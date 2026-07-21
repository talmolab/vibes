"""Per-(video, track, frame, behavior) label store (PLAN.md §3.2, §3.3, per-track upgrade).

Per-frame tri-state, now per animal track:
    frame:int32, track:int16, behavior_id:int16, value:int8 (+1 pos / 0 neg), source:str
Absent row => unlabeled. Ranges are half-open [start, end). Old parquets without a `track`
column are migrated to track 0 on load.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

_COLS = {"frame": "int32", "track": "int16", "behavior_id": "int16", "value": "int8", "source": "object"}


def _empty() -> pd.DataFrame:
    return pd.DataFrame({c: pd.Series([], dtype=t) for c, t in _COLS.items()})


def _rle(frames: np.ndarray, values: np.ndarray) -> list[list[int]]:
    """Contiguous same-value, consecutive-frame runs -> [[start, end_exclusive, value], ...]."""
    runs: list[list[int]] = []
    if len(frames) == 0:
        return runs
    order = np.argsort(frames, kind="stable")
    frames, values = frames[order], values[order]
    s = prev = int(frames[0])
    val = int(values[0])
    for f, v in zip(frames[1:], values[1:]):
        f, v = int(f), int(v)
        if f == prev + 1 and v == val:
            prev = f
        else:
            runs.append([s, prev + 1, val])
            s = prev = f
            val = v
    runs.append([s, prev + 1, val])
    return runs


def _rle_src(frames: np.ndarray, values: np.ndarray, sources: np.ndarray) -> list[list]:
    """Like _rle but also splits on source change -> [[start, end, value, source], ...]."""
    runs: list[list] = []
    if len(frames) == 0:
        return runs
    order = np.argsort(frames, kind="stable")
    frames, values, sources = frames[order], values[order], sources[order]
    s = prev = int(frames[0])
    val = int(values[0])
    src = sources[0] if sources[0] is not None and sources[0] == sources[0] else "manual"
    for f, v, sc in zip(frames[1:], values[1:], sources[1:]):
        f, v = int(f), int(v)
        sc = sc if sc is not None and sc == sc else "manual"
        if f == prev + 1 and v == val and sc == src:
            prev = f
        else:
            runs.append([s, prev + 1, val, str(src)])
            s = prev = f
            val, src = v, sc
    runs.append([s, prev + 1, val, str(src)])
    return runs


class LabelStore:
    def __init__(self, store) -> None:  # store: ProjectStore
        self.store = store
        self._cache: dict[tuple[str, str], pd.DataFrame] = {}

    def _path(self, pid: str, vid: str) -> Path:
        return self.store.get(pid).path / "labels" / f"{vid}.parquet"

    def _df(self, pid: str, vid: str) -> pd.DataFrame:
        key = (pid, vid)
        if key not in self._cache:
            p = self._path(pid, vid)
            df = pd.read_parquet(p) if p.exists() else _empty()
            if "track" not in df.columns:                 # migrate old whole-frame labels
                df["track"] = np.int16(0)
                df = df[list(_COLS)]
            if "source" not in df.columns:                # pre-provenance rows -> treat as hand-labeled
                df["source"] = "manual"
            df["source"] = df["source"].fillna("manual")  # never let a NaN source drop out of groupby stats
            self._cache[key] = df
        return self._cache[key]

    def forget(self, pid: str, vid: str) -> None:
        """Evict the cached label DataFrame for a removed video."""
        self._cache.pop((pid, vid), None)

    def _save(self, pid: str, vid: str) -> None:
        p = self._path(pid, vid)
        p.parent.mkdir(parents=True, exist_ok=True)
        self._cache[(pid, vid)].to_parquet(p, index=False)

    def get_runs(self, pid: str, vid: str, track: int, behavior_id: int | None = None) -> dict[int, list]:
        """RLE runs for one track: {behavior_id: [[start, end, value], ...]}."""
        df = self._df(pid, vid)
        df = df[df["track"] == int(track)]
        bids = [int(behavior_id)] if behavior_id is not None else sorted(int(b) for b in df["behavior_id"].unique())
        out: dict[int, list] = {}
        for b in bids:
            sub = df[df["behavior_id"] == b]
            out[b] = _rle(sub["frame"].to_numpy(), sub["value"].to_numpy())
        return out

    def get_runs_src(self, pid: str, vid: str, track: int, behavior_id: int | None = None) -> dict[int, list]:
        """RLE runs for one track WITH provenance: {behavior_id: [[start, end, value, source], ...]}.
        Feeds the frontend so its per-frame source array stays exact across edits/undo."""
        df = self._df(pid, vid)
        df = df[df["track"] == int(track)]
        bids = [int(behavior_id)] if behavior_id is not None else sorted(int(b) for b in df["behavior_id"].unique())
        out: dict[int, list] = {}
        for b in bids:
            sub = df[df["behavior_id"] == b]
            out[b] = _rle_src(sub["frame"].to_numpy(), sub["value"].to_numpy(), sub["source"].to_numpy())
        return out

    def rows_for_behavior(self, pid: str, vid: str, behavior_id: int) -> pd.DataFrame:
        """All (track, frame, value) rows for a behavior across every track — for training."""
        df = self._df(pid, vid)
        return df[df["behavior_id"] == int(behavior_id)][["track", "frame", "value"]]

    def put_spans(self, pid: str, vid: str, spans: list[dict], source: str = "manual") -> None:
        """Each span may carry its own `source` (e.g. 'candidate' for accepted suggestions);
        falls back to the call-level `source` (default 'manual')."""
        df = self._df(pid, vid)
        for sp in spans:
            b, t = int(sp["behavior_id"]), int(sp["track"])
            s, e, val = int(sp["start"]), int(sp["end"]), int(sp["value"])
            if e <= s:
                continue
            src = sp.get("source") or source
            keep = ~((df["behavior_id"] == b) & (df["track"] == t) & (df["frame"] >= s) & (df["frame"] < e))
            frames = np.arange(s, e, dtype="int32")
            add = pd.DataFrame({
                "frame": frames,
                "track": np.full(len(frames), t, dtype="int16"),
                "behavior_id": np.full(len(frames), b, dtype="int16"),
                "value": np.full(len(frames), val, dtype="int8"),
                "source": src,
            })
            df = pd.concat([df[keep], add], ignore_index=True)
        self._cache[(pid, vid)] = df
        self._save(pid, vid)

    def source_stats(self, pid: str) -> dict:
        """Provenance breakdown of the current labels: per behavior -> clip -> track -> source, how
        many positive/negative BOUTS (contiguous same-value, same-source runs) and frames. Answers
        'how many bouts did I label by hand vs accept from candidates, on which clip and track?'."""
        proj = self.store.get(pid)
        acc: dict[tuple[int, str, int, str], dict] = {}
        for v in proj.videos:
            vid = v["video_id"]
            if (pid, vid) not in self._cache and not self._path(pid, vid).exists():
                continue
            df = self._df(pid, vid)
            if len(df) == 0:
                continue
            for (b, t, src), sub in df.groupby(["behavior_id", "track", "source"], dropna=False):
                a = acc.setdefault((int(b), vid, int(t), str(src)),
                                   {"pos_bouts": 0, "neg_bouts": 0, "pos_frames": 0, "neg_frames": 0})
                for s, e, val in _rle(sub["frame"].to_numpy(), sub["value"].to_numpy()):
                    if val == 1:
                        a["pos_bouts"] += 1
                        a["pos_frames"] += e - s
                    elif val == 0:
                        a["neg_bouts"] += 1
                        a["neg_frames"] += e - s
        order = {v["video_id"]: i for i, v in enumerate(proj.videos)}
        behaviors = []
        for b in proj.behaviors:
            bid = int(b["id"])
            vids = sorted({vv for (bb, vv, _t, _s) in acc if bb == bid}, key=lambda x: order.get(x, 1 << 30))
            if not vids:
                continue
            clips = []
            for vv in vids:
                tracks = sorted({t for (bb, v2, t, _s) in acc if bb == bid and v2 == vv})
                clips.append({"video_id": vv,
                              "tracks": [{"track": t,
                                          "sources": {s: acc[(bid, vv, t, s)]
                                                      for (bb, v2, tt, s) in acc if bb == bid and v2 == vv and tt == t}}
                                         for t in tracks]})
            behaviors.append({
                "behavior_id": bid, "name": b.get("name"), "color": b.get("color"), "clips": clips,
            })
        return {"videos": [v["video_id"] for v in proj.videos], "behaviors": behaviors}

    def delete_range(self, pid: str, vid: str, behavior_id: int, track: int, start: int, end: int) -> None:
        df = self._df(pid, vid)
        b, t, s, e = int(behavior_id), int(track), int(start), int(end)
        keep = ~((df["behavior_id"] == b) & (df["track"] == t) & (df["frame"] >= s) & (df["frame"] < e))
        self._cache[(pid, vid)] = df[keep].reset_index(drop=True)
        self._save(pid, vid)

    def delete_behavior(self, pid: str, behavior_id: int) -> None:
        """Cascade-delete a behavior's labels across all videos/tracks of the project."""
        proj = self.store.get(pid)
        b = int(behavior_id)
        for v in proj.videos:
            vid = v["video_id"]
            if (pid, vid) in self._cache or self._path(pid, vid).exists():
                df = self._df(pid, vid)
                self._cache[(pid, vid)] = df[df["behavior_id"] != b].reset_index(drop=True)
                self._save(pid, vid)

    def copy_labels(self, pid: str, src_bid: int, dst_bid: int, initial_only: bool = True) -> dict:
        """Copy labeled frames from one behavior to another across all videos/tracks, preserving frame,
        track, value AND source. OVERWRITES the destination's existing labels.

        initial_only=True (default): copy ONLY the INITIAL/seed labels — those NOT produced by the
        candidate-review loop (source != 'candidate', i.e. hand-painted 'manual' + 'imported'). This
        gives a clone the same starting point but lets its OWN candidate process + further labeling
        proceed independently on the new model — for comparing the whole active-learning trajectory from
        a common seed. initial_only=False copies everything (fully-identical training set)."""
        proj = self.store.get(pid)
        s, d = int(src_bid), int(dst_bid)
        copied = 0
        for v in proj.videos:
            vid = v["video_id"]
            if (pid, vid) not in self._cache and not self._path(pid, vid).exists():
                continue
            df = self._df(pid, vid)
            src_rows = df[df["behavior_id"] == s]
            if initial_only:
                src_rows = src_rows[src_rows["source"] != "candidate"]   # keep only the initial/seed labels
            kept = df[df["behavior_id"] != d]                    # drop dst's current labels (replace, don't merge)
            if len(src_rows):
                dup = src_rows.copy(); dup["behavior_id"] = np.int16(d)
                out = pd.concat([kept, dup], ignore_index=True)
                copied += len(src_rows)
            else:
                out = kept.reset_index(drop=True)
            out["behavior_id"] = out["behavior_id"].astype("int16")
            self._cache[(pid, vid)] = out
            self._save(pid, vid)
        return {"frames_copied": int(copied)}
