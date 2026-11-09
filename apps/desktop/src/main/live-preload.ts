import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

// The live window shows untrusted scan content, so it gets only what it needs and none of the app's controls.
contextBridge.exposeInMainWorld('live', {
  getScans: () => ipcRenderer.invoke('get-live-scans'),
  openScan: (scanId: string) => ipcRenderer.send('live-open-scan', scanId),
  onScan: (callback: (scan: unknown) => void) => {
    ipcRenderer.on('live-scan', (_event: IpcRendererEvent, scan: unknown) => callback(scan));
  },
});
