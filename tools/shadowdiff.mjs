// Freezes a pose and renders it TWICE — once as shipped, once with
// sun.shadow.intensity forced to 0 — with nothing else changed, then diffs the
// two framebuffers. If the shadow map contributes nothing the two images are
// byte-identical. If the whole frame is one umbra, ~100% of pixels move.
// Usage: GAME_URL=http://localhost:5821 node tools/shadowdiff.mjs [tag] [pose,pose]
import puppeteer from 'puppeteer';
import fs from 'node:fs';

const URL_BASE = process.env.GAME_URL || 'http://localhost:5810';
const TAG = process.argv[2] || 'diff';
const poses = JSON.parse(fs.readFileSync(new URL('./poses.json', import.meta.url)));
const only = process.argv[3] ? new Set(process.argv[3].split(',')) : null;
const W = +(process.env.SHOT_W || 1920), H = +(process.env.SHOT_H || 1080);

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({
  headless: true,
  executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
  userDataDir: process.env.CHROME_PROFILE || '/tmp/gauntlet-chrome-profile-shadow',
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
    '--enable-webgl', '--use-gl=angle', `--window-size=${W},${H}`, '--hide-scrollbars',
    '--mute-audio', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForFunction('window.__GAME && window.__GAME.ready', { timeout: 45000 });
await page.evaluate(() => { const h = window.__GAME.ctx.hud; if (h && h.skipIntro) h.skipIntro(true); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(400);

const out = [];
for (const p of poses) {
  if (only && !only.has(p.id)) continue;
  await page.evaluate((pp) => {
    window.__GAME.teleport(pp.x, pp.z, pp.face);
    window.__GAME.setTime(pp.time);
    window.__GAME.release();
    const h = window.__GAME.ctx.hud; if (h && h.skipIntro) h.skipIntro(true);
  }, p);
  await sleep((p.settle ?? 2) * 1000);
  await page.evaluate((pp) => window.__GAME.setTime(pp.time), p);
  await sleep(400);
  const r = await page.evaluate(() => {
    const ctx = window.__GAME.ctx;
    const sun = ctx.sky.sun, gl = ctx.renderer.domElement;
    // Halt the rAF loop so nothing animates between the two renders.
    window.requestAnimationFrame = () => 0;
    const cv = document.createElement('canvas');
    cv.width = gl.width; cv.height = gl.height;
    const g2 = cv.getContext('2d', { willReadFrequently: true });
    const grab = () => {
      ctx.post.render(0);
      g2.drawImage(gl, 0, 0);
      return g2.getImageData(0, 0, cv.width, cv.height).data;
    };
    const before = sun.shadow.intensity;
    const A = grab();
    sun.shadow.intensity = 0;
    const B = grab();
    sun.shadow.intensity = before;
    let n = 0, sum = 0, max = 0, moved = 0, strong = 0;
    for (let i = 0; i < A.length; i += 4) {
      const la = 0.2126 * A[i] + 0.7152 * A[i + 1] + 0.0722 * A[i + 2];
      const lb = 0.2126 * B[i] + 0.7152 * B[i + 1] + 0.0722 * B[i + 2];
      const d = Math.abs(la - lb);
      n++; sum += d; if (d > max) max = d;
      if (d > 2) moved++;
      if (d > 12) strong++;
    }
    const sc = sun.shadow.camera;
    return {
      pixels: n, mean_abs_delta: +(sum / n).toFixed(3), max_delta: +max.toFixed(1),
      pct_moved: +(100 * moved / n).toFixed(2), pct_strong: +(100 * strong / n).toFixed(2),
      castShadow: sun.castShadow, shadow_intensity: before,
      box: [+(sc.right - sc.left).toFixed(0), +(sc.top - sc.bottom).toFixed(0), +(sc.far - sc.near).toFixed(0)],
      texel_cm: [+(100 * (sc.right - sc.left) / sun.shadow.mapSize.x).toFixed(1), +(100 * (sc.top - sc.bottom) / sun.shadow.mapSize.y).toFixed(1)],
      bias: sun.shadow.bias, normalBias: +sun.shadow.normalBias.toFixed(3),
      depth_bias_m: +(-sun.shadow.bias * (sc.far - sc.near)).toFixed(3),
    };
  });
  out.push({ id: p.id, ...r });
  console.log(`${p.id.padEnd(16)} moved=${r.pct_moved}%  strong=${r.pct_strong}%  mean|d|=${r.mean_abs_delta}  max=${r.max_delta}  box=${r.box.join('x')}  texel=${r.texel_cm.join('x')}cm  depthbias=${r.depth_bias_m}m nb=${r.normalBias}`);
  // the loop is dead in this tab now; reload for the next pose
  await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForFunction('window.__GAME && window.__GAME.ready', { timeout: 45000 });
  await page.evaluate(() => { const h = window.__GAME.ctx.hud; if (h && h.skipIntro) h.skipIntro(true); });
  await sleep(300);
}
fs.writeFileSync(`/tmp/shadowdiff-${TAG}.json`, JSON.stringify({ when: new Date().toISOString(), out, errors }, null, 2));
if (errors.length) console.error('PAGE ERRORS:\n' + errors.slice(0, 10).join('\n'));
await browser.close();
