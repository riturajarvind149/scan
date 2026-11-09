import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  MAX_IMAGE_BASE64_LENGTH,
  MAX_WS_MESSAGE_BYTES,
  RATE_LIMIT_SCANS_PER_MINUTE,
  WS_CLOSE_UNAUTHORIZED,
  type QrImagePayload,
  type ServerMessage,
} from '@qr2win/shared-types';
import { createRelay, type Relay } from './relay.js';
import { PairingStore } from './store.js';

const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

let counter = 0;
function scan(overrides: Partial<QrImagePayload> = {}): QrImagePayload {
  return {
    type: 'qr-image',
    scanId: `scan-test-${++counter}`,
    timestamp: Date.now(),
    mimeType: 'image/png',
    width: 1,
    height: 1,
    imageBase64: TINY_PNG,
    decodedText: 'https://example.com',
    ...overrides,
  };
}

/** A test client that queues every message so tests can await them in order. */
class Client {
  private queue: ServerMessage[] = [];
  private waiters: ((message: ServerMessage) => void)[] = [];
  closed: Promise<number>;

  constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.queue.push(message);
    });
    this.closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  }

  next(timeoutMs = 3000): Promise<ServerMessage> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const waiter = (message: ServerMessage) => {
        clearTimeout(timer);
        resolve(message);
      };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error('Timed out waiting for a message'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** Reads messages until one of the given type arrives, skipping presence updates and the like. */
  async nextOfType<T extends ServerMessage['type']>(type: T): Promise<Extract<ServerMessage, { type: T }>> {
    for (;;) {
      const message = await this.next();
      if (message.type === type) return message as Extract<ServerMessage, { type: T }>;
    }
  }

  async silentFor(ms: number, type: ServerMessage['type']): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      try {
        const message = await this.next(Math.max(1, deadline - Date.now()));
        if (message.type === type) return false;
      } catch {
        return true;
      }
    }
    return true;
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }
}

