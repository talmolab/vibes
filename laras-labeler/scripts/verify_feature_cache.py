#!/usr/bin/env python
"""Recompute each clip's features and diff against the cached .npy — the no-silent-drift gate.

`feature_config_hash` covers feature_config, skeleton roles and FEATURE_CODE_VERSION. It does NOT
cover *how* a column is computed, so an optimization that shifts a value by one float32 bit leaves
every cache on disk marked "ready" while disagreeing with a fresh build. Models were fit on the cached
matrices, so that disagreement is silent and permanent.

Run this after touching anything in features.py, poseio.py or video.py. A bit-identical result means
existing caches, trained models and published metrics all stand. If you INTEND to change values, bump
FEATURE_CODE_VERSION instead — that invalidates caches properly — and expect to retrain.

    scripts/verify_feature_cache.py --windows                       # no project data needed
    scripts/verify_feature_cache.py --pid single-cage-test
    scripts/verify_feature_cache.py --pid longitudinal-batch10 --vid day150_2025-10-08
    scripts/verify_feature_cache.py --pid single-cage-test --bench   # + per-phase timing

Clips whose .slp/.mp4 is not reachable (e.g. VAST unmounted) are skipped, not failed.
"""
from __future__ import annotations

import argparse
import sys
import time
import warnings
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
from laras_labeler import features as feat  # noqa: E402
from laras_labeler.featurestore import FeatureStore  # noqa: E402
from laras_labeler.project import ProjectStore  # noqa: E402
from laras_labeler.video import VideoManager  # noqa: E402


def phases(ov, entry, cfg, roles) -> None:
    """Per-phase timing, so a regression can be attributed to load / base / windowing."""
    fps = float(entry["fps"])
    t0 = time.perf_counter()
    pose = ov.poses()
    t_pose = time.perf_counter() - t0
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        t0 = time.perf_counter()
        base, present, _, _, _, T = feat._base_features(pose, ov.node_names, ov.track_names,
                                                        fps, cfg, roles)
        t_base = time.perf_counter() - t0
        radii = feat._radii(cfg, fps)
        t0 = time.perf_counter()
        for t in range(T):
            feat._window_signals({k: np.where(present[:, t], a[:, t], np.nan)
                                  for k, a in base.items()}, radii)
        t_win = time.perf_counter() - t0
    total = t_pose + t_base + t_win
    print(f"       phases: pose {t_pose:6.3f}s ({100 * t_pose / total:2.0f}%)  "
          f"base {t_base:6.3f}s ({100 * t_base / total:2.0f}%)  "
          f"window {t_win:6.3f}s ({100 * t_win / total:2.0f}%)")


