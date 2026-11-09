// Wire protocol shared by the phone, the relay and the desktop app.
// This module must stay free of Node and DOM APIs (atob aside, which both have).

// ─── Limits ────────────────────────────────────────────────────────────
export const PAIRING_CODE_LENGTH = 6;
export const PAIRING_CODE_EXPIRY_MS = 5 * 60 * 1000;
export const MAX_IMAGE_PAYLOAD_BYTES = 5 * 1024 * 1024; // decoded image bytes
export const MAX_IMAGE_BASE64_LENGTH = Math.ceil(MAX_IMAGE_PAYLOAD_BYTES / 3) * 4;
export const MAX_DECODED_TEXT_LENGTH = 8192;
/** Largest WebSocket frame accepted: the image plus a worst-case JSON-escaped envelope. */
export const MAX_WS_MESSAGE_BYTES = MAX_IMAGE_BASE64_LENGTH + MAX_DECODED_TEXT_LENGTH * 6 + 1024;
export const MAX_IMAGE_DIMENSION = 4096;
export const MAX_DEVICE_NAME_LENGTH = 64;
export const MAX_PHONES_PER_DESKTOP = 20;
export const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const RATE_LIMIT_SCANS_PER_MINUTE = 30;
export const AUTH_TIMEOUT_MS = 10_000;
export const WS_HEARTBEAT_INTERVAL_MS = 25_000;
export const WS_PONG_TIMEOUT_MS = 10_000;
/** WebSocket close code: the credential is invalid or was revoked; do not reconnect. */
export const WS_CLOSE_UNAUTHORIZED = 4003;
export const WS_CLOSE_AUTH_TIMEOUT = 4001;

export type ImageMimeType = (typeof ALLOWED_MIME_TYPES)[number];
export type ClientRole = 'phone' | 'desktop';

// ─── REST bodies ───────────────────────────────────────────────────────
export interface PairingCode {
  code: string;
  expiresAt: number; // unix ms
}

export interface RegisterDesktopResponse {
  desktopId: string;
  token: string;
}

export interface PairResponseBody {
  token: string;
  phoneId: string;
}

export interface PhoneSummary {
  id: string;
  name: string;
  online: boolean;
  createdAt: number;
}

// ─── Client → relay ────────────────────────────────────────────────────
export interface AuthMessage {
  type: 'auth';
  token: string;
}

export interface QrImagePayload {
  type: 'qr-image';
  scanId: string;
  timestamp: number; // unix ms
  mimeType: ImageMimeType;
  width: number;
  height: number;
  /** Base64 of the exact captured image, not a regenerated code. */
  imageBase64: string;
  /** Decoded QR content. Display only: never open or execute it. */
  decodedText: string;
}

/** Desktop → relay → phone: the desktop has received and surfaced this scan. */
export interface QrAck {
  type: 'qr-ack';
  scanId: string;
}

export interface PingMessage {
  type: 'ping';
}

export type ClientMessage = AuthMessage | QrImagePayload | QrAck | PingMessage;

// ─── Relay → client ────────────────────────────────────────────────────
export interface AuthResult {
  type: 'auth-result';
  success: boolean;
  role?: ClientRole;
  error?: string;
}

export interface ConnectionStatus {
  type: 'connection-status';
  desktopOnline: boolean;
  /** Only sent to the desktop that owns these phones. */
  phones?: PhoneSummary[];
}

/** Sent to the desktop when a new phone completes pairing. */
export interface PhonePaired {
  type: 'phone-paired';
  phone: PhoneSummary;
}

/** The scan was not forwarded because the desktop is offline; the phone keeps it and retries. */
export interface ScanDeferred {
  type: 'scan-deferred';
  scanId: string;
}

export interface PongMessage {
  type: 'pong';
}

export type ErrorCode =
  | 'NOT_AUTHENTICATED'
  | 'INVALID_FORMAT'
  | 'INVALID_PAYLOAD'
  | 'INVALID_ROLE'
  | 'RATE_LIMIT'
  | 'UNKNOWN_TYPE';

export interface ErrorMessage {
  type: 'error';
  message: string;
  code: ErrorCode;
  /** Set when the error rejects a specific scan. */
  scanId?: string;
}

export type ServerMessage =
  | AuthResult
  | ConnectionStatus
  | PhonePaired
  | ScanDeferred
  | QrImagePayload
  | QrAck
  | PongMessage
  | ErrorMessage;

// ─── Validation ────────────────────────────────────────────────────────
const SCAN_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

function matchesSignature(mimeType: string, base64: string): boolean {
  let header: string;
  try {
    header = atob(base64.slice(0, 16));
  } catch {
    return false;
  }
  switch (mimeType) {
    case 'image/png':
      return header.startsWith('\x89PNG\r\n\x1a\n');
    case 'image/jpeg':
      return header.startsWith('\xff\xd8\xff');
    case 'image/webp':
      return header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP';
    default:
      return false;
  }
}

/** Returns a description of what is wrong with the scan, or null when it is acceptable. */
export function validateQrPayload(p: unknown): string | null {
  if (typeof p !== 'object' || p === null) return 'Malformed scan';
  const scan = p as Partial<QrImagePayload>;
  if (typeof scan.scanId !== 'string' || !SCAN_ID_PATTERN.test(scan.scanId)) return 'Invalid scanId';
  if (typeof scan.timestamp !== 'number' || !Number.isFinite(scan.timestamp)) return 'Invalid timestamp';
  if (!ALLOWED_MIME_TYPES.includes(scan.mimeType as ImageMimeType)) return 'Invalid MIME type';
  for (const size of [scan.width, scan.height]) {
    if (!Number.isInteger(size) || (size as number) < 1 || (size as number) > MAX_IMAGE_DIMENSION) {
      return 'Invalid image dimensions';
    }
  }
  if (typeof scan.decodedText !== 'string' || scan.decodedText.length > MAX_DECODED_TEXT_LENGTH) {
    return 'Invalid decoded text';
  }
  if (typeof scan.imageBase64 !== 'string' || scan.imageBase64.length === 0) return 'Missing image data';
  if (scan.imageBase64.length > MAX_IMAGE_BASE64_LENGTH) return 'Image too large';
  if (!BASE64_PATTERN.test(scan.imageBase64)) return 'Image is not valid base64';
  if (!matchesSignature(scan.mimeType as string, scan.imageBase64)) {
    return 'Image data does not match its MIME type';
  }
  return null;
}

// ─── Pairing links ─────────────────────────────────────────────────────
const PAIR_HASH_PATTERN = /^#pair=(\d{6})$/;

/** Builds the URL a phone opens to pair. The code stays in the fragment so it is never sent in a request. */
export function buildPairingUrl(baseUrl: string, code: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/#pair=${code}`;
}

/** Extracts the pairing code from a URL hash such as `#pair=123456`. */
export function parsePairingHash(hash: string): string | null {
  return PAIR_HASH_PATTERN.exec(hash)?.[1] ?? null;
}

/** Parses a scanned pairing link. Returns null for anything that is not an http(s) pairing URL. */
export function parsePairingUrl(text: string): { origin: string; code: string } | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const code = parsePairingHash(url.hash);
  return code ? { origin: url.origin, code } : null;
}
