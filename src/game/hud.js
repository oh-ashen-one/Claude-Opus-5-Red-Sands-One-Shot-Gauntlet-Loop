import * as THREE from 'three';

// =============================================================================
//  KAZE NO MICHI — HUD, title sequence and the GUIDING WIND
//
//  OWNER: hud lane.  This file owns everything the player reads and nothing
//  the player fights.
//
//  The governing rule is subtraction.  Ghost of Tsushima's interface works
//  because for ninety per cent of the running time the screen is a photograph
//  and nothing else.  So:
//
//    * There is no minimap, no compass, no waypoint marker, no damage numbers,
//      no ability icons, no permanently-mounted frame of any kind.
//    * Navigation is diegetic.  Q calls the GUIDING WIND: a real gust of air
//      and leaves, living in the 3D scene, that leaves the player and streams
//      away along the bearing to ctx.quest.guideTarget.  You read the world,
//      not a UI.
//    * Everything else surfaces, says one thing, and leaves.  Objectives hold
//      five seconds.  Health only exists once it is not full.  Resolve only
//      exists once you have some.
//    * Type is gold-on-ink: a Mincho vertical column for Japanese, a period
//      Latin serif for everything else, wide letterspacing, low contrast on
//      labels and full contrast only on the one line that matters.
//
//  LEGIBILITY.  The island at golden hour is a wall of bright gold; paper-white
//  type disappears into it.  Two devices carry the text and neither of them is
//  a box:
//    - gameplay elements each sit on a soft elliptical ink halo that is
//      invisible over anything already dark;
//    - title / chapter / haiku moments raise a full cinematic scrim — four
//      edge gradients and a vignette — which is what those moments want anyway.
//
//  Two halves live here:
//    1. A DOM overlay inside #ui.  DOM because browser text rendering and
//       vertical writing-mode beat anything hand-rolled into a canvas.
//    2. GuidingWind — an in-scene particle system (two InstancedBufferGeometry
//       draw calls, custom GLSL, procedural leaf silhouette, no textures) that
//       renders through the same HDR + post chain as the world, so the leaves
//       bloom, catch the DOF and take the film grade.
//
//  Public API (other lanes drive the HUD through this, never through the DOM):
//    hud.objective(line, eyebrow)     hud.clearObjective()
//    hud.say(who, text, seconds)      hud.sayAll([...])   hud.clearSay()
//    hud.haiku('sunset' | spec)       hud.titleCard(spec)
//    hud.prompt(key, text)            hud.hidePrompt()
//    hud.setVitals({health, resolve, resolveMax})   hud.damage(n)
//    hud.stance(name)                 hud.callWind()
//    hud.setPaused(bool)              hud.skipIntro()     hud.replayIntro()
//
//  It reads, defensively and without ever assuming they exist:
//    ctx.quest.currentObjective, ctx.quest.guideTarget
//    ctx.combat.state.{health, resolve, resolveMax, stance, inCombat}
//    ctx.player.{position, health, yaw}, ctx.gcam.yaw
// =============================================================================

const NS = 'kw';

