import express from 'express';
import cors from 'cors';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { PairingStore } from './pairing.js';
import { WsHandler } from './ws-handler.js';

const PORT = parseInt(process.env.PORT || '3001', 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

const store = new PairingStore();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const handler = new WsHandler(store);

// ─── REST endpoints ────────────────────────────────────────────────────

/** Health check */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

/** Generate a pairing code (called by desktop app) */
app.post('/api/pairing/generate', (req, res) => {
  const { desktopDeviceId } = req.body;
  if (!desktopDeviceId || typeof desktopDeviceId !== 'string') {
    res.status(400).json({ error: 'desktopDeviceId is required' });
    return;
  }
  const pairingCode = store.generateCode(desktopDeviceId);
  res.json(pairingCode);
});

/** Pair a phone with a desktop using the pairing code (called by phone web) */
app.post('/api/pairing/pair', (req, res) => {
  const { code, deviceName } = req.body;
  if (!code || typeof code !== 'string') {
    res.status(400).json({ error: 'code is required' });
    return;
  }
  const result = store.pair(code, deviceName || 'Phone');
  if (!result) {
    res.status(400).json({ error: 'Invalid or expired pairing code' });
    return;
  }
  // Token is returned once – phone must store it securely
  res.json({ token: result.token, desktopDeviceId: result.desktopDeviceId });
});

/** Revoke a pairing (called by desktop or phone) */
app.post('/api/pairing/revoke', (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') {
    res.status(400).json({ error: 'token is required' });
    return;
  }
  const revoked = store.revoke(token);
  res.json({ revoked });
});

// ─── WebSocket ─────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  handler.handleConnection(ws);
});

// ─── Start ─────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[server] Listening on port ${PORT}`);
  console.log(`[server] WebSocket endpoint: ws://localhost:${PORT}/ws`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('[server] Shutting down...');
  handler.destroy();
  wss.close();
  server.close();
  process.exit(0);
});

export { app, server, wss, store, handler };

