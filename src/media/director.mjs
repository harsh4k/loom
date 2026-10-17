// Loom's art director and storyboard writer. Qwen makes the creative calls (what kind of project
// this is, which art direction suits it, what each shot says); code deals the options, keeps every
// project's look different, checks contrast, and drops any word that isn't in the project's facts.
import { ungrounded } from '../details/check.mjs';

// ---- Small helpers --------------------------------------------------------------------------

const clean = (value, limit = 400) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
const words = (value) => clean(value).split(' ').filter(Boolean).length;
const PLACEHOLDER = /[[\]{}<>#@]|\bTODO\b|\bTBD\b|lorem|ipsum|placeholder|example\.com|https?:\/\/|www\.|\p{Extended_Pictographic}/iu;
// Words from the brief itself, which a small model sometimes copies into the film.
const BRIEF_ECHO = /\b(scene|shots?|caption|storyboard|end ?card|end ?line|open with|fill only|the facts)\b/i;

// A stable random stream per project, so a project's look is the same on every run.
export function seeded(text) {
  let h = 2166136261;
  for (const ch of String(text)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const shuffle = (items, random) => items.map((item) => [random(), item]).sort((a, b) => a[0] - b[0]).map(([, item]) => item);

// WCAG contrast ratio between two #rrggbb colours.
export function contrast(a, b) {
  const lum = (hex) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

// A palette is usable on film when every pairing the studio draws reads clearly.
export function paletteReadable(p) {
  const field = p.fields?.[0];
  return contrast(p.ink, p.bg) >= 7
    && contrast(p.ink, p.surface) >= 4.5
    && contrast(p.muted, p.bg) >= 3
    && contrast(p.accentInk, p.accent) >= 4.5
    && (!field || contrast(field.ink, field.bg) >= 4.5);
}

// ---- Facts ------------------------------------------------------------------------------------

// A README as plain prose: no images, badges, HTML or link targets; code blocks dropped.
export function readmeText(markdown) {
  return String(markdown ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_`>|]+/g, ' ')
    .split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter((line) => line && !/^[-=:\s]+$/.test(line))
    .join('\n');
}

// A command worth typing on screen: a line from the README's shell blocks that runs the project
// itself (its first word is the project's own name), never an install or setup step.
export function readmeCommand(markdown, names = []) {
  const own = new Set(names.map((name) => String(name).toLowerCase().replace(/[^a-z0-9-]/g, '')).filter((name) => name.length >= 3));
  for (const block of String(markdown ?? '').matchAll(/```(?:bash|sh|shell|console|powershell|ps1|pwsh|zsh|cmd)\s*\n([\s\S]*?)```/gi)) {
    for (const raw of block[1].split('\n')) {
      const line = raw.replace(/^\s*(?:PS [^>]*>|[$>])\s*/, '').trim();
      if (!line || line.length > 48 || /[<>[\]{}|]|your[-_ ]|\.\.\./i.test(line)) continue;
      const first = line.split(/\s+/)[0].toLowerCase().replace(/^\.[\\/]/, '').replace(/\.(exe|ps1|cmd|sh)$/, '');
      if (own.has(first)) return line;
    }
  }
  return '';
}

// Everything a film may say about a project, as text the grounding check reads.
export function projectFacts(project, { draft = '', readme = '' } = {}) {
  const stats = (project.stats ?? []).filter((s) => Array.isArray(s) && s.length >= 2).map(([value, label]) => ({ value: clean(value, 16), label: clean(label, 90) }));
  const stack = (project.stack ?? []).map((item) => clean(item, 30)).filter(Boolean);
  const lines = [
    `Name: ${project.name}`,
    project.eyebrow ? `Kind: ${project.eyebrow}` : '',
    project.hook ? `Hook: ${project.hook}` : '',
    project.tagline ? `What it is: ${project.tagline}` : '',
    ...(project.features ?? []).map((feature) => `Feature: ${clean(feature, 160)}`),
    ...stats.map((s) => `Number: ${s.value} (${s.label})`),
    stack.length ? `Built with: ${stack.join(', ')}` : '',
    project.link ? `Link: ${project.link}` : '',
  ].filter(Boolean);
  const repo = /github\.com\/[^/]+\/([^/]+)/.exec(project.link ?? '')?.[1] ?? '';
  const command = clean(project.command, 48) || readmeCommand(readme, [project.name, project.name.split(/\s+/)[0], repo]);
  if (command) lines.push(`Command: ${command}`);
  const post = clean(draft.replace(/^- [A-Z][a-z]+:.*$/gm, ''), 1500);
  const about = readmeText(readme);
  const text = [lines.join('\n'), about ? `From the README:\n${about.slice(0, 2400)}` : ''].filter(Boolean).join('\n\n');
  return { name: project.name, stats, stack, command, link: clean(project.link, 60), text, source: `${lines.join('\n')}\n${post}\n${about.slice(0, 12000)}`, post };
}

// ---- Art direction ----------------------------------------------------------------------------

// Directions built around pictures need a screenshot; without one they are not dealt.
const NEEDS_PICTURE = new Set(['place-carries-it', 'hero-object', 'contact-sheet', 'uneven-photographs', 'page-is-the-object', 'pinned-poster', 'split-stage']);
const DEAL = 4;

const CLASSIFY_SCHEMA = (library) => ({
  type: 'object',
  properties: {
    sector: { type: 'string', enum: library.sectors },
    tones: { type: 'array', items: { type: 'string', enum: library.tones }, minItems: 1, maxItems: 2 },
  },
  required: ['sector', 'tones'],
});

const CHOOSE_SCHEMA = (ids) => ({
  type: 'object',
  properties: {
    direction: { type: 'string', enum: ids },
    idea: { type: 'string' },
    memorable: { type: 'string' },
  },
  required: ['direction', 'idea', 'memorable'],
});

const othersUse = (looks, name, key) => new Set(Object.entries(looks).filter(([other]) => other !== name).flatMap(([, look]) => [].concat(look?.[key] ?? [])));

// The directions worth offering Qwen: matching sector and tone first, ones other projects
// already use last, so every project ends up looking different.
export function dealDirections(library, { name, sector, tones, hasPicture, looks = {} }) {
  const taken = othersUse(looks, name, 'direction');
  const random = seeded(`${name}:directions`);
  const scored = shuffle(library.directions, random)
    .filter((d) => hasPicture || !NEEDS_PICTURE.has(d.id))
    .map((d) => ({ d, score: (d.sectors?.includes(sector) ? 3 : 0) + (d.tones ?? []).filter((t) => tones.includes(t)).length * 2 - (taken.has(d.id) ? 5 : 0) }))
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, DEAL).map(({ d }) => d);
}

function pickPalette(library, direction, { name, looks, random }) {
  const taken = othersUse(looks, name, 'paletteId');
  const tags = new Set(direction.paletteTags ?? []);
  const readable = library.palettes.filter(paletteReadable);
  const ranked = shuffle(readable, random)
    .map((p) => ({ p, score: (p.tags ?? []).filter((t) => tags.has(t)).length * 2 + (p.from === 'inspo' ? 1 : 0) - (taken.has(p.id) ? 10 : 0) }))
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.p ?? null;
}

// Type systems in the direction's classes, unused ones first. Several are returned so the
// renderer can fall back when a font can't be downloaded.
function rankTypes(library, direction, { name, looks, random }) {
  const taken = othersUse(looks, name, 'typeId');
  const classes = new Set(direction.typeClasses ?? []);
  return shuffle(library.types, random)
    .map((t) => ({ t, score: (classes.has(t.class) ? 4 : 0) - (taken.has(t.id) ? 6 : 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map(({ t }) => t.id);
}

function pickIdea(ideas, { tones, taken, random, accept = () => true }) {
  const ranked = shuffle(ideas.filter(accept), random)
    .map((idea) => ({ idea, score: (idea.tones ?? []).filter((t) => tones.includes(t)).length * 2 + (idea.fetched ? 1 : 0) - (taken.has(idea.id) ? 6 : 0) }))
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.idea ?? null;
}

// The film's motion: the direction's grammar sets the transition; the motion idea sets how
// words arrive, the spacing and the drift.
export function motionFor(grammar, idea) {
  const knobs = idea?.knobs ?? {};
  return {
    ease: knobs.ease ?? grammar.ease ?? 'sharp',
    tempo: Number((((grammar.tempo ?? 1) + (knobs.tempo ?? grammar.tempo ?? 1)) / 2).toFixed(2)),
    transition: knobs.transition && grammar.transition !== 'cut' ? knobs.transition : (grammar.transition ?? 'mask'),
    reveal: knobs.reveal ?? 'rise',
    stagger: knobs.stagger ?? 1,
    drift: knobs.drift ?? 'none',
    fieldTone: knobs.fieldTone ?? 'field',
  };
}

const DIRECTOR_SYSTEM = 'You are the art director of a small motion design studio. You make short, calm, confident films about software projects for LinkedIn. You choose by the project, never by habit. Answer only with the requested JSON.';

// Decides a project's look once. Qwen classifies the project and picks one of the dealt
// directions; code deals palette, type, motion and poster ideas so no two projects match.
export async function artDirect({ project, facts, library, looks = {}, askJson, hasPicture, signal }) {
  const name = project.name;
  let sector = 'other';
  let tones = ['technical'];
  const classified = await askJson({
    system: DIRECTOR_SYSTEM,
    prompt: `What kind of project is this, and what tone should its film have?\n\n${facts.text}\n\nsector: the closest sector. tones: one or two tones that fit how the project should feel.`,
    schema: CLASSIFY_SCHEMA(library),
    signal,
  }).catch((error) => { if (signal?.aborted) throw error; return null; });
  if (library.sectors.includes(classified?.sector)) sector = classified.sector;
  const picked = (classified?.tones ?? []).filter((t) => library.tones.includes(t)).slice(0, 2);
  if (picked.length) tones = picked;

  const dealt = dealDirections(library, { name, sector, tones, hasPicture, looks });
  if (!dealt.length) throw new Error('The design library has no art directions.');
  const options = dealt.map((d) => `- ${d.id}: ${clean(d.idea, 320)} On film: ${library.grammars[d.id]?.film ?? ''}`).join('\n');
  const chosen = await askJson({
    system: DIRECTOR_SYSTEM,
    prompt: `Choose the art direction for this project's film.\n\n${facts.text}\n\nDirections:\n${options}\n\ndirection: the id that suits this project best.\nidea: one sentence on how the film carries that direction for this project.\nmemorable: the one thing a viewer should remember, in under 12 words, using only the facts above.`,
    schema: CHOOSE_SCHEMA(dealt.map((d) => d.id)),
    signal,
  }).catch((error) => { if (signal?.aborted) throw error; return null; });
  const direction = dealt.find((d) => d.id === chosen?.direction) ?? dealt[0];
  const grammar = library.grammars[direction.id];

  const random = seeded(`${name}:${direction.id}`);
  const palette = pickPalette(library, direction, { name, looks, random });
  if (!palette) throw new Error('No palette in the design library reads clearly on film.');
  const typeIds = rankTypes(library, direction, { name, looks, random });
  const motionIdea = pickIdea(library.motion, { tones, taken: othersUse(looks, name, 'motionId'), random });
  const posterIdea = pickIdea(library.posters, {
    tones, taken: othersUse(looks, name, 'posterId'), random,
    accept: (idea) => hasPicture || idea.layout !== 'screen',
  });
  const memorable = clean(chosen?.memorable, 120);
  return {
    project: name,
    sector,
    tones,
    direction: direction.id,
    idea: clean(chosen?.idea, 300) || grammar.film,
    memorable: memorable && !PLACEHOLDER.test(memorable) && !ungrounded(memorable, facts.source).length ? memorable : '',
    paletteId: palette.id,
    typeId: typeIds[0],
    typeIds,
    motionId: motionIdea?.id ?? null,
    posterId: posterIdea?.id ?? null,
    motion: motionFor(grammar, motionIdea),
    at: new Date().toISOString(),
  };
}

// ---- Storyboard -------------------------------------------------------------------------------

const SHOT_FIELDS = {
  scene: { type: 'string' },
  text: { type: 'string' }, line: { type: 'string' }, value: { type: 'string' }, label: { type: 'string' },
  caption: { type: 'string' }, title: { type: 'string' },
  items: { type: 'array', items: { type: 'string' } }, lines: { type: 'array', items: { type: 'string' } },
};

export const storyboardSchema = (scenes) => ({
  type: 'object',
  properties: {
    shots: { type: 'array', minItems: 4, maxItems: 7, items: { type: 'object', properties: { ...SHOT_FIELDS, scene: { type: 'string', enum: scenes } }, required: ['scene'] } },
    endLine: { type: 'string' },
  },
  required: ['shots', 'endLine'],
});

// Words each scene may carry: [min, max].
const LIMITS = { text: [2, 16], line: [3, 14], label: [2, 12], caption: [3, 12], title: [1, 6], item: [1, 8], field: [1, 6], marquee: [1, 5], end: [4, 16], out: [1, 8] };

// How long each scene needs on screen at tempo 1, from how much it has to say.
function baseDuration(shot) {
  switch (shot.scene) {
    case 'monument': return 2.6;
    case 'statement': return 1.6 + words(shot.text) * 0.14;
    case 'number': return 2.2 + words(shot.label) * 0.08;
    case 'screen': return 3 + words(shot.caption) * 0.06;
    case 'split': return 3 + words(shot.text) * 0.06;
    case 'terminal': return 1.6 + shot.command.length * 0.045 + shot.lines.length * 0.35;
    case 'list': return 1 + shot.items.length * 0.8;
    case 'stack': return 0.9 + shot.items.length * 0.42;
    case 'field': return 1.8;
    case 'marquee': return 2.4;
    case 'end': return 3.4;
    default: return 2.5;
  }
}

// Amounts written as words must be in the facts too: a small model turns "100%" into "ten percent".
const AMOUNT_WORDS = /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|hundreds|thousand|thousands|million|millions|billion|percent|per cent|twice|double|triple|half|dozen|dozens|first|second|third|fourth|fifth|tenth|hundredth|all|every|no|none|zero)\b/gi;
export function inventedAmounts(value, source) {
  const have = ` ${String(source).toLowerCase().replace(/%/g, ' % ').replace(/[^a-z0-9%]+/g, ' ')} `;
  const digits = (word) => ({ zero: '0', none: '0', no: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', hundred: '100', percent: '%', 'per cent': '%' })[word];
  const loose = new Set(['all', 'every', 'no', 'one', 'first', 'second', 'half']);
  return [...String(value).matchAll(AMOUNT_WORDS)].map((m) => m[0].toLowerCase())
    .filter((word) => !loose.has(word) && !have.includes(` ${word} `) && !(digits(word) && have.includes(` ${digits(word)} `)));
}

// Why the last text was refused, so a rejected storyboard can be rewritten with the reason.
let refused = '';
function fits(text, [min, max], source) {
  // Drop a facts label the model copied ("What it is: A Windows ..." -> "A Windows ...").
  const value = clean(text, 200).replace(/^["'“”]+|["'“”]+$/g, '').replace(/^(name|kind|hook|what it is|number|built with|command|link|feature|from the readme)\s*:\s*/i, '');
  const n = words(value);
  const gaps = [...ungrounded(value, source), ...inventedAmounts(value, source)];
  const why = n < min || n > max ? `"${value.slice(0, 50)}" has ${n} words, needs ${min} to ${max}`
    : PLACEHOLDER.test(value) || BRIEF_ECHO.test(value) ? `"${value.slice(0, 50)}" isn't film copy`
      : gaps.length ? `"${value.slice(0, 50)}" names ${gaps.slice(0, 2).join(', ')}, which the facts don't` : '';
  if (why) refused = why;
  // Sentence case: a lowercase first letter is lifted ("things you can do" -> "Things you can do").
  return why ? null : value.replace(/^[a-z](?=[a-z\s])/, (letter) => letter.toUpperCase());
}

// Turns Qwen's storyboard into studio shots, dropping anything that isn't true to the facts.
// Returns { shots, problems }: shots is null when too little survived.
export function normaliseStoryboard(raw, { project, facts, look, library, images = {}, author = '' }) {
  const grammar = library.grammars[look.direction];
  const allowed = new Set([...grammar.scenes, 'statement', 'list', 'number']);
  const problems = [];
  const shots = [];
  const counts = {};
  const statementSpots = ['bottom', 'top', 'middle'];
  const hasImage = (key) => Boolean(images[key]);
  for (const [index, input] of (Array.isArray(raw?.shots) ? raw.shots : []).entries()) {
    const scene = input?.scene;
    if (!allowed.has(scene) || scene === 'end') { problems.push(`shot ${index + 1} used a scene this direction doesn't have`); continue; }
    if ((counts[scene] ?? 0) >= 2) { problems.push(`shot ${index + 1} repeated ${scene} a third time`); continue; }
    if (shots.at(-1)?.scene === scene) { problems.push(`shot ${index + 1} repeated the scene before it`); continue; }
    let shot = null;
    refused = '';
    const src = facts.source;
    if (scene === 'monument') {
      const line = input.line ? fits(input.line, LIMITS.line, src) : null;
      shot = { scene, name: project.name, ...(line ? { line } : {}), variant: grammar.monument ?? 'bleed' };
    } else if (scene === 'statement') {
      const text = fits(input.text, LIMITS.text, src);
      if (text) shot = { scene, text, variant: grammar.statementVariant ?? statementSpots[(counts.statement ?? 0) % statementSpots.length] };
    } else if (scene === 'number') {
      const stat = facts.stats.find((s) => s.value.toLowerCase() === clean(input.value, 16).toLowerCase());
      if (stat) {
        const label = fits(input.label, LIMITS.label, src) ?? stat.label;
        shot = { scene, value: stat.value, label, ...(grammar.numberVariant ? { variant: grammar.numberVariant } : {}) };
      }
    } else if (scene === 'screen' || scene === 'split') {
      const image = hasImage('shot') ? 'shot' : hasImage('readme') ? 'readme' : null;
      if (image) {
        if (scene === 'screen') {
          const caption = input.caption ? fits(input.caption, LIMITS.caption, src) : null;
          shot = { scene, image, ...(caption ? { caption } : {}), variant: grammar.screenVariant ?? ((counts.screen ?? 0) % 2 ? 'full' : 'framed') };
        } else {
          const title = fits(input.title, LIMITS.title, src);
          const text = input.text ? fits(input.text, [3, 20], src) : null;
          if (title) shot = { scene, image, title, ...(text ? { text } : {}) };
        }
      }
    } else if (scene === 'terminal') {
      if (facts.command) {
        const lines = (Array.isArray(input.lines) ? input.lines : []).map((line) => fits(line, LIMITS.out, src)).filter(Boolean).slice(0, 3);
        shot = { scene, command: facts.command, lines };
      }
    } else if (scene === 'list') {
      const items = (Array.isArray(input.items) ? input.items : []).map((item) => fits(item, LIMITS.item, src)).filter(Boolean).slice(0, 4);
      const title = input.title ? fits(input.title, [1, 5], src) : null;
      if (items.length >= 3) shot = { scene, items, ...(title ? { title } : {}) };
    } else if (scene === 'stack') {
      const known = new Map(facts.stack.map((item) => [item.toLowerCase(), item]));
      const items = [...new Set((Array.isArray(input.items) ? input.items : []).map((item) => known.get(clean(item, 30).toLowerCase())).filter(Boolean))];
      const all = items.length >= 3 ? items : facts.stack;
      if (all.length >= 3) shot = { scene, items: all.slice(0, 7), line: 'Built with' };
    } else if (scene === 'field') {
      const text = fits(input.text, LIMITS.field, src);
      if (text) shot = { scene, text };
    } else if (scene === 'marquee') {
      const text = fits(input.text, LIMITS.marquee, src);
      if (text) shot = { scene, text };
    }
    if (!shot) { problems.push(`shot ${index + 1} (${scene}) was dropped${refused ? `: ${refused}` : ''}`); refused = ''; continue; }
    counts[scene] = (counts[scene] ?? 0) + 1;
    shots.push(shot);
  }

  const endLine = fits(raw?.endLine, LIMITS.end, facts.source) ?? fits(project.tagline, [3, 20], facts.source) ?? '';
  const endLayout = grammar.end === 'screen' && !hasImage('shot') && !hasImage('readme') ? 'monument' : grammar.end;
  shots.push({ scene: 'end', layout: endLayout, name: project.name, line: endLine, link: facts.link, author, image: hasImage('shot') ? 'shot' : 'readme' });

  const tempo = look.motion?.tempo ?? 1;
  for (const shot of shots) shot.d = Number(Math.min(6, Math.max(1.4, baseDuration(shot) / tempo)).toFixed(2));
  // Keep the film between 12 and 24 seconds: trim from the middle, never the opening or the end.
  while (shots.length > 5 && shots.reduce((sum, s) => sum + s.d, 0) > 24) shots.splice(shots.length - 2, 1);

  const distinct = new Set(shots.map((s) => s.scene)).size;
  if (shots.length < 4) return { shots: null, problems: [...problems, 'fewer than three shots survived the checks'] };
  if (distinct < 3) return { shots: null, problems: [...problems, 'the film needs at least two different scenes before the end card'] };
  return { shots, problems };
}

// How alike two storyboards read (shared words over all distinct words); 1 is identical.
export function similarity(a, b) {
  const bag = (shots) => new Set(shots.flatMap((s) => [s.text, s.line, s.label, s.caption, s.title, ...(s.items ?? [])]).filter(Boolean).join(' ').toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const x = bag(a);
  const y = bag(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / (x.size + y.size - shared);
}

const WRITER_SYSTEM = 'You are the editor of a small motion design studio. You storyboard 15 to 20 second films about software projects for LinkedIn. You use only the facts you are given, word for word where you can. You write plain, specific sentences in sentence case: no hype, no emoji, no hashtags, no questions to the viewer, no made-up numbers. Answer only with the requested JSON.';

export function storyboardPrompt({ facts, look, library, history = [], feedback = '', images = {} }) {
  const grammar = library.grammars[look.direction];
  const picture = Boolean(images.shot || images.readme);
  // Only scenes this project can fill: no picture scenes without a screenshot, and so on.
  let scenes = grammar.scenes.filter((s) => s !== 'end' && (s !== 'terminal' || facts.command) && (s !== 'stack' || facts.stack.length >= 3) && (s !== 'number' || facts.stats.length) && (picture || !['screen', 'split'].includes(s)));
  if (scenes.length < 3) scenes = [...new Set([...scenes, 'statement', 'list', ...(facts.stats.length ? ['number'] : [])])];
  const catalogue = scenes.map((s) => `- ${s}: ${library.scenes[s]?.use ?? ''} Fill: ${Object.entries(library.scenes[s]?.slots ?? {}).map(([k, v]) => `${k} (${v})`).join(', ')}`).join('\n');
  const before = history.slice(-2).map((shots, i) => `Film ${i + 1}: ${shots.filter((s) => s.scene !== 'end').map((s) => `${s.scene}: ${s.text ?? s.line ?? s.label ?? s.caption ?? s.title ?? (s.items ?? []).join(', ')}`).join(' | ')}`).join('\n');
  return {
    scenes,
    prompt: [
      `Storyboard a film about ${facts.name}.`,
      `Facts (the only things the film may say):\n${facts.text}`,
      facts.post ? `Today's LinkedIn post about it (the film should tell the same story):\n${facts.post}` : '',
      `Art direction: ${look.direction}. ${grammar.film}`,
      look.idea ? `The idea for this project: ${look.idea}` : '',
      look.memorable ? `The one thing to remember: ${look.memorable}` : '',
      `Scenes you may use:\n${catalogue}`,
      `Rules: 4 to 6 shots, then the end card is added for you. Open with ${grammar.open.filter((s) => scenes.includes(s)).join(' or ') || scenes[0]}. Use at least three different scenes and never the same scene twice in a row. Fill only the fields that scene uses. Keep every number and name exactly as the facts write it (100% stays 100%, F9 stays F9). endLine: one sentence for the end card saying what ${facts.name} is.`,
      before ? `Earlier films about this project (say it differently this time):\n${before}` : '',
      feedback ? `The last storyboard was rejected: ${feedback}. Fix that.` : '',
    ].filter(Boolean).join('\n\n'),
  };
}

export async function writeStoryboard({ project, facts, look, library, images, author, askJson, history = [], feedback = '', signal }) {
  const { scenes, prompt } = storyboardPrompt({ facts, look, library, history, feedback, images });
  const raw = await askJson({ system: WRITER_SYSTEM, prompt, schema: storyboardSchema(scenes), signal });
  const result = normaliseStoryboard(raw, { project, facts, look, library, images, author });
  if (result.shots && history.some((old) => similarity(old, result.shots) > 0.6)) {
    return { shots: null, problems: [...result.problems, 'it repeated an earlier film almost word for word'] };
  }
  return result;
}

// A storyboard made by code alone from the facts, used when Qwen's drafts keep failing.
export function fallbackStoryboard({ project, facts, look, library, images = {}, author = '' }) {
  const grammar = library.grammars[look.direction];
  const picture = images.shot ? 'shot' : images.readme ? 'readme' : null;
  const proposals = {
    monument: { scene: 'monument', line: project.tagline },
    statement: { scene: 'statement', text: project.hook ?? project.tagline },
    number: facts.stats[0] ? { scene: 'number', value: facts.stats[0].value, label: facts.stats[0].label } : null,
    screen: picture ? { scene: 'screen', caption: '' } : null,
    split: picture ? { scene: 'split', title: project.name, text: project.tagline } : null,
    terminal: facts.command ? { scene: 'terminal', lines: [] } : null,
    stack: facts.stack.length >= 3 ? { scene: 'stack', items: facts.stack } : null,
    list: (project.features ?? []).length >= 3 ? { scene: 'list', items: project.features.slice(0, 3) } : null,
    field: { scene: 'field', text: project.name },
    marquee: { scene: 'marquee', text: project.name },
  };
  const order = [...new Set([...grammar.open, ...grammar.scenes, 'statement', 'monument', 'number', 'stack', 'field'])].filter((s) => s !== 'end');
  const raw = { shots: order.map((s) => proposals[s]).filter(Boolean).slice(0, 5), endLine: project.tagline };
  const result = normaliseStoryboard(raw, { project, facts, look, library, images, author });
  if (result.shots) return result.shots;
  // The last resort always works: the name, the promise and the end card.
  return [
    { scene: 'monument', name: project.name, variant: 'bleed', d: 2.6 },
    { scene: 'statement', text: clean(project.hook ?? project.tagline, 140), variant: 'bottom', d: 3 },
    { scene: 'end', layout: 'monument', name: project.name, line: clean(project.tagline, 140), link: facts.link, author, d: 3.4 },
  ];
}

// ---- Films ------------------------------------------------------------------------------------

// The studio film for a look and its shots, given the type system that loaded.
export function filmFor({ look, library, shots, typeSystem, displaySettings }) {
  const p = library.palettes.find((item) => item.id === look.paletteId);
  const field = p.fields?.[0];
  return {
    tokens: { bg: p.bg, surface: p.surface, ink: p.ink, muted: p.muted, accent: p.accent, accentInk: p.accentInk, fieldBg: field?.bg ?? p.ink, fieldInk: field?.ink ?? p.bg },
    type: typeSystem ? {
      display: { family: typeSystem.display.family, weight: displaySettings.weight ?? typeSystem.display.weights[0], tracking: displaySettings.tracking, leading: displaySettings.leading,
        // All-lowercase mangles product names (Spotify, F9), so only capitals carry over from the type system.
        case: displaySettings.case === 'uppercase' ? 'uppercase' : 'none' },
      text: { family: typeSystem.text.family, weight: typeSystem.text.weights.includes(400) ? 400 : typeSystem.text.weights[0] },
    } : {},
    motion: look.motion,
    shots,
  };
}

// The poster: the end card on its own, laid out by the project's poster idea.
export function posterShots({ look, library, shots }) {
  const idea = library.posters.find((item) => item.id === look.posterId);
  const end = shots.at(-1);
  const layout = idea?.layout === 'screen' && end.layout !== 'screen' && !end.image ? 'monument' : (idea?.layout ?? end.layout);
  return [{ ...end, layout, tone: idea?.tone ?? 'bg', d: 2.4 }];
}

// ---- Critique ---------------------------------------------------------------------------------

export const CRITIQUE_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer', minimum: 1, maximum: 10 },
    problems: { type: 'array', items: { type: 'string' }, maxItems: 4 },
  },
  required: ['score', 'problems'],
};

export const CRITIQUE_PROMPT = 'These are frames from a short motion design film about a software project, in order. Judge them like a strict design lead. Look for: text cut off at the frame edge when it is not meant to bleed, text overlapping other text or pictures, words too small to read on a phone, empty or broken frames, a screenshot that is blank or shows an error page, clashing colours. Do not judge the wording. score: 1 to 10, where 7 means good enough to post. problems: the concrete visual problems you see, each under 15 words; an empty list when there are none.';
