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

test('conversation snapshot replaces replayed partial text without duplication', () => {
  const event = { brain: 'batya', conversation_id: 'selected', request_id: 'one', event: 'snapshot', status: 'delta', text: 'Привет. ', pending: 1 };
  let state = { conversationId: 'selected', turns: { one: { text: 'Привет. ', status: 'delta', error: '' } }, pending: 0 };
  state = reduceBrainEvent(state, event);
  assert.equal(state.turns.one.status, 'delta');
  assert.equal(state.turns.one.text, 'Привет. ');
  assert.equal(state.pending, 1);
  state = reduceBrainEvent(state, { ...event, status: 'done', text: 'Привет. Как дела?', pending: 0 });
  assert.equal(state.turns.one.status, 'done');
  assert.equal(state.turns.one.text, 'Привет. Как дела?');
  assert.equal(state.pending, 0);
});
