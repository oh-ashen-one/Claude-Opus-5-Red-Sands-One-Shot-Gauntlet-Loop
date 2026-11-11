# Verified foundation — read before touching anything

Bugs already found and fixed. Do not reintroduce them.

1. **Sun below the horizon — and the golden band was WRONG here until wave E.**
   `core/time.js` maps t: 0.25 sunrise, 0.5 noon, 0.75 sunset, 0 midnight, and computes
   `sunAltitude = sin((t - 0.25) * 2π) * 90` IN DEGREES. This file previously claimed
   golden hour was t≈0.70–0.735; that is false at the bottom of the range and every lane
   that tuned against it was tuning for the wrong sun:

       t=0.700 → 27.8°     t=0.720 → 16.9°     t=0.734 →  9.0°
       t=0.7358 →  8.0°    t=0.7429 →  4.0°    t=0.7465 →  2.0°    t=0.750 → 0.0°

   Real raking golden hour — long shadows toward camera, sun visible near the horizon —
   is **2–8°, i.e. t ≈ 0.736–0.748**. Below t≈0.735 the sun is high afternoon and the
   frame reads as a flat high-key poster no matter how well the grade is tuned; six of
   eight blind critics independently called this out. Anything above 0.75 puts the sun
   UNDER the horizon and the whole frame goes black.
   `tools/poses.json` was retimed into 0.7358–0.7465 in wave E. The quest arc in
   `game/quest.js` legitimately runs past it (climb 0.744 → duel 0.749 → end 0.757,
   which is deliberately after sunset).
2. **Never lerp hue between blue and orange.** `THREE.Color.setHSL` interpolating hue from
   0.57 to 0.065 passes through 0.28 — green. The entire sky turned green. Always lerp in
   RGB between two named colours. See the `P` palette block in `world/sky.js`.
3. **Poses were underwater.** Three of the eight camera poses sat below sea level because the
   river carve was 280 units wide and flattened half the island. The river is now a 46-unit
   meander. Verify any coordinate before using it:
       node tools/pick.mjs        # reports sun direction and real terrain candidates
       node probe.mjs             # heights/slopes at every current pose
4. **Light levels.** A low sun plus a weak ambient crushes every away-facing surface to black.
   There is now an explicit ambient floor plus hemisphere bounce in `world/sky.js`. Golden hour
   should read BRIGHT and warm, not murky.
5. **Grass thresholds.** Grass is excluded below h=3 (beach/water), above h=150, on slope>0.36
   and where the meadow mask is low. If a field looks empty, check the height there first.
6. **`P.golden` does NOT govern the hero shot — `P.dusk` does, by six to one.** This is the
   trap that item 1 sets one layer further down. The poses are correctly inside the 2–8°
   raking band, but `deriveGrade()` in `core/postfx.js` crossfades `P.dusk → P.golden` across
   `smoothstep(1.5°, 8.0°)`, so being *in* golden hour does not mean being *on* the golden
   grade. Measured through `time.js`:

       01-sunset-ridge  3.05°  14.4% golden / 85.6% dusk     05-summit  4.01°  33.3% / 66.7%
       02-grass-field   5.99°  77.2% golden / 22.8% dusk     06-forest  7.06°  94.3% /  5.7%
       03-coast         1.98°   1.5% golden / 98.5% dusk     07-run     5.09°  57.7% / 42.3%
       04-river-valley  8.02°   100% golden                  08-night -89.29°  100% night

   A comment in `postfx.js` asserted for several waves that the judged poses sat at 9°, 13°,
   18° and 24°. No daylit pose exceeds 8.02°. Consequences, both real:
   - Tuning `P.golden` alone moves the hero pose by 14% and the coast pose by 1.5%. A lane
     that does so and sees nothing has run a **null test**, not found a null result.
   - `P.dusk` is more aggressive on every aerial parameter than `P.golden` (`hazeWarm` red
     **1.74** vs 1.58, `aerIn` 0.60 vs 0.56, `aerMie` 0.15 vs 0.11), so far-field brightness
     defects are worse than the golden numbers imply.

   Prefer fixing aerial/tone **maths in the shader**, which is grade-state independent and
   fixes all eight poses at once, over retuning the `P` table. If you must retune the table,
   change `dusk` and `golden` together and say so explicitly.

