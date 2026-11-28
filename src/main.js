const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, screen, nativeImage, clipboard, session, desktopCapturer } = require('electron');
const path = require('path');
const { Store } = require('./settings');
const { MediaWatcher } = require('./media');
const { fetchLyrics } = require('./lyrics');
const { OffsetStore } = require('./offsets');
const { PositionTracker } = require('./position');
const { SmartManager } = require('./smart/manager');
const timing = require('./overlay/timing');

const HOTKEY = 'Control+Alt+L';
const OFFSET_STEP = 250;      // ms por pulsación de Ctrl+Alt+←/→
const OFFSET_LIMIT = 60000;
const PRELOAD = path.join(__dirname, 'preload.js');

// Chromium puede creer que la ventana transparente está "tapada" por otra y dejar de dibujarla
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
// Tope de memoria de JavaScript (la app es pequeña): el recolector trabaja antes y ocupa menos
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=96');

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let store, offsets, watcher, overlay, settingsWin, tray, smartMgr;
let quitting = false;

// Estado real (música detectada) y estado demo
const state = {
  key: '',
  track: { active: false, title: '', artist: '', album: '', app: '', lyricsState: 'idle', lyrics: null, approx: false },
  songKey: '',
  songOffsetMs: 0,
  timing: { playing: false, positionMs: 0, sampledAt: Date.now() },
  detector: { supported: process.platform === 'win32', error: '' },
  lastTick: 0,
  fallbackPos: 0,
  logs: [],
  sessionsNow: [],
  sessionsSeen: new Set(),
  tracker: new PositionTracker(),
  pendingKey: null,
  pendingCount: 0,
  lastSample: null
};
const demo = { on: false, startedAt: 0, timer: null };

const DEMO_LINES = [
  'Así se verán tus letras',
  'Muévelas a la izquierda, al centro',
  'o al lado derecho de la pantalla',
  'Cambia tamaño, color y brillo',
  'Todo se actualiza al instante',
  '',
  'Pon música en Spotify o YouTube',
  'y las letras te seguirán solas'
].map((text, i) => ({ t: i * 3500 + 500, text }));
const DEMO_LENGTH = DEMO_LINES.length * 3500 + 1500;

// ---------- utilidades ----------
function scriptPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'media', 'get-media.ps1')
    : path.join(__dirname, 'media', 'get-media.ps1');
}

function pickDisplay() {
  const all = screen.getAllDisplays();
  const idx = store.get().display;
  return all[idx] || screen.getPrimaryDisplay();
}

