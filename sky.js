import * as THREE from 'three';

// ============================================================================
//  KAZE NO MICHI — sky, sun, moon, stars, clouds, crepuscular rays, light rig.
//
//  Everything above the terrain line is one custom GLSL dome. three's Preetham
//  `Sky` is gone: it had no night state, no lit clouds, and its sun disc lived
//  on a sprite at 9000 units — outside camera.far (6000). That is why the sun,
//  the moon and every star were silently clipped away and never once reached
//  the screen. The dome draws LAST in the opaque queue with gl_Position.z
//  forced to w, so it only shades pixels the terrain did not claim (early-Z
//  rejection) and can never be clipped by the far plane at all.
//
//  Time convention (core/time.js): t=0.25 sunrise, 0.5 noon, 0.75 sunset,
//  0.0 midnight. The judged poses sit at sun altitude ~9-16 degrees, so the
//  palette is art-directed to make that band read as full magic hour.
//
//  Colour rule, learned the hard way: THREE.ColorManagement is on, so
//  new THREE.Color('#hex') is ALREADY linear — never convert again. And never
//  interpolate hue: every transition below is a straight RGB lerp between
//  named colours, which is why the sky no longer passes through green.
// ============================================================================

const C = (hex, mul = 1) => new THREE.Color(hex).multiplyScalar(mul);
const UP = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
//  Procedural noise atlas. Four tileable channels baked once at boot. Clouds,
//  rays, lunar maria and the milky way all read from this one texture, which
//  keeps the dome shader down to a handful of cache-friendly fetches instead
//  of forty hash evaluations per pixel.
//    R  mid-frequency fbm    cloud body
//    G  low-frequency fbm    coverage modulation, domain warp
//    B  ridged fbm           fibrous cirrus, milky-way dust structure
//    A  high-frequency fbm   erosion detail, lunar surface grain
// ---------------------------------------------------------------------------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fade5 = (t) => t * t * t * (t * (t * 6 - 15) + 10);

function latticeNoise(x, y, P, l) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = fade5(x - x0), fy = fade5(y - y0);
  const i0 = ((x0 % P) + P) % P, i1 = (i0 + 1) % P;
  const j0 = ((y0 % P) + P) % P, j1 = (j0 + 1) % P;
  const a = l[j0 * P + i0], b = l[j0 * P + i1];
  const c = l[j1 * P + i0], d = l[j1 * P + i1];
  const top = a + (b - a) * fx;
  const bot = c + (d - c) * fx;
  return top + (bot - top) * fy;
}

function tileFbm(size, basePeriod, octaves, rng, ridge) {
  const lat = [];
  for (let o = 0; o < octaves; o++) {
    const P = basePeriod << o;
    const l = new Float32Array(P * P);
    for (let i = 0; i < l.length; i++) l[i] = rng();
    lat.push({ P, l });
  }
  const out = new Float32Array(size * size);
  let mn = Infinity, mx = -Infinity;
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      let amp = 0.5, sum = 0, norm = 0;
      for (let o = 0; o < octaves; o++) {
        const { P, l } = lat[o];
        let n = latticeNoise(u * P, v * P, P, l);
        if (ridge) n = 1.0 - Math.abs(n * 2.0 - 1.0);
        sum += amp * n; norm += amp; amp *= 0.5;
      }
      const val = sum / norm;
      out[y * size + x] = val;
      if (val < mn) mn = val;
      if (val > mx) mx = val;
    }
  }
  const inv = 1 / (mx - mn || 1);
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - mn) * inv;
  return out;
}

function makeNoiseAtlas(size) {
  const rng = mulberry32(0x5EA51DE);
  const r = tileFbm(size, 5, 5, rng, false);
  const g = tileFbm(size, 3, 4, rng, false);
  const b = tileFbm(size, 4, 5, rng, true);
  const a = tileFbm(size, 16, 3, rng, false);
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4 + 0] = (r[i] * 255) | 0;
    data[i * 4 + 1] = (g[i] * 255) | 0;
    data[i * 4 + 2] = (b[i] * 255) | 0;
    data[i * 4 + 3] = (a[i] * 255) | 0;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
