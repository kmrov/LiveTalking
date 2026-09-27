import assert from 'node:assert/strict';
import test from 'node:test';
import { initialServiceState, transitionServiceState } from '../src/service-state.mjs';

test('service state covers checking, start, ready, failure, retry and stop', () => {
  let state = initialServiceState();
  state = transitionServiceState(state, { type: 'CHECK', profileId: 'main' });
  assert.equal(state.phase, 'checking');
  state = transitionServiceState(state, { type: 'START', profileId: 'main' });
  assert.equal(state.phase, 'starting');
  state = transitionServiceState(state, { type: 'READY', profileId: 'main' });
  assert.equal(state.phase, 'ready');
  state = transitionServiceState(state, { type: 'CHILD_EXIT', detail: 'code 1' });
  assert.equal(state.phase, 'failed');
  state = transitionServiceState(state, { type: 'RETRY', profileId: 'main' });
  assert.equal(state.phase, 'checking');
  state = transitionServiceState(state, { type: 'STOP' });
  assert.equal(state.phase, 'not-configured');
});

test('service state ignores duplicate start and stale events after profile change', () => {
  let state = transitionServiceState(initialServiceState(), { type: 'START', profileId: 'first' });
  const duplicate = transitionServiceState(state, { type: 'START', profileId: 'first' });
  assert.deepEqual(duplicate, state);
  state = transitionServiceState(state, { type: 'PROFILE_CHANGE', profileId: 'second' });
  assert.equal(state.phase, 'not-configured');
  state = transitionServiceState(state, { type: 'READY', profileId: 'first' });
  assert.equal(state.phase, 'not-configured');
});
