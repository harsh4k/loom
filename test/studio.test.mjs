import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { artDirect, contrast, inventedAmounts, dealDirections, fallbackStoryboard, normaliseStoryboard, paletteReadable, posterShots, projectFacts, readmeCommand, readmeText, similarity } from '../src/media/director.mjs';
import { loadLibrary } from '../src/media/library.mjs';
import { gateProblems, sampleTimes } from '../src/media/produce.mjs';
import { sizedIndex } from '../src/media/studio.mjs';

const library = loadLibrary({ tasteDir: path.join(import.meta.dirname, 'no-such-dir'), inspoFile: path.join(import.meta.dirname, 'no-such-file.json') });
const ENGINE = readFileSync(path.resolve(import.meta.dirname, '../media/studio/assets/engine.js'), 'utf8');

const project = {
  name: 'Bunny OS',
  hook: 'Hold a key and talk to your computer.',
  tagline: 'A local desktop voice assistant.',
  stats: [['0', 'Cloud APIs'], ['2', 'Platforms shipped']],
  stack: ['Tauri', 'React', 'Rust', 'Ollama'],
  link: 'github.com/harsh4k/Bunny-OS',
};
const facts = projectFacts(project, { readme: '# Bunny OS\nA voice helper for your computer. It opens apps and stays on your PC.\n```bash\nbunny --listen\n```' });
const look = { direction: 'dense-tiles', motion: { tempo: 1 } };

test('the bundled library is complete and every grammar uses real scenes', () => {
  assert.ok(library.directions.length >= 15 && library.palettes.length >= 40 && library.types.length >= 30);
  assert.ok(library.motion.length >= 20 && library.posters.length >= 9);
  for (const direction of library.directions) {
    const grammar = library.grammars[direction.id];
    assert.ok(grammar, direction.id);
    for (const scene of [...grammar.scenes, ...grammar.open]) {
      assert.ok(library.scenes[scene], `${direction.id}: ${scene}`);
      assert.match(ENGINE, new RegExp(`\\n    ${scene}\\(shot\\)`), `engine has ${scene}`);
    }
    assert.ok(grammar.scenes.includes('end'), direction.id);
  }
});

test('contrast follows WCAG and unreadable palettes are refused', () => {
  assert.equal(Math.round(contrast('#000000', '#ffffff')), 21);
  assert.equal(contrast('#777777', '#777777'), 1);
  const base = { bg: '#ffffff', surface: '#f2f2f2', ink: '#111111', muted: '#666666', accent: '#1a4be0', accentInk: '#ffffff' };
  assert.equal(paletteReadable(base), true);
  assert.equal(paletteReadable({ ...base, ink: '#999999' }), false);
  assert.ok(library.palettes.filter(paletteReadable).length >= 20);
});

test('directions that need a picture are not dealt without one, and taken ones go last', () => {
  const dealt = dealDirections(library, { name: 'X', sector: 'ai-product', tones: ['quiet'], hasPicture: false, looks: {} });
  assert.equal(dealt.length, 4);
  assert.ok(dealt.every((d) => !['place-carries-it', 'hero-object', 'split-stage'].includes(d.id)));
  const taken = Object.fromEntries(dealt.map((d, i) => [`P${i}`, { direction: d.id }]));
  const again = dealDirections(library, { name: 'X', sector: 'ai-product', tones: ['quiet'], hasPicture: false, looks: taken });
  assert.ok(again.every((d) => !dealt.some((old) => old.id === d.id)));
});

test('art direction gives two projects different palettes and type', async () => {
  const askJson = async ({ schema }) => (schema.properties.sector
    ? { sector: 'dev-tool', tones: ['technical'] }
    : { direction: schema.properties.direction.enum[0], idea: 'Let the product talk.', memorable: 'A voice helper for your computer' });
  const first = await artDirect({ project, facts, library, looks: {}, askJson, hasPicture: true });
  assert.ok(library.grammars[first.direction]);
  assert.equal(first.memorable, 'A voice helper for your computer');
  const second = await artDirect({ project: { ...project, name: 'Rudo' }, facts, library, looks: { 'Bunny OS': first }, askJson, hasPicture: true });
  assert.notEqual(second.paletteId, first.paletteId);
  assert.notEqual(second.typeId, first.typeId);
  assert.notEqual(second.direction, first.direction);
  const offline = await artDirect({ project, facts, library, looks: {}, askJson: async () => { throw new Error('down'); }, hasPicture: false });
  assert.ok(offline.paletteId && offline.typeId && offline.motion.transition);
});

