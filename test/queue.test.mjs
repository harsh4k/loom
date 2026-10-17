import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openStore } from '../src/store.mjs';
import { createQueue } from '../src/queue.mjs';

async function withStore(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'automation-hub-queue-'));
  const store = openStore(path.join(dir, 'hub.sqlite'));
  try { await run(store); } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
}

async function waitForState(store, runId, state) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const run = store.getSnapshot().runs.find((item) => item.runId === runId);
    if (run?.state === state) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Run ${runId} did not reach ${state}`);
}

test('queue is FIFO, single-flight, pausable, and rejects same-day duplicates', async () => {
  await withStore(async (store) => {
    const firstDate = '2026-10-13';
    const secondDate = '2026-10-14';
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const started = [];
    let active = 0;
    let maxActive = 0;
    const queue = createQueue({
      store,
      jobs: { 'linkedin-draft': { async run({ date }) {
        started.push(date);
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (date === firstDate) await firstGate;
        active -= 1;
        return { summary: `Draft handled for ${date}`, artifactPath: null };
      } } },
      retryDelayMs: 20,
    });

    const first = queue.enqueue('linkedin-draft', firstDate);
    await waitForState(store, first.runId, 'running');
    assert.throws(() => queue.enqueue('linkedin-draft', firstDate), { code: 'ERR_DUPLICATE_RUN' });
    const second = queue.enqueue('linkedin-draft', secondDate);
    queue.pause();
    releaseFirst();
    await waitForState(store, first.runId, 'succeeded');
    assert.equal(store.getSnapshot().runs.find((item) => item.runId === second.runId).state, 'queued');
    assert.deepEqual(started, [firstDate]);

    queue.resume();
    await waitForState(store, second.runId, 'succeeded');
    assert.deepEqual(started, [firstDate, secondDate]);
    assert.equal(maxActive, 1);
    assert.equal(queue.snapshot().paused, false);
  });
});

test('queue retries a busy cross-process lease without dropping the queued run', async () => {
  await withStore(async (store) => {
    store.createRun({ runId: 'lease-owner', jobId: 'other-job', date: '2026-10-12' });
    store.setRunState('lease-owner', 'running', 'Held by the other process.');
    assert.equal(store.acquireLease('lease-owner').acquired, true);
    const queue = createQueue({
      store,
      jobs: { 'linkedin-draft': { async run() { return { summary: 'Done', artifactPath: null }; } } },
      retryDelayMs: 20,
    });

    const run = queue.enqueue('linkedin-draft', '2026-10-14');
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(store.getSnapshot().runs.find((item) => item.runId === run.runId).state, 'queued');
    assert.equal(store.releaseLease('lease-owner'), true);
    await waitForState(store, run.runId, 'succeeded');
  });
});

test('stopping the active run aborts its handler and records cancelled', async () => {
  await withStore(async (store) => {
    const queue = createQueue({ store, jobs: { 'linkedin-draft': { run({ signal }) {
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('stopped'), { name: 'AbortError' }));
      }, { once: true }));
    } } } });
    const run = queue.enqueue('linkedin-draft', '2026-10-14');
    await waitForState(store, run.runId, 'running');
    assert.equal(queue.stop(run.runId), true);
    await waitForState(store, run.runId, 'cancelled');
    assert.equal(store.getSnapshot().lease.ownerRunId, null);
  });
});

test('destroy records interrupted after the active handler exits', async () => {
  await withStore(async (store) => {
    const queue = createQueue({ store, jobs: { 'linkedin-draft': { run({ signal }) {
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('hub closed'), { name: 'AbortError' }));
      }, { once: true }));
    } } } });
    const run = queue.enqueue('linkedin-draft', '2026-10-14');
    await waitForState(store, run.runId, 'running');
    queue.destroy();
    await waitForState(store, run.runId, 'interrupted');
    assert.equal(store.getSnapshot().lease.ownerRunId, null);
  });
});
