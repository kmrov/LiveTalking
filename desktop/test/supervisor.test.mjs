import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSupervisor, launcherArguments, isCompatibleDesktopHealth } from '../electron/supervisor.mjs';
import { normalizeProfile } from '../src/profile.mjs';

const profile = normalizeProfile({ id: 'main', liveTalking: { root: '/tmp/Мой LiveTalking', python: '/tmp/Мой LiveTalking/.venv/bin/python' }, speech: { referenceWav: '/tmp/Мой LiveTalking/мой голос.wav', referenceText: 'Привет' } });

test('generative avatars launch with their supported single session', () => {
  for (const model of ['ditto', 'soulx']) {
    const args = launcherArguments({ ...profile, liveTalking: { ...profile.liveTalking, model } });
    assert.equal(args[args.indexOf('--max_session') + 1], '1');
  }
  assert.equal(launcherArguments(profile).includes('--max_session'), false);
});

test('OmniVoice profile launches its own Python speech server', () => {
  const selected = normalizeProfile({ ...profile, speech: { ...profile.speech, ttsEngine: 'omnivoice', omniPython: '/opt/omni/bin/python' } });
  const args = launcherArguments(selected);
  assert.equal(args[args.indexOf('--tts-engine') + 1], 'omnivoice');
  assert.equal(args[args.indexOf('--omni-python') + 1], '/opt/omni/bin/python');
});

test('running Qwen avatar is not adopted by an OmniVoice profile', async () => {
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'studio-tts-health-'));
  try {
    const qwen = normalizeProfile({ ...profile, liveTalking: { ...profile.liveTalking, root: checkout } });
    const omni = normalizeProfile({ ...qwen, speech: { ...qwen.speech, ttsEngine: 'omnivoice' } });
    const payload = { code: 0, data: { service: 'livetalking', api_version: 1,
      avatar: { model: omni.liveTalking.model, root: checkout },
      brain: { mode: 'direct' }, speech: { tts_model: 'Qwen/Qwen3-TTS-12Hz-1.7B-Base' } } };
    assert.equal(await isCompatibleDesktopHealth(payload, qwen), true);
    assert.equal(await isCompatibleDesktopHealth(payload, omni), false);
  } finally { await rm(checkout, { recursive: true, force: true }); }
});

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 123;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

test('supervisor starts once with a loopback host and one Unicode WAV argument', async () => {
  const calls = [];
  const child = fakeChild();
  let healthChecks = 0;
  const supervisor = createSupervisor({
    spawn: (...args) => { calls.push(args); return child; },
    kill: () => {},
    health: async () => ++healthChecks > 1,
    sleep: async () => {},
    emit: () => {},
  });
  await Promise.all([supervisor.start(profile), supervisor.start(profile)]);
  assert.equal(calls.length, 1);
  const argv = calls[0][1];
  assert.equal(argv[argv.indexOf('--ref-file') + 1], '/tmp/Мой LiveTalking/мой голос.wav');
  assert.equal(argv[argv.indexOf('--listenhost') + 1], '127.0.0.1');
  assert.equal(supervisor.snapshot().state, 'ready');
});

test('supervisor notices a newly ready avatar within half a second', async () => {
  let elapsedMs = 0;
  const supervisor = createSupervisor({
    spawn: () => fakeChild(),
    health: async () => elapsedMs >= 300,
    sleep: async ms => { elapsedMs += ms; },
  });
  await supervisor.start(profile);
  assert.equal(supervisor.snapshot().state, 'ready');
  assert.ok(elapsedMs <= 500, `readiness took ${elapsedMs} ms after the server became available`);
});

test('supervisor distinguishes queued model stages from active loading', async () => {
  const child = fakeChild();
  let finishHealth;
  let checks = 0;
  const supervisor = createSupervisor({
    spawn: () => child,
    health: async () => ++checks === 1 ? false : new Promise(resolve => { finishHealth = resolve; }),
    sleep: async () => {}, emit: () => {},
  });
  const start = supervisor.start(profile);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(supervisor.snapshot().stages, { asr: 'waiting', tts: 'waiting', livetalking: 'waiting' });
  child.stdout.emit('data', 'LT_STATUS {"stage":"asr","state":"starting"}\n');
  assert.equal(supervisor.snapshot().stages.asr, 'starting');
  assert.ok(supervisor.snapshot().stageStartedAt.asr > 0);
  assert.equal(supervisor.snapshot().stageStartedAt.tts, null);
  child.stdout.emit('data', 'LT_STATUS {"stage":"asr","state":"ready"}\n');
  assert.equal(supervisor.snapshot().stageStartedAt.asr, null);
  finishHealth(true);
  await start;
});

test('launcher failure clears stage loading indicators', async () => {
  const child = fakeChild();
  const supervisor = createSupervisor({
    spawn: () => child, health: async () => false,
    sleep: async () => {
      child.stdout.emit('data', 'LT_STATUS {"stage":"tts","state":"starting"}\n');
      child.emit('exit', 1);
    }, emit: () => {},
  });
  await assert.rejects(supervisor.start(profile), /launcher exited/);
  assert.equal(supervisor.snapshot().state, 'failed');
  assert.equal(Object.values(supervisor.snapshot().stages).includes('starting'), false);
  assert.deepEqual(supervisor.snapshot().stageStartedAt, { asr: null, tts: null, livetalking: null });
});

