import * as THREE from 'three';
import { heightAt, ISLAND } from './terrain.js';
import { fbm } from '../util/noise.js';
import { mulberry32 } from '../util/rng.js';
import { WIND_UNIFORMS_GLSL, WIND_GLSL } from './wind.js';

// OWNER: vfx lane. Atmospheric particulate — valley haze, drifting maple
// leaves, cherry petals, sun-caught dust, pollen over grassland, fireflies at
// dusk and embers over fire.
//
// Design
// ------
// * Nothing is stepped on the CPU. A particle's position is a closed-form
//   function of (base position, time) evaluated in the vertex shader, so a
//   layer is one draw call, one instanced quad, and zero per-frame JS.
// * Every layer lives in a cell that rides the camera and wraps with mod(), so
//   the air is populated wherever you stand at a fixed, bounded particle count.
//   The wrap seam is hidden behind a radial fade.
// * A baked island field carries terrain height, forest mask, meadow mask and
//   a valley/mist factor. The vertex shader reads it to sit particles on the
//   ground and to vary density by biome; heights come straight from
//   terrain.heightAt so nothing can disagree about where the ground is.
// * All motion is driven by ctx.wind, and by nothing else. The gust front is
//   not a lookalike of the grass wave, it is literally windGust() out of
//   wind.js compiled into this shader, with wind.js's uniform block attached
//   by reference. See the contract at the top of wind.js.
// * Horizontal advection is INTEGRATED on the CPU into a per-layer uDrift, not
//   recomputed as speed*t. See the comment at the advection block below: the
//   old form made every particle ride an arm that grew for the whole session.
//
// What went wrong the first time, and what fixes it
// -------------------------------------------------
// 1. A hard minimum screen size (`if px < minPx then grow`) kept every distant
//    mote at full brightness on a 2px quad. Result: uniform speckle over the
//    entire frame — confetti. Now the size floor is energy conserving: growing
//    a sprite by 1/s costs alpha s*s, so sub-pixel particles fade out instead
//    of persisting.
// 2. Forward scatter was an unbounded `sunColor * pow(dot,5) * 2.6`, which for
//    anything near the sun landed at ~4x white and bloomed into a hard dot.
//    Now scatter is a bounded Henyey-Greenstein lobe and every layer clamps its
//    peak radiance, so backlit particles glow instead of blowing out.
// 3. Leaves carried `emissive` and read as luminous orange flowers. Airborne
//    leaves are lit objects: dark warm bodies that go translucent when the sun
//    is behind them. No emissive on anything that is not literally on fire.
// 4. Particles were uniform random, so they blanketed the frame evenly. They
//    are now scattered in clusters, so the air has drifts and clear pockets.
// 5. WAVE G. The airborne leaves still read as "lens dirt or dead pixels":
//    dark five-lobed sprites strewn to the top of the sky, isotropic, sharing
//    no direction with the grass under them. Three separate causes, each
//    measured on the running lane before it was touched — see the block
//    comments at each site:
//      * the sky mask was pitch-blind and its upper edge was unreachable, so
//        the sprites over the sky were masked by 2.7%, not by 100%;
//      * hg() is peak-normalised, so phaseG 0.72 made the backlight lobe so
//        tight it ran at 0.134 across the whole frame — the transmission that
//        is supposed to make a leaf glow was effectively switched off — and it
//        was multiplied by an albedo whose green is a sixteenth of its red;
//      * nothing in the layer carried the wind's direction into SCREEN space,
//        so a frame of it had no common axis at all.
//    And the "lens-flare ghost orbs in clear sky far from the sun" reported
//    against wave F are this file's own dust and pollen: uncapped in screen
//    size, they draw 37 px and 63 px discs a couple of metres from the lens.
//    Both layers now carry a screen-size ceiling and the sky mask.

const SEA = ISLAND.seaLevel;
const MAX_FIRES = 6;

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
function sstep(x, e0, e1) { const t = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1); return t * t * (3 - 2 * t); }

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

// Feather the ALPHA channel only (never the shading mask) with a small
// separable box blur. Canvas polygon fill antialiases over about one canvas
// pixel; a 96 px leaf drawn 80 px wide on screen therefore arrives with a
// silhouette barely one screen pixel wide, which is what critics read as
// "stair-stepped alpha" and "hard-edged solid quad". Blurring the alpha by a
// couple of texels costs nothing and gives magnified sprites a real edge.
function featherAlpha(c, radius = 2) {
  const g = c.getContext('2d');
  const S = c.width, img = g.getImageData(0, 0, S, S), d = img.data;
  const src = new Float32Array(S * S), tmp = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) src[i] = d[i * 4 + 3];
  const w = radius * 2 + 1;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) s += src[y * S + clamp(x + k, 0, S - 1)];
      tmp[y * S + x] = s / w;
    }
  }
  for (let x = 0; x < S; x++) {
    for (let y = 0; y < S; y++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) s += tmp[clamp(y + k, 0, S - 1) * S + x];
      d[(y * S + x) * 4 + 3] = s / w;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

function texFromCanvas(c) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;      // these are masks, not colour art
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 2;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

/* ------------------------------------------------------------------ *
 * procedural sprite art  (RGB = shading mask, A = silhouette)
 * ------------------------------------------------------------------ */

// Five-lobed maple. r(t) = 0.40 + 0.60|cos(2.5t)|^0.55 puts lobe tips at
// t = 0, +-1.257, +-2.513 and leaves a stem notch at t = +-pi.
function mapleTexture(size = 128) {
  const c = makeCanvas(size), g = c.getContext('2d');
  const cx = size * 0.5, cy = size * 0.47, R = size * 0.44;
  g.clearRect(0, 0, size, size);
  g.beginPath();
  const N = 300;
  for (let i = 0; i <= N; i++) {
    const t = -Math.PI + (i / N) * Math.PI * 2;
    let r = 0.40 + 0.60 * Math.pow(Math.abs(Math.cos(2.5 * t)), 0.55);
    r *= 1 + 0.05 * Math.sin(15 * t);                 // serrated edge
    r *= 1 - 0.12 * (Math.abs(t) / Math.PI);
    const x = cx + Math.sin(t) * r * R, y = cy + Math.cos(t) * r * R;
    if (i) g.lineTo(x, y); else g.moveTo(x, y);
  }
  g.closePath();
  // The value ramp is the leaf's own form: the tip catches light, the base is
  // in its own shadow. Keeps a leaf from reading as a flat coloured chip.
  // The dark stop used to be #6e6659 (0.43), which is a narrow 2.3:1 ramp, and
  // once the film grade has lifted a backlit leaf most of that lands in the top
  // stop and reads as one flat colour. A deeper base and heavier, doubled veins
  // give the soft-knee tone curve below something it can still resolve.
  const grd = g.createLinearGradient(0, cy - R, 0, cy + R);
  grd.addColorStop(0.0, '#ffffff');
  grd.addColorStop(0.42, '#c3b9a8');
  grd.addColorStop(1.0, '#463f35');
  g.fillStyle = grd;
  g.fill();
  g.globalCompositeOperation = 'source-atop';
  g.strokeStyle = 'rgba(18,9,5,0.46)';                // veins: rgb only
  g.lineWidth = Math.max(1.4, size * 0.016);
  g.lineCap = 'round';
  for (const k of [-2, -1, 0, 1, 2]) {
    const t = k * 1.2566;
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + Math.sin(t) * R * 0.88, cy + Math.cos(t) * R * 0.88);
    g.stroke();
    // A secondary vein off each rib: at 40-60 px on screen a five-line star is
    // still readable as "a shape with lines on it" rather than as venation.
    g.lineWidth = Math.max(1, size * 0.008);
    for (const s of [-1, 1]) {
      const t2 = t + s * 0.30;
      g.beginPath();
      g.moveTo(cx + Math.sin(t) * R * 0.26, cy + Math.cos(t) * R * 0.26);
      g.lineTo(cx + Math.sin(t2) * R * 0.66, cy + Math.cos(t2) * R * 0.66);
      g.stroke();
    }
    g.lineWidth = Math.max(1.4, size * 0.016);
  }
  g.globalCompositeOperation = 'source-over';
  return texFromCanvas(featherAlpha(c, 2));
}

// Cherry petal: rounded, with the notch at the outer tip.
function petalTexture(size = 96) {
  const c = makeCanvas(size), g = c.getContext('2d');
  const cx = size * 0.5, cy = size * 0.56, W = size * 0.30, H = size * 0.42;
  g.beginPath();
  g.moveTo(cx, cy + H * 0.88);
  g.bezierCurveTo(cx - W * 1.55, cy + H * 0.34, cx - W * 1.20, cy - H * 0.78, cx - W * 0.24, cy - H * 0.92);
  g.lineTo(cx, cy - H * 0.58);
  g.lineTo(cx + W * 0.24, cy - H * 0.92);
  g.bezierCurveTo(cx + W * 1.20, cy - H * 0.78, cx + W * 1.55, cy + H * 0.34, cx, cy + H * 0.88);
  g.closePath();
  const grd = g.createLinearGradient(0, cy - H, 0, cy + H);
  grd.addColorStop(0.0, '#ffffff');
  grd.addColorStop(0.55, '#d2c9cb');
  grd.addColorStop(1.0, '#6d6367');
  g.fillStyle = grd;
  g.fill();
  g.globalCompositeOperation = 'source-atop';
  g.strokeStyle = 'rgba(80,44,58,0.18)';
  g.lineWidth = Math.max(1, size * 0.013);
  for (let k = -1; k <= 1; k++) {
    g.beginPath();
    g.moveTo(cx, cy + H * 0.8);
    g.quadraticCurveTo(cx + k * W * 0.55, cy, cx + k * W * 0.45, cy - H * 0.75);
    g.stroke();
  }
  g.globalCompositeOperation = 'source-over';
  return texFromCanvas(featherAlpha(c, 2));
}

// Gaussian mote. No hard edge anywhere in it — a dust speck is out of focus at
// every distance you ever see it, and a hard-edged dot is what reads as litter.
function moteTexture(size = 48, sharp = 9.0, halo = 0.10) {
  const c = makeCanvas(size), g = c.getContext('2d');
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5, dy = (y + 0.5) / size - 0.5;
      const d2 = (dx * dx + dy * dy) * 4;             // 0 centre .. 1 at radius
      let a = Math.exp(-d2 * sharp) + halo * Math.exp(-d2 * 1.7);
      a *= Math.max(0, 1 - d2 * d2);                  // hard zero at the border
      const i = (y * size + x) * 4;
      img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255;
      img.data[i + 3] = clamp(a, 0, 1) * 255;
    }
  }
  g.putImageData(img, 0, 0);
  return texFromCanvas(c);
}

// Firefly / ember: small hot core inside a wide soft bloom.
function sparkTexture(size = 64) {
  const c = makeCanvas(size), g = c.getContext('2d');
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5, dy = (y + 0.5) / size - 0.5;
      const d2 = (dx * dx + dy * dy) * 4;
      let a = Math.exp(-d2 * 26.0) * 0.95 + Math.exp(-d2 * 3.4) * 0.30;
      a *= Math.max(0, 1 - d2 * d2);
      const i = (y * size + x) * 4;
      img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255;
      img.data[i + 3] = clamp(a, 0, 1) * 255;
    }
  }
  g.putImageData(img, 0, 0);
  return texFromCanvas(c);
}

