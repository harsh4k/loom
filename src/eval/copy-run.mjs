import { scoreEntries } from './copy-bench.mjs';

// Each arm owns its history. Only accepted outputs affect later prompts/checks in that arm.
export async function evaluateGenerated({ topics, runs, generate, brand, storyBank, history = [], avoid = [], onEntry = async () => {} }) {
  const accepted = [...history];
  const results = [];
  for (const topic of topics) {
    for (let run = 1; run <= runs; run += 1) {
      const label = `${topic} #${run}`;
      let entry;
      try {
        const made = await generate({ topic, run, history: [...accepted] });
        [entry] = scoreEntries({ entries: [{ ...made, label }], brand, storyBank, history: accepted, avoid, topics });
        if (!entry.error && Object.values(entry.checks).some((check) => !check.pass)) entry.error = 'Generated draft failed shared quality checks.';
        if (!entry.error) accepted.push(entry.post);
      } catch (error) {
        entry = { label, project: topic, error: error.message, code: error.code ?? null, status: error.code === 'INSUFFICIENT_NOVELTY' ? 'skipped-insufficient-novelty' : 'failed', attempts: error.attempts ?? [], records: error.records ?? [] };
      }
      results.push(entry);
      await onEntry(entry, { topic, run });
    }
  }
  return results;
}
