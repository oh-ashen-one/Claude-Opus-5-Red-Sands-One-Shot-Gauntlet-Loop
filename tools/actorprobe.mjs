// Actor-shadow contribution probe. Freezes rAF, drives frames by hand,
// grabs A / B / A with ONLY the actor meshes' castShadow toggled.
import puppeteer from 'puppeteer';
import fs from 'node:fs';

const URL_BASE = process.env.GAME_URL || 'http://localhost:5861';
const TAG = process.argv[2] || 'actor';
const poses = JSON.parse(fs.readFileSync(new URL('./poses.json', import.meta.url)));
const only = process.argv[3] ? new Set(process.argv[3].split(',')) : new Set(['01-sunset-ridge']);
const W = +(process.env.SHOT_W || 1920), H = +(process.env.SHOT_H || 1080);
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({
  headless: true,
  executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
  userDataDir: process.env.CHROME_PROFILE || '/tmp/gauntlet-chrome-profile-actor',
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
  if (!only.has(p.id)) continue;
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
    const THREE = window.__GAME.THREE || ctx.THREE;
    const gl = ctx.renderer.domElement;
    window.requestAnimationFrame = () => 0;   // FREEZE

    // ---- find actor roots ------------------------------------------------
    const scene = ctx.scene;
    const roots = [];
    const seen = new Set();
    const push = (o, why) => { if (o && !seen.has(o.uuid)) { seen.add(o.uuid); roots.push({ o, why }); } };
    for (const k of ['player', 'samurai', 'horse', 'mount', 'actor']) {
      const c = ctx[k];
      if (c) push(c.root || c.group || c.object3D || c.mesh || c, 'ctx.' + k);
    }
    scene.traverse(o => {
      const n = (o.name || '').toLowerCase();
      if (/^(player|samurai|horse)$/.test(n)) push(o, 'name:' + o.name);
    });

    // collect meshes under those roots
    const meshes = [];
    for (const r of roots) r.o.traverse(o => { if (o.isMesh || o.isSkinnedMesh || o.isInstancedMesh) meshes.push(o); });
    const uniq = [...new Set(meshes)];

    const inv = {
      roots: roots.map(r => ({ why: r.why, name: r.o.name, type: r.o.type, pos: r.o.position.toArray().map(v => +v.toFixed(2)) })),
      mesh_count: uniq.length,
      casters: uniq.filter(m => m.castShadow).length,
      skinned: uniq.filter(m => m.isSkinnedMesh).length,
      instanced: uniq.filter(m => m.isInstancedMesh).length,
      with_customDepth: uniq.filter(m => m.customDepthMaterial).length,
      visible: uniq.filter(m => m.visible).length,
      sample: uniq.slice(0, 12).map(m => ({
        name: m.name, type: m.type, cast: m.castShadow, vis: m.visible,
        mat: m.material && (Array.isArray(m.material) ? m.material.map(x=>x.type).join('|') : m.material.type),
        alphaTest: m.material && m.material.alphaTest,
        transparent: m.material && m.material.transparent,
        side: m.material && m.material.side,
        skinning: !!m.isSkinnedMesh,
      })),
    };

    // ---- frame grabber ---------------------------------------------------
    const cv = document.createElement('canvas');
    cv.width = gl.width; cv.height = gl.height;
    const g2 = cv.getContext('2d', { willReadFrequently: true });
    const grab = () => { ctx.post.render(0); g2.drawImage(gl, 0, 0); return g2.getImageData(0, 0, cv.width, cv.height).data; };

    const diff = (A, B) => {
      let moved = 0, strong = 0, sum = 0, max = 0;
      let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      let sx0 = 1e9, sy0 = 1e9, sx1 = -1, sy1 = -1;
      const w = cv.width;
      for (let i = 0, px = 0; i < A.length; i += 4, px++) {
        const la = 0.2126*A[i] + 0.7152*A[i+1] + 0.0722*A[i+2];
        const lb = 0.2126*B[i] + 0.7152*B[i+1] + 0.0722*B[i+2];
        const d = Math.abs(la - lb);
        sum += d; if (d > max) max = d;
        if (d > 2) {
          moved++;
          const x = px % w, y = (px / w) | 0;
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
          if (d > 12) { strong++;
            if (x < sx0) sx0 = x; if (x > sx1) sx1 = x;
            if (y < sy0) sy0 = y; if (y > sy1) sy1 = y; }
        }
      }
      const n = A.length / 4;
      return { pct_moved: +(100*moved/n).toFixed(3), pct_strong: +(100*strong/n).toFixed(3),
        mean_abs: +(sum/n).toFixed(4), max: +max.toFixed(1),
        bbox: x1 < 0 ? null : [x0, y0, x1, y1],
        bbox_strong: sx1 < 0 ? null : [sx0, sy0, sx1, sy1] };
    };

    const A1 = grab();
    const prev = uniq.map(m => m.castShadow);
    uniq.forEach(m => { m.castShadow = false; });
    const B = grab();
    uniq.forEach((m, i) => { m.castShadow = prev[i]; });
    const A2 = grab();

    const sun = ctx.sky.sun, sc = sun.shadow.camera;
    return { inv,
      effect_A1_B: diff(A1, B),
      noise_A1_A2: diff(A1, A2),
      shadow: { bias: sun.shadow.bias, normalBias: +sun.shadow.normalBias.toFixed(4),
        depth_bias_m: +(-sun.shadow.bias * (sc.far - sc.near)).toFixed(3),
        box: [+(sc.right-sc.left).toFixed(0), +(sc.top-sc.bottom).toFixed(0), +(sc.far-sc.near).toFixed(0)],
        texel_cm: [+(100*(sc.right-sc.left)/sun.shadow.mapSize.x).toFixed(1), +(100*(sc.top-sc.bottom)/sun.shadow.mapSize.y).toFixed(1)],
        mapSize: sun.shadow.mapSize.toArray(), radius: +sun.shadow.radius.toFixed(2) },
    };
  });
  out.push({ id: p.id, ...r });
  console.log(`\n=== ${p.id} ===`);
  console.log('inventory:', JSON.stringify(r.inv, null, 1));
  console.log('EFFECT  (actors cast ON vs OFF):', JSON.stringify(r.effect_A1_B));
  console.log('NOISE   (A vs A, same state)   :', JSON.stringify(r.noise_A1_A2));
  console.log('shadow  :', JSON.stringify(r.shadow));
  await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForFunction('window.__GAME && window.__GAME.ready', { timeout: 45000 });
  await page.evaluate(() => { const h = window.__GAME.ctx.hud; if (h && h.skipIntro) h.skipIntro(true); });
  await sleep(300);
}
fs.writeFileSync(`/tmp/actorprobe-${TAG}.json`, JSON.stringify({ when: new Date().toISOString(), out, errors }, null, 2));
if (errors.length) console.error('PAGE ERRORS:\n' + errors.slice(0, 10).join('\n'));
await browser.close();
