import assert from 'node:assert/strict';
import test from 'node:test';
import { reduceBrainEvent } from '../renderer/brain-events.mjs';

test('brain response streams provisionally, resets, reconciles done and ignores other conversations', () => {
  let state = { conversationId: 'selected', turns: {}, pending: 0 };
  const event = (kind, text) => ({ brain: 'batya', conversation_id: 'selected', request_id: 'one', event: kind, text });
  state = reduceBrainEvent(state, event('delta', 'Начало'));
  assert.equal(state.turns.one.text, 'Начало');
  state = reduceBrainEvent(state, event('reset'));
  assert.equal(state.turns.one.text, '');
  state = reduceBrainEvent(state, event('delta', 'Новый'));
  state = reduceBrainEvent(state, event('done', 'Новый ответ.'));
  assert.equal(state.turns.one.text, 'Новый ответ.');
  assert.equal(state.turns.one.status, 'done');
  const unchanged = reduceBrainEvent(state, { ...event('delta', 'Чужой'), conversation_id: 'other' });
  assert.equal(unchanged, state);
  state = reduceBrainEvent(state, { ...event('error'), message: 'Ошибка модели' });
  assert.equal(state.turns.one.error, 'Ошибка модели');
  state = reduceBrainEvent(state, event('queued'));
  assert.equal(state.turns.one.text, '');
  assert.equal(state.turns.one.error, '');
});
