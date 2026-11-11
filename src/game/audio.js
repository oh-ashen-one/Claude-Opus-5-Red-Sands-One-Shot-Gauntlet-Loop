// =============================================================================
//  KAZE NO MICHI — sound
//
//  OWNER: audio lane. Everything below is synthesised at runtime with WebAudio.
//  There is not one sample, one impulse-response file or one external asset in
//  this module: the noise beds, the convolution reverb, the birds, the steel,
//  the flute and the drums are all built from oscillators, filtered noise and
//  scheduled envelopes.
//
//  Layout of the file
//    1.  small maths + deterministic RNG
//    2.  buffer factories       — noise, procedural impulse response
//    3.  the rig                — master chain, buses, reverb, spatial helper
//    4.  voice builder          — node bookkeeping so one-shots clean themselves up
//    5.  sfx synths             — footsteps, steel, cloth, wildlife, bamboo, waves
//    6.  instruments            — shakuhachi, koto, biwa, taiko, drone
//    7.  ambience beds          — wind (tracks ctx.wind), ocean, grass
//    8.  the adaptive score     — hirajoshi / in-sen sequencer, three tiers
//    9.  createAudio(ctx)       — the public interface + the offline renderer
//
//  INTERFACE (engine contract):
//    createAudio(ctx) -> { start(), update(dt, ctx), setIntensity(v), play(name, opts) }
//  Extras other lanes may call:
//    setIntensity('explore'|'tension'|'combat'|0..1)
//    play('whoosh'|'whoosh_heavy'|'clash'|'impact'|'sheathe'|'draw'|'parry_spark'|
//         'footstep'|'bamboo'|'bird'|'owl'|'frog'|'insect'|'wave'|'gust'|'rattle'|
//         'leather'|'tsuba'|'rin'|'cloth'|'koto'|'flute'|'taiko',
//         { x, y, z, gain, surface, delay })
//    ctx.audioEvents = [{ name, x, y, z, gain }]   drained every frame
//    renderOffline(opts) -> Promise<AudioBuffer>   used by tools/audio-render.sh
//
//  Nothing here allocates an AudioContext until start() is called from a user
//  gesture, so the headless screenshot harness stays silent and costs nothing.
// =============================================================================

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth01 = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };
// exponentialRampToValueAtTime can never touch zero; this is the floor everywhere.
const EPS = 1e-4;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// -----------------------------------------------------------------------------
//  2. buffers
// -----------------------------------------------------------------------------

// White noise. One mono buffer shared by every bright noise voice in the game.
// Sources are cheap, buffers are not; voices decorrelate by reading it at
// different offsets and playback rates. No loop crossfade is needed because
// adjacent samples of white noise are already uncorrelated — a wrap is just
// another sample.
function whiteNoise(ac, seconds, rng) {
  const n = Math.floor(ac.sampleRate * seconds);
  const buf = ac.createBuffer(1, n, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = rng() * 2 - 1;
  return buf;
}

// Pink noise via Paul Kellet's economy filter. Wind and surf are pink in
// nature; white noise on its own reads as a hi-hat, not as air. Pink noise IS
// correlated sample to sample, so the loop point gets a real crossfade or it
// ticks once per pass.
function pinkNoise(ac, seconds, rng) {
  const n = Math.floor(ac.sampleRate * seconds);
  const fade = Math.floor(ac.sampleRate * 0.08);
  const raw = new Float32Array(n + fade);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < raw.length; i++) {
    const w = rng() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    raw[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  const buf = ac.createBuffer(1, n, ac.sampleRate);
  const d = buf.getChannelData(0);
  // The head is crossfaded with what continues past the end, so playing
  // [0..n) on repeat is continuous at the seam.
  for (let i = 0; i < n; i++) {
    if (i < fade) { const t = i / fade; d[i] = raw[i] * t + raw[n + i] * (1 - t); }
    else d[i] = raw[i];
  }
  return buf;
}

// A procedurally generated stereo impulse response: a wide, dark, mid-sized
// valley. Early reflections come from explicit sparse taps — that is what makes
// a space read as a *place* — and the tail is exponentially decaying noise
// pushed through a one-pole lowpass whose cutoff falls with time, so highs die
// first exactly as they do in air. Left and right are generated from
// independent noise, which is where the width comes from.
function valleyIR(ac, rng, {
  seconds = 2.6, rt = 3.4, preDelay = 0.014, damp = 1.0, taps = 18,
} = {}) {
  const sr = ac.sampleRate;
  const n = Math.floor(sr * seconds);
  const buf = ac.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const pd = Math.floor(preDelay * sr * (ch ? 1.11 : 1.0));

    // --- early reflections: discrete, decaying, alternating sign ---
    for (let k = 0; k < taps; k++) {
      const tt = 0.004 + Math.pow(k / taps, 1.5) * 0.115 + rng() * 0.006;
      const idx = pd + Math.floor(tt * sr);
      if (idx >= n) continue;
      const amp = (0.62 / (1 + k * 0.85)) * (rng() < 0.5 ? -1 : 1);
      d[idx] += amp;
      // a short smear, so the tap is a reflection off a hillside, not a click
      for (let s = 1; s < 40 && idx + s < n; s++) d[idx + s] += amp * Math.exp(-s * 0.16) * 0.35;
    }

    // --- late diffuse tail ---
    let lp = 0, hp = 0;
    for (let i = pd; i < n; i++) {
      const t = (i - pd) / sr;
      const decay = Math.exp(-t * rt);
      const dens = smooth01(t / 0.12) * 0.85 + 0.15;   // tails thicken for ~120 ms
      const s = (rng() * 2 - 1) * decay * dens;
      const cut = lerp(0.62, 0.055, clamp01(t / (seconds * 0.55)) * damp);
      lp += cut * (s - lp);
      hp += 0.004 * (lp - hp);                          // kill DC and sub rumble
      d[i] += (lp - hp) * 0.9;
    }
  }
  // Normalised by hand, with convolver.normalize = false, so reshaping the IR
  // never silently changes the wet level under my feet.
  let peak = 0;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
  }
  const g = peak > 0 ? 0.42 / peak : 1;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) d[i] *= g;
  }
  return buf;
}

// Soft-knee saturation for master glue: tanh, not a hard clip. It rounds
// transients instead of squaring them.
function satCurve(amount = 1.35) {
  const n = 2048, c = new Float32Array(n);
  const k = Math.tanh(amount);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * amount) / k;
  }
  return c;
}

// -----------------------------------------------------------------------------
//  3. the rig — master chain, buses, reverb, spatialisation
// -----------------------------------------------------------------------------
function buildRig(ac, { seed = 0x4A5A17 } = {}) {
  const rng = mulberry32(seed);

  // ---- master: glue -> saturation -> gentle compression -> limiter -> out ----
  const out = ac.createGain(); out.gain.value = 0.72;
  const limiter = ac.createDynamicsCompressor();
  limiter.threshold.value = -2.0; limiter.knee.value = 0.0; limiter.ratio.value = 20;
  limiter.attack.value = 0.002;   limiter.release.value = 0.09;
  // Glue only. It must sit ABOVE the ambience bed, or the bed pumps the whole
  // mix down every time a drum lands and the waveform turns into a brick.
  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -8; comp.knee.value = 8; comp.ratio.value = 1.9;
  comp.attack.value = 0.02;  comp.release.value = 0.22;
  const sat = ac.createWaveShaper();
  sat.curve = satCurve(0.6); sat.oversample = '2x';   // near-linear until it is not
  const glue = ac.createGain(); glue.gain.value = 1.0;

  glue.connect(sat); sat.connect(comp); comp.connect(limiter);
  limiter.connect(out); out.connect(ac.destination);

  // ---- reverb return ----
  const conv = ac.createConvolver();
  conv.normalize = false;
  conv.buffer = valleyIR(ac, mulberry32(seed ^ 0x9E37));
  const revHi = ac.createBiquadFilter(); revHi.type = 'highpass'; revHi.frequency.value = 180;
  const revLo = ac.createBiquadFilter(); revLo.type = 'lowpass';  revLo.frequency.value = 5200;
  const revReturn = ac.createGain(); revReturn.gain.value = 0.95;
  conv.connect(revHi); revHi.connect(revLo); revLo.connect(revReturn); revReturn.connect(glue);

  // ---- buses. Connect a voice to bus.g only: the send is already tapped off
  //      the bus, so connecting to both would double the wet signal. ----
  const mkBus = (level, send, air) => {
    const g = ac.createGain(); g.gain.value = level;
    const s = ac.createGain(); s.gain.value = send;
    let tail = g;
    if (air) {
      // Nothing in nature — not wind, not surf, not a grass field — carries
      // flat energy out to 20 kHz. Without this the beds read as tape hiss.
      const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = air; lp.Q.value = 0.6;
      const sh = ac.createBiquadFilter(); sh.type = 'highshelf'; sh.frequency.value = 7000; sh.gain.value = -5;
      g.connect(sh); sh.connect(lp); tail = lp;
    }
    tail.connect(glue); tail.connect(s); s.connect(conv);
    return { g, send: s };
  };
  const buses = {
    amb: mkBus(0.40, 0.10, 13500),  // beds are already diffuse; they need little
    sfx: mkBus(0.95, 0.22),         // steel wants its top end and the valley behind it
    mus: mkBus(0.62, 0.30),         // the score sits furthest back
    ui:  mkBus(0.85, 0.16),
  };

  const rig = {
    ac, rng, buses, glue, out, conv, revReturn, comp, limiter,
    noiseW: whiteNoise(ac, 5.0, mulberry32(seed ^ 0x1234)),
    noiseP: pinkNoise(ac, 6.0, mulberry32(seed ^ 0xABCD)),
    // Voice budget. Held as a list of end times rather than a refcount driven
    // by onended, because an OfflineAudioContext may not deliver ended events
    // until the whole render is finished — which would silently starve the
    // verification render after forty voices.
    active: [],
    maxVoices: 44,
    waves: {},
  };
  rig.prune = (t) => {
    const a = rig.active;
    let w = 0;
    for (let i = 0; i < a.length; i++) if (a[i] > t) a[w++] = a[i];
    a.length = w;
    return w;
  };

  // ---- memoised plucked-string wavetables -----------------------------------
  // Additive spectra baked into a PeriodicWave: one oscillator then behaves
  // like a whole string. The difference between koto and biwa is these numbers.
  const mkWave = (harm, tilt, oddBias) => {
    const N = harm + 1;
    const real = new Float32Array(N), imag = new Float32Array(N);
    for (let k = 1; k < N; k++) {
      let a = 1 / Math.pow(k, tilt);
      if (k % 2 === 1) a *= oddBias;
      // phase scatter, so the partials do not all peak at once. That is the
      // difference between a plucked string and a buzzer.
      const ph = rng() * Math.PI * 2;
      real[k] = a * Math.cos(ph);
      imag[k] = a * Math.sin(ph);
    }
    return ac.createPeriodicWave(real, imag, { disableNormalization: false });
  };
  rig.waves.koto = mkWave(22, 1.18, 1.0);
  rig.waves.biwa = mkWave(28, 0.92, 1.35);   // brighter, nasal, odd-heavy: sawari
  rig.waves.reed = mkWave(9, 1.85, 1.05);

  return rig;
}

function setPos(node, x, y, z) {
  if (node.positionX) { node.positionX.value = x; node.positionY.value = y; node.positionZ.value = z; }
  else if (node.setPosition) node.setPosition(x, y, z);
}

// A positioned node feeding a bus. equalpower for anything numerous, HRTF for
// the handful of point sources where localisation actually matters: a bird in a
// tree behind you, an owl across the valley, a bamboo knock in the grove.
function spatial(rig, x, y, z, { hrtf = false, ref = 10, max = 900, roll = 1.15, bus = 'sfx' } = {}) {
  const p = rig.ac.createPanner();
  p.panningModel = hrtf ? 'HRTF' : 'equalpower';
  p.distanceModel = 'inverse';
  p.refDistance = ref; p.maxDistance = max; p.rolloffFactor = roll;
  setPos(p, x, y, z);
  p.connect(rig.buses[bus].g);
  return p;
}

