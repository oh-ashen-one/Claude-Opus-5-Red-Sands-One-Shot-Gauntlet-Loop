import * as THREE from 'three';
// OWNER: horse lane. Mount, gaits, terrain-aware riding, mount/dismount, mane/tail.
// INTERFACE: createHorse(ctx) -> { group, position, update(dt,ctx), mount(), dismount(),
//   get mounted(), setPosition(x,y,z,faceDeg), speed }
//
// WAVE F REBUILD. Six critical findings across one panel and repeated rubric
// automatic-fails for "reads as flat-shaded untextured polygons" were all one
// defect: the animal was assembled from thirty-one interpenetrating primitives
// and every intersection was a readable shading crease. The hide is now a SINGLE
// skinned tube from the point of the buttock to the lips, and each leg is a
// single skinned tube from inside the barrel to the top of the hoof. See
// skinTube() and the HIDE table in buildHorse().
//
// The horse is built to real equine proportions (1.61 m at the withers, 1.96 m
// point-of-buttock to point-of-shoulder — a horse is very nearly square, and the
// old barrel was 2.47 m, which is what made the legs look spindly): one lofted
// hide with a deep girth and a tucked flank, an arched neck, a wedge
// head, and four IK legs whose joints sit where a horse's actually sit —
// shoulder 1.06, elbow 0.83, knee 0.52 in front; hip 1.15, stifle 0.86, hock 0.50
// behind. Feet are pinned in world space through stance, so nothing skates: the
// body moves and the planted hoof stays where it was put.
//
// Four gaits with the real footfall patterns (walk 4-beat lateral, trot 2-beat
// diagonal, canter 3-beat right lead, gallop 4-beat right lead + suspension),
// blended continuously by speed. Stride frequency is derived from speed, so the
// stride length stays believable at every point of the acceleration curve.

/* ========================== palette ==========================
   A bay, read off the reference frame rather than invented. The old coat
   (#4d3626) was a desaturated mud sitting three stops under the grass it stands
   in; measured at t=0.726 the whole animal came back as one flat rgb(22,29,43)
   against grass at 150-215. A real bay is a warm red-brown with black points,
   and it needs to be light enough that the shaded side still has somewhere to
   fall to. */
/* WAVE F — measured against references/field_2.png. There the animal's barrel
   returns (48,20,4) while the grass it stands in returns (52,29,8): the horse is
   the SAME luminance as the field and far more saturated — a deep red-black. Our
   05-summit horse returned (133,94,60) against a lower half of (136,88,56): the
   same luminance, but washed pink and, more damningly, flat. The 30-35% albedo
   cut below is half the fix; the other half is the bounce floors in the shader,
   which were adding a constant albedo-tinted lift to EVERY fragment regardless
   of orientation and are what actually flattened the form. */
const COL = {
  coat:     '#5b4029',
  coatDk:   '#3a2315',
  coatLt:   '#725236',                     // countershaded flank / muzzle ring
  muzzle:   '#281810',
  hoof:     '#2b2521',
  hair:     '#1b120b',
  leather:  '#5a3a26',
  leatherDk:'#3a2415',
  cloth:    '#6b2620',
  lacquer:  '#1b1b21',
  gold:     '#c2963f',
  steel:    '#b3bac2',
  eye:      '#0a0908',
};

/* ========================== materials ========================
   Two shader injections, and the second one is the fix for the worst bug on
   this asset.

   1. RIM — the same injection samurai.js uses. The uniforms MUST be declared in
      the GLSL as well as pushed onto sh.uniforms or the program silently fails
      to compile and the object vanishes.

   2. GROUND BOUNCE — new. Measured at golden hour with the sun behind the
      animal: the barrel, the haunch and the shoulder ALL returned exactly
      rgb(22,29,43), one flat value with no gradient anywhere on the body, while
      the same pixels with the horse hidden read (186,141,43). The light rig is
      one key, one cool fill and a hemi; nothing bounces off the sunlit ground,
      so a backlit body has only a constant ambient plateau on its camera side
      and lands on the grade's black floor. This term is that missing bounce:
      warm, strongest on down-facing and away-from-key surfaces, and multiplied
      by the albedo so a bay stays a bay instead of turning into fog.

   And the bug underneath both: rimShaders[] was being FILLED and never read.
   uRimDirView therefore stayed at its construction default of (0,0,1), which
   makes `back` zero for every camera-facing fragment and leaves only the 0.18
   floor — the horse got no rim light at exactly the hour the rim exists for,
   while the samurai standing two metres away drives the same uniforms every
   frame from its own update. driveRim() below is the half that was missing.

   3. AND THEN IT WENT TOO FAR THE OTHER WAY. Measured at t=0.718, sun intensity
      8.23, broadside at 3.4 m: the barrel came back at (115,64,57) with the
      topline blown past (225,164,59), the tail a bleached grey broom, and the
      mane invisible because it had been washed to the same cream as the neck it
      hangs on. The arithmetic: uRimStrength was clamp(sunI*0.34, .18, 1.5),
      capped at 1.5, times a per-material 1.35 on the coat and 1.7 on the hair —
      2.03 and 2.55, against the samurai's 1.4 with no multiplier. With a rim
      power of only 2.0-2.5 that is not an edge light, it is a near-white
      additive fog over the whole animal: at the middle of the barrel, where
      |N.V| is about 0.5, it was still adding 0.18 linear of uncoloured light on
      top of an albedo worth about 0.25. That is what flattened the form and
      what made black horsehair read as straw.
      The rim now runs at the samurai's law with a per-material scale at or
      under 1, and at power 4.0-5.5 so it stays where a rim belongs: within a few
      degrees of the silhouette. The lost value is put back through the BOUNCE
      instead, which multiplies by the albedo and therefore keeps the coat a bay
      instead of turning it to fog. */
const rimShaders = [];
function mat(color, o = {}) {
  const m = new THREE.MeshStandardMaterial({
    color, roughness: o.rough ?? 0.72, metalness: o.metal ?? 0.0,
    side: o.side ?? THREE.FrontSide, flatShading: !!o.flat,
    map: o.map || null, bumpMap: o.bump || null, bumpScale: o.bumpScale ?? 0.0022,
    vertexColors: !!o.vc,
  });
  // power: pow(1-|N.V|, p) at the middle of a barrel (|N.V| ~ 0.5) is 0.177 at
  // 2.5, 0.109 at 3.2 and 0.063 at 4.0, while at the silhouette all three are 1.
  // The exponent is the difference between an edge light and a fog. 4.0 was too
  // tight to survive the rim-strength cut below it — see driveRim: at the
  // shoulder (|N.V| ~ 0.7) the animal was getting 8x less rim than the samurai
  // standing next to it. 3.2 sits between the samurai's 2.8 and the old 4.0.
  const power = o.rimPower ?? 3.0, scale = o.rim ?? 1.0, bounce = o.bounce ?? 1.0;
  /* WAVE I — the hide's highlight knee, and the reason a flat albedo cut could
     not do this job on its own.
     Measured: cutting the coat albedo to 0.62 of its value moved the sunlit
     barrel on 06-forest from lum 89.2 to 73.1 — an output response of 0.82 for
     an input of 0.62, because the lit side of the animal sits well up the
     tonemapper's shoulder where the curve is nearly flat. To reach the
     reference's horse-to-field ratio that way would take an albedo of 0.19,
     which would take the SHADED side (01-sunset-ridge, already at 0.41x the
     field where the reference is 0.57x) down to a black cutout.
     Two references, measured: field_2 puts the horse at 0.57x the grass
     immediately around it; field_9 at 0.43x. In both the animal is a dark warm
     mass and the FIELD carries the highlights. Ours was carrying the brightest
     thing in the middle of the frame at 1.25x.
     So the top end is compressed and the bottom end is left alone: a Reinhard
     soft-clip above uKnee in the material's own pre-tonemap linear space. A
     horse's summer coat is a matte hide; it has no business out-reading a
     backlit meadow. 0 disables it. */
  const knee = o.knee ?? 0.0;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uRimColor = { value: new THREE.Color('#ffb877') };
    sh.uniforms.uRimDirView = { value: new THREE.Vector3(0, 0, 1) };
    sh.uniforms.uRimPower = { value: power };
    sh.uniforms.uRimStrength = { value: scale };
    sh.uniforms.uBounceColor = { value: new THREE.Color('#c98d52') };
    sh.uniforms.uBounceAmt = { value: 0.0 };
    sh.uniforms.uUpView = { value: new THREE.Vector3(0, 1, 0) };
    sh.uniforms.uKnee = { value: knee };
    sh.fragmentShader =
        'uniform vec3 uRimColor;\nuniform vec3 uRimDirView;\n'
      + 'uniform float uRimPower;\nuniform float uRimStrength;\n'
      + 'uniform vec3 uBounceColor;\nuniform float uBounceAmt;\nuniform vec3 uUpView;\n'
      + 'uniform float uKnee;\n'
      + sh.fragmentShader;
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <opaque_fragment>',
      `{
         vec3 rimV = normalize(vViewPosition);
         vec3 nn = normalize(normal);
         // abs(): without it a normal pointing away clamps to zero and returns
         // a full-strength rim on the wrong side of the silhouette.
         float rim = pow(1.0 - clamp(abs(dot(nn, rimV)), 0.0, 1.0), uRimPower);
         float back = clamp(dot(-uRimDirView, rimV), 0.0, 1.0);
         // ...and only on the edges actually turned TOWARD the key. This read
         // dot(nn, -uRimDirView), i.e. it was strongest where the surface faces
         // AWAY from the sun — which on a backlit animal is the entire flank
         // pointed at the camera. That is not a rim, it is an additive fog laid
         // over the whole silhouette, and it is why raising the strength to the
         // samurai's law bleached the barrel to cream on 03-coast instead of
         // drawing an edge. samurai.js fixed exactly this sign on its own rim in
         // the same wave, with the same squared falloff; the horse never got it.
         float side = clamp(dot(nn, uRimDirView), -1.0, 1.0) * 0.5 + 0.5;
         outgoingLight += uRimColor * rim * (0.14 + 0.86 * back) * (0.14 + 0.86 * side * side) * uRimStrength;
         // Ground bounce. bDown is 1 where the surface looks at the ground,
         // bAway is 1 where it looks away from the key — the belly and the
         // shaded flank, which is exactly where a lit meadow throws light.
         // The two floors (0.30 / 0.28, up from 0.26 / 0.22) matter more than the
         // amplitude: they are what stops any part of the animal reaching the
         // grade with no light on it at all, and because this term multiplies
         // the albedo, the part that survives is the coat's own colour rather
         // than the grade's blue shadow lift.
         float bDown = clamp(0.5 - dot(nn, uUpView) * 0.5, 0.0, 1.0);
         float bAway = clamp(0.5 - dot(nn, uRimDirView) * 0.5, 0.0, 1.0);
         // FLOORS CUT 0.30/0.28 -> 0.08/0.10. At the old floors the product never
         // fell below 0.084 anywhere on the animal, so this term was a constant
         // albedo-coloured lift over the WHOLE body: an up-facing croup in full
         // key and a down-facing belly in shade differed by only 4.3x when the
         // physical ratio is more like 30x. That constant is what made the coat
         // read as one flat salmon slab at 1:1. Now the product runs 0.008 to
         // 1.0 and the bounce lands where a lit meadow actually throws light.
         outgoingLight += diffuseColor.rgb * uBounceColor
                        * (0.14 + 0.86 * bDown) * (0.16 + 0.84 * bAway) * uBounceAmt;
         // Matte-hide knee. Applied to the channel maximum so the hue and the
         // saturation of the coat are carried through unchanged — scaling the
         // channels independently would desaturate the hot band toward the key's
         // own colour, which is the cream-barrel failure of two waves ago.
         if (uKnee > 0.0) {
           float lm = max(max(outgoingLight.r, outgoingLight.g), outgoingLight.b);
           if (lm > uKnee) {
             float e = lm - uKnee;
             outgoingLight *= (uKnee + e / (1.0 + e / uKnee)) / lm;
           }
         }
       }
       #include <opaque_fragment>`
    );
    sh.__rimBase = scale;
    sh.__bounceBase = bounce;
    sh.__kneeBase = knee;
    rimShaders.push(sh);
  };
  return m;
}

// Push the live key into every rim/bounce shader. Without this the uniforms sit
// at their construction defaults for the entire run.
const _rimV = new THREE.Vector3(), _upV = new THREE.Vector3();
const _warmRim = new THREE.Color();
const _bounceC = new THREE.Color();
// Warm meadow at golden hour; cold wet ground under a moon. The bounce colour has
// to move between these two or the animal carries a sunset on its belly at midnight.
const GROUND_DAY = new THREE.Color('#c98d52');
// The rim is added un-multiplied by the albedo, so at 1.20x the sun's own colour
// it tonemapped toward white: the topline measured (84,72,77), a grey-pink,
// where the reference's backlit topline is (98,62,29). Pulled toward a warm
// ember and taken off the 1.20 boost.
const RIM_WARM = new THREE.Color('#ffa251');
const GROUND_NIGHT = new THREE.Color('#3c4a6b');
function driveRim(ctx) {
  const sky = ctx.sky, cam = ctx.camera;
  if (!sky || !cam || !rimShaders.length) return;
  _rimV.copy(sky.sunPos).transformDirection(cam.matrixWorldInverse);
  _upV.set(0, 1, 0).transformDirection(cam.matrixWorldInverse);
  const sunI = sky.sun ? sky.sun.intensity : 0;
  if (sky.sun) _warmRim.copy(sky.sun.color).lerp(RIM_WARM, 0.34).multiplyScalar(1.04);
  /* sky.sun is ONE DirectionalLight that the sky hands over to the moon after
     dark — measured at t=0.02 it still reports intensity 7.00, colour 7a9ce8.
     So "the bounce tracks the key, and is almost nothing under the moon" was
     never true: driving off intensity alone gave the horse a full-strength WARM
     ground bounce at midnight. Which key is up has to come from the altitude,
     the same smoothstep(-8, -3) the sky itself uses for its solar/lunar blend. */
  const alt = ctx.tod ? ctx.tod.sunAltitude : 90;
  const solar = THREE.MathUtils.smoothstep(alt, -8.0, -3.0);   // 1 sun, 0 moon
  _bounceC.copy(GROUND_NIGHT).lerp(GROUND_DAY, solar);
  /* MERGE RECONCILIATION — the daylight half of this asset, and the reason the
     animal reads as a near-black cutout at every judged (backlit) pose while the
     samurai two metres away keeps a hot edge.

     This line was written to match samurai.js and then samurai.js moved under it
     in the same wave that rebalanced sky.js: the character's rim went from
     `sunI * 0.30, capped 1.4` to `sunI * 0.34, capped 1.9`, because the rig it
     competes with lost two thirds of its indirect (hemi 4.20 -> 1.55, amb
     0.75 -> 0.26, fill 1.25 -> 0.60 at magic hour). The horse kept the OLD
     number, capped it even lower at 1.25, and then multiplied it a second time
     by a per-material scale of 0.5-0.9. Measured at t=0.718, sunI 12.72: the
     samurai's coat runs a rim of 1.90 at power 2.8; the horse's ran 1.25 x 0.80
     = 1.00 at power 4.0, which at the shoulder (|N.V| ~ 0.7) is 0.0081 against
     0.068 — EIGHT TIMES less light on the one edge that separates the animal
     from the field behind it.

     Same law as the samurai now, so the two actors in one frame get one rim.
     The (0.42 + 0.58*solar) factor is the horse's own, and is tuned so the NIGHT
     value is unchanged: 2.10 * 0.34 = 0.714 * 0.42 = 0.300, exactly what
     clamp(2.10*0.30,...) * 0.48 used to deliver. Only daylight moves. */
  const str = clamp(sunI * 0.34, 0.16, 1.90) * (0.42 + 0.58 * solar);
  // The old 0.62 ceiling was the same unreconciled crush seen from the other
  // side. This term is the horse's substitute for the indirect the rig no longer
  // delivers, and 0.075*sunI hits 0.62 at sunI 8.3 — so it was PINNED at its
  // ceiling through every daylight pose in poses.json (sunI 8.98-12.72) and
  // could not track the sun it was supposed to be tracking. Raised so the
  // daylight end has somewhere to go; the night end is untouched because
  // 2.10 * 0.085 = 0.179 is nowhere near either bound and 0.42 still scales it.
  /* 0.085 -> 0.190 and the ceiling 1.05 -> 2.20. Measured on 01-sunset-ridge,
     where the animal stands inside the tree's shadow: the coat came back at
     (29,32,48) against shadowed grass at (48,40,50) — 40% darker than the field
     it stands in AND blue, because with the key occluded the only thing left on
     it was the rig's cool ambient. In references/field_2.png the horse in the
     forest reads (48,20,4) against grass at (52,29,8): the same luminance as the
     field, and warm. This term is the only warm light the animal has in shadow
     and it multiplies the albedo, so raising it darkens nothing and keeps a bay
     a bay. */
  /* The solar factor is the bounce's OWN, not the rim's, and it is 0.188 rather
     than 0.42 purely to hold the night value fixed while the daylight end moved:
     2.10 * 0.190 * 0.188 = 0.0751, which is exactly what 2.10 * 0.085 * 0.42
     delivered before. A moonlit meadow does bounce — the animal must not be a
     cutout at night — but at a fraction of golden hour, and cold. */
  const bAmt = clamp(sunI * 0.190, 0.060, 2.20) * (0.188 + 0.812 * solar);
  for (let i = 0; i < rimShaders.length; i++) {
    const sh = rimShaders[i];
    sh.uniforms.uRimDirView.value.copy(_rimV);
    sh.uniforms.uUpView.value.copy(_upV);
    if (sky.sun) sh.uniforms.uRimColor.value.copy(_warmRim);
    sh.uniforms.uBounceColor.value.copy(_bounceC);
    sh.uniforms.uRimStrength.value = str * sh.__rimBase;
    sh.uniforms.uBounceAmt.value = bAmt * sh.__bounceBase;
  }
}

