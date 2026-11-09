import type { ConnectionState } from '../hooks/useConnection';

interface StatusBarProps {
  state: ConnectionState;
  onUnpair?: () => void;
}

export function StatusBar({ state, onUnpair }: StatusBarProps) {
  const statusColors: Record<string, string> = {
    disconnected: '#ef4444',
    connecting: '#f59e0b',
    connected: '#22c55e',
    error: '#ef4444',
  };

  const statusLabels: Record<string, string> = {
    disconnected: '⚪ Not connected',
    connecting: '🟡 Connecting…',
    connected: '🟢 Connected',
    error: '🔴 Error',
  };

  return (
    <div style={styles.bar}>
      <div style={styles.status}>
        <span
          style={{
            ...styles.dot,
            background: statusColors[state.status] || '#64748b',
          }}
        />
        <span style={styles.text}>
          {statusLabels[state.status] || state.status}
        </span>
        {state.error && (
          <span style={styles.errorText}> — {state.error}</span>
        )}
      </div>
      {onUnpair && (
        <button style={styles.unpairBtn} onClick={onUnpair}>
          Unpair
        </button>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 16px',
    background: '#1e293b',
    borderBottom: '1px solid #334155',
    fontSize: 13,
  },
  status: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    display: 'inline-block',
  },
  text: {
    color: '#e2e8f0',
  },
  errorText: {
    color: '#fca5a5',
    fontSize: 12,
  },
  unpairBtn: {
    padding: '6px 12px',
    borderRadius: 6,
    border: '1px solid #475569',
    background: 'transparent',
    color: '#94a3b8',
    cursor: 'pointer',
    fontSize: 12,
  },
};

