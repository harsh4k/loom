import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPortfolioSyncJob, makeCode, planPortfolio, slug } from '../src/jobs/portfolio-sync.mjs';
import { openLedger } from '../src/ledger.mjs';
import { readPage, toProperties } from '../src/notion/client.mjs';

const SITE = [
  { id: 'velsaro', order: 1, title: 'Velsaro', code: 'vlsr', url: 'https://www.velsaro.in/', image: '/images/velsaro.webp', problem: 'Hand-written.' },
  { id: 'coffee-rebuild', order: 2, title: 'Coffee Rebuild', code: 'rebld', url: 'https://threedwebs.vercel.app/', image: '/images/coffee-rebuild.webp' },
  { id: 'shipd', order: 3, title: 'Shipd', code: 'shpd', url: 'https://github.com/example-dev/shipd', image: '/images/shipd.webp' },
];
const page = (name, extra = {}) => ({
  id: `p-${slug(name)}`, name, githubUrl: `https://github.com/example-dev/${slug(name)}`, Description: '', 'Tech Stack': '',
  hasPortfolioBox: true, onPortfolio: false, 'Portfolio ID': '', ...extra,
});

test('caption codes are 3 to 5 letters and never repeat', () => {
  assert.equal(makeCode('bunny-os', new Set()), 'bnny');
  assert.equal(makeCode('bunny-os', new Set(['bnny'])), 'bunn');
  assert.match(makeCode('ab', new Set()), /^[a-z]{3,5}$|^null$/);
});

test('plans adds and removes from the checkbox and never edits existing entries', () => {
  const images = new Set(['velsaro.webp', 'shipd.webp', 'apexfr.webp', 'coffee-rebuild.webp']);
  const pages = [
    page('Velsaro', { onPortfolio: true }),                             // not linked yet: gets linked, not duplicated
    page('Shipd', { onPortfolio: false, 'Portfolio ID': 'shipd' }),     // linked and unticked: removed
    page('Apexfr', { onPortfolio: true, Description: 'Late Apex studio site', 'Tech Stack': 'Playwright, HTML, JavaScript' }),
    page('Edith', { onPortfolio: true }),                               // no image: left out
  ];
  const plan = planPortfolio({ entries: SITE, pages, images });
  assert.deepEqual(plan.removed.map((entry) => entry.id), ['shipd']);
  assert.deepEqual(plan.added, [{ id: 'apexfr', order: 4, title: 'Apexfr', code: 'apxf', url: 'https://github.com/example-dev/apexfr', image: '/images/apexfr.webp', summary: 'Late Apex studio site', stack: ['Playwright', 'HTML', 'JavaScript'] }]);
  assert.deepEqual(plan.next.map((entry) => entry.id), ['velsaro', 'coffee-rebuild', 'apexfr']);
  assert.equal(plan.next[0], SITE[0], 'existing entries are kept exactly as they are');
  assert.deepEqual(plan.links.map((link) => [link.page.name, link.id]), [['Velsaro', 'velsaro'], ['Apexfr', 'apexfr']]);
  assert.match(plan.notes.join(' '), /Edith: add the image public\/images\/edith\.webp/);
});

test('reads the checkbox and Portfolio ID from Notion', () => {
  const read = readPage({ id: 'x', properties: { ...toProperties({ Name: 'A', 'Portfolio ID': 'a' }), 'On portfolio': { checkbox: true } } });
  assert.equal(read.onPortfolio, true);
  assert.equal(read.hasPortfolioBox, true);
  assert.equal(read['Portfolio ID'], 'a');
  assert.equal(readPage({ id: 'y', properties: toProperties({ Name: 'B' }) }).hasPortfolioBox, false);
});

