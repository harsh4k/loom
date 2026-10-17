// A small JSON client shared by the GitHub and Notion readers. It waits and tries again on rate
// limits and server errors, and turns every other failure into an error a person can read.
import { RetryableError } from './errors.mjs';

const delay = (milliseconds, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, milliseconds);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? new Error('Stopped.')); }, { once: true });
});

export class HttpStatusError extends Error {
  constructor(service, status, message) {
    super(message);
    this.name = 'HttpStatusError';
    this.status = status;
    this.service = service;
  }
}

export function createJsonClient({ service, base, headers = {}, fetch: fetchImpl = fetch, attempts = 3, maxWaitMs = 30_000 }) {
  return async function request(method, route, { body, signal, raw = false, allow404 = false } = {}) {
    for (let attempt = 1; ; attempt++) {
      let response;
      try {
        response = await fetchImpl(route.startsWith('https://') ? route : `${base}${route}`, {
          method,
          headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        if (attempt < attempts) { await delay(1_000 * attempt, signal); continue; }
        throw new RetryableError(`Couldn’t reach ${service}. Check the internet connection.`);
      }
      if (response.status === 404 && allow404) return null;
      if (response.ok) return raw ? response.text() : response.json();
      const busy = response.status === 429 || response.status >= 500
        || (response.status === 403 && response.headers?.get?.('x-ratelimit-remaining') === '0');
      if (busy) {
        const wait = Math.min(maxWaitMs, Number(response.headers?.get?.('retry-after')) * 1_000 || 2_000 * attempt);
        if (attempt < attempts && wait <= maxWaitMs) { await delay(wait, signal); continue; }
        throw new RetryableError(`${service} is busy or rate-limited right now (${response.status}).`);
      }
      let detail = '';
      try { detail = String((await response.json())?.message ?? '').slice(0, 200); } catch { /* No detail. */ }
      throw new HttpStatusError(service, response.status, `${service} answered ${response.status}${detail ? `: ${detail}` : '.'}`);
    }
  };
}
