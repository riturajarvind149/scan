import fs from 'node:fs';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
  shell,
  Tray,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import QRCode from 'qrcode';
import type { PhoneSummary } from '@qr2win/shared-types';
import type { ChannelEvents, ChannelMode } from './channel';
import { InternetChannel } from './internet-channel';
import { LocalChannel } from './local-channel';
import { isLoopbackUrl, normalizeServerUrl } from './network';
import { ScanPresenter } from './scan-presenter';
import { SettingsStore } from './settings';

const APP_ID = 'com.qr2win.desktop';
/** Fixed for this app: Windows looks it up from the shortcut, so it must not change between runs. */
const TOAST_ACTIVATOR_CLSID = '{7E0C6A52-3B1F-4D8E-9A61-2F4C8B7D1E93}';
const START_HIDDEN_ARG = '--hidden';

// An explicit data directory lets several isolated instances run, which the end-to-end test needs.
const userDataOverride = app.commandLine.getSwitchValue('user-data-dir');
if (userDataOverride) app.setPath('userData', userDataOverride);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let settings: SettingsStore;
let presenter: ScanPresenter;
let local: LocalChannel;
let internet: InternetChannel;

const assetPath = (...parts: string[]): string => path.join(app.getAppPath(), 'assets', ...parts);

function showMainWindow(): void {
  if (!mainWindow) return;
  mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function createMainWindow(startHidden: boolean): BrowserWindow {
  const win = new BrowserWindow({
    width: 460,
    height: 760,
    minWidth: 380,
    minHeight: 520,
    title: 'QR-to-Windows-11',
    icon: assetPath('icon.ico'),
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenu(null);
  void win.loadFile(assetPath('index.html'));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('close', (event) => {
    // Closing the window leaves the app running in the tray so scans keep arriving.
    if (!isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });
  if (!startHidden) win.once('ready-to-show', () => win.show());
  return win;
}

function buildState() {
  return {
    local: { ...local.getState(), enabled: settings.localEnabled },
    internet: {
      ...internet.getState(),
      unreachableByPhones: !!settings.serverUrl && isLoopbackUrl(settings.serverUrl),
    },
    scans: presenter.getHistory(),
    startWithWindows: app.getLoginItemSettings(loginItemOptions()).openAtLogin,
    canAutoStart: app.isPackaged,
  };
}

function broadcastState(): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('state-changed', buildState());
  updateTray();
}

function updateTray(): void {
  if (!tray) return;
  const channels = [local.getState().status, internet.getState().status];
  const label = channels.includes('connected') ? 'Ready to receive scans' : 'Not connected';
  tray.setToolTip(`QR-to-Windows-11: ${label}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label, enabled: false },
      { type: 'separator' },
      { label: 'Show latest QR code', enabled: presenter.hasScans(), click: () => presenter.openLatest() },
      { label: 'Open QR-to-Windows-11', click: showMainWindow },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
}

function createTray(): void {
  tray = new Tray(nativeImage.createFromPath(assetPath('icon.ico')));
  tray.on('click', showMainWindow);
  updateTray();
}

function loginItemOptions() {
  // While running unpackaged, the executable is Electron itself and needs the app path too.
  return { path: process.execPath, args: app.isPackaged ? [START_HIDDEN_ARG] : [app.getAppPath(), START_HIDDEN_ARG] };
}

function fromTrustedPage(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  return event.senderFrame?.url.startsWith('file://') ?? false;
}

/** Registers a handler that only answers the app's own bundled pages. */
function handle<A extends unknown[], R>(channel: string, handler: (...args: A) => R | Promise<R>): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromTrustedPage(event)) throw new Error('Rejected call from an untrusted page');
    return handler(...(args as A));
  });
}

function assertMode(mode: unknown): asserts mode is ChannelMode {
  if (mode !== 'local' && mode !== 'internet') throw new Error('Unknown connection mode');
}

function setupIpc(): void {
  handle('get-state', buildState);

  handle('create-pairing', async (mode: ChannelMode, address?: string) => {
    assertMode(mode);
    const pairing = mode === 'local' ? await local.createPairing(address) : await internet.createPairing();
    const qrDataUrl = await QRCode.toDataURL(pairing.url, { width: 280, margin: 2, errorCorrectionLevel: 'M' });
    return { ...pairing, qrDataUrl, mode };
  });

  handle('create-laptop-code', () => internet.createLaptopCode());

  handle('join-account', async (code: string) => {
    if (typeof code !== 'string' || !/^\d{8}$/.test(code.trim())) throw new Error('Enter the 8-digit code from your other laptop.');
    await internet.joinAccount(code.trim());
  });

  handle('unpair-phone', async (mode: ChannelMode, phoneId: string) => {
    assertMode(mode);
    if (typeof phoneId !== 'string') throw new Error('Invalid phone');
    if (mode === 'local') local.unpair(phoneId);
    else await internet.unpair(phoneId);
  });

  handle('set-server-url', (input: string) => {
    if (typeof input !== 'string') throw new Error('Invalid address');
    settings.serverUrl = input.trim() ? normalizeServerUrl(input) : '';
    internet.start();
    return settings.serverUrl;
  });

  handle('set-local-enabled', async (enabled: boolean) => {
    settings.localEnabled = !!enabled;
    if (settings.localEnabled) await local.start();
    else await local.stop();
  });

  handle('set-start-with-windows', (enabled: boolean) => {
    app.setLoginItemSettings({ ...loginItemOptions(), openAtLogin: !!enabled });
    broadcastState();
  });

  handle('open-scan', (scanId: string) => {
    if (typeof scanId === 'string') presenter.openPopup(scanId);
  });

  ipcMain.handle('get-popup-scan', (event) => {
    if (!fromTrustedPage(event)) return null;
    const win = BrowserWindow.fromWebContents(event.sender);
    return win ? presenter.scanForWindow(win) : null;
  });

  ipcMain.on('close-popup', (event) => {
    if (fromTrustedPage(event)) BrowserWindow.fromWebContents(event.sender)?.close();
  });
}

function onPhonePaired(phone: PhoneSummary, mode: ChannelMode): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('phone-paired', { ...phone, mode });
  // Tell the user about every new pairing, so an unexpected phone is noticed and can be removed.
  if (Notification.isSupported()) {
    new Notification({
      title: 'New phone paired',
      body: `${phone.name} can now send QR codes to this PC. If this wasn't you, remove it in the app.`,
      icon: assetPath('icon.ico'),
    }).show();
  }
}

/**
 * Windows delivers toast clicks through a COM activator named on the Start Menu shortcut. The
 * installer's shortcut only carries the app id, so without this toasts appear but clicks do nothing.
 */
function registerToastShortcut(): void {
  if (!app.isPackaged) return;
  const shortcut = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'QR-to-Windows-11.lnk');
  const options = { target: process.execPath, appUserModelId: APP_ID, toastActivatorClsid: TOAST_ACTIVATOR_CLSID };
  if (!shell.writeShortcutLink(shortcut, fs.existsSync(shortcut) ? 'update' : 'create', options)) {
    console.warn('[desktop] Could not update the Start Menu shortcut; clicking notifications may not work.');
  }
}

