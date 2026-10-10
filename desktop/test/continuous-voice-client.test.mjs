import test from 'node:test';
import assert from 'node:assert/strict';

const { createContinuousVoiceClient } = await import('../renderer/continuous-voice-client.mjs').catch(() => ({}));

class FakeSocket {
  static latest;
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    FakeSocket.latest = this;
    queueMicrotask(() => this.onopen?.());
  }
  send(payload) { this.sent.push(payload); }
  close() { this.closed = true; }
  result(text) { this.onmessage?.({ data: JSON.stringify({ text, is_final: true }) }); }
  partial(text) { this.onmessage?.({ data: JSON.stringify({ text, is_final: false }) }); }
}

class FakeContext {
  constructor() { this.sampleRate = 16000; this.destination = {}; this.audioWorklet = { addModule: async () => {} }; }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
}

class FakeWorklet {
  static latest;
  constructor() { this.port = {}; FakeWorklet.latest = this; }
  connect() {}
  disconnect() {}
}

const tick = () => new Promise(resolve => setImmediate(resolve));
function feed(amplitude, count) {
  for (let i = 0; i < count; i++) FakeWorklet.latest.port.onmessage({ data: new Float32Array(160).fill(amplitude) });
}
const controls = socket => socket.sent.filter(payload => typeof payload === 'string').map(payload => JSON.parse(payload));

test('one microphone session recognizes consecutive phrases and sends each to the conversation', async () => {
  assert.equal(typeof createContinuousVoiceClient, 'function');
  let stopped = 0;
  const turns = [];
  const client = createContinuousVoiceClient({
    getUserMedia: async () => ({ getTracks: () => [{ stop: () => stopped++ }] }),
    AudioContext: FakeContext, AudioWorkletNode: FakeWorklet, WebSocket: FakeSocket,
    baseUrl: 'http://127.0.0.1:8010', onTurn: async text => turns.push(text), pause: async () => {},
  });
  await client.start();
  assert.equal(FakeSocket.latest.url, 'ws://127.0.0.1:8010/api/asr');
  feed(0, 20); feed(0.12, 45); feed(0, 91);
  assert.deepEqual(controls(FakeSocket.latest).map(item => item.is_speaking), [true, false]);
  assert.equal(FakeSocket.latest.sent.some(payload => payload instanceof ArrayBuffer), true);
  FakeSocket.latest.result('Привет');
  await tick();
  feed(0.12, 45); feed(0, 91);
  FakeSocket.latest.result('Как дела?');
  await tick();
  assert.deepEqual(turns, ['Привет', 'Как дела?']);
  assert.deepEqual(controls(FakeSocket.latest).map(item => item.is_speaking), [true, false, true, false]);
  await client.stop();
  assert.equal(stopped, 1);
  assert.equal(FakeSocket.latest.closed, true);
});

test('microphone input level is reported while listening and stops after capture ends', async () => {
  const levels = [];
  const client = createContinuousVoiceClient({
    getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
    AudioContext: FakeContext, AudioWorkletNode: FakeWorklet, WebSocket: FakeSocket,
    baseUrl: 'http://127.0.0.1:8010', onLevel: level => levels.push(level),
  });
  await client.start();
  feed(0.012, 30);
  assert.ok(levels.some(level => level >= 0.01 && level <= 0.013));
  const reported = levels.length;
  await client.stop();
  feed(0.012, 30);
  assert.equal(levels.length, reported);
});

test('continuous capture forwards PCM even before VAD starts ASR', async () => {
  const heard = [];
  let ended = 0;
  const client = createContinuousVoiceClient({ getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
    AudioContext: FakeContext, AudioWorkletNode: FakeWorklet, WebSocket: FakeSocket,
    baseUrl: 'http://127.0.0.1:8010', onPcm: pcm => heard.push(...pcm), onCaptureEnd: () => ended++ });
  await client.start();
  feed(0.012, 2);
  assert.ok(heard.length >= 300);
  assert.equal(FakeSocket.latest.sent.some(payload => payload instanceof ArrayBuffer), false);
  await client.stop();
  assert.equal(ended, 1);
});

