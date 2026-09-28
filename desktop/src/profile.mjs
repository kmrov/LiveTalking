import path from 'node:path';

export class ProfileError extends Error {
  constructor(field, message) {
    super(`${field}: ${message}`);
    this.name = 'ProfileError';
    this.field = field;
  }
}

function object(value, field) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProfileError(field, 'expected an object');
  return value;
}

function string(value, field, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value.includes('\0')) throw new ProfileError(field, 'expected text');
  return value.trim();
}

function absolutePath(value, field, fallback = '') {
  const text = string(value, field, fallback);
  if (text && !path.isAbsolute(text)) throw new ProfileError(field, 'expected an absolute path');
  return text;
}

function url(value, field) {
  const text = string(value, field);
  if (!text) return '';
  let parsed;
  try { parsed = new URL(text); } catch { throw new ProfileError(field, 'expected an HTTP URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new ProfileError(field, 'expected an HTTP URL without credentials');
  return text;
}

export function normalizeProfile(input) {
  const source = object(input, 'profile');
  const id = string(source.id, 'id', 'default');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new ProfileError('id', 'use 1–64 letters, numbers, _ or -');
  const lt = object(source.liveTalking, 'liveTalking');
  const speech = object(source.speech, 'speech');
  const llm = object(source.llm, 'llm');
  const brain = object(source.brain, 'brain');
  const root = absolutePath(lt.root, 'liveTalking.root');
  const port = lt.port ?? 8010;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ProfileError('liveTalking.port', 'expected port 1–65535');
  const mode = string(speech.mode, 'speech.mode', 'local');
  if (!['local', 'external'].includes(mode)) throw new ProfileError('speech.mode', 'expected local or external');
  const autoStart = source.autoStart ?? true;
  if (typeof autoStart !== 'boolean') throw new ProfileError('autoStart', 'expected a boolean');
  const avatarId = string(lt.avatarId, 'liveTalking.avatarId', 'wav2lip256_avatar1');
  if (!/^[\p{L}\p{N}_-]{1,128}$/u.test(avatarId)) throw new ProfileError('liveTalking.avatarId', 'use letters, numbers, _ or -');
  const brainMode = string(brain.mode, 'brain.mode', 'direct');
  if (!['direct', 'batya'].includes(brainMode)) throw new ProfileError('brain.mode', 'expected direct or batya');
  const brainRoot = absolutePath(brain.root, 'brain.root');
  const managed = brain.managed ?? true;
  if (typeof managed !== 'boolean') throw new ProfileError('brain.managed', 'expected a boolean');
  const brainUrl = url(brain.url, 'brain.url') || 'http://127.0.0.1:8000';
  const address = new URL(brainUrl);
  if (address.search || address.hash) throw new ProfileError('brain.url', 'query and fragment are not supported');
  if (managed && (address.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(address.hostname) || address.pathname !== '/')) throw new ProfileError('brain.url', 'managed Batya requires a loopback HTTP URL');
  const databaseMode = string(brain.databaseMode, 'brain.databaseMode', 'compose');
  if (!['compose', 'external'].includes(databaseMode)) throw new ProfileError('brain.databaseMode', 'expected compose or external');
  const conversationId = string(brain.conversationId, 'brain.conversationId');
  if (conversationId && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(conversationId)) throw new ProfileError('brain.conversationId', 'expected a UUID');
  return {
    schemaVersion: 1,
    id,
    name: string(source.name, 'name', 'Основной'),
    liveTalking: {
      root,
      python: absolutePath(lt.python, 'liveTalking.python', root ? path.join(root, '.venv/bin/python') : ''),
      model: string(lt.model, 'liveTalking.model', 'wav2lip'),
      avatarId,
      port,
    },
    speech: {
      mode,
      asrVllm: absolutePath(speech.asrVllm, 'speech.asrVllm'),
      ttsVllm: absolutePath(speech.ttsVllm, 'speech.ttsVllm'),
      asrUrl: url(speech.asrUrl, 'speech.asrUrl'),
      ttsUrl: url(speech.ttsUrl, 'speech.ttsUrl'),
      referenceWav: absolutePath(speech.referenceWav, 'speech.referenceWav'),
      referenceText: string(speech.referenceText, 'speech.referenceText'),
    },
    llm: {
      provider: string(llm.provider, 'llm.provider', 'yandex'),
      model: string(llm.model, 'llm.model'),
      promptFile: absolutePath(llm.promptFile, 'llm.promptFile'),
    },
    brain: {
      mode: brainMode, root: brainRoot,
      python: absolutePath(brain.python, 'brain.python', brainRoot ? path.join(brainRoot, '.venv/bin/python') : ''),
      url: brainUrl.replace(/\/$/, ''), managed, databaseMode,
      folderId: string(brain.folderId, 'brain.folderId'), conversationId,
    },
    autoStart,
  };
}
