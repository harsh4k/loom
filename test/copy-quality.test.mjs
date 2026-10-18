import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { factsFor, loadBrand, scorePost } from '../src/eval/copy-score.mjs';
import { scoreEntries, summarize } from '../src/eval/copy-bench.mjs';
import { selectFacts } from '../src/copy/sources.mjs';

const story = `## 1. Timeline
- Engineer, Secret Employer: Alpha was NOT employer work.
## 2. Receipts
- 17th place, Demo Hackathon 2026, with Alpha. (The resume says "1st"; corrected to 17th. Never claim a win.)
## 3. Shipped
- Alpha: local assistant on 16 GB RAM.
- shipd: Windows activity report in PowerShell. edith: Python terminal system monitor.
## 8. Names you can use
- Free to name: Alpha, shipd, edith, Secret Employer.
## 9. Off limits
- Alpha employer code is confidential.`;

test('generation constrains citation IDs in both model schemas, not only after generation', async () => {
  const { generateCopy } = await import('../src/copy/pipeline.mjs');
  const recordId = 'story:6:1';
  const text = 'Alpha is a local assistant on 16 GB RAM.\n\nIts documented system memory capacity for running this local assistant is 16 GB RAM.';
  await generateCopy({ topic: 'Alpha', storyBank: story, brand: loadBrand(), profile: { linkedin: {} }, askJson: async ({ schema }) => {
    if (schema.properties.angle) {
      assert.ok(schema.properties.factIds.items.enum.includes(recordId));
      assert.ok(schema.required.includes('exclusions'));
      return { angle: 'A local assistant on 16 GB RAM', format: 'short-note', factIds: [recordId], exclusions: ['No unsupported memory performance guarantees.'] };
    }
    assert.deepEqual(schema.properties.claims.items.properties.factIds.items.enum, [recordId]);
    return { topic: 'Alpha', formula: 'Memory capacity', post: text, claims: [
      { text: 'Alpha is a local assistant on 16 GB RAM.', factIds: [recordId] },
      { text: 'Its documented system memory capacity for running this local assistant is 16 GB RAM.', factIds: [recordId] },
    ] };
  } });
});

test('project retrieval excludes global permissions and unrelated clauses', () => {
  assert.equal(factsFor(story, 'shipd'), 'shipd: Windows activity report in PowerShell.');
  assert.equal(factsFor(story, 'edith'), 'edith: Python terminal system monitor.');
  assert.equal(factsFor(story, ''), '');
  assert.equal(factsFor(story, 'Alpha'), '17th place, Demo Hackathon 2026, with Alpha.\nAlpha: local assistant on 16 GB RAM.');
});

test('repository metadata belongs to the exact selected project clause', () => {
  const records = selectFacts('- Alpha (github.com/demo/alpha): local assistant. Beta (github.com/demo/beta): remote helper.', 'Beta');
  assert.equal(records.length, 1);
  assert.equal(records[0].repo, 'github.com/demo/beta');
  assert.equal(records[0].text, 'Beta (github.com/demo/beta): remote helper.');
});

test('project focus accepts case changes but rejects longer containing names', () => {
  for (const [post, pass] of [['SHIPD reports activity.', true], ['shipdraft reports activity.', false]]) {
    assert.equal(scorePost({ post, project: 'shipd', facts: 'shipd reports activity.', brand: loadBrand() }).checks.namesProject.pass, pass);
  }
});

test('missing project metadata is unscorable instead of using the entire bank', () => {
  const [result] = scoreEntries({ entries: [{ label: 'legacy', markdown: '# Draft\n\n---\n\nAlpha uses 16 GB RAM.' }], brand: loadBrand(), storyBank: story });
  assert.match(result.error, /project/i);
});

test('numeric grounding compares complete numeric tokens', () => {
  const result = scorePost({ post: 'Alpha uses 6 GB RAM.', project: 'Alpha', facts: 'Alpha uses 16 GB RAM.', brand: loadBrand() });
  assert.equal(result.checks.numbersGrounded.pass, false);
});

test('version and model-size numeric claims must also occur in the evidence', () => {
  for (const post of ['Alpha v0.3.9 is available.', 'Alpha uses a 9B model.']) {
    const result = scorePost({ post, project: 'Alpha', facts: 'Alpha v0.3.4 uses a 4B model.', brand: loadBrand() });
    assert.equal(result.checks.numbersGrounded.pass, false);
  }
});

