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
const previewWav = path.join(userData, 'preview-sample.wav');
const sampleRate = 16000, sampleCount = sampleRate * 10;
const previewBytes = Buffer.alloc(44 + sampleCount * 2);
previewBytes.write('RIFF', 0); previewBytes.writeUInt32LE(previewBytes.length - 8, 4);
previewBytes.write('WAVEfmt ', 8); previewBytes.writeUInt32LE(16, 16);
previewBytes.writeUInt16LE(1, 20); previewBytes.writeUInt16LE(1, 22);
previewBytes.writeUInt32LE(sampleRate, 24); previewBytes.writeUInt32LE(sampleRate * 2, 28);
previewBytes.writeUInt16LE(2, 32); previewBytes.writeUInt16LE(16, 34);
previewBytes.write('data', 36); previewBytes.writeUInt32LE(sampleCount * 2, 40);
for (let index = 0; index < sampleCount; index++)
  previewBytes.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 220 / sampleRate) * 6000), 44 + index * 2);
await writeFile(previewWav, previewBytes);
const screenshots = path.join(root, 'test-results', 'ui-audit');
await mkdir(screenshots, { recursive: true });
let application, activeWindow;
const speechChildren = [];
try {
  application = await electron.launch({ executablePath, args: [root], env: {
    ...process.env, LIVETALKING_DESKTOP_TEST_FIXTURE: '1',
    LIVETALKING_DESKTOP_TEST_PORT: String(fixture.port), LIVETALKING_DESKTOP_TEST_USER_DATA: userData,
  } });
  const window = await application.firstWindow();
  activeWindow = window;
  await window.locator('#setup-results li').first().waitFor({ state: 'attached' });
  await window.evaluate(async () => {
    const { profile } = await window.liveTalkingDesktop.getSetup();
    await window.liveTalkingDesktop.saveProfile(profile);
    await window.liveTalkingDesktop.saveProfile({ ...profile, id: 'sillytavern-smoke', name: 'SillyTavern',
      brain: { ...profile.brain, mode: 'sillytavern' } });
  });
  await window.reload();
  await window.locator('#setup-results li').first().waitFor({ state: 'attached' });
  assert.equal(await window.locator('.stage-tag').count(), 0, 'the avatar heading needs no preview badge');
  assert.equal(await window.locator('#connect-avatar').isHidden(), true,
    'manual preview control stays hidden before the profile starts');
  assert.match(await window.locator('.stage-empty p').textContent(), /Start.*profile/i);
  assert.equal(await window.locator('#profile-picker option').count(), 2,
    'saved profiles must appear in the Studio header');
  await window.locator('#profile-picker').selectOption('sillytavern-smoke');
  await window.waitForFunction(() => document.querySelector('#profile-brain-summary').textContent === 'SillyTavern');
  assert.equal(await window.locator('#brain-mode').inputValue(), 'sillytavern');
  assert.equal(await window.locator('#st-character-picker').isVisible(), true,
    'the saved SillyTavern profile shows its character picker');
  if (!await window.locator('#service-details').evaluate(details => details.open))
    await window.locator('#service-details > summary').click();
  assert.equal(await window.locator('#sillytavern-state').isVisible(), true,
    'SillyTavern runtime status is available inside service details');
  await window.locator('#profile-picker').selectOption('fixture');
  await window.waitForFunction(() => document.querySelector('#profile-brain-summary').textContent === 'Direct LLM');
  await window.screenshot({ path: path.join(screenshots, '00-stopped.png') });
  assert.equal(await window.locator('#setup-form').isVisible(), false,
    'technical settings should not occupy the main workspace');
  await window.locator('[data-open-settings="voice"]').click();
  if (!await window.locator('#voice-sample-details').evaluate(details => details.open))
    await window.locator('#voice-sample-details > summary').click();
  assert.equal(await window.locator('#voice-wav').isVisible(), true);
  assert.equal(await window.locator('#python-path').isVisible(), false);
  const originalTranscript = await window.locator('#voice-text').inputValue();
  const originalVoice = await window.locator('#voice-wav').inputValue();
  await window.locator('#voice-wav').fill('/tmp/studio-custom-voice.wav');
  assert.match(await window.locator('#known-voices option:checked').textContent(), /Custom file.*studio-custom-voice\.wav/,
    'a manually entered WAV is shown as the selected custom file');
  await window.locator('#known-voices').selectOption('');
  assert.equal(await window.locator('#voice-wav').inputValue(), '',
    'Choose a sample clears the selected WAV');
  assert.equal(await window.locator('#voice-text').inputValue(), '',
    'Choose a sample also clears its transcript');
  await application.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, previewWav);
  await window.locator('#choose-voice').click();
  assert.equal(await window.locator('#voice-wav').inputValue(), previewWav);
  await window.locator('#voice-preview-audio').evaluate(audio => { audio.muted = true; });
  await window.locator('#voice-preview').click();
  await window.waitForFunction(() => !document.querySelector('#voice-preview-audio').paused
    && document.querySelector('#voice-preview').textContent === 'Stop sample');
  assert.match(await window.locator('#voice-preview-audio').getAttribute('src'), /^data:audio\/wav;base64,/,
    'Play sample loads the selected WAV through the Electron bridge');
  await window.locator('#voice-text').fill('Unsaved voice draft');
  await window.keyboard.press('Escape');
  await window.waitForFunction(() => !document.querySelector('#profile-settings-dialog').open);
  await window.waitForFunction(original => document.querySelector('#voice-text').value === original, originalTranscript);
  assert.equal(await window.locator('#voice-text').inputValue(), originalTranscript,
    'Escape discards unsaved settings');
  assert.equal(await window.locator('#voice-wav').inputValue(), originalVoice,
    'Escape also restores the selected voice sample');
  assert.equal(await window.locator('#voice-preview-audio').evaluate(audio => audio.paused && !audio.getAttribute('src')), true,
    'closing settings stops sample playback and releases the source');
  assert.equal(await window.locator('[data-open-settings="voice"]').evaluate(button => button === document.activeElement), true,
    'Escape restores focus to the settings opener');
  await window.locator('[data-open-settings="voice"]').click();
  const settingsGeometry = () => window.evaluate(() => ({
    tabs: document.querySelector('#settings-tab-voice').getBoundingClientRect().top,
    save: document.querySelector('#save-profile').getBoundingClientRect().top,
  }));
  const voiceGeometry = await settingsGeometry();
  await window.locator('#settings-tab-voice').focus();
  await window.keyboard.press('ArrowRight');
  assert.equal(await window.locator('#brain-mode').isVisible(), true, 'settings tabs work with the keyboard');
  const brainGeometry = await settingsGeometry();
  await window.keyboard.press('End');
  if (!await window.locator('#services-advanced').evaluate(details => details.open))
    await window.locator('#services-advanced > summary').click();
  assert.equal(await window.locator('#python-path').isVisible(), true);
  const servicesGeometry = await settingsGeometry();
  for (const geometry of [brainGeometry, servicesGeometry]) {
    assert.ok(Math.abs(geometry.tabs - voiceGeometry.tabs) < 2,
      `switching settings tabs must keep the tab row still: ${JSON.stringify({ voiceGeometry, geometry })}`);
    assert.ok(Math.abs(geometry.save - voiceGeometry.save) < 2,
      `switching settings tabs must keep Save still: ${JSON.stringify({ voiceGeometry, geometry })}`);
  }
  console.log('Settings geometry:', JSON.stringify({ voiceGeometry, brainGeometry, servicesGeometry }));
  await window.keyboard.press('Escape');
  const draftBaseline = await window.evaluate(async () => (await window.liveTalkingDesktop.getSetup()).profile);
  await window.locator('[data-open-settings="brain"]').click();
  await window.locator('#brain-mode').selectOption('sillytavern');
  if (!await window.locator('#brain-advanced').evaluate(details => details.open))
    await window.locator('#brain-advanced > summary').click();
  await window.locator('#brain-st-url').fill('broken');
  await window.locator('#brain-mode').selectOption('direct');
  await window.locator('#save-profile').click();
  await window.locator('#profile-settings-dialog').waitFor({ state: 'hidden' });
  assert.equal(await window.evaluate(async () => (await window.liveTalkingDesktop.getSetup()).profile.brain.sillyTavernUrl),
    draftBaseline.brain.sillyTavernUrl, 'an invalid URL in an inactive brain mode cannot block Save or replace its valid value');
  await window.locator('[data-open-settings="voice"]').click();
  await window.locator('#settings-tab-services').click();
  await window.locator('#speech-mode').selectOption('external');
  await window.locator('#asr-url').fill('broken');
  await window.locator('#tts-url').fill('broken');
  await window.locator('#speech-mode').selectOption('local');
  await window.locator('#save-profile').click();
  await window.locator('#profile-settings-dialog').waitFor({ state: 'hidden' });
  const afterInactiveSpeech = await window.evaluate(async () => (await window.liveTalkingDesktop.getSetup()).profile);
  assert.equal(afterInactiveSpeech.speech.asrUrl, draftBaseline.speech.asrUrl);
  assert.equal(afterInactiveSpeech.speech.ttsUrl, draftBaseline.speech.ttsUrl);
  if (draftBaseline.speech.mode !== 'local') {
    await window.locator('[data-open-settings="voice"]').click();
    await window.locator('#settings-tab-services').click();
    await window.locator('#speech-mode').selectOption(draftBaseline.speech.mode);
    await window.locator('#save-profile').click();
    await window.locator('#profile-settings-dialog').waitFor({ state: 'hidden' });
  }
  await window.locator('[data-open-settings="brain"]').click();
  await window.locator('#brain-mode').selectOption('sillytavern');
  if (!await window.locator('#brain-advanced').evaluate(details => details.open))
    await window.locator('#brain-advanced > summary').click();
  await window.locator('#brain-st-url').fill('broken');
  await window.locator('#brain-advanced > summary').click();
  await window.locator('#save-profile').click();
  assert.equal(await window.locator('#profile-settings-dialog').evaluate(dialog => dialog.open), true,
    'an invalid URL in the active mode must keep settings open');
  assert.equal(await window.locator('#brain-advanced').evaluate(details => details.open), true,
    'Save reveals the invalid field inside Advanced');
  assert.equal(await window.locator('#brain-st-url').inputValue(), 'broken');
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
  assert.equal(await window.locator('#projection-url').inputValue(), 'http://127.0.0.1:19840/whip',
    'the Head in Jar address survives a renderer reload');
  assert.match(await window.locator('#projection-target-label').textContent(), /19840/,
    'the saved projection target is shown after reload');
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
  if (!await window.locator('#brain-advanced').evaluate(details => details.open))
    await window.locator('#brain-advanced > summary').click();
  assert.equal(await window.locator('#brain-st-fields').isVisible(), true, 'SillyTavern settings are visible');
  assert.equal(await window.locator('#brain-persona-fields').isVisible(), false, 'Persona settings are hidden in SillyTavern mode');
  assert.equal(await window.locator('#brain-yandex-fields').isVisible(), true, 'Yandex credentials are available to SillyTavern');
  assert.equal(await window.locator('#brain-library').isVisible(), false, 'Persona memory is unavailable in SillyTavern mode');
  assert.match(await window.locator('#brain-conversation-label').textContent(), /SillyTavern/);
  await window.locator('#brain-mode').selectOption('persona');
  await window.locator('#brain-service-mode').selectOption('external');
  await window.locator('#brain-url').fill(`http://127.0.0.1:${fixture.port}`);
  await window.locator('#save-profile').click();
  await window.locator('#profile-settings-dialog').waitFor({ state: 'hidden' });
  await window.evaluate(() => {
    const originalFetch = window.fetch.bind(window);
    window.__holdHuman = false;
    window.__humanPending = false;
    window.fetch = (input, options) => {
      if (window.__holdHuman && new URL(String(input), location.href).pathname === '/human') {
        window.__humanPending = true;
        return new Promise((resolve, reject) => {
          window.__releaseHuman = () => originalFetch(input, options).then(resolve, reject);
        });
      }
      return originalFetch(input, options);
    };
  });
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
  await window.waitForFunction(() => document.querySelector('#brain-library').textContent.includes('Тестовая память'));
  assert.equal(await window.locator('#document-details').evaluate(details => details.open), false,
    'the document form stays folded while reading memory');
  await window.screenshot({ path: path.join(screenshots, '07-memory.png') });
  await window.keyboard.press('Escape');
  await window.locator('#open-projection-settings').click();
  await window.screenshot({ path: path.join(screenshots, '08-projection-settings.png') });
  await window.keyboard.press('Escape');

  await window.waitForFunction(() => document.querySelector('#webrtc-state').dataset.sessionId === 'fixture-session');
  assert.equal(await window.locator('#connect-avatar').isVisible(), true,
    'connected preview retains its disconnect control');
  const initialConversation = await window.locator('#brain-conversation').inputValue();
  await window.evaluate(() => document.querySelector('#new-brain-conversation').click());
  await window.waitForFunction(previous => Boolean(document.querySelector('#brain-conversation').value)
    && document.querySelector('#brain-conversation').value !== previous, initialConversation);
  await window.waitForFunction(() => !document.querySelector('#new-brain-conversation').disabled);
  const beforeDouble = fixture.commands.filter(command => command.path === '/api/v1/conversations').length;
  await window.evaluate(() => {
    document.querySelector('#new-brain-conversation').click();
    document.querySelector('#new-brain-conversation').click();
  });
  await window.waitForTimeout(500);
  assert.equal(fixture.commands.filter(command => command.path === '/api/v1/conversations').length - beforeDouble, 1,
    'double click must create one conversation');

  // Preview connects automatically when the profile reaches Running.
  await window.waitForFunction(() => document.querySelector('#webrtc-state').dataset.sessionId === 'fixture-session');
  assert.equal(await window.locator('#speaking-state').textContent(), 'Ready',
    'a connected avatar with microphone and auto conversation off is ready, not listening');
  await window.screenshot({ path: path.join(screenshots, '02-connected.png') });
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
  assert.equal(await window.locator('#connect-projection').isDisabled(), true,
    'recording blocks the one-action switch to Head in Jar');
  assert.match(await window.locator('#projection-hint').textContent(), /Finish recording/i);
  await window.locator('#open-projection-settings').click();
  assert.equal(await window.locator('#projection-connect-settings').isDisabled(), true,
    'recording also blocks Connect inside connection settings');
  await window.keyboard.press('Escape');
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

  const composerGeometry = () => window.evaluate(() => ({
    input: document.querySelector('#message-text').getBoundingClientRect().top,
    send: document.querySelector('#send-message').getBoundingClientRect().top,
  }));
  const beforeReplyGeometry = await composerGeometry();
  await window.locator('#message-text').fill('Потоковый ответ');
  await window.locator('#send-message').click();
  await window.waitForFunction(() => document.querySelector('#conversation-list [data-status="delta"]')?.textContent.includes('Привет, сынок.'));
  const afterReplyGeometry = await composerGeometry();
  assert.ok(Math.abs(afterReplyGeometry.input - beforeReplyGeometry.input) < 2
    && Math.abs(afterReplyGeometry.send - beforeReplyGeometry.send) < 2,
  `reply status and history must not move the composer: ${JSON.stringify({ beforeReplyGeometry, afterReplyGeometry })}`);
  console.log('Composer geometry:', JSON.stringify({ beforeReplyGeometry, afterReplyGeometry }));
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
  console.log('Compact geometry:', JSON.stringify({ compactWidths: await panelWidths(), compactControls }));
  await window.locator('#open-profile-settings').click();
  await window.screenshot({ path: path.join(screenshots, '09-compact-settings.png') });
  console.log('UI smoke: compact settings captured');
  assert.equal(await window.locator('#save-profile').evaluate(button => {
    const r = button.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight;
  }), true, 'Save stays visible while settings scroll');
  await window.keyboard.press('Escape');
  await window.evaluate(() => document.querySelector('#refresh-brain-conversations').click());
  console.log('UI smoke: refreshing pending conversation');
  await window.waitForTimeout(250);
  assert.match(await window.locator('#conversation-list [data-role="assistant"]').textContent(), /Привет, сынок\./,
    'refresh must retain an unfinished answer');
  assert.match(await window.locator('#brain-turn-state').textContent(), /replying|thinking/,
    'refresh must retain pending state');
  fixture.finishTurn();
  console.log('UI smoke: finishing pending answer');
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
  console.log('UI smoke: microphone capture started');
  await window.waitForFunction(() => document.querySelector('#microphone-state').textContent.includes('Speak'));
  await window.locator('#microphone-button').click();
  await window.waitForFunction(() => document.querySelector('#microphone-state').textContent.includes('Transcribing'));
  const conversationBeforeAsrSwitch = await window.locator('#brain-conversation').inputValue();
  await window.locator('#new-brain-conversation').click();
  await window.waitForFunction(previous => document.querySelector('#brain-conversation').value !== previous
    && !document.querySelector('#new-brain-conversation').disabled, conversationBeforeAsrSwitch);
  assert.notEqual(await window.locator('#brain-conversation').inputValue(), conversationBeforeAsrSwitch,
    `ASR switch failed: ${await window.locator('#conversation-message').textContent()}`);
  assert.equal(await window.locator('#microphone-state').textContent(), 'Press to speak',
    'cancelled ASR must not write an error into the new conversation');
  assert.equal(await window.locator('#webrtc-state').getAttribute('data-session-id'), 'fixture-session');

  await window.evaluate(() => { window.__holdHuman = true; window.__humanPending = false; });
  await window.evaluate(() => { document.querySelector('#conversation-message').textContent = ''; });
  const beforeHeldSend = fixture.commands.filter(command => command.path === '/human').length;
  await window.locator('#message-text').fill('Отправленный текст');
  await window.locator('#send-message').click();
  console.log('UI smoke: draft preservation send started');
  console.log('UI smoke send state:', await window.evaluate(() => ({
    held: window.__holdHuman, pending: window.__humanPending,
    webrtc: document.querySelector('#webrtc-state').dataset.sessionId,
    sendDisabled: document.querySelector('#send-message').disabled,
    message: document.querySelector('#conversation-message').textContent,
    brain: document.querySelector('#brain-turn-state').textContent,
  })));
  await window.waitForFunction(() => window.__humanPending);
  await window.locator('#message-text').fill('Новый черновик');
  await window.evaluate(() => { window.__holdHuman = false; window.__releaseHuman(); });
  await window.waitForFunction(() => !document.querySelector('#send-message').disabled);
  for (let attempt = 0; attempt < 100 && fixture.commands.filter(command => command.path === '/human').length <= beforeHeldSend; attempt++)
    await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(fixture.commands.filter(command => command.path === '/human').length, beforeHeldSend + 1,
    'the delayed send reaches LiveTalking once after release');
  assert.equal(fixture.commands.findLast(command => command.path === '/human').body.text, 'Отправленный текст');
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
  activeWindow = ownedWindow;
  if (!await ownedWindow.locator('#service-details').evaluate(details => details.open))
    await ownedWindow.locator('#service-details > summary').click();
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
  activeWindow = ownedWindow;
  if (!await ownedWindow.locator('#service-details').evaluate(details => details.open))
    await ownedWindow.locator('#service-details > summary').click();
  await ownedWindow.locator('#stop-tts').waitFor({ state: 'visible' });
  closed = application.waitForEvent('close');
  await application.evaluate(({ app, dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); app.quit(); });
  await closed;
  application = null;
  assert.equal(speechChildren[1].signalCode, 'SIGTERM', 'Shut down terminates retained TTS');
  console.log('UI regressions: passed');
} catch (error) {
  console.error('UI regression failure:', error);
  if (activeWindow && !activeWindow.isClosed()) {
    try {
      const state = await Promise.race([
        activeWindow.evaluate(() => ({
          runtime: document.querySelector('#runtime-state')?.textContent,
          webrtc: document.querySelector('#webrtc-state')?.dataset.sessionId,
          conversation: document.querySelector('#conversation-message')?.textContent,
          sendDisabled: document.querySelector('#send-message')?.disabled,
          humanPending: window.__humanPending,
        })),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Renderer diagnostics timed out')), 2000)),
      ]);
      console.error('Renderer state:', state);
    } catch (diagnosticError) { console.error('Renderer diagnostics:', diagnosticError.message); }
  }
  throw error;
} finally {
  if (application) {
    try {
      await Promise.race([application.close(), new Promise((_, reject) => setTimeout(() => reject(new Error('Electron close timed out')), 3000))]);
    } catch (closeError) {
      console.error(closeError.message);
      application.process()?.kill('SIGKILL');
    }
  }
  for (const child of speechChildren) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  await fixture.close();
  await rm(userData, { recursive: true, force: true });
}
