// Sky-only captures: hide the world, sweep time, look at the dome itself.
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
const OUT = process.env.SHOT_DIR || 'shots/dome';
const W = 1600, H = 900;
fs.mkdirSync(OUT, { recursive: true });
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({
  headless: true, executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
  userDataDir: '/tmp/gauntlet-chrome-sky-dome',
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-webgl', '--use-gl=angle',
    `--window-size=${W},${H}`, '--hide-scrollbars', '--no-sandbox', '--mute-audio', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
page.on('pageerror', e => console.error('PAGEERROR', e.message));
await page.goto(process.env.GAME_URL || 'http://localhost:5811', { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForFunction('window.__GAME && window.__GAME.ready', { timeout: 45000 });
await page.evaluate(() => { window.__GAME.teleport(-536, 334, -9); });
await new Promise(r => setTimeout(r, 2500));
await page.evaluate(() => {
  const c = window.__GAME.ctx;
  c.scene.traverse(o => {
    if ((o.isMesh || o.isPoints || o.isSprite) && o.name !== 'skydome' && !o.isPoints) o.visible = false;
  });
  c.hudHidden = true;
  const el = document.querySelector('#hud, .hud, header, #title'); if (el) el.style.display = 'none';
});
// t -> which way the low sun sits relative to the fixed -Z view direction.
const times = [
  ['a-sun-ahead-11deg', 0.270],
  ['b-sun-ahead-2deg', 0.256],
  ['c-sun-behind-14deg', 0.726],
  ['d-dusk-behind', 0.752],
  ['e-blue-hour', 0.768],
  ['f-night', 0.020],
  ['g-noon', 0.500],
];
for (const [tag, t] of times) {
  await page.evaluate((tt) => { window.__GAME.setTime(tt); }, t);
  await new Promise(r => setTimeout(r, 900));
  const alt = await page.evaluate(() => +window.__GAME.ctx.tod.sunAltitude.toFixed(1));
  await page.screenshot({ path: path.join(OUT, `${tag}.png`) });
  console.log(tag, 'sunAlt=', alt);
}
await browser.close();
