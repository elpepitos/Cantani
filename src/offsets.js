const fs = require('fs');
const path = require('path');

/** Recuerda el ajuste de sincronía (ms) de cada canción: { "artista|título": ms }. */
class OffsetStore {
  constructor(file) {
    this.file = file;
    this.map = {};
    try { this.map = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { /* primera vez */ }
    this._timer = null;
  }

  static keyFor(artist, title) {
    return `${artist || ''}|${title || ''}`.toLowerCase().trim();
  }

  get(key) { return Number.isFinite(this.map[key]) ? this.map[key] : 0; }

  has(key) { return Number.isFinite(this.map[key]); }

  /** Mediana de los ajustes que has hecho a mano (si hay al menos `min`): sirve de valor inicial para canciones nuevas. */
  learned(min = 3, limit = 3000) {
    const v = Object.values(this.map).filter(Number.isFinite).sort((a, b) => a - b);
    if (v.length < min) return 0;
    const mid = v.length >> 1;
    const med = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
    return Math.max(-limit, Math.min(limit, Math.round(med / 10) * 10));
  }

  set(key, ms) {
    if (!key) return;
    if (!ms) delete this.map[key]; else this.map[key] = ms;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 400);
  }

  flush() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.map, null, 2));
    } catch { /* disco lleno o sin permisos */ }
  }
}

module.exports = { OffsetStore };
