import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { backupIfDue } from '../src/backup.mjs';
import { createConnections } from '../src/connections.mjs';
import { RetryableError } from '../src/errors.mjs';
import { openLedger, UNDONE } from '../src/ledger.mjs';
import { toastXml } from '../src/notify.mjs';
import { createOllamaKeeper } from '../src/ollama.mjs';
import { createQueue } from '../src/queue.mjs';
import { buildJobs } from '../src/registry.mjs';
import { createScheduler, latestSlot } from '../src/scheduler.mjs';
import { createServer } from '../src/server.mjs';
import { openSettings } from '../src/settings.mjs';
import { openStore } from '../src/store.mjs';

async function tempDir(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'automation-hub-platform-'));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
async function settle(store, runId) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const run = store.getSnapshot().runs.find((item) => item.runId === runId);
    if (TERMINAL.has(run?.state) && !store.getSnapshot().lease.ownerRunId) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('run did not finish');
}

const TUE_THU_8AM = { days: [2, 4], time: '08:00' };
// 2026-10-20 is a Tuesday; 08:00 IST is 02:30 UTC.
const ist = (date, time) => new Date(`${date}T${time}:00+05:30`);

test('latestSlot finds the most recent India-time slot', () => {
  assert.deepEqual(latestSlot(TUE_THU_8AM, ist('2026-10-20', '09:15')), { at: ist('2026-10-20', '08:00'), date: '2026-10-20' });
  assert.deepEqual(latestSlot(TUE_THU_8AM, ist('2026-10-20', '07:59')), { at: ist('2026-10-15', '08:00'), date: '2026-10-15' });
  assert.equal(latestSlot(null, new Date()), null);
});

test('scheduler starts a due run, catches up within 12 hours, and skips off, paused and old slots', async () => {
  await tempDir(async (dir) => {
    const store = openStore(path.join(dir, 'hub.sqlite'));
    const settings = openSettings(path.join(dir, 'hub-settings.json'));
    const ran = [];
    const queue = createQueue({ store, jobs: { 'linkedin-draft': { run: async ({ date }) => { ran.push(date); return { summary: 'ok' }; } } }, retryDelayMs: 10 });
    const automations = [{ id: 'linkedin-draft', name: 'LinkedIn posts', status: 'active', schedule: TUE_THU_8AM }];
    let now = ist('2026-10-20', '07:00');
    const scheduler = createScheduler({ automations, queue, store, settings, now: () => now });
    try {
      scheduler.tick();
      assert.equal(store.getSnapshot().runs.length, 0, 'last Thursday’s slot is more than 12 hours old');

      queue.pause();
      now = ist('2026-10-20', '08:00');
      scheduler.tick();
      assert.equal(store.getSnapshot().runs.length, 0, 'nothing is scheduled while paused');
      queue.resume();

      await settings.setEnabled('linkedin-draft', false);
      scheduler.tick();
      assert.equal(store.getSnapshot().runs.length, 0, 'a turned-off automation is not scheduled');
      await settings.setEnabled('linkedin-draft', true);

      now = ist('2026-10-20', '19:30'); // PC was off all day: still within the catch-up window.
      scheduler.tick();
      const run = store.findRun('linkedin-draft', '2026-10-20');
      assert.ok(run);
      await settle(store, run.runId);
      scheduler.tick();
      assert.equal(store.getSnapshot().runs.length, 1, 'a slot is only run once');
      assert.deepEqual(ran, ['2026-10-20']);
    } finally { queue.destroy(); store.close(); }
  });
});

test('a retryable failure is tried again after the delay, then reported once it fails for good', async () => {
  await tempDir(async (dir) => {
    const store = openStore(path.join(dir, 'hub.sqlite'));
    const settings = openSettings(path.join(dir, 'hub-settings.json'));
    const notices = [];
    let calls = 0;
    let scheduler;
    const queue = createQueue({
      store,
      jobs: { 'notion-projects': { run: async () => { calls++; throw new RetryableError('Notion is busy.'); } } },
      retryDelayMs: 10,
      onSettled: (info) => scheduler.onSettled(info),
    });
    let now = ist('2026-10-19', '09:00');
    scheduler = createScheduler({
      automations: [{ id: 'notion-projects', name: 'Notion projects', status: 'active', schedule: null }],
      queue, store, settings, now: () => now, retryDelayMs: 15 * 60_000, maxAttempts: 3,
      notify: (title, body) => notices.push({ title, body }),
    });
    try {
      const run = queue.enqueue('notion-projects', '2026-10-19');
      await settle(store, run.runId);
      assert.equal(scheduler.pendingRetries().length, 1);
      scheduler.tick();
      assert.equal(calls, 1, 'the retry waits for its delay');

      now = new Date(now.valueOf() + 16 * 60_000);
      scheduler.tick();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await settle(store, run.runId);
      now = new Date(now.valueOf() + 16 * 60_000);
      scheduler.tick();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const final = await settle(store, run.runId);

      assert.equal(calls, 3);
      assert.equal(final.attempts, 3);
      assert.equal(final.state, 'failed');
      assert.equal(scheduler.pendingRetries().length, 0);
      assert.deepEqual(notices, [{ title: 'Notion projects failed', body: 'Notion is busy.' }]);
    } finally { queue.destroy(); store.close(); }
  });
});

