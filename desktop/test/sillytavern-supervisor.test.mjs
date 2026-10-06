import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { normalizeProfile } from '../src/profile.mjs';

const profile = normalizeProfile({ brain: { mode: 'sillytavern', sillyTavernRoot: '/tmp/SillyTavern' } });
const environment = { YANDEX_AISTUDIO_KEY: 'secret', YANDEX_FOLDER_ID: 'folder' };
const child = pid => Object.assign(new EventEmitter(), { pid, stdout: new EventEmitter(), stderr: new EventEmitter() });

test('Studio does not adopt an older SillyTavern bridge without the character streaming contract', async () => {
  const { sillyTavernBridgeHealth } = await import('../electron/sillytavern-supervisor.mjs');
  const url = 'http://127.0.0.1:8002';
  const stUrl = 'http://127.0.0.1:8001';
  const oldBridge = async () => Response.json({ service: 'sillytavern', api_version: 1, speech_stream: 1, sillytavern_url: stUrl });
  assert.equal(await sillyTavernBridgeHealth(url, stUrl, oldBridge), false);
  const newBridge = async () => Response.json({ service: 'sillytavern', api_version: 2, speech_stream: 1, sillytavern_url: stUrl });
  assert.equal(await sillyTavernBridgeHealth(url, stUrl, newBridge), true);
});

test('SillyTavern supervisor adopts existing ST and stops only its own bridge', async () => {
  const { createSillyTavernSupervisor } = await import('../electron/sillytavern-supervisor.mjs');
  const bridge = child(400);
  const spawned = [], killed = [];
  let bridgeReady = false;
  const supervisor = createSillyTavernSupervisor({
    stHealth: async () => true, bridgeHealth: async () => bridgeReady,
    spawn: (bin, args, options) => { spawned.push([bin, args, options]); bridgeReady = true; return bridge; },
    kill: (pid, signal) => { killed.push([pid, signal]); bridge.emit('exit', 0); },
    sleep: async () => {},
  });
  await supervisor.start(profile, environment);
  assert.equal(supervisor.snapshot().stages.sillytavern, 'ready');
  assert.equal(spawned.length, 1);
  assert.match(spawned[0][1][0], /sillytavern-bridge\.mjs$/);
  assert.equal(spawned[0][2].env.YANDEX_AISTUDIO_KEY, 'secret');
  assert.equal(spawned[0][2].env.STUDIO_ST_AVATAR, 'Viktor_Petrovich_Studio.png');
  assert.equal(spawned[0][2].env.STUDIO_ST_ADOPTED, '1');
  await supervisor.stop();
  assert.deepEqual(killed, [[-400, 'SIGTERM']]);
});

test('SillyTavern supervisor can adopt a configured server without Studio credentials', async () => {
  const { createSillyTavernSupervisor } = await import('../electron/sillytavern-supervisor.mjs');
  const bridge = child(401);
  let ready = false;
  const supervisor = createSillyTavernSupervisor({
    stHealth: async () => true, bridgeHealth: async () => ready,
    spawn: (_bin, _args, options) => { assert.equal(options.env.STUDIO_ST_ADOPTED, '1'); ready = true; return bridge; },
    kill: () => bridge.emit('exit', 0), sleep: async () => {},
  });
  await supervisor.start(profile, {});
  assert.equal(supervisor.snapshot().state, 'ready');
  await supervisor.stop();
});
