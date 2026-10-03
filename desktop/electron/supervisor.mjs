import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { normalizeProfile } from '../src/profile.mjs';
import { realpath } from 'node:fs/promises';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function desktopHealth(port, profile) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/desktop/health`, { signal: AbortSignal.timeout(2000) });
    const payload = await response.json();
    return response.ok && await isCompatibleDesktopHealth(payload,profile);
  } catch { return false; }
}
export async function isCompatibleDesktopHealth(payload,profile) {
  const compatible=payload.code===0 && payload.data?.service==='livetalking' && payload.data?.api_version===1;
  if(!compatible||!profile)return compatible;
  const mode=payload.data.brain?.mode||'direct';
  if(mode!==profile.brain.mode || (mode==='batya' && payload.data.brain.url?.replace(/\/$/,'')!==profile.brain.url))return false;
  try{return payload.data.avatar?.model===profile.liveTalking.model && payload.data.avatar.root===await realpath(profile.liveTalking.root);}
  catch{return false;}
}

async function modelHealth(url, expected) {
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/v1/models`, { signal: AbortSignal.timeout(3000) });
    const payload = await response.json();
    return response.ok && payload.data?.some(model => model.id === expected);
  } catch { return false; }
}

export function launcherArguments(input) {
  const profile = normalizeProfile(input);
  const { liveTalking: lt, speech } = profile;
  const args = [
    path.join(lt.root, 'scripts/start_qwen_avatar.py'),
    '--json-status', '--avatar-python', lt.python,
    '--ref-file', speech.referenceWav, '--ref-text', speech.referenceText,
  ];
  if (speech.mode === 'external') {
    args.push('--external-models', '--asr-server', speech.asrUrl, '--tts-server', speech.ttsUrl);
  } else {
    if (speech.asrVllm) args.push('--asr-vllm', speech.asrVllm);
    if (speech.ttsVllm) args.push('--tts-vllm', speech.ttsVllm);
  }
  if (profile.llm.promptFile) args.push('--llm-prompt-file', profile.llm.promptFile);
  args.push('--', '--transport', 'webrtc', '--listenhost', '127.0.0.1', '--listenport', String(lt.port), '--model', lt.model, '--avatar_id', lt.avatarId);
  if (profile.brain.mode === 'batya') args.push('--llm_provider', 'batya', '--batya_url', profile.brain.url);
  return args;
}