function send(win, channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
function broadcast(channel, payload) {
  send(overlay, channel, payload);
  send(settingsWin, channel, payload);
}

function publicTrack() {
  const t = state.track;
  return { active: t.active, title: t.title, artist: t.artist, album: t.album, app: t.app, lyricsState: t.lyricsState, lyrics: t.lyrics, approx: !!t.approx, backup: !!t.backup, songOffsetMs: state.songOffsetMs, demo: demo.on };
}

function emitTrack() {
  if (demo.on) {
    broadcast('track', { active: true, title: 'Modo demostración', artist: 'Lyrics Overlay', album: '', app: '', lyricsState: 'found', lyrics: DEMO_LINES, approx: false, songOffsetMs: 0, demo: true });
  } else {
    broadcast('track', publicTrack());
  }
}
function emitTiming() {
  if (demo.on) return;
  broadcast('timing', state.timing);
}

// ---------- ventanas ----------
function createOverlay() {
  const d = pickDisplay();
  overlay = new BrowserWindow({
    ...overlayRect(),
    transparent: true, frame: false, resizable: false, movable: false, focusable: false,
    skipTaskbar: true, hasShadow: false, alwaysOnTop: true, show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setIgnoreMouseEvents(true, { forward: false });
  // Windows a veces baja la ventana cuando otra app pasa al frente: se reafirma "siempre encima" cada 2 s
  setInterval(() => {
    if (overlay && !overlay.isDestroyed() && overlay.isVisible()) {
      overlay.setAlwaysOnTop(true, 'screen-saver');
      overlay.moveTop();
    }
  }, 2000);
  overlay.loadFile(path.join(__dirname, 'overlay', 'overlay.html'));
  overlay.once('ready-to-show', () => { if (store.get().enabled) overlay.showInactive(); });
  overlay.webContents.on('did-finish-load', () => {
    send(overlay, 'settings', store.get());
    emitTrack();
    emitTiming();
  });
}

// La ventana de letras ocupa solo la zona donde se dibuja la letra, no toda la pantalla:
// una ventana transparente a pantalla completa cuesta mucha GPU/CPU aunque casi todo sea invisible.
function overlayRect() {
  const w = pickDisplay().workArea, st = store.get();
  const width = Math.max(300, Math.min(w.width, Math.round(w.width * st.maxWidthPct / 100)));
  const height = Math.max(120, Math.min(w.height, Math.round(st.linesVisible * st.fontSize * 1.65)));
  let x, y;
  if (st.hAlign === 'left') x = w.x + st.marginX;
  else if (st.hAlign === 'right') x = w.x + w.width - st.marginX - width;
  else x = w.x + Math.round((w.width - width) / 2);
  if (st.vPos === 'top') y = w.y + st.marginY;
  else if (st.vPos === 'bottom') y = w.y + w.height - st.marginY - height;
  else y = w.y + Math.round((w.height - height) / 2);
  x = Math.max(w.x, Math.min(x, w.x + w.width - width));
  y = Math.max(w.y, Math.min(y, w.y + w.height - height));
  return { x, y, width, height };
}

function moveOverlayToDisplay() {
  if (!overlay || overlay.isDestroyed()) return;
  overlay.setBounds(overlayRect());
}

function createSettings() {
  settingsWin = new BrowserWindow({
    width: 900, height: 720, minWidth: 780, minHeight: 560, show: false,
    backgroundColor: '#0e1014', title: 'Lyrics Overlay — Ajustes', autoHideMenuBar: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, spellcheck: false }
  });
  settingsWin.removeMenu();
  settingsWin.loadFile(path.join(__dirname, 'settings-ui', 'settings.html'));
  settingsWin.once('ready-to-show', () => settingsWin.show());
  // Al cerrar Ajustes la ventana se destruye de verdad (libera decenas de MB); se vuelve a crear al abrirla desde la bandeja
  settingsWin.on('closed', () => { settingsWin = null; });
}

function openSettings() {
  if (!settingsWin || settingsWin.isDestroyed()) createSettings();
  else { settingsWin.show(); settingsWin.focus(); }
}

function setEnabled(on) {
  store.set({ enabled: on });
  if (overlay && !overlay.isDestroyed()) on ? overlay.showInactive() : overlay.hide();
  broadcast('settings', store.get());
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('Lyrics Overlay');
  const rebuild = () => tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Ajustes…', click: openSettings },
    { label: store.get().enabled ? 'Ocultar letras  (Ctrl+Alt+L)' : 'Mostrar letras  (Ctrl+Alt+L)', click: () => { setEnabled(!store.get().enabled); rebuild(); } },
    { type: 'separator' },
    { label: 'Salir', click: () => { quitting = true; app.quit(); } }
  ]));
  rebuild();
  tray.on('click', openSettings);
  tray.rebuild = rebuild;
}

// ---------- música ----------
async function loadLyricsFor(sample, key) {
  state.track.lyricsState = 'loading';
  state.track.lyrics = null;
  emitTrack();
  const result = await fetchLyrics(
    { artist: sample.artist, title: sample.title, album: sample.album, app: sample.app, durationMs: sample.durationMs },
    path.join(app.getPath('userData'), 'lyrics-cache'),
    store.get().lyricsSource
  );
  if (state.key !== key) return; // cambió la canción mientras buscaba
  state.track.lyrics = result ? result.lines : null;
  state.track.approx = result ? result.approx : false;
  state.track.lyricsDuration = result ? (result.duration || 0) : 0;
  state.track.backup = !!(result && result.backup);
  state.track.lyricsSourceName = result ? (result.source || 'LRCLIB') : '';
  state.track.lyricsState = result ? 'found' : 'none';
  emitTrack();
  if (smartMgr && result) smartMgr.onLyrics(state.songKey, timing.cleanIntro(result.lines));
}

