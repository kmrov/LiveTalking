import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversationClient } from '../renderer/conversation-client.mjs';

test('conversation client sends echo and chat with current session and interrupt', async () => {
  const calls = [];
  const client = createConversationClient({ fetch: async (url, options) => { calls.push([url, JSON.parse(options.body)]); return { ok: true, json: async () => ({ code: 0 }) }; }, baseUrl: 'http://127.0.0.1:8010', getSessionId: () => '123' });
  await client.sendText('Привет', { type: 'echo', interrupt: true });
  await client.sendText('Как дела?', { type: 'chat', interrupt: false });
  assert.deepEqual(calls[0], ['http://127.0.0.1:8010/human', { sessionid: '123', text: 'Привет', type: 'echo', interrupt: true }]);
  assert.equal(calls[1][1].type, 'chat');
  await client.interrupt();
  assert.deepEqual(calls[2], ['http://127.0.0.1:8010/interrupt_talk', { sessionid: '123' }]);
});

test('conversation client controls recording and refuses commands after session loss', async () => {
  const calls = [];
  let session = '123';
  const client = createConversationClient({ fetch: async (url, options) => { calls.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ code: 0 }) }; }, baseUrl: 'http://127.0.0.1:8010', getSessionId: () => session });
  await client.startRecording();
  await client.stopRecording();
  assert.deepEqual(calls.map(item => item.type), ['start_record', 'end_record']);
  session = null;
  await assert.rejects(client.startRecording(), /session/i);
  assert.equal(calls.length, 2);
});

test('conversation client reports API failure and returns speaking state', async () => {
  const bad = createConversationClient({ fetch: async () => ({ ok: true, json: async () => ({ code: -1, msg: 'session not found' }) }), baseUrl: 'http://127.0.0.1:8010', getSessionId: () => '123' });
  await assert.rejects(bad.interrupt(), /session not found/);
  const good = createConversationClient({ fetch: async () => ({ ok: true, json: async () => ({ code: 0, data: true }) }), baseUrl: 'http://127.0.0.1:8010', getSessionId: () => '123' });
  assert.equal(await good.speaking(), true);
});

test('network retry is enabled only for an idempotent brain', async () => {
  for (const [idempotentChat, expected] of [[false, 1], [true, 2]]) {
    const calls = [];
    const client = createConversationClient({ idempotentChat,
      fetch: async (url, options) => { calls.push(JSON.parse(options.body)); throw new Error('Lost HTTP response'); },
      baseUrl: 'http://127.0.0.1:8010', getSessionId: () => '123' });
    await assert.rejects(client.sendText('Привет', { requestId: 'stable' }), /Lost HTTP response/);
    assert.equal(calls.length, expected);
    assert.ok(calls.every(item => item.request_id === 'stable'));
  }
});
