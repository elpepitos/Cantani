const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { fetchYtmLyrics } = require('./ytmusic');
const UA = 'LyricsOverlay/1.0 (personal desktop overlay)';

const TS = String.raw`(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?`;
const toMs = (m, a = 1) => parseInt(m[a], 10) * 60000 + parseInt(m[a + 1], 10) * 1000 +
  (m[a + 2] ? parseInt(m[a + 2].padEnd(3, '0').slice(0, 3), 10) : 0);

/**
 * LRC -> [{t, text, words?}] ordenado por tiempo.
 *  - respeta la etiqueta [offset:±ms] (positivo = las letras salen antes, como manda el formato)
 *  - si la línea trae marcas por palabra <mm:ss.xx>, devuelve words: [{t, text}] con tiempos reales
 */
function parseLrc(text) {
  const src = String(text || '');
  const offM = /^\[offset:\s*([+-]?\d+)\s*\]/im.exec(src);
  const offset = offM ? parseInt(offM[1], 10) : 0;
  const shift = (t) => Math.max(0, t - offset);
  const lineRe = new RegExp(String.raw`\[${TS}\]`, 'g');
  const wordRe = new RegExp(String.raw`<${TS}>([^<]*)`, 'g');
  const out = [];
  for (const raw of src.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(lineRe)];
    if (!stamps.length) continue;
    const body = raw.replace(/\[[^\]]*\]/g, '');
    const lineText = body.replace(new RegExp(String.raw`<${TS}>`, 'g'), '').replace(/\s+/g, ' ').trim();
    let words = [...body.matchAll(wordRe)]
      .map((m) => ({ t: shift(toMs(m)), text: m[4] }))
      .filter((w) => w.text.trim());
    if (words.length < 2) words = null;
    for (const m of stamps) {
      const entry = { t: shift(toMs(m)), text: lineText };
      if (words) entry.words = words.map((w) => ({ t: w.t, text: w.text }));
      out.push(entry);
    }
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

