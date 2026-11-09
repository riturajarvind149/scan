import {
  WS_CLOSE_UNAUTHORIZED,
  WS_HEARTBEAT_INTERVAL_MS,
  WS_PONG_TIMEOUT_MS,
  type ClientMessage,
  type QrImagePayload,
  type ServerMessage,
} from '@qr2win/shared-types';

const MAX_BACKOFF_MS = 30_000;
/** How long the desktop gets to confirm a scan before it is sent again. */
const ACK_TIMEOUT_MS = 10_000;
const MAX_SEND_ATTEMPTS = 3;
/** Unsent scans are kept this long, so a QR captured while the laptop sleeps still arrives. */
const MAX_PENDING_AGE_MS = 5 * 60 * 1000;
const MAX_PENDING = 10;
const VISIBLE_HISTORY = 5;

export type ScanStatus = 'sending' | 'waiting' | 'delivered' | 'failed';

export interface ScanEntry {
  scanId: string;
  text: string;
  status: ScanStatus;
  message?: string;
}

export interface ClientState {
  connection: 'connecting' | 'connected';
  desktopOnline: boolean;
  /** The relay refused the credential: this phone is no longer paired. */
  revoked: boolean;
  scans: ScanEntry[];
}

interface Pending {
  payload: QrImagePayload;
  attempts: number;
  ackTimer: ReturnType<typeof setTimeout> | null;
  queuedAt: number;
}

/** Owns the phone's connection to the relay and sees each scan through to confirmed delivery. */
export class PhoneClient {
  private ws: WebSocket | null = null;
  private stopped = true;
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private pending = new Map<string, Pending>();
  private listeners = new Set<() => void>();
  private state: ClientState = { connection: 'connecting', desktopOnline: false, revoked: false, scans: [] };

  constructor(
    private readonly url: string,
    /** Null on a relay with a public phone link, which needs no credential. */
    private readonly token: string | null,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ClientState => this.state;

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    window.addEventListener('online', this.wake);
    document.addEventListener('visibilitychange', this.wake);
    this.open();
  }

  stop(): void {
    this.stopped = true;
    window.removeEventListener('online', this.wake);
    document.removeEventListener('visibilitychange', this.wake);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.dropSocket();
    for (const entry of this.pending.values()) {
      if (entry.ackTimer) clearTimeout(entry.ackTimer);
    }
    this.pending.clear();
  }

  /** Queues a scan for delivery. It is sent now if possible and kept until confirmed otherwise. */
  sendScan(payload: QrImagePayload): void {
    this.pending.set(payload.scanId, { payload, attempts: 0, ackTimer: null, queuedAt: Date.now() });
    this.setScan({ scanId: payload.scanId, text: payload.decodedText, status: 'sending' });
    while (this.pending.size > MAX_PENDING) {
      const oldest = this.pending.keys().next().value as string;
      this.fail(oldest, 'Too many scans waiting for your laptop.');
    }
    this.transmit(payload.scanId);
  }

