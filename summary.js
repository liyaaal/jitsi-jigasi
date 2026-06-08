const fs = require('fs');
const path = require('path');
const Transcriber = require('./transcription');

async function processRecordings() {
    const recordingsDir = path.join(__dirname, 'recordings');
    if (!fs.existsSync(recordingsDir)) return;

    const transcriber = new Transcriber();
    const participants = fs.readdirSync(recordingsDir);
    const finalTranscript = [];

    for (const participantId of participants) {
        const participantPath = path.join(recordingsDir, participantId);
        if (fs.lstatSync(participantPath).isDirectory()) {
            const audioFile = path.join(participantPath, 'audio.webm');
            if (fs.existsSync(audioFile)) {
                let displayName = participantId;
                const metadataPath = path.join(participantPath, 'metadata.json');
                if (fs.existsSync(metadataPath)) {
                    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
                    displayName = metadata.displayName;
                }

                const text = await transcriber.transcribe(audioFile);
                finalTranscript.push({
                    displayName,
                    text
                });
            }
        }
    }

    let fullTranscript = '';
    finalTranscript.forEach(item => {
        fullTranscript += `[${item.displayName}]: ${item.text}\n`;
    });

    let summaryText = '';
    if (fullTranscript.trim()) {
        summaryText = await generateAiSummary(fullTranscript);
    }

    let report = `# Meeting Summary\n\n`;
    report += `## AI Overview\n${summaryText}\n\n`;
    report += `## Full Transcript\n`;
    
    if (finalTranscript.length === 0) {
        report += 'No speech detected.\n';
    } else {
        finalTranscript.forEach(item => {
            report += `### ${item.displayName}\n${item.text}\n\n`;
        });
    }

    fs.writeFileSync(path.join(__dirname, 'summary.md'), report);
}

async function generateAiSummary(transcript) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return '';

    try {
        const axios = require('axios');
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: 'You are a helpful assistant that summarizes meeting transcripts.' },
                { role: 'user', content: `Please summarize the following meeting:\n\n${transcript}` }
            ]
        }, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        });
        return response.data.choices[0].message.content;
    } catch (error) {
        return '';
    }
}

module.exports = { processRecordings };
