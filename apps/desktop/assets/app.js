'use strict';

const api = window.app;
const $ = (id) => document.getElementById(id);

let state = null;
let mode = 'local';
let expiryTimer = null;
let firstRender = true;

const STATUS_TEXT = {
  off: 'off',
  connecting: 'connecting…',
  connected: 'ready',
  error: 'problem',
};

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text; // always text: names and scans are untrusted
  if (className) node.className = className;
  return node;
}

function show(id, message) {
  const node = $(id);
  node.hidden = !message;
  node.textContent = message || '';
}

function renderStatus(id, label, channel) {
  const root = $(id);
  root.querySelector('.dot').className = `dot ${channel.status}`;
  root.querySelector('span:last-child').textContent = `${label}: ${STATUS_TEXT[channel.status]}`;
  root.title = channel.error || '';
}

function renderPairHint() {
  const { internet, local } = state;
  if (mode === 'local') {
    $('pairHint').textContent = local.error
      ? `The Wi-Fi server couldn't start: ${local.error}`
      : 'Your phone and this PC must be on the same Wi-Fi. No internet or account needed.';
    $('showPairing').disabled = false;
    return;
  }
  if (!internet.serverUrl) {
    $('pairHint').textContent = 'Set your internet relay address under Settings first.';
    $('showPairing').disabled = true;
  } else if (internet.unreachableByPhones) {
    $('pairHint').textContent = `${internet.serverUrl} only exists on this PC, so a phone can't reach it. Use a deployed relay.`;
    $('showPairing').disabled = false;
  } else {
    $('pairHint').textContent = `Uses your relay at ${internet.serverUrl}.`;
    $('showPairing').disabled = false;
  }
}

function renderAddresses() {
  const addresses = state.local.addresses;
  const showRow = mode === 'local' && addresses.length > 1;
  $('addressRow').hidden = !showRow;
  const select = $('address');
  const current = select.value;
  select.replaceChildren(...addresses.map((address) => {
    const option = element('option', address);
    option.value = address;
    return option;
  }));
  if (addresses.includes(current)) select.value = current;
}

function renderPhones() {
  const phones = [
    ...state.local.phones.map((phone) => ({ ...phone, mode: 'local', via: 'Wi-Fi' })),
    ...state.internet.phones.map((phone) => ({ ...phone, mode: 'internet', via: 'Internet' })),
  ];
  $('noPhones').hidden = phones.length > 0;
  $('phones').replaceChildren(...phones.map((phone) => {
    const row = element('li');
    const dot = element('span', undefined, `dot ${phone.online ? 'connected' : ''}`);
    dot.title = phone.online ? 'Online' : 'Offline';
    const remove = element('button', 'Remove');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${phone.name}`);
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        await api.unpairPhone(phone.mode, phone.id);
      } catch (err) {
        remove.disabled = false;
        show('pairError', cleanError(err));
      }
    });
    row.append(dot, element('span', phone.name, 'grow'), element('span', phone.via, 'meta'), remove);
    return row;
  }));
}

function renderScans() {
  $('noScans').hidden = state.scans.length > 0;
  $('scans').replaceChildren(...state.scans.map((scan) => {
    const row = element('li');
    const time = new Date(scan.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const text = element('span', scan.decodedText || 'QR code', 'grow');
    text.title = scan.decodedText;
    const open = element('button', 'Show');
    open.type = 'button';
    open.addEventListener('click', () => api.openScan(scan.scanId));
    row.append(element('span', time, 'meta'), text, open);
    return row;
  }));
}

function render(next) {
  state = next;
  // Once a relay is set, it is what daily use goes through.
  if (firstRender && state.internet.serverUrl) selectTab('internet');
  firstRender = false;
  $('laptopsSection').hidden = !state.internet.serverUrl;
  renderStatus('localStatus', 'Wi-Fi', state.local);
  renderStatus('internetStatus', 'Internet', state.internet);
  renderPairHint();
  renderAddresses();
  renderPhones();
  renderScans();
  $('localEnabled').checked = state.local.enabled;
  $('startWithWindows').checked = state.startWithWindows;
  $('autoStartRow').hidden = !state.canAutoStart;
  if (document.activeElement !== $('serverUrl')) $('serverUrl').value = state.internet.serverUrl;
  show('serverError', state.internet.status !== 'connected' && state.internet.serverUrl ? state.internet.error : '');
}

function cleanError(err) {
  return String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function hidePairing() {
  clearInterval(expiryTimer);
  $('pairing').hidden = true;
}

function selectTab(next) {
  mode = next;
  $('tabLocal').setAttribute('aria-selected', String(mode === 'local'));
  $('tabInternet').setAttribute('aria-selected', String(mode === 'internet'));
  hidePairing();
  show('pairError', '');
  show('pairSuccess', '');
  renderPairHint();
  renderAddresses();
}

function startCountdown(expiresAt) {
  const tick = () => {
    const seconds = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    if (seconds === 0) {
      hidePairing();
      show('pairError', 'That code expired. Show a new one when you are ready.');
      return;
    }
    $('pairingExpiry').textContent = `Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };
  clearInterval(expiryTimer);
  expiryTimer = setInterval(tick, 1000);
  tick();
}

async function showPairing() {
  const button = $('showPairing');
  button.disabled = true;
  show('pairError', '');
  show('pairSuccess', '');
  try {
    const pairing = await api.createPairing(mode, $('address').value || undefined);
    $('pairingQr').src = pairing.qrDataUrl;
    $('pairingCode').textContent = pairing.code;
    $('pairingUrl').textContent = new URL(pairing.url).origin;
    $('certHint').hidden = mode !== 'local';
    $('pairing').hidden = false;
    startCountdown(pairing.expiresAt);
  } catch (err) {
    hidePairing();
    show('pairError', cleanError(err));
  } finally {
    renderPairHint();
  }
}

$('tabLocal').addEventListener('click', () => selectTab('local'));
$('tabInternet').addEventListener('click', () => selectTab('internet'));
$('showPairing').addEventListener('click', showPairing);
$('address').addEventListener('change', () => {
  if (!$('pairing').hidden) showPairing();
});
$('localEnabled').addEventListener('change', (event) => api.setLocalEnabled(event.target.checked));
$('startWithWindows').addEventListener('change', (event) => api.setStartWithWindows(event.target.checked));

$('saveServer').addEventListener('click', async () => {
  show('serverError', '');
  try {
    $('serverUrl').value = await api.setServerUrl($('serverUrl').value);
    selectTab(mode);
  } catch (err) {
    show('serverError', cleanError(err));
  }
});

$('showLaptopCode').addEventListener('click', async () => {
  show('laptopError', '');
  show('laptopSuccess', '');
  try {
    const { code } = await api.createLaptopCode();
    $('laptopCode').textContent = code;
    $('laptopCodeBox').hidden = false;
  } catch (err) {
    show('laptopError', cleanError(err));
  }
});

$('joinAccount').addEventListener('click', async () => {
  show('laptopError', '');
  show('laptopSuccess', '');
  try {
    await api.joinAccount($('joinCode').value);
    $('joinCode').value = '';
    show('laptopSuccess', 'Joined. This laptop now receives your scans.');
  } catch (err) {
    show('laptopError', cleanError(err));
  }
});

api.onState(render);
api.onPhonePaired((phone) => {
  hidePairing();
  show('pairError', '');
  show('pairSuccess', `${phone.name} is paired. Scans will now appear on this PC.`);
});
api.getState().then(render);
