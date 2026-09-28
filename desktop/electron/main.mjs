import { app, BrowserWindow, dialog, ipcMain, session, safeStorage } from 'electron';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isAllowedStudioNavigation, isTrustedStudioSender, mayUseMicrophone } from './ipc-policy.mjs';
import { discoverLiveTalkingRoot } from './discover-root.mjs';
import { findVoiceReferences } from './discover-voice.mjs';
import { createProfileStore } from './profile-store.mjs';
import { inspectPrerequisites } from './prerequisites.mjs';
import { normalizeProfile } from '../src/profile.mjs';
import { createSupervisor } from './supervisor.mjs';
import { initialServiceState, transitionServiceState } from '../src/service-state.mjs';
import { createSecretStore, createFileSecretBackend } from './secret-store.mjs';
import { createBatyaApi } from './batya-api.mjs';
import { readServiceEnvironment, serviceEnvironment } from './service-environment.mjs';
import { createBatyaSupervisor } from './batya-supervisor.mjs';
import { inspectBatyaPrerequisites } from './batya-prerequisites.mjs';
import { createAvatarLibrary } from './avatar-library.mjs';
import { createAvatarJobs } from './avatar-jobs.mjs';
import { createAvatarSources } from './avatar-sources.mjs';
import { inspectAvatarPrerequisites, runAvatarCommand } from './avatar-prerequisites.mjs';
import { createAvatarRuntime } from './avatar-runtime.mjs';
import { createModelDownloads, prepareProfileModels } from './model-downloads.mjs';

const studioFile = fileURLToPath(new URL('../dist/studio.html', import.meta.url));
const studioUrl = pathToFileURL(studioFile).href;
const preloadFile = fileURLToPath(new URL('./preload.cjs', import.meta.url));
const fixtureMode = process.env.LIVETALKING_DESKTOP_TEST_FIXTURE === '1';
const fixturePort = Number(process.env.LIVETALKING_DESKTOP_TEST_PORT);
if (fixtureMode && process.env.LIVETALKING_DESKTOP_TEST_USER_DATA) app.setPath('userData', process.env.LIVETALKING_DESKTOP_TEST_USER_DATA);

let studioWindow;
let profileStore;
let supervisor;
let batyaSupervisor;
let secrets;
let avatarRuntime;
let avatarJobs;
let avatarLibrary;
let avatarFixture;
let modelDownloads;
let thumbnailQueue=Promise.resolve();
let serviceState = initialServiceState();
let startJob;
let runGeneration = 0;
let autoStarted = false;
let quitAfterStop = false;
let quitJob;

function runtimeSnapshot() { return { service: serviceState, supervisor: supervisor?.snapshot() ?? null, brain: batyaSupervisor?.snapshot() ?? null, downloads: modelDownloads?.snapshot() ?? null }; }
function publishSnapshot() {
  if (studioWindow && !studioWindow.isDestroyed()) studioWindow.webContents.send('desktop:snapshot', runtimeSnapshot());
}
const setupChecks = async profile => fixtureMode
  ? avatarFixture?.inspectSetup(profile) ?? Promise.resolve([{ id: 'fixture', state: 'ready', detail: 'Smoke fixture ready', action: '' }])
  : [...await inspectPrerequisites(profile), ...await inspectBatyaPrerequisites(profile, brainEnvironment(profile))];

