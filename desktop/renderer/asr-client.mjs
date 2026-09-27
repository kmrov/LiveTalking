export function createPcmResampler(inputRate, outputRate = 16000) {
  if (!(inputRate > 0 && outputRate > 0)) throw new Error('Invalid audio sample rate');
  const ratio = inputRate / outputRate;
  let buffer = [];
  let position = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let last = 0;
  const signed = value => {
    const clipped = Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
    return Math.round(clipped < 0 ? clipped * 32768 : clipped * 32767);
  };
  function collect(final = false) {
    const output = [];
    const target = Math.floor(totalInput / ratio);
    while (totalOutput < target) {
      const index = Math.floor(position);
      if (!final && index + 1 >= buffer.length) break;
      const left = buffer[index] ?? last;
      const right = buffer[index + 1] ?? left;
      output.push(signed(left + (right - left) * (position - index)));
      position += ratio;
      totalOutput++;
    }
    const consumed = Math.min(Math.floor(position), buffer.length);
    buffer = buffer.slice(consumed);
    position -= consumed;
    return Int16Array.from(output);
  }
  return {
    push(input) {
      if (input.length) last = input[input.length - 1];
      buffer.push(...input);
      totalInput += input.length;
      return collect();
    },
    flush: () => collect(true),
  };
}

export function createAsrClient({ getUserMedia, AudioContext, WebSocket, AudioWorkletNode = globalThis.AudioWorkletNode, baseUrl, onState = () => {}, onText = () => {}, workletUrl = new URL('./pcm-worklet.js', import.meta.url).href }) {
  let stream;
  let context;
  let source;
  let worklet;
  let socket;
  let resampler;
  let state = 'idle';
  let generation = 0;
  let finalResolve;
  let finalReject;
  let finalTimer;

  function setState(next, detail = '') { state = next; onState(next, detail); }
  async function releaseCapture() {
    source?.disconnect();
    worklet?.disconnect();
    source = null;
    worklet = null;
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    const previous = context;
    context = null;
    if (previous) await previous.close().catch(() => {});
  }
  function closeSocket() {
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
    socket.close();
    socket = null;
  }
  function fail(error) {
    ++generation;
    clearTimeout(finalTimer);
    void releaseCapture();
    closeSocket();
    setState('failed', error.message || 'ASR connection failed');
    finalReject?.(error);
    finalResolve = finalReject = null;
  }

  async function start() {
    if (['starting', 'capturing', 'transcribing'].includes(state)) return;
    const token = ++generation;
    setState('starting');
    try {
      stream = await getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (token !== generation) throw new Error('Microphone capture cancelled');
      const address = new URL('/api/asr', baseUrl);
      address.protocol = address.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(address.href);
      await new Promise((resolve, reject) => {
        socket.onopen = resolve;
        socket.onerror = () => { const error = new Error('Ошибка соединения ASR'); fail(error); reject(error); };
        socket.onclose = () => { const error = new Error('ASR connection closed'); fail(error); reject(error); };
      });
      if (token !== generation) throw new Error('Microphone capture cancelled');
      socket.onmessage = event => {
        try {
          const result = JSON.parse(event.data);
          if (result.error) { fail(new Error(result.error)); return; }
          if (!result.is_final) return;
          clearTimeout(finalTimer);
          const text = (result.text || '').trim();
          if (text) onText(text);
          setState(text ? 'ready' : 'empty');
          finalResolve?.(text);
          finalResolve = finalReject = null;
          void releaseCapture();
          closeSocket();
        } catch (error) { fail(error); }
      };
      context = new AudioContext({ sampleRate: 16000 });
      await context.audioWorklet.addModule(workletUrl);
      await context.resume();
      if (token !== generation) throw new Error('Microphone capture cancelled');
      resampler = createPcmResampler(context.sampleRate);
      worklet = new AudioWorkletNode(context, 'livetalking-pcm');
      worklet.port.onmessage = event => {
        if (state !== 'capturing' || !socket) return;
        const pcm = resampler.push(event.data);
        if (pcm.length) socket.send(pcm.buffer);
      };
      source = context.createMediaStreamSource(stream);
      socket.send(JSON.stringify({ mode: 'offline', is_speaking: true, wav_name: 'desktop', audio_fs: 16000, itn: true }));
      setState('capturing');
      source.connect(worklet);
      worklet.connect(context.destination);
    } catch (error) { fail(error); throw error; }
  }

  async function stop() {
    if (state !== 'capturing') return '';
    setState('transcribing');
    const result = new Promise((resolve, reject) => { finalResolve = resolve; finalReject = reject; });
    void result.catch(() => {});
    finalTimer = setTimeout(() => fail(new Error('ASR transcription timed out')), 130000);
    const tail = resampler.flush();
    if (tail.length) socket.send(tail.buffer);
    socket.send(JSON.stringify({ is_speaking: false }));
    await releaseCapture();
    return result;
  }

  function dispose() {
    ++generation;
    clearTimeout(finalTimer);
    void releaseCapture();
    closeSocket();
    finalReject?.(new Error('Microphone capture cancelled'));
    finalResolve = finalReject = null;
    setState('idle');
  }
  return { start, stop, dispose };
}
