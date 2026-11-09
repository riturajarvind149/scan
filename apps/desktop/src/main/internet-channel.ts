import WebSocket from 'ws';
import {
  MAX_WS_MESSAGE_BYTES,
  WS_CLOSE_UNAUTHORIZED,
  WS_HEARTBEAT_INTERVAL_MS,
  WS_PONG_TIMEOUT_MS,
  type RegisterDesktopResponse,
  type ServerMessage,
} from '@qr2win/shared-types';
import { handleServerMessage, type ChannelEvents } from './channel';
import type { SettingsStore } from './settings';

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BACKOFF_MS = 30_000;

/** 'needs-invite': the relay is set, but this laptop isn't on it yet, or was removed. */
export type ChannelStatus = 'off' | 'connecting' | 'connected' | 'error' | 'needs-invite';

export interface InternetState {
  status: ChannelStatus;
  error: string | null;
  serverUrl: string;
}

/** Keeps the desktop connected to the internet relay, once it has joined with an invite link. */
export class InternetChannel {
  private ws: WebSocket | null = null;
  private status: ChannelStatus = 'off';
  private error: string | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  /** Bumped whenever the connection is restarted, so late callbacks from an old attempt are ignored. */
  private generation = 0;

  constructor(
    private readonly settings: SettingsStore,
    private readonly events: ChannelEvents,
  ) {}

  getState(): InternetState {
    return { status: this.status, error: this.error, serverUrl: this.settings.serverUrl };
  }

  /** Connects using the saved settings. */
  start(): void {
    this.stop();
    if (!this.settings.serverUrl) {
      this.setStatus('off');
      return;
    }
    void this.connect(++this.generation);
  }

  stop(): void {
    this.generation++;
    this.clearTimers();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.on('error', () => undefined);
      this.ws.terminate();
      this.ws = null;
    }
    this.attempts = 0;
    this.setStatus('off');
  }

  /** Reconnects right away, for example after the PC wakes from sleep. */
  reconnectNow(): void {
    if (this.settings.serverUrl && this.status !== 'connected') this.start();
    else this.ws?.ping();
  }

  /** Joins the relay an invite link belongs to. Nothing changes here unless the relay accepts it. */
  async joinWithInvite(origin: string, invite: string, laptopName: string): Promise<void> {
    const joined = await this.request<RegisterDesktopResponse>(origin, '/api/desktops/join', { method: 'POST', body: { invite, name: laptopName } });
    this.settings.serverUrl = origin;
    this.settings.setCredential({ desktopId: joined.desktopId, token: joined.token });
    this.start();
  }

  private async connect(generation: number): Promise<void> {
    this.setStatus('connecting');
    const credential = this.settings.getCredential();
    if (!credential) {
      this.error = null;
      this.setStatus('needs-invite');
      return;
    }
    const { token } = credential;

    const wsUrl = `${this.settings.serverUrl.replace(/^http/, 'ws')}/ws`;
    const ws = new WebSocket(wsUrl, { maxPayload: MAX_WS_MESSAGE_BYTES, handshakeTimeout: REQUEST_TIMEOUT_MS });
    this.ws = ws;

    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    ws.on('message', (raw) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.type === 'auth-result') {
        if (message.success) {
          this.attempts = 0;
          this.error = null;
          this.setStatus('connected');
          this.startHeartbeat(ws);
        }
        return;
      }
      handleServerMessage(
        message,
        'internet',
        this.events,
        (reply) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
        },
        () => undefined,
      );
    });
    ws.on('pong', () => {
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = null;
    });
    ws.on('error', (err) => {
      this.error = err.message;
    });
    ws.on('close', (code) => {
      if (generation !== this.generation) return;
      this.clearTimers();
      this.ws = null;
      if (code === WS_CLOSE_UNAUTHORIZED) {
        // Removed from the dashboard, or the relay's secret changed. Only a new invite can fix this.
        this.settings.setCredential(null);
        this.error = 'This laptop was removed from the relay. Ask for a new invite link to rejoin.';
        this.setStatus('needs-invite');
        return;
      }
      this.scheduleRetry(generation, this.error ?? 'Connection lost');
    });
  }

  private async request<T = unknown>(origin: string, pathname: string, options: { method: string; body?: unknown }): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${origin}${pathname}`, {
        method: options.method,
        headers: { 'Content-Type': 'application/json' },
        body: options.method === 'POST' ? JSON.stringify(options.body ?? {}) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // A refused connection can have an empty message and only a code.
      const cause = (err as Error & { cause?: Error & { code?: string } }).cause;
      const reason = cause?.message || cause?.code || (err as Error).message || 'no response';
      throw new Error(`Could not reach the relay: ${reason}`);
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `The relay answered with an error (${response.status}).`);
    }
    return (await response.json()) as T;
  }

  private scheduleRetry(generation: number, reason: string): void {
    const backoff = Math.min(1000 * 2 ** this.attempts, MAX_BACKOFF_MS);
    const delay = backoff / 2 + Math.random() * (backoff / 2); // jitter avoids reconnect stampedes
    this.attempts++;
    this.error = reason;
    this.setStatus('connecting');
    this.retryTimer = setTimeout(() => {
      if (generation === this.generation) void this.connect(generation);
    }, delay);
  }

  private startHeartbeat(ws: WebSocket): void {
    this.clearTimers();
    this.heartbeatTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.ping();
      // A half-open socket raises no error by itself, so no pong means the connection is dead.
      this.pongTimer ??= setTimeout(() => ws.terminate(), WS_PONG_TIMEOUT_MS);
    }, WS_HEARTBEAT_INTERVAL_MS);
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.heartbeatTimer = null;
    this.pongTimer = null;
  }

  private setStatus(status: ChannelStatus): void {
    this.status = status;
    this.events.onChange();
  }
}