const CSS = `
#ui .${NS} {
  position:absolute; inset:0; overflow:hidden;
  --ink:6,7,10;
  --paper:#f4ecdc;
  --gold:#e6c27c;
  --serif:"Hoefler Text","Iowan Old Style",Baskerville,"Big Caslon",Georgia,"Times New Roman",serif;
  --jp:"Hiragino Mincho ProN","Yu Mincho","YuMincho","Songti SC","MS Mincho",serif;
  --sh:0 1px 2px rgba(0,0,0,.8), 0 3px 12px rgba(0,0,0,.62);
  --shh:0 1px 3px rgba(0,0,0,.9), 0 6px 26px rgba(0,0,0,.7);
  font-family:var(--serif);
  -webkit-font-smoothing:antialiased;
  text-rendering:geometricPrecision;
}
#ui .${NS} * { box-sizing:border-box; }

/* ---- opening veil ------------------------------------------------------- */
#ui .${NS}-veil {
  position:absolute; inset:-2px; background:#04050a; opacity:1;
  transition:opacity 2.1s cubic-bezier(.32,.06,.28,1);
}
#ui .${NS}-veil.off { opacity:0; }

/* ---- cinematic scrim: only up during title / chapter / haiku -------------
 * This used to be four strong edge gradients plus a heavy vignette, and it was
 * eating the picture: measured at sky altitude y=280 a golden-hour frame read
 * (233,175,105) on the clean right side and (67,53,35) behind the scrim — about
 * two and a half stops out of the best part of the sky, terminating in a soft
 * but visible vertical edge where the left gradient ran out around x=900.
 *
 * A scrim exists to make TYPE legible, not to grade the shot, and the type only
 * ever lives in two places: the vertical Japanese column up on the right, and
 * the Latin block down on the left.  So the darkening is now two soft ellipses
 * pinned to those two anchors, which is the local-luminance answer done in CSS,
 * plus the barest edge shaping so the letterbox has something to sit against.
 * The sky between them — which is the whole photograph — is left alone.
 * ------------------------------------------------------------------------- */
#ui .${NS}-scrim {
  position:absolute; inset:-2px; opacity:0;
  transition:opacity 1.7s cubic-bezier(.4,0,.5,1);
  background:
    radial-gradient(44% 40% at 85% 31%, rgba(var(--ink),.46), rgba(var(--ink),.19) 46%, rgba(var(--ink),0) 78%),
    radial-gradient(46% 36% at 19% 77%, rgba(var(--ink),.46), rgba(var(--ink),.19) 46%, rgba(var(--ink),0) 78%),
    linear-gradient(180deg, rgba(var(--ink),.20), rgba(var(--ink),.05) 24%, rgba(var(--ink),0) 40%),
    linear-gradient(0deg,   rgba(var(--ink),.24), rgba(var(--ink),.06) 24%, rgba(var(--ink),0) 42%),
    linear-gradient(270deg, rgba(var(--ink),.20), rgba(var(--ink),.03) 26%, rgba(var(--ink),0) 44%),
    linear-gradient(90deg,  rgba(var(--ink),.20), rgba(var(--ink),.03) 26%, rgba(var(--ink),0) 44%),
    radial-gradient(128% 104% at 50% 48%, rgba(var(--ink),0) 46%, rgba(var(--ink),.30) 100%);
}
#ui .${NS}.cine .${NS}-scrim { opacity:1; }

/* ---- cinematic letterbox ------------------------------------------------ */
#ui .${NS}-lb {
  position:absolute; left:-2px; right:-2px; height:0; background:#04050a;
  transition:height 1.5s cubic-bezier(.36,.02,.2,1);
}
#ui .${NS}-lb.t { top:-2px; } #ui .${NS}-lb.b { bottom:-2px; }
#ui .${NS}.bars .${NS}-lb { height:10.4vh; }

/* ---- photo-mode viewfinder frame ---------------------------------------- */
#ui .${NS}-frame {
  position:absolute; inset:15.2vh 6.6vw; opacity:0;
  transition:opacity 1.5s ease, transform 4.2s cubic-bezier(.2,0,.2,1);
  transform:scale(1.015);
}
#ui .${NS}-frame.on { opacity:1; transform:scale(1); }
#ui .${NS}-frame i {
  position:absolute; width:2.3vw; height:2.3vw;
  border:0 solid rgba(244,236,220,.9);
  filter:drop-shadow(0 1px 3px rgba(0,0,0,.85));
}
#ui .${NS}-frame i.tl { top:0; left:0; border-top-width:1px; border-left-width:1px; }
#ui .${NS}-frame i.tr { top:0; right:0; border-top-width:1px; border-right-width:1px; }
#ui .${NS}-frame i.bl { bottom:0; left:0; border-bottom-width:1px; border-left-width:1px; }
#ui .${NS}-frame i.br { bottom:0; right:0; border-bottom-width:1px; border-right-width:1px; }

/* ---- vertical japanese column (shared) ---------------------------------- */
#ui .${NS} .vert {
  writing-mode:vertical-rl; text-orientation:upright;
  font-family:var(--jp); font-weight:400;
  letter-spacing:.16em; line-height:1;
}
#ui .${NS} .vert span { display:inline-block; opacity:0; transform:translateY(-.34em);
  transition:opacity 1.5s ease, transform 1.9s cubic-bezier(.16,.7,.24,1); }
#ui .${NS} .vert.lit span { opacity:1; transform:translateY(0); }

/* ---- title sequence ----------------------------------------------------- */
#ui .${NS}-title { position:absolute; inset:0; opacity:1;
  transition:opacity 2.8s cubic-bezier(.4,0,.5,1); }
#ui .${NS}-title.gone { opacity:0; }
#ui .${NS}-title .jp {
  position:absolute; right:11.4vw; top:16vh;
  font-size:min(5.4vw,9.6vh); color:var(--paper);
  text-shadow:0 2px 5px rgba(0,0,0,.92), 0 0 22px rgba(0,0,0,.7), 0 0 60px rgba(230,194,124,.42);
}
#ui .${NS}-title .rule {
  position:absolute; right:9vw; top:16.6vh; width:1px; height:33vh;
  background:linear-gradient(180deg,rgba(196,72,46,0),#c4482e 20%,rgba(196,72,46,.12));
  box-shadow:0 0 7px rgba(0,0,0,.7);
  transform:scaleY(0); transform-origin:top;
  transition:transform 2.6s cubic-bezier(.2,.6,.2,1);
}
#ui .${NS}-title .rule.lit { transform:scaleY(1); }
#ui .${NS}-title .latin {
  position:absolute; left:8.4vw; bottom:16vh; opacity:0; transform:translateY(.5vh);
  transition:opacity 2.2s ease, transform 2.6s cubic-bezier(.16,.7,.24,1);
}
#ui .${NS}-title .latin.lit { opacity:1; transform:translateY(0); }
#ui .${NS}-title .eyebrow {
  font-size:min(.86vw,1.55vh); letter-spacing:.62em; text-transform:uppercase;
  color:var(--gold); text-shadow:var(--shh);
}
#ui .${NS}-title .name {
  margin-top:1.5vh; font-size:min(2.8vw,5vh); letter-spacing:.1em;
  color:var(--paper); text-shadow:var(--shh);
}
#ui .${NS}-title .name::after {
  content:''; display:block; margin-top:2.2vh; width:8vw; height:1px;
  background:linear-gradient(90deg,rgba(230,194,124,.85),rgba(230,194,124,0));
}

/* ---- chapter / photo title card ----------------------------------------- */
#ui .${NS}-card { position:absolute; inset:0; opacity:0;
  transition:opacity 1.5s cubic-bezier(.4,0,.5,1); }
#ui .${NS}-card.on { opacity:1; }
#ui .${NS}-card .jp {
  position:absolute; right:12.6vw; top:23vh; font-size:min(2.9vw,5.2vh);
  color:var(--paper); text-shadow:0 2px 6px rgba(0,0,0,.9), 0 0 26px rgba(0,0,0,.62);
}
#ui .${NS}-card .txt { position:absolute; left:11.6vw; bottom:24vh; }
#ui .${NS}-card .num {
  font-size:min(.8vw,1.44vh); letter-spacing:.66em; color:var(--gold);
  text-transform:uppercase; text-shadow:var(--shh);
}
#ui .${NS}-card .ttl {
  margin-top:1.7vh; font-size:min(2.3vw,4.1vh); letter-spacing:.07em;
  color:var(--paper); text-shadow:var(--shh);
}
#ui .${NS}-card .sub {
  margin-top:1.6vh; font-size:min(.82vw,1.48vh); letter-spacing:.42em;
  text-transform:uppercase; color:rgba(244,236,220,.82); text-shadow:var(--shh);
}
#ui .${NS}-card .cap {
  position:absolute; right:11.6vw; bottom:24.4vh; text-align:right;
  font-size:min(.72vw,1.32vh); letter-spacing:.4em; text-transform:uppercase;
  color:rgba(244,236,220,.8); text-shadow:0 1px 3px #000, 0 3px 16px rgba(0,0,0,.9);
}

/* ---- objective ----------------------------------------------------------
 * NOTE, and it applies to every halo below: .kw is overflow:hidden, so a
 * a farthest-side halo on a box that hangs off the screen gets sliced through
 * the middle of its falloff and leaves a straight dark border down the edge of
 * the frame — which is what the clipped bottom-left corner in the night frame
 * actually was.  Every halo box is therefore anchored inside the viewport and
 * the content is pushed into place with padding instead, so the ink reaches
 * zero exactly at the screen edge and there is nothing to cut.  The .7vw
 * left inset is the slide-in distance, so even mid-transition it stays on.
 * ------------------------------------------------------------------------- */
#ui .${NS}-obj {
  position:absolute; left:.7vw; top:0;
  display:flex; gap:1.5vw; padding:22vh 8vw 11vh 5.5vw;
  opacity:0; transform:translateX(-.7vw);
  background:radial-gradient(farthest-side at 50% 50%,
    rgba(var(--ink),.68), rgba(var(--ink),.4) 56%, rgba(var(--ink),0) 100%);
  transition:opacity 1.15s ease, transform 1.5s cubic-bezier(.16,.7,.24,1);
}
#ui .${NS}-obj.on { opacity:1; transform:translateX(0); }
#ui .${NS}-obj .rule {
  width:1px; align-self:stretch; transform:scaleY(0); transform-origin:top;
  background:linear-gradient(180deg,#c4482e,rgba(196,72,46,.06));
  transition:transform 1.5s cubic-bezier(.2,.6,.2,1) .25s;
}
#ui .${NS}-obj.on .rule { transform:scaleY(1); }
#ui .${NS}-obj .eyebrow {
  font-size:min(.74vw,1.34vh); letter-spacing:.52em; text-transform:uppercase;
  color:var(--gold); text-shadow:var(--shh);
}
#ui .${NS}-obj .line {
  margin-top:1.25vh; font-size:min(1.36vw,2.46vh); letter-spacing:.035em;
  color:var(--paper); text-shadow:var(--shh); max-width:24vw; line-height:1.42;
}

/* ---- haiku -------------------------------------------------------------- */
#ui .${NS}-haiku { position:absolute; inset:0; opacity:0;
  transition:opacity 1.9s cubic-bezier(.4,0,.5,1); }
#ui .${NS}-haiku.on { opacity:1; }
#ui .${NS}-haiku .cols {
  position:absolute; right:13vw; top:20vh; height:54vh;
  display:flex; flex-direction:row-reverse; gap:2.6vw;
}
#ui .${NS}-haiku .cols > div {
  font-size:min(1.9vw,3.4vh); color:var(--paper);
  text-shadow:0 2px 5px rgba(0,0,0,.92), 0 0 24px rgba(0,0,0,.72);
}
#ui .${NS}-haiku .place {
  position:absolute; right:13vw; top:14.2vh; text-align:right;
  font-size:min(.74vw,1.34vh); letter-spacing:.5em; text-transform:uppercase;
  color:var(--gold); opacity:0; transition:opacity 1.6s ease; text-shadow:var(--shh);
}
#ui .${NS}-haiku .place.lit { opacity:1; }
#ui .${NS}-haiku .en {
  position:absolute; left:11vw; bottom:19vh; opacity:0; transform:translateY(.6vh);
  transition:opacity 2.1s ease, transform 2.4s cubic-bezier(.16,.7,.24,1);
  font-size:min(1.2vw,2.16vh); font-style:italic; line-height:2.05;
  letter-spacing:.045em; color:rgba(244,236,220,.9); text-shadow:var(--shh);
}
#ui .${NS}-haiku .en.lit { opacity:1; transform:translateY(0); }
#ui .${NS}-haiku .en i {
  display:block; width:5.4vw; height:1px; margin-bottom:2.6vh;
  background:linear-gradient(90deg,rgba(230,194,124,.9),rgba(230,194,124,0));
}

/* ---- vitals: health + resolve ------------------------------------------- */
#ui .${NS}-vit {
  position:absolute; left:0; bottom:0; opacity:0;
  padding:13vh 9vw 5vh 6.4vw;
  background:radial-gradient(farthest-side at 50% 50%,
    rgba(var(--ink),.74), rgba(var(--ink),.44) 56%, rgba(var(--ink),0) 100%);
  transition:opacity 1.25s ease;
}
#ui .${NS}-vit.on { opacity:1; }
#ui .${NS}-vit .hp {
  position:relative; width:14.4vw; height:3px; background:rgba(var(--ink),.85);
  box-shadow:0 0 0 1px rgba(0,0,0,.7), 0 2px 7px rgba(0,0,0,.8);
}
#ui .${NS}-vit .hp i {
  position:absolute; left:0; top:0; bottom:0; width:100%;
  transform-origin:left; transform:scaleX(1);
  background:linear-gradient(90deg,#f5d69a,#e0b869);
  box-shadow:0 0 12px rgba(230,194,124,.8), 0 0 3px rgba(255,236,196,.9);
  transition:transform .45s cubic-bezier(.2,.7,.2,1);
}
#ui .${NS}-vit .hp u {
  position:absolute; top:-1px; bottom:-1px; width:1px; background:rgba(var(--ink),.88);
}
#ui .${NS}-vit .res { display:flex; gap:.56vw; margin-top:1.55vh; }
#ui .${NS}-vit .res i {
  width:.68vw; height:.68vw; border-radius:50%;
  border:1px solid rgba(230,194,124,.55); background:rgba(var(--ink),.6);
  box-shadow:0 1px 4px rgba(0,0,0,.85);
  transition:background .4s ease, border-color .4s ease, box-shadow .4s ease;
}
#ui .${NS}-vit .res i.f {
  background:#f5d69a; border-color:#f5d69a;
  box-shadow:0 0 11px rgba(230,194,124,.85), 0 1px 4px rgba(0,0,0,.85);
}

/* ---- subtitles ---------------------------------------------------------- */
#ui .${NS}-sub {
  position:absolute; left:50%; bottom:.6vh; transform:translate(-50%,.5vh);
  width:96vw; padding:13vh 20vw 8.4vh; text-align:center; opacity:0;
  background:radial-gradient(farthest-side at 50% 50%,
    rgba(var(--ink),.74), rgba(var(--ink),.44) 56%, rgba(var(--ink),0) 100%);
  transition:opacity .85s ease, transform 1.05s cubic-bezier(.16,.7,.24,1);
}
#ui .${NS}-sub.on { opacity:1; transform:translate(-50%,0); }
#ui .${NS}-sub .who {
  font-size:min(.74vw,1.34vh); letter-spacing:.52em; text-transform:uppercase;
  color:var(--gold); margin-bottom:1.25vh; text-shadow:var(--shh);
}
#ui .${NS}-sub .txt {
  font-size:min(1.32vw,2.38vh); line-height:1.62; letter-spacing:.028em;
  color:var(--paper); text-shadow:var(--shh);
}

/* ---- interaction prompt -------------------------------------------------
 * Was left:50% bottom:16vh — dead centre, which is exactly where the samurai
 * stands.  "Q CALL THE GUIDING WIND" printed across his hips in every frame,
 * and at night the mount prompt was the brightest object in the picture.  It
 * now sits in the same left-hand text column as the objective and the vitals
 * (content edge ~6vw, matching .kw-obj's 6.2vw and .kw-vit's 6.4vw), low
 * enough to be out of the landscape and clear of the character entirely.
 * ------------------------------------------------------------------------- */
#ui .${NS}-prm {
  position:absolute; left:0; bottom:8vh; transform:translateY(.4vh);
  display:flex; align-items:center; gap:.86vw; opacity:0;
  padding:6.5vh 9vw 6.5vh 6vw;
  background:radial-gradient(farthest-side at 50% 50%,
    rgba(var(--ink),.62), rgba(var(--ink),.33) 56%, rgba(var(--ink),0) 100%);
  transition:opacity .7s ease, transform .9s cubic-bezier(.16,.7,.24,1);
}
#ui .${NS}-prm.on { opacity:1; transform:translateY(0); }
#ui .${NS}-prm b {
  font-weight:400; font-size:min(.74vw,1.34vh); letter-spacing:.24em;
  color:var(--gold); padding:.56vh .78vw; border:1px solid rgba(230,194,124,.5);
  text-shadow:var(--shh);
}
#ui .${NS}-prm span {
  font-size:min(.96vw,1.72vh); letter-spacing:.34em; text-transform:uppercase;
  color:rgba(244,236,220,.9); text-shadow:var(--shh);
}

/* ---- stance flourish ---------------------------------------------------- */
#ui .${NS}-stn {
  position:absolute; left:50%; bottom:12vh; transform:translate(-50%,.6vh);
  text-align:center; opacity:0; padding:9vh 15vw;
  background:radial-gradient(farthest-side at 50% 50%,
    rgba(var(--ink),.66), rgba(var(--ink),.36) 56%, rgba(var(--ink),0) 100%);
  transition:opacity .8s ease, transform 1.1s cubic-bezier(.16,.7,.24,1);
}
#ui .${NS}-stn.on { opacity:1; transform:translate(-50%,0); }
#ui .${NS}-stn b {
  display:block; font-family:var(--jp); font-weight:400;
  font-size:min(1.66vw,3vh); letter-spacing:.28em; color:var(--paper);
  text-shadow:var(--shh);
}
#ui .${NS}-stn span {
  display:block; margin-top:1.1vh; font-size:min(.7vw,1.28vh);
  letter-spacing:.56em; text-transform:uppercase; color:var(--gold);
  text-shadow:var(--shh);
}

/* ---- pause / controls --------------------------------------------------- */
#ui .${NS}-pause {
  position:absolute; inset:0; opacity:0;
  background:radial-gradient(120% 88% at 50% 46%,rgba(var(--ink),.68),rgba(4,5,8,.94));
  -webkit-backdrop-filter:blur(9px) saturate(.6); backdrop-filter:blur(9px) saturate(.6);
  transition:opacity .5s cubic-bezier(.4,0,.5,1);
}
#ui .${NS}-pause.on { opacity:1; }
#ui .${NS}-pause .jp {
  position:absolute; right:8.2vw; top:12vh; font-size:min(2vw,3.6vh);
  color:rgba(244,236,220,.5);
}
#ui .${NS}-pause .head { position:absolute; left:11vw; top:15.4vh; }
#ui .${NS}-pause .head .e {
  font-size:min(.74vw,1.34vh); letter-spacing:.62em; text-transform:uppercase;
  color:var(--gold);
}
#ui .${NS}-pause .head .t {
  margin-top:1.3vh; font-size:min(2.1vw,3.8vh); letter-spacing:.09em; color:var(--paper);
}
#ui .${NS}-pause .head .r {
  margin-top:2.4vh; width:14vw; height:1px;
  background:linear-gradient(90deg,#c4482e,rgba(196,72,46,0));
}
#ui .${NS}-pause .cols {
  position:absolute; left:11vw; top:35vh; right:11vw;
  display:grid; grid-auto-flow:column;
  grid-template-rows:repeat(7,auto); grid-template-columns:repeat(2,minmax(0,1fr));
  column-gap:5vw; row-gap:2.35vh; max-width:62vw;
}
#ui .${NS}-pause .row { display:flex; align-items:baseline; gap:1.2vw; }
#ui .${NS}-pause .k { display:flex; gap:.38vw; flex:0 0 11.4vw; justify-content:flex-end; }
#ui .${NS}-pause .k b {
  font-weight:400; font-size:min(.7vw,1.28vh); letter-spacing:.2em;
  color:var(--gold); border:1px solid rgba(230,194,124,.36);
  padding:.44vh .6vw; white-space:nowrap; line-height:1;
}
#ui .${NS}-pause .d {
  font-size:min(1vw,1.82vh); letter-spacing:.05em; color:rgba(244,236,220,.86);
}
#ui .${NS}-pause .foot {
  position:absolute; left:11vw; bottom:12vh;
  font-size:min(.72vw,1.32vh); letter-spacing:.5em; text-transform:uppercase;
  color:rgba(244,236,220,.7);
}

/* ---- debug coordinates, top right ---------------------------------------
 * Plain world-space x/z (+ height) for navigation checks against the beat
 * coordinates in quest.js. Quiet on purpose: this is a dev readout, not a
 * diegetic compass — the game still has none by design. */
#ui .${NS}-coords {
  position:absolute; top:1.6vh; right:1.2vw; text-align:right;
  font-size:min(.8vw,1.5vh); letter-spacing:.14em;
  color:rgba(244,236,220,.62); text-shadow:var(--sh);
  font-variant-numeric:tabular-nums; pointer-events:none; user-select:none;
}
/* Teleport keys, directly under the readout. Same dev-aid family as the
 * coordinates: keys 5-9 are free (1-4 are stances), and the buttons are
 * clickable whenever the pointer is unlocked. */
#ui .${NS}-tps {
  position:absolute; top:3.6vh; right:1.2vw; text-align:right;
  font-size:min(.72vw,1.35vh); letter-spacing:.14em;
  color:rgba(244,236,220,.5); text-shadow:var(--sh);
  font-variant-numeric:tabular-nums; user-select:none;
}
#ui .${NS}-tps b {
  color:rgba(244,236,220,.78); font-weight:600; cursor:pointer;
  pointer-events:auto; padding:0 .18em;
}
#ui .${NS}-tps b:hover { color:rgba(244,236,220,1); }
`;

