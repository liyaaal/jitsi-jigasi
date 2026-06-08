(function() {
    const recorders = new Map();

    function startRecording(audioElement) {
        if (recorders.has(audioElement)) return;
        
        const stream = audioElement.srcObject;
        if (!stream || stream.getAudioTracks().length === 0) return;

        let displayName = 'Unknown';
        
        if (audioElement.id && audioElement.id.startsWith('remoteAudio_')) {
            const pId = audioElement.id.replace('remoteAudio_', '');
            const container = document.querySelector(`[id^="participant_${pId}"]`);
            if (container) {
                displayName = container.querySelector('.displayname')?.innerText || pId;
            } else {
                displayName = `User_${pId}`;
            }
        } else {
            const container = audioElement.closest('[id^="participant_"], .videocontainer, .largeVideoContainer');
            if (container) {
                const nameElem = container.querySelector('.displayname, .videocontainer span');
                if (nameElem && nameElem.innerText.trim()) {
                    displayName = nameElem.innerText.trim();
                }
            }
        }

        const track = stream.getAudioTracks()[0];
        const participantId = audioElement.id || track.id;

        let mediaRecorder;
        try {
            const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') 
                             ? 'audio/webm;codecs=opus' : 'audio/webm';
            mediaRecorder = new MediaRecorder(stream, { mimeType });
        } catch (e) {
            return;
        }
        
        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                const reader = new FileReader();
                reader.readAsArrayBuffer(event.data);
                reader.onloadend = () => {
                    const base64data = btoa(
                        new Uint8Array(reader.result)
                            .reduce((data, byte) => data + String.fromCharCode(byte), '')
                    );
                    window.handleAudioChunk(participantId, displayName, base64data);
                };
            }
        };

        try {
            mediaRecorder.start(3000); 
        } catch (e) {
            return;
        }
        
        recorders.set(audioElement, { mediaRecorder, displayName, participantId });
    }

    setInterval(() => {
        document.querySelectorAll('audio').forEach(startRecording);
    }, 2000);
})();
