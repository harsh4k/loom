// Renders a post's video and poster image on this PC with HyperFrames, using real screenshots of
// the project. With the local model available, Loom's studio (produce.mjs) art-directs and
// storyboards a film for the project; the single media/post template is the fallback.
// Nothing here calls a paid service.
import { spawn as systemSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { cp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createGitHub } from '../github/repos.mjs';
import { getProfile } from '../profile.mjs';
import { createStudio } from './produce.mjs';

const MEDIA_ROOT = path.resolve(import.meta.dirname, '../../media');
export const TEMPLATE_DIR = path.join(MEDIA_ROOT, 'post');
export const HYPERFRAMES_BIN = path.join(MEDIA_ROOT, 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs');
export const PROJECTS_FILE = path.resolve(import.meta.dirname, '../../config/projects.json');
const RENDER_TIMEOUT_MS = 15 * 60 * 1000;
const CAPTURE_TIMEOUT_MS = 90 * 1000;
const IMAGE_LIMIT = 15 * 1024 * 1024;
const MIN_SCREENSHOT_BYTES = 20 * 1024;
const OUTPUT_TAIL = 4 * 1024;

// Prefer chrome-headless-shell: HyperFrames' fast BeginFrame capture needs it.
export function findBrowser(env = process.env) {
  for (const key of ['HUB_BROWSER_PATH', 'HYPERFRAMES_BROWSER_PATH']) if (env[key] && existsSync(env[key])) return env[key];
  if (!env.LOCALAPPDATA) return null;
  const root = path.join(env.LOCALAPPDATA, 'ms-playwright');
  let names;
  try { names = readdirSync(root); } catch { return null; }
  const version = (name) => Number(name.split('-').pop()) || 0;
  for (const [prefix, exe] of [['chromium_headless_shell-', path.join('chrome-headless-shell-win64', 'chrome-headless-shell.exe')], ['chromium-', path.join('chrome-win64', 'chrome.exe')]]) {
    const found = names.filter((name) => name.startsWith(prefix) && !name.slice(prefix.length).includes('_'))
      .sort((a, b) => version(b) - version(a))
      .map((name) => path.join(root, name, exe))
      .find((file) => existsSync(file));
    if (found) return found;
  }
  return null;
}

// config/projects.json is personal and not committed (config/projects.example.json shows the
// shape). Without it, posts go out as text only.
export function loadProjects(file = PROJECTS_FILE) {
  let value;
  try { value = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { if (error?.code === 'ENOENT') return {}; throw error; }
  return Object.fromEntries(Object.entries(value).filter(([key, entry]) => !key.startsWith('_') && entry && typeof entry === 'object'));
}

export function findProject(projects, topic) {
  if (typeof topic !== 'string' || !topic.trim()) return null;
  const wanted = topic.trim().toLowerCase();
  const key = Object.keys(projects).find((name) => name.toLowerCase() === wanted);
  return key ? projects[key] : null;
}

// Reads a project's README from the GitHub repo its link names, for the studio's facts.
export function projectReadme({ token = () => null, fetch: fetchImpl = fetch } = {}) {
  return async (project, { signal } = {}) => {
    const fullName = /^(?:https?:\/\/)?github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/i.exec(project?.link ?? '')?.[1];
    if (!fullName) return null;
    const github = createGitHub({ token: token(), user: fullName.split('/')[0], fetch: fetchImpl });
    return github.readme(fullName, { signal });
  };
}

// The composition's variables are flat strings; stats are "value|label" lines.
export function compositionVariables(project, { author, shot }) {
  return {
    name: project.name,
    eyebrow: project.eyebrow ?? 'Shipped project',
    hook: project.hook ?? project.tagline,
    tagline: project.tagline,
    author,
    stats: (project.stats ?? []).slice(0, 3).map(([value, label]) => `${value}|${label}`).join('\n'),
    stack: (project.stack ?? []).join(', '),
    link: project.link ?? '',
    accent: project.accent ?? '#7c8cff',
    accent2: project.accent2 ?? '#ff7ab6',
    command: project.command ?? '',
    footnote: project.link?.startsWith('github.com/') ? 'Repo link in the comments' : 'Link in the comments',
    shot: shot ?? '',
  };
}

export function runProcess(spawn, command, args, { signal, timeoutMs, env }) {
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    } catch (error) { reject(error); return; }
    const keep = (chunk) => { output = (output + chunk.toString('utf8')).slice(-OUTPUT_TAIL); };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const stop = () => {
      if (child.pid && process.platform === 'win32') {
        try { spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* Fall through to kill. */ }
      }
      try { child.kill(); } catch { /* Already gone. */ }
    };
    const timer = setTimeout(() => { if (!settled) { stop(); finish(new Error(`${path.basename(command)} timed out.`)); } }, timeoutMs);
    const onAbort = () => { stop(); finish(new Error('Stopped.')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    function finish(error, code) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) { error.output = output; reject(error); } else resolve({ code, output });
    }
    child.once('error', (error) => finish(error));
    child.once('close', (code) => finish(null, code));
  });
}

async function fileSize(file) {
  try { return (await stat(file)).size; } catch { return 0; }
}

