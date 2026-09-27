import { app, BrowserWindow, session } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isAllowedStudioNavigation, mayUseMicrophone } from './ipc-policy.mjs';

const studioFile = fileURLToPath(new URL('../dist/studio.html', import.meta.url));
const studioUrl = pathToFileURL(studioFile).href;
const preloadFile = fileURLToPath(new URL('./preload.cjs', import.meta.url));

let studioWindow;

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
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(mayUseMicrophone({ sender: webContents }, permission, studioWindow, studioUrl, details));
  });
  createStudioWindow();
  app.on('activate', () => {
    if (!studioWindow) createStudioWindow();
  });
});

app.on('window-all-closed', () => app.quit());
