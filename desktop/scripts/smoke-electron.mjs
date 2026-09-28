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
    assert.equal(await window.locator('#avatar-video').evaluate(video => video.muted), true, 'only the audio element may play incoming audio');
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
  await runBatyaCase();
  assert.equal(logs.some(line => line.includes('Renderer error')), false);
} finally {
  await fixture.close();
  await writeFile(path.join(artifactDirectory, 'smoke.log'), logs.join('\n'));
}

async function runBatyaCase() {
  fixture.control.brainMode = 'batya';
  const userData = await mkdtemp(path.join(os.tmpdir(), 'livetalking-batya-smoke-'));
  let application;
  const launch = () => electron.launch({ executablePath, args: [root],
    env: { ...process.env, LIVETALKING_DESKTOP_TEST_FIXTURE: '1', LIVETALKING_DESKTOP_TEST_PORT: String(fixture.port), LIVETALKING_DESKTOP_TEST_USER_DATA: userData }, timeout: 30000 });
  try {
    application = await launch();
    const window = await application.firstWindow();
    window.on('pageerror', error => logs.push(`Renderer error: ${error.stack}`));
    await window.locator('#setup-results li').first().waitFor({ state: 'attached' });
    await window.locator('#brain-mode').selectOption('batya');
    await window.locator('#brain-service-mode').selectOption('external');
    await window.locator('#brain-url').fill(`http://127.0.0.1:${fixture.port}`);
    await window.locator('#start-profile').click();
    await window.waitForFunction(() => document.querySelector('#runtime-state').textContent === 'Работает');
    await window.locator('#new-brain-conversation').click();
    await window.waitForFunction(() => Boolean(document.querySelector('#brain-conversation').value));
    const id = await window.locator('#brain-conversation').inputValue();
    await window.locator('#connect-avatar').click();
    await window.waitForFunction(() => document.querySelector('#brain-turn-state').dataset.stream === 'connected');
    await window.locator('#message-text').fill('Привет из теста Бати');
    await window.locator('#send-message').click();
    await window.waitForFunction(() => document.querySelector('#conversation-list [data-role="assistant"]')?.textContent.includes('Привет, сынок.'));
    assert.equal(await window.locator('#conversation-list [data-role="assistant"]').getAttribute('data-status'), 'delta');
    await window.locator('#interrupt-avatar').click();
    await window.waitForFunction(() => document.querySelector('#brain-turn-state').textContent.includes('завершает'));
    assert.match(await window.locator('#brain-turn-state').textContent(), /завершает/);
    fixture.finishTurn();
    await window.waitForFunction(() => document.querySelector('#conversation-list [data-role="assistant"]')?.dataset.status === 'done');
    await window.locator('#connect-avatar').click();
    await window.locator('#connect-avatar').click();
    await window.waitForFunction(() => document.querySelector('#brain-turn-state').dataset.stream === 'connected');
    assert.equal(await window.locator('#brain-conversation').inputValue(), id);
    assert.equal(await window.locator('#conversation-list [data-role="assistant"]').count(), 1);
    fixture.control.failNextTurn = true;
    await window.locator('#message-text').fill('Проверка повтора'); await window.locator('#send-message').click();
    await window.locator('#retry-message').waitFor();
    const request = fixture.commands.filter(c => c.path === '/human' && c.body.type === 'chat').at(-1).body.request_id;
    await window.locator('#retry-message').click();
    await window.waitForFunction(() => document.querySelectorAll('#conversation-list [data-status="delta"]').length > 0);
    assert.equal(fixture.commands.filter(c => c.path === '/human').at(-1).body.request_id, request);
    fixture.finishTurn();
    await window.waitForFunction(() => [...document.querySelectorAll('#conversation-list [data-role="assistant"]')].at(-1)?.dataset.status === 'done');
    assert.equal(await window.locator('#conversation-list [data-role="assistant"]').count(), 2);
    await window.screenshot({ path: path.join(artifactDirectory, 'smoke-batya.png') });
    await application.close(); application = await launch();
    const reopened = await application.firstWindow();
    await reopened.locator('#setup-results li').first().waitFor({ state: 'attached' });
    await reopened.locator('#start-profile').click();
    await reopened.waitForFunction(() => document.querySelectorAll('#conversation-list [data-role="assistant"]').length === 2);
    assert.equal(await reopened.locator('#brain-conversation').inputValue(), id);
    await reopened.locator('#stop-profile').click();
    await reopened.waitForFunction(() => document.querySelector('#runtime-state').textContent === 'Не настроено');
    fixture.control.brainMode = 'direct';
    await reopened.locator('#setup-details').evaluate(details => { details.open = true; });
    await reopened.locator('#brain-mode').selectOption('direct');
    await reopened.locator('#start-profile').click();
    await reopened.waitForFunction(() => document.querySelector('#runtime-state').textContent === 'Работает');
    assert.equal(await reopened.locator('#brain-conversations').isHidden(), true);
    console.log('Batya streaming → interrupt → reconnect/history → error/retry → restart → direct mode: passed');
  } finally { await application?.close(); await rm(userData, { recursive: true, force: true }); fixture.control.brainMode = 'direct'; }
}
