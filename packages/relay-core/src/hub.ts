import crypto from 'node:crypto';
import type http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import {
  AUTH_TIMEOUT_MS,
  MAX_WS_MESSAGE_BYTES,
  OPEN_CONNECTIONS_PER_IP,
  OPEN_SCANS_PER_MINUTE,
  RATE_LIMIT_SCANS_PER_MINUTE,
  WS_CLOSE_AUTH_TIMEOUT,
  WS_CLOSE_UNAUTHORIZED,
  WS_HEARTBEAT_INTERVAL_MS,
  validateQrPayload,
  type ClientMessage,
  type ErrorCode,
  type LaptopSummary,
  type PhoneSummary,
  type QrImagePayload,
  type ServerMessage,
} from '@qr2win/shared-types';
import { RateLimiter } from './rate-limit.js';
import type { Identity, PairingStore, PhoneRecord } from './store.js';

/** Close code for "try again later": a phone keeps retrying rather than treating it as being unpaired. */
const WS_CLOSE_TRY_LATER = 1013;

const SCAN_MEMORY_MS = 5 * 60 * 1000;
const AUTH_FAILURES_PER_MINUTE = 20;

/** A connected desktop or phone: a WebSocket, or the in-process desktop of a local relay. */
interface Peer {
  identity: Identity;
  /** Whose allowance a scan spends. Anonymous phones can reconnect at will, so theirs is per IP. */
  rateKey?: string;
  send(message: ServerMessage): void;
  close(code: number, reason: string): void;
}

/** Routes scans between paired phones and desktops and tracks who is online. */
export class Hub {
  private peers = new Set<Peer>();
  private sockets = new Map<WebSocket, Peer>();
  private alive = new WeakSet<WebSocket>();
  /** Scans already forwarded, so a retry is re-acked rather than shown twice. */
  private scans = new Map<string, { at: number; acked: boolean; phoneId: string }>();
  private scanLimiter = new RateLimiter(RATE_LIMIT_SCANS_PER_MINUTE, 60_000);
  private authLimiter = new RateLimiter(AUTH_FAILURES_PER_MINUTE, 60_000);
  private openLimiter = new RateLimiter(OPEN_SCANS_PER_MINUTE, 60_000);
  private openConnections = new Map<string, number>();
  private wss: WebSocketServer | null = null;
  private heartbeat: ReturnType<typeof setInterval>;

  constructor(
    private readonly store: PairingStore,
    private readonly clientIp: (req: http.IncomingMessage) => string = (req) => req.socket.remoteAddress ?? 'unknown',
    /** The account that phones without a credential send to. Set only when the phone link is public. */
    private readonly openAccountId?: string,
  ) {
    this.heartbeat = setInterval(() => this.tick(), WS_HEARTBEAT_INTERVAL_MS);
    this.heartbeat.unref?.();
  }

