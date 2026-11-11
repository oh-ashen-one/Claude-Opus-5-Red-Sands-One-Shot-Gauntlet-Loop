import * as THREE from 'three';
import { heightAt, slopeAt } from './terrain.js';
import { fbm } from '../util/noise.js';
import { mulberry32 } from '../util/rng.js';
import { QUALITY } from '../core/quality.js';
import { WIND_UNIFORMS_GLSL, WIND_GLSL } from './wind.js';

// OWNER: trees lane. Maple / bamboo / pine / cherry, canopy, LOD, wind response.
//
// Everything here is generated in code: bark and leaf textures are painted to a
// canvas, trunks are grown as recursive tapered tubes, canopies are shells of
// instanced cards whose vertex normals point out of the canopy sphere so the
// mass reads as a rounded volume instead of a stack of flat quads.
//
// Three things carry the look:
//   1. TRAVELLING WIND. Sway phase is a function of the tree's position
//      projected onto the wind vector, so a gust front sweeps through a grove
//      and the whole grove leans together. Same field the grass uses.
//   2. TRANSLUCENCY. At golden hour the sun is behind the canopy in two of the
//      three hero poses; a backlit leaf has to glow, not go black.
//   3. SHELL NORMALS + BAKED AO. Cards deep inside the canopy are dark, cards
//      on the outside catch the key. That is what stops a "green blob".
//
// LOD0 full tree, LOD1 reduced trunk + fewer/larger cards (silhouette held so
// the swap is invisible), LOD2 a three-quad impostor cross. The handover
// between them is PER TREE, not per pixel — see CFG.lodJit1 and repartition().

// ---------------------------------------------------------------------------
// tuning
// ---------------------------------------------------------------------------
const CFG = {
  cell: 7.2,          // scatter grid spacing, metres
  islandR: 1170,
  lod0: 76,           // full detail out to here PLUS this tree's own jitter
  lod1: 226,          // mid detail out to here PLUS this tree's own jitter
  // LOD HANDOVER IS PER TREE, NOT PER PIXEL.
  //
  // This used to be a screen-door crossfade: both LODs drawn across a 58 m band
  // with complementary 4x4 bayer masks. On paper every pixel is covered exactly
  // once; on a 1080p frame with no TAA to resolve it, what you actually see is a
  // permanent 50% checkerboard over the entire distant forest — sea visibly
  // chequering through the maples. There is no dither pattern that survives
  // being looked at without temporal resolve, so the dither is gone entirely.
  //
  // Instead every tree carries a stable random offset and swaps LOD at its OWN
  // distance somewhere inside the band. At any camera position the band holds a
  // random mix of both representations, each drawn SOLID, so the handover has no
  // wavefront and no pattern — and the pop it costs happens on one tree at a
  // time, at a range where an impostor built from that tree's own canopy is a
  // handful of pixels wide.
  lodJit0: 26,        // width of the per-tree LOD0 -> LOD1 handover band
  lodJit1: 46,        // width of the per-tree LOD1 -> LOD2 handover band
  maxDist: 1050,      // nothing drawn past this (fog has eaten it anyway)
  shadowDist: 145,    // instances inside this cast shadows even when off-screen
  // Clearance measured from the CANOPY SPHERE, not the trunk: on a steep slope
  // a tree 12 m away can still have branches in the lens.
  //
  // THIS IS A HARD CULL WITH HYSTERESIS. There is NO near fade and there must
  // never be one again.
  //
  // ALPHA TO COVERAGE ON THIS TARGET IS EDGE ANTIALIASING ONLY. It is NOT an
  // opacity channel. Five separate comments in this file used to assert that a
  // partial coverage value "resolves smoothly through MSAA into a soft dissolve
  // instead of a visible stipple". That premise was probed directly against this
  // build (ANGLE/Metal) and is FALSE: forcing uNearFade = 400 on all 23 tree
  // materials at runtime pushes every near tree to fractional coverage and the
  // frame comes back with a HARD 4x4 CROSSHATCH. Injecting a wide near band at
  // 06-forest reproduced the reported intermittent artifact verbatim — "a large
  // semi-transparent 4x4-dithered dome with a smooth curved edge".
  //
  // The old 5.6 / 6.4 pair narrowed the WINDOW in which that bug is visible; it
  // did not remove the CLASS of bug. A camera that bobs, or a tree standing on a
  // slope, can still park inside 0.8 m of band and sit there dithered. So an
  // instance is now either drawn SOLID or vertex-discarded outright:
  //
  //   nearCull — clearance at which a DRAWN tree is removed
  //   nearShow — clearance at which a REMOVED tree comes back
  //
  // The 2.0 m gap between them is the hysteresis. It is an order of magnitude
  // wider than any camera bob, so an instance physically cannot flicker on the
  // threshold; the state is per instance and lives across repartitions.
  //
  // AND THE HYSTERESIS PAIR ALONE WAS NEVER AN INVARIANT. Both thresholds are
  // only ever evaluated inside repartition(), which runs at rebuildMove 4.0 m /
  // rebuildTurn 0.02 / rebuildTime 0.30 s granularity — so between two rebuilds
  // the drawn set is STALE and the camera can walk straight into a tree that
  // the last repartition cleared. Measured over a 12 s gallop: 273 drawn
  // instance-frames sat inside nearCull that repartition had not revisited.
  //
  // So the cull is now enforced in TWO places with different jobs:
  //   nearHard — a per-FRAME test in the vertex shader (see nearCulled() in
  //              VS_COMMON). Nothing is ever drawn inside this at any camera
  //              position, stale set or not. It is the actual invariant.
  //   nearCull/nearShow — the per-repartition hysteresis pair, which is what
  //              decides when a tree comes BACK. They now sit a guard band
  //              above nearHard so that a drawn instance is always at least
  //              (nearCull - nearHard) = 1.2 m clear of the shader threshold;
  //              a bobbing camera therefore cannot oscillate across it inside
  //              one rebuild interval, and the shader test only ever fires on
  //              genuine staleness — a camera closing >1.2 m in <0.30 s.
  nearHard: 5.6,
  nearCull: 6.8,
  nearShow: 8.8,
  rebuildMove: 4.0,
  rebuildTurn: 0.02,
  rebuildTime: 0.30,
};

// One knob for the whole forest budget, same contract grass.js honours for
// blades: thin the SCATTER, never shrink CFG.cell. Shrinking the cell would move
// every tree and re-roll the entire layout, so ?q=low would be a different world
// rather than the same world drawn cheaper.
const DENSITY = QUALITY.trees;   // 1.0 = shipping density; scaled by tier

const SPECIES = ['maple', 'bamboo', 'pine', 'cherry'];
const VARIANTS = {           // [lod0 variants, lod1 variants, lod2 variants]
  // LOD2 is what a whole hillside is MADE of — past 226 m every tree in the
  // frame is one of these cards. Three maple impostors over a thousand-tree
  // slope is what a critic read as "hundreds of identical low-poly lollipop
  // trees stamped at uniform spacing". Five silhouettes, each now structurally
  // randomised (trunk height, plate count, canopy aspect, lean) rather than
  // just noise-jittered, plus the per-instance aspect/lean below, is what
  // breaks the stamp.
  maple: [5, 2, 5],
  bamboo: [3, 2, 3],
  pine: [3, 2, 4],
  cherry: [2, 1, 3],
};
// A tree's variant index is rolled ONCE, across the widest LOD, and each LOD
// takes it modulo its own count. Rolling it across LOD0's count (as this used
// to) silently stranded every LOD2 variant past index n0-1: pine could never
// draw its fourth impostor and maple's fifth was unreachable.
const VARIANT_ROLL = {};
for (const k in VARIANTS) VARIANT_ROLL[k] = Math.max(...VARIANTS[k]);
const CAPS = [420, 900, 3400];   // instance capacity per bucket, by LOD

// Leaf palettes. Colours built from hex go through ColorManagement, so these
// end up linear — same convention as grass.js and sky.js.
//
// The maple ramp is deliberately kept on the WARM side of red: blue must stay
// below green. A crimson with b > g (#c02231) picks up the cool sky bounce on
// its shaded side and the whole grove goes magenta at 200 m. Vermilion does not.
const PALETTE = {
  maple: ['#c4321c', '#c4321c', '#b02a16', '#b02a16', '#d04420', '#d04420',
    '#a83a1c', '#982c12', '#cc4c18', '#d8701e', '#a4541f', '#e08a26'],
  cherry: ['#f0c4bc', '#e8b2a6', '#f6d4cc', '#e2a69c', '#eebcb0'],
  // PINE AND BAMBOO WERE THE ONLY THING IN THE FRAME OUTSIDE ITS COLOUR KEY.
  //
  // MEASURED on the shipped build, 01-sunset-ridge, with the leaf fragment
  // shader recompiled to write a flat flag colour so the canopy mask is exact
  // (hiding the meshes instead would have taken their SHADOWS with them and
  // sampled the sunlit ground underneath as though it were canopy). Pine covers
  // 4.76% of that frame and came back hue 37.6 deg / sat 0.639, with 11.1% of
  // its pixels in the green band (hue 55-190) and 22% above hue 45. The
  // references have essentially none: field_2 measures 29.2 / 0.772 with 0.02%
  // green, field_16 29.3 / 0.800 with 0.04%. A fifth of the pine sitting where
  // the reference has a fortieth of a percent is the whole "pasted in from a
  // different scene" read.
  //
  // The old palette was hue 91-97 deg at sat 0.44-0.46 — flat forest green —
  // and the ATLAS multiplied a SECOND green on top of it (see drawPineCluster),
  // so the composite albedo landed greener than either factor. Both halves are
  // fixed: the atlas is now a warm value carrier and the hue lives here, in
  // warm olive at 41-46 deg. Pine stays the coolest, most olive species in the
  // file — it is an evergreen standing in an autumn frame and it should not
  // become a second maple — but it is inside the amber key instead of fighting
  // it.
  pine: ['#64783d', '#7c934b', '#546635', '#708348', '#5e7438'],
  // Bamboo keeps the most green of any species (it is the one thing on the
  // island that is not turning) but leaves the deep forest-green band: hue
  // 90 deg -> 67 deg, which is yellow-green, the colour a madake grove actually
  // goes under a 2-8 degree sun.
  bamboo: ['#8a9440', '#7b8438', '#96a04a', '#6d7632', '#828c3c'],
};

// ---------------------------------------------------------------------------
// canvas helpers
// ---------------------------------------------------------------------------
function canvasOf(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h === undefined ? w : h;
  return c;
}

function texOf(canvas, repeat, aniso) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

const rgb = (r, g, b) => `rgb(${r | 0},${g | 0},${b | 0})`;

// ---------------------------------------------------------------------------
// leaf silhouettes
// ---------------------------------------------------------------------------

// Palmate five-lobed maple leaf. |cos(3a)| gives peaks at 0, +-60, +-120 which
// is exactly the momiji lobe count; the sin(21a) term serrates the edge.
function maplePath(g, R) {
  g.beginPath();
  const N = 84;
  for (let i = 0; i <= N; i++) {
    const a = (-152 + (304 * i) / N) * Math.PI / 180;
    let r = 0.30 + 0.70 * Math.pow(Math.abs(Math.cos(a * 3)), 0.45);
    r *= 1 + 0.055 * Math.sin(a * 21);
    const x = Math.sin(a) * r * R, y = -Math.cos(a) * r * R;
    if (i) g.lineTo(x, y); else g.moveTo(x, y);
  }
  g.closePath();
}

function lanceolatePath(g, L, W) {
  g.beginPath();
  g.moveTo(0, 0);
  g.bezierCurveTo(W, -L * 0.20, W * 0.72, -L * 0.70, 0, -L);
  g.bezierCurveTo(-W * 0.72, -L * 0.70, -W, -L * 0.20, 0, 0);
  g.closePath();
}

function drawMapleCluster(g, C, rnd, autumn) {
  const cx = C / 2, cy = C / 2, maxR = C * 0.265;
  const n = 18 + ((rnd() * 8) | 0);
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2;
    const rr = Math.pow(rnd(), 0.5) * maxR;
    const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr * 0.88;
    const R = C * (0.085 + rnd() * 0.070);
    const lum = 0.52 + rnd() * 0.48;
    // A few leaves have not turned: shift them green-ward so a crimson tint
    // multiplied through gives dull olive rather than uniform red.
    const green = autumn && rnd() < 0.16 ? 1 : 0;
    const j = (rnd() - 0.5) * 0.20;
    const col = green
      ? rgb(255 * lum * 0.62, 255 * lum * 0.95, 255 * lum * 0.5)
      : rgb(255 * lum * (1 + j * 0.5), 255 * lum * (1 - j * 0.3), 255 * lum * (1 - j * 0.55));
    g.save();
    g.translate(x, y);
    g.rotate(rnd() * Math.PI * 2);
    g.fillStyle = col;
    maplePath(g, R);
    g.fill();
    g.strokeStyle = `rgba(28,14,10,${0.14 + rnd() * 0.14})`;
    g.lineWidth = Math.max(0.9, R * 0.030);
    for (const va of [0, 58, -58, 116, -116]) {
      const ar = (va * Math.PI) / 180;
      g.beginPath();
      g.moveTo(0, R * 0.44);
      g.lineTo(Math.sin(ar) * R * 0.78, R * 0.44 - Math.cos(ar) * R * 0.80);
      g.stroke();
    }
    g.restore();
  }
}

// Needle fascicles. They have to build a solid MASS with a ragged edge — a fan
// of hairlines mips down into a field of half-alpha noise that stipples badly
// under an alpha test, so the needles are packed thick enough to close up.
function drawPineCluster(g, C, rnd) {
  const n = 9 + ((rnd() * 5) | 0);
  g.lineCap = 'round';
  for (let i = 0; i < n; i++) {
    const bx = C * (0.24 + rnd() * 0.52);
    const by = C * (0.24 + rnd() * 0.52);
    const dir = rnd() * Math.PI * 2;
    // solid core so the fascicle survives minification
    const core = C * (0.030 + rnd() * 0.026);
    // THE ATLAS CARRIES VALUE, THE PALETTE CARRIES HUE. This used to be
    // (0.84, 1.00, 0.76) — a green at hue 100 / sat 0.24 — multiplied on top of
    // a palette that was already green at hue 91-97, and multiplying two greens
    // does not average their hues, it lands the product GREENER than either:
    // computed over the pine palette, the old atlas pushed the composite albedo
    // +16 deg green-ward, the new one pulls it -4 deg warm. Cherry and maple
    // already worked this way (their atlases are within a few percent of
    // neutral); pine and bamboo were the two that did not.
    const lumC = 0.40 + rnd() * 0.30;
    g.fillStyle = rgb(255 * lumC, 255 * lumC * 0.90, 255 * lumC * 0.72);
    g.beginPath();
    g.ellipse(bx + Math.cos(dir) * core, by + Math.sin(dir) * core, core * 1.9, core * 1.1, dir, 0, 6.283);
    g.fill();
    const cnt = 46 + ((rnd() * 26) | 0);
    for (let k = 0; k < cnt; k++) {
      const a = dir + (rnd() - 0.5) * 1.35;
      const len = C * (0.075 + rnd() * 0.085);
      const lum = 0.42 + rnd() * 0.58;
      g.strokeStyle = rgb(255 * lum, 255 * lum * 0.90, 255 * lum * 0.72);
      // 2.2-4.2 px on a 256 cell is 0.9-1.6% of the card. A pine card 4 m wide
      // seen at 30 m covers ~70 screen pixels, so those needles land at half a
      // pixel or less: every one of them is a sub-pixel feature crossing the
      // alpha threshold, and sub-pixel features crossing an alpha threshold are
      // exactly what the crawling stair-stepped silhouette in 05-summit is made
      // of. No amount of coverage widening fixes geometry the frame cannot
      // resolve — the fix is to stop drawing detail below the pixel. 3.4-6.2 px
      // keeps the fascicle read while putting the needle back above one pixel
      // at the ranges the hero shots actually frame a pine at.
      g.lineWidth = 3.4 + rnd() * 2.8;
      g.beginPath();
      g.moveTo(bx, by);
      g.quadraticCurveTo(
        bx + Math.cos(a) * len * 0.55 + (rnd() - 0.5) * 6,
        by + Math.sin(a) * len * 0.55 + (rnd() - 0.5) * 6,
        bx + Math.cos(a) * len,
        by + Math.sin(a) * len,
      );
      g.stroke();
    }
  }
}

function drawBambooCluster(g, C, rnd) {
  const n = 5 + ((rnd() * 4) | 0);
  for (let i = 0; i < n; i++) {
    const bx = C * (0.22 + rnd() * 0.56);
    const by = C * (0.18 + rnd() * 0.40);
    const base = rnd() * Math.PI * 2;
    const cnt = 5 + ((rnd() * 5) | 0);
    for (let k = 0; k < cnt; k++) {
      const a = base + (k / cnt - 0.5) * 1.9 + (rnd() - 0.5) * 0.25;
      const L = C * (0.16 + rnd() * 0.14);
      const W = L * (0.10 + rnd() * 0.06);
      const lum = 0.50 + rnd() * 0.50;
      g.save();
      g.translate(bx, by);
      g.rotate(a + Math.PI);
      // Same split as pine: value here, hue in PALETTE.bamboo.
      g.fillStyle = rgb(255 * lum, 255 * lum * 0.94, 255 * lum * 0.78);
      lanceolatePath(g, L, W);
      g.fill();
      g.strokeStyle = `rgba(20,30,12,0.20)`;
      g.lineWidth = 0.9;
      g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -L * 0.96); g.stroke();
      g.restore();
    }
  }
}

