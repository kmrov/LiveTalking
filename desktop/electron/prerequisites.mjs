import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { normalizeProfile } from '../src/profile.mjs';

const item = (id, state, detail, action = '') => ({ id, state, detail, action });
const asrModel = 'Qwen/Qwen3-ASR-0.6B';
const ttsModel = 'Qwen/Qwen3-TTS-12Hz-1.7B-Base';

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

async function portStatus(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/desktop/health`, { signal: AbortSignal.timeout(2000) });
    const payload = await response.json();
    if (payload.code === 0 && payload.data?.service === 'livetalking' && payload.data?.api_version === 1) return 'livetalking';
  } catch { /* Check whether some other process owns the port. */ }
  return await portOpen(port) ? 'occupied' : 'free';
}

export const defaultProbes = {
  exists: existsSync,
  async python(executable) {
    const result = spawnSync(executable, ['-c', 'import aiohttp, aiortc, torch'], { encoding: 'utf8', timeout: 20000 });
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

  results.push(rootReady && probes.exists(path.join(lt.root, 'data/avatars', lt.avatarId))
    ? item('avatar', 'ready', `Аватар ${lt.avatarId} найден`)
    : item('avatar', 'missing', `Аватар ${lt.avatarId} не найден`, 'Подготовьте аватар в data/avatars или выберите существующий ID.'));

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
      results.push(locations.some(probes.exists)
        ? item(id, 'ready', `${name}: файлы модели найдены`)
        : item(id, 'missing', `${name}: файлы модели не найдены`, 'Подготовьте веса в Hugging Face cache или настройте внешние серверы моделей.'));
    }
  }

  results.push(await probes.gpu()
    ? item('gpu', 'ready', 'NVIDIA GPU для аватара доступна')
    : item('gpu', 'missing', 'NVIDIA GPU для аватара не обнаружена', 'Проверьте драйвер CUDA через nvidia-smi; локальному аватару GPU нужна и при внешних ASR/TTS серверах.'));
  const port = await probes.port(lt.port);
  results.push(port === 'occupied'
    ? item('port', 'blocked', `Порт ${lt.port} занят другим процессом`, 'Остановите конфликтующий процесс или выберите другой порт.')
    : item('port', 'ready', port === 'livetalking' ? `Совместимый LiveTalking уже работает на ${lt.port}` : `Порт ${lt.port} свободен`));
  return results;
}
