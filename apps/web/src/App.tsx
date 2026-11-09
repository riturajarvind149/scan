import { useCallback, useEffect, useRef, useState } from 'react';
import { parsePairingHash, type RelayConfig } from '@qr2win/shared-types';
import { AdminPage } from './components/AdminPage';
import { JoinPage } from './components/JoinPage';
import { PairingScreen } from './components/PairingScreen';
import { ScannerScreen } from './components/ScannerScreen';
import {
  clearPairing,
  fetchConfig,
  loadPairing,
  requestPairing,
  requestUnpair,
  savePairing,
  suggestDeviceName,
  type Pairing,
} from './lib/pairing';

export default function App() {
  const [config, setConfig] = useState<RelayConfig | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchConfig()
        .then((loaded) => {
          if (!cancelled) setConfig(loaded);
        })
        .catch(() => {
          if (cancelled) return;
          setFailed(true);
          setTimeout(load, 3000); // a sleeping free server can take a minute to wake
        });
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!config) {
    return (
      <main className="page">
        <p className="muted" role="status">{failed ? 'Waking up the server. This can take a minute…' : 'Loading…'}</p>
      </main>
    );
  }

  const { pathname } = window.location;
  if (pathname.startsWith('/admin')) return <AdminPage config={config} />;
  if (pathname.startsWith('/join/')) return <JoinPage config={config} token={pathname.slice('/join/'.length).replace(/\/$/, '')} />;
  if (config.mode === 'open') return <ScannerScreen pairing={null} notice={null} />;
  return <PairedApp />;
}

/** A laptop's own Wi-Fi relay, where a phone pairs once with a code. */
function PairedApp() {
  const [pairing, setPairing] = useState<Pairing | null>(loadPairing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handledLink = useRef(false);

  const pair = useCallback(async (code: string, deviceName: string) => {
    setBusy(true);
    setError(null);
    try {
      const created = await requestPairing(code, deviceName);
      savePairing(created);
      setPairing(created);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  // The phone's own camera app opens the pairing QR as a link, so the code arrives in the URL.
  useEffect(() => {
    if (handledLink.current) return;
    handledLink.current = true;
    const code = parsePairingHash(window.location.hash);
    if (!code) return;
    // Drop the code from the address bar and history; it is single use anyway.
    window.history.replaceState(null, '', window.location.pathname);
    void pair(code, suggestDeviceName());
  }, [pair]);

  const unpair = useCallback(() => {
    if (pairing) void requestUnpair(pairing.token);
    clearPairing();
    setPairing(null);
    setError(null);
  }, [pairing]);

  const onRevoked = useCallback(() => {
    clearPairing();
    setPairing(null);
    setError('This phone was unpaired. Pair it again to keep scanning.');
  }, []);

  if (pairing) {
    return <ScannerScreen key={pairing.token} pairing={pairing} notice={error} onUnpair={unpair} onRevoked={onRevoked} />;
  }
  return <PairingScreen busy={busy} error={error} onPair={pair} />;
}
