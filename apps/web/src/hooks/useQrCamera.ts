import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { readPixels, type Rect } from '../lib/capture';
import type { Detection } from '../lib/enhance';
import { ScannerClient } from '../lib/scanner-client';

/** Detection works on at most this many pixels across; the capture still uses the full frame. */
const DETECT_SIZE = 1280;
const MAX_FRAME_SIZE = 2560;
const MIN_TICK_MS = 80;
const MAX_DIGITAL_ZOOM = 5;
const OVEREXPOSED_LEVEL = 250;
const OVEREXPOSED_SHARE = 0.25;
const AUTO_EXPOSURE_INTERVAL_MS = 700;

interface ZoomConstraints {
  zoom?: number;
  exposureCompensation?: number;
  exposureMode?: string;
  focusMode?: string;
}

interface Capabilities {
  zoom?: { min: number; max: number; step?: number };
  exposureCompensation?: { min: number; max: number; step?: number };
  exposureMode?: string[];
  focusMode?: string[];
}

interface NativeDetector {
  detect(source: CanvasImageSource): Promise<{ rawValue: string; cornerPoints: { x: number; y: number }[] }[]>;
}

declare const BarcodeDetector: {
  new (options: { formats: string[] }): NativeDetector;
  getSupportedFormats(): Promise<string[]>;
};

export interface RangeControl {
  value: number;
  min: number;
  max: number;
  step: number;
  set(value: number): void;
}

export interface CameraState {
  error: string | null;
  running: boolean;
  /** The size of the camera frame, which `detections` coordinates refer to. */
  frameSize: { width: number; height: number };
  detections: Detection[];
  zoom: RangeControl;
  /** Scale to apply to the preview when the camera has no zoom of its own. */
  previewScale: number;
  /** Null on cameras that don't let the browser adjust brightness. */
  brightness: RangeControl | null;
}

function cameraErrorMessage(err: unknown): string {
  switch ((err as DOMException).name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access is blocked. Allow the camera for this site in your browser settings, then try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found on this device.';
    case 'NotReadableError':
    case 'AbortError':
      return 'Another app is using the camera. Close it and try again.';
    default:
      return "The camera couldn't start. Reload the page and try again.";
  }
}

async function createNativeDetector(): Promise<NativeDetector | null> {
  try {
    if (!('BarcodeDetector' in window)) return null;
    if (!(await BarcodeDetector.getSupportedFormats()).includes('qr_code')) return null;
    return new BarcodeDetector({ formats: ['qr_code'] });
  } catch {
    return null;
  }
}

function overexposedShare(data: Uint8ClampedArray): number {
  let bright = 0;
  let total = 0;
  for (let at = 1; at < data.length; at += 160) {
    if (data[at] >= OVEREXPOSED_LEVEL) bright++;
    total++;
  }
  return total === 0 ? 0 : bright / total;
}

/**
 * Which part of the frame each scan looks at, in turn: all of it for several codes at once, then
 * the centre at full detail for small or distant codes, then harder attempts for difficult ones.
 */
function nextPass(index: number, frame: HTMLCanvasElement, zoom: number): { region: Rect; thorough: boolean; stretch: boolean } {
  const whole: Rect = { x: 0, y: 0, width: frame.width, height: frame.height };
  const centre = (factor: number): Rect => {
    const width = Math.round(frame.width / factor);
    const height = Math.round(frame.height / factor);
    return { x: Math.round((frame.width - width) / 2), y: Math.round((frame.height - height) / 2), width, height };
  };
  const inView = zoom > 1 ? centre(zoom) : whole;
  switch (index % 5) {
    case 0:
      return { region: inView, thorough: false, stretch: false };
    case 1:
      return { region: centre(Math.max(2, zoom)), thorough: false, stretch: false };
    case 2:
      return { region: inView, thorough: false, stretch: true };
    case 3:
      return { region: centre(Math.max(3, zoom * 1.5)), thorough: true, stretch: true };
    default:
      return { region: inView, thorough: true, stretch: false };
  }
}

/**
 * Runs the camera and looks for QR codes while `active` is true. `onDetections` gets every code
 * found, and the full-resolution frame they were found in so a capture matches the detection exactly.
 * While `paused`, the preview holds still and nothing is looked for, and the camera stays ready.
 */
