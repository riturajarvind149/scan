import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent } from 'react';
import { MAX_DECODED_TEXT_LENGTH } from '@qr2win/shared-types';
import { useQrCamera } from '../hooks/useQrCamera';
import { copyRegion, cropRegion, encodeQuickly, encodeRawImage, readPixels } from '../lib/capture';
import { sharpnessScore, type Detection } from '../lib/enhance';
import { type Pairing, WS_URL } from '../lib/pairing';
import { PhoneClient, type ClientState, type ScanEntry } from '../lib/phone-client';
import { ScannerClient } from '../lib/scanner-client';

/** A code still in view is not a new scan; it counts again only after this long out of view. */
const SAME_CODE_COOLDOWN_MS = 3000;
/** How long after sending to keep looking for a sharper frame to enhance. Nothing waits on this. */
const BEST_FRAME_WINDOW_MS = 350;
const VISIBLE_RESULTS = 2;

interface ScannerScreenProps {
  /** Null when the relay's link is public, so there is nothing to pair or unpair. */
  pairing: Pairing | null;
  notice: string | null;
  onUnpair?: () => void;
  onRevoked?: () => void;
}

/** A scan already sent, whose best frame is being collected for the clearer copy. */
interface PendingCapture {
  scanId: string;
  crop: HTMLCanvasElement;
  score: number;
  text: string;
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
  const client = useMemo(() => new PhoneClient(WS_URL, pairing?.token ?? null), [pairing?.token]);
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [cameraOn, setCameraOn] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastSeen = useRef(new Map<string, number>());
  const pending = useRef(new Map<string, PendingCapture>());
  const enhancer = useRef<ScannerClient | null>(null);
  const pinch = useRef<{ pointers: Map<number, { x: number; y: number }>; distance: number; zoom: number }>({
    pointers: new Map(),
    distance: 0,
    zoom: 1,
  });

  useEffect(() => {
    client.start();
    return () => client.stop();
  }, [client]);

  useEffect(() => {
    if (state.revoked) onRevoked?.();
  }, [state.revoked, onRevoked]);

  useEffect(
    () => () => {
      enhancer.current?.terminate();
      enhancer.current = null;
    },
    [],
  );

  /** Makes the clearer copy on its own worker, so detection never pauses for it. */
  const enhanceInBackground = useCallback(
    (text: string) => {
      const capture = pending.current.get(text);
      if (!capture) return;
      pending.current.delete(text);
      enhancer.current ??= new ScannerClient();
      void enhancer.current
        .enhance(readPixels(capture.crop), capture.text)
        .then((result) => {
          const encoded = result && encodeRawImage(result.image);
          if (!result || !encoded) return;
          client.addEnhancement(capture.scanId, {
            mimeType: encoded.mimeType,
            width: encoded.width,
            height: encoded.height,
            imageBase64: encoded.base64,
            method: result.method,
          });
        })
        .catch((err: Error) => console.warn('[scanner] Enhancement skipped:', err.message));
    },
    [client],
  );

  const onDetections = useCallback(
    (detections: Detection[], frame: HTMLCanvasElement) => {
      const now = Date.now();
      for (const { text, corners } of detections) {
        const previous = lastSeen.current.get(text);
        const stillInView = previous !== undefined && now - previous < SAME_CODE_COOLDOWN_MS;
        lastSeen.current.set(text, now);
        const waiting = pending.current.get(text);
        if (stillInView && !waiting) continue;

        const region = cropRegion(corners, frame.width, frame.height);
        if (region.width < 1 || region.height < 1) continue;
        const crop = copyRegion(frame, region);
        const score = sharpnessScore(readPixels(crop));
        if (waiting) {
          // Already sent. Keep the sharpest view from the next few frames for the clearer copy.
          if (score > waiting.score) {
            waiting.crop = crop;
            waiting.score = score;
          }
          continue;
        }

        const photo = encodeQuickly(crop);
        if (!photo) continue;
        const scanId = newScanId();
        navigator.vibrate?.(40);
        client.sendScan({
          type: 'qr-image',
          scanId,
          timestamp: now,
          mimeType: photo.mimeType,
          width: photo.width,
          height: photo.height,
          imageBase64: photo.base64,
          decodedText: text.slice(0, MAX_DECODED_TEXT_LENGTH),
        });
        pending.current.set(text, { scanId, crop, score, text });
        setTimeout(() => enhanceInBackground(text), BEST_FRAME_WINDOW_MS);
      }
      for (const [text, seenAt] of lastSeen.current) {
        if (now - seenAt > SAME_CODE_COOLDOWN_MS * 2) lastSeen.current.delete(text);
      }
    },
    [client, enhanceInBackground],
  );