// -----------------------------------------------------------------------------
//  4. voice builder
//  Every one-shot is a handful of nodes that must stop and disconnect
//  themselves. Doing that by hand at each call site is how a WebAudio graph
//  leaks until the tab stutters, so it happens here, once.
// -----------------------------------------------------------------------------
function mk(rig) {
  const ac = rig.ac;
  const nodes = [], srcs = [];
  return {
    ok: rig.prune(ac.currentTime) < rig.maxVoices,
    osc(type, freq) {
      const o = ac.createOscillator();
      o.type = type; o.frequency.value = freq;
      nodes.push(o); srcs.push(o); return o;
    },
    pwave(wave, freq) {
      const o = ac.createOscillator();
      o.setPeriodicWave(wave); o.frequency.value = freq;
      nodes.push(o); srcs.push(o); return o;
    },
    noise(pink = false, rate = 1) {
      const s = ac.createBufferSource();
      s.buffer = pink ? rig.noiseP : rig.noiseW;
      s.loop = true; s.playbackRate.value = rate;
      s.__off = rig.rng() * (s.buffer.duration - 0.3);
      nodes.push(s); srcs.push(s); return s;
    },
    gain(val = 0) { const g = ac.createGain(); g.gain.value = val; nodes.push(g); return g; },
    filt(type, f, q = 1) {
      const b = ac.createBiquadFilter();
      b.type = type; b.frequency.value = f; b.Q.value = q;
      nodes.push(b); return b;
    },
    panner(x, y, z, opts) { const p = spatial(rig, x, y, z, opts); nodes.push(p); return p; },
    stereo(pan, bus) {
      const p = ac.createStereoPanner(); p.pan.value = pan;
      nodes.push(p);
      if (bus) p.connect(rig.buses[bus].g);
      return p;
    },
    // start every source, stop them all at `end`, free the graph afterwards
    run(t0, end) {
      rig.active.push(end);
      for (const s of srcs) {
        try { if (s.buffer) s.start(t0, s.__off); else s.start(t0); } catch (e) { /* already started */ }
      }
      let last = null;
      for (const s of srcs) { try { s.stop(end); last = s; } catch (e) { /* no-op */ } }
      const free = () => { for (const n of nodes) { try { n.disconnect(); } catch (e) { /* no-op */ } } };
      if (last) last.onended = free;
    },
  };
}

// Percussive envelope: silence -> peak over `atk` -> exponential fall to zero
// over `dur`. `curve = 2` adds a mid-point knee, which reads as body-then-ring.
function hit(param, t0, peak, atk, dur, curve = 1) {
  const p = Math.max(peak, EPS);
  const a = Math.max(atk, 0.0008);
  param.setValueAtTime(EPS, t0);
  param.exponentialRampToValueAtTime(p, t0 + a);
  if (curve !== 1) param.exponentialRampToValueAtTime(p * 0.28, t0 + a + dur * 0.22);
  param.exponentialRampToValueAtTime(EPS, t0 + a + dur);
  return t0 + a + dur;
}

// Swelling envelope for sustained voices: flute, gusts, waves, cloth.
function swell(param, t0, peak, atk, hold, rel) {
  const p = Math.max(peak, EPS);
  param.setValueAtTime(EPS, t0);
  param.exponentialRampToValueAtTime(p, t0 + Math.max(atk, 0.002));
  param.setValueAtTime(p, t0 + Math.max(atk, 0.002) + hold);
  param.exponentialRampToValueAtTime(EPS, t0 + Math.max(atk, 0.002) + hold + rel);
  return t0 + atk + hold + rel;
}

// -----------------------------------------------------------------------------
//  5. SFX
// -----------------------------------------------------------------------------

// --- footsteps -------------------------------------------------------------
// Five surfaces, each a different topology rather than the same burst with a
// different cutoff. Grass has a bright swish after the compression; sand has
// almost no transient and a long shhf; rock is a click plus a stone ring;
// water is a filter sweep with droplets; wood is inharmonic partials.
const FOOT = {
  grass: { thumpF: 96,  thumpG: 0.48, bpF: 1750, bpQ: 0.75, bpG: 0.52, dur: 0.10,  swish: [2900, 0.24, 0.13] },
  sand:  { thumpF: 78,  thumpG: 0.40, bpF: 1000, bpQ: 0.55, bpG: 0.60, dur: 0.15,  swish: [1600, 0.30, 0.10] },
  rock:  { thumpF: 132, thumpG: 0.36, bpF: 2700, bpQ: 2.20, bpG: 0.52, dur: 0.045, swish: null },
  water: { thumpF: 88,  thumpG: 0.30, bpF: 1200, bpQ: 1.10, bpG: 0.68, dur: 0.19,  swish: [3400, 0.34, 0.20] },
  wood:  { thumpF: 150, thumpG: 0.48, bpF: 2100, bpQ: 3.00, bpG: 0.40, dur: 0.07,  swish: null },
};

function sfxFootstep(rig, when, { surface = 'grass', gain = 1, x = 0, y = 0, z = 0, pan = 0, spatialise = true } = {}) {
  const S = FOOT[surface] || FOOT.grass;
  const v = mk(rig); if (!v.ok) return;
  const dest = spatialise ? v.panner(x, y, z, { ref: 4.5, roll: 1.1, max: 60 }) : v.stereo(pan, 'sfx');
  const r = rig.rng;
  const jitter = 0.9 + r() * 0.2;

  // Body: a short low thump. This is the mass of an armoured man, and it is
  // what most game footsteps forget.
  const th = v.osc('sine', S.thumpF * jitter);
  const thg = v.gain(0);
  th.frequency.setValueAtTime(S.thumpF * 1.7 * jitter, when);
  th.frequency.exponentialRampToValueAtTime(S.thumpF * 0.72 * jitter, when + 0.07);
  hit(thg.gain, when, S.thumpG * gain, 0.004, S.dur + 0.06);
  th.connect(thg); thg.connect(dest);

  // Grain: filtered noise, the surface itself.
  const n = v.noise(surface === 'rock' || surface === 'wood', 1 + (r() - 0.5) * 0.25);
  const bp = v.filt('bandpass', S.bpF * jitter, S.bpQ);
  const ng = v.gain(0);
  hit(ng.gain, when, S.bpG * gain, surface === 'sand' ? 0.012 : 0.003, S.dur);
  if (surface === 'water') {
    bp.frequency.setValueAtTime(700, when);
    bp.frequency.exponentialRampToValueAtTime(2900, when + 0.13);
  }
  n.connect(bp); bp.connect(ng); ng.connect(dest);

  // The trailing swish of a foot leaving deep grass or dry sand.
  if (S.swish) {
    const n2 = v.noise(false, 1.07);
    const hp = v.filt('highpass', S.swish[0] * jitter, 0.8);
    const g2 = v.gain(0);
    hit(g2.gain, when + 0.035, S.swish[1] * gain, 0.03, S.swish[2]);
    n2.connect(hp); hp.connect(g2); g2.connect(dest);
  }

  if (surface === 'rock') {
    const ring = v.osc('triangle', 214 * jitter);
    const rg = v.gain(0);
    hit(rg.gain, when + 0.002, 0.06 * gain, 0.002, 0.10);
    ring.connect(rg); rg.connect(dest);
  }
  if (surface === 'water') {
    for (let i = 0; i < 3; i++) {
      const f = 1400 + r() * 2200;
      const d = v.osc('sine', f);
      const dg = v.gain(0);
      const t = when + 0.05 + r() * 0.13;
      d.frequency.setValueAtTime(f, t);
      d.frequency.exponentialRampToValueAtTime(f * 1.9, t + 0.05);
      hit(dg.gain, t, 0.05 * gain, 0.002, 0.06);
      d.connect(dg); dg.connect(dest);
    }
  }
  v.run(when, when + 0.6);

  // Lamellar plates and the katana in its saya answer every step.
  if (rig.rng() < 0.85) sfxRattle(rig, when + 0.012, { gain: gain * 0.5, x, y, z, spatialise });
}

// Small metal-on-lacquer clicks: the do's plates, the sageo, the tsuba.
function sfxRattle(rig, when, { gain = 1, x = 0, y = 0, z = 0, spatialise = true } = {}) {
  const v = mk(rig); if (!v.ok) return;
  const dest = spatialise ? v.panner(x, y + 1.1, z, { ref: 4.0, roll: 1.4, max: 40 }) : v.stereo(0, 'sfx');
  const r = rig.rng;
  const count = 2 + Math.floor(r() * 3);
  for (let i = 0; i < count; i++) {
    const t = when + r() * 0.055;
    const n = v.noise(false, 1 + r() * 0.3);
    const bp = v.filt('bandpass', 1900 + r() * 3400, 5 + r() * 6);
    const g = v.gain(0);
    hit(g.gain, t, (0.035 + r() * 0.05) * gain, 0.001, 0.02 + r() * 0.03);
    n.connect(bp); bp.connect(g); g.connect(dest);
  }
  v.run(when, when + 0.22);
}

// Kimono, hakama, cloak. Broadband, soft, no transient.
function sfxCloth(rig, when, { gain = 1, x = 0, y = 0, z = 0, dur = 0.22, spatialise = true } = {}) {
  const v = mk(rig); if (!v.ok) return;
  const dest = spatialise ? v.panner(x, y + 1.0, z, { ref: 4.0, roll: 1.4, max: 40 }) : v.stereo(0, 'sfx');
  const n = v.noise(true, 1.0);
  const bp = v.filt('bandpass', 2400, 0.6);
  const g = v.gain(0);
  bp.frequency.setValueAtTime(1500, when);
  bp.frequency.linearRampToValueAtTime(3600, when + dur * 0.5);
  bp.frequency.linearRampToValueAtTime(1800, when + dur);
  swell(g.gain, when, 0.10 * gain, dur * 0.28, dur * 0.12, dur * 0.6);
  n.connect(bp); bp.connect(g); g.connect(dest);
  v.run(when, when + dur + 0.25);
}

// Saddle, obi, sandal straps. A creak is amplitude jitter, not a smooth swell.
function sfxLeather(rig, when, { gain = 1, x = 0, y = 0, z = 0 } = {}) {
  const v = mk(rig); if (!v.ok) return;
  const dest = v.panner(x, y + 1.0, z, { ref: 4.0, roll: 1.3, max: 60 });
  const n = v.noise(true, 0.8);
  const bp = v.filt('bandpass', 620, 3.2);
  const g = v.gain(0);
  bp.frequency.setValueAtTime(480, when);
  bp.frequency.linearRampToValueAtTime(900, when + 0.30);
  const lfo = v.osc('sawtooth', 21);
  const lg = v.gain(0.35);
  lfo.connect(lg); lg.connect(g.gain);
  swell(g.gain, when, 0.13 * gain, 0.07, 0.06, 0.28);
  n.connect(bp); bp.connect(g); g.connect(dest);
  v.run(when, when + 0.65);
}

// --- steel -----------------------------------------------------------------
// A katana whoosh is a band of noise whose centre tracks the blade's velocity
// through the arc: it rises as the blade accelerates and falls as it passes,
// and the resonance sharpens at the peak.
function sfxWhoosh(rig, when, { heavy = false, gain = 1, x = 0, y = 0, z = 0 } = {}) {
  const v = mk(rig); if (!v.ok) return;
  const dest = v.panner(x, y + 1.35, z, { ref: 4.5, roll: 1.2, max: 70 });
  const r = rig.rng;
  const dur = heavy ? 0.42 : 0.26;
  const f0 = heavy ? 380 : 620, f1 = heavy ? 1500 : 2500;

  for (let layer = 0; layer < 2; layer++) {
    const n = v.noise(layer === 0, 1 + (r() - 0.5) * 0.2);
    const bp = v.filt('bandpass', f0, layer === 0 ? 2.2 : 5.5);
    const g = v.gain(0);
    const jf = 0.88 + r() * 0.26;
    bp.frequency.setValueAtTime(f0 * jf, when);
    bp.frequency.exponentialRampToValueAtTime(f1 * jf, when + dur * 0.55);
    bp.frequency.exponentialRampToValueAtTime(f0 * 0.75 * jf, when + dur);
    bp.Q.setValueAtTime(layer === 0 ? 1.6 : 3.0, when);
    bp.Q.linearRampToValueAtTime(layer === 0 ? 3.2 : 8.0, when + dur * 0.55);
    const amp = (layer === 0 ? 0.28 : 0.19) * gain * (heavy ? 1.25 : 1);
    swell(g.gain, when, amp, dur * 0.5, 0.005, dur * 0.5);
    n.connect(bp); bp.connect(g); g.connect(dest);
  }
  // the low pressure wave a heavy cut pushes ahead of it
  if (heavy) {
    const s = v.osc('sine', 190);
    const sg = v.gain(0);
    s.frequency.setValueAtTime(190, when);
    s.frequency.exponentialRampToValueAtTime(80, when + dur);
    swell(sg.gain, when, 0.10 * gain, dur * 0.5, 0.01, dur * 0.5);
    s.connect(sg); sg.connect(dest);
  }
  v.run(when, when + dur + 0.35);
}

