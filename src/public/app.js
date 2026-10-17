const $ = (selector) => document.querySelector(selector);
const api = (path, options = {}) => fetch(path, { cache: 'no-store', ...options });
const SVG_NS = 'http://www.w3.org/2000/svg';
const VIEWS = ['overview', 'automation', 'activity', 'changes', 'accounts', 'drafts'];
const STATE_LABELS = {
  queued: 'Queued', running: 'Running', succeeded: 'Done', failed: 'Failed',
  cancelled: 'Stopped', interrupted: 'Interrupted', idle: 'Idle', paused: 'Paused', planned: 'Not set up', off: 'Off',
};

// Times show in the hub's time zone (config/profile.json), sent with the automation list.
let timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const formatCache = new Map();
function formatter(options) {
  return {
    format(value) {
      const key = `${timeZone}|${JSON.stringify(options)}`;
      if (!formatCache.has(key)) formatCache.set(key, new Intl.DateTimeFormat(undefined, { timeZone, ...options }));
      return formatCache.get(key).format(value);
    },
  };
}
const timeFormat = formatter({ hour: 'numeric', minute: '2-digit' });
const dayTimeFormat = formatter({ weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const longDateFormat = formatter({ weekday: 'long', day: 'numeric', month: 'long' });

function zoneParts(date) {
  const key = `${timeZone}|parts`;
  if (!formatCache.has(key)) formatCache.set(key, new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }));
  const parts = Object.fromEntries(formatCache.get(key).formatToParts(date).map(({ type, value }) => [type, Number(value)]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute };
}
function dateInZone(now = new Date()) {
  const { year, month, day } = zoneParts(now);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
// The moment a wall-clock time happens in the hub's time zone (daylight saving included).
function zonedTime(year, month, day, hour, minute) {
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wanted;
  for (let pass = 0; pass < 3; pass++) {
    const seen = zoneParts(new Date(guess));
    const diff = wanted - Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute);
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}
function displayTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return 'Time unavailable';
  const sameDay = dateInZone(date) === dateInZone();
  return sameDay ? `Today, ${timeFormat.format(date)}` : dayTimeFormat.format(date);
}
function relativeTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  const minutes = Math.round((Date.now() - date.valueOf()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} d ago`;
}
function nextScheduledRun(schedule, now = new Date()) {
  if (!schedule || !Array.isArray(schedule.days) || !/^\d{2}:\d{2}$/.test(schedule.time ?? '')) return null;
  const [hours, minutes] = schedule.time.split(':').map(Number);
  const today = zoneParts(now);
  for (let offset = 0; offset <= 7; offset++) {
    const civil = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    if (!schedule.days.includes(civil.getUTCDay())) continue;
    const at = zonedTime(civil.getUTCFullYear(), civil.getUTCMonth() + 1, civil.getUTCDate(), hours, minutes);
    if (at > now) return at;
  }
  return null;
}

const node = (tag, className, text) => {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
};
const clear = (item) => { while (item.firstChild) item.removeChild(item.firstChild); };
function appIcon(app, large = false) {
  const holder = node('span', `app-icon app-icon-${app}${large ? ' app-icon-large' : ''}`);
  holder.setAttribute('aria-hidden', 'true');
  if (typeof document.createElementNS === 'function') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('focusable', 'false');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#brand-${app}`);
    svg.append(use);
    holder.append(svg);
  }
  return holder;
}

// Each automation keeps one pastel, so its card and its detail page match.
const TONES = { 'linkedin-draft': 'blue', 'notion-projects': 'yellow', 'project-details': 'pink', 'portfolio-sync': 'green', 'weekly-report': 'lilac' };
const TONE_CYCLE = ['yellow', 'pink', 'green', 'blue', 'lilac'];
function toneOf(automation, index = 0) { return TONES[automation.id] ?? TONE_CYCLE[index % TONE_CYCLE.length]; }
const hourFormat = formatter({ hour: 'numeric', hourCycle: 'h23' });
function greeting(now = new Date()) {
  const hour = Number(hourFormat.format(now));
  return hour < 5 ? 'Working late' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}
const tileCache = new Map();
const seenEvents = new WeakMap();

let automations = [];
let snapshot = { paused: false, activeRun: null, queuedRuns: [], recentRuns: [], events: [] };
let currentView = 'overview';
let selectedId = 'linkedin-draft';
let pollTimer = null;
let refreshing = false;
let actionInFlight = '';
let draft = { runId: '', text: '', state: 'empty' };
let draftRequest = '';
let reviewInFlight = '';
let linkedin = null;
let editingLinkedInApp = false;
let health = null;
let connections = null;
let changes = [];

