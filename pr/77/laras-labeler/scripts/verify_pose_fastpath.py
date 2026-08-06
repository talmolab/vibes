#!/usr/bin/env python
"""Prove `poseio.read_poses` still matches `Labels.numpy(return_confidence=True)` bit-for-bit.

The fast HDF5 pose read is a reimplementation of someone else's semantics, so it needs a standing
check rather than a one-time one: a sleap-io upgrade can change what it is supposed to reproduce, and
a new pose source can have a layout the corpus never had. Run this after either.

Two halves, both on by default:

  corpus     every .slp under a root (default ~/laras-projects) read both ways and compared. Also
             times them, which is where the speedup claim comes from.
  synthetic  layouts the real corpus does not contain — user instances, invisible points, untracked
             instances, user-overrides-predicted, sparse frames, padding, duplicate track in a frame,
             and the single-instance case the fast path must DECLINE. Written to a temp dir.

    scripts/verify_pose_fastpath.py                        # both halves
    scripts/verify_pose_fastpath.py --synthetic            # just the edge cases (fast, no corpus)
    scripts/verify_pose_fastpath.py --corpus a.slp b.slp   # specific files

Exit status is nonzero if anything mismatched, so it works as a gate.
"""
from __future__ import annotations

import argparse
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import sleap_io as sio

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
from laras_labeler import poseio  # noqa: E402


def _diff(fast: np.ndarray, ref: np.ndarray) -> str | None:
    """None if bit-identical, else a description. 'Identical' = same NaN mask AND every finite value
    equal to the last bit — not np.allclose, which would hide exactly the drift we care about."""
    if fast.shape != ref.shape:
        return f"shape {fast.shape} != {ref.shape}"
    if not np.array_equal(np.isnan(fast), np.isnan(ref)):
        bad = np.argwhere(np.isnan(fast) != np.isnan(ref))[0]
        return (f"NaN mask differs, first at {tuple(bad)}: "
                f"fast={fast[tuple(bad)]} ref={ref[tuple(bad)]}")
    fin = ~np.isnan(ref)
    n = int((fast[fin] != ref[fin]).sum())
    if n:
        d = np.abs(fast[fin].astype("f8") - ref[fin].astype("f8"))
        return f"{n}/{int(fin.sum())} finite values differ, max|d|={d.max():.4g}"
    return None


def check_file(path: Path, quiet: bool = False) -> bool:
    t0 = time.perf_counter()
    labels = sio.load_file(str(path))
    t_load = time.perf_counter() - t0
    t0 = time.perf_counter()
    ref = labels.numpy(return_confidence=True).astype("float32")
    t_ref = time.perf_counter() - t0

    reasons: list[str] = []
    t0 = time.perf_counter()
    hdr = poseio.read_header(path)
    fast = poseio.read_poses(path, n_frames_hint=ref.shape[0], header=hdr,
                             on_fallback=reasons.append)
    t_fast = time.perf_counter() - t0
    slow = t_load + t_ref
    tag = f"sleap-io {slow:6.2f}s  fast {t_fast:6.3f}s  ({slow / max(t_fast, 1e-9):6.1f}x)"

    if fast is None:
        # Declining is legal, but on the real corpus it means losing the speedup, so flag it loudly.
        print(f"[WARN] {path.name[:44]:46} fell back: {'; '.join(reasons) or '?'}")
        return True
    bad = _diff(fast, ref)
    if bad is None and hdr is not None:
        if hdr.node_names != list(labels.skeletons[-1].node_names):
            bad = "node names differ"
        elif hdr.track_names != [t.name for t in labels.tracks]:
            bad = "track names differ"
    if bad:
        print(f"[BAD ] {path.name[:44]:46} {bad}   {tag}")
        return False
    if not quiet:
        print(f"[OK  ] {path.name[:44]:46} identical {ref.shape}   {tag}")
    return True


# --- synthetic layouts -------------------------------------------------------------------------

SK = sio.Skeleton(["nose", "body", "tail"])
NN = len(SK.nodes)


def _pred(rng, track, visible=(True, True, True), xy=None):
    xy = np.asarray(xy if xy is not None else rng.uniform(0, 100, (NN, 2)), dtype="float64")
    score = rng.uniform(0, 1, NN)
    inst = sio.PredictedInstance.from_numpy(points_data=xy, skeleton=SK, point_scores=score,
                                            score=float(score.mean()), track=track)
    inst.points["visible"] = np.asarray(visible, dtype=bool)
    return inst


