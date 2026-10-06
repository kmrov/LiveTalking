import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeProfile, ProfileError } from '../src/profile.mjs';

test('profile accepts spaced Unicode paths and drops secret fields', () => {
  const root = '/home/user/Мой LiveTalking';
  const profile = normalizeProfile({
    id: 'main',
    liveTalking: { root, python: `${root}/.venv/bin/python`, model: 'musetalk', avatarId: 'avatar_1', port: 8010 },
    speech: { mode: 'external', asrUrl: 'http://127.0.0.1:8000', ttsUrl: 'http://127.0.0.1:8001', referenceWav: `${root}/голос.wav`, referenceText: 'Привет' },
    llm: { provider: 'yandex', model: 'model', apiKey: 'private-value' },
    apiKey: 'private-value',
  });
  assert.equal(profile.liveTalking.root, root);
  assert.equal(profile.speech.referenceWav, `${root}/голос.wav`);
  assert.equal(profile.llm.apiKey, undefined);
  assert.equal(JSON.stringify(profile).includes('private-value'), false);
});

test('profile reports invalid field names', () => {
  assert.throws(() => normalizeProfile({ id: '../../escape' }), error => error instanceof ProfileError && error.field === 'id');
  assert.throws(() => normalizeProfile({ id: 'main', liveTalking: { port: 70000 } }), error => error instanceof ProfileError && error.field === 'liveTalking.port');
  assert.throws(() => normalizeProfile({ id: 'main', liveTalking: { avatarId: '../../escape' } }), error => error instanceof ProfileError && error.field === 'liveTalking.avatarId');
});

test('speech profile keeps OmniVoice engine and its Python without changing older Qwen profiles', () => {
  assert.equal(normalizeProfile({}).speech.ttsEngine, 'qwen');
  const speech = normalizeProfile({ speech: { ttsEngine: 'omnivoice', omniPython: '/opt/omnivoice/bin/python' } }).speech;
  assert.equal(speech.ttsEngine, 'omnivoice');
  assert.equal(speech.omniPython, '/opt/omnivoice/bin/python');
  assert.throws(() => normalizeProfile({ speech: { ttsEngine: 'other' } }), error => error instanceof ProfileError && error.field === 'speech.ttsEngine');
});
