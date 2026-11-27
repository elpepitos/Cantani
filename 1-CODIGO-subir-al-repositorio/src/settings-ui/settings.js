(() => {
  const FONTS = ['Segoe UI', 'Segoe UI Variable Display', 'Arial', 'Verdana', 'Trebuchet MS', 'Georgia', 'Impact', 'Comic Sans MS', 'Consolas'];

  const SECTIONS = [
    { title: 'Posición', custom: 'position' },
    { title: 'Texto', controls: [
      { key: 'fontFamily', type: 'select', label: 'Fuente', options: FONTS },
      { key: 'fontSize', type: 'range', label: 'Tamaño', min: 20, max: 120, step: 1, unit: 'px' },
      { key: 'fontWeight', type: 'range', label: 'Grosor', min: 300, max: 900, step: 100 },
      { key: 'activeColor', type: 'color', label: 'Color activo' },
      { key: 'dimColor', type: 'color', label: 'Color resto' },
      { key: 'dimOpacity', type: 'range', label: 'Opacidad resto', min: 0.1, max: 0.8, step: 0.02, fmt: (v) => Math.round(v * 100) + '%' }
    ] },
    { title: 'Efectos', controls: [
      { key: 'lightMode', type: 'switch', label: 'Modo ligero (menos CPU y GPU)' },
      { key: 'karaoke', type: 'switch', label: 'Relleno karaoke' },
      { key: 'fillLeadMs', type: 'range', label: 'Relleno: adelanto', min: -400, max: 400, step: 10, unit: ' ms' },
      { key: 'fillScalePct', type: 'range', label: 'Relleno: velocidad', min: 70, max: 130, step: 1, fmt: (v) => (v > 100 ? 'más lento ' : v < 100 ? 'más rápido ' : '') + v + '%' },
      { key: 'float', type: 'switch', label: 'Línea flotante' },
      { key: 'blurFar', type: 'switch', label: 'Desenfocar lejanas' },
      { key: 'glow', type: 'range', label: 'Brillo', min: 0, max: 40, step: 1, unit: 'px' },
      { key: 'shadow', type: 'range', label: 'Sombra', min: 0, max: 1, step: 0.05, fmt: (v) => Math.round(v * 100) + '%' },
      { key: 'animSpeed', type: 'range', label: 'Suavidad', min: 150, max: 1400, step: 10, unit: 'ms' }
    ] },
    { title: 'Pantalla y sincronía', controls: [
      { key: 'display', type: 'display', label: 'Monitor' },
      { key: 'linesVisible', type: 'range', label: 'Líneas visibles', min: 1, max: 13, step: 2 },
      { key: 'maxWidthPct', type: 'range', label: 'Ancho máximo', min: 20, max: 90, step: 1, unit: '%' },
      { key: 'lyricsSource', type: 'select', label: 'Fuente de letras', options: [['ytm-first', 'YouTube Music primero'], ['lrclib-first', 'LRCLIB primero'], ['lrclib', 'Solo LRCLIB']] },
      { key: 'syncOffsetMs', type: 'range', label: 'Adelantar/atrasar', min: -3000, max: 3000, step: 50, unit: 'ms' },
      { key: 'hideWhenPaused', type: 'switch', label: 'Ocultar en pausa' }
    ] }
  ];

  const grid = document.getElementById('grid');
  const inputs = {};
  let S = {};

  const set = (patch) => window.api.setSettings(patch);

  function fmtVal(c, v) {
    if (c.fmt) return c.fmt(v);
    return v + (c.unit || '');
  }

  function row(c) {
    const r = document.createElement('div');
    r.className = 'row' + (c.type === 'range' ? '' : ' noval');
    const lbl = document.createElement('label'); lbl.className = 'lbl'; lbl.textContent = c.label;
    r.appendChild(lbl);
    let el;
    if (c.type === 'range') {
      el = document.createElement('input'); el.type = 'range';
      el.min = c.min; el.max = c.max; el.step = c.step;
      const val = document.createElement('span'); val.className = 'val';
      el.addEventListener('input', () => { const v = parseFloat(el.value); val.textContent = fmtVal(c, v); set({ [c.key]: v }); });
      el._sync = (v) => { el.value = v; val.textContent = fmtVal(c, v); };
      r.appendChild(el); r.appendChild(val);
    } else if (c.type === 'color') {
      el = document.createElement('input'); el.type = 'color';
      el.addEventListener('input', () => set({ [c.key]: el.value }));
      el._sync = (v) => { el.value = v; };
      r.appendChild(el);
    } else if (c.type === 'select' || c.type === 'display') {
      el = document.createElement('select');
      if (c.type === 'select') c.options.forEach((o) => { const [val, text] = Array.isArray(o) ? o : [o, o]; const op = document.createElement('option'); op.value = val; op.textContent = text; el.appendChild(op); });
      el.addEventListener('change', () => set({ [c.key]: c.type === 'display' ? parseInt(el.value, 10) : el.value }));
      el._sync = (v) => { el.value = String(v); };
      r.appendChild(el);
    } else if (c.type === 'switch') {
      const wrap = document.createElement('label'); wrap.className = 'switch';
      el = document.createElement('input'); el.type = 'checkbox';
      const knob = document.createElement('span');
      el.addEventListener('change', () => set({ [c.key]: el.checked }));
      el._sync = (v) => { el.checked = !!v; };
      wrap.appendChild(el); wrap.appendChild(knob);
      r.appendChild(wrap);
    }
    inputs[c.key] = el;
    return r;
  }

  function positionCard() {
    const frag = document.createDocumentFragment();
    const pg = document.createElement('div'); pg.className = 'posgrid';
    const V = ['top', 'middle', 'bottom'], H = ['left', 'center', 'right'];
    const btns = [];
    V.forEach((v) => H.forEach((h) => {
      const b = document.createElement('button');
      b.title = `${{ top: 'Arriba', middle: 'Centro', bottom: 'Abajo' }[v]} · ${{ left: 'izquierda', center: 'centro', right: 'derecha' }[h]}`;
      b.addEventListener('click', () => set({ hAlign: h, vPos: v }));
      b._h = h; b._v = v; btns.push(b); pg.appendChild(b);
    }));
    inputs.__pos = { _sync: () => btns.forEach((b) => b.classList.toggle('sel', b._h === S.hAlign && b._v === S.vPos)) };
    frag.appendChild(pg);
    frag.appendChild(row({ key: 'marginX', type: 'range', label: 'Margen lateral', min: 0, max: 500, step: 5, unit: 'px' }));
    frag.appendChild(row({ key: 'marginY', type: 'range', label: 'Margen vertical', min: 0, max: 500, step: 5, unit: 'px' }));
    return frag;
  }

  SECTIONS.forEach((sec) => {
    const card = document.createElement('section'); card.className = 'card';
    const h = document.createElement('h2'); h.textContent = sec.title; card.appendChild(h);
    if (sec.custom === 'position') card.appendChild(positionCard());
    else sec.controls.forEach((c) => card.appendChild(row(c)));
    grid.appendChild(card);
  });

  function syncAll() {
    for (const [k, el] of Object.entries(inputs)) {
      if (k === '__pos') el._sync(); else if (k in S) el._sync(S[k]);
    }
    document.getElementById('enabled').checked = !!S.enabled;
  }

  // ----- cabecera / estado -----
  const eq = document.getElementById('eq');
  const nowTitle = document.getElementById('nowTitle');
  const nowSub = document.getElementById('nowSub');
  const demoBtn = document.getElementById('demoBtn');
  let demoOn = false;
  let detector = { supported: true, error: '' };

  const syncVal = document.getElementById('syncVal');
  const syncCard = document.getElementById('syncCard');
  const syncHint = document.getElementById('syncHint');
  const HINT = syncHint.innerHTML;
  function renderOffset(ms) { syncVal.textContent = `${ms > 0 ? '+' : ''}${ms} ms`; }
  document.querySelectorAll('#syncCard [data-d]').forEach((b) => b.addEventListener('click', () => window.api.adjustOffset(parseInt(b.dataset.d, 10))));
  document.getElementById('syncReset').addEventListener('click', () => window.api.resetOffset());

  function renderTrack(t) {
    demoOn = !!t.demo;
    syncCard.classList.toggle('disabled', !t.active || demoOn);
    renderOffset(t.songOffsetMs || 0);
    syncHint.innerHTML = t.approx ? 'Esta letra es de otra versión de la canción y puede ir desfasada: ajústala aquí o con el teclado.' : HINT;
    demoBtn.classList.toggle('on', demoOn);
    demoBtn.textContent = demoOn ? 'Detener demostración' : 'Probar con letra de ejemplo';
    eq.classList.toggle('on', !!t.active);
    if (!t.active) {
      nowTitle.textContent = 'Esperando música…';
      nowSub.textContent = detector.supported ? (detector.error || 'Pon algo en Spotify o YouTube') : detector.error;
      return;
    }
    nowTitle.textContent = t.title || '(sin título)';
    const st = { loading: 'buscando letra…', found: 'letra sincronizada ✓', none: 'sin letra sincronizada', idle: '' }[t.lyricsState] || '';
    nowSub.textContent = [t.artist, st].filter(Boolean).join(' · ');
  }

  document.getElementById('enabled').addEventListener('change', (e) => set({ enabled: e.target.checked }));
  demoBtn.addEventListener('click', () => window.api.setDemo(!demoOn));
  document.getElementById('resetBtn').addEventListener('click', () => window.api.resetSettings());

  window.api.onSettings((s) => { S = s; syncAll(); });
  const diagEl = document.getElementById('diag');
  const rb = document.getElementById('copyReport');
  if (rb) rb.addEventListener('click', async () => { await window.api.copyReport(); rb.textContent = '¡Copiado! Pégalo en el chat (Ctrl+V)'; setTimeout(() => { rb.textContent = 'Copiar informe (para mandarlo a quien te ayuda)'; }, 3500); });
  const fmt = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)} s`);
  window.api.onDiag((d) => {
    const dur = d.durationMs ? d.durationMs / 1000 : 0;
    const verdict = d.lyricsDurationSec && dur
      ? (Math.abs(d.lyricsDurationSec - dur) <= 6 ? 'coincide' : `DIFIERE ${Math.round(d.lyricsDurationSec - dur)} s`)
      : '—';
    diagEl.textContent = [
      `Reproductor:        ${d.app || '—'}  (${d.playing ? 'reproduciendo' : 'en pausa'})`,
      `Modo de posición:   ${d.mode || '—'}${d.hasTimeline ? '' : '  (cuenta propia)'}`,
      `Posición leída:     ${fmt(d.rawPositionMs)}   edad de la marca: ${d.updatedAgeMs == null ? '—' : fmt(d.updatedAgeMs)}`,
      `Posición estimada:  ${fmt(d.estimatedPositionMs)}   duración: ${fmt(d.durationMs)}`,
      `Ajustes:            global ${d.globalOffsetMs} ms · canción ${d.songOffsetMs} ms`,
      `Fuente de la letra: ${d.lyricsSource || '—'}`,
      `Letra:              ${d.lyricsState}${d.approx ? ' (otra versión)' : ''} · ${d.lineCount} líneas · dura ${d.lyricsDurationSec ? d.lyricsDurationSec + ' s' : '—'} (${verdict})`,
      `Estabilidad:        correcciones ${d.pos ? d.pos.corrections : 0} · mayor ${d.pos ? d.pos.maxAbsMs : 0} ms · saltos >0,5 s: ${d.pos ? d.pos.bigJumps : 0} · mayor hueco entre lecturas ${d.maxGapMs || 0} ms · reinicios PS ${d.restarts || 0}`,
      `Primera palabra:    ${fmt(d.firstTextLineMs)}`
    ].join('\n');
  });
  window.api.onTrack(renderTrack);
  window.api.onOffset((d) => renderOffset(d.songOffsetMs || 0));

  (async () => {
    const [s, displays, st] = await Promise.all([window.api.getSettings(), window.api.getDisplays(), window.api.getState()]);
    const sel = inputs.display;
    displays.forEach((d) => { const op = document.createElement('option'); op.value = d.index; op.textContent = d.label; sel.appendChild(op); });
    S = s; syncAll();
    detector = st.detector;
    renderTrack({ ...st.track, songOffsetMs: st.songOffsetMs });
  })();
})();
