const fs = require('node:fs/promises');
const path = require('node:path');
const Transcriber = require('./transcription');
async function processRecordings(directory, transcriber) {
    if (!directory) throw new Error('Укажите каталог сессии: npm run transcribe -- recordings/<session>');
    const dir = path.resolve(directory);
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'session.json'), 'utf8'));
    transcriber ||= new Transcriber();
    const errors = [];
    let previous = {};
    try { previous = JSON.parse(await fs.readFile(path.join(dir, 'transcript.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const results = previous.results || {};
    const segments = [...manifest.segments].sort((a, b) => a.startMs - b.startMs || a.file.localeCompare(b.file));
    for (const segment of segments) {
        if (!/^[a-zA-Z0-9-]+\.webm$/.test(segment.file)) throw new Error('Недопустимое имя аудиофайла в session.json.');
        if (typeof results[segment.file] === 'string') continue;
        try { results[segment.file] = await transcriber.transcribe(path.join(dir, segment.file)); }
        catch (error) { errors.push(`${segment.displayName}: ${error.message}`); }
        await atomicJson(path.join(dir, 'transcript.json'), { results, errors });
    }
    const transcript = segments.filter(s => results[s.file]).map(s =>
        `[${Math.floor(s.startMs / 1000)} сек] ${String(s.displayName).replace(/[\r\n]/g, ' ')}: ${results[s.file]}`).join('\n\n');
    await fs.writeFile(path.join(dir, 'transcript.txt'), transcript, 'utf8');
    let overview = '';
    if (transcript) {
        try { overview = await transcriber.summarize(transcript); }
        catch (error) { errors.push(`Резюме: ${error.message}`); }
    }
    const report = `# Протокол встречи\n\nРаспознавание может содержать ошибки. Время обозначает начало аудиоотрезка, а не точную секунду реплики.\n\n## Итоги\n\n${overview || 'Резюме не создано.'}\n\n## Расшифровка\n\n${transcript || 'Нет распознанного текста.'}\n\n${errors.length ? '## Ошибки обработки\n\n' + errors.join('\n\n') : ''}`;
    await fs.writeFile(path.join(dir, 'summary.md'), report, 'utf8');
    await atomicJson(path.join(dir, 'transcript.json'), { results, errors });
    return { report, errors, transcript };
}
async function atomicJson(file, data) {
    await fs.writeFile(file + '.tmp', JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(file + '.tmp', file);
}
if (require.main === module) processRecordings(process.argv[2]).then(({ errors }) => {
    console.log('Отчёт и исходный транскрипт сохранены в каталоге сессии.');
    if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
}).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { processRecordings, atomicJson };
