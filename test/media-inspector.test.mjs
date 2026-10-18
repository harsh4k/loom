import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInspector } from '../src/media/quality.mjs';

test('inspection reviews every numbered contact sheet and preserves the critique', async () => {
  const dir = await mkdtemp(path.resolve('data/quality/inspector-'));
  const layout = Object.fromEntries(['lint', 'runtime', 'layout', 'contrast'].map(key => [key, { findings: [] }]));
  const seen = [];
  try {
    const inspect = createInspector({
      hf: async args => {
        if (args[0] === 'check') {
          const checks = path.join(args[1], '.hyperframes/artifacts/checks');
          await mkdir(checks, { recursive: true }); await writeFile(path.join(checks, 'report.json'), JSON.stringify(layout));
        } else {
          const frames = args.at(-1); await mkdir(frames, { recursive: true });
          await writeFile(path.join(frames, 'contact-sheet-1.jpg'), 'first-sheet');
          await writeFile(path.join(frames, 'contact-sheet-2.jpg'), 'second-sheet');
        }
        return { code: 0, output: '' };
      },
      askJson: async request => { assert.equal(request.images.length, 1, 'one sheet per request leaves response context'); seen.push(...request.images.map(image => Buffer.from(image, 'base64').toString())); return { score: 8, problems: [] }; },
    });
    const reportDir = path.join(dir, 'report');
    const result = await inspect({ film: { tokens: {}, shots: [{ scene: 'statement', text: 'Fixture', d: 2 }] }, format: 'landscape', workDir: path.join(dir, 'work'), reportDir });
    assert.equal(result.status, 'PASS');
    assert.deepEqual(seen, ['first-sheet', 'second-sheet']);
    assert.deepEqual(JSON.parse(await readFile(path.join(reportDir, 'critique.json'), 'utf8')), { score: 8, problems: [] });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('multi-sheet review keeps the lowest score and cannot hide an unavailable sheet', async () => {
  const dir = await mkdtemp(path.resolve('data/quality/sheet-context-'));
  const layout = Object.fromEntries(['lint', 'runtime', 'layout', 'contrast'].map(key => [key, { findings: [] }]));
  const hf = async args => {
    if (args[0] === 'check') { const checks = path.join(args[1], '.hyperframes/artifacts/checks'); await mkdir(checks, { recursive: true }); await writeFile(path.join(checks, 'report.json'), JSON.stringify(layout)); }
    else { await mkdir(args.at(-1), { recursive: true }); for (const n of [1, 2]) await writeFile(path.join(args.at(-1), `contact-sheet-${n}.jpg`), String(n)); }
    return { code: 0 };
  };
  try {
    for (const [name, second, status, score] of [['low', { score: 6, problems: [] }, 'FAIL', 6], ['missing', null, 'UNVERIFIED', 8]]) {
      let calls = 0;
      const inspect = createInspector({ hf, askJson: async request => { assert.equal(request.images.length, 1); return ++calls === 1 ? { score: 8, problems: [] } : second; } });
      const reportDir = path.join(dir, name);
      const result = await inspect({ film: { shots: [{ scene: 'statement', text: 'Fixture', d: 2 }] }, format: 'story', workDir: path.join(dir, name + '-work'), reportDir });
      assert.equal(calls, 2); assert.equal(result.status, status); assert.equal(result.score, score);
      assert.equal(JSON.parse(await readFile(path.join(reportDir, 'critique-sheets.json'), 'utf8')).length, 2);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a poster critique sees one settled static output with static design criteria', async () => {
  const dir = await mkdtemp(path.resolve('data/quality/poster-inspector-'));
  let times, prompt;
  try {
    const inspect = createInspector({ hf: async args => {
      if (args[0] === 'snapshot') {
        times = args[args.indexOf('--at') + 1];
        await mkdir(args.at(-1), { recursive: true }); await writeFile(path.join(args.at(-1), 'contact-sheet.jpg'), 'settled');
      }
      return { code: 0, output: '' };
    }, askJson: async request => { prompt = request.prompt; return { score: 8, problems: [] }; } });
    await inspect({ film: { tokens: {}, shots: [{ scene: 'poster', name: 'Fixture', line: 'A supported statement.', d: 3.2 }] }, format: 'poster', workDir: path.join(dir, 'work'), reportDir: path.join(dir, 'report') });
    assert.equal(times, '2.95');
    assert.match(prompt, /static poster/i);
    assert.match(prompt, /not required/i);
    assert.doesNotMatch(prompt, /frames from a short motion design film/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
