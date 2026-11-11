# Claude Opus 5 Red Sands One-Shot Gauntlet Loop

A ~60-minute playable samurai adventure that runs in a browser. Three.js, no
engine, no imported art — every mesh, shader, sound and line of dialogue is
generated in code. ~21,000 lines across 25 modules.

It was built in a single continuous session by **Claude Opus 5** running a
**Gauntlet Loop**: the game was cut into independently-judgeable pieces, each
piece got a builder sub-agent and a *separate* critic sub-agent with fresh
context that only ever looked at the rendered frames — never at the builder's
summary — and the loop ran until the critic stopped complaining. No fixed
number of rounds.

This README is the honest post-mortem. It documents the process, the mistakes
(there were expensive ones), what actually worked, and enough detail that
another agent can rebuild the harness and run the same loop on a different
game.

## Give this to your agent

```text
Clone https://github.com/oh-ashen-one/Claude-Opus-5-Red-Sands-One-Shot-Gauntlet-Loop.git. It is about 900 MB because of the evidence images under shots/.
Read README.md in full, then docs/FOUNDATION.md, docs/CRITIC-RUBRIC.md and CONTROLS.md.
Then run npm install, start the game with npx vite --port 5810, and confirm the dev server starts and the page at http://localhost:5810/ loads. If the machine is slow, use http://localhost:5810/?q=low.
Do not run the capture or lane tools (tools/shoot.mjs, tools/burst.mjs, tools/lane.sh) until I say so. They drive Chrome and the loop is heavy.
Then ask me what I want to do: play and change the game, or reuse the Gauntlet Loop process on a different game. Ask me for anything you need, such as the path to Google Chrome or my own reference screenshots.
```

Before you start: the repo is about 900 MB, most of it screenshots and videos in `shots/`. The Ghost of Tsushima reference screenshots that the critics compared against are not in the repo (`references/` is git-ignored), so the comparison loop needs your own reference images. `tools/shoot.mjs` and `tools/burst.mjs` use Google Chrome at its default Mac path unless you set `CHROME_PATH`. `tools/lane.sh` and `tools/merge-lane.sh` read the optional variables `GAUNTLET_CANON` (the checkout to copy from) and `GAUNTLET_LANES` (the folder for lane copies). Notes on one wave of the loop, with its measurements, are in `docs/WAVE-M-NOTES.md`.

---

## Play it

```bash
npm install
npx vite --port 5810
# open http://localhost:5810/
```

Quality tier is guessed from `navigator.hardwareConcurrency`; force it with
`?q=low`, `?q=medium`, `?q=high`. A 2023 MacBook runs `?q=low` at ~108fps; a
Mac Studio runs the default tier at 66–99fps at 1080p.

**Controls:** `WASD` move · `Mouse` look · `Shift` sprint · `Space` jump ·
`C`/`Ctrl` dodge · `LMB` light attack · `RMB` heavy attack (release to parry) ·
`1`–`4` stances · `Q` guiding wind · `F` mount the horse when near it (hold
`Shift` to gallop — 14 m/s against 4.6 trotting) · `E` interact. Full list in
[`CONTROLS.md`](CONTROLS.md).

The live progress board that was updated throughout the build is at
`/progress.html`.

---

## Where to go: the island's key places

All coordinates are world-space `(x, z)` — the same numbers shown live in the
HUD's top-right readout and defined in `src/game/quest.js`. `Q` calls the
Guiding Wind, but the gust can be subtle in motion; the reliable way to
navigate is to **watch the HUD readout and walk until your numbers match the
target's**. The route:

```
shore (-743, 223) -> village (-559, 85) -> shrine (-375, -168)
                  -> camp (-444, -490) -> summit (-191, -697)
```

**Teleport keys:** the row under the HUD readout lists them — `5` shore,
`6` village, `7` shrine, `8` camp, `9` summit. Press one and you are there
(it runs the quest's own beat-jump, so the story moves with you; the labels
are also clickable whenever the pointer is unlocked).

Leg by leg (distance, and how your readout should change as you walk):

| Leg | Distance | Head |
|-----|----------|------|
| Shore -> village | ~230 m | x **up** ~184, z **down** ~138 |
| Village -> shrine | ~313 m | x **up** ~184, z **down** ~253 |
| Shrine -> camp | ~329 m | x **down** ~69, z **down** ~322 |
| Camp -> summit | ~327 m | x **up** ~253, z **down** ~207 (a long climb) |

**The five story locations, in quest order:**

