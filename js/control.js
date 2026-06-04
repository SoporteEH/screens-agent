document.getElementById('current-year').textContent = new Date().getFullYear();

let modalCallback = null;
const modalOverlay = document.getElementById('modal-overlay');
const modalTitle = document.getElementById('modal-title');
const modalMessage = document.getElementById('modal-message');
const modalConfirmBtn = document.getElementById('modal-confirm');
const modalCancelBtn = document.getElementById('modal-cancel');

function showModal(title, message, confirmText = 'Aceptar', isDanger = false) {
    return new Promise((resolve) => {
        modalTitle.textContent = title;
        modalMessage.textContent = message;
        modalConfirmBtn.textContent = confirmText;

        if (isDanger) {
            modalConfirmBtn.classList.add('danger');
        } else {
            modalConfirmBtn.classList.remove('danger');
        }

        modalOverlay.classList.add('show');
        modalCallback = resolve;
    });
}

function hideModal() {
    modalOverlay.classList.remove('show');
}

modalConfirmBtn.addEventListener('click', () => {
    hideModal();
    if (modalCallback) modalCallback(true);
});

modalCancelBtn.addEventListener('click', () => {
    hideModal();
    if (modalCallback) modalCallback(false);
});

modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) {
        hideModal();
        if (modalCallback) modalCallback(false);
    }
});

let agentServerUrl = null;

window.electron.onAgentInfo((info) => {
    document.getElementById('agent-version').textContent = 'v' + info.version;

    if (info.serverUrl && !agentServerUrl) {
        agentServerUrl = info.serverUrl;
        setTimeout(() => checkVersionStatus(), 500);
    }

    const statusBadge = document.getElementById('status-container');
    const statusText = document.getElementById('agent-status');

    if (info.status === 'Online') {
        statusBadge.classList.remove('offline');
        statusText.textContent = 'Online';
    } else {
        statusBadge.classList.add('offline');
        statusText.textContent = info.status;
    }

    if (info.deviceName) {
        document.getElementById('device-name').textContent = info.deviceName;
    }
});

document.getElementById('btn-restart').addEventListener('click', async () => {
    const confirmed = await showModal(
        'Reiniciar',
        'La aplicación se cerrará y volverá a iniciarse automáticamente.',
        'Reiniciar'
    );
    if (confirmed) {
        window.electron.sendAction('restart');
    }
});

document.getElementById('btn-quit').addEventListener('click', async () => {
    const confirmed = await showModal(
        'Cerrar',
        'La aplicación se cerrará completamente.',
        'Cerrar',
        true
    );
    if (confirmed) {
        window.electron.sendAction('quit');
    }
});

const updateBtn = document.getElementById('btn-update');
const updateBtnText = document.getElementById('update-btn-text');
const updateSpinner = document.getElementById('update-spinner');
let updateAvailable = false;

async function checkVersionStatus() {
    if (!agentServerUrl) return;

    try {
        const currentVersion = await window.electron.getAppVersion();
        const url = `${agentServerUrl}/api/agent/check-version?current=${currentVersion}`;
        const response = await fetch(url);
        const data = await response.json();

        updateAvailable = data.updateAvailable;

        if (updateAvailable) {
            updateBtnText.innerHTML = '<span class="material-icons">system_update_alt</span><span>Actualizar App</span>';
            updateBtn.classList.remove('btn-secondary');
            updateBtn.classList.add('btn-success');
            updateBtn.disabled = false;
        } else {
            updateBtnText.innerHTML = '<span class="material-icons">check_circle</span><span>App Actualizada</span>';
            updateBtn.classList.remove('btn-success');
            updateBtn.classList.add('btn-secondary');
            updateBtn.disabled = true;
        }
    } catch (error) {
        updateBtnText.innerHTML = '<span class="material-icons">system_update_alt</span><span>Buscar Actualización</span>';
        updateBtn.disabled = false;
    }
}

setInterval(() => {
    if (agentServerUrl) checkVersionStatus();
}, 2 * 60 * 1000);

updateBtn.addEventListener('click', () => {
    if (!updateAvailable) return;

    updateBtnText.style.display = 'none';
    updateSpinner.style.display = 'inline-block';
    updateBtn.disabled = true;
    window.electron.sendAction('check-update');

    let countdown = 10;
    const countdownInterval = setInterval(() => {
        countdown--;
        if (countdown > 0) {
            updateSpinner.style.display = 'none';
            updateBtnText.style.display = 'flex';
            updateBtnText.innerHTML = `<span class="material-icons">timer</span><span>Espera ${countdown}s</span>`;
        } else {
            clearInterval(countdownInterval);
            checkVersionStatus();
            updateBtnText.style.display = 'flex';
            updateSpinner.style.display = 'none';
        }
    }, 1000);
});

window.electron.onUpdateStatus((status) => {
    const notification = document.getElementById('notification');

    if (status.type === 'up-to-date') {
        notification.textContent = 'App en la última versión';
        notification.className = 'notification success show';
    } else if (status.type === 'downloading') {
        notification.textContent = 'Descargando actualización...';
        notification.className = 'notification info show';
    } else if (status.type === 'downloaded') {
        notification.textContent = 'Actualización descargada. Reiniciando...';
        notification.className = 'notification success show';
    } else if (status.type === 'error') {
        notification.textContent = 'Error al buscar actualización';
        notification.className = 'notification error show';
    }

    updateBtnText.style.display = 'flex';
    updateBtnText.style.alignItems = 'center';
    updateBtnText.style.gap = '8px';
    updateSpinner.style.display = 'none';
    updateBtn.disabled = false;

    if (status.type === 'up-to-date' || status.type === 'downloaded') {
        setTimeout(() => checkVersionStatus(), 2000);
    }
    setTimeout(() => {
        notification.classList.remove('show');
    }, 6000);
});

document.getElementById('btn-minimize').addEventListener('click', () => {
    window.electron.minimizeWindow();
});

document.getElementById('btn-window-close').addEventListener('click', () => {
    window.electron.closeWindow();
});
