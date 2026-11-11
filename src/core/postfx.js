import * as THREE from 'three';
import { QUALITY } from './quality.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

/*
  KAZE NO MICHI — post-processing / film grade.

  This module owns the entire frame from "scene rendered" to "pixels on screen".
  It deliberately takes over tone mapping: the scene renders in raw HDR linear
  (renderer.toneMapping = NoToneMapping) so bloom can threshold real highlights
  and the filmic curve is applied ONCE, at the end, after the grade.
  renderer.toneMappingExposure is still honoured — the sky lane drives it — and
  is folded into our exposure.

  Chain (all render targets owned here):

    scene  ->  rtScene (HDR, 4x MSAA, depth texture)
                 |-- luminance pyramid -> 1x1 adapted luminance (eye adaptation)
                 |-- SSAO (half res) -> bilateral blur
                 |-- bloom prefilter + down/up pyramid (half res)
                 |-- godrays: sky occlusion (quarter res) -> radial blur
                 |-- DOF: far-field CoC disc blur (half res)
                 v
               composite (full res, still linear HDR):
                 exposure -> DOF -> AO -> aerial perspective -> shafts ->
                 bloom + halation -> gold push -> linear split tone ->
                 vignette -> grain
                 v
               grade: lens distortion + CA -> highlight desat -> shoulder ->
                 ACES -> split tone -> S contrast -> vibrance -> lift/gain ->
                 edge desat -> sRGB -> dither -> screen

  Everything is re-derived from ctx.tod.sunAltitude every frame, so the sunset
  grade and the night grade are genuinely different grades — different exposure
  key, different bloom threshold, different haze colour, different saturation.

  ---------------------------------------------------------------------------
  Why aerial perspective lives here and not in scene fog
  ---------------------------------------------------------------------------
  scene.fog is one flat colour: it flattens every distance band to the same
  hue, which is exactly the "uniform muddy value" failure. Real atmosphere is
  DIRECTIONAL — the haze toward the sun is a hot amber forward-scatter lobe,
  the haze away from it is blue Rayleigh. Doing it in post, with depth, is what
  makes near grass / mid ridge / far peak read as three separate values.
*/

// ---------------------------------------------------------------------------
// shared GLSL
// ---------------------------------------------------------------------------

const VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// depth helpers: window-space depth -> view space position / linear eye depth
const DEPTH_LIB = /* glsl */`
uniform sampler2D tDepth;
uniform mat4 uProjInv;
uniform vec2 uCamNF;

float rawDepth(vec2 uv) { return texture2D(tDepth, uv).x; }

float linearEye(float d) {
  float z = d * 2.0 - 1.0;
  return (2.0 * uCamNF.x * uCamNF.y) / (uCamNF.y + uCamNF.x - z * (uCamNF.y - uCamNF.x));
}

vec3 viewPos(vec2 uv, float d) {
  vec4 c = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 v = uProjInv * c;
  return v.xyz / v.w;
}`;

const LUMA = /* glsl */`
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }`;

// hash / noise used for AO rotation, grain and dither
const NOISE = /* glsl */`
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}`;

/*
  Exposure: sampled from the 1x1 adaptation target.

  THE FLOOR WAS A HARD CLAMP AND IT WAS ALWAYS ENGAGED. Instrumented live on the
  wave-E build (post.meter(), below), uExposure.x / avg measured 0.111, 0.335,
  0.369, 0.415, 0.427 and 0.500 on the six poses that face the sun, against an
  evMin of 0.56-0.58 — every one of them pinned to the floor, with the meter
  contributing nothing. Only 06-forest, which faces away from it, came out above
  (1.02) and was actually being metered. So the floor was a hidden manual EV for
  six poses out of seven. But the floor is also doing real work: it is what stops
  those six from being metered down by their own bright sky.

  So: soft knee, not a lower floor. Above `lo` the meter is free. Below it the
  response is compressed by uExposureKnee, so a pose whose own content is
  genuinely hot can still stop down, while a pose that is only slightly under
  the floor barely moves. At knee = 0 this is bit-for-bit the old clamp; at
  knee = 1 the floor is gone. Compression is in the log domain, which is what
  makes the amount a pose moves proportional to how far past the floor it is.
*/
const EXPOSURE_LIB = /* glsl */`
uniform sampler2D tAdapt;
uniform vec3 uExposure; // x = key, y = min EV, z = max EV
uniform float uExposureMul;
uniform float uExposureKnee;

float sceneExposure() {
  float avg = max(texture2D(tAdapt, vec2(0.5)).r, 1e-5);
  float want = uExposure.x / avg;
  float lo = uExposure.y;
  float ev = want >= lo
    ? min(want, uExposure.z)
    : lo * pow(max(want / lo, 1e-4), uExposureKnee);
  return ev * uExposureMul;
}`;

// The CPU mirror of the curve above, so telemetry reports what the GPU did.
function evCurve(want, lo, hi, knee) {
  if (want >= lo) return Math.min(want, hi);
  if (knee <= 0) return lo;
  return lo * Math.pow(Math.max(want / lo, 1e-4), knee);
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function rt(w, h, opts = {}) {
  const t = new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    ...opts,
  });
  t.texture.colorSpace = THREE.NoColorSpace;
  return t;
}

function mat(fragmentShader, uniforms) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  });
}

const ss = THREE.MathUtils.smoothstep;
const lerp = THREE.MathUtils.lerp;
const clamp = THREE.MathUtils.clamp;

function setCol(out, a, s = 1) {
  out.setRGB(a[0] * s, a[1] * s, a[2] * s);
  return out;
}

// ---------------------------------------------------------------------------