function drawCherryCluster(g, C, rnd) {
  const n = 16 + ((rnd() * 10) | 0);
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2;
    const rr = Math.pow(rnd(), 0.5) * C * 0.30;
    const x = C / 2 + Math.cos(a) * rr, y = C / 2 + Math.sin(a) * rr * 0.9;
    const R = C * (0.036 + rnd() * 0.030);
    const lum = 0.68 + rnd() * 0.32;
    g.save();
    g.translate(x, y);
    g.rotate(rnd() * Math.PI * 2);
    g.fillStyle = rgb(255 * lum, 255 * lum * 0.95, 255 * lum * 0.96);
    for (let p = 0; p < 5; p++) {
      const pa = (p / 5) * Math.PI * 2;
      g.beginPath();
      g.ellipse(Math.cos(pa) * R * 0.72, Math.sin(pa) * R * 0.72, R * 0.62, R * 0.50, pa, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = `rgba(240,190,120,0.85)`;
    g.beginPath(); g.arc(0, 0, R * 0.20, 0, Math.PI * 2); g.fill();
    g.restore();
  }
  // a few young leaves for structure
  for (let i = 0; i < 6; i++) {
    const x = C * (0.22 + rnd() * 0.56), y = C * (0.22 + rnd() * 0.56);
    g.save(); g.translate(x, y); g.rotate(rnd() * 6.283);
    const lum = 0.45 + rnd() * 0.3;
    g.fillStyle = rgb(255 * lum * 0.75, 255 * lum * 0.90, 255 * lum * 0.62);
    lanceolatePath(g, C * 0.09, C * 0.020);
    g.fill(); g.restore();
  }
}

// ---------------------------------------------------------------------------
// LOD2 impostor painting
//
// The impostor used to be cell 14/15 of the shared 4x4 leaf atlas. That was the
// bug behind the "grey discs": at 250 m an impostor covers ~6 px, the sampler
// lands on mip 5, and at mip 5 a 4x4 atlas cell is 8x8 texels — the neighbouring
// leaf-cluster cells bleed straight into it and the whole thing averages to a
// featureless wash. It also inherited the blurred alpha padding that every leaf
// cell gets, which at the softened far cut survived as a halo disc.
//
// So impostors now get their OWN texture, one tree per texture, painted as a
// species SILHOUETTE and mipped in isolation. No neighbours to bleed in, and
// the alpha padding is a tight 1 px dilate instead of a 3 px blur.
// ---------------------------------------------------------------------------

// Momiji: a short trunk that forks low, then three or four horizontal plates of
// crimson stacked with sky between them and drooping outer edges.
// EVERY structural number here is rolled per texture, not fixed. The previous
// version fixed the trunk height, the fork count, the plate count, the canopy
// top and the stack axis, and only jittered plate radius by +-11% — so the
// three maple impostors had, to a 10 px silhouette, exactly one outline. That
// single outline repeated across a hillside is the "identical low-poly
// lollipop" the critic saw; the variation had to move from the leaf blobs
// (invisible at that size) up into the shape of the tree.
function impMaple(g, C, rnd, cherry) {
  const ground = C * 0.985;
  // Trunk: anything from a low fork that hides the stem to a clear bole with
  // sky under the crown. This alone splits the set into two silhouette families.
  const th = C * (cherry ? 0.20 + rnd() * 0.22 : 0.16 + rnd() * 0.34);
  // Where the crown sits over the base, and how far the whole stack tips.
  const tilt = (rnd() - 0.5) * C * 0.20;
  const bx = C * (0.5 - tilt / C * 0.35);
  // Crown envelope is rolled BEFORE the branches, because the branches have to
  // be clamped inside it. Rolled after, a narrow crown over full-reach leaders
  // leaves bare twigs sticking out past the foliage and the tree reads at
  // distance as a spiky starfish rather than a maple.
  const layers = cherry ? 2 + ((rnd() * 3) | 0) : 2 + ((rnd() * 4) | 0);
  const crownH = C * (cherry ? 0.28 + rnd() * 0.26 : 0.24 + rnd() * 0.38);
  const halfW = C * (cherry ? 0.26 + rnd() * 0.16 : 0.24 + rnd() * 0.21);
  const taper = 0.12 + rnd() * 0.40;
  const plateThk = 0.055 + rnd() * 0.055;
  const w0 = C * (0.024 + rnd() * 0.016), w1 = w0 * 0.55;
  g.fillStyle = cherry ? 'rgb(84,74,72)' : 'rgb(70,58,50)';
  g.beginPath();
  g.moveTo(bx - w0, ground); g.lineTo(bx + w0, ground);
  g.lineTo(bx + tilt * 0.35 + w1, ground - th); g.lineTo(bx + tilt * 0.35 - w1, ground - th);
  g.closePath(); g.fill();
  const forkX = bx + tilt * 0.35;
  g.strokeStyle = cherry ? 'rgb(84,74,72)' : 'rgb(70,58,50)';
  g.lineCap = 'round';
  const leaders = 2 + ((rnd() * 3) | 0);
  for (let i = 0; i < leaders; i++) {
    const dx = leaders === 1 ? 0 : ((i / (leaders - 1)) - 0.5) * 2 + (rnd() - 0.5) * 0.4;
    g.lineWidth = C * (0.014 + rnd() * 0.012);
    g.beginPath();
    // reach clamped to the crown it has to stay inside
    const reach = Math.min(C * 0.28, halfW * 0.80);
    g.moveTo(forkX, ground - th);
    g.quadraticCurveTo(forkX + dx * reach * 0.36, ground - th - C * 0.14,
      forkX + dx * reach + tilt * 0.5, ground - th - Math.min(crownH * 0.62, C * (0.16 + rnd() * 0.14)));
    g.stroke();
  }

  // The crown itself: `layers` flattened lenses stacked between the fork and
  // crownH, each narrowed by `taper` as it climbs and offset sideways so the
  // stack is a crooked pile rather than a wedding cake. A 2-plate stack 0.26 C
  // tall and 0.45 C wide is a squat dome; a 5-plate stack 0.62 C tall and
  // 0.24 C wide is a narrow column. Both are momiji, and next to each other on
  // a hillside they stop reading as one asset.
  const topY = ground - th - crownH;
  const botY = ground - th - C * 0.02;
  // Blob count follows plate AREA, so a narrow crown does not come out lacy and
  // a broad one does not come out as a solid painted disc: the fill density per
  // square texel is the same one the old fixed-geometry version was tuned at.
  const refArea = C * C * 0.40 * 0.070;
  for (let L = 0; L < layers; L++) {
    const t = layers === 1 ? 0.5 : L / (layers - 1);
    const y = botY + (topY - botY) * t;
    // per-plate lateral offset: the stack is a crooked pile, not a wedding cake
    const cx = bx + tilt * t + (rnd() - 0.5) * halfW * 0.36;
    const rx = halfW * (1.0 - taper * t) * (0.78 + rnd() * 0.40);
    const ry = C * plateThk * (1.0 - 0.20 * t) * (0.80 + rnd() * 0.44);
    // Floor at 52: below that a plate stops being a mass and starts being a
    // scatter of separate leaves, which at 300 m minifies to a spiky asterisk.
    const blobs = Math.min(160, Math.max(52, Math.round((cherry ? 90 : 78) * (rx * ry) / refArea)));
    for (let i = 0; i < blobs; i++) {
      const a = rnd() * Math.PI * 2;
      const rr = Math.pow(rnd(), 0.40);
      // droop: outer half of the plate sags
      const droop = Math.pow(rr, 2.2) * C * (cherry ? 0.03 : 0.055) * (0.4 + rnd());
      const x = cx + Math.cos(a) * rx * rr;
      const yy = y + Math.sin(a) * ry * rr + droop;
      const R = C * (cherry ? 0.030 : 0.026) * (0.7 + rnd() * 0.8);
      const lum = (cherry ? 0.72 : 0.44) + rnd() * (cherry ? 0.28 : 0.56);
      g.save(); g.translate(x, yy); g.rotate(rnd() * 6.283);
      if (cherry) {
        g.fillStyle = rgb(255 * lum, 255 * lum * 0.94, 255 * lum * 0.95);
        g.beginPath(); g.ellipse(0, 0, R * 1.25, R * 1.05, 0, 0, 6.283); g.fill();
      } else {
        const j = (rnd() - 0.5) * 0.18;
        g.fillStyle = rgb(255 * lum * (1 + j * 0.4), 255 * lum * (1 - j * 0.3), 255 * lum * (1 - j * 0.6));
        maplePath(g, R); g.fill();
      }
      g.restore();
    }
  }
}

// Kuromatsu: a heavy leaning S-curved trunk with separated cloud pads and real
// sky showing between them. The gaps are the whole silhouette.
function impPine(g, C, rnd) {
  const ground = C * 0.985;
  const bx = C * (0.40 + rnd() * 0.20);
  const lean = (rnd() < 0.5 ? -1 : 1) * C * (0.10 + rnd() * 0.10);
  const th = C * (0.50 + rnd() * 0.10);
  // trunk as an S
  g.strokeStyle = 'rgb(58,44,36)';
  g.lineCap = 'round';
  g.lineWidth = C * 0.052;
  g.beginPath();
  g.moveTo(bx, ground);
  g.bezierCurveTo(bx - lean * 0.7, ground - th * 0.36,
    bx + lean * 1.05, ground - th * 0.70, bx + lean * 0.75, ground - th);
  g.stroke();
  const pads = [];
  const nPad = 4 + ((rnd() * 3) | 0);
  for (let i = 0; i < nPad; i++) {
    const t = 0.34 + (i / nPad) * 0.72 + rnd() * 0.10;
    const side = (i % 2 === 0 ? 1 : -1) * (0.5 + rnd() * 0.9);
    const ax = bx + lean * Math.min(1, t) * 0.9;
    const ay = ground - th * Math.min(1.06, t);
    const ex = ax + side * C * (0.16 + rnd() * 0.19);
    const ey = ay - C * (0.02 + rnd() * 0.12);
    g.lineWidth = C * (0.016 + rnd() * 0.012);
    g.beginPath();
    g.moveTo(ax, ay);
    g.quadraticCurveTo((ax + ex) * 0.5, ay + C * 0.03, ex, ey);
    g.stroke();
    pads.push({ x: ex, y: ey, r: C * (0.09 + rnd() * 0.075) });
  }
  for (const p of pads) {
    const blobs = 46;
    for (let i = 0; i < blobs; i++) {
      const a = rnd() * Math.PI * 2;
      const rr = Math.pow(rnd(), 0.42);
      const x = p.x + Math.cos(a) * p.r * rr * 1.35;
      const y = p.y + Math.sin(a) * p.r * rr * 0.52;
      const R = p.r * (0.20 + rnd() * 0.26);
      const lum = 0.34 + rnd() * 0.60;
      g.save(); g.translate(x, y); g.rotate((rnd() - 0.5) * 0.5);
      g.fillStyle = rgb(255 * lum, 255 * lum * 0.90, 255 * lum * 0.72);
      g.beginPath(); g.ellipse(0, 0, R * 1.7, R * 0.62, 0, 0, 6.283); g.fill();
      g.restore();
    }
  }
}

// A grove of straight culms, feathered only in the top third.
function impBamboo(g, C, rnd) {
  const ground = C * 0.99;
  const n = 11 + ((rnd() * 5) | 0);
  const culms = [];
  for (let i = 0; i < n; i++) {
    const x = C * (0.16 + rnd() * 0.68);
    const h = C * (0.68 + rnd() * 0.30);
    const w = C * (0.0085 + rnd() * 0.0055);
    const tipx = x + (rnd() - 0.5) * C * 0.055;
    culms.push({ x, h, w, tipx });
    g.fillStyle = `rgb(${(146 + rnd() * 40) | 0},${(138 + rnd() * 36) | 0},${(66 + rnd() * 30) | 0})`;
    g.beginPath();
    g.moveTo(x - w, ground); g.lineTo(x + w, ground);
    g.lineTo(tipx + w * 0.5, ground - h); g.lineTo(tipx - w * 0.5, ground - h);
    g.closePath(); g.fill();
    // node bands
    g.fillStyle = 'rgba(58,66,30,0.5)';
    for (let k = 1; k < 7; k++) {
      const yy = ground - h * (k / 7);
      const xx = x + (tipx - x) * (k / 7);
      g.fillRect(xx - w * 1.15, yy, w * 2.3, C * 0.004);
    }
  }
  for (const c of culms) {
    const sprays = 16;
    for (let k = 0; k < sprays; k++) {
      const t = 0.60 + rnd() * 0.44;
      const yy = ground - c.h * Math.min(1.04, t);
      const xx = c.x + (c.tipx - c.x) * Math.min(1, t);
      const a = (rnd() - 0.5) * 2.4;
      const L = C * (0.055 + rnd() * 0.055);
      const lum = 0.46 + rnd() * 0.54;
      g.save();
      g.translate(xx + (rnd() - 0.5) * C * 0.05, yy);
      g.rotate(a + Math.PI * 0.5 + (rnd() - 0.5) * 0.6);
      g.fillStyle = rgb(255 * lum, 255 * lum * 0.94, 255 * lum * 0.78);
      lanceolatePath(g, L, L * 0.13);
      g.fill();
      g.restore();
    }
  }
}

function drawImpostor(g, C, species, rnd) {
  if (species === 'pine') impPine(g, C, rnd);
  else if (species === 'bamboo') impBamboo(g, C, rnd);
  else impMaple(g, C, rnd, species === 'cherry');
}

// One tree, one texture, mipped in isolation. The alpha padding is a tight
// dilate (four 1 px offset copies) rather than a wide blur, so no halo survives
// the alpha test at any distance.
function makeImpostorTex(species, rnd, aniso) {
  const C = 320;
  const out = canvasOf(C);
  const og = out.getContext('2d');
  const tmp = canvasOf(C);
  const tg = tmp.getContext('2d');
  tg.save();
  tg.translate(C * 0.5, C); tg.scale(0.94, 0.94); tg.translate(-C * 0.5, -C);
  drawImpostor(tg, C, species, rnd);
  tg.restore();
  og.globalAlpha = 0.5;
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) og.drawImage(tmp, dx, dy);
  og.globalAlpha = 1;
  og.drawImage(tmp, 0, 0);
  return texOf(out, false, aniso);
}

function makeLeafAtlas(species, rnd, aniso) {
  const C = 256, S = C * 4;
  const at = canvasOf(S);
  const g = at.getContext('2d');
  g.clearRect(0, 0, S, S);
  const tmp = canvasOf(C);
  const tg = tmp.getContext('2d');
  for (let idx = 0; idx < 16; idx++) {
    tg.clearRect(0, 0, C, C);
    tg.save();
    // keep everything inside a margin so the blurred underlay cannot bleed
    // into the neighbouring atlas cell
    tg.translate(C * 0.5, C * 0.5); tg.scale(0.90, 0.90); tg.translate(-C * 0.5, -C * 0.5);
    // All 16 cells are leaf clusters now. The impostor no longer lives in this
    // atlas — at high mips its neighbours bled into it.
    if (species === 'pine') drawPineCluster(tg, C, rnd);
    else if (species === 'bamboo') drawBambooCluster(tg, C, rnd);
    else if (species === 'cherry') drawCherryCluster(tg, C, rnd);
    else drawMapleCluster(tg, C, rnd, true);
    tg.restore();
    const cx = (idx % 4) * C, cy = (3 - ((idx / 4) | 0)) * C;
    // Alpha padding: a blurred copy underneath keeps RGB (and a little alpha)
    // alive outside the crisp silhouette so mip levels do not eat the canopy.
    g.save();
    g.filter = 'blur(3px)';
    g.globalAlpha = 0.42;
    g.drawImage(tmp, cx, cy);
    g.restore();
    g.drawImage(tmp, cx, cy);
  }
  return texOf(at, false, aniso);
}

