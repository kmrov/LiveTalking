import assert from 'node:assert/strict';
import test from 'node:test';
import { isAllowedStudioNavigation, isTrustedStudioSender, mayUseMicrophone } from '../electron/ipc-policy.mjs';

const studioUrl = 'file:///opt/livetalking/renderer/studio.html';

function studioWindow(url = studioUrl) {
  const webContents = { id: 17, url, getURL() { return this.url; } };
  return { webContents };
}

test('IPC policy accepts only the Studio window at its packaged URL', () => {
  const window = studioWindow();
  assert.equal(isTrustedStudioSender({ sender: window.webContents }, window, studioUrl), true);
  assert.equal(isTrustedStudioSender({ sender: { id: 18, getURL: () => studioUrl } }, window, studioUrl), false);
  window.webContents.url = 'https://example.org';
  assert.equal(isTrustedStudioSender({ sender: window.webContents }, window, studioUrl), false);
});

test('IPC policy rejects navigation away from the local Studio URL', () => {
  assert.equal(isAllowedStudioNavigation(studioUrl, studioUrl), true);
  assert.equal(isAllowedStudioNavigation('https://example.org', studioUrl), false);
  assert.equal(isAllowedStudioNavigation('file:///etc/passwd', studioUrl), false);
});

test('IPC policy allows microphone only for the trusted Studio window', () => {
  const window = studioWindow();
  assert.equal(mayUseMicrophone({ sender: window.webContents }, 'media', window, studioUrl, { mediaTypes: ['audio'] }), true);
  assert.equal(mayUseMicrophone({ sender: window.webContents }, 'media', window, studioUrl, { mediaTypes: ['video'] }), false);
  assert.equal(mayUseMicrophone({ sender: window.webContents }, 'camera', window, studioUrl), false);
  window.webContents.url = 'https://example.org';
  assert.equal(mayUseMicrophone({ sender: window.webContents }, 'media', window, studioUrl), false);
});
