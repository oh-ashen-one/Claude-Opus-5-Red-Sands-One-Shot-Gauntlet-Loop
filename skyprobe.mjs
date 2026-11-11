// Reads the live scene state at each judged pose. No guessing about what the
// light rig is actually doing.
import puppeteer from 'puppeteer';
import fs from 'node:fs';

const URL_BASE = process.env.GAME_URL || 'http://localhost:5811';
const poses = JSON.parse(fs.readFileSync(new URL('./tools/poses.json', import.meta.url)));
const only = process.argv[2] ? new Set(process.argv[2].split(',')) : null;

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({
  headless: true,
  executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
  userDataDir: '/tmp/gauntlet-chrome-profile-probe',
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-webgl', '--use-gl=angle',
    '--window-size=960,540', '--no-sandbox', '--mute-audio', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 960, height: 540, deviceScaleFactor: 1 });
page.on('pageerror', e => console.error('PAGEERROR', e.message));
await page.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForFunction('window.__GAME && window.__GAME.ready', { timeout: 45000 });

for (const p of poses) {
  if (only && !only.has(p.id)) continue;
  await page.evaluate((pp) => {
    window.__GAME.setTime(pp.time);
    window.__GAME.teleport(pp.x, pp.z, pp.face);
    window.__GAME.release();
  }, p);
  await new Promise(r => setTimeout(r, 1600));
  const out = await page.evaluate(() => {
    const g = window.__GAME, c = g.ctx;
    const cam = c.camera, sky = c.sky;
    const fwd = new c.THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const elevDeg = Math.asin(fwd.y) * 180 / Math.PI;
    // Angle between the view axis and the sun, and the sun's screen position.
    const sd = sky.sunDir.clone();
    const sp = sd.clone().multiplyScalar(1000).add(cam.position).project(cam);
    const md = sky.moonDir.clone();
    const mp = md.clone().multiplyScalar(1000).add(cam.position).project(cam);
    // Fraction of the frame that is sky: count how much of the dome survives.
    const f = (v) => +v.toFixed(3);
    return {
      camPos: [cam.position.x, cam.position.y, cam.position.z].map(v => +v.toFixed(1)),
      viewElevDeg: +elevDeg.toFixed(1),
      viewFwd: [f(fwd.x), f(fwd.y), f(fwd.z)],
      sunAlt: +c.tod.sunAltitude.toFixed(2),
      sunDir: [f(sd.x), f(sd.y), f(sd.z)],
      sunOnScreen: [f(sp.x), f(sp.y), f(sp.z)], sunBehind: sd.dot(fwd) < 0,
      moonAltDeg: +(Math.asin(md.y) * 180 / Math.PI).toFixed(1),
      moonOnScreen: [f(mp.x), f(mp.y), f(mp.z)], moonBehind: md.dot(fwd) < 0,
      sunI: f(sky.sun.intensity), sunC: sky.sun.color.toArray().map(f),
      hemiI: f(sky.hemi.intensity), hemiC: sky.hemi.color.toArray().map(f),
      ambI: f(sky.amb.intensity), ambC: sky.amb.color.toArray().map(f),
      fillI: f(sky.fill.intensity),
      expo: f(c.renderer.toneMappingExposure),
      fogC: c.scene.fog.color.toArray().map(f), fogD: c.scene.fog.density,
      grassSun: c.world.grass?.mesh?.material?.uniforms?.uSunColor?.value?.toArray().map(f),
      grassSky: c.world.grass?.mesh?.material?.uniforms?.uSkyColor?.value?.toArray().map(f),
      domeVisible: !!c.scene.getObjectByName('skydome')?.visible,
      playerPos: c.player ? [c.player.position.x, c.player.position.y, c.player.position.z].map(v => +v.toFixed(1)) : null,
    };
  });
  console.log('---', p.id, 'time=' + p.time);
  console.log(JSON.stringify(out, null, 1));
}
await browser.close();
