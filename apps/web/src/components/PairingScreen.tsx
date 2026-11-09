import { useRef, useState, type FormEvent } from 'react';
import { parsePairingUrl } from '@qr2win/shared-types';
import { useQrCamera } from '../hooks/useQrCamera';
import { SERVER_ORIGIN, suggestDeviceName } from '../lib/pairing';

interface PairingScreenProps {
  busy: boolean;
  error: string | null;
  onPair: (code: string, deviceName: string) => void;
}

export function PairingScreen({ busy, error, onPair }: PairingScreenProps) {
  const [code, setCode] = useState('');
  const [deviceName, setDeviceName] = useState(suggestDeviceName);
  const [scanning, setScanning] = useState(false);
  const [scanHint, setScanHint] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const camera = useQrCamera(videoRef, scanning, (detections) => {
    const [first] = detections;
    const pairing = parsePairingUrl(first.text);
    if (!pairing) {
      setScanHint("That isn't a pairing code. Point the camera at the QR code in the desktop app.");
      return;
    }
    setScanning(false);
    if (pairing.origin === SERVER_ORIGIN) {
      onPair(pairing.code, deviceName);
    } else {
      // The code belongs to another relay, such as this laptop's Wi-Fi server. Pair there instead.
      window.location.assign(first.text);
    }
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (code.length === 6) onPair(code, deviceName);
  };

  return (
    <main className="pairing">
      <h1>Connect to your laptop</h1>
      <p className="muted">
        Open QR-to-Windows on your laptop, choose <strong>Show pairing code</strong>, then scan it here.
      </p>

      {scanning ? (
        <div className="pairing-camera">
          <video ref={videoRef} playsInline muted />
        </div>
      ) : null}
      {scanning && scanHint ? <p className="muted">{scanHint}</p> : null}
      {camera.error ? <p className="notice error" role="alert">{camera.error}</p> : null}

      <button
        type="button"
        className={scanning ? 'secondary' : 'primary'}
        onClick={() => {
          setScanHint(null);
          setScanning((value) => !value);
        }}
      >
        {scanning ? 'Close camera' : 'Scan pairing code'}
      </button>

      <form onSubmit={submit}>
        <label>
          Or type the 6-digit code
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
          />
        </label>
        <label>
          Name for this phone
          <input maxLength={64} value={deviceName} onChange={(event) => setDeviceName(event.target.value)} />
        </label>
        {error ? <p className="notice error" role="alert">{error}</p> : null}
        <button type="submit" className="secondary" disabled={busy || code.length !== 6}>
          {busy ? 'Pairing…' : 'Pair'}
        </button>
      </form>
    </main>
  );
}