export function createSupervisor({ spawn = nodeSpawn, kill = process.kill.bind(process), health = desktopHealth, modelHealth: checkModel = modelHealth, emit = () => {}, sleep = pause, schedule = setTimeout, cancelSchedule = clearTimeout, monitorIntervalMs = 5000, startupTimeoutMs = 900000, shutdownTimeoutMs = 35000 } = {}) {
  let child = null;
  let startPromise = null;
  let stopPromise = null;
  let monitorTimer = null;
  let generation = 0;
  let state = 'stopped';
  let adopted = false;
  let port = null;
  let stages = { asr: 'stopped', tts: 'stopped', livetalking: 'stopped' };
  let stageStartedAt = { asr: null, tts: null, livetalking: null };
  let logs = [];

  function snapshot() { return { state, adopted, port, stages: { ...stages }, stageStartedAt: { ...stageStartedAt }, logExcerpt: logs.slice(-30).join('\n') }; }
  function publish() { emit(snapshot()); }
  function failActiveStages() {
    for (const stage of Object.keys(stages)) {
      if (['waiting', 'starting'].includes(stages[stage])) stages[stage] = 'failed';
      stageStartedAt[stage] = null;
    }
  }
  function appendLine(line) {
    if (!line) return;
    if (line.startsWith('LT_STATUS ')) {
      try {
        const event = JSON.parse(line.slice('LT_STATUS '.length));
        if (Object.hasOwn(stages, event.stage) && ['starting', 'ready', 'failed', 'stopped'].includes(event.state)) {
          if (event.state === 'starting' && stages[event.stage] !== 'starting') stageStartedAt[event.stage] = Date.now();
          else if (event.state !== 'starting') stageStartedAt[event.stage] = null;
          stages[event.stage] = event.state;
          if (event.state === 'failed') { state = 'failed'; failActiveStages(); if (event.detail) logs.push(event.detail); }
          publish();
        }
      } catch { logs.push('Invalid launcher status'); }
    } else logs.push(line);
    logs = logs.slice(-100);
  }

  function cancelMonitor() {
    if (monitorTimer !== null) cancelSchedule(monitorTimer);
    monitorTimer = null;
  }
  function monitor(profile, token) {
    cancelMonitor();
    monitorTimer = schedule(async () => {
      monitorTimer = null;
      const checks = [
        ['livetalking', () => health(port, profile)],
        ['asr', () => checkModel(profile.speech.asrUrl || 'http://127.0.0.1:8092', 'Qwen/Qwen3-ASR-0.6B')],
        ['tts', () => checkModel(profile.speech.ttsUrl || 'http://127.0.0.1:8091', 'Qwen/Qwen3-TTS-12Hz-1.7B-Base')],
      ];
      for (const [stage, check] of checks) {
        if (token !== generation || state !== 'ready') return;
        const ready = await check().catch(() => false);
        if (token !== generation || state !== 'ready') return;
        if (!ready) {
          state = 'failed';
          stages[stage] = 'failed';
          appendLine(`${stage}: service is no longer available; retry startup`);
          publish();
          return;
        }
      }
      monitor(profile, token);
    }, monitorIntervalMs);
    monitorTimer?.unref?.();
  }
  function readLines(stream) {
    let pending = '';
    stream?.on('data', chunk => {
      pending += String(chunk);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) appendLine(line);
      publish();
    });
    stream?.on('end', () => { if (pending) appendLine(pending); publish(); });
  }

  async function terminateOwned(owned) {
    const waitForExit = timeout => {
      let timer;
      let onExit;
      const promise = new Promise(resolve => {
        onExit = () => { clearTimeout(timer); resolve(true); };
        owned.once('exit', onExit);
        timer = setTimeout(() => { owned.off('exit', onExit); resolve(false); }, timeout);
      });
      return { promise, cancel: () => { clearTimeout(timer); owned.off('exit', onExit); } };
    };
    const waiting = waitForExit(shutdownTimeoutMs);
    try { kill(-owned.pid, 'SIGTERM'); } catch (error) {
      if (error.code !== 'ESRCH') { waiting.cancel(); throw error; }
    }
    const graceful = await waiting.promise;
    if (!graceful) {
      const forced = waitForExit(2000);
      try { kill(-owned.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await forced.promise;
    }
  }

  async function start(input) {
    if (stopPromise) await stopPromise;
    if (startPromise) return startPromise;
    if (state === 'ready') return snapshot();
    const profile = normalizeProfile(input);
    const token = ++generation;
    port = profile.liveTalking.port;
    state = 'starting';
    adopted = false;
    stages = { asr: 'waiting', tts: 'waiting', livetalking: 'waiting' };
    stageStartedAt = { asr: null, tts: null, livetalking: null };
    logs = [];
    publish();
    startPromise = (async () => {
      if (await health(port, profile)) {
        if (token !== generation) return snapshot();
        adopted = true;
        state = 'ready';
        stages = { asr: 'ready', tts: 'ready', livetalking: 'ready' };
        stageStartedAt = { asr: null, tts: null, livetalking: null };
        publish();
        monitor(profile, token);
        return snapshot();
      }
      if (token !== generation) return snapshot();
      child = spawn(profile.liveTalking.python, launcherArguments(profile), {
        cwd: profile.liveTalking.root,
        env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
        detached: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      readLines(child.stdout);
      readLines(child.stderr);
      child.on('error', error => { if (token === generation && state !== 'stopping') { state = 'failed'; failActiveStages(); appendLine(error.message); publish(); } });
      child.on('exit', code => {
        child = null;
        if (token === generation && !['stopping', 'stopped'].includes(state)) {
          state = 'failed';
          failActiveStages();
          appendLine(`LiveTalking launcher exited: ${code}`);
          publish();
        }
      });
      const deadline = Date.now() + startupTimeoutMs;
      while (token === generation && Date.now() < deadline) {
        if (state === 'failed') throw new Error(snapshot().logExcerpt || 'LiveTalking launcher failed');
        if (await health(port, profile)) {
          if (token !== generation) return snapshot();
          state = 'ready';
          stages = { asr: 'ready', tts: 'ready', livetalking: 'ready' };
          stageStartedAt = { asr: null, tts: null, livetalking: null };
          publish();
          monitor(profile, token);
          return snapshot();
        }
        await sleep(1000);
      }
      if (token !== generation) return snapshot();
      state = 'failed';
      failActiveStages();
      appendLine('Timed out waiting for LiveTalking health');
      publish();
      if (child) await terminateOwned(child);
      throw new Error('Timed out waiting for LiveTalking health');
    })().finally(() => { startPromise = null; });
    return startPromise;
  }

  async function stop() {
    if (stopPromise) return stopPromise;
    if (state === 'stopped') return snapshot();
    cancelMonitor();
    ++generation;
    state = 'stopping';
    publish();
    stopPromise = (async () => {
      const owned = child;
      if (owned && !adopted) {
        await terminateOwned(owned);
      }
      child = null;
      adopted = false;
      state = 'stopped';
      stages = { asr: 'stopped', tts: 'stopped', livetalking: 'stopped' };
      stageStartedAt = { asr: null, tts: null, livetalking: null };
      publish();
      return snapshot();
    })().finally(() => { stopPromise = null; });
    return stopPromise;
  }

  return { start, stop, snapshot };
}
