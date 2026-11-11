import * as THREE from 'three';

// OWNER: vfx lane. THE WIND FIELD — the single source of truth for air motion.
//
// The wind is the game's signature. Before this file was the authority there
// were THREE private winds: grass.js hard-coded k = 0.0130/0.0460/0.1500 with
// w = 0.72/2.00/4.90 (phase speeds 55/44/33 m/s), trees.js hard-coded
// k = 0.026/0.0098/0.071 (40/50/30 m/s), and vfx.js a third stack again. Only
// the scalar gust and the direction vector were shared, so the front that bent
// the grass was not the front that shook the trees was not the front that
// pushed the leaves. Everything below exists so that can never happen again.
//
// ===================================================================
//  THE CONTRACT  —  consumers: grass.js, trees.js, vfx.js, sky.js
// ===================================================================
//
// 1. UNIFORMS. `wind.uniforms` is an object of THREE uniform holders. Attach it
//    to a material by REFERENCE — do not copy the values, do not re-scale them:
//
//        const uniforms = Object.assign({ ...yourOwnUniforms }, ctx.wind.uniforms);
//        // or, on an existing uniforms object:
//        ctx.wind.attach(uniforms);
//
//    wind.update(dt) runs before every subsystem update (world.js), so a
//    material holding these references is already current when it draws. There
//    is nothing to do per frame — DELETE your `u.uWindDir.value.copy(...)` and
//    `u.uWindStr.value = ...` lines, and delete your own uWindDir/uWindStr
//    uniform declarations so they do not shadow these.
//
//    The block is exactly:
//
//        uniform float uWindTime;      // seconds. THE shared phase clock.
//        uniform vec2  uWindDir;       // prevailing direction, unit, world xz
//        uniform float uWindStr;       // scalar envelope, ~0.35 .. 1.45
//        uniform vec4  uWindWave[3];   // per band: (k, omega, amp, kAcross)
//        uniform vec4  uWindGuide;     // (originX, originZ, headDist, strength)
//        uniform vec2  uWindGuideDir;  // guiding-corridor direction, unit
//
//    THE SHAPE OF THIS BLOCK IS STABLE. Waves E and F changed only NUMBERS
//    inside windGuide()/windGust()/windDirAt() and inside createWind(); no
//    uniform was added, removed, renamed or retyped, no GLSL function signature
//    changed, and WIND_UNIFORMS_GLSL / WIND_GLSL / attach() are byte-compatible
//    with what grass.js, trees.js and vfx.js already paste in. Nothing
//    downstream needs to change to pick this up. Wave F's only structural edit
//    is CPU-side and private: blowToward() now offsets guide.origin forward
//    along the corridor before storing it, which is visible to shaders only as
//    a different uWindGuide.xy — the same vec4 it always was.
//
//    uWindTime is NOT your local time accumulator. Use uWindTime for anything
//    that must agree with the field; keep your own uTime only for private
//    detail (per-blade jitter, per-card flutter) that nothing else can see.
//
//    FOR THE SKY LANE: the cloud decks scroll AGAINST the wind. `uWindDir` is
//    the world-xz direction the air is TRAVELLING TOWARD, so a deck should
//    advance its uv by `+uWindDir * speed * uWindTime`, not minus. If you need
//    a slower aloft direction or an altitude shear, ask for it — do not add a
//    private direction; that is the exact bug this file was written to kill.
//
// 2. GLSL. `WIND_UNIFORMS_GLSL` is the declaration block above; `WIND_GLSL` is
//    the sampler. Paste both near the top of your vertex shader:
//
//        const VS = WIND_UNIFORMS_GLSL + WIND_GLSL + `
//          ... your shader ...
//        `;
//
//    It gives you four functions, all in world xz, all phase-locked:
//
//        float windWave(vec2 p)   signed front field, ~[-1, 1]
//        float windGuide(vec2 p)  guiding corridor only, 0 .. 1
//        float windGust(vec2 p)   TOTAL local intensity. 0 = still,
//                                 ~0.24 = ordinary wind, ~1.3 in a gust head
//                                 (1.58 worst case). See the measured block
//                                 under 5. It is NOT normalised to 1.
//        vec2  windDirAt(vec2 p)  local direction: prevailing, ROTATED toward
//                                 the guiding corridor where one is blowing.
//                                 Always unit length, for every angle between
//                                 the two — including a corridor fired dead
//                                 upwind. See the note on the function.
//
//    Sample at the WORLD position of the thing you are moving (a blade root, a
//    tree root, a particle) — never at the camera, never at the origin.
//
//    Scale it with your own amplitude uniform (uBendScale, uBend, uGustAmp).
//    Do not rescale uWindStr and do not add sines of your own: an extra private
//    band is exactly the bug this file was written to kill.
//
// 3. THE BANDS. Three travelling sine fronts, amplitudes summing to 1.0, fixed
//    inter-band phase offsets (0.0, 1.7, 4.1) baked into WIND_GLSL so the bands
//    never all peak at the world origin:
//
//        band  wavelength   phase speed   amp    what it reads as
//        0       190 m        14 m/s      0.50   the front crossing the valley
//        1        52 m        17 m/s      0.32   the ripple inside the front
//        2        17 m        20 m/s      0.18   the chop on top of the ripple
//
//    Phase speeds are deliberately 14-20 m/s. The old private stacks ran at
//    33-55 m/s, which is faster than the eye reads as wind — it reads as a
//    strobe. `kAcross` skews each front a few degrees off perpendicular so the
//    wavefronts are not dead-straight lines marching in lockstep.
//
// 4. DIRECTION IS SLOW. The prevailing direction wanders about +-5 degrees over
//    ~90 s and never faster than 0.6 deg/s. It used to swing 31 degrees in 8.6
//    seconds, which made every consumer's dot(worldPos, uWindDir) phase pivot:
//    the whole field stirred instead of blowing. If you need a fast direction
//    change, that is a guiding corridor (below), not the prevailing wind.
//
// 5. THE GUIDING WIND IS A CORRIDOR, NOT A ROTATION, AND NOT THE WHOLE FIELD.
//    `blowToward()` launches a gust HEAD that travels out along a narrow lane
//    toward the objective; the head shows up in windGust() as a moving bump and
//    in windDirAt() as a local bend. Everything that reads the field therefore
//    shows the corridor for free: the grass parts along it, the trees lean into
//    it, the leaves are carried down it.
//
//    WAVE F RESHAPE — read this before wave E's, below; it supersedes two of
//    wave E's numbers. Wave E made the corridor travel (verified: head 5.2 ->
//    80.1 m in 4.19 s) but it still did not read as a LANE, for two measured
//    reasons, both of them constants in G:
//
//    (a) THE LANE WAS WIDER THAN THE LEGIBLE FIELD. At LANE = 15 m the swath
//        driven above the ambient MAXIMUM (0.655) was +-20 m — a 40 m band —
//        and the swath above ambient p90 was +-26 to +-40 m. Individual blades
//        stop resolving from the shipped over-the-shoulder camera well inside
//        that, so both edges of the "lane" were always off-screen or in the
//        illegible band and the corridor read as the whole field gusting. At
//        LANE = 7 m the above-ambient-max swath is +-7.5 to +-8.8 m, a 16 m
//        path with both edges inside the near band.
//
//    (b) THE HEAD WAS BORN ON TOP OF THE CAMERA. blowToward() launched from the
//        caller's feet, so the head's 22 m leading face — the steep edge you are
//        supposed to READ as a front — was already behind the near plane on
//        frame one. It never arrived; it only receded. G.LAUNCH now births the
//        head 13 m downrange, so at t = 0.25 s the core sits at world x = 18 m
//        and the above-ambient-max span is x = 4 -> 42 m: an edge that crosses
//        the near band outward. Measured, this build.
//
//    (c) THE CORRIDOR OVER-DROVE THE GRASS PAST HORIZONTAL. GAIN was 1.8, and
//        grass.js multiplies windGust() by its own WIND_GAIN 0.88, so the
//        corridor alone added up to 1.54 to the grass bend term. On the pampas
//        that pushes the bend past horizontal: the plume does not whip, it LIES
//        DOWN, and the silhouette is erased for the whole 4 s beat. Evidence:
//        shots/judge-e-motion/pampas-whip.png — panel 1 (corridor off) is dense
//        upright susuki; panels 2 and 3 (head at 10 m and 21 m) are flat.
//        GAIN = 1.10 now. THE NUMBER TO COORDINATE ON — this is an exact
//        analytic bound, not a sample. windGuide's ceiling is its envelope
//        max, min(1, age/0.18) * (1 - age/4)^0.65, which peaks at 0.9705 at
//        age = 0.180 s. So the corridor's OWN contribution to windGust is:
//
//                          corridor adds to    ...and to grass's bend
//                          windGust (max)      term (x WIND_GAIN 0.88)
//            before (1.8)      1.747                   1.537
//            after  (1.10)     1.068                   0.939
//
//        Sweep-measured TOTALS including the ambient underneath (40 launch
//        phases, so the ambient sine is not cherry-picked): peak windGust
//        2.216 before -> 1.576 after; typical 1.28 after. In the running game
//        at the ridge stand, windGust at the head core measured 2.43 -> 1.58,
//        and windGust AT THE PLAYER — the blades directly under the camera,
//        the ones whose silhouette was being erased — measured 2.16 -> 0.96.
//
//        CONSUMERS: nothing about the uniform block or the GLSL changed, so
//        nothing needs to change to pick this up — but a consumer that had
//        tuned a saturation knee against the old 2.05-2.2 top end is now
//        clipping late rather than early. Place the knee above ambient p99
//        (0.514) and resolve up to ~1.6, not ~2.1.
//
//    WAVE E RESHAPE. The corridor was wired and firing, but it did not read as
//    a front travelling down a lane — it read as the entire field gusting at
//    once. Cause, measured: the along-lane falloff divided by 105 m, which is
//    LONGER THAN THE VISIBLE FIELD, so `exp(-d*d)` was still ~0.33 a hundred
//    metres behind the head; the lane divided by 30 m, i.e. a ~90 m wide
//    "lane"; and the head ran at 46 m/s for 2.2 s, crossing 8.5 m -> 110.6 m
//    inside the probe window. There was a front, and it was everywhere, and it
//    was gone before you could see it move. The geometry is now:
//
//        head, leading face    22 m     steep — the front edge you read
//        head, trailing wake   34 m     longer — the lane settling behind it
//        lane half-width        7 m     WAVE F, was 15. A path, not a prairie.
//        birth point           13 m     WAVE F, was 0 — ahead of the caller
//        head speed            20 m/s   eye-readable, matches the band speeds
//        lifetime              >= 4.0 s so the head crosses ~80 m of field
//
//    Peak intensity at the core of the head is deliberately close to what it
//    was; what collapsed is the AREA over which that peak is applied.
//
//    THE AMBIENT NUMBERS BELOW ARE MEASURED, and they replace an estimate that
//    was wrong. windGust() sampled on a 240x240 m grid every 4th frame for 4 s
//    (n = 17340), corridor idle:
//
//        mean 0.240   p10 0.083   p50 0.235   p90 0.404   p99 0.514   max 0.655
//
//    Re-measured on this build after the wave F changes: IDENTICAL to the digit
//    (mean 0.240, p50 0.235, p90 0.404, p99 0.514, max 0.655, n = 57660). GAIN,
//    LANE and LAUNCH touch the corridor only; ordinary wind is untouched.
//
//    So ambient NEVER reaches 1.0, let alone the ~1.2 this comment used to
//    claim, and its mean is 0.24, not 0.34. Peak windGust at the core of a
//    corridor head is 1.58 worst case / 1.28 typical (wave F; it was 2.05-2.22
//    at GAIN 1.8) — about 5.3x the ambient mean and 2.5x the ambient p99. A
//    consumer that saturates the gust should therefore place its knee well
//    above 0.66 (or it will flatten ordinary wind too) and still resolve detail
//    up to ~1.6.
//
// CPU side: dir (Vector2, mutated in place), strength, t, gust(),
// sample(x, z), setDirection(deg), blowToward(a, b, dur), guiding, guideDir,
// guideHead, and the two probe twins sampleGuide(x, z) and dirAt(x, z).
// sample() is the exact CPU twin of windGust() and dirAt() of windDirAt() —
// the shared numbers below are interpolated into BOTH the GLSL and the CPU
// path so they cannot drift apart again. Nothing here was removed this wave;
// dirAt() is the only addition and it is CPU-only, so no shader and no uniform
// changed shape.

