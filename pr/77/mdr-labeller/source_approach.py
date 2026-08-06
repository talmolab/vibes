"""
source_approach.py — the real 12e event source.

Two manifests (config `approach.manifest`):
  "features"   — approach_behavior/features.npz, ordered by 12d scaffold_members.npy
                 (what 12e_label_gui.py reads). Events carry order = [appr, appe, bystander].
  "aggression" — approach_behavior/labels/aggression_candidates.csv (the accrued aggression
                 corpus). It stores cohort/stem/contact_start/pair/rank_appr/rank_appe but
                 NOT the appr/appe track indices, so those are resolved lazily via
                 ab.assign_event(tm, cs, pair) the first time an event is rendered/labeled.

Either way it writes the IDENTICAL 12e labels.csv schema
(cohort, stem, contact_start, appr, appe, rank_appr, rank_appe, condition, behavior;
dedup/resume on (cohort, stem, contact_start)) so this labeller and 12e share state.
"""
import os
import sys
import csv

import numpy as np
import pandas as pd

from sources import BaseSource
import render

_HCM = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _HCM not in sys.path:
    sys.path.insert(0, _HCM)
from utils import approach_behavior as ab  # noqa: E402

LABELS_HEADER = ["cohort", "stem", "contact_start", "appr", "appe",
                 "rank_appr", "rank_appe", "condition", "behavior"]
_COND = {"pre": "pre", "dep": "despotism", "post": "post", "together": "together"}


def _cond_from_cohort(coh):
    suf = str(coh).rsplit("_", 1)[-1]
    return _COND.get(suf, "")