  private wake = (): void => {
    if (document.visibilityState !== 'visible' || this.stopped) return;
    // Phones suspend background tabs, so the socket may have died unnoticed. Check it at once.
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ping();
    } else if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.attempts = 0;
      this.open();
    }
  };

  private open(): void {
    this.patch({ connection: 'connecting' });
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      if (ws === this.ws) this.sendRaw(this.token ? { type: 'auth', token: this.token } : { type: 'auth' });
    };
    ws.onmessage = (event) => {
      if (ws !== this.ws) return;
      try {
        this.handle(JSON.parse(event.data as string) as ServerMessage);
      } catch {
        // Ignore anything unparseable.
      }
    };
    ws.onclose = (event) => {
      if (ws !== this.ws) return; // a socket we already replaced
      this.ws = null;
      this.clearHeartbeat();
      if (event.code === WS_CLOSE_UNAUTHORIZED) {
        this.patch({ revoked: true });
        this.stop();
        return;
      }
      this.patch({ connection: 'connecting', desktopOnline: false });
      this.scheduleReconnect();
    };
  }

  private handle(message: ServerMessage): void {
    switch (message.type) {
      case 'auth-result':
        if (message.success) {
          this.attempts = 0;
          this.patch({ connection: 'connected' });
          this.startHeartbeat();
        }
        break;
      case 'connection-status': {
        const cameOnline = message.desktopOnline && !this.state.desktopOnline;
        this.patch({ desktopOnline: message.desktopOnline });
        if (cameOnline) this.flush();
        break;
      }
      case 'qr-ack':
        this.complete(message.scanId);
        break;
      case 'scan-deferred':
        this.defer(message.scanId);
        break;
      case 'error':
        if (message.scanId) this.fail(message.scanId, message.message);
        break;
      case 'pong':
        if (this.pongTimer) clearTimeout(this.pongTimer);
        this.pongTimer = null;
        break;
      default:
        break;
    }
  }

  private transmit(scanId: string): void {
    const entry = this.pending.get(scanId);
    if (!entry) return;
    if (Date.now() - entry.queuedAt > MAX_PENDING_AGE_MS) {
      this.fail(scanId, "Your laptop didn't come back in time. Scan again.");
      return;
    }
    if (this.ws?.readyState !== WebSocket.OPEN || this.state.connection !== 'connected') {
      this.updateScan(scanId, { status: 'waiting' });
      return;
    }
    if (entry.attempts >= MAX_SEND_ATTEMPTS) {
      this.fail(scanId, "Your laptop didn't confirm this scan. Try again.");
      return;
    }
    entry.attempts++;
    this.updateScan(scanId, { status: 'sending' });
    this.sendRaw(entry.payload);
    if (entry.ackTimer) clearTimeout(entry.ackTimer);
    entry.ackTimer = setTimeout(() => this.transmit(scanId), ACK_TIMEOUT_MS);
  }

  private flush(): void {
    for (const scanId of [...this.pending.keys()]) this.transmit(scanId);
  }

  private defer(scanId: string): void {
    const entry = this.pending.get(scanId);
    if (!entry) return;
    if (entry.ackTimer) clearTimeout(entry.ackTimer);
    entry.ackTimer = null;
    entry.attempts = 0; // not a delivery failure: the laptop just isn't there yet
    this.updateScan(scanId, { status: 'waiting' });
  }

  private complete(scanId: string): void {
    this.settle(scanId);
    this.updateScan(scanId, { status: 'delivered' });
  }

  private fail(scanId: string, message: string): void {
    this.settle(scanId);
    this.updateScan(scanId, { status: 'failed', message });
  }

  private settle(scanId: string): void {
    const entry = this.pending.get(scanId);
    if (entry?.ackTimer) clearTimeout(entry.ackTimer);
    this.pending.delete(scanId);
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const backoff = Math.min(1000 * 2 ** this.attempts, MAX_BACKOFF_MS);
    const delay = backoff / 2 + Math.random() * (backoff / 2);
    this.attempts++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delay);
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => this.ping(), WS_HEARTBEAT_INTERVAL_MS);
  }

  private ping(): void {
    this.sendRaw({ type: 'ping' });
    // Browsers hide protocol-level pings, so liveness is checked with application-level ones.
    this.pongTimer ??= setTimeout(() => {
      this.pongTimer = null;
      const dead = this.ws;
      this.dropSocket();
      if (dead && !this.stopped) {
        this.patch({ connection: 'connecting', desktopOnline: false });
        this.scheduleReconnect();
      }
    }, WS_PONG_TIMEOUT_MS);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.heartbeatTimer = null;
    this.pongTimer = null;
  }

  private dropSocket(): void {
    this.clearHeartbeat();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  private sendRaw(message: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  private setScan(entry: ScanEntry): void {
    this.patch({ scans: [entry, ...this.state.scans].slice(0, VISIBLE_HISTORY) });
  }

  private updateScan(scanId: string, changes: Partial<ScanEntry>): void {
    this.patch({ scans: this.state.scans.map((scan) => (scan.scanId === scanId ? { ...scan, ...changes } : scan)) });
  }

  private patch(changes: Partial<ClientState>): void {
    this.state = { ...this.state, ...changes };
    for (const listener of this.listeners) listener();
  }
}
