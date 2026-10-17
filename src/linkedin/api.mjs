// Minimal client for LinkedIn's official member APIs: OpenID sign-in, Posts and Comments.
// Uses only the self-serve "Sign In with LinkedIn using OpenID Connect" and "Share on LinkedIn" products.
const AUTH_URL = 'https://www.linkedin.com/oauth/v2/authorization';
const TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
const API = 'https://api.linkedin.com';
export const SCOPES = 'openid profile w_member_social';
export const POST_LIMIT = 3000;
const VERSION_FALLBACKS = 6;
const REQUEST_TIMEOUT_MS = 30_000;

export class LinkedInError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'LinkedInError';
    this.status = status;
  }
}

// LinkedIn versions are monthly (YYYYMM); start from last month so a fresh release isn't required.
export function defaultVersion(now = new Date()) {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}
function previousVersion(version) {
  const year = Number(version.slice(0, 4));
  const month = Number(version.slice(4));
  const date = new Date(Date.UTC(year, month - 2, 1));
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Post commentary uses LinkedIn's "little text" format: reserved characters must be escaped,
// and hashtags need the hashtag template to render as tags rather than literal text.
export function toLittleText(text) {
  const escaped = text.replace(/[\\|{}@[\]()<>#*_~]/g, (char) => `\\${char}`);
  return escaped.replace(/(^|\s)\\#([\p{L}\p{N}_]+)/gu, (_, lead, tag) => `${lead}{hashtag|\\#|${tag}}`);
}

export function authorizationUrl({ clientId, redirectUri, state }) {
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state, scope: SCOPES }).toString();
  return url.toString();
}

async function call(fetchImpl, url, options) {
  let response;
  try {
    response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw new LinkedInError(`Could not reach LinkedIn (${error?.name === 'TimeoutError' ? 'timed out' : 'network error'}).`);
  }
  return response;
}

async function errorFrom(response, action) {
  let detail = '';
  try { detail = (await response.json())?.message ?? ''; } catch { /* Keep the status-only message. */ }
  const hint = response.status === 401 ? ' Sign in to LinkedIn again from the dashboard.' : '';
  return new LinkedInError(`LinkedIn ${action} failed (${response.status})${detail ? `: ${String(detail).slice(0, 200)}` : ''}.${hint}`, response.status);
}

export async function exchangeCode({ clientId, clientSecret, code, redirectUri, fetch: fetchImpl = fetch, now = Date.now() }) {
  const response = await call(fetchImpl, TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret }).toString(),
  });
  if (!response.ok) throw await errorFrom(response, 'sign-in');
  const body = await response.json();
  if (typeof body.access_token !== 'string' || !Number.isFinite(body.expires_in)) throw new LinkedInError('LinkedIn sign-in returned no access token.');
  return { accessToken: body.access_token, expiresAt: new Date(now + body.expires_in * 1000).toISOString(), scope: String(body.scope ?? '') };
}

