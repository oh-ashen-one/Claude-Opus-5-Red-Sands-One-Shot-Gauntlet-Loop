import * as THREE from 'three';
import { heightAt, riverAt } from './terrain.js';

// =============================================================================
// Kaze no Michi — WATER
//
// Two surfaces, one shading language:
//
//   OCEAN   a camera-centred grid whose radial spacing is warped so it stays
//           dense out to ~600m and then opens up geometrically to 8km. Six
//           Gerstner waves with real deep-water dispersion (c = sqrt(g/k)) give
//           directional swell; the same closed form is re-evaluated per pixel so
//           the normals stay crisp at any tessellation.
//
//   RIVER   a ribbon following terrain.js's riverAt(z) — the SAME meander the
//           height field carves, running north to the sea. It used to carry its
//           own private centreline running east-west, at right angles to the
//           actual valley, which is why there was no water at the river pose.
//           Its surface elevation is a real downhill profile: the channel bed
//           is sampled, pits are flooded to their spill level, and the result is
//           smoothed. Flow direction and speed come from the gradient of that
//           profile, so the water runs downhill and quickens in the steeps.
//
// Everything that needs to know where the land is reads ONE baked field texture
// built from world.heightAt — so the coastline the foam follows is the true
// coastline, not an approximation of it. Channels are
//   R  terrain height
//   G  signed horizontal distance to the waterline (+ on land, − offshore)
//   B  dH/dx
//   A  dH/dz
// Signed distance is what makes the shoreline work: a foam band N units wide in
// G is N METRES wide on the ground whether the beach is flat or steep.
//
// Two rules kept this fast enough: no `discard` anywhere (it would defeat the
// GPU's early depth rejection and the ocean grid covers the whole screen), and
// a hard early-out past the distance where fog is already total.
//
// No external assets — the field, the ripple/foam/caustic texture and both
// meshes are all generated in code.
// =============================================================================

const SEA_LEVEL = 0.0;

const FIELD_RES = 2048;
const FIELD_SPAN = 2560;          // world units covered by the field texture
const FIELD_DEEP = -34.0;         // assumed height outside the field
const OCEAN_REACH = 8192;         // radius of the ocean grid
const RIVER_HALF_W = 56;          // ribbon half-width; shading trims it to the channel

// ---------------------------------------------------------------------------
// Tileable procedural noise (value noise on a wrapping lattice).
// ---------------------------------------------------------------------------
function ihash(x, y, s) {
  let n = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1274126177);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}
function wrap(a, p) { return ((a % p) + p) % p; }
function pnoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const x0 = wrap(xi, period), x1 = wrap(xi + 1, period);
  const y0 = wrap(yi, period), y1 = wrap(yi + 1, period);
  const a = ihash(x0, y0, seed), b = ihash(x1, y0, seed);
  const c = ihash(x0, y1, seed), d = ihash(x1, y1, seed);
  const ab = a + (b - a) * u, cd = c + (d - c) * u;
  return ab + (cd - ab) * v;
}
function pfbm(u, v, base, oct, seed) {
  let amp = 0.5, f = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * pnoise(u * base * f, v * base * f, base * f, seed + i * 37);
    norm += amp; amp *= 0.5; f *= 2;
  }
  return sum / norm;
}

// R,G = ripple normal   B = foam breakup   A = caustic filaments
//
// NRM_GAIN is how hard the fbm's gradient is pushed into the 8-bit R/G
// channels. It used to be 7.0, and MEASURED over the whole 512x512 tile that
// leaves (r - 0.5) with an rms of 0.0193 and a full range of +-0.09 — barely
// twenty of the two hundred and fifty-six available codes. Every consumer then
// had to multiply it back up, quantisation and all, and the river's two ripple
// layers came out at an rms surface slope of 1.2 DEGREES. A 1.2-degree ripple
// is a mirror, which is exactly what the river graded as: "a thin flat
// grey-white ribbon with no depth". At 36.0 the same field spans +-0.46 with an
// rms of 0.0993 and still does not clip (peak |gradient| measured at 0.0257).
// NRM_RMS below is that measured 0.0993, so a shader can ask for a slope in
// RADIANS and get one.
const NRM_GAIN = 36.0;
const NRM_RMS = 0.0993;
// Preserves the ocean's chop exactly: its multipliers were tuned against the
// old gain, so they are scaled by the ratio. The ocean is unchanged except that
// its chop is now quantised five times more finely.
const OCEAN_CHOP_FIX = 7.0 / NRM_GAIN;

