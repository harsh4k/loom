// Loom desktop app: its own window and tray icon around the local automation hub.
// The hub keeps running as its own background service ("Automation Hub" logon task),
// so automations run whether or not this window is open.
import { app, BrowserWindow, Menu, Notification, Tray, screen, session, shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HUB_ORIGIN, HUB_URL, MODEL, MODEL_KEEP_ALIVE, OLLAMA_URL, isHubUrl, newFailures, opensInBrowser, ollamaAppPath, readHubRoot, windowBounds } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ICON = path.join(here, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const OFFLINE_PAGE = path.join(here, 'offline.html');
const OFFLINE_URL = pathToFileURL(OFFLINE_PAGE).href;
const HIDDEN_ARG = '--hidden';
const POLL_MS = 60_000;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

let win = null;
let tray = null;
let quitting = false;
let connecting = null;
const seenRuns = new Set();
const startedAt = Date.now();
let jobNames = {};

function boundsFile() { return path.join(app.getPath('userData'), 'window.json'); }

function savedBounds() {
  let saved = null;
  try { saved = JSON.parse(readFileSync(boundsFile(), 'utf8')); } catch { /* first run */ }
  const bounds = windowBounds(saved);
  // Drop a saved position that is no longer on any screen (for example an unplugged monitor).
  if ('x' in bounds) {
    const area = screen.getDisplayMatching({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }).workArea;
    const visible = bounds.x < area.x + area.width - 100 && bounds.x + bounds.width > area.x + 100 && bounds.y >= area.y - 10 && bounds.y < area.y + area.height - 100;
    if (!visible) { delete bounds.x; delete bounds.y; }
  }
  return bounds;
}

function saveBounds() {
  if (!win || win.isMinimized() || win.isMaximized()) return;
  try { writeFileSync(boundsFile(), JSON.stringify(win.getBounds())); } catch { /* not important */ }
}

async function hubIsUp() {
  try {
    const response = await fetch(`${HUB_ORIGIN}/api/snapshot`, { signal: AbortSignal.timeout(2500) });
    return response.ok;
  } catch {
    return false;
  }
}

function startHub() {
  // Prefer the logon task, so there is only ever one hub. Fall back to starting it directly.
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Start-ScheduledTask -TaskName 'Automation Hub'"], { windowsHide: true }, (error) => {
    if (!error) return;
    const root = readHubRoot(here);
    try {
      // A hidden console of its own, so programs the hub starts never open terminal windows.
      spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Start-Process -FilePath node -ArgumentList ('\"' + $env:LOOM_HUB_SERVER + '\"') -WorkingDirectory $env:LOOM_HUB_ROOT -WindowStyle Hidden"], {
        stdio: 'ignore', windowsHide: true, env: { ...process.env, LOOM_HUB_ROOT: root, LOOM_HUB_SERVER: path.join(root, 'src', 'server.mjs') },
      }).on('error', () => {}).unref();
    } catch { /* the offline page keeps retrying */ }
  });
}

// Opening Loom starts Ollama's server hidden (no Ollama window) and loads the model,
// so drafts and project details are ready to run.
async function ollamaUp() {
  try {
    return (await fetch(`${OLLAMA_URL}/api/version`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch { return false; }
}

let warming = null;
function startOllama() {
  if (warming) return warming;
  warming = (async () => {
    if (!(await ollamaUp())) {
      const ollama = ollamaAppPath();
      if (!ollama || !existsSync(ollama)) return;
      try {
        // Start-Process -WindowStyle Hidden gives Ollama a hidden console of its own; started
        // directly, each model runner it starts would open a terminal window.
        spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Start-Process -FilePath $env:LOOM_OLLAMA_EXE -ArgumentList 'serve' -WindowStyle Hidden"], {
          stdio: 'ignore', windowsHide: true, env: { ...process.env, LOOM_OLLAMA_EXE: ollama },
        }).on('error', () => {}).unref();
      } catch { return; }
      const deadline = Date.now() + 30_000;
      while (!(await ollamaUp())) {
        if (Date.now() > deadline) return;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    // An empty request loads the model into memory and keeps it there for a while.
    await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, keep_alive: MODEL_KEEP_ALIVE }),
      signal: AbortSignal.timeout(180_000),
    }).catch(() => {});
  })().finally(() => { warming = null; });
  return warming;
}

