import * as THREE from 'three';

// =============================================================================
//  KAZE NO MICHI — COMBAT
// =============================================================================
//  Four stances, each with its own tempo. Light and heavy strings with real
//  cancel windows. A parry with a 140ms perfect window that produces a clash.
//  Dodge with i-frames. Resolve. Hitstop, screen shake, blade trails sampled
//  from the actual sword transform, sparks, blood, directional knockback,
//  standoff duels and a kill-cam.
//
//  Everything here is timing. An attack is WIND-UP (committed, still hittable),
//  ACTIVE (the blade is dangerous, you cannot steer), RECOVERY (open, unless
//  you cancel into the next link). Nothing is instant and nothing is mushy.
//
//  This module owns no other file. It reaches the character through
//  ctx.samurai.bones — an additive pose layer stamped AFTER samurai.update has
//  written locomotion — and through ctx.player.setPosition for facing. It
//  WRAPS (never edits) player.update / world.update / enemies.update /
//  gcam.update so it can own frame ordering, time dilation and the camera.
// =============================================================================

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const easeOut = (t, p = 2) => 1 - Math.pow(1 - clamp(t, 0, 1), p);
const dampf = (a, b, l, dt) => b + (a - b) * Math.exp(-l * dt);
const angDelta = (from, to) =>
  THREE.MathUtils.euclideanModulo(to - from + Math.PI, Math.PI * 2) - Math.PI;
const angLerp = (a, b, t) => a + angDelta(a, b) * clamp(t, 0, 1);

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// -----------------------------------------------------------------------------
//  Pose channels. A pose is a sparse object; missing channels read as zero.
//  Applied ADDITIVELY on top of whatever samurai.js just wrote, so locomotion
//  keeps running underneath a swing.
//
//  'bs' is special: it is the blade's ABSOLUTE pitch, and the wrist angle is
//  solved from it every frame. That is what keeps a horizontal cut horizontal
//  no matter where the shoulder ended up.
// -----------------------------------------------------------------------------
const CH = [
  'hy', 'hrx', 'hry', 'hrz',
  'cx', 'cy', 'cz', 'nx', 'ny',
  'srx', 'sry', 'srz', 'erx',
  'slx', 'sly', 'slz', 'elx',
  'gy', 'gz',
  'lhx', 'rhx', 'lkx', 'rkx', 'lhz', 'rhz',
  'ik', 'ikR',
];

function blendPose(out, A, B, t) {
  for (let i = 0; i < CH.length; i++) {
    const c = CH[i];
    out[c] = lerp(A[c] || 0, B[c] || 0, t);
  }
  const a = A.bs, b = B.bs;
  if (a === undefined && b === undefined) out.bs = undefined;
  else out.bs = lerp(a === undefined ? b : a, b === undefined ? a : b, t);
  return out;
}
function newPose() { const p = {}; for (const c of CH) p[c] = 0; p.bs = undefined; return p; }

const NEUTRAL = {};

// ---- stance guards ----------------------------------------------------------
// The single most readable thing in a still frame: the silhouette has to say
// which stance you are in before anything moves.
const G_STONE = {
  hy: -0.07, hry: 0.16, cy: 0.20, cx: 0.05, ny: -0.16,
  srx: -0.78, srz: -0.12, erx: -0.48, bs: 1.80, gz: 0.18,
  lhx: 0.10, rhx: -0.16, lkx: -0.32, rkx: -0.24, lhz: 0.16, rhz: -0.13, ik: 1,
};
const G_WATER = {
  hy: -0.035, hry: 0.10, cy: 0.13, ny: -0.10,
  srx: -1.02, srz: -0.05, erx: -0.62, bs: 1.60,
  lhx: 0.15, rhx: -0.11, lkx: -0.24, rkx: -0.19, lhz: 0.10, rhz: -0.08, ik: 1,
};
const G_WIND = {
  hy: -0.02, hry: 0.22, cy: 0.27, cx: -0.03, ny: -0.20,
  srx: -1.62, srz: -0.26, erx: -1.30, bs: 0.32, gz: 0.22,
  lhx: 0.22, rhx: -0.07, lkx: -0.19, rkx: -0.26, lhz: 0.08, rhz: -0.06, ik: 1,
};
const G_MOON = {
  hy: -0.13, hry: 0.29, cy: 0.34, cx: -0.10, ny: -0.24,
  srx: -2.15, srz: -0.40, erx: -1.05, bs: -0.55, gz: 0.30,
  lhx: 0.06, rhx: -0.24, lkx: -0.44, rkx: -0.38, lhz: 0.20, rhz: -0.17, ik: 1,
};

// ---- arcs: [wind-up extreme, follow-through extreme] ------------------------
const ARCS = {
  overhead: [
    { hy: 0.05, hrx: -0.06, hry: 0.20, cx: -0.26, cy: 0.30,
      srx: -2.62, srz: -0.20, erx: -0.55, bs: -0.50, gz: 0.10, ik: 1,
      lhx: 0.12, rhx: -0.17, lkx: -0.26, rkx: -0.20 },
    { hy: -0.17, cx: 0.52, cy: -0.22, hry: -0.12,
      srx: -0.34, srz: 0.08, erx: -0.12, bs: 2.62, gz: -0.10, ik: 1,
      lhx: 0.32, rhx: -0.36, lkx: -0.58, rkx: -0.50 },
  ],
  diagR: [
    { hry: 0.28, cy: 0.52, cx: -0.15, hy: 0.02,
      srx: -2.20, srz: -0.55, erx: -0.70, bs: -0.32, gz: 0.55, ik: 1,
      lhx: 0.06, rhx: -0.19, lkx: -0.24, rkx: -0.18 },
    { hry: -0.22, cy: -0.54, cx: 0.30, hy: -0.13,
      srx: -0.82, srz: 0.72, erx: -0.26, bs: 2.45, gz: -0.62, ik: 1,
      lhx: 0.28, rhx: -0.32, lkx: -0.48, rkx: -0.40 },
  ],
  diagL: [
    { hry: -0.22, cy: -0.44, cx: -0.12, hy: 0.02,
      srx: -2.00, srz: 0.60, erx: -1.25, bs: -0.22, gz: -0.48, ik: 1 },
    { hry: 0.26, cy: 0.50, cx: 0.27, hy: -0.12,
      srx: -0.92, srz: -0.62, erx: -0.28, bs: 2.40, gz: 0.58, ik: 1,
      lhx: 0.24, rhx: -0.28, lkx: -0.44, rkx: -0.36 },
  ],
  horizR: [
    { hry: 0.34, cy: 0.68, cx: 0.02,
      srx: -1.20, srz: -0.70, erx: -0.95, bs: 1.42, gz: 0.30, ik: 1,
      lhz: 0.17, rhz: -0.15, lkx: -0.30, rkx: -0.24 },
    { hry: -0.28, cy: -0.64, cx: 0.04,
      srx: -1.38, srz: 0.82, erx: -0.30, bs: 1.62, gz: -0.36, ik: 1,
      lhz: 0.10, rhz: -0.08, lkx: -0.36, rkx: -0.30 },
  ],
  horizL: [
    { hry: -0.28, cy: -0.60, srx: -1.40, srz: 0.74, erx: -0.32, bs: 1.62, gz: -0.30, ik: 1 },
    { hry: 0.32, cy: 0.64, srx: -1.22, srz: -0.76, erx: -0.92, bs: 1.42, gz: 0.34, ik: 1,
      lkx: -0.34, rkx: -0.28 },
  ],
  rising: [
    { hry: 0.22, cy: 0.32, cx: 0.24, hy: -0.13,
      srx: -0.24, srz: 0.32, erx: -0.26, bs: 2.55, gz: 0.20, ik: 1,
      lkx: -0.42, rkx: -0.36, lhx: 0.12, rhx: -0.10 },
    { hry: -0.24, cy: -0.42, cx: -0.22, hy: 0.06,
      srx: -2.35, srz: -0.30, erx: -1.00, bs: 0.05, gz: -0.28, ik: 1 },
  ],
  thrust: [
    { hry: 0.30, cy: 0.42, srx: -0.95, erx: -1.70, bs: 1.90, ik: 1,
      lhx: 0.05, rhx: -0.22, lkx: -0.30, rkx: -0.18 },
    { hry: -0.14, cy: -0.16, hy: -0.12, srx: -1.45, erx: -0.05, bs: 1.55, ik: 1,
      lhx: 0.44, rhx: -0.42, lkx: -0.64, rkx: -0.20 },
  ],
  spin: [
    { hry: 0.32, cy: 0.44, srx: -1.30, srz: -0.58, erx: -0.62, bs: 1.52, gz: 0.20, ik: 0.65 },
    { hry: -0.22, cy: -0.34, srx: -1.34, srz: 0.44, erx: -0.48, bs: 1.55, gz: -0.20, ik: 0.35 },
  ],
  iai: [
    { hy: -0.20, hry: 0.34, cy: 0.26, cx: 0.12,
      srx: -0.50, srz: -0.30, erx: -1.30, slx: -0.85, slz: 0.50, elx: -1.30,
      ik: 0, ikR: 1, lkx: -0.58, rkx: -0.48, lhz: 0.22, rhz: -0.19 },
    { hy: -0.09, hry: -0.40, cy: -0.66, cx: 0.04,
      srx: -1.42, srz: 0.88, erx: -0.22, bs: 1.62, gz: -0.34, ik: 0, ikR: 0,
      lkx: -0.30, rkx: -0.26 },
  ],
};

const P_PARRY = {
  hy: -0.06, cx: 0.14, cy: 0.24, hry: 0.13,
  srx: -1.62, srz: -0.34, erx: -1.28, bs: 0.92, gz: 0.58, ik: 1,
  lkx: -0.28, rkx: -0.22, lhz: 0.12, rhz: -0.10,
};
const P_PARRY_SNAP = {
  hy: -0.02, cx: -0.10, cy: 0.02, hry: -0.06,
  srx: -1.95, srz: -0.62, erx: -1.05, bs: 0.35, gz: 1.05, ik: 1,
  lkx: -0.20, rkx: -0.16,
};
const P_DODGE = [
  { hy: -0.26, cx: 0.32, cz: 0.24, hrz: 0.22, srx: -0.70, srz: 0.20, erx: -0.55,
    slz: 0.36, bs: 2.30, ik: 0.35, lkx: -0.78, rkx: -0.58 },
  { hy: -0.09, cx: 0.14, cz: 0.08, hrz: 0.07, srx: -0.95, erx: -0.72, bs: 1.95, ik: 0.8,
    lkx: -0.36, rkx: -0.30 },
];
const P_STAGGER = {
  hy: -0.11, hrx: -0.20, cx: -0.55, nx: -0.34,
  srx: 0.34, srz: 0.46, erx: 0.18, slz: -0.46, slx: 0.20, bs: 2.9, ik: 0,
  lkx: -0.34, rkx: -0.20,
};
const P_FLINCH = { hy: -0.04, cx: -0.24, nx: -0.16, srz: 0.20, srx: 0.10, bs: 1.9, ik: 0.75 };
const P_STANDOFF = {
  hy: -0.17, hry: 0.32, cy: 0.24, cx: 0.10, ny: -0.26,
  srx: -0.50, srz: -0.32, erx: -1.28, slx: -0.90, slz: 0.52, elx: -1.35,
  ik: 0, ikR: 1, lkx: -0.56, rkx: -0.46, lhz: 0.22, rhz: -0.19,
};
const P_DEAD = {
  hy: -0.62, hrx: 0.55, cx: 0.65, nx: 0.35, srx: 0.7, slx: 0.7, srz: 0.5, slz: -0.5,
  lkx: -1.3, rkx: -1.2, lhx: 0.6, rhx: 0.5, ik: 0, bs: 2.6,
};

// -----------------------------------------------------------------------------
//  Stances. The whole point of four stances is four TEMPOS.
// -----------------------------------------------------------------------------
const STANCES = [
  {
    id: 'stone', kanji: '石', name: 'Stone', romaji: 'ISHI',
    trail: [1.00, 0.86, 0.58], guard: G_STONE, walk: 0.66,
    light: [
      { arc: 'diagR', wind: 0.19, act: 0.10, rec: 0.30, cancel: 0.34, dmg: 15, poise: 26, lunge: 3.3 },
      { arc: 'horizL', wind: 0.16, act: 0.10, rec: 0.28, cancel: 0.30, dmg: 15, poise: 26, lunge: 2.9 },
      { arc: 'overhead', wind: 0.23, act: 0.11, rec: 0.42, cancel: 0.50, dmg: 24, poise: 46, lunge: 3.4 },
    ],
    heavy: [
      { arc: 'overhead', wind: 0.33, act: 0.12, rec: 0.50, cancel: 0.58, dmg: 32, poise: 78, lunge: 3.0, breaks: true },
      { arc: 'spin', wind: 0.24, act: 0.26, rec: 0.54, cancel: 0.70, dmg: 36, poise: 92, lunge: 1.8, spin: true, breaks: true },
    ],
  },
  {
    id: 'water', kanji: '水', name: 'Water', romaji: 'MIZU',
    trail: [0.66, 0.90, 1.00], guard: G_WATER, walk: 0.74,
    light: [
      { arc: 'diagR', wind: 0.12, act: 0.08, rec: 0.20, cancel: 0.20, dmg: 11, poise: 15, lunge: 3.2 },
      { arc: 'diagL', wind: 0.11, act: 0.08, rec: 0.19, cancel: 0.18, dmg: 11, poise: 15, lunge: 3.0 },
      { arc: 'horizR', wind: 0.11, act: 0.09, rec: 0.20, cancel: 0.19, dmg: 12, poise: 17, lunge: 3.0 },
      { arc: 'thrust', wind: 0.15, act: 0.09, rec: 0.34, cancel: 0.42, dmg: 20, poise: 34, lunge: 4.6 },
    ],
    heavy: [
      { arc: 'diagL', wind: 0.24, act: 0.11, rec: 0.40, cancel: 0.46, dmg: 26, poise: 62, lunge: 3.6, breaks: true },
      { arc: 'thrust', wind: 0.20, act: 0.10, rec: 0.44, cancel: 0.55, dmg: 30, poise: 70, lunge: 5.2, breaks: true },
    ],
  },
  {
    id: 'wind', kanji: '風', name: 'Wind', romaji: 'KAZE',
    trail: [0.76, 1.00, 0.78], guard: G_WIND, walk: 0.82,
    light: [
      { arc: 'rising', wind: 0.10, act: 0.07, rec: 0.16, cancel: 0.14, dmg: 9, poise: 12, lunge: 3.0 },
      { arc: 'diagL', wind: 0.09, act: 0.07, rec: 0.15, cancel: 0.13, dmg: 9, poise: 12, lunge: 2.8 },
      { arc: 'horizR', wind: 0.09, act: 0.07, rec: 0.15, cancel: 0.13, dmg: 9, poise: 12, lunge: 2.8 },
      { arc: 'diagR', wind: 0.10, act: 0.07, rec: 0.16, cancel: 0.14, dmg: 10, poise: 14, lunge: 3.0 },
      { arc: 'rising', wind: 0.13, act: 0.09, rec: 0.32, cancel: 0.40, dmg: 19, poise: 40, lunge: 3.6 },
    ],
    heavy: [
      { arc: 'rising', wind: 0.21, act: 0.10, rec: 0.36, cancel: 0.42, dmg: 24, poise: 58, lunge: 3.8, breaks: true },
      { arc: 'spin', wind: 0.20, act: 0.22, rec: 0.44, cancel: 0.58, dmg: 28, poise: 66, lunge: 2.2, spin: true, breaks: true },
    ],
  },
  {
    id: 'moon', kanji: '月', name: 'Moon', romaji: 'TSUKI',
    trail: [1.00, 0.74, 0.90], guard: G_MOON, walk: 0.58,
    light: [
      { arc: 'overhead', wind: 0.29, act: 0.12, rec: 0.40, cancel: 0.46, dmg: 24, poise: 52, lunge: 3.2 },
      { arc: 'horizR', wind: 0.26, act: 0.13, rec: 0.44, cancel: 0.52, dmg: 27, poise: 60, lunge: 3.0 },
    ],
    heavy: [
      { arc: 'overhead', wind: 0.42, act: 0.14, rec: 0.58, cancel: 0.68, dmg: 44, poise: 120, lunge: 3.2, breaks: true },
      { arc: 'spin', wind: 0.30, act: 0.28, rec: 0.62, cancel: 0.80, dmg: 48, poise: 140, lunge: 2.0, spin: true, breaks: true },
    ],
  },
];