// Seed fluff: bright seed, feathery filaments, soft halo.
function fluffTexture(size = 80) {
  const c = makeCanvas(size), g = c.getContext('2d');
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5, dy = (y + 0.5) / size - 0.5;
      const d = Math.min(1.0, Math.hypot(dx, dy) * 2);
      const ang = Math.atan2(dy, dx);
      const spokes = Math.pow(Math.abs(Math.cos(ang * 6.5)), 7.0);
      let a = Math.exp(-d * d * 26.0) * 0.85;
      a += spokes * Math.pow(Math.max(0, 1 - d), 1.5) * 0.42;
      a += Math.exp(-d * d * 3.2) * 0.09;
      a *= Math.max(0, 1 - Math.pow(d, 6));
      const i = (y * size + x) * 4;
      img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255;
      img.data[i + 3] = clamp(a, 0, 1) * 255;
    }
  }
  g.putImageData(img, 0, 0);
  return texFromCanvas(c);
}

// Eroded haze bank: fbm alpha inside a wide elliptical falloff, feathered to
// nothing at the top so the slab has no visible upper edge.
function hazeTexture(size = 192) {
  const c = makeCanvas(size), g = c.getContext('2d');
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size, v = (y + 0.5) / size;
      const dx = (u - 0.5) * 2.0;
      // v = 0 at the top of the quad (uv origin is bottom-left, but the
      // gradient is symmetric enough that either way reads as a bank).
      const fall = Math.pow(Math.max(0, 1 - Math.abs(dx)), 1.15);
      const vert = Math.pow(Math.max(0, 1 - Math.abs(v * 2 - 1)), 1.6);
      const n = fbm(u * 3.4 + 17.0, v * 2.0 - 5.0, 4) * 0.5 + 0.5;
      const n2 = fbm(u * 8.5 - 3.0, v * 5.0 + 11.0, 3) * 0.5 + 0.5;
      let a = fall * vert * sstep(n * 0.7 + n2 * 0.3, 0.26, 0.78);
      a *= 0.45 + 0.55 * fall;
      const i = (y * size + x) * 4;
      img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255;
      img.data[i + 3] = clamp(a, 0, 1) * 255;
    }
  }
  g.putImageData(img, 0, 0);
  return texFromCanvas(c);
}

/* ------------------------------------------------------------------ *
 * baked island field
 *   R = terrain height (m, from terrain.heightAt)
 *   G = forest density   B = meadow density   A = haze / valley factor
 * ------------------------------------------------------------------ */
const FIELD_RES = 384;

function bakeIslandField() {
  const N = FIELD_RES, S = ISLAND.size, half = S * 0.5, step = S / N;
  const H = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    const z = -half + (j + 0.5) * step;
    for (let i = 0; i < N; i++) H[j * N + i] = heightAt(-half + (i + 0.5) * step, z);
  }
  // Separable box blur -> local mean height. Sitting below your neighbourhood
  // is what "valley" means, and it is what haze actually pools in.
  const R = 4, tmp = new Float32Array(N * N), blur = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      let s = 0;
      for (let k = -R; k <= R; k++) s += H[j * N + clamp(i + k, 0, N - 1)];
      tmp[j * N + i] = s / (R * 2 + 1);
    }
  }
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      let s = 0;
      for (let k = -R; k <= R; k++) s += tmp[clamp(j + k, 0, N - 1) * N + i];
      blur[j * N + i] = s / (R * 2 + 1);
    }
  }

  const data = new Uint16Array(N * N * 4);
  const h16 = THREE.DataUtils.toHalfFloat;
  for (let j = 0; j < N; j++) {
    const z = -half + (j + 0.5) * step;
    for (let i = 0; i < N; i++) {
      const x = -half + (i + 0.5) * step;
      const k = j * N + i, h = H[k];

      // The same meander terrain.js carves, so haze follows the actual water.
      const centre = Math.sin(x * 0.0034) * 150 + Math.sin(x * 0.0009 + 2.1) * 70;
      const rd = (z - centre) / 90;
      const river = Math.exp(-rd * rd);

      const fn = fbm(x * 0.0021 + 61.7, z * 0.0021 - 23.3, 4);
      const forest = sstep(fn, 0.045, 0.26) * sstep(h, 4, 16) * (1 - sstep(h, 150, 215));
      const mn = fbm(x * 0.0035 + 9.1, z * 0.0035 + 31.7, 3) * 0.5 + 0.5;
      const meadow = (1 - forest * 0.8) * sstep(h, 2.6, 9) * (1 - sstep(h, 110, 175)) * sstep(mn, 0.28, 0.56);

      const lowness = sstep(blur[k] - h, -1.0, 10.0);
      const overWater = 1 - sstep(h, -1.0, 3.2);
      let haze = 0.10 + river * 0.70 + lowness * 0.55 + overWater * 0.65 + forest * 0.22;
      // Haze is a low-altitude phenomenon. Ridges stand clear of it; that
      // contrast between a clear ridge and a drowned valley IS the depth read.
      haze *= 1 - sstep(h, 26, 150);

      const o = k * 4;
      data[o] = h16(h);
      data[o + 1] = h16(clamp(forest, 0, 1));
      data[o + 2] = h16(clamp(meadow, 0, 1));
      data[o + 3] = h16(clamp(haze, 0, 1));
    }
  }

  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------ *
 * shaders
 * ------------------------------------------------------------------ */
