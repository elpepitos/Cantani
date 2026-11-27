/**
 * Estima la posición real de la canción a partir de las lecturas de Windows (SMTC).
 *
 * Cada lectura trae la posición P y la hora U a la que Windows dice haberla medido.
 *  - Spotify de escritorio: P se queda quieta entre eventos y U marca cuándo se midió  -> P + (ahora - U)
 *  - Algunos navegadores:   P avanza sola pero U se queda en una hora vieja             -> P ya es "viva";
 *    sumarle (ahora - U) contaría el tiempo dos veces (las letras irían adelantadas y cada vez más).
 * Regla: si P cambia y U no, la marca U no es de fiar y P se toma como medida "ahora".
 */
class PositionTracker {
  constructor() { this.reset(); }

  reset() {
    this.prevTrackP = (this.lastP === undefined) ? null : this.lastP;   // última posición de la canción anterior
    this.anchor = null;      // { P, at } posición P válida en el instante `at`
    this.lastP = null;
    this.lastU = null;
    this.lastPlaying = null;
    this.mode = 'sin datos'; // 'marca' (U fiable) | 'viva' (U atrasada) | 'inicial'
    this.provisional = false; // primera lectura tras un cambio de canción que parecía de la canción anterior
    this.stats = { corrections: 0, maxAbsMs: 0, bigJumps: 0, lastMs: 0 };
  }

  /**
   * ctx.sinceChangeMs: ms desde que se detectó la canción nueva; ctx.hadPrevious: había otra canción antes.
   * Tras un cambio de canción, Windows a veces entrega aún la posición/marca de la canción ANTERIOR
   * (p. ej. minuto 3 con marca vieja). Una canción recién empezada no puede ir más allá de lo que lleva sonando.
   */
  update(s, now, ctx = {}) {
    const P = s.positionMs;
    const U = s.updatedMs > 1e12 && s.updatedMs <= now + 1000 ? s.updatedMs : 0;
    const changedP = P !== this.lastP;
    const changedU = U !== this.lastU;
    const toggled = s.playing !== this.lastPlaying;

    if (!this.anchor || changedP || changedU || toggled) {
      let at;
      if (!this.anchor) { at = U || now; this.mode = 'inicial'; }
      else if (changedU && U) { at = U; this.mode = 'marca'; }
      else { at = now; this.mode = 'viva'; }
      // Cuánto se equivocaba la estimación anterior al llegar la medida nueva (mide la calidad de la posición)
      if (this.anchor && toggled === false) {
        const before = this.anchor.P + (this.lastPlaying ? Math.max(0, at - this.anchor.at) : 0);
        const err = P - before;
        if (Number.isFinite(err) && Math.abs(err) < 60000) {
          this.stats.corrections++; this.stats.lastMs = Math.round(err);
          this.stats.maxAbsMs = Math.max(this.stats.maxAbsMs, Math.abs(Math.round(err)));
          if (Math.abs(err) > 500) this.stats.bigJumps++;
        }
      }
      const prev = this.anchor;
      this.anchor = { P, at };
      if (this.provisional && this.mode !== 'inicial') this.provisional = false;   // llegó una medida nueva: se acepta
      // Ventana de seguridad: justo después de cambiar de canción, cualquier medida que ya esté
      // más allá de lo que lleva sonando la canción nueva es de la canción anterior (dato viejo).
      const since = ctx.sinceChangeMs || 0;
      const cand = s.playing ? P + Math.max(0, now - at) : P;
      const early = ctx.hadPrevious && since < 25000;
      // Un salto real (el usuario adelanta) llega con marca fresca y lejos de la posición vieja; un dato viejo, no.
      const freshSeek = !!U && changedU && now - U < 2500 && this.mode !== 'viva' &&
        (this.prevTrackP == null || Math.abs(P - this.prevTrackP) > 3000);
      const tooFar = early && cand > since + 5000 && !freshSeek;
      const pastEnd = this.mode === 'inicial' && s.durationMs > 0 && cand > s.durationMs + 15000;
      if (tooFar || pastEnd) {
        const keep = prev && this.mode !== 'inicial' && (prev.P + Math.max(0, now - prev.at)) <= since + 5000;
        this.anchor = keep ? prev : { P: tooFar ? Math.max(0, since) : P, at: now };
        this.provisional = true;
        this.mode = 'dato viejo (esperando)';
      }
    }
    this.lastP = P; this.lastU = U; this.lastPlaying = s.playing;

    let pos = (s.playing || this.provisional) ? this.anchor.P + (s.playing ? Math.max(0, now - this.anchor.at) : 0) : P;
    if (s.durationMs > 0) pos = Math.min(pos, s.durationMs);
    return Math.max(0, pos);
  }
}

module.exports = { PositionTracker };