function onLaptopJoined(): void {
  if (!Notification.isSupported()) return;
  new Notification({
    title: 'New laptop added',
    body: "Another laptop now receives your scans too. If this wasn't you, change your relay's RELAY_SECRET.",
    icon: assetPath('icon.ico'),
  }).show();
}

function start(): void {
  registerToastShortcut();
  settings = new SettingsStore();
  // A daily-use receiver should already be running. On by default once; the checkbox can turn it off.
  if (app.isPackaged && !userDataOverride && settings.claimAutoStartInitialization()) {
    app.setLoginItemSettings({ ...loginItemOptions(), openAtLogin: true });
  }
  presenter = new ScanPresenter(assetPath, assetPath('icon.ico'), broadcastState, showMainWindow);
  Notification.handleActivation((details) => presenter.handleToastActivation(details.arguments));
  const events: ChannelEvents = {
    onScan: (scan, ack) => presenter.receive(scan, ack),
    onPhonePaired,
    onLaptopJoined,
    onChange: broadcastState,
  };
  local = new LocalChannel(settings, events);
  internet = new InternetChannel(settings, events);

  setupIpc();
  mainWindow = createMainWindow(process.argv.includes(START_HIDDEN_ARG));
  createTray();

  if (settings.localEnabled) void local.start();
  internet.start();

  powerMonitor.on('resume', () => internet.reconnectNow());
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Windows matches toasts to the app through this id; without it they can go missing.
  app.setAppUserModelId(app.isPackaged ? APP_ID : process.execPath);
  app.setToastActivatorCLSID(TOAST_ACTIVATOR_CLSID);

  app.on('second-instance', showMainWindow);
  app.whenReady().then(start).catch((err) => {
    console.error('[desktop] Failed to start:', err);
    app.exit(1);
  });

  // The app lives in the tray, so having no windows is normal.
  app.on('window-all-closed', () => undefined);

  let shutdownDone = false;
  app.on('before-quit', (event) => {
    isQuitting = true;
    if (shutdownDone || !local) return;
    event.preventDefault();
    presenter.closeAll();
    internet.stop();
    void local.stop().finally(() => {
      shutdownDone = true;
      app.quit();
    });
  });
}
