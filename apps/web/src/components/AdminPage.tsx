import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { AdminState, RelayConfig } from '@qr2win/shared-types';
import { SERVER_ORIGIN } from '../lib/pairing';

const SESSION_KEY = 'qr2win.adminSession';
const REFRESH_MS = 5000;

function loadSession(): string | null {
  try {
    return sessionStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

function saveSession(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(SESSION_KEY, token);
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // The session then lasts until this page closes.
  }
}

async function api<T>(path: string, token: string | null, method = 'GET', body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${SERVER_ORIGIN}/api${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("Couldn't reach the server. Check your connection and try again.");
  }
  const result = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (response.status === 401 && path !== '/admin/login') throw new SessionExpired();
  if (!response.ok || !result) throw new Error(result?.error ?? `Something went wrong (${response.status}).`);
  return result;
}

class SessionExpired extends Error {}

function formatWhen(time: number): string {
  return new Date(time).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export function AdminPage({ config }: { config: RelayConfig }) {
  const [session, setSession] = useState<string | null>(loadSession);

  if (!config.adminEnabled) {
    return (
      <main className="page">
        <h1>Admin dashboard is off</h1>
        <p className="muted">
          {config.mode === 'open'
            ? 'Set ADMIN_PASSWORD in your hosting settings and deploy again to turn it on.'
            : 'The dashboard is only available on your internet relay, not on a laptop’s Wi-Fi server.'}
        </p>
      </main>
    );
  }

  const signOut = () => {
    saveSession(null);
    setSession(null);
  };

  if (!session) {
    return (
      <LoginForm
        onSignedIn={(token) => {
          saveSession(token);
          setSession(token);
        }}
      />
    );
  }
  return <Dashboard session={session} onSignOut={signOut} />;
}

function LoginForm({ onSignedIn }: { onSignedIn: (token: string) => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { token } = await api<{ token: string }>('/admin/login', null, 'POST', { password });
      onSignedIn(token);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page">
      <h1>Admin dashboard</h1>
      <form onSubmit={submit}>
        <label>
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
        {error ? <p className="notice error" role="alert">{error}</p> : null}
        <button type="submit" className="primary" disabled={busy || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}

function Dashboard({ session, onSignOut }: { session: string; onSignOut: () => void }) {
  const [state, setState] = useState<AdminState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const run = useCallback(
    async (action: () => Promise<AdminState>) => {
      try {
        setState(await action());
        setError(null);
      } catch (err) {
        if (err instanceof SessionExpired) onSignOut();
        else setError((err as Error).message);
      }
    },
    [onSignOut],
  );

  useEffect(() => {
    const refresh = () => void run(() => api<AdminState>('/admin/state', session));
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [run, session]);

  if (!state) {
    return (
      <main className="page">
        {error ? <p className="notice error" role="alert">{error}</p> : <p className="muted" role="status">Loading…</p>}
      </main>
    );
  }

  const inviteLink = state.invite ? `${SERVER_ORIGIN}/join/${state.invite.token}` : null;

  const copy = async () => {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy automatically. Select the link and copy it.");
    }
  };

  return (
    <main className="page">
      <div className="row">
        <h1 className="grow">Admin dashboard</h1>
        <button type="button" className="link" onClick={onSignOut}>Sign out</button>
      </div>
      {error ? <p className="notice error" role="alert">{error}</p> : null}

      {state.storage === 'local-disk' ? (
        <p className="notice warn" role="status">
          Changes here are only saved on the server's disk. On free hosting that is wiped on restart, so a removed laptop could
          get back in. Add a free Upstash database to keep them.
        </p>
      ) : null}

      <section className="panel" aria-labelledby="laptops-heading">
        <h2 id="laptops-heading">Laptops ({state.laptops.length})</h2>
        {state.laptops.length === 0 ? <p className="muted">No laptops yet. Create an invite link to add one.</p> : null}
        <ul className="laptops">
          {state.laptops.map((laptop) => (
            <li key={laptop.id} className="row">
              <span className={`dot ${laptop.online ? 'on' : ''}`} aria-hidden="true" />
              <div className="grow">
                <div className="laptop-name">{laptop.name}</div>
                <div className="small">
                  {laptop.online ? 'Online' : `Last seen ${formatWhen(laptop.lastSeenAt)}`} · Added {formatWhen(laptop.createdAt)}
                </div>
              </div>
              <button
                type="button"
                aria-label={`Remove ${laptop.name}`}
                onClick={() => {
                  if (window.confirm(`Remove ${laptop.name}? It stops receiving scans right away.`)) {
                    void run(() => api<AdminState>(`/admin/laptops/${encodeURIComponent(laptop.id)}`, session, 'DELETE'));
                  }
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel" aria-labelledby="invite-heading">
        <h2 id="invite-heading">Add a laptop</h2>
        {inviteLink && state.invite ? (
          <>
            <p className="muted">Open this link on each new laptop. Anyone with it can join, so share it privately.</p>
            <p className="link-box" id="invite-link">{inviteLink}</p>
            <p className="small">Works until {formatWhen(state.invite.expiresAt)}, or until you cancel it.</p>
            <div className="panel-actions">
              <button type="button" className="primary" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy link'}</button>
              <button type="button" onClick={() => void run(() => api<AdminState>('/admin/invite', session, 'POST'))}>Replace link</button>
              <button type="button" onClick={() => void run(() => api<AdminState>('/admin/invite', session, 'DELETE'))}>Cancel link</button>
            </div>
          </>
        ) : (
          <div className="panel-actions">
            <button type="button" className="primary" onClick={() => void run(() => api<AdminState>('/admin/invite', session, 'POST'))}>
              Create invite link
            </button>
          </div>
        )}
      </section>

      <section className="panel" aria-labelledby="scanning-heading">
        <h2 id="scanning-heading">Scanning</h2>
        <p className="muted">
          {state.scansPaused ? 'Paused: phones cannot send anything.' : 'On: anyone with your link can send scans.'}{' '}
          {state.phonesOnline === 1 ? '1 phone' : `${state.phonesOnline} phones`} connected now.
        </p>
        <p className="link-box">{SERVER_ORIGIN}</p>
        <div className="panel-actions">
          <button type="button" onClick={() => void run(() => api<AdminState>('/admin/scanning', session, 'POST', { paused: !state.scansPaused }))}>
            {state.scansPaused ? 'Resume scanning' : 'Pause scanning'}
          </button>
        </div>
      </section>
    </main>
  );
}
