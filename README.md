# QR-to-Windows 11

Scan any QR code with your phone and see that exact image on your Windows 11 laptop. Point the phone, get a notification, click it, and an always-on-top window shows the code.

```
 Phone browser                                       Windows 11 app
 (camera + scanner)                                  (toast → popup)
       │                                                    ▲
       │  Same Wi-Fi: HTTPS/WSS straight to the laptop      │
       ├────────────────────────────────────────────────────┤
       │  Anywhere: HTTPS/WSS through your relay server     │
       └───────────────► relay server ──────────────────────┘
```

The phone needs no app, only a browser. The laptop needs the desktop app. Same-Wi-Fi mode needs no account and no server; internet mode needs a relay you deploy once.

## Use it

1. Install and open the desktop app. It waits in the system tray and starts receiving over Wi-Fi by itself.
2. Choose **Show pairing code** and scan the QR with your phone's normal camera. The scanner opens in your browser and pairs without any typing.
3. Point the phone at any QR code. A Windows notification appears; click it to see the code in a floating window that stays on top until you close it.

The phone stays paired. Next time, just reopen the page.

**First time on Wi-Fi:** the phone warns that the connection isn't private, because your laptop isn't a public website with a purchased certificate. Choose **Advanced**, then **Proceed**. Traffic is still encrypted. Windows also asks whether to allow the app through the firewall; allow it for the type of network you're on.

**If the phone can't reach the laptop:** campus, office and hotel Wi-Fi often block devices from talking to each other, and no app can get around that. Use internet mode there.

## Run from source

Requires Node.js 20.19 or newer, on Windows for the desktop app.

```bash
npm install
```

```bash
npm run dev:desktop
```

That builds everything and opens the app. Windows only delivers notification clicks to an installed app, so use the [installer](#build-the-installer) to try that step.

| Command | What it does |
| --- | --- |
| `npm test` | Unit and integration tests; nothing needs building first |
| `npm run typecheck` | Type-checks every workspace |
| `npm run test:e2e` | Full run against the real app and Edge with a simulated camera (Windows; shows real toasts) |
| `npm run dev:server` | Relay on port 3001, serving the phone app if it has been built with `npm run build:web` |
| `npm run dev:web` | Phone app with hot reload at `localhost:5173`, proxying to the local relay |

To work on the phone app using a real phone, build it and use the laptop's Wi-Fi server. A plain `http://192.168.x.x` page can't use the camera in any browser.

## Build the installer

```bash
npm run package:desktop
```

The installer lands in `apps/desktop/release/`. It isn't code-signed, so Windows SmartScreen warns on first run until you add a certificate. The CI workflow also builds it on every push.

## Deploy the internet relay

The relay is one service that also hosts the phone app, so there's nothing else to deploy.

**Render:** create a Blueprint from this repository; `render.yaml` configures it. **Anywhere else:** run the `Dockerfile` behind an HTTPS proxy, which most hosts provide automatically.

```bash
docker build -t qr-to-windows-relay .
```

```bash
docker run -p 3001:3001 -v qr-relay-data:/data -e TRUST_PROXY=1 qr-to-windows-relay
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | Port to listen on |
| `DATA_DIR` | `apps/server/data`, `/data` in Docker | Where pairings are saved; use a persistent volume |
| `TRUST_PROXY` | `0` | Reverse proxies in front of the server. Set to `1` on hosted platforms, or all visitors share one rate limit |
| `CORS_ORIGINS` | none | Extra origins allowed to call the API, if you host the phone app elsewhere (build it with `VITE_SERVER_URL`) |
| `WEB_ROOT` | `apps/web/dist` | Location of the built phone app |

Then paste your relay's `https://` address under **Settings** in the desktop app. Check it with `https://your-relay/health`.

It runs as a single instance, because live connections and pairings are held in that process and its data file.

## How it works

- **`packages/shared-types`**: the wire protocol, limits, and validation used by every part.
- **`packages/relay-core`**: pairing, credentials and message routing. Both modes run this same code.
- **`apps/server`**: relay-core as a hosted service.
- **`apps/desktop`**: the Electron app, which also runs relay-core itself over HTTPS for same-Wi-Fi mode.
- **`apps/web`**: the React phone app, served by whichever relay the phone paired with.

**Why the laptop serves the phone app.** Browsers only allow the camera on secure pages, and a secure page can't connect to plain `ws://` or `http://` addresses. So same-Wi-Fi mode must be HTTPS end to end, using a certificate the app generates for its own network addresses.

**Delivery.** A scan shows as delivered on the phone only once the laptop confirms it. If the laptop is offline, the phone holds the scan for up to 5 minutes and sends it when the laptop returns. Both sides reconnect by themselves and detect dead connections with heartbeats.

**The image.** The phone copies the code's pixels straight from the camera frame into a PNG with a clear margin around it. It is never regenerated from the decoded text.

## Security

- **Pairing:** 6-digit codes are single use, expire in 5 minutes, and are rate limited to 10 attempts per minute per IP address. The laptop announces every new phone and can remove any of them, which cuts its connection immediately.
- **Credentials:** a connection's role comes from its credential and can't be claimed. Tokens are 256-bit random values, and the relay stores only their SHA-256 hashes. The laptop encrypts its relay credential with Windows DPAPI. On the phone the token is in the site's local storage.
- **Transport:** internet relays must use HTTPS. Plain HTTP is accepted only on this PC or private networks.
- **Untrusted input:** every scan is validated on the relay and again on the desktop, including checking that the bytes really are the stated image type. Scanned text is shown as plain text and is never opened or turned into a link. Scans are rate limited to 30 per minute per phone.
- **Desktop app:** pages run sandboxed under a strict content security policy, and the popup has no access to app controls. Same-Wi-Fi mode listens on your network while enabled; turn it off under Settings if you only use the relay.

The relay passes images through without storing them, but the relay operator could read them in transit because they aren't end-to-end encrypted. Run your own relay.

## Known limitations

- **Notifications:** Do Not Disturb, Focus and full-screen apps can hide toasts, and Windows controls this. Scans still appear under **Recent scans** and in the tray menu's **Show latest QR code**.
- **Image fidelity:** it's a photo of the code, so glare, angle and focus carry over. The crop is a straight rectangle, not perspective-corrected.
- **iPhone on same-Wi-Fi:** Safari has historically been strict about secure WebSockets with self-signed certificates. If the page loads but never connects, use internet mode.
- **Changed networks:** a new Wi-Fi network usually means a new laptop address, and browsers treat that as a different site, so the phone pairs again there.
- **Background scanning:** browsers pause the camera when the page isn't visible.