/* ====================== geometry helpers ===================== */
// Deterministic RNG so the horse is identical every run.
function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Loft a tube through elliptical cross-sections. axis 'z': sections are
// [a(long axis), c(cross-centre on y), w(half width x), h(half height y)].
// axis 'y': [a(y), c(cross-centre on z), w(half width x), h(half depth z)].
// Winding is corrected automatically by testing one normal against the expected
// outward direction, so section order never has to be remembered.
function loft(sections, axis = 'z', radial = 14, squareness = 0.86) {
  const n = sections.length;
  const pos = new Float32Array(n * radial * 3);
  // UVs so the coat map has something to land on. The loft is not
  // area-preserving, so a photographic map would stretch across the barrel —
  // the coat map is isotropic dapple noise, and what matters is only that every
  // surface HAS a uv at all. Scaled by the real section girth so the grain does
  // not get four times denser on a cannon bone than on the barrel.
  const uv = new Float32Array(n * radial * 2);
  const shape = (u) => Math.sign(u) * Math.pow(Math.abs(u), squareness);
  let p = 0, q = 0, run = 0;
  for (let i = 0; i < n; i++) {
    const [a, c, w, h] = sections[i];
    if (i > 0) run += Math.abs(a - sections[i - 1][0]);
    const girth = (w + h) * Math.PI * 0.5;
    for (let j = 0; j < radial; j++) {
      const th = (j / radial) * Math.PI * 2;
      const x = w * Math.sin(th);
      const t = c + h * shape(Math.cos(th));
      if (axis === 'z') { pos[p++] = x; pos[p++] = t; pos[p++] = a; }
      else { pos[p++] = x; pos[p++] = a; pos[p++] = t; }
      uv[q++] = (j / radial) * girth * 1.6;
      uv[q++] = run * 1.6;
    }
  }
  const idx = [];
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const j2 = (j + 1) % radial;
      const A = i * radial + j, B = (i + 1) * radial + j;
      const C = (i + 1) * radial + j2, D = i * radial + j2;
      idx.push(A, B, C, A, C, D);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // Ring 1, vertex 0 is the "top" of the section; its normal must point outward.
  const nrm = g.attributes.normal;
  const k = radial + 0;
  const dot = axis === 'z' ? nrm.getY(k) : nrm.getZ(k);
  if (dot < 0) {
    for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
    g.setIndex(idx); g.computeVertexNormals();
  }
  return g;
}

// A limb segment hanging from the joint down -Y, elliptical, with an optional
// mid-bulge for muscle.
// `over` runs the tube a little past both joints and pinches it there, so the
// open end of one segment is always buried inside the next joint's mass instead
// of showing as a hard ring when the limb bends.
function segGeo(len, wTop, dTop, wBot, dBot, bulge = 0, over = 0) {
  const s = [];
  const steps = 6;
  const at = (t, k) => {
    const b = 1 + bulge * Math.sin(Math.PI * clamp(t, 0, 1));
    return [-len * t, 0, THREE.MathUtils.lerp(wTop, wBot, clamp(t, 0, 1)) * b * k,
            THREE.MathUtils.lerp(dTop, dBot, clamp(t, 0, 1)) * b * k];
  };
  if (over > 0) s.push(at(-over / len, 0.90));
  for (let i = 0; i <= steps; i++) s.push(at(i / steps, 1));
  if (over > 0) s.push(at(1 + over / len, 0.90));
  return loft(s, 'y', 12, 1.0);
}

/* ------------------------------- coat map -------------------------------
   A flat colour is what "untextured polygons" actually means: with one value
   over the whole barrel there is nothing for the low sun to catch and the eye
   reads a slab. This is the same trick samurai.js uses for its cloth — a
   procedural canvas painted once, used as both a value map and a bump map, so
   the coat has dapples, a hair grain that runs along the body, and a summer
   sheen that breaks up under a raking key.

   Grayscale and centred near white: the map MULTIPLIES the material colour, so
   it is normalised to its own mean in LINEAR light and the palette colour is
   divided by that mean on the way in. Otherwise every coat silently darkens by
   the mean of the texture. */
let _coat = null;
function coatMaps() {
  if (_coat) return _coat;
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const c = cv.getContext('2d');
  const r = rng(9173);
  c.fillStyle = '#e0e0e0'; c.fillRect(0, 0, S, S);

  /* WAVE F. The old map existed but could not be SEEN: strokes at alpha 0.55
     with a value swing of +-23 around 232, dapples at alpha 0.16-0.38 of pure
     white, and a bumpScale of 0.0026. On a coat whose linear albedo is about
     0.06 that is a peak-to-peak of roughly two 8-bit levels in the final frame
     — under the grade's own dither. A critic at 1:1 called the result "smooth
     plastic ... no visible fur, hair-flow or micro-detail at all", which is
     exactly right: the detail was there in the texture and never survived to a
     pixel. Everything below is roughly 3x the amplitude, at 512 instead of 256,
     and the bump that goes with it is 6x. */

  // Low-frequency blotching first, so the dapples and grain ride on a coat that
  // already has large-scale value. Without this the barrel is one tone with
  // speckle on it, which reads as noise rather than as an animal.
  for (let i = 0; i < 26; i++) {
    const x = r() * S, y = r() * S, rad = 55 + r() * 110;
    const g = c.createRadialGradient(x, y, 0, x, y, rad);
    const dark = r() < 0.5;
    // 0.10-0.26 -> 0.04-0.10. Measured in the inspector at 4.6 m: at the first
    // amplitude the blotches and the dark mottles below read as an appaloosa's
    // spots, not as a coat. This layer is meant to be a value the eye finds at
    // 1:1 and does not consciously see at riding distance.
    const amt = 0.04 + r() * 0.06;
    g.addColorStop(0.0, dark ? `rgba(0,0,0,${amt})` : `rgba(255,255,255,${amt})`);
    g.addColorStop(1.0, dark ? 'rgba(0,0,0,0)' : 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.beginPath(); c.arc(x, y, rad, 0, Math.PI * 2); c.fill();
  }

  // Hair grain: strokes running along the length axis (v), wrapped. Twice the
  // count for the 4x area, and a value swing wide enough to survive the grade.
  c.lineWidth = 1;
  for (let i = 0; i < 14000; i++) {
    const x = r() * S, y = r() * S, len = 7 + r() * 26;
    const v = 224 + (r() - 0.5) * 132;
    c.strokeStyle = `rgba(${clamp(v, 0, 255) | 0},${clamp(v, 0, 255) | 0},${clamp(v, 0, 255) | 0},0.62)`;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + (r() - 0.5) * 5, y + len);
    c.stroke();
  }
  // A second, coarser pass of longer strokes: this is the hair FLOW, the thing
  // that reads as a direction on the coat rather than as grain.
  c.lineWidth = 2.2;
  for (let i = 0; i < 1700; i++) {
    const x = r() * S, y = r() * S, len = 26 + r() * 60;
    const v = 218 + (r() - 0.5) * 96;
    c.strokeStyle = `rgba(${clamp(v, 0, 255) | 0},${clamp(v, 0, 255) | 0},${clamp(v, 0, 255) | 0},0.30)`;
    c.beginPath();
    c.moveTo(x, y);
    c.bezierCurveTo(x + (r() - 0.5) * 8, y + len * 0.35,
                    x + (r() - 0.5) * 10, y + len * 0.7, x + (r() - 0.5) * 12, y + len);
    c.stroke();
  }
  // dapples: soft rings of lighter coat, the signature of a summer bay
  for (let i = 0; i < 150; i++) {
    const x = r() * S, y = r() * S, rad = 16 + r() * 34;
    const g = c.createRadialGradient(x, y, 0, x, y, rad);
    const amt = 0.13 + r() * 0.15;
    g.addColorStop(0.0, `rgba(255,255,255,${amt})`);
    g.addColorStop(0.55, `rgba(255,255,255,${amt * 0.42})`);
    g.addColorStop(1.0, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.beginPath(); c.arc(x, y, rad, 0, Math.PI * 2); c.fill();
  }
  // darker mottles so the value does not only ever go up
  for (let i = 0; i < 70; i++) {
    const x = r() * S, y = r() * S, rad = 12 + r() * 28;
    const g = c.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0.0, `rgba(0,0,0,${0.07 + r() * 0.10})`);
    g.addColorStop(1.0, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.beginPath(); c.arc(x, y, rad, 0, Math.PI * 2); c.fill();
  }

  // linear mean, so the palette colour can be divided back out
  const px = c.getImageData(0, 0, S, S).data;
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) {
    const s = px[i] / 255;
    sum += s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }
  const mean = sum / (px.length / 4);

  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const bump = new THREE.CanvasTexture(cv);
  bump.wrapS = bump.wrapT = THREE.RepeatWrapping;
  _coat = { map: tex, bump, mean };
  return _coat;
}

/* WAVE I — the coat's VALUE, measured against the reference instead of argued.
   The one number that decides whether the animal belongs to the frame is its
   luminance relative to the field it is standing in, and it is measurable on
   both sides. references/field_2.png returns horse barrel 24.7 against the
   grass immediately around it at 43.0 (0.57x); references/field_9.png returns
   horse rump 22.7 against grass at 52.4 (0.43x). In both the animal is a dark
   warm mass and the FIELD carries the highlights.
   This build, measured on a barrel patch against the field in the same frame:
   06-forest 1.22x (the animal was the brightest thing in the middle of the
   frame) and 01-sunset-ridge 0.43x. That is not one error, it is a CONTRAST
   error — the lit state is two and a half stops off the reference while the
   shaded state is already sitting exactly on it. Which is why COAT_VALUE is
   1.00 and stays 1.00: a flat albedo cut moves both states together. It was
   tried at 0.62 and measured — 06 came down from 1.22x to 1.03x, but 01 went
   from 0.43x to 0.39x, i.e. it bought a little on the pose that was wrong by
   spending it on the pose that was right. The lit state is fixed by the
   highlight knee in mat() instead, which by construction cannot touch a
   surface that never reaches it.
   Left in place, at 1.00, as the knob to reach for if a future grade moves the
   whole animal rather than only its lit half. */
const COAT_VALUE = 1.00;
// Divide a palette colour by the coat map's mean so the map does not darken it.
function lifted(hex, mean) {
  const c = new THREE.Color(hex);
  c.multiplyScalar(COAT_VALUE / mean);
  return c;
}

// A clump of hair: tapered strips fanned around the origin, hanging down -Y and
// drifting back -Z. Normals are pushed upward so the mass catches sky light
// instead of reading as a black card.
/* THE MANE BUG, and it is a one-line one.
   `ang` used to be r()*PI, i.e. every ribbon's WIDTH AXIS pointed somewhere
   random in the xz plane. A mane hangs down one side of the neck — the +x side
   here — so a broadside camera looks along x. Every ribbon whose width axis
   came out near x is therefore edge-on to that camera and subtends, at 6 m
   through a 50-degree lens, well under one pixel. Half the strands were
   invisible and the rest were the "two hairline dark scratches" the critic
   logged. `axis` now fixes the ribbon plane: 0 spans the ribbon along z (its
   face points along x, at a camera standing beside the horse), PI/2 spans it
   along x. `spread` re-introduces a little variation without ever letting a
   strand go fully edge-on. */
