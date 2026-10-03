import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile, readFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './fixture-server.mjs';
import { normalizeProfile } from '../src/profile.mjs';

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
    await window.waitForFunction(() => document.querySelector('#runtime-state').textContent === 'Running');
    await window.locator('#connect-avatar').click();
    await window.waitForFunction(() => document.querySelector('#webrtc-state').dataset.sessionId === 'fixture-session');
    assert.match(await window.locator('#projection-hint').textContent(), /Disconnect.*WebRTC/i);
    assert.equal(await window.locator('#avatar-video').evaluate(video => video.muted), true, 'only the audio element may play incoming audio');
    await window.locator('#conversation-mode').selectOption('echo');
    await window.locator('#message-text').fill('Привет из smoke-теста');
    await window.locator('#send-message').click();
    await window.waitForFunction(() => document.querySelector('#conversation-message').textContent === 'Message received.');
    assert.deepEqual(fixture.commands.find(command => command.path === '/human').body, { sessionid: 'fixture-session', text: 'Привет из smoke-теста', type: 'echo', interrupt: true });
    await window.locator('#interrupt-avatar').click();
    await window.waitForFunction(() => document.querySelector('#conversation-message').textContent === 'Speech interrupted.');
    assert.equal(fixture.commands.some(command => command.path === '/interrupt_talk'), true);
    assert.equal(await window.locator('#handsfree-button').count(), 1);
    await window.evaluate(() => {
      window.__autoMicStops = 0;
      navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop: () => window.__autoMicStops++ }] });
      window.AudioContext = class {
        constructor() { this.sampleRate = 16000; this.destination = {}; this.audioWorklet = { addModule: async () => {} }; }
        resume() { return Promise.resolve(); }
        close() { return Promise.resolve(); }
        createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      };
      window.AudioWorkletNode = class {
        constructor() { this.port = {}; window.__autoVoiceWorklet = this; }
        connect() {}
        disconnect() {}
      };
      window.WebSocket = class {
        constructor() { queueMicrotask(() => this.onopen?.()); }
        send(payload) {
          if (typeof payload === 'string' && JSON.parse(payload).is_speaking === false) {
            queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ text: 'Вопрос без кнопок', is_final: true }) }));
          }
        }
        close() {}
      };
    });
    await window.locator('#handsfree-button').click();
    await window.waitForFunction(() => document.querySelector('#handsfree-state').dataset.state === 'listening');
    assert.equal(await window.locator('#handsfree-level').isVisible(), true);
    assert.match(await window.locator('#handsfree-level').textContent(), /waiting for signal/i);
    await window.evaluate(() => {
      const feed = (amplitude, count) => {
        for (let i = 0; i < count; i++) window.__autoVoiceWorklet.port.onmessage({ data: new Float32Array(160).fill(amplitude) });
      };
      feed(0.012, 45);
    });
    await window.waitForFunction(() => /Input: [1-9]/.test(document.querySelector('#handsfree-level').textContent));
    await window.evaluate(() => {
      for (let i = 0; i < 91; i++) window.__autoVoiceWorklet.port.onmessage({ data: new Float32Array(160) });
    });
    await window.waitForFunction(() => document.querySelector('#conversation-message').textContent === 'Message received.');
    assert.equal(fixture.commands.findLast(command => command.path === '/human').body.text, 'Вопрос без кнопок');
    assert.equal(fixture.commands.findLast(command => command.path === '/human').body.type, 'chat');
    await window.locator('#handsfree-button').click();
    await window.waitForFunction(() => document.querySelector('#handsfree-state').dataset.state === 'idle');
    assert.equal(await window.locator('#handsfree-level').isVisible(), false);
    assert.equal(await window.evaluate(() => window.__autoMicStops), 1);
    await window.locator('#handsfree-button').click();
    await window.waitForFunction(() => document.querySelector('#handsfree-state').dataset.state === 'listening');
    await window.locator('#connect-avatar').click();
    await window.waitForFunction(() => document.querySelector('#handsfree-state').dataset.state === 'idle');
    assert.equal(await window.evaluate(() => window.__autoMicStops), 2);
    await window.locator('#projection-url').fill('http://127.0.0.1:19840/whip');
    await window.locator('#projection-advanced > summary').click();
    await window.locator('#projection-token').fill('fixture-secret');
    fixture.control.delayOfferMs = 300;
    await window.locator('#connect-avatar').click();
    await window.waitForFunction(() => document.querySelector('#connect-projection').disabled);
    await window.locator('#connect-projection').evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await window.waitForFunction(() => document.querySelector('#webrtc-state').dataset.sessionId === 'fixture-session');
    assert.equal(fixture.commands.filter(command => command.path === '/api/whip/connect').length, 0);
    await window.locator('#connect-avatar').click();
    fixture.control.delayOfferMs = 0;
    fixture.control.delayWhipMs = 300;
    await window.locator('#connect-projection').click();
    await window.waitForFunction(() => document.querySelector('#connect-projection').disabled);
    await window.locator('#connect-projection').evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await window.waitForFunction(() => Boolean(document.querySelector('#projection-state').dataset.sessionId));
    assert.equal(fixture.commands.filter(command => command.path === '/api/whip/connect').length, 1);
    fixture.control.delayWhipMs = 0;
    const projectionId = await window.locator('#projection-state').getAttribute('data-session-id');
    assert.match(projectionId, /^[0-9a-f-]{36}$/);
    await window.locator('#message-text').fill('Привет проекции');
    await window.locator('#send-message').click();
    await window.waitForFunction(() => document.querySelector('#conversation-message').textContent === 'Message received.');
    assert.equal(fixture.commands.findLast(command => command.path === '/human').body.sessionid, projectionId);
    assert.equal(fixture.commands.find(command => command.path === '/api/whip/connect').body.token, 'fixture-secret');
    await window.locator('#interrupt-avatar').click();
    await window.waitForFunction(() => document.querySelector('#conversation-message').textContent === 'Speech interrupted.');
    assert.equal(fixture.commands.findLast(command => command.path === '/interrupt_talk').body.sessionid, projectionId);
    fixture.control.whip = null;
    await window.waitForFunction(() => document.querySelector('#projection-state').dataset.sessionId === '', null, { timeout: 7000 });
    assert.equal(await window.locator('#send-message').isDisabled(), true);
    await window.locator('#projection-token').fill('fixture-secret-retry');
    await window.locator('#connect-projection').click();
    await window.waitForFunction(() => Boolean(document.querySelector('#projection-state').dataset.sessionId));
    await window.locator('#connect-projection').click();
    await window.waitForFunction(() => document.querySelector('#projection-state').dataset.sessionId === '');
    assert.equal(await window.locator('#send-message').isDisabled(), true);
    await window.screenshot({ path: path.join(artifactDirectory, 'smoke-studio.png') });
    await window.locator('#stop-profile').click();
    await window.waitForFunction(() => document.querySelector('#runtime-state').textContent === 'Not configured');
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
  await runMissingRootCase();
  await runAvatarCase();
  await runBatyaCase();
  assert.equal(logs.some(line => line.includes('Renderer error')), false);
} finally {
  await fixture.close();
  await writeFile(path.join(artifactDirectory, 'smoke.log'), logs.join('\n'));
}

