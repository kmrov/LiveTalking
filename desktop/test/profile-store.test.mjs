import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createProfileStore } from '../electron/profile-store.mjs';

test('profile store round trips profiles and last successful ID without keys', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'lt-profiles-'));
  try {
    const store = createProfileStore(directory);
    store.save({ id: 'main', liveTalking: { root: '/tmp/Мой LiveTalking', port: 8010 }, llm: { apiKey: 'never-save' } });
    store.setLastSuccessfulId('main');
    const reopened = createProfileStore(directory);
    assert.equal(reopened.get('main').liveTalking.root, '/tmp/Мой LiveTalking');
    assert.equal(reopened.lastSuccessfulId(), 'main');
    assert.equal(readFileSync(path.join(directory, 'profiles.json'), 'utf8').includes('never-save'), false);
    assert.equal(readdirSync(directory).some(name => name.includes('.tmp')), false);
    reopened.remove('main');
    assert.deepEqual(reopened.list(), []);
    assert.equal(reopened.lastSuccessfulId(), null);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('profile store quarantines invalid JSON and reports a recoverable error', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'lt-profiles-'));
  try {
    writeFileSync(path.join(directory, 'profiles.json'), '{broken');
    const store = createProfileStore(directory);
    assert.deepEqual(store.list(), []);
    assert.match(store.recoveryError(), /invalid|поврежд|corrupt/i);
    assert.equal(readdirSync(directory).some(name => name.startsWith('profiles.corrupt-')), true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
