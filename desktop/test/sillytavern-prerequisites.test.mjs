import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeProfile } from '../src/profile.mjs';

test('SillyTavern setup reports missing Node modules and Yandex credentials', async () => {
  const { inspectSillyTavernPrerequisites } = await import('../electron/sillytavern-prerequisites.mjs');
  const profile = normalizeProfile({ brain: { mode: 'sillytavern', sillyTavernRoot: '/tmp/no-st' } });
  const results = await inspectSillyTavernPrerequisites(profile, {}, {
    exists: () => false, health: async () => false, node: async () => true,
  });
  assert.equal(results.find(item => item.id === 'sillytavern').state, 'missing');
  assert.equal(results.find(item => item.id === 'sillytavern-credentials').state, 'missing');
  assert.match(results.find(item => item.id === 'sillytavern').action, /npm ci/);
});
