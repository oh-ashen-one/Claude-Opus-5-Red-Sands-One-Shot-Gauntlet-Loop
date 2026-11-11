// Bias knee finder. On a frozen frame, sweeps the DEPTH bias (in metres of
// peter-panning) and reports what fraction of the frame the shadow term
// darkens. Recovering contact as the bias drops shows as a slow rise; acne
// flooding shows as a knee — a sudden jump in shadowed area.
import puppeteer from 'puppeteer';
import fs from 'node:fs';

const URL_BASE = process.env.GAME_URL || 'http://localhost:5810';
const poses = JSON.parse(fs.readFileSync(new URL('./poses.json', import.meta.url)));
const only = new Set((process.argv[2] || '01-sunset-ridge').split(','));
const METRES = (process.env.BIAS_M || '0.15,0.3,0.45,0.6,0.85,1.1,1.25,1.6').split(',').map(Number);
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
  const r = await page.evaluate((metres) => {
    const ctx = window.__GAME.ctx, sun = ctx.sky.sun, gl = ctx.renderer.domElement;
    window.requestAnimationFrame = () => 0;
    const cv = document.createElement('canvas'); cv.width = gl.width; cv.height = gl.height;
    const g2 = cv.getContext('2d', { willReadFrequently: true });
    const grab = () => { ctx.post.render(0); g2.drawImage(gl, 0, 0); return g2.getImageData(0, 0, cv.width, cv.height).data; };
    const sc = sun.shadow.camera, range = sc.far - sc.near;
    const b0 = sun.shadow.bias, i0 = sun.shadow.intensity;
    sun.shadow.intensity = 0; const B = grab(); sun.shadow.intensity = i0;
    const L = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    const rows = [];
    for (const m of metres) {
      sun.shadow.bias = -m / range;
      const A = grab();
      let sh = 0, n = 0;
      for (let i = 0; i < A.length; i += 4) { n++; if (L(B, i) - L(A, i) > 8) sh++; }
      rows.push({ m, shaded_pct: +(100 * sh / n).toFixed(2) });
    }
    sun.shadow.bias = b0;
    return { shipped_bias_m: +(-b0 * range).toFixed(3), rows };
  }, METRES);
  console.log(`${p.id}  (shipped depth bias ${r.shipped_bias_m} m)`);
  for (const row of r.rows) console.log(`   bias ${String(row.m).padStart(5)} m -> ${row.shaded_pct}% of frame shadowed`);
  await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForFunction('window.__GAME && window.__GAME.ready', { timeout: 45000 });
  await page.evaluate(() => { const h = window.__GAME.ctx.hud; if (h && h.skipIntro) h.skipIntro(true); });
  await sleep(300);
}
await browser.close();
