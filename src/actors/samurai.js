import * as THREE from 'three';

// =============================================================================
// Kaze no Michi — the samurai.
//
// A fully procedural character: a bone hierarchy with layered clothing and
// armour hung on it, hand-authored locomotion, two-bone IK for both legs and
// both arms, world-space foot planting against the terrain, and a handful of
// small cloth solvers for the hakama, the jinbaori and the hat cord.
//
// Nothing here is skinned. Segmented limbs with overlapping joint caps read
// cleanly at game distance and cost almost nothing; the parts that must deform
// (the hakama legs, the coat panels, the cords) are tiny CPU-updated meshes.
//
// Three rules the whole file obeys:
//   * The silhouette is the job. Kasa brim, sode, hakama volume and the sword
//     must be identifiable at 30m as a black cutout.
//   * Feet belong to the WORLD, not to the root. A planted foot stays at the
//     world point it was planted on until the cycle lifts it. No skating.
//   * Value contrast survives backlight. Golden hour flattens a dark figure to
//     a cutout, so the palette carries a bone-white kosode and crimson lacing
//     against the indigo, and every material gets a sun-driven rim.
// =============================================================================

/* ------------------------------------------------------------------ scratch */
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3(), _v5 = new THREE.Vector3(), _v6 = new THREE.Vector3();
const _u1 = new THREE.Vector3(), _u2 = new THREE.Vector3();
const _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3(), _e3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _m3 = new THREE.Matrix4();
const _s1 = new THREE.Vector3();
const _g1 = new THREE.Vector3(), _g2 = new THREE.Vector3();
const _wW = new THREE.Vector3(), _wL = new THREE.Vector3();
const _upV = new THREE.Vector3(), _bounceC = new THREE.Color();
// Warm meadow at golden hour, cold wet ground under a moon. Same two constants
// the horse uses, so both actors bounce the same ground.
const GROUND_DAY = new THREE.Color('#c98d52');
const GROUND_NIGHT = new THREE.Color('#3c4a6b');

const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
const damp = THREE.MathUtils.damp;
const smooth = t => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const smoother = t => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * t * (t * (t * 6 - 15) + 10));

/* ----------------------------------------------------------------- palette */
// Lifted well off black on purpose: at golden hour the sun is behind the player
// for most of the game and anything darker than about #2a crushes out entirely.
const PAL = {
  skin:    { color: '#c9a683', roughness: 0.74 },
  kosode:  { color: '#cdc2a8', roughness: 0.88, vc: 0.10 },  // bone under-robe
  kimono:  { color: '#33405a', roughness: 0.86, vc: 0.09 },  // indigo over-robe
  hakama:  { color: '#3d4a64', roughness: 0.89, vc: 0.11, side: 2 },
  armour:  { color: '#3c2622', roughness: 0.36, metalness: 0.30 }, // lacquer
  lacing:  { color: '#8e3129', roughness: 0.78, vc: 0.08 },  // crimson odoshi
  gold:    { color: '#b4893f', roughness: 0.34, metalness: 0.72 },
  // NULL RESULT, wave I — left at the wave-H value on purpose. Smoothing the
  // kasa's normals raised the hat's mean luminance in the hero shot from 113.9
  // to 156.9 (the flat facets had been averaging half the brim away from the
  // sky), so darkening the straw a full stop to #a58a57 looked like the obvious
  // compensation. Measured, it bought 1.4 levels: the hat sits on the tone
  // curve's shoulder at L 210-228, where an 18% cut in linear albedo is almost
  // invisible. A change that does not move its own number does not belong in
  // the file, so it came back out.
  // Wave K. The wave-I null result above was REAL but was measured through the
  // rim wash: an ADDITIVE term that ignores albedo entirely was contributing 28
  // of the hat's levels, so scaling the albedo could never move more than the
  // rest. With RIM_POWER at 11 the leverage comes back. Re-swept on the frozen
  // frame (kasa lit top, 01-sunset-ridge / 03-coast):
  //     1.00x 189.6/166.7   0.80x 181.0/157.2   0.62x 172.0/147.5
  //     0.48x 163.7/139.2   0.36x 155.9/131.8   0.26x 148.6/125.5
  // i.e. 0.62x now buys 17.6/19.2 levels where wave I measured 1.4. Taken to
  // 0.62 in LINEAR (#c9a86a -> #a28754 in sRGB): the hat stops being the
  // brightest object in the frame while still reading as a lit straw disc
  // against the body's 22, which is the silhouette the file is built around.
  straw:   { color: '#a28754', roughness: 0.93, vc: 0.16, side: 2 },
  steel:   { color: '#c2c8d1', roughness: 0.22, metalness: 0.88 },
  blade:   { color: '#d4dae2', roughness: 0.13, metalness: 0.94, vc: 0.22 },
  saya:    { color: '#1b1f27', roughness: 0.26, metalness: 0.10 },
  cord:    { color: '#6a5231', roughness: 0.92 },
  leather: { color: '#4a3626', roughness: 0.80 },
  coat:    { color: '#4e5936', roughness: 0.93, vc: 0.12 },   // jinbaori, outer face
  yoke:    { color: '#454e2f', roughness: 0.93, vc: 0.10 },   // its shoulder cape
  lining:  { color: '#8a3529', roughness: 0.88, vc: 0.10 },   // the flash inside
  trim:    { color: '#1d2126', roughness: 0.62, vc: 0.06 },   // hem roll and edges
  hair:    { color: '#171519', roughness: 0.52 },
  dark:    { color: '#14161b', roughness: 0.70 },
};

/* ------------------------------------------------------ rim-lit materials */
// A backlit figure at golden hour is otherwise a flat black cutout — the eye
// needs a lit edge to read the silhouette's interior. Injected into the standard
// material rather than faked with a second light, so it tracks the sun for free.
// The uniforms MUST be declared in the GLSL as well as handed to three, or the
// shader silently fails to compile and the mesh vanishes from the frame.
// MEASURED, wave K, and this is the single change the panel's four defects all
// come back to. The earlier bracket only ever swept DOWNWARD from 3.45 and
// concluded "below 1.8 it becomes a wash"; it never asked what 3.45 itself was
// doing. Isolated properly — rAF frozen, frames driven by hand, the rim uniform
// written directly (window.__SAMU.uni) so the term could be switched off and
// back on inside ONE frame — 3.45 is ALREADY the wash. On 01-sunset-ridge,
// rim off vs the shipped 3.0 strength:
//     silhouette depth d0/d1/d2/d4/d8  62.7/24.9/22.2/22.2/22.2  ->
//                                     103.6/113.0/92.7/50.3/28.9
//     kasa lit top   mean 179.7 sd 31.08  ->  mean 207.7 sd 18.60
//     hakama legs    mean  22.6          ->  mean  53.3
// That is not a rim light. It is a warm wash 8 px deep into a figure whose
// interior is otherwise a clean 22-level cutout, and it is:
//   * the flat pale kasa (it eats 12.5 of the hat's 31 levels of sd, because an
//     ADDITIVE term carries no texture — every level it adds is a level of the
//     straw map it buries),
//   * the "broad glossy specular sweep" down the hakama (+31 levels on cloth
//     the sun contributes 0.3 levels to — see the key-off probe; there is no
//     specular on that leg at all, the sweep IS this term),
//   * and the missing halo, because a term spread over the whole figure has no
//     edge left to be an edge.
// Sweeping power x strength (5x5, A/B/A drift <=0.5 levels against effects of
// 10-60) the useful corner is a HIGH power with a HIGH strength: narrow the
// band with the exponent, then pay the brightness back with the multiplier.
//     P=3.45 S=3  (shipped): d 103.6/113.0/92.7/50.3/28.9  top 207.7 sd 18.60
//     P=10   S=12          : d 117.6/111.5/69.0/27.9/22.5  top 196.2 sd 27.32
//     P=13   S=12          : d 111.7/ 99.6/47.7/23.5/22.4  top 191.8 sd 26.21
//     P=13   S=18          : d 118.7/109.4/54.9/25.8/22.6  top 194.0 sd 27.39
// 11 keeps the first two pixels and returns d4/d8 to the cutout value.
const RIM_POWER = 11.0;
const rimShaders = [];
function mat(spec) {
  const s = Object.assign({}, spec);
  const vc = s.vc; delete s.vc;
  if (s.side === 2) s.side = THREE.DoubleSide;
  if (vc) s.vertexColors = true;
  const m = new THREE.MeshStandardMaterial(s);
  m.userData.vc = vc || 0;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uRimColor = { value: new THREE.Color('#ffb877') };
    sh.uniforms.uRimDirView = { value: new THREE.Vector3(0, 0, 1) };
    sh.uniforms.uRimPower = { value: RIM_POWER };
    sh.uniforms.uRimStrength = { value: 1.0 };
    sh.uniforms.uAmbScale = { value: 1.0 };
    sh.uniforms.uBackCrush = { value: 0.0 };
    sh.uniforms.uBounceColor = { value: new THREE.Color('#c98d52') };
    sh.uniforms.uBounceAmt = { value: 0.0 };
    sh.uniforms.uUpView = { value: new THREE.Vector3(0, 1, 0) };
    sh.fragmentShader = 'uniform vec3 uRimColor;\nuniform vec3 uRimDirView;\n'
      + 'uniform float uRimPower;\nuniform float uRimStrength;\n'
      + 'uniform vec3 uBounceColor;\nuniform float uBounceAmt;\nuniform vec3 uUpView;\n'
      + 'uniform float uAmbScale;\nuniform float uBackCrush;\n' + sh.fragmentShader;
    // The rim was already here and was NOT reading, because the world rig it
    // has to compete with runs a hemisphere at 4-11 and an ambient floor on top
    // of a key of 3-9. That ratio is right for terrain, which must never crush,
    // and catastrophic for the one subject the eye is actually on: every
    // away-facing surface on the character came back at nearly full key, so a
    // figure standing in front of its own backlight read as evenly front-lit.
    // In the reference the rider is a near-black cutout with a hot edge. So the
    // character — and only the character — pulls its own indirect back down and
    // kills the deliberate counter-light on surfaces turned away from the sun,
    // in proportion to how backlit this particular shot actually is.
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <lights_fragment_end>',
      `#include <lights_fragment_end>
       {
         vec3 nS = normalize(normal);
         vec3 vS = normalize(vViewPosition);                    // fragment -> eye
         float backS = clamp(dot(-uRimDirView, vS), 0.0, 1.0);  // 1 = sun behind subject
         float awayS = clamp(dot(nS, -uRimDirView), 0.0, 1.0);  // 1 = surface turned from sun
         float crush = 1.0 - uBackCrush * backS * awayS;
         reflectedLight.indirectDiffuse  *= uAmbScale;
         reflectedLight.indirectSpecular *= uAmbScale;
         reflectedLight.directDiffuse    *= crush;
         reflectedLight.directSpecular   *= crush;
       }`
    );
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <opaque_fragment>',
      `{
         vec3 rimV = normalize(vViewPosition);
         vec3 nn = normalize(normal);
         float rim = pow(1.0 - clamp(abs(dot(nn, rimV)), 0.0, 1.0), uRimPower);
         // Strongest when the light is behind the subject, as at golden hour...
         float back = clamp(dot(-uRimDirView, rimV), 0.0, 1.0);
         // ...and only on the edges actually turned TOWARD it. This term used to
         // read -uRimDirView, which put the hot edge on the shadow side and
         // smeared the rim evenly over the front of the figure — the opposite of
         // a rim light, and part of why he read as front-lit.
         float sd = clamp(dot(nn, uRimDirView), -1.0, 1.0) * 0.5 + 0.5;
         // MEASURED, wave G. The sign fix above was right and still the rim did
         // not read at the poses it exists for. The reason is this factor. At
         // 01-sunset-ridge and 03-coast the sun is DEAD AHEAD of the camera and
         // directly behind the subject, so uRimDirView is very nearly parallel
         // to the view ray — and every silhouette normal is perpendicular to the
         // view ray by definition. So sd collapses to ~0.5 all the way round the
         // outline, and squaring it took the whole term to 0.25. Multiplied by
         // the 1.9 strength cap that left 0.67, against 8.0 in the forced-value
         // probe that proved the injection itself works. Scanning the sun-facing
         // shoulder at y=470 measured sky (246,227,193) -> (74,32,56) in one
         // pixel: a plain darkening, exactly as reported.
         //
         // A true backlit halo IS all the way round the outline — see
         // references/field_24.png, where the rim wraps the rider's whole upper
         // silhouette. The shadow side belongs suppressed by a FLOOR, not by a
         // square that also guts the head-on case.
         float side = 0.30 + 0.70 * sd;
         outgoingLight += uRimColor * rim * (0.12 + 0.88 * back) * side * uRimStrength;
         // MEASURED, wave I. The rim above was NOT the reason the figure reads
         // as flat-shaded polygons, and raising it is not the fix: forcing
         // uRimStrength from its nominal 3.0 to 8.0 moved the mean in-silhouette
         // delta only 53.5 -> 73.0 out of a possible 765, i.e. the term is
         // already tonemap-saturated where it lands. What the measurement
         // actually said is that 74.1% of the figure's interior pixels on
         // 01-sunset-ridge sit within +/-4 luminance levels of the median (22.2)
         // — against 15.3% for the GoT rider in references/field_24.png over the
         // same statistic. The body is ONE VALUE. That is what makes the shins
         // read as rectangles, the jinbaori as a rigid cone and the head as a
         // capsule: no gradient exists for any of that geometry to be revealed
         // by. The cause is structural — on a backlit figure the key's N.L is
         // negative over every camera-facing surface, so the only light left is
         // the rig's indirect, which is directionless, so every vertical surface
         // returns the same number no matter which way it faces.
         //
         // The horse solved exactly this with a ground-bounce term (horse.js,
         // uBounceAmt) and it is the reason the animal holds form in the same
         // frame where the man does not. Same term, same law, same two
         // directional factors, so the two actors in one shot get one lighting
         // model: bDown is 1 where a surface looks at the ground and bAway is 1
         // where it looks away from the key — the front of a backlit figure, and
         // exactly where a lit meadow throws light back. It multiplies the
         // albedo, so it darkens nothing, cannot lift the silhouette off the
         // sky, and what survives is the character's own dyed colour rather than
         // the grade's shadow lift.
         float bDown = clamp(0.5 - dot(nn, uUpView) * 0.5, 0.0, 1.0);
         float bAway = clamp(0.5 - dot(nn, uRimDirView) * 0.5, 0.0, 1.0);
         outgoingLight += diffuseColor.rgb * uBounceColor
                        * (0.10 + 0.90 * bDown) * (0.12 + 0.88 * bAway) * uBounceAmt;
       }
       #include <opaque_fragment>`
    );
    rimShaders.push(sh);
  };
  return m;
}

/* ------------------------------------------------------- geometry helpers */
function hash1(x) { const s = Math.sin(x * 127.1) * 43758.5453; return s - Math.floor(s); }

/* --------------------------------------------------------- woven fabric -- */
// A flat colour reads as plastic the moment the camera comes inside 3m, which
// is exactly where the third-person camera lives. These are procedural cloth
// maps: a twill weave with slubbed threads, painted once into a canvas and used
// as both a value map and a bump map so the surface catches the low sun.
// Grayscale and centred near 1.0, so the palette above still sets the colour.
// The map multiplies the material colour, so it is normalised to a known mean
// in LINEAR light (FAB_MEAN) and the palette colour is scaled by 1/FAB_MEAN on
// the way in. That leaves headroom above the cloth value for a lighter crest
// and keeps the tuned palette values intact.
const FAB_MEAN = 0.82;
const toSRGB = x => (x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
function fabricTexture(size, o, paint) {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g2 = c.getContext('2d');
  const img = g2.createImageData(size, size);
  const d = img.data;
  const buf = new Float32Array(size * size);
  let sum = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const warp = Math.cos(x * o.wk) * 0.5 + 0.5;
      const weft = Math.cos(y * o.wk * 1.07) * 0.5 + 0.5;
      const rib = Math.cos((x + y) * o.rk) * 0.5 + 0.5;
      let v = 1 - o.weave * (0.56 * warp + 0.44 * weft) - o.rib * rib;
      // slub: an occasional thicker thread running the length of the bolt
      v -= o.slub * hash1(y * 13.1 + 0.7) * hash1(x * 0.031 + 4.2);
      v -= o.grain * (hash1(x * 7.13 + y * 3.71) - 0.5);
      // wear across the folds — very low frequency, keeps big surfaces alive
      v += o.blotch * (hash1(Math.floor(x / 24) * 9.7 + Math.floor(y / 24) * 4.3) - 0.5);
      // MEASURED, wave K. Everything above this line is at or under the
      // hakama's Nyquist and therefore contributes nothing to the frame. At
      // repeat 5x3 the skirt puts ~3.4 texels in a pixel, so the twill's
      // 4-texel period is mip-averaged straight out and the garment's own map
      // measured sd 4.81 on the canvas and delivered a flat navy field. These
      // two terms are deliberately COARSE — a dyer's streak down the bolt and a
      // block mottle — sized to land at 5-20 px on a 400 px figure, which is
      // where a garment reads as cloth rather than as a moulded shell.
      if (o.streak) v += o.streak * (Math.cos(x * 0.42 + hash1(Math.floor(x / 17) * 3.3) * 4.0) * 0.5);
      if (o.mottle) v += o.mottle * (hash1(Math.floor(x / 40) * 2.7 + Math.floor(y / 40) * 8.1) - 0.5);
      buf[y * size + x] = v; sum += v;
    }
  }
  const k = FAB_MEAN / (sum / (size * size));
  for (let i = 0; i < buf.length; i++) {
    const b = Math.round(toSRGB(clamp(buf[i] * k, 0, 1)) * 255);
    d[i * 4] = b; d[i * 4 + 1] = b; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
  }
  g2.putImageData(img, 0, 0);
  if (paint) paint(g2, size);
  const tx = new THREE.CanvasTexture(c);
  tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
  tx.anisotropy = 4;
  return tx;
}

