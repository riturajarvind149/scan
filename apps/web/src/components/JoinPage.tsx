import { useEffect, useState } from 'react';
import type { RelayConfig } from '@qr2win/shared-types';
import { SERVER_ORIGIN } from '../lib/pairing';

interface JoinPageProps {
  config: RelayConfig;
  token: string;
}

/** The page behind a laptop invite link. */
export function JoinPage({ config, token }: JoinPageProps) {
  const [valid, setValid] = useState<boolean | null>(null);
  const link = `${SERVER_ORIGIN}/join/${token}`;

  useEffect(() => {
    fetch(`${SERVER_ORIGIN}/api/invites/${encodeURIComponent(token)}`)
      .then((response) => response.json() as Promise<{ valid?: boolean }>)
      .then((body) => setValid(body.valid === true))
      .catch(() => setValid(false));
  }, [token]);

  if (valid === null) {
    return (
      <main className="page">
        <p className="muted" role="status">Checking your invite…</p>
      </main>
    );
  }

  if (!valid) {
    return (
      <main className="page">
        <h1>This invite isn't valid</h1>
        <p className="muted">It has expired or been cancelled. Ask for a new link from the admin dashboard.</p>
      </main>
    );
  }

  return (
    <main className="page">
      <h1>Add this laptop</h1>
      <p className="muted">This laptop will get a Windows notification for every QR code scanned on {new URL(SERVER_ORIGIN).host}.</p>
      <ol className="steps">
        <li>
          <p>Install the desktop app, if this laptop doesn't have it yet.</p>
          <p className="small">Windows may warn about an unrecognised app. Choose More info, then Run anyway.</p>
          {config.downloadUrl ? (
            <p><a className="button secondary" href={config.downloadUrl}>Download for Windows</a></p>
          ) : null}
        </li>
        <li>
          <p>Join with one click. The app asks you to confirm.</p>
          <p><a className="button" href={`qr2win://join?url=${encodeURIComponent(link)}`}>Open in the app and join</a></p>
        </li>
        <li>
          <p>If nothing opens, paste this link under <strong>This laptop</strong> in the app and choose <strong>Join</strong>.</p>
          <p className="link-box">{link}</p>
        </li>
      </ol>
    </main>
  );
}
