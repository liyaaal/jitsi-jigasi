const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { processRecordings } = require('../summary');
const { validateOptions } = require('../bot');
test('partial transcription survives summary failure and resumes only failed audio', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'meeting-test-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.writeFile(path.join(dir, 'session.json'), JSON.stringify({ segments: [
        { file: 'later.webm', displayName: 'B', startMs: 60000 },
        { file: 'earlier.webm', displayName: 'A', startMs: 0 }
    ] }));
    const calls = [];
    let failure = true;
    const transcriber = {
        transcribe: async file => { calls.push(path.basename(file)); if (failure && file.endsWith('later.webm')) throw new Error('offline'); return path.basename(file); },
        summarize: async () => { if (failure) throw new Error('limit'); return 'Result'; }
    };
    const first = await processRecordings(dir, transcriber);
    assert.equal(first.errors.length, 2);
    assert.match(await fs.readFile(path.join(dir, 'transcript.txt'), 'utf8'), /A: earlier/);
    failure = false;
    const second = await processRecordings(dir, transcriber);
    assert.deepEqual(calls, ['earlier.webm', 'later.webm', 'later.webm']);
    assert.equal(second.errors.length, 0);
    assert.ok(second.transcript.indexOf('A:') < second.transcript.indexOf('B:'));
});
test('manifest path traversal is rejected', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'meeting-test-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.writeFile(path.join(dir, 'session.json'), JSON.stringify({ segments: [{ file: '../secret.webm' }] }));
    await assert.rejects(processRecordings(dir, {}), /Недопустимое имя/);
});
test('bot refuses invalid room and duration instead of launching random room', () => {
    assert.throws(() => validateOptions());
    assert.throws(() => validateOptions('http://meet.example/room'));
    for (const value of ['0', '-1', 'NaN', '999999999999']) assert.throws(() => validateOptions('https://meet.example/room', { RECORD_DURATION_MS: value }));
    assert.equal(validateOptions('https://meet.example/room', { RECORD_DURATION_MS: '1000' }).duration, 1000);
});
