import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../util/rng.js';

// =============================================================================
//  ENEMIES — Mongol raiders and island bandits.
//
//  Everything here is procedural: bodies are bone hierarchies with shared
//  geometry and one material set per faction, so a dozen fighters on screen
//  costs a dozen skeletons' worth of draw calls and nothing else.
//
//  The behaviour is a layered stack, cheapest first:
//    perception  — view cone + distance falloff + terrain line-of-sight + hearing
//    alertness   — one meter, four readable states (unaware/suspicious/search/engaged)
//    navigation  — context steering over real terrain, refuses steep ground and water
//    squad       — a director that hands out at most two attack tokens, the rest circle
//    combat      — telegraphed attacks with parry tells, unblockables in red,
//                  blocks, dodges, poise, stagger, knockdown, death
//
//  Ground truth is world.heightAt / normalAt / slopeAt. Nothing here ever
//  places a body at a y it did not read from the terrain.
// =============================================================================

const TAU = Math.PI * 2;
const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
const damp = THREE.MathUtils.damp;
const smooth = THREE.MathUtils.smoothstep;

// Shortest-arc difference in (-PI, PI].
const angleDelta = (from, to) =>
  THREE.MathUtils.euclideanModulo(to - from + Math.PI, TAU) - Math.PI;

// =============================================================================
//  MATERIALS
//  One rim-light injection shared by every enemy material. At golden hour a
//  figure between you and the sun is a black cutout; the lit edge is what makes
//  a raider read as a raider at forty metres.
// =============================================================================

const RIM_SHADERS = [];

// Defined once so three's program cache sees one shader variant, not N.
function onBeforeCompile(sh) {
  sh.uniforms.uRimColor = { value: new THREE.Color('#ffb877') };
  sh.uniforms.uRimDirView = { value: new THREE.Vector3(0, 0, 1) };
  sh.uniforms.uRimPower = { value: 2.4 };
  sh.uniforms.uRimStrength = { value: 1.0 };
  // Uniforms must be DECLARED in the GLSL, not merely attached to sh.uniforms,
  // or the program silently fails to compile and the body vanishes.
  sh.fragmentShader =
    'uniform vec3 uRimColor;\nuniform vec3 uRimDirView;\n' +
    'uniform float uRimPower;\nuniform float uRimStrength;\n' + sh.fragmentShader;
  sh.fragmentShader = sh.fragmentShader.replace(
    '#include <opaque_fragment>',
    `{
       vec3 rimV = normalize(vViewPosition);
       float rim = pow(1.0 - clamp(dot(normalize(normal), rimV), 0.0, 1.0), uRimPower);
       float back = clamp(dot(-uRimDirView, rimV), 0.0, 1.0);
       outgoingLight += uRimColor * rim * (0.16 + 0.84 * back) * uRimStrength;
     }
     #include <opaque_fragment>`
  );
  RIM_SHADERS.push(sh);
}

function rimMat(spec) {
  const m = new THREE.MeshStandardMaterial(spec);
  m.onBeforeCompile = onBeforeCompile;
  return m;
}

// Mongol: dark olive deel, black lacquer lamellar with ochre lacing, fur.
// Deliberately nothing indigo and nothing crimson — those are the player's.
//
// VALUE, not hue, is what makes a body legible, and this scene is graded very
// hot: at golden hour a mid-grey albedo lands on screen as pure white. The old
// #7c6d4c deel measured 235/232/224 in a render — a white cone with a black
// hat on it, which is exactly the failure this file was handed. Every cloth
// value here is roughly half what it was, so a raider is a DARK mass against a
// blown-out gold field with one small light accent (fur, ochre, bare steel)
// that draws the eye to the head and the weapon. Mongols are dark-with-ochre;
// bandits are the inverse, mid hemp under a near-black hat; the player is
// near-black indigo. Three reads that cannot be confused for one another.
const PALETTE = {
  mongol: {
    cloth:   { color: '#5a4e35', roughness: 0.95 },   // dark olive deel
    cloth2:  { color: '#332c20', roughness: 0.95 },   // sleeves, trousers, wrap
    plate:   { color: '#1b1715', roughness: 0.44, metalness: 0.30 },  // black lacquer
    lace:    { color: '#9a6d26', roughness: 0.78 },   // ochre lamellar lacing
    fur:     { color: '#786745', roughness: 0.97 },   // the one light mass
    leather: { color: '#1c1710', roughness: 0.90 },
    steel:   { color: '#c3ccd6', roughness: 0.30, metalness: 0.38 },
    skin:    { color: '#96694a', roughness: 0.82 },
    hair:    { color: '#100e0d', roughness: 0.96 },
    accent:  { color: '#7c2112', roughness: 0.82 },
    wood:    { color: '#332516', roughness: 0.93 },
  },
  bandit: {
    cloth:   { color: '#8a7b58', roughness: 0.96 },   // sun-bleached hemp
    cloth2:  { color: '#23271e', roughness: 0.95 },   // near-black moss vest + hat
    plate:   { color: '#2a2419', roughness: 0.76, metalness: 0.04 },
    lace:    { color: '#6b3c1a', roughness: 0.92 },
    fur:     { color: '#8a7752', roughness: 0.96 },
    leather: { color: '#1c1710', roughness: 0.92 },
    steel:   { color: '#bcc4ce', roughness: 0.34, metalness: 0.34 },
    skin:    { color: '#96694a', roughness: 0.82 },
    hair:    { color: '#12100f', roughness: 0.96 },
    accent:  { color: '#4e411e', roughness: 0.92 },
    wood:    { color: '#3a2b18', roughness: 0.93 },
  },
};

const MATS = {};
function materials(faction) {
  if (MATS[faction]) return MATS[faction];
  const src = PALETTE[faction];
  const out = {};
  for (const k in src) out[k] = rimMat(src[k]);
  MATS[faction] = out;
  return out;
}

// =============================================================================
//  GEOMETRY CACHE
//  Every raider shares the same forearm. Build it once.
// =============================================================================

const GEO = new Map();
function cached(key, build) {
  let g = GEO.get(key);
  if (!g) { g = build(); GEO.set(key, g); }
  return g;
}

// Tapered segment hanging from the joint down +Y-negative.
function limbGeo(len, rTop, rBot, seg = 7) {
  return cached(`L${len}|${rTop}|${rBot}|${seg}`, () => {
    const g = new THREE.CylinderGeometry(rTop, rBot, len, seg, 1);
    g.translate(0, -len / 2, 0);
    return g;
  });
}

// Box with the bottom edge pinched, so plates read as lamellar rather than bricks.
function plateGeo(w, h, d, bevel = 0.86) {
  return cached(`P${w}|${h}|${d}|${bevel}`, () => {
    const g = new THREE.BoxGeometry(w, h, d);
    if (bevel < 1) {
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        if (p.getY(i) < 0) { p.setX(i, p.getX(i) * bevel); p.setZ(i, p.getZ(i) * (bevel + 0.02)); }
      }
      g.computeVertexNormals();
    }
    return g;
  });
}

function coneGeo(rTop, rBot, h, seg = 12, open = true) {
  return cached(`C${rTop}|${rBot}|${h}|${seg}|${open}`, () =>
    new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open));
}

function sphereGeo(r, w = 10, h = 8) {
  return cached(`S${r}|${w}|${h}`, () => new THREE.SphereGeometry(r, w, h));
}

// A blade: box segmented along its length, bowed sideways by `curve`, tapering
// to a point. One helper covers sabre, katana, naginata and spear head.
function bladeGeo(len, width, thick, curve, taper = 0.35) {
  return cached(`B${len}|${width}|${thick}|${curve}|${taper}`, () => {
    const segs = 10;
    const g = new THREE.BoxGeometry(width, len, thick, 1, segs, 1);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      const u = clamp((y + len / 2) / len, 0, 1);       // 0 = ricasso, 1 = tip
      const w = lerp(1, taper, u * u);
      p.setX(i, p.getX(i) * w + curve * u * u * len * 0.5);
      p.setZ(i, p.getZ(i) * lerp(1, 0.45, u));
    }
    g.computeVertexNormals();
    g.translate(0, len / 2, 0);                          // grow upward from the grip
    return g;
  });
}

function mesh(geo, mat) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = false;
  return m;
}

// =============================================================================
//  STATIC-PART BUILDER
//  A body is forty-odd little boxes and cylinders. Left as individual meshes
//  that is forty draw calls per fighter, paid twice over because they also cast
//  shadows, and a dozen raiders was measurably the most expensive thing in the
//  frame. Anything that never moves relative to its bone goes through here and
//  comes back out as ONE merged mesh per (bone, material) — roughly a 55% cut
//  in submissions with no visual difference at all.
// =============================================================================

const _bm = new THREE.Matrix4();
const _be = new THREE.Euler();
const _bq = new THREE.Quaternion();
const _bp = new THREE.Vector3();
const _bs = new THREE.Vector3();

// Merged geometry is identical for every body of a kind — nothing in the static
// layer is randomised — so it is built once and shared. Without this cache the
// merge cost is paid per body and a five-strong squad activating as the player
// walks into its radius costs 8 ms in one frame: a visible hitch at the worst
// possible moment. Measured 2.2 ms for the first raider, 0.2 ms for every
// raider after it.
const BODY_CACHE = new Map();          // kind -> [{ bone, mat, geo }]

function makeBuilder(kind) {
  const cached = BODY_CACHE.get(kind);
  const buckets = new Map();           // bone -> Map(material -> [geometry])
  return {
    cached: !!cached,
    // p / r / s are plain arrays so a caller never allocates a Vector3.
    add(bone, geo, mat, p, r, sc) {
      if (cached) return;              // already merged for this archetype
      _bp.set(p ? p[0] : 0, p ? p[1] : 0, p ? p[2] : 0);
      _be.set(r ? r[0] : 0, r ? r[1] : 0, r ? r[2] : 0);
      _bq.setFromEuler(_be);
      _bs.set(sc ? sc[0] : 1, sc ? sc[1] : 1, sc ? sc[2] : 1);
      _bm.compose(_bp, _bq, _bs);
      const g = geo.clone().applyMatrix4(_bm);
      let byMat = buckets.get(bone);
      if (!byMat) { byMat = new Map(); buckets.set(bone, byMat); }
      let arr = byMat.get(mat);
      if (!arr) { arr = []; byMat.set(mat, arr); }
      arr.push(g);
    },
    flush(out, bones) {
      if (cached) {
        for (const rec of cached) {
          const m = mesh(rec.geo, rec.mat);
          bones[rec.bone].add(m); out.push(m);
        }
        return;
      }
      const record = [];
      for (const [bone, byMat] of buckets) {
        for (const [mat, arr] of byMat) {
          let g = arr[0];
          if (arr.length > 1) {
            const merged = mergeGeometries(arr, false);
            // mergeGeometries returns null if the attribute sets disagree.
            // Falling back to loose meshes is ugly but it is never invisible.
            if (merged) { for (const one of arr) one.dispose(); g = merged; }
            else {
              for (const one of arr) { const m = mesh(one, mat); bone.add(m); out.push(m); }
              continue;
            }
          }
          const m = mesh(g, mat);
          bone.add(m); out.push(m);
          record.push({ bone: bone.name, mat, geo: g });
        }
      }
      buckets.clear();
      BODY_CACHE.set(kind, record);
    },
  };
}

// =============================================================================
//  WEAPONS
//  Each returns a group whose origin is the grip, blade running up +Y, plus
//  the meshes that should glow during a telegraph.
//
//  The telegraph "sheath" is a fattened proxy of the blade, because a 12 mm
//  katana edge is sub-pixel at combat range. It used to be fattened to THREE
//  AND A HALF times the blade's width and seven times its thickness, and the
//  result was not a glowing sword, it was a glowing plank: through bloom and
//  the god-ray pass a 0.66 m naginata tell became a column of orange reaching
//  into the cloud deck. A proxy only has to be wide enough to survive the
//  resolve — roughly two blade-widths — so every one below is pulled back to
//  about 2x wide and 3x thick. Same job, inside the grade.
// =============================================================================

function buildWeapon(kind, M, tellMat, cfg = {}) {
  const g = new THREE.Group();
  const glow = [];
  const banner = [];
  const add = (m, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
    m.position.set(x, y, z); m.rotation.set(rx, ry, rz); g.add(m); return m;
  };

  if (kind === 'sabre') {
    add(mesh(limbGeo(0.20, 0.017, 0.020, 6), M.leather), 0, 0.20, 0);
    add(mesh(cached('sabreGuard', () => new THREE.CylinderGeometry(0.038, 0.038, 0.014, 8)), M.steel), 0, 0.20, 0);
    const b = add(mesh(bladeGeo(0.82, 0.048, 0.014, 0.30), M.steel), 0, 0.20, 0);
    glow.push(b);
    const sheath = add(mesh(bladeGeo(0.82, 0.096, 0.042, 0.30), tellMat), 0, 0.20, 0);
    glow.push(sheath); g.userData.tellMesh = sheath;
  } else if (kind === 'katana') {
    add(mesh(limbGeo(0.26, 0.018, 0.021, 6), M.lace), 0, 0.26, 0);
    add(mesh(cached('tsuba', () => new THREE.CylinderGeometry(0.042, 0.042, 0.011, 10)), M.steel), 0, 0.26, 0);
    const b = add(mesh(bladeGeo(0.78, 0.040, 0.012, 0.16), M.steel), 0, 0.26, 0);
    glow.push(b);
    const sheath = add(mesh(bladeGeo(0.78, 0.082, 0.038, 0.16), tellMat), 0, 0.26, 0);
    glow.push(sheath); g.userData.tellMesh = sheath;
  } else if (kind === 'spear') {
    add(mesh(limbGeo(2.05, 0.020, 0.022, 6), M.wood), 0, 1.35, 0);
    add(mesh(cached('spearCollar', () => new THREE.CylinderGeometry(0.030, 0.026, 0.06, 8)), M.steel), 0, 1.35, 0);
    const b = add(mesh(bladeGeo(0.34, 0.052, 0.016, 0, 0.05), M.steel), 0, 1.36, 0);
    glow.push(b);
    // A red tassel under the head — a spear tip is small, this is what carries it.
    add(mesh(coneGeo(0.03, 0.005, 0.13, 7, true), M.accent), 0, 1.30, 0);
    if (cfg.pennon) {
      // A pennon on the shaft. Four pixels of spear tip say nothing across a
      // meadow; a hand of cloth snapping in the wind says spearman instantly.
      for (let i = 0; i < 2; i++) {
        const pn = add(mesh(plateGeo(0.175, 0.20 - i * 0.05, 0.006, 1), M.accent),
          0.088, 1.14 - i * 0.19, -0.02);
        banner.push(pn);
      }
    }
    const sheath = add(mesh(bladeGeo(0.42, 0.100, 0.048, 0, 0.05), tellMat), 0, 1.24, 0);
    glow.push(sheath); g.userData.tellMesh = sheath;
  } else if (kind === 'axe') {
    add(mesh(limbGeo(0.98, 0.026, 0.030, 6), M.wood), 0, 0.86, 0);
    // Crescent head: two wedges plus a spike, so the silhouette is unmistakable.
    const h1 = add(mesh(plateGeo(0.30, 0.26, 0.035, 0.35), M.steel), 0.13, 0.80, 0, 0, 0, -0.22);
    const h2 = add(mesh(plateGeo(0.16, 0.30, 0.032, 0.45), M.steel), 0.05, 0.86, 0, 0, 0, 0.16);
    const sp = add(mesh(coneGeo(0.008, 0.032, 0.20, 6, false), M.steel), -0.07, 0.86, 0, 0, 0, 1.35);
    glow.push(h1, h2, sp);
    const sheath = add(mesh(plateGeo(0.38, 0.36, 0.085, 1), tellMat), 0.10, 0.83, 0, 0, 0, -0.10);
    glow.push(sheath); g.userData.tellMesh = sheath;
  } else if (kind === 'naginata') {
    add(mesh(limbGeo(1.60, 0.021, 0.024, 6), M.leather), 0, 1.05, 0);
    for (let i = 0; i < 4; i++) add(mesh(cached('ngRing', () => new THREE.CylinderGeometry(0.028, 0.028, 0.014, 8)), M.steel), 0, 0.25 + i * 0.26, 0);
    const b = add(mesh(bladeGeo(0.66, 0.055, 0.014, 0.34), M.steel), 0, 1.05, 0);
    glow.push(b);
    const sheath = add(mesh(bladeGeo(0.66, 0.108, 0.044, 0.34), tellMat), 0, 1.05, 0);
    glow.push(sheath); g.userData.tellMesh = sheath;
  } else if (kind === 'bow') {
    // Recurve: two arcs meeting at the grip, plus a taut string.
    const arc = cached('bowArc', () => {
      const g2 = new THREE.TorusGeometry(0.34, 0.014, 5, 14, Math.PI * 0.78);
      g2.rotateZ(-Math.PI * 0.39);
      return g2;
    });
    add(mesh(arc, M.wood), 0, 0.34, 0);
    const lower = add(mesh(arc, M.wood), 0, -0.34, 0);
    lower.rotation.z = Math.PI;
    add(mesh(cached('bowString', () => new THREE.BoxGeometry(0.005, 1.10, 0.005)), M.cloth ?? M.leather), 0.20, 0, 0);
    const sheath = add(mesh(cached('bowTell2', () => new THREE.BoxGeometry(0.032, 1.16, 0.032)), tellMat), 0.20, 0, 0);
    glow.push(sheath); g.userData.tellMesh = sheath;
  }
  // A ring at the grip. A blade seen edge-on is two pixels wide; the ring is
  // always facing something, so the telegraph never disappears on a bad angle.
  const ring = mesh(cached('tellRing2', () => {
    const t = new THREE.TorusGeometry(0.19, 0.022, 6, 20);
    t.rotateX(Math.PI * 0.5);
    return t;
  }), tellMat);
  ring.position.y = kind === 'bow' ? 0 : 0.06;
  ring.castShadow = false;
  g.add(ring);
  g.userData.tellRing = ring;
  g.userData.glow = glow;
  g.userData.banner = banner;
  return g;
}

