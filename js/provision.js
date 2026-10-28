document.getElementById('current-year').textContent = new Date().getFullYear();

const $ = (id) => document.getElementById(id);
const form = $('form');
const serverUrlInput = $('serverUrl');
const nonceInput = $('nonceInput');
const connectBtn = $('connectBtn');

function showView(id) {
    for (const view of ['form', 'waiting', 'done']) $(view).hidden = view !== id;
}

function setBusy(busy) {
    connectBtn.disabled = busy;
    serverUrlInput.disabled = busy;
    nonceInput.disabled = busy;
    $('connectLabel').textContent = busy ? 'Conectando…' : 'Conectar';
}

function showError(message) {
    form.classList.toggle('form-error', Boolean(message));
    $('alert').hidden = !message;
    $('alert-text').textContent = message || '';
}

window.electron.onDeviceId((deviceId) => {
    $('deviceId').textContent = deviceId;
});

window.electron.on('provision-status', ({ type, message, clearNonce }) => {
    if (type === 'success') return showView('waiting');
    if (type === 'linked') return showView('done');
    // An error may come after the waiting view: the form must come back.
    showView('form');
    setBusy(false);
    if (clearNonce) nonceInput.value = '';
    showError(message);
});

form.addEventListener('submit', (event) => {
    event.preventDefault();
    const url = serverUrlInput.value.trim();
    const nonce = nonceInput.value.trim();

    try {
        if (!/^https?:$/.test(new URL(url).protocol)) throw new Error();
    } catch {
        showError('La dirección del servidor no es válida.');
        return serverUrlInput.focus();
    }
    if (!nonce) {
        showError('Falta el código de configuración del panel.');
        return nonceInput.focus();
    }

    showError('');
    setBusy(true);
    window.electron.send('set-server-url', { url, nonce });
});

$('btn-minimize').addEventListener('click', () => window.electron.minimizeWindow());
$('btn-close').addEventListener('click', () => window.electron.closeWindow());

serverUrlInput.focus();
