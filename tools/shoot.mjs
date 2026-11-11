// Renders the ACTUAL running game headless and writes PNGs. Critics look at
// these, never at a builder's description of them.
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';

const URL_BASE = process.env.GAME_URL || 'http://localhost:5810';
const OUT = process.env.SHOT_DIR || 'shots/latest';
const W = +(process.env.SHOT_W || 1920), H = +(process.env.SHOT_H || 1080);
const poses = JSON.parse(fs.readFileSync(new URL('./poses.json', import.meta.url)));
const only = process.argv[2] ? new Set(process.argv[2].split(',')) : null;

fs.mkdirSync(OUT, { recursive: true });

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({
  headless: true,
  executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
  userDataDir: process.env.CHROME_PROFILE || '/tmp/gauntlet-chrome-profile',
  args: [
    '--use-angle=metal', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization', '--enable-webgl', '--use-gl=angle',
    `--window-size=${W},${H}`, '--hide-scrollbars', '--mute-audio',
    '--no-sandbox', '--disable-dev-shm-usage',
  ],
});
// ---- Frame-time statistics -------------------------------------------------
// window.__GAME.fps is a single ~0.5s window sampled once; measured, it swings
// 47.7 -> 79.9 fps for a MOTIONLESS camera inside one capture. That number is
// noise and must never be read as a regression. Instead we collect raw
// requestAnimationFrame deltas for seconds at a time and report a distribution.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FT_SECONDS = +(process.env.FT_SECONDS || 5.5);

const quantile = (sorted, q) =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))];

function frameStats(deltas) {
  // Drop the first two: the first delta spans from the evaluate() call to the
  // first rAF and is not a frame time at all.
  const d = deltas.slice(2).filter(x => x > 0 && x < 2000);
  if (d.length < 10) return { samples: d.length, ms_median: null, ms_p95: null, fps_median: null, frames_over_20ms: null };
  const s = [...d].sort((a, b) => a - b);
  return {
    samples: d.length,
    ms_median: +quantile(s, 0.5).toFixed(2),
    ms_p95: +quantile(s, 0.95).toFixed(2),
    fps_median: +(1000 / quantile(s, 0.5)).toFixed(1),
    frames_over_20ms: d.filter(x => x > 20).length,
  };
}

// Runs an rAF sampler inside whatever page is handed to us and returns the
// distribution. The page keeps rendering normally while we sample.
async function sampleFrames(pg, seconds) {
  await pg.evaluate(() => {
    window.__FT = { on: true, d: [] };
    let last = performance.now();
    const tick = (now) => {
      window.__FT.d.push(now - last); last = now;
      if (window.__FT.on) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await sleep(seconds * 1000);
  const raw = await pg.evaluate(() => { window.__FT.on = false; return window.__FT.d; });
  return frameStats(raw);
}

// ---- Pre-flight machine-state gate ----------------------------------------
// This machine saturates when many builders render at once. Measured, an EMPTY
// WebGL page costs p50=11.7ms / p95=29.0ms under load — indistinguishable from
// the game's own cost. So we measure the floor FIRST and stamp it into the
// report; a perf number taken above this floor is a statement about the machine,
// not about the game.
const SATURATION_MS = +(process.env.SATURATION_MS || 8);
const blank = await browser.newPage();
await blank.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
await blank.setContent(`<canvas id="c" width="${W}" height="${H}"></canvas><script>
  const gl = document.getElementById('c').getContext('webgl');
  (function f(){ gl.clearColor(0.05,0.05,0.06,1); gl.clear(gl.COLOR_BUFFER_BIT); requestAnimationFrame(f); })();
</script>`, { waitUntil: 'load' });
await sleep(600);
const floor = await sampleFrames(blank, 3.0);
await blank.close();
const saturated = floor.ms_median == null || floor.ms_median > SATURATION_MS;
const machine = {
  empty_webgl_ms_median: floor.ms_median,
  empty_webgl_ms_p95: floor.ms_p95,
  empty_webgl_fps_median: floor.fps_median,
  threshold_ms: SATURATION_MS,
  saturated,
  warning: saturated
    ? `MACHINE_SATURATED: an EMPTY WebGL page costs p50=${floor.ms_median}ms / p95=${floor.ms_p95}ms on this machine (floor should be <=${SATURATION_MS}ms). Every per-pose number below is dominated by machine load. DO NOT read any of it as a game regression.`
    : null,
};
if (saturated) {
  console.error('\n' + '='.repeat(78));
  console.error(machine.warning);
  console.error('='.repeat(78) + '\n');
} else {
  console.log(`preflight: empty WebGL floor p50=${floor.ms_median}ms p95=${floor.ms_p95}ms — machine looks idle`);
}

const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });

const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 60000 });
try {
  await page.waitForFunction('window.__GAME && window.__GAME.ready', { timeout: 45000 });
} catch (e) {
  fs.writeFileSync(path.join(OUT, 'FAILED.txt'), 'Game never became ready.\n' + errors.join('\n'));
  await page.screenshot({ path: path.join(OUT, '00-FAILED.png') });
  await browser.close();
  console.error('GAME FAILED TO BOOT\n' + errors.join('\n'));
  process.exit(1);
}

