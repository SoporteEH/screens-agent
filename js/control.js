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

window.electron.onAgentInfo((info) => {
    document.getElementById('agent-version').textContent = 'v' + info.version;

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

const versionStatus = document.getElementById('version-status');
const versionStatusIcon = document.getElementById('version-status-icon');
const versionStatusText = document.getElementById('version-status-text');

function applyUpdateState(s) {
    const state = s && s.state;
    if (state === 'up-to-date') {
        versionStatus.className = 'version-status up-to-date';
        versionStatusIcon.textContent = 'check_circle';
        versionStatusText.textContent = 'App actualizada';
    } else if (state === 'downloading') {
        versionStatus.className = 'version-status update-available';
        versionStatusIcon.textContent = 'system_update_alt';
        versionStatusText.textContent =
            s.percent != null
                ? `Descargando actualización… ${s.percent}%`
                : 'Descargando actualización…';
    } else if (state === 'downloaded') {
        versionStatus.className = 'version-status update-available';
        versionStatusIcon.textContent = 'system_update_alt';
        versionStatusText.textContent = 'Actualización lista — reiniciando…';
    } else if (state === 'error') {
        versionStatus.className = 'version-status';
        versionStatusIcon.textContent = 'help_outline';
        versionStatusText.textContent = 'No se pudo comprobar la versión';
    } else {
        versionStatus.className = 'version-status';
        versionStatusIcon.textContent = 'sync';
        versionStatusText.textContent = 'Comprobando versión…';
    }
}

// Show last known verdict immediately, then trigger a re-check.
window.electron.getUpdateState().then(applyUpdateState).catch(() => {});
window.electron.sendAction('check-update');

window.electron.onUpdateStatus((status) => {
    applyUpdateState(status);

    const notification = document.getElementById('notification');
    if (status.state === 'downloading') {
        notification.textContent = 'Descargando actualización...';
        notification.className = 'notification info show';
    } else if (status.state === 'downloaded') {
        notification.textContent = 'Actualización descargada. Reiniciando...';
        notification.className = 'notification success show';
    } else if (status.state === 'error') {
        notification.textContent = 'Error al buscar actualización';
        notification.className = 'notification error show';
    } else {
        return;
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
