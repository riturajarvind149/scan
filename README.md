# QR-to-Windows-11

Scan QR codes on your phone and receive them instantly on your Windows 11 desktop.

## Architecture

```
┌─────────────────┐     WebSocket      ┌──────────────┐     WebSocket      ┌───────────────────┐
│  Phone Browser  │◄──────────────────►│  Express     │◄──────────────────►│  Electron Desktop │
│  (React + Vite) │    (Internet)      │  Server      │    (Internet)      │  App (Win 11)     │
│  apps/web       │                    │  apps/server  │                    │  apps/desktop     │
└────────┬────────┘                    └──────────────┘                    └────────┬──────────┘
         │                                                                          │
         │              Direct WebSocket (Local Wi-Fi)                              │
         └──────────────────────────────────────────────────────────────────────────┘
```

- **`apps/web`** – React + Vite QR scanner website (opened on phone)
- **`apps/server`** – Node.js Express + WebSocket relay server (Internet mode)
- **`apps/desktop`** – Electron desktop app for Windows 11 (receives QR images)
- **`packages/shared-types`** – Shared TypeScript types and constants

## Prerequisites

- **Node.js** ≥ 18 (tested with v20)
- **npm** ≥ 9
- **Windows 11** (for the desktop app)
- A phone with a modern browser (Chrome, Safari, Firefox)

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Start the relay server (Internet mode)

```bash
npm run dev:server
# Starts on http://localhost:3001
```

### 3. Start the web app

```bash
npm run dev:web
# Starts on http://localhost:5173 (accessible from LAN)
```

### 4. Start the desktop app

```bash
npm run dev:desktop
# Opens the Electron window
```

## How to Pair

### Internet Mode

1. Open the **desktop app** and note the server URL (default: `http://localhost:3001`)
2. Click **"Generate Pairing Code"** — a 6-digit code appears
3. On your **phone**, open the web app URL
4. Enter the server URL and 6-digit code
5. Tap **"Pair with Desktop"**
6. Start scanning QR codes!

### Local Wi-Fi Mode

1. In the desktop app, click **"Start Local Server"**
2. Note the displayed IP addresses (e.g., `192.168.1.100:3002`) and pairing code
3. On your phone, enter the local address as the server URL
4. Enter the pairing code and pair
5. Both devices must be on the **same Wi-Fi network**

## Testing Local Wi-Fi Mode

1. Connect both your phone and laptop to the same Wi-Fi network
2. Start the local server in the desktop app
3. On your phone, use the IP address shown (NOT `localhost`)
4. If connection fails, check Windows Firewall (see troubleshooting below)

## Deploying the Backend (Internet Mode)

To use Internet mode across different networks:

1. Deploy `apps/server` to a cloud provider (Railway, Render, Fly.io, etc.)
2. Set environment variables:
   ```
   PORT=3001
   CORS_ORIGIN=https://your-web-app.com
   ```
3. Build: `npm run build:server`
4. Start: `node apps/server/dist/index.js`
5. Update the desktop app's server URL and the phone's server URL to point to the deployed backend
6. For production, use `wss://` (WebSocket Secure) via your hosting provider's TLS termination

> **Important**: Internet mode requires a deployed, reachable backend server. The app does not pretend to work over the internet without one. The default `localhost:3001` only works when both devices can reach that address.

## Building the Desktop App

```bash
# Build TypeScript
npm run build:desktop

# Package for Windows
cd apps/desktop
npm run package
# Output in apps/desktop/release/
```

## Running Tests

```bash
npm test
```

Tests cover:
- Pairing code generation and validation
- Token management and revocation
- Rate limiting
- WebSocket authentication and rejection
- QR image delivery and routing
- Duplicate scan deduplication
- Payload validation (size, MIME type, dimensions)
- Cross-device routing isolation
- Desktop offline notification
- Error paths

## Type Checking

```bash
npm run typecheck
```

## Windows Firewall Troubleshooting

When using Local Wi-Fi Mode, Windows Firewall may block incoming connections.

### Allow Node.js through firewall:

