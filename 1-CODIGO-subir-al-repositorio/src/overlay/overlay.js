(() => {
  const stage = document.getElementById('stage');
  const linesEl = document.getElementById('lines');
  const root = document.documentElement;

  let S = null;                 // ajustes
  let lines = [];               // [{t,text}]
  let els = [];                 // elementos .line
  let words = [];               // por línea: [{el, start, len}] y total de caracteres
  let songOffset = 0;           // ajuste recordado para la canción actual (ms)
  let toastTimer = null;
  let idx = -2;                 // línea activa (-1 = aún no empieza)
  let timing = { playing: false, positionMs: 0, sampledAt: Date.now() };
  let track = { active: false, lyricsState: 'idle' };
  let msgTimer = null;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function hexToRgba(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return `rgba(255,255,255,${a})`;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  // ---------- ajustes -> CSS ----------
  function applySettings(s) {
    S = s;
    root.style.setProperty('--font', `'${s.fontFamily}'`);
    root.style.setProperty('--fs', s.fontSize + 'px');
    root.style.setProperty('--fw', s.fontWeight);
    root.style.setProperty('--active', s.activeColor);
    root.style.setProperty('--dim', s.dimColor);
    root.style.setProperty('--unfilled', hexToRgba(s.dimColor, 0.5));
    root.style.setProperty('--glowc', s.activeColor);
    root.style.setProperty('--glow-px', s.glow + 'px');
    root.style.setProperty('--shadow', s.shadow);
    root.style.setProperty('--speed', s.animSpeed + 'ms');
    const ta = s.hAlign;
    root.style.setProperty('--ta', ta);
    root.style.setProperty('--origin', ta === 'left' ? 'left center' : ta === 'right' ? 'right center' : 'center');
    document.body.classList.toggle('karaoke', !!s.karaoke);
    document.body.classList.toggle('float', !!s.float);
    document.body.classList.toggle('light', !!s.lightMode);

    // El escenario llena toda la ventana (la ventana ya tiene el tamaño y la posición de la letra)
    stage.style.cssText = 'left:0;top:0;width:100%;height:100%;';

    updateVisibility();
    // El tamaño de letra cambia las alturas: re-centrar y re-estilizar sin saltos
    requestAnimationFrame(() => { if (els.length) { styleLines(); recenter(); } });
  }

  // ---------- construir letras ----------
  function setLines(arr) {
    clearTimeout(msgTimer);
    lines = window.LyricsTiming.cleanIntro(arr || []);
    linesEl.textContent = '';
    words = [];
    const T = window.LyricsTiming;
    // Modelo de cada línea (sílabas + pausas) y velocidad típica de la canción
    const models = lines.map((l) => (l.words ? null : T.lineModel(l.text || '♪')));
    const pace = T.songPace(lines, models);
    const paces = T.localPaces(lines, models, pace);
    els = lines.map((l, j) => {
      const div = document.createElement('div');
      div.className = 'line';
      const span = document.createElement('span');
      span.className = 't';
      const info = { list: [], total: 0, real: false, fillMs: 0, realWords: null };
      const addWord = (txt, extra) => {
        const ws = document.createElement('span');
        ws.className = 'w';
        const wb = document.createElement('span'); wb.className = 'b'; wb.textContent = txt;
        const wf = document.createElement('span'); wf.className = 'f'; wf.textContent = txt; wf.setAttribute('aria-hidden', 'true');
        ws.appendChild(wb); ws.appendChild(wf);
        span.appendChild(ws);
        info.list.push({ el: ws, ...extra });
      };
      if (l.words) {
        // La letra trae tiempos reales por palabra: se usan tal cual
        info.real = true;
        info.realWords = l.words;
        l.words.forEach((w) => {
          addWord(w.text.trim(), {});
          if (/\s$/.test(w.text)) span.appendChild(document.createTextNode(' '));
        });
      } else {
        const m = models[j];
        m.tokens.forEach((tok, i) => {
          addWord(tok.text, tok);
          if (i < m.tokens.length - 1) span.appendChild(document.createTextNode(' '));
        });
        info.total = m.total;
        const next = lines[j + 1];
        info.fillMs = T.fillDuration(next ? next.t - l.t : 4000, m.total, paces[j]);
      }
      words.push(info);
      div.appendChild(span);
      linesEl.appendChild(div);
      return div;
    });
    idx = -2;
    linesEl.classList.add('instant');
    styleLines(-1);
    recenter();
    requestAnimationFrame(() => requestAnimationFrame(() => linesEl.classList.remove('instant')));
    updateVisibility();
  }

  function showMessage(text) {
    setLines([{ t: 0, text }]);
    idx = 0;
    styleLines(0);
    recenter();
    stage.classList.remove('hidden');
    msgTimer = setTimeout(() => stage.classList.add('hidden'), 4500);
  }

  // ---------- estilo por distancia a la línea activa ----------
  function styleLines(active = idx) {
    if (!S) return;
    const half = Math.floor(S.linesVisible / 2) + 1;
    for (let j = 0; j < els.length; j++) {
      const el = els[j];
      const d = j - active;
      const a = Math.abs(d);
      let o, sc, b;
      if (active === -1) {            // antes de la primera línea: todo tenue
        o = j <= half ? S.dimOpacity * Math.max(0, 1 - j * 0.28) : 0;
        sc = 0.9; b = S.blurFar ? Math.min(j, 4) * 0.9 : 0;
      } else if (d === 0) { o = 1; sc = 1; b = 0; }
      else if (a > half) { o = 0; sc = 0.84; b = 0; }
      else {
        o = S.dimOpacity * Math.max(0, 1 - (a - 1) * 0.28);
        sc = 0.9 - Math.min(a, 3) * 0.02;
        b = S.blurFar ? Math.min(a, 4) * 0.9 : 0;
      }
      el.style.setProperty('--o', o.toFixed(3));
      el.style.setProperty('--s', sc.toFixed(3));
      el.style.setProperty('--b', b.toFixed(2) + 'px');
      el.classList.toggle('active', d === 0 && active >= 0);
    }
  }

  // Relleno por palabra. Con tiempos reales se usan; si no, se reparte por sílabas y pausas.
  // Solo se toca el estilo cuando el relleno cambió de verdad (menos trabajo por fotograma = menos tirones)
  function setWp(w, v) {
    if (w.last !== undefined && (v === w.last || (Math.abs(v - w.last) < 0.004 && v > 0 && v < 1))) return;
    w.last = v;
    w.el.style.setProperty('--wp', v.toFixed(3));
  }

  function fillWords(j, pos) {
    const info = words[j];
    if (!info) return;
    const T = window.LyricsTiming;
    if (info.real) {
      const lineEnd = lines[j + 1] ? lines[j + 1].t : lines[j].t + 4000;
      info.list.forEach((w, i) => setWp(w, T.realWordProgress(info.realWords, i, pos, lineEnd)));
      return;
    }
    const lead = S ? (S.fillLeadMs || 0) : 0, scale = S ? (S.fillScalePct || 100) / 100 : 1;
    const done = clamp((pos + lead - lines[j].t) / (info.fillMs * scale), 0, 1) * info.total;
    for (const w of info.list) setWp(w, T.wordProgress(w, done));
  }

  function toast(text, ms = 1400) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  function recenter() {
    if (!els.length) return;
    const target = idx >= 0 ? els[idx] : els[0];
    const y = stage.clientHeight / 2 - (target.offsetTop + target.offsetHeight / 2);
    linesEl.style.transform = `translateY(${y}px)`;
  }

  // ---------- tiempo ----------
  // Corrección suave: cuando Windows corrige la posición unos cientos de ms, no saltamos de golpe;
  // la diferencia se va absorbiendo (constante ~700 ms). Los saltos grandes (adelantar la canción) sí son inmediatos.
  let slew = 0, slewAt = 0;
  const SLEW_TAU = 700, SLEW_MAX = 3000;
  function slewNow() {
    return slew ? slew * Math.exp(-(Date.now() - slewAt) / SLEW_TAU) : 0;
  }
  function predicted() {
    return timing.positionMs + (timing.playing ? Date.now() - timing.sampledAt : 0) + slewNow();
  }
  function currentPos() { return predicted() + (S ? S.syncOffsetMs : 0) + songOffset; }

  function findIndex(pos) {
    let lo = 0, hi = lines.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].t <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  function updateVisibility() {
    const show = track.active && lines.length > 0 && !(S && S.hideWhenPaused && !timing.playing);
    if (track.lyricsState === 'none') return; // el mensaje gestiona su propia visibilidad
    stage.classList.toggle('hidden', !show);
  }

  let lastFrameAt = 0;
  let filled = false;   // en pausa se deja de recalcular el relleno
  function frame() {
    if (stage.classList.contains('hidden')) { requestAnimationFrame(frame); return; }
    // Modo ligero: el relleno se actualiza a ~30 fotogramas por segundo (la mitad de trabajo)
    const tNow = performance.now();
    if (S && S.lightMode && tNow - lastFrameAt < 30) { requestAnimationFrame(frame); return; }
    lastFrameAt = tNow;  // oculto: nada que calcular
    if (S && lines.length && track.lyricsState === 'found') {
      const pos = currentPos();
      const i = findIndex(pos);
      if (i !== idx) {
        idx = i;
        filled = false;
        styleLines();
        recenter();
      }
      if (S.karaoke && idx >= 0 && (timing.playing || !filled)) { fillWords(idx, pos); filled = true; }
    }
    requestAnimationFrame(frame);
  }

  // ---------- eventos ----------
  window.api.onSettings(applySettings);

  window.api.onTrack((t) => {
    const prevKey = track.title + '|' + track.artist + '|' + (track.demo ? 'd' : '');
    const prevState = track.lyricsState;
    track = t;
    songOffset = t.songOffsetMs || 0;
    const key = t.title + '|' + t.artist + '|' + (t.demo ? 'd' : '');
    if (t.lyricsState === 'found' && t.lyrics) {
      if (key !== prevKey || prevState !== 'found') {
        setLines(t.lyrics);
        if (t.backup && !t.approx && !t.demo) toast('Letra de respaldo (YouTube Music no respondió): puede ir desfasada', 5000);
        else if (t.approx && !t.demo) toast('Letra de otra versión: puede ir desfasada. Ajusta con Ctrl+Alt+← / →', 5000);
      }
    } else if (t.lyricsState === 'none') {
      showMessage('♪  Sin letra sincronizada para esta canción');
    } else {
      setLines([]);
    }
    updateVisibility();
  });

  // Ctrl+Alt+↑ justo cuando se oye empezar una línea: calcula el ajuste exacto de la canción
  window.api.onCalibrate(() => {
    if (!lines.length || track.demo || track.lyricsState !== 'found') return;
    const base = predicted() + (S ? S.syncOffsetMs : 0);
    const T = window.LyricsTiming;
    const i = T.nearestLine(lines, base + songOffset);
    if (i < 0) { toast('Pulsa cuando empiece a cantarse una línea (acércate con Ctrl+Alt+←/→)', 3500); return; }
    window.api.setOffset(T.calibratedOffset(lines[i].t, base));
  });

  // Letra desfasada por muchos segundos: pulsa cuando oigas la PRIMERA línea cantada y se alinea esa línea con el ahora
  window.api.onCalibrateFirst(() => {
    if (!lines.length || track.demo || track.lyricsState !== 'found') return;
    const base = predicted() + (S ? S.syncOffsetMs : 0);
    window.api.setOffset(window.LyricsTiming.calibratedOffset(lines[0].t, base, 180, 60000));
  });

  window.api.onOffset((d) => {
    songOffset = d.songOffsetMs || 0;
    if (d.toast) toast(`Sincronía de esta canción: ${songOffset > 0 ? '+' : ''}${songOffset} ms`);
  });

  window.api.onTiming((t) => {
    if (!t.playing) filled = false;
    // Ignora micro-ajustes para que las líneas no parpadeen en los bordes
    if (t.playing && timing.playing) {
      const shown = predicted();                         // lo que se ve ahora mismo
      const drift = t.positionMs - shown;
      if (Math.abs(drift) < 60) { /* micro-ajuste: se ignora */ }
      else if (Math.abs(drift) < SLEW_MAX) {
        timing = t;                                      // ancla nueva...
        slew = -drift; slewAt = Date.now();              // ...pero la pantalla se acerca poco a poco
      } else { timing = t; slew = 0; }                   // salto grande (seek, cambio de canción)
    } else { timing = t; slew = 0; }
    updateVisibility();
  });

  Promise.all([window.api.getSettings()]).then(([s]) => {
    applySettings(s);
    requestAnimationFrame(frame);
  });
})();
