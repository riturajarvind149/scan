import type { RemoteStorage } from '@qr2win/relay-core';

const KEY = 'qr2win:records';
const TIMEOUT_MS = 10_000;

/** Stores the relay's records in an Upstash Redis database through its REST API. */
export function upstashStorage(restUrl: string, token: string): RemoteStorage {
  async function command(args: string[]): Promise<unknown> {
    const response = await fetch(restUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => null)) as { result?: unknown; error?: string } | null;
    if (!response.ok || !body || body.error) {
      throw new Error(body?.error ?? `Upstash answered with status ${response.status}`);
    }
    return body.result;
  }

  return {
    load: async () => (await command(['GET', KEY])) as string | null,
    save: async (snapshot) => {
      await command(['SET', KEY, snapshot]);
    },
  };
}