//  The paintings. One keyframe per light state, keyed on sun altitude in
//  degrees; between keys everything is a plain RGB / scalar lerp.
//
//    -90  midnight        deep indigo, milky way, moon key, long cold shadows
//    -18  late twilight   the last blue before true dark
//     -8  blue hour       indigo zenith over a magenta horizon
//     -3  sunset          the horizon burns, the zenith stays cobalt
//      1  sun on horizon  maximum warmth, maximum ray fan
//      6  low golden      the sun clears the sea
//     14  MAGIC HOUR      <- every judged daylight pose lives here
//     26  warm afternoon
//     50  day
//     90  noon
// ---------------------------------------------------------------------------
const KEYS = [
  {
    a: -90,
    zen: C('#3c5a94', 0.40), mid: C('#43639f', 0.46), hor: C('#61789f', 0.58),
    haze: C('#1a2740', 0.90), halo: C('#26354f', 0.10),
    horOpp: C('#5a6d92', 0.58), belt: C('#404e78', 0.00),
    sunTint: C('#ffffff', 1), cLit: C('#8fa4cc', 0.36), cShade: C('#161e30', 0.55),
    cRim: C('#b6c9e8', 0.55), cHor: C('#2c3b56', 0.55), rayCol: C('#8fa4cc', 0.10),
    moonGlow: C('#9fb7e0', 0.085), fogC: C('#2d3c58', 0.32),
    sunC: C('#7a9ce8'), hemiSky: C('#22429f'), hemiGrd: C('#0a0f1a'),
    ambC: C('#2c4a86'), fillC: C('#4a63a0'),
    discHDR: 0, sunR: 0.011, flatten: 0.0, warmGlow: 0.0, rayGate: 0.0, beltAmt: 0.00,
    milky: 1.0, starF: 1.0, moonI: 1.0,
    sunI: 7.00, hemiI: 11.00, ambI: 1.90, fillI: 0.95,
    expo: 1.16, fogD: 0.00060, cover: 0.40, coverHi: 0.30, cloudA: 0.55, cirrusA: 0.35,
  },
  {
    a: -18,
    zen: C('#2c4a86', 0.46), mid: C('#3a5a97', 0.56), hor: C('#6a6f9c', 0.70),
    haze: C('#22304e', 0.95), halo: C('#5c5a86', 0.30),
    horOpp: C('#5d6a94', 0.70), belt: C('#6a5f86', 0.10),
    sunTint: C('#ffffff', 1), cLit: C('#9aa6c8', 0.44), cShade: C('#1a2236', 0.60),
    cRim: C('#c3c6e4', 0.70), cHor: C('#374466', 0.62), rayCol: C('#8f8fc0', 0.16),
    moonGlow: C('#a3bae2', 0.078), fogC: C('#39456e', 0.40),
    sunC: C('#96b4ee'), hemiSky: C('#25459f'), hemiGrd: C('#0c1220'),
    ambC: C('#30508c'), fillC: C('#4e6aa0'),
    discHDR: 0, sunR: 0.011, flatten: 0.0, warmGlow: 0.30, rayGate: 0.05, beltAmt: 0.35,
    milky: 0.82, starF: 0.88, moonI: 0.95,
    sunI: 6.40, hemiI: 10.30, ambI: 1.85, fillI: 1.00,
    expo: 1.17, fogD: 0.00068, cover: 0.42, coverHi: 0.33, cloudA: 0.62, cirrusA: 0.42,
  },
  {
    a: -8,
    zen: C('#22437f', 0.54), mid: C('#4a5c9c', 0.68), hor: C('#9c6a8e', 0.88),
    haze: C('#443a58', 0.90), halo: C('#c9718a', 0.55),
    horOpp: C('#6a6f9e', 0.76), belt: C('#a3708e', 0.35),
    sunTint: C('#ff9a6a', 1), cLit: C('#c78ea0', 0.88), cShade: C('#28304c', 0.70),
    cRim: C('#ffb0a0', 1.30), cHor: C('#6a5578', 0.80), rayCol: C('#d08aa0', 0.34),
    moonGlow: C('#a8bde2', 0.055), fogC: C('#7d6c94', 0.52),
    sunC: C('#c98a86'), hemiSky: C('#6a6fae'), hemiGrd: C('#221a24'),
    ambC: C('#9a8ab4'), fillC: C('#6a80b8'),
    discHDR: 0, sunR: 0.0125, flatten: 0.30, warmGlow: 0.85, rayGate: 0.35, beltAmt: 0.85,
    milky: 0.32, starF: 0.40, moonI: 0.70,
    sunI: 3.40, hemiI: 6.60, ambI: 1.30, fillI: 1.05,
    expo: 1.21, fogD: 0.00092, cover: 0.46, coverHi: 0.40, cloudA: 0.74, cirrusA: 0.60,
  },
  {
    a: -3,
    zen: C('#25529c', 0.82), mid: C('#8f6d9e', 1.00), hor: C('#ff6a30', 0.82),
    haze: C('#8a5f5e', 0.85), halo: C('#ff8a4a', 0.75),
    horOpp: C('#8c7a9e', 0.98), belt: C('#d98a92', 0.55),
    sunTint: C('#ff8a44', 1), cLit: C('#ffa06a', 1.70), cShade: C('#4a4468', 0.78),
    cRim: C('#ffbb84', 2.60), cHor: C('#b0728a', 1.00), rayCol: C('#ff9a5e', 0.62),
    moonGlow: C('#aabfe4', 0.040), fogC: C('#d6968a', 0.68),
    sunC: C('#ff8f52'), hemiSky: C('#a08cbe'), hemiGrd: C('#3a2620'),
    ambC: C('#bca2be'), fillC: C('#7890c8'),
    discHDR: 6.0, sunR: 0.0155, flatten: 0.55, warmGlow: 1.15, rayGate: 1.00, beltAmt: 1.00,
    milky: 0.06, starF: 0.10, moonI: 0.40,
    sunI: 4.20, hemiI: 4.80, ambI: 1.00, fillI: 1.20,
    expo: 1.30, fogD: 0.00120, cover: 0.50, coverHi: 0.46, cloudA: 0.82, cirrusA: 0.72,
  },
  {
    a: 1,
    zen: C('#2b5cae', 0.90), mid: C('#c78b8e', 1.05), hor: C('#ff7f34', 0.86),
    haze: C('#b4785c', 0.85), halo: C('#ffa254', 0.85),
    horOpp: C('#c49aa0', 1.06), belt: C('#e89a95', 0.60),
    sunTint: C('#ffb268', 1), cLit: C('#ffb87e', 2.10), cShade: C('#59567e', 0.72),
    cRim: C('#ffd0a0', 3.20), cHor: C('#e0997e', 1.05), rayCol: C('#ffb066', 0.72),
    moonGlow: C('#aabfe4', 0.035), fogC: C('#f0b09c', 0.74),
    sunC: C('#ff9b52'), hemiSky: C('#c8b0d2'), hemiGrd: C('#54301e'),
    ambC: C('#d4bcd0'), fillC: C('#84a0d8'),
    discHDR: 12.0, sunR: 0.0150, flatten: 0.45, warmGlow: 1.30, rayGate: 1.00, beltAmt: 1.00,
    milky: 0.0, starF: 0.02, moonI: 0.26,
    sunI: 6.20, hemiI: 4.50, ambI: 0.86, fillI: 1.25,
    expo: 1.33, fogD: 0.00135, cover: 0.50, coverHi: 0.48, cloudA: 0.84, cirrusA: 0.76,
  },
  {
    a: 6,
    zen: C('#3568bc', 0.82), mid: C('#d7a294', 0.94), hor: C('#ff9040', 0.90),
    haze: C('#c68a66', 0.85), halo: C('#ffb268', 0.80),
    horOpp: C('#d4a7a4', 1.06), belt: C('#e8a49c', 0.50),
    sunTint: C('#ffcb8c', 1), cLit: C('#ffc793', 2.20), cShade: C('#5f6a94', 0.60),
    cRim: C('#ffdcb2', 3.30), cHor: C('#eda882', 1.00), rayCol: C('#ffbc78', 0.70),
    moonGlow: C('#aabfe4', 0.030), fogC: C('#ffcaa8', 0.78),
    sunC: C('#ffab63'), hemiSky: C('#d6c8e0'), hemiGrd: C('#5e3a22'),
    ambC: C('#dcd0e4'), fillC: C('#8ba8dc'),
    discHDR: 15.0, sunR: 0.0132, flatten: 0.24, warmGlow: 1.15, rayGate: 0.96, beltAmt: 0.90,
    milky: 0.0, starF: 0.0, moonI: 0.16,
    sunI: 7.60, hemiI: 4.60, ambI: 0.84, fillI: 1.25,
    expo: 1.32, fogD: 0.00140, cover: 0.48, coverHi: 0.46, cloudA: 0.84, cirrusA: 0.74,
  },
  {
    // ---- MAGIC HOUR. Every daylight pose the critics look at lands here. ----
    a: 14,
    zen: C('#3f76c8', 0.68), mid: C('#d5b3ae', 0.86), hor: C('#ff9a52', 0.90),
    haze: C('#d09d76', 0.85), halo: C('#ffc686', 0.72),
    horOpp: C('#cbb0b4', 1.06), belt: C('#e2acaa', 0.36),
    sunTint: C('#fff0cf', 1), cLit: C('#ffd2a4', 2.20), cShade: C('#63739a', 0.50),
    cRim: C('#ffe3c0', 3.10), cHor: C('#f0b78e', 0.94), rayCol: C('#ffc78c', 0.60),
    moonGlow: C('#aabfe4', 0.026), fogC: C('#ffd2b0', 0.82),
    sunC: C('#ffbb78'), hemiSky: C('#ddd4e6'), hemiGrd: C('#6a4628'),
    ambC: C('#e4dcea'), fillC: C('#96acdf'),
    discHDR: 16.0, sunR: 0.0118, flatten: 0.10, warmGlow: 0.95, rayGate: 0.80, beltAmt: 0.70,
    milky: 0.0, starF: 0.0, moonI: 0.10,
    sunI: 9.50, hemiI: 4.20, ambI: 0.75, fillI: 1.25,
    expo: 1.32, fogD: 0.00135, cover: 0.46, coverHi: 0.44, cloudA: 0.82, cirrusA: 0.70,
  },
  {
    a: 26,
    zen: C('#3d78d0', 0.88), mid: C('#a8c0e2', 0.98), hor: C('#e6c398', 0.92),
    haze: C('#c4b298', 0.88), halo: C('#ffdcae', 0.75),
    horOpp: C('#c8cdd6', 1.10), belt: C('#d8c0c4', 0.12),
    sunTint: C('#fff8e8', 1), cLit: C('#ffeed6', 2.30), cShade: C('#6f83ad', 0.58),
    cRim: C('#fff4e2', 2.60), cHor: C('#dcd2c4', 1.00), rayCol: C('#ffdcb0', 0.34),
    moonGlow: C('#aabfe4', 0.020), fogC: C('#ecd8c6', 0.84),
    sunC: C('#ffe0b4'), hemiSky: C('#d2dcf2'), hemiGrd: C('#6f6048'),
    ambC: C('#e0e4f2'), fillC: C('#9ab4e2'),
    discHDR: 18.0, sunR: 0.0104, flatten: 0.0, warmGlow: 0.55, rayGate: 0.32, beltAmt: 0.25,
    milky: 0.0, starF: 0.0, moonI: 0.05,
    sunI: 6.20, hemiI: 5.00, ambI: 0.80, fillI: 1.15,
    expo: 1.15, fogD: 0.00110, cover: 0.42, coverHi: 0.40, cloudA: 0.80, cirrusA: 0.60,
  },
  {
    a: 50,
    zen: C('#2f68c8', 1.05), mid: C('#82b2ea', 1.10), hor: C('#cadcf0', 1.15),
    haze: C('#b0bcc6', 0.90), halo: C('#eaf2ff', 0.55),
    horOpp: C('#c6d6ea', 1.14), belt: C('#ffffff', 0.00),
    sunTint: C('#ffffff', 1), cLit: C('#ffffff', 2.50), cShade: C('#7a90bc', 0.68),
    cRim: C('#ffffff', 2.20), cHor: C('#cfdcea', 1.05), rayCol: C('#e8f0ff', 0.16),
    moonGlow: C('#aabfe4', 0.012), fogC: C('#cfdef0', 0.88),
    sunC: C('#fff4e0'), hemiSky: C('#c8daff'), hemiGrd: C('#6a5f4c'),
    ambC: C('#dae6f6'), fillC: C('#a8c0ea'),
    discHDR: 20.0, sunR: 0.0095, flatten: 0.0, warmGlow: 0.20, rayGate: 0.08, beltAmt: 0.00,
    milky: 0.0, starF: 0.0, moonI: 0.0,
    sunI: 6.00, hemiI: 4.60, ambI: 0.74, fillI: 1.00,
    expo: 1.02, fogD: 0.00085, cover: 0.38, coverHi: 0.36, cloudA: 0.78, cirrusA: 0.52,
  },
  {
    a: 90,
    zen: C('#2a5fc4', 1.10), mid: C('#7cadea', 1.15), hor: C('#cfe0f2', 1.18),
    haze: C('#b2bec8', 0.92), halo: C('#eaf2ff', 0.50),
    horOpp: C('#cbdaee', 1.16), belt: C('#ffffff', 0.00),
    sunTint: C('#ffffff', 1), cLit: C('#ffffff', 2.55), cShade: C('#7d94c0', 0.70),
    cRim: C('#ffffff', 2.10), cHor: C('#d2dfec', 1.06), rayCol: C('#e8f0ff', 0.12),
    moonGlow: C('#aabfe4', 0.010), fogC: C('#d2e0f0', 0.90),
    sunC: C('#ffffff'), hemiSky: C('#c8daff'), hemiGrd: C('#6a5f4c'),
    ambC: C('#dce8f8'), fillC: C('#a8c0ea'),
    discHDR: 21.0, sunR: 0.0092, flatten: 0.0, warmGlow: 0.16, rayGate: 0.05, beltAmt: 0.00,
    milky: 0.0, starF: 0.0, moonI: 0.0,
    sunI: 5.80, hemiI: 4.50, ambI: 0.72, fillI: 0.98,
    expo: 1.00, fogD: 0.00080, cover: 0.36, coverHi: 0.34, cloudA: 0.78, cirrusA: 0.48,
  },
];

