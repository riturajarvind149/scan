import WebSocket from 'ws';
import {
  MAX_WS_MESSAGE_BYTES,
  WS_CLOSE_UNAUTHORIZED,
  WS_HEARTBEAT_INTERVAL_MS,
  WS_PONG_TIMEOUT_MS,
  buildPairingUrl,
  type PairingCode,
  type PhoneSummary,
  type RegisterDesktopResponse,
  type ServerMessage,
} from '@qr2win/shared-types';
import { handleServerMessage, type ChannelEvents } from './channel';
import type { SettingsStore } from './settings';

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BACKOFF_MS = 30_000;

export type ChannelStatus = 'off' | 'connecting' | 'connected' | 'error';

export interface InternetState {
  status: ChannelStatus;
  error: string | null;
  serverUrl: string;
  phones: PhoneSummary[];
}

/** Keeps the desktop registered with and connected to the internet relay. */
export class InternetChannel {
  private ws: WebSocket | null = null;
  private status: ChannelStatus = 'off';
  private error: string | null = null;
  private phones: PhoneSummary[] = [];
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
    return { status: this.status, error: this.error, serverUrl: this.settings.serverUrl, phones: this.phones };
  }

  /** Connects using the saved settings, registering with the relay first if needed. */
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
    this.phones = [];
    this.attempts = 0;
    this.setStatus('off');
  }

  /** Reconnects right away, for example after the PC wakes from sleep. */
  reconnectNow(): void {
    if (this.settings.serverUrl && this.status !== 'connected') this.start();
    else this.ws?.ping();
  }

  async createPairing(): Promise<{ code: string; expiresAt: number; url: string }> {
    if (!this.settings.serverUrl) throw new Error('Set your relay address first.');
    const credential = await this.ensureCredential();
    const pairing = await this.request<PairingCode>('/api/pairing/generate', { method: 'POST', token: credential.token });
    return { ...pairing, url: buildPairingUrl(this.settings.serverUrl, pairing.code) };
  }

  async unpair(phoneId: string): Promise<void> {
    const credential = this.settings.getCredential();
    if (!credential) throw new Error('Not registered with the relay.');
    await this.request(`/api/phones/${encodeURIComponent(phoneId)}`, { method: 'DELETE', token: credential.token });
  }

  private async connect(generation: number): Promise<void> {
    this.setStatus('connecting');
    let token: string;
    try {
      ({ token } = await this.ensureCredential());
    } catch (err) {
      if (generation === this.generation) this.scheduleRetry(generation, (err as Error).message);
      return;
    }
    if (generation !== this.generation) return;

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
        (phones) => {
          this.phones = phones;
        },
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
        // The relay no longer recognises this PC, for example its data was reset.
        // Phones paired through it are gone too, so they will be listed as such and need re-pairing.
        this.settings.setCredential(null);
        this.phones = [];
      }
      this.scheduleRetry(generation, this.error ?? 'Connection lost');
    });
  }

  private async ensureCredential() {
    const existing = this.settings.getCredential();
    if (existing) return existing;
    const created = await this.request<RegisterDesktopResponse>('/api/desktops/register', { method: 'POST' });
    const credential = { desktopId: created.desktopId, token: created.token };
    this.settings.setCredential(credential);
    return credential;
  }

  private async request<T = unknown>(pathname: string, options: { method: string; token?: string }): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.settings.serverUrl}${pathname}`, {
        method: options.method,
        headers: {
          'Content-Type': 'application/json',
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
        body: options.method === 'POST' ? '{}' : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const cause = (err as Error & { cause?: Error }).cause?.message ?? (err as Error).message;
      throw new Error(`Could not reach the relay: ${cause}`);
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (response.status === 401) this.settings.setCredential(null);
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
