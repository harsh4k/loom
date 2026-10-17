import { createReadStream } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTOMATIONS, missingSetup } from './automations.mjs';
import { localDate } from './dates.mjs';
import { draftsFolder, getProfile } from './profile.mjs';

const LOOPBACK = '127.0.0.1';
const BODY_LIMIT = 1_024;
const DRAFT_LIMIT = 1_048_576;
const MEDIA_TYPES = { video: ['.mp4', 'video/mp4', 300 * 1024 * 1024], image: ['.png', 'image/png', 30 * 1024 * 1024] };
const RUN_LIMIT = 100;
const EVENT_LIMIT = 250;
const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json; charset=utf-8']],
  ['/icon-192.png', ['icon-192.png', 'image/png']],
  ['/icon-512.png', ['icon-512.png', 'image/png']],
  ['/favicon.ico', ['app.ico', 'image/x-icon']],
  ['/fonts/audiowide.woff2', ['fonts/audiowide.woff2', 'font/woff2']],
  ['/fonts/geo.woff2', ['fonts/geo.woff2', 'font/woff2']],
  ['/fonts/geo-italic.woff2', ['fonts/geo-italic.woff2', 'font/woff2']],
  ['/fonts/iceberg.woff2', ['fonts/iceberg.woff2', 'font/woff2']],
  ['/fonts/open-sans.woff2', ['fonts/open-sans.woff2', 'font/woff2']],
  ['/fonts/open-sans-italic.woff2', ['fonts/open-sans-italic.woff2', 'font/woff2']],
]);
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Referrer-Policy': 'no-referrer',
};

