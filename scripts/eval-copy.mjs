// Isolated copy evaluation; never writes to the production draft folder or publishes anything.
// --generate --engine legacy|node --inputs DIR --topic NAME --runs N --out DIR
// --profile FILE --story FILE --history DIR|JSON --projects FILE --readmes DIR --brand FILE
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { getProfile, normalizeProfile } from '../src/profile.mjs';
import { createModel } from '../src/model.mjs';
import { parseDraft } from '../src/linkedin/publish.mjs';
import { generateCopy, draftMarkdown } from '../src/copy/pipeline.mjs';
import { renderScorecard, scoreEntries, summarize } from '../src/eval/copy-bench.mjs';
import { evaluateGenerated } from '../src/eval/copy-run.mjs';
import { loadBrand, validateBrand } from '../src/eval/copy-score.mjs';
import { createTracedFetch } from '../src/eval/copy-trace.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const options = Object.fromEntries(['limit', 'out', 'engine', 'inputs', 'profile', 'story', 'history', 'projects', 'readmes', 'brand', 'topic', 'runs', 'runner'].map((name) => [name, { type: 'string' }]));
const { values } = parseArgs({ options: { ...options, generate: { type: 'boolean', default: false }, 'story-only': { type: 'boolean', default: false } } });
const positive = (value, fallback) => {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error('limit and runs must be positive integers.');
  return Number(value);
};
const limit = positive(values.limit, 20);
const engine = values.engine ?? 'legacy';
if (!['legacy', 'node'].includes(engine)) throw new Error('--engine must be legacy or node.');
const readJson = async (file) => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const optionalJson = async (file, fallback = {}) => { try { return await readJson(file); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; } };
const base = values.inputs ? path.resolve(values.inputs) : null;
const snapshot = base ? await readJson(path.join(base, 'inputs.json')) : null;
const profile = values.profile ? normalizeProfile(await readJson(values.profile)) : snapshot ? normalizeProfile(snapshot.profile) : getProfile();
const brandOverride = values.brand || process.env.LOOM_BRAND;
const brand = brandOverride ? loadBrand(brandOverride) : snapshot?.brand ? validateBrand(snapshot.brand) : loadBrand();
const benchmark = snapshot?.benchmark ?? await readJson(path.join(ROOT, 'eval', 'benchmark.json'));
const settingsSources = { brand: brandOverride ? path.resolve(brandOverride) : snapshot?.brand ? 'inputs.json:brand' : 'config/brand.json (fallback)', benchmark: snapshot?.benchmark ? 'inputs.json:benchmark' : 'eval/benchmark.json (fallback)' };
const runs = positive(values.runs, benchmark.runsPerTopic ?? 1);
const storyFile = values.story || (base ? path.join(base, 'story-bank.md') : path.join(profile.linkedin.folder, 'story-bank.md'));
const storyBank = await readFile(storyFile, 'utf8');
const historyFile = values.history || (base ? path.join(base, 'history') : path.join(profile.linkedin.folder, 'drafts'));
let saved;
if ((await stat(historyFile)).isDirectory()) {
  saved = await Promise.all((await readdir(historyFile)).filter((name) => /\.md$/i.test(name)).sort().map(async (name) => ({ label: name.replace(/\.md$/i, ''), markdown: await readFile(path.join(historyFile, name), 'utf8') })));
} else {
  saved = (await readJson(historyFile)).map((post, index) => ({ label: `history-${index}`, markdown: `# History\n\n---\n\n${post}` }));
}
const postOf = (entry) => { try { return parseDraft(entry.markdown).post; } catch { return ''; } };
const out = path.resolve(values.out || path.join(ROOT, 'data', 'eval', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)));
await mkdir(out, { recursive: true });
const effectiveBrandFile = path.join(out, 'effective-brand.json');
await writeFile(effectiveBrandFile, JSON.stringify(brand, null, 2));
const projects = await optionalJson(values.projects || (base ? path.join(base, 'projects.json') : path.join(ROOT, 'config', 'projects.json')));
const readmes = values.readmes || (base ? path.join(base, 'readmes') : null);
const slug = (topic) => topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const sourcesFor = async (topic) => {
  if (values['story-only']) return { project: null, readme: '' };
  const key = Object.keys(projects).find((name) => name.toLowerCase() === topic.toLowerCase());
  let readme = '';
  if (readmes) { try { readme = await readFile(path.join(readmes, `${slug(topic)}.md`), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  return { project: key ? projects[key] : null, readme };
};

async function legacy({ topic, run, history }) {
  const work = path.join(out, 'legacy-work', `${slug(topic)}-${run}`);
  await mkdir(path.join(work, 'drafts'), { recursive: true });
  const profileFile = path.join(work, 'profile.json');
  const historyPath = path.join(work, 'history.json');
  const attemptsFile = path.join(work, 'attempts.json');
  await writeFile(profileFile, JSON.stringify({ ...profile, linkedin: { ...profile.linkedin, folder: work } }));
  await writeFile(historyPath, JSON.stringify(history));
  await writeFile(path.join(work, 'story-bank.md'), storyBank);
  await Promise.all(history.map((post, index) => writeFile(path.join(work, 'drafts', `${String(index).padStart(4, '0')}-history.md`), `# History\n\n---\n\n${post}\n`)));
  const made = await new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', values.runner || path.join(ROOT, 'scripts', 'linkedin-local-draft.ps1'), '-DryRun', '-Topic', topic], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LOOM_PROFILE: profileFile, LOOM_BRAND: effectiveBrandFile, LOOM_COPY_STORY: path.resolve(storyFile), LOOM_COPY_HISTORY: historyPath, LOOM_COPY_ATTEMPTS: attemptsFile },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
      child.kill();
    }, 16 * 60 * 1000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); resolve({ error: error.message, stdout, stderr }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const marker = stdout.indexOf('DRY RUN: Would write');
      resolve(code === 0 && marker >= 0 && !timedOut ? { markdown: stdout.slice(stdout.indexOf('\n', marker) + 1), stdout, stderr } : { error: timedOut ? 'Legacy runner timed out.' : `Legacy runner failed (exit ${code}).`, stdout, stderr });
    });
  });
  const attempts = await optionalJson(attemptsFile, []);
  await writeFile(path.join(work, 'process.json'), JSON.stringify(made, null, 2));
  if (made.error) { const error = new Error(made.error); error.attempts = attempts; throw error; }
  return { markdown: made.markdown, attempts };
}

