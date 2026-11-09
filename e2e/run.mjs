// End-to-end test of the real product: the built relay server, the real Electron app, and a real
// browser (Microsoft Edge) as the phone, whose camera is fed a video of actual QR codes.
//
// Run with: npm run test:e2e     (Windows; shows real popups while it runs)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import jsQR from 'jsqr';
import { _electron, chromium } from 'playwright-core';
import { PNG } from 'pngjs';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import QRCode from 'qrcode';

const require = createRequire(import.meta.url);
prepareZXingModule({ overrides: { wasmBinary: fs.readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm')).buffer } });
const ROOT = path.resolve(import.meta.dirname, '..');
const OUTPUT = path.join(ROOT, 'e2e', 'output');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'qr2win-e2e-'));

const CODE_A = 'https://example.com/first-code';
const CODE_B = 'WIFI:S:Cafe;T:WPA;P:espresso;;';
const CODE_LEFT = 'https://example.com/shown-side-by-side/left';
const CODE_RIGHT = 'https://example.com/shown-side-by-side/right';
const CODE_FAR = 'https://example.com/small-and-far-away';
const CODE_PROJECTOR = 'https://example.com/washed-out-projector';
const ALL_CODES = [CODE_A, CODE_B, CODE_LEFT, CODE_RIGHT, CODE_FAR, CODE_PROJECTOR];

/** Records what a phone page sends, to measure how big and how quick each scan really is. */
function recordUploads() {
  window.uploads = [];
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function record(data) {
    try {
      const message = JSON.parse(data);
      if (message.type === 'qr-image') window.uploads.push({ type: message.type, bytes: data.length, waitedMs: Date.now() - message.timestamp, hasEnhanced: !!message.enhanced, text: message.decodedText });
      if (message.type === 'qr-enhanced') window.uploads.push({ type: message.type, bytes: data.length });
    } catch {
      // Not ours.
    }
    return send.call(this, data);
  };
}

/** Keeps tapping Rescan, for the tests that need a stream of scans from one phone. */
function keepRescanning() {
  setInterval(() => {
    const button = document.querySelector('button.rescan');
    if (button && !button.disabled) button.click();
  }, 2500);
}

/** Makes the simulated camera report zoom and brightness controls, and records what gets set. */
function offerCameraControls() {
  window.cameraSettings = [];
  MediaStreamTrack.prototype.getCapabilities = () => ({ zoom: { min: 1, max: 8, step: 0.1 }, exposureCompensation: { min: -2, max: 2, step: 0.1 } });
  MediaStreamTrack.prototype.applyConstraints = async (constraints) => {
    window.cameraSettings.push(constraints.advanced?.[0] ?? {});
  };
}

const IPHONE_SIZED = { viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true };

let passed = 0;
function ok(name) {
  passed++;
  console.log(`  ok ${passed} - ${name}`);
}

async function until(description, check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (err) {
      last = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for: ${description}${last ? ` (${last.message})` : ''}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function drawCode(frame, text, width, height, { size = Math.min(width, height) * 0.7, centerX = width / 2, centerY = height / 2, ink = 16 } = {}) {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const scale = Math.max(1, Math.floor(size / modules.size));
  const left = Math.floor(centerX - (modules.size * scale) / 2);
  const top = Math.floor(centerY - (modules.size * scale) / 2);
  for (let y = 0; y < modules.size * scale; y++) {
    for (let x = 0; x < modules.size * scale; x++) {
      if (modules.get(Math.floor(y / scale), Math.floor(x / scale))) frame[(top + y) * width + left + x] = ink;
    }
  }
}

/** Writes a looping camera feed of codes in increasingly hard conditions. Chromium plays it as a webcam. */
function writeCameraVideo(file) {
  const [width, height, fps] = [640, 480, 5];
  const out = fs.openSync(file, 'w');
  fs.writeSync(out, `YUV4MPEG2 W${width} H${height} F${fps}:1 Ip A1:1 C420jpeg\n`);
  const chroma = Buffer.alloc((width * height) / 2, 128);
  const empty = Buffer.alloc(width * height, 200);
  const withA = Buffer.alloc(width * height, 235);
  const withB = Buffer.alloc(width * height, 235);
  drawCode(withA, CODE_A, width, height);
  drawCode(withB, CODE_B, width, height);
  const sideBySide = Buffer.alloc(width * height, 235);
  drawCode(sideBySide, CODE_LEFT, width, height, { size: 270, centerX: 165 });
  drawCode(sideBySide, CODE_RIGHT, width, height, { size: 270, centerX: 475 });
  // Far away: a code a sixth of the frame, which the old 400-pixel scan could not resolve reliably.
  const farAway = Buffer.alloc(width * height, 150);
  for (let y = 180; y < 300; y++) farAway.fill(235, y * width + 260, y * width + 380);
  drawCode(farAway, CODE_FAR, width, height, { size: 100 });
  // A projector with strong room light: black ink comes out as a pale grey.
  const projector = Buffer.alloc(width * height, 245);
  drawCode(projector, CODE_PROJECTOR, width, height, { ink: 190 });
  const script = [[withA, 2], [empty, 4], [withB, 2], [empty, 4], [sideBySide, 2], [empty, 4], [farAway, 2], [empty, 4], [projector, 2], [empty, 4]];
  for (const [luma, seconds] of script) {
    for (let i = 0; i < seconds * fps; i++) {
      fs.writeSync(out, 'FRAME\n');
      fs.writeSync(out, luma);
      fs.writeSync(out, chroma);
    }
  }
  fs.closeSync(out);
}

/** Reads an image as a scanner would. The first photo of a scan is a JPEG, and the clearer copy a PNG. */
async function decodeDataUrl(dataUrl) {
  const [header, base64] = dataUrl.split(',');
  const bytes = Buffer.from(base64, 'base64');
  if (header.startsWith('data:image/png')) {
    const png = PNG.sync.read(bytes);
    return { width: png.width, height: png.height, text: jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data };
  }
  assert.match(header, /^data:image\/jpeg;base64$/);
  const [result] = await readBarcodes(new Uint8Array(bytes), { formats: ['QRCode'], tryHarder: true });
  return { width: 0, height: 0, text: result?.isValid ? result.text : undefined };
}

async function launchDesktop(userData) {
  // Start with no relay so a fresh test profile doesn't use the one built into the app.
  const settingsFile = path.join(userData, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify({ serverUrl: '' }));
  }
  // E2E_PACKAGED tests what people actually install, rather than the development build.
  const packaged = process.env.E2E_PACKAGED ? path.join(ROOT, 'apps', 'desktop', 'release', 'win-unpacked', 'QR-to-Windows-11.exe') : null;
  const electronApp = await _electron.launch({
    executablePath: packaged ?? require('electron'),
    args: packaged ? [`--user-data-dir=${userData}`] : [path.join(ROOT, 'apps', 'desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' },
  });
  // Count every popup as the app opens it, including ones already closed, and any toast about a scan.
  await electronApp.evaluate(({ app, Notification }) => {
    globalThis.popupsOpened = 0;
    globalThis.scanToasts = 0;
    globalThis.popupsTookFocus = 0;
    app.on('browser-window-created', (_event, win) => {
      win.webContents.once('did-finish-load', () => {
        if (win.webContents.getURL().endsWith('popup.html')) globalThis.popupsOpened++;
      });
      // Checked just after appearing, since Windows may later hand it focus when another window closes.
      win.once('show', () => setTimeout(() => {
        if (!win.isDestroyed() && win.getTitle() === 'QR code' && win.isFocused()) globalThis.popupsTookFocus++;
      }, 100));
    });
    const show = Notification.prototype.show;
    Notification.prototype.show = function record() {
      if (this.title === 'QR code received') globalThis.scanToasts++;
      return show.call(this);
    };
  });
  const page = await electronApp.firstWindow();
  const problems = [];
  page.on('pageerror', (err) => problems.push(err.message));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  await page.waitForLoadState('domcontentloaded');
  return { electronApp, page, problems };
}

const popupsOpened = (app) => app.evaluate(() => globalThis.popupsOpened);

const popupWindows = (app) => app.windows().filter((win) => win.url().endsWith('popup.html'));

async function readPairingLink(page) {
  await page.click('#showPairing');
  await page.waitForSelector('#pairing:not([hidden])');
  const qr = await decodeDataUrl(await page.getAttribute('#pairingQr', 'src'));
  assert.ok(qr.text, 'the pairing QR must be scannable');
  return { url: qr.text, code: await page.textContent('#pairingCode') };
}

/** Expects a scan to pop up by itself, straightened and reading the same. Returns the text of the scan. */
async function verifyScanCycle(app, page, phone, label, screenshots) {
  const already = new Set(popupWindows(app));

  await until(`${label}: a QR scan shows as delivered on the phone`, async () =>
    (await phone.textContent('.scan-result strong').catch(() => ''))?.includes('On your laptop'),
  );
  let popup;
  await until(`${label}: a popup opens with nothing clicked`, () => {
    popup = popupWindows(app).find((win) => !already.has(win));
    return !!popup;
  });
  assert.equal(await app.evaluate(() => globalThis.scanToasts), 0, 'a scan must not raise a notification as well');
  ok(`${label}: phone reports delivery and the popup opens by itself, with no notification`);

  await popup.waitForSelector('#image img');
  await until(`${label}: popup image renders`, () => popup.$eval('#image img', (img) => img.complete && img.naturalWidth > 0));

  const alwaysOnTop = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().filter((win) => win.getTitle() === 'QR code').every((win) => win.isAlwaysOnTop()),
  );
  assert.equal(alwaysOnTop, true);
  await until(`${label}: the popup becomes visible`, () =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((win) => win.getTitle() === 'QR code' && win.isVisible())), 3000);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await app.evaluate(() => globalThis.popupsTookFocus), 0, 'a popup opening must not take focus from what is being typed');
  ok(`${label}: the popup is always on top and leaves the keyboard focus alone`);

  const image = await decodeDataUrl(await popup.$eval('#image img', (img) => img.src));
  assert.ok(ALL_CODES.includes(image.text), `popup image must decode to a fed code, got ${image.text}`);
  ok(`${label}: the image shown decodes correctly (${image.width}x${image.height}): ${image.text}`);

  const footer = await popup.textContent('#details');
  assert.ok(footer.includes(image.text));

  await until(`${label}: straightened copy arrives`, () => popup.isVisible('#version'), 10_000);
  let shown;
  await until(`${label}: popup swaps in the straightened copy`, async () => {
    const src = await popup.$eval('#image img', (img) => img.src);
    if (!src.startsWith('data:image/png')) return false;
    shown = await decodeDataUrl(src);
    return shown.text === image.text;
  });
  assert.equal(shown.width, shown.height, 'the straightened code must be square');
  ok(`${label}: the straightened copy is square (${shown.width}x${shown.height}) and reads the same`);
  await popup.click('#toggleVersion');
  const original = await decodeDataUrl(await popup.$eval('#image img', (img) => img.src));
  assert.equal(original.text, image.text, 'the original and the clearer copy must read the same');
  assert.match(await popup.textContent('#versionNote'), /Original/);
  ok(`${label}: the original photo is one click away and reads the same`);
  await popup.click('#toggleVersion');
  assert.equal(await popup.$('#details a'), null, 'scanned text must never become a link');

  if (screenshots) {
    await popup.screenshot({ path: path.join(OUTPUT, `${label}-popup.png`) });
    await phone.screenshot({ path: path.join(OUTPUT, `${label}-phone.png`) });
    await page.screenshot({ path: path.join(OUTPUT, `${label}-desktop.png`) });
  }

  const closed = popup.waitForEvent('close');
  await popup.click('#close');
  await closed;
  ok(`${label}: the popup stays until closed, then closes`);
  return image.text;
}

