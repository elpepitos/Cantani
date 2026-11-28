// Simulador de canciones: genera las mismas mediciones que haría Cantani (nivel en banda de voz y nivel total
// cada 20 ms) a partir de un guion conocido, para poder medir el error del detector contra la verdad.
function mk(opt = {}) {
  const o = { dur: 180000, hop: 20, seed: 1, lineGap: [2200, 4200], voiceLen: [1200, 2600],
              instr: 'denso', shift: 0, nLines: 40, gapEvery: 11, gapLen: 15000,
              voiceDb: -18, voiceBandDb: -20, bedDb: -16, bedBandDb: -26, snr: 1, ...opt };
  let s = o.seed; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const lin = (d) => Math.pow(10, d / 20);
  // guion: tramos de voz reales (verdad) y líneas de letra desplazadas `shift` ms
  const segs = []; const lines = [];
  let t = 4000 + Math.floor(rnd() * 4000);
  for (let i = 0; i < o.nLines; i++) {
    const len = o.voiceLen[0] + Math.floor(rnd() * (o.voiceLen[1] - o.voiceLen[0]));
    segs.push({ s: t, e: t + len });
    lines.push({ t: t + o.shift, text: 'linea ' + i });
    t += (i % o.gapEvery === o.gapEvery - 1) ? o.gapLen : Math.max(len + 150, o.lineGap[0] + Math.floor(rnd() * (o.lineGap[1] - o.lineGap[0])));
    if (t > o.dur - 6000) break;
  }
  const hops = [];
  const env = (p, a, b, ramp = 120) => {                       // subida y bajada suaves
    if (p < a - ramp || p > b + ramp) return 0;
    if (p < a) return (p - (a - ramp)) / ramp;
    if (p > b) return 1 - (p - b) / ramp;
    return 1;
  };
  for (let p = 0; p <= o.dur; p += o.hop) {
    // base instrumental
    let band = o.bedBandDb, full = o.bedDb;
    if (o.instr === 'denso') {
      const golpe = env(p % 900, 0, 220, 60);                  // percusión/acentos constantes
      const cresc = 6 * Math.sin((2 * Math.PI * p) / 24000);   // crescendos lentos de orquesta
      band = o.bedBandDb + 4 * golpe + cresc * 0.6;
      full = o.bedDb + 6 * golpe + cresc;                 // la orquesta llena mucho más el total
    } else if (o.instr === 'suave') {
      band = o.bedBandDb - 10; full = o.bedDb - 12;
    }
    // voz
    let vb = -99, vf = -99;
    for (const g of segs) {
      const e = env(p, g.s, g.e, 150);
      if (e > 0) {
        const vib = 1.5 * Math.sin((2 * Math.PI * (p - g.s)) / 420);   // vibrato de nivel
        vb = o.voiceBandDb + vib - 6 * (1 - e); vf = o.voiceDb + vib - 6 * (1 - e);
        break;
      }
    }
    const sum = (a, b) => 10 * Math.log10(Math.pow(10, a / 10) + Math.pow(10, b / 10));
    const n = () => (rnd() - 0.5) * 2 * o.snr;
    hops.push({ p, v: lin(sum(band, vb) + n()), a: lin(sum(full, vf) + n()) });
  }
  return { hops, lines, segs, shift: o.shift };
}
module.exports = { mk };