function announce(message) { $('#live-notice').textContent = message; }
function showError(target, message) { target.textContent = message; target.hidden = false; }
function clearError(target) {
  target.textContent = '';
  target.hidden = true;
  target.classList.replace('banner-success', 'banner-error');
  target.setAttribute('role', 'alert');
}
function errorFrom(response, body) {
  const error = new Error(body?.error?.message || `Request failed (${response.status}).`);
  error.status = response.status;
  error.code = body?.error?.code;
  return error;
}
async function jsonResponse(response) {
  let body = null;
  try { body = await response.json(); } catch { /* Use the bounded fallback message. */ }
  if (!response.ok) throw errorFrom(response, body);
  return body;
}

const nameOf = (jobId) => automations.find((item) => item.id === jobId)?.name ?? jobId;
const selected = () => automations.find((item) => item.id === selectedId) ?? null;
function allRuns(source = snapshot) {
  return [...(source.activeRun ? [source.activeRun] : []), ...source.queuedRuns, ...source.recentRuns];
}
// The queue's active run object keeps its enqueue-time fields; the stored row has the live state and summary.
function activeRun() {
  const active = snapshot.activeRun;
  if (!active) return null;
  return { ...active, ...snapshot.recentRuns.find((run) => run.runId === active.runId), state: 'running' };
}
function latestRun(jobId) {
  if (snapshot.activeRun?.jobId === jobId) return activeRun();
  return snapshot.queuedRuns.find((run) => run.jobId === jobId) ?? snapshot.recentRuns.find((run) => run.jobId === jobId) ?? null;
}
function stateOf(automation) {
  if (automation.status !== 'active') return 'planned';
  if (snapshot.activeRun?.jobId === automation.id) return 'running';
  if (snapshot.queuedRuns.some((run) => run.jobId === automation.id)) return 'queued';
  if (snapshot.paused) return 'paused';
  if (automation.enabled === false) return 'off';
  const last = snapshot.recentRuns.find((run) => run.jobId === automation.id);
  return last && ['failed', 'interrupted'].includes(last.state) ? last.state : 'idle';
}

function setView(view, { focus = true } = {}) {
  if (!VIEWS.includes(view)) return;
  currentView = view;
  document.body.dataset.view = view;
  document.querySelectorAll('[data-page]').forEach((page) => { page.hidden = page.dataset.page !== view; });
  document.querySelectorAll('.nav-button').forEach((button) => {
    const isSelected = button.dataset.view === view || (view === 'automation' && button.dataset.view === 'overview');
    button.classList.toggle('is-selected', isSelected);
    button.setAttribute('aria-pressed', String(isSelected));
  });
  if (!focus) return;
  if (view === 'automation') $('#detail-title').focus({ preventScroll: true });
  if (view === 'activity') $('#activity-title').focus({ preventScroll: true });
  if (view === 'changes') { $('#changes-title').focus({ preventScroll: true }); void loadChanges(); }
  if (view === 'accounts') $('#accounts-title').focus({ preventScroll: true });
}
function openAutomation(id) {
  if (!automations.some((item) => item.id === id)) return;
  selectedId = id;
  renderDetail();
  setView('automation');
}

