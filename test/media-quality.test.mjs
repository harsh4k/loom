import assert from 'node:assert/strict';
import test from 'node:test';
import * as production from '../src/media/produce.mjs';
import { artDirect, projectFacts, normaliseStoryboard, posterShots, paletteReadable } from '../src/media/director.mjs';
import { loadLibrary } from '../src/media/library.mjs';
import { LOOK_VERSION } from '../src/media/art-direction.mjs';
import { parseFaces, loadTypeFaces } from '../src/media/fonts.mjs';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const library = loadLibrary({ tasteDir: null, inspoFile: 'missing' });
const project = { name: 'Demo', tagline: 'A local desktop voice assistant.', features: ['Open desktop apps', 'Chat with local models', 'Search files by name'], stack: [], stats: [] };
const look = { direction: 'one-motif', motion: { tempo: 1 }, posterId: 'name-wall' };

test('variable font range whitespace is normalized before caching', () => {
  const [face] = parseFaces("@font-face { font-family: 'Demo'; font-weight: 200\t800; src: url(https://fonts.example/demo.woff2); }", { source: 'fontshare' });
  assert.equal(face.weight, '200 800');
});

test('generated copy is context, never evidence for a film claim', () => {
  const facts = projectFacts(project, { draft: 'Demo has 999 users at Acme.' });
  assert.ok(!facts.source.includes('999'));
  assert.match(facts.post, /999/);
  assert.ok(facts.records.some((record) => record.field === 'tagline'));
});

test('a storyboard cannot relabel a known number into an invented achievement', () => {
  const facts = projectFacts({ ...project, stats: [['5', 'Built-in tools']] });
  const result = normaliseStoryboard({ shots: [
    { scene: 'number', value: '5', label: 'Happy users' },
    { scene: 'statement', text: project.tagline },
    { scene: 'field', text: 'Desktop voice assistant' },
  ], endLine: project.tagline }, { project, facts, look, library });
  assert.ok(!result.shots || result.shots.find((shot) => shot.scene === 'number')?.label === 'Built-in tools');
});

test('posters use a dedicated composition carrying sourced evidence', () => {
  const shots = [{ scene: 'statement', text: 'Open desktop apps' }, { scene: 'end', name: 'Demo', line: project.tagline, image: 'shot', d: 3 }];
  const poster = posterShots({ look, library, shots });
  assert.equal(poster[0].scene, 'poster');
  assert.ok([poster[0].line, ...poster[0].evidence].includes('Open desktop apps'));
});

test('poster hierarchy leads with one concise sourced claim without repeating it as evidence', () => {
  const shots = [
    { scene: 'kinetic', text: 'A local desktop voice assistant.' },
    { scene: 'statement', text: '100% local inference.' },
    { scene: 'end', name: 'Demo', line: 'Demo is a local desktop voice assistant with 100% local inference.', d: 3 },
  ];
  const [poster] = posterShots({ look, library, shots });
  assert.equal(poster.line, '100% local inference.');
  assert.deepEqual(poster.evidence, ['A local desktop voice assistant.']);
  const [fallback] = posterShots({ look, library, shots: [{ scene: 'field', text: 'Demo' }, { scene: 'kinetic', text: 'Open desktop apps' }, shots.at(-1)] });
  assert.equal(fallback.line, 'Open desktop apps');
  assert.ok(!fallback.evidence.includes('Demo'));
});

test('art direction offers bounded metaphors and preserves the selected motif', async () => {
  let choices;
  const askJson = async ({ schema }) => {
    if (schema.properties.sector) return { sector: 'dev-tool', tones: ['technical'] };
    choices = schema.properties.motif?.enum;
    return { direction: schema.properties.direction.enum[0], idea: 'An editorial visual metaphor.', memorable: project.tagline, motif: 'bars' };
  };
  const chosen = await artDirect({ project, facts: projectFacts(project), library, looks: {}, askJson, hasPicture: false });
  assert.deepEqual(choices, ['orbit', 'bars', 'tiles']);
  assert.equal(chosen.motif, 'bars');
});

test('signal motifs normalize invalid input to the look and old payloads stay usable', () => {
  const raw = { shots: [{ scene: 'signal', text: project.tagline, motif: 'arbitrary CSS' }, { scene: 'statement', text: project.tagline }, { scene: 'field', text: 'Desktop voice assistant' }], endLine: project.tagline };
  const normalized = normaliseStoryboard(raw, { project, facts: projectFacts(project), look: { ...look, motif: 'tiles' }, library });
  assert.equal(normalized.shots[0].motif, 'tiles');
  const old = normaliseStoryboard(raw, { project, facts: projectFacts(project), look, library });
  assert.equal(old.shots[0].motif, 'orbit');
  const poster = posterShots({ look: { ...look, motif: 'bars' }, library, shots: normalized.shots });
  assert.equal(poster[0].motif, 'bars');
  assert.equal(poster[0].layout, 'monument');
});

