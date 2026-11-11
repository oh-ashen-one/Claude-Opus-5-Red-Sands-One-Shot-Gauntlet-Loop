// The missing half of the audio instrument. game/audio.js already renders the
// complete rig offline on an OfflineAudioContext, stepping a real scenario at
// 1/60s, and its comment promises a tools/audio-render.sh that turns the result
// into a WAV, a waveform and a spectrogram. That script never existed, which is
// why audio is the one piece that has never been judged.
//
// Usage: node tools/audio-render.mjs [scenario[,scenario...]] [seconds]
//   scenarios: ambience | combat | night | shore   (default: all four)
//
// Prints measured numbers so this can fail mechanically rather than by opinion:
// a silent bus, a clipped master or a DC offset are all hard fails.
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const URL_BASE = process.env.GAME_URL || 'http://localhost:5810';
const OUT = process.env.AUDIO_DIR || 'shots/audio';
const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const scenarios = (process.argv[2] || 'ambience,combat,night,shore').split(',');
const seconds = +(process.argv[3] || 20);
// The offline renderer suspends and resumes the context on this interval to step
// the game. Varying it is how you tell a periodic artifact in the audio apart
// from one manufactured by the stepping itself.
const step = +(process.env.AUDIO_STEP || 1 / 60);
const suffix = process.env.AUDIO_SUFFIX || '';

fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  headless: true,
  executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
  userDataDir: '/tmp/gauntlet-chrome-audio',
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio',
         '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

await page.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForFunction('window.__GAME && window.__GAME.ready', { timeout: 45000 });

// Rendering happens in the page: the audio graph only exists there. The buffer
// comes back as a base64 WAV because shipping ~1.8M raw floats over CDP as JSON
// is an order of magnitude more bytes.
const renderOne = async (scenario) => page.evaluate(async (scenario, seconds, step) => {
  const audio = window.__GAME?.ctx?.audio;
  if (!audio || typeof audio.renderOffline !== 'function') {
    return { error: 'ctx.audio.renderOffline is not available' };
  }
  let buf;
  try {
    buf = await audio.renderOffline({ seconds, scenario, step });
  } catch (e) {
    return { error: 'renderOffline threw: ' + e.message };
  }

  const nCh = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
  const chans = [];
  for (let c = 0; c < nCh; c++) chans.push(buf.getChannelData(c));

  // Measured numbers first, so a silent or clipped render fails on evidence.
  const stats = [];
  for (let c = 0; c < nCh; c++) {
    const d = chans[c];
    let peak = 0, sum = 0, sumsq = 0, clipped = 0, nonzero = 0;
    for (let i = 0; i < len; i++) {
      const v = d[i], a = Math.abs(v);
      if (a > peak) peak = a;
      if (a >= 0.999) clipped++;
      if (a > 1e-5) nonzero++;
      sum += v; sumsq += v * v;
    }
    const rms = Math.sqrt(sumsq / len);
    stats.push({
      peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
      rmsDb: rms > 0 ? 20 * Math.log10(rms) : -Infinity,
      dcOffset: sum / len,
      clippedSamples: clipped,
      nonSilentRatio: nonzero / len,
    });
  }

  // Periodic-modulation detector. A spectrogram of every scenario showed evenly
  // spaced broadband dips; this measures their period and depth so the finding is
  // a number, and so it stays asserted once fixed. The first 1.5s is skipped
  // because the master deliberately fades in.
  const hop = Math.round(sr * 0.005);
  const env = [];
  for (let i = 0; i + hop <= len; i += hop) {
    let sq = 0;
    for (let k = 0; k < hop; k++) {
      let s = 0;
      for (let c = 0; c < nCh; c++) s += chans[c][i + k];
      const v = s / nCh;
      sq += v * v;
    }
    env.push(Math.sqrt(sq / hop));
  }
  const e = env.slice(Math.round(1.5 / 0.005));
  let mod = { periodMs: 0, correlation: 0, depth: 0 };
  if (e.length > 100) {
    const mean = e.reduce((a, b) => a + b, 0) / e.length;
    const d = e.map(v => v - mean);
    const denom = d.reduce((a, b) => a + b * b, 0) || 1;
    let best = { lag: 0, r: 0 };
    // 20..400 hops = 100ms..2000ms. Shorter lags are excluded because adjacent
    // windows of any noisy envelope correlate trivially, which made the detector
    // report a meaningless 20ms "period" on three of four scenarios.
    for (let lag = 20; lag <= Math.min(400, d.length >> 1); lag++) {
      let s = 0;
      for (let i = 0; i + lag < d.length; i++) s += d[i] * d[i + lag];
      const r = s / denom;
      if (r > best.r) best = { lag, r };
    }
    const sorted = [...e].sort((a, b) => a - b);
    const p05 = sorted[Math.floor(sorted.length * 0.05)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    mod = {
      periodMs: best.lag * 5,
      correlation: best.r,
      depth: p95 > 0 ? (p95 - p05) / p95 : 0,
    };
  }

  // 16-bit PCM WAV.
  const bytes = 44 + len * nCh * 2;
  const view = new DataView(new ArrayBuffer(bytes));
  const ascii = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  ascii(0, 'RIFF'); view.setUint32(4, bytes - 8, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, nCh, true);
  view.setUint32(24, sr, true); view.setUint32(28, sr * nCh * 2, true);
  view.setUint16(32, nCh * 2, true); view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, len * nCh * 2, true);
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nCh; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]));
      view.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  const u8 = new Uint8Array(view.buffer);
  let b64 = '';
  for (let i = 0; i < u8.length; i += 0x8000) {
    b64 += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  }
  return { sampleRate: sr, channels: nCh, frames: len, stats, mod, wav: btoa(b64) };
}, scenario, seconds, step);

