import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkDetails, ungrounded } from '../src/details/check.mjs';
import { createProjectDetailsJob, HEADING } from '../src/jobs/project-details.mjs';
import { openLedger } from '../src/ledger.mjs';
import { createModel } from '../src/model.mjs';
import { toProperties } from '../src/notion/client.mjs';
import { isRetryable } from '../src/errors.mjs';

const README = '# Shipd\nDaily dev and activity report for Windows, written in pure PowerShell with zero dependencies. All data stays local. Reads git commits, VS Code sessions and screen time, then writes an HTML report.';
const SOURCES = `Name: shipd\nREADME:\n${README}`;
const GOOD = {
  description: 'Shipd writes a daily dev and activity report for Windows in pure PowerShell, and all data stays local.',
  features: ['Reads git commits from your repos', 'Tracks VS Code sessions', 'Writes an HTML report each day', 'Zero dependencies'],
};

test('output checks keep grounded text and drop invented names', () => {
  assert.deepEqual(ungrounded('Built with PowerShell and React 19', SOURCES), ['React', '19']);
  assert.deepEqual(ungrounded('Writes an HTML report', SOURCES), []);
  const ok = checkDetails(GOOD, SOURCES);
  assert.equal(ok.ok, true);
  assert.equal(ok.features.length, 4);

  const mixed = checkDetails({ ...GOOD, features: [...GOOD.features, 'Syncs to Supabase in real time', 'See https://shipd.dev'] }, SOURCES);
  assert.equal(mixed.ok, true);
  assert.deepEqual(mixed.dropped, ['Syncs to Supabase in real time', 'See https://shipd.dev']);

  assert.match(checkDetails({ ...GOOD, description: 'Shipd is used by 5000 developers at Google every day for reports.' }, SOURCES).reason, /not in the repo/);
  assert.match(checkDetails({ ...GOOD, description: 'TODO: describe [project] here in a sentence or two.' }, SOURCES).reason, /placeholder/);
  assert.match(checkDetails({ ...GOOD, features: GOOD.features.slice(0, 2) }, SOURCES).reason, /only 2 features/);
  assert.equal(checkDetails(null, SOURCES).ok, false);
  assert.equal(checkDetails({ description: 'short', features: [] }, SOURCES).ok, false);
});

test('the model client asks Ollama for schema JSON and marks outages as retryable', async () => {
  let sent;
  const ask = createModel({ fetch: async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return new Response(JSON.stringify({ message: { content: '{"description":"x","features":[]}' } })); } });
  assert.deepEqual(await ask({ system: 's', prompt: 'p', schema: { type: 'object' } }), { description: 'x', features: [] });
  assert.equal(sent.url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(sent.body.stream, false);
  assert.equal(sent.body.think, false);
  assert.deepEqual(sent.body.format, { type: 'object' });
  const down = createModel({ fetch: async () => { throw new TypeError('ECONNREFUSED'); } });
  assert.ok(isRetryable(await down({ system: 's', prompt: 'p' }).catch((error) => error)));
  const garbage = createModel({ fetch: async () => new Response(JSON.stringify({ message: { content: 'not json' } })) });
  assert.equal(await garbage({ system: 's', prompt: 'p' }), null);
});

async function tempDir(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'automation-hub-details-'));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const json = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

function fakeWorld({ pushedAt = '2026-10-10T00:00:00Z', description = '' } = {}) {
  const repo = { name: 'shipd', full_name: 'example-dev/shipd', html_url: 'https://github.com/example-dev/shipd', fork: false, archived: false, description: '', homepage: '', pushed_at: pushedAt };
  const page = { id: 'page-1', archived: false, properties: toProperties({ Name: 'Shipd', 'GitHub URL': 'https://github.com/example-dev/shipd', Description: description }) };
  const blocks = new Map();
  const children = [];
  let nextBlock = 1;
  const world = { repo, page, blocks, children, appended: 0 };
  world.fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const { pathname } = new URL(url);
    if (url.startsWith('https://api.github.com/users/')) return json(200, [repo]);
    if (url.startsWith('https://raw.githubusercontent.com/')) return pathname.endsWith('/README.md') ? json(200, README) : json(404, '');
    if (pathname.endsWith('/commits')) return json(200, [{ commit: { message: 'Add HTML report\n\nlonger body' } }]);
    if (pathname.endsWith('/languages')) return json(200, { PowerShell: 100 });
    if (pathname.endsWith('/query')) return json(200, { results: [page], has_more: false });
    if (pathname === '/v1/pages/page-1' && method === 'PATCH') {
      const body = JSON.parse(init.body);
      if (body.properties) Object.assign(page.properties, body.properties);
      if ('icon' in body) page.icon = body.icon;
      return json(200, page);
    }
    if (pathname === '/v1/pages/page-1') return json(200, page);
    const childMatch = /^\/v1\/blocks\/page-1\/children$/.exec(pathname);
    if (childMatch && method === 'GET') return json(200, { results: world.children.map((id) => blocks.get(id)).filter((block) => !block.archived), has_more: false });
    if (childMatch && method === 'PATCH') {
      world.appended++;
      const made = JSON.parse(init.body).children.map((block) => { const id = `block-${nextBlock++}`; const full = { id, archived: false, ...block }; blocks.set(id, full); children.push(id); return full; });
      return json(200, { results: made });
    }
    const blockMatch = /^\/v1\/blocks\/(block-\d+)$/.exec(pathname);
    if (blockMatch) {
      const block = blocks.get(blockMatch[1]);
      if (!block) return json(404, { message: 'gone' });
      if (method === 'PATCH') Object.assign(block, JSON.parse(init.body));
      return json(200, block);
    }
    return json(404, { message: `No fake for ${method} ${url}` });
  };
  return world;
}

