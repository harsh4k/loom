// Turns the automation list and their job handlers into the job map the queue runs. Jobs that
// use the local model first make sure Ollama is answering, and every job gets a time limit.
import { AUTOMATIONS } from './automations.mjs';

const MODEL_JOB_LIMIT_MS = 20 * 60 * 1000;
const API_JOB_LIMIT_MS = 5 * 60 * 1000;

export function buildJobs(handlers, { automations = AUTOMATIONS, ollama = null } = {}) {
  const jobs = {};
  for (const automation of automations) {
    const handler = handlers[automation.id];
    if (automation.status !== 'active' || typeof handler?.run !== 'function') continue;
    const limitMs = automation.timeLimitMs ?? (automation.usesModel ? MODEL_JOB_LIMIT_MS : API_JOB_LIMIT_MS);
    jobs[automation.id] = {
      async run(context) {
        if (automation.usesModel && ollama) await ollama.ensure({ signal: context.signal, report: context.report });
        // The limit aborts through the same signal as Stop, so a job's own cleanup still runs.
        const limit = AbortSignal.timeout(limitMs);
        const signal = context.signal ? AbortSignal.any([context.signal, limit]) : limit;
        try {
          return await handler.run({ ...context, signal });
        } catch (error) {
          if (limit.aborted && !context.signal?.aborted) throw new Error(`Stopped after the ${Math.round(limitMs / 60_000)} minute time limit.`);
          throw error;
        }
      },
    };
  }
  return jobs;
}
