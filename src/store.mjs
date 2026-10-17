import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLeaseStore, initializeLeaseSchema } from './lease.mjs';
import { draftsFolder } from './profile.mjs';

const RUN_STATES = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted']);
const SUMMARY_LIMIT = 500;
const RUN_LIMIT = 100;
const EVENT_LIMIT = 250;

export class StoreValidationError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'StoreValidationError';
  }
}

function validateIdentifier(value, label) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(value)) {
    throw new StoreValidationError(`${label} must be a 1–80 character safe identifier`);
  }
  return value;
}

function validateDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new StoreValidationError('date must be a valid YYYY-MM-DD date');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new StoreValidationError('date must be a valid YYYY-MM-DD date');
  }
  return value;
}

function validateState(value) {
  if (!RUN_STATES.has(value)) {
    throw new StoreValidationError(`state must be one of: ${[...RUN_STATES].join(', ')}`);
  }
  return value;
}

function validateSummary(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > SUMMARY_LIMIT || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new StoreValidationError(`summary must be text of at most ${SUMMARY_LIMIT} characters without control characters`);
  }
  return value;
}

function validateArtifactPath(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new StoreValidationError('artifact path must be a safe path under the LinkedIn drafts folder');
  }
  const root = path.win32.resolve(draftsFolder());
  const candidate = path.win32.resolve(value);
  const relative = path.win32.relative(root, candidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.win32.sep}`) || path.win32.isAbsolute(relative) || path.win32.extname(candidate).toLowerCase() !== '.md') {
    throw new StoreValidationError('artifact path must be a Markdown file under the LinkedIn drafts folder');
  }
  return candidate;
}

function validateTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new StoreValidationError('timestamp must be a valid date or ISO timestamp');
  return date.toISOString();
}

function transaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function asRun(row) {
  if (!row) return null;
  return {
    runId: row.run_id,
    jobId: row.job_id,
    date: row.job_date,
    state: row.state,
    summary: row.summary,
    attempts: Number(row.attempts ?? 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function asEvent(row) {
  return {
    id: Number(row.id),
    runId: row.run_id,
    jobId: row.job_id,
    state: row.state,
    summary: row.summary,
    artifactPath: row.artifact_path,
    createdAt: row.created_at,
  };
}

/**
 * Open the persistent run/event store.
 *
 * `createRun` returns `{ run, duplicate }`; a duplicate points at the existing
 * run for the same job and date. `getSnapshot` returns `{ runs, events, lease }`:
 * up to 100 most-recent runs, 250 chronologically ordered recent events, and
 * `{ ownerRunId, acquiredAt, ownerPid, childPid, childState }` for the lease.
 * Child launch methods are restricted to the owning process. Recovery requires
 * an exact run/PID match and explicit owner/child-tree exit confirmations.
 */
export function openStore(dbPath) {
  if (typeof dbPath !== 'string' || dbPath.length === 0) throw new StoreValidationError('dbPath is required');
  const db = new DatabaseSync(dbPath);
  let closed = false;
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      job_date TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
      summary TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (job_id, job_date)
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(run_id),
      job_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
      summary TEXT,
      artifact_path TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_created_order ON events(created_at, id);
  `);

  // Added for retries; older databases get the column with every run counted as one attempt.
  if (!db.prepare('PRAGMA table_info(runs)').all().some((column) => column.name === 'attempts')) {
    db.exec('ALTER TABLE runs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1');
  }
  const getRun = db.prepare('SELECT * FROM runs WHERE run_id = ?');

  function ensureOpen() {
    if (closed) throw new Error('Store is closed');
  }

  initializeLeaseSchema(db);
  const leaseStore = createLeaseStore({ db, getRun, ensureOpen, validateIdentifier, ValidationError: StoreValidationError });
  leaseStore.reconcileInterruptedRuns();

  const store = {
    /** @returns {{ run: object, duplicate: boolean }} */
    createRun({ runId, jobId, date }) {
      ensureOpen();
      validateIdentifier(runId, 'runId');
      validateIdentifier(jobId, 'jobId');
      validateDate(date);
      return transaction(db, () => {
        const existing = db.prepare('SELECT * FROM runs WHERE job_id = ? AND job_date = ?').get(jobId, date);
        if (existing) return { run: asRun(existing), duplicate: true };
        const now = new Date().toISOString();
        db.prepare("INSERT INTO runs (run_id, job_id, job_date, state, summary, created_at, updated_at) VALUES (?, ?, ?, 'queued', NULL, ?, ?)").run(runId, jobId, date, now, now);
        return { run: asRun(getRun.get(runId)), duplicate: false };
      });
    },

    findRun(jobId, date) {
      ensureOpen();
      validateIdentifier(jobId, 'jobId');
      validateDate(date);
      return asRun(db.prepare('SELECT * FROM runs WHERE job_id = ? AND job_date = ?').get(jobId, date));
    },

    // Puts a failed run back in the queue as its next attempt. The run keeps its id and date,
    // so the one-run-per-day rule still holds.
    retryRun(runId) {
      ensureOpen();
      validateIdentifier(runId, 'runId');
      const now = new Date().toISOString();
      const result = db.prepare("UPDATE runs SET state = 'queued', attempts = attempts + 1, updated_at = ? WHERE run_id = ? AND state = 'failed'").run(now, runId);
      if (Number(result.changes) === 0) throw new RangeError(`Run ${runId} is not a failed run.`);
      return asRun(getRun.get(runId));
    },

    setRunState(runId, state, summary) {
      ensureOpen();
      validateIdentifier(runId, 'runId');
      validateState(state);
      const safeSummary = validateSummary(summary);
      const result = db.prepare('UPDATE runs SET state = ?, summary = ?, updated_at = ? WHERE run_id = ?').run(state, safeSummary, new Date().toISOString(), runId);
      if (Number(result.changes) === 0) throw new RangeError(`Unknown run: ${runId}`);
      return asRun(getRun.get(runId));
    },

    addEvent({ runId, jobId, state, summary, artifactPath }) {
      ensureOpen();
      validateIdentifier(runId, 'runId');
      validateIdentifier(jobId, 'jobId');
      validateState(state);
      const safeSummary = validateSummary(summary);
      const safeArtifactPath = validateArtifactPath(artifactPath);
      const run = getRun.get(runId);
      if (!run || run.job_id !== jobId) throw new RangeError(`Unknown run/job pair: ${runId}/${jobId}`);
      const result = db.prepare('INSERT INTO events (run_id, job_id, state, summary, artifact_path, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(runId, jobId, state, safeSummary, safeArtifactPath, new Date().toISOString());
      return asEvent(db.prepare('SELECT * FROM events WHERE id = ?').get(result.lastInsertRowid));
    },

    /** @returns {{ runs: object[], events: object[], lease: { ownerRunId: string|null, acquiredAt: string|null } }} */
    getSnapshot() {
      ensureOpen();
      const runs = db.prepare('SELECT * FROM runs ORDER BY updated_at DESC, rowid DESC LIMIT ?').all(RUN_LIMIT).map(asRun);
      const events = db.prepare('SELECT * FROM (SELECT * FROM events ORDER BY created_at DESC, id DESC LIMIT ?) ORDER BY created_at, id').all(EVENT_LIMIT).map(asEvent);
      return { runs, events, lease: leaseStore.snapshot() };
    },

    acquireLease: leaseStore.acquireLease,
    markChildStarting: leaseStore.markChildStarting,
    recordChildPid: leaseStore.recordChildPid,
    markChildExited: leaseStore.markChildExited,
    recoverInterruptedRun: leaseStore.recoverInterruptedRun,
    releaseLease: leaseStore.releaseLease,
    reconcileInterruptedRuns: leaseStore.reconcileInterruptedRuns,

    pruneEvents(beforeTimestamp) {
      ensureOpen();
      const cutoff = validateTimestamp(beforeTimestamp);
      const result = db.prepare('DELETE FROM events WHERE created_at < ?').run(cutoff);
      return Number(result.changes);
    },

    close() {
      if (closed) return;
      db.close();
      closed = true;
    },
  };

  return store;
}
