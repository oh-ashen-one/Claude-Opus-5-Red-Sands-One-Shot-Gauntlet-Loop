// One frozen frame, two depth biases, saved side by side. A/B/A for noise.
import puppeteer from 'puppeteer';
import fs from 'node:fs';
const URL_BASE = process.env.GAME_URL || 'http://localhost:5861';
const POSES = (process.argv[2]||'01-sunset-ridge').split(',');
const B1 = +(process.argv[3]||0.75), B2 = +(process.argv[4]||0.20);
const all = JSON.parse(fs.readFileSync(new URL('./poses.json', import.meta.url)));
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({ headless:true, executablePath: fs.existsSync(CHROME)?CHROME:undefined,
  userDataDir:'/tmp/gauntlet-chrome-profile-actor',
  args:['--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization','--enable-webgl','--use-gl=angle','--window-size=1920,1080','--hide-scrollbars','--mute-audio','--no-sandbox','--disable-dev-shm-usage']});
const page = await browser.newPage(); await page.setViewport({width:1920,height:1080});
const errors=[]; page.on('pageerror',e=>errors.push(e.message)); page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
await page.goto(URL_BASE,{waitUntil:'networkidle2',timeout:60000});
await page.waitForFunction('window.__GAME && window.__GAME.ready',{timeout:45000});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const dir='/tmp/biaspair'; fs.mkdirSync(dir,{recursive:true});
for (const id of POSES){
  const p=all.find(q=>q.id===id);
  await page.evaluate(pp=>{window.__GAME.teleport(pp.x,pp.z,pp.face);window.__GAME.setTime(pp.time);window.__GAME.release();
    const h=window.__GAME.ctx.hud; if(h&&h.skipIntro)h.skipIntro(true);},p);
  await sleep((p.settle??2)*1000);
  await page.evaluate(pp=>window.__GAME.setTime(pp.time),p);
  await sleep(400);
  const r=await page.evaluate(([b1,b2])=>{
    const ctx=window.__GAME.ctx, gl=ctx.renderer.domElement; window.requestAnimationFrame=()=>0;
    const sun=ctx.sky.sun, sc=sun.shadow.camera, range=Math.max(1,sc.far-sc.near);
    const cv=document.createElement('canvas'); cv.width=gl.width; cv.height=gl.height;
    const g2=cv.getContext('2d',{willReadFrequently:true});
    const grab=()=>{ctx.post.render(0); g2.drawImage(gl,0,0); return cv.toDataURL('image/png');};
    const raw=()=>{ctx.post.render(0); g2.drawImage(gl,0,0); return g2.getImageData(0,0,cv.width,cv.height).data;};
    sun.shadow.bias=-b1/range; const A1=grab(); const a1=raw();
    sun.shadow.bias=-b2/range; const B=grab();
    sun.shadow.bias=-b1/range; const a2=raw();
    const L=(d,i)=>0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2];
    let nz=0; for(let i=0;i<a1.length;i+=4) if(Math.abs(L(a1,i)-L(a2,i))>2) nz++;
    const v=ctx.player.position.clone().project(ctx.camera);
    return {A1,B,noise:+(100*nz/(a1.length/4)).toFixed(3),
      feet:[Math.round((v.x*.5+.5)*cv.width),Math.round((-v.y*.5+.5)*cv.height)]};
  },[B1,B2]);
  fs.writeFileSync(`${dir}/${id}-b${B1}.png`,Buffer.from(r.A1.split(',')[1],'base64'));
  fs.writeFileSync(`${dir}/${id}-b${B2}.png`,Buffer.from(r.B.split(',')[1],'base64'));
  console.log(id,'noise%',r.noise,'feet',r.feet);
  await page.reload({waitUntil:'networkidle2',timeout:60000});
  await page.waitForFunction('window.__GAME && window.__GAME.ready',{timeout:45000});
  await sleep(300);
}
console.log('errors',errors.length,dir);
await browser.close();