// -----------------------------------------------------------------------------
//  Content.  Written here rather than in the quest lane so the HUD can always
//  demonstrate itself, and so the quest lane can override any of it by passing
//  a spec.  All three haiku are genuine 5-7-5.
// -----------------------------------------------------------------------------
const HAIKU = {
  sunset: {
    place: 'West Ridge',
    jp: ['金の穂に', '風の道あり', '日は落ちぬ'],
    en: ['on the golden ears', 'a road the wind has opened —', 'and the sun goes down'],
  },
  ash: {
    place: 'The Burned Village',
    jp: ['焼け跡に', '刀の錆と', '秋の風'],
    en: ['among the burnt beams', 'the rust upon a sword, and', 'the wind of autumn'],
  },
  sea: {
    place: 'North Shore',
    jp: ['波の上', '日の道ひとつ', '帰らざる'],
    en: ['across the water', 'one single road of sunlight', 'that will not return'],
  },
};

const STANCES = {
  stone: ['石の型', 'Stone Stance'],
  water: ['水の型', 'Water Stance'],
  wind: ['風の型', 'Wind Stance'],
  moon: ['月の型', 'Moon Stance'],
};
const STANCE_ORDER = ['stone', 'water', 'wind', 'moon'];

// Column one is the body, column two is the sword.  Grid flows by column, so
// the first seven entries fill the left column and the rest the right; keep
// that split in sync with grid-template-rows in the .kw-pause .cols rule.
//
// This panel used to print Space as Dodge.  input.js:13 binds Space to JUMP and
// input.js:14 binds KeyC / ControlLeft to dodge, so the one screen in the game
// whose entire job is telling the truth about the controls was lying about the
// two most-used ones.  CONTROLS.md had it right all along.
const CONTROLS = [
  [['W', 'A', 'S', 'D'], 'Move'],
  [['Shift'], 'Sprint / gallop'],
  [['Space'], 'Jump'],
  [['Mouse'], 'Look'],
  [['F'], 'Mount / dismount'],
  [['E'], 'Observe / interact'],
  [['Esc'], 'Pause'],
  [['L-Click'], 'Light strike'],
  [['R-Click'], 'Heavy strike'],
  [['R-Release'], 'Parry'],
  [['C', 'Ctrl'], 'Dodge / roll'],
  [['1', '2', '3', '4'], 'Change stance'],
  [['Q'], 'Call the guiding wind'],
];

