import path from 'node:path';
import os from 'node:os';
import { existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { normalizeProfile } from '../src/profile.mjs';
import { createAvatarLibrary } from './avatar-library.mjs';

const item = (id, state, detail, action = '') => ({ id, state, detail, action });
const asrModel = 'Qwen/Qwen3-ASR-0.6B';
const ttsModel = 'Qwen/Qwen3-TTS-12Hz-1.7B-Base';

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
    return readdirSync(path.join(folder, 'snapshots')).some(revision => {
      const snapshot = path.join(folder, 'snapshots', revision);
      return ['config.json', 'tokenizer_config.json', 'preprocessor_config.json'].every(file => fileReady(path.join(snapshot, file)))
        && weightsReady(snapshot)
        && (!needsSpeechTokenizer || (fileReady(path.join(snapshot, 'speech_tokenizer/config.json')) && weightsReady(path.join(snapshot, 'speech_tokenizer'))));
    });
  } catch { return false; }
}

function avatarWeightFiles(lt) {
  const models = {
    wav2lip: ['models/wav2lip.pth'],
    musetalk: ['models/musetalkV15/unet.pth', 'models/musetalkV15/musetalk.json', 'models/sd-vae/config.json', 'models/sd-vae/diffusion_pytorch_model.bin', 'models/whisper/config.json', 'models/whisper/pytorch_model.bin'],
    ultralight: [`data/avatars/${lt.avatarId}/ultralight.pth`, 'models/hubert-large-ls960-ft/config.json', 'models/hubert-large-ls960-ft/pytorch_model.bin'],
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
      const mode = payload.data.brain?.mode || 'direct';
      if (profile && (mode !== profile.brain.mode || (mode === 'batya' && payload.data.brain.url?.replace(/\/$/, '') !== profile.brain.url))) return 'incompatible';
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
  async python(executable) {
    const result = spawnSync(executable, ['-c', 'import aiohttp, aiortc, torch, requests, soxr'], { encoding: 'utf8', timeout: 20000 });
    return result.status === 0
      ? { ok: true, detail: 'Python, aiohttp, aiortc и torch доступны' }
      : { ok: false, detail: (result.stderr || result.error?.message || 'Не удалось импортировать модули').trim().split('\n').at(-1) };
  },
  model: modelStatus,
  port: portStatus,
  async gpu() {
    const result = spawnSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { encoding: 'utf8', timeout: 5000 });
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
    : item('checkout', 'missing', lt.root ? `Совместимый LiveTalking не найден: ${lt.root}` : 'LiveTalking рядом с приложением не найден', 'Положите папку LiveTalking рядом с приложением или выберите другой каталог с scripts/start_qwen_avatar.py.'));

  let avatar = null;
  if (rootReady) {
    try { avatar = await probes.avatar(lt); } catch { /* Library provides the repair action below. */ }
  }
  results.push(avatar?.ready && avatar.model === lt.model
    ? item('avatar', 'ready', `Аватар ${avatar.name || lt.avatarId} готов`)
    : item('avatar', 'missing', avatar?.reason || `Аватар ${lt.avatarId} не готов для ${lt.model}`, 'Выберите готового аватара из библиотеки или создайте нового.'));

  const requiredWeights = avatarWeightFiles(lt);
  const missingWeights = requiredWeights.filter(file => !probes.fileReady(file));
  results.push(requiredWeights.length && !missingWeights.length
    ? item('avatar-model', 'ready', `Веса ${lt.model} найдены`)
    : item('avatar-model', 'missing', `Веса ${lt.model} не готовы: ${missingWeights.join(', ') || 'неподдерживаемая модель'}`, 'Подготовьте указанные файлы модели в каталоге LiveTalking.'));

  const pythonReady = Boolean(lt.python && probes.exists(lt.python));
  if (!pythonReady) results.push(item('python', 'missing', `Python не найден: ${lt.python || 'путь не задан'}`, `Создайте окружение: python3 -m venv "${lt.root || 'LiveTalking'}/.venv" и установите зависимости.`));
  else {
    const result = await probes.python(lt.python);
    results.push(result.ok ? item('python', 'ready', result.detail) : item('python', 'missing', result.detail, `Установите зависимости в ${lt.python}: python -m pip install -r requirements.txt.`));
  }

  results.push(speech.referenceWav && probes.exists(speech.referenceWav)
    ? item('voice', 'ready', `Образец голоса: ${speech.referenceWav}`)
    : item('voice', 'missing', 'WAV-образец голоса не найден', 'Выберите WAV-файл с образцом голоса.'));
  results.push(speech.referenceText
    ? item('transcript', 'ready', 'Расшифровка образца задана')
    : item('transcript', 'missing', 'Расшифровка образца не задана', 'Введите точный текст, произнесённый в WAV-файле.'));

  for (const [id, expected, address, executable] of [
    ['asr', asrModel, speech.asrUrl || 'http://127.0.0.1:8092', speech.asrVllm],
    ['tts', ttsModel, speech.ttsUrl || 'http://127.0.0.1:8091', speech.ttsVllm],
  ]) {
    const status = await probes.model(address, expected);
    if (status === 'ready') results.push(item(id, 'ready', `${expected} доступна на ${address}`));
    else if (status === 'wrong') results.push(item(id, 'blocked', `${address} отвечает другой моделью`, `Настройте ${expected} на ${address} или укажите правильный адрес.`));
    else if (speech.mode === 'external') results.push(item(id, 'missing', `${expected} недоступна на ${address}`, `Запустите сервер ${expected} или исправьте URL.`));
    else if (executable && probes.exists(executable)) results.push(item(id, 'ready', `${expected} будет запущена через ${executable}`));
    else results.push(item(id, 'missing', `Исполняемый файл ${id.toUpperCase()} не найден: ${executable || 'путь не задан'}`, `Укажите путь к vLLM для ${expected} или выберите внешнюю модель.`));
  }

  if (speech.mode === 'local') {
    for (const [id, name] of [['asr-model', 'Qwen3-ASR-0.6B'], ['tts-model', 'Qwen3-TTS-12Hz-1.7B-Base']]) {
      const folder = `models--Qwen--${name}`;
      const locations = [
        process.env.HF_HOME && path.join(process.env.HF_HOME, 'hub', folder),
        lt.root && path.join(path.dirname(lt.root), '.hf-cache-qwen/hub', folder),
        path.join(os.homedir(), '.cache/huggingface/hub', folder),
      ].filter(Boolean);
      results.push(locations.some(folder => probes.cachedModelReady(folder, id === 'tts-model'))
        ? item(id, 'ready', `${name}: файлы модели найдены`)
        : item(id, 'missing', `${name}: файлы модели не найдены`, 'Подготовьте веса в Hugging Face cache или настройте внешние серверы моделей.'));
    }
  }

  results.push(await probes.gpu()
    ? item('gpu', 'ready', 'NVIDIA GPU для аватара доступна')
    : item('gpu', 'missing', 'NVIDIA GPU для аватара не обнаружена', 'Проверьте драйвер CUDA через nvidia-smi; локальному аватару GPU нужна и при внешних ASR/TTS серверах.'));
  const port = await probes.port(lt.port, profile);
  results.push(port === 'incompatible'
    ? item('port', 'blocked', `LiveTalking на ${lt.port} запущен с другим мозгом`, 'Остановите прежний сервис или выберите другой порт; настройки мозга применяются при запуске.')
    : port === 'occupied'
    ? item('port', 'blocked', `Порт ${lt.port} занят другим процессом`, 'Остановите конфликтующий процесс или выберите другой порт.')
    : item('port', 'ready', port === 'livetalking' ? `Совместимый LiveTalking уже работает на ${lt.port}` : `Порт ${lt.port} свободен`));
  return results;
}
