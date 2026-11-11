// Names the failing request behind the bare "Failed to load resource" line that
// shoot.mjs records. A permanent 404 in report.json makes the errors-must-be-empty
// round gate meaningless, so the URL has to be identifiable.
import puppeteer from 'puppeteer';
import fs from 'node:fs';

const URL_BASE = process.env.GAME_URL || 'http://localhost:5810';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({
  headless: true,
  executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
  userDataDir: '/tmp/gauntlet-chrome-404',
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio',
         '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();

const bad = [];
page.on('requestfailed', r => bad.push(`REQUESTFAILED ${r.failure()?.errorText}  ${r.url()}`));
page.on('response', r => { if (r.status() >= 400) bad.push(`HTTP ${r.status()}  ${r.url()}`); });
page.on('pageerror', e => bad.push(`PAGEERROR ${e.message}`));

await page.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 60000 });
try {
  await page.waitForFunction('window.__GAME && window.__GAME.ready', { timeout: 45000 });
  console.log('game ready');
} catch {
  console.log('game did NOT become ready');
}
// Let deferred/lazy fetches land before judging.
await new Promise(r => setTimeout(r, 4000));

console.log(bad.length ? bad.join('\n') : 'no failing requests');
await browser.close();
