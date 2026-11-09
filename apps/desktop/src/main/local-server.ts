import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import os from 'node:os';
import crypto from 'node:crypto';
import { PairingStore } from './local-pairing';
import {
  MAX_IMAGE_PAYLOAD_BYTES,
  ALLOWED_MIME_TYPES,
  MAX_IMAGE_DIMENSION,
  type QrImagePayload,
  type AuthMessage,
  type AuthResult,
  type PairRequest,
  type PairResponse,
  type WsMessage,
  type ErrorMessage,
  type QrAck,
} from '@qr2win/shared-types';

type QrCallback = (payload: QrImagePayload) => void;

export class LocalServer {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private store = new PairingStore();
  private qrCallbacks: QrCallback[] = [];
  private port = 3002;
  private running = false;
  private authenticatedClients = new Map<WebSocket, { token: string; role: string }>();
  private seenScanIds = new Set<string>();

  onQrImage(callback: QrCallback): void {
    this.qrCallbacks.push(callback);
  }

  async start(): Promise<{ port: number; addresses: string[]; pairingCode: string }> {
    if (this.running) {
      return this.getInfo();
    }

    const app = http.createServer((req, res) => {
      // CORS headers for local network
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', mode: 'local' }));
        return;
      }

      if (req.url === '/api/pairing/pair' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          try {
            const { code, deviceName } = JSON.parse(body);
            const result = this.store.pair(code, deviceName || 'Phone');
            if (!result) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid or expired pairing code' }));
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ token: result.token, desktopDeviceId: result.desktopDeviceId }));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid request' }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    this.wss = new WebSocketServer({ server: app, path: '/ws' });

    this.wss.on('connection', (ws) => {
      const authTimeout = setTimeout(() => {
        if (!this.authenticatedClients.has(ws)) {
          ws.close(4001, 'Auth timeout');
        }
      }, 10_000);

      ws.on('message', (raw) => {
        try {
          const data = raw.toString();
          if (Buffer.byteLength(data) > MAX_IMAGE_PAYLOAD_BYTES + 4096) {
            this.sendError(ws, 'Payload too large', 'PAYLOAD_TOO_LARGE');
            return;
          }

          const msg: WsMessage = JSON.parse(data);
          const client = this.authenticatedClients.get(ws);

          if (!client) {
            if (msg.type === 'auth') {
              this.handleAuth(ws, msg as AuthMessage, authTimeout);
            } else if (msg.type === 'pair-request') {
              this.handlePairWs(ws, msg as PairRequest);
            } else {
              this.sendError(ws, 'Not authenticated', 'NOT_AUTHENTICATED');
            }
            return;
          }

          if (msg.type === 'qr-image' && client.role === 'phone') {
            this.handleQrImage(ws, msg as QrImagePayload);
          }
        } catch {
          this.sendError(ws, 'Invalid message', 'INVALID_FORMAT');
        }
      });

      ws.on('close', () => {
        clearTimeout(authTimeout);
        this.authenticatedClients.delete(ws);
      });
    });

    return new Promise((resolve, reject) => {
      this.server = app;
      app.listen(this.port, '0.0.0.0', () => {
        this.running = true;

        // Generate a pairing code automatically
        const desktopId = crypto.randomUUID();
        const pairing = this.store.generateCode(desktopId);

        console.log(`[local-server] Listening on port ${this.port}`);
        resolve(this.getInfo());
      });

      app.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          this.port++;
          app.listen(this.port, '0.0.0.0');
        } else {
          reject(err);
        }
      });
    });
  }

  stop(): void {
    if (this.wss) {
      for (const client of this.wss.clients) {
        client.close(1001, 'Server stopping');
      }
      this.wss.close();
      this.wss = null;
    }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.running = false;
    this.authenticatedClients.clear();
    this.store.clear();
  }

  getInfo(): { port: number; addresses: string[]; pairingCode: string } {
    const addresses = this.getLocalAddresses();
    const code = this.store.getLatestCode() || '';
    return { port: this.port, addresses, pairingCode: code };
  }

  generateNewPairingCode(): string {
    const desktopId = crypto.randomUUID();
    const pairing = this.store.generateCode(desktopId);
    return pairing.code;
  }

  private handleAuth(ws: WebSocket, msg: AuthMessage, authTimeout: ReturnType<typeof setTimeout>): void {
    const device = this.store.validate(msg.token);
    if (!device) {
      const result: AuthResult = { type: 'auth-result', success: false, error: 'Invalid token' };
      ws.send(JSON.stringify(result));
      ws.close(4003, 'Invalid token');
      return;
    }

    clearTimeout(authTimeout);
    this.authenticatedClients.set(ws, { token: msg.token, role: msg.role });

    const result: AuthResult = { type: 'auth-result', success: true };
    ws.send(JSON.stringify(result));
  }

  private handlePairWs(ws: WebSocket, msg: PairRequest): void {
    const result = this.store.pair(msg.code, msg.deviceName);
    const response: PairResponse = result
      ? { type: 'pair-response', success: true, token: result.token, deviceId: result.desktopDeviceId }
      : { type: 'pair-response', success: false, error: 'Invalid or expired code' };
    ws.send(JSON.stringify(response));
  }

  private handleQrImage(ws: WebSocket, payload: QrImagePayload): void {
    // Validate
    if (!ALLOWED_MIME_TYPES.includes(payload.mimeType as any)) {
      this.sendError(ws, 'Invalid MIME type', 'INVALID_PAYLOAD');
      return;
    }
    if (payload.width < 1 || payload.width > MAX_IMAGE_DIMENSION ||
        payload.height < 1 || payload.height > MAX_IMAGE_DIMENSION) {
      this.sendError(ws, 'Invalid dimensions', 'INVALID_PAYLOAD');
      return;
    }
    const estimatedBytes = Math.ceil(payload.imageBase64.length * 0.75);
    if (estimatedBytes > MAX_IMAGE_PAYLOAD_BYTES) {
      this.sendError(ws, 'Image too large', 'INVALID_PAYLOAD');
      return;
    }

    // Deduplicate
    if (this.seenScanIds.has(payload.scanId)) {
      const ack: QrAck = { type: 'qr-ack', scanId: payload.scanId };
      ws.send(JSON.stringify(ack));
      return;
    }
    this.seenScanIds.add(payload.scanId);

    // Notify desktop directly (no routing needed in local mode)
    for (const cb of this.qrCallbacks) {
      try { cb(payload); } catch (e) { console.error('[local-server] QR callback error:', e); }
    }

    const ack: QrAck = { type: 'qr-ack', scanId: payload.scanId };
    ws.send(JSON.stringify(ack));
  }

  private sendError(ws: WebSocket, message: string, code: string): void {
    if (ws.readyState === WebSocket.OPEN) {
      const err: ErrorMessage = { type: 'error', message, code };
      ws.send(JSON.stringify(err));
    }
  }

  private getLocalAddresses(): string[] {
    const interfaces = os.networkInterfaces();
    const addresses: string[] = [];
    for (const iface of Object.values(interfaces)) {
      if (!iface) continue;
      for (const addr of iface) {
        if (addr.family === 'IPv4' && !addr.internal) {
          addresses.push(`${addr.address}:${this.port}`);
        }
      }
    }
    return addresses;
  }
}

