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
