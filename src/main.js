const {
  app,
  Tray,
  Menu,
  BrowserWindow,
  screen,
  nativeImage,
  nativeTheme,
  ipcMain,
  shell,
} = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const { computeUsage } = require('./usage');
const { fetchUsage, normalizeLive } = require('./live-usage');
const { loadConfig, saveConfig, configPath } = require('./config');
const { drawRingIcon } = require('./tray-icon');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const APP_ID = 'com.claudeusage.widget';

let tray = null;
let win = null;
let cfg = null;
let latest = null;
let refreshTimer = null;
let watcher = null;
let lastHide = 0;

// Smoke-test mode: render the flyout offscreen, screenshot it, and quit. Used
// to verify the full render pipeline without a visible desktop session.
const SMOKE = process.argv.includes('--smoke') || process.env.CLAUDE_WIDGET_SMOKE === '1';

// ---------------------------------------------------------------------------
// Single-instance lock (must run before creating any window/tray)
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(SMOKE ? runSmoke : init);
}

async function runSmoke() {
  app.setAppUserModelId(APP_ID);
  cfg = loadConfig(configDir());
  registerIpc();
  const local = await computeUsage(PROJECTS_DIR, cfg);
  let live = { ok: false, error: 'smoke (no live fetch)' };
  const mockPath = process.env.CLAUDE_WIDGET_MOCK_LIVE;
  if (mockPath) {
    try {
      live = normalizeLive(JSON.parse(fs.readFileSync(mockPath, 'utf8')));
    } catch (e) {
      live = { ok: false, error: 'mock load failed: ' + e.message };
    }
  }
  latest = {
    generatedAt: Date.now(),
    metric: local.metric,
    filesScanned: local.filesScanned,
    live,
    local,
    bars: deriveBars(local, live),
  };

  const outDir = process.env.CLAUDE_WIDGET_SMOKE_DIR || app.getPath('temp');
  const sessionPct = latest.bars.session.pct || 0;
  try {
    fs.writeFileSync(
      path.join(outDir, 'tray.png'),
      trayImage(sessionPct, severityColor(sessionPct)).toPNG()
    );
  } catch (e) {
    console.error('tray capture failed', e);
  }

  createWindow();
  win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#202020' : '#F3F3F3');
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  win.webContents.send('usage:update', latest);
  win.show();
  await new Promise((r) => setTimeout(r, 1100));
  try {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, 'flyout.png'), img.toPNG());
    console.log(
      'SMOKE_OK',
      JSON.stringify({
        outDir,
        source: latest.bars.source,
        sessionPct: latest.bars.session.pct,
        weekPct: latest.bars.weekAll.pct,
        models: latest.bars.models.map((m) => m.family),
      })
    );
  } catch (e) {
    console.error('page capture failed', e);
  }
  // Force-exit: the real close handler preventDefaults, which would block quit.
  app.exit(0);
}

// Keep the app alive in the tray when the flyout hides/closes.
app.on('window-all-closed', () => {});

// Distinguish "user clicked away" (hide) from a real quit (tray > Quit). Without
// this, the close handler's preventDefault would block app.quit() entirely.
let isQuitting = false;
app.on('before-quit', () => {
  isQuitting = true;
});

function configDir() {
  return app.getPath('userData');
}

