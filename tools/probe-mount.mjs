import puppeteer from "puppeteer";
const b = await puppeteer.launch({headless:true,executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",userDataDir:"/tmp/pm",args:["--use-angle=metal","--no-sandbox"]});
const pg = await b.newPage(); await pg.setViewport({width:1280,height:720});
await pg.goto(process.env.GAME_URL||"http://localhost:5810",{waitUntil:"networkidle2"});
await pg.waitForFunction("window.__GAME && window.__GAME.ready",{timeout:60000});
await new Promise(r=>setTimeout(r,3000));
const snap = () => pg.evaluate(()=>{
  const g=window.__GAME, p=g.ctx.player.position, h=g.ctx.horse;
  return { player:[+p.x.toFixed(1),+p.z.toFixed(1)],
           horse: h&&h.position?[+h.position.x.toFixed(1),+h.position.z.toFixed(1)]:null,
           dist: h&&h.position?+Math.hypot(p.x-h.position.x,p.z-h.position.z).toFixed(1):null,
           mounted: h?!!h.mounted:null, speed:+(g.ctx.player.speed||0).toFixed(2) };
});
console.log("before F   :", JSON.stringify(await snap()));
// A real key event, exactly what a player sends.
await pg.evaluate(()=>{ document.body.focus();
  dispatchEvent(new KeyboardEvent("keydown",{code:"KeyF",bubbles:true}));
  setTimeout(()=>dispatchEvent(new KeyboardEvent("keyup",{code:"KeyF",bubbles:true})),60); });
await new Promise(r=>setTimeout(r,2500));
console.log("after F 2.5s:", JSON.stringify(await snap()));
await new Promise(r=>setTimeout(r,7000));
console.log("after F 9.5s:", JSON.stringify(await snap()));
// Now hold W and see if we actually ride.
await pg.evaluate(()=>dispatchEvent(new KeyboardEvent("keydown",{code:"KeyW",bubbles:true})));
await new Promise(r=>setTimeout(r,6000));
console.log("after W 6s  :", JSON.stringify(await snap()));
console.log("jump key exists:", await pg.evaluate(()=>"jump" in window.__GAME.ctx.input));
await b.close();
