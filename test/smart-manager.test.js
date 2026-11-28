// Flujo completo del modo inteligente con un Electron simulado
const assert = require('assert'); const EventEmitter = require('events'); const os = require('os'); const fs = require('fs'); const path = require('path');
const { SmartManager } = require('../src/smart/manager');
const ipcMain = new EventEmitter();
const win = { webContents: {}, isDestroyed() { return !!this.dead; }, destroy() { this.dead = true; }, removeMenu() {}, loadFile() {}, on() {} };
class BW { constructor() { win.dead = false; return win; } }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-'));
let applied = null; const logs = [];
const mgr = new SmartManager({ BrowserWindow: BW, session: { defaultSession: { setDisplayMediaRequestHandler() {} } }, desktopCapturer: {}, ipcMain },
  { dir, log: (m) => logs.push(m), hasManual: () => false, getOffset: () => (applied ? applied[1] : 0), enabled: () => true, apply: (k, ms) => { applied = [k, ms]; } });
let seed = 3; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const lin = (d) => Math.pow(10, d / 20);
const t0 = 1_700_000_000_000, key = 'trueno|feel me';
// canción lenta: la voz entra a 10,0 s (la letra dice 11,3 s: +1300 ms); 10 líneas cada 5 s; cada una suena 3 s (piano suave de fondo)
const lines = []; for (let i = 0; i < 10; i++) lines.push({ t: 11300 + i * 5000, text: 'línea ' + i });
const audioDb = (p) => (lines.some((l) => p >= l.t - 1300 && p < l.t - 1300 + 3000) ? -24 : -50);
mgr.onTrackStart(key);
assert.ok(mgr.s);
mgr.onLyrics(key, lines);
const ev = { sender: win.webContents };
const END = 62000;
for (let tw = 800; tw <= END; tw += 500) {
  for (let q = tw - 500; q < tw; q += 200) if (q >= 0) mgr.onPosition(t0 + q, q + (rnd() - .5) * 60, !(q > 0 && q < 600));   // al principio, un parpadeo "en pausa" (como en el informe real)
  if (tw < 1300) continue;
  const v = [], a = [];
  for (let i = 0; i < 25; i++) { const p = tw - 500 + i * 20; v.push(lin(audioDb(p) + (rnd() - .5))); a.push(lin(audioDb(p) + 3)); }
  ipcMain.emit('smart:hops', ev, { at: t0 + tw + 15, v, a });
}
assert.ok(applied, 'debe aplicar el ajuste del arranque pese al parpadeo de pausa: ' + logs.join(' | ') + ' · ' + mgr.describe());
assert.ok(Math.abs(applied[1] - 1300) <= 150, 'offset ≈ 1300: ' + applied[1]);
assert.ok(mgr.s && !win.dead, 'sigue escuchando para aprender el relleno');
mgr.onTrackStart('otra|cancion');                          // cambio de canción: se cierra y se aprende
const f = mgr.fillsFor(key);
assert.ok(f && f.length >= 7, 'aprende el relleno: ' + (f && f.length) + ' · ' + logs.join(' | '));
f.forEach((x) => { assert.ok(Math.abs(x.dur - 3000) <= 160, 'dur ≈ 3000: ' + x.dur); assert.ok(Math.abs(x.lead) <= 160, 'lead ≈ 0: ' + x.lead); });
console.log('smart-manager OK', applied, f.length, 'líneas');

