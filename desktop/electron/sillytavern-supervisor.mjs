import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { normalizeProfile } from '../src/profile.mjs';
import { redactServiceText } from './service-environment.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const bridgeScript = fileURLToPath(new URL('../scripts/sillytavern-bridge.mjs', import.meta.url));

export async function sillyTavernHealth(url, request = globalThis.fetch) {
  try {
    const response = await request(`${url}/version`, { signal: AbortSignal.timeout(3000) });
    return response.ok && Boolean((await response.json()).pkgVersion);
  } catch { return false; }
}

export async function sillyTavernBridgeHealth(url, stUrl, request = globalThis.fetch) {
  try {
    const response = await request(`${url}/api/v1/capabilities`, { signal: AbortSignal.timeout(3000) });
    const data = await response.json();
    return response.ok && data.service === 'sillytavern' && data.speech_stream === 1 && data.sillytavern_url === stUrl;
  } catch { return false; }
}

export function createSillyTavernSupervisor({ spawn = nodeSpawn, kill = process.kill.bind(process),
  stHealth = sillyTavernHealth, bridgeHealth = sillyTavernBridgeHealth, sleep = pause, emit = () => {},
  startupTimeoutMs = 120000, shutdownTimeoutMs = 10000, schedule = setTimeout, cancelSchedule = clearTimeout } = {}) {
  let state = 'stopped', stChild = null, bridgeChild = null, stAdopted = false, bridgeAdopted = false;
  let profile, environment, startJob, stopJob, monitorTimer, generation = 0, logs = [];
  let stages = { sillytavern: 'stopped', bridge: 'stopped' };
  let stageStartedAt = { sillytavern: null, bridge: null };
  const snapshot = () => ({ state, adopted: stAdopted && bridgeAdopted, stages: { ...stages },
    stageStartedAt: { ...stageStartedAt }, logExcerpt: logs.slice(-20).join('\n') });
  const publish = () => emit(snapshot());
  const log = line => { logs.push(redactServiceText(String(line), environment)); logs = logs.slice(-60); publish(); };
  function cancelMonitor() { if (monitorTimer) cancelSchedule(monitorTimer); monitorTimer = null; }
  function monitor(token) {
    cancelMonitor();
    monitorTimer = schedule(async () => {
      monitorTimer = null;
      if (token !== generation || state !== 'ready') return;
      const [stReady, bridgeReady] = await Promise.all([stHealth(profile.brain.sillyTavernUrl), bridgeHealth('http://127.0.0.1:8002', profile.brain.sillyTavernUrl)]);
      if (token !== generation || state !== 'ready') return;
      if (!stReady || !bridgeReady) {
        state = 'failed';
        stages[!stReady ? 'sillytavern' : 'bridge'] = 'failed';
        log('SillyTavern or its Studio bridge is unavailable.');
      } else monitor(token);
    }, 5000);
    monitorTimer?.unref?.();
  }
  function attach(child, stage, token) {
    for (const stream of [child.stdout, child.stderr]) {
      let pending = '';
      stream?.on('data', chunk => {
        pending += String(chunk);
        const lines = pending.split(/\r?\n/); pending = lines.pop();
        for (const line of lines) if (line) log(line);
      });
      stream?.on('end', () => { if (pending) log(pending); });
    }
    child.on('error', error => {
      if (token === generation && state !== 'stopping') {
        state = 'failed'; stages[stage] = 'failed'; stageStartedAt[stage] = null; log(error.message);
      }
    });
    child.on('exit', code => {
      if (stage === 'sillytavern' && stChild === child) stChild = null;
      if (stage === 'bridge' && bridgeChild === child) bridgeChild = null;
      if (token === generation && !['stopped', 'stopping'].includes(state)) {
        state = 'failed'; stages[stage] = 'failed'; stageStartedAt[stage] = null; log(`${stage} exited: ${code}`);
      }
    });
  }
  async function awaitReady(check, label, token) {
    const deadline = Date.now() + startupTimeoutMs;
    while (token === generation && Date.now() < deadline) {
      if (state === 'failed') throw new Error(snapshot().logExcerpt || `${label} exited`);
      if (await check()) return;
      await sleep(500);
    }
    throw new Error(`${label} did not become ready`);
  }
  async function terminate(child) {
    if (!child || typeof child.exitCode === 'number' || child.signalCode) return;
    const wait = timeout => new Promise(resolve => {
      const done = () => { clearTimeout(timer); resolve(true); };
      child.once('exit', done);
      const timer = setTimeout(() => { child.off('exit', done); resolve(false); }, timeout);
    });
    const finished = wait(shutdownTimeoutMs);
    try { kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    if (!await finished) {
      const forced = wait(2000);
      try { kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await forced;
    }
  }
  async function start(input, env = {}) {
    if (stopJob) await stopJob;
    if (startJob) return startJob;
    if (state === 'ready') return snapshot();
    profile = normalizeProfile(input);
    environment = env;
    if (!env.YANDEX_AISTUDIO_KEY || !env.YANDEX_FOLDER_ID) throw new Error('Yandex AI Studio key and folder ID are required for SillyTavern mode');
    const token = ++generation;
    state = 'starting'; logs = []; stAdopted = false; bridgeAdopted = false;
    stages = { sillytavern: 'starting', bridge: 'waiting' };
    stageStartedAt = { sillytavern: Date.now(), bridge: null }; publish();
    startJob = (async () => {
      try {
        const stUrl = profile.brain.sillyTavernUrl;
        if (await stHealth(stUrl)) stAdopted = true;
        else {
          const root = profile.brain.sillyTavernRoot;
          if (!existsSync(path.join(root, 'server.js'))) throw new Error(`SillyTavern server.js not found in ${root}`);
          if (!existsSync(path.join(root, 'node_modules'))) throw new Error(`SillyTavern dependencies missing in ${root}; run npm ci`);
          stChild = spawn('node', [path.join(root, 'server.js'), '--port', String(new URL(stUrl).port || 80), '--browserLaunchEnabled', 'false', '--listen', 'false'],
            { cwd: root, env: process.env, detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
          attach(stChild, 'sillytavern', token);
          await awaitReady(() => stHealth(stUrl), 'SillyTavern', token);
        }
        stages.sillytavern = 'ready'; stageStartedAt.sillytavern = null;
        stages.bridge = 'starting'; stageStartedAt.bridge = Date.now(); publish();
        const bridgeUrl = 'http://127.0.0.1:8002';
        if (await bridgeHealth(bridgeUrl, stUrl)) bridgeAdopted = true;
        else {
          bridgeChild = spawn('node', [bridgeScript], { cwd: path.dirname(bridgeScript),
            env: { ...process.env, ...env, STUDIO_ST_URL: stUrl, STUDIO_ST_BRIDGE_PORT: '8002',
              STUDIO_ST_AVATAR: profile.brain.sillyTavernCharacter },
            detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
          attach(bridgeChild, 'bridge', token);
          await awaitReady(() => bridgeHealth(bridgeUrl, stUrl), 'SillyTavern bridge', token);
        }
        state = 'ready'; stages.bridge = 'ready'; stageStartedAt.bridge = null; publish(); monitor(token);
        return snapshot();
      } catch (error) {
        if (token === generation) {
          state = 'failed';
          for (const stage of Object.keys(stages)) if (['waiting', 'starting'].includes(stages[stage])) { stages[stage] = 'failed'; stageStartedAt[stage] = null; }
          log(error.message);
        }
        throw error;
      }
    })().finally(() => { startJob = null; });
    return startJob;
  }
  async function stop() {
    if (stopJob) return stopJob;
    if (state === 'stopped') return snapshot();
    ++generation; cancelMonitor(); state = 'stopping'; publish();
    stopJob = (async () => {
      if (startJob) await startJob.catch(() => {});
      if (!bridgeAdopted) await terminate(bridgeChild);
      if (!stAdopted) await terminate(stChild);
      bridgeChild = null; stChild = null; bridgeAdopted = false; stAdopted = false;
      state = 'stopped'; stages = { sillytavern: 'stopped', bridge: 'stopped' };
      stageStartedAt = { sillytavern: null, bridge: null }; publish();
      return snapshot();
    })().finally(() => { stopJob = null; });
    return stopJob;
  }
  return { start, stop, snapshot };
}