// Used only when the quest lane has not set a guideTarget yet, so the wind
// always has somewhere honest to blow.  Every one of these was checked against
// terrain.heightAt and is on land.
const LANDMARKS = [
  { x: 218, z: 566, name: 'The East Summit' },
  { x: 330, z: -560, name: 'Kamiyama' },
  { x: -330, z: 190, name: 'The River Bluff' },
  { x: -159, z: 885, name: 'The North Shore' },
  { x: 120, z: -60, name: 'The Inland Shelf' },
  { x: -200, z: -720, name: 'The South Horn' },
  { x: 130, z: 250, name: 'The East Bluff' },
  { x: -536, z: 334, name: 'The West Ridge' },
  { x: 700, z: -120, name: 'The East Massif' },
];

// =============================================================================
//  GUIDING WIND
//
//  One call spawns one gust: a leading sheet of pale wind streaks and a long
//  drift of leaves, launched from just behind the player and blown along the
//  bearing to the objective.  The streaks are weightless and outrun the leaves,
//  so the gust has a front; a third of them are pinned just above the ground so
//  the front visibly runs over the terrain.  Leaves tumble, flutter across the
//  bearing, fall, and skitter when they touch down.
//
//  Two draw calls.  Geometry is one quad instanced with per-particle position,
//  orientation quaternion, size, colour and alpha.  The leaf silhouette and the
//  streak falloff are computed in the fragment shader — no textures, nothing
//  loaded.  Every uniform and attribute is declared in the shader source; this
//  is a ShaderMaterial, not an onBeforeCompile injection, precisely so it
//  cannot silently fail to compile and vanish.
// =============================================================================

const WIND_VERT = /* glsl */`
attribute vec3 iPos;
attribute vec4 iQuat;
attribute vec2 iSize;
attribute vec3 iColor;
attribute float iAlpha;

varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;

vec3 qrot(vec4 q, vec3 v) {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

void main() {
  vUv = uv;
  vColor = iColor;
  vAlpha = iAlpha;
  vec3 p = vec3(position.x * iSize.x, position.y * iSize.y, 0.0);
  p = qrot(iQuat, p) + iPos;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

// Procedural leaf: a lobed pointed blade with a darker midrib and a hot edge,
// because at golden hour every one of these is backlit.
const LEAF_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;

void main() {
  vec2 c = vUv * 2.0 - 1.0;
  float t = clamp((c.y + 1.0) * 0.5, 0.0, 1.0);
  float w = pow(sin(t * 3.14159265), 0.60) * 0.62;
  w *= 1.0 + 0.07 * sin(c.y * 7.0 + 1.1);
  w *= 1.0 - 0.22 * smoothstep(0.55, 1.0, t);
  float a = smoothstep(w, w - 0.14, abs(c.x));
  if (a < 0.01) discard;

  float rib = smoothstep(0.07, 0.0, abs(c.x));
  float edge = smoothstep(w - 0.34, w, abs(c.x));
  vec3 col = vColor * (1.0 - 0.28 * rib) * (1.0 + 0.6 * edge);
  gl_FragColor = vec4(col, a * vAlpha);
}`;

// A wind streak: a soft Gaussian ribbon fading out at both ends so it has no
// visible cap.  Deliberately very low alpha; it is air, not smoke.
const STREAK_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;

