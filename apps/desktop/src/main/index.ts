import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  Notification,
  ipcMain,
  nativeImage,
  screen,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import QRCode from 'qrcode';
import { ConnectionManager } from './connection';
import { LocalServer } from './local-server';
import { SettingsStore } from './settings';
import type { QrImagePayload } from '@qr2win/shared-types';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
const qrPopups = new Map<string, BrowserWindow>();
const connectionManager = new ConnectionManager();
const localServer = new LocalServer();
const settings = new SettingsStore();

function getAssetPath(...paths: string[]): string {
  // In dev: dist/main -> ../../assets
  const devPath = path.join(__dirname, '..', '..', 'assets', ...paths);
  if (fs.existsSync(devPath)) return devPath;

  // In packaged app / dist-relative: dist/main -> ../assets
  const distPath = path.join(__dirname, '..', 'assets', ...paths);
  if (fs.existsSync(distPath)) return distPath;

  // Fallback to app path
  return path.join(app.getAppPath(), 'assets', ...paths);
}

function getIconPath(): string {
  return getAssetPath('icon.png');
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 500,
    height: 700,
    minWidth: 400,
    minHeight: 550,
    title: 'QR-to-Windows-11',
    icon: getIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    show: false,
  });

  win.loadFile(getAssetPath('index.html'));

  // Security: restrict navigation
  win.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.on('close', (event) => {
    // Minimize to tray instead of closing
    event.preventDefault();
    win.hide();
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  return win;
}

function getOrCreateQrPopup(payload: QrImagePayload): BrowserWindow {
  const existing = qrPopups.get(payload.scanId);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    existing.setAlwaysOnTop(true, 'screen-saver');
    return existing;
  }

  const display = screen.getPrimaryDisplay();
  const { width: screenW, height: screenH } = display.workAreaSize;
  const popupW = 360;
  const popupH = 420;

  // Cascade offset if multiple popups are open
  const offset = (qrPopups.size % 5) * 24;
  const popupX = screenW - popupW - 20 - offset;
  const popupY = screenH - popupH - 20 - offset;

  const popup = new BrowserWindow({
    width: popupW,
    height: popupH,
    x: popupX,
    y: popupY,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: false,
    transparent: false,
    backgroundColor: '#1e293b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  popup.setAlwaysOnTop(true, 'screen-saver');
  popup.loadFile(getAssetPath('popup.html'));

  popup.webContents.once('did-finish-load', () => {
    popup.webContents.send('qr-image-data', {
      scanId: payload.scanId,
      mimeType: payload.mimeType,
      imageBase64: payload.imageBase64,
      decodedText: payload.decodedText,
      width: payload.width,
      height: payload.height,
      timestamp: payload.timestamp,
    });
  });

  popup.on('closed', () => {
    qrPopups.delete(payload.scanId);
  });

  qrPopups.set(payload.scanId, popup);
  return popup;
}

function showQrNotification(payload: QrImagePayload): void {
  const popup = getOrCreateQrPopup(payload);

  if (Notification.isSupported()) {
    const notification = new Notification({
      title: 'QR Code Received',
      body: `Scanned: ${payload.decodedText.length > 60 ? payload.decodedText.slice(0, 60) + '…' : payload.decodedText}`,
      icon: getIconPath(),
      silent: false,
    });

    notification.on('click', () => {
      if (!popup.isDestroyed()) {
        popup.show();
        popup.focus();
        popup.setAlwaysOnTop(true, 'screen-saver');
      } else {
        getOrCreateQrPopup(payload);
      }
    });

    notification.show();
  }
}

function createTray(): void {
  const iconPath = getIconPath();
  tray = new Tray(nativeImage.createFromPath(iconPath));

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Window',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.exit(0);
      },
    },
  ]);

  tray.setToolTip('QR-to-Windows-11');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

// ─── IPC Handlers ──────────────────────────────────────────────────────

