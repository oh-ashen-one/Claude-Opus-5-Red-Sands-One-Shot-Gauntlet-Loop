# Wave M notes: how the far-field sky inversion was found and fixed

These are working notes from one wave of the Gauntlet Loop on Red Sands, kept because they show the loop at work on a hard rendering bug: how lanes were judged, why the winning lane was not the one with the best score, and which dead ends cost the most. They were written at the end of wave M and describe the project as it stood then.

## The loop

"Kaze no Michi", a one-shot attempt to build a Ghost of Tsushima-look golden-hour game
(three.js + vite, headless-captured and judged) with no human in the loop.
Work proceeds in **waves**: capture the 8 canonical poses, judge the PNGs against real GoT
reference screenshots under `docs/CRITIC-RUBRIC.md`, fan out parallel "lanes" (agents working
in plain-directory copies of the repo) to root-cause and fix the biggest gap, judge
the lanes, merge the winner, re-capture, commit.

Judging hard rules (do not dilute them):
- Judge ONLY from the PNGs. Never trust `public/status.json`, `public/progress.html`, or any
  board or notes claims: they have been provably over-optimistic on this project.
- Ignore every framerate number: the capture machine is saturated, so fps is noise.
- Compare new vs old honestly in BOTH directions and log regressions, even when the frame is
  better overall. Do not be kind; if ours loses to the reference, say so.
- **Numbers break ties; they never win an argument with the PNG.** Wave M is the case study:
  the lane with the best score lost, because its score came from crushing far land to black.

## Wave M: what was wrong, and what fixed it

The defect: distant mountains rendered *brighter* than the sky behind them, which no real
golden-hour photograph does.

**Five waves went after the wrong file.** They retuned far-field haze in `world/terrain.js`.
Disable the postfx aerial mix entirely and terrain hands over far land *already correctly
below its sky* (01 at L=105.6 against sky 123.3; 03 at 65.2 against 133.9). The inversion was
added downstream in `core/postfx.js` by two terms that each treated land and sky as different
kinds of thing:

- the aerial blend mixed land toward `uHazeWarm`, whose red is **1.58 golden / 1.74 dusk**,
  which is greater than one, so the "haze tint" was a *brightening operator*, and `dens` carries
  `(1.0 - skyMask)`, so the dome was exempt. Far land climbed *away* from its own sky.
- godray shafts were weighted `mix(1.0, uSunSky, skyMask)`: the dome took 0.80 while a ridge
  one pixel below the skyline took 1.0. A 1.25x shaft premium for far land over its own sky.

**The fix is not a better constant.** `skyRadiance()` in `postfx.js` mirrors the sky dome
fragment term for term and reads `ctx.sky.uniforms` every frame, so far land converges onto
the sky's *actual radiance in that direction*. Both sides of a horizon line evaluate one
function of one set of uniforms, so the defect is unrepresentable rather than discouraged, and
nothing needs retuning as the time of day moves. `world/sky.js` is untouched. Shafts are now
keyed to `airFrac = max(skyMask, dens)`.

One number calibrates it: `params.aerial.maxConverge = 0.26`, swept not guessed. It is far
below 1.0 because postfx is the *second* application of this physics: terrain already runs
its own distance ramp capped at 0.94.

Measured, `shots/wave-l/` → `shots/wave-m/`:

| pose | sky-land before | after | top3mean before → after |
|---|---|---|---|
| 01-sunset-ridge | -57.0 | **+8.0** | 178.6 → 131.6 (reference 130.6) |
| 03-coast | -24.8 | **+38.5** | 151.5 → 98.7 |
| 05-summit | +11.5 | **+29.3** | 161.6 → 139.7 |
| 07-run | -36.3 | **-6.0** | 165.9 → 152.9 |

02, 04, 06, 08 carry no far landform. 06-forest and 08-night are unchanged within noise;
verified from the PNGs, not assumed.

**Regressions: none found in either direction.** Every pose was compared before/after at full
size. The frames are darker in the upper third by design; that *is* the fix.

**Not fixed, and not hidden:** 07-run is still -6.0. Its volcano cone remains marginally
brighter than its own sky. It is the only gradable pose that did not flip.

### The two lanes that did not merge

- **m-bound** scored *better* (+25.1 mean, +60.3 on 03-coast) and lost on the PNGs. Its gains
  came from crushing far land toward black: on 03-coast it turned the distant island into a
  crisp near-black silhouette with no haze at all, where the winner renders a soft mauve mass
  dissolving into the sky. Same failure mode as the winner's own rejected `converge 0.00`.
- **m-tonerange** returned a rigorous null: the tone curve is innocent. It dumped the linear
  buffer the curve receives and far land is already +1.07 stops brighter than its sky *before
  any tone mapping runs*. Nothing merged; findings are in FOUNDATION #9 and #10.

## Verification done

- `shots/wave-m/` captured on canonical after the merge (all 8 poses), measured
  with `tools/farfield.py`, and eyeballed pose by pose against `shots/wave-l/`.