void main() {
  vec2 c = vUv * 2.0 - 1.0;
  float across = exp(-c.x * c.x * 7.0);
  float along = pow(max(0.0, 1.0 - c.y * c.y), 1.9);
  float a = across * along;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vColor, a * vAlpha);
}`;

function makeInstancedQuad(count, frag, blending) {
  const base = new THREE.PlaneGeometry(1, 1);
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index;
  g.setAttribute('position', base.attributes.position);
  g.setAttribute('uv', base.attributes.uv);
  const buf = {
    iPos: new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3),
    iQuat: new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4),
    iSize: new THREE.InstancedBufferAttribute(new Float32Array(count * 2), 2),
    iColor: new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3),
    iAlpha: new THREE.InstancedBufferAttribute(new Float32Array(count), 1),
  };
  for (const k in buf) { buf[k].setUsage(THREE.DynamicDrawUsage); g.setAttribute(k, buf[k]); }
  g.instanceCount = count;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  const mat = new THREE.ShaderMaterial({
    vertexShader: WIND_VERT, fragmentShader: frag,
    transparent: true, depthWrite: false, depthTest: true,
    side: THREE.DoubleSide, blending,
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 12;
  return { mesh, geo: g, buf, mat };
}

function createGuidingWind(ctx) {
  const { scene, world } = ctx;
  const MAX_LEAF = 360, MAX_STREAK = 160;

  const leaves = makeInstancedQuad(MAX_LEAF, LEAF_FRAG, THREE.NormalBlending);
  const streaks = makeInstancedQuad(MAX_STREAK, STREAK_FRAG, THREE.AdditiveBlending);

  const group = new THREE.Group();
  group.name = 'guiding-wind';
  group.add(leaves.mesh, streaks.mesh);
  scene.add(group);

  // Linear-space colours: the scene renders raw HDR and post applies the curve,
  // and THREE.Color already stores hex as linear, so these need no conversion.
  // Weighted toward bone and pale gold — saturated confetti reads as debris.
  const LEAF_COLS = [0xe8cf95, 0xd9b06a, 0xf2e3c2, 0xc9853c, 0xe0c284, 0xb5502b]
    .map(h => new THREE.Color(h));
  const STREAK_COL = new THREE.Color(0xfff0d6);

  const pool = [];
  for (let i = 0; i < MAX_LEAF; i++) {
    pool.push({
      live: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(),
      quat: new THREE.Quaternion(), spinAxis: new THREE.Vector3(), spin: 0,
      age: 0, life: 1, delay: 0, w: 0.1, h: 0.17,
      col: new THREE.Color(), flutter: 0, flutterF: 0, phase: 0,
      ground: -1e4, groundTick: 0, settled: false,
    });
  }
  const spool = [];
  for (let i = 0; i < MAX_STREAK; i++) {
    spool.push({
      live: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(),
      quat: new THREE.Quaternion(),
      age: 0, life: 1, delay: 0, w: 0.05, h: 8, alphaK: 0.05,
      hug: false, ground: -1e4, groundTick: 0,
    });
  }

  const _dir = new THREE.Vector3();
  const _perp = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);
  const _tmp = new THREE.Vector3();
  const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
  const _m = new THREE.Matrix4();
  const _dq = new THREE.Quaternion();

  let active = 0;
  let gustAge = 1e9;
  const bearing = new THREE.Vector3(0, 0, 1);
  let targetName = '';

  // The bearing is judged against what the player is LOOKING at, not what the
  // body happens to face — gcam.yaw is the view direction in world XZ.
  function viewDir() {
    const y = (ctx.gcam && typeof ctx.gcam.yaw === 'number') ? ctx.gcam.yaw
      : (ctx.player && ctx.player.yaw) || 0;
    return { x: Math.sin(y), z: Math.cos(y) };
  }

  function readTarget() {
    const q = ctx.quest;
    let t = q && q.guideTarget;
    if (t) {
      const raw = t;
      if (Array.isArray(t)) t = { x: t[0], z: t.length > 2 ? t[2] : t[1] };
      else if (t.position) t = t.position;
      if (typeof t.x === 'number' && typeof t.z === 'number') {
        return { x: t.x, z: t.z, name: raw.name || '' };
      }
    }
    // Fallback: the landmark you are most nearly looking at, with a mild
    // preference for near ones.  Angle dominates so the gust stays on screen.
    const p = ctx.player.position;
    const v = viewDir();
    let best = null, bestScore = Infinity;
    for (const L of LANDMARKS) {
      const dx = L.x - p.x, dz = L.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d < 120) continue;
      const dot = (dx * v.x + dz * v.z) / d;
      const score = (1 - dot) * 3.2 + d / 1000;
      if (score < bestScore) { bestScore = score; best = L; }
    }
    if (best) return best;
    const v2 = viewDir();
    return { x: p.x + v2.x * 260, z: p.z + v2.z * 260, name: '' };
  }

  function spawn(originOffsetBack) {
    const p = ctx.player.position;
    const tgt = readTarget();
    targetName = tgt.name || '';
    _dir.set(tgt.x - p.x, 0, tgt.z - p.z);
    if (_dir.lengthSq() < 1e-4) _dir.set(0, 0, 1);
    _dir.normalize();
    bearing.copy(_dir);
    _perp.copy(_dir).cross(_up).normalize();

    const ox = p.x - _dir.x * originOffsetBack;
    const oz = p.z - _dir.z * originOffsetBack;
    const oy = world.heightAt(ox, oz);

    const nLeaf = 300, nStreak = 138;
    let used = 0;
    for (const l of pool) {
      if (used >= nLeaf) break;
      if (l.live) continue;
      used++;
      l.live = true; l.age = 0;
      l.delay = Math.pow(Math.random(), 0.7) * 1.15;
      l.life = 3.0 + Math.random() * 2.4;
      const lateral = (Math.random() * 2 - 1) * 1.5;
      const back = Math.random() * 3.0;
      l.pos.set(
        ox + _perp.x * lateral - _dir.x * back,
        oy + 0.15 + Math.pow(Math.random(), 1.8) * 2.2,
        oz + _perp.z * lateral - _dir.z * back,
      );
      const sp = 16 + Math.random() * 11;
      l.vel.copy(_dir).multiplyScalar(sp);
      l.vel.x += _perp.x * (Math.random() * 2 - 1) * 0.55;
      l.vel.z += _perp.z * (Math.random() * 2 - 1) * 0.55;
      l.vel.y += 0.4 + Math.random() * 1.4;
      l.spinAxis.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
      l.spin = 4.0 + Math.random() * 9.0;
      l.quat.setFromAxisAngle(l.spinAxis, Math.random() * 6.28);
      const s = 0.75 + Math.random() * 0.85;
      l.w = 0.086 * s; l.h = 0.152 * s;
      l.col.copy(LEAF_COLS[(Math.random() * LEAF_COLS.length) | 0]);
      l.flutter = 1.2 + Math.random() * 1.9;
      l.flutterF = 5.0 + Math.random() * 5.5;
      l.phase = Math.random() * 6.28;
      l.ground = -1e4; l.groundTick = (Math.random() * 6) | 0; l.settled = false;
    }
    used = 0;
    for (const s of spool) {
      if (used >= nStreak) break;
      if (s.live) continue;
      used++;
      s.live = true; s.age = 0;
      s.hug = used % 20 < 9;
      s.delay = Math.pow(Math.random(), 0.9) * 0.7;
      s.life = 1.5 + Math.random() * 1.3;
      const lateral = (Math.random() * 2 - 1) * (s.hug ? 3.4 : 2.4);
      s.pos.set(
        ox + _perp.x * lateral - _dir.x * (Math.random() * 3.2),
        oy + (s.hug ? 0.45 + Math.random() * 0.4 : 0.5 + Math.pow(Math.random(), 1.35) * 3.4),
        oz + _perp.z * lateral - _dir.z * (Math.random() * 3.2),
      );
      const sp = 30 + Math.random() * 24;
      s.vel.copy(_dir).multiplyScalar(sp);
      if (!s.hug) s.vel.y += (Math.random() * 2 - 1) * 0.9;
      s.w = s.hug ? 0.10 + Math.random() * 0.13 : 0.030 + Math.random() * 0.05;
      s.h = s.hug ? 8.0 + Math.random() * 10.0 : 6.0 + Math.random() * 8.0;
      s.alphaK = (s.hug ? 0.052 : 0.030) + Math.random() * 0.055;
      s.ground = -1e4; s.groundTick = (Math.random() * 4) | 0;
    }
    gustAge = 0;
    group.visible = true;
  }

  function writeSlot(target, i, p, alpha) {
    const b = target.buf;
    b.iPos.array[i * 3] = p.pos.x; b.iPos.array[i * 3 + 1] = p.pos.y; b.iPos.array[i * 3 + 2] = p.pos.z;
    b.iQuat.array[i * 4] = p.quat.x; b.iQuat.array[i * 4 + 1] = p.quat.y;
    b.iQuat.array[i * 4 + 2] = p.quat.z; b.iQuat.array[i * 4 + 3] = p.quat.w;
    b.iSize.array[i * 2] = p.w; b.iSize.array[i * 2 + 1] = p.h;
    b.iAlpha.array[i] = alpha;
  }

  function update(dt, c) {
    if (!group.visible) return;
    gustAge += dt;
    const camPos = c.camera.position;
    let live = 0;

    // ---- leaves -----------------------------------------------------------
    const la = leaves.buf;
    for (let i = 0; i < MAX_LEAF; i++) {
      const l = pool[i];
      if (!l.live) { la.iAlpha.array[i] = 0; continue; }
      l.age += dt;
      if (l.age < l.delay) { la.iAlpha.array[i] = 0; live++; continue; }
      const t = (l.age - l.delay) / l.life;
      if (t >= 1) { l.live = false; la.iAlpha.array[i] = 0; continue; }
      live++;

      if (!l.settled) {
        l.vel.multiplyScalar(Math.exp(-0.5 * dt));
        l.vel.y -= 1.5 * dt;
        const f = Math.sin(gustAge * l.flutterF + l.phase) * l.flutter;
        _tmp.copy(_perp).multiplyScalar(f * dt);
        _tmp.y += Math.cos(gustAge * l.flutterF * 0.63 + l.phase) * l.flutter * 0.5 * dt;
        l.pos.add(_tmp);
        l.pos.addScaledVector(l.vel, dt);

        // Ground is sampled round-robin — heightAt is analytic but not free.
        l.groundTick--;
        if (l.groundTick <= 0) { l.ground = world.heightAt(l.pos.x, l.pos.z); l.groundTick = 6; }
        const floor = l.ground + 0.14;
        if (l.pos.y < floor) {
          l.pos.y = floor;
          l.vel.y = Math.abs(l.vel.y) * 0.28;
          l.vel.x *= 0.74; l.vel.z *= 0.74;
          l.spin *= 0.72;
          if (l.vel.lengthSq() < 0.5) l.settled = true;
        }
        _dq.setFromAxisAngle(l.spinAxis, l.spin * dt);
        l.quat.multiply(_dq).normalize();
      }

      const fadeIn = Math.min(1, t / 0.10);
      const fadeOut = 1 - Math.max(0, (t - 0.58) / 0.42);
      writeSlot(leaves, i, l, Math.min(fadeIn, fadeOut * fadeOut));
      la.iColor.array[i * 3] = l.col.r;
      la.iColor.array[i * 3 + 1] = l.col.g;
      la.iColor.array[i * 3 + 2] = l.col.b;
    }

    // ---- streaks ----------------------------------------------------------
    const sa = streaks.buf;
    for (let i = 0; i < MAX_STREAK; i++) {
      const s = spool[i];
      if (!s.live) { sa.iAlpha.array[i] = 0; continue; }
      s.age += dt;
      if (s.age < s.delay) { sa.iAlpha.array[i] = 0; live++; continue; }
      const t = (s.age - s.delay) / s.life;
      if (t >= 1) { s.live = false; sa.iAlpha.array[i] = 0; continue; }
      live++;

      s.vel.multiplyScalar(Math.exp(-0.5 * dt));
      s.pos.addScaledVector(s.vel, dt);

      // A third of the streaks are pinned to the ground so the gust front is
      // visibly running over the terrain rather than through the air above it.
      if (s.hug) {
        s.groundTick--;
        if (s.groundTick <= 0) { s.ground = world.heightAt(s.pos.x, s.pos.z); s.groundTick = 4; }
        const want = s.ground + 0.55;
        s.pos.y += (want - s.pos.y) * Math.min(1, 7 * dt);
        s.vel.y = 0;
      }

      // Billboard the ribbon along its own velocity, rolled to face the camera.
      _y.copy(s.vel).normalize();
      _tmp.copy(camPos).sub(s.pos);
      _x.copy(_y).cross(_tmp);
      if (_x.lengthSq() < 1e-6) _x.set(1, 0, 0); else _x.normalize();
      _z.copy(_x).cross(_y).normalize();
      _m.makeBasis(_x, _y, _z);
      s.quat.setFromRotationMatrix(_m);

      const fadeIn = Math.min(1, t / 0.16);
      const fadeOut = 1 - Math.max(0, (t - 0.34) / 0.66);
      writeSlot(streaks, i, s, fadeIn * fadeOut * fadeOut * s.alphaK);
      sa.iColor.array[i * 3] = STREAK_COL.r;
      sa.iColor.array[i * 3 + 1] = STREAK_COL.g;
      sa.iColor.array[i * 3 + 2] = STREAK_COL.b;
    }

    active = live;
    if (live === 0) { group.visible = false; return; }
    for (const k of ['iPos', 'iQuat', 'iSize', 'iColor', 'iAlpha']) {
      leaves.buf[k].needsUpdate = true;
      streaks.buf[k].needsUpdate = true;
    }
  }

  return {
    group, update, spawn, readTarget,
    get active() { return active; },
    get bearing() { return bearing; },
    get targetName() { return targetName; },
  };
}

// =============================================================================
//  HUD
// =============================================================================
export function createHUD(ctx) {
  const el = document.getElementById('ui');

  const old = document.getElementById(`${NS}-style`);
  if (old) old.remove();
  const st = document.createElement('style');
  st.id = `${NS}-style`;
  st.textContent = CSS;
  document.head.appendChild(st);

  const chars = (s) => [...s].map(ch => `<span>${ch}</span>`).join('');
  const vert = (s, lit) => `<div class="vert${lit ? ' lit' : ''}">${chars(s)}</div>`;

  el.innerHTML = `