// =============================================================================
//  BODY
//  Bone hierarchy plus the armour and cloth that hangs on it. Proportions and
//  furniture change per archetype so each reads as a distinct black cutout.
// =============================================================================

function buildBody(kind, cfg, rng) {
  const M = materials(cfg.faction);
  const S = cfg.scale;
  const bulk = cfg.bulk ?? 1;

  const root = new THREE.Group();          // sits on the ground
  root.name = 'enemy_' + kind;
  const rig = new THREE.Group();
  rig.scale.setScalar(S);
  root.add(rig);

  const hips = new THREE.Group();   hips.position.y = 0.94;   rig.add(hips);
  const spine = new THREE.Group();  spine.position.y = 0.10;  hips.add(spine);
  const chest = new THREE.Group();  chest.position.y = 0.22;  spine.add(chest);
  const neck = new THREE.Group();   neck.position.y = 0.26;   chest.add(neck);
  const head = new THREE.Group();   head.position.y = 0.09;   neck.add(head);

  const sw = cfg.shoulderWidth ?? 0.205;
  const shoulder = { l: new THREE.Group(), r: new THREE.Group() };
  shoulder.l.position.set(sw, 0.20, 0);   chest.add(shoulder.l);
  shoulder.r.position.set(-sw, 0.20, 0);  chest.add(shoulder.r);
  const elbow = { l: new THREE.Group(), r: new THREE.Group() };
  elbow.l.position.y = -0.30; shoulder.l.add(elbow.l);
  elbow.r.position.y = -0.30; shoulder.r.add(elbow.r);

  const hw = 0.10 * (0.62 + 0.38 * bulk);
  const hip = { l: new THREE.Group(), r: new THREE.Group() };
  hip.l.position.set(hw, 0, 0);  hips.add(hip.l);
  hip.r.position.set(-hw, 0, 0); hips.add(hip.r);
  const knee = { l: new THREE.Group(), r: new THREE.Group() };
  knee.l.position.y = -0.44; hip.l.add(knee.l);
  knee.r.position.y = -0.44; hip.r.add(knee.r);
  const ankle = { l: new THREE.Group(), r: new THREE.Group() };
  ankle.l.position.y = -0.42; knee.l.add(ankle.l);
  ankle.r.position.y = -0.42; knee.r.add(ankle.r);

  // Named so the merged-geometry cache can reattach to the right joint.
  const JOINTS = {
    hips, spine, chest, neck, head,
    shoulderL: shoulder.l, shoulderR: shoulder.r,
    elbowL: elbow.l, elbowR: elbow.r,
    hipL: hip.l, hipR: hip.r, kneeL: knee.l, kneeR: knee.r,
    ankleL: ankle.l, ankleR: ankle.r,
  };
  for (const k in JOINTS) JOINTS[k].name = k;

  // Everything that never moves relative to its bone goes through the builder.
  const B = makeBuilder(kind);
  const put = (bone, geo, mat, p, r, sc) => B.add(bone, geo, mat, p, r, sc);

  // ---- torso -------------------------------------------------------------
  // The ribcage tops out AT the shoulder joints. The previous body ran one
  // unbroken cylinder from the coat hem all the way up past the chin, and that
  // single mistake is why every archetype read as a traffic cone: there was no
  // shoulder line, no neck and no waist anywhere in the silhouette.
  const chestW = 0.172 * bulk;
  put(chest, limbGeo(0.34, chestW, chestW * 0.90, 9), M.cloth, [0, 0.26, 0]);
  // Waist: narrower than the ribcage above it AND the coat below it. That pinch
  // is the whole difference between a man and a bollard at forty metres.
  put(spine, limbGeo(0.34, 0.128 * bulk, 0.150 * bulk, 9), M.cloth, [0, 0.26, 0]);
  put(spine, plateGeo(0.288 * bulk, 0.070, 0.222 * bulk, 1), M.leather, [0, -0.035, 0]);
  put(neck, limbGeo(0.13, 0.052, 0.062, 6), M.skin, [0, 0.05, 0]);

  // The collar. A wide band at shoulder height with a small dark head above it
  // is the entire "armoured man" read once the body is 30 pixels tall.
  if (cfg.collar === 'fur') {
    put(chest, coneGeo(0.205 * bulk, 0.278 * bulk, 0.150, 12, true), M.fur, [0, 0.245, 0]);
  } else if (cfg.collar === 'plate') {
    put(chest, coneGeo(0.192 * bulk, 0.250 * bulk, 0.120, 10, true), M.plate, [0, 0.238, 0]);
    put(chest, coneGeo(0.198 * bulk, 0.212 * bulk, 0.030, 10, true), M.lace, [0, 0.300, 0]);
  } else if (cfg.collar === 'rag') {
    put(chest, coneGeo(0.180 * bulk, 0.238 * bulk, 0.135, 9, true), M.cloth2, [0, 0.242, 0]);
  }

  if (cfg.armour === 'lamellar') {
    put(chest, plateGeo(0.335 * bulk, 0.30, 0.238 * bulk), M.plate, [0, 0.145, 0]);
    for (let i = 0; i < 3; i++) {
      put(chest, plateGeo(0.343 * bulk, 0.026, 0.246 * bulk, 1), M.lace, [0, 0.245 - i * 0.085, 0]);
    }
    // Short lamellar apron off the bottom of the cuirass, tying it to the coat.
    put(chest, plateGeo(0.300 * bulk, 0.145, 0.222 * bulk), M.plate, [0, -0.052, 0]);
  } else if (cfg.armour === 'furmantle') {
    // The brute wears no plate. A pale shaggy mantle over a dark body doubles
    // his shoulder line and makes his head read as a notch cut out of it.
    put(chest, coneGeo(0.200 * bulk, 0.268 * bulk, 0.32, 11, true), M.fur, [0, 0.185, 0]);
    put(chest, plateGeo(0.300 * bulk, 0.062, 0.235 * bulk, 1), M.leather, [0, 0.045, 0], [0, 0, 0.34]);
  } else if (cfg.armour === 'gambeson') {
    // The archer: no plate, a quilted jerkin with a vertical seam so the chest
    // is not one blank cylinder when he is the only thing on screen.
    put(chest, coneGeo(0.178 * bulk, 0.208 * bulk, 0.36, 9, true), M.cloth2, [0, 0.150, 0]);
    put(chest, plateGeo(0.046, 0.34, 0.20 * bulk, 1), M.leather, [0, 0.150, 0.040]);
  } else {
    // Bandit: an open dark vest over pale cloth, and a wide knotted sash.
    put(chest, coneGeo(0.180 * bulk, 0.226 * bulk, 0.40, 9, true), M.cloth2, [0, 0.140, 0]);
    put(spine, plateGeo(0.305, 0.088, 0.232, 1), M.lace, [0, 0.030, 0], [0, 0, 0.20]);
  }

  // ---- lower body --------------------------------------------------------
  // Mongol deel flares to the knee; bandit wears loose ragged trousers. It must
  // overlap the waist at the top and end above the knee at the bottom: a coat
  // that reaches the ground turns the fighter into a bell and the walk cycle
  // disappears inside it.
  const coatLen = cfg.coatLen ?? 0.50;
  const flare = (cfg.coatFlare ?? 0.27) * bulk;
  put(hips, coneGeo(0.178 * bulk, flare, coatLen, 12, true), M.cloth, [0, 0.04 - coatLen * 0.5, 0]);
  // A dark hem band. A cone with a hard terminating edge stops being a cone —
  // and it stops being one much harder if the edge KICKS OUT rather than
  // continuing the taper. The band now flares 14% past the coat, so the
  // bottom of the figure is a lip and a shadow, not a point of a wedge.
  put(hips, coneGeo(flare * 1.005, flare * 1.145, 0.070, 12, true), M.leather,
      [0, 0.04 - coatLen + 0.035, 0]);
  // The diagonal front wrap of a deel, offset forward in the second cloth. It
  // is the one asymmetry on the whole body and it kills the cone read outright.
  put(hips, plateGeo(0.150 * bulk, coatLen * 0.80, 0.032, 1),
      cfg.faction === 'mongol' ? M.cloth2 : M.lace,
      [0.050 * bulk, 0.02 - coatLen * 0.47, 0.150 * bulk], [0.05, 0, 0.11]);

  const skirtPanels = [];
  if (cfg.armour === 'lamellar') {
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU + 0.35;
      put(hips, plateGeo(0.145, 0.235, 0.045), M.plate,
          [Math.sin(a) * 0.165 * bulk, -0.135, Math.cos(a) * 0.145 * bulk], [0.14, a, 0]);
    }
  } else if (cfg.faction === 'bandit') {
    // Ragged hem: four torn panels that flap. Cheap, and it sells "brigand".
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + 0.6;
      const pn = mesh(plateGeo(0.165, 0.32 - (i % 2) * 0.09, 0.016, 1), M.cloth);
      pn.position.set(Math.sin(a) * 0.20, -0.44, Math.cos(a) * 0.18);
      pn.rotation.y = a;
      hips.add(pn); skirtPanels.push(pn);
    }
  }

  // ---- shoulders ---------------------------------------------------------
  for (const s of ['l', 'r']) {
    const sgn = s === 'l' ? 1 : -1;
    if (cfg.pauldrons) {
      // Squared-off Mongol pauldron sitting on the joint. Flat and wide where a
      // sode is layered and hanging — the shoulder line is the tell.
      //
      // It used to overhang the arm by six centimetres, which is nothing: the
      // widest part of the figure was still basically the arm, so the whole
      // body tapered from head to hem in one unbroken run and read as a cone
      // at any distance where the helmet stopped resolving. A silhouette is
      // identified by its WIDEST horizontal, and on an armoured man that has
      // to be the shoulders, hard and level and clear of the limbs. Pushed
      // outboard and widened to a 0.76 m span on a 1.75 m body — the same
      // shoulder-to-height ratio a real lamellar cuirass gives you — plus a
      // second hanging lappet so the edge is stepped instead of a single slab.
      put(shoulder[s], plateGeo(0.252 * bulk, 0.132, 0.212 * bulk), M.plate,
          [sgn * 0.042, -0.042, 0], [0, 0, sgn * -0.26]);
      put(shoulder[s], plateGeo(0.222 * bulk, 0.088, 0.196 * bulk), M.plate,
          [sgn * 0.048, -0.150, 0], [0, 0, sgn * -0.34]);
      put(shoulder[s], plateGeo(0.258 * bulk, 0.022, 0.216 * bulk, 1), M.lace,
          [sgn * 0.042, -0.106, 0], [0, 0, sgn * -0.26]);
      put(shoulder[s], coneGeo(0.100 * bulk, 0.124 * bulk, 0.058, 8, true), M.fur,
          [sgn * 0.026, -0.200, 0], [0, 0, sgn * -0.34]);
    } else if (cfg.armour === 'furmantle') {
      // Shaggy shoulder caps. Big enough to double the shoulder line, small
      // enough that the head is still a notch in it and not a mushroom stem.
      put(shoulder[s], sphereGeo(0.128, 8, 6), M.fur, [sgn * 0.012, -0.045, 0], null,
          [bulk, 0.80 * bulk, bulk * 0.94]);
    }
    const armR = 0.058 * bulk * (cfg.bareArms ? 1.14 : 1);
    put(shoulder[s], limbGeo(0.30, armR, armR * 0.86), cfg.bareArms ? M.skin : M.cloth2);
    put(elbow[s], limbGeo(0.28, armR * 0.84, armR * 0.70),
        cfg.bracers ? M.leather : (cfg.bareArms ? M.skin : M.cloth2));
    put(elbow[s], sphereGeo(0.048, 8, 6), cfg.bareArms ? M.skin : M.leather, [0, -0.29, 0]);
  }

  // ---- legs --------------------------------------------------------------
  for (const s of ['l', 'r']) {
    put(hip[s], limbGeo(0.46, 0.112 * bulk, 0.082 * bulk, 7), M.cloth2);
    put(knee[s], limbGeo(0.42, 0.076 * bulk, 0.052 * bulk, 7), M.leather);
    put(ankle[s], plateGeo(0.10, 0.07, 0.23, 1), M.leather, [0, -0.035, 0.045]);
    if (cfg.faction === 'mongol') {
      // Turned-up riding boot toe.
      put(ankle[s], coneGeo(0.026, 0.045, 0.07, 6, false), M.leather, [0, -0.005, 0.155], [-0.9, 0, 0]);
    }
  }

  // ---- head furniture ----------------------------------------------------
  put(head, sphereGeo(0.104, 11, 9), M.skin, null, null, [1, 1.10, 1.04]);

  const plume = [];
  if (cfg.helm === 'conical') {
    // The signature Mongol read: a tall black spike-topped cone on a pale fur
    // ring. Dark shape, light shape, dark shape — visible at range even when
    // the whole figure is a cutout against the sun.
    put(head, coneGeo(0.010, 0.130, 0.31, 10, false), M.plate, [0, 0.158, 0]);
    put(head, coneGeo(0.144, 0.200, 0.080, 13, true), M.fur, [0, 0.020, 0]);
    // A hard flared rim under the fur. Without it the helmet is a smooth taper
    // continuous with the head and the shoulders, and a smooth taper is a
    // cone; the flare puts one crisp horizontal break between skull and body
    // that survives all the way out to a thirty-pixel figure.
    put(head, coneGeo(0.152, 0.232, 0.032, 14, true), M.plate, [0, -0.020, 0]);
    put(head, coneGeo(0.002, 0.017, 0.10, 6, false), M.steel, [0, 0.360, 0]);
    for (let i = 0; i < 3; i++) {
      const t = mesh(limbGeo(0.24 + i * 0.04, 0.013, 0.004, 5), cfg.rank ? M.accent : M.hair);
      t.position.set((i - 1) * 0.016, 0.378, -0.012);
      head.add(t); plume.push(t);
    }
    // Neck guard — a short ochre-laced curtain off the back of the helm.
    put(head, plateGeo(0.190, 0.115, 0.03, 1), M.lace, [0, -0.038, -0.108], [0.42, 0, 0]);
  } else if (cfg.helm === 'furcap') {
    put(head, sphereGeo(0.113, 10, 6), M.plate, [0, 0.06, 0], null, [1, 0.82, 1]);
    put(head, coneGeo(0.130, 0.172, 0.090, 12, true), M.fur, [0, 0.012, 0]);
    for (let i = 0; i < 2; i++) {
      const t = mesh(limbGeo(0.26, 0.011, 0.004, 5), M.hair);
      t.position.set((i - 0.5) * 0.055, 0.07, -0.095); t.rotation.x = -0.25;
      head.add(t); plume.push(t);
    }
  } else if (cfg.helm === 'topknot') {
    // Bare-headed. The notch of a small dark skull sunk into a pale fur mantle
    // is the brute's whole identity — no helmet allowed to soften it.
    put(head, sphereGeo(0.118, 10, 7), M.hair, [0, 0.025, 0], null, [1, 0.94, 1]);
    const knot = mesh(limbGeo(0.21, 0.021, 0.030, 6), M.hair);
    knot.position.y = 0.26; knot.rotation.x = -0.7; head.add(knot); plume.push(knot);
  } else if (cfg.helm === 'kasa') {
    // A wide, flat, dark hat worn low and crooked. The player's kasa is a pale
    // cone over a black body; this is a black disc over a pale one.
    put(head, coneGeo(0.058, 0.300, 0.076, 14, true), M.cloth2, [0, 0.110, 0], [0.10, 0, 0.24]);
    put(head, coneGeo(0.058, 0.120, 0.090, 10, true), M.cloth2, [0, 0.162, 0], [0.10, 0, 0.24]);
  } else if (cfg.helm === 'rag') {
    put(head, sphereGeo(0.118, 10, 7), M.cloth2, [0, 0.035, 0], null, [1, 0.88, 1]);
    const tail = mesh(plateGeo(0.085, 0.30, 0.012, 1), M.cloth2);
    tail.position.set(0.02, -0.12, -0.10); head.add(tail); plume.push(tail);
  }
  if (cfg.crest) {
    // Maedate. A broad ochre crescent and two horns over the brow. One shape,
    // and the named duelist can never again be mistaken for a line raider.
    put(head, cached('crestArc', () => {
      const t = new THREE.TorusGeometry(0.155, 0.020, 5, 16, Math.PI * 0.86);
      t.rotateZ(Math.PI * 0.07);
      return t;
    }), M.lace, [0, 0.175, 0.030]);
    for (const sg of [1, -1]) {
      put(head, coneGeo(0.003, 0.024, 0.235, 6, false), M.lace,
          [sg * 0.095, 0.300, 0.010], [-0.10, 0, sg * 0.52]);
    }
  }
  if (cfg.mask === 'cloth') {
    put(head, plateGeo(0.138, 0.088, 0.122, 1), M.cloth2, [0, -0.045, 0.015]);
  } else if (cfg.mask === 'beard') {
    put(head, coneGeo(0.058, 0.020, 0.145, 7, false), M.hair, [0, -0.10, 0.035], [0.25, 0, 0]);
  } else if (cfg.mask === 'menpo') {
    // A lacquered half-mask with a jutting chin. Read: not a person.
    put(head, plateGeo(0.148, 0.115, 0.140, 0.66), M.plate, [0, -0.050, 0.014]);
    put(head, coneGeo(0.050, 0.010, 0.105, 7, false), M.plate, [0, -0.118, 0.036], [0.34, 0, 0]);
    put(head, plateGeo(0.150, 0.016, 0.128, 1), M.lace, [0, -0.006, 0.012]);
  }

  // ---- back furniture ----------------------------------------------------
  const quiverArrows = [];
  if (cfg.quiver) {
    // Crossed chest straps: the archer has no armour, so this is what stops
    // him reading as an unfinished body.
    for (let i = 0; i < 2; i++) {
      put(chest, plateGeo(0.078, 0.44, 0.235, 1), M.leather, [0, 0.24, 0], [0, 0, i ? 0.55 : -0.55]);
    }
    const q = new THREE.Group();
    q.name = 'quiver'; JOINTS.quiver = q;
    q.position.set(-0.12, 0.30, -0.16); q.rotation.set(0.3, 0, -0.5); chest.add(q);
    put(q, coneGeo(0.056, 0.046, 0.42, 8, true), M.leather, [0, 0.14, 0]);
    // Arrows fanning out of the quiver — the readable part at distance.
    for (let i = 0; i < 6; i++) {
      put(q, limbGeo(0.34, 0.006, 0.006, 4), M.wood,
          [(i - 2.5) * 0.016, 0.62, -0.01], [0, 0, (i - 2.5) * 0.075]);
      const fl = mesh(plateGeo(0.008, 0.075, 0.030, 1), M.accent);
      fl.position.set((i - 2.5) * 0.038, 0.60, -0.01);
      fl.rotation.z = (i - 2.5) * 0.075;
      q.add(fl); quiverArrows.push(fl);
    }
  }

  const capePanels = [];
  if (cfg.cape) {
    const cape = new THREE.Group();
    cape.position.set(0, 0.40, -0.115); chest.add(cape);
    for (let i = 0; i < 4; i++) {
      const pn = mesh(plateGeo(0.40 - i * 0.035, 0.34, 0.018, 1), cfg.rank ? M.accent : M.cloth2);
      pn.position.set(0, -0.17 - i * 0.29, -0.02 - i * 0.028);
      cape.add(pn); capePanels.push(pn);
    }
  }

  // ---- weapon ------------------------------------------------------------
  // The telegraph. This is rendered into an HDR buffer that the post stack
  // tone-maps afterwards, and the scene at golden hour sits at radiances of
  // five to twenty. An additive tell at an LDR 1.0 therefore added nothing
  // visible, and switching it to un-tone-mapped alpha made it worse: 1.0 laid
  // over blown-out grass reads as a DARK ring. The fix is to stay inside the
  // grade and be genuinely bright — the tell colours below are HDR, several
  // times over white, so additive blending pushes the pixel unmistakably
  // toward the tell's hue no matter how hot the frame already is.
  // Straight alpha, not additive: adding a colour to an already-hot frame keeps
  // the frame's own hue and every tell came out the same orange. Replacing the
  // pixel is what lets warm-gold and red mean two different things.
  const tellMat = new THREE.MeshBasicMaterial({
    color: '#ffd9a0', transparent: true, opacity: 0,
    depthWrite: false, side: THREE.DoubleSide,
  });
  // The ground mark gets its OWN material rather than sharing tellMat. Sharing
  // meant the floor ring ran at the weapon's HDR intensity — a horizontal
  // surface a metre across at three times white is a lamp, and the bloom pass
  // treated it as one. This one is graded, not emissive: it takes the tell's
  // hue but stays under white and at a third of the opacity, so it reads as a
  // scuff of light on the grass instead of a decal laid over it.
  const discMat = new THREE.MeshBasicMaterial({
    color: '#ffd9a0', transparent: true, opacity: 0,
    depthWrite: false, side: THREE.DoubleSide,
  });
  const weaponRig = new THREE.Group();
  weaponRig.position.y = -0.30;               // at the hand
  // A bow is held in the bow hand and drawn with the other — attach it left.
  (cfg.weapon === 'bow' ? elbow.l : elbow.r).add(weaponRig);
  const weapon = buildWeapon(cfg.weapon, M, tellMat, cfg);
  if (cfg.weaponScale) weapon.scale.setScalar(cfg.weaponScale);
  weaponRig.add(weapon);
  const banner = weapon.userData.banner || [];

  // A scabbard on the hip for the blades, so an unaware enemy is visibly unarmed.
  let scabbard = null;
  if (cfg.weapon === 'sabre' || cfg.weapon === 'katana') {
    scabbard = new THREE.Group();
    scabbard.position.set(0.14, 0.0, -0.03);
    scabbard.rotation.set(0.15, cfg.weapon === 'katana' ? -0.42 : -0.55, -0.28);
    hips.add(scabbard);
    const sc = mesh(limbGeo(0.80, 0.024, 0.019, 7), M.leather);
    sc.rotation.x = Math.PI * 0.5 - 0.42;
    scabbard.add(sc);
  }

  const meshes = [];
  B.flush(meshes, JOINTS);
  const seen = new Set(meshes);
  root.traverse(o => { if (o.isMesh && !seen.has(o)) { o.castShadow = true; meshes.push(o); } });

  // The telegraph proxies exist to be SEEN, not to be lit, and three's shadow
  // pass renders through a depth material that ignores `opacity` entirely — so
  // a tell slab at opacity 0 was still throwing a solid black plank across the
  // grass beside every raider on the island, all the time, whether or not he
  // was swinging. Drop them out of the cast list AND out of `meshes`, or the
  // distance shadow toggle in update() hands castShadow straight back.
  for (const m of [weapon.userData.tellMesh, weapon.userData.tellRing]) {
    if (!m) continue;
    m.castShadow = false;
    const i = meshes.indexOf(m);
    if (i >= 0) meshes.splice(i, 1);
  }

  // A mark on the ground under a fighter who is winding up. The weapon glow is
  // a few pixels wide at combat range and can be edge-on or behind his body,
  // so a second read at the feet is worth keeping.
  //
  // What is NOT worth keeping is what this used to be: a 22 cm-thick ring
  // scaled to a reach of 1.95 m — a four-metre glowing yellow annulus painted
  // on the meadow. In the summit frame it was the largest and brightest object
  // on screen and it read as exactly the thing the rubric forbids, a debug
  // overlay. The reach is not information the player reads off the floor
  // anyway; he reads it off the man. So this is now a thin scuff that hugs the
  // stance — about 1.2 m across at full extent, a hair over a footprint — and
  // the actual "he is winding up" statement moved onto the BODY (see the
  // unblockable coil in the animator) and the weapon.
  const tellDisc = new THREE.Mesh(cached('tellDisc2', () => {
    const g2 = new THREE.RingGeometry(0.50, 0.56, 28);
    g2.rotateX(-Math.PI * 0.5);
    return g2;
  }), discMat);
  tellDisc.position.y = 0.05;
  tellDisc.castShadow = false;
  tellDisc.receiveShadow = false;
  tellDisc.renderOrder = 3;
  tellDisc.visible = false;
  root.add(tellDisc);

  return {
    root, rig, meshes, tellMat, discMat, tellDisc, tellRing: weapon.userData.tellRing,
    bones: { hips, spine, chest, neck, head, shoulder, elbow, hip, knee, ankle, weaponRig },
    parts: { weapon, scabbard, capePanels, skirtPanels, plume, quiverArrows, banner },
  };
}