async function init() {
  app.setAppUserModelId(APP_ID);
  cfg = loadConfig(configDir());
  applyLoginItem();
  createWindow();
  createTray();
  registerIpc();
  await refresh('force');
  startAutoRefresh();
  watchLogs();
  nativeTheme.on('updated', () => {
    if (win) win.webContents.send('theme:changed', nativeTheme.shouldUseDarkColors);
  });
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------
function severityColor(pct) {
  if (pct >= 0.85) return '#E81123'; // Win11 red
  if (pct >= 0.6) return '#F7630C'; // amber
  return '#3A96DD'; // Fluent accent blue
}

// Unify the authoritative live bars and the local-estimate fallback into one
// shape the tray + renderer consume: { source, session, weekAll, models[] } with
// pct as a 0..1 fraction (or null when unknown).
function deriveBars(local, live) {
  if (live && live.ok && live.session) {
    const f = (b) =>
      b
        ? { pct: b.utilization == null ? null : b.utilization / 100, resetsAt: b.resetsAt }
        : { pct: null, resetsAt: null };
    return {
      source: 'live',
      session: f(live.session),
      weekAll: f(live.weekAll),
      // Only surface per-model bars the account actually has (drop null buckets),
      // so the tiles mirror the desktop's /usage exactly.
      models: (live.models || [])
        .filter((m) => m.utilization != null)
        .map((m) => ({
          family: m.family,
          label: m.label,
          pct: m.utilization / 100,
          resetsAt: m.resetsAt,
        })),
    };
  }
  const caps = local.caps || {};
  return {
    source: 'local',
    session: { pct: caps.fiveHour > 0 ? local.block.tokens / caps.fiveHour : null, resetsAt: local.block.resetTs },
    weekAll: { pct: caps.weekly > 0 ? local.week.tokens / caps.weekly : null, resetsAt: local.weekResetTs },
    models: (local.trackedWeek || []).map((t) => ({
      family: t.family,
      label: t.label,
      pct: t.cap > 0 ? t.tokens / t.cap : null,
      resetsAt: null,
    })),
  };
}

function trayImage(pct, color) {
  // Render at 32px and tag as 2x so it maps to a crisp 16-DIP tray icon.
  const buf = drawRingIcon(Math.min(pct, 1), color, { size: 32 });
  return nativeImage.createFromBuffer(buf, { scaleFactor: 2 });
}

function createTray() {
  tray = new Tray(trayImage(0, '#3A96DD'));
  tray.setToolTip('Claude Max — Usage');
  tray.on('click', () => {
    if (win.isVisible()) {
      win.hide();
      return;
    }
    if (Date.now() - lastHide < 250) return; // guard blur->click re-open race
    showWindow();
  });
  tray.on('right-click', () => {
    const menu = Menu.buildFromTemplate([
      { label: 'Open usage', click: () => showWindow() },
      { label: 'Refresh now', click: () => refresh('force') },
      { type: 'separator' },
      { label: 'Edit settings…', click: () => openConfig() },
      {
        label: 'Start on login',
        type: 'checkbox',
        checked: !!cfg.startOnLogin,
        click: (mi) => {
          cfg.startOnLogin = mi.checked;
          saveConfig(configDir(), cfg);
          applyLoginItem();
        },
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]);
    tray.popUpContextMenu(menu);
  });
}

function updateTray() {
  if (!tray || !latest) return;
  const bars = latest.bars;
  const sessionPct = bars.session.pct || 0;
  const sev = Math.max(
    0,
    sessionPct,
    bars.weekAll.pct || 0,
    ...bars.models.map((m) => m.pct || 0)
  );
  tray.setImage(trayImage(sessionPct, severityColor(sev)));

  const pct = (p) => (p == null ? '—' : Math.round(p * 100) + '%');
  // Windows tray tooltips are short; keep it tight and put detail in the flyout.
  const lines = [
    bars.source === 'live' ? 'Claude Max — Usage' : 'Claude Max — Usage (local est.)',
    `Session   ${pct(bars.session.pct)}`,
    `Week all  ${pct(bars.weekAll.pct)}`,
  ];
  if (bars.models.length) {
    lines.push(bars.models.map((m) => `${m.label} ${pct(m.pct)}`).join('   '));
  }
  tray.setToolTip(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Flyout window (Path A: opaque + acrylic material, DWM rounds corners)
// ---------------------------------------------------------------------------
function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors;
  win = new BrowserWindow({
    width: 360,
    height: 700,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    roundedCorners: true,
    transparent: false,
    backgroundColor: dark ? '#202020' : '#F3F3F3',
    backgroundMaterial: 'acrylic',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Acrylic/Mica requires Win11 22H2+; no-ops elsewhere. Guard just in case.
  try {
    if (win.setBackgroundMaterial) win.setBackgroundMaterial('acrylic');
  } catch (_) {}

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.on('blur', () => {
    if (win.webContents.isDevToolsOpened()) return;
    win.hide();
    lastHide = Date.now();
  });
  win.on('close', (e) => {
    if (isQuitting) return; // let a real quit through
    e.preventDefault();
    win.hide();
  });
}

function positionWindow() {
  const t = tray.getBounds();
  const w = win.getBounds();
  const { workArea, bounds } = screen.getDisplayNearestPoint({ x: t.x, y: t.y });
  const margin = 8;

  let x = Math.round(t.x + t.width / 2 - w.width / 2);
  x = Math.max(
    workArea.x + margin,
    Math.min(x, workArea.x + workArea.width - w.width - margin)
  );

  const taskbarBottom = workArea.y === bounds.y && workArea.height < bounds.height;
  const y = taskbarBottom
    ? workArea.y + workArea.height - w.height - margin
    : workArea.y + margin;

  win.setBounds({ x, y, width: w.width, height: w.height });
}

function showWindow() {
  positionWindow();
  win.show();
  win.focus();
  if (latest) win.webContents.send('usage:update', latest);
}

// ---------------------------------------------------------------------------
// Data refresh + file watching
// ---------------------------------------------------------------------------
// The live /api/oauth/usage endpoint is rate-limited, so we cache its result and
// only re-fetch on a slow cadence -- decoupled from the frequent local refreshes
// that the file watcher triggers. Modes:
//   'skip'      -> never call the API; reuse the cached live result (file-watch)
//   'throttled' -> call only if the cache is older than liveRefreshSeconds (timer)
//   'force'     -> always call (startup + manual Refresh button)
let liveCache = null;
let liveAt = 0;

async function getLive(mode) {
  const now = Date.now();
  const minMs = Math.max(20, cfg.liveRefreshSeconds || 60) * 1000;
  if (mode === 'skip') {
    return liveCache || { ok: false, error: 'not fetched yet' };
  }
  if (mode === 'throttled' && liveCache && liveCache.ok && now - liveAt < minMs) {
    return liveCache; // still fresh enough
  }
  try {
    const data = await fetchUsage();
    liveCache = data;
    liveAt = now;
    return data;
  } catch (e) {
    // On failure (e.g. 429/offline) keep showing the last good data as stale
    // rather than dropping to the local-estimate fallback.
    if (liveCache && liveCache.ok) {
      return { ...liveCache, stale: true, error: e.message, code: e.code || null };
    }
    return { ok: false, error: e.message || String(e), code: e.code || null };
  }
}

async function refresh(mode = 'throttled') {
  try {
    const local = await computeUsage(PROJECTS_DIR, cfg);
    const live = await getLive(mode);
    latest = {
      generatedAt: Date.now(),
      metric: local.metric,
      filesScanned: local.filesScanned,
      liveAt,
      live,
      local,
      bars: deriveBars(local, live),
    };
    updateTray();
    if (win && win.isVisible()) win.webContents.send('usage:update', latest);
  } catch (err) {
    console.error('[claude-usage] refresh failed:', err);
  }
}

function startAutoRefresh() {
  clearInterval(refreshTimer);
  const secs = Math.max(5, cfg.refreshSeconds || 30);
  refreshTimer = setInterval(() => refresh('throttled'), secs * 1000);
}

function watchLogs() {
  try {
    let timer = null;
    watcher = fs.watch(PROJECTS_DIR, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => refresh('skip'), 1500); // local only; don't hit the API
    });
  } catch (_) {
    // fs.watch(recursive) can fail on some setups; the interval poll still runs.
  }
}

// ---------------------------------------------------------------------------
// Login item + settings
// ---------------------------------------------------------------------------
function applyLoginItem() {
  try {
    const settings = { openAtLogin: !!cfg.startOnLogin };
    if (app.isPackaged) {
      settings.path = process.execPath;
      settings.args = ['--hidden'];
    }
    app.setLoginItemSettings(settings);
  } catch (_) {}
}

function openConfig() {
  const p = configPath(configDir());
  if (!fs.existsSync(p)) saveConfig(configDir(), cfg);
  shell.openPath(p);
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('usage:get', () => latest);
  ipcMain.handle('config:get', () => cfg);
  ipcMain.handle('usage:refresh', async () => {
    cfg = loadConfig(configDir()); // pick up any manual edits before recomputing
    await refresh('force');
    startAutoRefresh();
    return latest;
  });
  ipcMain.handle('app:openConfig', () => openConfig());
  ipcMain.handle('app:quit', () => app.quit());
}
