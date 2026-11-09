import type { PairResponseBody, RelayConfig } from '@qr2win/shared-types';

const STORAGE_KEY = 'qr2win.pairing';

export interface Pairing {
  token: string;
  phoneId: string;
}

/** The relay this page talks to. It is its own origin unless the app is hosted separately. */
export const SERVER_ORIGIN: string = (import.meta.env.VITE_SERVER_URL as string | undefined) || window.location.origin;

export const WS_URL = `${SERVER_ORIGIN.replace(/^http/, 'ws')}/ws`;

export async function fetchConfig(): Promise<RelayConfig> {
  const response = await fetch(`${SERVER_ORIGIN}/api/config`);
  if (!response.ok) throw new Error(`Config request failed (${response.status})`);
  return (await response.json()) as RelayConfig;
}

export function loadPairing(): Pairing | null {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Pairing | null;
    return stored?.token && stored.phoneId ? stored : null;
  } catch {
    return null; // private browsing can block storage; the phone then simply pairs again
  }
}

export function savePairing(pairing: Pairing): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pairing));
  } catch {
    // Pairing still works until this tab closes.
  }
}

export function clearPairing(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored.
  }
}

export function suggestDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  return 'Phone';
}

export async function requestPairing(code: string, deviceName: string): Promise<Pairing> {
  let response: Response;
  try {
    response = await fetch(`${SERVER_ORIGIN}/api/pairing/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, deviceName }),
    });
  } catch {
    throw new Error("Couldn't reach your laptop's server. Check your connection and try again.");
  }
  const body = (await response.json().catch(() => null)) as (Partial<PairResponseBody> & { error?: string }) | null;
  if (!response.ok || !body?.token || !body.phoneId) {
    throw new Error(body?.error ?? 'Pairing failed. Generate a new code on your laptop and try again.');
  }
  return { token: body.token, phoneId: body.phoneId };
}

/** Tells the relay to forget this phone. Failure is fine: the laptop can still remove it. */
export async function requestUnpair(token: string): Promise<void> {
  try {
    await fetch(`${SERVER_ORIGIN}/api/pairing/unpair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: '{}',
    });
  } catch {
    // Offline.
  }
}