1. Open **Windows Security** → **Firewall & network protection**
2. Click **"Allow an app through firewall"**
3. Click **"Change settings"** → **"Allow another app"**
4. Browse to your Node.js installation (e.g., `C:\Program Files\nodejs\node.exe`)
5. Check **"Private"** network
6. Click **OK**

### Or via PowerShell (Admin):

```powershell
New-NetFirewallRule -DisplayName "QR-to-Windows-11 Local" -Direction Inbound -Protocol TCP -LocalPort 3002 -Action Allow -Profile Private
```

## Camera Permission Troubleshooting

- **Chrome (Android)**: Settings → Site Settings → Camera → Allow for the web app URL
- **Safari (iOS)**: Settings → Safari → Camera → Allow
- The web app **requires HTTPS** in production for camera access. In local development, `localhost` and local IPs work without HTTPS in most browsers
- When testing over local Wi-Fi, your phone's browser may require you to manually accept the non-HTTPS connection

## Security Considerations

- **Context Isolation**: Electron renderer has no direct Node.js access; all IPC goes through a validated preload bridge
- **Content Security Policy**: Restrictive CSP on desktop HTML pages
- **Token Security**: Pairing tokens are cryptographically random (64 bytes), never logged, and stored only in `sessionStorage` (phone) or encrypted settings (desktop)
- **Authentication**: All WebSocket connections require valid token authentication within 10 seconds
- **Input Validation**: MIME types, image dimensions, and payload sizes are validated server-side
- **Rate Limiting**: 30 scans per minute per token
- **No Content Execution**: QR content is displayed as text only — URLs are never opened or executed
- **Image Safety**: QR images displayed via `data:` URIs with CSP restrictions
- **Pairing Codes**: 6-digit codes expire after 5 minutes and are single-use

## Known Limitations

### QR Image Cropping
Camera-based cropping cannot guarantee pixel-for-pixel identity with the physical QR code. Factors include:
- Perspective distortion from camera angle
- Glare and reflections
- Camera resolution and focus quality
- The library provides corner points which we use to crop, but the crop is from the camera frame — not a reconstruction

### Windows Notifications
- Notifications may not appear when **Windows Focus Assist / Do Not Disturb** is enabled
- Full-screen exclusive applications (especially DirectX games) may suppress notification popups
- The always-on-top popup window works in most cases but may be occluded by other always-on-top windows
- Some notification settings are controlled at the OS level and cannot be overridden by the app

### Network
- Local Wi-Fi mode requires both devices on the same network with no AP isolation
- Some corporate/university networks block device-to-device communication
- Internet mode requires a deployed backend — `localhost` is not accessible from a phone on a different network
- WebSocket connections may be interrupted by network changes (handled via auto-reconnect)

### Browser Compatibility
- Camera access requires a secure context (HTTPS) in production
- Some older browsers may not support the required camera APIs
- iOS Safari may have restrictions on background WebSocket connections

## Project Structure

```
SCANNER/
├── package.json              # Root workspace config
├── tsconfig.base.json        # Shared TypeScript config
├── packages/
│   └── shared-types/         # Shared types and constants
│       └── src/index.ts
├── apps/
│   ├── server/               # Express + WebSocket relay
│   │   └── src/
│   │       ├── index.ts      # Server entry point
│   │       ├── pairing.ts    # Pairing store
│   │       ├── ws-handler.ts # WebSocket message handler
│   │       └── server.test.ts# Comprehensive tests
│   ├── web/                  # React + Vite phone scanner
│   │   └── src/
│   │       ├── App.tsx
│   │       ├── components/
│   │       │   ├── QrScanner.tsx
│   │       │   ├── PairingScreen.tsx
│   │       │   └── StatusBar.tsx
│   │       └── hooks/
│   │           └── useConnection.ts
│   └── desktop/              # Electron desktop app
│       ├── src/main/
│       │   ├── index.ts      # Main process
│       │   ├── preload.ts    # Secure preload bridge
│       │   ├── connection.ts # Internet mode WebSocket
│       │   ├── local-server.ts # Local Wi-Fi server
│       │   ├── local-pairing.ts # Local pairing store
│       │   └── settings.ts   # Persistent settings
│       └── assets/
│           ├── index.html    # Main window UI
│           └── popup.html    # QR popup window
```

