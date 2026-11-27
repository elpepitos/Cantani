const { spawn } = require('child_process');
const { EventEmitter } = require('events');

/** Lanza get-media.ps1 y emite 'sample' con cada lectura de la sesión multimedia. */
class MediaWatcher extends EventEmitter {
  constructor(scriptPath) {
    super();
    this.script = scriptPath;
    this.proc = null;
    this.stopped = false;
    this.failures = 0;
    this.lastSampleAt = 0;
    this.restarts = 0;
    this.watchdog = null;
  }

  start() {
    if (process.platform !== 'win32') {
      this.emit('unsupported');
      return;
    }
    this._spawn();
    // Vigilante: si PowerShell se queda mudo más de 6 s (consulta colgada), se reinicia solo
    this.watchdog = setInterval(() => {
      if (this.proc && Date.now() - this.lastSampleAt > 6000) {
        this.lastSampleAt = Date.now();
        this.restarts++;
        this.emit('log', 'watchdog: sin lecturas, reiniciando PowerShell');
        try { this.proc.kill(); } catch { /* ya muerto */ }
      }
    }, 2000);
  }

  _spawn() {
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script];
    this.lastSampleAt = Date.now();
    this.proc = spawn('powershell.exe', args, { windowsHide: true });
    let buf = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim().replace(/^﻿/, '');
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const sample = JSON.parse(line);
          this.failures = 0;
          this.lastSampleAt = Date.now();
          this.emit('sample', sample);
        } catch { /* línea corrupta: se ignora */ }
      }
    });
    this.proc.stderr.on('data', (d) => this.emit('log', String(d)));
    this.proc.on('error', (e) => this.emit('log', 'spawn error: ' + e.message));
    this.proc.on('exit', () => {
      if (this.stopped) return;
      this.failures++;
      const wait = Math.min(2000 * this.failures, 15000);
      setTimeout(() => !this.stopped && this._spawn(), wait);
    });
  }

  stop() {
    this.stopped = true;
    clearInterval(this.watchdog);
    try { this.proc && this.proc.kill(); } catch { /* ya muerto */ }
  }
}

module.exports = { MediaWatcher };
