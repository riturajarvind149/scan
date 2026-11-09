import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  LAPTOP_CODE_LENGTH,
  MAX_DEVICE_NAME_LENGTH,
  MAX_PHONES_PER_DESKTOP,
  PAIRING_CODE_EXPIRY_MS,
  PAIRING_CODE_LENGTH,
  type ClientRole,
  type PairingCode,
  type PairingCodeKind,
} from '@qr2win/shared-types';

const SAVE_DEBOUNCE_MS = 500;
const GENERATED_SECRET_BYTES = 32;
const MAX_REVOKED_PHONES = 5000;
/** Records unused for this long are forgotten. Their credentials still work and recreate them. */
const STALE_AFTER_MS = 180 * 24 * 60 * 60 * 1000;

export interface PhoneRecord {
  id: string;
  desktopId: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
}

interface DesktopRecord {
  id: string;
  createdAt: number;
  lastSeenAt: number;
}

interface Snapshot {
  version: 2;
  /** Only present when the secret was generated here rather than supplied by the operator. */
  secret?: string;
  desktops: DesktopRecord[];
  phones: PhoneRecord[];
  revokedPhones: string[];
}

type TokenClaims =
  | { r: 'd'; d: string }
  | { r: 'p'; d: string; p: string; n: string; c: number };

export type Identity =
  | { role: Extract<ClientRole, 'desktop'>; desktopId: string }
  | { role: Extract<ClientRole, 'phone'>; desktopId: string; phoneId: string };

/**
 * Holds desktops, paired phones and live pairing codes.
 *
 * Credentials are signed with the relay's secret rather than looked up, so they keep working when
 * the relay restarts with an empty disk, as free hosting does. Nothing that could be replayed is
 * written to the data file unless the relay generated its own secret. The role of a connection comes
 * from the signed credential; clients cannot claim one.
 */
export class PairingStore {
  private desktops = new Map<string, DesktopRecord>();
  private phones = new Map<string, PhoneRecord>();
  private revokedPhones = new Set<string>();
  private codes = new Map<string, { desktopId: string; expiresAt: number; kind: PairingCodeKind }>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private secret: string;
  private readonly secretSupplied: boolean;

  /**
   * @param dataFile JSON file to persist records in; omit to keep them in memory only.
   * @param secret Signing secret. Without one, a secret is generated and kept in the data file.
   */
  constructor(
    private readonly dataFile?: string,
    secret?: string,
  ) {
    this.secretSupplied = !!secret;
    this.secret = secret ?? '';
    if (dataFile) this.load(dataFile);
    if (!this.secret) {
      this.secret = crypto.randomBytes(GENERATED_SECRET_BYTES).toString('hex');
      this.scheduleSave();
    }
  }

  registerDesktop(): { desktopId: string; token: string } {
    const now = Date.now();
    const desktopId = crypto.randomUUID();
    this.desktops.set(desktopId, { id: desktopId, createdAt: now, lastSeenAt: now });
    this.scheduleSave();
    return { desktopId, token: this.sign({ r: 'd', d: desktopId }) };
  }

  /** Creates the single desktop of an embedded local relay if needed and returns its id. */
  ensureLocalDesktop(): string {
    const [existing] = this.desktops.keys();
    if (existing) return existing;
    return this.registerDesktop().desktopId;
  }

  /** Issues a code for the desktop, replacing any outstanding code of the same kind. */
  issueCode(desktopId: string, kind: PairingCodeKind = 'phone'): PairingCode {
    if (!this.desktops.has(desktopId)) throw new Error('Unknown desktop');
    const now = Date.now();
    for (const [code, entry] of this.codes) {
      if ((entry.desktopId === desktopId && entry.kind === kind) || entry.expiresAt <= now) this.codes.delete(code);
    }
    // A laptop code can read every future scan, so it is longer than a phone code.
    const length = kind === 'laptop' ? LAPTOP_CODE_LENGTH : PAIRING_CODE_LENGTH;
    let code: string;
    do {
      code = crypto.randomInt(0, 10 ** length).toString().padStart(length, '0');
    } while (this.codes.has(code));
    const expiresAt = now + PAIRING_CODE_EXPIRY_MS;
    this.codes.set(code, { desktopId, expiresAt, kind });
    return { code, expiresAt };
  }

  /** Exchanges a phone code for a phone credential. The code is single use. */
  redeemCode(code: string, deviceName: string): { token: string; phone: PhoneRecord } | null {
    const desktopId = this.takeCode(code, 'phone');
    if (!desktopId || this.listPhones(desktopId).length >= MAX_PHONES_PER_DESKTOP) return null;

    const now = Date.now();
    const phone: PhoneRecord = {
      id: crypto.randomUUID(),
      desktopId,
      name: sanitizeName(deviceName),
      createdAt: now,
      lastSeenAt: now,
    };
    this.phones.set(phone.id, phone);
    this.scheduleSave();
    return { token: this.sign({ r: 'p', d: desktopId, p: phone.id, n: phone.name, c: now }), phone };
  }