// =============================================================================
//  ANIMATOR
//  Locomotion cycle plus a state layer plus an attack layer, all additive on
//  the same bones. The state layer is the whole point: an unaware raider must
//  look bored from thirty metres and a searching one must look dangerous.
// =============================================================================

function makeAnimator(body, cfg, rng) {
  const B = body.bones, P = body.parts;
  const twoHand = cfg.weapon === 'axe' || cfg.weapon === 'spear' || cfg.weapon === 'naginata';
  let phase = 0, t = rng() * 20, scan = rng() * TAU;
  let handedness = 0;    // 0 = weapon stowed, 1 = drawn

  // Where the weapon rig sits relative to the hand in each posture.
  const guardRot = {
    sabre:    [-0.55, 0.25, -0.35],
    katana:   [-0.75, 0.10, -0.10],
    spear:    [-1.15, 0.32, 0.05],
    axe:      [-0.35, 0.18, -0.55],
    naginata: [-1.05, 0.28, -0.15],
    bow:      [-1.45, 0.10, 0.35],
  }[cfg.weapon] || [-0.6, 0, 0];

  return function pose(dt, s) {
    t += dt;
    const speed = s.speed || 0;
    const moving = speed > 0.16;
    const stride = moving ? clamp(speed * 0.95, 1.1, 4.6) : 0;
    phase += dt * stride * Math.PI;
    if (!moving) phase = damp(phase % TAU, 0, 3.2, dt);

    const run = clamp((speed - 2.2) / 3.2, 0, 1);
    const amp = lerp(0.55, 1.20, run) * (moving ? 1 : 0);
    const sn = Math.sin(phase), cs = Math.cos(phase);
    const drawn = s.drawn ? 1 : 0;
    handedness = damp(handedness, drawn, 7, dt);

    // ---- locomotion base -------------------------------------------------
    B.hip.l.rotation.x = sn * 0.60 * amp;
    B.hip.r.rotation.x = -sn * 0.60 * amp;
    B.hip.l.rotation.z = 0; B.hip.r.rotation.z = 0;
    B.knee.l.rotation.x = -Math.max(0, -sn) * 1.22 * amp - 0.07;
    B.knee.r.rotation.x = -Math.max(0, sn) * 1.22 * amp - 0.07;
    B.ankle.l.rotation.x = -B.hip.l.rotation.x * 0.35 + 0.05;
    B.ankle.r.rotation.x = -B.hip.r.rotation.x * 0.35 + 0.05;

    // Positive z on the LEFT shoulder swings that arm outward, away from the
    // body. The old pose had the sign inverted on both sides, which folded both
    // arms into the torso and is half the reason these read as limbless cones.
    B.shoulder.l.rotation.set(-sn * 0.42 * amp, 0, 0.15 + run * 0.05);
    B.shoulder.r.rotation.set(sn * 0.42 * amp, 0, -0.15 - run * 0.05);
    B.elbow.l.rotation.set(-0.30 - Math.max(0, sn) * 0.45 * amp, 0, 0);
    B.elbow.r.rotation.set(-0.30 - Math.max(0, -sn) * 0.45 * amp, 0, 0);

    B.hips.rotation.set(0, sn * 0.10 * amp, cs * 0.045 * amp);
    B.spine.rotation.set(0, 0, 0);
    B.chest.rotation.set(0.04 + run * 0.20, -sn * 0.13 * amp, 0);
    B.neck.rotation.set(-(0.04 + run * 0.20) * 0.7, 0, 0);
    B.head.rotation.set(0, 0, 0);

    const bob = Math.abs(sn) * 0.05 * amp;
    let hipY = 0.94 - bob;

    // ---- state layer -----------------------------------------------------
    const st = s.state;
    const aim = clamp(s.aimYaw || 0, -1.6, 1.6);

    if (st === 'idle' || st === 'patrol') {
      // Bored: weight shift, slow head sweep, arms loose, weapon stowed.
      scan += dt * 0.55;
      const look = Math.sin(scan) * 0.62 + Math.sin(scan * 0.37) * 0.25;
      B.neck.rotation.y = look;
      B.head.rotation.y = look * 0.4;
      B.neck.rotation.x += Math.sin(scan * 0.8) * 0.10;
      if (!moving) {
        B.hips.rotation.z = Math.sin(t * 0.55) * 0.045;
        B.chest.rotation.y = Math.sin(t * 0.4 + 1) * 0.06;
        B.shoulder.l.rotation.x = Math.sin(t * 0.55) * 0.05;
        B.shoulder.r.rotation.x = Math.sin(t * 0.55 + 0.9) * 0.05;
        hipY += Math.sin(t * 1.4) * 0.012;
      }
      if (twoHand) {
        // A shouldered polearm — carried, not held.
        B.shoulder.r.rotation.x += -0.45;
        B.shoulder.r.rotation.z += 0.35;
        B.elbow.r.rotation.x += -0.9;
      }
    } else if (st === 'suspicious') {
      // Frozen mid-step, squared up, hand travelling to the hilt. Half-crouch.
      B.neck.rotation.y = aim * 0.55;
      B.head.rotation.y = aim * 0.30;
      B.chest.rotation.y += aim * 0.30;
      B.chest.rotation.x += 0.14;
      B.neck.rotation.x -= 0.06;
      hipY -= 0.045;
      B.hip.l.rotation.x += 0.20; B.hip.r.rotation.x -= 0.10;
      B.knee.l.rotation.x -= 0.30; B.knee.r.rotation.x -= 0.22;
      B.shoulder.r.rotation.x += -0.55 * (1 - handedness) - 0.9 * handedness;
      B.shoulder.r.rotation.z += 0.28;
      B.elbow.r.rotation.x += -1.15;
      B.shoulder.l.rotation.x += -0.25;
      B.elbow.l.rotation.x += -0.45;
    } else if (st === 'search') {
      // Weapon out, low and forward, sweeping. Predatory, leaning.
      scan += dt * 1.15;
      const look = Math.sin(scan) * 0.72;
      B.neck.rotation.y = look;
      B.head.rotation.y = look * 0.45;
      B.chest.rotation.y += look * 0.28;
      B.chest.rotation.x += 0.20;
      hipY -= 0.03;
      B.shoulder.r.rotation.x += -0.85;
      B.shoulder.r.rotation.z += 0.22;
      B.elbow.r.rotation.x += -0.75;
      B.shoulder.l.rotation.x += -0.60 - (twoHand ? 0.35 : 0);
      B.shoulder.l.rotation.z += -0.45;
      B.elbow.l.rotation.x += -1.00;
    } else if (st === 'engage') {
      // Combat guard: coiled, bladed stance, weapon up across the body.
      const bounce = Math.sin(t * 4.6) * 0.5 + 0.5;
      B.neck.rotation.y = aim * 0.45;
      B.head.rotation.y = aim * 0.25;
      B.chest.rotation.y += aim * 0.22 - 0.16;
      B.chest.rotation.x += 0.16 + bounce * 0.03;
      hipY -= 0.075 + bounce * 0.012;
      B.hips.rotation.y += -0.20;
      B.hip.l.rotation.x += 0.30; B.hip.r.rotation.x -= 0.18;
      B.knee.l.rotation.x -= 0.44; B.knee.r.rotation.x -= 0.40;
      B.shoulder.r.rotation.x += -1.05 - (twoHand ? 0.20 : 0);
      B.shoulder.r.rotation.z += 0.32;
      B.elbow.r.rotation.x += -1.05;
      B.shoulder.l.rotation.x += twoHand ? -1.25 : -0.55;
      B.shoulder.l.rotation.z += twoHand ? -0.75 : -0.30;
      B.elbow.l.rotation.x += twoHand ? -0.95 : -0.85;
    } else if (st === 'standoff') {
      // Duel: dead still, blade low and back, weight on the rear foot.
      B.neck.rotation.y = aim * 0.4;
      B.chest.rotation.y += aim * 0.18 - 0.34;
      B.chest.rotation.x += 0.05;
      hipY -= 0.05 + Math.sin(t * 1.1) * 0.008;
      B.hips.rotation.y += -0.42;
      B.hip.l.rotation.x += 0.34; B.hip.r.rotation.x -= 0.28;
      B.knee.l.rotation.x -= 0.48; B.knee.r.rotation.x -= 0.30;
      B.shoulder.r.rotation.x += -0.28;
      B.shoulder.r.rotation.z += 0.42;
      B.elbow.r.rotation.x += -0.55;
      B.shoulder.l.rotation.x += -0.75;
      B.shoulder.l.rotation.z += -0.55;
      B.elbow.l.rotation.x += -1.15;
    }

    // ---- block ------------------------------------------------------------
    if (s.guard > 0.01) {
      const g = s.guard;
      B.shoulder.r.rotation.x += -1.05 * g;
      B.shoulder.r.rotation.z += 0.30 * g;
      B.elbow.r.rotation.x += -1.35 * g;
      B.shoulder.l.rotation.x += -1.15 * g;
      B.shoulder.l.rotation.z += -0.55 * g;
      B.elbow.l.rotation.x += -1.25 * g;
      B.chest.rotation.x += 0.18 * g;
      B.neck.rotation.x -= 0.10 * g;
      hipY -= 0.05 * g;
    }

    // ---- attack layer -----------------------------------------------------
    const a = s.attack;
    if (a) {
      const kind = a.type;
      // Coil hard on the windup, release fast, then let the follow-through
      // decay across the recovery. Snapping straight back to guard reads as a
      // glitch; the long return is what makes a swing feel like it weighed
      // something.
      let w = 0, rel = 0;
      if (a.phase === 'windup') { w = a.k; }
      else if (a.phase === 'strike') { w = 1; rel = a.k; }
      else { rel = 1 - a.k * a.k; }
      const coil = w * w * (3 - 2 * w) * (1 - rel);
      if (kind === 'overhead' || kind === 'cleave') {
        B.shoulder.r.rotation.x += -2.35 * coil + 2.9 * rel;
        B.shoulder.l.rotation.x += -2.10 * coil + 2.6 * rel;
        B.elbow.r.rotation.x += -1.0 * coil + 1.2 * rel;
        B.chest.rotation.x += -0.42 * coil + 0.68 * rel;
        B.chest.rotation.y += 0.30 * coil - 0.20 * rel;
        B.hips.rotation.y += 0.16 * coil - 0.14 * rel;
        hipY += 0.06 * coil - 0.14 * rel;
      } else if (kind === 'sweep') {
        B.shoulder.r.rotation.x += -0.85 * coil + 0.30 * rel;
        B.shoulder.r.rotation.z += 0.55 * coil - 1.3 * rel;
        B.shoulder.l.rotation.x += -1.15 * coil + 0.55 * rel;
        B.shoulder.l.rotation.z += -0.45 * coil + 0.30 * rel;
        B.chest.rotation.y += 0.95 * coil - 1.75 * rel;
        B.hips.rotation.y += 0.55 * coil - 1.05 * rel;
        hipY -= 0.10 * coil + 0.05 * rel;
      } else if (kind === 'thrust' || kind === 'stab' || kind === 'iai') {
        B.shoulder.r.rotation.x += -0.55 * coil - 0.55 * rel;
        B.elbow.r.rotation.x += -1.55 * coil + 1.65 * rel;
        B.shoulder.l.rotation.x += -1.05 * coil - 0.30 * rel;
        B.chest.rotation.y += 0.65 * coil - 0.85 * rel;
        B.hips.rotation.y += 0.28 * coil - 0.50 * rel;
        B.hip.r.rotation.x += -0.35 * rel; B.hip.l.rotation.x += 0.45 * rel;
      } else if (kind === 'kick') {
        B.hip.r.rotation.x += -0.55 * coil - 1.45 * rel;
        B.knee.r.rotation.x += -1.20 * coil + 1.15 * rel;
        B.chest.rotation.x += 0.30 * coil - 0.35 * rel;
        B.shoulder.l.rotation.x += -0.60 * coil;
        hipY -= 0.05 * coil;
      } else if (kind === 'shoot') {
        B.shoulder.l.rotation.x += -1.55;
        B.shoulder.l.rotation.z += -0.42;
        B.elbow.l.rotation.x += 0.25;
        B.shoulder.r.rotation.x += -1.35;
        B.shoulder.r.rotation.z += 0.30;
        B.elbow.r.rotation.x += -1.15 - 0.55 * coil + 0.8 * rel;
        B.chest.rotation.y += -0.35;
      } else {          // slash — the bread-and-butter diagonal cut
        B.shoulder.r.rotation.x += -1.85 * coil + 2.15 * rel;
        B.shoulder.r.rotation.z += 0.70 * coil - 0.95 * rel;
        B.elbow.r.rotation.x += -0.95 * coil + 1.05 * rel;
        B.chest.rotation.y += 0.62 * coil - 0.95 * rel;
        B.hips.rotation.y += 0.26 * coil - 0.42 * rel;
        B.chest.rotation.x += -0.14 * coil + 0.30 * rel;
      }

      // ---- the tell, stated on the MAN ------------------------------------
      // The colour of the blade and a mark on the grass are both things laid
      // ON the frame. The thing a player actually reads in Tsushima is the
      // fighter's own body committing: he plants, he loads his back, and on an
      // unblockable he shakes with the effort of holding it. That is diegetic,
      // it survives being backlit to a cutout, and it is what lets the ground
      // and weapon tells be dialled down to a whisper instead of a floodlight.
      //
      // Two separate statements. EVERY windup sinks and squares up — "he is
      // starting something". An UNBLOCKABLE additionally over-rotates away and
      // holds a hard tremor — "and you cannot answer this one with steel".
      if (a.phase === 'windup') {
        const load = a.k * a.k;
        hipY -= 0.055 * load;
        B.hip.l.rotation.x += 0.16 * load;
        B.hip.r.rotation.x -= 0.12 * load;
        B.knee.l.rotation.x -= 0.26 * load;
        B.knee.r.rotation.x -= 0.22 * load;
        if (a.def && a.def.unblockable) {
          // ~5.4 Hz: fast enough to read as strain across a half-second
          // windup, slow enough not to alias into a buzz at 60 fps.
          const shake = Math.sin(t * 34) * 0.030 * load;
          B.chest.rotation.z += shake;
          B.shoulder.r.rotation.z += shake * 2.2;
          B.shoulder.l.rotation.z += shake * 1.6;
          B.neck.rotation.z -= shake * 0.9;
          B.chest.rotation.x -= 0.20 * load;      // back loaded further
          B.neck.rotation.x -= 0.16 * load;       // chin down over the guard
          hipY -= 0.045 * load;
        }
      }
    }

    // ---- hit reactions ----------------------------------------------------
    if (s.state === 'stagger') {
      const k = s.reactK;
      const jolt = Math.sin(k * Math.PI) ;
      B.chest.rotation.x -= 0.62 * jolt;
      B.neck.rotation.x -= 0.42 * jolt;
      B.chest.rotation.y += Math.sin(k * 22) * 0.10 * (1 - k);
      B.shoulder.l.rotation.x += -0.9 * jolt;
      B.shoulder.r.rotation.x += -0.5 * jolt;
      B.hip.l.rotation.x += 0.30 * jolt;
      B.knee.l.rotation.x -= 0.55 * jolt;
      hipY -= 0.10 * jolt;
    } else if (s.state === 'down') {
      // Curl in on the ground, then push back up in the last third.
      const k = s.reactK;
      const rise = clamp((k - 0.62) / 0.38, 0, 1);
      const curl = (1 - rise);
      B.chest.rotation.x += 0.55 * curl;
      B.hip.l.rotation.x += 1.15 * curl; B.hip.r.rotation.x += 0.85 * curl;
      B.knee.l.rotation.x -= 1.45 * curl; B.knee.r.rotation.x -= 1.15 * curl;
      B.shoulder.l.rotation.x += -0.55 * curl;
      B.shoulder.r.rotation.x += -0.35 * curl;
      hipY = lerp(0.30, hipY, rise);
    } else if (s.state === 'dead') {
      const k = s.reactK;
      B.chest.rotation.x += 0.75 * k;
      B.neck.rotation.x += 0.45 * k;
      B.hip.l.rotation.x += 0.95 * k; B.hip.r.rotation.x += 0.60 * k;
      B.knee.l.rotation.x -= 1.25 * k; B.knee.r.rotation.x -= 0.75 * k;
      B.shoulder.l.rotation.x += -0.35 * k;
      B.shoulder.r.rotation.x += 0.55 * k;
      hipY = lerp(hipY, 0.20, k);
    }

    B.hips.position.y = hipY;

    // ---- weapon carriage ---------------------------------------------------
    // Stowed weapons ride the hip scabbard; drawn ones sit in the hand.
    const wr = B.weaponRig;
    if (P.scabbard) {
      P.scabbard.visible = handedness < 0.5;
      P.weapon.visible = handedness > 0.5 || s.state === 'dead';
    }
    wr.rotation.set(
      damp(wr.rotation.x, guardRot[0] * (0.35 + 0.65 * handedness), 10, dt),
      damp(wr.rotation.y, guardRot[1], 10, dt),
      damp(wr.rotation.z, guardRot[2], 10, dt));

    // ---- cloth -------------------------------------------------------------
    const wind = s.wind ?? 0.5;
    for (let i = 0; i < P.capePanels.length; i++) {
      const p = P.capePanels[i];
      const lag = (i + 1) * 0.24;
      p.rotation.x = -0.10 - run * 0.55 - wind * 0.22 * lag
        + Math.sin(t * 2.1 - i * 0.8) * 0.07 * (0.4 + wind);
      p.rotation.z = Math.sin(t * 1.6 - i * 0.6) * 0.06 * (0.4 + wind);
    }
    for (let i = 0; i < P.skirtPanels.length; i++) {
      const p = P.skirtPanels[i];
      p.rotation.x = Math.sin(t * 2.6 + i * 1.7) * 0.10 * (0.5 + wind) - run * 0.30;
    }
    for (let i = 0; i < P.banner.length; i++) {
      const p = P.banner[i];
      p.rotation.x = Math.sin(t * 3.4 - i * 0.7) * (0.22 + wind * 0.42) - run * 0.25;
      p.rotation.z = 0.10 + Math.sin(t * 2.7 - i * 0.5) * 0.16 * (0.4 + wind);
    }
    for (let i = 0; i < P.plume.length; i++) {
      const p = P.plume[i];
      p.rotation.x = -0.15 - run * 0.75 - wind * 0.28 + Math.sin(t * 3.1 - i * 0.6) * 0.10;
      p.rotation.z = Math.sin(t * 2.4 - i * 0.9) * 0.09 * (0.4 + wind);
    }
  };
}

