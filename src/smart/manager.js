/**
 * Modo inteligente (experimental, desactivado por defecto): al empezar una canción escucha el audio del sistema
 * unos segundos, busca cuándo entra la voz y, si está muy seguro, ajusta la sincronía de ESA canción y la recuerda.
 * Nunca pisa un ajuste hecho a mano.
 */
const fs = require('fs');
const path = require('path');
const { analyze, median } = require('./onset');

const MAX_CAPTURE_MS = 45000;      // tiempo máximo escuchando
const RETRY_AFTER_MS = 7 * 24 * 3600 * 1000;

class SmartManager {
  /**
   * electron: { BrowserWindow, session, desktopCapturer, ipcMain }
   * opts: { dir, log(msg), hasManual(key), apply(key, ms, info), enabled() }
   */
  constructor(electron, opts) {
    this.e = electron; this.o = opts;
    this.file = path.join(opts.dir, 'smart-analysis.json');
    this.db = {};
    try { this.db = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {}; } catch { /* primera vez */ }
    this.win = null;
    this.s = null;                 // sesión actual
    this.status = 'inactivo';
    this.handlerSet = false;
    const ipc = electron.ipcMain;
    ipc.on('smart:hops', (ev, d) => this._onHops(ev, d));
    ipc.on('smart:ready', (ev) => { if (this._mine(ev)) this._set('escuchando'); });
    ipc.on('smart:error', (ev, m) => { if (this._mine(ev)) { this.o.log('modo inteligente: ' + m); this._finish('error: ' + m); } });
  }

  _mine(ev) { return this.win && !this.win.isDestroyed() && ev.sender === this.win.webContents; }
  _set(st) { this.status = st; }
  _save() { try { fs.writeFileSync(this.file, JSON.stringify(this.db)); } catch { /* sin permisos */ } }

  describe() {
    const last = this.s ? '' : '';
    return `${this.o.enabled() ? 'activado' : 'desactivado'} · ${this.status}${last}`;
  }

  /** Canción nueva (o activación con una canción ya sonando): decide si merece la pena escuchar. */
  onTrackStart(key, ctx) {
    this._finish('cambió la canción', true);
    if (!this.o.enabled() || !key) return;
    if (this.o.hasManual(key)) { this._set('omitida: ya la ajustaste a mano'); return; }
    const prev = this.db[key];
    if (prev && Date.now() - prev.at < RETRY_AFTER_MS) { this._set(prev.applied ? `ya analizada (${prev.offsetMs} ms)` : `ya analizada (${prev.reason})`); return; }
    if (ctx && ctx.posMs > 4000) { this._set('omitida: la canción ya iba empezada'); return; }
    this.s = { key, startedAt: Date.now(), hops: [], log: [], firstLineMs: null, done: false };
    this._set('arrancando captura');
    this._openWindow();
  }

  /** Letras listas: hace falta el tiempo de la primera línea cantada. */
  onLyrics(key, firstLineMs) {
    if (!this.s || this.s.key !== key) return;
    if (!Number.isFinite(firstLineMs) || firstLineMs > 40000) { this._finish('primera línea muy tarde o sin letra'); return; }
    this.s.firstLineMs = firstLineMs;
    this._maybeAnalyze();
  }

  /** Posición estimada de la canción en cada lectura (para convertir la hora de cada fragmento de audio en posición). */
  onPosition(now, posMs, playing) {
    const s = this.s;
    if (!s || s.done) return;
    if (!playing) { if (s.log.length > 5) this._finish('en pausa'); return; }
    s.log.push({ t: now, c: posMs - now });
    if (s.log.length > 400) s.log.shift();
    if (s.log.length > 10) {
      const c = median(s.log.map((x) => x.c));
      if (Math.abs(s.log[s.log.length - 1].c - c) > 1500) this._finish('se movió la canción (salto o pausa)');
    }
    if (now - s.startedAt > MAX_CAPTURE_MS) this._finish('tiempo agotado');
  }

  stop() { this._finish('detenido', true); }

  // ---- interno ----
  _openWindow() {
    const { BrowserWindow, session, desktopCapturer } = this.e;
    if (!this.handlerSet) {
      this.handlerSet = true;
      session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
        try {
          const src = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
          cb({ video: src[0], audio: 'loopback' });
        } catch { cb({}); }
      });
    }
    try {
      this.win = new BrowserWindow({
        show: false, width: 200, height: 100, skipTaskbar: true,
        webPreferences: { preload: path.join(__dirname, 'preload-capture.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false }
      });
      this.win.removeMenu();
      this.win.loadFile(path.join(__dirname, 'capture.html'));
      this.win.on('closed', () => { this.win = null; });
    } catch (err) { this.o.log('modo inteligente: ' + err.message); this._finish('no se pudo abrir la captura'); }
  }

  _onHops(ev, d) {
    const s = this.s;
    if (!s || s.done || !this._mine(ev) || !d || !Array.isArray(d.v)) return;
    const n = d.v.length;
    for (let i = 0; i < n; i++) {
      const t = d.at - (n - 1 - i) * 20 - 20;          // hora aproximada de este fragmento de 20 ms
      s.hops.push({ t, v: d.v[i], a: d.a[i] });
    }
    this._maybeAnalyze();
  }

  _toHops() {
    const s = this.s;
    if (s.log.length < 8) return null;
    const c = median(s.log.map((x) => x.c));
    return s.hops.map((h) => ({ p: h.t + c, v: h.v, a: h.a })).filter((h) => h.p >= 0);
  }

  _maybeAnalyze() {
    const s = this.s;
    if (!s || s.done || s.firstLineMs == null || s.hops.length < 100) return;
    const hops = this._toHops();
    if (!hops || !hops.length) return;
    const last = hops[hops.length - 1].p;
    if (last < s.firstLineMs + 1200) return;                  // todavía no hay audio de después de la primera línea
    const res = analyze(hops, s.firstLineMs);
    this.o.log(`modo inteligente: ${JSON.stringify(res)}`);
    const key = s.key;
    if (res.apply && this.o.enabled() && !this.o.hasManual(key)) {
      this.db[key] = { at: Date.now(), applied: true, offsetMs: res.offsetMs, confidence: res.confidence };
      this._save();
      this.o.apply(key, res.offsetMs, res);
      this._finish(`aplicado ${res.offsetMs} ms (confianza ${res.confidence})`);
    } else {
      this.db[key] = { at: Date.now(), applied: false, reason: res.reason || 'sin motivo' };
      this._save();
      this._finish(`sin cambios: ${res.reason || '?'}`);
    }
  }

  _finish(why, silent) {
    const s = this.s;
    this.s = null;
    if (s && !s.done) {
      s.done = true;
      if (!silent) this._set(why);
    } else if (!silent) this._set(why);
    if (this.win && !this.win.isDestroyed()) { try { this.win.destroy(); } catch { /* ya cerrada */ } }
    this.win = null;
  }
}

module.exports = { SmartManager };