test('supervisor maps external models to the existing Python launcher', async () => {
  const calls = [];
  const child = fakeChild();
  let healthChecks = 0;
  const external = normalizeProfile({ ...profile, speech: { ...profile.speech, mode: 'external', asrUrl: 'http://127.0.0.1:8092', ttsUrl: 'http://127.0.0.1:8091' } });
  const supervisor = createSupervisor({ spawn: (...args) => { calls.push(args); return child; }, kill: () => {}, health: async () => ++healthChecks > 1, sleep: async () => {}, emit: () => {} });
  await supervisor.start(external);
  assert.ok(calls[0][1].includes('--external-models'));
  assert.equal(calls[0][1][calls[0][1].indexOf('--asr-server') + 1], 'http://127.0.0.1:8092');
});

test('supervisor stops only the process it owns', async () => {
  const child = fakeChild();
  const signals = [];
  let healthChecks = 0;
  const supervisor = createSupervisor({
    spawn: () => child,
    kill: (pid, signal) => { signals.push([pid, signal]); child.emit('exit', 0); },
    health: async () => ++healthChecks > 1,
    sleep: async () => {}, emit: () => {},
  });
  await supervisor.start(profile);
  await supervisor.stop();
  assert.deepEqual(signals, [[-123, 'SIGTERM']]);
  assert.equal(supervisor.snapshot().state, 'stopped');
});

test('supervisor tells launcher to retain speech models before stopping its group', async () => {
  const registryDir = await mkdtemp(path.join(os.tmpdir(), 'supervisor-models-'));
  const child = fakeChild();
  let healthChecks = 0;
  let keepFile;
  try {
    const supervisor = createSupervisor({ registryDir,
      spawn: (_python, args) => { keepFile = args[args.indexOf('--keep-models-file') + 1]; return child; },
      health: async () => ++healthChecks > 1, sleep: async () => {},
      kill: (pid, signal) => { assert.equal(pid, -123); assert.equal(signal, 'SIGTERM'); assert.equal(readFileSync(keepFile, 'utf8'), 'keep'); child.emit('exit', 0); },
    });
    await supervisor.start(profile);
    await supervisor.stop({ keepModels: true });
    assert.equal(await readFile(keepFile, 'utf8'), 'keep');
    assert.equal(supervisor.snapshot().state, 'stopped');
  } finally { await rm(registryDir, { recursive: true, force: true }); }
});

test('supervisor adopts a compatible existing service without spawning or killing', async () => {
  let calls = 0;
  const supervisor = createSupervisor({ spawn: () => { calls++; }, kill: () => { calls++; }, health: async () => true, sleep: async () => {}, emit: () => {} });
  await supervisor.start(profile);
  assert.equal(supervisor.snapshot().adopted, true);
  await supervisor.stop();
  assert.equal(calls, 0);
});

test('supervisor terminates its launcher after readiness timeout', async () => {
  const child = fakeChild();
  const signals = [];
  const supervisor = createSupervisor({
    spawn: () => child,
    kill: (pid, signal) => { signals.push([pid, signal]); child.emit('exit', 1); },
    health: async () => false,
    sleep: async () => {}, emit: () => {}, startupTimeoutMs: -1,
  });
  await assert.rejects(supervisor.start(profile), /Timed out/);
  assert.deepEqual(signals, [[-123, 'SIGTERM']]);
  assert.equal(supervisor.snapshot().state, 'failed');
});

test('concurrent Stop requests wait for one owned shutdown', async () => {
  const child = fakeChild();
  const signals = [];
  let healthChecks = 0;
  const supervisor = createSupervisor({ spawn: () => child, health: async () => ++healthChecks > 1,
    kill: (pid, signal) => signals.push([pid, signal]), sleep: async () => {}, shutdownTimeoutMs: 100 });
  await supervisor.start(profile);
  const stops = [supervisor.stop(), supervisor.stop()];
  child.emit('exit', 0);
  await Promise.all(stops);
  assert.deepEqual(signals, [[-123, 'SIGTERM']]);
  assert.equal(supervisor.snapshot().state, 'stopped');
});

test('adopted service failure is visible and a recovered service can be adopted again', async () => {
  let tick;
  let available = true;
  const supervisor = createSupervisor({ health: async () => available,
    modelHealth: async () => true, schedule: callback => { tick = callback; return 1; }, cancelSchedule: () => {} });
  await supervisor.start(profile);
  assert.equal(typeof tick, 'function');
  available = false;
  await tick();
  assert.equal(supervisor.snapshot().state, 'failed');
  assert.equal(supervisor.snapshot().stages.livetalking, 'failed');
  await supervisor.stop();
  available = true;
  await supervisor.start(profile);
  assert.equal(supervisor.snapshot().state, 'ready');
  await supervisor.stop();
});

test('adopted speech endpoint failure propagates its stage without killing external processes', async () => {
  let tick;
  const supervisor = createSupervisor({ health: async () => true,
    modelHealth: async (_url, model) => !model.includes('TTS'),
    schedule: callback => { tick = callback; return 1; }, cancelSchedule: () => {},
    kill: () => assert.fail('must not kill adopted services') });
  await supervisor.start(profile);
  assert.equal(typeof tick, 'function');
  await tick();
  assert.equal(supervisor.snapshot().state, 'failed');
  assert.equal(supervisor.snapshot().stages.tts, 'failed');
  await supervisor.stop();
});
