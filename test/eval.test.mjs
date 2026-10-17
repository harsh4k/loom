import assert from 'node:assert/strict';
import test from 'node:test';
import { renderScorecard, scoreEntries, summarize } from '../src/eval/copy-bench.mjs';
import { factsFor, loadBrand, scorePost } from '../src/eval/copy-score.mjs';

const brand = loadBrand();
const STORY = '- Bunny OS: assistant runs on a local 9B model through Ollama.\n- Bunny OS: 42 voice commands ship in v1.\n- Shipd: deploys in 3 steps.';
const GOOD = 'Bunny OS runs its assistant on a local 9B model through Ollama.\n\nIt ships with 42 voice commands in the first version.\n\nHow do you keep a local model fast on modest hardware? #LocalAI';

test('the committed brand file loads and keeps the current copy rules', () => {
  assert.equal(brand.copy.minChars, 250);
  assert.equal(brand.copy.maxChars, 1300);
  assert.equal(brand.copy.maxHashtags, 2);
  assert.ok(brand.voice.banned.includes('robust'));
});

test('a grounded, well-formed post passes every check', () => {
  const post = `${GOOD.split('\n\nHow')[0]}\n\nNothing leaves the machine when it answers, which keeps the replies private by design.\n\nHow do you keep a local model fast on modest hardware? #LocalAI`;
  const result = scorePost({ post, project: 'Bunny OS', facts: factsFor(STORY, 'Bunny OS'), brand });
  assert.deepEqual(Object.entries(result.checks).filter(([, check]) => !check.pass).map(([name]) => name), []);
  assert.equal(result.score, 1);
});

test('invented numbers, banned phrases, links, a question opener and repeats are caught', () => {
  const post = 'Why does Bunny OS feel fast?\n\nIt is robust and handles 500 requests. See github.com/x/y for more.\n\nWhat would you build next? #a #b #c';
  const result = scorePost({ post, project: 'Bunny OS', facts: factsFor(STORY, 'Bunny OS'), brand, others: ['Why does Bunny OS feel fast?\n\nOther text.'] });
  const failed = Object.entries(result.checks).filter(([, check]) => !check.pass).map(([name]) => name).sort();
  assert.deepEqual(failed, ['ending', 'freshOpener', 'length', 'noBannedPhrases', 'noLinks', 'numbersGrounded', 'opener'].sort());
  assert.match(result.checks.numbersGrounded.detail, /500/);
  assert.ok(result.score < 0.5);
});

test('the scorecard lists each post with blank columns for human ratings', () => {
  const entries = [
    { label: 'one', markdown: `# Draft\n\n- Project: Bunny OS\n\n---\n\n${GOOD}\n` },
    { label: 'broken', markdown: 'no divider here' },
  ];
  const results = scoreEntries({ entries, brand, storyBank: STORY });
  assert.equal(results[1].error, 'Draft has no post section.');
  const summary = summarize(results);
  assert.equal(summary.posts, 2);
  assert.equal(summary.failed, 1);
  const card = renderScorecard({ results, summary, mode: 'test', brandVersion: 1, humanRatings: ['Copy quality (1-5)'], when: new Date('2026-10-17T10:00:00Z') });
  assert.match(card, /^# Copy benchmark, 2026-10-17 10:00 UTC/);
  assert.match(card, /\| Post \| Project \| Auto score \| Failed checks \| Copy quality \(1-5\) \|/);
  assert.match(card, /\| broken \| \? \| n\/a \| Draft has no post section\. \|  \|/);
  assert.match(card, /> Bunny OS runs its assistant/);
});
