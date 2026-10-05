import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { normalizeProfile } from '../src/profile.mjs';

const profile = normalizeProfile({ brain: { mode: 'sillytavern', sillyTavernRoot: '/tmp/SillyTavern' } });
const environment = { YANDEX_AISTUDIO_KEY: 'secret', YANDEX_FOLDER_ID: 'folder' };
const child = pid => Object.assign(new EventEmitter(), { pid, stdout: new EventEmitter(), stderr: new EventEmitter() });

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
  await supervisor.stop();
  assert.deepEqual(killed, [[-400, 'SIGTERM']]);
});

test('SillyTavern supervisor refuses missing credentials before spawning', async () => {
  const { createSillyTavernSupervisor } = await import('../electron/sillytavern-supervisor.mjs');
  const supervisor = createSillyTavernSupervisor({ spawn: () => assert.fail('must not spawn') });
  await assert.rejects(supervisor.start(profile, {}), /Yandex/);
});