function makeSurfaceNoise() {
  const S = 512;
  const hgt = new Float32Array(S * S);
  const foam = new Float32Array(S * S);
  const caus = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      hgt[y * S + x] = pfbm(u, v, 6, 5, 11);
      foam[y * S + x] = pfbm(u, v, 4, 6, 617);
      const r = pfbm(u, v, 7, 4, 1301);
      caus[y * S + x] = Math.pow(1 - Math.abs(r * 2 - 1), 3.1);
    }
  }
  const data = new Uint8Array(S * S * 4);
  const enc = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const xm = (x + S - 1) % S, xp = (x + 1) % S;
      const ym = (y + S - 1) % S, yp = (y + 1) % S;
      const gx = (hgt[y * S + xp] - hgt[y * S + xm]) * 0.5;
      const gy = (hgt[yp * S + x] - hgt[ym * S + x]) * 0.5;
      const o = (y * S + x) * 4;
      data[o] = enc(-gx * NRM_GAIN * 0.5 + 0.5);
      data[o + 1] = enc(-gy * NRM_GAIN * 0.5 + 0.5);
      data[o + 2] = enc(foam[y * S + x]);
      data[o + 3] = enc(caus[y * S + x]);
    }
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// The land field. Everything the water knows about the island comes from here.
// Deliberately un-mipmapped: the height function has no detail below ~13 units
// so there is nothing to alias, and flat sampling lets the shader branch around
// the reflection march without breaking derivative-based mip selection.
// ---------------------------------------------------------------------------
function makeLandField() {
  const N = FIELD_RES;
  const G = N + 1;
  const step = FIELD_SPAN / N;
  const half = FIELD_SPAN * 0.5;

  const hs = new Float32Array(G * G);
  for (let j = 0; j < G; j++) {
    const z = -half + j * step;
    const row = j * G;
    for (let i = 0; i < G; i++) hs[row + i] = heightAt(-half + i * step, z);
  }

  const toHalf = THREE.DataUtils.toHalfFloat;
  const data = new Uint16Array(N * N * 4);
  const invStep = 1 / step;
  for (let j = 0; j < N; j++) {
    const r0 = j * G, r1 = (j + 1) * G;
    for (let i = 0; i < N; i++) {
      const a = hs[r0 + i], b = hs[r0 + i + 1], c = hs[r1 + i], d = hs[r1 + i + 1];
      const h = (a + b + c + d) * 0.25;
      const gx = ((b + d) - (a + c)) * 0.5 * invStep;
      const gz = ((c + d) - (a + b)) * 0.5 * invStep;
      const g = Math.sqrt(gx * gx + gz * gz);
      // Signed horizontal distance to the h = 0 contour, first order.
      let sd = h / Math.max(g, 0.010);
      if (sd > 140) sd = 140; else if (sd < -140) sd = -140;
      const o = (j * N + i) * 4;
      data[o] = toHalf(h);
      data[o + 1] = toHalf(sd);
      data[o + 2] = toHalf(gx);
      data[o + 3] = toHalf(gz);
    }
  }

  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Ocean geometry: square rings whose radius follows a spacing schedule, so the
// lattice stays fine where the shoreline is and opens up towards the horizon.
// ---------------------------------------------------------------------------
function makeOceanGeometry() {
  const radii = [0];
  let r = 0;
  while (r < OCEAN_REACH) {
    r += Math.min(2.4 + r * 0.0082, 9.0) + Math.max(0, r - 800) * 0.115;
    radii.push(Math.min(r, OCEAN_REACH));
  }
  const N = radii.length - 1;
  const W = 2 * N + 1;

  const pos = new Float32Array(W * W * 3);
  for (let j = -N; j <= N; j++) {
    for (let i = -N; i <= N; i++) {
      const m = Math.max(Math.abs(i), Math.abs(j));
      const s = m === 0 ? 0 : radii[m] / m;
      const o = ((j + N) * W + (i + N)) * 3;
      pos[o] = i * s;
      pos[o + 1] = 0;
      pos[o + 2] = j * s;
    }
  }
  const idx = new Uint32Array(2 * N * 2 * N * 6);
  let k = 0;
  for (let j = 0; j < W - 1; j++) {
    for (let i = 0; i < W - 1; i++) {
      const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b;
      idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), OCEAN_REACH * 1.5);
  return geo;
}

// ---------------------------------------------------------------------------
// River: centreline, a hydrologically-sane downhill surface, and the ribbon.
// ---------------------------------------------------------------------------
// The channel centre. This MUST be terrain.js's riverAt, not a private copy:
// the ribbon used to run z = f(x) — east to west — while the carve in the
// height field runs x = f(z), north to the sea. The two crossed at a couple of
// points and were otherwise hundreds of metres apart on a dry hillside, where
// the confinement gate correctly threw every fragment away. That is the whole
// reason the river pose had no water in it.
function riverCentre(z) {
  return riverAt(z).x;
}

function makeRiverGeometry() {
  const NZ = 520, NW = 22;
  const Z0 = -420, Z1 = 1180;               // head of the valley to well past the mouth
  const zs = new Float32Array(NZ + 1);
  const cx = new Float32Array(NZ + 1);      // channel bottom line, not the nominal meander
  const bed = new Float32Array(NZ + 1);
  const conf = new Float32Array(NZ + 1);    // how deeply the channel is confined
  const thal = new Float32Array(NZ + 1);

  for (let i = 0; i <= NZ; i++) {
    const z = Z0 + (Z1 - Z0) * (i / NZ);
    const c = riverCentre(z);
    zs[i] = z;
    // The carve is a 46-unit gaussian laid over mountainous ground, so the true
    // bottom of the channel wanders off the nominal centre. Follow the thalweg.
    let lo = Infinity, off = 0;
    for (let d = -40; d <= 40; d += 2) {
      const h = heightAt(c + d, z);
      if (h < lo) { lo = h; off = d; }
    }
    thal[i] = off;
  }
  const sm = new Float32Array(NZ + 1);
  for (let pass = 0; pass < 10; pass++) {
    sm.set(thal);
    for (let i = 1; i < NZ; i++) thal[i] = 0.25 * sm[i - 1] + 0.5 * sm[i] + 0.25 * sm[i + 1];
  }
  for (let i = 0; i <= NZ; i++) {
    const z = zs[i], c = riverCentre(z) + thal[i];
    cx[i] = c;
    bed[i] = heightAt(c, z);
    // Both banks must actually rise, or the "valley" is really a hillside and
    // no water belongs there.
    conf[i] = Math.min(heightAt(c + 34, z), heightAt(c - 34, z)) - bed[i];
  }
  for (let pass = 0; pass < 10; pass++) {
    sm.set(conf);
    for (let i = 1; i < NZ; i++) conf[i] = 0.25 * sm[i - 1] + 0.5 * sm[i] + 0.25 * sm[i + 1];
  }

  // 1D priority flood: a cell escapes over the highest barrier between it and a
  // sink, and anything at or below sea level IS a sink — that estuary halfway
  // along is why a naive running maximum floods the entire island.
  const maxL = new Float32Array(NZ + 1), maxR = new Float32Array(NZ + 1);
  let m = -Infinity;
  for (let i = 0; i <= NZ; i++) {
    m = bed[i] <= SEA_LEVEL ? -Infinity : Math.max(m, bed[i]);
    maxL[i] = m;
  }
  m = -Infinity;
  for (let i = NZ; i >= 0; i--) {
    m = bed[i] <= SEA_LEVEL ? -Infinity : Math.max(m, bed[i]);
    maxR[i] = m;
  }

  const surf = new Float32Array(NZ + 1);
  for (let i = 0; i <= NZ; i++) {
    const spill = Math.min(maxL[i], maxR[i]);
    const filled = Math.min(Math.max(bed[i], spill), bed[i] + 3.5);
    surf[i] = filled + THREE.MathUtils.clamp(conf[i] * 0.40, 0.6, 2.4);
  }
  const tmp = new Float32Array(NZ + 1);
  for (let pass = 0; pass < 16; pass++) {
    tmp.set(surf);
    for (let i = 1; i < NZ; i++) surf[i] = 0.25 * tmp[i - 1] + 0.5 * tmp[i] + 0.25 * tmp[i + 1];
    for (let i = 0; i <= NZ; i++) {
      surf[i] = THREE.MathUtils.clamp(surf[i], bed[i] + 0.55, bed[i] + 2.9);
    }
  }

  const W = NW + 1;
  const pos = new Float32Array((NZ + 1) * W * 3);
  const flow = new Float32Array((NZ + 1) * W * 3);
  const extra = new Float32Array((NZ + 1) * W * 3); // u across, surface level, gate

  for (let i = 0; i <= NZ; i++) {
    const im = Math.max(0, i - 1), ip = Math.min(NZ, i + 1);
    let tx = cx[ip] - cx[im], tz = zs[ip] - zs[im];
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    const grade = (surf[ip] - surf[im]) / tl;      // + means uphill toward +z
    const sgn = grade > 0 ? -1 : 1;                // water runs downhill
    const speed = THREE.MathUtils.clamp(Math.sqrt(Math.abs(grade)) * 8.0, 0.28, 3.0);
    const nx = -tz, nz = tx;                       // across-channel
    const gate = THREE.MathUtils.smoothstep(conf[i], 1.2, 3.0);
    for (let j = 0; j <= NW; j++) {
      const u = (j / NW) * 2 - 1;
      const o3 = (i * W + j) * 3;
      pos[o3] = cx[i] + nx * u * RIVER_HALF_W;
      pos[o3 + 1] = surf[i];
      pos[o3 + 2] = zs[i] + nz * u * RIVER_HALF_W;
      flow[o3] = tx * sgn; flow[o3 + 1] = tz * sgn; flow[o3 + 2] = speed;
      extra[o3] = u; extra[o3 + 1] = surf[i]; extra[o3 + 2] = gate;
    }
  }

  const idx = [];
  for (let i = 0; i < NZ; i++) {
    for (let j = 0; j < NW; j++) {
      const a = i * W + j, b = a + 1, c = (i + 1) * W + j, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aFlow', new THREE.BufferAttribute(flow, 3));
  geo.setAttribute('aRiv', new THREE.BufferAttribute(extra, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

// ---------------------------------------------------------------------------
// Shared GLSL
// ---------------------------------------------------------------------------
const COMMON = `
precision highp float;

uniform sampler2D uField;
uniform sampler2D uNoise;
uniform float uFieldSpan;
uniform float uTime;
uniform float uSeaLevel;
uniform float uFarCut;
uniform vec3  uSunDir;
uniform vec3  uSunCol;
uniform float uSunI;
uniform samplerCube uSkyCube;
uniform vec3  uLandRefl;
uniform vec3  uFogCol;
uniform float uFogDensity;
uniform vec3  uAmbient;
uniform vec3  uSeaTint;
uniform float uSunGain;
uniform float uReflKnee;
uniform float uEdgeDist;

// height, signed shore distance, dH/dx, dH/dz
vec4 fieldAt(vec2 p){
  vec2 uv = p / uFieldSpan + 0.5;
  vec2 cl = clamp(uv, 0.0, 1.0);
  vec4 f = texture2D(uField, cl);
  float outside = step(0.000001, dot(cl - uv, cl - uv));
  f.x = mix(f.x, ${FIELD_DEEP.toFixed(1)}, outside);
  f.y = mix(f.y, -140.0, outside);
  f.z = mix(f.z, 0.0, outside);
  f.w = mix(f.w, 0.0, outside);
  return f;
}

`;

// Fragment-stage only: GLSL ES 1.00 vertex shaders have no cube lookup.
const FRAG_LIB = `
// The sky the water reflects is the SAME sky the camera sees: a small cube is
// rendered from the sky dome, sun, cloud deck and stars every few frames. That
// is what makes the join at the horizon seamless — there is nothing to match by
// hand, the two are literally the same pixels.
vec3 skyColour(vec3 R){
  return textureCube(uSkyCube, normalize(R)).rgb;
}

// WHY THE SEA HAD NO HORIZON, measured rather than argued. On wave-H's
// 03-coast the sky just above the skyline averages 215.1 LSB over columns
// 60..700 and the sea just below it averages 215.4 — a drop of 0.2%, and the
// biggest row-to-row step anywhere across the boundary is 3.9 LSB. The sea and
// the sky were the same pixels, and every critic who called that "the sea
// dissolves into the sky" was reading the frame correctly.
//
// uSeaTint was supposed to be what separated them, and on paper a 0.55/0.575/
// 0.66 factor is a 40% cut. It does nothing here because the sun is 2 degrees
// up and DEAD AHEAD: the sky within a few degrees of it is enormously over
// range, so 0.6 x (something like 12.0) is still 7.2, and the tonemapper maps
// both to the same near-white. A multiply cannot separate two values that are
// both past the knee.
//
// So the limit has to be a saturating one, and there is a physical reason for
// exactly that shape. A rough water surface does not mirror the sky; it returns
// the sky CONVOLVED over its slope lobe, and no lobe of finite width can return
// the sun disc's peak radiance — a sun subtending 0.5 degrees spread over a
// 3-degree lobe loses ~1.5 orders of magnitude. That energy is not lost from the
// frame: it is exactly what the sun-road GGX term adds back, deliberately and
// with its own breakup. reflLimit is that convolution loss, as a Reinhard knee:
// dim sky passes through untouched (c << 1/uReflKnee), the sun's own glow is
// hard-limited, and the sea finally sits UNDER the sky it mirrors.
vec3 reflLimit(vec3 c){
  return c / (1.0 + max(c, vec3(0.0)) * uReflKnee);
}

// The sea at range is a grazing mirror, but it is NOT the sky. Two reasons, and
// both of them are the horizon line:
//   * a grazing reflection at distance d does not sample the sky at the horizon,
//     it samples it a couple of degrees UP, where the sky is darker and more
//     saturated. Lifting the reflected ray is the whole trick.
//   * water swallows a few percent of what it reflects, and the swell scatters
//     the rest, so the far sea sits under the sky it mirrors.
// The old code returned the horizon sky verbatim past uFarCut, which is exactly
// why the critics measured no horizon at all — the sea and the sky were the
// same pixels by construction.
vec3 seaHorizon(vec3 V){
  vec3 R = normalize(vec3(-V.x, max(V.y, 0.012) + 0.058, -V.z));
  return reflLimit(skyColour(R)) * uSeaTint;
}

// Water fades into haze at range and resolves onto that horizon sea colour —
// never all the way, so the band above the waterline keeps a value of its own.
vec3 hazeFade(vec3 col, vec3 sea, float dist){
  float fg = 1.0 - exp(-pow(dist * uFogDensity, 2.0));
  fg = min(fg, 0.82);
  return mix(col, mix(uFogCol, sea, fg), fg);
}

// A statistical sun road. Past a few hundred metres a single wave is far under
// a pixel, so the correct model is not "how bright is this facet" but "what
// fraction of the facets in this pixel point at the sun" — a GGX lobe over the
// rms wave slope. That is what turns the specular into a broken, glittering
// road instead of the smooth pastel smear the critics measured.
// THE MISSING HALF OF THE MICROFACET TERM. This returned D alone. A microfacet
// specular is D * G / (4 NdotL NdotV) — and the part that was missing is not a
// constant the gain can absorb, it is 1/(4 NdotL NdotV), which is ~1 when you
// look down at water and 20-30 when you look ALONG it. It was being dropped
// exactly where a sun road lives. Measured on wave-H's 03-coast, road peak over
// the sea 400 px to its left: 2.53x at 133 m, 1.56x at 261 m, 1.24x at 821 m —
// the road faded out towards the horizon, which is backwards. On a real sunset
// sea the road is WIDEST and brightest running away from you, because the
// grazing geometry factor grows faster than the lobe broadens.
//
// Smith height-correlated visibility carries that denominator and stays finite
// at grazing (the shadowing of one facet by the next is what tames it), so this
// is the standard, well-behaved form rather than a hand-clamped 1/(4 nl nv).
// slopeRms is the rms surface slope, so a = slopeRms^2 is GGX's alpha^2.
float sunRoad(vec3 N, vec3 V, float slopeRms){
  vec3 H = normalize(uSunDir + V);
  float ndh = max(dot(N, H), 0.0);
  float ndv = max(dot(N, V), 1e-3);
  float ndl = max(dot(N, uSunDir), 0.0);
  float a = clamp(slopeRms * slopeRms, 1e-4, 1.0);
  float dnm = ndh * ndh * (a - 1.0) + 1.0;
  float D = a / (3.14159265 * dnm * dnm);
  float gv = ndl * sqrt(ndv * ndv * (1.0 - a) + a);
  float gl = ndv * sqrt(ndl * ndl * (1.0 - a) + a);
  float vis = 0.5 / max(gv + gl, 1e-5);
  return D * vis * ndl;
}

// Reflection occlusion: march the reflected ray across the land field so bays
// reflect their own headlands instead of an empty sky.
float landOcclusion(vec3 P, vec3 R, float dist){
  if (dist > 900.0) return 0.0;
  float occ = 0.0;
  float d = 30.0;
  for (int i = 0; i < 3; i++){
    float hh = fieldAt(P.xz + R.xz * d).x;
    occ = max(occ, smoothstep(-1.5, 4.5, hh - (P.y + R.y * d)));
    d *= 3.7;
  }
  return occ * (1.0 - smoothstep(600.0, 900.0, dist));
}

// The river needs the SAME idea at a hundredth of the scale. landOcclusion's
// first sample is 30 m out and its last is 411 m; a 46-unit channel with banks
// 20 m away is entirely inside its first step, so every river fragment came
// back occ = 0 and reflected nothing but open sky. That is why the river
// graded as "a thin flat grey-white ribbon with no depth, no reflection and no
// bank" — it was literally a sheet of sky colour. These steps (1.6 → 57 m)
// straddle the bank.
float bankOcclusion(vec3 P, vec3 R){
  float occ = 0.0;
  float d = 1.6;
  for (int i = 0; i < 5; i++){
    float hh = fieldAt(P.xz + R.xz * d).x;
    occ = max(occ, smoothstep(-0.30, 1.30, hh - (P.y + R.y * d)));
    d *= 2.45;
  }
  return occ;
}

`;

// uWaveA = (dir.x*k, dir.y*k, omega, amplitude)
// uWaveB = (dir.x, dir.y, k*amplitude, Q*amplitude)
const GERSTNER = `
uniform vec4 uWaveA[6];
uniform vec4 uWaveB[6];

// BAND-LIMITING. This closed form is re-evaluated PER PIXEL, and a closed form
// has no mip chain: past the range where one pixel covers half a wavelength the
// phase dot(A.xy, p) jumps by many radians between neighbouring pixels and the
// normal it returns is white noise, not a wave. That noise then goes through
// Fresnel and a cube-map reflection lookup, both of which are violently
// non-linear at grazing angles, and lands on screen as a per-pixel stipple over
// the entire sea. It was measured, not guessed: forcing N = +Y in this shader
// dropped the ocean's high-frequency energy from 3.9/7.4 to 0.96/1.13 LSB rms
// (far/mid bands of the coast frame) while nothing else in the stack moved it —
// post grain, SSAO and DOF each changed it by under 0.5 LSB.
//
// So each component is faded out as its wavelength falls under the pixel
// footprint fp (world metres per pixel, from the screen-space derivatives of
// the plan position), and the mean-square
// slope it carried is handed back through sigma2. The sun road is a GGX lobe
// over exactly that quantity, so the glitter a component stops drawing
// geometrically it keeps contributing statistically — the energy moves from the
// normal into the roughness instead of vanishing. Pass fp = 0.0 from the vertex
// stage, where there is no pixel and nothing to filter.
void gerstner(vec2 p, float t, float amp, float shortFade, float fp,
              out vec3 disp, out vec3 nrm, out float jac, out float sigma2){
  disp = vec3(0.0);
  vec3 n = vec3(0.0, 1.0, 0.0);
  float jxx = 0.0, jzz = 0.0, jxz = 0.0;
  sigma2 = 0.0;
  const float Q = 0.55;
  const float INV_TAU = 0.15915494;
  for (int i = 0; i < 6; i++){
    vec4 A = uWaveA[i];
    vec4 B = uWaveB[i];
    float sc = amp * mix(1.0, shortFade, clamp((float(i) - 1.0) * 0.25, 0.0, 1.0));
    // fp * k / 2pi is the pixel footprint measured in wavelengths. The point
    // sample stops meaning anything well before the Nyquist limit of 0.5,
    // because what a pixel needs is the AVERAGE of the shading over its
    // footprint and the shading — Fresnel, then a cube-map fetch — is sharply
    // non-linear in the normal. Measured by eye at 1080p on the coast frame:
    // fading out over 0.18..0.50 still stippled, 0.07..0.26 is clean and still
    // keeps every swell line the sea had.
    float kmag = max(length(A.xy), 1e-5);
    float nf = 1.0 - smoothstep(0.07, 0.26, fp * kmag * INV_TAU);
    float kAfull = B.z * sc;
    // Mean square slope of a single component of amplitude a, wavenumber k, is
    // (a k)^2 / 2 — hand back the part that just got filtered away.
    sigma2 += 0.5 * kAfull * kAfull * (1.0 - nf * nf);
    sc *= nf;
    float ph = dot(A.xy, p) - A.z * t;
    float S = sin(ph), C = cos(ph);
    float kA = B.z * sc;
    float QA = B.w * sc;
    disp.xz += B.xy * (QA * C);
    disp.y  += A.w * sc * S;
    n.x -= B.x * kA * C;
    n.z -= B.y * kA * C;
    n.y -= Q * kA * S;
    jxx += Q * B.x * B.x * kA * S;
    jzz += Q * B.y * B.y * kA * S;
    jxz += Q * B.x * B.y * kA * S;
  }
  nrm = normalize(n);
  jac = (1.0 - jxx) * (1.0 - jzz) - jxz * jxz;
}
`;

// ---------------------------------------------------------------------------
// Ocean shaders
// ---------------------------------------------------------------------------
const OCEAN_VERT = COMMON + GERSTNER + `
uniform vec2  uCenter;
uniform float uWindStr;

varying vec3  vWorld;
varying vec2  vP;
varying float vDist;
varying float vKill;

void main(){
  vec2 p = position.xz + uCenter;
  vec4 f = fieldAt(p);
  float terr = f.x;
  float sd   = f.y;

  // Flag geometry that sits well inland so the fragment stage bails immediately.
  vKill = step(uSeaLevel + 3.4, terr);

  float depth = max(0.0, uSeaLevel - terr);
  float fetch = smoothstep(0.0, 230.0, -sd);
  float shoal = 1.0 + 0.85 * smoothstep(17.0, 3.5, depth);
  float amp = uWindStr * (0.55 + 0.45 * fetch) * shoal * smoothstep(0.15, 2.6, depth);

  vec3 probe = vec3(p.x, uSeaLevel, p.y);
  float dist = distance(probe, cameraPosition);
  float shortFade = 1.0 - smoothstep(160.0, 1100.0, dist);

  vec3 disp, nrm; float jac, sigma2;
  // fp = 0: a vertex has no pixel footprint, so the geometry keeps every
  // component. Only the per-pixel evaluation in the fragment stage is filtered.
  gerstner(p, uTime, amp, shortFade, 0.0, disp, nrm, jac, sigma2);

  vec2 wp = p + disp.xz * fetch;
  float level = uSeaLevel + disp.y;

  // Climb the beach so the swash can actually run over sand. Clamped so the
  // sheet never rides more than a couple of metres above the still line.
  float y = level;
  if (terr > uSeaLevel - 1.3){
    y = max(level, min(terr + 0.05, uSeaLevel + 2.7));
  }

  vec3 wpos = vec3(wp.x, y, wp.y);
  vWorld = wpos;
  vP = p;
  vDist = distance(wpos, cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * vec4(wpos, 1.0);
}
`;

const OCEAN_FRAG = COMMON + FRAG_LIB + GERSTNER + `
uniform float uWindStr;
uniform vec2  uWindDir;
uniform vec3  uDeep;
uniform vec3  uShallow;
uniform vec3  uBedNear;
uniform vec3  uBedFar;
uniform vec3  uFoamCol;
uniform vec3  uWetSand;
uniform vec3  uScatter;

varying vec3  vWorld;
varying vec2  vP;
varying float vDist;
varying float vKill;

void main(){
  // No discard anywhere: the ocean grid covers the whole screen and losing early
  // depth rejection here costs more than everything else in the shader combined.
  if (vKill > 0.995) { gl_FragColor = vec4(0.0); return; }
  if (vDist > uFarCut) {
    // The cheap path, but not a different-looking one: same horizon sea colour
    // the near path converges on, and the sun road carries straight through it.
    // A hard change of shading model at a fixed radius drew a horizontal seam
    // right across the ocean, which is what the critics saw near the horizon.
    vec3 fv = normalize(cameraPosition - vWorld);
    vec3 sea = seaHorizon(fv);
    float glint = sunRoad(vec3(0.0, 1.0, 0.0), fv, 0.155 * (0.72 + 0.55 * uWindStr));
    vec3 col = sea + uSunCol * uSunI * glint * uSunGain * 1.30;
    // THE HORIZON. What used to be here was
    //     mix(col, skyColour(...), smoothstep(4200.0, 5900.0, vDist))
    // and that single line is why four waves of critics measured no horizon at
    // all: on a flat sea at eye height the horizon IS ~8 km away, so the last
    // 1700 m of the grid — every pixel within half a degree of the skyline —
    // was being replaced by literal sky. Measured on wave-F's 03-coast, the
    // biggest row-to-row luminance step anywhere across the sky/sea boundary
    // was 6.4 LSB, i.e. a ramp, not an edge.
    //
    // The thing that genuinely has to be hidden is the far EDGE of the ocean
    // grid, and that is angular, not radial: the edge sits
    // atan(eyeHeight / OCEAN_REACH) below horizontal — 0.4 px at the shoreline,
    // ~40 px from the summit. Fading across a window keyed to THAT angle is
    // sub-pixel down at the water (so the skyline stays a hard step) and a soft
    // resolve from a clifftop (so the grid still never draws its own edge).
    //
    // uEdgeDist, NOT OCEAN_REACH. The grid is built out to 8192 m but the
    // camera's far plane is 6000, so the ocean is CLIPPED 2.2 km short of its
    // own rim and the fade — keyed to 8192 — was only 85% done where the clip
    // fell. Measured on wave-H's isolated sea: a 1-2 px crenellated picket line
    // right along row 313, which is exactly atan(10.49/6000) below the horizon.
    // Keying the window to the distance the grid actually reaches puts the fade
    // at 100% on the last drawn row, so the grid can never draw its own edge.
    float ang = max(cameraPosition.y - vWorld.y, 0.0) / max(vDist, 1.0);
    float angEdge = max(cameraPosition.y - uSeaLevel, 1.0) / max(uEdgeDist, 1.0);
    float edgeFade = smoothstep(angEdge * 2.05, angEdge * 1.00, ang);
    col = mix(col, skyColour(vec3(-fv.x, max(fv.y, 0.012), -fv.z)), edgeFade);
    gl_FragColor = vec4(col, 1.0);
    return;
  }

  vec4 f = fieldAt(vWorld.xz);
  float terr = f.x;
  float sd   = f.y;
  vec2  grad = f.zw;
  float gm   = max(length(grad), 0.0035);
  vec2  upSlope = grad / gm;               // points inland
  vec2  alongShore = vec2(-upSlope.y, upSlope.x);

  // ---- swash ---------------------------------------------------------------
  float phase = texture2D(uNoise, vWorld.xz * 0.00082).b;
  float travel = dot(vWorld.xz, alongShore) * 0.0038;
  float cyc = fract(uTime * 0.132 + phase * 3.1 + travel);
  float rise = pow(clamp(cyc / 0.26, 0.0, 1.0), 0.55);
  float fall = pow(clamp(1.0 - (cyc - 0.26) / 0.74, 0.0, 1.0), 1.9);
  float run = mix(fall, rise, step(cyc, 0.26));
  float setAmp = 0.58 + 0.42 * sin(uTime * 0.21 + phase * 13.0);
  float bayVar = texture2D(uNoise, vWorld.xz * 0.0043 + 0.19).b;
  float runLen = clamp(15.0 / (gm * 17.0 + 0.55), 3.0, 38.0) * (0.55 + 0.85 * bayVar);
  // The wash line is never straight: perturb it in signed-distance space so the
  // foam edge is lacy instead of a drawn contour.
  float jagA = texture2D(uNoise, vWorld.xz * 0.085 + upSlope * uTime * 0.16).b;
  float jagB = texture2D(uNoise, vWorld.xz * 0.31 - upSlope * uTime * 0.06).b;
  float jag = (jagA - 0.5) * 2.0 + (jagB - 0.5) * 1.1;
  float washEdge = runLen * run * setAmp + jag * (1.1 + runLen * 0.16);
  float wetEdge  = runLen * 0.70 + jag * 0.9;

  float cover = smoothstep(washEdge, washEdge - 0.85, sd);
  float wet   = clamp((wetEdge - sd) / 2.6, 0.0, 1.0) * (1.0 - cover);
  if (cover + wet < 0.012) { gl_FragColor = vec4(0.0); return; }

  // ---- surface -------------------------------------------------------------
  float depth0 = max(0.0, uSeaLevel - terr);
  float fetch = smoothstep(0.0, 230.0, -sd);
  float amp = uWindStr * (0.55 + 0.45 * fetch)
            * (1.0 + 0.85 * smoothstep(17.0, 3.5, depth0))
            * smoothstep(0.15, 2.6, depth0);
  float shortFade = 1.0 - smoothstep(160.0, 1100.0, vDist);

  // World metres covered by one pixel of this fragment. At 20 m of eye height
  // and a 45-degree fov this is ~0.8 m at 145 m out and ~16 m at 660 m, which is
  // the whole reason the analytic waves have to be band-limited before they are
  // sampled. Per screen axis, and the LENGTH of each: fwidth() gives the two
  // WORLD axes separately, which understates a footprint that runs diagonally
  // across the swell — and diagonal is the usual case, since the camera almost
  // never looks straight down a wave train.
  float fp = max(max(length(dFdx(vP)), length(dFdy(vP))), 1e-4);

  vec3 disp, N; float jac, sigma2;
  gerstner(vP, uTime, amp, shortFade, fp, disp, N, jac, sigma2);
  float level = uSeaLevel + disp.y;
  float depth = max(level - terr, 0.0);

  vec4 nA = texture2D(uNoise, vWorld.xz * 0.049 + uWindDir * uTime * 0.016);
  vec4 nB = texture2D(uNoise, vWorld.xz * 0.0158 - uWindDir * uTime * 0.0062);
  vec4 nC = texture2D(uNoise, vWorld.xz * 0.150 + upSlope * uTime * 0.30);
  vec4 nD = texture2D(uNoise, vWorld.xz * 0.104 - upSlope * uTime * 0.12 + 0.37);

  float chopFade = 1.0 - smoothstep(70.0, 460.0, vDist);
  float chop = chopFade * uWindStr * (0.15 + 0.42 * fetch) * smoothstep(0.10, 1.8, depth0);
  N.x += ((nA.r - 0.5) * ${(1.9 * OCEAN_CHOP_FIX).toFixed(4)} + (nB.r - 0.5) * ${(1.2 * OCEAN_CHOP_FIX).toFixed(4)}) * chop;
  N.z += ((nA.g - 0.5) * ${(1.9 * OCEAN_CHOP_FIX).toFixed(4)} + (nB.g - 0.5) * ${(1.2 * OCEAN_CHOP_FIX).toFixed(4)}) * chop;
  N = normalize(N);

  vec3 V = normalize(cameraPosition - vWorld);
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float shallowT = smoothstep(9.0, 0.3, depth);
  // Bright sand under thin water throws back enough light to fight the mirror,
  // which is exactly why a shoal reads jade while the channel stays indigo.
  float F = (0.02 + 0.86 * pow(1.0 - ndv, 5.0)) * mix(1.0, 0.46, shallowT);

  // ---- body: indigo at depth, jade in the shallows, seabed showing through --
  // A slower ramp, so the shelf actually spends some metres in the jade before
  // it commits to indigo. At 0.15 the transition happened inside the surf line
  // and the whole offshore read as one colour.
  vec3 body = mix(uShallow, uDeep, 1.0 - exp(-depth * 0.085));
  float clarity = exp(-depth * 0.55);
  vec3 bedCol = mix(uBedNear, uBedFar, smoothstep(0.0, 3.5, depth));
  body = mix(body, bedCol, clarity * 0.72);
  body *= 1.0 + 0.55 * shallowT * uSunI;

  // Caustics: two counter-drifting filament fields multiplied together. They
  // brighten the SEABED, so they fade out exactly as fast as the bed does.
  float caus = pow(max(nC.a * nD.a, 0.0), 1.7);
  vec3 causCol = mix(vec3(dot(uSunCol, vec3(0.30, 0.59, 0.11))), uSunCol, 0.5);
  body += causCol * uSunI * caus * smoothstep(5.0, 0.4, depth)
        * smoothstep(0.12, 0.85, depth) * clarity * 0.34;

  // Subsurface: crests glow when the sun is on the far side of the wave.
  float crest = clamp(disp.y * 1.6 + 0.22, 0.0, 1.0);
  float through = pow(clamp(-dot(V, uSunDir) * 0.5 + 0.5, 0.0, 1.0), 3.0);
  body += uScatter * uSunI * crest * through * 0.8 * smoothstep(0.5, 5.0, depth);
  body += uAmbient * 0.12;

  // ---- reflection ----------------------------------------------------------
  vec3 R = reflect(-V, N);
  R.y = max(R.y, 0.006);
  float occ = landOcclusion(vWorld, R, vDist);
  // The reflection loss is a property of the WATER, not of the distance: the
  // far path already multiplied its sky by uSeaTint (that is what puts the sea
  // under the sky at the horizon) while the near path reflected the sky at
  // 100%. The mid-field therefore mirrored a cream sky at full strength on the
  // crests and showed navy body in the troughs — opposite hue, opposite value,
  // alternating on the swell. That is the "marbled noodle-lines" the critics
  // kept naming. Applying the same loss at every range makes the sea one
  // material again.
  vec3 skyRefl = reflLimit(skyColour(R)) * uSeaTint;
  vec3 shore = mix(uLandRefl, uDeep, 0.34);
  vec3 refl = mix(skyRefl, shore, occ * 0.62);

  // ---- sun road ------------------------------------------------------------
  // Roughness grows with distance because more and more of the wave spectrum
  // falls under a pixel and has to be handled statistically instead of
  // geometrically. A fixed narrow lobe gave a smooth pastel smear; this gives
  // the broken glitter of a real sunset sea.
  vec3 H = normalize(uSunDir + V);        // the wet-sand sheen below wants it too
  // The roughness is no longer a hand-drawn ramp against distance — it IS the
  // mean square slope the band-limiter just took out of the normal, plus the
  // sub-component ripple that was never in the spectrum to begin with. Same
  // numbers at both ends as the old mix(0.035, 0.155, dist) it replaces
  // (0.044 near, ~0.19 at the horizon), but now it tracks the pixel footprint,
  // so the road broadens exactly where the facets stopped being resolvable
  // instead of at a distance somebody picked.
  // 0.035 was a millpond: a 2.0-degree rms facet slope puts the whole road
  // inside a couple of degrees of the mirror direction, so it died within a
  // hundred metres of the sun's own reflection instead of running all the way
  // in to the shore the way a real sunset road does. 0.052 rad rms (3.0 deg) is
  // the Cox-Munk slope for a light breeze and it roughly doubles the solid
  // angle the road covers.
  float baseRms = 0.052 * (0.72 + 0.55 * uWindStr);
  float slopeRms = clamp(sqrt(baseRms * baseRms + sigma2), 0.02, 0.34);
  // Sparkle: individual facets winking in and out. Sampled at a world scale
  // that stays above a pixel out to a kilometre, so it reads as glints rather
  // than as noise.
  float spk = texture2D(uNoise, vWorld.xz * 0.0125 + uWindDir * uTime * 0.010).b
            * texture2D(uNoise, vWorld.xz * 0.0037 - uWindDir * uTime * 0.004 + 0.29).b;
  float sparkle = 0.42 + 2.30 * smoothstep(0.16, 0.62, spk);
  // Soft ceiling on the road. Putting the grazing geometry factor back into
  // sunRoad made the hottest near-field flecks push past the white point:
  // measured over four captures of this pose, 0 / 0 / 32 / 53 pixels at
  // R,G or B = 255, all of them in rows 512-516 on the road at ~75 m, against
  // 0 in every capture of the build before. The project's standing constraint
  // is 0.000% clipped, so the lobe gets a saturating ceiling — which is also
  // what a real capture does to a specular highlight. It only bites on values
  // already far past white, so the road's shape and its contrast against the
  // sea are untouched.
  float spec = sunRoad(N, V, slopeRms) * sparkle;
  vec3 sun = uSunCol * uSunI * spec * (0.3 + 0.7 * F) * uSunGain;

  // The sun road is added AFTER the haze, at the bottom of the shader. Folding
  // it in here meant the haze ate 90% of it by a kilometre out, so the glitter
  // died exactly where the far path picked it up at full strength — the second
  // half of that horizontal seam.
  vec3 col = mix(body, refl, F);

  // ---- foam ----------------------------------------------------------------
  // A leading edge that tracks the swash, a trailing band that lingers on the
  // backwash, a breaking line where the bottom comes up, and whitecaps offshore.
  float lead = pow(1.0 - smoothstep(0.0, 1.3 + runLen * 0.16, abs(sd - washEdge)), 0.62);
  float trail = (1.0 - smoothstep(0.0, 7.0 + runLen * 1.0, washEdge - sd)) * mix(0.62, 0.18, run);
  float lace = (1.0 - smoothstep(0.0, 1.3, abs(sd))) * 0.45;   // standing water line
  float surfLine = smoothstep(1.6, 0.25, depth) * smoothstep(-0.35, 0.55, depth)
                 * (0.25 + 0.65 * setAmp);
  float caps = smoothstep(0.80, 0.30, jac) * fetch * uWindStr;
  float foam = max(max(lead * 1.15, trail), max(max(surfLine * 0.75, lace), caps));
  // High-contrast breakup: solid in the churn, torn to lace at the edges.
  float bk = nC.b * 0.42 + nD.b * 0.42 + jagB * 0.34 + 0.06;
  foam *= smoothstep(0.34, 0.88, bk) * 1.45;
  foam = clamp(foam, 0.0, 1.0) * cover;

  // Foam is a dense scatterer: it reads WHITE and only picks up a little of the
  // sun's hue, which is why a sunset shoreline still has a bright neutral edge.
  vec3 lit = uAmbient * 0.65 + uSunCol * uSunI * 0.85;
  vec3 foamLit = uFoamCol * mix(vec3(dot(lit, vec3(0.30, 0.59, 0.11))), lit, 0.42) * 1.05;
  col = mix(col, foamLit, foam);

  // ---- wet sand ------------------------------------------------------------
  vec3 wetLit = uWetSand * (uAmbient * 0.55 + uSunCol * uSunI * 0.35);
  float sheen = pow(max(dot(normalize(vec3(-grad.x * 0.3, 1.0, -grad.y * 0.3)), H), 0.0), 46.0);
  wetLit += uSunCol * uSunI * sheen * 0.30;
  float residue = clamp(nC.b * nD.b * 2.8 - 0.70, 0.0, 1.0) * (1.0 - run) * 0.75;
  wetLit = mix(wetLit, foamLit, residue);

  float wsum = max(cover + wet, 0.0001);
  vec3 outC = (col * cover + wetLit * wet) / wsum;

  float sheet = clamp(0.40 + (washEdge - sd) * 0.30, 0.40, 1.0);
  float alpha = cover * sheet + wet * 0.66;
  alpha = clamp(max(alpha, foam * 0.95), 0.0, 1.0);

  // Converge on the SAME horizon sea colour the far path uses, so the two meet
  // with nothing to see at the join.
  outC = hazeFade(outC, seaHorizon(V), vDist);
  outC += sun;
  gl_FragColor = vec4(outC, alpha);
}
`;

// ---------------------------------------------------------------------------
// River shaders
// ---------------------------------------------------------------------------
const RIVER_VERT = COMMON + `
attribute vec3 aFlow;
attribute vec3 aRiv;

varying vec3  vWorld;
varying float vDist;
varying float vSurf;
varying vec3  vFlow;
varying float vGate;

void main(){
  vec3 p = position;
  vec2 fd = aFlow.xy;
  float sp = aFlow.z;
  float rip = sin(dot(p.xz, fd) * 0.85 - uTime * (1.4 + sp * 1.9)) * 0.035 * sp
            + sin(dot(p.xz, vec2(-fd.y, fd.x)) * 0.42 + uTime * 0.7) * 0.02;
  p.y += rip;
  vWorld = p;
  vSurf = aRiv.y;
  vFlow = aFlow;
  vGate = aRiv.z;
  vDist = distance(p, cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const RIVER_FRAG = COMMON + FRAG_LIB + `
uniform vec3 uRivShallow;
uniform vec3 uRivDeep;
uniform vec3 uRivBed;
uniform float uRivGlint;
uniform float uRivBankD;
uniform float uBedLit;
uniform float uBedGain;
uniform vec3 uFoamCol;

varying vec3  vWorld;
varying float vDist;
varying float vSurf;
varying vec3  vFlow;
varying float vGate;

// One flow-aligned ripple layer, band-limited by the pixel footprint exactly
// the way the ocean's Gerstner components are. fp is world metres per pixel and
// L is the layer's dominant feature size in metres; past fp/L ~ 0.26 the point
// sample is meaningless and the layer has to be handed to the roughness
// instead, or it aliases. (The ocean's band-limiter fixed a stipple that took
// three attempts to find; adding unfiltered river detail would have walked
// straight back into it, so the new fine layer is filtered on the same curve.)
// The slope argument is the layer's rms surface slope IN RADIANS: the R/G rms is
// the measured NRM_RMS, so dividing by it makes the parameter mean something.
vec3 ripple(vec2 uv, float L, float slope, float fp, inout float sigma2){
  float nf = 1.0 - smoothstep(0.07, 0.26, fp / L);
  sigma2 += 0.5 * slope * slope * (1.0 - nf * nf);
  float g = slope * nf * ${(1 / NRM_RMS).toFixed(4)};
  vec4 t = texture2D(uNoise, uv);
  return vec3((t.r - 0.5) * g, (t.g - 0.5) * g, t.b);
}

void main(){
  // Below sea level the ocean owns this water; where the carve never cut a real
  // trench there is no river to draw.
  // discard, NOT a transparent write. The no-discard rule is an OCEAN rule: that
  // grid covers the whole screen and losing early-Z there costs more than the
  // whole shader. The river covers 8% of the river-valley frame (measured by
  // flat-shading the ribbon and counting), so it can afford to discard — and it
  // has to, because the material now writes depth and a transparent write would
  // punch a hole in the valley.
  if (vSurf < 0.75 || vGate < 0.02) discard;
  if (vDist > uFarCut) discard;

  vec4 f = fieldAt(vWorld.xz);
  float depth = vSurf - f.x;
  if (depth < 0.035) discard;

  vec2 fd = normalize(vFlow.xy + vec2(1e-5));
  float sp = vFlow.z;
  vec2 side = vec2(-fd.y, fd.x);
  float along = dot(vWorld.xz, fd);
  float across = dot(vWorld.xz, side);

  float fp = max(max(length(dFdx(vWorld.xz)), length(dFdy(vWorld.xz))), 1e-4);
  float sigma2 = 0.0;

  // THREE flow-aligned layers now, not two. The old pair topped out at ~1.5 m
  // features, and at the river pose the near water is 9 m away and 0.9 m below
  // the eye: a 1.5 m ripple at that grazing angle is nearly a flat mirror, so
  // the surface returned one undifferentiated sheet of sky. The 0.4 m layer is
  // what actually breaks the reflection up into water.
  // FOUR layers, spanning 0.4 m chop to 9 m glides, each one band-limited on the
  // same curve as the ocean's Gerstner components. Two reasons for the spread:
  // the fine layers are what break the reflection up close, and the 9 m layer is
  // the only one that survives the pixel footprint past ~60 m, so without it the
  // mid-river collapses back to a perfect mirror the moment the others fade.
  float amp = 0.95 + 0.70 * sp;
  vec3 l1 = ripple(vec2(along * 0.115 - uTime * sp * 0.20, across * 0.30),
                   1.45, 0.085 * amp, fp, sigma2);
  vec3 l2 = ripple(vec2(along * 0.048 - uTime * sp * 0.085, across * 0.135) + 0.41,
                   3.50, 0.065 * amp, fp, sigma2);
  vec3 l3 = ripple(vec2(along * 0.420 - uTime * sp * 0.62, across * 0.86) + 0.13,
                   0.40, 0.105 * amp, fp, sigma2);
  vec3 l4 = ripple(vec2(along * 0.0185 - uTime * sp * 0.030, across * 0.052) + 0.77,
                   9.00, 0.045 * amp, fp, sigma2);
  vec2 slope = l1.xy + l2.xy + l3.xy + l4.xy;
  vec3 N = normalize(vec3(slope.x, 1.0, slope.y));

  vec3 V = normalize(cameraPosition - vWorld);
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  // Roughness-aware Fresnel. A mirror at 3 degrees of grazing returns 0.9 of
  // what it sees; a rippled surface at 3 degrees does not, because half its
  // facets are tilted away from the eye and are looking at the far bank
  // instead. Without this term the whole near reach pinned at F ~ 0.9 and
  // returned one undifferentiated sheet of sky.
  float rough = clamp(sqrt(0.5 * dot(slope, slope) + sigma2), 0.02, 0.45);
  float grazeMax = max(1.0 - 2.1 * rough, 0.12);
  float F = 0.02 + (grazeMax - 0.02) * pow(1.0 - ndv, 5.0);

  // ---- body: a real depth ramp, and a bed that only shows where it can ------
  vec3 body = mix(uRivShallow, uRivDeep, 1.0 - exp(-depth * 0.75));
  float clarity = exp(-depth * 1.15);
  // uBedGain: the bed albedo is a colour, and a sunlit gravel bar is brighter
  // than any 8-bit colour can say once it is being multiplied by a sun of
  // intensity 12.3 and then tonemapped. Bracketed at 1.0 / 2.0 / 3.2 / 5.0 on
  // this pose: river median luminance 66 / 72 / 78 / 91 against a bank of
  // 88 / 82 / 90 / 91. references/field_24.png has its stream at median L 24-33
  // against banks at 18-38 — the same value, not darker and not brighter — so
  // the ratio to aim at is 1.0 and 4.2 is where this lands.
  body = mix(body, uRivBed * uBedGain, clarity * 0.8);
  // THE BED WAS NEVER LIT. Everything above the waterline in this valley is lit
  // by a sun of intensity 12.3; the river's body was a raw albedo plus 0.14 of
  // ambient and nothing else — no uSunCol, no uSunI anywhere in the term. (The
  // ocean does not have this bug: it carries body *= 1.0 + 0.55*shallowT*uSunI.)
  // So a gravel bar under 15 cm of water rendered at its texture value while the
  // bank 2 m away rendered at 12x that, which is most of why the reach reads as
  // dull wet dirt rather than as sunlit shallow water. Light it, attenuated by
  // the round trip down through the column and back.
  float bedLit = exp(-depth * 0.85);
  vec3 lightOnBed = uAmbient * 0.60 + uSunCol * uSunI * (0.30 + 1.05 * bedLit);
  body *= mix(vec3(1.0), lightOnBed, uBedLit);

  float c1 = texture2D(uNoise, vec2(along * 0.30 - uTime * sp * 0.16, across * 0.34)).a;
  float c2 = texture2D(uNoise, vec2(along * 0.234 + uTime * sp * 0.09, across * 0.265 + uTime * 0.02)).a;
  float caus = pow(max(c1 * c2, 0.0), 1.7);
  vec3 causCol = mix(vec3(dot(uSunCol, vec3(0.30, 0.59, 0.11))), uSunCol, 0.5);
  body += causCol * uSunI * caus * smoothstep(2.2, 0.12, depth) * clarity * 0.40;
  body += uAmbient * 0.14;

  // ---- reflection: the BANK, not just the sky ------------------------------
  vec3 R = reflect(-V, N);
  R.y = max(R.y, 0.004);
  // Short march for the near bank, long march for the valley wall behind it.
  float occ = max(bankOcclusion(vWorld, R), landOcclusion(vWorld, R, vDist));
  // A rough surface returns the sky CONVOLVED with its slope distribution, not
  // a point sample of it, and past the footprint limit the geometric ripple is
  // gone but the roughness it left behind is not. Three taps spread by the rms
  // slope is a crude convolution, but it is the difference between "mirror" and
  // "water" on every reach the band-limiter has flattened.
  float spread = min(rough * 2.6, 0.30);
  vec3 skyRefl = reflLimit(( skyColour(R)
                 + skyColour(normalize(R + vec3(0.0, spread, 0.0)))
                 + skyColour(normalize(R - vec3(0.0, spread * 0.55, 0.0))) ) * ${(1/3).toFixed(6)}) * uSeaTint;
  // What a bank reflects is the bank: dark, and the same warm/cool the rest of
  // the land is graded to. Kept a shade under the land itself, because a
  // reflection off water always loses a little.
  vec3 bankRefl = mix(uLandRefl, uRivDeep, 0.30) * 0.85 + uAmbient * 0.06;
  vec3 refl = mix(skyRefl, bankRefl, occ * 0.95);

  // ---- sun glints ----------------------------------------------------------
  // A GGX lobe over the rms ripple slope, not pow(N.H, 420). The old exponent
  // was so tight that a perturbed normal missed the sun almost everywhere, so
  // the one thing the reference frame has on its stream — a hot broken sun
  // streak — never appeared at all.
  float slopeRms = clamp(rough, 0.03, 0.40);
  float glint = sunRoad(N, V, slopeRms);
  // Break it into moving flecks instead of a continuous sheen. The old window
  // was 0.30..0.72 over a field whose mean is ~0.65, so smoothstep returned
  // ~0.87 nearly everywhere and fleck sat at 2.06 out of a 2.30 maximum: a flat
  // sheen with the word "fleck" on it. Measured, the river carried 0.000% of
  // its pixels above L=200 while the reference stream's glint box is 5% above
  // L=249. A glint is SPARSE and HOT — mostly off, occasionally far past the
  // white point — so the window moves up into the tail of the field and the
  // gain goes up with it.
  float fleck = 0.18 + 6.20 * smoothstep(0.63, 0.90, l1.z * 0.55 + l3.z * 0.75);
  vec3 sun = uSunCol * uSunI * glint * fleck * (0.25 + 0.75 * F) * uSunGain * uRivGlint;

  vec3 col = mix(body, refl, F);

  // ---- foam / riffles / the bank line --------------------------------------
  // Both of these used to be gated on flow speed windows this reach never
  // enters: riffle needed sp > 0.5 and streak needed sp > 0.9, while the
  // river-valley reach runs at the 0.28 floor. So the near water carried NO
  // surface texture at all beyond the ripple normals — every foam term was
  // multiplied by zero. Slow water still shows drift lines and still breaks
  // white over a shallow bed; the gates now open at the speed floor.
  // THE RIVER WAS 41% WHITE PAINT. Measured on wave-H's 04-river-valley, over
  // the reach the pose actually looks at: median water depth 0.146 m, median
  // bank 0.352, median riffle 0.273, median foam 0.406 — and foamLit there
  // is (240,196,147). Compositing that over a body of (78,72,65) lands on
  // (144,123,99), which is within a couple of LSB of the (152,114,100) the
  // frame actually measured. That is the whole of "a thin flat grey-white
  // ribbon with no depth": not a missing reflection, not a missing ripple —
  // four tenths of a coat of white over the entire surface.
  //
  // Both gates were open at ankle depth: riffle broke white under 75 cm and
  // bank under 38 cm, and the reach the camera sees is a 15 cm margin running
  // out to a 1.5 m channel. Shallow water is not foam. Water goes white where
  // it is a few CENTIMETRES over stones or where it is genuinely fast; a quiet
  // shallow is a bright transparent sheet showing the bed, which is a different
  // colour and a different value, and that is what the depth ramp below is for.
  float riffle = smoothstep(0.17, 0.03, depth) * smoothstep(0.55, 1.60, sp);
  float bank   = smoothstep(uRivBankD, uRivBankD * 0.16, depth);
  float streak = clamp(l1.z * 2.3 - 1.15, 0.0, 1.0) * smoothstep(0.60, 1.60, sp) * 0.55;
  float foam = clamp(max(max(riffle * 0.90, bank * 0.70), streak), 0.0, 1.0);
  foam *= 0.35 + 0.95 * l2.z;
  vec3 lit = uAmbient * 0.65 + uSunCol * uSunI * 0.85;
  vec3 foamLit = uFoamCol * mix(vec3(dot(lit, vec3(0.30, 0.59, 0.11))), lit, 0.42) * 1.0;
  col = mix(col, foamLit, clamp(foam, 0.0, 1.0));

  // A dark wetted rim just inside the waterline. Without it the ribbon has no
  // edge at all and simply stops, which is most of why it read as a painted
  // stripe rather than as a channel with banks.
  float rim = smoothstep(0.30, 0.02, depth) * (1.0 - foam);
  col = mix(col, mix(uRivBed, uRivDeep, 0.55) * (0.45 + 0.55 * uSunI), rim * 0.55);

  // Opaque wherever there is real water. At 0.95 the terrain showed straight
  // through the channel and washed the whole ribbon toward the ground colour.
  float alpha = clamp(smoothstep(0.02, 0.22, depth) + foam * 0.6, 0.0, 1.0);
  alpha *= smoothstep(0.75, 1.35, vSurf) * vGate;
  if (alpha < 0.02) discard;

  col = hazeFade(col, skyRefl, vDist);
  col += sun;
  gl_FragColor = vec4(col, alpha);
}
`;

// ---------------------------------------------------------------------------
export function createWater(ctx) {
  const field = makeLandField();
  const noise = makeSurfaceNoise();

  // Live sky probe. Cheap: everything except the sky dome, cloud deck, stars and
  // the celestial sprites is hidden, shadows are frozen, and it only re-renders
  // every few frames.
  const skyRT = new THREE.WebGLCubeRenderTarget(128, {
    format: THREE.RGBAFormat, type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
  });
  const skyCam = new THREE.CubeCamera(10, 60000, skyRT);
  const hidden = [];
  function refreshSkyCube(c) {
    const scene = c.scene;
    const keep = c.sky ? [c.sky.sky, c.sky.clouds, c.sky.stars] : [];
    for (let i = 0; i < scene.children.length; i++) {
      const o = scene.children[i];
      if (!o.visible || o.isSprite || keep.indexOf(o) !== -1) continue;
      o.visible = false; hidden.push(o);
    }
    const prevShadow = c.renderer.shadowMap.autoUpdate;
    c.renderer.shadowMap.autoUpdate = false;
    const cp = c.camera.position;
    skyCam.position.set(cp.x, Math.max(cp.y, 3), cp.z);
    skyCam.updateMatrixWorld(true);
    skyCam.update(c.renderer, scene);
    c.renderer.shadowMap.autoUpdate = prevShadow;
    for (let i = 0; i < hidden.length; i++) hidden[i].visible = true;
    hidden.length = 0;
  }

  // Palette. Named colours only — never lerp hue between blue and orange.
  const P = {
    // deepWarm was #132c44 — a saturated navy. Under a cream golden-hour sky the
    // troughs read as BLUE PAINT next to the warm crests, which is half of the
    // "marbled noodle-lines" the sea kept grading as. Deep water at sunset is a
    // dark desaturated slate-teal; the colour in the frame should come from what
    // it mirrors, not from the pigment.
    deepDay: new THREE.Color('#0b2947'), deepWarm: new THREE.Color('#172a33'), deepNight: new THREE.Color('#04070f'),
    shalDay: new THREE.Color('#34ad9c'), shalWarm: new THREE.Color('#4bad8c'), shalNight: new THREE.Color('#06201d'),
    bedNearDay: new THREE.Color('#b9a172'), bedNearWarm: new THREE.Color('#cba167'), bedNight: new THREE.Color('#0a0f14'),
    bedFarDay: new THREE.Color('#4d7266'), bedFarWarm: new THREE.Color('#5d7055'),
    foamDay: new THREE.Color('#ffffff'), foamWarm: new THREE.Color('#fff1de'),
    wetDay: new THREE.Color('#6b5a3d'), wetWarm: new THREE.Color('#7a5a37'),
    scatterDay: new THREE.Color('#2fa889'), scatterWarm: new THREE.Color('#c98a3c'),
    zenDay: new THREE.Color('#5c8ed4'), zenWarm: new THREE.Color('#3a63ab'), zenNight: new THREE.Color('#0b1428'),
    landDay: new THREE.Color('#5a6749'), landWarm: new THREE.Color('#6e5c39'), landNight: new THREE.Color('#070a0c'),
    // Warm set measured against references/field_24.png, which is the same
    // shot this pose is trying to be: its stream reads hue 22-27 at saturation
    // 0.78-0.94 and a median luminance of 24-33, i.e. the SAME value as the
    // banks around it, not brighter. Wave-H's river measured hue 24 at sat 0.37
    // and L 100 against banks at L 84 — desaturated and a fifth brighter than
    // its own valley. The olive-green set below was most of the saturation
    // loss: a yellow-green bed under a warm amber grade averages out to grey.
    rivShalDay: new THREE.Color('#6f8f62'), rivShalWarm: new THREE.Color('#8a6a34'),
    rivDeepDay: new THREE.Color('#1b4038'), rivDeepWarm: new THREE.Color('#2b2318'),
    rivBedDay: new THREE.Color('#5c5333'), rivBedWarm: new THREE.Color('#7d4c1e'),
    ambDay: new THREE.Color('#9fbfe8'), ambWarm: new THREE.Color('#e0b48a'), ambNight: new THREE.Color('#0d1526'),
    // Reflection loss, per channel. The blue bias is real (the red end is
    // absorbed first) but at 0.72/0.79/0.90 it was only a 20% value cut with a
    // 25% hue swing, and under a cream golden-hour sky that reads as LAVENDER,
    // not as sea. Under a low sun the loss has to be mostly VALUE — the sea
    // sits well under the sky it mirrors — with only a light cool bias left.
    tintDay: new THREE.Color(0.70, 0.77, 0.90),
    tintWarm: new THREE.Color(0.55, 0.575, 0.66),
  };

  // Amplitudes roughly doubled from the first pass. The old set put a 0.9 m
  // amplitude on an 86 m swell — a steepness of 0.028, which is a millpond, and
  // it is why the sea graded as "a flat pastel wash with no wave geometry". The
  // total Gerstner steepness here is Q*sum(kA) = 0.35, well under the 1.0 where
  // the surface starts folding through itself.
  const WAVE_SPEC = [
    { L: 86, A: 1.55, spread: 0.00 },
    { L: 47, A: 0.95, spread: 0.34 },
    { L: 27, A: 0.50, spread: -0.52 },
    { L: 15.5, A: 0.260, spread: 0.78 },
    { L: 8.7, A: 0.130, spread: -0.95 },
    { L: 4.9, A: 0.060, spread: 1.35 },
  ];
  const waveA = [], waveB = [];
  for (let i = 0; i < 6; i++) { waveA.push(new THREE.Vector4()); waveB.push(new THREE.Vector4()); }

  const shared = () => ({
    uField: { value: field },
    uNoise: { value: noise },
    uFieldSpan: { value: FIELD_SPAN },
    uTime: { value: 0 },
    uSeaLevel: { value: SEA_LEVEL },
    uFarCut: { value: 2600 },
    uSunDir: { value: new THREE.Vector3(0, 0.2, 1) },
    uSunCol: { value: new THREE.Color('#ffcf94') },
    uSunI: { value: 1.0 },
    uSkyCube: { value: skyRT.texture },
    uLandRefl: { value: new THREE.Color('#47533a') },
    uFogCol: { value: new THREE.Color('#d9b48c') },
    uFogDensity: { value: 0.0016 },
    uAmbient: { value: new THREE.Color('#9fbfe8') },
    uFoamCol: { value: new THREE.Color('#ffffff') },
    // What a grazing reflection loses to the water, as a per-channel factor.
    // Cool, because the red end goes first. This IS the horizon line: without
    // it the sea and the sky are the same pixels by construction. Measured on
    // the summit frame at 960x540 with a 10% version of this, the sea was still
    // a featureless pale wash from the coast to the far shore — a low sun over
    // water has enormous dynamic range and the sea has to sit well under the
    // sky it mirrors before a horizon appears at all.
    uSeaTint: { value: new THREE.Color(0.72, 0.79, 0.90) },
    uSunGain: { value: 0.140 },
    // Reflection knee. Bracketed on 03-coast; see reflLimit() above.
    // WHAT THIS IS AND WHAT IT IS NOT. reflLimit is physically right (a rough
    // sea returns the sky convolved over its slope lobe and cannot return the
    // sun disc's peak radiance) and a same-session bracket at 0 / 0.06 / 0.12 /
    // 0.25 / 0.5 appeared to warm the mid sea from hue 346 to hue 19 and to open
    // the horizon. NEITHER OF THOSE SURVIVED A CONTROLLED MEASUREMENT. Three
    // captures of this build against two of the build before, with every box
    // re-aligned to each frame's own measured skyline row, put the 100-150 m sea
    // at hue 309.7 before and 306.7 after, and the sky-to-sea luminance drop at
    // 14.4% both times. The apparent win was the camera settling three rows
    // differently between two single captures — the same trap the shadow work
    // fell into, and worth restating: on this pose a metric keyed to a fixed
    // screen row is measuring the camera, not the water.
    //
    // It is kept at 0.12 for the ONE effect that did replicate, which is the
    // highlight budget: with it on, 7 of 7 captures of 03-coast have zero
    // pixels at 255; with it off, 1 of 5 had 50 (0.0024%), all of them on the
    // near sun road at ~78 m. Small sample, stated as such.
    uReflKnee: { value: 0.12 },
    // How far the ocean grid actually reaches on screen — the smaller of its
    // own radius and the camera's far plane. Written every frame in update().
    uEdgeDist: { value: OCEAN_REACH },
  });

  const oceanUniforms = Object.assign(shared(), {
    uCenter: { value: new THREE.Vector2() },
    uWindStr: { value: 1.0 },
    uWindDir: { value: new THREE.Vector2(0.82, 0.57) },
    uWaveA: { value: waveA },
    uWaveB: { value: waveB },
    uDeep: { value: new THREE.Color('#0a2647') },
    uShallow: { value: new THREE.Color('#1f9b90') },
    uBedNear: { value: new THREE.Color('#8f7b4e') },
    uBedFar: { value: new THREE.Color('#3d5c52') },
    uWetSand: { value: new THREE.Color('#6b5a3d') },
    uScatter: { value: new THREE.Color('#2fa889') },
  });

  const riverUniforms = Object.assign(shared(), {
    uRivShallow: { value: new THREE.Color('#6f8f62') },
    uRivDeep: { value: new THREE.Color('#1b4038') },
    uRivBed: { value: new THREE.Color('#5c5333') },
    uRivGlint: { value: 2.0 },
    uRivBankD: { value: 0.10 },
    uBedLit: { value: 1.0 },
    uBedGain: { value: 4.2 },
  });

  const oceanMat = new THREE.ShaderMaterial({
    vertexShader: OCEAN_VERT, fragmentShader: OCEAN_FRAG,
    uniforms: oceanUniforms, transparent: true, depthWrite: true, side: THREE.FrontSide,
  });
  // depthWrite was false, and that is why the river had no bank: grass rooted on
  // the channel bed drew straight over the surface, so the water never got an
  // edge — the ribbon just faded into the reeds. A surface you cannot see
  // through has to occlude what is under it. The fragment shader discards every
  // fragment that is not water, so this writes depth only where there IS water.
  const riverMat = new THREE.ShaderMaterial({
    vertexShader: RIVER_VERT, fragmentShader: RIVER_FRAG,
    uniforms: riverUniforms, transparent: true, depthWrite: true, side: THREE.FrontSide,
  });

  const ocean = new THREE.Mesh(makeOceanGeometry(), oceanMat);
  ocean.name = 'ocean';
  ocean.frustumCulled = false;
  ocean.renderOrder = 2;
  ocean.castShadow = false; ocean.receiveShadow = false;

  const river = new THREE.Mesh(makeRiverGeometry(), riverMat);
  river.name = 'river';
  river.renderOrder = 3;
  river.castShadow = false; river.receiveShadow = false;

  const group = new THREE.Group();
  group.name = 'water';
  group.add(ocean, river);

  const tmpA = new THREE.Color(), tmpB = new THREE.Color();
  const lerp = THREE.MathUtils.lerp;
  const smooth = THREE.MathUtils.smoothstep;
  const setBlend = (out, night, day, warm, dayT, warmT) => {
    tmpB.copy(day).lerp(warm, warmT);
    out.copy(night).lerp(tmpB, dayT);
  };

  let t = 0, cubeAge = 99;

  function update(dt, c, initial) {
    t += dt;
    const alt = THREE.MathUtils.clamp((c.tod ? c.tod.sunAltitude : 20) / 90, -1, 1);
    const day = smooth(alt, -0.12, 0.16);
    const warm = 1 - smooth(Math.max(alt, 0), 0.0, 0.45);

    const wind = c.wind;
    const wdir = wind ? wind.dir : { x: 0.82, y: 0.57 };
    const gust = wind ? wind.gust() * wind.strength : 0.8;
    const base = Math.atan2(wdir.y, wdir.x);

    for (let i = 0; i < 6; i++) {
      const s = WAVE_SPEC[i];
      const a = base + s.spread;
      const dx = Math.cos(a), dz = Math.sin(a);
      const k = 6.2831853 / s.L;
      const omega = Math.sqrt(9.81 * k);
      waveA[i].set(dx * k, dz * k, omega, s.A);
      waveB[i].set(dx, dz, k * s.A, 0.55 * s.A);
    }

    const sun = c.sky ? c.sky.sun : null;
    const sunI = sun ? THREE.MathUtils.clamp(sun.intensity / 3.6, 0.0, 1.35) : 1.0;

    for (const u of [oceanUniforms, riverUniforms]) {
      u.uTime.value = t;
      u.uSunI.value = sunI;
      if (c.sky) {
        u.uSunDir.value.copy(c.sky.sunPos);
        u.uSunCol.value.copy(c.sky.sun.color);
      }
      if (c.scene.fog) {
        const d = c.scene.fog.density;
        u.uFogCol.value.copy(c.scene.fog.color);
        u.uFogDensity.value = d;
        // Past this the fog is total, so the water is exactly the fog colour and
        // there is nothing left to compute — which is also what makes the join
        // at the horizon seamless.
        // Past this the haze has fully resolved into the horizon sky, so all
        // that is left to do is sample it.
        u.uFarCut.value = 3.60 / Math.max(d, 1e-5);
      }
      // The far plane clips the ocean grid long before its own rim; the edge
      // fade has to know where the sea really stops or it draws a picket line.
      u.uEdgeDist.value = Math.min(OCEAN_REACH, (c.camera.far || OCEAN_REACH) * 0.995);
      setBlend(u.uLandRefl.value, P.landNight, P.landDay, P.landWarm, day, warm);
      setBlend(u.uAmbient.value, P.ambNight, P.ambDay, P.ambWarm, day, warm);
      u.uFoamCol.value.copy(P.foamDay).lerp(P.foamWarm, warm);
      u.uSeaTint.value.copy(P.tintDay).lerp(P.tintWarm, warm);
    }

    setBlend(oceanUniforms.uDeep.value, P.deepNight, P.deepDay, P.deepWarm, day, warm);
    setBlend(oceanUniforms.uShallow.value, P.shalNight, P.shalDay, P.shalWarm, day, warm);
    setBlend(oceanUniforms.uBedNear.value, P.bedNight, P.bedNearDay, P.bedNearWarm, day, warm);
    setBlend(oceanUniforms.uBedFar.value, P.bedNight, P.bedFarDay, P.bedFarWarm, day, warm);
    setBlend(oceanUniforms.uWetSand.value, P.bedNight, P.wetDay, P.wetWarm, day, warm);
    tmpA.copy(P.scatterDay).lerp(P.scatterWarm, warm);
    oceanUniforms.uScatter.value.copy(tmpA).multiplyScalar(lerp(0.05, 1.0, day));
    setBlend(riverUniforms.uRivShallow.value, P.deepNight, P.rivShalDay, P.rivShalWarm, day, warm);
    setBlend(riverUniforms.uRivDeep.value, P.deepNight, P.rivDeepDay, P.rivDeepWarm, day, warm);
    setBlend(riverUniforms.uRivBed.value, P.bedNight, P.rivBedDay, P.rivBedWarm, day, warm);

    oceanUniforms.uWindStr.value = 0.55 + 0.75 * gust;
    oceanUniforms.uWindDir.value.set(wdir.x, wdir.y);

    const cam = c.camera.position;
    oceanUniforms.uCenter.value.set(cam.x, cam.z);

    if (!initial && ++cubeAge >= 8) { cubeAge = 0; refreshSkyCube(c); }
  }

  update(0, ctx, true);

  return {
    mesh: group, group, ocean, river,
    field, seaLevel: SEA_LEVEL, skyProbe: skyRT.texture,
    update,
  };
}
