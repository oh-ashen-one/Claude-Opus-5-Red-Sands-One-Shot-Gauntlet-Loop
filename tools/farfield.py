#!/usr/bin/env python3
"""farfield.py — measure far-field value separation from a PNG and nothing else.

Wave M exists because five waves of terrain tuning chased a defect that no lane
could measure the same way twice. Every one of those waves measured with a
throwaway script, so "the mountains are too bright" was never a number two lanes
could agree on. This is that number, committed, so a claim can be reproduced.

WHAT IT MEASURES

Aerial perspective has one hard physical constraint: a distant surface can only
converge TOWARD the airlight radiance behind it. At infinite optical depth a
ridge becomes indistinguishable from its sky. It can approach the sky from
below. It can never overshoot and come out BRIGHTER than the sky it sits
against. When it does, the cause is downstream gain, not terrain shading.

So the headline metric is signed:

    sky_minus_land = mean L of the sky region - mean L of the far-land region

Positive means the ridge is darker than its sky, which is what every real
golden-hour photograph does. Negative means the render gets brighter the
further away it looks. Measured values, wave L:

    references/field_24    +132     (sky 198, hill 66)
    01-sunset-ridge         -50     (sky 135, mountains 185)

DO NOT OPTIMISE top_third_std. IT IS GAMEABLE. sky_minus_land IS NOT.

Two wave-M lanes discovered this independently, from opposite directions, and it
is the most important thing on this page.

`top_third_std` measures tonal spread in the upper frame, and closing the gap to
the reference's 75.9 looks like an obvious goal. It is a trap. Raising local gain
in a band whose light/dark relationship has the WRONG SIGN amplifies the defect,
so std and correctness move in opposite directions. Measured across 13 tone-only
changes: correlation(top3std, sky_minus_land) = **-0.815, with zero exceptions.**
One tone push hit both "targets" — top3std 31.5 -> 51.7 and top3mean 178.6 ->
157.6 — while driving sky_minus_land from -56.8 to -93.3, i.e. while doubling the
exact defect the wave existed to fix. The frame was visibly worse: mountains
still featureless, zenith collapsed to dark purple, grass crushed to muddy
maroon.

From the other side: deleting the aerial mix outright scores BEST of all on both
std and sky_minus_land, and produces hard near-black cutouts with no atmospheric
recession whatsoever.

So: `sky_minus_land` is a physical constraint and safe to optimise, because no
amount of gain can fake the sign. `top_third_std` is a symptom, is reachable by
making the picture worse, and has a hard ceiling anyway — histogram
equalisation, the best any monotone curve can do on our linear input, tops out at
73.6 against the 75.9 "target". Read std as a diagnostic, never as an objective,
and always confirm against the PNG.

WHY THE REGIONS ARE FIXED AND NOT DETECTED

Two automatic segmenters were built and both were thrown away. Recording them
because both produce a comfortable number from a visibly broken frame:

1. "Walk down from the top until it gets darker." Unusable by construction: on a
   frame whose far land is BRIGHTER than its sky it locks onto the wrong side.

2. "Take the strongest absolute vertical gradient." Also unusable, and this one
   is subtle enough to have nearly shipped. On 01-sunset-ridge the strongest
   edge in the frame is the NEAR tree and grass line at 0.43 H, far below the
   mountains. Segmenting there puts the whole far mountain mass inside the "sky"
   band, so the metric compares mountains-plus-sky against near grass and
   returns +61.6 — better than the reference — for the exact frame whose
   mountains are washed out 50 L brighter than the sky. Caught by drawing the
   bands onto the PNG and looking at it.

   A third variant, "first sustained departure scanning down from known sky",
   fired at 0.064 H on every single image including the references, because the
   sky's own vertical gradient at golden hour exceeds any fixed step threshold.

The poses in tools/poses.json pin camera x/z/face/time, so a given ridge lands
in the same region of the frame every wave. Fixed regions are therefore both
honest and stable, and they are auditable: run --overlay and look.

USAGE

    python3 tools/farfield.py 'shots/wave-l/*.png'
    python3 tools/farfield.py --overlay /tmp/ov shots/wave-m/01-sunset-ridge.png
    python3 tools/farfield.py --json out.json 'shots/wave-m/*.png'

Region definitions live in tools/farfield-rois.json.
"""
import argparse
import glob
import json
import os
import sys

import numpy as np
from PIL import Image

# Rec.709 luma on the sRGB values as displayed. Deliberately NOT linearised:
# the judge looks at the PNG, so the metric reads the PNG.
_LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float64)

_ROI_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         "farfield-rois.json")


def load_rois(path=_ROI_FILE):
    with open(path) as fh:
        return json.load(fh)


def _luma(path):
    im = Image.open(path).convert("RGB")
    return np.asarray(im, dtype=np.float64) @ _LUMA, im.size


def _key_for(path, rois):
    """Map a file path to its region entry by stem, poses first then references."""
    stem = os.path.splitext(os.path.basename(path))[0]
    if stem in rois["poses"]:
        return stem, rois["poses"][stem]
    if stem in rois["references"]:
        return stem, rois["references"][stem]
    if stem in rois["no_far_landform"]:
        return stem, None
    return stem, None


