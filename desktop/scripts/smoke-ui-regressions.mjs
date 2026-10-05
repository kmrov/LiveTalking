import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './fixture-server.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const executablePath = createRequire(import.meta.url)('electron');
const fixture = await startFixtureServer();
fixture.control.brainMode = 'persona';
const userData = await mkdtemp(path.join(os.tmpdir(), 'livetalking-ui-regressions-'));
const screenshots = path.join(root, 'test-results', 'ui-audit');
await mkdir(screenshots, { recursive: true });
let application;
const speechChildren = [];
try {
  application = await electron.launch({ executablePath, args: [root], env: {
    ...process.env, LIVETALKING_DESKTOP_TEST_FIXTURE: '1',
    LIVETALKING_DESKTOP_TEST_PORT: String(fixture.port), LIVETALKING_DESKTOP_TEST_USER_DATA: userData,
  } });
  const window = await application.firstWindow();
  await window.locator('#setup-results li').first().waitFor({ state: 'attached' });
  await window.evaluate(async () => {
    const { profile } = await window.liveTalkingDesktop.getSetup();
    await window.liveTalkingDesktop.saveProfile(profile);
    await window.liveTalkingDesktop.saveProfile({ ...profile, id: 'sillytavern-smoke', name: 'SillyTavern',
      brain: { ...profile.brain, mode: 'sillytavern' } });
  });
  await window.reload();
  await window.locator('#setup-results li').first().waitFor({ state: 'attached' });
  assert.equal(await window.locator('#profile-picker option').count(), 2,
    'saved profiles must appear in the Studio header');
  await window.locator('#profile-picker').selectOption('sillytavern-smoke');
  await window.waitForFunction(() => document.querySelector('#profile-brain-summary').textContent === 'SillyTavern');
  assert.equal(await window.locator('#brain-mode').inputValue(), 'sillytavern');
  await window.locator('#profile-picker').selectOption('fixture');
  await window.waitForFunction(() => document.querySelector('#profile-brain-summary').textContent === 'Direct LLM');
  assert.equal(await window.locator('#setup-form').isVisible(), false,
    'technical settings should not occupy the main workspace');
  await window.locator('[data-open-settings="voice"]').click();
  assert.equal(await window.locator('#voice-wav').isVisible(), true);
  assert.equal(await window.locator('#python-path').isVisible(), false);
  const originalTranscript = await window.locator('#voice-text').inputValue();
  await window.locator('#voice-text').fill('Unsaved voice draft');
  await window.keyboard.press('Escape');
  await window.waitForFunction(() => !document.querySelector('#profile-settings-dialog').open);
  await window.waitForFunction(original => document.querySelector('#voice-text').value === original, originalTranscript);
  assert.equal(await window.locator('#voice-text').inputValue(), originalTranscript,
    'Escape discards unsaved settings');
  assert.equal(await window.locator('[data-open-settings="voice"]').evaluate(button => button === document.activeElement), true,
    'Escape restores focus to the settings opener');
  await window.locator('[data-open-settings="voice"]').click();
  await window.locator('#settings-tab-voice').focus();
  await window.keyboard.press('ArrowRight');
  assert.equal(await window.locator('#brain-mode').isVisible(), true, 'settings tabs work with the keyboard');
  await window.keyboard.press('End');
  assert.equal(await window.locator('#python-path').isVisible(), true);
  await window.keyboard.press('Escape');
  await window.locator('#open-projection-settings').click();
  await window.locator('#projection-url').fill('http://127.0.0.1:19840/whip');
  await window.locator('#projection-settings-dialog [data-close-dialog]').last().click();
  await window.waitForFunction(() => document.querySelector('#projection-target-label').textContent.includes('19840'));
  assert.match(await window.locator('#projection-target-label').textContent(), /19840/);
  assert.equal(await window.locator('#projection-url').isVisible(), false,
    'connection details stay out of the stage');

  assert.equal(await window.locator('.panel-resizer').count(), 2,
    'both side panels must have resize handles');
  const panelWidths = () => window.evaluate(() => ({
    left: document.querySelector('.left-panel').getBoundingClientRect().width,
    right: document.querySelector('.right-panel').getBoundingClientRect().width,
    stage: document.querySelector('.stage').getBoundingClientRect().width,
  }));
  const initialWidths = await panelWidths();
  const leftHandle = await window.locator('#left-panel-resizer').boundingBox();
  await window.mouse.move(leftHandle.x + leftHandle.width / 2, leftHandle.y + 50);
  await window.mouse.down();
  await window.mouse.move(leftHandle.x + leftHandle.width / 2 + 90, leftHandle.y + 50, { steps: 5 });
  await window.mouse.up();
  await window.waitForFunction(initial => document.querySelector('.left-panel').getBoundingClientRect().width > initial + 80, initialWidths.left, { timeout: 5000 });
  const afterLeftDrag = await panelWidths();
  assert.ok(afterLeftDrag.left > initialWidths.left + 80, 'dragging the left divider widens the profile panel');
  assert.ok(afterLeftDrag.stage < initialWidths.stage - 80, 'the stage gives space to the profile panel');
  const rightHandle = await window.locator('#right-panel-resizer').boundingBox();
  await window.mouse.move(rightHandle.x + rightHandle.width / 2, rightHandle.y + 50);
  await window.mouse.down();
  await window.mouse.move(rightHandle.x + rightHandle.width / 2 - 70, rightHandle.y + 50, { steps: 5 });
  await window.mouse.up();
  await window.waitForFunction(initial => document.querySelector('.right-panel').getBoundingClientRect().width > initial + 60, initialWidths.right, { timeout: 5000 });
  const afterRightDrag = await panelWidths();
  assert.ok(afterRightDrag.right > initialWidths.right + 60, 'dragging the right divider widens the conversation panel');
  await window.locator('#right-panel-resizer').focus();
  await window.keyboard.press('ArrowRight');
  const afterKeyboard = await panelWidths();
  assert.ok(afterKeyboard.right < afterRightDrag.right, 'the right divider can be adjusted with the keyboard');
  await window.reload();
  await window.locator('#setup-results li').first().waitFor({ state: 'attached' });
  const restoredWidths = await panelWidths();
  assert.ok(Math.abs(restoredWidths.left - afterKeyboard.left) < 1, 'the left panel width survives reload');
  assert.ok(Math.abs(restoredWidths.right - afterKeyboard.right) < 1, 'the right panel width survives reload');
  await window.setViewportSize({ width: 960, height: 680 });
  await window.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
  const compactWidths = await panelWidths();
  assert.ok(compactWidths.stage >= 319.5, `resizing the window keeps the stage usable: ${JSON.stringify(compactWidths)}`);
  assert.equal(await window.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
    'saved panel widths must not overflow a compact window');
  await window.setViewportSize({ width: 1440, height: 900 });
  await window.waitForFunction(({ left, right }) => {
    const leftWidth = document.querySelector('.left-panel').getBoundingClientRect().width;
    const rightWidth = document.querySelector('.right-panel').getBoundingClientRect().width;
    return Math.abs(leftWidth - left) < 1 && Math.abs(rightWidth - right) < 1;
  }, restoredWidths);
  const expandedWidths = await panelWidths();
  assert.ok(Math.abs(expandedWidths.left - restoredWidths.left) < 1, 'the preferred left width returns after expanding the window');
  assert.ok(Math.abs(expandedWidths.right - restoredWidths.right) < 1, 'the preferred right width returns after expanding the window');
  await window.locator('[data-open-settings="brain"]').click();
  await window.locator('#brain-mode').selectOption('sillytavern');
  assert.equal(await window.locator('#brain-st-fields').isVisible(), true, 'SillyTavern settings are visible');
  assert.equal(await window.locator('#brain-persona-fields').isVisible(), false, 'Persona settings are hidden in SillyTavern mode');
  assert.equal(await window.locator('#brain-yandex-fields').isVisible(), true, 'Yandex credentials are available to SillyTavern');
  assert.equal(await window.locator('#brain-library').isVisible(), false, 'Persona memory is unavailable in SillyTavern mode');
  assert.equal(await window.locator('#sillytavern-state').isVisible(), true, 'SillyTavern service status is visible');
  assert.equal(await window.locator('#st-character-picker').isVisible(), true, 'SillyTavern character picker is visible');
  assert.match(await window.locator('#brain-conversation-label').textContent(), /SillyTavern/);
  await window.locator('#brain-mode').selectOption('persona');
  await window.locator('#brain-service-mode').selectOption('external');
  await window.locator('#brain-url').fill(`http://127.0.0.1:${fixture.port}`);
  await window.locator('#save-profile').click();
  await window.locator('#profile-settings-dialog').waitFor({ state: 'hidden' });
  await window.locator('#start-profile').click();
  await window.waitForFunction(() => document.querySelector('#runtime-state').textContent === 'Running');
  assert.equal(await window.locator('#profile-picker').isDisabled(), true,
    'running services must prevent a profile switch');
  await window.evaluate(() => { document.querySelector('.left-panel').scrollTop = 0; });
  await window.screenshot({ path: path.join(screenshots, '01-ready.png') });
  await window.locator('[data-open-settings="voice"]').click();
  await window.screenshot({ path: path.join(screenshots, '04-voice-settings.png') });
  await window.locator('#settings-tab-brain').click();
  await window.screenshot({ path: path.join(screenshots, '05-brain-settings.png') });
  await window.locator('#settings-tab-services').click();
  await window.screenshot({ path: path.join(screenshots, '06-service-settings.png') });
  await window.keyboard.press('Escape');
  await window.locator('#open-memory').click();
  await window.locator('#refresh-memories').click();
  await window.waitForFunction(() => document.querySelector('#brain-library-message').textContent.length > 0);
  await window.screenshot({ path: path.join(screenshots, '07-memory.png') });
  await window.keyboard.press('Escape');
  await window.locator('#open-projection-settings').click();
  await window.screenshot({ path: path.join(screenshots, '08-projection-settings.png') });
  await window.keyboard.press('Escape');

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
  await window.waitForFunction(() => document.querySelector('#record-avatar').textContent === 'Finish recording');
  await window.locator('#stop-profile').click();
  await window.waitForTimeout(300);
  assert.equal(await window.locator('#runtime-state').textContent(), 'Running',
    'Stop must leave the profile running while recording');
  assert.equal(await window.locator('#webrtc-state').getAttribute('data-session-id'), 'fixture-session',
    'Stop must retain the active recording session');
  assert.match(await window.locator('#conversation-message').textContent(), /Finish recording before stopping the profile/);
  await window.locator('#connect-avatar').click();
  assert.equal(await window.locator('#webrtc-state').getAttribute('data-session-id'), 'fixture-session',
    'WebRTC must remain connected while recording');
  assert.equal(await window.locator('#record-avatar').textContent(), 'Finish recording');
  await application.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true }); });
  await window.locator('#record-avatar').click();
  await window.waitForFunction(() => document.querySelector('#conversation-message').textContent.includes('Save cancelled'));

  await window.locator('#message-text').fill('Потоковый ответ');
  await window.locator('#send-message').click();
  await window.waitForFunction(() => document.querySelector('#conversation-list [data-status="delta"]')?.textContent.includes('Привет, сынок.'));
  await window.evaluate(() => { document.querySelector('.left-panel').scrollTop = 0; });
  await window.screenshot({ path: path.join(screenshots, '02-persona.png') });
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
  assert.ok(await window.locator('.stage-screen').evaluate(node => node.getBoundingClientRect().height) > 280,
    'moving connection details into a dialog leaves room for the avatar in a compact window');
  await window.locator('#open-profile-settings').click();
  await window.screenshot({ path: path.join(screenshots, '09-compact-settings.png') });
  assert.equal(await window.locator('#save-profile').evaluate(button => {
    const r = button.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight;
  }), true, 'Save stays visible while settings scroll');
  await window.keyboard.press('Escape');
  await window.locator('#refresh-brain-conversations').click();
  await window.waitForTimeout(250);
  assert.match(await window.locator('#conversation-list [data-role="assistant"]').textContent(), /Привет, сынок\./,
    'refresh must retain an unfinished answer');
  assert.match(await window.locator('#brain-turn-state').textContent(), /replying|thinking/,
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
  await window.waitForFunction(() => document.querySelector('#microphone-state').textContent.includes('Speak'));
  await window.locator('#microphone-button').click();
  await window.waitForFunction(() => document.querySelector('#microphone-state').textContent.includes('Transcribing'));
  const conversationBeforeAsrSwitch = await window.locator('#brain-conversation').inputValue();
  await window.locator('#new-brain-conversation').click();
  await window.waitForTimeout(500);
  assert.notEqual(await window.locator('#brain-conversation').inputValue(), conversationBeforeAsrSwitch,
    `ASR switch failed: ${await window.locator('#conversation-message').textContent()}`);
  assert.equal(await window.locator('#microphone-state').textContent(), 'Press to speak',
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
  await window.waitForFunction(() => document.querySelector('#conversation-message').textContent === 'Message received.');
  await window.waitForFunction(() => !document.querySelector('#send-message').disabled);
  assert.equal(await window.locator('#message-text').inputValue(), 'Новый черновик',
    'completed send must retain a newer draft');
  await window.setViewportSize({ width: 1440, height: 900 });
  const wideHandle = await window.locator('#left-panel-resizer').boundingBox();
  await window.mouse.move(wideHandle.x + wideHandle.width / 2, wideHandle.y + 50);
  await window.mouse.down();
  await window.mouse.move(wideHandle.x + wideHandle.width / 2 - 220, wideHandle.y + 50, { steps: 5 });
  await window.mouse.up();
  const dialogHandle = await window.locator('#right-panel-resizer').boundingBox();
  await window.mouse.move(dialogHandle.x + dialogHandle.width / 2, dialogHandle.y + 50);
  await window.mouse.down();
  await window.mouse.move(dialogHandle.x + dialogHandle.width / 2 + 220, dialogHandle.y + 50, { steps: 5 });
  await window.mouse.up();
  const narrowWidths = await panelWidths();
  assert.ok(narrowWidths.left <= initialWidths.left - 50, 'the profile panel can be made narrower');
  assert.ok(narrowWidths.right <= initialWidths.right - 70, 'the conversation panel can be made narrower');
  assert.ok(narrowWidths.stage >= 320, 'the stage remains usable with narrow side panels');
  fixture.finishTurn();
  await application.close();
  application = null;

  const registry = path.join(userData, 'speech-models');
  await mkdir(registry, { recursive: true });
  for (const stage of ['asr', 'tts']) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    speechChildren.push(child);
    const stat = await readFile(`/proc/${child.pid}/stat`, 'utf8');
    const startTime = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    await writeFile(path.join(registry, `${child.pid}.json`), JSON.stringify({ stage, pid: child.pid, startTime }));
  }
  const launchWithSameProfile = () => electron.launch({ executablePath, args: [root], env: {
    ...process.env, LIVETALKING_DESKTOP_TEST_FIXTURE: '1',
    LIVETALKING_DESKTOP_TEST_PORT: String(fixture.port), LIVETALKING_DESKTOP_TEST_USER_DATA: userData,
  } });
  application = await launchWithSameProfile();
  let ownedWindow = await application.firstWindow();
  await ownedWindow.locator('#stop-asr').waitFor({ state: 'visible' });
  await ownedWindow.locator('#stop-tts').waitFor({ state: 'visible' });
  await ownedWindow.locator('#stop-asr').click();
  await ownedWindow.locator('#stop-asr').waitFor({ state: 'hidden' });
  assert.equal(speechChildren[0].signalCode, 'SIGTERM', 'Stop ASR must terminate only ASR');
  assert.equal(speechChildren[1].signalCode, null, 'Stop ASR must leave TTS running');

  await application.evaluate(({ BrowserWindow, dialog }) => { dialog.showMessageBox = async () => ({ response: 2 }); BrowserWindow.getAllWindows()[0].close(); });
  await ownedWindow.waitForTimeout(250);
  assert.equal(await ownedWindow.locator('#stop-tts').isVisible(), true, 'Cancel keeps the Studio window open');
  let closed = application.waitForEvent('close');
  await application.evaluate(({ BrowserWindow, dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); BrowserWindow.getAllWindows()[0].close(); });
  await closed;
  application = null;
  assert.equal(speechChildren[1].signalCode, null, 'Keep running preserves TTS after Studio exits');

  application = await launchWithSameProfile();
  ownedWindow = await application.firstWindow();
  await ownedWindow.locator('#stop-tts').waitFor({ state: 'visible' });
  closed = application.waitForEvent('close');
  await application.evaluate(({ app, dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); app.quit(); });
  await closed;
  application = null;
  assert.equal(speechChildren[1].signalCode, 'SIGTERM', 'Shut down terminates retained TTS');
  console.log('UI regressions: passed');
} finally {
  await application?.close();
  for (const child of speechChildren) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  await fixture.close();
  await rm(userData, { recursive: true, force: true });
}
