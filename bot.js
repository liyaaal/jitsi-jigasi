const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

async function runBot(roomUrl) {
    const browser = await chromium.launch({
        headless: true,
        args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--allow-file-access-from-files',
            '--disable-gesture-requirement-for-media-playback'
        ]
    });

    const context = await browser.newContext({
        permissions: ['microphone'],
    });

    const page = await context.newPage();

    page.on('console', msg => console.log(`[LOG] ${msg.text()}`));

    const url = new URL(roomUrl);
    url.hash = 'config.prejoinPageEnabled=false&userInfo.displayName="AI-Recorder"';
    
    console.log(`URL: ${url.toString()}`);
    await page.goto(url.toString(), { waitUntil: 'networkidle' });

    try {
        const joinSelectors = [
            'button:has-text("Join meeting")',
            'button:has-text("Присоединиться")',
            'button[data-testid="prejoin.joinMeeting"]',
            '.prejoin-content-button',
            '[aria-label="Join meeting"]',
            '[aria-label="Присоединиться к встрече"]'
        ];

        for (const selector of joinSelectors) {
            const btn = page.locator(selector).first();
            if (await btn.isVisible({ timeout: 2000 })) {
                await btn.click();
                break;
            }
        }
    } catch (e) {}

    await page.waitForSelector('.videocontainer, #largeVideo', { timeout: 30000 });
    await new Promise(resolve => setTimeout(resolve, 5000));

    const injectionScript = fs.readFileSync(path.join(__dirname, 'injection.js'), 'utf8');
    await page.evaluate(injectionScript);

    await page.exposeFunction('handleAudioChunk', async (participantId, displayName, base64Data) => {
        const dir = path.join(__dirname, 'recordings', participantId);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ participantId, displayName }));
        }
        const buffer = Buffer.from(base64Data, 'base64');
        fs.appendFileSync(path.join(dir, 'audio.webm'), buffer);
    });

    const duration = process.env.RECORD_DURATION_MS ? parseInt(process.env.RECORD_DURATION_MS) : 30000;
    
    let timer;
    const waitPromise = new Promise(resolve => {
        timer = setTimeout(resolve, duration);
    });

    process.on('SIGINT', async () => {
        clearTimeout(timer);
        await browser.close();
        process.exit(0);
    });

    await waitPromise;
    await browser.close();
    
    const { processRecordings } = require('./summary');
    await processRecordings();
}

const targetRoom = process.argv[2] || 'https://meet.jit.si/Room' + Math.random().toString(36).substring(7);
runBot(targetRoom).catch(console.error);
