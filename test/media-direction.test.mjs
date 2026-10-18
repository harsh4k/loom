import assert from 'node:assert/strict';
import test from 'node:test';
import { artDirect, dealDirections, fallbackStoryboard, normaliseStoryboard, posterShots, projectFacts, writeStoryboard } from '../src/media/director.mjs';
import { loadLibrary } from '../src/media/library.mjs';
import { unsupportedClaim } from '../src/media/claims.mjs';

const library = loadLibrary({ tasteDir: null, inspoFile: 'missing' });
const project = { name: 'Demo', tagline: 'A local desktop voice assistant.', stats: [['5', 'Built-in tools']], features: ['Open desktop apps', 'Chat with local models', 'Search files by name'] };
const facts = projectFacts(project);
const look = { direction: 'one-motif', motion: { tempo: 1 } };

test('bounded motif choices reach signal shots and posters with compatible defaults', () => {
  for (const [choice, expected] of [['bars', 'bars'], ['unsupported', 'tiles'], [undefined, 'tiles']]) {
    const result = normaliseStoryboard({ shots: [
      { scene: 'signal', text: project.tagline, motif: choice },
      { scene: 'number', value: '5', label: 'Built-in tools' },
      { scene: 'field', text: 'Desktop voice assistant' },
    ], endLine: project.tagline }, { project, facts, look: { ...look, motif: 'tiles' }, library });
    assert.equal(result.shots.find((shot) => shot.scene === 'signal').motif, expected);
    assert.equal(posterShots({ look: { ...look, motif: expected }, library, shots: result.shots })[0].motif, expected);
  }
});

test('expressive art direction deals executable graphic or kinetic compositions', () => {
  const directions = dealDirections(library, { name: 'Demo', sector: 'personal-portfolio', tones: ['warm', 'technical'], hasPicture: true });
  assert.equal(directions.length, 4);
  assert.ok(directions.every((item) => library.grammars[item.id].scenes.some((scene) => ['signal', 'kinetic'].includes(scene))));
});

test('fallback compositions can express the same graphic language as model films', () => {
  const shots = fallbackStoryboard({ project, facts, look, library });
  assert.ok(shots.some((shot) => ['signal', 'kinetic'].includes(shot.scene)));
});

test('storyboards must realize an expressive direction instead of ignoring its scene options', async () => {
  const result = await writeStoryboard({ project, facts, look, library, askJson: async () => ({ shots: [
    { scene: 'statement', text: project.tagline },
    { scene: 'number', value: '5', label: 'Built-in tools' },
    { scene: 'field', text: 'Desktop voice assistant' },
  ], endLine: project.tagline }) });
  assert.equal(result.shots, null);
  assert.match(result.problems.join(' '), /signal|kinetic/);
});

test('local inference does not establish whole-app data residency', async () => {
  assert.ok(unsupportedClaim('Data stays on this PC.', 'Local inference runs on this PC.'));
  assert.equal(unsupportedClaim('Data stays on this PC.', 'Data stays on this PC.'), '');
  const sourced = projectFacts(project, { readme: 'Local inference runs on this PC.' });
  const directed = await artDirect({ project, facts: sourced, library, hasPicture: false, askJson: async ({ schema }) => schema.properties.sector
    ? { sector: 'ai-product', tones: ['technical'] }
    : { direction: schema.properties.direction.enum[0], idea: 'Use graphic forms.', memorable: 'Data stays on this PC.' } });
  assert.equal(directed.memorable, '');
});
