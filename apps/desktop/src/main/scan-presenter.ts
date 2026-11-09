import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { validateEnhancedImage, validateQrPayload, type EnhancedImage, type QrImagePayload } from '@qr2win/shared-types';

const HISTORY_LIMIT = 50;
const LIVE_TILES = 6;
const LIVE_WIDTH = 720;
const LIVE_HEIGHT = 560;
const SEEN_LIMIT = 500;
const POPUP_WIDTH = 360;
const POPUP_HEIGHT = 440;
const POPUP_GAP = 16;
/**
 * The straightened copy follows the first photo closely. A new popup waits this long for it, so
 * the code usually appears clean rather than changing a moment later. It never waits any longer.
 */
const HOLD_FOR_CLEARER_MS = 1500;

export interface ScanSummary {
  scanId: string;
  decodedText: string;
  timestamp: number;
}

/** Turns received scans into always-on-top popups, or tiles in the live window when that is on. */
export class ScanPresenter {
  private history: QrImagePayload[] = [];
  private seen = new Set<string>();
  private popups = new Map<string, BrowserWindow>();
  /** Where each popup sits, so a new one can take the first free place. */
  private slots = new Map<string, number>();
  /** Shows a popup still hidden while it waits for the clearer copy. */
  private reveals = new Map<string, () => void>();
  private live: BrowserWindow | null = null;

  constructor(
    private readonly assetPath: (...parts: string[]) => string,
    private readonly iconPath: string,
    private readonly onChange: () => void,
    /** The person closed the live window, which turns live view off. */
    private readonly onLiveClosed: () => void,
  ) {}

  receive(scan: QrImagePayload, ack: () => void): void {
    const invalid = validateQrPayload(scan);
    if (invalid) {
      console.warn(`[scan] Dropped invalid scan: ${invalid}`);
      return;
    }
    if (this.seen.has(scan.scanId)) {
      ack(); // the phone is retrying because it missed our first ack
      return;
    }
    this.seen.add(scan.scanId);
    if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value as string);

