import assert from 'node:assert/strict';
import test from 'node:test';
import { createAsrClient, createPcmResampler } from '../renderer/asr-client.mjs';

class FakeSocket {
  static latest;
  constructor() { FakeSocket.latest = this; this.sent = []; this.readyState = 0; queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; }
  result(payload) { this.onmessage?.({ data: JSON.stringify(payload) }); }
}
class FakeWorklet {
  static latest;
  constructor() { FakeWorklet.latest = this; this.port = {}; }
  connect() {}
  disconnect() {}
}
class FakeContext {
  sampleRate = 48000;
  destination = {};
  audioWorklet = { addModule: async () => {} };
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}

test('ASR client sends start, PCM and stop in order, then final text and releases mic', async () => {
  let stopped = 0;
  const texts = [];
  const client = createAsrClient({ getUserMedia: async () => ({ getTracks: () => [{ stop: () => stopped++ }] }), AudioContext: FakeContext, AudioWorkletNode: FakeWorklet, WebSocket: FakeSocket, baseUrl: 'http://127.0.0.1:8010', onText: text => texts.push(text), onState: () => {} });
  await client.start();
  FakeWorklet.latest.port.onmessage({ data: new Float32Array(480).fill(.5) });
  const finishing = client.stop();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.parse(FakeSocket.latest.sent[0]).is_speaking, true);
  assert.ok(FakeSocket.latest.sent[1] instanceof ArrayBuffer);
  assert.equal(JSON.parse(FakeSocket.latest.sent.at(-1)).is_speaking, false);
  FakeSocket.latest.result({ text: 'Привет', is_final: true });
  assert.equal(await finishing, 'Привет');
  assert.deepEqual(texts, ['Привет']);
  assert.equal(stopped, 1);
});

test('ASR client releases capture on WebSocket error and microphone rejection', async () => {
  let stopped = 0;
  const states = [];
  const client = createAsrClient({ getUserMedia: async () => ({ getTracks: () => [{ stop: () => stopped++ }] }), AudioContext: FakeContext, AudioWorkletNode: FakeWorklet, WebSocket: FakeSocket, baseUrl: 'http://127.0.0.1:8010', onState: state => states.push(state) });
  await client.start();
  FakeSocket.latest.onerror?.(new Error('socket failed'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, 1);
  assert.equal(states.at(-1), 'failed');
  const denied = createAsrClient({ getUserMedia: async () => { throw new Error('Permission denied'); }, AudioContext: FakeContext, WebSocket: FakeSocket, baseUrl: 'http://127.0.0.1:8010', onState: () => {} });
  await assert.rejects(denied.start(), /Permission denied/);
});

test('PCM resampler preserves one second across chunks and clamps signed samples', () => {
  const resampler = createPcmResampler(48000);
  const input = new Float32Array(48000);
  for (let index = 0; index < input.length; index++) input[index] = index % 2 ? -2 : 2;
  const chunks = [];
  for (let index = 0; index < input.length; index += 127) chunks.push(resampler.push(input.slice(index, index + 127)));
  chunks.push(resampler.flush());
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.length, 0), 16000);
  assert.equal(chunks.every(chunk => Array.from(chunk).every(value => value >= -32768 && value <= 32767)), true);
});
