"""Headless verification of the core SLP -> features recipe (PLAN.md sections 3-4).

Run once against the mice sample to retire the #1 risk (movement install + the
sleap-io -> movement transpose -> clean -> kinematics pipeline) before any UI work.

Usage:
    <venv>/bin/python scripts/verify_pipeline.py [path/to/file.slp]
"""

import os
import sys
import numpy as np
import sleap_io as sio
from movement.io import load_poses
from movement.filtering import (
    filter_by_confidence,
    interpolate_over_time,
    rolling_filter,
)
from movement.kinematics import compute_speed, compute_pairwise_distances

SLP = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("LARAS_SAMPLE_SLP","")


def main() -> int:
    print(f"[1] loading {SLP}")
    labels = sio.load_file(SLP)
    print(f"    {labels}")

    # (F, T, N, 3) = [x, y, score]  -- PLAN.md 3.1
    pose = labels.numpy(return_confidence=True)
    print(f"[2] Labels.numpy(return_confidence=True) -> {pose.shape} {pose.dtype}")
    assert pose.ndim == 4 and pose.shape[-1] == 3, "expected (F, T, N, 3)"
    F, T, N, _ = pose.shape

    xy, conf = pose[..., :2], pose[..., 2]
    # NaN semantics sanity: whole-instance absent (conf NaN) vs dropped keypoint (conf 0)
    print(f"    frames={F} tracks={T} nodes={N}  "
          f"conf max={np.nanmax(conf):.3f} (>1.0 expected)  "
          f"all-NaN frames={int((np.isnan(conf).all(axis=(1, 2))).sum())}")

    track_names = [t.name for t in labels.tracks]
    node_names = labels.skeletons[0].node_names
    fps = float(labels.videos[0].fps or 30.0)
    print(f"[3] tracks={track_names}  fps={fps}")

    # sleap-io (F,T,N,C) -> movement position (F,C,N,T), confidence (F,N,T)  -- PLAN.md 4.1
    position = np.transpose(xy, (0, 3, 2, 1)).astype("float32")
    confidence = np.transpose(conf, (0, 2, 1)).astype("float32")
    ds = load_poses.from_numpy(
        position, confidence,
        individual_names=track_names, keypoint_names=node_names,
        fps=fps, source_software="SLEAP",
    )
    print(f"[4] movement Dataset dims: {dict(ds.sizes)}")
    assert set(ds.sizes) == {"time", "space", "keypoint", "individual"}

    # cleaning (fixed order) -- PLAN.md 4.2; rolling_filter is NaN-tolerant
    pos = filter_by_confidence(ds.position, ds.confidence, threshold=0.0)
    pos = interpolate_over_time(pos)
    pos = rolling_filter(pos, window=5, statistic="median")
    print(f"[5] cleaned position dims: {dict(pos.sizes)}  "
          f"residual NaN frac={float(np.isnan(pos).mean()):.4f}")

    # base kinematics -- PLAN.md 4.4A
    speed = compute_speed(pos)
    print(f"[6] compute_speed -> {dict(speed.sizes)}")

    # inter-animal (social) distance -- PLAN.md 4.4B (pairs REQUIRED)
    if T >= 2:
        d = compute_pairwise_distances(pos.sel(keypoint="nose"), dim="individual", pairs="all")
        # 'all' -> dict of DataArrays keyed by pair; single pair -> one DataArray
        keys = list(d) if isinstance(d, dict) else ["<single>"]
        print(f"[7] compute_pairwise_distances(nose, dim='individual', pairs='all') -> pairs={keys}")
    else:
        print("[7] single animal -> social features NaN (skipped)")

    print("\nOK: core SLP -> features pipeline verified end-to-end.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
