#!/usr/bin/env python
"""Does the ORDER bouts reach candidate review change how fast the model learns? Paired, with CIs.

Same design as tools/acquisition_sim.py — acquire whole bouts one round at a time from a pool, retrain,
score average precision on a held-out clip against its dense blind pass — with three changes that turn a
suggestive result into a decidable one:

  * per-seed curves are KEPT, not averaged away, so differences get confidence intervals
  * strategies are compared PAIRED: every strategy starts each seed from the identical seed set, so the
    per-seed difference cancels the (large) variance from which bouts you happened to start with. Paired
    is worth roughly an order of magnitude in seeds here.
  * seeds/rounds/batch are CLI arguments, so you can buy precision with compute

Why this has to be a simulation rather than a live GUI test: comparing orders needs every strategy to
label the SAME bouts from the SAME start, and a human can only ever label a given bout once. Replaying
already-labelled bouts in different orders is the only controlled version of the experiment. What the
simulation therefore CANNOT see: that uncertain bouts may take longer to judge and be labelled more
noisily than confident ones, so 'learning per bout' is not 'learning per minute of your time'.

    scripts/acquisition_test.py --pid single-cage-test --seeds 10 --out /tmp/acq.json
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from pathlib import Path

import numpy as np
from sklearn.metrics import average_precision_score

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
from laras_labeler.featurestore import FeatureStore, select_feature_cols  # noqa: E402
from laras_labeler.labels import LabelStore  # noqa: E402
from laras_labeler.project import ProjectStore  # noqa: E402
from laras_labeler.training import Trainer, make_model  # noqa: E402
from laras_labeler.video import VideoManager  # noqa: E402

# The four orders the GUI actually offers, so the test measures what a user can select.
STRATS = ("uncertain", "confident", "random", "mixed")


def pick(strat, rest, mp, batch, rng):
    """Which bouts this strategy sends to review next. `mp` is mean predicted probability per bout."""
    if strat == "random":
        return list(rng.choice(rest, min(batch, len(rest)), replace=False))
    if strat == "uncertain":
        return sorted(rest, key=lambda g: abs(mp[g] - 0.5))[:batch]
    if strat == "confident":
        return sorted(rest, key=lambda g: -mp[g])[:batch]
    half = sorted(rest, key=lambda g: abs(mp[g] - 0.5))[:batch // 2]      # mixed = half uncertain...
    pool2 = [g for g in rest if g not in half]                            # ...half random
    return half + list(rng.choice(pool2, min(batch - len(half), len(pool2)), replace=False))


def ci95(xs):
    """Mean and half-width of a t-ish 95% interval. Returns (mean, half) — half is nan below n=2."""
    if len(xs) < 2:
        return (float(xs[0]) if xs else float("nan")), float("nan")
    return statistics.fmean(xs), 1.96 * statistics.stdev(xs) / (len(xs) ** 0.5)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--projects-root", default=str(Path.home() / "laras-projects"))
    ap.add_argument("--pid", default="single-cage-test")
    ap.add_argument("--dense-dir", default=None,
                    help="dense_pass dir (default <project>/dense_pass); its clip is the held-out test")
    ap.add_argument("--meta", default=str(Path.home() / "laras-projects/tools/etho_meta.json"),
                    help="json with video_id/track/fps naming the held-out clip")
    ap.add_argument("--seeds", type=int, default=10)
    ap.add_argument("--seed-bouts", type=int, default=6)
    ap.add_argument("--batch", type=int, default=6)
    ap.add_argument("--rounds", type=int, default=8)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    root = Path(a.projects_root)
    store = ProjectStore(root)
    vm = VideoManager(store, 4, 85)
    labels, features = LabelStore(store), FeatureStore(store, vm)
    trainer = Trainer(store, labels, features)
    proj = store.get(a.pid)
    if proj is None:
        print(f"no such project: {a.pid}", file=sys.stderr)
        return 1

    meta = json.loads(Path(a.meta).read_text())
    test_vid, test_tk = meta["video_id"], meta["track"]
    dense_dir = Path(a.dense_dir) if a.dense_dir else root / a.pid / "dense_pass"

    dense: dict[str, list[tuple[int, int]]] = {}
    for f in sorted(dense_dir.glob("*.json")):
        d = json.loads(f.read_text())
        for b in d.get("bouts", []):
            dense.setdefault(b["behavior"], []).append((b["start"], b["end"]))
    if not dense:
        print(f"no dense pass found in {dense_dir}", file=sys.stderr)
        return 1

    out: dict = {"pid": a.pid, "test_video": test_vid, "test_track": test_tk,
                 "seeds": a.seeds, "batch": a.batch, "rounds": a.rounds,
                 "seed_bouts": a.seed_bouts, "behaviors": {}}

    for beh in proj.behaviors:
        bid, name = beh["id"], beh["name"]
        gt_key = next((k for k in dense if k.lower().replace("-", " ") == name.lower().replace("-", " ")), None)
        if gt_key is None:
            print(f"!! {name}: no dense ground truth, skipped")
            continue
        t0 = time.perf_counter()
        X, y, groups, rows, used, _skipped, _bouts = trainer.gather(a.pid, bid)
        cols = select_feature_cols(features.meta(a.pid, used[0]).get("feature_names") or [],
                                  beh.get("feature_set"))
        if len(cols) != X.shape[1]:
            X = X[:, cols]
        row_vid = np.array([r[0] for r in rows])
        gids = np.unique(groups[row_vid != test_vid])          # never train on the test clip
        gpos = {g: int(y[groups == g][0]) for g in gids}

        Xt = np.asarray(features.load(a.pid, test_vid)[:, test_tk, :], dtype="float32")
        if len(cols) != Xt.shape[1]:
            Xt = Xt[:, cols]

        # THREE ground truths for the SAME predictions. AP is not comparable across them, because
        # chance-level AP equals the positive prevalence — and these three populations differ by ~7x
        # in prevalence. Any AP quoted without naming its population is meaningless.
        #
        #   dense     every frame of the test clip vs the blind pass. Prevalence ~0.05-0.10, so chance
        #             AP ~0.08. The honest target: it contains bouts the model never proposed.
        #   all_frames  the project's own labels over every frame, unlabelled treated as negative.
        #             Prevalence ~0.05-0.10 as well. A reasonable target, but NOT the one any existing
        #             number in this project uses — do not compare it to the deck.
        #   reviewed  the project's labels on REVIEWED frames only: labelled positives vs labelled
        #             negatives. THIS is the population the deck's AUROC and the sample-efficiency
        #             curves live on — verified from model meta.json, where n_pos/(n_pos+n_neg) is
        #             0.60 / 0.40 / 0.56 for supported rearing / jump down / climb up. Prevalence that
        #             high means chance AP is ~0.5, so an AP of 0.87 there is only ~1.5x chance while
        #             an AP of 0.48 against `dense` is ~5x chance. It is the comparable target and
        #             simultaneously the least impressive-per-point one.
        scorings: dict[str, tuple[np.ndarray, np.ndarray]] = {}
        gt_dense = np.zeros(len(Xt), dtype=int)
        for s, e in dense[gt_key]:
            gt_dense[s:e] = 1
        scorings["dense"] = (gt_dense, np.ones(len(Xt), dtype=bool))

        lab = np.zeros(len(Xt), dtype=int)
        reviewed = np.zeros(len(Xt), dtype=bool)
        rws = labels.rows_for_behavior(a.pid, test_vid, bid)
        rws = rws[rws["track"] == int(test_tk)]
        fr = rws["frame"].to_numpy()
        keep = (fr >= 0) & (fr < len(Xt))
        lab[fr[keep]] = (rws["value"].to_numpy()[keep] == 1).astype(int)
        reviewed[fr[keep]] = True
        if 0 < int(lab.sum()) < len(lab):
            scorings["all_frames"] = (lab, np.ones(len(Xt), dtype=bool))
        if reviewed.any() and 0 < int(lab[reviewed].sum()) < int(reviewed.sum()):
            scorings["reviewed"] = (lab, reviewed)
        if len(scorings) == 1:
            print(f"   !! {name}: no usable project labels on the test clip/track, dense only")

        for sk, (g, msk) in scorings.items():
            print(f"\n== {name} [{sk}]: pool {len(gids)} bouts ({sum(gpos.values())} pos) · "
                  f"test {int(g[msk].sum())} pos of {int(msk.sum())} scored frames "
                  f"(prevalence {g[msk].mean():.4f})", flush=True)

        curves = {sk: {k: np.full((a.seeds, a.rounds + 1), np.nan) for k in STRATS}
                  for sk in scorings}
        pos = [g for g in gids if gpos[g] == 1]
        neg = [g for g in gids if gpos[g] == 0]

        for si in range(a.seeds):
            rng = np.random.default_rng(si)
            k = a.seed_bouts // 2
            if len(pos) < k or len(neg) < k:
                print(f"   seed {si}: pool too small, stopping"); break
            start = list(rng.choice(pos, k, replace=False)) + list(rng.choice(neg, k, replace=False))
            for strat in STRATS:
                srng = np.random.default_rng(1000 + si)        # same stream per strategy => paired
                have = list(start)
                for rd in range(a.rounds + 1):
                    m = np.isin(groups, have)
                    if len(np.unique(y[m])) < 2:
                        continue
                    clf = make_model().fit(X[m], y[m])
                    pt = clf.predict_proba(Xt)[:, 1]
                    # one fit, scored against every ground truth — so the strategies are compared on
                    # identical models and the two scorings differ only in the target
                    for sk, (g, msk) in scorings.items():
                        curves[sk][strat][si, rd] = average_precision_score(g[msk], pt[msk])
                    if rd == a.rounds:
                        break
                    rest = [g for g in gids if g not in have]
                    if not rest:
                        break
                    rest_m = np.isin(groups, rest)
                    pr = clf.predict_proba(X[rest_m])[:, 1]
                    og, inv = np.unique(groups[rest_m], return_inverse=True)
                    mp = dict(zip(og.tolist(),
                                  (np.bincount(inv, weights=pr) / np.bincount(inv)).tolist()))
                    have += list(pick(strat, rest, mp, a.batch, srng))
            print(f"   seed {si} done ({time.perf_counter() - t0:.0f}s)", flush=True)

        n_lab = [a.seed_bouts + r * a.batch for r in range(a.rounds + 1)]
        rec = {"n_bouts": n_lab, "scorings": {}}
        for sk, (g, msk) in scorings.items():
            cur = curves[sk]
            final = {k: [v for v in cur[k][:, -1] if np.isfinite(v)] for k in STRATS}
            base = final["uncertain"]
            srec = {"prevalence": round(float(g[msk].mean()), 4),
                    "n_scored_frames": int(msk.sum()),
                    "curves_per_seed": {k: np.round(cur[k], 4).tolist() for k in STRATS},
                    "final": {}, "paired_vs_uncertain": {}}
            print(f"   [{sk}] final AP after {n_lab[-1]} bouts:")
            for k in STRATS:
                mean, half = ci95(final[k])
                srec["final"][k] = {"mean": round(mean, 4),
                                    "ci95_half": None if np.isnan(half) else round(half, 4),
                                    "n_seeds": len(final[k])}
                print(f"      {k:10s} {mean:.3f} ± {0 if np.isnan(half) else half:.3f}")
            for k in STRATS:
                if k == "uncertain":
                    continue
                d = [x - b for x, b in zip(final[k], base)]     # paired per-seed difference
                dm, dh = ci95(d)
                sig = (not np.isnan(dh)) and abs(dm) > dh
                srec["paired_vs_uncertain"][k] = {"mean_diff": round(dm, 4),
                                                  "ci95_half": None if np.isnan(dh) else round(dh, 4),
                                                  "separated": bool(sig)}
                print(f"      {k:10s} vs uncertain: {dm:+.3f} ± {0 if np.isnan(dh) else dh:.3f}"
                      f"{'   <- CI excludes 0' if sig else ''}")
            rec["scorings"][sk] = srec
        # keep the flat keys pointing at the dense scoring so older readers still work
        if "dense" in rec["scorings"]:
            for k in ("curves_per_seed", "final", "paired_vs_uncertain"):
                rec[k] = rec["scorings"]["dense"][k]
        out["behaviors"][name] = rec

    Path(a.out).write_text(json.dumps(out, indent=1))
    print(f"\nwrote {a.out}")
    print("Read the PAIRED differences, not the raw curves: they share each seed's start set, so they")
    print("cancel the dominant source of variance. A CI that includes 0 means the order did not matter")
    print("at this number of seeds — not that it cannot matter.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