// Caso "FEEL ME??": la primera línea está en el segundo 0 y la letra va ~4,2 s por delante de la voz
{
  const ipc = new EventEmitter();
  const w = { webContents: {}, isDestroyed() { return !!this.dead; }, destroy() { this.dead = true; }, removeMenu() {}, loadFile() {}, on() {} };
  class BW2 { constructor() { return w; } }
  let ap = null; const lg = [];
  const m = new SmartManager({ BrowserWindow: BW2, session: { defaultSession: { setDisplayMediaRequestHandler() {} } }, desktopCapturer: {}, ipcMain: ipc },
    { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sm2-')), log: (x) => lg.push(x), hasManual: () => false, getOffset: () => (ap ? ap[1] : 0), enabled: () => true, apply: (k, ms) => { ap = [k, ms]; } });
  let sd = 5; const rn = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
  const L = []; let tt = 0;
  for (let i = 0; i < 40; i++) { L.push({ t: tt, text: 'x' + i }); tt += i % 11 === 10 ? 14000 : 2200 + Math.floor(rn() * 3800); }
  const SHIFT = 4200, END2 = tt + 3000, base = 1_700_000_100_000;
  const dbAt = (p) => (L.some((l) => p >= l.t - SHIFT && p < l.t - SHIFT + 1700) ? -25 : -49);
  m.onTrackStart('trueno|feel');
  m.onLyrics('trueno|feel', L);
  for (let tw = 800; tw <= END2 && !ap; tw += 500) {
    for (let q = tw - 500; q < tw; q += 200) if (q >= 0) m.onPosition(base + q, q + (rn() - .5) * 60, true);
    if (tw < 1300) continue;
    const v = [], a = [];
    for (let i = 0; i < 25; i++) { const p = tw - 500 + i * 20; v.push(Math.pow(10, (dbAt(p) + (rn() - .5)) / 20)); a.push(1); }
    ipc.emit('smart:hops', { sender: w.webContents }, { at: base + tw + 15, v, a });
  }
  assert.ok(ap, 'debe alinear con la primera línea en el segundo 0: ' + lg.join(' | ') + ' · ' + m.describe());
  assert.ok(Math.abs(ap[1] - SHIFT) <= 120, 'offset ≈ 4200: ' + ap[1]);
  console.log('alineación completa OK', ap[1]);
}

// Canción rápida: una coincidencia dudosa se aplica a prueba, pero las medidas siguientes la contradicen -> se deshace
{
  const ipc = new EventEmitter();
  const w = { webContents: {}, isDestroyed() { return !!this.dead; }, destroy() { this.dead = true; }, removeMenu() {}, loadFile() {}, on() {} };
  class BW3 { constructor() { w.dead = false; return w; } }
  const hist = []; const lg = [];
  let cur = 0;
  const m = new SmartManager({ BrowserWindow: BW3, session: { defaultSession: { setDisplayMediaRequestHandler() {} } }, desktopCapturer: {}, ipcMain: ipc },
    { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sm3-')), log: (x) => lg.push(x), hasManual: () => false, getOffset: () => cur, enabled: () => true, apply: (k, ms) => { cur = ms; hist.push(ms); } });
  m.onTrackStart('lumi|smoke');
  m.onLyrics('lumi|smoke', [{ t: 0, text: 'a' }]);
  const s = m.s;
  s.applied = { ms: -2000, confidence: 0.5, stable: true };   // ajuste puesto a prueba
  cur = -2000;
  m._verify(s, { offsetMs: 150, z: 6, ratio: 1.5 });          // la medida nueva dice que no hacía falta
  assert.strictEqual(s.doubts, 1);
  assert.strictEqual(cur, -2000, 'una sola duda no deshace');
  m._verify(s, { offsetMs: 120, z: 6, ratio: 1.5 });
  assert.strictEqual(cur, 0, 'dos dudas deshacen el ajuste');
  assert.ok(m.describe().includes('deshecho'), m.describe());
  // y confirmado: dos medidas que coinciden lo dejan fijo
  const s2 = { key: 'k2', applied: { ms: -2340, confidence: 0.6 }, confirms: 0, doubts: 0, needAlign: true, needFills: false, alignHist: [] };
  m.s = s2; cur = -2340;
  m._verify(s2, { offsetMs: -2300, z: 4, ratio: 1.3 });
  m._verify(s2, { offsetMs: -2380, z: 4, ratio: 1.3 });
  assert.strictEqual(cur, -2340, 'se mantiene');
  assert.ok(m.describe().includes('comprobado'), m.describe());
  console.log('verificación y deshacer OK');
}

// Relleno medido en caliente: llega al overlay durante la propia canción
{
  const ipc = new EventEmitter();
  const w = { webContents: {}, isDestroyed() { return !!this.dead; }, destroy() { this.dead = true; }, removeMenu() {}, loadFile() {}, on() {} };
  class BW4 { constructor() { w.dead = false; return w; } }
  const sent = []; const lg = [];
  const m = new SmartManager({ BrowserWindow: BW4, session: { defaultSession: { setDisplayMediaRequestHandler() {} } }, desktopCapturer: {}, ipcMain: ipc },
    { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sm4-')), log: (x) => lg.push(x), hasManual: () => true, getOffset: () => 0, enabled: () => true, apply: () => {}, fills: (k, f) => sent.push(f) });
  let sd = 9; const rn = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
  const L = []; for (let i = 0; i < 24; i++) L.push({ t: 6000 + i * 4000, text: 'linea ' + i });
  const base = 1_700_000_200_000, END = 6000 + 24 * 4000;
  const dbAt = (p) => (L.some((l) => p >= l.t + 200 && p < l.t + 2400) ? -25 : -50);
  m.onTrackStart('slow|song');                      // hasManual: solo toca medir el relleno
  m.onLyrics('slow|song', L);
  for (let tw = 500; tw <= END; tw += 500) {
    for (let q = tw - 500; q < tw; q += 200) if (q >= 0) m.onPosition(base + q, q + (rn() - .5) * 60, true);
    const v = [], a = [];
    for (let i = 0; i < 25; i++) { const p = tw - 500 + i * 20; v.push(Math.pow(10, (dbAt(p) + (rn() - .5)) / 20)); a.push(1); }
    ipc.emit('smart:hops', { sender: w.webContents }, { at: base + tw + 15, v, a });
  }
  assert.ok(sent.length >= 2, 'manda el relleno varias veces durante la canción: ' + sent.length + ' · ' + lg.join(' | '));
  const last = sent[sent.length - 1];
  assert.ok(last.length >= 12, 'aprende muchas líneas: ' + last.length);
  last.forEach((f) => assert.ok(Math.abs(f.dur - 2200) <= 160 && Math.abs(f.lead - 200) <= 160, 'medida ' + JSON.stringify(f)));
  console.log('relleno en vivo OK', sent.map((x) => x.length).join('→'));
}

// Volver a poner la MISMA canción reinicia el análisis, y un resultado no concluyente se reintenta
{
  const ipc = new EventEmitter();
  const w = { webContents: {}, isDestroyed() { return !!this.dead; }, destroy() { this.dead = true; }, removeMenu() {}, loadFile() {}, on() {} };
  class BW5 { constructor() { w.dead = false; return w; } }
  const m = new SmartManager({ BrowserWindow: BW5, session: { defaultSession: { setDisplayMediaRequestHandler() {} } }, desktopCapturer: {}, ipcMain: ipc },
    { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sm5-')), log: () => {}, hasManual: () => false, getOffset: () => 0, enabled: () => true, apply: () => {} });
  const L = [{ t: 1000, text: 'a' }, { t: 5000, text: 'b' }];
  m.onTrackStart('t|x'); m.onLyrics('t|x', L);
  const first = m.s;
  m.onPosition(1, 90000, true);
  m.onPosition(2, 500, true);                       // volvió al principio
  assert.ok(m.s && m.s !== first, 'sesión reiniciada');
  assert.ok(m.s.lines === L, 'conserva la letra tras reiniciar');
  // resultado no concluyente: se vuelve a intentar enseguida
  m.db['t|x'] = { at: Date.now(), applied: false, soft: true, fails: 1, reason: 'no se pudo alinear' };
  m.onTrackStart('t|x');
  assert.ok(m.s && m.s.needAlign, 'reintenta un resultado no concluyente');
  // tras varios intentos fallidos deja de insistir
  m.db['t|x'] = { at: Date.now(), applied: false, soft: true, fails: 3, reason: 'no se pudo alinear' };
  m.onTrackStart('t|x');
  assert.ok(!m.s || !m.s.needAlign, 'deja de insistir tras 3 intentos');
  // resultado firme: no se repite
  m.db['t|x'] = { at: Date.now(), applied: true, offsetMs: -2340 };
  m.onTrackStart('t|x');
  assert.ok(!m.s || !m.s.needAlign, 'no repite un ajuste ya comprobado');
  console.log('reinicio y reintento OK');
}
