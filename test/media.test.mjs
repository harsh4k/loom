import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compositionVariables, createMediaRenderer, findBrowser, findProject, loadProjects } from '../src/media/render.mjs';

test('every project entry has the facts the template needs', () => {
  const projects = loadProjects();
  assert.ok(Object.keys(projects).length >= 5);
  for (const [key, project] of Object.entries(projects)) {
    assert.ok(project.name && project.tagline && project.link, key);
    assert.ok(Array.isArray(project.stack) && project.stack.length, key);
    for (const stat of project.stats) assert.equal(stat.length, 2, key);
    for (const url of [project.shot?.url, project.shot?.image].filter(Boolean)) assert.match(url, /^https:\/\//, key);
  }
  assert.equal(findProject(projects, 'EDITH').name, 'EDITH');
  assert.equal(findProject(projects, 'freelance'), null);
});

test('composition variables flatten stats and stack', () => {
  const vars = compositionVariables({ name: 'X', tagline: 'T', stats: [['5', 'Tools'], ['0', 'APIs']], stack: ['A', 'B'], link: 'github.com/a/b' }, { author: 'H', shot: 'assets/shot.png' });
  assert.equal(vars.stats, '5|Tools\n0|APIs');
  assert.equal(vars.stack, 'A, B');
  assert.equal(vars.hook, 'T');
  assert.equal(vars.footnote, 'Repo link in the comments');
  assert.equal(vars.shot, 'assets/shot.png');
});

test('findBrowser prefers an explicit path and otherwise needs a Playwright install', () => {
  assert.equal(findBrowser({ HUB_BROWSER_PATH: process.execPath }), process.execPath);
  assert.equal(findBrowser({}), null);
});

function fakeSpawn(handler) {
  const calls = [];
  const spawn = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 1000 + calls.length;
    child.kill = () => {};
    setImmediate(async () => child.emit('close', await handler(command, args)));
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

test('renderer captures the site, renders the video and saves the last frame as the image', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'automation-hub-media-'));
  try {
    const template = path.join(dir, 'template');
    await mkdir(path.join(template, 'assets'), { recursive: true });
    await writeFile(path.join(template, 'index.html'), '<html></html>');
    const projectsFile = path.join(dir, 'projects.json');
    await writeFile(projectsFile, JSON.stringify({ Demo: { name: 'Demo', tagline: 'A demo.', stats: [], stack: ['Node'], link: 'github.com/x/demo', shot: { url: 'https://demo.example' } } }));
    const bin = path.join(dir, 'hyperframes.mjs');
    await writeFile(bin, '');
    let variables;
    const spawn = fakeSpawn(async (command, args) => {
      const shot = args.find((arg) => arg.startsWith('--screenshot='));
      if (shot) await writeFile(shot.slice('--screenshot='.length), Buffer.alloc(30 * 1024));
      if (args[1] === 'render') {
        variables = JSON.parse(await readFile(args[args.indexOf('--variables-file') + 1], 'utf8'));
        await writeFile(args[args.indexOf('--output') + 1], Buffer.alloc(100 * 1024));
      }
      if (args.includes('-sseof')) await writeFile(args.at(-1), Buffer.alloc(10));
      return 0;
    });
    const render = createMediaRenderer({ projectsFile, templateDir: template, hyperframesBin: bin, workRoot: path.join(dir, 'work'), browserPath: '/chrome', ffmpeg: 'ffmpeg', spawn });
    const result = await render({ topic: 'demo', outBase: path.join(dir, 'out') });
    assert.deepEqual(result, { name: 'Demo', video: path.join(dir, 'out.mp4'), image: path.join(dir, 'out.png'), note: '' });
    assert.equal(variables.shot, 'assets/shot.png');
    assert.equal(spawn.calls[0].command, '/chrome');
    assert.ok(spawn.calls[0].args.includes('https://demo.example'));
    assert.equal(await render({ topic: 'unknown', outBase: path.join(dir, 'x') }), null);

    const failing = createMediaRenderer({ projectsFile, templateDir: template, hyperframesBin: bin, workRoot: path.join(dir, 'work'), browserPath: '/chrome', spawn: fakeSpawn(async (command, args) => (args[1] === 'render' ? 1 : 0)) });
    const outcome = await failing({ topic: 'Demo', outBase: path.join(dir, 'y') }).catch((error) => error);
    assert.match(outcome.message, /Video render failed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