function onSample(s) {
  const received = Date.now();
  // Hora a la que PowerShell leyó la posición (más exacta que la de llegada por la tubería)
  const now = (s.nowMs && Math.abs(received - s.nowMs) < 2000) ? s.nowMs : received;
  state.detector.error = s.error || '';
  if (Array.isArray(s.sessions) || typeof s.sessions === 'string') {
    const arr = [].concat(s.sessions || []);
    state.sessionsNow = arr;
    arr.forEach((x) => state.sessionsSeen.add(x.replace(/ \[.*\]$/, '')));
  }
  // Un error puntual de lectura no significa "se paró la música": se ignora esa lectura
  if (s.error && !s.active) return;

  const key = s.active && s.title ? `${s.artist}|${s.title}` : '';

  if (key !== state.key) {
    // Filtro de parpadeos: la canción nueva debe repetirse en varias lecturas seguidas
    // (2 ≈ 0,6 s); quedarse sin canción tarda más (10 ≈ 3 s) para no borrar las letras por un fallo fugaz.
    if (key === state.pendingKey) state.pendingCount++;
    else { state.pendingKey = key; state.pendingCount = 1; }
    if (state.pendingCount < (key ? 2 : 10)) return;

    state.hadPrev = !!state.key;
    state.changeAt = now;
    state.key = key;
    state.pendingKey = null; state.pendingCount = 0;
    state.fallbackPos = 0;
    state.lastTick = now;
    state.tracker.reset();
    state.track = { active: !!key, title: s.title || '', artist: s.artist || '', album: s.album || '', app: s.app || '', lyricsState: key ? 'loading' : 'idle', lyrics: null, approx: false, lyricsDuration: 0 };
    state.songKey = key ? OffsetStore.keyFor(s.artist, s.title) : '';
    state.songOffsetMs = state.songKey ? offsets.get(state.songKey) : 0;
    if (smartMgr) smartMgr.onTrackStart(state.songKey);
    state.track.fills = smartMgr ? smartMgr.fillsFor(state.songKey) : null;
    emitTrack();
    if (key) loadLyricsFor(s, key);
  } else {
    state.pendingKey = null; state.pendingCount = 0;
  }

  let pos = 0;
  if (s.active) {
    if (s.hasTimeline) {
      pos = state.tracker.update(s, now, { hadPrevious: state.hadPrev, sinceChangeMs: now - (state.changeAt || now) });
    } else {
      // Fuente sin línea de tiempo: contamos desde que empezó la canción
      if (s.playing) state.fallbackPos += now - state.lastTick;
      pos = state.fallbackPos;
    }
  }
  const gap = state.prevSampleAt ? received - state.prevSampleAt : 0;
  state.prevSampleAt = received;
  if (gap > 0) { state.gapMax = Math.max(state.gapMax || 0, gap); }
  state.lastTick = now;
  state.lastSample = { app: s.app, playing: !!s.playing, rawPositionMs: s.positionMs, updatedAgeMs: s.updatedMs > 1e12 ? now - s.updatedMs : null, durationMs: s.durationMs, hasTimeline: !!s.hasTimeline, mode: s.hasTimeline ? state.tracker.mode : 'sin línea de tiempo' };
  state.timing = { playing: !!(s.active && s.playing), positionMs: pos, sampledAt: now };
  if (smartMgr) smartMgr.onPosition(now, pos, !!(s.active && s.playing));
  emitTiming();
}

function startDemo() {
  demo.on = true;
  demo.startedAt = Date.now();
  emitTrack();
  const tick = () => broadcast('timing', { playing: true, positionMs: (Date.now() - demo.startedAt) % DEMO_LENGTH, sampledAt: Date.now() });
  tick();
  demo.timer = setInterval(tick, 500);
}
function stopDemo() {
  demo.on = false;
  clearInterval(demo.timer);
  emitTrack();
  broadcast('timing', state.timing);
}

// ---------- informe para compartir (botón "Copiar informe" en Ajustes) ----------
function buildReport() {
  const os = require('os'), fs = require('fs');
  const t = state.track || {}, sm = state.lastSample || {};
  const sp = scriptPath();
  const st = store.get();
  return [
    'INFORME CANTANI',
    `Versión app: ${app.getVersion()} · empaquetada: ${app.isPackaged} · Electron ${process.versions.electron} · Chrome ${process.versions.chrome}`,
    `Windows: ${os.type()} ${os.release()} ${os.arch()} · idioma: ${app.getLocale()}`,
    `Script de lectura: ${sp} · existe: ${fs.existsSync(sp)}`,
    `Detector: soportado=${state.detector.supported} · error="${state.detector.error || ''}"`,
    `Reinicios de PowerShell: ${watcher ? watcher.restarts : '?'}`,
    `Última lectura: app="${sm.app || ''}" · reproduciendo=${sm.playing} · posición=${sm.rawPositionMs} · duración=${sm.durationMs} · línea de tiempo=${sm.hasTimeline} · modo=${sm.mode}`,
    `Pista: "${t.artist || ''}" - "${t.title || ''}" · letra: ${t.lyricsState} · fuente: ${t.lyricsSourceName || ''} · respaldo=${!!t.backup} · otra versión=${!!t.approx}`,
    `Ajustes: fuente de letras=${st.lyricsSource} · global=${st.syncOffsetMs} ms · monitor=${st.display}`,
    `Modo inteligente: ${smartMgr ? smartMgr.describe() : '?'}`,
    `Estabilidad: correcciones ${state.tracker.stats.corrections} · mayor ${state.tracker.stats.maxAbsMs} ms · saltos >0,5 s: ${state.tracker.stats.bigJumps} · mayor hueco ${state.gapMax || 0} ms · ajuste canción ${state.songOffsetMs} ms`,
    `Sesiones de medios que Windows ve AHORA: ${state.sessionsNow.length ? state.sessionsNow.join(' | ') : '(ninguna)'}`,
    `Reproductores vistos desde que abrió la app: ${[...state.sessionsSeen].join(' | ') || '(ninguno)'}`,
    'Registro del lector:',
    ...(state.logs.length ? state.logs : ['(vacío)'])
  ].join('\n');
}