// Steel on steel. Metal is inharmonic: the partials are not integer multiples,
// they are scattered, and the high ones die fastest. That scatter is the entire
// sound — get it wrong and you have a bell.
const CLASH_PARTIALS = [1.00, 1.61, 2.13, 2.97, 3.44, 4.62, 5.31, 6.88, 8.09];
function sfxClash(rig, when, { gain = 1, x = 0, y = 0, z = 0, bright = 1 } = {}) {
  const v = mk(rig); if (!v.ok) return;
  const dest = v.panner(x, y + 1.35, z, { ref: 5, roll: 1.1, max: 200 });
  const r = rig.rng;
  const base = (1180 + r() * 620) * bright;

  const n = v.noise(false, 1.1);
  const hp = v.filt('highpass', 2600, 0.7);
  const ng = v.gain(0);
  hit(ng.gain, when, 0.46 * gain, 0.0012, 0.055);
  n.connect(hp); hp.connect(ng); ng.connect(dest);

  for (let i = 0; i < CLASH_PARTIALS.length; i++) {
    const f = base * CLASH_PARTIALS[i] * (0.985 + r() * 0.03);
    if (f > 17000) continue;
    const o = v.osc(i < 3 ? 'triangle' : 'sine', f);
    const g = v.gain(0);
    const decay = (1.05 / (1 + i * 0.72)) * (0.75 + r() * 0.5);
    const amp = (0.19 / (1 + i * 0.55)) * gain;
    hit(g.gain, when + i * 0.0006, amp, 0.0015, decay, 2);
    // a slow beat between the two blades' modes
    if (i < 4) {
      const beat = v.osc('sine', 3 + r() * 7);
      const bg = v.gain(f * 0.0016);
      beat.connect(bg); bg.connect(o.frequency);
    }
    o.connect(g); g.connect(dest);
  }
  const body = v.osc('sine', 280);
  const bg2 = v.gain(0);
  body.frequency.setValueAtTime(280, when);
  body.frequency.exponentialRampToValueAtTime(120, when + 0.11);
  hit(bg2.gain, when, 0.14 * gain, 0.002, 0.16);
  body.connect(bg2); bg2.connect(dest);

  v.run(when, when + 1.7);
}

// Sparks off a parry: a fizz of tiny high transients.
function sfxSpark(rig, when, { gain = 1, x = 0, y = 0, z = 0 } = {}) {
  const v = mk(rig); if (!v.ok) return;
  const dest = v.panner(x, y + 1.35, z, { ref: 5, roll: 1.15, max: 120 });
  const r = rig.rng;
  for (let i = 0; i < 7; i++) {
    const t = when + r() * 0.09;
    const n = v.noise(false, 1 + r() * 0.4);
    const bp = v.filt('bandpass', 4200 + r() * 6000, 9 + r() * 8);
    const g = v.gain(0);
    hit(g.gain, t, (0.03 + r() * 0.05) * gain, 0.001, 0.02 + r() * 0.05);
    n.connect(bp); bp.connect(g); g.connect(dest);
  }
  v.run(when, when + 0.32);
}

// Blade meeting a body: no ring at all, just mass and cloth.
function sfxImpact(rig, when, { gain = 1, x = 0, y = 0, z = 0 } = {}) {
  const v = mk(rig); if (!v.ok) return;
  const dest = v.panner(x, y + 1.1, z, { ref: 5, roll: 1.15, max: 150 });
  const s = v.osc('sine', 165);
  const sg = v.gain(0);
  s.frequency.setValueAtTime(165, when);
  s.frequency.exponentialRampToValueAtTime(52, when + 0.16);
  hit(sg.gain, when, 0.34 * gain, 0.002, 0.28);
  s.connect(sg); sg.connect(dest);

  const n = v.noise(true, 1.0);
  const bp = v.filt('bandpass', 900, 1.1);
  const ng = v.gain(0);
  bp.frequency.setValueAtTime(900, when);
  bp.frequency.exponentialRampToValueAtTime(300, when + 0.1);
  hit(ng.gain, when, 0.26 * gain, 0.0015, 0.13);
  n.connect(bp); bp.connect(ng); ng.connect(dest);

  const n2 = v.noise(false, 1.0);
  const hp = v.filt('highpass', 3200, 0.7);
  const g2 = v.gain(0);
  hit(g2.gain, when, 0.10 * gain, 0.001, 0.05);
  n2.connect(hp); hp.connect(g2); g2.connect(dest);
  v.run(when, when + 0.65);
}

// Chiburi and the click of the tsuba against the koiguchi. Three events, and
// the gaps between them are the whole character of the sound.
function sfxSheathe(rig, when, { gain = 1, x = 0, y = 0, z = 0 } = {}) {
  const v = mk(rig); if (!v.ok) return;
  const dest = v.panner(x, y + 1.1, z, { ref: 4.5, roll: 1.2, max: 90 });
  const n = v.noise(false, 1.0);
  const bp = v.filt('bandpass', 2200, 3.0);
  const g = v.gain(0);
  bp.frequency.setValueAtTime(2200, when);
  bp.frequency.exponentialRampToValueAtTime(8200, when + 0.10);
  swell(g.gain, when, 0.15 * gain, 0.035, 0.005, 0.08);
  n.connect(bp); bp.connect(g); g.connect(dest);

  const t2 = when + 0.13;
  const n2 = v.noise(true, 1.0);
  const bp2 = v.filt('bandpass', 2600, 4.5);
  const g2 = v.gain(0);
  bp2.frequency.setValueAtTime(2600, t2);
  bp2.frequency.exponentialRampToValueAtTime(900, t2 + 0.19);
  swell(g2.gain, t2, 0.13 * gain, 0.05, 0.03, 0.13);
  n2.connect(bp2); bp2.connect(g2); g2.connect(dest);

  const t3 = t2 + 0.21;
  for (const [f, a, d] of [[520, 0.10, 0.07], [1180, 0.07, 0.045], [2360, 0.04, 0.025]]) {
    const o = v.osc('triangle', f);
    const og = v.gain(0);
    hit(og.gain, t3, a * gain, 0.001, d);
    o.connect(og); og.connect(dest);
  }
  v.run(when, when + 0.95);
}

// Nukitsuke — the draw. A rising metallic scrape with a resonance that opens,
// and the blade left ringing at the top of the arc.
function sfxDraw(rig, when, { gain = 1, x = 0, y = 0, z = 0 } = {}) {
  const v = mk(rig); if (!v.ok) return;
  const dest = v.panner(x, y + 1.1, z, { ref: 4.5, roll: 1.2, max: 90 });
  const n = v.noise(true, 1.0);
  const bp = v.filt('bandpass', 800, 6);
  const g = v.gain(0);
  bp.frequency.setValueAtTime(800, when);
  bp.frequency.exponentialRampToValueAtTime(4600, when + 0.30);
  bp.Q.setValueAtTime(3, when);
  bp.Q.linearRampToValueAtTime(11, when + 0.30);
  swell(g.gain, when, 0.16 * gain, 0.16, 0.02, 0.16);
  n.connect(bp); bp.connect(g); g.connect(dest);
  for (const [m, a] of [[1, 0.055], [2.41, 0.035], [4.13, 0.02]]) {
    const o = v.osc('sine', 1720 * m);
    const og = v.gain(0);
    hit(og.gain, when + 0.29, a * gain, 0.004, 0.55);
    o.connect(og); og.connect(dest);
  }
  v.run(when, when + 1.15);
}

// The tsuba tapped with a thumb — stance changes.
function sfxTsuba(rig, when, { gain = 1, x = 0, y = 0, z = 0 } = {}) {
  const v = mk(rig); if (!v.ok) return;
  const dest = v.panner(x, y + 1.1, z, { ref: 4.5, roll: 1.25, max: 70 });
  for (const [f, a, d] of [[1470, 0.10, 0.28], [2830, 0.06, 0.18], [4610, 0.035, 0.11]]) {
    const o = v.osc('sine', f * (0.97 + rig.rng() * 0.06));
    const og = v.gain(0);
    hit(og.gain, when, a * gain, 0.0012, d);
    o.connect(og); og.connect(dest);
  }
  v.run(when, when + 0.55);
}

// --- wildlife --------------------------------------------------------------