describe('relay', () => {
  let relay: Relay;
  let store: PairingStore;
  let server: http.Server;
  let base: string;
  let clients: Client[];

  async function start(dataFile?: string): Promise<void> {
    store = new PairingStore(dataFile);
    relay = createRelay({ store });
    server = http.createServer(relay.app);
    relay.hub.attach(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async function stop(): Promise<void> {
    for (const client of clients) client.ws.terminate();
    clients = [];
    await relay.hub.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  function post(pathname: string, body?: unknown, token?: string, ip?: string): Promise<Response> {
    return fetch(`http://${base}${pathname}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(ip ? { 'X-Forwarded-For': ip } : {}),
      },
      body: JSON.stringify(body ?? {}),
    });
  }

  async function registerDesktop(): Promise<{ desktopId: string; token: string }> {
    const res = await post('/api/desktops/register');
    expect(res.status).toBe(201);
    return (await res.json()) as { desktopId: string; token: string };
  }

  async function pairPhone(desktopToken: string): Promise<{ token: string; phoneId: string }> {
    const generated = await post('/api/pairing/generate', {}, desktopToken);
    const { code } = (await generated.json()) as { code: string };
    const res = await post('/api/pairing/pair', { code, deviceName: 'Test phone' });
    expect(res.status).toBe(200);
    return (await res.json()) as { token: string; phoneId: string };
  }

  async function connect(token?: string): Promise<Client> {
    const ws = new WebSocket(`ws://${base}/ws`);
    const client = new Client(ws);
    clients.push(client);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    if (token) {
      client.send({ type: 'auth', token });
      const result = await client.nextOfType('auth-result');
      expect(result.success).toBe(true);
    }
    return client;
  }

  /** The complete real flow: desktop registers, phone pairs with a code, both connect. */
  async function pairedClients() {
    const desktop = await registerDesktop();
    const phone = await pairPhone(desktop.token);
    return {
      desktop: await connect(desktop.token),
      phone: await connect(phone.token),
      desktopToken: desktop.token,
      phoneToken: phone.token,
      phoneId: phone.phoneId,
    };
  }

  beforeEach(async () => {
    clients = [];
    await start();
  });

  afterEach(stop);

  describe('pairing', () => {
    it('delivers a scan to a desktop using only credentials from the real pairing flow', async () => {
      const { desktop, phone } = await pairedClients();
      const payload = scan();
      phone.send(payload);

      const received = await desktop.nextOfType('qr-image');
      expect(received.imageBase64).toBe(TINY_PNG);
      expect(received.scanId).toBe(payload.scanId);
    });

    it('derives the role from the credential, ignoring any claimed role', async () => {
      const { phoneToken, desktop } = await pairedClients();
      const impostor = await connect();
      impostor.send({ type: 'auth', token: phoneToken, role: 'desktop' });
      const result = await impostor.nextOfType('auth-result');
      expect(result.role).toBe('phone');

      // A second phone connection must not receive scans meant for the desktop.
      const other = await connect(phoneToken);
      other.send(scan());
      await desktop.nextOfType('qr-image');
      expect(await impostor.silentFor(200, 'qr-image')).toBe(true);
    });

    it('requires a desktop credential to generate a pairing code', async () => {
      expect((await post('/api/pairing/generate')).status).toBe(401);
      const desktop = await registerDesktop();
      const { token: phoneToken } = await pairPhone(desktop.token);
      expect((await post('/api/pairing/generate', {}, phoneToken)).status).toBe(401);
    });

    it('rejects wrong and reused codes', async () => {
      const desktop = await registerDesktop();
      const { code } = (await (await post('/api/pairing/generate', {}, desktop.token)).json()) as { code: string };
      const wrong = code === '000000' ? '000001' : '000000';
      expect((await post('/api/pairing/pair', { code: wrong })).status).toBe(400);
      expect((await post('/api/pairing/pair', { code })).status).toBe(200);
      expect((await post('/api/pairing/pair', { code })).status).toBe(400);
    });

    it('expires codes', async () => {
      const desktop = store.registerDesktop();
      const { code } = store.issueCode(desktop.desktopId);
      const realNow = Date.now;
      Date.now = () => realNow() + 6 * 60 * 1000;
      try {
        expect(store.redeemCode(code, 'Phone')).toBeNull();
      } finally {
        Date.now = realNow;
      }
    });

    it('invalidates the previous code when a new one is generated', async () => {
      const { desktopId } = store.registerDesktop();
      const first = store.issueCode(desktopId);
      const second = store.issueCode(desktopId);
      if (first.code !== second.code) expect(store.redeemCode(first.code, 'Phone')).toBeNull();
      expect(store.redeemCode(second.code, 'Phone')).not.toBeNull();
    });

    it('throttles code guessing', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) {
        statuses.push((await post('/api/pairing/pair', { code: '999999' })).status);
      }
      expect(statuses.slice(0, 10).every((status) => status === 400)).toBe(true);
      expect(statuses.slice(10).every((status) => status === 429)).toBe(true);
    });

    it('announces a new phone to its desktop', async () => {
      const desktop = await registerDesktop();
      const desktopClient = await connect(desktop.token);
      await pairPhone(desktop.token);
      const event = await desktopClient.nextOfType('phone-paired');
      expect(event.phone.name).toBe('Test phone');
    });
  });

  describe('revocation', () => {
    it('drops the live connection and refuses the credential afterwards', async () => {
      const { phone, phoneToken, phoneId, desktopToken } = await pairedClients();
      const res = await fetch(`http://${base}/api/phones/${phoneId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${desktopToken}` },
      });
      expect(res.status).toBe(200);
      expect(await phone.closed).toBe(WS_CLOSE_UNAUTHORIZED);

      const retry = await connect();
      retry.send({ type: 'auth', token: phoneToken });
      expect((await retry.nextOfType('auth-result')).success).toBe(false);
      expect(await retry.closed).toBe(WS_CLOSE_UNAUTHORIZED);
    });

    it('lets a phone unpair itself', async () => {
      const { phone, phoneToken } = await pairedClients();
      expect((await post('/api/pairing/unpair', {}, phoneToken)).status).toBe(200);
      expect(await phone.closed).toBe(WS_CLOSE_UNAUTHORIZED);
    });

    it("does not let a desktop revoke another desktop's phone", async () => {
      const { phoneId } = await pairedClients();
      const stranger = await registerDesktop();
      const res = await fetch(`http://${base}/api/phones/${phoneId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${stranger.token}` },
      });
      expect(res.status).toBe(404);
    });
  });

  describe('scan delivery', () => {
    it('acks the phone only after the desktop confirms receipt', async () => {
      const { desktop, phone } = await pairedClients();
      const payload = scan();
      phone.send(payload);
      await desktop.nextOfType('qr-image');
      expect(await phone.silentFor(150, 'qr-ack')).toBe(true);

      desktop.send({ type: 'qr-ack', scanId: payload.scanId });
      expect((await phone.nextOfType('qr-ack')).scanId).toBe(payload.scanId);
    });

    it('defers instead of claiming delivery when the desktop is offline, then succeeds on retry', async () => {
      const desktop = await registerDesktop();
      const { token } = await pairPhone(desktop.token);
      const phone = await connect(token);
      const payload = scan();

      phone.send(payload);
      expect((await phone.nextOfType('scan-deferred')).scanId).toBe(payload.scanId);

      const desktopClient = await connect(desktop.token);
      const status = await phone.nextOfType('connection-status');
      expect(status.desktopOnline).toBe(true);

      phone.send(payload);
      expect((await desktopClient.nextOfType('qr-image')).scanId).toBe(payload.scanId);
    });

    it('reports the desktop going offline to its phones', async () => {
      const { desktop, phone } = await pairedClients();
      await phone.nextOfType('connection-status');
      desktop.ws.close();
      for (;;) {
        const status = await phone.nextOfType('connection-status');
        if (!status.desktopOnline) break;
      }
    });

    it('does not show a retried scan twice once acknowledged', async () => {
      const { desktop, phone } = await pairedClients();
      const payload = scan();
      phone.send(payload);
      await desktop.nextOfType('qr-image');
      desktop.send({ type: 'qr-ack', scanId: payload.scanId });
      await phone.nextOfType('qr-ack');

      phone.send(payload);
      await phone.nextOfType('qr-ack');
      expect(await desktop.silentFor(200, 'qr-image')).toBe(true);
    });

    it('never routes a scan to another desktop', async () => {
      const first = await pairedClients();
      const second = await pairedClients();
      first.phone.send(scan());
      await first.desktop.nextOfType('qr-image');
      expect(await second.desktop.silentFor(200, 'qr-image')).toBe(true);
    });

    it('rejects scans sent by a desktop', async () => {
      const { desktop } = await pairedClients();
      desktop.send(scan());
      expect((await desktop.nextOfType('error')).code).toBe('INVALID_ROLE');
    });

    it('rejects messages before authentication', async () => {
      const client = await connect();
      client.send(scan());
      expect((await client.nextOfType('error')).code).toBe('NOT_AUTHENTICATED');
    });

    it('rate limits scans per phone', async () => {
      const { desktop, phone } = await pairedClients();
      for (let i = 0; i < RATE_LIMIT_SCANS_PER_MINUTE; i++) phone.send(scan());
      for (let i = 0; i < RATE_LIMIT_SCANS_PER_MINUTE; i++) await desktop.nextOfType('qr-image');
      const rejected = scan();
      phone.send(rejected);
      const error = await phone.nextOfType('error');
      expect(error.code).toBe('RATE_LIMIT');
      expect(error.scanId).toBe(rejected.scanId);
    });

    it('survives garbage input', async () => {
      const { phone, desktop } = await pairedClients();
      phone.ws.send('not json');
      expect((await phone.nextOfType('error')).code).toBe('INVALID_FORMAT');
      phone.ws.send('null');
      expect((await phone.nextOfType('error')).code).toBe('INVALID_FORMAT');
      phone.send({ type: 'qr-image' });
      expect((await phone.nextOfType('error')).code).toBe('INVALID_PAYLOAD');
      phone.send({ type: 'nonsense' });
      expect((await phone.nextOfType('error')).code).toBe('UNKNOWN_TYPE');

      phone.send(scan());
      await desktop.nextOfType('qr-image');
    });

    it('answers application-level pings', async () => {
      const { phone } = await pairedClients();
      phone.send({ type: 'ping' });
      await phone.nextOfType('pong');
    });
  });

  describe('payload limits', () => {
    it('rejects a disguised non-image', async () => {
      const { phone } = await pairedClients();
      const payload = scan({ imageBase64: Buffer.from('<script>alert(1)</script>').toString('base64') });
      phone.send(payload);
      const error = await phone.nextOfType('error');
      expect(error.code).toBe('INVALID_PAYLOAD');
      expect(error.scanId).toBe(payload.scanId);
    });

    it('rejects a disallowed MIME type', async () => {
      const { phone } = await pairedClients();
      phone.send(scan({ mimeType: 'image/gif' as QrImagePayload['mimeType'] }));
      expect((await phone.nextOfType('error')).code).toBe('INVALID_PAYLOAD');
    });

    it('accepts an image right at the 5 MB limit', async () => {
      const { phone, desktop } = await pairedClients();
      const padding = 'A'.repeat(MAX_IMAGE_BASE64_LENGTH - TINY_PNG.length + 2);
      phone.send(scan({ imageBase64: TINY_PNG.replace(/=+$/, '') + padding.slice(0, padding.length - (padding.length + TINY_PNG.replace(/=+$/, '').length) % 4) }));
      await desktop.nextOfType('qr-image');
    });

    it('rejects an image over the limit that still fits in a frame', async () => {
      const { phone } = await pairedClients();
      phone.send(scan({ imageBase64: TINY_PNG.replace(/=+$/, '') + 'A'.repeat(MAX_IMAGE_BASE64_LENGTH) }));
      expect((await phone.nextOfType('error')).code).toBe('INVALID_PAYLOAD');
    });

    it('closes the connection on a frame over the hard limit', async () => {
      const { phone } = await pairedClients();
      phone.send(scan({ imageBase64: 'A'.repeat(MAX_WS_MESSAGE_BYTES + 1) }));
      expect(await phone.closed).toBe(1009);
    });
  });

  describe('persistence', () => {
    it('keeps pairings across a restart and never stores raw tokens', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr2win-'));
      const dataFile = path.join(dir, 'nested', 'pairings.json');
      await stop();
      await start(dataFile);

      const desktop = await registerDesktop();
      const phone = await pairPhone(desktop.token);
      store.flush();

      const onDisk = fs.readFileSync(dataFile, 'utf-8');
      expect(onDisk).not.toContain(desktop.token);
      expect(onDisk).not.toContain(phone.token);

      await stop();
      await start(dataFile);
      const desktopClient = await connect(desktop.token);
      const phoneClient = await connect(phone.token);
      const payload = scan();
      phoneClient.send(payload);
      expect((await desktopClient.nextOfType('qr-image')).scanId).toBe(payload.scanId);

      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('starts cleanly from a corrupt data file', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr2win-'));
      const dataFile = path.join(dir, 'pairings.json');
      fs.writeFileSync(dataFile, '{ not json');
      expect(() => new PairingStore(dataFile)).not.toThrow();
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('embedded local desktop', () => {
    it('speaks the same protocol as a remote desktop', async () => {
      const desktopId = store.ensureLocalDesktop();
      expect(store.ensureLocalDesktop()).toBe(desktopId);

      const received: ServerMessage[] = [];
      const local = relay.hub.connectLocalDesktop(desktopId, (message) => received.push(message));

      const { code } = store.issueCode(desktopId);
      const res = await post('/api/pairing/pair', { code, deviceName: 'Wi-Fi phone' });
      const { token } = (await res.json()) as { token: string };
      const phone = await connect(token);

      const payload = scan();
      phone.send(payload);
      await expect.poll(() => received.some((message) => message.type === 'qr-image')).toBe(true);
      expect(received.some((message) => message.type === 'phone-paired')).toBe(true);

      local.send({ type: 'qr-ack', scanId: payload.scanId });
      await phone.nextOfType('qr-ack');

      local.disconnect();
      for (;;) {
        const status = await phone.nextOfType('connection-status');
        if (!status.desktopOnline) break;
      }
    });
  });

  describe('http surface', () => {
    it('serves health and security headers', async () => {
      const res = await fetch(`http://${base}/health`);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
      expect(res.headers.get('x-powered-by')).toBeNull();
    });

    it('answers bad JSON with a 400 rather than a stack trace', async () => {
      const res = await fetch(`http://${base}/api/pairing/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{ nope',
      });
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain('SyntaxError');
    });

    it('can refuse desktop registration on a local relay', async () => {
      const localRelay = createRelay({ store: new PairingStore(), allowDesktopRegistration: false });
      const localServer = http.createServer(localRelay.app);
      await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve));
      const { port } = localServer.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/api/desktops/register`, { method: 'POST' });
      expect(res.status).toBe(404);
      await localRelay.hub.close();
      await new Promise<void>((resolve) => localServer.close(() => resolve()));
    });
  });
});
