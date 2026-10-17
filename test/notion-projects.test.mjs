import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalRepoUrl } from '../src/github/repos.mjs';
import { buildTechStack } from '../src/github/stack.mjs';
import { createJsonClient } from '../src/http.mjs';
import { isRetryable } from '../src/errors.mjs';
import { createNotionProjectsJob, ARCHIVED } from '../src/jobs/notion-projects.mjs';
import { openLedger } from '../src/ledger.mjs';
import { toProperties } from '../src/notion/client.mjs';

const NOW = new Date('2026-10-16T12:00:00Z');

async function tempDir(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'automation-hub-notion-'));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

const json = (status, body, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
const repo = (name, extra = {}) => ({
  name, full_name: `example-dev/${name}`, html_url: `https://github.com/example-dev/${name}`, fork: false, archived: false,
  description: '', homepage: '', private: false, pushed_at: '2026-01-01T00:00:00Z', ...extra,
});

// A fake GitHub and Notion behind one fetch. Notion pages live in `pages`, as Notion objects.
function fakeWorld({ repos, pages = [], languages = {}, files = {}, notionStatus = null }) {
  const calls = [];
  let nextId = 1;
  const notionPage = (id, values) => ({ id, archived: false, properties: toProperties(values) });
  const store = new Map(pages.map((values) => { const id = `page-${nextId++}`; return [id, notionPage(id, values)]; }));
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push(`${method} ${url}`);
    const { pathname } = new URL(url);
    if (url.startsWith('https://api.github.com/users/example-dev/repos')) return json(200, repos);
    if (url.startsWith('https://raw.githubusercontent.com/')) {
      const [, , name, , file] = pathname.split('/');
      return files[name]?.[file] ? json(200, files[name][file]) : json(404, 'Not found');
    }
    const repoMatch = /^\/repos\/example-dev\/([^/]+)(\/languages)?$/.exec(pathname);
    if (url.startsWith('https://api.github.com') && repoMatch) {
      const found = repos.find((item) => item.name.toLowerCase() === repoMatch[1].toLowerCase());
      if (repoMatch[2]) return json(200, languages[repoMatch[1]] ?? {});
      return found ? json(200, found) : json(404, { message: 'Not Found' });
    }
    if (url.startsWith('https://api.notion.com')) {
      if (notionStatus) return json(notionStatus, { message: 'nope' });
      if (pathname.endsWith('/query')) return json(200, { results: [...store.values()], has_more: false, next_cursor: null });
      if (pathname === '/v1/pages' && method === 'POST') {
        const id = `page-${nextId++}`;
        const page = { id, archived: false, properties: JSON.parse(init.body).properties };
        store.set(id, page);
        return json(200, page);
      }
      const pageMatch = /^\/v1\/pages\/(.+)$/.exec(pathname);
      if (pageMatch && store.has(pageMatch[1])) {
        const page = store.get(pageMatch[1]);
        if (method === 'PATCH') Object.assign(page.properties, JSON.parse(init.body).properties);
        return json(200, page);
      }
    }
    return json(404, { message: `No fake for ${method} ${url}` });
  };
  return { fetchImpl, calls, store };
}

function fakeConnections(tokens = { notion: 'secret_notion_key_1234567890' }) {
  const problems = [];
  return { problems, api: { token: (provider) => tokens[provider] ?? null, reportProblem: async (provider, message) => { problems.push([provider, message]); } } };
}

function makeJob(dir, world, connections = fakeConnections()) {
  return createNotionProjectsJob({
    connections: () => connections.api, openLedger: () => openLedger(path.join(dir, 'hub.sqlite')), fetch: world.fetchImpl, now: () => NOW,
  });
}

const prop = (page, field) => {
  const value = page.properties[field];
  if (value?.title) return value.title.map((part) => part.text.content).join('');
  if (value?.rich_text) return value.rich_text.map((part) => part.text.content).join('');
  if (value && 'select' in value) return value.select?.name ?? null;
  return value?.url ?? null;
};
const pageNamed = (world, name) => [...world.store.values()].find((page) => prop(page, 'Name') === name);

test('GitHub URLs are compared in one normalised form', () => {
  assert.equal(canonicalRepoUrl('https://github.com/example-dev/Getcited'), 'https://github.com/example-dev/getcited');
  assert.equal(canonicalRepoUrl('http://www.github.com/example-dev/Bunny-OS.git/'), 'https://github.com/example-dev/bunny-os');
  assert.equal(canonicalRepoUrl('https://gitlab.com/example-dev/x'), null);
  assert.equal(canonicalRepoUrl(null), null);
});