test('avoid-list names are rejected by benchmark even with mixed case', () => {
  const result = scorePost({ post: 'Alpha at SECRET EMPLOYER.', project: 'Alpha', facts: 'Alpha.', brand: loadBrand(), avoid: ['Secret Employer'] });
  assert.equal(result.checks.noRestrictedNames?.pass, false);
});

test('empty or malformed avoid entries do not ban every draft', () => {
  const result = scorePost({ post: 'Alpha is local.', project: 'Alpha', facts: 'Alpha is local.', brand: loadBrand(), avoid: ['', ' ', null, ' Secret Employer '] });
  assert.equal(result.checks.noRestrictedNames.pass, true);
});

test('a project catalogue is rejected when the post must focus on one topic', () => {
  const result = scorePost({ post: 'Alpha uses Beta and Gamma.', project: 'Alpha', facts: 'Alpha is local.', brand: loadBrand(), topics: ['Alpha', 'Beta', 'Gamma'] });
  assert.equal(result.checks.noUnrelatedProjects?.pass, false);
});

test('the hidden PowerShell adapter preserves Unicode source text over stdin', { skip: process.platform !== 'win32' }, () => {
  const stage = path.resolve('scripts/copy-stage.mjs').replace(/'/g, "''");
  const request = { action: 'prepare', topic: 'Alpha', storyBank: '- Alpha: résumé assistant with naïve search.', profile: { linkedin: {} }, brand: loadBrand(), history: [] };
  const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$OutputEncoding=[System.Text.UTF8Encoding]::new($false); [Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $request=[Console]::In.ReadToEnd(); $request | & node '${stage}'`], { input: JSON.stringify(request), encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).records[0].text, 'Alpha: résumé assistant with naïve search.');
});

test('local inference cannot become a claim of no network connectivity', () => {
  const result = scorePost({ post: 'Alpha works entirely offline. Nothing leaves the machine.', project: 'Alpha', facts: 'Alpha: local inference; zero cloud APIs.', brand: loadBrand() });
  assert.equal(result.checks.scopeGrounded?.pass, false);
  for (const post of ['Alpha: no data leaves the machine.', 'Alpha has zero cloud dependencies.', 'Alpha data stays on the machine.']) {
    assert.equal(scorePost({ post, project: 'Alpha', facts: 'Alpha: local inference.', brand: loadBrand() }).checks.scopeGrounded.pass, false, post);
  }
  assert.equal(scorePost({ post: 'Alpha data stays in this folder.', project: 'Alpha', facts: 'Alpha: all data stays in this folder.', brand: loadBrand() }).checks.scopeGrounded.pass, true);
});

test('pure PowerShell does not establish that a project has no external dependencies', () => {
  const result = scorePost({ post: 'shipd generates git reports without external dependencies.', project: 'shipd', facts: 'shipd: Windows activity and git report in pure PowerShell.', brand: loadBrand() });
  assert.equal(result.checks.scopeGrounded.pass, false);
});

test('failed generations lower yield and unconditional score', () => {
  const summary = summarize([{ post: 'valid', checks: { sample: { pass: true } }, score: 1, categories: {} }, { error: 'model failed' }]);
  assert.equal(summary.score, 0.5);
  assert.equal(summary.yield, 0.5);
  assert.equal(summary.successfulScore, 1);
});

test('generated, scorable, valid, and publishable counts remain separate', () => {
  const summary = summarize([
    { post: 'valid', score: 1, checks: { sample: { pass: true } }, categories: {} },
    { post: 'restricted name', score: 0.5, checks: { sample: { pass: false } }, categories: {} },
    { post: 'missing project', error: 'unscorable' },
    { error: 'generation failed' },
  ]);
  assert.equal(summary.attempted, 4);
  assert.equal(summary.generated, 3);
  assert.equal(summary.scorable, 2);
  assert.equal(summary.valid, 1);
  assert.equal(summary.publishable, null);
  assert.equal(summary.scorableYield, 0.5);
  assert.equal(summary.validYield, 0.25);
});

test('the candidate rejects fabricated citations and unmapped claims, then retries without echoing the bad draft', async () => {
  const pipeline = await import('../src/copy/pipeline.mjs').catch(() => ({}));
  assert.equal(typeof pipeline.generateCopy, 'function');
  const prompts = [];
  let copyAttempt = 0;
  const made = await pipeline.generateCopy({ topic: 'Alpha', storyBank: story, brand: loadBrand(), profile: { linkedin: {} },
    askJson: async (request) => {
      prompts.push(request.prompt);
      if (request.schema.properties.angle) return { angle: 'A local assistant', format: 'short-note', factIds: ['story:6:1'], exclusions: ['No unsupported guarantees.'] };
      copyAttempt += 1;
      if (copyAttempt === 1) return { topic: 'Alpha', formula: 'Concrete', post: 'Alpha SECRET INVENTION.', claims: [{ text: 'Alpha SECRET INVENTION.', factIds: ['made-up'] }] };
      const text = 'Alpha is a local assistant on 16 GB RAM. The explicitly recorded system memory requirement for this local assistant is 16 GB RAM.';
      return { topic: 'Alpha', formula: 'Concrete', post: text, claims: [{ text: text.split('. ')[0] + '.', factIds: ['story:6:1'] }, { text: 'The explicitly recorded system memory requirement for this local assistant is 16 GB RAM.', factIds: ['story:6:1'] }] };
    },
  });
  assert.equal(made.attempts.filter((item) => item.stage === 'copy').length, 2);
  assert.ok(made.attempts[1].errors.length);
  assert.equal(prompts.at(-1).includes('SECRET INVENTION'), false);
});

test('candidate evidence requires every declarative sentence to be mapped', async () => {
  const pipeline = await import('../src/copy/pipeline.mjs').catch(() => ({}));
  assert.equal(typeof pipeline.validateClaims, 'function');
  assert.match(pipeline.validateClaims({ post: 'Alpha runs locally. It won an award.', claims: [{ text: 'Alpha runs locally.', factIds: ['a'] }] }, [{ id: 'a', text: 'Alpha runs locally.' }]).join(' '), /unmapped/i);
});

test('voice I/O terminology is not mistaken for an invented first-person experience', async () => {
  const { validateClaims } = await import('../src/copy/pipeline.mjs');
  const records = [{ id: 'a', text: 'Alpha has voice I/O.' }];
  assert.deepEqual(validateClaims({ post: 'Alpha has voice I/O.', claims: [{ text: 'Alpha has voice I/O.', factIds: ['a'] }] }, records), []);
});

test('claims cannot introduce a model identifier absent from their cited source', async () => {
  const { validateClaims } = await import('../src/copy/pipeline.mjs');
  const post = 'Alpha uses nomic-embed-text for personal notes.';
  assert.match(validateClaims({ topic: 'Alpha', post, claims: [{ text: post, factIds: ['notes'] }] }, [{ id: 'notes', text: 'Alpha stores personal notes.' }]).join(' '), /nomic-embed-text/);
});

test('copy prompts contain only the brief-selected source records', async () => {
  const { generateCopy } = await import('../src/copy/pipeline.mjs');
  const source = '- Alpha: local assistant on 16 GB RAM.\n- Alpha: UnselectedTechnicalMarker handles search.';
  const post = 'Alpha is a local assistant on 16 GB RAM.\n\nThe recorded system memory capacity for running this local assistant is 16 GB RAM.';
  await generateCopy({ topic: 'Alpha', storyBank: source, profile: { linkedin: {} }, brand: loadBrand(), askJson: async ({ schema, prompt }) => {
    if (schema.properties.angle) return { angle: 'A local assistant on 16 GB RAM', format: 'short-note', factIds: ['story:1:1'], exclusions: ['Do not infer complete offline operation.'] };
    assert.equal(prompt.includes('UnselectedTechnicalMarker'), false);
    assert.ok(prompt.includes('Do not infer complete offline operation.'));
    return { topic: 'Alpha', formula: 'Memory capacity', post, claims: post.split('\n\n').map((text) => ({ text, factIds: ['story:1:1'] })) };
  } });
});

test('benchmark carries accepted drafts forward and counts generation failures', async () => {
  const module = await import('../src/eval/copy-run.mjs').catch(() => ({}));
  assert.equal(typeof module.evaluateGenerated, 'function');
  const post = 'Alpha is a local assistant on 16 GB RAM.\n\nWhich technical detail matters when choosing memory requirements for a local assistant?';
  let observedHistory;
  const results = await module.evaluateGenerated({ topics: ['Alpha'], runs: 2, history: [], storyBank: story, brand: loadBrand(),
    generate: async ({ history, run }) => {
      if (run === 2) { observedHistory = history; throw new Error('model offline'); }
      return { markdown: `# Draft\n\n- Project: Alpha\n\n---\n\n${post}` };
    },
  });
  assert.deepEqual(observedHistory, [post]);
  assert.equal(results[1].error, 'model offline');
  assert.equal(summarize(results).yield, 0.5);
});

