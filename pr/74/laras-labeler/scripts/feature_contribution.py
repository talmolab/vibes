"""Feature-contribution analysis for one behavior: how much each feature (group) helps the model.

Answers "which features drive the prediction / candidate bouts, and does a leaner feature set do
better?" using the SAME grouped cross-validation the trainer uses (bouts = CV groups), so it's an
honest, leakage-free estimate. No server needed — reads the project's labels + feature cache directly.

Three views, all on the same labeled frames:
  1. SUBSET metrics      grouped-CV AP/F1/P/R for FULL vs each feature group ALONE vs group-ABLATED.
  2. GROUP permutation   drop in average precision when a whole category is shuffled (fixed model).
  3. BASE permutation    same, per base signal (spout_roi_dist, centroid_speed, …) — the top movers.

Feature categories (by name):
  - "Spout ROI"  : spout* (spout_roi_dist / _inside / _dist_centroid, and the point-spout spout_* if set)
  - "Social"     : social* (multi-mouse / 2-mouse interaction features)
  - "Pose (SLP)" : everything else (single-animal kinematics + posture from the SLEAP keypoints)

Usage
-----
    .venv/bin/python scripts/feature_contribution.py <projects-root> --pid <pid> --bid <behavior_id>
    .venv/bin/python scripts/feature_contribution.py ~/laras-projects --pid default --bid 0 --plot ./out
"""
from __future__ import annotations
import argparse
from collections import defaultdict
from pathlib import Path

import numpy as np
from sklearn.metrics import average_precision_score
from sklearn.model_selection import StratifiedGroupKFold

from laras_labeler.featurestore import FeatureStore
from laras_labeler.labels import LabelStore
from laras_labeler.project import ProjectStore
from laras_labeler.training import Trainer, grouped_eval, make_model
from laras_labeler.video import VideoManager


def category(name: str) -> str:
    b = name.split("__")[0]
    if b.startswith("spout"):
        return "Spout ROI"
    if b.startswith("social"):
        return "Social"
    return "Pose (SLP)"


