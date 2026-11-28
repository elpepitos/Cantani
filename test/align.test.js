// Alineación por tramos de voz: debe acertar en canciones difíciles y RECHAZAR cuando no está claro.
const assert = require('assert');
const A = require('../src/smart/align');
const { mk } = require('./sim-audio');

const casos = [
  ['orquesta densa, letra +3,5 s', { instr: 'denso', shift: 3500 }],
  ['orquesta densa, letra -2,3 s', { instr: 'denso', shift: -2300 }],
  ['acompañamiento suave +4,2 s', { instr: 'suave', shift: 4200 }],
  ['con ruido de medición', { instr: 'denso', shift: 2500, snr: 3 }],
  ['lenta con pausas largas', { instr: 'suave', shift: 1800, lineGap: [3800, 6000], voiceLen: [1400, 2200] }],
  ['rápida y sin respiro', { instr: 'denso', shift: 900, lineGap: [1500, 2100], voiceLen: [1200, 1800] }]
];
for (const [nombre, opt] of casos) {
  for (let seed = 1; seed <= 3; seed++) {
    const r = mk({ ...opt, seed });
    const m = A.matchLines(A.voiceSegments(r.hops), r.lines);
    assert.ok(m.apply, nombre + ' (semilla ' + seed + '): ' + (m.reason || '?'));
    assert.ok(Math.abs(m.offsetMs - r.shift) <= 250, nombre + ': error ' + (m.offsetMs - r.shift) + ' ms');
  }
}

// Casos en los que NO debe fiarse
{
  let s = 5; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const r = mk({ instr: 'denso', shift: 0, seed: 2 });
  const falsas = r.lines.map((l, i) => ({ t: Math.floor(rnd() * 170000), text: 'x' + i })).sort((a, b) => a.t - b.t);
  assert.ok(!A.matchLines(A.voiceSegments(r.hops), falsas).apply, 'letra que no corresponde');

  const inst = mk({ instr: 'denso', shift: 0, seed: 3, nLines: 0 });
  const lineas = Array.from({ length: 30 }, (_, i) => ({ t: 5000 + i * 4000, text: 'l' + i }));
  assert.ok(!A.matchLines(A.voiceSegments(inst.hops), lineas).apply, 'canción instrumental');

  const per = mk({ instr: 'suave', shift: 0, seed: 4, lineGap: [4000, 4000], voiceLen: [1800, 1800], gapEvery: 99 });
  assert.ok(!A.matchLines(A.voiceSegments(per.hops), per.lines).apply, 'estructura periódica (ambigua)');

  const corto = mk({ instr: 'suave', shift: 2000, seed: 1 });
  assert.ok(!A.matchLines(A.voiceSegments(corto.hops.filter((h) => h.p <= 20000)), corto.lines).apply, 'poco audio');
}

// La duración medida de cada línea sirve para el relleno karaoke
{
  const r = mk({ instr: 'suave', shift: 1200, seed: 1, lineGap: [3600, 5200], voiceLen: [1500, 2300] });
  const m = A.matchLines(A.voiceSegments(r.hops), r.lines);
  assert.ok(m.apply);
  const dur = m.matched.filter((x) => !x.dentro).map((x) => x.e - x.s);
  const media = dur.reduce((a, b) => a + b, 0) / dur.length;
  assert.ok(media > 1200 && media < 3000, 'duraciones realistas: ' + Math.round(media));
}

console.log('alineación por voz: OK (' + (casos.length * 3) + ' canciones + 4 trampas)');
