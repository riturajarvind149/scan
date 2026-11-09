import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay, PairingStore } from '@qr2win/relay-core';
import { upstashStorage } from './upstash.js';

const here = path.dirname(fileURLToPath(import.meta.url));

if (fs.existsSync('.env')) process.loadEnvFile('.env');

const PORT = Number.parseInt(process.env.PORT ?? '3001', 10);
const DATA_DIR = process.env.DATA_DIR ?? path.resolve(here, '..', 'data');
const WEB_ROOT = process.env.WEB_ROOT ?? path.resolve(here, '..', '..', 'web', 'dist');
const TRUST_PROXY = Number.parseInt(process.env.TRUST_PROXY ?? '0', 10);
const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean);

const RELAY_SECRET = process.env.RELAY_SECRET;

if (RELAY_SECRET && RELAY_SECRET.length < 32) {
  console.error('[server] RELAY_SECRET must be at least 32 characters.');
  process.exit(1);
}
if (!RELAY_SECRET) {
  console.warn(`[server] RELAY_SECRET is not set; using one kept in ${DATA_DIR}. If that folder is lost, every device must pair again.`);
}

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const DOWNLOAD_URL = process.env.DESKTOP_DOWNLOAD_URL ?? 'https://github.com/riturajarvind149/scan/releases/latest/download/QR-to-Windows-11-Setup.exe';
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

if (ADMIN_PASSWORD && ADMIN_PASSWORD.length < 8) {
  console.error('[server] ADMIN_PASSWORD must be at least 8 characters.');
  process.exit(1);
}
if (!ADMIN_PASSWORD) console.warn('[server] ADMIN_PASSWORD is not set, so the admin dashboard is off.');
if (UPSTASH_URL && !RELAY_SECRET) {
  console.error('[server] Set RELAY_SECRET when using Upstash; the generated secret is only kept on local disk.');
  process.exit(1);
}
if (!UPSTASH_URL) {
  console.warn('[server] No UPSTASH_REDIS_REST_URL: laptops and removals are only saved on this disk, which free hosting wipes.');
}

const store = new PairingStore(path.join(DATA_DIR, 'pairings.json'), RELAY_SECRET, {
  sharedAccount: true,
  remote: UPSTASH_URL && UPSTASH_TOKEN ? upstashStorage(UPSTASH_URL, UPSTASH_TOKEN) : undefined,
});

// Before accepting anyone: a laptop that was removed must not get in during the first moments.
try {
  await store.restore();
} catch (err) {
  console.error('[server] Could not read from Upstash; starting with what is on disk:', (err as Error).message);
}

const { app, hub } = createRelay({
  store,
  webRoot: WEB_ROOT,
  corsOrigins: CORS_ORIGINS,
  trustProxy: TRUST_PROXY,
  mode: 'open',
  adminPassword: ADMIN_PASSWORD,
  downloadUrl: DOWNLOAD_URL,
});
const server = http.createServer(app);
hub.attach(server);

server.listen(PORT, () => {
  console.log(`[server] Listening on port ${PORT}`);
  if (!fs.existsSync(path.join(WEB_ROOT, 'index.html'))) {
    console.warn(`[server] No phone web app at ${WEB_ROOT}; run "npm run build:web" to serve it.`);
  }
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down`);
  const forced = setTimeout(() => process.exit(1), 10_000);
  forced.unref();
  void store.flush()
    .then(() => hub.close())
    .then(() => server.close(() => process.exit(0)));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => console.error('[server] Unhandled rejection:', reason));