function cleanArtist(a) {
  return String(a || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').replace(/\s+/g, ' ').trim();
}

function cleanTitle(t) {
  return String(t || '')
    .replace(/\s*[(\[{][^)\]}]*(official|video|audio|lyrics?|letra|visualizer|\bhd\b|\bhq\b|4k|remaster(ed)?|\bmv\b|explicit)[^)\]}]*[)\]}]/gi, '')
    .replace(/\s*[-–|]\s*(official.*|lyrics?.*|letra.*)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Combinaciones artista/título a probar (YouTube suele traer "Artista - Canción" en el título). */
function buildCandidates({ artist, title, app }) {
  const a = cleanArtist(artist);
  const t = cleanTitle(title);
  const list = [{ artist: a, title: t }];
  const isSpotify = /spotify/i.test(app || '');
  const m = t.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m && !isSpotify) list.unshift({ artist: cleanArtist(m[1]), title: cleanTitle(m[2]) });
  const seen = new Set();
  return list.filter((c) => {
    const k = (c.artist + '|' + c.title).toLowerCase();
    if (!c.title || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('LRCLIB HTTP ' + r.status);
  return r.json();
}

function hasSynced(x) {
  return x && typeof x.syncedLyrics === 'string' && x.syncedLyrics.trim().length > 0;
}

async function lrclibGet(c, durationSec, album) {
  const u = new URL('https://lrclib.net/api/get');
  u.searchParams.set('artist_name', c.artist);
  u.searchParams.set('track_name', c.title);
  if (album) u.searchParams.set('album_name', album);
  if (durationSec) u.searchParams.set('duration', String(Math.round(durationSec)));
  const j = await getJson(u);
  return hasSynced(j) ? j : null;
}

async function lrclibSearch(c, durationSec) {
  const u = new URL('https://lrclib.net/api/search');
  u.searchParams.set('track_name', c.title);
  if (c.artist) u.searchParams.set('artist_name', c.artist);
  const arr = await getJson(u);
  if (!Array.isArray(arr)) return null;
  const synced = arr.filter(hasSynced);
  if (!synced.length) return null;
  if (!durationSec) return synced[0];
  synced.sort((a, b) => Math.abs((a.duration || 0) - durationSec) - Math.abs((b.duration || 0) - durationSec));
  return synced[0];
}

/** Fuentes cuya duración es la de la pista (Spotify, Apple Music...), no la de un video. */
function isStrictSource(app) {
  return /spotify|applemusic|deezer|tidal|amazonmusic/i.test(app || '');
}

/**
 * Devuelve { lines: [{t,text}], approx } o null.
 * approx = true cuando la única letra encontrada es de una versión con duración distinta
 * (remix, edición corta...): puede ir desfasada.
 */
async function fetchLyrics(track, cacheDir, mode = 'ytm-first') {
  const durationSec = track.durationMs ? track.durationMs / 1000 : 0;
  const strict = isStrictSource(track.app);
  const tol = strict ? 6 : 25; // en YouTube la duración incluye intros/outros del video
  const key = crypto.createHash('sha1')
    .update(`v5|${mode}|${track.artist}|${track.title}|${Math.round(durationSec / 5)}`.toLowerCase()).digest('hex');
  const cacheFile = cacheDir ? path.join(cacheDir, key + '.json') : null;
  try {
    if (cacheFile && fs.existsSync(cacheFile)) {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (cached && Array.isArray(cached.lines) && cached.duration > 0) return cached;
    }
  } catch { /* caché dañada: se ignora */ }

  let fallback = null;
  const consider = (hit) => {
    if (!hit) return null;
    const lines = parseLrc(hit.syncedLyrics);
    if (!lines.length) return null;
    const diff = durationSec && hit.duration ? Math.abs(hit.duration - durationSec) : 0;
    if (diff <= tol) return { lines, approx: false, duration: hit.duration || 0 };
    if (!fallback || diff < fallback.diff) fallback = { lines, approx: true, diff, duration: hit.duration || 0 };
    return null;
  };
  const save = (result) => {
    try {
      if (cacheFile && !(ytmFailed && result.source !== 'YouTube Music')) {
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify({ lines: result.lines, approx: result.approx, duration: result.duration || 0, source: result.source || 'LRCLIB' }));
      }
    } catch { /* sin caché, no pasa nada */ }
    return { lines: result.lines, approx: result.approx, duration: result.duration || 0, source: result.source || 'LRCLIB', backup: ytmFailed && mode !== 'lrclib' };
  };

  // Hasta 2 intentos. Distingue "no la tiene" (null) de "falló la red/servicio" (ytmFailed):
  // si falló, la letra de respaldo se usa pero NO se guarda en caché, para reintentar YouTube Music la próxima vez.
  let ytmFailed = false;
  const tryYtm = async () => {
    // Se prueba con el título limpio y, en YouTube, con "Artista - Canción" separado del título del video
    for (const c of buildCandidates(track).slice(0, 2)) {
      for (let k = 0; k < 2; k++) {
        try {
          const r = await fetchYtmLyrics({ ...track, artist: c.artist, title: c.title }, durationSec, tol);
          if (r) return r;
          break; // respuesta válida sin coincidencia: no se repite, se prueba el siguiente
        } catch { ytmFailed = true; }
      }
    }
    return null;
  };
  if (mode === 'ytm-first') { const y = await tryYtm(); if (y) return save(y); }

  for (const c of buildCandidates(track)) {
    try {
      const exact = consider(await lrclibGet(c, durationSec, track.album)) ||
                    consider(await lrclibGet(c, strict ? durationSec : 0, '')) ||
                    consider(await lrclibSearch(c, durationSec));
      if (exact) return save(exact);
    } catch { /* red caída o timeout: prueba el siguiente */ }
  }
  if (mode === 'lrclib-first') { const y = await tryYtm(); if (y) return save(y); }
  return fallback ? save(fallback) : null;
}

module.exports = { parseLrc, cleanTitle, cleanArtist, buildCandidates, fetchLyrics, isStrictSource };
