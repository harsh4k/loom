// Keys for the apps the hub writes to (Notion, GitHub), kept in data/connections.json, which
// only the current Windows user can read. Keys never leave this module except to the job that
// calls token(); status() reports only whether each one works.
import { readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';

export const NOTION_VERSION = '2022-06-28';

// How to check each key and read a display name from the answer.
const PROVIDERS = {
  notion: {
    check: (token) => ({ url: 'https://api.notion.com/v1/users/me', headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION } }),
    name: (body) => body?.bot?.workspace_name || body?.name || 'Notion',
  },
  github: {
    check: (token) => ({ url: 'https://api.github.com/user', headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'automation-hub' } }),
    name: (body) => body?.login || 'GitHub',
  },
};
export const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS));

const TOKEN_PATTERN = /^[A-Za-z0-9_\-.]{20,200}$/;

export function createConnections({ file, fetch: fetchImpl = fetch, now = () => new Date() }) {
  let saved = {};
  // Read again before every use, because a scheduled job and the dashboard each hold their own copy.
  function load() {
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'));
      saved = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { saved = {}; }
  }
  load();

  async function persist() {
    const temp = `${file}.tmp`;
    await writeFile(temp, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, file);
  }

  function known(provider) {
    if (!Object.hasOwn(PROVIDERS, provider)) throw new RangeError('Unknown connection.');
    return PROVIDERS[provider];
  }

  async function save(provider, rawToken) {
    const spec = known(provider);
    const token = String(rawToken ?? '').trim();
    if (!TOKEN_PATTERN.test(token)) throw new RangeError('That doesn’t look like a valid key. Paste the whole key.');
    const { url, headers } = spec.check(token);
    let response;
    try { response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) }); }
    catch { throw new Error('Couldn’t reach the service to check the key. Check the internet connection and try again.'); }
    if (response.status === 401 || response.status === 403) throw new RangeError('The key was refused. Check that you copied the whole key.');
    if (!response.ok) throw new Error(`The service answered with an error (${response.status}). Try again in a minute.`);
    let body = null;
    try { body = await response.json(); } catch { /* A name is optional. */ }
    load();
    saved[provider] = { token, name: String(spec.name(body)).slice(0, 100), connectedAt: now().toISOString(), problem: null };
    await persist();
    return status();
  }

  async function disconnect(provider) {
    known(provider);
    load();
    delete saved[provider];
    await persist();
    return status();
  }

  // A job calls this when the key stops working, so the dashboard can say so.
  async function reportProblem(provider, message) {
    known(provider);
    load();
    if (!saved[provider]) return;
    saved[provider].problem = String(message).slice(0, 300);
    await persist();
  }

  function status() {
    load();
    return Object.fromEntries(PROVIDER_IDS.map((provider) => {
      const entry = saved[provider];
      return [provider, entry?.token
        ? { connected: true, name: entry.name ?? '', connectedAt: entry.connectedAt ?? null, problem: entry.problem ?? null }
        : { connected: false }];
    }));
  }

  return {
    save,
    disconnect,
    reportProblem,
    status,
    token: (provider) => { known(provider); load(); return saved[provider]?.token ?? null; },
  };
}
