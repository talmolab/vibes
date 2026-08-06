"""Import previously-annotated behavior annotations as training labels (PLAN.md §12 v1).

v0 supports a generic interval CSV (behavior, start, end) in frames or seconds — this also
covers BORIS-style exports via column mapping. Imported intervals become positive labels;
with coverage='complete' we sample negative windows from the un-annotated (animal-present)
frames so a classifier can be trained from the import alone. BORIS/JAABA/SimBA parsers slot
in behind the same import_intervals() core later.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd


def _mask_to_intervals(mask: np.ndarray) -> list[tuple[int, int]]:
    d = np.diff(mask.astype(np.int8))
    starts = list(np.where(d == 1)[0] + 1)
    ends = list(np.where(d == -1)[0] + 1)
    if mask[0]:
        starts = [0] + starts
    if mask[-1]:
        ends = ends + [len(mask)]
    return [(int(s), int(e)) for s, e in zip(starts, ends)]


class Importer:
    def __init__(self, store, labels, video_manager) -> None:
        self.store = store
        self.labels = labels
        self.vm = video_manager

    def import_event_annotator(self, pid: str, vid: str, json_path: str,
                               track: int | None = None) -> dict:
        """Import an event-annotator export (segments + eventTypes, per trackIdx).

        The timeline is a mutually-exclusive ethogram, so for each behavior:
        positives = its frames, negatives = frames of every OTHER non-eraser behavior
        (no negative sampling needed). Half-open [startFrame, endFrame). Clipped to n_frames.
        """
        data = json.loads(Path(json_path).read_text())
        proj = self.store.get(pid)
        n_frames = int(proj.video(vid)["n_frames"])
        et = {e["id"]: e for e in data.get("eventTypes", [])}

        # group segments per track -> {track: {eventTypeId: [(s, e)]}}
        by_track: dict[int, dict[str, list[tuple[int, int]]]] = {}
        for seg in data.get("segments", []):
            eid = seg["eventTypeId"]
            if et.get(eid, {}).get("isEraser"):
                continue
            tk = int(seg.get("trackIdx", 0))
            if track is not None and tk != track:
                continue
            s = max(0, min(n_frames, int(seg["startFrame"])))
            e = max(0, min(n_frames, int(seg["endFrame"])))
            if e > s:
                by_track.setdefault(tk, {}).setdefault(eid, []).append((s, e))
        if not by_track:
            raise ValueError("no non-eraser segments found in range")

        summary: dict = {"behaviors": {}, "tracks": sorted(by_track)}
        for tk, by_id in by_track.items():
            occ = np.full(n_frames, -1, dtype=np.int32)     # per-track: frame -> behavior id
            bid_of: dict[str, int] = {}
            for eid, intervals in by_id.items():
                e = et.get(eid, {})
                bid = self._behavior_by_name(proj, e.get("name", eid), e.get("color"), e.get("hotkey"))
                bid_of[eid] = bid
                for s, en in intervals:
                    occ[s:en] = bid
            for eid, bid in bid_of.items():
                pos = _mask_to_intervals(occ == bid)
                self.labels.put_spans(pid, vid, [{"behavior_id": bid, "track": tk, "start": s, "end": e, "value": 1}
                                                 for s, e in pos], source="imported")
                neg = _mask_to_intervals((occ != bid) & (occ != -1))
                self.labels.put_spans(pid, vid, [{"behavior_id": bid, "track": tk, "start": s, "end": e, "value": 0}
                                                 for s, e in neg], source="imported")
                ent = summary["behaviors"].setdefault(et[eid]["name"],
                                                       {"behavior_id": bid, "pos_frames": 0, "neg_frames": 0, "tracks": []})
                ent["pos_frames"] += int((occ == bid).sum())
                ent["neg_frames"] += int(((occ != bid) & (occ != -1)).sum())
                if tk not in ent["tracks"]:
                    ent["tracks"].append(tk)
        return summary

    def _behavior_by_name(self, proj, name: str, color=None, key=None) -> int:
        for b in proj.behaviors:
            if b["name"] == name:
                return b["id"]
        if key and any(b.get("key") == key for b in proj.behaviors):
            key = None
        return proj.add_behavior(name, color, key)["id"]

    def import_csv(self, pid: str, vid: str, csv_path: str, behavior_col="behavior",
                   start_col="start", end_col="end", units="frames",
                   coverage="complete", neg_ratio=1.0) -> dict:
        proj = self.store.get(pid)
        entry = proj.video(vid)
        fps, n_frames = float(entry["fps"]), int(entry["n_frames"])
        df = pd.read_csv(csv_path)
        for c in (behavior_col, start_col, end_col):
            if c not in df.columns:
                raise ValueError(f"column '{c}' not in CSV columns {list(df.columns)}")

        by_name: dict[str, list[tuple[int, int]]] = {}
        for _, r in df.iterrows():
            s, e = float(r[start_col]), float(r[end_col])
            if units == "seconds":
                s, e = s * fps, e * fps
            s, e = int(round(s)), int(round(e))
            s, e = max(0, min(n_frames, s)), max(0, min(n_frames, e))
            if e > s:
                by_name.setdefault(str(r[behavior_col]), []).append((s, e))

        return self.import_intervals(pid, vid, by_name, coverage, neg_ratio)

    def import_intervals(self, pid: str, vid: str, by_name: dict[str, list[tuple[int, int]]],
                         coverage="complete", neg_ratio=1.0) -> dict:
        proj = self.store.get(pid)
        n_frames = int(proj.video(vid)["n_frames"])
        summary: dict = {"behaviors": {}}
        present = None
        for name, intervals in by_name.items():
            bid = self._behavior_id(proj, name)
            self.labels.put_spans(pid, vid, [{"behavior_id": bid, "track": 0, "start": s, "end": e, "value": 1}
                                             for s, e in intervals], source="imported")
            pos = sum(e - s for s, e in intervals)
            neg = 0
            if coverage == "complete":
                if present is None:
                    present = self._present_mask(pid, vid, n_frames)
                negs = self._sample_negatives(intervals, n_frames, present, neg_ratio)
                self.labels.put_spans(pid, vid, [{"behavior_id": bid, "track": 0, "start": s, "end": e, "value": 0}
                                                 for s, e in negs], source="imported")
                neg = sum(e - s for s, e in negs)
            summary["behaviors"][name] = {"behavior_id": bid, "n_intervals": len(intervals),
                                          "pos_frames": pos, "neg_frames": neg}
        return summary

    def _behavior_id(self, proj, name: str) -> int:
        for b in proj.behaviors:
            if b["name"] == name:
                return b["id"]
        return proj.add_behavior(name)["id"]

    def _present_mask(self, pid: str, vid: str, n_frames: int) -> np.ndarray:
        pose = self.vm._get(pid, vid).poses()          # (F, T, N, 3)
        x = pose[..., 0].reshape(pose.shape[0], -1)
        return ~np.all(np.isnan(x), axis=1)

    def _sample_negatives(self, pos_intervals, n_frames, present, ratio):
        pos_mask = np.zeros(n_frames, dtype=bool)
        for s, e in pos_intervals:
            pos_mask[s:e] = True
        avail = present & ~pos_mask
        lengths = [e - s for s, e in pos_intervals]
        win = max(5, int(np.median(lengths))) if lengths else 15
        if len(avail) < win:
            return []
        csum = np.concatenate([[0], np.cumsum(avail.astype(int))])
        fits = np.where((csum[win:] - csum[:-win]) == win)[0]   # window-fully-available starts
        np.random.default_rng(0).shuffle(fits)
        target = int(sum(lengths) * ratio)
        used = np.zeros(n_frames, dtype=bool)
        negs, total = [], 0
        for s in fits:
            e = s + win
            if used[s:e].any():
                continue
            negs.append((int(s), int(e)))
            used[s:e] = True
            total += win
            if total >= target:
                break
        return negs