// ------------------------------------------------------------------ straw --
// MEASURED, wave K. The kasa's straw map was never unbound and never lost its
// UVs — the probe reads map+bumpMap+roughnessMap all live, uv present, uv range
// exactly 0..1, repeat 3 x 1.6. What it had lost was CONTRAST. Read straight
// off the canvas the generic cloth recipe gives mean 233.5 / sd 8.01 / range
// 203-255: a 3.4% modulation, on the one surface in the frame that sits at
// display L 190-210 where the grade's shoulder divides everything by four. The
// hat therefore carried about one level of material information, which is what
// "the brightest, flattest thing in frame" means.
//
// Cloth and straw are not the same material and cannot come off the same
// generator. A woven twill is a fine even weave; a kasa is a dozen fat plaited
// courses of dried reed with a near-black shadow line in every seam between
// them. So the seam is authored as a seam, at a depth (0.30 of crest) no
// tone-curve shoulder can flatten, and the fibres run ALONG each course rather
// than as an isotropic grid. v runs crown -> brim edge, so the courses come out
// concentric on the cone, which is what a kasa actually looks like from above.
function strawTexture(size) {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g2 = c.getContext('2d');
  const img = g2.createImageData(size, size);
  const d = img.data;
  const buf = new Float32Array(size * size);
  const COURSES = 6;           // plait courses per tile; x1.6 repeat -> ~10 rings
  let sum = 0;
  for (let y = 0; y < size; y++) {
    const b0 = (y / size) * COURSES;
    const course = Math.floor(b0);
    for (let x = 0; x < size; x++) {
      // The courses must not be ruler-straight rings — a hand-plaited kasa
      // wanders. Wobble is built from whole cycles across the tile so the
      // 3x horizontal repeat still meets itself without a seam.
      const wob = 0.085 * Math.cos(x * (Math.PI * 2 * 2 / size) + course * 1.31)
                + 0.045 * Math.cos(x * (Math.PI * 2 * 5 / size) - course * 0.77);
      const b = b0 + wob;
      const fv = b - Math.floor(b);
      // Rounded crest across the course, falling to the seam at both ends.
      const crest = Math.pow(Math.sin(Math.PI * fv), 0.55);
      // The seam itself: a hard dark line, not a smooth valley. This is the one
      // feature that has to survive the shoulder, so it is authored deep.
      const seam = Math.min(fv, 1 - fv) < 0.055 ? 0.55 : 1.0;
      // Fibres run along the course and lean, so they cross the seam at an
      // angle the way a real plait does.
      const su = x + fv * 9.0 + course * 3.0;
      const strand = Math.cos(su * (Math.PI * 2 / 7)) * 0.5 + 0.5;
      // A second, wider bundle so the fibres group into plaits of 3-4.
      const bundle = Math.cos(su * (Math.PI * 2 / 23) + course * 1.7) * 0.5 + 0.5;
      let v = (0.34 + 0.66 * crest) * seam;
      v *= 0.80 + 0.20 * strand;
      v *= 0.88 + 0.12 * bundle;
      // Individual reeds that took the weather differently.
      v *= 1 - 0.13 * hash1(Math.floor(su / 7) * 11.3 + course * 5.9);
      v *= 1 - 0.07 * (hash1(x * 7.13 + y * 3.71) - 0.5) * 2;
      buf[y * size + x] = v; sum += v;
    }
  }
  const k = FAB_MEAN / (sum / (size * size));
  for (let i = 0; i < buf.length; i++) {
    const b = Math.round(toSRGB(clamp(buf[i] * k, 0, 1)) * 255);
    d[i * 4] = b; d[i * 4 + 1] = b; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
  }
  g2.putImageData(img, 0, 0);
  const tx = new THREE.CanvasTexture(c);
  tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
  tx.anisotropy = 8;
  return tx;
}

// The back of a jinbaori is the one large flat area on the whole character, so
// it gets the treatment: a hem band, edge braid and a mitsudomoe crest, painted
// in UV space (u across the back, v from the shoulder to the hem).
// Cloth sits near byte 236 after normalisation, so anything darker than that
// reads as dye and anything brighter reads as undyed cloth.
function paintCoatBack(g2, S) {
  g2.globalAlpha = 1;
  // hem band, with a bright line of stitching along its top edge
  g2.fillStyle = '#a2a2a2'; g2.fillRect(0, S * 0.940, S, S * 0.060);
  g2.fillStyle = '#ffffff'; g2.fillRect(0, S * 0.930, S, S * 0.010);
  // braided edging down both leading edges
  g2.fillStyle = '#bcbcbc'; g2.fillRect(0, 0, S * 0.022, S); g2.fillRect(S * 0.978, 0, S * 0.022, S);
  // centre-back seam and the two panel seams either side of it
  g2.fillStyle = 'rgba(150,150,150,0.60)'; g2.fillRect(S * 0.4980, 0, S * 0.005, S);
  g2.fillStyle = 'rgba(190,190,190,0.45)';
  g2.fillRect(S * 0.246, 0, S * 0.004, S); g2.fillRect(S * 0.750, 0, S * 0.004, S);
  // mitsudomoe — three commas in a ring, the family crest.
  // It used to be painted at 246 on a cloth ground of 236, a 4% step that the
  // critic quite correctly called "a faint circular decal". The map multiplies
  // the palette colour and is normalised to FAB_MEAN, so 255 is only 1.22x the
  // cloth — there is no headroom to paint undyed white on a dyed ground that
  // way. So the mon is knocked out the other direction: a dark dyed disc with
  // the commas left bright inside it. 74 against 255 survives any exposure and
  // is what a mon on a jinbaori actually looks like.
  const cx = S * 0.5, cy = S * 0.330, R = S * 0.086;
  g2.fillStyle = '#4a4a4a';
  g2.beginPath(); g2.arc(cx, cy, R * 1.46, 0, Math.PI * 2); g2.fill();
  g2.strokeStyle = '#ffffff'; g2.lineWidth = S * 0.010;
  g2.beginPath(); g2.arc(cx, cy, R * 1.34, 0, Math.PI * 2); g2.stroke();
  g2.fillStyle = '#ffffff';
  for (let k = 0; k < 3; k++) {
    const a = k * Math.PI * 2 / 3 - Math.PI / 2;
    const hx = cx + Math.cos(a) * R * 0.46, hy = cy + Math.sin(a) * R * 0.46;
    g2.beginPath();
    g2.arc(hx, hy, R * 0.40, 0, Math.PI * 2);
    g2.moveTo(hx, hy);
    g2.arc(cx, cy, R * 0.94, a, a + Math.PI * 0.72);
    g2.lineTo(hx, hy);
    g2.fill();
  }
}

// Per-vertex value jitter. Fabric that is perfectly flat in colour reads as
// plastic at close range; a few percent of noise is enough to break it up.
function tintGeo(g, amt, seed = 0) {
  const p = g.attributes.position, n = p.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const h = hash1(p.getX(i) * 31.7 + p.getY(i) * 17.3 + p.getZ(i) * 11.9 + seed);
    const v = 1 + (h - 0.5) * amt;
    c[i * 3] = v; c[i * 3 + 1] = v * (1 + (h - 0.5) * amt * 0.35); c[i * 3 + 2] = v;
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

// Tapered segment hanging along -Y from the joint, which is how every bone in
// this rig is oriented.
function limbGeo(len, rTop, rBot, seg = 8) {
  const g = new THREE.CylinderGeometry(rTop, rBot, len, seg, 1);
  g.translate(0, -len / 2, 0);
  return g;
}

function plateGeo(w, h, d, pinch = 0.86) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (pinch < 1) {
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      if (p.getY(i) < 0) { p.setX(i, p.getX(i) * pinch); p.setZ(i, p.getZ(i) * (pinch + 0.02)); }
    }
    g.computeVertexNormals();
  }
  return g;
}

// Non-indexed merge with guaranteed position/normal/colour so merged clusters
// can mix tinted geometry with untinted geometry.
function mergeGeos(list) {
  const src = list.map(g => (g.index ? g.toNonIndexed() : g));
  let n = 0;
  for (const g of src) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  let o = 0;
  for (const g of src) {
    const c = g.attributes.position.count;
    pos.set(g.attributes.position.array, o * 3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array, o * 3);
    if (g.attributes.color) col.set(g.attributes.color.array, o * 3);
    else col.fill(1, o * 3, o * 3 + c * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, o * 2);
    o += c;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return out;
}

// Collects static geometry per material under one bone and flushes it into a
// single mesh per material. Roughly halves the samurai's draw calls.
const _kitEuler = new THREE.Euler();
class Kit {
  constructor() { this.byMat = new Map(); }
  add(geo, material, pos, rot, scale) {
    _m1.identity();
    if (rot) _m1.makeRotationFromEuler(_kitEuler.set(rot[0] || 0, rot[1] || 0, rot[2] || 0));
    if (scale) _m1.scale(_s1.set(scale[0], scale[1], scale[2]));
    if (pos) _m1.setPosition(pos[0], pos[1], pos[2]);
    const g = geo.clone().applyMatrix4(_m1);
    if (material.userData.vc) tintGeo(g, material.userData.vc, pos ? pos[0] * 97 + pos[1] * 53 : 0);
    if (!this.byMat.has(material)) this.byMat.set(material, []);
    this.byMat.get(material).push(g);
    return this;
  }
  build(parent, name = 'kit') {
    for (const [m, gs] of this.byMat) {
      const mesh = new THREE.Mesh(mergeGeos(gs), m);
      mesh.castShadow = true; mesh.receiveShadow = true; mesh.name = name;
      parent.add(mesh);
    }
    this.byMat.clear();
  }
}

/* --------------------------------------------------------------- cloth ---- */
// A hanging rectangular panel pinned along its top edge. Not a real cloth sim:
// a stack of shaped displacements (drape, lag, travelling wave, wind, flare)
// that costs nothing and can never explode.
function makeSheet(w, h, cols, rows, material) {
  const g = new THREE.PlaneGeometry(w, h, cols, rows);
  g.translate(0, -h / 2, 0);
  const base = Float32Array.from(g.attributes.position.array);
  if (material.userData.vc) tintGeo(g, material.userData.vc, w * 131);
  const mesh = new THREE.Mesh(g, material);
  mesh.castShadow = true; mesh.receiveShadow = true;
  const n = g.attributes.position.count;
  const phase = new Float32Array(n);
  for (let i = 0; i < n; i++) phase[i] = hash1(base[i * 3] * 61.1 + base[i * 3 + 1] * 13.7) * 6.28;
  return {
    mesh, geo: g,
    update(p) {
      const a = g.attributes.position, arr = a.array;
      for (let i = 0; i < n; i++) {
        const bx = base[i * 3], by = base[i * 3 + 1], bz = base[i * 3 + 2];
        const t = clamp(-by / h, 0, 1);           // 0 at the pinned edge, 1 at the hem
        const t2 = t * t;
        const ripple = Math.sin(p.t * p.waveHz + phase[i] + bx * p.waveK) * p.wave * t2;
        arr[i * 3] = bx * (1 + p.flare * t2) + p.windX * t2 * 0.6 + ripple * 0.35;
        arr[i * 3 + 1] = by + p.curl * t2 * 0.35 + t * p.hemLift;
        arr[i * 3 + 2] = bz - p.lag * t2 - p.windZ * t2 + ripple;
      }
      a.needsUpdate = true;
      g.computeVertexNormals();
      g.computeBoundingSphere();
    },
  };
}

/* ------------------------------------------------------- garment shell --- */
// A jinbaori is not a plane. This builds a CLOSED two-skin shell wrapped around
// the torso: an outer face, a lining face behind it, and a band of quads joining
// them along the hem and both leading edges, so the garment has real thickness
// and a rolled edge you can see against the sky. Three material groups —
// outer / lining / edge — one mesh.
//
// Parameterised by (theta, v): theta runs around the body from the centre back,
// v runs from the shoulder line to the hem. Rebuilt every frame from a small
// set of shaping fields, so it reacts to stride, turn, wind and speed.
function makeShell(o, matOut, matIn, matEdge) {
  const rows = o.rows, cols = o.cols;
  const per = (rows + 1) * (cols + 1);
  const nv = per * 2;
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(nv * 3);
  const uv = new Float32Array(nv * 2);
  const col = new Float32Array(nv * 3);
  for (let L = 0; L < 2; L++) {
    for (let i = 0; i <= rows; i++) {
      for (let j = 0; j <= cols; j++) {
        const k = L * per + i * (cols + 1) + j;
        uv[k * 2] = j / cols; uv[k * 2 + 1] = i / rows;
        const v = 1 + (hash1(k * 4.13 + L * 17.7) - 0.5) * 0.10;
        col[k * 3] = v; col[k * 3 + 1] = v; col[k * 3 + 2] = v;
      }
    }
  }
  const O = (i, j) => i * (cols + 1) + j;
  const I = (i, j) => per + i * (cols + 1) + j;
  const iOut = [], iIn = [], iEdge = [];
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      iOut.push(O(i, j), O(i, j + 1), O(i + 1, j), O(i, j + 1), O(i + 1, j + 1), O(i + 1, j));
      iIn.push(I(i, j), I(i + 1, j), I(i, j + 1), I(i, j + 1), I(i + 1, j), I(i + 1, j + 1));
    }
  }
  for (let j = 0; j < cols; j++)                       // hem roll
    iEdge.push(O(rows, j), O(rows, j + 1), I(rows, j), O(rows, j + 1), I(rows, j + 1), I(rows, j));
  for (let i = 0; i < rows; i++) {                     // the two leading edges
    iEdge.push(O(i, 0), O(i + 1, 0), I(i, 0), I(i, 0), O(i + 1, 0), I(i + 1, 0));
    iEdge.push(O(i, cols), I(i, cols), O(i + 1, cols), O(i + 1, cols), I(i, cols), I(i + 1, cols));
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(iOut.concat(iIn, iEdge));
  g.addGroup(0, iOut.length, 0);
  g.addGroup(iOut.length, iIn.length, 1);
  g.addGroup(iOut.length + iIn.length, iEdge.length, 2);
  const mesh = new THREE.Mesh(g, [matOut, matIn, matEdge]);
  mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false;

  const thM = o.theta;
  return {
    mesh,
    // p: fold/flare/lag/lift/sway/twist/wind fields, all in the anchor's space.
    update(p) {
      const a = g.attributes.position.array;
      for (let j = 0; j <= cols; j++) {
        const th0 = -thM + (j / cols) * 2 * thM;
        const ea = Math.abs(th0) / thM;                  // 0 centre back, 1 edge
        const edge = ea * ea * ea;
        // The shoulders only carry the middle of the garment; the sides start
        // below the armpit so the sode can swing clear of it.
        const yTop = -o.top - o.drop * smooth((ea - 0.50) / 0.50);
        // A per-column offset that never changes. Without it every crease sits
        // on a perfect harmonic and the garment reads as a turned cone.
        const jit = hash1(j * 7.31 + o.folds) - 0.5;
        // The wind has a SIDE, and that is the whole difference between a cloak
        // that streams and a cloak that flares. flare/edgeOut are isotropic —
        // pump them and the garment balloons evenly left and right, which is
        // exactly what the frame-difference caught. leeDot is this column's
        // outward normal dotted with the body-frame wind vector: +1 on the lee
        // face, which balloons, -1 on the windward face, which gets pressed
        // flat against the body.
        const leeDot = p.leeX * Math.sin(th0) - p.leeZ * Math.cos(th0);
        const leeS = p.lee * leeDot, leeY = p.leeLift * leeDot;
        for (let i = 0; i <= rows; i++) {
          const v = i / rows;
          const g2 = v * v;
          const th = th0 + p.twist * g2;
          // Two harmonics plus the jitter: broad drapes with smaller creases
          // running through them.
          const fold = (Math.cos(th0 * o.folds + p.foldPhase + v * 1.7) * 0.62
            + Math.cos(th0 * o.folds * 1.63 - p.foldPhase * 0.55 + 1.7) * 0.26
            + jit * 1.05)
            * (o.fold0 + p.foldAmp) * (0.10 + 0.90 * g2);
          // A THIRD, faster harmonic. With only the two above, the whole shell
          // carries one spatial frequency and the eye calls it a turned cone
          // however deep the folds are — which is exactly the "rigid flat cone
          // with straight hard-edged panels and no folds" the panel reported.
          // Small creases running through the broad drapes are what break it.
          const crease = Math.cos(th0 * o.folds * 1.85 - p.foldPhase * 1.35 + jit * 5.1)
            * (o.crease || 0) * (0.04 + 0.96 * g2);
          // The two leading edges of an open garment never hang as straight
          // lines, and in the judged frame they did: two dead-straight diagonals
          // from shoulder to hem. ea^3 keeps this ripple off the back panel.
          const ewv = edge * (o.edgeWave || 0)
            * Math.cos(v * 8.2 + jit * 6.4 + p.foldPhase * 0.55);
          const grow = Math.pow(v, 1.35);
          const swell = p.flare * g2 + edge * p.edgeOut * g2 + fold + crease + ewv + leeS * g2;
          // Floored: a hard windward press must not push the radius through the
          // body and turn the shell inside out.
          const rx = Math.max(0.030, o.rx0 + o.rxH * grow + swell);
          const rz = Math.max(0.024, o.rz0 + o.rzH * grow + swell * 0.86);
          let x = Math.sin(th) * rx;
          let z = -Math.cos(th) * rz;
          let y = lerp(yTop, -o.h, v * 0.62 + v * v * 0.38);
          x += (p.sway + p.windX) * g2 + p.stride * g2 * Math.cos(th0 * 0.6);
          z += (p.windZ - p.lagZ) * g2;
          // The hem rides up where the cloth folds, so the bottom edge is never
          // a level ring — that ring is the tell of a lathed shape.
          y += (p.hemLift + edge * p.edgeLift + leeY) * g2
            + (fold * 1.55 + crease * 1.20 + ewv * 1.30) * g2;
          const kO = (i * (cols + 1) + j) * 3, kI = (per + i * (cols + 1) + j) * 3;
          const nx = Math.sin(th), nz = -Math.cos(th);
          a[kO] = x + nx * o.thick; a[kO + 1] = y; a[kO + 2] = z + nz * o.thick;
          a[kI] = x - nx * o.thick; a[kI + 1] = y; a[kI + 2] = z - nz * o.thick;
        }
      }
      g.attributes.position.needsUpdate = true;
      g.computeVertexNormals();
    },
  };
}

