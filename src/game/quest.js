import * as THREE from 'three';
import { heightAt, slopeAt } from '../world/terrain.js';

// The 60-minute arc. A linear beat machine: each beat arms itself on entry,
// polls a single completion condition, and hands off. Everything it drives goes
// through the other systems' real APIs, and every call is guarded so a beat can
// never hard-fail because a system is mid-rewrite.
//
// Coordinates below were taken from tools/pick.mjs against the real heightfield,
// not guessed — three earlier camera poses ended up underwater that way.

const SHORE   = { x: -743, z: 223 };   // west beach,   h 5.2,  dev 3.2
const MEADOW  = { x: -559, z: 85  };   // the village,  h 33.2, dev 1.4
const VALLEY  = { x: -375, z: -168 };  // the shrine,   h 30.6, dev 3.1
const SHELF   = { x: -444, z: -490 };  // the camp,     h 41.9, dev 2.9
const SUMMIT  = { x: -191, z: -697 };  // the duel,     h 219.7, dev 2.9
const RIDGE   = MEADOW;

const call = (o, m, ...a) => {
  if (!o || typeof o[m] !== 'function') { console.warn('[quest] missing', m); return; }
  // Never swallow silently: a caught TypeError here hid every line of dialogue,
  // every chapter title and every haiku in the game across two full waves.
  try { return o[m](...a); } catch (e) { console.error('[quest]', m, 'threw:', e.message); }
};
const dist2 = (a, bx, bz) => Math.hypot(a.x - bx, a.z - bz);

// ---------------------------------------------------------------------------
// Procedural props. Owned entirely by this file so no other lane collides.
// ---------------------------------------------------------------------------
const M = {
  wood:   new THREE.MeshStandardMaterial({ color: '#6a4a35', roughness: 0.9 }),
  vermil: new THREE.MeshStandardMaterial({ color: '#a83a28', roughness: 0.72 }),
  char:   new THREE.MeshStandardMaterial({ color: '#241d1a', roughness: 0.98 }),
  thatch: new THREE.MeshStandardMaterial({ color: '#8b7444', roughness: 0.97 }),
  stone:  new THREE.MeshStandardMaterial({ color: '#7d7a72', roughness: 0.92 }),
  cloth:  new THREE.MeshStandardMaterial({ color: '#2c3550', roughness: 0.86, side: THREE.DoubleSide }),
  paper:  new THREE.MeshStandardMaterial({ color: '#e8dcc0', roughness: 0.9, emissive: '#3a2a12', emissiveIntensity: 0.35 }),
};

// Nudge a prop to the flattest point in a small neighbourhood, and report how
// far the ground moves under it so callers can reject hopeless sites.
function settle(cx, cz, r = 6) {
  let best = { x: cx, z: cz, s: slopeAt(cx, cz) };
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    for (const rr of [r * 0.5, r]) {
      const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
      const sl = slopeAt(x, z);
      if (sl < best.s) best = { x, z, s: sl };
    }
  }
  return best;
}

function place(obj, x, z, yOff = 0) {
  obj.position.set(x, heightAt(x, z) + yOff, z);
  obj.rotation.y = (Math.sin(x * 0.7 + z * 0.3) * 0.5 + 0.5) * Math.PI * 2;
  obj.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return obj;
}

function torii(scale = 1) {
  const g = new THREE.Group();
  const post = new THREE.CylinderGeometry(0.19, 0.23, 4.4, 8);
  for (const s of [-1, 1]) {
    const p = new THREE.Mesh(post, M.vermil);
    p.position.set(s * 1.55, 2.2, 0); p.rotation.z = -s * 0.03;
    g.add(p);
  }
  const top = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.26, 0.5), M.vermil);
  top.position.y = 4.35; g.add(top);
  const cap = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.2, 0.62), M.vermil);
  cap.position.y = 4.62; cap.rotation.z = 0.012; g.add(cap);
  const tie = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.2, 0.34), M.vermil);
  tie.position.y = 3.5; g.add(tie);
  g.scale.setScalar(scale);
  return g;
}

