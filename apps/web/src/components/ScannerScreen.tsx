import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { MAX_DECODED_TEXT_LENGTH } from '@qr2win/shared-types';
import { useQrCamera, type CameraResult } from '../hooks/useQrCamera';
import { captureFromVideo } from '../lib/capture';
import { type Pairing, WS_URL } from '../lib/pairing';
import { PhoneClient, type ClientState, type ScanEntry } from '../lib/phone-client';

/** A code still in view is not a new scan; it counts again only after this long out of view. */
const SAME_CODE_COOLDOWN_MS = 3000;

interface ScannerScreenProps {
  pairing: Pairing;
  notice: string | null;
  onUnpair: () => void;
  onRevoked: () => void;
}

function newScanId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function connectionLabel(state: ClientState): { text: string; tone: 'ok' | 'wait' } {
  if (state.connection !== 'connected') return { text: 'Reconnecting…', tone: 'wait' };
  if (!state.desktopOnline) return { text: 'Laptop offline', tone: 'wait' };
  return { text: 'Laptop connected', tone: 'ok' };
}

function scanLabel(scan: ScanEntry): string {
  switch (scan.status) {
    case 'sending':
      return 'Sending to your laptop…';
    case 'waiting':
      return "Waiting for your laptop. It will arrive when the laptop's back.";
    case 'delivered':
      return 'On your laptop';
    case 'failed':
      return scan.message ?? "Couldn't send this one. Scan it again.";
  }
}

export function ScannerScreen({ pairing, notice, onUnpair, onRevoked }: ScannerScreenProps) {
  const client = useMemo(() => new PhoneClient(WS_URL, pairing.token), [pairing.token]);
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [cameraOn, setCameraOn] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastCode = useRef({ text: '', seenAt: 0 });

  useEffect(() => {
    client.start();
    return () => client.stop();
  }, [client]);

  useEffect(() => {
    if (state.revoked) onRevoked();
  }, [state.revoked, onRevoked]);

  const onResult = useCallback(
    (result: CameraResult, video: HTMLVideoElement) => {
      const now = Date.now();
      const stillInView = result.data === lastCode.current.text && now - lastCode.current.seenAt < SAME_CODE_COOLDOWN_MS;
      lastCode.current = { text: result.data, seenAt: now };
      if (stillInView) return;

      const image = captureFromVideo(video, result.cornerPoints);
      if (!image) return;
      navigator.vibrate?.(40);
      client.sendScan({
        type: 'qr-image',
        scanId: newScanId(),
        timestamp: now,
        mimeType: image.mimeType,
        width: image.width,
        height: image.height,
        imageBase64: image.base64,
        decodedText: result.data.slice(0, MAX_DECODED_TEXT_LENGTH),
      });
    },
    [client],
  );

  const camera = useQrCamera(videoRef, cameraOn, onResult);
  const connection = connectionLabel(state);
  const latest = state.scans[0];

  return (
    <main className="scanner">
      <header className="scanner-bar">
        <span className={`pill ${connection.tone}`} role="status">
          {connection.text}
        </span>
        <button type="button" className="link" onClick={onUnpair}>
          Unpair
        </button>
      </header>

      <div className="viewfinder">
        <video ref={videoRef} playsInline muted hidden={!cameraOn} />
        {!cameraOn ? <p className="viewfinder-note">Camera is off.</p> : null}
        {cameraOn && !camera.running && !camera.error ? <p className="viewfinder-note">Starting camera…</p> : null}
        {camera.error ? <p className="viewfinder-note error" role="alert">{camera.error}</p> : null}
      </div>

      <footer className="scanner-panel">
        {notice ? <p className="notice error" role="alert">{notice}</p> : null}
        {latest ? (
          <div className={`scan-result ${latest.status}`} role="status">
            <strong>{scanLabel(latest)}</strong>
            <span>{latest.text}</span>
          </div>
        ) : (
          <p className="muted">Point your camera at any QR code. It appears on your laptop automatically.</p>
        )}
        <button type="button" className="secondary" onClick={() => setCameraOn((value) => !value)}>
          {cameraOn ? 'Turn camera off' : 'Turn camera on'}
        </button>
      </footer>
    </main>
  );
}
