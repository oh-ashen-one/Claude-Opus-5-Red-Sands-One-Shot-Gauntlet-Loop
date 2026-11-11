// Actor-shadow bias sweep on FROZEN frames.
// For each candidate depth bias (metres), renders A (actors cast) and B
// (actors' castShadow off), isolates the ACTOR-ATTRIBUTABLE shadow mask, and
// measures its area + how far it is DETACHED from the actor's feet.
// Also re-grabs the baseline at the end (A/B/A discipline) to report harness noise.
import puppeteer from 'puppeteer';
import fs from 'node:fs';
const URL_BASE = process.env.GAME_URL || 'http://localhost:5861';
const TAG = process.argv[2] || 'bias';
const POSES = (process.argv[3] || '01-sunset-ridge').split(',');
const BIASES = (process.env.BIASES || '0.75,0.45,0.25,0.12,0.05,0.0').split(',').map(Number);
const all = JSON.parse(fs.readFileSync(new URL('./poses.json', import.meta.url)));
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
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const results = [];
for (const id of POSES) {
  const p = all.find(q => q.id === id);
  await page.evaluate(pp => { window.__GAME.teleport(pp.x,pp.z,pp.face); window.__GAME.setTime(pp.time); window.__GAME.release();
    const h=window.__GAME.ctx.hud; if(h&&h.skipIntro) h.skipIntro(true); }, p);
  await sleep((p.settle??2)*1000);
  await page.evaluate(pp => window.__GAME.setTime(pp.time), p);
  await sleep(400);
  const r = await page.evaluate((BIASES) => {
    const ctx = window.__GAME.ctx, gl = ctx.renderer.domElement;
    window.requestAnimationFrame = () => 0;                 // FREEZE
    const sun = ctx.sky.sun, sc = sun.shadow.camera;
    const range = Math.max(1, sc.far - sc.near);
    const roots = [], seen = new Set();
    const push = o => { if (o && !seen.has(o.uuid)) { seen.add(o.uuid); roots.push(o); } };
    for (const k of ['player','samurai','horse']) { const c = ctx[k]; if (c) push(c.root||c.group||c.object3D||c); }
    const meshes = []; for (const r of roots) r.traverse(o => { if (o.isMesh) meshes.push(o); });
    const uniq = [...new Set(meshes)];
    const cv = document.createElement('canvas'); cv.width = gl.width; cv.height = gl.height;
    const g2 = cv.getContext('2d',{willReadFrequently:true});
    const grab = () => { ctx.post.render(0); g2.drawImage(gl,0,0); return g2.getImageData(0,0,cv.width,cv.height).data; };
    const lum = (D,i) => 0.2126*D[i]+0.7152*D[i+1]+0.0722*D[i+2];
    // feet: player world pos projected
    const v = ctx.player.position.clone().project(ctx.camera);
    const fx = (v.x*0.5+0.5)*cv.width, fy = (-v.y*0.5+0.5)*cv.height;
    const w = cv.width;
    const measure = (A,B) => {
      let n=0, strong=0, sum=0, minD=1e9, minPt=null, near=0;
      // "near" window = 260px box around the feet (~ the contact zone)
      for (let i=0,px=0;i<A.length;i+=4,px++){
        const d = Math.abs(lum(A,i)-lum(B,i));
        if (d>2){ n++; sum+=d;
          const x=px%w, y=(px/w)|0;
          const dist=Math.hypot(x-fx,y-fy);
          if (dist<minD){minD=dist;minPt=[x,y];}
          if (Math.abs(x-fx)<130 && Math.abs(y-fy)<130) near++;
          if (d>12) strong++; }
      }
      const tot=A.length/4;
      return { pct:+(100*n/tot).toFixed(3), pct_strong:+(100*strong/tot).toFixed(3),
        mean_abs:+(sum/tot).toFixed(4), gap_px:+minD.toFixed(1), gap_pt:minPt, near_px:near };
    };
    const rows=[];
    // A/B/A: first and last row are the SHIPPED bias, so the harness reports
    // its own noise beside the effect in the same run.
    const seq = [BIASES[0], ...BIASES, BIASES[0]];
    let firstA=null,lastA=null;
    for (let k=0;k<seq.length;k++){
      const b = seq[k];
      sun.shadow.bias = -b/range;
      const A = grab();
      const prev = uniq.map(m=>m.castShadow); uniq.forEach(m=>m.castShadow=false);
      const B = grab();
      uniq.forEach((m,i)=>m.castShadow=prev[i]);
      const m = measure(A,B);
      // whole-frame shadow coverage at this bias (intensity toggle)
      const ii = sun.shadow.intensity; const A2 = grab(); sun.shadow.intensity = 0; const S = grab(); sun.shadow.intensity = ii;
      let sh=0; for(let i=0;i<A2.length;i+=4){ if (Math.abs(lum(A2,i)-lum(S,i))>2) sh++; }
      m.frame_shadow_pct = +(100*sh/(A2.length/4)).toFixed(2);
      m.bias_m = b;
      if (k===0) firstA=A; if (k===seq.length-1) lastA=A;
      rows.push(m);
    }
    // harness noise: first vs last render of the SAME state
    let nz=0; for(let i=0;i<firstA.length;i+=4){ if (Math.abs(lum(firstA,i)-lum(lastA,i))>2) nz++; }
    sun.shadow.bias = -BIASES[0]/range;
    return { feet:[+fx.toFixed(0),+fy.toFixed(0)], range:+range.toFixed(0),
      texel_cm:[+(100*(sc.right-sc.left)/sun.shadow.mapSize.x).toFixed(1),+(100*(sc.top-sc.bottom)/sun.shadow.mapSize.y).toFixed(1)],
      autoUpdate: ctx.renderer.shadowMap.autoUpdate,
      noise_pct:+(100*nz/(firstA.length/4)).toFixed(3), rows };
  }, BIASES);
  results.push({ id, ...r });
  console.log(`\n=== ${id}  feet=${r.feet}  range=${r.range}m  texel=${r.texel_cm}cm  autoUpdate=${r.autoUpdate}`);
  console.log(`HARNESS NOISE (same state, first vs last render): ${r.noise_pct}% of pixels`);
  console.log('bias_m   actor%   strong%   mean|d|   gap_px   near_px   frame_shadow%');
  for (const x of r.rows) console.log(`${String(x.bias_m).padEnd(8)} ${String(x.pct).padEnd(8)} ${String(x.pct_strong).padEnd(9)} ${String(x.mean_abs).padEnd(9)} ${String(x.gap_px).padEnd(8)} ${String(x.near_px).padEnd(9)} ${x.frame_shadow_pct}`);
  await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForFunction('window.__GAME && window.__GAME.ready', { timeout: 45000 });
  await page.evaluate(() => { const h=window.__GAME.ctx.hud; if(h&&h.skipIntro) h.skipIntro(true); });
  await sleep(300);
}
fs.writeFileSync(`/tmp/actorbias-${TAG}.json`, JSON.stringify({when:new Date().toISOString(),results,errors},null,2));
if (errors.length) console.error('PAGE ERRORS:\n'+errors.slice(0,10).join('\n'));
await browser.close();
