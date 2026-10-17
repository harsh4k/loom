// Design inspiration: once a week, tops up Loom's design library with new motion and poster ideas
// (and palettes) read from public web-design galleries. It fetches more when the studio has used
// most of what it has. See src/media/inspo.mjs.
import { spawn as systemSpawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInspoFetcher } from '../media/inspo.mjs';
import { INSPO_FILE, loadLibrary, unusedIdeas } from '../media/library.mjs';
import { runProcess } from '../media/render.mjs';
import { getProfile } from '../profile.mjs';

export const LOW_MOTION = 6;
export const LOW_POSTERS = 4;

export function createDesignInspoJob({ askJson, dataDir, fetch: fetchImpl = fetch, spawn = systemSpawn, ffmpeg = process.env.HYPERFRAMES_FFMPEG_PATH || 'ffmpeg', inspoFile = INSPO_FILE }) {
  const fetchInspiration = createInspoFetcher({
    askJson, file: inspoFile, workDir: path.join(dataDir, 'inspo-work'), ffmpeg, fetch: fetchImpl,
    run: (command, args, options) => runProcess(spawn, command, args, options),
  });
  return {
    async run({ signal, report = () => {} } = {}) {
      let looks = {};
      try { looks = JSON.parse(await readFile(path.join(dataDir, 'media', 'looks.json'), 'utf8')); } catch { looks = {}; }
      const before = unusedIdeas(loadLibrary({ tasteDir: getProfile().design.tasteDir || undefined, inspoFile }), looks);
      const low = before.motion < LOW_MOTION || before.posters < LOW_POSTERS;
      const { added, skipped, total } = await fetchInspiration({ want: low ? 6 : 3, signal, report });
      const lead = added ? `Added ${added} new idea${added === 1 ? '' : 's'} from design galleries` : 'No new ideas this week';
      return { summary: `${lead} (${total} in the library${skipped ? `, ${skipped} skipped` : ''}). Unused before this run: ${before.motion} motion, ${before.posters} poster.` };
    },
  };
}
