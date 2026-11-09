import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { PairResponseBody, RegisterDesktopResponse } from '@qr2win/shared-types';
import { Hub } from './hub.js';
import { RateLimiter } from './rate-limit.js';
import type { Identity, PairingStore } from './store.js';

export interface RelayOptions {
  store: PairingStore;
  /** Directory holding the built phone web app; it is served at `/` when present. */
  webRoot?: string;
  /** Origins allowed to call the API from another site. The app's own origin never needs listing. */
  corsOrigins?: string[];
  /** Number of reverse proxies in front of this process. */
  trustProxy?: number;
  /** A local relay serves exactly one embedded desktop, so remote desktops may not register. */
  allowDesktopRegistration?: boolean;
}

export interface Relay {
  app: express.Express;
  hub: Hub;
}

const PHONE_APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // qr-scanner runs its decoder in a blob worker and styles its overlay inline.
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' ws: wss:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', PHONE_APP_CSP);
  next();
}

function limitBy(limiter: RateLimiter) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (limiter.allow(req.ip ?? 'unknown')) {
      next();
      return;
    }
    res.status(429).json({ error: 'Too many attempts. Wait a minute and try again.' });
  };
}

function bearerToken(req: Request): string | null {
  const header = req.get('authorization');
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
}

function requireRole<R extends Identity['role']>(store: PairingStore, role: R) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const identity = store.authenticate(bearerToken(req));
    if (!identity || identity.role !== role) {
      res.status(401).json({ error: 'Invalid or revoked credential' });
      return;
    }
    res.locals.identity = identity;
    next();
  };
}

/** Builds the HTTP app and message hub. Used by both the cloud server and the laptop's local relay. */
export function createRelay(options: RelayOptions): Relay {
  const { store, webRoot, corsOrigins = [], trustProxy = 0, allowDesktopRegistration = true } = options;

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);
  app.use(securityHeaders);
  if (corsOrigins.length > 0) app.use('/api', cors({ origin: corsOrigins }));
  app.use('/api', express.json({ limit: '16kb' }));

  const hub = new Hub(store, (req) => clientIp(req, trustProxy));
  const pairLimiter = new RateLimiter(10, 60_000); // keeps guessing a 6-digit code impractical
  const registerLimiter = new RateLimiter(10, 60 * 60_000);
  const requireDesktop = requireRole(store, 'desktop');

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', connections: hub.connectionCount() });
  });

  if (allowDesktopRegistration) {
    app.post('/api/desktops/register', limitBy(registerLimiter), (_req, res) => {
      const body: RegisterDesktopResponse = store.registerDesktop();
      res.status(201).json(body);
    });
  }

  app.post('/api/pairing/generate', requireDesktop, (_req, res) => {
    res.json(store.issueCode((res.locals.identity as Identity).desktopId));
  });

  app.post('/api/pairing/pair', limitBy(pairLimiter), (req, res) => {
    const { code, deviceName } = req.body ?? {};
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      res.status(400).json({ error: 'Enter the 6-digit pairing code' });
      return;
    }
    const result = store.redeemCode(code, typeof deviceName === 'string' ? deviceName : 'Phone');
    if (!result) {
      res.status(400).json({ error: 'That code is invalid or has expired. Generate a new one on your laptop.' });
      return;
    }
    hub.notifyPhonePaired(result.phone);
    const body: PairResponseBody = { token: result.token, phoneId: result.phone.id };
    res.json(body);
  });

  /** A phone removing its own pairing. */
  app.post('/api/pairing/unpair', requireRole(store, 'phone'), (_req, res) => {
    const identity = res.locals.identity as Extract<Identity, { role: 'phone' }>;
    res.json({ revoked: hub.revokePhone(identity.phoneId) });
  });

  app.get('/api/phones', requireDesktop, (_req, res) => {
    res.json({ phones: hub.listPhones((res.locals.identity as Identity).desktopId) });
  });

  app.delete('/api/phones/:id', requireDesktop, (req, res) => {
    const phone = store.getPhone(req.params.id);
    if (!phone || phone.desktopId !== (res.locals.identity as Identity).desktopId) {
      res.status(404).json({ error: 'No such phone' });
      return;
    }
    res.json({ revoked: hub.revokePhone(phone.id) });
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  if (webRoot && fs.existsSync(path.join(webRoot, 'index.html'))) {
    app.use(
      express.static(webRoot, {
        setHeaders(res, filePath) {
          // Vite fingerprints everything under assets/, while index.html must always be fresh.
          const immutable = filePath.includes(`${path.sep}assets${path.sep}`);
          res.setHeader('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
        },
      }),
    );
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.resolve(webRoot, 'index.html'));
    });
  }

  app.use((err: Error & { status?: number }, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const status = err.status && err.status < 500 ? err.status : 500;
    if (status === 500) console.error('[relay] Request failed:', err.message);
    res.status(status).json({ error: status === 500 ? 'Internal server error' : 'Bad request' });
  });

  return { app, hub };
}

function clientIp(req: http.IncomingMessage, trustProxy: number): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (trustProxy > 0 && typeof forwarded === 'string') {
    const chain = forwarded.split(',').map((part) => part.trim());
    const candidate = chain[chain.length - trustProxy];
    if (candidate) return candidate;
  }
  return req.socket.remoteAddress ?? 'unknown';
}
