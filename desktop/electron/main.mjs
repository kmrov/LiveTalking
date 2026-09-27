import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isAllowedStudioNavigation, mayUseMicrophone } from './ipc-policy.mjs';
import { discoverLiveTalkingRoot } from './discover-root.mjs';
import { createProfileStore } from './profile-store.mjs';
import { inspectPrerequisites } from './prerequisites.mjs';
import { normalizeProfile } from '../src/profile.mjs';
import { isTrustedStudioSender } from './ipc-policy.mjs';

const studioFile = fileURLToPath(new URL('../dist/studio.html', import.meta.url));
const studioUrl = pathToFileURL(studioFile).href;
const preloadFile = fileURLToPath(new URL('./preload.cjs', import.meta.url));

let studioWindow;
let profileStore;

function trusted(handler) {
  return (event, ...args) => {
    if (!isTrustedStudioSender(event, studioWindow, studioUrl)) throw new Error('Untrusted Studio request');
    return handler(...args);
  };
}

function initialProfile() {
  const saved = profileStore.get(profileStore.lastSuccessfulId()) ?? profileStore.list()[0];
  if (saved) return saved;
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
  ipcMain.handle('desktop:get-setup', trusted(() => ({
    profile: initialProfile(),
    recoveryError: profileStore.recoveryError(),
  })));
  ipcMain.handle('desktop:check-setup', trusted(async input => inspectPrerequisites(normalizeProfile(input))));
  ipcMain.handle('desktop:save-profile', trusted(input => profileStore.save(normalizeProfile(input))));
  ipcMain.handle('desktop:choose-root', trusted(async () => {
    const result = await dialog.showOpenDialog(studioWindow, { title: 'Выбрать LiveTalking', properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  }));
  ipcMain.handle('desktop:choose-voice-wav', trusted(async () => {
    const result = await dialog.showOpenDialog(studioWindow, { title: 'Выбрать WAV-образец голоса', properties: ['openFile'], filters: [{ name: 'WAV', extensions: ['wav'] }] });
    return result.canceled ? null : result.filePaths[0];
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
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (studioWindow === window) studioWindow = undefined;
  });
  void window.loadFile(studioFile);
  return window;
}

app.whenReady().then(() => {
  profileStore = createProfileStore(app.getPath('userData'));
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
