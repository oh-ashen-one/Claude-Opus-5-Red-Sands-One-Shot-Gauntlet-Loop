import * as THREE from 'three';
import { QUALITY } from '../core/quality.js';
import { heightAt, ISLAND } from './terrain.js';
import { fbm } from '../util/noise.js';
import { mulberry32 } from '../util/rng.js';
import { WIND_UNIFORMS_GLSL, WIND_GLSL } from './wind.js';

// ============================================================================
//  KAZE NO MICHI — grass, scrub and pampas.
//
//  This is the single most identifiable surface in the game, so it is built as
//  a real field rather than a scatter of blades:
//
//  * FIVE nested instanced layers, each a square field that follows the camera.
//    Density is graded by ring, not by radial rejection, because a square field
//    can be wrapped TOROIDALLY: when the camera walks forward, blades that fall
//    off the back edge are re-derived on the front edge, where the ring's
//    distance fade has already shrunk them to nothing. Nothing ever pops.
//  * CLUMPS, not uniform scatter. Every blade is pulled toward a hashed tussock
//    centre; the tussock owns its height, dryness, splay direction and value, so
//    the field reads as tufted ground rather than static noise.
//  * THREE species chosen by a biome mask sampled off the terrain: fine meadow
//    grass, low scrub on slopes and dry ground, and susuki pampas plumes that
//    only grow in stands on gentle, mid-altitude open ground.
//  * TRAVELLING GUST FRONTS along ctx.wind.dir. Phase is a function of the
//    blade's position projected on the wind vector, sharpened with a smoothstep,
//    so visible bands of bend sweep across the field. Blades also swing their
//    bend direction toward the wind as the gust builds — the whole field leans
//    together, which is the thing your eye actually reads as "wind".
//  * A blade bends as a CIRCULAR ARC of preserved length, so it never stretches
//    or shrinks as it bows, and the surface normal is exact.
//  * Strong backlit transmission plus a retro-reflective hot spot, so the field
//    glows both when you look into the low sun and when it is behind you.
//  * Sub-pixel blades are widened to a minimum screen width and cross-faded
//    toward the average field colour, which kills the crawling aliasing that
//    thin instanced geometry always produces at distance and makes the far field
//    settle into a solid mass of colour.
//
//  Ground truth for placement is the terrain lattice: heights are sampled on
//  exactly the vertex grid PlaneGeometry gives terrain.js and bilinearly
//  interpolated, so blade roots sit on the rendered surface rather than on an
//  analytic surface the mesh never actually reaches.
// ============================================================================

// One knob for the whole budget. 1.0 = shipping density.
const DENSITY = QUALITY.grass;   // 1.0 = shipping density; scaled by tier

const KIND = { COVER: 0, BLADE: 1, PAMPAS: 2 };

// R          half-size of the square field, metres (also the fade-out radius)
// fadeFrom   radius at which the ring starts shrinking to nothing
// cell       tussock cell size, metres
// pull       how hard blades are drawn into their tussock, 0..1
const LAYERS = [
  {
    key: 'cover', kind: KIND.COVER, count: 300000, R: 13, fadeFrom: 8.4, segs: 2,
    cell: 0.70, pull: 0.20, hScale: 1.0, minPx: 1.5, covFloor: 0.45,
    curve: 0.70, normalUp: 0.55, bendScale: 0.34, bendMax: 1.55, clearIn: 0.30, clearOut: 0.85,
    thinIn: 0.5, thinOut: 1.9, order: 0, defines: { COVER: '' },
  },
  {
    key: 'near', kind: KIND.BLADE, count: 300000, R: 28, fadeFrom: 18.0, segs: 4,
    cell: 1.25, pull: 0.28, hScale: 1.0, minPx: 1.5, covFloor: 0.50,
    // clearIn/Out were 0.45/1.30, which let a full-height blade sit half a metre
    // from the lens and eat 70% of the frame — taller than the camera, which the
    // rubric forbids outright. Nothing reaches full height inside 1.6 m now.
    curve: 0.78, normalUp: 0.26, bendScale: 1.00, clearIn: 0.55, clearOut: 1.60,
    thinIn: 0.6, thinOut: 2.3, order: 1, defines: {},
  },
  {
    // hScale was 1.18 here and 1.32 on `far`: distant blades were a THIRD taller
    // in world units than the ones at your feet, which is an impossible scale
    // relationship and reads as the ground receding wrongly. Coverage at
    // distance is the minimum-screen-width term's job, not the height's.
    key: 'mid', kind: KIND.BLADE, count: 300000, R: 70, fadeFrom: 49, segs: 3,
    cell: 1.70, pull: 0.32, hScale: 1.05, minPx: 1.5, covFloor: 0.40,
    curve: 0.72, normalUp: 0.34, bendScale: 0.92, clearIn: 0.0, clearOut: 0.01,
    thinIn: 0.6, thinOut: 2.3, order: 2, defines: {},
  },
  {
    key: 'far', kind: KIND.BLADE, count: 200000, R: 150, fadeFrom: 87, segs: 2,
    cell: 3.20, pull: 0.36, hScale: 1.10, minPx: 1.9, covFloor: 0.26,
    curve: 0.70, normalUp: 0.50, bendScale: 0.80, clearIn: 0.0, clearOut: 0.01,
    thinIn: 0.6, thinOut: 2.3, order: 3, defines: {},
  },
  {
    // The susuki plumes are the tallest, most wind-legible thing in the field —
    // they are what GoT uses to sell wind — so they must be the LOOSEST layer,
    // not the stiffest. They were bendScale 0.62 / bendMax 1.15 against the
    // meadow's 1.00 / 1.70 and stood as rigid spikes through a field leaning
    // hard. A plume now bows further and faster than the grass around it, and
    // its head whips a beat behind the culm (see the PLUME branch in VERT).
    // BEND CEILING, wave F. bendMax was 2.05 rad = 117 degrees, i.e. the culm
    // was allowed to be driven a quarter-turn PAST horizontal. Through the
    // corridor beat that is exactly what happened: shots/judge-e-motion/
    // pampas-whip.png is three frames of the same stand, and between the first
    // and the second every plume head has left the silhouette — the culms lie
    // down into the cover grass and the frame loses the one element that was
    // reading the wind. A plume that bows to 80 degrees is still a plume; one
    // that bows to 117 is a stick on the ground.
    //
    // 1.40 rad = 80 degrees. MEASURED with tools/plume-bend.mjs, which reads
    // wind.js's CPU twin (wind.sample) at the real roots of every live plume
    // within 45 m of the 02-grass-field camera and reruns this layer's own
    // bend arithmetic — rest + gust*0.88*1.35 through softBend() — under both
    // ceilings, ambient and 0.6 s into a real blowToward() corridor:
    //
    //   ambient        m = 2.05:  p05 0.126  p50 0.350  p95 0.776  max 0.962
    //                  m = 1.40:  p05 0.126  p50 0.350  p95 0.776  max 0.954
    //   corridor 0.6s  m = 2.05:  p05 0.129  p50 0.557  p95 1.742  max 1.854
    //                  m = 1.40:  p05 0.129  p50 0.557  p95 1.336  max 1.367
    //
    // So ambient lean is untouched to three decimals through p95 — softBend()
    // is identity below its knee at 0.62*m = 0.868 rad and almost nothing
    // ambient reaches it — and what changes is only the crest of the corridor
    // front: p95 99.8 -> 76.5 degrees, max 106.2 -> 78.3. The plume still goes
    // from 20 degrees at rest to a 78-degree bow and springs back; it just
    // never passes horizontal. softBend() is strictly increasing, so the
    // front keeps a leading and a trailing edge rather than clipping flat.
    //
    // This is deliberately the safe half of the coordination with the wind
    // lane, who is reducing the corridor GAIN from their side: a ceiling and a
    // gain cannot cancel into stillness the way two gain cuts would — if their
    // change lands, the crest simply stops reaching this ceiling and the
    // ceiling does nothing.
    key: 'pampas', kind: KIND.PAMPAS, count: 58000, R: 58, fadeFrom: 40, segs: 6,
    cell: 1.35, pull: 0.50, hScale: 1.0, minPx: 1.0, covFloor: 0.62,
    curve: 0.75, normalUp: 0.30, bendScale: 1.35, bendMax: 1.40, clearIn: 1.0, clearOut: 2.8,
    thinIn: 1.4, thinOut: 4.4, order: 4, defines: { PLUME: '' },
    trans: 0.82, retro: 0.30,
  },
];

// Runner wake. A single radial bubble taken from the character's CURRENT
// position has no history: at a 7 m/s sprint the grass stands back up a full
// metre behind him, and a 15 m/s gallop uses the same 2.3 m circle. The trail
// is a short ring of past positions, each carrying the heading he was on, so
// blades are pushed down, laid ALONG the motion, and spring back.
const TRAIL_N = 16;            // slot 0 is the live position, 1..N-1 the history
const TRAIL_LIFE = 1.6;        // seconds for a flattened lane to stand back up
const TRAIL_STEP = 0.45;       // metres between stored footprints at walking pace
const TRAIL_MAX_DT = TRAIL_LIFE / (TRAIL_N - 1);  // ...and a time cap, so a gallop
                                                  // still fills the whole ring
// Radius scale for slot 0 — the live position, which never ages out, so this
// is the disc a STANDING character presses forever. See the long block in the
// wake loop in VERT: at 1.0 it is the bald ring the critics measured at the
// hero's boots. 0.40 leaves 0.24/0.92 m on the meadow layers and 0.56/1.76 m
// on the pampas: he parts the grass at his shins instead of mowing a circle.
const FOOT_R = 0.40;

// The travelling gust fronts come from wind.js's shared field (WIND_GLSL) —
// see the contract block at the top of src/world/wind.js. Grass owns only its
// own AMPLITUDE (uBendScale, and WIND_GAIN below); the field itself is shared
// with trees.js and vfx.js so all three blow in one wind.
//
// WIND_GAIN carries the two scalars that used to live on grass's private copy
// of the wind: the 0.95 it applied when it wrote uWindStr itself (illegal now —
// uWindStr is shared by reference and writing it would corrupt every other
// consumer), and the ratio between the mean of grass's old front model and the
// mean of windGust(). Measured: old mean ~0.30, windGust mean ~0.34.
const WIND_GAIN = 0.88;

// ---- per-clump wind identity (wave I) --------------------------------------
// See the long block above the clump section in VERT. These add VARIATION
// INSIDE the shared field — an offset at which a tussock samples it, a
// stiffness, and a splay direction that the gust overrides. None of them has a
// phase, a wavelength or a clock, so none of them is a second wind.
const CLUMP_JIT = 4.5;      // m, how far a tussock's sample point wanders
const CLUMP_STIFF = 0.20;   // +-20% response, i.e. 0.80 .. 1.20
const CLUMP_SPLAY = 0.45;   // clump-coherent azimuth weight in a dead calm

// ---------------------------------------------------------------------------
//  Terrain / biome field cache
//
//  heightAt() is ten octaves of noise; calling it a million times would freeze
//  the tab. Instead the world is sampled on the terrain mesh's OWN vertex
//  lattice and interpolated. That is both ~300x cheaper and strictly more
//  correct: it reproduces the surface the terrain mesh actually renders.
// ---------------------------------------------------------------------------
const LAT = ISLAND.size / ISLAND.seg;        // 6.25 m — terrain vertex spacing
const LAT_O = -ISLAND.size * 0.5;            // lattice origin
const FIELD_EXT = 235;                       // half-extent cached around camera
const FIELD_N = Math.ceil((FIELD_EXT * 2) / LAT) + 3;
const FIELD_SLACK = 28;                      // rebuild once camera drifts this far
const CH = 5;                                // h, slope, meadow, dry, pampas

function createFieldCache() {
  const data = new Float32Array(FIELD_N * FIELD_N * CH);
  const raw = new Float32Array(FIELD_N * FIELD_N);
  let ox = 0, oz = 0, valid = false;

  function rebuild(cx, cz) {
    const i0 = Math.floor((cx - FIELD_EXT - LAT_O) / LAT);
    const j0 = Math.floor((cz - FIELD_EXT - LAT_O) / LAT);
    ox = LAT_O + i0 * LAT;
    oz = LAT_O + j0 * LAT;
    for (let j = 0; j < FIELD_N; j++) {
      const z = oz + j * LAT;
      for (let i = 0; i < FIELD_N; i++) {
        raw[j * FIELD_N + i] = heightAt(ox + i * LAT, z);
      }
    }
    for (let j = 0; j < FIELD_N; j++) {
      const z = oz + j * LAT;
      const jm = Math.max(j - 1, 0), jp = Math.min(j + 1, FIELD_N - 1);
      for (let i = 0; i < FIELD_N; i++) {
        const x = ox + i * LAT;
        const im = Math.max(i - 1, 0), ip = Math.min(i + 1, FIELD_N - 1);
        const dhx = (raw[j * FIELD_N + ip] - raw[j * FIELD_N + im]) / ((ip - im) * LAT);
        const dhz = (raw[jp * FIELD_N + i] - raw[jm * FIELD_N + i]) / ((jp - jm) * LAT);
        const k = (j * FIELD_N + i) * CH;
        data[k] = raw[j * FIELD_N + i];
        // slope = 1 - n.y, matching terrain.js's convention.
        data[k + 1] = 1 - 1 / Math.sqrt(1 + dhx * dhx + dhz * dhz);
        // Meadow mask: five octaves so patchiness exists at 300 m AND at 20 m.
        data[k + 2] = fbm(x * 0.0032 + 4.1, z * 0.0032 - 2.6, 5) * 0.5 + 0.5;
        // Dryness: biased warm so golden hour reads gold, not jade.
        data[k + 3] = Math.min(1, Math.max(0, fbm(x * 0.0040 + 2.7, z * 0.0040 - 1.3, 4) * 1.25 + 0.62));
        // Pampas stands: mid-scale, so susuki grows in readable blocks.
        data[k + 4] = fbm(x * 0.0088 + 31.7, z * 0.0088 - 12.3, 3) * 0.5 + 0.5;
      }
    }
    valid = true;
  }

  // One set of bilinear weights, five channels — the hot loop of the scatter.
  const out = new Float32Array(CH);
  function sample(x, z) {
    let fx = (x - ox) / LAT, fz = (z - oz) / LAT;
    let i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0) i = 0; else if (i > FIELD_N - 2) i = FIELD_N - 2;
    if (j < 0) j = 0; else if (j > FIELD_N - 2) j = FIELD_N - 2;
    const u = Math.min(Math.max(fx - i, 0), 1);
    const v = Math.min(Math.max(fz - j, 0), 1);
    const w00 = (1 - u) * (1 - v), w10 = u * (1 - v), w01 = (1 - u) * v, w11 = u * v;
    const a = (j * FIELD_N + i) * CH, b = a + CH;
    const c = ((j + 1) * FIELD_N + i) * CH, d = c + CH;
    for (let k = 0; k < CH; k++) {
      out[k] = data[a + k] * w00 + data[b + k] * w10 + data[c + k] * w01 + data[d + k] * w11;
    }
    return out;
  }

  return {
    sample, rebuild, data,
    get valid() { return valid; },
    get ox() { return ox; },
    get oz() { return oz; },
    get cx() { return ox + FIELD_EXT; },
    get cz() { return oz + FIELD_EXT; },
    needs(x, z) { return !valid || Math.abs(x - (ox + FIELD_EXT)) > FIELD_SLACK || Math.abs(z - (oz + FIELD_EXT)) > FIELD_SLACK; },
  };
}

