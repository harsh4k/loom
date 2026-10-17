import { spawn as systemSpawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { draftsFolder } from '../profile.mjs';

const MODEL = 'qwen3.5:9b-q4_K_M';
const RUNNER_PATH = path.resolve(import.meta.dirname, '../../scripts/linkedin-local-draft.ps1');
const OUTPUT_LIMIT = 64 * 1024;
const RUN_TIMEOUT_MS = 15 * 60 * 1000;
const KILL_TIMEOUT_MS = 10 * 1000;

export class ChildExitUnconfirmedError extends Error {
  constructor() {
    super('PowerShell termination could not be confirmed; the job lease must remain held.');
    this.name = 'ChildExitUnconfirmedError';
    this.code = 'ERR_CHILD_EXIT_UNCONFIRMED';
  }
}

function call(callback, ...args) {
  try { return callback?.(...args) !== false; } catch { return false; }
}

function watchChild(child, onChildExited) {
  let closed = false;
  let exitResult;
  let resolveClose;
  let rejectClose;
  const completion = new Promise((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
  const finish = (result, pid) => {
    if (closed) return;
    closed = true;
    exitResult = result;
    if (!call(onChildExited, pid)) rejectClose(new ChildExitUnconfirmedError());
    else resolveClose(result);
  };
  child.once('error', (error) => {
    if (child.pid === undefined) finish({ error, code: null }, null);
  });
  child.once('close', (code, signal) => finish({ code, signal }, child.pid ?? null));
  return { completion, get closed() { return closed; }, get exitResult() { return exitResult; } };
}

function waitFor(promise, milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), milliseconds);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(null); });
  });
}

async function killTree(spawn, pid, timeoutMs) {
  let process;
  try {
    process = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } catch { return false; }
  const close = await waitFor(new Promise((resolve) => {
    process.once('close', (code) => resolve(code));
    process.once('error', () => resolve(null));
  }), timeoutMs);
  return close === 0;
}

function collect(stream, target, size) {
  if (!stream) return;
  stream.on('data', (chunk) => {
    size.value += chunk.length;
    if (size.value <= OUTPUT_LIMIT) target.value += chunk.toString('utf8');
    else size.overflow = true;
  });
}

async function canonicalArtifact(rawPath, draftsRoot, date) {
  let root;
  let candidate;
  try {
    root = await realpath(draftsRoot);
    candidate = await realpath(rawPath);
  } catch {
    throw new Error('Draft artifact could not be resolved.');
  }
  const relative = path.relative(root, candidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Draft artifact is outside the LinkedIn drafts folder.');
  }
  if (path.extname(candidate).toLowerCase() !== '.md' || !path.basename(candidate).startsWith(`${date}-`)) {
    throw new Error('Draft artifact does not match the scheduled date and Markdown format.');
  }
  if (!(await stat(candidate)).isFile()) throw new Error('Draft artifact is not a regular file.');
  return candidate;
}

function abortError(kind) {
  const error = new Error(kind === 'timeout' ? 'LinkedIn draft runner timed out.' : 'LinkedIn draft run was cancelled.');
  error.name = kind === 'timeout' ? 'TimeoutError' : 'AbortError';
  error.code = kind === 'timeout' ? 'ERR_RUNNER_TIMEOUT' : 'ABORT_ERR';
  return error;
}

export function createLinkedInDraftJob({
  draftsRoot = draftsFolder(),
  runnerPath = RUNNER_PATH,
  spawn = systemSpawn,
  timeoutMs = RUN_TIMEOUT_MS,
  killTimeoutMs = KILL_TIMEOUT_MS,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new RangeError('timeoutMs must be positive');
  if (!Number.isSafeInteger(killTimeoutMs) || killTimeoutMs < 1) throw new RangeError('killTimeoutMs must be positive');
  return {
    async run({ date, signal, onChildStarting, onChildStarted, onChildExited }) {
      if (signal?.aborted) throw abortError('cancelled');
      if (!call(onChildStarting)) throw new ChildExitUnconfirmedError();

      let child;
      try {
        child = spawn('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runnerPath, '-Model', MODEL,
        ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        if (!call(onChildExited, null)) throw new ChildExitUnconfirmedError();
        throw new Error('Could not start the LinkedIn draft runner.');
      }

      const stdout = { value: '', overflow: false };
      const stderr = { value: '', overflow: false };
      const bytes = { value: 0, overflow: false };
      collect(child.stdout, stdout, bytes);
      collect(child.stderr, stderr, bytes);
      const watched = watchChild(child, onChildExited);
      if (!Number.isSafeInteger(child.pid) || child.pid <= 0 || !call(onChildStarted, child.pid)) {
        if (Number.isSafeInteger(child.pid) && child.pid > 0 && !watched.closed) await killTree(spawn, child.pid);
        const exited = watched.closed || await waitFor(watched.completion, KILL_TIMEOUT_MS);
        if (!exited) throw new ChildExitUnconfirmedError();
        throw new Error('Could not record the LinkedIn draft runner process.');
      }

      let timer;
      let abortListener;
      const interrupted = new Promise((resolve) => {
        abortListener = () => resolve({ kind: 'cancelled' });
        if (signal?.aborted) abortListener();
        else signal?.addEventListener('abort', abortListener, { once: true });
        timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
      });
      const outcome = await Promise.race([
        watched.completion.then((result) => ({ kind: 'exit', result }), (error) => ({ kind: 'error', error })),
        interrupted,
      ]);
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortListener);

      if (outcome.kind === 'error') throw outcome.error;
      if (outcome.kind !== 'exit') {
        let confirmed = watched.closed;
        if (!confirmed && Number.isSafeInteger(child.pid)) {
          const killed = await killTree(spawn, child.pid, killTimeoutMs);
          const exit = await waitFor(watched.completion, killTimeoutMs);
          confirmed = Boolean(exit) && (killed || watched.closed);
        }
        if (!confirmed) throw new ChildExitUnconfirmedError();
        throw abortError(outcome.kind);
      }

      const { result } = outcome;
      if (result.error) throw new Error('Could not start the LinkedIn draft runner.');
      if (result.code !== 0) throw new Error(`LinkedIn draft runner exited with code ${result.code ?? 'unknown'}.`);
      if (bytes.overflow) throw new Error('LinkedIn draft runner output exceeded the safe limit.');
      const lines = stdout.value.split(/\r?\n/).map((line) => line.trim());
      if (lines.includes(`A draft already exists for ${date}. Skipping.`)) {
        return { summary: `A draft already exists for ${date}; no new draft was generated.`, artifactPath: null };
      }
      const written = lines.find((line) => line.startsWith('Wrote draft: '));
      if (!written) throw new Error('LinkedIn draft runner returned no recognized result.');
      const artifactPath = await canonicalArtifact(written.slice('Wrote draft: '.length).trim(), draftsRoot, date);
      return { summary: 'Draft saved for review; it was not published.', artifactPath };
    },
  };
}
