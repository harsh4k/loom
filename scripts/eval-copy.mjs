// Copy benchmark. Usage:
//   node scripts/eval-copy.mjs                 score the latest drafts already in the drafts folder
//   node scripts/eval-copy.mjs --generate      write fresh dry-run drafts per topic with Qwen, then score them
// Options: --limit N (drafts to score, default 20), --out DIR (default data/eval/<time>).
// Nothing is posted and no draft is saved; results stay on this PC.
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { draftsFolder, getProfile } from '../src/profile.mjs';
import { renderScorecard, scoreEntries, summarize } from '../src/eval/copy-bench.mjs';
import { loadBrand } from '../src/eval/copy-score.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const RUNNER = path.join(ROOT, 'scripts', 'linkedin-local-draft.ps1');
const RUN_TIMEOUT_MS = 15 * 60 * 1000;

const { values } = parseArgs({ options: { generate: { type: 'boolean', default: false }, limit: { type: 'string', default: '20' }, out: { type: 'string' } } });
const limit = Number.parseInt(values.limit, 10);
if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a whole number above 0.');

const profile = getProfile();
const brand = loadBrand();
const benchmark = JSON.parse(await readFile(path.join(ROOT, 'eval', 'benchmark.json'), 'utf8'));
const storyBank = await readFile(path.join(profile.linkedin.folder, 'story-bank.md'), 'utf8');
const folder = draftsFolder(profile);
const names = (await readdir(folder)).filter((name) => /\.md$/i.test(name)).sort();
const saved = await Promise.all(names.map(async (name) => ({ label: name.replace(/\.md$/i, ''), markdown: await readFile(path.join(folder, name), 'utf8') })));

// Runs the real draft script in dry-run mode, hidden, and returns the draft it would have written.
function dryRun(topic) {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', RUNNER, '-DryRun', '-Topic', topic], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), RUN_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => { clearTimeout(timer); resolve({ error: error.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const marker = out.indexOf('DRY RUN: Would write');
      if (code !== 0 || marker === -1) { resolve({ error: (err || out).trim().split(/\r?\n/).slice(-1)[0] || `exit ${code}` }); return; }
      resolve({ markdown: out.slice(out.indexOf('\n', marker) + 1) });
    });
  });
}

let entries;
let history;
let mode;
if (values.generate) {
  const topics = benchmark.topics?.length ? benchmark.topics : profile.linkedin.topics;
  const runs = Math.max(1, Number(benchmark.runsPerTopic) || 1);
  entries = [];
  for (const topic of topics) {
    for (let run = 1; run <= runs; run += 1) {
      const label = runs > 1 ? `${topic} #${run}` : topic;
      console.log(`Writing a dry-run draft: ${label}`);
      const made = await dryRun(topic);
      entries.push(made.markdown ? { label, markdown: made.markdown } : { label, markdown: `- Project: ${topic}\n`, error: made.error });
    }
  }
  history = saved.map((item) => item.markdown);
  mode = 'fresh dry-run drafts';
} else {
  entries = saved.slice(-limit);
  history = saved.slice(0, -limit).map((item) => item.markdown);
  mode = 'drafts already saved';
}

const historyPosts = history.map((markdown) => { try { return markdown.replace(/\r\n/g, '\n').split('\n---\n')[1]?.trim() ?? ''; } catch { return ''; } }).filter(Boolean);
const results = scoreEntries({ entries, brand, storyBank, history: historyPosts }).map((result, index) => (entries[index].error ? { ...result, error: entries[index].error } : result));
const summary = summarize(results);
const out = values.out ? path.resolve(values.out) : path.join(ROOT, 'data', 'eval', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
await mkdir(out, { recursive: true });
await writeFile(path.join(out, 'scorecard.md'), renderScorecard({ results, summary, mode, brandVersion: brand.version, humanRatings: benchmark.humanRatings }));
await writeFile(path.join(out, 'results.json'), JSON.stringify({ mode, brandVersion: brand.version, summary, results }, null, 2));
console.log(`Automatic score ${Math.round(summary.score * 100)}% over ${summary.posts} posts. Scorecard: ${path.join(out, 'scorecard.md')}`);
