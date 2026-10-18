// JSON-over-stdin adapter shared by the hidden PowerShell runner and isolated benchmarks.
import { readFile } from 'node:fs/promises';
import { prepareCopy, validateCopy } from '../src/copy/pipeline.mjs';
import { parseDraft } from '../src/linkedin/publish.mjs';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
try {
  const request = JSON.parse(raw.replace(/^\uFEFF/, ''));
  let result;
  if (request.action === 'prepare') {
    const parse = (entry) => { try { return parseDraft(entry.markdown).post; } catch { return ''; } };
    let history;
    if (process.env.LOOM_COPY_HISTORY) history = JSON.parse(await readFile(process.env.LOOM_COPY_HISTORY, 'utf8'));
    else history = (request.history ?? []).map(parse).filter(Boolean);
    const storyBank = process.env.LOOM_COPY_STORY ? await readFile(process.env.LOOM_COPY_STORY, 'utf8') : request.storyBank;
    result = { ...prepareCopy({ ...request, storyBank, history }), history };
  } else if (request.action === 'validate') {
    result = validateCopy(request);
  } else throw new Error('Unknown copy-stage action.');
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
