// Scores one LinkedIn post against config/brand.json and the Story Bank. Every check is plain
// code, so the same post always gets the same score; quality judgements are left to a person.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { selectFacts, factText, nameList } from '../copy/sources.mjs';

export const BRAND_FILE = path.resolve(import.meta.dirname, '../../config/brand.json');

export function loadBrand(file = process.env.LOOM_BRAND || BRAND_FILE) {
  return validateBrand(JSON.parse(readFileSync(file, 'utf8')));
}

export function validateBrand(brand) {
  const copy = brand?.copy ?? {};
  for (const key of ['minChars', 'maxChars', 'maxHashtags', 'maxSentencesPerParagraph', 'maxAverageSentenceWords', 'maxEmDashes']) {
    if (!Number.isInteger(copy[key]) || copy[key] < 0) throw new Error(`brand.json copy.${key} must be a whole number.`);
  }
  if (!Array.isArray(brand?.voice?.banned)) throw new Error('brand.json voice.banned must be a list.');
  return { ...brand, copy: { ...copy, requireQuestionEnding: copy.requireQuestionEnding ?? brand.version === 1 } };
}

export const CATEGORIES = {
  grounding: ['numbersGrounded', 'namesProject', 'scopeGrounded', 'noUnrelatedProjects'],
  formatting: ['length', 'opener', 'ending', 'noLinks', 'noPlaceholders', 'paragraphs', 'emDashes'],
  brand: ['noBannedPhrases', 'noRestrictedNames'],
  readability: ['sentenceLength'],
  originality: ['freshOpener', 'freshBody'],
};

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const words = (text) => text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
const sentences = (text) => text.split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter((part) => /[a-z0-9]/i.test(part));
const firstLine = (post) => post.split(/\r?\n/)[0].trim();

// Share of the smaller set found in the other (1 = one fully contains the other).
function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  return shared(a, b) / Math.min(a.size, b.size);
}
function shared(a, b) {
  let count = 0;
  for (const item of a) if (b.has(item)) count += 1;
  return count;
}
function trigrams(text) {
  const list = words(text);
  const result = new Set();
  for (let index = 0; index + 2 < list.length; index += 1) result.add(list.slice(index, index + 3).join(' '));
  return result;
}

// The Story Bank lines that mention the project, matched the way the draft script matches them.
export function factsFor(storyBank, project) {
  return factText(selectFacts(storyBank, project));
}

export function scorePost({ post, project, facts, brand, others = [], avoid = [], topics = [] }) {
  const copy = brand.copy;
  const text = post.trim();
  const checks = {};
  const add = (name, pass, detail = '') => { checks[name] = { pass: Boolean(pass), detail }; };

  const numericTokens = (value) => (value.match(/(?<![\d.])\d[\d,]*(?:\.\d+)*/g) ?? []).map((token) => token.replace(/,/g, ''));
  const numbers = new Set(numericTokens(facts));
  const missing = numericTokens(text).filter((value) => !numbers.has(value));
  add('numbersGrounded', missing.length === 0, missing.length ? `not in the Story Bank: ${[...new Set(missing)].join(', ')}` : '');
  add('namesProject', Boolean(project) && new RegExp(`(?<![\\p{L}\\p{N}_])${escape(project)}(?![\\p{L}\\p{N}_])`, 'iu').test(text), project ? `Post body must name ${project} explicitly, not only in metadata` : 'no project');
  const broadNetwork = /\boffline\b|no internet|no (?:external |network )?connectivity|nothing leaves|never leaves|no data (?:ever )?leaves|no data (?:is )?sent|data stays|air.gapped|no API keys?/i;
  const dependencyFree = /\b(?:without|no|zero) (?:any )?(?:external |third.party |cloud )?dependenc(?:ies|y)\b|dependency.free/i;
  const unsupportedScope = (broadNetwork.test(text) && !broadNetwork.test(facts)) || (dependencyFree.test(text) && !dependencyFree.test(facts));
  add('scopeGrounded', !unsupportedScope, unsupportedScope ? 'source facts do not establish this whole-app connectivity, data-flow or dependency guarantee' : '');
  const unrelated = nameList(topics).filter((name) => name.toLowerCase() !== project.toLowerCase() && new RegExp(`(?<![\\p{L}\\p{N}_])${escape(name)}(?![\\p{L}\\p{N}_])`, 'iu').test(text));
  add('noUnrelatedProjects', unrelated.length === 0, unrelated.length ? 'mentions another project' : '');

  add('length', text.length >= copy.minChars && text.length <= copy.maxChars, `${text.length} characters`);
  add('opener', !/\?$/.test(firstLine(text)), '');
  const hashtagCount = (text.match(/#[\w-]+/g) ?? []).length;
  add('ending', hashtagCount <= copy.maxHashtags && (copy.requireQuestionEnding !== true || new RegExp(`\\?\\s*(?:#[\\w-]+\\s*){0,${copy.maxHashtags}}$`).test(text)), '');
  add('noLinks', !/https?:\/\/|www\.|github\.com\//i.test(text), '');
  add('noPlaceholders', !/[[\]{}]|\b(?:SLOT|TODO|TBD)\b/.test(text), '');
  const paragraphs = text.split(/\n\s*\n/).filter((part) => !/^\s*(?:#[\w-]+\s*)+$/.test(part));
  const longest = Math.max(0, ...paragraphs.map((part) => sentences(part).length));
  add('paragraphs', longest <= copy.maxSentencesPerParagraph, `longest paragraph: ${longest} sentences`);
  const dashes = (text.match(/—/g) ?? []).length;
  add('emDashes', dashes <= copy.maxEmDashes, `${dashes} em dashes`);

  const found = brand.voice.banned.filter((phrase) => new RegExp(`(?<![\\w])${escape(phrase)}(?![\\w])`, 'i').test(text));
  add('noBannedPhrases', found.length === 0, found.join(', '));
  const restricted = nameList(avoid).filter((name) => new RegExp(escape(name), 'i').test(text));
  add('noRestrictedNames', restricted.length === 0, restricted.length ? 'contains a restricted name' : '');

  const all = sentences(text);
  const average = all.length ? all.reduce((sum, sentence) => sum + words(sentence).length, 0) / all.length : 0;
  add('sentenceLength', average > 0 && average <= copy.maxAverageSentenceWords, `${average.toFixed(1)} words per sentence`);

  const opener = new Set(words(firstLine(text)));
  const openerMatch = Math.max(0, ...others.map((other) => overlap(opener, new Set(words(firstLine(other))))));
  add('freshOpener', openerMatch < 0.6, `closest opener overlap ${Math.round(openerMatch * 100)}%`);
  const body = trigrams(text);
  const bodyMatch = body.size ? Math.max(0, ...others.map((other) => shared(body, trigrams(other)) / body.size)) : 0;
  add('freshBody', bodyMatch < 0.35, `closest post shares ${Math.round(bodyMatch * 100)}% of phrases`);

  const names = Object.keys(checks);
  const passed = names.filter((name) => checks[name].pass).length;
  const categories = Object.fromEntries(Object.entries(CATEGORIES).map(([category, members]) => [
    category, members.filter((name) => checks[name].pass).length / members.length,
  ]));
  return { checks, passed, total: names.length, score: passed / names.length, categories };
}