// =============================================================================
//  ARCHETYPES
// =============================================================================

const KINDS = {
  raider: {
    faction: 'mongol', hp: 100, poise: 34, scale: 1.00, walk: 1.55, jog: 3.1, run: 5.2,
    weapon: 'sabre', armour: 'lamellar', collar: 'fur', pauldrons: true, bracers: true,
    helm: 'conical', mask: 'beard', bulk: 1.00, coatFlare: 0.265, coatLen: 0.50,
    shoulderWidth: 0.212, girth: 1.00,
    sight: 54, fov: 1.08, percept: 0.90, aggression: 0.78, block: 0.42, dodge: 0.22,
    attacks: ['slash', 'slash', 'stab', 'kick'], ring: 5.6,
  },
  spearman: {
    faction: 'mongol', hp: 112, poise: 42, scale: 1.06, walk: 1.5, jog: 2.9, run: 4.9,
    weapon: 'spear', armour: 'lamellar', collar: 'plate', pauldrons: true, bracers: true,
    helm: 'conical', mask: 'cloth', bulk: 0.98, coatFlare: 0.252, coatLen: 0.54,
    shoulderWidth: 0.206, pennon: true, girth: 1.00,
    sight: 60, fov: 1.10, percept: 0.95, aggression: 0.58, block: 0.50, dodge: 0.18,
    attacks: ['thrust', 'thrust', 'sweep'], ring: 6.8,
  },
  archer: {
    faction: 'mongol', hp: 76, poise: 22, scale: 0.96, walk: 1.7, jog: 3.4, run: 5.7,
    weapon: 'bow', armour: 'gambeson', collar: 'none', pauldrons: false, bracers: true, quiver: true,
    helm: 'furcap', mask: 'none', bulk: 0.88, coatFlare: 0.212, coatLen: 0.42,
    shoulderWidth: 0.190, girth: 0.90,
    sight: 74, fov: 1.24, percept: 1.20, aggression: 0.30, block: 0.10, dodge: 0.50,
    attacks: ['shoot'], ranged: true, ring: 15.0,
  },
  brute: {
    // Twice the mass of a raider and nothing on his head, so the eye reads a
    // wide pale wedge with a small dark ball sunk into it. He is the only
    // silhouette in the game that is wider than it is tall at the shoulders.
    faction: 'mongol', hp: 210, poise: 84, scale: 1.26, walk: 1.32, jog: 2.55, run: 4.15,
    weapon: 'axe', armour: 'furmantle', collar: 'none', pauldrons: false, bareArms: true,
    helm: 'topknot', mask: 'beard', bulk: 1.44, coatFlare: 0.30, coatLen: 0.42,
    shoulderWidth: 0.278, weaponScale: 1.22, girth: 1.55,
    sight: 44, fov: 0.94, percept: 0.62, aggression: 0.96, block: 0.16, dodge: 0.0,
    attacks: ['cleave', 'overhead', 'cleave'], ring: 5.2, heavy: true,
  },
  bandit: {
    faction: 'bandit', hp: 82, poise: 26, scale: 0.96, walk: 1.6, jog: 3.2, run: 5.4,
    weapon: 'katana', armour: 'sash', collar: 'none', pauldrons: false,
    helm: 'kasa', mask: 'cloth', bulk: 0.93, coatFlare: 0.232, coatLen: 0.42,
    shoulderWidth: 0.196, girth: 0.92,
    sight: 47, fov: 1.02, percept: 0.82, aggression: 0.62, block: 0.34, dodge: 0.46,
    attacks: ['slash', 'stab', 'slash'], ring: 5.4,
  },
  cutthroat: {
    faction: 'bandit', hp: 90, poise: 30, scale: 1.00, walk: 1.6, jog: 3.3, run: 5.5,
    weapon: 'sabre', armour: 'sash', collar: 'rag', pauldrons: false, bracers: true,
    helm: 'rag', mask: 'cloth', bulk: 0.97, coatFlare: 0.212, coatLen: 0.38,
    shoulderWidth: 0.202, girth: 0.96,
    sight: 47, fov: 1.05, percept: 0.85, aggression: 0.72, block: 0.28, dodge: 0.42,
    attacks: ['slash', 'kick', 'stab'], ring: 5.2,
  },
  duelist: {
    // The named one. Taller than anything else on the island, horned, masked,
    // caped, and carrying a naginata. Everything about him is one size up.
    faction: 'mongol', hp: 240, poise: 74, scale: 1.16, walk: 1.6, jog: 3.2, run: 5.0,
    weapon: 'naginata', armour: 'lamellar', collar: 'plate', pauldrons: true, bracers: true,
    cape: true, crest: true, rank: true,
    helm: 'conical', mask: 'menpo', bulk: 1.06, coatFlare: 0.278, coatLen: 0.60,
    shoulderWidth: 0.226, girth: 1.10,
    sight: 68, fov: 1.38, percept: 1.35, aggression: 0.80, block: 0.62, dodge: 0.38,
    attacks: ['iai', 'sweep', 'thrust', 'overhead'], ring: 6.2, duel: true,
  },
};

