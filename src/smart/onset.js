/**
 * Modo inteligente (experimental): detecta cuándo entra la voz en la canción a partir del audio del sistema
 * y lo compara con la primera línea de la letra.
 *
 * Entrada: hops = [{ p: posición de la canción en ms, v: energía (RMS) en la banda de la voz 300–3400 Hz, a: energía total }]
 * Solo corrige cuando está MUY seguro: una corrección mala es peor que no corregir.
 */

const db = (x) => 20 * Math.log10(x + 1e-5);
const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; };

/** Suaviza con media móvil de n puntos. */
function smooth(arr, n) {
  const out = new Array(arr.length);
  let acc = 0;
  for (let i = 0; i < arr.length; i++) {
    acc += arr[i];
    if (i >= n) acc -= arr[i - n];
    out[i] = acc / Math.min(i + 1, n);
  }
  // la media móvil retrasa n/2 puntos: se corrige desplazando
  const sh = n >> 1;
  return out.map((_, i) => out[Math.min(out.length - 1, i + sh)]);
}

/**
 * Candidatos a "entra la voz": subidas claras y sostenidas de la energía de la banda de voz.
 * Devuelve [{ p (ms de la canción), rise (dB), base (dB) }] ordenados por tiempo.
 */
function findOnsets(hops, opt = {}) {
  const o = { minRise: 7, floorDb: -60, hopMs: 20, baseSpanMs: 1400, gapMs: 200, afterFromMs: 100, afterToMs: 600, minSepMs: 700, ...opt };
  if (hops.length < 60) return [];
  const dv = smooth(hops.map((h) => db(h.v)), 5);
  const P = hops.map((h) => h.p);
  const n = hops.length;
  const idxAt = (ms, from) => { let i = from; while (i < n && P[i] < ms) i++; return i; };

  const raw = [];
  let iBaseStart = 0;
  for (let i = 0; i < n; i++) {
    const t = P[i];
    // ventana "antes": [t - baseSpan, t - gap]; "después": [t + afterFrom, t + afterTo]
    const b0 = idxAt(t - o.baseSpanMs, iBaseStart); iBaseStart = b0;
    const b1 = idxAt(t - o.gapMs, b0);
    const a0 = idxAt(t + o.afterFromMs, i);
    const a1 = idxAt(t + o.afterToMs, a0);
    if (b1 - b0 < 20 || a1 - a0 < 10 || a1 > n) continue;
    // la ventana "antes" debe estar completa (hay audio suficiente antes de esta subida)
    if (P[b0] > t - o.baseSpanMs + 200) continue;
    const base = median(dv.slice(b0, b1));
    const after = median(dv.slice(a0, a1));
    const rise = after - base;
    if (rise >= o.minRise && after > o.floorDb) raw.push({ i, p: t, rise, base, after });
  }
  if (!raw.length) return [];

  // agrupa subidas contiguas y se queda con la más fuerte de cada grupo
  const groups = [];
  for (const r of raw) {
    const last = groups[groups.length - 1];
    if (last && r.p - last[last.length - 1].p <= o.minSepMs) last.push(r); else groups.push([r]);
  }
  return groups.map((g) => {
    const best = g.reduce((a, b) => (b.rise > a.rise ? b : a));
    // el instante exacto de entrada: el primer punto, cerca del pico de subida, donde la energía ya supera la mitad de la subida
    const target = best.base + best.rise * 0.5;
    let k = best.i;
    while (k > 0 && best.p - P[k] < 800 && dv[k] >= target) k--;                 // por si ya estamos dentro de la subida
    while (k < n - 1 && P[k] - best.p < 1200 && dv[k] < target) k++;             // avanza hasta cruzar la mitad
    return { p: P[k], rise: best.rise, base: best.base, after: best.after };
  });
}

