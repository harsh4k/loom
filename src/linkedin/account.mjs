// Stores the LinkedIn app credentials and member token in the hub's private data folder.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { authorizationUrl, exchangeCode, getMember } from './api.mjs';

const STATE_TTL_MS = 10 * 60 * 1000;
const EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1000;
const CLIENT_ID = /^[A-Za-z0-9]{8,64}$/;
const CLIENT_SECRET = /^[A-Za-z0-9._~=+/-]{8,256}$/;

export function createLinkedInAccount({ file, redirectUri, fetch: fetchImpl = fetch, now = () => Date.now() }) {
  const pending = new Map();

  function load() {
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'));
      return value && typeof value === 'object' ? value : {};
    } catch { return {}; }
  }
  async function save(value) {
    const temporary = `${file}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(temporary, file);
  }

  function status() {
    const saved = load();
    const configured = Boolean(saved.clientId && saved.clientSecret);
    const expiresAt = saved.token?.expiresAt ?? null;
    const remaining = expiresAt ? Date.parse(expiresAt) - now() : -1;
    const connected = configured && Boolean(saved.token?.accessToken) && remaining > 0;
    return {
      configured,
      connected,
      name: connected ? (saved.member?.name ?? '') : '',
      expiresAt: connected ? expiresAt : null,
      expiresSoon: connected && remaining < EXPIRY_WARNING_MS,
      redirectUri,
    };
  }

  async function saveApp({ clientId, clientSecret }) {
    if (!CLIENT_ID.test(clientId ?? '') || !CLIENT_SECRET.test(clientSecret ?? '')) {
      throw new RangeError('Client ID or client secret does not look like a LinkedIn app credential.');
    }
    const saved = load();
    const changed = saved.clientId !== clientId;
    await save({ clientId, clientSecret, ...(changed ? {} : { token: saved.token, member: saved.member }) });
  }

  function startConnect() {
    const saved = load();
    if (!saved.clientId || !saved.clientSecret) throw new RangeError('Add your LinkedIn app credentials first.');
    for (const [key, expires] of pending) if (expires < now()) pending.delete(key);
    const state = randomBytes(24).toString('hex');
    pending.set(state, now() + STATE_TTL_MS);
    return authorizationUrl({ clientId: saved.clientId, redirectUri, state });
  }

  async function finishConnect({ code, state }) {
    const expires = pending.get(state);
    pending.delete(state);
    if (!expires || expires < now()) throw new RangeError('This sign-in link expired. Start again from the dashboard.');
    if (typeof code !== 'string' || !code) throw new RangeError('LinkedIn did not return a sign-in code.');
    const saved = load();
    const token = await exchangeCode({ clientId: saved.clientId, clientSecret: saved.clientSecret, code, redirectUri, fetch: fetchImpl, now: now() });
    if (!token.scope.split(/[\s,]+/).includes('w_member_social')) {
      throw new RangeError('LinkedIn did not grant posting permission. Add the "Share on LinkedIn" product to your app and try again.');
    }
    const member = await getMember({ accessToken: token.accessToken, fetch: fetchImpl });
    await save({ ...saved, token: { accessToken: token.accessToken, expiresAt: token.expiresAt }, member });
    return status();
  }

  async function disconnect() {
    const saved = load();
    await save({ clientId: saved.clientId, clientSecret: saved.clientSecret });
  }

  // Only what posting needs; null when not connected or the token has expired.
  function credentials() {
    if (!status().connected) return null;
    const saved = load();
    return { accessToken: saved.token.accessToken, personUrn: saved.member.personUrn };
  }

  return { status, saveApp, startConnect, finishConnect, disconnect, credentials };
}