<div class="${NS}">
  <div class="${NS}-veil"></div>
  <div class="${NS}-scrim"></div>

  <div class="${NS}-frame"><i class="tl"></i><i class="tr"></i><i class="bl"></i><i class="br"></i></div>

  <div class="${NS}-title">
    <div class="jp">${vert('風の道')}</div>
    <div class="rule"></div>
    <div class="latin">
      <div class="eyebrow">Kaze no Michi</div>
      <div class="name">Way of the Wind</div>
    </div>
  </div>

  <div class="${NS}-card">
    <div class="jp"></div>
    <div class="txt"><div class="num"></div><div class="ttl"></div><div class="sub"></div></div>
    <div class="cap"></div>
  </div>

  <div class="${NS}-obj">
    <div class="rule"></div>
    <div><div class="eyebrow"></div><div class="line"></div></div>
  </div>

  <div class="${NS}-haiku">
    <div class="place"></div>
    <div class="cols"></div>
    <div class="en"></div>
  </div>

  <div class="${NS}-vit">
    <div class="hp"><i></i><u style="left:33.3%"></u><u style="left:66.6%"></u></div>
    <div class="res"></div>
  </div>

  <div class="${NS}-sub"><div class="who"></div><div class="txt"></div></div>

  <div class="${NS}-prm"><b></b><span></span></div>

  <div class="${NS}-stn"><b></b><span></span></div>

  <div class="${NS}-coords"></div>
  <div class="${NS}-tps">${[['5','shore','Shore'],['6','village','Village'],['7','shrine','Shrine'],['8','camp','Camp'],['9','summit','Summit']].map(([k, beat, label]) => `<b data-beat="${beat}">${k}·${label}</b>`).join(' ')}</div>

  <div class="${NS}-pause">
    <div class="jp">${vert('風の道', true)}</div>
    <div class="head"><div class="e">Kaze no Michi</div><div class="t">Paused</div><div class="r"></div></div>
    <div class="cols">${CONTROLS.map(([keys, label]) => `
      <div class="row"><div class="k">${keys.map(k => `<b>${k}</b>`).join('')}</div><div class="d">${label}</div></div>`).join('')}
    </div>
    <div class="foot">Esc to return</div>
  </div>

  <div class="${NS}-lb t"></div>
  <div class="${NS}-lb b"></div>
