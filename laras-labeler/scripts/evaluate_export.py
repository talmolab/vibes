"""Headless real-signal check: given a pose .slp + an event-annotator .json export,
run the exact laras-labeler pipeline (features -> mutual-exclusion labels -> per-behavior
grouped-CV) and print honest per-behavior metrics. No server / no video needed.

Usage:
    .venv/bin/python scripts/evaluate_export.py path/to/preds.slp path/to/export.json [track]

`track` (optional int) restricts to one trackIdx; omit to use all tracks (whole-frame,
matching the current tool). This tells you whether real behaviors are separable from
pose features before investing in multi-video / per-track.
"""

import json
import sys

import numpy as np
import sleap_io as sio

from laras_labeler import features as F
from laras_labeler.project import DEFAULT_FEATURE_CONFIG
from laras_labeler.training import grouped_eval


def rle_bouts(frames, vals):
    """Contiguous same-value, consecutive-frame runs -> group id per row."""
    gid, groups = 0, [0]
    for i in range(1, len(frames)):
        if frames[i] != frames[i - 1] + 1 or vals[i] != vals[i - 1]:
            gid += 1
        groups.append(gid)
    return np.array(groups)


def main():
    slp_path, json_path = sys.argv[1], sys.argv[2]
    track = int(sys.argv[3]) if len(sys.argv) > 3 else None

    print(f"[load] {slp_path}")
    lb = sio.load_file(slp_path)
    pose = lb.numpy(return_confidence=True).astype("float32")   # (F, T, N, 3)
    nodes = list(lb.skeletons[0].node_names)
    tracks = [t.name for t in lb.tracks]
    fps = float(lb.videos[0].fps or 30.0)
    n = pose.shape[0]
    print(f"       frames={n} tracks={len(tracks)} nodes={len(nodes)} fps={fps}")
    print(f"       skeleton: {nodes}")

    print("[features] whole-frame (pooled over all animals)…")
    X, names, dropped, roles = F.compute_feature_matrix(pose, nodes, tracks, fps, DEFAULT_FEATURE_CONFIG, {})
    print(f"       X_wholeframe={X.shape}  roles={roles}  dropped={dropped}  NaN={np.isnan(X).mean():.3f}")
    print("[features] per-track (per focal animal)…")
    Xpt, _, _, _ = F.compute_per_track_features(pose, nodes, tracks, fps, DEFAULT_FEATURE_CONFIG, {})
    print(f"       X_pertrack={Xpt.shape}  (frames, tracks, D_per_track)")

    data = json.loads(open(json_path).read())
    et = {e["id"]: e for e in data.get("eventTypes", [])}
    occ = np.full(n, -1, dtype=np.int32)
    names_by_bid, bid = {}, {}
    nb = 0
    for seg in data.get("segments", []):
        eid = seg["eventTypeId"]
        if et.get(eid, {}).get("isEraser"):
            continue
        if track is not None and seg.get("trackIdx") != track:
            continue
        s = max(0, min(n, int(seg["startFrame"])))
        e = max(0, min(n, int(seg["endFrame"])))
        if e <= s:
            continue
        if eid not in bid:
            bid[eid] = nb; names_by_bid[nb] = et.get(eid, {}).get("name", eid); nb += 1
        occ[s:e] = bid[eid]

    focal = track if track is not None else 0     # per-track uses this focal animal
    print(f"\n[labels] tracks in export: {sorted({s.get('trackIdx') for s in data['segments']})} "
          f"| labels track={'all' if track is None else track} | per-track focal={focal}")
    print(f"{'behavior':16s} {'pos':>6s} {'neg':>6s} {'posB':>4s}  {'AP wholeframe':>13s}  {'AP per-track':>12s}  base")
    print("-" * 84)
    for eid, b in bid.items():
        pos = occ == b
        neg = (occ != b) & (occ != -1)
        frames = np.where(pos | neg)[0]
        y = pos[frames].astype(int)
        groups = rle_bouts(frames, y)
        n_pos, n_neg = int(pos.sum()), int(neg.sum())
        pb = len(np.unique(groups[y == 1]))
        base = n_pos / (n_pos + n_neg)

        def ap(Xmat):
            m = grouped_eval(np.asarray(Xmat[frames]), y, groups)
            return None if "warning" in m else m["average_precision"]

        ap_wf = ap(X)
        ap_pt = ap(Xpt[:, focal, :])
        f_wf = f"{ap_wf:.3f}" if ap_wf is not None else "—(few bouts)"
        f_pt = f"{ap_pt:.3f}" if ap_pt is not None else "—"
        mark = " ↑" if (ap_wf and ap_pt and ap_pt > ap_wf + 0.01) else ""
        print(f"{names_by_bid[b]:16s} {n_pos:6d} {n_neg:6d} {pb:4d}  {f_wf:>13s}  {f_pt:>12s}{mark}  {base:.2f}")

    print("\nAP vs base: >base = real separable signal. '↑' = per-track beats whole-frame "
          "(focal animal's own features are cleaner than pooling across all animals).")


if __name__ == "__main__":
    main()