// ---------------------------------------------------------------------------
// bark
// ---------------------------------------------------------------------------
function makeBark(species, rnd, aniso) {
  const S = 512;
  const c = canvasOf(S);
  const g = c.getContext('2d');
  const wrapX = (fn) => { fn(0); fn(-S); fn(S); };

  if (species === 'bamboo') {
    g.fillStyle = 'rgb(124,148,72)'; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 420; i++) {
      const x = rnd() * S, w = 1 + rnd() * 4;
      const l = 0.6 + rnd() * 0.9;
      g.fillStyle = `rgba(${(150 * l) | 0},${(174 * l) | 0},${(88 * l) | 0},${0.10 + rnd() * 0.28})`;
      wrapX((o) => g.fillRect(x + o, 0, w, S));
    }
    // ten node rings, aligned with the geometry's node bulges (NODES in
    // buildBamboo). If these two counts drift apart the painted ring stops
    // landing on the modelled swelling and the culm stops reading as segmented.
    for (let k = 0; k <= 10; k++) {
      const y = (k / 10) * S;
      g.fillStyle = 'rgba(58,66,30,0.62)';
      g.fillRect(0, y - 2.5, S, 5);
      g.fillStyle = 'rgba(206,214,150,0.30)';
      g.fillRect(0, y + 2.5, S, 7);
      g.fillStyle = 'rgba(150,128,72,0.16)';
      g.fillRect(0, y + 9, S, 16);
    }
    for (let i = 0; i < 160; i++) {
      const x = rnd() * S, y = rnd() * S, r = 2 + rnd() * 9;
      g.fillStyle = `rgba(96,110,52,${0.05 + rnd() * 0.10})`;
      g.beginPath(); g.ellipse(x, y, r, r * (0.5 + rnd()), 0, 0, 6.283); g.fill();
    }
  } else if (species === 'pine') {
    g.fillStyle = 'rgb(58,38,31)'; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 260; i++) {
      const x = rnd() * S, y = rnd() * S;
      const w = 22 + rnd() * 52, h = 14 + rnd() * 34;
      const l = 0.55 + rnd() * 0.75;
      g.save();
      wrapX((o) => {
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.translate(x + o, y); g.rotate((rnd() - 0.5) * 0.5);
        g.fillStyle = `rgba(${(126 * l) | 0},${(80 * l) | 0},${(56 * l) | 0},0.85)`;
        g.beginPath();
        g.moveTo(-w / 2, -h / 2); g.lineTo(w / 2, -h / 2 + (rnd() - 0.5) * 8);
        g.lineTo(w / 2 + (rnd() - 0.5) * 8, h / 2); g.lineTo(-w / 2, h / 2 - (rnd() - 0.5) * 8);
        g.closePath(); g.fill();
      });
      g.restore();
      g.setTransform(1, 0, 0, 1, 0, 0);
    }
    for (let i = 0; i < 500; i++) {
      const x = rnd() * S, y = rnd() * S;
      g.fillStyle = `rgba(24,14,10,${0.05 + rnd() * 0.28})`;
      wrapX((o) => g.fillRect(x + o, y, 1 + rnd() * 4, 3 + rnd() * 22));
    }
  } else if (species === 'cherry') {
    g.fillStyle = 'rgb(96,88,84)'; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 300; i++) {
      const x = rnd() * S, y = rnd() * S, w = 12 + rnd() * 60;
      g.fillStyle = `rgba(48,42,40,${0.10 + rnd() * 0.35})`;
      wrapX((o) => g.fillRect(x + o, y, w, 1 + rnd() * 3));
    }
    for (let i = 0; i < 220; i++) {
      const x = rnd() * S, y = rnd() * S;
      g.fillStyle = `rgba(150,142,136,${0.06 + rnd() * 0.18})`;
      wrapX((o) => g.fillRect(x + o, y, 4 + rnd() * 26, 1 + rnd() * 2));
    }
  } else {
    g.fillStyle = 'rgb(112,101,90)'; g.fillRect(0, 0, S, S);
    // wide furrows first, fine striation on top
    for (let i = 0; i < 34; i++) {
      const x = rnd() * S, w = 8 + rnd() * 26;
      g.fillStyle = `rgba(38,32,27,${0.16 + rnd() * 0.30})`;
      wrapX((o) => {
        g.beginPath();
        let pxx = x + o;
        g.moveTo(pxx, 0);
        for (let y = 0; y <= S; y += 48) { pxx += (rnd() - 0.5) * 14; g.lineTo(pxx, y); }
        for (let y = S; y >= 0; y -= 48) { g.lineTo(pxx + w, y); }
        g.closePath(); g.fill();
      });
    }
    for (let i = 0; i < 560; i++) {
      const x = rnd() * S, w = 1 + rnd() * 5;
      const dark = rnd() < 0.55;
      const l = dark ? 0.28 + rnd() * 0.34 : 1.20 + rnd() * 0.42;
      g.fillStyle = `rgba(${Math.min(255, 112 * l) | 0},${Math.min(255, 101 * l) | 0},${Math.min(255, 90 * l) | 0},${0.12 + rnd() * 0.42})`;
      wrapX((o) => {
        g.beginPath();
        let px = x + o;
        g.moveTo(px, 0);
        for (let y = 0; y <= S; y += 64) { px += (rnd() - 0.5) * 6; g.lineTo(px, y); }
        for (let y = S; y >= 0; y -= 64) { g.lineTo(px + w, y); }
        g.closePath(); g.fill();
      });
    }
    for (let i = 0; i < 300; i++) {
      const x = rnd() * S, y = rnd() * S;
      g.fillStyle = `rgba(58,50,44,${0.06 + rnd() * 0.20})`;
      wrapX((o) => { g.beginPath(); g.ellipse(x + o, y, 2 + rnd() * 7, 1 + rnd() * 3, 0, 0, 6.283); g.fill(); });
    }
  }
  return texOf(c, true, aniso);
}

// ---------------------------------------------------------------------------
// mesh assembly
// ---------------------------------------------------------------------------
class Mesher {
  constructor() { this.p = []; this.n = []; this.t = []; this.d = []; this.f = []; this.i = []; }
  get count() { return this.p.length / 3; }
  vert(px, py, pz, nx, ny, nz, u, v, sway, phase, ao, tint, flut) {
    const k = this.p.length / 3;
    this.p.push(px, py, pz); this.n.push(nx, ny, nz); this.t.push(u, v);
    this.d.push(sway, phase, ao, tint); this.f.push(flut);
    return k;
  }
  quad(a, b, c, d) { this.i.push(a, b, c, a, c, d); }
  geo() {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.t, 2));
    g.setAttribute('aData', new THREE.Float32BufferAttribute(this.d, 4));
    g.setAttribute('aFlut', new THREE.Float32BufferAttribute(this.f, 1));
    g.setIndex(this.i);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    return g;
  }
}

const V = () => new THREE.Vector3();
const _a = V(), _b = V(), _c = V(), _n = V(), _bi = V();

// Tapered tube along a polyline using a rotation-minimising frame, so trunks
// can curve hard without the cross-section twisting.
function tube(m, pts, radial, o) {
  const rings = [];
  let prevN = null, arc = 0;
  for (let i = 0; i < pts.length; i++) {
    const cur = pts[i];
    const T = _a.set(0, 0, 0);
    if (i === 0) T.copy(pts[1].p).sub(pts[0].p);
    else if (i === pts.length - 1) T.copy(pts[i].p).sub(pts[i - 1].p);
    else T.copy(pts[i + 1].p).sub(pts[i - 1].p);
    if (T.lengthSq() < 1e-9) T.set(0, 1, 0);
    T.normalize();
    if (i > 0) arc += pts[i].p.distanceTo(pts[i - 1].p);
    let N;
    if (!prevN) {
      N = Math.abs(T.y) > 0.9 ? V().set(1, 0, 0) : V().set(0, 1, 0);
      N.addScaledVector(T, -N.dot(T));
    } else {
      N = prevN.clone().addScaledVector(T, -prevN.dot(T));
      if (N.lengthSq() < 1e-8) { N.set(1, 0, 0).addScaledVector(T, -T.x); }
    }
    N.normalize();
    prevN = N;
    const B = _bi.crossVectors(T, N);
    const ring = [];
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      _n.set(N.x * ca + B.x * sa, N.y * ca + B.y * sa, N.z * ca + B.z * sa);
      const rr = cur.r * (1 + o.lobe * Math.sin(a * o.lobeN + o.lobePhase));
      ring.push(m.vert(
        cur.p.x + _n.x * rr, cur.p.y + _n.y * rr, cur.p.z + _n.z * rr,
        _n.x, _n.y, _n.z,
        (j / radial) * o.uRep, arc * o.vScale + o.vOff,
        cur.sway, o.phase, cur.ao, 0, 0,
      ));
    }
    rings.push(ring);
  }
  for (let i = 0; i < rings.length - 1; i++)
    for (let j = 0; j < radial; j++)
      m.quad(rings[i][j], rings[i][j + 1], rings[i + 1][j + 1], rings[i + 1][j]);
}

// One foliage card. Vertex normals are taken from the canopy sphere, not the
// quad, so a shell of cards lights like a single rounded volume.
function card(m, centre, nrm, w, h, cell, centreOfMass, sway, phase, ao, tint, flut, rnd) {
  const n = _a.copy(nrm).normalize();
  let up = _b.set(0, 1, 0);
  if (Math.abs(n.y) > 0.93) up.set(1, 0, 0);
  const right = V().crossVectors(up, n).normalize();
  const up2 = V().crossVectors(n, right).normalize();
  // spin the card in its own plane so cards do not all share an axis
  const sp = rnd() * Math.PI * 2, cs = Math.cos(sp), sn = Math.sin(sp);
  const rx = right.x * cs + up2.x * sn, ry = right.y * cs + up2.y * sn, rz = right.z * cs + up2.z * sn;
  const ux = -right.x * sn + up2.x * cs, uy = -right.y * sn + up2.y * cs, uz = -right.z * sn + up2.z * cs;

  const cx = (cell % 4) * 0.25, cy = ((cell / 4) | 0) * 0.25;
  const flip = rnd() < 0.5;
  const idx = [];
  for (let k = 0; k < 4; k++) {
    const sx = k === 0 || k === 3 ? -0.5 : 0.5;
    const sy = k < 2 ? -0.5 : 0.5;
    const px = centre.x + rx * sx * w + ux * sy * h;
    const py = centre.y + ry * sx * w + uy * sy * h;
    const pz = centre.z + rz * sx * w + uz * sy * h;
    _c.set(px - centreOfMass.x, py - centreOfMass.y, pz - centreOfMass.z);
    if (_c.lengthSq() < 1e-6) _c.copy(n);
    _c.normalize().multiplyScalar(0.76).addScaledVector(n, 0.24).normalize();
    let u = (flip ? 1 - (sx + 0.5) : sx + 0.5) * 0.245 + 0.0025;
    const v = (sy + 0.5) * 0.245 + 0.0025;
    idx.push(m.vert(px, py, pz, _c.x, _c.y, _c.z, cx + u, cy + v,
      sway, phase, ao, tint, flut * (0.30 + 0.70 * (sy + 0.5))));
  }
  m.quad(idx[0], idx[1], idx[2], idx[3]);
}

// ---------------------------------------------------------------------------
// branch growth
// ---------------------------------------------------------------------------
function growTree(cfg, rnd) {
  const trunk = new Mesher();
  const tips = [];
  const H = cfg.H;
  const radial = cfg.radial;
  const opts = { lobe: cfg.lobe, lobeN: cfg.lobeN, lobePhase: rnd() * 6.283, uRep: cfg.uRep, vScale: cfg.vScale, vOff: 0, phase: 0 };

  function limb(from, dir, len, r0, r1, swayFrom, swayTo, segs, curlUp, wander, taperAO) {
    const pts = [];
    const p = from.clone();
    const d = dir.clone().normalize();
    const up = V().set(0, 1, 0);
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      pts.push({
        p: p.clone(),
        r: r0 + (r1 - r0) * Math.pow(t, 0.85),
        sway: swayFrom + (swayTo - swayFrom) * t,
        ao: taperAO(p.y, t),
      });
      if (i === segs) break;
      p.addScaledVector(d, len / segs);
      d.addScaledVector(up, curlUp / segs);
      d.x += (rnd() - 0.5) * wander;
      d.z += (rnd() - 0.5) * wander;
      d.y += (rnd() - 0.5) * wander * 0.55;
      d.normalize();
    }
    opts.vOff = rnd() * 3;
    opts.phase = rnd();
    tube(trunk, pts, radial, opts);
    return { p, d, pts };
  }

  // Pick an attachment point somewhere ALONG a parent limb rather than only at
  // its far end. Branching only ever at the tip is what produced the acacia:
  // every primary limb left the trunk at one single height, so the whole crown
  // sat on one plane and the trunk below it was bare. Staggering the attachment
  // heights is the difference between a plate on a pole and a tree.
  function attach(f, range, k, n) {
    if (!range || !f.pts || f.pts.length < 2) {
      return { p: f.p, d: f.d, r: f.r, sway: f.sway, len: f.len };
    }
    // The k-th of n children takes the k-th SLICE of the range, jittered inside
    // it. Drawing t uniformly for each child independently lets four limbs land
    // within a few centimetres of each other perhaps a third of the time, and
    // when they do the tree is back to a single flat fan on a bare pole. This
    // guarantees the limbs are spread up the parent.
    const u = n > 1 ? (k + 0.5 + (rnd() - 0.5) * 0.72) / n : rnd();
    const t = range[0] + THREE.MathUtils.clamp(u, 0, 1) * (range[1] - range[0]);
    const last = f.pts.length - 1;
    const i = Math.min(last, Math.max(1, Math.round(t * last)));
    const tt = i / last;
    const d = f.pts[i].p.clone().sub(f.pts[i - 1].p);
    if (d.lengthSq() < 1e-9) d.copy(f.d); else d.normalize();
    return {
      p: f.pts[i].p.clone(),
      d,
      r: f.pts[i].r,
      sway: f.pts[i].sway,
      len: f.baseLen + (f.len - f.baseLen) * tt,
    };
  }

  const baseAO = (y) => 0.24 + 0.76 * THREE.MathUtils.smoothstep(y, 0, H * 0.30);

  // trunk
  const lean = V().set(rnd() - 0.5, 0, rnd() - 0.5).normalize().multiplyScalar(cfg.lean);
  const start = V().set(0, -0.35, 0);
  const trunkTop = H * cfg.trunkFrac;
  const dir0 = V().set(lean.x, 1, lean.z).normalize();
  const end = limb(start, dir0, trunkTop, cfg.baseR, cfg.baseR * cfg.trunkTaper,
    0, trunkTop / (H * 1.05), cfg.trunkSegs, cfg.trunkCurl, cfg.trunkWander, baseAO);

  let frontier = [{
    p: end.p, d: end.d, pts: end.pts, r: cfg.baseR * cfg.trunkTaper,
    sway: trunkTop / (H * 1.05), len: trunkTop, baseLen: 0,
  }];

  for (let lv = 0; lv < cfg.levels.length; lv++) {
    const L = cfg.levels[lv];
    const next = [];
    for (const f of frontier) {
      const n = L.n[0] + ((rnd() * (L.n[1] - L.n[0] + 1)) | 0);
      const base = rnd() * Math.PI * 2;
      for (let k = 0; k < n; k++) {
        const a = attach(f, L.along, k, n);
        const az = base + (k / n) * Math.PI * 2 + (rnd() - 0.5) * 0.8;
        const pol = THREE.MathUtils.degToRad(L.ang[0] + rnd() * (L.ang[1] - L.ang[0]));
        // rotate the parent direction away from its axis by `pol` around `az`
        const pd = a.d.clone().normalize();
        let side = V().set(0, 1, 0);
        if (Math.abs(pd.y) > 0.92) side.set(1, 0, 0);
        const rgt = V().crossVectors(side, pd).normalize();
        const upx = V().crossVectors(pd, rgt).normalize();
        const off = rgt.clone().multiplyScalar(Math.cos(az)).addScaledVector(upx, Math.sin(az));
        const nd = pd.clone().multiplyScalar(Math.cos(pol)).addScaledVector(off, Math.sin(pol)).normalize();
        const len = H * L.lenF * (0.75 + rnd() * 0.5);
        const r0 = a.r * (0.86 + rnd() * 0.12);
        const r1 = r0 * L.rMul * (0.85 + rnd() * 0.3);
        const total = a.len + len;
        const sw1 = Math.min(1, total / (H * 1.05));
        const e = limb(a.p, nd, len, r0, r1, a.sway, sw1, L.segs, L.curlUp, L.wander,
          (y, t) => Math.min(1, baseAO(y)) * (0.86 + 0.14 * t));
        const rec = { p: e.p, d: e.d, pts: e.pts, r: r1, sway: sw1, len: total, baseLen: a.len, lv };
        const last = lv === cfg.levels.length - 1;
        // Foliage hangs off the last TWO levels, not just the twig ends —
        // otherwise the tree reads as a bare skeleton with confetti on the tips.
        if (last || lv >= (cfg.tipFrom ?? 99)) tips.push(rec);
        if (!last) next.push(rec);
      }
    }
    frontier = next;
  }
  return { trunk, tips, H };
}

