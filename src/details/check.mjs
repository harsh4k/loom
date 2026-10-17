// The output checks for model-written project details. Text that fails is dropped, never shown.
// - Fixed shape and length limits.
// - No brackets, placeholders, TODOs or links.
// - Every name, number and tech term must appear in the source text (README, manifests, commits).

export const SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    description: { type: 'string' },
    features: { type: 'array', items: { type: 'string' } },
  },
  required: ['description', 'features'],
});

const LIMITS = { description: [40, 300], feature: [8, 140], features: [3, 6] };
const PLACEHOLDER = /[[\]{}<>]|\bTODO\b|\bTBD\b|\bFIXME\b|lorem|ipsum|placeholder|example\.com|your[ -]project|\bxxx+\b|https?:\/\/|www\./i;
// Capitalised words that are ordinary English rather than names, so they need no source.
const COMMON = new Set(`a an the it its this that these those and or but with without for from into onto in on of to by as at via
is are was were be built uses use using lets let allows helps provides supports includes adds shows tracks runs keeps makes
users user you your app apps site website platform tool tools project page pages data real time local fast simple modern
full stack frontend backend api apis web mobile desktop dashboard live clean responsive dark light mode open source
one two three four five six multiple each every all any custom smooth interactive animated secure offline online
github readme`.split(/\s+/));

const tokenise = (text) => text.toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ').replace(/\.(\s|$)/g, ' ');

// The words in `text` that look like names or numbers and are not found in the sources.
export function ungrounded(text, sourceText) {
  const source = ` ${tokenise(sourceText)} `;
  const missing = [];
  const sentences = text.split(/(?<=[.!?])\s+|\n/);
  for (const sentence of sentences) {
    const words = sentence.split(/\s+/).filter(Boolean);
    words.forEach((raw, index) => {
      const word = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9+#]+$/g, '');
      if (!word) return;
      const named = /\d/.test(word) || (/[A-Z]/.test(word) && (index > 0 || /[A-Z].*[A-Z]|[a-z][A-Z]/.test(word)));
      if (!named || COMMON.has(word.toLowerCase())) return;
      const plain = tokenise(word).trim();
      if (!plain || source.includes(` ${plain} `) || source.includes(` ${plain}`)) return;
      missing.push(word);
    });
  }
  return missing;
}

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

// Returns { ok: true, description, features, dropped } or { ok: false, reason }.
export function checkDetails(output, sourceText) {
  if (!output || typeof output !== 'object') return { ok: false, reason: 'Qwen didn’t answer with the expected JSON.' };
  const description = clean(output.description);
  const [minDesc, maxDesc] = LIMITS.description;
  if (description.length < minDesc || description.length > maxDesc) return { ok: false, reason: `the description was ${description.length} characters` };
  if (PLACEHOLDER.test(description)) return { ok: false, reason: 'the description had placeholder text' };
  const descriptionGaps = ungrounded(description, sourceText);
  if (descriptionGaps.length) return { ok: false, reason: `the description named things not in the repo (${descriptionGaps.slice(0, 3).join(', ')})` };

  const dropped = [];
  const features = [];
  for (const raw of Array.isArray(output.features) ? output.features : []) {
    const feature = clean(raw).replace(/^[-•*]\s*/, '');
    const [min, max] = LIMITS.feature;
    if (feature.length < min || feature.length > max || PLACEHOLDER.test(feature) || ungrounded(feature, sourceText).length) { dropped.push(feature); continue; }
    if (!features.some((kept) => kept.toLowerCase() === feature.toLowerCase())) features.push(feature);
  }
  const [minFeatures, maxFeatures] = LIMITS.features;
  if (features.length < minFeatures) return { ok: false, reason: `only ${features.length} features passed the checks` };
  return { ok: true, description, features: features.slice(0, maxFeatures), dropped };
}
