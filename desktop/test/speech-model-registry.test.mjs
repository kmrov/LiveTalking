import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { listOwnedSpeechModels, stopOwnedSpeechModel } from '../electron/speech-model-registry.mjs';

test('lists only living speech process groups recorded by Studio and stops one selected group', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'speech-registry-test-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  try {
    const stat = await (await import('node:fs/promises')).readFile(`/proc/${child.pid}/stat`, 'utf8');
    const startTime = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    await writeFile(path.join(directory, `${child.pid}.json`), JSON.stringify({ stage: 'asr', pid: child.pid, startTime }));
    await writeFile(path.join(directory, 'stale.json'), JSON.stringify({ stage: 'tts', pid: child.pid, startTime: '0' }));
    assert.deepEqual((await listOwnedSpeechModels(directory)).map(model => model.stage), ['asr']);
    await stopOwnedSpeechModel(directory, 'asr');
    assert.deepEqual(await listOwnedSpeechModels(directory), []);
    assert.equal((await (await import('node:fs/promises')).readdir(directory)).includes(`${child.pid}.json`), false);
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
});

test('refuses to signal a process whose PID was reused', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'speech-registry-test-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  try {
    await writeFile(path.join(directory, `${child.pid}.json`), JSON.stringify({ stage: 'tts', pid: child.pid, startTime: '0' }));
    await stopOwnedSpeechModel(directory, 'tts');
    assert.equal(child.exitCode, null);
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
});

test('finds and stops the vLLM process group after its API leader exits', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'speech-registry-test-'));
  const leader = spawn('bash', ['-c', 'sleep 60 & sleep 0.2'], { detached: true, stdio: 'ignore' });
  try {
    const stat = await (await import('node:fs/promises')).readFile(`/proc/${leader.pid}/stat`, 'utf8');
    const startTime = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    await writeFile(path.join(directory, `${leader.pid}.json`), JSON.stringify({ stage: 'tts', pid: leader.pid, startTime }));
    await once(leader, 'exit');
    assert.deepEqual((await listOwnedSpeechModels(directory)).map(model => model.stage), ['tts']);
    await stopOwnedSpeechModel(directory, 'tts');
    assert.deepEqual(await listOwnedSpeechModels(directory), []);
  } finally {
    try { process.kill(-leader.pid, 'SIGKILL'); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
});
