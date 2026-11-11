import puppeteer from "puppeteer";
const b = await puppeteer.launch({headless:true,executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",userDataDir:"/tmp/pg2",args:["--use-angle=metal","--no-sandbox"]});
const pg = await b.newPage(); await pg.setViewport({width:1280,height:720});
await pg.goto(process.env.GAME_URL||"http://localhost:5810",{waitUntil:"networkidle2"});
await pg.waitForFunction("window.__GAME && window.__GAME.ready",{timeout:60000});
await new Promise(r=>setTimeout(r,3000));
const key=(c,t="keydown")=>pg.evaluate(([a,b2])=>dispatchEvent(new KeyboardEvent(b2,{code:a,bubbles:true})),[c,t]);
const st=()=>pg.evaluate(()=>{const g=window.__GAME,h=g.ctx.horse,p=g.ctx.player.position;
  return{mounted:!!(h&&h.mounted),dist:h&&h.position?+Math.hypot(p.x-h.position.x,p.z-h.position.z).toFixed(1):null,
         spd:+(g.ctx.player.speed||0).toFixed(2),hspd:+(h&&h.speed||0).toFixed(2),
         mv:g.ctx.input.move.y,sprint:g.ctx.input.sprint,air:!!g.ctx.player.airborne};});
console.log("start   :",JSON.stringify(await st()));
await key("KeyF"); await new Promise(r=>setTimeout(r,3000));
console.log("mounted :",JSON.stringify(await st()));
await key("ShiftLeft"); await key("KeyW");
for (const t of [1500,3000,5000]) { await new Promise(r=>setTimeout(r,t===1500?1500:1500)); console.log("riding  :",JSON.stringify(await st())); }
await b.close();
