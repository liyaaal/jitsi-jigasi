'use strict';
const $ = id => document.getElementById(id);
let sources = [], recorder, session, sessions = [], selected, busy = false, preparing = false;
let audioContext, meterFrame, timer, captureStarted, lockRelease;
const status = (text, error = false) => { $('status').textContent = text; $('status').classList.toggle('error', error); };
const safeName = value => String(value).replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 80) || 'meeting';
function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function controls() {
    const recording = Boolean(recorder);
    for (const id of ['prepare', 'source', 'microphone', 'title']) $(id).disabled = recording || busy || preparing;
    $('start').disabled = recording || busy || preparing || !sources.length || !$('consent').checked;
    $('stop').disabled = !recording || busy;
    for (const id of ['process', 'delete']) $(id).disabled = recording || busy || !selected;
    $('provider').disabled = busy;
    $('apiKey').disabled = busy;
    $('language').disabled = busy;
}
async function releaseSources() {
    for (const source of sources) source.stream.getTracks().forEach(track => track.stop());
    sources = [];
    cancelAnimationFrame(meterFrame);
    if (audioContext) await audioContext.close().catch(() => {});
    audioContext = null;
    $('meetingLevel').value = $('micLevel').value = 0;
    controls();
}
async function prepare() {
    preparing = true; controls();
    try {
        // Call the chooser immediately while the click's user activation is live.
        const mode = $('source').value;
        const request = mode === 'microphone' ? navigator.mediaDevices.getUserMedia({ audio: true })
            : navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: mode === 'browser' ? 'browser' : 'monitor' }, audio: true,
                systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude',
                ...(mode === 'browser' ? { preferCurrentTab: false } : {}) });
        await releaseSources();
        const stream = await request;
        sources.push({ stream, label: mode === 'microphone' ? 'Мой микрофон' : 'Звук встречи', id: mode === 'microphone' ? 'microphone' : 'meeting' });
        if (!stream.getAudioTracks().length) throw new Error('Источник не передал аудио. Выберите вкладку или весь экран и включите передачу звука. На этой ОС звук окна может быть недоступен.');
        if (mode !== 'microphone' && $('microphone').checked) {
            sources.push({ stream: await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }), label: 'Мой микрофон', id: 'microphone' });
        }
        for (const source of sources) for (const track of source.stream.getTracks()) track.addEventListener('ended', () => {
            if (recorder) stopRecording().catch(error => status(error.message, true));
            else releaseSources().then(() => status('Источник отключён. Выберите его заново.'));
        }, { once: true });
        audioContext = new AudioContext();
        await audioContext.resume();
        const meters = sources.map(source => {
            const analyser = audioContext.createAnalyser(); analyser.fftSize = 256;
            audioContext.createMediaStreamSource(new MediaStream(source.stream.getAudioTracks())).connect(analyser);
            return { analyser, data: new Uint8Array(256), element: $(source.id === 'microphone' ? 'micLevel' : 'meetingLevel') };
        });
        function draw() {
            for (const { analyser, data, element } of meters) {
                analyser.getByteTimeDomainData(data);
                element.value = Math.min(1, Math.sqrt(data.reduce((sum, n) => sum + ((n - 128) / 128) ** 2, 0) / data.length) * 5);
            }
            meterFrame = requestAnimationFrame(draw);
        }
        draw(); status('Источник подключён. Проверьте индикаторы на слышимой речи, затем начните запись.');
    } catch (error) {
        await releaseSources();
        status(error.name === 'NotAllowedError' ? 'Доступ отменён или запрещён. Повторите выбор и разрешите звук.' : error.message, true);
    } finally { preparing = false; controls(); }
}
async function startRecording() {
    busy = true; controls();
    try {
        if (!sources.length || sources.some(s => !s.stream.getAudioTracks().some(t => t.readyState === 'live'))) throw new Error('Источник отключён. Выберите его заново.');
        session = { id: crypto.randomUUID(), title: $('title').value.trim() || 'Новая встреча', createdAt: new Date().toISOString(), state: 'recording' };
        await MeetingStore.putSession(session);
        recorder = new MeetingRecorder({ onSegment: async (blob, metadata) => {
            await MeetingStore.putSegment({ ...metadata, blob, id: crypto.randomUUID(), sessionId: session.id });
        }, onError: error => { status(`Ошибка сохранения: ${error.message}. Остановите запись и проверьте место на диске.`, true); } });
        recorder.start();
        sources.forEach(source => recorder.addStream(source.stream, source.label, source.id));
        selected = session;
        captureStarted = Date.now();
        timer = setInterval(() => {
            const seconds = Math.floor((Date.now() - captureStarted) / 1000);
            $('timer').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
        }, 500);
        status('Идёт запись. Аудио сохраняется на устройстве каждую минуту.');
        await refreshHistory(); await showSession(session);
    } catch (error) { status(error.message, true); }
    finally { busy = false; controls(); }
}
async function stopRecording() {
    if (!recorder || busy) return;
    busy = true; controls(); status('Сохраняю последний отрезок…');
    let errors = [];
    try {
        errors = await recorder.stop();
        if (!(await MeetingStore.segments(session.id)).length) errors.push('Аудиоданные не получены. Проверьте источник и попробуйте более длинную запись.');
        session.state = errors.length ? 'error' : 'saved';
        session.durationMs = Date.now() - captureStarted;
        session.recordingErrors = errors;
        await MeetingStore.putSession(session);
        await refreshHistory(); await showSession(session);
        status(errors.length ? `Запись завершена с ошибками: ${errors.join('; ')}` : 'Запись сохранена. Можно скачать аудио или запустить расшифровку.', errors.length > 0);
    } catch (error) { status(`Ошибка сохранения: ${error.message}`, true); }
    finally { recorder = null; clearInterval(timer); await releaseSources(); busy = false; controls(); }
}
async function refreshHistory() {
    sessions = (await MeetingStore.listSessions()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    $('historyCount').textContent = sessions.length;
    $('history').replaceChildren();
    for (const item of sessions) {
        const button = document.createElement('button');
        button.classList.toggle('selected', selected?.id === item.id);
        button.append(document.createTextNode(item.title));
        const date = document.createElement('small'); date.textContent = new Date(item.createdAt).toLocaleString('ru'); button.append(date);
        button.onclick = () => { if (!busy && !recorder) showSession(item).catch(error => status(error.message, true)); };
        $('history').append(button);
    }
}
async function showSession(item) {
    selected = item;
    $('resultTitle').textContent = item.title;
    const segments = (await MeetingStore.segments(item.id)).sort((a, b) => a.startMs - b.startMs);
    $('resultMeta').textContent = `${new Date(item.createdAt).toLocaleString('ru')} · ${segments.length} аудиоотрезков · ${item.state === 'recording' && !recorder ? 'Запись прервалась: доступны завершённые отрезки' : item.state === 'recording' ? 'Идёт запись' : 'Сохранено на устройстве'}`;
    $('report').textContent = item.report || 'Аудио сохранено. Расшифруйте встречу, когда будете готовы.';
    $('downloadReport').disabled = !item.report;
    $('downloadTranscript').disabled = !item.transcript;
    $('segmentCount').textContent = `(${segments.length})`;
    $('audioFiles').replaceChildren();
    for (const segment of segments) {
        const button = document.createElement('button');
        button.textContent = `↓ ${segment.displayName} · ${Math.floor(segment.startMs / 1000)} сек · ${(segment.blob.size / 1024).toFixed(0)} КБ`;
        button.onclick = () => download(segment.blob, `${safeName(item.title)}_${safeName(segment.displayName)}_${segment.startMs}_${segment.id.slice(0, 8)}.webm`);
        $('audioFiles').append(button);
    }
    controls();
}
async function processSession() {
    busy = true; controls();
    const target = selected;
    try {
        const options = MeetingAPI.settings({ apiKey: $('apiKey').value, baseUrl: $('provider').value, language: $('language').value });
        await chrome.storage.session.set({ apiKey: options.apiKey, provider: options.baseUrl });
        await chrome.storage.local.set({ provider: options.baseUrl, language: options.language });
        const segments = (await MeetingStore.segments(target.id)).sort((a, b) => a.startMs - b.startMs);
        if (!segments.length) throw new Error('Нет сохранённых аудиофайлов.');
        const errors = [];
        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            if (typeof segment.text === 'string') continue;
            status(`Распознаю аудио ${i + 1} из ${segments.length}: ${segment.displayName}…`);
            try {
                segment.text = await MeetingAPI.transcribe(segment.blob, options);
                await MeetingStore.putSegment(segment);
            } catch (error) { errors.push(`${segment.displayName} (${Math.floor(segment.startMs / 1000)} сек): ${error.message}`); }
        }
        target.transcript = segments.filter(s => s.text).map(s => `[${Math.floor(s.startMs / 1000)} сек] ${s.displayName}: ${s.text}`).join('\n\n');
        // Checkpoint before the independent summary request.
        target.report = target.transcript || 'Нет распознанного текста.';
        await MeetingStore.putSession(target);
        let summary = '';
        if (target.transcript) {
            status('Создаю протокол встречи…');
            try { summary = await MeetingAPI.summarize(target.transcript, options); }
            catch (error) { errors.push(`Протокол: ${error.message}`); }
        }
        target.report = `# ${target.title}\n\nРаспознавание может содержать ошибки. Время — начало аудиоотрезка, а не точная секунда реплики.\n\n## Итоги и задачи\n\n${summary || 'Протокол не создан.'}\n\n## Полная расшифровка\n\n${target.transcript || 'Нет распознанного текста.'}${errors.length ? '\n\n## Ошибки обработки\n\n' + errors.join('\n\n') : ''}`;
        target.state = errors.length ? 'partial' : 'processed';
        await MeetingStore.putSession(target); await showSession(target); await refreshHistory();
        status(errors.length ? 'Обработка завершена частично. Ошибки указаны в отчёте; можно повторить.' : 'Готово. Протокол и транскрипт сохранены.', errors.length > 0);
    } catch (error) { status(error.message, true); }
    finally { busy = false; controls(); }
}
$('prepare').onclick = prepare;
$('start').onclick = startRecording;
$('stop').onclick = stopRecording;
$('process').onclick = processSession;
$('consent').onchange = controls;
for (const id of ['source', 'microphone']) $(id).onchange = async () => {
    await releaseSources();
    $('sourceHint').textContent = $('source').value === 'desktop'
        ? 'Для Zoom, Discord и Telegram выберите весь экран и включите системный звук. Могут записаться и другие звуки компьютера.'
        : $('source').value === 'microphone' ? 'Для очной встречи или голосовой заметки. Будет записан только микрофон.'
            : 'Выберите вкладку со встречей и включите «Поделиться аудио вкладки».';
    status('Источник изменён. Подключите его заново.');
};
$('provider').onchange = async () => { $('apiKey').value = ''; await chrome.storage.session.remove('apiKey'); };
$('downloadReport').onclick = () => download(new Blob([selected.report], { type: 'text/markdown;charset=utf-8' }), `${safeName(selected.title)}.md`);
$('downloadTranscript').onclick = () => download(new Blob([selected.transcript], { type: 'text/plain;charset=utf-8' }), `${safeName(selected.title)}.txt`);
$('delete').onclick = async () => {
    if (!selected || busy || recorder || !confirm('Удалить эту встречу, аудио и расшифровку с устройства?')) return;
    try { await MeetingStore.deleteSession(selected.id); selected = null; await refreshHistory(); location.reload(); }
    catch (error) { status(error.message, true); }
};
window.addEventListener('beforeunload', event => { if (recorder || busy) { event.preventDefault(); event.returnValue = ''; } });
async function initialize() {
    // A second dashboard must not write to the same active recording.
    navigator.locks.request('meeting-pro-dashboard', { ifAvailable: true }, async lock => {
        if (!lock) { document.querySelectorAll('button,input,select').forEach(el => { el.disabled = true; }); status('Meeting Pro уже открыт в другой вкладке.', true); return; }
        try {
            await chrome.storage.local.remove(['openaiApiKey', 'openaiApiUrl']);
            const config = await chrome.storage.local.get(['provider', 'language']);
            const temporary = await chrome.storage.session.get(['apiKey', 'provider']);
            $('provider').value = config.provider || 'https://api.openai.com/v1';
            $('language').value = config.language || '';
            if (temporary.provider === $('provider').value) $('apiKey').value = temporary.apiKey || '';
            await refreshHistory();
            if (sessions[0]) await showSession(sessions[0]);
            controls();
        } catch (error) { status(`Не удалось открыть локальное хранилище: ${error.message}`, true); }
        await new Promise(resolve => { lockRelease = resolve; });
    }).catch(error => status(error.message, true));
}
initialize();
