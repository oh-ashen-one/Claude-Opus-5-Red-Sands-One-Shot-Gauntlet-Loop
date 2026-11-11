#!/usr/bin/env python3
"""
fardetail.py — how much STRUCTURE the far landforms carry, by spatial scale.

Wave M fixed the far field's VALUE: distant ridges are no longer brighter than
the sky behind them (see tools/farfield.py, which is the instrument for that and
is still the one that governs correctness). What wave M then exposed is that the
far field has the right range and the wrong texture. This tool measures that.

    python3 tools/fardetail.py shots/wave-n/*.png
    python3 tools/fardetail.py shots/wave-n/01-sunset-ridge.png --overlay /tmp/d

WHAT IT MEASURES

Inside the same per-pose far-land regions farfield.py uses (tools/farfield-rois.json,
audit them with --overlay before trusting a pose), it decomposes the region into
spatial-frequency bands by successive box blurs and reports how much luminance
energy lives in each band. Roughly: "~4px" is rock texture and erosion, "~8-16px"
is ridge and gully structure, "~32px" is the landform's gross shape.

Every number is DIVIDED BY THE REGION'S STANDARD DEVIATION, and that is the whole
design of this tool. See below.

WHY NORMALISED: THE LESSON FROM top_third_std

FOUNDATION #9 records that wave M's second success criterion, top_third_std, was
gameable: it could be raised by a change that doubled the very defect the wave
existed to fix, because it rewarded contrast without asking whether the contrast
was in the right place. Raw gradient energy has exactly the same hole. Multiply
any image by 1.5 and its gradient energy rises 1.5x while not one new detail
appears. A lane told to "raise gradient energy" could satisfy it by cranking
far-field contrast, which FOUNDATION #11 shows is already correct and must not be
touched.

Dividing by std removes that entirely: the normalised numbers are invariant to any
global scale or offset of the region. They can only move if the energy's
DISTRIBUTION ACROSS SCALES changes, which is what "add detail" actually means.

Verified, not asserted. Taking 01-sunset-ridge and applying a 1.5x contrast boost
about the mean raises the region's std 45.8 -> 64.9, a 42% increase, and moves the
normalised bands by at most 5% (0.0264 -> 0.0251 at ~2px) — that residual is pixels
clipping at 255, not signal. A +20 level offset is a no-op to three decimals. So a
lane cannot move these numbers by touching contrast, exposure or grade; it has to
put structure in the frame.

Measured, merged wave-M build against references/field_24, normalised:

    scale     ours 01   ours 05   reference   01 deficit
    ~2px       0.026     0.064      0.105        4.0x
    ~4px       0.015     0.043      0.088        5.8x
    ~8px       0.022     0.063      0.135        6.2x
    ~16px      0.036     0.084      0.156        4.3x
    ~32px      0.064     0.111      0.167        2.6x

Read that shape carefully, because it is the wave-N brief. The deficit is WORST at
4-8px and mildest at 32px, so our far landforms have approximately the right gross
silhouette and are missing the mid and fine structure that sits on it. And
05-summit, whose far mountains are nearer the camera, is ~3x better than 01 at
every scale, which points at distance-dependent detail falloff (LOD, normal-map
fade, mip bias, geometric tessellation) rather than at the base terrain shading,
which is shared between the two poses.

WHAT THIS TOOL CANNOT TELL YOU

That the detail is PLAUSIBLE. Value noise at 4px will raise every number here and
look like sandpaper. Aerial perspective must still soften structure with distance;
matching the reference band-for-band at 20 km would be its own defect. As always
on this project: the PNG governs and the numbers break ties.
"""

import sys, json, os
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROIS = os.path.join(HERE, "farfield-rois.json")
SCALES = (2, 4, 8, 16, 32)


def _luma(path):
    im = Image.open(path).convert("RGB")
    a = np.asarray(im, dtype=np.float64)
    return a @ np.array([0.2126, 0.7152, 0.0722]), im.size


