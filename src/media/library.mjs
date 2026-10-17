// Loom's design library: everything the art director may choose from.
// - Art directions, palettes and type systems come from the design-taste skill on this PC
//   (profile design.tasteDir), with a bundled copy in media/library/taste as a fallback.
// - Film grammars, the scene catalogue and the seed motion and poster ideas live in media/library.
// - Ideas the inspiration fetcher found on the web are added from data/inspo/cards.json.
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LIBRARY_DIR = path.resolve(import.meta.dirname, '../../media/library');
export const INSPO_FILE = path.resolve(import.meta.dirname, '../../data/inspo/cards.json');
export const DEFAULT_TASTE_DIR = path.join(os.homedir(), '.agents', 'skills', 'design-taste', 'library');

const HEX = /^#[0-9a-f]{6}$/i;
const FONT_SOURCES = new Set(['google', 'fontshare']);

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

// The design-taste files, preferring the live skill over the bundled copy, file by file.
function tasteFile(name, tasteDir) {
  for (const dir of [tasteDir, path.join(LIBRARY_DIR, 'taste')]) {
    if (!dir) continue;
    const file = path.join(dir, `${name}.json`);
    if (!existsSync(file)) continue;
    const value = readJson(file, null);
    if (Array.isArray(value) && value.length) return value;
  }
  return [];
}

const validPalette = (p) => p && typeof p.id === 'string' && ['bg', 'surface', 'ink', 'muted', 'accent', 'accentInk'].every((key) => HEX.test(p[key] ?? ''));
const validFace = (face) => face && typeof face.family === 'string' && FONT_SOURCES.has(face.source) && Array.isArray(face.weights) && face.weights.length > 0;
const validType = (t) => t && typeof t.id === 'string' && validFace(t.display) && validFace(t.text);

// A palette pulled from a fetched site, shaped like a design-taste palette.
function inspoPalette(card) {
  const p = card?.palette;
  if (!p || !['bg', 'surface', 'ink', 'muted', 'accent', 'accentInk'].every((key) => HEX.test(p[key] ?? ''))) return null;
  return { id: `inspo-${card.id}`, name: card.title ?? card.id, tags: Array.isArray(p.tags) ? p.tags : [], ...p, fields: HEX.test(p.fieldBg ?? '') && HEX.test(p.fieldInk ?? '') ? [{ bg: p.fieldBg, ink: p.fieldInk }] : [], note: `From ${card.url ?? 'the web'}`, from: 'inspo' };
}

export function loadLibrary({ tasteDir = DEFAULT_TASTE_DIR, libraryDir = LIBRARY_DIR, inspoFile = INSPO_FILE } = {}) {
  const grammars = readJson(path.join(libraryDir, 'grammars.json'), {});
  const scenes = readJson(path.join(libraryDir, 'scenes.json'), {});
  const directions = tasteFile('directions', tasteDir).filter((d) => d && grammars[d.id]);
  const palettes = tasteFile('palettes', tasteDir).filter(validPalette);
  const types = tasteFile('type', tasteDir).filter(validType);
  const motion = readJson(path.join(libraryDir, 'motion.json'), {}).ideas ?? [];
  const posters = readJson(path.join(libraryDir, 'poster.json'), {}).ideas ?? [];

  const cards = readJson(inspoFile, {}).cards ?? [];
  const fetched = Array.isArray(cards) ? cards.filter((card) => card && typeof card.id === 'string') : [];
  for (const card of fetched) {
    if (card.motion?.knobs) motion.push({ ...card.motion, id: `inspo-${card.id}`, from: card.url, tones: card.tones ?? [], fetched: true });
    if (card.poster?.layout) posters.push({ ...card.poster, id: `inspo-${card.id}`, from: card.url, tones: card.tones ?? [], fetched: true });
    const palette = inspoPalette(card);
    if (palette) palettes.push(palette);
  }

  return {
    directions,
    palettes,
    types,
    grammars: Object.fromEntries(Object.entries(grammars).filter(([key]) => !key.startsWith('_'))),
    scenes: Object.fromEntries(Object.entries(scenes).filter(([key]) => !key.startsWith('_'))),
    motion: motion.filter((idea) => idea?.id && idea.knobs),
    posters: posters.filter((idea) => idea?.id && ['monument', 'statement', 'screen'].includes(idea.layout)),
    inspo: fetched,
    tones: [...new Set(directions.flatMap((d) => d.tones ?? []))],
    sectors: [...new Set(directions.flatMap((d) => d.sectors ?? []))],
  };
}

// How many ideas no project has used yet; the fetcher tops the library up when this runs low.
export function unusedIdeas(library, looks = {}) {
  const used = new Set(Object.values(looks).flatMap((look) => [look?.motionId, look?.posterId]).filter(Boolean));
  return {
    motion: library.motion.filter((idea) => !used.has(idea.id)).length,
    posters: library.posters.filter((idea) => !used.has(idea.id)).length,
  };
}
