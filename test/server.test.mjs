import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openStore } from '../src/store.mjs';
import { createQueue } from '../src/queue.mjs';
import { createServer } from '../src/server.mjs';

const DRAFTS_ROOT = 'C:\\Loom\\linkedin\\drafts';
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);

function localDate() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function waitForRun(store, runId, predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const run = store.getSnapshot().runs.find((item) => item.runId === runId);
    if (predicate(run)) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Run ${runId} did not reach the expected state`);
}

async function withServer(run, { handler, serverOptions = {} } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'automation-hub-server-'));
  const store = openStore(path.join(dir, 'hub.sqlite'));
  const jobs = { 'linkedin-draft': { run: handler ?? (async () => ({ summary: 'Test draft ready for review.', artifactPath: null })) } };
  const queue = createQueue({ store, jobs, retryDelayMs: 10 });
  let app;
  try {
    app = await createServer({ store, queue, port: 0, ...serverOptions });
    await run({ app, baseUrl: `http://127.0.0.1:${app.address.port}`, store, queue });
  } finally {
    const activeRun = queue.snapshot().activeRun;
    queue.destroy();
    if (activeRun) await waitForRun(store, activeRun.runId, (item) => TERMINAL.has(item?.state));
    if (app) await app.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function rawRequest(url, method, headers = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1', port: Number(target.port), path: `${target.pathname}${target.search}`,
      method, headers,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('server binds only to IPv4 loopback and refuses a non-loopback host option', async () => {
  const deps = {
    store: { getSnapshot: () => ({ runs: [], events: [] }) },
    queue: { snapshot: () => ({ paused: false, activeRun: null, queuedRuns: [], recentRuns: [], events: [] }) },
  };
  await assert.rejects(createServer({ ...deps, host: '0.0.0.0' }), /127\.0\.0\.1/);
  await withServer(async ({ app }) => assert.equal(app.address.address, '127.0.0.1'));
});

test('snapshot is bounded, redacts artifact paths, and sends private same-origin headers', async () => {
  await withServer(async ({ baseUrl, app, store }) => {
    const run = store.createRun({ runId: 'snapshot-run', jobId: 'linkedin-draft', date: '2026-10-14' }).run;
    store.setRunState(run.runId, 'succeeded', 'Draft ready for review.');
    for (let index = 0; index < 260; index++) {
      store.addEvent({ runId: run.runId, jobId: run.jobId, state: 'succeeded', summary: `Event ${index}` });
    }
    store.addEvent({
      runId: run.runId, jobId: run.jobId, state: 'succeeded', summary: 'Draft ready.',
      artifactPath: `${DRAFTS_ROOT}\\2026-10-14-test.md`,
    });

    const response = await fetch(`${baseUrl}/api/snapshot`);
    const snapshot = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(snapshot), ['paused', 'activeRun', 'queuedRuns', 'recentRuns', 'events', 'retries']);
    assert.equal(snapshot.recentRuns[0].runId, run.runId);
    assert.equal(snapshot.events.length, 250);
    assert.equal(Object.hasOwn(snapshot.events.at(-1), 'artifactPath'), false);
    assert.equal(JSON.stringify(snapshot).includes(DRAFTS_ROOT), false);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(app.address.address, '127.0.0.1');
  });
});

test('serves only approved self-hosted font assets with the correct type', async () => {
  await withServer(async ({ baseUrl }) => {
    for (const name of ['audiowide', 'geo', 'geo-italic', 'open-sans', 'open-sans-italic']) {
      const response = await fetch(`${baseUrl}/fonts/${name}.woff2`);
      assert.equal(response.status, 200, name);
      assert.equal(response.headers.get('content-type'), 'font/woff2');
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.toString('ascii', 0, 4), 'wOF2', name);
    }
    assert.equal((await fetch(`${baseUrl}/fonts/unknown.woff2`)).status, 404);
  });
});

