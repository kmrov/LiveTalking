import test from 'node:test';
import assert from 'node:assert/strict';

const { createVoiceActivityDetector } = await import('../renderer/voice-activity.mjs').catch(() => ({}));
const chunk = amplitude => Int16Array.from({ length: 160 }, () => Math.round(amplitude * 32767));

test('speech after a short lead-in ends once silence lasts 900 ms', () => {
  assert.equal(typeof createVoiceActivityDetector, 'function');
  const events = [];
  const detector = createVoiceActivityDetector({ sampleRate: 16000,
    onStart: buffered => events.push(['start', buffered.reduce((n, part) => n + part.length, 0)]),
    onAudio: part => events.push(['audio', part.length]),
    onEnd: accepted => events.push(['end', accepted]),
  });
  for (let i = 0; i < 20; i++) detector.feed(chunk(0));
  for (let i = 0; i < 45; i++) detector.feed(chunk(0.12));
  for (let i = 0; i < 89; i++) detector.feed(chunk(0));
  assert.equal(events.filter(event => event[0] === 'end').length, 0);
  detector.feed(chunk(0));
  assert.equal(events.filter(event => event[0] === 'start').length, 1);
  assert.ok(events[0][1] >= 3000, 'the leading part of the phrase is retained');
  assert.deepEqual(events.at(-1), ['end', true]);
});

test('brief noise never starts an ASR request', () => {
  assert.equal(typeof createVoiceActivityDetector, 'function');
  let starts = 0;
  const detector = createVoiceActivityDetector({ sampleRate: 16000, onStart: () => starts++ });
  for (let i = 0; i < 7; i++) detector.feed(chunk(0.15));
  for (let i = 0; i < 110; i++) detector.feed(chunk(0));
  assert.equal(starts, 0);
});
