import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createBatyaSupervisor } from '../electron/batya-supervisor.mjs';
import { inspectBatyaPrerequisites } from '../electron/batya-prerequisites.mjs';
import { normalizeProfile } from '../src/profile.mjs';
import { launcherArguments } from '../electron/supervisor.mjs';

const profile = normalizeProfile({ liveTalking: { root: '/tmp/LiveTalking' }, brain: { mode: 'batya', root: '/tmp/Батя' } });
const env = { YANDEX_AISTUDIO_KEY: 'secret-key', YANDEX_FOLDER_ID: 'folder', BATYA_DATABASE_URL: 'postgresql://batya:password@localhost/batya' };
const child = () => Object.assign(new EventEmitter(), { pid: 456, stdout: new EventEmitter(), stderr: new EventEmitter() });

test('Batya adopts an existing compatible API without owning or stopping its database', async () => {
  const supervisor = createBatyaSupervisor({ health: async () => true, run: () => assert.fail('no docker command'), spawn: () => assert.fail('no process'), kill: () => assert.fail('no kill') });
  await supervisor.start(profile, env);
  assert.equal(supervisor.snapshot().adopted, true);
  await supervisor.stop();
});

test('Batya reports database and API as separate startup stages', async () => {
  const snapshots = [];
  let checks = 0;
  const supervisor = createBatyaSupervisor({
    health: async () => ++checks > 1,
    run: async () => ({ stdout: JSON.stringify({ State: 'running', Health: 'healthy' }) }),
    spawn: () => child(),
    emit: snapshot => snapshots.push(snapshot),
  });
  await supervisor.start(profile, env);
  const databaseStartup = snapshots.find(snapshot => snapshot.stages.database === 'starting');
  const apiStartup = snapshots.find(snapshot => snapshot.stages.database === 'ready' && snapshot.stages.batya === 'starting');
  assert.equal(databaseStartup.stages.batya, 'waiting');
  assert.ok(databaseStartup.stageStartedAt.database > 0);
  assert.ok(apiStartup.stageStartedAt.batya > 0);
  assert.deepEqual(supervisor.snapshot().stageStartedAt, { batya: null, database: null });
});

test('database startup failure stops its loading indicator', async () => {
  const supervisor = createBatyaSupervisor({
    health: async () => false,
    run: async () => { throw new Error('database unavailable'); },
    spawn: () => assert.fail('API must not start'),
  });
  await assert.rejects(supervisor.start(profile, env), /database unavailable/);
  assert.equal(supervisor.snapshot().stages.database, 'failed');
  assert.equal(supervisor.snapshot().stageStartedAt.database, null);
});

test('owned API stops once and an adopted database remains running; credentials stay in env', async () => {
  const process = child();
  const commands = [], signals = [];
  let checks = 0;
  const supervisor = createBatyaSupervisor({ health: async () => ++checks > 1,
    run: async (_bin, args) => { commands.push(args); return { stdout: JSON.stringify({ State: 'running', Health: 'healthy' }) }; },
    spawn: (bin, args, options) => { assert.equal(bin, profile.brain.python); assert.equal(args.includes('secret-key'), false); assert.equal(options.env.YANDEX_AISTUDIO_KEY, 'secret-key'); return process; },
    kill: (pid, signal) => { signals.push([pid, signal]); process.emit('exit', 0); }, sleep: async () => {} });
  await Promise.all([supervisor.start(profile, env), supervisor.start(profile, env)]);
  await Promise.all([supervisor.stop(), supervisor.stop()]);
  assert.deepEqual(signals, [[-456, 'SIGTERM']]);
  assert.equal(commands.some(args => args.includes('stop')), false);
});

test('Stop during compose startup cleans only the owned DB and never launches API', async () => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const begun = new Promise(resolve => { entered = resolve; });
  const commands = [];
  const supervisor = createBatyaSupervisor({ health: async () => false,
    run: async (_bin, args) => { commands.push(args); if (args.includes('up')) { entered(); await gate; } return { stdout: '' }; },
    spawn: () => assert.fail('API must not start after Stop'), sleep: async () => {} });
  const start = supervisor.start(profile, env);
  await begun;
  const stop = supervisor.stop();
  release();
  await Promise.all([start, stop]);
  assert.equal(supervisor.snapshot().state, 'stopped');
  assert.equal(commands.filter(args => args.includes('stop')).length, 1);
  assert.equal(commands.some(args => args.includes('down')), false);
});

test('brain checks report credentials and interpreter requirements with recovery guidance', async () => {
  const results = await inspectBatyaPrerequisites(profile, {}, {
    health: async () => false, exists: () => true,
    python: async () => ({ ok: false, detail: 'Нужен Python 3.13' }), docker: async () => true,
  });
  assert.equal(results.find(item => item.id === 'batya-credentials').state, 'missing');
  assert.equal(results.find(item => item.id === 'batya-python').state, 'missing');
  assert.match(results.find(item => item.id === 'batya-python').action, /uv sync/);
  const argv = launcherArguments(profile);
  assert.equal(argv[argv.indexOf('--llm_provider') + 1], 'batya');
  assert.equal(argv[argv.indexOf('--batya_url') + 1], 'http://127.0.0.1:8000');
});