test('tech stack comes only from manifests and the language list', () => {
  const stack = buildTechStack({
    languages: { TypeScript: 9000, CSS: 800, Shell: 10 },
    files: { 'package.json': JSON.stringify({ dependencies: { react: '^19.1.0', 'left-pad': '1.0.0', three: '0.170.0' }, devDependencies: { vite: '^6.0.0', tailwindcss: '4.0.0', typescript: '^5' } }) },
  });
  assert.equal(stack, 'React 19, Three.js, Vite 6, Tailwind CSS 4, TypeScript, CSS');
  assert.equal(buildTechStack({ languages: { Python: 10 }, files: { 'requirements.txt': 'psutil>=5\nflask==3.0\n# comment\nunknownpkg' } }), 'psutil, Flask, Python');
  assert.equal(buildTechStack({ files: { 'Cargo.toml': '[package]\nname="x"\n[dependencies]\ntokio = "1"\nserde = { version = "1" }' } }), 'Rust, Tokio, Serde');
  assert.equal(buildTechStack({ files: { 'package.json': '{not json' } }), '');
});

test('adds new repos, leaves your filled fields alone, archives archived repos', async () => tempDir(async (dir) => {
  const world = fakeWorld({
    repos: [
      repo('apexfr', { description: 'Late Apex studio site', pushed_at: '2026-10-01T00:00:00Z' }),
      repo('nexcart', { description: 'GitHub description' }),
      repo('portfolio-v2', { archived: true }),
      repo('delivery-p6', { archived: true }),
      repo('example-dev'),
      repo('acme-tool'),
      repo('forked', { fork: true }),
      repo('quiet', { homepage: 'https://quiet.example' }),
    ],
    pages: [
      { Name: 'NexCart', 'GitHub URL': 'https://github.com/example-dev/nexcart', Description: 'My own words', 'Tech Stack': 'React 19', Status: '🚀 Deployed' },
      { Name: 'Portfolio v2', 'GitHub URL': 'https://github.com/example-dev/portfolio-v2', Description: 'x', Status: '🚀 Deployed' },
      { Name: 'Acme Tool', Description: 'No URL yet', Status: '📋 Planning' },
      { Name: 'Velsaro', 'GitHub URL': 'https://github.com/example-dev/velsaro', Status: '🔧 Maintenance' },
    ],
    languages: { apexfr: { JavaScript: 100, HTML: 50 } },
    files: { apexfr: { 'package.json': JSON.stringify({ devDependencies: { '@playwright/test': '^1.48.0' } }) } },
  });
  const job = makeJob(dir, world);
  const result = await job.run({ runId: 'run-1', report: () => {} });
  assert.match(result.summary, /2 new \(Apexfr, Quiet\), 1 archived\. 2 left alone\./);

  const apex = pageNamed(world, 'Apexfr');
  assert.equal(prop(apex, 'Status'), '⚡ In Dev');
  assert.equal(prop(apex, 'Type'), '👤 Personal');
  assert.equal(prop(apex, 'Tech Stack'), 'Playwright, JavaScript, HTML');
  assert.equal(prop(apex, 'Description'), 'Late Apex studio site');
  assert.equal(prop(pageNamed(world, 'Quiet'), 'Status'), '🚀 Deployed');
  assert.equal(prop(pageNamed(world, 'NexCart'), 'Description'), 'My own words', 'your edits win');
  assert.equal(prop(pageNamed(world, 'Portfolio v2'), 'Status'), ARCHIVED);
  assert.equal(prop(pageNamed(world, 'Velsaro'), 'Status'), '🔧 Maintenance', 'a repo GitHub can’t show is left alone without a key');
  assert.equal([...world.store.values()].length, 6, 'no page for the profile repo, the fork, the archived repo or the unlinked name');

  const ledger = openLedger(path.join(dir, 'hub.sqlite'));
  try {
    const changes = ledger.list();
    assert.equal(changes.length, 3);
    assert.ok(changes.every((change) => change.state === 'applied'));
    const created = changes.find((change) => change.label === 'Added Apexfr');
    assert.equal(created.targetId, apex.id);
    assert.equal(created.after.pageId, apex.id);
  } finally { ledger.close(); }

  // A second run finds the new pages by URL and changes nothing.
  const again = await job.run({ runId: 'run-2', report: () => {} });
  assert.match(again.summary, /nothing to change/);
  assert.equal([...world.store.values()].length, 6);
}));

test('updates a field only while it still holds the hub’s own value', async () => tempDir(async (dir) => {
  const world = fakeWorld({ repos: [repo('shipd', { description: 'First words' })], pages: [] });
  const job = makeJob(dir, world);
  await job.run({ runId: 'a', report: () => {} });
  const page = pageNamed(world, 'Shipd');

  // GitHub’s description changes: the hub may follow it, since the field still holds its own value.
  const repos = [repo('shipd', { description: 'Second words' })];
  const world2 = { ...world, fetchImpl: async (url, init) => (url.startsWith('https://api.github.com/users/') ? json(200, repos) : world.fetchImpl(url, init)) };
  const job2 = makeJob(dir, world2);
  assert.match((await job2.run({ runId: 'b', report: () => {} })).summary, /1 updated/);
  assert.equal(prop(page, 'Description'), 'Second words');

  // You edit it in Notion: the hub leaves it alone from then on.
  page.properties.Description = toProperties({ Description: 'Mine now' }).Description;
  repos[0] = repo('shipd', { description: 'Third words' });
  assert.match((await job2.run({ runId: 'c', report: () => {} })).summary, /nothing to change/);
  assert.equal(prop(page, 'Description'), 'Mine now');
}));