  /** Exchanges a laptop code for a credential on the same account. The code is single use. */
  redeemLaptopCode(code: string): { token: string; desktopId: string } | null {
    const desktopId = this.takeCode(code, 'laptop');
    return desktopId ? { token: this.sign({ r: 'd', d: desktopId }), desktopId } : null;
  }

  authenticate(token: unknown): Identity | null {
    const claims = this.verify(token);
    if (!claims) return null;
    const now = Date.now();

    if (claims.r === 'd') {
      const desktop = this.desktops.get(claims.d);
      if (desktop) desktop.lastSeenAt = now;
      else this.desktops.set(claims.d, { id: claims.d, createdAt: now, lastSeenAt: now });
      this.scheduleSave();
      return { role: 'desktop', desktopId: claims.d };
    }

    if (this.revokedPhones.has(revocationKey(claims.d, claims.p))) return null;
    if (!this.desktops.has(claims.d)) this.desktops.set(claims.d, { id: claims.d, createdAt: now, lastSeenAt: now });
    const phone = this.phones.get(claims.p);
    if (phone) phone.lastSeenAt = now;
    else this.phones.set(claims.p, { id: claims.p, desktopId: claims.d, name: claims.n, createdAt: claims.c, lastSeenAt: now });
    this.scheduleSave();
    return { role: 'phone', desktopId: claims.d, phoneId: claims.p };
  }

  listPhones(desktopId: string): PhoneRecord[] {
    return [...this.phones.values()].filter((phone) => phone.desktopId === desktopId);
  }

  getPhone(phoneId: string): PhoneRecord | null {
    return this.phones.get(phoneId) ?? null;
  }

  /** Permanently refuses a phone's credential, whether or not this relay has seen it since restarting. */
  revokePhone(desktopId: string, phoneId: string): void {
    const phone = this.phones.get(phoneId);
    if (phone?.desktopId === desktopId) this.phones.delete(phoneId);
    this.revokedPhones.add(revocationKey(desktopId, phoneId));
    if (this.revokedPhones.size > MAX_REVOKED_PHONES) {
      this.revokedPhones.delete(this.revokedPhones.values().next().value as string);
    }
    this.scheduleSave();
  }

  /** Writes any pending change to disk immediately. Call before shutting down. */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.save();
    }
  }

  private takeCode(code: string, kind: PairingCodeKind): string | null {
    const entry = this.codes.get(code);
    if (!entry || entry.kind !== kind) return null;
    this.codes.delete(code);
    return entry.expiresAt > Date.now() && this.desktops.has(entry.desktopId) ? entry.desktopId : null;
  }

  private sign(claims: TokenClaims): string {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${payload}.${this.signature(payload)}`;
  }

  private signature(payload: string): string {
    return crypto.createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  private verify(token: unknown): TokenClaims | null {
    if (typeof token !== 'string' || token.length === 0 || token.length > 1024) return null;
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra !== undefined) return null;
    const expected = Buffer.from(this.signature(payload));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
    try {
      return JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as TokenClaims;
    } catch {
      return null;
    }
  }

  private load(dataFile: string): void {
    let snapshot: Partial<Snapshot>;
    try {
      snapshot = JSON.parse(fs.readFileSync(dataFile, 'utf-8')) as Partial<Snapshot>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[relay] Could not read ${dataFile}; starting with no pairings:`, (err as Error).message);
      }
      return;
    }
    if (!this.secret && snapshot.secret) this.secret = snapshot.secret;
    const cutoff = Date.now() - STALE_AFTER_MS;
    for (const desktop of snapshot.desktops ?? []) {
      if (desktop.lastSeenAt >= cutoff) this.desktops.set(desktop.id, desktop);
    }
    for (const phone of snapshot.phones ?? []) {
      if (phone.lastSeenAt >= cutoff && this.desktops.has(phone.desktopId)) this.phones.set(phone.id, phone);
    }
    this.revokedPhones = new Set(snapshot.revokedPhones ?? []);
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
      version: 2,
      ...(this.secretSupplied ? {} : { secret: this.secret }),
      desktops: [...this.desktops.values()],
      phones: [...this.phones.values()],
      revokedPhones: [...this.revokedPhones],
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

function revocationKey(desktopId: string, phoneId: string): string {
  return `${desktopId}:${phoneId}`;
}

function sanitizeName(name: string): string {
  const clean = String(name ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, MAX_DEVICE_NAME_LENGTH);
  return clean || 'Phone';
}
