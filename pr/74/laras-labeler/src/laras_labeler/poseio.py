"""Fast .slp pose reading: a vectorized HDF5 path that skips sleap-io's per-instance objects.

`Labels.numpy(return_confidence=True)` builds a Python `Instance` (and a `PointsArray`) for every
instance in the file — ~44k objects for a 5-min 3-mouse clip, ~530k for a full hour — which dominates
a feature build (measured 13.8 s of a 26.7 s build for one 5-min clip; 63% counting `load_file`).
Every value it needs is already a flat column in the .slp HDF5, so `read_poses` fills the output
array with two vectorized scatter writes instead.

This is a fast path, not a reimplementation: `read_poses` returns None whenever the file's layout
departs from what it has been verified against, and the caller falls back to sleap-io. It reproduces
`sleap_io.codecs.numpy.to_numpy(video=videos[0], untracked=False, return_confidence=True,
user_instances=True)` exactly — see `_unsupported` for the cases it declines and why.

Names (skeleton nodes, track order) still come from sleap-io's own metadata readers, which parse only
the small JSON header (~2 ms) and carry the skeleton-specific node ordering that is not safely
reproducible from the raw JSON by hand.
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable

import h5py
import numpy as np

# instances['instance_type'] (sleap_io.io.slp.InstanceType)
_USER = 0
_PREDICTED = 1

# format_id < 1.1 stores a legacy pixel convention that sleap-io shifts by -0.5 on read.
_MIN_FORMAT_ID = 1.1

_REQUIRED = ("frames", "instances", "points", "pred_points", "tracks_json", "metadata")


class PoseHeader:
    """Cheap per-file metadata: node names, track names, frame extent. Reads only the JSON header."""

    __slots__ = ("node_names", "track_names", "n_skeletons", "n_labeled_frames", "max_frame_idx")

    def __init__(self, node_names: list[str], track_names: list[str], n_skeletons: int,
                 n_labeled_frames: int, max_frame_idx: int) -> None:
        self.node_names = node_names
        self.track_names = track_names
        self.n_skeletons = n_skeletons
        self.n_labeled_frames = n_labeled_frames
        self.max_frame_idx = max_frame_idx


def read_header(slp_path: str | Path) -> PoseHeader | None:
    """Node/track names + frame extent for a .slp, without touching point data or the video.

    Returns None if the file isn't a readable SLP (e.g. the pose source is a bare .mp4)."""
    path = str(slp_path)
    try:
        with h5py.File(path, "r") as f:
            if not all(k in f for k in _REQUIRED):
                return None
            fidx = f["frames"]["frame_idx"][:]
        from sleap_io.io import slp as slpio

        skeletons = slpio.read_skeletons(path)
        tracks = slpio.read_tracks(path)
    except Exception:
        return None
    if not skeletons:
        return None
    return PoseHeader(
        node_names=list(skeletons[-1].node_names),       # to_numpy uses skeletons[-1]
        track_names=[t.name for t in tracks],
        n_skeletons=len(skeletons),
        n_labeled_frames=int(len(fidx)),
        max_frame_idx=int(fidx.max()) if len(fidx) else -1,
    )


def _unsupported(f: h5py.File, inst: np.ndarray, frames: np.ndarray, header: PoseHeader) -> str | None:
    """Reason to decline the fast path, or None. Each check guards a `to_numpy` behavior this module
    does not reproduce, so declining is always the safe answer."""
    if float(f["metadata"].attrs.get("format_id", 0.0)) < _MIN_FORMAT_ID:
        return "legacy format_id (<1.1) needs sleap-io's -0.5 pixel shift"
    if header.n_skeletons != 1:
        return f"{header.n_skeletons} skeletons — node count/order is per-instance"
    if len(header.track_names) != len(set(header.track_names)):
        # to_numpy picks a column with labels.tracks.index(track), which matches on equality, so
        # duplicate names would collapse onto the first column instead of the track's own index.
        return "duplicate track names"
    if len(frames) == 0 or len(inst) == 0:
        return "no labeled frames or no instances"
    if int(frames["frame_idx"].min()) < 0:
        return "negative frame_idx shifts to_numpy's frame origin"
    types = np.unique(inst["instance_type"])
    if not np.isin(types, (_USER, _PREDICTED)).all():
        return f"unknown instance_type {types.tolist()}"
    return None


def _last_per_slot(rows: np.ndarray, cols: np.ndarray, n_cols: int) -> np.ndarray:
    """Positions keeping only the LAST entry per (row, col), in input order.

    to_numpy builds a per-frame dict `track -> instance`, so when one frame holds two instances on the
    same track the later one in file order wins. Resolving that here keeps the scatter write from
    depending on numpy's (undocumented) duplicate-index assignment order."""
    key = rows.astype(np.int64) * n_cols + cols.astype(np.int64)
    order = np.argsort(key, kind="stable")
    k = key[order]
    keep = np.ones(len(k), dtype=bool)
    keep[:-1] = k[1:] != k[:-1]
    return np.sort(order[keep])


