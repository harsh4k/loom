// The copy benchmark: score a set of posts and write a scorecard a person can add ratings to.
import { parseDraft } from '../linkedin/publish.mjs';
import { CATEGORIES, factsFor, scorePost } from './copy-score.mjs';

export const draftProject = (markdown) => /^- Project:[ \t]*(.+)$/m.exec(markdown)?.[1]?.trim() ?? '';

// entries: [{ label, markdown }] (a draft file's text). Each post is compared with every other
// post in the set and with `history` (earlier drafts), so repeated openers show up.
export function scoreEntries({ entries, brand, storyBank, history = [] }) {
  const parsed = entries.map((entry) => {
    try { return { ...entry, project: draftProject(entry.markdown), post: parseDraft(entry.markdown).post }; }
    catch (error) { return { ...entry, project: draftProject(entry.markdown), post: '', error: error.message }; }
  });
  return parsed.map((entry, index) => {
    if (!entry.post) return { label: entry.label, project: entry.project, error: entry.error ?? 'No post text.' };
    const others = [...history, ...parsed.filter((_, other) => other !== index).map((item) => item.post)].filter(Boolean);
    const result = scorePost({ post: entry.post, project: entry.project, facts: factsFor(storyBank, entry.project), brand, others });
    return { label: entry.label, project: entry.project, post: entry.post, ...result };
  });
}

export function summarize(results) {
  const scored = results.filter((item) => !item.error);
  const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);
  return {
    posts: results.length,
    failed: results.length - scored.length,
    score: mean(scored.map((item) => item.score)),
    categories: Object.fromEntries(Object.keys(CATEGORIES).map((name) => [name, mean(scored.map((item) => item.categories[name]))])),
  };
}

const percent = (value) => `${Math.round(value * 100)}%`;
const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function renderScorecard({ results, summary, mode, brandVersion, humanRatings = [], when = new Date() }) {
  const lines = [
    `# Copy benchmark, ${when.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    '',
    `Mode: ${mode}. Brand file version ${brandVersion}. ${summary.posts} posts${summary.failed ? `, ${summary.failed} without usable text` : ''}.`,
    '',
    `**Automatic score: ${percent(summary.score)}**`,
    '',
    '| Category | Score |',
    '| --- | --- |',
    ...Object.entries(summary.categories).map(([name, value]) => `| ${name} | ${percent(value)} |`),
    '',
    '## Posts',
    '',
    `| Post | Project | Auto score | Failed checks |${humanRatings.map((name) => ` ${cell(name)} |`).join('')}`,
    `| --- | --- | --- | --- |${humanRatings.map(() => ' --- |').join('')}`,
    ...results.map((item) => {
      const failed = item.error ? item.error : Object.entries(item.checks).filter(([, check]) => !check.pass).map(([name, check]) => (check.detail ? `${name} (${check.detail})` : name)).join('; ') || 'none';
      return `| ${cell(item.label)} | ${cell(item.project || '?')} | ${item.error ? 'n/a' : percent(item.score)} | ${cell(failed)} |${humanRatings.map(() => '  |').join('')}`;
    }),
    '',
    'Fill in the rating columns by hand. The automatic score only covers rules code can check; it says nothing about whether a post is interesting.',
    '',
  ];
  for (const item of results) {
    if (!item.post) continue;
    lines.push(`### ${item.label}`, '', ...item.post.split(/\r?\n/).map((line) => `> ${line}`), '');
  }
  return lines.join('\n');
}