// ---- the corridor's geometry, shared by the GLSL and the CPU twin -----------
// One source for both so a future tweak cannot desync the shader from sample().
const G = {
  HEAD_LEAD: 22.0,   // m, along-lane falloff AHEAD of the head (steep face)
  HEAD_TAIL: 34.0,   // m, along-lane falloff BEHIND the head (the wake)
  LANE:       7.0,   // m, across-lane falloff — the corridor's half-width
  RAMP0:    -20.0,   // m, corridor has not started this far behind the origin
  RAMP1:      8.0,   // m, corridor at full width by here
  GAIN:       1.10,  // corridor's contribution to windGust()
  BEND:       1.6,   // how hard windDirAt() commits to the corridor direction
  BEND_MAX:   0.90,  // ...and the most of the prevailing wind it may override
  LAUNCH:    13.0,   // m, how far IN FRONT of the caller the head is born
};
const f = (n) => n.toFixed(1);

// ---- GLSL: the uniform block ----------------------------------------------
export const WIND_UNIFORMS_GLSL = /* glsl */`
uniform float uWindTime;
uniform vec2  uWindDir;
uniform float uWindStr;
uniform vec4  uWindWave[3];
uniform vec4  uWindGuide;
uniform vec2  uWindGuideDir;
`;

// ---- GLSL: the sampler ------------------------------------------------------
// Unrolled rather than looped: GLSL ES 1.00 will not let a loop index address a
// vector component, and three bands do not need a loop.
export const WIND_GLSL = /* glsl */`
// Unit vector 90 degrees from the prevailing wind, world xz.
vec2 windAcross() { return vec2(-uWindDir.y, uWindDir.x); }

// Signed travelling-front field, roughly [-1, 1]. Phase is distance ALONG the
// wind, so a whole valley leans as one and the front sweeps across it.
float windWave(vec2 p) {
  float al = dot(p, uWindDir);
  float ac = dot(p, windAcross());
  return uWindWave[0].z * sin(al * uWindWave[0].x - uWindTime * uWindWave[0].y + ac * uWindWave[0].w)
       + uWindWave[1].z * sin(al * uWindWave[1].x - uWindTime * uWindWave[1].y + ac * uWindWave[1].w + 1.7)
       + uWindWave[2].z * sin(al * uWindWave[2].x - uWindTime * uWindWave[2].y + ac * uWindWave[2].w + 4.1);
}

// The guiding corridor: a gust head racing down a narrow lane. 0 when idle.
// uWindGuide.z is how far the head has travelled from the origin, so 'dl' is
// the signed distance from the front itself: positive = ahead of the head,
// which falls off fast (that edge is the thing you read as a front), negative =
// the wake it drags behind, which falls off slower so the lane settles.
float windGuide(vec2 p) {
  if (uWindGuide.w <= 0.0) return 0.0;
  vec2  g    = p - uWindGuide.xy;
  float proj = dot(g, uWindGuideDir);
  float perp = dot(g, vec2(-uWindGuideDir.y, uWindGuideDir.x));
  float dl   = proj - uWindGuide.z;
  float d    = dl / (dl > 0.0 ? ${f(G.HEAD_LEAD)} : ${f(G.HEAD_TAIL)});
  float lane = perp / ${f(G.LANE)};
  return exp(-d * d) * exp(-lane * lane)
       * smoothstep(${f(G.RAMP0)}, ${f(G.RAMP1)}, proj) * uWindGuide.w;
}

// Total local intensity. 0 = still, ~1 = ordinary wind, ~2 in a gust head.
float windGust(vec2 p) {
  return max(uWindStr * (0.55 + 0.62 * windWave(p)) + windGuide(p) * ${f(G.GAIN)}, 0.0);
}

// Local direction. Prevailing everywhere, bent into the corridor inside one.
//
// This ROTATES from the prevailing wind toward the corridor by a fraction of
// the true signed angle between them. It used to be mix(a, b, t) followed by a
// normalize, which is only well behaved while a and b are within ~90 degrees.
// Fire the corridor UPWIND and the mixed vector passes through zero inside the
// lane. Measured on the old code, prevailing 35 deg and corridor -145 deg,
// walking across the lane at the head: |mix| fell 0.80 -> 0.075 between 6 m and
// 12 m off-axis and the direction then SNAPPED from -146 deg to +36 deg at 13 m
// — a seam down the inside of the corridor, well within its 15 m half-width,
// with the grass on either side of it laid in opposite directions. Every
// consumer inherited it, because all three call this function.
//
// The rotation below is unit length at every t and every angle, so there is no
// collapse and no seam; at t = 1 it lands exactly on uWindGuideDir. atan(cross,
// dot) is a UNIFORM expression — it does not vary per vertex — so the per-vertex
// cost is one sin/cos pair, and the idle early-out makes the common case (no
// corridor blowing, which is almost always) cheaper than the old mix+normalize.
vec2 windDirAt(vec2 p) {
  if (uWindGuide.w <= 0.0) return uWindDir;
  float t   = clamp(windGuide(p) * ${f(G.BEND)}, 0.0, ${G.BEND_MAX.toFixed(2)});
  float ang = atan(uWindDir.x * uWindGuideDir.y - uWindDir.y * uWindGuideDir.x,
                   dot(uWindDir, uWindGuideDir)) * t;
  float s = sin(ang), c = cos(ang);
  return vec2(uWindDir.x * c - uWindDir.y * s, uWindDir.x * s + uWindDir.y * c);
}
`;

