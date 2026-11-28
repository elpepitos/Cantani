/**
 * Modo inteligente (experimental, desactivado por defecto). Escucha el audio del sistema mientras suena una canción nueva y:
 *  1) busca cuándo entra la voz y, si está MUY seguro, ajusta la sincronía de ESA canción (nunca pisa un ajuste a mano);
 *  2) aprende cuándo empieza y termina de cantarse cada línea, para que el relleno karaoke siga a la voz real
 *     (útil sobre todo en canciones lentas). Lo aprendido se guarda y se usa las próximas veces que suene.
 */
const fs = require('fs');
const path = require('path');
const { analyze, learnFills, alignByCorrelation, stableAlignment, median } = require('./onset');

const OFFSET_STAGE_MS = 45000;           // tiempo máximo para el ajuste rápido del arranque
const ALIGN_STAGE_MS = 170000;           // tiempo máximo para alinear toda la letra con el audio
const MAX_CAPTURE_MS = 12 * 60 * 1000;   // tope de seguridad por canción
const RETRY_AFTER_MS = 7 * 24 * 3600 * 1000;
const GOOD_COVERAGE = 0.7;               // si ya hay tanto aprendido, no se vuelve a escuchar
const MIN_FILL_COVERAGE = 0.5;           // por debajo de esto el relleno medido no es fiable: se usa el de siempre
const MIN_FILL_LINES = 8;
const VERIFY_TOL_MS = 400;               // cuánto puede variar una medición posterior sin considerarse contradicción

class SmartManager {
  /**
   * electron: { BrowserWindow, session, desktopCapturer, ipcMain }
   * opts: { dir, log(msg), hasManual(key), getOffset(key), apply(key, ms, info), enabled() }
   */
  constructor(electron, opts) {
    this.e = electron; this.o = opts;
    this.file = path.join(opts.dir, 'smart-analysis-v3.json');
    this.fillsFile = path.join(opts.dir, 'smart-fills-v3.json');
    this.db = this._load(this.file);
    this.fills = this._load(this.fillsFile);
    this.win = null;
    this.s = null;
    this.offsetNote = ''; this.learnNote = ''; this.status = 'inactivo';
    this.handlerSet = false;
    const ipc = electron.ipcMain;
    ipc.on('smart:hops', (ev, d) => this._onHops(ev, d));
    ipc.on('smart:ready', (ev) => { if (this._mine(ev)) this.status = 'escuchando'; });
    ipc.on('smart:error', (ev, m) => {
      if (!this._mine(ev)) return;
      this.o.log('modo inteligente: ' + m);
      // Algunas versiones de Windows no dan el audio sin conceder también la pantalla: se reintenta una vez así
      if (!this.withVideo) { this.withVideo = true; this.handlerSet = false; this._close(); this._openWindow(); return; }
      this.status = 'error: ' + m; this._close(); this.s = null;
    });
  }

  _load(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch { return {}; } }
  _save(f, obj) { try { fs.writeFileSync(f, JSON.stringify(obj)); } catch { /* sin permisos */ } }
  _mine(ev) { return this.win && !this.win.isDestroyed() && ev.sender === this.win.webContents; }

  describe() {
    const parts = [this.o.enabled() ? 'activado' : 'desactivado', this.status];
    if (this.offsetNote) parts.push('arranque: ' + this.offsetNote);
    if (this.learnNote) parts.push('relleno: ' + this.learnNote);
    return parts.join(' · ');
  }

  /** Relleno aprendido de esta canción (solo con el modo activado). */
  fillsFor(key) {
    if (!this.o.enabled() || !key) return null;
    const f = this.fills[key];
    if (!f || !f.fills || f.fills.length < MIN_FILL_LINES || f.coverage < MIN_FILL_COVERAGE) return null;
    return f.fills;
  }

  /** Canción nueva: cierra (y aprende de) la anterior y decide si merece la pena escuchar esta. */
  onTrackStart(key) {
    this._finish();
    this.offsetNote = ''; this.learnNote = '';
    if (!this.o.enabled() || !key) { this.status = this.o.enabled() ? 'sin canción' : 'inactivo'; return; }
    const prev = this.db[key];
    const needOffset = !this.o.hasManual(key) && !(prev && Date.now() - prev.at < RETRY_AFTER_MS);
    const f = this.fills[key];
    const needFills = !(f && f.coverage >= GOOD_COVERAGE && f.fills.length >= MIN_FILL_LINES);
    if (prev) this.offsetNote = prev.applied ? `${prev.offsetMs} ms (ya analizada)` : `sin cambios (${prev.reason})`;
    else if (this.o.hasManual(key)) this.offsetNote = 'omitido (ajuste a mano)';
    if (f) this.learnNote = `${f.fills.length} líneas aprendidas (${Math.round(f.coverage * 100)} %)`;
    if (!needOffset && !needFills) { this.status = 'canción ya aprendida'; return; }
    this.s = { key, startedAt: Date.now(), hops: [], log: [], lines: null, firstLineMs: null, needOffset, needAlign: needOffset, alignedAt: 0, alignHist: [], applied: null, confirms: 0, doubts: 0, needFills, done: false };
    this.status = 'arrancando captura';
    this._openWindow();
  }