export async function getMember({ accessToken, fetch: fetchImpl = fetch }) {
  const response = await call(fetchImpl, `${API}/v2/userinfo`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw await errorFrom(response, 'profile lookup');
  const body = await response.json();
  if (typeof body.sub !== 'string' || !body.sub) throw new LinkedInError('LinkedIn profile lookup returned no member id.');
  return { personUrn: `urn:li:person:${body.sub}`, name: typeof body.name === 'string' ? body.name.slice(0, 100) : '' };
}

async function versioned(fetchImpl, path, { accessToken, version, body, method = 'POST' }) {
  let current = version || defaultVersion();
  for (let attempt = 0; attempt <= VERSION_FALLBACKS; attempt++) {
    const response = await call(fetchImpl, `${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        'LinkedIn-Version': current,
        'X-Restli-Protocol-Version': '2.0.0',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status !== 426) return { response, version: current };
    current = previousVersion(current);
  }
  throw new LinkedInError('LinkedIn rejected every recent API version.');
}

// media: { id: 'urn:li:image:…' | 'urn:li:video:…', title } attaches one uploaded image or video.
export async function createPost({ accessToken, personUrn, text, media, version, fetch: fetchImpl = fetch }) {
  const commentary = toLittleText(text);
  if (commentary.length > POST_LIMIT) throw new LinkedInError(`Post is longer than LinkedIn's ${POST_LIMIT}-character limit.`);
  const { response, version: used } = await versioned(fetchImpl, '/rest/posts', {
    accessToken, version,
    body: {
      author: personUrn,
      commentary,
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
      ...(media ? { content: { media: media.id.startsWith('urn:li:image:') ? { id: media.id, altText: media.title } : { id: media.id, title: media.title } } } : {}),
    },
  });
  if (response.status !== 201) throw await errorFrom(response, 'post');
  const postUrn = response.headers.get('x-restli-id');
  if (!postUrn) throw new LinkedInError('LinkedIn accepted the post but returned no post id.');
  return { postUrn, version: used };
}

export async function createComment({ accessToken, personUrn, postUrn, text, version, fetch: fetchImpl = fetch }) {
  const { response } = await versioned(fetchImpl, `/rest/socialActions/${encodeURIComponent(postUrn)}/comments`, {
    accessToken, version,
    body: { actor: personUrn, object: postUrn, message: { text } },
  });
  if (response.status !== 201) throw await errorFrom(response, 'comment');
}

const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

async function upload(fetchImpl, url, bytes, accessToken) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/octet-stream' },
      body: bytes,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    throw new LinkedInError(`Could not upload media to LinkedIn (${error?.name === 'TimeoutError' ? 'timed out' : 'network error'}).`);
  }
  if (!response.ok) throw await errorFrom(response, 'media upload');
  return response;
}

async function initialize(fetchImpl, path, options, action) {
  const { response, version } = await versioned(fetchImpl, path, options);
  if (!response.ok) throw await errorFrom(response, action);
  const value = (await response.json())?.value;
  if (!value) throw new LinkedInError(`LinkedIn ${action} returned no upload details.`);
  return { value, version };
}

// Images API: initialize, then PUT the bytes. Returns the image URN.
export async function uploadImage({ accessToken, personUrn, bytes, version, fetch: fetchImpl = fetch }) {
  const { value } = await initialize(fetchImpl, '/rest/images?action=initializeUpload',
    { accessToken, version, body: { initializeUploadRequest: { owner: personUrn } } }, 'image setup');
  if (typeof value.uploadUrl !== 'string' || typeof value.image !== 'string') throw new LinkedInError('LinkedIn image setup returned no upload URL.');
  await upload(fetchImpl, value.uploadUrl, bytes, accessToken);
  return value.image;
}

// Videos API: initialize, PUT each byte range, finalize with the part ETags, then wait for processing.
export async function uploadVideo({
  accessToken, personUrn, bytes, version, fetch: fetchImpl = fetch,
  pollMs = 5_000, maxWaitMs = 5 * 60 * 1000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const { value, version: used } = await initialize(fetchImpl, '/rest/videos?action=initializeUpload', {
    accessToken, version,
    body: { initializeUploadRequest: { owner: personUrn, fileSizeBytes: bytes.length, uploadCaptions: false, uploadThumbnail: false } },
  }, 'video setup');
  const parts = value.uploadInstructions;
  if (typeof value.video !== 'string' || !Array.isArray(parts) || !parts.length) throw new LinkedInError('LinkedIn video setup returned no upload instructions.');
  const etags = [];
  for (const part of parts) {
    const response = await upload(fetchImpl, part.uploadUrl, bytes.subarray(part.firstByte, part.lastByte + 1), accessToken);
    const etag = response.headers.get('etag');
    if (!etag) throw new LinkedInError('LinkedIn did not confirm a video upload part.');
    etags.push(etag);
  }
  const { response: finalized } = await versioned(fetchImpl, '/rest/videos?action=finalizeUpload', {
    accessToken, version: used,
    body: { finalizeUploadRequest: { video: value.video, uploadToken: value.uploadToken ?? '', uploadedPartIds: etags } },
  });
  if (!finalized.ok) throw await errorFrom(finalized, 'video finalize');

  for (let waited = 0; waited <= maxWaitMs; waited += pollMs) {
    const { response } = await versioned(fetchImpl, `/rest/videos/${encodeURIComponent(value.video)}`, { accessToken, version: used, method: 'GET' });
    if (!response.ok) throw await errorFrom(response, 'video status');
    const body = await response.json();
    if (body?.status === 'AVAILABLE') return value.video;
    if (body?.status === 'PROCESSING_FAILED') throw new LinkedInError(`LinkedIn could not process the video${body.processingFailureReason ? `: ${String(body.processingFailureReason).slice(0, 120)}` : '.'}`);
    await sleep(pollMs);
  }
  throw new LinkedInError('LinkedIn was still processing the video after 5 minutes.');
}