test('stops before writing anything when a run would pass the caps', async () => tempDir(async (dir) => {
  const repos = Array.from({ length: 11 }, (_, index) => repo(`repo-${index}`));
  const world = fakeWorld({ repos });
  await assert.rejects(makeJob(dir, world).run({ runId: 'r', report: () => {} }), /Stopped before writing: this run would add 11 pages/);
  assert.equal(world.store.size, 0);
  assert.ok(!world.calls.some((call) => call === 'POST https://api.notion.com/v1/pages'));
}));

test('skips quietly when Notion isn’t connected, and flags a refused key', async () => tempDir(async (dir) => {
  const world = fakeWorld({ repos: [repo('a')] });
  const none = fakeConnections({});
  assert.match((await makeJob(dir, world, none).run({ report: () => {} })).summary, /Skipped: Notion isn’t connected/);
  assert.equal(world.calls.length, 0);

  const refused = fakeConnections();
  await assert.rejects(makeJob(dir, fakeWorld({ repos: [repo('a')], notionStatus: 401 }), refused).run({ report: () => {} }), /Notion refused the key/);
  assert.equal(refused.problems[0][0], 'notion');
  await assert.rejects(makeJob(dir, fakeWorld({ repos: [repo('a')], notionStatus: 404 })).run({ report: () => {} }), /can’t see the Projects database/);
}));

test('a repo confirmed gone with a GitHub key archives its page', async () => tempDir(async (dir) => {
  const world = fakeWorld({ repos: [], pages: [{ Name: 'Old', 'GitHub URL': 'https://github.com/example-dev/old', Status: '🚀 Deployed' }] });
  const fetchImpl = async (url, init) => (url.startsWith('https://api.github.com/user/repos') ? json(200, []) : world.fetchImpl(url, init));
  const job = makeJob(dir, { ...world, fetchImpl }, fakeConnections({ notion: 'secret_notion_key_1234567890', github: 'ghp_abcdefghijklmnopqrstuvwxyz' }));
  assert.match((await job.run({ runId: 'g', report: () => {} })).summary, /1 archived/);
  assert.equal(prop(pageNamed(world, 'Old'), 'Status'), ARCHIVED);
}));

test('undo puts a field back, refuses after your edit, and archives a page it added', async () => tempDir(async (dir) => {
  const world = fakeWorld({ repos: [repo('portfolio-v2', { archived: true }), repo('newone')], pages: [{ Name: 'Portfolio v2', 'GitHub URL': 'https://github.com/example-dev/portfolio-v2', Status: '🚀 Deployed' }] });
  const job = makeJob(dir, world);
  await job.run({ runId: 'u', report: () => {} });
  const ledger = openLedger(path.join(dir, 'hub.sqlite'));
  try {
    const statusChange = ledger.list().find((change) => change.field === 'Status');
    await job.undo(statusChange);
    ledger.undone(statusChange.id);
    assert.equal(prop(pageNamed(world, 'Portfolio v2'), 'Status'), '🚀 Deployed');
    // Undone means hands off: the next run does not archive it again.
    assert.match((await job.run({ runId: 'u2', report: () => {} })).summary, /nothing to change/);

    const created = ledger.list().find((change) => change.field === 'page');
    const newPage = pageNamed(world, 'Newone');
    newPage.properties.Status = toProperties({ Status: '🧪 Testing' }).Status;
    await job.undo(created);
    assert.equal(prop(newPage, 'Status'), ARCHIVED, 'a page the hub added is archived, never deleted');
    assert.ok(world.store.has(newPage.id));

    const fieldChange = { field: 'Description', targetId: newPage.id, before: '', after: 'hub text' };
    await assert.rejects(job.undo(fieldChange), /changed in Notion since/);
  } finally { ledger.close(); }
}));

test('the JSON client retries rate limits but never resends a create after a lost answer', async () => {
  let calls = 0;
  const busyThenOk = async () => (++calls === 1 ? json(429, {}, { 'retry-after': '0' }) : json(200, { ok: true }));
  assert.deepEqual(await createJsonClient({ service: 'X', base: 'https://x', fetch: busyThenOk })('GET', '/a'), { ok: true });
  assert.equal(calls, 2);

  let sent = 0;
  const lost = async () => { sent++; throw new TypeError('socket hang up'); };
  const error = await createJsonClient({ service: 'Notion', base: 'https://x', fetch: lost, attempts: 1 })('POST', '/pages', { body: {} }).catch((caught) => caught);
  assert.equal(sent, 1);
  assert.ok(isRetryable(error));
  const always500 = async () => json(503, {});
  assert.ok(isRetryable(await createJsonClient({ service: 'X', base: 'https://x', fetch: always500, attempts: 1 })('GET', '/a').catch((caught) => caught)));
});