// ---------------------------------------------------------------------------
// species builders
// ---------------------------------------------------------------------------
// Momiji, Japanese maple. The old config gave it a 0.42*H clear trunk before
// the first fork, which is an acacia proportion: pole, then crown. A momiji
// forks at roughly a quarter of its height into several leaders that immediately
// go WIDE and only barely go up, so the canopy occupies most of the silhouette
// and is broader than it is tall. Outer twigs droop (negative curlUp).
function mapleCfg(rnd, lod, cherry) {
  const H = cherry ? 6.2 + rnd() * 3.0 : 6.6 + rnd() * 4.6;
  return {
    H,
    radial: lod === 0 ? 6 : 4,
    baseR: H * (cherry ? 0.022 : 0.025),
    trunkTaper: 0.54,
    trunkFrac: cherry ? 0.34 : 0.40,
    trunkSegs: lod === 0 ? 5 : 3,
    trunkCurl: 0.06,
    trunkWander: 0.18,
    lean: cherry ? 0.16 : 0.26,
    lobe: 0.13, lobeN: 3, uRep: 2.0, vScale: 0.42,
    tipFrom: 1,
    levels: cherry
      ? [
        { n: [3, 4], lenF: 0.36, ang: [30, 52], rMul: 0.66, segs: lod === 0 ? 4 : 2, curlUp: 0.34, wander: 0.10, along: [0.62, 1.0] },
        { n: [2, 3], lenF: 0.26, ang: [26, 52], rMul: 0.62, segs: lod === 0 ? 3 : 2, curlUp: 0.26, wander: 0.16, along: [0.40, 1.0] },
        { n: [2, 3], lenF: 0.16, ang: [30, 62], rMul: 0.58, segs: 1, curlUp: -0.06, wander: 0.22, along: [0.34, 1.0] },
      ]
      : [
        // leaders leave the short trunk almost horizontally
        { n: [3, 4], lenF: 0.34, ang: [46, 74], rMul: 0.58, segs: lod === 0 ? 4 : 2, curlUp: 0.55, wander: 0.12, along: [0.62, 1.0] },
        { n: [2, 3], lenF: 0.24, ang: [34, 64], rMul: 0.54, segs: lod === 0 ? 3 : 2, curlUp: 0.18, wander: 0.18, along: [0.38, 1.0] },
        // and the twigs sag back down: the tiers hang, they do not reach
        { n: [2, 3], lenF: 0.15, ang: [40, 78], rMul: 0.52, segs: 1, curlUp: -0.22, wander: 0.26, along: [0.32, 1.0] },
      ],
  };
}

function buildBroadleaf(rnd, lod, cherry) {
  const cfg = mapleCfg(rnd, lod, cherry);
  const { trunk, tips, H } = growTree(cfg, rnd);
  const leaf = new Mesher();

  // canopy centroid + radius
  const com = V();
  for (const t of tips) com.add(t.p);
  com.multiplyScalar(1 / Math.max(1, tips.length));
  let rad = 0;
  for (const t of tips) rad = Math.max(rad, t.p.distanceTo(com));
  rad = Math.max(rad, H * 0.20);

  const perTip = lod === 0 ? 8 : 5;
  const sizeMul = lod === 0 ? 1.0 : 1.16;
  // Maple cards are DELIBERATELY SMALL. A tier is only about 0.6 * rad clear of
  // the tier under it; a card taller than that gap bridges it and the layering
  // is erased no matter how the plates are positioned. Cherry keeps the bigger
  // softer cards because it is meant to be one cloud.
  const puff = H * (cherry ? 0.140 : 0.112);
  const dirv = V();

  // nBias tilts the shell normal up or down. It is what makes a flat plate read
  // as a SHELF: the cards on top of a plate face the low sun and catch the key,
  // the cards on its underside face away and drop into shade, and the boundary
  // between them draws a horizontal line across the crown. Without it a plate of
  // outward-facing cards lights identically top and bottom and disappears.
  const emit = (pos, sway, phase, sizeK, nBias, aoMul) => {
    const off = _c.copy(pos).sub(com);
    const dist = off.length() / (rad * 1.05);
    // Steep AO ramp: cards buried in the middle of the crown must go genuinely
    // dark, or the canopy lights like a solid painted ball.
    const ao = THREE.MathUtils.clamp(0.08 + 1.00 * dist, 0, 1)
      * (0.74 + 0.26 * THREE.MathUtils.clamp(off.y / rad + 0.5, 0, 1)) * (aoMul || 1);
    const nrm = off.lengthSq() < 1e-6 ? V().set(0, 1, 0) : off.clone().normalize();
    if (nBias) { nrm.y += nBias; nrm.x *= 0.55; nrm.z *= 0.55; }
    // splay the shell normal so neighbouring cards do not share one normal
    nrm.x += (rnd() - 0.5) * 0.55; nrm.y += (rnd() - 0.5) * 0.38; nrm.z += (rnd() - 0.5) * 0.55;
    nrm.normalize();
    const s = puff * (cherry ? 0.80 + rnd() * 1.55 : 0.72 + rnd() * 1.10) * sizeMul * (sizeK || 1);
    card(leaf, pos, nrm, s, s * (0.78 + rnd() * 0.44), (rnd() * 16) | 0, com,
      sway, phase, THREE.MathUtils.clamp(ao, 0.07, 1.0), rnd(), s * 0.13, rnd);
  };

  // Tip cards are squashed vertically for maple: a spherical scatter around
  // every twig end fills the gaps between the tiers straight back in and undoes
  // the layering the shell pass exists to create.
  const tipFlat = cherry ? 1.0 : 0.42;
  for (const t of tips) {
    for (let k = 0; k < perTip; k++) {
      dirv.set(rnd() - 0.5, (rnd() - 0.5) * tipFlat, rnd() - 0.5);
      if (dirv.lengthSq() < 1e-6) dirv.set(0, 1, 0);
      dirv.normalize().multiplyScalar(puff * (0.25 + rnd() * 0.95));
      emit(V().copy(t.p).add(dirv), Math.min(1, t.sway * 1.04), rnd());
    }
  }
  // The tiered layout spreads cards over four wide flat discs instead of over
  // one sphere shell — several times the surface area for the same card count —
  // so the shell budget has to go up with it or the crown turns to spatter.
  const shellMul = cherry ? 3.0 : 9.6;
  const shell = lod === 0 ? Math.round(tips.length * shellMul) : Math.round(tips.length * shellMul * 0.58);
  const l1 = rnd() * 6.283, l2 = rnd() * 6.283, l3 = rnd() * 6.283;

  // Every shell card gets pulled toward the nearest real twig end before it is
  // emitted. The tier formula alone places cards on an abstract lens surface, so
  // a card can and does land in open air with no branch anywhere near it — which
  // is exactly the "leaf cluster floating with sky between it and the tree" read.
  // The pull only bites on cards that are already further from a twig than a card
  // is wide, so the tiered silhouette the plates exist to draw survives intact.
  //
  // IT LIVES HERE, ABOVE THE CHERRY BRANCH, BECAUSE THE CHERRY BRANCH RETURNS.
  // This used to be declared below the `if (cherry) { ... return; }` block, so
  // the cherry shell — the ONLY foliage a cherry has, 3.0 cards per twig placed
  // on an abstract lobed sphere with no reference to the branches at all — was
  // the one card path in the file with no binding pass whatsoever. Measured on
  // the shipped build with the canopy audit (tools/canopyaudit.mjs, link radius
  // 0.45 = the atlas's own measured opaque radius): cherry LOD0 came back with
  // 59 cards in 54 clusters that had no wood anywhere in them, LOD1 24 in 22.
  //
  // THE FRACTIONAL PULL WAS NEVER A BOUND, EITHER. k caps at 0.42, so a card
  // starting 4x the slack away still ends up 2.3x the slack away — the pull
  // scales the error down, it does not clamp it. Measured across all LOD0/LOD1
  // variants, the 90th-percentile maple card sat 3.32 card-radii from the
  // nearest wood with the pull already applied. So after the proportional pull
  // there is now an absolute CEILING: no card may end further from its twig
  // than `ceil`, and one that would is moved onto that sphere exactly. That is
  // the invariant a critic can check — "no card is further from wood than N
  // card-widths" — rather than "a pull is applied and we hope".
  const _tp = V();
  const bindToTwig = (p) => {
    if (!tips.length) return p;
    let best = 1e9, bx = 0, by = 0, bz = 0;
    for (const t of tips) {
      const d2 = _tp.copy(t.p).sub(p).lengthSq();
      if (d2 < best) { best = d2; bx = t.p.x; by = t.p.y; bz = t.p.z; }
    }
    let dmin = Math.sqrt(best);
    const slack = puff * 1.05;
    if (dmin <= slack) return p;
    const k = Math.min(0.42, 0.42 * ((dmin - slack) / (rad * 0.45)));
    p.x += (bx - p.x) * k; p.y += (by - p.y) * k; p.z += (bz - p.z) * k;
    dmin *= (1 - k);
    // Absolute ceiling, in card widths. 2.6 is deliberately loose: it is above
    // the p90 the maple tiers already sit at once the pull has run, so the
    // plates keep their reach and only the genuine outliers move. Tightening it
    // to ~1.5 pulls the outer third of every tier inward and welds the plates
    // into one ball, which is the failure the tiered layout exists to avoid.
    const ceil = puff * 2.6;
    if (dmin > ceil) {
      const k2 = 1 - ceil / dmin;
      p.x += (bx - p.x) * k2; p.y += (by - p.y) * k2; p.z += (bz - p.z) * k2;
    }
    return p;
  };

  if (cherry) {
    // Cherry stays a SOFT CLOUD: one rounded, slightly flattened mass with a
    // very lacy edge and almost no visible internal structure. Blossom reads as
    // vapour, not as leaves on branches.
    for (let i = 0; i < shell; i++) {
      const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2;
      const sq = Math.sqrt(Math.max(0, 1 - u * u));
      const lobes = 1 + 0.18 * Math.sin(th * 3 + l1) + 0.13 * Math.sin(th * 5 + l2) + 0.11 * Math.sin(u * 4.0 + l3);
      const k = (0.60 + rnd() * 0.54) * lobes;
      dirv.set(sq * Math.cos(th) * k, u * k * 0.80 + 0.10, sq * Math.sin(th) * k);
      const outer = Math.min(1.35, dirv.length());
      emit(bindToTwig(V().copy(com).addScaledVector(dirv, rad)), 0.94 + rnd() * 0.08, rnd(),
        outer > 1.0 ? 0.58 : 1.0);
    }
    return { trunk, leaf, H, radius: rad + puff, canopyY: com.y };
  }

  // MAPLE SHELL: horizontal TIERS, not a sphere.
  //
  // The crown is built as three or four flattened lens-shaped plates stacked
  // with air between them, widest at the bottom and narrowing upward, each one
  // sagging at its outer edge. That layered read — plate, sky, plate — is the
  // single strongest cue that separates a momiji from a spreading acacia, and a
  // sphere of cards can never produce it no matter how it is lobed.
  // Three plates, not four: with four the gaps get thinner than the cards and
  // the whole point is lost. Widest at the bottom, narrowing to a cap — a
  // stepped pyramid in silhouette.

  const layers = 3;
  const yTop = 0.66, yBot = -0.40;
  for (let L = 0; L < layers; L++) {
    const t = layers === 1 ? 0 : L / (layers - 1);
    const ly = yBot + (yTop - yBot) * t;
    // widest plate low down, tapering to a small cap
    const lr = (1.22 - 0.40 * t) * (0.90 + rnd() * 0.18);
    const thick = 0.062 + 0.030 * rnd();
    const nHere = Math.round((shell / layers) * (1.22 - 0.36 * t));
    for (let i = 0; i < nHere; i++) {
      const th2 = rnd() * Math.PI * 2;
      const rr = Math.sqrt(rnd());                 // area-uniform across the plate
      const lobes = 1 + 0.22 * Math.sin(th2 * 3 + l1 + L * 1.7)
        + 0.15 * Math.sin(th2 * 5 + l2) + 0.10 * Math.sin(th2 * 2 + l3);
      const k = lr * rr * lobes;
      // Droop: the outer third of every plate hangs below its own centre line.
      // It has to stay SMALLER than the gap between plates — at 0.30-0.52 the
      // outer edge of each tier landed on the tier below it and welded the whole
      // crown back into one ball.
      const droop = -Math.pow(rr, 2.6) * (0.11 + 0.09 * rnd());
      dirv.set(
        Math.cos(th2) * k,
        ly + droop + (rnd() - 0.5) * thick,
        Math.sin(th2) * k,
      );
      // outer cards small so each tier ends in lace, not in a cut edge
      const sizeK = rr > 0.86 ? 0.56 : rr > 0.66 ? 0.80 : 1.0;
      // top half of the plate faces the sky, bottom half faces the ground
      const up = rnd() < 0.52;
      emit(bindToTwig(V().copy(com).addScaledVector(dirv, rad)), 0.90 + rnd() * 0.12, rnd(),
        sizeK, up ? 1.15 : -1.15, up ? 1.0 : 0.58);
    }
  }
  return { trunk, leaf, H, radius: rad * 1.12 + puff, canopyY: com.y };
}

// Kuromatsu, Japanese black pine. The previous version read as a Monterey
// cypress: a tall bare pole that forked at 60-80 degrees into one continuous
// horizontal plate. Three things caused that and all three are changed here.
//   1. The plates were HUGE — card size ran to 0.41*H, so neighbouring tips
//      merged into a single spreading canopy with no sky in it. Cards are now
//      ~0.09*H and there are more of them, so each branch end carries a small
//      discrete cloud pad and the gaps between pads survive.
//   2. The trunk was thin (0.030*H) and straight-ish. It is now 0.048*H with
//      a hard lean and a strong wander, so it reads gnarled, not lanky.
//   3. Branches all left the trunk at the same polar angle band. They now
//      alternate: a few long low limbs that sweep out and then hook UP, and a
//      short crown, which is the niwaki asymmetry.
function buildPine(rnd, lod) {
  const H = 6.0 + rnd() * 3.6;
  const cfg = {
    H,
    radial: lod === 0 ? 6 : 4,
    baseR: H * 0.042,
    trunkTaper: 0.42,           // fast taper: thick base, thin limbs
    // A tall trunk that the crown CLOTHES, not a pole with a lid. Limbs attach
    // from a third of the way up it, so the foliage covers 0.2*H to 1.0*H.
    trunkFrac: 0.64,
    trunkSegs: lod === 0 ? 8 : 5,
    trunkCurl: -0.10,
    trunkWander: 0.40,          // the twist that makes it read as kuromatsu
    lean: 0.62,                 // windswept: the whole tree leans off the ridge
    lobe: 0.22, lobeN: 4, uRep: 2.0, vScale: 0.40,
    tipFrom: 1,
    levels: [
      // several long, near-horizontal primary limbs. Three or four, never two:
      // exactly two makes a symmetric wishbone and the tree reads as a catapult.
      { n: [5, 6], lenF: 0.24, ang: [62, 92], rMul: 0.50, segs: lod === 0 ? 4 : 3, curlUp: 0.30, wander: 0.32, along: [0.24, 1.0] },
      // they hook upward at the ends — the signature kink
      { n: [2, 3], lenF: 0.16, ang: [30, 74], rMul: 0.50, segs: lod === 0 ? 3 : 2, curlUp: 0.95, wander: 0.32, along: [0.50, 1.0] },
      { n: [2, 2], lenF: 0.08, ang: [16, 52], rMul: 0.50, segs: 1, curlUp: 0.55, wander: 0.32, along: [0.50, 1.0] },
    ],
  };
  const { trunk, tips } = growTree(cfg, rnd);
  const leaf = new Mesher();
  const com = V();
  for (const t of tips) com.add(t.p);
  com.multiplyScalar(1 / Math.max(1, tips.length));
  let rad = 0;
  for (const t of tips) rad = Math.max(rad, t.p.distanceTo(com));
  rad = Math.max(rad, H * 0.28);

  // Foliage as discrete cloud pads clustered on the branch tips. Small cards,
  // packed tight inside a pad, nothing between pads.
  const perTip = lod === 0 ? 15 : 8;
  const sizeMul = lod === 0 ? 1.0 : 1.30;
  const nrm = V(), pos = V();
  for (const t of tips) {
    // wide spread of pad sizes so the crown is lumpy, never a uniform fringe
    const padR = H * 0.138 * (0.60 + rnd() * 0.90) * (t.lv === 1 ? 1.20 : 0.94);
    for (let k = 0; k < perTip; k++) {
      // THE RADIAL EXPONENT DECIDES WHERE THE TWIG IS, NOT JUST HOW THE PAD
      // LOOKS. r = pow(u, e) * padR puts a fraction u = f^(1/e) of the cards
      // inside a fraction f of the radius, so e < 0.5 is a distribution biased
      // OUTWARD — sparser at the centre than area-uniform. At the old e = 0.42
      // only 12.6% of a pad's cards landed inside the inner 42% of it, so a pad
      // was a RING with a thin middle, and the middle is exactly where the twig
      // end that is supposed to be holding the pad up comes through. That is the
      // geometry behind "a bare trunk with a disc of disconnected green clusters
      // hovering above it": the wood is visible through the hole in its own
      // foliage. Measured with tools/canopyaudit.mjs, 45.3% of pine LOD0 cards
      // sat further than one card-radius from any wood vertex.
      //
      // 0.55 is still outward-biased (area-uniform is 0.5) so the pad keeps a
      // full rim, but it moves ~1.5 cards of every 15 from the rim into the
      // core: 12.6% -> 21.6% of cards inside the inner 42%. padR is untouched,
      // so the pad's OUTER envelope — the silhouette the niwaki read depends on
      // — is exactly the same size it was.
      // A PAD MUST HAVE AN OPAQUE CORE, NOT JUST A GOOD DISTRIBUTION.
      //
      // The exponent above redistributes where cards land inside the pad, but a
      // distribution is a statement about averages: with 15 draws from it a
      // given pad can still come back with nothing over its own twig, and that
      // pad is the one a critic photographs. The first three cards of every pad
      // are now placed ON the twig end (rr -> ~0) unconditionally, so no pad in
      // the forest can be a ring. That is an invariant, not a probability.
      //
      // MEASURED with the flag-mask connected-component audit on 01-sunset-ridge
      // (leaf FS recompiled to flat magenta, rAF frozen): the shipped canopy came
      // back as 940 separate components with 8.34% of its pixels in components
      // under 256 px and the largest holding only 29.4% of the mask — i.e. a
      // confetti field, which is exactly the "disc of disconnected green pixel
      // clusters hovering above a bare trunk" read.
      const core = k < 3;
      const a = rnd() * Math.PI * 2;
      const rr = core ? padR * 0.10 * rnd() : Math.pow(rnd(), 0.55) * padR;
      // A pad is a FLAT LENS, roughly four times as wide as it is deep. Pads as
      // tall as they are wide merge with their neighbours into one dark ball and
      // the tree stops being a pine.
      // LATERAL STRETCH 1.45 -> 1.12, PAD RADIUS UP 20% TO PAY FOR IT.
      // The 1.45 pushed the rim of every pad half again as far out as the radius
      // the card SIZE is derived from, so the outer cards of a pad were the ones
      // least able to reach their neighbours: the pad's own geometry guaranteed
      // gaps at its edge. Widening padR instead buys the same envelope
      // (1.45*padR -> 1.12*1.20*padR = 1.34*padR, 7% tighter) while making every
      // card in the pad 20% bigger, so neighbouring cards overlap instead of
      // just touching. Card size is derived from padR a few lines below, which
      // is what makes this trade work at all.
      pos.set(t.p.x + Math.cos(a) * rr * 1.12,
        t.p.y + (rnd() - 0.5) * padR * 0.26 + padR * 0.10,
        t.p.z + Math.sin(a) * rr * 1.12);
      // pad normals fan slightly outward from the pad centre so a pad lights
      // like a small dome and not like one flat lid
      nrm.set(Math.cos(a) * 0.42, 1.0, Math.sin(a) * 0.42);
      nrm.x += (rnd() - 0.5) * 0.30; nrm.z += (rnd() - 0.5) * 0.30;
      nrm.normalize();
      const off = _c.copy(pos).sub(com);
      const dist = off.length() / (rad * 1.1);
      const ao = THREE.MathUtils.clamp(0.26 + 0.86 * dist, 0.16, 1.0) * (0.74 + 0.26 * THREE.MathUtils.clamp(off.y / rad + 0.5, 0, 1));
      const s = padR * (0.86 + rnd() * 0.50) * sizeMul;
      card(leaf, pos, nrm, s * 1.45, s * (0.44 + rnd() * 0.20), (rnd() * 16) | 0, com,
        Math.min(1, t.sway * 1.02), rnd(), ao, rnd(), s * 0.08, rnd);
    }
  }
  return { trunk, leaf, H, radius: rad + H * 0.10, canopyY: com.y };
}