const VERT = /* glsl */`
precision highp float;
` + WIND_UNIFORMS_GLSL + WIND_GLSL + /* glsl */`

uniform float uTime, uGustAmp;
uniform float uYMin, uCamBias, uSize, uSizeMin, uSizeMax, uSizeBias, uMinPx, uMaxPx, uMaxGrow, uProjScale;
uniform float uFall, uSpin, uFieldScale, uDensity;
uniform float uSeaLevel, uNear, uFar, uEdge0, uEdge1, uTop0, uTop1;
uniform float uCanopy, uSkyKill, uStreak, uAlign;
uniform vec2  uDrift, uSkyFade, uSkyTop, uCell, uAspect;
uniform vec3  uCam, uTurb, uSunDir;
uniform vec4  uBiome;
uniform sampler2D uField;
#ifdef FIRE
uniform vec4 uFires[${MAX_FIRES}];
#endif

attribute vec3  iBase;
attribute vec4  iSeed;
attribute float iExtra;

varying vec2  vUv;
varying vec4  vSeed;
varying float vFade, vCosSun, vDepth, vGust, vFacing, vSky;
varying vec3  vW;

#ifdef SKYMASK
// Is there anything solid at this world point's ALTITUDE, or is the sightline
// already out in open air here? The baked field carries terrain height in R and
// forest density in G, so a canopy standing on that terrain is ground + trees.
float occAt(vec3 p) {
  vec4 FB = texture2D(uField, p.xz * uFieldScale + 0.5);
  float g = max(FB.r, uSeaLevel);
  float bare = smoothstep(-1.0, 4.0, g - p.y);
  float tree = smoothstep(-1.0, 7.0, g + FB.g * uCanopy - p.y) * clamp(FB.g * 2.2, 0.0, 0.92);
  return max(bare, tree);
}
#endif

void main() {
  vUv   = uv;
  vSeed = iSeed;
  float t  = uTime;
  float ph = iSeed.x * 6.2831853 + iBase.x * 0.137 + iBase.z * 0.211;

  vec2  wxz;
  float y, gy, dens;
  float gust = 0.0, keepExtra = 1.0, bandFade = 1.0;

#ifdef FIRE
  // ---- embers: spiral up out of a registered fire source ------------------
  vec4 fire = vec4(0.0);
  for (int k = 0; k < ${MAX_FIRES}; k++) {
    if (float(k) == iExtra) fire = uFires[k];
  }
  float rise = mod(iBase.y - uFall * t * (0.6 + iSeed.y * 0.9), uCell.y);
  float up01 = rise / uCell.y;
  float rad  = fire.w * (0.12 + 0.75 * iSeed.y) * (0.35 + up01 * 1.6);
  float ang  = iSeed.x * 6.2831853 + t * (0.9 + iSeed.y * 1.7) + up01 * 3.0;
  wxz = fire.xz + vec2(cos(ang), sin(ang)) * rad
      + uWindDir * (up01 * up01 * 6.0 * (0.4 + uWindStr));
  y   = fire.y + rise;
  gy  = fire.y;
  dens = 1.0;
  keepExtra = step(0.0001, fire.w);
  bandFade  = (1.0 - up01) * (1.0 - up01) * smoothstep(0.0, 0.10, up01);
#else
  // ---- horizontal advection: INTEGRATED, never recomputed from t ----------
  // This used to be iBase.xz + uWindDir * (uSpeed * t + ...), an arm whose
  // length grows for the whole session — at t = 252 s the leaves' arm was
  // ~857 m, so any rotation of the wind swept every particle along an arc at
  // tens of m/s, and one guiding-wind press teleported the entire field.
  // uDrift is accumulated on the CPU with the direction that was actually
  // blowing at the time, and wrapped into the cell so it stays bounded.
  vec2 p2 = iBase.xz + uDrift;

  // Turbulence: several bounded frequencies so nothing travels in a straight
  // line and no two neighbours share a path.
  vec2  perp = vec2(-uWindDir.y, uWindDir.x);
  float tw   = uTurb.x * (0.55 + 0.9 * iSeed.y);
  p2 += perp * (sin(t * uTurb.y + ph) * tw + sin(t * uTurb.z + ph * 1.73) * tw * 0.55);
  p2 += uWindDir * (sin(t * uTurb.y * 0.61 + ph * 0.9) * tw * 0.75);
  p2 += perp * sin(t * 0.21 + ph * 0.37) * tw * 1.5;         // slow swirl

  // ---- wrap into a cell that rides with the camera ------------------------
  vec2 origin = uCam.xz - uCell.x * 0.5;
  wxz = mod(p2 - origin, uCell.x) + origin;

  vec4 F = texture2D(uField, wxz * uFieldScale + 0.5);
  gy = max(F.r, uSeaLevel);

  // ---- gust front: read straight out of the shared wind field -------------
  // No private sine stack any more. windGust/windDirAt come from wind.js, so
  // the front that bends the grass IS the front that shakes the trees IS the
  // front that shoves these leaves. The comment that used to sit here claimed
  // that was already true; it was not.
  float guideAmt = windGuide(wxz);
  vec2  wdir     = windDirAt(wxz);
  // MAPPING, not a threshold. wind.js publishes measured ambient statistics for
  // windGust(): mean 0.240, p50 0.235, p90 0.404, p99 0.514, max 0.655, with a
  // corridor head peaking at 2.05. The old smoothstep(0.62, 1.30, .) put its
  // LOWER edge above the ambient p99, so ordinary wind produced gust ~= 0 and
  // this layer was deaf to the very front that was bending the grass — it only
  // moved when a corridor was fired. A linear remap resolves the ambient band
  // AND the corridor peak, which is what "everything on the same vector" means.
  gust = clamp((windGust(wxz) - 0.10) / 1.05, 0.0, 1.9);
  // The guiding corridor pushes on top of the ambient gust rather than
  // saturating into it, so the burst is visibly stronger than ordinary wind.
  wxz += wdir * (gust + guideAmt * 2.2) * uGustAmp * 2.6;

  // ---- vertical band: rides the terrain, never sinks behind the camera ----
  float bandBottom = max(gy + uYMin, uCam.y - uCamBias);
  float yl = mod(iBase.y - uFall * t + sin(t * 0.83 + ph) * uTurb.x * 0.5, uCell.y);
  y = bandBottom + yl + (gust + guideAmt * 2.6) * uGustAmp * 1.1;
  gust = min(gust + guideAmt * 1.4, 1.6);
  bandFade = smoothstep(0.0, uCell.y * 0.14, yl) * (1.0 - smoothstep(uCell.y * uTop0, uCell.y * uTop1, yl));

  dens = clamp(uBiome.w + uBiome.x * F.g + uBiome.y * F.b + uBiome.z * F.a, 0.0, 1.6) * uDensity;
#endif

  // Stochastic thinning: each particle carries its own threshold and appears
  // once density climbs past it, so a layer dissolves in instead of popping.
  // The ramp starts AT the threshold, never below it — a band straddling zero
  // left the low-threshold particles visible at zero density, which is how
  // fireflies ended up blinking in the middle of the afternoon.
  float keep = smoothstep(iSeed.w, iSeed.w + 0.18, dens) * keepExtra;

  vec3  world = vec3(wxz.x, y, wxz.y);
  float dist  = distance(world, uCam);

  float edge = 1.0 - smoothstep(uCell.x * uEdge0, uCell.x * uEdge1, length(wxz - uCam.xz));
  float near = smoothstep(uNear * 0.20, uNear, dist);
  float far  = 1.0 - smoothstep(uFar * 0.55, uFar, dist);
  float fade = keep * edge * bandFade * near * far;

  // How much of this sprite's background is open sky, in 0..1. Only layers
  // carrying SKYMASK compute it; everything else runs with 0.
  //
  // WAVE H. WHAT THIS TERM IS FOR CHANGED, AND THAT IS THE WHOLE FIX.
  // Wave G used it as a DELETE -- fade *= (1-skyMask)^2 -- with skyKill 1.0 on
  // both foliage layers. Measured on the critic's own crop of 01-sunset-ridge,
  // box (1250,100)-(1900,300): wave F carried 74 discrete sprite blobs there
  // (my detector; the critic counted 53 of the same population), wave G and the
  // wave-G canonical build carry 13 and 12 — and every one of those twelve is a
  // cloud wisp or a shading edge on the mountain, not a sprite. The upper right
  // of the hero frame went from a flurry to an empty gradient.
  //
  // But wave G's diagnosis was right even though its cure was wrong. The wave-F
  // sprites in that box measure 10.8 luma DARKER than the sky behind them and
  // 4.5 LESS warm on R-B — objectively dark desaturated specks on a bright sky,
  // which is what "lens dirt, not backlit petals" means. Deleting them fixes
  // the dirt by deleting the petals.
  //
  // Airborne blossom on the wind is one of the most GoT-identifiable things in
  // the reference set, so it has to stay AND has to read right. A petal between
  // the lens and a low sun is a thin translucent thing in front of a very bright
  // background: physically it is dominated by TRANSMISSION, not by reflectance,
  // and it is partly see-through. So the sky term is now a lighting input, not
  // a cull. It is handed to the fragment shader, where it (a) adds skylight
  // transmitted through the card, (b) pushes the sun lobe further onto the warm
  // transmission colour, and (c) thins the card's own alpha so the sky reads
  // through it. Only a small residue of the old attenuation is kept, via
  // uSkyKill, to thin the very deepest part of the sky where a real flurry
  // would have run out of air anyway.
  vSky = 0.0;
#ifdef SKYMASK
  float elev = (world.y - uCam.y) / max(dist, 1e-3);
  //
  // WAVE G, MEASURED. Wave F's band was skyFade = (0.02, 0.16) and the frame
  // still came back with "dark desaturated five-point sprites strewn evenly all
  // the way to the top of the sky". Both halves of that mask were wrong, and the
  // numbers are from this pose, probed live off the running lane:
  //
  //   camera 01-sunset-ridge: pos (-534.6, 140.2, 328.7), fov 45,
  //   uProjScale 1303.7, view direction pitched DOWN 9.76 degrees.
  //
  // 1. THE MASK IS PITCH-BLIND AND THE CAMERA IS NOT LEVEL. elev is a slope
  //    about EYE LEVEL, but the sprites read as dirt are the ones above the
  //    drawn HORIZON, and a camera pitched down by 9.76 deg puts eye level 316
  //    px above the top of the frame's centre — screen y = 316. The specks the
  //    critic sampled sit at y = 270, which is elevation angle
  //    atan(270/1303.7) - 9.76 = 1.95 deg, i.e. elev = 0.034. Wave F's band
  //    smoothstep(0.02, 0.16, 0.034) = 0.027 — a 2.7% mask. They were not
  //    masked at all.
  // 2. THE UPPER EDGE WAS UNREACHABLE. elev = 0.16 means 0.16*dist above the
  //    camera, and the band top is only uCam.y - uCamBias + uCell.y = cam+9.4 m,
  //    so NO sprite past 59 m can ever reach the full mask, and past 30 m it
  //    cannot get halfway. The sprites that read as lens dirt are exactly the
  //    far ones.
  // Verified by uniform sweep on the running lane: forcing uSkyFade to
  // (-0.60, -0.50) — i.e. saturating this mask — took the pure-sky window
  // x 1250-1920, y 140-305 from 34 dark specks / 540 px (leaves layer alone) to
  // 4 specks / 106 px, which is the vfx-off baseline of 5 specks / 74 px.
  //
  // But a bare elevation cut also deletes every leaf against a CANOPY or a
  // hillside — the forest interior is entirely above eye level — and those are
  // the leaves worth having. So the cut is gated on what is actually behind the
  // sprite: march the sightline past it through the baked island field and ask
  // whether ground, or the trees standing on that ground, still rise above the
  // ray. Four samples, spaced so a sprite a metre from the lens and one eighty
  // metres out are both answered.
  vec3  vdir = (world - uCam) / max(dist, 1e-3);
  // WAVE J: A FIFTH SAMPLE, BECAUSE THE PROBE WAS STOPPING SHORT OF THE RIDGE
  // THAT DOMINATES THE HERO FRAME. The foliage layers cull at far = 78-95 m, so
  // the deepest march the four-sample version could ever reach was 95 + 520 =
  // 615 m, and the mountain that fills the right third of 01-sunset-ridge stands
  // further out than that. Behind it the probe therefore returned "open sky",
  // so every sprite in front of the ridge took the full transmission and the
  // full skylight term and came back as a pale round disc on a smooth warm
  // slope — which is precisely the shape a critic reads as a lens-flare ghost.
  // MEASURED: with the four samples and this wave's brighter transmission, the
  // fixed mountain patch (1600-1900, 240-340) went +0.29 luma and grew visible
  // pale discs; with this sample it holds at the values reported below.
  // The field is ClampToEdge, so a ray that leaves the 2400 m island reads the
  // edge height — sea, i.e. no occluder — instead of wrapping onto a false one.
  float behind = max(
    max(occAt(uCam + vdir * (dist + 7.0)), occAt(uCam + vdir * (dist * 1.5 + 28.0))),
    max(occAt(uCam + vdir * (dist * 3.0 + 110.0)),
        max(occAt(uCam + vdir * (dist + 520.0)), occAt(uCam + vdir * (dist + 1500.0)))));
  // The distance gate only spares a sprite literally whipping past the lens,
  // where the streak reads as motion rather than as a fleck.
  float skyMask = smoothstep(uSkyFade.x, uSkyFade.y, elev)
                * (1.0 - behind) * smoothstep(1.5, 4.0, dist);
  vSky  = skyMask;
  fade *= 1.0 - skyMask * uSkyKill;

  // ---- WAVE J: THE TOP OF THE SKY IS UNWINNABLE, SO DO NOT PLAY THERE -----
  // This is NOT wave G's cull coming back. Wave G killed the sprite EVERYWHERE
  // it had sky behind it (skyKill 1.0 over the whole skyFade band) and emptied
  // the hero frame; skyKill stays 0.0 for both foliage layers and every leaf
  // from the horizon up through the usable band is untouched. What this removes
  // is one narrow wedge at the TOP of the frame, and the reason is photometric,
  // not aesthetic.
  //
  // MEASURED at pose 01 on this lane, with the whole page clock frozen so two
  // captures are pixel-comparable (performance.now pinned; two identical
  // configs differ by 21 px in 2.07 M). Camera pos (-534.6, 140.2, 328.7),
  // fov 45, uProjScale 1303.7, pitched down 9.83 deg, so eye level (elev = 0)
  // lands at screen y = 314. Isolating this layer by differencing it against a
  // group-hidden capture gives 288 leaf blobs above y = 430, of which 77% are
  // DARKER than the sky they cover, median -3.7 luma. Their vertical spread
  // runs from y = 1 — the literal top row of the frame, elev 0.224 — with a
  // 10th percentile at y = 54 (elev 0.187).
  //
  // Up there the sky is the brightest thing in the picture: a fixed patch at
  // (300-1200, 0-120) measures 243.7 / 193.9 / 152.7 with the layer hidden. A
  // sprite cannot be a warm lamp in front of that, because there is no headroom
  // left to be brighter IN — the four-step transmission sweep below moves that
  // patch by at most 5.5 levels and every level of it costs saturation, which
  // is how the "snow" variants happened. Near the horizon the same sky is
  // 214-225 and a backlit petal has somewhere to go. So the layer is faded out
  // above uSkyTop.x and gone by uSkyTop.y, gated on (1 - behind) exactly like
  // the mask above: a leaf against a canopy or a hillside is never touched,
  // however high in frame it sits, because those are the leaves worth having.
  fade *= 1.0 - (1.0 - behind) * smoothstep(uSkyTop.x, uSkyTop.y, elev);
#endif

  // Skewed size distribution: mostly small, a handful large. A uniform spread
  // gives every particle the same apparent weight and the field reads as noise;
  // a few big near ones crossing frame in front of a haze of small ones is what
  // reads as depth.
  float sz = uSize * mix(uSizeMin, uSizeMax, pow(iSeed.y, uSizeBias));

  // Sub-pixel sprites shimmer, so hold a floor on screen size — but pay for it
  // in alpha. Growing a quad by 1/s multiplies its area by 1/s^2, so alpha must
  // drop by s^2 for the particle to carry the same light. Without this the
  // whole draw distance stays at full brightness and reads as confetti.
  float px  = sz * uProjScale / max(dist, 0.05);
  float sub = clamp(px / uMinPx, 0.0, 1.0);
  float grow = 1.0 / max(sub, 1.0 / uMaxGrow);
  sz  *= grow;
  fade *= sub * sub;

  // ---- and a CEILING, the mirror of that floor ---------------------------
  // Measured at pose 01 by replicating this size math over all 9000 instances:
  // the largest leaf reached 78-110 px on a 1920x1080 frame and 16-19 instances
  // exceeded 40 px at any instant. That size is geometrically correct — a 0.25 m leaf
  // a couple of metres from the lens — and that is exactly why it is wrong:
  // a leaf that close is a foreground object, and this layer draws flat
  // camera-facing sprites off a 128 px texture with no parallax and no depth
  // of field, so at that size it can only read as a decal stuck to the screen.
  // Fading it out is perspective-CORRECT: nothing is rescaled, sprites keep
  // shrinking exactly with distance; the ones that have grown past what a flat
  // sprite can carry simply are not drawn. uMaxPx defaults far above any layer
  // that wants to be big on screen (the haze slabs), so only foliage sees it.
  fade *= 1.0 - smoothstep(uMaxPx, uMaxPx * 1.8, px);

  // ---- WAVE J: ONLY SMALL CARDS ARE ALLOWED TO BE LAMPS -------------------
  // vSky is "how much bright background is behind me", and the fragment shader
  // spends it on transmission, on skylight through the card and on a raised
  // radiance ceiling. Every one of those is an argument about a THIN, DISTANT
  // card — a petal a hundred metres out is one cell thick and the sun comes
  // straight through it. A leaf three metres from the lens is an opaque
  // reflective object, and giving it the same treatment is what turns it into
  // a hot round blob with no structure.
  //
  // This is not hypothetical: the first cut of this wave's tone change, with no
  // taper, took the count of isolated round bright discs (>= 20 px, elongation
  // < 1.35, bbox fill > 0.6, at least +1.5 luma over their background) from 18
  // to 27 on this pose, and the largest from 13.0 px across to 16.4 px — I made
  // the very lens-flare-ghost artefact I was sent here to remove, out of the
  // leaves instead of the dust. 18 of those 27 were this layer.
  //
  // The thresholds are in SCREEN PIXELS, not in a fraction of uMaxPx, because
  // this is an argument about apparent size and it holds identically for every
  // layer: past ~18 px a sprite is close enough to read as an object.
  vSky *= 1.0 - smoothstep(6.0, 18.0, px);

  vFade = fade;

  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);

  vec2 q = position.xy * uAspect * sz;

  // Which way this particle happens to be presenting to the sun. Without it
  // every leaf takes the full key at once and the layer reads as a uniform
  // sprinkle of identically bright dots; with it, some are lit and some are
  // turned away, which is what a real flurry looks like.
  float spin = t * uSpin * (0.35 + 1.30 * iSeed.z) + iSeed.x * 6.2831853;
  vFacing = 0.26 + 0.74 * abs(sin(spin));

#ifdef TUMBLE
  // Fake 3d flip: squash across the quad as the leaf turns edge-on, then roll.
  //
  // The squash floor was 0.10. MEASURED: 5% of instances sit below 0.171, i.e.
  // one leaf in twenty was collapsed to a sliver under a sixth of its width, and
  // a five-lobed maple squashed that far has no lobes left, only a smooth lens
  // with no silhouette cue and no readable orientation. 0.32 keeps a
  // recognisable leaf at every phase of the flip.
  q.x *= mix(0.32, 1.0, abs(cos(spin)));
  // Roll used to be spin*0.43 + iSeed.z*TAU, i.e. it shared iSeed.z with the
  // spin RATE, so a leaf's tumble phase and its flip rate were locked together.
  // (The roll distribution itself was already uniform — measured 7.2-9.9% per
  // 30 degree bin over 9000 instances at pose 01 — so "all frozen at the same
  // rotation" was never true of this layer, and the wedges it was said about
  // were grass. Decorrelating roll from the flip rate is still right: it buys an
  // independent tumble phase per instance for free.)
  float rphase = fract(iSeed.x * 7.31 + iSeed.z * 3.77 + iSeed.y * 11.13);
  float roll = rphase * 6.2831853
             + t * uSpin * 0.33 * (0.35 + 0.9 * rphase)
             + gust * 1.4;

  // ---- THE SHARED WIND VECTOR, ON SCREEN ---------------------------------
  // "Isotropic blobs sharing no wind vector while the grass beneath them is
  // combed one way." The tumble above is per-instance and uncorrelated, so the
  // layer has no common axis — nothing in it says which way the air is going.
  // uWindDir is that axis and it is the SAME vec2 grass.js and trees.js bend
  // to (wind.js owns it; this file only reads it). Project it into the
  // billboard's own screen basis, comb each card's long axis toward it, and
  // smear along it with the local gust. Because the basis is the view basis,
  // every card in the frame leans the same way in SCREEN space, which is what
  // makes a flurry read as one moving body of air instead of confetti.
  // The -0.30 y component is the fall: air travels level, foliage in it sinks,
  // and the streak has to follow the actual path, not the horizontal alone.
  vec3 wv3 = normalize(vec3(uWindDir.x, -0.30, uWindDir.y));
  vec2 sv  = vec2(dot(wv3, right), dot(wv3, up));
  float sl = length(sv);
  if (sl > 1e-3 && uAlign + uStreak > 0.0) {
    sv /= sl;
    // Comb the roll toward the wind AXIS (either polarity, so no card has to
    // flip 180 to get there) by mixing unit vectors — no angle wrapping.
    vec2 rd = vec2(cos(roll), sin(roll));
    vec2 td = mix(rd, sv * (dot(rd, sv) < 0.0 ? -1.0 : 1.0), uAlign);
    float tl = length(td);
    if (tl > 1e-4) { td /= tl; roll = atan(td.y, td.x); }
  }
  q = mat2(cos(roll), -sin(roll), sin(roll), cos(roll)) * q;
  if (sl > 1e-3 && uStreak > 0.0) {
    // Motion smear: stretch along the wind, thin across it, so the sprite keeps
    // roughly the light it had. sl folds in foreshortening — a card blowing
    // straight at the lens has no screen-space direction and gets no streak.
    //
    // WAVE J, MEASURED. The base term was 0.30 and it made the streak a
    // GUST-ONLY effect. wind.js publishes windGust ambient statistics mean
    // 0.240 / p50 0.235, and the remap above turns p50 into
    // (0.235 - 0.10) / 1.05 = 0.129, so in ordinary wind the old bracket ran at
    // 0.30 + 0.90*0.129 = 0.416 — under half strength — and the layer only
    // combed when a corridor fired. Isolated on pose 01, the shipped leaves
    // measured elongation median 1.68 (p90 2.62); the principal-axis circular
    // mean was 154 deg, i.e. the AXIS was already shared and correct, there was
    // simply not enough of it to see. 0.62 + 0.62*gust holds the ambient case at
    // 0.70 and still lets a corridor push past 1.4.
    float st = uStreak * (0.62 + 0.62 * gust) * sl;
    vec2 al = sv * dot(q, sv);
    q = al * (1.0 + st) + (q - al) * inversesqrt(1.0 + st);
  }
#endif

#ifdef YBILLBOARD
  vec3 toC = uCam - world; toC.y = 0.0;
  if (dot(toC, toC) > 1e-6) right = normalize(vec3(-toC.z, 0.0, toC.x));
  up = vec3(0.0, 1.0, 0.0);
  q.y += sz * uAspect.y * 0.5;               // grow upward off the ground
#endif

  vec3 wpos = world + right * q.x + up * q.y;
  vW     = wpos;
  vDepth = dist;
  vGust  = gust;
  vCosSun = dot(normalize(world - uCam), uSunDir);

  gl_Position = projectionMatrix * viewMatrix * vec4(wpos, 1.0);
}
`;

