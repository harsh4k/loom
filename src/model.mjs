// Asks the local Qwen model on Ollama for JSON that matches a schema. Nothing here calls a paid API.
import { RetryableError } from './errors.mjs';
import { OLLAMA_URL } from './ollama.mjs';

export const MODEL = 'qwen3.5:9b-q4_K_M';

export function createModel({ url = OLLAMA_URL, model = MODEL, fetch: fetchImpl = fetch, timeoutMs = 5 * 60 * 1000 } = {}) {
  return async function askJson({ system, prompt, schema, signal }) {
    const limit = AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, stream: false, think: false, format: schema,
          options: { temperature: 0.2, num_ctx: 8192 },
          messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
        }),
        signal: signal ? AbortSignal.any([signal, limit]) : limit,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new RetryableError(limit.aborted ? 'Qwen took too long to answer.' : 'Couldn’t reach Ollama.');
    }
    if (!response.ok) {
      if (response.status >= 500) throw new RetryableError(`Ollama answered ${response.status}.`);
      throw new Error(`Ollama answered ${response.status}. Is the model ${model} installed?`);
    }
    const body = await response.json();
    try { return JSON.parse(body?.message?.content ?? ''); } catch { return null; }
  };
}
