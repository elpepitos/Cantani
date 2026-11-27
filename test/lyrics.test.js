const assert = require('assert');
const { parseLrc, cleanTitle, cleanArtist, buildCandidates, fetchLyrics, isStrictSource } = require('../src/lyrics');
const { OffsetStore } = require('../src/offsets');
const T = require('../src/overlay/timing');
const { PositionTracker } = require('../src/position');
const { Store, DEFAULTS } = require('../src/settings');
const fs = require('fs'), os = require('os'), path = require('path');

// parseLrc: tiempos, múltiples marcas, metadatos, marcas por palabra, orden
const lrc = ['[ar:Alguien]', '[ti:Prueba]', '[00:01.50]uno', '[00:03.00][00:10.25]dos', '[00:05]<00:05.10>tres', '', '[01:00.5]cuatro'].join('\n');
const p = parseLrc(lrc);
assert.deepStrictEqual(p.map((x) => x.t), [1500, 3000, 5000, 10250, 60500]);
assert.deepStrictEqual(p.map((x) => x.text), ['uno', 'dos', 'tres', 'dos', 'cuatro']);
assert.strictEqual(parseLrc('').length, 0);
assert.strictEqual(parseLrc(null).length, 0);

// limpieza de títulos de YouTube
assert.strictEqual(cleanTitle('Canción (Official Video)'), 'Canción');
assert.strictEqual(cleanTitle('Canción [Lyrics]'), 'Canción');
assert.strictEqual(cleanTitle('Canción (feat. Otro)'), 'Canción (feat. Otro)');
assert.strictEqual(cleanTitle('Canción - Official Audio'), 'Canción');
assert.strictEqual(cleanArtist('Artista - Topic'), 'Artista');
assert.strictEqual(cleanArtist('ArtistaVEVO'), 'Artista');

// candidatos: YouTube "Artista - Canción" va primero; Spotify no se parte
let c = buildCandidates({ artist: 'Canal', title: 'Artista - Canción (Official Video)', app: 'chrome.exe' });
assert.deepStrictEqual(c[0], { artist: 'Artista', title: 'Canción' });
assert.strictEqual(c.length, 2);
c = buildCandidates({ artist: 'Artista', title: 'Canción - Remastered 2011', app: 'Spotify.exe' });
assert.strictEqual(c.length, 1);
assert.strictEqual(c[0].title, 'Canción - Remastered 2011');
assert.strictEqual(buildCandidates({ artist: '', title: '' }).length, 0);

// ajustes: persistencia, saneado de tipos, reset
const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lo-')), 's.json');
const s = new Store(f);
assert.deepStrictEqual(s.get(), DEFAULTS);
s.set({ fontSize: 80, hAlign: 'right', fontSize_bad: 1, marginX: 'texto', glow: NaN });
assert.strictEqual(s.get().fontSize, 80);
assert.strictEqual(s.get().hAlign, 'right');
assert.strictEqual(s.get().marginX, DEFAULTS.marginX);
assert.strictEqual(s.get().glow, DEFAULTS.glow);
assert.ok(!('fontSize_bad' in s.get()));
s.flush();
assert.strictEqual(new Store(f).get().fontSize, 80);
s.reset(); s.flush();
assert.deepStrictEqual(new Store(f).get(), DEFAULTS);

// parseLrc: etiqueta [offset] y tiempos por palabra
let q = parseLrc('[offset:+500]\n[00:01.50]uno\n[00:05.00]<00:05.00>ho<00:05.30>la <00:05.60>mundo');
assert.deepStrictEqual(q.map((x) => x.t), [1000, 4500]);
assert.strictEqual(q[1].words.length, 3);
assert.deepStrictEqual(q[1].words.map((w) => w.t), [4500, 4800, 5100]);
assert.strictEqual(q[1].text, 'hola mundo');
assert.strictEqual(q[0].words, undefined);
assert.strictEqual(parseLrc('[offset:-300]\n[00:00.10]a')[0].t, 400);
assert.strictEqual(parseLrc('[offset:+900]\n[00:00.10]a')[0].t, 0); // nunca negativo