export function createPostFX(ctx) {
  const { renderer, scene, camera } = ctx;

  // We own tone mapping from here on.
  renderer.toneMapping = THREE.NoToneMapping;

  const params = {
    enabled: true,
    quality: 1.0,            // 1 = everything, 0.75 drops AO, 0.5 drops DOF too
    autoTod: true,

    /*
      knee: how much authority the meter has BELOW the daylight floor. 0 is the
      old hard clamp. areaMul scales the area-weighted highlight term that gives
      the meter something worth reacting to. See EXPOSURE_LIB and lumPre.
    */
    exposure: { keyMul: 1.0, minMul: 1.0, maxMul: 1.0, comp: 1.0, adaptSpeed: 2.6,
                // knee 0 — bit-for-bit the old hard clamp. 0.40 was measured to
                // DARKEN 5 of 7 daylight poses in a paired in-session A/B, and to
                // reproduce the exact failure that got an earlier exposure attempt
                // reverted: far terrain blown flat, fraction of pixels above L=230
                // going 0.08% -> 9.98% on 03-coast with mean saturation 0.536 ->
                // 0.356. The metering fix is still wanted, but it must not move the
                // six poses that already read correctly — prove that with a paired
                // A/B on all seven before raising this again.
                knee: 0.0, areaMul: 1.0 },

    bloom: { strength: 1.0, threshold: 1.0, knee: 0.55, scatter: 0.78, levels: 6,
             halation: 1.0 },

    ao: { strength: 1.0, radius: 1.15, bias: 0.03, power: 1.7, maxDist: 220.0 },

    // maxCoC was 0.9 over a 700-unit ramp: 10.8px of bokeh at 1080p on every
    // ridge past ~730m, which is most of what read as "blurred amber soup" at
    // the summit. 0.58 over 950 keeps the far field soft without dissolving the
    // silhouettes the composition is built on.
    dof: { enabled: true, near: 34.0, range: 950.0, maxCoC: 0.58, blurPx: 6.0 },

    /*
      ---- godrays: why `strength` is 36 and not 1 ---------------------------
      The pass normalises itself away. The march accumulates STEPS samples,
      each decayed, then multiplies by (weight / STEPS): with the shipped decay
      0.972 over 28 steps that is sum(decay^i) * 0.45 / 28 = 0.31 of the seed,
      and the angular dust field (mean 0.52) halves it again. So `strength 1`
      delivers about 16% of a seed that is itself the sky MINUS the seed
      threshold. Measured on 01-sunset-ridge with rAF frozen and frames driven
      by hand, godrays 1.0 -> 0.0 moved 0.68% of the frame at a maximum of
      7/255, against a harness noise floor of 0.00% / 2 — i.e. the pass has
      been running, and costing, and rendering nothing anyone could see. That
      is the whole answer to "there is still no volumetric light".
      Bracketed on 01 / 05-summit at skyMix 0.80, headroom 1.0 (pixels changed
      vs strength 1, and max delta): 6 -> 16.8% / 26, 14 -> 22.0% / 58,
      24 -> 23.3% / 82, 36 -> 29.6% / 131. 36 is where a shaft reads as a shaft
      at the poses' distances without the frame going milky; the headroom guard
      below is what keeps that gain off the pixels that are already hot.
    */
    godrays: { strength: 36.0, density: 0.80, decay: 0.972, weight: 0.45, seedMul: 1.0,
               dust: 1.0, dustDrift: 0.35,
               // occlusionSharp: 1 = only the sky dome seeds a shaft, so every
               // solid thing is an occluder. 0 restores the old
               // smoothstep(0.35,0.80) depth ramp, under which the horizon
               // ridges (3129m, 4007m of a 6000m far plane) counted as 32% and
               // 78% sky and seeded the shafts they were supposed to interrupt.
               occlusionSharp: 1.0,
               /*
                 skyMix: how much of a shaft survives where it crosses open
                 sky. Was a hard-coded 0.45, from when the seed counted distant
                 ridges as sky and the shafts were a wash that read better over
                 land. With the occlusion test fixed, the shafts land exactly
                 where light spills PAST a ridge — which on every judged pose is
                 sky — so 0.45 was cancelling most of the effect.
                 headroom: divides the shaft by the brightness it lands on.
                 Measured on 05-summit at strength 14: without it, pixels with a
                 channel at 255 went 0.0098% -> 0.0194%; with headroom 1.0 they
                 came back to 0.0106%. At the shipped strength 36 / headroom 2.0
                 the summit reads 0.0114% against a 0.0098% baseline and
                 01-sunset-ridge and 03-coast both stay at 0.0000%.
               */
               skyMix: 0.80, headroom: 2.0 },

    /*
      The sun's own glare. corePower ~900 is a lobe about 2.2 degrees wide at
      half maximum — a hair wider than the disc itself, which is what a low sun
      through haze actually looks like and what gives the bloom a halo to build
      on. skirt is the wide veil around it. strength rides on the per-state
      `glow`, so it is off at night by construction.
    */
    sunGlow: { strength: 1.5, corePower: 900.0, skirtPower: 46.0, skirtMix: 0.06,
               /*
                 occlude: 1 = the sun's aureole is depth-tested against the
                 scene, so a ridge in front of the sun blocks it. 0 restores the
                 old unconditional quarter-strength spill over geometry, which
                 is what painted a glow on the mountain that the sun was behind.
                 Kept as a knob so the two states can be A/B'd inside ONE page
                 load — cross-run diffs on this build are worthless, measured at
                 56.3% of pixels changed between two captures of the SAME state,
                 because the wind advances the world between page loads.
               */
               occlude: 1.0 },
    // strength 1.5, not 10.0. At 10 the glow skirt washed the far archipelago:
    // measured on 03-coast, the fraction of far-terrain pixels above L=230 went
    // 0.08% -> 10.35% and mean saturation 0.536 -> 0.346, which is the same
    // "distant mountains blown to flat cream" failure that got an earlier
    // exposure attempt reverted. Bisected to this parameter by reverting each
    // wave-F file in turn (only postfx moved the number) and then bracketing:
    // strength 0 -> 0.09%, 1.5 -> 0.08%, 3.0 -> 0.77%, 10.0 -> 10.35%.
    // 1.5 keeps a readable sun disc, which was its own repeated critical finding.

    // scene.fog already carries a lot of the far field, so this rides on top
    // of it rather than replacing it. 0.55 measured as "not reading at all",
    // but the reason was the sky mask above, not this number.
    // maxConverge is how far toward its own sky radiance a fully hazed pixel
    // travels. See AIRLIGHT_LIB and the aerial block.
    aerial: { strength: 0.65, maxConverge: 0.26 },

    lens: { chroma: 1.0, distortion: -0.05, edgeDesat: 1.0 },

    grain: { amount: 1.0, size: 1.15 },

    vignette: { amount: 1.0, start: 0.30, end: 1.08 },

    grade: { contrast: 1.12, saturation: 1.05, lift: 1.0, splitTone: 1.0, gold: 0.45,
             toe: 1.0, shadowSat: 1.0, hiKnee: 1.0, loKnee: 1.0 },

    /*
      ---- performance budget -------------------------------------------------
      Every expensive pass renders into a fraction of the backbuffer and every
      loop has a hard cap. These numbers were measured pass by pass on the
      merged build, not guessed; see the header note on the frame budget.

      `dyn` is the adaptive guard. It only ever scales the resolution of AO /
      DOF / godrays, and only when the frame time is already through the floor.
      It never removes a pass and never touches the grade, so the picture stays
      the same picture — just a softer AO and a coarser bokeh buffer.
    */
    // Post-process budget, by quality tier.
    //
    // Measured on the Studio (M3 Ultra) with an independent rAF counter: the
    // ENTIRE post stack is free there. Post fully disabled measured the same as
    // post enabled (92.4 vs 90.7fps at the summit) because the build is
    // CPU/main-thread bound at ~105fps. So on a capable machine these cuts buy
    // nothing measurable and cost real image quality — third-res DOF and
    // 8-sample AO are most of why the summit read as blurred amber soup.
    //
    // They are kept for weaker machines, where post is NOT free.
    perf: {
      aoScale:    QUALITY.tier === 'high' ? 1.0  : QUALITY.tier === 'medium' ? 0.65 : 0.5,
      dofScale:   0.34,     // do NOT raise: widening this blurs the whole frame, not just the far field
      sunScale:   QUALITY.tier === 'high' ? 0.55 : QUALITY.tier === 'medium' ? 0.35 : 0.25,
      aoSamples:  QUALITY.tier === 'high' ? 16   : QUALITY.tier === 'medium' ? 11   : 8,
      // 7, not 3. The coarse cross-hatch stipple that covered the whole frame
      // — which everyone including me blamed on the tree LOD dither — was SSAO
      // sample-rotation noise that a 3-tap bilateral blur could not resolve.
      // Isolated by disabling AO: the stipple vanished entirely. Widening the
      // blur removes it from the near and mid field at no measurable cost
      // (forest 97.6fps, summit 81.0fps after the change).
      aoBlurTaps: 7,
      dofTaps:    QUALITY.tier === 'low' ? 10 : 12,
      sunSteps:   QUALITY.tier === 'high' ? 28   : QUALITY.tier === 'medium' ? 20   : 16,
      msaa:       QUALITY.tier === 'low'  ? 2    : 4,
      // The pyramid feeds a value with a 0.4s time constant; rebuilding it
      // every frame at the high tier is six draws and six target binds for a
      // number that cannot have moved. Every other frame is identical output.
      lumEvery:   2,
      adapt: true,         // adaptive resolution guard (see above)
      // Deliberately set at the HARD FLOOR, not at the 60 target: the static
      // budget above is what is supposed to hit 60, and this only exists to
      // stop a bad moment falling through 45. Firing it at 60 would mean the
      // picture quietly changed on most frames, which is not a fix.
      floorFps: 46,
      ceilFps: 58,
      minScale: 0.6,
    },
  };

  // -------------------------------------------------------------------------
  // render targets
  // -------------------------------------------------------------------------

  const size = new THREE.Vector2();
  renderer.getDrawingBufferSize(size);
  let W = Math.max(2, size.x | 0), H = Math.max(2, size.y | 0);

  let rtScene, depthTex, rtComp, aoA, aoB, dofRT, sunA, sunB;
  let lumChain = [], adapt = [], bloomDown = [], bloomUp = [];
  let adaptPing = 0;
  let bloomTent = 1;          // fractional-level correction, see below
  let dynScale = 1;           // adaptive guard multiplier on the pass scales

  /*
    THE REFERENCE FRAME. Every radius in this file is a fraction of the SCREEN,
    never a count of texels in whatever intermediate buffer happens to hold it.

    The bug this replaces: DOF stepped its bokeh disc by `blurPx * uTexel` of a
    half-res target, and the bloom pyramid always had exactly 6 levels. Both of
    those are texel counts, so both grew in screen terms as the resolution fell.
    At 1280x720 the bokeh disc was 1.5x too wide and at 640x360 it was 5.3x too
    wide — the character and the horse dissolved and the whole frame veiled over
    while the identical 1080p frame was sharp. Anything spatial added here must
    be expressed against REF_H or as a fraction of the pyramid, not in texels.
  */
  const REF_H = 1080;
  const REF_SUN_STEPS = 28;   // step count params.godrays.decay was tuned at

  // 1x1 stand-ins so a skipped pass can be bound as "contributes nothing"
  // instead of leaving last frame's contents wired into the composite.
  function tiny(r, g, b, a) {
    const t = new THREE.DataTexture(new Uint8Array([r, g, b, a]), 1, 1);
    t.needsUpdate = true;
    return t;
  }
  const BLACK1 = tiny(0, 0, 0, 0);
  const WHITE1 = tiny(255, 255, 255, 255);

  function sizeOf(w, h, scale) {
    return [Math.max(1, Math.ceil(w * scale)), Math.max(1, Math.ceil(h * scale))];
  }

  /*
    Split allocation. The adaptive guard resizes only the AO / DOF / godray
    targets, and it can do that several times a minute — re-cutting the 4x MSAA
    full-res HDR scene target alongside them would cost a visible hitch every
    time, which is a strange way to fix a frame-rate problem.
  */
  function allocatePasses(w, h) {
    for (const t of [aoA, aoB, dofRT, sunA, sunB]) if (t) t.dispose();
    const P = params.perf;
    const [aw, ah] = sizeOf(w, h, P.aoScale * dynScale);
    aoA = rt(aw, ah, { type: THREE.UnsignedByteType });
    aoB = rt(aw, ah, { type: THREE.UnsignedByteType });

    const [dw, dh] = sizeOf(w, h, P.dofScale * dynScale);
    dofRT = rt(dw, dh);

    const [qw, qh] = sizeOf(w, h, P.sunScale * dynScale);
    sunA = rt(qw, qh);
    sunB = rt(qw, qh);
  }

  function allocate(w, h) {
    disposeAll();
    W = w; H = h;

    depthTex = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
    depthTex.format = THREE.DepthFormat;
    depthTex.minFilter = THREE.NearestFilter;
    depthTex.magFilter = THREE.NearestFilter;

    rtScene = rt(w, h, { depthBuffer: true, samples: params.perf.msaa });
    rtScene.depthTexture = depthTex;
    rtScene.texture.name = 'postfx.scene';

    rtComp = rt(w, h);

    aoA = aoB = dofRT = sunA = sunB = null;
    allocatePasses(w, h);

    // luminance pyramid: 1/8 res, then /4 until 1x1
    lumChain = [];
    let lw = Math.max(1, Math.ceil(w / 8)), lh = Math.max(1, Math.ceil(h / 8));
    lumChain.push(rt(lw, lh, { minFilter: THREE.LinearFilter }));
    while (lw > 1 || lh > 1) {
      lw = Math.max(1, Math.ceil(lw / 4));
      lh = Math.max(1, Math.ceil(lh / 4));
      lumChain.push(rt(lw, lh));
    }
    adapt = [
      rt(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter }),
      rt(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter }),
    ];
    adaptPing = 0;

    /*
      Bloom pyramid, half-res base. The bloom's reach is governed by the tent
      filter on the COARSEST level, whose width in screen terms is
      2^levels / (W/2) — so a fixed level count makes the bloom wider and
      wider as the resolution drops. Scale the count with log2 of the height
      instead, and carry the fractional part into the tent radius so the reach
      is continuous rather than doubling at every power of two.

      At 1080p this reproduces the tuned look exactly: levels = 6, tent = 1.0.
    */
    const [bw0, bh0] = sizeOf(w, h, 0.5);
    const want = params.bloom.levels + Math.log2(h / REF_H);
    const cap = Math.max(3, Math.floor(Math.log2(Math.min(bw0, bh0))) - 1);
    const levels = clamp(Math.floor(want), 3, Math.min(params.bloom.levels, cap));
    bloomTent = clamp(Math.pow(2, want - levels), 1, 2);
    bloomDown = []; bloomUp = [];
    let bw = bw0, bh = bh0;
    for (let i = 0; i < levels; i++) {
      bloomDown.push(rt(bw, bh));
      bloomUp.push(rt(bw, bh));
      bw = Math.max(1, Math.ceil(bw / 2));
      bh = Math.max(1, Math.ceil(bh / 2));
    }
  }

  function disposeAll() {
    const all = [rtScene, rtComp, aoA, aoB, dofRT, sunA, sunB, ...lumChain, ...adapt,
      ...bloomDown, ...bloomUp];
    for (const t of all) if (t) t.dispose();
    if (depthTex) depthTex.dispose();
  }

  // -------------------------------------------------------------------------
  // passes
  // -------------------------------------------------------------------------

  const quad = new FullScreenQuad(null);
  function draw(material, target) {
    quad.material = material;
    renderer.setRenderTarget(target || null);
    quad.render(renderer);
  }

  // --- luminance prefilter (scene -> log luminance) ---
  const lumPre = mat(/* glsl */`
    precision highp float;
    uniform sampler2D tSrc; uniform vec2 uTexel; varying vec2 vUv;
    ${LUMA}
    void main() {
      vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
      c += texture2D(tSrc, vUv + uTexel * vec2( 1.0, -1.0)).rgb;
      c += texture2D(tSrc, vUv + uTexel * vec2(-1.0,  1.0)).rgb;
      c += texture2D(tSrc, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
      c *= 0.25;
      // Clamp the range hard: one pixel of sun disc must not steer the meter,
      // and a frame that is 90% black must not drive exposure to the ceiling.
      float l = clamp(luma(c), 0.0018, 60.0);
      float lg = log(l);
      // Centre-weighted metering, like a real camera, and biased to the lower
      // half of the frame so a bright sky does not underexpose the land.
      vec2 d = vUv - vec2(0.5, 0.42);
      float r = length(d * vec2(1.0, 1.25)) * 1.42;
      float w = 1.0 - 0.72 * smoothstep(0.26, 1.0, r);
      /*
        .a is the weighted LINEAR mean, alongside .r's weighted log mean.
        A geometric mean is deaf to area: a frame that is a quarter blown and a
        frame with one blown pixel meter almost the same, which is measurably
        what happened at wave E (03-coast had 23.1% of its pixels with a channel
        pinned at 255 and metered LESS bright than 06-forest at 1.4%).

        HONEST CAVEAT: measured on the running build, this statistic came out at
        only 1.20x - 1.38x the geometric mean across the seven daylight poses —
        it separates them in the right ORDER but not by enough to be worth
        steering the meter with, because the metering weight w deliberately
        pulls toward the lower half of the frame and most of the blown area is
        sky. It is computed and carried because it costs one multiply-add in an
        eighth-res pass and because meter() reports it, but uHLArea (G.hla)
        ships at zero: the exposure differential is currently done entirely by
        the soft knee in EXPOSURE_LIB. Raising it needs its own measured pass.
      */
      gl_FragColor = vec4(lg * w, w, lg, l * w);
    }`, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });

  const lumDown = mat(/* glsl */`
    precision highp float;
    uniform sampler2D tSrc; uniform vec2 uTexel; varying vec2 vUv;
    void main() {
      vec4 a = texture2D(tSrc, vUv + uTexel * vec2(-1.5, -1.5));
      vec4 b = texture2D(tSrc, vUv + uTexel * vec2( 1.5, -1.5));
      vec4 c = texture2D(tSrc, vUv + uTexel * vec2(-1.5,  1.5));
      vec4 d = texture2D(tSrc, vUv + uTexel * vec2( 1.5,  1.5));
      vec2 avg = (a.rg + b.rg + c.rg + d.rg) * 0.25;
      float mx = max(max(a.b, b.b), max(c.b, d.b));
      float lin = (a.a + b.a + c.a + d.a) * 0.25;
      gl_FragColor = vec4(avg, mx, lin);
    }`, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });

  const adaptMat = mat(/* glsl */`
    precision highp float;
    uniform sampler2D tLum, tPrev;
    uniform float uRate, uHLProtect, uHLArea;
    varying vec2 vUv;
    void main() {
      vec4 s = texture2D(tLum, vec2(0.5));
      float avg = exp(s.r / max(s.g, 1e-4));
      float hi = exp(s.b);
      // Weighted linear mean — the area-sensitive term. See lumPre.
      float area = s.a / max(s.g, 1e-4);
      // Highlight protection: metering off the average alone blows a bright sky
      // out of a dark frame. Take whichever wants less exposure. At night this
      // has to be nearly off or the moon meters the whole world to black.
      // hi is a MAX, so one pixel of sun disc pins it; area is the same idea
      // weighted by how much of the frame is actually hot. uHLArea ships at 0 —
      // see the caveat in lumPre — so today this line is exactly the old one.
      float cur = clamp(max(max(avg, hi * uHLProtect), area * uHLArea), 0.0004, 40.0);
      float prev = texture2D(tPrev, vec2(0.5)).r;
      if (prev < 1e-5) prev = cur;
      // .gb carry the two raw statistics for the meter() telemetry. Nothing
      // reads them on the GPU; sceneExposure() only ever samples .r.
      gl_FragColor = vec4(mix(prev, cur, uRate), area, avg, 1.0);
    }`, {
    tLum: { value: null }, tPrev: { value: null },
    uRate: { value: 0.1 }, uHLProtect: { value: 0.12 }, uHLArea: { value: 0.0 },
  });

  // --- SSAO ---
  // The sample count is a compile-time constant (ESSL 1.00 wants constant loop
  // bounds), so changing params.perf.aoSamples recompiles this one shader.
  const aoSrc = (SAMPLES) => /* glsl */`
    precision highp float;
    varying vec2 vUv;
    uniform vec2 uRes;
    uniform mat4 uProj;
    uniform float uRadius, uBias, uPower, uMaxDist;
    ${DEPTH_LIB}
    ${NOISE}
    const int SAMPLES = ${SAMPLES | 0};
    void main() {
      float d = rawDepth(vUv);
      if (d >= 0.999999) { gl_FragColor = vec4(1.0, 1.0, 0.0, 1.0); return; }
      vec3 P = viewPos(vUv, d);
      float dist = -P.z;
      // .g carries sqrt-compressed view depth so the bilateral blur can read
      // its edge-stopping term straight out of this target instead of taking a
      // second full-res depth fetch for every one of its taps. sqrt keeps the
      // 8-bit precision where contact shading actually lives — near the camera.
      float dn = sqrt(clamp(dist / uMaxDist, 0.0, 1.0));
      if (dist > uMaxDist) { gl_FragColor = vec4(1.0, 1.0, 0.0, 1.0); return; }

      vec2 tx = vec2(1.5 / uRes.x, 0.0), ty = vec2(0.0, 1.5 / uRes.y);
      vec3 pR = viewPos(vUv + tx, rawDepth(vUv + tx));
      vec3 pL = viewPos(vUv - tx, rawDepth(vUv - tx));
      vec3 pU = viewPos(vUv + ty, rawDepth(vUv + ty));
      vec3 pD = viewPos(vUv - ty, rawDepth(vUv - ty));
      vec3 dx = abs(pR.z - P.z) < abs(pL.z - P.z) ? (pR - P) : (P - pL);
      vec3 dy = abs(pU.z - P.z) < abs(pD.z - P.z) ? (pU - P) : (P - pD);
      vec3 N = cross(dx, dy);
      float nl = length(N);
      if (nl < 1e-8) { gl_FragColor = vec4(1.0, dn, 0.0, 1.0); return; }
      N /= nl;
      if (N.z < 0.0) N = -N;

      vec3 up = abs(N.z) < 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
      vec3 T = normalize(cross(up, N));
      vec3 B = cross(N, T);

      // Scale the world-space radius with distance so foliage keeps its contact
      // shading at 60 m instead of the effect collapsing to a single texel.
      float rad = uRadius * (1.0 + dist * 0.012);

      float ang = hash12(floor(vUv * uRes)) * 6.28318530718;
      float occ = 0.0;
      for (int i = 0; i < SAMPLES; i++) {
        float fi = (float(i) + 0.5) / float(SAMPLES);
        float a = ang + float(i) * 2.39996323;
        float r = pow(fi, 0.7);
        vec3 dirv = T * (cos(a) * r) + B * (sin(a) * r) + N * (0.12 + 0.88 * fi * fi);
        vec3 sp = P + dirv * rad;
        vec4 off = uProj * vec4(sp, 1.0);
        vec2 suv = off.xy / off.w * 0.5 + 0.5;
        if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;
        float sd = rawDepth(suv);
        if (sd >= 0.999999) continue;
        vec3 spv = viewPos(suv, sd);
        float dz = spv.z - sp.z;              // >0 -> scene is nearer than the sample
        float range = smoothstep(0.0, 1.0, rad / max(abs(P.z - spv.z), 1e-4));
        occ += step(uBias, dz) * range;
      }
      float ao = 1.0 - occ / float(SAMPLES);
      ao = pow(clamp(ao, 0.0, 1.0), uPower);
      ao = mix(1.0, ao, 1.0 - smoothstep(uMaxDist * 0.55, uMaxDist, dist));
      gl_FragColor = vec4(ao, dn, 0.0, 1.0);
    }`;
  const aoMat = mat(aoSrc(params.perf.aoSamples), {
    tDepth: { value: null }, uProjInv: { value: new THREE.Matrix4() },
    uProj: { value: new THREE.Matrix4() }, uCamNF: { value: new THREE.Vector2() },
    uRes: { value: new THREE.Vector2() },
    uRadius: { value: 1.15 }, uBias: { value: 0.03 },
    uPower: { value: 1.7 }, uMaxDist: { value: 220 },
  });

  // Bilateral blur. Reads AO and its edge-stopping depth from the SAME texel,
  // so a tap costs one fetch instead of two, and nothing here touches the
  // full-res depth texture at all.
  const aoBlurSrc = (TAPS) => /* glsl */`
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tAO;
    uniform vec2 uDir;
    void main() {
      vec2 c = texture2D(tAO, vUv).rg;
      float sum = c.r * 0.25;
      float wsum = 0.25;
      for (int i = 1; i <= ${TAPS | 0}; i++) {
        float f = float(i);
        vec2 o = uDir * f;
        float w = 0.25 / (1.0 + f * 0.6);
        vec2 s1 = texture2D(tAO, vUv + o).rg;
        vec2 s2 = texture2D(tAO, vUv - o).rg;
        float w1 = w * exp(-abs(s1.g - c.g) * 90.0);
        float w2 = w * exp(-abs(s2.g - c.g) * 90.0);
        sum += s1.r * w1 + s2.r * w2;
        wsum += w1 + w2;
      }
      gl_FragColor = vec4(sum / max(wsum, 1e-4), c.g, 0.0, 1.0);
    }`;
  const aoBlur = mat(aoBlurSrc(params.perf.aoBlurTaps), {
    tAO: { value: null }, uDir: { value: new THREE.Vector2() },
  });

  // --- bloom ---
  const bloomPre = mat(/* glsl */`
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tSrc; uniform vec2 uTexel;
    uniform float uThreshold, uKnee;
    ${LUMA}
    ${EXPOSURE_LIB}
    vec3 thresh(vec3 c) {
      float br = max(c.r, max(c.g, c.b));
      float soft = br - uThreshold + uKnee;
      soft = clamp(soft, 0.0, 2.0 * uKnee);
      soft = soft * soft / (4.0 * uKnee + 1e-4);
      float w = max(soft, br - uThreshold) / max(br, 1e-4);
      return c * w;
    }
    vec3 fetch(vec2 o, float ev) { return thresh(texture2D(tSrc, vUv + uTexel * o).rgb * ev); }
    void main() {
      float ev = sceneExposure();
      vec3 a = fetch(vec2(-2.0,  2.0), ev), b = fetch(vec2(0.0,  2.0), ev), c = fetch(vec2(2.0,  2.0), ev);
      vec3 d = fetch(vec2(-2.0,  0.0), ev), e = fetch(vec2(0.0,  0.0), ev), f = fetch(vec2(2.0,  0.0), ev);
      vec3 g = fetch(vec2(-2.0, -2.0), ev), h = fetch(vec2(0.0, -2.0), ev), i = fetch(vec2(2.0, -2.0), ev);
      vec3 j = fetch(vec2(-1.0,  1.0), ev), k = fetch(vec2(1.0,  1.0), ev);
      vec3 l = fetch(vec2(-1.0, -1.0), ev), m = fetch(vec2(1.0, -1.0), ev);
      vec3 g0 = (j + k + l + m) * 0.25;
      vec3 g1 = (a + b + d + e) * 0.25;
      vec3 g2 = (b + c + e + f) * 0.25;
      vec3 g3 = (d + e + g + h) * 0.25;
      vec3 g4 = (e + f + h + i) * 0.25;
      // Karis average: firefly suppression, keeps single bright grass blades
      // from turning into flicker.
      float w0 = 0.5   / (1.0 + luma(g0));
      float w1 = 0.125 / (1.0 + luma(g1));
      float w2 = 0.125 / (1.0 + luma(g2));
      float w3 = 0.125 / (1.0 + luma(g3));
      float w4 = 0.125 / (1.0 + luma(g4));
      float wsum = w0 + w1 + w2 + w3 + w4;
      vec3 o = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / max(wsum, 1e-4);
      gl_FragColor = vec4(max(o, vec3(0.0)), 1.0);
    }`, {
    tSrc: { value: null }, uTexel: { value: new THREE.Vector2() },
    uThreshold: { value: 1.05 }, uKnee: { value: 0.55 },
    tAdapt: { value: null }, uExposure: { value: new THREE.Vector3() },
    uExposureMul: { value: 1 }, uExposureKnee: { value: 0.0 },
  });

  const bloomDownMat = mat(/* glsl */`
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tSrc; uniform vec2 uTexel;
    vec3 F(vec2 o) { return texture2D(tSrc, vUv + uTexel * o).rgb; }
    void main() {
      vec3 a = F(vec2(-2.0,  2.0)), b = F(vec2(0.0,  2.0)), c = F(vec2(2.0,  2.0));
      vec3 d = F(vec2(-2.0,  0.0)), e = F(vec2(0.0,  0.0)), f = F(vec2(2.0,  0.0));
      vec3 g = F(vec2(-2.0, -2.0)), h = F(vec2(0.0, -2.0)), i = F(vec2(2.0, -2.0));
      vec3 j = F(vec2(-1.0,  1.0)), k = F(vec2(1.0,  1.0));
      vec3 l = F(vec2(-1.0, -1.0)), m = F(vec2(1.0, -1.0));
      vec3 o = (j + k + l + m) * 0.125;
      o += (a + b + d + e) * 0.03125;
      o += (b + c + e + f) * 0.03125;
      o += (d + e + g + h) * 0.03125;
      o += (e + f + h + i) * 0.03125;
      gl_FragColor = vec4(o, 1.0);
    }`, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });

  const bloomUpMat = mat(/* glsl */`
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tSmall, tBig; uniform vec2 uTexel;
    uniform float uScatter; uniform vec3 uHalation;
    vec3 F(vec2 o) { return texture2D(tSmall, vUv + uTexel * o).rgb; }
    void main() {
      vec3 s = F(vec2(-1.0,  1.0)) + F(vec2(0.0,  1.0)) * 2.0 + F(vec2(1.0,  1.0));
      s += F(vec2(-1.0,  0.0)) * 2.0 + F(vec2(0.0, 0.0)) * 4.0 + F(vec2(1.0, 0.0)) * 2.0;
      s += F(vec2(-1.0, -1.0)) + F(vec2(0.0, -1.0)) * 2.0 + F(vec2(1.0, -1.0));
      s *= 0.0625;
      // Halation: on film the red-sensitive layer scatters furthest, so the
      // widest bloom radii carry a warm cast. Applied on the way up, so the
      // tight core stays neutral and only the wide skirt goes amber.
      s *= uHalation;
      vec3 big = texture2D(tBig, vUv).rgb;
      gl_FragColor = vec4(mix(big, s, uScatter), 1.0);
    }`, {
    tSmall: { value: null }, tBig: { value: null },
    uTexel: { value: new THREE.Vector2() }, uScatter: { value: 0.78 },
    uHalation: { value: new THREE.Vector3(1, 1, 1) },
  });

  /*
    --- the sun's own glare ------------------------------------------------

    Two lobes around the sun direction, evaluated per view ray: a tight core a
    couple of degrees wide and a wide skirt. This is the atmospheric/lens glare
    that surrounds a low sun, and it is what gives the bloom pass something to
    put a halo around: measured at wave E, the sun sits at screen uv (0.20,
    0.78) on 01-sunset-ridge with the godray pass at full strength, and the
    frame still has no readable source in it — because the dome at that point is
    a smooth pastel gradient with no core, so the bloom threshold never trips
    and the shaft march has nothing bright to march out of.

    Evaluated identically in the shaft seed and in the composite so the core the
    bloom sees and the core the shafts radiate from are the same core.
  */
  const SUN_GLARE = /* glsl */`
uniform vec3 uSunDirView;
uniform vec4 uSunGlow;   // x = strength, y = core power, z = skirt power, w = skirt mix
vec3 sunGlare(vec3 rayView, vec3 tint) {
  if (uSunGlow.x <= 0.0) return vec3(0.0);
  float c = max(dot(normalize(rayView), uSunDirView), 0.0);
  return tint * uSunGlow.x * (pow(c, uSunGlow.y) + uSunGlow.w * pow(c, uSunGlow.z));
}`;

  // --- godrays ---
  const sunOcc = mat(/* glsl */`
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tSrc;
    uniform float uFar, uSeed, uOccSharp;
    uniform vec3 uSunTint;
    ${DEPTH_LIB}
    ${LUMA}
    ${EXPOSURE_LIB}
    ${SUN_GLARE}
    void main() {
      float rd = rawDepth(vUv);
      float lz = linearEye(rd);
      /*
        WHAT COUNTS AS SKY IN THE SEED. This used to be
        smoothstep(0.35, 0.80, lz/uFar) — 2100m to 4800m against a 6000m far
        plane. Measured on 01-sunset-ridge, the far-silhouette ridges that
        make up the whole horizon sit at 3129m and 4007m, i.e. this declared
        them 32% and 78% SKY. The one thing that is supposed to interrupt a
        shaft was therefore seeding it: the seed buffer came out nearly uniform
        (bright sky next to bright "32% sky" mountain), and a radial blur of a
        uniform field is a wash, not a shaft. That is why godrays measured
        0.68% of pixels changed at maxAbs 7/255 with strength 1.0 — against a
        frozen-rAF harness noise of 0.00% / 2.
        The dome is the only thing in the frame that meters at exactly
        camera.far (it writes no depth), which is the same test the composite's
        skyMask uses. Use it here too, so every solid thing — ridge, tree,
        grass — is a genuine occluder.
      */
      float sky = mix(smoothstep(0.35, 0.80, lz / uFar),
                      smoothstep(0.9985, 0.99995, lz / uFar), uOccSharp);
      vec3 c = texture2D(tSrc, vUv).rgb * sceneExposure();
      // The glare core seeds the shafts as well as the bloom. Sky only — a
      // shaft has to start behind the geometry that is going to interrupt it.
      c += sunGlare(viewPos(vUv, rd), uSunTint) * sky;
      // Only the genuinely bright part of the sky seeds a shaft.
      float b = max(0.0, luma(c) - uSeed);
      gl_FragColor = vec4(min(c * (b / max(luma(c), 1e-4)), vec3(24.0)) * sky, 1.0);
    }`, {
    tSrc: { value: null }, tDepth: { value: null },
    uProjInv: { value: new THREE.Matrix4() }, uCamNF: { value: new THREE.Vector2() },
    uFar: { value: 6000 }, uSeed: { value: 0.5 }, uOccSharp: { value: 1.0 },
    uSunDirView: { value: new THREE.Vector3(0, 0, -1) },
    uSunGlow: { value: new THREE.Vector4(0, 900, 40, 0.18) },
    uSunTint: { value: new THREE.Color(1, 1, 1) },
    tAdapt: { value: null }, uExposure: { value: new THREE.Vector3() },
    uExposureMul: { value: 1 }, uExposureKnee: { value: 0.0 },
  });

  // The march is jittered per pixel, so halving the step count trades a little
  // extra dither noise (which the grain hides) rather than visible banding.
  const sunBlurSrc = (STEPS) => /* glsl */`
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tSrc;
    uniform vec2 uSunUV;
    uniform float uDensity, uDecay, uWeight;
    uniform vec3 uDust;   // x = depth of modulation, y = drift phase, z = aspect
    ${NOISE}
    const int STEPS = ${STEPS | 0};

    /*
      DUST IN THE BEAM.

      A radial blur of a bright sky integrates to a smooth gradient, and a
      smooth gradient is a glow, not a shaft. Real crepuscular rays are
      separated because the medium the light crosses is not uniform and because
      something upwind of the camera is breaking the beam up. The occlusion term
      supplies the second half of that — anything silhouetted against the sky is
      already black in the seed — but at every judged pose the sun sits in open
      sky (measured: uv (0.20,0.78) on 01, (0.48,0.93) on 05) with no canopy
      between it and the camera, so occlusion alone integrates to a wash.

      This is the medium. A band-limited angular field about the sun's screen
      position, so it forms wedges that radiate from the source and stay
      anchored to it as the camera moves, drifting slowly rather than crawling.
      It MULTIPLIES the marched samples, so it can only shape light that the
      occlusion test already said was there — it can never invent a shaft
      through a solid object.
    */
    float beamField(float a) {
      return 0.52
           + 0.26 * sin(a *  6.0 + uDust.y * 0.13)
           + 0.14 * sin(a * 11.0 - uDust.y * 0.21 + 2.1)
           + 0.08 * sin(a * 19.0 + uDust.y * 0.09 + 4.4);
    }

    void main() {
      vec2 uv = vUv;
      vec2 delta = (uv - uSunUV) * (uDensity / float(STEPS));
      vec2 rel = (vUv - uSunUV) * vec2(uDust.z, 1.0);
      float dust = mix(1.0, beamField(atan(rel.y, rel.x)), uDust.x);
      // jitter the ray start so the steps do not band
      uv -= delta * hash12(gl_FragCoord.xy);
      float illum = 1.0;
      vec3 acc = vec3(0.0);
      for (int i = 0; i < STEPS; i++) {
        uv -= delta;
        float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
        acc += texture2D(tSrc, clamp(uv, vec2(0.0), vec2(1.0))).rgb * illum * inside;
        illum *= uDecay;
      }
      gl_FragColor = vec4(acc * (uWeight * dust / float(STEPS)), 1.0);
    }`;
  const sunBlur = mat(sunBlurSrc(params.perf.sunSteps), {
    tSrc: { value: null }, uSunUV: { value: new THREE.Vector2(0.5, 0.5) },
    uDensity: { value: 0.80 }, uDecay: { value: 0.972 }, uWeight: { value: 0.34 },
    uDust: { value: new THREE.Vector3(0.0, 0.0, 1.777) },
  });

  // --- depth of field (far field only) ---
  /*
    uBlurUV is the bokeh radius as a FRACTION OF THE FRAME, aspect-corrected so
    the disc stays a circle. It used to be `uBlurPx * uTexel` of this pass's own
    render target, which meant the blur got wider every time the window got
    smaller and the pass got cheaper — the same frame was sharp at 1080p and
    dissolved at 360p. Nothing in here may depend on the target's size again:
    that is also what lets the pass render at a third of full res for free.
  */
  const dofSrc = (TAPS) => /* glsl */`
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tSrc;
    uniform vec2 uBlurUV;
    uniform vec3 uFocus;   // x = near edge, y = range, z = max coc
    ${DEPTH_LIB}
    ${NOISE}
    const int TAPS = ${TAPS | 0};
    float cocAt(vec2 uv) {
      float lz = linearEye(rawDepth(uv));
      /*
        THE SKY MUST STAY SHARP. The dome is drawn with gl_Position.z forced to
        w and writes no depth, so every sky pixel carries the CLEARED depth and
        meters as exactly camera.far — the only thing in the frame that does.
        Without this test it took the full far-field CoC: a ~11px bokeh disc
        smeared across the whole dome, which is what erased the starfield (stars
        are 2-5px), softened the moon, and spread the sun's core into the flat
        wash that had "no source" in it. Anything real at 5994m is inside the
        far clip by six metres and is not worth a branch.
      */
      if (lz >= uCamNF.y * 0.999) return 0.0;
      float t = clamp((lz - uFocus.x) / uFocus.y, 0.0, 1.0);
      // Quadratic ramp: the mid-ground stays crisp and only the far bands go
      // soft. A linear ramp softens the ridge the composition is built on.
      return t * t * uFocus.z;
    }
    void main() {
      float c0 = cocAt(vUv);
      if (c0 < 0.004) { gl_FragColor = vec4(texture2D(tSrc, vUv).rgb, 0.0); return; }
      float ang = hash12(gl_FragCoord.xy) * 6.28318530718;
      vec3 acc = texture2D(tSrc, vUv).rgb;
      float wsum = 1.0;
      for (int i = 0; i < TAPS; i++) {
        float fi = (float(i) + 0.5) / float(TAPS);
        float a = ang + float(i) * 2.39996323;
        float r = sqrt(fi) * c0;
        vec2 uv = vUv + vec2(cos(a), sin(a)) * r * uBlurUV;
        float cs = cocAt(uv);
        // A sharp foreground pixel must not bleed into the blurred distance.
        float w = clamp(cs / max(c0, 1e-3), 0.0, 1.0);
        acc += texture2D(tSrc, uv).rgb * w;
        wsum += w;
      }
      gl_FragColor = vec4(acc / wsum, c0);
    }`;
  const dofMat = mat(dofSrc(params.perf.dofTaps), {
    tSrc: { value: null }, tDepth: { value: null },
    uProjInv: { value: new THREE.Matrix4() }, uCamNF: { value: new THREE.Vector2() },
    uBlurUV: { value: new THREE.Vector2() },
    uFocus: { value: new THREE.Vector3(60, 700, 0.9) },
  });

  /*
    AIRLIGHT_LIB — the sky dome's own gradient, evaluated for an arbitrary ray.

    Aerial perspective has one boundary condition: at infinite optical depth a
    surface's radiance IS the airlight radiance along that ray, and the airlight
    radiance along a ray is exactly what the dome shows in that direction. So the
    far-field target is not a constant to be tuned, it is a function of direction
    that we already own. Blending far land toward THIS instead of toward a
    hand-picked uHazeWarm makes "distant ridge brighter than the sky behind it"
    unrepresentable rather than merely discouraged, because both sides of the
    horizon line are now evaluating the same function of the same uniforms.

    This mirrors world/sky.js's dome fragment, lines 542-575 and 700-701, term for
    term: the azimuthal horizon blend, the three-stop altitude gradient, the Belt
    of Venus and the earth's shadow under it, the two warm halo falloffs, the
    below-horizon haze wedge, the Mie forward lobe and its multiplicative warm
    gain, and the final horizon breath. The uniforms are not a second set of
    hand-tuned numbers — they are COPIED off ctx.sky.uniforms every frame, so
    every grade state and every point in the day cycle stays consistent by
    construction and there is nothing here to retune when the time of day moves.

    Deliberately NOT mirrored: cloud decks, stars, the milky way, the moon, and
    the sun's disc. The first four are stochastic screen features rather than a
    smooth radiance field, and the sun's disc is direct solar transmission, not
    airlight — the composite already carries that separately as sunGlare(), which
    is depth-occluded on purpose.
  */
  const AIRLIGHT_LIB = /* glsl */`
uniform vec3 uSkyZen, uSkyMid, uSkyHor, uSkyHorOpp, uSkyBelt, uSkyHaze, uSkyHalo;
uniform vec3 uSkyMisc;   // x warmGlow, y beltAmt, z sunUp
uniform vec2 uSkySunXZ;
uniform mat3 uViewToWorld;

vec3 skyRadiance(vec3 dW, float cosT) {
  float h = dW.y;
  vec2 dxz = dW.xz;
  float lxz = length(dxz);
  float az = lxz > 1e-5 ? dot(dxz / lxz, uSkySunXZ) : 1.0;
  float azR = az * 0.5 + 0.5;
  float azW = pow(max(az, 0.0), 2.4);
  vec3 horC = mix(uSkyHorOpp, uSkyHor, smoothstep(0.12, 0.94, azR));

  float f = pow(clamp(h, 0.0, 1.0), 0.34);
  vec3 col = mix(horC, uSkyMid, smoothstep(0.0, 0.52, f));
  col = mix(col, uSkyZen, smoothstep(0.34, 1.0, f));

  float anti = (1.0 - azR) * uSkyMisc.y;
  if (anti > 0.002) {
    float bh = (h - 0.078) / 0.062;
    col += uSkyBelt * exp(-bh * bh) * anti;
    float eh = h / 0.034;
    col = mix(col, uSkyHorOpp * 0.42, exp(-eh * eh) * anti * 0.55);
  }

  col += uSkyHalo * (azW * exp(-max(h, 0.0) * 3.4) * uSkyMisc.x * 0.16);
  col += uSkyHalo * (azW * exp(-max(h, 0.0) * 11.0) * uSkyMisc.x * 0.12);

  float below = smoothstep(0.0, -0.34, h);
  vec3 hz = uSkyHaze * (1.0 - 0.30 * below) * (1.0 + 0.45 * azW);
  col = mix(col, hz, smoothstep(0.022, -0.135, h));

  float cs = max(cosT, 0.0);
  float mie = pow(cs, 12.0) * 0.10 + pow(cs, 80.0) * 0.28 + pow(cs, 420.0) * 1.10;
  col += uSkyHalo * mie * uSkyMisc.z * 0.40;
  col *= 1.0 + 0.12 * cs * cs * uSkyMisc.z;

  col = mix(col, uSkyHaze * (1.0 + 0.45 * azW), smoothstep(0.058, -0.050, h) * 0.45);
  return max(col, vec3(0.0));
}`;

  // --- composite: everything merged, still linear HDR ---
  const compMat = mat(/* glsl */`
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tScene, tBloom, tAO, tDOF, tSun;
    uniform vec3 uBloomTint, uSunTint, uAOTint, uWhiteBalance, uLinCool, uLinWarm;
    /*
      uHazeCool IS DEAD as of wave M. Read nothing into it and do not tune it.

      It was the cool end of the old aerial target, a cosT smoothstep from
      uHazeCool to uHazeWarm. The aerial pass now converges far land
      onto skyRadiance(), the dome's own gradient, so there is no hand-authored
      target left for it to be half of. It is still declared, still uploaded
      each frame, and all four grade states still carry a hazeCool triple,
      because deleting it would churn the grade tables for no visual gain — but
      every one of those numbers is inert. Changing any of them renders exactly
      the same frame. Same story for uAerial.y (the old inscatter amount,
      G.aerIn * params.aerial.strength): still computed and uploaded, read by
      nothing, superseded by uAirConverge.
    */
    uniform vec3 uHazeWarm, uHazeCool, uVigTint;
    uniform vec4 uAerial;    // x density, y DEAD (see above), z mie power, w mie strength
    uniform vec2 uLinSplit;
    uniform float uBloomStrength, uAOStrength, uSunStrength, uDofMix, uGoldPush;
    uniform float uSunOcclude, uSunSky, uSunHeadroom;
    uniform float uGrain, uGrainSize, uTime;
    uniform vec3 uVignette;  // amount, start, end
    uniform vec2 uRes;
    uniform float uFar;
    ${DEPTH_LIB}
    ${LUMA}
    ${NOISE}
    ${EXPOSURE_LIB}
    ${SUN_GLARE}
    ${AIRLIGHT_LIB}
    uniform float uAirConverge;   // far-field convergence fraction

    void main() {
      vec3 c = texture2D(tScene, vUv).rgb;
      float ev = sceneExposure();
      c *= ev;

      /*
        Every block below is gated on its own uniform. These are uniform-valued
        branches, so they are coherent across the whole draw — the GPU takes the
        same side for every pixel and the skipped texture fetches are genuinely
        never issued. That is what makes "godrays with the sun below the
        horizon" cost nothing at night instead of costing a full-res fetch and a
        multiply-by-zero.
      */

      // ---- depth of field ----
      if (uDofMix > 0.0) {
        vec4 dofS = texture2D(tDOF, vUv);
        float coc = clamp(dofS.a, 0.0, 1.0) * uDofMix;
        c = mix(c, dofS.rgb * ev, smoothstep(0.0, 1.0, coc));
      }

      float l0 = luma(c);

      // ---- ambient occlusion ----
      if (uAOStrength > 0.0) {
        float ao = texture2D(tAO, vUv).r;
        // AO is an ambient term: pull it back where the pixel is clearly key-lit,
        // otherwise sunlit grass gets dirty crevices that sunlight would fill.
        float lit = smoothstep(0.55, 2.2, l0);
        float k = uAOStrength * (1.0 - 0.72 * lit);
        float aoF = mix(1.0, ao, clamp(k, 0.0, 1.0));
        c *= mix(uAOTint, vec3(1.0), aoF);
      }

      // ---- aerial perspective ---------------------------------------------
      // Directional in-scattering. Forward scatter toward the sun is a hot
      // amber lobe; back scatter is cool Rayleigh blue. This is the pass that
      // gives near / mid / far three distinct values instead of one mud.
      float rd = rawDepth(vUv);
      float lz = linearEye(rd);
      /*
        This mask exists to keep the in-scatter off the SKY. It used to ramp
        from 0.30 to 0.72 of the far plane — 1800m to 4300m — so it declared
        every distant ridge, the far shore and the whole sea haze to be sky and
        stripped the aerial pass straight back off them. That is why depth ran
        BACKWARDS: the far band came out darker and higher in contrast than the
        near band, and at the summit sky / horizon / sea / ground metered as one
        continuous value. The dome writes no depth and is pinned to the far
        plane, so it is the only thing that meters at exactly camera.far; test
        for that instead and every band of real geometry keeps its haze.
      */
      float skyMask = smoothstep(0.9985, 0.99995, lz / uFar);
      vec3 ray = normalize(viewPos(vUv, rd));
      float cosT = dot(ray, uSunDirView);
      float mie = pow(max(cosT, 0.0), uAerial.z);
      /*
        The airlight TARGET is the sky's own radiance along this ray, not a
        constant. What was here blended toward uHazeWarm, whose red channel is
        1.58 — greater than one, so the "tint" was a brightening operator — and
        it did so on land only, because dens carries (1.0 - skyMask) and the
        dome is exempt. Far land therefore climbed AWAY from the sky it sits
        against instead of converging onto it, and every distant ridge metered
        brighter than its own sky. Five waves tried to fix that by retuning the
        far-field haze colour inside world/terrain.js; none of them could,
        because whatever value terrain hands over gets re-brightened right here.

        skyRadiance() is the dome's gradient, same uniforms, same terms. Both
        sides of a horizon line now evaluate one function, so at full optical
        depth land lands ON its sky rather than through it.
      */
      vec3 rayW = uViewToWorld * ray;
      vec3 inscat = skyRadiance(rayW, cosT) * ev;
      /*
        The density SHAPE is canonical, untouched. It saturates by about 2 km,
        so every graded far band sits at dens ~= 1 and uAirConverge is literally
        the far-field convergence fraction — which makes this ONE number the
        whole calibration, and it was swept rather than guessed. Measured
        sky-land on 01/03/05/07, canonical is -56.8/-26.1/+12.2/-33.2:

          converge 0.00   +17.7 / +68.8 /     - / -19.4    (mix disabled)
          converge 0.26    +8.2 / +38.4 / +27.1 / -11.8    <- shipped
          converge 0.36    +3.0 / +31.6 / +24.3 / -15.4
          converge 1.00   -22.1 / -11.6 / +30.9 / -22.0

        0.36 is the value that reproduces canonical's old mix weight
        (aerIn * strength) to three decimals, and it already flips three of the
        four poses — that run is the clean attribution, because the only thing
        that changed was the TARGET. 0.26 is a modest further step and is where
        01's top-third mean lands on its 130 bar.

        It is nowhere near 1.0 because postfx is the SECOND application of this
        physics: world/terrain.js already runs its own distance ramp capped at
        0.94 (see its aerial block) and far land arrives here mostly hazed. With
        this mix disabled entirely, terrain hands over 01-sunset-ridge far land
        at L=105.6 against sky 123.3, and 03-coast at 65.2 against 133.9 — both
        already correctly BELOW their sky. So the inversion was never terrain's
        far-field value, which is what five earlier waves went after; it was
        added here, downstream, by mixing that sane value toward a >1 constant.
        Convergence 1.0 overshoots in the other direction and measures -22.1 on
        01, because a full atmospheric column is more airlight than a 3 km path
        holds. Do not read the 0.00 column as "best": it scores well on this
        metric only by deleting aerial perspective, and the far ranges come back
        as hard near-black cutouts with no recession at all.
      */
      float tau = pow(max(lz, 0.0) * uAerial.x, 1.6);
      float dens = (1.0 - exp(-tau)) * (1.0 - skyMask);
      c = mix(c, inscat, clamp(dens * uAirConverge, 0.0, 1.0));
      // Veiling glare: the sun smears light over everything facing it, land or
      // sky. Wide, low frequency, warm — it is half of why GoT reads as hot.
      // It MUST accumulate with distance. Applied flat it lifts the black point
      // of near geometry and crushes the whole frame to one mustard value.
      /*
        Gated by (1.0 - dens). This term is an approximation of the Mie forward
        lobe in the airlight, and skyRadiance() already contains that lobe
        exactly — so wherever the mix above has converged, adding this again is
        double counting the same photons, and it double counts them at 1.0 on
        land against 0.45 on the dome. That asymmetry is the second half of the
        inversion and it survives any choice of target colour. Near and mid
        geometry, where dens is small, keep the term at full strength; that is
        the band it was tuned for and the band that still needs it.
      */
      float glareDepth = 1.0 - exp(-tau);
      c += uHazeWarm * mie * uAerial.w * glareDepth
           * mix(1.0, 0.45, skyMask) * (1.0 - dens);

      /*
        How much of this pixel's radiance is AIR rather than surface. The dome is
        all air by definition; a hazed ridge is most of the way there. Every
        remaining term that splits the frame into "land" and "sky" is really
        asking this question, and asking it as a binary is what lets far land
        diverge from the sky it is dissolving into.
      */
      float airFrac = max(skyMask, dens);

      // ---- the sun's own glare ----
      // The bright core the bloom pass hangs its halo on, and the same core the
      // shaft seed marches out of. Mostly on open sky; a quarter of it bleeds
      // over the geometry in front, because that is what glare does in a lens.
      /*
        DEPTH-OCCLUDED. This was mix(0.25, 1.0, skyMask): a quarter of the sun's
        own aureole was painted over whatever was in front of it, on the theory
        that "that is what glare does in a lens". On 01-sunset-ridge the sun
        projects to pixel (388,235), which is INSIDE the left ridge's
        silhouette (raycast: far-silhouette at 3129m along the sun ray), so the
        quarter-strength core landed as a soft radial hotspot on the mountain's
        face while no disc appeared anywhere in open sky. Measured by freezing
        rAF and driving frames by hand: sunGlow 1.5 -> 0 moved 12.81% of the
        frame, max 55/255 at pixel (414,170) — dead on the hotspot — while the
        A/B/A control moved 0.00% at max 1/255.
        The sun's own aureole is light arriving FROM the sun, so anything opaque
        between it and the lens blocks it. The airlight in FRONT of that
        occluder is a different term and is already carried, correctly and
        proportionally to distance, by the veiling-glare line above
        (uHazeWarm * mie * uAerial.w * glareDepth) — which is what keeps a
        3km ridge with the sun just behind it glowing.
      */
      c += sunGlare(ray, uSunTint) * (skyMask + (1.0 - skyMask) * 0.25 * (1.0 - uSunOcclude));

      // ---- godrays ----
      // Zero whenever the sun is below the horizon or behind the camera, which
      // is the whole of the night pose. The pass itself is skipped on the CPU
      // side too; this stops the composite paying for the lookup.
      if (uSunStrength > 0.0) {
        vec3 shafts = texture2D(tSun, vUv).rgb * uSunTint * uSunStrength;
        // How much of a shaft survives where it crosses open sky. Land gets all
        // of it; the dome gets uSunSky. This was a hard 0.45, tuned back when
        // the seed pass counted distant ridges as sky and the shafts were an
        // undifferentiated wash — under the fixed occlusion test the shafts
        // land exactly where light spills PAST an occluder, and on a ridge pose
        // that is mostly sky, so the penalty was cancelling the effect.
        /*
          HEADROOM GUARD. The shafts are additive linear HDR, so on a pose whose
          sky is already sitting on the tone curve's shoulder they buy no
          structure and only push pixels through the top. Measured on
          05-summit: at gain 14 with no guard, pixels with a channel at 255 went
          0.0096% -> 0.0190% and pixels above L=230 went 0.459% -> 0.846%.
          Divide the shaft by the brightness it is landing on, so it fills the
          headroom of a mid-bright sky and fades out of one that is already hot.
          uSunHeadroom = 0 restores the plain additive term.
        */
        /*
          Weighted by airFrac, not skyMask. A shaft is light scattered by the air
          BETWEEN the camera and whatever stops the ray, so the column in front
          of a 4 km ridge is very nearly the column in front of the dome and has
          to be weighted very nearly the same. Keyed to skyMask this went the
          other way: the dome took uSunSky (0.80) while the ridge one pixel below
          the skyline took the full 1.0, handing far land a 1.25x shaft premium
          over its own sky on exactly the poses with the most shaft energy. Near
          geometry, which really does have little air in front of it, still gets
          1.0 because its airFrac is ~0.
        */
        float hr = 1.0 / (1.0 + uSunHeadroom * max(luma(c), 0.0));
        c += shafts * mix(1.0, uSunSky, airFrac) * hr;
      }

      // ---- bloom ----
      if (uBloomStrength > 0.0) {
        c += texture2D(tBloom, vUv).rgb * uBloomTint * uBloomStrength;
      }

      // ---- gold push -------------------------------------------------------
      // GoT never shows engine-green. Under a warm key, chlorophyll reads gold
      // because the red channel of the key light dominates the leaf's own
      // reflectance. Bleed green into red, pull a little blue: pure hue work,
      // no hue interpolation through the colour wheel. Nothing to do at night,
      // where the grade sets gold to zero outright.
      if (uGoldPush > 0.0) {
        float grn = clamp((c.g - max(c.r, c.b)) / max(c.g, 1e-3), 0.0, 1.0);
        c.r += c.g * grn * uGoldPush;
        c.b -= c.b * grn * uGoldPush * 0.45;
      }

      // ---- white balance + linear-space colour separation ----
      // Doing the warm/cool split in scene-linear, BEFORE the tone curve, is
      // what makes a highlight read as sunlight instead of clipped white: the
      // amber survives the shoulder instead of being multiplied into a ceiling.
      c *= uWhiteBalance;
      float lin = luma(c);
      c *= mix(uLinCool, uLinWarm, smoothstep(uLinSplit.x, uLinSplit.y, lin));

      // ---- vignette as an exposure falloff (shapes, does not smother) ----
      vec2 vd = vUv - 0.5;
      float rad = length(vd * vec2(1.0, 0.94)) * 1.42;
      float vs = smoothstep(uVignette.y, uVignette.z, rad);
      c *= 1.0 - uVignette.x * vs;
      // and a whisper of cool at the corners, like an uncoated lens
      c *= mix(vec3(1.0), uVigTint, vs * 0.55);

      // ---- film grain, applied UNDER the tone curve ----
      // Multiplicative in scene-linear, weighted to the mids: this is how real
      // negative grain behaves, and it means the grade sits on top of it.
      if (uGrain > 0.0) {
        vec2 gp = gl_FragCoord.xy / max(uGrainSize, 0.05);
        float n1 = hash12(gp + floor(uTime * 24.0) * 37.1);
        float n2 = hash12(gp * 1.31 + 11.7 - floor(uTime * 24.0) * 21.3);
        float g = (n1 + n2) - 1.0;                    // triangular PDF, [-1,1]
        float lt = l0 / (1.0 + l0);
        float gw = 4.0 * lt * (1.0 - lt);             // strongest in the mids
        vec3 gc = vec3(g, g * 0.86 + (n2 - 0.5) * 0.28, g * 0.72 + (n1 - 0.5) * 0.36);
        c *= 1.0 + gc * uGrain * gw;
      }

      gl_FragColor = vec4(max(c, vec3(0.0)), 1.0);
    }`, {
    tScene: { value: null }, tBloom: { value: null }, tAO: { value: null },
    tDOF: { value: null }, tSun: { value: null }, tDepth: { value: null },
    uProjInv: { value: new THREE.Matrix4() }, uCamNF: { value: new THREE.Vector2() },
    uBloomTint: { value: new THREE.Color(1, 1, 1) },
    uSunTint: { value: new THREE.Color(1, 1, 1) },
    uAOTint: { value: new THREE.Color(0.10, 0.13, 0.19) },
    uWhiteBalance: { value: new THREE.Color(1, 1, 1) },
    uLinCool: { value: new THREE.Color(0.82, 0.94, 1.18) },
    uLinWarm: { value: new THREE.Color(1.14, 0.98, 0.76) },
    uHazeWarm: { value: new THREE.Color(1.3, 0.85, 0.5) },
    uHazeCool: { value: new THREE.Color(0.42, 0.52, 0.78) },
    uVigTint: { value: new THREE.Color(0.86, 0.92, 1.06) },
    uSunDirView: { value: new THREE.Vector3(0, 0, -1) },
    uSunGlow: { value: new THREE.Vector4(0, 900, 40, 0.18) },
    uAerial: { value: new THREE.Vector4(0.0011, 0.55, 9.0, 0.10) },
    uAirConverge: { value: 0.26 },
    // Copied off ctx.sky.uniforms each frame; never authored here. See
    // AIRLIGHT_LIB. The defaults are only what the first frame samples before
    // the sky lane has run once.
    uSkyZen: { value: new THREE.Color(0, 0, 0) },
    uSkyMid: { value: new THREE.Color(0, 0, 0) },
    uSkyHor: { value: new THREE.Color(0, 0, 0) },
    uSkyHorOpp: { value: new THREE.Color(0, 0, 0) },
    uSkyBelt: { value: new THREE.Color(0, 0, 0) },
    uSkyHaze: { value: new THREE.Color(0, 0, 0) },
    uSkyHalo: { value: new THREE.Color(0, 0, 0) },
    uSkyMisc: { value: new THREE.Vector3(1, 0, 1) },
    uSkySunXZ: { value: new THREE.Vector2(1, 0) },
    uViewToWorld: { value: new THREE.Matrix3() },
    uLinSplit: { value: new THREE.Vector2(0.05, 0.9) },
    uBloomStrength: { value: 0.06 }, uAOStrength: { value: 0.8 },
    uSunStrength: { value: 1.0 }, uDofMix: { value: 1.0 }, uGoldPush: { value: 0.0 },
    uSunOcclude: { value: 1.0 }, uSunSky: { value: 0.80 }, uSunHeadroom: { value: 2.0 },
    uGrain: { value: 0.03 }, uGrainSize: { value: 1.15 }, uTime: { value: 0 },
    uVignette: { value: new THREE.Vector3(0.36, 0.30, 1.08) },
    uRes: { value: new THREE.Vector2() }, uFar: { value: 6000 },
    tAdapt: { value: null }, uExposure: { value: new THREE.Vector3() },
    uExposureMul: { value: 1 }, uExposureKnee: { value: 0.0 },
  });

  // --- final grade: lens, tone curve, film grade, output ---
  const gradeMat = mat(/* glsl */`
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tComp;
    uniform float uDistort, uChroma, uEdgeDesat;
    uniform vec3 uShadowTint, uHighTint, uLift, uGain;
    uniform vec4 uToe;      // rgb = cool bounce added into the toe, a = its width
    uniform float uContrast, uSCurve, uSaturation, uVibrance;
    uniform float uSplitLow, uSplitHigh, uPivot;
    uniform float uShoulder, uHiDesat, uShadowSat, uHiKnee, uLoKnee;
    uniform vec2 uRes;
    ${LUMA}
    ${NOISE}

    // ACES filmic fit (Stephen Hill / Narkowicz), matching three's ACESFilmic so
    // anything tuned against the default renderer curve still reads the same.
    vec3 RRTAndODTFit(vec3 v) {
      vec3 a = v * (v + 0.0245786) - 0.000090537;
      vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
      return a / b;
    }
    vec3 aces(vec3 color) {
      const mat3 IN = mat3(
        0.59719, 0.07600, 0.02840,
        0.35458, 0.90834, 0.13383,
        0.04823, 0.01566, 0.83777);
      const mat3 OUT = mat3(
         1.60475, -0.10208, -0.00327,
        -0.53108,  1.10813, -0.07276,
        -0.07367, -0.00605,  1.07602);
      color = IN * (color / 0.6);
      color = RRTAndODTFit(color);
      return clamp(OUT * color, 0.0, 1.0);
    }

    vec3 toSRGB(vec3 c) {
      c = clamp(c, 0.0, 1.0);
      return mix(c * 12.92, 1.055 * pow(c, vec3(0.41666)) - 0.055,
                 step(vec3(0.0031308), c));
    }

    void main() {
      // ---- lens distortion, quartic so only the extreme edges move ----
      vec2 d = vUv - 0.5;
      float r2 = dot(d, d) * 2.0;
      vec2 duv = d * (1.0 + uDistort * r2 * r2);

      // ---- lateral chromatic aberration, edges only ----
      float ca = uChroma * smoothstep(0.35, 1.15, r2);
      vec3 col;
      col.r = texture2D(tComp, clamp(0.5 + duv * (1.0 + ca),       vec2(0.0), vec2(1.0))).r;
      col.g = texture2D(tComp, clamp(0.5 + duv,                    vec2(0.0), vec2(1.0))).g;
      col.b = texture2D(tComp, clamp(0.5 + duv * (1.0 - ca * 1.1), vec2(0.0), vec2(1.0))).b;

      // ---- highlight desaturation before the curve: sunlight goes white,
      //      not neon, which is what sells a photographic highlight ----
      float hl = smoothstep(1.8, 10.0, luma(col));
      col = mix(col, vec3(luma(col)), hl * uHiDesat);

      // ---- extra shoulder so the sky rolls off instead of clipping ----
      col = col * (1.0 + uShoulder) / (1.0 + col * uShoulder);

      // ---- filmic tone curve ----
      col = aces(col);

      // ---- display-referred grade -----------------------------------------
      // Order: split tone -> contrast -> S-curve -> saturation/vibrance ->
      // lift -> gain. Lifting before contrast just gets the lift crushed
      // straight back out again.
      float l = luma(col);
      col *= mix(uShadowTint, uHighTint, smoothstep(uSplitLow, uSplitHigh, l));

      col = (col - uPivot) * uContrast + uPivot;

      /*
        SHADOW ROLLOFF — the mirror of the highlight one below, and there for
        the same reason.

        (x - 0.36) * 1.13 + 0.36 is negative for everything under ACES 0.041,
        and a max(..., 0.0) there throws the ordering away wholesale. Measured
        at wave E, the darkest 5% of every daylight pose sat within 1.1 levels
        of the darkest 1% (p1 29.9 / p5 31.0 on 01-sunset-ridge) — the entire
        shadow end was ONE value, which the lift then raised bodily to 30/255.
        The four Ghost of Tsushima reference frames run p1 0.5-14 against p5
        7-20: a graded toe, several stops of readable structure below the point
        where ours has already collapsed.

        So replace the hard max with a smooth one: 0.5*(x + sqrt(x*x + e)). It
        is monotone over the whole negative range, so the crushed values keep
        their ORDER instead of all landing on the same zero, and it is within a
        rounding error of x once x is a few times sqrt(e) — which means it
        recovers shadow separation without raising the black floor by even one
        8-bit level. Tried the obvious alternative first (an exponential toe
        anchored at a knee) and measured it: it lifted p1 from 29.9 to 42.7 and
        bought 0.8 of a level of spread. This buys the spread and costs nothing.
      */
      float e = uLoKnee * uLoKnee;
      col = 0.5 * (col + sqrt(col * col + e));

      vec3 sc = clamp(col, 0.0, 1.0);
      col = mix(col, sc * sc * (3.0 - 2.0 * sc), uSCurve);

      float g2 = luma(col);
      col = max(mix(vec3(g2), col, uSaturation), 0.0);
      // Vibrance: lift the already-dull colours, leave the saturated ones be.
      // One dominant hue per vista only works if the weak hues come up too.
      float mx = max(col.r, max(col.g, col.b));
      float mn = min(col.r, min(col.g, col.b));
      float sat = (mx - mn) / max(mx, 1e-4);
      col = max(mix(vec3(g2), col, 1.0 + uVibrance * (1.0 - sat)), 0.0);
      // Deep shadows lose chroma on real film; letting them keep it is what
      // makes an ungraded engine frame look like plastic.
      float shd = 1.0 - smoothstep(0.02, 0.30, g2);
      col = mix(col, vec3(g2), shd * uShadowSat);

      // ASC-CDL style lift: raises the black floor, leaves white alone, so the
      // shadows stay dense and readable instead of collapsing to pure black.
      col = uLift + col * (1.0 - uLift);
      /*
        THE TOE — a shaped, chromatic floor. Quadratic falloff that is gone by
        the mid-tones, so it buys shadow density without the flat grey a neutral
        lift would cost. That much was right. Its COLOUR was wrong, and it was
        the single biggest colour error in the game.

        Until wave H this term was blue-violet (golden ran [0.0045, 0.0072,
        0.0270] — six times more blue than red) on the theory that skylight
        bounce is cool. Measured, it did not read as bounce, it read as a floor:
        it is ADDITIVE and the darkest pixels have nothing else in them, so the
        frame's black point WAS this constant. Sampling shadowed vegetation on
        01-sunset-ridge (whole frame, pixels with max(r,g,b)/255 < 0.45, mean
        RGB -> HSV — the same measurement run on the reference frames):

            Ghost of Tsushima field_2   hue  27.8   sat 0.81
            Ghost of Tsushima field_16  hue  27.3   sat 0.73
            ours, wave G                hue 307.3   sat 0.31

        Violet at under half the reference saturation: the wrong end of the
        colour wheel, not a tweak. And the cause was provably HERE and not in
        the light rig — the darkest 1% of every daylight pose measured
        [18, 25, 52], which is toSRGB(toe + lift) to a rounding error, the same
        value on all seven poses because scene light never entered it. Zeroing
        toe and lift with sky.js untouched (shots/h-null) left shadowed
        vegetation at hue 16.1 / 8.6 / 18.0, sat 0.66-0.73: the hemisphere,
        ambient and fill terms were already producing WARM shadows. So this is
        the one place to fix it, and warming the light rig as well would have
        double-corrected.

        Warm amber-brown, then, at the reference's saturation. The rubric's
        "shadows hold cool blue-violet bounce" is about the bounce being cool
        RELATIVE TO A WARM KEY, not about the shadow rendering violet overall —
        the reference proves the net result is warm. The relative cool is still
        here, in uAOTint (0.11, 0.15, 0.26 at golden) and in uShadowTint and
        uLinCool, all of which are multiplicative and all of which survive.
        Measured after: hue 25.3 sat 0.70 on 01, floor [27, 21, 6].
      */
      float toeT = 1.0 - smoothstep(0.0, max(uToe.a, 1e-3), luma(col));
      col += uToe.rgb * toeT * toeT;
      col *= uGain;

      /*
        HIGHLIGHT ROLLOFF — hue- and luminance-preserving, immediately before
        the clamp, which is the only place that can see everything that would
        have been thrown away.

        ACES lands the scene inside [0,1]; the split tone (red x1.12 at golden),
        the contrast ((x - 0.36) * 1.13 + 0.36) and then saturation 1.22 plus
        vibrance push it straight back out again. Measured at wave E, 23.1% of
        03-coast, 16.9% of 05-summit and 15.8% of 01-sunset-ridge had at least
        one channel pinned at 255 — against 0.8-2.8% on the four real Ghost of
        Tsushima reference frames. That is why every distant mountain read as
        one flat cream shape: three values wide, no form in it.

        Isolated per pose, most of that overshoot is CHROMA, not luminance —
        saturation and vibrance expand about luma, so a warm highlight leaves
        the cube on red alone while its luminance is still comfortably under 1.
        Clamping it there does two bad things at once: it flattens the form AND
        it shifts the hue, because only one channel stops.

        So compress the excursion of the max channel through a soft knee and
        pull the whole pixel back toward its own luminance by exactly that
        ratio. Below uHiKnee nothing moves at all — this cannot touch a midtone
        or a shadow. Above it, hue and value survive and only the chroma that
        could not have been displayed is given up.
      */
      if (uHiKnee < 1.0) {
        float L = luma(col);
        float mx = max(col.r, max(col.g, col.b));
        if (mx > uHiKnee && L < 1.0) {
          float hw = 1.0 - uHiKnee;
          float over = mx - uHiKnee;
          float mxT = uHiKnee + hw * (over / (over + hw));   // -> 1.0 asymptote
          col = mix(vec3(L), col, clamp((mxT - L) / max(mx - L, 1e-4), 0.0, 1.0));
        }
      }
      col = clamp(col, 0.0, 1.0);

      // ---- edge desaturation: cheap, and it focuses the eye centre-frame ----
      col = mix(col, vec3(luma(col)), uEdgeDesat * smoothstep(0.40, 1.25, r2));

      col = toSRGB(col);

      // ---- ordered-ish dither, triangular PDF, kills 8-bit banding in skies ----
      float dn = ign(gl_FragCoord.xy) - ign(gl_FragCoord.xy + vec2(37.0, 17.0));
      col += dn * (1.5 / 255.0);

      gl_FragColor = vec4(col, 1.0);
    }`, {
    tComp: { value: null },
    uDistort: { value: -0.05 }, uChroma: { value: 0.0012 }, uEdgeDesat: { value: 0.10 },
    uShadowTint: { value: new THREE.Color(0.88, 0.96, 1.08) },
    uHighTint: { value: new THREE.Color(1.08, 1.0, 0.9) },
    uLift: { value: new THREE.Color(0.012, 0.018, 0.030) },
    uToe: { value: new THREE.Vector4(0, 0, 0, 0.25) },
    uGain: { value: new THREE.Color(1, 1, 1) },
    uContrast: { value: 1.08 }, uSCurve: { value: 0.22 },
    uSaturation: { value: 1.10 }, uVibrance: { value: 0.30 },
    uPivot: { value: 0.36 },
    uSplitLow: { value: 0.06 }, uSplitHigh: { value: 0.60 },
    uShoulder: { value: 0.30 }, uHiDesat: { value: 0.35 }, uShadowSat: { value: 0.22 },
    uHiKnee: { value: 1.0 }, uLoKnee: { value: 0.0 },
    uRes: { value: new THREE.Vector2() },
  });

  // -------------------------------------------------------------------------
  // per-frame grade derivation from time of day
  // -------------------------------------------------------------------------

  /*
    Four named lighting states. Every field is interpolated in RGB between the
    two bracketing states — never in HSL, because a hue lerp from blue shadow
    to orange highlight passes straight through green and turns the world
    swampy. Numbers are tuned against real frames, not guessed.
  */
  const P = {
    day: {
      shadow: [0.92, 0.97, 1.07], high: [1.05, 1.01, 0.95],
      lift: [0.0020, 0.0013, 0.0008], wb: [1.0, 1.0, 1.0],
      toe: [0.0060, 0.0040, 0.0023], toeW: 0.24,
      linCool: [0.90, 0.97, 1.12], linWarm: [1.08, 1.00, 0.90],
      aoTint: [0.20, 0.25, 0.34], bloomTint: [1.0, 0.98, 0.94],
      halation: [1.0, 0.94, 0.86],
      hazeWarm: [1.16, 1.10, 1.02], hazeCool: [0.62, 0.74, 0.99],
      vigTint: [0.90, 0.95, 1.06],
      sat: 1.12, vib: 0.24, contrast: 1.10, scurve: 0.20,
      bloom: 0.085, grain: 0.020, vig: 0.30,
      key: 0.115, evMin: 0.45, evMax: 2.4, hlp: 0.20, hla: 0.0, hiKnee: 0.82, loKnee: 0.0035, glow: 0.45, dust: 0.45,
      hiDesat: 0.26, shoulder: 0.34, shadowSat: 0.18,
      bthresh: 1.15, linSplit: 0.10, gold: 0.06,
      aerK: 0.00065, aerIn: 0.40, aerPow: 14.0, aerMie: 0.04,
      sunSeed: 0.525,
    },
    // The hero state. Sun 4-25 degrees up. Everything is gold, the distance is
    // a bright amber wall rather than grey haze, and the shadows are warm
    // amber-brown with a COOL BOUNCE INSIDE THEM — cool relative to the key,
    // carried by the multiplicative aoTint/shadow/linCool terms, never by the
    // additive toe. See the toe comment in the grade shader for the numbers.
    golden: {
      shadow: [0.84, 0.94, 1.16], high: [1.12, 1.01, 0.86],
      lift: [0.0026, 0.0018, 0.0005], wb: [1.05, 0.995, 0.93],
      toe: [0.0079, 0.0053, 0.0013], toeW: 0.26,
      linCool: [0.74, 0.90, 1.28], linWarm: [1.26, 1.00, 0.66],
      aoTint: [0.11, 0.15, 0.26], bloomTint: [1.0, 0.76, 0.47],
      halation: [1.0, 0.80, 0.58],
      hazeWarm: [1.58, 1.00, 0.54], hazeCool: [0.47, 0.56, 0.92],
      vigTint: [0.82, 0.90, 1.10],
      sat: 1.22, vib: 0.34, contrast: 1.13, scurve: 0.26,
      bloom: 0.20, grain: 0.028, vig: 0.30,
      // key/shoulder measured, not guessed. At 0.138 with a 0.36 shoulder the
      // summit came back with 29.7% of the FRAME holding the red channel pinned
      // at 255 and the zenith reading (255,235,176): every highlight above ACES
      // ~0.75 was being carried over 1.0 by the split tone (1.12 red) and the
      // contrast (x-0.36)*1.13. Pulling the key 7% and widening the shoulder
      // holds the brightest air near 245 instead of 255, which is the whole
      // difference between "highlight structure" and "white paper".
      key: 0.128, evMin: 0.56, evMax: 3.0, hlp: 0.16, hla: 0.0, hiKnee: 0.80, loKnee: 0.0040, glow: 1.0, dust: 1.0,
      hiDesat: 0.12, shoulder: 0.52, shadowSat: 0.24,
      bthresh: 0.80, linSplit: 0.05, gold: 0.36,
      aerK: 0.00105, aerIn: 0.56, aerPow: 9.0, aerMie: 0.11,
      sunSeed: 0.385,
    },
    // Sun on or just under the horizon. Deeper, more crimson, shadows a denser
    // umber. Bloom is at its widest because the key is pointing at the lens.
    dusk: {
      shadow: [0.80, 0.92, 1.20], high: [1.16, 0.99, 0.80],
      lift: [0.0029, 0.0020, 0.0005], wb: [1.04, 0.985, 0.955],
      toe: [0.0086, 0.0060, 0.0015], toeW: 0.26,
      linCool: [0.68, 0.85, 1.34], linWarm: [1.32, 0.96, 0.56],
      aoTint: [0.09, 0.12, 0.24], bloomTint: [1.0, 0.58, 0.33],
      halation: [1.0, 0.68, 0.44],
      hazeWarm: [1.74, 0.84, 0.42], hazeCool: [0.38, 0.47, 0.86],
      vigTint: [0.78, 0.87, 1.14],
      sat: 1.24, vib: 0.36, contrast: 1.11, scurve: 0.24,
      bloom: 0.26, grain: 0.034, vig: 0.34,
      key: 0.118, evMin: 0.58, evMax: 3.4, hlp: 0.12, hla: 0.0, hiKnee: 0.80, loKnee: 0.0040, glow: 1.0, dust: 1.0,
      hiDesat: 0.08, shoulder: 0.56, shadowSat: 0.26,
      bthresh: 0.66, linSplit: 0.04, gold: 0.32,
      aerK: 0.00128, aerIn: 0.60, aerPow: 6.5, aerMie: 0.15,
      sunSeed: 0.294,
    },
    // Moonlight: low key, heavy blue, chroma mostly gone, grain up. The frame
    // must still read as a landscape at midnight, never as a black rectangle.
    // This is the ONE state whose toe and lift stay cool, and they were left
    // exactly as they were at wave G: a blue cast is correct under a moon, and
    // 08-night sits at sun altitude -89, which blends to pure night (t = 0), so
    // nothing above reaches it.
    night: {
      shadow: [0.80, 0.90, 1.22], high: [0.86, 0.94, 1.14],
      lift: [0.0050, 0.0080, 0.0150], wb: [0.90, 0.96, 1.16],
      toe: [0.0036, 0.0072, 0.0234], toeW: 0.22,
      linCool: [0.70, 0.86, 1.34], linWarm: [0.86, 0.96, 1.20],
      aoTint: [0.07, 0.10, 0.20], bloomTint: [0.62, 0.79, 1.10],
      halation: [0.80, 0.90, 1.10],
      hazeWarm: [0.11, 0.15, 0.26], hazeCool: [0.06, 0.08, 0.17],
      vigTint: [0.80, 0.88, 1.12],
      sat: 0.72, vib: 0.16, contrast: 1.06, scurve: 0.16,
      bloom: 0.16, grain: 0.055, vig: 0.40,
      /*
        THIS is the number that made night look like day. Auto-exposure drives
        the frame's log-average TO `key`, so a key of 0.062 says "midnight
        should meter 2.2x darker than golden hour" — and 2.2 stops is nothing.
        Measured, it produced ground L=82, sky L=81 and cloak L=87: one value,
        the same blue-violet saturation on all three, a daytime render with a
        filter over it. 0.026 is roughly five stops under golden, which is what
        lets the moon read as the only key and the field fall away from it.
        evMax comes down with it — a 12x ceiling exists to rescue a frame that
        is genuinely black, and it will happily undo the whole thing.
      */
      key: 0.026, evMin: 0.45, evMax: 5.0, hlp: 0.020, hla: 0.0, hiKnee: 0.86, loKnee: 0.0030, glow: 0.0, dust: 0.0,
      hiDesat: 0.34, shoulder: 0.50, shadowSat: 0.34,
      bthresh: 0.22, linSplit: 0.03, gold: 0.0,
      aerK: 0.00075, aerIn: 0.34, aerPow: 18.0, aerMie: 0.02,
      sunSeed: 0.07,
    },
  };

  const G = {
    shadow: [0, 0, 0], high: [0, 0, 0], lift: [0, 0, 0], wb: [0, 0, 0],
    toe: [0, 0, 0], toeW: 0.25,
    aoTint: [0, 0, 0], bloomTint: [0, 0, 0], linCool: [0, 0, 0], linWarm: [0, 0, 0],
    halation: [0, 0, 0], hazeWarm: [0, 0, 0], hazeCool: [0, 0, 0], vigTint: [0, 0, 0],
    sat: 1, vib: 0.3, contrast: 1, scurve: 0.2, bloom: 0.1, grain: 0.03, vig: 0.35,
    key: 0.12, evMin: 0.5, evMax: 3, hlp: 0.15, hla: 0.0, hiKnee: 0.82, loKnee: 0.0035, glow: 0.5, dust: 0.5,
    hiDesat: 0.2, shoulder: 0.3, shadowSat: 0.2,
    bthresh: 1.0, linSplit: 0.06, gold: 0.2,
    aerK: 0.0012, aerIn: 0.55, aerPow: 8, aerMie: 0.12,
    sunSeed: 0.5,
  };
  const KEYS_C = ['shadow', 'high', 'lift', 'toe', 'wb', 'aoTint', 'bloomTint', 'linCool',
    'linWarm', 'halation', 'hazeWarm', 'hazeCool', 'vigTint'];
  const KEYS_F = ['sat', 'toeW', 'vib', 'contrast', 'scurve', 'bloom', 'grain', 'vig',
    'key', 'evMin', 'evMax', 'hla', 'hlp', 'hiKnee', 'loKnee', 'glow', 'dust', 'hiDesat', 'shoulder', 'shadowSat',
    'bthresh', 'linSplit', 'gold', 'aerK', 'aerIn', 'aerPow', 'aerMie', 'sunSeed'];

  function blendInto(out, a, b, t) {
    for (const k of KEYS_C) {
      for (let i = 0; i < 3; i++) out[k][i] = lerp(a[k][i], b[k][i], t);
    }
    for (const k of KEYS_F) out[k] = lerp(a[k], b[k], t);
  }

  function deriveGrade() {
    const alt = ctx.tod ? ctx.tod.sunAltitude : 20;   // degrees
    /*
      Band boundaries are keyed on real sun altitude, not on tod.t, so this
      stays correct whatever the lighting lanes decide a given t means.

      Golden holds all the way to 26deg and only then starts giving way to the
      neutral day grade. An earlier version began crossfading at 10deg, which is
      why the forest pose came back reading as flat midday.

      /!\ The claim that used to sit here — "the judged poses sit at altitude
      9deg, 13deg, 18deg and 24deg, all four of those are golden hour" — was
      FALSE and it misdirected wave after wave of grade tuning. Measured from
      tools/poses.json through time.js, no daylit pose exceeds 8.02deg, and
      because ss() below is a real smoothstep the blend lands mostly on DUSK:

        01-sunset-ridge  3.05deg   14.4% golden / 85.6% dusk
        02-grass-field   5.99deg   77.2% golden / 22.8% dusk
        03-coast         1.98deg    1.5% golden / 98.5% dusk
        04-river-valley  8.02deg    100% golden
        05-summit        4.01deg   33.3% golden / 66.7% dusk
        06-forest        7.06deg   94.3% golden /  5.7% dusk
        07-run           5.09deg   57.7% golden / 42.3% dusk
        08-night       -89.29deg    100% night

      So P.golden does NOT govern the hero shot; P.dusk does, by six to one. A
      lane that tunes only P.golden and sees the hero pose barely move has run a
      null TEST, not found a null result. P.dusk is also more aggressive on
      every aerial parameter (hazeWarm R 1.74 vs 1.58, aerIn 0.60 vs 0.56,
      aerMie 0.15 vs 0.11), so far-field defects are worse than the golden
      numbers suggest. Prefer fixing aerial maths in the shader, which is
      grade-state independent, over retuning this table.
    */
    if (alt >= 26) {
      blendInto(G, P.golden, P.day, ss(alt, 26, 52));
    } else if (alt >= 1.5) {
      blendInto(G, P.dusk, P.golden, ss(alt, 1.5, 8.0));
    } else {
      // The sky stays lit well past geometric sunset; dusk has to hold on much
      // longer than -4 degrees or every twilight pose reads as midnight.
      blendInto(G, P.night, P.dusk, ss(alt, -34, -9));
    }
    return alt;
  }

  // -------------------------------------------------------------------------
  // frame
  // -------------------------------------------------------------------------

  const texel = new THREE.Vector2();
  const sunWorld = new THREE.Vector3();
  const sunNDC = new THREE.Vector3();
  const sunDirView = new THREE.Vector3(0, 0, -1);
  const camDir = new THREE.Vector3();
  const tmpCol = new THREE.Color();
  const expo = new THREE.Vector3();
  let time = 0;
  // telemetry — see the `meter` getter. Written every frame, costs two stores.
  const tel = { alt: 0, sunU: 0, sunV: 0, facing: 0, altGate: 0, faceGate: 0,
                edgeFade: 0, sunStrength: 0, rendererExposure: 1 };
  let pending = true;
  let passPending = false;
  let lumTick = 999, lumAccum = 0;     // eye-adaptation cadence
  let adaptTex = null;

  function syncSize() {
    renderer.getDrawingBufferSize(size);
    const w = Math.max(2, size.x | 0), h = Math.max(2, size.y | 0);
    if (w !== W || h !== H || pending) {
      allocate(w, h); pending = false; passPending = false; adaptTex = null;
    } else if (passPending) {
      allocatePasses(W, H); passPending = false;
    }
  }

  addEventListener('resize', () => { pending = true; });

  // Recompile the three shaders whose loop bounds are compile-time constants,
  // and re-cut the render targets whose size comes out of params.perf.
  function applyPerf(patch) {
    if (patch) Object.assign(params.perf, patch);
    aoMat.fragmentShader = aoSrc(clamp(params.perf.aoSamples | 0, 3, 24));
    aoMat.needsUpdate = true;
    aoBlur.fragmentShader = aoBlurSrc(clamp(params.perf.aoBlurTaps | 0, 1, 5));
    aoBlur.needsUpdate = true;
    dofMat.fragmentShader = dofSrc(clamp(params.perf.dofTaps | 0, 4, 24));
    dofMat.needsUpdate = true;
    sunBlur.fragmentShader = sunBlurSrc(clamp(params.perf.sunSteps | 0, 6, 48));
    sunBlur.needsUpdate = true;
    pending = true;
  }

  /*
    Adaptive guard. Frame times are noisy, so this walks a single scale factor
    through three steps with wide hysteresis and a 1.5 s dwell — it must never
    be able to oscillate, because every step costs a render-target realloc.
    It only touches AO / DOF / godray resolution.
  */
  const DYN_STEPS = [1.0, 0.8, 0.66];
  let dynIdx = 0, dynHold = 0, frameEMA = 1 / 60;
  function adaptStep(dt) {
    const P = params.perf;
    if (!P.adapt) { if (dynIdx !== 0) { dynIdx = 0; dynScale = 1; passPending = true; } return; }
    frameEMA += (Math.min(dt, 0.25) - frameEMA) * 0.05;
    const fps = 1 / Math.max(frameEMA, 1e-4);
    dynHold -= dt;
    if (dynHold > 0) return;
    let next = dynIdx;
    if (fps < P.floorFps) next = Math.min(DYN_STEPS.length - 1, dynIdx + 1);
    else if (fps > P.ceilFps) next = Math.max(0, dynIdx - 1);
    if (next !== dynIdx) {
      dynIdx = next;
      dynScale = Math.max(P.minScale, DYN_STEPS[dynIdx]);
      passPending = true;
      dynHold = 1.5;
    }
  }

  allocate(W, H);
  pending = false;

  function render(dt) {
    if (!params.enabled) {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      return;
    }
    adaptStep(dt);
    syncSize();
    time += dt;

    if (renderer.toneMapping !== THREE.NoToneMapping) {
      renderer.toneMapping = THREE.NoToneMapping;
    }

    const alt = deriveGrade();
    const rendererExposure = renderer.toneMappingExposure || 1.0;
    const q = params.quality;
    // A pass whose contribution is zero is not run at all — no draw, no target
    // bind, no full-res fetch in the composite. Bloom and AO are the two that
    // combat.js drives to zero, and godrays are zero for the whole night half
    // of the day cycle.
    const bloomAmt = G.bloom * params.bloom.strength;
    const useBloom = bloomAmt > 1e-4;
    const useAO = q >= 0.75 && params.ao.strength > 1e-3;
    const useDOF = params.dof.enabled && q >= 0.5 && params.dof.maxCoC > 1e-3;

    // ---- 1. scene ----
    renderer.setRenderTarget(rtScene);
    renderer.render(scene, camera);

    const projInv = camera.projectionMatrixInverse;
    const nf = { x: camera.near, y: camera.far };

    // ---- 2. auto exposure ----
    // The eye adapts over ~0.4 s, so metering it at full frame rate is six
    // draws and six target binds a frame spent on a value that barely moves.
    // Run it every params.perf.lumEvery frames and hand the accumulated dt to
    // the adaptation rate, which keeps the time constant exactly the same.
    lumAccum += dt;
    if (++lumTick >= Math.max(1, params.perf.lumEvery | 0) || !adaptTex) {
      lumTick = 0;
      lumPre.uniforms.tSrc.value = rtScene.texture;
      lumPre.uniforms.uTexel.value.set(1 / W, 1 / H);
      draw(lumPre, lumChain[0]);
      for (let i = 1; i < lumChain.length; i++) {
        lumDown.uniforms.tSrc.value = lumChain[i - 1].texture;
        lumDown.uniforms.uTexel.value.set(1 / lumChain[i - 1].width, 1 / lumChain[i - 1].height);
        draw(lumDown, lumChain[i]);
      }
      const prev = adapt[adaptPing], next = adapt[1 - adaptPing];
      adaptMat.uniforms.tLum.value = lumChain[lumChain.length - 1].texture;
      adaptMat.uniforms.tPrev.value = prev.texture;
      adaptMat.uniforms.uRate.value =
        1 - Math.exp(-Math.max(lumAccum, 1e-4) * params.exposure.adaptSpeed);
      adaptMat.uniforms.uHLProtect.value = G.hlp;
      adaptMat.uniforms.uHLArea.value = G.hla * params.exposure.areaMul;
      draw(adaptMat, next);
      adaptPing = 1 - adaptPing;
      adaptTex = next.texture;
      lumAccum = 0;
    }

    expo.set(G.key * params.exposure.keyMul,
             G.evMin * params.exposure.minMul,
             G.evMax * params.exposure.maxMul);
    const expoMul = params.exposure.comp * rendererExposure;
    const knee = clamp(params.exposure.knee, 0, 1);

    // ---- 3. SSAO ----
    if (useAO) {
      const hw = aoA.width, hh = aoA.height;
      aoMat.uniforms.tDepth.value = depthTex;
      aoMat.uniforms.uProjInv.value.copy(projInv);
      aoMat.uniforms.uProj.value.copy(camera.projectionMatrix);
      aoMat.uniforms.uCamNF.value.set(nf.x, nf.y);
      aoMat.uniforms.uRes.value.set(hw, hh);
      aoMat.uniforms.uRadius.value = params.ao.radius;
      aoMat.uniforms.uBias.value = params.ao.bias;
      aoMat.uniforms.uPower.value = params.ao.power;
      aoMat.uniforms.uMaxDist.value = params.ao.maxDist;
      draw(aoMat, aoA);

      aoBlur.uniforms.tAO.value = aoA.texture;
      aoBlur.uniforms.uDir.value.set(1 / hw, 0);
      draw(aoBlur, aoB);
      aoBlur.uniforms.tAO.value = aoB.texture;
      aoBlur.uniforms.uDir.value.set(0, 1 / hh);
      draw(aoBlur, aoA);
    }

    // ---- 4. bloom ----
    const last = bloomDown.length - 1;
    if (useBloom) {
      bloomPre.uniforms.tSrc.value = rtScene.texture;
      bloomPre.uniforms.uTexel.value.set(1 / W, 1 / H);
      bloomPre.uniforms.uThreshold.value = G.bthresh * params.bloom.threshold;
      bloomPre.uniforms.uKnee.value = params.bloom.knee;
      bloomPre.uniforms.tAdapt.value = adaptTex;
      bloomPre.uniforms.uExposure.value.copy(expo);
      bloomPre.uniforms.uExposureMul.value = expoMul;
      bloomPre.uniforms.uExposureKnee.value = knee;
      draw(bloomPre, bloomDown[0]);
      for (let i = 1; i < bloomDown.length; i++) {
        const src = bloomDown[i - 1];
        bloomDownMat.uniforms.tSrc.value = src.texture;
        bloomDownMat.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
        draw(bloomDownMat, bloomDown[i]);
      }
      bloomUpMat.uniforms.uScatter.value = params.bloom.scatter;
      for (let i = last - 1; i >= 0; i--) {
        const small = (i === last - 1) ? bloomDown[last] : bloomUp[i + 1];
        // Halation is strongest on the widest levels and gone by the tight ones.
        const hw2 = params.bloom.halation * (i / Math.max(1, last - 1));
        bloomUpMat.uniforms.uHalation.value.set(
          lerp(1, G.halation[0], hw2), lerp(1, G.halation[1], hw2), lerp(1, G.halation[2], hw2));
        bloomUpMat.uniforms.tSmall.value = small.texture;
        bloomUpMat.uniforms.tBig.value = bloomDown[i].texture;
        // bloomTent carries the fractional pyramid level that the integer
        // level count had to drop, so the bloom's reach stays the same
        // fraction of the frame at every resolution.
        bloomUpMat.uniforms.uTexel.value.set(
          bloomTent / small.width, bloomTent / small.height);
        draw(bloomUpMat, bloomUp[i]);
      }
    }

    // ---- 5. godrays ----
    let sunStrength = 0;
    if (ctx.sky && ctx.sky.sunPos) {
      /*
        Sun direction in view space drives the aerial scatter lobe AND the glare
        core. It used to be recomputed at the BOTTOM of this block, i.e. one
        frame stale by the time anything read it — harmless for a slow haze
        term, not harmless for a two-degree-wide core that has to sit exactly on
        the disc. Derived first now, so the seed pass, the composite and the
        shaft origin all agree within the same frame.
      */
      sunDirView.copy(ctx.sky.sunPos).transformDirection(camera.matrixWorldInverse);
      if (ctx.sky.sun) {
        tmpCol.copy(ctx.sky.sun.color);
        // push the shaft colour a touch warmer and brighter than the key
        compMat.uniforms.uSunTint.value.setRGB(
          Math.min(1.8, tmpCol.r * 1.30 + 0.20),
          Math.min(1.5, tmpCol.g * 1.05 + 0.10),
          Math.min(1.2, tmpCol.b * 0.82 + 0.04));
      }
      const gl = params.sunGlow;
      compMat.uniforms.uSunGlow.value.set(
        gl.strength * G.glow, gl.corePower, gl.skirtPower, gl.skirtMix);
      compMat.uniforms.uSunOcclude.value = clamp(gl.occlude ?? 1, 0, 1);

      camera.getWorldDirection(camDir);
      const facing = camDir.dot(ctx.sky.sunPos);
      // shafts survive a little below the horizon: that glow is still the sun
      const altGate = ss(alt, -11, 3);
      const faceGate = ss(facing, -0.05, 0.45);
      sunStrength = params.godrays.strength * altGate * faceGate;
      tel.facing = facing; tel.altGate = altGate; tel.faceGate = faceGate;
      tel.alt = alt; tel.edgeFade = 0;
      if (sunStrength > 0.002) {
        sunWorld.copy(ctx.sky.sunPos).multiplyScalar(3000).add(camera.position);
        sunNDC.copy(sunWorld).project(camera);
        const su = sunNDC.x * 0.5 + 0.5, sv = sunNDC.y * 0.5 + 0.5;
        // fade as the sun leaves the frame so shafts never pop
        const edge = Math.max(Math.abs(su - 0.5), Math.abs(sv - 0.5));
        sunStrength *= 1 - ss(edge, 0.55, 1.35);
        tel.sunU = su; tel.sunV = sv; tel.edgeFade = 1 - ss(edge, 0.55, 1.35);

        sunOcc.uniforms.tSrc.value = rtScene.texture;
        sunOcc.uniforms.tDepth.value = depthTex;
        sunOcc.uniforms.uProjInv.value.copy(projInv);
        sunOcc.uniforms.uCamNF.value.set(nf.x, nf.y);
        sunOcc.uniforms.uFar.value = nf.y;
        sunOcc.uniforms.uSeed.value = G.sunSeed * params.godrays.seedMul;
        sunOcc.uniforms.uOccSharp.value = clamp(params.godrays.occlusionSharp ?? 1, 0, 1);
        sunOcc.uniforms.uSunDirView.value.copy(sunDirView);
        sunOcc.uniforms.uSunGlow.value.copy(compMat.uniforms.uSunGlow.value);
        sunOcc.uniforms.uSunTint.value.copy(compMat.uniforms.uSunTint.value);
        sunOcc.uniforms.tAdapt.value = adaptTex;
        sunOcc.uniforms.uExposure.value.copy(expo);
        sunOcc.uniforms.uExposureMul.value = expoMul;
        sunOcc.uniforms.uExposureKnee.value = knee;
        draw(sunOcc, sunA);

        sunBlur.uniforms.tSrc.value = sunA.texture;
        sunBlur.uniforms.uSunUV.value.set(su, sv);
        sunBlur.uniforms.uDensity.value = params.godrays.density;
        // params.godrays.decay is tuned per step at REF_SUN_STEPS. Re-derive it
        // for the actual step count so cutting steps changes the cost and not
        // the length or the brightness of the shafts.
        sunBlur.uniforms.uDecay.value = Math.pow(
          params.godrays.decay, REF_SUN_STEPS / Math.max(1, params.perf.sunSteps));
        sunBlur.uniforms.uWeight.value = params.godrays.weight;
        // time is wrapped before it reaches the drift phase: an hour of play
        // would otherwise push the argument of sin() past where a 32-bit float
        // can still resolve a cycle, and the beams would start to crawl.
        sunBlur.uniforms.uDust.value.set(
          clamp(params.godrays.dust * G.dust, 0, 1),
          (time % 1024) * params.godrays.dustDrift, W / H);
        draw(sunBlur, sunB);
      } else {
        sunStrength = 0;
      }
    } else {
      compMat.uniforms.uSunGlow.value.x = 0;
    }

    // ---- 6. depth of field ----
    let dofMix = 0;
    if (useDOF) {
      let focusDist = 12;
      if (ctx.player && ctx.player.position) {
        focusDist = camera.position.distanceTo(ctx.player.position);
      }
      // Focus plane sits on the character; everything nearer than ~3x that
      // distance stays sharp so the foreground grass never turns to soup.
      const nearEdge = Math.max(params.dof.near, focusDist * 3.0 + 18);
      dofMat.uniforms.tSrc.value = rtScene.texture;
      dofMat.uniforms.tDepth.value = depthTex;
      dofMat.uniforms.uProjInv.value.copy(projInv);
      dofMat.uniforms.uCamNF.value.set(nf.x, nf.y);
      // blurPx is quoted at the 1080p half-res grid this was tuned on. Convert
      // once, here, into a fraction of the frame — aspect-corrected so the
      // bokeh stays circular — and the look no longer moves with the window.
      const k = params.dof.blurPx / (REF_H * 0.5);
      dofMat.uniforms.uBlurUV.value.set(k * (H / W), k);
      dofMat.uniforms.uFocus.value.set(nearEdge, params.dof.range, params.dof.maxCoC);
      draw(dofMat, dofRT);
      dofMix = 1;
    }

    // ---- 7. composite ----
    const u = compMat.uniforms;
    u.tScene.value = rtScene.texture;
    // A skipped pass is bound to a 1x1 neutral rather than left pointing at a
    // stale target — the shader branches it out, and if a branch is ever
    // removed the frame degrades to "no contribution", not "last second's AO".
    u.tBloom.value = useBloom ? (last > 0 ? bloomUp[0] : bloomDown[0]).texture : BLACK1;
    u.tAO.value = useAO ? aoA.texture : WHITE1;
    u.tDOF.value = useDOF ? dofRT.texture : BLACK1;
    u.tSun.value = sunStrength > 0 ? sunB.texture : BLACK1;
    u.tDepth.value = depthTex;
    u.uProjInv.value.copy(projInv);
    u.uCamNF.value.set(nf.x, nf.y);
    u.uFar.value = nf.y;
    u.tAdapt.value = adaptTex;
    u.uExposure.value.copy(expo);
    u.uExposureMul.value = expoMul;
    u.uExposureKnee.value = knee;
    setCol(u.uBloomTint.value, G.bloomTint);
    u.uBloomStrength.value = useBloom ? bloomAmt : 0.0;
    u.uAOStrength.value = useAO ? params.ao.strength * 0.9 : 0.0;
    setCol(u.uAOTint.value, G.aoTint);
    u.uSunStrength.value = sunStrength;
    u.uSunSky.value = clamp(params.godrays.skyMix ?? 0.45, 0, 1);
    u.uSunHeadroom.value = Math.max(0, params.godrays.headroom ?? 0);
    tel.sunStrength = sunStrength;
    tel.rendererExposure = rendererExposure;
    // uSunTint and uSunGlow are written in step 5, which needs them a pass early.
    u.uSunDirView.value.copy(sunDirView);
    u.uAerial.value.set(
      G.aerK, G.aerIn * params.aerial.strength, G.aerPow, G.aerMie * params.aerial.strength);
    /*
      Mirror the live dome radiance into the composite so the aerial pass can
      converge far land onto the sky it actually sits against. createSky()
      already returns its uniforms object, so this reads the exact values the
      dome drew with THIS frame and world/sky.js needs no change at all —
      nothing is re-derived, re-tuned or duplicated on this side.
    */
    const su = ctx.sky && ctx.sky.uniforms;
    if (su) {
      u.uSkyZen.value.copy(su.uZen.value);
      u.uSkyMid.value.copy(su.uMid.value);
      u.uSkyHor.value.copy(su.uHor.value);
      u.uSkyHorOpp.value.copy(su.uHorOpp.value);
      u.uSkyBelt.value.copy(su.uBelt.value);
      u.uSkyHaze.value.copy(su.uHaze.value);
      u.uSkyHalo.value.copy(su.uHalo.value);
      u.uSkyMisc.value.set(
        su.uWarmGlow.value, su.uBeltAmt.value, su.uSunUp.value);
      u.uSkySunXZ.value.copy(su.uSunXZ.value);
    }
    // The dome works in world space and the composite reconstructs rays in view
    // space, so the airlight lookup needs the camera's rotation. No scale on a
    // camera, so the upper 3x3 of matrixWorld is already orthonormal.
    u.uViewToWorld.value.setFromMatrix4(camera.matrixWorld);
    u.uAirConverge.value = params.aerial.maxConverge;
    setCol(u.uHazeWarm.value, G.hazeWarm);
    setCol(u.uHazeCool.value, G.hazeCool);
    setCol(u.uVigTint.value, G.vigTint);
    u.uDofMix.value = dofMix;
    u.uGoldPush.value = G.gold * params.grade.gold;
    setCol(u.uWhiteBalance.value, G.wb);
    setCol(u.uLinCool.value, G.linCool);
    setCol(u.uLinWarm.value, G.linWarm);
    u.uLinSplit.value.set(G.linSplit, G.linSplit * 14.0 + 0.2);
    u.uGrain.value = G.grain * params.grain.amount;
    u.uGrainSize.value = params.grain.size * (H / 1080);
    u.uTime.value = time;
    u.uVignette.value.set(
      G.vig * params.vignette.amount, params.vignette.start, params.vignette.end);
    u.uRes.value.set(W, H);
    draw(compMat, rtComp);

    // ---- 8. grade to screen ----
    const g = gradeMat.uniforms;
    g.tComp.value = rtComp.texture;
    g.uDistort.value = params.lens.distortion;
    g.uChroma.value = 0.0012 * params.lens.chroma;
    g.uEdgeDesat.value = 0.10 * params.lens.edgeDesat;
    const st = params.grade.splitTone;
    g.uShadowTint.value.setRGB(lerp(1, G.shadow[0], st), lerp(1, G.shadow[1], st), lerp(1, G.shadow[2], st));
    g.uHighTint.value.setRGB(lerp(1, G.high[0], st), lerp(1, G.high[1], st), lerp(1, G.high[2], st));
    g.uLift.value.setRGB(
      G.lift[0] * params.grade.lift, G.lift[1] * params.grade.lift, G.lift[2] * params.grade.lift);
    const tw = params.grade.toe;
    g.uToe.value.set(G.toe[0] * tw, G.toe[1] * tw, G.toe[2] * tw, G.toeW);
    g.uContrast.value = 1 + (G.contrast - 1) * params.grade.contrast;
    g.uSCurve.value = G.scurve * params.grade.contrast;
    g.uSaturation.value = 1 + (G.sat - 1) * params.grade.saturation;
    g.uVibrance.value = G.vib * params.grade.saturation;
    g.uHiDesat.value = G.hiDesat;
    g.uShoulder.value = G.shoulder;
    g.uShadowSat.value = G.shadowSat * params.grade.shadowSat;
    g.uHiKnee.value = clamp(G.hiKnee * params.grade.hiKnee, 0.2, 1.0);
    g.uLoKnee.value = clamp(G.loKnee * params.grade.loKnee, 0.0, 0.05);
    g.uRes.value.set(W, H);
    draw(gradeMat, null);

    renderer.setRenderTarget(null);
  }

  void texel;

  return {
    params,
    render,
    // handy for other systems / debugging
    get grade() { return G; },
    get sceneTarget() { return rtScene; },
    get depthTexture() { return depthTex; },
    // What the frame is actually costing right now, for profiling harnesses.
    get budget() {
      return {
        w: W, h: H, dynScale, bloomLevels: bloomDown.length, bloomTent,
        ao: aoA ? [aoA.width, aoA.height] : null,
        dof: dofRT ? [dofRT.width, dofRT.height] : null,
        sun: sunA ? [sunA.width, sunA.height] : null,
        fps: 1 / Math.max(frameEMA, 1e-4),
      };
    },
    /*
      Live metering state, for the capture harness. Reading the 1x1 adaptation
      target is a GPU sync, so this is a METHOD and never called from render().
      It exists because "auto-exposure is dead" is a claim that has to be
      measured on the running build, not inferred from the shader source.
    */
    meter() {
      const half = new Uint16Array(4);
      let avg = null, areaMean = null, geoMean = null;
      const h2f = (h) => {
        const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
        return e === 0 ? s * Math.pow(2, -14) * (f / 1024)
             : e === 31 ? NaN
             : s * Math.pow(2, e - 15) * (1 + f / 1024);
      };
      try {
        renderer.readRenderTargetPixels(adapt[adaptPing], 0, 0, 1, 1, half);
        avg = h2f(half[0]); areaMean = h2f(half[1]); geoMean = h2f(half[2]);
      } catch (err) { avg = null; }
      const mul = params.exposure.comp * tel.rendererExposure;
      const key = G.key * params.exposure.keyMul;
      const evMin = G.evMin * params.exposure.minMul;
      const evMax = G.evMax * params.exposure.maxMul;
      const want = avg ? key / avg : null;
      const knee = params.exposure.knee;
      return { avg, areaMean, geoMean, key, evMin, evMax, want, mul, knee,
               ev: want == null ? null : evCurve(want, evMin, evMax, knee) * mul,
               ...tel };
    },
    setQuality(v) { params.quality = clamp(v, 0, 1); },
    // Change any of params.perf and have the shaders and targets follow.
    setPerf(obj) { applyPerf(obj); },
    tune(obj) { Object.assign(params, obj); },
    dispose() {
      disposeAll(); quad.dispose();
      BLACK1.dispose(); WHITE1.dispose();
    },
    update() { /* postfx runs from render(), not the system list */ },
  };
}
