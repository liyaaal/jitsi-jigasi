const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { atomicJson, processRecordings } = require('./summary');
require('dotenv').config({ quiet: true });

function validateOptions(roomUrl, env = process.env) {
    let url;
    try { url = new URL(roomUrl); } catch { throw new Error('Укажите полный HTTPS-адрес комнаты Jitsi.'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Нужен HTTPS-адрес комнаты без логина и пароля в URL.');
    const duration = Number(env.RECORD_DURATION_MS || 1800000);
    if (!Number.isSafeInteger(duration) || duration < 1000 || duration > 86400000) throw new Error('RECORD_DURATION_MS: целое число от 1000 до 86400000.');
    return { url, duration };
}
async function runBot(roomUrl) {
    const { url, duration } = validateOptions(roomUrl);
    if (process.env.RECORD_ONLY !== 'true') new (require('./transcription'))();
    const dir = path.join(__dirname, 'recordings', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
    await fs.mkdir(dir, { recursive: true });
    const manifest = { id: path.basename(dir), createdAt: new Date().toISOString(), segments: [] };
    await atomicJson(path.join(dir, 'session.json'), manifest);
    let browser, page, timer, stopRequested;
    let writes = Promise.resolve();
    const stop = new Promise(resolve => { stopRequested = resolve; });
    const onSignal = () => stopRequested();
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    try {
        browser = await chromium.launch({ headless: process.env.HEADLESS !== 'false', args: [
            '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'
        ] });
        const context = await browser.newContext({ permissions: ['microphone'] });
        page = await context.newPage();
        await page.exposeFunction('saveAudioSegment', (base64, metadata) => {
            const write = writes.then(async () => {
                const file = `${randomUUID()}.webm`;
                await fs.writeFile(path.join(dir, file), Buffer.from(base64, 'base64'));
                manifest.segments.push({ ...metadata, file });
                await atomicJson(path.join(dir, 'session.json'), manifest);
            });
            writes = write.catch(() => {});
            return write;
        });
        const originalHash = url.hash.slice(1);
        url.hash = [originalHash, 'config.prejoinConfig.enabled=false', 'config.startWithAudioMuted=true',
            'config.startWithVideoMuted=true', 'userInfo.displayName="Meeting-Pro-Recorder"'].filter(Boolean).join('&');
        await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
        console.log('Ожидаю вход в Jitsi. Для лобби/авторизации используйте HEADLESS=false.');
        await Promise.race([
            page.waitForFunction(() => window.APP?.conference?._room?.isJoined?.(), null, { timeout: 120000 }),
            stop.then(() => { throw new Error('Остановлено до входа в комнату.'); })
        ]);
        await page.addScriptTag({ path: path.join(__dirname, 'jitsi-ai-extension/recorder.js') });
        await page.evaluate(() => {
            window.meetingRecorder = new MeetingRecorder({ scanDom: true, onSegment: async (blob, metadata) => {
                const base64 = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result.split(',')[1]);
                    reader.onerror = () => reject(reader.error);
                    reader.readAsDataURL(blob);
                });
                await window.saveAudioSegment(base64, metadata);
            } });
            window.meetingRecorder.start();
        });
        console.log(`Запись начата. Файлы: ${dir}. Ctrl+C — сохранить и завершить.`);
        timer = setTimeout(stopRequested, duration);
        page.once('close', stopRequested);
        await stop;
        if (page.isClosed()) throw new Error('Страница закрыта. Уже завершённые аудиоотрезки сохранены.');
        const errors = await page.evaluate(() => window.meetingRecorder.stop());
        if (errors.length) throw new Error(errors.join('\n'));
    } finally {
        clearTimeout(timer);
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
        await writes;
        await browser?.close();
    }
    if (!manifest.segments.length) throw new Error('Аудиопотоки не найдены. Проверьте вход в комнату и звук участников.');
    if (process.env.RECORD_ONLY !== 'true') {
        const { errors } = await processRecordings(dir);
        if (errors.length) throw new Error(`Аудио сохранено. ${errors.join('\n')}`);
    }
    console.log(`Готово: ${dir}`);
    return dir;
}
if (require.main === module) runBot(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { runBot, validateOptions };