// ---------- diagnóstico (solo si la ventana de ajustes está visible) ----------
function sendDiag() {
  if (!settingsWin || settingsWin.isDestroyed() || !settingsWin.isVisible()) return;
  const t = state.track, sm = state.lastSample || {};
  const lines = t.lyrics || [];
  const posNow = state.timing.playing ? state.timing.positionMs + (Date.now() - state.timing.sampledAt) : state.timing.positionMs;
  send(settingsWin, 'diag', {
    app: sm.app || '', mode: sm.mode || '', playing: !!sm.playing, hasTimeline: !!sm.hasTimeline,
    rawPositionMs: sm.rawPositionMs, updatedAgeMs: sm.updatedAgeMs, durationMs: sm.durationMs,
    estimatedPositionMs: Math.round(posNow), songOffsetMs: state.songOffsetMs, globalOffsetMs: store.get().syncOffsetMs,
    lyricsState: t.lyricsState, lyricsSource: t.lyricsSourceName || '', approx: !!t.approx, lyricsDurationSec: t.lyricsDuration || 0,
    smart: smartMgr ? smartMgr.describe() : '',
    lineCount: lines.length, firstLineMs: lines.length ? lines[0].t : null,
    pos: state.tracker.stats, maxGapMs: state.gapMax || 0, restarts: watcher ? watcher.restarts : 0,
    firstTextLineMs: (lines.find((l) => l.text) || {}).t ?? null
  });
}

// ---------- ajuste de sincronía por canción ----------
function adjustOffset(delta, reset = false) {
  if (demo.on || !state.songKey) return state.songOffsetMs;
  const next = reset ? 0 : Math.max(-OFFSET_LIMIT, Math.min(OFFSET_LIMIT, state.songOffsetMs + delta));
  state.songOffsetMs = next;
  offsets.set(state.songKey, next);
  broadcast('offset', { songOffsetMs: next, toast: true });
  return next;
}

function setOffset(ms) {
  if (demo.on || !state.songKey) return state.songOffsetMs;
  const next = Math.max(-OFFSET_LIMIT, Math.min(OFFSET_LIMIT, Math.round(Number(ms) || 0)));
  state.songOffsetMs = next;
  offsets.set(state.songKey, next);
  broadcast('offset', { songOffsetMs: next, toast: true });
  return next;
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('settings:get', () => store.get());
  ipcMain.handle('settings:set', (_e, patch) => {
    const before = store.get();
    const next = store.set(patch);
    if (['display', 'hAlign', 'vPos', 'marginX', 'marginY', 'fontSize', 'linesVisible', 'maxWidthPct'].some((k) => next[k] !== before[k])) moveOverlayToDisplay();
    if (next.enabled !== before.enabled) {
      next.enabled ? overlay.showInactive() : overlay.hide();
      tray && tray.rebuild();
    }
    broadcast('settings', next);
    return next;
  });
  ipcMain.handle('settings:reset', () => {
    const next = store.reset();
    moveOverlayToDisplay();
    next.enabled ? overlay.showInactive() : overlay.hide();
    broadcast('settings', next);
    return next;
  });
  ipcMain.handle('displays:get', () =>
    screen.getAllDisplays().map((d, i) => ({ index: i, label: `Pantalla ${i + 1} (${d.bounds.width}×${d.bounds.height})${d.id === screen.getPrimaryDisplay().id ? ' — principal' : ''}` }))
  );
  ipcMain.handle('report:copy', () => { const r = buildReport(); clipboard.writeText(r); return r.length; });
  ipcMain.handle('state:get', () => ({ track: demo.on ? { active: true, title: 'Modo demostración', artist: 'Lyrics Overlay', lyricsState: 'found', demo: true } : { ...publicTrack(), lyrics: undefined }, detector: state.detector, demo: demo.on, songOffsetMs: state.songOffsetMs }));
  ipcMain.handle('offset:adjust', (_e, delta) => adjustOffset(Number(delta) || 0));
  ipcMain.handle('offset:reset', () => adjustOffset(0, true));
  ipcMain.handle('offset:set', (_e, ms) => setOffset(ms));
  ipcMain.handle('demo:set', (_e, on) => { on ? startDemo() : stopDemo(); return demo.on; });
}

