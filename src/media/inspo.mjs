// The inspiration fetcher: keeps Loom's design library growing with new work from public
// web-design galleries. For each new site it reads the gallery's preview image:
// - code pulls a palette out of the pixels (ffmpeg shrinks the image to raw RGB) and checks contrast;
// - Qwen looks at the picture and writes a motion idea and a poster idea in the studio's terms.
// Cards land in data/inspo/cards.json, which loadLibrary() reads. One request per feed, a handful
// of images per run, and every card names where it came from.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { contrast, paletteReadable } from './director.mjs';

export const FEEDS = Object.freeze([
  { id: 'onepagelove', url: 'https://onepagelove.com/feed' },
  { id: 'minimal-gallery', url: 'https://minimal.gallery/feed/' },
  { id: 'siteinspire', url: 'https://www.siteinspire.com/websites/feed' },
]);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Loom design library (personal, runs weekly)';
const IMAGE_LIMIT = 4 * 1024 * 1024;
const KEEP = 300;

const decode = (text) => String(text ?? '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'");
const tag = (xml, name) => decode(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml)?.[1] ?? '').trim();
const plain = (html) => decode(html).replace(/<[^>]+>/g, ' ').replace(/\bFull Review\b/g, '').replace(/\s+/g, ' ').trim();
const slug = (value) => String(value).toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

// The newest entries of a gallery feed: title, page link, preview image and any description.
export function parseFeed(xml, source) {
  const items = [];
  for (const match of String(xml).matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const item = match[0];
    const link = tag(item, 'link');
    const media = /<media:content[^>]*url="([^"]+)"/i.exec(item)?.[1];
    const img = /<img[^>]+src="([^"]+)"/i.exec(decode(item))?.[1];
    const image = decode(media ?? img ?? '');
    if (!/^https:\/\//.test(link) || !/^https:\/\//.test(image)) continue;
    items.push({
      id: slug(link),
      source,
      title: plain(tag(item, 'title')).replace(/^Website Inspiration:\s*/i, '').slice(0, 80),
      url: link,
      image,
      about: plain(tag(item, 'description')).slice(0, 500),
      categories: [...item.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/gi)].map((m) => plain(m[1])).filter(Boolean).slice(0, 8),
    });
  }
  return items;
}

// ---- Colour ---------------------------------------------------------------------------------

const hex = ([r, g, b]) => `#${[r, g, b].map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('')}`;
const mix = (a, b, t) => a.map((c, i) => c + (b[i] - c) * t);
const rgb = (value) => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
function saturation([r, g, b]) {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  return max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
}

// A studio palette from raw RGB pixels: the most common colour is the ground, the most common
// strongly contrasting one the ink, the most common saturated one the accent. null when the
// result wouldn't read clearly on film.
export function extractPalette(pixels) {
  const buckets = new Map();
  let total = 0;
  for (let i = 0; i + 2 < pixels.length; i += 3) {
    const key = ((pixels[i] >> 3) << 10) | ((pixels[i + 1] >> 3) << 5) | (pixels[i + 2] >> 3);
    const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bucket.n += 1; bucket.r += pixels[i]; bucket.g += pixels[i + 1]; bucket.b += pixels[i + 2];
    buckets.set(key, bucket);
    total += 1;
  }
  if (!total) return null;
  const colours = [...buckets.values()].sort((a, b) => b.n - a.n).map((b) => ({ n: b.n / total, c: [b.r / b.n, b.g / b.n, b.b / b.n] }));
  const bg = colours[0].c;
  const bgHex = hex(bg);
  const ink = colours.find((item) => item.n > 0.002 && contrast(hex(item.c), bgHex) >= 7)?.c
    ?? (contrast('#111111', bgHex) > contrast('#f5f5f5', bgHex) ? rgb('#111111') : rgb('#f5f5f5'));
  const inkHex = hex(ink);
  const accent = colours.find((item) => item.n > 0.003 && saturation(item.c) > 0.45 && contrast(hex(item.c), bgHex) >= 1.5 && contrast(hex(item.c), inkHex) >= 1.5)?.c;
  if (!accent) return null;
  const accentHex = hex(accent);
  const accentInk = [inkHex, bgHex, '#ffffff', '#111111'].sort((a, b) => contrast(b, accentHex) - contrast(a, accentHex))[0];
  let muted = hex(mix(bg, ink, 0.6));
  if (contrast(muted, bgHex) < 3.2) muted = hex(mix(bg, ink, 0.72));
  const dark = contrast('#000000', bgHex) < contrast('#ffffff', bgHex);
  const palette = {
    bg: bgHex, surface: hex(mix(bg, ink, 0.06)), ink: inkHex, muted, accent: accentHex, accentInk,
    fieldBg: inkHex, fieldInk: bgHex, fields: [{ bg: inkHex, ink: bgHex }],
    tags: [dark ? 'dark-neutral' : 'light-neutral', 'mono-accent'],
  };
  return paletteReadable(palette) ? palette : null;
}

