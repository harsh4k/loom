// Notion projects: keeps your Notion Projects database in step with your GitHub repos.
// - A repo with no page gets a new page.
// - On an existing page only Description and Tech Stack may change, and only while the field is
//   empty or still holds what the hub last wrote ("your edits win").
// - A repo archived on GitHub (or gone, when a GitHub key can confirm it) sets Status to Archived.
// Nothing is ever deleted. Every write goes into the change log first, so it can be undone.
import { isRetryable } from '../errors.mjs';
import { canonicalRepoUrl, createGitHub, githubUser } from '../github/repos.mjs';
import { buildTechStack } from '../github/stack.mjs';
import { HttpStatusError } from '../http.mjs';
import { UNDONE } from '../ledger.mjs';
import { createNotion } from '../notion/client.mjs';

export const JOB_ID = 'notion-projects';
export const TARGET = 'notion-page';
export const ARCHIVED = '📦 Archived';
export const CAPS = Object.freeze({ creates: 10, updates: 25 });
const RECENT_MS = 30 * 24 * 60 * 60 * 1000;
const UPDATABLE = ['Description', 'Tech Stack'];

const normalName = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
export const pageName = (repoName) => {
  const words = repoName.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export function startingStatus(repo, now) {
  if (repo.pushedAt && now.getTime() - Date.parse(repo.pushedAt) <= RECENT_MS) return '⚡ In Dev';
  if (repo.homepage) return '🚀 Deployed';
  return '🔧 Maintenance';
}

// What the hub last wrote to a field on a page: undefined (never), UNDONE (hands off), or the value.
// A page the hub created counts as written with the values it was created with.
export function hubValue(ledger, pageId, field) {
  const last = ledger.lastWritten(TARGET, pageId, field);
  if (last !== undefined) return last;
  const created = ledger.lastWritten(TARGET, pageId, 'page');
  if (created === UNDONE) return UNDONE;
  if (created && typeof created === 'object' && Object.hasOwn(created.values ?? {}, field)) return created.values[field];
  return undefined;
}

// A field may be rewritten if the hub never touched it and it is empty, or it still holds the
// hub's last value.
export function mayRewrite(current, hub) {
  if (hub === UNDONE) return false;
  if (hub === undefined) return String(current ?? '').trim() === '';
  return current === hub;
}

// Archiving is the one change allowed on any page, but not after you changed Status back.
function mayArchive(current, hub) {
  if (current === ARCHIVED || hub === UNDONE) return false;
  return hub === undefined || current === hub;
}

async function stackFor(github, repo, signal) {
  const [languages, files] = await Promise.all([github.languages(repo.fullName, { signal }), github.manifests(repo.fullName, { signal })]);
  return buildTechStack({ languages, files });
}

// Works out every change without writing anything. Returns { creates, updates, notes }.
export async function planSync({ repos, pages, github, ledger, now = new Date(), canConfirmGone = false, signal, user = githubUser() }) {
  const notes = [];
  const creates = [];
  const updates = new Map(); // pageId -> { page, values: {field: value} }
  const addUpdate = (page, field, value) => {
    const entry = updates.get(page.id) ?? { page, values: {} };
    entry.values[field] = value;
    updates.set(page.id, entry);
  };

  const listed = repos.filter((repo) => repo.url && repo.name.toLowerCase() !== user.toLowerCase());
  const repoByUrl = new Map(listed.map((repo) => [repo.url, repo]));
  const pageByUrl = new Map();
  const duplicated = new Set();
  for (const page of pages) {
    const url = canonicalRepoUrl(page.githubUrl);
    if (!url) continue;
    if (pageByUrl.has(url)) duplicated.add(url);
    pageByUrl.set(url, page);
  }
  for (const url of duplicated) {
    pageByUrl.delete(url);
    notes.push(`More than one page links to ${url}, so those pages were left alone.`);
  }

  // Pages whose repo isn't in the list: renamed, private, someone else's, or gone.
  for (const [url, page] of [...pageByUrl]) {
    if (repoByUrl.has(url)) continue;
    const fullName = url.slice('https://github.com/'.length);
    const found = await github.getRepo(fullName, { signal });
    if (found) {
      const foundUrl = canonicalRepoUrl(found.html_url);
      if (foundUrl && foundUrl !== url && repoByUrl.has(foundUrl) && !pageByUrl.has(foundUrl)) pageByUrl.set(foundUrl, page);
      if (found.archived === true && mayArchive(page.Status, hubValue(ledger, page.id, 'Status'))) addUpdate(page, 'Status', ARCHIVED);
      continue;
    }
    const mine = fullName.split('/')[0].toLowerCase() === user.toLowerCase();
    if (mine && canConfirmGone) {
      if (mayArchive(page.Status, hubValue(ledger, page.id, 'Status'))) addUpdate(page, 'Status', ARCHIVED);
    } else {
      notes.push(`${page.name || url}: GitHub didn’t show this repo (private or removed), so the page was left alone.`);
    }
  }

  const unlinkedNames = new Map(pages.filter((page) => !canonicalRepoUrl(page.githubUrl)).map((page) => [normalName(page.name), page]));
  for (const repo of listed) {
    const page = pageByUrl.get(repo.url);
    if (!page) {
      if (repo.archived) continue;
      const sameName = unlinkedNames.get(normalName(repo.name)) ?? unlinkedNames.get(normalName(pageName(repo.name)));
      if (sameName) {
        notes.push(`${repo.name}: the page “${sameName.name}” has no GitHub URL, so no new page was made. Add the URL to link them.`);
        continue;
      }
      const values = {
        Name: pageName(repo.name),
        'GitHub URL': repo.htmlUrl,
        Description: repo.description,
        'Tech Stack': await stackFor(github, repo, signal),
        Status: startingStatus(repo, now),
        Type: '👤 Personal',
      };
      creates.push({ repo, values });
      continue;
    }
    if (repo.archived && mayArchive(page.Status, hubValue(ledger, page.id, 'Status'))) addUpdate(page, 'Status', ARCHIVED);
    const writable = UPDATABLE.filter((field) => mayRewrite(page[field], hubValue(ledger, page.id, field)));
    for (const field of writable) {
      const value = field === 'Description' ? repo.description : await stackFor(github, repo, signal);
      if (value && value !== page[field]) addUpdate(page, field, value);
    }
  }
  return { creates, updates: [...updates.values()], notes };
}

function describe(plan) {
  const archived = plan.updates.filter((update) => update.values.Status === ARCHIVED).length;
  const changed = plan.updates.length - archived;
  const parts = [];
  if (plan.creates.length) parts.push(`${plan.creates.length} new (${plan.creates.map((item) => item.values.Name).join(', ')})`);
  if (changed) parts.push(`${changed} updated`);
  if (archived) parts.push(`${archived} archived`);
  return parts.length ? parts.join(', ') : 'nothing to change';
}

export function createNotionProjectsJob({ connections, openLedger, fetch: fetchImpl = fetch, now = () => new Date() }) {
  async function prepare(signal, report) {
    const notionKey = connections().token('notion');
    if (!notionKey) return null;
    const githubKey = connections().token('github');
    const github = createGitHub({ token: githubKey, fetch: fetchImpl });
    const notion = createNotion({ token: notionKey, fetch: fetchImpl });
    report('Reading your GitHub repos.');
    const repos = await github.listRepos({ signal });
    report('Reading your Notion projects.');
    const pages = await notion.listPages({ signal });
    return { github, notion, repos, pages, canConfirmGone: Boolean(githubKey) };
  }

  // Turns a Notion refusal into a message that says what to fix.
  async function explain(error) {
    if (!(error instanceof HttpStatusError) || error.service !== 'Notion') return error;
    if (error.status === 401) {
      await connections().reportProblem('notion', 'Notion refused the key. Paste a new key on the Accounts page.');
      return new Error('Notion refused the key. Paste a new key on the Accounts page.');
    }
    if (error.status === 404 || error.status === 403) {
      return new Error('Notion can’t see the Projects database. In Notion, open your Projects database, choose ••• > Connections, and add the hub’s integration.');
    }
    return error;
  }

  async function run(context = {}) {
    const report = typeof context.report === 'function' ? context.report : () => {};
    const { signal } = context;
    const ledger = openLedger();
    try {
      let ready;
      try { ready = await prepare(signal, report); } catch (error) { throw await explain(error); }
      if (!ready) return { summary: 'Skipped: Notion isn’t connected yet. Add your Notion key on the Accounts page.' };
      report('Working out what changed.');
      const plan = await planSync({ ...ready, ledger, now: now(), signal });
      if (plan.creates.length > CAPS.creates || plan.updates.length > CAPS.updates) {
        throw new Error(`Stopped before writing: this run would add ${plan.creates.length} pages and change ${plan.updates.length}, over the limit of ${CAPS.creates} and ${CAPS.updates}. Nothing was changed.`);
      }
      const runId = context.runId ?? `manual-${now().toISOString()}`;
      const problems = [];
      const write = async (label, fn) => {
        if (signal?.aborted) throw signal.reason ?? new Error('Stopped.');
        try { await fn(); } catch (error) {
          const explained = await explain(error);
          if (isRetryable(explained) || explained !== error || signal?.aborted) throw explained;
          problems.push(`${label}: ${explained.message}`);
        }
      };

      for (const { repo, values } of plan.creates) {
        report(`Adding ${values.Name} to Notion.`);
        await write(values.Name, async () => {
          const change = ledger.begin({ runId, jobId: JOB_ID, target: TARGET, targetId: repo.url, field: 'page', label: `Added ${values.Name}`, before: null, after: { values } });
          try {
            const page = await ready.notion.createPage(values, { signal });
            ledger.applied(change.id, { targetId: page.id, after: { values, pageId: page.id } });
          } catch (error) { ledger.failed(change.id, error.message); throw error; }
        });
      }
      for (const { page, values } of plan.updates) {
        report(`Updating ${page.name} in Notion.`);
        await write(page.name, async () => {
          const changes = Object.entries(values).map(([field, after]) => ledger.begin({
            runId, jobId: JOB_ID, target: TARGET, targetId: page.id, field,
            label: field === 'Status' ? `Archived ${page.name}` : `${page.name}: ${field}`, before: page[field] ?? '', after,
          }));
          try {
            await ready.notion.updatePage(page.id, values, { signal });
            for (const change of changes) ledger.applied(change.id);
          } catch (error) { for (const change of changes) ledger.failed(change.id, error.message); throw error; }
        });
      }

      const notes = plan.notes.length ? ` ${plan.notes.length} left alone.` : '';
      if (problems.length) throw new Error(`Notion projects: ${describe(plan)}, but ${problems.length} failed. ${problems.join(' ')}`.slice(0, 480));
      return { summary: `Notion projects: ${describe(plan)}.${notes}` };
    } finally {
      ledger.close();
    }
  }

  // The same plan without writing anything, for checking before the first real run.
  async function preview({ signal } = {}) {
    const ledger = openLedger();
    try {
      let ready;
      try { ready = await prepare(signal, () => {}); } catch (error) { throw await explain(error); }
      if (!ready) return { connected: false };
      const plan = await planSync({ ...ready, ledger, now: now(), signal });
      return { connected: true, repos: ready.repos.length, pages: ready.pages.length, ...plan, summary: describe(plan) };
    } finally {
      ledger.close();
    }
  }

  // Puts one logged change back. A created page is archived (never deleted); a field gets its
  // old value, but only if nobody has changed it in Notion since.
  async function undo(change) {
    const notion = createNotion({ token: connections().token('notion'), fetch: fetchImpl });
    try {
      if (change.field === 'page') {
        const pageId = change.after?.pageId;
        if (!pageId) throw new Error('This page’s id wasn’t recorded, so it can’t be undone.');
        await notion.updatePage(pageId, { Status: ARCHIVED });
        return;
      }
      const current = await notion.getPage(change.targetId);
      if ((current[change.field] ?? '') !== (change.after ?? '')) throw new Error('This field was changed in Notion since, so it was left as it is.');
      await notion.updatePage(change.targetId, { [change.field]: change.before ?? '' });
    } catch (error) {
      throw await explain(error);
    }
  }

  return { run, preview, undo };
}
