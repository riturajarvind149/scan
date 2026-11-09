import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import { resolveServerUrl } from './network';

declare const __DEFAULT_RELAY_URL__: string;

interface StoredSettings {
  serverUrl: string;
  localEnabled: boolean;
  localPort: number;
  /** The relay credential, encrypted with the Windows user's key (DPAPI). */
  internetCredential: { desktopId: string; encryptedToken: string } | null;
  /** Phones removed from this laptop, re-sent to a relay that may have restarted with an empty disk. */
  removedPhones: string[];
  /** Whether "start with Windows" got its on-by-default value, which is only done once. */
  autoStartInitialized: boolean;
}

const DEFAULTS: StoredSettings = {
  serverUrl: __DEFAULT_RELAY_URL__,
  localEnabled: true,
  localPort: 3002,
  internetCredential: null,
  removedPhones: [],
  autoStartInitialized: false,
};

const MAX_REMEMBERED_REMOVALS = 200;

export interface InternetCredential {
  desktopId: string;
  token: string;
}

export class SettingsStore {
  private data: StoredSettings;
  private readonly filePath = path.join(app.getPath('userData'), 'settings.json');

  /** Must be constructed after the app is ready, when safeStorage becomes usable. */
  constructor() {
    this.data = { ...DEFAULTS };
    try {
      this.data = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[settings] Could not read settings, using defaults:', (err as Error).message);
      }
    }
    const resolved = resolveServerUrl(this.data.serverUrl, __DEFAULT_RELAY_URL__);
    if (resolved !== this.data.serverUrl) this.serverUrl = resolved;
  }

  get serverUrl(): string {
    return this.data.serverUrl;
  }

  /** Changing relays discards the credential, which is only valid on the relay that issued it. */
  set serverUrl(url: string) {
    if (url === this.data.serverUrl) return;
    this.data.serverUrl = url;
    this.data.internetCredential = null;
    this.save();
  }

  get localEnabled(): boolean {
    return this.data.localEnabled;
  }

  set localEnabled(enabled: boolean) {
    this.data.localEnabled = enabled;
    this.save();
  }

  get localPort(): number {
    return this.data.localPort;
  }

  set localPort(port: number) {
    this.data.localPort = port;
    this.save();
  }

  get removedPhones(): string[] {
    return this.data.removedPhones;
  }

  addRemovedPhone(phoneId: string): void {
    this.data.removedPhones = [...this.data.removedPhones, phoneId].slice(-MAX_REMEMBERED_REMOVALS);
    this.save();
  }

  /** True the first time it is called on this install. */
  claimAutoStartInitialization(): boolean {
    if (this.data.autoStartInitialized) return false;
    this.data.autoStartInitialized = true;
    this.save();
    return true;
  }

  getCredential(): InternetCredential | null {
    const stored = this.data.internetCredential;
    if (!stored) return null;
    try {
      return { desktopId: stored.desktopId, token: safeStorage.decryptString(Buffer.from(stored.encryptedToken, 'base64')) };
    } catch {
      // Encrypted by another Windows user, or the profile moved: registering again is the recovery.
      return null;
    }
  }

  setCredential(credential: InternetCredential | null): void {
    if (credential && !safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows could not provide secure storage for the relay credential.');
    }
    this.data.internetCredential = credential && {
      desktopId: credential.desktopId,
      encryptedToken: safeStorage.encryptString(credential.token).toString('base64'),
    };
    this.save();
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(this.data, null, 2));
      fs.renameSync(temp, this.filePath);
    } catch (err) {
      console.error('[settings] Failed to save:', (err as Error).message);
    }
  }
}