// windup / strike / recover in seconds. The windup is the contract with the
// player: long enough to read, short enough to threaten.
const ATTACKS = {
  slash:    { windup: 0.46, strike: 0.13, recover: 0.44, reach: 2.9, arc: 1.05, dmg: 14, poise: 12, unblockable: false },
  stab:     { windup: 0.40, strike: 0.11, recover: 0.42, reach: 2.8, arc: 0.65, dmg: 12, poise: 10, unblockable: false },
  kick:     { windup: 0.36, strike: 0.12, recover: 0.40, reach: 2.1, arc: 0.80, dmg: 7,  poise: 24, unblockable: true },
  thrust:   { windup: 0.54, strike: 0.12, recover: 0.50, reach: 4.3, arc: 0.48, dmg: 16, poise: 14, unblockable: false },
  sweep:    { windup: 0.70, strike: 0.17, recover: 0.62, reach: 3.9, arc: 1.75, dmg: 18, poise: 28, unblockable: true },
  overhead: { windup: 0.88, strike: 0.18, recover: 0.82, reach: 3.4, arc: 0.90, dmg: 30, poise: 46, unblockable: true },
  cleave:   { windup: 0.64, strike: 0.16, recover: 0.58, reach: 3.5, arc: 1.55, dmg: 22, poise: 30, unblockable: false },
  iai:      { windup: 0.62, strike: 0.10, recover: 0.56, reach: 4.5, arc: 0.58, dmg: 26, poise: 30, unblockable: false },
  shoot:    { windup: 0.98, strike: 0.06, recover: 0.60, reach: 52,  arc: 0.16, dmg: 13, poise: 6,  unblockable: false, ranged: true },
};

// Above white on purpose — see the note on tellMat — but only just. At x3.2
// and x4.2 these were four to five stops over a frame that already sits at
// radiance five to twenty, which is not "readable", it is a light source: the
// bloom and god-ray stack picked them up and turned a hand-length blade into a
// plume the height of the tree line. The floor for surviving the tone mapper
// against blown-out gold grass is a little over 1.0, not four. These land the
// tell clearly hotter than anything organic in frame and nowhere near lamp.
const TELL_PARRY = new THREE.Color('#ffc061').multiplyScalar(1.62);
const TELL_UNBLOCK = new THREE.Color('#ff2a12').multiplyScalar(2.05);
// The ground scuff never goes over white — a lit patch of grass is not a lamp.
const DISC_PARRY = new THREE.Color('#ffc061').multiplyScalar(0.90);
const DISC_UNBLOCK = new THREE.Color('#ff5a34').multiplyScalar(0.90);

// =============================================================================
//  ENCOUNTERS
//  Anchors are intentions; every one is snapped to real ground before use.
// =============================================================================

const ENCOUNTERS = [
  { id: 'ridge-ambush', x: -296, z: 121, r: 24, roster: ['raider', 'raider', 'spearman', 'brute'] },
  { id: 'meadow-patrol', x: -217, z: 392, r: 34, roster: ['raider', 'archer', 'raider'] },
  { id: 'coast-camp', x: -130, z: 508, r: 32, roster: ['raider', 'spearman', 'archer', 'raider', 'brute'] },
  { id: 'river-bandits', x: -159, z: 15, r: 28, roster: ['bandit', 'cutthroat', 'bandit'] },
  { id: 'west-meadow', x: -710, z: 102, r: 32, roster: ['bandit', 'bandit', 'cutthroat'] },
  { id: 'north-shore', x: -507, z: 740, r: 30, roster: ['raider', 'spearman', 'archer'] },
  { id: 'east-ridge', x: 15, z: 189, r: 26, roster: ['raider', 'raider', 'brute'] },
  { id: 'high-camp', x: 218, z: 421, r: 28, roster: ['spearman', 'archer', 'raider', 'raider'] },
  { id: 'south-vale', x: -449, z: -72, r: 30, roster: ['cutthroat', 'bandit', 'bandit'] },
  { id: 'far-meadow', x: -681, z: 450, r: 30, roster: ['raider', 'archer', 'bandit'] },
  { id: 'lost-field', x: -420, z: 624, r: 28, roster: ['bandit', 'raider'] },
  { id: 'inland-post', x: -101, z: 276, r: 26, roster: ['raider', 'spearman', 'archer'] },
  // Standoffs. A duel is one silhouette against the sky, alone on purpose.
  { id: 'duel-summit', x: 218, z: 566, r: 12, roster: ['duelist'], duel: true },
  { id: 'duel-vale', x: -449, z: 200, r: 12, roster: ['duelist'], duel: true },
];

const ACTIVE_R = 165;     // full simulation inside this radius of the player
const DROP_R = 205;       // hysteresis so an encounter at the edge does not flicker
// ...and past this one the bodies leave the scene graph entirely. Deliberately
// a long way outside DROP_R: build and teardown are cheap (BODY_CACHE makes a
// rebuilt raider 0.2 ms) but they are not free, and 57 metres of hysteresis on
// top of the 40 already between ACTIVE_R and DROP_R means no amount of pacing
// back and forth along an encounter's edge can make this thrash.
const UNLOAD_R = 262;

// =============================================================================

