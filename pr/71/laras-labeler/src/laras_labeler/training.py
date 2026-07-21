"""Per-behavior training (PLAN.md §5).

One binary HistGradientBoostingClassifier per behavior, trained on labeled frames sliced
from the feature memmap. Bouts (RLE runs) are the CV groups (StratifiedGroupKFold) so
temporally-adjacent frames never leak train->test. Models persist per behavior at
model/<behavior_id>/<version>.joblib with an authoritative meta.json.
"""

from __future__ import annotations

import hashlib
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.metrics import (average_precision_score, confusion_matrix,
                             precision_recall_fscore_support)
from sklearn.model_selection import StratifiedGroupKFold, cross_val_predict
from sklearn.pipeline import Pipeline

from .featurestore import feature_config_hash, select_feature_cols


def make_model() -> Pipeline:
    # NOTE (deviates from PLAN.md D6): HistGradientBoosting is ~10x too slow on this Intel Mac
    # (~5s/fit at 50 iters, measured), which breaks the interactive loop. RandomForest fits in
    # ~0.6s. RF can't take NaN natively (pose data has ~0.6% NaN), so a constant imputer precedes
    # it; keep_empty_features keeps D stable if a feature column is ever all-NaN. HGB/LightGBM
    # remain a drop-in upgrade on faster hardware.
    return Pipeline([
        ("impute", SimpleImputer(strategy="constant", fill_value=0.0, keep_empty_features=True)),
        ("clf", RandomForestClassifier(n_estimators=100, n_jobs=-1,
                                       class_weight="balanced_subsample", random_state=0)),
    ])


def grouped_eval(X: np.ndarray, y: np.ndarray, groups: np.ndarray) -> dict:
    pos_g = len(np.unique(groups[y == 1]))
    neg_g = len(np.unique(groups[y == 0]))
    if pos_g < 2 or neg_g < 2:
        return {"warning": "not enough labeled bouts per class for a trustworthy estimate",
                "n_pos_groups": pos_g, "n_neg_groups": neg_g}
    n_splits = int(min(5, pos_g, neg_g))
    cv = StratifiedGroupKFold(n_splits=n_splits, shuffle=True, random_state=0)
    proba = cross_val_predict(make_model(), X, y, groups=groups, cv=cv,
                              method="predict_proba")[:, 1]
    pred = (proba >= 0.5).astype(int)
    p, r, f1, _ = precision_recall_fscore_support(y, pred, labels=[1], average="binary",
                                                  zero_division=0)
    # bout-level: each CV group is one labeled bout; the model "calls" it positive if its mean
    # cross-validated probability >= 0.5. TP = true-pos bout called positive.
    b_tp = b_pred = b_pos = 0
    for g in np.unique(groups):
        m = groups == g
        gt_pos = int(y[m][0]) == 1
        pred_pos = float(np.nanmean(proba[m])) >= 0.5
        b_pos += gt_pos
        b_pred += pred_pos
        b_tp += gt_pos and pred_pos
    return {"precision": float(p), "recall": float(r), "f1": float(f1),
            "average_precision": float(average_precision_score(y, proba)),
            "bout_precision": float(b_tp / b_pred) if b_pred else 0.0,
            "bout_recall": float(b_tp / b_pos) if b_pos else 0.0,
            "confusion": confusion_matrix(y, pred, labels=[0, 1]).tolist(),
            "n_pos_groups": pos_g, "n_neg_groups": neg_g, "n_splits": n_splits}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _auc(pos: np.ndarray, neg: np.ndarray) -> float:
    """P(a random positive-frame value > a random negative-frame value) — Mann-Whitney AUC, tie-aware.
    0.5 = no separation; distance from 0.5 is a scale-free measure of how much the feature differs."""
    from scipy.stats import rankdata
    n_pos, n_neg = len(pos), len(neg)
    r = rankdata(np.concatenate([pos, neg]))
    u = r[:n_pos].sum() - n_pos * (n_pos + 1) / 2.0
    return float(u / (n_pos * n_neg))


