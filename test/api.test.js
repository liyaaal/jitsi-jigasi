const { test } = require('node:test');
const assert = require('node:assert/strict');
const api = require('../jitsi-ai-extension/api');
const options = { apiKey: 'test-key', baseUrl: 'https://api.groq.com/openai/v1/' };
test('provider selection uses exact origin, rejects key leakage and invalid language', () => {
    assert.equal(api.settings(options).transcriptionModel, 'whisper-large-v3-turbo');
    assert.throws(() => api.settings({ ...options, baseUrl: 'https://api.groq.com.evil.test/openai/v1' }));
    assert.throws(() => api.settings({ apiKey: '' }));
    assert.throws(() => api.settings({ ...options, language: 'russian' }));
});
test('transcription sends independently playable blob and configurable language', async () => {
    const text = await api.transcribe(new Blob(['audio']), { ...options, language: 'kk' }, async (url, request) => {
        assert.equal(url, 'https://api.groq.com/openai/v1/audio/transcriptions');
        assert.equal(request.headers.Authorization, 'Bearer test-key');
        assert.equal(request.redirect, 'error');
        assert.equal(request.body.get('language'), 'kk');
        assert.equal(request.body.get('model'), 'whisper-large-v3-turbo');
        assert.equal(await request.body.get('file').text(), 'audio');
        return { ok: true, json: async () => ({ text: ' hello ' }) };
    });
    assert.equal(text, 'hello');
});
test('HTTP errors, invalid response and oversized files are explicit', async () => {
    await assert.rejects(api.transcribe(new Blob(['x']), options, async () => ({ ok: false, status: 429 })), /Лимит/);
    await assert.rejects(api.transcribe(new Blob(['x']), options, async () => ({ ok: true, json: async () => ({}) })), /не вернул текст/);
    await assert.rejects(api.transcribe(new Blob([]), options), /пуст/);
    await assert.rejects(api.transcribe(new Blob([new Uint8Array(25 * 1024 * 1024)]), options), /24 МиБ/);
});
test('summary uses selected provider and preserves source text', async () => {
    const result = await api.summarize('original', options, async (url, request) => {
        assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
        const body = JSON.parse(request.body);
        assert.equal(body.model, 'llama-3.3-70b-versatile');
        assert.equal(body.messages[1].content, 'original');
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'Summary' } }] }) };
    });
    assert.equal(result, 'Summary');
});