function showOffline(state) {
  win?.loadFile(OFFLINE_PAGE, { query: { state } }).catch(() => {});
}

// Show the dashboard once the hub answers; start the hub if it isn't running.
function connect() {
  if (connecting) return connecting;
  connecting = (async () => {
    let started = false;
    for (let attempt = 0; ; attempt += 1) {
      if (await hubIsUp()) {
        await win?.loadURL(HUB_URL).catch(() => {});
        return;
      }
      if (!started && process.platform === 'win32') { startHub(); started = true; }
      showOffline(attempt < 8 ? 'starting' : 'down');
      await new Promise((resolve) => setTimeout(resolve, attempt < 8 ? 2500 : 10_000));
    }
  })().finally(() => { connecting = null; });
  return connecting;
}

function createWindow() {
  win = new BrowserWindow({
    ...savedBounds(),
    minWidth: 900,
    minHeight: 600,
    title: 'Loom',
    icon: ICON,
    backgroundColor: '#f7f0e3', // the dashboard's cream, so opening never flashes
    show: false,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  win.once('ready-to-show', () => { if (!process.argv.includes(HIDDEN_ARG)) win.show(); });
  win.on('page-title-updated', (event) => event.preventDefault());
  win.on('resized', saveBounds);
  win.on('moved', saveBounds);
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
  win.webContents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && isHubUrl(url)) connect();
  });
  win.webContents.on('render-process-gone', () => connect());
  showOffline('starting');
  connect();
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  void startOllama();
  if (!isHubUrl(win.webContents.getURL())) connect();
}

function opensAtLogin() {
  return app.getLoginItemSettings({ args: [HIDDEN_ARG] }).openAtLogin;
}

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Open Loom', click: showWindow },
    { label: 'Reload', click: () => { showWindow(); win?.webContents.reloadIgnoringCache(); } },
    { type: 'separator' },
    {
      label: 'Open when I sign in',
      type: 'checkbox',
      checked: opensAtLogin(),
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, args: [HIDDEN_ARG] });
        tray.setContextMenu(trayMenu());
      },
    },
    { type: 'separator' },
    { label: 'Quit (automations keep running)', click: () => { quitting = true; app.quit(); } },
  ]);
}

function createTray() {
  tray = new Tray(ICON);
  tray.setToolTip('Loom');
  tray.setContextMenu(trayMenu());
  tray.on('click', showWindow);
}

async function loadJobNames() {
  try {
    const response = await fetch(`${HUB_ORIGIN}/api/automations`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return;
    const { automations } = await response.json();
    jobNames = Object.fromEntries((automations ?? []).map((item) => [item.id, item.name]));
  } catch { /* names are optional */ }
}

// A Windows notification for each automation that fails while the app is open.
async function checkRuns() {
  try {
    const response = await fetch(`${HUB_ORIGIN}/api/snapshot`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return;
    const { recentRuns } = await response.json();
    if (!Object.keys(jobNames).length) await loadJobNames();
    for (const run of newFailures(recentRuns, seenRuns, startedAt)) {
      if (!Notification.isSupported()) break;
      const note = new Notification({
        title: `${jobNames[run.jobId] ?? run.jobId} failed`,
        body: String(run.summary ?? 'Open the hub to see what happened.').slice(0, 200),
        icon: ICON,
      });
      note.on('click', showWindow);
      note.show();
    }
  } catch { /* hub not reachable right now */ }
}

function lockDown() {
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (opensInBrowser(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    // Server redirects (for example the hub sending a link on to linkedin.com) skip
    // will-navigate, so both events get the same check.
    const guard = (event, url) => {
      if (!opensInBrowser(url) && (isHubUrl(url) || url.split('?')[0] === OFFLINE_URL)) return;
      event.preventDefault();
      if (opensInBrowser(url)) shell.openExternal(url);
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}

function start() {
  app.setAppUserModelId('local.loom');
  lockDown();
  app.on('second-instance', showWindow);
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => { /* stay in the tray */ });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    // The dashboard needs no camera, microphone, location or similar.
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    createTray();
    createWindow();
    void startOllama();
    setInterval(checkRuns, POLL_MS).unref?.();
  });
}
