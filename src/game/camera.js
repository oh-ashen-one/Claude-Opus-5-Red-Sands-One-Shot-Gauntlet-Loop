import * as THREE from 'three';

// =============================================================================
//  KAZE NO MICHI — game camera / cinematography
//
//  This file owns where the lens is and what it is pointed at. Nothing in the
//  rig snaps. Position, aim, boom length, field of view and the composition
//  biases each run through their own damped spring with its own stiffness, so
//  the camera has a body: it is dragged out behind you when you accelerate, it
//  settles when you stop, it ducks under a hillside rather than through it.
//
//  Layers, in the order they are applied:
//
//    1. subject      Player, or the horse when mounted. Velocity is measured
//                    from position deltas, never taken on faith, so a teleport
//                    cannot inject a bogus 400 m/s into the trailing solver.
//    2. orientation  Mouse look plus a gated auto-recentre that cannot enter
//                    the yaw feedback loop naive follow rigs spiral in — see
//                    recentre().
//    3. composition  The land in front of the lens is sampled out to 620 m. As
//                    it falls away the boom rises and the aim lifts, so wide
//                    shots carry a high horizon and the frame fills with island
//                    instead of sky. In a hollow both relax to neutral.
//    4. trailing     The anchor is pulled backwards along the velocity vector
//                    under acceleration and released as speed settles.
//    5. collision    The boom is marched against the analytic ground and cut
//                    where it would enter it. Biting in is stiff, recovery is
//                    soft, and the committed position is smooth-maxed above the
//                    terrain — the last word, so the lens can never be inside a
//                    hill or under the sea.
//    6. combat       A second solver framing player and locked opponent
//                    together, orbiting off-axis so the duel reads in depth.
//    7. cinematic    Virtual cameras (push-in, establishing hold, standoff
//                    over-the-shoulder, orbit) cross-faded over the gameplay
//                    solution, which keeps solving underneath so release is
//                    seamless at any moment.
//    8. handheld     Low-frequency operator noise scaled by speed and combat
//                    heat, plus a decaying stack of impact impulses.
//    9. safe frame   The guarantee. Whatever the layers above did, the subject
//                    is rotated back inside the frame before the matrix is
//                    committed. The player cannot leave the screen.
//
//  Everything is analytic. Nothing allocates per frame.
// =============================================================================

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const sat = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoother01 = (t) => { t = sat(t); return t * t * t * (t * (t * 6 - 15) + 10); };

// Shortest signed arc from a to b, in (-PI, PI].
const angleDelta = (a, b) =>
  THREE.MathUtils.euclideanModulo(b - a + Math.PI, Math.PI * 2) - Math.PI;

// Polynomial smooth maximum. The ground clamp needs this: a hard Math.max pops
// the lens every time it crosses a bump; this is C1 and eases over it.
function smax(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k * 0.25;
}

// -----------------------------------------------------------------------------
//  Damped spring, implicit-Euler form — unconditionally stable at any dt, which
//  matters because the frame after a teleport can be a very long one.
//    omega  angular frequency, rad/s. Higher = stiffer, arrives sooner.
//    zeta   damping ratio. 1 critical, <1 overshoots, >1 crawls in.
// -----------------------------------------------------------------------------
function springScalar(S, key, target, omega, zeta, dt) {
  const v = S[key + 'V'] || 0;
  const x = S[key];
  const D = 1 + 2 * dt * zeta * omega + dt * dt * omega * omega;
  const nv = (v - dt * omega * omega * (x - target)) / D;
  S[key + 'V'] = nv;
  S[key] = x + dt * nv;
  return S[key];
}

const _sv = new THREE.Vector3();
function springVec(pos, vel, target, omega, zeta, dt) {
  const D = 1 + 2 * dt * zeta * omega + dt * dt * omega * omega;
  _sv.copy(pos).sub(target).multiplyScalar(dt * omega * omega);
  vel.sub(_sv).divideScalar(D);
  pos.addScaledVector(vel, dt);
}

// -----------------------------------------------------------------------------
//  Deterministic smooth noise: three incommensurate sines per channel. Cheap,
//  continuous in every derivative, and it does not visibly loop in a session.
// -----------------------------------------------------------------------------
function wob(t, seed) {
  return Math.sin(t * 1.317 + seed * 2.173) * 0.55
       + Math.sin(t * 2.191 + seed * 5.311) * 0.30
       + Math.sin(t * 4.073 + seed * 1.091) * 0.15;
}
function rattle(t, seed) {
  return Math.sin(t * 33.7 + seed * 3.71) * 0.62
       + Math.sin(t * 57.3 + seed * 1.93) * 0.26
       + Math.sin(t * 91.1 + seed * 7.17) * 0.12;
}

// -----------------------------------------------------------------------------
//  Tuning. Everything a director would reach for lives in one block.
// -----------------------------------------------------------------------------
const CFG = {
  // boom
  distWalk: 5.15, distSprint: 5.90, distRide: 7.90, distMin: 3.05, distMax: 15.0,
  pivotHeight: 1.62, pivotHeightRide: 2.10,
  shoulder: 0.55,                 // lateral rig offset: seats the subject left of centre
  shoulderCombat: 0.28,

  // orientation
  lookSensX: 0.0024, lookSensY: 0.0019,
  // pitchUserMax sits at pitchMax minus the vista bias on purpose: any further
  // and the last quarter of a mouse pull down is a dead zone, because the
  // composed clamp below eats it.
  pitchUserMin: -0.55, pitchUserMax: 0.355,
  pitchMin: -0.62, pitchMax: 0.40,
  pitchCamMax: 0.46,              // the boom may sit higher than the aim, but not
                                  // by much: past this the frame is all dirt
  // Neutral elevation. This was 0.115, and with the vista bias on top the boom
  // sat 14.3 degrees up — measured, that puts the lens a full metre ABOVE the
  // character's head, so it must tilt 17 degrees down to hold him and the
  // horizon is shoved to the top eighth of the frame. The reference frames all
  // shoot from roughly the character's own head height with a near-level lens.
  // 0.055 + 0.045 of vista bias is that: the horizon lands on the upper third.
  pitchBase: 0.055,
  manualHold: 1.05,               // seconds of no auto authority after a mouse nudge
  recentreWalk: 0.55, recentreGallop: 1.70, recentreDead: 0.155,
  levelRate: 0.16,                // how fast the user's pitch drifts back to neutral

  // springs
  posOmega: 8.4, posZeta: 0.92,
  posOmegaCombat: 12.5, posZetaCombat: 1.05,
  lookOmega: 6.0, lookZeta: 1.00,
  distIn: 26.0, distOut: 4.2,     // collision bite / recovery
  fovOmega: 5.4, fovZeta: 0.95,

  // trailing. Two terms, and the split is the whole point: the velocity term is
  // a small steady lag that says "moving", the acceleration term is the big one
  // and it collapses to nothing the moment speed stops changing — so the lens is
  // dragged out of the launch and then glides back in as the run settles.
  trailPerSpeed: 0.045, trailPerAccel: 0.055, trailLift: 0.022, trailMax: 1.7,
  trailOmega: 3.4, trailZeta: 0.90,
  boomCap: 1.22,                  // hard ceiling on lag: boom never exceeds want * this

  // lens. 50 vertical is 78 horizontal at 16:9 — a full third wider than the
  // reference, which is why our vistas read small and our subject reads like a
  // portrait. 45 is 72 horizontal: still a travelling lens, but it compresses
  // the distance bands instead of throwing them away at the edges.
  fovBase: 45.0, fovSpeedGain: 4.0, fovGallopGain: 5.0, fovCombat: -2.5,
  fovFrameFill: 0.62,             // subject may fill this much of the half-frame
  fovMax: 68.0,

  // composition
  horizonBias: 0.045,             // extra boom elevation at full openness
  aimLift: 0.02,                  // look-above-pivot: seats the subject low in frame
  aimLiftVista: 0.10,             // a little more of it when the land opens up

  // framing. The subject is PLACED, not centred. Aiming the lens at the body
  // pins him to the optical axis, and an axis-centred subject with a centred
  // horizon quarters the frame — the least dynamic picture available, and what
  // every critic pass has called out. These are the marks he is put on instead:
  // a third across, a little below centre, so the sky owns the top of the frame
  // and the land runs out to one side of him.
  frameX: 0.33, frameY: -0.10,
  frameChest: 0.98,               // the body point that lands on the mark
  frameOmega: 1.3,                // how slowly the chosen side may swap over
  pitchViewMax: 0.40,             // the horizon guarantee: the committed lens is
                                  // never pitched further down than this

  // collision
  clearance: 0.62, groundClamp: 0.92, marchSteps: 16, refineSteps: 4,
  liftSteps: 8,                   // march resolution while trying boom elevations
  liftOmegaUp: 13.0, liftOmegaDown: 2.4,

  // handheld
  handheldIdle: 0.0018, handheldMove: 0.0058, handheldCombat: 0.0095,
  handheldPos: 0.024,
  bankPerAccel: 0.0080, bankMax: 0.055,

  // safe frame, in normalised device coords the subject may never pass
  safeX: 0.74, safeYTop: 0.72, safeYBot: 0.70,
};

