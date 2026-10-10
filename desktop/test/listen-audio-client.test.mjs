import assert from 'node:assert/strict';
import test from 'node:test';
import { createListenAudioSender } from '../renderer/listen-audio-client.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));

test('microphone sender batches PCM16 little endian without altering samples', async () => {
  const requests = [];
  const sender = createListenAudioSender({
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true }; },
    baseUrl: 'http://127.0.0.1:8010', sessionId: 'abc', batchSamples: 4,
  });
  const pcm = Int16Array.from([-32768, 0, 32767, 256]);
  sender.push(pcm.slice(0, 2));
  assert.equal(requests.length, 0);
  sender.push(pcm.slice(2));
  await tick();
  assert.equal(requests[0].url, 'http://127.0.0.1:8010/api/desktop/listen-audio?sessionid=abc');
  assert.equal(requests[0].options.method, 'POST');
  assert.deepEqual(Array.from(new Uint8Array(requests[0].options.body)), [0, 128, 0, 0, 255, 127, 0, 1]);
  assert.deepEqual(Array.from(pcm), [-32768, 0, 32767, 256]);
  sender.close();
});

test('stalled avatar request cannot grow the queue or delay ASR capture', async () => {
  const requests = [];
  const complete = [];
  const sender = createListenAudioSender({
    fetch: (_url, options) => {
      requests.push(options);
      return new Promise(resolve => complete.push(() => resolve({ ok: true })));
    },
    baseUrl: 'http://127.0.0.1:8010', sessionId: 'abc', batchSamples: 2,
  });
  for (let index = 0; index < 20; index++) sender.push(Int16Array.from([index, index]));
  assert.equal(requests.length, 1);
  complete[0]();
  await tick();
  assert.equal(new DataView(requests[1].body).getInt16(0, true), 18);
  complete[1]();
  await tick();
  assert.equal(new DataView(requests[2].body).getInt16(0, true), 19);
  assert.equal(requests.length, 3);
  sender.close();
  assert.equal(requests[2].signal.aborted, true);
  sender.push(Int16Array.from([99, 99]));
  assert.equal(requests.length, 3);
});
