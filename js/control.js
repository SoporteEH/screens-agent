document.getElementById('current-year').textContent = new Date().getFullYear();

const $ = (id) => document.getElementById(id);

const CONNECTION = {
    online: { text: 'Online', tone: 'ok' },
    connecting: { text: 'Offline', tone: 'error', retry: true },
    offline: { text: 'Offline', tone: 'error', retry: true },
    'no-internet': { text: 'Offline', tone: 'error' },
};

function contentLabel(screen) {
    if (screen.contentName) return screen.contentName;
    const url = screen.url || '';
    if (!url) return 'Sin contenido';
    if (url.startsWith('playlist:')) return 'Playlist';
    if (url.startsWith('local:')) return 'Archivo local';
    if (url.startsWith('file:')) return 'Carrusel sin conexión';
    try {
        return new URL(url).hostname || url;
    } catch {
        return url;
    }
}

// Decorative only: varied bars tell the thumbnails apart.
const THUMB_BAR_WIDTHS = [60, 45, 70, 35];

const CHANGE_ERRORS = {
    offline: 'Sin conexión con el servidor.',
    timeout: 'El servidor no ha respondido.',
    screenPinned: 'Un administrador ha fijado el contenido de esta pantalla.',
    singleScreenBusy: 'Ese contenido ya se muestra en otra pantalla de este salón.',
    accountSuspended: 'La cuenta del salón está desactivada.',
    contentNotAllowed: 'Ese contenido ya no está disponible para este salón.',
    throttled: 'Demasiados cambios seguidos. Espera un momento.',
};

const view = {
    screens: [],
    catalogue: [],
    online: false,
    pending: new Set(),
    errors: {},
    openPicker: null,
};
let renderedKey = '';

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function setOpenPicker(screenId) {
    view.openPicker = screenId;
    renderScreens();
}

// Custom instead of <select>: the native popup can't be styled on Windows.
function contentPicker(screen) {
    const picker = el('div', 'picker');
    const current = view.catalogue.find((c) => c.url === screen.url);
    const open = view.openPicker === screen.id;

    const button = el('button', 'picker-button');
    button.type = 'button';
    button.dataset.picker = screen.id;
    button.disabled = view.pending.has(screen.id);
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', `Contenido de la pantalla ${screen.id}`);
    button.append(
        el('span', 'picker-value', current?.name || contentLabel(screen)),
        el('span', 'material-icons', 'expand_more')
    );
    button.addEventListener('click', () => setOpenPicker(open ? null : screen.id));
    picker.append(button);

    if (open) {
        const list = el('div', 'picker-list');
        list.setAttribute('role', 'listbox');
        for (const content of view.catalogue) {
            const option = el('button', 'picker-option', content.name);
            option.type = 'button';
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', String(content === current));
            option.addEventListener('click', () => {
                view.openPicker = null;
                if (content === current) renderScreens();
                else changeContent(screen.id, content.id);
            });
            list.append(option);
        }
        picker.append(list);
    }
    return picker;
}

// Opens upwards when the list would run past the bottom of the window.
function placeOpenList() {
    const list = document.querySelector('.picker-list');
    if (!list) return;
    const bounds = list.closest('.content').getBoundingClientRect();
    const rect = list.getBoundingClientRect();
    const above = list.parentElement.getBoundingClientRect().top - bounds.top;
    if (rect.bottom > bounds.bottom && above > bounds.bottom - rect.top) list.classList.add('up');
    (list.querySelector('[aria-selected="true"]') || list.firstElementChild)?.focus();
}

document.addEventListener('click', (event) => {
    if (view.openPicker && !event.target.closest('.picker')) setOpenPicker(null);
});

document.addEventListener('keydown', (event) => {
    if (!view.openPicker) return;
    if (event.key === 'Escape') {
        const screenId = view.openPicker;
        setOpenPicker(null);
        document.querySelector(`[data-picker="${screenId}"]`)?.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const options = [...document.querySelectorAll('.picker-option')];
        const index = options.indexOf(document.activeElement);
        const step = event.key === 'ArrowDown' ? 1 : -1;
        options[(index + step + options.length) % options.length]?.focus();
    }
});

function screenRow(screen) {
    const row = el('div', 'screen');

    const thumb = el('span', 'screen-thumb');
    thumb.setAttribute('aria-hidden', 'true');
    const bar = el('span', 'screen-thumb-bar');
    bar.style.width = `${THUMB_BAR_WIDTHS[(Number(screen.id) - 1) % THUMB_BAR_WIDTHS.length] || 50}%`;
    thumb.append(bar);

    const text = el('div', 'screen-text');
    const name = el('span', 'screen-name', `Pantalla ${screen.id}`);
    name.append(' ', el('span', 'mono screen-resolution', screen.resolution));
    text.append(name);

    // Changing content needs the server: offline the screen just says what it shows.
    if (view.online && view.catalogue.length > 0) {
        text.append(contentPicker(screen));
    } else {
        const content = el('span', 'screen-content', contentLabel(screen));
        content.title = screen.url || '';
        text.append(content);
    }
    if (view.errors[screen.id]) text.append(el('span', 'screen-error', view.errors[screen.id]));

    const identify = el('button', 'btn-small', 'Identificar');
    identify.title = 'Muestra el número en esta pantalla';
    identify.addEventListener('click', () => window.electron.identifyScreen(screen.id));

    row.append(thumb, text, identify);
    return row;
}