// timing: sílabas, pausas en comas/puntos, ritmo, calibración
assert.strictEqual(T.syllables('bonito'), 3);
assert.strictEqual(T.syllables('canción'), 2);
assert.strictEqual(T.syllables('...'), 1);
assert.strictEqual(T.pauseUnits('hola,'), 0.9);
assert.strictEqual(T.pauseUnits('hola.'), 1.8);
assert.strictEqual(T.pauseUnits('hola)."'), 1.8);
assert.strictEqual(T.pauseUnits('hola'), 0);
const lm = T.lineModel('Hola, mundo, esto es largo.');
assert.deepStrictEqual(lm.tokens.map((t) => t.pause), [0.9, 0.9, 0, 0, 0]); // la pausa final no cuenta
// durante la pausa tras la coma, "Hola," ya está lleno y "mundo," aún no ha empezado
const hola = lm.tokens[0], mundo = lm.tokens[1];
const mid = hola.start + hola.len + 0.45; // a mitad de la pausa
assert.strictEqual(T.wordProgress(hola, mid), 1);
assert.strictEqual(T.wordProgress(mundo, mid), 0);
// ritmo por canción: mediana de ms/unidad, con tope y valor por defecto
const mk = (n) => Array.from({ length: n }, (_, i) => ({ t: i * 3000, text: 'una dos tres cuatro cinco seis' }));
const ls = mk(8);
const unitsPerLine = T.lineModel(ls[0].text).total;
assert.ok(Math.abs(T.songPace(ls, ls.map((l) => T.lineModel(l.text))) - 3000 / unitsPerLine) < 1);
assert.strictEqual(T.songPace([{ t: 0, text: 'a' }], [T.lineModel('a')]), 260);
assert.ok(T.fillDuration(2000, 40, 260) <= 2000 * 0.95); // nunca pasa del hueco
assert.ok(T.fillDuration(8000, 5, 260) === 1300);
assert.ok(Math.abs(T.fillDuration(1500, 5, 260) - 1455) < 1);        // cantada de corrido: usa el hueco real        // línea corta tras un hueco largo
// tiempos reales por palabra
const rw = [{ t: 1000, text: 'a' }, { t: 1400, text: 'b' }];
assert.strictEqual(T.realWordProgress(rw, 0, 1200, 3000), 0.5);
assert.strictEqual(T.realWordProgress(rw, 1, 5000, 3000), 1);
// línea más cercana y calibración exacta
const nl = [{ t: 1000, text: 'x' }, { t: 5000, text: '' }, { t: 9000, text: 'y' }];
assert.strictEqual(T.nearestLine(nl, 8700), 2);
assert.strictEqual(T.nearestLine(nl, 5100), 0 + (Math.abs(1000 - 5100) < Math.abs(9000 - 5100) ? 0 : 2)); // ignora líneas vacías
assert.strictEqual(T.nearestLine(nl, 40000), -1);
// pulsé a base=8700 oyendo empezar la línea de 9000 con 180 ms de reacción -> ajuste +480 ms
assert.strictEqual(T.calibratedOffset(9000, 8700), 480);
assert.strictEqual(T.calibratedOffset(9000, -50000), 15000);

// PositionTracker -------------------------------------------------------
const base = 1.7e12; // hora "real" de referencia (ms desde 1970)
const smp = (P, U, playing = true, extra = {}) => ({ positionMs: P, updatedMs: U, playing, durationMs: 300000, ...extra });
{
  // Spotify de escritorio: P quieta, U fija -> se extrapola con la marca
  const t = new PositionTracker();
  assert.strictEqual(t.update(smp(10000, base), base + 100), 10100);
  assert.strictEqual(t.update(smp(10000, base), base + 400), 10400);   // sigue sumando
  assert.strictEqual(t.update(smp(10000, base), base + 3000), 13000);
  // seek: llegan P y U nuevos juntos
  assert.strictEqual(t.update(smp(60000, base + 3100), base + 3300), 60200);
  assert.strictEqual(t.mode, 'marca');
  // pausa: se queda en P
  assert.strictEqual(t.update(smp(61000, base + 4100, false), base + 4300), 61000);
  assert.strictEqual(t.update(smp(61000, base + 4100, false), base + 9000), 61000);
}
{
  // Marca atrasada (el caso de "Fine"): P avanza sola pero U se queda en el inicio de la pista.
  // Antes se sumaba (ahora - U) otra vez y a los 30 s las letras iban por el segundo 60.
  const t = new PositionTracker();
  const U0 = base;                   // marca vieja, nunca cambia
  let realMs = 30000;                // llevamos 30 s de canción
  const now0 = base + 30000;
  const first = t.update(smp(realMs, U0), now0);       // primera lectura: aún no se puede saber
  assert.ok(first > realMs);                           // (error inicial de una sola lectura)
  let last;
  for (let k = 1; k <= 5; k++) {                       // lecturas cada 300 ms: P avanza, U no
    realMs += 300;
    last = t.update(smp(realMs, U0), now0 + k * 300);
  }
  assert.strictEqual(last, realMs);                    // ya corregido: sin doble conteo
  assert.strictEqual(t.mode, 'viva');
  // y se mantiene exacto durante 60 s
  for (let k = 6; k <= 200; k++) { realMs += 300; last = t.update(smp(realMs, U0), now0 + k * 300); }
  assert.strictEqual(last, realMs);
}
{
  // Reanudar tras una pausa: no debe saltar
  const t = new PositionTracker();
  t.update(smp(20000, base, false), base + 100);
  assert.strictEqual(t.update(smp(20000, base, true), base + 5000), 20000); // acaba de reanudar
  assert.strictEqual(t.update(smp(20000, base, true), base + 5500), 20500);
  // sin duración conocida y límite por duración
  const t2 = new PositionTracker();
  assert.strictEqual(t2.update({ positionMs: 299000, updatedMs: base, playing: true, durationMs: 300000 }, base + 5000), 300000);
}

