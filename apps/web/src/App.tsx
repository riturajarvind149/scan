import { useCallback, useEffect, useRef, useState } from 'react';
import { parsePairingHash } from '@qr2win/shared-types';
import { PairingScreen } from './components/PairingScreen';
import { ScannerScreen } from './components/ScannerScreen';
import {
  clearPairing,
  loadPairing,
  requestPairing,
  requestUnpair,
  savePairing,
  suggestDeviceName,
  type Pairing,
} from './lib/pairing';

export default function App() {
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