def _user(rng, track, visible=(True, True, True), xy=None):
    xy = np.asarray(xy if xy is not None else rng.uniform(0, 100, (NN, 2)), dtype="float64")
    inst = sio.Instance.from_numpy(points_data=xy, skeleton=SK, track=track)
    inst.points["visible"] = np.asarray(visible, dtype=bool)
    return inst


def _write(frames_spec, tracks, n_video_frames) -> Path:
    video = sio.Video.from_filename("fake.mp4")
    video.backend_metadata = {"shape": (n_video_frames, 64, 64, 1), "filename": "fake.mp4"}
    lfs = [sio.LabeledFrame(video=video, frame_idx=i, instances=insts)
           for i, insts in sorted(frames_spec.items())]
    path = Path(tempfile.mkdtemp()) / "synth.slp"
    sio.Labels(labeled_frames=lfs, videos=[video], skeletons=[SK], tracks=tracks).save(str(path))
    return path


def synthetic_cases() -> list[tuple[str, Path, bool]]:
    rng = np.random.default_rng(7)
    a, b, c = sio.Track("a"), sio.Track("b"), sio.Track("c")
    P, U = lambda *ar, **kw: _pred(rng, *ar, **kw), lambda *ar, **kw: _user(rng, *ar, **kw)
    return [
        # (name, file, should the fast path handle it?)
        ("predicted dense", _write({i: [P(a), P(b)] for i in range(20)}, [a, b], 20), True),
        # xy must go NaN while the predicted score column survives — sleap-io masks only xy.
        ("invisible points keep score", _write(
            {i: [P(a, visible=(True, False, True)), P(b, visible=(False, False, False))]
             for i in range(10)}, [a, b], 10), True),
        ("user only (score 1.0)", _write(
            {i: [U(a), U(b, visible=(True, False, True))] for i in range(10)}, [a, b], 10), True),
        ("user overrides predicted", _write(
            {i: [P(a), P(b), P(c), U(a), U(b, visible=(False, True, True))]
             for i in range(10)}, [a, b, c], 10), True),
        ("sparse frames + padding", _write(
            {i: [P(a), P(b)] for i in (0, 3, 4, 9)}, [a, b], 25), True),
        ("untracked instances dropped", _write(
            {i: [P(a), P(b), P(None)] for i in range(10)}, [a, b], 10), True),
        ("unoccupied track column", _write(
            {i: [P(a), P(c)] for i in range(10)}, [a, b, c], 10), True),
        # two instances on one track in a frame -> the later one in file order wins.
        ("duplicate track in a frame", _write(
            {i: [P(a, xy=np.zeros((NN, 2))), P(b), P(a, xy=np.full((NN, 2), 42.0))]
             for i in range(10)}, [a, b], 10), True),
        # to_numpy switches to untracked column order here, so declining is the correct answer.
        ("single instance per frame", _write({i: [P(a)] for i in range(10)}, [a], 10), False),
    ]


def check_synthetic(name: str, path: Path, expect_fast: bool) -> bool:
    labels = sio.load_file(str(path))
    ref = labels.numpy(return_confidence=True).astype("float32")
    reasons: list[str] = []
    fast = poseio.read_poses(path, n_frames_hint=ref.shape[0], on_fallback=reasons.append)
    if fast is None:
        ok = not expect_fast
        print(f"[{'OK  ' if ok else 'BAD '}] {name:38} declined: {'; '.join(reasons) or '?'}")
        return ok
    if not expect_fast:
        print(f"[BAD ] {name:38} used the fast path but must decline")
        return False
    bad = _diff(fast, ref)
    print(f"[{'OK  ' if bad is None else 'BAD '}] {name:38} {bad or f'exact {ref.shape}'}")
    return bad is None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--corpus", nargs="*", metavar="SLP",
                    help="specific .slp files (default: every .slp under --root)")
    ap.add_argument("--root", default=str(Path.home() / "laras-projects"),
                    help="tree to scan for .slp files")
    ap.add_argument("--synthetic", action="store_true", help="skip the corpus, run only edge cases")
    ap.add_argument("--no-synthetic", action="store_true", help="skip the edge cases")
    args = ap.parse_args()

    failures = 0
    if not args.synthetic:
        paths = ([Path(p) for p in args.corpus] if args.corpus
                 else sorted(Path(args.root).rglob("*.slp")))
        print(f"=== corpus: {len(paths)} file(s) ===")
        for p in paths:
            failures += not check_file(p)
    if not args.no_synthetic:
        print("\n=== synthetic layouts ===")
        for name, path, expect in synthetic_cases():
            failures += not check_synthetic(name, path, expect)

    print(f"\n{'FAILED: ' + str(failures) + ' mismatch(es)' if failures else 'all checks passed'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
