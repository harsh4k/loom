import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

class Element {
  constructor() {
    this.children = [];
    this.dataset = {};
    this.hidden = false;
    this._textContent = '';
    this.textContentWrites = 0;
    this.classList = { toggle() {} };
  }
  get textContent() { return this._textContent; }
  set textContent(value) { this._textContent = String(value); this.textContentWrites++; }
  get firstChild() { return this.children[0] ?? null; }
  append(...children) { this.children.push(...children); }
  removeChild(child) { this.children = this.children.filter((item) => item !== child); }
  setAttribute() {}
  addEventListener() {}
  focus() {}
}

async function bootDashboard(snapshots) {
  const elements = new Map();
  elements.set('#live-notice', new Element());
  const pages = ['overview', 'automation', 'activity', 'drafts'].map((view) => Object.assign(new Element(), { dataset: { page: view } }));
  const buttons = ['overview', 'activity', 'drafts'].map((view) => Object.assign(new Element(), { dataset: { view } }));
  let nextPoll;
  const document = {
    body: new Element(),
    visibilityState: 'visible',
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, new Element());
      return elements.get(selector);
    },
    querySelectorAll(selector) { return selector === '[data-page]' ? pages : selector === '.nav-button' ? buttons : []; },
    createElement() { return new Element(); },
    createElementNS() { return new Element(); },
    addEventListener() {},
  };
  const context = {
    document,
    fetch: async (url) => ({
      ok: true, status: 200,
      json: async () => (url === '/api/automations' ? { automations: AUTOMATIONS }
        : url === '/api/linkedin' ? { configured: false, connected: false, redirectUri: 'http://localhost:4173/linkedin/callback' }
          : url === '/api/health' ? { ollama: true, diskFreeBytes: 50 * 1024 ** 3, lastBackupAt: null }
            : url === '/api/connections' ? { notion: { connected: false }, github: { connected: false } }
              : snapshots.shift()),
    }),
    URLSearchParams,
    location: { search: '', pathname: '/' },
    history: { replaceState() {} },
    setTimeout(callback) { nextPoll = callback; return 1; },
    clearTimeout() {},
  };
  const source = await readFile(new URL('../src/public/app.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, context, { filename: 'src/public/app.js' });
  for (let attempt = 0; attempt < 10 && !nextPoll; attempt++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(typeof nextPoll, 'function', 'initial snapshot schedules polling');
  return { elements, poll: () => nextPoll() };
}

const AUTOMATIONS = [
  { id: 'linkedin-draft', name: 'LinkedIn posts', app: 'linkedin', status: 'active', description: '', schedule: { days: [2, 4], time: '08:00', label: '' } },
  { id: 'notion-projects', name: 'Notion projects', app: 'notion', status: 'planned', description: '', schedule: null },
];
const run = { runId: 'run-1', jobId: 'linkedin-draft', state: 'running', summary: 'Working' };
const snapshot = (activeRun, recentRuns = []) => ({ paused: false, activeRun, queuedRuns: [], recentRuns, events: [] });

test('announces a completed run once across repeated dashboard polls', async () => {
  const completed = snapshot(null, [{ ...run, state: 'succeeded', summary: 'Draft saved' }]);
  const dashboard = await bootDashboard([snapshot(run), completed, completed]);
  await dashboard.poll();
  const notice = dashboard.elements.get('#live-notice');
  assert.equal(notice.textContent, 'LinkedIn posts completed.');
  const writes = notice.textContentWrites;
  await dashboard.poll();
  assert.equal(notice.textContentWrites, writes, 'an unchanged poll does not re-announce the run');
});

test('announces a failed run detected by dashboard polling', async () => {
  const dashboard = await bootDashboard([snapshot(run), snapshot(null, [{ ...run, state: 'failed', summary: 'Runner failed' }])]);
  await dashboard.poll();
  assert.equal(dashboard.elements.get('#live-notice').textContent, 'LinkedIn posts failed.');
});

test('dashboard ships local brand marks for every listed automation app', async () => {
  const html = await readFile(new URL('../src/public/index.html', import.meta.url), 'utf8');
  const { AUTOMATIONS: listed } = await import('../src/automations.mjs');
  for (const { app } of listed) {
    assert.match(html, new RegExp(`<symbol id="brand-${app}" viewBox="0 0 24 24">`), app);
  }
  assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org)/, 'no third-party requests');
});
