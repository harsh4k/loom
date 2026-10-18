// Actual browser regression: CSS's initial transform must not survive as an additive GSAP y.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { findBrowser } from '../src/media/render.mjs';
import { prepareStudio } from '../src/media/studio.mjs';

const { values } = parseArgs({ options: { out: { type: 'string' } } });
const out = path.resolve(values.out || 'data/quality/wipe-regression');
const requireMedia = createRequire(path.resolve(import.meta.dirname, '../media/package.json'));
const { default: puppeteer } = await import(pathToFileURL(requireMedia.resolve('puppeteer-core')).href);
const browser = await puppeteer.launch({ executablePath: findBrowser(), headless: true, windowsHide: true, pipe: true, timeout: 30000, args: ['--no-sandbox'] });
const results = [];
try {
  for (const transition of ['wipe', 'mask', 'cut', 'push']) {
    for (const tempo of [0.6, 1.05, 1.6]) {
      const workDir = path.join(out, `${transition}-${tempo}`);
      const shots = [
        { scene: 'statement', text: 'A local desktop voice assistant', d: 2.57 },
        { scene: 'number', value: '0', label: 'Cloud APIs', d: 2.25 },
        { scene: 'statement', text: 'A second sourced statement', d: 3 },
      ];
      await prepareStudio({ workDir, film: { motion: { transition, tempo }, shots }, format: 'landscape' });
      const page = await browser.newPage();
      await page.setViewport({ width: 1920, height: 1080 });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const url = pathToFileURL(path.join(workDir, 'index.html')).href;
      const samples = [];
      // Fresh loads establish cold seeking, then mixed ordering tests timeline state recovery.
      for (const sequence of [[3.236], [4.161], [0, 0.8, 3.236, 4.161, 5.5, 1, 3.236]]) {
        await page.goto(url);
        await page.evaluate(() => document.fonts.ready.then(() => true));
        for (const time of sequence) {
          await page.evaluate((time) => { window.__loomTimeline.totalTime(time, false); }, time);
          const measured = await page.evaluate(() => {
            const node = document.getElementById('wipe');
            const rect = node.getBoundingClientRect();
            const overlap = Math.max(0, Math.min(rect.bottom, 1080) - Math.max(rect.top, 0));
            return { top: rect.top, bottom: rect.bottom, overlap, transform: getComputedStyle(node).transform, y: gsap.getProperty(node, 'y'), yPercent: gsap.getProperty(node, 'yPercent') };
          });
          samples.push({ time, ...measured });
          if (measured.overlap > 0.5) await page.screenshot({ path: path.join(workDir, `occluded-${time}.png`) });
          assert.ok(measured.overlap <= 0.5, `${transition} tempo ${tempo} at ${time}s: wipe occludes ${measured.overlap}px during scene hold`);
        }
      }
      if (transition === 'wipe') {
        // Wipes still cover the boundary; the fix must not simply disable the transition.
        await page.evaluate(() => { window.__loomTimeline.totalTime(2.57, false); });
        const top = await page.evaluate(() => document.getElementById('wipe').getBoundingClientRect().top);
        assert.ok(Math.abs(top) < 1, `wipe tempo ${tempo}: boundary should be fully covered`);
      }
      assert.deepEqual(errors, []);
      results.push({ transition, tempo, status: 'PASS', samples });
      await page.close();
    }
  }
} catch (error) {
  results.push({ status: 'FAIL', error: error.message });
  process.exitCode = 1;
} finally {
  await browser.close();
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
}
console.log(JSON.stringify(results.map(({ transition, tempo, status, error }) => ({ transition, tempo, status, error }))));
