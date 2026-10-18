// Browser regression for art-direction parameters and dedicated poster compositions.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { findBrowser } from '../src/media/render.mjs';
import { prepareStudio } from '../src/media/studio.mjs';

const { values } = parseArgs({ options: { out: { type: 'string' }, image: { type: 'string' } } });
const out = path.resolve(values.out || 'data/quality/motif-regression');
const requireMedia = createRequire(path.resolve(import.meta.dirname, '../media/package.json'));
const { default: puppeteer } = await import(pathToFileURL(requireMedia.resolve('puppeteer-core')).href);
const browser = await puppeteer.launch({ executablePath: findBrowser(), headless: true, windowsHide: true, pipe: true, timeout: 30000, args: ['--no-sandbox'] });
const results = [];
try {
  for (const motif of ['orbit', 'bars', 'tiles']) for (const layout of ['monument', 'statement', 'screen']) for (const tone of ['bg', 'field']) {
    const workDir = path.join(out, `${motif}-${layout}-${tone}`);
    const film = {
      tokens: { bg: '#142d2a', surface: '#254c45', ink: '#f6f1d5', muted: '#c3d1bf', accent: '#e3fc76', accentInk: '#142d2a', fieldBg: '#e3fc76', fieldInk: '#142d2a' },
      shots: [{ scene: 'poster', name: 'Studio fixture', line: 'Streaming chat and persistent memory.', evidence: ['Local desktop assistant', 'Voice input and output'], image: 'shot', motif, layout, tone, d: 3.2 }],
    };
    await prepareStudio({ workDir, film, format: 'poster', images: values.image ? { shot: path.resolve(values.image) } : {} });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewport({ width: 1080, height: 1350 });
    await page.goto(pathToFileURL(path.join(workDir, 'index.html')).href, { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.fonts.ready.then(() => true));
    await page.evaluate(() => { window.__loomTimeline.totalTime(2.5, false); });
    const measured = await page.evaluate(() => {
      const visible = [...document.querySelectorAll('.shot')].find((node) => getComputedStyle(node).visibility === 'visible');
      const text = [...visible.querySelectorAll('h1,h2,p')].map((node) => {
        const r = node.getBoundingClientRect();
        return { text: node.textContent, x: r.x, y: r.y, w: r.width, h: r.height };
      }).filter((item) => item.text);
      const mark = visible.querySelector('.signal-mark');
      return { motif: mark?.dataset.motif, markColor: mark ? getComputedStyle(mark).color : null, background: getComputedStyle(visible).backgroundColor, frame: Boolean(visible.querySelector('.frame')), text, problems: window.__loom.problems };
    });
    if (layout !== 'screen' || !values.image) assert.equal(measured.motif, motif, 'Art direction motif must reach the renderer');
    if (layout === 'screen' && values.image) assert.equal(measured.frame, true, 'Screenshot layout retains real imagery');
    if (measured.motif) assert.notEqual(measured.markColor, measured.background, 'Focal graphic must remain visible on field backgrounds');
    for (const item of measured.text) assert.ok(item.x >= 0 && item.y >= 0 && item.x + item.w <= 1081 && item.y + item.h <= 1351, `Text stays in frame: ${item.text}`);
    for (let i = 0; i < measured.text.length; i++) for (const b of measured.text.slice(i + 1)) {
      const a = measured.text[i];
      assert.ok(Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) <= 1 || Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) <= 1, 'Text zones do not overlap');
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(measured.problems, []);
    await page.screenshot({ path: path.join(workDir, 'poster.png') });
    results.push({ motif, layout, tone, status: 'PASS', measured });
    await page.close();
  }
} catch (error) { results.push({ status: 'FAIL', error: error.message }); process.exitCode = 1; }
finally { await browser.close(); await mkdir(out, { recursive: true }); await writeFile(path.join(out, 'results.json'), JSON.stringify(results, null, 2)); }
console.log(JSON.stringify(results.map(({ motif, layout, tone, status, error }) => ({ motif, layout, tone, status, error }))));
