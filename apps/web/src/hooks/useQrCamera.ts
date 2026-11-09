import { useEffect, useRef, useState, type RefObject } from 'react';
import QrScanner from 'qr-scanner';

const MAX_SCANS_PER_SECOND = 12;

export type CameraResult = QrScanner.ScanResult;

function insecureContextMessage(): string | null {
  if (window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === 'function') return null;
  return 'Browsers only allow the camera on secure pages. Open the https:// address shown in the desktop app.';
}

/** qr-scanner hides the real reason behind a generic error, so ask the browser directly. */
async function describeCameraFailure(): Promise<string> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    for (const track of stream.getTracks()) track.stop();
    return "The camera couldn't start. Close other apps using it and try again.";
  } catch (err) {
    switch ((err as DOMException).name) {
      case 'NotAllowedError':
        return 'Camera access is blocked. Allow the camera for this site in your browser settings, then try again.';
      case 'NotFoundError':
      case 'OverconstrainedError':
        return 'No camera was found on this device.';
      case 'NotReadableError':
        return 'Another app is using the camera. Close it and try again.';
      default:
        return "The camera couldn't start. Reload the page and try again.";
    }
  }
}

/** Sharper frames mean a sharper image on the laptop. The browser default is often just 640×480. */
async function requestHighResolution(video: HTMLVideoElement): Promise<void> {
  const [track] = (video.srcObject as MediaStream | null)?.getVideoTracks() ?? [];
  try {
    await track?.applyConstraints({ width: { ideal: 1920 }, height: { ideal: 1080 } });
  } catch {
    // Keep the resolution we have.
  }
}

async function requestWakeLock(): Promise<WakeLockSentinel | null> {
  try {
    return (await navigator.wakeLock?.request('screen')) ?? null;
  } catch {
    return null; // not supported, or battery saver is on
  }
}

/** Runs the camera and QR decoder on the given video element while `active` is true. */
export function useQrCamera(
  videoRef: RefObject<HTMLVideoElement>,
  active: boolean,
  onResult: (result: CameraResult, video: HTMLVideoElement) => void,
): { error: string | null; running: boolean } {
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const callback = useRef(onResult);
  callback.current = onResult;

  useEffect(() => {
    const video = videoRef.current;
    if (!active || !video) return;

    const blocked = insecureContextMessage();
    if (blocked) {
      setError(blocked);
      return;
    }

    let disposed = false;
    let wakeLock: WakeLockSentinel | null = null;
    setError(null);

    const scanner = new QrScanner(video, (result) => callback.current(result, video), {
      preferredCamera: 'environment',
      highlightScanRegion: true,
      highlightCodeOutline: true,
      returnDetailedScanResult: true,
      maxScansPerSecond: MAX_SCANS_PER_SECOND,
    });

    const keepAwake = async () => {
      if (document.visibilityState !== 'visible') return;
      const lock = await requestWakeLock();
      if (disposed) void lock?.release();
      else wakeLock = lock;
    };
    document.addEventListener('visibilitychange', keepAwake);

    scanner
      .start()
      .then(async () => {
        if (disposed) return;
        await requestHighResolution(video);
        if (disposed) return;
        setRunning(true);
        void keepAwake();
      })
      .catch(async () => {
        const message = await describeCameraFailure();
        if (!disposed) setError(message);
      });

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', keepAwake);
      void wakeLock?.release();
      scanner.destroy();
      setRunning(false);
    };
  }, [active, videoRef]);

  return { error, running };
}