const PARRY_PERFECT = 0.14;
const PARRY_BLOCK = 0.46;
const PARRY_TOTAL = 0.64;
const DODGE_TOTAL = 0.50;
const IFRAME_A = 0.055, IFRAME_B = 0.30;
const BUFFER = 0.50;

// =============================================================================
//  Instanced screen-aligned effect quads. No textures — the shapes are analytic
//  so they stay crisp at any resolution and cost one draw call each.
// =============================================================================
const FX_VERT = `
attribute vec3 iPos;
attribute vec3 iDir;
attribute vec2 iScale;
attribute vec3 iColor;
attribute vec2 iMode;
varying vec2 vUv;
varying vec3 vCol;
varying vec2 vMode;
void main() {
  vUv = uv; vCol = iColor; vMode = iMode;
  vec4 vp = modelViewMatrix * vec4(iPos, 1.0);
  vec3 dv = (modelViewMatrix * vec4(iDir, 0.0)).xyz;
  vec2 d2 = dv.xy;
  float dl = length(d2);
  d2 = dl > 1e-4 ? d2 / dl : vec2(0.0, 1.0);
  vec2 perp = vec2(-d2.y, d2.x);
  vp.xy += d2 * (position.y * iScale.y) + perp * (position.x * iScale.x);
  gl_Position = projectionMatrix * vp;
}`;
const FX_FRAG = `
precision highp float;
varying vec2 vUv;
varying vec3 vCol;
varying vec2 vMode;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float a;
  if (vMode.x < 0.5) {
    float ax = abs(p.x), ay = abs(p.y);
    a = max(0.0, 1.0 - ax * ax) * pow(max(0.0, 1.0 - ay), 1.25);
  } else if (vMode.x < 1.5) {
    float r = length(p);
    a = max(0.0, 1.0 - r * r); a *= a;
  } else {
    float r = length(p);
    float core = exp(-r * r * 6.0);
    float ang = atan(p.y, p.x);
    float spikes = pow(max(0.0, abs(cos(ang * 2.0))), 14.0);
    a = min(core + spikes * exp(-r * 2.2) * 0.85, 1.4);
  }
  a *= vMode.y;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vCol * a, a);
}`;

function createFX(scene, max, blending) {
  const quad = new THREE.PlaneGeometry(1, 1);
  const g = new THREE.InstancedBufferGeometry();
  g.setIndex(quad.index);
  g.setAttribute('position', quad.attributes.position);
  g.setAttribute('uv', quad.attributes.uv);
  g.instanceCount = max;
  const iPos = new Float32Array(max * 3);
  const iDir = new Float32Array(max * 3);
  const iScale = new Float32Array(max * 2);
  const iColor = new Float32Array(max * 3);
  const iMode = new Float32Array(max * 2);
  for (let i = 0; i < max; i++) iDir[i * 3 + 1] = 1;
  const aPos = new THREE.InstancedBufferAttribute(iPos, 3);
  const aDir = new THREE.InstancedBufferAttribute(iDir, 3);
  const aScale = new THREE.InstancedBufferAttribute(iScale, 2);
  const aColor = new THREE.InstancedBufferAttribute(iColor, 3);
  const aMode = new THREE.InstancedBufferAttribute(iMode, 2);
  g.setAttribute('iPos', aPos); g.setAttribute('iDir', aDir);
  g.setAttribute('iScale', aScale); g.setAttribute('iColor', aColor);
  g.setAttribute('iMode', aMode);
  const mat = new THREE.ShaderMaterial({
    vertexShader: FX_VERT, fragmentShader: FX_FRAG,
    transparent: true, depthWrite: false, blending,
    premultipliedAlpha: true, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 12;
  scene.add(mesh);

  const P = new Float32Array(max * 3), V = new Float32Array(max * 3);
  const life = new Float32Array(max), maxLife = new Float32Array(max);
  const grav = new Float32Array(max), drag = new Float32Array(max);
  const w = new Float32Array(max), h = new Float32Array(max), stretch = new Float32Array(max);
  const col = new Float32Array(max * 3), mode = new Uint8Array(max);
  const floorY = new Float32Array(max), grow = new Float32Array(max);
  let cursor = 0;

  return {
    mesh,
    emit(o) {
      const i = cursor; cursor = (cursor + 1) % max;
      const i3 = i * 3;
      P[i3] = o.x; P[i3 + 1] = o.y; P[i3 + 2] = o.z;
      V[i3] = o.vx; V[i3 + 1] = o.vy; V[i3 + 2] = o.vz;
      life[i] = maxLife[i] = o.life;
      grav[i] = o.grav ?? 0; drag[i] = o.drag ?? 1.2;
      w[i] = o.w; h[i] = o.h ?? o.w; stretch[i] = o.stretch ?? 0;
      col[i3] = o.r; col[i3 + 1] = o.g; col[i3 + 2] = o.b;
      mode[i] = o.mode ?? 0; floorY[i] = o.floor ?? -1e9; grow[i] = o.grow ?? 0;
      return i;
    },
    update(dt) {
      for (let i = 0; i < max; i++) {
        const i3 = i * 3;
        if (life[i] <= 0) { iScale[i * 2] = 0; iScale[i * 2 + 1] = 0; continue; }
        life[i] -= dt;
        const k = clamp(life[i] / maxLife[i], 0, 1);
        const d = Math.exp(-drag[i] * dt);
        V[i3] *= d; V[i3 + 2] *= d;
        V[i3 + 1] = V[i3 + 1] * d - grav[i] * dt;
        P[i3] += V[i3] * dt; P[i3 + 1] += V[i3 + 1] * dt; P[i3 + 2] += V[i3 + 2] * dt;
        if (P[i3 + 1] < floorY[i]) {
          P[i3 + 1] = floorY[i];
          V[i3 + 1] *= -0.28; V[i3] *= 0.5; V[i3 + 2] *= 0.5;
          if (Math.abs(V[i3 + 1]) < 0.4) V[i3 + 1] = 0;
        }
        iPos[i3] = P[i3]; iPos[i3 + 1] = P[i3 + 1]; iPos[i3 + 2] = P[i3 + 2];
        const sp = Math.hypot(V[i3], V[i3 + 1], V[i3 + 2]);
        if (sp > 1e-3) { iDir[i3] = V[i3] / sp; iDir[i3 + 1] = V[i3 + 1] / sp; iDir[i3 + 2] = V[i3 + 2] / sp; }
        const gk = 1 + (1 - k) * grow[i];
        const shrink = mode[i] === 0 ? (0.35 + 0.65 * k) : (0.65 + 0.35 * k);
        iScale[i * 2] = w[i] * gk * shrink;
        iScale[i * 2 + 1] = (h[i] + stretch[i] * sp) * gk * shrink;
        iColor[i3] = col[i3]; iColor[i3 + 1] = col[i3 + 1]; iColor[i3 + 2] = col[i3 + 2];
        iMode[i * 2] = mode[i];
        iMode[i * 2 + 1] = mode[i] === 0 ? k * k : (mode[i] === 2 ? k * k * k : k);
      }
      aPos.needsUpdate = aDir.needsUpdate = aScale.needsUpdate = true;
      aColor.needsUpdate = aMode.needsUpdate = true;
    },
  };
}

// =============================================================================
//  Sword trail — a ribbon built from the real blade transform, sampled every
//  frame. Two rows of vertices (spine edge, cutting edge) so the ribbon has the
//  blade's actual width and twist rather than being a fattened line.
//
//  The buffer SHIFTS rather than wrapping: a ring buffer puts the newest sample
//  next to the oldest in index order and draws a triangle straight across the
//  arc. Shifting 30 samples a frame is free and the seam problem disappears.
// =============================================================================
const TRAIL_VERT = `
attribute float aAge;
attribute float aEdge;
varying float vAge;
varying float vEdge;
void main() {
  vAge = aAge; vEdge = aEdge;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const TRAIL_FRAG = `
precision highp float;
uniform vec3 uHot;
uniform vec3 uCool;
uniform float uOpacity;
varying float vAge;
varying float vEdge;
void main() {
  float a = pow(clamp(1.0 - vAge, 0.0, 1.0), 1.55);
  float e = pow(vEdge, 1.4);
  vec3 c = mix(uCool, uHot, e * (0.35 + 0.65 * (1.0 - vAge)));
  a *= mix(0.18, 1.0, e) * uOpacity;
  if (a < 0.003) discard;
  gl_FragColor = vec4(c * a * 1.45, a);
}`;

function createTrail(scene, N, hot, cool) {
  const pos = new Float32Array(N * 2 * 3);
  const age = new Float32Array(N * 2);
  const edge = new Float32Array(N * 2);
  const idx = [];
  for (let i = 0; i < N - 1; i++) {
    const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
    idx.push(a, b, c, b, d, c);
  }
  for (let i = 0; i < N; i++) {
    edge[i * 2] = 0; edge[i * 2 + 1] = 1;
    age[i * 2] = age[i * 2 + 1] = 2;         // index 0 = oldest
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aAge', new THREE.BufferAttribute(age, 1));
  g.setAttribute('aEdge', new THREE.BufferAttribute(edge, 1));
  g.setIndex(idx);
  const mat = new THREE.ShaderMaterial({
    vertexShader: TRAIL_VERT, fragmentShader: TRAIL_FRAG,
    uniforms: {
      uHot: { value: new THREE.Color(hot[0], hot[1], hot[2]) },
      uCool: { value: new THREE.Color(cool[0], cool[1], cool[2]) },
      uOpacity: { value: 0 },
    },
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, premultipliedAlpha: true,
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 11;
  mesh.visible = false;
  scene.add(mesh);

  let count = 0, opacity = 0;
  return {
    mesh, mat,
    setColor(h2, c2) {
      mat.uniforms.uHot.value.setRGB(h2[0], h2[1], h2[2]);
      mat.uniforms.uCool.value.setRGB(c2[0], c2[1], c2[2]);
    },
    push(bx, by, bz, tx, ty, tz) {
      if (count === 0) {
        // Prime every slot with the first sample so no triangle ever fans back
        // to the origin; the age table keeps them invisible until they are real.
        for (let i = 0; i < N; i++) {
          const o = i * 6;
          pos[o] = bx; pos[o + 1] = by; pos[o + 2] = bz;
          pos[o + 3] = tx; pos[o + 4] = ty; pos[o + 5] = tz;
        }
      } else {
        pos.copyWithin(0, 6);
        const o = (N - 1) * 6;
        pos[o] = bx; pos[o + 1] = by; pos[o + 2] = bz;
        pos[o + 3] = tx; pos[o + 4] = ty; pos[o + 5] = tz;
      }
      count = Math.min(count + 1, N);
      // Index N-1 is the newest. Anything older than `count` samples has never
      // been written this swing and must not draw — otherwise the whole ribbon
      // collapses into one bright quad spanning the start of the arc.
      const denom = Math.max(1, count - 1);
      for (let i = 0; i < N; i++) {
        const rel = N - 1 - i;
        const a = rel < count ? rel / denom : 2;
        age[i * 2] = a; age[i * 2 + 1] = a;
      }
      g.attributes.aAge.needsUpdate = true;
      g.attributes.position.needsUpdate = true;
    },
    clear() { count = 0; opacity = 0; mesh.visible = false; },
    setOpacity(v) { opacity = v; },
    update(dt) {
      opacity = Math.max(0, opacity - dt * 2.6);
      mat.uniforms.uOpacity.value = Math.min(opacity, 1.35);
      mesh.visible = opacity > 0.01 && count > 3;
    },
  };
}

// =============================================================================
//  Weapons
// =============================================================================
function bladeGeometry(len, width, thick, sori) {
  const segs = 12;
  const verts = [], idx = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const y = t * len;
    const bend = Math.sin(t * Math.PI * 0.52) * sori;
    const taper = 1 - Math.pow(t, 3.2) * 0.86;
    const w = width * taper, d = thick * taper;
    verts.push(-w * 0.5, y, bend, 0, y, bend + d, w * 0.5, y, bend, 0, y, bend - d * 0.55);
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 4, b = (i + 1) * 4;
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      idx.push(a + k, a + k2, b + k, a + k2, b + k2, b + k);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function buildKatana() {
  const grp = new THREE.Group();
  const steel = rimMat({
    color: '#cfd6de', roughness: 0.16, metalness: 0.95,
    emissive: new THREE.Color('#20242c'), rimPower: 1.5,
  });
  const edge = rimMat({
    color: '#eef3f8', roughness: 0.07, metalness: 1.0,
    emissive: new THREE.Color('#2a3038'), rimPower: 1.2,
  });
  const cord = new THREE.MeshStandardMaterial({ color: '#171a20', roughness: 0.85 });
  const brass = rimMat({ color: '#8a7340', roughness: 0.34, metalness: 0.8 });

  const blade = new THREE.Mesh(bladeGeometry(0.72, 0.031, 0.010, 0.030), steel);
  blade.position.y = 0.10; grp.add(blade);
  const ham = new THREE.Mesh(bladeGeometry(0.70, 0.011, 0.0122, 0.030), edge);
  ham.position.set(-0.0105, 0.10, 0); grp.add(ham);

  const tsuba = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.010, 12), brass);
  tsuba.position.y = 0.085; tsuba.rotation.x = Math.PI / 2; tsuba.scale.z = 0.82; grp.add(tsuba);
  const tsuka = new THREE.Mesh(new THREE.CylinderGeometry(0.0175, 0.0205, 0.27, 8), cord);
  tsuka.position.y = -0.055; grp.add(tsuka);
  const kashira = new THREE.Mesh(new THREE.SphereGeometry(0.021, 8, 6), brass);
  kashira.position.y = -0.192; grp.add(kashira);

  const base = new THREE.Object3D(); base.position.set(0, 0.12, 0); grp.add(base);
  const tip = new THREE.Object3D(); tip.position.set(0, 0.815, 0.030); grp.add(tip);
  grp.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return { group: grp, base, tip, steel, edge };
}

function buildSabre() {
  const grp = new THREE.Group();
  const steel = rimMat({
    color: '#a8b0ba', roughness: 0.26, metalness: 0.9,
    emissive: new THREE.Color('#000000'), rimPower: 1.5,
  });
  const wood = rimMat({ color: '#3a2a1c', roughness: 0.9 });
  const blade = new THREE.Mesh(bladeGeometry(0.66, 0.036, 0.008, 0.085), steel);
  blade.position.y = 0.09; grp.add(blade);
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.014, 0.028), wood);
  guard.position.y = 0.082; grp.add(guard);
  const hilt = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.019, 0.20, 7), wood);
  hilt.position.y = -0.02; grp.add(hilt);
  const base = new THREE.Object3D(); base.position.set(0, 0.10, 0); grp.add(base);
  const tip = new THREE.Object3D(); tip.position.set(0, 0.745, 0.085); grp.add(tip);
  grp.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return { group: grp, base, tip, steel };
}

// =============================================================================
//  Fallback opponent. The AI lane owns src/actors/enemy.js and it is still a
//  stub; without a body to cut there is nothing to tune, so combat ships its
//  own sparring band. The moment ctx.enemies.list is populated these hide and
//  combat drives the real enemies instead.
// =============================================================================
function buildRaider(rng) {
  const M = {
    coat: rimMat({ color: '#3d4553', roughness: 0.86 }),
    leather: rimMat({ color: '#5c4429', roughness: 0.78 }),
    fur: rimMat({ color: '#8a765c', roughness: 0.96, rimPower: 1.6 }),
    steel: rimMat({ color: '#9aa2ab', roughness: 0.34, metalness: 0.8 }),
    skin: rimMat({ color: '#c09372', roughness: 0.8 }),
    sash: rimMat({ color: '#7a3226', roughness: 0.86 }),
  };
  const limb = (len, rt, rb, m, seg = 7) => {
    const g = new THREE.CylinderGeometry(rt, rb, len, seg, 1);
    g.translate(0, -len / 2, 0);
    return new THREE.Mesh(g, m);
  };
  const root = new THREE.Group();
  const hips = new THREE.Group(); hips.position.y = 0.90; root.add(hips);
  const chest = new THREE.Group(); chest.position.y = 0.30; hips.add(chest);
  const neck = new THREE.Group(); neck.position.y = 0.26; chest.add(neck);
  const head = new THREE.Group(); head.position.y = 0.08; neck.add(head);
  const shoulder = { l: new THREE.Group(), r: new THREE.Group() };
  shoulder.l.position.set(0.20, 0.19, 0); chest.add(shoulder.l);
  shoulder.r.position.set(-0.20, 0.19, 0); chest.add(shoulder.r);
  const elbow = { l: new THREE.Group(), r: new THREE.Group() };
  elbow.l.position.y = -0.29; shoulder.l.add(elbow.l);
  elbow.r.position.y = -0.29; shoulder.r.add(elbow.r);
  const hip = { l: new THREE.Group(), r: new THREE.Group() };
  hip.l.position.set(0.10, 0, 0); hips.add(hip.l);
  hip.r.position.set(-0.10, 0, 0); hips.add(hip.r);
  const knee = { l: new THREE.Group(), r: new THREE.Group() };
  knee.l.position.y = -0.44; hip.l.add(knee.l);
  knee.r.position.y = -0.44; hip.r.add(knee.r);

  const torso = limb(0.44, 0.165, 0.145, M.coat, 9); torso.position.y = 0.44; chest.add(torso);
  const lam = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.30, 0.24), M.leather);
  lam.position.y = 0.27; chest.add(lam);
  for (let i = 0; i < 3; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.348, 0.022, 0.248), M.steel);
    b.position.y = 0.38 - i * 0.09; chest.add(b);
  }
  const belt = new THREE.Mesh(new THREE.TorusGeometry(0.165, 0.020, 5, 12), M.sash);
  belt.rotation.x = Math.PI / 2; belt.position.y = 0.02; belt.scale.z = 0.78; hips.add(belt);
  // Fur mantle across the shoulders — the shape that says steppe raider at 20m.
  const mantle = new THREE.Mesh(new THREE.ConeGeometry(0.30, 0.20, 12, 1, true), M.fur);
  mantle.position.y = 0.40; mantle.rotation.x = Math.PI; chest.add(mantle);
  // Split coat: narrower and shorter than a dress so the legs still read.
  const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.185, 0.265, 0.50, 12, 1, true), M.coat);
  skirt.position.y = -0.26; hips.add(skirt);
  for (const sgn of [1, -1]) {                 // hanging coat tails, front split
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.34, 0.02), M.coat);
    tail.position.set(sgn * 0.115, -0.66, 0.16); tail.rotation.y = sgn * 0.22;
    hips.add(tail);
  }

  for (const s of ['l', 'r']) {
    shoulder[s].add(limb(0.29, 0.058, 0.048, M.coat));
    elbow[s].add(limb(0.28, 0.046, 0.038, M.leather));
    const hd = new THREE.Mesh(new THREE.SphereGeometry(0.044, 7, 5), M.skin);
    hd.position.y = -0.28; elbow[s].add(hd);
    const pad = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 6), M.leather);
    pad.scale.set(1, 0.72, 1); pad.position.y = -0.02; shoulder[s].add(pad);
    hip[s].add(limb(0.44, 0.10, 0.075, M.coat));
    knee[s].add(limb(0.44, 0.068, 0.048, M.leather));
    const boot = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.07, 0.23), M.leather);
    boot.position.set(0, -0.46, 0.04); knee[s].add(boot);
  }

  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.10, 10, 8), M.skin);
  skull.scale.set(1, 1.1, 1.05); head.add(skull);
  const beard = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 6), M.fur);
  beard.scale.set(1, 0.9, 0.75); beard.position.set(0, -0.06, 0.03); head.add(beard);
  const helm = new THREE.Mesh(new THREE.ConeGeometry(0.115, 0.19, 10), M.steel);
  helm.position.y = 0.10; head.add(helm);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.108, 0.030, 6, 14), M.fur);
  rim.rotation.x = Math.PI / 2; rim.position.y = 0.035; head.add(rim);
  const spike = new THREE.Mesh(new THREE.ConeGeometry(0.012, 0.10, 6), M.steel);
  spike.position.y = 0.245; head.add(spike);

  const sabre = buildSabre();
  const grip = new THREE.Group(); grip.position.y = -0.28; elbow.r.add(grip);
  grip.add(sabre.group);

  root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  root.scale.setScalar(0.97 + rng() * 0.09);
  return { root, bones: { hips, chest, neck, head, shoulder, elbow, hip, knee }, sabre, grip, mats: M };
}

// =============================================================================
//  Two-bone IK. Puts the left hand on the hilt (and the right hand on the
//  sheathed hilt during a standoff). Without it the katana reads as a stick
//  held in one fist — the commonest tell of a fake samurai.
// =============================================================================
// -----------------------------------------------------------------------------
//  Rim light. Same trick samurai.js uses: a backlit figure at golden hour is a
//  flat black cutout otherwise. Without this the raiders read as traffic cones.
//  The uniforms MUST be declared in the GLSL, not merely added to sh.uniforms,
//  or the shader silently fails to compile and the mesh vanishes.
// -----------------------------------------------------------------------------
const rimShaders = [];
function rimMat(spec) {
  const m = new THREE.MeshStandardMaterial(spec);
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uRimColor = { value: new THREE.Color('#ffb877') };
    sh.uniforms.uRimDirView = { value: new THREE.Vector3(0, 0, 1) };
    sh.uniforms.uRimPower = { value: spec.rimPower ?? 2.4 };
    sh.uniforms.uRimStrength = { value: 1.0 };
    sh.fragmentShader = 'uniform vec3 uRimColor;\nuniform vec3 uRimDirView;\n'
      + 'uniform float uRimPower;\nuniform float uRimStrength;\n' + sh.fragmentShader;
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <opaque_fragment>',
      `{
         vec3 rimV = normalize(vViewPosition);
         float rim = pow(1.0 - clamp(dot(normalize(normal), rimV), 0.0, 1.0), uRimPower);
         float back = clamp(dot(-uRimDirView, rimV), 0.0, 1.0);
         outgoingLight += uRimColor * rim * (0.20 + 0.80 * back) * uRimStrength;
       }
       #include <opaque_fragment>`
    );
    rimShaders.push(sh);
  };
  return m;
}
const _rimDir = new THREE.Vector3();
function updateRim(ctx, mul) {
  if (!ctx.sky || !ctx.camera || rimShaders.length === 0) return;
  _rimDir.copy(ctx.sky.sunPos).transformDirection(ctx.camera.matrixWorldInverse);
  const warm = ctx.sky.sun ? ctx.sky.sun.color : null;
  const str = ctx.sky.sun ? clamp(ctx.sky.sun.intensity * 0.30, 0.15, 1.4) : 0.6;
  for (const sh of rimShaders) {
    sh.uniforms.uRimDirView.value.copy(_rimDir);
    if (warm) sh.uniforms.uRimColor.value.copy(warm).multiplyScalar(1.15);
    sh.uniforms.uRimStrength.value = str * mul;
  }
}

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3(), _v5 = new THREE.Vector3(), _v6 = new THREE.Vector3();
const _m4 = new THREE.Matrix4(), _qa = new THREE.Quaternion();

