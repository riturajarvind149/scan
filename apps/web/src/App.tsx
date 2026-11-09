import { useState, useCallback } from 'react';
import { QrScanner } from './components/QrScanner';
import { PairingScreen } from './components/PairingScreen';
import { StatusBar } from './components/StatusBar';
import { useConnection } from './hooks/useConnection';

type Screen = 'pairing' | 'scanner';

export default function App() {
  const [screen, setScreen] = useState<Screen>(() => {
    // Check if already paired
    const token = sessionStorage.getItem('qr2win_token');
    return token ? 'scanner' : 'pairing';
  });

  const {
    connectionState,
    sendQrImage,
    connect,
    disconnect,
  } = useConnection();

  const handlePaired = useCallback((token: string, serverUrl: string) => {
    sessionStorage.setItem('qr2win_token', token);
    sessionStorage.setItem('qr2win_server', serverUrl);
    connect(serverUrl, token);
    setScreen('scanner');
  }, [connect]);

  const handleUnpair = useCallback(() => {
    disconnect();
    sessionStorage.removeItem('qr2win_token');
    sessionStorage.removeItem('qr2win_server');
    setScreen('pairing');
  }, [disconnect]);

  // Auto-connect on mount if token exists
  useState(() => {
    const token = sessionStorage.getItem('qr2win_token');
    const serverUrl = sessionStorage.getItem('qr2win_server');
    if (token && serverUrl) {
      connect(serverUrl, token);
    }
  });

  return (
    <div style={styles.container}>
      <StatusBar
        state={connectionState}
        onUnpair={screen === 'scanner' ? handleUnpair : undefined}
      />
      {screen === 'pairing' ? (
        <PairingScreen onPaired={handlePaired} />
      ) : (
        <QrScanner
          onScan={sendQrImage}
          connectionState={connectionState}
        />
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    background: '#0f172a',
  },
};

