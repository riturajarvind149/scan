import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
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
import { parseInviteLink, type PhoneSummary } from '@qr2win/shared-types';
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
const PROTOCOL = 'qr2win';

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
    liveView: settings.liveView,
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
      { label: 'Live view', type: 'checkbox', checked: settings.liveView, click: (item) => setLiveView(item.checked) },
      { label: 'Open QR-to-Windows-11', click: showMainWindow },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
}

function setLiveView(enabled: boolean): void {
  settings.liveView = enabled;
  presenter.setLiveView(enabled);
  broadcastState();
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

function qrImage(text: string): Promise<string> {
  return QRCode.toDataURL(text, { width: 280, margin: 2, errorCorrectionLevel: 'M' });
}

async function joinWithInvite(link: string): Promise<void> {
  const invite = parseInviteLink(link);
  if (!invite) throw new Error("That isn't an invite link. It should look like https://your-relay/join/...");
  await internet.joinWithInvite(normalizeServerUrl(invite.origin), invite.token, os.hostname());
}

/** Handles a qr2win:// link. Any website can open one, so it always asks before joining a relay. */
async function handleDeepLink(link: string): Promise<void> {
  const invite = parseInviteLink(link);
  if (!invite) return;
  showMainWindow();
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: 'Join this relay?',
    message: `Receive scanned QR codes from ${new URL(invite.origin).host}?`,
    detail: 'Only continue if you asked for this invite. Images sent through this relay will appear as notifications on this PC.',
    buttons: ['Join', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;
  try {
    await joinWithInvite(link);
  } catch (err) {
    dialog.showErrorBox("Couldn't join", (err as Error).message);
  }
}

function deepLinkIn(argv: string[]): string | undefined {
  return argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
}

function setupIpc(): void {
  handle('get-state', buildState);

  handle('create-pairing', async (address?: string) => {
    const pairing = await local.createPairing(address);
    return { ...pairing, qrDataUrl: await qrImage(pairing.url) };
  });

  /** The public phone link: any phone can open it, so there is no code. */
  handle('phone-link-qr', async () => {
    if (!settings.serverUrl) throw new Error('Set your relay address first.');
    return { url: settings.serverUrl, qrDataUrl: await qrImage(settings.serverUrl) };
  });

  handle('join-with-invite', async (link: string) => {
    await joinWithInvite(typeof link === 'string' ? link : '');
  });

  handle('open-admin', () => {
    if (settings.serverUrl) void shell.openExternal(`${settings.serverUrl}/admin`);
  });

  handle('unpair-phone', (phoneId: string) => {
    if (typeof phoneId !== 'string') throw new Error('Invalid phone');
    local.unpair(phoneId);
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

  handle('set-live-view', (enabled: boolean) => {
    setLiveView(!!enabled);
  });

  handle('get-live-scans', () => presenter.getLiveScans());

  ipcMain.on('live-open-scan', (event, scanId: unknown) => {
    if (fromTrustedPage(event) && typeof scanId === 'string') presenter.openPopup(scanId);
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

function onLaptopJoined(name: string): void {
  if (!Notification.isSupported()) return;
  new Notification({
    title: 'New laptop added',
    body: `${name} now receives your scans too. If you didn't expect this, remove it in the admin dashboard.`,
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
  presenter = new ScanPresenter(assetPath, assetPath('icon.ico'), broadcastState, showMainWindow, () => {
    settings.liveView = false;
    broadcastState();
  });
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
  if (settings.liveView) presenter.setLiveView(true);

  // Test instances have an explicit data folder and must not take over this machine's links.
  if (app.isPackaged && !userDataOverride) app.setAsDefaultProtocolClient(PROTOCOL);
  const startupLink = deepLinkIn(process.argv);
  if (startupLink) void handleDeepLink(startupLink);

  powerMonitor.on('resume', () => internet.reconnectNow());
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Windows matches toasts to the app through this id; without it they can go missing.
  app.setAppUserModelId(app.isPackaged ? APP_ID : process.execPath);
  app.setToastActivatorCLSID(TOAST_ACTIVATOR_CLSID);

  app.on('second-instance', (_event, argv) => {
    showMainWindow();
    const link = deepLinkIn(argv);
    if (link) void handleDeepLink(link);
  });
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
