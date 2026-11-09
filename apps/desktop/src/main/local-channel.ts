import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { generate } from 'selfsigned';
import { createRelay, PairingStore, type Hub } from '@qr2win/relay-core';
import { buildPairingUrl, type PhoneSummary } from '@qr2win/shared-types';
import { handleServerMessage, type ChannelEvents } from './channel';
import type { ChannelStatus } from './internet-channel';
import { rankLanAddresses } from './network';
import type { SettingsStore } from './settings';

const PORT_ATTEMPTS = 20;
const CERT_VALID_DAYS = 800; // phones reject certificates valid for more than 825 days
const CERT_RENEW_MARGIN_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CERT_ADDRESSES = 16;

export interface LocalState {
  status: ChannelStatus;
  error: string | null;
  port: number;
  addresses: string[];
  phones: PhoneSummary[];
}

interface StoredCertificate {
  key: string;
  cert: string;
  addresses: string[];
  expiresAt: number;
}

/**
 * Loads the HTTPS certificate, creating one if the current addresses are not covered. Past addresses
 * are kept in it so moving between networks does not make phones accept a new certificate each time.
 */
async function loadCertificate(dir: string, addresses: string[]): Promise<StoredCertificate> {
  const file = path.join(dir, 'local-certificate.json');
  let stored: StoredCertificate | null = null;
  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf-8')) as StoredCertificate;
  } catch {
    // No usable certificate yet.
  }
  if (
    stored &&
    stored.expiresAt - Date.now() > CERT_RENEW_MARGIN_MS &&
    addresses.every((address) => stored.addresses.includes(address))
  ) {
    return stored;
  }

  const covered = [...new Set([...addresses, ...(stored?.addresses ?? [])])].slice(0, MAX_CERT_ADDRESSES);
  const notAfterDate = new Date(Date.now() + CERT_VALID_DAYS * 24 * 60 * 60 * 1000);
  const pems = await generate([{ name: 'commonName', value: 'QR-to-Windows-11 on this PC' }], {
    keySize: 2048,
    algorithm: 'sha256',
    notAfterDate,
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, ...covered.map((ip) => ({ type: 7 as const, ip }))],
      },
    ],
  });
  const certificate: StoredCertificate = {
    key: pems.private,
    cert: pems.cert,
    addresses: covered,
    expiresAt: notAfterDate.getTime(),
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(certificate), { mode: 0o600 });
  return certificate;
}

function webRoot(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'web') : path.resolve(app.getAppPath(), '..', 'web', 'dist');
}

/**
 * Runs the relay on this PC so a phone on the same Wi-Fi needs no internet.
 *
 * It also serves the phone app over HTTPS: browsers only allow camera access from secure pages,
 * and a secure page may not talk to plain-http or plain-ws addresses, so all of it must be HTTPS.
 */
export class LocalChannel {
  private server: https.Server | null = null;
  private hub: Hub | null = null;
  private store: PairingStore | null = null;
  private localDesktop: ReturnType<Hub['connectLocalDesktop']> | null = null;
  private desktopId = '';
  private status: ChannelStatus = 'off';
  private error: string | null = null;
  private port = 0;
  private phones: PhoneSummary[] = [];

  constructor(
    private readonly settings: SettingsStore,
    private readonly events: ChannelEvents,
  ) {}

  getState(): LocalState {
    return {
      status: this.status,
      error: this.error,
      port: this.port,
      addresses: this.status === 'connected' ? this.addresses() : [],
      phones: this.phones,
    };
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.status = 'connecting';
    this.error = null;
    this.events.onChange();
    try {
      await this.listen();
      this.status = 'connected';
    } catch (err) {
      await this.stop();
      this.status = 'error';
      this.error = (err as Error).message;
      console.error('[local] Could not start:', this.error);
    }
    this.events.onChange();
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.localDesktop?.disconnect();
    this.localDesktop = null;
    await this.hub?.close();
    this.hub = null;
    this.store?.flush();
    this.store = null;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.status = 'off';
    this.phones = [];
    this.events.onChange();
  }

  async createPairing(address?: string): Promise<{ code: string; expiresAt: number; url: string }> {
    await this.start();
    if (!this.store || this.status !== 'connected') throw new Error(this.error ?? 'The Wi-Fi server is not running.');
    const addresses = this.addresses();
    if (addresses.length === 0) throw new Error('This PC is not connected to a network.');
    const host = address && addresses.includes(address) ? address : addresses[0];

    // A new network address needs a certificate that names it.
    const certificate = await loadCertificate(app.getPath('userData'), addresses);
    this.server?.setSecureContext({ key: certificate.key, cert: certificate.cert });

    const pairing = this.store.issueCode(this.desktopId);
    return { ...pairing, url: buildPairingUrl(`https://${host}:${this.port}`, pairing.code) };
  }

  unpair(phoneId: string): void {
    if (!this.hub) throw new Error('The Wi-Fi server is not running.');
    this.hub.revokePhone(this.desktopId, phoneId);
  }

  private addresses(): string[] {
    return rankLanAddresses(os.networkInterfaces());
  }

  private async listen(): Promise<void> {
    const userData = app.getPath('userData');
    const certificate = await loadCertificate(userData, this.addresses());

    const store = new PairingStore(path.join(userData, 'local-pairings.json'));
    this.desktopId = store.ensureLocalDesktop();
    const { app: expressApp, hub } = createRelay({ store, webRoot: webRoot(), allowDesktopRegistration: false });
    const server = https.createServer({ key: certificate.key, cert: certificate.cert }, expressApp);

    // Attach only once bound: the WebSocket server rethrows the listen errors that bind() retries on.
    this.port = await this.bind(server);
    hub.attach(server);
    this.server = server;
    this.store = store;
    this.hub = hub;
    this.phones = hub.listPhones(this.desktopId);
    const localDesktop = hub.connectLocalDesktop(this.desktopId, (message) =>
      handleServerMessage(
        message,
        'local',
        this.events,
        (reply) => localDesktop.send(reply),
        (phones) => {
          this.phones = phones;
        },
      ),
    );
    this.localDesktop = localDesktop;
  }

  /** Binds the remembered port if free, so paired phones keep working across restarts. */
  private async bind(server: https.Server): Promise<number> {
    const first = this.settings.localPort;
    for (let port = first; port < first + PORT_ATTEMPTS; port++) {
      const bound = await new Promise<boolean>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE' || err.code === 'EACCES') resolve(false);
          else reject(err);
        };
        server.once('error', onError);
        server.listen(port, '0.0.0.0', () => {
          server.off('error', onError);
          resolve(true);
        });
      });
      if (bound) {
        if (port !== first) this.settings.localPort = port;
        return port;
      }
    }
    throw new Error(`No free network port between ${first} and ${first + PORT_ATTEMPTS - 1}.`);
  }
}
