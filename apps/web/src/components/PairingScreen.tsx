import { useState, useRef, useEffect } from 'react';
import QrScannerLib from 'qr-scanner';

interface PairingScreenProps {
  onPaired: (token: string, serverUrl: string) => void;
}

export function PairingScreen({ onPaired }: PairingScreenProps) {
  const [serverUrl, setServerUrl] = useState(() => {
    return sessionStorage.getItem('qr2win_server') || '';
  });
  const [pairingCode, setPairingCode] = useState('');
  const [deviceName, setDeviceName] = useState('My Phone');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'internet' | 'local'>('internet');
  const [isScanningPairQr, setIsScanningPairQr] = useState(false);

  const pairVideoRef = useRef<HTMLVideoElement>(null);
  const pairScannerRef = useRef<QrScannerLib | null>(null);

  const pairWith = async (targetServer: string, targetCode: string) => {
    if (!targetServer.trim()) {
      setError('Enter the server URL shown in the desktop app');
      return;
    }
    if (!targetCode.trim() || targetCode.length !== 6) {
      setError('Enter the 6-digit pairing code from the desktop app');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      let baseUrl = targetServer.trim();
      if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
        baseUrl = `http://${baseUrl}`;
      }
      baseUrl = baseUrl.replace(/\/+$/, '');

      const response = await fetch(`${baseUrl}/api/pairing/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: targetCode.trim(), deviceName }),
      });

      const data = await response.json();

      if (!response.ok || !data.token) {
        setError(data.error || 'Pairing failed. Check the code and try again.');
        return;
      }

      // Derive WebSocket URL from HTTP URL
      const wsUrl = baseUrl.replace(/^http/, 'ws') + '/ws';
      onPaired(data.token, wsUrl);
    } catch (err: any) {
      setError(`Connection failed: ${err.message}. Check network and firewall.`);
    } finally {
      setLoading(false);
    }
  };

  const handleManualPair = () => {
    pairWith(serverUrl, pairingCode);
  };

  // Camera scanner for pairing QR
  const startPairQrScanner = async () => {
    setError(null);
    setIsScanningPairQr(true);
  };

  const stopPairQrScanner = () => {
    if (pairScannerRef.current) {
      pairScannerRef.current.stop();
      pairScannerRef.current.destroy();
      pairScannerRef.current = null;
    }
    setIsScanningPairQr(false);
  };

  useEffect(() => {
    if (!isScanningPairQr || !pairVideoRef.current) return;

    let active = true;
    const scanner = new QrScannerLib(
      pairVideoRef.current,
      (result) => {
        if (!active) return;
        try {
          const text = result.data;
          // Check for JSON pairing payload
          if (text.includes('qr2win-pair') || text.startsWith('{')) {
            const parsed = JSON.parse(text);
            if (parsed.server && parsed.code) {
              active = false;
              stopPairQrScanner();
              setServerUrl(parsed.server);
              setPairingCode(parsed.code);
              pairWith(parsed.server, parsed.code);
              return;
            }
          }

          // Check if purely 6-digit code
          const digits = text.replace(/\D/g, '');
          if (digits.length === 6) {
            active = false;
            stopPairQrScanner();
            setPairingCode(digits);
            if (serverUrl) {
              pairWith(serverUrl, digits);
            }
          }
        } catch {
          // not JSON, continue scanning
        }
      },
      {
        preferredCamera: 'environment',
        highlightScanRegion: true,
      }
    );

    scanner.start().catch((err) => {
      setError(`Camera error: ${err.message}`);
      setIsScanningPairQr(false);
    });
    pairScannerRef.current = scanner;

    return () => {
      active = false;
      scanner.stop();
      scanner.destroy();
    };
  }, [isScanningPairQr, serverUrl, deviceName]);

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>📱 QR-to-Windows-11</h1>
        <p style={styles.subtitle}>
          Pair this phone with your Windows desktop to send scanned QR codes instantly.
        </p>

        {/* Scan Desktop QR Button */}
        <button
          style={styles.scanQrBtn}
          onClick={startPairQrScanner}
          type="button"
        >
          📷 Scan Desktop Pairing QR
        </button>

        <div style={{ textAlign: 'center', margin: '14px 0', color: '#64748b', fontSize: 13 }}>
          — or enter details manually —
        </div>

        {/* Mode toggle */}
        <div style={styles.modeToggle}>
          <button
            style={{
              ...styles.modeBtn,
              ...(mode === 'internet' ? styles.modeBtnActive : {}),
            }}
            onClick={() => setMode('internet')}
          >
            🌐 Internet
          </button>
          <button
            style={{
              ...styles.modeBtn,
              ...(mode === 'local' ? styles.modeBtnActive : {}),
            }}
            onClick={() => setMode('local')}
          >
            📶 Local WiFi
          </button>
        </div>

        <div style={styles.instructions}>
          {mode === 'internet' ? (
            <p>Enter the server URL from the desktop app (default: <code style={styles.code}>http://localhost:3001</code>).</p>
          ) : (
            <p>
              Enter the local address shown in the desktop app (e.g.,{' '}
              <code style={styles.code}>192.168.1.100:3002</code>).
              Both devices must be on the same Wi-Fi.
            </p>
          )}
        </div>

        <label style={styles.label}>
          Server Address
          <input
            style={styles.input}
            type="text"
            placeholder={mode === 'local' ? '192.168.1.100:3002' : 'http://localhost:3001'}
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
          />
        </label>

        <label style={styles.label}>
          6-Digit Pairing Code
          <input
            style={styles.input}
            type="text"
            placeholder="123456"
            value={pairingCode}
            onChange={(e) => setPairingCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
          />
        </label>

        <label style={styles.label}>
          Device Name
          <input
            style={styles.input}
            type="text"
            placeholder="My Phone"
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
          />
        </label>

        {error && <div style={styles.error}>⚠️ {error}</div>}

        <button
          style={{
            ...styles.pairButton,
            opacity: loading ? 0.6 : 1,
          }}
          onClick={handleManualPair}
          disabled={loading}
        >
          {loading ? '⏳ Pairing...' : '🔗 Pair with Desktop'}
        </button>

        <div style={styles.help}>
          <h3 style={{ marginBottom: 8, fontSize: 13, color: '#cbd5e1' }}>How to pair:</h3>
          <ol style={{ paddingLeft: 18, lineHeight: 1.8 }}>
            <li>Open the desktop app on your laptop</li>
            <li>Click <strong>"Generate Pairing Code &amp; QR"</strong></li>
            <li>Tap <strong>"📷 Scan Desktop Pairing QR"</strong> above, or type the 6 digits</li>
            <li>Once paired, start scanning QR codes!</li>
          </ol>
        </div>
      </div>

      {/* Camera scanner modal for scanning desktop pairing QR */}
      {isScanningPairQr && (
        <div style={styles.modalOverlay}>
          <div style={styles.modalContent}>
            <div style={styles.modalHeader}>
              <h3>Point camera at Desktop QR</h3>
              <button style={styles.modalCloseBtn} onClick={stopPairQrScanner}>×</button>
            </div>
            <div style={styles.modalVideoWrapper}>
              <video ref={pairVideoRef} style={styles.modalVideo} playsInline muted />
            </div>
            <p style={{ textAlign: 'center', marginTop: 12, fontSize: 13, color: '#94a3b8' }}>
              Aim your camera at the QR code on the desktop app screen
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    overflow: 'auto',
  },
  card: {
    background: '#1e293b',
    borderRadius: 16,
    padding: 24,
    maxWidth: 420,
    width: '100%',
  },
  title: {
    fontSize: 24,
    fontWeight: 700,
    marginBottom: 6,
    textAlign: 'center' as const,
  },
  subtitle: {
    color: '#94a3b8',
    fontSize: 13,
    textAlign: 'center' as const,
    marginBottom: 16,
  },
  scanQrBtn: {
    width: '100%',
    padding: '13px 16px',
    borderRadius: 10,
    border: '1px solid #3b82f6',
    background: '#1e3a8a',
    color: '#93c5fd',
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  modeToggle: {
    display: 'flex',
    gap: 8,
    marginBottom: 14,
  },
  modeBtn: {
    flex: 1,
    padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid #334155',
    background: 'transparent',
    color: '#94a3b8',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 500,
  },
  modeBtnActive: {
    background: '#2563eb',
    borderColor: '#2563eb',
    color: '#fff',
  },
  instructions: {
    background: '#0f172a',
    padding: '10px 14px',
    borderRadius: 8,
    marginBottom: 14,
    fontSize: 12,
    color: '#94a3b8',
    lineHeight: 1.5,
  },
  code: {
    background: '#334155',
    padding: '2px 6px',
    borderRadius: 4,
    fontSize: 12,
    color: '#60a5fa',
  },
  label: {
    display: 'block',
    marginBottom: 10,
    fontSize: 13,
    fontWeight: 500,
    color: '#cbd5e1',
  },
  input: {
    display: 'block',
    width: '100%',
    marginTop: 4,
    padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid #334155',
    background: '#0f172a',
    color: '#e2e8f0',
    fontSize: 15,
    outline: 'none',
  },
  error: {
    background: '#7f1d1d',
    color: '#fca5a5',
    padding: '10px 14px',
    borderRadius: 8,
    fontSize: 13,
    marginBottom: 12,
  },
  pairButton: {
    width: '100%',
    padding: '14px 20px',
    borderRadius: 10,
    border: 'none',
    background: '#16a34a',
    color: '#fff',
    fontSize: 16,
    fontWeight: 600,
    cursor: 'pointer',
    marginTop: 4,
    marginBottom: 16,
  },
  help: {
    borderTop: '1px solid #334155',
    paddingTop: 14,
    fontSize: 12,
    color: '#94a3b8',
  },
  modalOverlay: {
    position: 'fixed' as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0,0,0,0.85)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
    padding: 16,
  },
  modalContent: {
    background: '#1e293b',
    borderRadius: 16,
    padding: 16,
    maxWidth: 380,
    width: '100%',
  },
  modalHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  modalCloseBtn: {
    background: '#dc2626',
    border: 'none',
    borderRadius: '50%',
    color: '#fff',
    width: 28,
    height: 28,
    cursor: 'pointer',
    fontSize: 18,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalVideoWrapper: {
    width: '100%',
    height: 280,
    borderRadius: 12,
    overflow: 'hidden',
    background: '#000',
  },
  modalVideo: {
    width: '100%',
    height: '100%',
    objectFit: 'cover' as const,
  },
};
