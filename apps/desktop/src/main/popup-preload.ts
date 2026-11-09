import { contextBridge, ipcRenderer } from 'electron';

// The popup shows untrusted scan content, so it gets only what it needs and none of the app's controls.
contextBridge.exposeInMainWorld('popup', {
  getScan: () => ipcRenderer.invoke('get-popup-scan'),
  close: () => ipcRenderer.send('close-popup'),
});
