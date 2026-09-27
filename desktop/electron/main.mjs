import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isAllowedStudioNavigation, isTrustedStudioSender, mayUseMicrophone } from './ipc-policy.mjs';
import { discoverLiveTalkingRoot } from './discover-root.mjs';
import { findVoiceReferences } from './discover-voice.mjs';
import { createProfileStore } from './profile-store.mjs';
import { inspectPrerequisites } from './prerequisites.mjs';
import { normalizeProfile } from '../src/profile.mjs';
import { createSupervisor } from './supervisor.mjs';
import { initialServiceState, transitionServiceState } from '../src/service-state.mjs';

const studioFile = fileURLToPath(new URL('../dist/studio.html', import.meta.url));
const studioUrl = pathToFileURL(studioFile).href;
const preloadFile = fileURLToPath(new URL('./preload.cjs', import.meta.url));
const fixtureMode = process.env.LIVETALKING_DESKTOP_TEST_FIXTURE === '1';
const fixturePort = Number(process.env.LIVETALKING_DESKTOP_TEST_PORT);
if (fixtureMode && process.env.LIVETALKING_DESKTOP_TEST_USER_DATA) app.setPath('userData', process.env.LIVETALKING_DESKTOP_TEST_USER_DATA);

let studioWindow;
let profileStore;
let supervisor;
let serviceState = initialServiceState();
let startJob;
let runGeneration = 0;
let autoStarted = false;
let quitAfterStop = false;

function runtimeSnapshot() { return { service: serviceState, supervisor: supervisor?.snapshot() ?? null }; }
function publishSnapshot() {
  if (studioWindow && !studioWindow.isDestroyed()) studioWindow.webContents.send('desktop:snapshot', runtimeSnapshot());
}
const setupChecks = profile => fixtureMode
  ? Promise.resolve([{ id: 'fixture', state: 'ready', detail: 'Smoke fixture ready', action: '' }])
  : inspectPrerequisites(profile);

async function startProfile(id) {
  if (startJob) return startJob;
  const profile = profileStore.get(id);
  if (!profile) throw new Error(`Профиль ${id} не найден`);
  if (serviceState.phase === 'ready' && serviceState.profileId === id) return runtimeSnapshot();
  if (['ready', 'starting', 'checking'].includes(serviceState.phase) && serviceState.profileId !== id) throw new Error('Остановите текущий профиль перед переключением.');
  const token = ++runGeneration;
  serviceState = transitionServiceState(serviceState, { type: 'CHECK', profileId: id });
  publishSnapshot();
  startJob = (async () => {
    try {
      const checks = await setupChecks(profile);
      if (token !== runGeneration) return runtimeSnapshot();
      const blockers = checks.filter(result => result.state !== 'ready');
      if (blockers.length) throw new Error(blockers.map(result => result.detail).join('; '));
      if (supervisor.snapshot().state === 'failed') await supervisor.stop();
      serviceState = transitionServiceState(serviceState, { type: 'START', profileId: id });
      publishSnapshot();
      const snapshot = await supervisor.start(profile);
      if (token !== runGeneration) return runtimeSnapshot();
      if (snapshot.state !== 'ready') throw new Error(snapshot.logExcerpt || 'LiveTalking не запустился');
      serviceState = transitionServiceState(serviceState, { type: 'READY', profileId: id });
      profileStore.setLastSuccessfulId(id);
      publishSnapshot();
      return runtimeSnapshot();
    } catch (error) {
      if (token === runGeneration) {
        serviceState = transitionServiceState(serviceState, { type: 'FAIL', detail: error.message });
        publishSnapshot();
      }
      throw error;
    } finally { startJob = null; }
  })();
  return startJob;
}

async function stopProfile() {
  ++runGeneration;
  await supervisor.stop();
  serviceState = transitionServiceState(serviceState, { type: 'STOP' });
  publishSnapshot();
  return runtimeSnapshot();
}

function trusted(handler) {
  return (event, ...args) => {
    if (!isTrustedStudioSender(event, studioWindow, studioUrl)) throw new Error('Untrusted Studio request');
    return handler(...args);
  };
}

function initialProfile() {
  const saved = profileStore.get(profileStore.lastSuccessfulId()) ?? profileStore.list()[0];
  if (saved) return saved;
  if (fixtureMode) return normalizeProfile({
    id: 'fixture', liveTalking: { root: path.dirname(app.getAppPath()), python: '/usr/bin/python3', port: fixturePort },
    speech: { mode: 'external', referenceWav: '/tmp/fixture.wav', referenceText: 'Привет', asrUrl: `http://127.0.0.1:${fixturePort}`, ttsUrl: `http://127.0.0.1:${fixturePort}` },
    autoStart: false,
  });
  const root = discoverLiveTalkingRoot({
    appPath: app.getAppPath(),
    executablePath: process.execPath,
    appImagePath: process.env.APPIMAGE,
  }) ?? '';
  return normalizeProfile({
    liveTalking: { root },
    speech: {
      asrVllm: root ? path.join(path.dirname(root), '.venv/bin/vllm') : '',
      ttsVllm: root ? path.join(path.dirname(root), '.venv-omni/bin/vllm') : '',
    },
  });
}

