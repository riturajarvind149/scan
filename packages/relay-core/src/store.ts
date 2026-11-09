import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ADMIN_SESSION_MS,
  INVITE_VALID_MS,
  MAX_DEVICE_NAME_LENGTH,
  MAX_LAPTOPS,
  MAX_PHONES_PER_DESKTOP,
  PAIRING_CODE_EXPIRY_MS,
  PAIRING_CODE_LENGTH,
  type ClientRole,
  type InviteSummary,
  type PairingCode,
} from '@qr2win/shared-types';

const SAVE_DEBOUNCE_MS = 500;
const GENERATED_SECRET_BYTES = 32;
const MAX_REVOKED = 5000;
/** How stale a last-seen time may get before it alone is worth writing to storage. */
const LAST_SEEN_SAVE_INTERVAL_MS = 60 * 60 * 1000;
/** Records unused for this long are forgotten. Their credentials still work and recreate them. */
const STALE_AFTER_MS = 180 * 24 * 60 * 60 * 1000;

export interface PhoneRecord {
  id: string;
  desktopId: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface LaptopRecord {
  id: string;
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
  version: 3;
  /** Only present when the secret was generated here rather than supplied by the operator. */
  secret?: string;
  desktops: DesktopRecord[];
  phones: PhoneRecord[];
  revokedPhones: string[];
  laptops: LaptopRecord[];
  revokedLaptops: string[];
  inviteVersion: number;
  invite: { version: number; expiresAt: number } | null;
  scansPaused: boolean;
}

type TokenClaims =
  /** A desktop. `l` and `n` identify one laptop on a shared relay; older credentials lack them. */
  | { r: 'd'; d: string; l?: string; n?: string; c?: number }
  | { r: 'p'; d: string; p: string; n: string; c: number }
  | { r: 'i'; v: number; e: number }
  | { r: 'a'; e: number };

export type Identity =
  | { role: Extract<ClientRole, 'desktop'>; desktopId: string; laptopId?: string }
  | { role: Extract<ClientRole, 'phone'>; desktopId: string; phoneId: string };

/** Off-machine storage for the records, for hosts whose own disk does not survive a restart. */
export interface RemoteStorage {
  load(): Promise<string | null>;
  save(snapshot: string): Promise<void>;
}

export interface StoreOptions {
  remote?: RemoteStorage;
  /** A shared relay: every laptop is on the one account, joining by invite. */
  sharedAccount?: boolean;
}

/**
 * Holds desktops, phones, laptops, invites and live pairing codes.
 *
 * Credentials are signed with the relay's secret rather than looked up, so they keep working when
 * the relay restarts with an empty disk, as free hosting does. Nothing that could be replayed is
 * written to storage unless the relay generated its own secret. The role of a connection comes from
 * the signed credential; clients cannot claim one.
 */
export class PairingStore {
  private desktops = new Map<string, DesktopRecord>();
  private phones = new Map<string, PhoneRecord>();
  private laptops = new Map<string, LaptopRecord>();
  private revokedPhones = new Set<string>();
  private revokedLaptops = new Set<string>();
  private inviteVersion = 0;
  private invite: { version: number; expiresAt: number } | null = null;
  private paused = false;
  private codes = new Map<string, { desktopId: string; expiresAt: number }>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private secret: string;
  private readonly secretSupplied: boolean;
  private readonly remote?: RemoteStorage;
  private readonly sharedAccount: boolean;
  private remoteWrites: Promise<void> = Promise.resolve();

  /**
   * @param dataFile JSON file to persist records in; omit to keep them in memory only.
   * @param secret Signing secret. Without one, a secret is generated and kept in the data file.
   */
  constructor(
    private readonly dataFile?: string,
    secret?: string,
    options: StoreOptions = {},
  ) {
    this.secretSupplied = !!secret;
    this.secret = secret ?? '';
    this.remote = options.remote;
    this.sharedAccount = options.sharedAccount ?? false;
    if (dataFile) this.loadFile(dataFile);
    if (!this.secret) {
      this.secret = crypto.randomBytes(GENERATED_SECRET_BYTES).toString('hex');
      this.scheduleSave();
    }
  }

  /** Reads records from remote storage. Call once, before accepting connections. */
  async restore(): Promise<void> {
    if (!this.remote) return;
    const saved = await this.remote.load();
    if (saved) this.apply(JSON.parse(saved) as Partial<Snapshot>);
  }

  get storageKind(): 'external' | 'local-disk' {
    return this.remote ? 'external' : 'local-disk';
  }

  /** The one account of a shared relay. Derived from the secret, so it survives an empty disk. */
  get accountId(): string {
    return crypto.createHmac('sha256', this.secret).update('account').digest('base64url').slice(0, 24);
  }