test('storyboards keep only what the facts say and always end on the end card', () => {
  const raw = {
    shots: [
      { scene: 'terminal', lines: ['listening'] },
      { scene: 'statement', text: 'Bunny OS was built by a team of forty at Google.' },
      { scene: 'number', value: '0', label: 'Cloud APIs' },
      { scene: 'number', value: '99', label: 'Happy users' },
      { scene: 'screen', caption: 'A voice helper for your computer' },
      { scene: 'stack', items: ['Tauri', 'React', 'Rust', 'Kubernetes'] },
      { scene: 'monument', line: 'whatever' },
    ],
    endLine: 'A local desktop voice assistant.',
  };
  const { shots, problems } = normaliseStoryboard(raw, { project, facts, look, library, images: { shot: '/x.png' }, author: 'H' });
  assert.deepEqual(shots.map((s) => s.scene), ['terminal', 'number', 'screen', 'stack', 'end']);
  assert.equal(shots[0].command, 'bunny --listen');
  assert.deepEqual(shots[3].items, ['Tauri', 'React', 'Rust']);
  assert.equal(shots.at(-1).name, 'Bunny OS');
  assert.equal(shots.at(-1).line, 'A local desktop voice assistant.');
  assert.ok(shots.every((s) => s.d >= 1.4 && s.d <= 6));
  assert.ok(problems.length >= 3);

  const noPicture = normaliseStoryboard(raw, { project, facts, look, library, images: {}, author: 'H' });
  assert.ok(!noPicture.shots || noPicture.shots.every((s) => s.scene !== 'screen'));
  assert.equal(normaliseStoryboard({ shots: [] }, { project, facts, look, library }).shots, null);
});

test('the fallback storyboard always makes a film', () => {
  for (const direction of library.directions) {
    const shots = fallbackStoryboard({ project, facts, look: { direction: direction.id, motion: {} }, library, images: {}, author: 'H' });
    assert.ok(shots.length >= 3, direction.id);
    assert.equal(shots.at(-1).scene, 'end');
    const poster = posterShots({ look: { posterId: 'product-hero' }, library, shots });
    assert.equal(poster.length, 1);
    assert.notEqual(poster[0].layout, undefined);
  }
});

test('README helpers keep prose and only the project’s own command', () => {
  assert.equal(readmeText('# T\n![badge](x.svg) See [docs](https://a.b) <b>now</b>\n```\ncode\n```'), '# T\nSee docs now');
  assert.equal(readmeCommand('```bash\nnpm install\ncd rudo\nrudo chat\n```', ['Rudo']), 'rudo chat');
  assert.equal(readmeCommand('```\nrudo chat\n```', ['Rudo']), '');
  assert.equal(readmeCommand('```sh\npython scripts/build.py\n```', ['Rudo']), '');
});

test('similar storyboards are spotted', () => {
  const a = [{ scene: 'statement', text: 'Hold a key and talk to your computer' }];
  assert.equal(similarity(a, a), 1);
  assert.ok(similarity(a, [{ scene: 'statement', text: 'Five tools and live system signals' }]) < 0.3);
});

test('the gate reads HyperFrames check findings', () => {
  const report = {
    lint: { findings: [] },
    layout: { findings: [{ severity: 'warning', code: 'container_overflow', message: 'Nowrap text' }, { severity: 'error', code: 'canvas_overflow', message: 'Bleeds' }, { severity: 'error', code: 'clipped_text', message: 'Text overflows the frame', time: 3.21 }] },
    contrast: { findings: [{ severity: 'warning', message: 'Low contrast 2.1:1' }] },
  };
  assert.deepEqual(gateProblems(report), ['Text overflows the frame at 3.2s', 'Low contrast 2.1:1']);
  assert.deepEqual(gateProblems(null), []);
  assert.deepEqual(sampleTimes([{ d: 2 }, { d: 3 }]), [1.6, 4.4]);
});

test('the studio page is sized and timed for each format', () => {
  const html = readFileSync(path.resolve(import.meta.dirname, '../media/studio/index.html'), 'utf8');
  const sized = sizedIndex(html, { w: 1920, h: 1080 }, 17.456);
  assert.match(sized, /data-duration="17.46"/);
  assert.match(sized, /data-width="1920" data-height="1080"/);
  assert.match(sized, /width=1920, height=1080/);
  assert.match(sized, /window\.__timelines\["film"\]/);
});

test('amounts written as words must be in the facts', () => {
  const source = 'Hook: 100% local inference. Number: 2 (Platforms shipped)';
  assert.deepEqual(inventedAmounts('Ten percent local inference', source), ['ten']);
  assert.deepEqual(inventedAmounts('One hundred percent local', source), []);
  assert.deepEqual(inventedAmounts('Shipped on two platforms, not three', source), ['three']);
});