/**
 * Decide si hay que corregir.
 * firstLineMs: tiempo (según la letra) de la primera línea cantada.
 * Devuelve { offsetMs, confidence, onsetMs, rise } o { reason }.
 * offsetMs sigue la convención de Cantani: positivo = letras más pronto (offset = tiempoLetra - tiempoAudio).
 */
function analyze(hops, firstLineMs, opt = {}) {
  const o = { windowMs: 4000, minCorrectionMs: 150, maxCorrectionMs: 3500, minConfidence: 0.7, isolationMs: 2500, ...opt };
  if (!Number.isFinite(firstLineMs)) return { reason: 'sin primera línea' };
  if (!hops || hops.length < 100) return { reason: 'poco audio' };
  const first = hops[0].p, last = hops[hops.length - 1].p;
  if (first > firstLineMs - 1500) return { reason: 'empezó la captura demasiado tarde' };
  if (last < firstLineMs + 800) return { reason: 'captura demasiado corta' };

  const loudest = median(hops.map((h) => db(h.v)).sort((a, b) => b - a).slice(0, Math.max(5, hops.length >> 4)));
  const onsets = findOnsets(hops, opt);
  if (!onsets.length) return { reason: 'no se detecta entrada clara de voz' };

  // el candidato más cercano a la primera línea dentro de la ventana
  const near = onsets.filter((c) => Math.abs(c.p - firstLineMs) <= o.windowMs)
    .sort((a, b) => Math.abs(a.p - firstLineMs) - Math.abs(b.p - firstLineMs));
  if (!near.length) return { reason: 'ninguna entrada cerca de la primera línea' };
  const c = near[0];
  if (c.p - first < 1500) return { reason: 'sin calma previa suficiente', onsetMs: Math.round(c.p) };

  // confianza: subida fuerte, aislada (sin otras subidas parecidas cerca) y precedida de calma relativa
  const others = onsets.filter((x) => x !== c && Math.abs(x.p - c.p) <= o.isolationMs).length;
  const riseScore = Math.max(0, Math.min(1, (c.rise - 7) / 9));
  const quiet = Math.max(0, Math.min(1, (loudest - c.base - 8) / 14));   // el "antes" está claramente más bajo que lo más fuerte
  const isolation = others === 0 ? 1 : others === 1 ? 0.35 : 0;
  const confidence = 0.4 * riseScore + 0.3 * quiet + 0.3 * isolation;

  const offsetMs = Math.round((firstLineMs - c.p) / 10) * 10;
  const res = { offsetMs, confidence: +confidence.toFixed(2), onsetMs: Math.round(c.p), rise: +c.rise.toFixed(1), others };
  if (Math.abs(offsetMs) < o.minCorrectionMs) return { ...res, reason: 'ya va bien' };
  if (Math.abs(offsetMs) > o.maxCorrectionMs) return { ...res, reason: 'corrección demasiado grande' };
  if (confidence < o.minConfidence || others > 0) return { ...res, reason: 'confianza baja' };
  return { ...res, apply: true };
}


const pctl = (arr, q) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0; };

/**
 * Aprende cuándo se canta de verdad cada línea (para el relleno karaoke).
 * hops: [{ p, v, a }] con p = posición de AUDIO (ms); lines: [{ t, text }] (t = tiempo según la letra);
 * offsetMs: ajuste de la canción (tiempo de letra = tiempo de audio + offsetMs).
 * Devuelve { fills: [{ t, lead, dur }], coverage }:
 *   lead = cuánto después (o antes, si es negativo) de t empieza a oírse la voz; dur = cuánto se canta la línea.
 * Una línea solo se aprende cuando el final de la voz se distingue claramente (cae el nivel antes de la línea siguiente).
 */