7. **The far-field inversion was created in `postfx.js`, not `terrain.js` — five waves went
   after the wrong file.** "Distant mountains brighter than the sky behind them" persisted
   through five attempts to retune the far-field haze colour in `world/terrain.js`. None of
   them could have worked. Disable the postfx aerial mix entirely and terrain hands over far
   land *already correctly below its sky*: 01-sunset-ridge at L=105.6 against sky 123.3,
   03-coast at 65.2 against 133.9. The inversion was added downstream, in the composite, by
   two independent asymmetries that both treated land and sky as different kinds of thing:
   - The aerial blend mixed land toward `uHazeWarm`, whose red is **1.58 in golden and 1.74
     in dusk** — greater than one, so the "haze tint" was a *brightening operator* — and it
     applied only to land, because `dens` carries `(1.0 - skyMask)` and the dome is exempt.
     Far land therefore climbed *away* from the sky it sits against.
   - Godray shafts were weighted `mix(1.0, uSunSky, skyMask)`, so the dome took 0.80 while a
     ridge one pixel below the skyline took the full 1.0 — a 1.25x shaft premium handed to
     far land over its own sky, worst on exactly the poses with the most shaft energy.

   The fix (wave M) is not a better constant. `skyRadiance()` in `postfx.js` mirrors the dome
   fragment term for term and reads `ctx.sky.uniforms` every frame, so far land converges onto
   *the sky's own radiance in that direction*. Both sides of a horizon line now evaluate one
   function of one set of uniforms, which makes the defect unrepresentable rather than merely
   discouraged, and it needs no retuning as the time of day moves. Shafts are keyed to
   `airFrac = max(skyMask, dens)` instead of `skyMask`. **The general lesson: any term that
   sorts pixels into "land" and "sky" as a binary is a latent inversion.** The physical
   question is always *how much of this pixel is air*, which is continuous.

8. **`uHazeCool` and `uAerial.y` are dead. Tuning them is a null test.** Both are still
   declared and uploaded every frame, and all four grade states still carry a `hazeCool`
   triple, but nothing reads them since wave M replaced the hand-authored aerial target.
   Changing any of those numbers renders a bit-identical frame. Kept only to avoid churning
   the grade tables; see the comment at the composite's uniform block.

9. **Do not optimise `top_third_std`. It is gameable. `sky_minus_land` is not.** Two wave-M
   lanes found this independently from opposite directions. Raising local gain in a band whose
   light/dark relationship already has the wrong sign amplifies the defect, so spread and
   correctness move in opposite directions: across 13 tone-only changes,
   correlation(top3std, sky_minus_land) = **-0.815 with zero exceptions**. One tone push hit
   both stated targets — top3std 31.5 → 51.7, top3mean 178.6 → 157.6 — while driving
   sky_minus_land from -56.8 to -93.3 and visibly wrecking the frame. From the other side,
   deleting the aerial mix outright scores *best of all* on both numbers and produces hard
   near-black cutouts with no recession. `top3std` also has a hard ceiling of 73.6 (histogram
   equalisation, the best any monotone curve can do on our linear input) against the 75.9 that
   was being chased. Read it as a diagnostic, never as an objective.

   Corollary discovered while judging: **`sky_minus_land` has a "too much" direction too.** A
   soft hazy recession and a hard black silhouette can post the same delta — m-bound reached
   +60.3 on 03-coast by turning the distant island into a crisp near-black cutout. The sign is
   the constraint; the *softness of the transition* is only visible in the PNG.

10. **The tone curve is innocent of far-field flatness, and captures are NOT mid-adaptation.**
    A lane dumped the linear buffer the tone curve receives: on 01 the far land is already
    **+1.07 stops brighter than its sky before any tone mapping runs**. 01 and 05-summit
    resolve to nearly identical grade parameters yet differ 2.4x in output spread purely from
    their linear input range, and `post.meter()` shows five of eight poses pinned at the
    exposure floor (`exposure.knee` is 0.0, a hard clamp) where `key` is inert outright.
    Separately, that lane reported captures firing mid-adaptation, which would have invalidated
    every number in every wave. **It does not reproduce.** Retested through the real harness
    with `settle` raised 2.5s → 8.0s: 178.6 / 31.5, sky 123.2, sky-land -57.0, identical to the
    2.5s capture. `shoot.mjs` sets the clock both before *and* after the settle (`shoot.mjs`
    line ~142); the drift belongs to that lane's custom probe. Wave numbers stand.

