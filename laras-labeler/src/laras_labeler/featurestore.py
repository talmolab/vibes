"""Feature cache: memmapped (F, D) float32 per video + status/invalidation (PLAN.md §4.6, §3.3).

Invalidation keys on feature_config_hash + slp_content_hash stored in the per-video meta.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
from pathlib import Path

import numpy as np

from . import features as feat


def feature_config_hash(config: dict, roles: dict) -> str:
    payload = {
        "config": {k: config[k] for k in sorted(config)},
        "roles": {k: roles[k] for k in sorted(roles)} if roles else {},
        "code": feat.FEATURE_CODE_VERSION,
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:16]


def select_feature_cols(feature_names: list[str], feature_set: str | None) -> list[int]:
    """Column indices for a behavior's feature subset (per-behavior lean models). `None`/'all' → every
    column. Sets are matched on the base signal (the name before '__'):
      'spout'/'spout_only' → spout* only; 'cage' → cage* (arena-boundary) only; 'spout_cage' → both
      arena families (spout* + cage*); 'no_social' → drop social*; 'pose' → kinematics only (no
      spout/cage/social); 'social' → social* (focal-vs-nearest-other) only; 'social_pose' → social +
      pose kinematics, no arena landmarks (for interaction behaviors like fighting/following that need
      proximity AND motion). An unknown set or empty result falls back to all columns (never breaks fit)."""
    n = len(feature_names)
    if not feature_set or feature_set == "all":
        return list(range(n))
    base = lambda nm: nm.split("__")[0]
    keep = {
        "spout":       lambda b: b.startswith("spout"),
        "spout_only":  lambda b: b.startswith("spout"),
        "cage":        lambda b: b.startswith("cage"),
        "spout_cage":  lambda b: b.startswith("spout") or b.startswith("cage"),
        "no_social":   lambda b: not b.startswith("social"),
        "pose":        lambda b: not (b.startswith("spout") or b.startswith("cage") or b.startswith("social")),
        "social":      lambda b: b.startswith("social"),
        "social_pose": lambda b: not (b.startswith("spout") or b.startswith("cage")),
    }.get(feature_set)
    if keep is None:
        return list(range(n))
    cols = [i for i, nm in enumerate(feature_names) if keep(base(nm))]
    return cols or list(range(n))


def suggest_feature_set(name: str) -> tuple[str | None, str]:
    """Heuristic default feature set for a NEW behavior from its name, per the empirically-validated axis
    rule (see ~/Downloads/mouse_behavior_feature_guide.md): social/interaction → social_pose; location →
    landmark sets; cage-structure → no_social; solo motion → pose. Returns (feature_set, reason). Falls
    back to no_social (drop social) when nothing matches — most home-cage behaviors are solo. Always
    overridable; the point is to never silently start a behavior on 'all' (which is almost never best)."""
    n = (name or "").lower()

    def has(*ws):
        return any(w in n for w in ws)

    # arena-position behaviors FIRST, so e.g. 'wall-following' isn't mis-read as social 'following'
    if has("thigmotax", "wall-follow", "wall follow", "perimeter", "center-cross", "center cross"):
        return "cage", "location behavior — arena-position (cage) features are the signal"
    # ingestive/location at the water spout — landmark features win, kinematics measurably hurt
    if has("drink", "lick", "spout", "water"):
        return "spout_cage", "location behavior at the spout — landmark features win (drinking: kinematics hurt)"
    if has("eat", "feed", "hopper", "food", "forag", "chew", "gnaw"):
        return "cage", "feeding at a fixed cage location — arena position (cage) localizes the hopper"
    # social / interaction behaviors — need inter-animal proximity + the actor's own motion
    if has("fight", "aggress", "attack", "chase", "spar", "wrestl", "tail rattl", "follow", "mount",
           "social", "allogroom", "huddl", "approach", "investigat", "nose-to", "nose to", "conspecific",
           "cagemate", "mate", "copulat", "boxing"):
        return "social_pose", "social/interaction behavior — needs proximity + motion; arena/spout features are noise"
    # cage-structure behaviors: a position component plus motion
    if has("climb", "rear", "jump", "hang", "rim", "cage top", "lid", "descen", "drop"):
        return "no_social", "cage-structure behavior — pose + arena landmarks (drop social)"
    # solo kinematic behaviors — body motion only; arena/spout/social columns are off-axis noise
    if has("walk", "run", "locomot", "ambulat", "turn", "pivot", "circl", "freez", "rest", "immobil",
           "sleep", "dig", "burrow", "scratch", "shake", "groom", "stretch", "sniff", "scan", "dart",
           "pause", "tremor", "gait", "twitch", "backward"):
        return "pose", "solo kinematic behavior — body motion only (arena/spout/social are off-axis noise)"
    return "no_social", "no strong name match — defaulting to no_social (drop social); pick a set from the guide if wrong"


def slp_content_hash(path: str | Path) -> str:
    st = os.stat(path)
    return hashlib.sha256(f"{st.st_size}:{int(st.st_mtime)}".encode()).hexdigest()[:16]


class FeatureStore:
    def __init__(self, store, video_manager) -> None:
        self.store = store            # ProjectStore
        self.vm = video_manager       # VideoManager (for pose + skeleton)
        # per-(pid,vid) compute lock: background pre-warm and a lazy train-time compute can both target
        # the same clip; serialize them so two threads never write the same .npy/meta at once (and the
        # loser sees the cache is ready and returns instead of recomputing).
        self._compute_locks: dict[tuple[str, str], threading.Lock] = {}
        self._locks_guard = threading.Lock()

    def _lock_for(self, pid: str, vid: str) -> "threading.Lock":
        with self._locks_guard:
            lk = self._compute_locks.get((pid, vid))
            if lk is None:
                lk = self._compute_locks[(pid, vid)] = threading.Lock()
            return lk

    def _dir(self, pid: str) -> Path:
        return self.store.get(pid).path / "features"

    def _npy(self, pid: str, vid: str) -> Path:
        return self._dir(pid) / f"{vid}.npy"

    def _meta(self, pid: str, vid: str) -> Path:
        return self._dir(pid) / f"{vid}.meta.json"

    def _clip_cfg(self, proj, entry: dict) -> dict:
        """Feature config for one clip: a per-clip `spout`/`spout_roi` in the video entry overrides the
        project-wide default, so clips from different cameras carry their own arena landmarks. Because
        this feeds the per-video feature hash, changing one clip's ROI invalidates only that clip."""
        cfg = dict(proj.manifest["feature_config"])
        for k in ("spout", "spout_roi", "cage_roi"):
            if entry.get(k) is not None:
                cfg[k] = entry[k]
        return cfg

    def _expected_hashes(self, pid: str, vid: str) -> tuple[str, str]:
        proj = self.store.get(pid)
        entry = proj.video(vid)
        cfg = self._clip_cfg(proj, entry)
        roles = proj.manifest.get("skeleton_roles", {})
        slp = entry.get("slp_path") or entry["video_path"]
        return feature_config_hash(cfg, roles), slp_content_hash(slp)

    def status(self, pid: str, vid: str) -> dict:
        entry = self.store.get(pid).video(vid)
        if not entry or not entry.get("has_poses"):
            return {"status": "none", "reason": "no poses"}
        mp = self._meta(pid, vid)
        if not mp.exists() or not self._npy(pid, vid).exists():
            return {"status": "none"}
        meta = json.loads(mp.read_text())
        try:
            cfg_h, slp_h = self._expected_hashes(pid, vid)
        except FileNotFoundError:
            # The source video/pose file is gone (e.g. an ephemeral scratch dir got swept), but the
            # feature cache the model actually reads (load()) is still on disk and unaffected — treat
            # it as ready (training/prediction keep working) rather than crashing the whole project
            # load. Playback for this clip just won't be possible until the source file is restored.
            return {"status": "ready", "D": meta.get("D"), "source_missing": True}
        if meta.get("feature_config_hash") != cfg_h or meta.get("slp_content_hash") != slp_h:
            return {"status": "stale", "D": meta.get("D")}
        return {"status": "ready", "D": meta.get("D")}

    def load(self, pid: str, vid: str) -> np.ndarray:
        """Memmapped (F, D) float32."""
        return np.load(self._npy(pid, vid), mmap_mode="r")

    def meta(self, pid: str, vid: str) -> dict:
        return json.loads(self._meta(pid, vid).read_text())

    def compute(self, pid: str, vid: str, progress=lambda p, m: None) -> dict:
        """Compute + cache features for one clip. Serialized per (pid, vid): a background pre-warm and a
        lazy train-time compute can both target the same clip, so we hold a per-clip lock and — if the
        cache turned ready while we waited — return it instead of recomputing (no double write, no race)."""
        with self._lock_for(pid, vid):
            if self.status(pid, vid).get("status") == "ready":
                meta = json.loads(self._meta(pid, vid).read_text())
                progress(100, "already cached")
                return {"D": meta.get("D"), "n_frames": meta.get("n_frames"),
                        "dropped": meta.get("dropped_features", [])}
            return self._compute_now(pid, vid, progress)

    def _compute_now(self, pid: str, vid: str, progress=lambda p, m: None) -> dict:
        proj = self.store.get(pid)
        entry = proj.video(vid)
        cfg = self._clip_cfg(proj, entry)                  # per-clip spout/ROI override the project default
        roles = proj.manifest.get("skeleton_roles", {})

        progress(5, "loading poses")
        ov = self.vm._get(pid, vid)
        pose = ov.poses()                                  # (F, T, N, 3)
        node_names = [n for n in ov.labels.skeletons[0].node_names]
        track_names = [t.name for t in ov.labels.tracks]
        fps = float(entry["fps"])

        progress(20, f"features: {pose.shape[0]} frames x {pose.shape[1]} animals (per-track)")
        X, names, dropped, resolved = feat.compute_per_track_features(pose, node_names, track_names,
                                                                      fps, cfg, roles)   # (F, T, D)
        progress(85, f"writing cache (T={X.shape[1]}, D={X.shape[2]})")

        # persist resolved roles back to the manifest if not set
        if not roles and resolved:
            proj.manifest["skeleton_roles"] = resolved
            proj.save()
            roles = resolved

        self._dir(pid).mkdir(parents=True, exist_ok=True)
        np.save(self._npy(pid, vid), X)
        cfg_h, slp_h = self._expected_hashes(pid, vid)
        meta = {
            "D": int(X.shape[2]),
            "n_tracks": int(X.shape[1]),
            "n_frames": int(X.shape[0]),
            "feature_names": names,
            "dropped_features": dropped,
            "feature_config_hash": cfg_h,
            "slp_content_hash": slp_h,
            "fps": fps,
            "status": "ready",
        }
        self._meta(pid, vid).write_text(json.dumps(meta))
        progress(100, "done")
        return {"D": meta["D"], "n_frames": meta["n_frames"], "dropped": dropped}