// ---------- arranque ----------
app.on('second-instance', openSettings);

app.whenReady().then(() => {
  store = new Store(path.join(app.getPath('userData'), 'settings.json'));
  offsets = new OffsetStore(path.join(app.getPath('userData'), 'song-offsets.json'));
  smartMgr = new SmartManager({ BrowserWindow, session, desktopCapturer, ipcMain }, {
    dir: app.getPath('userData'),
    log: (m) => { state.logs.push(new Date().toISOString().slice(11, 19) + ' ' + String(m)); if (state.logs.length > 40) state.logs.shift(); },
    hasManual: (k) => offsets.has(k),
    getOffset: (k) => offsets.get(k),
    enabled: () => !!store.get().smartMode,
    apply: (k, ms, info) => {
      if (state.songKey !== k) return;
      state.songOffsetMs = ms; offsets.set(k, ms);
      broadcast('offset', { songOffsetMs: ms, toast: false });
      const text = (info && info.revert)
        ? 'Modo inteligente: ajuste deshecho (las medidas no coincidían)'
        : `Modo inteligente: letras ajustadas ${ms > 0 ? '+' : ''}${ms} ms para esta canción`;
      broadcast('toast', { text, ms: 4500 });
    }
  });
  registerIpc();
  createOverlay();
  createTray();
  createSettings();

  const hotkey = (accel, fn) => { try { globalShortcut.register(accel, fn); } catch { /* atajo ocupado por otra app */ } };
  hotkey(HOTKEY, () => { setEnabled(!store.get().enabled); tray && tray.rebuild(); });
  hotkey('Control+Alt+Shift+Right', () => adjustOffset(2000));
  hotkey('Control+Alt+Shift+Left', () => adjustOffset(-2000));
  hotkey('Control+Alt+Right', () => adjustOffset(OFFSET_STEP));   // letras más pronto
  hotkey('Control+Alt+Left', () => adjustOffset(-OFFSET_STEP));   // letras más tarde
  hotkey('Control+Alt+Down', () => adjustOffset(0, true));        // quitar el ajuste de esta canción
  hotkey('Control+Alt+PageUp', () => send(overlay, 'calibrateFirst')); // "la 1.ª línea cantada suena AHORA": arregla letras desfasadas muchos segundos
  hotkey('Control+Alt+I', () => {          // interruptor secreto del modo inteligente (experimental)
    const on = !store.get().smartMode;
    store.set({ smartMode: on });
    if (!on) smartMgr.stop();
    broadcast('toast', { text: on ? 'Modo inteligente ACTIVADO (se aplica desde la próxima canción)' : 'Modo inteligente desactivado', ms: 3500 });
  });
  hotkey('Control+Alt+Up', () => send(overlay, 'calibrate'));     // "esta línea empieza AHORA": ajuste exacto

  setInterval(sendDiag, 1000);
  watcher = new MediaWatcher(scriptPath());
  watcher.on('sample', onSample);
  watcher.on('unsupported', () => { state.detector = { supported: false, error: 'La detección de música solo funciona en Windows. Usa el modo demostración.' }; });
  watcher.on('log', (m) => { state.logs.push(new Date().toISOString().slice(11, 19) + ' ' + String(m).trim()); if (state.logs.length > 40) state.logs.shift(); console.error('[media]', m); });
  watcher.start();

  screen.on('display-metrics-changed', moveOverlayToDisplay);
  screen.on('display-added', moveOverlayToDisplay);
  screen.on('display-removed', moveOverlayToDisplay);
});

app.on('before-quit', () => { quitting = true; smartMgr && smartMgr.stop(); store && store.flush(); offsets && offsets.flush(); watcher && watcher.stop(); });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', (e) => e.preventDefault()); // vive en la bandeja
