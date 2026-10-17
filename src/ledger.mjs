// The change log: every write the hub makes outside this PC is recorded here before it is
// made, with the value before and after, so it can be looked back at and undone. It also tells
// a job what it last wrote to a field, which is how "your edits win" is decided.
import { DatabaseSync } from 'node:sqlite';

export const UNDONE = Symbol('undone');
const STATES = new Set(['pending', 'applied', 'failed', 'undone']);
const LIST_LIMIT = 200;
const text = (value, limit) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit);

function asChange(row) {
  if (!row) return null;
  const parse = (value) => { try { return value === null ? null : JSON.parse(value); } catch { return null; } };
  return {
    id: Number(row.id),
    runId: row.run_id,
    jobId: row.job_id,
    target: row.target,
    targetId: row.target_id,
    field: row.field,
    label: row.label,
    before: parse(row.before_json),
    after: parse(row.after_json),
    state: row.state,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function openLedger(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      target TEXT NOT NULL,
      target_id TEXT NOT NULL,
      field TEXT NOT NULL,
      label TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      state TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS changes_target ON changes(target, target_id, field, id);
  `);
  const get = db.prepare('SELECT * FROM changes WHERE id = ?');

  function setState(id, state, error = null) {
    if (!STATES.has(state)) throw new RangeError('Unknown change state.');
    db.prepare('UPDATE changes SET state = ?, error = ?, updated_at = ? WHERE id = ?')
      .run(state, error === null ? null : text(error, 300), new Date().toISOString(), id);
    return asChange(get.get(id));
  }

  return {
    // Records an outside write before it is made. `before` and `after` must be JSON values.
    begin({ runId, jobId, target, targetId, field, label, before = null, after = null }) {
      const now = new Date().toISOString();
      const result = db.prepare(`INSERT INTO changes (run_id, job_id, target, target_id, field, label, before_json, after_json, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).run(
        text(runId, 80), text(jobId, 80), text(target, 40), text(targetId, 200), text(field, 80), text(label, 200),
        JSON.stringify(before), JSON.stringify(after), now, now,
      );
      return asChange(get.get(result.lastInsertRowid));
    },
    // `patch` fills in what is only known after the write, such as the id of a page just created.
    applied(id, patch = {}) {
      if (patch.targetId !== undefined) db.prepare('UPDATE changes SET target_id = ? WHERE id = ?').run(text(patch.targetId, 200), id);
      if (patch.after !== undefined) db.prepare('UPDATE changes SET after_json = ? WHERE id = ?').run(JSON.stringify(patch.after), id);
      return setState(id, 'applied');
    },
    failed: (id, error) => setState(id, 'failed', error ?? 'Failed.'),
    undone: (id) => setState(id, 'undone'),
    get: (id) => asChange(get.get(id)),
    list: (limit = LIST_LIMIT) => db.prepare('SELECT * FROM changes ORDER BY id DESC LIMIT ?').all(Math.min(limit, LIST_LIMIT)).map(asChange),
    // What the hub last wrote to this field: undefined if it never has, UNDONE if its last write
    // was undone (the field is then left alone for good), otherwise the value it wrote.
    lastWritten(target, targetId, field) {
      const row = db.prepare(`SELECT * FROM changes WHERE target = ? AND target_id = ? AND field = ? AND state IN ('applied', 'undone')
        ORDER BY id DESC LIMIT 1`).get(target, targetId, field);
      if (!row) return undefined;
      const change = asChange(row);
      return change.state === 'applied' ? change.after : UNDONE;
    },
    close: () => db.close(),
  };
}