function ik2(shoulderG, elbowG, a, b, targetParent, pole, weight) {
  const v = _v1.copy(targetParent).sub(shoulderG.position);
  let d = v.length();
  if (d < 1e-4) return false;
  const dHat = _v2.copy(v).divideScalar(d);
  d = clamp(d, Math.abs(a - b) + 0.03, a + b - 0.012);
  const cosE = clamp((a * a + b * b - d * d) / (2 * a * b), -1, 1);
  const bend = Math.PI - Math.acos(cosE);
  const cosS = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
  const off = Math.acos(cosS);
  const axis = _v3.crossVectors(dHat, pole);
  if (axis.lengthSq() < 1e-7) return false;
  axis.normalize();
  const u = _v4.copy(dHat).applyAxisAngle(axis, off);
  const cb = Math.cos(bend), sb = Math.sin(bend);
  const cross = _v5.crossVectors(axis, u);
  const bx = shoulderG.position.x + u.x * (a + b * cb);
  const by = shoulderG.position.y + u.y * (a + b * cb);
  const bz = shoulderG.position.z + u.z * (a + b * cb);
  let best = 1, bestErr = Infinity;
  for (let s = -1; s <= 1; s += 2) {
    const hx = bx - s * cross.x * b * sb;
    const hy = by - s * cross.y * b * sb;
    const hz = bz - s * cross.z * b * sb;
    const e = (hx - targetParent.x) ** 2 + (hy - targetParent.y) ** 2 + (hz - targetParent.z) ** 2;
    if (e < bestErr) { bestErr = e; best = s; }
  }
  const X = _v6.copy(axis).multiplyScalar(best);
  const Y = _v2.copy(u).multiplyScalar(-1);
  const Z = _v1.crossVectors(X, Y).normalize();
  X.crossVectors(Y, Z).normalize();
  _m4.makeBasis(X, Y, Z);
  _qa.setFromRotationMatrix(_m4);
  shoulderG.quaternion.slerp(_qa, weight);
  elbowG.rotation.set(lerp(elbowG.rotation.x, -bend, weight), 0, 0);
  return true;
}

