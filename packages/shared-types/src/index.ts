// ─── Pairing ───────────────────────────────────────────────────────────
export interface PairingCode {
  code: string;
  expiresAt: number; // unix ms
}

export interface PairRequest {
  type: 'pair-request';
  code: string;
  deviceName: string;
}

export interface PairResponse {
  type: 'pair-response';
  success: boolean;
  token?: string;       // revocable credential – never log this
  deviceId?: string;
  error?: string;
}

export interface UnpairRequest {
  type: 'unpair';
  token: string;
}

// ─── QR image delivery ────────────────────────────────────────────────
export interface QrImagePayload {
  type: 'qr-image';
  scanId: string;       // UUID – deduplicate on receiver
  timestamp: number;    // unix ms
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
  /** Base64-encoded image data */
  imageBase64: string;
  /** Decoded text from the QR (for display only – never execute) */
  decodedText: string;
}

export interface QrAck {
  type: 'qr-ack';
  scanId: string;
}

// ─── Connection ────────────────────────────────────────────────────────
export interface AuthMessage {
  type: 'auth';
  token: string;
  role: 'phone' | 'desktop';
}

export interface AuthResult {
  type: 'auth-result';
  success: boolean;
  error?: string;
}

export interface ConnectionStatus {
  type: 'connection-status';
  connected: boolean;
  mode: 'local' | 'internet';
  pairedDevices: number;
}

// ─── Error ─────────────────────────────────────────────────────────────
export interface ErrorMessage {
  type: 'error';
  message: string;
  code?: string;
}

// ─── Union type ────────────────────────────────────────────────────────
export type WsMessage =
  | PairRequest
  | PairResponse
  | UnpairRequest
  | QrImagePayload
  | QrAck
  | AuthMessage
  | AuthResult
  | ConnectionStatus
  | ErrorMessage;

// ─── Constants ─────────────────────────────────────────────────────────
export const PAIRING_CODE_LENGTH = 6;
export const PAIRING_CODE_EXPIRY_MS = 5 * 60 * 1000;   // 5 minutes
export const MAX_IMAGE_PAYLOAD_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_IMAGE_DIMENSION = 4096;
export const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const WS_HEARTBEAT_INTERVAL_MS = 30_000;
export const TOKEN_LENGTH = 64;
export const RATE_LIMIT_SCANS_PER_MINUTE = 30;