const FRAG = /* glsl */`
precision highp float;

uniform sampler2D uMap, uField;
uniform vec3  uColA, uColB, uSunColor, uSkyColor, uFog, uTrans;
uniform float uOpacity, uAmbient, uDirect, uScatter, uPhaseG, uEmissive;
uniform float uSkyGlow, uSkyThin;
uniform float uSunPow, uFogDensity, uMaxRad, uTime;
uniform float uFieldScale, uSeaLevel, uHazeTop;

varying vec2  vUv;
varying vec4  vSeed;
varying float vFade, vCosSun, vDepth, vGust, vFacing, vSky;
varying vec3  vW;

// Henyey-Greenstein, normalised so the backward lobe is 0 and the forward lobe
// peaks at 1. Bounded by construction, which is the whole point: an unbounded
// forward-scatter term is what turned every mote near the sun into a white dot.
float hg(float c, float g) {
  float g2 = g * g;
  float d  = 1.0 + g2 - 2.0 * g * c;
  float f  = (1.0 - g2) / max(pow(d, 1.5), 1e-4);
  float mx = (1.0 - g2) / max(pow((1.0 - g) * (1.0 - g), 1.5), 1e-4);
  float mn = (1.0 - g2) / max(pow((1.0 + g) * (1.0 + g), 1.5), 1e-4);
  return clamp((f - mn) / max(mx - mn, 1e-4), 0.0, 1.0);
}

void main() {
  if (vFade <= 0.0015) discard;
  vec4 tx = texture2D(uMap, vUv);
  float a = tx.a * vFade * uOpacity;
  if (a <= 0.0025) discard;

#ifdef HAZE
  // Haze is the air itself: it wears the fog colour so distance dissolves into
  // the horizon exactly the way aerial perspective says it should.
  vec3 albedo = mix(uFog, vec3(1.0), 0.06) * (0.90 + 0.20 * vSeed.y) * tx.rgb;
#else
  vec3 albedo = mix(uColA, uColB, vSeed.z) * (0.82 + 0.36 * vSeed.y) * tx.rgb;
#endif

#ifdef PULSE
  float b = sin(uTime * (1.5 + vSeed.y * 1.6) + vSeed.x * 41.0);
  a *= 0.14 + 0.86 * pow(max(b, 0.0), 1.9);          // each firefly blinks alone
#endif

#ifdef HAZE
  vec4 FF = texture2D(uField, vW.xz * uFieldScale + 0.5);
  float above = vW.y - max(FF.r, uSeaLevel);
  a *= smoothstep(-3.0, 2.5, above) * (1.0 - smoothstep(uHazeTop * 0.30, uHazeTop, above));
  a *= clamp(FF.a * 1.35, 0.0, 1.0);
  if (a <= 0.0025) discard;
#endif

  // Sky bounce fills the shadow side; the sun does the rest.
  vec3 lit = albedo * (uSkyColor * uAmbient + uSunColor * (uDirect * uSunPow * vFacing));
  // Forward scatter: light coming through a leaf, a petal or a mote toward you.
#ifdef FOLIAGE
  // A leaf lit THROUGH is not the same colour as a leaf lit ON: the chlorophyll
  // and carotenoid layers eat blue, so transmission runs hotter and more
  // saturated than reflection. Tinting the lobe is what makes an airborne leaf
  // read as backlit rather than as fill light on a coloured chip.
  //
  // WAVE F MULTIPLIED THE LOBE BY THE ALBEDO, and the albedo is the problem.
  // #b8451c through THREE's sRGB decode is linear (0.478, 0.061, 0.011): the
  // green channel is a sixteenth of the red and the blue is a fortieth. No
  // amount of scatter gain can make a glow out of that — it can only make a
  // more saturated dark red, which is exactly the "dark desaturated
  // purple-brown" that got sampled. Light coming THROUGH a leaf is not the
  // leaf's reflectance; it is the sun's spectrum filtered by it, and at the thin
  // parts it is nearly the sun. So the lobe now carries its own transmission
  // colour and keeps only the texture's own ramp and venation for structure.
  vec3 tcol  = uTrans * tx.rgb * (0.80 + 0.40 * vSeed.y);
  // Against open sky the card is almost pure transmission, so slide the lobe's
  // colour the rest of the way onto the transmission tint as vSky rises.
  vec3 trans = mix(albedo, tcol, 0.78 + 0.20 * vSky);
  lit += uSunColor * trans * hg(vCosSun, uPhaseG) * uScatter * uSunPow;
  // SKYLIGHT THROUGH THE CARD. The sun lobe alone only lights the sprites
  // pointing at the sun; the rest of a real flurry is lit by the whole bright
  // hemisphere behind it, which is exactly the light this layer was missing.
  // Bounded by uSkyColor, so it can never exceed the background it is standing
  // in front of by more than uSkyGlow, and the soft knee below still holds it.
  lit += uSkyColor * tcol * (vSky * uSkyGlow);
  // And thin the card. A petal a hundred metres out is one cell thick against a
  // sky two stops brighter: it does not occlude, it tints. This is also what
  // stops a restored flurry from reading as a field of hard-edged chips — the
  // sprites furthest out on the sky are the softest, not the crispest.
  a *= 1.0 - vSky * uSkyThin;
  if (a <= 0.0025) discard;
#else
  lit += uSunColor * albedo * hg(vCosSun, uPhaseG) * uScatter * uSunPow;
#endif
  lit += albedo * uEmissive;
  lit *= 1.0 + vGust * 0.25;                          // gust fronts catch light
#ifdef FOLIAGE
  // SOFT KNEE, not a clamp. min(lit, uMaxRad) is a hard clip; anything above
  // the ceiling flattens to one value and takes the leaf's ramp and its five
  // veins with it. This asymptotes to uMaxRad instead, so it is monotonic
  // everywhere and the internal structure survives however hot the key gets.
  //
  // FOR THE RECORD, because it cost a wave to establish: the "flat solid-yellow
  // 40-60 px chips with stair-stepped alpha and no venation" reported against
  // wave E's 01-sunset-ridge ARE NOT THIS LAYER. Measured, at that pose, with
  // window.__VFX.group.visible = false — every vfx layer off, haze and dust and
  // leaves and petals — the frame still contains 15 solid warm components of
  // 120 px or more, the largest 162 x 85 px, R pinned at 250+. They are grass
  // blade clumps out of grass.js catching the low key and clipping. Lowering
  // this layer's radiance to a quarter of wave E's changed nothing about them,
  // which is how it was caught. Do not dim the leaves to chase them.
  //
  // WAVE J: THE CEILING IS WHAT WAS HOLDING THE GLOW DOWN, so it now rises with
  // the background. Evaluating this shader's arithmetic by hand at pose 01 with
  // the live uniforms read off the running lane (uSkyColor 0.704/0.560/0.784,
  // uSunColor 1/0.357/0.099, uSunPow 1, hg(0.8956, 0.32) = 0.788) a fully
  // sky-backed leaf reaches lit = (3.75, 0.66, 0.10) BEFORE the knee and
  // (1.46, 0.52, 0.09) after it — the knee is taking 2.6 stops out of red and
  // almost nothing out of green, which both dims the sprite AND drags its hue
  // toward the "desaturated purple-brown" that got sampled. A leaf standing in
  // front of a hillside is lit by the same key and must NOT get that headroom,
  // or it stops sitting in the landscape. vSky is exactly the "how much bright
  // background is behind me" term, so it is the right thing to scale by.
  lit = lit / (1.0 + lit / (uMaxRad * (1.0 + vSky * 1.20)));
#else
  lit  = min(lit, vec3(uMaxRad));                     // never blow out to a dot
#endif

  float f = 1.0 - exp(-pow(vDepth * uFogDensity, 2.0));
#ifdef ADDITIVE
  a *= 1.0 - f;
  gl_FragColor = vec4(lit * a, 1.0);
#else
  lit = mix(lit, uFog, f * 0.94);
  a *= 1.0 - f * 0.45;
  gl_FragColor = vec4(lit, a);
#endif
}
`;

