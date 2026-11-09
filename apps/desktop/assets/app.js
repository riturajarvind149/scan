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
  'needs-invite': 'not joined',
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
    $('showPairing').textContent = 'Show pairing code';
    return;
  }
  $('showPairing').textContent = 'Show link for phones';
  $('showPairing').disabled = !internet.serverUrl;
  if (!internet.serverUrl) {
    $('pairHint').textContent = 'Set your internet relay address under Settings first.';
  } else if (internet.unreachableByPhones) {
    $('pairHint').textContent = `${internet.serverUrl} only exists on this PC, so a phone can't reach it. Use a deployed relay.`;
  } else {
    $('pairHint').textContent = 'Any phone can open this link and scan, with no pairing. Every laptop on the relay receives the scans.';
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
  const phones = state.local.phones;
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
        await api.unpairPhone(phone.id);
      } catch (err) {
        remove.disabled = false;
        show('pairError', cleanError(err));
      }
    });
    row.append(dot, element('span', phone.name, 'grow'), remove);
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
  renderJoin();
  renderStatus('localStatus', 'Wi-Fi', state.local);
  renderStatus('internetStatus', 'Internet', state.internet);
  renderPairHint();
  renderAddresses();
  renderPhones();
  renderScans();
  $('liveView').checked = state.liveView;
  $('localEnabled').checked = state.local.enabled;
  $('startWithWindows').checked = state.startWithWindows;
  $('autoStartRow').hidden = !state.canAutoStart;
  if (document.activeElement !== $('serverUrl')) $('serverUrl').value = state.internet.serverUrl;
  const serverProblem = state.internet.status === 'connecting' && state.internet.serverUrl;
  show('serverError', serverProblem ? state.internet.error : '');
}

function renderJoin() {
  const { status, error, serverUrl } = state.internet;
  const joined = status === 'connected' || status === 'connecting';
  $('joinRow').hidden = joined;
  $('openAdmin').hidden = !serverUrl;
  if (error && status === 'needs-invite') $('joinHint').textContent = error;
  else if (joined) $('joinHint').textContent = 'This laptop receives every scan sent to your relay. Add or remove laptops in the admin dashboard.';
  else $('joinHint').textContent = 'To receive scans, paste an invite link from your admin dashboard.';
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
    const isLocal = mode === 'local';
    const pairing = isLocal ? await api.createPairing($('address').value || undefined) : await api.phoneLinkQr();
    $('pairingQr').src = pairing.qrDataUrl;
    $('pairingCode').textContent = isLocal ? pairing.code : '';
    $('pairingCode').hidden = !isLocal;
    $('pairingExpiry').hidden = !isLocal;
    $('pairingLead').textContent = isLocal ? "Scan with your phone's camera, or open" : "Scan with any phone's camera, or open";
    $('pairingTrail').textContent = isLocal ? 'and type the code.' : '';
    $('pairingUrl').textContent = new URL(pairing.url).origin;
    $('certHint').hidden = !isLocal;
    $('pairing').hidden = false;
    if (isLocal) startCountdown(pairing.expiresAt);
    else clearInterval(expiryTimer);
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
$('liveView').addEventListener('change', (event) => api.setLiveView(event.target.checked));
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

$('joinRelay').addEventListener('click', async () => {
  show('laptopError', '');
  show('laptopSuccess', '');
  try {
    await api.joinWithInvite($('inviteLink').value);
    $('inviteLink').value = '';
    show('laptopSuccess', 'Joined. This laptop now receives scans.');
  } catch (err) {
    show('laptopError', cleanError(err));
  }
});

$('openAdmin').addEventListener('click', () => api.openAdmin());

api.onState(render);
api.onPhonePaired((phone) => {
  hidePairing();
  show('pairError', '');
  show('pairSuccess', `${phone.name} is paired. Scans will now appear on this PC.`);
});
api.getState().then(render);
