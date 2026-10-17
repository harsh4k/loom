import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openStore } from '../src/store.mjs';

const draftRoot = 'C:\\Loom\\linkedin\\drafts';
const draftPath = `${draftRoot}\\sample.md`;
const storeModuleUrl = new URL('../src/store.mjs', import.meta.url).href;

async function withStore(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'automation-hub-store-'));
  const dbPath = path.join(dir, 'hub.sqlite');
  const stores = [];
  const open = () => {
    const store = openStore(dbPath);
    stores.push(store);
    return store;
  };
  try {
    await run({ dir, dbPath, store: open(), open });
  } finally {
    for (const store of stores.reverse()) store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function seedLeaseFromExitedOwner(dbPath, { runId = 'run-stale', childState = 'running', childPid = 7654321 } = {}) {
  const source = `
    import { openStore } from ${JSON.stringify(storeModuleUrl)};
    const store = openStore(${JSON.stringify(dbPath)});
    store.createRun({ runId: ${JSON.stringify(runId)}, jobId: 'linkedin-draft', date: '2026-10-14' });
    store.setRunState(${JSON.stringify(runId)}, 'running', 'Started');
    store.acquireLease(${JSON.stringify(runId)});
    if (${JSON.stringify(childState)} !== 'not_started') {
      store.markChildStarting(${JSON.stringify(runId)});
      if (${JSON.stringify(childState)} === 'running') store.recordChildPid(${JSON.stringify(runId)}, ${childPid});
      if (${JSON.stringify(childState)} === 'exited') {
        store.recordChildPid(${JSON.stringify(runId)}, ${childPid});
        store.markChildExited(${JSON.stringify(runId)}, ${childPid});
      }
    }
    console.log(JSON.stringify({ ownerPid: process.pid }));
    store.close();
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim()).ownerPid;
}

async function startLiveLeaseOwner(dbPath) {
  const source = `
    import { openStore } from ${JSON.stringify(storeModuleUrl)};
    const store = openStore(${JSON.stringify(dbPath)});
    store.createRun({ runId: 'run-live', jobId: 'linkedin-draft', date: '2026-10-14' });
    store.setRunState('run-live', 'running', 'Started');
    store.acquireLease('run-live');
    console.log('ready');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('lease owner did not become ready')), 5000);
    child.once('error', reject);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.includes('ready')) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  return child;
}

async function startLiveChild() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await once(child, 'spawn');
  return child;
}

