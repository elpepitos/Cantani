/**
 * Alineación por TRAMOS DE VOZ (método principal del modo inteligente).
 *
 * En vez de correlacionar energías, primero detecta los tramos en que alguien canta y luego empareja esa
 * secuencia con la secuencia de líneas de la letra. Eso es mucho más firme en música densa, permite que el
 * desfase cambie a lo largo de la canción y, de paso, da la duración real de cada línea para el karaoke.
 */
const DB = (x) => 20 * Math.log10(x + 1e-5);

const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pctl = (a, q) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))]; };

/** Media móvil centrada de n puntos. */
function smooth(arr, n) {
  const out = new Array(arr.length); const h = n >> 1;
  let acc = 0;
  for (let i = 0; i < arr.length + h; i++) {
    if (i < arr.length) acc += arr[i];
    if (i - n >= 0) acc -= arr[i - n];
    if (i >= h) out[i - h] = acc / Math.min(n, i + 1);
  }
  return out;
}

/**
 * Tramos en que se oye voz. Usa dos pistas a la vez: el nivel en la banda de la voz y qué proporción del
 * sonido total está en esa banda (una orquesta llena todo el espectro; una voz se concentra en su banda).
 */
function voiceSegments(hops, opt = {}) {
  const o = { smoothMs: 60, minMs: 300, mergeMs: 150, wLvl: 0.6, wPres: 0.4, ...opt };
  if (!hops || hops.length < 200) return [];
  const step = Math.max(1, Math.round((hops[hops.length - 1].p - hops[0].p) / (hops.length - 1))) || 20;
  const n = Math.max(3, Math.round(o.smoothMs / step));
  const lvl = smooth(hops.map((h) => DB(h.v)), n);
  const pres = smooth(hops.map((h) => DB(h.v) - DB(h.a)), n);
  const zs = (arr) => {
    const med = median(arr);
    const mad = median(arr.map((x) => Math.abs(x - med))) || 1e-6;
    return arr.map((x) => (x - med) / (1.4826 * mad));
  };
  const zl = zs(lvl), zp = zs(pres);
  const score = zl.map((x, i) => o.wLvl * x + o.wPres * zp[i]);
  // Umbral automático (Otsu): separa el sonido en dos grupos (con voz / sin voz) sin suponer cuánto se canta.
  // Un percentil fijo fallaba en canciones rápidas, donde la voz ocupa casi todo el tiempo.
  const lo0 = Math.min(...score), hi0 = Math.max(...score), B = 256;
  const hist = new Float64Array(B);
  for (const x of score) hist[Math.min(B - 1, Math.floor(((x - lo0) / (hi0 - lo0 || 1)) * B))]++;
  let total = score.length, sumAll = 0;
  for (let i = 0; i < B; i++) sumAll += i * hist[i];
  let wB = 0, sumB = 0, bestVar = -1, thrBin = B >> 1;
  for (let i = 0; i < B; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > bestVar) { bestVar = v; thrBin = i; }
  }
  const thr = lo0 + ((thrBin + 0.5) / B) * (hi0 - lo0);
  const sd = Math.sqrt(score.reduce((s2, x) => s2 + (x - (score.reduce((p, q) => p + q, 0) / score.length)) ** 2, 0) / score.length) || 1;
  const hi = thr + 0.12 * sd, lo = thr - 0.12 * sd;

  const segs = [];
  let open = null;
  for (let i = 0; i < hops.length; i++) {
    if (!open && score[i] > hi) open = { s: hops[i].p, i0: i };
    else if (open && score[i] < lo) { segs.push({ s: open.s, e: hops[i].p, i0: open.i0, i1: i }); open = null; }
  }
  if (open) segs.push({ s: open.s, e: hops[hops.length - 1].p, i0: open.i0, i1: hops.length - 1 });

  const merged = [];
  for (const g of segs) {
    const last = merged[merged.length - 1];
    if (last && g.s - last.e <= o.mergeMs) { last.e = g.e; last.i1 = g.i1; } else merged.push({ ...g });
  }
  const back = Math.round(240 / step);
  return merged.filter((g) => g.e - g.s >= o.minMs).map((g) => {
    let k = g.i0;                                    // el comienzo real está algo antes: se busca hacia atrás
    while (k > 0 && g.i0 - k < back && score[k - 1] > lo - 0.1 * sd) k--;
    return { s: hops[k].p, e: g.e, level: median(lvl.slice(g.i0, g.i1 + 1)) };
  });
}

