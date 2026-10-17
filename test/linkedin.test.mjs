import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLinkedInPostingJob } from '../src/jobs/linkedin-post.mjs';
import { createLinkedInAccount } from '../src/linkedin/account.mjs';
import { createComment, createPost, defaultVersion, toLittleText } from '../src/linkedin/api.mjs';
import { createPublisher, parseDraft } from '../src/linkedin/publish.mjs';
import { createQueue } from '../src/queue.mjs';
import { createServer } from '../src/server.mjs';
import { openStore } from '../src/store.mjs';

const REDIRECT = 'http://localhost:4173/linkedin/callback';
const POST = 'Bunny OS runs its assistant on a local model, so every reply is generated on the machine itself.\n\nHow do you test local inference? #LocalAI';
const DRAFT = `# Draft: Bunny OS\n\n- Formula: fact first\n- First comment: github.com/example-dev/Bunny-OS\n\n---\n\n${POST}\n`;

function response(status, body = {}, headers = {}) {
  return new Response(status === 201 && !Object.keys(body).length ? null : JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json', ...headers },
  });
}

// Records each call and answers from a list of handlers, one per request.
function fakeFetch(...answers) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url: String(url), options, body: options.body ? (String(options.body).startsWith('{') ? JSON.parse(options.body) : String(options.body)) : null });
    const answer = answers.shift();
    if (!answer) throw new Error(`Unexpected request to ${url}`);
    return typeof answer === 'function' ? answer(url, options) : answer;
  };
  impl.calls = calls;
  return impl;
}

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'automation-hub-linkedin-'));
}

async function connectedAccount(dir, fetchImpl, { now = () => Date.now() } = {}) {
  const account = createLinkedInAccount({ file: path.join(dir, 'linkedin.json'), redirectUri: REDIRECT, fetch: fetchImpl, now });
  await writeFile(path.join(dir, 'linkedin.json'), JSON.stringify({
    clientId: 'abcd1234efgh', clientSecret: 'secret-value-1',
    token: { accessToken: 'token-1', expiresAt: new Date(now() + 30 * 86_400_000).toISOString() },
    member: { personUrn: 'urn:li:person:abc', name: 'Test Person' },
  }));
  return account;
}

test('little text escapes reserved characters and keeps hashtags as tags', () => {
  assert.equal(toLittleText('Uses (Rust) & C++ #LocalAI'), 'Uses \\(Rust\\) & C++ {hashtag|\\#|LocalAI}');
  assert.equal(toLittleText('a_b*c @me'), 'a\\_b\\*c \\@me');
});

test('default API version is the previous month', () => {
  assert.equal(defaultVersion(new Date('2026-10-16T00:00:00Z')), '202609');
  assert.equal(defaultVersion(new Date('2026-01-05T00:00:00Z')), '202512');
});

