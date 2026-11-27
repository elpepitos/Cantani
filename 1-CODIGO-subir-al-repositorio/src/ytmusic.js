/**
 * Letras sincronizadas de YouTube Music (servicio interno, NO oficial: puede cambiar sin aviso).
 * Flujo: buscar la canción -> pedir su pestaña de letras -> pedir las letras con marcas de tiempo.
 * Cualquier fallo devuelve null y la app usa LRCLIB.
 */
const BASE = 'https://music.youtube.com/youtubei/v1/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const WEB = { clientName: 'WEB_REMIX', clientVersion: '1.20241127.01.00', hl: 'en' };
const ANDROID = { clientName: 'ANDROID_MUSIC', clientVersion: '7.21.50', hl: 'en' };
const SONGS_FILTER = 'EgWKAQIIAWoKEAkQBRAKEAMQBA==';

async function post(endpoint, body, client) {
  const r = await fetch(`${BASE}${endpoint}?prettyPrint=false`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'User-Agent': UA,
      Origin: 'https://music.youtube.com', Referer: 'https://music.youtube.com/', Cookie: 'SOCS=CAI'
    },
    body: JSON.stringify({ context: { client }, ...body }),
    signal: AbortSignal.timeout(9000)
  });
  if (!r.ok) throw new Error('YTM HTTP ' + r.status);
  return r.json();
}

/** Recorre el JSON y llama a cb(clave, valor, padre) en cada nodo. */
function walk(node, cb) {
  if (Array.isArray(node)) { node.forEach((n) => walk(n, cb)); return; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) { cb(k, v, node); walk(v, cb); }
  }
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
const mmss = (t) => { const m = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(t || ''); if (!m) return 0; return m[3] ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : (+m[1]) * 60 + (+m[2]); };

/** Resultados de búsqueda -> [{videoId,title,artists,durationSec}] */
function parseSearch(json) {
  const out = [];
  walk(json, (k, v) => {
    if (k !== 'musicResponsiveListItemRenderer' || !v) return;
    let videoId = null;
    walk(v, (kk, vv) => { if (kk === 'videoId' && typeof vv === 'string' && !videoId) videoId = vv; });
    const cols = (v.flexColumns || []).map((c) => {
      const runs = (((c.musicResponsiveListItemFlexColumnRenderer || {}).text || {}).runs) || [];
      return runs.map((r) => r.text).filter(Boolean);
    });
    const title = (cols[0] || []).join('');
    const rest = (cols[1] || []);
    const dur = rest.map(mmss).filter(Boolean).pop() || 0;
    const artists = rest.filter((x) => x.trim() !== '•' && !/^\d+:\d{2}/.test(x)).join(' ');
    if (videoId && title) out.push({ videoId, title, artists, durationSec: dur });
  });
  return out;
}

/** Elige el resultado que cuadra con la pista (título, artista y duración). */
function pickMatch(results, want, durationSec, tol) {
  const wt = norm(want.title), wa = norm(want.artist).split(' ')[0] || '';
  for (const r of results) {
    const rt = norm(r.title);
    if (!rt || !(rt.includes(wt) || wt.includes(rt))) continue;
    if (wa && !norm(r.artists).includes(wa)) continue;
    if (durationSec && r.durationSec && Math.abs(r.durationSec - durationSec) > tol) continue;
    return r;
  }
  return null;
}

function parseLyricsBrowseId(json) {
  let id = null;
  walk(json, (k, v) => { if (k === 'browseId' && typeof v === 'string' && v.startsWith('MPLY') && !id) id = v; });
  return id;
}

/** Respuesta de letras -> [{t,text}] (o [] si no hay letras con tiempos). */
function parseTimedLyrics(json) {
  let data = null;
  walk(json, (k, v) => { if (k === 'timedLyricsData' && Array.isArray(v) && !data) data = v; });
  if (!data) return [];
  const lines = data.map((d) => ({
    t: Number(((d.cueRange || {}).startTimeMilliseconds)) || 0,
    text: String(d.lyricLine || '').replace(/\s+/g, ' ').trim()
  })).filter((l) => Number.isFinite(l.t));
  lines.sort((a, b) => a.t - b.t);
  return lines.some((l) => l.text) ? lines : [];
}

async function fetchYtmLyrics(track, durationSec, tol) {
  const query = `${track.artist || ''} ${track.title || ''}`.trim();
  const search = await post('search', { query, params: SONGS_FILTER }, WEB);
  const hit = pickMatch(parseSearch(search), track, durationSec, tol);
  if (!hit) return null;
  const next = await post('next', {
    videoId: hit.videoId, isAudioOnly: true, playlistId: 'RDAMVM' + hit.videoId,
    tunerSettingValue: 'AUTOMIX_SETTING_NORMAL', enablePersistentPlaylistPanel: true
  }, WEB);
  const browseId = parseLyricsBrowseId(next);
  if (!browseId) return null;
  const lyr = await post('browse', { browseId }, ANDROID);
  const lines = parseTimedLyrics(lyr);
  if (!lines.length) return null;
  return { lines, approx: false, duration: hit.durationSec || 0, source: 'YouTube Music' };
}

module.exports = { fetchYtmLyrics, parseSearch, pickMatch, parseLyricsBrowseId, parseTimedLyrics, norm };