  const camera = useQrCamera(videoRef, cameraOn, onDetections);
  const connection = connectionLabel(state);
  const { zoom, brightness, previewScale, frameSize, detections } = camera;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    pinch.current.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch.current.pointers.size === 2) {
      const [a, b] = [...pinch.current.pointers.values()];
      pinch.current.distance = Math.hypot(a.x - b.x, a.y - b.y);
      pinch.current.zoom = zoom.value;
    }
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!pinch.current.pointers.has(event.pointerId)) return;
    pinch.current.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch.current.pointers.size === 2 && pinch.current.distance > 0) {
      const [a, b] = [...pinch.current.pointers.values()];
      const ratio = Math.hypot(a.x - b.x, a.y - b.y) / pinch.current.distance;
      zoom.set(Math.min(zoom.max, Math.max(zoom.min, pinch.current.zoom * ratio)));
    }
  };

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    pinch.current.pointers.delete(event.pointerId);
  };

  return (
    <main className="scanner">
      <header className="scanner-bar">
        <span className={`pill ${connection.tone}`} role="status">
          {connection.text}
        </span>
        {onUnpair ? (
          <button type="button" className="link" onClick={onUnpair}>
            Unpair
          </button>
        ) : null}
      </header>

      <div className="viewfinder" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}>
        <div className="viewfinder-zoom" style={previewScale > 1 ? { transform: `scale(${previewScale})` } : undefined}>
          <video ref={videoRef} playsInline muted hidden={!cameraOn} />
          {cameraOn ? (
            <svg className="code-outlines" viewBox={`0 0 ${frameSize.width} ${frameSize.height}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
              {detections.map((detection) => (
                <polygon key={detection.text} points={detection.corners.map((point) => `${point.x},${point.y}`).join(' ')} />
              ))}
            </svg>
          ) : null}
        </div>
        {!cameraOn ? <p className="viewfinder-note">Camera is off.</p> : null}
        {cameraOn && !camera.running && !camera.error ? <p className="viewfinder-note">Starting camera…</p> : null}
        {camera.error ? <p className="viewfinder-note error" role="alert">{camera.error}</p> : null}
      </div>

      <footer className="scanner-panel">
        {notice ? <p className="notice error" role="alert">{notice}</p> : null}
        {state.scans.length > 0 ? (
          <div className="scan-results">
            {state.scans.slice(0, VISIBLE_RESULTS).map((scan) => (
              <div key={scan.scanId} className={`scan-result ${scan.status}`} role="status">
                <strong>{scanLabel(scan)}</strong>
                <span>{scan.text}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">Point your camera at any QR codes. Each one appears on your laptop automatically.</p>
        )}
        {cameraOn && camera.running ? (
          <div className="camera-controls">
            <label>
              <span>Zoom {zoom.value.toFixed(1)}×</span>
              <input type="range" min={zoom.min} max={zoom.max} step={zoom.step} value={zoom.value} onChange={(event) => zoom.set(Number(event.target.value))} />
            </label>
            {brightness ? (
              <label>
                <span>Brightness</span>
                <input type="range" min={brightness.min} max={brightness.max} step={brightness.step} value={brightness.value} onChange={(event) => brightness.set(Number(event.target.value))} />
              </label>
            ) : null}
          </div>
        ) : null}
        <button type="button" className="secondary" onClick={() => setCameraOn((value) => !value)}>
          {cameraOn ? 'Turn camera off' : 'Turn camera on'}
        </button>
      </footer>
    </main>
  );
}
