// The copy benchmark: score a set of posts and write a scorecard a person can add ratings to.
import { parseDraft } from '../linkedin/publish.mjs';
import { CATEGORIES, factsFor, scorePost } from './copy-score.mjs';
import { factText } from '../copy/sources.mjs';

export const draftProject = (markdown) => /^- Project:[ \t]*(.+)$/m.exec(markdown)?.[1]?.trim() ?? '';

// entries: [{ label, markdown }] (a draft file's text). Each post is compared with every other
// post in the set and with `history` (earlier drafts), so repeated openers show up.
export function scoreEntries({ entries, brand, storyBank, history = [], avoid = [], topics = [] }) {
  const parsed = entries.map((entry) => {
    try { return { ...entry, project: draftProject(entry.markdown), post: parseDraft(entry.markdown).post }; }
    catch (error) { return { ...entry, project: draftProject(entry.markdown), post: '', error: entry.error ?? error.message }; }
  });
  return parsed.map((entry, index) => {
    if (!entry.post) return { label: entry.label, project: entry.project, error: entry.error ?? 'No post text.' };
    if (!entry.project) return { ...entry, error: 'Missing project metadata; grounding is unscorable.' };
    const facts = entry.records?.length ? factText(entry.records) : factsFor(storyBank, entry.project);
    if (!facts) return { ...entry, error: 'No usable project facts; grounding is unscorable.' };
    const others = [...history, ...parsed.filter((_, other) => other !== index).map((item) => item.post)].filter(Boolean);
    const result = scorePost({ post: entry.post, project: entry.project, facts, brand, others, avoid, topics });
    return { ...entry, ...result };
  });
}

export function summarize(results) {
  const scored = results.filter((item) => item.checks && Number.isFinite(item.score));
  const generated = results.filter((item) => item.post);
  const valid = scored.filter((item) => !item.error && Object.values(item.checks).every((check) => check.pass));
  const skipped = results.filter((item) => item.status === 'skipped-insufficient-novelty').length;
  const ratio = (count) => results.length ? count / results.length : 0;
  const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);
  return {
    posts: results.length,
    attempted: results.length,
    generated: generated.length,
    scorable: scored.length,
    valid: valid.length,
    publishable: generated.length && generated.every((item) => typeof item.humanReview?.publishable === 'boolean') ? generated.filter((item) => item.humanReview.publishable).length : null,
    skipped,
    failed: results.length - valid.length - skipped,
    generationYield: ratio(generated.length),
    scorableYield: ratio(scored.length),
    validYield: ratio(valid.length),
    yield: ratio(valid.length),
    score: ratio(valid.reduce((sum, item) => sum + item.score, 0)),
    successfulScore: mean(valid.map((item) => item.score)),
    scorableScore: mean(scored.map((item) => item.score)),
    categories: Object.fromEntries(Object.keys(CATEGORIES).map((name) => [name, mean(scored.map((item) => item.categories?.[name] ?? 0))])),
  };
}

const percent = (value) => `${Math.round(value * 100)}%`;
const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function renderScorecard({ results, summary, mode, brandVersion, humanRatings = [], when = new Date() }) {
  const lines = [
    `# Copy benchmark, ${when.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    '',
    `Mode: ${mode}. Brand file version ${brandVersion}. ${summary.posts} posts${summary.failed ? `, ${summary.failed} failed or unscorable` : ''}.`,
    '',
    `**Automatic score: ${percent(summary.score)}**`,
    `Attempted ${summary.attempted}; generated ${summary.generated}; scorable ${summary.scorable}; constraint-valid ${summary.valid}; publishable ${summary.publishable === null ? 'unknown (human review required)' : summary.publishable}.`,
    `Skipped for insufficient novelty: ${summary.skipped ?? 0}. Failed or invalid: ${summary.failed}.`,
    `Generated yield: ${percent(summary.generationYield)}. Scorable yield: ${percent(summary.scorableYield)}. Valid yield: ${percent(summary.validYield)}. Invalid, failed or unscorable outputs contribute zero to the headline score.`,
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
      const details = Object.entries(item.checks ?? {}).filter(([, check]) => !check.pass).map(([name, check]) => (check.detail ? `${name} (${check.detail})` : name));
      const failed = [item.error, ...details].filter(Boolean).join('; ') || 'none';
      return `| ${cell(item.label)} | ${cell(item.project || '?')} | ${item.error ? 'n/a' : percent(item.score)} | ${cell(failed)} |${humanRatings.map(() => '  |').join('')}`;
    }),
    '',
    'Fill in the rating columns by hand. The automatic score checks constraints, numeric tokens, and lexical repetition. It does not prove factual entailment, originality of ideas, voice, or publication value. A source citation is traceability, not an entailment verdict. Evaluate media separately.',
    '',
  ];
  for (const item of results) {
    if (!item.post) continue;
    lines.push(`### ${item.label}`, '', ...item.post.split(/\r?\n/).map((line) => `> ${line}`), '');
  }
  return lines.join('\n');
}
