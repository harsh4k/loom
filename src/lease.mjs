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

function validatePid(value, label, ValidationError, allowNull = false) {
  if (allowNull && value === null) return null;
  if (!Number.isSafeInteger(value) || value <= 0) throw new ValidationError(`${label} must be a positive process ID`);
  return value;
}

function isPidDefinitelyExited(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === 'ESRCH';
  }
}

export function initializeLeaseSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_lease (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      owner_run_id TEXT REFERENCES runs(run_id),
      acquired_at TEXT,
      owner_pid INTEGER,
      child_pid INTEGER,
      child_state TEXT NOT NULL DEFAULT 'unknown'
    );
  `);
  const columns = new Set(db.prepare('PRAGMA table_info(job_lease)').all().map((column) => column.name));
  if (!columns.has('owner_pid')) db.exec('ALTER TABLE job_lease ADD COLUMN owner_pid INTEGER');
  if (!columns.has('child_pid')) db.exec('ALTER TABLE job_lease ADD COLUMN child_pid INTEGER');
  if (!columns.has('child_state')) db.exec("ALTER TABLE job_lease ADD COLUMN child_state TEXT NOT NULL DEFAULT 'unknown'");
  db.exec(`
    INSERT INTO job_lease (singleton, owner_run_id, acquired_at, owner_pid, child_pid, child_state)
      VALUES (1, NULL, NULL, NULL, NULL, 'none') ON CONFLICT(singleton) DO NOTHING;
    UPDATE job_lease SET child_state = 'none', owner_pid = NULL, child_pid = NULL
      WHERE owner_run_id IS NULL AND child_state = 'unknown';
  `);
}

export function createLeaseStore({ db, getRun, ensureOpen, validateIdentifier, ValidationError }) {
  function ownedByCurrentProcess(runId) {
    const lease = db.prepare('SELECT owner_run_id, owner_pid FROM job_lease WHERE singleton = 1').get();
    return lease?.owner_run_id === runId && Number(lease.owner_pid) === process.pid;
  }

  function snapshot() {
    const lease = db.prepare('SELECT owner_run_id, acquired_at, owner_pid, child_pid, child_state FROM job_lease WHERE singleton = 1').get();
    return {
      ownerRunId: lease?.owner_run_id ?? null,
      acquiredAt: lease?.acquired_at ?? null,
      ownerPid: lease?.owner_pid === null ? null : Number(lease?.owner_pid),
      childPid: lease?.child_pid === null ? null : Number(lease?.child_pid),
      childState: lease?.child_state ?? 'none',
    };
  }

  function reconcileInterruptedRuns() {
    ensureOpen();
    return transaction(db, () => {
      const lease = db.prepare('SELECT owner_run_id FROM job_lease WHERE singleton = 1').get();
      const activeOwner = lease?.owner_run_id ?? null;
      const staleRuns = db.prepare("SELECT run_id, job_id FROM runs WHERE state = 'running' AND run_id <> COALESCE(?, '') ORDER BY created_at, run_id").all(activeOwner);
      const now = new Date().toISOString();
      const update = db.prepare("UPDATE runs SET state = 'interrupted', summary = ?, updated_at = ? WHERE run_id = ? AND state = 'running'");
      const event = db.prepare('INSERT INTO events (run_id, job_id, state, summary, artifact_path, created_at) VALUES (?, ?, ?, ?, NULL, ?)');
      for (const run of staleRuns) {
        const summary = 'Hub restarted before this run completed.';
        const result = update.run(summary, now, run.run_id);
        if (Number(result.changes) > 0) event.run(run.run_id, run.job_id, 'interrupted', summary, now);
      }
      return staleRuns.length;
    });
  }

  function acquireLease(runId) {
    ensureOpen();
    validateIdentifier(runId, 'runId');
    return transaction(db, () => {
      if (!getRun.get(runId)) throw new RangeError(`Unknown run: ${runId}`);
      const current = db.prepare('SELECT owner_run_id, owner_pid FROM job_lease WHERE singleton = 1').get();
      const ownerRunId = current?.owner_run_id ?? null;
      const ownerPid = current?.owner_pid === null ? null : Number(current?.owner_pid);
      if (ownerRunId && (ownerRunId !== runId || ownerPid !== process.pid)) return { acquired: false, ownerRunId };
      if (!ownerRunId) db.prepare("UPDATE job_lease SET owner_run_id = ?, acquired_at = ?, owner_pid = ?, child_pid = NULL, child_state = 'not_started' WHERE singleton = 1 AND owner_run_id IS NULL").run(runId, new Date().toISOString(), process.pid);
      return { acquired: true, ownerRunId: runId };
    });
  }

  function markChildStarting(runId) {
    ensureOpen();
    validateIdentifier(runId, 'runId');
    return transaction(db, () => {
      if (!ownedByCurrentProcess(runId)) return false;
      const lease = db.prepare('SELECT child_state FROM job_lease WHERE singleton = 1').get();
      if (lease.child_state === 'starting') return true;
      if (lease.child_state !== 'not_started') return false;
      db.prepare("UPDATE job_lease SET child_state = 'starting', child_pid = NULL WHERE singleton = 1 AND owner_run_id = ? AND owner_pid = ?").run(runId, process.pid);
      return true;
    });
  }

  function recordChildPid(runId, childPid) {
    ensureOpen();
    validateIdentifier(runId, 'runId');
    validatePid(childPid, 'childPid', ValidationError);
    return transaction(db, () => {
      if (!ownedByCurrentProcess(runId)) return false;
      const lease = db.prepare('SELECT child_pid, child_state FROM job_lease WHERE singleton = 1').get();
      if (lease.child_state === 'running' && Number(lease.child_pid) === childPid) return true;
      if (lease.child_state !== 'starting' || lease.child_pid !== null) return false;
      db.prepare("UPDATE job_lease SET child_pid = ?, child_state = 'running' WHERE singleton = 1 AND owner_run_id = ? AND owner_pid = ?").run(childPid, runId, process.pid);
      return true;
    });
  }

  /** Call only after the child tree has exited, or a spawn attempt is confirmed not to have started a child. */
  function markChildExited(runId, childPid = null) {
    ensureOpen();
    validateIdentifier(runId, 'runId');
    validatePid(childPid, 'childPid', ValidationError, true);
    return transaction(db, () => {
      if (!ownedByCurrentProcess(runId)) return false;
      const lease = db.prepare('SELECT child_pid, child_state FROM job_lease WHERE singleton = 1').get();
      if (lease.child_state === 'starting' && lease.child_pid === null && childPid === null) {
        db.prepare("UPDATE job_lease SET child_state = 'exited' WHERE singleton = 1 AND owner_run_id = ? AND owner_pid = ?").run(runId, process.pid);
        return true;
      }
      if (lease.child_state === 'exited' && (lease.child_pid === null ? null : Number(lease.child_pid)) === childPid) return true;
      if (lease.child_state !== 'running' || Number(lease.child_pid) !== childPid) return false;
      db.prepare("UPDATE job_lease SET child_state = 'exited' WHERE singleton = 1 AND owner_run_id = ? AND owner_pid = ? AND child_pid = ?").run(runId, process.pid, childPid);
      return true;
    });
  }

  function recoverInterruptedRun({ runId, expectedOwnerPid, expectedChildPid, ownerExited, childTreeExited } = {}) {
    ensureOpen();
    validateIdentifier(runId, 'runId');
    validatePid(expectedOwnerPid, 'expectedOwnerPid', ValidationError);
    validatePid(expectedChildPid, 'expectedChildPid', ValidationError, true);
    if (typeof ownerExited !== 'boolean' || typeof childTreeExited !== 'boolean') {
      throw new ValidationError('recovery requires explicit ownerExited and childTreeExited confirmations');
    }
    if (!ownerExited || !childTreeExited) return false;
    return transaction(db, () => {
      const lease = db.prepare('SELECT * FROM job_lease WHERE singleton = 1').get();
      if (lease?.owner_run_id !== runId || Number(lease.owner_pid) !== expectedOwnerPid || !isPidDefinitelyExited(expectedOwnerPid)) return false;
      if (!['not_started', 'running', 'exited'].includes(lease.child_state)) return false;
      const childPid = lease.child_pid === null ? null : Number(lease.child_pid);
      if (childPid !== expectedChildPid || (childPid !== null && !isPidDefinitelyExited(childPid))) return false;
      const run = getRun.get(runId);
      if (!run || run.state !== 'running') return false;
      const now = new Date().toISOString();
      const summary = 'Hub recovered after the previous process and child tree exited.';
      const changed = db.prepare("UPDATE runs SET state = 'interrupted', summary = ?, updated_at = ? WHERE run_id = ? AND state = 'running'").run(summary, now, runId);
      if (Number(changed.changes) !== 1) return false;
      db.prepare('INSERT INTO events (run_id, job_id, state, summary, artifact_path, created_at) VALUES (?, ?, ?, ?, NULL, ?)').run(runId, run.job_id, 'interrupted', summary, now);
      db.prepare("UPDATE job_lease SET owner_run_id = NULL, acquired_at = NULL, owner_pid = NULL, child_pid = NULL, child_state = 'none' WHERE singleton = 1 AND owner_run_id = ? AND owner_pid = ?").run(runId, expectedOwnerPid);
      return true;
    });
  }

  function releaseLease(runId) {
    ensureOpen();
    validateIdentifier(runId, 'runId');
    const result = db.prepare("UPDATE job_lease SET owner_run_id = NULL, acquired_at = NULL, owner_pid = NULL, child_pid = NULL, child_state = 'none' WHERE singleton = 1 AND owner_run_id = ? AND owner_pid = ? AND child_state IN ('not_started', 'exited')").run(runId, process.pid);
    return Number(result.changes) > 0;
  }

  return { snapshot, acquireLease, markChildStarting, recordChildPid, markChildExited, recoverInterruptedRun, releaseLease, reconcileInterruptedRuns };
}