test('variable font ranges cover the requested weights in emitted CSS', async () => {
  const css = "@font-face { font-family: 'Demo'; font-style: normal; font-weight: 200 800; src: url(https://fonts.example/demo.woff2); }";
  const parsed = parseFaces(css, { source: 'fontshare' });
  assert.equal(parsed[0].weight, '200 800');
  const dir = await mkdtemp(path.resolve('data/quality/loom-font-'));
  try {
    const bytes = Buffer.alloc(1100); bytes.write('wOF2');
    const fetch = async (url) => url.endsWith('.woff2') ? { ok: true, arrayBuffer: async () => bytes } : { ok: true, text: async () => css };
    const fonts = await loadTypeFaces({ display: { family: 'Demo', source: 'fontshare', weights: [400, 700] } }, { cacheDir: dir, fetch });
    assert.match(fonts.css, /font-weight: 200 800/);
    assert.equal(fonts.files.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('missing review evidence is unverified and a low score cannot pass without reasons', () => {
  const layout = Object.fromEntries(['lint', 'runtime', 'layout', 'contrast'].map((name) => [name, { findings: [] }]));
  assert.equal(typeof production.qualityVerdict, 'function');
  assert.equal(production.qualityVerdict({}).status, 'UNVERIFIED');
  assert.equal(production.qualityVerdict({ layout, score: 6, problems: [] }).status, 'FAIL');
  assert.equal(production.qualityVerdict({ layout, score: 8, problems: ['Overlapping title'] }).status, 'FAIL');
  assert.equal(production.qualityVerdict({ layout, score: 8, problems: [] }).status, 'PASS');
  assert.equal(production.qualityVerdict({ layout: {}, score: 8 }).status, 'UNVERIFIED');
});

test('a source containing local inference does not authorize a privacy guarantee', () => {
 const facts = projectFacts(project);
 const result = normaliseStoryboard({ shots: [
 { scene: 'statement', text: 'A local assistant guarantees total privacy.' },
 { scene: 'field', text: 'Desktop voice assistant' },
 { scene: 'statement', text: project.tagline }
 ], endLine: project.tagline }, { project, facts, look, library });
 assert.ok(!result.shots || !result.shots.some((shot) => /guarantees/.test(shot.text ?? '')));
});

test('missing inspection evidence and failed cuts stay explicit in preserved manifests', async () => {
  const dir = await mkdtemp(path.resolve('data/quality/loom-studio-test-'));
  try {
    await mkdir(path.join(dir, 'media'), { recursive: true });
    const kept = { ...look, version: LOOK_VERSION, paletteId: library.palettes.find(paletteReadable).id, typeIds: [library.types[0].id] };
    await writeFile(path.join(dir, 'media', 'looks.json'), JSON.stringify({ Demo: kept }));
    const askJson = async () => ({ shots: [{ scene: 'statement', text: project.tagline }, { scene: 'signal', text: project.tagline }, { scene: 'field', text: 'Desktop voice assistant' }], endLine: project.tagline });
    const makeRun = (fail) => async (_cmd, args) => {
      if (args[1] === 'check') return { code: 1, output: 'check unavailable' };
      if (args[1] === 'render') {
        const output = args[args.indexOf('--output') + 1];
        if (output.includes(fail)) return { code: 1, output: 'fixture render failure' };
        await writeFile(output, Buffer.alloc(100 * 1024));
      }
      if (args[1] === 'snapshot' && args.at(-1).endsWith('still')) {
        await mkdir(args.at(-1), { recursive: true });
        await writeFile(path.join(args.at(-1), 'frame-0.png'), Buffer.alloc(100));
      }
      return { code: 0, output: '' };
    };
    const produce = production.createStudio({ askJson, dataDir: dir, hyperframesBin: 'unused', run: makeRun('-4x5'), fetch: async () => ({ ok: false }), tasteDir: null, inspoFile: 'missing' });
    const outBase = path.join(dir, 'preview');
    const result = await produce({ project, outBase, workRoot: path.join(dir, 'work') });
    assert.equal(result.quality.status, 'FAIL');
    assert.equal(result.quality.formats.landscape.status, 'UNVERIFIED');
    assert.equal(result.quality.renders.portrait.status, 'FAIL');
    assert.equal(result.quality.renders.poster.status, 'PASS');
    const saved = JSON.parse(await readFile(`${outBase}.quality/manifest.json`, 'utf8'));
    assert.equal(saved.quality.status, 'FAIL');
    assert.equal(Object.keys(saved.quality.formats).length, 4);
    await assert.rejects(readFile(path.join(dir, 'media', 'storyboards.json')), { code: 'ENOENT' });
    const fail = production.createStudio({ askJson, dataDir: dir, hyperframesBin: 'unused', run: makeRun('failed.mp4'), fetch: async () => ({ ok: false }), tasteDir: null, inspoFile: 'missing' });
    const failedBase = path.join(dir, 'failed');
    await assert.rejects(fail({ project, outBase: failedBase, workRoot: path.join(dir, 'work') }), /landscape render failed/);
    const failed = JSON.parse(await readFile(`${failedBase}.quality/manifest.json`, 'utf8'));
    assert.equal(failed.quality.renders.landscape.status, 'FAIL');
    assert.equal(failed.quality.status, 'FAIL');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