test('a lasting failure is not retried', async () => {
  await tempDir(async (dir) => {
    const store = openStore(path.join(dir, 'hub.sqlite'));
    const notices = [];
    let scheduler;
    const queue = createQueue({ store, jobs: { job: { run: async () => { throw new Error('Bad key.'); } } }, retryDelayMs: 10, onSettled: (info) => scheduler.onSettled(info) });
    scheduler = createScheduler({ automations: [], queue, store, settings: openSettings(path.join(dir, 's.json')), notify: (title) => notices.push(title) });
    try {
      await settle(store, queue.enqueue('job', '2026-10-19').runId);
      assert.equal(scheduler.pendingRetries().length, 0);
      assert.deepEqual(notices, ['job failed']);
    } finally { queue.destroy(); store.close(); }
  });
});

test('the store counts attempts and only retries failed runs', async () => {
  await tempDir(async (dir) => {
    const store = openStore(path.join(dir, 'hub.sqlite'));
    try {
      const { run } = store.createRun({ runId: 'r1', jobId: 'job', date: '2026-10-19' });
      assert.equal(run.attempts, 1);
      assert.throws(() => store.retryRun('r1'), /not a failed run/);
      store.setRunState('r1', 'failed', 'x');
      assert.equal(store.retryRun('r1').attempts, 2);
      assert.equal(store.findRun('job', '2026-10-19').state, 'queued');
      assert.equal(store.findRun('job', '2026-10-20'), null);
      // Run now on a day that already succeeded starts the same run again; a queued run can't.
      assert.throws(() => store.retryRun('r1', { anyFinished: true }), /not a finished run/);
      store.setRunState('r1', 'succeeded', 'done');
      assert.throws(() => store.retryRun('r1'), /not a failed run/);
      assert.equal(store.retryRun('r1', { anyFinished: true }).attempts, 3);
    } finally { store.close(); }
  });
});

test('the Ollama keeper starts Ollama when it is off and gives up with a retryable error', async () => {
  let up = false;
  let launched = 0;
  const keeper = createOllamaKeeper({
    app: 'C:\\ollama.exe', exists: () => true, pollMs: 5, waitMs: 200,
    fetch: async () => ({ ok: up }),
    spawn: (_app, args) => { assert.deepEqual(args, ['serve']); launched++; setTimeout(() => { up = true; }, 20); return { unref() {}, on() {} }; },
  });
  assert.deepEqual(await keeper.ensure(), { started: true });
  assert.deepEqual(await keeper.ensure(), { started: false });
  assert.equal(launched, 1);

  const dead = createOllamaKeeper({ app: 'C:\\ollama app.exe', exists: () => true, pollMs: 5, waitMs: 30, fetch: async () => { throw new Error('refused'); }, spawn: () => ({ unref() {}, on() {} }) });
  await assert.rejects(dead.ensure(), (error) => error.retryable === true && /didn’t start/.test(error.message));
  const missing = createOllamaKeeper({ app: null, fetch: async () => ({ ok: false }) });
  await assert.rejects(missing.ensure(), (error) => error.retryable === true);
});