test('createPost sends a public post and falls back when a version is retired', async () => {
  const fetchImpl = fakeFetch(response(426), response(201, {}, { 'x-restli-id': 'urn:li:share:1' }));
  const result = await createPost({ accessToken: 't', personUrn: 'urn:li:person:abc', text: POST, version: '202609', fetch: fetchImpl });
  assert.deepEqual(result, { postUrn: 'urn:li:share:1', version: '202608' });
  const [first, second] = fetchImpl.calls;
  assert.equal(first.options.headers['LinkedIn-Version'], '202609');
  assert.equal(second.options.headers['LinkedIn-Version'], '202608');
  assert.equal(second.url, 'https://api.linkedin.com/rest/posts');
  assert.equal(second.body.author, 'urn:li:person:abc');
  assert.equal(second.body.visibility, 'PUBLIC');
  assert.match(second.body.commentary, /\{hashtag\|\\#\|LocalAI\}$/);
});

test('createPost reports LinkedIn errors with their status', async () => {
  const fetchImpl = fakeFetch(response(401, { message: 'Expired token' }));
  await assert.rejects(
    createPost({ accessToken: 't', personUrn: 'urn:li:person:abc', text: POST, version: '202609', fetch: fetchImpl }),
    (error) => error.status === 401 && /Sign in to LinkedIn again/.test(error.message),
  );
});

test('createComment posts to the post’s comment thread', async () => {
  const fetchImpl = fakeFetch(response(201));
  await createComment({ accessToken: 't', personUrn: 'urn:li:person:abc', postUrn: 'urn:li:share:1', text: 'https://github.com/x/y', version: '202609', fetch: fetchImpl });
  assert.equal(fetchImpl.calls[0].url, 'https://api.linkedin.com/rest/socialActions/urn%3Ali%3Ashare%3A1/comments');
  assert.deepEqual(fetchImpl.calls[0].body.message, { text: 'https://github.com/x/y' });
});

test('parseDraft separates the post from the first comment', () => {
  assert.deepEqual(parseDraft(DRAFT.replace(/\n/g, '\r\n')), { post: POST, firstComment: 'https://github.com/example-dev/Bunny-OS' });
  assert.throws(() => parseDraft('# Draft only'), /no post section/);
});

test('account saves keys, signs in with a checked state, and disconnects', async () => {
  const dir = await tempDir();
  try {
    const fetchImpl = fakeFetch(
      response(200, { access_token: 'token-1', expires_in: 5_184_000, scope: 'openid,profile,w_member_social' }),
      response(200, { sub: 'abc', name: 'Test Person' }),
    );
    const account = createLinkedInAccount({ file: path.join(dir, 'linkedin.json'), redirectUri: REDIRECT, fetch: fetchImpl });
    assert.equal(account.status().configured, false);
    assert.throws(() => account.startConnect(), /credentials first/);
    await assert.rejects(account.saveApp({ clientId: 'x', clientSecret: 'y' }), RangeError);
    await account.saveApp({ clientId: 'abcd1234efgh', clientSecret: 'secret-value-1' });

    const url = new URL(account.startConnect());
    assert.equal(url.origin + url.pathname, 'https://www.linkedin.com/oauth/v2/authorization');
    assert.equal(url.searchParams.get('redirect_uri'), REDIRECT);
    assert.equal(url.searchParams.get('scope'), 'openid profile w_member_social');
    const state = url.searchParams.get('state');

    await assert.rejects(account.finishConnect({ code: 'c', state: 'wrong' }), /expired/);
    const status = await account.finishConnect({ code: 'c', state });
    assert.equal(status.connected, true);
    assert.equal(status.name, 'Test Person');
    assert.equal(status.expiresSoon, false);
    assert.deepEqual(account.credentials(), { accessToken: 'token-1', personUrn: 'urn:li:person:abc' });
    assert.match(fetchImpl.calls[0].body, /grant_type=authorization_code/);
    await assert.rejects(account.finishConnect({ code: 'c', state }), /expired/, 'a state is single-use');

    await account.disconnect();
    assert.equal(account.status().connected, false);
    assert.equal(account.status().configured, true);
    assert.equal(account.credentials(), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('account refuses a sign-in without posting permission', async () => {
  const dir = await tempDir();
  try {
    const fetchImpl = fakeFetch(response(200, { access_token: 't', expires_in: 100, scope: 'openid profile' }));
    const account = createLinkedInAccount({ file: path.join(dir, 'linkedin.json'), redirectUri: REDIRECT, fetch: fetchImpl });
    await account.saveApp({ clientId: 'abcd1234efgh', clientSecret: 'secret-value-1' });
    const state = new URL(account.startConnect()).searchParams.get('state');
    await assert.rejects(account.finishConnect({ code: 'c', state }), /Share on LinkedIn/);
    assert.equal(account.status().connected, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an expired token counts as not connected and warns a week ahead', async () => {
  const dir = await tempDir();
  try {
    let clock = Date.now();
    const account = await connectedAccount(dir, fakeFetch(), { now: () => clock });
    clock += 25 * 86_400_000;
    assert.equal(account.status().expiresSoon, true);
    clock += 10 * 86_400_000;
    assert.equal(account.status().connected, false);
    assert.equal(account.credentials(), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('publisher posts once, adds the repo comment, and never repeats a draft', async () => {
  const dir = await tempDir();
  try {
    const fetchImpl = fakeFetch(response(201, {}, { 'x-restli-id': 'urn:li:share:9' }), response(201));
    const account = await connectedAccount(dir, fetchImpl);
    const draftPath = path.join(dir, '2026-10-16-bunny-os.md');
    await writeFile(draftPath, DRAFT);
    const ledgerFile = path.join(dir, 'posted.json');
    const publish = createPublisher({ account, ledgerFile, fetch: fetchImpl, version: '202609' });

    const first = await publish(draftPath);
    assert.equal(first.posted, true);
    assert.match(first.summary, /first comment/);
    assert.equal(fetchImpl.calls[1].body.message.text, 'https://github.com/example-dev/Bunny-OS');
    assert.equal(JSON.parse(await readFile(ledgerFile, 'utf8'))['2026-10-16-bunny-os.md'].state, 'posted');

    const second = await publish(draftPath);
    assert.equal(second.posted, false);
    assert.equal(fetchImpl.calls.length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('publisher skips drafts with blanks and does nothing when not connected', async () => {
  const dir = await tempDir();
  try {
    const fetchImpl = fakeFetch();
    const draftPath = path.join(dir, 'd.md');
    await writeFile(draftPath, DRAFT.replace('on the machine itself', 'on [SLOT: device]'));
    const ledgerFile = path.join(dir, 'posted.json');
    const account = await connectedAccount(dir, fetchImpl);
    const blank = await createPublisher({ account, ledgerFile, fetch: fetchImpl })(draftPath);
    assert.equal(blank.posted, false);
    assert.match(blank.summary, /blank/);

    await account.disconnect();
    const off = await createPublisher({ account, ledgerFile, fetch: fetchImpl })(draftPath);
    assert.match(off.summary, /isn’t connected/);
    assert.equal(fetchImpl.calls.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('publisher allows a retry after LinkedIn refuses, but not after a lost connection', async () => {
  const dir = await tempDir();
  try {
    const draftPath = path.join(dir, 'd.md');
    await writeFile(draftPath, DRAFT);
    const ledgerFile = path.join(dir, 'posted.json');

    const refused = fakeFetch(response(500, { message: 'Down' }));
    const account = await connectedAccount(dir, refused);
    await assert.rejects(createPublisher({ account, ledgerFile, fetch: refused })(draftPath), /500/);
    assert.deepEqual(JSON.parse(await readFile(ledgerFile, 'utf8')), {});

    const lost = fakeFetch(() => { throw new TypeError('socket hang up'); });
    await assert.rejects(createPublisher({ account, ledgerFile, fetch: lost })(draftPath), /Could not reach LinkedIn/);
    const again = await createPublisher({ account, ledgerFile, fetch: fakeFetch() })(draftPath);
    assert.equal(again.posted, false);
    assert.match(again.summary, /may have reached LinkedIn/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a failed comment still counts the post as published', async () => {
  const dir = await tempDir();
  try {
    const fetchImpl = fakeFetch(response(201, {}, { 'x-restli-id': 'urn:li:share:9' }), response(403, { message: 'No' }));
    const account = await connectedAccount(dir, fetchImpl);
    const draftPath = path.join(dir, 'd.md');
    await writeFile(draftPath, DRAFT);
    const result = await createPublisher({ account, ledgerFile: path.join(dir, 'posted.json'), fetch: fetchImpl })(draftPath);
    assert.equal(result.posted, true);
    assert.match(result.summary, /comment failed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('posting job publishes a new draft and reports the outcome', async () => {
  const published = [];
  const job = createLinkedInPostingJob({
    draftJob: { run: async () => ({ summary: 'Draft ready.', artifactPath: 'X:\\d.md' }) },
    publish: async (file) => { published.push(file); return { summary: 'Posted to LinkedIn.' }; },
  });
  assert.deepEqual(await job.run({ signal: new AbortController().signal }), { summary: 'Posted to LinkedIn.', artifactPath: 'X:\\d.md' });
  assert.deepEqual(published, ['X:\\d.md']);

  const skipped = createLinkedInPostingJob({
    draftJob: { run: async () => ({ summary: 'A draft already exists for today.', artifactPath: null }) },
    publish: async () => assert.fail('nothing to publish'),
  });
  assert.equal((await skipped.run({})).summary, 'A draft already exists for today.');

  const failing = createLinkedInPostingJob({
    draftJob: { run: async () => ({ summary: 'Draft ready.', artifactPath: 'X:\\d.md' }) },
    publish: async () => { throw new Error('LinkedIn post failed (500).'); },
  });
  await assert.rejects(failing.run({}), /Draft saved, but posting failed: LinkedIn post failed/);
});

function send(port, method, pathname, { host = `127.0.0.1:${port}`, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path: pathname, method, headers: { Host: host, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

test('server exposes LinkedIn status, key setup, sign-in redirects and disconnect', async () => {
  const dir = await tempDir();
  const store = openStore(path.join(dir, 'hub.sqlite'));
  const queue = createQueue({ store, jobs: { 'linkedin-draft': { run: async () => ({ summary: 'ok', artifactPath: null }) } } });
  const fetchImpl = fakeFetch(
    response(200, { access_token: 'token-1', expires_in: 5_184_000, scope: 'openid profile w_member_social' }),
    response(200, { sub: 'abc', name: 'Test Person' }),
  );
  const linkedin = createLinkedInAccount({ file: path.join(dir, 'linkedin.json'), redirectUri: REDIRECT, fetch: fetchImpl });
  const app = await createServer({ store, queue, port: 0, linkedin });
  const port = app.address.port;
  const origin = `http://127.0.0.1:${port}`;
  try {
    const initial = JSON.parse((await send(port, 'GET', '/api/linkedin')).text);
    assert.equal(initial.configured, false);

    const noKeys = await send(port, 'GET', '/linkedin/connect');
    assert.equal(noKeys.status, 302);
    assert.match(noKeys.headers.location, /\?linkedin=Add%20your%20LinkedIn/);

    const json = { 'Content-Type': 'application/json', Origin: origin };
    const crossSite = await send(port, 'POST', '/api/linkedin/app', { headers: { ...json, Origin: 'https://evil.example' }, body: '{}' });
    assert.equal(crossSite.status, 403);
    const bad = await send(port, 'POST', '/api/linkedin/app', { headers: json, body: JSON.stringify({ clientId: 'x', clientSecret: 'y' }) });
    assert.equal(bad.status, 400);
    const saved = await send(port, 'POST', '/api/linkedin/app', { headers: json, body: JSON.stringify({ clientId: 'abcd1234efgh', clientSecret: 'secret-value-1' }) });
    assert.equal(JSON.parse(saved.text).configured, true);
    assert.doesNotMatch(saved.text, /secret-value-1/);

    const connect = await send(port, 'GET', '/linkedin/connect');
    const state = new URL(connect.headers.location).searchParams.get('state');
    assert.ok(state);

    assert.equal((await send(port, 'GET', '/api/linkedin', { host: `localhost:${port}` })).status, 403, 'only the callback accepts localhost');
    const cancelled = await send(port, 'GET', '/linkedin/callback?error=user_cancelled_login', { host: `localhost:${port}` });
    assert.match(cancelled.headers.location, /cancelled/);
    const callback = await send(port, 'GET', `/linkedin/callback?code=c&state=${state}`, { host: `localhost:${port}` });
    assert.equal(callback.headers.location, `http://127.0.0.1:${port}/?linkedin=connected`);
    assert.equal(JSON.parse((await send(port, 'GET', '/api/linkedin')).text).name, 'Test Person');

    const disconnected = await send(port, 'POST', '/api/linkedin/disconnect', { headers: { Origin: origin } });
    assert.equal(JSON.parse(disconnected.text).connected, false);
  } finally {
    queue.destroy();
    await app.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('uploadImage initializes, uploads the bytes and returns the image id', async () => {
  const { uploadImage } = await import('../src/linkedin/api.mjs');
  const fetchImpl = fakeFetch(
    response(200, { value: { uploadUrl: 'https://www.linkedin.com/dms-uploads/img', image: 'urn:li:image:1' } }),
    response(201),
  );
  const id = await uploadImage({ accessToken: 't', personUrn: 'urn:li:person:abc', bytes: Buffer.from('png-bytes'), version: '202609', fetch: fetchImpl });
  assert.equal(id, 'urn:li:image:1');
  assert.equal(fetchImpl.calls[0].url, 'https://api.linkedin.com/rest/images?action=initializeUpload');
  assert.deepEqual(fetchImpl.calls[0].body, { initializeUploadRequest: { owner: 'urn:li:person:abc' } });
  assert.equal(fetchImpl.calls[1].options.method, 'PUT');
  assert.equal(fetchImpl.calls[1].url, 'https://www.linkedin.com/dms-uploads/img');
});

test('uploadVideo uploads each part, finalizes with the ETags and waits until available', async () => {
  const { uploadVideo } = await import('../src/linkedin/api.mjs');
  const bytes = Buffer.alloc(10, 1);
  const fetchImpl = fakeFetch(
    response(200, { value: { video: 'urn:li:video:9', uploadToken: 'tok', uploadInstructions: [
      { uploadUrl: 'https://up/1', firstByte: 0, lastByte: 5 }, { uploadUrl: 'https://up/2', firstByte: 6, lastByte: 9 },
    ] } }),
    response(200, {}, { etag: 'e1' }),
    response(200, {}, { etag: 'e2' }),
    response(200),
    response(200, { status: 'PROCESSING' }),
    response(200, { status: 'AVAILABLE' }),
  );
  const id = await uploadVideo({ accessToken: 't', personUrn: 'urn:li:person:abc', bytes, version: '202609', fetch: fetchImpl, sleep: async () => {} });
  assert.equal(id, 'urn:li:video:9');
  assert.equal(fetchImpl.calls[0].body.initializeUploadRequest.fileSizeBytes, 10);
  assert.equal(fetchImpl.calls[1].options.body.length, 6);
  assert.equal(fetchImpl.calls[2].options.body.length, 4);
  assert.deepEqual(fetchImpl.calls[3].body.finalizeUploadRequest, { video: 'urn:li:video:9', uploadToken: 'tok', uploadedPartIds: ['e1', 'e2'] });
  assert.equal(fetchImpl.calls[4].url, 'https://api.linkedin.com/rest/videos/urn%3Ali%3Avideo%3A9');
  assert.equal(fetchImpl.calls[4].options.method, 'GET');
});

test('uploadVideo reports a failed LinkedIn processing step', async () => {
  const { uploadVideo } = await import('../src/linkedin/api.mjs');
  const fetchImpl = fakeFetch(
    response(200, { value: { video: 'urn:li:video:9', uploadToken: '', uploadInstructions: [{ uploadUrl: 'https://up/1', firstByte: 0, lastByte: 3 }] } }),
    response(200, {}, { etag: 'e1' }),
    response(200),
    response(200, { status: 'PROCESSING_FAILED', processingFailureReason: 'Bad codec' }),
  );
  await assert.rejects(uploadVideo({ accessToken: 't', personUrn: 'p', bytes: Buffer.alloc(4), fetch: fetchImpl, sleep: async () => {} }), /Bad codec/);
});

test('publisher attaches an uploaded video to the post', async () => {
  const dir = await tempDir();
  try {
    const fetchImpl = fakeFetch(response(201, {}, { 'x-restli-id': 'urn:li:share:9' }), response(201));
    const account = await connectedAccount(dir, fetchImpl);
    const draftPath = path.join(dir, 'd.md');
    await writeFile(draftPath, DRAFT);
    const videoPath = path.join(dir, 'd.mp4');
    await writeFile(videoPath, Buffer.alloc(2048));
    const uploads = { uploadVideo: async ({ bytes }) => { assert.equal(bytes.length, 2048); return 'urn:li:video:5'; }, uploadImage: async () => assert.fail('no image') };
    const result = await createPublisher({ account, ledgerFile: path.join(dir, 'p.json'), fetch: fetchImpl, uploads })(draftPath, { media: { kind: 'video', path: videoPath, title: 'Bunny OS' } });
    assert.equal(result.posted, true);
    assert.match(result.summary, /with the video and the repo link/);
    assert.deepEqual(fetchImpl.calls[0].body.content, { media: { id: 'urn:li:video:5', title: 'Bunny OS' } });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('publisher posts text when the media upload fails or LinkedIn refuses the media', async () => {
  const dir = await tempDir();
  try {
    const draftPath = path.join(dir, 'd.md');
    await writeFile(draftPath, DRAFT);
    const imagePath = path.join(dir, 'd.png');
    await writeFile(imagePath, Buffer.alloc(100));

    const first = fakeFetch(response(201, {}, { 'x-restli-id': 'urn:li:share:1' }), response(201));
    const account = await connectedAccount(dir, first);
    const failing = { uploadImage: async () => { throw new Error('upload broke'); }, uploadVideo: async () => assert.fail() };
    const textOnly = await createPublisher({ account, ledgerFile: path.join(dir, 'a.json'), fetch: first, uploads: failing })(draftPath, { media: { kind: 'image', path: imagePath, title: 'x' } });
    assert.equal(textOnly.posted, true);
    assert.match(textOnly.summary, /upload failed \(upload broke\), so it went out as text/);
    assert.equal(first.calls[0].body.content, undefined);

    const second = fakeFetch(response(422, { message: 'Bad media' }), response(201, {}, { 'x-restli-id': 'urn:li:share:2' }), response(201));
    const working = { uploadImage: async () => 'urn:li:image:3', uploadVideo: async () => assert.fail() };
    const retried = await createPublisher({ account, ledgerFile: path.join(dir, 'b.json'), fetch: second, uploads: working })(draftPath, { media: { kind: 'image', path: imagePath, title: 'x' } });
    assert.equal(retried.posted, true);
    assert.deepEqual(second.calls[0].body.content, { media: { id: 'urn:li:image:3', altText: 'x' } });
    assert.equal(second.calls[1].body.content, undefined);
    assert.match(retried.summary, /refused the post with the image/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('posting job renders media for the draft’s project and picks video or image by day', async () => {
  const { mediaKindFor } = await import('../src/jobs/linkedin-post.mjs');
  assert.equal(mediaKindFor('2026-10-20'), 'video');
  assert.equal(mediaKindFor('2026-10-22'), 'image');

  const dir = await tempDir();
  try {
    const draftPath = path.join(dir, '2026-10-22-bunny.md');
    await writeFile(draftPath, DRAFT.replace('- Formula:', '- Project: Bunny OS\n- Formula:'));
    const calls = [];
    const job = createLinkedInPostingJob({
      draftJob: { run: async () => ({ summary: 'Draft ready.', artifactPath: draftPath }) },
      renderMedia: async (options) => { calls.push(options); return { name: 'Bunny OS', video: `${options.outBase}.mp4`, image: `${options.outBase}.png`, note: '' }; },
      publish: async (file, { media }) => { calls.push(media); return { summary: 'Posted to LinkedIn with the image.' }; },
    });
    const result = await job.run({ date: '2026-10-22', signal: new AbortController().signal, report: () => {} });
    assert.equal(calls[0].topic, 'Bunny OS');
    assert.equal(calls[0].outBase, path.join(dir, '2026-10-22-bunny'));
    assert.deepEqual(calls[1], { kind: 'image', path: path.join(dir, '2026-10-22-bunny.png'), title: 'Bunny OS' });
    assert.equal(result.summary, 'Posted to LinkedIn with the image.');

    const broken = createLinkedInPostingJob({
      draftJob: { run: async () => ({ summary: 'Draft ready.', artifactPath: draftPath }) },
      renderMedia: async () => { throw new Error('Video render failed.'); },
      publish: async (file, { media }) => { assert.equal(media, undefined); return { summary: 'Posted to LinkedIn.' }; },
    });
    assert.equal((await broken.run({ date: '2026-10-20', signal: new AbortController().signal })).summary, 'Posted to LinkedIn. Media wasn’t made (Video render failed.).');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
