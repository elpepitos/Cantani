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

module.exports = { findOnsets, analyze, smooth, db, median };
