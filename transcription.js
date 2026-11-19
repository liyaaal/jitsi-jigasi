const fs = require('node:fs/promises');
const api = require('./jitsi-ai-extension/api');
require('dotenv').config({ quiet: true });
class Transcriber {
    constructor(options = {}) {
        this.options = api.settings({ apiKey: process.env.OPENAI_API_KEY,
            baseUrl: process.env.OPENAI_BASE_URL, transcriptionModel: process.env.TRANSCRIPTION_MODEL,
            summaryModel: process.env.SUMMARY_MODEL, language: process.env.TRANSCRIPTION_LANGUAGE, ...options });
    }
    async transcribe(filePath) {
        if ((await fs.stat(filePath)).size > 24 * 1024 * 1024) throw new Error('Файл больше 24 МиБ. Разделите аудио перед отправкой.');
        return api.transcribe(new Blob([await fs.readFile(filePath)], { type: 'audio/webm' }), this.options);
    }
    summarize(text) { return api.summarize(text, this.options); }
}
module.exports = Transcriber;
