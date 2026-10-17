// Starts each automation at its scheduled time (the profile's time zone), catches up on a slot the PC missed
// while it was off, retries runs that failed for a reason that can pass, and runs the daily backup.
// The hub starts at login and runs all day, so this replaces one Windows task per automation.

import { missingSetup } from './automations.mjs';
import { shiftedDay, zonedTime } from './dates.mjs';
import { getProfile } from './profile.mjs';

const MINUTE = 60 * 1000;

// The most recent scheduled moment at or before `now`, looking back up to 8 days.
export function latestSlot(schedule, now, timeZone = getProfile().timeZone) {
  if (!schedule || !Array.isArray(schedule.days) || !/^\d{2}:\d{2}$/.test(schedule.time ?? '')) return null;
  const [hour, minute] = schedule.time.split(':').map(Number);
  for (let back = 0; back <= 8; back++) {
    const day = shiftedDay(now, -back, timeZone);
    if (!schedule.days.includes(day.weekday)) continue;
    const at = zonedTime({ ...day, hour, minute }, timeZone);
    if (at <= now) return { at, date: day.date };
  }
  return null;
}

export function createScheduler({
  automations,
  queue,
  store,
  settings,
  notify = () => {},
  backup = null,
  now = () => new Date(),
  tickMs = 30_000,
  catchUpMs = 12 * 60 * MINUTE,
  retryDelayMs = 15 * MINUTE,
  maxAttempts = 3,
  log = () => {},
}) {
  const retries = new Map(); // runId -> { dueAt, jobId }
  let timer = null;
  let backingUp = false;
  const nameOf = (jobId) => automations.find((item) => item.id === jobId)?.name ?? jobId;
  const scheduled = () => automations.filter((item) => item.status === 'active' && item.schedule);

  function tick() {
    const current = now();
    if (!queue.snapshot().paused) {
      for (const automation of scheduled()) {
        if (!settings.isEnabled(automation.id) || missingSetup(automation).length) continue;
        const slot = latestSlot(automation.schedule, current);
        if (!slot || current - slot.at > catchUpMs) continue;
        if (store.findRun(automation.id, slot.date)) continue;
        try {
          queue.enqueue(automation.id, slot.date);
          log(`Scheduled ${automation.id} for ${slot.date}.`);
        } catch (error) {
          if (error?.code !== 'ERR_DUPLICATE_RUN') log(`Could not schedule ${automation.id}: ${error?.message}`);
        }
      }
      for (const [runId, retry] of retries) {
        if (retry.dueAt > current) continue;
        retries.delete(runId);
        if (!settings.isEnabled(retry.jobId)) continue;
        try { queue.retry(runId); } catch (error) { log(`Could not retry ${runId}: ${error?.message}`); }
      }
    }
    if (backup && !backingUp) {
      backingUp = true;
      void Promise.resolve().then(backup).catch((error) => log(`Backup failed: ${error?.message}`)).finally(() => { backingUp = false; });
    }
  }

  // Wired to the queue's onSettled.
  function onSettled({ run, state, retryable }) {
    if (state !== 'failed') return;
    if (retryable && (run.attempts ?? 1) < maxAttempts) {
      retries.set(run.runId, { dueAt: new Date(now().valueOf() + retryDelayMs), jobId: run.jobId });
      return;
    }
    const saved = store.getSnapshot().runs.find((item) => item.runId === run.runId);
    notify(`${nameOf(run.jobId)} failed`, saved?.summary ?? 'The run failed. Open the hub for details.');
  }

  return {
    tick,
    onSettled,
    pendingRetries: () => [...retries].map(([runId, retry]) => ({ runId, ...retry })),
    start() {
      if (timer) return;
      tick();
      timer = setInterval(tick, tickMs);
      timer.unref?.();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}