export function createWind() {
  const dir = new THREE.Vector2(0.82, 0.57).normalize();
  const target = new THREE.Vector2().copy(dir);
  const _wander = new THREE.Vector2();
  let t = 0;
  let baseAngle = Math.atan2(dir.y, dir.x);

  // (k = rad/m along wind, omega = rad/s, amplitude, kAcross = rad/m across).
  // omega = k * phaseSpeed; see the band table in the contract above.
  const waves = [
    new THREE.Vector4(0.0331, 0.463, 0.50, 0.0042),
    new THREE.Vector4(0.1208, 2.054, 0.32, 0.0110),
    new THREE.Vector4(0.3696, 7.390, 0.18, 0.0380),
  ];

  // Guiding wind: a directed corridor the player fires toward an objective.
  //
  // MIN_DURATION is a floor, not a default, and it is deliberate. The head now
  // travels at 20 m/s instead of 46, so the 2.4 s that game/quest.js passes —
  // a number tuned against the old 46 m/s head — would stall the front 48 m out
  // and kill it while it is still on top of the player. 4.0 s carries it ~80 m,
  // which is most of the visible field. If quest.js ever wants the duration
  // back, it only has to pass >= 4.0.
  //
  // RETRIGGER_LOCK exists because hud.callWind()'s cooldown is 1.4 s, shorter
  // than the corridor now lives. Without the lock a player holding Q would
  // re-launch the head from their feet every 1.4 s and it would never get more
  // than ~28 m out — the old "whole field gusting" read by another route. A
  // press inside the lock is ignored BY THE WIND ONLY; the HUD flourish, the
  // audio cue and the vfx leaf burst still fire, so the key still answers.
  const MIN_DURATION = 4.0;
  const RETRIGGER_LOCK = 1.5;
  const guide = {
    active: 0, age: 0, duration: MIN_DURATION, speed: 20,
    dir: new THREE.Vector2(1, 0), origin: new THREE.Vector2(),
  };

  // Shared by reference with every consumer material. uWindDir IS `dir`, so
  // mutating dir in update() is what updates the shaders — there is no copy.
  const uniforms = {
    uWindTime: { value: 0 },
    uWindDir: { value: dir },
    uWindStr: { value: 1 },
    uWindWave: { value: waves },
    uWindGuide: { value: new THREE.Vector4(0, 0, 0, 0) },
    uWindGuideDir: { value: new THREE.Vector2(1, 0) },
  };

  const api = {
    dir, strength: 1.0, t: 0, uniforms,

    // Merge the wind block into an existing uniforms object, by reference.
    attach(u) { for (const k in uniforms) u[k] = uniforms[k]; return u; },

    // Slow ambient envelope: the wind breathes rather than blowing at a
    // constant rate. This is the scalar half of the field; windWave is the
    // spatial half. uWindStr carries gust() * strength for every shader.
    gust() {
      return 0.62
        + 0.24 * Math.sin(t * 0.31)
        + 0.12 * Math.sin(t * 0.87 + 1.3)
        + 0.08 * Math.sin(t * 2.13 + 0.4);
    },

    // CPU twin of windGust(). Same bands, same phases, same clock, same
    // corridor constants (G above) — anything stepped on the CPU agrees with
    // what the shaders are drawing.
    sample(x, z) {
      const al = x * dir.x + z * dir.y;
      const ac = -x * dir.y + z * dir.x;
      const PH = [0, 1.7, 4.1];
      let w = 0;
      for (let i = 0; i < 3; i++) {
        const b = waves[i];
        w += b.z * Math.sin(al * b.x - t * b.y + ac * b.w + PH[i]);
      }
      let g = uniforms.uWindStr.value * (0.55 + 0.62 * w);
      g += api.sampleGuide(x, z) * G.GAIN;
      return Math.max(g, 0);
    },

    // CPU twin of windGuide(). Exposed so a probe (or a CPU-stepped particle)
    // can ask for the corridor alone without re-deriving the geometry.
    sampleGuide(x, z) {
      const gu = uniforms.uWindGuide.value;
      if (gu.w <= 0) return 0;
      const gx = x - gu.x, gz = z - gu.y;
      const proj = gx * guide.dir.x + gz * guide.dir.y;
      const perp = -gx * guide.dir.y + gz * guide.dir.x;
      const dl = proj - gu.z;
      const d = dl / (dl > 0 ? G.HEAD_LEAD : G.HEAD_TAIL);
      const lane = perp / G.LANE;
      let r = (proj - G.RAMP0) / (G.RAMP1 - G.RAMP0);
      r = Math.min(1, Math.max(0, r));
      const ramp = r * r * (3 - 2 * r);
      return Math.exp(-d * d) * Math.exp(-lane * lane) * ramp * gu.w;
    },

    // CPU twin of windDirAt(). Same rotation, same clamp, same constants, so a
    // probe can assert that the shader and the CPU agree on which way the air
    // is moving at a point — which is how the 180-degree seam described above
    // was caught. Returns a unit [x, z] pair.
    dirAt(x, z) {
      const gu = uniforms.uWindGuide.value;
      if (gu.w <= 0) return [dir.x, dir.y];
      const gd = uniforms.uWindGuideDir.value;
      const tt = Math.min(G.BEND_MAX, Math.max(0, api.sampleGuide(x, z) * G.BEND));
      const ang = Math.atan2(dir.x * gd.y - dir.y * gd.x, dir.x * gd.x + dir.y * gd.y) * tt;
      const s = Math.sin(ang), c = Math.cos(ang);
      return [dir.x * c - dir.y * s, dir.x * s + dir.y * c];
    },

    setDirection(deg) {
      const r = THREE.MathUtils.degToRad(deg);
      // Move the wander's own centre, not just the target: otherwise the slow
      // follow drags the direction straight back where it came from.
      baseAngle = r;
      target.set(Math.cos(r), Math.sin(r));
    },

    // Fire the guiding wind toward a world point. This does NOT rotate the
    // prevailing wind — a 51-degree yank of the whole world's direction is what
    // used to make this beat read as the map spinning rather than as a gust.
    // It launches a corridor that every consumer of the field can see.
    //
    // Returns true if a head was launched, false if the call was swallowed by
    // RETRIGGER_LOCK (see above). Callers may ignore the return value.
    blowToward(fromVec3, toVec3, duration = MIN_DURATION) {
      if (guide.active > 0 && guide.age < RETRIGGER_LOCK) return false;
      guide.dir.set(toVec3.x - fromVec3.x, toVec3.z - fromVec3.z);
      const reach = guide.dir.length();
      if (reach < 1e-4) guide.dir.copy(dir); else guide.dir.divideScalar(reach);
      // BORN IN FRONT OF THE CALLER, NOT ON TOP OF THEM. The head used to start
      // at the player's feet, so its 22 m leading face was already PAST the
      // camera on frame one: the front never arrived, it only receded, and the
      // corridor read as "the field gusted" rather than "a lane opened". Moving
      // the birth point G.LAUNCH metres downrange puts that steep face out in
      // the near band where individual blades are still legible, and it crosses
      // outward from there. Clamped to half the distance to the objective so a
      // target closer than G.LAUNCH cannot spawn the head beyond it.
      guide.origin.set(fromVec3.x, fromVec3.z)
        .addScaledVector(guide.dir, Math.min(G.LAUNCH, reach * 0.5));
      guide.active = 1;
      guide.age = 0;
      guide.duration = Math.max(MIN_DURATION, duration);
      uniforms.uWindGuideDir.value.copy(guide.dir);
      return true;
    },
    get guiding() { return guide.active; },
    get guideDir() { return guide.dir; },
    get guideHead() { return uniforms.uWindGuide.value.z; },

    update(dt) {
      t += dt; api.t = t; uniforms.uWindTime.value = t;

      // Slow wander. The integral of sin(0.07t)*0.012 has amplitude
      // 0.012/0.07 = 0.171 rad, and the 0.05 follow attenuates that to about
      // +-5 degrees with a peak rate of 0.6 deg/s. Measured before: 31 degrees
      // in 8.6 s, up to 6.9 deg/s, which pivoted every wavefront in the game.
      baseAngle += Math.sin(t * 0.07) * dt * 0.012;
      _wander.set(Math.cos(baseAngle), Math.sin(baseAngle));
      target.lerp(_wander, 1 - Math.exp(-0.05 * dt)).normalize();
      dir.lerp(target, 1 - Math.exp(-1.4 * dt)).normalize();

      uniforms.uWindStr.value = api.gust() * api.strength;

      if (guide.active > 0) {
        guide.age += dt;
        guide.active = Math.max(0, 1 - guide.age / guide.duration);
        // Hard attack so the corridor leaves the player at once, then a tail
        // that outlasts the head so the lane settles instead of snapping off.
        const env = Math.min(1, guide.age / 0.18) * Math.pow(guide.active, 0.65);
        uniforms.uWindGuide.value.set(
          guide.origin.x, guide.origin.y, guide.age * guide.speed, env);
      } else if (uniforms.uWindGuide.value.w !== 0) {
        uniforms.uWindGuide.value.w = 0;
      }
    },
  };
  return api;
}
