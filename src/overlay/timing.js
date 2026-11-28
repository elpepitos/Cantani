// Cálculos de tiempo del relleno karaoke. Sin DOM: se puede probar con Node.
(function (root) {
  const VOWEL_GROUP = /[aeiouyáéíóúüàèìòùâêîôûäëïö]+/gi;

  /** Sílabas aproximadas de una palabra (grupos de vocales; mínimo 1). */
  function syllables(word) {
    const letters = String(word).replace(/[^\p{L}]/gu, '');
    if (!letters) return 1;
    const groups = letters.match(VOWEL_GROUP);
    return Math.max(1, groups ? groups.length : 1);
  }

  /** Pausa (en "sílabas equivalentes") que el cantante hace después de esta palabra. */
  function pauseUnits(token) {
    const t = String(token).replace(/[)"'»”’\]]+$/u, '');
    if (/[.!?…]$/.test(t)) return 1.8;
    if (/[,;:]$/.test(t)) return 0.9;
    if (/[—–-]$/.test(t)) return 0.6;
    return 0;
  }

  /** Modelo de una línea: cada palabra con su tramo [start, start+len] y su pausa posterior. */
  function lineModel(text) {
    const parts = String(text || '').split(/\s+/).filter(Boolean);
    let total = 0;
    const tokens = parts.map((p, i) => {
      const len = syllables(p);
      const pause = i < parts.length - 1 ? pauseUnits(p) : 0; // la pausa final no cuenta
      const tok = { text: p, start: total, len, pause };
      total += len + pause;
      return tok;
    });
    return { tokens, total };
  }

  /** Progreso (0..1) de una palabra cuando la línea lleva `done` unidades cantadas. */
  function wordProgress(tok, done) {
    return Math.min(1, Math.max(0, (done - tok.start) / tok.len));
  }

  const PACE_MIN = 140, PACE_MAX = 340;   // ms por sílaba: por encima de PACE_MAX el relleno se arrastra
  const pctl = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

  /**
   * Velocidad típica de canto, en ms por unidad. Se toma un percentil bajo de los huecos entre líneas:
   * los huecos incluyen las pausas en que no se canta, así que la mediana hace el relleno demasiado lento.
   */
  function songPace(lines, models) {
    const ratios = [];
    for (let i = 0; i < lines.length - 1; i++) {
      const m = models[i];
      if (!m || m.total < 3 || lines[i].words) continue;
      const gap = lines[i + 1].t - lines[i].t;
      if (gap > 0 && gap <= 7000) ratios.push(gap / m.total);
    }
    if (ratios.length < 3) return 260;
    ratios.sort((a, b) => a - b);
    return Math.min(PACE_MAX, Math.max(PACE_MIN, pctl(ratios, 0.35)));
  }

  /**
   * Ritmo por zona de la canción: estrofas y estribillos no se cantan igual de rápido.
   * Para cada línea toma las vecinas (±3) que se cantan de corrido (sin pausa larga detrás)
   * y usa su mediana; si no hay suficientes, la velocidad global.
   */
  function localPaces(lines, models, globalPace) {
    const ratio = lines.map((l, i) => {
      const m = models[i];
      if (!m || m.total < 3 || l.words || !lines[i + 1]) return null;
      const gap = lines[i + 1].t - l.t;
      const r = gap / m.total;
      // se descartan los huecos desproporcionados (instrumentales), no las zonas lentas de verdad
      return gap > 0 && gap <= 7000 && r <= globalPace * 2.5 ? r : null;
    });
    return lines.map((_, i) => {
      const v = [];
      for (let k = Math.max(0, i - 3); k <= Math.min(lines.length - 1, i + 3); k++) if (ratio[k] != null) v.push(ratio[k]);
      if (v.length < 2) return globalPace;
      v.sort((a, b) => a - b);
      return Math.min(PACE_MAX, Math.max(PACE_MIN, pctl(v, 0.35)));
    });
  }

  /** Cuánto dura el relleno de una línea: lo que tarda en cantarse, sin pasar del hueco hasta la siguiente. */
  function fillDuration(gapMs, totalUnits, paceMs) {
    const expected = totalUnits * paceMs;
    // Línea cantada de corrido (el hueco es casi lo que dura cantarla): el hueco real es mejor que la estimación
    if (gapMs <= expected * 1.2) return Math.max(350, gapMs * (gapMs >= expected ? 0.97 : 0.95));
    // Hueco mucho mayor: después de cantar hay una pausa. El relleno termina con la voz y espera,
    // en vez de arrastrarse hasta la línea siguiente (es lo que estropeaba las canciones lentas).
    return Math.max(350, Math.min(gapMs * 0.9, expected));
  }

  /** Progreso de la palabra i cuando la letra trae tiempos reales por palabra. */
  function realWordProgress(words, i, pos, lineEnd) {
    const t0 = words[i].t;
    const t1 = i + 1 < words.length ? words[i + 1].t : Math.min(lineEnd, t0 + 800);
    return Math.min(1, Math.max(0, (pos - t0) / Math.max(80, t1 - t0)));
  }

  /** Línea (con texto) cuyo inicio está más cerca de `pos`. -1 si no hay ninguna a menos de maxDist. */
  function nearestLine(lines, pos, maxDist = 6000) {
    let best = -1, bd = Infinity;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].text) continue;
      const d = Math.abs(lines[i].t - pos);
      if (d < bd) { bd = d; best = i; }
    }
    return bd <= maxDist ? best : -1;
  }

  /**
   * Ajuste exacto de la canción al pulsar el atajo justo cuando se oye empezar `lineT`.
   * `base` = posición sin el ajuste de la canción; `reaction` = retraso humano al pulsar.
   */
  function calibratedOffset(lineT, base, reaction = 180, limit = 15000) {
    const v = Math.round((lineT + reaction - base) / 10) * 10;
    return Math.max(-limit, Math.min(limit, v));
  }

  /**
   * Quita lo que no se canta: líneas solo entre paréntesis/corchetes, como "(One, two, three, four)",
   * y las líneas vacías o ♪ del principio. Así la letra no "arranca" con el conteo o la intro.
   * Los ♪ del medio se conservan (son los instrumentales).
   */
  function cleanIntro(lines) {
    const isNoise = (t) => {
      const x = (t || '').trim();
      return !x || /^[♪♫♬\s.\-–—]+$/.test(x) || /^[\(\[].*[\)\]]$/.test(x);
    };
    const out = lines.filter((l) => !/^[\(\[].*[\)\]]$/.test((l.text || '').trim()));
    let k = 0;
    while (k < out.length && isNoise(out[k].text)) k++;
    return out.slice(k);
  }

  const api = { localPaces, cleanIntro, syllables, pauseUnits, lineModel, wordProgress, songPace, fillDuration, realWordProgress, nearestLine, calibratedOffset };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LyricsTiming = api;
})(typeof window !== 'undefined' ? window : globalThis);
