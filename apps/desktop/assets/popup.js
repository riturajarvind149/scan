'use strict';

document.getElementById('close').addEventListener('click', () => window.popup.close());

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.popup.close();
});

window.popup.getScan().then((scan) => {
  if (!scan) {
    document.getElementById('details').textContent = 'This scan is no longer available.';
    return;
  }

  const image = document.createElement('img');
  image.alt = 'Scanned QR code';
  image.src = `data:${scan.mimeType};base64,${scan.imageBase64}`;
  document.getElementById('image').appendChild(image);

  // Scanned content is untrusted: it is shown as plain text and never turned into a link.
  const details = document.getElementById('details');
  const time = new Date(scan.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  details.textContent = scan.decodedText ? `${time} · ${scan.decodedText}` : time;
  details.title = scan.decodedText;
});
