// What a new portfolio card needs that Notion doesn't hold, made the way the site's own cards are:
// - the picture: a clean full-width screenshot of the project's live site (1900x950 WebP), taken
//   with headless Chrome and converted by ffmpeg, both hidden;
// - the words: summary, role, problem and outcome in the site's voice (first person, plain,
//   specific), written by Qwen from the README and checked so nothing is invented.
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { ungrounded } from '../details/check.mjs';

export const CARD_SIZE = Object.freeze({ w: 1900, h: 950 });
const MIN_PNG = 40 * 1024;
const MIN_WEBP = 12 * 1024;

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const PLACEHOLDER = /[[\]{}<>#@*_`]|\bTODO\b|\bTBD\b|lorem|ipsum|placeholder|example\.com|https?:\/\/|www\.|\p{Extended_Pictographic}/iu;
// Words the site never uses about its own work.
const HYPE = /\b(cutting[- ]edge|state[- ]of[- ]the[- ]art|revolutionary|seamless(ly)?|robust|leverag(e|es|ing)|empower(s|ing)?|innovative|world[- ]class|next[- ]gen(eration)?|game[- ]chang(er|ing)|blazing(ly)?|supercharg(e|ed|es))\b/i;

async function size(file) {
  try { return (await stat(file)).size; } catch { return 0; }
}

// Takes the card picture of a live site. Returns WebP bytes, or null when the site couldn't be
// captured cleanly (too small usually means blank or an error page).
export async function captureCard({ url, browserPath, ffmpeg = 'ffmpeg', run, workDir, signal }) {
  if (!browserPath || !/^https:\/\//.test(url ?? '')) return null;
  await mkdir(workDir, { recursive: true });
  const png = path.join(workDir, 'card.png');
  const webp = path.join(workDir, 'card.webp');
  try {
    await run(browserPath, [
      '--headless', '--hide-scrollbars', '--no-first-run', '--disable-extensions', '--mute-audio',
      `--user-data-dir=${path.join(workDir, 'browser-profile')}`, `--window-size=${CARD_SIZE.w},${CARD_SIZE.h}`,
      '--virtual-time-budget=15000', `--screenshot=${png}`, url,
    ], { signal, timeoutMs: 90_000 });
    if ((await size(png)) < MIN_PNG) return null;
    const converted = await run(ffmpeg, ['-loglevel', 'error', '-y', '-i', png, '-vf', `scale=${CARD_SIZE.w}:${CARD_SIZE.h}`, '-c:v', 'libwebp', '-quality', '82', webp], { signal, timeoutMs: 60_000 });
    if (converted.code !== 0 || (await size(webp)) < MIN_WEBP) return null;
    return await readFile(webp);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---- Words ------------------------------------------------------------------------------------

export const ENTRY_SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string' }, role: { type: 'string' }, problem: { type: 'string' }, outcome: { type: 'string' } },
  required: ['summary', 'role', 'problem', 'outcome'],
};
const LIMITS = { summary: [12, 120], role: [6, 120], problem: [60, 600], outcome: [60, 600] };

// The site's own entries, as examples of its voice.
export function voiceExamples(entries, count = 2) {
  return entries
    .filter((entry) => entry.summary && entry.problem && entry.outcome)
    .slice(0, count)
    .map((entry) => JSON.stringify({ title: entry.title, summary: entry.summary, role: entry.role, problem: entry.problem, outcome: entry.outcome }))
    .join('\n');
}

// Checks Qwen's entry. Fields that fail are left out (the site treats them as optional), but a
// card without a summary isn't worth adding words to at all.
export function checkEntry(output, sourceText) {
  const kept = {};
  const dropped = [];
  for (const [field, [min, max]] of Object.entries(LIMITS)) {
    const value = clean(output?.[field]).replace(/^["“]|["”]$/g, '');
    const ok = value.length >= min && value.length <= max && !PLACEHOLDER.test(value) && !HYPE.test(value) && !ungrounded(value, sourceText).length;
    if (ok) kept[field] = field === 'summary' ? value.replace(/\.$/, '') : value;
    else if (value) dropped.push(field);
  }
  return kept.summary ? { entry: kept, dropped } : { entry: null, dropped: Object.keys(LIMITS) };
}

export async function writeEntry({ page, readme = '', examples = '', askJson, signal }) {
  const facts = [
    `Name: ${page.name}`,
    page.Description ? `Description: ${clean(page.Description)}` : '',
    page['Tech Stack'] ? `Built with: ${clean(page['Tech Stack'])}` : '',
    readme ? `README:\n${String(readme).slice(0, 6000)}` : '',
  ].filter(Boolean).join('\n');
  const output = await askJson({
    system: 'You write the project cards on a developer\'s personal portfolio, in their own voice. Answer only with the requested JSON.',
    prompt: `Write the portfolio card for this project, using only these facts:\n\n${facts}\n\nCards already on the site (match their voice exactly: first person where it fits, plain and specific, no hype, no marketing words, no emoji):\n${examples}\n\nsummary: what it is in a few words, like the examples, no full stop.\nrole: what I did on it, a few words.\nproblem: one or two sentences on the problem it solves or the need behind it.\noutcome: one or two sentences on what exists now and what it does, concrete.`,
    schema: ENTRY_SCHEMA,
    signal,
  });
  return checkEntry(output, facts);
}
