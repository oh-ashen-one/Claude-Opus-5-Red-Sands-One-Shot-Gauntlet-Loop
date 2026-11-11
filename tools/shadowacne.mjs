// Is the darkening real occlusion, or acne? Freezes a pose and renders it
// three times: as shipped, with the depth bias TRIPLED, and with the shadow
// term off. Acne dies under a tripled bias; a real caster's shadow does not.
// Reports what fraction of the shadowed pixels survive the tripled bias.
import puppeteer from 'puppeteer';
import fs from 'node:fs';

const URL_BASE = process.env.GAME_URL || 'http://localhost:5810';
const poses = JSON.parse(fs.readFileSync(new URL('./poses.json', import.meta.url)));
const only = new Set((process.argv[2] || '06-forest').split(','));
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({
  headless: true,
  executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
  userDataDir: process.env.CHROME_PROFILE || '/tmp/gauntlet-chrome-profile-shadow',
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-webgl', '--use-gl=angle',
    '--window-size=1920,1080', '--hide-scrollbars', '--mute-audio', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080 });
await page.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForFunction('window.__GAME && window.__GAME.ready', { timeout: 45000 });
await page.evaluate(() => { const h = window.__GAME.ctx.hud; if (h && h.skipIntro) h.skipIntro(true); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (const p of poses) {
  if (!only.has(p.id)) continue;
  await page.evaluate((pp) => {
    window.__GAME.teleport(pp.x, pp.z, pp.face);
    window.__GAME.setTime(pp.time); window.__GAME.release();
    const h = window.__GAME.ctx.hud; if (h && h.skipIntro) h.skipIntro(true);
  }, p);
  await sleep((p.settle ?? 2) * 1000);
  await page.evaluate((pp) => window.__GAME.setTime(pp.time), p);
  await sleep(400);
  const r = await page.evaluate(() => {
    const ctx = window.__GAME.ctx, sun = ctx.sky.sun, gl = ctx.renderer.domElement;
    window.requestAnimationFrame = () => 0;
    const cv = document.createElement('canvas'); cv.width = gl.width; cv.height = gl.height;
    const g2 = cv.getContext('2d', { willReadFrequently: true });
    const grab = () => { ctx.post.render(0); g2.drawImage(gl, 0, 0); return g2.getImageData(0, 0, cv.width, cv.height).data; };
    const b0 = sun.shadow.bias;
    const A = grab();                                   // as shipped
    sun.shadow.bias = b0 * 3; const C = grab();         // 3x depth bias
    sun.shadow.bias = b0;
    const i0 = sun.shadow.intensity; sun.shadow.intensity = 0;
    const B = grab();                                   // no shadow at all
    sun.shadow.intensity = i0; sun.shadow.bias = b0;
    const L = d => (i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    const la = L(A), lb = L(B), lc = L(C);
    let shaded = 0, survives = 0;
    for (let i = 0; i < A.length; i += 4) {
      if (lb(i) - la(i) > 8) { shaded++; if (lb(i) - lc(i) > 8) survives++; }
    }
    return { shaded_pct: +(100 * shaded / (A.length / 4)).toFixed(2), survives_3x_bias_pct: +(100 * survives / Math.max(1, shaded)).toFixed(1), bias: b0 };
  });
  console.log(`${p.id}: shadowed=${r.shaded_pct}% of frame; ${r.survives_3x_bias_pct}% of it SURVIVES a 3x depth bias (acne would die)`);
  await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForFunction('window.__GAME && window.__GAME.ready', { timeout: 45000 });
  await page.evaluate(() => { const h = window.__GAME.ctx.hud; if (h && h.skipIntro) h.skipIntro(true); });
  await sleep(300);
}
await browser.close();