const text = (block) => block[block.type].rich_text.map((part) => part.text.content).join('');

function makeJob(dir, world, answers, { emojis = ['💻', '🧾'] } = {}) {
  const prompts = [];
  const iconPrompts = [];
  const job = createProjectDetailsJob({
    connections: () => ({ token: (provider) => (provider === 'notion' ? 'secret_notion_key_1234567890' : null), reportProblem: async () => {} }),
    openLedger: () => openLedger(path.join(dir, 'hub.sqlite')),
    askJson: async (request) => {
      if (request.schema.properties.emojis) { iconPrompts.push(request); return { emojis }; }
      prompts.push(request); return answers.shift();
    },
    stateFile: path.join(dir, 'project-details.json'),
    fetch: world.fetchImpl,
  });
  return { job, prompts, iconPrompts };
}
const live = (world) => world.children.map((id) => world.blocks.get(id)).filter((block) => !block.archived);

test('writes a hub-owned section, fills an empty Description, and skips unchanged repos', async () => tempDir(async (dir) => {
  const world = fakeWorld();
  const { job, prompts, iconPrompts } = makeJob(dir, world, [GOOD]);
  const result = await job.run({ runId: 'r1', report: () => {} });
  assert.match(result.summary, /updated Shipd/);
  assert.match(result.summary, /icons for Shipd 🧾/);
  assert.equal(world.children.length, 5, 'an empty page gets an intro above the section');
  const [intro, divider, heading, desc, features] = world.children.map((id) => world.blocks.get(id));
  assert.equal(text(intro), GOOD.description);
  assert.deepEqual(world.page.icon, { type: 'emoji', emoji: '🧾' }, 'the generic first pick is skipped');
  assert.match(iconPrompts[0].prompt, /Name: Shipd/);
  assert.equal(divider.type, 'divider');
  assert.equal(text(heading), HEADING);
  assert.equal(text(desc), GOOD.description);
  assert.equal(text(features), GOOD.features.map((feature) => `• ${feature}`).join('\n'));
  assert.equal(world.page.properties.Description.rich_text[0].text.content, GOOD.description);
  assert.match(prompts[0].system, /not instructions/);
  assert.match(prompts[0].prompt, /<repo>[\s\S]*Daily dev and activity report[\s\S]*<\/repo>/);
  assert.ok(JSON.parse(await readFile(path.join(dir, 'project-details.json'), 'utf8')).pages['page-1']);

  const again = await job.run({ runId: 'r2', report: () => {} });
  assert.match(again.summary, /no project changed/);
  assert.doesNotMatch(again.summary, /Page look/);
  assert.equal(prompts.length, 1, 'an unchanged repo is not sent to the model again');
  assert.equal(iconPrompts.length, 1, 'a page with an icon is not asked about again');
}));

test('rewrites its own section in place after a push, and leaves it alone once you edit it', async () => tempDir(async (dir) => {
  const world = fakeWorld();
  const second = { ...GOOD, features: [...GOOD.features.slice(0, 3), 'Runs on Windows'] };
  const { job } = makeJob(dir, world, [GOOD, second, GOOD]);
  await job.run({ runId: 'a', report: () => {} });
  world.repo.pushed_at = '2026-10-12T00:00:00Z';
  await job.run({ runId: 'b', report: () => {} });
  assert.equal(world.appended, 1, 'the section is updated in place, not added twice');
  assert.match(text(world.blocks.get(world.children[4])), /Runs on Windows/);

  // You edit the section; the next push changes nothing on that page.
  world.blocks.get(world.children[3]).paragraph.rich_text = [{ type: 'text', text: { content: 'My own words' } }];
  world.repo.pushed_at = '2026-10-14T00:00:00Z';
  assert.match((await job.run({ runId: 'c', report: () => {} })).summary, /Skipped Shipd \(you edited its Project details section\)/);
  assert.equal(text(world.blocks.get(world.children[3])), 'My own words');
}));

