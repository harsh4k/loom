import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, statfs } from 'node:fs/promises';
import path from 'node:path';
import { createLinkedInDraftJob } from './jobs/linkedin-draft.mjs';
import { createLinkedInPostingJob } from './jobs/linkedin-post.mjs';
import { createNotionProjectsJob } from './jobs/notion-projects.mjs';
import { createPortfolioSyncJob } from './jobs/portfolio-sync.mjs';
import { createProjectDetailsJob } from './jobs/project-details.mjs';
import { createWeeklyReportJob } from './jobs/weekly-report.mjs';
import { createModel } from './model.mjs';
import { createLinkedInAccount } from './linkedin/account.mjs';
import { createPublisher } from './linkedin/publish.mjs';
import { createMediaRenderer } from './media/render.mjs';
import { AUTOMATIONS } from './automations.mjs';
import { backupIfDue, lastBackupAt } from './backup.mjs';
import { createConnections } from './connections.mjs';
import { openLedger } from './ledger.mjs';
import { createNotifier } from './notify.mjs';
import { createOllamaKeeper } from './ollama.mjs';
import { createQueue } from './queue.mjs';
import { buildJobs } from './registry.mjs';
import { createScheduler } from './scheduler.mjs';
import { createServer } from './server.mjs';
import { openSettings } from './settings.mjs';
import { openStore } from './store.mjs';
import { fileURLToPath } from 'node:url';

export const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');
export const DATABASE = 'hub.sqlite';
const SQLITE_FILES = [DATABASE, `${DATABASE}-wal`, `${DATABASE}-shm`, `${DATABASE}-journal`];
export const LINKEDIN_ACCOUNT_FILE = 'linkedin.json';
export const LINKEDIN_LEDGER_FILE = 'linkedin-posted.json';
export const LINKEDIN_REDIRECT_URI = 'http://localhost:4173/linkedin/callback';
export const CONNECTIONS_FILE = 'connections.json';
export const SETTINGS_FILE = 'hub-settings.json';
export const PROJECT_DETAILS_FILE = 'project-details.json';
const PRIVATE_FILES = [...SQLITE_FILES, LINKEDIN_ACCOUNT_FILE, LINKEDIN_LEDGER_FILE, CONNECTIONS_FILE, SETTINGS_FILE];

// The draft job, followed by posting to LinkedIn when an account is connected.
export function createLinkedInJobs({ dataDir = DATA_DIR, draftJob = createLinkedInDraftJob(), fetch: fetchImpl = fetch } = {}) {
  const account = createLinkedInAccount({ file: path.join(dataDir, LINKEDIN_ACCOUNT_FILE), redirectUri: LINKEDIN_REDIRECT_URI, fetch: fetchImpl });
  const publish = createPublisher({ account, ledgerFile: path.join(dataDir, LINKEDIN_LEDGER_FILE), fetch: fetchImpl });
  const renderMedia = createMediaRenderer({ workRoot: path.join(dataDir, 'media-work') });
  return { account, job: createLinkedInPostingJob({ draftJob, publish, renderMedia }) };
}

// Every active automation's job, ready for the queue. The CLI and the hub both use this, so a
// scheduled run and a dashboard run behave the same way.
export function createHubJobs({
  dataDir = DATA_DIR, draftJob, ollama = createOllamaKeeper(),
  connections = createConnections({ file: path.join(dataDir, CONNECTIONS_FILE) }), fetch: fetchImpl = fetch,
} = {}) {
  const linkedin = createLinkedInJobs({ dataDir, ...(draftJob ? { draftJob } : {}) });
  // Each run opens the change log on its own, so the CLI and the hub share one record.
  const notionProjects = createNotionProjectsJob({ connections: () => connections, openLedger: () => openLedger(path.join(dataDir, DATABASE)), fetch: fetchImpl });
  const projectDetails = createProjectDetailsJob({
    connections: () => connections, openLedger: () => openLedger(path.join(dataDir, DATABASE)),
    askJson: createModel(), stateFile: path.join(dataDir, PROJECT_DETAILS_FILE), fetch: fetchImpl,
  });
  const portfolioSync = createPortfolioSyncJob({ connections: () => connections, openLedger: () => openLedger(path.join(dataDir, DATABASE)), fetch: fetchImpl });
  const weeklyReport = createWeeklyReportJob({
    connections: () => connections, openLedger: () => openLedger(path.join(dataDir, DATABASE)), fetch: fetchImpl,
    readRuns: () => { const store = openStore(path.join(dataDir, DATABASE)); try { return store.getSnapshot().runs; } finally { store.close(); } },
  });
  const jobs = buildJobs({
    'linkedin-draft': linkedin.job, 'notion-projects': notionProjects, 'project-details': projectDetails,
    'portfolio-sync': portfolioSync, 'weekly-report': weeklyReport,
  }, { automations: AUTOMATIONS, ollama });
  return {
    jobs, linkedin: linkedin.account, ollama, notionProjects,
    undo: { 'notion-page': notionProjects.undo, 'notion-section': projectDetails.undo, 'portfolio-file': portfolioSync.undo },
  };
}