function setupIPC(): void {
  // Settings
  ipcMain.handle('get-settings', () => {
    return settings.getAll();
  });

  ipcMain.handle('save-settings', (_event, data) => {
    settings.setAll(data);
    return true;
  });

  ipcMain.handle('get-start-with-windows', () => {
    try {
      return app.getLoginItemSettings().openAtLogin;
    } catch {
      return false;
    }
  });

  ipcMain.handle('set-start-with-windows', (_event, enabled: boolean) => {
    try {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        path: process.execPath,
      });
      settings.setAll({ startWithWindows: enabled });
      return app.getLoginItemSettings().openAtLogin;
    } catch (err: any) {
      console.warn('[desktop] Failed to set login item settings:', err.message);
      return false;
    }
  });

  // Generate pairing code + pairing QR
  ipcMain.handle('generate-pairing-code', async () => {
    const deviceId = settings.getDesktopDeviceId();
    const serverUrl = settings.getServerUrl();

    if (!serverUrl) {
      return { error: 'Server URL not configured' };
    }

    try {
      const response = await fetch(`${serverUrl}/api/pairing/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ desktopDeviceId: deviceId }),
      });

      if (!response.ok) {
        return { error: `Server returned ${response.status}: ${response.statusText}` };
      }

      const data = await response.json();

      // Generate a QR code containing pairing info for phone scanner
      const pairingPayload = JSON.stringify({
        type: 'qr2win-pair',
        server: serverUrl,
        code: data.code,
      });

      const qrDataUrl = await QRCode.toDataURL(pairingPayload, {
        width: 220,
        margin: 2,
        color: { dark: '#0f172a', light: '#ffffff' },
      });

      return { ...data, qrDataUrl };
    } catch (err: any) {
      return { error: `Failed to connect to server at ${serverUrl}: ${err.message}` };
    }
  });

  // Connect to server
  ipcMain.handle('connect-server', async (_event, serverUrl: string, token: string) => {
    try {
      const wsUrl = serverUrl.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws';
      connectionManager.connect(wsUrl, token, 'desktop');
      return { success: true };
    } catch (err: any) {
      return { error: err.message };
    }
  });

  // Disconnect
  ipcMain.handle('disconnect-server', () => {
    connectionManager.disconnect();
    return { success: true };
  });

  // Get connection status
  ipcMain.handle('get-connection-status', () => {
    return connectionManager.getStatus();
  });

  // Start local server
  ipcMain.handle('start-local-server', async () => {
    try {
      const info = await localServer.start();
      const primaryAddress = info.addresses[0] || `localhost:${info.port}`;
      const pairingPayload = JSON.stringify({
        type: 'qr2win-pair',
        server: `http://${primaryAddress}`,
        code: info.pairingCode,
      });

      const qrDataUrl = await QRCode.toDataURL(pairingPayload, {
        width: 220,
        margin: 2,
        color: { dark: '#0f172a', light: '#ffffff' },
      });

      return { ...info, qrDataUrl };
    } catch (err: any) {
      return { error: err.message };
    }
  });

  // Stop local server
  ipcMain.handle('stop-local-server', () => {
    localServer.stop();
    return { success: true };
  });

  // Get local server info
  ipcMain.handle('get-local-server-info', () => {
    return localServer.getInfo();
  });

  // Close popup
  ipcMain.on('close-popup', (event) => {
    const popup = BrowserWindow.fromWebContents(event.sender);
    if (popup) {
      popup.close();
    }
  });

  // Revoke token
  ipcMain.handle('revoke-token', async (_event, token: string) => {
    const serverUrl = settings.getServerUrl();
    if (!serverUrl) return { error: 'No server configured' };

    try {
      const response = await fetch(`${serverUrl}/api/pairing/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      return await response.json();
    } catch (err: any) {
      return { error: err.message };
    }
  });
}

// ─── QR event handler ──────────────────────────────────────────────────
function onQrReceived(payload: QrImagePayload): void {
  console.log(`[desktop] QR received: scanId=${payload.scanId}`);
  showQrNotification(payload);

  // Notify main window
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('qr-received', {
      scanId: payload.scanId,
      decodedText: payload.decodedText,
      timestamp: payload.timestamp,
    });
  }
}

// ─── App lifecycle ─────────────────────────────────────────────────────

app.whenReady().then(() => {
  mainWindow = createMainWindow();
  createTray();
  setupIPC();

  // Listen for QR images from both connection types
  connectionManager.onQrImage(onQrReceived);
  localServer.onQrImage(onQrReceived);

  // Auto-connect if settings exist
  const token = settings.getToken();
  const serverUrl = settings.getServerUrl();
  if (token && serverUrl) {
    const wsUrl = serverUrl.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws';
    connectionManager.connect(wsUrl, token, 'desktop');
  }
});

app.on('window-all-closed', () => {
  // Keep running in tray – don't quit
});

app.on('before-quit', () => {
  connectionManager.disconnect();
  localServer.stop();
  if (mainWindow) {
    mainWindow.removeAllListeners('close');
    mainWindow.close();
  }
  for (const popup of qrPopups.values()) {
    if (!popup.isDestroyed()) popup.close();
  }
});

app.on('activate', () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
  } else {
    mainWindow.show();
  }
});