// Take (madake): TALL, STRAIGHT, SEGMENTED, and above all DENSE. The read is a
// screen of vertical lines with the leaf mass held up in the top quarter. The
// old clump leaned its culms by up to 0.14 * H sideways, which turned a grove
// into a shuttlecock; the lateral drift is now a fifth of that, the culms are
// thinner and taller relative to their spacing, and there are half again as many
// of them inside a tighter footprint.
function buildBamboo(rnd, lod) {
  const trunk = new Mesher(), leaf = new Mesher();
  const culms = lod === 0 ? 22 + ((rnd() * 9) | 0) : 12 + ((rnd() * 5) | 0);
  const radial = lod === 0 ? 6 : 4;
  const R = 2.2 + rnd() * 1.1;
  let maxH = 0;
  const com = V();
  const nrm = V(), pos = V();
  const opts = { lobe: 0.012, lobeN: 5, lobePhase: 0, uRep: 1.0, vScale: 1, vOff: 0, phase: 0 };

  for (let ci = 0; ci < culms; ci++) {
    const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * R;
    const bx = Math.cos(a) * rr, bz = Math.sin(a) * rr;
    const H = 11.5 + rnd() * 7.5;
    maxH = Math.max(maxH, H);
    const r0 = 0.046 + rnd() * 0.026;
    const r1 = r0 * 0.50;
    const lx = Math.cos(a) * (0.010 + rnd() * 0.020) + (rnd() - 0.5) * 0.016;
    const lz = Math.sin(a) * (0.010 + rnd() * 0.020) + (rnd() - 0.5) * 0.016;
    const NODES = 10, SUB = lod === 0 ? 2 : 1;
    const pts = [];
    for (let i = 0; i <= NODES * SUB; i++) {
      const t = i / (NODES * SUB);
      const y = t * H;
      const drift = Math.pow(t, 1.7) * H;
      const nodeT = (i % SUB) === 0 ? 1.13 : 1.0;
      // Outer culms sink further so a clump sitting on a slope keeps its feet
      // in the ground instead of stilting on the downhill side.
      const sink = 0.3 + (rr / Math.max(R, 0.001)) * 0.75;
      pts.push({
        p: V().set(bx + lx * drift, y - sink, bz + lz * drift),
        r: (r0 + (r1 - r0) * Math.pow(t, 0.9)) * nodeT,
        sway: Math.pow(t, 0.92),
        ao: 0.30 + 0.70 * THREE.MathUtils.smoothstep(y, 0, 2.6),
      });
    }
    opts.vScale = 1 / H;
    opts.lobePhase = rnd() * 6.283;
    opts.phase = rnd();
    tube(trunk, pts, radial, opts);

    // Leaf sprays live in the TOP QUARTER only. Keeping the lower three
    // quarters of every culm bare is what makes a grove read as a colonnade of
    // green poles rather than as a hedge.
    const top = pts[pts.length - 1].p;
    com.add(top);
    const sprays = lod === 0 ? 8 : 4;
    for (let k = 0; k < sprays; k++) {
      const t = 0.74 + (k / sprays) * 0.28 + rnd() * 0.04;
      const tt = Math.min(0.995, t);
      const drift = Math.pow(tt, 1.7) * H;
      const cxp = bx + lx * drift, czp = bz + lz * drift;
      const cyp = tt * H - (0.3 + (rr / Math.max(R, 0.001)) * 0.75);
      const ang = rnd() * Math.PI * 2;
      const out = 0.25 + rnd() * 0.60;
      pos.set(cxp + Math.cos(ang) * out, cyp - 0.18 - rnd() * 0.42, czp + Math.sin(ang) * out);
      nrm.set(Math.cos(ang) * 0.75, 0.42 + rnd() * 0.4, Math.sin(ang) * 0.75).normalize();
      const s = (lod === 0 ? 0.86 : 1.34) * (0.80 + rnd() * 0.60);
      card(leaf, pos, nrm, s * 1.15, s, (rnd() * 16) | 0, V().set(bx, cyp, bz),
        Math.pow(tt, 0.9), rnd(), 0.58 + 0.42 * tt, rnd(), s * 0.20, rnd);
    }
  }
  com.multiplyScalar(1 / culms);
  return { trunk, leaf, H: maxH, radius: R + 1.6, canopyY: maxH * 0.7 };
}

// The impostor cross. Its proportions must match the full-geometry tree it
// replaces or the swap is visible as a size jump: maple/cherry are now short and
// broad, pine is short and broad-but-gappy, bamboo is tall and narrow.
const IMP_DIMS = {
  maple: { H: 9.6, W: 10.4 },
  cherry: { H: 8.4, W: 9.2 },
  pine: { H: 8.6, W: 9.4 },
  bamboo: { H: 16.0, W: 6.4 },
};

function buildImpostorGeo(rnd, species) {
  const leaf = new Mesher();
  const trunk = new Mesher();
  const H = IMP_DIMS[species].H;
  const W = IMP_DIMS[species].W;
  // Full 0..1 UVs: the impostor has its own texture now, not an atlas cell.
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI + rnd() * 0.25;
    const dx = Math.cos(a), dz = Math.sin(a);
    const idx = [];
    for (let q = 0; q < 4; q++) {
      const sx = q === 0 || q === 3 ? -0.5 : 0.5;
      const sy = q < 2 ? 0 : 1;
      const px = dx * sx * W, pz = dz * sx * W, py = sy * H - 0.3;
      // Normal biased outward AND up so a cross of three quads still lights
      // like a rounded mass; without the outward term all three quads share one
      // normal and the impostor goes flat and grey against the sky.
      const nx = dx * sx * 2, nz = dz * sx * 2;
      const nl = Math.hypot(nx, 0.95, nz);
      idx.push(leaf.vert(px, py, pz, nx / nl, 0.95 / nl, nz / nl,
        sx + 0.5, sy,
        Math.pow(sy, 1.4), rnd(), 0.62 + 0.30 * sy, 0.5, 0));
    }
    leaf.quad(idx[0], idx[1], idx[2], idx[3]);
  }
  // an empty trunk mesher keeps the bucket shape uniform
  trunk.vert(0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0);
  trunk.vert(0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0);
  trunk.vert(0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0);
  trunk.i.push(0, 1, 2);
  return { trunk, leaf, H, radius: W * 0.6, canopyY: H * 0.6 };
}

// ---------------------------------------------------------------------------
// shaders
// ---------------------------------------------------------------------------
// WIND_GAIN: trees own their AMPLITUDE, never the field. This carries the
// ratio between the mean of the private three-sine stack this file used to run
// (~0.26 at an ordinary gust) and the mean of wind.js's windGust() (~0.34), so
// the tuned lean magnitude survives the move onto the shared field.
const WIND_GAIN = 0.82;

const VS_COMMON = WIND_UNIFORMS_GLSL + WIND_GLSL + /* glsl */`
attribute vec4  aData;      // sway, phase, ao, cardTint
attribute float aFlut;
attribute vec3  iPos;
attribute vec4  iCfg;       // yaw, scale, phase, fade
attribute vec3  iTint;
// PER-INSTANCE SILHOUETTE. x = horizontal scale, y = vertical scale, z = signed
// lean (tan of the tilt, in the instance's own local +x, so the random yaw
// gives it a random world azimuth for free).
//
// Uniform scale alone cannot break a stamped forest: every tree keeps the SAME
// outline, just bigger, and a hillside of one outline at eleven sizes still
// reads as one asset repeated. Splitting scale into two axes turns one geometry
// into a continuum — squat and broad, tall and narrow — and the lean is what
// takes them off the vertical they were all stamped on.
attribute vec3  iShp;
// PER-INSTANCE CULL SPHERE. x = canopy-centre height above iPos, y = radius.
// The same two numbers repartition() tests on the CPU, carried onto the GPU so
// the near cull can be re-tested EVERY FRAME instead of once per rebuild.
attribute vec2  iSph;

uniform float uTime;        // private detail clock: per-card flutter only
uniform vec3  uCam;
uniform float uBend;
uniform float uFlut;
uniform float uNearCull;    // CFG.nearHard — see the CFG block

vec3 yawv(vec3 v, float c, float s) { return vec3(v.x * c + v.z * s, v.y, -v.x * s + v.z * c); }

// THE NEAR CULL, AS A PER-FRAME INVARIANT. repartition() runs at best every
// 0.30 s and at worst every 4 m of travel, so its clearance test describes
// where the camera WAS, not where it is; a gallop measured 273 drawn
// instance-frames inside the cull that no rebuild had revisited. This costs one
// distance per vertex and closes that window completely: a tree growing into
// the lens is removed on the frame it does it, not on the next rebuild.
bool nearCulled() {
  return distance(uCam, iPos + vec3(0.0, iSph.x, 0.0)) - iSph.y < uNearCull;
}

void treeTransform(out vec3 world, out vec3 nrm) {
  float yaw = iCfg.x, scl = iCfg.y, iph = iCfg.z;
  float c = cos(yaw), s = sin(yaw);

  // anisotropic scale, then shear. The shear is anchored at y=0 so the trunk
  // base stays planted on the terrain sample that placed it, and y is shortened
  // by the cosine of the tilt so a leaning tree is not also a taller one.
  vec3 q = position * vec3(iShp.x, iShp.y, iShp.x);
  float ln = iShp.z;
  q.x += q.y * ln;
  q.y *= 1.0 - 0.5 * ln * ln;
  // inverse-transpose of the same pair: reciprocal on the diagonal, and the
  // shear transposes onto the other axis with the opposite sign. Without this
  // a stretched crown lights as though it were still round.
  vec3 nl = normal * vec3(1.0 / iShp.x, 1.0 / iShp.y, 1.0 / iShp.x);
  nl.y -= nl.x * ln;

  vec3 p = yawv(q * scl, c, s);
  nrm = normalize(yawv(nl, c, s));

  // THE SHARED gust front (wind.js). This used to be a private three-sine stack
  // at 30-50 m/s phase speed, which is why the grove and the field it stood in
  // never leant on the same beat. windGust() already carries uWindStr.
  float sway  = aData.x;
  float gust  = windGust(iPos.xz) * ${WIND_GAIN.toFixed(3)};
  vec2  wdir  = windDirAt(iPos.xz);

  float lean = gust * pow(sway, 1.75) * uBend * scl;
  p.xz += wdir * lean;
  p.y  -= lean * lean * 0.11;

  // per-card flutter, strongest at the free edge of the card
  float ph = aData.y * 6.2831853 + iph * 6.2831853;
  float fl = sin(uTime * 3.6 + ph) * 0.62 + sin(uTime * 6.1 + ph * 1.63) * 0.38;
  vec3 fdir = normalize(vec3(wdir.x, 0.55, wdir.y));
  p += fdir * (fl * aFlut * uFlut * scl * (0.28 + 0.72 * gust));

  world = iPos + p;
}
`;

const VS_MAIN = /* glsl */`
#include <common>
#include <shadowmap_pars_vertex>
` + VS_COMMON + /* glsl */`
varying vec3  vWorld;
varying vec3  vNormal;
varying vec2  vUv;
varying vec3  vTint;
varying float vAO;
varying float vFade;
varying float vDepth;

void main() {
  if (iCfg.w < 0.0 || nearCulled()) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  vec3 world, nrm;
  treeTransform(world, nrm);

  vWorld  = world;
  vNormal = nrm;
  vUv     = uv;
  // per-card value variation: without it a canopy is one flat sheet of colour
  vTint   = iTint * (0.60 + 0.66 * aData.w);
  vAO     = aData.z;
  vFade   = iCfg.w;

  vec4 mv = viewMatrix * vec4(world, 1.0);
  vDepth  = -mv.z;

  vec4 worldPosition = vec4(world, 1.0);
  vec3 transformedNormal = mat3(viewMatrix) * nrm;
  #include <shadowmap_vertex>

  gl_Position = projectionMatrix * mv;
}
`;

