import { motifFor } from './director-common.mjs';
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

// A dedicated poster composition, with sourced evidence and the project's graphic motif.
export function posterShots({ look, library, shots }) {
  const idea = library.posters.find((item) => item.id === look.posterId);
  const end = shots.at(-1);
  const layout = idea?.layout === 'screen' && end.layout !== 'screen' && !end.image ? 'monument' : (idea?.layout ?? end.layout);
  const key = (text) => String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const evidence = shots.filter((shot) => shot.scene !== 'end').flatMap((shot) => [shot.caption, ...(shot.items ?? []), shot.scene === 'number' ? `${shot.value} ${shot.label}` : shot.text]).filter((text) => text && key(text) !== key(end.name));
  const concise = evidence.filter((text) => text.length <= 95 && text.split(/\s+/).length >= 2 && text.split(/\s+/).length <= 12);
  // Reuse a complete sourced shot, never truncate a sentence or invent a new headline.
  const line = concise.find((text) => /\d/.test(text)) ?? concise[0] ?? end.line;
  const seen = new Set([key(line)]);
  const supporting = evidence.filter((text) => { const value = key(text); if (seen.has(value)) return false; seen.add(value); return true; });
  return [{ ...end, line, scene: 'poster', layout, motif: motifFor(look.motif), evidence: supporting.slice(0, 2), tone: idea?.tone ?? 'bg', d: 3.2 }];
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