test('launch accepts only empty input, uses the India date, and runs again on request', async () => {
  await withServer(async ({ baseUrl, store }) => {
    const first = await fetch(`${baseUrl}/api/jobs/linkedin-draft`, { method: 'POST' });
    const accepted = await first.json();
    assert.equal(first.status, 202);
    assert.match(accepted.runId, /^[0-9a-f-]{36}$/i);
    await waitForRun(store, accepted.runId, (run) => run?.state === 'succeeded');
    assert.equal(store.getSnapshot().runs.find((run) => run.runId === accepted.runId).date, localDate());

    // Run now again the same day starts the same run over, keeping one run per day.
    const again = await fetch(`${baseUrl}/api/jobs/linkedin-draft`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(again.status, 202);
    assert.equal((await again.json()).runId, accepted.runId);
    const whileQueued = await fetch(`${baseUrl}/api/jobs/linkedin-draft`, { method: 'POST' });
    if (whileQueued.status === 409) assert.equal((await whileQueued.json()).error.code, 'DUPLICATE_RUN');
    const rerun = await waitForRun(store, accepted.runId, (run) => run?.state === 'succeeded' && run.attempts >= 2);
    assert.ok(rerun.attempts >= 2);

    const forgedDate = await fetch(`${baseUrl}/api/jobs/linkedin-draft`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"date":"2000-01-01"}',
    });
    assert.equal(forgedDate.status, 400);
  });
});

test('launch bounds bodies and rejects malformed or non-JSON payloads', async () => {
  await withServer(async ({ baseUrl }) => {
    const malformed = await fetch(`${baseUrl}/api/jobs/linkedin-draft`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
    });
    assert.equal(malformed.status, 400);

    const wrongType = await fetch(`${baseUrl}/api/jobs/linkedin-draft`, {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}',
    });
    assert.equal(wrongType.status, 415);

    const oversized = await fetch(`${baseUrl}/api/jobs/linkedin-draft`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: 'x'.repeat(2048) }),
    });
    assert.equal(oversized.status, 413);
    assert.equal(JSON.stringify(await oversized.json()).includes('stack'), false);
  });
});

test('pause and resume return their new bounded snapshots', async () => {
  await withServer(async ({ baseUrl }) => {
    const paused = await fetch(`${baseUrl}/api/pause`, { method: 'POST' });
    assert.equal(paused.status, 200);
    assert.equal((await paused.json()).paused, true);
    const resumed = await fetch(`${baseUrl}/api/resume`, { method: 'POST' });
    assert.equal(resumed.status, 200);
    assert.equal((await resumed.json()).paused, false);
  });
});

test('stop only accepts an active run and distinguishes unknown from non-active runs', async () => {
  const waitForAbort = ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
  });
  await withServer(async ({ baseUrl, store }) => {
    const response = await fetch(`${baseUrl}/api/jobs/linkedin-draft`, { method: 'POST' });
    const { runId } = await response.json();
    await waitForRun(store, runId, (run) => run?.state === 'running');

    const unknown = await fetch(`${baseUrl}/api/runs/00000000-0000-4000-8000-000000000000/stop`, { method: 'POST' });
    assert.equal(unknown.status, 404);
    const stopped = await fetch(`${baseUrl}/api/runs/${runId}/stop`, { method: 'POST' });
    assert.equal(stopped.status, 202);
    await waitForRun(store, runId, (run) => run?.state === 'cancelled');
    const alreadyStopped = await fetch(`${baseUrl}/api/runs/${runId}/stop`, { method: 'POST' });
    assert.equal(alreadyStopped.status, 409);
  }, { handler: waitForAbort });
});

test('rejects foreign Host and Origin headers and does not serve private source files', async () => {
  await withServer(async ({ baseUrl }) => {
    const host = await rawRequest(`${baseUrl}/api/snapshot`, 'GET', { host: 'evil.example' });
    assert.equal(host.status, 403);
    const origin = await fetch(`${baseUrl}/api/pause`, {
      method: 'POST', headers: { origin: 'http://evil.example' },
    });
    assert.equal(origin.status, 403);

    for (const pathname of ['/src/server.mjs', '/package.json', '/test/server.test.mjs']) {
      const response = await fetch(`${baseUrl}${pathname}`);
      assert.equal(response.status, 404);
      assert.equal((await response.text()).includes('import '), false);
    }
    const wrongMethod = await fetch(`${baseUrl}/api/pause`);
    assert.equal(wrongMethod.status, 405);
  });
});