const report = [];
for (const scenario of scenarios) {
  process.stdout.write(`rendering ${scenario} (${seconds}s) ... `);
  const r = await renderOne(scenario);
  if (r.error) { console.log('FAILED: ' + r.error); report.push({ scenario, error: r.error }); continue; }

  // Split the payload off the metadata immediately: it must never reach the report.
  const { wav: wavBase64, ...meta } = r;
  const wav = path.join(OUT, `${scenario}${suffix}.wav`);
  fs.writeFileSync(wav, Buffer.from(wavBase64, 'base64'));

  const wave = path.join(OUT, `${scenario}${suffix}-wave.png`);
  const spec = path.join(OUT, `${scenario}${suffix}-spectrogram.png`);
  const ff = [];
  try {
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', wav, '-filter_complex',
      'showwavespic=s=1600x360:colors=0xffb877|0x6fa8dc:split_channels=1',
      '-frames:v', '1', wave]);
  } catch (e) { ff.push('waveform failed: ' + e.message); }
  try {
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', wav, '-lavfi',
      'showspectrumpic=s=1600x800:mode=combined:legend=1:scale=log',
      '-frames:v', '1', spec]);
  } catch (e) { ff.push('spectrogram failed: ' + e.message); }

  const L = meta.stats[0];
  const verdict = [];
  if (L.nonSilentRatio < 0.02) verdict.push('SILENT BUS');
  if (L.clippedSamples > meta.frames * 0.0005) verdict.push(`CLIPPING (${L.clippedSamples} samples)`);
  if (Math.abs(L.dcOffset) > 0.01) verdict.push(`DC OFFSET ${L.dcOffset.toFixed(4)}`);
  if (L.peakDb < -30) verdict.push(`TOO QUIET (peak ${L.peakDb.toFixed(1)} dBFS)`);
  const m = meta.mod || {};
  if (m.correlation > 0.35) {
    verdict.push(`PERIODIC MODULATION ${m.periodMs}ms (r=${m.correlation.toFixed(2)}, depth=${(m.depth * 100).toFixed(0)}%)`);
  }

  console.log(`peak ${L.peakDb.toFixed(1)} dBFS  rms ${L.rmsDb.toFixed(1)} dBFS  `
    + `nonsilent ${(L.nonSilentRatio * 100).toFixed(1)}%  `
    + `mod ${m.periodMs ?? 0}ms r=${(m.correlation ?? 0).toFixed(2)} depth=${((m.depth ?? 0) * 100).toFixed(0)}%  `
    + (verdict.length ? 'FAIL: ' + verdict.join(', ') : 'ok'));
  if (ff.length) console.log('  ' + ff.join('\n  '));

  report.push({ scenario, seconds, wav, wave, spec, ...meta, verdict, ffmpeg: ff });
}

fs.writeFileSync(path.join(OUT, 'report.json'),
  JSON.stringify({ when: new Date().toISOString(), pageErrors, scenarios: report }, null, 2));
if (pageErrors.length) console.error('PAGE ERRORS:\n' + pageErrors.slice(0, 10).join('\n'));
await browser.close();
console.log(`\nwrote ${report.length} renders to ${OUT}`);
