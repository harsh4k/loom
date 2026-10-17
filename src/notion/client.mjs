// A small Notion API client for the Projects database: read every page, create a page, and
// change page properties. It never deletes or trashes anything.
import { NOTION_VERSION } from '../connections.mjs';
import { createJsonClient } from '../http.mjs';
import { getProfile, need } from '../profile.mjs';

export const projectsDatabaseId = () => need(getProfile().notion.projectsDatabaseId, 'notion.projectsDatabaseId');
export const reportPageId = () => need(getProfile().notion.reportPageId, 'notion.reportPageId');
const TEXT_LIMIT = 2000;

export const plainText = (richText) => (Array.isArray(richText) ? richText.map((part) => part?.plain_text ?? part?.text?.content ?? '').join('') : '');

// Reads the fields the hub cares about from a Notion page object.
export function readPage(page) {
  const props = page?.properties ?? {};
  return {
    id: String(page.id),
    name: plainText(props.Name?.title).trim(),
    githubUrl: props['GitHub URL']?.url ?? null,
    Description: plainText(props.Description?.rich_text),
    'Tech Stack': plainText(props['Tech Stack']?.rich_text),
    Status: props.Status?.select?.name ?? null,
    Type: props.Type?.select?.name ?? null,
    hasPortfolioBox: Object.hasOwn(props, 'On portfolio'),
    onPortfolio: props['On portfolio']?.checkbox === true,
    'Portfolio ID': plainText(props['Portfolio ID']?.rich_text).trim(),
  };
}

// Turns plain values into Notion property objects. Only these fields can be written.
export const WRITABLE_FIELDS = Object.freeze(['Name', 'GitHub URL', 'Description', 'Tech Stack', 'Status', 'Type', 'Portfolio ID']);
export function toProperties(values) {
  const properties = {};
  for (const [field, value] of Object.entries(values)) {
    if (!WRITABLE_FIELDS.includes(field)) throw new RangeError(`The hub may not write the ${field} field.`);
    const content = value === null || value === undefined ? '' : String(value).slice(0, TEXT_LIMIT);
    if (field === 'Name') properties.Name = { title: [{ type: 'text', text: { content } }] };
    else if (field === 'GitHub URL') properties[field] = { url: content || null };
    else if (field === 'Status' || field === 'Type') properties[field] = { select: content ? { name: content } : null };
    else properties[field] = { rich_text: content ? [{ type: 'text', text: { content } }] : [] };
  }
  return properties;
}

export function createNotion({ token, databaseId = projectsDatabaseId(), fetch: fetchImpl = fetch }) {
  if (!token) throw new Error('Notion isn’t connected. Add your Notion key on the Accounts page.');
  const headers = { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION };
  const api = createJsonClient({ service: 'Notion', base: 'https://api.notion.com/v1', headers, fetch: fetchImpl });
  // A create whose answer is lost may still have happened, so it is never resent within a run;
  // the next run reads the database again and finds the page by its GitHub URL.
  const createApi = createJsonClient({ service: 'Notion', base: 'https://api.notion.com/v1', headers, fetch: fetchImpl, attempts: 1 });

  async function listPages({ signal } = {}) {
    const pages = [];
    let cursor;
    for (let round = 0; round < 20; round++) {
      const body = await api('POST', `/databases/${databaseId}/query`, { signal, body: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) } });
      if (!Array.isArray(body?.results)) throw new Error('Notion sent an unexpected answer for the Projects database.');
      pages.push(...body.results.filter((page) => !page.archived && !page.in_trash).map(readPage));
      if (!body.has_more || !body.next_cursor) return pages;
      cursor = body.next_cursor;
    }
    throw new Error('The Projects database has more pages than the hub reads (2000).');
  }

  async function createPage(values, { signal } = {}) {
    const page = await createApi('POST', '/pages', { signal, body: { parent: { database_id: databaseId }, properties: toProperties(values) } });
    return readPage(page);
  }

  async function getPage(pageId, { signal } = {}) {
    return readPage(await api('GET', `/pages/${pageId}`, { signal }));
  }

  async function updatePage(pageId, values, { signal } = {}) {
    return readPage(await api('PATCH', `/pages/${pageId}`, { signal, body: { properties: toProperties(values) } }));
  }

  // Blocks inside a page. The hub only appends its own blocks and edits those it made.
  async function listChildren(pageId, { signal } = {}) {
    const blocks = [];
    let cursor;
    for (let round = 0; round < 10; round++) {
      const body = await api('GET', `/blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`, { signal });
      blocks.push(...(body?.results ?? []));
      if (!body?.has_more || !body.next_cursor) break;
      cursor = body.next_cursor;
    }
    return blocks;
  }

  async function appendChildren(pageId, children, { signal } = {}) {
    const body = await createApi('PATCH', `/blocks/${pageId}/children`, { signal, body: { children } });
    return body?.results ?? [];
  }

  // null when the block is gone or in the trash.
  async function getBlock(blockId, { signal } = {}) {
    const block = await api('GET', `/blocks/${blockId}`, { signal, allow404: true });
    return block && !block.archived && !block.in_trash ? block : null;
  }

  async function updateBlock(blockId, payload, { signal } = {}) {
    return api('PATCH', `/blocks/${blockId}`, { signal, body: payload });
  }

  // A plain page under another page (not a database row), for reports.
  async function createChildPage(parentPageId, title, children, { signal } = {}) {
    const page = await createApi('POST', '/pages', {
      signal, body: { parent: { page_id: parentPageId }, properties: { title: { title: [{ type: 'text', text: { content: String(title).slice(0, 200) } }] } }, children: children.slice(0, 100) },
    });
    return { id: String(page.id), url: page.url ?? null };
  }

  return { listPages, createPage, getPage, updatePage, createChildPage, listChildren, appendChildren, getBlock, updateBlock };
}