  get scansPaused(): boolean {
    return this.paused;
  }

  set scansPaused(paused: boolean) {
    this.paused = paused;
    this.scheduleSave();
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

  /** Issues a phone pairing code for the desktop, replacing any it still has outstanding. */
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

  /** Exchanges a phone code for a phone credential. The code is single use. */
  redeemCode(code: string, deviceName: string): { token: string; phone: PhoneRecord } | null {
    const entry = this.codes.get(code);
    if (!entry) return null;
    this.codes.delete(code);
    if (entry.expiresAt <= Date.now() || !this.desktops.has(entry.desktopId)) return null;
    if (this.listPhones(entry.desktopId).length >= MAX_PHONES_PER_DESKTOP) return null;

    const now = Date.now();
    const phone: PhoneRecord = {
      id: crypto.randomUUID(),
      desktopId: entry.desktopId,
      name: sanitizeName(deviceName, 'Phone'),
      createdAt: now,
      lastSeenAt: now,
    };
    this.phones.set(phone.id, phone);
    this.scheduleSave();
    return { token: this.sign({ r: 'p', d: phone.desktopId, p: phone.id, n: phone.name, c: now }), phone };
  }

  /** Creates the laptop invite link's token, replacing any previous one. */
  createInvite(): InviteSummary {
    this.inviteVersion++;
    this.invite = { version: this.inviteVersion, expiresAt: Date.now() + INVITE_VALID_MS };
    this.scheduleSave();
    return this.getInvite() as InviteSummary;
  }

  getInvite(): InviteSummary | null {
    if (!this.invite || this.invite.expiresAt <= Date.now()) return null;
    return { token: this.sign({ r: 'i', v: this.invite.version, e: this.invite.expiresAt }), expiresAt: this.invite.expiresAt };
  }

  /** Cancels the current invite link. */
  revokeInvite(): void {
    this.inviteVersion++;
    this.invite = null;
    this.scheduleSave();
  }

  isInviteValid(token: unknown): boolean {
    const claims = this.verify(token);
    return claims?.r === 'i' && claims.e > Date.now() && claims.v >= this.inviteVersion;
  }

  /** Adds a laptop to the shared account using an invite link. The link stays valid for more laptops. */
  redeemInvite(token: unknown, laptopName: string): { token: string; laptop: LaptopRecord } | null {
    if (!this.isInviteValid(token) || this.laptops.size >= MAX_LAPTOPS) return null;
    const now = Date.now();
    const laptop: LaptopRecord = { id: crypto.randomUUID(), name: sanitizeName(laptopName, 'Laptop'), createdAt: now, lastSeenAt: now };
    this.laptops.set(laptop.id, laptop);
    this.scheduleSave();
    return { token: this.sign({ r: 'd', d: this.accountId, l: laptop.id, n: laptop.name, c: now }), laptop };
  }

  listLaptops(): LaptopRecord[] {
    return [...this.laptops.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Permanently refuses a laptop's credential. */
  revokeLaptop(laptopId: string): void {
    this.laptops.delete(laptopId);
    addCapped(this.revokedLaptops, laptopId);
    this.scheduleSave();
  }

  createAdminSession(): string {
    return this.sign({ r: 'a', e: Date.now() + ADMIN_SESSION_MS });
  }

  isAdminSession(token: unknown): boolean {
    const claims = this.verify(token);
    return claims?.r === 'a' && claims.e > Date.now();
  }

  authenticate(token: unknown): Identity | null {
    const claims = this.verify(token);
    if (!claims) return null;
    if (claims.r === 'd') return this.authenticateDesktop(claims);
    if (claims.r !== 'p') return null;

    const desktopId = this.sharedAccount ? this.accountId : claims.d;
    if (this.revokedPhones.has(revocationKey(desktopId, claims.p))) return null;
    const now = Date.now();
    this.touchDesktop(desktopId, now);
    const phone = this.phones.get(claims.p);
    if (phone) this.touch(phone, now);
    else {
      this.phones.set(claims.p, { id: claims.p, desktopId, name: claims.n, createdAt: claims.c, lastSeenAt: now });
      this.scheduleSave();
    }
    return { role: 'phone', desktopId, phoneId: claims.p };
  }

  listPhones(desktopId: string): PhoneRecord[] {
    return [...this.phones.values()].filter((phone) => phone.desktopId === desktopId);
  }

  /** Permanently refuses a phone's credential, whether or not this relay has seen it since restarting. */
  revokePhone(desktopId: string, phoneId: string): void {
    const phone = this.phones.get(phoneId);
    if (phone?.desktopId === desktopId) this.phones.delete(phoneId);
    addCapped(this.revokedPhones, revocationKey(desktopId, phoneId));
    this.scheduleSave();
  }

  /** Writes any pending change immediately. Call before shutting down. */
  flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.save();
    }
    return this.remoteWrites;
  }

  private authenticateDesktop(claims: Extract<TokenClaims, { r: 'd' }>): Identity | null {
    const now = Date.now();
    if (!this.sharedAccount) {
      this.touchDesktop(claims.d, now);
      return { role: 'desktop', desktopId: claims.d };
    }
    // A credential from before invites has no laptop id, so its account id serves as one.
    const laptopId = claims.l ?? claims.d;
    if (this.revokedLaptops.has(laptopId)) return null;
    const laptop = this.laptops.get(laptopId);
    if (laptop) this.touch(laptop, now);
    else {
      this.laptops.set(laptopId, { id: laptopId, name: claims.n ?? 'Laptop', createdAt: claims.c ?? now, lastSeenAt: now });
      this.scheduleSave();
    }
    return { role: 'desktop', desktopId: this.accountId, laptopId };
  }

  private touchDesktop(desktopId: string, now: number): void {
    const desktop = this.desktops.get(desktopId);
    if (desktop) this.touch(desktop, now);
    else {
      this.desktops.set(desktopId, { id: desktopId, createdAt: now, lastSeenAt: now });
      this.scheduleSave();
    }
  }

  /** Updates a last-seen time, saving only occasionally so routine reconnects don't spend storage writes. */
  private touch(record: { lastSeenAt: number }, now: number): void {
    const stale = now - record.lastSeenAt > LAST_SEEN_SAVE_INTERVAL_MS;
    record.lastSeenAt = now;
    if (stale) this.scheduleSave();
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

  private loadFile(dataFile: string): void {
    try {
      this.apply(JSON.parse(fs.readFileSync(dataFile, 'utf-8')) as Partial<Snapshot>);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[relay] Could not read ${dataFile}; starting with no pairings:`, (err as Error).message);
      }
    }
  }

  private apply(snapshot: Partial<Snapshot>): void {
    if (!this.secret && snapshot.secret) this.secret = snapshot.secret;
    const cutoff = Date.now() - STALE_AFTER_MS;
    for (const desktop of snapshot.desktops ?? []) {
      if (desktop.lastSeenAt >= cutoff) this.desktops.set(desktop.id, desktop);
    }
    for (const phone of snapshot.phones ?? []) {
      if (phone.lastSeenAt >= cutoff && this.desktops.has(phone.desktopId)) this.phones.set(phone.id, phone);
    }
    for (const laptop of snapshot.laptops ?? []) {
      if (laptop.lastSeenAt >= cutoff) this.laptops.set(laptop.id, laptop);
    }
    this.revokedPhones = new Set(snapshot.revokedPhones ?? []);
    this.revokedLaptops = new Set(snapshot.revokedLaptops ?? []);
    this.inviteVersion = snapshot.inviteVersion ?? 0;
    this.invite = snapshot.invite ?? null;
    this.paused = snapshot.scansPaused ?? false;
  }

  private scheduleSave(): void {
    if ((!this.dataFile && !this.remote) || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  private save(): void {
    const snapshot: Snapshot = {
      version: 3,
      ...(this.secretSupplied ? {} : { secret: this.secret }),
      desktops: [...this.desktops.values()],
      phones: [...this.phones.values()],
      revokedPhones: [...this.revokedPhones],
      laptops: [...this.laptops.values()],
      revokedLaptops: [...this.revokedLaptops],
      inviteVersion: this.inviteVersion,
      invite: this.invite,
      scansPaused: this.paused,
    };
    const json = JSON.stringify(snapshot);
    if (this.dataFile) {
      try {
        fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
        const temp = `${this.dataFile}.${process.pid}.tmp`;
        fs.writeFileSync(temp, json, { mode: 0o600 });
        fs.renameSync(temp, this.dataFile);
      } catch (err) {
        console.error('[relay] Failed to persist records:', (err as Error).message);
      }
    }
    if (this.remote) {
      // One at a time, so an older snapshot can never land after a newer one.
      const remote = this.remote;
      this.remoteWrites = this.remoteWrites
        .then(() => remote.save(json))
        .catch((err: Error) => console.error('[relay] Failed to save to remote storage:', err.message));
    }
  }
}

function addCapped(set: Set<string>, value: string): void {
  set.add(value);
  if (set.size > MAX_REVOKED) set.delete(set.values().next().value as string);
}

function revocationKey(desktopId: string, phoneId: string): string {
  return `${desktopId}:${phoneId}`;
}

function sanitizeName(name: string, fallback: string): string {
  const clean = String(name ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, MAX_DEVICE_NAME_LENGTH);
  return clean || fallback;
}
