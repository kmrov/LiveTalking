import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { findVoiceReferences } from '../electron/discover-voice.mjs';

test('voice discovery finds paired WAV and transcript beside LiveTalking, newest first', () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'lt-voice-'));
  try {
    const root = path.join(parent, 'LiveTalking');
    const cloning = path.join(parent, 'cloning');
    mkdirSync(root);
    mkdirSync(cloning);
    writeFileSync(path.join(cloning, 'voice_reference_old.wav'), 'RIFF');
    writeFileSync(path.join(cloning, 'voice_reference_old.txt'), 'Старый текст');
    writeFileSync(path.join(cloning, 'voice_reference_new.wav'), 'RIFF');
    writeFileSync(path.join(cloning, 'voice_reference_new.txt'), 'Новый текст');
    writeFileSync(path.join(cloning, 'voice_reference_no_text.wav'), 'RIFF');
    utimesSync(path.join(cloning, 'voice_reference_old.wav'), 100, 100);
    utimesSync(path.join(cloning, 'voice_reference_new.wav'), 200, 200);
    const found = findVoiceReferences(root);
    assert.equal(found.length, 2);
    assert.equal(found[0].wav, path.join(cloning, 'voice_reference_new.wav'));
    assert.equal(found[0].text, 'Новый текст');
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('voice discovery returns none for a missing checkout', () => {
  assert.deepEqual(findVoiceReferences(''), []);
});
