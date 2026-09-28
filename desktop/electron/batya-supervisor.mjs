import { spawn as nodeSpawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeProfile } from '../src/profile.mjs';
import { redactServiceText } from './service-environment.mjs';

const execute = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function batyaHealth(url) {
  try {
    const options = { signal: AbortSignal.timeout(3000) };
    const health = await fetch(`${url}/api/v1/health`, options);
    if (!health.ok || (await health.json()).status !== 'ok') return false;
    const response = await fetch(`${url}/api/v1/capabilities`, { signal: AbortSignal.timeout(3000) });
    const data = await response.json();
    return response.ok && data.service === 'batya' && data.speech_stream === 1;
  } catch { return false; }
}

export function createBatyaSupervisor({ spawn = nodeSpawn, run = execute, kill = process.kill.bind(process), health = batyaHealth, sleep = pause, emit = () => {}, startupTimeoutMs = 120000, shutdownTimeoutMs = 10000, schedule = setTimeout, cancelSchedule = clearTimeout } = {}) {
  let state = 'stopped', adopted = false, ownedDatabase = false, child = null;
  let generation = 0, startJob = null, stopJob = null, monitorTimer = null;
  let profile, environment = {}, logs = [];
  let stages = { batya: 'stopped', database: 'stopped' };
  const snapshot = () => ({ state, adopted, ownedDatabase, stages: { ...stages }, logExcerpt: logs.slice(-20).join('\n') });
  const publish = () => emit(snapshot());
  const log = value => { logs.push(redactServiceText(value, environment)); logs = logs.slice(-60); publish(); };
  function cancelMonitor() { if (monitorTimer !== null) cancelSchedule(monitorTimer); monitorTimer = null; }
  function monitor(token) {
    cancelMonitor();
    monitorTimer = schedule(async () => {
      monitorTimer = null;
      if (token !== generation || state !== 'ready') return;
      const ready = await health(profile.brain.url);
      if (token !== generation || state !== 'ready') return;
      if (!ready) { state = 'failed'; stages.batya = 'failed'; log('Батя или его база недоступны. Проверьте сервис и повторите запуск.'); }
      else monitor(token);
    }, 5000);
    monitorTimer?.unref?.();
  }
  const compose = args => run('docker', ['compose', ...args], { cwd: profile.brain.root, env: environment, timeout: 45000, maxBuffer: 256 * 1024 });
  async function databaseRunning() {
    const result = await compose(['ps', '--format', 'json', 'db']);
    const output = result.stdout.trim();
    if (!output) return false;
    const parsed = output.startsWith('[') ? JSON.parse(output) : output.split('\n').map(line => JSON.parse(line));
    return parsed.some(item => item.State === 'running');
  }

  async function start(input, env = {}) {
    if (stopJob) await stopJob;
    if (startJob) return startJob;
    if (state === 'ready') return snapshot();
    profile = normalizeProfile(input);
    environment = { ...env, PYTHONUNBUFFERED: '1' };
    const token = ++generation;
    state = 'starting'; adopted = false; logs = [];
    stages = { batya: 'starting', database: 'starting' };
    publish();
    startJob = (async () => {
      try {
        const ready = await health(profile.brain.url);
        if (token !== generation) return snapshot();
        if (ready) {
          adopted = true; state = 'ready'; stages = { batya: 'ready', database: 'ready' };
          publish(); monitor(token); return snapshot();
        }
        if (!profile.brain.managed) throw new Error('Внешний Батя недоступен или не поддерживает speech_stream. Обновите сервис и проверьте URL.');
        if (profile.brain.databaseMode === 'compose') {
          const running = await databaseRunning();
          if (token !== generation) return snapshot();
          if (!running) {
            ownedDatabase = true;
            await compose(['up', '-d', 'db']);
          }
          if (token !== generation) return snapshot();
        }
        stages.database = 'ready'; publish();
        const url = new URL(profile.brain.url);
        child = spawn(profile.brain.python, ['-m', 'uvicorn', 'batya.main:app', '--host', url.hostname.replace(/[\[\]]/g, ''), '--port', url.port || '80'], {
          cwd: profile.brain.root, env: environment, detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
        });
        for (const stream of [child.stdout, child.stderr]) {
          let pending = '';
          stream?.on('data', data => {
            pending += String(data);
            const lines = pending.split(/\r?\n/); pending = lines.pop();
            for (const line of lines) if (line) log(line);
          });
          stream?.on('end', () => { if (pending) log(pending); });
        }
        child.on('error', error => { if (token === generation && state !== 'stopping') { state = 'failed'; stages.batya = 'failed'; log(error.message); } });
        child.on('exit', code => {
          child = null;
          if (token === generation && !['stopping', 'stopped'].includes(state)) { state = 'failed'; stages.batya = 'failed'; log(`Батя завершился: ${code}`); }
        });
        const deadline = Date.now() + startupTimeoutMs;
        while (token === generation && Date.now() < deadline) {
          if (state === 'failed') throw new Error(snapshot().logExcerpt || 'Батя не запустился');
          if (await health(profile.brain.url)) {
            if (token !== generation) return snapshot();
            state = 'ready'; stages.batya = 'ready'; publish(); monitor(token); return snapshot();
          }
          await sleep(500);
        }
        if (token === generation) throw new Error('Батя не стал готов: проверьте PostgreSQL, ключ Yandex и журнал запуска.');
        return snapshot();
      } catch (error) {
        if (token !== generation) return snapshot();
        state = 'failed'; stages.batya = 'failed'; log(error.message);
        throw new Error(redactServiceText(error.message, environment));
      }
    })().finally(() => { startJob = null; });
    return startJob;
  }

  async function terminate(process) {
    if (typeof process.exitCode === 'number' || process.signalCode) return;
    const wait = timeout => new Promise(resolve => {
      const exited = () => { clearTimeout(timer); resolve(true); };
      process.once('exit', exited);
      const timer = setTimeout(() => { process.off('exit', exited); resolve(false); }, timeout);
    });
    const finished = wait(shutdownTimeoutMs);
    try { kill(-process.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    if (!await finished) {
      const forced = wait(2000);
      try { kill(-process.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await forced;
    }
  }

  async function stop() {
    if (stopJob) return stopJob;
    if (state === 'stopped') return snapshot();
    ++generation; cancelMonitor(); state = 'stopping'; publish();
    stopJob = (async () => {
      if (startJob) await startJob.catch(() => {});
      if (child && !adopted) await terminate(child);
      child = null;
      if (ownedDatabase) { await compose(['stop', 'db']); ownedDatabase = false; }
      adopted = false; state = 'stopped'; stages = { batya: 'stopped', database: 'stopped' }; publish();
      return snapshot();
    })().finally(() => { stopJob = null; });
    return stopJob;
  }
  return { start, stop, snapshot };
}
