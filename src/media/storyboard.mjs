import { ungrounded } from '../details/check.mjs';
import { clean, words, PLACEHOLDER, BRIEF_ECHO, MOTIFS, motifFor } from './director-common.mjs';
import { unsupportedClaim } from './claims.mjs';
const SHOT_FIELDS = {
  motif: { type: 'string', enum: MOTIFS },
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
    case 'statement': case 'signal': case 'kinetic': return 2 + words(shot.text) * 0.14;
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
  const why = unsupportedClaim(value, source) || (n < min || n > max ? `"${value.slice(0, 50)}" has ${n} words, needs ${min} to ${max}`
    : PLACEHOLDER.test(value) || BRIEF_ECHO.test(value) ? `"${value.slice(0, 50)}" isn't film copy`
      : gaps.length ? `"${value.slice(0, 50)}" names ${gaps.slice(0, 2).join(', ')}, which the facts don't` : '');
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
    if (scene === 'signal' || scene === 'kinetic') {
      const text = fits(input.text, scene === 'kinetic' ? [3, 10] : LIMITS.text, src);
      if (text) shot = { scene, text, name: project.name, ...(scene === 'signal' ? { motif: motifFor(input.motif, look.motif) } : {}) };
    } else if (scene === 'monument') {
      const line = input.line ? fits(input.line, LIMITS.line, src) : null;
      shot = { scene, name: project.name, ...(line ? { line } : {}), variant: grammar.monument ?? 'bleed' };
    } else if (scene === 'statement') {
      const text = fits(input.text, LIMITS.text, src);
      if (text) shot = { scene, text, variant: grammar.statementVariant ?? statementSpots[(counts.statement ?? 0) % statementSpots.length] };
    } else if (scene === 'number') {
      const stat = facts.stats.find((s) => s.value.toLowerCase() === clean(input.value, 16).toLowerCase());
      if (stat) {
        // A source number cannot acquire a different meaning from model-written copy.
        const label = stat.label;
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
      `Abstract visual metaphor: ${motifFor(look.motif)}. Signal shots may choose orbit, bars or tiles; these are editorial graphics, never measured data or simulated product output.`,
      look.idea ? `The idea for this project: ${look.idea}` : '',
      look.memorable ? `The one thing to remember: ${look.memorable}` : '',
      `Scenes you may use:\n${catalogue}`,
      scenes.some((scene) => ['signal', 'kinetic'].includes(scene)) ? 'Realize the art direction with at least one signal or kinetic composition. Abstract graphics are visual metaphors, never evidence of a technical architecture or measured result.' : '',
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
  if (result.shots && scenes.some((scene) => ['signal', 'kinetic'].includes(scene)) && !result.shots.some((shot) => ['signal', 'kinetic'].includes(shot.scene))) {
    return { shots: null, problems: [...result.problems, 'Use a signal or kinetic composition to realize the expressive direction.'] };
  }
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
    signal: { scene: 'signal', text: project.hook ?? project.tagline, motif: motifFor(look.motif) },
    kinetic: { scene: 'kinetic', text: project.hook ?? project.tagline },
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

