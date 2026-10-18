import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Local benchmark logs preserve malformed content that createModel otherwise returns as null.
export function createTracedFetch({ directory, fetch: fetchImpl = fetch }) {
  let sequence = 0;
  return async (url, init) => {
    const number = ++sequence;
    const response = await fetchImpl(url, init);
    const raw = await response.clone().text();
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${String(number).padStart(4, '0')}.json`), JSON.stringify({ request: JSON.parse(init.body), status: response.status, response: raw }, null, 2), { mode: 0o600 });
    return response;
  };
}