// Songbird: a short motif of frequency-swept blips. Real birdsong is almost
// pure tone with fast glides, so this is an oscillator on a scripted frequency
// contour with a whisper of pitch-locked noise, not a noise burst.
function sfxBird(rig, when, { gain = 1, x = 0, y = 0, z = 0 } = {}) {
  const v = mk(rig); if (!v.ok) return;
  const dest = v.panner(x, y, z, { hrtf: true, ref: 12, roll: 1.05, max: 260, bus: 'amb' });
  const r = rig.rng;
  const notes = 2 + Math.floor(r() * 4);
  const base = 2300 + r() * 1900;
  let t = when;
  const o = v.osc('sine', base);
  const g = v.gain(0);
  const lp = v.filt('lowpass', 9000, 0.7);
  const n = v.noise(false, 1);
  const nbp = v.filt('bandpass', base, 14);
  const ng = v.gain(0);
  n.connect(nbp); nbp.connect(ng); ng.connect(lp);
  o.connect(g); g.connect(lp); lp.connect(dest);

  for (let i = 0; i < notes; i++) {
    const dur = 0.045 + r() * 0.075;
    const f0 = base * (0.8 + r() * 0.5);
    const f1 = f0 * (r() < 0.55 ? 1.25 + r() * 0.7 : 0.62 + r() * 0.25);
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    nbp.frequency.setValueAtTime(f0, t);
    nbp.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const a = (0.24 + r() * 0.18) * gain;
    g.gain.setValueAtTime(EPS, t);
    g.gain.exponentialRampToValueAtTime(a, t + 0.012);
    g.gain.setValueAtTime(a, t + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(EPS, t + dur);
    ng.gain.setValueAtTime(EPS, t);
    ng.gain.exponentialRampToValueAtTime(a * 0.5, t + 0.012);
    ng.gain.exponentialRampToValueAtTime(EPS, t + dur);
    t += dur + 0.018 + r() * 0.075;
  }
  v.run(when, t + 0.3);
}

// Higurashi and crickets: a bandpassed noise burst chopped by a fast amplitude
// modulator. The trill rate is the species; the descending cascade at the end
// is what makes a higurashi a higurashi.
function sfxInsect(rig, when, { gain = 1, x = 0, y = 0, z = 0, kind = 'cricket' } = {}) {
  const v = mk(rig); if (!v.ok) return;
  const dest = v.panner(x, y, z, { ref: 9, roll: 1.2, max: 120, bus: 'amb' });
  const r = rig.rng;
  const cicada = kind === 'cicada';
  const f = cicada ? 3400 + r() * 1400 : 4300 + r() * 1500;
  const dur = cicada ? 1.4 + r() * 1.6 : 0.16 + r() * 0.2;
  const trill = cicada ? 44 + r() * 22 : 26 + r() * 12;

  const n = v.noise(false, 1);
  const bp = v.filt('bandpass', f, cicada ? 5 : 12);
  const am = v.gain(0.5);
  const g = v.gain(0);
  const lfo = v.osc('sine', trill);
  const lg = v.gain(0.5);
  lfo.connect(lg); lg.connect(am.gain);
  n.connect(bp); bp.connect(am); am.connect(g); g.connect(dest);
  if (cicada) {
    bp.frequency.setValueAtTime(f, when);
    bp.frequency.setValueAtTime(f, when + dur * 0.62);
    bp.frequency.exponentialRampToValueAtTime(f * 0.55, when + dur);
    lfo.frequency.setValueAtTime(trill, when + dur * 0.6);
    lfo.frequency.linearRampToValueAtTime(trill * 0.45, when + dur);
    swell(g.gain, when, 0.09 * gain, dur * 0.18, dur * 0.42, dur * 0.4);
  } else {
    swell(g.gain, when, 0.055 * gain, 0.02, dur * 0.6, dur * 0.4);
  }
  v.run(when, when + dur + 0.45);
}

// Frog: a low croak. Sawtooth through two formant bandpasses with a fast
// amplitude ripple, repeated two to five times.
function sfxFrog(rig, when, { gain = 1, x = 0, y = 0, z = 0 } = {}) {
  const v = mk(rig); if (!v.ok) return;
  const dest = v.panner(x, y, z, { ref: 8, roll: 1.3, max: 140, bus: 'amb' });
  const r = rig.rng;
  const f = 170 + r() * 90;
  const reps = 2 + Math.floor(r() * 4);
  const o = v.osc('sawtooth', f);
  const f1 = v.filt('bandpass', 520 + r() * 260, 4);
  const f2 = v.filt('bandpass', 1250 + r() * 500, 6);
  const sum = v.gain(1);
  const g = v.gain(0);
  const rip = v.osc('sine', 30 + r() * 16);
  const rg = v.gain(0.45);
  rip.connect(rg); rg.connect(g.gain);
  o.connect(f1); o.connect(f2); f1.connect(sum); f2.connect(sum);
  sum.connect(g); g.connect(dest);
  let t = when;
  for (let i = 0; i < reps; i++) {
    const dur = 0.09 + r() * 0.07;
    o.frequency.setValueAtTime(f * (0.95 + r() * 0.12), t);
    swell(g.gain, t, 0.11 * gain, 0.012, dur * 0.4, dur * 0.6);
    t += dur + 0.10 + r() * 0.10;
  }
  v.run(when, t + 0.35);
}

// Owl: a breathy two-note hoot. The breath is what makes it an owl rather than
// an ocarina, so there is as much bandpassed noise here as tone.
function sfxOwl(rig, when, { gain = 1, x = 0, y = 0, z = 0 } = {}) {
  const v = mk(rig); if (!v.ok) return;
  const dest = v.panner(x, y, z, { hrtf: true, ref: 22, roll: 0.85, max: 500, bus: 'amb' });
  const r = rig.rng;
  const f = 330 + r() * 150;
  for (const [off, freq, dur] of [[0, f, 0.34], [0.52, f * 0.94, 0.46]]) {
    const t = when + off;
    const o = v.osc('sine', freq);
    const o2 = v.osc('sine', freq * 2);
    const g = v.gain(0);
    const g2 = v.gain(0);
    const n = v.noise(false, 1);
    const bp = v.filt('bandpass', freq, 9);
    const ng = v.gain(0);
    const vib = v.osc('sine', 5.2);
    const vg = v.gain(freq * 0.006);
    vib.connect(vg); vg.connect(o.frequency);
    o.frequency.setValueAtTime(freq * 0.965, t);
    o.frequency.exponentialRampToValueAtTime(freq, t + 0.10);
    swell(g.gain, t, 0.17 * gain, 0.075, dur * 0.35, dur * 0.55);
    swell(g2.gain, t, 0.028 * gain, 0.075, dur * 0.3, dur * 0.55);
    swell(ng.gain, t, 0.05 * gain, 0.04, dur * 0.3, dur * 0.6);
    o.connect(g); g.connect(dest);
    o2.connect(g2); g2.connect(dest);
    n.connect(bp); bp.connect(ng); ng.connect(dest);
  }
  v.run(when, when + 1.6);
}

// --- bamboo ----------------------------------------------------------------
// A shishi-odoshi knock: a hollow tube struck. Inharmonic partials, a very
// short decay on the high ones, a wooden noise transient, and no reverb tail
// of its own — it is a close, dry, deliberate sound.
function sfxBamboo(rig, when, { gain = 1, x = 0, y = 0, z = 0 } = {}) {
  const v = mk(rig); if (!v.ok) return;
  const dest = v.panner(x, y, z, { hrtf: true, ref: 14, roll: 1.0, max: 320, bus: 'amb' });
  const r = rig.rng;
  const base = 300 + r() * 190;
  const ratios = [1, 2.41, 3.87, 5.63, 7.9];
  for (let i = 0; i < ratios.length; i++) {
    const o = v.osc(i === 0 ? 'triangle' : 'sine', base * ratios[i] * (0.99 + r() * 0.02));
    const g = v.gain(0);
    hit(g.gain, when, (0.20 / (1 + i * 1.15)) * gain, 0.0012, 0.26 / (1 + i * 0.9));
    o.connect(g); g.connect(dest);
  }
  const n = v.noise(false, 1);
  const bp = v.filt('bandpass', 1900, 1.6);
  const ng = v.gain(0);
  hit(ng.gain, when, 0.11 * gain, 0.001, 0.035);
  n.connect(bp); bp.connect(ng); ng.connect(dest);
  v.run(when, when + 0.75);
}

// Two stalks rubbing in a gust: a slow, pitched, amplitude-torn creak.
function sfxBambooCreak(rig, when, { gain = 1, x = 0, y = 0, z = 0 } = {}) {
  const v = mk(rig); if (!v.ok) return;
  const dest = v.panner(x, y, z, { ref: 16, roll: 1.0, max: 300, bus: 'amb' });
  const r = rig.rng;
  const dur = 0.5 + r() * 0.8;
  const f = 260 + r() * 220;
  const o = v.osc('sawtooth', f);
  const bp = v.filt('bandpass', f * 2.5, 7);
  const g = v.gain(0);
  const tear = v.osc('sawtooth', 12 + r() * 14);
  const tg = v.gain(0.55);
  tear.connect(tg); tg.connect(g.gain);
  o.frequency.setValueAtTime(f, when);
  o.frequency.linearRampToValueAtTime(f * (0.8 + r() * 0.5), when + dur);
  swell(g.gain, when, 0.075 * gain, dur * 0.35, dur * 0.15, dur * 0.5);
  o.connect(bp); bp.connect(g); g.connect(dest);
  v.run(when, when + dur + 0.45);
}

// A struck rin bowl — the guiding-wind cue and quest beats.
function sfxRin(rig, when, { gain = 1 } = {}) {
  const v = mk(rig); if (!v.ok) return;
  const dest = v.stereo(0, 'ui');
  const base = 523.25;
  for (const [m, a, d] of [[1, 0.16, 5.5], [2.756, 0.09, 3.6], [5.404, 0.05, 2.2], [8.933, 0.025, 1.4]]) {
    const o = v.osc('sine', base * m);
    const g = v.gain(0);
    const beat = v.osc('sine', 1.4 + m * 0.6);
    const bg = v.gain(base * m * 0.0009);
    beat.connect(bg); bg.connect(o.frequency);
    hit(g.gain, when, a * gain, 0.004, d);
    o.connect(g); g.connect(dest);
  }
  v.run(when, when + 6.3);
}

// The guiding wind: a 2.4 s gust that traverses the stereo field and leaves a
// resonance behind it, with the bowl underneath.
function sfxGust(rig, when, { gain = 1 } = {}) {
  const v = mk(rig); if (!v.ok) return;
  const dest = v.stereo(-0.75, 'ui');
  const dur = 2.4;
  const n = v.noise(true, 1);
  const bp = v.filt('bandpass', 260, 1.4);
  const g = v.gain(0);
  bp.frequency.setValueAtTime(260, when);
  bp.frequency.exponentialRampToValueAtTime(1900, when + dur * 0.45);
  bp.frequency.exponentialRampToValueAtTime(420, when + dur);
  swell(g.gain, when, 0.26 * gain, dur * 0.42, 0.05, dur * 0.5);
  n.connect(bp); bp.connect(g); g.connect(dest);

  const n2 = v.noise(false, 1);
  const wh = v.filt('bandpass', 1200, 14);
  const g2 = v.gain(0);
  wh.frequency.setValueAtTime(1200, when + 0.2);
  wh.frequency.exponentialRampToValueAtTime(3100, when + dur * 0.6);
  wh.frequency.exponentialRampToValueAtTime(1500, when + dur);
  swell(g2.gain, when + 0.2, 0.09 * gain, dur * 0.35, 0.04, dur * 0.4);
  n2.connect(wh); wh.connect(g2); g2.connect(dest);

  dest.pan.setValueAtTime(-0.75, when);
  dest.pan.linearRampToValueAtTime(0.75, when + dur);
  v.run(when, when + dur + 0.55);
  sfxRin(rig, when + 0.12, { gain: gain * 0.55 });
}

// A breaking wave, driven from the ocean bed's own scheduler.
function sfxWave(rig, when, { gain = 1, x = 0, y = 0, z = 0, big = false } = {}) {
  const v = mk(rig); if (!v.ok) return;
  const dest = v.panner(x, y, z, { ref: 26, roll: 0.8, max: 700, bus: 'amb' });
  const rise = big ? 1.15 : 0.75;
  const fall = big ? 3.6 : 2.4;

  const n = v.noise(true, 1);
  const lp = v.filt('lowpass', 240, 0.9);
  const g = v.gain(0);
  lp.frequency.setValueAtTime(240, when);
  lp.frequency.exponentialRampToValueAtTime(big ? 1100 : 800, when + rise);
  lp.frequency.exponentialRampToValueAtTime(220, when + rise + fall);
  swell(g.gain, when, (big ? 0.30 : 0.20) * gain, rise, 0.12, fall);
  n.connect(lp); lp.connect(g); g.connect(dest);

  // the foam hiss that follows it up the sand
  const n2 = v.noise(false, 1);
  const hp = v.filt('highpass', 900, 0.7);
  const g2 = v.gain(0);
  hp.frequency.setValueAtTime(900, when + rise * 0.7);
  hp.frequency.linearRampToValueAtTime(3400, when + rise + fall * 0.8);
  swell(g2.gain, when + rise * 0.55, (big ? 0.13 : 0.09) * gain, rise * 0.7, 0.2, fall * 0.85);
  n2.connect(hp); hp.connect(g2); g2.connect(dest);
  v.run(when, when + rise + fall + 0.7);
}

// -----------------------------------------------------------------------------
//  6. instruments
// -----------------------------------------------------------------------------

// Tuning. Everything is built on D. Hirajoshi (D E F A Bb) is the open,
// contemplative koto tuning and carries exploration; in-sen (D Eb G A C) is
// darker and takes over as the game tenses. Offsets are semitones from A4.
const A4 = 440;
const ROOT = -7;                            // D4 = 293.66 Hz
const SCALES = {
  hirajoshi: [0, 2, 3, 7, 8],
  insen:     [0, 1, 5, 7, 10],
};
function degFreq(scale, deg, root = ROOT) {
  const n = scale.length;
  const oct = Math.floor(deg / n);
  const i = ((deg % n) + n) % n;
  return A4 * Math.pow(2, (root + scale[i] + 12 * oct) / 12);
}

// --- shakuhachi ------------------------------------------------------------
// The signature voice, and more air than tone: a weak filtered tone plus a
// large band of breath noise locked to the note. The attack scoops up from
// below (meri), the vibrato arrives late as a player's does, and accented notes
// get a muraiki blast of air at the front.
function shakuhachi(rig, when, freq, dur, { gain = 1, breath = 1, accent = false, bend = 0 } = {}) {
  const v = mk(rig); if (!v.ok) return;
  const dest = v.stereo((rig.rng() - 0.5) * 0.4, 'mus');
  const r = rig.rng;
  const atk = accent ? 0.045 : lerp(0.13, 0.34, r());
  const rel = Math.max(0.30, dur * 0.55);
  const body = Math.max(0.08, dur - atk - rel * 0.35);

  const tone = v.gain(0.55);
  const lp = v.filt('lowpass', freq * 3.0, 0.9);
  for (let i = 0; i < 2; i++) {
    const det = i === 0 ? -4 : 5;
    const o = v.pwave(rig.waves.reed, freq);
    o.detune.setValueAtTime(det - 55, when);
    o.detune.linearRampToValueAtTime(det, when + Math.min(0.12, atk));
    if (bend) {
      o.detune.setValueAtTime(det, when + dur * 0.55);
      o.detune.linearRampToValueAtTime(det + bend, when + dur * 0.9);
    }
    const vib = v.osc('sine', 4.6 + r() * 1.4);
    const vg = v.gain(0);
    vg.gain.setValueAtTime(EPS, when);
    vg.gain.linearRampToValueAtTime(0, when + atk);
    vg.gain.linearRampToValueAtTime(14 + r() * 12, when + Math.min(dur * 0.7, atk + 0.55));
    vib.connect(vg); vg.connect(o.detune);
    o.connect(tone);
  }
  const tg = v.gain(0);
  tone.connect(lp); lp.connect(tg); tg.connect(dest);
  swell(tg.gain, when, 0.115 * gain, atk, body, rel);
  lp.frequency.setValueAtTime(freq * 3.0, when);
  lp.frequency.linearRampToValueAtTime(freq * 6.5, when + atk);
  lp.frequency.linearRampToValueAtTime(freq * 3.4, when + dur);

  // breath: a high-Q band locked to the note, its octave, and broad air
  const n = v.noise(false, 1);
  const bp = v.filt('bandpass', freq, 11);
  const bp2 = v.filt('bandpass', freq * 2.02, 4.5);
  const air = v.filt('highpass', 1500, 0.7);
  const bg = v.gain(0);
  const ag = v.gain(0);
  n.connect(bp); bp.connect(bg); bg.connect(dest);
  n.connect(bp2); bp2.connect(bg);
  n.connect(air); air.connect(ag); ag.connect(dest);
  swell(bg.gain, when, 0.085 * gain * breath, atk * 0.55, body, rel * 0.8);
  swell(ag.gain, when, 0.022 * gain * breath, atk * 0.35, body * 0.6, rel);

  if (accent) {
    const n2 = v.noise(false, 1);
    const hp = v.filt('highpass', 2200, 0.7);
    const g2 = v.gain(0);
    hit(g2.gain, when, 0.10 * gain, 0.006, 0.16);
    n2.connect(hp); hp.connect(g2); g2.connect(dest);
  }
  v.run(when, when + dur + rel + 0.35);
}

// --- koto ------------------------------------------------------------------
// One oscillator on a baked plucked spectrum, through a lowpass that closes as
// the note decays. That falling cutoff makes the high partials die first, which
// is the whole psychoacoustic signature of a plucked string.
function koto(rig, when, freq, dur, { gain = 1, oshi = 0, bright = 1 } = {}) {
  const v = mk(rig); if (!v.ok) return;
  const dest = v.stereo((rig.rng() - 0.5) * 0.55, 'mus');
  const o = v.pwave(rig.waves.koto, freq);
  const lp = v.filt('lowpass', Math.min(17000, freq * 15 * bright), 1.1);
  const g = v.gain(0);
  lp.frequency.setValueAtTime(Math.min(17000, freq * 15 * bright), when);
  lp.frequency.exponentialRampToValueAtTime(Math.max(160, freq * 2.1), when + dur * 0.8);
  hit(g.gain, when, 0.15 * gain, 0.004, dur, 2);
  o.connect(lp); lp.connect(g); g.connect(dest);

  // ato-oshi: press the string behind the bridge and the pitch rises
  if (oshi) {
    o.detune.setValueAtTime(0, when + dur * 0.22);
    o.detune.linearRampToValueAtTime(oshi, when + dur * 0.45);
  }

  const n = v.noise(false, 1);
  const bp = v.filt('bandpass', Math.min(9000, freq * 5), 1.2);
  const ng = v.gain(0);
  hit(ng.gain, when, 0.055 * gain, 0.0012, 0.022);       // the nail on the string
  n.connect(bp); bp.connect(ng); ng.connect(dest);

  const bodyF = v.filt('bandpass', 330, 1.6);            // paulownia body
  const bodyG = v.gain(0);
  hit(bodyG.gain, when, 0.035 * gain, 0.006, dur * 0.4);
  o.connect(bodyF); bodyF.connect(bodyG); bodyG.connect(dest);

  v.run(when, when + dur + 0.45);
}

// --- biwa ------------------------------------------------------------------
// Struck hard with a plectrum, and buzzing: the sawari is a rattle deliberately
// designed into the instrument. Noise ring-modulating the amplitude for the
// first 240 ms is the cheapest honest way to get it.
function biwa(rig, when, freq, dur, { gain = 1 } = {}) {
  const v = mk(rig); if (!v.ok) return;
  const dest = v.stereo((rig.rng() - 0.5) * 0.5, 'mus');
  const o = v.pwave(rig.waves.biwa, freq);
  const o2 = v.pwave(rig.waves.biwa, freq * 1.004);
  const sum = v.gain(0.55);
  const lp = v.filt('lowpass', Math.min(16000, freq * 20), 1.4);
  const g = v.gain(0);
  o.connect(sum); o2.connect(sum); sum.connect(lp); lp.connect(g); g.connect(dest);
  lp.frequency.setValueAtTime(Math.min(16000, freq * 20), when);
  lp.frequency.exponentialRampToValueAtTime(Math.max(200, freq * 2.6), when + dur * 0.7);
  hit(g.gain, when, 0.15 * gain, 0.003, dur, 2);

  const n = v.noise(false, 1);
  const nbp = v.filt('bandpass', freq * 6, 1.0);
  const buzz = v.gain(0);
  hit(buzz.gain, when, 0.22, 0.002, 0.24);
  n.connect(nbp); nbp.connect(buzz); buzz.connect(g.gain);

  const n2 = v.noise(false, 1);
  const bp2 = v.filt('bandpass', 2600, 1.4);
  const pg = v.gain(0);
  hit(pg.gain, when, 0.10 * gain, 0.001, 0.05);
  n2.connect(bp2); bp2.connect(pg); pg.connect(dest);
  v.run(when, when + dur + 0.45);
}

// --- taiko -----------------------------------------------------------------
// Odaiko: a sine whose pitch collapses, a lowpassed slap, and a resonant shell.
// Shime is the same shape an octave up and ten times shorter. Ka is the rim.
function taiko(rig, when, { gain = 1, kind = 'do', pan = 0 } = {}) {
  const v = mk(rig); if (!v.ok) return;
  const dest = v.stereo(pan, 'mus');
  const r = rig.rng;

  if (kind === 'ka') {
    const n = v.noise(false, 1);
    const bp = v.filt('bandpass', 3200 + r() * 900, 3.2);
    const g = v.gain(0);
    hit(g.gain, when, 0.22 * gain, 0.0012, 0.05);
    n.connect(bp); bp.connect(g); g.connect(dest);
    const o = v.osc('triangle', 640);
    const og = v.gain(0);
    hit(og.gain, when, 0.09 * gain, 0.001, 0.045);
    o.connect(og); og.connect(dest);
    v.run(when, when + 0.28);
    return;
  }

  const shime = kind === 'shime';
  const f0 = shime ? 340 : 155, f1 = shime ? 190 : 52;
  const dec = shime ? 0.20 : 0.85;

  const o = v.osc('sine', f0);
  const g = v.gain(0);
  o.frequency.setValueAtTime(f0 * (0.96 + r() * 0.08), when);
  o.frequency.exponentialRampToValueAtTime(f1, when + (shime ? 0.055 : 0.22));
  hit(g.gain, when, (shime ? 0.34 : 0.62) * gain, 0.0018, dec, 2);
  o.connect(g); g.connect(dest);

  const n = v.noise(false, 1);
  const lp = v.filt('lowpass', shime ? 3200 : 1300, 0.8);
  const ng = v.gain(0);
  hit(ng.gain, when, (shime ? 0.22 : 0.30) * gain, 0.0012, shime ? 0.06 : 0.075);
  n.connect(lp); lp.connect(ng); ng.connect(dest);

  const bod = v.filt('bandpass', shime ? 480 : 190, 2.4);
  const bg = v.gain(0);
  hit(bg.gain, when, (shime ? 0.06 : 0.10) * gain, 0.004, dec * 0.7);
  n.connect(bod); bod.connect(bg); bg.connect(dest);
  v.run(when, when + 1.6);
}

// --- drone -----------------------------------------------------------------
// A permanent low bed: root, sub, a fifth that only arrives with tension, a
// minor second that only arrives with dread, and a high shimmer. Slow filter
// movement keeps it alive without ever asking for attention.
function buildDrone(rig) {
  const ac = rig.ac;
  const out = ac.createGain(); out.gain.value = 0.0;
  const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 300; lp.Q.value = 0.8;
  const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 28;
  lp.connect(hp); hp.connect(out);
  out.connect(rig.buses.mus.g);

  const root = degFreq(SCALES.hirajoshi, 0) / 4;      // D2, 73.4 Hz
  const add = (freq, type, level, detune) => {
    const o = ac.createOscillator();
    o.type = type; o.frequency.value = freq; o.detune.value = detune;
    const g = ac.createGain(); g.gain.value = level;
    o.connect(g); g.connect(lp); o.start();
    return g;
  };
  add(root, 'sawtooth', 0.10, -7);
  add(root, 'sawtooth', 0.10, 6);
  add(root * 0.5, 'sine', 0.11, 0);
  const fifth = add(root * 1.4983, 'triangle', 0.0, 3);   // A2
  const minor2 = add(root * 1.0595, 'sine', 0.0, 0);      // Eb — the unease
  const shimmer = add(root * 8, 'sine', 0.0, 4);

  const wobble = (rate, depth) => {
    const o = ac.createOscillator(); o.type = 'sine'; o.frequency.value = rate;
    const g = ac.createGain(); g.gain.value = depth;
    o.connect(g); g.connect(lp.frequency); o.start();
  };
  wobble(0.043, 90);
  wobble(0.017, 46);

  return {
    out, lp,
    set(level, tension, when) {
      out.gain.setTargetAtTime(level, when, 1.4);
      fifth.gain.setTargetAtTime(0.085 * clamp01(tension * 1.6), when, 2.0);
      minor2.gain.setTargetAtTime(0.030 * clamp01((tension - 0.45) * 2.2), when, 2.4);
      shimmer.gain.setTargetAtTime(0.010 * clamp01((tension - 0.30) * 1.8), when, 3.0);
      lp.frequency.setTargetAtTime(240 + 330 * clamp01(tension), when, 2.2);
    },
  };
}

// -----------------------------------------------------------------------------
//  7. ambience beds
// -----------------------------------------------------------------------------

// Wind. Four bands, each doing a different job:
//   rumble   — the pressure you feel rather than hear
//   body     — the mass of moving air; its centre frequency rides the gust
//   whistle  — a high-Q resonance that only speaks at the top of a gust. This
//              is the layer that makes wind read as wind and not as hiss.
//   hiss     — air over grass and cloth
// The body layer is two decorrelated sources panned wide, which gives the bed
// its width without any help from the reverb.
function buildWind(rig) {
  const ac = rig.ac;
  const out = ac.createGain(); out.gain.value = 1.0;
  out.connect(rig.buses.amb.g);

  const layer = (opts) => {
    const src = ac.createBufferSource();
    src.buffer = opts.pink ? rig.noiseP : rig.noiseW;
    src.loop = true; src.playbackRate.value = opts.rate || 1;
    const f = ac.createBiquadFilter();
    f.type = opts.type; f.frequency.value = opts.f; f.Q.value = opts.q || 1;
    const g = ac.createGain(); g.gain.value = 0;
    const p = ac.createStereoPanner(); p.pan.value = opts.pan || 0;
    src.connect(f); f.connect(g); g.connect(p); p.connect(out);
    src.start(0, rig.rng() * 4);
    return { src, f, g, p };
  };

  const rumble = layer({ pink: true,  type: 'lowpass',  f: 150,  q: 0.9, rate: 0.85 });
  const bodyL  = layer({ pink: true,  type: 'bandpass', f: 500,  q: 1.0, rate: 0.97, pan: -0.62 });
  const bodyR  = layer({ pink: true,  type: 'bandpass', f: 520,  q: 1.0, rate: 1.04, pan: 0.62 });
  const whis1  = layer({ pink: false, type: 'bandpass', f: 1400, q: 11,  rate: 1.00, pan: -0.35 });
  const whis2  = layer({ pink: false, type: 'bandpass', f: 2100, q: 15,  rate: 1.00, pan: 0.42 });
  const hiss   = layer({ pink: false, type: 'bandpass', f: 5200, q: 0.55, rate: 1.00, pan: 0 });

  // slow uncorrelated LFOs sweeping the resonances, so nothing sits still
  const sweep = (target, rate, depth) => {
    const o = ac.createOscillator(); o.type = 'sine'; o.frequency.value = rate;
    const g = ac.createGain(); g.gain.value = depth;
    o.connect(g); g.connect(target); o.start();
  };
  sweep(whis1.f.frequency, 0.071, 420);
  sweep(whis2.f.frequency, 0.113, 560);
  sweep(bodyL.f.frequency, 0.037, 130);
  sweep(bodyR.f.frequency, 0.029, 150);

  return {
    out,
    // gust 0..1 normalised gust energy; amt overall strength (altitude and
    // exposure); shelter 0..1 how much terrain is in the way.
    set(gust, amt, when, shelter = 0) {
      const tc = 0.14, tcf = 0.30;
      const g2 = gust * gust;
      const s = 1 - shelter * 0.55;
      rumble.g.gain.setTargetAtTime(0.135 * amt * s * (0.6 + 0.4 * gust), when, tc);
      const bodyAmt = 0.115 * amt * s * (0.45 + 0.55 * gust);
      bodyL.g.gain.setTargetAtTime(bodyAmt, when, tc);
      bodyR.g.gain.setTargetAtTime(bodyAmt * 0.94, when, tc);
      bodyL.f.frequency.setTargetAtTime(360 + 620 * gust, when, tcf);
      bodyR.f.frequency.setTargetAtTime(400 + 700 * gust, when, tcf);
      whis1.g.gain.setTargetAtTime(0.072 * amt * s * Math.pow(gust, 2.1), when, tc);
      whis2.g.gain.setTargetAtTime(0.052 * amt * s * Math.pow(gust, 2.6), when, tc);
      whis1.f.frequency.setTargetAtTime(1050 + 1500 * gust, when, tcf);
      whis2.f.frequency.setTargetAtTime(1700 + 2100 * g2, when, tcf);
      hiss.g.gain.setTargetAtTime(0.052 * amt * s * Math.pow(gust, 1.6), when, tc);
      hiss.f.frequency.setTargetAtTime(4200 + 2600 * gust, when, tcf);
    },
  };
}

// Ocean. A distance-mixed bed hung on a panner at the nearest point of shore,
// so the surf genuinely comes from the water, plus discrete breaking waves
// scheduled by the frame loop.
function buildOcean(rig) {
  const ac = rig.ac;
  const panner = ac.createPanner();
  panner.panningModel = 'equalpower'; panner.distanceModel = 'inverse';
  panner.refDistance = 40; panner.maxDistance = 900; panner.rolloffFactor = 0.55;
  panner.connect(rig.buses.amb.g);

  const mkLayer = (type, f, q, pink, rate) => {
    const src = ac.createBufferSource();
    src.buffer = pink ? rig.noiseP : rig.noiseW;
    src.loop = true; src.playbackRate.value = rate;
    const fl = ac.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
    const g = ac.createGain(); g.gain.value = 0;
    src.connect(fl); fl.connect(g); g.connect(panner);
    src.start(0, rig.rng() * 4);
    return { src, fl, g };
  };
  const body = mkLayer('lowpass', 520, 0.8, true, 0.8);
  const foam = mkLayer('bandpass', 2200, 0.7, false, 1.0);

  // the long swell: a very slow LFO on the body, so the sea breathes
  const swellOsc = ac.createOscillator(); swellOsc.type = 'sine'; swellOsc.frequency.value = 0.085;
  const swellG = ac.createGain(); swellG.gain.value = 0;
  swellOsc.connect(swellG); swellG.connect(body.g.gain); swellOsc.start();

  return {
    panner,
    set(near, when, x, y, z) {
      setPos(panner, x, y, z);
      body.g.gain.setTargetAtTime(0.26 * near, when, 0.4);
      foam.g.gain.setTargetAtTime(0.085 * Math.pow(near, 1.8), when, 0.4);
      body.fl.frequency.setTargetAtTime(360 + 700 * near, when, 0.6);
      swellG.gain.setTargetAtTime(0.09 * near, when, 0.6);
    },
  };
}

// Grass. A broad rustle that swells with the gust, plus a close "wade" layer
// that only exists while the player is moving through the field, chopped by an
// LFO locked to the stride rate.
function buildGrass(rig) {
  const ac = rig.ac;
  const out = ac.createGain(); out.gain.value = 1;
  out.connect(rig.buses.amb.g);

  const mkLayer = (f, q, pan, rate) => {
    const src = ac.createBufferSource();
    src.buffer = rig.noiseW; src.loop = true; src.playbackRate.value = rate;
    const fl = ac.createBiquadFilter(); fl.type = 'bandpass'; fl.frequency.value = f; fl.Q.value = q;
    const g = ac.createGain(); g.gain.value = 0;
    const p = ac.createStereoPanner(); p.pan.value = pan;
    src.connect(fl); fl.connect(g); g.connect(p); p.connect(out);
    src.start(0, rig.rng() * 4);
    return { src, fl, g };
  };
  const wideL = mkLayer(2600, 0.85, -0.5, 0.99);
  const wideR = mkLayer(2900, 0.85, 0.5, 1.03);
  const wade = mkLayer(1500, 0.7, 0, 1.0);
  const wadeAM = ac.createOscillator(); wadeAM.type = 'sine'; wadeAM.frequency.value = 2.2;
  const wadeAMG = ac.createGain(); wadeAMG.gain.value = 0;
  wadeAM.connect(wadeAMG); wadeAMG.connect(wade.g.gain); wadeAM.start();

  return {
    set(gust, cover, speed, strideHz, when) {
      const a = cover * (0.16 + 0.84 * Math.pow(gust, 1.5));
      wideL.g.gain.setTargetAtTime(0.115 * a, when, 0.18);
      wideR.g.gain.setTargetAtTime(0.108 * a, when, 0.18);
      wideL.fl.frequency.setTargetAtTime(2100 + 1500 * gust, when, 0.4);
      wideR.fl.frequency.setTargetAtTime(2400 + 1700 * gust, when, 0.4);
      const w = cover * clamp01(speed / 5.5);
      wade.g.gain.setTargetAtTime(0.10 * w, when, 0.12);
      wadeAMG.gain.setTargetAtTime(0.075 * w, when, 0.12);
      wadeAM.frequency.setTargetAtTime(Math.max(0.5, strideHz * 2), when, 0.2);
    },
  };
}

// -----------------------------------------------------------------------------
//  8. the adaptive score
//
//  A lookahead scheduler on an eighth-note grid. Three tiers with hysteresis
//  choose the material; the layer gains crossfade continuously so a transition
//  is a change of weather, not a cut.
//
//    explore  — 58 bpm, hirajoshi. A shakuhachi phrase every four bars over a
//               sparse koto and a quiet drone. The silences are the point.
//    tension  — 72 bpm, in-sen. Koto tremolo two bars on two bars off, soft
//               odaiko on 1 and 3, rim ticks, the fifth arrives in the drone.
//    combat   — 96 bpm, in-sen. A taiko ostinato with shime sixteenths, biwa
//               stabs on the bar, a koto ostinato underneath, short high
//               shakuhachi cries and kakizume runs.
// -----------------------------------------------------------------------------
function buildScore(rig) {
  const drone = buildDrone(rig);
  const lv = { flute: 1, koto: 1, biwa: 0, taiko: 0 };

  return {
    drone,
    step: 0,
    nextTime: 0,
    tier: 0,             // 0 explore, 1 tension, 2 combat
    intensity: 0,
    smooth: 0,
    scale: SCALES.hirajoshi,
    phrase: [],
    lastPhraseBar: -99,
    bpm: 58,

    begin(when) { this.nextTime = when + 0.15; },

    tick(when, dt, state) {
      // --- smooth the intensity, choose the tier with hysteresis ---
      const k = 1 - Math.exp(-dt / 1.6);
      this.smooth += (this.intensity - this.smooth) * k;
      const s = this.smooth;
      if (this.tier === 0 && s > 0.34) this.tier = 1;
      else if (this.tier === 1 && s > 0.68) this.tier = 2;
      else if (this.tier === 1 && s < 0.24) this.tier = 0;
      else if (this.tier === 2 && s < 0.56) this.tier = 1;
      this.bpm = this.tier === 0 ? 58 : this.tier === 1 ? 72 : 96;
      this.scale = this.tier === 0 ? SCALES.hirajoshi : SCALES.insen;

      lv.flute = lerp(1.0, 0.62, clamp01(s * 1.2));
      lv.koto = lerp(0.85, 1.0, clamp01(s * 1.5));
      lv.biwa = clamp01((s - 0.5) * 2.6);
      lv.taiko = clamp01((s - 0.24) * 1.9);

      drone.set(lerp(0.16, 0.48, clamp01(s * 1.25)), s, when);

      // --- lookahead scheduler ---
      if (this.nextTime < when) this.nextTime = when + 0.05;   // recover from a stall
      const eighth = 30 / this.bpm;
      let guard = 0;
      while (this.nextTime < when + 0.55 && guard++ < 48) {
        this.emit(this.step, this.nextTime, eighth, lv);
        this.step++;
        this.nextTime += eighth;
      }
    },

    emit(step, t, eighth, lv) {
      const sub = step % 8;
      const bar = Math.floor(step / 8);
      const r = rig.rng;
      const sc = this.scale;
      const tier = this.tier;

      // ---------------- taiko ----------------
      if (lv.taiko > 0.02) {
        const g = lv.taiko;
        if (tier >= 2) {
          const patt = [1.0, 0, 0.55, 0, 0.85, 0, 0.55, 0.45];
          if (patt[sub] > 0) taiko(rig, t, { gain: patt[sub] * g * (sub === 0 ? 1.15 : 1), kind: 'do', pan: -0.12 });
          for (let i = 0; i < 2; i++) {
            if (r() < 0.72) taiko(rig, t + i * eighth * 0.5, { gain: (i ? 0.35 : 0.55) * g, kind: 'shime', pan: 0.3 });
          }
          if (sub === 6 && bar % 4 === 3) {
            for (let i = 0; i < 4; i++) taiko(rig, t + i * eighth * 0.25, { gain: (0.5 + i * 0.16) * g, kind: 'ka', pan: 0.4 - i * 0.2 });
          }
        } else {
          if (sub === 0) taiko(rig, t, { gain: 0.65 * g, kind: 'do', pan: -0.1 });
          if (sub === 4) taiko(rig, t, { gain: 0.42 * g, kind: 'do', pan: -0.1 });
          if ((sub === 3 || sub === 7) && r() < 0.5) taiko(rig, t, { gain: 0.3 * g, kind: 'ka', pan: 0.35 });
        }
      }

      // ---------------- koto ----------------
      if (tier === 0) {
        if (sub === 0 && bar % 2 === 0) koto(rig, t, degFreq(sc, bar % 4 === 0 ? -5 : -3), 3.4, { gain: 0.95 * lv.koto });
        if (sub === 4 && bar % 4 === 1) {
          koto(rig, t, degFreq(sc, 2), 2.4, { gain: 0.55 * lv.koto, oshi: 100 });
          koto(rig, t + eighth * 0.55, degFreq(sc, 4), 2.2, { gain: 0.42 * lv.koto });
        }
        // kakizume: a fast descending sweep across the strings
        if (sub === 2 && bar % 8 === 5) {
          for (let i = 0; i < 6; i++) koto(rig, t + i * 0.055, degFreq(sc, 7 - i), 1.4, { gain: 0.4 * lv.koto, bright: 1.15 });
        }
      } else if (tier === 1) {
        if (bar % 4 < 2) {
          const deg = bar % 8 < 4 ? -5 : -4;
          for (let i = 0; i < 2; i++) koto(rig, t + i * eighth * 0.5, degFreq(sc, deg), 0.9, { gain: (i ? 0.34 : 0.5) * lv.koto });
        }
        if (sub === 6 && bar % 4 === 3) koto(rig, t, degFreq(sc, 3), 2.6, { gain: 0.6 * lv.koto, oshi: 100 });
      } else {
        const pat = [-5, -5, -3, -5, -2, -5, -3, -1];
        if (sub % 2 === 0 || r() < 0.5) {
          koto(rig, t, degFreq(sc, pat[sub]), 0.85, { gain: (sub % 4 === 0 ? 0.62 : 0.4) * lv.koto });
        }
        if (sub === 0 && bar % 2 === 1) {
          for (let i = 0; i < 5; i++) koto(rig, t + i * 0.045, degFreq(sc, 9 - i), 1.1, { gain: 0.34 * lv.koto, bright: 1.2 });
        }
      }

      // ---------------- biwa ----------------
      if (lv.biwa > 0.03) {
        if (sub === 0 && bar % 2 === 0) {
          const d = bar % 4 === 0 ? -5 : -3;
          for (let i = 0; i < 3; i++) biwa(rig, t + i * 0.026, degFreq(sc, d + i * 2), 1.5, { gain: (0.85 - i * 0.16) * lv.biwa });
        }
        if (sub === 5 && r() < 0.45) biwa(rig, t, degFreq(sc, 0), 1.1, { gain: 0.5 * lv.biwa });
      }

      // ---------------- shakuhachi ----------------
      // The flute plays phrases, not grid notes: a phrase is generated whole
      // and then drained one note at a time.
      if (this.phrase.length && this.phrase[0].step <= step) {
        while (this.phrase.length && this.phrase[0].step <= step) {
          const n = this.phrase.shift();
          shakuhachi(rig, t + (n.frac || 0) * eighth, degFreq(sc, n.deg), n.dur, {
            gain: n.gain * lv.flute, accent: n.accent, breath: n.breath || 1, bend: n.bend || 0,
          });
        }
      } else if (this.phrase.length === 0 && sub === 0) {
        const every = tier === 2 ? 2 : 4;
        if (bar % every === 0 && bar !== this.lastPhraseBar) {
          this.lastPhraseBar = bar;
          this.phrase = this.makePhrase(step, tier, eighth);
        }
      }
    },

    // Exploration phrases wander and settle on a long note; combat phrases are
    // two-note cries high on the instrument.
    makePhrase(step, tier, eighth) {
      const r = rig.rng;
      const out = [];
      if (tier === 2) {
        const top = 6 + Math.floor(r() * 3);
        out.push({ step: step + 1, deg: top, dur: 0.7, gain: 1.0, accent: true, breath: 1.5 });
        out.push({ step: step + 3, deg: top - 2, dur: 1.1, gain: 0.8, accent: false, breath: 1.3, bend: -60 });
        return out;
      }
      const len = tier === 0 ? 3 + Math.floor(r() * 4) : 3 + Math.floor(r() * 3);
      let deg = (r() < 0.5 ? 0 : 2) + (r() < 0.3 ? 5 : 0);
      let s = step + (tier === 0 ? 2 : 1);
      for (let i = 0; i < len; i++) {
        const last = i === len - 1;
        const dur = last ? (tier === 0 ? 2.6 + r() * 2.2 : 1.8 + r() * 1.2)
                         : (tier === 0 ? 0.9 + r() * 1.6 : 0.7 + r() * 0.9);
        out.push({
          step: s, deg, dur,
          gain: last ? 0.95 : 0.72 + r() * 0.22,
          accent: i === 0 && r() < 0.5,
          breath: last ? 1.25 : 1.0,
          bend: last && r() < 0.4 ? -45 : 0,
          frac: i === 0 ? 0 : r() * 0.3,
        });
        deg = clamp(deg + (r() < 0.62 ? (r() < 0.5 ? 1 : -1) : (r() < 0.5 ? 2 : -2)), -2, 9);
        s += Math.max(1, Math.round((dur / eighth) * 0.55));
      }
      return out;
    },
  };
}

// -----------------------------------------------------------------------------
//  9. createAudio
// -----------------------------------------------------------------------------

// What the player is standing on, from the single source of truth. These
// thresholds mirror the grass field's own exclusion rules, so the ear and the
// eye agree about where the meadow is.
function surfaceAt(world, x, z) {
  if (!world || !world.heightAt) return 'grass';
  const h = world.heightAt(x, z);
  if (h < 0.30) return 'water';
  if (h < 2.6) return 'sand';
  const s = world.slopeAt ? world.slopeAt(x, z) : 0;
  if (s > 0.40 || h > 150) return 'rock';
  return 'grass';
}

// How much of the ground around the player is grass — drives the rustle bed.
function grassCover(world, x, z) {
  if (!world || !world.heightAt) return 0.6;
  let n = 0;
  const R = 16;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const px = x + Math.cos(a) * R, pz = z + Math.sin(a) * R;
    const h = world.heightAt(px, pz);
    if (h < 3 || h > 150) continue;
    if ((world.slopeAt ? world.slopeAt(px, pz) : 0) > 0.36) continue;
    n++;
  }
  return n / 6;
}

