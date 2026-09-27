import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { normalizeProfile } from '../src/profile.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function desktopHealth(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/desktop/health`, { signal: AbortSignal.timeout(2000) });
    const payload = await response.json();
    return response.ok && payload.code === 0 && payload.data?.service === 'livetalking' && payload.data?.api_version === 1;
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
  return args;
}

export function createSupervisor({ spawn = nodeSpawn, kill = process.kill.bind(process), health = desktopHealth, emit = () => {}, sleep = pause, startupTimeoutMs = 900000, shutdownTimeoutMs = 35000 } = {}) {
  let child = null;
  let startPromise = null;
  let generation = 0;
  let state = 'stopped';
  let adopted = false;
  let port = null;
  let stages = { asr: 'stopped', tts: 'stopped', livetalking: 'stopped' };
  let logs = [];

  function snapshot() { return { state, adopted, port, stages: { ...stages }, logExcerpt: logs.slice(-30).join('\n') }; }
  function publish() { emit(snapshot()); }
  function appendLine(line) {
    if (!line) return;
    if (line.startsWith('LT_STATUS ')) {
      try {
        const event = JSON.parse(line.slice('LT_STATUS '.length));
        if (Object.hasOwn(stages, event.stage) && ['starting', 'ready', 'failed', 'stopped'].includes(event.state)) {
          stages[event.stage] = event.state;
          if (event.state === 'failed') state = 'failed';
          publish();
        }
      } catch { logs.push('Invalid launcher status'); }
    } else logs.push(line);
    logs = logs.slice(-100);
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
    if (startPromise) return startPromise;
    if (state === 'ready') return snapshot();
    const profile = normalizeProfile(input);
    const token = ++generation;
    port = profile.liveTalking.port;
    state = 'starting';
    adopted = false;
    stages = { asr: 'starting', tts: 'starting', livetalking: 'starting' };
    logs = [];
    publish();
    startPromise = (async () => {
      if (await health(port)) {
        if (token !== generation) return snapshot();
        adopted = true;
        state = 'ready';
        stages = { asr: 'ready', tts: 'ready', livetalking: 'ready' };
        publish();
        return snapshot();
      }
      if (token !== generation) return snapshot();
      child = spawn(profile.liveTalking.python, launcherArguments(profile), {
        cwd: profile.liveTalking.root,
        detached: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      readLines(child.stdout);
      readLines(child.stderr);
      child.on('error', error => { if (token === generation && state !== 'stopping') { state = 'failed'; appendLine(error.message); publish(); } });
      child.on('exit', code => {
        child = null;
        if (token === generation && !['stopping', 'stopped'].includes(state)) {
          state = 'failed';
          appendLine(`LiveTalking launcher exited: ${code}`);
          publish();
        }
      });
      const deadline = Date.now() + startupTimeoutMs;
      while (token === generation && Date.now() < deadline) {
        if (state === 'failed') throw new Error(snapshot().logExcerpt || 'LiveTalking launcher failed');
        if (await health(port)) {
          if (token !== generation) return snapshot();
          state = 'ready';
          stages.livetalking = 'ready';
          publish();
          return snapshot();
        }
        await sleep(1000);
      }
      if (token !== generation) return snapshot();
      state = 'failed';
      appendLine('Timed out waiting for LiveTalking health');
      publish();
      if (child) await terminateOwned(child);
      throw new Error('Timed out waiting for LiveTalking health');
    })().finally(() => { startPromise = null; });
    return startPromise;
  }

  async function stop() {
    if (state === 'stopped') return snapshot();
    ++generation;
    state = 'stopping';
    publish();
    const owned = child;
    if (owned && !adopted) {
      await terminateOwned(owned);
    }
    child = null;
    adopted = false;
    state = 'stopped';
    stages = { asr: 'stopped', tts: 'stopped', livetalking: 'stopped' };
    publish();
    return snapshot();
  }

  return { start, stop, snapshot };
}
