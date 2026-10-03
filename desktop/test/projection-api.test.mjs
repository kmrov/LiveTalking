import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectionApi } from '../electron/projection-api.mjs';

const profile = { liveTalking: { port: 8010 } };
const destination = { url: 'http://127.0.0.1:19840/whip', token: 'secret' };
const ids = ['c0166cbc-a705-4d29-a34b-5be696608315', 'c0166cbc-a705-4d29-a34b-5be696608316'];

function harness(fetch, discover) {
  let index = 0;
  const state = { phase: 'ready', profileId: 'main' };
  return { state, api: createProjectionApi({
    getProfile: id => id === 'main' ? profile : null,
    getServiceState: () => state, fetch, discover, makeId: () => ids[index++],
  }) };
}

test('projection IPC uses a unique owned session and validates active profile and destination', async () => {
  const calls = [];
  const { api } = harness(async (url, options) => {
    calls.push([url, options]);
    const body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ code: 0, data: { state: 'connected', sessionid: body.sessionid, lease: body.lease } }) };
  });
  const result = await api.request('main', 'connect', destination);
  assert.equal(result.sessionid, ids[0]);
  assert.equal(calls[0][0], 'http://127.0.0.1:8010/api/whip/connect');
  assert.deepEqual(JSON.parse(calls[0][1].body), { ...destination, sessionid: ids[0], lease: ids[1] });
  await assert.rejects(api.request('other', 'disconnect'), /active profile/i);
  await assert.rejects(api.request('main', 'delete'), /invalid action/i);
  await api.release();
  await assert.rejects(api.request('main', 'connect', { url: 'http://example.com/whip' }), /local Head in Jar/i);
});

test('Studio can discover a Head in Jar before avatar services start', async () => {
  const { api, state } = harness(async () => { throw new Error('No WHIP control call expected'); },
    async () => [{ name: 'Head in Jar', url: 'http://192.168.8.12:19840/whip', auth: 'local' }]);
  state.phase = 'not-configured';
  assert.deepEqual(await api.request('main', 'discover'),
    [{ name: 'Head in Jar', url: 'http://192.168.8.12:19840/whip', auth: 'local' }]);
});

test('same-computer Head in Jar accepts an empty token through projection IPC', async () => {
  const requests = [];
  const { api } = harness(async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    return { ok: true, json: async () => ({ code: 0, data: { state: 'connected', sessionid: body.sessionid, lease: body.lease } }) };
  });
  await api.request('main', 'connect', { url: 'http://127.0.0.1:19840/whip', token: '' });
  assert.equal(requests[0].token, '');
  await api.release();
});

test('discovered LAN receiver can connect without a token but unknown endpoints are rejected', async () => {
  const calls = [];
  const discovered = [{ name: 'Head in Jar', url: 'http://192.168.8.12:19840/whip', auth: 'local' }];
  const { api } = harness(async (url, options) => {
    calls.push([url, options]);
    const body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ code: 0, data: { state: 'connected', sessionid: body.sessionid, lease: body.lease } }) };
  }, async () => discovered);
  assert.deepEqual(await api.request('main', 'discover'), discovered);
  await assert.rejects(api.request('main', 'connect', { url: 'http://192.168.8.13:19840/whip', token: '' }), /local Head in Jar/i);
  await api.request('main', 'connect', { url: discovered[0].url, token: '' });
  assert.equal(JSON.parse(calls[0][1].body).url, discovered[0].url);
  await api.release();
});

test('stopping Studio releases the owned stream even while connect is pending', async () => {
  const calls = [];
  let finishConnect;
  const { api, state } = harness(async (url, options) => {
    calls.push([url, options]);
    if (url.endsWith('/connect')) return new Promise(resolve => { finishConnect = () => resolve({
      ok: true, json: async () => ({ code: 0, data: { state: 'connected', sessionid: ids[0], lease: ids[1] } }),
    }); });
    return { ok: true, json: async () => ({ code: 0, data: { state: 'disconnected', url: '' } }) };
  });
  await api.release();
  assert.deepEqual(calls, []);
  const pending = api.request('main', 'connect', destination);
  await assert.rejects(api.request('main', 'connect', destination), /already connecting/i);
  state.phase = 'failed';
  const released = api.release();
  const cancelled = assert.rejects(pending, /cancelled/i);
  assert.equal(calls.length, 1, 'disconnect must wait until the connect request reaches the server');
  finishConnect();
  await released;
  assert.equal(calls[1][0], 'http://127.0.0.1:8010/api/whip/disconnect');
  assert.deepEqual(JSON.parse(calls[1][1].body), { sessionid: ids[0], lease: ids[1] });
  await cancelled;
});

test('status rejects a replaced stream and later disconnect does not remove it', async () => {
  const calls = [];
  const { api } = harness(async (url, options) => {
    calls.push([url, options]);
    if (url.includes('/status')) return { ok: true, json: async () => ({ code: 0, data: {
      state: 'connected', sessionid: ids[0], lease: 'different-lease',
    } }) };
    const body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ code: 0, data: { state: 'connected', sessionid: body.sessionid, lease: body.lease } }) };
  });
  await api.request('main', 'connect', destination);
  const status = await api.request('main', 'status');
  assert.equal(status.state, 'disconnected');
  assert.equal(new URL(calls[1][0]).searchParams.get('sessionid'), ids[0]);
  await api.release();
  assert.equal(calls.length, 2);
});

test('concurrent Stop requests wait for the same remote disconnect', async () => {
  let finishDisconnect;
  let disconnectCount = 0;
  const { api } = harness(async (url, options) => {
    if (url.endsWith('/disconnect')) {
      disconnectCount++;
      return new Promise(resolve => { finishDisconnect = () => resolve({ ok: true, json: async () => ({ code: 0, data: { state: 'disconnected' } }) }); });
    }
    const body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ code: 0, data: { state: 'connected', sessionid: body.sessionid, lease: body.lease } }) };
  });
  await api.request('main', 'connect', destination);
  const first = api.release();
  const second = api.release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(disconnectCount, 1);
  finishDisconnect();
  await Promise.all([first, second]);
});


test('discovered bearer receiver requires and forwards a token', async () => {
  const requests = [];
  const discovered = [{ name: 'Protected', url: 'http://192.168.8.12:19840/whip', auth: 'bearer' }];
  const { api } = harness(async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    return { ok: true, json: async () => ({ code: 0, data: { state: 'connected', sessionid: body.sessionid, lease: body.lease } }) };
  }, async () => discovered);
  await api.request('main', 'discover');
  await assert.rejects(api.request('main', 'connect', { url: discovered[0].url, token: '' }), /token/i);
  await assert.rejects(api.request('main', 'connect', { url: 'http://192.168.8.13:19840/whip', token: 'secret' }), /local Head in Jar/i);
  await api.request('main', 'connect', { url: discovered[0].url, token: 'secret' });
  assert.equal(requests[0].token, 'secret');
  await api.release();
});
