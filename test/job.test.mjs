import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLinkedInDraftJob } from '../src/jobs/linkedin-draft.mjs';
import { fakeSpawn } from './fake-child.mjs';

async function withDrafts(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'automation-hub-job-'));
  const draftsRoot = path.join(root, 'drafts');
  await mkdir(draftsRoot);
  try { await run({ root, draftsRoot }); } finally { await rm(root, { recursive: true, force: true }); }
}

function leaseCallbacks(calls = []) {
  return {
    onChildStarting: () => true,
    onChildStarted: (pid) => { calls.push(['started', pid]); return true; },
    onChildExited: (pid) => { calls.push(['exited', pid]); return true; },
  };
}

test('runs the fixed PowerShell runner and accepts only a canonical draft artifact', async () => {
  await withDrafts(async ({ draftsRoot }) => {
    const draftPath = path.join(draftsRoot, '2026-10-14-topic.md');
    await writeFile(draftPath, 'Draft under review');
    const fake = fakeSpawn({ output: `Wrote draft: ${draftPath}\n` });
    const job = createLinkedInDraftJob({ draftsRoot, runnerPath: 'C:\\hub\\scripts\\linkedin-local-draft.ps1', spawn: fake.spawn });
    const lease = [];
    const result = await job.run({ date: '2026-10-14', signal: new AbortController().signal, ...leaseCallbacks(lease) });

    assert.equal(result.artifactPath, draftPath);
    assert.match(result.summary, /Draft saved/);
    assert.equal(fake.calls[0].command, 'powershell.exe');
    assert.deepEqual(fake.calls[0].args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']);
    assert.ok(fake.calls[0].args.includes('qwen3.5:9b-q4_K_M'));
    assert.deepEqual(lease, [['started', 4321], ['exited', 4321]]);
  });
});

test('treats the runner same-day skip as a successful no-artifact run', async () => {
  await withDrafts(async ({ draftsRoot }) => {
    const fake = fakeSpawn({ output: 'A draft already exists for 2026-10-14. Skipping.\n' });
    const job = createLinkedInDraftJob({ draftsRoot, spawn: fake.spawn });
    const result = await job.run({ date: '2026-10-14', signal: new AbortController().signal, ...leaseCallbacks() });
    assert.equal(result.artifactPath, null);
    assert.match(result.summary, /already exists/);
  });
});

test('fails on an unsuccessful runner exit', async () => {
  await withDrafts(async ({ draftsRoot }) => {
    const fake = fakeSpawn({ exitCode: 1, output: 'Ollama request failed' });
    const job = createLinkedInDraftJob({ draftsRoot, spawn: fake.spawn });
    await assert.rejects(job.run({ date: '2026-10-14', signal: new AbortController().signal, ...leaseCallbacks() }), /exited with code 1/);
  });
});

test('rejects missing, outside-root, and symlink-escaped artifacts', async () => {
  await withDrafts(async ({ root, draftsRoot }) => {
    const outside = path.join(root, 'outside.md');
    await writeFile(outside, 'outside');
    const missing = fakeSpawn({ output: `Wrote draft: ${path.join(draftsRoot, 'missing.md')}\n` });
    await assert.rejects(createLinkedInDraftJob({ draftsRoot, spawn: missing.spawn }).run({ date: '2026-10-14', signal: new AbortController().signal, ...leaseCallbacks() }), /could not be resolved/);

    const outsideSpawn = fakeSpawn({ output: `Wrote draft: ${outside}\n` });
    await assert.rejects(createLinkedInDraftJob({ draftsRoot, spawn: outsideSpawn.spawn }).run({ date: '2026-10-14', signal: new AbortController().signal, ...leaseCallbacks() }), /outside the LinkedIn drafts folder/);

    const externalDir = path.join(root, 'external');
    await mkdir(externalDir);
    const externalFile = path.join(externalDir, 'escaped.md');
    await writeFile(externalFile, 'escaped');
    const junction = path.join(draftsRoot, 'linked');
    await symlink(externalDir, junction, 'junction');
    const escaped = fakeSpawn({ output: `Wrote draft: ${path.join(junction, 'escaped.md')}\n` });
    await assert.rejects(createLinkedInDraftJob({ draftsRoot, spawn: escaped.spawn }).run({ date: '2026-10-14', signal: new AbortController().signal, ...leaseCallbacks() }), /outside the LinkedIn drafts folder/);
  });
});

test('timeout kills the whole child tree and waits for confirmed exit', async () => {
  await withDrafts(async ({ draftsRoot }) => {
    const fake = fakeSpawn({ hang: true });
    const lease = [];
    const job = createLinkedInDraftJob({ draftsRoot, spawn: fake.spawn, timeoutMs: 10 });
    await assert.rejects(job.run({ date: '2026-10-14', signal: new AbortController().signal, ...leaseCallbacks(lease) }), /timed out/);
    assert.ok(fake.calls.some((call) => call.command.toLowerCase().includes('taskkill')));
    assert.deepEqual(lease, [['started', 4321], ['exited', 4321]]);
  });
});

test('cancellation is distinct from timeout and an unconfirmed child keeps the lease unsafe', async () => {
  await withDrafts(async ({ draftsRoot }) => {
    const fake = fakeSpawn({ hang: true, killExitCode: 1, closeOnKill: false });
    const controller = new AbortController();
    const lease = [];
    const job = createLinkedInDraftJob({ draftsRoot, spawn: fake.spawn, timeoutMs: 5_000, killTimeoutMs: 15 });
    const pending = job.run({ date: '2026-10-14', signal: controller.signal, ...leaseCallbacks(lease) });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(pending, (error) => error.code === 'ERR_CHILD_EXIT_UNCONFIRMED');
    assert.deepEqual(lease, [['started', 4321]]);
  });
});
