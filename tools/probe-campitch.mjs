// Reports the camera's framing pitch, its boom pitch, and where the horizon
// lands in normalised device coords, per pose. Written to verify a feedback bug
// where the boom's obstruction lift leaked out through gcam.pitch into a servo
// in combat.js and drove the lens toward vertical.
//
// Horizon NDC y: 0 is frame centre, +1 is the top edge. Anything above ~1 means
// the horizon is off-screen and the shot has become a floor plan. Two runs of
// the same pose disagreeing is the signature of feedback, so each pose is
// sampled twice.
import puppeteer from 'puppeteer';
import fs from 'node:fs';

const URL_BASE = process.env.GAME_URL || 'http://localhost:5810';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const poses = JSON.parse(fs.readFileSync(new URL('./poses.json', import.meta.url)));
const only = process.argv[2] ? new Set(process.argv[2].split(',')) : null;

const browser = await puppeteer.launch({
  headless: true,
  executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
  userDataDir: '/tmp/gauntlet-chrome-campitch',
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio', '--no-sandbox',
         '--window-size=1920,1080'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
await page.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForFunction('window.__GAME && window.__GAME.ready', { timeout: 45000 });

const DEG = 180 / Math.PI;
console.log('pose                run   framing°   boom°   horizonNDC  mode');
for (const p of poses) {
  if (only && !only.has(p.id)) continue;
  for (let run = 1; run <= 2; run++) {
    await page.evaluate((pp) => {
      window.__GAME.setTime(pp.time);
      window.__GAME.teleport(pp.x, pp.z, pp.face);
      window.__GAME.release();
    }, p);
    await new Promise(r => setTimeout(r, 3000));
    const m = await page.evaluate(() => {
      const g = window.__GAME.ctx.gcam, cam = window.__GAME.ctx.camera;
      // Project a point on the true horizon: far along the view azimuth at eye height.
      const dir = new window.__GAME.ctx.THREE.Vector3();
      cam.getWorldDirection(dir);
      const far = new window.__GAME.ctx.THREE.Vector3(
        cam.position.x + dir.x * 100000, cam.position.y, cam.position.z + dir.z * 100000);
      far.project(cam);
      return { pitch: g.pitch, boomPitch: g.boomPitch ?? null, horizon: far.y, mode: g.mode };
    });
    console.log(
      `${p.id.padEnd(18)}  ${run}    ${(m.pitch * DEG).toFixed(1).padStart(7)}`
      + `  ${(m.boomPitch === null ? NaN : m.boomPitch * DEG).toFixed(1).padStart(7)}`
      + `  ${m.horizon.toFixed(2).padStart(10)}  ${m.mode}`);
  }
}
await browser.close();
