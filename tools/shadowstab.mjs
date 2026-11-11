// Temporal stability of the shadow box while the player MOVES and TURNS.
// A box that changes size changes texel size, and a shadow that changes
// sharpness between frames pulses. Records the box every frame for a few
// seconds of running and of spinning, and reports how often it resized.
import puppeteer from 'puppeteer';
import fs from 'node:fs';

const URL_BASE = process.env.GAME_URL || 'http://localhost:5810';
const poses = JSON.parse(fs.readFileSync(new URL('./poses.json', import.meta.url)));
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({
  headless: true,
  executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
  userDataDir: process.env.CHROME_PROFILE || '/tmp/gauntlet-chrome-profile-shadow',
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-webgl', '--use-gl=angle',
    '--window-size=1280,720', '--hide-scrollbars', '--mute-audio', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForFunction('window.__GAME && window.__GAME.ready', { timeout: 45000 });
await page.evaluate(() => { const h = window.__GAME.ctx.hud; if (h && h.skipIntro) h.skipIntro(true); });
const sleep = ms => new Promise(r => setTimeout(r, ms));

for (const id of (process.env.STAB_POSES || '05-summit,06-forest,07-run').split(',')) {
  const p = poses.find(q => q.id === id);
  await page.evaluate((pp) => {
    window.__GAME.teleport(pp.x, pp.z, pp.face);
    window.__GAME.setTime(pp.time); window.__GAME.release();
  }, p);
  await sleep(1500);
  // sample the box every frame while the player runs forward AND the camera turns
  const r = await page.evaluate(async () => {
    const ctx = window.__GAME.ctx;
    const sc = ctx.sky.sun.shadow.camera;
    const rec = [];
    window.__GAME.drive({ move: { x: 0.6, y: 1 }, sprint: true });
    await new Promise(res => {
      let n = 0;
      const tick = () => {
        rec.push([+(sc.right - sc.left).toFixed(1), +(sc.top - sc.bottom).toFixed(1)]);
        if (++n < 150) requestAnimationFrame(tick); else res();
      };
      requestAnimationFrame(tick);
    });
    window.__GAME.release();
    let resized = 0, maxJump = 0;
    for (let i = 1; i < rec.length; i++) {
      const dw = Math.abs(rec[i][0] - rec[i - 1][0]), dh = Math.abs(rec[i][1] - rec[i - 1][1]);
      if (dw > 0.5 || dh > 0.5) resized++;
      maxJump = Math.max(maxJump, dw, dh);
    }
    const w = rec.map(r => r[0]), h = rec.map(r => r[1]);
    return {
      frames: rec.length, resized_frames: resized, max_jump_m: +maxJump.toFixed(1),
      w_min: Math.min(...w), w_max: Math.max(...w), h_min: Math.min(...h), h_max: Math.max(...h),
    };
  });
  console.log(`${id.padEnd(12)} frames=${r.frames} resized=${r.resized_frames} maxjump=${r.max_jump_m}m  W ${r.w_min}..${r.w_max}  H ${r.h_min}..${r.h_max}`);
}
if (errors.length) console.error('PAGE ERRORS:\n' + errors.slice(0, 10).join('\n'));
await browser.close();