def read_poses(slp_path: str | Path, n_frames_hint: int | None = None,
               header: PoseHeader | None = None,
               on_fallback: Callable[[str], None] | None = None) -> np.ndarray | None:
    """(F, T, N, 3) float32 [x, y, score], NaN where missing — or None to use sleap-io instead.

    Equivalent to `Labels.numpy(return_confidence=True)` for the first video: xy is NaN wherever the
    point is not visible while the score column keeps its stored value (sleap-io masks only xy), user
    instances override predicted ones on the same track and score 1.0, and the frame axis is padded to
    the video length. `n_frames_hint` supplies that video length (the manifest's `n_frames`, recorded
    from the same `video.shape[0]` sleap-io would read) so the video file never has to be opened."""
    def decline(reason: str) -> None:
        if on_fallback:
            on_fallback(reason)
        return None

    path = str(slp_path)
    if header is None:
        header = read_header(path)
        if header is None:
            return decline("not a readable .slp")
    n_tracks, n_nodes = len(header.track_names), len(header.node_names)
    if n_tracks == 0 or n_nodes == 0:
        return decline("no tracks or no skeleton nodes")

    try:
        with h5py.File(path, "r") as f:
            frames = f["frames"][:]
            inst = f["instances"][:]
            bad = _unsupported(f, inst, frames, header)
            if bad:
                return decline(bad)

            frames = frames[frames["video"] == 0]        # to_numpy exports the first video only
            if len(frames) == 0:
                return decline("no frames for video 0")

            # instances carry frame_id; the output's frame axis is frame_idx.
            fid = frames["frame_id"].astype(np.int64)
            order = np.argsort(fid, kind="stable")
            fid_sorted = fid[order]
            pos = np.clip(np.searchsorted(fid_sorted, inst["frame_id"].astype(np.int64)),
                          0, len(fid_sorted) - 1)
            found = fid_sorted[pos] == inst["frame_id"].astype(np.int64)
            frame_row = np.where(found, order[pos], -1)
            frame_idx = frames["frame_idx"].astype(np.int64)

            # to_numpy counts max(n_user, n_predicted) over every instance in the video's frames —
            # tracked or not — and switches to `untracked` mode (one column, filled in frame order
            # rather than by track index) when that is 1. Rare; cheap to hand off.
            in_video = frame_row >= 0
            is_user = inst["instance_type"] == _USER
            n_user = np.bincount(frame_row[in_video & is_user], minlength=len(frames))
            n_pred = np.bincount(frame_row[in_video & ~is_user], minlength=len(frames))
            if int(np.maximum(n_user, n_pred).max(initial=0)) <= 1:
                return decline("single instance per frame — to_numpy uses untracked column order")

            track = inst["track"].astype(np.int64)
            keep = in_video & (track >= 0) & (track < n_tracks)

            starts = inst["point_id_start"].astype(np.int64)
            # Every instance must span exactly n_nodes contiguous, node-aligned point rows for the
            # reshape to (n_instances, n_nodes) below to be a valid view of the point table.
            if not np.array_equal(inst["point_id_end"].astype(np.int64) - starts,
                                  np.full(len(inst), n_nodes)):
                return decline("instances do not each span exactly n_nodes point rows")
            if not bool((starts % n_nodes == 0).all()):
                return decline("point_id_start is not node-aligned")

            n_frames = int(max(frame_idx.max() + 1, n_frames_hint or 0))
            out = np.full((n_frames, n_tracks, n_nodes, 3), np.nan, dtype="float32")

            # Predicted first, then user, so a user instance overwrites the predicted one on its track
            # (to_numpy's dict-override order).
            for want_user, dset in ((False, "pred_points"), (True, "points")):
                sel = np.flatnonzero(keep & (is_user == want_user))
                if len(sel) == 0:
                    continue
                n_pts = f[dset].shape[0]
                if n_pts % n_nodes or int(starts[sel].max()) + n_nodes > n_pts:
                    return decline(f"{dset} is too short for the instances that index into it")
                block = f[dset][:]
                sel = sel[_last_per_slot(frame_row[sel], track[sel], n_tracks)]
                pb = starts[sel] // n_nodes                       # this instance's row block
                vis = block["visible"].reshape(-1, n_nodes)[pb]
                rows, cols = frame_idx[frame_row[sel]], track[sel]
                out[rows, cols, :, 0] = np.where(vis, block["x"].reshape(-1, n_nodes)[pb], np.nan)
                out[rows, cols, :, 1] = np.where(vis, block["y"].reshape(-1, n_nodes)[pb], np.nan)
                # sleap-io masks only xy: a predicted point's score survives invisibility, and a user
                # instance scores 1.0 on every node whether visible or not.
                out[rows, cols, :, 2] = (block["score"].reshape(-1, n_nodes)[pb]
                                         if "score" in (block.dtype.names or ()) else 1.0)
    except Exception as e:                                   # never let the fast path break a build
        return decline(f"{type(e).__name__}: {e}")
    return out