const FS_HEAD = /* glsl */`
#include <common>
#include <packing>
#include <shadowmap_pars_fragment>

uniform sampler2D uMap;
uniform vec3  uSunDir, uSunColor, uSkyColor, uGroundColor, uAmbColor, uFogColor;
uniform float uFogDensity;
uniform float uAerialK;
uniform vec3  uHazeWarm, uHazeCool;
uniform vec3  uCam;

varying vec3  vWorld;
varying vec3  vNormal;
varying vec2  vUv;
varying vec3  vTint;
varying float vAO;
varying float vFade;
varying float vDepth;

float sunShadow() {
  #if defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0
    DirectionalLightShadow ds = directionalLightShadows[0];
    return getShadow(directionalShadowMap[0], ds.shadowMapSize, ds.shadowIntensity,
                     ds.shadowBias, ds.shadowRadius, vDirectionalShadowCoord[0]);
  #else
    return 1.0;
  #endif
}

// Aerial perspective, on exactly the model terrain.js uses (see its
// fog_fragment replacement) so a ridge and the trees standing on it haze as one
// thing. Foliage previously got the bare scene exp2 fog and NOTHING else, which
// is why a canopy 30 m away and a canopy on the far ridge came back the same
// value and the entire mid band collapsed into one flat mass.
//
// Two deliberate differences from the ground:
//   * uAerialK is set ~15% hotter for foliage. A canopy is a scattering volume
//     sitting up in the haze layer rather than a hard surface at its floor, so
//     it goes to sky value slightly ahead of the ground beneath it. That
//     difference is most of what separates a near grove from a far one.
//   * the altitude thinning is gentler, because a tree is never far enough above
//     the terrain to climb out of the haze the way a peak does.
vec3 applyFog(vec3 c, vec3 Vv) {
  // MERGE RECONCILIATION: this was written as exp2 (exp of -k*k*d*d) to match
  // terrain.js — and in the same wave terrain.js replaced ITS law with
  // Beer-Lambert in distance, because the squared form saturates (80% haze at
  // 1 km, 99.8% at 2 km) and collapsed the far half of the island onto one
  // value. Left alone the two disagreed hard at range: measured at 1 km the
  // canopy came back 88% hazed standing on ground that was 54% hazed, plus a
  // SECOND full exp2 pass to flat uFogColor on top of it. That is why the far
  // hillside in 06-forest read as blown white paper with pastel lollipops on
  // it. One LAW now, terrain's — Beer-Lambert in distance, not the old squared
  // form — with this file's own documented offsets kept and, as of this wave, a
  // much larger foliage coefficient (see below). uAerialK itself still runs ~15%
  // hotter than the ground's and the altitude thinning stays gentler.
  //
  // AERIAL PERSPECTIVE WAS INVERTED ON FOLIAGE, AND THIS COEFFICIENT IS WHY.
  // At 0.62 the extinction was 0.00088/m, so a canopy 200 m out picked up 18%
  // haze — nothing. Measured on shots/wave-e/01-sunset-ridge the canopy median
  // was [25,31,48] at 20 m, [25,31,48] at 120 m and [40,45,75] at 200 m: the
  // frame's own black floor at every band, i.e. distance made canopies DARKER
  // instead of lifting them toward the sky. Every reference does the opposite —
  // field_2, field_9 and field_16 all wash the far tree line into pale warm
  // haze so five or six depth bands stack visibly.
  //
  // 4.2 puts extinction at ~0.0060/m, which lands the bands at
  //   30 m 0.17   60 m 0.30   100 m 0.45   200 m 0.70   400 m 0.91   800 m 0.99
  // i.e. the ~200 m tree line sits at roughly 70% of the horizon haze value,
  // which is the target. This was bracketed against 06-forest at 3.4 and 6.5:
  // 3.4 still collapses the far half of a grove onto one value, 6.5 has the
  // maples 40 m away already washed and the far band drifting violet-grey.
  // Foliage is deliberately HOTTER than the ground here
  // (terrain.js runs 0.62 on its own uAerialK): a canopy is a scattering volume
  // up inside the haze layer, not a hard surface at its floor, and that offset
  // is most of what separates a near grove from a far one.
  float aerial = 1.0 - exp(-uAerialK * 4.20 * vDepth);
  aerial *= mix(1.0, 0.62, smoothstep(40.0, 320.0, vWorld.y));
  // Never all the way — the last few percent of contrast is what separates the
  // furthest canopy from the sky behind it. Terrain caps at 0.94; foliage is
  // allowed a little further so a tree does dissolve rather than stop dead.
  aerial = min(aerial, 0.97);
  // Looking into the low sun the haze is lit from behind and goes amber; looking
  // away from it it stays a cool blue-grey. One flat fog colour for both is what
  // makes a fogged forest read as grey soup.
  float sunAlign = smoothstep(-0.15, 0.90, dot(-Vv, uSunDir));
  // The off-sun end of this mix is pulled 30% toward the warm haze. The ground
  // can afford a fully cool away-from-sun haze because it is a hard surface with
  // its own albedo underneath; a canopy is thin and it is the aerial term that
  // supplies most of its value past 100 m, so taking the cool end neat sends a
  // far grove violet-grey (measured on 06-forest while bracketing this) instead
  // of the pale warm tree line every reference frame has.
  vec3 haze = uFogColor * mix(mix(uHazeCool, uHazeWarm, 0.30), uHazeWarm, sunAlign);
  // IN-SCATTER. The haze column between the camera and a far canopy is itself
  // lit, so looking into the low sun the far tree line is BRIGHTER than the near
  // grove, not merely lower contrast. Without this the ramp is a fade to grey
  // instead of the glow field_2 and field_16 are built on. Scaled by uSunColor
  // so it costs nothing at night, and squared on sunAlign so it stays on the
  // sun side of the frame.
  haze += uSunColor * (0.045 * sunAlign * sunAlign);
  return mix(c, haze, aerial);
}
`;

const FS_BARK = FS_HEAD + /* glsl */`
uniform vec3 uBarkColor;
uniform float uBump;

void main() {
  // vFade IS BINARY. It is a draw flag, not an opacity: repartition() hard-culls
  // with hysteresis and never hands an instance a fractional value, and the
  // vertex shader has already rejected the shadow-only ones. Do NOT reintroduce
  // a fractional fade here — alphaToCoverage on this target is EDGE
  // antialiasing only, and a partial coverage value comes back as a hard 4x4
  // screen door, never as a soft dissolve (probed on ANGLE/Metal; see CFG).
  if (vFade < 0.004) discard;
  vec3 tex = texture2D(uMap, vUv).rgb;
  vec3 N = normalize(vNormal);

  // Derive a bump normal from the bark's own luminance gradient. Without this
  // a tapered tube lights like a smooth plastic pipe no matter how good the
  // texture is.
  float lum = dot(tex, vec3(0.3333));
  vec3 dpx = dFdx(vWorld), dpy = dFdy(vWorld);
  vec3 r1 = cross(dpy, N), r2 = cross(N, dpx);
  float det = dot(dpx, r1);
  if (abs(det) > 1e-8) {
    vec3 grad = (r1 * dFdx(lum) + r2 * dFdy(lum)) / det;
    N = normalize(N - grad * uBump);
  }

  vec3 Vv = normalize(uCam - vWorld);
  float sh = sunShadow();

  float ndl = max(dot(N, uSunDir), 0.0);
  vec3 lit = uSunColor * ndl * sh;
  // Trunks live under their own canopy; without a lift they read as black
  // sticks and the tree loses its structure entirely.
  lit += (mix(uGroundColor, uSkyColor, 0.5 + 0.5 * N.y) + uAmbColor) * 1.55;

  // grazing rim off a low sun keeps the trunk from reading as a flat cylinder
  float rim = pow(1.0 - max(dot(N, Vv), 0.0), 2.6) * max(dot(N, uSunDir), 0.0);
  vec3 c = tex * uBarkColor * lit * (0.30 + 0.70 * vAO);
  c += uSunColor * rim * 0.30 * sh;

  gl_FragColor = vec4(applyFog(c, Vv), 1.0);
}
`;

const FS_LEAF = FS_HEAD + /* glsl */`
uniform float uCut;
uniform float uCutFar;
uniform float uTrans;
uniform float uSat;
// Coverage band, in PIXELS either side of the alpha isoline, and the card
// footprint in PIXELS below which there is no edge left to antialias at all.
// Both are screen-space quantities on purpose; see the block in main().
// uUvSpan is the UV extent of ONE card: 0.245 for a 4x4 leaf-atlas cell,
// 1.0 for an impostor, which owns its whole texture.
uniform float uCovPx;
uniform float uCovMinPx;
uniform float uUvSpan;

void main() {
  // Two opposite failures to dodge. Up close, a low cut lets the blurred alpha
  // padding through and fine leaf detail lands right on the threshold, which
  // stipples the whole canopy. Far away, mip levels average alpha down and the
  // canopy dissolves into lace. So: cut hard near, cut soft far.
  //
  // The LOD2 impostor sets uCutFar to 1.0 and opts out of that softening
  // entirely. It is only ever seen far away, its texture is dilated by exactly
  // one pixel instead of blurred, and softening its cut is precisely what used
  // to leave a fogged halo disc floating around each distant tree.
  float cut = uCut * mix(1.0, uCutFar, smoothstep(15.0, 70.0, vDepth));
  vec4 t = texture2D(uMap, vUv);

  // ALPHA TO COVERAGE, not a binary cut. A hard alpha test gives a canopy edge
  // exactly two states per pixel, so every leaf silhouette against bright sky
  // comes back as single-pixel stair steps, and there is no TAA in this stack to
  // clean them up afterwards. Widening the test to one texel of the alpha
  // gradient and handing the result to the MSAA coverage mask spends the samples
  // the frame is already paying for on the one edge that most needs them.
  //
  // THIS IS THE ONLY LEGITIMATE USE OF COVERAGE IN THIS FILE: a one-to-two pixel
  // EDGE gradient. Coverage is NOT an opacity channel on this target — a
  // fractional value applied across a whole instance comes back as a hard 4x4
  // screen door, not a dissolve (probed directly on ANGLE/Metal; see CFG).
  //
  // WHY THIS GOT WIDER. alphaToCoverage resolves through the MSAA mask, and the
  // mask has exactly (samples+1) levels — 5 at the high tier, 3 at low. Five
  // levels is plenty for a low-contrast edge and nowhere near enough for this
  // one: a backlit canopy is ~25/255 against a ~205/255 sky, so each coverage
  // step is a 45-value jump and the edge still reads as a stair even though it
  // is technically antialiased. Measured on shots/wave-e-sun/05-summit, a pine
  // silhouette crossed sky->canopy in 2-3 pixels: 205, 182, 116, 55, 25.
  //
  // The only lever the shader has over a fixed level count is how many PIXELS
  // those levels are spread across. 0.85 of one alpha-gradient texel put the
  // whole ramp inside about one pixel, which is the worst case: all five levels
  // land on one or two fragments. 1.6 spreads the same five levels over roughly
  // two, which is what turns a stair into a ramp. Wider than this and the
  // canopy starts to fringe: a leaf edge gains a permanent half-transparent
  // halo, which is the failure the old blurred alpha padding used to cause.
  //
  // THE BAND MUST BE BOUNDED IN SCREEN SPACE, AND THE OLD FORM WAS NOT.
  //
  // fwidth(t.a) is alpha-change-per-PIXEL, so fwidth * 1.60 is by construction
  // a band 1.6 px either side of the alpha isoline — screen-space bounded, which
  // is the invariant this whole design rests on. The old max(..., 0.055) FLOOR
  // broke that invariant: a floor stated in ALPHA units is a band of
  // 0.055/fwidth PIXELS, so as a card minifies and its mip flattens, the ramp
  // silently widens without limit (at fwidth=0.005 it is a 22 px ramp). And the
  // floor was justified by exactly the case where it is WRONG: where the alpha
  // is locally flat there is no edge in this pixel, so degenerating to the
  // binary test is the CORRECT answer, not a failure to be papered over.
  //
  // MEASURED (non-MSAA re-render of the tree group, coverage maths verbatim,
  // 1920x1080): at 05-summit 66.4% of leaf fragments had fwidth(t.a) > 0.30 and
  // 94-100% of those came back fractional; only 6.8% of fragments were in the
  // floor's range at all. So the floor was never the main defect — a huge
  // fwidth was. Past fwidth ~0.3 the band cut +- 1.6*fwidth is wider than the
  // entire 0..1 alpha range, so EVERY fragment of the card lands inside the ramp
  // and not one of them is solid. On this target fractional coverage is a hard
  // 4x4 screen door, so a distant forest became a stipple field: 05-summit came
  // back 20.2% solid / 79.8% fractional, with 557 of 1836 LOD2 impostor cards
  // carrying no solid fragment anywhere.
  //
  // uCovMinPx IS THE MINIFICATION ESCAPE, AND IT IS KEYED ON CARD SIZE, NOT ON
  // GRADIENT STEEPNESS. Those are different things and confusing them costs the
  // near canopy: a big card with a crisp leaf silhouette ALSO has a huge
  // fwidth(t.a) — that is what a sharp edge IS — so culling coverage on a
  // fwidth threshold takes the antialiasing off exactly the near-canopy edges
  // it exists for. Measured: a fwidth>0.085 escape took 06-forest from 64.2%
  // solid to 99.9% solid, i.e. it removed leaf-edge AA from the whole frame.
  //
  // The quantity that actually decides whether an edge EXISTS is how many
  // pixels the card covers. Derivatives of vUv give it directly: uvpp is the UV
  // step per screen pixel, so uUvSpan / uvpp is the card's footprint in pixels.
  // What runs out first is not the card but the card's DETAIL: an atlas cell is
  // 251 texels across and its leaf blobs are 4-8 of them, so below roughly a
  // 60 px card every blob is sub-pixel, the sampler returns a mip average with
  // slopes instead of edges, and a +-uCovPx band laid across a slope makes the
  // whole card fractional — which on this target is a hard 4x4 screen door over
  // the entire card. Under the threshold the card goes opaque-or-discard on the
  // same stable cut the rest of the frame uses: an aliased small card is a
  // tree, a stippled one is noise. See uCovMinPx for the measured sweep.
  float uvpp = max(fwidth(vUv.x), fwidth(vUv.y));
  float cardPx = uUvSpan / max(uvpp, 1e-8);
  float cov;
  if (cardPx < uCovMinPx) {
    cov = step(cut, t.a);
  } else {
    // 1e-4, not 0.055: this exists only to keep smoothstep's edge0 < edge1, and
    // it is small enough that it can never widen the band beyond a pixel.
    float aw = max(fwidth(t.a) * uCovPx, 1e-4);
    cov = smoothstep(cut - aw, cut + aw, t.a);
  }

  // NOTHING ELSE MULTIPLIES INTO cov. This line used to read
  //     cov *= vFade * smoothstep(0.9, uNearFade, distance(uCam, vWorld));
  // with uNearFade = 2.6, so any leaf card between 0.9 m and 2.6 m of the lens
  // went fractional — a loaded gun that the sphere-clearance cull merely kept
  // unfired. Both halves are gone: vFade is binary (repartition() hard-culls
  // with hysteresis, the vertex shader rejects shadow-only instances) and the
  // distance term has no business here at all. If you ever need to hide an
  // instance, hide it in repartition(); NEVER ramp coverage.
  if (cov < 0.0039) discard;

  vec3 N = normalize(vNormal);
  vec3 Vv = normalize(uCam - vWorld);
  float sh = sunShadow();
  float ao = vAO;

  float ndl = dot(N, uSunDir);
  // wrapped diffuse: foliage has no hard terminator
  float wrap = clamp((ndl + 0.42) / 1.42, 0.0, 1.0);
  // AO is applied ONCE, and only weakly to the key. It used to be multiplied in
  // three separate places — into the ambient, into the translucency, and then
  // again over the finished colour — so an outer card in full sun lost most of
  // its key light to an occlusion term that has no business touching direct sun
  // at all. That triple darkening is what crushed every canopy to the same
  // near-black value regardless of which way it faced.
  vec3 lit = uSunColor * wrap * sh * (0.46 + 0.54 * ao);

  // TRANSLUCENCY. Two of the three hero poses look into the sun and a backlit
  // crown is the signature golden-hour shot, so this carries the frame. Two
  // lobes, because a canopy glows in two different ways and the old single
  // forward-scatter term only had one of them:
  //   * a tight forward lobe when you look straight INTO the sun through the
  //     crown, and
  //   * a broad wrap-around glow on any leaf whose far side is lit, which is
  //     what stops a crown 60 degrees off the sun crushing to black maroon.
  // Deliberately NOT gated hard on the shadow map: a directly backlit leaf
  // shadows itself, so multiplying by sh would switch the glow off exactly
  // when it matters.
  float towards = clamp(dot(-Vv, uSunDir), 0.0, 1.0);
  float back    = clamp(0.5 - 0.5 * ndl, 0.0, 1.0);
  //
  // FLOORS, NOT GAINS. Every one of these factors used to bottom out near zero
  // at once for the exact fragment that needs the term most — a crown card
  // pointing away from a low sun is backlit (good), self-shadowed (sh -> 0),
  // and interior (ao low), so the old 0.55 shadow floor times the old 0.30 AO
  // floor threw away 5/6 of the glow precisely where the reference has its
  // brightest foliage. A directly backlit leaf shadows itself by definition;
  // gating the transmission on the shadow map is backwards.
  float trans = uTrans * (pow(towards, 2.2) + 0.52 * (0.25 + 0.75 * towards))
              * (0.30 + 0.70 * back) * mix(0.82, 1.0, sh) * (0.52 + 0.48 * ao);

  // Indirect. AO belongs HERE — it occludes the sky and ground hemisphere, not
  // the sun — and it keeps a floor, so the deep interior of a crown settles into
  // a coloured shade rather than onto a black clamp.
  vec3 amb = mix(uGroundColor, uSkyColor, 0.5 + 0.5 * N.y) + uAmbColor;
  lit += amb * (0.42 + 0.58 * ao);

  vec3 albedo = vTint * t.rgb;
  float l = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
  albedo = mix(vec3(l), albedo, uSat);

  // Light that came THROUGH a leaf was filtered by the leaf twice, so it is both
  // dimmer and far more saturated than light that bounced off it. That double
  // filter is the whole reason a backlit momiji reads as glowing vermilion and
  // not as pale pink.
  vec3 through = albedo * mix(vec3(1.0), albedo * 2.2, 0.65) * uSunColor * trans;

  // AMBIENT TRANSMISSION. Sky and ground bounce pass THROUGH a leaf exactly the
  // way sun light does, and this file had no term for it at all — so a crown not
  // pointing at the sun had nothing but albedo * ambient, a second-order product
  // of two small numbers that lands on the frame's black floor. That, plus the
  // dead aerial ramp above, is why critics read every canopy as "a uniform pure
  // black cutout with no hue and no depth". It carries the leaf's own hue, which
  // is what stops the shaded side of a crown going the flat blue-black of the
  // sky bounce alone.
  through += albedo * amb * uTrans * 0.90 * (0.35 + 0.65 * back);

  vec3 c = albedo * lit + through;

  gl_FragColor = vec4(applyFog(c, Vv), min(cov, 1.0));
}
`;

