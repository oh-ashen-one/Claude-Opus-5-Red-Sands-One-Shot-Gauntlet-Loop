// Saves A (actors cast), B (actors don't), and an amplified diff mask.
import puppeteer from 'puppeteer';
import fs from 'node:fs';
const URL_BASE = process.env.GAME_URL || 'http://localhost:5861';
const TAG = process.argv[2] || 'mask';
const POSE = process.argv[3] || '01-sunset-ridge';
const poses = JSON.parse(fs.readFileSync(new URL('./poses.json', import.meta.url)));
const p = poses.find(q => q.id === POSE);
const W = 1920, H = 1080;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({ headless: true,
  executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
  userDataDir: '/tmp/gauntlet-chrome-profile-actor',
  args: ['--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization','--enable-webgl','--use-gl=angle',`--window-size=${W},${H}`,'--hide-scrollbars','--mute-audio','--no-sandbox','--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: '+e.message));
page.on('console', m => { if (m.type()==='error') errors.push('console: '+m.text()); });
await page.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForFunction('window.__GAME && window.__GAME.ready', { timeout: 45000 });
await page.evaluate(() => { const h = window.__GAME.ctx.hud; if (h&&h.skipIntro) h.skipIntro(true); });
const sleep = ms => new Promise(r=>setTimeout(r,ms));
await sleep(400);
await page.evaluate(pp => { window.__GAME.teleport(pp.x,pp.z,pp.face); window.__GAME.setTime(pp.time); window.__GAME.release();
  const h=window.__GAME.ctx.hud; if(h&&h.skipIntro) h.skipIntro(true); }, p);
await sleep((p.settle??2)*1000);
await page.evaluate(pp => window.__GAME.setTime(pp.time), p);
await sleep(400);
const r = await page.evaluate((MODE) => {
  const ctx = window.__GAME.ctx, gl = ctx.renderer.domElement;
  window.requestAnimationFrame = () => 0;
  const scene = ctx.scene, roots = [], seen = new Set();
  const push = o => { if (o && !seen.has(o.uuid)) { seen.add(o.uuid); roots.push(o); } };
  for (const k of ['player','samurai','horse']) { const c = ctx[k]; if (c) push(c.root||c.group||c.object3D||c); }
  const meshes = []; for (const r of roots) r.traverse(o => { if (o.isMesh) meshes.push(o); });
  const uniq = [...new Set(meshes)];
  const cv = document.createElement('canvas'); cv.width = gl.width; cv.height = gl.height;
  const g2 = cv.getContext('2d',{willReadFrequently:true});
  const grab = () => { ctx.post.render(0); g2.drawImage(gl,0,0); return g2.getImageData(0,0,cv.width,cv.height); };
  const A = grab();
  const prev = uniq.map(m=>m.castShadow); uniq.forEach(m=>m.castShadow=false);
  const B = grab();
  uniq.forEach((m,i)=>m.castShadow=prev[i]);
  const A2 = grab();
  // mask: amplified |A-B|
  const M = g2.createImageData(cv.width, cv.height);
  for (let i=0;i<A.data.length;i+=4){
    const la=0.2126*A.data[i]+0.7152*A.data[i+1]+0.0722*A.data[i+2];
    const lb=0.2126*B.data[i]+0.7152*B.data[i+1]+0.0722*B.data[i+2];
    const d=Math.min(255,Math.abs(la-lb)*8);
    M.data[i]=d; M.data[i+1]=d; M.data[i+2]=d; M.data[i+3]=255;
  }
  const toPng = (img) => { g2.putImageData(img,0,0); return cv.toDataURL('image/png'); };
  // player feet in screen space
  const THREE_V = ctx.player.position.clone();
  const cam = ctx.camera; const v = THREE_V.clone().project(cam);
  const feet = [Math.round((v.x*0.5+0.5)*cv.width), Math.round((-v.y*0.5+0.5)*cv.height)];
  // column profile: how much delta per 40px row band under the feet
  return { mask: toPng(M), a: toPng(A), b: toPng(B), feet,
    noise: (()=>{ let n=0; for(let i=0;i<A.data.length;i+=4){
      const la=0.2126*A.data[i]+0.7152*A.data[i+1]+0.0722*A.data[i+2];
      const lc=0.2126*A2.data[i]+0.7152*A2.data[i+1]+0.0722*A2.data[i+2];
      if(Math.abs(la-lc)>2)n++; } return +(100*n/(A.data.length/4)).toFixed(3); })() };
}, 'x');
const dir = `/tmp/actormask-${TAG}`; fs.mkdirSync(dir,{recursive:true});
for (const k of ['mask','a','b']) fs.writeFileSync(`${dir}/${POSE}-${k}.png`, Buffer.from(r[k].split(',')[1],'base64'));
console.log('feet px', r.feet, 'noise%', r.noise, 'errors', errors.length);
console.log(dir);
await browser.close();
