window.addEventListener('message', (event) => {
    if (!event.data || event.data.type !== 'GET_JITSI_NAMES') return;
    try {
        const conference = window.APP?.conference;
        if (!conference) return;

        const participants = conference._room?.participants || {};
        const localName = conference.getLocalDisplayName() || 'Вы';
        const names = { local: localName };

        for (const id in participants) {
            const p = participants[id];
            names[id] = p.getDisplayName() || p._id || 'Участник';
        }

        window.postMessage({ type: 'JITSI_NAMES_RESULT', names }, '*');
    } catch (e) {
        console.warn('[inject.js] ошибка получения имён:', e);
    }
});