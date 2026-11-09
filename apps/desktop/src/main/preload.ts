import { contextBridge, ipcRenderer } from 'electron';

// Expose a safe, minimal API to the renderer
contextBridge.exposeInMainWorld('electronAPI', {
  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (data: any) => ipcRenderer.invoke('save-settings', data),
  getStartWithWindows: () => ipcRenderer.invoke('get-start-with-windows'),
  setStartWithWindows: (enabled: boolean) => ipcRenderer.invoke('set-start-with-windows', enabled),

  // Pairing
  generatePairingCode: () => ipcRenderer.invoke('generate-pairing-code'),

  // Connection
  connectServer: (serverUrl: string, token: string) =>
    ipcRenderer.invoke('connect-server', serverUrl, token),
  disconnectServer: () => ipcRenderer.invoke('disconnect-server'),
  getConnectionStatus: () => ipcRenderer.invoke('get-connection-status'),

  // Local server
  startLocalServer: () => ipcRenderer.invoke('start-local-server'),
  stopLocalServer: () => ipcRenderer.invoke('stop-local-server'),
  getLocalServerInfo: () => ipcRenderer.invoke('get-local-server-info'),

  // Token management
  revokeToken: (token: string) => ipcRenderer.invoke('revoke-token', token),

  // Popup
  closePopup: () => ipcRenderer.send('close-popup'),

  // Events from main → renderer
  onQrReceived: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('qr-received', handler);
    return () => ipcRenderer.removeListener('qr-received', handler);
  },

  onQrImageData: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('qr-image-data', handler);
    return () => ipcRenderer.removeListener('qr-image-data', handler);
  },

  onConnectionStatusChange: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('connection-status-change', handler);
    return () => ipcRenderer.removeListener('connection-status-change', handler);
  },
});