test('avatar reply pauses recognition until it finishes', async () => {
  assert.equal(typeof createContinuousVoiceClient, 'function');
  let finishReply;
  const client = createContinuousVoiceClient({ getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
    AudioContext: FakeContext, AudioWorkletNode: FakeWorklet, WebSocket: FakeSocket,
    baseUrl: 'http://127.0.0.1:8010', onTurn: () => new Promise(resolve => { finishReply = resolve; }), pause: async () => {} });
  await client.start();
  feed(0.12, 45); feed(0, 91);
  FakeSocket.latest.result('Первый вопрос');
  await tick();
  feed(0.12, 45); feed(0, 91);
  assert.equal(controls(FakeSocket.latest).filter(item => item.is_speaking).length, 1);
  finishReply();
  await tick();
  feed(0.12, 45); feed(0, 91);
  assert.equal(controls(FakeSocket.latest).filter(item => item.is_speaking).length, 2);
  await client.stop();
});

test('barge-in waits for recognized speech and ignores an empty ASR result', async () => {
  assert.equal(typeof createContinuousVoiceClient, 'function');
  let interrupted = 0;
  let firstSignal;
  const client = createContinuousVoiceClient({ getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
    AudioContext: FakeContext, AudioWorkletNode: FakeWorklet, WebSocket: FakeSocket,
    baseUrl: 'http://127.0.0.1:8010', allowBargeIn: true,
    onTurn: (_text, { signal }) => { firstSignal ??= signal; return new Promise(() => {}); },
    onBargeIn: () => { interrupted++; }, pause: async () => {} });
  await client.start();
  feed(0.12, 45); feed(0, 91);
  FakeSocket.latest.result('Первый вопрос');
  await tick();
  feed(0.12, 30);
  await tick();
  assert.equal(interrupted, 0);
  assert.equal(firstSignal.aborted, false);
  assert.equal(controls(FakeSocket.latest).filter(item => item.is_speaking).length, 2);
  feed(0, 91);
  FakeSocket.latest.result('');
  await tick();
  assert.equal(interrupted, 0);
  assert.equal(firstSignal.aborted, false);
  assert.equal(client.state(), 'waiting');
  feed(0.12, 45); feed(0, 91);
  FakeSocket.latest.result('Стоп, пожалуйста, сейчас');
  await tick();
  assert.equal(interrupted, 1);
  assert.equal(firstSignal.aborted, true);
  await client.stop();
});

test('partial transcript appears during speech and interrupts the reply once', async () => {
  let interrupted = 0;
  const partials = [];
  const turns = [];
  const client = createContinuousVoiceClient({ getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
    AudioContext: FakeContext, AudioWorkletNode: FakeWorklet, WebSocket: FakeSocket,
    baseUrl: 'http://127.0.0.1:8010', allowBargeIn: true, pause: async () => {},
    onPartial: text => partials.push(text), onBargeIn: () => { interrupted++; },
    onTurn: text => { turns.push(text); return new Promise(() => {}); } });
  await client.start();
  feed(0.12, 45); feed(0, 91); FakeSocket.latest.result('первый');
  await tick();
  feed(0.12, 45);
  assert.equal(controls(FakeSocket.latest).at(-1).partial_results, true);
  FakeSocket.latest.partial('можешь');
  await tick();
  assert.equal(interrupted, 0);
  assert.equal(turns.length, 1);
  FakeSocket.latest.partial('можешь пожалуйста');
  await tick();
  assert.equal(interrupted, 0);
  assert.equal(partials.at(-1), 'можешь пожалуйста');
  FakeSocket.latest.partial('можешь пожалуйста остановиться');
  await tick();
  assert.equal(interrupted, 1);
  feed(0, 91); FakeSocket.latest.result('Можешь пожалуйста остановиться');
  await tick();
  assert.deepEqual(turns, ['первый', 'Можешь пожалуйста остановиться']);
  assert.equal(interrupted, 1);
  await client.stop();
});

test('empty partial and a rejected phrase do not interrupt the reply', async () => {
  let interrupted = 0;
  const client = createContinuousVoiceClient({ getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
    AudioContext: FakeContext, AudioWorkletNode: FakeWorklet, WebSocket: FakeSocket,
    baseUrl: 'http://127.0.0.1:8010', allowBargeIn: true, pause: async () => {},
    onBargeIn: () => { interrupted++; }, onTurn: () => new Promise(() => {}) });
  await client.start();
  feed(0.12, 45); feed(0, 91); FakeSocket.latest.result('первый');
  await tick();
  feed(0.12, 20); FakeSocket.latest.partial('');
  assert.equal(interrupted, 0);
  FakeSocket.latest.partial('...');
  assert.equal(interrupted, 0);
  FakeSocket.latest.partial('Стоп!');
  await tick();
  assert.equal(interrupted, 0);
  feed(0, 91); FakeSocket.latest.partial('шум'); FakeSocket.latest.result('шум');
  await tick();
  assert.equal(interrupted, 0);
  await client.stop();
});