export function useQrCamera(
  videoRef: RefObject<HTMLVideoElement>,
  active: boolean,
  onDetections: (detections: Detection[], frame: HTMLCanvasElement) => void,
  paused = false,
): CameraState {
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [frameSize, setFrameSize] = useState({ width: 1, height: 1 });
  const [detections, setDetections] = useState<Detection[]>([]);
  const [zoomValue, setZoomValue] = useState(1);
  const [zoomRange, setZoomRange] = useState({ min: 1, max: MAX_DIGITAL_ZOOM, step: 0.1, hardware: false });
  const [brightnessRange, setBrightnessRange] = useState<{ min: number; max: number; step: number } | null>(null);
  const [brightnessValue, setBrightnessValue] = useState(0);

  const callback = useRef(onDetections);
  callback.current = onDetections;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const zoomRef = useRef({ value: 1, hardware: false });
  const brightnessRef = useRef({ value: 0, userSet: false, min: 0, step: 0, lastAuto: 0, available: false });

  const zoomSending = useRef(false);

  /** A pinch changes the zoom far faster than a camera can follow, so only the latest value is sent. */
  const sendZoom = useCallback(() => {
    const track = trackRef.current;
    if (!track || zoomSending.current) return;
    zoomSending.current = true;
    const sent = zoomRef.current.value;
    void track
      .applyConstraints({ advanced: [{ zoom: sent } as ZoomConstraints as MediaTrackConstraintSet] })
      .catch(() => undefined)
      .finally(() => {
        zoomSending.current = false;
        if (zoomRef.current.value !== sent) sendZoom();
      });
  }, []);

  const setZoom = useCallback((value: number) => {
    setZoomValue(value);
    zoomRef.current.value = value;
    if (zoomRef.current.hardware) sendZoom();
  }, [sendZoom]);

  const applyBrightness = useCallback((value: number) => {
    setBrightnessValue(value);
    brightnessRef.current.value = value;
    void trackRef.current
      ?.applyConstraints({ advanced: [{ exposureMode: 'continuous', exposureCompensation: value } as ZoomConstraints as MediaTrackConstraintSet] })
      .catch(() => undefined);
  }, []);

  const setBrightness = useCallback((value: number) => {
    brightnessRef.current.userSet = true; // the person's choice wins over automatic adjustment
    applyBrightness(value);
  }, [applyBrightness]);

  useEffect(() => {
    const video = videoRef.current;
    if (!active || !video) return;

    if (!window.isSecureContext || typeof navigator.mediaDevices?.getUserMedia !== 'function') {
      setError('Browsers only allow the camera on secure pages. Open the https:// address shown in the desktop app.');
      return;
    }

    let disposed = false;
    let stream: MediaStream | null = null;
    let wakeLock: WakeLockSentinel | null = null;
    let scanner: ScannerClient | null = null;
    setError(null);

    const keepAwake = async () => {
      if (disposed || document.visibilityState !== 'visible') return;
      try {
        const lock = await navigator.wakeLock?.request('screen');
        if (disposed) void lock?.release();
        else wakeLock = lock ?? null;
      } catch {
        // Not supported, or battery saver is on.
      }
      if (!pausedRef.current) void video.play().catch(() => undefined);
    };
    document.addEventListener('visibilitychange', keepAwake);

    const configureTrack = (track: MediaStreamTrack) => {
      const capabilities = (track.getCapabilities?.() ?? {}) as Capabilities;
      const constraints: ZoomConstraints = {};
      if (capabilities.focusMode?.includes('continuous')) constraints.focusMode = 'continuous';
      if (Object.keys(constraints).length > 0) {
        void track.applyConstraints({ advanced: [constraints as MediaTrackConstraintSet] }).catch(() => undefined);
      }
      if (capabilities.zoom && capabilities.zoom.max > capabilities.zoom.min) {
        const { min, max, step } = capabilities.zoom;
        setZoomRange({ min, max, step: step || 0.1, hardware: true });
        setZoomValue(min);
        zoomRef.current = { value: min, hardware: true };
      }
      if (capabilities.exposureCompensation && capabilities.exposureCompensation.max > capabilities.exposureCompensation.min) {
        const { min, max, step } = capabilities.exposureCompensation;
        setBrightnessRange({ min, max, step: step || 0.1 });
        brightnessRef.current = { ...brightnessRef.current, min, step: step || 0.1, available: true };
      }
    };

    const start = async () => {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: MAX_FRAME_SIZE }, height: { ideal: 1440 } },
      });
      if (disposed) return;
      const [track] = stream.getVideoTracks();
      trackRef.current = track;
      configureTrack(track);
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();
      if (disposed) return;
      setRunning(true);
      void keepAwake();

      scanner = new ScannerClient();
      const native = await createNativeDetector();
      const frame = document.createElement('canvas');
      const frameContext = frame.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
      const detectCanvas = document.createElement('canvas');
      const detectContext = detectCanvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
      let pass = 0;

      while (!disposed) {
        const tickStart = Date.now();
        if (document.hidden || !video.videoWidth || pausedRef.current) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }

        const scale = Math.min(1, MAX_FRAME_SIZE / Math.max(video.videoWidth, video.videoHeight));
        const width = Math.round(video.videoWidth * scale);
        const height = Math.round(video.videoHeight * scale);
        if (frame.width !== width || frame.height !== height) {
          frame.width = width;
          frame.height = height;
          setFrameSize({ width, height });
        }
        frameContext.drawImage(video, 0, 0, width, height);

        const digitalZoom = zoomRef.current.hardware ? 1 : zoomRef.current.value;
        const { region, thorough, stretch } = nextPass(pass++, frame, digitalZoom);
        const detectScale = Math.min(1, DETECT_SIZE / Math.max(region.width, region.height));
        detectCanvas.width = Math.round(region.width * detectScale);
        detectCanvas.height = Math.round(region.height * detectScale);
        detectContext.drawImage(frame, region.x, region.y, region.width, region.height, 0, 0, detectCanvas.width, detectCanvas.height);
        const pixels = readPixels(detectCanvas);

        const bright = brightnessRef.current;
        if (bright.available && !bright.userSet && Date.now() - bright.lastAuto > AUTO_EXPOSURE_INTERVAL_MS && overexposedShare(pixels.data) > OVEREXPOSED_SHARE && bright.value > bright.min) {
          bright.lastAuto = Date.now();
          applyBrightness(Math.max(bright.min, bright.value - bright.step * 2));
        }

        // Both run at once, and whichever answers first sends the scan. The frame stays put until both finish.
        const found = new Map<string, Detection>();
        const report = (detections: Detection[]) => {
          if (disposed || detections.length === 0) return;
          for (const detection of detections) found.set(detection.text, detection);
          setDetections([...found.values()]);
          callback.current(detections, frame);
        };
        const fromWorker = scanner.detect(pixels, thorough, stretch).then(
          (detections) =>
            report(
              detections.map((detection) => ({
                ...detection,
                corners: detection.corners.map((point) => ({ x: region.x + point.x / detectScale, y: region.y + point.y / detectScale })),
              })),
            ),
          (err: Error) => console.warn('[scanner] Detection failed:', err.message),
        );
        const fromPhone = native
          ? native.detect(frame).then(
              (codes) => report(codes.filter((code) => code.rawValue).map((code) => ({ text: code.rawValue, corners: code.cornerPoints, inverted: false }))),
              () => undefined, // the phone's own detector is only a bonus
            )
          : Promise.resolve();
        await Promise.all([fromWorker, fromPhone]);
        if (disposed) return;
        if (found.size === 0 && !pausedRef.current) setDetections([]);

        const elapsed = Date.now() - tickStart;
        if (elapsed < MIN_TICK_MS) await new Promise((resolve) => setTimeout(resolve, MIN_TICK_MS - elapsed));
      }
    };

    start().catch((err) => {
      if (!disposed) setError(cameraErrorMessage(err));
    });

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', keepAwake);
      void wakeLock?.release();
      scanner?.terminate();
      for (const track of stream?.getTracks() ?? []) track.stop();
      trackRef.current = null;
      video.srcObject = null;
      setRunning(false);
      setDetections([]);
      setZoomValue(1);
      setZoomRange({ min: 1, max: MAX_DIGITAL_ZOOM, step: 0.1, hardware: false });
      setBrightnessRange(null);
      zoomRef.current = { value: 1, hardware: false };
    };
  }, [active, videoRef, applyBrightness]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video?.srcObject) return;
    if (paused) {
      video.pause();
    } else {
      setDetections([]);
      void video.play().catch(() => undefined);
    }
  }, [paused, videoRef]);

  return {
    error,
    running,
    frameSize,
    detections,
    zoom: { value: zoomValue, min: zoomRange.min, max: zoomRange.max, step: zoomRange.step, set: setZoom },
    previewScale: zoomRange.hardware ? 1 : zoomValue,
    brightness: brightnessRange ? { value: brightnessValue, ...brightnessRange, set: setBrightness } : null,
  };
}