function learnFills(hops, lines, offsetMs = 0, opt = {}) {
  const o = { dropDb: 10, minPeakAboveFloor: 12, run: 6, minDur: 300, maxDur: 14000, maxLead: 1200, endMarginMs: 150, ...opt };
  const out = { fills: [], coverage: 0, singable: 0 };
  if (!hops || hops.length < 200) return out;
  const n = hops.length;
  const P = hops.map((h) => h.p);
  const dv = smooth(hops.map((h) => db(h.v)), 5);
  const floor = pctl(dv, 0.15);
  const lb = (ms) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (P[m] < ms) lo = m + 1; else hi = m; } return lo; };
  const isSung = (l) => l && l.text && /[\p{L}\p{N}]/u.test(l.text);

  for (let k = 0; k < lines.length; k++) {
    const l = lines[k];
    if (!isSung(l)) continue;
    out.singable++;
    const a = l.t - offsetMs;
    const nxt = lines[k + 1];
    const aNext = nxt ? nxt.t - offsetMs : a + 6000;
    if (aNext - a < 900) continue;
    if (P[0] > a - 400 || P[n - 1] < aNext) continue;                    // no hay audio de toda la línea
    const i0 = lb(a - 300), i1 = lb(aNext);
    if (i1 - i0 < 0.6 * ((aNext - a + 300) / 20)) continue;              // demasiados huecos en la captura
    const peak = pctl(dv.slice(i0, i1), 0.85);
    if (peak - floor < o.minPeakAboveFloor) continue;                     // la voz no destaca del fondo
    const thr = peak - o.dropDb;
    // inicio: primera subida sostenida cerca del inicio de la línea
    let sIdx = -1;
    for (let i = lb(a - 700), end = lb(a + 1500); i < end && i + o.run <= n; i++) {
      let ok = true;
      for (let r = 0; r < o.run; r++) if (dv[i + r] < thr) { ok = false; break; }
      if (ok) { sIdx = i; break; }
    }
    if (sIdx < 0) continue;
    // final: último tramo sostenido por encima del umbral antes de la línea siguiente
    let eIdx = -1;
    for (let j = i1 - 1; j >= sIdx + o.run; j--) {
      let ok = true;
      for (let r = 0; r < o.run; r++) if (dv[j - r] < thr) { ok = false; break; }
      if (ok) { eIdx = j; break; }
    }
    if (eIdx < 0) continue;
    const s = P[sIdx], e = P[eIdx];
    if (e >= aNext - o.endMarginMs) continue;                             // sigue sonando hasta la siguiente: no se distingue el final
    const dur = e - s, lead = s - a;
    if (dur < o.minDur || dur > o.maxDur || Math.abs(lead) > o.maxLead) continue;
    out.fills.push({ t: l.t, lead: Math.round(lead / 10) * 10, dur: Math.round(dur / 10) * 10 });
  }
  out.coverage = out.singable ? out.fills.length / out.singable : 0;
  return out;
}


/**
 * Alinea TODA la letra con el audio: busca el desplazamiento para el que más inicios de línea coinciden
 * con entradas de voz (subidas de energía en la banda de la voz). Sirve con intros instrumentales
 * y cuando la primera línea está en el segundo 0.
 * Devuelve { offsetMs, confidence, z, ratio, lines, apply } (offsetMs: tiempo de letra = tiempo de audio + offsetMs).
 */