export function createMediaRenderer({
  projectsFile = PROJECTS_FILE,
  templateDir = TEMPLATE_DIR,
  hyperframesBin = HYPERFRAMES_BIN,
  workRoot,
  author = getProfile().name,
  browserPath = findBrowser(),
  ffmpeg = process.env.HYPERFRAMES_FFMPEG_PATH || 'ffmpeg',
  spawn = systemSpawn,
  fetch: fetchImpl = fetch,
  renderTimeoutMs = RENDER_TIMEOUT_MS,
  studio = null, // { askJson, dataDir, tasteDir? } turns on Loom's studio
} = {}) {
  if (!workRoot) throw new TypeError('workRoot is required');
  const run = (command, args, options) => runProcess(spawn, command, args, options);
  const produce = studio?.askJson && studio?.dataDir
    ? createStudio({ ...studio, hyperframesBin, browserPath, run, author, fetch: fetchImpl, renderTimeoutMs })
    : null;

  async function captureSite(url, target, signal, workDir) {
    if (!browserPath || !/^https:\/\//.test(url)) return false;
    await runProcess(spawn, browserPath, [
      '--headless', '--hide-scrollbars', '--no-first-run', '--disable-extensions', '--mute-audio',
      `--user-data-dir=${path.join(workDir, 'browser-profile')}`, '--window-size=1440,1080',
      '--virtual-time-budget=12000', `--screenshot=${target}`, url,
    ], { signal, timeoutMs: CAPTURE_TIMEOUT_MS });
    return (await fileSize(target)) >= MIN_SCREENSHOT_BYTES;
  }

  async function downloadImage(url, target) {
    if (!/^https:\/\//.test(url)) return false;
    const response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
    const type = response.headers.get('content-type') ?? '';
    if (!response.ok || !/^image\/(png|jpeg|webp|gif)/.test(type)) return false;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > IMAGE_LIMIT || bytes.length < 1024) return false;
    await writeFile(target, bytes);
    return true;
  }

  // Returns the screenshot path relative to the composition, or '' when none could be made.
  async function screenshot(project, workDir, signal, notes) {
    const assets = path.join(workDir, 'assets');
    if (project.shot?.url) {
      try { if (await captureSite(project.shot.url, path.join(assets, 'shot.png'), signal, workDir)) return 'assets/shot.png'; }
      catch (error) { if (signal?.aborted) throw error; }
      notes.push('the live site could not be captured');
    }
    if (project.shot?.image) {
      try { if (await downloadImage(project.shot.image, path.join(assets, 'shot-image'))) return 'assets/shot-image'; }
      catch { /* Fall back to the wordmark panel. */ }
      notes.push('the README image could not be downloaded');
    }
    return '';
  }

  // Renders <outBase>.mp4 and its final frame as <outBase>.png. Returns null for an unknown project.
  return async function renderMedia({ topic, outBase, draft = '', signal, report = () => {} }) {
    const project = findProject(loadProjects(projectsFile), topic);
    if (!project) return null;
    if (!existsSync(hyperframesBin)) throw new Error('HyperFrames is not installed. Run npm ci in the media folder.');
    const workDir = path.join(workRoot, randomUUID());
    const notes = [];
    try {
      await mkdir(workRoot, { recursive: true });
      await cp(templateDir, workDir, { recursive: true, filter: (source) => !source.includes(`${path.sep}.hyperframes`) && !source.includes(`${path.sep}renders`) });
      report(`Capturing ${project.name} for the post video.`);
      const shot = await screenshot(project, workDir, signal, notes);
      if (produce) {
        try {
          const images = shot ? { [shot.endsWith('shot.png') ? 'shot' : 'readme']: path.join(workDir, shot) } : {};
          const made = await produce({ project, images, outBase, workRoot: path.join(workDir, 'studio'), draft, signal, report });
          return { ...made, note: [made.note, notes.length ? `Pictures: ${notes.join(' and ')}.` : ''].filter(Boolean).join(' ') };
        } catch (error) {
          if (signal?.aborted) throw error;
          notes.push(`the studio failed (${String(error?.message ?? error).slice(0, 160)})`);
        }
      }
      const variablesFile = path.join(workDir, 'variables.json');
      await writeFile(variablesFile, JSON.stringify(compositionVariables(project, { author, shot })));

      const video = `${outBase}.mp4`;
      const image = `${outBase}.png`;
      report(`Rendering the ${project.name} video.`);
      const env = { HYPERFRAMES_NO_TELEMETRY: '1', HYPERFRAMES_NO_UPDATE_CHECK: '1', HYPERFRAMES_SKIP_SKILLS: '1', ...(browserPath ? { HYPERFRAMES_BROWSER_PATH: browserPath } : {}) };
      const rendered = await runProcess(spawn, process.execPath, [hyperframesBin, 'render', workDir, '--output', video, '--variables-file', variablesFile, '--quality', 'looks', '--fps', '30'],
        { signal, timeoutMs: renderTimeoutMs, env });
      if (rendered.code !== 0 || (await fileSize(video)) < 75 * 1024) {
        throw new Error(`Video render failed${rendered.output ? `: ${rendered.output.trim().split(/\r?\n/).slice(-2).join(' ').slice(0, 200)}` : '.'}`);
      }
      // The film ends on the finished poster, so its last frame is the still image.
      const poster = await runProcess(spawn, ffmpeg, ['-loglevel', 'error', '-y', '-sseof', '-0.1', '-i', video, '-frames:v', '1', image], { signal, timeoutMs: 60_000 });
      return {
        name: project.name,
        video,
        image: poster.code === 0 && (await fileSize(image)) > 0 ? image : null,
        note: notes.length ? `Used the plain layout because ${notes.join(' and ')}.` : '',
      };
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  };
}
