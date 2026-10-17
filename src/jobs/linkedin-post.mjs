// Wraps the draft job: once the local model has written and validated a draft, render the
// project's video and poster image, then publish the post with one of them attached.
import { readFile } from 'node:fs/promises';

// Thursday posts carry the still image, every other day the video, so the feed alternates.
export function mediaKindFor(date) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day === 4 ? 'image' : 'video';
}

async function draftProject(draftPath) {
  try { return /^- Project:[ \t]*(.+)$/m.exec(await readFile(draftPath, 'utf8'))?.[1]?.trim() ?? ''; } catch { return ''; }
}

export function createLinkedInPostingJob({ draftJob, publish, renderMedia = null }) {
  return {
    async run(context) {
      const result = await draftJob.run(context);
      if (!result?.artifactPath || context.signal?.aborted) return result;
      const report = typeof context.report === 'function' ? context.report : () => {};

      let media;
      let mediaNote = '';
      if (renderMedia) {
        const topic = await draftProject(result.artifactPath);
        try {
          const rendered = topic ? await renderMedia({ topic, outBase: result.artifactPath.replace(/\.md$/i, ''), signal: context.signal, report }) : null;
          if (rendered) {
            const kind = mediaKindFor(context.date) === 'image' && rendered.image ? 'image' : 'video';
            media = { kind, path: kind === 'image' ? rendered.image : rendered.video, title: rendered.name };
            if (rendered.note) mediaNote = ` ${rendered.note}`;
          }
        } catch (error) {
          if (context.signal?.aborted) return { summary: 'Draft saved; stopped while rendering media.', artifactPath: result.artifactPath };
          mediaNote = ` Media wasn’t made (${error?.message ?? 'unexpected error'}).`;
        }
      }
      if (context.signal?.aborted) return { summary: 'Draft saved; stopped before posting.', artifactPath: result.artifactPath };

      report(media ? `Posting to LinkedIn with the ${media.kind}.` : 'Posting to LinkedIn.');
      let outcome;
      try {
        outcome = await publish(result.artifactPath, { media });
      } catch (error) {
        throw new Error(`Draft saved, but posting failed: ${error?.message ?? 'Unexpected error.'}`);
      }
      return { summary: `${outcome.summary}${mediaNote}`, artifactPath: result.artifactPath };
    },
  };
}
