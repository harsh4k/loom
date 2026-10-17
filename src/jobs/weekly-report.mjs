// Weekly report: every Sunday evening, one Notion page under the report page with what each automation did
// in the last 7 days, every change the hub made outside the PC, what needs your attention, and
// READMEs that look out of date (code pushed lately, README untouched for 90 days or more).
// It only ever creates its own page, once per week.
import { AUTOMATIONS } from '../automations.mjs';
import { createGitHub, githubUser } from '../github/repos.mjs';
import { HttpStatusError } from '../http.mjs';
import { createNotion, reportPageId } from '../notion/client.mjs';

export const JOB_ID = 'weekly-report';
export const TARGET = 'notion-report';
const DAY = 24 * 60 * 60 * 1000;
const STALE_DAYS = 90;

const text = (content) => [{ type: 'text', text: { content: String(content).slice(0, 2000) } }];
const heading = (content) => ({ object: 'block', type: 'heading_2', heading_2: { rich_text: text(content) } });
const bullet = (content) => ({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: text(content) } });
const para = (content) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: text(content) } });
const day = (iso) => String(iso ?? '').slice(0, 10);

// Repos pushed in the last 90 days whose README is 90+ days older than the last push.
export async function staleReadmes({ github, repos, now, signal }) {
  const stale = [];
  for (const repo of repos) {
    if (repo.archived || !repo.pushedAt || repo.name.toLowerCase() === githubUser().toLowerCase()) continue;
    const pushed = Date.parse(repo.pushedAt);
    if (now.getTime() - pushed > STALE_DAYS * DAY) continue;
    const changed = await github.lastChanged(repo.fullName, 'README.md', { signal }).catch(() => null);
    if (!changed) { stale.push(`${repo.name}: no README.md`); continue; }
    const gap = Math.floor((pushed - Date.parse(changed)) / DAY);
    if (gap >= STALE_DAYS) stale.push(`${repo.name}: README last changed ${day(changed)}, code pushed ${day(repo.pushedAt)}`);
  }
  return stale;
}

export function reportBlocks({ runs, changes, problems, stale, from, to }) {
  const blocks = [para(`What the automation hub did from ${from} to ${to}. Written by the hub; nothing here needs a reply.`)];
  blocks.push(heading('Needs your attention'));
  const attention = [
    ...problems,
    ...runs.filter((run) => run.state === 'failed').map((run) => `${run.name} failed on ${run.date}: ${run.summary}`),
  ];
  blocks.push(...(attention.length ? attention.slice(0, 20).map(bullet) : [para('Nothing.')]));
  blocks.push(heading('Runs'));
  const named = new Map(AUTOMATIONS.map((item) => [item.id, item.name]));
  if (!runs.length) blocks.push(para('No runs this week.'));
  for (const id of new Set(runs.map((run) => run.jobId))) {
    const mine = runs.filter((run) => run.jobId === id);
    const ok = mine.filter((run) => run.state === 'succeeded').length;
    blocks.push(bullet(`${named.get(id) ?? id}: ${mine.length} run${mine.length === 1 ? '' : 's'}, ${ok} succeeded. Latest: ${mine[0].summary}`));
  }
  blocks.push(heading('Changes made outside your PC'));
  const applied = changes.filter((change) => change.state === 'applied' || change.state === 'undone');
  blocks.push(...(applied.length ? applied.slice(0, 40).map((change) => bullet(`${day(change.createdAt)} ${change.label}${change.state === 'undone' ? ' (undone)' : ''}`)) : [para('None.')]));
  if (applied.length > 40) blocks.push(para(`And ${applied.length - 40} more on the dashboard’s Changes page.`));
  blocks.push(heading('READMEs that may be out of date'));
  blocks.push(...(stale.length ? stale.slice(0, 20).map(bullet) : [para('None.')]));
  return blocks;
}

export function createWeeklyReportJob({ connections, openLedger, readRuns, fetch: fetchImpl = fetch, now = () => new Date() }) {
  async function run(context = {}) {
    const report = typeof context.report === 'function' ? context.report : () => {};
    const { signal } = context;
    const notionKey = connections().token('notion');
    if (!notionKey) return { summary: 'Skipped: Notion isn’t connected yet. Add your Notion key on the Accounts page.' };
    const at = now();
    const to = day(at.toISOString());
    const since = new Date(at.getTime() - 7 * DAY);
    const from = day(since.toISOString());
    const ledger = openLedger();
    try {
      if (ledger.lastWritten(TARGET, to, 'page') !== undefined) return { summary: 'This week’s report is already in Notion.' };
      report('Collecting the week’s runs and changes.');
      const inWeek = (iso) => Date.parse(iso) >= since.getTime();
      const named = new Map(AUTOMATIONS.map((item) => [item.id, item.name]));
      const runs = readRuns().filter((item) => inWeek(item.updatedAt ?? item.createdAt) && item.jobId !== JOB_ID)
        .map((item) => ({ ...item, name: named.get(item.jobId) ?? item.jobId }));
      const changes = ledger.list().filter((change) => inWeek(change.createdAt));
      const status = connections().status?.() ?? {};
      const problems = Object.entries(status).filter(([, value]) => value?.problem).map(([provider, value]) => `${provider}: ${value.problem}`);

      report('Checking READMEs on GitHub.');
      const github = createGitHub({ token: connections().token('github'), fetch: fetchImpl });
      let stale = [];
      try { stale = await staleReadmes({ github, repos: await github.listRepos({ signal }), now: at, signal }); }
      catch (error) { if (signal?.aborted) throw error; stale = [`Couldn’t check GitHub this week (${error.message}).`]; }

      const title = `Hub report: week to ${to}`;
      const blocks = reportBlocks({ runs, changes, problems, stale, from, to });
      report('Writing the report to Notion.');
      const notion = createNotion({ token: notionKey, fetch: fetchImpl });
      const change = ledger.begin({ runId: context.runId ?? `manual-${at.toISOString()}`, jobId: JOB_ID, target: TARGET, targetId: to, field: 'page', label: `Weekly report for ${to}`, before: null, after: { title } });
      try {
        const page = await notion.createChildPage(reportPageId(), title, blocks, { signal });
        ledger.applied(change.id, { after: { title, pageId: page.id, url: page.url } });
      } catch (error) {
        ledger.failed(change.id, error.message);
        if (error instanceof HttpStatusError && error.service === 'Notion' && [401, 403, 404].includes(error.status)) {
          throw new Error('Notion can’t see your report page. Give the integration access to it (see the Accounts page).');
        }
        throw error;
      }
      return { summary: `Weekly report written to Notion: ${runs.length} runs, ${changes.length} changes, ${stale.length} READMEs to look at.` };
    } finally {
      ledger.close();
    }
  }
  return { run };
}