async function main() {
  fs.rmSync(OUTPUT, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT, { recursive: true });

  const video = path.join(WORK, 'camera.y4m');
  writeCameraVideo(video);

  const RELAY_SECRET = 'e2e-secret-e2e-secret-e2e-secret-e2e-secret';
  const ADMIN_PASSWORD = 'e2e-admin-password';
  const port = await freePort();
  const relayUrl = `http://localhost:${port}`;
  const startRelay = (dataDir) =>
    spawn(process.execPath, [path.join(ROOT, 'apps', 'server', 'dist', 'index.js')], {
      env: { ...process.env, PORT: String(port), DATA_DIR: path.join(WORK, dataDir), RELAY_SECRET, ADMIN_PASSWORD },
      stdio: 'ignore',
    });
  const relay = startRelay('relay-data');
  await until('relay health check', async () => (await fetch(`${relayUrl}/health`)).ok);
  ok('the built relay server starts and answers /health');

  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`],
  });

  const userData = path.join(WORK, 'desktop-data');
  let { electronApp, page, problems } = await launchDesktop(userData);
  const phoneProblems = [];
  const watchPhone = (phonePage) => {
    phonePage.on('pageerror', (err) => phoneProblems.push(err.message));
    phonePage.on('console', (message) => {
      if (message.type() === 'error' && !/WebSocket|ERR_CONNECTION|Failed to load resource/.test(message.text())) {
        phoneProblems.push(message.text());
      }
    });
  };

  try {
    // â”€â”€ Local Wi-Fi â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    console.log('Local Wi-Fi mode');
    await until('Wi-Fi server running', async () => (await page.textContent('#localStatus')).includes('ready'));
    ok('the Wi-Fi server starts by itself with the app');

    const localLink = await readPairingLink(page);
    assert.match(localLink.url, /^https:\/\/[\d.]+:\d+\/#pair=\d{6}$/);
    ok(`the pairing QR opens the phone app directly over HTTPS: ${new URL(localLink.url).origin}`);
    await page.screenshot({ path: path.join(OUTPUT, 'pairing-qr.png') });

    // Accepting the certificate warning, as the user does once on their phone.
    const localContext = await browser.newContext({ ...IPHONE_SIZED, ignoreHTTPSErrors: true });
    await localContext.addInitScript(keepRescanning);
    const localPhone = await localContext.newPage();
    watchPhone(localPhone);
    await localPhone.goto(localLink.url);
    await until('phone paired over Wi-Fi', async () => (await localPhone.textContent('.pill')).includes('Laptop connected'));
    assert.equal(new URL(localPhone.url()).hash, '', 'the code must not stay in the address bar');
    ok('scanning the pairing link pairs the phone with no typing');
    assert.equal(await localPhone.evaluate(() => window.isSecureContext), true);
    ok('the phone page is a secure context, so the camera is allowed');

    await until('phone listed on desktop', async () => (await page.textContent('#phones')).includes('Phone'));
    await until('pairing QR hidden after success', () => page.isHidden('#pairing'));
    ok('the desktop lists the phone and clears the pairing code');

    await verifyScanCycle(electronApp, page, localPhone, 'wifi-first', true);
    const first = await verifyScanCycle(electronApp, page, localPhone, 'wifi-second', false);
    const scanned = async () => page.$$eval('#scans .grow', (nodes) => nodes.map((node) => node.textContent));
    await until('every code in the feed arrives', async () => {
      const texts = await scanned();
      return ALL_CODES.every((code) => texts.includes(code));
    }, 70_000);
    ok(`consecutive scans of different codes all arrive (last checked: ${first})`);
    ok('two codes in view at once arrive as two separate scans');
    ok('a small, far-away code is read');
    ok('a washed-out projector code is read');

    const cameraWidth = await localPhone.$eval('video', (video) => video.videoWidth);
    assert.ok(cameraWidth > 0);

    await localPhone.reload();
    await until('phone stays paired after reload', async () => (await localPhone.textContent('.pill')).includes('Laptop connected'));
    ok('the phone stays paired after closing and reopening the page');

    await page.click('#phones button');
    await until('phone returned to the pairing screen', () => localPhone.isVisible('.pairing'));
    assert.match(await localPhone.textContent('.pairing'), /unpaired/);
    await localPhone.reload();
    await localPhone.waitForSelector('.pairing');
    ok('removing the phone on the desktop disconnects it for good');
    await localContext.close();

    // â”€â”€ Admin dashboard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    console.log('Admin dashboard');
    const adminContext = await browser.newContext({ viewport: { width: 900, height: 900 } });
    const admin = await adminContext.newPage();
    watchPhone(admin);
    await admin.goto(`${relayUrl}/admin`);
    await admin.fill('input[type=password]', 'wrong-password');
    await admin.click('button[type=submit]');
    await admin.waitForSelector('[role=alert]');
    assert.match(await admin.textContent('[role=alert]'), /Wrong password/);
    await admin.fill('input[type=password]', ADMIN_PASSWORD);
    await admin.click('button[type=submit]');
    await admin.waitForSelector('text=Create invite link');
    ok('the dashboard refuses a wrong password and opens with the right one');

    await admin.click('text=Create invite link');
    await admin.waitForSelector('#invite-link');
    const inviteLink = await admin.textContent('#invite-link');
    ok('the dashboard creates a laptop invite link');
    await admin.screenshot({ path: path.join(OUTPUT, 'admin-dashboard.png') });

    const joinContext = await browser.newContext({ viewport: { width: 900, height: 900 } });
    const joinPage = await joinContext.newPage();
    watchPhone(joinPage);
    await joinPage.goto(inviteLink);
    await joinPage.waitForSelector('text=Open in the app and join');
    assert.match(await joinPage.getAttribute('a.button:not(.secondary)', 'href'), /^qr2win:\/\/join\?url=/);
    await joinPage.screenshot({ path: path.join(OUTPUT, 'join-page.png') });
    await joinPage.goto(`${relayUrl}/join/not-a-real-invite-token-at-all`);
    await joinPage.waitForSelector("text=This invite isn't valid");
    await joinContext.close();
    ok('the invite page offers install and join, and rejects a fake invite');

    // â”€â”€ First laptop joins â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    console.log('Laptops');
    await page.fill('#serverUrl', 'http://relay.example.com');
    await page.click('#saveServer');
    await until('rejecting plain http', async () => (await page.textContent('#serverError')).includes('https'));
    ok('a plain-http internet relay is refused');

    await page.fill('#serverUrl', relayUrl);
    await page.click('#saveServer');
    await until('waiting for an invite', async () => (await page.textContent('#internetStatus')).includes('not joined'));
    ok('without an invite, a laptop cannot connect to the relay');

    await page.fill('#inviteLink', `${relayUrl}/join/forged-invite-token-that-means-nothing`);
    await page.click('#joinRelay');
    await until('fake invite refused', async () => (await page.textContent('#laptopError')).includes('invite'));
    ok('a fake invite link is refused');

    await page.fill('#inviteLink', inviteLink);
    await page.click('#joinRelay');
    await until('joined the relay', async () => (await page.textContent('#internetStatus')).includes('ready'));
    await until('first laptop on the dashboard', async () => (await admin.textContent('.laptops')).includes('Online'));
    ok('the invite link joins the laptop, and it shows as online on the dashboard');

    const secureFile = fs.readFileSync(path.join(userData, 'settings.json'), 'utf-8');
    const stored = JSON.parse(secureFile).internetCredential.encryptedToken;
    assert.ok(stored && !stored.includes('.'));
    ok('the relay credential is stored encrypted');

    // â”€â”€ Phones scan with no pairing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    console.log('Phones with no pairing');
    await page.click('#tabInternet');
    await page.click('#showPairing');
    await page.waitForSelector('#pairing:not([hidden])');
    assert.equal((await decodeDataUrl(await page.getAttribute('#pairingQr', 'src'))).text, relayUrl);
    assert.equal(await page.isVisible('#pairingCode'), false);
    ok('the app shows a plain QR of the link, with no code');

    const phoneOneContext = await browser.newContext(IPHONE_SIZED);
    await phoneOneContext.addInitScript(keepRescanning);
    await phoneOneContext.addInitScript(recordUploads);
    const internetPhone = await phoneOneContext.newPage();
    watchPhone(internetPhone);
    await internetPhone.goto(relayUrl);
    await until('phone connected with no pairing', async () => (await internetPhone.textContent('.pill').catch(() => '')).includes('Laptop connected'));
    assert.equal(await internetPhone.isVisible('.pairing'), false);
    assert.equal(await internetPhone.isVisible('text=Unpair'), false);
    ok('opening the link goes straight to the camera, with no pairing screen');

    await verifyScanCycle(electronApp, page, internetPhone, 'internet', true);

    // ── The scanner's own controls ──────────────────────────────
    console.log('Scanner controls');
    const controlsContext = await browser.newContext(IPHONE_SIZED);
    await controlsContext.addInitScript(recordUploads);
    await controlsContext.addInitScript(offerCameraControls);
    const controlsPhone = await controlsContext.newPage();
    watchPhone(controlsPhone);
    await controlsPhone.goto(relayUrl);
    await controlsPhone.waitForSelector('input[aria-label="Zoom"]');

    assert.equal(await controlsPhone.isVisible('text=Turn camera'), false, 'the camera button must be gone');
    const brightnessBar = await controlsPhone.locator('.camera-bar.left').boundingBox();
    const zoomBar = await controlsPhone.locator('.camera-bar.right').boundingBox();
    assert.ok(await controlsPhone.locator('.camera-bar.left input[aria-label="Brightness"]').count(), 'brightness must be the left bar');
    assert.ok(await controlsPhone.locator('.camera-bar.right input[aria-label="Zoom"]').count(), 'zoom must be the right bar');
    assert.ok(brightnessBar.x + brightnessBar.width <= 80, `brightness should hug the left edge, at ${brightnessBar.x}`);
    assert.ok(zoomBar.x >= IPHONE_SIZED.viewport.width - 80, `zoom should hug the right edge, at ${zoomBar.x}`);
    assert.ok(zoomBar.height > zoomBar.width * 2, 'the bars must stand upright');
    assert.equal(await controlsPhone.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'the page must not scroll sideways');
    ok('the camera button is gone, with brightness upright on the left and zoom on the right');

    const rescanButton = controlsPhone.locator('button.rescan');
    await until('a green tick appears on a scan', () => controlsPhone.locator('.scan-tick').isVisible(), 40_000);
    assert.equal(await controlsPhone.$eval('.scan-tick circle', (circle) => getComputedStyle(circle).fill), 'rgb(22, 163, 74)');
    assert.ok(await rescanButton.isEnabled(), 'Rescan must be available after a scan');
    await controlsPhone.screenshot({ path: path.join(OUTPUT, 'scanner-tick.png') });
    ok('a scan shows a green tick in the scanner, with Rescan below it');

    // The simulated camera's video keeps moving through different codes, so a scanner still running
    // would be sending them. Nothing going out for this long proves it has really stopped.
    const sent = () => controlsPhone.evaluate(() => window.uploads.filter((u) => u.type === 'qr-image').length);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const sentWhenFrozen = await sent();
    assert.equal(await controlsPhone.$eval('video', (video) => video.paused), true, 'the camera view must hold still');
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    assert.equal(await sent(), sentWhenFrozen, 'nothing may be sent until Rescan');
    assert.equal(await controlsPhone.locator('.scan-tick').count(), 1, 'the tick stays until Rescan');
    ok('after a scan the camera holds still, the tick stays, and nothing more is sent');

    await rescanButton.click();
    assert.equal(await controlsPhone.locator('.scan-tick').count(), 0, 'Rescan clears the tick');
    assert.equal(await rescanButton.isEnabled(), false, 'Rescan has nothing to do until the next scan');
    await until('the camera runs again', () => controlsPhone.$eval('video', (video) => !video.paused), 3000);
    await until('Rescan lets the next scan out', async () => (await sent()) > sentWhenFrozen, 30_000);
    ok('Rescan reopens the camera and the next code goes out');

    // A real two-finger pinch, sent as touch input to the browser rather than called in the page.
    const touch = await controlsContext.newCDPSession(controlsPhone);
    const pinchTo = async (type, spread) => touch.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x: 195 - spread, y: 300, id: 1 }, { x: 195 + spread, y: 300, id: 2 }],
    });
    const zoomValue = () => controlsPhone.$eval('input[aria-label="Zoom"]', (input) => Number(input.value));
    const zoomStart = await zoomValue();
    await pinchTo('touchStart', 40);
    for (const spread of [50, 60, 70, 80]) await pinchTo('touchMove', spread);
    await pinchTo('touchEnd', 0);
    await until('pinching out zooms in', async () => (await zoomValue()) > zoomStart * 1.8, 3000);
    await until('the camera follows the pinch', () => controlsPhone.evaluate((target) => window.cameraSettings.some((setting) => setting.zoom >= target), zoomStart * 1.8), 3000);
    assert.equal(await controlsPhone.evaluate(() => visualViewport.scale), 1, 'the page itself must not zoom');
    const zoomed = await zoomValue();
    await pinchTo('touchStart', 80);
    for (const spread of [70, 60, 50, 40]) await pinchTo('touchMove', spread);
    await pinchTo('touchEnd', 0);
    await until('pinching in zooms out', async () => (await zoomValue()) < zoomed / 1.8, 3000);
    ok(`two fingers zoom the camera both ways (${zoomStart.toFixed(1)}× to ${zoomed.toFixed(1)}× and back), and the bar follows`);
    await controlsPhone.screenshot({ path: path.join(OUTPUT, 'scanner-controls.png') });

    // Dragging a bar upward raises it, which confirms the rotated slider still works by touch.
    const zoomInput = await controlsPhone.locator('input[aria-label="Zoom"]').boundingBox();
    const dragBar = async (type, y) => touch.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x: zoomInput.x + zoomInput.width / 2, y, id: 1 }],
    });
    const beforeDrag = await zoomValue();
    await dragBar('touchStart', zoomInput.y + zoomInput.height * 0.8);
    for (const part of [0.6, 0.4, 0.2]) await dragBar('touchMove', zoomInput.y + zoomInput.height * part);
    await dragBar('touchEnd', 0);
    await until('dragging the bar up zooms in', async () => (await zoomValue()) > beforeDrag, 3000);
    ok('dragging the upright zoom bar upward zooms in');
    await controlsContext.close();

    await until('several scans sent', async () => (await internetPhone.evaluate(() => window.uploads.filter((u) => u.type === 'qr-image').length)) >= 3, 40_000);
    const uploads = await internetPhone.evaluate(() => window.uploads);
    const firstSends = uploads.filter((upload) => upload.type === 'qr-image');
    const updates = uploads.filter((upload) => upload.type === 'qr-enhanced');
    const kb = (bytes) => Math.round(bytes / 1024);
    const biggest = Math.max(...firstSends.map((upload) => upload.bytes));
    const slowest = Math.max(...firstSends.map((upload) => upload.waitedMs));
    assert.ok(firstSends.every((upload) => !upload.hasEnhanced), 'the first send must not wait for enhancement');
    assert.ok(biggest < 400 * 1024, `first upload should be small, was ${kb(biggest)} KB`);
    assert.ok(slowest < 150, `the scan should go out at once, waited ${slowest} ms`);
    assert.ok(updates.length > 0, 'clearer copies should follow');
    ok(`a scan leaves the phone within ${slowest} ms of detection, at ${kb(biggest)} KB or less; the clearer copy follows at ${kb(Math.max(...updates.map((u) => u.bytes)))} KB or less`);

    // â”€â”€ Several laptops and several phones â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    console.log('Several laptops and phones');
    const second = await launchDesktop(path.join(WORK, 'second-laptop-data'));
    await second.page.fill('#serverUrl', relayUrl);
    await second.page.click('#saveServer');
    await until('second laptop waiting', async () => (await second.page.textContent('#internetStatus')).includes('not joined'));
    await second.page.fill('#inviteLink', inviteLink);
    await second.page.click('#joinRelay');
    await until('second laptop joined', async () => (await second.page.textContent('#internetStatus')).includes('ready'));
    await until('two laptops on the dashboard', async () => (await admin.$$('.laptops li')).length === 2);
    ok('a second laptop joins with the same link');

    const phoneTwoContext = await browser.newContext(IPHONE_SIZED);
    await phoneTwoContext.addInitScript(keepRescanning);
    const phoneTwo = await phoneTwoContext.newPage();
    watchPhone(phoneTwo);
    await phoneTwo.goto(relayUrl);
    await until('second phone connected', async () => (await phoneTwo.textContent('.pill').catch(() => '')).includes('Laptop connected'));

    const secondBefore = await popupsOpened(second.electronApp);
    const firstBefore = await popupsOpened(electronApp);
    await until('both laptops receive scans', async () =>
      (await popupsOpened(second.electronApp)) > secondBefore && (await popupsOpened(electronApp)) > firstBefore, 30_000);
    const senders = await Promise.all([internetPhone, phoneTwo].map((phone) => phone.textContent('.scan-result strong')));
    assert.ok(senders.every((text) => text.includes('On your laptop')), `both phones must report delivery: ${senders}`);
    ok('scans from two phones reach both laptops');

    // Several codes get a popup each, side by side rather than on top of each other.
    await until('several popups open', () => popupWindows(electronApp).length >= 2, 30_000);
    const overlapping = await electronApp.evaluate(({ BrowserWindow }) => {
      const boxes = BrowserWindow.getAllWindows().filter((win) => win.getTitle() === 'QR code').map((win) => win.getBounds());
      return boxes.some((a, i) => boxes.some((b, j) => i < j && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height));
    });
    assert.equal(overlapping, false, 'popups must not cover each other');
    ok('each code gets its own popup, and none covers another');

    // Live view shows codes in one window as they arrive, with no popup for each.
    const liveOpening = electronApp.waitForEvent('window');
    await page.check('#liveView');
    const liveWindow = await liveOpening;
    await liveWindow.waitForLoadState('domcontentloaded');
    const liveAtStart = await liveWindow.$$eval('.tile', (tiles) => tiles.length);
    await new Promise((resolve) => setTimeout(resolve, 1000)); // lets a scan already on its way finish
    const liveBefore = await popupsOpened(electronApp);
    await until('live window shows codes', async () => {
      const texts = await liveWindow.$$eval('.tile .text', (nodes) => nodes.map((node) => node.textContent));
      return texts.includes(CODE_LEFT) && texts.includes(CODE_RIGHT);
    }, 70_000);
    await liveWindow.screenshot({ path: path.join(OUTPUT, 'live-view.png') });
    const liveTile = await decodeDataUrl(await liveWindow.$eval('.tile img', (img) => img.src));
    assert.ok(ALL_CODES.includes(liveTile.text), 'a live tile must show a readable code');
    assert.equal(await popupsOpened(electronApp), liveBefore, 'live view replaces popups');
    assert.equal(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.getTitle().startsWith('QR codes, live')).isAlwaysOnTop()), true);
    ok(`live view shows each code on its own as it arrives, on top, with no popups (started with ${liveAtStart} tiles)`);
    await page.uncheck('#liveView');
    await until('live window closed', async () => !electronApp.windows().includes(liveWindow) || liveWindow.isClosed());
    ok('turning live view off closes it and brings popups back');

    // Pausing stops scans, and resuming restarts them.
    await admin.click('text=Pause scanning');
    await until('phone told scanning is paused', async () => (await phoneTwo.textContent('.scan-result strong')).includes('paused'), 30_000);
    await admin.click('text=Resume scanning');
    ok('pausing in the dashboard stops phones from sending');

    // Removing a laptop cuts it off at once and for good.
    await admin.bringToFront();
    admin.once('dialog', (dialog) => dialog.accept());
    await admin.click('.laptops li:last-child button');
    await until('second laptop told it was removed', async () => (await second.page.textContent('#joinHint')).includes('removed'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(WORK, 'second-laptop-data', 'settings.json'), 'utf-8')).internetCredential, null);
    await until('one laptop left on the dashboard', async () => (await admin.$$('.laptops li')).length === 1);
    ok('removing a laptop on the dashboard cuts it off and clears its credential');

    await admin.click('text=Cancel link');
    await admin.waitForSelector('text=Create invite link');
    await second.page.fill('#inviteLink', inviteLink);
    await second.page.click('#joinRelay');
    await until('cancelled invite refused', async () => (await second.page.textContent('#laptopError')).includes('invite'));
    ok('a cancelled invite link no longer works');
    await second.electronApp.evaluate(({ app }) => app.quit());
    await second.electronApp.waitForEvent('close').catch(() => undefined);
    await phoneTwoContext.close();

    // â”€â”€ Laptop goes away and comes back â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    console.log('Reconnection');
    await electronApp.evaluate(({ app }) => app.quit());
    await electronApp.waitForEvent('close').catch(() => undefined);
    await until('phone notices laptop is gone', async () => (await internetPhone.textContent('.pill')).includes('Laptop offline'));
    ok('the app quits cleanly and the phone shows the laptop as offline');

    await until('a scan made offline is held', async () => (await internetPhone.textContent('.scan-result strong')).includes('Waiting for your laptop'), 20_000);
    await internetPhone.screenshot({ path: path.join(OUTPUT, 'phone-laptop-offline.png') });
    ok('a QR scanned while no laptop is online waits instead of being lost');

    ({ electronApp, page, problems } = await launchDesktop(userData));
    await until('reconnected to relay after restart', async () => (await page.textContent('#internetStatus')).includes('ready'));
    await until('phone sees laptop again', async () => (await internetPhone.textContent('.pill')).includes('Laptop connected'));
    await until('held scan delivered', async () => (await popupsOpened(electronApp)) > 0, 20_000);
    ok('after restarting, the desktop reconnects unattended and the held scan arrives');

    // â”€â”€ Free hosting: the relay restarts and its disk is gone â”€â”€â”€â”€â”€â”€â”€â”€â”€
    console.log('Free-tier restart');
    await adminContext.close();
    relay.kill();
    fs.rmSync(path.join(WORK, 'relay-data'), { recursive: true, force: true });
    await until('phone notices relay is gone', async () => (await internetPhone.textContent('.pill')).includes('Reconnecting'));
    const relayAgain = startRelay('relay-data-empty');
    try {
      await until('both reconnect after relay restart', async () =>
        (await internetPhone.textContent('.pill')).includes('Laptop connected') &&
        (await page.textContent('#internetStatus')).includes('ready'), 45_000);
      ok('after a relay restart with an empty disk, phone and laptop reconnect with no setup');
      const held = await popupsOpened(electronApp);
      await until('scans still flow after restart', async () => (await popupsOpened(electronApp)) > held, 30_000);
      ok('scans keep flowing after that restart');
    } finally {
      relayAgain.kill();
    }
    await phoneOneContext.close();

    assert.deepEqual(problems, [], 'the desktop window must log no errors');
    assert.deepEqual(phoneProblems, [], 'the phone page must log no errors');
    ok('no console errors or CSP violations on any page');
  } finally {
    await electronApp.evaluate(({ app }) => app.quit()).catch(() => undefined);
    await browser.close().catch(() => undefined);
    relay.kill();
  }

  console.log(`\nAll ${passed} checks passed. Screenshots: ${OUTPUT}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\nFAILED after ${passed} checks:`, err);
    process.exit(1);
  })
  .finally(() => fs.rmSync(WORK, { recursive: true, force: true }));