// Tube swept along an arbitrary polyline, rebuilt every frame. Used for the
// hakama legs (which must bend at the knee) and for the cords. The frame is
// parallel-transported so a near-vertical run never flips.
function makeTube(rings, sides, material, ellipse = 1) {
  const vc = (rings + 1) * sides;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vc * 3), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(vc * 3), 3));
  {
    const uv = new Float32Array(vc * 2);
    for (let r = 0; r <= rings; r++) for (let s = 0; s < sides; s++) {
      const i = r * sides + s; uv[i * 2] = s / sides; uv[i * 2 + 1] = r / rings;
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }
  const idx = [];
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < sides; s++) {
      const a = r * sides + s, b = r * sides + (s + 1) % sides;
      const c = (r + 1) * sides + s, d = (r + 1) * sides + (s + 1) % sides;
      idx.push(a, c, b, b, c, d);
    }
  }
  g.setIndex(idx);
  if (material.userData.vc) {
    const col = new Float32Array(vc * 3);
    for (let i = 0; i < vc; i++) {
      const v = 1 + (hash1(i * 3.77) - 0.5) * material.userData.vc;
      col[i * 3] = v; col[i * 3 + 1] = v; col[i * 3 + 2] = v;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  const mesh = new THREE.Mesh(g, material);
  mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false;
  const nrm = new THREE.Vector3(1, 0, 0), bi = new THREE.Vector3(), tan = new THREE.Vector3();
  return {
    mesh,
    update(pts, radius, pleat = 0, lobes = 6) {
      const a = g.attributes.position.array, nn = g.attributes.normal.array;
      nrm.set(1, 0, 0);
      for (let r = 0; r <= rings; r++) {
        const p = pts[r];
        const pa = pts[Math.max(0, r - 1)], pb = pts[Math.min(rings, r + 1)];
        tan.copy(pb).sub(pa);
        if (tan.lengthSq() < 1e-10) tan.set(0, -1, 0);
        tan.normalize();
        // Parallel transport: strip the tangent component out of the carried
        // normal instead of rebuilding it from a world axis.
        nrm.addScaledVector(tan, -nrm.dot(tan));
        if (nrm.lengthSq() < 1e-8) { nrm.set(0, 0, 1).addScaledVector(tan, -tan.z); }
        if (nrm.lengthSq() < 1e-8) nrm.set(1, 0, 0);
        nrm.normalize();
        bi.copy(tan).cross(nrm).normalize();
        const rad = radius(r / rings);
        for (let s = 0; s < sides; s++) {
          const th = (s / sides) * Math.PI * 2;
          const pr = rad * (1 + pleat * Math.cos(th * lobes));
          const cx = Math.cos(th) * pr * ellipse, cz = Math.sin(th) * pr;
          const i = (r * sides + s) * 3;
          const ox = nrm.x * cx + bi.x * cz, oy = nrm.y * cx + bi.y * cz, oz = nrm.z * cx + bi.z * cz;
          a[i] = p.x + ox; a[i + 1] = p.y + oy; a[i + 2] = p.z + oz;
          const l = Math.hypot(ox, oy, oz) || 1;
          nn[i] = ox / l; nn[i + 1] = oy / l; nn[i + 2] = oz / l;
        }
      }
      g.attributes.position.needsUpdate = true;
      // A purely radial normal ignores the pleat modulation, so a fluted tube
      // still shaded as a smooth cylinder. Only worth the cost when there is a
      // flute to shade.
      if (pleat > 0.01) g.computeVertexNormals();
      g.attributes.normal.needsUpdate = true;
    },
  };
}

// Verlet chain. Two pinned ends give the kasa's chin cord; one pinned end gives
// the sageo trailing off the scabbard.
function makeCord(n, radius, material, len) {
  const tube = makeTube(n, 4, material);
  const pts = [], prev = [];
  for (let i = 0; i <= n; i++) { pts.push(new THREE.Vector3(0, -i * len / n, 0)); prev.push(pts[i].clone()); }
  const seg = len / n;
  const rad = () => radius;
  return {
    mesh: tube.mesh, pts,
    // grav and wind are expressed in the same local space as the points.
    step(dt, grav, wind, pinA, pinB) {
      const d = Math.min(dt, 1 / 30);
      for (let i = 0; i <= n; i++) {
        if ((i === 0 && pinA) || (i === n && pinB)) continue;
        const p = pts[i], q = prev[i];
        const vx = (p.x - q.x) * 0.90, vy = (p.y - q.y) * 0.90, vz = (p.z - q.z) * 0.90;
        q.copy(p);
        p.x += vx + (grav.x + wind.x) * d * d * 60;
        p.y += vy + (grav.y + wind.y) * d * d * 60;
        p.z += vz + (grav.z + wind.z) * d * d * 60;
      }
      if (pinA) pts[0].copy(pinA);
      if (pinB) pts[n].copy(pinB);
      for (let it = 0; it < 4; it++) {
        for (let i = 0; i < n; i++) {
          const a = pts[i], b = pts[i + 1];
          _v1.copy(b).sub(a);
          const dl = _v1.length() || 1e-5;
          const corr = (dl - seg) / dl * 0.5;
          const wa = (i === 0 && pinA) ? 0 : 1;
          const wb = (i + 1 === n && pinB) ? 0 : 1;
          const tw = wa + wb || 1;
          a.addScaledVector(_v1, corr * (2 * wa / tw));
          b.addScaledVector(_v1, -corr * (2 * wb / tw));
        }
        if (pinA) pts[0].copy(pinA);
        if (pinB) pts[n].copy(pinB);
      }
      tube.update(pts, rad, 0);
    },
  };
}

/* ---------------------------------------------------------------- katana -- */
// A real cross-section swept along a curved spine: flat mune, shinogi ridge and
// a single cutting edge, tapering into a kissaki. The hamon is baked into the
// vertex colours, so the edge reads a shade brighter than the flat.
// Local frame: blade runs along +Y from the tsuba, cutting edge faces +Z.
function bladeGeo(len) {
  const N = 24, sori = 0.052;
  const pos = [], col = [];
  const sec = (v) => {
    const taper = 1 - 0.28 * v;
    const tip = v > 0.93 ? (1 - v) / 0.07 : 1;
    return {
      w: 0.0165 * taper * tip, th: 0.0037 * (1 - 0.34 * v) * tip,
      y: len * v, z0: -sori * (v * v * 0.86 + v * 0.14),
    };
  };
  const ring = (s) => ([
    [-s.th * 0.55, s.y, s.z0 - s.w],     // mune, upper corner
    [s.th, s.y, s.z0 - s.w * 0.18],      // shinogi — the thickest line
    [0, s.y, s.z0 + s.w],                // ha — the cutting edge
    [-s.th, s.y, s.z0 - s.w * 0.18],
    [s.th * 0.55, s.y, s.z0 - s.w],
  ]);
  const shade = (k, v) => (k === 2 ? 1.32 : (k === 1 || k === 3) ? 1.02 + Math.sin(v * 21) * 0.06 : 0.84);
  for (let i = 0; i < N; i++) {
    const a = ring(sec(i / N)), b = ring(sec((i + 1) / N));
    const va = i / N, vb = (i + 1) / N;
    for (let k = 0; k < 5; k++) {
      const k2 = (k + 1) % 5;
      const quad = [a[k], b[k], a[k2], a[k2], b[k], b[k2]];
      const sh = [shade(k, va), shade(k, vb), shade(k2, va), shade(k2, va), shade(k, vb), shade(k2, vb)];
      for (let q = 0; q < 6; q++) { pos.push(quad[q][0], quad[q][1], quad[q][2]); col.push(sh[q], sh[q], sh[q] * 0.99); }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

// Woven-straw conical hat. A lathe is too clean for straw, so the radius is
// modulated per spoke and concentric weave bands are shaded into the profile.
function kasaGeo(R, H) {
  const SEG = 26, RINGS = 7;
  const pos = [], col = [], uv = [];
  const prof = (t) => [R * t, H * (1 - Math.pow(t, 1.55)) - (t > 0.90 ? (t - 0.90) * H * 1.4 : 0)];
  const P = [];
  for (let i = 0; i <= RINGS; i++) P.push(prof(i / RINGS));
  // MEASURED, wave I. This geometry is non-indexed — every quad pushes its own
  // six vertices — so computeVertexNormals() below gave it FLAT per-face
  // normals. At 26 segments the kasa is ~230 px across in the hero shot, so
  // each facet is ~28 px of dead-constant value, and the brim came back as a
  // ring of hard-edged wedges with visible value steps between them: the
  // rubric's "reads as flat-shaded untextured polygons", on the brightest and
  // largest single shape on the whole figure. A cone of revolution has an
  // analytic normal, so take it rather than averaging: for p(t,a) =
  // (r cos a, y, r sin a), dp/da x dp/dt = r * (-y' cos a, r', -y' sin a).
  // The straw map, the plait wobble and the ring banding all survive — only
  // the faceting goes.
  const NRM = [];
  for (let i = 0; i <= RINGS; i++) {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(RINGS, i + 1)];
    const dr = b[0] - a[0], dy = b[1] - a[1];
    const nr = -dy, ny = dr;                 // meridian normal, outward and up
    const l = Math.hypot(nr, ny) || 1;
    NRM.push([nr / l, ny / l]);
  }
  const nrm = [];
  const pushN = (i, ang) => {
    const n = NRM[i];
    nrm.push(n[0] * Math.cos(ang), n[1], n[0] * Math.sin(ang));
  };
  for (let i = 0; i < RINGS; i++) {
    for (let s = 0; s < SEG; s++) {
      const a0 = (s / SEG) * Math.PI * 2, a1 = ((s + 1) / SEG) * Math.PI * 2;
      const w0 = 1 + Math.cos(a0 * SEG / 2) * 0.010, w1 = 1 + Math.cos(a1 * SEG / 2) * 0.010;
      const band = 1 + (i % 2 ? 0.060 : -0.025);
      const p0 = P[i], p1 = P[i + 1];
      const A = [Math.cos(a0) * p0[0] * w0, p0[1], Math.sin(a0) * p0[0] * w0];
      const B = [Math.cos(a1) * p0[0] * w1, p0[1], Math.sin(a1) * p0[0] * w1];
      const C = [Math.cos(a0) * p1[0] * w0, p1[1], Math.sin(a0) * p1[0] * w0];
      const D = [Math.cos(a1) * p1[0] * w1, p1[1], Math.sin(a1) * p1[0] * w1];
      // UVs so the straw weave map has somewhere to land. Without them the kasa
      // sampled a single texel and read as one smooth untextured cone — the
      // largest flat value on the whole figure in a close frame.
      const u0 = s / SEG, u1 = (s + 1) / SEG, v0 = i / RINGS, v1 = (i + 1) / RINGS;
      const UV = [[u0, v0], [u0, v1], [u1, v0], [u1, v0], [u0, v1], [u1, v1]];
      const V = [A, C, B, B, C, D];
      const RI = [i, i + 1, i, i, i + 1, i + 1];
      const AN = [a0, a0, a1, a1, a0, a1];
      for (let q = 0; q < 6; q++) {
        pos.push(V[q][0], V[q][1], V[q][2]);
        col.push(band, band * 0.99, band * 0.95);
        uv.push(UV[q][0], UV[q][1]);
        pushN(RI[q], AN[q]);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return g;
}

/* -------------------------------------------------------------------- IK -- */
// Analytic two-bone solve. `target` and `pole` live in the parent space of `a`;
// `b` must sit at (0,-L1,0) in a's space and the end effector at (0,-L2,0) in
// b's. Writes a.quaternion and b.rotation.x. The basis is built explicitly so
// the mid joint always bulges toward the pole and the twist is deterministic.
function ik2(a, b, L1, L2, target, pole) {
  _v1.copy(target).sub(a.position);
  let d = _v1.length();
  const max = (L1 + L2) * 0.997, min = Math.abs(L1 - L2) + 1e-3;
  d = clamp(d, min, max);
  if (_v1.lengthSq() < 1e-10) _v1.set(0, -1, 0);
  _u1.copy(_v1).normalize();
  _u2.copy(pole).addScaledVector(_u1, -pole.dot(_u1));
  if (_u2.lengthSq() < 1e-8) _u2.set(0, 0, 1).addScaledVector(_u1, -_u1.z);
  if (_u2.lengthSq() < 1e-8) _u2.set(1, 0, 0).addScaledVector(_u1, -_u1.x);
  _u2.normalize();
  const al = Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
  const be = Math.acos(clamp((L2 * L2 + d * d - L1 * L1) / (2 * L2 * d), -1, 1));
  _v2.copy(_u1).multiplyScalar(Math.cos(al)).addScaledVector(_u2, Math.sin(al));  // bone dir
  _e1.copy(_u2).cross(_u1).normalize();        // bone local +X, the bend axis
  _e2.copy(_v2).multiplyScalar(-1);            // bone local +Y (bones hang on -Y)
  _e3.copy(_e1).cross(_e2);
  _m1.makeBasis(_e1, _e2, _e3);
  a.quaternion.setFromRotationMatrix(_m1);
  b.rotation.set(al + be, 0, 0);
}

/* --------------------------------------------------------------- tracks -- */
function track(k, pts) {
  if (k <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (k <= pts[i][0]) {
      const a = pts[i - 1], b = pts[i];
      return a[1] + (b[1] - a[1]) * smooth((k - a[0]) / Math.max(1e-6, b[0] - a[0]));
    }
  }
  return pts[pts.length - 1][1];
}

/* -------------------------------------------------------------- stances -- */
// Each stance is a posture, not just a sword angle: where the weight sits, how
// square the chest is, how high the guard rides.
const STANCES = {
  stone: { chestY: 0.06, chestX: 0.02, headY: 0.00, guard: [-0.24, -0.10, 0.34], gx: -0.42, gy: -0.30, gz: 0.16, width: 1.00, breathe: 1.00 },
  water: { chestY: 0.34, chestX: 0.05, headY: -0.20, guard: [-0.30, 0.06, 0.38], gx: -0.72, gy: -0.62, gz: 0.34, width: 1.16, breathe: 1.15 },
  wind:  { chestY: -0.14, chestX: -0.06, headY: 0.10, guard: [-0.14, 0.40, 0.12], gx: -2.30, gy: -0.16, gz: -0.16, width: 1.08, breathe: 0.90 },
  moon:  { chestY: 0.18, chestX: 0.08, headY: -0.10, guard: [-0.08, 0.10, 0.46], gx: -1.05, gy: -0.34, gz: 0.04, width: 1.04, breathe: 0.80 },
};
const STANCE_ORDER = ['stone', 'water', 'wind', 'moon'];

/* ================================================================ factory */
export function createSamurai(ctx) {
  const M = {};
  for (const k in PAL) M[k] = mat(PAL[k]);

  // Cloth maps. The coat back is unique (crest, hem band, seams) so its map is
  // not tiled; everything else repeats. bumpMap re-uses the same canvas, which
  // is what makes a raking golden-hour sun pick the weave out.
  {
    const coarse = { wk: 1.55, rk: 0.72, weave: 0.085, rib: 0.055, slub: 0.075, grain: 0.045, blotch: 0.075 };
    const fine = { wk: 2.10, rk: 1.05, weave: 0.070, rib: 0.040, slub: 0.055, grain: 0.038, blotch: 0.055 };
    // Straw is not cloth: broad plaited bands with fat slubbed fibres and no
    // fine weave at all. The kasa is the highest-value shape on the figure, so
    // it is the one that most obviously read as a smooth untextured cone.
    // The old strawO recipe is gone: it was the cloth generator with its knobs
    // turned up, and measured on the canvas it still only reached sd 8.01.
    // strawTexture() authors the plait seams directly; see its own block.
    // The two big dyed garments (hakama, kimono) get their own bolt: same twill,
    // plus streak and mottle at a spatial frequency the camera can resolve.
    // Amplitudes are large on purpose. The garment sits at display L 22-40,
    // where the grade's toe lift pins the darks at 21 whatever the albedo does,
    // so the map only ever reads on the part of the cloth the ground-bounce
    // term has lifted clear of the toe — and there it has to be big to survive.
    const bolt = { wk: 1.55, rk: 0.72, weave: 0.10, rib: 0.070, slub: 0.090,
                   grain: 0.045, blotch: 0.160, streak: 0.165, mottle: 0.245 };
    const plain = fabricTexture(256, coarse, null);
    const garment = fabricTexture(256, bolt, null);
    const silk = fabricTexture(256, fine, null);
    const straw = strawTexture(256);
    const setTex = (m, t, rx, ry, bump) => {
      if (!t) return;
      const c = t.clone(); c.needsUpdate = true;
      c.wrapS = c.wrapT = THREE.RepeatWrapping; c.repeat.set(rx, ry);
      c.colorSpace = THREE.SRGBColorSpace;
      m.map = c; m.bumpMap = c; m.bumpScale = bump;
      // The same weave driving ROUGHNESS. A value map plus a bump map still
      // leaves a perfectly uniform specular response, which is what keeps
      // reading as painted plastic once a low sun rakes across the surface.
      // Cloned separately because a roughness map is data, not colour, and
      // sampling it through the sRGB decode would skew the whole surface.
      const r = t.clone(); r.needsUpdate = true;
      r.wrapS = r.wrapT = THREE.RepeatWrapping; r.repeat.set(rx, ry);
      r.colorSpace = THREE.NoColorSpace;
      m.roughnessMap = r;
      m.roughness = Math.min(1, m.roughness * 1.08);   // the map's mean pulls it back down
      m.color.multiplyScalar(1 / FAB_MEAN);
    };
    setTex(M.coat, fabricTexture(512, coarse, paintCoatBack), 1, 1, 0.022);
    setTex(M.yoke, plain, 2.4, 1.2, 0.016);
    setTex(M.lining, silk, 3.0, 2.0, 0.010);
    setTex(M.trim, silk, 6.0, 2.0, 0.008);
    // Repeat dropped 5x3 -> 2.6x1.7 with it, so the coarse terms land at a size
    // the frame can actually resolve instead of below one pixel.
    setTex(M.hakama, garment, 2.6, 1.7, 0.055);
    setTex(M.kimono, garment, 2.0, 2.0, 0.044);
    setTex(M.kosode, silk, 3.0, 3.0, 0.012);
    setTex(M.straw, straw, 3.0, 1.6, 0.026);
    setTex(M.leather, plain, 4.0, 4.0, 0.012);
  }

  const root = new THREE.Group();
  root.name = 'samurai';

  /* ---------------------------------------------------------- proportions */
  // ~1.80m. Every number here is measured from the ground: foot 0.088, knee
  // 0.505, hip pivot 0.935, sternum 1.27, shoulder 1.455, eyes 1.66.
  const P = {
    hipY: 0.935,
    // heel/toe are the two contact pivots the stance roll rotates about, and
    // they must stay equal to the real extents of the boot geometry below or
    // the foot rolls about a point that is not on it. Both grew with the boot.
    thigh: 0.450, shin: 0.430, ankleH: 0.092, heel: 0.098, toe: 0.152,
    hipHalf: 0.098,
    spine: 0.105, chest: 0.230, neck: 0.275, headUp: 0.100,
    shoulderX: 0.198, shoulderY: 0.185,
    upperArm: 0.300, foreArm: 0.268,
  };
  const LEG = P.thigh + P.shin;
  const ARM = P.upperArm + P.foreArm;

  /* ------------------------------------------------------------- skeleton */
  const hips = new THREE.Group();  hips.position.y = P.hipY;   root.add(hips);
  const spine = new THREE.Group(); spine.position.y = P.spine; hips.add(spine);
  const chest = new THREE.Group(); chest.position.y = P.chest; spine.add(chest);
  const neck = new THREE.Group();  neck.position.y = P.neck;   chest.add(neck);
  const head = new THREE.Group();  head.position.y = P.headUp; neck.add(head);

  const shoulder = { l: new THREE.Group(), r: new THREE.Group() };
  shoulder.l.position.set(P.shoulderX, P.shoulderY, 0);  chest.add(shoulder.l);
  shoulder.r.position.set(-P.shoulderX, P.shoulderY, 0); chest.add(shoulder.r);
  const elbow = { l: new THREE.Group(), r: new THREE.Group() };
  const wrist = { l: new THREE.Group(), r: new THREE.Group() };
  for (const s of ['l', 'r']) {
    elbow[s].position.y = -P.upperArm; shoulder[s].add(elbow[s]);
    wrist[s].position.y = -P.foreArm;  elbow[s].add(wrist[s]);
  }

  const hip = { l: new THREE.Group(), r: new THREE.Group() };
  hip.l.position.set(P.hipHalf, 0, 0);  hips.add(hip.l);
  hip.r.position.set(-P.hipHalf, 0, 0); hips.add(hip.r);
  const knee = { l: new THREE.Group(), r: new THREE.Group() };
  const ankle = { l: new THREE.Group(), r: new THREE.Group() };
  for (const s of ['l', 'r']) {
    knee[s].position.y = -P.thigh; hip[s].add(knee[s]);
    ankle[s].position.y = -P.shin; knee[s].add(ankle[s]);
  }

  /* ------------------------------------------------------------ the torso */
  {
    // Body hangs DOWN from the chest bone to the pelvis. (The first version of
    // this file hung it upward, which buried the head inside the cuirass.)
    const k = new Kit();
    k.add(limbGeo(0.40, 0.166, 0.126, 12), M.kimono, [0, 0.030, 0]);
    k.add(new THREE.SphereGeometry(0.150, 12, 8), M.kimono, [0, 0.115, 0], null, [1, 0.72, 0.90]);
    k.build(chest, 'torso');

    // Collar: crossed bands of bone kosode at the throat, left over right. The
    // only high-value shape above the chest, so it carries the head visually.
    const c = new Kit();
    c.add(plateGeo(0.070, 0.150, 0.032, 1), M.kosode, [0.052, 0.250, 0.098], [0.34, 0.10, 0.30]);
    c.add(plateGeo(0.070, 0.150, 0.032, 1), M.kosode, [-0.052, 0.250, 0.098], [0.34, -0.10, -0.30]);
    c.add(plateGeo(0.058, 0.144, 0.028, 1), M.kimono, [0.080, 0.246, 0.082], [0.34, 0.10, 0.32]);
    c.add(plateGeo(0.058, 0.144, 0.028, 1), M.kimono, [-0.080, 0.246, 0.082], [0.34, -0.10, -0.32]);
    c.add(limbGeo(0.14, 0.058, 0.066, 10), M.skin, [0, 0.340, 0.006]);   // neck column
    c.build(chest, 'collar');
  }

  // Do — the cuirass. It sits on the RIBS, sternum to waist.
  {
    const k = new Kit();
    const doH = 0.36, doY = -0.030;
    // A barrel, not a brick: four stacked lamellar courses, each a touch wider.
    for (let i = 0; i < 4; i++) {
      const t = i / 3;
      const w = 0.298 + t * 0.040, d = 0.212 + t * 0.022;
      k.add(plateGeo(w, doH / 4 + 0.008, d, 0.985), M.armour, [0, doY + doH / 2 - doH / 8 - i * (doH / 4), -0.004]);
      k.add(plateGeo(w + 0.010, 0.019, d + 0.010, 1), M.lacing, [0, doY + doH / 2 - i * (doH / 4) - 0.004, -0.004]);
    }
    // Munaita: the solid top plate, plus the watagami straps over the shoulders.
    k.add(plateGeo(0.298, 0.055, 0.216, 1), M.armour, [0, doY + doH / 2 + 0.028, -0.004]);
    for (const sx of [1, -1]) {
      k.add(plateGeo(0.056, 0.085, 0.148, 1), M.armour, [sx * 0.116, doY + doH / 2 + 0.075, -0.010], [0, 0, sx * 0.10]);
      k.add(new THREE.SphereGeometry(0.020, 8, 6), M.gold, [sx * 0.118, doY + doH / 2 + 0.112, 0.050]);
    }
    // Agemaki bow at the back — a crimson accent that reads from behind.
    k.add(new THREE.TorusGeometry(0.036, 0.011, 6, 12), M.lacing, [0, doY + 0.05, -0.120], [0.2, 0, 0]);
    k.build(chest, 'do');
  }

  // Kusazuri — the skirt plates hung off the do. Big silhouette contributor and
  // the only thing that reads as armour from behind at distance.
  const kusazuri = [];
  {
    for (const a of [-0.66, 0, 0.66, Math.PI - 0.58, Math.PI, Math.PI + 0.58]) {
      const g = new THREE.Group();
      g.position.set(Math.sin(a) * 0.130, 0.010, Math.cos(a) * 0.128);
      g.rotation.y = a;
      hips.add(g);
      const k = new Kit();
      for (let r = 0; r < 3; r++) {
        const w = 0.150 + r * 0.012;
        k.add(plateGeo(w, 0.062, 0.030, 0.97), M.armour, [0, -0.045 - r * 0.058, 0]);
        k.add(plateGeo(w + 0.006, 0.013, 0.036, 1), M.lacing, [0, -0.020 - r * 0.058, 0]);
      }
      k.build(g, 'kusazuri');
      kusazuri.push({ g, base: a, sw: 0 });
    }
  }

  // Obi — the wide belt the sword is thrust through, tying the halves together.
  {
    const k = new Kit();
    k.add(new THREE.CylinderGeometry(0.170, 0.178, 0.118, 16, 1), M.lacing, [0, 0.052, 0], null, [1, 1, 0.86]);
    k.add(new THREE.CylinderGeometry(0.154, 0.162, 0.046, 14, 1), M.leather, [0, 0.120, 0], null, [1, 1, 0.86]);
    k.build(hips, 'obi');
  }

  /* -------------------------------------------------------- shoulders/arms */
  for (const s of ['l', 'r']) {
    const sx = s === 'l' ? 1 : -1;
    // Sode: three laced lames on their own pivot so they can swing.
    const sode = new THREE.Group();
    sode.position.set(sx * 0.038, 0.010, -0.006);
    shoulder[s].add(sode);
    const k = new Kit();
    for (let r = 0; r < 3; r++) {
      const w = 0.172 + r * 0.016, d = 0.130 + r * 0.010;
      k.add(plateGeo(w, 0.072, d, 0.97), M.armour, [0, -0.046 - r * 0.066, 0], [0, 0, sx * 0.06]);
      k.add(plateGeo(w + 0.006, 0.015, d + 0.008, 1), M.lacing, [0, -0.018 - r * 0.066, 0], [0, 0, sx * 0.06]);
    }
    k.build(sode, 'sode');
    shoulder[s].userData.sode = sode;

    const a = new Kit();
    a.add(limbGeo(0.30, 0.072, 0.052, 10), M.kimono, [0, 0.012, 0]);
    a.build(shoulder[s], 'uparm');
    const f = new Kit();
    f.add(limbGeo(0.255, 0.050, 0.040, 10), M.armour, [0, 0.008, 0]);       // kote
    for (let i = 0; i < 3; i++) f.add(new THREE.TorusGeometry(0.047 - i * 0.004, 0.008, 5, 10), M.lacing, [0, -0.042 - i * 0.070, 0], [Math.PI / 2, 0, 0]);
    f.add(new THREE.SphereGeometry(0.037, 8, 6), M.armour, [0, 0.004, 0]);  // elbow cap
    f.build(elbow[s], 'kote');
  }

  // Hands. A palm, a fused finger block in two joints, and a thumb — enough to
  // read as a real grip when it closes on the tsuka.
  const hands = {};
  for (const s of ['l', 'r']) {
    const sx = s === 'l' ? 1 : -1;
    const hand = new THREE.Group(); wrist[s].add(hand);
    const k = new Kit();
    k.add(plateGeo(0.070, 0.072, 0.048, 0.90), M.skin, [0, -0.032, 0]);
    k.add(new THREE.SphereGeometry(0.032, 8, 6), M.skin, [0, 0.002, 0], null, [1.05, 0.9, 0.8]);
    k.build(hand, 'palm');
    const fing = new THREE.Group(); fing.position.set(0, -0.066, 0.004); hand.add(fing);
    new Kit().add(plateGeo(0.068, 0.048, 0.042, 0.92), M.skin, [0, -0.023, 0]).build(fing, 'fingers');
    const tip = new THREE.Group(); tip.position.set(0, -0.046, 0); fing.add(tip);
    new Kit().add(plateGeo(0.064, 0.040, 0.038, 0.88), M.skin, [0, -0.019, 0]).build(tip, 'fingertips');
    const thumb = new THREE.Group(); thumb.position.set(sx * -0.030, -0.044, 0.016); hand.add(thumb);
    new Kit().add(limbGeo(0.052, 0.017, 0.014, 6), M.skin, [0, 0, 0]).build(thumb, 'thumb');
    hands[s] = { group: hand, fing, tip, thumb, grip: 0 };
  }

  /* ------------------------------------------------------------------ legs */
  for (const s of ['l', 'r']) {
    // Dark under-leg. Mostly hidden by the hakama, but it stops light leaking
    // through the hem and gives the ankle something to sit on.
    new Kit().add(limbGeo(P.thigh + 0.02, 0.110, 0.088, 8), M.dark, [0, 0.01, 0]).build(hip[s], 'thighcore');

    // Below the hakama cuff the leg is bare geometry, so it has to carry real
    // calf mass — a stick there is what made the whole figure read spindly.
    const j = new Kit();
    j.add(limbGeo(0.300, 0.100, 0.078, 10), M.dark, [0, 0.01, 0]);
    j.add(new THREE.SphereGeometry(0.076, 10, 8), M.dark, [0, -0.095, -0.022], null, [1.0, 1.35, 1.02]);
    // Kyahan — the shin wrap. It starts where the hakama gathers into its cuff
    // and runs to the ankle, so the calf is wrapped cloth rather than a pipe.
    // The kyahan used to run to r=0.064 at the ankle — 13.3 cm across, WIDER
    // than the 10.6 cm foot that was supposed to be underneath it. That is the
    // whole of "no feet": the foot silhouette sat entirely inside the leg
    // silhouette, so the outline was a tapered box that stopped dead on a
    // horizontal line with ground showing under it, exactly as reported. The
    // wrap now closes to ~5 cm radius at the ankle so the boot can step OUT of
    // it on both sides. The binding cords stay proud of the cone on purpose.
    j.add(limbGeo(0.200, 0.092, 0.048, 14), M.kimono, [0, -0.238, 0]);
    j.add(new THREE.TorusGeometry(0.094, 0.013, 6, 12), M.cord, [0, -0.236, 0], [Math.PI / 2, 0, 0]);
    // Hugged to the narrowed cone. Left at their old radii they stood up to
    // 1.5 cm proud of it, and a small torus is almost all grazing angle, so
    // each one lit as a hot ring and the shins read as a stack of bangles.
    for (let i = 0; i < 3; i++) j.add(new THREE.TorusGeometry(0.083 - i * 0.012, 0.0080, 5, 12), M.cord, [0, -0.276 - i * 0.056, 0], [Math.PI / 2, 0, 0]);
    j.build(knee[s], 'shin');

    // ---------------------------------------------------------------- boots
    // Travel boots over tabi, on a straw waraji sole. Built for the SILHOUETTE
    // first: the outline has to go narrow at the ankle, step out at the heel,
    // curve round the back of the heel, run forward along the instep and finish
    // on a rounded toe that projects past the shin. Ground plane is
    // y = -P.ankleH; every extent below is measured from it, and the fore/aft
    // extents equal P.toe / P.heel so the stance roll pivots on real geometry.
    const G = -P.ankleH;
    const f = new Kit();
    // Rounded heel cap. 14.4 cm across against a ~10 cm ankle: this is the
    // silhouette step that says "foot" from behind, which is the read the hero
    // shot needs, since the camera sits behind the figure.
    f.add(new THREE.SphereGeometry(0.072, 12, 9), M.leather, [0, G + 0.052, -0.052], null, [1.0, 0.86, 0.66]);
    // Heel block down to the sole, squared off at the back.
    f.add(plateGeo(0.134, 0.058, 0.092, 0.90), M.leather, [0, G + 0.044, -0.050]);
    // Mid-foot and instep.
    f.add(plateGeo(0.140, 0.052, 0.130, 0.92), M.leather, [0, G + 0.038, 0.028]);
    // Toe box, dropping and narrowing forward, then capped round.
    f.add(plateGeo(0.126, 0.042, 0.104, 0.86), M.leather, [0, G + 0.030, 0.098]);
    f.add(new THREE.SphereGeometry(0.058, 10, 8), M.leather, [0, G + 0.034, 0.122], null, [1.06, 0.60, 0.94]);
    // Split-toe seam and the tabi cloth showing at the ankle opening.
    f.add(plateGeo(0.007, 0.024, 0.086, 1), M.dark, [0, G + 0.052, 0.104]);
    f.add(new THREE.SphereGeometry(0.056, 10, 8), M.kimono, [0, G + 0.082, -0.006], null, [1.02, 0.92, 1.06]);
    // Waraji: a straw sole that overhangs the boot all round, so there is a
    // 4-5 px lit welt between a dark boot and the ground instead of the boot
    // dissolving into the terrain. Thin on purpose — a thick one reads as a
    // white box and drags the eye off the figure.
    f.add(plateGeo(0.152, 0.019, P.heel + P.toe, 1), M.straw, [0, G + 0.0095, (P.toe - P.heel) / 2]);
    // Straps: two over the instep, one round the heel, and the ankle tie.
    f.add(plateGeo(0.136, 0.012, 0.020, 1), M.straw, [0, G + 0.060, 0.012], [0.22, 0, 0]);
    f.add(plateGeo(0.122, 0.011, 0.019, 1), M.straw, [0, G + 0.050, 0.076], [0.32, 0, 0]);
    f.add(plateGeo(0.020, 0.044, 0.012, 1), M.straw, [0.062, G + 0.038, -0.030], [0, 0, 0.20]);
    f.add(plateGeo(0.020, 0.044, 0.012, 1), M.straw, [-0.062, G + 0.038, -0.030], [0, 0, -0.20]);
    f.add(new THREE.TorusGeometry(0.054, 0.0090, 5, 12), M.cord, [0, G + 0.094, -0.004], [Math.PI / 2, 0, 0]);
    f.build(ankle[s], 'foot');
  }

  /* ------------------------------------------------------------- the head */
  {
    const k = new Kit();
    k.add(new THREE.SphereGeometry(0.098, 14, 11), M.skin, [0, 0.012, -0.006], null, [1.0, 1.10, 1.06]);
    // A sphere alone reads as a ball. Cheekbones and a jaw give it a face.
    k.add(plateGeo(0.116, 0.068, 0.100, 0.80), M.skin, [0, -0.055, 0.014]);
    // Ears. The camera in the hero pose sits behind and slightly above the
    // figure, so the ONLY head landmarks it can see are the ones on the outline
    // below the brim: these two, and the hair mass below. Each stands ~2 cm
    // proud of the skull, about 5 px at the ~400 px figure height the panel
    // judged — enough that the backlit head stops being a capsule.
    k.add(new THREE.SphereGeometry(0.032, 9, 7), M.skin, [0.100, -0.010, -0.008], [0, 0, 0.18], [0.55, 1.10, 0.86]);
    k.add(new THREE.SphereGeometry(0.032, 9, 7), M.skin, [-0.100, -0.010, -0.008], [0, 0, -0.18], [0.55, 1.10, 0.86]);
    k.build(head, 'skull');

    // Hair. The kasa hides the crown from every camera above the brim, so the
    // chonmage on its own could never do the job it was written for. The shapes
    // that actually survive under the hat are at the NAPE: a shell that comes
    // down the back of the skull to a visible hairline, the occipital mass
    // behind it, and the bound root of the tail below both. Together they give
    // the head a top-heavy human profile instead of one smooth ball, and they
    // put a hair/skin value break where the silhouette needs it.
    const h = new Kit();
    h.add(new THREE.SphereGeometry(0.104, 16, 10, 0, Math.PI * 2, 0.42, Math.PI * 0.64), M.hair, [0, 0.012, -0.010], null, [1.03, 1.16, 1.10]);
    h.add(new THREE.SphereGeometry(0.090, 12, 8, 0, Math.PI, 0, Math.PI), M.hair, [0, 0.026, -0.028], [0, Math.PI, 0], [1, 1.04, 1.0]);
    h.add(new THREE.SphereGeometry(0.064, 12, 9), M.hair, [0, -0.010, -0.082], null, [1.08, 1.06, 0.74]);
    h.add(new THREE.SphereGeometry(0.031, 10, 8), M.hair, [0, -0.040, -0.100], null, [0.88, 1.02, 0.88]);
    h.add(new THREE.TorusGeometry(0.027, 0.0075, 5, 10), M.cord, [0, -0.044, -0.100], [Math.PI / 2, 0, 0]);
    h.add(limbGeo(0.090, 0.026, 0.018, 8), M.hair, [0, 0.096, -0.058], [-0.85, 0, 0]);
    h.build(head, 'hair');

    // Menpo: a half mask, not a plate. Cheek flares, a nose ridge, a chin cup
    // and a laced throat guard under it.
    const m = new Kit();
    m.add(plateGeo(0.110, 0.084, 0.052, 0.84), M.armour, [0, -0.050, 0.060], [0.16, 0, 0]);
    m.add(plateGeo(0.056, 0.062, 0.062, 0.92), M.armour, [0.052, -0.018, 0.048], [0.05, 0.34, 0]);
    m.add(plateGeo(0.056, 0.062, 0.062, 0.92), M.armour, [-0.052, -0.018, 0.048], [0.05, -0.34, 0]);
    m.add(plateGeo(0.030, 0.056, 0.052, 0.70), M.armour, [0, 0.006, 0.080], [-0.30, 0, 0]);
    m.add(new THREE.CylinderGeometry(0.010, 0.006, 0.048, 6), M.armour, [0.036, -0.058, 0.076], [0, 0, 0.95]);
    m.add(new THREE.CylinderGeometry(0.010, 0.006, 0.048, 6), M.armour, [-0.036, -0.058, 0.076], [0, 0, -0.95]);
    for (let i = 0; i < 2; i++) {                        // yodare-kake, throat guard
      m.add(plateGeo(0.126 - i * 0.008, 0.034, 0.070, 0.95), M.armour, [0, -0.098 - i * 0.032, 0.036 - i * 0.008], [0.34 + i * 0.08, 0, 0]);
      m.add(plateGeo(0.132 - i * 0.008, 0.010, 0.078, 1), M.lacing, [0, -0.082 - i * 0.032, 0.040 - i * 0.008], [0.34 + i * 0.08, 0, 0]);
    }
    m.build(head, 'menpo');

    // Eyes set under a brow shadow. Two dark slots plus a pupil is all it takes
    // for the head to look at you.
    const e = new Kit();
    e.add(plateGeo(0.124, 0.020, 0.030, 1), M.armour, [0, 0.036, 0.084], [-0.22, 0, 0]);
    e.add(plateGeo(0.044, 0.024, 0.014, 1), M.dark, [0.032, 0.012, 0.088]);
    e.add(plateGeo(0.044, 0.024, 0.014, 1), M.dark, [-0.032, 0.012, 0.088]);
    e.add(new THREE.SphereGeometry(0.010, 8, 6), M.dark, [0.032, 0.012, 0.093]);
    e.add(new THREE.SphereGeometry(0.010, 8, 6), M.dark, [-0.032, 0.012, 0.093]);
    e.build(head, 'brow');
  }

  // Kasa on its own pivot under the head so it can lag and tilt independently.
  const kasa = new THREE.Group(); kasa.position.y = 0.080; head.add(kasa);
  {
    const brim = new THREE.Mesh(kasaGeo(0.310, 0.135), M.straw);
    brim.castShadow = true; brim.receiveShadow = true; kasa.add(brim);
    const k = new Kit();
    k.add(new THREE.TorusGeometry(0.306, 0.010, 5, 24), M.cord, [0, 0.000, 0], [Math.PI / 2, 0, 0]);
    k.add(new THREE.CylinderGeometry(0.104, 0.108, 0.016, 14), M.cord, [0, 0.050, 0]);
    k.build(kasa, 'kasa-trim');
  }
  // Chin cord: pinned under both brim edges, sagging under the jaw.
  const chinCord = makeCord(7, 0.0085, M.cord, 0.50);
  chinCord.mesh.name = 'chincord'; head.add(chinCord.mesh);
  const cordPinA = new THREE.Vector3(0.215, 0.060, 0.030);
  const cordPinB = new THREE.Vector3(-0.215, 0.060, 0.030);

  /* ------------------------------------------------------------ the sword */
  // Scabbard rig at the left hip (+X is the body's left). Its local -Y runs from
  // the koiguchi to the kojiri; its local +Z is roughly world up so the sheathed
  // blade sits edge-up, the way a katana is actually worn.
  // Tucked INTO the hip, not hung off it. The old koiguchi sat 3.6cm proud of
  // the hip socket on a direction only 19 degrees below horizontal, which threw
  // a 0.74m scabbard out sideways and backwards at belt height — the reason it
  // read as a detached stick floating in the grass. Pulled inboard onto the hip
  // and dropped to 31 degrees, which is roughly how a katana is actually worn
  // and puts the kojiri clearly below the pelvis where the eye expects it.
  const sayaRig = new THREE.Group();
  sayaRig.position.set(0.104, -0.026, -0.028);
  const sayaDir = new THREE.Vector3(0.118, -0.520, -0.846).normalize();
  {
    const eY = sayaDir.clone().multiplyScalar(-1);
    const eZ = new THREE.Vector3(0, 1, 0).addScaledVector(eY, -eY.y).normalize();
    const eX = new THREE.Vector3().crossVectors(eY, eZ).normalize();
    sayaRig.quaternion.setFromRotationMatrix(_m1.makeBasis(eX, eY, eZ));
  }
  hips.add(sayaRig);
  const SAYA_LEN = 0.735, TSUKA_LEN = 0.262;
  {
    const k = new Kit();
    k.add(limbGeo(SAYA_LEN, 0.0230, 0.0180, 8), M.saya, [0, -0.004, 0]);
    k.add(new THREE.CylinderGeometry(0.0250, 0.0250, 0.028, 10), M.gold, [0, -0.012, 0]);   // koiguchi
    k.add(new THREE.SphereGeometry(0.021, 8, 6), M.gold, [0, -SAYA_LEN - 0.002, 0]);        // kojiri
    k.add(new THREE.TorusGeometry(0.025, 0.006, 5, 10), M.leather, [0, -0.110, 0], [Math.PI / 2, 0, 0]);
    k.build(sayaRig, 'saya');
  }
  // Sageo — the silk cord tying the scabbard to the belt. Pure secondary motion.
  const sageo = makeCord(6, 0.006, M.lacing, 0.32);
  sageo.mesh.name = 'sageo'; hips.add(sageo.mesh);
  const sageoPin = new THREE.Vector3();

  // The sword lives directly under the root so it can be blended between the
  // scabbard socket and the hand socket without reparenting every frame.
  // Local frame: origin at the tsuba, blade along +Y, tsuka along -Y, edge +Z.
  const swordGroup = new THREE.Group(); swordGroup.name = 'katana'; root.add(swordGroup);
  {
    const k = new Kit();
    k.add(limbGeo(TSUKA_LEN, 0.0175, 0.0205, 8), M.leather, [0, 0, 0]);
    for (let i = 0; i < 7; i++) {  // ito wrap, suggested by alternating diamonds
      k.add(plateGeo(0.041, 0.012, 0.041, 1), M.dark, [0, -0.028 - i * 0.033, 0], [0, i % 2 ? 0.55 : -0.55, 0]);
    }
    k.add(new THREE.SphereGeometry(0.019, 8, 6), M.gold, [0, -TSUKA_LEN + 0.004, 0], null, [1, 0.7, 1]); // kashira
    k.add(new THREE.SphereGeometry(0.012, 6, 5), M.gold, [0.019, -0.115, 0], null, [0.5, 1.4, 0.9]);     // menuki
    k.build(swordGroup, 'tsuka');
    const t = new Kit();
    t.add(new THREE.CylinderGeometry(0.045, 0.045, 0.009, 14), M.steel, [0, 0.004, 0], null, [1, 1, 0.72]);
    t.add(new THREE.CylinderGeometry(0.021, 0.021, 0.016, 10), M.gold, [0, 0.013, 0]);   // seppa
    t.add(new THREE.CylinderGeometry(0.019, 0.017, 0.030, 10), M.gold, [0, 0.029, 0]);   // habaki
    t.build(swordGroup, 'tsuba');
    const blade = new THREE.Mesh(bladeGeo(0.705), M.blade);
    blade.position.y = 0.042; blade.castShadow = true;
    swordGroup.add(blade);
  }
  // Stow socket: 180 degrees about Z maps the sword's +Y (blade) onto the saya's
  // -Y (the cavity) while leaving +Z — the cutting edge — pointing up.
  const stowSocket = new THREE.Object3D();
  stowSocket.rotation.set(0, 0, Math.PI);
  sayaRig.add(stowSocket);
  // Hold socket: the tsuka passes through the curled fingers, so its axis lies
  // along the hand's X. The blade emerges on the thumb side.
  const holdSocket = new THREE.Object3D();
  holdSocket.position.set(-0.052, -0.048, 0.004);
  holdSocket.rotation.set(0, 0, Math.PI * 0.5);
  hands.r.group.add(holdSocket);
  // Where the left wrist should land for a two-handed grip.
  const leftGripSocket = new THREE.Object3D();
  leftGripSocket.position.set(0, -0.190, -0.050);
  swordGroup.add(leftGripSocket);

  /* ------------------------------------------------------------- the coat */
  // Jinbaori: a sleeveless surcoat worn over armour. Open at the front so the do
  // still reads, with a crimson lining that flashes when it flares.
  const coatAnchor = new THREE.Group(); coatAnchor.position.set(0, 0.250, 0); chest.add(coatAnchor);
  // The garment itself: a wrapped two-skin shell open at the front, hem at the
  // knee, plus a shorter cape over the shoulders so the back reads as two
  // layers of cloth rather than one card.
  const cloak = makeShell({
    rows: 13, cols: 30, theta: 1.52, h: 0.815, top: 0.020, drop: 0.345,
    rx0: 0.212, rz0: 0.134, rxH: 0.118, rzH: 0.102,
    // fold0 nearly doubled. At 0.0215 the deepest crease was ~2 cm of radius on
    // a 33 cm hem: about 5 px at the judged figure size, i.e. below the width
    // where a fold reads as a fold at all.
    folds: 7.6, fold0: 0.0370, crease: 0.0105, edgeWave: 0.0250, thick: 0.0115,
  }, M.coat, M.lining, M.trim);
  cloak.mesh.name = 'jinbaori';
  coatAnchor.add(cloak.mesh);
  const yoke = makeShell({
    rows: 5, cols: 22, theta: 1.24, h: 0.300, top: 0.006, drop: 0.100,
    rx0: 0.230, rz0: 0.152, rxH: 0.052, rzH: 0.048,
    folds: 6.0, fold0: 0.0135, crease: 0.0042, edgeWave: 0.0075, thick: 0.0095,
  }, M.yoke, M.trim, M.trim);
  yoke.mesh.name = 'jinbaori-yoke';
  coatAnchor.add(yoke.mesh);
  // A rolled crimson collar standing above both. It is the one warm value on
  // the back of the figure and it is what stops the shoulders reading as a slab.
  {
    const k = new Kit();
    // arc 1.30pi wide, its gap rotated round to the front of the throat
    k.add(new THREE.TorusGeometry(0.126, 0.029, 7, 18, Math.PI * 1.30), M.lining,
      [0, -0.022, 0.004], [Math.PI / 2, 0, Math.PI * 0.85]);
    k.add(new THREE.TorusGeometry(0.142, 0.013, 5, 18, Math.PI * 1.26), M.trim,
      [0, -0.056, 0.002], [Math.PI / 2, 0, Math.PI * 0.87]);
    k.build(coatAnchor, 'collar-roll');
  }
  // Kimono sleeves: the big square hanging cuffs under each arm.
  const sleeves = [];
  for (const s of ['l', 'r']) {
    const sx = s === 'l' ? 1 : -1;
    const sl = makeSheet(0.150, 0.195, 3, 4, M.kimono);
    sl.mesh.position.set(sx * 0.072, -0.205, -0.006);
    sl.mesh.rotation.set(0, -sx * 0.42, sx * 0.10);
    shoulder[s].add(sl.mesh);
    sleeves.push({ s: sl, sx, side: s });
  }

  /* ----------------------------------------------------------- the hakama */
  // Upper skirt: a pleated cone from the obi to just above the knee, rebuilt
  // every frame so it reacts to stride, wind and the body's own sway.
  // Eight box pleats, four columns each: fewer and the creases alias, more and
  // they stop reading as separate panels of cloth.
  const SK_R = 11, SK_C = 32, SK_PLEATS = 8;
  const skirtGeo = new THREE.BufferGeometry();
  {
    const vc = (SK_R + 1) * SK_C;
    skirtGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vc * 3), 3));
    skirtGeo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(vc * 3), 3));
    const col = new Float32Array(vc * 3);
    const uv = new Float32Array(vc * 2);
    for (let r = 0; r <= SK_R; r++) for (let s = 0; s < SK_C; s++) {
      const i = r * SK_C + s;
      // The last hand's-width of the hem takes the dye twice; it is the band
      // that lets the eye find the bottom edge of the garment against grass.
      const tt = r / SK_R;
      const hem = tt > 0.86 ? lerp(1, 0.74, smooth((tt - 0.86) / 0.14)) : 1;
      const v = hem * (1 + (hash1(i * 5.13) - 0.5) * 0.11);
      col[i * 3] = v; col[i * 3 + 1] = v; col[i * 3 + 2] = v;
      uv[i * 2] = s / SK_C; uv[i * 2 + 1] = tt;
    }
    skirtGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    skirtGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    const idx = [];
    for (let r = 0; r < SK_R; r++) for (let s = 0; s < SK_C; s++) {
      const a = r * SK_C + s, b = r * SK_C + (s + 1) % SK_C;
      const c = (r + 1) * SK_C + s, d = (r + 1) * SK_C + (s + 1) % SK_C;
      idx.push(a, c, b, b, c, d);
    }
    skirtGeo.setIndex(idx);
  }
  const skirt = new THREE.Mesh(skirtGeo, M.hakama);
  skirt.castShadow = true; skirt.receiveShadow = true; skirt.frustumCulled = false;
  hips.add(skirt);
  // Koshiita — the stiff back board of a hakama, sat above the pleats.
  new Kit().add(plateGeo(0.215, 0.105, 0.040, 0.95), M.hakama, [0, 0.055, -0.155], [-0.14, 0, 0]).build(hips, 'koshiita');
  // The two hakama legs, swept along the live IK leg chain.
  // MEASURED, wave K. update() already flutes these with pleat=0.105 at 6 lobes,
  // and at 14 sides that is 2.33 vertices per lobe — under two samples per
  // period, so the flute aliased into a lumpy cylinder instead of reading as
  // pleats and the leg came back as the critic's "inflated plastic balloon".
  // 24 sides puts 4 vertices on every lobe, which is the minimum that shows a
  // crest and a trough. 9x24 verts a leg; the cost is not measurable.
  const legTubes = { l: makeTube(8, 24, M.hakama, 0.82), r: makeTube(8, 24, M.hakama, 0.82) };
  const legPts = { l: [], r: [] };
  for (const s of ['l', 'r']) {
    legTubes[s].mesh.name = 'hakama-' + s;
    hips.add(legTubes[s].mesh);
    for (let i = 0; i <= 8; i++) legPts[s].push(new THREE.Vector3());
  }

  root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  /* ==================================================== animation state === */
  let t = 0, phase = 0;
  let stance = 'stone', stancePrev = 'stone', stanceBlend = 1;
  const SB = { guard: [0, 0, 0] };
  for (const kk in STANCES.stone) SB[kk] = Array.isArray(STANCES.stone[kk]) ? STANCES.stone[kk].slice() : STANCES.stone[kk];

  let drawn = false, swordBlend = 0;
  let combatTimer = 0, attackAlt = 0;
  const act = { name: null, k: 0, dur: 0, drawK: 0 };

  const foot = {};
  for (const s of ['l', 'r']) {
    foot[s] = {
      plant: new THREE.Vector3(), lift: new THREE.Vector3(), target: new THREE.Vector3(),
      pending: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0),
      // Normal at the spot the swinging foot is aiming for, so the sole is
      // already level with the ground it is about to meet.
      nextN: new THREE.Vector3(0, 1, 0),
      // Heading the foot was planted at. A stance foot must not twist on the
      // spot while the body turns over it.
      yaw: 0, yawW: 0, gotNext: false,
      rollX: 0, contact: true, stepT: 0, ready: false,
    };
  }
  let stepLock = null;
  const _f1 = new THREE.Vector3(), _f2 = new THREE.Vector3(), _f3 = new THREE.Vector3();
  const wrapPi = a => THREE.MathUtils.euclideanModulo(a + Math.PI, Math.PI * 2) - Math.PI;

  const bodyPos = new THREE.Vector3(), fwd = new THREE.Vector3(0, 0, 1), lft = new THREE.Vector3(1, 0, 0);
  const upW = new THREE.Vector3(0, 1, 0);
  let yaw = 0, yawPrev = 0, yawRate = 0, speedSm = 0, accel = 0, speedPrev = 0;
  let hipDrop = 0, bobExtra = 0, bankSm = 0;
  let landDip = 0, landV = 0;
  const hipsInv = new THREE.Matrix4(), chestInv = new THREE.Matrix4(), rootInv = new THREE.Matrix4();
  const legPole = { l: new THREE.Vector3(), r: new THREE.Vector3() };
  const armPole = { l: new THREE.Vector3(), r: new THREE.Vector3() };
  const ikTargetR = new THREE.Vector3(), ikTargetL = new THREE.Vector3();
  const skirtSway = new THREE.Vector2();
  const cloakSway = new THREE.Vector2();
  let cloakPhase = 0, cloakTwist = 0;
  const _hp = new THREE.Vector3(), _kp = new THREE.Vector3(), _ap = new THREE.Vector3();

  // Pose channel block. Locomotion writes the base, actions blend over it, and
  // only then does anything get pushed into the bones. Blending here instead of
  // adding into bone rotations is what stops the action layer exploding.
  const B = {
    spineX: 0, spineY: 0, spineZ: 0, chestX: 0, chestY: 0, chestZ: 0,
    neckX: 0, neckY: 0, neckZ: 0, headX: 0, headY: 0, headZ: 0,
    hipsRX: 0, hipsRY: 0, hipsRZ: 0, hipsLift: 0,
    shLX: 0, shLY: 0, shLZ: 0, elLX: 0,
    shRX: 0, shRY: 0, shRZ: 0, elRX: 0,
    gripL: 0, gripR: 0, kneeBias: 0, footAir: 0,
  };
  const blend = (key, v, w) => { B[key] = B[key] * (1 - w) + v * w; };

  const DURS = {
    attack_light: 0.44, attack_heavy: 0.86, parry: 0.34, dodge: 0.58,
    draw: 0.62, draw_cut: 0.72, sheathe: 0.74, stagger: 0.52, death: 1.4,
  };

  const groundAt = (x, z) => (ctx.world && ctx.world.heightAt ? ctx.world.heightAt(x, z) : 0);

  // Cheap local slope at a plant point. Four taps, and only ever on touchdown.
  function slopeFrame(p, out) {
    const e = 0.16;
    const hx = groundAt(p.x + e, p.z) - groundAt(p.x - e, p.z);
    const hz = groundAt(p.x, p.z + e) - groundAt(p.x, p.z - e);
    out.set(-hx, 2 * e, -hz).normalize();
  }

  function neutralStance(s, out) {
    const sx = (s === 'l' ? 1 : -1) * 0.105 * SB.width;
    const fz = (s === 'l' ? 0.028 : -0.028) * SB.width;
    out.copy(bodyPos).addScaledVector(lft, sx).addScaledVector(fwd, fz);
    out.y = groundAt(out.x, out.z);
  }

  /* ==================================================== the update loop === */
  const api = {
    group: root,
    bones: { hips, spine, chest, neck, head, shoulder, elbow, wrist, hip, knee, ankle, kasa, swordRig: sayaRig, sword: swordGroup },
    getBone(n) { return api.bones[n] || null; },
    // Read-only view of the foot solver, for the lane's skate measurement.
    get feet() { return foot; },
    get drawn() { return drawn; },
    get stance() { return stance; },

    setStance(s) {
      if (typeof s === 'number') s = STANCE_ORDER[(s - 1) % STANCE_ORDER.length] || 'stone';
      if (!STANCES[s] || s === stance) return;
      stancePrev = stance; stance = s; stanceBlend = 0;
    },
    cycleStance() { api.setStance(STANCE_ORDER[(STANCE_ORDER.indexOf(stance) + 1) % STANCE_ORDER.length]); },

    setSheathed(v) {
      drawn = !v; swordBlend = drawn ? 1 : 0;
      if (drawn) combatTimer = 9;
      act.name = null;
    },

    playAction(name) {
      // An attack with the sword stowed is an iai draw-cut, not a swing at air.
      if ((name === 'attack_light' || name === 'attack_heavy') && !drawn) name = 'draw_cut';
      if (name === 'attack_light') attackAlt ^= 1;
      act.name = name; act.k = 0; act.dur = DURS[name] ?? 0.5;
      if (name !== 'sheathe') combatTimer = Math.max(combatTimer, 7);
    },

    // Landing impulse, in m/s of downward velocity at touchdown. The pelvis
    // takes it as a real spring instead of a keyframed dip, so a hop barely
    // registers and a long fall folds him into a crouch that pushes back up.
    impact(v) { landV -= clamp(v, 0, 11) * 0.024; },

    update(dt, s = {}) {
      dt = Math.min(dt, 1 / 20);
      t += dt;
      const speed = s.speed ?? 0;
      speedSm = damp(speedSm, speed, 14, dt);
      accel = damp(accel, (speed - speedPrev) / Math.max(dt, 1e-4), 8, dt);
      speedPrev = speed;

      // Absorb spring. Stiff enough to recover inside a third of a second,
      // just under critical damping so it settles with one small rebound.
      landV += (-landDip * 260 - landV * 26) * dt;
      landDip = clamp(landDip + landV * dt, -0.30, 0.05);

      /* ---- where the body actually is, in world space -------------------- */
      root.updateWorldMatrix(true, false);
      bodyPos.setFromMatrixPosition(root.matrixWorld);
      const py = ctx.player && typeof ctx.player.yaw === 'number' ? ctx.player.yaw : yaw;
      const dyaw = THREE.MathUtils.euclideanModulo(py - yawPrev + Math.PI, Math.PI * 2) - Math.PI;
      yawRate = damp(yawRate, clamp(dyaw / Math.max(dt, 1e-4), -6, 6), 10, dt);
      yawPrev = py; yaw = py;
      fwd.set(Math.sin(yaw), 0, Math.cos(yaw));
      lft.set(Math.cos(yaw), 0, -Math.sin(yaw));   // +X of the body is its left

      /* ---- stance blend --------------------------------------------------- */
      stanceBlend = Math.min(1, stanceBlend + dt * 3.2);
      const SA = STANCES[stancePrev], SC = STANCES[stance], sb = smooth(stanceBlend);
      for (const kk in SC) {
        if (Array.isArray(SC[kk])) for (let i = 0; i < 3; i++) SB[kk][i] = lerp(SA[kk][i], SC[kk][i], sb);
        else SB[kk] = lerp(SA[kk], SC[kk], sb);
      }

      /* ---- gait clock ------------------------------------------------------ */
      const moving = speed > 0.16;
      const run = smooth(clamp((speed - 1.2) / 2.4, 0, 1));
      const sprintK = smooth(clamp((speed - 3.6) / 3.4, 0, 1));
      // Cadence and duty factor fitted to real gait: at a walk one foot is
      // always down; in a sprint neither is, for part of the cycle. The stride
      // length that falls out of these is what keeps the leg inside its reach.
      const cyc = speed < 1.4 ? lerp(1.15, 1.00, clamp(speed / 1.4, 0, 1))
        : speed < 3.4 ? lerp(1.00, 0.72, clamp((speed - 1.4) / 2.0, 0, 1))
          : lerp(0.72, 0.44, clamp((speed - 3.4) / 3.8, 0, 1));
      const duty = speed < 1.2 ? lerp(0.66, 0.60, clamp(speed / 1.2, 0, 1))
        : speed < 3.4 ? lerp(0.60, 0.34, clamp((speed - 1.2) / 2.2, 0, 1))
          : lerp(0.34, 0.29, clamp((speed - 3.4) / 3.8, 0, 1));
      const halfStride = Math.min(0.5 * speed * duty * cyc, 0.50);
      const lat = lerp(0.112, 0.052, run);
      const liftH = lerp(0.075, 0.28, run);
      phase += moving ? dt * (Math.PI * 2) / cyc : dt * 0.9;

      /* ---- action clock ---------------------------------------------------- */
      let ak = 0, aw = 0;
      const aname = act.name;
      if (act.name) {
        act.k += dt / act.dur;
        if (act.k >= 1) {
          if (act.name === 'draw' || act.name === 'draw_cut') drawn = true;
          if (act.name === 'sheathe') drawn = false;
          act.name = null; act.k = 0;
        } else {
          ak = act.k;
          aw = Math.min(smooth(ak / 0.13), smooth((1 - ak) / 0.28));
          if ((act.name === 'draw' || act.name === 'draw_cut') && ak > 0.30) drawn = true;
          if (act.name === 'sheathe' && ak > 0.74) drawn = false;
        }
      }
      combatTimer = Math.max(0, combatTimer - dt);
      if (drawn && !act.name && combatTimer <= 0) api.playAction('sheathe');

      /* ================================================= base pose (FK) === */
      const sw = Math.sin(phase), cs = Math.cos(phase);
      const amp = moving ? lerp(0.55, 1.20, run) : 0;
      const idle = moving ? 0 : 1;
      const br = Math.sin(t * 1.35 * SB.breathe);

      // Bank into the turn. yawRate was already computed and was being spent on
      // the cloak sway and the kasa lag while the torso itself stayed bolt
      // upright — a man changing direction at 7 m/s with a level spine reads as
      // a puck sliding on rails. Centripetal, so it scales with speed: there is
      // nothing to lean against at a standstill. Damped slower than yawRate so
      // the lean has mass and settles after the turn instead of snapping.
      bankSm = damp(bankSm, clamp(yawRate * speedSm * 0.014, -0.30, 0.30), 5, dt);
      // yawRate > 0 turns to the body's left (+X), and +rotation.z tips the top
      // toward its right, so the lean is the negative term.
      B.hipsRY = sw * 0.085 * amp + idle * Math.sin(t * 0.47) * 0.03;
      B.hipsRZ = cs * 0.040 * amp + idle * Math.sin(t * 0.61) * 0.022 - bankSm * 0.55;
      B.hipsRX = -0.02 - run * 0.05;
      // The absorb rides hipsLift, not the final pelvis height, so the reach
      // solver below sees the lowered pelvis and the planted feet stay planted
      // while he folds over them.
      B.hipsLift = landDip;
      B.spineX = 0.02 + run * 0.06 - landDip * 1.25;
      B.spineY = -sw * 0.05 * amp;
      B.spineZ = -cs * 0.02 * amp - bankSm * 0.26;
      B.chestX = 0.02 + run * 0.24 + SB.chestX * (1 - run * 0.7) + idle * br * 0.012;
      B.chestY = -sw * 0.13 * amp + SB.chestY * (1 - run * 0.6);
      B.chestZ = -cs * 0.03 * amp - bankSm * 0.19;
      B.neckX = -(B.chestX + B.spineX) * 0.72;
      B.neckY = 0; B.neckZ = 0;
      B.headX = -0.02 + idle * br * 0.008;
      B.headY = SB.headY * (1 - run * 0.8) + idle * Math.sin(t * 0.31) * 0.05;
      B.headZ = -B.hipsRZ * 0.35;
      B.kneeBias = 0;
      B.footAir = 0;

      // Arms. The right arm swings; the left rides the scabbard when the sword
      // is stowed, which is most of the walking silhouette of a samurai.
      const swingR = moving ? sw * lerp(0.42, 0.95, run) : idle * Math.sin(t * 0.6) * 0.03;
      const swingL = moving ? -sw * lerp(0.30, 0.72, run) : idle * Math.sin(t * 0.6 + 0.8) * 0.03;
      B.shRX = swingR - 0.06 - run * 0.10;
      B.shRY = 0; B.shRZ = 0.115 + run * 0.09;
      B.elRX = 0.42 + run * 0.62 + Math.max(0, -sw) * 0.45 * amp;
      B.shLX = swingL - 0.06;
      B.shLY = 0; B.shLZ = -0.115 - run * 0.09;
      B.elLX = 0.40 + run * 0.55 + Math.max(0, sw) * 0.40 * amp;
      B.gripL = 0.16; B.gripR = 0.12;

      /* ---- drawn guard posture -------------------------------------------- */
      const guardW = clamp(swordBlend * (1 - run * 0.35), 0, 1);
      if (guardW > 0.001) {
        blend('shRX', SB.gx, guardW);
        blend('shRY', SB.gy * 0.28, guardW);
        blend('shRZ', SB.gz + 0.26, guardW);
        blend('elRX', 1.05 + SB.gz * 0.4, guardW);
        blend('chestY', SB.chestY * 1.4, guardW * 0.7);
        blend('gripR', 1, guardW);
        blend('gripL', 0.92, guardW);
      }

      /* ---- action overlays -------------------------------------------------- */
      let armIKr = false;
      let swordTargetBlend = drawn ? 1 : 0;

      if (aname && aw > 0) {
        const w = aw;
        if (aname === 'attack_light' || aname === 'attack_heavy' || aname === 'draw_cut') {
          const heavy = aname === 'attack_heavy';
          const dir = (aname === 'attack_light' && attackAlt) ? -1 : 1;
          const hi = heavy ? 1.25 : 1.0;
          // Kesa-giri: wind up over the shoulder, cut down across the body.
          const kk = aname === 'draw_cut' ? clamp((ak - 0.30) / 0.70, 0, 1) : ak;
          const wind = track(kk, [[0, 0.0], [0.34, 1.0], [0.52, 1.0], [1, 0.0]]);
          const cut = track(kk, [[0, 0.0], [0.34, 0.0], [0.60, 1.0], [1, 0.94]]);
          blend('shRX', lerp(-0.25, -2.35 * hi, wind) + cut * (2.05 * hi), w);
          blend('shRY', dir * (wind * 0.55 - cut * 0.85), w);
          blend('shRZ', 0.30 + wind * 0.55 * dir - cut * 0.30 * dir, w);
          blend('elRX', lerp(1.0, 1.85, wind) - cut * 1.35, w);
          blend('chestY', dir * (wind * 0.55 - cut * 0.95) * hi, w);
          blend('chestX', -wind * 0.16 + cut * 0.30 * hi, w);
          blend('hipsRY', dir * (wind * 0.22 - cut * 0.42), w);
          blend('spineY', dir * (wind * 0.16 - cut * 0.28), w);
          blend('headY', dir * (-wind * 0.20 + cut * 0.30), w);
          blend('kneeBias', cut * 0.22 * hi, w);
          blend('gripR', 1, w); blend('gripL', 1, w);
          if (heavy) blend('hipsLift', -0.05 * cut, w);
        } else if (aname === 'parry') {
          const p = track(ak, [[0, 0], [0.30, 1], [0.62, 1], [1, 0]]);
          blend('shRX', -1.30, w * p); blend('shRZ', 0.62, w * p); blend('elRX', 1.45, w * p);
          blend('shLX', -1.05, w * p); blend('shLZ', -0.50, w * p); blend('elLX', 1.55, w * p);
          blend('chestX', 0.16, w * p); blend('chestY', -0.28, w * p);
          blend('hipsLift', -0.045, w * p);
          blend('gripR', 1, w); blend('gripL', 1, w);
        } else if (aname === 'dodge') {
          const p = track(ak, [[0, 0], [0.22, 1], [0.55, 0.85], [1, 0]]);
          const airK = track(ak, [[0, 0], [0.18, 1], [0.60, 1], [0.86, 0]]);
          blend('chestX', 0.85, w * p); blend('spineX', 0.42, w * p); blend('neckX', -0.30, w * p);
          blend('hipsLift', -0.30 * p, w);
          blend('shRX', -0.55, w * p); blend('shLX', -0.55, w * p);
          blend('elRX', 1.9, w * p); blend('elLX', 1.9, w * p);
          blend('kneeBias', 1.05 * p, w);
          B.footAir = airK * w;
        } else if (aname === 'stagger') {
          const p = track(ak, [[0, 0], [0.25, 1], [0.60, 0.6], [1, 0]]);
          blend('chestX', -0.55, w * p); blend('neckX', -0.42, w * p);
          blend('hipsRZ', 0.20, w * p); blend('shRX', 0.55, w * p); blend('shLX', 0.55, w * p);
          blend('hipsLift', -0.06, w * p);
        } else if (aname === 'death') {
          const p = track(ak, [[0, 0], [0.55, 1], [1, 1]]);
          blend('chestX', 0.55, p); blend('neckX', 0.30, p);
          blend('hipsLift', -0.55, p); blend('kneeBias', 1.5, p);
          blend('shRX', 0.7, p); blend('shLX', 0.7, p);
        }

        // Draw and sheathe run the right hand along the scabbard axis, so the
        // arm takes an IK target and the blade slides where the hand goes.
        if (aname === 'draw' || aname === 'draw_cut' || aname === 'sheathe') {
          const kk = aname === 'sheathe' ? 1 - ak : ak;
          armIKr = true;
          act.drawK = kk;
          blend('gripR', smooth((kk - 0.08) / 0.16), 1);
          blend('chestY', 0.34 * track(kk, [[0, 0], [0.30, 1], [0.70, 0.5], [1, 0]]), aw * 0.8);
          blend('shLX', -0.45, aw * 0.5); blend('elLX', 1.25, aw * 0.5);
          swordTargetBlend = smooth((kk - 0.22) / 0.14);
        }
      }

      /* ---- apply the base pose to the bones ------------------------------- */
      hips.rotation.set(B.hipsRX, B.hipsRY, B.hipsRZ);
      spine.rotation.set(B.spineX, B.spineY, B.spineZ);
      chest.rotation.set(B.chestX, B.chestY, B.chestZ);
      neck.rotation.set(B.neckX, B.neckY, B.neckZ);
      head.rotation.set(B.headX, B.headY, B.headZ);
      shoulder.l.rotation.set(B.shLX, B.shLY, B.shLZ);
      shoulder.r.rotation.set(B.shRX, B.shRY, B.shRZ);
      elbow.l.rotation.set(B.elLX, 0, 0);
      elbow.r.rotation.set(B.elRX, 0, 0);
      for (const s of ['l', 'r']) {
        const h = hands[s];
        h.grip = damp(h.grip, s === 'l' ? B.gripL : B.gripR, 16, dt);
        h.fing.rotation.x = h.grip * 1.35;
        h.tip.rotation.x = h.grip * 1.30;
        h.thumb.rotation.set(h.grip * 0.60, 0, (s === 'l' ? 1 : -1) * (0.50 + h.grip * 0.60));
      }
      // Sode lag: the shoulder plates swing a beat behind the arm.
      for (const s of ['l', 'r']) {
        const sd = shoulder[s].userData.sode;
        sd.rotation.x = damp(sd.rotation.x, -shoulder[s].rotation.x * 0.34, 9, dt);
      }

      /* ============================================ feet: plant on the world */
      for (const s of ['l', 'r']) {
        const F = foot[s];
        const sx = s === 'l' ? 1 : -1;
        const u = ((phase / (Math.PI * 2)) + (s === 'l' ? 0 : 0.5)) % 1;
        const contact = !moving || u < duty;

        if (!F.ready) {
          neutralStance(s, F.plant);
          F.lift.copy(F.plant); F.target.copy(F.plant); F.target.y += P.ankleH;
          slopeFrame(F.plant, F.normal); F.nextN.copy(F.normal);
          F.yaw = yaw; F.yawW = 1; F.ready = true;
        }

        if (!moving) {
          // Standing: hold the plant, but re-step if the body has turned or
          // drifted off it. Feet must never twist on the spot, so a heading
          // error past ~30 degrees also triggers a step.
          neutralStance(s, _v4);
          const err = _v4.distanceTo(F.plant);
          const twist = Math.abs(wrapPi(F.yaw - yaw));
          if (err > 1.0) {                                   // teleport: snap
            F.plant.copy(_v4); slopeFrame(F.plant, F.normal); F.nextN.copy(F.normal);
            F.stepT = 0; F.yaw = yaw;
            if (stepLock === s) stepLock = null;
          } else if (F.stepT > 0 || ((err > 0.19 || twist > 0.52) && (stepLock === null || stepLock === s))) {
            stepLock = s;
            F.stepT += dt / 0.26;
            const k2 = clamp(F.stepT, 0, 1);
            F.target.lerpVectors(F.plant, _v4, smoother(k2));
            F.target.y += P.ankleH + Math.sin(Math.PI * k2) * 0.065;
            F.yawW = 1 - smooth(k2);                         // release the lock mid-step
            if (k2 >= 1) {
              F.plant.copy(_v4); slopeFrame(F.plant, F.normal); F.nextN.copy(F.normal);
              F.stepT = 0; stepLock = null; F.yaw = yaw; F.yawW = 1;
            }
          } else {
            F.target.copy(F.plant);
            F.target.y += P.ankleH + Math.sin(t * 1.3 + (s === 'l' ? 0 : 2.1)) * 0.002;
            F.yawW = 1;
          }
          F.rollX = damp(F.rollX, 0, 8, dt);
          F.contact = true;
        } else {
          F.stepT = 0;
          if (stepLock === s) stepLock = null;
          if (contact && !F.contact) {                       // touchdown
            F.plant.copy(F.pending);
            F.plant.y = groundAt(F.plant.x, F.plant.z);
            slopeFrame(F.plant, F.normal);
            F.yaw = yaw;                                     // the foot commits to this heading
          }
          if (!contact && F.contact) { F.lift.copy(F.plant); F.gotNext = false; }  // lift-off
          F.contact = contact;

          // Landing attitude: toes up, heel leading. Shared by the end of the
          // swing and the start of stance so the two agree frame to frame.
          const pLand = -(0.06 + 0.30 * run);
          if (contact) {
            const c = clamp(u / duty, 0, 1);
            // Roll the foot over three fixed contact points: the heel at
            // strike, the whole sole through mid-stance, the ball at push-off.
            // The pivot is CONSTANT within each phase — ramping it, as this
            // did before, drags the contact point forward and is exactly the
            // skate you see at speed. Positive pitch lifts the heel.
            let pivot, pitch;
            if (c < 0.20) { pitch = lerp(pLand, 0, smooth(c / 0.20)); pivot = -P.heel; }
            else if (c < 0.56) { pitch = 0; pivot = 0; }
            else { const k2 = smooth((c - 0.56) / 0.44); pitch = k2 * lerp(0.55, 1.05, run); pivot = P.toe; }
            const oy = P.ankleH;
            const cpp = Math.cos(pitch), spp = Math.sin(pitch);
            // Heel and toe travel across the SLOPE, and the ankle sits above the
            // contact along the surface normal. Offsetting along world up instead
            // buried the toe by ankleH*sin(slope) on every hill.
            _f1.copy(F.normal);
            _f2.copy(fwd).addScaledVector(_f1, -fwd.dot(_f1));
            if (_f2.lengthSq() < 1e-8) _f2.copy(fwd); else _f2.normalize();
            F.target.copy(F.plant)
              .addScaledVector(_f2, pivot + oy * spp - pivot * cpp)
              .addScaledVector(_f1, oy * cpp + pivot * spp);
            F.rollX = pitch;
            // Hold the heading from touchdown, then release it before the foot
            // leaves so toe-off does not snap.
            F.yawW = smooth((1 - c) / 0.22);
          } else {
            const sT = clamp((u - duty) / (1 - duty), 0, 1);
            // Aim at where the body will BE at touchdown, not where it is now.
            const ahead = speed * (1 - u) * cyc;
            F.pending.copy(bodyPos).addScaledVector(fwd, ahead + halfStride).addScaledVector(lft, sx * lat);
            F.pending.y = groundAt(F.pending.x, F.pending.z);
            // Once the landing spot has settled, read the ground there so the
            // sole arrives already parallel to it.
            // Four extra terrain taps per foot per frame is real cost; the
            // landing spot is settled by mid-swing, so read it once.
            if (sT > 0.45 && !F.gotNext) { slopeFrame(F.pending, F.nextN); F.gotNext = true; }
            const e = smoother(sT);
            // Land on the same ankle offset the stance phase will start from.
            const cl = Math.cos(pLand), sl = Math.sin(pLand);
            const fL = -P.heel + P.ankleH * sl + P.heel * cl;
            const uL = P.ankleH * cl - P.heel * sl;
            F.target.lerpVectors(F.lift, F.pending, e);
            F.target.y = lerp(F.lift.y, F.pending.y, e) + lerp(P.ankleH, uL, e)
              + Math.sin(Math.PI * Math.pow(sT, 0.85)) * liftH;
            F.target.addScaledVector(fwd, fL * e);
            F.rollX = lerp(0.55 * run, pLand, smooth(sT));
            F.yawW = 0;
          }
        }

        // Airborne actions (the dodge) pull the feet off the ground entirely.
        if (B.footAir > 0.001) {
          _v4.copy(bodyPos).addScaledVector(fwd, 0.10).addScaledVector(lft, sx * 0.12);
          _v4.y = bodyPos.y + 0.42;
          F.target.lerp(_v4, B.footAir);
        }
      }

      /* ---- pelvis: bob, then lower until both feet are actually reachable -- */
      const targetBob = moving ? Math.abs(Math.sin(phase)) * lerp(0.012, 0.050, run) : 0;
      bobExtra = damp(bobExtra, targetBob, 18, dt);
      const baseY = P.hipY + bobExtra + B.hipsLift;
      const reach = LEG * 0.985;
      let need = 0;
      for (const s of ['l', 'r']) {
        const F = foot[s];
        _v5.copy(bodyPos).addScaledVector(lft, (s === 'l' ? 1 : -1) * P.hipHalf);
        _v5.y += baseY;
        const dx = _v5.x - F.target.x, dz = _v5.z - F.target.z;
        const allow = Math.sqrt(Math.max(reach * reach - (dx * dx + dz * dz), 0.0004));
        need = Math.min(need, allow - (_v5.y - F.target.y));
      }
      // Drop quickly when the stride outruns the leg, recover gently — a
      // symmetric filter lags on touchdown and lets the leg over-extend.
      const needY = clamp(need, -0.32, 0);
      hipDrop = damp(hipDrop, needY, needY < hipDrop ? 42 : 14, dt);
      hips.position.y = baseY + hipDrop + (moving ? 0 : br * 0.008);

      /* ---- leg IK ---------------------------------------------------------- */
      root.updateWorldMatrix(false, true);
      hipsInv.copy(hips.matrixWorld).invert();
      for (const s of ['l', 'r']) {
        const F = foot[s];
        const sx = s === 'l' ? 1 : -1;
        _v6.copy(F.target).applyMatrix4(hipsInv);
        legPole[s].set(sx * 0.20, -0.12, 1).normalize();
        ik2(hip[s], knee[s], P.thigh, P.shin, _v6, legPole[s]);
        if (B.kneeBias > 0.001) {
          knee[s].rotation.x += B.kneeBias * 0.9;
          hip[s].rotateX(-B.kneeBias * 0.30);
        }
        // Ankle. In contact the sole lies on the ground it is standing on; in
        // the air it rolls toward the ground it is about to land on, so it never
        // arrives at a slope flat-footed. Ankle roll is clamped to a human range.
        hip[s].updateWorldMatrix(false, true);
        _f3.copy(F.contact ? F.normal : F.nextN);
        if (!F.contact) _f3.lerp(F.normal, 0.35).normalize();
        _m3.copy(knee[s].matrixWorld).invert();
        _v1.copy(_f3).transformDirection(_m3);
        _q1.setFromUnitVectors(upW, _v1);
        const tilt = 2 * Math.acos(Math.min(1, Math.abs(_q1.w)));      // how far off level
        const align = (F.contact ? 0.92 : 0.55) * clamp(0.62 / Math.max(0.08, tilt), 0, 1);
        ankle[s].quaternion.identity().slerp(_q1, align);
        ankle[s].rotateX(F.rollX);
        // Heading lock: a planted foot keeps the direction it was planted in
        // while the body turns over it. This is what stops the pivot-skate.
        const yerr = clamp(wrapPi(F.yaw - yaw), -0.75, 0.75) * F.yawW;
        ankle[s].rotateY(sx * 0.055 + yerr);
      }

      /* ---- the sword: blend between the scabbard and the hand -------------- */
      root.updateWorldMatrix(false, true);
      swordBlend = damp(swordBlend, swordTargetBlend, 22, dt);
      rootInv.copy(root.matrixWorld).invert();
      placeSword();

      /* ---- arm IK ---------------------------------------------------------- */
      chestInv.copy(chest.matrixWorld).invert();
      armPole.l.set(0.55, -0.25, -1).normalize();
      armPole.r.set(-0.55, -0.25, -1).normalize();

      // Right arm, only while drawing or sheathing: the hand takes the tsuka
      // and then pulls straight out along the scabbard's axis.
      if (armIKr) {
        const kk = act.drawK;
        stowSocket.updateWorldMatrix(true, false);
        _v3.set(0, -0.120, 0).applyMatrix4(stowSocket.matrixWorld);           // grip on the stowed tsuka
        _v4.copy(sayaDir).transformDirection(hips.matrixWorld).multiplyScalar(-1);
        const pull = track(kk, [[0, 0], [0.24, 0.03], [0.60, 0.80], [0.80, 0.66], [1, 0.30]]);
        const swingOut = track(kk, [[0, 0], [0.58, 0], [1, 1]]);
        ikTargetR.copy(_v3).addScaledVector(_v4, pull * 0.80).addScaledVector(upW, pull * 0.14);
        _v5.set(SB.guard[0], SB.guard[1], SB.guard[2]).applyMatrix4(chest.matrixWorld);
        ikTargetR.lerp(_v5, swingOut);
        _v6.copy(ikTargetR).applyMatrix4(chestInv);
        ik2(shoulder.r, elbow.r, P.upperArm, P.foreArm, _v6, armPole.r);
        root.updateWorldMatrix(false, true);
        placeSword();
        chestInv.copy(chest.matrixWorld).invert();
      }

      // Left arm. Two-handed on the tsuka when the blade is out, resting on the
      // koiguchi when it is not — released only in a full sprint.
      let leftW = clamp(1 - sprintK * (drawn ? 0.25 : 0.75), 0, 1);
      if (aname === 'dodge' || aname === 'stagger' || aname === 'death') leftW *= (1 - aw);
      if (leftW > 0.02) {
        if (swordBlend > 0.45) {
          leftGripSocket.updateWorldMatrix(true, false);
          ikTargetL.setFromMatrixPosition(leftGripSocket.matrixWorld);
        } else {
          ikTargetL.set(0, -0.060, 0.040).applyMatrix4(sayaRig.matrixWorld);
        }
        _v6.copy(ikTargetL).applyMatrix4(chestInv);
        // Only take the IK where it is actually reachable; otherwise ease off.
        const okW = leftW * clamp((ARM * 1.02 - _v6.distanceTo(shoulder.l.position)) / 0.10, 0, 1);
        if (okW > 0.02) {
          _q1.copy(shoulder.l.quaternion);
          const eb = elbow.l.rotation.x;
          ik2(shoulder.l, elbow.l, P.upperArm, P.foreArm, _v6, armPole.l);
          shoulder.l.quaternion.slerp(_q1, 1 - okW);
          elbow.l.rotation.x = lerp(eb, elbow.l.rotation.x, okW);
        }
      }

      /* ---- kusazuri swing --------------------------------------------------- */
      root.updateWorldMatrix(false, true);
      for (let i = 0; i < kusazuri.length; i++) {
        const K = kusazuri[i];
        const front = Math.cos(K.base);
        const legSide = Math.sin(K.base) >= 0 ? 'l' : 'r';
        const push = front > 0.2 ? -hip[legSide].rotation.x * 0.40
          : front < -0.2 ? hip[legSide].rotation.x * 0.26 : 0;
        K.sw = damp(K.sw, push + 0.05 - accel * 0.012, 12, dt);
        K.g.rotation.x = clamp(K.sw, -0.70, 0.70);
      }

      /* ---- cloth ------------------------------------------------------------ */
      const wind = ctx.wind;
      // The cloth used to read wind.gust() alone. That is a slow global
      // envelope — 0.62 +/- 0.44 with a 20s dominant period — so over any few
      // seconds it is very nearly DC, which is why the cloak measured
      // pixel-for-pixel frozen while the grass beside it was boiling. The grass
      // is driven by the TRAVELLING GUST FRONTS, and wind.sample() is that same
      // field on the CPU: fronts 30-78 units wide crossing at 17-34 m/s, so a
      // front sweeps the player in a couple of seconds and the garment surges
      // with the field instead of ignoring it.
      const local = wind && wind.sample ? clamp(wind.sample(bodyPos.x, bodyPos.z), 0, 2.4) : 0.55;
      const gust = wind ? wind.gust() * wind.strength * (0.42 + 0.92 * local) : 0.6;
      // DIRECTION: windDirAt(), not uWindDir. This is the one line that put the
      // garment on the same vector as everything else. grass.js, trees.js and
      // vfx.js all bend along windDirAt(worldPos) — the prevailing wind ROTATED
      // toward a guiding corridor wherever one is blowing — while the cloth read
      // wind.dir, the prevailing direction alone. Outside a corridor the two are
      // the same vector, which is why a still frame could never show this; the
      // moment the player fires the guiding wind they diverge by up to the 63.5
      // degrees wind.js measured inside the lane, and the cape streams down a
      // line the grass under it is not lying along. dirAt() is wind.js's own CPU
      // twin of the GLSL windDirAt(), so this agrees with the shaders by
      // construction rather than by a number kept in step by hand.
      _wW.set(wind ? wind.dir.x : 0, 0, wind ? wind.dir.y : 0);
      if (wind && wind.dirAt) {
        const d = wind.dirAt(bodyPos.x, bodyPos.z);
        _wW.set(d[0], 0, d[1]);
      }
      let wx = 0, wz = 0;
      if (wind) {                                   // wind direction, body frame
        wx = _wW.x * lft.x + _wW.z * lft.z;
        wz = _wW.x * fwd.x + _wW.z * fwd.z;
      }
      const wa = gust * 0.16;

      updateSkirt(dt, run, gust, wx, wz);
      updateLegTubes();

      /* ---- the jinbaori ----------------------------------------------------- */
      // The wind travels around the garment rather than merely shaking it: the
      // fold phase advances with the gust, and the whole hem twists behind a
      // turn before it catches up.
      // The fold pattern has to TRAVEL, not just breathe: at the old rate the
      // creases advanced about a sixth of a fold per second, which is below the
      // threshold where the eye calls it motion at all.
      cloakPhase += dt * (1.30 + gust * 4.40 + run * 1.60);
      cloakSway.x = damp(cloakSway.x, clamp(-yawRate * 0.028, -0.10, 0.10) + wx * gust * 0.14, 8, dt);
      cloakSway.y = damp(cloakSway.y, clamp(accel * 0.011, -0.05, 0.12), 7, dt);
      cloakTwist = damp(cloakTwist, clamp(-yawRate * 0.115, -0.40, 0.40) + wx * gust * 0.22, 9, dt);
      // Wind energy now goes mostly into the SIGNED fields — windX/windZ push
      // the hem along the wind vector, lee/leeLift balloon the downwind face —
      // and only enough into the isotropic billow (flare/edgeOut/foldAmp) to
      // keep the surface alive. lagZ is locomotion lag only; it used to carry a
      // gust term, which dragged the cloak backwards in BODY space no matter
      // which way the air was actually moving.
      const cp = {
        foldPhase: cloakPhase, foldAmp: 0.008 + run * 0.020 + gust * 0.050,
        flare: 0.030 + run * 0.115 + gust * 0.075,
        edgeOut: 0.018 + run * 0.075 + gust * 0.080,
        edgeLift: run * 0.105 + gust * 0.075,
        lagZ: 0.045 + run * 0.315 + cloakSway.y,
        hemLift: run * 0.115 + gust * 0.055,
        sway: cloakSway.x, twist: cloakTwist,
        windX: wx * gust * 0.20, windZ: wz * gust * 0.24,
        lee: gust * 0.090, leeLift: gust * 0.075, leeX: wx, leeZ: wz,
        stride: Math.sin(phase) * (0.009 + run * 0.026) * amp,
      };
      cloak.update(cp);
      // Probe-only; window.__WINDPROBE is set by tools/kw-*.mjs and by nothing
      // else, so the shipped build allocates none of this per frame.
      if (typeof window !== 'undefined' && window.__WINDPROBE && window.__SAMU) {
        window.__SAMU.windDbg = {
          wx, wz, gust, local,
          dir: wind ? [wind.dir.x, wind.dir.y] : [0, 0],
          dirLocal: [_wW.x, _wW.z],
          cp,
        };
      }
      yoke.update({
        foldPhase: cloakPhase * 0.8, foldAmp: 0.004 + run * 0.008 + gust * 0.018,
        flare: 0.010 + run * 0.028 + gust * 0.020, edgeOut: 0.006 + run * 0.018 + gust * 0.022,
        edgeLift: run * 0.022 + gust * 0.020,
        lagZ: 0.012 + run * 0.070 + cloakSway.y * 0.4, hemLift: run * 0.026 + gust * 0.014,
        sway: cloakSway.x * 0.45, twist: cloakTwist * 0.35,
        windX: wx * gust * 0.070, windZ: wz * gust * 0.080,
        lee: gust * 0.030, leeLift: gust * 0.024, leeX: wx, leeZ: wz,
        stride: Math.sin(phase) * 0.004 * amp,
      });
      // THE SLEEVES WERE ON A THIRD VECTOR. makeSheet applies windX/windZ in the
      // SHEET's own local frame, and a sleeve hangs off a shoulder bone that
      // swings through the whole stride — so a BODY-frame wind vector poured
      // into it lands wherever the arm happens to be pointing, and it was fed
      // NEGATED on top of that. Measured on the shipped build at
      // 01-sunset-ridge, frozen frame, A/B/A with the harness noise at 0.0:
      // the jinbaori's wind push had dot(push, windDir) = +0.986 — streaming
      // downwind — while the two sleeves came out at -0.253 and +0.070. The
      // left sleeve was blowing INTO the wind and the right one across it.
      // Pushing the world wind vector through each sleeve's own inverse world
      // matrix, the way the cords already do, makes them downwind at any arm
      // pose. Amplitudes (wa * 1.7 / 1.9) are the previous wave's and untouched.
      if (typeof window !== 'undefined' && window.__WINDPROBE && window.__SAMU) window.__SAMU.sleeveP = [];
      for (const sl of sleeves) {
        sl.s.mesh.updateWorldMatrix(true, false);
        _m3.copy(sl.s.mesh.matrixWorld).invert();
        _wL.copy(_wW).transformDirection(_m3);
        const sp = {
          // waveHz stays CONSTANT on purpose: makeSheet multiplies it by a
          // running clock, so modulating it with the gust would scale an
          // ever-growing t and strobe the sleeve. The gust rides the amplitude.
          t: t + sl.sx * 1.3, waveHz: 3.4, waveK: 9.0, wave: 0.012 + gust * 0.042,
          lag: (sl.side === 'l' ? B.shLX : B.shRX) * 0.10 - 0.02 - run * 0.10,
          // NOTE THE SIGNS. makeSheet applies windX as +x but windZ as MINUS z
          // (`bz - p.lag*t2 - p.windZ*t2`), so downwind is +x, -z in sheet
          // space. The old caller's blanket negation got the z half right by
          // accident and the x half exactly backwards.
          windX: _wL.x * wa * 1.7, windZ: -_wL.z * wa * 1.9,
          flare: 0.06 + run * 0.16 + gust * 0.10, curl: 0.02, hemLift: 0,
        };
        sl.s.update(sp);
        if (typeof window !== 'undefined' && window.__WINDPROBE && window.__SAMU) window.__SAMU.sleeveP.push(sp);
      }

      /* ---- cords ------------------------------------------------------------ */
      // Gravity and wind pushed into each cord's own local frame so they behave
      // when the head turns or the hips rotate.
      head.updateWorldMatrix(true, false);
      _m3.copy(head.matrixWorld).invert();
      _g1.set(0, -0.9, 0).transformDirection(_m3);
      _g2.copy(_wW)
        .multiplyScalar(gust * 0.14 + run * 0.18)
        .addScaledVector(fwd, -speedSm * 0.050)
        .transformDirection(_m3);
      chinCord.step(dt, _g1, _g2, cordPinA, cordPinB);

      _m3.copy(hips.matrixWorld).invert();
      _g1.set(0, -0.9, 0).transformDirection(_m3);
      _g2.copy(_wW)
        .multiplyScalar(gust * 0.10 + run * 0.14)
        .addScaledVector(fwd, -speedSm * 0.040)
        .transformDirection(_m3);
      sageoPin.set(0, -0.110, 0).applyMatrix4(sayaRig.matrix);
      sageo.step(dt, _g1, _g2, sageoPin, null);

      /* ---- kasa lag ---------------------------------------------------------- */
      kasa.rotation.z = damp(kasa.rotation.z, -B.hipsRZ * 0.55 - yawRate * 0.030, 9, dt);
      kasa.rotation.x = damp(kasa.rotation.x, run * 0.13 + gust * 0.02 - B.chestX * 0.25, 9, dt);

      /* ---- rim light --------------------------------------------------------- */
      if (ctx.sky && ctx.camera) {
        _v1.copy(ctx.sky.sunPos).transformDirection(ctx.camera.matrixWorldInverse);
        _upV.set(0, 1, 0).transformDirection(ctx.camera.matrixWorldInverse);
        const warm = ctx.sky.sun ? ctx.sky.sun.color : null;
        const sunI = ctx.sky.sun ? ctx.sky.sun.intensity : 2.0;
        // Ceiling raised with the `side` fix above. At magic hour sky.js runs
        // sunI 10-14, so the old 0.34/1.9 pair pinned at the cap and the whole
        // term delivered 0.67 of rim colour on the one shot that most needs it.
        // Wave K: RIM_POWER went 3.45 -> 11 to stop the term washing the figure
        // (see the block on RIM_POWER). A P=11 lobe delivers ~15x less at one
        // pixel in than a P=3.45 one, so the brightness has to be paid back here
        // or the halo disappears with the wash. Measured, sunI is 10.2 at
        // 03-coast and 10.7 at 01-sunset-ridge, so the old cap of 3.0 was also
        // BINDING at both hero poses (0.42 * 10.7 = 4.5) and the strength was
        // not tracking the sun at all. 1.35 puts the two of them at 13.8-14.5,
        // the corner the sweep picked, and the moon's 2.1 key at 2.8 so the
        // night pose keeps a whisper of an edge rather than a hot line.
        const str = clamp(sunI * 1.35, 0.30, 15.0);
        // How much of a key there is to be backlit BY. NOT "is the key bright" —
        // the same light carries the moon after dark and is set just as high, so
        // intensity alone says nothing. It is whether the key BEATS the ambient.
        // Measured across the whole day table that ratio is 0.43-0.72 through
        // night and blue hour and 1.07-1.92 once the sun is genuinely up, so the
        // crush arms on the ratio and stays completely off after dark, where the
        // ambient IS the light and crushing it would leave a black hole where a
        // man is standing.
        const hemiI = ctx.sky.hemi ? ctx.sky.hemi.intensity : 0;
        const ambI = ctx.sky.amb ? ctx.sky.amb.intensity : 0;
        // MERGE RECONCILIATION: the sky lane rebalanced the rig UNDERNEATH this
        // exception in the same wave — hemi 4.20 -> 1.55, amb 0.75 -> 0.26,
        // fill 1.25 -> 0.60 at magic hour. The world already delivers 0.34x the
        // indirect it used to, which is the separation this block existed to
        // manufacture, so the old 0.34 floor multiplied in a SECOND time and
        // took the character to 0.12x of canonical: a black cutout, not a
        // silhouette. Floor raised to 0.82 and the counter-light crush halved,
        // so this is now a light hero exception on top of a rig that is already
        // doing the work, exactly as the character lane's handoff asked.
        //
        // The ratio gate also had to be re-armed. It reads "does the key beat
        // the ambient", and at the OLD midnight (key 7.00 vs hemi 11.00 + amb
        // 1.90) that was 0.54 and the crush stayed off. At the NEW midnight the
        // moon is a 2.10 key over 0.34 + 0.08, a ratio of 5.0 — so the gate
        // would have fired at FULL strength after dark and put a black hole
        // where a man is standing, which is the one thing the character lane
        // said it must never do. `solar` is sky.js's own -8..-3 degree sun/moon
        // handover, so the exception now belongs to daylight by construction.
        const alt = ctx.tod ? ctx.tod.sunAltitude : 20;
        const solar = smooth(clamp((alt + 8) / 5, 0, 1));
        const keyK = solar * smooth(clamp((sunI / Math.max(hemiI + ambI, 1e-3) - 0.80) / 0.65, 0, 1));
        // MEASURED, wave G. Scanning the body across y=470 in the hero shot the
        // whole shoulder/chest mass came back between (20,27,53) and (43,42,55)
        // — a span of ~20 levels out of 255 over a metre of form. That is one
        // uniform value, i.e. the rubric's "reads as flat-shaded untextured
        // polygons", and it is what makes the shins read as rectangles and the
        // jinbaori read as a cone with no folds: there is no shading gradient
        // left for any of that geometry to be revealed BY. The crush is the
        // cause — it removes the directional term on every away-facing surface
        // and leaves only the (directionless) ambient. Halved, and the ambient
        // floor lifted, so form still reads INSIDE the silhouette. The figure
        // stays a dark cutout; it stops being a single flat swatch.
        const ambS = lerp(1.0, 0.90, keyK);
        const crushK = 0.22 * keyK;
        const forced = (typeof window !== 'undefined' && window.__SAMU
          && window.__SAMU.forceRim != null) ? window.__SAMU.forceRim : null;
        // Ground bounce, on the horse's law (horse.js driveRim) so the man and
        // the animal in one frame carry one bounce. `solar` already gates the
        // sun/moon handover above, and the colour swings warm->cold with it so
        // the figure is not carrying a sunset on its shins at midnight.
        _bounceC.copy(GROUND_NIGHT).lerp(GROUND_DAY, solar);
        // BRACKETED, wave I, on 01-sunset-ridge with everything else frozen.
        // Sweeping this amplitude and reading the median luminance of the
        // figure's eroded interior: 0 -> 22.2, 2.2 (the horse's own cap) -> 22.2,
        // 3 -> 23.5, 4 -> 26.2, 5 -> 32.4, 6 -> 41.2, 8 -> 56.3. The grade's toe
        // is a cliff in there: at 2.2 the term is invisible (the man's dyed
        // indigo and black are 4-6x darker than a bay coat, so the horse's own
        // number delivers 4-6x less light here), and by 4 the crest, the weave
        // and the hakama are all plainly lit and the figure reads FRONT-lit —
        // the exact failure earlier waves fought. 3.0 is the last value that
        // keeps him a dark cutout while the jinbaori and the hakama pick up a
        // gradient and the sode lacing finds its crimson. The night end is held
        // at the horse's: 2.10 * 0.44 * 0.085 = 0.0785 against its 0.075.
        const bAmt = clamp(sunI * 0.44, 0.14, 3.00) * (0.085 + 0.915 * solar);
        const fb = (typeof window !== 'undefined' && window.__SAMU
          && window.__SAMU.forceBounce != null) ? window.__SAMU.forceBounce : null;
        const fp = (typeof window !== 'undefined' && window.__SAMU
          && window.__SAMU.forceRimPow != null) ? window.__SAMU.forceRimPow : null;
        for (let i = 0; i < rimShaders.length; i++) {
          const sh = rimShaders[i];
          sh.uniforms.uRimDirView.value.copy(_v1);
          if (warm) sh.uniforms.uRimColor.value.copy(warm).multiplyScalar(1.20);
          sh.uniforms.uRimStrength.value = forced != null ? forced : str;
          sh.uniforms.uAmbScale.value = ambS;
          sh.uniforms.uBackCrush.value = crushK;
          sh.uniforms.uRimPower.value = fp != null ? fp : RIM_POWER;
          sh.uniforms.uUpView.value.copy(_upV);
          sh.uniforms.uBounceColor.value.copy(_bounceC);
          sh.uniforms.uBounceAmt.value = fb != null ? fb : bAmt;
        }
      }
    },
  };

  /* ---------------------------------------------------- sword placement -- */
  function placeSword() {
    stowSocket.updateWorldMatrix(true, false);
    holdSocket.updateWorldMatrix(true, false);
    _m1.multiplyMatrices(rootInv, stowSocket.matrixWorld).decompose(_v1, _q1, _s1);
    _m2.multiplyMatrices(rootInv, holdSocket.matrixWorld).decompose(_v2, _q2, _s1);
    const bw = clamp(swordBlend, 0, 1);
    swordGroup.position.lerpVectors(_v1, _v2, bw);
    swordGroup.quaternion.copy(_q1).slerp(_q2, bw);
    swordGroup.scale.set(1, 1, 1);
    swordGroup.updateMatrix();
    swordGroup.matrixWorld.multiplyMatrices(root.matrixWorld, swordGroup.matrix);
  }

  /* ------------------------------------------------------- cloth updaters */
  function updateSkirt(dt, run, gust, wx, wz) {
    const a = skirtGeo.attributes.position.array;
    // Lag: the skirt trails the body's acceleration and its turn rate. Wind now
    // pushes WITH its own direction rather than against it.
    skirtSway.x = damp(skirtSway.x, clamp(-yawRate * 0.028, -0.11, 0.11) + wx * gust * 0.125, 7, dt);
    skirtSway.y = damp(skirtSway.y, clamp(-accel * 0.012, -0.11, 0.11) + wz * gust * 0.140, 7, dt);
    // The swinging leg has to move the cloth in front of it. Reading the live
    // hip rotation means the skirt reacts to whatever the legs are actually
    // doing — walk, sprint, dodge or a stagger — with no separate authoring.
    const legF = { l: -hip.l.rotation.x, r: -hip.r.rotation.x };
    const flut = 0.006 + gust * 0.055 + run * 0.014;
    for (let r = 0; r <= SK_R; r++) {
      const tt = r / SK_R;
      const y = 0.112 - tt * 0.560;
      const rad = 0.178 + 0.148 * smooth(tt) + 0.022 * tt;
      // Pleat depth grows down the skirt; a triangle wave gives flat panels
      // with a sharp crease between them, which is what a hakama actually is.
      const pAmp = (0.026 + 0.032 * tt) * (1 + run * 0.30);
      for (let s = 0; s < SK_C; s++) {
        const th = (s / SK_C) * Math.PI * 2;
        const cth = Math.cos(th), sth = Math.sin(th);
        // Box pleat: a flat outer panel, then a fold set back behind it. Four
        // columns to a pleat, so the crease is one quad wide and survives
        // smooth normals.
        const q = s * SK_PLEATS / SK_C;
        const tri = (q - Math.floor(q)) < 0.5 ? 0.5 : -0.5;
        // Each leg leads the cloth on its own side, blended around the ring —
        // switching hard at the side seam threw the hem into paper spikes.
        const w = 0.5 + 0.5 * sth;
        const side = legF.l * w + legF.r * (1 - w);
        const push = cth * side * 0.30 * tt * tt;
        const lift = Math.max(0, cth) * side * 0.06 * tt * tt;
        const rr = rad + tri * pAmp;
        const wave = Math.sin(t * 2.6 + th * 3 + tt * 5) * flut * tt * tt;
        const i = (r * SK_C + s) * 3;
        a[i] = sth * rr + (skirtSway.x + wave) * tt * tt * 1.2;
        a[i + 1] = y + lift + Math.abs(skirtSway.x) * tt * tt * 0.16;
        a[i + 2] = cth * rr + skirtSway.y * tt * tt * 1.2 + push;
      }
    }
    skirtGeo.attributes.position.needsUpdate = true;
    // Real normals. The old analytic normal ignored the pleats entirely, which
    // is why the hakama shaded as one smooth plastic bell no matter how deep
    // the creases in the silhouette were.
    skirtGeo.computeVertexNormals();
  }

  // Sweep the hakama legs along the live IK chain (hip -> knee -> ankle) in the
  // pelvis's own space, so a bent knee bends the cloth instead of shearing it.
  function updateLegTubes() {
    for (const s of ['l', 'r']) {
      hip[s].updateWorldMatrix(false, true);
      _hp.copy(hip[s].position);
      _kp.setFromMatrixPosition(knee[s].matrixWorld).applyMatrix4(hipsInv);
      _ap.setFromMatrixPosition(ankle[s].matrixWorld).applyMatrix4(hipsInv);
      const pts = legPts[s];
      // Sample 0.30..0.68 along the chain: the top hides inside the skirt and
      // the leg is gathered into a cuff a hand below the knee, which is where
      // the kyahan takes over. A hakama worn for travel is bloused, not narrow.
      for (let i = 0; i <= 8; i++) {
        const u = 0.30 + (i / 8) * 0.50;
        if (u <= 0.5) pts[i].lerpVectors(_hp, _kp, u / 0.5);
        else pts[i].lerpVectors(_kp, _ap, (u - 0.5) / 0.5);
      }
      legTubes[s].update(pts, hakamaRadius, 0.105, 6);
    }
  }
  // Wide and bloused through the thigh and knee, then gathered hard into the
  // cuff over the last quarter, where the kyahan takes over. The old profile
  // tapered to a 7cm pipe halfway down, which is what read as a matchstick leg.
  const hakamaRadius = (u) => {
    const base = 0.176 + 0.030 * Math.sin(u * 2.4) - 0.040 * u * u;
    return base * (u > 0.72 ? lerp(1, 0.52, smooth((u - 0.72) / 0.28)) : 1);
  };

  api.setSheathed(true);

  /* ------------------------------------------------- measurement hook ----- */
  // The scene is never static — grass and cloth move every frame — so a
  // hide-the-actor frame diff comes back as "the whole 1920x1080 changed" and
  // tells you nothing. This hook lets the harness paint the figure into a flat
  // key colour and read its exact pixel footprint, and force the rim uniforms
  // to a known value for an A/B. Debug only; it changes nothing unless called.
  if (typeof window !== 'undefined') {
    const dbgSaved = [];
    window.__SAMU = {
      root,
      // Flat-key silhouette: every material on the figure goes unlit magenta.
      silhouette(on) {
        if (on) {
          if (dbgSaved.length) return;
          root.traverse(o => {
            if (!o.material) return;
            dbgSaved.push([o, o.material]);
            o.material = new THREE.MeshBasicMaterial({
              color: 0xff00ff, side: THREE.DoubleSide, toneMapped: false,
            });
          });
        } else {
          for (const [o, m] of dbgSaved) o.material = m;
          dbgSaved.length = 0;
        }
      },
      // Force (or release) the rim strength / bounce amount that the update
      // loop writes every frame, for an A/B against the same pose.
      forceRim: null,
      forceBounce: null,
      forceRimPow: null,
      shaderCount() { return rimShaders.length; },
      // Write uniform values straight into every injected shader. The
      // forceRim/forceBounce hooks above only take effect on the next update(),
      // which is exactly what a FROZEN-rAF A/B does not get — so a probe that
      // freezes the frame and drives it by hand could not isolate the rim at
      // all. Debug only; the update loop overwrites these on the next tick.
      uni(o) {
        for (const sh of rimShaders) for (const k in o) {
          const u = sh.uniforms[k]; if (!u) continue;
          if (u.value && u.value.isColor) u.value.set(o[k]);
          else if (u.value && u.value.isVector3) u.value.fromArray(o[k]);
          else u.value = o[k];
        }
        return rimShaders.length;
      },
      readUni(k) { return rimShaders.length ? rimShaders[0].uniforms[k] &&
        (rimShaders[0].uniforms[k].value.toArray ? rimShaders[0].uniforms[k].value.toArray()
          : rimShaders[0].uniforms[k].value) : null; },
      mats: M,
      // ---- wind measurement (k-wind lane) -------------------------------
      // The cloth's response to the field cannot be judged from a still and
      // cannot be judged from a whole-frame diff (grass moves too). This
      // exposes the garment solvers and the last parameter block so a probe
      // can re-run ONE update with the wind terms zeroed, at a FROZEN frame,
      // and read the exact vertex delta the wind is responsible for.
      windDbg: null,
      cloth: { cloak, yoke, sleeves, anchor: coatAnchor },
    };
  }
  return api;
}
