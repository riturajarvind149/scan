'use strict';

const MAX_TILES = 6;
const tiles = document.getElementById('tiles');
const empty = document.getElementById('empty');

/** Newest first. A code seen again replaces its old tile, so each distinct code appears once. */
let scans = [];

function buildTile(scan) {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'tile';
  tile.title = 'Open on its own';
  tile.addEventListener('click', () => window.live.openScan(scan.scanId));

  const image = document.createElement('img');
  const shown = scan.enhanced ?? scan;
  image.src = `data:${shown.mimeType};base64,${shown.imageBase64}`;
  image.alt = 'Scanned QR code';

  // Scanned content is untrusted: shown as plain text and never turned into a link.
  const text = document.createElement('span');
  text.className = 'text';
  text.textContent = scan.decodedText;

  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = new Date(scan.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });

  tile.append(image, text, time);
  return tile;
}

function render() {
  empty.hidden = scans.length > 0;
  tiles.dataset.count = String(scans.length);
  tiles.replaceChildren(...scans.map(buildTile));
}

function add(scan) {
  scans = [scan, ...scans.filter((item) => item.decodedText !== scan.decodedText)].slice(0, MAX_TILES);
  render();
}

window.live.onScan(add);
window.live.getScans().then((existing) => {
  for (const scan of [...existing].reverse()) add(scan);
  render();
});
