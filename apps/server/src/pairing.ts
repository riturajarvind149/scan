import crypto from 'node:crypto';
import {
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_EXPIRY_MS,
  TOKEN_LENGTH,
  RATE_LIMIT_SCANS_PER_MINUTE,
  type PairingCode,
} from '@qr2win/shared-types';

// ─── Pairing code store ────────────────────────────────────────────────
interface PendingPairing {
  code: string;
  desktopDeviceId: string;
  expiresAt: number;
}

// ─── Paired device ─────────────────────────────────────────────────────
export interface PairedDevice {
  token: string;
  desktopDeviceId: string;
  phoneDeviceId: string;
  phoneName: string;
  createdAt: number;
}

// ─── Rate limit entry ──────────────────────────────────────────────────
interface RateLimitEntry {
  count: number;
  windowStart: number;
}

export class PairingStore {
  private pendingCodes = new Map<string, PendingPairing>();
  private pairedDevices = new Map<string, PairedDevice>(); // keyed by token
  private rateLimits = new Map<string, RateLimitEntry>();  // keyed by token

  /** Generate a short-lived numeric pairing code for a desktop device. */
  generateCode(desktopDeviceId: string): PairingCode {
    // Clean expired
    this.cleanExpired();

    const code = this.randomDigits(PAIRING_CODE_LENGTH);
    const expiresAt = Date.now() + PAIRING_CODE_EXPIRY_MS;

    this.pendingCodes.set(code, { code, desktopDeviceId, expiresAt });

    return { code, expiresAt };
  }

  /** Attempt to pair a phone with a desktop using the pairing code.
   *  Returns the revocable token on success. */
  pair(code: string, phoneName: string): { token: string; desktopDeviceId: string } | null {
    this.cleanExpired();

    const pending = this.pendingCodes.get(code);
    if (!pending) return null;
    if (Date.now() > pending.expiresAt) {
      this.pendingCodes.delete(code);
      return null;
    }

    const token = crypto.randomBytes(TOKEN_LENGTH).toString('hex');
    const phoneDeviceId = crypto.randomUUID();

    this.pairedDevices.set(token, {
      token,
      desktopDeviceId: pending.desktopDeviceId,
      phoneDeviceId,
      phoneName,
      createdAt: Date.now(),
    });

    // Consume the code
    this.pendingCodes.delete(code);

    return { token, desktopDeviceId: pending.desktopDeviceId };
  }

  /** Validate token and return the paired device info. */
  validate(token: string): PairedDevice | null {
    return this.pairedDevices.get(token) ?? null;
  }

  /** Revoke a token. */
  revoke(token: string): boolean {
    return this.pairedDevices.delete(token);
  }

  /** Get all paired devices for a desktop. */
  getDevicesForDesktop(desktopDeviceId: string): PairedDevice[] {
    return [...this.pairedDevices.values()].filter(
      (d) => d.desktopDeviceId === desktopDeviceId
    );
  }

  /** Rate limit check – returns true if allowed. */
  checkRateLimit(token: string): boolean {
    const now = Date.now();
    const entry = this.rateLimits.get(token);

    if (!entry || now - entry.windowStart > 60_000) {
      this.rateLimits.set(token, { count: 1, windowStart: now });
      return true;
    }

    if (entry.count >= RATE_LIMIT_SCANS_PER_MINUTE) {
      return false;
    }

    entry.count++;
    return true;
  }

  /** Cleanup for testing or shutdown. */
  clear(): void {
    this.pendingCodes.clear();
    this.pairedDevices.clear();
    this.rateLimits.clear();
  }

  private cleanExpired(): void {
    const now = Date.now();
    for (const [code, pending] of this.pendingCodes) {
      if (now > pending.expiresAt) {
        this.pendingCodes.delete(code);
      }
    }
  }

  private randomDigits(n: number): string {
    let result = '';
    const bytes = crypto.randomBytes(n);
    for (let i = 0; i < n; i++) {
      result += (bytes[i] % 10).toString();
    }
    return result;
  }
}