// Integer hash — tussock identity must be a pure function of the world cell so
// that a blade wrapping across the field lands in a consistent clump.
function ihash(x, y, s) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

// How well grass grows here, 0..1. Blades and the ground carpet both read this,
// so the field and its ground can never disagree about where grass ends.
function fertility(h, slope, meadow) {
  if (h < 3.3 || h > 168 || slope > 0.46) return 0;
  let f = clamp01((meadow - 0.10) * 3.4);
  f *= clamp01(1 - (slope - 0.15) * 3.0);
  f *= clamp01((h - 3.3) / 3.5);
  // MEASURED, wave E. This ramp used to start at 115 m and reach zero at 170,
  // i.e. it began fading a third of the way up the island and was already at
  // 0.59 on the 01-sunset-ridge hero pose (mean h = 137.6 in the near band).
  // Sampled at 15 m around every pose, altitude was the ONLY factor costing
  // that frame anything — meadow 0.86, slope 1.00, low-cut 1.00, altitude 0.59
  // — and the resulting near-band census was 145,783 cover blades against the
  // coast's 273,695 and the meadow's 227,658. That 2x deficit is precisely the
  // critic's "flat yellow smear with sparse thin dark hair-strokes drawn on
  // top", and it is pose-specific rather than global, which is why 03-coast and
  // 05-summit read as a real field from the same code.
  // Tsushima's ridges are grassed to the top (see references/field_24.png — the
  // whole hillside is a solid mass of susuki), so the fade now holds full
  // density to 140 m and runs out at 172, just past the 168 m hard cut above,
  // instead of thinning the uplands out from halfway.
  f *= clamp01(1 - (h - 140) / 32);
  return f;
}

