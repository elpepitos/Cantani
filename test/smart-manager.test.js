// Modo inteligente de principio a fin, con canciones simuladas (audio sintético con la respuesta conocida).
const assert = require('assert'); const EventEmitter = require('events'); const os = require('os'); const fs = require('fs'); const path = require('path');
const { SmartManager } = require('../src/smart/manager');
const { mk } = require('./sim-audio');

function correr(opt, cfg = {}) {
  const ipc = new EventEmitter();
  const win = { webContents: {}, isDestroyed() { return !!this.dead; }, destroy() { this.dead = true; }, removeMenu() {}, loadFile() {}, on() {} };
  class BW { constructor() { win.dead = false; return win; } }
  const logs = []; const fills = []; let off = 0;
  const mgr = new SmartManager({ BrowserWindow: BW, session: { defaultSession: { setDisplayMediaRequestHandler() {} } }, desktopCapturer: {}, ipcMain: ipc },
    { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'smx-')), log: (x) => logs.push(x),
      hasManual: () => !!cfg.manual, getOffset: () => off, enabled: () => true,
      apply: (k, ms) => { off = ms; }, fills: (k, f) => fills.push(f) });
  const r = mk(opt);
  const lines = cfg.lines ? cfg.lines(r) : r.lines;
  mgr.onTrackStart('k|' + (opt.seed || 1));
  mgr.onLyrics('k|' + (opt.seed || 1), lines);
  const base = 1_700_000_000_000;
  const porLote = 25;                                  // el medidor manda 25 valores (0,5 s) cada vez
  for (let i = 0; i + porLote <= r.hops.length; i += porLote) {
    const t0 = r.hops[i].p;
    for (let q = t0; q < t0 + 500; q += 200) mgr.onPosition(base + q, q, true);
    const trozo = r.hops.slice(i, i + porLote);
    ipc.emit('smart:hops', { sender: win.webContents }, { at: base + trozo[trozo.length - 1].p + 20, v: trozo.map((h) => h.v), a: trozo.map((h) => h.a) });
  }
  return { mgr, off, fills, logs, verdad: r };
}

// 1) Canción con orquesta densa y la letra 3,5 s adelantada: debe corregirla sola
{
  const { mgr, off, fills, logs } = correr({ instr: 'denso', shift: 3500, seed: 1 });
  assert.ok(Math.abs(off - 3500) <= 250, 'corrige el desfase: ' + off + ' · ' + logs.slice(-2).join(' | '));
  assert.ok(mgr.describe().includes('comprobado') || mgr.describe().includes('probando'), mgr.describe());
  assert.ok(fills.length >= 1 && fills[fills.length - 1].length >= 20, 'mide el relleno de las líneas: ' + (fills[0] || []).length);
  const f = fills[fills.length - 1];
  f.forEach((x) => { assert.ok(Math.abs(x.lead) <= 400, 'lead pequeño tras corregir: ' + x.lead); assert.ok(x.dur >= 800 && x.dur <= 3200, 'duración medida: ' + x.dur); });
}

// 2) Canción lenta con pausas largas: el relleno medido debe ser más corto que el hueco
{
  const { off, fills, verdad } = correr({ instr: 'suave', shift: 1500, seed: 2, lineGap: [3800, 6000], voiceLen: [1400, 2200] });
  assert.ok(Math.abs(off - 1500) <= 250, 'corrige: ' + off);
  const f = fills[fills.length - 1];
  assert.ok(f.length >= 20, 'mide muchas líneas: ' + f.length);
  const medias = f.map((x) => x.dur).reduce((a, b) => a + b, 0) / f.length;
  assert.ok(medias < 3000, 'el relleno medido no llega hasta la línea siguiente: ' + Math.round(medias));
  void verdad;
}

// 3) Canción rápida ya bien sincronizada: no debe tocar nada
{
  const { off } = correr({ instr: 'denso', shift: 0, seed: 3, lineGap: [1500, 2100], voiceLen: [1200, 1800] });
  assert.ok(Math.abs(off) <= 200, 'no mueve una canción que ya va bien: ' + off);
}

// 4) Letra que no corresponde a la canción: no debe inventarse un ajuste
{
  let s = 7; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const { off } = correr({ instr: 'denso', shift: 0, seed: 4 },
    { lines: (r) => r.lines.map((l, i) => ({ t: Math.floor(rnd() * 170000), text: 'x' + i })).sort((a, b) => a.t - b.t) });
  assert.strictEqual(off, 0, 'no aplica nada con una letra equivocada: ' + off);
}

// 5) Si el usuario ya ajustó la canción a mano, no se le pisa
{
  const { off } = correr({ instr: 'suave', shift: 2500, seed: 5 }, { manual: true });
  assert.strictEqual(off, 0, 'respeta el ajuste a mano: ' + off);
}

console.log('modo inteligente: 5 escenarios OK');

// Un ajuste puesto a prueba se deshace si las medidas siguientes lo contradicen
{
  const ipc = new EventEmitter();
  const w = { webContents: {}, isDestroyed() { return !!this.dead; }, destroy() { this.dead = true; }, removeMenu() {}, loadFile() {}, on() {} };
  class BW { constructor() { w.dead = false; return w; } }
  let cur = 0;
  const m = new SmartManager({ BrowserWindow: BW, session: { defaultSession: { setDisplayMediaRequestHandler() {} } }, desktopCapturer: {}, ipcMain: ipc },
    { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'smv-')), log: () => {}, hasManual: () => false, getOffset: () => cur, enabled: () => true, apply: (k, ms) => { cur = ms; } });
  m.onTrackStart('a|b'); m.onLyrics('a|b', [{ t: 0, text: 'a' }]);
  const s = m.s; s.applied = { ms: -2000, confidence: 0.5 }; cur = -2000;
  m._verify(s, { offsetMs: 150, z: 6, ratio: 1.5 });
  assert.strictEqual(cur, -2000, 'una sola duda no deshace');
  m._verify(s, { offsetMs: 120, z: 6, ratio: 1.5 });
  assert.strictEqual(cur, 0, 'dos dudas deshacen el ajuste');

  // repetir la MISMA canción reinicia el análisis
  m.onTrackStart('c|d'); m.onLyrics('c|d', [{ t: 1000, text: 'a' }, { t: 5000, text: 'b' }]);
  const first = m.s;
  m.onPosition(1, 90000, true); m.onPosition(2, 500, true);
  assert.ok(m.s && m.s !== first, 'sesión reiniciada al repetir la canción');
  // un resultado no firme se reintenta; uno firme no
  m.db['c|d'] = { at: Date.now(), applied: false, fails: 1, reason: 'no se pudo alinear' };
  m.onTrackStart('c|d');
  assert.ok(m.s && m.s.needAlign, 'reintenta un resultado no concluyente');
  m.db['c|d'] = { at: Date.now(), applied: true, offsetMs: -2340 };
  m.onTrackStart('c|d');
  assert.ok(!m.s || !m.s.needAlign, 'no repite un ajuste ya comprobado');
  console.log('seguridad (deshacer, reinicio, reintento): OK');
}
