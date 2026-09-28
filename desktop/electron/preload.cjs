const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('liveTalkingDesktop', Object.freeze({
  version: 1,
  getSetup: () => ipcRenderer.invoke('desktop:get-setup'),
  checkSetup: profile => ipcRenderer.invoke('desktop:check-setup', profile),
  saveProfile: profile => ipcRenderer.invoke('desktop:save-profile', profile),
  chooseLiveTalkingRoot: () => ipcRenderer.invoke('desktop:choose-root'),
  chooseVoiceWav: () => ipcRenderer.invoke('desktop:choose-voice-wav'),
  chooseBrainRoot: () => ipcRenderer.invoke('desktop:choose-brain-root'),
  setBrainSecrets: (id, input) => ipcRenderer.invoke('desktop:brain-secrets', id, input),
  brainConversations: id => ipcRenderer.invoke('desktop:brain-conversations', id),
  createBrainConversation: id => ipcRenderer.invoke('desktop:brain-create', id),
  brainHistory: (id, conversationId) => ipcRenderer.invoke('desktop:brain-history', id, conversationId),
  brainMemories: id => ipcRenderer.invoke('desktop:brain-memories', id),
  brainDocument: (id, input) => ipcRenderer.invoke('desktop:brain-document', id, input),
  startProfile: id => ipcRenderer.invoke('desktop:start-profile', id),
  stopProfile: () => ipcRenderer.invoke('desktop:stop-profile'),
  getSnapshot: () => ipcRenderer.invoke('desktop:get-snapshot'),
  saveRecording: sessionId => ipcRenderer.invoke('desktop:save-recording', sessionId),
  onSnapshot: listener => {
    const wrapped = (_event, snapshot) => listener(snapshot);
    ipcRenderer.on('desktop:snapshot', wrapped);
    return () => ipcRenderer.removeListener('desktop:snapshot', wrapped);
  },
}));
