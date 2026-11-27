// Ventana oculta y temporal: escucha el audio del sistema y manda su energía al programa principal.
(async () => {
  const api = window.smartApi;
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    stream.getVideoTracks().forEach((t) => t.stop());          // el vídeo no se usa: se corta enseguida
    const audio = stream.getAudioTracks();
    if (!audio.length) throw new Error('Windows no dio audio del sistema');
    const ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'playback' });
    await ctx.audioWorklet.addModule('worklet.js');
    const src = ctx.createMediaStreamSource(new MediaStream(audio));
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 300;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3400;
    const meter = new AudioWorkletNode(ctx, 'band-meter', { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1] });
    const mute = ctx.createGain(); mute.gain.value = 0;
    src.connect(hp); hp.connect(lp); lp.connect(meter, 0, 0); src.connect(meter, 0, 1);
    meter.connect(mute); mute.connect(ctx.destination);        // silencio; solo mantiene el grafo en marcha
    meter.port.onmessage = (e) => api.hops({ at: Date.now(), v: e.data.v, a: e.data.a });
    api.ready();
  } catch (e) {
    api.error(String((e && e.message) || e));
  }
})();