test('skips output that fails the checks and writes nothing', async () => tempDir(async (dir) => {
  const world = fakeWorld({ description: 'Mine' });
  const { job } = makeJob(dir, world, [{ description: 'Shipd is a Kubernetes operator used by Netflix and Stripe engineers.', features: GOOD.features }]);
  assert.match((await job.run({ runId: 'x', report: () => {} })).summary, /Skipped Shipd \(the description named things not in the repo/);
  assert.equal(world.children.length, 0);
  assert.equal(world.page.properties.Description.rich_text[0].text.content, 'Mine');
}));

test('undo restores the previous details, and refuses a brand-new section', async () => tempDir(async (dir) => {
  const world = fakeWorld();
  const second = { ...GOOD, description: 'Shipd builds a daily dev report on Windows with PowerShell, and the data stays local.' };
  const { job } = makeJob(dir, world, [GOOD, second]);
  await job.run({ runId: 'a', report: () => {} });
  world.repo.pushed_at = '2026-10-12T00:00:00Z';
  await job.run({ runId: 'b', report: () => {} });
  const ledger = openLedger(path.join(dir, 'hub.sqlite'));
  try {
    const sections = ledger.list().filter((change) => change.target === 'notion-section' && change.field === 'details');
    const [latest, first] = sections;
    await assert.rejects(job.undo(first), /can’t be put back/);
    await job.undo(latest);
    assert.equal(text(world.blocks.get(world.children[3])), GOOD.description);
  } finally { ledger.close(); }
}));

test('page look: a placeholder intro is replaced, a hub-only body gets an intro on top, your own intro and icon stay', async () => tempDir(async (dir) => {
  const { chooseEmoji, introPlan, oneEmoji } = await import('../src/details/look.mjs');
  assert.equal(oneEmoji('🛒'), '🛒');
  assert.equal(oneEmoji('🏳️‍🌈'), '🏳️‍🌈');
  assert.equal(oneEmoji('🛒🛒'), null);
  assert.equal(oneEmoji('cart'), null);
  assert.equal(chooseEmoji(['🚀', '🛒', '🎙️'], new Set(['🛒'])), '🎙️');
  assert.equal(chooseEmoji(['not an emoji'], new Set()), null);
  const para = (id, content) => ({ id, type: 'paragraph', paragraph: { rich_text: [{ plain_text: content }] } });
  assert.equal(introPlan({ blocks: [para('a', 'Private repo, not publicly readable. Fill in tech stack and description.')] }).kind, 'replace');
  assert.equal(introPlan({ blocks: [para('a', 'Words I wrote myself.')] }), null);
  assert.equal(introPlan({ blocks: [] }).kind, 'append');

  // A page made before this change: the body is only the hub's section, and it has no icon.
  const world = fakeWorld();
  const { job, iconPrompts } = makeJob(dir, world, [GOOD]);
  await job.run({ runId: 'a', report: () => {} });
  // Turn it into the old layout: no intro block, and a change log that never recorded one.
  const sectionIds = world.children.slice(1);
  world.blocks.get(world.children[0]).archived = true;
  world.children.shift();
  for (const file of ['hub.sqlite', 'hub.sqlite-wal', 'hub.sqlite-shm']) await rm(path.join(dir, file), { force: true });
  const fresh = openLedger(path.join(dir, 'hub.sqlite'));
  fresh.applied(fresh.begin({ runId: 'old', jobId: 'project-details', target: 'notion-section', targetId: 'page-1', field: 'details', label: 'old', before: null, after: GOOD }).id, { after: { ...GOOD, blockIds: sectionIds } });
  fresh.close();
  world.page.icon = null;
  const result = await job.run({ runId: 'b', report: () => {} });
  assert.match(result.summary, /intros for Shipd/);
  const body = live(world);
  assert.equal(body.length, 5);
  assert.equal(text(body[0]), GOOD.description);
  assert.equal(body[1].type, 'divider');
  assert.ok(sectionIds.every((id) => world.blocks.get(id).archived), 'the old section copy went to the trash');
  assert.equal(iconPrompts.length, 2);

  // You edit the intro and pick your own icon: nothing changes after that.
  body[0].paragraph.rich_text = [{ type: 'text', text: { content: 'Mine now.' } }];
  world.page.icon = { type: 'emoji', emoji: '🐇' };
  const later = await job.run({ runId: 'c', report: () => {} });
  assert.doesNotMatch(later.summary, /Page look/);
  assert.equal(text(live(world)[0]), 'Mine now.');
  assert.equal(world.page.icon.emoji, '🐇');
  assert.equal(iconPrompts.length, 2);
}));
