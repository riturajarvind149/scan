import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';

interface Settings {
  serverUrl: string;
  token: string;
  desktopDeviceId: string;
  startWithWindows: boolean;
  localServerEnabled: boolean;
}

const DEFAULTS: Settings = {
  serverUrl: 'http://localhost:3001',
  token: '',
  desktopDeviceId: '',
  startWithWindows: false,
  localServerEnabled: true,
};

export class SettingsStore {
  private data: Settings;
  private filePath: string;

  constructor() {
    // Use app.getPath for safe data storage
    const userDataPath = app.getPath('userData');
    this.filePath = path.join(userDataPath, 'settings.json');

    this.data = { ...DEFAULTS };

    // Load from disk
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        this.data = { ...DEFAULTS, ...parsed };
      }
    } catch {
      // Use defaults
    }

    // Generate device ID if not set
    if (!this.data.desktopDeviceId) {
      this.data.desktopDeviceId = crypto.randomUUID();
      this.save();
    }
  }

  getAll(): Omit<Settings, 'token'> & { hasToken: boolean } {
    return {
      serverUrl: this.data.serverUrl,
      desktopDeviceId: this.data.desktopDeviceId,
      startWithWindows: this.data.startWithWindows,
      localServerEnabled: this.data.localServerEnabled,
      hasToken: !!this.data.token,
    };
  }

  setAll(partial: Partial<Settings>): void {
    if (partial.serverUrl !== undefined) this.data.serverUrl = partial.serverUrl;
    if (partial.token !== undefined) this.data.token = partial.token;
    if (partial.startWithWindows !== undefined) this.data.startWithWindows = partial.startWithWindows;
    if (partial.localServerEnabled !== undefined) this.data.localServerEnabled = partial.localServerEnabled;
    this.save();
  }

  getServerUrl(): string {
    return this.data.serverUrl;
  }

  getToken(): string {
    return this.data.token;
  }

  getDesktopDeviceId(): string {
    return this.data.desktopDeviceId;
  }

  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.error('[settings] Failed to save:', err);
    }
  }
}

