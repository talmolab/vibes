"""Prediction + active-learning suggestions (PLAN.md §5.2, §6).

Predicts per-frame probability for a behavior across a project's videos (from the feature
memmap) and stores predictions/<vid>.parquet (frame + one float32 column per behavior).
Suggestions rank UNLABELED frames by uncertainty (|p-0.5|), diversified so you don't get
20 near-identical frames from one wobble.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from .featurestore import select_feature_cols

DEFAULT_POSTPROC = {"smooth": 5, "hi": 0.6, "lo": 0.4, "min_bout": 3, "min_gap": 3,
                    "social_gate_s": 0.5,   # drop a candidate if >=2 mice are in the spout ROI this long (v8 drinking filter)
                    "min_cand": 8,          # don't surface a REVIEW candidate shorter than this many frames (~0.27s @30fps):
                                            # a 3-8-frame flicker is barely watchable and usually boundary noise. Per-behavior
                                            # overridable; keep it BELOW a behavior's real bout floor (brief drinks/jumps exist).
                                            # Applies to review candidates only — detection bouts still use min_bout.
                    "max_cand": 200}        # cap a REVIEW candidate at this many frames: a long, sustained behaviour
                                            # (e.g. a 50s grooming episode) is a real single bout, but reviewing it as
                                            # one giant yes/no is unwieldy, so we split it into <=max_cand windows.
                                            # Detection bouts (bouts_from_proba) are NOT capped — only the review items.


def bouts_from_proba(proba: np.ndarray, smooth=5, hi=0.6, lo=0.4, min_bout=3, min_gap=3):
    """Per-frame proba -> predicted bouts (PLAN.md §5.3): smooth -> hysteresis -> length/gap filter."""
    p = pd.Series(proba).rolling(max(1, smooth), center=True, min_periods=1).mean().to_numpy()
    p = np.nan_to_num(p, nan=0.0)
    F = len(p)
    above_lo, above_hi = p >= lo, p >= hi
    d = np.diff(above_lo.astype(int))
    starts = list(np.where(d == 1)[0] + 1)
    ends = list(np.where(d == -1)[0] + 1)
    if above_lo[0]:
        starts = [0] + starts
    if above_lo[-1]:
        ends = ends + [F]
    bouts = [(s, e) for s, e in zip(starts, ends) if above_hi[s:e].any() and e - s >= min_bout]
    merged: list[list[int]] = []
    for s, e in bouts:
        if merged and s - merged[-1][1] < min_gap:
            merged[-1][1] = e
        else:
            merged.append([s, e])
    return [(int(s), int(e)) for s, e in merged]


def _max_true_run(mask: np.ndarray) -> int:
    """Longest contiguous run of True in a boolean array (0 if none)."""
    m = np.asarray(mask, dtype=bool)
    if not m.any():
        return 0
    d = np.diff(np.concatenate(([0], m.view(np.int8), [0])))
    return int((np.flatnonzero(d == -1) - np.flatnonzero(d == 1)).max())


def _unlabeled_subruns(labeled: np.ndarray, s: int, e: int, min_len: int):
    """Maximal runs of *unlabeled* frames inside the predicted bout [s, e), each >= min_len.
    A candidate is a question about frames you haven't answered yet, so we subtract the labeled
    mask from each predicted bout and only propose the gaps that remain."""
    out, i = [], s
    while i < e:
        if labeled[i]:
            i += 1
            continue
        j = i
        while j < e and not labeled[j]:
            j += 1
        if j - i >= min_len:
            out.append((i, j))
        i = j
    return out


def _split_capped(s: int, e: int, max_len: int):
    """Split [s, e) into near-equal windows each <= max_len frames, so a single review candidate never
    spans a whole multi-second episode. Returns [(s, e)] unchanged when already within the cap or when
    the cap is disabled (max_len <= 0). Windows are equal-length (via linspace) rather than [200,200,…,rem]
    so a long bout doesn't end in a tiny leftover sliver."""
    n = e - s
    if max_len <= 0 or n <= max_len:
        return [(s, e)]
    k = int(np.ceil(n / max_len))
    edges = np.linspace(s, e, k + 1).round().astype(int)
    return [(int(edges[i]), int(edges[i + 1])) for i in range(k) if edges[i + 1] > edges[i]]