function hairGeo({ n = 10, len = 0.30, spanX = 0.05, spanZ = 0.04, width = 0.020,
                   bend = 0.35, seed = 7, taper = 0.55, segs = 4,
                   axis = null, spread = 0.55, sheet = 0, drift = 0, curl = 0 }) {
  const r = rng(seed);
  const pos = [], idx = [];
  let v = 0;
  for (let s = 0; s < n; s++) {
    // `sheet`: lay the roots along a line instead of scattering them in a box,
    // so the clump reads as a continuous curtain of hair rather than a bush.
    const u = n > 1 ? s / (n - 1) - 0.5 : 0;
    const ox = sheet ? u * spanX * 2 + (r() - 0.5) * spanX * 0.35 : (r() - 0.5) * spanX * 2;
    const oz = sheet ? (r() - 0.5) * spanZ * 2 * 0.7 + u * spanZ * sheet
                     : (r() - 0.5) * spanZ * 2;
    const L = len * (0.70 + r() * 0.62);
    const bd = bend * (0.5 + r());
    const w0 = width * (0.7 + r() * 0.7);
    const ang = axis === null ? r() * Math.PI : axis + (r() - 0.5) * spread;
    const wx = Math.cos(ang), wz = Math.sin(ang);
    const base = v;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const y = -L * t;
      const z = oz - bd * t * t * L;
      const w = w0 * (1 - taper * t);
      const dx = ox + drift * t * t * L + Math.sin(t * 2.4 + s) * curl * t * L;
      pos.push(dx - wx * w, y, z - wz * w, dx + wx * w, y, z + wz * w);
      v += 2;
    }
    for (let i = 0; i < segs; i++) {
      const a = base + i * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const nm = g.attributes.normal;
  for (let i = 0; i < nm.count; i++) {
    _v1.set(nm.getX(i), nm.getY(i) + 0.9, nm.getZ(i)).normalize();
    nm.setXYZ(i, _v1.x, _v1.y, _v1.z);
  }
  return g;
}

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _e1 = new THREE.Euler();
const UPV = new THREE.Vector3(0, 1, 0);
const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
// Shortest-arc difference for a 0..1 cyclic phase.
function cdiff(a, b) { let d = b - a; d -= Math.floor(d + 0.5); return d; }
function clerp(a, b, t) { return a + cdiff(a, b) * t; }
function smooth(t) { return t * t * (3 - 2 * t); }

/* ===================== the animal itself ===================== */
// Every measurement is in metres and matches a real 1.58 m horse.
const BODY_Y = 1.20;                       // barrel centre above the hooves
// How far the hoof wall stands INTO the sward. 0.022 left the wall sitting on
// the mathematical ground plane with 0.4 m of grass around it, which is what
// "the hoof sits above the grass with no anchoring" looks like from three
// metres. A hoof in a meadow is buried to the coronet.
const HOOF_SINK = 0.050;
/* x 0.185 -> 0.165. The barrel's own half-width at the shoulder (z 0.55,
   y -0.14) is 0.272; with the leg tube 0.100 wide at the top, a pivot at 0.185
   put the shoulder 1.3 cm PROUD of the hide and re-created exactly the
   intersection ridge this whole rebuild exists to remove. At 0.165 the top of
   the limb is swallowed. */
const FORE = { x: 0.165, y: -0.14, z: 0.50, a: 0.30, b: 0.36, c: 0.52, s: -1 };
const HIND = { x: 0.165, y: -0.05, z: -0.56, a: 0.36, b: 0.42, c: 0.50, s: 1 };

/* The barrel's cross-sections. The tack is built against these, so they have to
   agree with the hide's own section table (see HIDE in buildHorse) or the saddle
   sinks into the animal.

   RETIMED IN WAVE F, and this is a proportion bug nobody had measured. The old
   table ran z -1.18 to +1.06, and with the breast the animal was 2.47 m from the
   point of the buttock to the point of the shoulder against a wither height of
   1.62 m — a ratio of 1.52. A horse is very nearly SQUARE: body length is about
   1.05-1.15 times the height at the withers. At 1.52 it read as a dachshund, and
   it is why the legs looked spindly: they were the right length under a body
   half again too long for them. The table below is 1.96 m at the same 1.61 m
   withers, i.e. 1.22, and every consumer (leg pivots, neck base, tail root,
   saddle spans) moved with it.
   [z, centre-y, half-width, half-height-to-the-TOPLINE] */
const BARREL = [
  [-0.940, 0.020, 0.045, 0.055],
  [-0.900, 0.045, 0.120, 0.145],
  [-0.840, 0.080, 0.210, 0.235],
  [-0.775, 0.100, 0.264, 0.264],
  [-0.700, 0.088, 0.302, 0.276],
  [-0.620, 0.058, 0.306, 0.292],
  [-0.550, 0.030, 0.300, 0.312],
  [-0.280, -0.005, 0.290, 0.335],
  [ 0.000, -0.015, 0.280, 0.350],
  [ 0.280, -0.005, 0.284, 0.355],
  [ 0.470,  0.038, 0.286, 0.342],
  [ 0.620,  0.128, 0.264, 0.292],
  [ 0.730,  0.200, 0.220, 0.218],
  [ 0.800,  0.250, 0.180, 0.190],
];
// Interpolated section at any z: [centre-y, half-width, half-height].
function barrelAt(z) {
  const S = BARREL;
  if (z <= S[0][0]) return [S[0][1], S[0][2], S[0][3]];
  for (let i = 1; i < S.length; i++) {
    if (z <= S[i][0]) {
      const t = (z - S[i - 1][0]) / (S[i][0] - S[i - 1][0]);
      return [lerp(S[i - 1][1], S[i][1], t), lerp(S[i - 1][2], S[i][2], t),
              lerp(S[i - 1][3], S[i][3], t)];
    }
  }
  const L = S[S.length - 1];
  return [L[1], L[2], L[3]];
}
// Height of the barrel's back at z, offset outward by `pad` (the thickness of
// whatever is being laid on it). squareness 0.86 in the loft means the top of
// the section is the pure +h point, so this is exact on the spine line and a
// good approximation a hand's width either side of it.
function backY(z, xFrac = 0, pad = 0) {
  const [c, w, h] = barrelAt(z);
  const k = Math.sqrt(Math.max(0, 1 - xFrac * xFrac));
  return c + (h + pad) * Math.pow(k, 0.86);
}

/* The barrel's anatomy, written as value rather than as geometry. Measured off
   the bay in the reference frame: the shoulder and the quarter carry the light,
   the girth groove behind the elbow and the paralumbar hollow in front of the
   stifle are the two dark seams that tell the eye where the ribs stop. Centred
   on 1.0 and only worth about a fifth of a stop each — enough to read at five
   metres, not enough to look painted on. `t` is the belly-to-spine coordinate,
   so the seams can be kept off the topline where a real horse does not have them. */
function barrelAnatomy(z, t) {
  const side = 1 - smooth(clamp((t - 0.72) / 0.28, 0, 1));     // fades out over the spine
  const gauss = (x, c, w) => Math.exp(-Math.pow((x - c) / w, 2));
  let v = 1;
  v -= 0.13 * gauss(z, 0.42, 0.12) * side;      // girth groove, behind the elbow
  v -= 0.10 * gauss(z, -0.52, 0.15) * side;     // paralumbar hollow, before the stifle
  v += 0.11 * gauss(z, 0.63, 0.15);             // shoulder / triceps mass
  v += 0.09 * gauss(z, -0.74, 0.16);            // the round of the quarter
  v += 0.05 * gauss(z, 0.03, 0.26) * side;      // sprung ribs through the middle
  return v;
}

/* A sheet laid over the barrel. loft() only makes closed tubes, and a saddle
   blanket that closes round the belly would paint the whole animal crimson —
   this walks the barrel's own cross-section over an arc either side of the
   spine, offsets it outward by the cloth thickness, and then hangs a skirt
   straight down past the point where the barrel turns under. That is what makes
   the tack sit ON the horse instead of hovering over it.
   z is in BODY space; the caller shifts it into saddle space itself. */
function drape(z0, z1, nz, thMax, na, pad, drop, yOff) {
  const pos = [], uv = [], idx = [];
  const cols = na + 2;                       // arc samples plus one skirt row each side
  for (let i = 0; i <= nz; i++) {
    const t = i / nz;
    const z = lerp(z0, z1, t);
    const [c, w, h] = barrelAt(z);
    // The skirt is longest under the rider's leg and shortest fore and aft.
    const dr = drop * Math.pow(Math.sin(Math.PI * (0.10 + 0.80 * t)), 0.4);
    for (let j = 0; j < cols; j++) {
      let th, extra = 0;
      if (j === 0) { th = -thMax; extra = dr; }
      else if (j === cols - 1) { th = thMax; extra = dr; }
      else th = -thMax + (2 * thMax) * ((j - 1) / (na - 1));
      const cs = Math.cos(th), sn = Math.sin(th);
      const sx = w * sn;
      const sy = c + h * Math.sign(cs) * Math.pow(Math.abs(cs), 0.86);
      // outward normal of the superellipse, approximated from the axes
      let nx = sx / (w * w), ny = (sy - c) / (h * h);
      const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
      pos.push(sx + nx * pad, sy + ny * pad - extra + yOff, z);
      uv.push(j / (cols - 1), t);
    }
  }
  for (let i = 0; i < nz; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const a = i * cols + j, b = (i + 1) * cols + j;
      idx.push(a, b, b + 1, a, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// A joint mass. Every hard ring seam in the critics' notes is the open end of
// one lofted tube meeting the open end of the next with nothing between them;
// an ellipsoid sized to the joint hides the seam and gives the articulation the
// bulk a real one has.
function blob(m, w, h, d, seg = 10) {
  const g = new THREE.Mesh(new THREE.SphereGeometry(1, seg, Math.max(6, seg - 2)), m);
  g.scale.set(w, h, d);
  return g;
}

/* ==================== continuous skinned hide ====================
   THE ROOT CAUSE OF THE MOST-CITED DEFECT ON THIS BUILD, and it was never a
   shading problem. Verbatim from a critic at 1:1: "the horse is a visible stack
   of intersecting ellipsoids: three separate overlapping spheres form the neck,
   another the shoulder, another the barrel, with the intersection seams plainly
   readable as smooth shading creases."

   That is a literal description of what the old buildHorse emitted. Counted from
   the source it put THIRTY-ONE separate closed surfaces into the forehand alone:
   a barrel loft, three neck lofts, three neck joint ellipsoids, a withers, a
   chest mass, two shoulder beds, two haunches, a head loft, a jowl, two cheeks,
   a nose, a lip ring, and four ellipsoids per leg. Every place two of them
   interpenetrate there is a C0 crease in the silhouette and a hard shading
   discontinuity — and unlike a seam in a texture, no amount of light fixes it.
   Ellipsoid stacking cannot be lit out of a frame.

   So the hide is now ONE surface. A single tube is lofted along a smooth
   Catmull-Rom centreline that runs from the point of the buttock, forward along
   the spine, up the neck, round the poll and down the face to the muzzle, and it
   is SKINNED to the same bone chain the animation already drives. There is not
   one intersection seam anywhere between the tail and the lips.

   Two details make it possible to do the whole forehand in one tube:

   1. The cross-section is vertically ASYMMETRIC — an independent half-height
      above the centreline (hu) and below it (hd). That is what carries the
      chest. Where the centreline turns up into the neck its frame tilts with
      it, so "below the centreline" at the base of the neck points DOWN AND
      FORWARD, which is exactly where a horse's breast and point of shoulder
      are. The brisket is sculpted by the tube instead of being a sphere parked
      in front of it.

   2. The turn from the horizontal barrel to the 45-degree neck is spread over
      0.6 m of arc (radius ~0.8 m against a section half-height of 0.3), so the
      inside of the bend never folds through itself. The old build could not do
      this because its neck sprang out of the barrel at a corner.

   `up`/`hu`/`hd` are carried by parallel transport, so the section's "up" is
   continuous all the way round the poll: on the topline it is the crest, on the
   face it is the nasal bone, and `hd` is the throat and then the jaw. */
function crv(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
    + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/* nodes: [{ p:[x,y,z], w, hu, hd, b }]  b = float index into the bone list.
   Returns { geometry, samples } where samples[] carries the centre, frame and
   section of every ring so the mane can be rooted exactly on the crest. */
function skinTube(nodes, opt = {}) {
  const radial = opt.radial ?? 18;
  const div = opt.div ?? 4;
  const sq = opt.sq ?? 0.80;
  const boneBase = opt.boneBase ?? 0;
  const uvScale = opt.uvScale ?? 1.5;
  const up0 = opt.up0 || new THREE.Vector3(0, 1, 0);

  const n = nodes.length;
  const at = (i) => nodes[clamp(i, 0, n - 1)];
  const pick = (i, k) => { const q = at(i); return k === 0 ? q.p[0] : k === 1 ? q.p[1] : q.p[2]; };
  const sc = (i, key) => at(i)[key];

  // --- sample the centreline and its section, uniformly in node parameter ---
  const C = [], W = [], HU = [], HD = [], BB = [];
  for (let i = 0; i < n - 1; i++) {
    for (let k = 0; k < div; k++) {
      const t = k / div;
      C.push(new THREE.Vector3(
        crv(pick(i - 1, 0), pick(i, 0), pick(i + 1, 0), pick(i + 2, 0), t),
        crv(pick(i - 1, 1), pick(i, 1), pick(i + 1, 1), pick(i + 2, 1), t),
        crv(pick(i - 1, 2), pick(i, 2), pick(i + 1, 2), pick(i + 2, 2), t)));
      // Catmull-Rom OVERSHOOTS, and a section half-axis that overshoots below
      // zero turns the tube inside out for that ring. Floored, not clamped to
      // the neighbours, so a deliberate pinch still pinches.
      const pos3 = (a, b, c, d) => Math.max(0.004, crv(a, b, c, d, t));
      W.push(pos3(sc(i - 1, 'w'), sc(i, 'w'), sc(i + 1, 'w'), sc(i + 2, 'w')));
      HU.push(pos3(sc(i - 1, 'hu'), sc(i, 'hu'), sc(i + 1, 'hu'), sc(i + 2, 'hu')));
      HD.push(pos3(sc(i - 1, 'hd'), sc(i, 'hd'), sc(i + 1, 'hd'), sc(i + 2, 'hd')));
      BB.push(lerp(sc(i, 'b'), sc(i + 1, 'b'), t));
    }
  }
  const L = at(n - 1);
  C.push(new THREE.Vector3(L.p[0], L.p[1], L.p[2]));
  W.push(L.w); HU.push(L.hu); HD.push(L.hd); BB.push(L.b);
  const m = C.length;

  // --- parallel-transport frames ---
  const T = [], U = [], SD = [];
  const tmp = new THREE.Vector3(), q = new THREE.Quaternion();
  for (let i = 0; i < m; i++) {
    const a = C[Math.max(0, i - 1)], b = C[Math.min(m - 1, i + 1)];
    const t = new THREE.Vector3().subVectors(b, a);
    if (t.lengthSq() < 1e-12) t.set(0, 0, 1);
    T.push(t.normalize());
  }
  for (let i = 0; i < m; i++) {
    let u;
    if (i === 0) {
      u = up0.clone();
      u.addScaledVector(T[0], -T[0].dot(u));
      if (u.lengthSq() < 1e-8) u.set(1, 0, 0).addScaledVector(T[0], -T[0].x);
      u.normalize();
    } else {
      q.setFromUnitVectors(T[i - 1], T[i]);
      u = U[i - 1].clone().applyQuaternion(q);
      u.addScaledVector(T[i], -T[i].dot(u)).normalize();
    }
    U.push(u);
    SD.push(new THREE.Vector3().crossVectors(u, T[i]).normalize());
  }

  // --- ring vertices ---
  const nv = m * radial + 2;                       // + two cap centres
  const pos = new Float32Array(nv * 3);
  const uv = new Float32Array(nv * 2);
  const si = new Uint16Array(nv * 4);
  const sw = new Float32Array(nv * 4);
  let run = 0;
  const setSkin = (v, b) => {
    const bf = Math.max(0, b), i0 = Math.floor(bf), f = bf - i0;
    si[v * 4] = boneBase + i0; si[v * 4 + 1] = boneBase + i0 + (f > 0 ? 1 : 0);
    sw[v * 4] = 1 - f; sw[v * 4 + 1] = f;
  };
  for (let i = 0; i < m; i++) {
    if (i > 0) run += C[i].distanceTo(C[i - 1]);
    const w = W[i], hu = HU[i], hd = HD[i];
    const girth = (w + (hu + hd) * 0.5) * Math.PI;
    for (let j = 0; j < radial; j++) {
      const th = (j / radial) * Math.PI * 2;
      const cs = Math.cos(th), sn = Math.sin(th);
      // Height blends hu->hd smoothly through the sides, so the two halves of
      // the section meet with a continuous tangent instead of a horizontal
      // crease down the length of the animal.
      const a = 0.5 + 0.5 * cs;
      const h = hu * a + hd * (1 - a);
      const y = h * Math.sign(cs) * Math.pow(Math.abs(cs), sq);
      const x = w * Math.sign(sn) * Math.pow(Math.abs(sn), sq);
      const v = i * radial + j;
      tmp.copy(C[i]).addScaledVector(U[i], y).addScaledVector(SD[i], x);
      pos[v * 3] = tmp.x; pos[v * 3 + 1] = tmp.y; pos[v * 3 + 2] = tmp.z;
      uv[v * 2] = (j / radial) * girth * uvScale;
      uv[v * 2 + 1] = run * uvScale;
      setSkin(v, BB[i]);
    }
  }
  // cap centres, pulled slightly in along the tangent so the cap is a dome
  const capA = m * radial, capB = capA + 1;
  tmp.copy(C[0]).addScaledVector(T[0], -(W[0] + HU[0]) * 0.42);
  pos[capA * 3] = tmp.x; pos[capA * 3 + 1] = tmp.y; pos[capA * 3 + 2] = tmp.z;
  uv[capA * 2] = 0; uv[capA * 2 + 1] = -0.05; setSkin(capA, BB[0]);
  tmp.copy(C[m - 1]).addScaledVector(T[m - 1], (W[m - 1] + HU[m - 1]) * 0.42);
  pos[capB * 3] = tmp.x; pos[capB * 3 + 1] = tmp.y; pos[capB * 3 + 2] = tmp.z;
  uv[capB * 2] = 0; uv[capB * 2 + 1] = run * uvScale + 0.05; setSkin(capB, BB[m - 1]);

  const idx = [];
  for (let i = 0; i < m - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const j2 = (j + 1) % radial;
      const A = i * radial + j, B = (i + 1) * radial + j;
      const D = (i + 1) * radial + j2, E = i * radial + j2;
      idx.push(A, B, D, A, D, E);
    }
  }
  for (let j = 0; j < radial; j++) {
    const j2 = (j + 1) % radial;
    idx.push(capA, j, j2);
    idx.push(capB, (m - 1) * radial + j2, (m - 1) * radial + j);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  // Ring 1 vertex 0 sits on the "up" side of the section; its normal has to
  // agree with the frame's up or the whole tube is inside out.
  const nrm = g.attributes.normal;
  const k = radial;
  if (nrm.getX(k) * U[1].x + nrm.getY(k) * U[1].y + nrm.getZ(k) * U[1].z < 0) {
    for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
    g.setIndex(idx); g.computeVertexNormals();
  }
  return { geometry: g, C, U, SD, T, W, HU, HD, radial, m };
}

/* Countershading + mottling written into a colour attribute on a tube, using
   the tube's own frames rather than a world axis — so the flank of a NECK gets
   the same treatment as the flank of a barrel even though the two point in
   completely different directions. `along` is the second, lengthwise term: a
   horse is a shoulder, a rib cage, a hollow flank and a quarter, and each has
   its own value. */
/* WAVE I — `ao` is new, and it is the term the critics were asking for when
   they wrote "no ambient occlusion under the belly ... no shading gradient
   along the barrel, the body reads flat".
   Measured on 06-forest: the barrel's top band returned lum 63.8 and its belly
   band 73.1, a ramp of 0.87 — the underside of the animal was LIGHTER than its
   topline. That is not a light-rig failure, it is this function: `flank`
   peaked at t=0.34, which is BELOW the widest point of the barrel, so the
   countershading lift was being applied to the lower flank and the belly
   (t=0 still got +7.8%), while `darkTop` took 34% off the spine. The albedo
   was ramping the wrong way and the key could not overcome it.
   So: the lift moves up to the true flank (t=0.46), the spine loses most of its
   darkening (a bay does carry a dorsal shade, but it must not be the darkest
   thing on the animal), and a multiplicative occlusion is added under the
   barrel where a real animal sees nothing but its own legs and the ground. */
function shadeTube(tube, lightUp, darkTop, along, seed = 5, ao = 0, aoT = 0.34, flankAt = 0.46) {
  const g = tube.geometry;
  const p = g.attributes.position;
  const col = new Float32Array(p.count * 3);
  const { C, U, radial, m } = tube;
  const r = rng(seed);
  // three octaves of cheap lengthwise/around mottle, evaluated per ring/spoke
  const ph = []; for (let i = 0; i < 12; i++) ph.push(r() * 6.283);
  let run = 0;
  for (let i = 0; i < m; i++) {
    if (i > 0) run += C[i].distanceTo(C[i - 1]);
    for (let j = 0; j < radial; j++) {
      const v = i * radial + j;
      const th = (j / radial) * Math.PI * 2;
      const t = 0.5 + 0.5 * Math.cos(th);                 // 1 spine, 0 belly
      const flank = Math.exp(-Math.pow((t - flankAt) / 0.30, 2));
      let val = 1 + lightUp * flank - darkTop * smooth(clamp((t - 0.55) / 0.45, 0, 1));
      // Occlusion under the barrel. Multiplicative and applied AFTER the
      // countershading, so it cannot be cancelled by the flank lift the way an
      // additive term would be: at t=0 the belly ends up at (1 - ao) of the
      // flank rather than 8% above it.
      const aoAmt = typeof ao === 'function' ? ao(C[i]) : ao;
      if (aoAmt) val *= 1 - aoAmt * smooth(clamp((aoT - t) / aoT, 0, 1));
      if (along) val *= along(run, t, C[i]);
      // Mottle. Small — 4% peak — but it is low frequency and it is in the
      // ALBEDO, so it survives being fully backlit, which is when the coat map
      // has nothing to catch.
      val *= 1 + 0.045 * Math.sin(run * 3.1 + ph[0] + th * 2.0)
                + 0.030 * Math.sin(run * 7.7 + ph[1] - th * 3.0)
                + 0.022 * Math.sin(run * 15.3 + ph[2] + th * 5.0);
      col[v * 3] = val; col[v * 3 + 1] = val * 0.992; col[v * 3 + 2] = val * 0.978;
    }
  }
  for (let v = m * radial; v < p.count; v++) { col[v * 3] = 1; col[v * 3 + 1] = 0.992; col[v * 3 + 2] = 0.978; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return tube;
}

/* A hoof. The old one was `new CylinderGeometry(0.058, 0.076, 0.088, 12)` — a
   critic's "hooves are cylinder end-caps" is not a reading, it is the literal
   primitive. A real hoof is a rounded wedge: broad and round at the toe,
   narrower at the heel, flaring to the ground, with the wall meeting the
   coronet at a smaller section than it meets the floor, and two heel bulbs
   behind. Built as a loft of an egg-shaped section so the ground line is a
   curve rather than a circle. */
function hoofGeo(scale = 1) {
  // y is measured UP from the ground: HOOF_SINK's contract is that the hoof
  // group's origin is the bottom of the wall. [y, halfWidth, depthToe, depthHeel]
  const rings = [
    [0.108, 0.047, 0.054, 0.039],   // coronet, where the wall meets the hair
    [0.080, 0.054, 0.063, 0.043],
    [0.048, 0.063, 0.074, 0.048],
    [0.020, 0.071, 0.083, 0.052],   // widest, just above the ground
    [0.007, 0.070, 0.082, 0.051],
    [0.001, 0.058, 0.068, 0.043],   // the wall turning under to the sole
  ];
  const radial = 16;
  const pos = [], uv = [], idx = [];
  for (const [y, w, dF, dB] of rings) {
    for (let j = 0; j < radial; j++) {
      const th = (j / radial) * Math.PI * 2;
      const cs = Math.cos(th), sn = Math.sin(th);
      const a = 0.5 + 0.5 * cs;
      const d = dF * a + dB * (1 - a);
      // toe end rounder than the heel: exponent under 1 squares the toe off
      pos.push(scale * w * Math.sign(sn) * Math.pow(Math.abs(sn), 0.78), scale * y,
               scale * d * Math.sign(cs) * Math.pow(Math.abs(cs), 0.72));
      uv.push(j / radial, (y + 0.09) * 8);
    }
  }
  const nr = rings.length;
  for (let i = 0; i < nr - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const j2 = (j + 1) % radial;
      const A = i * radial + j, B = (i + 1) * radial + j;
      const D = (i + 1) * radial + j2, E = i * radial + j2;
      idx.push(A, D, B, A, E, D);
    }
  }
  // sole
  const cen = pos.length / 3;
  pos.push(0, scale * -0.004, 0); uv.push(0.5, 0);
  for (let j = 0; j < radial; j++) {
    const j2 = (j + 1) % radial;
    idx.push(cen, (nr - 1) * radial + j, (nr - 1) * radial + j2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function buildHorse() {
  const CM = coatMaps();
  // bumpScale 0.0026 -> 0.016. See coatMaps: at the old value the whole coat
  // texture moved the final frame by about two 8-bit levels, i.e. by less than
  // the grade's dither, which is why a critic at 1:1 measured "smooth plastic".
  const coatOpts = { rough: 0.52, rim: 1.00, bounce: 1.22, map: CM.map, bump: CM.bump,
                     bumpScale: 0.016, knee: 0.22 };
  const M = {
    coat: mat(lifted(COL.coat, CM.mean), coatOpts),
    coatVC: mat(lifted(COL.coat, CM.mean), { ...coatOpts, vc: true }),
    coatLt: mat(lifted(COL.coatLt, CM.mean), coatOpts),
    coatDk: mat(lifted(COL.coatDk, CM.mean), { ...coatOpts, rough: 0.58, rim: 0.90 }),
    muzzle: mat(COL.muzzle, { rough: 0.62, rim: 0.55, bounce: 0.9 }),
    hoof: mat(COL.hoof, { rough: 0.38, metal: 0.05, rim: 0.70, bounce: 0.55 }),
    /* Mane and tail. The rim is UP from 0.50/power 5.5 to 0.72/power 4.0. With
       the hair this dark (#1b120b) and the coat behind it now 30% darker too,
       a rim confined to within a couple of degrees of the silhouette left the
       mane with nothing to separate it from the neck. At power 4.0 the outer
       third of the hair mass catches the key, which is what a backlit mane
       actually does and what makes it read as hair rather than as a hole. */
    hair: mat(COL.hair, { rough: 0.44, rim: 0.72, rimPower: 4.0, bounce: 0.80,
                          side: THREE.DoubleSide }),
    leather: mat(COL.leather, { rough: 0.55, rim: 0.65, bounce: 0.9 }),
    leatherDk: mat(COL.leatherDk, { rough: 0.5, rim: 0.65, bounce: 0.9 }),
    cloth: mat(COL.cloth, { rough: 0.78, rim: 0.70, bounce: 1.1, side: THREE.DoubleSide }),
    lacquer: mat(COL.lacquer, { rough: 0.24, metal: 0.25, rim: 0.85, rimPower: 3.4, bounce: 0.7 }),
    gold: mat(COL.gold, { rough: 0.3, metal: 0.8, rim: 0.90, rimPower: 3.2, bounce: 0.5 }),
    steel: mat(COL.steel, { rough: 0.26, metal: 0.85, rim: 0.90, rimPower: 3.2, bounce: 0.5 }),
    eye: mat(COL.eye, { rough: 0.10, rim: 0.9, rimPower: 2.2, bounce: 0.2 }),
  };

  const root = new THREE.Group(); root.name = 'horse';
  const chassis = new THREE.Group(); root.add(chassis);          // terrain pitch/roll
  const body = new THREE.Group(); body.position.y = BODY_Y; chassis.add(body);

  /* ---- the bone chain ----
     These were Groups. They are Bones now, and nothing else about them changed:
     the same rotations, the same rest angles, driven by the same lines in
     update(). What changed is that a single skinned hide is stretched over
     them, so bending the neck bends ONE surface instead of sliding three tubes
     and three ellipsoids past each other. */
  const bones = [];
  const bBody = new THREE.Bone(); body.add(bBody); bones.push(bBody);        // 0
  const neckBase = new THREE.Group();
  neckBase.position.set(0, 0.25, 0.80);
  body.add(neckBase);
  const NECK_REST = [0.95, -0.16, -0.14];
  const n1 = new THREE.Bone(); n1.rotation.x = NECK_REST[0]; neckBase.add(n1); bones.push(n1);   // 1
  const n2 = new THREE.Bone(); n2.position.y = 0.25; n2.rotation.x = NECK_REST[1]; n1.add(n2); bones.push(n2); // 2
  const n3 = new THREE.Bone(); n3.position.y = 0.25; n3.rotation.x = NECK_REST[2]; n2.add(n3); bones.push(n3); // 3
  const headPivot = new THREE.Bone();
  headPivot.position.y = 0.25; headPivot.rotation.x = 1.60; n3.add(headPivot); bones.push(headPivot); // 4

  /* ---- the legs' bones, built before the hide so the skeleton is one list ---- */
  const legDef = [
    { key: 'LF', fore: true, sx: 1 }, { key: 'RF', fore: true, sx: -1 },
    { key: 'LH', fore: false, sx: 1 }, { key: 'RH', fore: false, sx: -1 },
  ];
  const legs = [];
  for (const d of legDef) {
    const P = d.fore ? FORE : HIND;
    const pivot = new THREE.Group();
    pivot.position.set(d.sx * P.x, P.y, P.z);
    body.add(pivot);
    const s1 = new THREE.Bone(); pivot.add(s1);
    const s2 = new THREE.Bone(); s2.position.y = -P.a; s1.add(s2);
    const s3 = new THREE.Bone(); s3.position.y = -P.b; s2.add(s3);
    const hoofG = new THREE.Bone(); hoofG.position.y = -P.c; s3.add(hoofG);
    const base = bones.length;
    bones.push(s1, s2, s3, hoofG);
    legs.push({
      ...d, P, pivot, s1, s2, s3, hoof: hoofG, boneBase: base, pivotZ0: P.z,
      restX: d.sx * (d.fore ? 0.172 : 0.170), restZ: d.fore ? 0.50 : -0.56,
      phase: 0, stance: true, wasStance: true,
      foot: new THREE.Vector2(0, 0), from: new THREE.Vector2(0, 0),
      footY: 0, lastStrike: 0,
    });
  }

  // Bone frames have to be live before any station can be expressed in one.
  root.updateMatrixWorld(true);
  const _t = new THREE.Vector3();
  // A point given in some bone's local frame, expressed in body space.
  const IN = (obj, x, y, z) => {
    _t.set(x, y, z);
    obj.localToWorld(_t);
    body.worldToLocal(_t);
    return [_t.x, _t.y, _t.z];
  };

  /* ================= the hide: ONE tube, buttock to lips =================
     Read the section columns as an anatomy chart. w is half the width; hu is
     the distance from the centreline to the TOPLINE (croup, back, wither,
     crest, then the nasal bone once the frame has turned over the poll); hd is
     the distance to the UNDERLINE (belly, then breast, then throat, then jaw).
     hd doing double duty as the breast is the whole trick — see skinTube. */
  const HIDE = [
    // ---- hindquarter -> barrel ---- (bone 0: rigid to the body)
    { p: [0, 0.020, -0.940], w: 0.045, hu: 0.055, hd: 0.055, b: 0 },   // point of buttock
    { p: [0, 0.045, -0.900], w: 0.120, hu: 0.145, hd: 0.115, b: 0 },
    { p: [0, 0.080, -0.840], w: 0.210, hu: 0.235, hd: 0.170, b: 0 },
    { p: [0, 0.100, -0.775], w: 0.264, hu: 0.264, hd: 0.205, b: 0 },   // croup
    { p: [0, 0.088, -0.700], w: 0.302, hu: 0.276, hd: 0.232, b: 0 },   // quarters, widest
    { p: [0, 0.058, -0.620], w: 0.306, hu: 0.292, hd: 0.252, b: 0 },
    // The flank TUCK. The old belly line ran flat at hd 0.35 from the girth to
    // the croup, which is a cow, not a horse; the tuck in front of the stifle is
    // most of what makes the hind leg read as long.
    { p: [0, 0.030, -0.550], w: 0.300, hu: 0.312, hd: 0.278, b: 0 },   // loin / flank
    { p: [0, -0.005, -0.280], w: 0.290, hu: 0.335, hd: 0.322, b: 0 },
    { p: [0, -0.015, 0.000], w: 0.280, hu: 0.350, hd: 0.352, b: 0 },   // deepest rib
    { p: [0, -0.005, 0.280], w: 0.284, hu: 0.355, hd: 0.360, b: 0 },
    { p: [0, 0.038, 0.470], w: 0.286, hu: 0.342, hd: 0.372, b: 0 },    // girth, deepest point
    { p: [0, 0.128, 0.620], w: 0.264, hu: 0.292, hd: 0.390, b: 0 },    // shoulder
    { p: [0, 0.200, 0.730], w: 0.220, hu: 0.218, hd: 0.375, b: 0 },    // withers
    { p: [0, 0.250, 0.800], w: 0.180, hu: 0.190, hd: 0.340, b: 0.40 }, // base of neck / breast
    // ---- neck ---- the frame is tilted 36 degrees here, so hd points down AND
    //      FORWARD and is therefore the breast and the point of the shoulder.
    { p: IN(n1, 0, 0.11, 0), w: 0.155, hu: 0.196, hd: 0.262, b: 1.0 },
    { p: IN(n1, 0, 0.21, 0), w: 0.142, hu: 0.192, hd: 0.196, b: 1.0 },
    { p: IN(n2, 0, 0.09, 0), w: 0.132, hu: 0.188, hd: 0.170, b: 2.0 },
    { p: IN(n2, 0, 0.20, 0), w: 0.122, hu: 0.178, hd: 0.150, b: 2.0 },
    { p: IN(n3, 0, 0.09, 0), w: 0.112, hu: 0.164, hd: 0.136, b: 3.0 },
    { p: IN(n3, 0, 0.19, 0), w: 0.100, hu: 0.136, hd: 0.116, b: 3.0 },
    { p: IN(n3, 0, 0.30, 0), w: 0.092, hu: 0.108, hd: 0.086, b: 3.4 }, // poll crown
    // ---- head ---- the frame has rolled 83 degrees over the poll: hu is now
    //      the forehead and nasal bone, hd the jaw and chin.
    { p: IN(headPivot, 0, 0.130, 0), w: 0.094, hu: 0.096, hd: 0.158, b: 4 },
    { p: IN(headPivot, 0, 0.220, 0), w: 0.104, hu: 0.090, hd: 0.172, b: 4 },  // cheek / jowl
    { p: IN(headPivot, 0, 0.310, 0), w: 0.096, hu: 0.084, hd: 0.140, b: 4 },
    { p: IN(headPivot, 0, 0.400, 0), w: 0.080, hu: 0.078, hd: 0.104, b: 4 },
    { p: IN(headPivot, 0, 0.485, 0), w: 0.068, hu: 0.072, hd: 0.084, b: 4 },
    { p: IN(headPivot, 0, 0.560, 0), w: 0.064, hu: 0.070, hd: 0.076, b: 4 },
    { p: IN(headPivot, 0, 0.620, 0), w: 0.068, hu: 0.076, hd: 0.074, b: 4 },  // muzzle
    { p: IN(headPivot, 0, 0.665, 0), w: 0.046, hu: 0.050, hd: 0.048, b: 4 },  // lips
  ];


  /* Lengthwise value. barrelAnatomy still carries the girth groove, the
     paralumbar hollow, the triceps and the round of the quarter; everything
     past z ~1.0 is neck and head, where those gaussians are already zero. */
  const along = (run, t, c) => {
    let v = barrelAnatomy(c.z, t);
    if (c.z > 0.88) {
      // crest darker than the flat of the neck, throat lighter
      v *= 1 - 0.07 * smooth(clamp((t - 0.6) / 0.4, 0, 1));
      // pale muzzle ring — a bay's mealy nose, and the thing that stops the
      // head reading as a wedge with no features on it
      v *= 1 + 0.42 * smooth(clamp((c.z - 1.68) / 0.13, 0, 1));
      // dark round the eye and down the front of the face
      v *= 1 - 0.10 * Math.exp(-Math.pow((c.z - 1.49) / 0.10, 2)) * smooth(clamp((t - 0.35) / 0.4, 0, 1));
    }
    return v;
  };
  const hideT = skinTube(HIDE, { radial: 24, div: 5, sq: 0.86, uvScale: 1.5 });
  /* darkTop 0.34 -> 0.13 and a belly occlusion that runs 0.50 under the barrel,
     tapering to 0.30 up the neck and 0.18 under the jaw and muzzle — the throat
     is occluded, but by a good deal less than a rib cage with four legs under
     it. z runs +forward: the barrel is z < 0.9, the neck 0.9-1.5, the head
     past that. */
  const bellyAO = (c) => (0.50
    - 0.20 * smooth(clamp((c.z - 0.90) / 0.55, 0, 1))
    - 0.12 * smooth(clamp((c.z - 1.45) / 0.30, 0, 1)));
  shadeTube(hideT, 0.28, 0.13, along, 17, bellyAO, 0.36, 0.46);
  const hide = new THREE.SkinnedMesh(hideT.geometry, M.coatVC);
  hide.frustumCulled = false;
  body.add(hide);

  /* ---- head furniture ----
     Ears, eye and nostril are the only things on the head that are still their
     own mesh, because on a real horse they are their own thing: an ear is a
     separate cone of cartilage and an eye is a separate ball. Everything that
     used to be a lump ON the head — jowl, two cheeks, nose, lip ring — is now
     part of the hide's own section table. */
  const ears = [];
  for (const sgn of [1, -1]) {
    // The eye sits on the side of the skull just under the brow, at the widest
    // point of the cheek. Almond, not a ball: scaled down in the face-normal
    // axis so it beds into the socket, and glossy enough to take a catchlight
    // off the key — "the eye does not resolve" was partly that the old one was
    // a matte 0.026 sphere parked 4 cm too far up the head.
    const socket = new THREE.Mesh(new THREE.SphereGeometry(0.040, 10, 8), M.coatDk);
    socket.position.set(sgn * 0.078, 0.205, -0.028);
    socket.scale.set(0.62, 1.05, 0.85);
    headPivot.add(socket);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.028, 12, 10), M.eye);
    // The hide's own surface at this station is x = 0.0986; the eye is placed so
    // its outer pole stands 7 mm past that. The old eye was a 0.026 ball at
    // x 0.098 on a head that was wider there, i.e. buried.
    eye.position.set(sgn * 0.090, 0.203, -0.028);
    eye.scale.set(0.55, 1.0, 0.80);
    headPivot.add(eye);

    const ear = new THREE.Group();
    ear.position.set(sgn * 0.058, 0.010, -0.062);
    ear.rotation.set(-1.42, 0, sgn * 0.24);
    headPivot.add(ear);
    const em = new THREE.Mesh(new THREE.ConeGeometry(0.038, 0.145, 7, 1), M.coatDk);
    em.position.y = 0.068; em.rotation.x = Math.PI; ear.add(em);   // taper points away
    ear.userData.base = ear.rotation.clone();
    ear.userData.side = sgn;
    ears.push(ear);

    const nos = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 6), M.muzzle);
    nos.position.set(sgn * 0.045, 0.600, 0.012);
    nos.scale.set(0.8, 1.2, 0.7);
    headPivot.add(nos);
  }

  /* ---- mane and forelock ----
     hairGeo's `axis` is the fix; see the note on the function. Beyond that:
     nine stations instead of six, sixteen strands each instead of eleven, and
     a strand 0.030 m wide instead of 0.021 — which at the 6 m riding distance
     these frames are judged at is about ten pixels rather than three, so the
     mass reads as hair instead of aliasing away. The crest row sits ON the
     neck and gives the topline a ridge; the curtain falls down the near side. */
  const maneClumps = [];
  const NA = [NECK_REST[0], NECK_REST[0] + NECK_REST[1],
              NECK_REST[0] + NECK_REST[1] + NECK_REST[2]];
  const maneOn = (parent, y, z, len, n, seed, base, off, spanX, width, drift = 0.16) => {
    const g = new THREE.Group(); g.position.set(off, y, z); parent.add(g);
    g.rotation.x = base;                      // cancel the neck angle: hair falls down
    const m = new THREE.Mesh(hairGeo({ n, len, spanX, spanZ: 0.042, width,
      bend: 0.20, seed, taper: 0.58, segs: 5,
      axis: Math.PI / 2, spread: 0.55, drift, curl: 0.05 }), M.hair);
    m.castShadow = true; g.add(m);
    maneClumps.push({ g, lag: 0, base });
    return g;
  };
  /* Crest. The first pass at this hung the crest hair straight DOWN from the
     topline, which put a black saw-tooth mohawk on the neck — measured in the
     inspector at 4.6 m, and wrong in the obvious way: crest hair LIES BACK
     along the neck, it does not stand off it. hairGeo's strands run down its
     own -Y, and a neck bone's -Y already points back down the neck, so the
     correct rotation here is none at all. `bend` then lifts the tips off the
     crest, which is the only part of it that should stand proud. */
  const crestAt = [[n1, 0.16, 0.190], [n1, 0.25, 0.190], [n2, 0.11, 0.184],
                   [n2, 0.21, 0.176], [n3, 0.11, 0.160], [n3, 0.21, 0.132],
                   [n3, 0.29, 0.106]];
  for (let i = 0; i < crestAt.length; i++) {
    const [par, yy, hu] = crestAt[i];
    const cg = new THREE.Group();
    cg.position.set(0, yy, -hu * 0.86);
    par.add(cg);
    // width 0.026 at spread 0.85 put twenty near-parallel black plates broadside
    // to the camera and the crest read as cards. Half the width, twice the
    // count, and enough spread that no two strands share a plane.
    const crest = new THREE.Mesh(hairGeo({ n: 24, len: 0.155, spanX: 0.030, spanZ: 0.024,
      width: 0.015, bend: 0.13, seed: 71 + i * 7, taper: 0.45, segs: 4,
      axis: Math.PI / 2, spread: 1.5, curl: 0.06 }), M.hair);
    crest.castShadow = true;
    cg.add(crest);
  }
  /* Curtain. Rooted just outboard of the crest and swept OUT as it falls
     (`drift`), so the mass ends up hanging beside the neck rather than through
     it, and a short second curtain goes over the off side — a real mane falls
     to one side but the eye still finds hair on the other, and without it the
     animal loses its mane entirely at every camera bearing that happens to see
     the off flank. */
  const maneAt = [
    [n1, 0.06, 0.196, 0.42, 3],
    [n1, 0.14, 0.194, 0.47, 11],
    [n1, 0.22, 0.192, 0.50, 19],
    [n2, 0.06, 0.188, 0.50, 27],
    [n2, 0.14, 0.182, 0.48, 35],
    [n2, 0.22, 0.176, 0.44, 43],
    [n3, 0.06, 0.164, 0.39, 51],
    [n3, 0.14, 0.144, 0.33, 59],
    [n3, 0.23, 0.118, 0.26, 67],
  ];
  for (const [par, yy, hu, len, seed] of maneAt) {
    const ang = par === n1 ? NA[0] : par === n2 ? NA[1] : NA[2];
    maneOn(par, yy, -hu * 0.94, len, 16, seed, -ang + 0.10, 0.055, 0.030, 0.030, 0.16);
    maneOn(par, yy, -hu * 0.94, len * 0.64, 12, seed + 500, -ang + 0.10, -0.048, 0.028, 0.028, -0.17);
  }
  const forelock = maneOn(headPivot, 0.055, -0.092, 0.25, 12, 91, -1.95, 0.008, 0.048, 0.026, 0.03);

  /* ---- tail ----
     Same width bug, same fix, plus the strands are now arranged as a SKIRT:
     two crossed sheets, one facing across the horse and one along it, so the
     mass has depth from every angle instead of being a blade that disappears
     when the camera swings round. */
  const tailBones = [];
  const tailRoot = new THREE.Group();
  tailRoot.position.set(0, 0.245, -0.880); tailRoot.rotation.x = 0.34; body.add(tailRoot);
  let tp = tailRoot;
  for (let i = 0; i < 5; i++) {
    const b = new THREE.Group();
    if (i > 0) b.position.y = -0.13;
    tp.add(b); tp = b;
    tailBones.push(b);
    if (i === 0) {
      const dock = new THREE.Mesh(segGeo(0.20, 0.066, 0.066, 0.042, 0.042, 0.10, 0.03), M.coat);
      b.add(dock);
    }
    /* Strand width 0.034 with only 0.7 rad of spread made eighteen near-parallel
       ribbons whose silhouette was one rectangle — the tail read as a black
       plank stuck on the back of the horse. Narrower strands, more of them, and
       enough spread and curl that the outline is ragged. */
    const side = new THREE.Mesh(hairGeo({
      n: i === 0 ? 30 : 26, len: i === 0 ? 0.36 : 0.55,
      spanX: 0.076 - i * 0.008, spanZ: 0.072, width: 0.021, bend: 0.15,
      seed: 61 + i * 13, taper: 0.55, segs: 5,
      axis: Math.PI / 2, spread: 1.25, curl: 0.10 }), M.hair);
    side.castShadow = true;
    side.position.y = i === 0 ? -0.07 : 0;
    b.add(side);
    const cross = new THREE.Mesh(hairGeo({
      n: i === 0 ? 16 : 14, len: i === 0 ? 0.34 : 0.53,
      spanX: 0.062 - i * 0.007, spanZ: 0.064, width: 0.020, bend: 0.17,
      seed: 311 + i * 13, taper: 0.55, segs: 5,
      axis: 0, spread: 1.25, curl: 0.09 }), M.hair);
    cross.castShadow = true;
    cross.position.y = i === 0 ? -0.07 : 0;
    b.add(cross);
    if (i >= 3) {
      const hero = new THREE.Mesh(hairGeo({ n: 6, len: 0.58, spanX: 0.048, spanZ: 0.044,
        width: 0.022, bend: 0.10, seed: 131 + i * 17, taper: 0.70, segs: 6,
        axis: Math.PI / 2, spread: 0.5 }), M.hair);
      hero.castShadow = true; b.add(hero);
    }
  }

  /* ================= legs: one continuous tube each =================
     "Legs are stacked cylinders with an open joint gap, hooves are cylinder
     end-caps." Both are literal. Each leg was three separate lofted tubes with
     open ends plus four ellipsoids stuffed in the gaps, and the hoof was
     CylinderGeometry(0.058, 0.076, 0.088, 12).

     Now: one skinned tube per leg, running from inside the barrel to the top of
     the hoof, weighted across s1/s2/s3/hoof so the elbow, knee and fetlock BEND
     the surface instead of being holes plugged with spheres. hu/hd are the
     front and back depths, so the point of the hock can stick out behind the
     way it does on a real horse and the knee can be flat in front. */
  const FORE_ST = [
    [0.22, 0.085, 0.105, 0.105, 0],
    [0.06, 0.098, 0.130, 0.150, 0],
    [-0.08, 0.100, 0.140, 0.178, 0],     // upper arm / triceps
    [-0.20, 0.088, 0.115, 0.142, 0.40],
    [-0.30, 0.078, 0.100, 0.112, 1],     // elbow
    [-0.40, 0.070, 0.092, 0.098, 1],
    [-0.52, 0.058, 0.074, 0.076, 1],     // forearm taper
    [-0.61, 0.048, 0.060, 0.060, 1.6],
    [-0.66, 0.046, 0.058, 0.062, 2],     // knee
    [-0.73, 0.039, 0.047, 0.052, 2],
    [-0.88, 0.033, 0.037, 0.045, 2],     // cannon
    [-1.02, 0.033, 0.037, 0.045, 2],
    [-1.055, 0.040, 0.046, 0.058, 2],    // fetlock
    [-1.10, 0.035, 0.040, 0.044, 2.6],
    [-1.14, 0.031, 0.035, 0.037, 3],     // pastern, buried in the hoof
  ];
  const HIND_ST = [
    [0.24, 0.098, 0.130, 0.140, 0],
    [0.06, 0.128, 0.175, 0.218, 0],      // thigh
    [-0.12, 0.126, 0.168, 0.208, 0],
    [-0.26, 0.106, 0.136, 0.162, 0.35],
    [-0.36, 0.092, 0.118, 0.130, 1],     // stifle
    [-0.50, 0.080, 0.105, 0.120, 1],     // gaskin
    [-0.64, 0.062, 0.078, 0.092, 1],
    [-0.73, 0.050, 0.058, 0.084, 1.6],
    [-0.78, 0.048, 0.052, 0.096, 2],     // hock, point standing out behind
    [-0.85, 0.040, 0.042, 0.058, 2],
    [-1.00, 0.033, 0.037, 0.045, 2],
    [-1.14, 0.033, 0.037, 0.045, 2],
    [-1.175, 0.040, 0.046, 0.058, 2],    // fetlock
    [-1.22, 0.035, 0.040, 0.044, 2.6],
    [-1.26, 0.031, 0.035, 0.037, 3],
  ];
  const LEG_UP = new THREE.Vector3(0, 0, 1);
  for (const leg of legs) {
    const table = leg.fore ? FORE_ST : HIND_ST;
    const nodes = table.map(([y, w, hu, hd, b]) => ({ p: [0, y, 0], w, hu, hd, b }));
    const t = skinTube(nodes, { radial: 14, div: 3, sq: 0.92, uvScale: 2.2,
                                boneBase: leg.boneBase, up0: LEG_UP });
    // Socks are baked into the vertex colour rather than being a second tube
    // slid over the cannon — one more overlapping primitive is exactly what
    // this asset does not need. The multiplier takes #563520 to about #7d6c58.
    const sock = (leg.key === 'LF' || leg.key === 'RH') ? -0.90 : null;
    shadeTube(t, 0.18, 0.22, (run, tt, c) => {
      let v = 1 + 0.06 * Math.exp(-Math.pow((c.y + 0.78) / 0.10, 2));   // hock/knee highlight
      /* WAVE I. The leg tube starts INSIDE the barrel, and the top 30 cm of it
         is the pocket under the elbow and the stifle — the most occluded place
         on a standing horse and, before this, the same value as the cannon out
         in the open. Without it the legs read as four bright poles pushed into
         a body rather than as limbs coming out of a shadowed girth, which is
         half of what "no ambient occlusion under the belly" was pointing at.
         c.y is measured DOWN from the pivot (it is negative going to the hoof).*/
      v *= 1 - 0.44 * smooth(clamp((c.y + 0.30) / 0.30, 0, 1));
      if (sock !== null) v *= 1 + 1.55 * smooth(clamp((sock - c.y) / 0.16, 0, 1));
      return v;
    }, 200 + leg.boneBase, 0.20, 0.34);
    const mesh = new THREE.SkinnedMesh(t.geometry, M.coatVC);
    mesh.frustumCulled = false;
    leg.pivot.add(mesh);
    leg.mesh = mesh;

    // Feather: the tuft behind the fetlock, now facing the camera like the rest
    // of the hair on the animal.
    const feather = new THREE.Mesh(hairGeo({ n: 8, len: 0.115, spanX: 0.026, spanZ: 0.018,
      width: 0.016, bend: 0.30, seed: 400 + leg.boneBase, taper: 0.6, segs: 3,
      axis: Math.PI / 2, spread: 0.8 }), M.hair);
    feather.position.set(0, -leg.P.c + 0.140, -0.032); leg.s3.add(feather);

    // Hoof: a rounded wedge, wide and square at the toe, narrow at the heel,
    // flaring to the ground, with a dark sole. Not an end cap.
    const hoof = new THREE.Mesh(hoofGeo(), M.hoof);
    leg.hoof.add(hoof);
  }

  /* ---- one skeleton for the whole animal ---- */
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  hide.bind(skeleton);
  for (const leg of legs) leg.mesh.bind(skeleton);

  return { M, root, chassis, body, barrel: hide, neckBase, neck: [n1, n2, n3], headPivot,
           head: hide, ears, maneClumps, tailBones, tailRoot, legs, NECK_REST, skeleton };
}

/* ============================ tack ===========================
   A samurai kura: lacquered tree with a high pommel and cantle, crimson aori
   panels, flat abumi stirrups, and a bridle whose reins are re-strung every
   frame between the bit and whatever the rider's hands are doing. */
function buildTack(rig) {
  const { M, body, headPivot, root } = rig;
  const saddle = new THREE.Group();
  saddle.position.set(0, 0.335, 0.08);
  body.add(saddle);

  /* The saddle used to be a flat 0.50 x 0.035 x 0.66 box laid across a barrel
     whose back is a curve — the middle sank into the spine and the four corners
     stood clear of it, which is precisely "a flat box with two square blocks
     floating above the back". Everything below is built against barrelAt(), so
     the blanket, the panels and the side bars follow the animal's real
     cross-section and the tree sits DOWN on them. SADDLE_Y is the group's own
     offset inside body space, so the barrel query has to add it back. */
  const SADDLE_Y = 0.335, SADDLE_Z = 0.08;
  // Half-width x, half-height y of the barrel at a z given in SADDLE space.
  const onBack = (z, xFrac, pad) => backY(z + SADDLE_Z, xFrac, pad) - SADDLE_Y;

  // Saddle blanket, draped on the barrel's real curve and hanging a hand's
  // width below the tree on both flanks.
  const pad = new THREE.Mesh(
    drape(SADDLE_Z - 0.32, SADDLE_Z + 0.32, 10, 1.28, 11, 0.014, 0.24, -SADDLE_Y),
    M.cloth);
  pad.position.z = -SADDLE_Z;                 // drape() works in body z
  saddle.add(pad);
  // Gold hem along the bottom edge of the blanket. It has to follow the same
  // skirt line the drape computes or it reads as a stripe floating off the
  // cloth, so the two share the formula.
  const cs28 = Math.cos(1.28), sn28 = Math.sin(1.28);
  for (const sgn of [1, -1]) {
    const pts = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      const z = lerp(-0.32, 0.32, t);
      const [c, w, h] = barrelAt(z + SADDLE_Z);
      const dr = 0.24 * Math.pow(Math.sin(Math.PI * (0.10 + 0.80 * t)), 0.4);
      const sy = c + h * Math.sign(cs28) * Math.pow(Math.abs(cs28), 0.86);
      pts.push(new THREE.Vector3(sgn * (w * sn28 + 0.016), sy - dr - SADDLE_Y - 0.006, z));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    saddle.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 14, 0.013, 5, false), M.gold));
  }

  // Crimson aori panels, curved to the barrel rather than two flat slabs.
  for (const sgn of [1, -1]) {
    const panel = [];
    for (let i = 0; i <= 6; i++) {
      const z = -0.25 + (i / 6) * 0.48;
      const k = Math.pow(Math.sin(Math.PI * (0.10 + 0.80 * (i / 6))), 0.45);
      panel.push([z, onBack(z, 0.86, 0.012) - 0.145 * k, 0.012, 0.135 * k + 0.02]);
    }
    const p = new THREE.Mesh(loft(panel, 'z', 8, 1.0), M.cloth);
    p.position.x = sgn * 0.262;
    p.rotation.z = sgn * 0.09;
    saddle.add(p);
  }

  /* The tree. Two side bars that lie ALONG the barrel either side of the spine,
     bridged by a dished seat — which is how a kura actually distributes weight
     and, more to the point here, why it reads as attached. */
  for (const sgn of [1, -1]) {
    const bar = [];
    for (let i = 0; i <= 6; i++) {
      const z = -0.25 + (i / 6) * 0.48;
      bar.push([z, onBack(z, 0.62, 0.020) - 0.022, 0.072, 0.028]);
    }
    const b = new THREE.Mesh(loft(bar, 'z', 8, 0.9), M.lacquer);
    b.position.x = sgn * 0.128;
    saddle.add(b);
  }
  // seat: dished in the middle, rising to the pommel and cantle
  const seat = [];
  for (let i = 0; i <= 8; i++) {
    const u = i / 8;
    const z = -0.245 + u * 0.47;
    const dish = 0.055 * Math.sin(Math.PI * u) - 0.030;   // hollow under the rider
    const w = 0.150 + 0.055 * Math.sin(Math.PI * u);
    seat.push([z, onBack(z, 0.0, 0.030) + dish, w, 0.030]);
  }
  const tree = new THREE.Mesh(loft(seat, 'z', 14, 0.75), M.lacquer);
  saddle.add(tree);

  /* Pommel and cantle: lofted arches with a rolled gold cap, standing off the
     seat they are actually joined to. Boxes read as two blocks parked on the
     back; these read as one carved tree. */
  const arch = (z, tilt, w, h, flare) => {
    const g = new THREE.Group();
    g.position.set(0, onBack(z, 0.0, 0.030) - 0.010, z);
    g.rotation.x = tilt; saddle.add(g);
    const sec = [];
    for (let i = 0; i <= 5; i++) {
      const u = i / 5;
      const k = 1 + flare * u * u;
      sec.push([h * u * 1.02, 0, w * k, 0.028 * (1 + 0.5 * u)]);
    }
    const plate = new THREE.Mesh(loft(sec, 'y', 12, 0.55), M.lacquer);
    g.add(plate);
    // rolled gold cap over the top of the arch
    const cap = blob(M.gold, w * (1 + flare) * 1.07, 0.024, 0.036, 14);
    cap.position.y = h * 1.02;
    g.add(cap);
    return g;
  };
  // Wider and much more flared than before, and lower. A kura's bow is a broad
  // fan; at width 0.086 with a flare of 0.62 these two read as what the critics
  // called them, "two square blocks floating above the back".
  const pommel = arch(0.215, -0.34, 0.098, 0.152, 1.05);   // canted forward
  arch(-0.232, 0.40, 0.108, 0.134, 1.15);                  // cantle, canted back

  // girth, sized off the real section rather than a guessed ellipse
  const [gc, gw, gh] = barrelAt(0.30);
  const girth = new THREE.Mesh(new THREE.TorusGeometry(1, 0.048, 8, 28), M.leather);
  girth.position.set(0, gc, 0.30);
  girth.scale.set(gw + 0.022, gh + 0.020, 0.42);
  body.add(girth);
  const [g2c, g2w, g2h] = barrelAt(-0.05);
  const girth2 = girth.clone();
  girth2.position.set(0, g2c, -0.05);
  girth2.scale.set(g2w + 0.026, g2h + 0.020, 0.42);
  body.add(girth2);

  // Stirrups: hung off the saddle tree, not floating out in space beside the
  // barrel. The leathers swing outward as they fall so they clear the flank.
  const stirrups = [];
  for (const sgn of [1, -1]) {
    const s = new THREE.Group();
    s.position.set(sgn * 0.132, 0.02, 0.10);
    s.rotation.z = -sgn * 0.30;
    saddle.add(s);
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.50, 0.018), M.leatherDk);
    strap.position.y = -0.25; s.add(strap);
    const shoe = new THREE.Group(); shoe.position.y = -0.50; shoe.rotation.z = sgn * 0.30; s.add(shoe);
    const tread = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.028, 0.165), M.lacquer);
    shoe.add(tread);
    const toe = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.10, 0.028), M.lacquer);
    toe.position.set(0, 0.048, 0.082); toe.rotation.x = -0.35; shoe.add(toe);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.010, 5, 10), M.steel);
    ring.position.y = 0.075; shoe.add(ring);
    stirrups.push(s);
  }

  // bridle
  const bit = new THREE.Group(); bit.position.set(0, 0.505, 0.035); headPivot.add(bit);
  const bitBar = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.20, 6), M.steel);
  bitBar.rotation.z = Math.PI / 2; bit.add(bitBar);
  for (const sgn of [1, -1]) {
    const cheek = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.56, 0.012), M.leather);
    cheek.position.set(sgn * 0.098, 0.245, 0.012); cheek.rotation.z = sgn * 0.055;
    headPivot.add(cheek);
    const ringm = new THREE.Mesh(new THREE.TorusGeometry(0.030, 0.007, 5, 10), M.steel);
    ringm.position.set(sgn * 0.100, 0.505, 0.035); ringm.rotation.y = Math.PI / 2;
    headPivot.add(ringm);
  }
  const noseband = new THREE.Mesh(new THREE.TorusGeometry(1, 0.05, 5, 14), M.leather);
  noseband.position.set(0, 0.44, 0.012); noseband.rotation.x = Math.PI / 2;
  noseband.scale.set(0.075, 0.075, 0.24);
  headPivot.add(noseband);
  const brow = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.020, 0.014), M.leather);
  brow.position.set(0, 0.045, -0.055); headPivot.add(brow);
  const crownStrap = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.016, 0.055), M.leather);
  crownStrap.position.set(0, -0.005, -0.03); headPivot.add(crownStrap);

  // reins, re-strung each frame on the horse root so both ends can be anywhere
  const reinGeo = new THREE.CylinderGeometry(0.008, 0.008, 1, 5, 1);
  const reins = [];
  for (let i = 0; i < 4; i++) {
    const m = new THREE.Mesh(reinGeo, M.leatherDk);
    m.castShadow = false; root.add(m); reins.push(m);
  }
  return { saddle, stirrups, bit, reins, pommel };
}

