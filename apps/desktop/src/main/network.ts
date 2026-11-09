import type { NetworkInterfaceInfo } from 'node:os';

/** Adapters that exist on the PC but that a phone on the Wi-Fi network cannot reach. */
const VIRTUAL_ADAPTER = /vethernet|virtualbox|vmware|hyper-v|wsl|docker|loopback|bluetooth|tailscale|zerotier|vpn|tap-/i;
const WIRELESS_ADAPTER = /wi-?fi|wlan|wireless/i;

function isPrivateIpv4(address: string): boolean {
  const [a, b] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Lists addresses a phone could use to reach this PC, most likely first. */
export function rankLanAddresses(interfaces: Record<string, NetworkInterfaceInfo[] | undefined>): string[] {
  const candidates: { address: string; score: number }[] = [];
  for (const [name, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal || info.address.startsWith('169.254.')) continue;
      let score = 0;
      if (WIRELESS_ADAPTER.test(name)) score += 4;
      if (isPrivateIpv4(info.address)) score += 2;
      if (VIRTUAL_ADAPTER.test(name)) score -= 8;
      candidates.push({ address: info.address, score });
    }
  }
  return candidates.sort((a, b) => b.score - a.score).map((candidate) => candidate.address);
}

function isLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || host.startsWith('127.') || /^[\d.]+$/.test(host) && isPrivateIpv4(host);
}

/**
 * Cleans up a relay address typed by the user and returns its origin.
 * Plain http is only allowed for addresses on this machine or network: on the internet it would
 * expose scans and credentials, and browsers would refuse the camera anyway.
 */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Enter the address of your relay server.');
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new Error('That is not a valid address.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('The relay address must start with https://');
  }
  if (url.protocol === 'http:' && !isLocalHost(url.hostname)) {
    throw new Error('Internet relays must use https://');
  }
  return url.origin;
}

/** The address early versions saved automatically, whether or not the user ever chose it. */
const LEGACY_DEFAULT_RELAY = 'http://localhost:3001';

/** The relay to use on startup: a saved leftover default gives way to the one built into this app. */
export function resolveServerUrl(saved: string, builtInDefault: string): string {
  return saved === LEGACY_DEFAULT_RELAY && builtInDefault ? builtInDefault : saved;
}

/** True when a phone elsewhere on the network could not reach this address. */
export function isLoopbackUrl(serverUrl: string): boolean {
  const host = new URL(serverUrl).hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}