// Tras cambiar de canción, Windows aún entrega la posición y marca de la canción anterior
{
  const t = new PositionTracker();
  const stale = { positionMs: 190000, updatedMs: base - 600000, playing: true, durationMs: 149466 };
  const ctx = { hadPrevious: true, sinceChangeMs: 400 };
  const p1 = t.update(stale, base, ctx);
  assert.ok(p1 < 2000, 'no debe saltar al final de la canción: ' + p1);
  const p2 = t.update(stale, base + 1000, { ...ctx, sinceChangeMs: 1400 });
  assert.ok(p2 >= 1000 && p2 < 3000, 'sigue contando desde el inicio: ' + p2);
  // llega la lectura buena (P≈0, marca de ahora): se acepta
  const p3 = t.update({ positionMs: 800, updatedMs: base + 1500, playing: true, durationMs: 149466 }, base + 1600, { ...ctx, sinceChangeMs: 2000 });
  assert.ok(Math.abs(p3 - 900) < 50, 'acepta la medida nueva: ' + p3);
  // un salto legítimo (adelantar la canción) justo después también se acepta
  const p4 = t.update({ positionMs: 90000, updatedMs: base + 2500, playing: true, durationMs: 149466 }, base + 2600, { ...ctx, sinceChangeMs: 3000 });
  assert.ok(Math.abs(p4 - 90100) < 50);
  // Sin cambio previo y marca imposible (más allá del final): no se queda pegada al final
  const t2 = new PositionTracker();
  const p5 = t2.update({ positionMs: 5000, updatedMs: base - 900000, playing: true, durationMs: 149466 }, base, { hadPrevious: false, sinceChangeMs: 0 });
  assert.strictEqual(p5, 5000);
}

// OffsetStore.learned
{
  const os = require('../src/offsets');
  const st = new os.OffsetStore('/tmp/_x_offsets.json'); st.map = { a: 300 };
  assert.strictEqual(st.learned(), 0);               // pocos datos: no aprende
  st.map = { a: 300, b: 500, c: 400, d: 9000 };
  assert.strictEqual(st.learned(), 450);             // mediana, robusta a un valor raro
  assert.ok(st.has('a') && !st.has('z'));
}

// YouTube Music (con respuestas simuladas; el formato real no se pudo comprobar desde aquí)
{
  const Y = require('../src/ytmusic');
  const search = { contents: [{ musicResponsiveListItemRenderer: {
    playlistItemData: { videoId: 'abc123' },
    flexColumns: [
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Fine' }] } } },
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Song' }, { text: ' • ' }, { text: 'Lemon Demon' }, { text: ' • ' }, { text: 'Dinosaurchestra' }, { text: ' • ' }, { text: '4:40' }] } } }
    ] } }] };
  const res = Y.parseSearch(search);
  assert.strictEqual(res.length, 1); assert.strictEqual(res[0].videoId, 'abc123'); assert.strictEqual(res[0].durationSec, 280);
  assert.ok(Y.pickMatch(res, { title: 'Fine', artist: 'Lemon Demon' }, 280, 6));
  assert.strictEqual(Y.pickMatch(res, { title: 'Fine', artist: 'Lemon Demon' }, 250, 6), null);   // otra duración
  assert.strictEqual(Y.pickMatch(res, { title: 'Fine', artist: 'Otro Artista' }, 280, 6), null);
  assert.strictEqual(Y.parseLyricsBrowseId({ a: [{ tabRenderer: { endpoint: { browseEndpoint: { browseId: 'MPLYt_xyz' } } } }] }), 'MPLYt_xyz');
  const lyr = { contents: { elementRenderer: { newElement: { type: { componentType: { model: { timedLyricsModel: { lyricsData: { timedLyricsData: [
    { lyricLine: 'Today has a way', cueRange: { startTimeMilliseconds: '61000' } }, { lyricLine: '(One, two)', cueRange: { startTimeMilliseconds: '58000' } } ] } } } } } } } } };
  const ln = Y.parseTimedLyrics(lyr);
  assert.deepStrictEqual(ln.map((l) => l.t), [58000, 61000]);
  assert.deepStrictEqual(Y.parseTimedLyrics({ nada: 1 }), []);
}

