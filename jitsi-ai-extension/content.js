(function() {
    let recorders = new Map();
    let isRecording = false;
    let jitsiNames = { local: 'Вы' };

    function injectScript() {
        const script = document.createElement('script');
        script.src = chrome.runtime.getURL('inject.js');
        (document.head || document.documentElement).appendChild(script);
        script.onload = () => script.remove();
    }

    injectScript();

    window.addEventListener('message', (event) => {
        if (!event.data || !event.data.type) return;

        if (event.data.type === 'JITSI_NAMES_RESULT') {
            jitsiNames = event.data.names;

            // Обновляем имена на уже запущенных рекордерах
            for (const [stream, state] of recorders.entries()) {
                if (state.participantId === 'local') {
                    state.displayName = jitsiNames.local || 'Вы';
                } else if (jitsiNames[state.participantId]) {
                    state.displayName = jitsiNames[state.participantId];
                }
            }
        }
    });

    // Запрашиваем имена каждые 3 секунды
    setInterval(() => {
        if (isRecording) {
            window.postMessage({ type: 'GET_JITSI_NAMES' }, '*');
        }
    }, 3000);

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === "START_RECORDING") {
            if (!isRecording) {
                isRecording = true;
                // Сразу запросить имена
                window.postMessage({ type: 'GET_JITSI_NAMES' }, '*');
                setTimeout(scanAndRecord, 500);
            }
            sendResponse({ status: "started" });
        } else if (request.action === "STOP_RECORDING") {
            isRecording = false;
            stopAllRecorders().then(data => {
                sendResponse({ status: "stopped", data: data });
            });
            return true;
        } else if (request.action === "GET_STATUS") {
            sendResponse({ isRecording: isRecording, participantsCount: recorders.size });
        }
    });

    async function stopAllRecorders() {
        const results = [];
        const stopPromises = [];

        for (const [stream, state] of recorders.entries()) {
            const p = new Promise(resolve => {
                state.mediaRecorder.onstop = async () => {
                    await new Promise(r => setTimeout(r, 600));
                    results.push({
                        participantId: state.participantId,
                        displayName: state.displayName,
                        chunks: state.chunks
                    });
                    resolve();
                };
                try {
                    state.mediaRecorder.stop();
                } catch(e) { resolve(); }
            });
            stopPromises.push(p);
        }

        await Promise.all(stopPromises);
        recorders.clear();
        return results;
    }

    function getParticipantName(el) {
        let displayName = 'Участник';
        let participantId = el.id || 'unknown';

        // Вариант 1: remoteAudio_PARTICIPANTID
        if (participantId.includes('remoteAudio_')) {
            const id = participantId.replace('remoteAudio_', '');
            participantId = id;
            displayName = jitsiNames[id] || 'Участник';
            return { displayName, participantId };
        }

        // Вариант 2: локальный аудио
        if (el.id === 'localAudio' || el.closest('.local-video-container')) {
            displayName = jitsiNames.local || 'Вы';
            participantId = 'local';
            return { displayName, participantId };
        }

        // Вариант 3: ищем через DOM-контейнер участника
        const container = el.closest('[id^="participant_"], .videocontainer, [id^="remoteVideo_"]');
        if (container) {
            // Извлекаем ID из атрибута контейнера
            const cid = container.id?.replace('participant_', '')?.replace('remoteVideo_', '');
            if (cid && jitsiNames[cid]) {
                displayName = jitsiNames[cid];
                participantId = cid;
                return { displayName, participantId };
            }
            // Ищем имя в DOM
            const nameElem = container.querySelector('.displayname, .participant-name');
            if (nameElem && nameElem.innerText.trim()) {
                displayName = nameElem.innerText.trim();
            }
        }

        // Вариант 4: если только один другой участник — берём его имя из jitsiNames
        const otherNames = Object.entries(jitsiNames).filter(([k]) => k !== 'local');
        if (otherNames.length === 1) {
            participantId = otherNames[0][0];
            displayName = otherNames[0][1] || 'Участник';
        }

        return { displayName, participantId };
    }

    function scanAndRecord() {
        if (!isRecording) return;

        const allMedia = [
            ...document.querySelectorAll('audio'),
            ...document.querySelectorAll('video')
        ];

        allMedia.forEach(el => {
            const stream = el.srcObject;
            if (!stream || stream.getAudioTracks().length === 0) return;
            if (recorders.has(stream)) return;

            const { displayName, participantId } = getParticipantName(el);
            startRecordingStream(stream, displayName, participantId);
        });

        if (isRecording) setTimeout(scanAndRecord, 2000);
    }

    function startRecordingStream(stream, displayName, participantId) {
        if (recorders.has(stream)) return;
        const chunks = [];
        try {
            const options = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                ? { mimeType: 'audio/webm;codecs=opus' }
                : { mimeType: 'audio/webm' };

            const mediaRecorder = new MediaRecorder(stream, options);
            mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    const reader = new FileReader();
                    reader.onload = () => {
                        const base = btoa(
                            new Uint8Array(reader.result)
                                .reduce((d, b) => d + String.fromCharCode(b), '')
                        );
                        chunks.push(base);
                    };
                    reader.readAsArrayBuffer(event.data);
                }
            };
            mediaRecorder.start(2000);
            recorders.set(stream, { mediaRecorder, displayName, participantId, chunks, stream });
            console.log(`[Meeting Pro] Запись: ${displayName} (${participantId})`);
        } catch (e) {
            console.error('[Meeting Pro] Ошибка запуска записи:', e);
        }
    }
})();