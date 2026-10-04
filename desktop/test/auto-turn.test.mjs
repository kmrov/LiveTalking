import test from 'node:test';
import assert from 'node:assert/strict';

const { waitForAvatarReply, waitForSendSlot } = await import('../renderer/auto-turn.mjs').catch(() => ({}));

test('the next phrase waits until the avatar has spoken and become quiet', async () => {
  assert.equal(typeof waitForAvatarReply, 'function');
  let time = 0;
  const states = [false, false, true, true, false, false, false];
  let polls = 0;
  const result = await waitForAvatarReply({
    speaking: async () => states[polls++] ?? false,
    pending: () => false,
    now: () => time,
    sleep: async ms => { time += ms; },
    quietMs: 500,
  });
  assert.equal(result, 'finished');
  assert.equal(polls, 7);
  assert.ok(time >= 1500);
});

test('Persona pending and avatar speech are both observed before listening resumes', async () => {
  assert.equal(typeof waitForAvatarReply, 'function');
  let time = 0;
  let checks = 0;
  let polls = 0;
  const result = await waitForAvatarReply({
    pending: () => checks++ < 2,
    speaking: async () => { polls++; return polls === 3 || polls === 4; },
    now: () => time, sleep: async ms => { time += ms; }, quietMs: 500,
  });
  assert.equal(result, 'finished');
  assert.ok(polls >= 6, 'speech must be polled even while Persona is preparing a reply');
  assert.equal(polls, checks);
});

test('an aborted wait stops before polling the old avatar again', async () => {
  assert.equal(typeof waitForAvatarReply, 'function');
  const abort = new AbortController();
  let polls = 0;
  const result = await waitForAvatarReply({
    speaking: async () => { polls++; abort.abort(); return true; },
    pending: () => false,
    signal: abort.signal,
    sleep: async () => {},
  });
  assert.equal(result, 'aborted');
  assert.equal(polls, 1);
});

test('a barged-in phrase waits until the previous chat request is submitted', async () => {
  assert.equal(typeof waitForSendSlot, 'function');
  let polls = 0;
  const ready = await waitForSendSlot({ busy: () => polls++ < 3, sleep: async () => {} });
  assert.equal(ready, true);
  assert.equal(polls, 4);
});
