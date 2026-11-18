const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

test('extension records both sources, restores history, retries API failure, exports and deletes', { timeout: 90000 }, async t => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'meeting-extension-'));
    const extension = path.resolve('jitsi-ai-extension');
    const context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium',
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`], viewport: { width: 1440, height: 1200 } });
    t.after(async () => { await context.close(); await fs.rm(profile, { recursive: true, force: true }); });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    await context.addInitScript(() => {
        const synthetic = async frequency => {
            const ctx = new AudioContext(); await ctx.resume();
            const osc = ctx.createOscillator(); osc.frequency.value = frequency;
            const out = ctx.createMediaStreamDestination(); osc.connect(out); osc.start();
            window.testContexts ||= []; window.testContexts.push(ctx);
            window.testStreams ||= []; window.testStreams.push(out.stream);
            return out.stream;
        };
        navigator.mediaDevices.getDisplayMedia = () => synthetic(440);
        navigator.mediaDevices.getUserMedia = () => synthetic(880);
    });
    const page = await context.newPage();
    const exceptions = [];
    page.on('pageerror', error => exceptions.push(error.message));
    await page.goto(`chrome-extension://${id}/dashboard.html`);
    await page.waitForFunction(() => typeof lockRelease === 'function');
    await page.locator('#title').fill('Командная встреча');
    await page.locator('#prepare').click();
    await page.waitForFunction(() => sources.length === 2 && !preparing);
    await page.locator('#consent').check();
    await page.locator('#start').click();
    await page.waitForFunction(() => Boolean(recorder) && !busy);
    await page.evaluate(() => Promise.all([...recorder.tracks.values()].map(entry => new Promise(resolve => {
        entry.recorder.addEventListener('dataavailable', resolve, { once: true });
    }))));
    await page.locator('#stop').click();
    await page.waitForFunction(() => !recorder && !busy && selected?.state === 'saved');
    assert.equal(await page.locator('#audioFiles button').count(), 2);
    assert.equal(await page.evaluate(() => window.testStreams.every(s => s.getTracks().every(t => t.readyState === 'ended'))), true);
    await page.reload(); await page.waitForFunction(() => typeof lockRelease === 'function' && Boolean(selected));
    assert.equal(await page.locator('#audioFiles button').count(), 2);
    await page.locator('#apiKey').fill('test-key');
    let transcriptionCalls = 0, summaryCalls = 0;
    await context.route('https://api.openai.com/v1/**', async route => {
        if (route.request().url().endsWith('/audio/transcriptions')) {
            transcriptionCalls++;
            await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ text: `Реплика ${transcriptionCalls}` }) });
        } else {
            summaryCalls++;
            await route.fulfill(summaryCalls === 1 ? { status: 429, body: '{}' }
                : { contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: 'Решение: проверить релиз.' } }] }) });
        }
    });
    await page.locator('#process').click();
    await page.waitForFunction(() => !busy && selected?.state === 'partial');
    assert.match(await page.locator('#report').innerText(), /Реплика 1/);
    await page.locator('#process').click();
    await page.waitForFunction(() => !busy && selected?.state === 'processed');
    assert.equal(transcriptionCalls, 2);
    assert.equal(summaryCalls, 2);
    assert.match(await page.locator('#report').innerText(), /проверить релиз/);
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#downloadReport').click();
    assert.match((await downloadPromise).suggestedFilename(), /\.md$/);
    if (process.env.UI_SCREENSHOT) await page.screenshot({ path: process.env.UI_SCREENSHOT, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    page.once('dialog', dialog => dialog.accept());
    const reload = page.waitForEvent('domcontentloaded');
    await page.locator('#delete').click();
    await reload;
    await page.waitForFunction(() => typeof lockRelease === 'function' && sessions.length === 0);
    assert.equal(await page.evaluate(() => MeetingStore.listSessions().then(x => x.length)), 0);
    assert.deepEqual(exceptions, []);
});

test('missing shared audio releases capture and prevents silent recording', { timeout: 60000 }, async t => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'meeting-noaudio-'));
    const extension = path.resolve('jitsi-ai-extension');
    const context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium',
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    t.after(async () => { await context.close(); await fs.rm(profile, { recursive: true, force: true }); });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await context.addInitScript(() => {
        navigator.mediaDevices.getDisplayMedia = async () => {
            const canvas = document.createElement('canvas');
            window.testVideo = canvas.captureStream();
            return window.testVideo;
        };
    });
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/dashboard.html`);
    await page.waitForFunction(() => typeof lockRelease === 'function');
    await page.locator('#prepare').click();
    await page.waitForFunction(() => !preparing && document.getElementById('status').classList.contains('error'));
    assert.match(await page.locator('#status').innerText(), /не передал аудио/);
    assert.equal(await page.locator('#start').isDisabled(), true);
    assert.equal(await page.evaluate(() => window.testVideo.getTracks()[0].readyState), 'ended');
});