const json = (status, body) => new Response(JSON.stringify(body), { status });
function fakeWorld(pages, entries = SITE) {
  const world = { commits: [], notionPatches: [], file: { sha: 'sha-1', text: `${JSON.stringify(entries, null, 2)}\n` } };
  const notionPage = (item) => ({ id: item.id, properties: { ...toProperties({ Name: item.name, 'GitHub URL': item.githubUrl, Description: item.Description, 'Tech Stack': item['Tech Stack'], 'Portfolio ID': item['Portfolio ID'] }), ...(item.hasPortfolioBox ? { 'On portfolio': { checkbox: item.onPortfolio } } : {}) } });
  world.fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    if (url.endsWith('/query')) return json(200, { results: pages.map(notionPage), has_more: false });
    if (url.includes('api.notion.com/v1/pages/') && method === 'PATCH') { world.notionPatches.push(JSON.parse(init.body)); return json(200, { id: 'x', properties: {} }); }
    if (url.endsWith('/contents/site/public/images')) return json(200, ['velsaro.webp', 'shipd.webp', 'apexfr.webp'].map((name) => ({ name, type: 'file' })));
    if (url.endsWith('/contents/site/src/content/projects.json')) {
      if (method === 'PUT') {
        const body = JSON.parse(init.body);
        if (body.sha !== world.file.sha) return json(409, { message: 'sha mismatch' });
        world.file = { sha: `sha-${world.commits.length + 2}`, text: Buffer.from(body.content, 'base64').toString('utf8') };
        world.commits.push(body.message);
        return json(200, { content: { sha: world.file.sha }, commit: { sha: 'c1', html_url: 'https://github.com/c1' } });
      }
      return json(200, { sha: world.file.sha, content: Buffer.from(world.file.text).toString('base64') });
    }
    return json(404, { message: `No fake for ${method} ${url}` });
  };
  return world;
}
async function tempDir(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'automation-hub-portfolio-'));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const tokens = { notion: 'secret_notion_key_1234567890', github: 'github_pat_abcdefghijklmnopqrstuvwxyz' };
const makeJob = (dir, world, keys = tokens) => createPortfolioSyncJob({
  connections: () => ({ token: (provider) => keys[provider] ?? null, reportProblem: async () => {} }),
  openLedger: () => openLedger(path.join(dir, 'hub.sqlite')), fetch: world.fetchImpl,
});

test('commits one file, links pages, and undo puts the old list back', async () => tempDir(async (dir) => {
  const world = fakeWorld([page('Velsaro', { onPortfolio: true, 'Portfolio ID': 'velsaro' }), page('Shipd', { 'Portfolio ID': 'shipd' }), page('Apexfr', { onPortfolio: true })]);
  const job = makeJob(dir, world);
  const result = await job.run({ runId: 'r', report: () => {} });
  assert.match(result.summary, /added Apexfr and removed Shipd/);
  assert.equal(world.commits.length, 1);
  assert.deepEqual(JSON.parse(world.file.text).map((entry) => entry.id), ['velsaro', 'coffee-rebuild', 'apexfr']);
  assert.deepEqual(world.notionPatches, [{ properties: toProperties({ 'Portfolio ID': 'apexfr' }) }]);

  const ledger = openLedger(path.join(dir, 'hub.sqlite'));
  try {
    const change = ledger.list().find((item) => item.target === 'portfolio-file');
    await job.undo(change);
    assert.deepEqual(JSON.parse(world.file.text), SITE);
    await assert.rejects(job.undo(change), /changed since/);
  } finally { ledger.close(); }
}));

test('skips without keys or the checkbox, and refuses runs that would empty or gut the site', async () => tempDir(async (dir) => {
  assert.match((await makeJob(dir, fakeWorld([]), { notion: tokens.notion }).run({ report: () => {} })).summary, /add a GitHub key/);
  assert.match((await makeJob(dir, fakeWorld([page('A', { hasPortfolioBox: false })])).run({ report: () => {} })).summary, /no “On portfolio” checkbox/);
  await assert.rejects(makeJob(dir, fakeWorld([page('Velsaro')])).run({ report: () => {} }), /would empty the site/);
  const many = Array.from({ length: 4 }, (_, index) => ({ id: `p${index}`, order: index + 1, title: `P${index}`, code: `pqr${'abcd'[index]}`, url: 'https://x.dev', image: '/images/x.webp' }));
  const world = fakeWorld([...many.map((entry) => page(entry.title, { 'Portfolio ID': entry.id })), page('Keep', { onPortfolio: true })], many);
  await assert.rejects(makeJob(dir, world).run({ report: () => {} }), /would remove 4/);
  assert.equal(world.commits.length, 0);
}));