function shrine() {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.5, 2.0), M.stone);
  base.position.y = 0.25; g.add(base);
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.3, 1.3), M.wood);
  body.position.y = 1.15; g.add(body);
  const roof = new THREE.Mesh(new THREE.ConeGeometry(1.6, 0.9, 4), M.char);
  roof.position.y = 2.25; roof.rotation.y = Math.PI / 4; g.add(roof);
  for (const s of [-1, 1]) {
    const l = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.42, 8), M.paper);
    l.position.set(s * 1.0, 1.5, 0.85); g.add(l);
  }
  return g;
}

function burnedHut(intact = false) {
  const g = new THREE.Group();
  const mat = intact ? M.wood : M.char;
  const walls = new THREE.Mesh(new THREE.BoxGeometry(3.4, 1.9, 3.0), mat);
  walls.position.y = 0.95; g.add(walls);
  if (intact) {
    const roof = new THREE.Mesh(new THREE.ConeGeometry(2.9, 1.5, 4), M.thatch);
    roof.position.y = 2.6; roof.rotation.y = Math.PI / 4; g.add(roof);
  } else {
    // Collapsed: a few charred beams left standing at angles.
    for (let i = 0; i < 5; i++) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.18, 2.6, 0.18), M.char);
      b.position.set((i - 2) * 0.7, 1.3, (i % 2 ? 1.2 : -1.2));
      b.rotation.z = (i - 2) * 0.16; b.rotation.x = (i % 2 ? 0.2 : -0.15);
      g.add(b);
    }
  }
  return g;
}

function camp() {
  const g = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const t = new THREE.Mesh(new THREE.ConeGeometry(1.5, 1.9, 6), M.cloth);
    t.position.set(Math.cos(a) * 6, 0.95, Math.sin(a) * 6);
    g.add(t);
  }
  const fire = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 0.24, 10), M.char);
  fire.position.y = 0.12; g.add(fire);
  for (const s of [-1, 1]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 3.6, 6), M.wood);
    pole.position.set(s * 8, 1.8, -7); g.add(pole);
    const ban = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 2.0), M.cloth);
    ban.position.set(s * 8 + 0.44, 2.2, -7); g.add(ban);
  }
  return g;
}

