import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

// The popup shows untrusted scan content, so it gets only what it needs and none of the app's controls.
contextBridge.exposeInMainWorld('popup', {
  getScan: () => ipcRenderer.invoke('get-popup-scan'),
  close: () => ipcRenderer.send('close-popup'),
  onEnhanced: (callback: (scan: unknown) => void) => {
    ipcRenderer.on('scan-enhanced', (_event: IpcRendererEvent, scan: unknown) => callback(scan));
  },
});
