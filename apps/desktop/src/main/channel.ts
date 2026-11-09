import type { ClientMessage, PhoneSummary, QrImagePayload, ServerMessage } from '@qr2win/shared-types';

export type ChannelMode = 'local' | 'internet';

export interface ChannelEvents {
  onScan(scan: QrImagePayload, ack: () => void): void;
  onPhonePaired(phone: PhoneSummary, mode: ChannelMode): void;
  onLaptopJoined(): void;
  onChange(): void;
}

/** Handles the relay → desktop messages common to the Wi-Fi and internet channels. */
export function handleServerMessage(
  message: ServerMessage,
  mode: ChannelMode,
  events: ChannelEvents,
  send: (message: ClientMessage) => void,
  setPhones: (phones: PhoneSummary[]) => void,
): void {
  switch (message.type) {
    case 'connection-status':
      if (message.phones) {
        setPhones(message.phones);
        events.onChange();
      }
      break;
    case 'phone-paired':
      events.onPhonePaired(message.phone, mode);
      break;
    case 'laptop-joined':
      events.onLaptopJoined();
      break;
    case 'qr-image':
      events.onScan(message, () => send({ type: 'qr-ack', scanId: message.scanId }));
      break;
    case 'error':
      console.warn(`[${mode}] Relay error ${message.code}: ${message.message}`);
      break;
    default:
      break;
  }
}
