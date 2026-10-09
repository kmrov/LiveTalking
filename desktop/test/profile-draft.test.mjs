import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeProfile } from '../src/profile.mjs';
import { activeProfileDraft, activeSecretDraft } from '../renderer/profile-draft.mjs';

test('inactive SillyTavern URL is ignored when saving Persona or Direct LLM', () => {
  const saved = normalizeProfile({ brain: { sillyTavernUrl: 'http://127.0.0.1:8001' } });
  for (const mode of ['persona', 'direct']) {
    const draft = structuredClone(saved);
    draft.brain.mode = mode;
    draft.brain.sillyTavernUrl = 'broken';
    const active = activeProfileDraft(saved, draft);
    assert.equal(normalizeProfile(active).brain.sillyTavernUrl, saved.brain.sillyTavernUrl);
  }
});

test('inactive external ASR/TTS URLs are ignored when saving local mode', () => {
  const saved = normalizeProfile({ speech: { asrUrl: 'http://127.0.0.1:8092', ttsUrl: 'http://127.0.0.1:8091' } });
  const draft = structuredClone(saved);
  draft.speech.mode = 'local';
  draft.speech.asrUrl = 'broken';
  draft.speech.ttsUrl = 'broken';
  const active = activeProfileDraft(saved, draft);
  assert.equal(normalizeProfile(active).speech.asrUrl, saved.speech.asrUrl);
  assert.equal(normalizeProfile(active).speech.ttsUrl, saved.speech.ttsUrl);
});

test('active invalid URLs still fail profile validation', () => {
  const saved = normalizeProfile({});
  for (const [mode, field] of [['external', 'asrUrl'], ['external', 'ttsUrl']]) {
    const draft = structuredClone(saved);
    draft.speech.mode = mode;
    draft.speech[field] = 'broken';
    assert.throws(() => normalizeProfile(activeProfileDraft(saved, draft)), error => error.field === `speech.${field}`);
  }
  const draft = structuredClone(saved);
  draft.brain.mode = 'sillytavern';
  draft.brain.sillyTavernUrl = 'broken';
  assert.throws(() => normalizeProfile(activeProfileDraft(saved, draft)), error => error.field === 'brain.sillyTavernUrl');
});

test('secret drafts include only visible settings and preserve hidden saved secrets', () => {
  const input = { apiKey: 'new-key', databaseUrl: 'postgresql://new' };
  const direct = normalizeProfile({ brain: { mode: 'direct' } });
  assert.deepEqual(activeSecretDraft(direct, input), { apiKey: '', databaseUrl: '' });
  const externalPersona = normalizeProfile({ brain: { mode: 'persona', managed: false } });
  assert.deepEqual(activeSecretDraft(externalPersona, input), { apiKey: '', databaseUrl: '' });
  const managedPersona = normalizeProfile({ brain: { mode: 'persona', managed: true } });
  assert.deepEqual(activeSecretDraft(managedPersona, input), input);
  const sillytavern = normalizeProfile({ brain: { mode: 'sillytavern' } });
  assert.deepEqual(activeSecretDraft(sillytavern, input), { apiKey: 'new-key', databaseUrl: '' });
});