function announceRunTransitions(previous, next) {
  const previousStates = new Map(allRuns(previous).map((run) => [run.runId, run.state]));
  const changed = allRuns(next).filter((run) => previousStates.has(run.runId)
    && previousStates.get(run.runId) !== run.state
    && ['running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.state));
  if (!changed.length) return;
  const latest = changed.at(-1);
  const labels = { running: 'is running', succeeded: 'completed', failed: 'failed', cancelled: 'stopped', interrupted: 'was interrupted' };
  announce(`${nameOf(latest.jobId)} ${labels[latest.state]}.`);
}

function renderToolbar() {
  const active = snapshot.activeRun;
  const queued = snapshot.queuedRuns[0];
  const busy = active ?? queued;
  $('#global-indicator').hidden = !busy;
  $('#global-indicator-job').textContent = busy ? `${nameOf(busy.jobId)} · ` : '';
  $('#global-indicator-label').textContent = busy ? (active ? 'Running' : 'Queued') : '';
  const pause = $('#pause-button');
  pause.disabled = Boolean(actionInFlight);
  pause.textContent = snapshot.paused ? 'Resume all' : 'Pause all';
  pause.setAttribute('aria-pressed', String(snapshot.paused));
}

function renderOverview() {
  $('#overview-date').textContent = longDateFormat.format(new Date());
  $('#overview-title').textContent = greeting();
  const live = automations.filter((item) => item.status === 'active');
  const running = live.filter((item) => ['running', 'queued'].includes(stateOf(item))).length;
  const failing = live.filter((item) => ['failed', 'interrupted'].includes(stateOf(item))).length;
  const parts = [`${live.filter((item) => item.enabled !== false).length} on a schedule`];
  if (running) parts.push(`${running} working now`);
  if (failing) parts.push(`${failing} need${failing === 1 ? 's' : ''} attention`);
  const planned = automations.length - live.length;
  if (planned) parts.push(`${planned} not set up yet`);
  $('#overview-summary').textContent = snapshot.paused ? 'Paused. Nothing new will start until you resume.' : `${parts.join(' · ')}.`;
  renderHealth();

  const grid = $('#automation-grid');
  // Cards are kept between polls so their entrance and shape animations don't restart every refresh.
  const wanted = new Set(automations.map((item) => item.id));
  for (const [id, entry] of tileCache) {
    if (!wanted.has(id)) { grid.removeChild(entry.item); tileCache.delete(id); }
  }
  automations.forEach((automation, index) => {
    let entry = tileCache.get(automation.id);
    if (!entry) {
      const item = node('li', 'tile-item');
      const tile = node('button', 'tile');
      tile.type = 'button';
      tile.dataset.automation = automation.id;
      item.append(tile);
      grid.append(item);
      entry = { item, tile };
      tileCache.set(automation.id, entry);
    }
    const { item, tile } = entry;
    item.style?.setProperty?.('--i', String(index));
    const state = stateOf(automation);
    tile.dataset.state = state;
    tile.dataset.tone = toneOf(automation, index);
    const head = node('div', 'tile-head');
    const pill = node('span', 'status-pill', STATE_LABELS[state]);
    pill.dataset.state = state;
    head.append(appIcon(automation.app), pill);
    const name = node('span', 'tile-name', automation.name);
    const last = latestRun(automation.id);
    let detail;
    if (automation.status !== 'active') detail = 'Planned. Not running yet.';
    else if (last) detail = `${STATE_LABELS[last.state] ?? 'Updated'} ${relativeTime(last.updatedAt || last.createdAt)}: ${last.summary || ''}`;
    else detail = 'Hasn’t run yet.';
    const meta = node('span', 'tile-meta', detail);
    const next = nextScheduledRun(automation.schedule);
    const setup = automation.setupNeeded ?? [];
    const foot = node('span', 'tile-foot', automation.status !== 'active' ? 'Coming in a later step'
      : setup.length ? `Needs setup: add ${setup.join(', ')} to config/profile.json`
      : automation.enabled === false ? 'Turned off. It won’t run on its schedule.'
        : next ? `Next run ${displayTime(next)}` : 'No schedule');
    if (automation.id === 'linkedin-draft' && linkedin && !linkedin.connected) {
      foot.append(node('span', 'tile-warning', ' · Posting is off until you connect LinkedIn'));
    }
    clear(tile);
    tile.append(head, name, meta, foot);
    tile.setAttribute('aria-label', `${automation.name}, ${STATE_LABELS[state]}. ${detail}`);
  });
}

function fact(list, label, value) {
  const group = node('div', 'fact');
  group.append(node('dt', 'fact-label', label), node('dd', 'fact-value', value));
  list.append(group);
}

function renderDetail() {
  const automation = selected();
  if (!automation) return;
  const isActive = automation.status === 'active';
  const state = stateOf(automation);
  $('#detail-title').textContent = automation.name;
  $('#detail-head').dataset.tone = toneOf(automation, automations.indexOf(automation));
  $('#detail-description').textContent = automation.description;
  const pill = $('#detail-state');
  pill.textContent = STATE_LABELS[state];
  pill.dataset.state = state;
  const icon = $('#detail-icon');
  clear(icon);
  icon.className = `app-icon app-icon-large app-icon-${automation.app}`;
  icon.append(...appIcon(automation.app).children);

  const facts = $('#detail-facts');
  clear(facts);
  const last = latestRun(automation.id);
  const next = nextScheduledRun(automation.schedule);
  fact(facts, 'Schedule', automation.schedule?.label ?? (isActive ? 'Manual only' : 'Not set up'));
  fact(facts, 'Next run', isActive && next && automation.enabled !== false && !(automation.setupNeeded ?? []).length ? displayTime(next) : '—');
  if ((automation.setupNeeded ?? []).length) fact(facts, 'Needs setup', `Add ${automation.setupNeeded.join(', ')} to config/profile.json, then restart the hub.`);
  fact(facts, 'Last run', last ? `${displayTime(last.updatedAt || last.createdAt)} · ${STATE_LABELS[last.state] ?? last.state}` : '—');
  fact(facts, automation.usesModel ? 'Model' : 'Runs on', automation.usesModel ? 'Qwen 3.5 9B on Ollama' : isActive ? 'This PC, no model needed' : '—');

  $('#detail-active').hidden = !isActive;
  $('#detail-planned').hidden = isActive;
  if (!isActive) return;

  const active = snapshot.activeRun?.jobId === automation.id ? activeRun() : null;
  const today = allRuns().some((run) => run.jobId === automation.id && run.date === dateInZone());
  const runButton = $('#run-button');
  const needsSetup = (automation.setupNeeded ?? []).length > 0;
  const waiting = snapshot.queuedRuns.some((run) => run.jobId === automation.id);
  runButton.disabled = Boolean(actionInFlight) || Boolean(active) || waiting || needsSetup;
  runButton.textContent = active ? 'Running…' : waiting ? 'Waiting…' : needsSetup ? 'Needs setup' : actionInFlight === 'launch' ? 'Starting…' : today ? 'Run again' : 'Run now';
  $('#stop-button').disabled = !active || Boolean(actionInFlight);
  const queued = snapshot.queuedRuns.find((run) => run.jobId === automation.id);
  const retry = (snapshot.retries ?? []).find((item) => item.jobId === automation.id);
  $('#run-summary').textContent = active?.summary || queued?.summary
    || (retry ? `The last try failed for a reason that can pass. Trying again ${displayTime(retry.dueAt)}.` : '')
    || (snapshot.paused ? 'Everything is paused.' : 'Nothing is running right now.');
  const toggle = $('#enabled-switch');
  toggle.setAttribute('aria-checked', String(automation.enabled !== false));
  toggle.disabled = Boolean(actionInFlight) || !automation.schedule;
  toggle.hidden = !automation.schedule;
  renderRuns(automation.id);
  const isLinkedIn = automation.id === 'linkedin-draft';
  $('#latest-output').hidden = !isLinkedIn;
  if (isLinkedIn) renderDraft($('#draft-preview-workspace'));
  renderLinkedIn(isLinkedIn);
}

function renderLinkedIn(visible) {
  const panel = $('#linkedin-account');
  panel.hidden = !visible || !linkedin;
  if (panel.hidden) return;
  const showForm = !linkedin.configured || editingLinkedInApp;
  $('#linkedin-app-form').hidden = !showForm;
  $('#linkedin-connect').hidden = showForm || linkedin.connected;
  $('#linkedin-connected').hidden = showForm || !linkedin.connected;
  $('#linkedin-redirect').textContent = linkedin.redirectUri;
  if (linkedin.connected) {
    const how = linkedin.autoPublish ? 'Posting automatically' : 'Posting after your approval';
    $('#linkedin-connected-text').textContent = linkedin.name ? `${how} as ${linkedin.name}.` : `${how}.`;
    const expiry = $('#linkedin-expiry');
    const until = formatter({ day: 'numeric', month: 'long' }).format(new Date(linkedin.expiresAt));
    expiry.textContent = linkedin.expiresSoon
      ? `LinkedIn sign-in ends on ${until}. Sign in again before then to keep posting.`
      : `${linkedin.autoPublish ? 'Each new draft is posted' : 'Each draft you approve in Drafts is posted'} with its repo link as the first comment. Sign-in lasts until ${until}.`;
    expiry.classList.toggle('is-warning', linkedin.expiresSoon);
  }
}

async function loadLinkedIn() {
  try { linkedin = await jsonResponse(await api('/api/linkedin')); } catch { /* Keep the last known state. */ }
}

async function linkedInAction(endpoint, body) {
  if (actionInFlight) return false;
  actionInFlight = 'linkedin';
  clearError($('#action-alert'));
  try {
    const options = { method: 'POST' };
    if (body) { options.headers = { 'Content-Type': 'application/json' }; options.body = JSON.stringify(body); }
    linkedin = await jsonResponse(await api(endpoint, options));
    editingLinkedInApp = false;
    announce(body ? 'LinkedIn app keys saved.' : 'LinkedIn disconnected. Drafts will be saved without posting.');
    return true;
  } catch (error) {
    showError($('#action-alert'), error.message || 'That didn’t work. Try again.');
    return false;
  } finally { actionInFlight = ''; render(); }
}

// The sign-in callback returns here with ?linkedin=connected or an error message.
function showLinkedInResult() {
  const params = new URLSearchParams(location.search);
  const result = params.get('linkedin');
  if (result === null) return;
  history.replaceState(null, '', location.pathname);
  const banner = $('#action-alert');
  if (result === 'connected') {
    banner.classList.replace('banner-error', 'banner-success');
    banner.setAttribute('role', 'status');
    showError(banner, 'LinkedIn is connected. Approve a draft in Drafts to post it.');
  } else showError(banner, result.slice(0, 300));
  openAutomation('linkedin-draft');
}

function renderRuns(jobId) {
  const list = $('#run-list');
  clear(list);
  const runs = snapshot.recentRuns.filter((run) => run.jobId === jobId).slice(0, 10);
  $('#run-count').textContent = String(runs.length);
  if (!runs.length) {
    list.append(node('li', 'list-empty', 'The first run will show up here.'));
    return;
  }
  for (const run of runs) {
    const item = node('li', 'list-row');
    const dot = node('span', 'state-dot');
    dot.dataset.state = run.state;
    dot.setAttribute('aria-hidden', 'true');
    const body = node('div', 'list-copy');
    const top = node('div', 'list-top');
    top.append(node('strong', '', STATE_LABELS[run.state] ?? run.state), node('time', 'list-time', displayTime(run.updatedAt || run.createdAt)));
    body.append(top, node('p', 'list-summary', run.summary || 'No details.'));
    item.append(dot, body);
    list.append(item);
  }
}

function renderEvents(target, events, limit) {
  clear(target);
  const items = events.slice(-limit).reverse();
  // Rows that arrived since the last refresh slide in; the first fill does not animate.
  const seen = seenEvents.get(target);
  seenEvents.set(target, new Set(items.map((event) => event.id)));
  if (!items.length) {
    target.append(node('li', 'list-empty', 'Nothing has happened yet.'));
    return;
  }
  for (const event of items) {
    const item = node('li', seen && !seen.has(event.id) ? 'list-row is-new' : 'list-row');
    const dot = node('span', 'state-dot');
    dot.dataset.state = event.state;
    dot.setAttribute('aria-hidden', 'true');
    const body = node('div', 'list-copy');
    const top = node('div', 'list-top');
    top.append(node('strong', '', `${nameOf(event.jobId)} · ${STATE_LABELS[event.state] ?? event.state}`), node('time', 'list-time', displayTime(event.createdAt)));
    body.append(top, node('p', 'list-summary', event.summary || 'No details.'));
    item.append(dot, body);
    target.append(item);
  }
}

function renderDraft(target) {
  // Rebuilding on every poll would restart the video, so only redraw when the draft changes.
  const key = `${draft.runId}:${draft.state}:${draft.media?.video ? 'v' : ''}${draft.media?.image ? 'i' : ''}:${draft.review?.state ?? ''}:${reviewInFlight}`;
  if (target.dataset.rendered === key) return;
  target.dataset.rendered = key;
  clear(target);
  if (draft.state === 'ready') {
    const base = `/api/drafts/${encodeURIComponent(draft.runId)}`;
    if (draft.review) target.append(reviewBar(draft.review));
    if (draft.media?.video || draft.media?.image) {
      const frame = node('div', 'draft-media');
      if (draft.media.video) {
        const video = node('video', 'draft-video');
        Object.assign(video, { controls: true, muted: true, loop: true, playsInline: true, preload: 'metadata' });
        if (draft.media.image) video.poster = `${base}/image`;
        video.src = `${base}/video`;
        video.setAttribute('aria-label', 'Post video');
        frame.append(video);
      }
      if (draft.media.image) {
        const image = node('img', 'draft-image');
        image.src = `${base}/image`;
        image.alt = 'Post image';
        frame.append(image);
      }
      target.append(frame);
    }
    const preview = node('pre', 'draft-text');
    preview.setAttribute('aria-label', 'Draft text');
    preview.textContent = draft.text;
    target.append(preview);
    return;
  }
  const messages = {
    empty: 'The latest draft will show up here after a run writes one.',
    loading: 'Loading the latest draft…',
    unavailable: 'The latest run didn’t save a draft file.',
    error: 'The draft couldn’t be loaded. It will be tried again shortly.',
  };
  target.append(node('p', 'list-empty', messages[draft.state]));
}

const GB = 1024 ** 3;
function renderHealth() {
  const strip = $('#health-strip');
  clear(strip);
  if (!health) return;
  const item = (text, level = 'ok') => { const entry = node('li', 'health-item', text); entry.dataset.level = level; strip.append(entry); };
  item(health.ollama ? 'Ollama is running' : 'Ollama is off. The hub starts it before a run.', health.ollama ? 'ok' : 'warn');
  if (typeof health.diskFreeBytes === 'number') {
    const free = health.diskFreeBytes / GB;
    item(`${free >= 10 ? Math.round(free) : free.toFixed(1)} GB free`, free < 5 ? 'bad' : free < 20 ? 'warn' : 'ok');
  }
  const backedUp = health.lastBackupAt ? Date.now() - new Date(health.lastBackupAt).valueOf() : null;
  item(backedUp === null ? 'Not backed up yet' : `Backed up ${relativeTime(health.lastBackupAt)}`, backedUp === null || backedUp > 3 * 86_400_000 ? 'warn' : 'ok');
}

function renderAccounts() {
  const status = $('#account-linkedin-status');
  status.textContent = !linkedin ? 'Checking…'
    : linkedin.connected ? `Connected${linkedin.name ? ` as ${linkedin.name}` : ''}.${linkedin.expiresSoon ? ' Sign-in ends soon.' : ''}`
      : 'Not connected. Drafts are saved but not posted.';
  status.classList.toggle('is-problem', Boolean(linkedin && (!linkedin.connected || linkedin.expiresSoon)));
  for (const body of document.querySelectorAll('[data-provider]:not(button)')) {
    const entry = connections?.[body.dataset.provider];
    const line = body.querySelector('[data-role="status"]');
    if (!entry) { line.textContent = 'Checking…'; continue; }
    line.textContent = entry.connected
      ? (entry.problem ? `Needs attention: ${entry.problem}` : `Connected${entry.name ? ` to ${entry.name}` : ''}.`)
      : 'Not connected.';
    line.classList.toggle('is-problem', Boolean(entry.problem));
    body.querySelector('[data-role="form"]').hidden = entry.connected;
    body.querySelector('[data-role="note"]').hidden = entry.connected && !entry.problem;
    body.querySelector('[data-role="connected"]').hidden = !entry.connected;
    body.querySelectorAll('button').forEach((button) => { button.disabled = Boolean(actionInFlight); });
  }
}

const shortValue = (value) => {
  if (value === null || value === undefined || value === '') return 'empty';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
};
const CHANGE_LABELS = { pending: 'Writing', applied: 'Changed', failed: 'Didn’t work', undone: 'Put back' };
function renderChanges() {
  const list = $('#change-list');
  clear(list);
  if (!changes.length) {
    list.append(node('li', 'list-empty', 'Nothing has been changed outside this PC yet.'));
    return;
  }
  for (const change of changes) {
    const item = node('li', 'list-row change-row');
    const dot = node('span', 'state-dot');
    dot.dataset.state = change.state;
    dot.setAttribute('aria-hidden', 'true');
    const body = node('div', 'list-copy');
    const top = node('div', 'list-top');
    top.append(node('strong', '', `${change.label} · ${CHANGE_LABELS[change.state] ?? change.state}`), node('time', 'list-time', displayTime(change.createdAt)));
    const values = node('p', 'change-values');
    const before = node('del', '', shortValue(change.before));
    values.append(before, document.createTextNode(' → '), node('span', '', shortValue(change.after)));
    body.append(top, node('p', 'list-summary', `${nameOf(change.jobId)}${change.error ? ` · ${change.error}` : ''}`), values);
    item.append(dot, body);
    if (change.undoable) {
      const undo = node('button', 'button button-secondary', 'Undo');
      undo.type = 'button';
      undo.dataset.action = 'undo-change';
      undo.dataset.change = String(change.id);
      undo.disabled = Boolean(actionInFlight);
      undo.setAttribute('aria-label', `Undo ${change.label}`);
      item.append(undo);
    }
    list.append(item);
  }
}

async function loadChanges() {
  try { changes = (await jsonResponse(await api('/api/changes'))).changes ?? []; renderChanges(); } catch { /* Keep the last list. */ }
}
async function loadHubState() {
  const [nextHealth, nextConnections] = await Promise.all([
    api('/api/health').then(jsonResponse).catch(() => null),
    api('/api/connections').then(jsonResponse).catch(() => null),
  ]);
  if (nextHealth) health = nextHealth;
  if (nextConnections) connections = nextConnections;
}

async function postJson(endpoint, body) {
  const options = { method: 'POST' };
  if (body !== undefined) { options.headers = { 'Content-Type': 'application/json' }; options.body = JSON.stringify(body); }
  return jsonResponse(await api(endpoint, options));
}

// Runs one dashboard action at a time and shows its error in the action banner.
async function hubAction(name, work, success) {
  if (actionInFlight) return false;
  actionInFlight = name;
  clearError($('#action-alert'));
  render();
  try {
    await work();
    if (success) announce(success);
    return true;
  } catch (error) {
    showError($('#action-alert'), error.message || 'That didn’t work. Try again.');
    return false;
  } finally { actionInFlight = ''; render(); }
}

function render() {
  renderToolbar();
  renderOverview();
  renderDetail();
  renderEvents($('#context-events'), snapshot.events, 14);
  renderEvents($('#all-events'), snapshot.events, 250);
  $('#event-count').textContent = String(snapshot.events.length);
  renderDraft($('#draft-preview-full'));
  renderAccounts();
  if (currentView === 'changes') renderChanges();
}

// The approval gate: a draft waiting for review shows Approve and Discard; nothing posts without a click.
const REVIEW_TEXT = {
  awaiting: 'Waiting for your approval. Nothing has been posted.',
  posted: 'Approved and posted to LinkedIn.',
  discarded: 'Discarded. This draft won’t be posted.',
};
function reviewBar(review) {
  const bar = node('div', 'draft-review');
  bar.dataset.state = review.state;
  bar.append(node('p', 'draft-review-text', REVIEW_TEXT[review.state] ?? ''));
  if (review.state !== 'awaiting') return bar;
  const approve = node('button', 'button button-primary', reviewInFlight === 'approve' ? 'Posting…' : 'Approve and post');
  const discard = node('button', 'button button-destructive', 'Discard');
  for (const [button, action] of [[approve, 'approve'], [discard, 'discard']]) {
    button.type = 'button';
    button.disabled = Boolean(reviewInFlight);
    button.addEventListener('click', () => { void decideDraft(action); });
  }
  bar.append(approve, discard);
  return bar;
}
async function decideDraft(action) {
  if (reviewInFlight || !draft.runId) return;
  if (action === 'approve' && !window.confirm('Post this draft to LinkedIn now?')) return;
  const runId = draft.runId;
  reviewInFlight = action;
  const show = () => { renderDraft($('#draft-preview-workspace')); renderDraft($('#draft-preview-full')); };
  show();
  try {
    const result = await jsonResponse(await api(`/api/drafts/${encodeURIComponent(runId)}/${action}`, { method: 'POST' }));
    if (draft.runId === runId && result?.state) draft.review = { ...draft.review, state: result.state };
    announce(result?.summary || 'Done.');
  } catch (error) {
    announce(error.message || 'That didn’t work. Try again.');
  } finally { reviewInFlight = ''; show(); }
}

async function loadDraft() {
  const completed = snapshot.recentRuns.find((run) => run.jobId === 'linkedin-draft' && run.state === 'succeeded');
  const show = () => { renderDraft($('#draft-preview-workspace')); renderDraft($('#draft-preview-full')); };
  if (!completed) { draft = { runId: '', text: '', state: 'empty' }; show(); return; }
  if (draft.runId === completed.runId && draft.state !== 'error') return;
  if (draftRequest === completed.runId) return;
  draftRequest = completed.runId;
  draft = { runId: completed.runId, text: '', state: 'loading' };
  show();
  try {
    const response = await api(`/api/drafts/${encodeURIComponent(completed.runId)}`);
    if (response.status === 404) { draft = { runId: completed.runId, text: '', state: 'unavailable' }; return; }
    if (!response.ok) throw errorFrom(response, null);
    const text = await response.text();
    const exists = async (kind) => {
      try { return (await api(`/api/drafts/${encodeURIComponent(completed.runId)}/${kind}`, { method: 'HEAD' })).ok; } catch { return false; }
    };
    const review = async () => {
      try { const reply = await api(`/api/drafts/${encodeURIComponent(completed.runId)}/review`); return reply.ok ? await reply.json() : null; } catch { return null; }
    };
    const [video, image, reviewed] = await Promise.all([exists('video'), exists('image'), review()]);
    draft = { runId: completed.runId, text, state: 'ready', media: { video, image }, review: reviewed };
  } catch { draft = { runId: completed.runId, text: '', state: 'error' }; }
  finally { draftRequest = ''; show(); }
}

async function refresh() {
  if (refreshing || document.visibilityState === 'hidden') return;
  refreshing = true;
  try {
    const listed = await jsonResponse(await api('/api/automations'));
    automations = listed.automations ?? automations;
    if (typeof listed.timeZone === 'string' && listed.timeZone) timeZone = listed.timeZone;
    const nextSnapshot = await jsonResponse(await api('/api/snapshot'));
    announceRunTransitions(snapshot, nextSnapshot);
    snapshot = nextSnapshot;
    await Promise.all([loadLinkedIn(), loadHubState()]);
    if (currentView === 'changes') await loadChanges();
    clearError($('#connection-alert'));
    render();
    void loadDraft();
  } catch {
    showError($('#connection-alert'), 'Can’t reach the hub on this PC. Showing the last update; check that it’s still running.');
  } finally { refreshing = false; }
}

function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = null;
  if (document.visibilityState === 'hidden') return;
  pollTimer = setTimeout(async () => { await refresh(); schedulePoll(); }, 2_000);
}

async function runAction(name, endpoint) {
  if (actionInFlight) return;
  actionInFlight = name;
  clearError($('#action-alert'));
  render();
  try {
    await jsonResponse(await api(endpoint, { method: 'POST' }));
    announce(name === 'launch' ? 'Run queued.' : name === 'pause' ? (snapshot.paused ? 'Resumed.' : 'Paused.') : 'Stop requested.');
    await refresh();
  } catch (error) {
    if (error.code === 'DUPLICATE_RUN') { announce('This automation is already running.'); await refresh(); }
    else if (error.status === 409 && name === 'stop') { announce('That run has already finished.'); await refresh(); }
    else showError($('#action-alert'), error.message || 'That didn’t work. Try again.');
  } finally { actionInFlight = ''; render(); }
}

document.addEventListener('click', (event) => {
  const target = event.target;
  const tile = target.closest('[data-automation]');
  if (tile) { openAutomation(tile.dataset.automation); return; }
  const viewButton = target.closest('button[data-view]');
  if (viewButton) { setView(viewButton.dataset.view); return; }
  const action = target.closest('[data-action]')?.dataset.action;
  if (action === 'launch' && selected()?.status === 'active') void runAction('launch', `/api/jobs/${encodeURIComponent(selectedId)}`);
  if (action === 'toggle-enabled') {
    const automation = selected();
    if (automation) {
      const enabled = automation.enabled === false;
      void hubAction('toggle', async () => {
        await postJson(`/api/automations/${encodeURIComponent(automation.id)}/enabled`, { enabled });
        automation.enabled = enabled;
      }, enabled ? `${automation.name} will run on its schedule.` : `${automation.name} is turned off.`);
    }
  }
  if (action === 'open-linkedin') openAutomation('linkedin-draft');
  if (action === 'disconnect') {
    const provider = target.closest('[data-action]').dataset.provider;
    void hubAction('disconnect', async () => { connections = await postJson(`/api/connections/${provider}/disconnect`); }, 'Disconnected.');
  }
  if (action === 'undo-change') {
    const id = target.closest('[data-action]').dataset.change;
    void hubAction('undo', async () => { await postJson(`/api/changes/${encodeURIComponent(id)}/undo`); await loadChanges(); }, 'Change put back.');
  }
  if (action === 'linkedin-disconnect') void linkedInAction('/api/linkedin/disconnect');
  if (action === 'linkedin-edit-app') { editingLinkedInApp = true; render(); $('#linkedin-app-form input[name="clientId"]').focus(); }
  if (action === 'pause') void runAction('pause', snapshot.paused ? '/api/resume' : '/api/pause');
  if (action === 'open-stop' && snapshot.activeRun) $('#stop-dialog').showModal();
  if (action === 'show-active') {
    event.preventDefault();
    const busy = snapshot.activeRun ?? snapshot.queuedRuns[0];
    if (busy) openAutomation(busy.jobId);
  }
});

$('#linkedin-app-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  void linkedInAction('/api/linkedin/app', { clientId: String(form.get('clientId') ?? '').trim(), clientSecret: String(form.get('clientSecret') ?? '').trim() })
    .then((saved) => { if (saved) event.target.reset(); });
});

document.querySelectorAll('form[data-role="form"]').forEach((form) => {
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const provider = form.closest('[data-provider]').dataset.provider;
    const token = String(new FormData(form).get('token') ?? '').trim();
    void hubAction('connect', async () => { connections = await postJson(`/api/connections/${provider}`, { token }); }, 'Key saved and checked.')
      .then((saved) => { if (saved) form.reset(); });
  });
});

$('#stop-dialog').addEventListener('close', () => {
  if ($('#stop-dialog').returnValue === 'stop' && snapshot.activeRun) {
    void runAction('stop', `/api/runs/${encodeURIComponent(snapshot.activeRun.runId)}/stop`);
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { clearTimeout(pollTimer); pollTimer = null; }
  else { void refresh(); schedulePoll(); }
});

setView(currentView, { focus: false });
void refresh().finally(() => { showLinkedInResult(); schedulePoll(); });
