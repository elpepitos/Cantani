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
