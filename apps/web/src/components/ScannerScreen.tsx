import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { MAX_DECODED_TEXT_LENGTH } from '@qr2win/shared-types';
import { useQrCamera } from '../hooks/useQrCamera';
import { copyRegion, cropRegion, encodeQuickly, encodeRawImage, readPixels, type Point } from '../lib/capture';
import { sharpnessScore, type Detection } from '../lib/enhance';
import { type Pairing, WS_URL } from '../lib/pairing';
import { PhoneClient, type ClientState, type ScanEntry } from '../lib/phone-client';
import { ScannerClient } from '../lib/scanner-client';

/** A code still in view is not a new scan; it counts again only after this long out of view. */
const SAME_CODE_COOLDOWN_MS = 3000;
/**
 * How long after sending to keep looking for a sharper frame to straighten. The laptop waits briefly
 * for the straightened copy before showing its popup, so this stays short.
 */
const BEST_FRAME_WINDOW_MS = 150;
/**
 * After a scan the camera freezes until Rescan is tapped, so one code isn't sent over and over. This
 * short wait first lets other codes in the same view through, and finds the sharpest frame.
 */
const FREEZE_AFTER_MS = 400;
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
  /** Where the code is in `crop`. */
  corners: Point[];
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
  /** A code has been scanned, and nothing more goes out until Rescan. */
  const [scanned, setScanned] = useState(false);
  const [frozen, setFrozen] = useState(false);
  const frozenNow = useRef(false);
  const freezeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const screenRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastSeen = useRef(new Map<string, number>());
  const pending = useRef(new Map<string, PendingCapture>());
  const enhancer = useRef<ScannerClient | null>(null);

  useEffect(() => {
    client.start();
    return () => client.stop();
  }, [client]);

  useEffect(() => {
    if (state.revoked) onRevoked?.();
  }, [state.revoked, onRevoked]);

  useEffect(() => {
    // Loaded up front: fetching the decoder during the first scan would make that copy arrive late.
    const worker = new ScannerClient();
    enhancer.current = worker;
    void worker.detect({ data: new Uint8ClampedArray(4 * 8 * 8), width: 8, height: 8 }, false, false).catch(() => undefined);
    return () => {
      worker.terminate();
      enhancer.current = null;
    };
  }, []);

  /** Makes the clearer copy on its own worker, so detection never pauses for it. */
  const enhanceInBackground = useCallback(
    (text: string) => {
      const capture = pending.current.get(text);
      if (!capture) return;
      pending.current.delete(text);
      if (!enhancer.current) return;
      void enhancer.current
        .enhance(readPixels(capture.crop), capture.text, capture.corners)
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
      if (frozenNow.current) return;
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
        const cornersInCrop = corners.map((point) => ({ x: point.x - region.x, y: point.y - region.y }));
        if (waiting) {
          // Already sent. Keep the sharpest view from the next few frames for the clearer copy.
          if (score > waiting.score) {
            waiting.crop = crop;
            waiting.score = score;
            waiting.corners = cornersInCrop;
          }
          continue;
        }

        const photo = encodeQuickly(crop);
        if (!photo) continue;
        const scanId = newScanId();
        navigator.vibrate?.(40);
        setScanned(true);
        freezeTimer.current ??= setTimeout(() => {
          frozenNow.current = true;
          setFrozen(true);
        }, FREEZE_AFTER_MS);
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
        pending.current.set(text, { scanId, crop, score, text, corners: cornersInCrop });
        setTimeout(() => enhanceInBackground(text), BEST_FRAME_WINDOW_MS);
      }
      for (const [text, seenAt] of lastSeen.current) {
        if (now - seenAt > SAME_CODE_COOLDOWN_MS * 2) lastSeen.current.delete(text);
      }
    },
    [client, enhanceInBackground],
  );

  useEffect(
    () => () => {
      if (freezeTimer.current) clearTimeout(freezeTimer.current);
    },
    [],
  );

  /** Restarts the camera and forgets what was sent, so a code still in view counts as a new scan. */
  const rescan = () => {
    // A scan still choosing its sharpest frame finishes now, or it would absorb the new one.
    for (const text of [...pending.current.keys()]) enhanceInBackground(text);
    lastSeen.current.clear();
    if (freezeTimer.current) clearTimeout(freezeTimer.current);
    freezeTimer.current = null;
    frozenNow.current = false;
    setFrozen(false);
    setScanned(false);
  };

  const camera = useQrCamera(videoRef, true, onDetections, frozen);
  const zoomControl = useRef(camera.zoom);
  zoomControl.current = camera.zoom;

  // Touch events, because browsers cancel pointer events once they treat two fingers as a page zoom.
  useEffect(() => {
    const screenElement = screenRef.current;
    if (!screenElement) return;
    let startDistance = 0;
    let startZoom = 1;
    const fingers = (event: TouchEvent) => [...event.touches].filter((touch) => !(touch.target instanceof HTMLInputElement));
    const distance = ([a, b]: Touch[]) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

    const onTouchStart = (event: TouchEvent) => {
      const touches = fingers(event);
      if (touches.length !== 2) return;
      startDistance = distance(touches);
      startZoom = zoomControl.current.value;
      if (event.cancelable) event.preventDefault();
    };
    const onTouchMove = (event: TouchEvent) => {
      const touches = fingers(event);
      if (touches.length !== 2 || startDistance === 0) return;
      if (event.cancelable) event.preventDefault();
      const { min, max, set } = zoomControl.current;
      set(Math.min(max, Math.max(min, startZoom * (distance(touches) / startDistance))));
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (fingers(event).length < 2) startDistance = 0;
    };
    // Safari's own page zoom, which ignores everything above.
    const stopPageZoom = (event: Event) => event.preventDefault();

    screenElement.addEventListener('touchstart', onTouchStart, { passive: false });
    screenElement.addEventListener('touchmove', onTouchMove, { passive: false });
    screenElement.addEventListener('touchend', onTouchEnd);
    screenElement.addEventListener('touchcancel', onTouchEnd);
    document.addEventListener('gesturestart', stopPageZoom);
    document.addEventListener('gesturechange', stopPageZoom);
    return () => {
      screenElement.removeEventListener('touchstart', onTouchStart);
      screenElement.removeEventListener('touchmove', onTouchMove);
      screenElement.removeEventListener('touchend', onTouchEnd);
      screenElement.removeEventListener('touchcancel', onTouchEnd);
      document.removeEventListener('gesturestart', stopPageZoom);
      document.removeEventListener('gesturechange', stopPageZoom);
    };
  }, []);
  const connection = connectionLabel(state);
  const { zoom, brightness, previewScale, frameSize, detections } = camera;

  return (
    <main className="scanner" ref={screenRef}>
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

      <div className="viewfinder">
        <div className="viewfinder-zoom" style={previewScale > 1 ? { transform: `scale(${previewScale})` } : undefined}>
          <video ref={videoRef} playsInline muted />
          <svg className="code-outlines" viewBox={`0 0 ${frameSize.width} ${frameSize.height}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
            {detections.map((detection) => (
              <polygon key={detection.text} points={detection.corners.map((point) => `${point.x},${point.y}`).join(' ')} />
            ))}
          </svg>
        </div>
        {!camera.running && !camera.error ? <p className="viewfinder-note">Starting camera…</p> : null}
        {camera.error ? <p className="viewfinder-note error" role="alert">{camera.error}</p> : null}
        {scanned ? (
          <svg className="scan-tick" viewBox="0 0 96 96" aria-hidden="true">
            <circle cx="48" cy="48" r="48" />
            <path d="M26 50 l15 15 l29 -32" />
          </svg>
        ) : null}
        {camera.running && brightness ? (
          <label className="camera-bar left">
            <span aria-hidden="true">Light</span>
            <input aria-label="Brightness" type="range" min={brightness.min} max={brightness.max} step={brightness.step} value={brightness.value} onChange={(event) => brightness.set(Number(event.target.value))} />
          </label>
        ) : null}
        {camera.running ? (
          <label className="camera-bar right">
            <span aria-hidden="true">{zoom.value.toFixed(1)}×</span>
            <input aria-label="Zoom" type="range" min={zoom.min} max={zoom.max} step={zoom.step} value={zoom.value} onChange={(event) => zoom.set(Number(event.target.value))} />
          </label>
        ) : null}
      </div>

      <div className="rescan-row">
        <button type="button" className="rescan" disabled={!scanned} onClick={rescan}>
          Rescan
        </button>
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
      </footer>
    </main>
  );
}