const COLOR_FIELDS = [
  'zen', 'mid', 'hor', 'haze', 'halo', 'sunTint', 'cLit', 'cShade', 'cRim',
  'cHor', 'rayCol', 'moonGlow', 'fogC', 'sunC', 'hemiSky', 'hemiGrd', 'ambC', 'fillC',
  'horOpp', 'belt',
];
const SCALAR_FIELDS = [
  'discHDR', 'sunR', 'flatten', 'warmGlow', 'rayGate', 'beltAmt', 'milky', 'starF', 'moonI',
  'sunI', 'hemiI', 'ambI', 'fillI', 'expo', 'fogD', 'cover', 'coverHi', 'cloudA', 'cirrusA',
];

// A missing field in one keyframe would otherwise produce a NaN colour and a
// black sky. Backfill from a neighbour rather than take the whole game down.
for (let i = 0; i < KEYS.length; i++) {
  const near = KEYS[i - 1] || KEYS[i + 1];
  for (const f of COLOR_FIELDS) if (!KEYS[i][f]) KEYS[i][f] = near[f].clone();
  for (const f of SCALAR_FIELDS) if (typeof KEYS[i][f] !== 'number') KEYS[i][f] = near[f];
}

const MIX = {};
for (const f of COLOR_FIELDS) MIX[f] = new THREE.Color();
for (const f of SCALAR_FIELDS) MIX[f] = 0;

