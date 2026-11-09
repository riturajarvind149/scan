# QR-to-Windows 11

Scan any QR code with your phone and see that exact image on your Windows 11 laptops. Open your link, point the phone, and an always-on-top window pops up on the laptop showing the code, straightened and cropped.

```
 Phone browser                                       Windows 11 app
 (camera + scanner)                                  (always-on-top popup)
       │                                                    ▲
       │  Same Wi-Fi: HTTPS/WSS straight to the laptop      │
       ├────────────────────────────────────────────────────┤
       │  Anywhere: HTTPS/WSS through your relay server     │
       └───────────────► relay server ──────────────────────┘
```

The phone needs no app or pairing: anyone with your relay's link opens it and scans, and every laptop on the relay receives the scan. Laptops need the desktop app and join once with an invite link from the admin dashboard at `/admin`. Same-Wi-Fi mode needs no server, and is the one case that still pairs a phone with a code.

## Use it

1. In the dashboard at `https://your-relay/admin`, choose **Create invite link** and open that link on each laptop. It offers the installer and then joins the laptop to the relay.
2. On any phone, open `https://your-relay` and allow the camera. Bookmark it.
3. Point the phone at any QR code. A green tick shows it was scanned and the camera holds still, so one code is only sent once; tap **Rescan** to scan again. A floating window pops up on every laptop and stays on top until you close it. It shows the code straightened, cropped and neutral in colour whenever that copy reads exactly the same as the original photo, and **Show original** switches to the photo itself.

The dashboard lists the laptops, removes them, cancels the invite link, and can pause scanning.

**Live view:** tick **Live view** in the desktop app for an always-on-top window that shows codes as they arrive, rather than a popup for each. Good for codes you keep an eye on, like attendance codes on a projector. Several codes in view at once each get their own tile or popup, placed side by side.

**Same Wi-Fi instead of a relay:** in the app choose **Same Wi-Fi**, then **Show pairing code**, and scan it with your phone's normal camera.

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

That builds everything and opens the app.

| Command | What it does |
| --- | --- |
| `npm test` | Unit and integration tests; nothing needs building first |
| `npm run typecheck` | Type-checks every workspace |
| `npm run test:e2e` | Full run against the real app and Edge with a simulated camera (Windows; shows real popups) |
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

**Render (free):** create a Blueprint from this repository; `render.yaml` configures it, including a generated `RELAY_SECRET`. The free instance sleeps when idle, so the first request after a quiet spell can take about a minute. **Anywhere else:** run the `Dockerfile` behind an HTTPS proxy, which most hosts provide automatically.

```bash
docker build -t qr-to-windows-relay .
```

```bash
docker run -p 3001:3001 -v qr-relay-data:/data -e TRUST_PROXY=1 -e RELAY_SECRET=your-long-random-value qr-to-windows-relay
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | Port to listen on |
| `RELAY_SECRET` | generated and kept in `DATA_DIR` | Signs every credential, at least 32 characters. Set it on any host that wipes its disk, and never change it: that signs out every laptop |
| `ADMIN_PASSWORD` | none | Password for `/admin`, at least 8 characters. Without it the dashboard stays off, and no new laptops can join |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | none | Keeps the laptop list and removals across restarts on hosts that wipe their disk. A [free Upstash database](https://upstash.com) needs no card |
| `DESKTOP_DOWNLOAD_URL` | this repository's latest release | Installer link on the invite page |
| `DATA_DIR` | `apps/server/data`, `/data` in Docker | Where records are saved on disk |
| `TRUST_PROXY` | `0` | Reverse proxies in front of the server. Set to `1` on hosted platforms, or all visitors share one rate limit |
| `CORS_ORIGINS` | none | Extra origins allowed to call the API, if you host the phone app elsewhere (build it with `VITE_SERVER_URL`) |
| `WEB_ROOT` | `apps/web/dist` | Location of the built phone app |

Set `qr2win.defaultRelayUrl` in `apps/desktop/package.json` before building, so every install knows its relay. Check the relay with `https://your-relay/health`. Pushing a tag such as `v1.1.0` publishes the installer as a GitHub release, which is where the invite page's download button points.

It runs as a single instance, because live connections are held in that process.

## How it works