def _region(L, box):
    H, W = L.shape
    x0, x1, y0, y1 = box
    a, b = int(round(x0 * W)), int(round(x1 * W))
    c, d = int(round(y0 * H)), int(round(y1 * H))
    a, b = max(0, a), min(W, max(a + 1, b))
    c, d = max(0, c), min(H, max(c + 1, d))
    return L[c:d, a:b]


def measure(path, rois=None):
    rois = rois or load_rois()
    L, (W, H) = _luma(path)
    stem, spec = _key_for(path, rois)

    t3 = L[: H // 3]
    out = {
        "file": path,
        "pose": stem,
        "size": [W, H],
        # Needs no segmentation, so it is the metric to trust when regions are
        # absent. The wave-M spec is written against these two.
        "top_third_mean": round(float(t3.mean()), 1),
        "top_third_std": round(float(t3.std()), 1),
        "sky_minus_land": None,
        "sky_mean": None,
        "land_mean": None,
        "columns_inverted_pct": None,
        "gradable": False,
    }
    if not spec:
        out["skip_reason"] = (rois["no_far_landform"].get(stem)
                              or "no regions defined for this file")
        return out

    sky, land = _region(L, spec["sky"]), _region(L, spec["land"])
    # Column-wise so a single bright patch cannot hide behind a dark one. The
    # two regions are cropped to a common width before pairing.
    n = min(sky.shape[1], land.shape[1])
    per_col = sky[:, :n].mean(axis=0) - land[:, :n].mean(axis=0)

    out.update({
        "sky_minus_land": round(float(sky.mean() - land.mean()), 1),
        "sky_mean": round(float(sky.mean()), 1),
        "land_mean": round(float(land.mean()), 1),
        "land_std": round(float(land.std()), 1),
        "columns_inverted_pct": round(float((per_col < 0).mean() * 100.0), 1),
        "gradable": True,
    })
    return out


def write_overlay(path, out_dir, rois=None, width=760):
    """Draw the two regions onto the frame so the choice can be audited."""
    from PIL import ImageDraw

    rois = rois or load_rois()
    stem, spec = _key_for(path, rois)
    if not spec:
        return None
    im = Image.open(path).convert("RGB")
    W, H = im.size
    d = ImageDraw.Draw(im)
    for box, col, tag in ((spec["sky"], (0, 255, 255), "SKY"),
                          (spec["land"], (255, 255, 0), "FAR LAND")):
        x0, x1, y0, y1 = box
        r = [x0 * W, y0 * H, x1 * W, y1 * H]
        d.rectangle(r, outline=col, width=6)
        d.text((r[0] + 10, r[1] + 10), tag, fill=col)
    os.makedirs(out_dir, exist_ok=True)
    dst = os.path.join(out_dir, f"roi-{stem}.png")
    im.resize((width, int(width * H / W))).save(dst)
    return dst


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="+")
    ap.add_argument("--json", help="write the full result list here")
    ap.add_argument("--overlay", metavar="DIR",
                    help="also write region overlays here for visual audit")
    a = ap.parse_args()

    files = []
    for p in a.paths:
        files.extend(sorted(glob.glob(p)) if any(c in p for c in "*?[") else [p])

    rois = load_rois()
    out = []
    hdr = (f"{'file':<34} {'top3mean':>8} {'top3std':>7} "
           f"{'sky-land':>8} {'sky':>6} {'land':>6} {'inv%':>6}")
    print(hdr)
    print("-" * len(hdr))
    for f in files:
        try:
            r = measure(f, rois)
        except Exception as e:                       # noqa: BLE001
            print(f"{f:<34} ERROR {e}", file=sys.stderr)
            continue
        out.append(r)
        name = f if len(f) <= 34 else "..." + f[-31:]
        if r["gradable"]:
            print(f"{name:<34} {r['top_third_mean']:>8} {r['top_third_std']:>7} "
                  f"{r['sky_minus_land']:>8} {r['sky_mean']:>6} "
                  f"{r['land_mean']:>6} {r['columns_inverted_pct']:>6}")
        else:
            print(f"{name:<34} {r['top_third_mean']:>8} {r['top_third_std']:>7} "
                  f"{'-':>8} {'-':>6} {'-':>6} {'-':>6}   (no far landform)")
        if a.overlay:
            write_overlay(f, a.overlay, rois)

    grade = [r for r in out if r["gradable"]]
    if grade:
        m = float(np.mean([r["sky_minus_land"] for r in grade]))
        worst = min(grade, key=lambda r: r["sky_minus_land"])
        print(f"\ngradable poses: {len(grade)}   mean sky-land: {m:+.1f}"
              f"   worst: {worst['pose']} {worst['sky_minus_land']:+.1f}")
        print("positive = far land darker than its sky = physically sane")
        print("optimise sky-land, NOT top3std - top3std is gameable by making "
              "the frame worse (see module docstring)")

    if a.json:
        with open(a.json, "w") as fh:
            json.dump(out, fh, indent=2)
        print(f"wrote {a.json}")


if __name__ == "__main__":
    main()
