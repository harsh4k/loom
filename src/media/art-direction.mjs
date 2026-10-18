import { ungrounded } from '../details/check.mjs';
import { clean, PLACEHOLDER, MOTIFS, motifFor } from './director-common.mjs';
import { unsupportedClaim } from './claims.mjs';
export const LOOK_VERSION = 3;
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
    motif: { type: 'string', enum: MOTIFS },
  },
  required: ['direction', 'idea', 'memorable', 'motif'],
});

const othersUse = (looks, name, key) => new Set(Object.entries(looks).filter(([other]) => other !== name).flatMap(([, look]) => [].concat(look?.[key] ?? [])));

// The directions worth offering Qwen: matching sector and tone first, ones other projects
// already use last, so every project ends up looking different.
export function dealDirections(library, { name, sector, tones, hasPicture, looks = {} }) {
  const taken = othersUse(looks, name, 'direction');
  const random = seeded(`${name}:directions`);
  // Expressiveness must be executable by the scene grammar, not just promised in prose.
  const expressive = library.directions.filter((d) => library.grammars[d.id]?.scenes.some((scene) => ['signal', 'kinetic'].includes(scene)));
  const candidates = expressive.length >= DEAL ? expressive : library.directions;
  const scored = shuffle(candidates, random)
    .filter((d) => hasPicture || !NEEDS_PICTURE.has(d.id))
    .map((d) => ({ d, score: (d.sectors?.includes(sector) ? 3 : 0) + (d.tones ?? []).filter((t) => tones.includes(t)).length * 2 - (taken.has(d.id) ? 5 : 0) }))
    .sort((a, b) => Number(taken.has(a.d.id)) - Number(taken.has(b.d.id)) || b.score - a.score);
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

const DIRECTOR_SYSTEM = 'You are the art director of a small motion design studio. You make distinctive, expressive, precisely composed films about software projects for LinkedIn. You choose by the project, never by habit. Answer only with the requested JSON.';

// Decides a project's look once. Qwen classifies the project and picks one of the dealt
// directions; code deals palette, type, motion and poster ideas so no two projects match.
export async function artDirect({ project, facts, library, looks = {}, askJson, hasPicture, signal }) {
  const name = project.name;
  let sector = 'other';
  let tones = ['technical'];
  const classified = await askJson({
    system: DIRECTOR_SYSTEM,
    prompt: `Classify the project's actual functionality, not its author's portfolio or marketing audience. What kind of project is this, and what tone should its film have?\n\n${facts.text}\n\nsector: the closest sector. tones: one or two tones that fit how the project should feel.`,
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
    prompt: `Choose the art direction for this project's film.\n\n${facts.text}\n\nDirections:\n${options}\n\ndirection: the id that suits this project best.\nidea: one sentence on how the film carries that direction for this project.\nmemorable: the one thing a viewer should remember, in under 12 words, using only the facts above.\nmotif: choose orbit (concentric orbits), bars (abstract rhythmic columns), or tiles (offset geometric blocks). These are editorial visual metaphors, never measured data, a real architecture diagram or product output.`,
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
    version: LOOK_VERSION,
    project: name,
    sector,
    tones,
    direction: direction.id,
    motif: motifFor(chosen?.motif, MOTIFS[Math.floor(seeded(`${name}:motif`)() * MOTIFS.length)]),
    idea: clean(chosen?.idea, 300) || grammar.film,
    memorable: memorable && !PLACEHOLDER.test(memorable) && !ungrounded(memorable, facts.source).length && !unsupportedClaim(memorable, facts.source) ? memorable : '',
    paletteId: palette.id,
    typeId: typeIds[0],
    typeIds,
    motionId: motionIdea?.id ?? null,
    posterId: posterIdea?.id ?? null,
    motion: motionFor(grammar, motionIdea),
    at: new Date().toISOString(),
  };
}