let results;
const mode = values.generate ? `fresh isolated ${engine} drafts` : 'drafts already saved';
if (values.generate) {
  const topics = values.topic ? values.topic.split(',').map((topic) => topic.trim()).filter(Boolean) : benchmark.topics?.length ? benchmark.topics : profile.linkedin.topics;
  const askJson = createModel({ fetch: createTracedFetch({ directory: path.join(out, 'model-responses') }) });
  await writeFile(path.join(out, 'inputs.json'), JSON.stringify({ profile, storyFile: path.resolve(storyFile), historyFile: path.resolve(historyFile), brand, benchmark, settingsSources, topics, runs, engine, sourceMode: values['story-only'] ? 'story-only' : 'enriched' }, null, 2));
  results = await evaluateGenerated({ topics, runs, brand, storyBank, history: saved.map(postOf).filter(Boolean), avoid: profile.linkedin.avoid,
    generate: async ({ topic, run, history }) => {
      console.log(`Writing isolated ${engine} draft: ${topic} #${run}`);
      if (engine === 'legacy') return legacy({ topic, run, history });
      const made = await generateCopy({ askJson, topic, storyBank, profile, brand, history, ...await sourcesFor(topic) });
      return { ...made, markdown: draftMarkdown({ topic, formula: made.formula, post: made.post }) };
    },
    onEntry: async (entry, { topic, run }) => {
      const stem = path.join(out, `${slug(topic)}-${run}`);
      await writeFile(`${stem}.json`, JSON.stringify(entry, null, 2));
      if (entry.markdown) await writeFile(`${stem}.md`, entry.markdown);
      console.log(entry.error ? `FAILED: ${entry.label}: ${entry.error}` : `Constraint-valid (factual review pending): ${entry.label}`);
    },
  });
} else {
  const entries = saved.slice(-limit);
  // Legacy drafts without project metadata are intentionally reported as unscorable.
  results = scoreEntries({ entries, brand, storyBank, history: saved.slice(0, -limit).map(postOf).filter(Boolean), avoid: profile.linkedin.avoid, topics: profile.linkedin.topics });
}
const summary = summarize(results);
await writeFile(path.join(out, 'scorecard.md'), renderScorecard({ results, summary, mode, brandVersion: brand.version, humanRatings: benchmark.humanRatings }));
await writeFile(path.join(out, 'results.json'), JSON.stringify({ mode, brandVersion: brand.version, settingsSources, summary, results }, null, 2));
console.log(`Automatic constraint score ${Math.round(summary.score * 100)}%; yield ${Math.round(summary.yield * 100)}%. Scorecard: ${path.join(out, 'scorecard.md')}`);
