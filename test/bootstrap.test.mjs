import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function withCopiedHub(run) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'automation-hub-bootstrap-'));
  const hubRoot = path.join(temporaryRoot, 'hub');
  const launchCwd = path.join(temporaryRoot, 'outside');
  await mkdir(hubRoot);
  await mkdir(launchCwd);
  await cp(path.join(REPO_ROOT, 'src'), path.join(hubRoot, 'src'), { recursive: true });
  try {
    await run({ hubRoot, launchCwd });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function freeLoopbackPort() {
  const probe = createNetServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

test('direct entrypoint stores private hub data beside the code, not in the launch working directory', async () => {
  await withCopiedHub(async ({ hubRoot, launchCwd }) => {
    const port = await freeLoopbackPort();
    const child = spawn(process.execPath, [path.join(hubRoot, 'src', 'server.mjs')], {
      cwd: launchCwd, env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: 'ignore',
    });
    try {
      let response;
      for (let attempt = 0; attempt < 100 && !response && child.exitCode === null; attempt++) {
        try { response = await fetch(`http://127.0.0.1:${port}/api/snapshot`, { signal: AbortSignal.timeout(100) }); }
        catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
      }
      assert.ok(response, `server exited before listening (code ${child.exitCode})`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).paused, false);
      const dataDirectory = path.join(hubRoot, 'data');
      assert.ok((await stat(path.join(dataDirectory, 'hub.sqlite'))).isFile());
      await assert.rejects(stat(path.join(launchCwd, 'data', 'hub.sqlite')), { code: 'ENOENT' });
      if (process.platform === 'win32') {
        const acl = spawnSync('icacls.exe', [dataDirectory], { encoding: 'utf8', windowsHide: true });
        assert.equal(acl.status, 0, acl.stderr);
        assert.match(acl.stdout, /SYSTEM/i);
        assert.match(acl.stdout, /Administrators/i);
        assert.doesNotMatch(acl.stdout, /Everyone|BUILTIN\\Users|Authenticated Users/i);
      }
      child.kill('SIGTERM');
      const [code, signal] = await Promise.race([
        once(child, 'exit'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('hub did not stop after SIGTERM')), 5_000)),
      ]);
      if (process.platform === 'win32') {
        assert.equal(code, null);
        assert.equal(signal, 'SIGTERM');
      } else {
        assert.equal(code, 0);
        assert.equal(signal, null);
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
    }
  });
});

test('hub aborts an active draft job before HTTP shutdown completes', async () => {
  await withCopiedHub(async ({ hubRoot }) => {
    const { startHub } = await import(pathToFileURL(path.join(hubRoot, 'src', 'bootstrap.mjs')).href);
    let markStarted;
    let markAborted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const aborted = new Promise((resolve) => { markAborted = resolve; });
    const draftJob = {
      run({ signal }) {
        markStarted();
        return new Promise((resolve) => signal.addEventListener('abort', () => {
          markAborted();
          resolve({ summary: 'Stopped after the hub shutdown signal.' });
        }, { once: true }));
      },
    };
    const app = await startHub({ port: 0, draftJob, schedule: false, ollama: { isUp: async () => true, ensure: async () => ({ started: false }) } });
    const closeServer = app.server.close.bind(app.server);
    let finishServerClose;
    app.server.close = (callback) => {
      let finished = false;
      finishServerClose = () => {
        if (finished) return;
        finished = true;
        closeServer(callback);
      };
      return app.server;
    };
    let closing;
    try {
      const launch = await fetch(`http://127.0.0.1:${app.address.port}/api/jobs/linkedin-draft`, { method: 'POST' });
      assert.equal(launch.status, 202);
      await started;

      closing = app.close();
      const abortedBeforeDrain = await Promise.race([
        aborted.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 500)),
      ]);
      assert.equal(abortedBeforeDrain, true, 'active draft must be aborted before HTTP drain completes');
      finishServerClose();
      await closing;
    } finally {
      finishServerClose?.();
      await (closing ?? app.close());
    }
  });
});