/* ------------------------------------------------------------------ *
 * layer factory
 * ------------------------------------------------------------------ */

// Clustered scatter. Uniform random reads as an even blanket over the frame;
// real particulate arrives in drifts with clear air between them.
function quadGeometry(count, cell, rng, o) {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(
    [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);

  const per = Math.max(1, o.clump ?? 1);
  const spread = o.clumpSpread ?? 0;
  const nClusters = Math.max(1, Math.round(count / per));
  const cx = new Float32Array(nClusters), cz = new Float32Array(nClusters), cy = new Float32Array(nClusters);
  for (let i = 0; i < nClusters; i++) {
    cx[i] = (rng() - 0.5) * cell.x;
    cz[i] = (rng() - 0.5) * cell.x;
    cy[i] = rng() * cell.y;
  }

  const base = new Float32Array(count * 3);
  const seed = new Float32Array(count * 4);
  const extra = new Float32Array(count);
  const wrap = (v, s) => { const h = s * 0.5; return ((v + h) % s + s) % s - h; };
  for (let i = 0; i < count; i++) {
    const c = i % nClusters;
    // Triangular jitter: denser at the cluster core, no hard cluster boundary.
    const jx = (rng() + rng() - 1) * spread;
    const jz = (rng() + rng() - 1) * spread;
    const jy = (rng() + rng() - 1) * Math.min(spread, cell.y * 0.45);
    base[i * 3 + 0] = spread > 0 ? wrap(cx[c] + jx, cell.x) : (rng() - 0.5) * cell.x;
    base[i * 3 + 1] = spread > 0 ? ((cy[c] + jy) % cell.y + cell.y) % cell.y : rng() * cell.y;
    base[i * 3 + 2] = spread > 0 ? wrap(cz[c] + jz, cell.x) : (rng() - 0.5) * cell.x;
    seed[i * 4 + 0] = rng();
    seed[i * 4 + 1] = rng();
    seed[i * 4 + 2] = rng();
    seed[i * 4 + 3] = rng() * 0.94;
    extra[i] = o.extraFn ? o.extraFn(i) : rng();
  }
  geo.setAttribute('iBase', new THREE.InstancedBufferAttribute(base, 3));
  geo.setAttribute('iSeed', new THREE.InstancedBufferAttribute(seed, 4));
  geo.setAttribute('iExtra', new THREE.InstancedBufferAttribute(extra, 1));
  geo.instanceCount = count;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  return geo;
}

function makeLayer(o, shared) {
  const rng = mulberry32(o.seed);
  const geo = quadGeometry(o.count, o.cell, rng, o);

  const defines = {};
  for (const d of o.defines || []) defines[d] = '';

  const uniforms = {
    uTime: shared.uTime,
    uCam: shared.uCam,
    // The wind block, by reference, straight off wind.js. Nothing in this file
    // writes to any of these — wind.update() owns them.
    uWindTime: shared.uWindTime,
    uWindDir: shared.uWindDir,
    uWindStr: shared.uWindStr,
    uWindWave: shared.uWindWave,
    uWindGuide: shared.uWindGuide,
    uWindGuideDir: shared.uWindGuideDir,
    uSunDir: shared.uSunDir,
    uSunColor: shared.uSunColor,
    uSkyColor: shared.uSkyColor,
    uSunPow: shared.uSunPow,
    uFog: shared.uFog,
    uFogDensity: shared.uFogDensity,
    uProjScale: shared.uProjScale,
    uField: shared.uField,
    uFieldScale: shared.uFieldScale,
    uSeaLevel: shared.uSeaLevel,

    uMap: { value: o.map },
    uCell: { value: new THREE.Vector2(o.cell.x, o.cell.y) },
    uAspect: { value: new THREE.Vector2(o.aspect ? o.aspect[0] : 1, o.aspect ? o.aspect[1] : 1) },
    uYMin: { value: o.yMin ?? 0 },
    uCamBias: { value: o.camBias ?? 5000 },
    uSize: { value: o.size },
    uSizeMin: { value: o.sizeMin ?? 0.55 },
    uSizeMax: { value: o.sizeMax ?? 1.6 },
    uSizeBias: { value: o.sizeBias ?? 2.0 },
    uMinPx: { value: o.minPx ?? 1.1 },
    // Screen-size ceiling. Default is effectively off — the haze slabs are
    // MEANT to be hundreds of pixels wide. Only the foliage layers set it.
    uMaxPx: { value: o.maxPx ?? 1e5 },
    uMaxGrow: { value: o.maxGrow ?? 3.0 },
    // Accumulated horizontal advection for this layer, wrapped into the cell.
    uDrift: { value: new THREE.Vector2() },
    // Elevation above the view horizon at which a distant particle fades out,
    // so nothing peppers the sky. Only meaningful on a layer that also carries
    // the SKYMASK define; without it the whole block is compiled out.
    uSkyFade: { value: new THREE.Vector2(o.skyFade ? o.skyFade[0] : 2.0, o.skyFade ? o.skyFade[1] : 3.0) },
    // Top-of-sky cutoff, in the same elevation units as uSkyFade (rise over
    // run about EYE level, i.e. tan of the elevation angle). The layer thins
    // from x and is gone by y, and ONLY where the occlusion probe finds open
    // sky behind the sprite. Default is far above anything reachable, so a
    // layer that does not ask for it is unaffected.
    uSkyTop: { value: new THREE.Vector2(o.skyTop ? o.skyTop[0] : 90.0, o.skyTop ? o.skyTop[1] : 100.0) },
    // How completely the sky mask removes a sprite. 1.0 = gone. A dark opaque
    // sprite on a bright sky has to reach zero or it still reads as lens dirt;
    // a small additive mote is far more forgiving, so those keep a residue.
    // WAVE H: this is now a RESIDUE, not a cull. See the block in the vertex
    // shader. A foliage layer keeps most of its sprites over open sky and pays
    // for them with transmission (uSkyGlow) and translucency (uSkyThin) instead.
    uSkyKill: { value: o.skyKill ?? 1.0 },
    // Skylight transmitted through a backlit card, as a multiple of uSkyColor,
    // ramped by how much open sky is behind it. This is what makes an airborne
    // petal a warm lamp instead of a dark fleck.
    uSkyGlow: { value: o.skyGlow ?? 0 },
    // How far a fully sky-backed card fades its own alpha, 0..1. Backlit thin
    // foliage is translucent; an opaque one is lens dirt by construction.
    uSkyThin: { value: o.skyThin ?? 0 },
    // Canopy height used by the "is there land behind this?" probe, in metres.
    // SWEPT, pose 01, sky window x 1250-1920 y 140-305 (pure sky, verified with
    // the vfx group hidden): canopy 0 -> 6 specks/149 px, 5 -> 5/85, 8 -> 4/104,
    // 11 -> 11/583, 16 -> 21/776, against a vfx-off baseline of 6-7 specks/79-
    // 117 px. Above ~10 m the probe starts claiming a canopy on the hillside
    // BELOW a ridge camera, where the ground is already ten metres under the
    // sightline, and every leaf it spares there is a fleck on open sky. 8 m
    // clears the ridge and still covers a forest interior, where the ground is
    // a metre or two under the eye and real trunks do stand behind the leaves.
    uCanopy: { value: o.canopy ?? 8.0 },
    // Screen-space motion smear along the shared wind vector, and how far each
    // card's long axis is combed onto that vector. 0 = the old isotropic tumble.
    uStreak: { value: o.streak ?? 0 },
    uAlign: { value: o.align ?? 0 },
    // Colour of sunlight coming THROUGH a leaf or a petal (FOLIAGE only).
    uTrans: { value: new THREE.Color(o.trans ?? '#ffffff') },
    uFall: { value: o.fall ?? 0 },
    uSpin: { value: o.spin ?? 1 },
    uTurb: { value: new THREE.Vector3(o.turb[0], o.turb[1], o.turb[2]) },
    uGustAmp: { value: o.gustAmp ?? 1 },
    uBiome: { value: new THREE.Vector4(o.biome[0], o.biome[1], o.biome[2], o.biome[3]) },
    uDensity: { value: 1 },
    uNear: { value: o.near ?? 1.5 },
    uFar: { value: o.far ?? 200 },
    uEdge0: { value: o.edge0 ?? 0.30 },
    uEdge1: { value: o.edge1 ?? 0.487 },
    // Where the airborne band starts thinning out, as a fraction of its height.
    // Pulling this down keeps leaves in the landscape instead of peppering the
    // sky, where a dark fleck on bright blue reads as dirt on the lens.
    uTop0: { value: o.top0 ?? 0.72 },
    uTop1: { value: o.top1 ?? 1.0 },
    uColA: { value: new THREE.Color(o.colA ?? '#ffffff') },
    uColB: { value: new THREE.Color(o.colB ?? '#ffffff') },
    uOpacity: { value: o.opacity ?? 1 },
    uAmbient: { value: o.ambient ?? 0.5 },
    uDirect: { value: o.direct ?? 0.8 },
    uScatter: { value: o.scatter ?? 0.8 },
    uPhaseG: { value: o.phaseG ?? 0.65 },
    uEmissive: { value: o.emissive ?? 0 },
    uMaxRad: { value: o.maxRad ?? 1.6 },
    uHazeTop: { value: o.hazeTop ?? 20 },
  };
  if ((o.defines || []).includes('FIRE')) uniforms.uFires = shared.uFires;

  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    defines,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: o.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    uniforms,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = o.order ?? 5;
  mesh.name = 'vfx-' + o.name;
  return {
    name: o.name, mesh, mat, count: o.count, density: o.density,
    // Advection is stepped on the CPU, so the rate constants live out here too.
    speed: o.speed ?? 1, speedGust: o.speedGust ?? 1,
    gustAmpBase: o.gustAmp ?? 1,
    fire: (o.defines || []).includes('FIRE'),
  };
}

/* ------------------------------------------------------------------ *
 * createVFX
 * ------------------------------------------------------------------ */
export function createVFX(ctx) {
  const group = new THREE.Group();
  group.name = 'vfx';
  group.matrixAutoUpdate = false;

  if (typeof document === 'undefined') return { group, update() {} };

  const field = bakeIslandField();

  const shared = {
    uTime: { value: 0 },
    uCam: { value: new THREE.Vector3() },
    uSunDir: { value: new THREE.Vector3(0, 0.15, 1) },
    uSunColor: { value: new THREE.Color('#ffc98d') },
    uSkyColor: { value: new THREE.Color('#8fa6c4') },
    uSunPow: { value: 0.6 },
    uFog: { value: new THREE.Color('#d9b48c') },
    uFogDensity: { value: 0.0016 },
    uProjScale: { value: 900 },
    uField: { value: field },
    uFieldScale: { value: 1 / ISLAND.size },
    uSeaLevel: { value: SEA + 0.25 },
    uFires: { value: Array.from({ length: MAX_FIRES }, () => new THREE.Vector4(0, 0, 0, 0)) },
  };

  // The wind block, attached BY REFERENCE. There is no second copy of the
  // direction, the clock or the wave bands anywhere in this file; wind.update()
  // writes them once per frame and every layer material sees it. The fallback
  // only exists so a headless harness without a wind can still compile.
  if (ctx.wind && ctx.wind.uniforms) ctx.wind.attach(shared);
  else {
    shared.uWindTime = { value: 0 };
    shared.uWindDir = { value: new THREE.Vector2(0.82, 0.57).normalize() };
    shared.uWindStr = { value: 1 };
    shared.uWindWave = {
      value: [new THREE.Vector4(0.0331, 0.463, 0.50, 0.0042),
        new THREE.Vector4(0.1208, 2.054, 0.32, 0.0110),
        new THREE.Vector4(0.3696, 7.390, 0.18, 0.0380)],
    };
    shared.uWindGuide = { value: new THREE.Vector4(0, 0, 0, 0) };
    shared.uWindGuideDir = { value: new THREE.Vector2(1, 0) };
  }

  const texMaple = mapleTexture(96);
  const texPetal = petalTexture(80);
  const texMote = moteTexture(48, 9.0, 0.10);
  const texSpark = sparkTexture(64);
  const texFluff = fluffTexture(80);
  const texHaze = hazeTexture(192);

  // --------------------------------------------------------------
  // Layers. `density` is re-evaluated every frame from time of day.
  // --------------------------------------------------------------
  const L = (o) => makeLayer(o, shared);

  const layers = [
    // Haze banking in the valleys, along the river and out over the water.
    // This is the layer that carries depth: a clear ridge standing in front of
    // a drowned valley is what makes a vista read as miles rather than metres.
    L({
      name: 'haze', seed: 7717, count: 700, cell: { x: 1150, y: 5 },
      map: texHaze, size: 190, sizeMin: 0.60, sizeMax: 1.5, sizeBias: 1.3, aspect: [1.0, 0.13],
      yMin: -2.5, camBias: 5000, fall: 0, speed: 0.55, speedGust: 0.5, spin: 0,
      turb: [3.0, 0.09, 0.05], gustAmp: 0.25, minPx: 1.0, maxGrow: 1.3,
      biome: [0.0, 0.0, 1.20, 0.14], near: 38, far: 780, edge0: 0.30, edge1: 0.484,
      clump: 4, clumpSpread: 120,
      opacity: 0.52, ambient: 0.62, direct: 0.32, scatter: 0.85, phaseG: 0.40,
      maxRad: 1.30, hazeTop: 26,
      defines: ['YBILLBOARD', 'HAZE'], order: 3,
      density: (d) => 0.60 + 0.55 * d.golden + 0.40 * d.night,
    }),

    // Crimson maple and gold, thickest over the forest mask. Lit, never
    // emissive: warm bodies that go translucent when the sun is behind them.
    //
    // Rebuilt after critics counted 3-5 airborne flecks in a whole frame and
    // read them as "unlit dark specks / sensor dust". Four separate causes:
    //   * density was 0.016 leaves/m3, and clump 30 / spread 10 covered barely
    //     a quarter of the cell, so most of the field genuinely had none;
    //   * uSpeed 3.4 m/s against a grass front travelling 14 m/s made them
    //     look becalmed next to the field they float over;
    //   * scatter 0.90 / maxRad 1.30 is not enough radiance to read as backlit
    //     against a golden-hour sky, so they went to silhouette;
    //   * nothing masked the sky, so the survivors were flecks on blue.
    // Now: 3.7x the count at 3.7x the density, a 55 m radius instead of 34,
    // 8 m/s drift, a much hotter forward lobe, and an elevation mask.
    L({
      // WAVE H: 9000 -> 12000. The sky mask above no longer deletes the
      // sky-backed half of the layer, so the count now has to fill a volume
      // it never had to fill before, and pose 01's box is 40% mountain where
      // wave F's was open sky. Same cell, so this is a density change only.
      name: 'leaves', seed: 1013, count: 12000, cell: { x: 112, y: 12 },
      // sizeMax was 1.55 -> a 0.256 m leaf, and a real maple is 8-20 cm across.
      // 1.28 tops out at 0.211 m, still the big end of plausible, and it is the
      // top of the distribution that produced every oversized chip. maxPx then
      // fades out anything that still grows past 26 px on a 1080p frame, which
      // for the largest leaf means it is simply not drawn inside ~10.5 m.
      map: texMaple, size: 0.165, sizeMin: 0.40, sizeMax: 1.28, sizeBias: 2.2, aspect: [1.0, 1.0],
      yMin: -1.0, camBias: 2.6, fall: 1.05, speed: 8.0, speedGust: 9.0, spin: 1.9,
      turb: [1.9, 1.05, 0.63], gustAmp: 1.2, minPx: 1.2, maxPx: 34.0,
      // A tight growth cap is what keeps size perspective-correct: with
      // maxGrow 1.8 a far leaf could inflate most of a pixel-doubling and stop
      // shrinking with distance, which is why distant leaves measured the same
      // on-screen size as ones next to the tree.
      maxGrow: 1.30,
      biome: [0.55, 0.42, 0.0, 0.36], near: 2.8, far: 95, edge0: 0.33, edge1: 0.487,
      clump: 60, clumpSpread: 14, top0: 0.34, top1: 0.92,
      // See the SKYMASK block in the vertex shader for the arithmetic. Full
      // mask 1.2 degrees above eye level, none 2.9 degrees below it, cancelled
      // wherever the probe finds a hillside or a canopy behind the sprite.
      // skyKill WAS 1.0 and that emptied the sky. See the vertex-shader block.
      // 0.28 keeps roughly three sprites in four over open air, and the pair
      // below is what pays for them: skylight through the card, and a card thin
      // enough for the sky to read through.
      skyFade: [-0.050, 0.021], skyKill: 0.0, canopy: 8.0,
      // WAVE J. Top-of-sky fade — see the block in the vertex shader for the
      // photometry. At this pose the pinhole maths puts 0.100 at screen y = 177
      // and 0.195 at y = 43, and the measured leaf-only veil per 60 px band
      // (x 200-1900, differenced against a group-hidden capture) is:
      //
      //   band        0-60  60-120  120-180  180-240  240-300
      //   no cut     +0.44   +0.22    +0.16    +0.36    +0.17
      //   [.135,.23] +0.28   +0.20    +0.16    +0.36    +0.17
      //   [.100,.195]+0.11   +0.11    +0.16    +0.36    +0.17
      //   [.070,.150]+0.03   +0.02    +0.11    +0.35    +0.17
      //
      // i.e. the band this touches is the top ~180 px and NOTHING below it
      // moves at all. The critic's density box starts at y = 100 and its
      // population is unchanged from y = 120 down.
      skyTop: [0.100, 0.195],
      // WAVE J TONE. SWEPT ON THE RUNNING LANE, pose 01, clock frozen, each
      // variant differenced against a group-hidden capture of the same instant.
      // The metric is the median luma of a leaf blob MINUS the sky it covers,
      // over every blob above screen y = 430:
      //
      //   shipped (glow 2.10 / thin 0.26 / rad 2.40 / trans #ff9a3c)  -3.7, 23% brighter
      //   trans ladder alone   #ffab52 .. #ffd699                     -2.44 .. -2.40
      //   skyGlow ladder alone 2.1 -> 6.5                             -2.46 .. -2.40
      //   maxRad ladder alone  2.4 -> 4.4                             -2.42 .. -2.33
      //   THIS (glow 2.60 / thin 0.30 / rad 2.70 / trans #ffc97e)     +3.07, 86% brighter
      //   one stop hotter      (glow 4.60 / rad 3.40 / thin 0.34)     +3.80, 95% brighter
      //
      // Read the ladders: no single knob moves it. The transmission colour, the
      // skylight gain and the knee ceiling each buy about a tenth of a level on
      // their own, because whichever one you raise, the OTHER two are still
      // clamping. What actually flips the sign is the vSky-scaled knee in the
      // fragment shader; these values then set how far past the sky it goes.
      // The blob-minus-sky delta here is up in red AND green and DOWN in blue,
      // which is a warm golden lamp. That last number is the guard rail: two
      // earlier candidates (trans #ffcf92 and #ffe0bb) also went positive but
      // carried blue with them, and the frame came back reading as SNOW. If a
      // future pass raises this, watch the blue delta, not the luma.
      //
      // AND WATCH THE RIDGE. This is NOT set at the value that maximises the
      // glow, and the reason is defect 4. The far mountain range is a separate
      // backdrop in terrain.js and is NOT in the baked island field this file
      // probes — heightAt() returns the ocean floor (-88) everywhere along a
      // sightline through it, verified by evaluating terrain.heightAt along
      // three rays out to 3400 m — so every sprite standing in front of that
      // range is scored as fully sky-backed and takes the whole transmission
      // treatment. Counting compact bright patches on the ridge (window
      // 1500-1920 x 180-360, >= 20 px, elongation < 1.6, over a 41 px median
      // background):
      //
      //   leaves reverted to the shipped uniforms, this wave's code   8, peak +6.4
      //   glow 2.60 / rad 2.70  (THIS)                                8, peak +6.2
      //   glow 3.20 / rad 2.90                                       11, peak +6.8
      //   glow 4.60 / rad 3.40                                       12-16, peak +8.0
      //
      // The hot end draws twice as many pale discs on a smooth warm slope, which
      // is the lens-flare-ghost artefact I was sent to remove, rebuilt out of
      // the leaves. This setting holds the ridge exactly level with the control
      // and still takes the sky from 52% to 86% of sprites brighter than their
      // background. Do not raise it until the probe can see the backdrop.
      skyGlow: 2.60, skyThin: 0.30,
      streak: 1.15, align: 0.60,
      colA: '#b8451c', colB: '#e08a34',
      // Backlit maple is not dark red, it is a hot amber lamp — this is the
      // colour of the sun AFTER the leaf, not the colour of the leaf.
      trans: '#ffc97e',
      // RADIANCE IS DELIBERATELY UNCHANGED from wave E, and that is a reversal
      // of my own first pass. I lowered these hard (0.44 / 0.72 / 1.15) on the
      // strength of the critic's "flat solid-yellow chips", then went looking
      // for the chips and found that hiding the ENTIRE vfx group leaves them on
      // screen — 15 components >= 120 px, largest 162 x 85, with vfx.group
      // .visible = false. They are grass, not leaves. See the note by the
      // FOLIAGE knee. The airborne leaves' real failure is the opposite one:
      // against a bright sky they read as dark specks, so dimming them was
      // exactly wrong. What stays from that pass is structural, not tonal — the
      // soft knee, the warm transmission tint and the deeper texture ramp.
      // phaseG WAS 0.72 AND THAT IS WHY NOTHING GLOWED. hg() here is normalised
      // so its forward peak is exactly 1.0, which makes a high g a very TIGHT
      // lobe: measured on this pose, the sun sits 31.4 degrees off the view
      // axis (sunDir (-0.200, 0.327, 0.924) vs camera dir (-0.416, -0.169,
      // 0.893), cos = 0.854) and hg(0.854, 0.72) = 0.134. The transmission term
      // that is supposed to carry the backlight was running at an eighth of
      // strength across the whole frame. hg(0.854, 0.32) = 0.75. Real foliage
      // transmission is broad — a leaf held up anywhere near the sun lights up,
      // not only when it eclipses it — so 0.32 is also the physically right end.
      opacity: 0.90, ambient: 0.66, direct: 1.05, scatter: 1.85, phaseG: 0.32,
      // 2.40 -> 2.70. This is the ceiling a leaf standing in front of the LAND
      // still obeys; the fragment shader raises it by (1 + vSky * 1.20) only for
      // the part of the layer that has bright sky behind it, so a hillside leaf
      // moves by an eighth of a stop and a sky-backed one by nearly a stop.
      maxRad: 2.70,
      defines: ['TUMBLE', 'FOLIAGE', 'SKYMASK'], order: 6,
      density: (d) => 0.50 + 0.50 * d.day,
    }),

    // Cherry petals: smaller, slower, flutter harder, drift wider. Same four
    // fixes as the leaves, at a paler and cooler end of the warm range.
    L({
      name: 'petals', seed: 2027, count: 6500, cell: { x: 96, y: 11 },
      map: texPetal, size: 0.098, sizeMin: 0.42, sizeMax: 1.22, sizeBias: 2.2, aspect: [1.0, 1.0],
      yMin: -0.5, camBias: 2.0, fall: 0.80, speed: 6.2, speedGust: 7.0, spin: 2.1,
      turb: [2.1, 1.35, 0.79], gustAmp: 1.1, minPx: 1.2, maxPx: 26.0, maxGrow: 1.30,
      biome: [0.34, 0.46, 0.0, 0.22], near: 2.4, far: 78, edge0: 0.32, edge1: 0.487,
      clump: 40, clumpSpread: 12, top0: 0.32, top1: 0.90,
      // A cherry petal is thinner and paler than a maple leaf, so it keeps more
      // of itself over the sky and glows harder when it is there.
      skyFade: [-0.050, 0.021], skyKill: 0.0, canopy: 8.0,
      skyTop: [0.100, 0.195],
      skyGlow: 3.60, skyThin: 0.30,
      streak: 1.25, align: 0.56,
      colA: '#f3dcd6', colB: '#fff2e2',
      // Isolated on pose 01 this layer was ALREADY reading correctly — 91 blobs
      // in the sky band, every one of them brighter than the sky it covered,
      // median +4.87 luma. Its only fault was its blue: the blob-minus-sky
      // delta was (+8.0, +9.5, +3.9), and blue that far up is the difference
      // between a lit petal and a snowflake. #ffd9b4 is linear blue 0.456;
      // this is 0.271. A cherry petal is meant to stay paler and pinker than
      // the maple, so it keeps more blue than the leaves do, just not that much.
      trans: '#ffd2a0',
      opacity: 0.72, ambient: 0.62, direct: 0.95, scatter: 1.55, phaseG: 0.30,
      maxRad: 2.90,
      defines: ['TUMBLE', 'FOLIAGE', 'SKYMASK'], order: 6,
      density: (d) => 0.40 + 0.60 * d.day,
    }),

    // Dust in the low sun. A shallow volume around the camera so the air in
    // front of you is never empty, whatever the terrain is doing. The phase
    // lobe does the work: motes toward the sun shimmer, motes away vanish.
    L({
      name: 'dust', seed: 3037, count: 7200, cell: { x: 68, y: 14 },
      map: texMote, size: 0.030, sizeMin: 0.6, sizeMax: 1.9, sizeBias: 2.0, aspect: [1.0, 1.0],
      yMin: -1.5, camBias: 5.0, fall: 0.12, speed: 1.30, speedGust: 1.1, spin: 0,
      turb: [0.55, 0.72, 0.41], gustAmp: 0.5, minPx: 1.0, maxGrow: 2.2,
      // THE "LENS-FLARE GHOST ORBS" WERE THESE. A dust mote is 0.030 * up to
      // 1.9 = 0.057 m across, and uProjScale measured 1303.7 on this frame, so
      // one drifting 2 m from the lens draws at 0.057*1303.7/2 = 37 px — an
      // additive, warm, perfectly round soft disc with a halo, hanging in clear
      // sky nowhere near the sun. That is a lens-flare ghost by construction.
      // A cap at 13 px keeps every mote small enough to read as air.
      //
      // WAVE J: 13 -> 9. 13 px was still a readable DISC. Measured on the
      // shipped wave-I capture of 01-sunset-ridge, the compact round bright
      // patch nearest the two coordinates a critic called flare ghosts —
      // (1863, 275) — is at (1832, 293): 140 px of area, elongation 1.45,
      // +5.5 luma over the slope behind it, i.e. a 13.4 px diameter warm disc,
      // exactly this cap. Hiding the whole vfx group removes it and every other
      // disc in that crop, and postfx's sun glow is still running in that
      // capture, so these are mine and not the glow's. The reference frames do
      // carry bokeh, but bokeh in them is a texture of many small motes, never
      // one isolated coin on a smooth slope; below ~9 px they stop resolving as
      // discs and start reading as air.
      maxPx: 9.0,
      biome: [0.22, 0.28, 0.22, 0.70], near: 1.0, far: 42, edge0: 0.26, edge1: 0.478,
      clump: 14, clumpSpread: 7.0,
      // Sun-caught dust belongs in the air over the land, the way it does in
      // every Ghost reference frame — never as spots on open sky. Additive
      // motes are far more forgiving than an opaque leaf, so this mask keeps a
      // residue instead of cutting to nothing.
      // The ghost orbs were the missing maxPx above, NOT the sky. Sun-caught
      // motes drifting across a bright sky are the bokeh the reference frames
      // are full of, so this only thins them.
      skyFade: [-0.035, 0.035], skyKill: 0.40, canopy: 8.0,
      colA: '#ffd6a0', colB: '#fff3df',
      opacity: 0.62, ambient: 0.16, direct: 0.42, scatter: 2.60, phaseG: 0.82,
      maxRad: 2.20,
      additive: true, defines: ['ADDITIVE', 'SKYMASK'], order: 8,
      density: (d) => 0.42 + 0.55 * d.golden + 0.25 * d.day,
    }),

    // Seed fluff over open grassland: bigger, slower, very floaty.
    L({
      name: 'pollen', seed: 4049, count: 2000, cell: { x: 88, y: 11 },
      map: texFluff, size: 0.12, sizeMin: 0.5, sizeMax: 2.0, sizeBias: 2.2, aspect: [1.0, 1.0],
      yMin: -0.8, camBias: 2.6, fall: 0.26, speed: 1.6, speedGust: 1.5, spin: 0,
      turb: [1.5, 0.55, 0.33], gustAmp: 0.9, minPx: 1.3, maxGrow: 2.0,
      // Same ghost-orb arithmetic as the dust, and worse: a seed head is
      // 0.12 * up to 2.0 = 0.24 m, so at 5 m it draws 63 px. The fluff texture
      // is a bright core inside a wide halo, which is precisely a flare ghost.
      // WAVE J: 19 -> 13, same reasoning as the dust cap above. This layer is
      // nearly absent at pose 01 (2 blobs in the whole sky band), so the change
      // is unmeasurable there; it is here because a seed head is TWICE the
      // diameter of a dust mote and its texture is a bright core in a wide
      // halo, so it is the layer most able to draw a coin when the meadow
      // density mix does put one near the lens.
      maxPx: 13.0,
      skyFade: [-0.035, 0.040], skyKill: 0.45, canopy: 8.0,
      biome: [-0.10, 1.00, 0.0, 0.16], near: 1.7, far: 52,
      clump: 12, clumpSpread: 9, top0: 0.40, top1: 0.95,
      colA: '#ffeac4', colB: '#fffaf0',
      opacity: 0.42, ambient: 0.22, direct: 0.45, scatter: 1.20, phaseG: 0.70,
      maxRad: 1.35,
      additive: true, defines: ['ADDITIVE', 'SKYMASK'], order: 7,
      density: (d) => (0.25 + 0.60 * d.golden + 0.35 * d.day) * (1 - d.night),
    }),

    // Fireflies: dusk and night only, low over meadow and forest floor.
    L({
      name: 'fireflies', seed: 5059, count: 1800, cell: { x: 70, y: 4.0 },
      map: texSpark, size: 0.075, sizeMin: 0.6, sizeMax: 1.5, sizeBias: 1.6, aspect: [1.0, 1.0],
      yMin: 0.35, camBias: 1.6, fall: 0, speed: 0.5, speedGust: 0.35, spin: 0,
      turb: [0.85, 0.62, 0.29], gustAmp: 0.4, minPx: 1.8, maxGrow: 2.2,
      biome: [0.45, 0.60, 0.25, 0.42], near: 1.3, far: 55,
      clump: 9, clumpSpread: 7,
      colA: '#b6f27e', colB: '#ffe08a',
      opacity: 0.95, ambient: 0.0, direct: 0.0, scatter: 0.0,
      emissive: 2.8, maxRad: 4.2,
      additive: true, defines: ['ADDITIVE', 'PULSE'], order: 9,
      density: (d) => d.night,
    }),

    // Embers spiralling up out of registered fire sources.
    L({
      name: 'embers', seed: 6067, count: 600, cell: { x: 1, y: 7.0 },
      map: texSpark, size: 0.055, sizeMin: 0.5, sizeMax: 1.8, sizeBias: 1.8, aspect: [1.0, 1.0],
      yMin: 0, camBias: 5000, fall: -1.9, speed: 0, speedGust: 0, spin: 0,
      turb: [0.4, 1.1, 0.6], gustAmp: 0.6, minPx: 1.6, maxGrow: 2.4,
      biome: [0, 0, 0, 1], near: 0.6, far: 70,
      colA: '#ff5f0e', colB: '#ffc885',
      opacity: 1.0, ambient: 0.0, direct: 0.0, scatter: 0.0,
      emissive: 3.0, maxRad: 5.0,
      additive: true, defines: ['ADDITIVE', 'FIRE'], order: 9,
      extraFn: (i) => i % MAX_FIRES,
      density: () => 1,
    }),
  ];

  for (const l of layers) group.add(l.mesh);

  /* ---------------- fire registry ---------------- */
  const fires = shared.uFires.value;
  let fireCursor = 0;
  function addFire(x, y, z, radius = 0.6) {
    const i = fireCursor % MAX_FIRES;
    fireCursor++;
    fires[i].set(x, y, z, radius);
    return i;
  }
  function setFire(i, x, y, z, radius) {
    if (i >= 0 && i < MAX_FIRES) fires[i].set(x, y, z, radius);
  }
  function clearFires() { for (const f of fires) f.set(0, 0, 0, 0); }

  /* ---------------- guiding-wind burst ----------------
   * The visible half of "call the guiding wind". wind.blowToward() launches the
   * corridor in the shared field — every layer's windGust()/windDirAt() already
   * picks that up as a gust head racing toward the objective. This adds the
   * three things the field alone cannot do:
   *   1. thickens the leaf and petal layers so there is something to carry;
   *   2. raises each layer's gust amplitude so the shove is larger than any
   *      ambient gust can produce, which is what makes the beat legible;
   *   3. bends each layer's accumulated DRIFT toward the corridor, so the
   *      whole flurry streams down the lane instead of across it. Bending the
   *      drift is safe because it is an integral; bending uWindDir would pivot
   *      every wavefront in the game, which is the bug this replaced.
   * Safe to call with no arguments — quest.js does.                          */
  let pulse = 0, pulseDecay = 1;
  function guidingWind(strength = 1.4, seconds = 2.2) {
    pulse = Math.max(pulse, strength);
    pulseDecay = strength / Math.max(seconds, 0.1);
  }

  /* ---------------- per-frame ---------------- */
  const _size = new THREE.Vector2();
  const _drift = new THREE.Vector2(0.82, 0.57).normalize();
  let time = 0, quality = 1;

  const api = {
    group, layers, field, MAX_FIRES,
    addFire, setFire, clearFires, guidingWind,
    get quality() { return quality; },
    setQuality(q) {
      quality = clamp(q, 0.1, 1);
      for (const l of layers) l.mesh.geometry.instanceCount = Math.max(1, Math.round(l.count * quality));
    },
    update(dt, c) {
      const cam = c.camera;
      time += dt;
      shared.uTime.value = time;
      shared.uCam.value.copy(cam.position);

      // ---- wind ------------------------------------------------------------
      // Nothing to copy: uWindDir/uWindStr/uWindWave/uWindGuide are wind.js's
      // own uniform objects, already written by wind.update() this frame.
      const wind = c.wind;
      const gustStr = shared.uWindStr.value;
      if (pulse > 0) pulse = Math.max(0, pulse - pulseDecay * dt);

      // ---- advection: integrate the drift, never recompute it from t -------
      // rate is d(advection)/dt of the old closed form, so the look is
      // preserved while the unbounded arm — and the sideways sweep any wind
      // rotation used to apply to it — is gone.
      // Stream the flurry down the guiding corridor for the length of the call,
      // by ROTATING the prevailing direction through a fraction of the signed
      // angle to the corridor — the identical construction windDirAt() uses,
      // and for the identical reason.
      //
      // This was `_drift.lerp(wind.guideDir, t)` followed by a normalize, which
      // is the exact pattern wind.js was rewritten to eliminate. It is only well
      // behaved while the two directions are within ~90 degrees; fire the
      // corridor upwind and the mixed vector walks through zero length and the
      // normalized result flips. MEASURED on this code, prevailing 35.0 deg and
      // a corridor fired dead upwind at -145.0 deg: the leaf layer's uDrift step
      // direction held at -145.0 deg from t = 0.008 s to t = 1.046 s, then
      // SNAPPED to +36.8 deg in a single frame at t = 1.101 s. The whole leaf
      // field reverses 178 degrees mid-beat.
      //
      // A rotation is unit length at every t and every angle — wind.dir is unit,
      // and a rotation preserves length — so there is no degenerate case and no
      // normalize to guard. At t = 1 it lands exactly on wind.guideDir.
      const wdir = wind ? wind.dir : shared.uWindDir.value;
      _drift.copy(wdir);
      if (pulse > 0 && wind && wind.guiding > 0) {
        const gd = wind.guideDir;
        const bend = clamp(pulse * 0.7, 0, 0.8);
        const ang = Math.atan2(wdir.x * gd.y - wdir.y * gd.x,
          wdir.x * gd.x + wdir.y * gd.y) * bend;
        const s = Math.sin(ang), cs = Math.cos(ang);
        _drift.set(wdir.x * cs - wdir.y * s, wdir.x * s + wdir.y * cs);
      }
      for (const l of layers) {
        if (l.fire) continue;                       // embers ride their source
        const rate = (l.speed + (gustStr - 0.72) * l.speedGust) * (1 + pulse * 0.6);
        const d = l.mat.uniforms.uDrift.value;
        const cw = l.mat.uniforms.uCell.value.x;
        d.x += _drift.x * rate * dt;
        d.y += _drift.y * rate * dt;
        // Fold into the cell. The shader mods by uCell.x anyway, so removing a
        // whole number of cells changes nothing on screen but keeps the value
        // small enough that float32 never loses sub-centimetre precision.
        d.x -= Math.round(d.x / cw) * cw;
        d.y -= Math.round(d.y / cw) * cw;
        l.mat.uniforms.uGustAmp.value = l.gustAmpBase * (1 + pulse * 1.1);
      }

      // ---- light ----
      let sunPow = 0.5;
      if (c.sky) {
        shared.uSunDir.value.copy(c.sky.sunPos).normalize();
        shared.uSunColor.value.copy(c.sky.sun.color);
        if (c.sky.hemi) {
          shared.uSkyColor.value.copy(c.sky.hemi.color)
            .multiplyScalar(clamp(0.30 + c.sky.hemi.intensity * 0.75, 0.22, 1.15));
        }
        sunPow = clamp(c.sky.sun.intensity / 3.4, 0, 1);
      }
      if (c.scene.fog) {
        shared.uFog.value.copy(c.scene.fog.color);
        shared.uFogDensity.value = c.scene.fog.density;
      }
      // How lit the air actually is. Falls back to fog luminance so a twilight
      // sun that has already switched off cannot kill the motes outright.
      const fc = shared.uFog.value;
      const skyLum = 0.2126 * fc.r + 0.7152 * fc.g + 0.0722 * fc.b;
      const air = clamp(Math.max(sunPow, skyLum * 0.95), 0.12, 1);
      shared.uSunPow.value = air;

      // ---- time-of-day mixes ----
      const alt = c.tod ? c.tod.sunAltitude : 20;
      // "Golden" has to cover the whole low-sun window, not just the last few
      // degrees: the hero poses sit at 13-24 degrees of altitude, which is
      // still raking light, still long shadows, still full of visible air.
      const d = {
        day: sstep(alt, -6, 9),
        night: 1 - sstep(alt, -9, 1.5),
        golden: sstep(alt, -14, 2) * (1 - sstep(alt, 18, 45)),
        air,
      };
      for (const l of layers) {
        let v = l.density(d);
        if (l.name === 'leaves' || l.name === 'petals') v *= 1 + pulse * 0.75;
        l.mat.uniforms.uDensity.value = clamp(v, 0, 1.6);
      }

      // ---- the screen-space size floor needs the real projection scale ----
      c.renderer.getDrawingBufferSize(_size);
      shared.uProjScale.value = _size.y / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5));

      // ---- optional externally-registered fires ----
      const ext = c.state && c.state.fires;
      if (ext && ext.length) {
        for (let i = 0; i < MAX_FIRES; i++) {
          const f = ext[i];
          if (f) fires[i].set(f.x, f.y, f.z, f.r ?? 0.6);
          else fires[i].w = 0;
        }
      }
    },
  };

  if (ctx.state) ctx.state.vfx = api;
  if (typeof window !== 'undefined') window.__VFX = api;
  return api;
}