test('persists supported run states and bounded summaries', async () => {
  await withStore(async ({ store, open }) => {
    const { run, duplicate } = store.createRun({ runId: 'run-1', jobId: 'linkedin-draft', date: '2026-10-14' });
    assert.equal(duplicate, false);
    assert.equal(run.state, 'queued');

    for (const [state, summary] of [
      ['running', 'Started'], ['succeeded', 'Draft ready'], ['failed', 'Runner failed'],
    ]) {
      store.setRunState('run-1', state, summary);
      assert.equal(store.getSnapshot().runs[0].state, state);
      assert.equal(store.getSnapshot().runs[0].summary, summary);
    }
    assert.throws(() => store.setRunState('run-1', 'publishing', 'Not supported'), /state/i);
    assert.throws(() => store.setRunState('run-1', 'failed', 'x'.repeat(501)), /summary/i);
    store.close();

    const reopened = open();
    assert.equal(reopened.getSnapshot().runs[0].state, 'failed');
    reopened.close();
  });
});
test('refuses a duplicate job/date while returning the existing run', async () => {
  await withStore(async ({ store }) => {
    store.createRun({ runId: 'run-1', jobId: 'linkedin-draft', date: '2026-10-14' });
    const result = store.createRun({ runId: 'run-2', jobId: 'linkedin-draft', date: '2026-10-14' });
    assert.equal(result.duplicate, true);
    assert.equal(result.run.runId, 'run-1');
    assert.equal(store.getSnapshot().runs.length, 1);
    assert.throws(() => store.createRun({ runId: 'run-3', jobId: 'linkedin-draft', date: '2026-02-30' }), /date/i);
  });
});
test('stores events in timestamp and insertion order with validated artifact paths', async () => {
  await withStore(async ({ store }) => {
    store.createRun({ runId: 'run-1', jobId: 'linkedin-draft', date: '2026-10-14' });
    store.addEvent({ runId: 'run-1', jobId: 'linkedin-draft', state: 'queued', summary: 'Queued' });
    store.addEvent({ runId: 'run-1', jobId: 'linkedin-draft', state: 'succeeded', summary: 'Draft saved', artifactPath: draftPath });
    const events = store.getSnapshot().events;
    assert.deepEqual(events.map((event) => event.summary), ['Queued', 'Draft saved']);
    assert.equal(events[1].artifactPath, draftPath);
    assert.throws(() => store.addEvent({ runId: 'run-1', jobId: 'linkedin-draft', state: 'succeeded', summary: 'bad', artifactPath: `${draftRoot}\\..\\secrets.txt` }), /artifact/i);
    assert.throws(() => store.addEvent({ runId: 'run-1', jobId: 'linkedin-draft', state: 'oops', summary: 'bad' }), /state/i);
  });
});
test('acquires the model lease atomically across independent database connections', async () => {
  await withStore(async ({ store, open }) => {
    const other = open();
    store.createRun({ runId: 'run-1', jobId: 'linkedin-draft', date: '2026-10-14' });
    store.createRun({ runId: 'run-2', jobId: 'linkedin-draft', date: '2026-10-15' });
    assert.deepEqual(store.acquireLease('run-1'), { acquired: true, ownerRunId: 'run-1' });
    assert.deepEqual(other.acquireLease('run-2'), { acquired: false, ownerRunId: 'run-1' });
    assert.equal(other.releaseLease('run-2'), false);
    assert.equal(other.getSnapshot().lease.ownerRunId, 'run-1');
    assert.equal(store.releaseLease('run-1'), true);
    assert.deepEqual(other.acquireLease('run-2'), { acquired: true, ownerRunId: 'run-2' });
    other.close();
  });
});
test('prunes old events without deleting runs or draft artifacts', async () => {
  await withStore(async ({ dir, store }) => {
    const existingDraft = path.join(dir, 'draft.md');
    await writeFile(existingDraft, 'review me', 'utf8');
    store.createRun({ runId: 'run-1', jobId: 'linkedin-draft', date: '2026-10-14' });
    store.addEvent({ runId: 'run-1', jobId: 'linkedin-draft', state: 'succeeded', summary: 'Draft saved', artifactPath: draftPath });
    const removed = store.pruneEvents(new Date(Date.now() + 1000).toISOString());
    assert.equal(removed, 1);
    assert.equal(store.getSnapshot().events.length, 0);
    assert.equal(store.getSnapshot().runs.length, 1);
    assert.equal(await readFile(existingDraft, 'utf8'), 'review me');
  });
});
test('reconciles an unleased running run to interrupted when reopened', async () => {
  await withStore(async ({ store, open }) => {
    store.createRun({ runId: 'run-1', jobId: 'linkedin-draft', date: '2026-10-14' });
    store.setRunState('run-1', 'running', 'Started');
    store.close();

    const reopened = open();
    const snapshot = reopened.getSnapshot();
    assert.equal(snapshot.runs[0].state, 'interrupted');
    assert.ok(snapshot.events.some((event) => event.state === 'interrupted'));
    reopened.close();
  });
});

test('does not interrupt a lease owned by another live process when opened', async () => {
  await withStore(async ({ dbPath, open }) => {
    const owner = await startLiveLeaseOwner(dbPath);
    try {
      const other = open();
      const snapshot = other.getSnapshot();
      assert.equal(snapshot.runs[0].state, 'running');
      assert.equal(snapshot.lease.ownerRunId, 'run-live');
      assert.equal(snapshot.lease.ownerPid, owner.pid);
      assert.equal(snapshot.lease.childState, 'not_started');
    } finally {
      owner.kill();
      await once(owner, 'exit');
    }
  });
});

test('records child startup, PID, and confirmed child-tree exit only for the lease owner', async () => {
  await withStore(async ({ dbPath, store }) => {
    store.createRun({ runId: 'run-1', jobId: 'linkedin-draft', date: '2026-10-14' });
    store.acquireLease('run-1');
    const otherProcess = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { openStore } from ${JSON.stringify(storeModuleUrl)};
      const other = openStore(${JSON.stringify(dbPath)});
      console.log(other.markChildStarting('run-1'));
      other.close();
    `], { encoding: 'utf8' });
    assert.equal(otherProcess.status, 0, otherProcess.stderr);
    assert.equal(otherProcess.stdout.trim(), 'false');
    assert.equal(store.markChildStarting('run-1'), true);
    assert.equal(store.getSnapshot().lease.childState, 'starting');
    assert.equal(store.recordChildPid('run-1', 7654321), true);
    assert.equal(store.getSnapshot().lease.childState, 'running');
    assert.equal(store.getSnapshot().lease.childPid, 7654321);
    const foreignExit = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { openStore } from ${JSON.stringify(storeModuleUrl)};
      const other = openStore(${JSON.stringify(dbPath)});
      console.log(other.markChildExited('run-1', 7654321));
      other.close();
    `], { encoding: 'utf8' });
    assert.equal(foreignExit.status, 0, foreignExit.stderr);
    assert.equal(foreignExit.stdout.trim(), 'false');
    assert.equal(store.markChildExited('run-1', 7654321), true);
    assert.equal(store.getSnapshot().lease.childState, 'exited');
  });
});