def _box(a, k):
    """Separable box blur via cumulative sums. Keeps this tool to numpy+PIL,
    matching farfield.py — no scipy, so it runs anywhere the harness does."""
    if k < 2:
        return a.copy()
    out = a
    for axis in (0, 1):
        n = out.shape[axis]
        r = min(k, n)
        pad = [(0, 0), (0, 0)]
        pad[axis] = (r // 2, r - r // 2)
        p = np.pad(out, pad, mode="edge")
        c = np.cumsum(p, axis=axis)
        zero = np.zeros_like(np.take(c, [0], axis=axis))
        c = np.concatenate([zero, c], axis=axis)
        hi = np.take(c, range(r, r + n), axis=axis)
        lo = np.take(c, range(0, n), axis=axis)
        out = (hi - lo) / float(r)
    return out


def _region(L, box):
    H, W = L.shape
    x0, x1, y0, y1 = box
    return L[int(y0 * H):int(y1 * H), int(x0 * W):int(x1 * W)]


def bands(region):
    """Normalised energy per spatial band. Invariant to global scale/offset."""
    r = region.astype(np.float64)
    sd = r.std()
    if sd < 1e-6:
        return {k: 0.0 for k in SCALES}, sd
    prev, out = r, {}
    for k in SCALES:
        sm = _box(r, k)
        out[k] = float(np.abs(prev - sm).mean() / sd)
        prev = sm
    return out, sd


def measure(path, rois=None):
    rois = rois or json.load(open(ROIS))
    pose = os.path.splitext(os.path.basename(path))[0]
    spec = rois["poses"].get(pose) or rois.get("references", {}).get(pose)
    if not spec or "land" not in spec:
        return {"pose": pose, "skip": "no far-land region defined"}
    L, _ = _luma(path)
    r = _region(L, spec["land"])
    b, sd = bands(r)
    return {"pose": pose, "std": sd, "bands": b}


def main(argv):
    overlay = None
    if "--overlay" in argv:
        i = argv.index("--overlay")
        overlay = argv[i + 1]
        argv = argv[:i] + argv[i + 2:]
    paths = argv[1:]
    if not paths:
        print(__doc__)
        return 1

    rois = json.load(open(ROIS))
    ref = None
    refp = os.path.join(os.path.dirname(HERE), "references", "field_24.png")
    if os.path.exists(refp):
        ref = measure(refp, rois)

    hdr = f"{'pose':<20}{'std':>7}" + "".join(f"{'~'+str(k)+'px':>9}" for k in SCALES)
    print(hdr)
    print("-" * len(hdr))
    rows = []
    for p in paths:
        m = measure(p, rois)
        if m.get("skip"):
            print(f"{m['pose']:<20}{'-':>7}   ({m['skip']})")
            continue
        rows.append(m)
        print(f"{m['pose']:<20}{m['std']:7.1f}" +
              "".join(f"{m['bands'][k]:9.3f}" for k in SCALES))

    if ref and not ref.get("skip"):
        print("-" * len(hdr))
        print(f"{'REFERENCE field_24':<20}{ref['std']:7.1f}" +
              "".join(f"{ref['bands'][k]:9.3f}" for k in SCALES))
        if rows:
            print(f"{'deficit (x short)':<20}{'':>7}", end="")
            for k in SCALES:
                ours = np.mean([r["bands"][k] for r in rows])
                print(f"{(ref['bands'][k] / ours if ours > 1e-9 else float('inf')):9.1f}", end="")
            print()

    if overlay:
        os.makedirs(overlay, exist_ok=True)
        from PIL import ImageDraw
        for p in paths:
            pose = os.path.splitext(os.path.basename(p))[0]
            spec = rois["poses"].get(pose)
            if not spec:
                continue
            im = Image.open(p).convert("RGB")
            W, H = im.size
            d = ImageDraw.Draw(im)
            x0, x1, y0, y1 = spec["land"]
            d.rectangle([x0 * W, y0 * H, x1 * W, y1 * H], outline=(255, 255, 0), width=3)
            d.text((x0 * W + 6, y0 * H + 6), "FAR LAND", fill=(255, 255, 0))
            im.save(os.path.join(overlay, f"detail-{pose}.png"))
        print(f"\noverlays -> {overlay}")

    print("\nnormalised: invariant to contrast, so raising contrast cannot move these.")
    print("the PNG still governs - 4px noise scores well and looks like sandpaper.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
