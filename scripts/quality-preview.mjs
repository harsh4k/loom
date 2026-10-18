// Builds an offline comparison page. Optional --port serves only this evaluation's artifacts.
import { createServer } from 'node:http';
import { readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { dir: { type: 'string' }, port: { type: 'string' } } });
if (!values.dir) throw new Error('--dir must name an isolated quality evaluation.');
const root = await realpath(path.resolve(values.dir));
const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const href = (file) => path.relative(root, file).split(path.sep).map(encodeURIComponent).join('/');
const json = async (file, fallback) => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; } };
const sections = [];
const dirs = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory());
for (const entry of dirs) {
  const dir = path.join(root, entry.name);
  const audit = await json(path.join(dir, 'final-constraints.json'), null);
  const results = audit ?? await json(path.join(dir, 'results.json'), null);
  const manifest = await json(path.join(dir, 'manifest.json'), []);
  if (!results?.summary && !(Array.isArray(manifest) && manifest.some((item) => Number.isInteger(item.code) && item.run))) continue;
  const cards = [];
  for (const name of (await readdir(dir)).filter((name) => /-\d+\.md$/.test(name)).sort()) {
    const markdown = await readFile(path.join(dir, name), 'utf8');
    const body = markdown.split(/\r?\n---\r?\n/).slice(1).join('\n---\n').trim();
    if (!body) continue;
    cards.push(`<article><h3>${esc(name.replace(/\.md$/, ''))}</h3><p class="copy">${esc(body)}</p><a href="${href(path.join(dir, name))}">Draft source</a></article>`);
  }
  const summary = results?.summary;
  const count = summary ? `${summary.attempted} attempted · ${summary.generated} generated · ${summary.valid} constraint-valid · ${summary.skipped ?? 0} skipped · ${summary.failed} failed/invalid · publishability requires review` : `${manifest.length || cards.length} attempts · ${manifest.filter((item) => item.code !== 0).length} generation failures`;
  const errors = results?.results?.filter((item) => item.error).map((item) => `${item.label}: ${item.error}`) ?? [];
  const scorecard = await stat(path.join(dir, audit ? 'final-scorecard.md' : 'scorecard.md')).then(() => `<a href="${href(path.join(dir, audit ? 'final-scorecard.md' : 'scorecard.md'))}">${audit ? 'Current-constraint audit' : 'Full scorecard'}</a> · <a href="${href(path.join(dir, 'results.json'))}">Original run</a>`).catch(() => '');
  sections.push(`<section><h2>${esc(entry.name)}</h2><p>${esc(count)} ${scorecard}</p>${errors.length ? `<details><summary>Failure details</summary><pre>${esc(errors.join('\n'))}</pre></details>` : ''}<div class="grid">${cards.join('')}</div></section>`);
}
for (const entry of dirs.filter((entry) => /media/.test(entry.name))) {
  const dir = path.join(root, entry.name);
  const cards = [];
  for (const child of await readdir(dir, { withFileTypes: true })) {
    if (!child.isDirectory() || ['state', 'work', 'model-responses'].includes(child.name)) continue;
    const folder = path.join(dir, child.name);
    const files = await readdir(folder);
    const poster = files.find((name) => name.endsWith('.png'));
    const videos = files.filter((name) => name.endsWith('.mp4'));
    if (!poster && !videos.length) continue;
    const playbackDir = path.join(dir, 'playback', child.name);
    const playback = await stat(path.join(playbackDir, 'contact-sheet.png')).then(() => `<a href="${href(path.join(playbackDir, 'contact-sheet.png'))}">Continuous playback samples</a>`).catch(() => '');
    cards.push(`<article><h3>${esc(child.name)}</h3>${poster ? `<img loading="lazy" src="${href(path.join(folder, poster))}" alt="${esc(child.name)} poster">` : ''}${videos.map((name) => `<details><summary>${esc(name)}</summary><video controls preload="none" playsinline src="${href(path.join(folder, name))}"></video></details>`).join('')}<p>Check claims, readable holds, transitions, and endings during playback. ${playback}</p></article>`);
  }
  const manifestFile = await stat(path.join(dir, 'manifest.json')).then(() => 'manifest.json').catch(() => 'results.json');
  sections.push(`<section><h2>${esc(entry.name)}</h2><p><a href="${href(path.join(dir, manifestFile))}">Results and evidence paths</a> · Rendering success alone does not establish quality.</p><div class="grid">${cards.join('')}</div></section>`);
}
const review = await readFile(path.join(root, 'review.md'), 'utf8').catch(() => 'Review pending. Automatic constraints and model critiques do not establish publication quality.');
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>Loom quality comparison</title><style>
:root{color-scheme:dark;--bg:#111318;--surface:#1b1e25;--ink:#f4f3ed;--muted:#b9bdc9;--line:#363b47;--accent:#b4c9ff}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,sans-serif}main{max-width:1440px;margin:auto;padding:40px 24px}h1{font-size:clamp(32px,5vw,64px);line-height:1.05;letter-spacing:-.04em}h2{margin:48px 0 8px}h3{margin:0 0 16px}p{color:var(--muted)}a{color:var(--accent)}a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:4px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr));gap:20px}article{border:1px solid var(--line);border-radius:16px;padding:24px;background:var(--surface)}.copy{white-space:pre-wrap;color:var(--ink)}img,video{width:100%;max-height:650px;object-fit:contain;background:var(--bg)}details{margin:16px 0}summary{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.7 ui-monospace,monospace}.note{border-left:3px solid var(--accent);padding:8px 20px}
</style></head><body><main><p>LOOM / LOCAL EVALUATION</p><h1>Content worth publishing.</h1><p>Baseline and candidate outputs, kept separate from live drafts. Copy, static design, and motion require separate judgments.</p><details open class="note"><summary>Review and limitations</summary><pre>${esc(review)}</pre></details>${sections.join('')}</main></body></html>`;
await writeFile(path.join(root, 'index.html'), html);
console.log(`Preview: ${path.join(root, 'index.html')}`);
if (values.port) {
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('--port must be 1024–65535.');
  const types = { '.html': 'text/html; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4' };
  createServer(async (req, res) => {
    try {
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
      const route = decodeURIComponent(new URL(req.url, `http://127.0.0.1:${port}`).pathname);
      const file = await realpath(path.join(root, route === '/' ? 'index.html' : route.replace(/^\/+/, '')));
      const relative = path.relative(root, file);
      if (relative.startsWith('..') || path.isAbsolute(relative) || !types[path.extname(file)]) { res.writeHead(403).end(); return; }
      const bytes = await readFile(file);
      res.writeHead(200, { 'Content-Type': types[path.extname(file)], 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch { res.writeHead(404).end(); }
  }).listen(port, '127.0.0.1', () => console.log(`Preview server: http://127.0.0.1:${port}`));
}
