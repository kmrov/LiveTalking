import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { discoverLiveTalkingRoot } from '../electron/discover-root.mjs';

function markers(...roots) {
  const files = new Set(roots.flatMap(root => [path.join(root, 'app.py'), path.join(root, 'config.py')]));
  return file => files.has(file);
}

test('discover root uses the parent checkout during development', () => {
  const root = '/home/user/Проекты/Live Talking';
  assert.equal(discoverLiveTalkingRoot({ appPath: path.join(root, 'desktop'), executablePath: '/usr/bin/electron', exists: markers(root) }), root);
});

test('discover root uses the AppImage location before the temporary mount', () => {
  const root = '/home/user/Apps/LiveTalking';
  assert.equal(discoverLiveTalkingRoot({
    appPath: '/tmp/.mount_studio/resources/app.asar',
    executablePath: '/tmp/.mount_studio/studio',
    appImagePath: '/home/user/Apps/Studio.AppImage',
    exists: markers(root),
  }), root);
});

test('discover root uses a sibling of a regular installed executable', () => {
  const root = '/opt/studio/LiveTalking';
  assert.equal(discoverLiveTalkingRoot({ appPath: '/opt/studio/resources/app.asar', executablePath: '/opt/studio/studio', exists: markers(root) }), root);
});

test('discover root returns null when missing, and preserves an explicit override for diagnosis', () => {
  const options = { appPath: '/missing/app.asar', executablePath: '/missing/studio', exists: () => false };
  assert.equal(discoverLiveTalkingRoot(options), null);
  assert.equal(discoverLiveTalkingRoot({ ...options, override: '/other/LiveTalking' }), '/other/LiveTalking');
});