  /** Letras listas (ya sin la intro que no se canta). */
  onLyrics(key, lines) {
    const s = this.s;
    if (!s || s.key !== key) return;
    s.lines = lines || [];
    const first = s.lines.find((l) => l.text && /[\p{L}\p{N}]/u.test(l.text));
    s.firstLineMs = first ? first.t : null;
    if (s.needOffset && (s.firstLineMs == null || s.firstLineMs > 40000)) s.needOffset = false;   // sin primera línea útil: solo la alineación completa
    this._maybeAnalyzeOffset();
    this._checkDone();
  }

  /** Posición de la canción en cada lectura: sirve para pasar la hora de cada fragmento de audio a posición de la canción. */
  onPosition(now, posMs, playing) {
    const s = this.s;
    if (!s || s.done) return;
    s.log.push({ t: now, c: posMs - now, pl: !!playing });
    if (s.log.length > 4000) s.log.shift();
    if (s.needOffset && playing) {                      // un salto de posición estropea solo el ajuste rápido del arranque
      const recent = s.log.filter((x) => x.pl).slice(-12);
      if (recent.length >= 10) {
        const c = median(recent.map((x) => x.c));
        if (Math.abs(recent[recent.length - 1].c - c) > 1500) s.needOffset = false;
      }
    }
    if (s.needOffset && now - s.startedAt > OFFSET_STAGE_MS) s.needOffset = false;
    if (s.needAlign && now - s.startedAt > ALIGN_STAGE_MS) this._giveUpAlign();
    if (now - s.startedAt > MAX_CAPTURE_MS) this._finish();
    else this._checkDone();
  }

  stop() { this._finish(); }

  // ---- interno ----
  _checkDone() {
    const s = this.s;
    if (s && !s.done && !s.needOffset && !s.needAlign && !s.needFills) this._finish();
  }

  _openWindow() {
    const { BrowserWindow, session } = this.e;
    if (!this.s) return;
    if (!this.handlerSet) {
      this.handlerSet = true;
      session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
        try {
          if (!this.withVideo) { cb({ audio: 'loopback' }); return; }   // solo audio: no se captura la pantalla
          const src = await this.e.desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
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
    } catch (err) { this.o.log('modo inteligente: ' + err.message); this.status = 'no se pudo abrir la captura'; this.s = null; }
  }

  _close() {
    if (this.win && !this.win.isDestroyed()) { try { this.win.destroy(); } catch { /* ya cerrada */ } }
    this.win = null;
  }

  _onHops(ev, d) {
    const s = this.s;
    if (!s || s.done || !this._mine(ev) || !d || !Array.isArray(d.v)) return;
    const n = d.v.length;
    for (let i = 0; i < n; i++) s.hops.push({ t: d.at - (n - 1 - i) * 20 - 20, v: d.v[i], a: d.a[i] });
    this._maybeAnalyzeOffset();
  }

  /** Desfase constante (posición de la canción - hora de pared) cerca de la hora t, solo con lecturas en reproducción. */
  _cAt(log, t) {
    let lo = 0, hi = log.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (log[m].t < t) lo = m + 1; else hi = m; }
    const v = [];
    for (let i = lo - 1; i >= 0 && t - log[i].t <= 1500; i--) if (log[i].pl) v.push(log[i].c);
    for (let i = lo; i < log.length && log[i].t - t <= 1500; i++) if (log[i].pl) v.push(log[i].c);
    return v.length >= 3 ? median(v) : null;
  }

  _toHops(s) {
    const out = [];
    for (const h of s.hops) {
      const c = this._cAt(s.log, h.t);
      if (c == null) continue;
      const p = h.t + c;
      if (p >= 0) out.push({ p, v: h.v, a: h.a });
    }
    return out;
  }

  _giveUpAlign() {
    const s = this.s;
    if (!s || !s.needAlign) return;
    s.needAlign = false; s.needOffset = false;
    if (!this.db[s.key]) { this.db[s.key] = { at: Date.now(), applied: false, reason: 'no se pudo alinear' }; this._save(this.file, this.db); }
    if (!this.offsetNote) this.offsetNote = 'sin cambios (no se pudo alinear)';
  }

  _decide(s, rec, note) {
    s.needOffset = false; s.needAlign = false;
    this.db[s.key] = { at: Date.now(), ...rec };
    this._save(this.file, this.db);
    this.offsetNote = note;
    this.status = s.needFills ? 'aprendiendo el relleno' : 'terminado';
  }