function alignByCorrelation(hops, lines, opt = {}) {
  const o = { maxShiftMs: 12000, tolMs: 140, minLines: 8, minZ: 5, minRatio: 1.3, minCorrectionMs: 150, minCoverageMs: 25000, ...opt };
  const STEP = 20;
  if (!hops || hops.length < 1500) return { reason: 'poco audio' };
  const p0 = hops[0].p, pEnd = hops[hops.length - 1].p;
  if (pEnd - p0 < o.minCoverageMs) return { reason: 'poco audio' };
  const N = Math.floor((pEnd - p0) / STEP) + 1;
  const dvRaw = new Array(hops.length);
  for (let i = 0; i < hops.length; i++) dvRaw[i] = db(hops[i].v);
  const dv = smooth(dvRaw, 5);
  // rejilla uniforme de 20 ms con "subida de energía" (positiva, tope 12 dB) y marca de cobertura
  const flux = new Float32Array(N), seen = new Uint8Array(N);
  const lvl = new Float32Array(N).fill(NaN);
  for (let i = 0; i < hops.length; i++) { const g = Math.round((hops[i].p - p0) / STEP); if (g >= 0 && g < N) { lvl[g] = dv[i]; seen[g] = 1; } }
  const K = 6;                                   // compara 120 ms después con 120 ms antes
  for (let g = K; g < N - K; g++) {
    if (!seen[g - K] || !seen[g + K]) continue;
    const d = lvl[g + K] - lvl[g - K];
    flux[g] = d > 0 ? Math.min(12, d) : 0;
  }
  // dilatación: el máximo de la subida en ±tol (tolera pequeños errores de la letra)
  const R = Math.round(o.tolMs / STEP);
  const dil = new Float32Array(N);
  for (let g = 0; g < N; g++) { let m = 0; for (let k = Math.max(0, g - R); k <= Math.min(N - 1, g + R); k++) if (flux[k] > m) m = flux[k]; dil[g] = m; }
  // "Presencia de voz": cuánta de la energía total está en la banda de la voz. En música densa (orquesta)
  // la energía sube en todas partes, pero esta proporción sube sobre todo cuando alguien canta.
  const presG = new Float32Array(N);
  {
    const rRaw = new Array(hops.length);
    for (let i = 0; i < hops.length; i++) rRaw[i] = db(hops[i].v) - db(hops[i].a);
    const rs = smooth(rRaw, 10);
    for (let i = 0; i < hops.length; i++) { const g = Math.round((hops[i].p - p0) / STEP); if (g >= 0 && g < N) presG[g] = rs[i]; }
    let last = 0;
    for (let g = 0; g < N; g++) { if (seen[g]) last = presG[g]; else presG[g] = last; }
  }
  const isSung = (l) => l && l.text && /[\p{L}\p{N}]/u.test(l.text);
  const sung = lines.filter(isSung);
  const ts = sung.map((l) => l.t);
  // tramo de cada línea donde debería oírse la voz (hasta 1,4 s o hasta la línea siguiente)
  const spans = sung.map((l, i) => {
    const nxt = sung[i + 1];
    return Math.max(300, Math.min(1400, nxt ? (nxt.t - l.t) * 0.8 : 1400));
  });
  if (ts.length < o.minLines) return { reason: 'pocas líneas' };

  // suma acumulada de la presencia: permite la media de cualquier tramo en tiempo constante
  const cum = new Float64Array(N + 1);
  for (let g = 0; g < N; g++) cum[g + 1] = cum[g] + presG[g];

  const shifts = []; const sOnset = []; const sPres = [];
  for (let d = -o.maxShiftMs; d <= o.maxShiftMs; d += STEP) {
    let a1 = 0, a2 = 0, cnt = 0;
    for (let i = 0; i < ts.length; i++) {
      const g = Math.round((ts[i] - d - p0) / STEP);
      const w = Math.round(spans[i] / STEP);
      if (g < R + 2 || g + w > N - R - 3) continue;
      a1 += dil[g];
      a2 += (cum[g + w] - cum[g]) / w;
      cnt++;
    }
    shifts.push(d);
    sOnset.push(cnt >= o.minLines ? a1 / cnt : NaN);
    sPres.push(cnt >= o.minLines ? a2 / cnt : NaN);
  }
  // cada señal se normaliza por su cuenta y se suman: hace falta que coincidan las dos
  const zify = (arr) => {
    const v = arr.filter(Number.isFinite);
    const mu = v.reduce((a, b) => a + b, 0) / v.length;
    const sg = Math.sqrt(v.reduce((a, b) => a + (b - mu) * (b - mu), 0) / v.length) || 1e-6;
    return arr.map((x) => (Number.isFinite(x) ? (x - mu) / sg : NaN));
  };
  if (sOnset.filter(Number.isFinite).length < 40) return { reason: 'pocas líneas dentro del audio' };
  const zo = zify(sOnset), zp = zify(sPres);
  const scores = zo.map((x, i) => (Number.isFinite(x) && Number.isFinite(zp[i]) ? x + zp[i] : NaN));
  const valid = scores.filter(Number.isFinite);
  if (valid.length < 40) return { reason: 'pocas líneas dentro del audio' };
  const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
  const sd = Math.sqrt(valid.reduce((a, b) => a + (b - mean) * (b - mean), 0) / valid.length) || 1e-6;
  let bi = -1;
  for (let i = 0; i < scores.length; i++) if (Number.isFinite(scores[i]) && (bi < 0 || scores[i] > scores[bi])) bi = i;
  const best = scores[bi], z = (best - mean) / sd;
  // el mejor "rival": máximo a más de 600 ms del ganador
  let second = -Infinity;
  for (let i = 0; i < scores.length; i++) if (Number.isFinite(scores[i]) && Math.abs(shifts[i] - shifts[bi]) > 600 && scores[i] > second) second = scores[i];
  const ratio = Number.isFinite(second) && sd > 0 ? 1 + (best - second) / (2 * sd) : 9;   // separación con el rival, en desviaciones
  // el máximo es una meseta (la subida y la tolerancia la ensanchan): se toma el centro de la meseta
  let lo = bi, hi = bi;
  while (lo > 0 && Number.isFinite(scores[lo - 1]) && scores[lo - 1] >= best * 0.96) lo--;
  while (hi < scores.length - 1 && Number.isFinite(scores[hi + 1]) && scores[hi + 1] >= best * 0.96) hi++;
  const off = (shifts[lo] + shifts[hi]) / 2;
  const offsetMs = Math.round(off / 10) * 10;
  const confidence = Math.max(0, Math.min(1, 0.5 * Math.min(1, (z - 3) / 6) + 0.5 * Math.min(1, (ratio - 1) / 0.6)));
  const res = { offsetMs, confidence: +confidence.toFixed(2), z: +z.toFixed(1), ratio: +ratio.toFixed(2), lines: ts.length };
  if (Math.abs(offsetMs) < o.minCorrectionMs) return { ...res, reason: 'ya va bien' };
  if (z < o.minZ || ratio < o.minRatio) return { ...res, reason: 'alineación poco clara' };
  return { ...res, apply: true };
}


