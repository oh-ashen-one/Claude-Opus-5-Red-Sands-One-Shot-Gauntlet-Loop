// Motion capture: drives the game with a scripted input sequence, grabs a timed
// burst of frames, and assembles a contact sheet + mp4 so a critic can judge FEEL,
// not a still. Usage: node tools/burst.mjs <sequenceId>
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const URL_BASE = process.env.GAME_URL || 'http://localhost:5810';
const OUT = process.env.SHOT_DIR || 'shots/burst';
const W = +(process.env.SHOT_W || 1280), H = +(process.env.SHOT_H || 720);
// Escape hatch back to the old per-frame screenshot path, which is ~4x slower to
// sample but does not depend on CDP screencast behaving in headless.
const NO_SCREENCAST = process.env.BURST_SCREENSHOT === '1';
const SEQS = JSON.parse(fs.readFileSync(new URL('./sequences.json', import.meta.url)));
const want = process.argv[2] ? new Set(process.argv[2].split(',')) : null;

fs.mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({
  headless: true,
  executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
  userDataDir: process.env.CHROME_PROFILE || ('/tmp/gauntlet-burst-' + process.pid),
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
         `--window-size=${W},${H}`, '--hide-scrollbars', '--mute-audio', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
await page.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForFunction('window.__GAME && window.__GAME.ready', { timeout: 45000 });

const report = [];
for (const seq of SEQS) {
  if (want && !want.has(seq.id)) continue;
  const dir = path.join(OUT, seq.id);
  fs.mkdirSync(dir, { recursive: true });
  await page.evaluate(s => {
    window.__GAME.setTime(s.time);
    window.__GAME.teleport(s.x, s.z, s.face);
    window.__GAME.release();
  }, seq);
  await new Promise(r => setTimeout(r, 1200));

  const frames = seq.frames ?? 12;
  const gap = seq.gap ?? 0.18;
  const files = [];
  // page.screenshot() costs far more than the gap it is added to: measured, the
  // `ride` sequence captured at 1.70 frames/sec where 1/gap implies 6.25, so
  // clips encoded at 1/gap played back 3.7x too fast. A gallop cycle is ~0.5s,
  // so 1.7Hz cannot resolve a gait at all, truthfully encoded or not.
  //
  // CDP screencast delivers frames as the compositor paints them, an order of
  // magnitude faster, so motion is sampled densely enough to judge. Timestamps
  // come from the capture itself and the mp4 is encoded at the rate achieved.
  const t0 = Date.now();
  const stamps = [];
  let span = 0, realFps = 1;

  // Screencast is duration-bounded, not count-bounded: the scripted inputs run on
  // a real clock, so stopping at N frames would end the take before the later
  // steps fire. Cover the whole input timeline plus a tail for the follow-through.
  const lastAt = (seq.steps || []).reduce((m, s) => Math.max(m, s.at || 0), 0);
  const duration = Math.max(3, lastAt + (seq.tail ?? 2.5));
  const CAP = 400;

  if (!NO_SCREENCAST) {
    const client = await page.createCDPSession();
    let n = 0, pending = Promise.resolve();
    const onFrame = async ({ data, sessionId }) => {
      // Ack immediately or the stream stalls; write behind the ack.
      try { await client.send('Page.screencastFrameAck', { sessionId }); } catch (e) {
        console.error('[burst] ack failed:', e.message);
      }
      if (n >= CAP) return;
      const f = path.join(dir, `f${String(n).padStart(3, '0')}.jpg`);
      n++;
      stamps.push((Date.now() - t0) / 1000);
      files.push(f);
      pending = pending.then(() => fs.promises.writeFile(f, Buffer.from(data, 'base64')))
        .catch(e => console.error('[burst] frame write failed:', e.message));
    };
    client.on('Page.screencastFrame', onFrame);
    await client.send('Page.startScreencast', {
      format: 'jpeg', quality: 88, maxWidth: W, maxHeight: H, everyNthFrame: 1,
    });

    // Drive the scripted input on a real-time timeline while frames stream in.
    let lastStep = null;
    while (n < CAP && (Date.now() - t0) / 1000 < duration) {
      const tNow = (Date.now() - t0) / 1000;
      const step = (seq.steps || []).filter(s => s.at <= tNow).pop();
      if (step && step !== lastStep) {
        lastStep = step;
        await page.evaluate(d => window.__GAME.drive(d.input), step);
      }
      await new Promise(r => setTimeout(r, 16));
    }
    try { await client.send('Page.stopScreencast'); } catch (e) {
      console.error('[burst] stopScreencast failed:', e.message);
    }
    client.off('Page.screencastFrame', onFrame);
    await pending;
    span = stamps.length > 1 ? stamps[stamps.length - 1] - stamps[0] : 1;
    realFps = stamps.length > 1 ? (stamps.length - 1) / span : 1;
  } else {
    for (let i = 0; i < frames; i++) {
      const tNow = (Date.now() - t0) / 1000;
      const step = (seq.steps || []).filter(s => s.at <= tNow).pop();
      if (step) await page.evaluate(d => window.__GAME.drive(d.input), step);
      await new Promise(r => setTimeout(r, gap * 1000));
      const f = path.join(dir, `f${String(i).padStart(3, '0')}.png`);
      await page.screenshot({ path: f });
      files.push(f);
    }
    span = (Date.now() - t0) / 1000;
    realFps = frames > 1 ? (frames - 1) / span : 1;
  }
  await page.evaluate(() => window.__GAME.release());
  const fps = await page.evaluate(() => window.__GAME.fps);

  const pattern = path.join(dir, NO_SCREENCAST ? 'f%03d.png' : 'f%03d.jpg');
  const got = files.length;

  // Contact sheet — one image a critic can read at a glance. Cap the tiles so a
  // dense screencast burst does not produce an unreadable wall of thumbnails.
  const sheet = path.join(OUT, `${seq.id}-sheet.png`);
  const tiles = Math.min(got, 12);
  const nth = Math.max(1, Math.floor(got / tiles));
  try {
    execFileSync('/opt/homebrew/bin/ffmpeg', ['-y', '-loglevel', 'error',
      '-framerate', '1', '-i', pattern,
      '-vf', `select='not(mod(n\\,${nth}))',scale=${Math.round(W / 2)}:-1,`
           + `tile=3x${Math.ceil(tiles / 3)}:padding=6:color=0x1a1a1a`,
      '-frames:v', '1', sheet]);
  } catch (e) { errors.push('contact sheet failed: ' + e.message); }
  const mp4 = path.join(OUT, `${seq.id}.mp4`);
  try {
    execFileSync('/opt/homebrew/bin/ffmpeg', ['-y', '-loglevel', 'error',
      '-framerate', realFps.toFixed(3), '-i', pattern,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20',
      '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', mp4]);
  } catch (e) { errors.push('mp4 failed: ' + e.message); }

  report.push({
    id: seq.id, fps: +fps.toFixed(1), frames: got, sheet, mp4, note: seq.note,
    // captureFps is the sampling rate of the burst, NOT the game's framerate.
    // The mp4 is encoded at it so playback runs at true speed.
    captureFps: +realFps.toFixed(2), spanSeconds: +span.toFixed(2),
    method: NO_SCREENCAST ? 'screenshot' : 'screencast',
  });
  console.log(`burst ${seq.id}  fps=${fps.toFixed(1)}  ${got} frames, `
    + `capture=${realFps.toFixed(1)}/s over ${span.toFixed(1)}s  sheet=${sheet}`);
}
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ when: new Date().toISOString(), errors, bursts: report }, null, 2));
if (errors.length) console.error('ERRORS:\n' + errors.slice(0, 15).join('\n'));
await browser.close();
console.log(`wrote ${report.length} bursts to ${OUT}`);