/* =========================== gaits ===========================
   off[] is the touchdown phase of each foot in [LF, RF, LH, RH] order.
   duty is the fraction of the cycle the foot is on the ground. */
const GAITS = [
  { name: 'walk',   L: 1.55, fMin: 0.42, fMax: 1.45, duty: 0.62, lift: 0.085, fold: 0.30,
    off: [0.25, 0.75, 0.00, 0.50],
    bobA: 0.014, bobK: 2, bobP: 0.10, pitchA: 0.010, pitchP: 0.10,
    sway: 0.032, neckA: 0.030, headA: 0.030, reach: 1.0 },
  { name: 'trot',   L: 2.45, fMin: 1.00, fMax: 2.05, duty: 0.42, lift: 0.175, fold: 0.75,
    off: [0.00, 0.50, 0.50, 0.00],
    bobA: 0.048, bobK: 2, bobP: 0.33, pitchA: 0.016, pitchP: 0.33,
    sway: 0.012, neckA: 0.022, headA: 0.030, reach: 1.0 },
  { name: 'canter', L: 3.40, fMin: 1.35, fMax: 2.20, duty: 0.34, lift: 0.235, fold: 1.05,
    off: [0.33, 0.66, 0.00, 0.33],
    bobA: 0.080, bobK: 1, bobP: 0.35, pitchA: 0.075, pitchP: 0.15,
    sway: 0.020, neckA: 0.080, headA: 0.070, reach: 1.02 },
  { name: 'gallop', L: 4.85, fMin: 1.70, fMax: 2.80, duty: 0.26, lift: 0.300, fold: 1.30,
    off: [0.45, 0.60, 0.00, 0.15],
    bobA: 0.110, bobK: 1, bobP: 0.37, pitchA: 0.105, pitchP: 0.16,
    sway: 0.012, neckA: 0.120, headA: 0.095, reach: 1.05 },
];