/**
 * Alineaciones repetidas: si las últimas `n` pasadas dan el mismo desplazamiento (±tol) y cada una supera un mínimo
 * más bajo que el exigido a una sola pasada, el resultado es fiable (el ruido no se repite igual).
 * hist: [{ offsetMs, z, ratio }]. Devuelve { offsetMs, confidence, apply } o null.
 */
function stableAlignment(hist, opt = {}) {
  const o = { n: 3, tolMs: 120, minZ: 3, minRatio: 1.18, minCorrectionMs: 150, ...opt };
  const last = (hist || []).slice(-o.n);
  if (last.length < o.n) return null;
  if (!last.every((h) => Number.isFinite(h.offsetMs) && h.z >= o.minZ && h.ratio >= o.minRatio)) return null;
  const offs = last.map((h) => h.offsetMs);
  if (Math.max(...offs) - Math.min(...offs) > o.tolMs) return null;
  const offsetMs = Math.round(offs.reduce((a, b) => a + b, 0) / offs.length / 10) * 10;
  if (Math.abs(offsetMs) < o.minCorrectionMs) return null;
  return { offsetMs, confidence: +Math.min(1, 0.4 + 0.1 * last.length).toFixed(2), apply: true, stable: true };
}

module.exports = { findOnsets, analyze, learnFills, alignByCorrelation, stableAlignment, smooth, db, median };
