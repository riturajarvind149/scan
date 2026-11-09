// Windows check of the one step the main end-to-end test can only simulate: a real toast being clicked.
// Tests the packaged app in release/win-unpacked; build it first with: npm run package:desktop
//
//   node e2e/real-toast.mjs           Calls the app's toast activator exactly as Windows does on a click.
//   node e2e/real-toast.mjs --mouse   Physically clicks the toast. It moves the mouse, so leave the PC
//                                     alone while it runs. Needs Do Not Disturb off and the toast in its
//                                     usual bottom-right position.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright-core';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUTPUT = path.join(ROOT, 'e2e', 'output');
const USE_MOUSE = process.argv.includes('--mouse');
const SCAN_ID = 'real-toast-test';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'qr2win-toast-'));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CLICK_WITH_MOUSE = String.raw`
Add-Type @'
using System; using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e);
}
'@
[void][Win32]::SetProcessDPIAware()
Add-Type -AssemblyName System.Windows.Forms
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
[void][Win32]::SetCursorPos($b.Width - 320, $b.Height - 65)
Start-Sleep -Milliseconds 200
[Win32]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero)
[Win32]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero)
`;

const CALL_ACTIVATOR = String.raw`
Add-Type @'
using System; using System.Runtime.InteropServices;
[ComImport, Guid("53E31837-6600-4A81-9395-75CFFE746F94"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface INotificationActivationCallback {
  void Activate([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, [MarshalAs(UnmanagedType.LPWStr)] string invokedArgs, IntPtr data, uint count);
}
public static class Toast {
  public static void Activate(string clsid, string aumid, string args) {
    var callback = (INotificationActivationCallback)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid(clsid)));
    callback.Activate(aumid, args, IntPtr.Zero, 0);
  }
}
'@
[Toast]::Activate('7E0C6A52-3B1F-4D8E-9A61-2F4C8B7D1E93', 'com.qr2win.desktop', $env:TOAST_ARGS)
`;

function post(url, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', rejectUnauthorized: false, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

fs.mkdirSync(OUTPUT, { recursive: true });
const executable = path.join(ROOT, 'apps', 'desktop', 'release', 'win-unpacked', 'QR-to-Windows-11.exe');
// The packaged app maintains this shortcut. Remove it afterwards unless the app was already installed.
const shortcut = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'QR-to-Windows-11.lnk');
const installed = fs.existsSync(shortcut);
const app = await _electron.launch({ executablePath: executable, args: [`--user-data-dir=${work}`] });
let exitCode = 1;
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => document.getElementById('localStatus').textContent.includes('ready'));
  await page.click('#tabLocal');
  await page.click('#showPairing');
  await page.waitForSelector('#pairing:not([hidden])');
  const code = await page.textContent('#pairingCode');
  const origin = await page.textContent('#pairingUrl');

  const { token } = await post(`${origin}/api/pairing/pair`, { code, deviceName: 'Toast test' });
  // Hide the main window and let the "new phone paired" toast clear, leaving Windows time to index the shortcut.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((win) => win.hide()));
  await sleep(9000);

  const ws = new WebSocket(`${origin.replace('https', 'wss')}/ws`, { rejectUnauthorized: false });
  await new Promise((resolve) => ws.once('open', resolve));
  ws.send(JSON.stringify({ type: 'auth', token }));
  await sleep(300);
  ws.send(JSON.stringify({
    type: 'qr-image', scanId: SCAN_ID, timestamp: Date.now(), mimeType: 'image/png',
    width: 1, height: 1, imageBase64: PNG, decodedText: 'https://example.com/real-toast',
  }));
  await sleep(1500);

  const popupsBefore = app.windows().filter((win) => win.url().endsWith('popup.html')).length;
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', USE_MOUSE ? CLICK_WITH_MOUSE : CALL_ACTIVATOR], {
    env: { ...process.env, TOAST_ARGS: '' },
    stdio: 'inherit',
  });
  await sleep(2500);

  const popups = app.windows().filter((win) => win.url().endsWith('popup.html'));
  console.log(`Popups before the click: ${popupsBefore}; after: ${popups.length}`);
  if (popupsBefore === 0 && popups.length === 1) {
    console.log(USE_MOUSE ? 'PASS: physically clicking the real toast opened the popup.' : 'PASS: the Windows toast activator opened the popup.');
    exitCode = 0;
  } else {
    console.log('FAILED: the popup did not open.');
  }
  ws.close();
} finally {
  await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
  await sleep(1000);
  if (!installed) fs.rmSync(shortcut, { force: true });
  fs.rmSync(work, { recursive: true, force: true });
}
process.exit(exitCode);
