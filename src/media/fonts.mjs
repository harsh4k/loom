// Real free fonts for the studio, from the type systems in the design library (Google Fonts and
// Fontshare). Each face is downloaded once into a local cache, so renders never depend on the
// network and every frame uses the same file.
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const MAX_FONT_BYTES = 2 * 1024 * 1024;
const safe = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Reads "weight 600 · tracking -0.04em · leading 0.95 · sentence case" into numbers.
export function parseSettings(settings = '') {
  const text = String(settings);
  const weight = Number(/weight\s+(\d{3})/i.exec(text)?.[1]) || null;
  const tracking = /tracking\s+(-?[\d.]+)em/i.exec(text)?.[1];
  const leading = Number(/leading\s+([\d.]+)/i.exec(text)?.[1]) || null;
  const upper = /\b(all )?(capitals|uppercase|caps)\b/i.test(text) && !/no capitals/i.test(text) && !/sentence case/i.test(text.split('·').find((part) => /case|caps|capitals/i.test(part)) ?? '');
  const lower = /all lowercase/i.test(text) && !/sentence case/i.test(text);
  return {
    weight,
    tracking: tracking === undefined ? null : `${Number(tracking)}em`,
    leading: leading && leading >= 0.75 && leading <= 1.4 ? leading : null,
    case: upper ? 'uppercase' : lower ? 'lowercase' : 'none',
  };
}

// The CSS a font service hands out lists one @font-face per subset; keep the Latin ones.
export function parseFaces(css, { source }) {
  const faces = [];
  const blocks = String(css).split('@font-face').slice(1);
  const labels = String(css).split('@font-face').slice(0, -1).map((before) => /\/\*\s*([\w-]+)\s*\*\/\s*$/.exec(before)?.[1] ?? null);
  blocks.forEach((block, index) => {
    if (source === 'google' && labels[index] && labels[index] !== 'latin') return;
    const family = /font-family:\s*['"]?([^;'"]+)['"]?;/.exec(block)?.[1]?.trim();
    const weight = /font-weight:\s*(\d{1,4}(?:\s+\d{1,4})?)\s*;/.exec(block)?.[1]?.replace(/\s+/g, ' ');
    const style = /font-style:\s*(\w+)/.exec(block)?.[1] ?? 'normal';
    let url = /url\(['"]?([^'")]+\.woff2)['"]?\)/.exec(block)?.[1];
    if (!family || !weight || !url) return;
    if (url.startsWith('//')) url = `https:${url}`;
    if (!/^https:\/\//.test(url)) return;
    faces.push({ family, weight: weight.includes(' ') ? weight : Number(weight), style, url });
  });
  return faces;
}

export function cssUrl(face) {
  const weights = [...new Set(face.weights)].sort((a, b) => a - b);
  if (face.source === 'fontshare') return `https://api.fontshare.com/v2/css?f[]=${encodeURIComponent(face.slug ?? safe(face.family))}@${face.variable ? '1' : weights.join(',')}${face.italic && !face.variable ? `,${weights.map((w) => `${w}i`).join(',')}` : ''}&display=swap`;
  const family = encodeURIComponent(face.family).replace(/%20/g, '+');
  return face.italic
    ? `https://fonts.googleapis.com/css2?family=${family}:ital,wght@${weights.map((w) => `0,${w}`).concat(weights.map((w) => `1,${w}`)).join(';')}&display=swap`
    : `https://fonts.googleapis.com/css2?family=${family}:wght@${face.variable ? `${weights[0]}..${weights.at(-1)}` : weights.join(';')}&display=swap`;
}

// Downloads the faces a type system needs (display and text) into cacheDir. Returns the
// @font-face CSS pointing at fonts/<file> and the files to copy next to it, or null when a face
// can't be had (then the caller picks another type system).
export async function loadTypeFaces(typeSystem, { cacheDir, fetch: fetchImpl = fetch, signal } = {}) {
  await mkdir(cacheDir, { recursive: true });
  const roles = ['display', 'text'].map((role) => typeSystem?.[role]).filter(Boolean);
  if (!roles.length) return null;
  const files = [];
  const rules = [];
  const seen = new Set();
  for (const face of roles) {
    if (!['google', 'fontshare'].includes(face.source) || !Array.isArray(face.weights) || !face.weights.length) return null;
    const indexFile = path.join(cacheDir, `${safe(face.family)}.${face.source}${face.variable ? '.variable' : ''}.json`);
    let faces = null;
    if (existsSync(indexFile)) { try { faces = JSON.parse(await readFile(indexFile, 'utf8')); } catch { faces = null; } }
    const wanted = face.weights.map(Number);
    const covers = (item, weight) => { const range = String(item.weight).split(/\s+/).map(Number); return range.length === 2 ? weight >= range[0] && weight <= range[1] : weight === range[0]; };
    if (!faces || !wanted.every((weight) => faces.some((item) => covers(item, weight) && existsSync(path.join(cacheDir, item.file))))) {
      const response = await fetchImpl(cssUrl(face), { headers: { 'User-Agent': UA }, signal: signal ?? AbortSignal.timeout(20_000) }).catch(() => null);
      if (!response?.ok) return null;
      const parsed = parseFaces(await response.text(), face).filter((item) => wanted.some((weight) => covers(item, weight)));
      if (!wanted.every((weight) => parsed.some((item) => item.style === 'normal' && covers(item, weight)))) return null;
      faces = [];
      for (const item of parsed) {
        const file = `${safe(item.family)}-${String(item.weight).replace(/\s+/g, '-')}${item.style === 'italic' ? 'i' : ''}.woff2`;
        const target = path.join(cacheDir, file);
        if (!existsSync(target)) {
          const fontResponse = await fetchImpl(item.url, { headers: { 'User-Agent': UA }, signal: signal ?? AbortSignal.timeout(30_000) }).catch(() => null);
          if (!fontResponse?.ok) return null;
          const bytes = Buffer.from(await fontResponse.arrayBuffer());
          if (bytes.length < 1024 || bytes.length > MAX_FONT_BYTES || bytes.subarray(0, 4).toString('latin1') !== 'wOF2') return null;
          await writeFile(`${target}.tmp`, bytes);
          await rename(`${target}.tmp`, target);
        }
        faces.push({ family: item.family, weight: item.weight, style: item.style, file });
      }
      await writeFile(indexFile, JSON.stringify(faces));
    }
    for (const item of faces) {
      if (!wanted.some((weight) => covers(item, weight)) || seen.has(item.file)) continue;
      seen.add(item.file);
      files.push({ name: item.file, path: path.join(cacheDir, item.file) });
      rules.push(`@font-face { font-family: "${face.family}"; src: url("fonts/${item.file}") format("woff2"); font-weight: ${item.weight}; font-style: ${item.style}; font-display: block; }`);
    }
  }
  return { css: `${rules.join('\n')}\n`, files };
}