| # | Place | Coordinates | Height | What happens there |
|---|-------|-------------|--------|--------------------|
| 1 | The Tide Line (west beach) — start | `(-743, 223)` | h ~5 | You wash ashore. Torii gate just inland at `(-729, 197)` |
| 2 | Kayano Village — "What the Fire Left" | `(-559, 85)` | h ~33 | Burned village, first fight (2 raiders). The horse waits in the paddock here |
| 3 | The Shrine in the Cut, Kawakami | `(-375, -168)` | h ~31 | Stone shrine + torii at `(-366, -163)`. Pay respects within ~7 m |
| 4 | The Occupied Camp (Inland Shelf) | `(-444, -490)` | h ~42 | Take back the camp (4 raiders), then survive the 3-raider ambush |
| 5 | The Summit — the Duel | `(-191, -697)` | h ~220 | Big torii at `(-196, -705)`. Final duel vs Sakai no Ryūzō, then the ending |

**Scenic photo spots** (from `tools/poses.json` — the poses the build's
critics were graded on):

- Sunset ridge: `(-536, 334)`
- Grass field (the pampas signature shot): `(-681, 363)`
- Coast / sun road on the water: `(-159, 885)`
- River valley: `(-126, 330)`
- High vantage overlooking the field: `(460, -150)`
- Forest interior: `(-373, -390)`

**Finer control from the console:** `window.__GAME.quest.list()` shows all
ten beats, and `window.__GAME.quest.goto('summit')` teleports you there (also
`shore`, `wind`, `village`, `ride`, `shrine`, `camp`, `ambush`, `climb`,
`duel`, `end`).

---

## The process: what a Gauntlet Loop actually is

### 1. Cut the game into pieces that can be judged alone

Not "levels" and not "sprints" — **pieces a critic can look at in isolation
and say better or worse.** The sixteen used here:

`terrain` · `sky` · `grass` · `trees` · `water` · `postfx` · `vfx` ·
`character` · `locomotion` · `camera` · `combat` · `enemy AI` · `hud` ·
`audio` · `horse` · `quest`

The test for a good piece: *can one screenshot or one 6-second video prove it
is or isn't good?* "Atmosphere" fails that test. "Sky at golden hour" passes.

### 2. Give every piece a private copy of the repo (a lane)

Parallel builders editing one working tree destroy each other's screenshots
and each other's framerate measurements. `tools/lane.sh <name> <portOffset>`
rsyncs a private copy to `~/gauntlet-lanes/<name>` (change the folder with `GAUNTLET_LANES`) on its own Vite port
(5810 + offset), symlinking `node_modules` so the copy is cheap. `--update`
means a lane's newer edits are never clobbered by a re-sync.
`tools/merge-lane.sh <lane> <files...>` pulls only that lane's **owned** files
back to canonical. File ownership per lane is non-negotiable — it is what
makes the merges trivial.

### 3. Critique the rendered game, never the builder's report

This is the whole trick, and it is where most agent loops fail. A builder
sub-agent will tell you the grass looks beautiful. The grass does not look
beautiful. So:

- **`tools/shoot.mjs`** — launches headless Chrome (system Chrome via
  `executablePath`, isolated `userDataDir`, *never* the user's live browser),
  teleports the camera to named poses from `tools/poses.json`, and writes PNGs.
- **`tools/burst.mjs`** — drives scripted input from `tools/sequences.json`,
  captures timed frame bursts, and assembles them with ffmpeg into a contact
  sheet plus an mp4. This exists because **stills cannot judge feel.** Horse
  gait, attack weight and camera lag are motion properties; a critic looking
  at one frame will pass a game that plays like mud.
- **`window.__GAME`** debug API — `setTime`, `teleport`, `drive`, `release`,
  `fps`, `quest.goto/list/next`. Without a scripting surface the harness
  cannot reach beat 8 of the story to photograph it.

The critic sub-agent is spawned **fresh, with no build context**, is handed
the images and real Ghost of Tsushima reference frames, and is asked to compare
blind: *which of these two looks better, and name the single biggest gap.*
When ours loses, that one gap — one sentence — is the entire next brief for
the builder. Not a list. One gap.

### 4. Between waves, one agent plays the whole game

After each wave of parallel piece-work, a fresh agent drives real input end to
end and reports on **coherence**, not quality. This produced the single most
valuable artifact of the whole build (see below).

### 5. Keep a board

`public/progress.html` + `public/status.json`, updated by `tools/status.mjs`,
tracking per piece: status, rounds spent, and the current named gap.

---

## What we did wrong

These are the real ones, with root causes. Most of them cost multiple hours.

**1. The catastrophic one: a defensive guard that swallowed errors.**
`quest.js` called into the HUD through a helper that wrapped everything in
`try/catch` and discarded the exception. The HUD signatures had changed. The
result: seven story beats with zero dialogue, every chapter card reading the
same wrong title, and every haiku missing — **for two full waves**, while the
game reported no errors at all. Screenshot critics can't see missing dialogue
in a still. The fix is one line, and it is a law now:

```js
// Never swallow silently: a caught TypeError here hid every line of dialogue,
// every chapter title and every haiku in the game across two full waves.
catch (e) { console.error('[quest]', m, 'threw:', e.message); }
```

**Lesson: in an agent loop, a silent failure is worse than a crash.** A crash
gets fixed in one round. Silence survives every round.

**2. Everyone misdiagnosed the stipple, including the model writing the
briefs.** A coarse cross-hatch pattern covered every frame. Two critics blamed
the tree LOD Bayer dither; so did I, and I wrote it into a wave brief as fact.
It was **SSAO sample-rotation noise** that a 3-tap bilateral blur could not
resolve. Found only by elimination — grain off (still there), tree dither
removed (still there), impostor cut softened (still there), AO off (**gone**).
Fixed by widening the blur to 7 taps, at no measurable frame cost.
**Lesson: a critic's diagnosis of *cause* is worthless. Only its report of
*symptom* is data.** Bisect; don't believe.

**3. Measured framerate in the wrong place.** Wave-long panic about 43–50fps
was GPU contention from a dozen parallel lane servers rendering at once. The
canonical build was at 74–96fps the whole time. Every subsequent brief now
says, in caps: MEASURE FPS ON CANONICAL, NOT IN A LANE.

**4. Synced over my own fix.** Patched `horse.js` on the remote machine, then
rsynced local→remote and destroyed it. **One direction only; local is source
of truth.**

**5. Trusted a hue lerp.** Interpolating sky colour from blue to orange in HSL
passes through **green**. Every sunset was green for a wave. Named-colour RGB
lerps only.

**6. Let a critic tune a global.** A DOF widening that a critic asked for
(`dofScale` 0.34→0.85) softened the *entire* frame, near ground included. It
looked better in the one pose the critic was shown and worse everywhere else.
Reverted. **A critic judges a frame; only integration judges the game.**

**7. Poses that pointed at nothing.** Half the early critique rounds shot
sunset poses with the sun *below the horizon* (`sin((0.78−0.25)·2π)` is
negative — the time-of-day convention was wrong) and three poses underwater,
because a river carve was 280 units wide and had flattened half the island
below the grass line. Critics dutifully reported "the lighting is terrible."
**Validate the harness before believing its verdicts.**

**8. Ran the wave fan-out too wide, too early.** Five waves died on an account
spend limit, ~5M sub-agent tokens of which a large share was burned on retry
errors after the limit was hit. Fan-out is not free, and a failed wave costs
the same as a successful one.

**9. Left dead config in place.** `QUALITY.trees` and `QUALITY.particles` are
declared and read by nothing. Small, but it is exactly the kind of thing that
makes a future agent believe a knob exists.

---

## What we did right

**Lanes.** Sixteen builders ran in parallel for hours with zero merge
conflicts, because file ownership was assigned up front and merges were
per-file, not per-branch.

**The separation of builder and critic.** Non-negotiable, and it worked. The
critic never saw the builder's claims, only pixels. Round after round it
rejected work the builder had declared finished — the trees lane failed four
consecutive times on the same note, and the note was correct every time.

**Motion critique.** Adding `burst.mjs` mid-build was the largest single
quality jump. Everything about *feel* — gait, weight, camera lag, attack
timing — was invisible until frames became video.

**The coherence playthrough agent.** The highest-value agent in the entire
run. It drove real input for thirteen minutes and proved the game reached beat
4 of 10 and then stopped forever. **Four waves of screenshot critique never
caught it**, because every screenshot was of a place, and every place looked
fine. It also produced fourteen coherence faults that no per-piece critic
could have seen, because they were all *between* pieces.

**One analytic ground truth.** `world.heightAt(x,z)` — a pure function every
system queries. Terrain, grass, trees, water, the horse, enemy spawns and the
camera all agree on where the ground is, forever, with no baked data to go
stale. If you take one architectural idea from this repo, take this one.

**Procedural everything.** No asset pipeline means no asset pipeline to break,
and an agent can change the look of a tree by editing a number.

**Debug surface as a first-class feature.** `window.__GAME` is why the harness
could photograph beat 9 without playing to beat 9.

**Honest status.** The board tracks `fail` and `building` states with the
named gap, not a completion percentage. A percentage would have been a lie in
every single wave.

---

## If you are an agent asked to replicate this

Do it in this order. Steps 1–4 are the harness; **do not let a builder write
game code until step 4 works**, or you will spend your first four rounds
critiquing broken screenshots (we did).

1. **Scaffold the smallest running thing** — engine, camera, one lit ground
   plane. Get it on a port.
2. **Build the debug API before the game.** `window.__GAME` with `teleport`,
   `setTime`, `fps`, and a way to jump to any story beat.
3. **Build `shoot.mjs`.** Headless Chrome, a named pose list, PNGs to disk.
   Then **validate every pose by hand**: is the camera above water, is the sun
   above the horizon, does the frame contain the thing it claims to?
4. **Build `burst.mjs` immediately after.** Scripted input → frame burst →
   contact sheet + mp4. Do not defer this. Feel is half the game and stills
   cannot see it.
5. **Cut the pieces** with the one-screenshot test. Assign each an owned file
   list. Write it down; ownership is the merge strategy.
6. **Write the lane scripts** (`lane.sh`, `merge-lane.sh`). Private copy per
   builder, own port, symlinked `node_modules`.
7. **Run waves.** Per piece, in a loop:
   - builder sub-agent, in its lane, given *one named gap*;
   - `run.sh` / `burst-run.sh` to render;
   - **fresh** critic sub-agent, no build context, given our frames + real
     reference frames, asked to pick blind and name the single biggest gap;
   - repeat until the critic prefers ours. No fixed round count.
8. **Between waves, one coherence agent plays the whole game** with real
   input, start to finish, and reports on continuity, pacing, difficulty and
   dead ends — explicitly *not* on visual quality.
9. **Merge, verify on canonical, update the board, commit.**

**Rules worth stealing verbatim:**

- The critic never reads the builder's summary. Ever.
- One gap per round. A list of ten notes produces ten half-fixes.
- Measure performance only on canonical, never in a lane.
- Never catch an exception you don't log.
- A critic's *symptom* is data; its *diagnosis* is a guess. Bisect.
- Sync one direction. Local is source of truth.
- Validate the harness before you believe a single verdict it produces.
- Budget fan-out. A wave that dies costs what a wave that ships costs.

---

## Repo map

```
src/core/      engine, input, time, quality tiers, postfx (the film grade)
src/world/     terrain (the analytic ground truth), sky, grass, trees,
               water, wind, vfx
src/actors/    samurai (procedural), player locomotion, horse, enemy
src/game/      quest (the 10-beat arc), combat, camera, hud, audio
tools/         shoot.mjs, burst.mjs, lane.sh, merge-lane.sh, status.mjs,
               probe-*.mjs, poses.json, sequences.json
docs/          FOUNDATION.md (verified facts + traps), CRITIC-RUBRIC.md,
               WAVE-M-NOTES.md (one wave of the loop, worked through)
public/        progress.html — the live board
```

Read `docs/FOUNDATION.md` before touching anything. It records the traps —
the time-of-day convention (golden hour is the narrow band t ≈ 0.712–0.750),
the shader-uniform declaration trap, and the coordinates that are known-good.

---

## Honest status

**Works:** ten story beats, start to end, with dialogue, chapter cards and
haiku; melee combat with real damage; a rideable horse with gaits; jump;
day-night with a correct sun; three quality tiers; 66–99fps at 1080p on an
M3 Ultra, ~108fps at `?q=low` on a laptop; zero console errors across a full
playthrough.

**Does not yet meet the bar:** the pines still read as acacia — a kuromatsu is
4–7 *separated* cloud pads with sky punched between them on a leaning trunk,
and ours is one continuous dome (the trees lane failed this note four times);
residual stipple in the far tree band; a 1%-low framerate of ~36fps at combat
beats and a recurring 27ms hitch; two coherence items open (two HUDs can show
at once; the combat camera pitches near-overhead).

It is not Ghost of Tsushima. It is a real, finishable hour of game built in one
session by agents that were never allowed to grade their own homework, and the
list above is what the critics still say is wrong — which is the point.