class Predictor:
    def __init__(self, store, features, trainer, labels) -> None:
        self.store = store
        self.features = features
        self.trainer = trainer
        self.labels = labels

    def _path(self, pid: str, vid: str, bid: int) -> Path:
        return self.store.get(pid).path / "predictions" / vid / f"{bid}.npy"

    def _ready_videos(self, pid: str) -> list[str]:
        proj = self.store.get(pid)
        return [v["video_id"] for v in proj.videos
                if v.get("has_poses") and self.features.status(pid, v["video_id"])["status"] == "ready"]

    def predict_one(self, pid: str, vid: str, bid: int, model=None) -> str:
        """Run one behavior's model over one video's feature memmap -> predictions/<vid>/<bid>.npy.
        Returns a status: 'ok' | 'no_model' | 'feature_mismatch: …' — the reason is surfaced to the UI
        so a skipped prediction is never silent (the common trap: a new clip missing the spout/cage ROI
        the model was trained with, so its feature count doesn't match)."""
        model = model if model is not None else self.trainer.load_model(pid, bid)
        if model is None:
            return "no_model"
        Xf = self.features.load(pid, vid)                          # memmap (F, T, D)
        F, T, D = Xf.shape
        # apply the behavior's feature subset (same as train) so the model gets the columns it expects
        beh = next((b for b in self.store.get(pid).behaviors if b["id"] == bid), {})
        fset = beh.get("feature_set")
        try:
            fnames = self.features.meta(pid, vid).get("feature_names") or []
        except (FileNotFoundError, ValueError):
            fnames = []
        cols = select_feature_cols(fnames, fset) if fnames else list(range(D))
        exp = getattr(model, "n_features_in_", None)               # model trained on a different feature set/version
        if exp is not None and exp != len(cols):
            # two distinct causes, opposite directions: clip has FEWER features than the model -> it's
            # missing an ROI the model was trained with (set the ROI); clip has MORE -> the model is stale
            # (trained on an older feature-code version), so retrain the behavior on the current features.
            if len(cols) < exp:
                why = ("this clip is missing the spout/cage ROI the model was trained with — "
                       "set the same ROIs as the training clips, then predict again")
            else:
                why = ("this behavior's model is out of date (trained on an older feature version) — "
                       "retrain the behavior on the current features, then predict again")
            return (f"feature_mismatch: model expects {exp} features (set '{fset or 'all'}'), "
                    f"this clip has {len(cols)} — {why}.")
        sub = len(cols) != D
        proba = np.empty((F, T), dtype="float32")
        for t in range(T):
            Xt = np.asarray(Xf[:, t, :])
            proba[:, t] = model.predict_proba(Xt[:, cols] if sub else Xt)[:, 1].astype("float32")
        p = self._path(pid, vid, bid)
        p.parent.mkdir(parents=True, exist_ok=True)
        np.save(p, proba)                                          # (F, T)
        return "ok"

    def predict_behavior(self, pid: str, bid: int, progress=lambda p, m: None) -> dict:
        model = self.trainer.load_model(pid, bid)
        if model is None:
            raise ValueError("no trained model for this behavior")
        vids = self._ready_videos(pid)
        done, skipped = [], []
        for i, vid in enumerate(vids):
            status = self.predict_one(pid, vid, bid, model=model)
            (done if status == "ok" else skipped).append(vid if status == "ok" else {"video_id": vid, "reason": status})
            progress(int((i + 1) / max(1, len(vids)) * 100), f"predicted {vid}")
        return {"videos": done, "skipped": skipped}

    def trained_behaviors(self, pid: str) -> list[int]:
        return [b["id"] for b in self.store.get(pid).behaviors
                if self.trainer.model_meta(pid, b["id"])]

    def predict_video(self, pid: str, vid: str, progress=lambda p, m: None) -> dict:
        """Apply every trained behavior model to a single video (e.g. a newly loaded one). Reports both
        the behaviors predicted and any SKIPPED (with a reason) so the UI can warn instead of silently
        showing nothing."""
        proj = self.store.get(pid)
        name_of = {b["id"]: b.get("name", str(b["id"])) for b in proj.behaviors}
        bids = self.trained_behaviors(pid)
        done, skipped = [], []
        for i, bid in enumerate(bids):
            progress(int(i / max(1, len(bids)) * 100), f"predicting {name_of.get(bid, bid)}")
            status = self.predict_one(pid, vid, bid)
            if status == "ok":
                done.append(bid)
            else:
                skipped.append({"behavior_id": bid, "name": name_of.get(bid, str(bid)), "reason": status})
        progress(100, "done")
        return {"behaviors": done, "skipped": skipped}

    def get_proba(self, pid: str, vid: str, bid: int, track: int) -> np.ndarray | None:
        p = self._path(pid, vid, bid)
        if not p.exists():
            return None
        arr = np.load(p, mmap_mode="r")                           # (F, T)
        t = int(track)
        return np.asarray(arr[:, t], dtype="float32") if t < arr.shape[1] else None

    def _nose_spout_dist(self, pid: str, vid: str, track: int) -> np.ndarray | None:
        """Per-frame nose→spout distance (body lengths) for one track, read from the feature cache.
        Prefers the ROI distance (`spout_roi_dist`, 0 when the nose is inside the polygon); falls back
        to the point-spout distance (`spout_dist`). None if no spout feature is present in the cache
        (no spout configured, or the model's video wasn't recomputed with one)."""
        try:
            names = self.features.meta(pid, vid).get("feature_names") or []
        except (FileNotFoundError, ValueError):
            return None
        col = next((names.index(c) for c in ("spout_roi_dist__raw", "spout_dist__raw") if c in names), None)
        if col is None:
            return None
        Xf = self.features.load(pid, vid)
        t = int(track)
        return np.asarray(Xf[:, t, col], dtype="float32") if t < Xf.shape[1] else None

    def _fps(self, pid: str, vid: str) -> float:
        try:
            return float(self.features.meta(pid, vid).get("fps", 30.0))
        except (FileNotFoundError, ValueError):
            return float((self.store.get(pid).video(vid) or {}).get("fps", 30.0))

    def _drink_count(self, pid: str, vid: str) -> np.ndarray | None:
        """Per-frame count of mice whose nose is inside the spout ROI, across ALL tracks — the v8
        drinking filter's `drink_count`. Reads `spout_roi_inside` from the feature cache. None if the
        feature isn't present (no spout ROI configured / not recomputed)."""
        try:
            meta = self.features.meta(pid, vid)
        except (FileNotFoundError, ValueError):
            return None
        names = meta.get("feature_names") or []
        if "spout_roi_inside__raw" not in names:
            return None
        inside = np.asarray(self.features.load(pid, vid)[:, :, names.index("spout_roi_inside__raw")])  # (F,T)
        return (inside == 1.0).sum(axis=1).astype("int32")            # (F,) # mice at the spout each frame

    def candidates(self, pid: str, vid: str, bid: int, track: int, n: int = 12,
                   mode: str = "new") -> list[dict]:
        """Ranked yes/no review items for one behavior+track. Three modes:

        `new` (default) — predicted-positive regions you HAVEN'T labeled yet, most-uncertain first.
        `disagree` — labeled bouts the model confidently CONTRADICTS (the label-error finder).
        `dropped` — predicted bouts the FILTERS removed (e.g. the 2-mouse social gate), each with a
        `drop_reason`, so you can see what was filtered and override it.
        `mislabel` — like `disagree` but scored by CROSS-VALIDATED (out-of-fold) probability, so each
        labeled bout is judged by a model that never trained on it (an honest label-error finder that
        isn't fooled by the model memorizing its own training labels)."""
        if mode == "mislabel":
            return self.mislabels(pid, vid, bid, track, n)
        if mode == "reviewed":
            return self.reviewed_candidates(pid, vid, bid, track, n)
        if mode == "disagree":
            return self.disagreements(pid, vid, bid, track, n)
        proba = self.get_proba(pid, vid, bid, track)
        if proba is None:
            return []
        beh = next((b for b in self.store.get(pid).behaviors if b["id"] == bid), {})
        pp = {**DEFAULT_POSTPROC, **(beh.get("postproc") or {})}
        F = len(proba)
        labeled = np.zeros(F, dtype=bool)
        for s, e, _ in self.labels.get_runs(pid, vid, track, bid).get(bid, []):
            labeled[s:e] = True
        min_len = max(1, int(pp["min_bout"]), int(pp.get("min_cand", 0) or 0))   # candidate floor (>= min_bout)
        max_cand = int(pp.get("max_cand", 0) or 0)
        cands = []
        for s, e in bouts_from_proba(proba, pp["smooth"], pp["hi"], pp["lo"], pp["min_bout"], pp["min_gap"]):
            for us0, ue0 in _unlabeled_subruns(labeled, s, e, min_len):
                for us, ue in _split_capped(us0, ue0, max_cand):   # long sustained bouts -> <=max_cand review windows
                    mp = float(np.nanmean(proba[us:ue]))
                    cands.append({"start": us, "end": ue, "mid": (us + ue) // 2, "track": int(track),
                                  "mean_proba": mp, "uncertainty": float(1.0 - abs(2.0 * mp - 1.0)), "kind": "predicted"})
        # Factor in the nose→spout distance: a genuine spout behaviour (e.g. drinking) needs the nose
        # AT the spout, so a predicted bout whose nose stays far away is likely a false positive. We
        # tag each candidate's mean distance (body lengths) and DEMOTE far ones — proximity in (0,1],
        # so far bouts drop in rank but are never hidden. No spout configured -> pure uncertainty (as
        # before). (The distance is ALSO a model input once you retrain, so it shapes `proba` too.)
        dist = self._nose_spout_dist(pid, vid, track)
        for c in cands:
            d = float(np.nanmean(dist[c["start"]:c["end"]])) if dist is not None else float("nan")
            c["spout_dist"] = d if np.isfinite(d) else None

        # v8 "social" gate: drop a candidate drinking bout where >=2 mice have their nose in the spout
        # ROI at once for >= social_gate_s (you can't attribute the drink to one animal). Tags every
        # candidate's max concurrent count + overlap length for transparency. Needs the spout ROI + >=2
        # tracks; otherwise a no-op.
        fps = float(self._fps(pid, vid))
        drink = self._drink_count(pid, vid)
        social_fr = int(round(float(pp.get("social_gate_s", 0.5)) * fps))
        dropped = []
        if drink is not None:
            kept = []
            for c in cands:
                seg = drink[c["start"]:c["end"]]
                c["max_concurrent"] = int(seg.max()) if len(seg) else 0
                c["social_overlap"] = _max_true_run(seg >= 2)
                if social_fr > 0 and c["social_overlap"] >= social_fr:
                    c["drop_filter"] = "social"
                    c["drop_reason"] = f"{c['max_concurrent']} mice at the spout for {c['social_overlap'] / fps:.1f}s"
                    dropped.append(c)
                else:
                    kept.append(c)
            cands = kept

        if mode == "dropped":                                    # bouts the filters removed (worst overlap first)
            dropped.sort(key=lambda c: -c.get("social_overlap", 0))
            return dropped[:n]

        # Least-confidence first (active-learning uncertainty sampling): the model's most-borderline
        # predictions — mean proba nearest 0.5 — first, where a label teaches the model the most.
        # NB: a controlled AL simulation on rearing showed that ADDING feature-space DIVERSITY on top of
        # this HURT (it chased outliers away from the decision boundary and underperformed even random
        # order past ~20 bouts) — so pure uncertainty is the default. spout distance is only a tiebreak.
        cands.sort(key=lambda c: (-c["uncertainty"], c.get("spout_dist") if c.get("spout_dist") is not None else 0.0))
        return cands[:n]

    def disagreements(self, pid: str, vid: str, bid: int, track: int, n: int = 12) -> list[dict]:
        """Labeled bouts the model is *confident* you got wrong — the "annotations aren't perfect"
        workflow (PLAN.md §6). For each labeled run the model's contradicting probability is
        `1 - proba` on a positive label and `proba` on a negative label; wherever that stays
        confidently high (same smooth/hysteresis/length filter as detection bouts) we surface the
        sub-run as a yes/no: 'you called this X — the model is sure it isn't; keep it or flip it?'.
        Ranked by how strongly the model disagrees, so the most-likely mislabels come first.

        Each item carries `label_value` (what you have: 1 pos / 0 neg) and `suggest_value`
        (the flip the model proposes). Skips explicit-Unknown runs (value 2)."""
        proba = self.get_proba(pid, vid, bid, track)
        if proba is None:
            return []
        beh = next((b for b in self.store.get(pid).behaviors if b["id"] == bid), {})
        pp = {**DEFAULT_POSTPROC, **(beh.get("postproc") or {})}
        Fn = len(proba)
        cands = []
        for s, e, v in self.labels.get_runs(pid, vid, track, bid).get(bid, []):
            if int(v) not in (0, 1):                          # only pos/neg labels can be "wrong"
                continue
            s, e = int(s), min(int(e), Fn)
            if e <= s:
                continue
            contra = (1.0 - proba[s:e]) if int(v) == 1 else proba[s:e]   # model's confidence AGAINST your label
            for cs, ce in bouts_from_proba(contra, pp["smooth"], pp["hi"], pp["lo"], pp["min_bout"], pp["min_gap"]):
                a, b = s + cs, s + ce
                score = float(np.nanmean(contra[cs:ce]))       # how strongly the model disagrees (0..1)
                cands.append({"start": a, "end": b, "mid": (a + b) // 2, "track": int(track),
                              "mean_proba": float(np.nanmean(proba[a:b])),
                              "label_value": int(v), "suggest_value": int(1 - int(v)),
                              "disagreement": score, "uncertainty": score, "kind": "disagree"})
        cands.sort(key=lambda c: -c["disagreement"])
        return cands[:n]

    def _compute_oof(self, pid: str, bid: int) -> dict:
        """Cross-validated out-of-fold P(behavior) for every LABELED frame — each bout scored by a model
        that NEVER trained on it (StratifiedGroupKFold, bouts = groups). This is the honest basis for
        label-error detection: the deployed model memorizes its own training labels, so it under-reports
        disagreements; OOF doesn't. Cached per (pid, bid) keyed on the CURRENT LABEL STATE (not the model
        version — labels change without a retrain, and the cross-val must reflect them or the mislabel
        queue serves stale probabilities). Returns {(vid, track): (F,) array} with NaN outside labeled
        frames, or {} if too few bouts to cross-validate."""
        import hashlib
        from sklearn.model_selection import StratifiedGroupKFold, cross_val_predict
        from .training import make_model
        got = self.trainer.gather(pid, bid)               # gather first so the cache key reflects live labels
        if got is None:
            return {}
        X, y, groups, rows, used, skipped, bouts = got
        y = np.asarray(y); groups = np.asarray(groups)
        # signature of the exact labeled set (behavior's feature_set folded in too — it selects columns).
        beh = next((b for b in self.store.get(pid).behaviors if b["id"] == bid), {})
        sig = hashlib.sha1(repr((beh.get("feature_set"),
                                 sorted((str(r[0]), int(r[1]), int(r[2]), int(r[3])) for r in rows))).encode()).hexdigest()[:16]
        cache = getattr(self, "_oof_cache", None)
        if cache is None:
            cache = self._oof_cache = {}
        entry = cache.get((pid, bid))                     # one entry per behavior; busts when labels change
        if entry and entry[0] == sig:
            return entry[1]
        posg, negg = len(np.unique(groups[y == 1])), len(np.unique(groups[y == 0]))
        if posg < 2 or negg < 2:
            cache[(pid, bid)] = (sig, {}); return {}
        fnames = self.features.meta(pid, used[0]).get("feature_names") or []
        cols = select_feature_cols(fnames, beh.get("feature_set"))
        Xs = np.asarray(X, dtype="float32")
        if len(cols) != Xs.shape[1]:
            Xs = Xs[:, cols]
        n_splits = int(min(5, posg, negg))
        cv = StratifiedGroupKFold(n_splits=n_splits, shuffle=True, random_state=0)
        oof = cross_val_predict(make_model(), Xs, y, groups=groups, cv=cv, method="predict_proba")[:, 1]
        out: dict = {}
        for i, (vid, tk, frame, _val) in enumerate(rows):
            arr = out.get((vid, tk))
            if arr is None:
                nf = int(self.store.get(pid).video(vid)["n_frames"])
                arr = out[(vid, tk)] = np.full(nf, np.nan, dtype="float32")
            arr[int(frame)] = oof[i]
        cache[(pid, bid)] = (sig, out)
        return out

    def get_oof_proba(self, pid: str, vid: str, bid: int, track: int):
        return self._compute_oof(pid, bid).get((vid, int(track)))

    def mislabels(self, pid: str, vid: str, bid: int, track: int, n: int = 25) -> list[dict]:
        """Labeled bouts a CROSS-VALIDATED model confidently contradicts — honest candidate mislabels.
        Per bout: mean out-of-fold P(behavior); a positive bout is suspicious if that mean is low, a
        negative bout if it's high. Returns the same shape as disagreements() (kind='disagree', with
        label_value/suggest_value) so the review UI's change/keep flow handles it unchanged. Bouts the
        OOF model agrees with on balance (contra <= 0.5) are dropped — only genuine flips surface."""
        oof = self.get_oof_proba(pid, vid, bid, track)
        if oof is None:
            return []
        reviewed = self._reviewed_keys(pid, bid)
        cands = []
        for s, e, v in self.labels.get_runs(pid, vid, track, bid).get(bid, []):
            if int(v) not in (0, 1):
                continue
            s, e = int(s), min(int(e), len(oof))
            if e <= s:
                continue
            seg = oof[s:e]; seg = seg[np.isfinite(seg)]
            if len(seg) == 0:
                continue
            if f"{vid}|{int(track)}|{int(s)}|{int(e)}" in reviewed:   # already reviewed -> don't resurface
                continue
            mp = float(seg.mean())
            contra = (1.0 - mp) if int(v) == 1 else mp        # OOF model's confidence AGAINST your label
            if contra <= 0.5:                                  # agrees on balance -> not a candidate mislabel
                continue
            cands.append({"start": s, "end": e, "mid": (s + e) // 2, "track": int(track),
                          "mean_proba": mp, "label_value": int(v), "suggest_value": int(1 - int(v)),
                          "disagreement": contra, "uncertainty": contra, "kind": "disagree"})
        cands.sort(key=lambda c: -c["disagreement"])
        return cands[:n]

    # ---- reviewed-mislabel bookkeeping: bouts you've already checked shouldn't keep resurfacing in the
    # mislabel queue (a bout you 'kept' still disagrees with the model forever, so it would reappear).
    def _reviewed_path(self, pid: str, bid: int) -> Path:
        return self.store.get(pid).path / "model" / str(bid) / "reviewed_mislabels.json"

    def reviewed_list(self, pid: str, bid: int) -> list[dict]:
        import json
        p = self._reviewed_path(pid, bid)
        return json.loads(p.read_text()) if p.exists() else []

    def _reviewed_keys(self, pid: str, bid: int) -> set[str]:
        return {f"{r['vid']}|{r['track']}|{r['start']}|{r['end']}" for r in self.reviewed_list(pid, bid)}

    def mark_reviewed(self, pid: str, bid: int, vid: str, track: int, start: int, end: int,
                      label_value=None, action: str = "reviewed") -> dict:
        import json
        from datetime import datetime, timezone
        items = self.reviewed_list(pid, bid)
        key = f"{vid}|{int(track)}|{int(start)}|{int(end)}"
        if not any(f"{r['vid']}|{r['track']}|{r['start']}|{r['end']}" == key for r in items):
            items.append({"vid": vid, "track": int(track), "start": int(start), "end": int(end),
                          "label_value": label_value, "action": action,
                          "reviewed_at": datetime.now(timezone.utc).isoformat(timespec="seconds")})
            p = self._reviewed_path(pid, bid); p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(json.dumps(items, indent=1))
        return {"reviewed": len(items)}

    def unmark_reviewed(self, pid: str, bid: int, vid: str, track: int, start: int, end: int) -> dict:
        import json
        key = f"{vid}|{int(track)}|{int(start)}|{int(end)}"
        items = [r for r in self.reviewed_list(pid, bid)
                 if f"{r['vid']}|{r['track']}|{r['start']}|{r['end']}" != key]
        self._reviewed_path(pid, bid).write_text(json.dumps(items, indent=1))
        return {"reviewed": len(items)}

    def reviewed_candidates(self, pid: str, vid: str, bid: int, track: int, n: int = 200) -> list[dict]:
        """The 'reviewed' tab: mislabel bouts on this vid/track you've already checked. Same item shape
        as mislabels() (kind='reviewed') so the review UI can list them and offer to un-review."""
        by_key = {f"{r['vid']}|{r['track']}|{r['start']}|{r['end']}": r for r in self.reviewed_list(pid, bid)}
        out = []
        for s, e, v in self.labels.get_runs(pid, vid, track, bid).get(bid, []):
            r = by_key.get(f"{vid}|{int(track)}|{int(s)}|{int(e)}")
            if r is None or int(v) not in (0, 1):
                continue
            out.append({"start": int(s), "end": int(e), "mid": (int(s) + int(e)) // 2, "track": int(track),
                        "mean_proba": 0.0, "label_value": int(v), "suggest_value": int(1 - int(v)),
                        "disagreement": 0.0, "uncertainty": 0.0, "kind": "reviewed", "reviewed_at": r.get("reviewed_at")})
        return out[:n]
