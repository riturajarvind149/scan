import crypto from 'node:crypto';
import {
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_EXPIRY_MS,
  TOKEN_LENGTH,
  type PairingCode,
} from '@qr2win/shared-types';

interface PendingPairing {
  code: string;
  desktopDeviceId: string;
  expiresAt: number;
}

interface PairedDevice {
  token: string;
  desktopDeviceId: string;
  phoneDeviceId: string;
  phoneName: string;
  createdAt: number;
}

/** Standalone pairing store for the local server (no dependency on the internet server). */
export class PairingStore {
  private pendingCodes = new Map<string, PendingPairing>();
  private pairedDevices = new Map<string, PairedDevice>();
  private latestCode: string | null = null;

  generateCode(desktopDeviceId: string): PairingCode {
    this.cleanExpired();
    const code = this.randomDigits(PAIRING_CODE_LENGTH);
    const expiresAt = Date.now() + PAIRING_CODE_EXPIRY_MS;
    this.pendingCodes.set(code, { code, desktopDeviceId, expiresAt });
    this.latestCode = code;
    return { code, expiresAt };
  }

  pair(code: string, phoneName: string): { token: string; desktopDeviceId: string } | null {
    this.cleanExpired();
    const pending = this.pendingCodes.get(code);
    if (!pending || Date.now() > pending.expiresAt) {
      if (pending) this.pendingCodes.delete(code);
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

    this.pendingCodes.delete(code);
    return { token, desktopDeviceId: pending.desktopDeviceId };
  }

  validate(token: string): PairedDevice | null {
    return this.pairedDevices.get(token) ?? null;
  }

  revoke(token: string): boolean {
    return this.pairedDevices.delete(token);
  }

  getLatestCode(): string | null {
    return this.latestCode;
  }

  clear(): void {
    this.pendingCodes.clear();
    this.pairedDevices.clear();
    this.latestCode = null;
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

