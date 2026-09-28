import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeProfile } from '../src/profile.mjs';

test('old profiles migrate to direct brain and Batya configuration excludes credentials', () => {
  assert.equal(normalizeProfile({}).brain.mode, 'direct');
  const profile = normalizeProfile({ brain: { mode: 'batya', root: '/tmp/Батя', python: '/tmp/Батя/.venv/bin/python', url: 'http://127.0.0.1:8000', conversationId: '49819c24-d2ab-46d2-bce3-479e315d956e', apiKey: 'secret', databaseUrl: 'secret' } });
  assert.equal(profile.brain.conversationId, '49819c24-d2ab-46d2-bce3-479e315d956e');
  assert.equal(JSON.stringify(profile).includes('secret'), false);
  assert.throws(() => normalizeProfile({ brain: { conversationId: '../../file' } }), /conversationId/);
  assert.throws(() => normalizeProfile({ brain: { mode: 'unknown' } }), /brain.mode/);
  assert.throws(() => normalizeProfile({ brain: { managed: true, url: 'https://remote.example' } }), /local|loopback/);
});
