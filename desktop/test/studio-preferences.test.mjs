import assert from 'node:assert/strict';
import test from 'node:test';
import { projectionPreference, validProjectionUrl } from '../renderer/projection-preferences.mjs';
import { conversationLabel } from '../renderer/conversation-label.mjs';

test('projection address persists for one profile without URL credentials or query secrets', () => {
  const entries = new Map();
  const storage = { getItem: key => entries.get(key) || null, setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
  assert.equal(projectionPreference(storage, 'one', 'http://127.0.0.1:19840/whip'), 'http://127.0.0.1:19840/whip');
  assert.equal(projectionPreference(storage, 'one'), 'http://127.0.0.1:19840/whip');
  assert.equal(projectionPreference(storage, 'two'), '');
  assert.equal(validProjectionUrl('https://host/whip?token=secret'), '');
  assert.equal(validProjectionUrl('https://user:pass@host/whip'), '');
  assert.equal(projectionPreference(storage, 'one', 'https://host/whip?token=secret'), '');
  assert.equal(projectionPreference(storage, 'one'), 'http://127.0.0.1:19840/whip');
  assert.equal([...entries.values()].some(value => value.includes('secret')), false);
  projectionPreference(storage, 'one', '');
  assert.equal(projectionPreference(storage, 'one'), '');
});

test('conversation labels prefer first user message and use date only for empty history', () => {
  const conversation = { id: 'some-uuid', created_at: '2026-10-10T10:00:00Z' };
  assert.equal(conversationLabel(conversation, [{ role: 'assistant', text: 'Hello' }, { role: 'user', text: '  First\nquestion  ' }]), 'First question');
  assert.equal(conversationLabel({ title: 'My chat' }, []), 'My chat');
  assert.equal(conversationLabel(conversation).includes('some-uuid'), false);
});