async function runMissingRootCase() {
 const userData=await mkdtemp(path.join(os.tmpdir(),'livetalking-missing-root-'));
 const profile=normalizeProfile({id:'fixture',autoStart:false,liveTalking:{root:path.join(userData,'removed'),python:'/usr/bin/python3',port:fixture.port}});
 await writeFile(path.join(userData,'profiles.json'),JSON.stringify({schemaVersion:1,profiles:[profile],lastSuccessfulId:null}));
 const application=await electron.launch({executablePath,args:[root],env:{...process.env,LIVETALKING_DESKTOP_TEST_FIXTURE:'1',LIVETALKING_DESKTOP_TEST_PORT:String(fixture.port),LIVETALKING_DESKTOP_TEST_USER_DATA:userData},timeout:30000});
 try {
  const window=await application.firstWindow();
  window.on('pageerror',error=>logs.push(`Renderer error: ${error.stack}`));
  await window.waitForFunction(()=>document.querySelector('#avatar-summary-message').textContent.includes('Could not open library'));
  assert.equal(await window.locator('#choose-root').isEnabled(),true);
  console.log('Unavailable saved checkout → editable setup and library error: passed');
 } finally {await application.close();await rm(userData,{recursive:true,force:true});}
}

async function runAvatarCase() {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'livetalking-avatar-smoke-'));
  const avatarRoot = path.join(userData, 'checkout');
  const source = path.join(userData, 'Фото.png');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGNMmXaCARtgwio6aCUAYr8B0jIwXssAAAAASUVORK5CYII=', 'base64');
  await mkdir(avatarRoot);
  await symlink(avatarRoot,path.join(userData,'checkout-link'));
  await writeFile(source, png);
  const control = mode => writeFile(path.join(avatarRoot, 'fixture-control.json'), JSON.stringify({ mode }));
  await control('delay');
  const previousRoot=fixture.control.avatarRoot;
  fixture.control.avatarRoot=avatarRoot;
  const profile=normalizeProfile({id:'fixture',autoStart:false,liveTalking:{root:path.join(userData,'checkout-link')+'/',python:'/usr/bin/python3',port:fixture.port},
    speech:{mode:'external',asrUrl:`http://127.0.0.1:${fixture.port}`,ttsUrl:`http://127.0.0.1:${fixture.port}`}});
  await writeFile(path.join(userData,'profiles.json'),JSON.stringify({schemaVersion:1,profiles:[profile],lastSuccessfulId:null}));
  let application, window;
  const launch = async () => {
    application = await electron.launch({ executablePath, args: [root], env: { ...process.env,
      LIVETALKING_DESKTOP_TEST_FIXTURE: '1', LIVETALKING_DESKTOP_TEST_PORT: String(fixture.port),
      LIVETALKING_DESKTOP_TEST_USER_DATA: userData, LIVETALKING_DESKTOP_TEST_AVATAR_ROOT: avatarRoot }, timeout: 30000 });
    window = await application.firstWindow();
    window.on('pageerror', error => logs.push(`Renderer error: ${error.stack}`));
    await window.locator('#setup-results li').first().waitFor({ state: 'attached' });
    await application.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      dialog.showSaveDialog = async () => ({ canceled: true });
    }, source);
  };
  const state = async expected => window.waitForFunction(value => document.querySelector('#avatar-job-state').dataset.avatarStage === value, expected);
  const chooseSource = async name => {
    await window.locator('#open-avatar-create').click();
    await window.locator('#choose-avatar-source').click();
    await window.locator('#new-avatar-name').fill(name);
  };
  try {
    await launch();
    await window.locator('#setup-details').evaluate(details => { details.open = true; });
    await window.locator('#voice-wav').fill('');
    await window.locator('#voice-text').fill('');
    await chooseSource('Мой аватар');
    await window.locator('#check-avatar-create').click();
    await window.locator('#avatar-create-checks li').first().waitFor();
    assert.equal(await window.locator('#avatar-create-checks [data-state="ready"]').count(), 1);
    await window.locator('#submit-avatar-create').click();
    await state('running');
    await window.waitForFunction(() => document.querySelector('#avatar-job-progress').value >= 25);
    assert.match(await window.locator('#avatar-job-message').textContent(), /Downloading avatar model/);
    await window.screenshot({ path: path.join(artifactDirectory, 'smoke-avatar-create.png') });
    await window.keyboard.press('Escape');
    assert.equal(await window.locator('#avatar-create-dialog').isVisible(), false);
    await window.waitForFunction(() => document.activeElement.id === 'open-avatar-job');
    assert.equal(await window.locator('#start-profile').isDisabled(), true);
    await window.locator('#open-avatar-job').click();
    assert.equal(await window.locator('#avatar-job-progress').evaluate(progress => progress.value), 25);
    await rm(source);
    await control('success');
    await state('completed');
    await window.locator('#select-created-avatar').click();
    const saved = JSON.parse(await readFile(path.join(userData, 'profiles.json'), 'utf8')).profiles[0];
    const createdId = saved.liveTalking.avatarId;
    assert.match(createdId, /^studio_[0-9a-f]{32}$/);
    assert.equal(saved.liveTalking.model, 'musetalk');
    await application.close();
    await launch();
    await window.locator('#open-avatar-library').click();
    let card = window.locator(`[data-avatar-id="${createdId}"]`);
    await card.waitFor();
    assert.equal(await card.locator('[data-avatar-name]').textContent(), 'Мой аватар');
    assert.equal(await card.locator('img').evaluate(img => img.naturalWidth > 0), true);
    const imageBox = await card.locator('img').boundingBox();
    const nameBox = await card.locator('[data-avatar-name]').boundingBox();
    assert.ok(imageBox.y + imageBox.height <= nameBox.y, 'thumbnail must not cover the avatar name');
    const restored = JSON.parse(await readFile(path.join(userData, 'profiles.json'), 'utf8')).profiles[0];
    assert.equal(restored.liveTalking.avatarId, createdId);
    assert.equal(restored.liveTalking.model, 'musetalk');
    await card.getByText('Rename', { exact: true }).click();
    await card.getByRole('textbox').fill('Портрет');
    await card.getByRole('button', { name: 'Save name', exact: true }).click();
    await window.locator('#avatar-search').fill('ПОРТР');
    await window.waitForFunction(() => document.querySelector('[data-avatar-name]')?.textContent === 'Портрет');
    assert.equal(await window.locator('[data-avatar-id]').count(), 1);
    await window.screenshot({ path: path.join(artifactDirectory, 'smoke-avatar-library.png') });
    await window.keyboard.press('Escape');
    await window.waitForFunction(() => document.activeElement.id === 'open-avatar-library');

    await writeFile(source, png); await control('fail');
    await chooseSource('Повтор аватара');
    await window.locator('#submit-avatar-create').click(); await state('failed');
    assert.match(await window.locator('#avatar-job-error').textContent(), /fixture/i);
    await rm(source); await control('success');
    await window.locator('#retry-avatar-job').click(); await state('completed');
    await window.locator('#select-created-avatar').click();

    await writeFile(path.join(avatarRoot, 'fixture-control.json'), JSON.stringify({ mode: 'success', modelsMode: 'delay' }));
    fixture.control.avatarModel = 'musetalk';
    await window.locator('#start-profile').click();
    await window.waitForFunction(() => document.querySelector('#model-download-progress').value === 25);
    assert.equal(await window.locator('#model-download-panel').isVisible(), true);
    assert.equal(await window.locator('#startup-progress').isVisible(), true);
    assert.equal(await window.locator('#runtime-state').getAttribute('data-phase'), 'checking');
    assert.notEqual(await window.locator('.startup-spinner').evaluate(node => getComputedStyle(node).animationName), 'none');
    assert.equal(await window.locator('#model-download-panel').evaluate(panel => { const box = panel.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; }), true, 'download progress must be visible without scrolling settings');
    assert.match(await window.locator('#model-download-state').textContent(), /Avatar model/);
    await window.screenshot({ path: path.join(artifactDirectory, 'smoke-model-download.png') });
    await window.locator('#stop-profile').click();
    await window.waitForFunction(() => document.querySelector('#runtime-state').textContent === 'Not configured');
    await assert.rejects(readFile(path.join(avatarRoot, '.fixture-models-ready')), { code: 'ENOENT' });
    await writeFile(path.join(avatarRoot, 'fixture-control.json'), JSON.stringify({ mode: 'success', modelsMode: 'fail' }));
    await window.locator('#start-profile').click();
    await window.waitForFunction(() => document.querySelector('#runtime-state').textContent === 'Error');
    assert.match(await window.locator('#runtime-log').textContent(), /Fixture model download failed/);
    await writeFile(path.join(avatarRoot, 'fixture-control.json'), JSON.stringify({ mode: 'success', modelsMode: 'success' }));
    await window.locator('#start-profile').click();
    await window.waitForFunction(() => document.querySelector('#runtime-state').textContent === 'Running');
    assert.equal(await readFile(path.join(avatarRoot, '.fixture-models-ready'), 'utf8'), 'verified');
    await window.locator('#stop-profile').click();
    await window.waitForFunction(() => document.querySelector('#runtime-state').textContent === 'Not configured');
    console.log('Model download progress → Stop cancellation → failure → repeat → startup: passed');

    const existing = path.join(avatarRoot, 'data/avatars/legacy');
    await mkdir(path.join(existing, 'full_imgs'), { recursive: true });
    await mkdir(path.join(existing, 'face_imgs'));
    await writeFile(path.join(existing, 'full_imgs/00000000.png'), png);
    await writeFile(path.join(existing, 'face_imgs/00000000.png'), png);
    await writeFile(path.join(existing, 'coords.pkl'), 'fixture');
    await window.locator('#setup-details').evaluate(details => { details.open = true; });
    await window.locator('#brain-mode').selectOption('batya');
    await window.locator('#brain-service-mode').selectOption('external');
    await window.locator('#brain-url').fill(`http://127.0.0.1:${fixture.port}`);
    fixture.control.brainMode = 'batya';
    fixture.control.avatarModel = 'musetalk';
    await window.locator('#start-profile').click();
    await window.waitForFunction(() => document.querySelector('#runtime-state').textContent === 'Running');
    await window.locator('#connect-avatar').click();
    await window.waitForFunction(() => document.querySelector('#brain-turn-state').dataset.stream === 'connected');
    await window.locator('#message-text').fill('Ответ после смены аватара'); await window.locator('#send-message').click();
    await window.waitForFunction(() => document.querySelector('#conversation-list [data-status="delta"]'));
    await window.locator('#record-avatar').click();
    await window.waitForFunction(() => document.querySelector('#record-avatar').textContent === 'Finish recording');
    await window.locator('#open-avatar-library').click();
    await window.locator('#avatar-search').fill('');
    card = window.locator('[data-avatar-id="legacy"]'); await card.waitFor();
    assert.equal(await card.getByRole('button', { name: 'Stop and select', exact: true }).isDisabled(), true);
    await window.keyboard.press('Escape');
    await window.locator('#record-avatar').click();
    await window.waitForFunction(() => document.querySelector('#conversation-message').textContent.includes('Save cancelled'));
    await window.locator('#open-avatar-library').click();
    await card.getByRole('button', { name: 'Stop and select', exact: true }).click();
    await window.waitForFunction(() => document.querySelector('#runtime-state').textContent === 'Not configured');
    const before = await window.locator('#conversation-list').textContent();
    fixture.finishTurn();
    await window.waitForFunction(() => document.querySelector('#start-profile').disabled === false);
    assert.equal(await window.locator('#conversation-list').textContent(), before);
    const selected = JSON.parse(await readFile(path.join(userData, 'profiles.json'), 'utf8')).profiles[0];
    assert.equal(selected.liveTalking.avatarId, 'legacy'); assert.equal(selected.liveTalking.model, 'wav2lip');
    fixture.control.avatarModel = 'wav2lip';
    await window.locator('#start-profile').click();
    await window.waitForFunction(() => document.querySelector('#conversation-list [data-role="assistant"]')?.textContent.includes('Это тестовый ответ.'));
    await window.locator('#stop-profile').click();
    await window.waitForFunction(() => document.querySelector('#runtime-state').textContent === 'Not configured');

    await writeFile(source, png); await control('delay');
    await chooseSource('Отмена'); await window.locator('#submit-avatar-create').click(); await state('running');
    await window.locator('#cancel-avatar-job').click(); await state('cancelled');
    assert.equal(await window.locator('#select-created-avatar').isHidden(), true);
    await window.keyboard.press('Escape');
    await chooseSource('Закрытие'); await window.locator('#submit-avatar-create').click(); await state('running');
    await window.waitForFunction(() => document.querySelector('#avatar-job-progress').value >= 25);
    const closingJob = await window.evaluate(async () => {
      const setup = await window.liveTalkingDesktop.getSetup();
      return setup.avatars.job;
    });
    await application.close();
    const workerLog = await readFile(closingJob.logPath, 'utf8');
    const workerPid = Number(workerLog.match(/fixture pid=(\d+)/)[1]);
    assert.throws(() => process.kill(workerPid, 0), { code: 'ESRCH' }, 'closing Studio must leave no owned worker');
    await launch();
    await window.locator('#open-avatar-job').click(); await state('cancelled');
    await window.keyboard.press('Escape');
    await chooseSource('Аварийное закрытие'); await window.locator('#submit-avatar-create').click(); await state('running');
    await window.waitForFunction(() => document.querySelector('#avatar-job-progress').value >= 25);
    const crashJob = await window.evaluate(async () => (await window.liveTalkingDesktop.getSetup()).avatars.job);
    const crashLog = await readFile(crashJob.logPath, 'utf8');
    const crashPid = Number(crashLog.match(/fixture pid=(\d+)/)[1]);
    const electronChild = application.process();
    const exited = new Promise(resolve => electronChild.once('exit', resolve));
    electronChild.kill('SIGKILL');
    process.kill(-crashPid, 'SIGTERM');
    await exited;
    application = null;
    await launch();
    await window.locator('#open-avatar-job').click(); await state('interrupted');
    assert.equal(await window.locator('#retry-avatar-job').isEnabled(), true);
    console.log('Avatar create → progress/reopen → source independence → restart → rename/search → fail/retry → recording/selection/Batya history → cancel/close/crash recovery: passed');
  } catch (error) {
    if (window && !window.isClosed()) {
      await window.screenshot({ path: path.join(artifactDirectory, 'smoke-avatar-failure.png') });
      logs.push(await window.locator('#setup-message').textContent());
      logs.push(await window.locator('#avatar-library-message').textContent());
    }
    throw error;
  } finally { await application?.close(); await rm(userData, { recursive: true, force: true }); fixture.control.brainMode = 'direct';fixture.control.avatarRoot=previousRoot;fixture.control.avatarModel='wav2lip'; }
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
    await window.waitForFunction(() => document.querySelector('#runtime-state').textContent === 'Running');
    await window.locator('#new-brain-conversation').click();
    await window.waitForFunction(() => Boolean(document.querySelector('#brain-conversation').value));
    let id = await window.locator('#brain-conversation').inputValue();
    await window.locator('#connect-avatar').click();
    await window.waitForFunction(() => document.querySelector('#brain-turn-state').dataset.stream === 'connected');
    await window.locator('#message-text').fill('Привет из теста Бати');
    await window.locator('#send-message').click();
    await window.waitForFunction(() => document.querySelector('#conversation-list [data-role="assistant"]')?.textContent.includes('Привет, сынок.'));
    assert.equal(await window.locator('#conversation-list [data-role="assistant"]').getAttribute('data-status'), 'delta');
    await window.locator('#interrupt-avatar').click();
    await window.waitForFunction(() => document.querySelector('#brain-turn-state').textContent.includes('saving'));
    assert.match(await window.locator('#brain-turn-state').textContent(), /saving/);
    await window.locator('#connect-avatar').click();
    await window.locator('#connect-avatar').click();
    await window.waitForFunction(() => document.querySelector('#brain-turn-state').dataset.stream === 'connected' && document.querySelector('#conversation-list [data-role="assistant"]')?.dataset.status === 'delta');
    assert.match(await window.locator('#conversation-list [data-role="assistant"]').textContent(), /Привет, сынок/);
    assert.match(await window.locator('#brain-turn-state').textContent(), /replying|saving/);
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
    await window.locator('#connect-avatar').click();
    await window.locator('#projection-url').fill('http://127.0.0.1:19840/whip');
    await window.locator('#projection-advanced > summary').click();
    await window.locator('#projection-token').fill('batya-fixture-secret');
    await window.locator('#connect-projection').click();
    await window.waitForFunction(() => Boolean(document.querySelector('#projection-state').dataset.sessionId));
    const batyaProjectionId = await window.locator('#projection-state').getAttribute('data-session-id');
    assert.equal(fixture.commands.findLast(c => c.path === '/api/whip/connect').body.batya_conversation_id, id);
    await window.locator('#message-text').fill('Батя на проекции'); await window.locator('#send-message').click();
    await window.waitForFunction(() => [...document.querySelectorAll('#conversation-list [data-role="assistant"]')].at(-1)?.dataset.status === 'delta');
    assert.equal(fixture.commands.findLast(c => c.path === '/human').body.sessionid, batyaProjectionId);
    fixture.finishTurn();
    await window.waitForFunction(() => [...document.querySelectorAll('#conversation-list [data-role="assistant"]')].at(-1)?.dataset.status === 'done');
    const previousId = id;
    const disconnects = fixture.commands.filter(c => c.path === '/api/whip/disconnect').length;
    await window.locator('#new-brain-conversation').click();
    await window.waitForFunction(previous => document.querySelector('#brain-conversation').value !== previous, id);
    id = await window.locator('#brain-conversation').inputValue();
    assert.equal(await window.locator('#projection-state').getAttribute('data-session-id'), batyaProjectionId);
    assert.equal(fixture.commands.filter(c => c.path === '/api/whip/disconnect').length, disconnects);
    await window.locator('#message-text').fill('Новая тема на проекции'); await window.locator('#send-message').click();
    await window.waitForFunction(() => document.querySelector('#conversation-list [data-role="assistant"]')?.dataset.status === 'delta');
    assert.equal(fixture.commands.findLast(c => c.path === '/human').body.sessionid, batyaProjectionId);
    assert.equal(fixture.control.currentConversation, id);
    fixture.finishTurn();
    await window.waitForFunction(() => document.querySelector('#conversation-list [data-role="assistant"]')?.dataset.status === 'done');
    await window.locator('#brain-conversation').selectOption(previousId);
    await window.waitForFunction(() => document.querySelectorAll('#conversation-list [data-role="assistant"]').length === 3);
    assert.equal(fixture.control.currentConversation, previousId);
    assert.equal(await window.locator('#projection-state').getAttribute('data-session-id'), batyaProjectionId);
    await window.locator('#brain-conversation').selectOption(id);
    await window.waitForFunction(() => document.querySelectorAll('#conversation-list [data-role="assistant"]').length === 1);
    assert.equal(fixture.control.currentConversation, id);
    assert.equal(await window.locator('#projection-state').getAttribute('data-session-id'), batyaProjectionId);
    await window.locator('#connect-projection').click();
    await window.screenshot({ path: path.join(artifactDirectory, 'smoke-batya.png') });
    await application.close(); application = await launch();
    const reopened = await application.firstWindow();
    await reopened.locator('#setup-results li').first().waitFor({ state: 'attached' });
    await reopened.locator('#start-profile').click();
    await reopened.waitForFunction(() => document.querySelectorAll('#conversation-list [data-role="assistant"]').length === 1);
    assert.equal(await reopened.locator('#brain-conversation').inputValue(), id);
    await reopened.locator('#stop-profile').click();
    await reopened.waitForFunction(() => document.querySelector('#runtime-state').textContent === 'Not configured');
    fixture.control.brainMode = 'direct';
    await reopened.locator('#setup-details').evaluate(details => { details.open = true; });
    await reopened.locator('#brain-mode').selectOption('direct');
    await reopened.locator('#start-profile').click();
    await reopened.waitForFunction(() => document.querySelector('#runtime-state').textContent === 'Running');
    assert.equal(await reopened.locator('#brain-conversations').isHidden(), true);
    console.log('Batya streaming → interrupt → reconnect/history → error/retry → restart → direct mode: passed');
  } finally { await application?.close(); await rm(userData, { recursive: true, force: true }); fixture.control.brainMode = 'direct'; }
}
