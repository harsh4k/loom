import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runOnce } from '../src/cli.mjs';
import { openStore } from '../src/store.mjs';

async function withStore(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'automation-hub-cli-'));
  const store = openStore(path.join(dir, 'hub.sqlite'));
  try { await run(store); } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const quiet = () => {};

test('scheduled run records success in the shared store and exits 0', async () => {
  await withStore(async (store) => {
    const jobs = { 'linkedin-draft': { run: async () => ({ summary: 'Draft saved.', artifactPath: null }) } };
    const code = await runOnce({ jobId: 'linkedin-draft', jobs, store, date: '2026-10-16', log: quiet });
    assert.equal(code, 0);
    const [run] = store.getSnapshot().runs;
    assert.equal(run.state, 'succeeded');
    assert.equal(run.date, '2026-10-16');
  });
});

test('scheduled run exits 1 when the job fails', async () => {
  await withStore(async (store) => {
    const jobs = { 'linkedin-draft': { run: async () => { throw new Error('Ollama is not running'); } } };
    const code = await runOnce({ jobId: 'linkedin-draft', jobs, store, date: '2026-10-16', log: quiet });
    assert.equal(code, 1);
    assert.equal(store.getSnapshot().runs[0].state, 'failed');
  });
});

test('a second scheduled run on the same date is a no-op that exits 0', async () => {
  await withStore(async (store) => {
    let calls = 0;
    const jobs = { 'linkedin-draft': { run: async () => { calls++; return { summary: 'Draft saved.', artifactPath: null }; } } };
    await runOnce({ jobId: 'linkedin-draft', jobs, store, date: '2026-10-16', log: quiet });
    const code = await runOnce({ jobId: 'linkedin-draft', jobs, store, date: '2026-10-16', log: quiet });
    assert.equal(code, 0);
    assert.equal(calls, 1);
    assert.equal(store.getSnapshot().runs.length, 1);
  });
});

test('an unknown job id exits 2 without creating a run', async () => {
  await withStore(async (store) => {
    const code = await runOnce({ jobId: 'nope', jobs: {}, store, log: quiet });
    assert.equal(code, 2);
    assert.equal(store.getSnapshot().runs.length, 0);
  });
});
