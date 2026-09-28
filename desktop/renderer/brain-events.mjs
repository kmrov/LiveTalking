export function reduceBrainEvent(state, event) {
  if (event?.brain !== 'batya' || event.conversation_id !== state.conversationId || typeof event.request_id !== 'string') return state;
  const previous = state.turns[event.request_id] || { text: '', status: 'queued', error: '' };
  const turn = { ...previous, status: event.event };
  if (event.event === 'snapshot') {
    turn.status = event.status;
    turn.text = typeof event.text === 'string' ? event.text : '';
    turn.error = event.status === 'error' ? event.message || 'Ошибка Бати' : '';
  }
  if (event.event === 'queued' && previous.status === 'error') { turn.text = ''; turn.error = ''; }
  if (event.event === 'delta' && typeof event.text === 'string') turn.text += event.text;
  if (event.event === 'reset') turn.text = '';
  if (event.event === 'done' && typeof event.text === 'string') { turn.text = event.text; turn.error = ''; }
  if (event.event === 'error') turn.error = event.message || 'Ошибка Бати';
  if (event.event === 'idle') turn.status = previous.status;
  return { ...state, turns: { ...state.turns, [event.request_id]: turn },
    pending: Number.isInteger(event.pending) ? Math.max(0, event.pending) : state.pending,
    latest: event.request_id };
}
