import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MODEL, isHubUrl, isSafeExternal, newFailures, ollamaAppPath, readHubRoot, windowBounds , opensInBrowser } from '../desktop/lib.mjs';
import { MODEL as HUB_MODEL } from '../src/model.mjs';

test('the app window only shows the hub itself', () => {
  assert.equal(isHubUrl('http://127.0.0.1:4173/'), true);
  assert.equal(isHubUrl('http://127.0.0.1:4173/api/snapshot'), true);
  assert.equal(isHubUrl('http://localhost:4173/'), false);
  assert.equal(isHubUrl('http://127.0.0.1:4174/'), false);
  assert.equal(isHubUrl('not a url'), false);
});

test('only web links open in the default browser', () => {
  assert.equal(isSafeExternal('https://www.notion.so/page'), true);
  assert.equal(isSafeExternal('http://example.com'), true);
  assert.equal(isSafeExternal('file:///C:/Windows/system32/calc.exe'), false);
  assert.equal(isSafeExternal('javascript:alert(1)'), false);
  assert.equal(isSafeExternal('ms-settings:privacy'), false);
  assert.equal(isSafeExternal('http://127.0.0.1:4173/'), false);
});

test('each failed run is announced once, and only if it failed after the app opened', () => {
  const seen = new Set();
  const since = Date.parse('2026-10-17T10:00:00Z');
  const runs = [
    { runId: 'a', state: 'failed', updatedAt: '2026-10-17T09:00:00Z' },
    { runId: 'b', state: 'failed', updatedAt: '2026-10-17T11:00:00Z' },
    { runId: 'c', state: 'succeeded', updatedAt: '2026-10-17T11:00:00Z' },
  ];
  assert.deepEqual(newFailures(runs, seen, since).map((run) => run.runId), ['b']);
  assert.deepEqual(newFailures(runs, seen, since), []);
  assert.deepEqual(newFailures(null, seen, since), []);
});

test('hub location comes from the env, then the build file, then the parent folder', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hub-desktop-'));
  assert.equal(readHubRoot(dir, {}), path.resolve(dir, '..'));
  writeFileSync(path.join(dir, 'hub-root.json'), JSON.stringify({ root: 'X:\\hub' }));
  assert.equal(readHubRoot(dir, {}), 'X:\\hub');
  assert.equal(readHubRoot(dir, { HUB_ROOT: dir }), path.resolve(dir));
});

test('a broken saved window size falls back to the default', () => {
  assert.deepEqual(windowBounds(null), { width: 1280, height: 840 });
  assert.deepEqual(windowBounds({ width: 10, height: 10 }), { width: 1280, height: 840 });
  assert.deepEqual(windowBounds({ width: 1400.4, height: 900, x: 5, y: 6 }), { width: 1400, height: 900, x: 5, y: 6 });
  assert.deepEqual(windowBounds({ width: 1400, height: 900, x: 'a' }), { width: 1400, height: 900 });
});

test('Ollama is looked for in the per-user install folder', () => {
  assert.equal(ollamaAppPath({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }), path.join('C:\\Users\\me\\AppData\\Local', 'Programs', 'Ollama', 'ollama.exe'));
  assert.equal(ollamaAppPath({}), null);
});

test('Loom warms the same model the hub uses', () => {
  assert.equal(MODEL, HUB_MODEL);
});

test('LinkedIn sign-in leaves the Loom window for the browser', () => {
  assert.equal(opensInBrowser('http://127.0.0.1:4173/linkedin/connect'), true);
  assert.equal(opensInBrowser('https://www.linkedin.com/oauth/v2/authorization?x=1'), true);
  assert.equal(opensInBrowser('http://127.0.0.1:4173/'), false);
  assert.equal(opensInBrowser('http://127.0.0.1:4173/linkedin/callback?code=1'), false);
  assert.equal(opensInBrowser('file:///C:/evil'), false);
  assert.equal(opensInBrowser('not a url'), false);
});