</div>`;

  const $ = (s) => el.querySelector(s);
  const root = $(`.${NS}`);
  const D = {
    veil: $(`.${NS}-veil`),
    frame: $(`.${NS}-frame`),
    title: $(`.${NS}-title`),
    titleJp: $(`.${NS}-title .vert`),
    titleRule: $(`.${NS}-title .rule`),
    titleLatin: $(`.${NS}-title .latin`),
    card: $(`.${NS}-card`),
    cardJp: $(`.${NS}-card .jp`),
    cardNum: $(`.${NS}-card .num`),
    cardTtl: $(`.${NS}-card .ttl`),
    cardSub: $(`.${NS}-card .sub`),
    cardCap: $(`.${NS}-card .cap`),
    obj: $(`.${NS}-obj`),
    objEye: $(`.${NS}-obj .eyebrow`),
    objLine: $(`.${NS}-obj .line`),
    haiku: $(`.${NS}-haiku`),
    haikuPlace: $(`.${NS}-haiku .place`),
    haikuCols: $(`.${NS}-haiku .cols`),
    haikuEn: $(`.${NS}-haiku .en`),
    vit: $(`.${NS}-vit`),
    hpFill: $(`.${NS}-vit .hp i`),
    res: $(`.${NS}-vit .res`),
    sub: $(`.${NS}-sub`),
    subWho: $(`.${NS}-sub .who`),
    subTxt: $(`.${NS}-sub .txt`),
    prm: $(`.${NS}-prm`),
    prmKey: $(`.${NS}-prm b`),
    prmTxt: $(`.${NS}-prm span`),
    stn: $(`.${NS}-stn`),
    stnJp: $(`.${NS}-stn b`),
    stnEn: $(`.${NS}-stn span`),
    pause: $(`.${NS}-pause`),
    coords: $(`.${NS}-coords`),
    tps: $(`.${NS}-tps`),
  };

  [...D.titleJp.children].forEach((s, i) => { s.style.transitionDelay = `${0.34 * i}s`; });

  const wind = createGuidingWind(ctx);

  // ---------------------------------------------------------------------------
  //  A tiny cue scheduler on the game clock, so sequencing stays in step with
  //  the render loop rather than drifting against setTimeout.
  // ---------------------------------------------------------------------------
  let now = 0;
  const cues = [];
  function at(delay, fn, tag) { cues.push({ t: now + delay, fn, tag }); }
  function cancel(tag) {
    for (let i = cues.length - 1; i >= 0; i--) if (cues[i].tag === tag) cues.splice(i, 1);
  }
  function runCues() {
    for (let i = cues.length - 1; i >= 0; i--) {
      if (cues[i].t <= now) { const c = cues.splice(i, 1)[0]; c.fn(); }
    }
  }

  // The scrim and the bars are shared by three different moments, so they are
  // reference-counted rather than toggled, or one ending clobbers another.
  let cineRefs = 0, barRefs = 0;
  const setCine = (on) => { cineRefs = Math.max(0, cineRefs + (on ? 1 : -1)); root.classList.toggle('cine', cineRefs > 0); };
  const setBars = (on) => { barRefs = Math.max(0, barRefs + (on ? 1 : -1)); root.classList.toggle('bars', barRefs > 0); };
  const forceBars = (on) => { barRefs = on ? 1 : 0; root.classList.toggle('bars', on); };

  // ---------------------------------------------------------------------------
  //  TEXT TRAFFIC CONTROL
  //
  //  A beat change used to fire four readable things in the same frame — the
  //  chapter card, the objective, a line of dialogue and the centred key prompt
  //  — each on its own independent hold timer, so the screen carried four
  //  competing blocks of type over a landscape that was supposed to be the
  //  whole point.  Everything the player reads now takes a turn.
  //
  //  Two clocks, both on the game clock so a pause holds them:
  //    cinemaUntil — when a full-frame moment (title card / haiku) lets go of
  //                  the screen.  Small elements wait this out entirely.
  //    floorUntil  — when the last small element raised will be gone.  Only the
  //                  prompt queues behind this; it is the least urgent thing on
  //                  screen and the only one that was permanent.
  //  Nothing ever queues behind more than one predecessor, so a deferred cue
  //  cannot strand behind a chain that never drains.
  // ---------------------------------------------------------------------------
  let cinemaUntil = 0, floorUntil = 0;
  const claim = (seconds) => { floorUntil = Math.max(floorUntil, now + seconds); };
  const cinemaWait = () => Math.max(0, cinemaUntil - now);

  // ---------------------------------------------------------------------------
  //  Title sequence
  // ---------------------------------------------------------------------------
  let introRunning = false;
  function runIntro() {
    introRunning = true;
    D.title.style.display = '';
    D.title.classList.remove('gone');
    D.titleJp.classList.remove('lit');
    D.titleRule.classList.remove('lit');
    D.titleLatin.classList.remove('lit');
    setCine(true);
    at(0.30, () => D.veil.classList.add('off'), 'intro');
    at(1.00, () => D.titleJp.classList.add('lit'), 'intro');
    at(1.60, () => D.titleRule.classList.add('lit'), 'intro');
    at(3.20, () => D.titleLatin.classList.add('lit'), 'intro');
    at(11.0, () => { D.title.classList.add('gone'); setCine(false); }, 'intro');
    at(14.2, () => { D.title.style.display = 'none'; introRunning = false; }, 'intro');
    // The title owns the screen the way any other cinematic moment does. The
    // shore beat's chapter card fires on frame one, so without this the game's
    // own title column and a second vertical column saying almost the same
    // thing were stacked in the same corner for the whole opening.
    cinemaUntil = Math.max(cinemaUntil, now + 14.2);
  }
  function skipIntro(fast) {
    if (!introRunning) return;
    cancel('intro');
    D.veil.classList.add('off');
    D.title.classList.add('gone');
    setCine(false);
    at(fast ? 1.0 : 2.8, () => { D.title.style.display = 'none'; }, 'intro');
    introRunning = false;
    // Skipping the title releases the screen too, or a deferred chapter card
    // would sit and wait out a sequence that is no longer playing.
    cinemaUntil = Math.min(cinemaUntil, now + (fast ? 1.0 : 2.8));
  }
  function replayIntro() {
    cancel('intro');
    if (introRunning) { introRunning = false; setCine(false); }
    D.veil.classList.remove('off');
    runIntro();
  }
  runIntro();


  // ---------------------------------------------------------------------------
  //  Objective
  // ---------------------------------------------------------------------------
  let objText = '', objEye = '';
  function objective(line, eyebrow, hold = 5.0) {
    if (!line) return clearObjective();
    objText = line; objEye = eyebrow || objEye || 'Objective';
    D.objEye.textContent = objEye;
    D.objLine.textContent = line;
    cancel('obj');
    D.obj.classList.remove('on');
    // Hold behind a chapter card or a haiku rather than printing over it.
    const w = cinemaWait() + 0.05;
    at(w, () => D.obj.classList.add('on'), 'obj');     // replay the rule wipe
    if (hold > 0) at(w + hold, () => D.obj.classList.remove('on'), 'obj');
    claim(w + (hold > 0 ? hold : 5.0) + 1.2);          // + the fade out
  }
  function reshowObjective(hold = 3.4) {
    if (!objText) return;
    cancel('obj');
    D.obj.classList.add('on');
    at(hold, () => D.obj.classList.remove('on'), 'obj');
    claim(hold + 1.2);
  }
  function clearObjective() { cancel('obj'); D.obj.classList.remove('on'); objText = ''; }

  // ---------------------------------------------------------------------------
  //  Subtitles
  // ---------------------------------------------------------------------------
  const sayQueue = [];
  let saying = false;
  function say(who, text, seconds) {
    sayQueue.push({ who: who || '', text, sec: seconds || Math.max(2.4, 1.1 + text.length * 0.052) });
    if (!saying) nextSay();
  }
  function sayAll(list) { for (const l of list) say(l.who || l[0], l.text || l[1], l.sec || l[2]); }
  function nextSay() {
    const line = sayQueue.shift();
    if (!line) { saying = false; D.sub.classList.remove('on'); return; }
    saying = true;
    D.sub.classList.remove('on');
    at(0.22, () => {
      D.subWho.textContent = line.who;
      D.subWho.style.display = line.who ? '' : 'none';
      D.subTxt.textContent = line.text;
      D.sub.classList.add('on');
    }, 'say');
    at(0.22 + line.sec, () => D.sub.classList.remove('on'), 'say');
    at(0.22 + line.sec + 0.7, nextSay, 'say');
    claim(0.22 + line.sec + 0.7);
  }
  function clearSay() { sayQueue.length = 0; cancel('say'); saying = false; D.sub.classList.remove('on'); }

  // ---------------------------------------------------------------------------
  //  Haiku composition
  // ---------------------------------------------------------------------------
  let haikuBusy = false;
  function haiku(spec, opts = {}) {
    const h = typeof spec === 'string' ? HAIKU[spec] : spec;
    if (!h) return;
    cancel('haiku');
    if (haikuBusy) { setCine(false); setBars(false); }
    haikuBusy = true;
    D.haikuCols.innerHTML = h.jp.map(l => `<div class="vert">${chars(l)}</div>`).join('');
    [...D.haikuCols.children].forEach((col) => {
      [...col.children].forEach((s, i) => { s.style.transitionDelay = `${0.14 * i}s`; });
    });
    D.haikuPlace.textContent = h.place || '';
    D.haikuEn.innerHTML = '<i></i>' + h.en.map(l => `${l}<br>`).join('');
    D.haikuEn.classList.remove('lit');
    D.haikuPlace.classList.remove('lit');

    setBars(true); setCine(true);
    D.haiku.classList.add('on');
    at(0.9, () => D.haikuPlace.classList.add('lit'), 'haiku');
    const cols = [...D.haikuCols.children];
    cols.forEach((col, i) => at(1.3 + i * 2.0, () => col.classList.add('lit'), 'haiku'));
    at(1.3 + cols.length * 2.0 + 0.8, () => D.haikuEn.classList.add('lit'), 'haiku');
    const total = opts.hold != null ? opts.hold : 1.3 + cols.length * 2.0 + 6.4;
    cinemaUntil = Math.max(cinemaUntil, now + total + 2.0);
    claim(total + 2.0);
    at(total, () => {
      D.haiku.classList.remove('on');
      setBars(false); setCine(false);
      at(2.0, () => { haikuBusy = false; }, 'haiku');
    }, 'haiku');
  }

  // ---------------------------------------------------------------------------
  //  Photo-mode title card
  // ---------------------------------------------------------------------------
  // cardHolds is separate from cardBusy: once the card can be DEFERRED, "a card
  // is running" and "this card is currently holding the scrim/letterbox refs"
  // stop being the same thing, and releasing a ref you never took would steal
  // the scrim out from under whatever moment is actually on screen.
  let cardBusy = false, cardHolds = false;
  function titleCard(spec = {}, opts = {}) {
    const s = Object.assign({
      numeral: 'Chapter One', jp: '灰の道', title: 'The Road of Ash',
      sub: 'West Ridge', caption: '',
    }, spec);
    const wasBusy = cardBusy;
    cancel('card');
    if (cardHolds) { setCine(false); setBars(false); cardHolds = false; }
    cardBusy = true;
    D.cardJp.innerHTML = `<div class="vert">${chars(s.jp)}</div>`;
    const col = D.cardJp.firstElementChild;
    [...col.children].forEach((c, i) => { c.style.transitionDelay = `${0.22 * i}s`; });
    D.cardNum.textContent = s.numeral;
    D.cardTtl.textContent = s.title;
    D.cardSub.textContent = s.sub;
    D.cardCap.textContent = s.caption || placeCaption();
    // Queue behind a haiku rather than drawing over it.  The camp beat's
    // Chapter Three card fired in the same frame as the shrine beat's exit
    // haiku, so two vertical Japanese columns stacked on top of each other in
    // the same corner of the frame.  Capped, so a card can never be lost.
    // A card replacing a card is an explicit override and plays at once; only a
    // fresh card queues, and only behind a moment it did not itself schedule.
    const w = wasBusy ? 0 : Math.min(cinemaWait(), 24);
    at(w, () => {
      cardHolds = true;
      setBars(true); setCine(true);
      D.frame.classList.add('on');
      D.card.classList.add('on');
    }, 'card');
    at(w + 0.55, () => col.classList.add('lit'), 'card');
    const hold = (opts.hold != null ? opts.hold : 6.6) + w;
    cinemaUntil = Math.max(cinemaUntil, now + hold + 1.7);
    claim(hold + 1.7);
    at(hold, () => {
      D.card.classList.remove('on');
      D.frame.classList.remove('on');
      if (cardHolds) { setBars(false); setCine(false); cardHolds = false; }
      at(1.7, () => { col.classList.remove('lit'); cardBusy = false; }, 'card');
    }, 'card');
  }

  function placeCaption() {
    const t = ctx.tod ? ctx.tod.t : 0.72;
    const alt = ctx.tod ? ctx.tod.sunAltitude : 12;
    let when = 'Night';
    if (alt > 42) when = 'Midday';
    else if (alt > 22) when = t > 0.5 ? 'Late Afternoon' : 'Morning';
    else if (alt > -2) when = t > 0.5 ? 'Golden Hour' : 'First Light';
    else if (alt > -12) when = t > 0.5 ? 'Dusk' : 'Dawn';
    return `50mm · ${when}`;
  }

  // ---------------------------------------------------------------------------
  //  Prompt
  //
  //  This was the single worst offender in the whole interface.  quest.js raised
  //  it on beat enter and only dropped it on beat exit, which for the wind beat
  //  is however many minutes of traversal the player takes — so "Q CALL THE
  //  GUIDING WIND" was printed across the samurai's cloak in essentially every
  //  frame, and after dark the mount prompt was measured as the brightest object
  //  in the picture.  A prompt is a thing you read once.  It now waits for the
  //  rest of the type to clear, says its piece, and leaves on its own.
  // ---------------------------------------------------------------------------
  let promptKey = null;
  function prompt(key, text, hold = 6.5) {
    const k = key + '|' + text;
    if (promptKey === k) return;
    promptKey = k;
    cancel('prm');
    D.prm.classList.remove('on');
    // The prompt is the last thing in the queue and it re-checks the floor each
    // time it comes up, because a beat's enter() raises its dialogue before the
    // objective is published — so the queue in front of it grows after it has
    // already taken a ticket.  The deadline stops that becoming a wait forever.
    // A full-frame moment always outranks a key prompt, so the cinema clock is
    // waited out in full; ordinary type only gets `deadline` worth of patience;
    // and `hardStop` guarantees the prompt eventually shows no matter what.
    const deadline = now + 14, hardStop = now + 40;
    const raise = () => {
      let wait = 0;
      if (now < hardStop) {
        wait = cinemaUntil - now;
        if (wait <= 0.05 && now < deadline) wait = floorUntil - now;
      }
      if (wait > 0.05) { at(Math.min(wait, hardStop - now), raise, 'prm'); return; }
      D.prmKey.textContent = key;
      D.prmTxt.textContent = text;
      D.prm.classList.add('on');
      // Clear promptKey on the way out, so the same prompt can legitimately
      // come back the next time the player walks up to the same thing.
      if (hold > 0) at(hold, () => { D.prm.classList.remove('on'); promptKey = null; }, 'prm');
    };
    raise();
  }
  function hidePrompt() { cancel('prm'); promptKey = null; D.prm.classList.remove('on'); }

  // ---------------------------------------------------------------------------
  //  Stance flourish
  // ---------------------------------------------------------------------------
  function stance(name) {
    const s = STANCES[name] || STANCES[STANCE_ORDER[(name | 0) - 1]] || null;
    if (!s) return;
    D.stnJp.textContent = s[0];
    D.stnEn.textContent = s[1];
    cancel('stn');
    D.stn.classList.add('on');
    at(1.9, () => D.stn.classList.remove('on'), 'stn');
    claim(1.9 + 0.8);
  }

  // ---------------------------------------------------------------------------
  //  Vitals.  Absent until they matter, gone again a few seconds after they
  //  stop mattering.  Health is a hairline; resolve is a row of ink dots.
  // ---------------------------------------------------------------------------
  let lastCoordsAt = -1;
  const vit = { health: 1, resolve: 0, resolveMax: 5 };
  let vitShownUntil = -1, vitVisible = false, resolveDots = -1;

  function buildResolve(n) {
    if (resolveDots === n) return;
    resolveDots = n;
    D.res.innerHTML = new Array(Math.max(0, n)).fill('<i></i>').join('');
  }
  function paintVitals() {
    D.hpFill.style.transform = `scaleX(${Math.max(0, Math.min(1, vit.health))})`;
    D.hpFill.style.background = vit.health < 0.3
      ? 'linear-gradient(90deg,#d1512f,rgba(209,81,47,.8))'
      : 'linear-gradient(90deg,#e6c27c,rgba(230,194,124,.8))';
    buildResolve(vit.resolveMax);
    const kids = D.res.children;
    for (let i = 0; i < kids.length; i++) kids[i].classList.toggle('f', i < vit.resolve);
  }
  function surfaceVitals(seconds = 4.6) {
    vitShownUntil = now + seconds;
    if (!vitVisible) { vitVisible = true; D.vit.classList.add('on'); }
  }
  function setVitals(v = {}, quiet) {
    let changed = false;
    if (v.health != null) {
      const h = v.health > 1.5 ? v.health / 100 : v.health;
      if (Math.abs(h - vit.health) > 1e-4) { vit.health = h; changed = true; }
    }
    if (v.resolveMax != null && (v.resolveMax | 0) !== vit.resolveMax) { vit.resolveMax = v.resolveMax | 0; changed = true; }
    if (v.resolve != null) {
      const r = Math.max(0, Math.min(vit.resolveMax, v.resolve | 0));
      if (r !== vit.resolve) { vit.resolve = r; changed = true; }
    }
    if (!changed) return;
    paintVitals();
    if (!quiet) surfaceVitals();
  }
  function damage(n) { setVitals({ health: Math.max(0, vit.health - (n > 1.5 ? n / 100 : n)) }); }
  paintVitals();

  // ---------------------------------------------------------------------------
  //  Pause.  main.js owns the loop and must not be touched, so the pause takes
  //  the INPUT instead: input.scripted short-circuits poll(), which is exactly
  //  the hook the headless driver uses, and a capture-phase key listener eats
  //  the one-frame edges before input.js ever sees them.  The world keeps
  //  breathing behind the blur, which is what a real pause screen does anyway.
  // ---------------------------------------------------------------------------
  let paused = false, prevScripted = null;
  function setPaused(v) {
    if (v === paused) return;
    paused = v;
    D.pause.classList.toggle('on', v);
    const inp = ctx.input;
    if (v) {
      prevScripted = inp.scripted;
      inp.scripted = true;
      inp.move.x = 0; inp.move.y = 0; inp.sprint = false;
    } else {
      inp.scripted = prevScripted || null;
    }
  }
  //  Debug teleports. Same spirit as the coordinate readout: digits 5-9 map
  //  to the five key places, and quest.goto does the real work (beat entry,
  //  player placement, camera snap) so a jump can never strand the story.
  const TP_KEYS = { Digit5: 'shore', Digit6: 'village', Digit7: 'shrine', Digit8: 'camp', Digit9: 'duel' };
  function teleport(beat) {
    if (ctx.quest && typeof ctx.quest.goto === 'function') {
      const jumped = ctx.quest.goto(beat);
      if (jumped && paused) setPaused(false);
    }
  }
  if (D.tps) D.tps.addEventListener('click', (e) => {
    const b = e.target.closest('b[data-beat]');
    if (b) teleport(b.dataset.beat);
  });
  const onKey = (e) => {
    if (TP_KEYS[e.code]) {
      e.preventDefault(); e.stopImmediatePropagation();
      teleport(TP_KEYS[e.code]);
      return;
    }
    if (e.code === 'Escape' || e.code === 'KeyP') {
      e.preventDefault(); e.stopImmediatePropagation();
      setPaused(!paused);
      return;
    }
    if (paused) { e.preventDefault(); e.stopImmediatePropagation(); }
  };
  addEventListener('keydown', onKey, true);

  // ---------------------------------------------------------------------------
  //  Guiding wind trigger
  // ---------------------------------------------------------------------------
  let windCooldown = 0;
  function callWind() {
    if (windCooldown > 0) return false;
    windCooldown = 1.4;
    wind.spawn(2.6);
    reshowObjective(3.4);
    try { ctx.audio && ctx.audio.cue && ctx.audio.cue('wind'); } catch (_) { /* audio lane may not be up */ }
    return true;
  }

  // ---------------------------------------------------------------------------
  //  Per-frame
  // ---------------------------------------------------------------------------
  let lastQuestObj = null;
  let lastCombatStance = null;
  // A hard cut (a teleport, a scene change) is not a place for a title card to
  // still be hanging around.  The first one is allowed — that is the reveal
  // shot.  The second ends it.
  let jumps = 0;
  const lastPos = new THREE.Vector3().copy(ctx.player.position);

  function update(dt, c) {
    now += dt;
    runCues();
    if (windCooldown > 0) windCooldown -= dt;

    const inp = c.input;
    if (paused) { inp.move.x = 0; inp.move.y = 0; inp.sprint = false; }

    if (c.player.position.distanceToSquared(lastPos) > 2500) {
      lastPos.copy(c.player.position);
      if (++jumps >= 2) skipIntro(true);
    } else {
      lastPos.copy(c.player.position);
    }

    // Any deliberate act dismisses the title, the way a real game does.
    if (introRunning && !paused &&
        (inp.move.x || inp.move.y || inp.attack || inp.heavy || inp.dodge || inp.wind || inp.interact)) {
      skipIntro(true);
    }

    if (inp.wind && !paused) callWind();
    if (inp.stanceCycle && !paused) stance(STANCE_ORDER[(inp.stanceCycle - 1) % 4]);

    // Quest lane feeds objectives; accept a string or {text, eyebrow, hold}.
    const q = c.quest;
    if (q) {
      const o = q.currentObjective;
      const key = o == null ? null : (typeof o === 'string' ? o : (o.text || '') + '|' + (o.eyebrow || ''));
      if (key !== lastQuestObj) {
        lastQuestObj = key;
        if (o == null) clearObjective();
        else if (typeof o === 'string') objective(o);
        else objective(o.text, o.eyebrow, o.hold);
      }
    }

    // Combat lane feeds vitals and stance; both are optional.
    const cs = c.combat && c.combat.state;
    if (cs) {
      if (cs.stance && cs.stance !== lastCombatStance) {
        if (lastCombatStance !== null) stance(cs.stance);
        lastCombatStance = cs.stance;
      }
      setVitals({ health: cs.health, resolve: cs.resolve, resolveMax: cs.resolveMax });
      if (cs.inCombat) surfaceVitals(2.2);
    }
    if (c.player && c.player.health != null) setVitals({ health: c.player.health });

    // Vitals retire once they are full and nothing has happened for a while.
    if (vitVisible && now > vitShownUntil && vit.health >= 0.999 && vit.resolve === 0) {
      vitVisible = false;
      D.vit.classList.remove('on');
    }

    // Top-right coordinate readout. 10Hz is plenty for a navigation aid and
    // keeps text layout out of the hot path.
    if (now - lastCoordsAt > 0.1) {
      lastCoordsAt = now;
      const p = c.player.position;
      D.coords.textContent = `x ${p.x.toFixed(0)}  z ${p.z.toFixed(0)}  h ${p.y.toFixed(0)}`;
    }

    wind.update(dt, c);
  }

  const api = {
    el, update,
    objective, clearObjective, reshowObjective,
    say, sayAll, clearSay,
    haiku, titleCard, placeCaption,
    prompt, hidePrompt,
    stance, setVitals, damage, surfaceVitals,
    callWind, setPaused, skipIntro, replayIntro,
    // The quest lane needs to stage things a few seconds apart.  Handing it the
    // cue scheduler keeps that on the game clock — a setTimeout keeps counting
    // through a pause and lands its payload over the pause screen.
    after(delay, fn, tag) { at(delay, fn, tag || 'quest'); },
    get textBusy() { return now < floorUntil; },
    setLetterbox: forceBars,
    get paused() { return paused; },
    get busy() { return haikuBusy || cardBusy; },
    get vitals() { return vit; },
    wind, HAIKU,
    dispose() { removeEventListener('keydown', onKey, true); },
  };
  return api;
}