const VS_DEPTH = VS_COMMON + /* glsl */`
uniform float uShadowDist;
varying vec2 vUv;
void main() {
  // uNearCull now lives in VS_COMMON (both passes need it). The sphere test is
  // the same per-frame invariant the beauty pass runs: a tree the camera has
  // walked into must lose its shadow on the same frame it loses its geometry,
  // or the frame keeps a shadow with no caster.
  float dc = distance(iPos.xz, uCam.xz);
  if (dc > uShadowDist || dc < uNearCull || nearCulled()) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  vec3 world, nrm;
  treeTransform(world, nrm);
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const FS_DEPTH_LEAF = /* glsl */`
uniform sampler2D uMap;
uniform float uCut;
varying vec2 vUv;
void main() {
  if (texture2D(uMap, vUv).a < uCut) discard;
  gl_FragColor = vec4(1.0);
}
`;

const FS_DEPTH_BARK = /* glsl */`
varying vec2 vUv;
void main() { gl_FragColor = vec4(1.0); }
`;

// ---------------------------------------------------------------------------
// placement
// ---------------------------------------------------------------------------
export function classify(x, z) {
  const h = heightAt(x, z);
  // TREE LINE. This used to be 208, which is BELOW most of the island's high
  // ground: the terrain runs to h=459 and 3824 sampled cells sit above 200, so
  // every summit and every skyline ridge came back with zero tree-eligible
  // cells and read as a bald cream dome. 275 puts the line where it belongs —
  // pine survives onto the ridges, the true peaks (300-459) stay bare rock,
  // which is the read we actually want up there.
  if (h < 4.6 || h > 275) return null;
  const s = slopeAt(x, z);
  if (s > 0.44) return null;

  const forest = fbm(x * 0.0021 + 71.3, z * 0.0021 - 18.9, 4);        // -0.54 .. 0.54
  const patch = fbm(x * 0.0125 + 5.2, z * 0.0125 + 33.1, 3);
  const rc = Math.sin(x * 0.0034) * 150 + Math.sin(x * 0.0009 + 2.1) * 70;
  const rd = Math.abs(z - rc);

  // High ground and steep shoulders: twisted pine. Deliberately sparse — pine
  // is a silhouette accent on the skyline, not a second forest.
  if (h > 118 || (s > 0.31 && h > 78)) {
    if (s > 0.42) return null;
    const p = 0.12 + 0.26 * THREE.MathUtils.clamp(forest * 2.4 + 0.55, 0, 1);
    // Fade moved up with the tree line. At 168-206 it thinned the pine out
    // exactly where the ridges are, so the last 70 m of every hill was empty
    // before the hard reject even got a say. 235-275 leaves base probability
    // 0.12-0.38 intact across the ridge band and only thins across the last
    // 40 m, which is a handful of wind-bent pines on a skyline rather than a
    // bald edge.
    return { spec: 2, p: p * (1 - THREE.MathUtils.smoothstep(h, 235, 275)) };
  }
  // River corridor: bamboo, patchy.
  if (rd < 108 && h > 5.2 && h < 62 && s < 0.26) {
    const m = fbm(x * 0.0068 - 24.7, z * 0.0068 + 9.4, 3) * 0.5 + 0.5;
    const edge = 1 - THREE.MathUtils.smoothstep(rd, 46, 108);
    const p = 0.30 * edge * THREE.MathUtils.smoothstep(m, 0.36, 0.62);
    if (p > 0.004) return { spec: 1, p };
  }
  // Everything else below the pine line: maple groves, with rare cherry.
  if (s < 0.36) {
    // Glades. A forest with no clearings reads as a wall; the open patches are
    // where the grass and the long shadows get to do their work.
    const glade = fbm(x * 0.0056 - 61.4, z * 0.0056 + 27.8, 3);
    // Deeper clearings than before. A maple grove whose density never drops
    // below 0.30 has no holes in it, and a canopy with no holes in it reads as
    // a painted wall of pom-poms rather than as a forest.
    const open = 0.05 + 0.95 * THREE.MathUtils.smoothstep(glade, -0.30, 0.06);
    const g = THREE.MathUtils.clamp(0.38 + 2.35 * forest, 0, 1);
    const p = g * open * (0.55 + 0.45 * (patch * 0.5 + 0.5)) * 1.00;
    if (p < 0.01) return null;
    // Cherry only where it earns it: a few small stands, never a pink carpet.
    const cherry = fbm(x * 0.0042 + 140.1, z * 0.0042 - 77.5, 3);
    if (cherry > 0.31 && h < 70 && s < 0.20) return { spec: 3, p: p * 0.50 };
    return { spec: 0, p };
  }
  return null;
}

// Conservative upper bound on classify()'s acceptance probability given only
// the cheap grove noise, so most grid cells are rejected before paying for
// heightAt / slopeAt.
function maxProb(forest) {
  const mapleP = Math.min(1, Math.max(0, 0.38 + 2.35 * forest)) * 1.05;
  const pineP = 0.12 + 0.26 * THREE.MathUtils.clamp(forest * 2.4 + 0.55, 0, 1);
  return Math.max(0.30, Math.max(mapleP, pineP));
}

// ---------------------------------------------------------------------------
// system
// ---------------------------------------------------------------------------
export function createTrees(ctx) {
  const { scene, renderer } = ctx;
  const group = new THREE.Group();
  group.name = 'trees';
  void scene;

  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const rnd = mulberry32(0x7EE5);

  // ---- shared uniforms, referenced by every tree material AND every depth
  // material, so one write updates the whole system.
  const shared = {
    uTime: { value: 0 },
    uCam: { value: new THREE.Vector3() },
    uSunDir: { value: new THREE.Vector3(0, 0.3, 1) },
    uSunColor: { value: new THREE.Color(1, 0.8, 0.6) },
    uSkyColor: { value: new THREE.Color(0.3, 0.4, 0.6) },
    uGroundColor: { value: new THREE.Color(0.2, 0.16, 0.12) },
    uAmbColor: { value: new THREE.Color(0.15, 0.15, 0.15) },
    uFogColor: { value: new THREE.Color(0.85, 0.7, 0.55) },
    uFogDensity: { value: 0.0016 },
    // Aerial perspective, driven from scene.fog exactly the way terrain.js
    // drives its own uAerialK, so canopy and ridge haze together.
    uAerialK: { value: 0.0016 },
    uHazeWarm: { value: new THREE.Vector3(1.14, 1.01, 0.84) },
    uHazeCool: { value: new THREE.Vector3(0.90, 0.96, 1.10) },
    uShadowDist: { value: CFG.shadowDist },
    uNearCull: { value: CFG.nearHard },
  };

  // THE SHARED WIND, attached ONCE, by reference. Every tree material and every
  // depth material copies `shared` in by reference (`for (const k in shared)`),
  // so they all end up pointing at wind.js's own uniform holders — the same
  // objects grass.js and vfx.js hold.
  if (ctx && ctx.wind && ctx.wind.attach) ctx.wind.attach(shared);

  const textures = {};
  for (const sp of SPECIES) {
    const si = SPECIES.indexOf(sp);
    const irnd = mulberry32(0x1A9D + si * 1181);
    textures[sp] = {
      bark: makeBark(sp, mulberry32(0xB0A0 + si * 977), aniso),
      leaf: makeLeafAtlas(sp, mulberry32(0x1EAF + si * 613), aniso),
      // one texture per impostor variant, mipped on its own so nothing bleeds in
      imp: Array.from({ length: VARIANTS[sp][2] }, () => makeImpostorTex(sp, irnd, aniso)),
    };
  }

  const LOOK = {
    maple: { bark: '#e0d4c4', bend: 1.00, flut: 0.30, trans: 1.70, cut: 0.52, sat: 0.94, bump: 0.30 },
    bamboo: { bark: '#e2ecc8', bend: 2.40, flut: 0.42, trans: 1.45, cut: 0.50, sat: 1.02, bump: 0.10 },
    // PINE CARRIED THE LOWEST TRANSMISSION IN THE FILE AND IT IS THE SPECIES
    // THE HERO POSE BACKLIGHTS. 01-sunset-ridge is 4.7% pine and 0.04% maple,
    // with the sun behind the crowns at 2-8 degrees altitude; every other
    // species was tuned above it. Measured (rAF frozen, uTrans driven to 0 and
    // back inside one run, A/A2/A3 all 0.000% noise) the transmission was worth
    // only dLum +11.7 over the pine mask on the shipped build, and its dRGB was
    // (8.2, 13.4, 5.5) — the glow was GREENER than the canopy, because
    // `through` filters the albedo through itself twice and the albedo was
    // green. Rehueing the palette alone took it to +25 and (31, 25, 10). 1.85
    // spends the headroom that opened up; bracketed against highlight clipping,
    // which stays 0.0000% on 01 / 03 / 06.
    //
    // uSat IS A NULL RESULT HERE, AND IT IS RECORDED SO NOBODY SPENDS THE
    // BRACKET AGAIN. The rendered canopy sits at sat 0.69 against a reference
    // vegetation figure of 0.77-0.80 (field_2 0.772, field_16 0.800, measured
    // the same way), and uSat looks like the obvious lever. It is not: it
    // saturates the ALBEDO only, upstream of an ambient term and an aerial-haze
    // mix that both add unsaturated light, so 1.06 -> 1.16 moved the measured
    // canopy saturation 0.691 -> 0.694. Ten percent of the knob buys three
    // thousandths of the result. 1.06 is kept because it is free; the remaining
    // 0.08 of saturation is not available from here.
    pine: { bark: '#d2bfad', bend: 0.55, flut: 0.18, trans: 1.85, cut: 0.54, sat: 1.06, bump: 0.45 },
    cherry: { bark: '#dedad4', bend: 1.10, flut: 0.34, trans: 1.40, cut: 0.52, sat: 1.02, bump: 0.24 },
  };

  const allMats = [];

  function baseUniforms(extra) {
    const u = THREE.UniformsUtils.merge([THREE.UniformsLib.lights, {
      uBend: { value: 0.5 }, uFlut: { value: 0.6 },
      uBarkColor: { value: new THREE.Color(1, 1, 1) }, uBump: { value: 0.35 },
      uCut: { value: 0.33 }, uCutFar: { value: 0.26 },
      uTrans: { value: 1.2 }, uSat: { value: 1.0 },
      // See the coverage block in FS_LEAF. uCovPx is the half-width of the edge
      // ramp in PIXELS (1.6 reproduces the wave-F near-canopy edge exactly, and
      // is the value that was tuned against the five-level MSAA mask).
      // uCovMinPx is the card footprint in pixels below which the card is too
      // minified to carry an edge at all and goes opaque-or-discard instead.
      // uUvSpan is overridden per material: 0.245 for a leaf-atlas cell, 1.0
      // for an impostor.
      //
      // WHY 60 PX AND NOT 4. The card is not the smallest thing on the card: a
      // leaf-atlas cell is 251 texels across and its blobs are 4-8 texels, so a
      // blob stops being a pixel at roughly a 60 px card. Below that the alpha
      // the sampler returns is a mip average of sub-pixel detail — it has no
      // edges, only slopes — and a +-1.6 px ramp laid across a slope makes every
      // fragment fractional. MEASURED at 05-summit, share of leaf fragments
      // that came back FRACTIONAL by card size: <2px 96%, 4-6px 89%, 8-12px 81%,
      // 12-20px 75%, 20-40px 67%, 40-100px 59%. There is no card size at which
      // the old maths produced a mostly-solid card; the curve only breaks once
      // the escape is taken. Sweeping the threshold at 05-summit / 06-forest:
      //   0  -> 20.1% / 59.9% solid, 553 / 21 impostor cards with NO solid px
      //   20 -> 78.4% / 79.1% solid,  30 /  3 such cards
      //   40 -> 96.6% / 91.2% solid,   4 /  0 such cards
      //   60 -> 99.7% / 97.1% solid,   0 /  0 such cards
      // 60 is the first value at which no impostor card is drawn entirely out
      // of screen-door, and it still leaves the ramp running on the nearest
      // canopy: 0.8% of the 06-forest frame is fractional, and that 0.8% is the
      // outer silhouette of the big foreground cards, which is the only place a
      // cutout edge was ever resolvable.
      uCovPx: { value: 1.60 }, uCovMinPx: { value: 60.0 }, uUvSpan: { value: 0.245 },
    }]);
    for (const k in shared) u[k] = shared[k];
    for (const k in extra) u[k] = extra[k];
    return u;
  }

  function makeMats(sp) {
    const L = LOOK[sp];
    const bark = new THREE.ShaderMaterial({
      lights: true,
      uniforms: baseUniforms({ uMap: { value: textures[sp].bark } }),
      vertexShader: VS_MAIN, fragmentShader: FS_BARK,
      side: THREE.FrontSide,
      // Bark writes alpha 1.0 always and has no alpha cutout, so there is
      // nothing here for coverage to antialias. Leaving alphaToCoverage on is a
      // standing invitation for the next builder to route an opacity through it;
      // on this target that returns a hard 4x4 screen door, not a dissolve.
      alphaToCoverage: false,
    });
    // Trunk and canopy MUST share uBend or the canopy detaches from the branch
    // tips it is supposed to be hanging on.
    bark.uniforms.uBend.value = L.bend;
    bark.uniforms.uFlut.value = 0.0;
    bark.uniforms.uBarkColor.value.set(L.bark);
    bark.uniforms.uBump.value = L.bump;

    const leaf = new THREE.ShaderMaterial({
      lights: true,
      uniforms: baseUniforms({ uMap: { value: textures[sp].leaf } }),
      vertexShader: VS_MAIN, fragmentShader: FS_LEAF,
      side: THREE.DoubleSide,
      // EDGE ANTIALIASING ONLY. This exists to soften the leaf CUTOUT against a
      // bright sky, which is a one-to-two pixel gradient. It is not an opacity
      // channel and it does not carry a near fade any more: partial coverage on
      // this target resolves as a hard 4x4 screen door (probed on ANGLE/Metal),
      // so nothing may drive it but fwidth of the alpha texture.
      alphaToCoverage: true,
    });
    leaf.uniforms.uBend.value = L.bend;
    leaf.uniforms.uFlut.value = L.flut;
    leaf.uniforms.uCut.value = L.cut;
    leaf.uniforms.uTrans.value = L.trans;
    leaf.uniforms.uSat.value = L.sat;

    const depthOf = (isLeaf, src) => {
      const u = {
        uBend: { value: src.uniforms.uBend.value },
        uFlut: { value: src.uniforms.uFlut.value },
        uCut: { value: L.cut },
        uMap: { value: textures[sp].leaf },
      };
      for (const k in shared) u[k] = shared[k];
      return new THREE.ShaderMaterial({
        uniforms: u,
        vertexShader: VS_DEPTH,
        fragmentShader: isLeaf ? FS_DEPTH_LEAF : FS_DEPTH_BARK,
        blending: THREE.NoBlending,
      });
    };
    // One material per impostor variant. It reuses the full FS_LEAF lighting —
    // same wrapped diffuse, same translucency, same ambient, same per-instance
    // tint — so a distant tree is lit by exactly the maths that lit it a metre
    // before the swap. That is what makes the transition invisible; the LOD2
    // pass being visually "unshaded" was never a lighting model difference, it
    // was a texture that had lost its contrast to atlas mip bleed.
    const imp = textures[sp].imp.map((tex) => {
      const m = new THREE.ShaderMaterial({
        lights: true,
        uniforms: baseUniforms({ uMap: { value: tex } }),
        vertexShader: VS_MAIN, fragmentShader: FS_LEAF,
        side: THREE.DoubleSide,
        // Same contract as the LOD0/LOD1 leaf: EDGE antialiasing of the impostor
        // cutout, never an opacity. See the note on the leaf material above.
        alphaToCoverage: true,
      });
      m.uniforms.uBend.value = L.bend * 0.55;   // a 250 m tree barely moves
      m.uniforms.uFlut.value = 0.0;
      m.uniforms.uCut.value = 0.34;
      m.uniforms.uCutFar.value = 1.0;           // no far softening: no halo
      m.uniforms.uUvSpan.value = 1.0;           // full 0..1 UVs, not an atlas cell
      m.uniforms.uTrans.value = L.trans * 0.85;
      m.uniforms.uSat.value = L.sat;
      allMats.push(m);
      return m;
    });

    allMats.push(bark, leaf);
    return { bark, leaf, imp, barkDepth: depthOf(false, bark), leafDepth: depthOf(true, leaf) };
  }

  const mats = {};
  for (const sp of SPECIES) mats[sp] = makeMats(sp);

  // ---- geometry variants ---------------------------------------------------
  const buckets = [];
  const index = {};                  // index[spec][lod][variant] -> bucket

  function addBucket(specIdx, lod, variant, built) {
    const sp = SPECIES[specIdx];
    const cap = CAPS[lod];
    const iPos = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const iCfg = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    const iTint = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const iShp = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    // canopy sphere (centre height, radius) — the shader's per-frame near cull
    const iSph = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2).setUsage(THREE.DynamicDrawUsage);

    const gT = built.trunk.geo(), gL = built.leaf.geo();
    for (const g of [gT, gL]) {
      g.setAttribute('iPos', iPos);
      g.setAttribute('iCfg', iCfg);
      g.setAttribute('iTint', iTint);
      g.setAttribute('iShp', iShp);
      g.setAttribute('iSph', iSph);
      g.instanceCount = 0;
    }
    const mT = new THREE.Mesh(gT, mats[sp].bark);
    const mL = new THREE.Mesh(gL, lod === 2 ? mats[sp].imp[variant] : mats[sp].leaf);
    mT.frustumCulled = false; mL.frustumCulled = false;
    mT.name = `${sp}-trunk-${lod}-${variant}`;
    mL.name = `${sp}-leaf-${lod}-${variant}`;
    if (lod < 2) {
      mT.castShadow = true; mL.castShadow = true;
      mT.customDepthMaterial = mats[sp].barkDepth;
      mL.customDepthMaterial = mats[sp].leafDepth;
    }
    if (lod === 2) group.add(mL); else group.add(mT, mL);

    const b = {
      specIdx, lod, variant, cap, count: 0,
      iPos, iCfg, iTint, iShp, iSph,
      pa: iPos.array, ca: iCfg.array, ta: iTint.array, sa: iShp.array, qa: iSph.array,
      geos: [gT, gL],
      radius: built.radius, height: built.H, cy: built.canopyY,
    };
    buckets.push(b);
    (index[specIdx] ||= {});
    (index[specIdx][lod] ||= {});
    index[specIdx][lod][variant] = b;
    return b;
  }

  for (let si = 0; si < SPECIES.length; si++) {
    const sp = SPECIES[si];
    const [n0, n1, n2] = VARIANTS[sp];
    for (let lod = 0; lod < 3; lod++) {
      const n = [n0, n1, n2][lod];
      for (let v = 0; v < n; v++) {
        let built;
        if (lod === 2) built = buildImpostorGeo(rnd, sp);
        else if (sp === 'bamboo') built = buildBamboo(rnd, lod);
        else if (sp === 'pine') built = buildPine(rnd, lod);
        else built = buildBroadleaf(rnd, lod, sp === 'cherry');
        addBucket(si, lod, v, built);
      }
    }
  }

  // ---- scatter -------------------------------------------------------------
  const px = [], py = [], pz = [], pyaw = [], pscl = [], pphase = [];
  const pspec = [], pvar = [], ptr = [], ptg = [], ptb = [], prad = [], pcy = [], pjit = [];
  const pshw = [], pshh = [], pshl = [];

  // A forest is not a Poisson field of one size. One accepted grid cell used to
  // mean exactly one tree, jittered inside its own 7.2 m box, so the minimum
  // spacing was the cell and the maximum was the cell: no two trunks ever
  // touched and no hole was ever bigger than the noise made it. That is the
  // literal definition of "stamped at uniform spacing", and it survives any
  // amount of per-tree scale jitter because the LATTICE, not the tree, is what
  // the eye is reading.
  //
  // So an accepted cell now seeds a CLUMP, and the accept probability is halved
  // to pay for it. Same total tree count, completely different distribution:
  // trunks that overlap, and real clearings between the clumps.
  const CLUMP_P = 0.50;
  const clumpExtra = (u) => (u < 0.34 ? 0 : u < 0.72 ? 1 : u < 0.93 ? 2 : 3);   // mean ~1.01

  {
    const srnd = mulberry32(0xF01A6E);
    const S = CFG.cell, R = CFG.islandR;
    const pal = {};
    for (const sp of SPECIES) pal[sp] = PALETTE[sp].map((h) => new THREE.Color(h));
    const tmp = new THREE.Color();

    // Long-tailed, not uniform. 0.66..1.52 uniform gives a hillside where every
    // tree is within 2.3x of every other and the modal tree dominates; what a
    // real slope has is a majority of ordinary canopy, a scatter of understory
    // saplings well under half height, and a few emergents standing a third
    // clear of everything around them. The emergents are what give a canopy a
    // ragged top edge instead of a mown one.
    const scaleOf = (spec, understory) => {
      if (spec === 1) return 0.74 + srnd() * 0.58;             // bamboo culms
      const u = understory ? srnd() * 0.62 : srnd();
      if (u < 0.26) return 0.40 + srnd() * 0.32;               // sapling / understory
      if (u < 0.88) return 0.70 + srnd() * 0.60;               // canopy
      return 1.30 + srnd() * (spec === 2 ? 0.34 : 0.42);       // emergent
    };

    const emit = (x, z, spec, understory) => {
      const sp = SPECIES[spec];
      const v = (srnd() * VARIANT_ROLL[sp]) | 0;
      const b = index[spec][0][v % VARIANTS[sp][0]];
      const scl = scaleOf(spec, understory);
      // Silhouette axes. Bamboo is a culm and must stay a culm, so it gets a
      // narrow band; broadleaf and pine get a wide one, which is where most of
      // the "identical outline" read dies.
      const shw = spec === 1 ? 0.92 + srnd() * 0.18 : 0.80 + srnd() * 0.46;
      const shh = spec === 1 ? 0.84 + srnd() * 0.42 : 0.78 + srnd() * 0.52;
      // Lean. Pine is the skyline accent and leans hardest — a wind-bent
      // kuromatsu on a ridge is the whole point of putting it there.
      const lmax = spec === 2 ? 0.30 : spec === 1 ? 0.09 : 0.17;
      const shl = (srnd() * 2 - 1) * lmax * (0.35 + srnd() * 0.65);

      const list = pal[sp];
      tmp.copy(list[(srnd() * list.length) | 0]);
      tmp.multiplyScalar(0.68 + srnd() * 0.66);

      px.push(x); py.push(heightAt(x, z) - 0.15); pz.push(z);
      pyaw.push(srnd() * Math.PI * 2);
      pscl.push(scl);
      pphase.push(srnd());
      pspec.push(spec); pvar.push(v);
      ptr.push(tmp.r); ptg.push(tmp.g); ptb.push(tmp.b);
      pshw.push(shw); pshh.push(shh); pshl.push(shl);
      // Cull sphere has to know about the new axes: a 1.26-wide crown that the
      // radius still thinks is 1.0 clips into the lens, and the lean walks the
      // crown centre sideways by height * lean.
      const rw = Math.max(b.radius * shw, b.height * shh * 0.58) + b.height * shh * Math.abs(shl) * 0.5;
      prad.push(rw * scl + 2.0);
      pcy.push(b.height * shh * 0.5 * scl);
      // This tree's own place in both LOD handover bands. Stable for the life
      // of the world, so a tree never oscillates between LODs as the camera
      // drifts across a shared threshold; random across the forest, so the
      // handover has no visible wavefront and no screen-space pattern.
      pjit.push(srnd());
    };

    for (let gx = -R; gx <= R; gx += S) {
      for (let gz = -R; gz <= R; gz += S) {
        const x = gx + (srnd() - 0.5) * S * 0.95;
        const z = gz + (srnd() - 0.5) * S * 0.95;
        const roll = srnd();
        // cheap reject before paying for heightAt/slopeAt
        const q = fbm(x * 0.0021 + 71.3, z * 0.0021 - 18.9, 4);
        // Tier gate, the grass.js contract: thin the ACCEPT TEST, keep the grid.
        // Both tests are scaled by the same factor so maxProb stays a valid
        // upper bound on classify()'s probability and no cell is probed twice.
        if (roll > maxProb(q) * DENSITY * CLUMP_P) continue;
        const c = classify(x, z);
        if (!c || roll > c.p * DENSITY * CLUMP_P) continue;

        emit(x, z, c.spec, false);

        // Companions. Each one is re-classified at its own position, so a clump
        // can never push a trunk into the sea, onto a cliff or through the tree
        // line, and a clump that straddles a species boundary genuinely mixes —
        // which is what a grove edge looks like.
        const extra = clumpExtra(srnd());
        for (let k = 0; k < extra; k++) {
          const a = srnd() * Math.PI * 2;
          const r = 2.2 + srnd() * srnd() * 8.0;
          const nx = x + Math.cos(a) * r, nz = z + Math.sin(a) * r;
          const cc = classify(nx, nz);
          if (!cc) continue;
          emit(nx, nz, cc.spec, srnd() < 0.55);
        }
      }
    }
  }

  const N = px.length;
  const aX = Float32Array.from(px), aY = Float32Array.from(py), aZ = Float32Array.from(pz);
  const aYaw = Float32Array.from(pyaw), aScl = Float32Array.from(pscl), aPh = Float32Array.from(pphase);
  const aSpec = Uint8Array.from(pspec), aVar = Uint8Array.from(pvar);
  const aR = Float32Array.from(ptr), aG = Float32Array.from(ptg), aB = Float32Array.from(ptb);
  const aRad = Float32Array.from(prad), aCy = Float32Array.from(pcy);
  const aJit = Float32Array.from(pjit);
  const aShW = Float32Array.from(pshw), aShH = Float32Array.from(pshh), aShL = Float32Array.from(pshl);

  const stats = { total: N, maple: 0, bamboo: 0, pine: 0, cherry: 0, drawn: 0 };
  for (let i = 0; i < N; i++) stats[SPECIES[aSpec[i]]]++;

  // ---- LOD / frustum partition --------------------------------------------
  const frustum = new THREE.Frustum();
  const projScreen = new THREE.Matrix4();
  const sphere = new THREE.Sphere();
  // Per-instance near-cull state for the hysteresis above. 1 = currently hidden
  // because the camera got inside CFG.nearCull; it stays hidden until the
  // clearance climbs back past CFG.nearShow.
  const nearHidden = new Uint8Array(N);
  const lastCam = new THREE.Vector3(1e9, 1e9, 1e9);
  const lastFwd = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  let sinceRebuild = 1e9;

  function push(b, i, fade) {
    if (b.count >= b.cap) return;
    const k = b.count++;
    b.pa[k * 3] = aX[i]; b.pa[k * 3 + 1] = aY[i]; b.pa[k * 3 + 2] = aZ[i];
    b.ca[k * 4] = aYaw[i]; b.ca[k * 4 + 1] = aScl[i]; b.ca[k * 4 + 2] = aPh[i]; b.ca[k * 4 + 3] = fade;
    b.ta[k * 3] = aR[i]; b.ta[k * 3 + 1] = aG[i]; b.ta[k * 3 + 2] = aB[i];
    b.sa[k * 3] = aShW[i]; b.sa[k * 3 + 1] = aShH[i]; b.sa[k * 3 + 2] = aShL[i];
    b.qa[k * 2] = aCy[i]; b.qa[k * 2 + 1] = aRad[i];
  }

  function repartition(camera) {
    for (const b of buckets) b.count = 0;
    projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreen);
    const cx = camera.position.x, cz = camera.position.z;
    const L0 = CFG.lod0, L1 = CFG.lod1, MAX = CFG.maxDist, SD = CFG.shadowDist;
    const J0 = CFG.lodJit0, J1 = CFG.lodJit1;

    for (let i = 0; i < N; i++) {
      const dx = aX[i] - cx, dz = aZ[i] - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 > MAX * MAX) continue;
      const d = Math.sqrt(d2);
      const spec = aSpec[i], v = aVar[i];

      sphere.center.set(aX[i], aY[i] + aCy[i], aZ[i]);
      sphere.radius = aRad[i];

      // A tree growing on the lens is not a tree, it is a wall. Remove the
      // whole instance rather than letting the near plane slice it open.
      //
      // HARD CULL WITH HYSTERESIS, never a fade. The instance is either drawn at
      // full coverage or not drawn at all; nearHidden[i] carries its state
      // across repartitions, so the tree only disappears below CFG.nearCull and
      // only comes back above CFG.nearShow. A camera bobbing on the threshold
      // cannot flicker it, and — the point of the whole change — no instance is
      // ever handed a fractional coverage value, which on this target is a hard
      // 4x4 screen door rather than a dissolve.
      //
      // THIS TEST IS NOT THE INVARIANT; nearCulled() in VS_COMMON is. This one
      // runs at rebuild granularity, so it describes where the camera WAS.
      // Measured over a 12 s gallop, the pair at its old 5.6/7.6 values left
      // 368 stale instance-frames inside nearHard (worst penetration 2.55 m);
      // at 6.8/8.8 it leaves 36 (worst 1.87 m), and the vertex shader rejects
      // every one of those on the frame it happens. The 1.2 m gap to nearHard
      // is what keeps a bobbing camera from crossing the shader threshold
      // between two rebuilds. Costs 6 of 966 drawn instances at 06-forest and
      // nothing at all at 01-sunset-ridge (measured both ways).
      const clear = sphere.center.distanceTo(camera.position) - sphere.radius;
      if (nearHidden[i]) {
        if (clear < CFG.nearShow) continue;
        nearHidden[i] = 0;
      } else if (clear < CFG.nearCull) {
        nearHidden[i] = 1;
        continue;
      }

      const visible = frustum.intersectsSphere(sphere);
      const shadowOnly = !visible && d < SD;
      if (!visible && !shadowOnly) continue;

      // PER-TREE handover. Each tree crosses each threshold at its own
      // distance inside the band, and is then drawn SOLID by exactly one LOD.
      // Every tree in the band being drawn solid by one of the two, rather than
      // every tree being drawn by both through complementary bayer masks, is
      // what removes the checkerboard: there is no screen-space mask left.
      const j = aJit[i];
      const nv = VARIANTS[SPECIES[spec]];
      if (d < L0 + J0 * j) {
        push(index[spec][0][v % nv[0]], i, shadowOnly ? -1 : 1);
      } else if (d < L1 + J1 * j) {
        push(index[spec][1][v % nv[1]], i, shadowOnly ? -1 : 1);
      } else {
        if (shadowOnly) continue;
        push(index[spec][2][v % nv[2]], i, 1);
      }
    }

    let drawn = 0;
    for (const b of buckets) {
      b.iPos.needsUpdate = true; b.iCfg.needsUpdate = true; b.iTint.needsUpdate = true;
      b.iShp.needsUpdate = true; b.iSph.needsUpdate = true;
      for (const g of b.geos) g.instanceCount = b.count;
      drawn += b.count;
    }
    stats.drawn = drawn;
  }

  const coolShade = new THREE.Color('#7d93c8');
  const tmpC = new THREE.Color();

  return {
    group, stats, buckets, CFG,
    update(dt, c) {
      shared.uTime.value += dt;
      shared.uCam.value.copy(c.camera.position);
      // No wind writes here. The block is attached by reference at
      // construction and wind.update(dt) has already run this frame; writing
      // uWindStr would corrupt it for grass.js and vfx.js as well.
      if (c.sky) {
        const sky = c.sky;
        shared.uSunDir.value.copy(sky.sunPos).normalize();
        // Match the terrain's physical light response: irradiance / PI.
        shared.uSunColor.value.copy(sky.sun.color).multiplyScalar(Math.max(sky.sun.intensity, 0.0) * 0.318);
        tmpC.copy(sky.hemi.color).multiplyScalar(sky.hemi.intensity * 0.318);
        // A touch of cool bounce so shadowed foliage sits blue-violet, not muddy.
        tmpC.lerp(coolShade, 0.24 * Math.min(1, sky.hemi.intensity));
        shared.uSkyColor.value.copy(tmpC);
        shared.uGroundColor.value.copy(sky.hemi.groundColor).multiplyScalar(sky.hemi.intensity * 0.318);
        shared.uAmbColor.value.copy(sky.amb.color).multiplyScalar(sky.amb.intensity * 0.318);
      }
      if (c.scene.fog) {
        shared.uFogColor.value.copy(c.scene.fog.color);
        shared.uFogDensity.value = c.scene.fog.density;
        // terrain.js: clamp(density * 0.90, 0.00120, 0.0028). Foliage takes the
        // same curve 15% hotter — a canopy sits up inside the haze layer, the
        // ground is its floor — which is what gives the mid band the three or
        // four separate value steps a flat exp2 fog cannot produce.
        shared.uAerialK.value = Math.min(0.0032, Math.max(0.00138, c.scene.fog.density * 1.04));
      }

      sinceRebuild += dt;
      c.camera.getWorldDirection(fwd);
      const moved = c.camera.position.distanceTo(lastCam);
      const turned = 1 - fwd.dot(lastFwd);
      if (moved > CFG.rebuildMove || turned > CFG.rebuildTurn || sinceRebuild > CFG.rebuildTime) {
        lastCam.copy(c.camera.position);
        lastFwd.copy(fwd);
        sinceRebuild = 0;
        repartition(c.camera);
      }
    },
  };
}