// Rebuilt only when something changed: the 3 s poll would otherwise close an open dropdown.
function renderScreens() {
    const key = JSON.stringify([
        view.screens,
        view.catalogue,
        view.online,
        [...view.pending],
        view.errors,
        view.openPicker,
    ]);
    if (key === renderedKey) return;
    renderedKey = key;
    $('screen-count').textContent = view.screens.length;
    $('screen-list').replaceChildren(...view.screens.map(screenRow));
    placeOpenList();
}

async function changeContent(screenId, contentId) {
    if (!contentId) return;
    view.pending.add(screenId);
    delete view.errors[screenId];
    renderScreens();
    const result = await window.electron.showContent(screenId, contentId).catch(() => null);
    view.pending.delete(screenId);
    if (!result?.ok) {
        view.errors[screenId] =
            CHANGE_ERRORS[result?.error] || 'No se ha podido cambiar el contenido.';
        setTimeout(() => {
            delete view.errors[screenId];
            renderScreens();
        }, 8000);
    }
    renderScreens();
}

async function loadCatalogue() {
    const result = await window.electron.getCatalogue().catch(() => null);
    if (Array.isArray(result?.contents)) view.catalogue = result.contents;
    renderScreens();
}

function applyAgentInfo(info) {
    if (!info) return;
    $('agent-version').textContent = 'v' + info.version;
    if (info.deviceName) $('device-name').textContent = info.deviceName;
    $('salon-name').textContent = info.salonName || '';
    $('salon-name').hidden = !info.salonName;

    const state = CONNECTION[info.connection] || CONNECTION.connecting;
    $('status').className = `status ${state.tone}`;
    $('status-text').textContent = state.text;
    $('btn-reconnect').hidden = !state.retry;

    const cameOnline = info.connection === 'online' && !view.online;
    view.online = info.connection === 'online';
    if (!view.online) view.openPicker = null;
    view.screens = info.screens || [];
    if (cameOnline) loadCatalogue();
    renderScreens();
}

window.electron.onAgentInfo(applyAgentInfo);
const refreshInfo = () =>
    window.electron
        .getAgentInfo()
        .then(applyAgentInfo)
        .catch(() => {});
refreshInfo();
setInterval(refreshInfo, 3000);
// Grants change from the panel; a minute is fresh enough for a picker.
setInterval(() => view.online && loadCatalogue(), 60000);

$('btn-reconnect').addEventListener('click', () => {
    window.electron.sendAction('reconnect');
    $('btn-reconnect').hidden = true;
});

// Actions, the quit confirmation and the restart notice share one slot.
function showSlot(id) {
    for (const slot of ['actions', 'confirm', 'restarting']) $(slot).hidden = slot !== id;
}

$('btn-restart').addEventListener('click', () => {
    showSlot('restarting');
    window.electron.sendAction('restart');
});
$('btn-quit').addEventListener('click', () => {
    showSlot('confirm');
    $('btn-quit-cancel').focus();
});
$('btn-quit-cancel').addEventListener('click', () => showSlot('actions'));
$('btn-quit-confirm').addEventListener('click', () => window.electron.sendAction('quit'));

const versionStatus = $('version-status');
const versionStatusIcon = $('version-status-icon');
const versionStatusText = $('version-status-text');

// Only visible while actively checking or updating; quiet states stay hidden.
function applyUpdateState(s) {
    const state = s && s.state;
    if (state === 'up-to-date' || state === 'error') {
        versionStatus.className = 'version-status hidden';
    } else if (state === 'downloading') {
        versionStatus.className = 'version-status update-available';
        versionStatusIcon.textContent = 'system_update_alt';
        versionStatusText.textContent = Number.isFinite(s.percent)
            ? `Descargando actualización… ${s.percent}%`
            : 'Descargando actualización…';
    } else if (state === 'downloaded') {
        versionStatus.className = 'version-status update-available';
        versionStatusIcon.textContent = 'system_update_alt';
        versionStatusText.textContent = 'Actualización lista — reiniciando…';
    } else {
        versionStatus.className = 'version-status';
        versionStatusIcon.textContent = 'sync';
        versionStatusText.textContent = 'Comprobando versión…';
    }
}

// Show last known verdict immediately, then trigger a re-check.
window.electron
    .getUpdateState()
    .then(applyUpdateState)
    .catch(() => {});
window.electron.sendAction('check-update');
window.electron.onUpdateStatus(applyUpdateState);

$('btn-minimize').addEventListener('click', () => window.electron.minimizeWindow());
$('btn-window-close').addEventListener('click', () => window.electron.closeWindow());
