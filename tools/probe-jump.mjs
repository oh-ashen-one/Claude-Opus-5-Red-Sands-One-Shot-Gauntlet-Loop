import puppeteer from "puppeteer";
const b = await puppeteer.launch({headless:true,executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",userDataDir:"/tmp/pj",args:["--use-angle=metal","--no-sandbox"]});
const pg = await b.newPage(); await pg.setViewport({width:1280,height:720});
await pg.goto(process.env.GAME_URL||"http://localhost:5810",{waitUntil:"networkidle2"});
await pg.waitForFunction("window.__GAME && window.__GAME.ready",{timeout:60000});
await new Promise(r=>setTimeout(r,3000));
const key=(code,type="keydown")=>pg.evaluate(([c,t])=>dispatchEvent(new KeyboardEvent(t,{code:c,bubbles:true})),[code,type]);
const y=()=>pg.evaluate(()=>{const g=window.__GAME;return {y:+g.ctx.player.position.y.toFixed(2), air:!!g.ctx.player.airborne};});
const ground=(await y()).y;
await key("Space");
let peak=ground, sawAir=false;
for(let i=0;i<40;i++){ await new Promise(r=>setTimeout(r,40)); const s=await y(); peak=Math.max(peak,s.y); if(s.air) sawAir=true; }
console.log("jump: ground",ground.toFixed(2),"peak",peak.toFixed(2),"rise",(peak-ground).toFixed(2)+"m", sawAir?"airborne OK":"*** NEVER LEFT GROUND ***");
// Gallop
await key("KeyF"); await new Promise(r=>setTimeout(r,2200));
await key("ShiftLeft"); await key("KeyW");
await new Promise(r=>setTimeout(r,6000));
const sp=await pg.evaluate(()=>+(window.__GAME.ctx.player.speed||0).toFixed(2));
console.log("gallop speed:", sp, sp>9?"OK":"*** SLOW ***");
await b.close();