- **`packages/shared-types`**: the wire protocol, limits, and validation used by every part.
- **`packages/relay-core`**: pairing, credentials and message routing. Both modes run this same code.
- **`apps/server`**: relay-core as a hosted service.
- **`apps/desktop`**: the Electron app, which also runs relay-core itself over HTTPS for same-Wi-Fi mode.
- **`apps/web`**: the React phone app, served by whichever relay the phone paired with.

**Why the laptop serves the phone app.** Browsers only allow the camera on secure pages, and a secure page can't connect to plain `ws://` or `http://` addresses. So same-Wi-Fi mode must be HTTPS end to end, using a certificate the app generates for its own network addresses.

**Delivery.** A scan shows as delivered on the phone only once the laptop confirms it. If the laptop is offline, the phone holds the scan for up to 5 minutes and sends it when the laptop returns. Both sides reconnect by themselves and detect dead connections with heartbeats.

**The image.** To reach the laptop as fast as possible, the phone sends a photo of the code the moment it detects one: the code's real pixels from that camera frame, as a high-quality JPEG up to 1000 pixels across. It is never regenerated from the decoded text.

**Enhancement.** A moment later, in the background, the phone takes the sharpest of the next few frames and tries to make a clearer copy, by squaring up the code, evening out glare, stretching contrast and sharpening edges. These keep the code's real shades and never force pixels to pure black and white. The copy is used only if two independent decoders, in their normal mode, both read it as exactly the same text as the capture; otherwise only the original is shown. When it arrives, the laptop swaps it in, labelled as checked, with a button to see the original photo.

## Security

- **The public phone link:** anyone who has your relay's link can send images to your laptops, as many as they like, so treat it like a private address. The dashboard's pause switch is the protection against abuse. Search engines are asked not to index it.
- **Laptops:** only an invite link or an existing credential gets a laptop on the relay. Invites last 7 days, work for several laptops until cancelled, and every join notifies the other laptops. A laptop removed from the dashboard is cut off immediately.
- **Dashboard:** protected by `ADMIN_PASSWORD`, with 5 sign-in attempts a minute per IP address and sessions that end after 12 hours.
- **Same-Wi-Fi pairing:** 6-digit codes are single use, expire in 5 minutes, and are rate limited to 10 attempts per minute per IP address.
- **Credentials:** a connection's role comes from its credential and can't be claimed. Credentials are signed with HMAC-SHA-256 using `RELAY_SECRET` and aren't stored on the relay, so they survive a restart on an empty disk. The laptop encrypts its credential with Windows DPAPI.
- **Removals need storage:** without Upstash on a host that wipes its disk, a removed laptop's credential works again after a restart. The dashboard warns about this.
- **Transport:** internet relays must use HTTPS. Plain HTTP is accepted only on this PC or private networks.
- **Untrusted input:** every scan is validated on the relay and again on the desktop, including checking that the bytes really are the stated image type. Scanned text is shown as plain text and is never opened or turned into a link. Scans are rate limited to 30 per minute per phone.
- **Desktop app:** pages run sandboxed under a strict content security policy, and the popup has no access to app controls. Same-Wi-Fi mode listens on your network while enabled; turn it off under Settings if you only use the relay.

The relay passes images through without storing them, but the relay operator could read them in transit because they aren't end-to-end encrypted. Run your own relay.

## Known limitations

- **Image fidelity:** the original is a photo of the code, so glare, angle and focus carry over. If glare has burned out part of a code entirely, no enhancement can restore those pixels; try moving to one side or lowering the brightness slider.
- **Camera controls:** zoom and brightness use the camera's own controls where the browser offers them. Elsewhere, zoom is digital, and the brightness slider doesn't appear; iPhones generally fall in this group.
- **iPhone on same-Wi-Fi:** Safari has historically been strict about secure WebSockets with self-signed certificates. If the page loads but never connects, use internet mode.
- **Changed networks (same-Wi-Fi mode only):** a new network usually means a new laptop address, and browsers treat that as a different site, so the phone pairs again there. Internet mode has no such issue.
- **Free hosting:** the first request after the relay has been idle can take about a minute. Render's free plan also has a monthly hours limit.
- **Background scanning:** browsers pause the camera when the page isn't visible.
