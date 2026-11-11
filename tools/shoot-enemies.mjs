import puppeteer from "puppeteer";
const b = await puppeteer.launch({headless:true,executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",userDataDir:"/tmp/en",args:["--use-angle=metal","--no-sandbox"]});
const pg = await b.newPage(); await pg.setViewport({width:1920,height:1080});
await pg.goto(process.env.GAME_URL||"http://localhost:5810",{waitUntil:"networkidle2"});
await pg.waitForFunction("window.__GAME && window.__GAME.ready",{timeout:60000});
await new Promise(r=>setTimeout(r,2500));
await pg.evaluate(()=>window.__GAME.quest.goto("camp"));
await new Promise(r=>setTimeout(r,3000));
const info = await pg.evaluate(()=>{
  const g=window.__GAME, p=g.ctx.player.position;
  const l=(g.ctx.enemies&&g.ctx.enemies.list)||[];
  const live=l.filter(e=>!e.dead);
  let best=null,bd=1e9;
  for(const e of live){ const q=e.root&&e.root.position; if(!q) continue;
    const d=Math.hypot(q.x-p.x,q.z-p.z); if(d<bd){bd=d;best=e;} }
  if(best){ const q=best.root.position; g.teleport(q.x+5, q.z+5, 225); }
  return { n: live.length, d:+bd.toFixed(1),
           kinds: live.map(e=>e.kind||e.cfg&&e.cfg.kind||e.type||"?").slice(0,8) };
});
console.log(JSON.stringify(info));
await new Promise(r=>setTimeout(r,2500));
await pg.screenshot({path:"shots/enemies.png"});
console.log("fps", await pg.evaluate(()=>Math.round(window.__GAME.fps)));
await b.close();
