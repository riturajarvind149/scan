import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_DEVICE_NAME_LENGTH,
  MAX_PHONES_PER_DESKTOP,
  PAIRING_CODE_EXPIRY_MS,
  PAIRING_CODE_LENGTH,
  type ClientRole,
  type PairingCode,
} from '@qr2win/shared-types';

const TOKEN_BYTES = 32;
const SAVE_DEBOUNCE_MS = 500;
/** Credentials unused for this long are forgotten, so an abandoned relay does not grow forever. */
const STALE_AFTER_MS = 180 * 24 * 60 * 60 * 1000;

export interface PhoneRecord {
  id: string;
  desktopId: string;
  tokenHash: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
}

interface DesktopRecord {
  id: string;
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
}

interface Snapshot {
  version: 1;
  desktops: DesktopRecord[];
  phones: PhoneRecord[];
}

export type Identity =
  | { role: Extract<ClientRole, 'desktop'>; desktopId: string }
  | { role: Extract<ClientRole, 'phone'>; desktopId: string; phoneId: string };

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function newToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * Holds desktops, paired phones and live pairing codes.
 *
 * Only SHA-256 hashes of tokens are kept, so a leaked data file cannot be replayed. The role of a
 * connection comes from the token it presents; clients cannot claim one.
 */
export class PairingStore {
  private desktops = new Map<string, DesktopRecord>();
  private phones = new Map<string, PhoneRecord>();
  private desktopIdByHash = new Map<string, string>();
  private phoneIdByHash = new Map<string, string>();
  private codes = new Map<string, { desktopId: string; expiresAt: number }>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  /** @param dataFile JSON file to persist pairings in; omit to keep them in memory only. */
  constructor(private readonly dataFile?: string) {
    if (dataFile) this.load(dataFile);
  }

  registerDesktop(): { desktopId: string; token: string } {
    const token = newToken();
    const now = Date.now();
    const record: DesktopRecord = { id: crypto.randomUUID(), tokenHash: hashToken(token), createdAt: now, lastSeenAt: now };
    this.desktops.set(record.id, record);
    this.desktopIdByHash.set(record.tokenHash, record.id);
    this.scheduleSave();
    return { desktopId: record.id, token };
  }

  /** Creates the single desktop of an embedded local relay if needed and returns its id. */
  ensureLocalDesktop(): string {
    const [existing] = this.desktops.keys();
    if (existing) return existing;
    return this.registerDesktop().desktopId;
  }

  /** Issues a code for the desktop, replacing any code it still has outstanding. */
  issueCode(desktopId: string): PairingCode {
    if (!this.desktops.has(desktopId)) throw new Error('Unknown desktop');
    const now = Date.now();
    for (const [code, entry] of this.codes) {
      if (entry.desktopId === desktopId || entry.expiresAt <= now) this.codes.delete(code);
    }
    let code: string;
    do {
      code = crypto.randomInt(0, 10 ** PAIRING_CODE_LENGTH).toString().padStart(PAIRING_CODE_LENGTH, '0');
    } while (this.codes.has(code));
    const expiresAt = now + PAIRING_CODE_EXPIRY_MS;
    this.codes.set(code, { desktopId, expiresAt });
    return { code, expiresAt };
  }

  /** Exchanges a pairing code for a phone credential. The code is single use. */
  redeemCode(code: string, deviceName: string): { token: string; phone: PhoneRecord } | null {
    const entry = this.codes.get(code);
    if (!entry) return null;
    this.codes.delete(code);
    const now = Date.now();
    if (entry.expiresAt <= now || !this.desktops.has(entry.desktopId)) return null;
    if (this.listPhones(entry.desktopId).length >= MAX_PHONES_PER_DESKTOP) return null;

    const token = newToken();
    const phone: PhoneRecord = {
      id: crypto.randomUUID(),
      desktopId: entry.desktopId,
      tokenHash: hashToken(token),
      name: sanitizeName(deviceName),
      createdAt: now,
      lastSeenAt: now,
    };
    this.phones.set(phone.id, phone);
    this.phoneIdByHash.set(phone.tokenHash, phone.id);
    this.scheduleSave();
    return { token, phone };
  }

  authenticate(token: unknown): Identity | null {
    if (typeof token !== 'string' || token.length === 0 || token.length > 256) return null;
    const hash = hashToken(token);
    const now = Date.now();

    const desktopId = this.desktopIdByHash.get(hash);
    const desktop = desktopId ? this.desktops.get(desktopId) : undefined;
    if (desktop) {
      desktop.lastSeenAt = now;
      this.scheduleSave();
      return { role: 'desktop', desktopId: desktop.id };
    }

    const phoneId = this.phoneIdByHash.get(hash);
    const phone = phoneId ? this.phones.get(phoneId) : undefined;
    if (phone) {
      phone.lastSeenAt = now;
      this.scheduleSave();
      return { role: 'phone', desktopId: phone.desktopId, phoneId: phone.id };
    }
    return null;
  }

  listPhones(desktopId: string): PhoneRecord[] {
    return [...this.phones.values()].filter((phone) => phone.desktopId === desktopId);
  }

  getPhone(phoneId: string): PhoneRecord | null {
    return this.phones.get(phoneId) ?? null;
  }

  removePhone(phoneId: string): boolean {
    const phone = this.phones.get(phoneId);
    if (!phone) return false;
    this.phones.delete(phoneId);
    this.phoneIdByHash.delete(phone.tokenHash);
    this.scheduleSave();
    return true;
  }

  /** Writes any pending change to disk immediately. Call before shutting down. */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.save();
    }
  }

  private load(dataFile: string): void {
    let snapshot: Snapshot;
    try {
      snapshot = JSON.parse(fs.readFileSync(dataFile, 'utf-8')) as Snapshot;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[relay] Could not read ${dataFile}; starting with no pairings:`, (err as Error).message);
      }
      return;
    }
    const cutoff = Date.now() - STALE_AFTER_MS;
    for (const desktop of snapshot.desktops ?? []) {
      if (desktop.lastSeenAt < cutoff) continue;
      this.desktops.set(desktop.id, desktop);
      this.desktopIdByHash.set(desktop.tokenHash, desktop.id);
    }
    for (const phone of snapshot.phones ?? []) {
      if (phone.lastSeenAt < cutoff || !this.desktops.has(phone.desktopId)) continue;
      this.phones.set(phone.id, phone);
      this.phoneIdByHash.set(phone.tokenHash, phone.id);
    }
  }

  private scheduleSave(): void {
    if (!this.dataFile || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  private save(): void {
    if (!this.dataFile) return;
    const snapshot: Snapshot = {
      version: 1,
      desktops: [...this.desktops.values()],
      phones: [...this.phones.values()],
    };
    try {
      fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
      const temp = `${this.dataFile}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(snapshot), { mode: 0o600 });
      fs.renameSync(temp, this.dataFile);
    } catch (err) {
      console.error('[relay] Failed to persist pairings:', (err as Error).message);
    }
  }
}

function sanitizeName(name: string): string {
  const clean = String(name ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, MAX_DEVICE_NAME_LENGTH);
  return clean || 'Phone';
}
