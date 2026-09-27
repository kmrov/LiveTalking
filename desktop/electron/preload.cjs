const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('liveTalkingDesktop', Object.freeze({
  version: 1,
  getSetup: () => ipcRenderer.invoke('desktop:get-setup'),
  checkSetup: profile => ipcRenderer.invoke('desktop:check-setup', profile),
  saveProfile: profile => ipcRenderer.invoke('desktop:save-profile', profile),
  chooseLiveTalkingRoot: () => ipcRenderer.invoke('desktop:choose-root'),
  chooseVoiceWav: () => ipcRenderer.invoke('desktop:choose-voice-wav'),
  startProfile: id => ipcRenderer.invoke('desktop:start-profile', id),
  stopProfile: () => ipcRenderer.invoke('desktop:stop-profile'),
  getSnapshot: () => ipcRenderer.invoke('desktop:get-snapshot'),
  onSnapshot: listener => {
    const wrapped = (_event, snapshot) => listener(snapshot);
    ipcRenderer.on('desktop:snapshot', wrapped);
    return () => ipcRenderer.removeListener('desktop:snapshot', wrapped);
  },
}));