- The boot guard in `shoot.mjs` caught a real syntax error during this merge (a backtick
  inside a GLSL template literal) and refused to write shots. Trust it.
- **One inherited claim was tested and rejected.** A lane reported that captures fire
  mid-adaptation and that every wave's numbers are therefore unconverged. Retested through the
  real harness with `settle` 2.5s → 8.0s: byte-identical numbers. It does not reproduce. See
  FOUNDATION #10 before anyone re-raises it.

## Next steps

1. **Wave N: the far field has correct VALUE but not enough FORM.** This is now the biggest
   measured gap on the hero pose, and wave M is what made it visible:

   | | top3mean | top3std | gradient energy | % below L100 |
   |---|---|---|---|---|
   | wave-L 01 | 178.6 | 31.4 | 2.17 | 1.2% |
   | wave-M 01 | 131.6 | 50.2 | 2.31 | 28.0% |
   | reference field_24 | 130.6 | **75.9** | **3.02** | 35.8% |

   Mean and dark content are now close. What is missing is *internal detail*. Measured on the
   far-land regions themselves, the diagnosis is specific and it is **not** a contrast problem:

   | | spread (p95-p05) | bimodality | gradient energy |
   |---|---|---|---|
   | ours 01-sunset-ridge | 134.6 | 0.650 | **2.12** |
   | reference field_24 | 142.8 | 0.564 | **10.30** |

   The reference carries the same tonal range and is also bimodal; it just spends that range
   on constant fine transitions where we spend it on a few large flat patches. So the brief is
   **add spatial detail at the far-field scale; do NOT compress the albedo range.** Read it as
   a geometry, normal-map and cloud-deck problem in `world/terrain.js` and the sky's cloud
   layer. This is the one far-field question that genuinely does live in `terrain.js`, unlike
   the value problem that wasted five waves there.

   Wave M's losing lane recommended the opposite: reducing far-mountain albedo contrast to
   kill a "slab" look. The numbers above refute it; the slab look is missing detail
   masquerading as excess contrast. FOUNDATION #11.
2. **Do not lane this as "raise top3std".** It is gameable and there is a hard ceiling of 73.6
   on it anyway. FOUNDATION #9. Brief lanes on *form*, and judge from the PNGs.
3. Resume the cadence: judge → name the single biggest gap → lane it → judge the lanes →
   merge the winner → verify → commit.

## Key files

- `docs/FOUNDATION.md`: verified bugs never to reintroduce. **Items 7 to 10 are new in wave M**
  and are the most load-bearing text in the repo right now: the land/sky binary as a latent
  inversion, the dead `uHazeCool`/`uAerial.y`, `top3std`'s gameability, and the tone curve's
  innocence. Its "Current measured state" section is still stale (pre-wave-C); the bug list is
  authoritative, that section is not.
- `docs/CRITIC-RUBRIC.md`: the judging bar, with the automatic-fail list.
- `tools/farfield.py` + `tools/farfield-rois.json`: **the wave-M measurement instrument.**
  Fixed per-pose regions, no auto-segmentation. Read its module docstring before using any
  number it prints. `--overlay DIR` draws the regions on the frame; do that before trusting a
  pose you have not audited.
- `src/core/postfx.js`: `AIRLIGHT_LIB` / `skyRadiance()` and the aerial block are the wave-M
  work and are heavily commented with the measurements behind every constant.
- `tools/shoot.mjs`: pose capture. `tools/poses.json`: the 8 canonical poses.
- `tools/lane.sh`, `tools/merge-lane.sh`: lane flow.

## Gotchas

- **Parallel lanes need a unique `CHROME_PROFILE` each**, not just a unique port. Puppeteer's
  `userDataDir` defaults to one shared path and the second lane to launch dies with "browser
  is already running". Fixed in `tools/lane.sh`; if you hand-roll a lane, set it yourself.
- **Never put a backtick in a comment inside a GLSL template literal** in `postfx.js`. It ends
  the template string and the game fails to boot with "missing ) after argument list".
- `uHazeCool` and `uAerial.y` are **dead** since wave M: declared and uploaded, read by
  nothing. Tuning them, or any grade state's `hazeCool` triple, is a null test. FOUNDATION #8.
- Golden hour is **t ≈ 0.736 to 0.748** (sun 2 to 8 degrees). `core/time.js` gives altitude in DEGREES;
  t above 0.75 = sun under the horizon = black frame. FOUNDATION #1.
- Being in golden hour does NOT mean being on the `P.golden` grade. The hero pose is 85.6%
  `P.dusk`. Tuning `P.golden` alone and seeing nothing is a **null test**, not a null result.
  FOUNDATION #6.
- Never lerp hue between blue and orange (`setHSL` passes through green). Lerp in RGB.
- Do not tune far-mountain *brightness* in `terrain.js FAR_FRAG`. That value is set in
  `postfx.js`. That mistake cost five waves. Far-mountain *form* is a different question and
  does belong there.
