import puppeteer from "puppeteer";
const b = await puppeteer.launch({headless:true,executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",userDataDir:"/tmp/vfix",args:["--use-angle=metal","--no-sandbox"]});
const pg = await b.newPage(); await pg.setViewport({width:1600,height:900});
const warns=[]; pg.on("console",m=>{ if(/\[quest\]/.test(m.text())) warns.push(m.text()); });
await pg.goto("http://localhost:5810",{waitUntil:"networkidle2"});
await pg.waitForFunction("window.__GAME && window.__GAME.ready",{timeout:45000});
await new Promise(r=>setTimeout(r,3500));
const txt = s => pg.evaluate(q=>{const e=document.querySelector(q);return e?e.textContent.trim():null}, s);
console.log("opening beat :", await pg.evaluate(()=>window.__GAME.quest.beatId));
console.log("dialogue     :", JSON.stringify(await txt(".kw-sub .txt")));
console.log("card title   :", JSON.stringify(await txt(".kw-card .ttl")));
console.log("card numeral :", JSON.stringify(await txt(".kw-card .num")));
console.log("card sub     :", JSON.stringify(await txt(".kw-card .sub")));

// Ride beat: mount and try to actually move.
await pg.evaluate(()=>window.__GAME.quest.goto("ride"));
await new Promise(r=>setTimeout(r,1500));
await pg.evaluate(()=>window.__GAME.drive({mount:true}));
await new Promise(r=>setTimeout(r,900));
await pg.evaluate(()=>window.__GAME.drive({move:{x:0,y:1},sprint:true,mount:false}));
const p0 = await pg.evaluate(()=>[window.__GAME.ctx.player.position.x, window.__GAME.ctx.player.position.z]);
await new Promise(r=>setTimeout(r,12000));
const p1 = await pg.evaluate(()=>[window.__GAME.ctx.player.position.x, window.__GAME.ctx.player.position.z]);
const moved = Math.hypot(p1[0]-p0[0], p1[1]-p0[1]);
console.log("ride moved   :", moved.toFixed(1), "m in 12s", moved > 25 ? "OK" : "*** STILL STUCK ***");
await pg.evaluate(()=>window.__GAME.release());

// Haiku on the shrine beat.
await pg.evaluate(()=>window.__GAME.quest.goto("shrine"));
await new Promise(r=>setTimeout(r,1200));
await pg.evaluate(()=>{const q=window.__GAME.ctx.quest; q.state.beatTime=99; });
await new Promise(r=>setTimeout(r,3500));
console.log("haiku shown  :", await pg.evaluate(()=>{const e=document.querySelector(".kw-haiku");return e?e.className:"none"}));
console.log("quest warns  :", warns.length? warns.slice(0,4):"none");
await b.close();