  _maybeAnalyzeOffset() {
    const s = this.s;
    if (!s || s.done || !(s.needOffset || s.needAlign) || !s.lines || s.hops.length < 100 || s.log.length < 8) return;
    const live = this.o.enabled() && !this.o.hasManual(s.key);
    // 1) Ajuste rápido: entrada de la voz frente a la primera línea (solo si hay calma antes de cantar)
    if (s.needOffset && s.firstLineMs != null) {
      const hops = this._toHops(s);
      if (hops.length && hops[hops.length - 1].p >= s.firstLineMs + 1200) {
        const res = analyze(hops, s.firstLineMs);
        this.o.log(`modo inteligente (arranque): ${JSON.stringify(res)}`);
        s.needOffset = false;
        if (res.apply && live) { this.o.apply(s.key, res.offsetMs, res); this._decide(s, { applied: true, offsetMs: res.offsetMs, confidence: res.confidence }, `aplicado ${res.offsetMs} ms (confianza ${res.confidence})`); return; }
        if (res.reason === 'ya va bien') { this._decide(s, { applied: false, reason: 'ya va bien' }, 'sin cambios (ya iba bien)'); return; }
      }
    }
    // 2) Alineación de toda la letra con las entradas de voz (cada ~10 s de audio nuevo, a partir de 45 s)
    if (s.needAlign && s.hops.length - s.alignedAt >= 500 && s.hops.length >= 2250) {
      s.alignedAt = s.hops.length;
      const hops = this._toHops(s);
      const res = alignByCorrelation(hops, s.lines);
      this.o.log(`modo inteligente (alineación): ${JSON.stringify(res)}`);
      if (s.applied) { this._verify(s, res); return; }
      if (Number.isFinite(res.offsetMs) && Number.isFinite(res.z)) s.alignHist.push({ offsetMs: res.offsetMs, z: res.z, ratio: res.ratio });
      const rep = res.apply ? res : stableAlignment(s.alignHist);          // una pasada clara, o varias pasadas que coinciden
      if (rep && rep.apply && live) {
        // Se aplica EN PRUEBAS: las siguientes mediciones, con más audio, tienen que confirmarlo o se deshace.
        s.applied = { ms: rep.offsetMs, confidence: rep.confidence, stable: !!rep.stable };
        this.o.apply(s.key, rep.offsetMs, rep);
        this.offsetNote = `probando ${rep.offsetMs} ms (confianza ${rep.confidence})`;
        this.status = 'comprobando el ajuste';
        return;
      }
      if (res.reason === 'ya va bien') { this._decide(s, { applied: false, reason: 'ya va bien' }, 'sin cambios (ya iba bien)'); return; }
      this.offsetNote = `buscando… (${res.reason || 'sin datos'})`;
    }
  }

  /**
   * Comprueba un ajuste ya aplicado con audio nuevo. Dos mediciones que lo contradigan lo deshacen:
   * así una coincidencia casual no deja una canción peor de como estaba.
   */
  _verify(s, res) {
    const ap = s.applied;
    if (this.o.getOffset(s.key) !== ap.ms) { s.needAlign = false; this.offsetNote = `aplicado ${ap.ms} ms (lo cambiaste tú)`; return; }  // el usuario lo tocó: no se insiste
    if (!Number.isFinite(res.offsetMs) || !Number.isFinite(res.z)) return;
    if (Math.abs(res.offsetMs - ap.ms) <= VERIFY_TOL_MS) {
      s.confirms++; s.doubts = 0;
      this.offsetNote = `aplicado ${ap.ms} ms (confirmado ${s.confirms}/2)`;
      if (s.confirms >= 2) this._decide(s, { applied: true, offsetMs: ap.ms, confidence: ap.confidence }, `aplicado ${ap.ms} ms (comprobado)`);
      return;
    }
    s.doubts++;
    this.offsetNote = `comprobando… (la nueva medida dice ${res.offsetMs} ms)`;
    if (s.doubts >= 2) {
      this.o.apply(s.key, 0, { revert: true });
      s.applied = null;
      this._decide(s, { applied: false, reason: 'medidas contradictorias' }, 'deshecho (las medidas no coincidían)');
    }
  }

  /** Cierra la sesión: si se estaba aprendiendo el relleno, analiza ahora lo escuchado y lo guarda. */
  _finish() {
    const s = this.s;
    this.s = null;
    if (s && !s.done) {
      s.done = true;
      try {
        if (s.needFills && s.lines && s.lines.length && s.hops.length > 400 && s.log.length > 20) {
          const hops = this._toHops(s);
          const r = learnFills(hops, s.lines, this.o.getOffset(s.key));
          const old = this.fills[s.key];
          this.o.log(`modo inteligente (relleno): ${r.fills.length}/${r.singable} líneas`);
          if (r.fills.length >= MIN_FILL_LINES && r.coverage >= MIN_FILL_COVERAGE && (!old || r.coverage > old.coverage)) {
            this.fills[s.key] = { at: Date.now(), coverage: +r.coverage.toFixed(2), fills: r.fills };
            this._save(this.fillsFile, this.fills);
            this.learnNote = `${r.fills.length} líneas aprendidas (${Math.round(r.coverage * 100)} %)`;
          } else if (!old) {
            this.learnNote = `no se pudo aprender (${r.fills.length}/${r.singable} líneas claras)`;
          }
        }
      } catch (err) { this.o.log('modo inteligente (relleno) falló: ' + err.message); }
      this.status = 'terminado';
    }
    this._close();
  }
}

module.exports = { SmartManager };
