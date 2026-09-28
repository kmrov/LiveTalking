import path from 'node:path';
import { readFileSync } from 'node:fs';

const keys = new Set(['YANDEX_AISTUDIO_KEY', 'YANDEX_FOLDER_ID', 'BATYA_DATABASE_URL', 'COMPOSE_PROJECT_NAME']);

export function parseEnv(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || !keys.has(match[1])) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    result[match[1]] = value;
  }
  return result;
}

export function readServiceEnvironment(profile) {
  const result = {};
  for (const root of [profile.liveTalking.root, profile.brain.root]) {
    if (!root) continue;
    try { Object.assign(result, parseEnv(readFileSync(path.join(root, '.env'), 'utf8'))); }
    catch { /* Environment settings are optional when an existing API is adopted. */ }
  }
  return result;
}

export function serviceEnvironment({ values = {}, inherited = process.env, secrets = {}, folderId = '' } = {}) {
  const result = { ...inherited };
  for (const key of keys) {
    if (!result[key] && values[key]) result[key] = values[key];
    if (secrets[key]) result[key] = secrets[key];
  }
  if (folderId) result.YANDEX_FOLDER_ID = folderId;
  return result;
}

export function redactServiceText(text, environment = {}) {
  let result = String(text);
  for (const key of ['YANDEX_AISTUDIO_KEY', 'BATYA_DATABASE_URL']) {
    const secret = environment[key];
    if (secret) result = result.split(secret).join('[redacted]');
  }
  return result.replace(/(postgres(?:ql)?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[redacted]@')
    .replace(/(Api-Key\s+|Bearer\s+)[^\s]+/gi, '$1[redacted]');
}
