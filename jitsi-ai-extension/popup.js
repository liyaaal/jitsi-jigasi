document.addEventListener('DOMContentLoaded', () => {
    const recordBtn = document.getElementById('recordBtn');
    const status = document.getElementById('status');
    const apiKeyInput = document.getElementById('apiKey');
    const apiUrlInput = document.getElementById('apiUrl');
    const resultBox = document.getElementById('result');
    const summaryContent = document.getElementById('summaryContent');
    const copyBtn = document.getElementById('copyBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const downloadAudioBtn = document.getElementById('downloadAudioBtn');

    const DEFAULT_KEY = "";
    const DEFAULT_URL = "https://api.groq.com/openai/v1";

    let currentReport = "";
    let isRecording = false;
    let lastParticipantsData = [];
    let currentTranscript = "";

    chrome.storage.local.get(['openaiApiKey', 'openaiApiUrl'], (res) => {
        apiKeyInput.value = res.openaiApiKey || DEFAULT_KEY;
        apiUrlInput.value = res.openaiApiUrl || DEFAULT_URL;
    });

    setInterval(() => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (!tabs[0] || !tabs[0].url.includes('meet.jit.si')) return;
            chrome.tabs.sendMessage(tabs[0].id, { action: "GET_STATUS" }, (res) => {
                if (chrome.runtime.lastError) return;
                if (res && res.isRecording) {
                    isRecording = true;
                    status.innerText = `Идет запись... (Участников: ${res.participantsCount || 0})`;
                    updateUI(true);
                }
            });
        });
    }, 2000);

    recordBtn.addEventListener('click', async () => {
        const apiKey = apiKeyInput.value.trim() || DEFAULT_KEY;
        const apiUrl = apiUrlInput.value.trim() || DEFAULT_URL;
        
        if (!apiKey) {
            alert("Введите API Ключ.");
            return;
        }
        chrome.storage.local.set({ openaiApiKey: apiKey, openaiApiUrl: apiUrl });

        chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
            if (!tabs[0] || !tabs[0].url.includes('meet.jit.si')) {
                alert("Пожалуйста, откройте Jitsi Meet.");
                return;
            }

            if (!isRecording) {
                chrome.tabs.sendMessage(tabs[0].id, { action: "START_RECORDING" }, (res) => {
                    if (chrome.runtime.lastError) {
                        alert("Обновите страницу Jitsi Meet (F5).");
                        return;
                    }
                    isRecording = true;
                    status.innerText = "Запуск записи...";
                    updateUI(true);
                });
            } else {
                status.innerText = "Сбор данных... Ждите.";
                status.style.color = "white";
                recordBtn.disabled = true;
                
                chrome.tabs.sendMessage(tabs[0].id, { action: "STOP_RECORDING" }, async (res) => {
                    if (chrome.runtime.lastError || !res) {
                        status.innerText = "Ошибка связи.";
                        status.style.color = "red";
                        recordBtn.disabled = false;
                        return;
                    }
                        try {
                            lastParticipantsData = res.data;
                            const report = await processMeetingData(res.data, apiKey, apiUrl);
                            showResult(report);
                            isRecording = false;
                            recordBtn.disabled = false;
                            updateUI(false);
                            status.innerText = "Готово!";
                        } catch (err) {
                            status.innerText = "ОШИБКА: " + err.message;
                            status.style.color = "red";
                            recordBtn.disabled = false;
                            isRecording = false;
                            updateUI(false, true); 
                            resultBox.classList.remove('hidden');
                            summaryContent.innerText = "Транскрипция не удалась, но аудио доступно ниже.";
                        }
                });
            }
        });
    });

    function updateUI(recording, skipStatusReset = false) {
        if (recording) {
            recordBtn.innerText = "Остановить и Сохранить";
            recordBtn.classList.remove('primary');
            recordBtn.classList.add('danger');
        } else {
            recordBtn.innerText = "Начать запись";
            recordBtn.classList.add('primary');
            recordBtn.classList.remove('danger');
            if (!skipStatusReset) {
                status.innerText = "Запись остановлена";
                status.style.color = "white";
            }
        }
    }

    async function processMeetingData(participantsData, apiKey, apiUrl) {
        status.innerText = "Транскрипция: " + participantsData.length + " чел.";
        const transcriptions = [];

        for (const p of participantsData) {
            if (!p.chunks || p.chunks.length === 0) continue;
            
            const audioBlob = base64ChunksToBlob(p.chunks);
            if (audioBlob.size < 500) continue;

            status.innerText = `Расшифровка: ${p.displayName}...`;
            try {
                const text = await transcribeAudio(audioBlob, apiKey, apiUrl);
                if (text && text.trim()) {
                    transcriptions.push(`[${p.displayName}]: ${text}`);
                }
            } catch (e) {
                throw new Error(`${p.displayName}: ${e.message}`);
            }
        }

        if (transcriptions.length === 0) {
            throw new Error("Речь не обнаружена.");
        }

        status.innerText = "ИИ обработка...";
        const rawTranscript = transcriptions.join("\n");
        const polishedTranscript = await polishTranscript(rawTranscript, apiKey, apiUrl);

        status.innerText = "Создание протокола...";
        const summary = await generateSummary(polishedTranscript, apiKey, apiUrl);

        currentReport = `ВНИМАНИЕ: Речь распознана искусственным интеллектом и может содержать неточности.\n\n` + 
                        `--- КРАТКИЙ ПЕРЕСКАЗ ---\n${summary}\n\n` + 
                        `--- ПОЛНАЯ РАСШИФРОВКА ---\n${polishedTranscript}`;
                        currentTranscript = polishedTranscript;
        return currentReport;
    }

    async function transcribeAudio(blob, apiKey, apiUrl) {
        const formData = new FormData();
        formData.append('file', blob, 'audio.webm');
        const model = apiUrl.includes('groq.com') ? 'whisper-large-v3-turbo' : 'whisper-1';
        formData.append('model', model);
        formData.append('language', 'ru');

        const response = await fetch(`${apiUrl}/audio/transcriptions`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}` },
            body: formData
        });

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(`${errData.error?.message || "unknown"}`);
        }
        const data = await response.json();
        return data.text;
    }

    async function polishTranscript(transcript, apiKey, apiUrl) {
        try {
            const model = apiUrl.includes('groq.com') ? 'llama-3.3-70b-versatile' : 'gpt-4o-mini';
            const response = await fetch(`${apiUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: model,
                    messages: [
                        { role: 'system', content: 'Ты редактор. Исправь опечатки в тексте на русском языке. ВЫВЕДИ ТОЛЬКО ИСПРАВЛЕННЫЙ ТЕКСТ.' },
                        { role: 'user', content: transcript }
                    ]
                })
            });
            if (!response.ok) return transcript;
            const data = await response.json();
            return data.choices[0].message.content;
        } catch (e) {
            return transcript;
        }
    }

    async function generateSummary(transcript, apiKey, apiUrl) {
        const model = apiUrl.includes('groq.com') ? 'llama-3.3-70b-versatile' : 'gpt-4o-mini';
        const response = await fetch(`${apiUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: model,
                    messages: [
                        { role: 'system', content: 'Сделай краткий пересказ встречи на русском языке. Будь лаконичен.' },
                        { role: 'user', content: transcript }
                    ]
            })
        });
        if (!response.ok) return "Ошибка саммари.";
        const data = await response.json();
        return data.choices[0].message.content;
    }

    function base64ChunksToBlob(chunks) {
        const byteArrays = chunks.map(base64 => {
            const byteCharacters = atob(base64);
            const byteNumbers = new Array(byteCharacters.length);
            for (let i = 0; i < byteCharacters.length; i++) {
                byteNumbers[i] = byteCharacters.charCodeAt(i);
            }
            return new Uint8Array(byteNumbers);
        });
        return new Blob(byteArrays, { type: 'audio/webm' });
    }

    function showResult(report) {
        resultBox.classList.remove('hidden');
        summaryContent.innerText = report;
    }

    copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(summaryContent.innerText);
        alert("Скопировано!");
    });

    downloadBtn.addEventListener('click', () => {
        if (!currentReport) return;
        const blob = new Blob([currentReport], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Report_${new Date().toISOString().split('T')[0]}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    });

    downloadAudioBtn.addEventListener('click', () => {
        if (!lastParticipantsData || lastParticipantsData.length === 0) return;
        lastParticipantsData.forEach((p, index) => {
            if (!p.chunks || p.chunks.length === 0) return;
            const blob = base64ChunksToBlob(p.chunks);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `Audio_${p.displayName}.webm`;
            document.body.appendChild(a);
            setTimeout(() => {
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }, index * 800); 
        });
    });
    downloadTranscriptBtn.addEventListener('click', () => {
    if (!currentTranscript) return;
    const blob = new Blob([currentTranscript], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Transcript_${new Date().toISOString().split('T')[0]}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
});
});
