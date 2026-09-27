const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('liveTalkingDesktop', Object.freeze({ version: 1 }));