def check_windows() -> bool:
    """`_window_signals` vs a literal pandas transcription of what it replaced. Needs no project data.

    Covers the length regime real clips never exercise: a signal shorter than one window, where
    bottleneck refuses the window outright and the code has to fall back."""
    import pandas as pd

    def reference(signals, radii):
        names, cols = [], []
        for nm, s in signals.items():
            s = np.asarray(s, dtype="float64")
            ser = pd.Series(s)
            names.append(f"{nm}__raw"); cols.append(s.astype("float32"))
            for r in radii:
                roll = ser.rolling(2 * r + 1, center=True, min_periods=1)
                for st, fn in (("mean", roll.mean), ("std", roll.std),
                               ("min", roll.min), ("max", roll.max)):
                    names.append(f"{nm}__{st}__r{r}"); cols.append(fn().to_numpy("float32"))
                names.append(f"{nm}__change__r{r}")
                cols.append((ser.shift(-r) - ser.shift(r)).to_numpy("float32"))
        return np.ascontiguousarray(np.stack(cols, axis=1), dtype="float32"), names

    rng = np.random.default_rng(3)
    radii = [2, 8, 15]
    ok = True
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        for F in (1, 2, 5, 10, 30, 31, 32, 100, 5000):
            s = rng.normal(size=F)
            if F > 4:
                s[F // 2] = np.nan                       # a dropout
                s[max(0, F - 3):] = 12345.0              # a constant tail (std cancellation)
            sig = {"a": s, "all_nan": np.full(F, np.nan)}
            X, names = feat._window_signals(sig, radii)
            R, rnames = reference(sig, radii)
            fin = ~np.isnan(R)
            good = (names == rnames
                    and np.array_equal(np.isnan(X), np.isnan(R))
                    and bool((X[fin] == R[fin]).all()))
            ok &= good
            print(f"[{'OK  ' if good else 'BAD '}] window signals, F={F:<5} "
                  f"{'identical to pandas' if good else 'DIFFERS'}")
    return ok


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=str(Path.home() / "laras-projects"))
    ap.add_argument("--windows", action="store_true",
                    help="only check _window_signals against pandas (no project data needed)")
    ap.add_argument("--pid")
    ap.add_argument("--vid", nargs="*", help="only these video ids (default: all cached clips)")
    ap.add_argument("--bench", action="store_true", help="also print the per-phase timing split")
    args = ap.parse_args()

    if args.windows:
        return 0 if check_windows() else 1
    if not args.pid:
        ap.error("--pid is required unless --windows is given")

    store = ProjectStore(Path(args.root))
    vm = VideoManager(store)
    fs = FeatureStore(store, vm)
    proj = store.get(args.pid)
    if proj is None:
        print(f"no such project: {args.pid}")
        return 2
    roles = proj.manifest.get("skeleton_roles", {})

    n_ok = n_run = n_skip = 0
    for v in proj.videos:
        vid = v["video_id"]
        if args.vid and vid not in args.vid:
            continue
        if fs.status(args.pid, vid).get("status") != "ready":
            continue
        src = v.get("slp_path") or v["video_path"]
        if not Path(src).exists():
            print(f"[skip] {vid[:44]:46} source not reachable")
            n_skip += 1
            continue

        cfg = fs._clip_cfg(proj, v)
        ref = np.asarray(np.load(fs._npy(args.pid, vid), mmap_mode="r"))
        t0 = time.perf_counter()
        ov = vm._get(args.pid, vid)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            X, names, _, _ = feat.compute_per_track_features(
                ov.poses(), ov.node_names, ov.track_names, float(v["fps"]), cfg, roles)
        dt = time.perf_counter() - t0
        n_run += 1

        if X.shape != ref.shape:
            print(f"[BAD ] {vid[:44]:46} shape {X.shape} != {ref.shape}")
        elif not np.array_equal(np.isnan(X), np.isnan(ref)):
            bad = np.argwhere(np.isnan(X) != np.isnan(ref))[0]
            print(f"[BAD ] {vid[:44]:46} NaN mask differs at {tuple(bad)} "
                  f"(column {names[bad[2]]})")
        else:
            fin = ~np.isnan(ref)
            n_diff = int((X[fin] != ref[fin]).sum())
            if n_diff:
                d = np.abs(X.astype("f8") - ref.astype("f8"))
                worst = names[int(np.nanargmax(np.nanmax(d, axis=(0, 1))))]
                print(f"[BAD ] {vid[:44]:46} {n_diff}/{int(fin.sum())} values differ, "
                      f"max|d|={np.nanmax(d):.4g}, worst column {worst}   build {dt:6.2f}s")
            else:
                n_ok += 1
                print(f"[OK  ] {vid[:44]:46} identical {X.shape}   build {dt:6.2f}s")
        if args.bench:
            phases(ov, v, cfg, roles)
        del X, ref
        vm.forget(args.pid, vid)          # pose arrays are ~100 MB (1 GB for a full hour)

    tail = f" ({n_skip} skipped)" if n_skip else ""
    print(f"\n{n_ok}/{n_run} bit-identical to cache{tail}")
    return 0 if n_run and n_ok == n_run else 1


if __name__ == "__main__":
    sys.exit(main())
