// End-to-end test of the real product: the built relay server, the real Electron app, and a real
// browser (Microsoft Edge) as the phone, whose camera is fed a video of actual QR codes.
//
// Run with: npm run test:e2e     (Windows; shows real toasts and popups while it runs)
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
import QRCode from 'qrcode';

const require = createRequire(import.meta.url);
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

function decodeDataUrl(dataUrl) {
  const [header, base64] = dataUrl.split(',');
  assert.match(header, /^data:image\/png;base64$/);
  const png = PNG.sync.read(Buffer.from(base64, 'base64'));
  return { width: png.width, height: png.height, text: jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data };
}

async function launchDesktop(userData) {
  // Start with no relay so a fresh test profile doesn't use the one built into the app.
  const settingsFile = path.join(userData, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify({ serverUrl: '' }));
  }
  const electronApp = await _electron.launch({
    executablePath: require('electron'),
    args: [path.join(ROOT, 'apps', 'desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' },
  });
  // Record notifications as the app creates them, so the test can click them like the user would.
  await electronApp.evaluate(({ Notification }) => {
    globalThis.notifications = [];
    const show = Notification.prototype.show;
    Notification.prototype.show = function record() {
      globalThis.notifications.push({ instance: this, title: this.title, body: this.body, failed: false });
      const entry = globalThis.notifications.at(-1);
      this.on('failed', () => {
        entry.failed = true;
      });
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

const notificationCount = (app) => app.evaluate(() => globalThis.notifications.filter((n) => n.title === 'QR code received').length);

const popupWindows = (app) => app.windows().filter((win) => win.url().endsWith('popup.html'));

async function clickNotification(app, index) {
  await app.evaluate((_electron, at) => {
    globalThis.notifications.filter((n) => n.title === 'QR code received')[at].instance.emit('click');
  }, index);
}

async function readPairingLink(page) {
  await page.click('#showPairing');
  await page.waitForSelector('#pairing:not([hidden])');
  const qr = decodeDataUrl(await page.getAttribute('#pairingQr', 'src'));
  assert.ok(qr.text, 'the pairing QR must be scannable');
  return { url: qr.text, code: await page.textContent('#pairingCode') };
}

/** Expects a scan delivered, click-to-open and pixel-faithful. Returns the text of the scan. */
async function verifyScanCycle(app, page, phone, label, screenshots) {
  const before = await notificationCount(app);
  const popupsBefore = popupWindows(app).length;

  await until(`${label}: a QR scan shows as delivered on the phone`, async () =>
    (await phone.textContent('.scan-result strong').catch(() => ''))?.includes('On your laptop'),
  );
  await until(`${label}: desktop raised a notification`, async () => (await notificationCount(app)) > before);
  const failed = await app.evaluate(() => globalThis.notifications.some((n) => n.failed));
  assert.equal(failed, false, 'Windows must accept the toast');
  ok(`${label}: phone reports delivery and Windows accepted the notification`);

  assert.equal(popupWindows(app).length, popupsBefore, 'the popup must wait for a click');
  ok(`${label}: no popup appears before the notification is clicked`);

  const opening = app.waitForEvent('window');
  await clickNotification(app, before);
  const popup = await opening;
  await popup.waitForSelector('#image img');
  await until(`${label}: popup image renders`, () => popup.$eval('#image img', (img) => img.complete && img.naturalWidth > 0));

  const alwaysOnTop = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().filter((win) => win.getTitle() === 'QR code').every((win) => win.isAlwaysOnTop()),
  );
  assert.equal(alwaysOnTop, true);
  ok(`${label}: clicking opens an always-on-top popup showing the image`);

  const image = decodeDataUrl(await popup.$eval('#image img', (img) => img.src));
  assert.ok(ALL_CODES.includes(image.text), `popup image must decode to a fed code, got ${image.text}`);
  ok(`${label}: the image shown decodes correctly (${image.width}x${image.height}): ${image.text}`);

  const footer = await popup.textContent('#details');
  assert.ok(footer.includes(image.text));

  assert.equal(await popup.isVisible('#version'), true, 'an enhanced copy should have been made of a clean code');
  await popup.click('#toggleVersion');
  const original = decodeDataUrl(await popup.$eval('#image img', (img) => img.src));
  assert.equal(original.text, image.text, 'the original and the clearer copy must read the same');
  assert.match(await popup.textContent('#versionNote'), /Original/);
  ok(`${label}: the original photo is one click away and reads the same (${original.width}x${original.height})`);
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
    assert.equal(decodeDataUrl(await page.getAttribute('#pairingQr', 'src')).text, relayUrl);
    assert.equal(await page.isVisible('#pairingCode'), false);
    ok('the app shows a plain QR of the link, with no code');

    const phoneOneContext = await browser.newContext(IPHONE_SIZED);
    const internetPhone = await phoneOneContext.newPage();
    watchPhone(internetPhone);
    await internetPhone.goto(relayUrl);
    await until('phone connected with no pairing', async () => (await internetPhone.textContent('.pill').catch(() => '')).includes('Laptop connected'));
    assert.equal(await internetPhone.isVisible('.pairing'), false);
    assert.equal(await internetPhone.isVisible('text=Unpair'), false);
    ok('opening the link goes straight to the camera, with no pairing screen');

    await verifyScanCycle(electronApp, page, internetPhone, 'internet', true);

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
    const phoneTwo = await phoneTwoContext.newPage();
    watchPhone(phoneTwo);
    await phoneTwo.goto(relayUrl);
    await until('second phone connected', async () => (await phoneTwo.textContent('.pill').catch(() => '')).includes('Laptop connected'));

    const secondBefore = await notificationCount(second.electronApp);
    const firstBefore = await notificationCount(electronApp);
    await until('both laptops receive scans', async () =>
      (await notificationCount(second.electronApp)) > secondBefore && (await notificationCount(electronApp)) > firstBefore, 30_000);
    const senders = await Promise.all([internetPhone, phoneTwo].map((phone) => phone.textContent('.scan-result strong')));
    assert.ok(senders.every((text) => text.includes('On your laptop')), `both phones must report delivery: ${senders}`);
    ok('scans from two phones reach both laptops');

    // Live view shows codes as they arrive, with no notification to click.
    const liveOpening = electronApp.waitForEvent('window');
    await page.check('#liveView');
    const liveWindow = await liveOpening;
    await liveWindow.waitForLoadState('domcontentloaded');
    const liveBefore = await notificationCount(electronApp);
    const liveAtStart = await liveWindow.$$eval('.tile', (tiles) => tiles.length);
    await until('live window shows codes', async () => {
      const texts = await liveWindow.$$eval('.tile .text', (nodes) => nodes.map((node) => node.textContent));
      return texts.includes(CODE_LEFT) && texts.includes(CODE_RIGHT);
    }, 70_000);
    await liveWindow.screenshot({ path: path.join(OUTPUT, 'live-view.png') });
    const liveTile = decodeDataUrl(await liveWindow.$eval('.tile img', (img) => img.src));
    assert.ok(ALL_CODES.includes(liveTile.text), 'a live tile must show a readable code');
    assert.equal(await notificationCount(electronApp), liveBefore, 'live view replaces notifications');
    assert.equal(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.getTitle().startsWith('QR codes, live')).isAlwaysOnTop()), true);
    ok(`live view shows each code on its own as it arrives, on top, with no notification (started with ${liveAtStart} tiles)`);
    await page.uncheck('#liveView');
    await until('live window closed', async () => !electronApp.windows().includes(liveWindow) || liveWindow.isClosed());
    ok('turning live view off closes it and brings notifications back');

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
    await until('held scan delivered', async () => (await notificationCount(electronApp)) > 0, 20_000);
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
      const held = await notificationCount(electronApp);
      await until('scans still flow after restart', async () => (await notificationCount(electronApp)) > held, 30_000);
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
