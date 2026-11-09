import { WebSocket } from 'ws';
import {
  MAX_IMAGE_PAYLOAD_BYTES,
  MAX_IMAGE_DIMENSION,
  ALLOWED_MIME_TYPES,
  type WsMessage,
  type QrImagePayload,
  type AuthMessage,
  type AuthResult,
  type QrAck,
  type ErrorMessage,
  type PairRequest,
  type PairResponse,
  type ConnectionStatus,
} from '@qr2win/shared-types';
import { PairingStore, type PairedDevice } from './pairing.js';

interface AuthenticatedClient {
  ws: WebSocket;
  token: string;
  role: 'phone' | 'desktop';
  deviceId: string;        // desktopDeviceId for desktop, phoneDeviceId for phone
  pairedDesktopId: string;  // the desktop this client is paired to
}

export class WsHandler {
  private clients = new Map<WebSocket, AuthenticatedClient>();
  private recentScanIds = new Map<string, number>(); // scanId → timestamp
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor(private store: PairingStore) {
    // Periodically clean up old scan IDs (keep 5 min)
    this.cleanupInterval = setInterval(() => {
      const cutoff = Date.now() - 5 * 60 * 1000;
      for (const [id, ts] of this.recentScanIds) {
        if (ts < cutoff) this.recentScanIds.delete(id);
      }
    }, 60_000);
  }

  handleConnection(ws: WebSocket): void {
    // Must authenticate within 10 seconds
    const authTimeout = setTimeout(() => {
      if (!this.clients.has(ws)) {
        this.sendError(ws, 'Authentication timeout', 'AUTH_TIMEOUT');
        ws.close(4001, 'Authentication timeout');
      }
    }, 10_000);

    ws.on('message', (raw) => {
      try {
        const data = raw.toString();
        // Reject oversized messages before parsing
        if (Buffer.byteLength(data, 'utf-8') > MAX_IMAGE_PAYLOAD_BYTES + 4096) {
          this.sendError(ws, 'Payload too large', 'PAYLOAD_TOO_LARGE');
          return;
        }

        const msg: WsMessage = JSON.parse(data);
        const client = this.clients.get(ws);

        if (!client) {
          // Only accept auth or pair-request before authentication
          if (msg.type === 'auth') {
            this.handleAuth(ws, msg as AuthMessage, authTimeout);
          } else if (msg.type === 'pair-request') {
            this.handlePairRequest(ws, msg as PairRequest);
          } else {
            this.sendError(ws, 'Not authenticated', 'NOT_AUTHENTICATED');
          }
          return;
        }

        // Authenticated message routing
        switch (msg.type) {
          case 'qr-image':
            this.handleQrImage(client, msg as QrImagePayload);
            break;
          case 'qr-ack':
            // Acknowledged – no action needed for MVP
            break;
          default:
            this.sendError(ws, `Unknown message type: ${(msg as any).type}`, 'UNKNOWN_TYPE');
        }
      } catch (err) {
        this.sendError(ws, 'Invalid message format', 'INVALID_FORMAT');
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimeout);
      this.clients.delete(ws);
    });

    ws.on('error', () => {
      this.clients.delete(ws);
    });
  }

  private handleAuth(ws: WebSocket, msg: AuthMessage, authTimeout: ReturnType<typeof setTimeout>): void {
    const device = this.store.validate(msg.token);
    if (!device) {
      const result: AuthResult = { type: 'auth-result', success: false, error: 'Invalid or expired token' };
      ws.send(JSON.stringify(result));
      ws.close(4003, 'Invalid token');
      return;
    }

    clearTimeout(authTimeout);

    const client: AuthenticatedClient = {
      ws,
      token: msg.token,
      role: msg.role,
      deviceId: msg.role === 'desktop' ? device.desktopDeviceId : device.phoneDeviceId,
      pairedDesktopId: device.desktopDeviceId,
    };

    this.clients.set(ws, client);

    const result: AuthResult = { type: 'auth-result', success: true };
    ws.send(JSON.stringify(result));

    // Send connection status
    this.sendConnectionStatus(client);
  }

