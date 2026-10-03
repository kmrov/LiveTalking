export function createVoiceActivityDetector({ sampleRate = 16000, onStart = () => {}, onAudio = () => {}, onEnd = () => {}, onLevel = () => {},
  silenceMs = 900, startMs = 180, minVoiceMs = 250, preRollMs = 450, maxUtteranceMs = 25000 } = {}) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error('Invalid voice activity sample rate');
  let noiseFloor = 0.003;
  let preRoll = [];
  let preRollDuration = 0;
  let candidateMs = 0;
  let voiceMs = 0;
  let quietMs = 0;
  let utteranceMs = 0;
  let active = false;

  function reset() {
    preRoll = [];
    preRollDuration = candidateMs = voiceMs = quietMs = utteranceMs = 0;
    active = false;
  }

  function feed(pcm, { thresholdMultiplier = 1 } = {}) {
    if (!(pcm instanceof Int16Array) || !pcm.length) return;
    const duration = pcm.length * 1000 / sampleRate;
    let power = 0;
    for (const sample of pcm) power += sample * sample;
    const rms = Math.sqrt(power / pcm.length) / 32768;
    onLevel(rms, duration);
    const voiced = rms >= Math.max(0.008, noiseFloor * 2.7) * thresholdMultiplier;

    if (!active) {
      preRoll.push(pcm);
      preRollDuration += duration;
      while (preRollDuration > preRollMs && preRoll.length > 1) {
        preRollDuration -= preRoll.shift().length * 1000 / sampleRate;
      }
      if (voiced) candidateMs += duration;
      else {
        candidateMs = Math.max(0, candidateMs - duration * 2);
        noiseFloor = noiseFloor * 0.98 + rms * 0.02;
      }
      if (candidateMs >= startMs) {
        active = true;
        voiceMs = candidateMs;
        utteranceMs = preRollDuration;
        onStart(preRoll);
        preRoll = [];
        preRollDuration = 0;
      }
      return;
    }

    utteranceMs += duration;
    if (voiced) { voiceMs += duration; quietMs = 0; }
    else quietMs += duration;
    onAudio(pcm);
    if (quietMs >= silenceMs || utteranceMs >= maxUtteranceMs) {
      onEnd(voiceMs >= minVoiceMs);
      reset();
    }
  }

  return { feed, reset };
}