// ---- Qwen's reading of the picture ----------------------------------------------------------

export const CARD_SCHEMA = {
  type: 'object',
  properties: {
    tones: { type: 'array', items: { type: 'string', enum: ['bold', 'editorial', 'luxury', 'playful', 'quiet', 'warm', 'technical'] }, minItems: 1, maxItems: 2 },
    typeFeel: { type: 'string', enum: ['grotesk-tight', 'grotesk-light', 'condensed-heavy', 'extended-heavy', 'heavy-black', 'geometric', 'rounded-friendly', 'serif-display', 'serif-light-large', 'serif-text', 'slab'] },
    composition: { type: 'string' },
    motion: {
      type: 'object',
      properties: {
        name: { type: 'string' }, idea: { type: 'string' },
        reveal: { type: 'string', enum: ['rise', 'slide', 'fade', 'scale', 'type'] },
        ease: { type: 'string', enum: ['sharp', 'smooth', 'soft', 'snap'] },
        transition: { type: 'string', enum: ['cut', 'mask', 'wipe', 'push'] },
        drift: { type: 'string', enum: ['none', 'push', 'pan'] },
        pace: { type: 'string', enum: ['slow', 'steady', 'quick'] },
      },
      required: ['name', 'idea', 'reveal', 'ease', 'transition', 'drift', 'pace'],
    },
    poster: {
      type: 'object',
      properties: {
        name: { type: 'string' }, idea: { type: 'string' },
        layout: { type: 'string', enum: ['monument', 'statement', 'screen'] },
        tone: { type: 'string', enum: ['bg', 'surface', 'field'] },
      },
      required: ['name', 'idea', 'layout', 'tone'],
    },
  },
  required: ['tones', 'typeFeel', 'composition', 'motion', 'poster'],
};

const PACE = { slow: { tempo: 0.8, stagger: 1.4 }, steady: { tempo: 1, stagger: 1 }, quick: { tempo: 1.25, stagger: 0.7 } };
const short = (value, limit) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
const sentence = (value, limit) => short(value, limit).replace(/^\p{Ll}/u, (c) => c.toUpperCase());

// Turns Qwen's reading into a library card, or null when it is unusable.
export function cardFrom(item, reading, palette) {
  const m = reading?.motion;
  const p = reading?.poster;
  if (!m || !p || !short(m.idea, 10) || !short(p.idea, 10)) return null;
  const pace = PACE[m.pace] ?? PACE.steady;
  return {
    id: item.id,
    source: item.source,
    title: item.title,
    url: item.url,
    image: item.image,
    at: new Date().toISOString(),
    tones: [...new Set(reading.tones ?? [])].slice(0, 2),
    typeFeel: reading.typeFeel ?? null,
    composition: short(reading.composition, 300),
    palette: palette ?? null,
    motion: { name: short(m.name, 40) || item.title, idea: sentence(m.idea, 240), knobs: { reveal: m.reveal, ease: m.ease, transition: m.transition, drift: m.drift, tempo: pace.tempo, stagger: pace.stagger } },
    poster: { name: short(p.name, 40) || item.title, idea: sentence(p.idea, 240), layout: p.layout, tone: p.tone },
  };
}

const READ_PROMPT = (item) => `This is the opening screen of a website featured in a web design gallery: "${item.title}".${item.about ? ` The gallery says: ${item.about}` : ''}

You are building a library of ideas for short motion design films and posters about software projects. Study the picture.
tones: one or two tones it has. typeFeel: the closest kind of headline typeface. composition: one sentence on how the page is composed.
motion: if this page were a 15 second film, how would it move? name: two or three words. idea: one sentence. Then pick reveal, ease, transition, drift and pace.
poster: a still poster that borrows this page's composition. name: two or three words. idea: one sentence. layout: monument (the name huge), statement (a sentence large) or screen (a product picture framed). tone: bg, surface or field.`;