// ---------------------------------------------------------------------------
export function createQuest(ctx) {
  const props = new THREE.Group();
  props.name = 'quest-props';
  ctx.scene.add(props);

  // World dressing, placed once on the real heightfield.
  props.add(place(torii(1.15), SHORE.x + 14, SHORE.z - 26));
  // The village. Placed on flat ground and settled per-hut, so it reads as a
  // village from the objective marker rather than as debris on a cliff face.
  const h0 = heightAt(MEADOW.x, MEADOW.z);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + 0.4;
    const r = 13 + (i % 3) * 4;
    const c = settle(MEADOW.x + Math.cos(a) * r, MEADOW.z + Math.sin(a) * r, 5);
    if (Math.abs(heightAt(c.x, c.z) - h0) > 5) continue;   // never drape downhill
    props.add(place(burnedHut(i === 4 || i === 6), c.x, c.z));
  }
  // Smouldering posts at the centre so the beat has a focal point.
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.22, 2.2, 0.22), M.char);
    props.add(place(post, MEADOW.x + Math.cos(a) * 4.5, MEADOW.z + Math.sin(a) * 4.5, 1.1));
  }
  const shrineG = place(shrine(), VALLEY.x, VALLEY.z);
  props.add(shrineG);
  props.add(place(torii(0.9), VALLEY.x + 9, VALLEY.z + 5));
  props.add(place(camp(), SHELF.x, SHELF.z));
  props.add(place(torii(1.4), SUMMIT.x - 5, SUMMIT.z - 8));

  const state = {
    beat: 0, beatTime: 0, armed: false, done: false,
    kills: 0, killsAtBeatStart: 0, started: false,
    promptShown: null, gallopHinted: false, gallopHintT: 0,
  };
  const guideTarget = new THREE.Vector3();
  let liveEnemies = 0;
  let attached = false;

  const P = () => ctx.player ? ctx.player.position : new THREE.Vector3();
  const kills = () => (ctx.combat && ctx.combat.state && ctx.combat.state.kills) || 0;
  const aliveCount = () => {
    const l = ctx.enemies && ctx.enemies.list;
    if (!l) return 0;
    let n = 0;
    for (const e of l) if (!e.dead && e.hp === undefined ? true : (e.hp > 0)) n++;
    return n;
  };
  // Actually remove combatants near a point. reset() only de-alerts them, which
  // left a duelist standing 0.2m from the player through the ending shot.
  const clearNearby = (radius = 260) => {
    call(ctx.enemies, 'reset');
    const l = ctx.enemies && ctx.enemies.list;
    if (!l) return;
    const p = P();
    for (const e of l) {
      const q = e.root && e.root.position;
      if (!q || Math.hypot(q.x - p.x, q.z - p.z) > radius) continue;
      e.dead = true; e.st = 'dead'; e.hp = 0; e.health = 0;
      if (e.root.parent) e.root.parent.remove(e.root);
      e.root.visible = false;
    }
  };

  const spawnRing = (cx, cz, n, kind, r = 9) => {
    liveEnemies = 0;
    const h0 = heightAt(cx, cz);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + 0.3;
      let x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      // Reject cliffs AND big vertical offsets: the village raiders once spawned
      // at y=38.9 and y=22.0 across 22m of ground, invisible from the marker.
      let ok = false;
      for (let t = 0; t < 16 && !ok; t++) {
        const aa = a + t * 0.42, rr = r * (1 - t * 0.045);
        x = cx + Math.cos(aa) * rr; z = cz + Math.sin(aa) * rr;
        ok = slopeAt(x, z) < 0.26 && Math.abs(heightAt(x, z) - h0) < 2.6;
      }
      if (!ok) { x = cx + Math.cos(a) * 5; z = cz + Math.sin(a) * 5; }
      call(ctx.enemies, 'spawn', x, z, kind);
      liveEnemies++;
    }
  };

  // -------------------------------------------------------------------------
  // The arc. `to` is the guiding-wind target; `at` is the arrival radius.
  // -------------------------------------------------------------------------
  const BEATS = [
    {
      id: 'shore', from: SHORE, jp: '漂着', en: 'The Tide Line', tod: 0.728,
      obj: 'Walk inland', to: MEADOW, at: 999,
      enter() {
        call(ctx.hud, 'titleCard', { numeral: '', jp: '風の道', title: 'Way of the Wind', sub: 'Tsushima, the eleventh month' });
        call(ctx.audio, 'setIntensity', 0.15);
        call(ctx.hud, 'say', '', 'The sea gave you back. The island did not ask why.', 5.2);
      },
      done: () => dist2(P(), SHORE.x, SHORE.z) > 60,
    },
    {
      id: 'wind', from: { x: SHORE.x - 40, z: SHORE.z - 70 }, jp: '導き風', en: 'The Guiding Wind', tod: 0.716,
      obj: 'Follow the wind to the village', to: MEADOW, at: 40,
      enter() {
        // The line first, the key last. This beat used to raise the objective,
        // the line and the centred key prompt in one frame, and the prompt then
        // stayed up until the beat ended — minutes of traversal with "Q CALL
        // THE GUIDING WIND" printed across the samurai. The HUD serialises them
        // now; the order here is what decides which one the player reads first.
        call(ctx.hud, 'say', '', 'The wind knows this island better than any map.', 5.0);
        call(ctx.hud, 'prompt', 'Q', 'call the guiding wind');
        call(ctx.audio, 'setIntensity', 0.25);
      },
      done: () => dist2(P(), MEADOW.x, MEADOW.z) < 40,
      exit() { call(ctx.hud, 'hidePrompt'); },
    },
    {
      id: 'village', from: { x: MEADOW.x + 13, z: MEADOW.z + 13 }, jp: '焼村', en: 'What the Fire Left', tod: 0.72,
      obj: 'Clear the raiders', to: MEADOW, at: 0,
      enter() {
        call(ctx.hud, 'titleCard', { numeral: 'Chapter One', jp: '焼村', title: 'What the Fire Left', sub: 'Kayano Village' });
        call(ctx.hud, 'say', '', 'Six houses. Five of them ash.', 4.2);
        call(ctx.audio, 'setIntensity', 0.85);
        call(ctx.gcam, 'setMode', 'combat');
        spawnRing(MEADOW.x, MEADOW.z, 2, 'raider', 11);
        state.killsAtBeatStart = kills();
      },
      done: () => kills() - state.killsAtBeatStart >= 2 || state.beatTime > 900,
      exit() {
        call(ctx.gcam, 'setMode', 'auto');
        call(ctx.audio, 'setIntensity', 0.3);
        call(ctx.hud, 'haiku', 'ash');
      },
    },
    {
      id: 'ride', from: MEADOW, jp: '遠乗り', en: 'The Long Way Inland', tod: 0.724,
      obj: 'Ride for the shrine', to: VALLEY, at: 34,
      enter() {
        call(ctx.hud, 'say', '', 'A horse still stands in the paddock. It has been waiting.', 5.0);
        call(ctx.audio, 'setIntensity', 0.2);
        call(ctx.gcam, 'cinematic', 'establish', { hold: 3.4 });
      },
      done: () => dist2(P(), VALLEY.x, VALLEY.z) < 34,
      exit() { call(ctx.hud, 'hidePrompt'); },
    },
    {
      id: 'shrine', from: { x: VALLEY.x + 46, z: VALLEY.z + 46 }, jp: '社', en: 'The Shrine in the Cut', tod: 0.712,
      obj: 'Pay respects at the shrine', to: VALLEY, at: 7,
      enter() {
        call(ctx.hud, 'titleCard', { numeral: 'Chapter Two', jp: '社', title: 'The Shrine in the Cut', sub: 'Kawakami' });
        call(ctx.audio, 'setIntensity', 0.1);
      },
      done: () => dist2(P(), VALLEY.x, VALLEY.z) < 7 && state.beatTime > 4,
      exit() {
        call(ctx.hud, 'haiku', 'sunset');
        call(ctx.hud, 'say', 'Sensei', 'Stone stance. Break their guard before they find yours.', 5.4);
      },
    },
    {
      id: 'camp', from: { x: SHELF.x + 14, z: SHELF.z + 14 }, jp: '陣', en: 'The Occupied Camp', tod: 0.734,
      obj: 'Take back the camp', to: SHELF, at: 0,
      enter() {
        call(ctx.hud, 'titleCard', { numeral: 'Chapter Three', jp: '陣', title: 'The Occupied Camp', sub: 'The Inland Shelf' });
        call(ctx.audio, 'setIntensity', 1.0);
        call(ctx.gcam, 'setMode', 'combat');
        spawnRing(SHELF.x, SHELF.z, 4, 'raider', 12);
        state.killsAtBeatStart = kills();
      },
      done: () => kills() - state.killsAtBeatStart >= 4 || state.beatTime > 900,
      exit() { call(ctx.gcam, 'setMode', 'auto'); call(ctx.audio, 'setIntensity', 0.35); },
    },
    {
      id: 'ambush', from: SHELF, jp: '伏兵', en: 'They Were Waiting', tod: 0.739,
      obj: 'Survive the ambush', to: SHELF, at: 0,
      enter() {
        call(ctx.hud, 'say', '', 'The camp was the bait.', 3.6);
        call(ctx.gcam, 'shake', 0.5, 0.6);
        call(ctx.audio, 'setIntensity', 1.0);
        call(ctx.gcam, 'setMode', 'combat');
        spawnRing(P().x, P().z, 3, 'raider', 14);
        state.killsAtBeatStart = kills();
      },
      done: () => kills() - state.killsAtBeatStart >= 3 || state.beatTime > 900,
      exit() { call(ctx.gcam, 'setMode', 'auto'); call(ctx.audio, 'setIntensity', 0.25); },
    },
    {
      id: 'climb', from: { x: SUMMIT.x - 150, z: SUMMIT.z - 150 }, jp: '登り', en: 'Last Light', tod: 0.744,
      obj: 'Climb to the summit', to: SUMMIT, at: 40,
      enter() {
        call(ctx.hud, 'titleCard', { numeral: 'Chapter Four', jp: '登り', title: 'Last Light', sub: 'The Long Ascent' });
        call(ctx.audio, 'setIntensity', 0.18);
        call(ctx.hud, 'say', '', 'He will be at the top. He always meant to be.', 5.0);
      },
      done: () => dist2(P(), SUMMIT.x, SUMMIT.z) < 40,
    },
    {
      id: 'duel', from: { x: SUMMIT.x + 12, z: SUMMIT.z + 12 }, jp: '果し合い', en: 'The Duel', tod: 0.749,
      obj: 'Duel', to: SUMMIT, at: 0,
      enter() {
        call(ctx.hud, 'titleCard', { numeral: 'Chapter Five', jp: '果し合い', title: 'The Duel', sub: 'Sakai no Ryūzō' });
        call(ctx.audio, 'setIntensity', 1.0);
        call(ctx.gcam, 'setMode', 'combat');
        call(ctx.gcam, 'cinematic', 'standoff', {});
        spawnRing(SUMMIT.x, SUMMIT.z, 1, 'duelist', 8);
        state.killsAtBeatStart = kills();
      },
      done: () => kills() - state.killsAtBeatStart >= 1 || state.beatTime > 900,
      exit() { call(ctx.gcam, 'setMode', 'auto'); },
    },
    {
      id: 'end', from: SUMMIT, jp: '結', en: 'What the Wind Keeps', tod: 0.757,
      obj: '', to: SUMMIT, at: 0,
      enter() {
        clearNearby(400);          // the closing shot is one figure, on purpose
        call(ctx.audio, 'setIntensity', 0.06);
        call(ctx.hud, 'clearObjective');
        call(ctx.hud, 'haiku', 'sea');
        call(ctx.gcam, 'cinematic', 'establish', { hold: 8 });
        // On the game clock, not setTimeout: a pause during the closing shot
        // used to leave the end card to land on top of the pause screen.
        call(ctx.hud, 'after', 9.0, () => call(ctx.hud, 'titleCard',
          { numeral: '', jp: '風の道', title: 'Way of the Wind', sub: '終' }, { hold: 12 }));
      },
      done: () => false,
    },
  ];

  function enterBeat(i) {
    const b = BEATS[i];
    if (!b) return;
    state.beat = i; state.beatTime = 0;
    call(ctx.hud, 'hidePrompt');
    guideTarget.set(b.to.x, heightAt(b.to.x, b.to.z), b.to.z);
    if (typeof b.tod === 'number' && ctx.tod) ctx.tod.t = b.tod;
    b.enter && b.enter();
    // The objective is published, not pushed, and it is published AFTER enter().
    //
    // Two reasons. First, this used to call hud.objective() here *and* set
    // currentObjective, which hud.update polls — so every beat raised the same
    // objective twice, the second one clobbering the first's hold and replaying
    // the rule wipe. One writer now. Second, setting it after enter() means a
    // beat that opens on a chapter card has already told the HUD the screen is
    // busy, so the objective queues behind the card instead of printing across
    // it. hud runs after quest in main.js's system order, so it still lands on
    // this same frame.
    api.currentObjective = b.obj ? { text: b.obj, eyebrow: b.en || '', hold: 6.5 } : null;
    state.armed = true;
  }

  const api = {
    state, props, BEATS,
    guideTarget,
    currentObjective: null,
    get beatId() { return BEATS[state.beat] ? BEATS[state.beat].id : null; },

    // Debug hooks — attached to window.__GAME on the first frame, since main.js
    // builds that object after this module is constructed.
    goto(n) {
      const i = typeof n === 'string' ? BEATS.findIndex(b => b.id === n) : n;
      if (i < 0 || i >= BEATS.length) return false;
      const b = BEATS[i];
      const prev = BEATS[state.beat];
      if (prev && prev !== b && prev.exit) { try { prev.exit(); } catch (e) { console.error('[quest] exit', e.message); } }
      call(ctx.hud, 'hidePrompt');
      call(ctx.enemies, 'reset');
      const f = b.from || b.to;
      if (ctx.player) ctx.player.setPosition(f.x, 0, f.z, -9);
      call(ctx.gcam, 'snap');
      enterBeat(i);
      return true;
    },
    next() { return api.goto(Math.min(state.beat + 1, BEATS.length - 1)); },
    list() { return BEATS.map((b, i) => ({ i, id: b.id, en: b.en, obj: b.obj })); },

    update(dt) {
      if (!state.started) {
        state.started = true;
        // Open where the story opens. main.js spawns the player on the ridge,
        // which is ~700m from the shore, so beat 0 completed on frame one and
        // the arc silently began at beat 1.
        const b0 = BEATS[0];
        if (ctx.player && b0.from) ctx.player.setPosition(b0.from.x, 0, b0.from.z, 200);
        call(ctx.gcam, 'snap');
        enterBeat(0);
      }
      // main.js assigns window.__GAME *after* the first frame runs, so this has
      // to keep trying rather than attach once and give up.
      if (!attached && typeof window !== 'undefined' && window.__GAME) {
        attached = true;
        window.__GAME.quest = {
          goto: api.goto, next: api.next, list: api.list,
          get beat() { return state.beat; },
          get beatId() { return api.beatId; },
        };
      }
      state.beatTime += dt;
      const b = BEATS[state.beat];
      if (!b || state.done) return;

      // Contextual mount prompt. The horse was always rideable — nothing ever
      // told the player which key, so it read as broken.
      const h = ctx.horse;
      if (h && h.position) {
        const near = Math.hypot(P().x - h.position.x, P().z - h.position.z) < 9;
        const want = near && !h.mounted ? 'mount' : (h.mounted && !state.gallopHinted ? 'gallop' : null);
        if (want !== state.promptShown) {
          state.promptShown = want;
          if (want === 'mount') call(ctx.hud, 'prompt', 'F', 'mount');
          else if (want === 'gallop') { call(ctx.hud, 'prompt', 'Shift', 'gallop'); state.gallopHintT = 0; }
          else call(ctx.hud, 'hidePrompt');
        }
        if (state.promptShown === 'gallop') {
          state.gallopHintT = (state.gallopHintT || 0) + dt;
          if (state.gallopHintT > 6) { state.gallopHinted = true; state.promptShown = null; call(ctx.hud, 'hidePrompt'); }
        }
      }

      // The guiding wind always points at the current objective. quest runs
      // before hud in main.js's system order, so this is the call that actually
      // spawns the gust. On an ACCEPTED press hud's own Q handler then no-ops
      // on the cooldown this sets. On a REJECTED one it does NOT: input.wind
      // stays true for the whole frame (input.consume() runs after every
      // system), so hud.js:1403 still calls its local callWind() and reshows
      // the objective ~2 ms after a blowToward that returned false. Measured.
      // That last leak has to be closed in hud.js, which this lane does not own.
      if (ctx.wind && ctx.hud && ctx.input && ctx.input.wind) {
        // THE WIND IS THE AUTHORITY, not the HUD. This used to gate on
        // hud.callWind(), whose cooldown is 1.4 s, while wind.blowToward()'s
        // RETRIGGER_LOCK is 1.5 s — and blowToward's return value was thrown
        // away. In the 100 ms between those two numbers a second Q press lit
        // the HUD flourish and re-pulsed the leaf field while the corridor
        // itself refused to relaunch. Measured: press at t=0.06 and t=1.54,
        // the corridor head sailed on 30.6 -> 80.2 m and decayed to 0 at
        // t=4.06 s (one gust, correctly), but the leaf pulse jumped
        // 1.013 -> 1.5 — the leaves restarting a beat the wind had ignored.
        //
        // blowToward() returns false when it is still locked. Everything that
        // PRESENTS the gust now hangs off that boolean, so the flourish, the
        // objective re-show and the leaf burst can only ever describe a gust
        // that actually launched.
        //
        // 4.0 is passed explicitly rather than leaning on wind.js's
        // MIN_DURATION floor: the head travels at 20 m/s (was 46) and needs
        // 4 s to cross the field, and vfx.guidingWind is given the same 4.0 so
        // the leaves and the corridor decay together. At the old 2.4 the leaves
        // fell back to the prevailing drift while the grass and trees were
        // still leaning down the lane.
        if (call(ctx.wind, 'blowToward', P(), guideTarget, 4.0)) {
          call(ctx.hud, 'callWind');
          // The leaf burst that sells the beat. vfx.guidingWind() has existed
          // since the vfx lane wrote it and had zero call sites, so the one
          // moment the whole navigation design rests on was firing with no
          // visible leaves at all. vfx hangs off the world module, not ctx.
          const vfx = ctx.world && ctx.world.vfx;
          if (vfx) call(vfx, 'guidingWind', 1.6, 4.0);
        }
      }

      if (b.done && b.done()) {
        b.exit && b.exit();
        if (state.beat + 1 < BEATS.length) enterBeat(state.beat + 1);
        else state.done = true;
      }
    },
  };

  return api;
}