test('registry checks Ollama only for model jobs and enforces the time limit', async () => {
  const ensured = [];
  const ollama = { ensure: async () => { ensured.push(true); } };
  const automations = [
    { id: 'model', status: 'active', usesModel: true },
    { id: 'api', status: 'active', timeLimitMs: 20 },
    { id: 'planned', status: 'planned' },
  ];
  const jobs = buildJobs({
    model: { run: async () => ({ summary: 'ok' }) },
    api: { run: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) },
    planned: { run: async () => ({ summary: 'never' }) },
  }, { automations, ollama });
  assert.deepEqual(Object.keys(jobs), ['model', 'api']);
  assert.equal((await jobs.model.run({})).summary, 'ok');
  assert.equal(ensured.length, 1);
  // AbortSignal.timeout doesn't keep the process alive by itself; the hub's server does.
  const keepAlive = setTimeout(() => {}, 1_000);
  try { await assert.rejects(jobs.api.run({ signal: new AbortController().signal }), /time limit/); }
  finally { clearTimeout(keepAlive); }
  assert.equal(ensured.length, 1);
});

test('connections check a key before saving it and never report the key back', async () => {
  await tempDir(async (dir) => {
    const file = path.join(dir, 'connections.json');
    const calls = [];
    const fetch = async (url, options) => {
      calls.push({ url, auth: options.headers.Authorization });
      return options.headers.Authorization === 'Bearer ntn_good_key_123456789012345'
        ? { ok: true, status: 200, json: async () => ({ bot: { workspace_name: 'My workspace' } }) }
        : { ok: false, status: 401, json: async () => ({}) };
    };
    const connections = createConnections({ file, fetch });
    await assert.rejects(connections.save('notion', 'short'), RangeError);
    await assert.rejects(connections.save('notion', 'ntn_wrong_key_12345678901234'), /refused/);
    await assert.rejects(connections.save('slack', 'ntn_good_key_123456789012345'), /Unknown/);
    const status = await connections.save('notion', ' ntn_good_key_123456789012345 ');
    assert.equal(calls[0].url, 'https://api.notion.com/v1/users/me');
    assert.equal(status.notion.connected, true);
    assert.equal(status.notion.name, 'My workspace');
    assert.equal(status.github.connected, false);
    assert.doesNotMatch(JSON.stringify(status), /ntn_good/);
    assert.equal(createConnections({ file, fetch }).token('notion'), 'ntn_good_key_123456789012345', 'the key survives a restart');
    await connections.reportProblem('notion', 'Key was revoked.');
    assert.equal(connections.status().notion.problem, 'Key was revoked.');
    await connections.disconnect('notion');
    assert.equal(connections.token('notion'), null);
    assert.doesNotMatch(await readFile(file, 'utf8'), /ntn_good/);
  });
});

test('the change log remembers the hub’s last write and locks a field once it is undone', async () => {
  await tempDir(async (dir) => {
    const ledger = openLedger(path.join(dir, 'hub.sqlite'));
    try {
      const base = { runId: 'r1', jobId: 'notion-projects', target: 'notion-page', targetId: 'p1', field: 'Description', label: 'GetCited · Description' };
      assert.equal(ledger.lastWritten('notion-page', 'p1', 'Description'), undefined);
      const first = ledger.begin({ ...base, before: '', after: 'One' });
      assert.equal(ledger.lastWritten('notion-page', 'p1', 'Description'), undefined, 'a pending write does not count');
      ledger.applied(first.id);
      assert.equal(ledger.lastWritten('notion-page', 'p1', 'Description'), 'One');
      const second = ledger.begin({ ...base, before: 'One', after: 'Two' });
      ledger.failed(second.id, 'Notion said no');
      assert.equal(ledger.lastWritten('notion-page', 'p1', 'Description'), 'One');
      ledger.undone(first.id);
      assert.equal(ledger.lastWritten('notion-page', 'p1', 'Description'), UNDONE);
      assert.deepEqual(ledger.list().map((change) => change.state), ['failed', 'undone']);
    } finally { ledger.close(); }
  });
});

test('backups run once a day and keep the newest copies', async () => {
  await tempDir(async (dir) => {
    const dbPath = path.join(dir, 'hub.sqlite');
    openStore(dbPath).close();
    const backupDir = path.join(dir, 'backup');
    const day = 24 * 60 * 60 * 1000;
    const start = new Date('2026-10-01T03:00:00Z');
    for (let index = 0; index < 4; index++) {
      const when = new Date(start.valueOf() + index * day);
      const made = await backupIfDue({ dbPath, dir: backupDir, extraFiles: [path.join(dir, 'missing.json')], keep: 2, now: when });
      assert.ok(made);
      await utimes(made, when, when);
      assert.equal(await backupIfDue({ dbPath, dir: backupDir, keep: 2, now: new Date(when.valueOf() + 60_000) }), null);
    }
    const kept = (await readdir(backupDir)).sort();
    assert.deepEqual(kept, ['hub-202610030300', 'hub-202610040300']);
    assert.deepEqual(await readdir(path.join(backupDir, kept[1])), ['hub.sqlite']);
  });
});