// ---- The job ----------------------------------------------------------------------------------

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

// run({ want, signal, report }) fetches up to `want` new cards and returns { added, skipped, total }.
export function createInspoFetcher({ askJson, file, workDir, run, ffmpeg = 'ffmpeg', fetch: fetchImpl = fetch, feeds = FEEDS }) {
  async function pixels(imageFile, signal) {
    const raw = path.join(workDir, 'pixels.rgb');
    const result = await run(ffmpeg, ['-loglevel', 'error', '-y', '-i', imageFile, '-vf', 'scale=160:100', '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw], { signal, timeoutMs: 60_000 });
    if (result.code !== 0) return null;
    return readFile(raw).catch(() => null);
  }
  // A small copy for Qwen to look at: full-size gallery shots make vision slow on a busy PC.
  async function small(imageFile, signal) {
    const out = path.join(workDir, 'small.jpg');
    const result = await run(ffmpeg, ['-loglevel', 'error', '-y', '-i', imageFile, '-vf', 'scale=768:-2', '-q:v', '4', out], { signal, timeoutMs: 60_000 });
    if (result.code !== 0) return null;
    return readFile(out).catch(() => null);
  }

  return async function fetchInspiration({ want = 4, signal, report = () => {} } = {}) {
    const store = await readJson(file, { cards: [], seen: [] });
    const cards = Array.isArray(store.cards) ? store.cards : [];
    const seen = new Set([...(store.seen ?? []), ...cards.map((card) => card.id)]);
    await mkdir(workDir, { recursive: true });
    const fresh = [];
    for (const feed of feeds) {
      try {
        const response = await fetchImpl(feed.url, { headers: { 'User-Agent': UA }, signal: signal ?? AbortSignal.timeout(30_000) });
        if (response.ok) fresh.push(...parseFeed(await response.text(), feed.id).filter((item) => !seen.has(item.id)));
      } catch (error) { if (signal?.aborted) throw error; }
    }
    // Take turns between galleries so one source never fills the library.
    const queue = [];
    for (let i = 0; queue.length < fresh.length; i += 1) for (const feed of feeds) { const item = fresh.filter((x) => x.source === feed.id)[i]; if (item) queue.push(item); }

    let added = 0;
    let skipped = 0;
    for (const item of queue) {
      if (added >= want || signal?.aborted) break;
      seen.add(item.id);
      report(`Studying ${item.title} from ${item.source}.`);
      try {
        const response = await fetchImpl(item.image, { headers: { 'User-Agent': UA }, signal: signal ?? AbortSignal.timeout(30_000) });
        const type = response.headers.get('content-type') ?? '';
        const bytes = response.ok && /^image\/(jpeg|png|webp)/.test(type) ? Buffer.from(await response.arrayBuffer()) : null;
        if (!bytes || bytes.length < 2048 || bytes.length > IMAGE_LIMIT) { skipped += 1; continue; }
        const imageFile = path.join(workDir, `preview${type.includes('png') ? '.png' : type.includes('webp') ? '.webp' : '.jpg'}`);
        await writeFile(imageFile, bytes);
        const rgbPixels = await pixels(imageFile, signal);
        const palette = rgbPixels ? extractPalette(rgbPixels) : null;
        const reading = await askJson({ system: 'You are an art director studying web design for ideas. Answer only with the requested JSON.', prompt: READ_PROMPT(item), schema: CARD_SCHEMA, images: [((await small(imageFile, signal)) ?? bytes).toString('base64')], temperature: 0.4, signal });
        const card = cardFrom(item, reading, palette);
        if (!card) { skipped += 1; continue; }
        cards.push(card);
        added += 1;
      } catch (error) {
        if (signal?.aborted) throw error;
        skipped += 1;
      }
    }
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    const next = { cards: cards.slice(-KEEP), seen: [...seen].slice(-2000) };
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(next, null, 2));
    await rename(`${file}.tmp`, file);
    return { added, skipped, total: next.cards.length };
  };
}