class HttpError extends Error {
  constructor(status, code, message, close = false) {
    super(message);
    this.status = status;
    this.code = code;
    this.close = close;
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8' });
}

function fail(res, error) {
  if (res.headersSent || res.destroyed) return;
  if (error instanceof HttpError && error.close) res.shouldKeepAlive = false;
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : 'INTERNAL_ERROR';
  const message = error instanceof HttpError ? error.message : 'The request could not be completed.';
  sendJson(res, status, { error: { code, message } });
}

function safeRecord(record, fields) {
  if (!record || typeof record !== 'object') return null;
  const result = {};
  for (const key of fields) {
    const value = record[key];
    if (typeof value === 'string') result[key] = value.slice(0, key === 'summary' ? 500 : 200);
    else if (key === 'id' && Number.isSafeInteger(value)) result[key] = value;
  }
  return result;
}

function snapshotOf(queue) {
  const current = queue.snapshot();
  return {
    paused: current.paused === true,
    activeRun: safeRecord(current.activeRun, ['runId', 'jobId', 'date', 'state', 'summary', 'createdAt', 'updatedAt']),
    queuedRuns: (Array.isArray(current.queuedRuns) ? current.queuedRuns : []).slice(0, RUN_LIMIT)
      .map((run) => safeRecord(run, ['runId', 'jobId', 'date', 'state', 'summary', 'createdAt', 'updatedAt'])).filter(Boolean),
    recentRuns: (Array.isArray(current.recentRuns) ? current.recentRuns : []).slice(0, RUN_LIMIT)
      .map((run) => safeRecord(run, ['runId', 'jobId', 'date', 'state', 'summary', 'createdAt', 'updatedAt'])).filter(Boolean),
    events: (Array.isArray(current.events) ? current.events : []).slice(-EVENT_LIMIT)
      .map((event) => safeRecord(event, ['id', 'runId', 'jobId', 'state', 'summary', 'createdAt'])).filter(Boolean),
  };
}

function checkOrigin(req, port) {
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${LOOPBACK}:${port}`) {
    throw new HttpError(403, 'FORBIDDEN', 'Request origin is not allowed.');
  }
}

function checkHost(req, port, pathname) {
  // LinkedIn app redirect URLs commonly use "localhost", so the sign-in callback accepts it too.
  if (pathname === '/linkedin/callback' && req.headers.host === `localhost:${port}`) return;
  if (req.headers.host !== `${LOOPBACK}:${port}`) {
    throw new HttpError(403, 'FORBIDDEN', 'Request host is not allowed.');
  }
}

function readBody(req) {
  const declaredLength = Number(req.headers['content-length'] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > BODY_LIMIT) {
    throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body is too large.', true);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        req.pause();
        reject(new HttpError(408, 'REQUEST_TIMEOUT', 'Request body timed out.', true));
      }
    }, 15_000);
    timer.unref?.();
    req.on('data', (chunk) => {
      length += chunk.length;
      if (length > BODY_LIMIT) {
        if (!settled) {
          settled = true;
          chunks.length = 0;
          reject(new HttpError(413, 'BODY_TOO_LARGE', 'Request body is too large.', true));
          req.resume();
        }
      } else if (!settled) chunks.push(chunk);
    });
    req.on('end', () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(error); }
    });
    req.on('aborted', () => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(new HttpError(400, 'BAD_REQUEST', 'Request body was interrupted.', true)); }
    });
  });
}

async function emptyBody(req) {
  const body = await readBody(req);
  if (body.length !== 0) throw new HttpError(400, 'INVALID_BODY', 'This action does not accept a request body.');
}

async function launchBody(req) {
  const body = await readBody(req);
  if (!body) return;
  const type = (req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json for a request body.');
  let value;
  try { value = JSON.parse(body); } catch { throw new HttpError(400, 'INVALID_JSON', 'Request body must be valid JSON.'); }
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length !== 0) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body must be an empty JSON object.');
  }
}

async function jsonBody(req) {
  const body = await readBody(req);
  const type = (req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json for a request body.');
  let value;
  try { value = JSON.parse(body); } catch { throw new HttpError(400, 'INVALID_JSON', 'Request body must be valid JSON.'); }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new HttpError(400, 'INVALID_BODY', 'Request body must be a JSON object.');
  return value;
}

function redirect(res, location) {
  send(res, 302, '', { Location: location });
}

async function handleLinkedIn(req, res, url, { linkedin, port }) {
  const pathname = url.pathname;
  if (!linkedin) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
  const home = `http://${LOOPBACK}:${port}/`;
  if (pathname === '/api/linkedin') {
    if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    sendJson(res, 200, linkedin.status());
    return;
  }
  if (pathname === '/api/linkedin/app' || pathname === '/api/linkedin/disconnect') {
    if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    checkOrigin(req, port);
    if (pathname === '/api/linkedin/app') {
      const { clientId, clientSecret } = await jsonBody(req);
      try { await linkedin.saveApp({ clientId: String(clientId ?? '').trim(), clientSecret: String(clientSecret ?? '').trim() }); }
      catch (error) {
        if (error instanceof RangeError) throw new HttpError(400, 'INVALID_CREDENTIALS', error.message);
        throw error;
      }
    } else {
      await emptyBody(req);
      await linkedin.disconnect();
    }
    sendJson(res, 200, linkedin.status());
    return;
  }
  if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  if (pathname === '/linkedin/connect') {
    try { redirect(res, linkedin.startConnect()); }
    catch (error) {
      if (error instanceof RangeError) { redirect(res, `${home}?linkedin=${encodeURIComponent(error.message)}`); return; }
      throw error;
    }
    return;
  }
  // LinkedIn returns the browser here after sign-in.
  const denied = url.searchParams.get('error_description') || url.searchParams.get('error');
  if (denied) { redirect(res, `${home}?linkedin=${encodeURIComponent(`LinkedIn sign-in didn’t finish: ${decodeEntities(denied).slice(0, 200)}`)}`); return; }
  try {
    await linkedin.finishConnect({ code: url.searchParams.get('code'), state: url.searchParams.get('state') ?? '' });
    redirect(res, `${home}?linkedin=connected`);
  } catch (error) {
    redirect(res, `${home}?linkedin=${encodeURIComponent((error?.message ?? 'Sign-in failed.').slice(0, 300))}`);
  }
}

// Routes for the parts of the hub beyond a single job: on/off switches, app keys, the change
// log and health. `hub` is optional so the server still runs with only a store and a queue.
async function handleHub(req, res, pathname, { hub, port }) {
  const toggle = /^\/api\/automations\/([^/]+)\/enabled$/.exec(pathname);
  if (toggle) {
    if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    checkOrigin(req, port);
    const id = toggle[1];
    if (!AUTOMATIONS.some((item) => item.id === id && item.status === 'active')) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
    const { enabled } = await jsonBody(req);
    if (typeof enabled !== 'boolean') throw new HttpError(400, 'INVALID_BODY', 'enabled must be true or false.');
    await hub.settings.setEnabled(id, enabled);
    sendJson(res, 200, { id, enabled: hub.settings.isEnabled(id) });
    return true;
  }
  if (pathname === '/api/connections') {
    if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    sendJson(res, 200, hub.connections.status());
    return true;
  }
  const connection = /^\/api\/connections\/(notion|github)(\/disconnect)?$/.exec(pathname);
  if (connection) {
    if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    checkOrigin(req, port);
    if (connection[2]) {
      await emptyBody(req);
      sendJson(res, 200, await hub.connections.disconnect(connection[1]));
      return true;
    }
    const { token } = await jsonBody(req);
    try { sendJson(res, 200, await hub.connections.save(connection[1], token)); }
    catch (error) {
      if (error instanceof RangeError) throw new HttpError(400, 'INVALID_KEY', error.message);
      throw new HttpError(502, 'CHECK_FAILED', (error?.message ?? 'The key could not be checked.').slice(0, 300));
    }
    return true;
  }
  if (pathname === '/api/changes') {
    if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    sendJson(res, 200, { changes: hub.ledger.list().map((change) => ({ ...change, undoable: change.state === 'applied' && typeof hub.undo?.[change.target] === 'function' })) });
    return true;
  }
  const undo = /^\/api\/changes\/(\d{1,12})\/undo$/.exec(pathname);
  if (undo) {
    if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    checkOrigin(req, port);
    await emptyBody(req);
    const change = hub.ledger.get(Number(undo[1]));
    if (!change) throw new HttpError(404, 'NOT_FOUND', 'Change not found.');
    const undoer = hub.undo?.[change.target];
    if (change.state !== 'applied' || typeof undoer !== 'function') throw new HttpError(409, 'NOT_UNDOABLE', 'This change can’t be undone.');
    try { await undoer(change); }
    catch (error) { throw new HttpError(502, 'UNDO_FAILED', `Undo didn’t work: ${(error?.message ?? 'unexpected error').slice(0, 250)}`); }
    sendJson(res, 200, { change: hub.ledger.undone(change.id) });
    return true;
  }
  if (pathname === '/api/health') {
    if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    sendJson(res, 200, await hub.health());
    return true;
  }
  return false;
}

// LinkedIn HTML-escapes its error text (for example &quot;openid&quot;); the page shows it as plain text.
export function decodeEntities(text) {
  const named = { quot: '"', apos: "'", amp: '&', lt: '<', gt: '>' };
  return String(text).replace(/&(#\d+|#x[\da-f]+|quot|apos|amp|lt|gt);/gi, (match, code) => {
    const key = code.toLowerCase();
    if (key in named) return named[key];
    const value = key.startsWith('#x') ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    return Number.isInteger(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : match;
  });
}

function safeId(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value);
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// Resolves a run's saved file (the draft, or its rendered media beside it) inside the drafts root.
async function runFile(store, runId, draftsRoot, extension, limit) {
  const saved = store.getSnapshot();
  if (!saved.runs.some((run) => run.runId === runId && run.jobId === 'linkedin-draft')) return null;
  const artifactPath = [...saved.events].reverse().find((event) => event.runId === runId && typeof event.artifactPath === 'string' && event.artifactPath)?.artifactPath;
  if (!artifactPath || path.extname(artifactPath).toLowerCase() !== '.md') return null;
  try {
    const canonicalRoot = await realpath(draftsRoot);
    const canonicalFile = await realpath(`${artifactPath.slice(0, -3)}${extension}`);
    if (!isWithin(canonicalRoot, canonicalFile)) return null;
    const info = await stat(canonicalFile);
    if (!info.isFile() || info.size > limit) return null;
    return { file: canonicalFile, size: info.size };
  } catch { return null; }
}

async function readDraft(store, runId, draftsRoot) {
  const found = await runFile(store, runId, draftsRoot, '.md', DRAFT_LIMIT);
  try { return found ? await readFile(found.file) : null; } catch { return null; }
}

// Streams a media file, honouring one byte range so the dashboard's video can seek.
function sendMedia(req, res, { file, size }, type) {
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  let start = 0;
  let end = size - 1;
  let status = 200;
  if (range && (range[1] || range[2])) {
    start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      send(res, 416, '', { 'Content-Range': `bytes */${size}` });
      return;
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers, 'Content-Length': String(end - start + 1) });
  if (req.method === 'HEAD') { res.end(); return; }
  const stream = createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

async function handle(req, res, { store, queue, draftsRoot, port, linkedin, hub }) {
  let url;
  try { url = new URL(req.url, `http://${LOOPBACK}`); } catch { throw new HttpError(400, 'BAD_REQUEST', 'Request URL is invalid.'); }
  const pathname = url.pathname;
  checkHost(req, port, pathname);
  if (pathname === '/api/linkedin' || pathname.startsWith('/api/linkedin/') || pathname === '/linkedin/connect' || pathname === '/linkedin/callback') {
    await handleLinkedIn(req, res, url, { linkedin, port });
    return;
  }
  if (hub && await handleHub(req, res, pathname, { hub, port })) return;
  const jobIds = hub?.jobIds ?? AUTOMATIONS.filter((item) => item.status === 'active').map((item) => item.id);
  const routeMethods = new Map([
    ['/api/snapshot', 'GET'], ['/api/automations', 'GET'],
    ...jobIds.map((id) => [`/api/jobs/${id}`, 'POST']),
    ['/api/pause', 'POST'], ['/api/resume', 'POST'],
  ]);
  const mediaMatch = /^\/api\/drafts\/([^/]+)\/(video|image)$/.exec(pathname);
  if (mediaMatch) {
    let decoded;
    try { decoded = decodeURIComponent(mediaMatch[1]); } catch { throw new HttpError(404, 'NOT_FOUND', 'Not found.'); }
    if (!safeId(decoded) || decoded.includes('/')) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    const [extension, type, limit] = MEDIA_TYPES[mediaMatch[2]];
    const found = await runFile(store, decoded, draftsRoot, extension, limit);
    if (!found) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
    sendMedia(req, res, found, type);
    return;
  }
  const stopMatch = /^\/api\/runs\/([^/]+)\/stop$/.exec(pathname);
  const draftMatch = /^\/api\/drafts\/([^/]+)$/.exec(pathname);
  if (stopMatch || draftMatch) {
    const id = (stopMatch ?? draftMatch)[1];
    let decoded;
    try { decoded = decodeURIComponent(id); } catch { throw new HttpError(404, 'NOT_FOUND', 'Not found.'); }
    if (!safeId(decoded) || decoded.includes('/')) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
    if (req.method !== (stopMatch ? 'POST' : 'GET')) throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    if (stopMatch) {
      checkOrigin(req, port);
      await emptyBody(req);
      const state = queue.snapshot();
      const known = state.activeRun?.runId === decoded || state.queuedRuns.some((run) => run.runId === decoded)
        || state.recentRuns.some((run) => run.runId === decoded)
        || store.getSnapshot().runs.some((run) => run.runId === decoded);
      if (!known) throw new HttpError(404, 'NOT_FOUND', 'Run not found.');
      if (state.activeRun?.runId !== decoded) throw new HttpError(409, 'RUN_NOT_ACTIVE', 'Run is not active.');
      if (!queue.stop(decoded)) throw new HttpError(409, 'RUN_NOT_ACTIVE', 'Run is not active.');
      sendJson(res, 202, { runId: decoded, stopping: true });
      return;
    }
    const content = await readDraft(store, decoded, draftsRoot);
    if (!content) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
    send(res, 200, content, { 'Content-Type': 'text/markdown; charset=utf-8' });
    return;
  }
  if (routeMethods.has(pathname)) {
    if (req.method !== routeMethods.get(pathname)) throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    if (pathname === '/api/snapshot') {
      const retries = typeof hub?.retries === 'function' ? hub.retries() : [];
      sendJson(res, 200, {
        ...snapshotOf(queue),
        retries: retries.slice(0, RUN_LIMIT).map((retry) => ({ runId: String(retry.runId), jobId: String(retry.jobId), dueAt: new Date(retry.dueAt).toISOString() })),
      });
      return;
    }
    if (pathname === '/api/automations') {
      sendJson(res, 200, {
        automations: AUTOMATIONS.map((item) => ({ ...item, enabled: hub?.settings ? hub.settings.isEnabled(item.id) : true, setupNeeded: missingSetup(item) })),
        timeZone: getProfile().timeZone,
      });
      return;
    }
    checkOrigin(req, port);
    if (pathname.startsWith('/api/jobs/')) {
      await launchBody(req);
      const missing = missingSetup(AUTOMATIONS.find((item) => item.id === pathname.slice('/api/jobs/'.length)));
      if (missing.length) throw new HttpError(409, 'SETUP_NEEDED', `Set ${missing.join(', ')} in config/profile.json first.`);
      try {
        const run = queue.enqueue(pathname.slice('/api/jobs/'.length), localDate());
        sendJson(res, 202, { runId: run.runId });
      } catch (error) {
        if (error?.code === 'ERR_DUPLICATE_RUN') throw new HttpError(409, 'DUPLICATE_RUN', 'This automation already ran today.');
        throw error;
      }
      return;
    }
    await emptyBody(req);
    if (pathname === '/api/pause') queue.pause();
    else queue.resume();
    sendJson(res, 200, snapshotOf(queue));
    return;
  }
  const asset = PUBLIC_FILES.get(pathname);
  if (asset) {
    if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    try {
      const content = await readFile(path.join(SOURCE_DIR, 'public', asset[0]));
      send(res, 200, content, { 'Content-Type': asset[1] });
    } catch { throw new HttpError(404, 'NOT_FOUND', 'Not found.'); }
    return;
  }
  throw new HttpError(404, 'NOT_FOUND', 'Not found.');
}

export async function createServer({ store, queue, host = LOOPBACK, port = 0, draftsRoot = draftsFolder(), linkedin = null, hub = null } = {}) {
  if (host !== LOOPBACK) throw new TypeError(`Server host must be ${LOOPBACK}.`);
  if (!store || typeof store.getSnapshot !== 'function') throw new TypeError('store is required.');
  if (!queue || typeof queue.snapshot !== 'function') throw new TypeError('queue is required.');
  if (typeof draftsRoot !== 'string' || draftsRoot.length === 0) throw new TypeError('draftsRoot must be a path.');
  const server = createHttpServer((req, res) => {
    const boundPort = server.address()?.port ?? port;
    void handle(req, res, { store, queue, draftsRoot, port: boundPort, linkedin, hub }).catch((error) => fail(res, error));
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, LOOPBACK, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  return {
    server,
    address,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void import('./bootstrap.mjs')
    .then(({ runHub }) => runHub())
    .catch((error) => {
      console.error(`Automation hub failed to start: ${error?.message ?? 'Unexpected error.'}`);
      process.exitCode = 1;
    });
}
