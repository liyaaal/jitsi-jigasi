const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
require('dotenv').config();

class Transcriber {
    constructor() {
        this.apiKey = process.env.OPENAI_API_KEY;
        this.model = 'whisper-1';
    }

    async transcribe(filePath) {
        if (!this.apiKey) {
            return '';
        }

        const formData = new FormData();
        formData.append('file', fs.createReadStream(filePath));
        formData.append('model', this.model);

        try {
            const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
                headers: {
                    ...formData.getHeaders(),
                    'Authorization': `Bearer ${this.apiKey}`
                }
            });
            return response.data.text;
        } catch (error) {
            return '';
        }
    }
}

module.exports = Transcriber;