// Dismiss the opening title sequence before shooting anything. It claims the
// whole screen — letterbox, title column, its own cinematic camera — for 14.2 s
// from boot, which is long enough to swallow the SECOND pose completely: the
// wave-D capture put "Way of the Wind" and a dutch-angle intro camera over
// 02-grass-field. Critics judge these frames; none of them should contain the
// title card unless the pose is asking for it.
await page.evaluate(() => {
  const hud = window.__GAME.ctx && window.__GAME.ctx.hud;
  if (hud && hud.skipIntro) hud.skipIntro(true);
});
await new Promise(r => setTimeout(r, 400));

const report = [];
for (const p of poses) {
  if (only && !only.has(p.id)) continue;
  // ORDER MATTERS. quest.js's enterBeat() writes `ctx.tod.t = b.tod` (that is
  // deliberate arc lighting), and teleporting into a beat's radius enters it —
  // so setTime BEFORE teleport was silently thrown away and the pose captured
  // at the beat's hour instead of the one poses.json asked for. Teleport first,
  // then set the clock, then set it AGAIN after the settle in case the beat is
  // entered a frame or two late.
  await page.evaluate((pp) => {
    window.__GAME.teleport(pp.x, pp.z, pp.face);
    window.__GAME.setTime(pp.time);
    window.__GAME.release();
  }, p);
  await new Promise(r => setTimeout(r, (p.settle ?? 2) * 1000));
  // Wait out any full-frame cinematic moment. Teleporting into a beat's radius
  // ENTERS that beat, and a beat entry raises a chapter card — letterbox, a
  // vertical title column and the photo-mode corner brackets over the whole
  // screen. The wave-D capture lost 02-grass-field entirely that way. hud.busy
  // is true while a card or a haiku owns the frame; bounded so a stuck card can
  // never hang the run, and it costs nothing on a pose that has no card.
  for (let i = 0; i < 60; i++) {
    const busy = await page.evaluate(() => {
      const hud = window.__GAME.ctx && window.__GAME.ctx.hud;
      if (hud && hud.skipIntro) hud.skipIntro(true);
      return !!(hud && hud.busy);
    });
    if (!busy) break;
    await new Promise(r => setTimeout(r, 400));
  }
  await page.evaluate((pp) => window.__GAME.setTime(pp.time), p);
  if (p.drive) {
    await page.evaluate(d => window.__GAME.drive(d), p.drive);
    await new Promise(r => setTimeout(r, (p.hold ?? 2) * 1000));
  }
  // Frame FIRST, so the composition is exactly the one the pose asked for, then
  // measure. Measuring first would let a driven pose run five seconds past it.
  const file = path.join(OUT, `${p.id}.png`);
  await page.screenshot({ path: file });
  const ft = await sampleFrames(page, FT_SECONDS);
  report.push({
    id: p.id, note: p.note, file,
    fps: ft.fps_median,              // median of real frame times, not __GAME.fps
    ms_median: ft.ms_median, ms_p95: ft.ms_p95,
    frames_over_20ms: ft.frames_over_20ms, samples: ft.samples,
  });
  console.log(`shot ${p.id}  p50=${ft.ms_median}ms (${ft.fps_median}fps)  p95=${ft.ms_p95}ms  >20ms=${ft.frames_over_20ms}/${ft.samples}`);
  await page.evaluate(() => window.__GAME.release());
}

fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ when: new Date().toISOString(), machine, errors, shots: report }, null, 2));
if (errors.length) console.error('PAGE ERRORS:\n' + errors.slice(0, 20).join('\n'));
if (machine.saturated) console.error('\n' + machine.warning + '\n');
await browser.close();
console.log(`\nwrote ${report.length} shots to ${OUT}`);