function registerSetupIpc() {
  ipcMain.handle('desktop:get-setup', trusted(() => {
    const profile = initialProfile();
    const voiceReferences = findVoiceReferences(profile.liveTalking.root);
    if (!profile.speech.referenceWav && voiceReferences.length) {
      profile.speech.referenceWav = voiceReferences[0].wav;
      profile.speech.referenceText = voiceReferences[0].text;
    }
    return { profile, voiceReferences, recoveryError: profileStore.recoveryError(), testFixture: fixtureMode };
  }));
  ipcMain.handle('desktop:check-setup', trusted(async input => setupChecks(normalizeProfile(input))));
  ipcMain.handle('desktop:save-profile', trusted(input => profileStore.save(normalizeProfile(input))));
  ipcMain.handle('desktop:choose-root', trusted(async () => {
    const result = await dialog.showOpenDialog(studioWindow, { title: 'Выбрать LiveTalking', properties: ['openDirectory'] });
    if (result.canceled) return null;
    const root = result.filePaths[0];
    return { root, voiceReferences: findVoiceReferences(root) };
  }));
  ipcMain.handle('desktop:choose-voice-wav', trusted(async () => {
    const result = await dialog.showOpenDialog(studioWindow, { title: 'Выбрать WAV-образец голоса', properties: ['openFile'], filters: [{ name: 'WAV', extensions: ['wav'] }] });
    return result.canceled ? null : result.filePaths[0];
  }));
  ipcMain.handle('desktop:start-profile', trusted(startProfile));
  ipcMain.handle('desktop:stop-profile', trusted(stopProfile));
  ipcMain.handle('desktop:get-snapshot', trusted(runtimeSnapshot));
  ipcMain.handle('desktop:save-recording', trusted(async sessionId => {
    if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(sessionId)) throw new Error('Invalid recording session');
    const port = supervisor.snapshot().port;
    if (!port || serviceState.phase !== 'ready') throw new Error('LiveTalking не запущен');
    const chosen = await dialog.showSaveDialog(studioWindow, { title: 'Сохранить запись', defaultPath: `livetalking-${sessionId}.mp4`, filters: [{ name: 'MP4', extensions: ['mp4'] }] });
    if (chosen.canceled || !chosen.filePath) return null;
    const response = await fetch(`http://127.0.0.1:${port}/record/${encodeURIComponent(sessionId)}`, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Не удалось получить запись: HTTP ${response.status}`);
    await writeFile(chosen.filePath, Buffer.from(await response.arrayBuffer()));
    return chosen.filePath;
  }));
}

export function createStudioWindow() {
  if (studioWindow && !studioWindow.isDestroyed()) return studioWindow;
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 680,
    backgroundColor: '#0d1013',
    show: false,
    webPreferences: {
      preload: preloadFile,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  studioWindow = window;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, destination) => {
    if (!isAllowedStudioNavigation(destination, studioUrl)) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.once('ready-to-show', () => {
    window.show();
    if (!autoStarted) {
      autoStarted = true;
      const id = profileStore.lastSuccessfulId();
      if (id && profileStore.get(id)?.autoStart) void startProfile(id).catch(() => {});
    }
  });
  window.on('closed', () => {
    if (studioWindow === window) studioWindow = undefined;
  });
  void window.loadFile(studioFile);
  return window;
}

app.whenReady().then(() => {
  profileStore = createProfileStore(app.getPath('userData'));
  supervisor = createSupervisor({ emit: snapshot => {
    if (snapshot.state === 'failed' && !['failed', 'not-configured'].includes(serviceState.phase)) {
      serviceState = transitionServiceState(serviceState, { type: 'CHILD_EXIT', detail: snapshot.logExcerpt || 'Сервис завершился' });
    }
    publishSnapshot();
  } });
  registerSetupIpc();
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(mayUseMicrophone({ sender: webContents }, permission, studioWindow, studioUrl, details));
  });
  createStudioWindow();
  app.on('activate', () => {
    if (!studioWindow) createStudioWindow();
  });
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (quitAfterStop || !supervisor || (supervisor.snapshot().state === 'stopped' && !startJob)) return;
  event.preventDefault();
  quitAfterStop = true;
  void stopProfile().finally(() => app.quit());
});
