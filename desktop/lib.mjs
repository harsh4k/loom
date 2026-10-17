// Small pure helpers for the desktop app, kept apart from Electron so tests can import them.
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const HUB_ORIGIN = 'http://127.0.0.1:4173';
export const HUB_URL = `${HUB_ORIGIN}/`;

export function parse(url) {
  try { return new URL(url); } catch { return null; }
}

// Pages the app window may show itself: only the hub's own dashboard.
export function isHubUrl(url) {
  return parse(url)?.origin === HUB_ORIGIN;
}

// Links that leave the hub (GitHub, Notion, LinkedIn sign-in) open in the default browser.
export function isSafeExternal(url) {
  const parsed = parse(url);
  return Boolean(parsed) && (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !isHubUrl(url);
}

// Hub pages that hand off to an outside sign-in. They open in the default browser, where the
// person is already signed in to LinkedIn, so the sign-in never runs inside the Loom window.
const BROWSER_PATHS = new Set(['/linkedin/connect']);
export function opensInBrowser(url) {
  const parsed = parse(url);
  if (!parsed) return false;
  return isHubUrl(url) ? BROWSER_PATHS.has(parsed.pathname) : isSafeExternal(url);
}

// Where the hub's source lives. The installer records it at build time; HUB_ROOT overrides it.
export function readHubRoot(appDir, env = process.env) {
  if (env.HUB_ROOT) return path.resolve(env.HUB_ROOT);
  try {
    const { root } = JSON.parse(readFileSync(path.join(appDir, 'hub-root.json'), 'utf8'));
    if (typeof root === 'string' && root) return root;
  } catch { /* fall through */ }
  return path.resolve(appDir, '..');
}

// Failed runs that finished after `since` and haven't been announced yet.
export function newFailures(runs, seen, since) {
  const fresh = [];
  for (const run of Array.isArray(runs) ? runs : []) {
    if (run?.state !== 'failed' || seen.has(run.runId)) continue;
    const at = Date.parse(run.updatedAt ?? run.createdAt ?? '');
    seen.add(run.runId);
    if (Number.isFinite(at) && at >= since) fresh.push(run);
  }
  return fresh;
}

// Keep a saved window size only if it is sane, so a bad file never opens an unusable window.
export function windowBounds(saved) {
  const base = { width: 1280, height: 840 };
  if (!saved || typeof saved !== 'object') return base;
  const width = Number(saved.width);
  const height = Number(saved.height);
  if (!(width >= 900 && width <= 8000 && height >= 600 && height <= 8000)) return base;
  const out = { width: Math.round(width), height: Math.round(height) };
  if (Number.isInteger(saved.x) && Number.isInteger(saved.y)) Object.assign(out, { x: saved.x, y: saved.y });
  return out;
}

// Ollama's command-line server (not "ollama app.exe", which opens a window), per-user install on Windows.
export function ollamaAppPath(env = process.env) {
  return env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe') : null;
}

// The model the hub's jobs use (src/model.mjs). Loom loads it on open so the first run doesn't wait.
export const OLLAMA_URL = 'http://127.0.0.1:11434';
export const MODEL = 'qwen3.5:9b-q4_K_M';
export const MODEL_KEEP_ALIVE = '1h';
