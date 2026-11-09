import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { PairingStore } from './pairing.js';
import { WsHandler } from './ws-handler.js';
import type {
  AuthMessage,
  AuthResult,
  PairRequest,
  PairResponse,
  QrImagePayload,
  QrAck,
  ErrorMessage,
  ConnectionStatus,
} from '@qr2win/shared-types';

// ─── Helpers ───────────────────────────────────────────────────────────

const messageQueues = new WeakMap<
  WebSocket,
  {
    queue: any[];
    waiters: { resolve: (msg: any) => void; reject: (err: any) => void; timeout: NodeJS.Timeout }[];
  }
>();

function setupWsQueue(ws: WebSocket) {
  const state = {
    queue: [] as any[],
    waiters: [] as { resolve: (msg: any) => void; reject: (err: any) => void; timeout: NodeJS.Timeout }[],
  };
  messageQueues.set(ws, state);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (state.waiters.length > 0) {
        const waiter = state.waiters.shift()!;
        clearTimeout(waiter.timeout);
        waiter.resolve(msg);
      } else {
        state.queue.push(msg);
      }
    } catch {
      // ignore JSON parse error in tests
    }
  });
}

function waitForMessage(ws: WebSocket, timeoutMs = 5000): Promise<any> {
  const state = messageQueues.get(ws);
  if (!state) {
    throw new Error('WebSocket not registered in message queue');
  }

  if (state.queue.length > 0) {
    return Promise.resolve(state.queue.shift());
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const idx = state.waiters.findIndex((w) => w.resolve === resolve);
      if (idx !== -1) state.waiters.splice(idx, 1);
      reject(new Error('Message timeout'));
    }, timeoutMs);

    state.waiters.push({ resolve, reject, timeout });
  });
}

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    setupWsQueue(ws);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function makeTestQrPayload(overrides: Partial<QrImagePayload> = {}): QrImagePayload {
  // 1x1 red PNG pixel as base64
  const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
  return {
    type: 'qr-image',
    scanId: `scan-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    timestamp: Date.now(),
    mimeType: 'image/png',
    width: 100,
    height: 100,
    imageBase64: tinyPng,
    decodedText: 'https://example.com',
    ...overrides,
  };
}

// ─── Test suite ────────────────────────────────────────────────────────

describe('PairingStore', () => {
  let store: PairingStore;

  beforeEach(() => {
    store = new PairingStore();
  });

  it('generates a pairing code of correct length', () => {
    const { code } = store.generateCode('desktop-1');
    expect(code).toHaveLength(6);
    expect(/^\d{6}$/.test(code)).toBe(true);
  });

  it('pairs successfully with valid code', () => {
    const { code } = store.generateCode('desktop-1');
    const result = store.pair(code, 'My Phone');
    expect(result).not.toBeNull();
    expect(result!.token).toBeTruthy();
    expect(result!.desktopDeviceId).toBe('desktop-1');
  });

  it('rejects invalid code', () => {
    const result = store.pair('000000', 'Phone');
    expect(result).toBeNull();
  });

  it('rejects reused code', () => {
    const { code } = store.generateCode('desktop-1');
    store.pair(code, 'Phone');
    const result = store.pair(code, 'Phone 2');
    expect(result).toBeNull();
  });

  it('validates token after pairing', () => {
    const { code } = store.generateCode('desktop-1');
    const paired = store.pair(code, 'Phone')!;
    const device = store.validate(paired.token);
    expect(device).not.toBeNull();
    expect(device!.desktopDeviceId).toBe('desktop-1');
  });

  it('revokes token', () => {
    const { code } = store.generateCode('desktop-1');
    const paired = store.pair(code, 'Phone')!;
    expect(store.revoke(paired.token)).toBe(true);
    expect(store.validate(paired.token)).toBeNull();
  });

  it('enforces rate limit', () => {
    const { code } = store.generateCode('desktop-1');
    const paired = store.pair(code, 'Phone')!;
    for (let i = 0; i < 30; i++) {
      expect(store.checkRateLimit(paired.token)).toBe(true);
    }
    expect(store.checkRateLimit(paired.token)).toBe(false);
  });

  it('lists devices for desktop', () => {
    const { code: code1 } = store.generateCode('desktop-1');
    const { code: code2 } = store.generateCode('desktop-1');
    store.pair(code1, 'Phone A');
    store.pair(code2, 'Phone B');
    const devices = store.getDevicesForDesktop('desktop-1');
    expect(devices).toHaveLength(2);
  });
});

describe('WebSocket Handler', () => {
  let server: http.Server;
  let wss: WebSocketServer;
  let store: PairingStore;
  let handler: WsHandler;
  let port: number;

  beforeAll(async () => {
    store = new PairingStore();
    const app = express();
    server = http.createServer(app);
    wss = new WebSocketServer({ server, path: '/ws' });
    handler = new WsHandler(store);
    wss.on('connection', (ws) => handler.handleConnection(ws));

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        port = (server.address() as any).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    handler.destroy();
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    store.clear();
  });

  it('rejects unauthenticated messages', async () => {
    const ws = await connectWs(port);
    ws.send(JSON.stringify({ type: 'qr-image', scanId: '123' }));
    const msg: ErrorMessage = await waitForMessage(ws);
    expect(msg.type).toBe('error');
    expect(msg.code).toBe('NOT_AUTHENTICATED');
    ws.close();
  });

  it('rejects invalid token', async () => {
    const ws = await connectWs(port);
    const auth: AuthMessage = { type: 'auth', token: 'invalid-token', role: 'phone' };
    ws.send(JSON.stringify(auth));
    const msg: AuthResult = await waitForMessage(ws);
    expect(msg.type).toBe('auth-result');
    expect(msg.success).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    ws.close();
  });

  it('authenticates with valid token', async () => {
    const { code } = store.generateCode('desktop-1');
    const paired = store.pair(code, 'Phone')!;

    const ws = await connectWs(port);
    const auth: AuthMessage = { type: 'auth', token: paired.token, role: 'phone' };
    ws.send(JSON.stringify(auth));

    const result: AuthResult = await waitForMessage(ws);
    expect(result.type).toBe('auth-result');
    expect(result.success).toBe(true);
    ws.close();
  });

  it('handles pairing via WebSocket', async () => {
    store.generateCode('desktop-1');
    const { code } = store.generateCode('desktop-2');

    const ws = await connectWs(port);
    const pairReq: PairRequest = {
      type: 'pair-request',
      code,
      deviceName: 'WS Phone',
    };
    ws.send(JSON.stringify(pairReq));

    const response: PairResponse = await waitForMessage(ws);
    expect(response.type).toBe('pair-response');
    expect(response.success).toBe(true);
    expect(response.token).toBeTruthy();
    ws.close();
  });

  it('delivers QR image from phone to desktop', async () => {
    const { code } = store.generateCode('desktop-1');
    const paired = store.pair(code, 'Phone')!;

    // Connect desktop
    const desktopWs = await connectWs(port);
    const desktopAuth: AuthMessage = { type: 'auth', token: paired.token, role: 'desktop' };
    desktopWs.send(JSON.stringify(desktopAuth));
    await waitForMessage(desktopWs); // auth-result
    await waitForMessage(desktopWs); // connection-status

    // Connect phone
    const phoneWs = await connectWs(port);
    const phoneAuth: AuthMessage = { type: 'auth', token: paired.token, role: 'phone' };
    phoneWs.send(JSON.stringify(phoneAuth));
    await waitForMessage(phoneWs); // auth-result
    await waitForMessage(phoneWs); // connection-status

    // Phone sends QR
    const payload = makeTestQrPayload();
    phoneWs.send(JSON.stringify(payload));

    // Desktop receives QR
    const received: QrImagePayload = await waitForMessage(desktopWs);
    expect(received.type).toBe('qr-image');
    expect(received.scanId).toBe(payload.scanId);
    expect(received.imageBase64).toBe(payload.imageBase64);

    // Phone receives ACK
    const ack: QrAck = await waitForMessage(phoneWs);
    expect(ack.type).toBe('qr-ack');
    expect(ack.scanId).toBe(payload.scanId);

    desktopWs.close();
    phoneWs.close();
  });

  it('deduplicates same scanId', async () => {
    const { code } = store.generateCode('desktop-1');
    const paired = store.pair(code, 'Phone')!;

    // Connect desktop so message is delivered
    const desktopWs = await connectWs(port);
    const desktopAuth: AuthMessage = { type: 'auth', token: paired.token, role: 'desktop' };
    desktopWs.send(JSON.stringify(desktopAuth));
    await waitForMessage(desktopWs); // auth-result
    await waitForMessage(desktopWs); // connection-status

    const phoneWs = await connectWs(port);
    const phoneAuth: AuthMessage = { type: 'auth', token: paired.token, role: 'phone' };
    phoneWs.send(JSON.stringify(phoneAuth));
    await waitForMessage(phoneWs); // auth-result
    await waitForMessage(phoneWs); // connection-status

    const payload = makeTestQrPayload();

    // Send twice with same scanId
    phoneWs.send(JSON.stringify(payload));
    const desktopMsg = await waitForMessage(desktopWs);
    expect(desktopMsg.type).toBe('qr-image');

    const ack1 = await waitForMessage(phoneWs);
    expect(ack1.type).toBe('qr-ack');

    phoneWs.send(JSON.stringify(payload));
    const ack2 = await waitForMessage(phoneWs);
    expect(ack2.type).toBe('qr-ack');

    // Desktop should not receive a duplicate
    const noDuplicate = await Promise.race([
      waitForMessage(desktopWs).then(() => 'duplicate_received'),
      new Promise((r) => setTimeout(() => r('no_duplicate'), 300)),
    ]);
    expect(noDuplicate).toBe('no_duplicate');

    desktopWs.close();
    phoneWs.close();
  });

  it('rejects oversized image payload', async () => {
    const { code } = store.generateCode('desktop-1');
    const paired = store.pair(code, 'Phone')!;

    const phoneWs = await connectWs(port);
    const phoneAuth: AuthMessage = { type: 'auth', token: paired.token, role: 'phone' };
    phoneWs.send(JSON.stringify(phoneAuth));
    await waitForMessage(phoneWs); // auth-result
    await waitForMessage(phoneWs); // connection-status

    // Create a payload with too-large image (>5MB)
    const hugeBase64 = 'A'.repeat(8_000_000); // ~6MB
    const payload = makeTestQrPayload({ imageBase64: hugeBase64 });
    phoneWs.send(JSON.stringify(payload));

    const err: ErrorMessage = await waitForMessage(phoneWs);
    expect(err.type).toBe('error');
    expect(['INVALID_PAYLOAD', 'PAYLOAD_TOO_LARGE']).toContain(err.code);
    phoneWs.close();
  });

  it('rejects invalid MIME type', async () => {
    const { code } = store.generateCode('desktop-1');
    const paired = store.pair(code, 'Phone')!;

    const phoneWs = await connectWs(port);
    const phoneAuth: AuthMessage = { type: 'auth', token: paired.token, role: 'phone' };
    phoneWs.send(JSON.stringify(phoneAuth));
    await waitForMessage(phoneWs); // auth-result
    await waitForMessage(phoneWs); // connection-status

    const payload = makeTestQrPayload({ mimeType: 'image/gif' as any });
    phoneWs.send(JSON.stringify(payload));

    const err: ErrorMessage = await waitForMessage(phoneWs);
    expect(err.type).toBe('error');
    expect(err.code).toBe('INVALID_PAYLOAD');
    phoneWs.close();
  });

  it('rejects desktop trying to send QR image', async () => {
    const { code } = store.generateCode('desktop-1');
    const paired = store.pair(code, 'Phone')!;

    const desktopWs = await connectWs(port);
    const desktopAuth: AuthMessage = { type: 'auth', token: paired.token, role: 'desktop' };
    desktopWs.send(JSON.stringify(desktopAuth));
    await waitForMessage(desktopWs); // auth-result
    await waitForMessage(desktopWs); // connection-status

    const payload = makeTestQrPayload();
    desktopWs.send(JSON.stringify(payload));

    const err: ErrorMessage = await waitForMessage(desktopWs);
    expect(err.type).toBe('error');
    expect(err.code).toBe('INVALID_ROLE');
    desktopWs.close();
  });

  it('notifies phone when desktop is offline', async () => {
    const { code } = store.generateCode('desktop-1');
    const paired = store.pair(code, 'Phone')!;

    // Only connect phone, no desktop
    const phoneWs = await connectWs(port);
    const phoneAuth: AuthMessage = { type: 'auth', token: paired.token, role: 'phone' };
    phoneWs.send(JSON.stringify(phoneAuth));
    await waitForMessage(phoneWs); // auth-result
    await waitForMessage(phoneWs); // connection-status

    const payload = makeTestQrPayload();
    phoneWs.send(JSON.stringify(payload));

    // Should get ACK + desktop offline error
    const msg1 = await waitForMessage(phoneWs);
    const msg2 = await waitForMessage(phoneWs);
    const messages = [msg1, msg2];
    expect(messages.some((m: any) => m.type === 'qr-ack')).toBe(true);
    expect(messages.some((m: any) => m.type === 'error' && m.code === 'DESKTOP_OFFLINE')).toBe(true);
    phoneWs.close();
  });

  it('does not route QR to wrong desktop', async () => {
    // Set up two separate desktop/phone pairs
    const { code: code1 } = store.generateCode('desktop-1');
    const paired1 = store.pair(code1, 'Phone 1')!;

    const { code: code2 } = store.generateCode('desktop-2');
    const paired2 = store.pair(code2, 'Phone 2')!;

    // Connect desktop-2
    const desktop2Ws = await connectWs(port);
    const d2Auth: AuthMessage = { type: 'auth', token: paired2.token, role: 'desktop' };
    desktop2Ws.send(JSON.stringify(d2Auth));
    await waitForMessage(desktop2Ws); // auth-result
    await waitForMessage(desktop2Ws); // connection-status

    // Connect phone-1 (paired to desktop-1)
    const phone1Ws = await connectWs(port);
    const p1Auth: AuthMessage = { type: 'auth', token: paired1.token, role: 'phone' };
    phone1Ws.send(JSON.stringify(p1Auth));
    await waitForMessage(phone1Ws); // auth-result
    await waitForMessage(phone1Ws); // connection-status

    // Phone-1 sends QR – should NOT go to desktop-2
    const payload = makeTestQrPayload();
    phone1Ws.send(JSON.stringify(payload));

    // Phone should get desktop offline (desktop-1 not connected)
    const msg1 = await waitForMessage(phone1Ws);
    const msg2 = await waitForMessage(phone1Ws);
    const messages = [msg1, msg2];
    expect(messages.some((m: any) => m.code === 'DESKTOP_OFFLINE')).toBe(true);

    // Desktop-2 should NOT receive anything (wait briefly)
    const noMsg = await Promise.race([
      waitForMessage(desktop2Ws).then(() => 'received'),
      new Promise((r) => setTimeout(() => r('timeout'), 500)),
    ]);
    expect(noMsg).toBe('timeout');

    desktop2Ws.close();
    phone1Ws.close();
  });
});

