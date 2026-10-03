import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './fixture-server.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const executablePath = createRequire(import.meta.url)('electron');
const fixture = await startFixtureServer();
fixture.control.brainMode = 'batya';
const userData = await mkdtemp(path.join(os.tmpdir(), 'livetalking-ui-regressions-'));
const screenshots = path.join(root, 'test-results', 'ui-audit');
await mkdir(screenshots, { recursive: true });
let application;
try {
  application = await electron.launch({ executablePath, args: [root], env: {
    ...process.env, LIVETALKING_DESKTOP_TEST_FIXTURE: '1',
    LIVETALKING_DESKTOP_TEST_PORT: String(fixture.port), LIVETALKING_DESKTOP_TEST_USER_DATA: userData,
  } });
  const window = await application.firstWindow();
  await window.locator('#setup-results li').first().waitFor({ state: 'attached' });
  await window.locator('#brain-mode').selectOption('batya');
  await window.locator('#brain-service-mode').selectOption('external');
  await window.locator('#brain-url').fill(`http://127.0.0.1:${fixture.port}`);
  await window.locator('#start-profile').click();
  await window.waitForFunction(() => document.querySelector('#runtime-state').textContent === 'Работает');
  await window.evaluate(() => { document.querySelector('.left-panel').scrollTop = 0; });
  await window.screenshot({ path: path.join(screenshots, '01-ready.png') });

  await window.evaluate(() => document.querySelector('#new-brain-conversation').click());
  await window.waitForFunction(() => Boolean(document.querySelector('#brain-conversation').value));
  const beforeDouble = fixture.commands.filter(command => command.path === '/api/v1/conversations').length;
  await window.evaluate(() => {
    document.querySelector('#new-brain-conversation').click();
    document.querySelector('#new-brain-conversation').click();
  });
  await window.waitForTimeout(500);
  assert.equal(fixture.commands.filter(command => command.path === '/api/v1/conversations').length - beforeDouble, 1,
    'double click must create one conversation');

  await window.locator('#connect-avatar').click();
  await window.waitForFunction(() => document.querySelector('#webrtc-state').dataset.sessionId === 'fixture-session');
  const conversationBeforeRecordingRace = await window.locator('#brain-conversation').inputValue();
  const recordsBeforeSwitch = fixture.commands.filter(command => command.path === '/record').length;
  await window.evaluate(() => {
    document.querySelector('#new-brain-conversation').click();
    document.querySelector('#record-avatar').click();
  });
  await window.waitForTimeout(250);
  assert.equal(fixture.commands.filter(command => command.path === '/record').length, recordsBeforeSwitch,
    'recording must not start during a conversation change');
  await window.waitForFunction(previous => document.querySelector('#brain-conversation').value !== previous, conversationBeforeRecordingRace);
  await window.locator('#record-avatar').click();
  await window.waitForFunction(() => document.querySelector('#record-avatar').textContent === 'Завершить запись');
  await window.locator('#stop-profile').click();
  await window.waitForTimeout(300);
  assert.equal(await window.locator('#runtime-state').textContent(), 'Работает',
    'Stop must leave the profile running while recording');
  assert.equal(await window.locator('#webrtc-state').getAttribute('data-session-id'), 'fixture-session',
    'Stop must retain the active recording session');
  assert.match(await window.locator('#conversation-message').textContent(), /Завершите запись перед остановкой профиля/);
  await window.locator('#connect-avatar').click();
  assert.equal(await window.locator('#webrtc-state').getAttribute('data-session-id'), 'fixture-session',
    'WebRTC must remain connected while recording');
  assert.equal(await window.locator('#record-avatar').textContent(), 'Завершить запись');
  await application.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true }); });
  await window.locator('#record-avatar').click();
  await window.waitForFunction(() => document.querySelector('#conversation-message').textContent.includes('Сохранение отменено'));

  await window.locator('#message-text').fill('Потоковый ответ');
  await window.locator('#send-message').click();
  await window.waitForFunction(() => document.querySelector('#conversation-list [data-status="delta"]')?.textContent.includes('Привет, сынок.'));
  await window.evaluate(() => { document.querySelector('.left-panel').scrollTop = 0; });
  await window.screenshot({ path: path.join(screenshots, '02-batya.png') });
  await window.setViewportSize({ width: 960, height: 680 });
  await window.evaluate(() => { document.querySelector('.left-panel').scrollTop = 0; });
  await window.screenshot({ path: path.join(screenshots, '03-compact.png') });
  assert.equal(await window.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
    'compact viewport must not overflow horizontally');
  const compactControls = await window.evaluate(() => {
    const send = document.querySelector('#send-message').getBoundingClientRect();
    const dialog = document.querySelector('.right-panel').getBoundingClientRect();
    const projection = document.querySelector('#connect-projection').getBoundingClientRect();
    const stage = document.querySelector('.stage').getBoundingClientRect();
    return { sendVisible: send.top >= dialog.top && send.bottom <= Math.min(dialog.bottom, innerHeight),
      projectionVisible: projection.top >= stage.top && projection.bottom <= Math.min(stage.bottom, innerHeight) };
  });
  assert.equal(compactControls.sendVisible, true, 'Send button must fit inside the compact dialog panel');
  assert.equal(compactControls.projectionVisible, true, 'Projection button must fit inside the compact stage');
  await window.locator('#refresh-brain-conversations').click();
  await window.waitForTimeout(250);
  assert.match(await window.locator('#conversation-list [data-role="assistant"]').textContent(), /Привет, сынок\./,
    'refresh must retain an unfinished answer');
  assert.match(await window.locator('#brain-turn-state').textContent(), /отвечает|думает/,
    'refresh must retain pending state');
  fixture.finishTurn();
  await window.waitForFunction(() => document.querySelector('#conversation-list [data-role="assistant"]')?.dataset.status === 'done');

  await window.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop() {} }] });
    window.AudioContext = class {
      constructor() { this.sampleRate = 16000; this.destination = {}; this.audioWorklet = { addModule: async () => {} }; }
      resume() { return Promise.resolve(); }
      close() { return Promise.resolve(); }
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    };
    window.AudioWorkletNode = class { constructor() { this.port = {}; } connect() {} disconnect() {} };
    window.WebSocket = class {
      constructor() { queueMicrotask(() => this.onopen?.()); }
      send() {}
      close() {}
    };
  });
  await window.locator('#microphone-button').click();
  await window.waitForFunction(() => document.querySelector('#microphone-state').textContent.includes('Говорите'));
  await window.locator('#microphone-button').click();
  await window.waitForFunction(() => document.querySelector('#microphone-state').textContent.includes('Распознавание'));
  const conversationBeforeAsrSwitch = await window.locator('#brain-conversation').inputValue();
  await window.locator('#new-brain-conversation').click();
  await window.waitForTimeout(500);
  assert.notEqual(await window.locator('#brain-conversation').inputValue(), conversationBeforeAsrSwitch,
    `ASR switch failed: ${await window.locator('#conversation-message').textContent()}`);
  assert.equal(await window.locator('#microphone-state').textContent(), 'Нажмите, чтобы говорить',
    'cancelled ASR must not write an error into the new conversation');

  let releaseSend;
  const sendStarted = new Promise(resolve => { releaseSend = resolve; });
  await window.route('**/human', async route => {
    releaseSend();
    await new Promise(resolve => setTimeout(resolve, 300));
    await route.continue();
  });
  await window.evaluate(() => { document.querySelector('#conversation-message').textContent = ''; });
  await window.locator('#message-text').fill('Отправленный текст');
  await window.locator('#send-message').click();
  await sendStarted;
  await window.locator('#message-text').fill('Новый черновик');
  await window.waitForFunction(() => document.querySelector('#conversation-message').textContent === 'Сообщение принято.');
  await window.waitForFunction(() => !document.querySelector('#send-message').disabled);
  assert.equal(await window.locator('#message-text').inputValue(), 'Новый черновик',
    'completed send must retain a newer draft');
  fixture.finishTurn();
  console.log('UI regressions: passed');
} finally {
  await application?.close();
  await fixture.close();
  await rm(userData, { recursive: true, force: true });
}
