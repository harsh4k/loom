import { randomUUID } from 'node:crypto';
import { isRetryable } from './errors.mjs';

export class DuplicateRunError extends Error {
  constructor(run) {
    super(`A ${run.jobId} run already exists for ${run.date}.`);
    this.name = 'DuplicateRunError';
    this.code = 'ERR_DUPLICATE_RUN';
    this.run = run;
  }
}

function safeSummary(value, fallback) {
  const text = typeof value === 'string' ? value : fallback;
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, 500);
}

// `onSettled({ run, state, retryable })` is called after each run is finished and recorded.
export function createQueue({ store, jobs, retryDelayMs = 1_000, onSettled = null }) {
  if (!store || typeof store.getSnapshot !== 'function') throw new TypeError('store is required');
  if (!jobs || typeof jobs !== 'object') throw new TypeError('jobs must be a job map');
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 10 || retryDelayMs > 5_000) throw new RangeError('retryDelayMs must be between 10 and 5000');

  let paused = false;
  let pumping = false;
  let pumpQueued = false;
  let retryTimer = null;
  let active = null;
  const pending = store.getSnapshot().runs
    .filter((run) => run.state === 'queued')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.runId.localeCompare(right.runId));

  function record(run, state, summary, artifactPath = null) {
    store.setRunState(run.runId, state, summary);
    store.addEvent({ runId: run.runId, jobId: run.jobId, state, summary, artifactPath });
  }

  function schedulePump() {
    if (pumpQueued || paused || active) return;
    pumpQueued = true;
    queueMicrotask(() => {
      pumpQueued = false;
      void pump();
    });
  }

  function retryLater() {
    if (retryTimer || paused) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      schedulePump();
    }, retryDelayMs);
    retryTimer.unref?.();
  }

  function pauseWithHeldLease(entry, message) {
    paused = true;
    entry.blocked = message;
    try {
      const summary = 'Process exit could not be confirmed; lease retained and queue paused for manual recovery.';
      store.setRunState(entry.run.runId, 'running', summary);
      store.addEvent({ runId: entry.run.runId, jobId: entry.run.jobId, state: 'running', summary });
    } catch { /* Keep the lease held even if persistence is itself unavailable. */ }
    return false;
  }

  function settled(run, state, retryable = false) {
    try { onSettled?.({ run: { ...run }, state, retryable }); } catch { /* A listener must never break the queue. */ }
  }

  function finalize(entry, state, summary, artifactPath = null, retryable = false) {
    const lease = store.getSnapshot().lease;
    if (lease.ownerRunId !== entry.run.runId || lease.ownerPid !== process.pid || !['not_started', 'exited'].includes(lease.childState)) {
      return pauseWithHeldLease(entry, 'Lease ownership or child exit state is uncertain.');
    }
    try {
      record(entry.run, state, summary, artifactPath);
    } catch (error) {
      return pauseWithHeldLease(entry, safeSummary(error?.message, 'Run finalization failed.'));
    }
    if (!store.releaseLease(entry.run.runId)) {
      return pauseWithHeldLease(entry, 'The owned lease could not be released.');
    }
    settled(entry.run, state, retryable);
    return true;
  }

  async function execute(entry) {
    const { run, controller } = entry;
    try {
      const handler = jobs[run.jobId];
      if (!handler || typeof handler.run !== 'function') throw new Error(`No handler is registered for ${run.jobId}.`);
      record(run, 'running', run.attempts > 1 ? `Started (attempt ${run.attempts}).` : 'Started.');
      const result = await handler.run({
        runId: run.runId,
        date: run.date,
        signal: controller.signal,
        onChildStarting: () => store.markChildStarting(run.runId),
        onChildStarted: (pid) => store.recordChildPid(run.runId, pid),
        onChildExited: (pid) => store.markChildExited(run.runId, pid),
        // Lets a job show what it is doing now (for example "Rendering the video") on the dashboard.
        report: (summary) => {
          if (!controller.signal.aborted) record(run, 'running', safeSummary(summary, 'Working.'));
        },
      });
      if (!result || typeof result.summary !== 'string') throw new Error('Job handler returned an invalid result.');
      const state = controller.signal.aborted ? (entry.requestedState ?? 'cancelled') : 'succeeded';
      const summary = state === 'succeeded'
        ? safeSummary(result.summary, 'Done.')
        : state === 'interrupted' ? 'Hub stopped after the child process exited.' : 'Run cancelled after the child process exited.';
      return finalize(entry, state, summary, result.artifactPath ?? null);
    } catch (error) {
      if (error?.code === 'ERR_CHILD_EXIT_UNCONFIRMED') return pauseWithHeldLease(entry, error.message);
      if (controller.signal.aborted) {
        const state = entry.requestedState ?? 'cancelled';
        const summary = state === 'interrupted' ? 'Hub stopped after the child process exited.' : 'Run cancelled after the child process exited.';
        return finalize(entry, state, summary);
      }
      return finalize(entry, 'failed', safeSummary(error?.message || 'Unexpected error.', 'Failed.'), null, isRetryable(error));
    }
  }

  async function pump() {
    if (pumping || paused) return;
    pumping = true;
    let waitingForLease = false;
    try {
      while (!paused && !active && pending.length > 0) {
        const run = pending[0];
        const lease = store.acquireLease(run.runId);
        if (!lease.acquired) {
          waitingForLease = true;
          retryLater();
          break;
        }
        pending.shift();
        active = { run, controller: new AbortController(), requestedState: null, blocked: null };
        const entry = active;
        if (await execute(entry)) active = null;
        else break;
      }
    } finally {
      pumping = false;
      if (!waitingForLease && !paused && !active && pending.length > 0) schedulePump();
    }
  }

  function enqueue(jobId, date) {
    if (typeof jobs[jobId]?.run !== 'function') throw new RangeError(`No handler is registered for ${jobId}.`);
    const created = store.createRun({ runId: randomUUID(), jobId, date });
    if (created.duplicate) throw new DuplicateRunError(created.run);
    pending.push(created.run);
    store.addEvent({ runId: created.run.runId, jobId, state: 'queued', summary: 'Queued.' });
    schedulePump();
    return created.run;
  }

  // Queues a failed run again as its next attempt.
  function retry(runId) {
    const run = store.retryRun(runId);
    if (typeof jobs[run.jobId]?.run !== 'function') throw new RangeError(`No handler is registered for ${run.jobId}.`);
    pending.push(run);
    store.addEvent({ runId: run.runId, jobId: run.jobId, state: 'queued', summary: `Trying again (attempt ${run.attempts}).` });
    schedulePump();
    return run;
  }

  function pause() { paused = true; return snapshot(); }

  function resume() {
    paused = false;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    schedulePump();
    return snapshot();
  }

  function stop(runId) {
    if (!active || active.run.runId !== runId || active.blocked) return false;
    active.requestedState = 'cancelled';
    active.controller.abort(new Error('Stopped by operator.'));
    return true;
  }

  function snapshot() {
    const saved = store.getSnapshot();
    return {
      paused,
      activeRun: active?.run ?? null,
      blockedReason: active?.blocked ?? null,
      queuedRuns: pending.map((run) => ({ ...run })),
      recentRuns: saved.runs,
      events: saved.events,
    };
  }

  function destroy() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    paused = true;
    if (active && !active.blocked) {
      active.requestedState = 'interrupted';
      active.controller.abort(new Error('Hub shutdown.'));
    }
  }

  schedulePump();
  return { enqueue, retry, pause, resume, stop, snapshot, destroy };
}