11. **The far field's problem is spatial frequency, NOT contrast. Do not reduce far-mountain
    albedo contrast.** Wave M's losing lane concluded that far-mountain shading is too
    contrasty — dark rock against near-white snow reading as "slabs" — and recommended
    compressing it at source in `terrain.js`. That is wrong, and acting on it would move us
    away from the reference. Measured on the far-land regions, merged wave-M build vs
    `references/field_24`:

    | | p95-p05 spread | bimodality | gradient energy |
    |---|---|---|---|
    | ours 01-sunset-ridge | 134.6 | 0.650 | **2.12** |
    | ours 05-summit | 165.9 | 0.728 | **5.85** |
    | reference field_24 | 142.8 | 0.564 | **10.30** |

    The reference carries the *same* tonal range and is *also* bimodal. It is not smoother or
    flatter than ours. It spends that range on constant fine transitions — ridge structure,
    erosion, rock texture — where we spend it on a few large flat patches. Normalising
    gradient by std to remove any contrast dependence, ours is 0.046 against the reference's
    0.221, still 4.8x. **Keep the contrast; add spatial detail.** The "slab" look is a
    missing-detail artifact that reads as a contrast problem, and compressing the range would
    remove the one far-field property we already match.

12. **The favicon 404 is fixed and must stay fixed.** `index.html` inlines an SVG data URI so the
   browser never requests `/favicon.ico`. That 404 used to sit in every `report.json`, which
   silently made the errors-must-be-empty round gate useless — a permanently non-empty errors
   array means the gate can never fail, so it stops being a gate. A clean boot now reports no
   failing requests; confirm with `node tools/probe-404.mjs`, which names the URL behind the bare
   "Failed to load resource" line that `shoot.mjs` records. Provenance, since it matters for
   trust: this edit appeared in canonical mid-wave from a lane builder that had been told
   canonical was read-only. The change is correct and was kept, but it is the one case so far of
   a builder writing outside its lane, and lanes older than it still carry the 404.
13. **The shadow rig really is PCF, despite what `engine.js` says. Do not "fix" it.** `engine.js`
   sets `renderer.shadowMap.type = THREE.PCFSoftShadowMap`, which is deprecated in three r185 and
   emits a boot warning. It is tempting to read the r185 source, notice that `shadowMapTypeDefines`
   maps only `PCFShadowMap` and `VSMShadowMap`, and conclude the game silently falls through to
   hard-edged `SHADOWMAP_TYPE_BASIC`. **That conclusion is wrong**, and a builder reached it and
   built a performance argument on top of it. `WebGLShadowMap.render()` mutates `this.type` to
   `PCFShadowMap` on the first frame, before any material compiles, so the define resolves to
   `SHADOWMAP_TYPE_PCF`. Verified at runtime with `node tools/probe-shadow.mjs`, which reports the
   live type, the compiled defines and the sun's shadow box. Measured: type `PCFShadowMap`,
   mapSize 2048, radius 1, bias −0.00042, ortho box ±190 with near 40 / far 1000 — so **shadows
   simply stop at about 190m** while the grass carpet reaches 225m. Fog currently hides the
   boundary.
14. **Lanes must never share a Vite dependency cache. This one fakes a real finding.** `lane.sh`
   symlinks `node_modules` into every lane to keep the copy cheap, and Vite's `cacheDir` defaults
   to `node_modules/.vite` — so every lane was optimising deps into ONE cache. Two lane servers
   running concurrently returned NaN through the entire rig, **in the experiment and in its
   control**, which is exactly how it disguises itself as a genuine discovery about the code.
   `vite.config.js` now sets `cacheDir: '.vite-cache'`, which resolves against each project root
   and so gives every lane its own. If a lane starts producing impossible numbers, suspect this
   before you believe the numbers.
15. **`rimPower` is not a real material property, and that warning is harmless.** `rimMat()` in
   `game/combat.js` and `mat()` in `actors/horse.js` pass their whole spec into
   `MeshStandardMaterial` and separately read `spec.rimPower` for a shader uniform, so three.js
   warns eight times at boot while the rim light works correctly. Do not "fix" it by deleting
   the property — the uniform reads from it. Destructure it out of the constructor spec instead.
   Related documented trap, in the same file: rim uniforms MUST be declared in the GLSL, not
   merely added to `sh.uniforms`, or the shader silently fails to compile and the mesh vanishes.

## Current measured state
1920x1080 headless on the Studio: 73–88 fps. Sky, sun disc, stars, moon, cloud deck, ambient
rig, 2.4km island, 420k-blade instanced grass with travelling wind waves, ocean, film grade.
Trees and VFX are empty stubs. The character is still a capsule with a cone hat.

## Salvage note
`~/gauntlet-lanes/{terrain,grass,postfx,vfx}` contain substantial earlier work (650–1080 lines
each) that was never merged because the run was cut short. The grass lane's version renders
NOTHING on screen — debug it or discard it, but do not merge it blind. The others are worth
reading before you start from scratch.