test('notification text is escaped into the toast XML', () => {
  assert.equal(
    toastXml('A <b> & "c"', 'line\none'),
    '<toast><visual><binding template="ToastGeneric"><text>A &lt;b&gt; &amp; &quot;c&quot;</text><text>line one</text></binding></visual></toast>',
  );
});

test('hub routes: switches, keys, change log and undo', async () => {
  await tempDir(async (dir) => {
    const store = openStore(path.join(dir, 'hub.sqlite'));
    const ledger = openLedger(path.join(dir, 'hub.sqlite'));
    const settings = openSettings(path.join(dir, 'hub-settings.json'));
    const connections = createConnections({
      file: path.join(dir, 'connections.json'),
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ login: 'example-dev' }) }),
    });
    const undone = [];
    const queue = createQueue({ store, jobs: { 'linkedin-draft': { run: async () => ({ summary: 'ok' }) } }, retryDelayMs: 10 });
    const app = await createServer({
      store, queue, port: 0,
      hub: {
        jobIds: ['linkedin-draft'], settings, connections, ledger,
        health: async () => ({ ollama: false, diskFreeBytes: 1, lastBackupAt: null }),
        undo: { 'notion-page': async (change) => { undone.push(change.id); } },
        retries: () => [{ runId: 'r9', jobId: 'linkedin-draft', dueAt: new Date('2026-10-20T03:00:00Z') }],
      },
    });
    const base = `http://127.0.0.1:${app.address.port}`;
    const post = (route, body, headers = {}) => fetch(`${base}${route}`, {
      method: 'POST', headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    try {
      assert.equal((await post('/api/automations/linkedin-draft/enabled', { enabled: false }, { Origin: 'http://evil.example' })).status, 403);
      assert.equal((await post('/api/automations/not-a-job/enabled', { enabled: false })).status, 404, 'unknown automations have no switch');
      assert.equal((await post('/api/automations/linkedin-draft/enabled', { enabled: 'no' })).status, 400);
      assert.deepEqual(await (await post('/api/automations/linkedin-draft/enabled', { enabled: false })).json(), { id: 'linkedin-draft', enabled: false });
      const listed = (await (await fetch(`${base}/api/automations`)).json()).automations;
      assert.equal(listed.find((item) => item.id === 'linkedin-draft').enabled, false);

      const saved = await (await post('/api/connections/github', { token: 'github_pat_secret_value_1234567890' })).json();
      assert.equal(saved.github.connected, true);
      const status = await (await fetch(`${base}/api/connections`)).text();
      assert.doesNotMatch(status, /secret_value/);
      assert.equal((await post('/api/connections/github', { token: 'x' })).status, 400);
      assert.equal((await post('/api/connections/github/disconnect')).status, 200);

      const change = ledger.begin({ runId: 'r1', jobId: 'notion-projects', target: 'notion-page', targetId: 'p1', field: 'Description', label: 'GetCited · Description', before: 'a', after: 'b' });
      ledger.applied(change.id);
      const other = ledger.begin({ runId: 'r1', jobId: 'linkedin-draft', target: 'linkedin-post', targetId: 'x', field: 'post', label: 'Post', before: null, after: 'text' });
      ledger.applied(other.id);
      const changes = (await (await fetch(`${base}/api/changes`)).json()).changes;
      assert.deepEqual(changes.map((item) => item.undoable), [false, true]);
      assert.equal((await post(`/api/changes/${other.id}/undo`)).status, 409);
      assert.equal((await post(`/api/changes/${change.id}/undo`)).status, 200);
      assert.deepEqual(undone, [change.id]);
      assert.equal(ledger.get(change.id).state, 'undone');
      assert.equal((await post(`/api/changes/${change.id}/undo`)).status, 409, 'a change is undone only once');

      const snapshot = await (await fetch(`${base}/api/snapshot`)).json();
      assert.deepEqual(snapshot.retries, [{ runId: 'r9', jobId: 'linkedin-draft', dueAt: '2026-10-20T03:00:00.000Z' }]);
      assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { ollama: false, diskFreeBytes: 1, lastBackupAt: null });
      assert.equal((await post('/api/jobs/notion-projects')).status, 404, 'only registered jobs can be started');
    } finally {
      queue.destroy();
      await app.close();
      ledger.close();
      store.close();
    }
  });
});