/**
 * Empareja los tramos de voz con las líneas de la letra.
 * Devuelve { offsetMs (letra - audio), matched, coverage, residualMs, driftMs, confidence }.
 */
/** Empareja líneas con tramos en orden; `dOf(t)` da el desfase esperado para cada línea. */
function pair(sung, segs, dOf, tol) {
  const out = [];
  let k = 0;
  for (const l of sung) {
    const want = l.t + dOf(l.t);
    let best = -1, bd = Infinity;
    for (let i = k; i < segs.length; i++) {
      const d = Math.abs(segs[i].s - want);
      if (segs[i].s - want > tol && d > bd) break;
      if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0 && bd <= tol) { out.push({ t: l.t, s: segs[best].s, e: segs[best].e }); k = best + 1; continue; }
    const dentro = segs.findIndex((g, i) => i >= Math.max(0, k - 1) && want > g.s && want < g.e);
    if (dentro >= 0) { out.push({ t: l.t, s: want, e: Math.min(segs[dentro].e, want + 2500), dentro: true }); k = dentro; }
  }
  return out;
}

function matchLines(segs, lines, opt = {}) {
  const o = { maxShiftMs: 12000, binMs: 40, tolMs: 650, minLines: 8, minSep: 1.6, minCoverage: 0.6, maxResidualMs: 450, ...opt };
  const sung = lines.filter((l) => l && l.text && /[\p{L}\p{N}]/u.test(l.text));
  if (sung.length < o.minLines || segs.length < Math.min(6, o.minLines)) return { reason: 'pocos datos' };

  // 1) Votación: cada par (tramo, línea) vota por un desfase. El pico es el desfase de la canción.
  const vote = (bin) => {
    const nb = Math.round((2 * o.maxShiftMs) / bin) + 1;
    const v = new Float64Array(nb);
    for (const g of segs) for (const l of sung) {
      const d = g.s - l.t;
      if (Math.abs(d) > o.maxShiftMs) continue;
      const b = Math.round((d + o.maxShiftMs) / bin);
      v[b] += 1; if (b > 0) v[b - 1] += 0.5; if (b < nb - 1) v[b + 1] += 0.5;
    }
    let bi = 0;
    for (let i = 1; i < nb; i++) if (v[i] > v[bi]) bi = i;
    let second = 0;
    for (let i = 0; i < nb; i++) if (Math.abs(i - bi) * bin > 900 && v[i] > second) second = v[i];
    return { d: bi * bin - o.maxShiftMs, peak: v[bi], second };
  };
  const need = Math.max(4, Math.min(sung.length, segs.length) * 0.25);   // en canciones rápidas varios versos caen en un mismo tramo
  let vf = vote(o.binMs);
  // si no hay un pico claro, se vota con bins anchos: así se encuentra también un desfase que va cambiando
  const coarse = vf.peak < need;
  if (coarse) vf = vote(300);
  if (vf.peak < need) return { reason: 'sin coincidencias suficientes' };
  const peak = vf.peak, second = vf.second, d0 = vf.d;

  // 2) Afinado: mediana de los pares cercanos al pico
  const near = [];
  for (const g of segs) for (const l of sung) { const d = g.s - l.t; if (Math.abs(d - d0) <= 400) near.push(d); }
  const d1 = near.length ? median(near) : d0;

  // 3) Emparejado en orden: cada línea toma el tramo más cercano sin romper la secuencia
  const tol0 = coarse ? Math.max(o.tolMs, 1100) : o.tolMs;
  let matched = pair(sung, segs, () => d1, tol0);
  // segunda pasada: cada línea usa el desfase de sus vecinas ya emparejadas (así se sigue un desfase que cambia)
  if (matched.length >= 4) {
    const pts = matched.map((m) => ({ t: m.t, off: m.s - m.t }));
    const localD = (t) => {
      let a2 = null, b2 = null;
      for (const p of pts) { if (p.t <= t) a2 = p; else { b2 = p; break; } }
      if (a2 && b2) return a2.off + ((b2.off - a2.off) * (t - a2.t)) / (b2.t - a2.t);
      return (a2 || b2).off;
    };
    const again = pair(sung, segs, localD, Math.min(tol0, 800));
    if (again.length > matched.length) matched = again;
  }
  if (matched.length < o.minLines) return { reason: 'pocas líneas emparejadas', coverage: +(matched.length / sung.length).toFixed(2) };

  const offs = matched.map((m) => m.t - m.s);
  const offsetMs = Math.round(median(offs) / 10) * 10;
  const residualMs = Math.round(median(offs.map((x) => Math.abs(x - offsetMs))));
  const half = offs.length >> 1;
  const driftMs = Math.round(median(offs.slice(half)) - median(offs.slice(0, half)));
  const coverage = matched.length / sung.length;
  const sep = second > 0 ? peak / second : 3;
  const confidence = Math.max(0, Math.min(1,
    0.45 * Math.min(1, (coverage - 0.35) / 0.45) +
    0.30 * Math.min(1, (sep - 1) / 1.2) +
    0.25 * Math.min(1, (500 - residualMs) / 350)));
  const res = { offsetMs, residualMs, driftMs, coverage: +coverage.toFixed(2), sep: +sep.toFixed(2), confidence: +confidence.toFixed(2), matched, lines: sung.length };
  // Condiciones para fiarse: un pico claramente mejor que su rival, muchas líneas emparejadas y poco error.
  // Sin esto, una letra que no corresponde a la canción también "encaja" en algún sitio.
  if (sep < o.minSep) return { ...res, reason: 'alineación ambigua' };
  if (coverage < o.minCoverage) return { ...res, reason: 'pocas líneas reconocidas' };
  if (residualMs > o.maxResidualMs) return { ...res, reason: 'emparejado irregular' };
  return { ...res, apply: true };
}

