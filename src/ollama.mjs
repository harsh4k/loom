// Makes sure the local Ollama server is answering before a job that needs the model starts.
// Ollama is often not running on this PC, which used to fail the whole day's run.
import { spawn as spawnProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { RetryableError } from './errors.mjs';

export const OLLAMA_URL = 'http://127.0.0.1:11434';
// The command-line server, not "ollama app.exe": it runs hidden and opens no window.
const DEFAULT_APP = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe')
  : null;

// How Ollama is started on Windows. Started straight from Node (detached), ollama.exe has no
// console, so every model runner it starts (llama-server, one per model load) opens a new terminal
// window. Start-Process -WindowStyle Hidden gives it its own hidden console that the runners share,
// and it outlives whoever started it. The path travels in an environment variable, not the script.
export function hiddenLaunch(app) {
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', "Start-Process -FilePath $env:LOOM_OLLAMA_EXE -ArgumentList 'serve' -WindowStyle Hidden"],
    options: { stdio: 'ignore', windowsHide: true, env: { ...process.env, LOOM_OLLAMA_EXE: app } },
  };
}

const delay = (milliseconds, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, milliseconds);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? new Error('Stopped.')); }, { once: true });
});

export function createOllamaKeeper({
  url = OLLAMA_URL,
  app = DEFAULT_APP,
  fetch: fetchImpl = fetch,
  spawn = spawnProcess,
  exists = existsSync,
  waitMs = 60_000,
  pollMs = 1_000,
} = {}) {
  async function isUp() {
    try {
      const response = await fetchImpl(`${url}/api/version`, { signal: AbortSignal.timeout(3_000) });
      return response.ok;
    } catch { return false; }
  }

  function launch() {
    if (!app || !exists(app)) return false;
    const { command, args, options } = hiddenLaunch(app);
    const child = spawn(command, args, options);
    child.on?.('error', () => {});
    child.unref?.();
    return true;
  }

  // Resolves once Ollama answers; throws a RetryableError if it can't be started in time.
  async function ensure({ signal, report = () => {} } = {}) {
    if (await isUp()) return { started: false };
    report('Starting Ollama.');
    if (!launch()) throw new RetryableError('Ollama isn’t running and its app wasn’t found to start it.');
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await delay(pollMs, signal);
      if (await isUp()) return { started: true };
    }
    throw new RetryableError(`Ollama didn’t start within ${Math.round(waitMs / 1000)} seconds.`);
  }

  return { isUp, ensure };
}