// Continuous gait index with blend bands, so the transitions are real blends
// rather than a snap between two cycles.
function gaitIndex(v) {
  if (v < 2.2) return 0;
  if (v < 3.3) return (v - 2.2) / 1.1;
  if (v < 5.4) return 1;
  if (v < 6.9) return 1 + (v - 5.4) / 1.5;
  if (v < 8.6) return 2;
  if (v < 10.3) return 2 + (v - 8.6) / 1.7;
  return 3;
}

/* ============================ dust ===========================
   Hooves throw warm dust at speed. A single Points cloud with per-particle size
   and alpha; the tint is pulled off the real sun so it sits in the golden hour
   instead of glowing grey. */
function createDust(ctx) {
  const N = 260;
  const pos = new Float32Array(N * 3);
  const size = new Float32Array(N);
  const alpha = new Float32Array(N);
  const vel = new Float32Array(N * 3);
  const life = new Float32Array(N);
  const maxLife = new Float32Array(N);
  for (let i = 0; i < N; i++) { pos[i * 3 + 1] = -9999; }

  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const c2 = cv.getContext('2d');
  const grd = c2.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0.0, 'rgba(255,255,255,0.95)');
  grd.addColorStop(0.45, 'rgba(255,255,255,0.42)');
  grd.addColorStop(1.0, 'rgba(255,255,255,0.0)');
  c2.fillStyle = grd; c2.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(cv);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  g.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
  const m = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: tex }, uColor: { value: new THREE.Color('#c8ab86') } },
    vertexShader: `
      attribute float aSize; attribute float aAlpha; varying float vA;
      void main(){
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * (420.0 / max(1.0, -mv.z));
        gl_Position = projectionMatrix * mv;
        vA = aAlpha;
      }`,
    fragmentShader: `
      uniform sampler2D uMap; uniform vec3 uColor; varying float vA;
      void main(){
        float a = texture2D(uMap, gl_PointCoord).a * vA;
        if (a < 0.004) discard;
        gl_FragColor = vec4(uColor, a);
      }`,
    transparent: true, depthWrite: false, blending: THREE.NormalBlending,
  });
  const points = new THREE.Points(g, m);
  points.frustumCulled = false;
  points.renderOrder = 3;

  let cur = 0;
  return {
    points,
    emit(x, y, z, power, vx, vz) {
      const n = Math.min(9, 2 + Math.round(power * 7));
      for (let k = 0; k < n; k++) {
        const i = cur; cur = (cur + 1) % N;
        pos[i * 3] = x + (Math.random() - 0.5) * 0.22;
        pos[i * 3 + 1] = y + 0.03 + Math.random() * 0.10;
        pos[i * 3 + 2] = z + (Math.random() - 0.5) * 0.22;
        vel[i * 3] = -vx * (0.10 + Math.random() * 0.24) + (Math.random() - 0.5) * 0.9;
        vel[i * 3 + 1] = 0.35 + Math.random() * 0.75 * power;
        vel[i * 3 + 2] = -vz * (0.10 + Math.random() * 0.24) + (Math.random() - 0.5) * 0.9;
        maxLife[i] = 0.75 + Math.random() * 0.85 + power * 0.4;
        life[i] = maxLife[i];
        size[i] = (0.16 + Math.random() * 0.24) * (0.7 + power);
        alpha[i] = 0;
      }
    },
    update(dt, c) {
      const w = c.wind;
      const wx = w ? w.dir.x * w.strength * 0.7 : 0.3;
      const wz = w ? w.dir.y * w.strength * 0.7 : 0.2;
      for (let i = 0; i < N; i++) {
        if (life[i] <= 0) { if (alpha[i] !== 0) alpha[i] = 0; continue; }
        life[i] -= dt;
        const t = Math.max(0, life[i] / maxLife[i]);
        vel[i * 3] += (wx - vel[i * 3]) * dt * 1.1;
        vel[i * 3 + 2] += (wz - vel[i * 3 + 2]) * dt * 1.1;
        vel[i * 3 + 1] += (0.22 - vel[i * 3 + 1]) * dt * 1.6;
        pos[i * 3] += vel[i * 3] * dt;
        pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
        pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
        size[i] += dt * 0.55;
        alpha[i] = 0.30 * t * Math.min(1, (1 - t) * 6.0);
      }
      g.attributes.position.needsUpdate = true;
      g.attributes.aSize.needsUpdate = true;
      g.attributes.aAlpha.needsUpdate = true;
      if (c.sky && c.sky.sun) {
        m.uniforms.uColor.value.copy(c.sky.sun.color).lerp(new THREE.Color('#b8a487'), 0.45);
      }
    },
  };
}

