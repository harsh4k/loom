import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { awaitReview, createReviewer, readReview, reviewPath } from '../src/linkedin/review.mjs';
import { createServer } from '../src/server.mjs';

const DRAFT = '# Draft: Bunny OS\n\n- Project: Bunny OS\n\n---\n\nBunny OS runs its assistant on a local model, so every reply is generated on the machine.\n\nHow do you test local inference?\n';

async function draftIn(dir, name = '2026-10-20-bunny.md') {
  const file = path.join(dir, name);
  await writeFile(file, DRAFT);
  return file;
}

test('a review keeps only the media file name and refuses media outside the draft folder', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loom-review-'));
  try {
    const draft = await draftIn(dir);
    assert.equal(reviewPath(draft), path.join(dir, '2026-10-20-bunny.review.json'));
    await awaitReview(draft, { media: { kind: 'image', path: path.join(dir, '2026-10-20-bunny.png'), title: 'Bunny OS' } });
    assert.deepEqual((await readReview(draft)).media, { kind: 'image', file: '2026-10-20-bunny.png', title: 'Bunny OS' });
    await awaitReview(draft, { media: { kind: 'image', path: path.join(os.tmpdir(), 'elsewhere.png') } });
    assert.equal((await readReview(draft)).media, null);
    assert.equal(await readReview(path.join(dir, 'missing.md')), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('approving publishes once with the saved media; a refusal keeps the draft waiting', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loom-review-'));
  try {
    const draft = await draftIn(dir);
    await awaitReview(draft, { media: { kind: 'video', path: path.join(dir, '2026-10-20-bunny.mp4'), title: 'Bunny OS' } });
    const calls = [];
    let connected = false;
    const reviewer = createReviewer({
      publish: async (file, { media }) => {
        calls.push({ file, media });
        return connected ? { posted: true, postUrn: 'urn:li:share:1', summary: 'Posted to LinkedIn with the video.' } : { posted: false, summary: 'Draft saved. Not posted: LinkedIn isn’t connected.' };
      },
    });
    const first = await reviewer.approve(draft);
    assert.deepEqual(first, { posted: false, summary: 'Draft saved. Not posted: LinkedIn isn’t connected.' });
    assert.equal((await readReview(draft)).state, 'awaiting');

    connected = true;
    assert.equal((await reviewer.approve(draft)).posted, true);
    assert.deepEqual(calls[1], { file: draft, media: { kind: 'video', path: path.join(dir, '2026-10-20-bunny.mp4'), title: 'Bunny OS' } });
    const record = await readReview(draft);
    assert.equal(record.state, 'posted');
    assert.equal(record.postUrn, 'urn:li:share:1');
    await assert.rejects(reviewer.approve(draft), { code: 'ALREADY_DECIDED' });
    await assert.rejects(reviewer.discard(draft), { code: 'ALREADY_DECIDED' });
    assert.equal(calls.length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a second approve while the first is posting is refused, and discard never posts', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loom-review-'));
  try {
    const draft = await draftIn(dir);
    await awaitReview(draft, {});
    let release;
    const reviewer = createReviewer({ publish: () => new Promise((resolve) => { release = () => resolve({ posted: true, summary: 'Posted.' }); }) });
    const pending = reviewer.approve(draft);
    await assert.rejects(reviewer.approve(draft), { code: 'BUSY' });
    await assert.rejects(reviewer.discard(draft), { code: 'BUSY' });
    while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    assert.equal((await pending).posted, true);

    const other = await draftIn(dir, '2026-10-22-bunny.md');
    await awaitReview(other, {});
    const quiet = createReviewer({ publish: async () => assert.fail('discard must not post') });
    assert.equal((await quiet.discard(other)).posted, false);
    assert.equal((await readReview(other)).state, 'discarded');
    await assert.rejects(quiet.approve(path.join(dir, 'none.md')), { code: 'NO_REVIEW' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the review API reads, approves and discards only known drafts, from the dashboard origin', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'loom-review-api-'));
  const draftsRoot = path.join(root, 'drafts');
  await mkdir(draftsRoot);
  const draft = await draftIn(draftsRoot);
  await awaitReview(draft, { media: { kind: 'video', path: path.join(draftsRoot, '2026-10-20-bunny.mp4') } });
  const runId = 'draft-run-1';
  const saved = {
    runs: [{ runId, jobId: 'linkedin-draft', date: '2026-10-20', state: 'succeeded', summary: 'Ready.' }],
    events: [{ runId, jobId: 'linkedin-draft', state: 'succeeded', artifactPath: draft }],
  };
  const store = { getSnapshot: () => saved };
  const queue = { snapshot: () => ({ paused: false, activeRun: null, queuedRuns: [], recentRuns: saved.runs, events: saved.events }), enqueue() {}, pause() {}, resume() {}, stop() { return false; } };
  const published = [];
  const review = createReviewer({ publish: async (file) => { published.push(file); return { posted: true, postUrn: 'urn:li:share:9', summary: 'Posted to LinkedIn.' }; } });
  const app = await createServer({ store, queue, port: 0, draftsRoot, hub: { review, jobIds: [] } });
  const base = `http://127.0.0.1:${app.address.port}`;
  try {
    const read = await fetch(`${base}/api/drafts/${runId}/review`);
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), { state: 'awaiting', media: { kind: 'video' }, createdAt: (await readReview(draft)).createdAt, decidedAt: null });

    assert.equal((await fetch(`${base}/api/drafts/${runId}/approve`)).status, 405);
    const foreign = await fetch(`${base}/api/drafts/${runId}/approve`, { method: 'POST', headers: { Origin: 'http://evil.example' } });
    assert.equal(foreign.status, 403);
    assert.equal((await fetch(`${base}/api/drafts/unknown-run/approve`, { method: 'POST' })).status, 404);
    assert.deepEqual(published, []);

    const approved = await fetch(`${base}/api/drafts/${runId}/approve`, { method: 'POST' });
    assert.equal(approved.status, 200);
    assert.deepEqual(await approved.json(), { posted: true, summary: 'Posted to LinkedIn.', state: 'posted' });
    assert.deepEqual(published, [draft]);
    const again = await fetch(`${base}/api/drafts/${runId}/discard`, { method: 'POST' });
    assert.equal(again.status, 409);
    assert.equal(JSON.parse(await readFile(reviewPath(draft), 'utf8')).state, 'posted');
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