function evalRamp(alt) {
  let i = 0;
  while (i < KEYS.length - 2 && alt > KEYS[i + 1].a) i++;
  const A = KEYS[i], B = KEYS[i + 1];
  const k = THREE.MathUtils.clamp((alt - A.a) / (B.a - A.a), 0, 1);
  const s = k * k * (3 - 2 * k);   // smooth the joins so no keyframe creases
  for (const f of COLOR_FIELDS) MIX[f].copy(A[f]).lerp(B[f], s);
  for (const f of SCALAR_FIELDS) MIX[f] = A[f] + (B[f] - A[f]) * s;
  return MIX;
}

const STAR_COUNT = 1900;

// ---------------------------------------------------------------------------
const DOME_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  // Pin to the far plane: nothing about camera.far can clip the sky, and the
  // depth test rejects every pixel the terrain already owns.
  gl_Position = p.xyww;
}`;

const DOME_FRAG = /* glsl */`
precision highp float;

uniform sampler2D uNoise;
uniform vec3  uSunDir, uSunU, uSunV, uMoonDir, uMoonU, uMoonV, uMoonLight;
uniform vec3  uZen, uMid, uHor, uHorOpp, uBelt, uHaze, uHalo, uSunTint;
uniform vec3  uCLit, uCShade, uCRim, uCHor, uRayCol, uMoonGlow;
uniform vec2  uKeyXZ, uSunXZ, uWindDir, uCamXZ;
uniform float uKeyY, uCamY, uTime;
uniform float uDiscHDR, uSunR, uFlatten, uWarmGlow, uRayGate, uBeltAmt;
uniform float uMilky, uStarF, uMoonI, uMoonR;
uniform float uCover, uCoverHi, uCloudA, uCirrusA, uCloudScroll, uSunUp;

varying vec3 vDir;

// Galactic plane, and an orthonormal basis inside it.
const vec3 MW_AXIS = vec3( 0.3402,  0.5203, -0.7834);
const vec3 MW_E1   = vec3( 0.9349, -0.0972,  0.3414);
const vec3 MW_E2   = vec3( 0.1015, -0.8486, -0.5195);

// GLSL leaves smoothstep undefined when edge0 >= edge1, and several of the
// bands below descend. This one is well defined in both directions.
float sstep(float e0, float e1, float x) {
  float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
float h21(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}
vec3 h33(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
           dot(p, vec3(269.5, 183.3, 246.1)),
           dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453123);
}

// --- cloud density -------------------------------------------------------
float cdens(vec2 uv, float cover, float sharp) {
  vec4 a = texture2D(uNoise, uv);
  vec4 b = texture2D(uNoise, uv * 0.41 + vec2(0.317, 0.629));
  float d = a.r * 0.52 + b.g * 0.48;
  d += (a.a - 0.5) * 0.15;
  return smoothstep(0.0, sharp, d - (1.0 - cover));
}
// Cheap single-fetch approximation, for the march toward the key light.
float cdensLite(vec2 uv, float cover, float sharp) {
  vec4 a = texture2D(uNoise, uv);
  float d = a.r * 0.52 + a.g * 0.48;
  return smoothstep(0.0, sharp, d - (1.0 - cover));
}

// A cumulus deck on a virtual plane: real perspective, so it converges into
// the horizon instead of sitting there as a ring of billboards. Lit by a two
// tap march toward the key light, which gives warm sun-side faces, cool
// self-shadowed bodies and a bright rim exactly where the edge turns away.
vec4 cumulus(vec3 d, float H, float scl, float cover, float sharp,
             float lstep, float phase, float sunAmt) {
  if (d.y < 0.0035) return vec4(0.0);
  float t = (H - uCamY) / d.y;
  vec2 p = uCamXZ + d.xz * t;
  vec2 uv = p * scl + uWindDir * uCloudScroll;

  vec4 w = texture2D(uNoise, uv * 0.23 + vec2(0.11, 0.77));
  uv += (w.rg - 0.5) * 0.40;

  float dens = cdens(uv, cover, sharp);
  if (dens <= 0.002) return vec4(0.0);

  float L1 = cdensLite(uv + uKeyXZ * lstep,       cover, sharp);
  float L2 = cdensLite(uv + uKeyXZ * lstep * 2.7, cover, sharp);
  float sh = exp(-(L1 * 1.55 + L2 * 0.95) * 1.35);
  float rim = clamp(dens - L1, 0.0, 1.0);

  float distF = 1.0 - exp(-t * 0.000030);
  float horiz = smoothstep(0.0035, 0.030, d.y);

  vec3 c = mix(uCShade, uCLit, sh);
  c += uCRim * rim * (0.30 + 2.4 * phase) * sunAmt;
  c += uHalo * phase * 0.30 * sh * sunAmt;
  c = mix(c, uCHor, distF * 0.85);

  float alpha = dens * uCloudA * horiz * (1.0 - distF * 0.22);
  return vec4(c, clamp(alpha, 0.0, 1.0));
}

