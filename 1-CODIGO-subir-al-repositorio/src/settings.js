const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  enabled: true,
  hAlign: 'left',      // left | center | right
  vPos: 'middle',      // top | middle | bottom
  marginX: 60,
  marginY: 60,
  fontFamily: 'Segoe UI',
  fontSize: 46,
  fontWeight: 700,
  activeColor: '#ffffff',
  dimColor: '#ffffff',
  dimOpacity: 0.38,
  glow: 8,
  shadow: 0.5,
  linesVisible: 7,
  maxWidthPct: 42,
  animSpeed: 650,
  lightMode: true,
  karaoke: true,
  fillLeadMs: 0,
  fillScalePct: 100,
  float: true,
  blurFar: false,
  hideWhenPaused: true,
  syncOffsetMs: 0,
  lyricsSource: 'ytm-first',
  display: 0
};

class Store {
  constructor(file) {
    this.file = file;
    this.data = { ...DEFAULTS };
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data = { ...DEFAULTS, ...this._sanitize(saved) };
    } catch { /* primera ejecución */ }
    this._timer = null;
  }

  _sanitize(patch) {
    const out = {};
    for (const [k, v] of Object.entries(patch || {})) {
      if (k in DEFAULTS && typeof v === typeof DEFAULTS[k] && !(typeof v === 'number' && !Number.isFinite(v))) out[k] = v;
    }
    return out;
  }

  get() { return { ...this.data }; }

  set(patch) {
    Object.assign(this.data, this._sanitize(patch));
    this._queueSave();
    return this.get();
  }

  reset() {
    this.data = { ...DEFAULTS };
    this._queueSave();
    return this.get();
  }

  _queueSave() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 400);
  }

  flush() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch { /* disco lleno o sin permisos */ }
  }
}

module.exports = { Store, DEFAULTS };
