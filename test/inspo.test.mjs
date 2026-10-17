import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { paletteReadable } from '../src/media/director.mjs';
import { cardFrom, createInspoFetcher, extractPalette, parseFeed } from '../src/media/inspo.mjs';
import { loadLibrary } from '../src/media/library.mjs';

const FEED = `<rss><channel>
<item><title>Website Inspiration: Scout Graphics</title><link>https://onepagelove.com/scout-graphics</link>
<description><![CDATA[A warm off-white canvas with hand-drawn accents. Full Review]]></description>
<content:encoded><![CDATA[<p><img src="https://assets.example/scout.jpg" /></p>]]></content:encoded></item>
<item><title><![CDATA[No picture]]></title><link>https://onepagelove.com/none</link></item>
<item><title>Grafik</title><link>https://minimal.gallery/grafik/</link><media:content url="https://cdn.example/grafik.jpg" type="image/jpeg" /></item>
</channel></rss>`;

const reading = {
  tones: ['warm', 'playful'], typeFeel: 'serif-display', composition: 'A collage of work on an off-white page.',
  motion: { name: 'Hand-drawn pop', idea: 'Words pop in like stickers on a page.', reveal: 'scale', ease: 'snap', transition: 'cut', drift: 'none', pace: 'quick' },
  poster: { name: 'Studio sign', idea: 'The name set like painted signage.', layout: 'monument', tone: 'surface' },
};

// A 10x10 picture: cream ground, black type, one orange block.
function picture() {
  const px = [];
  for (let i = 0; i < 100; i += 1) px.push(...(i < 70 ? [246, 241, 232] : i < 90 ? [20, 20, 20] : [235, 90, 30]));
  return Buffer.from(px);
}

test('gallery feeds give title, page, picture and description', () => {
  const items = parseFeed(FEED, 'onepagelove');
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { id: 'onepagelove-com-scout-graphics', source: 'onepagelove', title: 'Scout Graphics', url: 'https://onepagelove.com/scout-graphics', image: 'https://assets.example/scout.jpg', about: 'A warm off-white canvas with hand-drawn accents.', categories: [] });
  assert.equal(items[1].image, 'https://cdn.example/grafik.jpg');
});

test('palettes come from the pixels and must read clearly', () => {
  const palette = extractPalette(picture());
  assert.ok(palette && paletteReadable(palette));
  assert.equal(palette.bg, '#f6f1e8');
  assert.equal(palette.ink, '#141414');
  assert.equal(palette.accent, '#eb5a1e');
  assert.equal(extractPalette(Buffer.from(new Array(300).fill(128))), null);
});

test('cards become library ideas and palettes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loom-inspo-'));
  try {
    const card = cardFrom(parseFeed(FEED, 'onepagelove')[0], reading, extractPalette(picture()));
    assert.deepEqual(card.motion.knobs, { reveal: 'scale', ease: 'snap', transition: 'cut', drift: 'none', tempo: 1.25, stagger: 0.7 });
    assert.equal(cardFrom({ id: 'x' }, { motion: {} }, null), null);
    const inspoFile = path.join(dir, 'cards.json');
    await writeFile(inspoFile, JSON.stringify({ cards: [card] }));
    const library = loadLibrary({ tasteDir: path.join(dir, 'none'), inspoFile });
    assert.ok(library.motion.some((idea) => idea.id === `inspo-${card.id}` && idea.fetched));
    assert.ok(library.posters.some((idea) => idea.id === `inspo-${card.id}`));
    assert.ok(library.palettes.some((p) => p.id === `inspo-${card.id}` && p.bg === '#f6f1e8'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the fetcher adds new sites once, with their picture shown to Qwen', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loom-inspo-'));
  try {
    const file = path.join(dir, 'cards.json');
    const seenImages = [];
    const fetchImpl = async (url) => {
      if (url.includes('feed')) return new Response(FEED, { status: 200 });
      return new Response(Buffer.alloc(4096, 1), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    };
    const run = async (command, args) => { await writeFile(args.at(-1), picture()); return { code: 0, output: '' }; };
    const askJson = async ({ images }) => { seenImages.push(images?.length); return reading; };
    const fetcher = createInspoFetcher({ askJson, file, workDir: path.join(dir, 'work'), run, fetch: fetchImpl, feeds: [{ id: 'onepagelove', url: 'https://x/feed' }] });
    assert.deepEqual(await fetcher({ want: 5 }), { added: 2, skipped: 0, total: 2 });
    assert.deepEqual(seenImages, [1, 1]);
    assert.deepEqual(await fetcher({ want: 5 }), { added: 0, skipped: 0, total: 2 });
    const stored = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(stored.cards[0].palette.accent, '#eb5a1e');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
