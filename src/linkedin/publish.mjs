// Publishes a finished draft once. A ledger entry is written before posting so a crash
// mid-post can never cause the same draft to be posted twice.
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createComment, createPost, uploadImage, uploadVideo } from './api.mjs';

export function parseDraft(markdown) {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const divider = normalized.indexOf('\n---\n');
  if (divider === -1) throw new Error('Draft has no post section.');
  const post = normalized.slice(divider + 5).trim();
  const comment = /^- First comment:[ \t]*(.*)$/m.exec(normalized.slice(0, divider))?.[1]?.trim() ?? '';
  const firstComment = comment && !/^https?:\/\//i.test(comment) ? `https://${comment}` : comment;
  return { post, firstComment };
}

async function readLedger(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error('The LinkedIn post ledger could not be read; nothing was posted.');
  }
}
async function writeLedger(file, ledger) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify(ledger, null, 2), { mode: 0o600 });
  await rename(temporary, file);
}

const MEDIA_LIMITS = { image: 10 * 1024 * 1024, video: 200 * 1024 * 1024 };

export function createPublisher({ account, ledgerFile, fetch: fetchImpl = fetch, version, uploads = { uploadImage, uploadVideo } }) {
  // Uploading never publishes anything, so a failed upload just means a text-only post.
  async function attach(credentials, media) {
    if (!media?.path || !['image', 'video'].includes(media.kind)) return { attached: null, note: '' };
    try {
      const bytes = await readFile(media.path);
      if (bytes.length > MEDIA_LIMITS[media.kind]) return { attached: null, note: `The ${media.kind} was too large to upload.` };
      const upload = media.kind === 'image' ? uploads.uploadImage : uploads.uploadVideo;
      const id = await upload({ ...credentials, bytes, version, fetch: fetchImpl });
      return { attached: { id, title: String(media.title ?? '').slice(0, 200) }, note: '' };
    } catch (error) {
      return { attached: null, note: `The ${media.kind} upload failed (${error?.message ?? 'unexpected error'}), so it went out as text.` };
    }
  }

  return async function publish(draftPath, { media } = {}) {
    const credentials = account.credentials();
    if (!credentials) return { posted: false, summary: 'Draft saved. Not posted: LinkedIn isn’t connected.' };

    const key = path.basename(draftPath);
    const ledger = await readLedger(ledgerFile);
    if (ledger[key]?.state === 'posted') return { posted: false, summary: 'Already posted to LinkedIn.' };
    if (ledger[key]?.state === 'pending') {
      return { posted: false, summary: 'Not posted again: an earlier attempt may have reached LinkedIn. Check your profile.' };
    }

    const { post, firstComment } = parseDraft(await readFile(draftPath, 'utf8'));
    if (post.length < 50) throw new Error('Draft post is too short to publish.');
    if (/\[|\]/.test(post)) return { posted: false, summary: 'Draft saved. Not posted: it still has a blank to fill.' };

    let { attached, note } = await attach(credentials, media);

    ledger[key] = { state: 'pending', at: new Date().toISOString() };
    await writeLedger(ledgerFile, ledger);
    let postUrn;
    let used;
    try {
      try {
        ({ postUrn, version: used } = await createPost({ ...credentials, text: post, media: attached, version, fetch: fetchImpl }));
      } catch (error) {
        // LinkedIn refused the post with media attached; nothing went live, so try once as text.
        if (!attached || !error?.status) throw error;
        note = `LinkedIn refused the post with the ${media.kind} (${error.message}), so it went out as text.`;
        attached = null;
        ({ postUrn, version: used } = await createPost({ ...credentials, text: post, version, fetch: fetchImpl }));
      }
    } catch (error) {
      // A status means LinkedIn answered and refused, so nothing was posted and a later retry is safe.
      // Without one (timeout, dropped connection) the post may exist, so the pending entry stays.
      if (error?.status) {
        delete ledger[key];
        await writeLedger(ledgerFile, ledger);
      }
      throw error;
    }
    ledger[key] = { state: 'posted', postUrn, media: attached ? media.kind : null, at: new Date().toISOString() };
    await writeLedger(ledgerFile, ledger);

    const withMedia = attached ? ` with the ${media.kind}` : '';
    const tail = note ? ` ${note}` : '';
    if (firstComment) {
      try {
        await createComment({ ...credentials, postUrn, text: firstComment, version: used, fetch: fetchImpl });
      } catch (error) {
        return { posted: true, postUrn, summary: `Posted to LinkedIn${withMedia}. The repo-link comment failed: ${error.message}${tail}` };
      }
    }
    return { posted: true, postUrn, summary: `Posted to LinkedIn${withMedia}${firstComment ? ' and the repo link as the first comment' : ''}.${tail}` };
  };
}