async function startProfile(id) {
  if (!fixtureMode) await avatarRuntime.assertCanStart(profileStore.get(id));
  else if (avatarJobs.isBusy()) throw new Error("Сначала завершите подготовку аватара.");
  if (startJob) return startJob;
  const profile = profileStore.get(id);
  if (!profile) throw new Error(`Профиль ${id} не найден`);
  if (serviceState.phase === 'ready' && serviceState.profileId === id) return runtimeSnapshot();
  if (['ready', 'starting', 'checking'].includes(serviceState.phase) && serviceState.profileId !== id) throw new Error('Остановите текущий профиль перед переключением.');
  const wasFailed = serviceState.phase === 'failed';
  const token = ++runGeneration;
  serviceState = transitionServiceState(serviceState, { type: 'CHECK', profileId: id });
  publishSnapshot();
  startJob = (async () => {
    try {
      if (wasFailed) { await supervisor.stop(); await batyaSupervisor.stop(); }
      await prepareProfileModels(profile, { inspect: setupChecks, download: value => modelDownloads.prepare(value), cancelled: () => token !== runGeneration });
      if (token !== runGeneration) return runtimeSnapshot();
      if (supervisor.snapshot().state === 'failed') await supervisor.stop();
      serviceState = transitionServiceState(serviceState, { type: 'START', profileId: id });
      publishSnapshot();
      if (profile.brain.mode === 'batya') await batyaSupervisor.start(profile, brainEnvironment(profile));
      if (token !== runGeneration) return runtimeSnapshot();
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
  await modelDownloads?.stop();
  await supervisor.stop();
  await batyaSupervisor.stop();
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
    id: 'fixture', liveTalking: { root: avatarFixture?.root ?? path.dirname(app.getAppPath()), python: '/usr/bin/python3', port: fixturePort },
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

function discoverBrain(profile) {
  if (!profile.brain.root) {
    const roots = [path.join(path.dirname(profile.liveTalking.root || app.getAppPath()), 'batya'), path.join(os.homedir(), 'batya')];
    const root = roots.find(value => existsSync(path.join(value, 'src/batya/main.py')));
    if (root) { profile.brain.root = root; profile.brain.python = path.join(root, '.venv/bin/python'); }
  }
  if (!profile.brain.folderId) profile.brain.folderId = readServiceEnvironment(profile).YANDEX_FOLDER_ID || '';
  return profile;
}

function brainEnvironment(profile) {
  return serviceEnvironment({ values: readServiceEnvironment(profile), folderId: profile.brain.folderId,
    secrets: { YANDEX_AISTUDIO_KEY: secrets.get(`batya:${profile.id}:key`), BATYA_DATABASE_URL: secrets.get(`batya:${profile.id}:database`) } });
}

function secretStatus(profile) {
  const env = brainEnvironment(profile);
  return { persistent: secrets.persistent, apiKeyConfigured: Boolean(env.YANDEX_AISTUDIO_KEY), databaseConfigured: Boolean(env.BATYA_DATABASE_URL) };
}

function brainApi(id) {
  const profile = profileStore.get(id);
  if (!profile || profile.brain.mode !== 'batya') throw new Error('Сначала выберите и сохраните режим «Батя».');
  return createBatyaApi({ baseUrl: profile.brain.url });
}

function registerSetupIpc() {
  ipcMain.handle('desktop:get-setup', trusted(async () => {
    const profile = discoverBrain(initialProfile());
    const voiceReferences = findVoiceReferences(profile.liveTalking.root);
    if (!profile.speech.referenceWav && voiceReferences.length) {
      profile.speech.referenceWav = voiceReferences[0].wav;
      profile.speech.referenceText = voiceReferences[0].text;
    }
    return { profile, voiceReferences, avatars: await avatarRuntime.snapshot(profile), secrets: secretStatus(profile), recoveryError: profileStore.recoveryError(), testFixture: fixtureMode };
  }));
  ipcMain.handle('desktop:check-setup', trusted(async input => setupChecks(normalizeProfile(input))));
  ipcMain.handle('desktop:save-profile', trusted(input => avatarRuntime.runLifecycle(async () => { const profile = normalizeProfile(input); await avatarRuntime.assertCanSave(profile); return profileStore.save(profile); })));
  ipcMain.handle('desktop:brain-secrets', trusted((id, input = {}) => {
    const profile = profileStore.get(id);
    if (!profile) throw new Error('Профиль не найден');
    for (const [field, name] of [['apiKey', 'key'], ['databaseUrl', 'database']]) {
      const value = input[field];
      if (value === undefined || value === '') continue;
      if (typeof value !== 'string' || value.includes('\0') || value.length > 8192) throw new Error(`Invalid ${field}`);
      if (field === 'databaseUrl' && !/^postgres(?:ql)?:\/\//.test(value)) throw new Error('Database URL must use PostgreSQL');
      secrets.set(`batya:${id}:${name}`, value);
    }
    return secretStatus(profile);
  }));
  ipcMain.handle('desktop:brain-conversations', trusted(id => brainApi(id).conversations()));
  ipcMain.handle('desktop:brain-create', trusted(async id => {
    const conversation = await brainApi(id).createConversation();
    const profile = profileStore.get(id);
    profile.brain.conversationId = conversation.id;
    profileStore.save(profile);
    return conversation;
  }));
  ipcMain.handle('desktop:brain-history', trusted((id, conversationId) => brainApi(id).history(conversationId)));
  ipcMain.handle('desktop:brain-memories', trusted(id => brainApi(id).memories()));
  ipcMain.handle('desktop:brain-document', trusted((id, input) => brainApi(id).document(input)));
  ipcMain.handle('desktop:choose-brain-root', trusted(async () => {
    const result = await dialog.showOpenDialog(studioWindow, { title: 'Выбрать Батю', properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  }));
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
  ipcMain.handle('desktop:start-profile', trusted(id => avatarRuntime.runLifecycle(() => startProfile(id))));
  ipcMain.handle('desktop:stop-profile', trusted(stopProfile));
  ipcMain.handle('desktop:avatar-library', trusted(profile => avatarRuntime.list(profile)));
  ipcMain.handle('desktop:avatar-source', trusted(profile => avatarRuntime.chooseSource(profile)));
  ipcMain.handle('desktop:avatar-check', trusted(input => avatarRuntime.checkCreation(input)));
  ipcMain.handle('desktop:avatar-create', trusted((input, options) => avatarRuntime.create(input, options)));
  ipcMain.handle('desktop:avatar-retry', trusted((input, options) => avatarRuntime.retry(input, options)));
  ipcMain.handle('desktop:avatar-cancel', trusted(jobId => avatarJobs.cancel(jobId)));
  ipcMain.handle('desktop:avatar-rename', trusted(input => avatarRuntime.rename(input)));
  ipcMain.handle('desktop:avatar-select', trusted((profile, id, options) => avatarRuntime.select(profile, id, options)));
  ipcMain.handle('desktop:avatar-state', trusted(profile => avatarRuntime.snapshot(normalizeProfile(profile))));
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
      if (id && profileStore.get(id)?.autoStart) void avatarRuntime.runLifecycle(() => startProfile(id)).catch(() => {});
    }
  });
  window.on('closed', () => {
    if (studioWindow === window) studioWindow = undefined;
  });
  void window.loadFile(studioFile);
  return window;
}

app.whenReady().then(async () => {
  if (fixtureMode && process.env.LIVETALKING_DESKTOP_TEST_AVATAR_ROOT) {
    const { avatarFixtureOptions } = await import('../scripts/avatar-fixture-worker.mjs');
    avatarFixture = await avatarFixtureOptions(process.env.LIVETALKING_DESKTOP_TEST_AVATAR_ROOT, app.getPath('userData'));
  }
  profileStore = createProfileStore(app.getPath('userData'));
  modelDownloads = createModelDownloads({ ...(avatarFixture ? { spawn: avatarFixture.spawnModels } : {}), emit: publishSnapshot });
  secrets = createSecretStore({ safeStorage, backend: createFileSecretBackend(app.getPath('userData')) });
  batyaSupervisor = createBatyaSupervisor({ emit: snapshot => {
    if (snapshot.state === 'failed' && !['failed', 'not-configured'].includes(serviceState.phase)) {
      serviceState = transitionServiceState(serviceState, { type: 'CHILD_EXIT', detail: snapshot.logExcerpt || 'Батя недоступен' });
    }
    publishSnapshot();
  } });
  supervisor = createSupervisor({ emit: snapshot => {
    if (snapshot.state === 'failed' && !['failed', 'not-configured'].includes(serviceState.phase)) {
      serviceState = transitionServiceState(serviceState, { type: 'CHILD_EXIT', detail: snapshot.logExcerpt || 'Сервис завершился' });
    }
    publishSnapshot();
  } });
  avatarLibrary = createAvatarLibrary({
    readThumbnailBytes: false,
    makeThumbnail: async (_bytes, context) => {
      if(!context.python)return null;
      const result=thumbnailQueue.then(()=>avatarFixture
        ? avatarFixture.inspectPreview(context)
        : runAvatarCommand({...context,sourceKind:'image'},'preview'));
      thumbnailQueue=result.catch(()=>{});
      return result;
    },
    moveDirectoryNoReplace: avatarFixture?.moveDirectoryNoReplace ?? (async (_staged, final, context) => {
      const result = await runAvatarCommand({ ...context, schemaVersion: 1 }, 'publish');
      if (result.version !== 1 || result.avatarId !== context.avatarId || result.path !== final) throw new Error('Публикация аватара не подтверждена.');
    }),
  });
  avatarJobs = createAvatarJobs({ library: avatarLibrary, ...(avatarFixture ? { inspectCreation: avatarFixture.inspectCreation, spawn: avatarFixture.spawn } : {}), emit: job => {
    if (studioWindow && !studioWindow.isDestroyed()) studioWindow.webContents.send('desktop:avatar-snapshot', { root: job.root, job });
  } });
  const avatarSources = createAvatarSources({ ...(avatarFixture ? { inspectPreview: avatarFixture.inspectPreview } : {}), chooseFile: async () => {
    const result = await dialog.showOpenDialog(studioWindow, { title: 'Фото или видео для аватара', properties: ['openFile'], filters: [{ name: 'Фото и видео', extensions: ['png', 'jpg', 'jpeg', 'mp4', 'mov', 'mkv', 'avi'] }] });
    return result.canceled ? null : result.filePaths[0];
  } });
  avatarRuntime = createAvatarRuntime({ library: avatarLibrary, jobs: avatarJobs, sources: avatarSources, profiles: profileStore, stopProfile,
    getServiceState: () => serviceState, inspectCreation: avatarFixture?.inspectCreation ?? inspectAvatarPrerequisites });
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
  if (quitAfterStop || !supervisor || (supervisor.snapshot().state === 'stopped' && batyaSupervisor?.snapshot().state === 'stopped' && !startJob && !avatarJobs?.isBusy())) return;
  event.preventDefault();
  if (!quitJob) quitJob = Promise.all([avatarRuntime?.shutdown(), stopProfile()]).finally(() => { quitAfterStop = true; app.quit(); });
});
