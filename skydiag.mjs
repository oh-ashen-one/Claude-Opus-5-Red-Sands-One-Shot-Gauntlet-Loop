// Replicates tools/shoot.mjs launch conditions exactly, then bisects.
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';

const URL_BASE = process.env.GAME_URL || 'http://localhost:5811';
const OUT = process.env.SHOT_DIR || 'shots/diag';
const W = +(process.env.SHOT_W || 1920), H = +(process.env.SHOT_H || 1080);
const MODE = process.env.DIAG_MODE || 'baseline';
const poses = JSON.parse(fs.readFileSync(new URL('./tools/poses.json', import.meta.url)));
const want = process.argv[2] || '01-sunset-ridge';
const p = poses.find(q => q.id === want);
fs.mkdirSync(OUT, { recursive: true });

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({
  headless: true,
  executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
  userDataDir: '/tmp/gauntlet-chrome-sky-diag',
  args: [
    '--use-angle=metal', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization', '--enable-webgl', '--use-gl=angle',
    `--window-size=${W},${H}`, '--hide-scrollbars', '--mute-audio',
    '--no-sandbox', '--disable-dev-shm-usage',
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
page.on('pageerror', e => console.error('PAGEERROR', e.message));
await page.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForFunction('window.__GAME && window.__GAME.ready', { timeout: 45000 });

// Apply the mode BEFORE anything is ever composited.
await page.evaluate((mode) => {
  const c = window.__GAME.ctx;
  if (mode === 'nobloom') c.post.bloom.enabled = false;
  if (mode === 'nodome') c.scene.getObjectByName('skydome').visible = false;
  if (mode === 'clampdome') {
    const d = c.scene.getObjectByName('skydome');
    d.material.fragmentShader = d.material.fragmentShader.replace(
      'gl_FragColor = vec4(max(col, 0.0), 1.0);',
      'col = clamp(col, 0.0, 4.0); if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0, 1.0, 0.0); gl_FragColor = vec4(col, 1.0);');
    d.material.needsUpdate = true;
  }
  if (mode === 'nodisc') {
    const d = c.scene.getObjectByName('skydome');
    d.material.uniforms.uDiscHDR.value = 0.0;
  }
  if (mode === 'nostars') c.sky.stars.visible = false;
}, MODE);

await page.evaluate((pp) => {
  window.__GAME.setTime(pp.time);
  window.__GAME.teleport(pp.x, pp.z, pp.face);
  window.__GAME.release();
}, p);
await new Promise(r => setTimeout(r, (p.settle ?? 2) * 1000));

// Read the composer's own buffer before the grade pass touches it.
const probe = await page.evaluate(() => {
  const c = window.__GAME.ctx;
  const r = c.renderer;
  const rt = c.post.composer.readBuffer;
  const buf = new Float32Array(4 * 9);
  const out = [];
  const pts = [[0.1, 0.5], [0.5, 0.5], [0.9, 0.5], [0.5, 0.9], [0.5, 0.1]];
  for (const [fx, fy] of pts) {
    const b = new Float32Array(4);
    try {
      r.readRenderTargetPixels(rt, Math.floor(fx * rt.width), Math.floor(fy * rt.height), 1, 1, b);
      out.push([fx, fy, [...b].map(v => +v.toFixed(4))]);
    } catch (e) { out.push([fx, fy, 'ERR ' + e.message]); }
  }
  void buf;
  return { rtType: rt.texture.type, out, exposure: r.toneMappingExposure };
});
console.log('MODE=' + MODE, JSON.stringify(probe));

await page.screenshot({ path: path.join(OUT, `${want}-${MODE}.png`) });
console.log('shot', MODE);
await browser.close();
