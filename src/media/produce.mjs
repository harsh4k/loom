// Makes a project's post media in Loom's studio, on this PC, with the local model:
// 1. Art direction (once per project, kept in data/media/looks.json).
// 2. A fresh storyboard for this post, checked against the project's facts.
// 3. A quality gate: HyperFrames' layout and contrast check, then Qwen looks at the frames.
//    A rejected storyboard is rewritten with the reasons, up to three times, then a safe one is used.
// 4. Renders: the 16:9 video (posted), 4:5 and 9:16 cuts, and a 4:5 poster image.
import { createInspector, gateProblems, qualityVerdict } from './quality.mjs';
export { gateProblems, qualityVerdict } from './quality.mjs';
import { LOOK_VERSION } from './art-direction.mjs';
import { evidenceMap } from './claims.mjs';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { artDirect, CRITIQUE_PROMPT, CRITIQUE_SCHEMA, fallbackStoryboard, filmFor, posterShots, projectFacts, writeStoryboard } from './director.mjs';
import { loadTypeFaces, parseSettings } from './fonts.mjs';
import { loadLibrary } from './library.mjs';
import { filmDuration, prepareStudio } from './studio.mjs';

const ATTEMPTS = 3;
const HISTORY = 6;
export const CUTS = Object.freeze([
  { format: 'landscape', suffix: '' },
  { format: 'portrait', suffix: '-4x5' },
  { format: 'story', suffix: '-9x16' },
]);

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}
async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(value, null, 2));
  await rename(`${file}.tmp`, file);
}
async function fileSize(file) {
  try { return (await stat(file)).size; } catch { return 0; }
}

// The moments worth looking at: late in each shot, when its words have landed.
export function sampleTimes(shots) {
  const times = [];
  let t = 0;
  for (const shot of shots) {
    const d = Math.min(8, Math.max(1, Number(shot.d) || 2.5));
    times.push(Number((t + d * 0.8).toFixed(2)));
    t += d;
  }
  return times;
}

