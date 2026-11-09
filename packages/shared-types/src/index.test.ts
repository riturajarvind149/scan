import { describe, expect, it } from 'vitest';
import { buildPairingUrl, parseInviteLink, parsePairingHash, parsePairingUrl, validateQrPayload, type QrImagePayload } from './index.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
const valid: QrImagePayload = {
  type: 'qr-image',
  scanId: 'abcd-1234',
  timestamp: 1,
  mimeType: 'image/png',
  width: 10,
  height: 10,
  imageBase64: PNG,
  decodedText: 'hello',
};

describe('validateQrPayload', () => {
  it('accepts a good scan', () => {
    expect(validateQrPayload(valid)).toBeNull();
  });

  it('accepts a scan with an enhanced copy', () => {
    expect(validateQrPayload({ ...valid, enhanced: { mimeType: 'image/png', width: 10, height: 10, imageBase64: PNG, method: 'squared up' } })).toBeNull();
  });

  it.each([
    ['non-object', null],
    ['bad scan id', { ...valid, scanId: '../../etc' }],
    ['fractional size', { ...valid, width: 1.5 }],
    ['huge size', { ...valid, height: 99999 }],
    ['non-string text', { ...valid, decodedText: 5 }],
    ['oversized text', { ...valid, decodedText: 'x'.repeat(9000) }],
    ['bad mime', { ...valid, mimeType: 'text/html' }],
    ['bad base64', { ...valid, imageBase64: 'not base64!' }],
    ['mime mismatch', { ...valid, mimeType: 'image/jpeg' }],
    ['non-object enhanced image', { ...valid, enhanced: 'x' }],
    ['enhanced image without a description', { ...valid, enhanced: { mimeType: 'image/png', width: 1, height: 1, imageBase64: PNG } }],
    ['enhanced image that is not an image', { ...valid, enhanced: { mimeType: 'image/png', width: 1, height: 1, imageBase64: 'PGh0bWw+AAAAAAAA', method: 'x' } }],
  ])('rejects %s', (_name, payload) => {
    expect(validateQrPayload(payload)).not.toBeNull();
  });
});

describe('invite links', () => {
  const token = 'abcdefghijklmnopqrstuvwxyz.ABCDEFG-_';
  const link = `https://relay.example.com/join/${token}`;

  it('reads the web link and the link that opens the app', () => {
    expect(parseInviteLink(link)).toEqual({ origin: 'https://relay.example.com', token });
    expect(parseInviteLink(`qr2win://join?url=${encodeURIComponent(link)}`)).toEqual({ origin: 'https://relay.example.com', token });
  });

  it.each(['hello', 'https://relay.example.com/', 'https://relay.example.com/join/short', 'ftp://x.test/join/abcdefghijklmnopqrstuvwxyz', 'qr2win://join?url=javascript:alert(1)', 'qr2win://join'])(
    'rejects %s',
    (text) => {
      expect(parseInviteLink(text)).toBeNull();
    },
  );
});

describe('pairing links', () => {
  it('round-trips and tolerates a trailing slash on the base', () => {
    const url = buildPairingUrl('https://relay.example.com/', '012345');
    expect(url).toBe('https://relay.example.com/#pair=012345');
    expect(parsePairingUrl(url)).toEqual({ origin: 'https://relay.example.com', code: '012345' });
  });

  it('keeps the port of a local address', () => {
    expect(parsePairingUrl('https://192.168.1.20:3002/#pair=123456')?.origin).toBe('https://192.168.1.20:3002');
  });

  it.each(['hello', 'javascript:alert(1)//#pair=123456', 'https://x.test/#pair=12345', 'https://x.test/#pair=abcdef', 'https://x.test/'])(
    'rejects %s',
    (text) => {
      expect(parsePairingUrl(text)).toBeNull();
    },
  );

  it('parses only an exact hash', () => {
    expect(parsePairingHash('#pair=123456')).toBe('123456');
    expect(parsePairingHash('#pair=123456&x=1')).toBeNull();
  });
});