def group_perm(X, y, groups, col_map, repeats, rng):
    """Grouped-CV permutation importance: mean drop in AP when each group's columns are shuffled
    jointly on the held-out fold. col_map: {label: [col indices]}. Returns {label: (mean, std)}."""
    pos_g = len(np.unique(groups[y == 1]))
    neg_g = len(np.unique(groups[y == 0]))
    cv = StratifiedGroupKFold(n_splits=int(min(5, pos_g, neg_g)), shuffle=True, random_state=0)
    acc = defaultdict(list)
    base_aps = []
    for tri, tei in cv.split(X, y, groups):
        model = make_model().fit(X[tri], y[tri])
        Xte, yte = X[tei], y[tei]
        if len(np.unique(yte)) < 2:
            continue
        base = average_precision_score(yte, model.predict_proba(Xte)[:, 1])
        base_aps.append(base)
        for lbl, cols in col_map.items():
            if not cols:
                continue
            drops = []
            for _ in range(repeats):
                Xp = Xte.copy()
                Xp[:, cols] = Xte[rng.permutation(len(Xte))][:, cols]
                drops.append(base - average_precision_score(yte, model.predict_proba(Xp)[:, 1]))
            acc[lbl].append(float(np.mean(drops)))
    out = {lbl: (float(np.mean(v)), float(np.std(v))) for lbl, v in acc.items()}
    return out, float(np.mean(base_aps)) if base_aps else float("nan")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("projects_root", type=Path)
    ap.add_argument("--pid", required=True)
    ap.add_argument("--bid", type=int, required=True, help="behavior id")
    ap.add_argument("--repeats", type=int, default=5, help="permutation repeats per group")
    ap.add_argument("--plot", type=Path, default=None, help="dir to write PNG plots (optional)")
    args = ap.parse_args()

    store = ProjectStore(args.projects_root)
    if store.get(args.pid) is None:
        raise SystemExit(f"project {args.pid!r} not found under {args.projects_root}")
    feats = FeatureStore(store, VideoManager(store, 64, 85))
    tr = Trainer(store, LabelStore(store), feats)

    got = tr.gather(args.pid, args.bid)
    if got is None:
        raise SystemExit("no labeled frames with features ready — label some and Train/Predict once.")
    X, y, groups, _rows, used, _skipped, bouts = got
    X = np.asarray(X, np.float32); y = np.asarray(y)
    names = feats.meta(args.pid, used[0])["feature_names"]
    beh = next((b for b in store.get(args.pid).behaviors if int(b["id"]) == args.bid), {})
    name = beh.get("name", f"behavior {args.bid}")
    print(f"{name}: {len(y)} labeled frames ({int((y==1).sum())} pos), {len(bouts)} bouts, D={X.shape[1]}")

    cats = ["Pose (SLP)", "Spout ROI", "Social"]
    cat_cols = {c: [i for i, n in enumerate(names) if category(n) == c] for c in cats}
    print("  features per category:", {c: len(v) for c, v in cat_cols.items()})

    # 1) subset metrics — full vs each group alone vs group-ablated
    def line(tag, cols):
        if not cols:
            print(f"  {tag:26s} (empty)"); return
        m = grouped_eval(X[:, cols], y, groups)
        if "warning" in m:
            print(f"  {tag:26s} {m['warning']}"); return
        print(f"  {tag:26s} D={len(cols):3d}  AP={m['average_precision']:.3f}  F1={m['f1']:.3f}  "
              f"P={m['precision']:.3f}  R={m['recall']:.3f}  boutP/R={m['bout_precision']:.2f}/{m['bout_recall']:.2f}")
    print("\n== grouped-CV metrics by feature subset ==")
    allc = list(range(X.shape[1]))
    line("FULL", allc)
    for c in cats:
        line(f"{c} only", cat_cols[c])
    for c in cats:
        line(f"without {c}", [i for i in allc if i not in set(cat_cols[c])])

    # 2) group permutation importance
    rng = np.random.RandomState(0)
    gimp, base_ap = group_perm(X, y, groups, cat_cols, args.repeats, rng)
    print(f"\n== group permutation importance (base AP={base_ap:.3f}) ==")
    for c, (mu, sd) in sorted(gimp.items(), key=lambda kv: -kv[1][0]):
        print(f"  {c:26s} {mu:+.4f} ± {sd:.4f}")

    # 3) base-signal permutation importance (top movers)
    base_cols = defaultdict(list)
    for i, n in enumerate(names):
        base_cols[n.split("__")[0]].append(i)
    bimp, _ = group_perm(X, y, groups, dict(base_cols), max(2, args.repeats // 2), rng)
    print("\n== top base signals ==")
    for b, (mu, sd) in sorted(bimp.items(), key=lambda kv: -kv[1][0])[:10]:
        print(f"  {b:26s} {mu:+.4f} ± {sd:.4f}")

    if args.plot:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        args.plot.mkdir(parents=True, exist_ok=True)
        colors = {"Pose (SLP)": "#9aa3b2", "Spout ROI": "#4ad0ff", "Social": "#7fb069"}
        order = sorted(gimp, key=lambda c: gimp[c][0])
        fig, axp = plt.subplots(figsize=(8, 3.6))
        axp.barh(range(len(order)), [gimp[c][0] for c in order],
                 xerr=[gimp[c][1] for c in order],
                 color=[colors.get(c, "#9aa3b2") for c in order], error_kw=dict(ecolor="#555", lw=1))
        axp.set_yticks(range(len(order))); axp.set_yticklabels(order)
        axp.axvline(0, color="#888", lw=0.8)
        axp.set_xlabel("Δ average precision when the group is shuffled")
        axp.set_title(f"{name}: feature-group contribution (base AP={base_ap:.3f})")
        axp.grid(axis="x", alpha=0.25); axp.spines[["top", "right"]].set_visible(False)
        p = args.plot / f"{name}_group_contribution.png"
        fig.tight_layout(); fig.savefig(p, dpi=150, bbox_inches="tight", facecolor="white")
        print(f"\nplot -> {p}")


if __name__ == "__main__":
    main()
