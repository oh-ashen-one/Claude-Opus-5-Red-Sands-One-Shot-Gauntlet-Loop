// Quality tier. Chosen from ?q= in the URL, else guessed from the device.
// The Studio renders the full tier at ~75fps; a laptop needs less.
const P = new URLSearchParams(location.search);
const asked = (P.get('q') || '').toLowerCase();

function guess() {
  // Rough: high-core Apple Silicon desktops take 'high'; anything else 'medium'.
  const cores = navigator.hardwareConcurrency || 8;
  if (cores >= 20) return 'high';
  if (cores >= 10) return 'medium';
  return 'low';
}

const tier = ['low', 'medium', 'high'].includes(asked) ? asked : guess();

// ---------------------------------------------------------------------------
// The tier table. Every field here is a CONTRACT with exactly one consumer, and
// the consumer is named. A field nobody reads is a lie told to the player via
// CONTROLS.md, so if you add one, wire it in the same commit.
//
//   pixelRatio  hard ceiling on renderer.setPixelRatio.
//               read by src/core/engine.js:9.
//   grass       blade-count scale, 1.0 = shipping density.
//               read by src/world/grass.js:45 -> DENSITY, applied at :710 as
//               `Math.max(1, Math.round(L.count * DENSITY))`. This is the
//               reference pattern for every count-like knob below: scale the
//               count at build time, never per frame, and never let it hit 0.
//   shadow      sun shadow map edge, texels.
//               read by src/world/sky.js:741.
//   trees       scatter-density scale for the forest, 1.0 = shipping density.
//               read by src/world/trees.js -> DENSITY, applied in the scatter
//               loop as `roll > maxProb(q) * DENSITY` and `roll > c.p * DENSITY`
//               — BOTH the cheap pre-reject and the classify probability, so
//               maxProb stays a valid upper bound and no cell is probed twice.
//               CFG.cell is untouched, so ?q=low is the same world drawn
//               cheaper rather than a different layout.
//   particles   instance-count scale for the vfx layers, 1.0 = shipping count.
//               NOT YET READ — src/world/vfx.js already has the setter
//               (api.setQuality at :862, which scales every layer's
//               instanceCount exactly the way grass.js scales blade counts);
//               nothing ever calls it, so it sits at 1.
//   post        LABEL for the post-stack sample budget, one of
//               'light' | 'balanced' | 'full'. Descriptive, not a knob:
//               src/core/postfx.js:198-213 derives the same split itself from
//               QUALITY.tier (MSAA samples, AO samples, godray steps, DOF
//               taps, luminance cadence). It used to claim medium was 'full',
//               which it is not — medium runs a reduced sample budget too.
//               No pass is ever dropped on any tier.
// ---------------------------------------------------------------------------
const TIERS = {
  low:    { pixelRatio: 1.0,  grass: 0.30, shadow: 1024, trees: 0.45, particles: 0.35, post: 'light'    },
  medium: { pixelRatio: 1.25, grass: 0.60, shadow: 2048, trees: 0.75, particles: 0.65, post: 'balanced' },
  high:   { pixelRatio: 2.0,  grass: 1.00, shadow: 4096, trees: 1.00, particles: 1.00, post: 'full'     },
};

export const QUALITY = { tier, ...TIERS[tier] };

// The console is a gate: a clean boot must print nothing, or "no console
// errors" stops being a check anybody can run. So only speak when the URL
// actually asked for something — the tier is otherwise readable from the
// exported QUALITY object.
if (asked) {
  if (asked === tier) console.log(`[quality] ${tier} (from ?q=)`);
  else console.warn(`[quality] ignoring ?q=${asked} — use low, medium or high. Running ${tier}.`);
}
