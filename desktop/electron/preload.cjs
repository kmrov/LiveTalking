const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('liveTalkingDesktop', Object.freeze({
  version: 1,
  getSetup: () => ipcRenderer.invoke('desktop:get-setup'),
  listProfiles: () => ipcRenderer.invoke('desktop:list-profiles'),
  getProfile: id => ipcRenderer.invoke('desktop:get-profile', id),
  checkSetup: profile => ipcRenderer.invoke('desktop:check-setup', profile),
  saveProfile: profile => ipcRenderer.invoke('desktop:save-profile', profile),
  chooseLiveTalkingRoot: () => ipcRenderer.invoke('desktop:choose-root'),
  chooseVoiceWav: () => ipcRenderer.invoke('desktop:choose-voice-wav'),
  previewVoiceWav: (id, wav) => ipcRenderer.invoke('desktop:preview-voice-wav', id, wav),
  chooseBrainRoot: () => ipcRenderer.invoke('desktop:choose-brain-root'),
  setBrainSecrets: (id, input) => ipcRenderer.invoke('desktop:brain-secrets', id, input),
  brainConversations: id => ipcRenderer.invoke('desktop:brain-conversations', id),
  createBrainConversation: id => ipcRenderer.invoke('desktop:brain-create', id),
  brainHistory: (id, conversationId) => ipcRenderer.invoke('desktop:brain-history', id, conversationId),
  brainMemories: id => ipcRenderer.invoke('desktop:brain-memories', id),
  brainDocument: (id, input) => ipcRenderer.invoke('desktop:brain-document', id, input),
  sillyTavernCharacters: id => ipcRenderer.invoke('desktop:st-characters', id),
  selectSillyTavernCharacter: (id, avatar) => ipcRenderer.invoke('desktop:st-select-character', id, avatar),
  startProfile: id => ipcRenderer.invoke('desktop:start-profile', id),
  stopProfile: () => ipcRenderer.invoke('desktop:stop-profile'),
  stopSpeechModel: stage => ipcRenderer.invoke('desktop:stop-speech-model', stage),
  projectionRequest: (id, action, input) => ipcRenderer.invoke('desktop:projection-request', id, action, input),
  getSnapshot: () => ipcRenderer.invoke('desktop:get-snapshot'),
  saveRecording: sessionId => ipcRenderer.invoke('desktop:save-recording', sessionId),
  avatarLibrary: profile => ipcRenderer.invoke('desktop:avatar-library', profile),
  chooseAvatarSource: profile => ipcRenderer.invoke('desktop:avatar-source', profile),
  checkAvatarCreation: input => ipcRenderer.invoke('desktop:avatar-check', input),
  createAvatar: (input, options) => ipcRenderer.invoke('desktop:avatar-create', input, options),
  retryAvatar: (input, options) => ipcRenderer.invoke('desktop:avatar-retry', input, options),
  cancelAvatar: jobId => ipcRenderer.invoke('desktop:avatar-cancel', jobId),
  renameAvatar: input => ipcRenderer.invoke('desktop:avatar-rename', input),
  selectAvatar: (profile, id, options) => ipcRenderer.invoke('desktop:avatar-select', profile, id, options),
  avatarSnapshot: profile => ipcRenderer.invoke('desktop:avatar-state', profile),
  onAvatarSnapshot: listener => {
    const wrapped = (_event, value) => listener(value);
    ipcRenderer.on('desktop:avatar-snapshot', wrapped);
    return () => ipcRenderer.removeListener('desktop:avatar-snapshot', wrapped);
  },
  onSnapshot: listener => {
    const wrapped = (_event, snapshot) => listener(snapshot);
    ipcRenderer.on('desktop:snapshot', wrapped);
    return () => ipcRenderer.removeListener('desktop:snapshot', wrapped);
  },
}));
