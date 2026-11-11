// Runs one pose N times under shoot.mjs conditions and reports mean luma plus
// the renderer/composer sizing at capture time, to catch an intermittent black.
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';

const URL_BASE = process.env.GAME_URL || 'http://localhost:5811';
const OUT = process.env.SHOT_DIR || 'shots/flake';
const W = +(process.env.SHOT_W || 1920), H = +(process.env.SHOT_H || 1080);
const N = +(process.env.RUNS || 5);
const poses = JSON.parse(fs.readFileSync(new URL('./tools/poses.json', import.meta.url)));
const want = process.argv[2] || '01-sunset-ridge';
const p = poses.find(q => q.id === want);
fs.mkdirSync(OUT, { recursive: true });
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

for (let run = 0; run < N; run++) {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    userDataDir: '/tmp/gauntlet-chrome-sky-flake',
    args: [
      '--use-angle=metal', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization', '--enable-webgl', '--use-gl=angle',
      `--window-size=${W},${H}`, '--hide-scrollbars', '--mute-audio',
      '--no-sandbox', '--disable-dev-shm-usage',
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  await page.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForFunction('window.__GAME && window.__GAME.ready', { timeout: 45000 });
  await page.evaluate((pp) => {
    window.__GAME.setTime(pp.time);
    window.__GAME.teleport(pp.x, pp.z, pp.face);
    window.__GAME.release();
  }, p);
  await new Promise(r => setTimeout(r, (p.settle ?? 2) * 1000));

  const info = await page.evaluate(() => {
    const c = window.__GAME.ctx, r = c.renderer, cv = r.domElement;
    const gl = r.getContext();
    const cm = c.post.composer;
    return {
      inner: [innerWidth, innerHeight],
      canvas: [cv.width, cv.height],
      css: [cv.clientWidth, cv.clientHeight],
      db: [gl.drawingBufferWidth, gl.drawingBufferHeight],
      pr: r.getPixelRatio(),
      rt1: [cm.renderTarget1.width, cm.renderTarget1.height],
      rt2: [cm.renderTarget2.width, cm.renderTarget2.height],
      bloomRes: [c.post.bloom.resolution.x, c.post.bloom.resolution.y],
      vp: r.getViewport(new c.THREE.Vector4()).toArray(),
      camAspect: c.camera.aspect,
    };
  });
  const file = path.join(OUT, `${want}-run${run}.png`);
  await page.screenshot({ path: file });
  console.log('run', run, JSON.stringify(info));
  await browser.close();
}
