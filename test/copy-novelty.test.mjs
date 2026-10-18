import assert from 'node:assert/strict';
import test from 'node:test';
import { generateCopy, validateClaims } from '../src/copy/pipeline.mjs';
import { loadBrand } from '../src/eval/copy-score.mjs';

const storyBank = '- Alpha: shipped on 2 platforms.\n- Alpha: risky actions need on-screen confirmation.\n- Alpha: has a Python sidecar.';
const history = ['Alpha shipped on 2 platforms.'];
const originalBrand = loadBrand();
const brand = { ...originalBrand, copy: { ...originalBrand.copy, minChars: 20 } };
const input = { topic: 'Alpha', storyBank, history, brand, profile: { linkedin: {} } };
const brief = (angle, id) => ({ angle, format: 'short-note', factIds: [id], exclusions: ['No unsupported guarantees.'] });
const copy = (post, id) => ({ topic: 'Alpha', formula: 'Concrete', post, claims: [{ text: post, factIds: [id] }] });

test('a repeated brief is corrected to a fresh supported detail before asking for copy', async () => {
  let briefCalls = 0;
  const stages = [];
  const made = await generateCopy({ ...input, askJson: async (request) => {
    const isBrief = Boolean(request.schema.properties.angle);
    stages.push(isBrief ? 'brief' : 'copy');
    if (isBrief) return ++briefCalls === 1 ? brief('Alpha shipped on 2 platforms.', 'story:1:1') : brief('Risky actions need on-screen confirmation.', 'story:2:1');
    return copy('Alpha asks for on-screen confirmation before risky actions.', 'story:2:1');
  } });
  assert.deepEqual(stages, ['brief', 'brief', 'copy']);
  assert.match(made.attempts[1].prompt, /sourceSignals/);
  assert.match(made.attempts[1].prompt, /eligibleAsAngle/);
});

test('exhausted source novelty is skipped explicitly without calling the model', async () => {
  let calls = 0;
  await assert.rejects(generateCopy({ ...input, storyBank: '- Alpha: shipped on 2 platforms.', askJson: async () => { calls += 1; return brief('Alpha shipped on 2 platforms.', 'story:1:1'); } }), (error) => error.code === 'INSUFFICIENT_NOVELTY' && error.attempts.length === 0);
  assert.equal(calls, 0);
});

test('two repeated copy attempts trigger brief reselection within the global request budget', async () => {
  const stages = [];
  let briefCalls = 0;
  const made = await generateCopy({ ...input, askJson: async (request) => {
    if (request.schema.properties.angle) {
      stages.push('brief');
      return ++briefCalls === 1 ? brief('Risky actions need on-screen confirmation.', 'story:2:1') : brief('A Python sidecar runs alongside the desktop application.', 'story:3:1');
    }
    stages.push('copy');
    return briefCalls === 1 ? copy('Alpha shipped on 2 platforms.', 'story:1:1') : copy('Alpha includes a Python sidecar.', 'story:3:1');
  } });
  assert.deepEqual(stages, ['brief', 'copy', 'copy', 'brief', 'copy']);
  assert.equal(made.brief.factIds[0], 'story:3:1');
  assert.ok(made.attempts.length <= 6);
});

test('a copied claim cannot be anchored only by an irrelevant source ID', () => {
  const result = copy('Alpha needs on-screen confirmation before risky actions.', 'a');
  const errors = validateClaims(result, [{ id: 'a', text: 'Alpha shipped on 2 platforms.' }, { id: 'b', text: 'Alpha requires confirmation for risky actions.' }]);
  assert.match(errors.join(' '), /substantive.*evidence/i);
});

test('reselection cannot exceed six model calls when stale copy persists', async () => {
  let calls = 0;
  let briefs = 0;
  await assert.rejects(generateCopy({ ...input, askJson: async (request) => {
    calls += 1;
    if (request.schema.properties.angle) return ++briefs === 1 ? brief('Risky actions need on-screen confirmation.', 'story:2:1') : brief('A Python sidecar runs alongside the desktop application.', 'story:3:1');
    return copy('Alpha shipped on 2 platforms.', 'story:1:1');
  } }), (error) => error.code === 'NOVELTY_RETRY_EXHAUSTED' && error.attempts.length === 6);
  assert.equal(calls, 6);
});
