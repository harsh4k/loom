// Prepares a HyperFrames project for one film: the studio engine (media/studio), sized for the
// format, with its fonts and pictures copied in and the film written to assets/film.js.
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const STUDIO_DIR = path.resolve(import.meta.dirname, '../../media/studio');

// The sizes Loom makes. The 16:9 video is the one that gets posted; the others are kept.
export const FORMATS = Object.freeze({
  landscape: { w: 1920, h: 1080 },
  portrait: { w: 1080, h: 1350 },
  story: { w: 1080, h: 1920 },
  poster: { w: 1080, h: 1350 },
});

export function sizedIndex(html, { w, h }, duration = 10) {
  return html
    .replace(/<meta name="viewport" content="width=\d+, height=\d+" \/>/, `<meta name="viewport" content="width=${w}, height=${h}" />`)
    .replace(/data-duration="[\d.]+"/, `data-duration="${Number(duration.toFixed(2))}"`)
    .replace(/data-width="\d+" data-height="\d+"/, `data-width="${w}" data-height="${h}"`);
}

// film: { tokens, type, motion, shots }. images: { key: absolute path } copied to assets/.
// fonts: { css, files } from loadTypeFaces, or null for the system face.
export async function prepareStudio({ workDir, film, format, images = {}, fonts = null, studioDir = STUDIO_DIR }) {
  const size = FORMATS[format] ?? format;
  if (!size?.w || !size?.h) throw new RangeError(`Unknown format ${format}.`);
  await mkdir(workDir, { recursive: true });
  await cp(studioDir, workDir, { recursive: true, filter: (source) => !source.includes(`${path.sep}.hyperframes`) && !source.includes(`${path.sep}renders`) });
  const index = path.join(workDir, 'index.html');
  await writeFile(index, sizedIndex(await readFile(index, 'utf8'), size, filmDuration(film)));
  await mkdir(path.join(workDir, 'assets', 'fonts'), { recursive: true });
  if (fonts) {
    for (const file of fonts.files) await cp(file.path, path.join(workDir, 'assets', 'fonts', file.name));
    await writeFile(path.join(workDir, 'assets', 'fonts.css'), fonts.css);
  }
  const imageMap = {};
  const imageSizes = {};
  for (const [key, file] of Object.entries(images)) {
    if (!file) continue;
    const name = `img-${key.replace(/[^a-z0-9]/gi, '')}${path.extname(file) || '.png'}`;
    await cp(file, path.join(workDir, 'assets', name));
    imageMap[key] = `assets/${name}`;
    const size = imageSize(await readFile(file));
    if (size?.w && size?.h) imageSizes[key] = size;
  }
  // JSON is valid JavaScript; "<" is escaped so no text can close the script.
  const json = JSON.stringify({ ...film, images: imageMap, imageSizes, format: size }).replace(/</g, '\\u003c');
  await writeFile(path.join(workDir, 'assets', 'film.js'), `window.__LOOM_FILM = ${json};\n`);
  return { workDir, size, duration: filmDuration(film) };
}

// Width and height from a PNG, JPEG or WebP header, or null.
export function imageSize(bytes) {
  if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47) return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
  if (bytes.length > 30 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    const kind = bytes.toString('latin1', 12, 16);
    if (kind === 'VP8X') return { w: 1 + bytes.readUIntLE(24, 3), h: 1 + bytes.readUIntLE(27, 3) };
    if (kind === 'VP8 ') return { w: bytes.readUInt16LE(26) & 0x3fff, h: bytes.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') { const bits = bytes.readUInt32LE(21); return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 }; }
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1];
      const length = bytes.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { w: bytes.readUInt16BE(offset + 7), h: bytes.readUInt16BE(offset + 5) };
      offset += 2 + length;
    }
  }
  return null;
}

export const filmDuration = (film) => film.shots.reduce((sum, shot) => sum + Math.min(8, Math.max(1, Number(shot.d) || 2.5)), 0);
