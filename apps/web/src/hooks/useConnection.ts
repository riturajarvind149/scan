import { useState, useRef, useCallback, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import type {
  AuthMessage,
  AuthResult,
  QrImagePayload,
  QrAck,
  ErrorMessage,
  WsMessage,
} from '@qr2win/shared-types';
import { WS_HEARTBEAT_INTERVAL_MS } from '@qr2win/shared-types';

export interface ConnectionState {
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  error?: string;
}

export function useConnection() {
  const [connectionState, setConnectionState] = useState<ConnectionState>({
    status: 'disconnected',
  });

  const wsRef = useRef<WebSocket | null>(null);
  const tokenRef = useRef<string | null>(null);
  const urlRef = useRef<string | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectAttemptsRef = useRef(0);

  const cleanup = useCallback(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const connect = useCallback((url: string, token: string) => {
    cleanup();
    tokenRef.current = token;
    urlRef.current = url;
    reconnectAttemptsRef.current = 0;

    const doConnect = () => {
      setConnectionState({ status: 'connecting' });

      try {
        const ws = new WebSocket(url);
        wsRef.current = ws;

        ws.onopen = () => {
          // Authenticate immediately
          const auth: AuthMessage = { type: 'auth', token, role: 'phone' };
          ws.send(JSON.stringify(auth));
        };

        ws.onmessage = (event) => {
          try {
            const msg: WsMessage = JSON.parse(event.data);

            switch (msg.type) {
              case 'auth-result': {
                const result = msg as AuthResult;
                if (result.success) {
                  setConnectionState({ status: 'connected' });
                  reconnectAttemptsRef.current = 0;

                  // Start heartbeat
                  heartbeatRef.current = setInterval(() => {
                    if (ws.readyState === WebSocket.OPEN) {
                      ws.send(JSON.stringify({ type: 'ping' }));
                    }
                  }, WS_HEARTBEAT_INTERVAL_MS);
                } else {
                  setConnectionState({
                    status: 'error',
                    error: result.error || 'Authentication failed',
                  });
                }
                break;
              }
              case 'qr-ack':
                // Scan delivered successfully
                break;
              case 'error': {
                const errMsg = msg as ErrorMessage;
                console.warn('[ws] Server error:', errMsg.message);
                if (errMsg.code === 'DESKTOP_OFFLINE') {
                  // Not fatal – desktop just not connected
                }
                break;
              }
              case 'connection-status':
                // Could update UI with paired device count
                break;
            }
          } catch {
            // Ignore parse errors
          }
        };

        ws.onclose = (event) => {
          cleanup();
          if (event.code === 4003) {
            // Invalid token – don't reconnect
            setConnectionState({ status: 'error', error: 'Token rejected. Please re-pair.' });
            return;
          }

          // Auto-reconnect with backoff
          const maxDelay = 30000;
          const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), maxDelay);
          reconnectAttemptsRef.current++;
          setConnectionState({ status: 'connecting', error: `Reconnecting in ${Math.round(delay / 1000)}s…` });
          reconnectTimerRef.current = setTimeout(doConnect, delay);
        };

        ws.onerror = () => {
          // onclose will fire after this
        };
      } catch (err: any) {
        setConnectionState({ status: 'error', error: err.message });
      }
    };

    doConnect();
  }, [cleanup]);

  const disconnect = useCallback(() => {
    cleanup();
    tokenRef.current = null;
    urlRef.current = null;
    setConnectionState({ status: 'disconnected' });
  }, [cleanup]);

  const sendQrImage = useCallback(
    (imageBase64: string, mimeType: string, width: number, height: number, decodedText: string) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        console.warn('[ws] Cannot send – not connected');
        return;
      }

      const payload: QrImagePayload = {
        type: 'qr-image',
        scanId: uuidv4(),
        timestamp: Date.now(),
        mimeType: mimeType as QrImagePayload['mimeType'],
        width,
        height,
        imageBase64,
        decodedText,
      };

      wsRef.current.send(JSON.stringify(payload));
    },
    []
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  return {
    connectionState,
    connect,
    disconnect,
    sendQrImage,
  };
}