test('keeps uncertain child launch leases held during recovery', async () => {
  await withStore(async ({ store }) => {
    store.createRun({ runId: 'run-1', jobId: 'linkedin-draft', date: '2026-10-14' });
    store.setRunState('run-1', 'running', 'Started');
    store.acquireLease('run-1');
    store.markChildStarting('run-1');
    const ownerPid = store.getSnapshot().lease.ownerPid;
    assert.equal(store.recoverInterruptedRun({
      runId: 'run-1', expectedOwnerPid: ownerPid, expectedChildPid: null,
      ownerExited: true, childTreeExited: true,
    }), false);
    assert.equal(store.getSnapshot().runs[0].state, 'running');
    assert.equal(store.getSnapshot().lease.ownerRunId, 'run-1');
    assert.equal(store.getSnapshot().events.some((event) => event.state === 'interrupted'), false);
  });
});

test('refuses recovery without both process-exit proofs and exact stored identities', async () => {
  await withStore(async ({ dbPath, open }) => {
    const ownerPid = seedLeaseFromExitedOwner(dbPath, { runId: 'run-1', childState: 'running', childPid: 7654321 });
    const store = open();
    assert.deepEqual(store.acquireLease('run-1'), { acquired: false, ownerRunId: 'run-1' });
    assert.equal(store.releaseLease('run-1'), false);
    const proof = { runId: 'run-1', expectedOwnerPid: ownerPid, expectedChildPid: 7654321, ownerExited: true, childTreeExited: false };
    assert.equal(store.recoverInterruptedRun(proof), false);
    assert.equal(store.getSnapshot().runs[0].state, 'running');
    assert.equal(store.getSnapshot().lease.ownerRunId, 'run-1');
    assert.equal(store.recoverInterruptedRun({ ...proof, childTreeExited: true, expectedOwnerPid: ownerPid + 1 }), false);
    assert.equal(store.getSnapshot().lease.ownerRunId, 'run-1');
  });
});

test('refuses recovery while the recorded child process is still alive', async () => {
  await withStore(async ({ dbPath, open }) => {
    const child = await startLiveChild();
    try {
      const ownerPid = seedLeaseFromExitedOwner(dbPath, { runId: 'run-1', childState: 'running', childPid: child.pid });
      const store = open();
      assert.equal(store.recoverInterruptedRun({
        runId: 'run-1', expectedOwnerPid: ownerPid, expectedChildPid: child.pid,
        ownerExited: true, childTreeExited: true,
      }), false);
      assert.equal(store.getSnapshot().runs[0].state, 'running');
      assert.equal(store.getSnapshot().lease.ownerRunId, 'run-1');
    } finally {
      child.kill();
      await once(child, 'exit');
    }
  });
});

test('recovers only the matching exited owner and child, atomically recording interruption and clearing lease', async () => {
  await withStore(async ({ dbPath, open }) => {
    const ownerPid = seedLeaseFromExitedOwner(dbPath, { runId: 'run-1', childState: 'exited', childPid: 7654321 });
    const store = open();
    const proof = { runId: 'run-1', expectedOwnerPid: ownerPid, expectedChildPid: 7654321, ownerExited: true, childTreeExited: true };
    assert.equal(store.recoverInterruptedRun({ ...proof, ownerExited: false }), false);
    assert.equal(store.getSnapshot().lease.ownerRunId, 'run-1');
    assert.equal(store.recoverInterruptedRun(proof), true);

    const snapshot = store.getSnapshot();
    assert.equal(snapshot.runs[0].state, 'interrupted');
    assert.equal(snapshot.runs[0].summary, 'Hub recovered after the previous process and child tree exited.');
    assert.equal(snapshot.lease.ownerRunId, null);
    assert.equal(snapshot.lease.ownerPid, null);
    assert.equal(snapshot.lease.childPid, null);
    assert.equal(snapshot.lease.childState, 'none');
    assert.equal(snapshot.events.length, 1);
    assert.equal(snapshot.events[0].state, 'interrupted');
    assert.equal(snapshot.events[0].runId, 'run-1');
  });
});

test('rejects unsafe persisted artifact paths and unknown run references', async () => {
  await withStore(async ({ store }) => {
    store.createRun({ runId: 'run-1', jobId: 'linkedin-draft', date: '2026-10-14' });
    for (const artifactPath of ['relative.md', 'C:\\Loom\\secrets.txt', `${draftRoot}\\..\\private.md`]) {
      assert.throws(() => store.addEvent({ runId: 'run-1', jobId: 'linkedin-draft', state: 'succeeded', summary: 'bad', artifactPath }), /artifact/i);
    }
    assert.throws(() => store.acquireLease('missing'), /run/i);
  });
});
