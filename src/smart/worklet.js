// Mide la energía (RMS) cada 20 ms: entrada 0 = audio filtrado a la banda de la voz (300–3400 Hz), entrada 1 = audio completo.
class BandMeter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.n = 0; this.sv = 0; this.sa = 0; this.v = []; this.a = [];
  }
  static mono(chans, i) {
    if (!chans || !chans.length) return 0;
    let s = 0;
    for (let c = 0; c < chans.length; c++) s += chans[c][i];
    return s / chans.length;
  }
  process(inputs) {
    const band = inputs[0], full = inputs[1];
    const len = (band && band[0] && band[0].length) || (full && full[0] && full[0].length) || 0;
    for (let i = 0; i < len; i++) {
      const x = BandMeter.mono(band, i), y = BandMeter.mono(full, i);
      this.sv += x * x; this.sa += y * y; this.n++;
      if (this.n >= 320) {                       // 320 muestras a 16 kHz = 20 ms
        this.v.push(Math.sqrt(this.sv / this.n)); this.a.push(Math.sqrt(this.sa / this.n));
        this.n = 0; this.sv = 0; this.sa = 0;
        if (this.v.length >= 25) {               // se envía cada 0,5 s
          this.port.postMessage({ v: this.v, a: this.a });
          this.v = []; this.a = [];
        }
      }
    }
    return true;
  }
}
registerProcessor('band-meter', BandMeter);