// High fibrous deck stretched along the wind. This is what actually sells a
// painted sunset: long streaks catching light above and behind the cumulus.
vec4 cirrus(vec3 d, float H, float scl, float cover, float phase, float sunAmt) {
  if (d.y < 0.005) return vec4(0.0);
  float t = (H - uCamY) / d.y;
  vec2 p = uCamXZ + d.xz * t;
  vec2 q = vec2(dot(p, uWindDir), dot(p, vec2(-uWindDir.y, uWindDir.x)));
  vec2 uv = vec2(q.x * 0.20, q.y * 1.30) * scl + uWindDir.yx * (uCloudScroll * 1.9);

  vec4 a = texture2D(uNoise, uv);
  vec4 b = texture2D(uNoise, uv * 2.4 + vec2(0.53, 0.19));
  float dens = a.b * 0.60 + b.b * 0.40;
  dens = smoothstep(1.0 - cover, 1.0 - cover + 0.26, dens);
  if (dens <= 0.002) return vec4(0.0);

  float sh = mix(0.55, 1.0, smoothstep(0.30, 0.75, a.r * 0.5 + b.r * 0.5));
  float distF = 1.0 - exp(-t * 0.000022);
  float horiz = smoothstep(0.005, 0.030, d.y);

  vec3 c = mix(uCShade, uCLit, sh);
  c += uCRim * dens * (0.20 + 3.0 * phase) * sunAmt * 0.70;
  c = mix(c, uCHor, distF * 0.70);

  return vec4(c, clamp(dens * uCirrusA * horiz, 0.0, 1.0));
}

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  float cosT = dot(d, uSunDir);

  // ---- Which way we are facing decides everything about the horizon. The
  // sun's half burns; the half behind us gets the Belt of Venus — a rose band
  // sitting on the blue-grey shadow the planet casts into its own air. Without
  // this the sky is uniformly on fire in every direction, which is the tell of
  // a gradient rather than an atmosphere.
  vec2 dxz = d.xz;
  float lxz = length(dxz);
  float az = lxz > 1e-5 ? dot(dxz / lxz, uSunXZ) : 1.0;   // -1 opposite, 1 at sun
  float azR = az * 0.5 + 0.5;
  float azW = pow(max(az, 0.0), 2.4);
  vec3 horC = mix(uHorOpp, uHor, sstep(0.12, 0.94, azR));

  // ---- base gradient. Three stops on a curved altitude parameter so the
  // falloff into the horizon has no visible shoulder, dithered at the end to
  // kill 8-bit banding.
  float f = pow(clamp(h, 0.0, 1.0), 0.34);
  vec3 col = mix(horC, uMid, sstep(0.0, 0.52, f));
  col = mix(col, uZen, sstep(0.34, 1.0, f));

  // Belt of Venus, then the earth's own shadow sitting underneath it.
  float anti = (1.0 - azR) * uBeltAmt;
  if (anti > 0.002) {
    float bh = (h - 0.078) / 0.062;
    col += uBelt * exp(-bh * bh) * anti;
    float eh = h / 0.034;
    col = mix(col, uHorOpp * 0.42, exp(-eh * eh) * anti * 0.55);
  }

  // ---- the sun's half of the sky runs warmer, hottest along the horizon. Two
  // falloffs so the glow is a graded wash, not a stripe.
  col += uHalo * (azW * exp(-max(h, 0.0) * 3.4) * uWarmGlow * 0.16);
  col += uHalo * (azW * exp(-max(h, 0.0) * 11.0) * uWarmGlow * 0.12);

  // ---- below the horizon: graded haze, deepening downward, warm toward the
  // sun. Terrain covers most of it, but the sea and far shoreline do not.
  float below = sstep(0.0, -0.34, h);
  vec3 hz = uHaze * (1.0 - 0.30 * below) * (1.0 + 0.45 * azW);
  col = mix(col, hz, sstep(0.022, -0.135, h));

  // ---- Mie forward scatter: the glow that wraps a low sun.
  float cs = max(cosT, 0.0);
  float mie = pow(cs, 12.0) * 0.10 + pow(cs, 80.0) * 0.28 + pow(cs, 420.0) * 1.10;
  col += uHalo * mie * uSunUp * 0.40;
  col *= 1.0 + 0.12 * cs * cs * uSunUp;

  // ---- night: milky way, then the faint background star field -----------
  if (uMilky > 0.002) {
    float b = dot(d, MW_AXIS);
    float band = 1.0 - smoothstep(0.02, 0.34, abs(b));
    band *= band;
    if (band > 0.001) {
      vec2 muv = vec2(atan(dot(d, MW_E2), dot(d, MW_E1)) * 0.150, b * 1.15);
      float n1 = texture2D(uNoise, muv * 0.85 + vec2(0.13, 0.51)).r;
      float n2 = texture2D(uNoise, muv * 2.70 + vec2(0.71, 0.22)).b;
      float glow = smoothstep(0.26, 0.86, n1 * 0.62 + n2 * 0.48);
      float lane = 1.0 - 0.78 * smoothstep(0.42, 0.80, n1);
      vec3 mwc = mix(vec3(0.26, 0.34, 0.62), vec3(0.78, 0.72, 0.62), n2 * n2);
      col += mwc * (band * glow * lane * uMilky * 0.42);
      col += vec3(0.30, 0.36, 0.58) * band * 0.060 * uMilky;
    }
  }
  if (uStarF > 0.002) {
    for (int i = 0; i < 2; i++) {
      float sc  = (i == 0) ? 190.0 : 305.0;
      float thr = (i == 0) ? 0.78  : 0.86;
      vec3 p = d * sc;
      vec3 ci = floor(p), cf = fract(p);
      vec3 hv = h33(ci);
      float on = step(thr, hv.z);
      float dd = length(cf - (hv * 0.72 + 0.14));
      float m = pow(max(0.0, 1.0 - dd / 0.58), 5.0);
      float mag = 0.30 + 0.70 * fract(hv.x * 57.31);
      float tw = 0.72 + 0.28 * sin(uTime * 2.4 + hv.y * 31.4);
      vec3 sct = mix(vec3(0.70, 0.80, 1.0), vec3(1.0, 0.88, 0.72), fract(hv.y * 21.7));
      col += sct * (on * m * mag * tw * uStarF * 0.58);
    }
  }

  // ---- moon: a shaded sphere with maria, a real terminator and a glow.
  if (uMoonI > 0.004) {
    vec2 mq = vec2(dot(d, uMoonU), dot(d, uMoonV));
    float mr = length(mq);
    // The (u,v) projection is symmetric about the origin, so without this the
    // moon would also be painted at the antipodal point.
    if (mr < uMoonR * 9.0 && dot(d, uMoonDir) > 0.0) {
      float inside = 1.0 - smoothstep(uMoonR * 0.985, uMoonR * 1.02, mr);
      vec2 nq = mq / uMoonR;
      float zz = sqrt(max(0.0, 1.0 - dot(nq, nq)));
      float lam = clamp(dot(vec3(nq, zz), uMoonLight), 0.0, 1.0);
      lam = smoothstep(0.0, 0.14, lam) * lam;
      float maria = texture2D(uNoise, nq * 0.30 + 0.5).g;
      float grain = texture2D(uNoise, nq * 1.40 + 0.25).a;
      vec3 mc = mix(vec3(0.50, 0.53, 0.61), vec3(1.0, 0.98, 0.93),
                    smoothstep(0.30, 0.66, maria * 0.80 + grain * 0.20));
      float limb = 0.55 + 0.45 * pow(zz, 0.40);
      col += mc * inside * (lam * limb * 2.30 + 0.030) * uMoonI;
      col += uMoonGlow * exp(-mr * 34.0) * uMoonI;
      col += uMoonGlow * exp(-mr *  6.0) * uMoonI * 0.30;
    }
  }


  float sdx = dot(d, uSunU), sdy = dot(d, uSunV);
  float behind = dot(d, uSunDir);

  // ---- crepuscular rays. A noise fan built in the sun's own angular frame,
  // so shafts radiate correctly wherever the sun sits. Drawn BEFORE the cloud
  // decks, so the clouds occlude them and the beams read as light breaking
  // through gaps rather than as a decal over the top.
  if (uRayGate > 0.004 && behind > 0.0) {
    float ang = atan(sdy, sdx);
    float rr = length(vec2(sdx, sdy));
    float s1 = texture2D(uNoise, vec2(ang * 0.152 + uTime * 0.0040, 0.31)).r;
    float s2 = texture2D(uNoise, vec2(ang * 0.061 - uTime * 0.0022, 0.77)).b;
    float s3 = texture2D(uNoise, vec2(ang * 0.331 + uTime * 0.0071, 0.55)).g;
    float shaft = smoothstep(0.44, 0.98, s1 * 0.52 + s2 * 0.34 + s3 * 0.32);
    float radial = exp(-rr * 3.4) * (1.0 - exp(-rr * 26.0));
    col += uRayCol * shaft * radial * uRayGate * smoothstep(-0.06, 0.10, h) * 0.85;

    // Sun pillar: the vertical smear a low sun throws through ice crystals.
    col += uSunTint * exp(-abs(sdx) * 130.0) * exp(-abs(sdy) * 9.0)
         * uRayGate * uSunUp * 0.22;
  }

  // Soft shoulder on the ATMOSPHERE — gradient, glow, Mie, ray fan. ACES alone
  // cannot stop a low-sun glow that reaches 7.0 linear from pasting the upper
  // frame to flat white. This holds the air under ~1.7 while leaving the disc
  // that follows free to stay white-hot, and small.
  col = col / (1.0 + max(vec3(0.0), col - 0.72) * 0.62);

  // ---- sun disc: elliptical near the horizon (atmospheric flattening),
  // limb-darkened, and pushed deep into HDR so ACES rolls it into a soft
  // white-hot core with warm edges instead of a flat clipped circle.
  if (uDiscHDR > 0.01 && behind > 0.0) {
    vec2 sq = vec2(sdx, sdy / max(0.45, 1.0 - uFlatten * 0.50));
    float sr = length(sq);
    if (sr < uSunR * 2.0) {
      float core = 1.0 - smoothstep(uSunR * 0.88, uSunR * 1.08, sr);
      float e = min(sr / uSunR, 1.0);
      float lb = sqrt(max(0.0, 1.0 - e * e));
      col += uSunTint * core * (0.58 + 0.52 * lb) * uDiscHDR;
    }
  }

  // ---- cloud decks. Cirrus first (higher, further), cumulus over it.
  float phase = pow(cs, 5.0);
  if (uCirrusA > 0.004) {
    vec4 ci = cirrus(d, 5400.0, 0.000112, uCoverHi, phase, uSunUp);
    col = mix(col, ci.rgb, ci.a);
  }
  if (uCloudA > 0.004) {
    float lstep = 0.030 / clamp(uKeyY + 0.24, 0.24, 1.0);
    vec4 cu = cumulus(d, 2100.0, 0.000150, uCover, 0.34, lstep, phase, uSunUp);
    col = mix(col, cu.rgb, cu.a);
  }

  // A last breath of atmosphere over everything sitting on the horizon line.
  col = mix(col, uHaze * (1.0 + 0.45 * azW), sstep(0.058, -0.050, h) * 0.45);

  // Dither. Cheap insurance against banding across a very smooth gradient.
  col += (h21(gl_FragCoord.xy + fract(uTime) * 137.0) - 0.5) * 0.0032;

  gl_FragColor = vec4(max(col, 0.0), 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ---------------------------------------------------------------------------
export function createSky(ctx) {
  const { scene, tod, renderer, camera } = ctx;

  const noiseTex = makeNoiseAtlas(512);

  const sunV = new THREE.Vector3(0, 1, 0);    // true sun direction
  const moonV = new THREE.Vector3(0, -1, 0);  // moon direction
  const keyV = new THREE.Vector3(0, 1, 0);    // whichever body owns the shadows
  const sunU = new THREE.Vector3();
  const sunW = new THREE.Vector3();
  const moonU = new THREE.Vector3();
  const moonW = new THREE.Vector3();
  const fillDir = new THREE.Vector3();

  const uniforms = {
    uNoise: { value: noiseTex },
    uSunDir: { value: sunV }, uMoonDir: { value: moonV },
    uSunU: { value: sunU }, uSunV: { value: sunW },
    uMoonU: { value: moonU }, uMoonV: { value: moonW },
    uMoonLight: { value: new THREE.Vector3(0.4, 0.3, 0.86) },
    uZen: { value: new THREE.Color() }, uMid: { value: new THREE.Color() },
    uHor: { value: new THREE.Color() }, uHorOpp: { value: new THREE.Color() },
    uBelt: { value: new THREE.Color() }, uHaze: { value: new THREE.Color() },
    uHalo: { value: new THREE.Color() }, uSunTint: { value: new THREE.Color() },
    uCLit: { value: new THREE.Color() }, uCShade: { value: new THREE.Color() },
    uCRim: { value: new THREE.Color() }, uCHor: { value: new THREE.Color() },
    uRayCol: { value: new THREE.Color() }, uMoonGlow: { value: new THREE.Color() },
    uKeyXZ: { value: new THREE.Vector2(1, 0) },
    uSunXZ: { value: new THREE.Vector2(1, 0) },
    uWindDir: { value: new THREE.Vector2(0.82, 0.57).normalize() },
    uCamXZ: { value: new THREE.Vector2() },
    uKeyY: { value: 0.5 }, uCamY: { value: 0 }, uTime: { value: 0 },
    uDiscHDR: { value: 0 }, uSunR: { value: 0.012 }, uFlatten: { value: 0 },
    uWarmGlow: { value: 1 }, uRayGate: { value: 0 }, uBeltAmt: { value: 0 },
    uMilky: { value: 0 }, uStarF: { value: 0 },
    uMoonI: { value: 0 }, uMoonR: { value: 0.0215 },
    uCover: { value: 0.46 }, uCoverHi: { value: 0.44 },
    uCloudA: { value: 0.8 }, uCirrusA: { value: 0.7 },
    uCloudScroll: { value: 0 }, uSunUp: { value: 1 },
  };

  const domeMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: DOME_VERT,
    fragmentShader: DOME_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(400, 48, 32), domeMat);
  dome.frustumCulled = false;
  dome.renderOrder = 900;   // last opaque: every terrain pixel early-Z rejects it
  dome.name = 'skydome';
  scene.add(dome);

  // ---- bright foreground stars ------------------------------------------
  // These live at 3500 units — INSIDE camera.far. The old rig put them at
  // 12000 and they were silently clipped away every single frame.
  const starGeo = new THREE.BufferGeometry();
  const sp = new Float32Array(STAR_COUNT * 3);
  const ss = new Float32Array(STAR_COUNT);
  const sc = new Float32Array(STAR_COUNT * 3);
  const srng = mulberry32(90210);
  for (let i = 0; i < STAR_COUNT; i++) {
    const th = srng() * Math.PI * 2;
    const ph = Math.acos(Math.pow(srng(), 0.62));
    const r = 3500;
    sp[i * 3] = r * Math.sin(ph) * Math.cos(th);
    sp[i * 3 + 1] = r * Math.cos(ph);
    sp[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
    ss[i] = 1.1 + Math.pow(srng(), 3.4) * 3.8;
    const u = srng();
    const c = u < 0.14 ? new THREE.Color(0.66, 0.76, 1.0)
      : u > 0.86 ? new THREE.Color(1.0, 0.82, 0.62)
        : new THREE.Color(0.94, 0.95, 1.0);
    sc[i * 3] = c.r; sc[i * 3 + 1] = c.g; sc[i * 3 + 2] = c.b;
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  starGeo.setAttribute('aSize', new THREE.BufferAttribute(ss, 1));
  starGeo.setAttribute('color', new THREE.BufferAttribute(sc, 3));
  starGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 3600);

  const starMat = new THREE.ShaderMaterial({
    uniforms: {
      uOpacity: { value: 0 }, uTime: { value: 0 },
      uPR: { value: Math.min(renderer.getPixelRatio(), 2) },
    },
    vertexShader: /* glsl */`
      attribute float aSize;
      varying vec3 vC; varying float vTw;
      uniform float uTime, uPR;
      void main() {
        vC = color;
        float s1 = sin(uTime * 2.1 + position.x * 0.0031 + position.z * 0.0047);
        float s2 = sin(uTime * 5.3 + position.y * 0.0072);
        vTw = 0.66 + 0.24 * s1 + 0.10 * s2;
        gl_PointSize = aSize * uPR;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vC; varying float vTw; uniform float uOpacity;
      void main() {
        float r = length(gl_PointCoord - 0.5) * 2.0;
        float core = pow(max(0.0, 1.0 - r), 2.6);
        float halo = exp(-r * 3.4) * 0.30;
        gl_FragColor = vec4(vC * (core + halo) * uOpacity * vTw, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexColors: true, fog: false,
  });
  const stars = new THREE.Points(starGeo, starMat);
  stars.renderOrder = 905;
  stars.frustumCulled = false;
  scene.add(stars);

  // ---- light rig ---------------------------------------------------------
  // One shadow-casting key. It follows the sun by day and hands over to the
  // moon after dark, crossing through a deep intensity dip so the swap lands
  // inside blue hour, where there is no strong key anyway, and never pops.
  const sun = new THREE.DirectionalLight(0xffd9a8, 3.0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.camera.near = 40;
  sun.shadow.camera.far = 1000;
  const S = 190;
  sun.shadow.camera.left = -S; sun.shadow.camera.right = S;
  sun.shadow.camera.top = S; sun.shadow.camera.bottom = -S;
  // terrain.js sets castShadow = false, so there is no large-scale acne to
  // fight and the bias can stay tiny — the only way the player keeps a crisp
  // contact shadow under a raking low sun.
  sun.shadow.bias = -0.00042;
  sun.shadow.normalBias = 0.06;
  scene.add(sun, sun.target);

  const hemi = new THREE.HemisphereLight(0x9fc0ff, 0x4a3a2c, 0.5);
  scene.add(hemi);
  const fill = new THREE.DirectionalLight(0x8ea9d6, 0.35);
  scene.add(fill, fill.target);
  const amb = new THREE.AmbientLight(0xffffff, 0.18);
  scene.add(amb);

  scene.fog = new THREE.FogExp2(0xd9b48c, 0.0014);

  // grass.js and water.js read sky.sunPos as the key direction, so it has to
  // be the body that is actually lighting the world — the moon after dark.
  const sunPos = keyV;
  const moonPos = moonV;

  let t = 0;

  function apply(dt = 0) {
    t += dt;

    const alt = tod.sunAltitude;
    sunV.setFromSphericalCoords(
      1,
      THREE.MathUtils.degToRad(90 - alt),
      THREE.MathUtils.degToRad(tod.sunAzimuth),
    );

    // The moon rides its own shallower, phase-shifted orbit rather than
    // sitting at the anti-solar point: it hangs low over the sea at night and
    // shows a gibbous face instead of a flat full disc.
    const mt = tod.t + 0.28;
    const mAlt = Math.sin((mt - 0.25) * Math.PI * 2) * 62;
    moonV.setFromSphericalCoords(
      1,
      THREE.MathUtils.degToRad(90 - mAlt),
      THREE.MathUtils.degToRad((mt * 360 + 116) % 360),
    );

    const R = evalRamp(alt);

    // --- which body owns the key light --------------------------------
    const solar = THREE.MathUtils.smoothstep(alt, -8.0, -3.0);   // 1 sun, 0 moon
    if (solar > 0.5) keyV.copy(sunV); else keyV.copy(moonV);
    const dip = Math.abs(solar - 0.5) * 2.0;                     // 0 at the handover

    const sunUp = THREE.MathUtils.smoothstep(alt, -2.5, 1.5);

    // --- frames for the disc, the pillar, the ray fan and the terminator ---
    if (Math.abs(sunV.y) > 0.9995) sunU.set(1, 0, 0);
    else sunU.copy(sunV).cross(UP).normalize();
    sunW.copy(sunU).cross(sunV).normalize();
    if (Math.abs(moonV.y) > 0.9995) moonU.set(1, 0, 0);
    else moonU.copy(moonV).cross(UP).normalize();
    moonW.copy(moonU).cross(moonV).normalize();
    uniforms.uMoonLight.value
      .set(sunV.dot(moonU), sunV.dot(moonW), sunV.dot(moonV)).normalize();

    const sh = Math.hypot(sunV.x, sunV.z);
    if (sh > 1e-4) uniforms.uSunXZ.value.set(sunV.x / sh, sunV.z / sh);
    const kh = Math.hypot(keyV.x, keyV.z);
    if (kh > 1e-4) uniforms.uKeyXZ.value.set(keyV.x / kh, keyV.z / kh);
    uniforms.uKeyY.value = keyV.y;

    // --- dome uniforms --------------------------------------------------
    uniforms.uZen.value.copy(R.zen);
    uniforms.uMid.value.copy(R.mid);
    uniforms.uHor.value.copy(R.hor);
    uniforms.uHorOpp.value.copy(R.horOpp);
    uniforms.uBelt.value.copy(R.belt);
    uniforms.uHaze.value.copy(R.haze);
    uniforms.uHalo.value.copy(R.halo);
    uniforms.uSunTint.value.copy(R.sunTint);
    uniforms.uCLit.value.copy(R.cLit);
    uniforms.uCShade.value.copy(R.cShade);
    uniforms.uCRim.value.copy(R.cRim);
    uniforms.uCHor.value.copy(R.cHor);
    uniforms.uRayCol.value.copy(R.rayCol);
    uniforms.uMoonGlow.value.copy(R.moonGlow);
    uniforms.uDiscHDR.value = R.discHDR;
    uniforms.uSunR.value = R.sunR;
    uniforms.uFlatten.value = R.flatten;
    uniforms.uWarmGlow.value = R.warmGlow;
    uniforms.uRayGate.value = R.rayGate;
    uniforms.uBeltAmt.value = R.beltAmt;
    uniforms.uMilky.value = R.milky;
    uniforms.uStarF.value = R.starF;
    uniforms.uMoonI.value = R.moonI;
    uniforms.uCover.value = R.cover;
    uniforms.uCoverHi.value = R.coverHi;
    uniforms.uCloudA.value = R.cloudA;
    uniforms.uCirrusA.value = R.cirrusA;
    uniforms.uSunUp.value = sunUp;
    uniforms.uTime.value = t;
    uniforms.uCloudScroll.value = t * 0.00042;

    const camPos = camera.position;
    uniforms.uCamXZ.value.set(camPos.x, camPos.z);
    uniforms.uCamY.value = camPos.y;
    dome.position.copy(camPos);
    stars.position.copy(camPos);

    if (ctx.wind) uniforms.uWindDir.value.copy(ctx.wind.dir).normalize();

    // --- light rig ------------------------------------------------------
    sun.intensity = R.sunI * (0.15 + 0.85 * dip);
    sun.color.copy(R.sunC);
    sun.visible = sun.intensity > 0.005;

    hemi.intensity = R.hemiI;
    hemi.color.copy(R.hemiSky);
    hemi.groundColor.copy(R.hemiGrd);

    amb.intensity = R.ambI;
    amb.color.copy(R.ambC);

    // Counter-light from the opposite side of the sky. This is what keeps the
    // shadowed face of the player readable and cool under a low key instead of
    // crushing to a black cut-out.
    fill.intensity = R.fillI;
    fill.color.copy(R.fillC);
    fillDir.set(-keyV.x, 0.62, -keyV.z).normalize();
    fill.position.copy(fillDir).multiplyScalar(600).add(camPos);
    fill.target.position.copy(camPos);
    fill.target.updateMatrixWorld();

    scene.fog.color.copy(R.fogC);
    scene.fog.density = R.fogD;
    renderer.toneMappingExposure = R.expo;

    starMat.uniforms.uOpacity.value = R.starF;
    starMat.uniforms.uTime.value = t;
    stars.visible = R.starF > 0.006;
  }

  apply(0);

  return {
    // Public shape kept intact: world.js reads .sky, water.js reads
    // .sunPos/.sun, grass.js reads .sunPos/.sun/.hemi.
    sky: dome, dome, sun, hemi, fill, amb, sunPos, moonPos,
    sunDir: sunV, moonDir: moonV, stars, clouds: dome, noiseTex, uniforms, apply,
    update(dt, c) {
      apply(dt);
      const p = c.player ? c.player.position : c.camera.position;
      sun.target.position.copy(p);
      sun.target.updateMatrixWorld();
      sun.position.copy(keyV).multiplyScalar(500).add(p);
    },
  };
}