function windowsUserSid() {
  const result = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  const sid = result.stdout?.match(/S-\d+(?:-\d+)+/i)?.[0];
  if (result.error || result.status !== 0 || !sid) throw new Error('Could not identify the current Windows user.');
  return sid;
}

function setWindowsAcl(target, sid, directory) {
  const rights = directory ? '(OI)(CI)F' : 'F';
  const result = spawnSync('icacls.exe', [
    target, '/inheritance:r', '/grant:r', `*${sid}:${rights}`, `*S-1-5-18:${rights}`, `*S-1-5-32-544:${rights}`,
  ], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('Could not secure the automation hub data directory.');
}

export async function secureDataDirectory(directory) {
  await mkdir(directory, { recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Hub data path must be a real directory.');
  if (process.platform === 'win32') {
    const sid = windowsUserSid();
    setWindowsAcl(directory, sid, true);
    for (const name of PRIVATE_FILES) {
      const file = path.join(directory, name);
      try {
        const entry = await lstat(file);
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Hub database files must be regular files.');
        setWindowsAcl(file, sid, false);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  } else {
    await chmod(directory, 0o700);
    for (const name of PRIVATE_FILES) {
      try {
        const file = path.join(directory, name);
        const entry = await lstat(file);
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Hub database files must be regular files.');
        await chmod(file, 0o600);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// `ollama` and `schedule` exist so tests can run the hub without starting Ollama or the schedule.
export async function startHub({ port = Number(process.env.PORT) || 4173, draftJob = createLinkedInDraftJob(), ollama: keeper = createOllamaKeeper(), schedule = true } = {}) {
  await secureDataDirectory(DATA_DIR);
  const dbPath = path.join(DATA_DIR, DATABASE);
  const store = openStore(dbPath);
  const ledger = openLedger(dbPath);
  const settings = openSettings(path.join(DATA_DIR, SETTINGS_FILE));
  const connections = createConnections({ file: path.join(DATA_DIR, CONNECTIONS_FILE) });
  const { jobs, linkedin, ollama, undo } = createHubJobs({ draftJob, ollama: keeper, connections });
  const backupDir = path.join(DATA_DIR, 'backup');
  let queue;
  let app;
  let scheduler;
  try {
    // The queue reports each finished run to the scheduler, which is created right after it.
    queue = createQueue({ store, jobs, onSettled: (info) => scheduler?.onSettled(info) });
    queue.pause();
    scheduler = createScheduler({
      automations: AUTOMATIONS, queue, store, settings, notify: createNotifier(),
      // Once a day: back up, then prune activity older than 90 days (run history and drafts are kept).
      backup: async () => {
        const made = await backupIfDue({ dbPath, dir: backupDir, extraFiles: [LINKEDIN_LEDGER_FILE, SETTINGS_FILE, PROJECT_DETAILS_FILE].map((name) => path.join(DATA_DIR, name)) });
        if (made) store.pruneEvents(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000));
      },
      log: (message) => console.log(message),
    });
    const health = async () => {
      const disk = await statfs(DATA_DIR).catch(() => null);
      return {
        ollama: await ollama.isUp(),
        diskFreeBytes: disk ? disk.bavail * disk.bsize : null,
        lastBackupAt: (await lastBackupAt(backupDir).catch(() => null))?.toISOString() ?? null,
      };
    };
    app = await createServer({
      store, queue, host: '127.0.0.1', port, linkedin,
      hub: { jobIds: Object.keys(jobs), settings, connections, ledger, health, retries: scheduler.pendingRetries, undo },
    });
    queue.resume();
    if (schedule) scheduler.start();
  } catch (error) {
    scheduler?.stop();
    queue?.destroy();
    ledger.close();
    store.close();
    throw error;
  }

  let closing;
  const close = () => {
    closing ??= (async () => {
      scheduler.stop();
      queue.destroy();
      await app.close();
      while (queue.snapshot().activeRun) await delay(50);
      ledger.close();
      store.close();
    })();
    return closing;
  };
  return { ...app, store, queue, close };
}

export async function runHub() {
  const app = await startHub();
  console.log(`Automation hub listening at http://127.0.0.1:${app.address.port}`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void app.close().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
