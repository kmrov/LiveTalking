import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeProfile } from '../src/profile.mjs';

test('old profiles migrate to direct brain and Persona configuration excludes credentials', () => {
  assert.equal(normalizeProfile({}).brain.mode, 'direct');
  assert.equal(normalizeProfile({ brain: { mode: 'batya' } }).brain.mode, 'persona');
  const profile = normalizeProfile({ brain: { mode: 'persona', root: '/tmp/Персона', python: '/tmp/Персона/.venv/bin/python', url: 'http://127.0.0.1:8000', conversationId: '49819c24-d2ab-46d2-bce3-479e315d956e', apiKey: 'secret', databaseUrl: 'secret' } });
  assert.equal(profile.brain.conversationId, '49819c24-d2ab-46d2-bce3-479e315d956e');
  assert.equal(JSON.stringify(profile).includes('secret'), false);
  assert.throws(() => normalizeProfile({ brain: { conversationId: '../../file' } }), /conversationId/);
  assert.throws(() => normalizeProfile({ brain: { mode: 'unknown' } }), /brain.mode/);
  assert.throws(() => normalizeProfile({ brain: { managed: true, url: 'https://remote.example' } }), /local|loopback/);
});

test('saved Batya checkout paths follow the renamed Persona directory', () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'persona-profile-'));
  try {
    const root = path.join(parent, 'persona');
    mkdirSync(path.join(root, 'src/persona'), { recursive: true });
    writeFileSync(path.join(root, 'src/persona/main.py'), '');
    const migrated = normalizeProfile({ brain: {
      mode: 'batya', root: path.join(parent, 'batya'),
      python: path.join(parent, 'batya/.venv/bin/python'),
    } });
    assert.equal(migrated.brain.mode, 'persona');
    assert.equal(migrated.brain.root, root);
    assert.equal(migrated.brain.python, path.join(root, '.venv/bin/python'));
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('SillyTavern mode keeps Persona settings and validates loopback API URL', () => {
  const profile = normalizeProfile({ brain: {
    mode: 'sillytavern', url: 'http://127.0.0.1:8000', sillyTavernUrl: 'http://127.0.0.1:8001',
    sillyTavernRoot: '/home/user/SillyTavern', folderId: 'folder',
  } });
  assert.equal(profile.brain.mode, 'sillytavern');
  assert.equal(profile.brain.url, 'http://127.0.0.1:8000');
  assert.equal(profile.brain.sillyTavernUrl, 'http://127.0.0.1:8001');
  assert.equal(profile.brain.sillyTavernCharacter, 'Viktor_Petrovich_Studio.png');
  assert.equal(normalizeProfile({ brain: { mode: 'sillytavern', sillyTavernCharacter: 'Другая героиня.png' } }).brain.sillyTavernCharacter, 'Другая героиня.png');
  assert.throws(() => normalizeProfile({ brain: { mode: 'sillytavern', sillyTavernCharacter: '../escape.png' } }), /character filename/);
  assert.throws(() => normalizeProfile({ brain: { mode: 'sillytavern', sillyTavernUrl: 'https://example.org' } }), /sillyTavernUrl/);
});
