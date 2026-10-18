// Local media benchmark. Reuses frozen sources/assets and private per-arm studio state.
// node scripts/eval-media.mjs --inputs DIR --out DIR [--source-root DIR] [--topics A,B]
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createModel } from '../src/model.mjs';
import { findBrowser, HYPERFRAMES_BIN, runProcess } from '../src/media/render.mjs';

const { values } = parseArgs({ options: Object.fromEntries(['inputs', 'out', 'source-root', 'topics'].map((key) => [key, { type: 'string' }])) });
if (!values.inputs || !values.out) throw new Error('--inputs and --out are required; production state is never used.');
const root = path.resolve(values.inputs);
const out = path.resolve(values.out);
const sourceRoot = path.resolve(values['source-root'] || path.join(import.meta.dirname, '..'));
const { createStudio } = await import(pathToFileURL(path.join(sourceRoot, 'src/media/produce.mjs')).href);
const topics = (values.topics || 'Bunny OS,Rudo,shipd,GetCited').split(',').map((item) => item.trim()).filter(Boolean);
const slug = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const exists = async (file) => { try { return (await stat(file)).isFile(); } catch { return false; } };
const projectsText = await readFile(path.join(root, 'projects.json'), 'utf8');
const projects = JSON.parse(projectsText);
const state = path.join(out, 'state');
await mkdir(path.join(state, 'media'), { recursive: true });
// Each invocation starts a new arm. Existing benchmark results must never be overwritten.
if (await exists(path.join(out, 'manifest.json'))) throw new Error('This output already has a benchmark manifest; choose a new --out.');
for (const name of ['looks.json', 'storyboards.json']) {
  const source = path.join(root, name);
  if (await exists(source)) await cp(source, path.join(state, 'media', name));
}
// Font files are a cache, never a source of creative state.
const fontCache = path.join(root, 'baseline-media/state/media/fonts');
try { await cp(fontCache, path.join(state, 'media/fonts'), { recursive: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
let request = 0;
await mkdir(path.join(out, 'model-responses'), { recursive: true });
const askJson = createModel({ fetch: async (...args) => {
  const id = ++request;
  const response = await fetch(...args);
  await writeFile(path.join(out, 'model-responses', `${String(id).padStart(3, '0')}.json`), await response.clone().text());
  return response;
} });
const produce = createStudio({
  askJson, dataDir: state, hyperframesBin: HYPERFRAMES_BIN, browserPath: findBrowser(), author: '',
  tasteDir: path.join(sourceRoot, 'media/library/taste'), libraryDir: path.join(sourceRoot, 'media/library'),
  inspoFile: path.join(root, 'inspo.json'),
  run: (command, args, options) => runProcess(spawn, command, args, options),
  readme: async (project) => {
    const file = path.join(root, 'readmes', `${slug(project.name)}.md`);
    return await exists(file) ? readFile(file, 'utf8') : null;
  },
});
const manifest = { startedAt: new Date().toISOString(), sourceRoot, topics, projectsSha256: createHash('sha256').update(projectsText).digest('hex'), results: [] };
await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
for (const topic of topics) {
  const key = Object.keys(projects).find((name) => name.toLowerCase() === topic.toLowerCase());
  if (!key) { manifest.results.push({ topic, error: 'No project source record.', verdict: 'UNVERIFIED' }); continue; }
  const project = projects[key];
  const dir = path.join(out, slug(topic));
  await mkdir(dir, { recursive: true });
  const images = {};
  for (const kind of ['shot', 'readme']) {
    const file = path.join(root, 'images', slug(topic), `${kind}.png`);
    if (await exists(file)) images[kind] = file;
  }
  const started = Date.now();
  console.log(`MEDIA ${topic}: started`);
  try {
    const result = await produce({ project, images, outBase: path.join(dir, slug(topic)), workRoot: path.join(out, 'work'), report: (message) => console.log(`${topic}: ${message}`) });
    manifest.results.push({ topic, result, ms: Date.now() - started });
  } catch (error) {
    manifest.results.push({ topic, error: error.message, verdict: error.quality?.verdict ?? 'UNVERIFIED', ms: Date.now() - started });
  }
  await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`MEDIA ${topic}: ${Math.round((Date.now() - started) / 1000)}s`);
}
manifest.finishedAt = new Date().toISOString();
await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Saved media benchmark: ${out}. Playback and factual review remain separate from rendering.`);
