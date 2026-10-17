// One-shot entry point for Windows Task Scheduler. It records the run in the same SQLite
// store as the dashboard, so scheduled runs show up there even when the hub is not open.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHubJobs, DATA_DIR, DATABASE, secureDataDirectory, SETTINGS_FILE } from './bootstrap.mjs';
import { localDate } from './dates.mjs';
import { createQueue } from './queue.mjs';
import { openSettings } from './settings.mjs';
import { openStore } from './store.mjs';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const POLL_MS = 250;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function runOnce({ jobId, jobs, store, date = localDate(), log = console.log }) {
  if (typeof jobs[jobId]?.run !== 'function') {
    log(`Unknown job: ${jobId}`);
    return 2;
  }
  const queue = createQueue({ store, jobs });
  let run;
  try {
    run = queue.enqueue(jobId, date);
  } catch (error) {
    queue.destroy();
    if (error?.code !== 'ERR_DUPLICATE_RUN') throw error;
    log(`${jobId} already has a run for ${date}; nothing to do.`);
    return 0;
  }

  let stopping = false;
  const stop = () => { stopping = true; queue.destroy(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    for (;;) {
      const current = store.getSnapshot().runs.find((item) => item.runId === run.runId);
      if (current && TERMINAL.has(current.state) && !queue.snapshot().activeRun) {
        log(`${jobId} ${current.state}: ${current.summary}`);
        return current.state === 'succeeded' ? 0 : 1;
      }
      if (stopping && !queue.snapshot().activeRun) {
        log(`${jobId} stopped before it finished.`);
        return 1;
      }
      await delay(POLL_MS);
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    queue.destroy();
  }
}

// Prints what the Notion sync would change, without writing anything.
async function previewNotionProjects() {
  await secureDataDirectory(DATA_DIR);
  const result = await createHubJobs().notionProjects.preview();
  if (!result.connected) { console.log('Notion isn’t connected yet. Add your Notion key on the Accounts page.'); return 0; }
  console.log(`Read ${result.repos} repos and ${result.pages} Notion pages: ${result.summary}.`);
  for (const { values } of result.creates) console.log(`ADD     ${values.Name} | ${values.Status} | ${values['Tech Stack'] || '(no stack found)'} | ${values.Description || '(no description)'}`);
  for (const { page, values } of result.updates) for (const [field, value] of Object.entries(values)) console.log(`CHANGE  ${page.name} | ${field}: ${JSON.stringify(page[field] ?? '')} -> ${JSON.stringify(value)}`);
  for (const note of result.notes) console.log(`LEAVE   ${note}`);
  return 0;
}

async function main(argv) {
  const [command, jobId] = argv;
  if (command === 'preview' && jobId === 'notion-projects') return previewNotionProjects();
  if (command !== 'run' || !jobId) {
    console.log('Usage: node src/cli.mjs run <job-id>\n       node src/cli.mjs preview notion-projects');
    return 2;
  }
  await secureDataDirectory(DATA_DIR);
  // An automation turned off on the dashboard is skipped by its Windows task too.
  if (!openSettings(path.join(DATA_DIR, SETTINGS_FILE)).isEnabled(jobId)) {
    console.log(`${jobId} is turned off on the dashboard; nothing to do.`);
    return 0;
  }
  const store = openStore(path.join(DATA_DIR, DATABASE));
  try {
    return await runOnce({ jobId, store, jobs: createHubJobs().jobs });
  } finally {
    store.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      console.error(`Automation run failed: ${error?.message ?? 'Unexpected error.'}`);
      process.exitCode = 1;
    },
  );
}
