"""
sources.py — event sources for the refinement labeller.

A "source" supplies: an ordered list of events, poster/clip renderers, a done-set +
per-event behavior for resume, and label / unlabel / relabel writers. Two live here:

  BaseSource  — shared serving/served/done/behavior bookkeeping (subclass + fill hooks).
  DemoSource  — synthetic events + procedurally-rendered clips (numpy -> ffmpeg). Needs
                no /snlkt data, no cv2, no pipeline import; lets the whole app run anywhere.

The real one, ApproachSource (features.npz or the aggression corpus + 12e labels.csv
schema + skeleton clips), lives in source_approach.py.
"""
import os
import csv
import threading

import numpy as np

from ffmpeg_util import encode_mp4, encode_jpg

RANK_NAMES = {1: "Dom", 2: "Mid", 3: "Sub"}


class BaseSource:
    def __init__(self, cfg):
        self.cfg = cfg
        self.labels = list(cfg["labels"])
        self.label_display = dict(cfg.get("label_display", {}))
        self.file_code = cfg.get("file_code", "UNTITLED")
        self.file_sub = cfg.get("file_sub", "")
        self.refiner = cfg.get("refiner", "I. TANG")
        self.clip = cfg.get("clip", {})
        self.cache_dir = os.path.abspath(cfg.get("cache_dir", os.path.join(os.path.dirname(__file__), "cache")))
        os.makedirs(self.cache_dir, exist_ok=True)
        self.events = []             # list of internal dicts, each with an int "id" == index
        self.served = set()          # ids handed to the client, not yet labeled (in-memory)
        self.lock = threading.Lock()
        self._done = set()           # done_keys
        self._behavior = {}          # done_key -> behavior (for the bin flyouts)
        self._key_to_id = {}         # done_key -> event id (lazy)

    # ---- hooks a subclass must provide ----
    def done_key(self, ev):
        raise NotImplementedError
    def load_done(self):             # -> set; also fills self._behavior
        raise NotImplementedError
    def write_label(self, ev, behavior):
        raise NotImplementedError
    def remove_label(self, ev):      # drop this event's row(s) from the labels file
        raise NotImplementedError
    def counts(self):
        raise NotImplementedError
    def poster_path(self, eid):
        raise NotImplementedError
    def clip_path(self, eid):
        raise NotImplementedError

    # ---- shared ----
    def public(self, ev):
        dyad = f'{RANK_NAMES.get(ev.get("ra"), "?")}→{RANK_NAMES.get(ev.get("re"), "?")}'
        d = {"id": ev["id"], "cohort": ev.get("cohort", ""), "stem": ev.get("stem", ""),
             "cs": ev.get("cs", 0), "dyad": dyad, "cond": ev.get("cond", ""),
             "poster": f'/poster/{ev["id"]}', "clip": f'/clip/{ev["id"]}'}
        if ev.get("subtype"):
            d["subtype"] = ev["subtype"]
        return d

    def _ensure_index(self):
        if not self._key_to_id:
            for ev in self.events:
                self._key_to_id[self.done_key(ev)] = ev["id"]

    def next_events(self, n):
        out = []
        with self.lock:
            for ev in self.events:
                if len(out) >= n:
                    break
                if self.done_key(ev) in self._done or ev["id"] in self.served:
                    continue
                self.served.add(ev["id"])
                out.append(self.public(ev))
        return out

    def label(self, eid, behavior):
        ev = self.events[int(eid)]
        self.write_label(ev, behavior)
        with self.lock:
            k = self.done_key(ev)
            self._done.add(k); self._behavior[k] = behavior; self.served.discard(int(eid))

    def unlabel(self, eid):
        ev = self.events[int(eid)]
        self.remove_label(ev)
        with self.lock:
            k = self.done_key(ev)
            self._done.discard(k); self._behavior.pop(k, None); self.served.add(int(eid))
        return self.public(ev)

    def relabel(self, eid, behavior):
        ev = self.events[int(eid)]
        self.remove_label(ev); self.write_label(ev, behavior)
        with self.lock:
            k = self.done_key(ev)
            self._done.add(k); self._behavior[k] = behavior
        return self.public(ev)

    def binned(self, behavior):
        self._ensure_index()
        out = []
        for k, beh in list(self._behavior.items()):
            if beh == behavior:
                eid = self._key_to_id.get(k)
                if eid is not None:
                    out.append(self.public(self.events[eid]))
        return out

    def total(self):
        return len(self.events)

    def done_count(self):
        return sum(1 for ev in self.events if self.done_key(ev) in self._done)


# ============================================================================
# Demo source — synthetic, self-contained
# ============================================================================
_TEAL = (60, 44, 12)
_RANK_BGR = {1: (60, 70, 224), 2: (230, 162, 90), 3: (138, 201, 87)}   # Dom / Mid / Sub
_DEMO_HEADER = ["id", "cohort", "stem", "cs", "behavior"]