// =============================================================================
//  HUD — four kanji, resolve pips, a health line. GoT-level restraint.
// =============================================================================
function createCombatHUD() {
  const stub = { ensure() {}, setVisible() {}, setStance() {}, setHealth() {}, setResolve() {},
    flash() {}, standoff() {}, update() {} };
  if (typeof document === 'undefined') return stub;
  const host = document.getElementById('ui');
  if (!host) return stub;
  const el = document.createElement('div');
  el.id = 'combat-ui';
  el.style.cssText = 'position:absolute;inset:0;pointer-events:none;opacity:0;transition:opacity .45s ease';
  el.innerHTML = `
  <div id="cb-stances" style="position:absolute;left:3.2vw;bottom:6.4vh;display:flex;gap:15px;align-items:flex-end"></div>
  <div id="cb-meters" style="position:absolute;left:3.2vw;bottom:3.0vh;width:238px">
    <div style="height:3px;background:rgba(255,255,255,.13)">
      <div id="cb-hp" style="height:100%;width:100%;background:linear-gradient(90deg,#f6e7cf,#e6c99a);
        box-shadow:0 0 10px rgba(255,214,160,.5);transition:width .18s linear"></div>
    </div>
    <div id="cb-res" style="display:flex;gap:5px;margin-top:7px"></div>
  </div>
  <div id="cb-flash" style="position:absolute;left:0;right:0;top:31%;text-align:center;
    color:#fff3e0;font-size:62px;letter-spacing:.2em;opacity:0;
    text-shadow:0 0 30px rgba(255,190,120,.85),0 2px 12px rgba(0,0,0,.6)"></div>
  <div id="cb-so" style="position:absolute;left:0;right:0;top:13%;text-align:center;color:#f0e0c8;
    font-size:13px;letter-spacing:.5em;opacity:0;transition:opacity .3s;
    text-shadow:0 2px 14px rgba(0,0,0,.8)"></div>`;
  host.appendChild(el);

  const sw = el.querySelector('#cb-stances');
  const nodes = STANCES.map(s => {
    const d = document.createElement('div');
    d.style.cssText = 'text-align:center;color:#efe2cc;transition:all .22s ease';
    d.innerHTML = `<div class="k" style="font-size:25px;line-height:1">${s.kanji}</div>
      <div class="r" style="font-size:8px;letter-spacing:.24em;margin-top:3px">${s.romaji}</div>
      <div class="u" style="height:2px;margin-top:4px;background:#e8c795;transform:scaleX(0);transition:transform .22s ease"></div>`;
    sw.appendChild(d);
    return d;
  });
  const resEl = el.querySelector('#cb-res');
  const pips = [];
  for (let i = 0; i < 5; i++) {
    const p = document.createElement('div');
    p.style.cssText = 'width:15px;height:8px;transform:skewX(-24deg);background:rgba(255,255,255,.12);'
      + 'transition:background .2s,box-shadow .2s';
    resEl.appendChild(p); pips.push(p);
  }
  const hpEl = el.querySelector('#cb-hp');
  const flashEl = el.querySelector('#cb-flash');
  const soEl = el.querySelector('#cb-so');
  let flashT = 0;

  return {
    root: el,
    ensure() { if (!el.isConnected) { const h = document.getElementById('ui'); if (h) h.appendChild(el); } },
    setVisible(v) { el.style.opacity = v ? '1' : '0'; },
    setStance(i) {
      nodes.forEach((n, j) => {
        const on = j === i;
        n.style.opacity = on ? '1' : '.32';
        n.querySelector('.k').style.fontSize = on ? '31px' : '23px';
        n.querySelector('.k').style.textShadow = on ? '0 0 20px rgba(255,205,140,.85)' : 'none';
        n.querySelector('.u').style.transform = on ? 'scaleX(1)' : 'scaleX(0)';
      });
    },
    setHealth(f) { hpEl.style.width = (clamp(f, 0, 1) * 100).toFixed(1) + '%'; },
    setResolve(r) {
      for (let i = 0; i < pips.length; i++) {
        const on = r >= i + 1, part = !on && r > i;
        pips[i].style.background = on ? '#f0d9a8' : part ? 'rgba(240,217,168,.42)' : 'rgba(255,255,255,.12)';
        pips[i].style.boxShadow = on ? '0 0 9px rgba(240,200,140,.8)' : 'none';
      }
    },
    flash(text, color) {
      flashEl.textContent = text;
      flashEl.style.color = color || '#fff3e0';
      flashEl.style.opacity = '1';
      flashT = 0.62;
    },
    standoff(text) { soEl.textContent = text || ''; soEl.style.opacity = text ? '1' : '0'; },
    update(dt) {
      if (flashT > 0) {
        flashT -= dt;
        const k = clamp(flashT / 0.62, 0, 1);
        flashEl.style.opacity = String(easeOut(k, 2));
        flashEl.style.transform = `scale(${(1.24 - 0.24 * k).toFixed(3)})`;
        if (flashT <= 0) flashEl.style.opacity = '0';
      }
    },
  };
}

