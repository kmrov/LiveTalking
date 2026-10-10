import path from 'node:path';
import os from 'node:os';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { connect } from 'node:net';
import { normalizeProfile } from '../src/profile.mjs';
import { createAvatarLibrary } from './avatar-library.mjs';
import { isCompatibleDesktopHealth } from './supervisor.mjs';

const item = (id, state, detail, action = '') => ({ id, state, detail, action });
const asrModel = 'Qwen/Qwen3-ASR-0.6B';
const ttsModel = 'Qwen/Qwen3-TTS-12Hz-1.7B-Base';
const omniModel = 'k2-fsa/OmniVoice';

export function runPrerequisiteCommand(executable, args, options = {}) {
  return new Promise(resolve => {
    execFile(executable, args, { encoding: 'utf8', ...options }, (error, stdout, stderr) => {
      resolve({ status: error ? null : 0, stdout, stderr, error });
    });
  });
}

function fileReady(file) {
  try { const info = statSync(file); return info.isFile() && info.size > 0; }
  catch { return false; }
}

function weightsReady(folder) {
  if (['model.safetensors', 'pytorch_model.bin'].some(file => fileReady(path.join(folder, file)))) return true;
  for (const name of ['model.safetensors.index.json', 'pytorch_model.bin.index.json']) {
    try {
      const index = JSON.parse(readFileSync(path.join(folder, name), 'utf8'));
      const shards = Object.values(index.weight_map || {});
      if (shards.length && shards.every(file => typeof file === 'string' && path.basename(file) === file && fileReady(path.join(folder, file)))) return true;
    } catch { /* Missing or incomplete snapshot. */ }
  }
  return false;
}

export function cachedModelReady(folder, needsSpeechTokenizer = false) {
  try {
      const revision = readFileSync(path.join(folder, 'refs/main'), 'utf8').trim();
      if (!/^[0-9a-f]{40}$/.test(revision)) return false;
      const snapshot = path.join(folder, 'snapshots', revision);
      return ['config.json', 'tokenizer_config.json', 'preprocessor_config.json', 'vocab.json', 'merges.txt'].every(file => fileReady(path.join(snapshot, file)))
        && weightsReady(snapshot)
        && (!needsSpeechTokenizer || (['config.json', 'preprocessor_config.json'].every(file => fileReady(path.join(snapshot, 'speech_tokenizer', file))) && weightsReady(path.join(snapshot, 'speech_tokenizer'))));
  } catch { return false; }
}

export function cachedOmniModelReady(folder) {
  try {
    const revision = readFileSync(path.join(folder, 'refs/main'), 'utf8').trim();
    if (!/^[0-9a-f]{40}$/.test(revision)) return false;
    const snapshot = path.join(folder, 'snapshots', revision);
    return ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'chat_template.jinja', 'audio_tokenizer/config.json', 'audio_tokenizer/preprocessor_config.json'].every(file => fileReady(path.join(snapshot, file)))
      && weightsReady(snapshot) && weightsReady(path.join(snapshot, 'audio_tokenizer'));
  } catch { return false; }
}

export function speechCacheRoot(root, { env = process.env, home = os.homedir(), exists = existsSync } = {}) {
  if (env.HF_HUB_CACHE) return env.HF_HUB_CACHE;
  if (env.HF_HOME) return path.join(env.HF_HOME, 'hub');
  const adjacent = path.join(path.dirname(root), '.hf-cache-qwen');
  if (exists(adjacent)) return path.join(adjacent, 'hub');
  return path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'huggingface/hub');
}

function avatarWeightFiles(lt) {
  const models = {
    wav2lip: ['models/wav2lip.pth'],
    musetalk: ['models/musetalkV15/unet.pth', 'models/musetalkV15/musetalk.json', 'models/sd-vae/config.json', 'models/sd-vae/diffusion_pytorch_model.bin', 'models/whisper/config.json', 'models/whisper/pytorch_model.bin', 'models/whisper/preprocessor_config.json'],
    ultralight: [`data/avatars/${lt.avatarId}/ultralight.pth`, 'models/hubert-large-ls960-ft/config.json', 'models/hubert-large-ls960-ft/pytorch_model.bin', 'models/hubert-large-ls960-ft/preprocessor_config.json', 'models/hubert-large-ls960-ft/vocab.json', 'models/hubert-large-ls960-ft/tokenizer_config.json', 'models/hubert-large-ls960-ft/special_tokens_map.json'],
  };
  return (models[lt.model] || []).map(file => path.join(lt.root, file));
}

