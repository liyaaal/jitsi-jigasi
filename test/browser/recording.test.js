const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const path = require('node:path');
test('real MediaRecorder rotates valid WebMs, deduplicates tracks, waits for last save', { timeout: 45000 }, async t => {
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.addScriptTag({ path: path.resolve('jitsi-ai-extension/recorder.js') });
    const result = await page.evaluate(async () => {
        const context = new AudioContext(); await context.resume();
        const oscillator = context.createOscillator(); const destination = context.createMediaStreamDestination();
        oscillator.connect(destination); oscillator.start();
        const blobs = [], metadata = [];
        let enough;
        const recorded = new Promise(resolve => { enough = resolve; });
        const recorder = new MeetingRecorder({ segmentMs: 1000, onSegment: async (blob, meta) => {
            await new Promise(r => setTimeout(r, 100)); blobs.push(blob); metadata.push(meta);
            if (blobs.length >= 2) enough();
        } });
        recorder.start(); recorder.addStream(destination.stream, 'Speaker');
        recorder.addStream(new MediaStream(destination.stream.getAudioTracks()), 'Duplicate');
        await recorded;
        const errors = await recorder.stop();
        const decoded = [];
        for (const blob of blobs) decoded.push((await context.decodeAudioData(await blob.arrayBuffer())).duration);
        const live = destination.stream.getAudioTracks()[0].readyState;
        oscillator.stop(); await context.close();
        return { decoded, metadata, errors, live };
    });
    assert.equal(result.errors.length, 0);
    assert.ok(result.decoded.length >= 2);
    assert.ok(result.decoded.every(duration => duration > 0));
    assert.ok(result.metadata.every(m => m.displayName === 'Speaker'));
    assert.equal(result.live, 'live');
    assert.ok(result.metadata.at(-1).endMs >= 900);
});
test('recorder surfaces storage failure without hanging on stop', async t => {
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage();
    await page.addScriptTag({ path: path.resolve('jitsi-ai-extension/recorder.js') });
    const errors = await page.evaluate(async () => {
        const context = new AudioContext(); await context.resume();
        const destination = context.createMediaStreamDestination();
        const oscillator = context.createOscillator(); oscillator.connect(destination); oscillator.start();
        const recorder = new MeetingRecorder({ onSegment: async () => { throw new Error('disk full'); } });
        recorder.start(); recorder.addStream(destination.stream, 'Speaker');
        await new Promise(resolve => recorder.tracks.values().next().value.recorder.addEventListener('dataavailable', resolve, { once: true }));
        const result = await recorder.stop(); oscillator.stop(); await context.close(); return result;
    });
    assert.deepEqual(errors, ['disk full']);
});