// =============================================================================
//  createCombat
// =============================================================================
export function createCombat(ctx) {
  const { scene, camera } = ctx;
  const player = ctx.player;
  const sam = ctx.samurai;
  const world = ctx.world;
  const B = sam ? sam.bones : null;

  const group = new THREE.Group();
  group.name = 'combat';
  scene.add(group);

  const state = {
    inCombat: false, stance: 'stone', stanceIndex: 0, resolve: 0,
    health: 120, maxHealth: 120, drawn: false,
    phase: 'idle', comboIndex: -1, target: null, hostiles: 0,
    standoff: null, killcam: false, timeScale: 1, kills: 0,
    perfectParries: 0, hitsLanded: 0,
  };

  // ---- player weapon --------------------------------------------------------
  const katana = buildKatana();
  const grip = new THREE.Group();
  if (B) { grip.position.set(0, -0.29, 0); B.elbow.r.add(grip); }
  grip.add(katana.group);
  katana.group.visible = false;

  const trail = createTrail(scene, 30, [1.55, 1.32, 0.98], [0.30, 0.40, 0.66]);
  const fxAdd = createFX(scene, 460, THREE.AdditiveBlending);
  const fxAlpha = createFX(scene, 280, THREE.NormalBlending);

  function makeTell() {
    const g = new THREE.PlaneGeometry(0.36, 0.36);
    const m = new THREE.ShaderMaterial({
      uniforms: { uCol: { value: new THREE.Color(1, 1, 1) }, uA: { value: 0 } },
      vertexShader: `varying vec2 vUv; uniform float uA;
        void main(){ vUv=uv; vec4 vp=modelViewMatrix*vec4(0.,0.,0.,1.);
        vp.xy += position.xy * (0.7+0.55*uA); gl_Position=projectionMatrix*vp; }`,
      fragmentShader: `precision highp float; varying vec2 vUv; uniform vec3 uCol; uniform float uA;
        void main(){ vec2 p=vUv*2.-1.; float d=abs(p.x)+abs(p.y);
        float a=smoothstep(1.0,0.74,d)*(1.0-smoothstep(0.64,0.32,d));
        a += exp(-d*d*7.0)*0.45; a*=uA; if(a<0.01) discard;
        gl_FragColor=vec4(uCol*a*2.2,a); }`,
      transparent: true, depthWrite: false, depthTest: false,
      blending: THREE.AdditiveBlending, premultipliedAlpha: true,
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false; mesh.renderOrder = 20; mesh.visible = false;
    group.add(mesh);
    return mesh;
  }

  // ---- sparring band --------------------------------------------------------
  const bandGroup = new THREE.Group(); bandGroup.name = 'combat-sparring'; group.add(bandGroup);
  const band = [];
  for (let i = 0; i < 3; i++) {
    const rng = mulberry(1337 + i * 977);
    const r = buildRaider(rng);
    bandGroup.add(r.root);
    band.push({
      kind: 'raider', rng, root: r.root, bones: r.bones, sabre: r.sabre, grip: r.grip,
      pos: r.root.position, yaw: 0, health: 100, maxHealth: 100, poise: 100, maxPoise: 100,
      st: 'idle', t: 0, dur: 0, dead: false, deadT: 0,
      flinch: 0, flinchDir: new THREE.Vector3(), stagger: 0, kb: new THREE.Vector3(),
      speed: 0, phase: rng() * 6.28, cool: 0.8 + rng() * 1.4, aggro: false,
      tell: makeTell(), trail: createTrail(scene, 18, [1.05, 0.92, 0.78], [0.22, 0.27, 0.42]),
      hitDone: false, foreign: false, tellKind: 0,
    });
  }
  const foreign = [];
  let useForeign = false;
  const enemies = () => (useForeign ? foreign : band);

  // ---- camera authority -----------------------------------------------------
  const gcam = ctx.gcam;
  let trauma = 0, shakeT = 0;
  let camMode = 'follow';
  let camT = 0, camDur = 0, camRoll = 0;
  const camFrom = new THREE.Vector3(), camTo = new THREE.Vector3();
  const camLook = new THREE.Vector3(), camLook2 = new THREE.Vector3();
  const _cv = new THREE.Vector3();
  function addTrauma(v) { trauma = clamp(trauma + v, 0, 1); }

  if (gcam && typeof gcam.update === 'function' && !gcam.__combatWrapped) {
    if (typeof gcam.shake !== 'function') gcam.shake = (amount) => addTrauma(amount);
    const inner = gcam.update.bind(gcam);
    gcam.update = (dt, c) => {
      if (camMode === 'follow') inner(dt, c);
      else {
        camT += dt;
        const k = clamp(camT / camDur, 0, 1);
        const e = smooth(k);
        camera.position.lerpVectors(camFrom, camTo, e);
        _cv.lerpVectors(camLook, camLook2, e);
        camera.up.set(Math.sin(camRoll) * 0.15, 1, 0).normalize();
        camera.lookAt(_cv);
        camera.up.set(0, 1, 0);
        if (k >= 1) camMode = 'follow';
      }
      if (trauma > 0.001) {
        shakeT += dt * 34;
        const s = trauma * trauma;
        const n1 = Math.sin(shakeT) + Math.sin(shakeT * 2.31) * 0.6;
        const n2 = Math.sin(shakeT * 1.37 + 2.1) + Math.sin(shakeT * 3.11) * 0.5;
        const n3 = Math.sin(shakeT * 0.83 + 4.3);
        camera.position.x += n1 * 0.115 * s * 1.5;
        camera.position.y += n2 * 0.098 * s * 1.5;
        camera.position.z += n3 * 0.075 * s * 1.5;
        camera.rotateZ(n3 * s * 0.028);
      }
    };
    gcam.__combatWrapped = true;
  }

  function cineCam(dur) { camMode = 'killcam'; camT = 0; camDur = dur; }

  // The follow rig frames landscape, not a duel. During combat pull it in, drop
  // it, and feed look deltas so it drifts to keep the target on the far side of
  // the player — GoT's soft lock, done entirely through gcam's public surface.
  const camBase = gcam ? { d: gcam.distance, h: gcam.height } : null;
  function frameFight(dt, c, target, engaged) {
    if (!gcam || !camBase) return;
    const wantD = engaged ? (phase === 'active' || phase === 'exec' ? 3.25 : 3.65) : camBase.d;
    const wantH = engaged ? 1.52 : camBase.h;
    gcam.distance = dampf(gcam.distance, wantD, 3.2, dt);
    gcam.height = dampf(gcam.height, wantH, 3.2, dt);
    if (!engaged || !target || camMode !== 'follow') return;
    const inp = c.input;
    if (Math.abs(inp.look.x) > 0.5 || Math.abs(inp.look.y) > 0.5) return;  // player is aiming
    const p = playerPos();
    const want = Math.atan2(target.pos.x - p.x, target.pos.z - p.z);
    const dYaw = angDelta(gcam.yaw, want);
    // gcam does: yaw -= look.x * 0.0022
    inp.look.x += clamp(-dYaw * (1 - Math.exp(-2.6 * dt)) / 0.0022, -900, 900);
    const dPitch = 0.16 - gcam.pitch;
    inp.look.y += clamp(dPitch * (1 - Math.exp(-2.0 * dt)) / 0.0018, -600, 600);
  }

  // ---- cinematic grade ------------------------------------------------------
  const post = ctx.post;
  const baseGrade = post && post.params ? {
    vig: post.params.vignette.amount, con: post.params.grade.contrast,
    sat: post.params.grade.saturation, bloom: post.params.bloom.strength,
    comp: post.params.exposure.comp,
  } : null;
  let cine = 0;
  function applyGrade() {
    if (!baseGrade) return;
    const k = cine;
    post.params.vignette.amount = baseGrade.vig * (1 + k * 0.85);
    post.params.grade.contrast = baseGrade.con * (1 + k * 0.22);
    post.params.grade.saturation = baseGrade.sat * (1 - k * 0.24);
    post.params.bloom.strength = baseGrade.bloom * (1 + k * 0.5);
    post.params.exposure.comp = baseGrade.comp * (1 - k * 0.05);
  }

  // ---- time dilation --------------------------------------------------------
  let hitstop = 0, hitstopScale = 0.035;
  let slowmo = 0, slowmoTarget = 1;
  function doHitstop(sec, scale = 0.035) { hitstop = Math.max(hitstop, sec); hitstopScale = scale; }
  function timeScale() { return hitstop > 0 ? hitstopScale : slowmoTarget; }

  function wrapScaled(obj) {
    if (!obj || typeof obj.update !== 'function' || obj.__combatWrapped) return;
    const inner = obj.update.bind(obj);
    obj.update = (dt, c) => inner(dt * state.timeScale, c);
    obj.__combatWrapped = true;
  }
  wrapScaled(ctx.world);
  wrapScaled(ctx.enemies);

  // ---- player state ---------------------------------------------------------
  let phase = 'idle';
  let pt = 0, execReal = 0, deathReal = 0;
  let step = null, stepIndex = -1, chainKind = 'light';
  let bufferKind = null, bufferT = 0;
  let pendingParry = false, pendingDodge = false, standoffPress = false;
  let attackYaw = 0, spinFrom = 0;
  let lockTarget = null;
  const hitSet = new Set();
  let parryResult = 0;
  const dodgeDir = new THREE.Vector3(0, 0, 1);
  const staggerDir = new THREE.Vector3();
  let sheatheT = 0, drawT = 0, outOfCombat = 0, regenT = 0;
  let execTarget = null;

  const pose = newPose();
  const poseTmp = newPose();
  const poseFromBuf = newPose();
  let poseFrom = NEUTRAL, poseTo = NEUTRAL;

  const prevBase = new THREE.Vector3(), prevTip = new THREE.Vector3();
  const curBase = new THREE.Vector3(), curTip = new THREE.Vector3();
  let bladeSampled = false;

  const hud = createCombatHUD();
  hud.setStance(0); hud.setResolve(0); hud.setHealth(1);

  const stanceOf = () => STANCES[state.stanceIndex];
  const playerPos = () => player.root.position;
  const groundY = (x, z) => (world ? world.heightAt(x, z) : 0);
  function capture() { blendPose(poseFromBuf, pose, pose, 0); return poseFromBuf; }
  function setYaw(y) {
    const p = playerPos();
    player.setPosition(p.x, p.y, p.z, THREE.MathUtils.radToDeg(y));
  }

  function nearestHostile(maxDist) {
    const p = playerPos();
    let best = null, bd = maxDist * maxDist;
    for (const e of enemies()) {
      if (e.dead) continue;
      const dx = e.pos.x - p.x, dz = e.pos.z - p.z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  // ---- effects --------------------------------------------------------------
  function sparks(x, y, z, nx, ny, nz, n, hotness, spread) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, b = (Math.random() - 0.5) * spread;
      const sp = 3.2 + Math.random() * 9.5 * hotness;
      const ux = nx + Math.cos(a) * b, uy = ny + Math.sin(a) * b + 0.25, uz = nz + Math.sin(a * 1.7) * b;
      const l = Math.hypot(ux, uy, uz) || 1;
      const t = Math.random();
      fxAdd.emit({
        x, y, z, vx: ux / l * sp, vy: uy / l * sp, vz: uz / l * sp,
        life: 0.20 + Math.random() * 0.34, grav: 11, drag: 1.4,
        w: 0.013 + Math.random() * 0.012, h: 0.02, stretch: 0.030,
        r: 1.9, g: 1.1 + t * 0.5, b: 0.35 + t * 0.55, mode: 0, floor: y - 2.2,
      });
    }
  }
  function bloodBurst(x, y, z, dx, dy, dz, n, fy) {
    for (let i = 0; i < n; i++) {
      const sp = 1.6 + Math.random() * 5.0;
      const ux = dx + (Math.random() - 0.5) * 0.85;
      const uy = dy + Math.random() * 0.75 + 0.2;
      const uz = dz + (Math.random() - 0.5) * 0.85;
      const l = Math.hypot(ux, uy, uz) || 1;
      fxAlpha.emit({
        x, y, z, vx: ux / l * sp, vy: uy / l * sp, vz: uz / l * sp,
        life: 0.42 + Math.random() * 0.5, grav: 9.5, drag: 0.9,
        w: 0.016 + Math.random() * 0.020, h: 0.02, stretch: 0.020,
        r: 0.30, g: 0.032, b: 0.034, mode: 0, floor: fy,
      });
    }
  }
  function dust(x, y, z, n, power) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 0.5 + Math.random() * 2.4 * power;
      fxAlpha.emit({
        x: x + (Math.random() - 0.5) * 0.4, y: y + Math.random() * 0.12, z: z + (Math.random() - 0.5) * 0.4,
        vx: Math.cos(a) * sp, vy: 0.35 + Math.random() * 1.1, vz: Math.sin(a) * sp,
        life: 0.5 + Math.random() * 0.7, grav: 1.3, drag: 2.0,
        w: 0.20 + Math.random() * 0.30, h: 0.20, stretch: 0, grow: 1.4,
        r: 0.50, g: 0.43, b: 0.33, mode: 1, floor: y,
      });
    }
  }
  function flash(x, y, z, size, r, g, b, life) {
    fxAdd.emit({ x, y, z, vx: 0, vy: 0, vz: 0, life, grav: 0, drag: 6,
      w: size, h: size, stretch: 0, r, g, b, mode: 2, grow: 1.4 });
  }
  function shockRing(x, y, z, size) {
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      fxAdd.emit({
        x, y, z, vx: Math.cos(a) * size * 5.5, vy: (Math.random() - 0.3) * 1.2, vz: Math.sin(a) * size * 5.5,
        life: 0.17 + Math.random() * 0.08, grav: 0, drag: 5.5,
        w: 0.020, h: 0.05, stretch: 0.024, r: 1.9, g: 1.5, b: 0.9, mode: 0,
      });
    }
  }

  // ---- attack token ---------------------------------------------------------
  let token = null, tokenT = 0;
  function requestToken(e) {
    if (token && token !== e && !token.dead) return false;
    token = e; tokenT = 0; return true;
  }
  function releaseToken(e) { if (token === e) { token = null; tokenT = 0; } }

  // ---- damage ---------------------------------------------------------------
  function damageEnemy(e, dmg, poiseDmg, dirx, dirz, opts = {}) {
    if (e.dead) return;
    state.hitsLanded++;
    e.health -= dmg;
    e.poise -= poiseDmg;
    e.flinch = 0.30;
    e.flinchDir.set(dirx, 0, dirz);
    e.kb.set(dirx * (opts.kb ?? (0.9 + poiseDmg * 0.012)), 0, dirz * (opts.kb ?? (0.9 + poiseDmg * 0.012)));
    e.aggro = true;
    if (e.foreign) e.pendingHit = { dmg, dir: { x: dirx, y: 0, z: dirz } };
    if (e.st === 'telegraph' || e.st === 'swing') { e.st = 'flinch'; e.t = 0; e.dur = 0.34; releaseToken(e); }
    if (e.poise <= 0 && e.health > 0) {
      e.poise = e.maxPoise; e.stagger = 1.45; e.st = 'stagger'; e.t = 0; e.dur = 1.45;
      releaseToken(e);
      hud.flash('崩', '#ffd9a0');
    }
    state.resolve = clamp(state.resolve + (opts.resolve ?? 0.22), 0, 5);
    if (e.health <= 0) killEnemy(e, dirx, dirz, opts.execute);
  }

  function killEnemy(e, dirx, dirz, execute) {
    if (e.dead) return;
    e.dead = true; e.deadT = 0; e.st = 'dead'; e.health = 0;
    if (e.tell) e.tell.visible = false;
    releaseToken(e);
    state.kills++;
    state.resolve = clamp(state.resolve + 1, 0, 5);
    const q = e.pos, pp = playerPos();
    bloodBurst(q.x, q.y + 1.15, q.z, dirx, 0.5, dirz, 34, groundY(q.x, q.z));
    flash(q.x, q.y + 1.2, q.z, 0.75, 1.5, 0.6, 0.45, 0.24);

    const ax = q.x - pp.x, az = q.z - pp.z, l = Math.hypot(ax, az) || 1;
    const px = -az / l, pz = ax / l;
    const side = (camera.position.x - pp.x) * px + (camera.position.z - pp.z) * pz >= 0 ? 1 : -1;
    const mx = (q.x + pp.x) * 0.5, mz = (q.z + pp.z) * 0.5;
    const my = Math.max(groundY(mx, mz), groundY(q.x, q.z));
    camFrom.set(mx + px * side * 4.4 - ax / l * 1.2, my + 2.0, mz + pz * side * 4.4 - az / l * 1.2);
    camTo.set(mx + px * side * 2.5 + ax / l * 0.5, my + 1.35, mz + pz * side * 2.5 + az / l * 0.5);
    camLook.set(mx, my + 1.25, mz);
    camLook2.set(q.x, groundY(q.x, q.z) + 0.9, q.z);
    camRoll = (Math.random() - 0.5) * 0.8;
    cineCam(execute ? 1.9 : 1.4);
    slowmoTarget = execute ? 0.18 : 0.28;
    slowmo = execute ? 1.5 : 1.1;
    doHitstop(execute ? 0.20 : 0.13, 0.02);
    addTrauma(execute ? 0.85 : 0.55);
    hud.flash(execute ? '一閃' : '斬', '#ffe4c4');
  }

  let audioReleased = false;

  function damagePlayer(dmg, dirx, dirz, heavy) {
    if (phase === 'dead') return;
    state.health -= dmg;
    regenT = 0;
    const p = playerPos();
    bloodBurst(p.x, p.y + 1.2, p.z, dirx, 0.4, dirz, 16, groundY(p.x, p.z));
    addTrauma(heavy ? 0.55 : 0.32);
    doHitstop(heavy ? 0.09 : 0.055, 0.05);
    staggerDir.set(dirx, 0, dirz);
    poseFrom = capture();
    phase = heavy ? 'stagger' : 'flinch';
    pt = 0; step = null; hitSet.clear();
    trail.setOpacity(0);
    if (state.health <= 0) {
      state.health = 0; phase = 'dead'; pt = 0; deathReal = 0;
      hud.flash('死', '#e8b0a0');
    }
  }

  // ---- standoff -------------------------------------------------------------
  const so = { active: false, t: 0, phase: '', tell: 0, enemy: null, streak: 0, window: 0 };
  function standoffCam(e) {
    const p = playerPos(), q = e.pos;
    const ax = q.x - p.x, az = q.z - p.z, l = Math.hypot(ax, az) || 1;
    const px = -az / l, pz = ax / l;
    const side = (camera.position.x - p.x) * px + (camera.position.z - p.z) * pz >= 0 ? 1 : -1;
    const mx = (p.x + q.x) * 0.5, mz = (p.z + q.z) * 0.5, my = groundY(mx, mz);
    camFrom.set(mx + px * side * 6.0, my + 1.85, mz + pz * side * 6.0);
    camTo.set(mx + px * side * 4.2, my + 1.12, mz + pz * side * 4.2);
    camLook.set(mx, my + 1.32, mz);
    camLook2.set(mx, my + 1.14, mz);
    camRoll = 0;
    cineCam(6.0);
  }
  function beginStandoff(e, fixedTell) {
    if (!e || e.dead || so.active) return false;
    so.active = true; so.t = 0; so.phase = 'settle'; so.enemy = e; so.streak = 0; so.window = 0;
    so.tell = fixedTell ?? (1.15 + Math.random() * 1.0);
    e.st = 'standoff'; e.t = 0; e.aggro = true;
    poseFrom = capture();
    phase = 'standoff'; pt = 0; step = null;
    state.standoff = 'settle';
    setDrawn(false);
    slowmoTarget = 0.9;
    hud.standoff('HOLD  —  WAIT FOR THE TELL');
    const p = playerPos();
    setYaw(Math.atan2(e.pos.x - p.x, e.pos.z - p.z));
    standoffCam(e);
    return true;
  }
  function endStandoff() {
    so.active = false; so.enemy = null; state.standoff = null;
    hud.standoff('');
    slowmoTarget = 1; camMode = 'follow';
    if (phase === 'standoff') { phase = 'idle'; pt = 0; }
  }
  function standoffStrike(hit) {
    const e = so.enemy;
    hud.standoff('');
    if (!e) { endStandoff(); return; }
    if (hit) {
      setDrawn(true);
      phase = 'exec'; pt = 0; execReal = 0; execTarget = e;
      e.st = 'standoff'; e.t = 0;
      so.phase = 'strike'; so.streak++;
      trail.clear(); trail.setOpacity(1.35);
      slowmoTarget = 0.4;
    } else {
      const p = playerPos();
      const dx = p.x - e.pos.x, dz = p.z - e.pos.z, l = Math.hypot(dx, dz) || 1;
      endStandoff();
      setDrawn(true);
      damagePlayer(26, dx / l, dz / l, true);
      e.st = 'recover'; e.t = 0; e.dur = 0.8;
      hud.flash('失', '#c98a7a');
    }
  }

  // ---- draw / sheathe -------------------------------------------------------
  function setDrawn(v) {
    state.drawn = v;
    katana.group.visible = v;
    if (B && B.swordRig) {
      // Hide only the hilt furniture — the empty saya stays on the hip.
      const kids = B.swordRig.children;
      for (let i = 1; i < kids.length; i++) kids[i].visible = !v;
    }
    if (!v) trail.clear();
  }
  setDrawn(false);

  // ---- input ----------------------------------------------------------------
  function readInput(inp, dt) {
    if (inp.stanceCycle) {
      let i = state.stanceIndex;
      if (inp.stanceCycle === -1) i = (i + 1) % STANCES.length;
      else i = clamp(inp.stanceCycle - 1, 0, STANCES.length - 1);
      if (i !== state.stanceIndex) {
        state.stanceIndex = i;
        state.stance = STANCES[i].id;
        hud.setStance(i);
        const c = STANCES[i].trail;
        trail.setColor([c[0] * 1.55, c[1] * 1.42, c[2] * 1.15], [c[0] * 0.36, c[1] * 0.40, c[2] * 0.55]);
        sam.setStance?.(STANCES[i].id);
        const p = playerPos();
        flash(p.x, p.y + 1.5, p.z, 0.55, c[0] * 1.3, c[1] * 1.3, c[2] * 1.3, 0.32);
        if (state.drawn) hud.flash(STANCES[i].kanji, '#ffe9c8');
      }
    }
    if (inp.attack) { bufferKind = 'light'; bufferT = BUFFER; }
    if (inp.heavy) { bufferKind = 'heavy'; bufferT = BUFFER; }
    if (inp.parry) pendingParry = true;
    if (inp.dodge) pendingDodge = true;
    if ((inp.attack || inp.heavy) && so.active && phase === 'standoff') standoffPress = true;
    if (bufferT > 0) bufferT -= dt; else bufferKind = null;
  }

  function startAttack(kind) {
    const S = stanceOf();
    const chain = kind === 'heavy' ? S.heavy : S.light;
    let idx = 0;
    if (chainKind === kind && stepIndex >= 0 && phase === 'recover') idx = (stepIndex + 1) % chain.length;
    chainKind = kind;
    stepIndex = idx;
    step = chain[idx];
    poseFrom = capture(); poseTo = ARCS[step.arc][0];
    phase = 'windup'; pt = 0;
    hitSet.clear();
    if (!state.drawn) setDrawn(true);
    lockTarget = nearestHostile(step.lunge + 3.4);
    const p = playerPos();
    attackYaw = lockTarget
      ? Math.atan2(lockTarget.pos.x - p.x, lockTarget.pos.z - p.z)
      : player.yaw;
    spinFrom = attackYaw;
    trail.clear();
    bufferKind = null; bufferT = 0;
  }

  function startParry() {
    poseFrom = capture(); poseTo = P_PARRY;
    phase = 'parry'; pt = 0; parryResult = 0; step = null; hitSet.clear();
    if (!state.drawn) setDrawn(true);
    const t = nearestHostile(10), p = playerPos();
    attackYaw = t ? Math.atan2(t.pos.x - p.x, t.pos.z - p.z) : player.yaw;
    pendingParry = false;
  }

  function startDodge(inp) {
    poseFrom = capture(); poseTo = P_DODGE[0];
    phase = 'dodge'; pt = 0; step = null; hitSet.clear();
    const camYaw = gcam ? gcam.yaw : 0;
    const fx = Math.sin(camYaw), fz = Math.cos(camYaw);
    let dx = fx * inp.move.y + fz * inp.move.x;
    let dz = fz * inp.move.y - fx * inp.move.x;
    const p = playerPos();
    if (Math.hypot(dx, dz) < 0.1) {
      const t = nearestHostile(12);
      if (t) { dx = p.x - t.pos.x; dz = p.z - t.pos.z; }
      else { dx = -Math.sin(player.yaw); dz = -Math.cos(player.yaw); }
    }
    const l = Math.hypot(dx, dz) || 1;
    dodgeDir.set(dx / l, 0, dz / l);
    dust(p.x, groundY(p.x, p.z), p.z, 10, 1.3);
    const t2 = nearestHostile(12);
    attackYaw = t2 ? Math.atan2(t2.pos.x - p.x, t2.pos.z - p.z) : player.yaw;
    pendingDodge = false;
    trail.setOpacity(0.32);
  }

  const iFrames = () => phase === 'dodge' && pt >= IFRAME_A && pt <= IFRAME_B;

  // How much of the player's own locomotion survives the current state. Zero
  // during a committed swing — otherwise the movement code fights the facing.
  function moveGate() {
    switch (phase) {
      case 'windup': case 'active': return 0;
      case 'recover': {
        const c = step ? step.cancel * step.rec : 0.1;
        const r = step ? step.rec : 0.3;
        return clamp((pt - c) / (r * 0.5), 0, 1) * 0.6;
      }
      case 'parry': return pt < PARRY_BLOCK ? 0 : 0.4;
      case 'dodge': case 'stagger': case 'flinch': case 'dead': case 'standoff': case 'exec': return 0;
      default: return state.inCombat ? stanceOf().walk : 1;
    }
  }

  // ---- blade sweep vs enemy capsules ---------------------------------------
  function sweepHit() {
    if (!step) return;
    for (const e of enemies()) {
      if (e.dead || hitSet.has(e)) continue;
      const ex = e.pos.x, ez = e.pos.z, ey = e.pos.y;
      let hit = false, hx = 0, hy = 0, hz = 0;
      for (let i = 0; i < 5 && !hit; i++) {
        const t = i / 4;
        const pbx = lerp(prevBase.x, prevTip.x, t), pby = lerp(prevBase.y, prevTip.y, t), pbz = lerp(prevBase.z, prevTip.z, t);
        const cbx = lerp(curBase.x, curTip.x, t), cby = lerp(curBase.y, curTip.y, t), cbz = lerp(curBase.z, curTip.z, t);
        for (let s = 0; s <= 2; s++) {
          const k = s / 2;
          const px = lerp(pbx, cbx, k), py = lerp(pby, cby, k), pz = lerp(pbz, cbz, k);
          const dx = px - ex, dz = pz - ez, dy = py - ey;
          if (dx * dx + dz * dz < 0.44 * 0.44 && dy > 0.15 && dy < 1.95) {
            hit = true; hx = px; hy = py; hz = pz; break;
          }
        }
      }
      if (!hit) continue;
      hitSet.add(e);
      const p = playerPos();
      let dirx = ex - p.x, dirz = ez - p.z;
      const l = Math.hypot(dirx, dirz) || 1; dirx /= l; dirz /= l;
      const finisher = (e.stagger > 0 || e.st === 'stagger') && state.resolve >= 1 && chainKind === 'heavy';
      damageEnemy(e, finisher ? 9999 : step.dmg, step.poise, dirx, dirz, {
        resolve: chainKind === 'heavy' ? 0.45 : 0.22,
        execute: finisher,
      });
      if (finisher) state.resolve = clamp(state.resolve - 1, 0, 5);
      const gy = groundY(hx, hz);
      bloodBurst(hx, hy, hz, dirx, 0.35, dirz, 14 + (step.dmg | 0), gy);
      sparks(hx, hy, hz, dirx, 0.35, dirz, 9, 0.5, 0.9);
      flash(hx, hy, hz, 0.42 + step.dmg * 0.010, 1.7, 1.1, 0.7, 0.17);
      doHitstop(clamp(0.042 + step.dmg * 0.0022, 0.045, 0.115), 0.03);
      addTrauma(clamp(0.16 + step.dmg * 0.0075, 0.16, 0.6));
      ctx.audio?.play?.('sword_hit', { x: hx, y: hy, z: hz });
    }
  }

  // ---- enemy strike resolution ---------------------------------------------
  function enemyStrike(e) {
    const p = playerPos();
    const dx = p.x - e.pos.x, dz = p.z - e.pos.z;
    const dist = Math.hypot(dx, dz) || 1e-4;
    const facing = Math.cos(e.yaw) * (dz / dist) + Math.sin(e.yaw) * (dx / dist);
    if (dist > 2.9 || facing < 0.3) return;
    const nx = dx / dist, nz = dz / dist;
    const heavy = e.tellKind === 1;

    if (iFrames()) {
      state.resolve = clamp(state.resolve + 0.6, 0, 5);
      hud.flash('避', '#cfe4ff');
      doHitstop(0.05, 0.06);
      const wx = p.x - nx * 0.5, wz = p.z - nz * 0.5;
      dust(wx, groundY(wx, wz), wz, 9, 1.7);
      addTrauma(0.14);
      return;
    }
    if (phase === 'parry' && pt <= PARRY_BLOCK && !heavy) {
      const perfect = pt <= PARRY_PERFECT;
      parryResult = perfect ? 2 : 1;
      const cx = (p.x + e.pos.x) * 0.5, cz = (p.z + e.pos.z) * 0.5, cy = p.y + 1.30;
      if (perfect) {
        state.perfectParries++;
        state.resolve = clamp(state.resolve + 1, 0, 5);
        e.poise -= 55; e.stagger = 1.25; e.st = 'stagger'; e.t = 0; e.dur = 1.25;
        e.kb.set(-nx * 2.6, 0, -nz * 2.6);
        releaseToken(e);
        sparks(cx, cy, cz, -nx, 0.15, -nz, 48, 1.5, 1.5);
        flash(cx, cy, cz, 1.20, 2.4, 1.9, 1.15, 0.28);
        shockRing(cx, cy, cz, 1.0);
        doHitstop(0.155, 0.015);
        addTrauma(0.72);
        hud.flash('弾', '#fff0cf');
        poseFrom = capture(); poseTo = P_PARRY_SNAP; pt = 0.0001;
        ctx.audio?.play?.('clash', { x: cx, y: cy, z: cz });
      } else {
        state.health -= 3; regenT = 0;
        state.resolve = clamp(state.resolve + 0.25, 0, 5);
        e.kb.set(-nx * 0.7, 0, -nz * 0.7);
        sparks(cx, cy, cz, -nx, 0.1, -nz, 17, 0.85, 1.1);
        flash(cx, cy, cz, 0.52, 1.5, 1.25, 0.85, 0.15);
        doHitstop(0.06, 0.05);
        addTrauma(0.28);
        ctx.audio?.play?.('block', { x: cx, y: cy, z: cz });
      }
      return;
    }
    damagePlayer(heavy ? 22 : 13, nx, nz, heavy);
    ctx.audio?.play?.('flesh_hit', { x: p.x, y: p.y + 1.2, z: p.z });
  }

  // ---- opponent simulation --------------------------------------------------
  function updateRaider(e, dt, pp) {
    const dx = pp.x - e.pos.x, dz = pp.z - e.pos.z;
    const dist = Math.hypot(dx, dz);
    const nx = dist > 1e-4 ? dx / dist : 0, nz = dist > 1e-4 ? dz / dist : 1;
    e.t += dt;

    if (e.kb.lengthSq() > 1e-5) {
      e.pos.x += e.kb.x * dt * 6; e.pos.z += e.kb.z * dt * 6;
      e.kb.multiplyScalar(Math.exp(-9 * dt));
      if (e.kb.lengthSq() < 1e-5) e.kb.set(0, 0, 0);
    }

    if (e.dead) {
      e.deadT += dt;
      e.pos.y = groundY(e.pos.x, e.pos.z);
      if (e.tell) e.tell.visible = false;
      poseRaider(e, dt, dist);
      return;
    }

    e.flinch = Math.max(0, e.flinch - dt);
    e.stagger = Math.max(0, e.stagger - dt);
    if (!e.aggro && dist < 15) e.aggro = true;
    let want = 0, strafe = 0;

    switch (e.st) {
      case 'idle': if (e.aggro) { e.st = 'approach'; e.t = 0; } break;
      case 'approach':
        if (dist > 2.55) want = 1;
        else { e.st = 'circle'; e.t = 0; e.dur = 0.5 + e.rng() * 1.0; }
        break;
      case 'circle':
        strafe = e.phase > 3.14 ? 1 : -1;
        if (dist > 3.3) want = 0.7; else if (dist < 2.0) want = -0.6;
        e.cool -= dt;
        if (e.t > e.dur && e.cool <= 0 && dist < 3.05 && requestToken(e)) {
          e.st = 'telegraph'; e.t = 0;
          e.tellKind = e.rng() < 0.30 ? 1 : 0;
          e.dur = e.tellKind ? 0.72 : 0.50;
          e.hitDone = false;
        } else if (e.t > e.dur) { e.t = 0; e.dur = 0.6 + e.rng() * 1.1; e.phase = e.rng() * 6.28; }
        break;
      case 'telegraph':
        if (dist > 3.4) want = 0.8;
        if (e.t >= e.dur) { e.st = 'swing'; e.t = 0; e.dur = e.tellKind ? 0.34 : 0.28; e.hitDone = false; }
        break;
      case 'swing': {
        const k = e.t / e.dur;
        if (k > 0.22 && k < 0.55) want = 1.4;
        if (!e.hitDone && k >= 0.34) { e.hitDone = true; enemyStrike(e); }
        if (e.t >= e.dur) {
          e.st = 'recover'; e.t = 0; e.dur = e.tellKind ? 0.78 : 0.55;
          e.cool = 1.1 + e.rng() * 1.7; releaseToken(e);
        }
        break;
      }
      case 'recover':
        if (e.t >= e.dur) { e.st = 'circle'; e.t = 0; e.dur = 0.4 + e.rng() * 0.8; }
        break;
      case 'flinch':
        if (e.t >= e.dur) { e.st = 'circle'; e.t = 0; e.dur = 0.4 + e.rng() * 0.6; e.cool = 0.7; }
        break;
      case 'stagger':
        if (e.t >= e.dur) { e.st = 'circle'; e.t = 0; e.dur = 0.5; e.cool = 1.0; }
        break;
      case 'standoff': break;
      default: e.st = 'circle'; e.t = 0; break;
    }

    const spd = e.st === 'swing' ? 3.4 : e.st === 'approach' ? 2.55 : 1.5;
    const mvx = nx * want - nz * strafe * 0.9;
    const mvz = nz * want + nx * strafe * 0.9;
    const ml = Math.hypot(mvx, mvz);
    if (ml > 1e-3 && e.stagger <= 0 && e.flinch <= 0) {
      e.pos.x += (mvx / ml) * spd * Math.min(1, ml) * dt;
      e.pos.z += (mvz / ml) * spd * Math.min(1, ml) * dt;
      e.speed = dampf(e.speed, spd * Math.min(1, ml), 8, dt);
    } else e.speed = dampf(e.speed, 0, 9, dt);

    for (const o of enemies()) {
      if (o === e || o.dead) continue;
      const ox = e.pos.x - o.pos.x, oz = e.pos.z - o.pos.z;
      const d2 = ox * ox + oz * oz;
      if (d2 < 1.44 && d2 > 1e-5) {
        const d = Math.sqrt(d2), f = (1.2 - d) * 2.2 * dt;
        e.pos.x += (ox / d) * f; e.pos.z += (oz / d) * f;
      }
    }
    if (dist < 1.15 && dist > 1e-4) { e.pos.x -= nx * (1.15 - dist); e.pos.z -= nz * (1.15 - dist); }

    e.pos.y = groundY(e.pos.x, e.pos.z);
    e.yaw += clamp(angDelta(e.yaw, Math.atan2(nx, nz)), -6 * dt, 6 * dt);
    e.root.rotation.y = e.yaw;

    const showTell = e.st === 'telegraph';
    e.tell.visible = showTell;
    if (showTell) {
      e.tell.position.set(e.pos.x, e.pos.y + 2.24, e.pos.z);
      const k = clamp(e.t / e.dur, 0, 1);
      e.tell.material.uniforms.uA.value = 0.35 + 0.65 * Math.pow(k, 0.6) * (0.7 + 0.3 * Math.sin(e.t * 34));
      if (e.tellKind) e.tell.material.uniforms.uCol.value.setRGB(1.7, 0.14, 0.10);
      else e.tell.material.uniforms.uCol.value.setRGB(0.5, 0.82, 1.7);
      e.sabre.steel.emissive.setRGB(e.tellKind ? 0.6 * k : 0.08 * k, 0.05 * k, e.tellKind ? 0.04 * k : 0.4 * k);
    } else {
      e.sabre.steel.emissive.multiplyScalar(Math.exp(-6 * dt));
    }

    poseRaider(e, dt, dist);
  }

  function poseRaider(e, dt, dist) {
    const b = e.bones;
    e.phase += dt * clamp(e.speed * 1.05, 0, 5) * Math.PI;
    const amp = clamp(e.speed / 2.5, 0, 1);
    const sw = Math.sin(e.phase);
    b.hip.l.rotation.x = sw * 0.55 * amp;
    b.hip.r.rotation.x = -sw * 0.55 * amp;
    b.knee.l.rotation.x = -Math.max(0, -sw) * 1.1 * amp - 0.08;
    b.knee.r.rotation.x = -Math.max(0, sw) * 1.1 * amp - 0.08;
    b.hips.rotation.set(0, sw * 0.09 * amp, 0);
    b.hips.position.y = 0.90 - Math.abs(sw) * 0.05 * amp;
    b.chest.rotation.set(0.05 + amp * 0.12, -sw * 0.12 * amp, 0);
    b.neck.rotation.x = -b.chest.rotation.x * 0.8;
    b.shoulder.l.rotation.set(-sw * 0.35 * amp, 0, -0.15);
    b.shoulder.r.rotation.set(-0.55, 0, 0.22);
    b.elbow.l.rotation.set(-0.35, 0, 0);
    b.elbow.r.rotation.set(-1.05, 0, 0);
    e.grip.rotation.set(Math.PI * 0.5, 0, 0);
    e.root.rotation.z = 0;

    const st = e.st;
    if (e.dead) {
      const s = smooth(clamp(e.deadT / 0.85, 0, 1));
      b.hips.position.y = 0.90 - s * 0.68;
      b.hips.rotation.x = s * 0.9;
      b.chest.rotation.x = 0.05 + s * 0.75;
      b.neck.rotation.x = s * 0.4;
      b.knee.l.rotation.x = -0.08 - s * 1.5;
      b.knee.r.rotation.x = -0.08 - s * 1.3;
      b.hip.l.rotation.x = s * 0.75; b.hip.r.rotation.x = s * 0.6;
      b.shoulder.r.rotation.set(-0.55 + s * 1.3, 0, 0.22 + s * 0.5);
      b.shoulder.l.rotation.set(s * 1.2, 0, -0.15 - s * 0.5);
      e.root.rotation.z = -s * 0.28;
    } else if (st === 'stagger') {
      const k = clamp(e.t / Math.max(0.001, e.dur), 0, 1);
      const s = Math.sin(k * Math.PI) * (1 - k * 0.35);
      b.chest.rotation.x = 0.05 - s * 0.62;
      b.neck.rotation.x = -s * 0.34;
      b.hips.position.y = 0.90 - s * 0.10;
      b.hips.rotation.y += s * 0.2;
      b.shoulder.r.rotation.set(-0.55 + s * 1.5, 0, 0.22 + s * 0.6);
      b.shoulder.l.rotation.set(s * 1.4, 0, -0.15 - s * 0.6);
      b.elbow.r.rotation.x = -1.05 + s * 0.8;
      b.knee.l.rotation.x -= s * 0.35; b.knee.r.rotation.x -= s * 0.25;
    } else if (st === 'flinch' || e.flinch > 0) {
      const s = Math.sin(clamp(e.flinch / 0.30, 0, 1) * Math.PI);
      b.chest.rotation.x = 0.05 - s * 0.34;
      b.neck.rotation.x = -s * 0.22;
      b.shoulder.r.rotation.x = -0.55 + s * 0.55;
      b.hips.rotation.y += s * 0.16;
    } else if (st === 'telegraph') {
      const s = easeOut(clamp(e.t / Math.max(0.001, e.dur), 0, 1), 2);
      if (e.tellKind) {
        b.shoulder.r.rotation.set(-0.55 - s * 2.0, 0, 0.22 - s * 0.25);
        b.elbow.r.rotation.x = -1.05 + s * 0.45;
        b.chest.rotation.x = 0.05 - s * 0.28;
        b.chest.rotation.y -= s * 0.22;
        b.hips.position.y -= s * 0.06;
        e.grip.rotation.x = Math.PI * 0.5 + s * 0.8;
      } else {
        b.shoulder.r.rotation.set(-0.55 - s * 0.85, 0, 0.22 - s * 0.85);
        b.elbow.r.rotation.x = -1.05 - s * 0.35;
        b.chest.rotation.y -= s * 0.55;
        b.hips.rotation.y -= s * 0.24;
        e.grip.rotation.x = Math.PI * 0.5 + s * 0.35;
      }
      b.knee.l.rotation.x -= s * 0.2; b.knee.r.rotation.x -= s * 0.2;
    } else if (st === 'swing') {
      const k = clamp(e.t / Math.max(0.001, e.dur), 0, 1);
      const s = easeOut(k, 0.42);
      if (e.tellKind) {
        b.shoulder.r.rotation.set(lerp(-2.55, -0.25, s), 0, lerp(-0.03, 0.30, s));
        b.elbow.r.rotation.x = lerp(-0.60, -0.15, s);
        b.chest.rotation.x = lerp(-0.23, 0.52, s);
        b.chest.rotation.y = lerp(-0.22, 0.10, s);
        e.grip.rotation.x = lerp(Math.PI * 0.5 + 0.8, Math.PI * 0.5 - 0.5, s);
      } else {
        b.shoulder.r.rotation.set(lerp(-1.40, -1.15, s), 0, lerp(-0.63, 1.00, s));
        b.elbow.r.rotation.x = lerp(-1.40, -0.30, s);
        b.chest.rotation.y = lerp(-0.55, 0.60, s);
        b.hips.rotation.y = lerp(-0.24, 0.26, s);
        e.grip.rotation.x = Math.PI * 0.5 + lerp(0.35, -0.15, s);
      }
      b.hips.position.y -= 0.05 * Math.sin(k * Math.PI);
    } else if (st === 'standoff') {
      b.shoulder.r.rotation.set(-0.35, 0, 0.32);
      b.elbow.r.rotation.x = -1.35;
      b.shoulder.l.rotation.set(-0.55, 0, -0.40);
      b.elbow.l.rotation.x = -1.20;
      b.chest.rotation.x = 0.12;
      b.hips.position.y = 0.80;
      b.knee.l.rotation.x = -0.50; b.knee.r.rotation.x = -0.42;
      e.grip.rotation.x = Math.PI * 0.5 - 0.35;
    } else if (dist < 9) {
      const br = Math.sin(e.t * 2.2 + e.phase) * 0.03;
      b.shoulder.r.rotation.set(-0.85 + br, 0, 0.34);
      b.elbow.r.rotation.x = -1.15;
      b.shoulder.l.rotation.z = -0.34;
      b.elbow.l.rotation.x = -0.85;
      b.chest.rotation.y -= 0.20;
      b.hips.position.y -= 0.05;
      b.knee.l.rotation.x -= 0.16; b.knee.r.rotation.x -= 0.14;
      e.grip.rotation.x = Math.PI * 0.5 - 0.25;
    }
  }

  // ---- foreign enemy adoption ----------------------------------------------
  // LATCH, do not poll. An empty ctx.enemies.list used to mean "the AI lane is
  // still a stub", so this fell back to the grey-blue sparring band anchored
  // 3.4-5.6 m in front of the camera. enemy.js now unloads squads outside 262 m,
  // which makes a reachable-zero list a NORMAL state — walking away from a camp
  // would spawn three placeholder raiders in the shot. Once real enemies have
  // ever been adopted the band is gone for good.
  let everForeign = false;
  function syncForeign() {
    const list = ctx.enemies && ctx.enemies.list ? ctx.enemies.list : null;
    if (!list || list.length === 0) {
      if (everForeign) { foreign.length = 0; return; }
      if (useForeign) { useForeign = false; bandGroup.visible = true; }
      return;
    }
    everForeign = true;
    if (!useForeign) {
      useForeign = true; bandGroup.visible = false;
      for (const e of band) { e.tell.visible = false; e.trail.clear(); }
    }
    foreign.length = 0;
    for (const src of list) {
      if (!src) continue;
      const p = src.position || (src.group && src.group.position) || (src.root && src.root.position);
      if (!p) continue;
      let a = src.__combat;
      if (!a) {
        a = src.__combat = {
          foreign: true, src, pos: p, dead: false,
          health: src.health ?? 100, maxHealth: src.maxHealth ?? 100,
          poise: src.poise ?? 100, maxPoise: src.maxPoise ?? 100,
          st: 'idle', t: 0, dur: 0, flinch: 0, stagger: 0, tellKind: 0,
          kb: new THREE.Vector3(), flinchDir: new THREE.Vector3(),
          rng: mulberry(4242), pendingHit: null, tell: null,
        };
      }
      a.pos = p;
      if (src.health !== undefined && src.health > a.health) a.health = src.health;
      a.dead = src.dead ?? (a.health <= 0);
      foreign.push(a);
    }
  }
  function pushForeign(dt) {
    for (const a of foreign) {
      const s = a.src;
      if (a.pendingHit) {
        s.onHit?.(a.pendingHit.dmg, a.pendingHit.dir);
        s.hit?.(a.pendingHit.dmg, a.pendingHit.dir);
        a.pendingHit = null;
      }
      if (s.health !== undefined) s.health = a.health;
      // On the TRANSITION only. This ran every frame for as long as a corpse
      // was in the list, so any provider whose kill() is not idempotent had its
      // death routine — and its death timer — restarted 60x a second, and the
      // corpse could never sink or despawn.
      if (a.dead && !s.dead) { s.dead = true; s.kill?.(); }
      if (a.kb.lengthSq() > 1e-6) {
        a.pos.x += a.kb.x * dt * 6; a.pos.z += a.kb.z * dt * 6;
        a.kb.multiplyScalar(Math.exp(-9 * dt));
      }
      a.stagger = Math.max(0, a.stagger - dt);
      a.flinch = Math.max(0, a.flinch - dt);
      s.staggered = a.stagger > 0;
    }
  }

  // ---- sparring band anchoring ---------------------------------------------
  const lastPos = new THREE.Vector3();
  function anchorBand() {
    const p = playerPos();
    const yaw = player.yaw;
    const spread = [[0.0, 3.4], [-0.62, 4.5], [0.66, 5.6]];
    for (let i = 0; i < band.length; i++) {
      const e = band[i];
      const a = yaw + spread[i][0], d = spread[i][1];
      const x = p.x + Math.sin(a) * d, z = p.z + Math.cos(a) * d;
      e.pos.set(x, groundY(x, z), z);
      e.yaw = a + Math.PI; e.root.rotation.set(0, e.yaw, 0);
      e.health = e.maxHealth; e.poise = e.maxPoise;
      e.dead = false; e.deadT = 0; e.st = 'idle'; e.t = 0; e.dur = 0;
      e.flinch = 0; e.stagger = 0; e.kb.set(0, 0, 0);
      e.aggro = false; e.cool = 0.9 + i * 0.7; e.tell.visible = false;
      e.trail.clear();
      e.rng = mulberry(1337 + i * 977);
    }
    token = null;
  }

  // ---- the pose stamp -------------------------------------------------------
  const _hilt = new THREE.Vector3(), _pole = new THREE.Vector3(), _tgt = new THREE.Vector3();
  function stampPose(dt) {
    if (!B) return;
    const S = stanceOf();
    let A = poseFrom, Bp = poseTo, k = 0;

    switch (phase) {
      case 'windup':
        A = poseFrom; Bp = poseTo; k = easeOut(pt / step.wind, 1.7); break;
      case 'active':
        // the whip: nearly all of the travel happens in the first third
        A = ARCS[step.arc][0]; Bp = ARCS[step.arc][1]; k = easeOut(pt / step.act, 0.40); break;
      case 'recover':
        A = ARCS[step.arc][1]; Bp = state.drawn ? S.guard : NEUTRAL;
        k = smooth(clamp(pt / step.rec, 0, 1)); break;
      case 'parry':
        if (parryResult === 2) { A = poseFrom; Bp = P_PARRY_SNAP; k = easeOut(pt / 0.10, 0.45); }
        else if (pt < 0.09) { A = poseFrom; Bp = P_PARRY; k = easeOut(pt / 0.09, 0.5); }
        else if (pt < PARRY_BLOCK) { A = P_PARRY; Bp = P_PARRY; k = 0; }
        else {
          A = parryResult === 2 ? P_PARRY_SNAP : P_PARRY;
          Bp = state.drawn ? S.guard : NEUTRAL;
          k = smooth((pt - PARRY_BLOCK) / (PARRY_TOTAL - PARRY_BLOCK));
        }
        break;
      case 'dodge':
        if (pt < 0.13) { A = poseFrom; Bp = P_DODGE[0]; k = easeOut(pt / 0.13, 0.5); }
        else if (pt < 0.30) { A = P_DODGE[0]; Bp = P_DODGE[1]; k = smooth((pt - 0.13) / 0.17); }
        else { A = P_DODGE[1]; Bp = state.drawn ? S.guard : NEUTRAL; k = smooth((pt - 0.30) / (DODGE_TOTAL - 0.30)); }
        break;
      case 'flinch':
        if (pt < 0.13) { A = poseFrom; Bp = P_FLINCH; k = easeOut(pt / 0.13, 0.5); }
        else { A = P_FLINCH; Bp = state.drawn ? S.guard : NEUTRAL; k = smooth((pt - 0.13) / 0.24); }
        break;
      case 'stagger':
        if (pt < 0.12) { A = poseFrom; Bp = P_STAGGER; k = easeOut(pt / 0.12, 0.5); }
        else { A = P_STAGGER; Bp = state.drawn ? S.guard : NEUTRAL; k = smooth((pt - 0.12) / 0.62); }
        break;
      case 'standoff':
        A = poseFrom; Bp = P_STANDOFF; k = smooth(clamp(pt / 0.55, 0, 1)); break;
      case 'exec':
        if (pt < 0.09) { A = ARCS.iai[0]; Bp = ARCS.iai[0]; k = 0; }
        else if (pt < 0.23) { A = ARCS.iai[0]; Bp = ARCS.iai[1]; k = easeOut((pt - 0.09) / 0.14, 0.35); }
        else { A = ARCS.iai[1]; Bp = state.drawn ? S.guard : NEUTRAL; k = smooth(clamp((pt - 0.45) / 0.5, 0, 1)); }
        break;
      case 'dead':
        A = poseFrom; Bp = P_DEAD; k = smooth(clamp(pt / 0.9, 0, 1)); break;
      default: {
        const target = state.drawn ? S.guard : NEUTRAL;
        blendPose(poseTmp, pose, target, 1 - Math.exp(-9 * dt));
        A = poseTmp; Bp = poseTmp; k = 0;
      }
    }
    blendPose(pose, A, Bp, clamp(k, 0, 1));

    B.hips.position.y += pose.hy;
    B.hips.rotation.x += pose.hrx; B.hips.rotation.y += pose.hry; B.hips.rotation.z += pose.hrz;
    B.chest.rotation.x += pose.cx; B.chest.rotation.y += pose.cy; B.chest.rotation.z += pose.cz;
    B.neck.rotation.x += pose.nx; B.neck.rotation.y += pose.ny;
    B.shoulder.r.rotation.x += pose.srx; B.shoulder.r.rotation.y += pose.sry; B.shoulder.r.rotation.z += pose.srz;
    B.elbow.r.rotation.x += pose.erx;
    B.shoulder.l.rotation.x += pose.slx; B.shoulder.l.rotation.y += pose.sly; B.shoulder.l.rotation.z += pose.slz;
    B.elbow.l.rotation.x += pose.elx;
    B.hip.l.rotation.x += pose.lhx; B.hip.r.rotation.x += pose.rhx;
    B.hip.l.rotation.z += pose.lhz; B.hip.r.rotation.z += pose.rhz;
    B.knee.l.rotation.x += pose.lkx; B.knee.r.rotation.x += pose.rkx;

    // Solve the wrist so the blade aims where the ARC says, not wherever the
    // shoulder happened to land. This is what keeps a flat cut flat.
    if (pose.bs !== undefined) {
      grip.rotation.x = pose.bs - (B.chest.rotation.x + B.shoulder.r.rotation.x + B.elbow.r.rotation.x);
    } else grip.rotation.x = Math.PI;
    grip.rotation.y = pose.gy; grip.rotation.z = pose.gz;

    player.root.updateMatrixWorld(true);

    if (pose.ik > 0.02 && state.drawn) {
      _hilt.set(0, -0.05, 0);
      katana.group.localToWorld(_hilt);
      B.chest.worldToLocal(_tgt.copy(_hilt));
      _pole.set(0.85, -0.55, 0.28).normalize();
      ik2(B.shoulder.l, B.elbow.l, 0.30, 0.29, _tgt, _pole, clamp(pose.ik, 0, 1));
      player.root.updateMatrixWorld(true);
    }
    if (pose.ikR > 0.02 && B.swordRig) {
      _hilt.set(0, 0, 0.30);
      B.swordRig.localToWorld(_hilt);
      B.chest.worldToLocal(_tgt.copy(_hilt));
      _pole.set(-0.8, -0.5, 0.35).normalize();
      ik2(B.shoulder.r, B.elbow.r, 0.30, 0.29, _tgt, _pole, clamp(pose.ikR, 0, 1));
      _hilt.set(0, -0.20, 0.02);
      B.swordRig.localToWorld(_hilt);
      B.chest.worldToLocal(_tgt.copy(_hilt));
      _pole.set(0.9, -0.4, 0.2).normalize();
      ik2(B.shoulder.l, B.elbow.l, 0.30, 0.29, _tgt, _pole, clamp(pose.ikR, 0, 1) * 0.9);
      player.root.updateMatrixWorld(true);
    }
  }

  // ---- player step (runs inside the player.update wrapper) ------------------
  function preStep(sdt, rdt, inp) {
    readInput(inp, sdt);
    pt += sdt;

    if (phase !== 'dead' && phase !== 'exec' && phase !== 'standoff') {
      if (pendingDodge && phase !== 'dodge' && phase !== 'active') startDodge(inp);
      else if (pendingParry && (phase === 'idle' || phase === 'recover' || phase === 'flinch')) startParry();
    }
    pendingParry = false; pendingDodge = false;

    switch (phase) {
      case 'idle':
        if (bufferKind) startAttack(bufferKind);
        break;

      case 'windup': {
        if (lockTarget && !lockTarget.dead) {
          const p = playerPos();
          attackYaw = Math.atan2(lockTarget.pos.x - p.x, lockTarget.pos.z - p.z);
        }
        setYaw(angLerp(player.yaw, attackYaw, 1 - Math.exp(-14 * sdt)));
        if (pt >= step.wind) {
          phase = 'active'; pt = 0;
          hitSet.clear();
          trail.clear(); trail.setOpacity(1.35);
          ctx.audio?.play?.('swing', {});
        }
        break;
      }

      case 'active':
        if (step.spin) setYaw(spinFrom + Math.PI * 2 * easeOut(pt / step.act, 1.4));
        if (pt >= step.act) { phase = 'recover'; pt = 0; }
        break;

      case 'recover':
        trail.setOpacity(Math.max(0, 1.0 - pt / (step.rec * 0.7)) * 0.85);
        if (bufferKind && pt >= step.cancel * step.rec) startAttack(bufferKind);
        else if (pt >= step.rec) { phase = 'idle'; pt = 0; stepIndex = -1; }
        break;

      case 'parry':
        if (pt >= PARRY_TOTAL) { phase = 'idle'; pt = 0; parryResult = 0; }
        break;

      case 'dodge': {
        const t = clamp(pt / DODGE_TOTAL, 0, 1);
        const v = 15.5 * Math.pow(1 - t, 2.2);
        const p = playerPos();
        player.setPosition(p.x + dodgeDir.x * v * sdt, 0, p.z + dodgeDir.z * v * sdt,
          THREE.MathUtils.radToDeg(angLerp(player.yaw, attackYaw, 1 - Math.exp(-9 * sdt))));
        if (pt >= DODGE_TOTAL) { phase = 'idle'; pt = 0; }
        break;
      }

      case 'flinch':
        if (pt >= 0.37) { phase = 'idle'; pt = 0; }
        break;

      case 'stagger': {
        const p = playerPos();
        const push = 3.2 * Math.pow(clamp(1 - pt / 0.34, 0, 1), 2);
        player.setPosition(p.x + staggerDir.x * push * sdt, 0, p.z + staggerDir.z * push * sdt,
          THREE.MathUtils.radToDeg(player.yaw));
        if (pt >= 0.74) { phase = 'idle'; pt = 0; }
        break;
      }

      case 'standoff': break;

      case 'exec': {
        execReal += rdt;
        if (execTarget) {
          const p = playerPos();
          setYaw(Math.atan2(execTarget.pos.x - p.x, execTarget.pos.z - p.z));
          const d = Math.hypot(execTarget.pos.x - p.x, execTarget.pos.z - p.z);
          if (pt > 0.09 && pt < 0.30 && d > 1.5) {
            const ux = (execTarget.pos.x - p.x) / d, uz = (execTarget.pos.z - p.z) / d;
            player.setPosition(p.x + ux * 13 * sdt, 0, p.z + uz * 13 * sdt,
              THREE.MathUtils.radToDeg(player.yaw));
          }
          if (pt >= 0.20 && !execTarget.dead) {
            const p2 = playerPos();
            const dx = execTarget.pos.x - p2.x, dz = execTarget.pos.z - p2.z;
            const l = Math.hypot(dx, dz) || 1;
            killEnemy(execTarget, dx / l, dz / l, true);
            trail.setOpacity(1.5);
          }
        }
        if (execReal >= 2.3) {
          phase = 'idle'; pt = 0; execTarget = null; slowmoTarget = 1;
          if (so.active) {
            const next = nearestHostile(9);
            if (next && so.streak < 3) {
              so.t = 0; so.phase = 'settle'; so.enemy = next; so.window = 0;
              so.tell = 0.85 + Math.random() * 0.75;
              next.st = 'standoff'; next.t = 0;
              poseFrom = capture();
              phase = 'standoff'; pt = 0;
              setDrawn(false);
              slowmoTarget = 0.9;
              hud.standoff('HOLD  —  WAIT FOR THE TELL');
              standoffCam(next);
            } else endStandoff();
          }
        }
        break;
      }

      case 'dead':
        deathReal += rdt;
        if (deathReal > 3.0) {
          state.health = state.maxHealth * 0.6;
          phase = 'idle'; pt = 0;
          for (const e of enemies()) { e.aggro = false; e.cool = 2.5; }
        }
        break;
    }

    // lunge — the step INTO the cut, and the settle back on the wind-up
    if ((phase === 'windup' || phase === 'active') && step) {
      const p = playerPos();
      const v = phase === 'windup'
        ? -step.lunge * 0.16 * (1 - pt / step.wind)
        : step.lunge * Math.pow(1 - pt / step.act, 1.6);
      let block = false;
      if (lockTarget && !lockTarget.dead && v > 0) {
        const d = Math.hypot(lockTarget.pos.x - p.x, lockTarget.pos.z - p.z);
        if (d < 1.55) block = true;
      }
      if (!block && Math.abs(v) > 0.001) {
        const nx = p.x + Math.sin(player.yaw) * v * sdt;
        const nz = p.z + Math.cos(player.yaw) * v * sdt;
        player.root.position.set(nx, groundY(nx, nz), nz);
      }
    }

    if (phase !== 'dead') {
      regenT += rdt;
      if (regenT > 6 && state.health < state.maxHealth) {
        state.health = Math.min(state.maxHealth, state.health + 7 * rdt);
      }
    }
  }

  // ---- install the player wrapper ------------------------------------------
  const _savedMove = { x: 0, y: 0 };
  if (player && typeof player.update === 'function' && !player.__combatWrapped) {
    const inner = player.update.bind(player);
    player.update = (dt, c) => {
      const sdt = dt * state.timeScale;
      const inp = c.input;
      const a = inp.attack, h = inp.heavy, pr = inp.parry, dg = inp.dodge, sc = inp.stanceCycle;
      preStep(sdt, dt, inp);
      // combat owns these edges — the character's built-in overlay must not
      // also fire, or two animation systems fight over the same bones.
      inp.attack = inp.heavy = inp.parry = inp.dodge = false; inp.stanceCycle = 0;
      _savedMove.x = inp.move.x; _savedMove.y = inp.move.y;
      const gate = moveGate();
      inp.move.x *= gate; inp.move.y *= gate;
      const sprint = inp.sprint;
      if (state.inCombat || phase !== 'idle') inp.sprint = false;
      inner(sdt, c);
      inp.move.x = _savedMove.x; inp.move.y = _savedMove.y;
      inp.sprint = sprint;
      inp.attack = a; inp.heavy = h; inp.parry = pr; inp.dodge = dg; inp.stanceCycle = sc;
      stampPose(sdt);
    };
    player.__combatWrapped = true;
  }

  // ---------------------------------------------------------------------------
  //  Public update — after the player has moved and been posed.
  // ---------------------------------------------------------------------------
  const _wp = new THREE.Vector3();
  let firstFrame = true;

  function update(rdt, c) {
    state.timeScale = timeScale();
    const sdt = rdt * state.timeScale;

    if (hitstop > 0) hitstop -= rdt;
    if (slowmo > 0) { slowmo -= rdt; if (slowmo <= 0) { slowmoTarget = 1; slowmo = 0; } }
    cine = dampf(cine, (camMode === 'killcam' || so.active) ? 1 : 0, 6, rdt);
    applyGrade();

    syncForeign();

    const p = playerPos();
    if (firstFrame) { lastPos.copy(p); anchorBand(); firstFrame = false; }
    else if (!useForeign && p.distanceToSquared(lastPos) > 400) anchorBand();
    lastPos.copy(p);

    // scripted hooks used by this lane's own burst sequences
    const cmd = c.input.cmd;
    if (cmd) {
      c.input.cmd = null;
      if (cmd === 'standoff') beginStandoff(nearestHostile(14), 1.0);
      else if (cmd === 'enemy_attack' || cmd === 'enemy_heavy') {
        const e = nearestHostile(9);
        if (e && !e.dead) {
          token = e; e.st = 'telegraph'; e.t = 0; e.hitDone = false; e.aggro = true;
          e.tellKind = cmd === 'enemy_heavy' ? 1 : 0;
          e.dur = e.tellKind ? 0.60 : 0.42;
        }
      } else if (cmd === 'kill') {
        const e = nearestHostile(14);
        if (e && !e.dead) {
          const dx = e.pos.x - p.x, dz = e.pos.z - p.z, l = Math.hypot(dx, dz) || 1;
          killEnemy(e, dx / l, dz / l, true);
        }
      } else if (cmd === 'aggro') for (const e of enemies()) e.aggro = true;
    }

    let hostiles = 0, nearest = Infinity;
    for (const e of enemies()) {
      if (e.dead) continue;
      hostiles++;
      const d = Math.hypot(e.pos.x - p.x, e.pos.z - p.z);
      if (d < nearest) nearest = d;
    }
    state.hostiles = hostiles;

    const engaged = hostiles > 0 && nearest < 16;
    if (engaged) { outOfCombat = 0; state.inCombat = true; }
    else { outOfCombat += rdt; if (outOfCombat > 4) state.inCombat = false; }

    if (state.inCombat && !state.drawn && phase !== 'standoff' && phase !== 'exec') {
      drawT += rdt;
      if (drawT > 0.18) {
        setDrawn(true); drawT = 0;
        trail.setOpacity(0.85);
        flash(p.x, p.y + 1.25, p.z, 0.55, 1.5, 1.3, 0.95, 0.24);
        ctx.audio?.play?.('draw', {});
      }
    } else if (!state.inCombat && state.drawn && phase === 'idle') {
      sheatheT += rdt;
      if (sheatheT > 1.2) { setDrawn(false); sheatheT = 0; }
    } else { sheatheT = 0; drawT = 0; }

    // ---- standoff clock
    if (so.active) {
      so.t += rdt;
      const e = so.enemy;
      if ((!e || e.dead) && phase !== 'exec') endStandoff();
      else if (phase === 'standoff') {
        if (standoffPress) { standoffPress = false; standoffStrike(so.phase === 'tell'); }
        else if (so.phase === 'settle' && so.t > so.tell) {
          so.phase = 'tell'; so.window = 0;
          state.standoff = 'tell';
          e.st = 'telegraph'; e.t = 0; e.dur = 0.42; e.tellKind = 0; e.hitDone = false;
          hud.standoff('STRIKE');
          addTrauma(0.10);
          slowmoTarget = 0.5;
        } else if (so.phase === 'tell') {
          so.window += rdt;
          if (so.window > 0.34) standoffStrike(false);
        }
      }
    }
    standoffPress = false;

    // ---- opponents
    if (useForeign) pushForeign(sdt);
    else for (const e of band) updateRaider(e, sdt, p);

    for (const e of band) {
      if (!useForeign && e.st === 'swing' && !e.dead) {
        e.root.updateMatrixWorld(true);
        e.sabre.base.getWorldPosition(_wp);
        const bx = _wp.x, by = _wp.y, bz = _wp.z;
        e.sabre.tip.getWorldPosition(_wp);
        e.trail.push(bx, by, bz, _wp.x, _wp.y, _wp.z);
        e.trail.setOpacity(0.8);
      }
      e.trail.update(rdt);
    }

    // ---- blade sampling, trail, hit sweep
    if (state.drawn) {
      katana.base.getWorldPosition(curBase);
      katana.tip.getWorldPosition(curTip);
      if (!bladeSampled) { prevBase.copy(curBase); prevTip.copy(curTip); bladeSampled = true; }
      const hot = phase === 'active';
      if (hot || phase === 'exec' || (phase === 'parry' && pt < 0.18) || phase === 'dodge') {
        trail.push(curBase.x, curBase.y, curBase.z, curTip.x, curTip.y, curTip.z);
      }
      if (hot) sweepHit();
      if (phase === 'exec' && pt > 0.09 && pt < 0.34 && Math.random() < 0.75) {
        const t = Math.random();
        sparks(lerp(curBase.x, curTip.x, t), lerp(curBase.y, curTip.y, t), lerp(curBase.z, curTip.z, t),
          0, 0.4, 0, 2, 0.8, 1.6);
      }
      prevBase.copy(curBase); prevTip.copy(curTip);
    } else bladeSampled = false;
    trail.update(rdt);

    const glow = phase === 'active' ? 1 : phase === 'exec' ? 1.6 : 0;
    katana.steel.emissive.setRGB(0.10 + glow * 0.28, 0.11 + glow * 0.26, 0.14 + glow * 0.20);
    katana.edge.emissive.setRGB(0.16 + glow * 0.60, 0.18 + glow * 0.58, 0.22 + glow * 0.50);

    fxAdd.update(sdt); fxAlpha.update(sdt);
    trauma = Math.max(0, trauma - rdt * 1.85);
    if (token) { tokenT += rdt; if (tokenT > 4) { token = null; tokenT = 0; } }

    updateRim(c, 1.0 + cine * 0.5);
    frameFight(rdt, c, lockTarget && !lockTarget.dead ? lockTarget : nearestHostile(16),
      state.inCombat && hostiles > 0);

    state.phase = phase;
    state.comboIndex = stepIndex;
    state.target = lockTarget;
    state.killcam = camMode === 'killcam';
    hud.ensure();
    hud.setHealth(state.health / state.maxHealth);
    hud.setResolve(state.resolve);
    hud.setVisible(state.inCombat || state.drawn);
    hud.update(rdt);

    // Only drive the mix while actually fighting. Out of combat the quest owns
    // intensity; writing 0 here every frame silently overrode the whole arc.
    if (state.inCombat) {
      ctx.audio?.setIntensity?.(clamp(0.35 + hostiles * 0.22, 0, 1));
      audioReleased = false;
    } else if (!audioReleased) {
      audioReleased = true;                     // hand control back exactly once
      ctx.audio?.setIntensity?.(0.18);
    }
  }

  // ---------------------------------------------------------------------------
  const api = {
    state, group, katana, trail, STANCES,
    get stance() { return stanceOf(); },
    get enemyList() { return enemies(); },
    update,
    onPlayerInput(inp) { readInput(inp, 1 / 60); },

    // Called by enemy.js when a hit lands. Without this the health bars were
    // decoration and nothing the enemies did ever mattered.
    onPlayerHit(dmg = 8, blockable = true) {
      const p = playerPos();
      let dx = 0, dz = 1;
      const src = ctx.enemies && ctx.enemies.nearestTo ? ctx.enemies.nearestTo(p, 8) : null;
      if (src && src.root) {
        dx = p.x - src.root.position.x; dz = p.z - src.root.position.z;
        const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      }
      damagePlayer(dmg, dx, dz, !blockable || dmg >= 14);
    },
    setStance(i) {
      state.stanceIndex = clamp(i | 0, 0, STANCES.length - 1);
      state.stance = STANCES[state.stanceIndex].id;
      hud.setStance(state.stanceIndex);
    },
    beginStandoff, endStandoff,
    hitstop: doHitstop,
    shake: addTrauma,
    damage(e, dmg, dirx, dirz) { damageEnemy(e, dmg, dmg * 2, dirx, dirz, {}); },
    kill(e, dirx = 0, dirz = 1) { killEnemy(e, dirx, dirz, true); },
    registerEnemy(e) { if (e && !foreign.includes(e)) foreign.push(e); },
    spawnSparring: anchorBand,
    sparks, bloodBurst, dust, flash,
  };

  if (typeof window !== 'undefined') window.__COMBAT = api;
  return api;
}
