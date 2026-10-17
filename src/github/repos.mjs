// Reads the profile's GitHub repos: the list, and on demand each repo's languages and manifest files,
// which is what the tech stack is built from. Public repos need no key; a key adds private ones.
import { createJsonClient } from '../http.mjs';
import { getProfile, need } from '../profile.mjs';

export const githubUser = () => need(getProfile().github.user, 'github.user');
const MANIFESTS = ['package.json', 'Cargo.toml', 'requirements.txt', 'pyproject.toml'];

export function canonicalRepoUrl(value) {
  if (typeof value !== 'string') return null;
  const match = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?(?:[?#].*)?$/i.exec(value.trim());
  return match ? `https://github.com/${match[1]}/${match[2]}`.toLowerCase() : null;
}

export function createGitHub({ token = null, user = githubUser(), fetch: fetchImpl = fetch } = {}) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'loom-automation-hub', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const api = createJsonClient({ service: 'GitHub', base: 'https://api.github.com', headers, fetch: fetchImpl });

  async function listRepos({ signal } = {}) {
    const repos = [];
    for (let page = 1; page <= 10; page++) {
      const route = token ? `/user/repos?affiliation=owner&per_page=100&page=${page}` : `/users/${user}/repos?type=owner&per_page=100&page=${page}`;
      const batch = await api('GET', route, { signal });
      if (!Array.isArray(batch)) throw new Error('GitHub sent an unexpected repo list.');
      repos.push(...batch);
      if (batch.length < 100) break;
    }
    return repos.filter((repo) => !repo.fork).map((repo) => ({
      name: String(repo.name),
      fullName: String(repo.full_name),
      url: canonicalRepoUrl(repo.html_url),
      htmlUrl: String(repo.html_url),
      description: typeof repo.description === 'string' ? repo.description.trim() : '',
      homepage: typeof repo.homepage === 'string' ? repo.homepage.trim() : '',
      archived: repo.archived === true,
      private: repo.private === true,
      pushedAt: repo.pushed_at ?? null,
    }));
  }

  // null when GitHub says the repo doesn't exist (or isn't visible without a key).
  async function getRepo(fullName, { signal } = {}) {
    return api('GET', `/repos/${fullName}`, { signal, allow404: true });
  }

  async function languages(fullName, { signal } = {}) {
    return (await api('GET', `/repos/${fullName}/languages`, { signal, allow404: true })) ?? {};
  }

  // The text of a file at the default branch, or null. Public files come from raw.githubusercontent.com,
  // which doesn't count against the API rate limit.
  async function file(fullName, filePath, { signal } = {}) {
    if (token) {
      const body = await api('GET', `/repos/${fullName}/contents/${filePath}`, { signal, allow404: true });
      return body?.content ? Buffer.from(body.content, 'base64').toString('utf8') : null;
    }
    return api('GET', `https://raw.githubusercontent.com/${fullName}/HEAD/${filePath}`, { signal, allow404: true, raw: true });
  }

  async function manifests(fullName, options) {
    const found = {};
    for (const name of MANIFESTS) {
      const text = await file(fullName, name, options);
      if (typeof text === 'string' && text.length < 200_000) found[name] = text;
    }
    return found;
  }

  async function readme(fullName, options = {}) {
    if (token) {
      const body = await api('GET', `/repos/${fullName}/readme`, { ...options, allow404: true });
      return body?.content ? Buffer.from(body.content, 'base64').toString('utf8') : null;
    }
    for (const name of ['README.md', 'readme.md', 'Readme.md', 'README']) {
      const text = await file(fullName, name, options);
      if (typeof text === 'string') return text;
    }
    return null;
  }

  // The first line of each of the latest commit messages.
  async function commitMessages(fullName, { signal, count = 20 } = {}) {
    const body = await api('GET', `/repos/${fullName}/commits?per_page=${count}`, { signal, allow404: true });
    return Array.isArray(body) ? body.map((item) => String(item?.commit?.message ?? '').split('\n')[0].trim()).filter(Boolean) : [];
  }

  // When a file last changed on the default branch, or null.
  async function lastChanged(fullName, filePath, { signal } = {}) {
    const body = await api('GET', `/repos/${fullName}/commits?path=${encodeURIComponent(filePath)}&per_page=1`, { signal, allow404: true });
    return Array.isArray(body) && body[0] ? (body[0].commit?.committer?.date ?? body[0].commit?.author?.date ?? null) : null;
  }

  // A file's text and sha through the contents API (needs a key for writing, not for reading).
  async function getContent(fullName, filePath, { signal } = {}) {
    const body = await api('GET', `/repos/${fullName}/contents/${filePath}`, { signal, allow404: true });
    if (!body || Array.isArray(body)) return null;
    return { sha: body.sha, text: Buffer.from(body.content ?? '', 'base64').toString('utf8') };
  }

  async function listDirectory(fullName, dirPath, { signal } = {}) {
    const body = await api('GET', `/repos/${fullName}/contents/${dirPath}`, { signal, allow404: true });
    return Array.isArray(body) ? body.map((entry) => ({ name: String(entry.name), type: entry.type })) : [];
  }

  // Commits one file. `sha` is the version being replaced, so a file changed meanwhile is refused.
  async function putContent(fullName, filePath, { text, sha, message, signal }) {
    if (!token) throw new Error('Add a GitHub key on the Accounts page to let the hub update your portfolio.');
    const body = await api('PUT', `/repos/${fullName}/contents/${filePath}`, {
      signal, body: { message, content: Buffer.from(text, 'utf8').toString('base64'), ...(sha ? { sha } : {}) },
    });
    return { sha: body?.content?.sha ?? null, commit: body?.commit?.sha ?? null, url: body?.commit?.html_url ?? null };
  }

  return { listRepos, getRepo, languages, file, manifests, readme, commitMessages, lastChanged, getContent, listDirectory, putContent };
}
