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
  document.getElementById('image').appendChild(image);

  const original = `data:${scan.mimeType};base64,${scan.imageBase64}`;
  image.src = original;

  // The clearer copy is only ever sent if it reads exactly the same as the original.
  const showClearerOption = (enhanced) => {
    const clearer = `data:${enhanced.mimeType};base64,${enhanced.imageBase64}`;
    const version = document.getElementById('version');
    const note = document.getElementById('versionNote');
    const toggle = document.getElementById('toggleVersion');
    let showingClearer = true;
    const render = () => {
      image.src = showingClearer ? clearer : original;
      note.textContent = showingClearer ? 'Clearer copy, checked to read the same' : 'Original photo';
      note.title = showingClearer ? enhanced.method : '';
      toggle.textContent = showingClearer ? 'Show original' : 'Show clearer';
    };
    toggle.addEventListener('click', () => {
      showingClearer = !showingClearer;
      render();
    });
    version.hidden = false;
    render();
  };
  if (scan.enhanced) showClearerOption(scan.enhanced);
  // It often arrives just after this window opens.
  else window.popup.onEnhanced((updated) => showClearerOption(updated.enhanced));

  // Scanned content is untrusted: it is shown as plain text and never turned into a link.
  const details = document.getElementById('details');
  const time = new Date(scan.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  details.textContent = scan.decodedText ? `${time} · ${scan.decodedText}` : time;
  details.title = scan.decodedText;
});
