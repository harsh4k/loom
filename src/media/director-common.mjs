export const clean = (value, limit = 400) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
export const words = (value) => clean(value).split(' ').filter(Boolean).length;
export const MOTIFS = Object.freeze(['orbit', 'bars', 'tiles']);
export const motifFor = (value, fallback = 'orbit') => MOTIFS.includes(value) ? value : MOTIFS.includes(fallback) ? fallback : 'orbit';
export const PLACEHOLDER = /[[\]{}<>#@]|\bTODO\b|\bTBD\b|lorem|ipsum|placeholder|example\.com|https?:\/\/|www\.|\p{Extended_Pictographic}/iu;
// Words from the brief itself, which a small model sometimes copies into the film.
export const BRIEF_ECHO = /\b(scene|shots?|caption|storyboard|end ?card|end ?line|open with|fill only|the facts)\b/i;