class DemoSource(BaseSource):
    def __init__(self, cfg):
        super().__init__(cfg)
        n = int(cfg.get("demo", {}).get("n_events", 48))
        cohorts = ["12192025_dep", "12192025_pre", "11032025", "20260222_dep"]
        conds = ["despotism", "pre", "baseline", "despotism"]
        rng = np.random.RandomState(7)
        for i in range(n):
            ci = rng.randint(len(cohorts))
            ra = 1 + rng.randint(3)
            re = 1 + rng.randint(3)
            while re == ra:
                re = 1 + rng.randint(3)
            cam = 9 + rng.randint(7)
            self.events.append(dict(
                id=i, cohort=cohorts[ci], stem=f"cam.{cam:02d}.{rng.randint(100,999):05d}",
                cs=int(rng.randint(2000, 90000)), appr=0, appe=1, ra=int(ra), re=int(re),
                cond=conds[ci], seed=int(rng.randint(1, 1_000_000))))
        self.labels_csv = os.path.join(self.cache_dir, "demo_labels.csv")
        self._done = self.load_done()

    def done_key(self, ev):
        return int(ev["id"])

    def load_done(self):
        done = set()
        if os.path.exists(self.labels_csv):
            with open(self.labels_csv) as f:
                for row in csv.DictReader(f):
                    done.add(int(row["id"])); self._behavior[int(row["id"])] = row["behavior"]
        return done

    def write_label(self, ev, behavior):
        new = not os.path.exists(self.labels_csv)
        with open(self.labels_csv, "a", newline="") as f:
            w = csv.writer(f)
            if new:
                w.writerow(_DEMO_HEADER)
            w.writerow([ev["id"], ev["cohort"], ev["stem"], ev["cs"], behavior])

    def remove_label(self, ev):
        if not os.path.exists(self.labels_csv):
            return
        with open(self.labels_csv) as f:
            rows = [r for r in csv.reader(f)][1:]
        rows = [r for r in rows if r and int(r[0]) != int(ev["id"])]
        with open(self.labels_csv, "w", newline="") as f:
            w = csv.writer(f); w.writerow(_DEMO_HEADER); w.writerows(rows)

    def counts(self):
        c = {b: 0 for b in self.labels}
        if os.path.exists(self.labels_csv):
            with open(self.labels_csv) as f:
                for row in csv.DictReader(f):
                    c[row["behavior"]] = c.get(row["behavior"], 0) + 1
        return c

    def _frames(self, ev, cell, nframes, only_first=False):
        rng = np.random.RandomState(ev["seed"])
        p_appe = np.array([cell * 0.62, cell * 0.5])
        p_by = np.array([cell * 0.30, cell * 0.74])
        start = np.array([cell * 0.18, cell * (0.25 + 0.02 * rng.rand())])
        blobs = [(1, _RANK_BGR[ev["ra"]]), (2, _RANK_BGR[ev["re"]]), (3, (90, 110, 78))]
        idxs = [int(nframes * 0.45)] if only_first else range(nframes)
        out = []
        for k in idxs:
            t = 0.5 if only_first else (k / max(1, nframes - 1))
            fr = np.empty((cell, cell, 3), np.uint8)
            fr[:] = _TEAL
            for _ in range(24):
                x = int((rng.rand() * cell + t * 40) % cell)
                y = int(rng.rand() * cell)
                fr[max(0, y):y + 2, max(0, x):x + 2] = (110, 150, 150)
            ease = t * t * (3 - 2 * t)
            p_appr = start + (p_appe - start) * ease
            for pos, (_, col) in zip([p_by, p_appe, p_appr], blobs):
                self._blob(fr, int(pos[0]), int(pos[1]), 9, col)
            if np.linalg.norm(p_appr - p_appe) < 34:
                self._blob(fr, int((p_appr[0] + p_appe[0]) / 2), int((p_appr[1] + p_appe[1]) / 2), 5, (60, 60, 235))
            fr[8:20, cell - 20:cell - 8] = (60, 60, 235)
            out.append(fr)
        return out

    @staticmethod
    def _blob(fr, cx, cy, r, color):
        h, w = fr.shape[:2]
        fr[max(0, cy - r):min(h, cy + r), max(0, cx - r):min(w, cx + r)] = color

    def poster_path(self, eid):
        ev = self.events[int(eid)]
        cell = int(self.clip.get("cell", 260))
        d = os.path.join(self.cache_dir, "posters"); os.makedirs(d, exist_ok=True)
        out = os.path.join(d, f"demo_{eid}.jpg")
        if not os.path.exists(out):
            encode_jpg(self._frames(ev, cell, 60, only_first=True)[0], out)
        return out

    def clip_path(self, eid):
        ev = self.events[int(eid)]
        cell = int(self.clip.get("cell", 260))
        d = os.path.join(self.cache_dir, "clips"); os.makedirs(d, exist_ok=True)
        out = os.path.join(d, f"demo_{eid}.mp4")
        if not os.path.exists(out):
            encode_mp4(self._frames(ev, cell, 60), 25, out)
        return out
