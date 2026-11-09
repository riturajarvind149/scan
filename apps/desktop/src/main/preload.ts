import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

function subscribe(channel: string, callback: (data: unknown) => void): () => void {
  const listener = (_event: IpcRendererEvent, data: unknown) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('app', {
  getState: () => ipcRenderer.invoke('get-state'),
  createPairing: (address?: string) => ipcRenderer.invoke('create-pairing', address),
  phoneLinkQr: () => ipcRenderer.invoke('phone-link-qr'),
  joinWithInvite: (link: string) => ipcRenderer.invoke('join-with-invite', link),
  openAdmin: () => ipcRenderer.invoke('open-admin'),
  unpairPhone: (phoneId: string) => ipcRenderer.invoke('unpair-phone', phoneId),
  setServerUrl: (url: string) => ipcRenderer.invoke('set-server-url', url),
  setLocalEnabled: (enabled: boolean) => ipcRenderer.invoke('set-local-enabled', enabled),
  setStartWithWindows: (enabled: boolean) => ipcRenderer.invoke('set-start-with-windows', enabled),
  setLiveView: (enabled: boolean) => ipcRenderer.invoke('set-live-view', enabled),
  openScan: (scanId: string) => ipcRenderer.invoke('open-scan', scanId),
  onState: (callback: (state: unknown) => void) => subscribe('state-changed', callback),
  onPhonePaired: (callback: (phone: unknown) => void) => subscribe('phone-paired', callback),
});