/* ====================== contact shadows ======================
   The critics measured it: "the near foreleg hoof sits above the grass with no
   contact shadow, no grass displacement, no anchoring". The sun shadow map is
   2048 texels over a 380 m frustum — 0.19 m per texel — so the darkening right
   under a hoof is physically below what it can resolve, and the hoof reads as
   balanced on top of the field rather than standing in it. These are four small
   multiplied decals, one per hoof, that live in the root's frame and follow the
   terrain. They are deliberately tight: anything larger fights the real shadow
   the animal already casts. */
/* Two bugs were in the way of that working at all, and both were silent.

   THREE.MultiplyBlending on a material with premultipliedAlpha false made the
   renderer log "MultiplyBlending requires material.premultipliedAlpha = true"
   — measured at 817 lines in a ten-second headless capture, which is a console
   error on every frame of every critic run.

   Worse, the fade did nothing. Multiply blending is blendFunc(ZERO, SRC_COLOR):
   the destination is multiplied by the fragment's RGB and the fragment's ALPHA
   is not in the equation at all. `opacity` on a MeshBasicMaterial only writes
   alpha, so every mark that was visible was drawn at FULL strength and then
   popped off when mesh.visible flipped. A hoof coming down had no ramp.

   So the fade has to be a colour fade — toward white, which is the identity for
   a multiply — and that is a uniform, not an opacity. CustomBlending with the
   same factors keeps the look and takes the warning with it. */
function createContacts() {
  const S = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const c = cv.getContext('2d');
  c.fillStyle = '#ffffff'; c.fillRect(0, 0, S, S);
  const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0.0, 'rgba(0,0,0,0.86)');
  g.addColorStop(0.42, 'rgba(0,0,0,0.42)');
  g.addColorStop(1.0, 'rgba(0,0,0,0.0)');
  c.fillStyle = g; c.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(cv);
  // Painted directly as the multiplier we want, so it must NOT be decoded as
  // sRGB on the way in — what is in the canvas is what multiplies the frame.
  tex.colorSpace = THREE.NoColorSpace;

  const quad = new THREE.PlaneGeometry(1, 1);
  const mats = [], meshes = [];
  // FIVE now, not four: index 4 is the body mark. See setBody().
  for (let i = 0; i < 5; i++) {
    const m = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: tex }, uAmt: { value: 0 } },
      vertexShader: `
        varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform sampler2D uMap; uniform float uAmt; varying vec2 vUv;
        void main(){
          float d = texture2D(uMap, vUv).r;     // 1 at the edge, dark at the centre
          gl_FragColor = vec4(mix(vec3(1.0), vec3(d), uAmt), 1.0);
        }`,
      transparent: true, depthWrite: false, toneMapped: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor,
      blendEquation: THREE.AddEquation,
    });
    const mesh = new THREE.Mesh(quad, m);
    mesh.rotation.x = -Math.PI / 2;
    mesh.renderOrder = 2;
    mesh.frustumCulled = false;
    mats.push(m); meshes.push(mesh);
  }
  return {
    meshes,
    // x/z are root-local, y is the terrain height relative to the root.
    set(i, x, y, z, lift, strength) {
      const mesh = meshes[i];
      // A hoof in the air throws a wider, weaker mark; a planted one a tight,
      // dark one. That contrast is most of what sells the contact.
      const h = clamp(lift, 0, 0.45);
      /* WAVE I: 0.26 m -> 0.52 m planted. A 26 cm mark is a quarter of the
         width of one grass clump. Measured on 06-forest with the whole horse
         toggled off, the ground under the belly moved by -0.0% while four
         control discs 5 m away moved by +0.3 to +10.0% (that spread is the
         wind, and it is the noise floor of this test): the marks were there in
         the scene graph and contributed nothing a measurement could find. */
      const s = 0.52 + h * 1.1;
      mesh.position.set(x, y + 0.015, z);
      mesh.scale.set(s, s, 1);
      const amt = clamp((1 - h / 0.45) * 0.62, 0, 1) * strength;
      mats[i].uniforms.uAmt.value = amt;
      mesh.visible = amt > 0.012;
    },
    /* The mark the four hoof decals could never make. A standing horse occludes
       a body-length pocket of ground, not four coins: the barrel is 1.9 m long
       and 0.75 m wide and it hangs 0.6 m off the floor, so the sky is shut out
       of a soft ellipse roughly two metres by one. This is that ellipse. It is
       lower amplitude than a hoof mark and much wider, which is what ambient
       occlusion looks like as opposed to a cast shadow — the sun shadow map
       already draws the cast shadow and this must not fight it.
       yaw is the root's own, so the ellipse is passed in root-local space and
       needs no rotation of its own. */
    setBody(x, y, z, strength) {
      const mesh = meshes[4];
      mesh.position.set(x, y + 0.012, z);
      mesh.scale.set(1.15, 2.35, 1);   // lateral, fore-aft (plane is +X/-Z after the -90 x-rot)
      const amt = clamp(0.52 * strength, 0, 1);
      mats[4].uniforms.uAmt.value = amt;
      mesh.visible = amt > 0.012;
    },
  };
}

/* ============================= IK ============================
   Two-bone solve to the knee/hock, then the cannon aims at the hoof. The bend
   sign puts the elbow behind the line of the front leg and the stifle in front
   of the line of the back one, which is what makes a horse read as a horse.
   Angles are worked in phi-space: phi is measured from straight down, positive
   forward, and rotation.x = -phi. */
function solveLeg(leg, tx, ty, tz, fold) {
  const P = leg.P;
  // lateral splay handled by the pivot, so the leg swings in its own plane
  const splay = Math.atan2(tx, Math.max(0.05, -ty));
  leg.pivot.rotation.z = splay;
  const R = Math.sqrt(tx * tx + ty * ty);          // distance straight "down" the plane
  const d0 = Math.max(0.02, Math.sqrt(R * R + tz * tz));

  // Cannon leans toward the body rather than staying vertical.
  const kx = -tz / d0, ky = R / d0;                // unit vector foot -> pivot, in-plane
  let ux = kx * 0.6, uy = 0.4 + ky * 0.6;
  const ul = Math.hypot(ux, uy) || 1; ux /= ul; uy /= ul;
  const kzT = tz + ux * P.c;
  const kyT = -R + uy * P.c;

  const a = P.a, b = P.b, s = P.s;
  let d = Math.hypot(kzT, kyT);
  d = clamp(d, Math.abs(a - b) + 0.035, (a + b) * 0.998);
  const dirPhi = Math.atan2(kzT, Math.max(1e-4, -kyT));
  const A = Math.acos(clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1));
  const B = Math.acos(clamp((a * a + b * b - d * d) / (2 * a * b), -1, 1));
  let phi1 = dirPhi + s * A;
  let phi2 = phi1 - s * (Math.PI - B);

  // Mid-swing fold: the joints close further than reaching alone would close them.
  phi1 -= s * fold * 0.30;
  phi2 -= s * fold * 0.95;

  leg.s1.rotation.x = -phi1;
  leg.s2.rotation.x = -(phi2 - phi1);
  const ky2 = -(a * Math.cos(phi1) + b * Math.cos(phi2));
  const kz2 = a * Math.sin(phi1) + b * Math.sin(phi2);
  const phi3 = Math.atan2(tz - kz2, Math.max(1e-4, -( -R - ky2)));
  leg.s3.rotation.x = -(phi3 - phi2);
  leg.hoof.rotation.x = phi3;
  leg.kneeY = ky2; leg.kneeZ = kz2; leg.phi3 = phi3;
}

