import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { OPEN_CONNECTIONS_PER_IP, WS_CLOSE_UNAUTHORIZED, type AdminState, type QrImagePayload, type ServerMessage } from '@qr2win/shared-types';
import { createRelay, type Relay } from './relay.js';
import { PairingStore, type RemoteStorage } from './store.js';

const SECRET = 's'.repeat(32);
const PASSWORD = 'correct-horse';
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

let counter = 0;
function scan(): QrImagePayload {
  return {
    type: 'qr-image',
    scanId: `open-test-${++counter}`,
    timestamp: Date.now(),
    mimeType: 'image/png',
    width: 1,
    height: 1,
    imageBase64: TINY_PNG,
    decodedText: 'https://example.com',
  };
}

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
        if ((await this.next(Math.max(1, deadline - Date.now()))).type === type) return false;
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

describe('open relay', () => {
  let relay: Relay;
  let store: PairingStore;
  let server: http.Server;
  let base: string;
  let clients: Client[];

  async function start(options: { remote?: RemoteStorage; adminPassword?: string | null } = {}): Promise<void> {
    store = new PairingStore(undefined, SECRET, { sharedAccount: true, remote: options.remote });
    await store.restore();
    const adminPassword = options.adminPassword === null ? undefined : options.adminPassword ?? PASSWORD;
    relay = createRelay({ store, mode: 'open', adminPassword, downloadUrl: 'https://example.com/setup.exe' });
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

  function call(method: string, pathname: string, body?: unknown, token?: string): Promise<Response> {
    return fetch(`http://${base}${pathname}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function signIn(): Promise<string> {
    const res = await call('POST', '/api/admin/login', { password: PASSWORD });
    expect(res.status).toBe(200);
    return ((await res.json()) as { token: string }).token;
  }

  async function createInvite(admin: string): Promise<string> {
    const res = await call('POST', '/api/admin/invite', {}, admin);
    return ((await res.json()) as AdminState).invite!.token;
  }

  async function joinLaptop(invite: string, name = 'Work laptop'): Promise<{ token: string; id: string }> {
    const res = await call('POST', '/api/desktops/join', { invite, name });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; desktopId: string };
    return { token: body.token, id: body.desktopId };
  }

  async function connect(token?: string): Promise<Client> {
    const ws = new WebSocket(`ws://${base}/ws`);
    const client = new Client(ws);
    clients.push(client);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    client.send(token ? { type: 'auth', token } : { type: 'auth' });
    return client;
  }

  async function connected(token?: string): Promise<Client> {
    const client = await connect(token);
    expect((await client.nextOfType('auth-result')).success).toBe(true);
    return client;
  }

  beforeEach(async () => {
    clients = [];
    await start();
  });

  afterEach(stop);

  describe('phones', () => {
    it('sends a scan from a phone with no credential to every laptop', async () => {
      const admin = await signIn();
      const invite = await createInvite(admin);
      const first = await connected((await joinLaptop(invite, 'First')).token);
      const second = await connected((await joinLaptop(invite, 'Second')).token);
      const phone = await connected();

      const payload = scan();
      phone.send(payload);
      expect((await first.nextOfType('qr-image')).scanId).toBe(payload.scanId);
      expect((await second.nextOfType('qr-image')).scanId).toBe(payload.scanId);

      first.send({ type: 'qr-ack', scanId: payload.scanId });
      expect((await phone.nextOfType('qr-ack')).scanId).toBe(payload.scanId);
    });

    it('accepts scans from several phones at once', async () => {
      const laptop = await connected((await joinLaptop(await createInvite(await signIn()))).token);
      const phones = [await connected(), await connected()];
      for (const phone of phones) phone.send(scan());
      await laptop.nextOfType('qr-image');
      await laptop.nextOfType('qr-image');
    });

    it('never lets a phone with no credential receive scans', async () => {
      const laptop = await connected((await joinLaptop(await createInvite(await signIn()))).token);
      const sender = await connected();
      const bystander = await connected();
      sender.send(scan());
      await laptop.nextOfType('qr-image');
      expect(await bystander.silentFor(200, 'qr-image')).toBe(true);
    });

    it('holds its place when no laptop is online', async () => {
      const phone = await connected();
      const payload = scan();
      phone.send(payload);
      expect((await phone.nextOfType('scan-deferred')).scanId).toBe(payload.scanId);
    });

    it('delivers the ack after a phone reconnects and retries', async () => {
      const laptop = await connected((await joinLaptop(await createInvite(await signIn()))).token);
      const firstConnection = await connected();
      const payload = scan();
      firstConnection.send(payload);
      await laptop.nextOfType('qr-image');
      firstConnection.ws.close();
      await firstConnection.closed;

      const secondConnection = await connected();
      secondConnection.send(payload);
      await laptop.nextOfType('qr-image');
      laptop.send({ type: 'qr-ack', scanId: payload.scanId });
      expect((await secondConnection.nextOfType('qr-ack')).scanId).toBe(payload.scanId);
    });

    it('does not limit how many scans get through', async () => {
      const laptop = await connected((await joinLaptop(await createInvite(await signIn()))).token);
      const phone = await connected();
      const count = 300;
      for (let i = 0; i < count; i++) phone.send(scan());
      for (let i = 0; i < count; i++) await laptop.nextOfType('qr-image');
      phone.send({ type: 'ping' });
      expect(await phone.silentFor(100, 'error')).toBe(true);
    });

    describe('a clearer copy following a scan', () => {
      const enhanced = { mimeType: 'image/png' as const, width: 1, height: 1, imageBase64: TINY_PNG, method: 'squared up' };

      it('reaches every laptop after the scan itself', async () => {
        const invite = await createInvite(await signIn());
        const first = await connected((await joinLaptop(invite, 'One')).token);
        const second = await connected((await joinLaptop(invite, 'Two')).token);
        const phone = await connected();
        const payload = scan();
        phone.send(payload);
        await first.nextOfType('qr-image');
        await second.nextOfType('qr-image');

        phone.send({ type: 'qr-enhanced', scanId: payload.scanId, enhanced });
        expect((await first.nextOfType('qr-enhanced')).scanId).toBe(payload.scanId);
        expect((await second.nextOfType('qr-enhanced')).enhanced.method).toBe('squared up');
      });

      it('is ignored for a scan that was never sent', async () => {
        const laptop = await connected((await joinLaptop(await createInvite(await signIn()))).token);
        const phone = await connected();
        phone.send({ type: 'qr-enhanced', scanId: 'never-sent-0001', enhanced });
        expect(await laptop.silentFor(150, 'qr-enhanced')).toBe(true);
      });

      it("can't be attached to another phone's scan", async () => {
        const laptop = await connected((await joinLaptop(await createInvite(await signIn()))).token);
        const sender = await connected();
        const attacker = await connected();
        const payload = scan();
        sender.send(payload);
        await laptop.nextOfType('qr-image');
        attacker.send({ type: 'qr-enhanced', scanId: payload.scanId, enhanced });
        expect(await laptop.silentFor(150, 'qr-enhanced')).toBe(true);
      });

      it('is dropped if it is not a real image', async () => {
        const laptop = await connected((await joinLaptop(await createInvite(await signIn()))).token);
        const phone = await connected();
        const payload = scan();
        phone.send(payload);
        await laptop.nextOfType('qr-image');
        phone.send({ type: 'qr-enhanced', scanId: payload.scanId, enhanced: { ...enhanced, imageBase64: 'PGh0bWw+AAAAAAAA' } });
        expect(await laptop.silentFor(150, 'qr-enhanced')).toBe(true);
      });

      it('never comes from a laptop', async () => {
        const invite = await createInvite(await signIn());
        const first = await connected((await joinLaptop(invite, 'One')).token);
        const second = await connected((await joinLaptop(invite, 'Two')).token);
        const phone = await connected();
        const payload = scan();
        phone.send(payload);
        await second.nextOfType('qr-image');
        first.send({ type: 'qr-enhanced', scanId: payload.scanId, enhanced });
        expect(await second.silentFor(150, 'qr-enhanced')).toBe(true);
      });
    });

    it('carries the enhanced copy along with the original', async () => {
      const laptop = await connected((await joinLaptop(await createInvite(await signIn()))).token);
      const phone = await connected();
      const payload = { ...scan(), enhanced: { mimeType: 'image/png' as const, width: 1, height: 1, imageBase64: TINY_PNG, method: 'squared up' } };
      phone.send(payload);
      const received = await laptop.nextOfType('qr-image');
      expect(received.imageBase64).toBe(TINY_PNG);
      expect(received.enhanced?.method).toBe('squared up');
    });

    it('limits how many connections one address can hold open', async () => {
      for (let i = 0; i < OPEN_CONNECTIONS_PER_IP; i++) await connected();
      const extra = await connect();
      expect(await extra.closed).toBe(1013);
    });

    it('still validates what an anonymous phone sends', async () => {
      const phone = await connected();
      phone.send({ ...scan(), imageBase64: Buffer.from('<script>').toString('base64') });
      expect((await phone.nextOfType('error')).code).toBe('INVALID_PAYLOAD');
    });

    it('refuses scans while paused, and accepts them again after', async () => {
      const admin = await signIn();
      const laptop = await connected((await joinLaptop(await createInvite(admin))).token);
      const phone = await connected();

      await call('POST', '/api/admin/scanning', { paused: true }, admin);
      phone.send(scan());
      expect((await phone.nextOfType('error')).code).toBe('SCANS_PAUSED');
      expect(await laptop.silentFor(150, 'qr-image')).toBe(true);

      await call('POST', '/api/admin/scanning', { paused: false }, admin);
      phone.send(scan());
      await laptop.nextOfType('qr-image');
    });

    it('offers no phone pairing routes', async () => {
      expect((await call('POST', '/api/pairing/pair', { code: '123456' })).status).toBe(404);
    });
  });

  describe('laptops', () => {
    it('has no way to self-register, so a stranger can never receive scans', async () => {
      expect((await call('POST', '/api/desktops/register', {})).status).toBe(404);
      const res = await call('POST', '/api/desktops/join', { invite: 'made-up', name: 'Stranger' });
      expect(res.status).toBe(400);
    });

    it('does not accept a token signed for something else as an invite or laptop', async () => {
      const admin = await signIn();
      expect((await call('POST', '/api/desktops/join', { invite: admin })).status).toBe(400);

      const client = await connect(admin);
      expect((await client.nextOfType('auth-result')).success).toBe(false);
      const invite = await createInvite(admin);
      const withInvite = await connect(invite);
      expect((await withInvite.nextOfType('auth-result')).success).toBe(false);
    });

    it('authenticates a laptop as a desktop, not by anything it claims', async () => {
      const laptop = await joinLaptop(await createInvite(await signIn()));
      const client = await connect(laptop.token);
      expect((await client.nextOfType('auth-result')).role).toBe('desktop');
    });

    it('announces a new laptop to the others', async () => {
      const invite = await createInvite(await signIn());
      const first = await connected((await joinLaptop(invite, 'First')).token);
      await joinLaptop(invite, 'Second');
      expect((await first.nextOfType('laptop-joined')).name).toBe('Second');
    });

    it('cuts off a removed laptop at once and refuses it afterwards', async () => {
      const admin = await signIn();
      const laptop = await joinLaptop(await createInvite(admin));
      const client = await connected(laptop.token);

      const res = await call('DELETE', `/api/admin/laptops/${laptop.id}`, undefined, admin);
      expect(((await res.json()) as AdminState).laptops).toEqual([]);
      expect(await client.closed).toBe(WS_CLOSE_UNAUTHORIZED);

      const retry = await connect(laptop.token);
      expect((await retry.nextOfType('auth-result')).success).toBe(false);
    });

    it('still accepts a laptop credential from before invites, and it can be removed', async () => {
      const legacy = new PairingStore(undefined, SECRET);
      const { token, desktopId } = legacy.registerDesktop();
      const client = await connected(token);
      const admin = await signIn();

      const state = (await (await call('GET', '/api/admin/state', undefined, admin)).json()) as AdminState;
      expect(state.laptops).toMatchObject([{ id: desktopId, online: true }]);

      const phone = await connected();
      phone.send(scan());
      await client.nextOfType('qr-image');

      await call('DELETE', `/api/admin/laptops/${desktopId}`, undefined, admin);
      expect(await client.closed).toBe(WS_CLOSE_UNAUTHORIZED);
    });

    it('keeps a laptop working after a restart on an empty disk, with its name', async () => {
      const laptop = await joinLaptop(await createInvite(await signIn()), 'Work laptop');
      await stop();
      await start();
      await connected(laptop.token);
      const state = (await (await call('GET', '/api/admin/state', undefined, await signIn())).json()) as AdminState;
      expect(state.laptops).toMatchObject([{ name: 'Work laptop', online: true }]);
    });
  });

  describe('invites', () => {
    it('works for several laptops until replaced', async () => {
      const admin = await signIn();
      const first = await createInvite(admin);
      await joinLaptop(first, 'One');
      await joinLaptop(first, 'Two');

      await createInvite(admin);
      expect((await call('POST', '/api/desktops/join', { invite: first })).status).toBe(400);
      expect(await (await call('GET', `/api/invites/${first}`)).json()).toEqual({ valid: false });
    });

    it('can be cancelled', async () => {
      const admin = await signIn();
      const invite = await createInvite(admin);
      const res = await call('DELETE', '/api/admin/invite', undefined, admin);
      expect(((await res.json()) as AdminState).invite).toBeNull();
      expect((await call('POST', '/api/desktops/join', { invite })).status).toBe(400);
    });

    it('expires', () => {
      const invite = store.createInvite();
      const realNow = Date.now;
      Date.now = () => realNow() + 8 * 24 * 60 * 60 * 1000;
      try {
        expect(store.redeemInvite(invite.token, 'Late')).toBeNull();
        expect(store.getInvite()).toBeNull();
      } finally {
        Date.now = realNow;
      }
    });

    it('rejects a tampered invite', async () => {
      const { token } = store.createInvite();
      const [, signature] = token.split('.');
      const forged = Buffer.from(JSON.stringify({ r: 'i', v: 99, e: Date.now() + 1e9 })).toString('base64url');
      expect(store.redeemInvite(`${forged}.${signature}`, 'Forged')).toBeNull();
    });
  });

  describe('admin', () => {
    it('refuses every action without a session', async () => {
      const attempts: [string, string][] = [
        ['GET', '/api/admin/state'],
        ['POST', '/api/admin/invite'],
        ['DELETE', '/api/admin/invite'],
        ['DELETE', '/api/admin/laptops/x'],
        ['POST', '/api/admin/scanning'],
      ];
      for (const [method, pathname] of attempts) {
        expect((await call(method, pathname, method === 'POST' ? {} : undefined)).status, pathname).toBe(401);
      }
    });

    it('does not accept a laptop credential as an admin session', async () => {
      const laptop = await joinLaptop(await createInvite(await signIn()));
      expect((await call('GET', '/api/admin/state', undefined, laptop.token)).status).toBe(401);
    });

    it('refuses a wrong password and throttles guessing', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) {
        statuses.push((await call('POST', '/api/admin/login', { password: `guess-${i}` })).status);
      }
      expect(statuses.slice(0, 5).every((status) => status === 401)).toBe(true);
      expect(statuses.slice(5).every((status) => status === 429)).toBe(true);
    });

    it('ends sessions after 12 hours', () => {
      const session = store.createAdminSession();
      expect(store.isAdminSession(session)).toBe(true);
      const realNow = Date.now;
      Date.now = () => realNow() + 13 * 60 * 60 * 1000;
      try {
        expect(store.isAdminSession(session)).toBe(false);
      } finally {
        Date.now = realNow;
      }
    });

    it('stays locked when no password is configured', async () => {
      await stop();
      await start({ adminPassword: null });
      expect((await call('POST', '/api/admin/login', { password: 'anything' })).status).toBe(403);
      const config = (await (await call('GET', '/api/config')).json()) as { mode: string; adminEnabled: boolean };
      expect(config).toMatchObject({ mode: 'open', adminEnabled: false });
    });

    it('never reveals the password or secret in its state', async () => {
      const text = await (await call('GET', '/api/admin/state', undefined, await signIn())).text();
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(SECRET);
    });
  });

  describe('remote storage', () => {
    function memoryRemote() {
      let value: string | null = null;
      const remote: RemoteStorage = {
        load: async () => value,
        save: async (snapshot) => {
          value = snapshot;
        },
      };
      return { remote, read: () => value };
    }

    it('keeps a removed laptop out, and everything else, across a restart on an empty disk', async () => {
      const { remote, read } = memoryRemote();
      await stop();
      await start({ remote });

      const admin = await signIn();
      const invite = await createInvite(admin);
      const keeper = await joinLaptop(invite, 'Keeper');
      const removed = await joinLaptop(invite, 'Removed');
      await call('DELETE', `/api/admin/laptops/${removed.id}`, undefined, admin);
      await call('POST', '/api/admin/scanning', { paused: true }, admin);
      await store.flush();

      // Credentials are signed and never stored, so a stolen copy of the data can't be replayed.
      expect(read()).not.toContain(keeper.token);
      expect(read()).not.toContain(SECRET);

      await stop();
      await start({ remote });

      const refused = await connect(removed.token);
      expect((await refused.nextOfType('auth-result')).success).toBe(false);
      await connected(keeper.token);

      const state = (await (await call('GET', '/api/admin/state', undefined, await signIn())).json()) as AdminState;
      expect(state.laptops.map((laptop) => laptop.name)).toEqual(['Keeper']);
      expect(state.scansPaused).toBe(true);
      expect(state.invite).not.toBeNull();
      expect(state.storage).toBe('external');
    });

    it('keeps a replaced invite dead across a restart', async () => {
      const { remote } = memoryRemote();
      await stop();
      await start({ remote });
      const admin = await signIn();
      const old = await createInvite(admin);
      await createInvite(admin);
      await store.flush();

      await stop();
      await start({ remote });
      expect((await call('POST', '/api/desktops/join', { invite: old })).status).toBe(400);
    });

    it('survives remote storage failing', async () => {
      const remote: RemoteStorage = { load: async () => null, save: async () => Promise.reject(new Error('down')) };
      const failing = new PairingStore(undefined, SECRET, { sharedAccount: true, remote });
      failing.createInvite();
      await expect(failing.flush()).resolves.toBeUndefined();
    });
  });

  it('tells the phone app how to behave', async () => {
    const config = await (await call('GET', '/api/config')).json();
    expect(config).toEqual({ mode: 'open', adminEnabled: true, downloadUrl: 'https://example.com/setup.exe' });
  });
});
