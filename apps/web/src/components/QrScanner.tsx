import { useState, useRef, useEffect, useCallback } from 'react';
import QrScannerLib from 'qr-scanner';
import { v4 as uuidv4 } from 'uuid';
import type { ConnectionState } from '../hooks/useConnection';

interface QrScannerProps {
  onScan: (imageBase64: string, mimeType: string, width: number, height: number, decodedText: string) => void;
  connectionState: ConnectionState;
}

export function QrScanner({ onScan, connectionState }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<QrScannerLib | null>(null);
  const lastScanRef = useRef<string>('');
  const lastScanTimeRef = useRef<number>(0);

  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastScannedText, setLastScannedText] = useState<string | null>(null);
  const [scanCount, setScanCount] = useState(0);

  const DEBOUNCE_MS = 3000; // Avoid re-scanning same QR for 3 seconds

  const cropQrFromFrame = useCallback(
    (video: HTMLVideoElement, rect: QrScannerLib.ScanRegion): { base64: string; width: number; height: number } => {
      const canvas = document.createElement('canvas');

      // The rect from qr-scanner gives us the QR region
      const sx = rect.x ?? 0;
      const sy = rect.y ?? 0;
      const sw = rect.width ?? video.videoWidth;
      const sh = rect.height ?? video.videoHeight;

      // Add padding (10%) for context
      const padding = Math.max(sw, sh) * 0.1;
      const cropX = Math.max(0, sx - padding);
      const cropY = Math.max(0, sy - padding);
      const cropW = Math.min(video.videoWidth - cropX, sw + padding * 2);
      const cropH = Math.min(video.videoHeight - cropY, sh + padding * 2);

      canvas.width = Math.round(cropW);
      canvas.height = Math.round(cropH);

      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, canvas.width, canvas.height);

      const base64 = canvas.toDataURL('image/png').split(',')[1];
      return { base64, width: canvas.width, height: canvas.height };
    },
    []
  );

  const startScanning = useCallback(async () => {
    setError(null);

    if (!videoRef.current) return;

    try {
      // Check camera support
      const hasCamera = await QrScannerLib.hasCamera();
      if (!hasCamera) {
        setError('No camera found on this device.');
        return;
      }

      const scanner = new QrScannerLib(
        videoRef.current,
        (result) => {
          const now = Date.now();
          const text = result.data;

          // Debounce: skip if same QR scanned recently
          if (text === lastScanRef.current && now - lastScanTimeRef.current < DEBOUNCE_MS) {
            return;
          }

          lastScanRef.current = text;
          lastScanTimeRef.current = now;

          // Crop the QR from the video frame
          if (videoRef.current && result.cornerPoints && result.cornerPoints.length >= 4) {
            const points = result.cornerPoints;
            const xs = points.map((p) => p.x);
            const ys = points.map((p) => p.y);
            const minX = Math.min(...xs);
            const minY = Math.min(...ys);
            const maxX = Math.max(...xs);
            const maxY = Math.max(...ys);

            const rect: QrScannerLib.ScanRegion = {
              x: minX,
              y: minY,
              width: maxX - minX,
              height: maxY - minY,
            };

            const { base64, width, height } = cropQrFromFrame(videoRef.current, rect);
            onScan(base64, 'image/png', width, height, text);
          } else {
            // Fallback: capture full frame
            if (videoRef.current) {
              const canvas = document.createElement('canvas');
              canvas.width = videoRef.current.videoWidth;
              canvas.height = videoRef.current.videoHeight;
              const ctx = canvas.getContext('2d')!;
              ctx.drawImage(videoRef.current, 0, 0);
              const base64 = canvas.toDataURL('image/png').split(',')[1];
              onScan(base64, 'image/png', canvas.width, canvas.height, text);
            }
          }

          setLastScannedText(text);
          setScanCount((c) => c + 1);
        },
        {
          preferredCamera: 'environment', // rear camera
          highlightScanRegion: true,
          highlightCodeOutline: true,
          returnDetailedScanResult: true,
        }
      );

      await scanner.start();
      scannerRef.current = scanner;
      setScanning(true);
    } catch (err: any) {
      if (err.name === 'NotAllowedError') {
        setError('Camera permission denied. Please allow camera access in your browser settings and reload.');
      } else if (err.name === 'NotFoundError') {
        setError('No camera found on this device.');
      } else if (err.name === 'NotReadableError') {
        setError('Camera is in use by another application.');
      } else {
        setError(`Camera error: ${err.message || 'Unknown error'}`);
      }
    }
  }, [onScan, cropQrFromFrame]);

  const stopScanning = useCallback(() => {
    if (scannerRef.current) {
      scannerRef.current.stop();
      scannerRef.current.destroy();
      scannerRef.current = null;
    }
    setScanning(false);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (scannerRef.current) {
        scannerRef.current.stop();
        scannerRef.current.destroy();
      }
    };
  }, []);

  const isConnected = connectionState.status === 'connected';

  return (
    <div style={styles.wrapper}>
      <div style={styles.videoContainer}>
        <video
          ref={videoRef}
          style={{
            ...styles.video,
            display: scanning ? 'block' : 'none',
          }}
          playsInline
          muted
        />
        {!scanning && (
          <div style={styles.placeholder}>
            <div style={styles.icon}>📷</div>
            <p>Tap "Start Scanning" to activate the camera</p>
          </div>
        )}
      </div>

      {error && (
        <div style={styles.error}>
          <span>⚠️ {error}</span>
        </div>
      )}

      <div style={styles.controls}>
        {!scanning ? (
          <button
            style={{
              ...styles.button,
              ...styles.startButton,
              opacity: isConnected ? 1 : 0.6,
            }}
            onClick={startScanning}
            disabled={!isConnected}
          >
            {isConnected ? '📷 Start Scanning' : '⏳ Connect first...'}
          </button>
        ) : (
          <button
            style={{ ...styles.button, ...styles.stopButton }}
            onClick={stopScanning}
          >
            ⏹ Stop Scanning
          </button>
        )}
      </div>

      {lastScannedText && (
        <div style={styles.lastScan}>
          <small style={{ color: '#94a3b8' }}>
            Last scan #{scanCount}: {lastScannedText.length > 60 ? lastScannedText.slice(0, 60) + '…' : lastScannedText}
          </small>
          <small style={{ color: '#22c55e' }}> ✓ Sent to desktop</small>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  videoContainer: {
    flex: 1,
    position: 'relative',
    background: '#000',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  video: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  },
  placeholder: {
    textAlign: 'center' as const,
    color: '#64748b',
    padding: 32,
  },
  icon: {
    fontSize: 64,
    marginBottom: 16,
  },
  error: {
    background: '#7f1d1d',
    color: '#fca5a5',
    padding: '12px 16px',
    fontSize: 14,
  },
  controls: {
    padding: 16,
    display: 'flex',
    justifyContent: 'center',
  },
  button: {
    padding: '14px 28px',
    borderRadius: 12,
    border: 'none',
    fontSize: 16,
    fontWeight: 600,
    cursor: 'pointer',
    color: '#fff',
    width: '100%',
    maxWidth: 320,
  },
  startButton: {
    background: '#2563eb',
  },
  stopButton: {
    background: '#dc2626',
  },
  lastScan: {
    padding: '8px 16px',
    borderTop: '1px solid #1e293b',
    fontSize: 12,
  },
};