// Nearest water. Ring-marches outward and returns both the distance and a point
// on the shore to hang the surf panner on. Called at 4 Hz, not per frame.
function coastProbe(world, x, z) {
  if (!world || !world.heightAt) return { dist: 9999, x, y: 0, z };
  const rings = [10, 26, 52, 90, 140, 205, 285, 380];
  const dirs = 10;
  for (let ri = 0; ri < rings.length; ri++) {
    const R = rings[ri];
    let best = 9999, bx = x, bz = z;
    for (let a = 0; a < dirs; a++) {
      const ang = (a / dirs) * Math.PI * 2 + ri * 0.31;
      const px = x + Math.cos(ang) * R, pz = z + Math.sin(ang) * R;
      if (world.heightAt(px, pz) < 0.4) {
        const d = Math.hypot(px - x, pz - z);
        if (d < best) { best = d; bx = px; bz = pz; }
      }
    }
    if (best < 9999) return { dist: best, x: bx, y: 0.4, z: bz };
  }
  return { dist: 9999, x, y: 0, z };
}

export function createAudio(ctx) {
  let rig = null, started = false;
  let wind = null, ocean = null, grass = null, score = null;

  const st = {
    t: 0,
    surface: 'grass',
    cover: 0.7,
    coast: { dist: 9999, x: 0, y: 0, z: 0 },
    probeTimer: 0,
    bedTimer: 0,
    stridePhase: 0,
    footLeft: false,
    nextBird: 2.0,
    nextInsect: 3.0,
    nextFrog: 8.0,
    nextOwl: 12.0,
    nextBamboo: 9.0,
    nextWave: 3.0,
    combatHold: 0,
    intensity: 0,
  };

  // Where the ear is. Panner positions are world space, so the listener has to
  // be the camera or nothing lines up.
  function updateListener(rg, camera) {
    const L = rg.ac.listener;
    let px = 0, py = 2, pz = 0, fx = 0, fy = 0, fz = -1, ux = 0, uy = 1, uz = 0;
    const m = camera && camera.matrixWorld && camera.matrixWorld.elements;
    if (m) {
      px = m[12]; py = m[13]; pz = m[14];
      fx = -m[8]; fy = -m[9]; fz = -m[10];
      ux = m[4]; uy = m[5]; uz = m[6];
    }
    if (L.positionX) {
      L.positionX.value = px; L.positionY.value = py; L.positionZ.value = pz;
      L.forwardX.value = fx; L.forwardY.value = fy; L.forwardZ.value = fz;
      L.upX.value = ux; L.upY.value = uy; L.upZ.value = uz;
    } else {
      L.setPosition(px, py, pz);
      L.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  // Solar altitude drives every creature layer. Golden hour (t≈0.726) sits at
  // altitude ≈ +0.15: the birds are still going and the first insects are up.
  function creatureWeights(todT) {
    const a = Math.sin((todT - 0.25) * Math.PI * 2);
    return {
      day: clamp01(a * 3.2),
      insect: clamp01(1 - Math.abs(a + 0.13) * 3.4),
      night: clamp01(-a * 3.0),
    };
  }

  function bumpCombat(seconds) { st.combatHold = Math.max(st.combatHold, seconds * 3.2); }

  // One frame of everything. `s` is a snapshot, so the offline renderer can
  // feed a scripted world through exactly this code path.
  function frame(dt, s) {
    if (!rig) return;
    const now = rig.ac.currentTime;
    st.t += dt;
    if (s !== snap) { snap.px = s.px; snap.py = s.py; snap.pz = s.pz; }

    updateListener(rig, s.camera);

    // ---- slow probes: terrain queries are not free, so 4 Hz ----
    st.probeTimer -= dt;
    if (st.probeTimer <= 0) {
      st.probeTimer = 0.25;
      st.surface = surfaceAt(s.world, s.px, s.pz);
      st.cover = grassCover(s.world, s.px, s.pz);
      st.coast = coastProbe(s.world, s.px, s.pz);
    }

    // ---- beds at 20 Hz ----
    st.bedTimer -= dt;
    if (st.bedTimer <= 0) {
      st.bedTimer = 0.05;
      const gn = clamp01((s.gust - 0.42) / 0.56);
      // exposure: high ground and open beach are windy, valley floors are not
      const alt = clamp01(s.py / 170);
      const exposure = lerp(0.72, 1.35, alt) * (st.surface === 'rock' ? 1.1 : 1.0);
      wind.set(gn, clamp01(s.windStrength * exposure), now, clamp01(1 - alt) * 0.25);

      const near = Math.pow(clamp01(1 - st.coast.dist / 330), 1.35);
      ocean.set(near, now, st.coast.x, st.coast.y, st.coast.z);

      const strideHz = s.speed > 0.1 ? s.speed / (s.sprinting ? 2.15 : 1.45) : 0;
      grass.set(gn, st.surface === 'grass' ? st.cover : st.cover * 0.25, s.speed, strideHz, now);
    }

    // ---- footsteps, driven purely by distance travelled ----
    if (s.speed > 0.25) {
      const stride = s.sprinting ? 2.15 : 1.45;
      st.stridePhase += (s.speed * dt) / stride;
      let guard = 0;
      while (st.stridePhase >= 1 && guard++ < 3) {
        st.stridePhase -= 1;
        st.footLeft = !st.footLeft;
        const g = clamp(0.5 + s.speed / 7.2, 0.5, 1.15);
        sfxFootstep(rig, now + 0.005, {
          surface: st.surface, gain: g,
          x: s.px + (st.footLeft ? -0.25 : 0.25), y: s.py + 0.1, z: s.pz,
        });
        if (s.sprinting && rig.rng() < 0.5) sfxCloth(rig, now + 0.02, { gain: 0.7, x: s.px, y: s.py, z: s.pz, dur: 0.18 });
      }
    } else {
      if (st.stridePhase < 0.55) st.stridePhase = 0.55;   // land the next step promptly
      if (rig.rng() < dt * 0.22) sfxRattle(rig, now + 0.01, { gain: 0.35, x: s.px, y: s.py, z: s.pz });
    }

    // ---- wildlife ----
    const w = creatureWeights(s.tod);
    const near = clamp01(1 - st.coast.dist / 330);
    const R = rig.rng;

    st.nextBird -= dt * (0.25 + w.day * 1.6);
    if (st.nextBird <= 0) {
      st.nextBird = 1.4 + R() * 4.5;
      if (w.day > 0.06) {
        const a = R() * Math.PI * 2, r = 10 + R() * 34;
        sfxBird(rig, now + 0.02, {
          gain: 0.55 + w.day * 0.6,
          x: s.px + Math.cos(a) * r, y: s.py + 4 + R() * 7, z: s.pz + Math.sin(a) * r,
        });
      }
    }

    st.nextInsect -= dt * (0.2 + w.insect * 2.2);
    if (st.nextInsect <= 0) {
      st.nextInsect = 0.6 + R() * 2.4;
      if (w.insect > 0.05) {
        const a = R() * Math.PI * 2, r = 5 + R() * 22;
        sfxInsect(rig, now + 0.02, {
          gain: 0.5 + w.insect * 0.8,
          kind: R() < 0.3 ? 'cicada' : 'cricket',
          x: s.px + Math.cos(a) * r, y: s.py + 0.6, z: s.pz + Math.sin(a) * r,
        });
      }
    }

    st.nextFrog -= dt * (0.2 + (w.insect + w.night) * 1.1 * near);
    if (st.nextFrog <= 0) {
      st.nextFrog = 3 + R() * 9;
      if (near > 0.35 && (w.insect > 0.15 || w.night > 0.15)) {
        const a = R() * Math.PI * 2, r = 8 + R() * 28;
        sfxFrog(rig, now + 0.02, { gain: 0.7, x: s.px + Math.cos(a) * r, y: s.py, z: s.pz + Math.sin(a) * r });
      }
    }

    st.nextOwl -= dt * (0.15 + w.night * 1.4);
    if (st.nextOwl <= 0) {
      st.nextOwl = 7 + R() * 16;
      if (w.night > 0.1) {
        const a = R() * Math.PI * 2, r = 25 + R() * 70;
        sfxOwl(rig, now + 0.02, { gain: 0.8, x: s.px + Math.cos(a) * r, y: s.py + 9, z: s.pz + Math.sin(a) * r });
      }
    }

    // bamboo: the knock is rare and deliberate, the creak rides the gust
    st.nextBamboo -= dt * (0.5 + s.gust * 0.9);
    if (st.nextBamboo <= 0) {
      st.nextBamboo = 8 + R() * 20;
      const a = R() * Math.PI * 2, r = 14 + R() * 40;
      const px = s.px + Math.cos(a) * r, pz = s.pz + Math.sin(a) * r;
      if (R() < 0.45) sfxBamboo(rig, now + 0.02, { gain: 0.85, x: px, y: s.py + 1.2, z: pz });
      else sfxBambooCreak(rig, now + 0.02, { gain: 0.6 + s.gust * 0.5, x: px, y: s.py + 2.5, z: pz });
    }

    // ---- breaking waves ----
    if (near > 0.10) {
      st.nextWave -= dt;
      if (st.nextWave <= 0) {
        const big = R() < 0.3;
        st.nextWave = (big ? 7 : 4) + R() * 5;
        const spread = 60 + R() * 120;
        const a = R() * Math.PI * 2;
        sfxWave(rig, now + 0.02, {
          gain: 0.55 + near * 0.75, big,
          x: st.coast.x + Math.cos(a) * spread * 0.4,
          y: 0.5,
          z: st.coast.z + Math.sin(a) * spread * 0.4,
        });
      }
    }

    // ---- player action sounds, straight off the input edges ----
    const inp = s.input;
    if (inp) {
      const p = { x: s.px, y: s.py, z: s.pz };
      if (inp.attack) { sfxWhoosh(rig, now + 0.02, p); bumpCombat(1.4); }
      if (inp.heavy) { sfxWhoosh(rig, now + 0.02, { ...p, heavy: true }); bumpCombat(1.8); }
      if (inp.parry) { sfxClash(rig, now + 0.01, p); sfxSpark(rig, now + 0.015, p); bumpCombat(2.2); }
      if (inp.dodge) {
        sfxCloth(rig, now + 0.01, { ...p, gain: 1.2, dur: 0.3 });
        sfxRattle(rig, now + 0.04, { ...p, gain: 0.9 });
        sfxFootstep(rig, now + 0.22, { ...p, surface: st.surface, gain: 1.15 });
      }
      if (inp.interact) sfxSheathe(rig, now + 0.01, p);
      if (inp.mount) sfxLeather(rig, now + 0.01, p);
      if (inp.wind) sfxGust(rig, now + 0.01, {});
      if (inp.stanceCycle) {
        sfxTsuba(rig, now + 0.01, p);
        koto(rig, now + 0.05, degFreq(score.scale, 4), 1.6, { gain: 0.5 });
      }
    }

    // ---- events queued by other systems ----
    if (s.events && s.events.length) {
      for (const e of s.events) api.play(e.name, e);
      s.events.length = 0;
    }

    // ---- combat heat decays back to exploration on its own ----
    if (st.combatHold > 0) st.combatHold = Math.max(0, st.combatHold - dt);
    score.intensity = Math.max(st.intensity, st.combatHold > 0 ? clamp01(st.combatHold / 6) : 0);
    score.tick(now, dt, s);
  }

  // A snapshot of the live game for frame().
  const snap = { events: [] };
  function gather(c) {
    const p = (c.player && c.player.position) || { x: 0, y: 0, z: 0 };
    snap.px = p.x; snap.py = p.y; snap.pz = p.z;
    snap.speed = c.player ? (c.player.speed || 0) : 0;
    snap.sprinting = !!(c.input && c.input.sprint && snap.speed > 3.6);
    snap.gust = (c.wind && c.wind.gust) ? c.wind.gust() : 0.7;
    snap.windStrength = c.wind && c.wind.strength != null ? c.wind.strength : 1;
    snap.tod = c.tod ? c.tod.t : 0.726;
    snap.world = c.world;
    snap.camera = c.camera;
    snap.input = c.input;
    // other lanes can queue one-shots without knowing anything about this file
    if (c.audioEvents && c.audioEvents.length) {
      for (const e of c.audioEvents) snap.events.push(e);
      c.audioEvents.length = 0;
    }
    return snap;
  }

  const api = {
    get started() { return started; },
    get context() { return rig ? rig.ac : null; },
    get voiceCount() { return rig ? rig.active.length : 0; },

    // Must be called from a user gesture in the browser. Safe to call twice.
    // Passing a BaseAudioContext builds the whole rig on that context instead,
    // which is how the offline renderer works.
    start(injected = null) {
      if (started) {
        if (rig && rig.ac.state === 'suspended' && rig.ac.resume) rig.ac.resume();
        return true;
      }
      const AC = injected || (typeof AudioContext !== 'undefined' ? new AudioContext({ latencyHint: 'interactive' }) : null);
      if (!AC) return false;
      rig = buildRig(AC);
      wind = buildWind(rig);
      ocean = buildOcean(rig);
      grass = buildGrass(rig);
      score = buildScore(rig);
      score.begin(AC.currentTime);
      // fade the master in, so the beds never click on
      rig.out.gain.setValueAtTime(EPS, AC.currentTime);
      rig.out.gain.exponentialRampToValueAtTime(0.72, AC.currentTime + 1.4);
      // An OfflineAudioContext also reports state 'suspended', and calling
      // resume() on one before startRendering() throws InvalidStateError.
      const offline = typeof AC.startRendering === 'function';
      if (!offline && AC.state === 'suspended' && AC.resume) AC.resume();
      started = true;
      return true;
    },

    stop() {
      if (!rig) return;
      const t = rig.ac.currentTime;
      rig.out.gain.cancelScheduledValues(t);
      rig.out.gain.setValueAtTime(rig.out.gain.value, t);
      rig.out.gain.exponentialRampToValueAtTime(EPS, t + 0.6);
    },

    // 0..1, or one of the three named states.
    setIntensity(v) {
      if (typeof v === 'string') v = v === 'combat' ? 1 : v === 'tension' ? 0.5 : 0;
      st.intensity = clamp01(+v || 0);
      return st.intensity;
    },
    get intensity() { return score ? score.smooth : st.intensity; },
    get tier() { return score ? ['explore', 'tension', 'combat'][score.tier] : 'explore'; },

    // Anyone may fire a one-shot. Unknown names are ignored, never thrown.
    play(name, o = {}) {
      if (!rig) return;
      const t = rig.ac.currentTime + (o.delay || 0) + 0.005;
      const p = {
        x: o.x != null ? o.x : (snap.px || 0),
        y: o.y != null ? o.y : (snap.py || 0),
        z: o.z != null ? o.z : (snap.pz || 0),
        gain: o.gain != null ? o.gain : 1,
      };
      switch (name) {
        case 'footstep': sfxFootstep(rig, t, { ...p, surface: o.surface || st.surface }); break;
        case 'whoosh': sfxWhoosh(rig, t, p); break;
        case 'whoosh_heavy': sfxWhoosh(rig, t, { ...p, heavy: true }); break;
        case 'clash': sfxClash(rig, t, p); bumpCombat(2.0); break;
        case 'parry_spark': sfxSpark(rig, t, p); break;
        case 'impact': case 'thud': sfxImpact(rig, t, p); bumpCombat(2.0); break;
        case 'sheathe': sfxSheathe(rig, t, p); break;
        case 'draw': sfxDraw(rig, t, p); break;
        case 'tsuba': sfxTsuba(rig, t, p); break;
        case 'rattle': sfxRattle(rig, t, p); break;
        case 'cloth': sfxCloth(rig, t, p); break;
        case 'leather': sfxLeather(rig, t, p); break;
        case 'bamboo': sfxBamboo(rig, t, p); break;
        case 'bamboo_creak': sfxBambooCreak(rig, t, p); break;
        case 'bird': sfxBird(rig, t, p); break;
        case 'insect': sfxInsect(rig, t, { ...p, kind: o.kind }); break;
        case 'frog': sfxFrog(rig, t, p); break;
        case 'owl': sfxOwl(rig, t, p); break;
        case 'wave': sfxWave(rig, t, { ...p, big: !!o.big }); break;
        case 'gust': sfxGust(rig, t, p); break;
        case 'rin': sfxRin(rig, t, p); break;
        case 'koto': koto(rig, t, o.freq || degFreq(SCALES.hirajoshi, o.deg || 0), o.dur || 2.0, p); break;
        case 'flute': shakuhachi(rig, t, o.freq || degFreq(SCALES.hirajoshi, o.deg || 0), o.dur || 2.0, p); break;
        case 'taiko': taiko(rig, t, { ...p, kind: o.kind || 'do' }); break;
        default: break;
      }
    },

    update(dt, c) {
      if (!started || !rig) return;
      frame(Math.min(dt, 0.1), gather(c || ctx));
    },

    // Step the whole system with an explicit snapshot instead of the live ctx.
    // The offline renderer is the only caller.
    stepRaw(dt, s) { if (started && rig) frame(Math.min(dt, 0.1), s); },

    // ------------------------------------------------------------------
    //  Offline verification. Builds a SECOND, complete rig on an
    //  OfflineAudioContext and steps it through a scripted scenario at 1/60 s
    //  using OfflineAudioContext.suspend(), so what gets rendered is the same
    //  code path the game runs — not a special test tone. The player walks the
    //  real island, so the surface and coast logic are genuinely exercised.
    //  tools/audio-render.sh turns the result into a WAV, a waveform and a
    //  spectrogram.
    // ------------------------------------------------------------------
    async renderOffline({ seconds = 20, sampleRate = 44100, scenario = 'ambience', step = 1 / 60 } = {}) {
      const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
      if (!OAC) throw new Error('no OfflineAudioContext in this environment');
      const oac = new OAC({ numberOfChannels: 2, length: Math.ceil(seconds * sampleRate), sampleRate });

      const sub = createAudio(ctx);        // a private instance; the live one plays on
      sub.start(oac);

      const SC = SCENARIOS[scenario] || SCENARIOS.ambience;
      const world = (ctx && ctx.world) || null;
      const cam = { matrixWorld: { elements: new Float32Array(16) } };
      const inp = {
        attack: false, heavy: false, parry: false, dodge: false,
        interact: false, mount: false, wind: false, sprint: false, stanceCycle: 0,
      };
      const state = {
        px: SC.start[0], py: 0, pz: SC.start[1], speed: 0, sprinting: false,
        gust: 0.7, windStrength: 1, tod: SC.tod, world, camera: cam, input: inp, events: [],
      };

      let fired = 0;
      const drive = (t) => {
        for (const k in inp) inp[k] = (k === 'stanceCycle' ? 0 : false);
        SC.drive(state, t, step);
        while (fired < SC.events.length && SC.events[fired][0] <= t) {
          const [, k, val] = SC.events[fired++];
          if (k === 'intensity') sub.setIntensity(val);
          else if (k in inp) inp[k] = val;
          else state.events.push({ name: k, ...(val || {}) });
        }
        if (world && world.heightAt) state.py = world.heightAt(state.px, state.pz);
        // a camera three metres behind and two above, looking at the player
        const e = cam.matrixWorld.elements;
        e[0] = 1; e[1] = 0; e[2] = 0; e[3] = 0;
        e[4] = 0; e[5] = 1; e[6] = 0; e[7] = 0;
        e[8] = 0; e[9] = 0; e[10] = 1; e[11] = 0;      // forward = -z
        e[12] = state.px; e[13] = state.py + 2.0; e[14] = state.pz + 3.0; e[15] = 1;
        sub.stepRaw(step, state);
      };

      for (let t = step; t < seconds - step; t += step) {
        const at = t;
        oac.suspend(at)
          .then(() => { drive(at); return oac.resume(); })
          .catch(() => { /* a suspend past the end of the render is not an error */ });
      }
      return await oac.startRendering();
    },
  };

  // Scenarios for the offline renderer. Each drives the same public surface a
  // player would: it moves across real terrain, it fights, it changes the hour.
  const SCENARIOS = {
    // Golden hour on the west ridge, walking down toward the headland shore.
    // Wind gusts, birds and the first insects, bamboo, waves as the coast nears.
    ambience: {
      start: [-536, 334], tod: 0.726,
      drive(s, t, dt) {
        s.gust = 0.72 + Math.sin(t * 0.7) * 0.2 + Math.sin(t * 1.93) * 0.12;
        s.windStrength = 1.0;
        s.speed = t < 1.5 ? 0 : (t > 15 ? 6.6 : 3.2);
        s.sprinting = t > 15;
        s.input.sprint = s.sprinting;
        s.px += -0.83 * s.speed * dt;
        s.pz += 0.55 * s.speed * dt;
      },
      events: [
        [2.0, 'intensity', 0],
        [6.0, 'wind', true],
        [11.0, 'bamboo', { gain: 1 }],
        [13.5, 'interact', true],
      ],
    },
    // A fight. Intensity ramps to combat and the sword work is real input edges.
    combat: {
      start: [-536, 334], tod: 0.726,
      drive(s, t, dt) {
        s.gust = 0.7 + Math.sin(t * 0.9) * 0.22;
        s.speed = (t % 4 < 2.2) ? 5.4 : 0.6;
        s.sprinting = s.speed > 4;
        s.input.sprint = s.sprinting;
        s.px += Math.cos(t * 0.5) * s.speed * dt;
        s.pz += Math.sin(t * 0.5) * s.speed * dt;
      },
      events: [
        [0.5, 'intensity', 0.5],
        [3.0, 'intensity', 1.0],
        [4.0, 'draw', {}],
        [5.2, 'attack', true], [5.9, 'attack', true], [6.7, 'heavy', true],
        [7.4, 'clash', {}], [8.1, 'parry', true], [8.8, 'impact', {}],
        [9.6, 'attack', true], [10.1, 'attack', true], [10.9, 'heavy', true],
        [11.6, 'clash', {}], [12.4, 'dodge', true], [13.2, 'impact', {}],
        [14.0, 'attack', true], [14.6, 'clash', {}], [15.4, 'heavy', true],
        [16.4, 'sheathe', {}],
        [17.0, 'intensity', 0.0],
      ],
    },
    // Deep night on the same ridge: owls, low wind, the drone, no birds.
    night: {
      start: [-536, 334], tod: 0.92,
      drive(s, t, dt) {
        s.gust = 0.55 + Math.sin(t * 0.42) * 0.18;
        s.windStrength = 0.75;
        s.speed = (t > 4 && t < 12) ? 2.6 : 0;
        s.px += -0.7 * s.speed * dt;
        s.pz += 0.7 * s.speed * dt;
      },
      events: [
        [1.0, 'intensity', 0.35],
        [3.0, 'owl', { x: -560, y: 122, z: 380 }],
        [9.0, 'owl', { x: -500, y: 118, z: 300 }],
        [14.0, 'frog', {}],
      ],
    },
    // The west headland beach: standing at the waterline, then walking up the
    // sand until it turns to meadow. Verified with tools/pick.mjs — h = 0.89 m
    // with open water six metres away, NOT the -35 m of sea floor that a
    // plausible-looking coastal coordinate turns out to be.
    shore: {
      start: [-754, 350], tod: 0.70,
      drive(s, t, dt) {
        s.gust = 0.78 + Math.sin(t * 0.55) * 0.2;
        s.windStrength = 1.15;
        s.speed = t > 3 ? 2.6 : 0;
        s.px += 0.30 * s.speed * dt;
        s.pz += 0.95 * s.speed * dt;
      },
      events: [[1.0, 'intensity', 0]],
    },
  };

  return api;
}
