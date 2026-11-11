// Reports what the shadow rig is ACTUALLY doing at runtime, because the constant
// set in engine.js is not the constant three ends up using: r185's WebGLShadowMap
// rewrites the deprecated PCFSoftShadowMap to PCFShadowMap on first render, which
// changes which getShadow() variant every custom shader compiles against.
import puppeteer from 'puppeteer';
import fs from 'node:fs';

const URL_BASE = process.env.GAME_URL || 'http://localhost:5810';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({
  headless: true,
  executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
  userDataDir: '/tmp/gauntlet-chrome-shadow',
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio', '--no-sandbox'],
});
const page = await browser.newPage();
await page.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForFunction('window.__GAME && window.__GAME.ready', { timeout: 45000 });
await new Promise(r => setTimeout(r, 3000));

console.log(await page.evaluate(() => {
  const r = window.__GAME.ctx.renderer, s = r.shadowMap;
  const names = { 0: 'BasicShadowMap', 1: 'PCFShadowMap', 2: 'PCFSoftShadowMap', 3: 'VSMShadowMap' };
  const defines = new Set();
  for (const prog of (r.info.programs || [])) {
    for (const m of String(prog.cacheKey || '').match(/SHADOWMAP_TYPE_\w+/g) || []) defines.add(m);
  }
  const sun = window.__GAME.ctx.sky && window.__GAME.ctx.sky.sun;
  return JSON.stringify({
    enabled: s.enabled,
    typeValue: s.type,
    typeName: names[s.type] ?? 'unknown',
    compiledDefines: [...defines],
    programCount: (r.info.programs || []).length,
    sun: sun ? {
      mapSize: [sun.shadow.mapSize.x, sun.shadow.mapSize.y],
      radius: sun.shadow.radius,
      bias: sun.shadow.bias,
      // Ortho half-extent: shadows simply stop beyond this distance.
      box: [sun.shadow.camera.left, sun.shadow.camera.right,
            sun.shadow.camera.near, sun.shadow.camera.far],
    } : null,
  }, null, 2);
}));
await browser.close();