test('two-word final result during avatar reply is ignored without replacing the active turn', async () => {
  let interrupted = 0;
  let firstSignal;
  const turns = [];
  const client = createContinuousVoiceClient({ getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
    AudioContext: FakeContext, AudioWorkletNode: FakeWorklet, WebSocket: FakeSocket,
    baseUrl: 'http://127.0.0.1:8010', allowBargeIn: true, pause: async () => {},
    onBargeIn: () => { interrupted++; },
    onTurn: (text, { signal }) => { turns.push(text); firstSignal ??= signal; return new Promise(() => {}); } });
  await client.start();
  feed(0.12, 45); feed(0, 91); FakeSocket.latest.result('первый');
  await tick();
  feed(0.12, 45); feed(0, 91); FakeSocket.latest.result('слово стоп');
  await tick();
  assert.equal(interrupted, 0);
  assert.equal(firstSignal.aborted, false);
  assert.deepEqual(turns, ['первый']);
  assert.equal(client.state(), 'waiting');
  await client.stop();
});

test('a short stop command interrupts on partial ASR and does not become a chat turn', async () => {
  let interrupted = 0;
  const turns = [];
  const client = createContinuousVoiceClient({ getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
    AudioContext: FakeContext, AudioWorkletNode: FakeWorklet, WebSocket: FakeSocket,
    baseUrl: 'http://127.0.0.1:8010', allowBargeIn: true, pause: async () => {},
    onBargeIn: () => { interrupted++; }, onTurn: text => { turns.push(text); return new Promise(() => {}); } });
  await client.start();
  feed(0.12, 45); feed(0, 91); FakeSocket.latest.result('первый вопрос');
  await tick();
  feed(0.12, 45); FakeSocket.latest.partial('Стоп!');
  await tick();
  assert.equal(interrupted, 1);
  feed(0, 91); FakeSocket.latest.result('Стоп, пожалуйста.');
  await tick();
  assert.deepEqual(turns, ['первый вопрос']);
  assert.equal(client.state(), 'listening');
  await client.stop();
});

test('a final-only stop command interrupts, but mentioning stop is not a command', async () => {
  let interrupted = 0;
  const turns = [];
  const client = createContinuousVoiceClient({ getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
    AudioContext: FakeContext, AudioWorkletNode: FakeWorklet, WebSocket: FakeSocket,
    baseUrl: 'http://127.0.0.1:8010', allowBargeIn: true, pause: async () => {},
    onBargeIn: () => { interrupted++; }, onTurn: text => { turns.push(text); return new Promise(() => {}); } });
  await client.start();
  feed(0.12, 45); feed(0, 91); FakeSocket.latest.result('первый вопрос');
  await tick();
  feed(0.12, 45); FakeSocket.latest.partial('слово стоп');
  await tick();
  assert.equal(interrupted, 0);
  feed(0, 91); FakeSocket.latest.result('не стоп');
  await tick();
  assert.equal(interrupted, 0);
  feed(0.12, 45); feed(0, 91); FakeSocket.latest.result('Хватит.');
  await tick();
  assert.equal(interrupted, 1);
  assert.deepEqual(turns, ['первый вопрос']);
  await client.stop();
});

test('stopping during microphone permission releases the late stream', async () => {
  assert.equal(typeof createContinuousVoiceClient, 'function');
  let finishPermission;
  let stops = 0;
  const client = createContinuousVoiceClient({
    getUserMedia: () => new Promise(resolve => { finishPermission = resolve; }),
    AudioContext: FakeContext, AudioWorkletNode: FakeWorklet, WebSocket: FakeSocket,
    baseUrl: 'http://127.0.0.1:8010',
  });
  const starting = client.start();
  await client.stop();
  finishPermission({ getTracks: () => [{ stop: () => stops++ }] });
  await assert.rejects(starting, /cancelled/i);
  assert.equal(stops, 1);
  assert.equal(client.state(), 'idle');
});

