import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectionClient } from '../renderer/projection-client.mjs';

test('projection uses the selected avatar, voice and conversation as one active session', async () => {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push([url, options]);
    return { ok: true, json: async () => ({ code: 0, data: { state: 'connected', url: 'http://127.0.0.1:19840/whip', sessionid: '0' } }) };
  };
  const client = createProjectionClient({ fetch, baseUrl: 'http://127.0.0.1:8010' });
  const sessionId = await client.connect({
    url: 'http://127.0.0.1:19840/whip', token: 'private-token', avatarId: 'batya_wrap_details_v4',
    referenceWav: '/voice.wav', referenceText: 'Привет', conversationId: 'conversation-id',
  });
  assert.equal(sessionId, '0');
  assert.equal(client.sessionId(), '0');
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    url: 'http://127.0.0.1:19840/whip', token: 'private-token', avatar: 'batya_wrap_details_v4',
    refaudio: '/voice.wav', reftext: 'Привет', batya_conversation_id: 'conversation-id',
  });
  await client.disconnect();
  assert.equal(client.sessionId(), null);
  assert.equal(calls[1][0], 'http://127.0.0.1:8010/api/whip/disconnect');
});

test('projection clears its target when status reports a dropped stream', async () => {
  let dropped = false;
  const client = createProjectionClient({
    baseUrl: 'http://127.0.0.1:8010',
    fetch: async () => ({ ok: true, json: async () => ({ code: 0, data: dropped
      ? { state: 'disconnected', url: '' }
      : { state: 'connected', url: 'http://127.0.0.1:19840/whip', sessionid: '0' } }) }),
  });
  await client.connect({ url: 'http://127.0.0.1:19840/whip', token: '' });
  dropped = true;
  await client.status();
  assert.equal(client.sessionId(), null);
});

test('a late status response cannot restore a disconnected projection', async () => {
  let finishStatus;
  const client = createProjectionClient({
    baseUrl: 'http://127.0.0.1:8010',
    fetch: async (url) => {
      if (url.endsWith('/status')) return new Promise(resolve => { finishStatus = () => resolve({ ok: true, json: async () => ({ code: 0, data: { state: 'connected', sessionid: '0' } }) }); });
      return { ok: true, json: async () => ({ code: 0, data: { state: 'connected', sessionid: '0' } }) };
    },
  });
  await client.connect({ url: 'http://127.0.0.1:19840/whip', token: '' });
  const pending = client.status();
  await client.disconnect();
  finishStatus();
  await pending;
  assert.equal(client.sessionId(), null);
});

test('disconnect during a pending connect asks Electron to release the session', async () => {
  const actions = [];
  let finishConnect;
  const client = createProjectionClient({
    send: async action => {
      actions.push(action);
      if (action === 'connect') return new Promise(resolve => { finishConnect = () => resolve({ state: 'connected', sessionid: 'owned' }); });
      return { state: 'disconnected', url: '' };
    },
  });
  const pending = client.connect({ url: 'http://127.0.0.1:19840/whip', token: '' });
  await client.disconnect();
  finishConnect();
  await assert.rejects(pending, /cancelled/i);
  assert.deepEqual(actions, ['connect', 'disconnect']);
  assert.equal(client.sessionId(), null);
});
