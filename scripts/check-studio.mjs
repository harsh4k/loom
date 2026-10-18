// Deterministic browser regression for the actual studio engine, not a source-text assertion.
// Uses the headless browser and Puppeteer already installed by media/HyperFrames.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { findBrowser } from '../src/media/render.mjs';
import { FORMATS, prepareStudio } from '../src/media/studio.mjs';

const { values } = parseArgs({ options: { out: { type: 'string' } } });
const out = path.resolve(values.out || 'data/quality/studio-regression');
const requireMedia = createRequire(path.resolve(import.meta.dirname, '../media/package.json'));
const { default: puppeteer } = await import(pathToFileURL(requireMedia.resolve('puppeteer-core')).href);
const film = {
  tokens: { bg: '#141820', surface: '#222a38', ink: '#f6f3ec', muted: '#bcc3cf', accent: '#b5ed68', accentInk: '#141820' },
  type: {}, motion: { reveal: 'slide', tempo: 1, transition: 'mask' },
  shots: [
    { scene: 'statement', text: 'A deterministic renderer fixture', d: 3 },
    { scene: 'number', value: '8192', label: 'Token context', d: 3 },
    { scene: 'list', title: 'Capabilities', items: ['Open apps on your computer', 'Chat with a local model', 'Keep notes between sessions'], d: 4 },
    { scene: 'signal', text: 'A local desktop assistant', motif: 'orbit', d: 3 },
    { scene: 'kinetic', text: 'Streaming chat and persistent memory', d: 3 },
    { scene: 'end', name: 'Fixture', line: 'A deterministic renderer test', d: 3 },
  ],
};
const browser = await puppeteer.launch({ executablePath: findBrowser(), headless: true, windowsHide: true, pipe: true, timeout: 30000, args: ['--no-sandbox'] });
const results = [];
try {
  for (const [format, size] of Object.entries(FORMATS)) {
    const workDir = path.join(out, format);
    const sampleFilm = format === 'poster' ? { ...film, shots: [{ scene: 'poster', name: 'Fixture', line: 'A deterministic renderer test', evidence: ['Streaming chat', 'Persistent memory'], d: 3.2 }] } : film;
    await prepareStudio({ workDir, film: sampleFilm, format });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    await page.setViewport({ width: size.w, height: size.h });
    await page.goto(pathToFileURL(path.join(workDir, 'index.html')).href, { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.fonts.ready.then(() => true));
    if (format !== 'poster') {
      const scaleAt = async (time) => page.evaluate((time) => {
        window.__loomTimeline.totalTime(time, false);
        return new DOMMatrix(getComputedStyle(document.querySelector('.kinetic-shot .display')).transform).a;
      }, time);
      assert.ok(await scaleAt(13.1) < 0.99, `${format}: kinetic type changes scale during entry`);
      assert.ok(Math.abs(await scaleAt(15.3) - 1) < 0.001, `${format}: kinetic type settles before its readable hold`);
    }
    const times = format === 'poster' ? [2.5] : [2, 5, 9.3, 12.3, 15.3, 18, 0, 5, 9.3];
    const samples = [];
    for (const time of times) {
      // Never return the GSAP timeline: its thenable waits forever while paused.
      await page.evaluate((time) => { window.__loomTimeline.totalTime(time, false); }, time);
      const measured = await page.evaluate(() => {
        const visible = [...document.querySelectorAll('.shot')].filter((node) => getComputedStyle(node).visibility === 'visible');
        const partial = visible.flatMap((node) => [...node.querySelectorAll('.mask > span')]).filter((node) => {
          const value = getComputedStyle(node).transform;
          const matrix = new DOMMatrix(value === 'none' ? undefined : value);
          return Math.abs(matrix.m41) > 1 || Math.abs(matrix.m42) > 1;
        });
        return { text: visible.map((node) => node.textContent), partialWords: partial.map((node) => node.textContent), counter: document.querySelector('.num')?.textContent, fontsReady: window.__loom.fontsReady, problems: window.__loom.problems };
      });
      assert.equal(measured.fontsReady, true, `${format}: font readiness`);
      assert.equal(measured.text.length, 1, `${format}@${time}: exactly one visible shot`);
      if (time === 5) assert.equal(measured.counter.replace(/,/g, ''), '8192', `${format}: seekable final counter`);
      if (time > 0) assert.deepEqual(measured.partialWords, [], `${format}@${time}: words fully revealed during hold`);
      assert.deepEqual(measured.problems, [], `${format}: fitted text`);
      samples.push({ time, ...measured });
      if (time > 0) await page.screenshot({ path: path.join(workDir, `at-${time}.png`) });
    }
    assert.deepEqual(consoleErrors, [], `${format}: console errors`);
    results.push({ format, size, status: 'PASS', samples, consoleErrors });
    await page.close();
  }
} catch (error) {
  results.push({ status: 'FAIL', error: error.message });
  process.exitCode = 1;
} finally {
  await browser.close();
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
}
console.log(JSON.stringify(results.map(({ format, status, error }) => ({ format, status, error }))));