export function createEnemies(ctx) {
  const { world } = ctx;
  const group = new THREE.Group();
  group.name = 'enemies';

  const rng = mulberry32(0xA11EE);
  const list = [];
  const squads = [];

  const _v = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _sunView = new THREE.Vector3();
  const playerPos = new THREE.Vector3();
  const lastPlayerPos = new THREE.Vector3();
  let frame = 0, timeNow = 0;

  // ---- terrain helpers ---------------------------------------------------
  const groundY = (x, z) => world.heightAt(x, z);

  // Walkable = above the waterline and not a cliff face.
  function walkable(x, z, maxSlope) {
    const h = world.heightAt(x, z);
    if (h < 1.0) return false;
    return world.slopeAt(x, z) <= maxSlope;
  }

  // Spiral outward from an intention until real ground agrees with it.
  function snapToGround(x, z, maxSlope = 0.20, maxR = 70) {
    if (walkable(x, z, maxSlope)) return { x, z };
    for (let r = 6; r <= maxR; r += 6) {
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * TAU + r * 0.37;
        const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
        if (walkable(px, pz, maxSlope)) return { x: px, z: pz };
      }
    }
    // Give up gracefully rather than leaving a body underwater or in a cliff.
    return { x, z };
  }

  // Terrain line of sight. Marches the segment and fails the moment the ground
  // rises through it. Coarse near the eye, finer over distance.
  function losClear(ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dz = bz - az, dy = by - ay;
    const d = Math.hypot(dx, dz);
    if (d < 1.5) return true;
    const steps = clamp(Math.ceil(d / 4.0), 3, 22);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (world.heightAt(ax + dx * t, az + dz * t) > ay + dy * t + 0.4) return false;
    }
    return true;
  }

  // ---- squads ------------------------------------------------------------
  function makeSquad(def) {
    const anchor = snapToGround(def.x, def.z, def.duel ? 0.14 : 0.20, 90);
    const squad = {
      id: def.id, def,
      x: anchor.x, z: anchor.z, r: def.r,
      duel: !!def.duel,
      members: [],
      alert: 0,
      tokens: 0, maxTokens: 1,
      tokenTimer: 0,
      slotTimer: 0,
      lastKnown: new THREE.Vector3(anchor.x, groundY(anchor.x, anchor.z), anchor.z),
      hasTarget: false,
      lostTimer: 0,
      built: false,
      active: false,
    };
    // Patrol loop: a ring of waypoints, each dragged onto walkable ground.
    const n = squad.duel ? 0 : 3 + ((rng() * 3) | 0);
    squad.route = [];
    const rot = rng() * TAU;
    for (let i = 0; i < n; i++) {
      const a = rot + (i / n) * TAU;
      const rad = squad.r * (0.55 + rng() * 0.5);
      const p = snapToGround(squad.x + Math.cos(a) * rad, squad.z + Math.sin(a) * rad, 0.26, 30);
      squad.route.push(new THREE.Vector3(p.x, groundY(p.x, p.z), p.z));
    }
    squads.push(squad);
    return squad;
  }

  function buildSquad(squad) {
    if (squad.built) return;
    squad.built = true;
    // A squad that has been here before comes back the way it was left: same
    // bodies, same wounds, and the dead stay dead. Without this the unload
    // path below would be a free heal and a resurrection every time the player
    // walked a quarter of a kilometre away from a fight he was losing.
    const saved = squad.saved;
    if (saved) {
      for (const rec of saved) {
        if (!rec.alive) continue;                 // he does not get up again
        const e = makeEnemy(rec.kind, rec.x, rec.z, squad);
        e.hp = rec.hp; e.poise = rec.poise;
        e.yaw = rec.yaw; e.root.rotation.y = rec.yaw;
        e.routeIndex = rec.routeIndex;
        // Restore the post he was assigned, not where he happened to be
        // standing, or a squad reloaded a dozen times drifts off its anchor.
        e.home.set(rec.hx, groundY(rec.hx, rec.hz), rec.hz);
        squad.members.push(e);
      }
    } else {
      const roster = squad.def.roster;
      for (let i = 0; i < roster.length; i++) {
        const a = (i / roster.length) * TAU + rng() * 0.9;
        const rad = squad.duel ? 0 : squad.r * (0.16 + rng() * 0.38);
        const p = snapToGround(squad.x + Math.cos(a) * rad, squad.z + Math.sin(a) * rad, 0.28, 26);
        const e = makeEnemy(roster[i], p.x, p.z, squad);
        e.routeIndex = i % Math.max(1, squad.route.length);
        squad.members.push(e);
      }
    }
    squad.maxTokens = squad.duel ? 1 : (squad.members.length >= 4 ? 2 : 1);
  }

  // The other half of buildSquad, which never existed. Fourteen encounters got
  // lazily built as the player came within ACTIVE_R and then stayed in the
  // scene graph for the rest of the session: measured across one capture run
  // the scene went 817 -> 990 -> 1522 -> 1828 -> 2061 objects and never came
  // back down, the enemies group alone growing 613 -> 975 meshes. Hiding a
  // squad (setActive) stops it drawing but three still walks every one of
  // those nodes for matrix and frustum work, every frame, forever, and dead
  // bodies accumulated on top.
  //
  // NOTE FOR WHOEVER READS THIS NEXT: do NOT add geometry.dispose() or
  // material.dispose() to this loop. Every merged body part comes out of
  // BODY_CACHE and every standard material out of MATS — they are shared by
  // ARCHETYPE, not owned per body, so disposing one raider's forearm deletes
  // the forearm of every raider on the island. The only GPU resources a body
  // actually owns are its two telegraph materials, and those are what gets
  // freed here.
  function unloadSquad(squad) {
    if (!squad.built) return;
    const saved = [];
    for (const e of squad.members) {
      saved.push({
        kind: e.kind, alive: e.alive,
        x: e.root.position.x, z: e.root.position.z,
        hp: e.hp, poise: e.poise, yaw: e.yaw, routeIndex: e.routeIndex,
        hx: e.home.x, hz: e.home.z,
      });
      group.remove(e.root);
      e.body.tellMat.dispose();
      e.body.discMat.dispose();
      // combat.js rebuilds its `foreign` array from ctx.enemies.list every
      // frame, so dropping an entry here is all that is needed to release the
      // adopted wrapper along with it.
      e.__combat = null;
      const i = list.indexOf(e);
      if (i >= 0) list.splice(i, 1);
    }
    squad.saved = saved;
    // Nobody left alive to come back. Stop reconsidering this encounter.
    squad.cleared = !saved.some(r => r.alive);
    squad.members.length = 0;
    squad.built = false;
    squad.active = false;
    squad.alert = 0; squad.tokens = 0; squad.hasTarget = false; squad.lostTimer = 0;
  }

  // ---- enemy construction ------------------------------------------------
  let nextId = 1;
  function makeEnemy(kind, x, z, squad) {
    const cfg = KINDS[kind] || KINDS.raider;
    const body = buildBody(kind, cfg, rng);
    const y = groundY(x, z);
    body.root.position.set(x, y, z);
    group.add(body.root);

    const e = {
      id: nextId++, kind, cfg, squad, body,
      anim: makeAnimator(body, cfg, rng),
      root: body.root,
      yaw: rng() * TAU,
      speed: 0, targetSpeed: 0,
      heading: 0, headingTimer: 0,
      hp: cfg.hp, maxHp: cfg.hp,
      poise: cfg.poise, maxPoise: cfg.poise,
      alert: 0,
      state: 'idle',
      prevState: 'idle',
      alive: true,
      guard: 0, wantGuard: 0,
      attack: null,
      attackCool: 1.2 + rng() * 2.0,
      staggerCount: 0, staggerDecay: 0,
      reactT: 0, reactDur: 0,
      deadT: 0,
      slotAngle: rng() * TAU,
      slotRadius: cfg.ring,
      token: false, tokenCool: 0,
      strafe: rng() < 0.5 ? 1 : -1,
      strafeTimer: 1 + rng() * 2,
      dodgeCool: 0,
      pauseTimer: 0,
      routeIndex: 0,
      perceptTimer: rng() * 0.15, perceptAccum: 0,
      drawn: false,
      retreatTimer: 0, dodgeTimer: 0, guardHold: 0, sink: 0, lastHitAt: -99,
      dodgeTarget: [x, z], searchX: x, searchZ: z,
      seesTarget: false,
      lastSeen: 0,
      wary: false,
      shadowOn: true,
      tilt: new THREE.Vector2(0, 0),
      duelPhase: 'wait', duelTimer: 0,
      home: new THREE.Vector3(x, y, z),
      target: new THREE.Vector3(x, y, z),
    };
    e.yaw = Math.atan2(squad.x - x, squad.z - z) + (rng() - 0.5);
    body.root.rotation.y = e.yaw;

    // ---- the surface every other system already looks for -----------------
    // combat.js adopts anything in ctx.enemies.list and reads `position`,
    // `health`, `dead`, then reports hits back through onHit / kill. camera.js
    // lock-on reads `position` too. Neither existed, so the player's katana
    // swung through these bodies without touching them, combat.state.kills
    // never incremented (the village beat can never complete without it),
    // combat counted every corpse as a live hostile so inCombat latched on
    // forever, and the camera could not lock on to anything. This block is the
    // whole fix and it costs one getter.
    Object.defineProperty(e, 'position', { get: () => body.root.position });
    Object.defineProperty(e, 'dead', {
      get: () => !e.alive,
      set: (v) => { if (v && e.alive) kill(e); },
    });
    // `health` MUST be a view onto combat's own pool, never an independent
    // field. combat.js runs syncForeign() -> pushForeign() -> sweepHit() in one
    // frame, so a plain field holds last frame's pre-damage number and
    // syncForeign's `if (src.health > a.health) a.health = src.health` hands
    // every point straight back. Measured: resolve ticked up on each landed
    // cut while enemy health sat at 100/100 forever and nothing could be
    // killed. Reading through to the wrapper makes that line a no-op, and at
    // adoption time (before __combat exists) it still seeds the right maximum.
    Object.defineProperty(e, 'health', {
      get: () => (e.__combat ? e.__combat.health : e.hp),
      set: (v) => { e.hp = v; },
    });
    Object.defineProperty(e, 'maxHealth', {
      get: () => e.maxHp,
      set: (v) => { e.maxHp = v; },
    });
    e.onHit = (dmg, dir) => reactToHit(e, dmg, dir);
    e.hit = e.onHit;
    // Guarded, unlike the `dead` setter above, which already checks e.alive.
    // combat.js's pushForeign does `if (a.dead) { s.dead = true; s.kill?.(); }`
    // EVERY frame for as long as a corpse is in the list, so an unguarded kill
    // re-ran the whole death routine sixty times a second — including
    // `e.deadT = 0`, which meant the deadT > 14 sink and the deadT > 20 hide
    // could never be reached and corpses lay on the grass in a permanent
    // first-frame death pose forever.
    e.kill = () => { if (e.alive) kill(e); };

    list.push(e);
    return e;
  }

  // ---- projectiles (arrows) ----------------------------------------------
  const arrows = [];
  const arrowGeo = new THREE.CylinderGeometry(0.006, 0.006, 0.72, 4);
  arrowGeo.rotateX(Math.PI * 0.5);
  const arrowMat = rimMat({ color: '#5a4326', roughness: 0.9 });
  function fireArrow(from, to) {
    let a = arrows.find(q => !q.live);
    if (!a) {
      const m = new THREE.Mesh(arrowGeo, arrowMat);
      m.castShadow = false;
      group.add(m);
      a = { mesh: m, live: false, vel: new THREE.Vector3(), t: 0 };
      arrows.push(a);
    }
    a.mesh.position.copy(from);
    a.vel.copy(to).sub(from);
    const d = a.vel.length();
    a.vel.normalize().multiplyScalar(46);
    a.vel.y += d * 0.075;        // a little loft so it arcs
    a.t = 0; a.live = true; a.mesh.visible = true;
    return a;
  }
  function updateArrows(dt) {
    for (const a of arrows) {
      if (!a.live) continue;
      a.t += dt;
      a.vel.y -= 9.4 * dt;
      a.mesh.position.addScaledVector(a.vel, dt);
      a.mesh.lookAt(_v.copy(a.mesh.position).add(a.vel));
      const gy = groundY(a.mesh.position.x, a.mesh.position.z);
      const hitPlayer = a.mesh.position.distanceTo(playerPos) < 1.05;
      if (hitPlayer) {
        hurtPlayer(ATTACKS.shoot.dmg, false, a.mesh.position.x - a.vel.x, a.mesh.position.z - a.vel.z);
        a.live = false; a.mesh.visible = false;
      }
      else if (a.mesh.position.y <= gy || a.t > 4) { a.live = false; a.mesh.visible = false; }
    }
  }

  // ---- player interface --------------------------------------------------
  const api = {
    group, list, squads, arrows,
    alertLevel: 0,
    playerHp: 100, playerMaxHp: 100,
    // Set true by a combat lane that wants to own hit resolution itself. It is
    // also detected automatically once combat.js adopts these bodies; set
    // externalHitResolutionForced to pin it either way.
    externalHitResolution: false,
    externalHitResolutionForced: false,
    // Critique hook: hold every enemy in its current state so a still can be
    // read. Never touched by gameplay.
    freeze: false,
    debug: { active: 0, engaged: 0 },
  };

  // Being hit has to cost something the player can see. This used to call
  // ctx.combat.onPlayerHit, which does not exist on combat.js's api — so every
  // blow drained a private counter nobody rendered while the two on-screen
  // health bars, both driven by combat.state.health, sat at 100% for an entire
  // thirteen-minute session. combat.state IS exported; drive it, and use the
  // public feedback hooks so a hit reads as a hit.
  function hurtPlayer(dmg, blockable, fromX, fromZ) {
    const cb = ctx.combat;
    if (cb && typeof cb.onPlayerHit === 'function') {
      cb.onPlayerHit(dmg, blockable);
    } else if (cb && cb.state && typeof cb.state.health === 'number') {
      if (cb.state.health <= 0) return;
      cb.state.health = Math.max(0, cb.state.health - dmg);
      const heavy = !blockable || dmg >= 20;
      if (typeof cb.shake === 'function') cb.shake(heavy ? 0.55 : 0.32);
      if (typeof cb.hitstop === 'function') cb.hitstop(heavy ? 0.09 : 0.055, 0.05);
      if (typeof cb.bloodBurst === 'function') {
        const dx = fromX === undefined ? 0 : playerPos.x - fromX;
        const dz = fromZ === undefined ? 1 : playerPos.z - fromZ;
        const l = Math.hypot(dx, dz) || 1;
        cb.bloodBurst(playerPos.x, playerPos.y + 1.2, playerPos.z,
          dx / l, 0.4, dz / l, 14, world.heightAt(playerPos.x, playerPos.z));
      }
    }
    // Mirror whichever pool is authoritative so nothing reads two truths.
    if (cb && cb.state && typeof cb.state.health === 'number') {
      api.playerHp = cb.state.health;
      api.playerMaxHp = cb.state.maxHealth || api.playerMaxHp;
    } else {
      api.playerHp = Math.max(0, api.playerHp - dmg);
    }
    if (ctx.samurai) ctx.samurai.playAction('stagger');
  }

  // ---- perception --------------------------------------------------------
  // One meter, four states. Everything a critic can see comes from this number
  // plus how long the enemy has been out of contact.
  function perceive(e, dt) {
    const pos = e.root.position;
    const dx = playerPos.x - pos.x, dz = playerPos.z - pos.z;
    const dist = Math.hypot(dx, dz);
    const cfg = e.cfg;
    let gain = 0;
    e.seesTarget = false;

    if (dist < cfg.sight) {
      const toYaw = Math.atan2(dx, dz);
      const off = Math.abs(angleDelta(e.yaw, toYaw));
      // A fighter already in the fight scans much wider than one on patrol.
      const halfFov = e.state === 'engage' || e.state === 'search'
        ? cfg.fov * 1.55 : (e.state === 'suspicious' ? cfg.fov * 1.25 : cfg.fov);
      if (off < halfFov) {
        const eyeY = pos.y + 1.62 * cfg.scale;
        const clear = losClear(pos.x, eyeY, pos.z, playerPos.x, playerPos.y + 1.35, playerPos.z);
        if (clear) {
          e.seesTarget = true;
          // Falls off with the square of distance, and hard toward the edge
          // of the cone — peripheral vision notices motion, not detail.
          let g = 1 - (dist / cfg.sight);
          g *= g * 1.9;
          g *= 1 - smooth(off, halfFov * 0.45, halfFov) * 0.82;
          // A sprinting target is obvious; a still one in deep grass is not.
          const pspeed = ctx.player ? (ctx.player.speed || 0) : 0;
          g *= 0.42 + clamp(pspeed / 5.0, 0, 1) * 0.75;
          const cover = world.slopeAt(playerPos.x, playerPos.z) < 0.36
            && playerPos.y > 3 && playerPos.y < 150 && pspeed < 1.2 ? 0.55 : 1;
          g *= cover;
          gain = g * cfg.percept * 2.6;
        }
      }
    }

    // Hearing is omnidirectional and ignores the view cone entirely — this is
    // what stops a player simply walking up behind a whole camp.
    const pspeed = ctx.player ? (ctx.player.speed || 0) : 0;
    const noiseR = pspeed > 5.2 ? 26 : pspeed > 2.4 ? 15 : pspeed > 0.4 ? 7 : 2.5;
    if (dist < noiseR) {
      gain = Math.max(gain, (1 - dist / noiseR) * 1.15);
      if (!e.seesTarget) {
        // Heard, not seen: the last known position is deliberately fuzzy.
        e.squad.lastKnown.set(
          playerPos.x + (rng() - 0.5) * 6,
          playerPos.y,
          playerPos.z + (rng() - 0.5) * 6);
      }
    }

    if (e.seesTarget) {
      e.lastSeen = timeNow;
      e.squad.lastKnown.copy(playerPos);
      e.squad.hasTarget = true;
    }

    if (gain > 0) e.alert = clamp(e.alert + gain * dt, 0, 1.35);
    else {
      const floor = e.state === 'search' ? 0.42 : 0;
      e.alert = Math.max(floor, e.alert - (e.state === 'engage' ? 0.10 : 0.26) * dt);
    }

    // Squad chatter: a raider who sees you tells the ones who do not. Not
    // instant omniscience — it drags the rest up to suspicious, no further.
    if (e.alert >= 1 && e.seesTarget) {
      for (const o of e.squad.members) {
        if (o === e || !o.alive) continue;
        const d2 = o.root.position.distanceTo(pos);
        if (d2 < 34) o.alert = Math.max(o.alert, o.seesTarget ? o.alert : 0.72);
      }
    }
  }

  function setState(e, s) {
    if (e.state === s) return;
    e.prevState = e.state;
    e.state = s;
    if (s === 'engage' || s === 'search') e.drawn = true;
    if (s === 'idle' || s === 'patrol') { e.drawn = false; e.token = false; }
  }

  function thinkAlert(e, dt) {
    if (!e.alive) return;
    if (e.state === 'stagger' || e.state === 'down' || e.state === 'dead') return;

    const engaged = e.alert >= 1;
    const contactAge = timeNow - e.lastSeen;

    if (engaged && (e.seesTarget || contactAge < 4.5)) {
      setState(e, e.cfg.duel && e.duelPhase !== 'fight' ? 'standoff' : 'engage');
    } else if (e.alert >= 1 || (e.state === 'engage' && contactAge < 9)) {
      setState(e, 'search');
    } else if (e.alert >= 0.34) {
      setState(e, 'suspicious');
    } else if (e.state === 'search' || e.state === 'suspicious' || e.state === 'engage' || e.state === 'standoff') {
      if (e.alert < 0.12) setState(e, 'patrol');
    } else if (e.state === 'idle' && e.pauseTimer <= 0) {
      setState(e, 'patrol');
    }
  }

  // ---- navigation --------------------------------------------------------
  // Context steering: fan candidate headings around the direction we want,
  // score each one against slope, water and squadmates, take the best. This is
  // what keeps a raider walking around a bluff instead of scrabbling up it.
  const FAN = 9;
  const FAN_SPREAD = 1.45;     // radians either side
  const PROBE = 2.8;

  function chooseHeading(e, tx, tz) {
    const pos = e.root.position;
    const want = Math.atan2(tx - pos.x, tz - pos.z);
    let bestA = want, bestScore = -1e9;
    for (let i = 0; i < FAN; i++) {
      const off = (i / (FAN - 1) - 0.5) * 2 * FAN_SPREAD;
      const a = want + off;
      const px = pos.x + Math.sin(a) * PROBE;
      const pz = pos.z + Math.cos(a) * PROBE;
      const h = world.heightAt(px, pz);
      let score = Math.cos(off) * 2.4;
      if (h < 1.2) score -= 40;                              // never wade in
      const s = world.slopeAt(px, pz);
      score -= Math.max(0, s - 0.22) * 22;                   // steep is expensive
      if (s > 0.52) score -= 26;                             // cliffs are refused
      // Separation, so a squad does not compress into one body.
      const mem = e.squad.members;
      for (let j = 0; j < mem.length; j++) {
        const o = mem[j];
        if (o === e || !o.alive) continue;
        const d = Math.hypot(o.root.position.x - px, o.root.position.z - pz);
        if (d < 1.9) score -= (1.9 - d) * 5.5;
      }
      // Turning costs a little, so they commit rather than dither.
      score -= Math.abs(angleDelta(e.heading, a)) * 0.5;
      if (score > bestScore) { bestScore = score; bestA = a; }
    }
    return bestA;
  }

  function driveTo(e, tx, tz, speed, dt, arriveAt = 0.6) {
    const pos = e.root.position;
    const dist = Math.hypot(tx - pos.x, tz - pos.z);
    if (dist < arriveAt) { e.targetSpeed = 0; return true; }
    e.headingTimer -= dt;
    if (e.headingTimer <= 0) {
      e.heading = chooseHeading(e, tx, tz);
      e.headingTimer = 0.10 + rng() * 0.05;
    }
    e.targetSpeed = speed * clamp(dist / 2.2, 0.35, 1);
    // Body yaw chases the heading; turning is not instant.
    const turn = (e.state === 'engage' ? 5.5 : 3.4) * dt;
    e.yaw += clamp(angleDelta(e.yaw, e.heading), -turn, turn);
    return false;
  }

  function faceTo(e, tx, tz, dt, rate = 6.5) {
    const a = Math.atan2(tx - e.root.position.x, tz - e.root.position.z);
    e.yaw += clamp(angleDelta(e.yaw, a), -rate * dt, rate * dt);
  }

  // ---- squad director ----------------------------------------------------
  // At most two fighters may commit at once. The rest hold a ring and rotate
  // around it — the reason a Ghost of Tsushima brawl reads instead of mobbing.
  function directSquad(sq, dt) {
    const alive = sq.members.filter(m => m.alive);
    sq.alert = 0;
    let engagedCount = 0;
    for (const m of alive) {
      sq.alert = Math.max(sq.alert, m.alert);
      if (m.state === 'engage' || m.state === 'standoff') engagedCount++;
    }
    if (engagedCount === 0) {
      for (const m of alive) m.token = false;
      sq.tokens = 0;
      return;
    }

    // Ring slots: spread the engaged fighters evenly around the player, with a
    // deliberate bias toward the flanks so someone is always off to the side.
    sq.slotTimer -= dt;
    if (sq.slotTimer <= 0) {
      sq.slotTimer = 0.7;
      const engagers = alive.filter(m => m.state === 'engage');
      const pyaw = ctx.player ? ctx.player.yaw : 0;
      for (let i = 0; i < engagers.length; i++) {
        const m = engagers[i];
        // Slot angles alternate front / left flank / right flank / behind.
        const pattern = [0, 2.0, -2.0, 1.1, -1.1, Math.PI];
        m.slotAngle = pyaw + pattern[i % pattern.length] + (rng() - 0.5) * 0.25;
        m.slotRadius = m.cfg.ring * (m.wary ? 1.45 : 1) + (i > 1 ? 1.2 : 0);
      }
    }

    // Token rotation.
    sq.maxTokens = Math.min(sq.duel ? 1 : 2, Math.max(1, Math.ceil(engagedCount / 2.5)));
    sq.tokenTimer -= dt;
    let held = 0;
    for (const m of alive) {
      if (m.token) {
        if (!m.alive || m.state !== 'engage' || m.hp / m.maxHp < 0.22) m.token = false;
        else held++;
      }
    }
    if (sq.tokenTimer <= 0 || held < sq.maxTokens) {
      sq.tokenTimer = 1.5 + rng() * 1.4;
      // Prefer whoever is closest and off cooldown; brutes push in hardest.
      const cands = alive
        .filter(m => m.state === 'engage' && !m.token && m.tokenCool <= 0 && m.hp / m.maxHp > 0.25)
        .sort((a, b) => {
          const da = a.root.position.distanceToSquared(playerPos) - a.cfg.aggression * 60;
          const db = b.root.position.distanceToSquared(playerPos) - b.cfg.aggression * 60;
          return da - db;
        });
      while (held < sq.maxTokens && cands.length) {
        const m = cands.shift();
        m.token = true; m.tokenCool = 2.6 + rng() * 1.8;
        held++;
      }
      // If we are over quota, drop the furthest holder.
      if (held > sq.maxTokens) {
        const holders = alive.filter(m => m.token)
          .sort((a, b) => b.root.position.distanceToSquared(playerPos) - a.root.position.distanceToSquared(playerPos));
        while (held > sq.maxTokens && holders.length) { holders.shift().token = false; held--; }
      }
    }
    sq.tokens = held;
  }

  // ---- combat ------------------------------------------------------------
  function startAttack(e, typeName) {
    const def = ATTACKS[typeName];
    if (!def) return;
    e.attack = { type: typeName, def, phase: 'windup', t: 0, k: 0, landed: false, parried: false };
    e.guardHold = 0;
  }

  function endAttack(e) {
    e.attack = null;
    e.body.tellMat.opacity = 0;
    e.body.tellDisc.visible = false; e.body.discMat.opacity = 0;
    const base = e.cfg.duel ? 1.1 : 1.5;
    e.attackCool = base + rng() * (e.wary ? 2.6 : 1.5) * (1.4 - e.cfg.aggression);
  }

  function updateAttack(e, dt) {
    const a = e.attack;
    if (!a) {
      // An attack cancelled from outside (a hit, a state change, the critique
      // harness) used to leave the telegraph glowing on a fighter who was not
      // swinging at anything. The tell must mean exactly one thing.
      if (e.body.tellMat.opacity !== 0) {
        e.body.tellMat.opacity = 0;
        if (e.body.tellRing) e.body.tellRing.scale.setScalar(1);
      }
      if (e.body.tellDisc.visible) { e.body.tellDisc.visible = false; e.body.discMat.opacity = 0; }
      return;
    }
    a.t += dt;
    const d = a.def;
    const tell = e.body.tellMat;

    if (a.phase === 'windup') {
      a.k = clamp(a.t / d.windup, 0, 1);
      // The tell. Parryable steel glows warm and steady; an unblockable runs
      // hot red and pulses, so the decision is made before the strike lands.
      if (d.unblockable) {
        tell.color.copy(TELL_UNBLOCK);
        tell.opacity = smooth(a.k, 0.06, 0.30) * (0.82 + Math.sin(a.t * 26) * 0.18);
        e.body.discMat.color.copy(DISC_UNBLOCK);
      } else {
        tell.color.copy(TELL_PARRY);
        tell.opacity = smooth(a.k, 0.08, 0.46) * 0.78;
        e.body.discMat.color.copy(DISC_PARRY);
      }
      // The ring contracts onto the grip as the swing loads: a wind-up clock.
      if (e.body.tellRing) e.body.tellRing.scale.setScalar(lerp(1.55, 0.85, smooth(a.k, 0, 1)));
      // The ground scuff tightens under the feet as the swing loads. It states
      // that a swing is COMING, not how far it reaches — reach used to drive
      // the radius and that is what grew it into a four-metre arcade decal.
      // The spread here is a fifth of a metre, all of it inside his stance.
      const disc = e.body.tellDisc;
      if (!d.ranged) {
        disc.visible = true;
        disc.scale.setScalar(lerp(1.20, 1.00, smooth(a.k, 0, 1)));
        e.body.discMat.opacity = smooth(a.k, 0.10, 0.50) * (d.unblockable ? 0.34 : 0.24);
      }
      // Track the target through the windup, but progressively lock in — you
      // can walk out of a committed swing.
      faceTo(e, playerPos.x, playerPos.z, dt, lerp(4.5, 0.5, a.k));
      if (a.t >= d.windup) { a.phase = 'strike'; a.t = 0; a.k = 0; tell.opacity = d.unblockable ? 0.96 : 0.86; }
    } else if (a.phase === 'strike') {
      a.k = clamp(a.t / d.strike, 0, 1);
      tell.opacity = lerp(d.unblockable ? 0.96 : 0.86, 0, a.k);
      // The scuff flicks outward and fades as the blade goes through.
      e.body.tellDisc.scale.setScalar(lerp(1.00, 1.26, a.k));
      e.body.discMat.opacity = lerp(d.unblockable ? 0.34 : 0.24, 0, a.k);
      if (!a.landed) {
        a.landed = true;
        if (d.ranged) {
          _v.copy(e.root.position); _v.y += 1.45 * e.cfg.scale;
          _v2.copy(playerPos); _v2.y += 1.1;
          fireArrow(_v, _v2);
        } else {
          const pd = Math.hypot(playerPos.x - e.root.position.x, playerPos.z - e.root.position.z);
          const toYaw = Math.atan2(playerPos.x - e.root.position.x, playerPos.z - e.root.position.z);
          const off = Math.abs(angleDelta(e.yaw, toYaw));
          if (pd < d.reach && off < d.arc) hurtPlayer(d.dmg, !d.unblockable, e.root.position.x, e.root.position.z);
        }
      }
      if (a.t >= d.strike) { a.phase = 'recover'; a.t = 0; a.k = 0; }
    } else {
      a.k = clamp(a.t / d.recover, 0, 1);
      tell.opacity = 0;
      e.body.tellDisc.visible = false;
      e.body.discMat.opacity = 0;
      if (e.body.tellRing) e.body.tellRing.scale.setScalar(1);
      if (a.t >= d.recover) { if (api.freeze) { a.phase = 'windup'; a.t = 0; a.k = 0; } else endAttack(e); }
    }
  }

  // A parry only counts against a blockable attack in its windup or the first
  // instant of the strike. Parry an unblockable and the player eats it.
  function tryParry() {
    let any = false;
    for (const e of list) {
      if (!e.alive || !e.attack) continue;
      const a = e.attack;
      const d = a.def;
      if (d.ranged) continue;
      const dist = e.root.position.distanceTo(playerPos);
      if (dist > d.reach + 1.2) continue;
      const inWindow = (a.phase === 'windup' && a.k > 0.35) || (a.phase === 'strike');
      if (!inWindow) continue;
      any = true;
      if (d.unblockable) {
        // Wrong answer. The tell said so.
        hurtPlayer(Math.round(d.dmg * 0.6), false, e.root.position.x, e.root.position.z);
      } else {
        a.parried = true;
        applyHit(e, 6, d.poise * 2.4, true);
        // Knocked back out of the strike.
        const away = Math.atan2(e.root.position.x - playerPos.x, e.root.position.z - playerPos.z);
        e.root.position.x += Math.sin(away) * 0.55;
        e.root.position.z += Math.cos(away) * 0.55;
        endAttack(e);
      }
    }
    return any;
  }

  // The reaction half of a hit: alertness, poise, stagger, knockdown. When
  // combat.js has adopted these bodies it owns the health pool and calls in
  // here through e.onHit, so `extern` skips the local damage arithmetic and
  // the two systems never disagree about who is alive.
  function reactToHit(e, dmg, dir) {
    if (!e.alive) return;
    if (dir && (dir.x || dir.z)) {
      e.squad.lastKnown.set(e.root.position.x - dir.x * 2, e.root.position.y, e.root.position.z - dir.z * 2);
    }
    applyHit(e, dmg, dmg * 0.6, false, true);
  }

  function applyHit(e, dmg, poiseDmg, fromParry, extern) {
    if (!e.alive) return;
    // One blow, one reaction: combat.js and the local fallback can both fire in
    // the same frame and a double count would halve every enemy's health.
    if (timeNow - e.lastHitAt < 0.09) return;
    e.lastHitAt = timeNow;
    // Blocking eats most of it, but the poise damage still lands.
    let d = dmg;
    if (e.guard > 0.55 && !fromParry) {
      const toYaw = Math.atan2(playerPos.x - e.root.position.x, playerPos.z - e.root.position.z);
      if (Math.abs(angleDelta(e.yaw, toYaw)) < 1.15) { d = Math.round(dmg * 0.18); poiseDmg *= 0.55; }
    }
    if (!extern) e.hp -= d;
    e.poise -= poiseDmg;
    e.alert = 1.2;
    e.lastSeen = timeNow;
    e.squad.lastKnown.copy(playerPos);
    if (e.state === 'idle' || e.state === 'patrol' || e.state === 'suspicious') setState(e, 'engage');

    if (e.hp <= 0) { kill(e); return; }

    if (e.poise <= 0) {
      e.poise = e.maxPoise * 0.65;
      e.staggerDecay = 3.2;
      e.staggerCount++;
      if (e.staggerCount >= 3 || fromParry) {
        e.staggerCount = 0;
        setState(e, 'down');
        e.reactT = 0; e.reactDur = fromParry ? 1.5 : 2.0;
      } else {
        setState(e, 'stagger');
        e.reactT = 0; e.reactDur = 0.55;
      }
      e.attack = null;
      e.body.tellMat.opacity = 0;
      e.body.tellDisc.visible = false; e.body.discMat.opacity = 0;
      e.token = false; e.tokenCool = 2.0;
    }
    e.wary = e.hp / e.maxHp < 0.36;
  }

  function kill(e) {
    e.alive = false;
    e.hp = 0;
    e.token = false;
    e.attack = null;
    e.body.tellMat.opacity = 0;
    e.body.tellDisc.visible = false; e.body.discMat.opacity = 0;
    setState(e, 'dead');
    e.state = 'dead';
    e.reactT = 0; e.reactDur = 1.0;
    e.deadT = 0;
    e.targetSpeed = 0; e.speed = 0;
  }

  // Self-resolved player hits. If a combat lane takes over it sets
  // externalHitResolution and calls damage() itself; until then the enemies
  // still react to the player's sword so the fight is playable in isolation.
  function resolvePlayerAttacks() {
    const inp = ctx.input;
    if (!inp) return;
    // A parry is always ours: these telegraphs are ours, and combat.js only
    // knows how to parry its own sparring band.
    if (inp.parry) tryParry();
    if (api.externalHitResolution) return;
    const light = inp.attack, heavy = inp.heavy;
    if (!light && !heavy) return;
    const reach = heavy ? 3.2 : 2.7;
    const arc = heavy ? 1.2 : 0.95;
    const dmg = heavy ? 42 : 24;
    const poiseDmg = heavy ? 34 : 15;
    const pyaw = ctx.player ? ctx.player.yaw : 0;
    for (const e of list) {
      if (!e.alive) continue;
      const dx = e.root.position.x - playerPos.x, dz = e.root.position.z - playerPos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > reach) continue;
      if (Math.abs(angleDelta(pyaw, Math.atan2(dx, dz))) > arc) continue;
      applyHit(e, dmg, poiseDmg, false);
      // Shove them off the sword.
      const away = Math.atan2(dx, dz);
      e.root.position.x += Math.sin(away) * (heavy ? 0.32 : 0.18);
      e.root.position.z += Math.cos(away) * (heavy ? 0.32 : 0.18);
    }
  }

  // ---- per-enemy behaviour ----------------------------------------------
  function behave(e, dt) {
    const cfg = e.cfg;
    const pos = e.root.position;
    const distP = Math.hypot(playerPos.x - pos.x, playerPos.z - pos.z);
    e.wantGuard = 0;

    if (e.state === 'dead') {
      e.targetSpeed = 0;
      e.reactT = Math.min(e.reactDur, e.reactT + dt);
      e.deadT += dt;
      return;
    }
    if (e.state === 'stagger' || e.state === 'down') {
      e.targetSpeed = 0;
      e.reactT += dt;
      if (e.reactT >= e.reactDur) {
        setState(e, 'engage');
        e.poise = e.maxPoise;
        e.tokenCool = Math.max(e.tokenCool, 0.8);
      }
      return;
    }

    if (e.staggerDecay > 0) { e.staggerDecay -= dt; if (e.staggerDecay <= 0) e.staggerCount = 0; }
    if (e.tokenCool > 0) e.tokenCool -= dt;
    if (e.dodgeCool > 0) e.dodgeCool -= dt;
    if (e.attackCool > 0) e.attackCool -= dt;
    e.poise = Math.min(e.maxPoise, e.poise + dt * 7);

    // ---- unaware: walk the route, stop, look around ----------------------
    if (e.state === 'idle' || e.state === 'patrol') {
      if (e.squad.route.length === 0) {
        // Duellists do not patrol; they wait where they chose to wait.
        driveTo(e, e.home.x, e.home.z, cfg.walk, dt, 1.0);
        if (Math.hypot(e.home.x - pos.x, e.home.z - pos.z) < 1.2) faceTo(e, playerPos.x, playerPos.z, dt, 0.7);
        return;
      }
      if (e.pauseTimer > 0) {
        e.pauseTimer -= dt;
        e.targetSpeed = 0;
        if (e.pauseTimer <= 0) setState(e, 'patrol');
        return;
      }
      const wp = e.squad.route[e.routeIndex % e.squad.route.length];
      if (driveTo(e, wp.x, wp.z, cfg.walk, dt, 2.0)) {
        e.routeIndex = (e.routeIndex + 1) % e.squad.route.length;
        e.pauseTimer = 1.6 + rng() * 3.4;
        setState(e, 'idle');
      }
      return;
    }

    // ---- suspicious: stop dead, square up, hand to the hilt --------------
    if (e.state === 'suspicious') {
      e.targetSpeed = 0;
      const lk = e.squad.lastKnown;
      faceTo(e, e.seesTarget ? playerPos.x : lk.x, e.seesTarget ? playerPos.z : lk.z, dt, 3.2);
      // Above two thirds they start stepping toward it — the classic tell.
      if (e.alert > 0.66) {
        const tx = e.seesTarget ? playerPos.x : lk.x, tz = e.seesTarget ? playerPos.z : lk.z;
        if (Math.hypot(tx - pos.x, tz - pos.z) > 7) driveTo(e, tx, tz, cfg.walk * 0.8, dt, 6.5);
      }
      return;
    }

    // ---- searching: sweep toward the last known position -----------------
    if (e.state === 'search') {
      const lk = e.squad.lastKnown;
      const d = Math.hypot(lk.x - pos.x, lk.z - pos.z);
      if (d > 2.5) {
        driveTo(e, lk.x, lk.z, cfg.jog, dt, 2.2);
      } else {
        // Arrived and found nothing. Fan out from the last known point.
        e.targetSpeed = 0;
        e.strafeTimer -= dt;
        if (e.strafeTimer <= 0) {
          e.strafeTimer = 1.6 + rng() * 1.8;
          const a = rng() * TAU;
          const rr = 6 + rng() * 12;
          e.searchX = lk.x + Math.sin(a) * rr;
          e.searchZ = lk.z + Math.cos(a) * rr;
        }
        if (e.searchX !== undefined) driveTo(e, e.searchX, e.searchZ, cfg.walk, dt, 1.6);
      }
      return;
    }

    // ---- standoff: the duel ----------------------------------------------
    if (e.state === 'standoff') {
      e.duelTimer += dt;
      e.targetSpeed = 0;
      faceTo(e, playerPos.x, playerPos.z, dt, 2.4);
      e.drawn = true;
      // Hold until the player closes, then break into the fight with a
      // committed opening strike.
      if (distP < 5.0 && e.duelTimer > 1.2) {
        e.duelPhase = 'fight';
        setState(e, 'engage');
        e.attackCool = 0.25;
      } else if (distP > 26) {
        e.duelTimer = 0;
      }
      return;
    }

    // ---- engaged ---------------------------------------------------------
    e.drawn = true;
    const inAttack = !!e.attack;

    // Ranged fighters keep their distance and shoot from it.
    if (cfg.ranged) {
      const want = 14 + Math.sin(timeNow * 0.4 + e.id) * 3;
      if (distP < want - 3) {
        // Back off, still facing.
        const away = Math.atan2(pos.x - playerPos.x, pos.z - playerPos.z);
        driveTo(e, pos.x + Math.sin(away) * 8, pos.z + Math.cos(away) * 8, cfg.jog, dt, 0.4);
        faceTo(e, playerPos.x, playerPos.z, dt, 4);
      } else if (distP > cfg.sight * 0.6) {
        driveTo(e, playerPos.x, playerPos.z, cfg.jog, dt, 3);
      } else {
        e.targetSpeed = 0;
        faceTo(e, playerPos.x, playerPos.z, dt, 4);
        if (!inAttack && e.attackCool <= 0 && e.seesTarget) startAttack(e, 'shoot');
      }
      return;
    }

    // Melee: hold the assigned ring slot unless holding a token.
    const slotX = playerPos.x + Math.sin(e.slotAngle) * e.slotRadius;
    const slotZ = playerPos.z + Math.cos(e.slotAngle) * e.slotRadius;

    if (inAttack) {
      // Committed. Step in slightly through the strike so it has weight.
      const a = e.attack;
      e.targetSpeed = a.phase === 'strike' ? cfg.jog * 0.7 : 0;
      if (a.phase === 'strike') {
        e.heading = Math.atan2(playerPos.x - pos.x, playerPos.z - pos.z);
        e.yaw += clamp(angleDelta(e.yaw, e.heading), -3 * dt, 3 * dt);
      }
      return;
    }

    // Back off when badly hurt: wider ring, more guard, occasional retreat.
    if (e.wary && distP < e.slotRadius * 0.8 && rng() < 0.02) {
      e.retreatTimer = 0.6 + rng() * 0.6;
    }
    if (e.retreatTimer > 0) {
      e.retreatTimer -= dt;
      const away = Math.atan2(pos.x - playerPos.x, pos.z - playerPos.z);
      driveTo(e, pos.x + Math.sin(away) * 6, pos.z + Math.cos(away) * 6, cfg.jog, dt, 0.4);
      faceTo(e, playerPos.x, playerPos.z, dt, 5);
      e.wantGuard = 1;
      return;
    }

    if (e.token) {
      // Close and commit.
      const reach = ATTACKS[cfg.attacks[0]].reach;
      const closeTo = reach * 0.72;
      if (distP > closeTo) {
        driveTo(e, playerPos.x, playerPos.z, distP > 8 ? cfg.run : cfg.jog, dt, closeTo);
        faceTo(e, playerPos.x, playerPos.z, dt, 3.2);
      } else {
        e.targetSpeed = 0;
        faceTo(e, playerPos.x, playerPos.z, dt, 6.0);
        if (e.attackCool <= 0) {
          const pick = cfg.attacks[(rng() * cfg.attacks.length) | 0];
          startAttack(e, pick);
        }
      }
    } else {
      // Circle the ring slot. Guard up, sidestepping, waiting for a turn.
      const slotDist = Math.hypot(slotX - pos.x, slotZ - pos.z);
      if (slotDist > 1.4) {
        driveTo(e, slotX, slotZ, slotDist > 7 ? cfg.jog : cfg.walk * 1.35, dt, 1.0);
      } else {
        e.targetSpeed = 0;
        e.strafeTimer -= dt;
        if (e.strafeTimer <= 0) { e.strafeTimer = 1.6 + rng() * 2.2; e.strafe *= -1; }
        e.slotAngle += e.strafe * dt * 0.42;
      }
      faceTo(e, playerPos.x, playerPos.z, dt, 4.5);
      e.wantGuard = cfg.block * (distP < 6 ? 1 : 0.35);
    }

    // Reactive defence: when the player swings and this one is not attacking,
    // it either raises a guard or gets out of the way.
    const inp = ctx.input;
    if (inp && (inp.attack || inp.heavy) && distP < 4.2 && e.dodgeCool <= 0) {
      if (rng() < cfg.dodge) {
        e.dodgeCool = 1.3 + rng();
        const side = rng() < 0.5 ? 1 : -1;
        const a = Math.atan2(pos.x - playerPos.x, pos.z - playerPos.z) + side * 1.25;
        e.dodgeTarget = [pos.x + Math.sin(a) * 3.2, pos.z + Math.cos(a) * 3.2];
        e.dodgeTimer = 0.4;
      } else if (rng() < cfg.block) {
        e.wantGuard = 1;
        e.guardHold = 0.45;
      }
    }
    if (e.dodgeTimer > 0) {
      e.dodgeTimer -= dt;
      driveTo(e, e.dodgeTarget[0], e.dodgeTarget[1], cfg.run, dt, 0.3);
      faceTo(e, playerPos.x, playerPos.z, dt, 5);
    }
    if (e.guardHold > 0) { e.guardHold -= dt; e.wantGuard = 1; }
  }

  // ---- integrate + place on the ground ----------------------------------
  function integrate(e, dt) {
    const pos = e.root.position;
    const accel = e.state === 'engage' ? 11 : 7;
    e.speed += clamp(e.targetSpeed - e.speed, -14 * dt, accel * dt);
    e.speed = Math.max(0, e.speed);

    if (e.speed > 0.01) {
      const nx = pos.x + Math.sin(e.yaw) * e.speed * dt;
      const nz = pos.z + Math.cos(e.yaw) * e.speed * dt;
      // Final guard: never step into water or onto a cliff, whatever the
      // steering decided. If the step is illegal, stop rather than clip.
      const nh = world.heightAt(nx, nz);
      if (nh > 1.0 && world.slopeAt(nx, nz) < 0.62) { pos.x = nx; pos.z = nz; }
      else { e.speed *= 0.25; e.headingTimer = 0; }
    }

    // Hard separation, so two bodies never occupy one space. This walks the
    // whole live list rather than only the squad: quest.js spawns loose raiders
    // into their own ad-hoc squads and two of those would otherwise stand
    // inside each other with nothing to push them apart.
    const myR = 0.46 * e.cfg.scale * (e.cfg.girth ?? 1);
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o === e || !o.alive || !o.root.visible) continue;
      const dx = pos.x - o.root.position.x, dz = pos.z - o.root.position.z;
      const d2 = dx * dx + dz * dz;
      const min = myR + 0.46 * o.cfg.scale * (o.cfg.girth ?? 1);
      if (d2 > 0.0001 && d2 < min * min) {
        const d = Math.sqrt(d2);
        const push = (min - d) * 0.5;
        pos.x += (dx / d) * push; pos.z += (dz / d) * push;
      }
    }
    // And out of the player. Without this a committed attacker walks into the
    // camera and the fight turns into a wrestle inside one body.
    {
      const dx = pos.x - playerPos.x, dz = pos.z - playerPos.z;
      const d2 = dx * dx + dz * dz;
      const min = myR + 0.42;
      if (d2 > 0.0001 && d2 < min * min) {
        const d = Math.sqrt(d2);
        pos.x += (dx / d) * (min - d); pos.z += (dz / d) * (min - d);
      }
    }

    // Ground truth. This line is the reason nothing ever floats and nothing
    // ever stands inside a hillside.
    pos.y = world.heightAt(pos.x, pos.z) - e.sink;
    e.root.rotation.y = e.yaw;

    // Plant on the surface rather than standing bolt upright on a hillside.
    if ((frame + e.id) % 3 === 0) {
      const n = world.normalAt(pos.x, pos.z);
      e.tilt.set(n.x, n.z);
    }
    const lie = e.state === 'dead' ? clamp(e.reactT / Math.max(0.001, e.reactDur), 0, 1) : 0;
    const tiltAmt = 0.42;
    e.root.rotation.z = damp(e.root.rotation.z, -e.tilt.x * tiltAmt, 6, dt);
    e.root.rotation.x = damp(e.root.rotation.x, e.tilt.y * tiltAmt + lie * 0.30, 4, dt);
  }

  // ---- lifecycle ---------------------------------------------------------
  function setActive(sq, on) {
    if (sq.active === on) return;
    sq.active = on;
    for (const m of sq.members) m.root.visible = on;
    for (const m of sq.members) if (!on) { m.speed = 0; m.targetSpeed = 0; }
  }

  function resetAll() {
    for (const e of list) {
      if (!e.alive) continue;
      e.alert = 0; e.attack = null; e.token = false;
      e.body.tellMat.opacity = 0; e.body.tellDisc.visible = false; e.body.discMat.opacity = 0;
      e.guard = 0; e.wantGuard = 0;
      e.retreatTimer = 0; e.dodgeTimer = 0; e.guardHold = 0;
      e.duelPhase = 'wait'; e.duelTimer = 0;
      e.state = 'patrol'; e.drawn = false;
      e.lastSeen = -999;
      e.pauseTimer = rng() * 2;
    }
    for (const sq of squads) { sq.alert = 0; sq.hasTarget = false; sq.tokens = 0; }
    for (const a of arrows) { a.live = false; a.mesh.visible = false; }
    api.playerHp = api.playerMaxHp;
  }

  // ---- build the world's encounters -------------------------------------
  for (const def of ENCOUNTERS) makeSquad(def);

  // ---- public ------------------------------------------------------------
  api.spawn = function spawn(x, z, kind = 'raider') {
    const p = snapToGround(x, z, 0.3, 40);
    const sq = {
      id: 'adhoc' + nextId, def: { roster: [kind] },
      x: p.x, z: p.z, r: 16, duel: KINDS[kind]?.duel || false,
      members: [], route: [], alert: 0, tokens: 0, maxTokens: 1,
      tokenTimer: 0, slotTimer: 0,
      lastKnown: new THREE.Vector3(p.x, groundY(p.x, p.z), p.z),
      hasTarget: false, lostTimer: 0, built: true, active: true,
    };
    squads.push(sq);
    const e = makeEnemy(kind, p.x, p.z, sq);
    sq.members.push(e);
    return e;
  };

  api.nearestTo = function nearestTo(vec, radius = 1e9) {
    let best = null, bd = radius * radius;
    for (const e of list) {
      if (!e.alive || !e.root.visible) continue;
      const d = e.root.position.distanceToSquared(vec);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  };

  // For the combat lane: report a hit, report a noise, take a target away.
  api.damage = function damage(e, dmg, poiseDmg = dmg * 0.6) {
    if (!e) return;
    applyHit(e, dmg, poiseDmg, false);
  };
  api.parry = tryParry;
  api.startAttack = startAttack;
  api.noise = function noise(pos, radius = 20) {
    for (const e of list) {
      if (!e.alive) continue;
      const d = e.root.position.distanceTo(pos);
      if (d < radius) {
        e.alert = Math.max(e.alert, 0.55 + (1 - d / radius) * 0.5);
        e.squad.lastKnown.copy(pos);
      }
    }
  };
  api.reset = resetAll;

  // =========================================================================
  //  UPDATE
  // =========================================================================
  api.update = function update(dt, c) {
    frame++;
    timeNow += dt;
    const player = c.player;
    if (!player) return;
    playerPos.copy(player.position);

    // The screenshot harness teleports the player across the island. Without
    // this the whole map would come sprinting after him.
    if (lastPlayerPos.lengthSq() > 0 && lastPlayerPos.distanceTo(playerPos) > 25) resetAll();
    lastPlayerPos.copy(playerPos);

    // combat.js adopts everything in `list` and stamps __combat on it. Once it
    // has, its katana is the only thing allowed to spend enemy health — two
    // independent resolvers would each take a full swing's worth off the same
    // body, and combat.state.kills (which quest.js counts to close the village
    // beat) only ticks when combat itself lands the killing blow.
    if (!api.externalHitResolutionForced) {
      api.externalHitResolution = !!(list.length && list[0].__combat);
    }

    let maxAlert = 0, activeCount = 0, engagedCount = 0;

    // This used to refuse to take the built-squad count to zero, because
    // combat.js's syncForeign() read `ctx.enemies.list.length === 0` as "the AI
    // lane has no bodies, this must still be the stub build" and flipped back
    // to its own fallback sparring band — three grey-blue raiders anchored
    // three and a half metres in front of the camera. Measured: with the unload
    // path unguarded, the coast pose emptied the list and put three of them in
    // the middle of the frame.
    //
    // MERGE RECONCILIATION: syncForeign() now LATCHES (combat.js, `everForeign`)
    // — once real bodies have been adopted the band never comes back — so the
    // guard is gone and the last squad unloads like any other. That is the
    // ~176 permanently-resident scene nodes this lane was paying as a
    // workaround, given back.

    for (const sq of squads) {
      if (sq.cleared) continue;
      const d = Math.hypot(sq.x - playerPos.x, sq.z - playerPos.z);
      const want = sq.active ? d < DROP_R : d < ACTIVE_R;
      if (want && !sq.built) buildSquad(sq);
      if (want !== sq.active) setActive(sq, want);
      // Out of sight AND out of mind: give the scene graph its nodes back.
      if (!want && sq.built && d > UNLOAD_R) { unloadSquad(sq); continue; }
      if (!sq.active) continue;

      directSquad(sq, dt);
      maxAlert = Math.max(maxAlert, sq.alert);

      for (const e of sq.members) {
        activeCount++;
        if (e.alive) {
          // Mirror the adopted pool back onto the local one so `wary`, the
          // token director and the stagger thresholds all read the same number
          // the player's health bar is reading.
          const ad = e.__combat;
          if (ad) {
            e.hp = ad.health;
            e.maxHp = ad.maxHealth || e.maxHp;
            if (ad.dead || e.hp <= 0) { kill(e); continue; }
          }
          // Perception is the expensive part; round-robin it rather than
          // paying for a full line-of-sight march on every body every frame.
          if (!api.freeze) {
            e.perceptAccum += dt;
            e.perceptTimer -= dt;
            if (e.perceptTimer <= 0) {
              perceive(e, e.perceptAccum);
              e.perceptAccum = 0;
              e.perceptTimer = e.state === 'engage' ? 0.10 : 0.17;
            }
            thinkAlert(e, dt);
            behave(e, dt);
          }
          updateAttack(e, dt);
          if (e.state === 'engage' || e.state === 'standoff') engagedCount++;
        } else {
          e.deadT += dt;
          e.reactT = Math.min(e.reactDur, e.reactT + dt);
          // Corpses settle, then sink out of the world so the count stays sane.
          if (e.deadT > 14) {
            e.sink = (e.deadT - 14) * 0.22;
            if (e.deadT > 20) { e.root.visible = false; continue; }
          }
        }

        integrate(e, dt);

        // Guard blend, then drive the skeleton.
        e.guard = damp(e.guard, e.wantGuard, 9, dt);
        const aimYaw = angleDelta(e.yaw, Math.atan2(playerPos.x - e.root.position.x, playerPos.z - e.root.position.z));
        e.anim(dt, {
          speed: e.speed,
          state: e.state,
          drawn: e.drawn,
          aimYaw,
          guard: e.attack ? 0 : e.guard,
          attack: e.attack,
          reactK: clamp(e.reactT / Math.max(0.001, e.reactDur), 0, 1),
          wind: c.wind ? c.wind.gust() * c.wind.strength : 0.5,
        });

        // Shadow casting is the single most expensive thing a body does.
        // Only the ones close enough to matter pay for it.
        const near = e.root.position.distanceToSquared(c.camera.position) < 42 * 42;
        if (near !== e.shadowOn) {
          e.shadowOn = near;
          for (const m of e.body.meshes) m.castShadow = near;
        }
      }
    }

    updateArrows(dt);
    if (!api.freeze) resolvePlayerAttacks();

    api.alertLevel = maxAlert;
    api.debug.active = activeCount;
    api.debug.engaged = engagedCount;

    // Rim light follows the real sun, in view space, once for every material.
    if (c.sky && c.camera) {
      _sunView.copy(c.sky.sunPos).transformDirection(c.camera.matrixWorldInverse);
      const warm = c.sky.sun ? c.sky.sun.color : null;
      const strength = c.sky.sun ? clamp(c.sky.sun.intensity * 0.30, 0.15, 1.4) : 0.6;
      for (let i = 0; i < RIM_SHADERS.length; i++) {
        const sh = RIM_SHADERS[i];
        sh.uniforms.uRimDirView.value.copy(_sunView);
        if (warm) sh.uniforms.uRimColor.value.copy(warm).multiplyScalar(1.10);
        sh.uniforms.uRimStrength.value = strength;
      }
    }
  };

  return api;
}
