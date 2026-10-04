import assert from 'node:assert/strict';
import test from 'node:test';
import { createPersonaApi } from '../electron/persona-api.mjs';
import { serviceEnvironment, redactServiceText, parseEnv } from '../electron/service-environment.mjs';

test('Persona bridge sends only narrow API operations and validates history UUID/document fields', async () => {
  const calls = [];
  const api = createPersonaApi({ baseUrl: 'http://127.0.0.1:8000', fetch: async (url, options) => { calls.push([url, options]); return { ok: true, json: async () => [] }; } });
  await api.conversations();
  await api.createConversation();
  await api.memories();
  assert.throws(() => api.history('../../secrets'), /UUID/);
  await api.document({ title: 'Тест', source: 'Studio', content: 'Материал' });
  assert.equal(calls[0][0], 'http://127.0.0.1:8000/api/v1/conversations');
  assert.equal(calls[1][1].method, 'POST');
  assert.equal(JSON.parse(calls[3][1].body).content, 'Материал');
  assert.throws(() => api.document({ title: 'Тест', source: 'Studio', content: '' }), /content/);
});

test('service environment reads known keys without evaluating shell and redacts secrets', () => {
  const values = parseEnv('YANDEX_AISTUDIO_KEY="private-key"\nYANDEX_FOLDER_ID=folder\nPERSONA_DATABASE_URL=postgresql://user:password@127.0.0.1/db\nCOMPOSE_PROJECT_NAME=persona-live\nPERSONA_SPEECH_MODEL=qwen3.6-35b-a3b\nDANGEROUS=$(cat /etc/passwd)\n');
  const env = serviceEnvironment({ values, inherited: { PATH: '/bin' }, secrets: { YANDEX_AISTUDIO_KEY: 'override-key' } });
  assert.equal(env.YANDEX_AISTUDIO_KEY, 'override-key');
  assert.equal(env.DANGEROUS, undefined);
  assert.equal(env.COMPOSE_PROJECT_NAME, 'persona-live');
  assert.equal(env.PERSONA_SPEECH_MODEL, 'qwen3.6-35b-a3b');
  const text = redactServiceText(`Failed ${env.YANDEX_AISTUDIO_KEY} ${env.PERSONA_DATABASE_URL}`, env);
  assert.equal(text.includes('override-key'), false);
  assert.equal(text.includes('password'), false);
  const legacy = serviceEnvironment({ values: parseEnv('BATYA_DATABASE_URL=postgresql://old:secret@localhost/old\nBATYA_SPEECH_MODEL=deepseek-v4-flash'), inherited: {} });
  assert.equal(legacy.PERSONA_DATABASE_URL, 'postgresql://old:secret@localhost/old');
  assert.equal(legacy.PERSONA_SPEECH_MODEL, 'deepseek-v4-flash');
  assert.equal(legacy.COMPOSE_PROJECT_NAME, 'batya');
});