// module scratch — update() must not allocate
const _v0 = new THREE.Vector3(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3(), _v5 = new THREE.Vector3();
const _fwd = new THREE.Vector3(), _rgt = new THREE.Vector3(), _up = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
let SEED = 0;

export function createGameCamera(ctx) {
  const { camera, world } = ctx;
  const seaLevel = (world.ISLAND && world.ISLAND.seaLevel) || 0;

  // Ground truth for anything the lens must stay out of. The sea counts — a
  // camera under the waterline is as broken as one inside a hill.
  const groundY = (x, z) => {
    const h = world.heightAt(x, z);
    return h > seaLevel ? h : seaLevel;
  };

  // --- rig state -------------------------------------------------------------
  let yaw = 0;
  let pitchUser = CFG.pitchBase;   // the player's own elevation, never stolen back
  let pitch = CFG.pitchBase;       // pitchUser + composition — the steerable one
  // The boom's own elevation: pitch plus whatever the obstruction solver had to
  // climb. It is kept SEPARATE from `pitch` on purpose. combat.js soft-locks by
  // servoing gcam.pitch back to 0.16 through injected look deltas; when the
  // reported pitch included the climb, the servo fought the hillside and drained
  // pitchUser to -0.48 rad (measured, 06-forest), which collapsed the boom to
  // distMin and left the safe frame tilting the lens 23 degrees into the dirt.
  // Nothing outside this file may see the collision term.
  let pitchCam = CFG.pitchBase;
  let manualTimer = 0;
  let time = 0;
  let boot = true;

  const S = {
    dist: CFG.distWalk, distV: 0,
    fov: CFG.fovBase, fovV: 0,
    horizon: 0, horizonV: 0,       // composition elevation, sprung so it never steps
    vista: 0, vistaV: 0,
    lift: 0, liftV: 0,             // extra boom elevation bought by climbing an obstruction
    bank: 0, bankV: 0,
    combatW: 0, combatWV: 0,       // blend into the duel solver
    engage: 0,                     // recent-violence heat, decays
    orbitSide: 1,
    frameSide: -0.75, frameSideV: 0,   // -1 subject left of frame, +1 right
  };

  const camPos = new THREE.Vector3(), camVel = new THREE.Vector3();
  const lookPos = new THREE.Vector3(), lookVel = new THREE.Vector3();
  const trail = new THREE.Vector3(), trailVel = new THREE.Vector3();

  const subjPos = new THREE.Vector3(), subjPrev = new THREE.Vector3();
  const subjVel = new THREE.Vector3(), subjVelPrev = new THREE.Vector3();
  const subjAcc = new THREE.Vector3();
  const pivot = new THREE.Vector3(), ideal = new THREE.Vector3(), aim = new THREE.Vector3();
  const finalPos = new THREE.Vector3(), finalLook = new THREE.Vector3();
  const lookOverride = new THREE.Vector3();
  let hasLookOverride = false;

  let subjSpeed = 0, subjYaw = 0, mounted = false;

  // shake stack — impulses stay independent, so a blade landing during a
  // collapse reads as both rather than whichever wrote last
  const shakes = [];
  const shakeOff = new THREE.Vector3();
  let shakeYaw = 0, shakePitch = 0, shakeRoll = 0, shakeAmt = 0;

  let lockTarget = null, modeReq = 'auto';

  let cine = null;
  const cinePos = new THREE.Vector3(), cineLook = new THREE.Vector3();
  let cineFov = CFG.fovBase;

  // ===========================================================================
  //  SUBJECT
  // ===========================================================================
  function readSubject(dt, c) {
    const horse = c.horse, player = c.player;
    mounted = !!(player && player.mounted) || !!(horse && horse.mounted);
    const src = (mounted && horse && horse.position) ? horse.position : player.position;

    subjPrev.copy(subjPos);
    subjPos.copy(src);

    if (dt > 1e-5 && !boot) {
      subjVelPrev.copy(subjVel);
      _v0.copy(subjPos).sub(subjPrev).divideScalar(dt);
      if (_v0.lengthSq() > 3600) _v0.set(0, 0, 0);   // that was a teleport, not a sprint
      subjVel.lerp(_v0, 1 - Math.exp(-14 * dt));
      _v1.copy(subjVel).sub(subjVelPrev).divideScalar(dt);
      if (_v1.lengthSq() > 40000) _v1.set(0, 0, 0);
      subjAcc.lerp(_v1, 1 - Math.exp(-9 * dt));
    } else {
      subjVel.set(0, 0, 0); subjVelPrev.set(0, 0, 0); subjAcc.set(0, 0, 0);
    }
    subjSpeed = Math.hypot(subjVel.x, subjVel.z);

    if (subjSpeed > 0.35) subjYaw = Math.atan2(subjVel.x, subjVel.z);
    else if (player && typeof player.yaw === 'number') subjYaw = player.yaw;
  }

  // ===========================================================================
  //  ORIENTATION
  //
  //  The trap in every third-person rig: the player steers relative to camera
  //  yaw, so a camera that chases the player's heading closes a positive
  //  feedback loop — hold strafe+forward and the whole world spins forever.
  //  The gate kills it by collapsing recentre authority as strafe input rises.
  //  With pure forward input both angles converge on one value and the loop is
  //  stable; with hard strafe the authority is a sixth of that, which reads as
  //  the camera leaning into the arc instead of driving it.
  // ===========================================================================
  function recentre(dt, c) {
    const inp = c.input;
    const lx = (inp.look && inp.look.x) || 0;
    const ly = (inp.look && inp.look.y) || 0;
    if (lx !== 0 || ly !== 0) manualTimer = CFG.manualHold;
    yaw -= lx * CFG.lookSensX;
    pitchUser = clamp(pitchUser + ly * CFG.lookSensY, CFG.pitchUserMin, CFG.pitchUserMax);
    manualTimer = Math.max(0, manualTimer - dt);
    if (manualTimer > 0) return;

    const mx = Math.abs((inp.move && inp.move.x) || 0);
    const my = Math.max(0, (inp.move && inp.move.y) || 0);
    const gate = my * (1 - 0.82 * mx) * sat(subjSpeed / 2.4);

    // A long run quietly returns the elevation to neutral. Slow enough that it
    // never feels like the camera is arguing.
    if (gate > 0.4) {
      pitchUser += clamp(CFG.pitchBase - pitchUser, -CFG.levelRate * dt, CFG.levelRate * dt);
    }

    if (S.combatW > 0.5) return;   // the duel solver owns yaw
    if (gate <= 1e-3) return;

    const gallop = sat((subjSpeed - 4.0) / 6.0);
    const rate = lerp(CFG.recentreWalk, CFG.recentreGallop, gallop) * gate;
    const err = angleDelta(yaw, subjYaw);
    const mag = Math.abs(err) - CFG.recentreDead;
    if (mag <= 0) return;
    yaw += clamp(Math.sign(err) * mag * 3.0, -rate, rate) * dt;
  }

  // ===========================================================================
  //  COMPOSITION
  //
  //  openness is 1 when everything ahead of the lens falls below eye level out
  //  to 620 m, and 0 when a slope walls the shot off. On an open vista the boom
  //  rises and the aim lifts: the lens tilts down, the horizon climbs toward
  //  the upper third, the frame fills with island. Facing a hillside both relax
  //  so the camera is not left staring at dirt two metres ahead.
  // ===========================================================================
  const RANGES = [30, 70, 140, 250, 400, 620];
  function openness(x, z, dx, dz, eyeY) {
    let worst = -1;
    for (let i = 0; i < RANGES.length; i++) {
      const d = RANGES[i];
      const a = (groundY(x + dx * d, z + dz * d) - eyeY) / d;
      if (a > worst) worst = a;
    }
    return sat(1 - (worst + 0.035) / 0.30);
  }

  // Which half of the frame has the lower skyline. A subject parked on the
  // third line at 0.33 of the half-frame sits about 13 degrees off the optical
  // axis, so these are the two rays his silhouette will actually be read
  // against. He belongs in front of the OPEN one: a dark figure against lit sky
  // reads instantly, the same figure against a hillside merges into it — a
  // critic measured exactly that, head and shoulders lost in a (22,29,43) tree
  // band. Returns -1 to put him left of frame, +1 right.
  const SIDE_RANGES = [60, 140, 300, 520];
  function skySide(x, z, eyeY) {
    const yl = yaw - 0.24, yr = yaw + 0.24;
    const sl = Math.sin(yl), cl = Math.cos(yl), sr = Math.sin(yr), cr = Math.cos(yr);
    let l = -1, r = -1;
    for (let i = 0; i < SIDE_RANGES.length; i++) {
      const d = SIDE_RANGES[i];
      const a = (groundY(x + sl * d, z + cl * d) - eyeY) / d;
      const b = (groundY(x + sr * d, z + cr * d) - eyeY) / d;
      if (a > l) l = a;
      if (b > r) r = b;
    }
    let pref = clamp((l - r) * 8.0, -1, 1);
    // Flat land has no opinion and must not be allowed to drift the subject back
    // to centre — that is the failure being fixed. Keep the standing side.
    if (Math.abs(pref) < 0.30) pref = S.frameSide >= 0 ? 0.75 : -0.75;
    return pref;
  }

  // ===========================================================================
  //  COLLISION
  //
  //  Two mechanisms, and the order matters.
  //
  //  Shortening the boom is the LAST resort. Jamming the lens into the back of
  //  the player's head every time he walks downhill is the single ugliest
  //  failure a third-person rig has, and it is what a pure cut-the-boom
  //  solution does on any real terrain — measured at the west bluff it pinched
  //  a 5.2 m boom to 2.6 m and pushed the subject's feet clean off the bottom
  //  of the frame.
  //
  //  So the rig CLIMBS first. A ladder of boom elevations is tested and the
  //  lowest one that clears the ground at full length wins — the operator walks
  //  up the hillside behind you and shoots down, which is also the better shot.
  //  Only if no elevation clears does the boom shorten, and even then the
  //  marched contact is bisected so the length is continuous and never buzzes.
  //
  //  A stepped march quantises the contact and the lens judders, hence the
  //  bisection refine against the last clear sample.
  // ===========================================================================
  function boomClear(ox, oy, oz, dx, dy, dz, maxD, steps, refine) {
    const N = steps || CFG.marchSteps, c = CFG.clearance;
    let lastGood = 0;
    for (let i = 1; i <= N; i++) {
      const t = (maxD * i) / N;
      if (oy + dy * t < groundY(ox + dx * t, oz + dz * t) + c) {
        let lo = lastGood, hi = t;
        const R = refine === undefined ? CFG.refineSteps : refine;
        for (let k = 0; k < R; k++) {
          const m = (lo + hi) * 0.5;
          if (oy + dy * m < groundY(ox + dx * m, oz + dz * m) + c) hi = m; else lo = m;
        }
        return Math.max(CFG.distMin, lo);
      }
      lastGood = t;
    }
    return maxD;
  }

  // Boom elevations tried, in radians above the composed pitch. Coarse on
  // purpose: the result is sprung, so the ladder only has to find the rung.
  //
  // The top rung used to be 0.74 rad. On a shelf that rises behind the player —
  // 06-forest climbs 0.74 m per metre — no rung under 0.52 clears, so the solver
  // took it, the lens went 42 degrees nose-down and the horizon left the frame
  // entirely: a wall of grass, no sky, no depth. Above about 25 degrees the shot
  // is already lost, so the ladder stops there and the boom shortens instead.
  // Shortening on an uphill is also the flatter angle: the ground behind rises
  // with distance, so the closer lens looks down LESS, not more.
  const LIFTS = [0, 0.07, 0.15, 0.24, 0.34];
  const _lb = new THREE.Vector3();

  // A rock or a ridge crossing the boom is something to climb over. A hillside
  // that keeps rising all the way back is not: climbing that only carries the
  // lens further up the slope, and every metre it gains it must tip further
  // down to hold the subject, until the horizon is off the top of the frame.
  // On rising ground the flatter shot is the SHORTER one, so the ladder is
  // capped by the slope behind and the boom is allowed to give instead.
  function liftCeiling(want) {
    const bx = -Math.sin(yaw), bz = -Math.cos(yaw), d = Math.max(1e-3, want);
    const rise = (groundY(pivot.x + bx * d, pivot.z + bz * d) - subjPos.y) / d;
    return LIFTS[LIFTS.length - 1] * sat((0.42 - rise) / 0.26);
  }

  // Returns the elevation, in radians, at which the full boom is clear — or
  // the one that buys the most room if none is.
  function solveLift(want, lateral, extra, ceiling) {
    let bestL = 0, bestClear = -1;
    for (let i = 0; i < LIFTS.length; i++) {
      if (LIFTS[i] > ceiling) break;
      const p = clamp(pitch + LIFTS[i], CFG.pitchMin, CFG.pitchCamMax);
      const cp = Math.cos(p);
      _lb.set(Math.sin(yaw) * cp, -Math.sin(p), Math.cos(yaw) * cp).normalize();
      _v2.copy(pivot)
        .addScaledVector(_lb, -want)
        .addScaledVector(_rgt, lateral)
        .add(extra)
        .sub(pivot);
      const len = _v2.length();
      if (len < 1e-4) return LIFTS[i];
      _v2.divideScalar(len);
      const cl = boomClear(pivot.x, pivot.y, pivot.z, _v2.x, _v2.y, _v2.z, len, CFG.liftSteps, 2);
      if (cl >= len * 0.985) return LIFTS[i];      // fully clear: take the lowest rung
      if (cl > bestClear) { bestClear = cl; bestL = LIFTS[i]; }
    }
    return bestL;
  }

  // ===========================================================================
  //  GAMEPLAY SOLVE — follow rig and duel rig, blended by combatW.
  // ===========================================================================
  function solve(dt, c, instant) {
    const inp = c.input;

    // --- lock-on / combat detection -----------------------------------------
    const cs = c.combat && c.combat.state;
    let tgt = lockTarget;
    if (!tgt && cs && cs.target) tgt = cs.target;
    if (!tgt && cs && cs.inCombat && c.enemies && c.enemies.nearestTo) {
      tgt = c.enemies.nearestTo(subjPos, 22) || null;
    }
    const tp = tgt ? (tgt.position || (tgt.group && tgt.group.position) || tgt) : null;
    const validTgt = !!(tp && typeof tp.x === 'number');

    // Swinging steel keeps the rig hot for a few seconds even with nobody to
    // lock onto: tighter, busier, more reactive. Decays back to travel feel.
    if (inp && (inp.attack || inp.heavy || inp.parry)) S.engage = 1;
    else S.engage = Math.max(0, S.engage - dt * 0.34);

    const wantCombat = modeReq === 'combat' ? 1 : modeReq === 'follow' ? 0 : (validTgt ? 1 : 0);
    if (instant) { S.combatW = wantCombat; S.combatWV = 0; }
    else springScalar(S, 'combatW', wantCombat, 7.0, 1.0, dt);
    const cw = sat(S.combatW);

    // --- speed measures ------------------------------------------------------
    const top = mounted ? 12.5 : 7.2;
    const spN = sat(subjSpeed / top);
    const gallop = sat((subjSpeed - (mounted ? 7.5 : 5.6)) / 5.0);

    // --- pivot ---------------------------------------------------------------
    const ph = mounted ? CFG.pivotHeightRide : CFG.pivotHeight;
    pivot.copy(subjPos); pivot.y += ph;

    // --- duel yaw: sit off the player->opponent axis so both read in depth ---
    let duelDist = 0;
    if (cw > 0.001 && validTgt) {
      _v1.set(tp.x - subjPos.x, 0, tp.z - subjPos.z);
      const sep = Math.max(1.2, _v1.length());
      _v1.divideScalar(sep);
      // Behind the player on that axis, kicked ~17 degrees so the shot is a
      // three-quarter, not a flat two-shot straight down the line.
      const want = Math.atan2(_v1.x, _v1.z) + 0.30 * S.orbitSide;
      yaw += angleDelta(yaw, want) * (1 - Math.exp(-(instant ? 60 : 5.0) * dt)) * cw;
      // The pivot drags toward the midpoint so neither fighter owns the frame.
      _v2.set(tp.x, tp.y + 1.25, tp.z);
      pivot.lerp(_v2, 0.34 * cw);
      duelDist = clamp(5.9 + sep * 0.62, 6.0, 13.0);
    }

    // --- composition ---------------------------------------------------------
    const eyeY = pivot.y + Math.sin(pitchCam) * S.dist;
    const op = openness(subjPos.x, subjPos.z, Math.sin(yaw), Math.cos(yaw), eyeY);
    const vistaWant = op * (1 - cw) * (1 - sat(S.engage));
    if (instant) { S.vista = vistaWant; S.vistaV = 0; }
    else springScalar(S, 'vista', vistaWant, 1.9, 1.0, dt);
    const vista = sat(S.vista);

    // Which third the subject is put on. Slow: a swap is a re-stage, not a
    // twitch. The duel pulls him back toward the axis, but not all the way —
    // half the shots in this world have an enemy in them, and a fight is not a
    // reason to hand back the only thing keeping the frame off dead centre.
    const sideWant = skySide(subjPos.x, subjPos.z, eyeY);
    if (instant) { S.frameSide = sideWant; S.frameSideV = 0; }
    else springScalar(S, 'frameSide', sideWant, CFG.frameOmega, 1.0, dt);

    pitch = clamp(
      pitchUser + vista * CFG.horizonBias - gallop * 0.055 + cw * 0.055,
      CFG.pitchMin, CFG.pitchMax);

    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    _fwd.set(Math.sin(yaw) * cp, -sp, Math.cos(yaw) * cp).normalize();
    _rgt.set(_fwd.z, 0, -_fwd.x).normalize();

    // --- boom length ---------------------------------------------------------
    let want = mounted
      ? lerp(CFG.distRide * 0.78, CFG.distRide, spN)
      : lerp(CFG.distWalk, CFG.distSprint, sat(subjSpeed / 6.4));
    want += gallop * 0.85;
    want -= S.engage * 0.45 * (1 - cw);
    if (cw > 0.001 && duelDist > 0) want = lerp(want, duelDist, cw);
    want = clamp(want, CFG.distMin, CFG.distMax);

    // --- trailing: dragged back under load, released as the run settles ------
    _v3.copy(subjVel).multiplyScalar(-CFG.trailPerSpeed)
      .addScaledVector(subjAcc, -CFG.trailPerAccel);
    _v3.multiplyScalar(1 - cw * 0.7);
    if (_v3.lengthSq() > CFG.trailMax * CFG.trailMax) _v3.setLength(CFG.trailMax);
    _v3.y = subjSpeed * CFG.trailLift;
    if (instant) { trail.copy(_v3); trailVel.set(0, 0, 0); }
    else springVec(trail, trailVel, _v3, CFG.trailOmega, CFG.trailZeta, dt);

    // --- collision: climb first, shorten only if the climb fails ---------------
    const lateral = lerp(CFG.shoulder, CFG.shoulderCombat, cw);
    const ceiling = liftCeiling(want);
    const liftWant = Math.min(solveLift(want, lateral, trail, ceiling), ceiling);
    // Rising has to be quick or the hillside catches the lens; coming back down
    // is slow, so the rig does not bob every time it clears a bump.
    if (instant) { S.lift = liftWant; S.liftV = 0; }
    else springScalar(S, 'lift', liftWant,
      liftWant > S.lift ? CFG.liftOmegaUp : CFG.liftOmegaDown, 1.0, dt);
    S.lift = clamp(S.lift, 0, ceiling);

    // `pitch` is left alone here. It is the composed aim the rest of the game is
    // allowed to steer; the climb belongs to the boom and to nothing else.
    const pT = clamp(pitch + S.lift, CFG.pitchMin, CFG.pitchCamMax);
    const cpT = Math.cos(pT);
    _fwd.set(Math.sin(yaw) * cpT, -Math.sin(pT), Math.cos(yaw) * cpT).normalize();
    _rgt.set(_fwd.z, 0, -_fwd.x).normalize();
    pitchCam = pT;

    ideal.copy(pivot)
      .addScaledVector(_fwd, -want)
      .addScaledVector(_rgt, lateral)
      .add(trail);

    _v4.copy(ideal).sub(pivot);
    const full = _v4.length();
    if (full > 1e-4) {
      _v4.divideScalar(full);
      const allow = boomClear(pivot.x, pivot.y, pivot.z, _v4.x, _v4.y, _v4.z, full);
      if (instant) { S.dist = allow; S.distV = 0; }
      else springScalar(S, 'dist', allow, allow < S.dist ? CFG.distIn : CFG.distOut, 1.0, dt);
      S.dist = clamp(S.dist, CFG.distMin, full);
      ideal.copy(pivot).addScaledVector(_v4, S.dist);
    }

    // --- position spring ------------------------------------------------------
    if (instant) { camPos.copy(ideal); camVel.set(0, 0, 0); }
    else springVec(camPos, camVel, ideal,
      lerp(CFG.posOmega, CFG.posOmegaCombat, cw) * lerp(1, 1.18, spN),
      lerp(CFG.posZeta, CFG.posZetaCombat, cw), dt);

    // Lag has a ceiling. The trailing spring plus a hard acceleration can
    // otherwise stretch the boom until the subject is a speck; past the cap the
    // lens is pulled straight back down the boom.
    _v0.copy(camPos).sub(pivot);
    const lagged = _v0.length();
    const capD = Math.min(want * CFG.boomCap + 0.6, CFG.distMax);
    if (lagged > capD && lagged > 1e-4) {
      camPos.copy(pivot).addScaledVector(_v0, capD / lagged);
      camVel.multiplyScalar(0.5);
    }

    // --- aim point ------------------------------------------------------------
    aim.copy(subjPos);
    aim.y += ph + CFG.aimLift + vista * CFG.aimLiftVista;
    if (cw > 0.001 && validTgt) {
      _v5.set(tp.x, tp.y + 1.45, tp.z);
      aim.lerp(_v5, 0.40 * cw);
    }
    if (hasLookOverride) aim.lerp(lookOverride, 0.85);
    // Lead the aim into travel so the shot opens ahead of the runner.
    aim.addScaledVector(subjVel, 0.055 * (1 - cw));

    if (instant) { lookPos.copy(aim); lookVel.set(0, 0, 0); }
    else springVec(lookPos, lookVel, aim, CFG.lookOmega * lerp(1, 1.45, cw), CFG.lookZeta, dt);

    // --- lens -----------------------------------------------------------------
    // Speed opens the lens; a gallop opens it hard. On top of that, if the rig
    // has been forced close enough that a 1.9 m body would overflow the frame,
    // the lens opens far enough to hold him whole. Cropping the player is not
    // an option, so the glass gives instead.
    let fovWant = CFG.fovBase + spN * CFG.fovSpeedGain
      + gallop * CFG.fovGallopGain + cw * CFG.fovCombat;
    const dSub = Math.max(1.0, camPos.distanceTo(pivot));
    const need = THREE.MathUtils.radToDeg(2 * Math.atan((0.98 / dSub) / CFG.fovFrameFill));
    if (need > fovWant) fovWant = Math.min(need, CFG.fovMax);
    if (instant) { S.fov = fovWant; S.fovV = 0; }
    else springScalar(S, 'fov', fovWant, CFG.fovOmega, CFG.fovZeta, dt);

    // --- bank: lateral acceleration rolls the horizon a touch ------------------
    if (instant) { S.bank = 0; S.bankV = 0; }
    else {
      const bankWant = clamp(-subjAcc.dot(_rgt) * CFG.bankPerAccel, -CFG.bankMax, CFG.bankMax) * (1 - cw * 0.6);
      springScalar(S, 'bank', bankWant, 4.5, 1.0, dt);
    }

    return cw;
  }

  // ===========================================================================
  //  CINEMATIC VIRTUAL CAMERAS
  //  Each fills cinePos / cineLook / cineFov. The gameplay rig keeps solving
  //  underneath, so the weight can be released at any time without a jump.
  // ===========================================================================
  const CINE = {
    // Slow dolly toward the subject, lens closing. The classic realisation beat.
    push_in(k, cs) {
      const e = smoother01(k);
      const p = cs.pitch;
      _v0.set(Math.sin(cs.yaw) * Math.cos(p), -Math.sin(p), Math.cos(cs.yaw) * Math.cos(p));
      cinePos.copy(cs.anchor).addScaledVector(_v0, -lerp(cs.from, cs.to, e));
      cinePos.y = smax(cinePos.y, groundY(cinePos.x, cinePos.z) + 0.85, 0.5);
      cineLook.copy(cs.anchor).addScaledVector(_v0, 1.5);
      cineFov = lerp(cs.fov0, cs.fov1, e);
    },

    // Wide establishing hold: high, far, drifting. Horizon deliberately high,
    // subject small and low in frame — the island is the subject here.
    establish(k, cs) {
      const az = cs.yaw + cs.drift * cs.elapsed;
      const r = lerp(cs.radius * 0.86, cs.radius, smoother01(k));
      cinePos.set(cs.anchor.x - Math.sin(az) * r, 0, cs.anchor.z - Math.cos(az) * r);
      cinePos.y = groundY(cinePos.x, cinePos.z) + cs.height + Math.sin(cs.elapsed * 0.35) * 0.9;
      cineLook.copy(cs.anchor); cineLook.y += cs.aimLift;
      cineFov = cs.fov;
    },

    // Standoff. Camera on the player's shoulder, opponent across the diagonal,
    // long lens so the gap compresses and reads as pressure, not distance.
    over_shoulder(k, cs) {
      _v0.copy(cs.anchor);
      const t = cs.target && (cs.target.position || (cs.target.group && cs.target.group.position) || cs.target);
      if (t && typeof t.x === 'number') _v1.set(t.x - _v0.x, 0, t.z - _v0.z);
      else _v1.set(Math.sin(cs.yaw), 0, Math.cos(cs.yaw));
      const sep = Math.max(1.0, _v1.length());
      _v1.divideScalar(sep);
      _v2.set(_v1.z, 0, -_v1.x);
      const e = smoother01(k);
      cinePos.copy(_v0)
        .addScaledVector(_v1, -lerp(3.4, 2.55, e))
        .addScaledVector(_v2, cs.side * lerp(0.70, 0.98, e));
      cinePos.y = _v0.y + 0.42;
      cinePos.y = smax(cinePos.y, groundY(cinePos.x, cinePos.z) + 0.85, 0.5);
      cineLook.copy(_v0).addScaledVector(_v1, Math.min(sep * 0.55, 3.6));
      cineLook.y += 0.15;
      cineLook.addScaledVector(_v2, cs.side * -0.55);
      cineFov = lerp(46, 40, e);
    },

    // Slow lateral orbit — title cards, shrine reveals, the end of a duel.
    orbit(k, cs) {
      const az = cs.yaw + cs.drift * cs.elapsed;
      cinePos.set(cs.anchor.x - Math.sin(az) * cs.radius, 0, cs.anchor.z - Math.cos(az) * cs.radius);
      cinePos.y = cs.anchor.y + cs.height;
      cinePos.y = smax(cinePos.y, groundY(cinePos.x, cinePos.z) + 0.9, 0.6);
      cineLook.copy(cs.anchor); cineLook.y += cs.aimLift;
      cineFov = cs.fov;
    },
  };

  function stepCinematic(dt, c) {
    if (!cine) return 0;
    cine.elapsed += dt;
    if (cine.follow) {
      cine.anchor.lerp(subjPos, 1 - Math.exp(-6 * dt));
      cine.anchor.y = subjPos.y + cine.anchorLift;
    }
    const t = cine.elapsed;
    let w;
    if (cine.releasing) {
      w = 1 - (t - cine.releaseAt) / cine.blendOut;
      if (w <= 0) { cine = null; return 0; }
      w = smoother01(w);
    } else if (t < cine.blendIn) {
      w = smoother01(t / cine.blendIn);
    } else if (t < cine.blendIn + cine.hold) {
      w = 1;
    } else {
      const o = (t - cine.blendIn - cine.hold) / cine.blendOut;
      if (o >= 1) { cine = null; return 0; }
      w = smoother01(1 - o);
    }
    // Progress through the move itself, independent of the cross-fade.
    (CINE[cine.name] || CINE.orbit)(sat(t / Math.max(0.01, cine.blendIn + cine.hold)), cine, c);
    return sat(w);
  }

  // ===========================================================================
  //  SHAKE
  //  Trauma stack. Impulses are either omnidirectional (a collapse) or
  //  directional (a blade landing, a horse stumbling). Amplitude falls with the
  //  square of remaining life, so hits punch and then vanish instead of fading
  //  out like a wobble.
  // ===========================================================================
  function stepShake(dt, moveI, combatI) {
    shakeOff.set(0, 0, 0);
    shakeYaw = shakePitch = shakeRoll = 0;
    let total = 0;
    for (let i = shakes.length - 1; i >= 0; i--) {
      const s = shakes[i];
      s.t += dt;
      if (s.t >= s.dur) { shakes.splice(i, 1); continue; }
      const life = 1 - s.t / s.dur;
      const a = s.amp * life * life;
      const ph = s.t * s.freq;
      total += a;
      if (s.dir) {
        const o = a * Math.sin(ph * 6.283) * Math.exp(-s.t * 5.5);
        shakeOff.addScaledVector(s.dir, o * 0.85);
        shakePitch += o * 0.05;
        shakeRoll += o * 0.045;
      } else {
        shakeOff.x += a * rattle(ph, s.seed) * 0.55;
        shakeOff.y += a * rattle(ph, s.seed + 3.1) * 0.42;
        shakeOff.z += a * rattle(ph, s.seed + 6.4) * 0.55;
        shakeYaw += a * rattle(ph, s.seed + 9.2) * 0.055;
        shakePitch += a * rattle(ph, s.seed + 12.7) * 0.045;
        shakeRoll += a * rattle(ph, s.seed + 15.3) * 0.070;
      }
    }
    shakeAmt = Math.min(total, 2.5);

    // Handheld. Always on, always small: the difference between a camera and a
    // tripod is that a camera is being held by somebody.
    const h = lerp(lerp(CFG.handheldIdle, CFG.handheldMove, moveI), CFG.handheldCombat, combatI);
    shakeYaw += wob(time, 1.7) * h;
    shakePitch += wob(time, 4.3) * h * 0.78;
    shakeRoll += wob(time, 8.9) * h * 1.30;
    const hp = CFG.handheldPos * (0.35 + moveI * 0.9 + combatI * 0.8);
    shakeOff.x += wob(time * 0.83, 12.1) * hp;
    shakeOff.y += wob(time * 0.71, 15.6) * hp;
    shakeOff.z += wob(time * 0.91, 19.4) * hp;
  }

  // ===========================================================================
  //  FRAMING — where in the picture the subject actually sits.
  //
  //  Every layer above aims the lens AT the body, which pins him to the optical
  //  axis: measured across all eight poses his horizontal screen position was
  //  0.000, 0.001, 0.017, 0.001, -0.005 — dead centre, every frame, forever. A
  //  centred subject over a centred horizon is a character portrait, not a
  //  landscape, and it is the one composition a landscape photographer will
  //  never take.
  //
  //  So the aim is rotated off the body by exactly the angle that lands his
  //  chest on a mark: a third across, a touch below centre. Rotating the AIM and
  //  not the position keeps the staging — the camera stays where the collision
  //  and trailing solvers put it, only the lens is re-pointed.
  // ===========================================================================
  function frameSubject(pos, look, fovDeg, aspect, w) {
    if (w <= 1e-3) return;
    const tanV = Math.tan(THREE.MathUtils.degToRad(fovDeg) * 0.5);
    const tanH = tanV * aspect;

    _v1.copy(look).sub(pos);
    if (_v1.lengthSq() < 1e-8) return;
    _fwd.copy(_v1).normalize();
    _rgt.copy(_fwd).cross(WORLD_UP);
    if (_rgt.lengthSq() < 1e-6) return;        // straight up or down: no basis
    _rgt.normalize();
    _up.copy(_rgt).cross(_fwd).normalize();

    _v0.copy(subjPos); _v0.y += CFG.frameChest; _v0.sub(pos);
    const z = _v0.dot(_fwd);
    if (z <= 0.2) return;                      // behind the lens: safe frame owns it

    // Where the mark is, and where he is. Rotating the aim by -d moves him left
    // by d on the horizontal axis and down by d on the vertical — same sign
    // convention the safe frame below uses.
    const dH = Math.atan2(_v0.dot(_rgt), z) - Math.atan(CFG.frameX * clamp(S.frameSide, -1, 1) * w * tanH);
    const dV = Math.atan2(_v0.dot(_up), z) - Math.atan(CFG.frameY * w * tanV);

    if (dH !== 0) _v1.applyAxisAngle(WORLD_UP, -dH);
    if (dV !== 0) {
      _axis.copy(_v1).normalize().cross(WORLD_UP);
      if (_axis.lengthSq() > 1e-8) _v1.applyAxisAngle(_axis.normalize(), dV);
    }
    look.copy(pos).add(_v1);
  }

  // The horizon guarantee. A shelf behind the player can leave the lens nose
  // down far enough that the sky is off the top of the frame and the shot is a
  // flat wall of ground — a rubric automatic fail, and measured at 23.5 degrees
  // on 06-forest. Whatever the terrain did, the committed lens stops here. The
  // safe frame still runs afterwards, so keeping the subject on screen can still
  // overrule this; nothing else can.
  function capViewPitch(pos, look) {
    _v1.copy(look).sub(pos);
    const L = _v1.length();
    if (L < 1e-4) return;
    const over = Math.asin(clamp(-_v1.y / L, -1, 1)) - CFG.pitchViewMax;
    if (over <= 0) return;
    _axis.copy(_v1).normalize().cross(WORLD_UP);
    if (_axis.lengthSq() < 1e-8) return;
    _v1.applyAxisAngle(_axis.normalize(), over);
    look.copy(pos).add(_v1);
  }

  // ===========================================================================
  //  SAFE FRAME — the guarantee.
  //
  //  Whatever the springs, the collision cut, the cinematic and the shake did,
  //  the subject is brought back inside the frame before the matrix is
  //  committed. Two body points are tested, not one: a chest-only test happily
  //  leaves the feet hanging off the bottom edge, which the probe caught doing
  //  exactly that for 233 frames straight on the west bluff.
  //
  //  If the body is taller than the safe box — which only happens when the rig
  //  has been forced very close — the two corrections cancel to a compromise
  //  that centres him, and the lens has already opened to help (see the FOV
  //  framing term). Two passes, because rotating for the horizontal changes the
  //  vertical a little.
  // ===========================================================================
  const FOOT = 0.10, CROWN = 1.86;

  // Never let the eye end up inside the body, whatever shortened the boom.
  const BODY_CLEAR = 2.55;
  const _clr = new THREE.Vector3();
  function enforceStandoff(pos, subj) {
    _clr.copy(pos).sub(subj);
    _clr.y *= 0.55;                       // the body is tall and thin, not a sphere
    const d = _clr.length();
    if (d >= BODY_CLEAR || d < 1e-4) return;
    _clr.multiplyScalar((BODY_CLEAR - d) / d);
    _clr.y /= 0.55;
    pos.add(_clr);
  }

  function enforceFrame(pos, look, fovDeg, aspect) {
    const tanV = Math.tan(THREE.MathUtils.degToRad(fovDeg) * 0.5);
    const tanH = tanV * aspect;
    const maxH = Math.atan(CFG.safeX * tanH);
    const maxUp = Math.atan(CFG.safeYTop * tanV);
    const maxDn = Math.atan(CFG.safeYBot * tanV);

    for (let pass = 0; pass < 2; pass++) {
      _fwd.copy(look).sub(pos);
      const L = _fwd.length();
      if (L < 1e-4) return;
      _fwd.divideScalar(L);
      _rgt.copy(_fwd).cross(WORLD_UP);
      if (_rgt.lengthSq() < 1e-6) _rgt.set(1, 0, 0); else _rgt.normalize();
      _up.copy(_rgt).cross(_fwd).normalize();

      // crown
      _v0.copy(subjPos); _v0.y += CROWN; _v0.sub(pos);
      const zH = _v0.dot(_fwd);
      if (zH <= 0.15) {
        // Subject is behind the lens. Nothing subtler is recoverable: swing back.
        look.copy(subjPos); look.y += 1.15;
        continue;
      }
      const aHx = Math.atan2(_v0.dot(_rgt), zH);
      const aTop = Math.atan2(_v0.dot(_up), zH);
      // feet
      _v0.copy(subjPos); _v0.y += FOOT; _v0.sub(pos);
      const zF = Math.max(0.15, _v0.dot(_fwd));
      const aBot = Math.atan2(_v0.dot(_up), zF);
      const aHf = Math.atan2(_v0.dot(_rgt), zF);

      const aH = (aHx + aHf) * 0.5;
      let dH = 0;
      if (aH > maxH) dH = aH - maxH; else if (aH < -maxH) dH = aH + maxH;

      // Rotate up to pull the crown down, down to pull the feet up. When both
      // want it, the sum is the compromise that centres the body.
      const over = Math.max(0, aTop - maxUp);
      const under = Math.max(0, -maxDn - aBot);
      const dV = over - under;

      if (Math.abs(dH) < 1e-5 && Math.abs(dV) < 1e-5) return;

      // Rotate the aim, not the position — the shot keeps its staging.
      _v1.copy(look).sub(pos);
      if (dH !== 0) _v1.applyAxisAngle(WORLD_UP, -dH);
      if (dV !== 0) {
        _axis.copy(_v1).normalize().cross(WORLD_UP);
        if (_axis.lengthSq() > 1e-8) _v1.applyAxisAngle(_axis.normalize(), dV);
      }
      look.copy(pos).add(_v1);
    }
  }

  // ===========================================================================
  //  UPDATE
  // ===========================================================================
  function update(dt, c, instant) {
    dt = clamp(dt, 0, 0.1);
    if (!instant) time += dt;

    readSubject(instant ? 0 : dt, c);
    if (boot) {
      subjPrev.copy(subjPos);
      yaw = (c.player && typeof c.player.yaw === 'number') ? c.player.yaw : 0;
      pitchUser = CFG.pitchBase;
      pitch = pitchCam = CFG.pitchBase;
      // Left third by default. Reset on every snap so a shot is a function of
      // the land it is taken on and nothing else — otherwise flat ground, which
      // has no opinion about the side, silently inherits the previous scene's.
      S.frameSide = -0.75; S.frameSideV = 0;
      trail.set(0, 0, 0); trailVel.set(0, 0, 0);
    }
    if (!instant) recentre(dt, c);

    // On a snap the composition, the boom and the collision cut all depend on
    // each other; three passes converge them before the first frame is shown.
    let cw;
    if (instant) { cw = solve(1 / 60, c, true); solve(1 / 60, c, true); cw = solve(1 / 60, c, true); }
    else cw = solve(dt, c, false);

    // --- cinematic cross-fade -------------------------------------------------
    finalPos.copy(camPos);
    finalLook.copy(lookPos);
    let fov = S.fov;
    const cineW = instant ? 0 : stepCinematic(dt, c);
    if (cineW > 0) {
      finalPos.lerp(cinePos, cineW);
      finalLook.lerp(cineLook, cineW);
      fov = lerp(fov, cineFov, cineW);
    }

    // --- shake / handheld -----------------------------------------------------
    if (instant) {
      shakes.length = 0; shakeOff.set(0, 0, 0);
      shakeYaw = shakePitch = shakeRoll = 0; shakeAmt = 0;
    } else {
      stepShake(dt, sat(subjSpeed / 7.0), sat(Math.max(cw, S.engage)));
    }
    // A cinematic is operated, not fought: damp the noise, do not kill it.
    const sw = 1 - cineW * 0.75;
    finalPos.addScaledVector(shakeOff, sw);

    // --- standoff -------------------------------------------------------------
    // Before the ground clamp, and before anything that reasons about screen
    // space. It used to run last, after the safe frame, and it moved the lens
    // out from under the frame the safe frame had just guaranteed — measured on
    // 06-forest with the subject's feet at -0.955, a quarter of a frame past
    // the bottom edge they were supposedly held inside. The clamp below only
    // ever raises the lens, which increases this separation, so the guarantee
    // survives it.
    enforceStandoff(finalPos, subjPos);

    // --- ground guarantee -----------------------------------------------------
    // Smooth-max, not clamp: crossing a ridge behind the player must not step
    // the lens. This is the last word — nothing after it moves the position.
    finalPos.y = smax(finalPos.y, groundY(finalPos.x, finalPos.z) + CFG.groundClamp, 0.55);

    // --- framing --------------------------------------------------------------
    // Runs on the FINAL position and before the handheld rotation, in that
    // order and for a reason: the mark is a screen position, so it can only be
    // solved once the lens has stopped moving, and solving it after the shake
    // would pin the subject to the pixel and cancel the operator's hands.
    // A duel and a scripted shot both stage themselves, so it stands down.
    const aspect = camera.aspect || (innerWidth / Math.max(1, innerHeight));
    frameSubject(finalPos, finalLook, fov, aspect, (1 - cw * 0.55) * (1 - cineW));

    // --- rotational offsets ---------------------------------------------------
    if (shakeYaw !== 0 || shakePitch !== 0) {
      _v1.copy(finalLook).sub(finalPos);
      if (_v1.lengthSq() > 1e-8) {
        _v1.applyAxisAngle(WORLD_UP, shakeYaw * sw);
        _axis.copy(_v1).normalize().cross(WORLD_UP);
        if (_axis.lengthSq() > 1e-8) _v1.applyAxisAngle(_axis.normalize(), shakePitch * sw);
        finalLook.copy(finalPos).add(_v1);
      }
    }

    // --- horizon guarantee ----------------------------------------------------
    if (cineW < 0.92) capViewPitch(finalPos, finalLook);

    // --- safe frame -----------------------------------------------------------
    if (cineW < 0.92) enforceFrame(finalPos, finalLook, fov, aspect);

    // --- commit ---------------------------------------------------------------
    camera.position.copy(finalPos);
    _fwd.copy(finalLook).sub(finalPos);
    if (_fwd.lengthSq() < 1e-8) _fwd.set(0, 0, -1);
    _up.copy(WORLD_UP);
    const roll = S.bank + shakeRoll * sw;
    if (roll !== 0) _up.applyAxisAngle(_axis.copy(_fwd).normalize(), roll);
    _m4.lookAt(finalPos, finalLook, _up);
    _q.setFromRotationMatrix(_m4);
    camera.quaternion.copy(_q);

    if (Math.abs(camera.fov - fov) > 1e-4) { camera.fov = fov; camera.updateProjectionMatrix(); }
    camera.updateMatrixWorld(true);
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

    api.focusDistance = finalPos.distanceTo(subjPos);
    boot = false;
  }

  // ===========================================================================
  //  PUBLIC API
  // ===========================================================================
  const _screenV = new THREE.Vector3();
  const _fwdOut = new THREE.Vector3();

  const api = {
    get yaw() { return yaw; },
    get pitch() { return pitch; },
    get fov() { return S.fov; },
    get boom() { return S.dist; },
    get vista() { return S.vista; },
    get mode() { return cine ? 'cinematic' : (S.combatW > 0.5 ? 'combat' : 'follow'); },
    get inCinematic() { return !!cine; },
    get shakeAmount() { return shakeAmt; },
    // Read-only window for the headless probes. `pitch` is the steerable aim,
    // `pitchCam` the boom's own elevation including the obstruction climb.
    get _dbg() {
      return { yaw, pitch, pitchCam, pitchUser, lift: S.lift, vista: S.vista,
               dist: S.dist, frameSide: S.frameSide };
    },
    get target() { return lockTarget; },
    height: CFG.pivotHeight,
    focusDistance: 8,

    // Legacy field, kept live: `gcam.distance` still reads and writes something.
    // Clamped, because it writes straight into the tuning block and combat.js
    // damps it every frame of a fight — one bad value there would be permanent.
    get distance() { return S.dist; },
    set distance(v) {
      if (!(v > 0)) return;
      CFG.distWalk = clamp(v, CFG.distMin, CFG.distMax);
      CFG.distSprint = Math.max(CFG.distWalk, CFG.distSprint);
    },

    snap() { boot = true; update(1 / 60, ctx, true); },
    update(dt, c) { update(dt, c, false); },

    // ---- shake -------------------------------------------------------------
    //  shake(strength, duration, freq)  omnidirectional trauma
    //  impulse(dir, strength, duration) a punch along a world direction —
    //      a blade landing from the left should throw the lens right
    //  kick(strength, duration)         recoil straight back down the boom
    shake(strength = 0.35, duration = 0.38, freq = 1.0) {
      if (!(strength > 0)) return;
      shakes.push({
        amp: Math.min(strength, 1.6) * 0.55, dur: Math.max(0.05, duration),
        t: 0, freq, seed: (SEED = (SEED + 37.13) % 997), dir: null,
      });
      if (shakes.length > 12) shakes.shift();
    },
    impulse(dir, strength = 0.4, duration = 0.32) {
      if (!dir) return api.shake(strength, duration);
      _v0.set(dir.x || 0, dir.y || 0, dir.z || 0);
      if (_v0.lengthSq() < 1e-8) return api.shake(strength, duration);
      shakes.push({
        amp: Math.min(strength, 1.6) * 0.32, dur: Math.max(0.05, duration),
        t: 0, freq: 11, seed: 0, dir: _v0.clone().normalize(),
      });
      if (shakes.length > 12) shakes.shift();
    },
    kick(strength = 0.3, duration = 0.22) {
      _v0.copy(camera.position).sub(subjPos).setY(0);
      api.impulse(_v0, strength, duration);
    },

    // ---- modes -------------------------------------------------------------
    lockOn(t) { lockTarget = t || null; },
    // Swaps the duel orbit AND the third the subject is framed on — they are the
    // same gesture: "put him on my other shoulder".
    swapShoulder() {
      S.orbitSide = -S.orbitSide;
      S.frameSide = -S.frameSide; S.frameSideV = 0;
    },
    setMode(m) { modeReq = (m === 'combat' || m === 'follow') ? m : 'auto'; },
    setLookTarget(v) {
      if (v) { lookOverride.copy(v); hasLookOverride = true; }
      else hasLookOverride = false;
    },

    // ---- cinematics --------------------------------------------------------
    //  cinematic(name, opts) -> token.
    //  names: 'push_in' | 'establish' | 'over_shoulder' | 'orbit'
    //  Every opt is optional; defaults are derived from the live shot, so the
    //  quest can fire one with a bare name and get something composed.
    //    blendIn / hold / blendOut  seconds of cross-fade in, hold, out
    //    follow                     anchor tracks the subject (default true)
    //    target                     the opponent, for over_shoulder
    cinematic(name, opts = {}) {
      const anchorLift = opts.anchorLift ?? 1.35;
      const anchor = new THREE.Vector3();
      if (opts.anchor) anchor.copy(opts.anchor);
      else { anchor.copy(subjPos); anchor.y += anchorLift; }
      const cs = {
        name: CINE[name] ? name : 'orbit',
        elapsed: 0,
        blendIn: opts.blendIn ?? 1.1,
        hold: opts.hold ?? (opts.duration ?? 4.0),
        blendOut: opts.blendOut ?? 1.2,
        releasing: false, releaseAt: 0,
        follow: opts.follow ?? true,
        anchorLift, anchor,
        yaw: opts.yaw ?? yaw,
        pitch: opts.pitch ?? 0.09,
        from: opts.from ?? Math.max(S.dist, 9.0),
        to: opts.to ?? 3.1,
        fov0: opts.fov0 ?? 52, fov1: opts.fov1 ?? 34,
        side: opts.side ?? S.orbitSide,
        target: opts.target ?? lockTarget,
        radius: 0, height: 0, aimLift: 0, drift: 0, fov: 0,
      };
      if (cs.name === 'orbit') {
        cs.radius = opts.radius ?? 7.5; cs.height = opts.height ?? 2.6;
        cs.aimLift = opts.aimLift ?? 1.1; cs.drift = opts.drift ?? 0.30;
        cs.fov = opts.fov ?? 44;
      } else {
        cs.radius = opts.radius ?? 46; cs.height = opts.height ?? 17;
        cs.aimLift = opts.aimLift ?? 6.0; cs.drift = opts.drift ?? 0.055;
        cs.fov = opts.fov ?? 62;
      }
      cine = cs;
      return cs;
    },
    cancelCinematic(fade = 0.7) {
      if (!cine) return;
      cine.releasing = true;
      cine.releaseAt = cine.elapsed;
      cine.blendOut = Math.max(0.05, fade);
    },

    // ---- helpers others can use --------------------------------------------
    // Project a world point to normalised device coords. HUD markers and the
    // quest compass want this. The returned vectors are shared — copy them.
    worldToScreen(v, out = { x: 0, y: 0, visible: false }) {
      _screenV.copy(v).project(camera);
      out.x = _screenV.x; out.y = _screenV.y;
      out.visible = _screenV.z < 1 && Math.abs(_screenV.x) <= 1 && Math.abs(_screenV.y) <= 1;
      return out;
    },
    get forward() { return _fwdOut.set(0, 0, -1).applyQuaternion(camera.quaternion); },
  };

  camPos.copy(camera.position);
  lookPos.copy(camera.position).add(_v0.set(0, 0, -1));
  api.snap();
  return api;
}
