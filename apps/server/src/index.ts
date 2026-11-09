import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay, PairingStore } from '@qr2win/relay-core';

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

const store = new PairingStore(path.join(DATA_DIR, 'pairings.json'), RELAY_SECRET);
const { app, hub } = createRelay({ store, webRoot: WEB_ROOT, corsOrigins: CORS_ORIGINS, trustProxy: TRUST_PROXY });
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
  store.flush();
  void hub.close().then(() => server.close(() => process.exit(0)));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => console.error('[server] Unhandled rejection:', reason));