class ApproachSource(BaseSource):
    def __init__(self, cfg):
        super().__init__(cfg)
        self.a = cfg.get("approach", {})
        self.corpus_dir = None
        self.labels_csv = None

        manifest = self.a.get("manifest", "features")
        if manifest == "aggression_corpus":
            self._load_corpus()
        elif manifest == "aggression":
            self._load_aggression()
        else:
            self._load_features()

        if not self.labels_csv:
            self.labels_csv = self.a.get("labels_csv") or f"{ab.LABELS_DIR}/labels.csv"
        os.makedirs(os.path.dirname(self.labels_csv), exist_ok=True)
        if not os.path.exists(self.labels_csv):
            with open(self.labels_csv, "w", newline="") as f:
                csv.writer(f).writerow(LABELS_HEADER)
        self._done = self.load_done()

    # ---- manifests ----
    def _load_features(self):
        feat_path = self.a.get("features_npz") or f"{ab.FEATURES_DIR}/features.npz"
        if not os.path.exists(feat_path):
            raise FileNotFoundError(
                f"features not found: {feat_path}\n"
                "Run 12b_extract_features.py, set approach.features_npz, or use "
                'approach.manifest="aggression".')
        feat = np.load(feat_path, allow_pickle=True)
        cohorts = feat["cohorts"].astype(str); stems = feat["stems"].astype(str)
        css = feat["contact_starts"].astype(np.int64); order = feat["order"]
        ra = feat["rank_appr"]; re = feat["rank_appe"]; conds = feat["conditions"].astype(str)
        idx = list(range(len(cohorts)))
        sm_path = self.a.get("scaffold_npy") or f"{ab.CLUST_DIR}/scaffold_members.npy"
        if os.path.exists(sm_path):
            sm = np.load(sm_path, allow_pickle=True).item()
            seen, q = set(), []
            for _clu, members in sm.items():
                for gi in members:
                    gi = int(gi)
                    if gi not in seen:
                        seen.add(gi); q.append(gi)
            q += [i for i in idx if i not in seen]
            idx = q
        if self.a.get("only_aggression_candidates"):
            keep = set()
            if os.path.exists(ab.AGGR_CANDIDATES_CSV):
                with open(ab.AGGR_CANDIDATES_CSV) as f:
                    for r in csv.DictReader(f):
                        keep.add((r["cohort"], r["stem"], int(r["contact_start"])))
            idx = [i for i in idx if (cohorts[i], stems[i], int(css[i])) in keep]
        for eid, i in enumerate(idx):
            self.events.append(dict(
                id=eid, cohort=str(cohorts[i]), stem=str(stems[i]), cs=int(css[i]),
                appr=int(order[i][0]), appe=int(order[i][1]),
                ra=int(ra[i]), re=int(re[i]), cond=str(conds[i]), pair=None))

    def _load_corpus(self):
        """The 12j aggression corpus: index.csv already carries appr/appe/ranks/condition/
        subtype/clip_id, and clips/ are pre-rendered. Labels live with the corpus by default."""
        cdir = self.a.get("corpus_dir") or f"{ab.BASE}/aggression"
        idx = os.path.join(cdir, "index.csv")
        if not os.path.exists(idx):
            raise FileNotFoundError(
                f"corpus index not found: {idx}\n"
                "Run 12j_build_aggression_corpus.py, or set approach.corpus_dir.")
        self.corpus_dir = cdir
        self.labels_csv = self.a.get("labels_csv") or os.path.join(cdir, "labels.csv")
        df = pd.read_csv(idx, dtype={"cohort": str, "stem": str, "pair": str,
                                     "clip_id": str, "subtype": str})
        for eid, r in enumerate(df.itertuples()):
            self.events.append(dict(
                id=eid, cohort=r.cohort, stem=r.stem, cs=int(r.contact_start),
                appr=int(r.appr), appe=int(r.appe), pair=r.pair,
                ra=int(r.rank_appr), re=int(r.rank_appe), cond=str(r.condition),
                subtype=("" if pd.isna(r.subtype) else str(r.subtype)),
                clip_id=str(r.clip_id)))

    def _load_aggression(self):
        path = self.a.get("manifest_csv") or ab.AGGR_CANDIDATES_CSV
        if not os.path.exists(path):
            raise FileNotFoundError(
                f"aggression corpus not found: {path}\n"
                "Run 12d ... --export-aggression to accrue it, or set approach.manifest_csv.")
        with open(path) as f:
            rows = list(csv.DictReader(f))
        for eid, r in enumerate(rows):
            self.events.append(dict(
                id=eid, cohort=r["cohort"], stem=r["stem"], cs=int(r["contact_start"]),
                appr=None, appe=None, pair=r["pair"],
                ra=int(r["rank_appr"]), re=int(r["rank_appe"]),
                cond=_cond_from_cohort(r["cohort"])))

    # resolve appr/appe track indices (only needed for the aggression manifest)
    def _order(self, ev):
        if ev.get("appr") is not None:
            return ev["appr"], ev["appe"]
        appr = appe = None
        try:
            tm = np.load(f'{ab.TM_BASE}/{ev["cohort"]}/{ev["stem"]}_tracks_matrix.npz')["tracks_matrix"]
            appr, appe, _by = ab.assign_event(tm, ev["cs"], ev["pair"])
        except Exception:
            slots = ab.PAIR_SLOTS.get(ev.get("pair"), (0, 1))
            appr, appe = slots
        ev["appr"], ev["appe"] = int(appr), int(appe)
        return ev["appr"], ev["appe"]

    # ---- labels.csv (12e schema) ----
    def done_key(self, ev):
        return (ev["cohort"], ev["stem"], int(ev["cs"]))

    def load_done(self):
        done = set()
        if os.path.exists(self.labels_csv):
            with open(self.labels_csv) as f:
                for row in csv.DictReader(f):
                    k = (row["cohort"], row["stem"], int(row["contact_start"]))
                    done.add(k); self._behavior[k] = row["behavior"]
        return done

    def write_label(self, ev, behavior):
        appr, appe = self._order(ev)
        with open(self.labels_csv, "a", newline="") as f:
            csv.writer(f).writerow([ev["cohort"], ev["stem"], ev["cs"], appr, appe,
                                    ev["ra"], ev["re"], ev["cond"], behavior])

    def remove_label(self, ev):
        if not os.path.exists(self.labels_csv):
            return
        key = (ev["cohort"], ev["stem"], int(ev["cs"]))
        with open(self.labels_csv) as f:
            kept = [row for row in csv.DictReader(f)
                    if (row["cohort"], row["stem"], int(row["contact_start"])) != key]
        with open(self.labels_csv, "w", newline="") as f:
            w = csv.writer(f); w.writerow(LABELS_HEADER)
            for row in kept:
                w.writerow([row[c] for c in LABELS_HEADER])

    def counts(self):
        c = {b: 0 for b in self.labels}
        if os.path.exists(self.labels_csv):
            with open(self.labels_csv) as f:
                for row in csv.DictReader(f):
                    c[row["behavior"]] = c.get(row["behavior"], 0) + 1
        return c

    def poster_path(self, eid):
        ev = self.events[int(eid)]
        pre = self._prerendered(ev, "posters", ".jpg")
        if pre:
            return pre
        self._order(ev)
        return render.ensure_poster(ev, self.clip, self.cache_dir)

    def clip_path(self, eid):
        ev = self.events[int(eid)]
        pre = self._prerendered(ev, "", ".mp4")
        if pre:
            return pre
        self._order(ev)
        return render.ensure_clip(ev, self.clip, self.cache_dir)

    def _prerendered(self, ev, sub, ext):
        cid = ev.get("clip_id")
        if not (cid and self.corpus_dir):
            return None
        p = os.path.join(self.corpus_dir, "clips", sub, cid + ext) if sub \
            else os.path.join(self.corpus_dir, "clips", cid + ext)
        return p if os.path.exists(p) else None
