import puppeteer from "puppeteer";
const b = await puppeteer.launch({headless:true,executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",userDataDir:"/tmp/v2",args:["--use-angle=metal","--no-sandbox"]});
const pg = await b.newPage(); await pg.setViewport({width:1600,height:900});
const errs=[]; pg.on("pageerror",e=>errs.push(e.message));
pg.on("console",m=>{ if(/\[quest\]/.test(m.text())) errs.push(m.text()); });
await pg.goto("http://localhost:5810",{waitUntil:"networkidle2"});
await pg.waitForFunction("window.__GAME && window.__GAME.ready",{timeout:45000});
await new Promise(r=>setTimeout(r,3000));
console.log("onPlayerHit exists :", await pg.evaluate(()=>typeof window.__GAME.ctx.combat.onPlayerHit));
// Damage must now actually move the bar.
const before = await pg.evaluate(()=>window.__GAME.ctx.combat.state.health);
await pg.evaluate(()=>window.__GAME.ctx.combat.onPlayerHit(25,true));
await new Promise(r=>setTimeout(r,400));
const after = await pg.evaluate(()=>window.__GAME.ctx.combat.state.health);
console.log("health 25 dmg      :", before, "->", after, after<before?"OK":"*** NO EFFECT ***");
// Walk every beat: check props, spawn heights and hostiles-near-shrine.
const rows=[];
for (const id of ["shore","wind","village","ride","shrine","camp","ambush","climb","duel","end"]) {
  await pg.evaluate(i=>window.__GAME.quest.goto(i), id);
  await new Promise(r=>setTimeout(r,900));
  const r0 = await pg.evaluate(()=>{
    const g=window.__GAME, p=g.ctx.player.position;
    const list=(g.ctx.enemies&&g.ctx.enemies.list)||[];
    let near=0, maxdy=0;
    for(const e of list){ if(e.dead||e.st==="dead") continue; const q=e.root&&e.root.position; if(!q||!e.root.visible) continue;
      const d=Math.hypot(q.x-p.x,q.z-p.z); if(d<60){near++; maxdy=Math.max(maxdy,Math.abs(q.y-p.y));} }
    const pr=document.querySelector(".kw-prompt");
    return {beat:g.quest.beatId, near, maxdy:+maxdy.toFixed(1),
            prompt: pr? (pr.className.includes("on")?"VISIBLE":"hidden"):"none",
            fps:Math.round(g.fps)};
  });
  rows.push(r0);
  console.log(" ", r0.beat.padEnd(8), "near60:"+String(r0.near).padStart(2), "maxΔy:"+String(r0.maxdy).padStart(5), "prompt:"+r0.prompt.padEnd(7), r0.fps+"fps");
}
console.log("errors :", errs.length?errs.slice(0,3):"none");
await b.close();
