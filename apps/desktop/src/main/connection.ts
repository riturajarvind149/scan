import WebSocket from 'ws';
import type {
  AuthMessage,
  AuthResult,
  QrImagePayload,
  WsMessage,
} from '@qr2win/shared-types';
import { WS_HEARTBEAT_INTERVAL_MS } from '@qr2win/shared-types';

type QrCallback = (payload: QrImagePayload) => void;

export class ConnectionManager {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private url: string | null = null;
  private role: 'desktop' | 'phone' = 'desktop';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private qrCallbacks: QrCallback[] = [];
  private seenScanIds = new Set<string>();
  private status: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';
  private lastError: string | null = null;
  private intentionalClose = false;

  onQrImage(callback: QrCallback): void {
    this.qrCallbacks.push(callback);
  }

  connect(url: string, token: string, role: 'desktop' | 'phone' = 'desktop'): void {
    this.disconnect();
    this.url = url;
    this.token = token;
    this.role = role;
    this.intentionalClose = false;
    this.reconnectAttempts = 0;
    this.doConnect();
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.cleanup();
    this.status = 'disconnected';
    this.lastError = null;
  }

  getStatus(): { status: string; error: string | null } {
    return { status: this.status, error: this.lastError };
  }

  private doConnect(): void {
    if (!this.url || !this.token) return;

    this.status = 'connecting';
    this.lastError = null;

    try {
      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        console.log('[connection] WebSocket connected');
        const auth: AuthMessage = {
          type: 'auth',
          token: this.token!,
          role: this.role,
        };
        this.ws!.send(JSON.stringify(auth));
      });

      this.ws.on('message', (raw) => {
        try {
          const msg: WsMessage = JSON.parse(raw.toString());
          this.handleMessage(msg);
        } catch {
          // Ignore malformed messages
        }
      });

      this.ws.on('close', (code) => {
        console.log(`[connection] WebSocket closed: ${code}`);
        this.cleanup();

        if (this.intentionalClose) return;

        if (code === 4003) {
          this.status = 'error';
          this.lastError = 'Token rejected – re-pair required';
          return;
        }

        // Auto-reconnect with exponential backoff
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
        this.reconnectAttempts++;
        this.status = 'connecting';
        this.lastError = `Reconnecting in ${Math.round(delay / 1000)}s`;
        console.log(`[connection] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
        this.reconnectTimer = setTimeout(() => this.doConnect(), delay);
      });

      this.ws.on('error', (err) => {
        console.error('[connection] WebSocket error:', err.message);
        this.lastError = err.message;
      });
    } catch (err: any) {
      this.status = 'error';
      this.lastError = err.message;
    }
  }

  private handleMessage(msg: WsMessage): void {
    switch (msg.type) {
      case 'auth-result': {
        const result = msg as AuthResult;
        if (result.success) {
          this.status = 'connected';
          this.lastError = null;
          this.reconnectAttempts = 0;
          console.log('[connection] Authenticated successfully');

          // Start heartbeat
          this.heartbeatTimer = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
              this.ws.ping();
            }
          }, WS_HEARTBEAT_INTERVAL_MS);
        } else {
          this.status = 'error';
          this.lastError = result.error || 'Auth failed';
        }
        break;
      }

      case 'qr-image': {
        const payload = msg as QrImagePayload;
        // Deduplicate
        if (this.seenScanIds.has(payload.scanId)) {
          console.log(`[connection] Duplicate scan ignored: ${payload.scanId}`);
          return;
        }
        this.seenScanIds.add(payload.scanId);

        // Trim old scan IDs (keep last 100)
        if (this.seenScanIds.size > 100) {
          const arr = [...this.seenScanIds];
          for (let i = 0; i < arr.length - 100; i++) {
            this.seenScanIds.delete(arr[i]);
          }
        }

        // Notify callbacks
        for (const cb of this.qrCallbacks) {
          try {
            cb(payload);
          } catch (err) {
            console.error('[connection] QR callback error:', err);
          }
        }

        // Send ACK
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'qr-ack', scanId: payload.scanId }));
        }
        break;
      }

      case 'connection-status':
        console.log('[connection] Status update:', msg);
        break;

      case 'error':
        console.warn('[connection] Server error:', (msg as any).message);
        break;
    }
  }

  private cleanup(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }
  }
}

