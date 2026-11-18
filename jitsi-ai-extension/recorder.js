/* Shared browser recorder. Each segment is an independently playable WebM. */
(function (root) {
    'use strict';
    class MeetingRecorder {
        constructor({ onSegment, onError = () => {}, segmentMs = 60000, scanDom = false }) {
            this.onSegment = onSegment;
            this.onError = onError;
            this.segmentMs = segmentMs;
            this.scanDom = scanDom;
            this.tracks = new Map();
            this.pending = new Set();
            this.errors = [];
            this.running = false;
        }
        start() {
            if (this.running) throw new Error('Запись уже идёт.');
            this.running = true;
            this.startedAt = Date.now();
            if (this.scanDom) {
                this.scan();
                this.scanner = setInterval(() => this.scan(), 1000);
            }
        }
        fail(error) {
            this.errors.push(error.message);
            this.onError(error);
        }
        scan() {
            for (const element of document.querySelectorAll('audio, video')) {
                if (element.id === 'localAudio' || element.closest('#localVideoContainer, .local-video-container')) continue;
                const stream = element.srcObject;
                if (!stream?.getAudioTracks) continue;
                const container = element.closest('[id^="participant_"], .videocontainer');
                const participantId = element.id?.replace(/^remoteAudio_/, '');
                const participant = root.APP?.conference?._room?.getParticipantById?.(participantId);
                const displayName = participant?.getDisplayName?.() || container?.querySelector('.displayname')?.textContent?.trim()
                    || element.id || 'Участник';
                this.addStream(stream, displayName, element.id || displayName);
            }
        }
        addStream(stream, displayName, participantId = displayName) {
            if (!this.running) return;
            for (const track of stream.getAudioTracks()) {
                if (track.readyState === 'ended' || this.tracks.has(track.id)) continue;
                const entry = { track, displayName, participantId, index: 0 };
                this.tracks.set(track.id, entry);
                this.record(entry);
            }
        }
        record(entry) {
            if (!this.running || entry.track.readyState === 'ended') return;
            let recorder;
            try {
                if (!MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) throw new Error('Нужен браузер с поддержкой WebM/Opus (Chrome или Edge).');
                recorder = new MediaRecorder(new MediaStream([entry.track]), {
                    mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 64000
                });
            } catch (error) { this.fail(error); return; }
            const chunks = [];
            const startMs = Date.now() - this.startedAt;
            const index = entry.index++;
            let finish;
            entry.done = new Promise(resolve => { finish = resolve; });
            entry.recorder = recorder;
            recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
            recorder.onerror = event => this.fail(event.error || new Error('Ошибка MediaRecorder.'));
            recorder.onstop = () => {
                clearTimeout(entry.timer);
                const blob = new Blob(chunks, { type: recorder.mimeType });
                const metadata = { participantId: entry.participantId, displayName: entry.displayName,
                    trackId: entry.track.id, index, startMs, endMs: Date.now() - this.startedAt };
                // Restart immediately; saving the completed file must not delay capture.
                if (this.running && entry.track.readyState !== 'ended') this.record(entry);
                const save = Promise.resolve().then(() => blob.size && this.onSegment(blob, metadata))
                    .catch(error => this.fail(error)).finally(() => { this.pending.delete(save); finish(); });
                this.pending.add(save);
            };
            recorder.start(1000);
            entry.timer = setTimeout(() => {
                if (recorder.state !== 'inactive') recorder.stop();
            }, this.segmentMs);
        }
        async stop() {
            this.running = false;
            clearInterval(this.scanner);
            const completions = [];
            for (const entry of this.tracks.values()) {
                clearTimeout(entry.timer);
                if (entry.done) completions.push(entry.done);
                if (entry.recorder?.state !== 'inactive') entry.recorder?.stop();
            }
            await Promise.all(completions);
            await Promise.all([...this.pending]);
            this.tracks.clear();
            return [...this.errors];
        }
    }
    root.MeetingRecorder = MeetingRecorder;
})(globalThis);
