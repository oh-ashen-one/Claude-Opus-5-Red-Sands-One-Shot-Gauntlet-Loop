// Shadow-frustum coverage sweep.
//
// For five vantages x twelve camera facings, projects the ground the camera can
// actually see through the LIVE shadow camera using three's own
// light.shadow.matrix and three's own acceptance test
// (getShadow: frustumTest = all(coord.xy in [0,1]) && coord.z <= 1.0; anything
// failing it is returned UNCONDITIONALLY LIT).
//
// Reports, per (vantage, facing):
//   player_in     is the player inside the frustum
//   near          fraction of visible ground cells within NEAR m that are inside
//   mid           ... within MID m
//   far           ... within FAR m
// Usage: GAME_URL=http://localhost:5821 node tools/shadowsweep.mjs [tag]
import puppeteer from 'puppeteer';
import fs from 'node:fs';

const URL_BASE = process.env.GAME_URL || 'http://localhost:5810';
const TAG = process.argv[2] || 'sweep';
const poses = JSON.parse(fs.readFileSync(new URL('./poses.json', import.meta.url)));
const WANT = (process.env.VANTAGES || '01-sunset-ridge,02-grass-field,03-coast,05-summit,06-forest').split(',');
const NEAR = +(process.env.NEAR || 100), MID = +(process.env.MID || 300), FAR = +(process.env.FAR || 600);

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({
  headless: true,
  executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
  userDataDir: process.env.CHROME_PROFILE || '/tmp/gauntlet-chrome-profile-shadow',
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
    '--enable-webgl', '--use-gl=angle', '--window-size=1280,720', '--hide-scrollbars',
    '--mute-audio', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForFunction('window.__GAME && window.__GAME.ready', { timeout: 45000 });
await page.evaluate(() => { const h = window.__GAME.ctx.hud; if (h && h.skipIntro) h.skipIntro(true); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(400);

const probe = await page.evaluate(() => typeof window.__GAME.ctx.sky.sun);
if (probe !== 'object') throw new Error('no sun on ctx.sky');

const rows = [];
for (const p of poses) {
  if (!WANT.includes(p.id)) continue;
  for (let f = 0; f < 12; f++) {
    const face = f * 30;
    await page.evaluate((pp, ff) => {
      window.__GAME.teleport(pp.x, pp.z, ff);
      window.__GAME.setTime(pp.time);
      window.__GAME.release();
      const h = window.__GAME.ctx.hud; if (h && h.skipIntro) h.skipIntro(true);
    }, p, face);
    await sleep(700);
    const r = await page.evaluate((near, mid, far) => {
      const g = window.__GAME, ctx = g.ctx, THREE = ctx.THREE;
      const sun = ctx.sky.sun, cam = ctx.camera, world = ctx.world;
      const M = sun.shadow.matrix;           // world -> shadow texture space
      const v = new THREE.Vector3();
      const inside = (x, y, z) => {
        v.set(x, y, z).applyMatrix4(M);
        return v.x >= 0 && v.x <= 1 && v.y >= 0 && v.y <= 1 && v.z >= 0 && v.z <= 1;
      };
      const fwd = new THREE.Vector3();
      cam.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
      const right = new THREE.Vector3(fwd.z, 0, -fwd.x);
      const tanX = Math.tan(cam.fov * Math.PI / 360) * cam.aspect;
      const cx = cam.position.x, cz = cam.position.z;
      const bands = [near, mid, far];
      const hit = [0, 0, 0], tot = [0, 0, 0];
      const ND = 90, NL = 45;                 // 4050 cells per band-union
      for (let i = 1; i <= ND; i++) {
        const d = far * i / ND;
        const half = d * tanX;
        for (let j = 0; j < NL; j++) {
          const s = (j / (NL - 1)) * 2 - 1;
          const x = cx + fwd.x * d + right.x * half * s;
          const z = cz + fwd.z * d + right.z * half * s;
          const y = world.heightAt(x, z);
          const ok = inside(x, y, z);
          for (let b = 0; b < 3; b++) if (d <= bands[b]) { tot[b]++; if (ok) hit[b]++; }
        }
      }
      const pp = ctx.player.position;
      const sc = sun.shadow.camera;
      return {
        player_in: inside(pp.x, pp.y + 1, pp.z),
        near: tot[0] ? hit[0] / tot[0] : 0,
        mid: tot[1] ? hit[1] / tot[1] : 0,
        far: tot[2] ? hit[2] / tot[2] : 0,
        box: [+(sc.right - sc.left).toFixed(1), +(sc.top - sc.bottom).toFixed(1), +(sc.far - sc.near).toFixed(1)],
        bias: +sun.shadow.bias.toExponential(2), nb: +sun.shadow.normalBias.toFixed(3),
      };
    }, NEAR, MID, FAR);
    rows.push({ pose: p.id, face, ...r });
    process.stdout.write(`${p.id} face=${String(face).padStart(3)}  player=${r.player_in ? 'IN ' : 'OUT'}  near=${(r.near * 100).toFixed(1)}%  mid=${(r.mid * 100).toFixed(1)}%  far=${(r.far * 100).toFixed(1)}%  box=${r.box.join('x')}\n`);
  }
}

const byPose = {};
for (const r of rows) {
  const b = byPose[r.pose] || (byPose[r.pose] = { in: 0, n: 0, near: 0, mid: 0, far: 0 });
  b.n++; if (r.player_in) b.in++; b.near += r.near; b.mid += r.mid; b.far += r.far;
}
console.log('\n=== summary (12 facings each) ===');
for (const k of Object.keys(byPose)) {
  const b = byPose[k];
  console.log(`${k.padEnd(16)} player IN ${b.in}/${b.n}   near ${(100 * b.near / b.n).toFixed(1)}%   mid ${(100 * b.mid / b.n).toFixed(1)}%   far ${(100 * b.far / b.n).toFixed(1)}%`);
}
const tot = Object.values(byPose).reduce((a, b) => ({ in: a.in + b.in, n: a.n + b.n }), { in: 0, n: 0 });
console.log(`ALL              player IN ${tot.in}/${tot.n}`);
fs.writeFileSync(`/tmp/shadowsweep-${TAG}.json`, JSON.stringify({ when: new Date().toISOString(), NEAR, MID, FAR, rows, errors }, null, 2));
if (errors.length) console.error('PAGE ERRORS:\n' + errors.slice(0, 10).join('\n'));
await browser.close();