def _build_trainset(proj, used, bouts, version, trained_at,
                    n_pos, n_neg, n_pos_bouts, n_neg_bouts) -> dict:
    """Structure the flat bout list into a per-video / per-track summary + the full bout list,
    frozen at train time. `used` preserves the order videos were pooled; each bout is one CV group."""
    by_vid: dict[str, dict[int, dict]] = {}
    for bt in bouts:
        tk = by_vid.setdefault(bt["video_id"], {}).setdefault(
            bt["track"], {"track": bt["track"], "pos_bouts": 0, "neg_bouts": 0,
                          "pos_frames": 0, "neg_frames": 0})
        if bt["value"] == 1:
            tk["pos_bouts"] += 1
            tk["pos_frames"] += bt["n_frames"]
        else:
            tk["neg_bouts"] += 1
            tk["neg_frames"] += bt["n_frames"]
    videos = []
    for vid in used:
        tracks = by_vid.get(vid, {})
        vinfo = proj.video(vid) or {}
        name = Path(str(vinfo.get("video_path", ""))).name or vid
        tlist = [tracks[t] for t in sorted(tracks)]
        videos.append({
            "video_id": vid, "name": name,
            "pos_bouts": sum(t["pos_bouts"] for t in tlist),
            "neg_bouts": sum(t["neg_bouts"] for t in tlist),
            "pos_frames": sum(t["pos_frames"] for t in tlist),
            "neg_frames": sum(t["neg_frames"] for t in tlist),
            "tracks": tlist,
        })
    return {"version": version, "trained_at": trained_at, "n_videos": len(used),
            "n_pos": n_pos, "n_neg": n_neg, "n_pos_bouts": n_pos_bouts, "n_neg_bouts": n_neg_bouts,
            "videos": videos, "bouts": bouts}


