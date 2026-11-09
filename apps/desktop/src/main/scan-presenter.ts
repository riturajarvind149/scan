import { BrowserWindow, Notification, screen } from 'electron';
import path from 'node:path';
import { validateQrPayload, type QrImagePayload } from '@qr2win/shared-types';

const HISTORY_LIMIT = 20;
const SEEN_LIMIT = 500;
const POPUP_WIDTH = 360;
const POPUP_HEIGHT = 440;
const TEXT_PREVIEW_LENGTH = 80;
const ACTIVATION_SETTLE_MS = 150;

export interface ScanSummary {
  scanId: string;
  decodedText: string;
  timestamp: number;
}

/** Turns received scans into Windows notifications and, on click, always-on-top popups. */
export class ScanPresenter {
  private history: QrImagePayload[] = [];
  private seen = new Set<string>();
  private popups = new Map<string, BrowserWindow>();
  /**
   * Windows only delivers a toast's click while its Notification object is alive, and JavaScript
   * would otherwise collect it, so recent ones stay referenced.
   */
  private notifications: Notification[] = [];
  private lastInstanceClickAt = 0;

  constructor(
    private readonly assetPath: (...parts: string[]) => string,
    private readonly iconPath: string,
    private readonly onChange: () => void,
    /** A toast was clicked but there is no scan to show, as after a restart. */
    private readonly onEmptyActivation: () => void,
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
    this.notify(scan);
    ack();
    this.onChange();
  }

  /**
   * Handles a toast click reported by Windows, including one made later from the notification
   * center, when the Notification object may be long gone. Windows passes back the toast's arguments.
   */
  handleToastActivation(activationArguments: string): void {
    const scan = this.history.find((item) => activationArguments.includes(item.scanId));
    if (scan) {
      this.showPopup(scan);
      return;
    }
    // No id to go on. The toast's own click event may be about to handle it, so give that a moment.
    setTimeout(() => {
      if (Date.now() - this.lastInstanceClickAt < ACTIVATION_SETTLE_MS * 2) return;
      if (this.history[0]) this.showPopup(this.history[0]);
      else this.onEmptyActivation();
    }, ACTIVATION_SETTLE_MS);
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
  }

  private notify(scan: QrImagePayload): void {
    if (!Notification.isSupported()) {
      this.showPopup(scan);
      return;
    }
    const notification = new Notification({
      id: scan.scanId,
      title: 'QR code received',
      body: `Click to view. ${previewText(scan.decodedText)}`.trim(),
      icon: this.iconPath,
    });
    notification.on('click', () => {
      this.lastInstanceClickAt = Date.now();
      this.showPopup(scan);
    });
    // If Windows refuses the toast, the scan must still reach the user.
    notification.on('failed', (_event, error) => {
      console.warn('[scan] Notification failed:', error);
      this.showPopup(scan);
    });
    notification.show();

    this.notifications.push(notification);
    if (this.notifications.length > HISTORY_LIMIT) this.notifications.shift();
  }

  private showPopup(scan: QrImagePayload): void {
    const existing = this.popups.get(scan.scanId);
    if (existing && !existing.isDestroyed()) {
      existing.show();
      existing.focus();
      return;
    }

    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const offset = (this.popups.size % 5) * 28; // cascade so consecutive scans stay visible
    const popup = new BrowserWindow({
      width: POPUP_WIDTH,
      height: POPUP_HEIGHT,
      minWidth: 240,
      minHeight: 280,
      x: Math.round(workArea.x + workArea.width - POPUP_WIDTH - 24 - offset),
      y: Math.round(workArea.y + workArea.height - POPUP_HEIGHT - 24 - offset),
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
    popup.once('ready-to-show', () => {
      popup.show();
      popup.focus();
    });
    popup.on('closed', () => this.popups.delete(scan.scanId));
    this.popups.set(scan.scanId, popup);
    void popup.loadFile(this.assetPath('popup.html'));
  }
}

function previewText(text: string): string {
  const clean = text.replace(/\p{Cc}+/gu, ' ').trim();
  return clean.length > TEXT_PREVIEW_LENGTH ? `${clean.slice(0, TEXT_PREVIEW_LENGTH)}…` : clean;
}
