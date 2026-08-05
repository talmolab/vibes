#!/usr/bin/env python
"""Draw a BLIND, confidence-stratified sample of predicted bouts, then score it.

The question this answers: does a bout's confidence tell you whether the bout is real? If it does, you
can threshold on it and stop reporting counts at the model's raw bout precision (0.56-0.69 on the
current models). If it doesn't, confidence is not a usable filter and every bout needs review.

Why blind: the reviewer must not see the probability. Knowing a bout scored 0.95 biases the verdict
toward "real", which is exactly the correlation under test. So `draw` writes two files —

    <out>.csv        what you review: shuffled, no probability, an empty `verdict` column
    <out>.key.csv    what you must not read until scoring: bout_id -> probability + band

Sampling is stratified over confidence bands rather than uniform, because a uniform sample of a
skewed score distribution leaves the high-confidence tail with too few bouts to estimate precision in.
That means the sample is NOT representative of the bout population — per-band precision is the valid
output, and a population precision has to be recovered by reweighting by each band's true share
(`draw` records those shares in the key so `score` can do it).

    scripts/sample_bouts.py draw  --pid day25-day150 --per-band 8 --out /tmp/sample
    # ... fill in the verdict column with y (real) / n (false alarm) / ? (can't tell) ...
    scripts/sample_bouts.py score --key /tmp/sample.key.csv --reviewed /tmp/sample.csv
"""
from __future__ import annotations

import argparse
import csv
import json
import random
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
from laras_labeler.predict import DEFAULT_POSTPROC, bouts_from_proba  # noqa: E402

BANDS = [(0.5, 0.6), (0.6, 0.7), (0.7, 0.8), (0.8, 0.9), (0.9, 1.01)]


def _band_sort(band: str) -> float:
    """Order bands by confidence, so the sub-0.5 bucket leads instead of sorting after '0.9'."""
    return -1.0 if band == "<0.5" else float(band.split("-")[0])


def band_of(p: float) -> str:
    for lo, hi in BANDS:
        if lo <= p < hi:
            return f"{lo:.1f}-{min(hi, 1.0):.1f}"
    return "<0.5"


def collect(root: Path, manifest: dict, true_fps: float) -> list[dict]:
    """Every predicted bout in the project, with its confidence."""
    out = []
    for v in manifest["videos"]:
        vid, n_frames = v["video_id"], v["n_frames"]
        for b in manifest["behaviors"]:
            bid = b["id"]
            f = root / "predictions" / vid / f"{bid}.npy"
            if not f.exists():
                continue
            pp = {**DEFAULT_POSTPROC, **(b.get("postproc") or {})}
            arr = np.load(f)
            A = arr if arr.shape[0] <= 8 else arr.T
            for t in range(A.shape[0]):
                proba = A[t]
                for s, e in bouts_from_proba(proba, pp["smooth"], pp["hi"], pp["lo"],
                                             pp["min_bout"], pp["min_gap"]):
                    seg = proba[s:e]
                    mp = float(np.nanmean(seg))
                    out.append({"video_id": vid, "track": t, "behavior_id": bid,
                                "behavior": b["name"], "start_frame": s, "end_frame": e,
                                "frames": e - s, "dur_real_s": round((e - s) / true_fps, 3),
                                "mean_proba": round(mp, 4),
                                "max_proba": round(float(np.nanmax(seg)), 4),
                                "band": band_of(mp)})
    return out