/**
 * Tiempos corregidos por línea a partir del emparejado: cada línea se coloca donde de verdad empieza la voz,
 * y lleva la duración medida para el relleno karaoke. Las líneas sin tramo propio se interpolan.
 */
function retime(res, lines) {
  if (!res || !res.matched || !res.matched.length) return [];
  const sung = lines.filter((l) => l && l.text && /[\p{L}\p{N}]/u.test(l.text));
  const byT = new Map(res.matched.map((m) => [m.t, m]));
  const pts = res.matched.map((m) => ({ t: m.t, off: m.t - m.s }));          // off = letra - audio
  const out = [];
  for (const l of sung) {
    const m = byT.get(l.t);
    if (m) { out.push({ t: l.t, t2: Math.round(m.s), dur: Math.round(m.e - m.s), medido: true }); continue; }
    let a = null, b = null;
    for (const p of pts) { if (p.t <= l.t) a = p; else { b = p; break; } }
    let off;
    if (a && b) off = a.off + ((b.off - a.off) * (l.t - a.t)) / (b.t - a.t);
    else off = (a || b).off;
    out.push({ t: l.t, t2: Math.round(l.t - off), dur: 0, medido: false });
  }
  return out;
}

module.exports = { voiceSegments, matchLines, retime, smooth, median, pctl, DB };
