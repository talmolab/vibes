#!/usr/bin/env python
"""Export every bout in a project to CSV — one row per (clip, behavior, track, bout).

Fills the gap the GUI leaves: the Training-set panel is a snapshot frozen at train time, and
`label-stats` returns counts only, so there is no way to get a live bout list spanning clips.

Two kinds of row, selectable with --source:
  predicted  segment the cached per-frame probabilities with the project's own postproc rules
  labeled    the human/candidate labels as stored (value 1 = Happening)

`cage` and `age_days` are emitted per row so bouts can be compared ACROSS CAGES at matched age —
cage comes from the cam token in the clip id, age from an `ageNNN` token if present.

TIME IS REPORTED TWICE, on purpose. Clips are registered at 30 fps but the HCM sources are 50 fps
(the extraction wrote 15k/180k contiguous 50 fps frames into a 30 fps container), so anything the
GUI shows in seconds is 1.667x too long. `frames` and `dur_declared_s` follow the project's 30 fps;
`*_real_s` and the per-minute rates use --true-fps and are the numbers to publish.

CAUTION — `track` is a per-clip column index, not an animal. Track 0 in one clip and track 0 in
another are generally different mice, so never group by `track` alone; group by (video_id, track).

    scripts/export_bouts.py --pid day25-day150 --out bouts.csv
    scripts/export_bouts.py --pid default --source labeled --out labeled.csv
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
from laras_labeler.predict import DEFAULT_POSTPROC, bouts_from_proba  # noqa: E402

CAM_RE = re.compile(r"cam[_-]?0*(\d+)")
AGE_RE = re.compile(r"age(\d+)")


def _runs_of(arr: np.ndarray, value: int):
    """Contiguous [start, end) runs where arr == value."""
    hit = np.flatnonzero(arr == value)
    if not hit.size:
        return
    breaks = np.flatnonzero(np.diff(hit) > 1)
    for s, e in zip(np.r_[0, breaks + 1], np.r_[breaks, hit.size - 1]):
        yield int(hit[s]), int(hit[e]) + 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--projects-root", default=str(Path.home() / "laras-projects"))
    ap.add_argument("--pid", required=True)
    ap.add_argument("--source", choices=("predicted", "labeled", "both"), default="predicted")
    ap.add_argument("--behaviors", help="comma-separated behavior ids (default: all)")
    ap.add_argument("--true-fps", type=float, default=50.0, help="real source frame rate (default 50)")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    root = Path(a.projects_root) / a.pid
    manifest = json.loads((root / "project.json").read_text())
    want = {int(x) for x in a.behaviors.split(",")} if a.behaviors else None
    behaviors = [b for b in manifest["behaviors"] if want is None or b["id"] in want]
    if not behaviors:
        print("no matching behaviors", file=sys.stderr)
        return 1

    sources = ("predicted", "labeled") if a.source == "both" else (a.source,)
    rows, summary = [], {}

    for v in manifest["videos"]:
        vid, declared = v["video_id"], float(v["fps"])
        m = CAM_RE.search(vid)
        cam = f"cam_{int(m.group(1)):02d}" if m else ""
        m = AGE_RE.search(vid)
        age = int(m.group(1)) if m else ""
        minutes_real = v["n_frames"] / a.true_fps / 60.0

        for b in behaviors:
            bid, pp = b["id"], {**DEFAULT_POSTPROC, **(b.get("postproc") or {})}

            for src in sources:
                if src == "predicted":
                    f = root / "predictions" / vid / f"{bid}.npy"
                    if not f.exists():
                        continue
                    arr = np.load(f)
                    A = arr if arr.shape[0] <= 8 else arr.T          # -> (tracks, frames)
                    per_track = {
                        t: (list(bouts_from_proba(A[t], pp["smooth"], pp["hi"], pp["lo"],
                                                  pp["min_bout"], pp["min_gap"])), A[t])
                        for t in range(A.shape[0])
                    }
                else:
                    f = root / "labels" / f"{vid}.parquet"
                    if not f.exists():
                        continue
                    import pandas as pd
                    df = pd.read_parquet(f)
                    df = df[(df["behavior_id"] == bid) & (df["value"] == 1)]
                    per_track = {}
                    for t, g in df.groupby("track"):
                        marked = np.zeros(v["n_frames"], dtype=np.int8)
                        marked[g["frame"].to_numpy()] = 1
                        per_track[int(t)] = (list(_runs_of(marked, 1)), None)

                for t, (bouts, proba) in sorted(per_track.items()):
                    summary[(vid, b["name"], src, t)] = [len(bouts), sum(e - s for s, e in bouts), minutes_real]
                    for s, e in bouts:
                        rows.append({
                            "pid": a.pid, "video_id": vid, "cage": cam, "age_days": age,
                            "behavior_id": bid, "behavior": b["name"], "feature_set": b.get("feature_set", ""),
                            "track": t, "source": src,
                            "start_frame": s, "end_frame": e, "frames": e - s,
                            "start_real_s": round(s / a.true_fps, 3),
                            "end_real_s": round(e / a.true_fps, 3),
                            "dur_real_s": round((e - s) / a.true_fps, 3),
                            "dur_declared_s": round((e - s) / declared, 3),
                            "mean_proba": round(float(np.mean(proba[s:e])), 4) if proba is not None else "",
                        })

    if not rows:
        print("no bouts found — has the project been predicted?", file=sys.stderr)
        return 1

    with open(a.out, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    print(f"wrote {len(rows)} bouts -> {a.out}\n")
    print(f"{'clip':<24} {'behavior':<19} {'src':<9} {'trk':>3} {'bouts':>6} {'real_s':>8} {'per_min':>8}")
    for (vid, name, src, t), (n, fr, mins) in sorted(summary.items()):
        print(f"{vid[:24]:<24} {name[:19]:<19} {src:<9} {t:>3} {n:>6} "
              f"{fr / a.true_fps:>8.1f} {n / mins:>8.2f}")
    print(f"\nseconds and rates use --true-fps {a.true_fps}; 'dur_declared_s' follows the project's "
          f"declared fps and reads 1.667x long.")
    print("group by (video_id, track) — `track` is a per-clip index, not an animal identity.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