test('serves only a canonical database-known Markdown draft and rejects path escapes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'automation-hub-draft-api-'));
  const draftsRoot = path.join(root, 'drafts');
  const externalDir = path.join(root, 'external');
  await mkdir(draftsRoot);
  await mkdir(externalDir);
  const runId = 'draft-preview-1';
  const draftPath = path.join(draftsRoot, '2026-10-14-review.md');
  await writeFile(draftPath, 'Needs review — not published.');
  const outsidePath = path.join(externalDir, 'secret.md');
  await writeFile(outsidePath, 'private');
  const record = { runId, jobId: 'linkedin-draft', date: '2026-10-14', state: 'succeeded', summary: 'Draft ready.' };
  const saved = { runs: [record], events: [{ runId, jobId: record.jobId, state: 'succeeded', artifactPath: draftPath }] };
  const store = { getSnapshot: () => saved };
  const queue = {
    snapshot: () => ({ paused: false, activeRun: null, queuedRuns: [], recentRuns: saved.runs, events: saved.events }),
    enqueue() {}, pause() {}, resume() {}, stop() { return false; },
  };
  const app = await createServer({ store, queue, port: 0, draftsRoot });
  const baseUrl = `http://127.0.0.1:${app.address.port}`;
  try {
    const good = await fetch(`${baseUrl}/api/drafts/${runId}`);
    assert.equal(good.status, 200);
    assert.equal(good.headers.get('content-type'), 'text/markdown; charset=utf-8');
    assert.equal(await good.text(), 'Needs review — not published.');

    saved.events[0].artifactPath = outsidePath;
    const outside = await fetch(`${baseUrl}/api/drafts/${runId}`);
    assert.equal(outside.status, 404);
    assert.equal((await outside.json()).error.code, 'NOT_FOUND');

    await symlink(externalDir, path.join(draftsRoot, 'linked'), 'junction');
    saved.events[0].artifactPath = path.join(draftsRoot, 'linked', 'secret.md');
    const escaped = await fetch(`${baseUrl}/api/drafts/${runId}`);
    assert.equal(escaped.status, 404);
    const traversal = await fetch(`${baseUrl}/api/drafts/%2e%2e%5cpackage.json`);
    assert.equal(traversal.status, 404);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});


test('lists automations and marks only registered jobs as active', async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/automations`);
    assert.equal(response.status, 200);
    const { automations } = await response.json();
    assert.deepEqual(automations.filter((item) => item.status === 'active').map((item) => item.id), ['linkedin-draft', 'notion-projects', 'project-details', 'portfolio-sync', 'weekly-report']);
    assert.equal((await fetch(`${baseUrl}/api/automations`, { method: 'POST' })).status, 405);
  });
});

test('serves the web app manifest and icons so the hub can be installed as an app', async () => {
  await withServer(async ({ baseUrl }) => {
    const manifest = await fetch(`${baseUrl}/manifest.webmanifest`);
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get('content-type'), /application\/manifest\+json/);
    const body = await manifest.json();
    assert.equal(body.display, 'standalone');
    for (const icon of body.icons) {
      const response = await fetch(`${baseUrl}${icon.src}`);
      assert.equal(response.status, 200, icon.src);
      assert.equal(response.headers.get('content-type'), 'image/png');
    }
    assert.match(await (await fetch(`${baseUrl}/`)).text(), /<link rel="manifest" href="\/manifest.webmanifest">/);
  });
});

test('LinkedIn error text is shown without HTML entities', async () => {
  const { decodeEntities } = await import('../src/server.mjs');
  assert.equal(decodeEntities('Scope &quot;openid&quot; is not authorized &amp; &#39;x&#39; &#x41;'), 'Scope "openid" is not authorized & \'x\' A');
  assert.equal(decodeEntities('&bogus; stays'), '&bogus; stays');
});
