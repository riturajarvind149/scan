import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { isLoopbackUrl, normalizeServerUrl, rankLanAddresses, resolveServerUrl } from './network';

const v4 = (address: string, internal = false) => ({ address, family: 'IPv4', internal }) as NetworkInterfaceInfo;

describe('rankLanAddresses', () => {
  it('prefers real Wi-Fi over virtual adapters and skips unusable addresses', () => {
    const ranked = rankLanAddresses({
      'vEthernet (WSL)': [v4('172.20.0.1')],
      'Loopback Pseudo-Interface 1': [v4('127.0.0.1', true)],
      Ethernet: [v4('169.254.10.10')],
      'Wi-Fi': [v4('192.168.1.42'), { address: 'fe80::1', family: 'IPv6', internal: false } as NetworkInterfaceInfo],
    });
    expect(ranked).toEqual(['192.168.1.42', '172.20.0.1']);
  });
});

describe('normalizeServerUrl', () => {
  it('defaults to https and strips paths', () => {
    expect(normalizeServerUrl(' relay.example.com/some/path ')).toBe('https://relay.example.com');
  });

  it('allows http only on this machine or network', () => {
    expect(normalizeServerUrl('http://localhost:3001')).toBe('http://localhost:3001');
    expect(normalizeServerUrl('http://192.168.1.5:3001')).toBe('http://192.168.1.5:3001');
    expect(() => normalizeServerUrl('http://relay.example.com')).toThrow(/https/);
    expect(() => normalizeServerUrl('http://8.8.8.8')).toThrow(/https/);
  });

  it('rejects other schemes and empty input', () => {
    expect(() => normalizeServerUrl('ftp://x.test')).toThrow();
    expect(() => normalizeServerUrl('   ')).toThrow();
  });
});

describe('resolveServerUrl', () => {
  const builtIn = 'https://relay.example.com';

  it('replaces the default an old version saved', () => {
    expect(resolveServerUrl('http://localhost:3001', builtIn)).toBe(builtIn);
  });

  it('keeps an address the user chose, including turning the relay off', () => {
    expect(resolveServerUrl('https://mine.example.com', builtIn)).toBe('https://mine.example.com');
    expect(resolveServerUrl('http://localhost:4000', builtIn)).toBe('http://localhost:4000');
    expect(resolveServerUrl('', builtIn)).toBe('');
  });

  it('leaves the old address alone in a build with no built-in relay', () => {
    expect(resolveServerUrl('http://localhost:3001', '')).toBe('http://localhost:3001');
  });
});

describe('isLoopbackUrl', () => {
  it('flags addresses a phone cannot reach', () => {
    expect(isLoopbackUrl('http://localhost:3001')).toBe(true);
    expect(isLoopbackUrl('http://127.0.0.1:3001')).toBe(true);
    expect(isLoopbackUrl('https://relay.example.com')).toBe(false);
  });
});