test('stopping during ASR connection settles the pending start', async () => {
  assert.equal(typeof createContinuousVoiceClient, 'function');
  class SlowSocket {
    constructor() { this.sent = []; }
    send(payload) { this.sent.push(payload); }
    close() {}
  }
  const client = createContinuousVoiceClient({ getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
    AudioContext: FakeContext, AudioWorkletNode: FakeWorklet, WebSocket: SlowSocket,
    baseUrl: 'http://127.0.0.1:8010',
  });
  const starting = client.start();
  await tick();
  await client.stop();
  const outcome = await Promise.race([
    starting.then(() => 'started', () => 'cancelled'),
    new Promise(resolve => setTimeout(() => resolve('hung'), 30)),
  ]);
  assert.equal(outcome, 'cancelled');
});

test('a short triggered noise is discarded even if ASR returns words', async () => {
  assert.equal(typeof createContinuousVoiceClient, 'function');
  const turns = [];
  const client = createContinuousVoiceClient({ getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
    AudioContext: FakeContext, AudioWorkletNode: FakeWorklet, WebSocket: FakeSocket,
    baseUrl: 'http://127.0.0.1:8010', onTurn: text => turns.push(text), pause: async () => {} });
  await client.start();
  feed(0.12, 20); feed(0, 91);
  FakeSocket.latest.result('случайное слово');
  await tick();
  assert.deepEqual(turns, []);
  assert.equal(client.state(), 'listening');
  await client.stop();
});

test('a stalled ASR reply times out and releases the microphone', async () => {
  assert.equal(typeof createContinuousVoiceClient, 'function');
  let stopped = 0;
  const client = createContinuousVoiceClient({ getUserMedia: async () => ({ getTracks: () => [{ stop: () => stopped++ }] }),
    AudioContext: FakeContext, AudioWorkletNode: FakeWorklet, WebSocket: FakeSocket,
    baseUrl: 'http://127.0.0.1:8010', transcriptionTimeoutMs: 5 });
  await client.start();
  feed(0.12, 45); feed(0, 91);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(client.state(), 'failed');
  assert.equal(stopped, 1);
  assert.equal(FakeSocket.latest.closed, true);
});

test('barge-in waits for interrupt before sending the replacement turn', async () => {
  assert.equal(typeof createContinuousVoiceClient, 'function');
  let finishInterrupt;
  const turns = [];
  const client = createContinuousVoiceClient({ getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
    AudioContext: FakeContext, AudioWorkletNode: FakeWorklet, WebSocket: FakeSocket,
    baseUrl: 'http://127.0.0.1:8010', allowBargeIn: true, pause: async () => {},
    onTurn: text => { turns.push(text); return new Promise(() => {}); },
    onBargeIn: () => new Promise(resolve => { finishInterrupt = resolve; }),
  });
  await client.start();
  feed(0.12, 45); feed(0, 91); FakeSocket.latest.result('первый');
  await tick();
  feed(0.12, 45); feed(0, 91); FakeSocket.latest.result('второй вопрос сейчас');
  await tick();
  assert.deepEqual(turns, ['первый']);
  assert.equal(typeof finishInterrupt, 'function');
  finishInterrupt();
  await tick();
  assert.deepEqual(turns, ['первый', 'второй вопрос сейчас']);
  await client.stop();
});

test('stopping auto conversation cancels an unstarted ASR-confirmed interrupt', async () => {
  let interrupted = 0;
  const turns = [];
  const client = createContinuousVoiceClient({ getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
    AudioContext: FakeContext, AudioWorkletNode: FakeWorklet, WebSocket: FakeSocket,
    baseUrl: 'http://127.0.0.1:8010', allowBargeIn: true, pause: async () => {},
    onTurn: text => { turns.push(text); return new Promise(() => {}); }, onBargeIn: () => { interrupted++; },
  });
  await client.start();
  feed(0.12, 45); feed(0, 91); FakeSocket.latest.result('первый');
  await tick();
  feed(0.12, 45); feed(0, 91); FakeSocket.latest.result('второй вопрос сейчас');
  await client.stop();
  await tick();
  assert.equal(interrupted, 0);
  assert.deepEqual(turns, ['первый']);
});
