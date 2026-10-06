import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import os from 'node:os';
import path from 'node:path';

const downloadable = new Set(['avatar-model', 'asr-model', 'tts-model']);
export async function prepareProfileModels(profile, { inspect, download, cancelled = () => false }) {
  let checks = await inspect(profile);
  if (cancelled()) return;
  const blockers = checks.filter(check => check.state !== 'ready');
  const other = blockers.filter(check => !downloadable.has(check.id) || check.state !== 'missing');
  if (other.length) throw new Error(other.map(check => check.detail).join('; '));
  if (!blockers.length) return;
  await download(profile);
  if (cancelled()) return;
  checks = await inspect(profile);
  if (cancelled()) return;
  const remaining = checks.filter(check => check.state !== 'ready');
  if (remaining.length) throw new Error(remaining.map(check => check.detail).join('; '));
}

export function createModelDownloads({ spawn = nodeSpawn, kill = (pid, signal) => process.kill(pid, signal), emit = () => {}, temporaryRoot = os.tmpdir(), shutdownTimeoutMs = 5000 } = {}) {
  let active = null;
  let state = { state: 'idle', progress: 0 };
  const snapshot = () => ({ ...state });
  const publish = value => { state = value; emit(snapshot()); };

  async function prepare(profile) {
    if (active) throw new Error('Model download is already running.');
    const owner = { cancelled: false, child: null, directory: null, closed: false };
    active = owner;
    owner.finished = new Promise(resolve => { owner.finish = resolve; });
    publish({ state: 'checking', progress: 0 });
    try {
      owner.directory = await mkdtemp(path.join(temporaryRoot, 'livetalking-models-'));
      const requestFile = path.join(owner.directory, 'request.json');
      const request = { root: profile.liveTalking.root, model: profile.liveTalking.model, speechMode: profile.speech.mode, ttsEngine: profile.speech.ttsEngine };
      await writeFile(requestFile, JSON.stringify(request), { mode: 0o600 });
      if (owner.cancelled) throw new Error('Download cancelled.');
      await new Promise((resolve, reject) => {
        const child = spawn(profile.liveTalking.python, ['-u', path.join(request.root, 'scripts/download_desktop_models.py'), '--profile', requestFile], { cwd: request.root, detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        owner.child = child;
        const decoder = new StringDecoder('utf8');
        const errorDecoder = new StringDecoder('utf8');
        let buffer = '', errors = '', completed = false, failure = '';
        const consume = line => {
          if (!line.startsWith('LT_MODELS ')) return;
          let event;
          try { event = JSON.parse(line.slice(10)); } catch { return; }
          if (event.version !== 1 || owner.cancelled) return;
          if (event.state === 'completed') { completed = true; return; }
          if (event.state === 'failed') { failure = String(event.message || 'Model download failed.').slice(0, 2048); return; }
          if (event.state !== 'downloading' || !Number.isSafeInteger(event.downloadedBytes) || !Number.isSafeInteger(event.totalBytes) || event.downloadedBytes < 0 || event.totalBytes < event.downloadedBytes) return;
          publish({ state: 'downloading', progress: Math.min(100, Math.max(0, Math.floor(Number(event.progress) || 0))), file: String(event.file || '').slice(0, 1024), label: String(event.label || '').slice(0, 256), downloadedBytes: event.downloadedBytes, totalBytes: event.totalBytes });
        };
        const onData = data => {
          buffer += decoder.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
          let newline;
          while ((newline = buffer.indexOf('\n')) !== -1) { consume(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
          if (buffer.length > 65536) buffer = '';
        };
        const onErrorData = data => { errors = (errors + errorDecoder.write(Buffer.isBuffer(data) ? data : Buffer.from(data))).slice(-8192); };
        const cleanup = () => { child.stdout?.off('data', onData); child.stderr?.off('data', onErrorData); child.off('error', onError); child.off('close', onClose); };
        const onError = error => { owner.closed = true; cleanup(); reject(error); };
        const onClose = code => {
          owner.closed = true;
          consume(buffer + decoder.end());
          errors += errorDecoder.end();
          cleanup();
          if (owner.cancelled) reject(new Error('Download cancelled.'));
          else if (code !== 0 || failure) reject(new Error(failure || errors.trim() || 'Model download failed.'));
          else if (!completed) reject(new Error('Downloader did not confirm the installed models.'));
          else resolve();
        };
        child.stdout?.on('data', onData); child.stderr?.on('data', onErrorData);
        child.once('error', onError); child.once('close', onClose);
      });
      publish({ state: 'completed', progress: 100 });
      return snapshot();
    } catch (error) {
      const failure = owner.cancelled ? new Error('Download cancelled.') : error;
      publish({ ...state, state: owner.cancelled ? 'cancelled' : 'failed', detail: failure.message });
      throw failure;
    } finally {
      if (owner.directory) await rm(owner.directory, { recursive: true, force: true });
      active = null;
      owner.finish();
    }
  }

  async function stop() {
    const owner = active;
    if (!owner) return snapshot();
    owner.cancelled = true;
    const signal = name => {
      if (!owner.child?.pid || owner.closed) return;
      try { kill(-owner.child.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    signal('SIGTERM');
    const timer = setTimeout(() => signal('SIGKILL'), shutdownTimeoutMs);
    try { await owner.finished; } finally { clearTimeout(timer); }
    return snapshot();
  }
  return { prepare, stop, snapshot, isBusy: () => active !== null };
}