class Trainer:
    def __init__(self, store, labels, features) -> None:
        self.store = store
        self.labels = labels
        self.features = features

    def _dir(self, pid: str, bid: int) -> Path:
        return self.store.get(pid).path / "model" / str(bid)

    def model_meta(self, pid: str, bid: int) -> dict | None:
        mp = self._dir(pid, bid) / "meta.json"
        return json.loads(mp.read_text()) if mp.exists() else None

    def history(self, pid: str, bid: int) -> list:
        hp = self._dir(pid, bid) / "history.json"
        return json.loads(hp.read_text()) if hp.exists() else []

    def trainset(self, pid: str, bid: int) -> dict | None:
        """The frozen provenance of the current model: which videos/tracks/bouts it was trained on."""
        tp = self._dir(pid, bid) / "trainset.json"
        return json.loads(tp.read_text()) if tp.exists() else None

    def load_model(self, pid: str, bid: int):
        meta = self.model_meta(pid, bid)
        if not meta:
            return None
        return joblib.load(self._dir(pid, bid) / f"{meta['version']}.joblib")

    def gather(self, pid: str, bid: int):
        """Per-track examples pooled across tracks and videos. One row per (video, track, frame).
        CV groups = bouts (contiguous same-value runs) per (video, track). Also returns `bouts`: the
        exact provenance of the training set — one dict per CV group (video, track, [start, end),
        value, n_frames) — so we can later show/serve 'what this model was trained on'."""
        proj = self.store.get(pid)
        Xs, ys, gs, rows, used, skipped, bouts = [], [], [], [], [], [], []
        gid = 0
        for v in proj.videos:
            vid = v["video_id"]
            if not v.get("has_poses"):
                continue
            rdf = self.labels.rows_for_behavior(pid, vid, bid)      # track, frame, value
            if len(rdf) == 0:
                continue
            if self.features.status(pid, vid)["status"] != "ready":
                skipped.append({"video_id": vid, "reason": "features not ready"})
                continue
            Xf = self.features.load(pid, vid)                      # memmap (F, T, D)
            rdf = rdf[rdf["value"] != 2]                            # drop 'Unknown' (value 2) — not a training target
            if len(rdf) == 0:
                continue
            for tk, sub in rdf.groupby("track"):
                sub = sub.sort_values("frame")
                frames = sub["frame"].to_numpy()
                vals = sub["value"].to_numpy().astype("int8")
                Xs.append(np.asarray(Xf[frames, int(tk), :], dtype="float32"))
                ys.append(vals)
                newb = np.ones(len(frames), dtype=bool)
                if len(frames) > 1:
                    newb[1:] = (frames[1:] != frames[:-1] + 1) | (vals[1:] != vals[:-1])
                boutid = gid + np.cumsum(newb) - 1
                gs.append(boutid.astype("int32"))
                gid = int(boutid[-1]) + 1
                rows.extend((vid, int(tk), int(f), int(val)) for f, val in zip(frames, vals))
                starts = np.flatnonzero(newb)                      # one CV group == one contiguous same-value run
                ends = np.append(starts[1:], len(frames))
                for si, ei in zip(starts, ends):
                    bouts.append({"video_id": vid, "track": int(tk),
                                  "start": int(frames[si]), "end": int(frames[ei - 1]) + 1,
                                  "value": int(vals[si]), "n_frames": int(ei - si)})
            used.append(vid)
        if not Xs:
            return None
        return (np.concatenate(Xs), np.concatenate(ys), np.concatenate(gs),
                rows, used, skipped, bouts)

    def feature_diff(self, pid: str, bid: int, top_n: int = 12, bins: int = 24,
                     max_per_class: int = 8000) -> dict:
        """How each keypoint feature differs between this behavior's positive and negative labeled
        frames (pooled per-track, exactly as the model sees them). Per feature: pos/neg mean & std,
        Mann-Whitney AUC (scale-free separation), Cohen's d, and density histograms for the top ones.
        Returns the most-discriminative features first."""
        got = self.gather(pid, bid)
        if got is None:
            return {"error": "no labeled frames with features ready — label some, then Train or Predict once"}
        X, y, _groups, _rows, used, _skipped, _bouts = got
        D = int(X.shape[1])
        names = None
        for vid in used:
            try:
                names = self.features.meta(pid, vid).get("feature_names")
            except Exception:
                names = None
            if names and len(names) == D:
                break
        if not names or len(names) != D:
            names = [f"f{i}" for i in range(D)]
        pos_idx, neg_idx = np.flatnonzero(y == 1), np.flatnonzero(y == 0)
        n_pos, n_neg = int(len(pos_idx)), int(len(neg_idx))
        if n_pos == 0 or n_neg == 0:
            return {"error": f"need both positive and negative labels (pos={n_pos}, neg={n_neg})"}
        rng = np.random.default_rng(0)                     # subsample for speed; plenty for distributions
        if n_pos > max_per_class:
            pos_idx = rng.choice(pos_idx, max_per_class, replace=False)
        if n_neg > max_per_class:
            neg_idx = rng.choice(neg_idx, max_per_class, replace=False)
        Xp, Xn = np.asarray(X[np.sort(pos_idx)], dtype="float64"), np.asarray(X[np.sort(neg_idx)], dtype="float64")
        # Require real support so a mostly-occluded (near-all-NaN) column can't saturate sep on a handful
        # of points and dominate the ranking. Need enough of BOTH classes present for this feature.
        min_support = max(20, int(0.05 * min(len(Xp), len(Xn))))
        feats = []
        for d in range(D):
            p, n = Xp[:, d], Xn[:, d]
            p, n = p[~np.isnan(p)], n[~np.isnan(n)]
            if len(p) < min_support or len(n) < min_support:
                continue
            mp, mn, sp, sn = float(p.mean()), float(n.mean()), float(p.std()), float(n.std())
            pooled = np.sqrt((sp * sp + sn * sn) / 2.0)
            auc = _auc(p, n)
            d_eff = 0.0 if pooled < 1e-9 else float(np.clip((mp - mn) / pooled, -20.0, 20.0))   # cap the degenerate blow-up
            feats.append({"name": names[d], "index": d, "auc": auc, "sep": abs(auc - 0.5) * 2.0,
                          "cohens_d": d_eff, "mean_pos": mp, "mean_neg": mn,
                          "std_pos": sp, "std_neg": sn, "coverage": int(min(len(p), len(n)))})
        feats.sort(key=lambda f: -f["sep"])
        top = feats[:top_n]
        for f in top:                                      # dual density histograms for the top features
            d = f["index"]
            p, n = Xp[:, d], Xn[:, d]
            p, n = p[~np.isnan(p)], n[~np.isnan(n)]
            # union of per-class 1/99 percentiles so an imbalanced minority class isn't clipped into one bin
            lo = float(min(np.percentile(p, 1), np.percentile(n, 1)))
            hi = float(max(np.percentile(p, 99), np.percentile(n, 99)))
            if hi <= lo:
                hi = lo + 1e-6
            edges = np.linspace(lo, hi, bins + 1)
            ph, _ = np.histogram(np.clip(p, lo, hi), bins=edges, density=True)
            nh, _ = np.histogram(np.clip(n, lo, hi), bins=edges, density=True)
            f["hist"] = {"lo": lo, "hi": hi, "pos": [float(x) for x in ph], "neg": [float(x) for x in nh]}
        return {"behavior_id": bid, "n_pos": n_pos, "n_neg": n_neg, "D": D,
                "sampled_pos": int(len(pos_idx)), "sampled_neg": int(len(neg_idx)),
                "videos_used": used, "features": top,
                "ranked": [{"name": f["name"], "sep": f["sep"], "auc": f["auc"], "cohens_d": f["cohens_d"]}
                           for f in feats[:max(top_n, 24)]]}

    def _version(self, bid: int, rows: list, cfg_hash: str, params: dict) -> str:
        key = json.dumps({"b": bid, "rows": sorted(rows), "fc": cfg_hash,
                          "p": {k: str(v) for k, v in params.items()}}, sort_keys=True)
        return hashlib.sha256(key.encode()).hexdigest()[:16]

    def _ensure_features(self, pid: str, bid: int, progress) -> None:
        """Build the feature memmap for any labeled video that isn't ready yet (idempotent).
        Runs in-process so the resolved skeleton_roles + feature-config hash stay consistent
        with what gather()/status() expect."""
        proj = self.store.get(pid)
        todo = [v["video_id"] for v in proj.videos
                if v.get("has_poses")
                and len(self.labels.rows_for_behavior(pid, v["video_id"], bid)) > 0
                and self.features.status(pid, v["video_id"])["status"] != "ready"]
        for i, vid in enumerate(todo):
            lo, hi = int(i / len(todo) * 25), int((i + 1) / len(todo) * 25)
            self.features.compute(
                pid, vid,
                lambda p, m, lo=lo, hi=hi: progress(lo + int(p / 100 * (hi - lo)), f"features {vid[:18]}: {m}"))

    def train(self, pid: str, bid: int, progress=lambda p, m: None) -> dict:
        proj = self.store.get(pid)
        _t0 = time.perf_counter()
        self._ensure_features(pid, bid, progress)      # build missing feature caches before gathering
        feature_seconds = round(time.perf_counter() - _t0, 2)   # ~0 when pre-warmed; large = cold compute
        progress(28, "gathering labeled frames")
        got = self.gather(pid, bid)
        if got is None:
            raise ValueError("no labeled frames for this behavior — label some Happening / Not-happening frames first")
        X, y, groups, rows, used, skipped, bouts = got
        n_pos, n_neg = int((y == 1).sum()), int((y == 0).sum())
        n_pos_bouts = int(len(np.unique(groups[y == 1])))
        n_neg_bouts = int(len(np.unique(groups[y == 0])))
        # seed-vs-candidate provenance of this training set (bouts NOT from the candidate loop = 'seed';
        # 'candidate' = accepted during review) — so the learning curve / A-B can show how many candidate
        # bouts it took to reach each performance level.
        n_seed_bouts = n_candidate_bouts = 0
        _sb = next((b for b in self.labels.source_stats(pid).get("behaviors", []) if b["behavior_id"] == bid), None)
        if _sb:
            for _cl in _sb["clips"]:
                for _t in _cl["tracks"]:
                    for _src, _d in _t["sources"].items():
                        _nb = int(_d.get("pos_bouts", 0)) + int(_d.get("neg_bouts", 0))
                        if _src == "candidate":
                            n_candidate_bouts += _nb
                        else:
                            n_seed_bouts += _nb
        # what actually went into this model — training always pools every track & clip, so surface
        # the breakdown to the UI (which only *shows* the active track) as proof nothing was left out.
        tracks = sorted({int(t) for _, t, _, _ in rows})
        pos_by_track = {int(t): int(((y == 1) & (np.array([r[1] for r in rows]) == t)).sum()) for t in tracks}
        if n_pos == 0 or n_neg == 0:
            raise ValueError(f"need both positive and negative labels (pos={n_pos}, neg={n_neg})")

        # per-behavior feature subset (lean models): e.g. drinking learns better from spout-only
        beh = next((b for b in proj.behaviors if b["id"] == bid), {})
        feature_set = beh.get("feature_set")
        fnames = self.features.meta(pid, used[0]).get("feature_names") or []
        cols = select_feature_cols(fnames, feature_set)
        if len(cols) != X.shape[1]:
            X = X[:, cols]

        progress(40, f"cross-validating ({n_pos} pos / {n_neg} neg frames, {X.shape[1]} feats)")
        metrics = grouped_eval(X, y, groups)

        progress(75, "fitting model")
        pipe = make_model().fit(X, y)
        cfg = proj.manifest["feature_config"]
        roles = proj.manifest.get("skeleton_roles", {})
        cfg_hash = feature_config_hash(cfg, roles)
        # salt the version with the feature_set so different subsets never collide on a model filename
        version = self._version(bid, rows, cfg_hash if not feature_set else f"{cfg_hash}|{feature_set}",
                                pipe.named_steps["clf"].get_params())

        d = self._dir(pid, bid)
        d.mkdir(parents=True, exist_ok=True)
        joblib.dump(pipe, d / f"{version}.joblib")
        # how long this training round took: total wall time (feature-ensure + gather + CV + fit + save),
        # with the feature-ensure portion broken out (≈0 when the cache was pre-warmed, large on a cold
        # compute) so a slow round is attributable. NB: excludes the separate predict-over-videos step.
        train_seconds = round(time.perf_counter() - _t0, 2)
        meta = {"behavior_id": bid, "version": version, "trained_at": _now(),
                "feature_config_hash": cfg_hash, "feature_set": feature_set, "n_features": int(X.shape[1]),
                "n_pos": n_pos, "n_neg": n_neg,
                "n_pos_bouts": n_pos_bouts, "n_neg_bouts": n_neg_bouts,
                "train_seconds": train_seconds, "feature_seconds": feature_seconds,
                "videos_used": used, "skipped": skipped, "metrics": metrics}
        (d / "meta.json").write_text(json.dumps(meta, indent=2))

        # frozen training-set provenance: exactly which videos/tracks/bouts fed THIS model version
        # (snapshot now — labels change after training, so we can't reconstruct it later from labels).
        trainset = _build_trainset(proj, used, bouts, version, meta["trained_at"],
                                   n_pos, n_neg, n_pos_bouts, n_neg_bouts)
        (d / "trainset.json").write_text(json.dumps(trainset))

        # learning-curve history: one point per train (metrics vs. how much is labeled)
        hist_path = d / "history.json"
        history = json.loads(hist_path.read_text()) if hist_path.exists() else []
        history.append({"trained_at": meta["trained_at"], "n_pos": n_pos, "n_neg": n_neg,
                        "n_pos_bouts": n_pos_bouts, "n_neg_bouts": n_neg_bouts,
                        "n_seed_bouts": n_seed_bouts, "n_candidate_bouts": n_candidate_bouts,
                        "feature_set": feature_set or "all", "n_features": int(X.shape[1]),
                        "n_videos": len(used), "version": version,
                        "train_seconds": train_seconds, "feature_seconds": feature_seconds,
                        "ap": metrics.get("average_precision"), "f1": metrics.get("f1"),
                        "precision": metrics.get("precision"), "recall": metrics.get("recall"),
                        "bout_precision": metrics.get("bout_precision"), "bout_recall": metrics.get("bout_recall")})
        hist_path.write_text(json.dumps(history))

        b = next(x for x in proj.behaviors if x["id"] == bid)
        b["model"] = {"version": version, "trained_at": meta["trained_at"],
                      "f1": metrics.get("f1"), "n_pos": n_pos, "n_neg": n_neg}
        proj.save()

        progress(100, "done")
        return {"version": version, "metrics": metrics, "n_pos": n_pos, "n_neg": n_neg,
                "n_pos_bouts": n_pos_bouts, "n_neg_bouts": n_neg_bouts,
                "n_seed_bouts": n_seed_bouts, "n_candidate_bouts": n_candidate_bouts,
                "train_seconds": train_seconds, "feature_seconds": feature_seconds,
                "tracks": tracks, "pos_by_track": pos_by_track,
                "videos_used": used, "skipped": skipped}