// ---------------------------------------------------------------------------
//  Procedural susuki plume texture. Alpha only: a fan of fine tapered hairs
//  radiating from the base of the plume, which is what gives pampas its
//  feathered silhouette instead of reading as a flag on a stick.
// ---------------------------------------------------------------------------
function makePlumeTexture() {
  const W = 96, H = 288;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, W, H);
  g.lineCap = 'round';
  const r = mulberry32(0x5115A);

  // A solid core down the middle of the plume, erased toward the tip. A plume
  // made purely of strokes reads as a torn flag; a plume with no strokes reads
  // as a cardboard triangle. It needs both: a mass, feathered at the edges.
  const core = g.createLinearGradient(0, 0, W, 0);
  core.addColorStop(0.00, 'rgba(255,255,255,0)');
  core.addColorStop(0.46, 'rgba(255,255,255,0.04)');
  core.addColorStop(0.50, 'rgba(255,255,255,0.80)');
  core.addColorStop(0.54, 'rgba(255,255,255,0.04)');
  core.addColorStop(1.00, 'rgba(255,255,255,0)');
  g.fillStyle = core;
  g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'destination-out';
  const taper = g.createLinearGradient(0, 0, 0, H);
  taper.addColorStop(0.00, 'rgba(0,0,0,1)');
  taper.addColorStop(0.34, 'rgba(0,0,0,0)');
  g.fillStyle = taper;
  g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'source-over';

  // Solid-ish spine so the plume never reads as a hollow ring of hairs.
  for (let i = 0; i < 22; i++) {
    const len = 0.34 + Math.pow(r(), 0.7) * 0.42;
    const sgn = r() < 0.5 ? -1 : 1;
    const sp = Math.pow(r(), 1.4) * 0.20;
    g.strokeStyle = `rgba(255,255,255,${0.55 + 0.35 * r()})`;
    g.lineWidth = 1.3 + r() * 1.6;
    g.beginPath();
    g.moveTo(W * 0.5 + (r() - 0.5) * 5, H);
    g.quadraticCurveTo(W * (0.5 + sgn * sp * 0.4), H * (1 - len * 0.5), W * (0.5 + sgn * sp), H * (1 - len));
    g.stroke();
  }
  // The fan. Hairs that reach furthest out also droop, like real silver grass.
  //
  // The spread exponent is the whole character of the head. It was pow(r, 0.62),
  // which biases every hair OUTWARD, so 130 hairs at near-full alpha laid about
  // 2.5x more ink than the head's own area and the texture was simply solid —
  // no alpha cutoff between 0.34 and 0.52 changed the render at all, because
  // there was nothing but core to cut. pow(r, 1.15) puts the mass on the spine
  // and thins toward the fringe, and the fringe hairs are also dimmer, so the
  // alpha ramps down across the last quarter of the head instead of ending at a
  // wall. That ramp is what the fragment's fringe term below reads.
  for (let i = 0; i < 104; i++) {
    const sgn = r() < 0.5 ? -1 : 1;
    const spread = Math.pow(r(), 1.15);
    const len = 0.40 + Math.pow(r(), 0.85) * 0.58;
    const droop = spread * 0.16 * r();
    const x0 = W * 0.5 + (r() - 0.5) * W * 0.05;
    const xEnd = W * (0.5 + sgn * spread * 0.47);
    const yEnd = H * (1 - len + droop);
    g.strokeStyle = `rgba(255,255,255,${(0.95 - 0.42 * spread) * (0.78 + 0.22 * r())})`;
    g.lineWidth = 1.15 + r() * 1.25;
    g.beginPath();
    g.moveTo(x0, H * 0.995);
    g.quadraticCurveTo(W * (0.5 + sgn * spread * 0.13), H * (1 - len * 0.52), xEnd, yEnd);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
//  Shaders
// ---------------------------------------------------------------------------
// Where the susuki HEAD starts along the culm, as a fraction of blade length,
// and how much of the blade it occupies. The vertex profile, the fragment's
// texture lookup and the fragment's early-out all have to agree about this, so
// it is written once and pasted into both shaders.
const PLUME_T0 = 0.60;
const PLUME_SPAN = (1 - PLUME_T0).toFixed(2);
const PLUME_GLSL = /* glsl */`
  #define PLUME_T0 ${PLUME_T0}
  #define PLUME_SPAN ${PLUME_SPAN}
`;

const VERT = /* glsl */`
  #include <common>
  #include <shadowmap_pars_vertex>
` + PLUME_GLSL + WIND_UNIFORMS_GLSL + WIND_GLSL + /* glsl */`

  uniform float uTime;                       // private detail clock only
  uniform vec4  uTrail[${TRAIL_N}];          // wake sample: x, z, heading, age 0..1
  uniform vec4  uTrailBox;                   // minX, minZ, maxX, maxZ of the live wake
  uniform vec3  uCam;
  uniform vec3  uPlayer;
  uniform float uPxWorld;

  uniform float uFadeR, uFadeFrom;
  uniform float uThinIn, uThinOut;
  uniform float uClearIn, uClearOut;
  uniform float uMinPx, uCovFloor;
  uniform float uCurve, uNormalUp, uBendScale, uBendMax;
  uniform float uCell;    // this layer's tussock cell size, metres

  uniform vec3 uRootLush, uTipLush, uRootDry, uTipDry, uScrubRoot, uScrubTip, uSeedC;
  #ifdef PLUME
    uniform vec3 uCulmC, uPlumeC, uPlumeGold;
  #endif

  attribute vec3 iPos;
  attribute vec4 iA;      // splay angle, height, half-width, resting lean
  attribute vec4 iB;      // dryness, tussock value, species, ambient occlusion

  varying vec3 vWorld;
  varying vec3 vN;
  varying vec3 vAlb;
  varying vec4 vP;        // t (root..tip), u (across), ao, thickness
  #ifdef PLUME
    // x: plume u.  y: distance-relaxed alpha cutoff.  z: the head's width in
    // SCREEN PIXELS, which is what gates the fibre octaves in the fragment —
    // a fibre band narrower than two pixels is not fibre, it is aliasing.
    // w: this plume's own fibre phase, so no two heads carry the same pattern.
    varying vec4 vPl;
  #endif

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  // ---- gust envelope: contrast, not a second field --------------------------
  // THE UNIFORM COMB, wave I, half one of two. The field was already carrying
  // wind.js's three travelling fronts — that part was never broken — but the
  // crest-to-trough CONTRAST the eye gets to see was low, so a front read as a
  // gradient rather than as a front.
  //
  // FIRST, THE AMBIENT DISTRIBUTION, RE-MEASURED (tools-side script driving
  // wind.js's own CPU twin, createWind() + update(1/60), no corridor, 900
  // points per sampled frame over a 240x240 m square, 60 frames across 4 s,
  // n = 54,000):
  //
  //     windGust  mean 0.425  p10 0.143  p50 0.432  p90 0.706  p99 0.881  max 0.993
  //
  // That is NOT what the contract block at the top of wind.js documents — it
  // states mean 0.240 / p50 0.235 / p90 0.404 / p99 0.514 / max 0.655, and says
  // it was re-measured and identical to the digit after wave F. Every number
  // here is ~1.75x that. The shape of the two distributions agrees, so it looks
  // like a scale factor (a different api.strength, or a sample taken before
  // uWindStr was folded in) rather than a drift in the field. It matters for
  // anyone tuning a knee against those figures, so it is in the report as an
  // unresolved item for the wind lane; the numbers used HERE are the ones this
  // build actually produces, measured on this build.
  //
  // WHAT THAT BOUGHT, before: windGust p10..p90 = 0.143..0.706, times WIND_GAIN
  // 0.88 and the near layer's uBendScale 1.0, on a resting lean of 0.16..0.50 —
  // a blade's total lean ran 24.2 deg at the trough to 56.3 deg at the crest.
  // 32 degrees is not nothing, but it is spread smoothly over wavelengths of
  // 190, 52 and 17 m and every blade inside a band answers with the SAME 32, so
  // there is no edge anywhere for the eye to catch as a wave front.
  //
  // This is NOT a new wave stack — that is the sin wind.js exists to prevent,
  // and nothing here has a phase, a wavelength or a clock of its own. It is a
  // pure pointwise transfer function on the SHARED field's own value: push the
  // deviation about the ambient MEDIAN out by GUST_K, clamp at zero so a trough
  // goes properly still, and roll the gain back to 1.0 across 0.90..1.30 so the
  // guiding corridor's head — 1.28 typical / 1.58 worst case, the ceiling wave
  // F spent a whole pass placing — passes through untouched.
  //
  //     windGust    0.143   0.432   0.706   0.881   0.993   1.28    1.58
  //     shaped      0.000   0.434   0.855   1.129   1.261   1.283   1.580
  //
  // MEASURED over the same 54,000 samples, and the point of the whole exercise:
  //
  //                     mean    p10     p50     p90     p99     max
  //     windGust        0.425   0.143   0.432   0.706   0.881   0.993
  //     shaped          0.434   0.000   0.434   0.858   1.129   1.260
  //     bend, before    0.703   0.423   0.702   0.982   1.165   1.295  rad
  //     bend, after     0.709   0.331   0.706   1.101   1.307   1.420  rad
  //
  // The MEAN LEAN IS UNCHANGED — 0.703 -> 0.709 rad, 40.3 -> 40.6 degrees — so
  // the field is not being laid over, which is the failure mode wave F was
  // cleaning up. What moved is the spread: p10..p90 goes from 24.2..56.3 deg to
  // 19.0..63.1, i.e. 32 degrees of crest-to-trough range becomes 44, with the
  // low tail pinned flat at zero so a trough is properly STILL and a front
  // therefore has a leading edge instead of a gradient.
  //
  // One honest wart: the roll-off makes the curve non-monotone by 0.0001 near
  // g = 1.15 (0.006 degrees of bend — four orders of magnitude below anything
  // renderable). Widening the roll-off to 0.92..1.50 removes it exactly, but it
  // also carries the corridor peak 1.28 -> 1.43, which is 12% of wave F's GAIN
  // cut handed back. The wiggle is the cheaper of the two.
  #define GUST_MID  0.43
  #define GUST_K    1.55
  float gustShape(float g) {
    float k = mix(GUST_K, 1.0, smoothstep(0.90, 1.30, g));
    return max(GUST_MID + (g - GUST_MID) * k, 0.0);
  }

  // ---- THE shared wind field ------------------------------------------------
  // This used to be a private stack of three sines with constants that existed
  // nowhere else in the codebase, so grass, trees and vfx literally blew in
  // three different winds. wind.js is the single source now: windGust() above
  // is ITS evaluation, phase-locked to uWindTime, and it already carries
  // uWindStr — so this is a gain, never a second field.
  float windAt(vec2 p) { return gustShape(windGust(p)) * ${WIND_GAIN.toFixed(3)}; }

  // ---- soft bend ceiling ----------------------------------------------------
  // MEASURED, wave E, with tools/probe-bend.mjs reading ctx.wind.sample() —
  // the CPU twin of windGust() — out of the running game. The bend used to be a
  // hard min(raw, uBendMax).
  //
  // Be precise about the size of this, because the brief overstated it: over a
  // 80x90 m patch the guiding corridor's gust runs p50 0.35, p95 0.92, peak
  // 1.55-1.61, against an ambient p50 0.48 / p95 0.66. So most of the corridor
  // never comes near the 1.70 ceiling; what saturates is the CREST of the
  // travelling front, about 0.6% of the area weighted over the blade layers'
  // rest range of 0.16-0.50. But that crest is the brightest, most-looked-at
  // part of the wave, and there the clipping was total: raw 1.71 / 1.88 / 2.05
  // for rest 0.16 / 0.33 / 0.50 all mapped to exactly 1.700, i.e. the spatial
  // gradient of bend went to ZERO across the front — and that gradient is the
  // only thing the eye can read as a wave passing rather than a patch of field
  // lying down.
  //
  // This is identity below a knee at 0.62*m and then decays exponentially onto
  // m, C1-continuous at the knee (value k, slope 1) and strictly increasing
  // forever after. On the near/mid/far blade layers (m = 1.70, knee 1.054)
  // ambient raw is rest 0.16..0.50 plus a measured gust of 0.11..0.66, i.e.
  // 0.27..1.16, all below the knee — the probe confirms hard() and soft() agree
  // to three decimals on every ambient sample, so ambient is untouched, not
  // "approximately unchanged". At the crest the measured 1.71 / 1.88 / 2.05 now
  // map to 1.466 / 1.520 / 1.562 instead of 1.700 / 1.700 / 1.700: 0.096 rad,
  // about 5.5 degrees of surviving spread and ~8 cm of tip travel on a metre
  // blade. Small, but it is the difference between a front with a leading and a
  // trailing edge and a front with neither, because the ORDERING is preserved.
  //
  // Honest caveat: the COVER layer is the exception. Its resting bend is large
  // by design (rest 0.78..1.33 against m = 1.55, knee 0.961) so the top of its
  // ambient range does cross the knee and the flattest cover blades now sit at
  // 1.32 rad where they used to clamp at 1.52. On a 0.20 m blade that is 1.6 cm
  // of tip height — sub-pixel past a couple of metres, and it costs coverage
  // nothing because a slightly more upright blade occludes slightly more ground.
  // The wake is unaffected: press*1.55 drives cover far past the ceiling either
  // way, so a trampled lane still lies flat.
  float softBend(float raw, float m) {
    float k = m * 0.62;
    if (raw <= k) return raw;
    float s = m - k;
    return m - s * exp(-(raw - k) / s);
  }

  void main() {
    float dirA = iA.x, hgt = iA.y, hw = iA.z, rest = iA.w;
    float dry  = iB.x, shade = iB.y, spc = iB.z, ao0 = iB.w;

    float t = uv.y;
    float u = uv.x * 2.0 - 1.0;

    float dRoot = length(iPos.xz - uCam.xz);

    // Ring LOD. Blades sink away over a wide band; because a wrapped blade
    // always re-enters at the outer edge, it re-enters at zero height.
    float fade  = 1.0 - smoothstep(uFadeFrom, uFadeR, dRoot);
    float clear = smoothstep(uClearIn, uClearOut, dRoot);
    float vanish = fade * clear;

    // ---- the runner's wake -------------------------------------------------
    // press = how flattened this blade is, 0..1. Every live trail sample is a
    // disc of crushed grass that recovers over its own lifetime, so the wake is
    // a LANE behind the character rather than a bubble centred on him, and it
    // scales with speed for free: fast travel simply lays down more samples.
    float press = 0.0;
    vec2  layAcc = vec2(0.0);
    // Cheap reject first: the wake occupies a few tens of square metres and the
    // CPU hands us its bounding box, so almost every blade in a 150 m ring pays
    // four comparisons instead of walking the ring buffer.
    if (all(greaterThan(iPos.xz, uTrailBox.xy - uThinOut)) &&
        all(lessThan(iPos.xz, uTrailBox.zw + uThinOut))) {
      for (int i = 0; i < ${TRAIL_N}; i++) {
        vec4 s = uTrail[i];
        float rec = max(1.0 - s.w * s.w, 0.0);      // springs back, fast at first
        // THE BALD RING, wave I. Slot 0 is not a footprint — it is the LIVE
        // position, rewritten every frame with age 0, so rec never decays for
        // it. A MOTIONLESS character therefore presses a permanent disc of
        // radius uThinOut: 1.9 m of cover, 2.3 m of meadow and 4.4 m of susuki,
        // centred on the one place in the frame the eye is already looking.
        // MEASURED on 01-sunset-ridge with the blade layers rendered against
        // the sky (terrain, carpet, trees and water hidden) so blade coverage
        // is a pixel count and not a guess, wind clock frozen so the A and B
        // frames are the same instant:
        //     region                      shipped    slot-0 radius -> 0
        //     boots  x760-1180 y790-940     66.33%        72.89%   +6.56
        //     wake   x600-1300 y760-1080    67.81%        71.93%   +4.12
        //     left control  x0-600          88.02%        89.36%   +1.34
        //     right control x1400-1920      59.53%        60.23%   +0.70
        // i.e. a 6.6-point hole in blade coverage at his boots against a
        // ~1-point control drift. The camera-radius cull (uClearIn/uClearOut)
        // was measured the same way in the same session and is INNOCENT here:
        // zeroing it moved the boots patch 67.98% -> 65.85%, inside the noise
        // and the wrong way, because at this pose the ring is a 1.6 m cylinder
        // under a camera 5.49 m behind the player and 2.17 m up — entirely
        // below the bottom of the frame. It is left exactly as it is.
        //
        // The footprint of a standing man is a boot, not a bicycle wheel. Slot
        // 0 gets FOOT_R of the wake radius; slots 1..N-1 — the lane he actually
        // ran through, which is the effect that was wanted — keep the full one.
        float rs = i == 0 ? ${FOOT_R.toFixed(2)} : 1.0;
        float w = (1.0 - smoothstep(uThinIn * rs, uThinOut * rs, length(iPos.xz - s.xy))) * rec;
        press = max(press, w);
        layAcc += vec2(cos(s.z), sin(s.z)) * w;
      }
    }
    float thin = 1.0 - press;
    float dp = length(iPos.xz - uPlayer.xz);

    // Crushed grass is LAID DOWN, not deleted: the bend below takes it to
    // uBendMax (flat) so the lane still has grass in it, just horizontal grass.
    // Shrinking it hard as well leaves a bald stripe behind the character.
    //
    // ...which is what 0.58 was still doing. A blade laid flat by press*1.55
    // has already lost most of its silhouette to the camera; taking 42% of its
    // LENGTH away as well is the second half of the bald ring, and unlike the
    // bend it cannot be read as trampling — it reads as grass that is not
    // there. 0.90 keeps a hint of compaction and lets the bend do the work.
    hgt *= vanish * mix(0.90, 1.0, thin);
    hw  *= vanish * mix(0.92, 1.0, thin);

    // ---- the clump reads the field a few metres from its own root ----------
    // The second half of the uniform-comb fix, and the half that has to be
    // done WITHOUT a private wave: every blade in a band was not only bending
    // by the same amount, it was bending in the same phase, because every
    // blade sampled the shared field at its own root and roots are dense. A
    // tussock is one plant. It gets one identity here — a hashed offset of a
    // few metres at which IT reads the shared field, a stiffness, and a splay
    // — so neighbouring tussocks sit at different points on the SAME wave.
    //
    // CLUMP_JIT is deliberately 3.4 m and not more. Against wind.js's band
    // wavelengths (190 / 52 / 17 m) that decorrelates the 17 m chop between
    // adjacent tussocks (up to a fifth of a wavelength) while leaving the 52 m
    // ripple and the 190 m front — the two bands a wave CREST is actually made
    // of — essentially coherent across a stand. Push it past ~6 m and the
    // fronts dissolve into noise, which is the opposite failure.
    vec2  cell   = floor(iPos.xz / uCell);
    float cH1    = hash12(cell * 1.37 + 3.7);
    float cH2    = hash12(cell * 2.11 - 9.1);
    float cH3    = hash12(cell * 0.83 + 17.3);
    vec2  wp     = iPos.xz + (vec2(cH1, cH2) - 0.5) * ${CLUMP_JIT.toFixed(2)};
    // One tussock is woodier than the next. This scales the blade's response
    // to the field, never the field itself.
    float stiff  = ${(1 - CLUMP_STIFF).toFixed(2)} + ${(2 * CLUMP_STIFF).toFixed(2)} * cH3;

    // ---- travelling gust fronts ------------------------------------------
    float ph = hash12(iPos.xz * 0.37) * 6.2831853;
    // windGust() already carries uWindStr; multiplying it again here would
    // square the envelope and is exactly what the shared block forbids.
    float gust = windAt(wp) * stiff;

    // Flutter is TIP-ONLY and tiny. It is texture on top of a coherent lean,
    // never a competing direction — the field has to read as one body of air.
    float flut = 0.055 * gust * sin(uTime * 4.6 + ph);

    float bend = softBend(rest + gust * uBendScale + press * 1.55, uBendMax);

    // The whole field commits to ONE direction. A blade keeps a few degrees of
    // private jitter and nothing more: the old per-blade random azimuth carried
    // 0.80 of the bend vector against the wind's ~1.2, which is why inside a
    // single patch blades leant hard right, hard left and straight up at once.
    float jit = (hash12(iPos.xz * 0.71 + 5.3) - 0.5) * 0.30;
    float cj = cos(jit), sj = sin(jit);
    // windDirAt(), not uWindDir: inside a guiding corridor the local direction
    // bends into the lane, so the grass parts along it for free.
    vec2 w0 = windDirAt(wp);
    vec2 wd = vec2(w0.x * cj - w0.y * sj, w0.x * sj + w0.y * cj);
    vec2 rd = vec2(cos(dirA), sin(dirA));
    // A CLUMP direction, not the old per-blade one — that is the distinction
    // that matters. The per-blade azimuth is what made a single patch lean
    // three ways at once and it stays capped at 0.13. This term is coherent
    // across a tussock and, crucially, it DIES AS THE GUST RISES: in the still
    // trough between two fronts the tussocks show their own splay (up to ~23
    // deg apart, which is the difference between tufted ground and a comb),
    // and as a crest arrives the field aligns onto the wind. That handover is
    // what a wave front looks like from the ground.
    float cA = cH1 * 6.2831853;
    vec2  cd = vec2(cos(cA), sin(cA));
    float splay = ${CLUMP_SPLAY.toFixed(2)} * (1.0 - smoothstep(0.12, 0.85, gust));
    vec2 bv = wd * (0.70 + 1.25 * gust) + cd * splay + rd * 0.13;
    vec2 bd = bv / max(length(bv), 1e-4);

    // Through the wake the blade is laid along the way he went; right beside him
    // it is pushed aside instead, so he parts the grass rather than clipping it.
    vec2 lay  = layAcc / max(length(layAcc), 1e-4);
    vec2 away = (iPos.xz - uPlayer.xz) / max(dp, 1e-3);
    bv = mix(bd, mix(lay, away, 0.34), press * 0.90);
    bd = bv / max(length(bv), 1e-4);

    vec3 up   = vec3(0.0, 1.0, 0.0);
    vec3 fwd  = vec3(bd.x, 0.0, bd.y);
    vec3 side = vec3(-bd.y, 0.0, bd.x);

    // Circular arc of preserved length: the blade bows without stretching.
    float a = max(bend + flut * t, 0.0025);
    #ifdef PLUME
      // Second-order whip. The head reads the gust the culm felt a few metres
      // UPWIND, so it lags the culm through the bend instead of following it
      // rigidly — the flick at the top of a susuki plume is the whole point.
      //
      // FIXED, wave F. This sampled uWindDir — the PREVAILING direction —
      // while the bend vector thirty lines up already used windDirAt(), the
      // LOCAL direction. Inside a guiding corridor those are not the same
      // vector, so through the signature beat the head lagged along a line the
      // air was not moving along: the probe went looking for "the gust this
      // culm felt a moment ago" in a direction the culm was not leaning.
      // w0 is windDirAt(iPos.xz), already computed above for the bend vector,
      // so using it makes the lag collinear with the lean by construction, in
      // the corridor and out of it.
      //
      // MEASURED, tools/plume-lag.mjs, 6,000 live plume roots within 45 m of
      // the 02-grass-field camera, 0.6 s into a real blowToward() corridor,
      // through wind.js's own CPU twins (dirAt / sample / sampleGuide). Be
      // precise about the size of this, because it is a correctness fix and
      // not a dramatic one:
      //   all 6,000 roots   local vs prevailing 24.0 deg   head angle delta
      //                     mean 1.44 deg, max 14.5 deg
      //   the 1,792 inside  local vs prevailing 63.5 deg   head angle delta
      //   the lane (guide                                  mean 2.87 deg,
      //   > 0.30)                                          max 14.5 deg
      // The whole-disc average is small because the corridor is a 15 m
      // half-width lane and most of a 45 m disc is outside it, where the two
      // directions agree by definition. It is the plumes IN the lane — the
      // ones the beat is pointing at — that were lagging up to 14.5 degrees
      // the wrong way.
      // wp, not iPos.xz: the head must lag along the SAME sample line the culm
      // is leaning on, or the clump offset above would put the head on a
      // different point of the wave from its own stem.
      float gLag = windAt(wp - w0 * 4.5) * stiff;
      float aHead = softBend(rest + gLag * uBendScale * 1.28 + press * 1.7, uBendMax);
      a = mix(a, max(aHead, 0.0025), smoothstep(0.30, 1.0, t));
    #endif
    float ang = a * t;
    vec3 spine = iPos + up * (hgt * sin(ang) / a) + fwd * (hgt * (1.0 - cos(ang)) / a);
    vec3 tang  = up * cos(ang) + fwd * sin(ang);

    #ifdef PLUME
      // OBSERVED, wave E, on the first frames that actually had plumes in them
      // (see the census note above — before this wave there were five within
      // 15 m of the hero camera and nobody had ever looked at one up close).
      // The head used to run from t=0.46 to the tip at a peak half-width of
      // 1.0*hw: a 0.11 m wide, 0.81 m long spike. At 5 m that is FOURTEEN
      // screen pixels across a 96-texel-wide fan texture, so the GPU sampled
      // mip ~3 and 130 hairs averaged into one flat value — which is why no
      // alpha cutoff could ever make it feather. A high cutoff kept the core
      // only (a thin stroke); a low cutoff passed the whole envelope, and the
      // near field filled with hard-edged cream DARTS crossing each other in
      // X shapes. Real susuki, and references/field_24.png, is the opposite
      // proportion: a short fat fluffy head on a long bare culm.
      // The head is now 0.26 m wide and 0.60 m long — 2.4x the pixels across,
      // enough for the fan to resolve — and it starts higher up the culm.
      float q = (t - PLUME_T0) / PLUME_SPAN;
      float prof = t < PLUME_T0
        ? mix(0.15, 0.085, t / PLUME_T0)
        : mix(0.085, 2.30, smoothstep(0.0, 0.42, q)) * (1.0 - 0.58 * smoothstep(0.46, 1.0, q));
    #else
      float prof = smoothstep(0.0, 0.10, t) * pow(max(1.0 - t, 0.0), 0.78) * (1.0 - 0.22 * t);
    #endif
    float w = hw * prof;

    // Sub-pixel blades are widened to a floor width and then cross-faded toward
    // the average field colour, which trades geometric aliasing for a solid,
    // correctly-averaged mass of colour at distance.
    float dv = distance(spine, uCam);
    float minHalf = uPxWorld * dv * uMinPx * 0.5 * vanish * step(1e-6, hw);
    float wF = max(w, minHalf);
    float cov = clamp(w / max(wF, 1e-6), uCovFloor, 1.0);

    vec3 nrm = normalize(cross(side, tang));
    vec3 world = spine + side * (u * wF) + nrm * (1.0 - u * u) * w * 0.16;

    // Round the blade across its width, then relax toward vertical with
    // distance so the far field stops sparkling.
    vec3 N = normalize(nrm * cos(u * uCurve) + side * sin(u * uCurve));
    N = normalize(mix(N, up, mix(uNormalUp, 0.80, 1.0 - cov)));

    // ---- root-to-tip colour ----------------------------------------------
    vec3 rootC = mix(uRootLush, uRootDry, dry);
    vec3 tipC  = mix(uTipLush,  uTipDry,  dry);
    if (spc > 0.5 && spc < 1.5) { rootC = uScrubRoot; tipC = uScrubTip; }
    #ifdef COVER
      rootC = mix(rootC, tipC, 0.18);
      tipC = mix(rootC, tipC, 0.82);
    #endif
    vec3 alb = mix(rootC, tipC, smoothstep(0.0, 0.92, t));
    if (spc > 3.5) alb = mix(alb, uSeedC, smoothstep(0.76, 1.0, t));
    #ifdef PLUME
      // VALUE + HUE, wave G. MEASURED on shots/diag2/01-sunset-ridge, using a
      // pixel-exact plume mask (the frame rendered twice, once with grass-pampas
      // hidden, and differenced): the head pixels above L=200 were 2.83% of the
      // whole frame, mean RGB (246,209,166), L p50 211.8 / p95 231.2 / max 244.
      // The sky immediately behind them samples (245,206,166) — the SAME value —
      // so the heads had nothing to be read against and merged into the sky as
      // white paddles. references/field_24.png does the opposite: the susuki
      // heads there are a gold-to-cream RAMP, darkest and most saturated at the
      // collar, and they read against the sky because their body is gold.
      //
      // So the head is now two colours, not one: uPlumeGold at the collar
      // (where the hairs are densest and the sheath still wraps them) running
      // to uPlumeC at the loose bleached fringe. uPlumeC itself is rolled back
      // ~15% (see the uniform block).
      float hq = smoothstep(PLUME_T0 - 0.08, PLUME_T0 + 0.22, t);   // culm -> head
      // The gold has to own the BODY of the head, not just its collar: at
       // 0.05/0.98 the ramp was already 80% cream by mid-head and the plume
       // still read pink-cream overall. 0.13/1.04 keeps the lower two thirds
       // gold and lets only the fringe bleach, which is the proportion in
       // references/field_24.png.
      float tq = smoothstep(PLUME_T0 + 0.13, 1.04, t);              // collar -> tip
      alb = mix(uCulmC, mix(uPlumeGold, uPlumeC, tq), hq);
      // The head needs its OWN value ramp, for the same reason every blade in
      // this file has one. Without it the head is a single flat cream value
      // from the collar to the tip, which is most of why it read as a paper
      // cut-out pasted on the field rather than a mass of hairs with a shaded
      // underside. The collar of a real susuki head — where the hairs are
      // densest and the sheath still wraps them — is the darkest part of the
      // plant above the culm; only the loose fringe at the top bleaches out.
      // VALUE, wave I. 1.02 at the tip is where the "flat near-white paddle"
      // read comes from: it BRIGHTENS the loose fringe above the albedo the
      // ramp above chose, on the one part of the head with the least material
      // in it. 0.92 deepens the same ramp instead of moving the whole head:
      // the gold collar is 6% down, the cream fringe 10%, so the gold-to-cream
      // contrast that references/field_24.png actually shows goes UP while the
      // head stops being the brightest note in the frame by itself. Measured
      // below; the near band is watched because wave G's harder cut emptied it.
      alb *= mix(0.58, 0.92, smoothstep(PLUME_T0, 0.97, t));
    #endif
    alb *= shade;
    // Value gradient in the albedo itself, on top of the occlusion below. In
    // the reference the bottom half of every clump is dead sheath and shadow;
    // only the top third is bleached straw. Ours was one flat unmodulated
    // yellow root to tip, which is most of why the field read as painted.
    #ifndef PLUME
      alb *= mix(0.34, 1.08, smoothstep(0.02, 0.66, t));
    #endif
    #ifdef PLUME
      vec3 fieldC = mix(uCulmC, uPlumeC, 0.62) * shade;
    #else
      // The distance colour is the CLUMP average, so it takes the mean of that
      // ramp — otherwise the far field lights up brighter than the near field.
      vec3 fieldC = mix(rootC, tipC, 0.60) * shade * 0.76;
    #endif
    vAlb = mix(fieldC, alb, cov);

    // Ambient occlusion at the blade base. A tussock is a solid mass of stems:
    // no sky and no sun reach the bottom 20% of it. This ramp plus the albedo
    // ramp above is the whole difference between a field with 3D volume and a
    // field of unshaded ribbons.
    float ao = ao0 * mix(0.12, 1.0, smoothstep(0.0, 0.62, t));
    #ifdef PLUME
      // VALUE, wave F. This was mix(0.35, 1.75, ...). thick multiplies the
      // transmission term outright, and the pampas layer also runs uTrans 0.95
      // against the meadow's 0.62 — so a plume head was glowing 1.75*0.95 =
      // 1.66 against a grass tip's 1.00*0.62 = 0.62, i.e. 2.7x, on top of an
      // albedo that is brighter than the meadow's AND is the one albedo in the
      // file with no root-to-tip value ramp on it. Measured on
      // shots/wave-e/05-summit.png, the lower 45% of the frame has a median
      // luma of 92.7 and 5.4% of it above 180 — the plumes were a second,
      // brighter population sitting on top of the field rather than the
      // lightest note within it. 1.25 with uTrans 0.82 puts the head at 1.03,
      // still 1.7x a grass tip, which is what a head of translucent hairs
      // against a low sun should be.
      float thick = mix(0.35, 1.25, smoothstep(PLUME_T0 - 0.06, 0.95, t));
    #else
      float thick = mix(0.18, 1.0, pow(t, 1.25));
    #endif

    vWorld = world;
    vN = N;
    vP = vec4(t, u, ao, thick);
    #ifdef PLUME
      // Alpha-test cutoff for the plume fan. OBSERVED once the census fix put
      // enough plumes in frame to actually look at one: at 5 m a plume is ~14
      // screen pixels across a 96-pixel-wide texture, so it is already sampling
      // mip 2-3 and the fan hairs have averaged down well below the old 0.56
      // cutoff. Only the solid core survived and every near plume read as an
      // opaque flat dart rather than a feathered susuki head. Lower near, so
      // the fan comes back; lower still far, because mip averaging pulls the
      // whole quad toward the texture's ~0.3 mean alpha and a high cutoff makes
      // distant plumes flicker out instead of settling into a solid mass.
      // Third channel: the head's screen width in pixels. uPxWorld * dv is the
      // world size of one pixel at this depth (it is what the minHalf term
      // above is built from), so 2*wF divided by it is the quad's width in
      // pixels. The fragment turns each fibre octave on only once a band of it
      // is at least two pixels wide.
      float headPx = (2.0 * wF) / max(uPxWorld * dv, 1e-6);
      // Without a per-plume phase every head in the frame carries an IDENTICAL
      // band pattern at the same u — fifty copies of one texture, which the eye
      // reads as a repeat almost faster than it reads the fibre itself.
      vPl = vec4(uv.x, mix(0.30, 0.19, smoothstep(8.0, 48.0, dv)), headPx,
                 hash12(iPos.xz * 1.93 + 7.7) * 6.2831853);
    #endif

    // The field is what the sun casts its shadows ONTO: without these two lines
    // the tree and character shadows were being drawn on terrain that the grass
    // then covered up, and the whole surface read as flat unlit yellow.
    //
    // SHADOW NORMAL OFFSET, wave G. FOUND BY READING three 0.185.1's own source,
    // not by looking at a frame: shadowmap_vertex.glsl.js only computes
    // shadowWorldNormal only under "ifdef HAS_NORMAL", falling back to
    // vec3(0.0) otherwise; WebGLPrograms.js:307 sets HAS_NORMAL from
    // "!! geometry.attributes.normal". These five blade layers are
    // InstancedBufferGeometry carrying position / uv / iPos / iA / iB and NO
    // normal attribute — a blade's normal does not exist until this shader
    // builds it — so directionalLightShadows[0].shadowNormalBias has been a
    // SILENT NO-OP on every blade in the game. The ground carpet below sets a
    // real normal attribute and terrain.js's mesh has one, so both of those DO
    // receive the offset: grass was the one surface in the frame taking the sun
    // shadow on different terms from the ground it stands on.
    //
    // That matters more, not less, once the shadow frustum is reworked:
    // sky.js:1307 recomputes normalBias = NB_TEXELS(0.6) * ty every frame, where
    // ty is one shadow texel measured in world Y — so it GROWS in proportion to
    // the frustum, and so does the discrepancy. Reproducing the chunk's own
    // offset here with the blade's real runtime normal makes grass track that
    // one knob exactly: no new heuristic, no private bias, and identically zero
    // if sky.js ever sets normalBias to 0.
    #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
      vec4 worldPosition = vec4(world + N * directionalLightShadows[0].shadowNormalBias, 1.0);
    #else
      vec4 worldPosition = vec4(world, 1.0);
    #endif
    vec3 transformedNormal = mat3(viewMatrix) * N;
    #include <shadowmap_vertex>

    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }`;

const FRAG = /* glsl */`
  #include <common>
  #include <packing>
  #include <shadowmap_pars_fragment>
` + PLUME_GLSL + /* glsl */`

  uniform vec3  uSunCol, uSkyCol, uGndCol, uAmbCol;
  uniform vec3  uSunDir, uCam, uFogCol, uTransTint, uZenith;
  uniform float uFogDensity, uTrans, uRetro, uSheen, uSunSat;
  uniform float uShadeFill, uShadeCool;
  #ifdef PLUME
    uniform sampler2D uPlumeTex;
    uniform float uFibre;
  #endif

  varying vec3 vWorld;
  varying vec3 vN;
  varying vec3 vAlb;
  varying vec4 vP;
  #ifdef PLUME
    varying vec4 vPl;
  #endif

  const float INV_PI = 0.3183098862;

  // Same helper trees.js uses. A raw ShaderMaterial gets no shadow plumbing
  // unless it asks for it: lights:true on the material, the shadowmap chunks in
  // both stages, and this one sample of the sun's map.
  float sunShadow() {
    #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
      DirectionalLightShadow ds = directionalLightShadows[0];
      return getShadow(directionalShadowMap[0], ds.shadowMapSize, ds.shadowIntensity,
                       ds.shadowBias, ds.shadowRadius, vDirectionalShadowCoord[0]);
    #else
      return 1.0;
    #endif
  }

  void main() {
    float pFringe = 1.0;
    float pFibre = 1.0;
    #ifdef PLUME
      if (vP.x > PLUME_T0) {
        float fq = (vP.x - PLUME_T0) / PLUME_SPAN;
        float aT = texture2D(uPlumeTex, vec2(vPl.x, fq)).a;
        if (aT < vPl.y) discard;

        // ---- LENGTHWISE FIBRE -------------------------------------------
        // MEASURED: the head pixels above L=200 on 01-sunset-ridge had a
        // 7x7 interior luma SD whose median was 17.2 — and almost all of that
        // is the outline, not the inside. Inside a head the alpha texture is
        // its own solid core (see makePlumeTexture: a 0.80-alpha spine, and
        // 104 hairs whose alpha averages to a plateau), so at the 20-40 screen
        // pixels a near head actually occupies, every texel that survives the
        // cutoff carries the SAME albedo. That is the whole "flat white paddle".
        //
        // The breakup cannot come out of the alpha texture: alpha is the
        // silhouette, and driving value from it would just re-cut the edge.
        // It cannot be an opacity channel either — partial alphaToCoverage on
        // this ANGLE/Metal target is a hard 4x4 screen door, established.
        // So it is a VALUE field, three incommensurate bands ACROSS the head
        // (that is what makes it lengthwise: constant along a hair, varying
        // between hairs), sheared outward with height so the hairs fan from
        // the collar instead of forming a comb.
        //
        // Each octave is gated on vPl.z, the head's width in screen pixels,
        // so a band never gets narrower than ~2 px. 44/(2pi) = 7 bands across,
        // 101 -> 16, 207 -> 33; the gates are 2x those widths.
        float fu = vPl.x + (vPl.x - 0.5) * 0.55 * fq;
        // WHY THE HEADS WERE STILL FLAT PADDLES, wave I. The three octaves
        // below are gated on the head's screen width so no band is ever
        // narrower than ~2 px — correct, and it is why nothing aliases. But
        // MEASURED on this build, with a pixel-exact plume mask (the frame
        // rendered twice, once with grass-pampas hidden, and differenced):
        //
        //   pose             plume px   head px above L200      brightest decile
        //   01-sunset-ridge   25.07%    0.96% of frame          (246,214,172)
        //   02-grass-field    35.54%    0.33% of frame          (243,213,168)
        //
        // and the 7x7 interior luma SD inside an eroded head mask came out at
        // 15.2 on the ridge but 3.97 on 02-grass-field — i.e. the head that is
        // actually near the camera has some fibre and the ordinary mid-field
        // head has none at all. The reason is arithmetic, not tuning: a head
        // at the size the field is mostly made of measures 8-14 px across, so
        // o1 = smoothstep(9, 18, 11) = 0.06, o2 = o3 = 0, fib collapses to ~0,
        // and pFibre falls back to the CONSTANT 1 - uFibre*0.5. A constant is
        // not fibre. It is a slightly darker paddle.
        //
        // o0 is the octave that fixes that: three bands across the head
        // (19/2pi = 3.0), so a band is 2 px wide on a head only 6 px across and
        // it can be gated at 4-9 px and be fully on for essentially every head
        // that is large enough to read as a head at all. The finer octaves keep
        // their gates and now ride on top of it.
        float o0 = smoothstep(4.0,   9.0, vPl.z);
        float o1 = smoothstep(9.0,  18.0, vPl.z);
        float o2 = smoothstep(16.0, 34.0, vPl.z);
        float o3 = smoothstep(42.0, 84.0, vPl.z);
        float ph = vPl.w;
        float fib = 0.50 * o0 * sin(fu *  19.0 - fq *  2.2 + ph * 1.6 + 0.9)
                  + 0.34 * o1 * sin(fu *  44.0 + fq *  3.1 + ph)
                  + 0.22 * o2 * sin(fu * 101.0 - fq *  5.7 + ph * 2.7 + 1.7)
                  + 0.12 * o3 * sin(fu * 207.0 + fq *  2.3 + ph * 5.3 + 4.1);
        // The four amplitudes sum to 1.18, so on a head big enough to run all
        // four the sum can leave [-1, 1] and the "darkening only" rule below
        // would be broken at the top. Clamped, not renormalised: the point of
        // the extra octave is that the COARSE band survives alone at small
        // sizes, and renormalising would scale it back down again.
        fib = clamp(fib, -1.0, 1.0);
        // Fibre is a DARKENING only: hairs cast on each other, they do not
        // emit. Keeping the top at 1.0 means the head's peak value is still
        // the peak value the ramp above chose, and the mean drops instead.
        pFibre = 1.0 - uFibre * (0.5 - 0.5 * fib);
        // VOLUME. Everything else in this block is gated on screen size, so a
        // 10 px head has always been lit as a flat sheet however good the
        // shading of a 40 px one is. A susuki head is a round tuft: the hairs
        // at the silhouette edge are seen end-on and through more of their own
        // neighbours than the ones at the middle. This is one smoothstep on
        // the across-head coordinate, it costs nothing, and — the point — it
        // has NO size gate, so it is the one thing giving the far half of a
        // susuki stand a lit side and a shaded side.
        pFibre *= 1.0 - 0.30 * smoothstep(0.20, 1.0, abs(vPl.x * 2.0 - 1.0));
        // An alpha TEST can only ever produce a hard, stair-stepped silhouette,
        // and at 30 screen pixels across there is no room to draw individual
        // hairs — so the head read as a cream paper cut-out with a jagged edge.
        // The feathering therefore has to happen in VALUE: the last stretch of
        // alpha above the cutoff is the fringe, and it is dimmed toward the
        // culm rather than lit like the solid core. The eye reads that gradient
        // as fluff, and it costs one smoothstep.
        pFringe = smoothstep(vPl.y, vPl.y + 0.30, aT);
      }
    #endif

    vec3 N = normalize(vN);
    if (!gl_FrontFacing) N = -N;
    vec3 V = normalize(uCam - vWorld);
    vec3 L = uSunDir;

    float ndl = dot(N, L);
    float ao = vP.z;
    float thick = vP.w;
    float sh = sunShadow();

    // Wrapped diffuse — grass is not a hard lambertian sheet, and a hard
    // terminator on a blade at a low sun reads as broken geometry.
    float wrapd = clamp((ndl + 0.55) / 1.55, 0.0, 1.0);
    vec3 key = mix(vec3(dot(uSunCol, vec3(0.2126, 0.7152, 0.0722))), uSunCol, uSunSat);
    // ao now runs almost to zero at the blade base, so it multiplies the key
    // nearly outright: the bottom of a clump gets no direct sun at all.
    vec3 direct = key * wrapd * sh * mix(0.08, 1.0, ao);
    vec3 amb = (mix(uGndCol, uSkyCol, 0.42 + 0.58 * (0.5 + 0.5 * N.y))
               + uAmbCol + uZenith * (0.35 + 0.65 * max(N.y, 0.0))) * (0.20 + 0.80 * ao);

    // ---- SHADED-FIELD RESPONSE, wave G -------------------------------------
    // MEASURED on shots/diag2/01-sunset-ridge with a blade-vs-carpet mask (the
    // frame rendered again with every blade layer hidden, and differenced):
    //
    //   block y700-1080 x1100-1920 (shadowed)  blade px  p5 27.2  p50 34.6  p95  89.6  SD 21.0
    //   block y700-1080 x0-800     (lit)       blade px  p5 35.6  p50 85.1  p95 150.0  SD 34.5
    //
    // The whole shadowed half of the near field sits within ~8 luma levels of
    // the frame's own black floor (both blocks bottom out at p5 ~26-27, which
    // is the grade's toe, not this shader). A critic gamma-boosted the region
    // and found the blade detail intact in the buffer, so nothing is missing —
    // the shaded response simply lands in the flat part of the curve, where a
    // 3x albedo ratio between a blade's root and its tip becomes a 3-level
    // difference on screen and the fall-line, the blades and the horse's legs
    // all quantise into one mass.
    //
    // In shadow the ONLY surviving light here is amb, which is a function of
    // N.y alone — and every blade in a stand is near-vertical, so every blade
    // in a stand gets the same ambient. There is nothing left to separate on.
    // This term is the missing one: the sky is enormously bright at this hour
    // (uSkyCol ~1.11, uZenith ~(0.15,0.29,0.59) MEASURED off the live uniforms
    // at pose 01), and a blade standing in a cast shadow is still under all of
    // it. Crucially it is shaped, not flat:
    //   * it scales with the blade's own root-to-tip coordinate, so it MULTIPLIES
    //     the existing structure rather than washing it out — lifting the level
    //     lifts the spread with it,
    //   * it scales with ao, so the inside of a tussock stays dark,
    //   * it only fires where the sun is blocked, so the lit field is untouched
    //     and the shadow lane's contrast is not being undone from here.
    // The tint is deliberately cool (uZenith weighted over uSkyCol): the rubric
    // asks for blue-violet bounce in shadow, and a cool shadow separates from
    // a gold key by hue as well as by value.
    float shadowed = 1.0 - sh;
    vec3 coolSky = mix(uSkyCol, uZenith * 2.2, uShadeCool);
    vec3 fill = coolSky * uShadeFill * shadowed
              * mix(0.16, 1.0, smoothstep(0.02, 0.80, vP.x))
              * (0.24 + 0.76 * ao);

    // Transmission. The first term fires when the camera looks into the sun,
    // the second whenever the far face of the blade is the lit one. Together
    // they are most of the golden hour. A blade standing in a cast shadow is
    // not being lit from behind, so this mostly dies there too.
    float back = pow(max(dot(-V, L), 0.0), 2.5);
    float thru = max(-ndl, 0.0);
    vec3 trans = uSunCol * uTransTint * (back * 1.55 + thru * 0.60)
               * thick * uTrans * mix(0.26, 1.0, sh);

    // Retro-reflection: with the sun at your back the whole field lights up.
    float retro = pow(max(dot(V, L), 0.0), 2.0) * max(ndl, 0.0) * uRetro * sh;

    // The plume fringe is thin, half-lit fluff, not solid head: it takes less
    // direct sun and less of the albedo, so the head fades out into the field
    // instead of ending at a cut-out edge. Transmission is left alone — a hair
    // held up against a low sun is exactly the thing that glows.
    vec3 albF = vAlb * mix(0.42, 1.0, pFringe) * pFibre;
    vec3 col = albF * INV_PI * (direct * mix(0.45, 1.0, pFringe) + amb + fill + trans + key * retro);

    vec3 H = normalize(L + V);
    col += key * sh * pow(max(dot(N, H), 0.0), 26.0) * uSheen * INV_PI * smoothstep(0.2, 0.9, vP.x);

    float d = length(vWorld - uCam);
    float f = 1.0 - exp(-pow(d * uFogDensity, 2.0));
    gl_FragColor = vec4(mix(col, uFogCol, f), 1.0);
  }`;

// ---------------------------------------------------------------------------
//  Ground carpet
//
//  Blades alone can never hide the ground on a hillside seen face-on: a flat
//  field is viewed at a grazing angle, where a knee-high blade occludes many
//  times its own footprint, but a slope tilted toward the camera projects at
//  nearly full area and would need an impossible ten-fold density to cover.
//  Every open-world game solves this the same way — the ground itself is grass,
//  and the instanced blades supply silhouette, parallax and wind on top of it.
//
//  The carpet is a decal built on the terrain's OWN vertex lattice, so it is
//  geometrically identical to the surface it sits on and cannot z-fight or
//  crawl. It is masked by the same fertility field the blades use, so it stops
//  exactly where they stop: no carpet on sand, rock, cliff or waterline.
// ---------------------------------------------------------------------------
function makeMatTexture() {
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const r = mulberry32(0x6BA55);

  // Three independent stroke sets, one per channel, so the same texture can be
  // sampled at three scales without the octaves correlating into visible tiles.
  const chans = [
    { comp: 0, n: 2600, len: 26, wide: 2.4 },
    { comp: 1, n: 1500, len: 52, wide: 4.0 },
    { comp: 2, n: 700, len: 118, wide: 9.0 },
  ];
  const img = g.createImageData(S, S);
  const buf = new Float32Array(S * S * 3).fill(0.5);

  for (const c of chans) {
    for (let k = 0; k < c.n; k++) {
      const x0 = r() * S, y0 = r() * S;
      const a = r() * Math.PI * 2;
      const len = c.len * (0.35 + r() * 0.9);
      const val = (r() < 0.5 ? -1 : 1) * (0.18 + r() * 0.42);
      const wide = c.wide * (0.4 + r() * 0.9);
      const steps = Math.max(2, Math.ceil(len));
      for (let sIdx = 0; sIdx <= steps; sIdx++) {
        const t = sIdx / steps;
        const px = x0 + Math.cos(a) * len * t;
        const py = y0 + Math.sin(a) * len * t;
        const w = wide * (1 - t * 0.75);
        const amp = val * (1 - t) * 0.9;
        const iw = Math.ceil(w);
        for (let dy = -iw; dy <= iw; dy++) {
          for (let dx = -iw; dx <= iw; dx++) {
            const d2 = (dx * dx + dy * dy) / (w * w + 1e-4);
            if (d2 > 1) continue;
            const xi = (((px + dx) | 0) % S + S) % S;
            const yi = (((py + dy) | 0) % S + S) % S;
            buf[(yi * S + xi) * 3 + c.comp] += amp * (1 - d2);
          }
        }
      }
    }
  }
  for (let i = 0; i < S * S; i++) {
    img.data[i * 4] = Math.max(0, Math.min(255, buf[i * 3] * 255));
    img.data[i * 4 + 1] = Math.max(0, Math.min(255, buf[i * 3 + 1] * 255));
    img.data[i * 4 + 2] = Math.max(0, Math.min(255, buf[i * 3 + 2] * 255));
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

const CARPET_VERT = /* glsl */`
  #include <common>
  #include <shadowmap_pars_vertex>
` + WIND_UNIFORMS_GLSL + WIND_GLSL + /* glsl */`

  uniform float uTime;
  attribute vec3 aDat;              // dryness, fertility, unused
  varying vec3 vWorld;
  varying vec3 vNrm;
  varying vec2 vDF;
  varying float vGust;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vNrm = normal;
    vDF = aDat.xy;
    // Literally the same field the blades read — same function, same clock —
    // so ground and field breathe together instead of beating against each
    // other. Same WIND_GAIN, so the carpet's response tracks the blades'.
    vGust = clamp(windGust(wp.xz) * ${WIND_GAIN.toFixed(3)}, 0.0, 1.6);

    vec4 worldPosition = wp;
    vec3 transformedNormal = mat3(viewMatrix) * normal;
    #include <shadowmap_vertex>

    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;

const CARPET_FRAG = /* glsl */`
  #include <common>
  #include <packing>
  #include <shadowmap_pars_fragment>

  uniform sampler2D uMat;
  uniform vec3 uSunCol, uSkyCol, uGndCol, uAmbCol, uSunDir, uCam, uFogCol, uZenith;
  uniform vec3 uMatLush, uMatDry;
  uniform float uFogDensity, uSunSat, uCarpetR;
  uniform float uShadeFill, uShadeCool;
  uniform vec2 uCarpetC;
  varying vec3 vWorld;
  varying vec3 vNrm;
  varying vec2 vDF;
  varying float vGust;
  const float INV_PI = 0.3183098862;

  float sunShadow() {
    #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
      DirectionalLightShadow ds = directionalLightShadows[0];
      return getShadow(directionalShadowMap[0], ds.shadowMapSize, ds.shadowIntensity,
                       ds.shadowBias, ds.shadowRadius, vDirectionalShadowCoord[0]);
    #else
      return 1.0;
    #endif
  }

  void main() {
    // Three octaves of the same tileable stroke texture, one per channel, so
    // nothing repeats at a readable frequency.
    float m1 = texture2D(uMat, vWorld.xz * 0.62).r;
    float m2 = texture2D(uMat, vWorld.xz * 0.118).g;
    float m3 = texture2D(uMat, vWorld.xz * 0.0295).b;
    float m = m1 * 0.44 + m2 * 0.34 + m3 * 0.22;

    // Grass stands vertically however the ground tilts, so the surface that
    // actually catches the light is much closer to horizontal than the terrain.
    vec3 N = normalize(mix(normalize(vNrm), vec3(0.0, 1.0, 0.0), 0.42));
    vec3 V = normalize(uCam - vWorld);
    vec3 L = uSunDir;
    float ndl = dot(N, L);
    float wrapd = clamp((ndl + 0.42) / 1.42, 0.0, 1.0);
    vec3 key = mix(vec3(dot(uSunCol, vec3(0.2126, 0.7152, 0.0722))), uSunCol, uSunSat);

    vec3 alb = mix(uMatLush, uMatDry, vDF.x * 0.92) * (0.32 + 1.34 * m);
    // The carpet breathes with the same gust fronts as the blades, so ground
    // and field never look like two separate systems.
    alb *= 0.94 + 0.12 * vGust;

    vec3 amb = mix(uGndCol, uSkyCol, 0.42 + 0.58 * (0.5 + 0.5 * N.y))
             + uAmbCol + uZenith * (0.45 + 0.55 * max(N.y, 0.0));
    float sh = sunShadow();
    float back = pow(max(dot(-V, L), 0.0), 3.0);

    // ---- canopy shadow ------------------------------------------------------
    // MEASURED, wave F. A critic on 01-sunset-ridge: the lower half is "a dark
    // noise field where individual blades have stopped resolving". Toggling
    // THIS mesh off in the running game (tools/carpet-share.mjs) changes 89.7%
    // of that frame's bottom third by more than 8 levels, mean |diff| 42.2 —
    // the near band is not mostly blades with ground showing through, it is
    // mostly carpet with blades drawn on it. And the carpet was taking the
    // full hemisphere, the full ambient floor, the full zenith fill and a
    // backlight term, as though it were an open field surface, so the gaps
    // between blades never went dark and the strokes had nothing to separate
    // against. The numbers say the same thing: the bottom third of that frame
    // has a 5th-percentile luma of 31.0 and a 5x5 local SD/mean of 0.149,
    // against references/field_2.png's 16.5 and 0.248 over the same band.
    //
    // The ground under a dense stand of grass is one of the darkest surfaces
    // in a field — almost no sky reaches it — so it gets occluded by the
    // canopy density it sits under, which is the same fertility channel that
    // decides whether there are blades here at all.
    //
    // It has to be a NEAR-band effect, and that is not a fudge: within a few
    // metres the carpet is literally the floor beneath resolved blades, but by
    // 34 m it is no longer visible as floor at all — it is standing in for the
    // canopy itself, which is the entire reason this mesh exists (see the
    // block above on face-on slopes). Occluding it out there would darken the
    // whole hillside for nothing. Ambient is cut hardest; the key is cut less,
    // because a sun this low rakes THROUGH the base of a field rather than
    // down onto it, which is exactly the light in field_2.png.
    float dcam = length(vWorld - uCam);
    float canopy = clamp(vDF.y * 1.8 - 0.05, 0.0, 1.0)
                 * (1.0 - smoothstep(6.0, 34.0, dcam));
    // The same shadow fill the blades get, and for the same measured reason.
    // The carpet is 32.4% of the shadowed block on 01-sunset-ridge (blade
    // coverage there is 67.6% against 95.1% in the lit block, because a
    // fall-line is steep and fertility() thins grass on slope), and in the
    // full render those gap pixels measure p50 L=27.4 — the grade's floor.
    // So a third of the shaded field was literally black between the strokes,
    // which is the other half of "an undifferentiated mass" and all of the
    // critic's "ground visible between the hair-strokes". The canopy term
    // above stays exactly as it is — it is what gives the LIT near band its
    // separation — but it is applied to the fill too, so the ground under a
    // dense stand stays the darkest thing in frame either way.
    vec3 fill = mix(uSkyCol, uZenith * 2.2, uShadeCool) * uShadeFill
              * (1.0 - sh) * (0.30 + 0.70 * max(N.y, 0.0)) * mix(1.0, 0.46, canopy);
    vec3 col = alb * INV_PI * (key * wrapd * sh * mix(1.0, 0.76, canopy)
                             + amb * mix(1.0, 0.50, canopy)
                             + fill
                             + key * back * 0.30 * sh * mix(1.0, 0.62, canopy));

    float d = dcam;
    float f = 1.0 - exp(-pow(d * uFogDensity, 2.0));
    col = mix(col, uFogCol, f);

    // Fertility mask, broken up by the finest texture octave so the edge of the
    // grass never reads as a painted outline.
    float a = clamp(vDF.y * 2.0 - 0.06, 0.0, 1.0) * (0.62 + 0.62 * m1);

    // Rim dissolve. This used to fade on distance from the CAMERA while the
    // carpet is a square mesh centred on the height cache, which only re-centres
    // every 28 m — so on the trailing side the mesh simply ended, up to 28 m
    // before the fade had finished, and the field terminated in a straight
    // hard-cut line with bare terrain beyond it. Fade on the square's own
    // Chebyshev distance instead and the edge cannot exist by construction.
    float e = max(abs(vWorld.x - uCarpetC.x), abs(vWorld.z - uCarpetC.y));
    a *= 1.0 - smoothstep(uCarpetR - 78.0, uCarpetR, e);
    gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
  }`;

// A ribbon of `segs` quads. Only uv is read by the shader; position exists so
// three has something to compute a (never used) bounding volume from.
function ribbon(segs) {
  const pos = [], uvs = [], idx = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    pos.push(-0.5, t, 0, 0.5, t, 0);
    uvs.push(0, t, 1, t);
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

export function createGrass(ctx) {
  const group = new THREE.Group();
  group.name = 'grass';

  const cache = createFieldCache();
  const rnd = mulberry32(0xA11CE5);
  const plumeTex = makePlumeTexture();
  const matTex = makeMatTexture();

  // ---- uniforms shared by every layer (one object, one update per frame) ---
  const shared = {
    uTime: { value: 0 },
    uTrail: { value: Array.from({ length: TRAIL_N }, () => new THREE.Vector4(0, -9999, 0, 1)) },
    uTrailBox: { value: new THREE.Vector4(1e9, 1e9, -1e9, -1e9) },
    uCam: { value: new THREE.Vector3() },
    uPlayer: { value: new THREE.Vector3(0, 0, -9999) },
    uPxWorld: { value: 8.6e-4 },

    uSunDir: { value: new THREE.Vector3(0, 0.3, 1) },
    uSunCol: { value: new THREE.Color(1, 0.82, 0.6) },
    uSkyCol: { value: new THREE.Color(0.4, 0.5, 0.7) },
    uGndCol: { value: new THREE.Color(0.2, 0.15, 0.1) },
    uAmbCol: { value: new THREE.Color(0.1, 0.1, 0.1) },
    // The horizon is on fire at sunset but the zenith is still deep blue, and
    // that is the light that fills the shadow side of every blade. Without it
    // the whole field collapses to one saturated orange with no cool anywhere.
    uZenith: { value: new THREE.Color(0.1, 0.15, 0.3) },
    uFogCol: { value: new THREE.Color('#d9b48c') },
    uFogDensity: { value: 0.0016 },

    // Palette. Deep jade at the root, straw gold at the tip; the dryness mask
    // slides each blade between the two families.
    uRootLush: { value: new THREE.Color('#3f4a26') },
    uTipLush: { value: new THREE.Color('#a9a45a') },
    uRootDry: { value: new THREE.Color('#5e4f29') },
    uTipDry: { value: new THREE.Color('#e7c87c') },
    uScrubRoot: { value: new THREE.Color('#33391f') },
    uScrubTip: { value: new THREE.Color('#8a7c42') },
    uSeedC: { value: new THREE.Color('#ecdba4') },
    uCulmC: { value: new THREE.Color('#9a9152') },
    // #e8d3a0 was very nearly the paper white of the sky at this hour. Pulled
    // down and warmed a step: still the lightest thing in the field by a clear
    // margin (the dry meadow tip is #e7c87c under a 0.34-1.08 value ramp, so
    // it averages far below this), but no longer a separate light source.
    //
    // ...which was still not enough. MEASURED with a pixel-exact plume mask on
    // 01-sunset-ridge (see the head block in VERT): head px above L=200 came
    // out at mean RGB (246,209,166), and the sky directly behind them samples
    // (245,206,166). Identical. #dcc192 -> #c9ad80 is a 15% rollback of the
    // LINEAR albedo (0.928x per sRGB channel), which is what finally puts the
    // head below the sky it is drawn against.
    uPlumeC: { value: new THREE.Color('#c9ad80') },
    // The collar. A susuki head is not one colour: it is amber-gold where the
    // hairs are packed and the sheath still wraps them, bleaching to cream only
    // at the loose fringe. references/field_24.png is a hillside of exactly
    // this ramp. Without it the head is one flat value and reads as a paddle
    // however dark you make it.
    uPlumeGold: { value: new THREE.Color('#c2984c') },
    // Depth of the lengthwise fibre darkening in the head. 0 = the old flat
    // paddle. Bracketed below. Raised 0.42 -> 0.50 in wave I now that the
    // coarse octave means the depth is actually spent on TEXTURE at ordinary
    // head sizes rather than on a flat offset (see the fibre block in FRAG).
    uFibre: { value: 0.50 },

    uMatLush: { value: new THREE.Color('#57632f') },
    uMatDry: { value: new THREE.Color('#9d8a4c') },
    uTransTint: { value: new THREE.Color('#ffdeb0') },
    uTrans: { value: 0.62 },
    uRetro: { value: 0.22 },
    uSheen: { value: 0.04 },
    // Sky fill for blades and ground standing in a cast shadow. See the long
    // block in FRAG: this is the term that lifts the shaded half of the near
    // field off the grade's toe so its structure survives. Bracketed below.
    uShadeFill: { value: 1.6 },
    // How far the fill leans from sky colour toward zenith blue-violet.
    uShadeCool: { value: 0.52 },
    // The sunset key light is violently orange (R:G:B near 4:2:1). Grass is a
    // deep scattering volume, so the light that finally leaves it is whiter
    // than the light that went in; without this the field renders as fire.
    uSunSat: { value: 0.60 },
  };

  // ---- THE SHARED WIND, attached ONCE -------------------------------------
  // wind.attach() merges wind.js's own uniform holders into `shared` BY
  // REFERENCE, and every material below Object.assign's `shared` in, so all six
  // grass materials, trees.js and vfx.js end up pointing at the SAME objects.
  // world.js calls wind.update(dt) before any subsystem update, so these are
  // already current when we draw: there is nothing to write per frame, and
  // writing uWindStr here would corrupt it for every other consumer.
  if (ctx && ctx.wind && ctx.wind.attach) ctx.wind.attach(shared);

  const _v2 = new THREE.Vector2();
  const layers = [];

  for (const L of LAYERS) {
    const count = Math.max(1, Math.round(L.count * DENSITY));
    const src = ribbon(L.segs);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', src.getAttribute('position'));
    geo.setAttribute('uv', src.getAttribute('uv'));
    geo.setIndex(src.getIndex());

    const iPos = new Float32Array(count * 3);
    const iA = new Float32Array(count * 4);
    const iB = new Float32Array(count * 4);
    const aPos = new THREE.InstancedBufferAttribute(iPos, 3);
    const aA = new THREE.InstancedBufferAttribute(iA, 4);
    const aB = new THREE.InstancedBufferAttribute(iB, 4);
    aPos.setUsage(THREE.DynamicDrawUsage);
    aA.setUsage(THREE.DynamicDrawUsage);
    aB.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', aPos);
    geo.setAttribute('iA', aA);
    geo.setAttribute('iB', aB);
    geo.instanceCount = count;

    // lights:true is what earns directionalShadowMap / vDirectionalShadowCoord.
    // The lights block must be CLONED per material (three writes into it), but
    // every one of our own uniforms is shared BY REFERENCE so one write a frame
    // still updates the whole system.
    const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.lights, {}]);
    Object.assign(uniforms, shared, {
      uFadeR: { value: L.R },
      uFadeFrom: { value: L.fadeFrom },
      uThinIn: { value: L.thinIn },
      uThinOut: { value: L.thinOut },
      uClearIn: { value: L.clearIn },
      uClearOut: { value: L.clearOut },
      uMinPx: { value: L.minPx },
      uCovFloor: { value: L.covFloor },
      uCurve: { value: L.curve },
      uNormalUp: { value: L.normalUp },
      uBendScale: { value: L.bendScale },
      uBendMax: { value: L.bendMax ?? 1.70 },
      // The tussock lattice the CPU already places blades on (see place()).
      // The shader needs it to derive the same clump id the placement used, so
      // per-clump wind identity lines up with per-clump geometry.
      uCell: { value: L.cell },
    });
    if (L.trans !== undefined) uniforms.uTrans = { value: L.trans };
    if (L.retro !== undefined) uniforms.uRetro = { value: L.retro };
    if (L.kind === KIND.PAMPAS) uniforms.uPlumeTex = { value: plumeTex };

    const mat = new THREE.ShaderMaterial({
      lights: true,
      vertexShader: VERT, fragmentShader: FRAG,
      defines: Object.assign({}, L.defines),
      uniforms, side: THREE.DoubleSide,
      transparent: false, depthWrite: true, depthTest: true,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = L.order;
    mesh.name = 'grass-' + L.key;
    group.add(mesh);

    layers.push({
      ...L, count, mesh, geo, mat, iPos, iA, iB, aPos, aA, aB,
      rawX: new Float32Array(count),
      rawZ: new Float32Array(count),
      cursor: 0,
      // One full wrap sweep every `slices` frames. Nearer rings churn faster
      // because they cross their own boundary sooner.
      slices: L.R < 25 ? 6 : L.R < 90 ? 14 : 24,
    });
  }

  // ---- ground carpet ------------------------------------------------------
  const carpetGeo = new THREE.BufferGeometry();
  const cVerts = FIELD_N * FIELD_N;
  const cPos = new Float32Array(cVerts * 3);
  const cNrm = new Float32Array(cVerts * 3);
  const cDat = new Float32Array(cVerts * 3);
  const cIdx = new Uint32Array((FIELD_N - 1) * (FIELD_N - 1) * 6);
  {
    let t = 0;
    for (let j = 0; j < FIELD_N - 1; j++) {
      for (let i = 0; i < FIELD_N - 1; i++) {
        const a = j * FIELD_N + i, b = a + 1, c = a + FIELD_N, d = c + 1;
        cIdx[t++] = a; cIdx[t++] = c; cIdx[t++] = b;
        cIdx[t++] = b; cIdx[t++] = c; cIdx[t++] = d;
      }
    }
  }
  const aCPos = new THREE.BufferAttribute(cPos, 3);
  const aCNrm = new THREE.BufferAttribute(cNrm, 3);
  const aCDat = new THREE.BufferAttribute(cDat, 3);
  aCPos.setUsage(THREE.DynamicDrawUsage);
  aCNrm.setUsage(THREE.DynamicDrawUsage);
  aCDat.setUsage(THREE.DynamicDrawUsage);
  carpetGeo.setAttribute('position', aCPos);
  carpetGeo.setAttribute('normal', aCNrm);
  carpetGeo.setAttribute('aDat', aCDat);
  carpetGeo.setIndex(new THREE.BufferAttribute(cIdx, 1));

  const carpetUniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.lights, {}]);
  Object.assign(carpetUniforms, shared, {
    uMat: { value: matTex },
    // The mesh's own half-extent, not a camera radius — see the rim dissolve in
    // CARPET_FRAG. Fading has to be finished a few metres before the geometry
    // physically stops or the field ends in a straight cut.
    uCarpetR: { value: FIELD_EXT - 8 },
    uCarpetC: { value: new THREE.Vector2() },
  });
  const carpetMat = new THREE.ShaderMaterial({
    lights: true,
    vertexShader: CARPET_VERT, fragmentShader: CARPET_FRAG,
    uniforms: carpetUniforms,
    transparent: true, depthWrite: false, depthTest: true,
    side: THREE.DoubleSide, polygonOffset: true,
    polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  });
  const carpet = new THREE.Mesh(carpetGeo, carpetMat);
  carpet.frustumCulled = false;
  carpet.renderOrder = -1;
  carpet.name = 'grass-carpet';
  group.add(carpet);

  // Rebuilt only when the height cache moves, i.e. every ~28 m of travel.
  function rebuildCarpet() {
    const ox = cache.ox, oz = cache.oz, D = cache.data;
    for (let j = 0; j < FIELD_N; j++) {
      const jm = Math.max(j - 1, 0), jp = Math.min(j + 1, FIELD_N - 1);
      for (let i = 0; i < FIELD_N; i++) {
        const im = Math.max(i - 1, 0), ip = Math.min(i + 1, FIELD_N - 1);
        const k = j * FIELD_N + i;
        const h = D[k * CH];
        const dhx = (D[(j * FIELD_N + ip) * CH] - D[(j * FIELD_N + im) * CH]) / ((ip - im) * LAT);
        const dhz = (D[(jp * FIELD_N + i) * CH] - D[(jm * FIELD_N + i) * CH]) / ((jp - jm) * LAT);
        const inv = 1 / Math.sqrt(dhx * dhx + 1 + dhz * dhz);
        const nx = -dhx * inv, ny = inv, nz = -dhz * inv;
        // Lift along the normal so the decal can never dip under the surface it
        // is copied from; polygon offset handles the rest.
        cPos[k * 3] = ox + i * LAT + nx * 0.05;
        cPos[k * 3 + 1] = h + ny * 0.05;
        cPos[k * 3 + 2] = oz + j * LAT + nz * 0.05;
        cNrm[k * 3] = nx; cNrm[k * 3 + 1] = ny; cNrm[k * 3 + 2] = nz;
        cDat[k * 3] = D[k * CH + 3];
        cDat[k * 3 + 1] = fertility(h, D[k * CH + 1], D[k * CH + 2]);
        cDat[k * 3 + 2] = 0;
      }
    }
    aCPos.needsUpdate = true; aCNrm.needsUpdate = true; aCDat.needsUpdate = true;
    carpetUniforms.uCarpetC.value.set(cache.cx, cache.cz);
  }

  // -------------------------------------------------------------------------
  //  Placement
  // -------------------------------------------------------------------------
  function hide(L, i, rx, rz) {
    L.rawX[i] = rx; L.rawZ[i] = rz;
    L.iPos[i * 3] = rx; L.iPos[i * 3 + 1] = -1000; L.iPos[i * 3 + 2] = rz;
    L.iA[i * 4 + 1] = 0; L.iA[i * 4 + 2] = 0;
  }

  // ---- pampas placement census (off unless a probe turns it on) -----------
  // Every number in the pampas gate's comment below came out of this, live,
  // via tools/pampas-gate-sweep.mjs and tools/census-pampas.mjs. It is left in
  // deliberately: the mask has now been retuned blind twice, once too tight
  // and once too loose, and the only way to retune it honestly is to read the
  // (pampv, slope, height) cloud the gate ACTUALLY sees at a hero pose rather
  // than to re-derive it on the CPU and hope the two agree. `DBG.on` is false
  // in normal play, so the hot loop pays one property read per placement.
  const DBG = { on: false, reset() { Object.assign(this, { tot: 0, rejHard: 0, rejFert: 0, rejPm: 0, pmS: 0, pmN: 0, pmFull: 0, pmEmpty: 0, sPv: [], sOt: [] }); } };
  DBG.reset();

  function place(L, i, rx, rz) {
    L.rawX[i] = rx; L.rawZ[i] = rz;

    // --- tussock ---
    const cell = L.cell;
    const gx = Math.floor(rx / cell), gz = Math.floor(rz / cell);
    const h1 = ihash(gx, gz, 11), h2 = ihash(gx, gz, 23);
    const h3 = ihash(gx, gz, 37), h4 = ihash(gx, gz, 53);
    const ccx = (gx + 0.18 + 0.64 * h1) * cell;
    const ccz = (gz + 0.18 + 0.64 * h2) * cell;
    const pull = L.pull * (0.70 + 0.55 * h3);
    const x = rx + (ccx - rx) * pull + (rnd() - 0.5) * cell * 0.12;
    const z = rz + (ccz - rz) * pull + (rnd() - 0.5) * cell * 0.12;
    const dc = Math.min(Math.hypot(x - ccx, z - ccz) / (cell * 0.70), 1);

    const f = cache.sample(x, z);
    const h = f[0], slope = f[1], meadow = f[2], dryv = f[3], pampv = f[4];

    const _DBG = DBG.on && L.kind === KIND.PAMPAS;
    if (_DBG) DBG.tot++;
    if (h < 3.3 || h > 168 || slope > 0.46) { if (_DBG) DBG.rejHard++; hide(L, i, rx, rz); return; }

    // --- fertility: where grass actually grows -----------------------------
    let fert = fertility(h, slope, meadow) * (0.80 + 0.20 * h4);
    if (rnd() > fert * 1.15) { if (_DBG) DBG.rejFert++; hide(L, i, rx, rz); return; }

    let species, hgt, hw, rest;
    if (L.kind === KIND.PAMPAS) {
      // Susuki grows in stands, on gentle open ground, never on the beach or
      // the rock line. Anything else is empty for this layer.
      //
      // MEASURED, wave E. The old gate was `(pampv - 0.505) * 3.4`, which
      // saturates at pampv = 0.799 — a value that DOES NOT EXIST anywhere on
      // this island. Sampled over 20k points in a 58 m disc at each hero pose,
      // the pampas channel runs 0.19..0.76 globally and 0.41..0.59 in the near
      // band; the highest reading found anywhere was 0.757. So the mask never
      // once reached 1.0, and three further clamps multiplied that partial
      // value down again: a live census of the 58,000-instance layer at the
      // flagship meadow pose (-681, 363) found 1,632 alive and SIX plumes
      // within 15 m. The susuki plume is the single most wind-legible thing in
      // a Ghost of Tsushima field and it was effectively absent.
      //
      // The gate now saturates at pampv = 0.527, just above the near-band
      // median of the meadow and coast poses, so a stand is a STAND — full
      // density inside it — while the p10 of every pose still sits under 0.36,
      // so the mask keeps its block structure and pampas is not everywhere.
      // The slope term was zeroing at 0.257, well below the 0.46 at which
      // grass itself stops; it now runs out where the grass does. The altitude
      // ceiling was 92 m falling to zero by 127 m, which excluded the ridge
      // (h=138) and all but grazed the summit (h=123) — susuki is a highland
      // plant (Soni Kogen, Sengokuhara) and the ceiling now ends just past the
      // grass cutoff at 168 m instead of a third of the way up the island.
      //
      // Census, re-run against THIS file (tools/census-pampas.mjs, 58,000
      // instances, R = 58 m, old gate -> new gate):
      //   pose             alive            <15 m           <30 m
      //   01-sunset-ridge    122 -> 21,292      0 ->   590      0 ->  2,674
      //   02-grass-field   1,632 -> 21,737      6 -> 1,408    173 ->  5,511
      //   03-coast         3,981 -> 17,374    215 -> 1,464    744 ->  4,758
      //   05-summit          207 -> 32,210     26 -> 2,951     72 -> 10,356
      //
      // And the mask still has STANDS, which is the point — this is not "pampas
      // everywhere". Sampling pm on a 0.725 m grid over the same 58 m disc:
      //   pose             full (pm>0.9)    empty (pm<0.1)
      //   01-sunset-ridge   0.0% -> 15.7%   100.0% -> 38.0%
      //   02-grass-field    0.0% -> 16.0%    84.6% ->  7.9%
      //   03-coast          0.0% ->  8.5%    83.3% -> 48.6%
      //   05-summit         0.0% -> 23.6%   100.0% -> 14.6%
      // The old gate never once reached a full stand ANYWHERE on the island;
      // now 8-24% of a hero pose is solid susuki and 8-49% is clear meadow,
      // which is the block structure references/field_24.png actually shows —
      // one bank wall-to-wall plume, the opposite bank plain grass.
      // OVERCORRECTED, and re-measured in wave F. The gate above was widened
      // from `(pampv - 0.505) * 3.4` to `(pampv - 0.36) * 6.0` because the old
      // one saturated at a pampv that does not exist on this island. It does
      // fix that, but it lands too far: pulled out of the running game
      // (tools/pampas-gate-sweep.mjs samples the exact (pampv, slope, height)
      // cloud place() tests, then evaluates candidate curves against it), the
      // 0.36 gate leaves only 14% of the 05-summit disc empty and 13% of the
      // 02-grass-field disc empty. Susuki is then not a stand inside a meadow,
      // it is the ground cover, and shots/wave-e/05-summit.png reads as
      // confetti scattered wall to wall.
      //
      // The replacement is a SMOOTHSTEP, not another line. Every linear
      // candidate tried (offsets 0.42-0.48, gains 6-8) cut the count but
      // destroyed the stands with it — pm>0.9 fell from 24.5% of the summit
      // disc to 0.4-2.1%, which is the wave-D failure again in the other
      // direction. A smoothstep across 0.44..0.56 still saturates inside the
      // real distribution, so the core of a stand is still solid, while its
      // toe is flat enough to leave real gaps.
      //
      // Sweep, same cloud, current -> smoothstep(0.42, 0.55):
      //   pose             alive%        stand (pm>0.9)   empty (pm<0.1)
      //   01-sunset-ridge  36.1 -> 24.6   17.6 -> 14.4     38.0 -> 60.4
      //   02-grass-field   37.6 -> 27.1   18.1 -> 15.7     13.4 -> 36.3
      //   03-coast         31.0 -> 24.3   19.5 -> 16.7     21.0 -> 37.4
      //   05-summit        53.0 -> 42.6   24.5 -> 15.6     14.0 -> 21.0
      // i.e. 0.68-0.80x the plumes, stands still saturating on a sixth of each
      // disc, and a fifth to three fifths of it now plain meadow.
      //
      // A HARDER cut was tried first and shot: smoothstep(0.44, 0.56), 0.57x
      // on the ridge. On 01-sunset-ridge that emptied the near band outright —
      // zero pixels above 180 luma in the lower 45% of the frame against
      // wave-E's 1.19% — and the pose is already the darkest of the eight.
      // The confetti read is fixed by the bend ceiling and the value cut
      // below, not by deleting the plant; this gate only has to stop susuki
      // being the ground cover.
      const pmT = clamp01((pampv - 0.42) / 0.13);
      const pm = pmT * pmT * (3 - 2 * pmT)
        * clamp01(1 - (slope - 0.16) * 3.4)
        * clamp01((h - 6) / 5)
        * clamp01(1 - (h - 128) / 44);
      if (_DBG) { DBG.pmS += pm; DBG.pmN++; if (pm > 0.9) DBG.pmFull++; if (pm < 0.1) DBG.pmEmpty++;
        DBG.sPv.push(pampv); DBG.sOt.push(clamp01(1 - (slope - 0.16) * 3.4) * clamp01((h - 6) / 5) * clamp01(1 - (h - 128) / 44)); }
      if (rnd() > pm) { if (_DBG) DBG.rejPm++; hide(L, i, rx, rz); return; }
      species = 3;
      hgt = 1.26 + rnd() * 0.46;
      hw = 0.046 + rnd() * 0.020;
      rest = 0.05 + rnd() * 0.10;
    } else if (L.kind === KIND.COVER) {
      species = 2;
      hgt = 0.10 + rnd() * 0.22;
      hw = 0.0050 + rnd() * 0.0032;
      rest = 0.78 + rnd() * 0.55;
    } else {
      const scrub = slope > 0.28 || meadow < 0.32 || h > 132;
      species = scrub ? 1 : (rnd() < 0.055 ? 4 : 0);
      if (scrub) { hgt = 0.22 + rnd() * 0.20; rest = 0.26 + rnd() * 0.32; }
      else { hgt = 0.26 + rnd() * 0.56; rest = 0.16 + rnd() * 0.50; }
      hgt *= L.hScale;
      // Real blade widths: 1-3 cm. Anything wider reads as a leaf, not grass.
      // Distance coverage is recovered by the minimum-screen-width term in the
      // vertex shader instead of by fattening the geometry everywhere.
      hw = L.key === 'near' ? 0.0060 + rnd() * 0.0038
        : L.key === 'mid' ? 0.0085 + rnd() * 0.0050
          : 0.0120 + rnd() * 0.0075;
    }

    // Tussock silhouette: taller in the middle, plus clump-to-clump variety.
    hgt *= (1.10 - 0.20 * dc) * (0.82 + 0.30 * h4) * (0.80 + 0.26 * fert);
    // Hard scale ceilings. Meadow grass tops out knee-to-waist on a 1.7 m
    // character however the multipliers stack; only susuki goes higher, and it
    // is a different plant. Without this the tails of three random factors
    // multiply into blades taller than the camera in the near ring.
    if (species === 3) hgt = Math.min(hgt, 1.72);
    else hgt = Math.min(hgt, 1.02);

    let dry = dryv + (h4 - 0.5) * 0.22 + (rnd() - 0.5) * 0.10;
    if (species === 1) dry += 0.24;
    dry = clamp01(dry);

    const shade = Math.min(1.32, Math.max(0.62, 0.80 + 0.42 * h4 + (rnd() - 0.5) * 0.12));
    const ao = L.kind === KIND.COVER ? 0.62 + 0.30 * dc : 0.58 + 0.42 * dc;

    // Splay: the tussock picks a direction, each blade jitters around it.
    const dirA = h3 * 6.2831853 + (rnd() - 0.5) * 1.2;

    L.iPos[i * 3] = x; L.iPos[i * 3 + 1] = h; L.iPos[i * 3 + 2] = z;
    L.iA[i * 4] = dirA;
    L.iA[i * 4 + 1] = hgt;
    L.iA[i * 4 + 2] = hw;
    L.iA[i * 4 + 3] = rest;
    L.iB[i * 4] = dry;
    L.iB[i * 4 + 1] = shade;
    L.iB[i * 4 + 2] = species;
    L.iB[i * 4 + 3] = ao;
  }

  function markAll(L) {
    L.aPos.needsUpdate = true; L.aA.needsUpdate = true; L.aB.needsUpdate = true;
    L.aPos.clearUpdateRanges?.(); L.aA.clearUpdateRanges?.(); L.aB.clearUpdateRanges?.();
  }

  function markRange(L, lo, hi) {
    const n = hi - lo + 1;
    if (L.aPos.addUpdateRange) {
      L.aPos.addUpdateRange(lo * 3, n * 3);
      L.aA.addUpdateRange(lo * 4, n * 4);
      L.aB.addUpdateRange(lo * 4, n * 4);
    }
    L.aPos.needsUpdate = true; L.aA.needsUpdate = true; L.aB.needsUpdate = true;
  }

  function fullScatter(cx, cz) {
    for (const L of layers) {
      const R = L.R;
      for (let i = 0; i < L.count; i++) {
        place(L, i, cx + (rnd() * 2 - 1) * R, cz + (rnd() * 2 - 1) * R);
      }
      L.cursor = 0;
      markAll(L);
    }
  }

  // Toroidal wrap, one slice per frame. A blade that leaves the trailing edge
  // re-enters at the leading edge, where the ring fade has it at zero height,
  // so the field scrolls with the camera and nothing ever appears out of thin
  // air. Only the touched span is re-uploaded.
  function wrapSlice(L, cx, cz) {
    const R = L.R, R2 = R * 2;
    const from = L.cursor;
    const to = Math.min(L.count, from + Math.ceil(L.count / L.slices));
    let lo = L.count, hi = -1;
    for (let i = from; i < to; i++) {
      let x = L.rawX[i], z = L.rawZ[i];
      let moved = false;
      let dx = x - cx;
      if (dx > R) { x -= R2; moved = true; } else if (dx < -R) { x += R2; moved = true; }
      let dz = z - cz;
      if (dz > R) { z -= R2; moved = true; } else if (dz < -R) { z += R2; moved = true; }
      if (moved) {
        place(L, i, x, z);
        if (i < lo) lo = i;
        if (i > hi) hi = i;
      }
    }
    L.cursor = to >= L.count ? 0 : to;
    if (hi >= lo) markRange(L, lo, hi);
  }

  let started = false;
  let lastX = 0, lastZ = 0;
  const tmpC = new THREE.Color();
  const ZENITH = new THREE.Color('#84b0f2');

  // ---- runner wake --------------------------------------------------------
  // Slot 0 tracks the character every frame so the bubble around him never
  // lags; slots 1..N-1 are a ring of dropped footprints that age out.
  const trailSlots = shared.uTrail.value;
  let trailHead = 1, trailHeading = 0;
  let trailX = 0, trailZ = 0, trailStarted = false;
  let trailPrevX = 0, trailPrevZ = 0, trailSpd = 0, trailPrimed = false;

  function updateTrail(dt, px, pz) {
    for (let i = 1; i < TRAIL_N; i++) {
      const s = trailSlots[i];
      if (s.w < 1) s.w = Math.min(1, s.w + dt / TRAIL_LIFE);
    }

    // Real speed, from the per-FRAME delta — not from `moved`, which is the
    // distance since the last DROP and is therefore a sawtooth. Smoothed so a
    // single long frame cannot stretch the whole lane.
    const fdx = px - trailPrevX, fdz = pz - trailPrevZ;
    const inst = trailPrimed ? Math.hypot(fdx, fdz) / Math.max(dt, 1e-4) : 0;
    trailSpd += (inst - trailSpd) * (trailPrimed ? Math.min(1, dt * 9.0) : 1);
    trailPrevX = px; trailPrevZ = pz; trailPrimed = true;

    const dx = px - trailX, dz = pz - trailZ;
    const moved = Math.hypot(dx, dz);
    if (moved > 1e-4) trailHeading = Math.atan2(dz, dx);

    // MEASURED, wave E. The drop step was a fixed TRAIL_STEP (0.45 m) with a
    // TRAIL_MAX_DT *ceiling* bolted on, but a distance test always fires first:
    // at a 15.25 m/s gallop 0.45 m is 30 ms, so the 15-slot ring was consumed
    // in 0.44 s and the lane spanned 7.6-9.8 m with a maximum age of only
    // 0.31-0.41 — a third of TRAIL_LIFE. The wake read as a short stub that
    // stopped a horse-length behind him instead of a lane fading out over 1.6 s.
    //
    // The step is now speed-ADAPTIVE, so the ring always spans TRAIL_LIFE
    // whatever the gait, and it stays inside every layer's crush radius
    // (thinOut 1.9-4.4 m) so the lane is a lane, not a dotted line.
    //
    // VERIFIED LIVE, tools/probe-wake.mjs, reading uTrail out of the running
    // game (true ground speed measured from player.position over 1 s):
    //   gait     speed      span      max age    mean spacing
    //   walk     3.8 m/s     5.7 m     0.93        0.47 m
    //   sprint   7.6 m/s    11.6 m     0.94        0.82 m
    //   gallop  12.4 m/s    19.5 m     0.96        1.48 m
    //   gallop  12.0 m/s    18.3 m     0.94        1.29 m
    // Before the change the same probe read 7.4-7.9 m of span at a max age of
    // 0.39-0.42 for every gait above a walk: the ring was consumed in a third
    // of TRAIL_LIFE and the wake stopped a horse-length behind him. Ages now
    // reach ~0.95 at a gallop, i.e. the ring spans essentially the full life.
    const step = Math.max(TRAIL_STEP, trailSpd * TRAIL_MAX_DT);
    if (!trailStarted || moved > step) {
      trailHead = 1 + ((trailHead) % (TRAIL_N - 1));
      trailSlots[trailHead].set(px, pz, trailHeading, 0);
      trailX = px; trailZ = pz; trailStarted = true;
    }
    trailSlots[0].set(px, pz, trailHeading, 0);

    // Bounding box of the still-live samples, for the vertex shader's reject.
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < TRAIL_N; i++) {
      const s = trailSlots[i];
      if (s.w >= 1) continue;
      if (s.x < x0) x0 = s.x; if (s.x > x1) x1 = s.x;
      if (s.y < z0) z0 = s.y; if (s.y > z1) z1 = s.y;
    }
    if (x0 > x1) { x0 = z0 = 1e9; x1 = z1 = -1e9; }
    shared.uTrailBox.value.set(x0, z0, x1, z1);
  }

  return {
    mesh: group, group, layers, DBG,

    // Exposed so other systems (quests, cutscenes) can force a re-seed.
    scatter(x, z) {
      if (cache.needs(x, z)) { cache.rebuild(x, z); rebuildCarpet(); }
      fullScatter(x, z);
      lastX = x; lastZ = z; started = true;
    },

    update(dt, c) {
      const cam = c.camera.position;
      const u = shared;

      // ---- field maintenance ------------------------------------------
      if (cache.needs(cam.x, cam.z)) { cache.rebuild(cam.x, cam.z); rebuildCarpet(); }
      if (!started || Math.hypot(cam.x - lastX, cam.z - lastZ) > 26) {
        fullScatter(cam.x, cam.z);
        started = true;
      } else if (Math.abs(cam.x - lastX) + Math.abs(cam.z - lastZ) > 1e-4) {
        for (const L of layers) wrapSlice(L, cam.x, cam.z);
      }
      lastX = cam.x; lastZ = cam.z;

      // ---- per-frame uniforms ------------------------------------------
      u.uCam.value.copy(cam);
      const pp = c.player ? c.player.position : cam;
      u.uPlayer.value.copy(pp);
      updateTrail(dt, pp.x, pp.z);

      // The wind block is attached by reference and wind.update(dt) has
      // already run this frame — uWindDir / uWindStr / uWindTime / uWindWave /
      // uWindGuide are all current. uTime is grass's OWN private detail clock
      // (per-blade flutter phase) and nothing else reads it.
      if (c.wind) u.uTime.value = c.wind.t; else u.uTime.value += dt;

      const sky = c.sky;
      if (sky) {
        u.uSunDir.value.copy(sky.sunPos);
        const si = sky.sun.visible === false ? 0 : sky.sun.intensity;
        u.uSunCol.value.copy(sky.sun.color).multiplyScalar(si);
        if (sky.hemi) {
          u.uSkyCol.value.copy(sky.hemi.color).multiplyScalar(sky.hemi.intensity);
          u.uGndCol.value.copy(sky.hemi.groundColor).multiplyScalar(sky.hemi.intensity);
        }
        if (sky.amb) {
          u.uAmbCol.value.copy(sky.amb.color).multiplyScalar(sky.amb.intensity);
        }
        // A low sun crushes anything facing away to black. Grass keeps an
        // interreflection floor, weighted to the sky so the shadow side of the
        // field reads cool rather than dead — the GoT shadow read.
        tmpC.copy(u.uSunCol.value).multiplyScalar(0.085);
        u.uAmbCol.value.add(tmpC);
        // Zenith fill, scaled by how much sky light there is at all.
        const skyE = (u.uSkyCol.value.r + u.uSkyCol.value.g + u.uSkyCol.value.b) / 3;
        u.uZenith.value.copy(ZENITH).multiplyScalar(skyE * 0.62);
      }

      if (c.scene.fog) {
        u.uFogCol.value.copy(c.scene.fog.color);
        u.uFogDensity.value = c.scene.fog.density;
      }

      if (matTex.anisotropy < 2) {
        const aniso = Math.min(8, c.renderer.capabilities.getMaxAnisotropy());
        matTex.anisotropy = aniso;
        matTex.needsUpdate = true;
        // The plume quad is ~30 px wide and ~150 px tall on screen in the near
        // band: a 5:1 anisotropic footprint. With anisotropy 1 the GPU has to
        // pick the mip off the WIDER axis, which throws away exactly the fan
        // detail the alpha test is trying to read. This was left at 1 while the
        // ground mat got 8.
        plumeTex.anisotropy = aniso;
        plumeTex.needsUpdate = true;
      }

      // World size of one screen pixel at unit distance — drives the
      // minimum-width anti-aliasing compensation.
      c.renderer.getDrawingBufferSize(_v2);
      u.uPxWorld.value = 2 * Math.tan(THREE.MathUtils.degToRad(c.camera.fov * 0.5)) / Math.max(_v2.y, 1);
    },
  };
}
