import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upstashStorage } from './upstash.js';

/** A stand-in following Upstash's documented REST format: a POSTed JSON array, answered with {result}. */
describe('upstashStorage', () => {
  let server: http.Server;
  let url: string;
  const data = new Map<string, string>();

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.headers.authorization !== 'Bearer good-token') {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        const [command, key, value] = JSON.parse(body) as string[];
        if (command === 'SET') {
          data.set(key, value);
          res.end(JSON.stringify({ result: 'OK' }));
        } else {
          res.end(JSON.stringify({ result: data.get(key) ?? null }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('reads back what it saved, and nothing before that', async () => {
    const storage = upstashStorage(url, 'good-token');
    expect(await storage.load()).toBeNull();
    await storage.save('{"version":3}');
    expect(await storage.load()).toBe('{"version":3}');
  });

  it('reports a rejected token', async () => {
    await expect(upstashStorage(url, 'bad-token').load()).rejects.toThrow('Unauthorized');
  });
});
