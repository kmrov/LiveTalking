import { createPcmResampler } from './asr-client.mjs';
import { createVoiceActivityDetector } from './voice-activity.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createContinuousVoiceClient({ getUserMedia, AudioContext, AudioWorkletNode = globalThis.AudioWorkletNode,
  WebSocket, baseUrl, onState = () => {}, onLevel = () => {}, onTurn = async () => {}, onBargeIn = () => {},
  allowBargeIn = false, pause = delay, transcriptionTimeoutMs = 130000,
  workletUrl = new URL('./pcm-worklet.js', import.meta.url).href }) {
  let stream;
  let context;
  let source;
  let worklet;
  let socket;
  let detector;
  let resampler;
  let state = 'idle';
  let generation = 0;
  let turnGeneration = 0;
  let turnAbort;
  let socketOpenReject;
  let finalTimer;
  let discardFinal = false;
  let bargeInPending = Promise.resolve();
  let levelDuration = 0;
  let peakLevel = 0;

  const setState = (next, detail = '') => { state = next; onState(next, detail); };
  function sendAudio(pcm) {
    if (socket?.readyState !== undefined && socket.readyState !== 1) return;
    socket?.send(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
  }

  async function release() {
    clearTimeout(finalTimer); finalTimer = null;
    levelDuration = peakLevel = 0;
    socketOpenReject?.(new Error('Microphone capture cancelled'));
    socketOpenReject = null;
    source?.disconnect(); source = null;
    worklet?.disconnect(); worklet = null;
    stream?.getTracks().forEach(track => track.stop()); stream = null;
    const previous = socket; socket = null;
    if (previous) {
      previous.onopen = previous.onmessage = previous.onerror = previous.onclose = null;
      previous.close();
    }
    const oldContext = context; context = null;
    if (oldContext) await oldContext.close().catch(() => {});
    detector = resampler = null;
  }

  function fail(error) {
    if (state === 'idle' || state === 'failed') return;
    ++generation;
    turnAbort?.abort(); turnAbort = null;
    void release();
    setState('failed', error?.message || 'Recognition error');
  }

  function finishTurn(text, token) {
    if (token !== generation || state !== 'transcribing') return;
    clearTimeout(finalTimer); finalTimer = null;
    if (discardFinal) { discardFinal = false; detector.reset(); setState('listening'); return; }
    if (!text) { detector.reset(); setState('listening'); return; }
    setState('waiting');
    const turn = ++turnGeneration;
    turnAbort = new AbortController();
    const signal = turnAbort.signal;
    Promise.resolve().then(() => bargeInPending).then(() => onTurn(text, { signal }))
      .then(() => pause(350))
      .then(() => {
        if (token !== generation || turn !== turnGeneration || state !== 'waiting') return;
        turnAbort = null;
        detector.reset();
        setState('listening');
      })
      .catch(error => { if (token === generation && turn === turnGeneration) fail(error); });
  }

  async function start() {
    if (!['idle', 'failed'].includes(state)) return;
    const token = ++generation;
    levelDuration = peakLevel = 0;
    setState('starting');
    try {
      const acquired = await getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (token !== generation) {
        acquired.getTracks().forEach(track => track.stop());
        throw new Error('Microphone capture cancelled');
      }
      stream = acquired;
      const address = new URL('/api/asr', baseUrl);
      address.protocol = address.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(address.href);
      await new Promise((resolve, reject) => {
        socketOpenReject = reject;
        socket.onopen = () => { socketOpenReject = null; resolve(); };
        socket.onerror = () => { socketOpenReject = null; reject(new Error('ASR connection error')); };
        socket.onclose = () => { socketOpenReject = null; reject(new Error('ASR connection closed')); };
      });
      if (token !== generation) throw new Error('Microphone capture cancelled');
      socket.onerror = () => fail(new Error('ASR connection error'));
      socket.onclose = () => fail(new Error('ASR connection closed'));
      socket.onmessage = event => {
        try {
          const result = JSON.parse(event.data);
          if (result.error) { fail(new Error(result.error)); return; }
          if (result.is_final) finishTurn((result.text || '').trim(), token);
        } catch (error) { fail(error); }
      };

      context = new AudioContext({ sampleRate: 16000 });
      await context.audioWorklet.addModule(workletUrl);
      await context.resume();
      if (token !== generation) throw new Error('Microphone capture cancelled');
      resampler = createPcmResampler(context.sampleRate);
      detector = createVoiceActivityDetector({
        onLevel: (level, duration) => {
          levelDuration += duration;
          peakLevel = Math.max(peakLevel, level);
          if (levelDuration >= 200) {
            onLevel(peakLevel);
            levelDuration = peakLevel = 0;
          }
        },
        onStart: buffered => {
          if (state === 'waiting' && allowBargeIn) {
            ++turnGeneration;
            turnAbort?.abort(); turnAbort = null;
            bargeInPending = Promise.resolve().then(onBargeIn);
            void bargeInPending.catch(fail);
          }
          if (!['listening', 'waiting'].includes(state)) return;
          discardFinal = false;
          socket.send(JSON.stringify({ mode: 'offline', is_speaking: true, wav_name: 'desktop-auto', audio_fs: 16000, itn: true }));
          for (const part of buffered) sendAudio(part);
          setState('capturing');
        },
        onAudio: sendAudio,
        onEnd: accepted => {
          if (state !== 'capturing') return;
          discardFinal = !accepted;
          socket.send(JSON.stringify({ is_speaking: false }));
          setState('transcribing');
          finalTimer = setTimeout(() => fail(new Error('ASR transcription timed out')), transcriptionTimeoutMs);
        },
      });
      worklet = new AudioWorkletNode(context, 'livetalking-pcm');
      worklet.port.onmessage = event => {
        if (token !== generation || !resampler || !detector) return;
        const pcm = resampler.push(event.data);
        if (state === 'listening' || state === 'capturing' || state === 'waiting' && allowBargeIn) {
          detector.feed(pcm, { thresholdMultiplier: state === 'waiting' ? 1.8 : 1 });
        }
      };
      source = context.createMediaStreamSource(stream);
      source.connect(worklet);
      worklet.connect(context.destination);
      setState('listening');
    } catch (error) {
      if (token === generation) fail(error);
      throw error;
    }
  }

  async function stop() {
    ++generation;
    ++turnGeneration;
    turnAbort?.abort(); turnAbort = null;
    await release();
    setState('idle');
  }

  return { start, stop, state: () => state };
}
