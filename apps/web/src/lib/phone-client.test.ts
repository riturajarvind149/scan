// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WS_CLOSE_UNAUTHORIZED, type QrImagePayload, type ServerMessage } from '@qr2win/shared-types';
import { PhoneClient } from './phone-client';

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 1;
  sent: { type: string; scanId?: string; token?: string }[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number }) => void;

  constructor() {
    FakeSocket.instances.push(this);
  }

  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }

  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }

  receive(message: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  scansSent() {
    return this.sent.filter((message) => message.type === 'qr-image').length;
  }
}

const payload = (scanId: string): QrImagePayload => ({
  type: 'qr-image',
  scanId,
  timestamp: 1,
  mimeType: 'image/png',
  width: 1,
  height: 1,
  imageBase64: 'AAAA',
  decodedText: 'text',
});

const latestSocket = () => FakeSocket.instances[FakeSocket.instances.length - 1];

function connectedClient() {
  const client = new PhoneClient('wss://relay.test/ws', 'token');
  client.start();
  const socket = latestSocket();
  socket.onopen?.();
  socket.receive({ type: 'auth-result', success: true, role: 'phone' });
  socket.receive({ type: 'connection-status', desktopOnline: true });
  return { client, socket };
}

describe('PhoneClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('authenticates and reports only delivered once the desktop confirms', () => {
    const { client, socket } = connectedClient();
    expect(socket.sent[0]).toEqual({ type: 'auth', token: 'token' });

    client.sendScan(payload('scan-0001'));
    expect(client.getSnapshot().scans[0].status).toBe('sending');

    socket.receive({ type: 'qr-ack', scanId: 'scan-0001' });
    expect(client.getSnapshot().scans[0].status).toBe('delivered');
    client.stop();
  });

  it('connects without a credential on a public link', () => {
    const client = new PhoneClient('wss://relay.test/ws', null);
    client.start();
    const socket = latestSocket();
    socket.onopen?.();
    expect(socket.sent[0]).toEqual({ type: 'auth' });
    client.stop();
  });

  it('holds a scan while the laptop is offline and sends it when it returns', () => {
    const { client, socket } = connectedClient();
    socket.receive({ type: 'connection-status', desktopOnline: false });
    client.sendScan(payload('scan-0002'));
    socket.receive({ type: 'scan-deferred', scanId: 'scan-0002' });
    expect(client.getSnapshot().scans[0].status).toBe('waiting');
    expect(socket.scansSent()).toBe(1);

    socket.receive({ type: 'connection-status', desktopOnline: true });
    expect(socket.scansSent()).toBe(2);
    socket.receive({ type: 'qr-ack', scanId: 'scan-0002' });
    expect(client.getSnapshot().scans[0].status).toBe('delivered');
    client.stop();
  });

  it('queues scans made while disconnected and sends them after reconnecting', () => {
    const { client, socket } = connectedClient();
    socket.serverClose(1006);
    expect(client.getSnapshot().connection).toBe('connecting');

    client.sendScan(payload('scan-0003'));
    expect(client.getSnapshot().scans[0].status).toBe('waiting');

    vi.advanceTimersByTime(2000);
    const next = latestSocket();
    expect(next).not.toBe(socket);
    next.onopen?.();
    next.receive({ type: 'auth-result', success: true });
    next.receive({ type: 'connection-status', desktopOnline: true });
    expect(next.scansSent()).toBe(1);
    client.stop();
  });

  it('retries an unconfirmed scan, then gives up and says so', () => {
    const { client, socket } = connectedClient();
    client.sendScan(payload('scan-0004'));
    vi.advanceTimersByTime(10_000);
    vi.advanceTimersByTime(10_000);
    expect(socket.scansSent()).toBe(3);
    vi.advanceTimersByTime(10_000);
    expect(client.getSnapshot().scans[0].status).toBe('failed');
    client.stop();
  });

  it('surfaces a rejection for a specific scan', () => {
    const { client, socket } = connectedClient();
    client.sendScan(payload('scan-0005'));
    socket.receive({ type: 'error', code: 'SCANS_PAUSED', message: 'Scanning is paused', scanId: 'scan-0005' });
    const [scan] = client.getSnapshot().scans;
    expect(scan.status).toBe('failed');
    expect(scan.message).toMatch(/paused/);
    client.stop();
  });

  it('stops for good when the credential is revoked', () => {
    const { client, socket } = connectedClient();
    socket.serverClose(WS_CLOSE_UNAUTHORIZED);
    expect(client.getSnapshot().revoked).toBe(true);
    const count = FakeSocket.instances.length;
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.instances.length).toBe(count);
  });

  it('does not reconnect after stop', () => {
    const { client } = connectedClient();
    client.stop();
    const count = FakeSocket.instances.length;
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.instances.length).toBe(count);
  });

  it('treats an unanswered ping as a dead connection', () => {
    const { client, socket } = connectedClient();
    vi.advanceTimersByTime(25_000);
    expect(socket.sent.some((message) => message.type === 'ping')).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(client.getSnapshot().connection).toBe('connecting');
    vi.advanceTimersByTime(30_000);
    expect(latestSocket()).not.toBe(socket);
    client.stop();
  });
});