    this.history.unshift(scan);
    this.history.length = Math.min(this.history.length, HISTORY_LIMIT);
    if (this.live && !this.live.isDestroyed()) this.live.webContents.send('live-scan', scan);
    else this.present(scan);
    ack();
    this.onChange();
  }

  /** Upgrades a scan already on screen with its clearer copy, which arrives just after the scan. */
  applyEnhancement(scanId: string, enhanced: EnhancedImage): void {
    const scan = this.history.find((item) => item.scanId === scanId);
    if (!scan || validateEnhancedImage(enhanced)) return;
    scan.enhanced = enhanced;
    const popup = this.popups.get(scanId);
    if (popup && !popup.isDestroyed()) popup.webContents.send('scan-enhanced', scan);
    this.reveals.get(scanId)?.();
    if (this.live && !this.live.isDestroyed()) this.live.webContents.send('live-scan', scan);
  }

  getHistory(): ScanSummary[] {
    return this.history.map(({ scanId, decodedText, timestamp }) => ({ scanId, decodedText, timestamp }));
  }

  openPopup(scanId: string): void {
    const scan = this.history.find((item) => item.scanId === scanId);
    if (scan) this.showPopup(scan);
  }

  openLatest(): void {
    if (this.history[0]) this.showPopup(this.history[0]);
  }

  hasScans(): boolean {
    return this.history.length > 0;
  }

  /** Opens or closes the always-on-top window showing codes as they arrive. */
  setLiveView(enabled: boolean): void {
    if (!enabled) {
      const live = this.live;
      this.live = null;
      if (live && !live.isDestroyed()) live.destroy();
      return;
    }
    if (this.live && !this.live.isDestroyed()) {
      this.live.show();
      return;
    }
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const live = new BrowserWindow({
      width: LIVE_WIDTH,
      height: LIVE_HEIGHT,
      minWidth: 320,
      minHeight: 280,
      x: Math.round(workArea.x + workArea.width - LIVE_WIDTH - 24),
      y: Math.round(workArea.y + 24),
      alwaysOnTop: true,
      autoHideMenuBar: true,
      show: false,
      title: 'QR codes, live',
      icon: this.iconPath,
      backgroundColor: '#ffffff',
      webPreferences: {
        preload: path.join(__dirname, 'live-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    live.setMenu(null);
    live.setAlwaysOnTop(true, 'screen-saver');
    live.webContents.on('will-navigate', (event) => event.preventDefault());
    live.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // Without taking focus, so a code arriving doesn't interrupt whatever is being typed.
    live.once('ready-to-show', () => live.showInactive());
    live.on('closed', () => {
      if (this.live === live) {
        this.live = null;
        this.onLiveClosed();
      }
    });
    this.live = live;
    void live.loadFile(this.assetPath('live.html'));
  }

  /** The newest codes, for the live window to start with. */
  getLiveScans(): QrImagePayload[] {
    return this.history.slice(0, LIVE_TILES);
  }

  /** The scan a popup window displays. */
  scanForWindow(win: BrowserWindow): QrImagePayload | null {
    for (const [scanId, popup] of this.popups) {
      if (popup === win) return this.history.find((item) => item.scanId === scanId) ?? null;
    }
    return null;
  }

  closeAll(): void {
    for (const popup of this.popups.values()) {
      if (!popup.isDestroyed()) popup.destroy();
    }
    this.popups.clear();
    this.slots.clear();
    this.reveals.clear();
    this.setLiveView(false);
  }

  /** Opens a new scan's popup without taking focus, so a code arriving never interrupts typing. */
  private present(scan: QrImagePayload): void {
    const popup = this.createPopup(scan);
    let ready = false;
    let holdOver = false;
    const reveal = () => {
      if (ready && (holdOver || scan.enhanced) && !popup.isDestroyed() && !popup.isVisible()) popup.showInactive();
    };
    popup.once('ready-to-show', () => {
      ready = true;
      reveal();
    });
    setTimeout(() => {
      holdOver = true;
      reveal();
    }, HOLD_FOR_CLEARER_MS);
    this.reveals.set(scan.scanId, reveal);
  }

  /** Opens a popup the person asked for, from the recent scans or the tray. */
  private showPopup(scan: QrImagePayload): void {
    const existing = this.popups.get(scan.scanId);
    if (existing && !existing.isDestroyed()) {
      existing.show();
      existing.focus();
      return;
    }
    const popup = this.createPopup(scan);
    popup.once('ready-to-show', () => {
      popup.show();
      popup.focus();
    });
  }

  private forget(scanId: string): void {
    this.popups.delete(scanId);
    this.slots.delete(scanId);
    this.reveals.delete(scanId);
  }

  /** Creates a hidden popup in the first free place on screen, so each code stays fully visible. */
  private createPopup(scan: QrImagePayload): BrowserWindow {
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const columns = Math.max(1, Math.floor((workArea.width - POPUP_GAP) / (POPUP_WIDTH + POPUP_GAP)));
    const rows = Math.max(1, Math.floor((workArea.height - POPUP_GAP) / (POPUP_HEIGHT + POPUP_GAP)));
    const places = columns * rows;
    if (this.popups.size >= places) {
      // The screen is full. The oldest makes way, and stays available under recent scans.
      const [oldestId, oldest] = this.popups.entries().next().value as [string, BrowserWindow];
      if (!oldest.isDestroyed()) oldest.destroy();
      this.forget(oldestId);
    }
    const taken = new Set(this.slots.values());
    let slot = 0;
    while (taken.has(slot)) slot++;

    const popup = new BrowserWindow({
      width: POPUP_WIDTH,
      height: POPUP_HEIGHT,
      minWidth: 240,
      minHeight: 280,
      x: Math.round(workArea.x + workArea.width - (POPUP_WIDTH + POPUP_GAP) * ((slot % columns) + 1)),
      y: Math.round(workArea.y + workArea.height - (POPUP_HEIGHT + POPUP_GAP) * (Math.floor(slot / columns) + 1)),
      frame: false,
      alwaysOnTop: true,
      show: false,
      title: 'QR code',
      icon: this.iconPath,
      backgroundColor: '#ffffff',
      webPreferences: {
        preload: path.join(__dirname, 'popup-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    // This level stays above normal "always on top" windows and the taskbar.
    popup.setAlwaysOnTop(true, 'screen-saver');
    popup.webContents.on('will-navigate', (event) => event.preventDefault());
    popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    popup.on('closed', () => {
      if (this.popups.get(scan.scanId) === popup) this.forget(scan.scanId);
    });
    this.popups.set(scan.scanId, popup);
    this.slots.set(scan.scanId, slot);
    void popup.loadFile(this.assetPath('popup.html'));
    return popup;
  }
}