async function modelStatus(url, expected) {
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/v1/models`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return 'unavailable';
    const payload = await response.json();
    return payload.data?.some(model => model.id === expected) ? 'ready' : 'wrong';
  } catch { return 'unavailable'; }
}

function portOpen(port) {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(2000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}

async function portStatus(port, profile) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/desktop/health`, { signal: AbortSignal.timeout(2000) });
    const payload = await response.json();
    if (payload.code === 0 && payload.data?.service === 'livetalking' && payload.data?.api_version === 1) {
      if(!response.ok || !await isCompatibleDesktopHealth(payload,profile))return 'incompatible';
      return 'livetalking';
    }
  } catch { /* Check whether some other process owns the port. */ }
  return await portOpen(port) ? 'occupied' : 'free';
}

export const defaultProbes = {
  exists: existsSync,
  avatar: async lt => createAvatarLibrary().get(lt.root, lt.avatarId),
  fileReady,
  cachedModelReady,
  cachedOmniModelReady,
  async omniPython(executable) {
    const result = await runPrerequisiteCommand(executable, ['-c', 'import omnivoice, torch, soundfile'], { timeout: 30000 });
    return result.status === 0
      ? { ok: true, detail: 'OmniVoice Python and dependencies are available' }
      : { ok: false, detail: (result.stderr || result.error?.message || 'OmniVoice import failed').trim().split('\n').at(-1) };
  },
  async python(executable) {
    const result = await runPrerequisiteCommand(executable, ['-c', 'import aiohttp, aiortc, torch, requests, soxr'], { timeout: 20000 });
    return result.status === 0
      ? { ok: true, detail: 'Python, aiohttp, aiortc, and torch are available' }
      : { ok: false, detail: (result.stderr || result.error?.message || 'Could not import modules').trim().split('\n').at(-1) };
  },
  async generativeRuntime(lt) {
    const result = await runPrerequisiteCommand(lt.python, [path.join(lt.root, 'scripts/check_generative_runtime.py'), '--model', lt.model, '--root', lt.root], { cwd: lt.root, timeout: 30000, maxBuffer: 1024 * 1024 });
    try {
      const value = JSON.parse(result.stdout);
      if (typeof value.ok === 'boolean' && typeof value.detail === 'string') return { ok: result.status === 0 && value.ok, detail: value.detail };
    } catch { /* Report invalid responses and subprocess failures as a runtime blocker. */ }
    return { ok: false, detail: (result.error?.message || result.stderr || 'Invalid generative runtime check response').trim().slice(-8192) };
  },
  model: modelStatus,
  port: portStatus,
  async gpu() {
    const result = await runPrerequisiteCommand('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { timeout: 5000 });
    return result.status === 0 && Boolean(result.stdout.trim());
  },
};

export async function inspectPrerequisites(input, probes = defaultProbes) {
  const profile = normalizeProfile(input);
  const { liveTalking: lt, speech } = profile;
  const results = [];
  const rootReady = Boolean(lt.root && probes.exists(path.join(lt.root, 'app.py')) && probes.exists(path.join(lt.root, 'config.py')) && probes.exists(path.join(lt.root, 'scripts/start_qwen_avatar.py')));
  results.push(rootReady
    ? item('checkout', 'ready', `LiveTalking: ${lt.root}`)
    : item('checkout', 'missing', lt.root ? `Compatible LiveTalking not found: ${lt.root}` : 'LiveTalking was not found beside the app', 'Place the LiveTalking folder beside the app or select another folder containing scripts/start_qwen_avatar.py.'));

  let avatar = null;
  if (rootReady) {
    try { avatar = await probes.avatar(lt); } catch { /* Library provides the repair action below. */ }
  }
  results.push(avatar?.ready && avatar.model === lt.model
    ? item('avatar', 'ready', `Avatar ${avatar.name || lt.avatarId} is ready`)
    : item('avatar', 'missing', avatar?.reason || `Avatar ${lt.avatarId} is not ready for ${lt.model}`, 'Select a ready avatar from the library or create one.'));

  if (['ditto', 'soulx', 'avtr1'].includes(lt.model)) {
    let runtime = { ok: false, detail: `Runtime for ${lt.model} is not configured` };
    if (rootReady && lt.python && probes.exists(lt.python)) {
      try { runtime = await probes.generativeRuntime(lt); }
      catch (error) { runtime = { ok: false, detail: error.message }; }
    }
    results.push(item('avatar-runtime', runtime.ok ? 'ready' : 'missing', runtime.detail,
      runtime.ok ? '' : `Install the ${lt.model} runtime and weights following desktop/README.md, then configure absolute paths in models/${lt.model}/runtime.json.`));
  } else {
    const requiredWeights = avatarWeightFiles(lt);
    const missingWeights = requiredWeights.filter(file => !probes.fileReady(file));
    results.push(requiredWeights.length && !missingWeights.length
      ? item('avatar-model', 'ready', `Weights for ${lt.model} found`)
      : item('avatar-model', 'missing', `Weights for ${lt.model} are not ready: ${missingWeights.join(', ') || 'unsupported model'}`, 'Press Start: Studio will download missing models.'));
  }

  const pythonReady = Boolean(lt.python && probes.exists(lt.python));
  if (!pythonReady) results.push(item('python', 'missing', `Python not found: ${lt.python || 'path not set'}`, `Create an environment: python3 -m venv "${lt.root || 'LiveTalking'}/.venv" and install dependencies.`));
  else {
    const result = await probes.python(lt.python);
    results.push(result.ok ? item('python', 'ready', result.detail) : item('python', 'missing', result.detail, `Install dependencies in ${lt.python}: python -m pip install -r requirements.txt.`));
  }

  results.push(speech.referenceWav && probes.exists(speech.referenceWav)
    ? item('voice', 'ready', `Voice sample: ${speech.referenceWav}`)
    : item('voice', 'missing', 'WAV voice sample not found', 'Select a WAV voice sample.'));
  results.push(speech.referenceText
    ? item('transcript', 'ready', 'Sample transcript is set')
    : item('transcript', 'missing', 'Sample transcript is missing', 'Enter the exact words spoken in the WAV file.'));

  const selectedTts = speech.ttsEngine === 'omnivoice' ? omniModel : ttsModel;
  for (const [id, expected, address, executable] of [
    ['asr', asrModel, speech.asrUrl || 'http://127.0.0.1:8092', speech.asrVllm],
    ['tts', selectedTts, speech.ttsUrl || 'http://127.0.0.1:8091', speech.ttsEngine === 'omnivoice' ? speech.omniPython : speech.ttsVllm],
  ]) {
    const status = await probes.model(address, expected);
    if (status === 'ready') results.push(item(id, 'ready', `${expected} is available at ${address}`));
    else if (status === 'wrong') results.push(item(id, 'blocked', `${address} responds with a different model`, `Configure ${expected} at ${address} or enter the correct address.`));
    else if (speech.mode === 'external') results.push(item(id, 'missing', `${expected} is unavailable at ${address}`, `Start the ${expected} server or correct the URL.`));
    else if (executable && probes.exists(executable)) {
      if (id === 'tts' && speech.ttsEngine === 'omnivoice') {
        const installed = await probes.omniPython(executable);
        results.push(item(id, installed.ok ? 'ready' : 'missing', installed.detail,
          installed.ok ? '' : `Install OmniVoice from PyPI into ${executable} or select an external server.`));
      } else results.push(item(id, 'ready', `${expected} will be started using ${executable}`));
    } else results.push(item(id, 'missing', `Executable for ${id.toUpperCase()} not found: ${executable || 'path not set'}`, `Set the ${id === 'tts' && speech.ttsEngine === 'omnivoice' ? 'OmniVoice Python' : 'vLLM'} path for ${expected} or select an external model.`));
  }

  if (speech.mode === 'local') {
    for (const [id, name] of [['asr-model', 'Qwen3-ASR-0.6B'], ...(speech.ttsEngine === 'qwen' ? [['tts-model', 'Qwen3-TTS-12Hz-1.7B-Base']] : [])]) {
      const folder = `models--Qwen--${name}`;
      results.push(probes.cachedModelReady(path.join(speechCacheRoot(lt.root), folder), id === 'tts-model')
        ? item(id, 'ready', `${name}: model files found`)
        : item(id, 'missing', `${name}: model files not found`, 'Press Start: Studio will download the model into the Hugging Face cache.'));
    }
    if (speech.ttsEngine === 'omnivoice') {
      const folder = path.join(speechCacheRoot(lt.root), 'models--k2-fsa--OmniVoice');
      results.push(probes.cachedOmniModelReady(folder)
        ? item('tts-model', 'ready', 'OmniVoice model files found')
        : item('tts-model', 'missing', 'OmniVoice model files not found', 'Press Start: Studio will download the OmniVoice model into the Hugging Face cache.'));
    }
  }

  results.push(await probes.gpu()
    ? item('gpu', 'ready', 'NVIDIA GPU is available for the avatar')
    : item('gpu', 'missing', 'NVIDIA GPU was not detected for the avatar', 'Check the CUDA driver with nvidia-smi; a local avatar needs a GPU even with external ASR/TTS servers.'));
  const port = await probes.port(lt.port, profile);
  results.push(port === 'incompatible'
    ? item('port', 'blocked', `LiveTalking at ${lt.port} is incompatible with the selected profile`, 'An existing service uses a different avatar model, folder, brain, or TTS engine. Stop and restart it with these settings, or choose another port.')
    : port === 'occupied'
    ? item('port', 'blocked', `Port ${lt.port} is used by another process`, 'Stop the conflicting process or choose another port.')
    : item('port', 'ready', port === 'livetalking' ? `Compatible LiveTalking is already running on ${lt.port}` : `Port ${lt.port} is available`));
  return results;
}