  /** Starts accepting WebSocket clients on `/ws` of the given HTTP(S) server. */
  attach(server: http.Server): void {
    this.wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_WS_MESSAGE_BYTES });
    this.wss.on('connection', (ws, req) => this.handleSocket(ws, this.clientIp(req)));
  }

  /**
   * Connects an in-process desktop, used by the laptop's own local relay. It speaks the same
   * protocol as a remote desktop; `send` delivers its messages (acks) to the relay.
   */
  connectLocalDesktop(desktopId: string, onMessage: (message: ServerMessage) => void): {
    send(message: ClientMessage): void;
    disconnect(): void;
  } {
    const peer: Peer = {
      identity: { role: 'desktop', desktopId },
      send: onMessage,
      close: () => this.peers.delete(peer),
    };
    this.peers.add(peer);
    this.broadcastStatus(desktopId);
    return {
      send: (message) => this.handleMessage(peer, message),
      disconnect: () => {
        this.peers.delete(peer);
        this.broadcastStatus(desktopId);
      },
    };
  }

  /** Announces a newly paired phone to its desktop. */
  notifyPhonePaired(phone: PhoneRecord): void {
    const summary = this.summarize(phone);
    for (const peer of this.desktopPeers(phone.desktopId)) peer.send({ type: 'phone-paired', phone: summary });
    this.broadcastStatus(phone.desktopId);
  }

  /** Tells the laptops that another one joined, so an unexpected laptop gets noticed. */
  notifyLaptopJoined(desktopId: string, name: string): void {
    for (const peer of this.desktopPeers(desktopId)) peer.send({ type: 'laptop-joined', name });
  }

  /** Removes a laptop: its credential stops working and any live connection is dropped. */
  revokeLaptop(laptopId: string): void {
    this.store.revokeLaptop(laptopId);
    for (const peer of [...this.peers]) {
      if (peer.identity.role === 'desktop' && peer.identity.laptopId === laptopId) {
        peer.close(WS_CLOSE_UNAUTHORIZED, 'Laptop removed');
      }
    }
  }

  listLaptops(): LaptopSummary[] {
    const online = new Set<string>();
    for (const peer of this.peers) {
      if (peer.identity.role === 'desktop' && peer.identity.laptopId) online.add(peer.identity.laptopId);
    }
    return this.store.listLaptops().map((laptop) => ({ ...laptop, online: online.has(laptop.id) }));
  }

  phonesOnline(): number {
    return [...this.peers].filter((peer) => peer.identity.role === 'phone').length;
  }

  /** Revokes a phone: its credential stops working and any live connection is dropped. */
  revokePhone(desktopId: string, phoneId: string): void {
    this.store.revokePhone(desktopId, phoneId);
    for (const peer of [...this.peers]) {
      if (peer.identity.role === 'phone' && peer.identity.desktopId === desktopId && peer.identity.phoneId === phoneId) {
        peer.close(WS_CLOSE_UNAUTHORIZED, 'Pairing revoked');
      }
    }
    this.broadcastStatus(desktopId);
  }

  listPhones(desktopId: string): PhoneSummary[] {
    return this.store.listPhones(desktopId).map((phone) => this.summarize(phone));
  }

  connectionCount(): number {
    return this.peers.size;
  }

  async close(): Promise<void> {
    clearInterval(this.heartbeat);
    for (const peer of [...this.peers]) peer.close(1001, 'Server shutting down');
    this.peers.clear();
    const wss = this.wss;
    if (wss) {
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  }

  private handleSocket(ws: WebSocket, ip: string): void {
    this.alive.add(ws);
    ws.on('pong', () => this.alive.add(ws));

    const authTimer = setTimeout(() => {
      if (!this.sockets.has(ws)) ws.close(WS_CLOSE_AUTH_TIMEOUT, 'Authentication timeout');
    }, AUTH_TIMEOUT_MS);

    ws.on('message', (raw) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        this.sendRaw(ws, { type: 'error', message: 'Invalid message format', code: 'INVALID_FORMAT' });
        return;
      }
      if (typeof message !== 'object' || message === null) {
        this.sendRaw(ws, { type: 'error', message: 'Invalid message format', code: 'INVALID_FORMAT' });
        return;
      }

      const peer = this.sockets.get(ws);
      if (peer) {
        this.handleMessage(peer, message);
      } else if (message.type === 'auth') {
        const authenticated = message.token === undefined && this.openAccountId
          ? this.admitAnonymousPhone(ws, this.openAccountId, ip)
          : this.authenticateSocket(ws, message.token, ip);
        if (authenticated) clearTimeout(authTimer);
      } else if (message.type === 'ping') {
        this.sendRaw(ws, { type: 'pong' });
      } else {
        this.sendRaw(ws, { type: 'error', message: 'Not authenticated', code: 'NOT_AUTHENTICATED' });
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      const peer = this.sockets.get(ws);
      if (!peer) return;
      this.sockets.delete(ws);
      this.peers.delete(peer);
      this.broadcastStatus(peer.identity.desktopId);
    });

    // Oversized frames and protocol errors arrive here; `ws` closes the socket itself.
    ws.on('error', () => undefined);
  }

  /** A phone on a public link: no credential, so each connection is its own short-lived identity. */
  private admitAnonymousPhone(ws: WebSocket, accountId: string, ip: string): boolean {
    const connections = this.openConnections.get(ip) ?? 0;
    if (connections >= OPEN_CONNECTIONS_PER_IP) {
      ws.close(WS_CLOSE_TRY_LATER, 'Too many connections');
      return false;
    }
    this.openConnections.set(ip, connections + 1);
    ws.once('close', () => {
      const remaining = (this.openConnections.get(ip) ?? 1) - 1;
      if (remaining > 0) this.openConnections.set(ip, remaining);
      else this.openConnections.delete(ip);
    });
    this.addSocketPeer(ws, { role: 'phone', desktopId: accountId, phoneId: `open-${crypto.randomUUID()}` }, `ip:${ip}`);
    return true;
  }

  private authenticateSocket(ws: WebSocket, token: string | undefined, ip: string): boolean {
    const identity = this.authLimiter.allow(ip) ? this.store.authenticate(token) : null;
    if (!identity) {
      this.sendRaw(ws, { type: 'auth-result', success: false, error: 'Invalid or revoked credential' });
      ws.close(WS_CLOSE_UNAUTHORIZED, 'Invalid token');
      return false;
    }
    this.addSocketPeer(ws, identity);
    return true;
  }

  private addSocketPeer(ws: WebSocket, identity: Identity, rateKey?: string): void {
    const peer: Peer = {
      identity,
      rateKey,
      send: (message) => this.sendRaw(ws, message),
      close: (code, reason) => ws.close(code, reason),
    };
    this.sockets.set(ws, peer);
    this.peers.add(peer);
    this.sendRaw(ws, { type: 'auth-result', success: true, role: identity.role });
    this.broadcastStatus(identity.desktopId);
  }

  private handleMessage(peer: Peer, message: ClientMessage): void {
    switch (message.type) {
      case 'ping':
        peer.send({ type: 'pong' });
        return;
      case 'qr-image':
        this.handleScan(peer, message);
        return;
      case 'qr-ack':
        this.handleAck(peer, message.scanId);
        return;
      default:
        this.sendError(peer, 'Unknown message type', 'UNKNOWN_TYPE');
    }
  }

  private handleScan(peer: Peer, scan: QrImagePayload): void {
    const { identity } = peer;
    if (identity.role !== 'phone') {
      this.sendError(peer, 'Only phones can send scans', 'INVALID_ROLE');
      return;
    }
    const invalid = validateQrPayload(scan);
    if (invalid) {
      this.sendError(peer, invalid, 'INVALID_PAYLOAD', typeof scan.scanId === 'string' ? scan.scanId : undefined);
      return;
    }

    if (peer.rateKey && this.store.scansPaused) {
      this.sendError(peer, 'Scanning is paused by the administrator.', 'SCANS_PAUSED', scan.scanId);
      return;
    }

    const key = `${identity.desktopId}:${scan.scanId}`;
    const known = this.scans.get(key);
    if (known?.acked) {
      peer.send({ type: 'qr-ack', scanId: scan.scanId });
      return;
    }
    // Retries of a scan already counted do not spend the sender's allowance.
    if (!known && (!this.scanLimiter.allow(peer.rateKey ?? identity.phoneId) || (peer.rateKey && !this.openLimiter.allow('all')))) {
      this.sendError(peer, 'Too many scans; slow down', 'RATE_LIMIT', scan.scanId);
      return;
    }

    const desktops = this.desktopPeers(identity.desktopId);
    if (desktops.length === 0) {
      peer.send({ type: 'scan-deferred', scanId: scan.scanId });
      return;
    }
    this.pruneScans();
    // On a retry the phone may have reconnected under a new id, and the ack must reach it there.
    this.scans.set(key, { at: known?.at ?? Date.now(), acked: false, phoneId: identity.phoneId });
    for (const desktop of desktops) desktop.send(scan);
  }

  private handleAck(peer: Peer, scanId: unknown): void {
    if (peer.identity.role !== 'desktop' || typeof scanId !== 'string') return;
    const record = this.scans.get(`${peer.identity.desktopId}:${scanId}`);
    if (!record) return;
    record.acked = true;
    for (const candidate of this.peers) {
      if (candidate.identity.role === 'phone' && candidate.identity.phoneId === record.phoneId) {
        candidate.send({ type: 'qr-ack', scanId });
      }
    }
  }

  private desktopPeers(desktopId: string): Peer[] {
    return [...this.peers].filter((peer) => peer.identity.role === 'desktop' && peer.identity.desktopId === desktopId);
  }

  private summarize(phone: PhoneRecord): PhoneSummary {
    const online = [...this.peers].some(
      (peer) => peer.identity.role === 'phone' && peer.identity.phoneId === phone.id,
    );
    return { id: phone.id, name: phone.name, online, createdAt: phone.createdAt };
  }

  private broadcastStatus(desktopId: string): void {
    const desktopOnline = this.desktopPeers(desktopId).length > 0;
    const phones = this.listPhones(desktopId);
    for (const peer of this.peers) {
      if (peer.identity.desktopId !== desktopId) continue;
      peer.send(
        peer.identity.role === 'desktop'
          ? { type: 'connection-status', desktopOnline, phones }
          : { type: 'connection-status', desktopOnline },
      );
    }
  }

  private sendError(peer: Peer, message: string, code: ErrorCode, scanId?: string): void {
    peer.send({ type: 'error', message, code, ...(scanId ? { scanId } : {}) });
  }

  private sendRaw(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  private pruneScans(): void {
    const cutoff = Date.now() - SCAN_MEMORY_MS;
    for (const [key, record] of this.scans) {
      if (record.at >= cutoff) break; // insertion-ordered, so the rest are newer
      this.scans.delete(key);
    }
  }

  /** Terminates sockets that stopped answering pings, which otherwise look online forever. */
  private tick(): void {
    for (const socket of this.wss?.clients ?? []) {
      if (!this.alive.has(socket)) {
        socket.terminate();
        continue;
      }
      this.alive.delete(socket);
      socket.ping();
    }
    this.pruneScans();
  }
}