// localPaces: estrofa lenta (400 ms/unidad) y estribillo rápido (200 ms/unidad)
{
  const mk = (n, t0, gap) => Array.from({ length: n }, (_, i) => ({ t: t0 + i * gap, text: 'la la la la la la la la' }));
  const lines = [...mk(8, 0, 3200), ...mk(8, 40000, 1600)];
  const models = lines.map((l) => T.lineModel(l.text));
  const g = T.songPace(lines, models);
  const lp = T.localPaces(lines, models, g);
  assert.ok(lp[1] > lp[13], 'la zona lenta tiene más ms/unidad que la rápida');
  assert.strictEqual(lp.length, lines.length);
}

// cleanIntro
{
  const L = [{t:40800,text:'(One, two, three, four)'},{t:44000,text:'♪'},{t:60000,text:'Today has a way of scarring'},{t:90000,text:'♪'},{t:95000,text:'Otra línea (bis)'}];
  const r = T.cleanIntro(L);
  assert.deepStrictEqual(r.map((l) => l.t), [60000, 90000, 95000]);
}

// isStrictSource
assert.ok(isStrictSource('Spotify.exe'));
assert.ok(isStrictSource('SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify'));
assert.ok(!isStrictSource('chrome.exe'));

// OffsetStore: persistencia, clave normalizada y borrado al volver a 0
const of = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'of-')), 'o.json');
const os1 = new OffsetStore(of);
const k = OffsetStore.keyFor('24kGoldn', 'CITY OF ANGELS (Sero Remix)');
assert.strictEqual(os1.get(k), 0);
os1.set(k, 750); os1.flush();
assert.strictEqual(new OffsetStore(of).get(OffsetStore.keyFor('24KGOLDN', 'city of angels (sero remix)')), 750);
os1.set(k, 0); os1.flush();
assert.strictEqual(new OffsetStore(of).get(k), 0);

// fetchLyrics con LRCLIB simulado: versión exacta, versión aproximada y sin resultados
const LRC = '[00:01.00]hola\n[00:05.00]mundo';
const mkRes = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });
async function withFetch(handler, fn) {
  const real = global.fetch; global.fetch = async (u) => handler(new URL(String(u)));
  try { return await fn(); } finally { global.fetch = real; }
}
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-'));
  // 1) Spotify, la búsqueda trae dos versiones: debe elegir la de duración 200 y marcarla exacta
  let r = await withFetch((u) => {
    if (u.pathname.endsWith('/get')) return mkRes(null, 404);
    return mkRes([{ duration: 245, syncedLyrics: '[00:09.00]remix' }, { duration: 200, syncedLyrics: LRC }]);
  }, () => fetchLyrics({ artist: 'A', title: 'B', album: '', app: 'Spotify.exe', durationMs: 200000 }, path.join(tmp, '1')));
  assert.strictEqual(r.approx, false);
  assert.strictEqual(r.lines[0].text, 'hola');
  // 2) Spotify, solo existe una versión de 245 s para una pista de 200 s: se usa pero se marca aproximada
  r = await withFetch((u) => u.pathname.endsWith('/get') ? mkRes(null, 404) : mkRes([{ duration: 245, syncedLyrics: LRC }]),
    () => fetchLyrics({ artist: 'A', title: 'C', album: '', app: 'Spotify.exe', durationMs: 200000 }, path.join(tmp, '2')));
  assert.strictEqual(r.approx, true);
  // 3) YouTube: 20 s de diferencia es normal (intro del video), no se marca aproximada
  r = await withFetch((u) => u.pathname.endsWith('/get') ? mkRes(null, 404) : mkRes([{ duration: 220, syncedLyrics: LRC }]),
    () => fetchLyrics({ artist: 'A', title: 'D', album: '', app: 'chrome.exe', durationMs: 240000 }, path.join(tmp, '3')));
  assert.strictEqual(r.approx, false);
  // 4) Sin resultados
  r = await withFetch(() => mkRes([]), () => fetchLyrics({ artist: 'A', title: 'E', album: '', app: 'Spotify.exe', durationMs: 200000 }, path.join(tmp, '4')));
  assert.strictEqual(r, null);
  // 5) Segunda llamada sale de la caché sin tocar la red
  r = await withFetch(() => { throw new Error('no debería haber red'); }, () => fetchLyrics({ artist: 'A', title: 'B', album: '', app: 'Spotify.exe', durationMs: 200000 }, path.join(tmp, '1')));
  assert.strictEqual(r.lines[0].text, 'hola');
  console.log('OK: todas las pruebas pasaron');
})().catch((e) => { console.error(e); process.exit(1); });