def draw(a) -> int:
    root = Path(a.projects_root) / a.pid
    manifest = json.loads((root / "project.json").read_text())
    bouts = collect(root, manifest, a.true_fps)
    if not bouts:
        print("no predicted bouts — has the project been predicted?", file=sys.stderr)
        return 1

    rng = random.Random(a.seed)
    by_band: dict[str, list[dict]] = {}
    for b in bouts:
        by_band.setdefault(b["band"], []).append(b)

    picked = []
    for band, items in sorted(by_band.items(), key=lambda kv: _band_sort(kv[0])):
        take = rng.sample(items, min(a.per_band, len(items)))
        for it in take:
            it["band_population"] = len(items)          # for reweighting at score time
        picked.extend(take)
    rng.shuffle(picked)                                  # presentation order must not encode confidence

    out = Path(a.out)
    review_p, key_p = out.with_suffix(".csv"), out.with_suffix(".key.csv")
    rev_cols = ["bout_id", "behavior", "video_id", "track", "start_frame", "end_frame",
                "dur_real_s", "verdict", "note"]
    with open(review_p, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=rev_cols)
        w.writeheader()
        for i, b in enumerate(picked, 1):
            b["bout_id"] = i
            w.writerow({**{k: b.get(k, "") for k in rev_cols}, "verdict": "", "note": ""})
    with open(key_p, "w", newline="") as fh:
        cols = ["bout_id", "behavior", "video_id", "track", "start_frame", "end_frame",
                "mean_proba", "max_proba", "band", "band_population"]
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        w.writerows({k: b[k] for k in cols} for b in picked)

    print(f"{len(bouts)} predicted bouts in {a.pid}; sampled {len(picked)}")
    print(f"\n{'band':<10} {'population':>11} {'sampled':>8}")
    for band, items in sorted(by_band.items(), key=lambda kv: _band_sort(kv[0])):
        print(f"{band:<10} {len(items):>11} {min(a.per_band, len(items)):>8}")
    print(f"\n  review this  -> {review_p}   (no probabilities: keep it that way while reviewing)")
    print(f"  do not open  -> {key_p}")
    print("\nMark `verdict` as y (real bout of that behavior) / n (false alarm) / ? (can't tell).")
    print("Judge each bout on the video alone. Reviewing in the GUI: set order=random and jump to the frames.")
    return 0


def score(a) -> int:
    key = {int(r["bout_id"]): r for r in csv.DictReader(open(a.key))}
    rows = list(csv.DictReader(open(a.reviewed)))
    seen = [(int(r["bout_id"]), (r.get("verdict") or "").strip().lower()) for r in rows]
    filled = [(i, v) for i, v in seen if v in ("y", "n")]
    unclear = sum(1 for _, v in seen if v == "?")
    if not filled:
        print("no y/n verdicts found in the reviewed file", file=sys.stderr)
        return 1

    per: dict[str, list[int]] = {}
    for i, v in filled:
        per.setdefault(key[i]["band"], []).append(1 if v == "y" else 0)

    print(f"scored {len(filled)} bouts ({unclear} marked '?', {len(seen) - len(filled) - unclear} blank)\n")
    print(f"{'band':<10} {'n':>4} {'precision':>10} {'95% CI':>16}   {'pop share':>10}")
    tot_pop = sum(int(key[i]['band_population']) for i in {i for i, _ in filled})
    pop_by_band, num, den = {}, 0.0, 0.0
    for i, _ in filled:
        pop_by_band[key[i]["band"]] = int(key[i]["band_population"])
    for band in sorted(per, key=_band_sort):
        v = per[band]
        n, k = len(v), sum(v)
        p = k / n
        # Wilson interval — Wald is unusable at p near 0 or 1 with n this small
        z, lo, hi = 1.96, 0.0, 1.0
        denom = 1 + z * z / n
        centre = (p + z * z / (2 * n)) / denom
        half = z * ((p * (1 - p) / n + z * z / (4 * n * n)) ** 0.5) / denom
        lo, hi = max(0.0, centre - half), min(1.0, centre + half)
        share = pop_by_band[band] / sum(pop_by_band.values())
        print(f"{band:<10} {n:>4} {p:>10.2f} {f'[{lo:.2f}, {hi:.2f}]':>16}   {share:>10.1%}")
        num += p * pop_by_band[band]
        den += pop_by_band[band]
    print(f"\npopulation precision, reweighted by band share: {num / den:.3f}")
    print("Compare against the model's own cross-validated bout_precision. If precision rises steeply")
    print("with the band, a confidence threshold is worth applying; if it is flat, confidence is not a")
    print("usable filter and bout counts need full review instead.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("draw", help="draw a blind stratified sample")
    d.add_argument("--projects-root", default=str(Path.home() / "laras-projects"))
    d.add_argument("--pid", required=True)
    d.add_argument("--per-band", type=int, default=8)
    d.add_argument("--true-fps", type=float, default=50.0)
    d.add_argument("--seed", type=int, default=0)
    d.add_argument("--out", required=True, help="path prefix; writes <out>.csv and <out>.key.csv")
    d.set_defaults(fn=draw)

    s = sub.add_parser("score", help="score filled-in verdicts against the key")
    s.add_argument("--key", required=True)
    s.add_argument("--reviewed", required=True)
    s.set_defaults(fn=score)

    a = ap.parse_args()
    return a.fn(a)


if __name__ == "__main__":
    raise SystemExit(main())
