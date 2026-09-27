import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './fixture-server.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const artifactDirectory = path.join(root, 'test-results');
const require = createRequire(import.meta.url);
const executablePath = require('electron');
const fixture = await startFixtureServer();
const logs = [];
await mkdir(artifactDirectory, { recursive: true });

async function runCase(corrupt) {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'livetalking-smoke-'));
  if (corrupt) await writeFile(path.join(userData, 'profiles.json'), '{broken');
  const application = await electron.launch({
    executablePath,
    args: [root],
    env: { ...process.env, LIVETALKING_DESKTOP_TEST_FIXTURE: '1', LIVETALKING_DESKTOP_TEST_PORT: String(fixture.port), LIVETALKING_DESKTOP_TEST_USER_DATA: userData },
    timeout: 30000,
  });
  try {
    const window = await application.firstWindow();
    window.on('console', event => logs.push(event.text()));
    window.on('pageerror', error => logs.push(`Renderer error: ${error.stack}`));
    await window.locator('#setup-results li').first().waitFor({ state: 'attached' });
    if (corrupt) {
      assert.match(await window.locator('#setup-recovery').textContent(), /invalid/i);
      assert.equal(await window.locator('#setup-form').isVisible(), true);
      console.log('Corrupt profile startup: passed');
      return;
    }
    await window.locator('#start-profile').click();
    await window.waitForFunction(() => document.querySelector('#runtime-state').textContent === 'Работает');
    await window.locator('#connect-avatar').click();
    await window.waitForFunction(() => document.querySelector('#webrtc-state').dataset.sessionId === 'fixture-session');
    await window.locator('#conversation-mode').selectOption('echo');
    await window.locator('#message-text').fill('Привет из smoke-теста');
    await window.locator('#send-message').click();
    await window.waitForFunction(() => document.querySelector('#conversation-message').textContent === 'Сообщение принято.');
    assert.deepEqual(fixture.commands.find(command => command.path === '/human').body, { sessionid: 'fixture-session', text: 'Привет из smoke-теста', type: 'echo', interrupt: true });
    await window.locator('#interrupt-avatar').click();
    await window.waitForFunction(() => document.querySelector('#conversation-message').textContent === 'Озвучивание прервано.');
    assert.equal(fixture.commands.some(command => command.path === '/interrupt_talk'), true);
    await window.screenshot({ path: path.join(artifactDirectory, 'smoke-studio.png') });
    await window.locator('#stop-profile').click();
    await window.waitForFunction(() => document.querySelector('#runtime-state').textContent === 'Не настроено');
    assert.equal(await window.locator('#send-message').isDisabled(), true);
    assert.equal(await window.locator('#record-avatar').isDisabled(), true);
    assert.equal(await window.locator('#webrtc-state').getAttribute('data-session-id'), '');
    console.log('Setup → Start → WebRTC → text → interrupt → Stop: passed');
  } finally {
    await application.close();
    await rm(userData, { recursive: true, force: true });
  }
}

try {
  await runCase(false);
  await runCase(true);
  assert.equal(logs.some(line => line.includes('Renderer error')), false);
} finally {
  await fixture.close();
  await writeFile(path.join(artifactDirectory, 'smoke.log'), logs.join('\n'));
}
