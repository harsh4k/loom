// The approval gate. A finished draft waits in "<draft>.review.json" until the person approves
// it in Loom; only then is it published. The record holds no post text or personal data, just
// the state and which rendered file (beside the draft) goes with the post.
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const STATES = ['awaiting', 'posted', 'discarded'];
export const reviewPath = (draftPath) => draftPath.replace(/\.md$/i, '.review.json');

export async function readReview(draftPath) {
  try {
    const value = JSON.parse(await readFile(reviewPath(draftPath), 'utf8'));
    return value && STATES.includes(value.state) ? value : null;
  } catch { return null; }
}

async function writeReview(draftPath, record) {
  const file = reviewPath(draftPath);
  await writeFile(`${file}.tmp`, JSON.stringify(record, null, 2));
  await rename(`${file}.tmp`, file);
}

// Media must sit beside the draft, so only its file name is kept.
function mediaRecord(draftPath, media) {
  if (!media?.path || !['image', 'video'].includes(media.kind)) return null;
  if (path.dirname(path.resolve(media.path)) !== path.dirname(path.resolve(draftPath))) return null;
  return { kind: media.kind, file: path.basename(media.path), title: String(media.title ?? '').slice(0, 200) };
}

export async function awaitReview(draftPath, { media } = {}) {
  await writeReview(draftPath, { state: 'awaiting', media: mediaRecord(draftPath, media), createdAt: new Date().toISOString() });
}

export class ReviewError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

export function createReviewer({ publish }) {
  // One decision per draft at a time: a double click must not start two uploads.
  const busy = new Set();
  async function current(draftPath) {
    const record = await readReview(draftPath);
    if (!record) throw new ReviewError('This draft has no review waiting.', 'NO_REVIEW');
    if (record.state !== 'awaiting') throw new ReviewError(`This draft was already ${record.state}.`, 'ALREADY_DECIDED');
    return record;
  }
  async function approveOnce(draftPath) {
    const record = await current(draftPath);
    const media = record.media
      ? { kind: record.media.kind, path: path.join(path.dirname(draftPath), path.basename(record.media.file)), title: record.media.title }
      : undefined;
    const outcome = await publish(draftPath, { media });
    if (outcome?.posted || outcome?.alreadyPosted) {
      await writeReview(draftPath, { ...record, state: 'posted', decidedAt: new Date().toISOString(), postUrn: outcome.postUrn ?? null });
    }
    return { posted: Boolean(outcome?.posted || outcome?.alreadyPosted), summary: outcome?.summary ?? '' };
  }
  return {
    read: readReview,
    // Publishes through the normal publisher, whose own ledger stops a draft going out twice.
    // When nothing was posted (for example LinkedIn isn't connected) the draft keeps waiting.
    async approve(draftPath) {
      if (busy.has(draftPath)) throw new ReviewError('This draft is already being posted.', 'BUSY');
      busy.add(draftPath);
      try { return await approveOnce(draftPath); } finally { busy.delete(draftPath); }
    },
    async discard(draftPath) {
      if (busy.has(draftPath)) throw new ReviewError('This draft is already being posted.', 'BUSY');
      const record = await current(draftPath);
      await writeReview(draftPath, { ...record, state: 'discarded', decidedAt: new Date().toISOString() });
      return { posted: false, summary: 'Draft discarded. Nothing was posted.' };
    },
  };
}
