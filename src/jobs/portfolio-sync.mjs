// Portfolio sync: the Notion "On portfolio" checkbox decides which projects are in the Work
// section of a portfolio site: one JSON file in a GitHub repo (portfolio.repo and portfolio.file
// in config/profile.json).
// - A ticked project that isn't on the site yet is added at the end, if it has an image at
//   <portfolio.imagesDir>/<id>.webp. Its Portfolio ID is written back to Notion so the two stay linked.
// - A project linked by Portfolio ID and then unticked is removed from the site.
// - Entries already on the site are never edited, and entries with no Notion link are kept.
// The file is the only thing written, through one commit; Cloudflare Pages rebuilds from it.
import { canonicalRepoUrl, createGitHub } from '../github/repos.mjs';
import { HttpStatusError } from '../http.mjs';
import { createNotion } from '../notion/client.mjs';
import { getProfile, need } from '../profile.mjs';

export const JOB_ID = 'portfolio-sync';
export const TARGET = 'portfolio-file';
// Where the portfolio's project list lives, from the profile.
export function portfolioTarget(profile = getProfile()) {
  return {
    repo: need(profile.portfolio.repo, 'portfolio.repo'),
    file: need(profile.portfolio.file, 'portfolio.file'),
    images: need(profile.portfolio.imagesDir, 'portfolio.imagesDir'),
  };
}
export const CAPS = Object.freeze({ removals: 3, additions: 5 });

export const slug = (name) => String(name ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

// A 3 to 5 letter caption code ("bunny-os" -> "bnny"), unique among `taken`.
export function makeCode(id, taken) {
  const letters = id.replace(/[^a-z]/g, '');
  const consonants = letters[0] + letters.slice(1).replace(/[aeiou]/g, '');
  const bases = [consonants.slice(0, 4), letters.slice(0, 4), letters.slice(0, 5), consonants.slice(0, 5)].filter((code) => /^[a-z]{3,5}$/.test(code));
  for (const code of bases) if (!taken.has(code)) return code;
  for (const extra of 'abcdefghijklmnopqrstuvwxyz') {
    const code = `${(bases[0] ?? 'prj').slice(0, 3)}${extra}`;
    if (!taken.has(code)) return code;
  }
  return null;
}

// Builds a new site entry from a Notion page, or returns { skip } saying why it can't be added.
export function entryFor(page, { id, order, images, codes }) {
  const url = page.githubUrl && /^https:\/\//.test(page.githubUrl) ? page.githubUrl.trim() : null;
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) return { skip: `${page.name}: it needs a Portfolio ID made of lowercase letters, numbers and dashes` };
  if (!url) return { skip: `${page.name}: it has no GitHub URL to link to` };
  const imageName = `${id}.webp`;
  if (!images.has(imageName)) return { skip: `${page.name}: add the image public/images/${imageName} to the portfolio first` };
  const title = page.name.trim().slice(0, 40);
  if (!title) return { skip: 'a ticked page has no name' };
  const code = makeCode(id, codes);
  if (!code) return { skip: `${page.name}: no free caption code` };
  const entry = { id, order, title, code, url, image: `/images/${imageName}` };
  const summary = page.Description.trim();
  if (summary && summary.length <= 120) entry.summary = summary;
  const stack = page['Tech Stack'].split(',').map((item) => item.trim()).filter((item) => item && item.length <= 30).slice(0, 12);
  if (stack.length) entry.stack = stack;
  return { entry };
}