export function createStudio({
  askJson, dataDir, hyperframesBin, browserPath, run, author = '',
  tasteDir, libraryDir, inspoFile, fetch: fetchImpl = fetch, renderTimeoutMs = 15 * 60 * 1000,
  readme = async () => null, // (project, { signal }) => the project's README markdown, or null
}) {
  const mediaDir = path.join(dataDir, 'media');
  const looksFile = path.join(mediaDir, 'looks.json');
  const historyFile = path.join(mediaDir, 'storyboards.json');
  const fontCache = path.join(mediaDir, 'fonts');
  const env = { HYPERFRAMES_NO_TELEMETRY: '1', HYPERFRAMES_NO_UPDATE_CHECK: '1', HYPERFRAMES_SKIP_SKILLS: '1', ...(browserPath ? { HYPERFRAMES_BROWSER_PATH: browserPath } : {}) };
  const hf = (args, signal, timeoutMs = 5 * 60 * 1000) => run(process.execPath, [hyperframesBin, ...args], { signal, timeoutMs, env });

  async function lookFor(project, { library, facts, hasPicture, signal, report }) {
    const looks = await readJson(looksFile, {});
    const kept = looks[project.name];
    const usable = kept?.version === LOOK_VERSION && library.grammars[kept.direction] && library.palettes.some((p) => p.id === kept.paletteId) && kept.typeIds?.some((id) => library.types.some((t) => t.id === id));
    if (usable) return kept;
    report(`Art-directing ${project.name}.`);
    const look = await artDirect({ project, facts, library, looks, askJson, hasPicture, signal });
    await writeJson(looksFile, { ...(await readJson(looksFile, {})), [project.name]: look });
    return look;
  }

  async function typeFor(look, library, signal) {
    for (const id of look.typeIds ?? [look.typeId]) {
      const system = library.types.find((t) => t.id === id);
      if (!system) continue;
      const fonts = await loadTypeFaces(system, { cacheDir: fontCache, fetch: fetchImpl, signal }).catch(() => null);
      if (fonts) return { system, fonts };
    }
    return { system: null, fonts: null };
  }

  const inspect = createInspector({ hf, askJson });

  async function renderCut({ film, format, images, fonts, workDir, output, signal }) {
    await rm(workDir, { recursive: true, force: true });
    await prepareStudio({ workDir, film, format, images, fonts });
    const result = await hf(['render', workDir, '--output', output, '--quality', 'looks', '--fps', '30'], signal, renderTimeoutMs);
    if (result.code !== 0 || (await fileSize(output)) < 75 * 1024) {
      throw new Error(`the ${format} render failed${result.output ? `: ${result.output.trim().split(/\r?\n/).slice(-1)[0].slice(0, 160)}` : ''}`);
    }
    return output;
  }

  async function renderPoster({ film, images, fonts, workDir, output, signal }) {
    await rm(workDir, { recursive: true, force: true });
    await prepareStudio({ workDir, film, format: 'poster', images, fonts });
    const framesDir = path.join(workDir, 'still');
    const at = Math.max(0.1, filmDuration(film) - 0.05).toFixed(2);
    await hf(['snapshot', workDir, '--at', at, '--no-end', '--describe', 'false', '-o', framesDir], signal);
    const still = existsSync(framesDir) ? (await readdir(framesDir)).find((name) => name.startsWith('frame-') && name.endsWith('.png')) : null;
    if (!still) throw new Error('the poster still could not be captured');
    await copyFile(path.join(framesDir, still), output);
    return output;
  }

  // project: a config/projects.json entry. images: { shot, readme } file paths (either may be missing).
  return async function produce({ project, images = {}, outBase, workRoot, draft = '', signal, report = () => {} }) {
    const library = loadLibrary({ tasteDir, libraryDir, inspoFile });
    if (!library.directions.length || !library.palettes.length || !library.types.length) throw new Error('the design library is empty');
    const readmeMarkdown = await readme(project, { signal }).catch((error) => { if (signal?.aborted) throw error; return null; });
    const facts = projectFacts(project, { draft, readme: readmeMarkdown ?? '' });
    const hasPicture = Boolean(images.shot || images.readme);
    const look = await lookFor(project, { library, facts, hasPicture, signal, report });
    const { system, fonts } = await typeFor(look, library, signal);
    const displaySettings = system ? parseSettings(system.display.settings) : {};
    const histories = await readJson(historyFile, {});
    const history = Array.isArray(histories[project.name]) ? histories[project.name] : [];
    const workDir = path.join(workRoot, randomUUID());
    const qualityDir = `${outBase}.quality`;
    await mkdir(qualityDir, { recursive: true });
    const notes = [];
    let manifest = null;
    const persist = async () => {
      if (!manifest) return;
      const checks = [...Object.values(manifest.quality.formats), ...Object.values(manifest.quality.renders)];
      manifest.quality.status = checks.some((item) => item.status === 'FAIL') ? 'FAIL' : checks.some((item) => item.status === 'UNVERIFIED') ? 'UNVERIFIED' : 'PASS';
      await writeFile(path.join(qualityDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    };
    try {
      let shots = null;
      let feedback = '';
      let verdict = null;
      for (let attempt = 1; attempt <= ATTEMPTS && !shots; attempt += 1) {
        report(`Storyboarding the ${project.name} film (draft ${attempt}).`);
        const written = await writeStoryboard({ project, facts, look, library, images, author, askJson: (args) => askJson({ ...args, temperature: 0.7 }), history, feedback, signal })
          .catch((error) => { if (signal?.aborted) throw error; return { shots: null, problems: ['Qwen did not answer'] }; });
        if (!written.shots) { feedback = written.problems.slice(-4).join('; '); report(`Draft ${attempt} rejected: ${feedback}.`); continue; }
        report(`Checking the ${project.name} landscape layout and sampled frames.`);
        const film = filmFor({ look, library, shots: written.shots, typeSystem: system, displaySettings });
        verdict = await inspect({ film, format: 'landscape', images, fonts, workDir: path.join(workDir, `check-${attempt}`), reportDir: path.join(qualityDir, `attempt-${attempt}`), signal });
        if (verdict.status === 'FAIL') { feedback = verdict.problems.slice(0, 3).join('; '); report(`Draft ${attempt} looked wrong${verdict.score ? ` (${verdict.score}/10)` : ''}: ${feedback}.`); continue; }
        shots = written.shots;
      }
      const usedFallback = !shots;
      if (!shots) {
        notes.push(`used a plain storyboard (${feedback || 'drafts kept failing the checks'})`);
        shots = fallbackStoryboard({ project, facts, look, library, images, author });
      }

      const film = filmFor({ look, library, shots, typeSystem: system, displaySettings });
      const formats = {};
      for (const format of ['landscape', 'portrait', 'story', 'poster']) {
        const checkedFilm = format === 'poster' ? { ...film, shots: posterShots({ look, library, shots }) } : film;
        formats[format] = format === 'landscape' && !usedFallback && verdict ? verdict : await inspect({ film: checkedFilm, format, images, fonts, workDir: path.join(workDir, `inspect-${format}`), reportDir: path.join(qualityDir, format), signal });
      }
      const quality = {
        status: Object.values(formats).some((item) => item.status === 'FAIL') ? 'FAIL' : Object.values(formats).some((item) => item.status === 'UNVERIFIED') ? 'UNVERIFIED' : 'PASS',
        scope: 'Layout and sampled visual frames; not semantic correctness or motion playback', formats,
        renders: Object.fromEntries(['landscape', 'portrait', 'story', 'poster'].map((format) => [format, { status: 'UNVERIFIED', reason: 'Render not completed' }])),
        motion: { status: 'UNVERIFIED', reason: 'Review actual playback for pacing and transition continuity.' },
        usedFallback, reportDir: qualityDir,
        grounding: { status: 'REVIEW_REQUIRED', reason: 'Source traceability and lexical checks do not prove semantic entailment.', sources: facts.records, shots: evidenceMap(shots, facts.records) },
      };
      manifest = { quality, look, film, fonts: system?.id ?? 'system' };
      await persist();
      const cuts = {};
      for (const { format, suffix } of CUTS) {
        report(`Rendering the ${project.name} ${format === 'landscape' ? '16:9 video' : `${format} cut`}.`);
        try {
          cuts[format] = await renderCut({ film, format, images, fonts, workDir: path.join(workDir, format), output: `${outBase}${suffix}.mp4`, signal });
          quality.renders[format] = { status: 'PASS', output: cuts[format] };
        } catch (error) {
          quality.renders[format] = { status: 'FAIL', reason: error.message };
          if (signal?.aborted || format === 'landscape') throw error;
          notes.push(error.message);
        }
      }
      let image = null;
      report(`Making the ${project.name} poster.`);
      try {
        const poster = { ...film, shots: posterShots({ look, library, shots }) };
        image = await renderPoster({ film: poster, images, fonts, workDir: path.join(workDir, 'poster'), output: `${outBase}.png`, signal });
        quality.renders.poster = { status: 'PASS', output: image };
      } catch (error) {
        quality.renders.poster = { status: 'FAIL', reason: error.message };
        if (signal?.aborted) throw error;
        notes.push(error.message);
      }

      // Only Qwen's own films are remembered; the plain fallback would make every later draft look like a repeat.
      await persist();
      if (quality.status !== 'PASS') notes.push(`visual quality ${quality.status}; inspect ${qualityDir}`);
      if (!usedFallback && quality.status === 'PASS') await writeJson(historyFile, { ...(await readJson(historyFile, {})), [project.name]: [...history, shots].slice(-HISTORY) });
      return {
        name: project.name,
        video: cuts.landscape,
        image,
        cuts,
        quality,
        look: { direction: look.direction, palette: look.paletteId, type: system?.id ?? 'system', motion: look.motionId, poster: look.posterId, score: verdict?.score ?? null },
        note: notes.length ? `Studio: ${notes.join('; ')}.` : '',
      };
    } finally {
      await persist();
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  };
}