  private handlePairRequest(ws: WebSocket, msg: PairRequest): void {
    const result = this.store.pair(msg.code, msg.deviceName);
    if (!result) {
      const response: PairResponse = {
        type: 'pair-response',
        success: false,
        error: 'Invalid or expired pairing code',
      };
      ws.send(JSON.stringify(response));
      return;
    }

    const response: PairResponse = {
      type: 'pair-response',
      success: true,
      token: result.token,
      deviceId: result.desktopDeviceId,
    };
    ws.send(JSON.stringify(response));

    // Notify all desktop clients for this desktop about the new pairing
    for (const client of this.clients.values()) {
      if (client.role === 'desktop' && client.pairedDesktopId === result.desktopDeviceId) {
        this.sendConnectionStatus(client);
      }
    }
  }

  handleQrImage(sender: AuthenticatedClient, payload: QrImagePayload): void {
    // Validate sender is a phone
    if (sender.role !== 'phone') {
      this.sendError(sender.ws, 'Only phone clients can send QR images', 'INVALID_ROLE');
      return;
    }

    // Rate limit
    if (!this.store.checkRateLimit(sender.token)) {
      this.sendError(sender.ws, 'Rate limit exceeded', 'RATE_LIMIT');
      return;
    }

    // Deduplicate
    if (this.recentScanIds.has(payload.scanId)) {
      const ack: QrAck = { type: 'qr-ack', scanId: payload.scanId };
      sender.ws.send(JSON.stringify(ack));
      return;
    }

    // Validate payload
    const validationError = this.validateQrPayload(payload);
    if (validationError) {
      this.sendError(sender.ws, validationError, 'INVALID_PAYLOAD');
      return;
    }

    // Record scan ID
    this.recentScanIds.set(payload.scanId, Date.now());

    // Route to paired desktop(s)
    let delivered = false;
    for (const client of this.clients.values()) {
      if (
        client.role === 'desktop' &&
        client.pairedDesktopId === sender.pairedDesktopId &&
        client.ws.readyState === WebSocket.OPEN
      ) {
        client.ws.send(JSON.stringify(payload));
        delivered = true;
      }
    }

    // ACK the sender
    const ack: QrAck = { type: 'qr-ack', scanId: payload.scanId };
    sender.ws.send(JSON.stringify(ack));

    if (!delivered) {
      this.sendError(sender.ws, 'Desktop is not connected', 'DESKTOP_OFFLINE');
    }
  }

  private validateQrPayload(p: QrImagePayload): string | null {
    if (!p.scanId || typeof p.scanId !== 'string') return 'Missing scanId';
    if (!p.timestamp || typeof p.timestamp !== 'number') return 'Missing timestamp';
    if (!ALLOWED_MIME_TYPES.includes(p.mimeType as any)) return 'Invalid MIME type';
    if (!p.width || p.width < 1 || p.width > MAX_IMAGE_DIMENSION) return 'Invalid width';
    if (!p.height || p.height < 1 || p.height > MAX_IMAGE_DIMENSION) return 'Invalid height';
    if (!p.imageBase64 || typeof p.imageBase64 !== 'string') return 'Missing image data';

    // Check base64 size
    const estimatedBytes = Math.ceil(p.imageBase64.length * 0.75);
    if (estimatedBytes > MAX_IMAGE_PAYLOAD_BYTES) return 'Image too large';

    return null;
  }

  private sendConnectionStatus(client: AuthenticatedClient): void {
    const devices = this.store.getDevicesForDesktop(client.pairedDesktopId);
    const status: ConnectionStatus = {
      type: 'connection-status',
      connected: true,
      mode: 'internet',
      pairedDevices: devices.length,
    };
    client.ws.send(JSON.stringify(status));
  }

  private sendError(ws: WebSocket, message: string, code: string): void {
    if (ws.readyState === WebSocket.OPEN) {
      const err: ErrorMessage = { type: 'error', message, code };
      ws.send(JSON.stringify(err));
    }
  }

  /** Get count of connected clients (for testing). */
  getClientCount(): number {
    return this.clients.size;
  }

  /** Cleanup on shutdown. */
  destroy(): void {
    clearInterval(this.cleanupInterval);
    for (const client of this.clients.values()) {
      client.ws.close(1001, 'Server shutting down');
    }
    this.clients.clear();
    this.recentScanIds.clear();
  }
}