// Works out the new list without writing anything.
export function planPortfolio({ entries, pages, images }) {
  const notes = [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const linked = new Map(); // site id -> page
  for (const page of pages) {
    const id = page['Portfolio ID'];
    if (!id) continue;
    if (linked.has(id)) { notes.push(`Two Notion pages use the Portfolio ID ${id}, so it was left as it is.`); linked.set(id, null); continue; }
    linked.set(id, page);
  }
  const removed = entries.filter((entry) => { const page = linked.get(entry.id); return page && !page.onPortfolio; });
  const kept = entries.filter((entry) => !removed.includes(entry));

  const codes = new Set(entries.map((entry) => entry.code));
  const ids = new Set(entries.map((entry) => entry.id));
  let order = Math.max(0, ...entries.map((entry) => Number(entry.order) || 0));
  const added = [];
  const links = []; // pages that need their Portfolio ID written
  for (const page of pages.filter((item) => item.onPortfolio)) {
    const id = page['Portfolio ID'];
    if (id && linked.get(id) === null) continue;
    if (id && byId.has(id)) continue;
    const newId = id || slug(page.name);
    if (!id && ids.has(newId)) {
      // A site entry with this id exists but isn't linked yet: link it rather than add a second card.
      links.push({ page, id: newId });
      continue;
    }
    const result = entryFor(page, { id: newId, order: order + 1, images, codes });
    if (result.skip) { notes.push(result.skip); continue; }
    order += 1;
    codes.add(result.entry.code);
    ids.add(newId);
    added.push(result.entry);
    if (!id) links.push({ page, id: newId });
  }
  return { next: [...kept, ...added], added, removed, links, notes };
}

export function createPortfolioSyncJob({ connections, openLedger, fetch: fetchImpl = fetch, now = () => new Date() }) {
  async function read(signal) {
    const notionKey = connections().token('notion');
    const githubKey = connections().token('github');
    if (!notionKey) return { skip: 'Skipped: Notion isn’t connected yet. Add your Notion key on the Accounts page.' };
    if (!githubKey) return { skip: 'Skipped: add a GitHub key on the Accounts page so the hub can update your portfolio.' };
    const { repo: REPO, file: FILE, images: IMAGES } = portfolioTarget();
    const github = createGitHub({ token: githubKey, fetch: fetchImpl });
    const notion = createNotion({ token: notionKey, fetch: fetchImpl });
    const [pages, file, listing] = await Promise.all([
      notion.listPages({ signal }), github.getContent(REPO, FILE, { signal }), github.listDirectory(REPO, IMAGES, { signal }),
    ]);
    if (!pages.some((page) => page.hasPortfolioBox)) return { skip: 'Skipped: the Projects database has no “On portfolio” checkbox yet.' };
    if (!file) throw new Error(`Couldn’t find ${FILE} in ${REPO}.`);
    let entries;
    try { entries = JSON.parse(file.text); } catch { throw new Error('The portfolio’s projects.json isn’t valid JSON, so it was left alone.'); }
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry?.id !== 'string')) throw new Error('The portfolio’s projects.json isn’t a list of projects, so it was left alone.');
    if (!pages.some((page) => page.onPortfolio) && entries.length) {
      throw new Error('No Notion project has “On portfolio” ticked, which would empty the site, so nothing was changed.');
    }
    const images = new Set(listing.filter((entry) => entry.type === 'file').map((entry) => entry.name));
    return { github, notion, pages, file, entries, images, repo: REPO, path: FILE };
  }

  function explain(error) {
    if (error instanceof HttpStatusError && error.service === 'GitHub' && (error.status === 401 || error.status === 403)) {
      void connections().reportProblem('github', 'GitHub refused the key. It needs Contents: read and write on your portfolio repo.');
      return new Error(`GitHub refused the key. Make a key with Contents: read and write on ${portfolioTarget().repo} and paste it on the Accounts page.`);
    }
    if (error instanceof HttpStatusError && error.service === 'GitHub' && error.status === 409) {
      return new Error('The portfolio file changed while the hub was working, so nothing was written. The next run will try again.');
    }
    if (error instanceof HttpStatusError && error.service === 'Notion' && (error.status === 401 || error.status === 403 || error.status === 404)) {
      return new Error('Notion can’t see the Projects database. Give the integration access to it.');
    }
    return error;
  }

  async function run(context = {}) {
    const report = typeof context.report === 'function' ? context.report : () => {};
    const { signal } = context;
    const runId = context.runId ?? `manual-${now().toISOString()}`;
    const ledger = openLedger();
    try {
      report('Reading Notion and your portfolio.');
      let ready;
      try { ready = await read(signal); } catch (error) { throw explain(error); }
      if (ready.skip) return { summary: ready.skip };
      const plan = planPortfolio(ready);
      if (plan.removed.length > CAPS.removals || plan.added.length > CAPS.additions) {
        throw new Error(`Stopped before writing: this run would remove ${plan.removed.length} and add ${plan.added.length} projects, over the limit of ${CAPS.removals} and ${CAPS.additions}. Nothing was changed.`);
      }
      const notes = plan.notes.length ? ` Left out: ${plan.notes.join('; ')}.` : '';

      // Link pages to their site entry first, so an untick later maps to the right card.
      for (const { page, id } of plan.links) {
        const change = ledger.begin({ runId, jobId: JOB_ID, target: 'notion-page', targetId: page.id, field: 'Portfolio ID', label: `${page.name}: Portfolio ID`, before: page['Portfolio ID'], after: id });
        try { await ready.notion.updatePage(page.id, { 'Portfolio ID': id }, { signal }); ledger.applied(change.id); }
        catch (error) { ledger.failed(change.id, error.message); throw explain(error); }
      }

      if (!plan.added.length && !plan.removed.length) {
        return { summary: `Portfolio sync: the site already matches Notion (${ready.entries.length} projects).${notes}`.slice(0, 480) };
      }
      const text = `${JSON.stringify(plan.next, null, 2)}\n`;
      const parts = [
        plan.added.length ? `added ${plan.added.map((entry) => entry.title).join(', ')}` : '',
        plan.removed.length ? `removed ${plan.removed.map((entry) => entry.title).join(', ')}` : '',
      ].filter(Boolean).join(' and ');
      report('Committing projects.json to your portfolio.');
      const change = ledger.begin({ runId, jobId: JOB_ID, target: TARGET, targetId: `${ready.repo}/${ready.path}`, field: 'projects', label: `Portfolio: ${parts}`, before: ready.entries, after: plan.next });
      try {
        const commit = await ready.github.putContent(ready.repo, ready.path, { text, sha: ready.file.sha, message: `Portfolio: ${parts} (from Notion, by the automation hub)`, signal });
        ledger.applied(change.id, { after: { entries: plan.next, commit: commit.commit } });
      } catch (error) { ledger.failed(change.id, error.message); throw explain(error); }
      return { summary: `Portfolio sync: ${parts}. The site rebuilds on its own.${notes}`.slice(0, 480) };
    } finally {
      ledger.close();
    }
  }

  // Puts the previous list back, if the file still holds what this change wrote.
  async function undo(change) {
    const github = createGitHub({ token: connections().token('github'), fetch: fetchImpl });
    // targetId is "owner/repo/path/to/file", recorded when the change was made.
    const [owner, name, ...rest] = String(change.targetId ?? '').split('/');
    const REPO = `${owner}/${name}`;
    const FILE = rest.join('/');
    try {
      const file = await github.getContent(REPO, FILE);
      let current;
      try { current = JSON.parse(file?.text ?? ''); } catch { current = null; }
      if (JSON.stringify(current) !== JSON.stringify(change.after?.entries)) throw new Error('The portfolio file was changed since, so it was left as it is.');
      await github.putContent(REPO, FILE, { text: `${JSON.stringify(change.before, null, 2)}\n`, sha: file.sha, message: 'Portfolio: undo the last change from the automation hub' });
    } catch (error) { throw explain(error); }
  }

  return { run, undo };
}