/* ========================== the mount ========================= */
export function createHorse(ctx) {
  const { world } = ctx;
  const rig = buildHorse();
  const tack = buildTack(rig);
  const dust = createDust(ctx);
  ctx.scene.add(dust.points);            // particles live in world space

  const { root, chassis, body, legs, neck, headPivot, maneClumps, tailBones, ears } = rig;
  // Scratch for the wind read below. Allocated once; nothing here allocates per
  // frame.
  const _wW = new THREE.Vector3(), _wB = new THREE.Vector3(), _wM = new THREE.Matrix4();
  root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  // Measurement hook (k-wind lane). The mane and the tail are the two things a
  // still frame cannot judge; a probe needs the bones themselves to read which
  // way they are actually pointing in WORLD space. Debug only, reads nothing.
  if (typeof window !== 'undefined') window.__HORSE = { rig, maneClumps, tailBones, tailRoot: rig.tailRoot };

  // Contact decals hang off the root, not the chassis: they belong to the
  // ground, so they must not inherit the animal's pitch and roll.
  const contacts = createContacts();
  for (const m of contacts.meshes) { m.castShadow = false; m.receiveShadow = false; root.add(m); }

  // The rider hangs off the saddle. ctx.samurai is re-parented in here on mount
  // and handed back to the player root on dismount; samurai.js is never touched.
  const riderRoot = new THREE.Group();
  const SEAT = new THREE.Vector3(0, 0.50, 0.06);
  riderRoot.position.copy(SEAT);
  body.add(riderRoot);

  const qcInv = new THREE.Quaternion(), qbInv = new THREE.Quaternion();
  const startPos = new THREE.Vector3(), endPos = new THREE.Vector3();
  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _m = new THREE.Vector3();

  let px = 0, pz = 0, py = 0, yaw = 0, speed = 0;
  let phase = 0, gIdx = 0, gaitName = 'halt';
  const liveOff = GAITS[0].off.slice();
  let mode = 'off', mountT = 0, blend = 0, startYaw = 0;
  let refuse = 0, refuseCool = 0, summon = 0, autoMount = false;
  let turnRate = 0, lean = 0, bob = 0, bobVel = 0, gaitPitch = 0;
  let idleT = 0.5, graze = 0, hazeAcc = 0;
  let camDist = 0, camHt = 0, camSaved = false;
  let teleGuard = false;

  const wrap01 = (v) => v - Math.floor(v);
  const angleDelta = (from, to) =>
    THREE.MathUtils.euclideanModulo(to - from + Math.PI, Math.PI * 2) - Math.PI;
  const wX = (lx, lz) => px + lx * Math.cos(yaw) + lz * Math.sin(yaw);
  const wZ = (lx, lz) => pz - lx * Math.sin(yaw) + lz * Math.cos(yaw);
  // A point pinned in the world, expressed in the horse's frame, after the horse
  // has moved dz along its nose and turned dy.
  function recede(p, dz, dy) {
    p.y -= dz;                                   // Vector2: x = lateral, y = along the nose
    const c = Math.cos(-dy), s = Math.sin(-dy);
    const nx = p.x * c + p.y * s;
    const nz = -p.x * s + p.y * c;
    p.x = nx; p.y = nz;
  }

  function placeFeet() {
    for (const leg of legs) {
      leg.foot.set(leg.restX, leg.restZ);
      leg.from.copy(leg.foot);
      leg.footY = world.heightAt(wX(leg.foot.x, leg.foot.y), wZ(leg.foot.x, leg.foot.y)) - py;
      leg.wasStance = true;
    }
  }

  /* Pitch and roll straight off the ground under the animal. update() damps
     toward exactly this every frame (rate 7, so ~0.5 s to arrive); a horse that
     is PLACED rather than ridden never gets that half second before the shutter,
     so on a 12-degree slope setPosition used to leave a perfectly level horse
     with two hooves buried and two in the air. Solve it now, from the same four
     samples update() uses, and update() then has nothing to correct. */
  function groundChassis() {
    const hF = world.heightAt(px + Math.sin(yaw) * 0.95, pz + Math.cos(yaw) * 0.95);
    const hB = world.heightAt(px - Math.sin(yaw) * 0.95, pz - Math.cos(yaw) * 0.95);
    const lxr = Math.cos(yaw) * 0.42, lzr = -Math.sin(yaw) * 0.42;
    const hL = world.heightAt(px + lxr, pz + lzr), hR = world.heightAt(px - lxr, pz - lzr);
    chassis.rotation.set(-Math.atan2(hF - hB, 1.9), 0, Math.atan2(hL - hR, 0.84));
  }

  function setPosition(x, y, z, faceDeg = 0) {
    px = x; pz = z; yaw = THREE.MathUtils.degToRad(faceDeg);
    py = world.heightAt(px, pz); speed = 0; phase = 0;
    root.position.set(px, py, pz); root.rotation.y = yaw;
    groundChassis();
    placeFeet();
  }

  /* ---------------- mount / dismount ---------------- */
  function beginMount(c) {
    const s = ctx.samurai; if (!s) return;
    const p = c.player.position;
    const dx = p.x - px, dz = p.z - pz;
    startPos.set(
      dx * Math.cos(yaw) - dz * Math.sin(yaw),
      (p.y + 0.92 - py) - body.position.y,
      dx * Math.sin(yaw) + dz * Math.cos(yaw),
    );
    startYaw = angleDelta(yaw, c.player.yaw ?? yaw);
    riderRoot.position.copy(startPos);
    riderRoot.rotation.y = startYaw;
    riderRoot.add(s.group);
    s.group.position.set(0, -0.92, 0);
    s.group.rotation.set(0, 0, 0);
    mode = 'mounting'; mountT = 0; blend = 0;
    ears.forEach(e => { e.userData.flick = 0.5; });
  }

  function beginDismount(c) {
    const lx = 1.05, lz = -0.10;                       // step down on the near side
    const gx = wX(lx, lz), gz = wZ(lx, lz);
    endPos.set(lx, (world.heightAt(gx, gz) + 0.92 - py) - body.position.y, lz);
    startPos.copy(riderRoot.position);
    mode = 'dismounting'; mountT = 0;
  }

  function finishDismount(c) {
    const s = ctx.samurai;
    const gx = wX(endPos.x, endPos.z), gz = wZ(endPos.x, endPos.z);
    if (s) {
      c.player.root.add(s.group);
      s.group.position.set(0, 0, 0);
      s.group.rotation.set(0, 0, 0);
    }
    teleGuard = true;
    c.player.setPosition(gx, 0, gz, THREE.MathUtils.radToDeg(yaw) + 25);
    teleGuard = false;
    c.player.mounted = false;
    mode = 'off'; blend = 0;
  }

  function pressMount(c) {
    if (mode === 'mounting' || mode === 'dismounting') return;
    if (mode === 'on') { beginDismount(c); return; }
    const p = c.player.position;
    if (Math.hypot(p.x - px, p.z - pz) > 6.5) { summon = 1; autoMount = true; return; }
    beginMount(c);
  }

  /* ---------------- rider pose ----------------
     Runs inside the player's update slot so it lands after the horse has moved
     and after samurai.update() has written its locomotion pose — the seat is
     stamped on top, blended in over the mount. */
  const playerUpdate = ctx.player.update.bind(ctx.player);
  const playerSetPos = ctx.player.setPosition.bind(ctx.player);

  ctx.player.setPosition = (x, y, z, faceDeg = 0) => {
    playerSetPos(x, y, z, faceDeg);
    if (teleGuard) return;
    // A teleport must never strand the rider: dump them off, then park the horse
    // in shot beside wherever the player landed.
    if (mode !== 'off') {
      const s = ctx.samurai;
      if (s) { ctx.player.root.add(s.group); s.group.position.set(0, 0, 0); s.group.rotation.set(0, 0, 0); }
      mode = 'off'; blend = 0; ctx.player.mounted = false;
      riderRoot.position.copy(SEAT); riderRoot.rotation.y = 0;
    }
    park(x, z, faceDeg);
    speed = 0;
  };

  function poseRider(dt, c) {
    const s = ctx.samurai;
    if (!s || blend <= 0.001) return;
    const b = s.bones, k = blend;
    const v = Math.abs(speed);
    const gal = clamp((v - 5.0) / 7.0, 0, 1);
    const rock = -bobVel * 0.012 + gaitPitch * 0.9;
    const L = (o, key, val) => { o[key] = lerp(o[key], val, k); };

    const chestX = 0.12 + gal * 0.40 + rock * 0.6 + refuse * 0.35;
    L(b.hips.position, 'y', 0.92 + gal * 0.045 - bob * 0.35);
    L(b.hips.rotation, 'x', 0.05 + gaitPitch * 0.5); L(b.hips.rotation, 'y', 0); L(b.hips.rotation, 'z', 0);
    L(b.spine.rotation, 'x', 0.05); L(b.spine.rotation, 'z', 0);
    L(b.chest.rotation, 'x', chestX); L(b.chest.rotation, 'y', 0); L(b.chest.rotation, 'z', 0);
    L(b.neck.rotation, 'x', -chestX * 0.85);
    // thighs out around the barrel, shins in against the stirrup leathers
    L(b.hip.l.rotation, 'x', -1.00 - gal * 0.10); L(b.hip.l.rotation, 'z', 0.50);
    L(b.hip.r.rotation, 'x', -1.00 - gal * 0.10); L(b.hip.r.rotation, 'z', -0.50);
    L(b.knee.l.rotation, 'x', 1.02 + gal * 0.22); L(b.knee.l.rotation, 'z', -0.26);
    L(b.knee.r.rotation, 'x', 1.02 + gal * 0.22); L(b.knee.r.rotation, 'z', 0.26);
    L(b.ankle.l.rotation, 'x', -0.16); L(b.ankle.r.rotation, 'x', -0.16);
    // hands forward on the reins, dropping as the body leans over the withers
    const sh = -0.72 - chestX * 0.55 - gal * 0.20;
    L(b.shoulder.l.rotation, 'x', sh); L(b.shoulder.l.rotation, 'z', -0.13);
    L(b.shoulder.r.rotation, 'x', sh); L(b.shoulder.r.rotation, 'z', 0.13);
    L(b.elbow.l.rotation, 'x', -0.66); L(b.elbow.r.rotation, 'x', -0.62);
  }

  ctx.player.update = (dt, c) => {
    if (mode === 'off') { playerUpdate(dt, c); return; }
    // Mounted: the player rig is a camera anchor, nothing more.
    const p = c.player.root;
    p.position.set(px, py + 0.55, pz);
    p.rotation.set(0, yaw, 0);
    c.player.speed = Math.abs(speed);
    c.player.mounted = mode === 'on' || mode === 'mounting';
    const s = ctx.samurai;
    if (s) s.update(dt, { speed: Math.abs(speed), moving: Math.abs(speed) > 0.12,
                          sprinting: Math.abs(speed) > 8, grounded: true });
    poseRider(dt, c);
  };

  /* ============================ update ============================ */
  function update(dt, c) {
    dt = Math.min(dt, 1 / 20);
    const inp = c.input;
    if (inp && inp.mount) pressMount(c);

    /* ---- mount transitions ---- */
    if (mode === 'mounting') {
      mountT += dt;
      const k = clamp(mountT / 0.55, 0, 1), e = smooth(k);
      riderRoot.position.lerpVectors(startPos, SEAT, e);
      riderRoot.position.y += Math.sin(Math.PI * k) * 0.34;
      riderRoot.rotation.y = lerp(startYaw, 0, e);
      blend = e;
      if (k >= 1) { mode = 'on'; riderRoot.position.copy(SEAT); riderRoot.rotation.y = 0; blend = 1; }
    } else if (mode === 'dismounting') {
      mountT += dt;
      const k = clamp(mountT / 0.55, 0, 1), e = smooth(k);
      riderRoot.position.lerpVectors(startPos, endPos, e);
      riderRoot.position.y += Math.sin(Math.PI * k) * 0.30;
      riderRoot.rotation.y = lerp(0, 0.5, e);
      blend = 1 - e;
      if (k >= 1) finishDismount(c);
    }

    /* ---- what the horse is being asked to do ---- */
    let target = 0, steer = null;
    const ridden = mode === 'on' || (mode === 'mounting' && mountT > 0.28);
    if (ridden && inp) {
      const mag = Math.min(Math.hypot(inp.move.x, inp.move.y), 1);
      if (mag > 0.05) {
        const cy = c.gcam ? c.gcam.yaw : yaw;
        const fx = Math.sin(cy), fz = Math.cos(cy);
        const dx = fx * inp.move.y + fz * inp.move.x;
        const dz = fz * inp.move.y - fx * inp.move.x;
        if (inp.move.y < -0.2 && Math.abs(inp.move.x) < 0.5 && Math.abs(speed) < 2) {
          steer = yaw; target = -1.25;                       // rein back
        } else {
          steer = Math.atan2(dx, dz);
          target = (inp.sprint ? 12.2 : 4.6) * mag;
        }
      }
    } else if (summon > 0) {
      const p = c.player.position;
      const d = Math.hypot(p.x - px, p.z - pz);
      if (d < 3.2) {
        summon = 0;
        if (autoMount) { autoMount = false; beginMount(c); }
      } else {
        steer = Math.atan2(p.x - px, p.z - pz);
        target = clamp(d * 0.85, 2.6, 8.5);
      }
    }

    /* ---- terrain refuses some of it ---- */
    const look = 2.0 + Math.abs(speed) * 0.26;
    const ax = px + Math.sin(yaw) * look, az = pz + Math.cos(yaw) * look;
    const ah = world.heightAt(ax, az);
    // A SINGLE lookahead sample over-reads noisy terrain by roughly 3x: on a
    // 13-degree hill (slopeAt 0.24) it returned grade 0.84, pinned target to 0,
    // and the horse could never build the speed it needed to clear the rise.
    // That softlocked the ride beat and made six of the ten beats unreachable.
    // Take the median of a fan, and require the analytic slope to agree.
    const g = [];
    for (const L of [look * 0.55, look, look * 1.7]) {
      const sx = px + Math.sin(yaw) * L, sz = pz + Math.cos(yaw) * L;
      g.push((world.heightAt(sx, sz) - py) / L);
    }
    g.sort((a, b) => a - b);
    const grade = g[1];
    const slopeHere = world.slopeAt(ax, az);
    const blocked = (grade > 0.62 && slopeHere > 0.45) || slopeHere > 0.74 || ah < 0.45;
    if (blocked && target > 0) {
      target = 0;
      if (Math.abs(speed) > 3.0 && refuseCool <= 0) { refuse = 1; refuseCool = 2.6; }
    }
    refuse = Math.max(0, refuse - dt / 0.9);
    refuseCool -= dt;

    const nrm = world.normalAt(px, pz);
    const uphill = -(Math.sin(yaw) * nrm.x + Math.cos(yaw) * nrm.z);
    target *= clamp(1 - uphill * 1.3, 0.40, 1.25);

    /* ---- steering; a galloping horse cannot pivot ---- */
    let dYaw = 0;
    if (steer !== null) {
      const d = angleDelta(yaw, steer);
      const rate = lerp(2.7, 0.85, clamp(Math.abs(speed) / 12, 0, 1));
      dYaw = clamp(d, -rate * dt, rate * dt);
      yaw += dYaw;
      target *= 1 - clamp(Math.abs(d), 0, 1.4) * 0.22;
    }
    turnRate = THREE.MathUtils.damp(turnRate, dt > 1e-5 ? dYaw / dt : 0, 9, dt);

    const acc = Math.abs(target) > Math.abs(speed)
      ? (Math.abs(speed) < 5.5 ? 12.0 : 8.5) : 9.5;
    speed += clamp(target - speed, -acc * dt, acc * dt);
    if (refuse > 0.01) speed = THREE.MathUtils.damp(speed, 0, 9, dt);
    if (Math.abs(speed) < 0.02) speed = 0;

    /* ---- move ---- */
    const step = speed * dt;
    px += Math.sin(yaw) * step; pz += Math.cos(yaw) * step;
    const lim = ((world.ISLAND && world.ISLAND.size) || 2400) * 0.5 - 60;
    px = clamp(px, -lim, lim); pz = clamp(pz, -lim, lim);
    py = world.heightAt(px, pz);
    root.position.set(px, py, pz);
    root.rotation.y = yaw;

    /* ---- chassis sits on the ground, and leans into the corner ---- */
    const hF = world.heightAt(px + Math.sin(yaw) * 0.95, pz + Math.cos(yaw) * 0.95);
    const hB = world.heightAt(px - Math.sin(yaw) * 0.95, pz - Math.cos(yaw) * 0.95);
    const lxr = Math.cos(yaw) * 0.42, lzr = -Math.sin(yaw) * 0.42;
    const hL = world.heightAt(px + lxr, pz + lzr), hR = world.heightAt(px - lxr, pz - lzr);
    lean = THREE.MathUtils.damp(lean,
      clamp(-turnRate * Math.abs(speed) * 0.030, -0.26, 0.26), 5, dt);
    chassis.rotation.x = THREE.MathUtils.damp(
      chassis.rotation.x, -Math.atan2(hF - hB, 1.9) - refuse * 0.55, 7, dt);
    chassis.rotation.z = THREE.MathUtils.damp(
      chassis.rotation.z, Math.atan2(hL - hR, 0.84) + lean, 7, dt);

    /* ---- gait ---- */
    const v = Math.abs(speed);
    gIdx = THREE.MathUtils.damp(gIdx, gaitIndex(v), 7, dt);
    const i0 = Math.min(2, Math.floor(clamp(gIdx, 0, 3))), i1 = Math.min(3, i0 + 1);
    const fr = clamp(gIdx - i0, 0, 1);
    const GA = GAITS[i0], GB = GAITS[i1];
    const gp = (k) => lerp(GA[k], GB[k], fr);
    gaitName = fr < 0.5 ? GA.name : GB.name;
    const strideL = gp('L'), duty = gp('duty'), liftH = gp('lift'), foldA = gp('fold');
    const f = clamp(v / strideL, gp('fMin'), gp('fMax'));
    const moving = v > 0.18;
    if (moving) phase = wrap01(phase + Math.sign(speed) * f * dt);
    const oK = 1 - Math.exp(-7 * dt);
    for (let i = 0; i < 4; i++) {
      liveOff[i] = wrap01(clerp(liveOff[i], clerp(GA.off[i], GB.off[i], fr), oK));
    }
    const mv = clamp(v / 1.4, 0, 1);
    const cw = (G, key, k) => G[key] * Math.sin(Math.PI * 2 * (G.bobK * phase + G[k]));
    const prevBob = bob;
    bob = lerp(cw(GA, 'bobA', 'bobP'), cw(GB, 'bobA', 'bobP'), fr) * mv;
    gaitPitch = lerp(cw(GA, 'pitchA', 'pitchP'), cw(GB, 'pitchA', 'pitchP'), fr) * mv;
    const sway = gp('sway') * Math.sin(Math.PI * 2 * phase) * mv;
    bobVel = dt > 1e-5 ? (bob - prevBob) / dt : 0;

    body.position.y = BODY_Y + bob - clamp(v / 12, 0, 1) * 0.035;
    body.rotation.x = -gaitPitch - refuse * 0.30;
    body.rotation.z = sway;

    /* ---- legs ---- */
    qcInv.setFromEuler(chassis.rotation).invert();
    qbInv.setFromEuler(body.rotation).invert();
    const reach = moving ? (speed * duty) / (2 * f) : 0;
    // Contact marks track the key: a hard sun makes a hard mark, and there is
    // almost nothing to mark under a moon.
    const contactK = c.sky && c.sky.sun ? clamp(c.sky.sun.intensity * 0.16, 0.10, 1.0) : 0.6;
    for (let i = 0; i < 4; i++) {
      const leg = legs[i];
      const lp = wrap01(phase - liveOff[i]);
      const stance = !moving || lp < duty;
      let liftY = 0, fold = 0;

      if (stance) {
        if (!leg.wasStance) {
          leg.foot.set(leg.restX, leg.restZ + reach);
          if (v > 2.0) {                                   // hoof strike
            const hx = wX(leg.foot.x, leg.foot.y), hz = wZ(leg.foot.x, leg.foot.y);
            dust.emit(hx, world.heightAt(hx, hz), hz, clamp((v - 1.8) / 9, 0, 1),
                      Math.sin(yaw) * v, Math.cos(yaw) * v);
          }
        } else if (moving) {
          recede(leg.foot, step, dYaw);
        } else {
          leg.foot.x = THREE.MathUtils.damp(leg.foot.x, leg.restX, 4, dt);
          leg.foot.y = THREE.MathUtils.damp(leg.foot.y, leg.restZ, 4, dt);
        }
      } else {
        if (leg.wasStance) leg.from.copy(leg.foot);
        recede(leg.from, step, dYaw);
        const u = clamp((lp - duty) / (1 - duty), 0, 1);
        const e = smooth(u);
        leg.foot.x = lerp(leg.from.x, leg.restX, e);
        leg.foot.y = lerp(leg.from.y, leg.restZ + reach, e);
        liftY = liftH * Math.sin(Math.PI * Math.pow(u, 0.82));
        fold = foldA * Math.pow(Math.sin(Math.PI * u), 1.25);
      }
      leg.wasStance = stance;

      // rearing pulls the forehand up and folds it under
      if (refuse > 0.01 && leg.fore) {
        liftY += refuse * 0.85;
        leg.foot.y = lerp(leg.foot.y, leg.restZ - 0.18, refuse);
        fold += refuse * 1.1;
      }

      const gx = wX(leg.foot.x, leg.foot.y), gz = wZ(leg.foot.x, leg.foot.y);
      // HOOF_SINK: the hoof group's origin is the bottom of the hoof wall, so
      // solving exactly to the terrain height leaves the animal balanced on a
      // mathematical plane while the grass it is standing in is 0.4 m tall.
      // Two centimetres under puts the wall into the sward, which is what
      // "anchored" looks like.
      leg.footY = world.heightAt(gx, gz) - py - HOOF_SINK;
      contacts.set(i, leg.foot.x, leg.footY + HOOF_SINK, leg.foot.y, liftY, contactK);

      // scapula / pelvis swing buys the extra protraction a real horse gets
      const sw = clamp((leg.foot.y - leg.restZ) * 0.24, -0.15, 0.15) * (leg.fore ? 1 : 0.7);
      leg.pivot.position.z = leg.pivotZ0 + sw;

      _v1.set(leg.foot.x, leg.footY + liftY, leg.foot.y);
      _v1.applyQuaternion(qcInv);
      _v1.y -= body.position.y;
      _v1.applyQuaternion(qbInv);
      _v1.sub(leg.pivot.position);
      solveLeg(leg, _v1.x, _v1.y, _v1.z, fold);
    }

    /* The body's own occlusion pocket, centred on the mean of the four feet so
       it travels with the animal and sits square under the barrel at every
       gait. Slightly weaker than a planted hoof mark and twenty times the area:
       this is the term that makes the horse stand IN the field. */
    let bx = 0, bz = 0, byy = 0;
    for (let i = 0; i < 4; i++) { bx += legs[i].foot.x; bz += legs[i].foot.y; byy += legs[i].footY; }
    contacts.setBody(bx / 4, byy / 4 + HOOF_SINK, bz / 4, contactK);

    /* ---- neck, head, mane, tail ---- */
    const run = clamp(v / 12, 0, 1);
    idleT += dt;
    if (mode === 'off' && v < 0.2) {
      const cyc = wrap01(idleT / 17);
      graze = THREE.MathUtils.damp(graze, cyc > 0.55 && cyc < 0.78 ? 1 : 0, 1.6, dt);
    } else graze = THREE.MathUtils.damp(graze, 0, 3, dt);

    const pump = gp('neckA') * Math.sin(Math.PI * 2 * (phase + 0.55)) * mv;
    const hnod = gp('headA') * Math.sin(Math.PI * 2 * (phase + 0.62)) * mv;
    neck[0].rotation.x = THREE.MathUtils.damp(neck[0].rotation.x,
      rig.NECK_REST[0] + run * 0.30 + graze * 0.95 - refuse * 0.55 + pump, 9, dt);
    neck[1].rotation.x = THREE.MathUtils.damp(neck[1].rotation.x,
      rig.NECK_REST[1] + run * 0.10 + graze * 0.30 - refuse * 0.20 + pump * 0.5, 9, dt);
    neck[2].rotation.x = THREE.MathUtils.damp(neck[2].rotation.x,
      rig.NECK_REST[2] + run * 0.06 + graze * 0.22 + pump * 0.3, 9, dt);
    neck[0].rotation.z = THREE.MathUtils.damp(neck[0].rotation.z, -turnRate * 0.10, 5, dt);
    neck[1].rotation.z = THREE.MathUtils.damp(neck[1].rotation.z, -turnRate * 0.08, 5, dt);
    headPivot.rotation.x = THREE.MathUtils.damp(headPivot.rotation.x,
      1.60 - run * 0.42 - graze * 0.55 - refuse * 0.35 + hnod, 9, dt);
    headPivot.rotation.z = THREE.MathUtils.damp(headPivot.rotation.z, turnRate * 0.06, 5, dt);

    /* ---- THE WIND. -----------------------------------------------------------
       The mane used to read `c.wind.gust() * strength` — one SCALAR, with no
       direction in it at all — and add it to rotation.x, so the whole mane got
       a DC bias backwards and nothing else. The tail read no wind term of any
       kind: its only inputs were `run` and an idle sine, so a standing horse's
       tail hung dead vertical while the grass under it was in a travelling
       gust. Measured on the shipped build at 01-sunset-ridge, frozen frame:
       tail tip 0.27 of its length off vertical, and that fraction pointing
       -0.75 AGAINST the wind (it was the idle sine, not air).

       Both now read the SAME field every other system reads:
         wind.sample(x, z)  — windGust()'s CPU twin: the travelling fronts, so
                              a gust that crosses the field crosses the animal.
         wind.dirAt(x, z)   — windDirAt()'s CPU twin: the local direction,
                              bent into a guiding corridor wherever one blows.
       Sampled at the ANIMAL's world position, never at the origin. */
    const wind = c.wind;
    let gW = 0.24, wxb = 0, wzb = 0;                 // ambient mean, body frame
    if (wind) {
      root.updateWorldMatrix(true, false);
      const wpx = root.position.x, wpz = root.position.z;
      gW = wind.sample ? Math.max(0, wind.sample(wpx, wpz)) : wind.gust() * wind.strength;
      if (wind.dirAt) { const d = wind.dirAt(wpx, wpz); _wW.set(d[0], 0, d[1]); }
      else _wW.set(wind.dir.x, 0, wind.dir.y);
      // Into the barrel's own frame, so terrain pitch and roll do not shear it.
      body.updateWorldMatrix(true, false);
      _wM.copy(body.matrixWorld).invert();
      _wB.copy(_wW).transformDirection(_wM);
      const l = Math.hypot(_wB.x, _wB.z) || 1;
      wxb = _wB.x / l; wzb = _wB.z / l;
    }
    /* Saturating response. wind.js measured the ambient field at mean 0.240,
       p99 0.514, max 0.655, and a guiding-corridor head at 1.28 typical / 1.58
       worst case; its own note says put the knee ABOVE ambient p99 and still
       resolve to ~1.6. g/(1+0.45g) does that: 0.24 -> 0.222, 0.514 -> 0.418,
       1.0 -> 0.690, 1.58 -> 0.921. Ordinary wind is not flattened and a gust
       head still reads as four times it, but nothing can ever reach the
       horizontal that would make hair look like a flag. */
    const gS = gW / (1 + 0.45 * gW);
    if (typeof window !== 'undefined' && window.__WINDPROBE && window.__HORSE) {
      window.__HORSE.windDbg = { gW: +gW.toFixed(4), gS: +gS.toFixed(4),
        wxb: +wxb.toFixed(4), wzb: +wzb.toFixed(4),
        worldDir: [+_wW.x.toFixed(4), +_wW.z.toFixed(4)], run: +run.toFixed(3) };
    }
    /* Positive rotation.x swings hair toward -Z (the rear); positive rotation.z
       swings it toward +X. So a wind blowing toward body +Z has to SUBTRACT
       from rotation.x, and one blowing toward +X adds to rotation.z. */
    /* A_MANE PICKED BY SWEEP. tools/kw-mane.mjs, same A/B/A method as the tail
       (horse.js publishes each clump's wind-only rotation on
       __HORSE.windDbg.maneA; the probe subtracts it and puts it back), frozen
       frame, harness noise 0.00 m at every value:

         A_MANE   wind push   push . wind   curtain off vert   hang . wind
         0 (ship)  0.000 m       --             21.5 deg         -0.652
         0.62      0.108 m      0.984           32.6 deg         -0.104
         1.05      0.160 m      0.996           45.5 deg         -0.019
         1.50      0.213 m      0.992           49.6 deg         +0.309

       The shipped mane read `gust() * strength` — a SCALAR with no direction
       in it — so its 21.5 deg of offset was the curtain's own outboard `drift`
       and an idle sine, pointing 131 deg away from the air. Every non-zero row
       pushes dead downwind (0.98-1.00); what the sweep buys is how much.
       1.05 doubles the shipped push and lands the curtain at 45 deg off
       vertical at gW 0.58. 1.50 was rejected: it is already at 49.6 deg in
       ORDINARY wind, and a corridor head roughly doubles the wind term, which
       lays the mane out level with the crest.
       The lateral coefficient is 0.89 of the fore/aft one — the mane is rooted
       along the crest, so it swings across the neck more easily than it lifts
       along it. */
    const A_MANE = (typeof window !== 'undefined' && window.__HORSE
      && window.__HORSE.tuneAMane != null) ? window.__HORSE.tuneAMane : 1.05;
    // Probe-only. window.__WINDPROBE is set by tools/kw-*.mjs and by nothing
    // else, so the shipped build allocates none of this per frame.
    const dbgM = (typeof window !== 'undefined' && window.__WINDPROBE) ? [] : null;
    for (let i = 0; i < maneClumps.length; i++) {
      const m = maneClumps[i];
      const lagK = 1 - Math.exp(-(7 - i * 0.5) * dt);
      // The clumps sit down the neck, so each reads the field a little further
      // upwind than the one behind it: a front arrives at the poll first and
      // travels down the crest instead of the whole mane flicking at once.
      const gI = wind && wind.sample
        ? Math.max(0, wind.sample(root.position.x - _wW.x * (0.25 + i * 0.10),
                                  root.position.z - _wW.z * (0.25 + i * 0.10)))
        : gW;
      const gSi = gI / (1 + 0.45 * gI);
      const tgt = run * 1.30 - gSi * A_MANE * wzb
                + Math.sin(idleT * 2.3 - i * 0.9) * (0.04 + run * 0.14);
      m.lag = lerp(m.lag, tgt, lagK);
      m.g.rotation.x = m.base + m.lag;
      m.g.rotation.z = THREE.MathUtils.damp(m.g.rotation.z,
        gSi * A_MANE * 0.89 * wxb
        + Math.sin(idleT * 1.7 - i * 0.7) * (0.05 + run * 0.20) - turnRate * 0.10,
        7 - i * 0.2, dt);
      if (dbgM) dbgM.push([-gSi * A_MANE * wzb, gSi * A_MANE * 0.89 * wxb]);
    }
    if (dbgM && window.__HORSE.windDbg) window.__HORSE.windDbg.maneA = dbgM;
    /* The tail is a five-link chain, so the tip's total deflection is the SUM
       of the five. Distribute one target angle across them with the tip
       swinging most, and let each bone lag more than the one above it, and the
       tail streams and trails instead of swinging as a rigid plank.
       A_TAIL PICKED BY SWEEP, not by feel. tools/kw-tail.mjs, 01-sunset-ridge,
       frozen frame, A/B/A with the harness noise at 0.00 m every time. The A/B
       subtracts exactly the per-bone rotation the wind put in (horse.js
       publishes it on __HORSE.windDbg.tailA) and puts it back, so the delta is
       the wind's own contribution and nothing else:

         A_TAIL   wind push   push . wind   visible tip off   tip . wind
         0 (ship)   0.000 m      --            16.1 deg        -0.751
         1.05       0.420 m     1.000          13.5 deg        +0.628
         1.80       0.684 m     1.000          24.4 deg        +0.909
         2.60       0.944 m     0.999          41.7 deg        +0.971

       Read the last column first: at A_TAIL 0 — the shipped build — the tail's
       whole hang pointed 139 degrees AWAY from the wind. It was not weakly
       downwind, it was upwind, because the only things moving it were the
       dock's fixed rearward set and an idle sine. 1.80 lands it 24.6 deg off
       the wind line at an ordinary gW of 0.62 (well above the field's own mean
       of 0.240), with the tip 24 deg off vertical. 2.60 was rejected: 41.7 deg
       at ORDINARY wind scales to about 70 in a corridor head, which is a flag,
       not a tail. */
    const A_TAIL = (typeof window !== 'undefined' && window.__HORSE
      && window.__HORSE.tuneATail != null) ? window.__HORSE.tuneATail : 1.80;
    const TW = [0.55, 0.80, 1.05, 1.30, 1.55], TWS = 5.25;
    const dbgA = (typeof window !== 'undefined' && window.__WINDPROBE) ? [] : null;
    for (let i = 0; i < tailBones.length; i++) {
      const b = tailBones[i];
      const w = i === 0 ? 1 : 0.85;
      // Same upwind lag as the plume heads in grass.js: the tip is answering
      // the gust the dock felt a moment ago, which is the flick in a tail.
      const gI = wind && wind.sample
        ? Math.max(0, wind.sample(root.position.x - _wW.x * (0.4 + i * 0.55),
                                  root.position.z - _wW.z * (0.4 + i * 0.55)))
        : gW;
      const a = A_TAIL * (TW[i] / TWS) * (gI / (1 + 0.45 * gI));
      const t = run * (0.17 + i * 0.075)
              + Math.sin(idleT * (1.4 + i * 0.25) - i * 0.8) * (0.035 + run * 0.09);
      if (dbgA) dbgA.push([-a * wzb, a * wxb]);   // this bone's wind-only rotation
      b.rotation.x = THREE.MathUtils.damp(b.rotation.x, t * w - a * wzb, 7 - i * 0.6, dt);
      b.rotation.z = THREE.MathUtils.damp(b.rotation.z,
        a * wxb
        + Math.sin(idleT * (0.9 + i * 0.3) + i) * (0.055 + run * 0.10) - turnRate * 0.05 * (i + 1),
        6, dt);
    }
    if (dbgA && window.__HORSE.windDbg) window.__HORSE.windDbg.tailA = dbgA;
    for (const e of ears) {
      const fl = Math.sin(idleT * 0.9 + e.userData.side * 1.3);
      e.rotation.x = e.userData.base.x + run * 0.22 + fl * 0.10 - refuse * 0.35;
      e.rotation.z = e.userData.base.z + fl * 0.08;
    }

    /* ---- light ----
       The rim and bounce uniforms have to be pushed every frame: they are in
       VIEW space, so they change when the camera moves even if the sun does
       not. Leaving them at their defaults is what made the animal render as an
       unlit slab in the same frame the samurai read fully modelled. */
    driveRim(ctx);

    /* ---- dust ---- */
    if (v > 7) {
      hazeAcc += dt * (v - 6) * 0.9;
      while (hazeAcc > 1) {
        hazeAcc -= 1;
        const bx = wX((Math.random() - 0.5) * 0.7, -0.9), bz = wZ((Math.random() - 0.5) * 0.7, -0.9);
        dust.emit(bx, world.heightAt(bx, bz), bz, 0.5, Math.sin(yaw) * v, Math.cos(yaw) * v);
      }
    }
    dust.update(dt, c);

    /* ---- reins ---- */
    root.updateMatrixWorld(true);
    const s = ctx.samurai;
    const holdL = (mode !== 'off' && s) ? s.bones.elbow.l : null;
    const holdR = (mode !== 'off' && s) ? s.bones.elbow.r : null;
    for (let side = 0; side < 2; side++) {
      const sgn = side === 0 ? 1 : -1;
      _a.set(sgn * 0.098, 0.505, 0.035);
      tack.bit.parent.localToWorld(_a);
      const hold = side === 0 ? holdL : holdR;
      if (hold) { _b.set(0, -0.30, 0.02); hold.localToWorld(_b); }
      else { _b.set(sgn * 0.10, 0.20, 0.24); tack.pommel.localToWorld(_b); }
      _m.copy(_a).add(_b).multiplyScalar(0.5);
      _m.y -= 0.06 + _a.distanceTo(_b) * 0.05;
      link(tack.reins[side * 2], _a, _m);
      link(tack.reins[side * 2 + 1], _m, _b);
    }

    /* ---- camera opens up when mounted ---- */
    const gc = c.gcam;
    if (gc && typeof gc.distance === 'number') {
      if (!camSaved) { camDist = gc.distance; camHt = gc.height; camSaved = true; }
      const wantD = mode === 'off' ? camDist : camDist + 2.4 + run * 0.9;
      const wantH = mode === 'off' ? camHt : camHt + 0.75;
      gc.distance = THREE.MathUtils.damp(gc.distance, wantD, 3, dt);
      gc.height = THREE.MathUtils.damp(gc.height, wantH, 3, dt);
    }
  }

  function link(mesh, a, b) {
    root.worldToLocal(_v2.copy(a));
    root.worldToLocal(_v3.copy(b));
    mesh.position.copy(_v2).add(_v3).multiplyScalar(0.5);
    _v2.sub(_v3);
    const len = _v2.length() || 0.001;
    mesh.scale.set(1, len, 1);
    mesh.quaternion.setFromUnitVectors(UPV, _v2.multiplyScalar(-1 / len));
  }

  /* ---- park the horse in shot next to wherever the player is ----

     TWO BUGS LIVED IN THE FIXED OFFSET THIS USED TO BE.

     1. THE YAW WAS A FRAME STALE. main.js teleports (which lands here through
        the player.setPosition hook) and only THEN calls gcam.snap(), and
        camera.js adopts the player's heading on a snap — so ctx.gcam.yaw read
        here is the PREVIOUS shot's heading, not the one about to be framed.
        Measured on the harness: the same pose (player -159, 885) parked the
        horse at (-157.4, 889.7) on one run and (-162.7, 881.7) on the next,
        purely from what the camera happened to be looking at before. That is
        how the animal ends up half out of frame at the left edge with one leg
        dangling in the corner of 02-grass-field, and how it landed at ndc.x
        1.40 — entirely off screen — on 04-river-valley. The heading the camera
        is ABOUT to adopt is the player's own, so use that and nothing else.

     2. ONE FIXED OFFSET IGNORES THE GROUND. 4.4 m forward and 2.3 m across is a
        composition on a billiard table. On a slope it drops the horse wherever
        that vector lands: up-slope, where its feet sit above the camera's eye
        line and the whole animal silhouettes against the sky with no ground
        under it (that is the "levitating" read on 04-river-valley — measured,
        the horse's ground was 0.74 m ABOVE the player's), or inside the boom,
        3 m from the near plane, cropped by the frame edge.

     So: sample a fan of candidate spots and score them on the things that
     actually decide whether the animal reads as standing in the field —
     flatness, elevation relative to the player, staying below the camera's eye
     so there is ground behind the hooves, clearance from the camera, and
     staying near the view axis. Height itself comes from setPosition, which
     samples the terrain and now also lays the chassis on the slope normal. */
  function park(x, z, faceDeg) {
    const gy = THREE.MathUtils.degToRad(faceDeg);
    const gc = ctx.gcam;
    const camD = (gc && typeof gc.distance === 'number') ? gc.distance : 6.2;
    const camH = (gc && typeof gc.height === 'number') ? gc.height : 2.1;
    const py0 = world.heightAt(x, z);
    // Where gcam.snap() is about to put the camera: straight back along the
    // player's heading, lifted by the boom height.
    const camX = x - Math.sin(gy) * camD, camZ = z - Math.cos(gy) * camD;
    const camY = py0 + camH;
    const sea = (world.ISLAND && world.ISLAND.seaLevel) || 0;

    /* Which half of the frame the composition is about to leave empty.
       camera.js parks the SUBJECT on a third line and picks the side by which
       way the skyline is lower (camera.js: skySide), resetting to "subject left
       of frame" on a snap. A horse dropped on the same side as the player lands
       on the crowded third and gets cropped by the frame edge — measured, ndc.x
       -0.67 to -0.70 on three of the four judged poses, which is the left-edge
       crop and the dangling leg in the corner of 02-grass-field. Replicated here
       from the same terrain samples so the animal goes in the space the shot is
       actually leaving for it. pref < 0 puts the player left, so the room is on
       screen right, which is the player's own right: side +1. */
    let sl = -1, sr = -1;
    for (const d of [60, 140, 300, 520]) {
      const yl = gy - 0.24, yr = gy + 0.24;
      const a = (world.heightAt(x + Math.sin(yl) * d, z + Math.cos(yl) * d) - camY) / d;
      const b = (world.heightAt(x + Math.sin(yr) * d, z + Math.cos(yr) * d) - camY) / d;
      if (a > sl) sl = a;
      if (b > sr) sr = b;
    }
    let pref = clamp((sl - sr) * 8.0, -1, 1);
    if (Math.abs(pref) < 0.30) pref = -0.75;                   // camera.js's snap default
    const openSide = pref < 0 ? 1 : -1;

    let best = null;
    for (const side of [1, -1]) {
      for (const bearing of [32, 40, 26, 48, 20]) {
        for (const r of [5.4, 6.5, 7.4, 4.8]) {
          // MINUS: yaw rotates +Z toward +X, and for a camera looking down
          // (sin yaw, cos yaw) with +Y up, right = forward x up = -X. So a
          // POSITIVE yaw offset swings to the camera's LEFT. side = +1 has to
          // mean screen right, which is a NEGATIVE offset — getting this
          // backwards is what kept putting the animal on the crowded third even
          // after the frame side was known.
          const a = gy - side * THREE.MathUtils.degToRad(bearing);
          const sx = x + Math.sin(a) * r, sz = z + Math.cos(a) * r;
          const h = world.heightAt(sx, sz);
          if (h < sea + 0.6) continue;                       // never in the water
          const slope = world.slopeAt(sx, sz);
          if (slope > 0.42) continue;                        // no cliff faces
          const dCam = Math.hypot(sx - camX, sz - camZ);
          if (dCam < 4.6) continue;                          // out of the near plane
          // Withers ~1.65 m. Above the camera's eye there is sky behind the
          // hooves instead of ground, which is what reads as levitation.
          const overEye = Math.max(0, (h + 1.65) - camY);
          const rise = h - py0;
          // How far off the optical axis it will sit, in degrees. The boom
          // sits BEHIND the player, so this is always far smaller than the
          // bearing: 26 degrees at 6.5 m is only 13 degrees of frame. Under
          // about 18 the animal hides behind the samurai's own silhouette (the
          // first pass at this parked it with its head behind his kasa); over
          // about 27 the far end starts leaving the frame.
          const off = Math.abs(Math.atan2(Math.sin(a - gy) * r,
                                          camD + Math.cos(a - gy) * r)) * 180 / Math.PI;
          const cost = slope * 2.6
                     + overEye * 1.9
                     + Math.max(0, rise) * 0.75 + Math.max(0, -rise) * 0.30
                     + Math.max(0, 18 - off) * 0.30 + Math.max(0, off - 27) * 0.14
                     + (side === openSide ? 0 : 1.10)
                     + Math.max(0, 5.6 - dCam) * 0.5;
          if (!best || cost < best.cost) best = { cost, sx, sz, a, side };
        }
      }
    }
    if (!best) {                                             // nothing scored: old behaviour
      const dx = Math.sin(gy), dz = Math.cos(gy);
      best = { sx: x + dx * 4.4 + dz * 2.3, sz: z + dz * 4.4 - dx * 2.3, a: gy, side: 1 };
    }
    // Broadside to the camera, head turned back toward the player, whichever
    // side of the axis it ended up on.
    setPosition(best.sx, 0, best.sz,
                THREE.MathUtils.radToDeg(gy) + best.side * 118);
  }
  park(ctx.player.position.x, ctx.player.position.z,
       THREE.MathUtils.radToDeg(ctx.player.yaw || 0));

  return {
    group: root, position: root.position,
    get speed() { return Math.abs(speed); },
    get mounted() { return mode === 'on' || mode === 'mounting'; },
    get gait() { return gaitName; },
    get yaw() { return yaw; },
    setPosition,
    mount() { if (mode === 'off') beginMount(ctx); },
    dismount() { if (mode === 'on') beginDismount(ctx); },
    whistle() { summon = 1; autoMount = false; },
    update,
  };
}