test('a ticked project without a picture gets one from its live site and words in the site’s voice', async () => tempDir(async (dir) => {
  const world = fakeWorld([page('Velsaro', { onPortfolio: true, 'Portfolio ID': 'velsaro' }), page('Edith', { onPortfolio: true, Description: 'A local voice assistant', 'Tech Stack': 'Python, Ollama' })]);
  const images = [];
  const base = world.fetchImpl;
  world.fetchImpl = async (url, init = {}) => {
    if (url.endsWith('/repos/example-dev/edith')) return json(200, { homepage: 'https://edith.example.dev' });
    if (url.endsWith('/repos/example-dev/edith/readme')) return json(200, { content: Buffer.from('# Edith\nA local voice assistant in Python that talks to Ollama on your own PC.').toString('base64') });
    if (url.endsWith('/contents/site/public/images/edith.webp') && init.method === 'PUT') { images.push(JSON.parse(init.body)); return json(200, { content: { sha: 'img' }, commit: { sha: 'c0' } }); }
    return base(url, init);
  };
  const shots = [];
  const run = async (command, args) => {
    const shot = args.find((arg) => arg.startsWith('--screenshot='));
    if (shot) { shots.push(args.at(-1)); await writeFile(shot.slice('--screenshot='.length), Buffer.alloc(60 * 1024, 7)); }
    else await writeFile(args.at(-1), Buffer.alloc(20 * 1024, 9));
    return { code: 0, output: '' };
  };
  const askJson = async () => ({ summary: 'Local voice assistant', role: 'Designed and built it', problem: 'I wanted a voice assistant that runs on my own PC and never sends my voice to a server.', outcome: 'A Python voice assistant that talks to Ollama on my own PC, with nothing sent to the cloud.' });
  const job = createPortfolioSyncJob({
    connections: () => ({ token: (provider) => tokens[provider] ?? null, reportProblem: async () => {} }),
    openLedger: () => openLedger(path.join(dir, 'hub.sqlite')), fetch: world.fetchImpl,
    cards: { askJson, browserPath: '/chrome', ffmpeg: 'ffmpeg', run, workRoot: path.join(dir, 'work') },
  });
  const result = await job.run({ runId: 'r', report: () => {} });
  assert.match(result.summary, /added Edith/);
  assert.deepEqual(shots, ['https://edith.example.dev']);
  assert.equal(images.length, 1);
  assert.equal(Buffer.from(images[0].content, 'base64').length, 20 * 1024);
  const added = JSON.parse(world.file.text).at(-1);
  assert.deepEqual(Object.keys(added), ['id', 'order', 'title', 'code', 'url', 'image', 'summary', 'role', 'stack', 'repo', 'problem', 'outcome']);
  assert.equal(added.url, 'https://edith.example.dev');
  assert.equal(added.repo, 'https://github.com/example-dev/edith');
  assert.equal(added.summary, 'Local voice assistant');
}));

test('card words that invent facts or sound like marketing are dropped', async () => {
  const { checkEntry } = await import('../src/portfolio/card.mjs');
  const source = 'Name: Edith\nREADME: A local voice assistant in Python that talks to Ollama.';
  const { entry, dropped } = checkEntry({ summary: 'Local voice assistant.', role: 'Built it with Kubernetes', problem: 'A seamless, cutting-edge assistant that leverages local models for everyone.', outcome: 'x' }, source);
  assert.deepEqual(entry, { summary: 'Local voice assistant' });
  assert.deepEqual(dropped, ['role', 'problem', 'outcome']);
  assert.equal(checkEntry({ summary: 'Built on Kubernetes' }, source).entry, null);
});
