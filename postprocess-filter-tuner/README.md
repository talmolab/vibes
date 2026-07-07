# SLEAP-NN Postprocess Filter Tuner

**Live:** https://vibes.tlab.sh/postprocess-filter-tuner/

Tune [sleap-nn](https://github.com/talmolab/sleap-nn) post-inference `FilterConfig` knobs
against ground truth — see how many bad predictions you remove versus how many good ones you
lose — then export the config and apply it to a held-out test set. Everything runs client-side
in the browser via [sleap-io.js](https://github.com/talmolab/sleap-io.js); no data leaves your
machine.

## What it does

1. **Load a validation pair** — a ground-truth `.slp` (e.g. `labels_gt.val.0.slp`) and the
   matching predictions `.slp` (`labels_pr.val.0.slp`). Frames are aligned by video + frame index.
   The output type is auto-detected from the prediction skeleton (see below).
2. **Tune the filters** — live sliders for every field of
   `sleap_nn.inference.filters.FilterConfig`:
   `min_peak_value`, `min_instance_score`, `min_mean_node_score`, `min_visible_nodes`,
   `min_visible_node_fraction`, `min_centroid_distance`, and overlap-NMS (bbox IoU).
   Plus the matcher's `match_threshold` (min OKS) and a PCK "good" distance.
3. **Read the metrics** — instance precision/recall/F1, PCK, median/p90 localization error, and
   node-visibility recall/precision, all recomputed live.
4. **See the tradeoff** — of the predicted keypoints removed vs. the raw predictions (on
   GT-matched instances), how many were **errors correctly removed** (far from GT) vs. **good
   predictions lost** (close to GT).
5. **Sweep a knob** — drag any single filter across its range and watch precision/recall/PCK/error
   curves so you can pick an operating point.
6. **Export & apply** — copy the tuned `FilterConfig` as YAML, and optionally load a test pair to
   see final metrics at that config.

## Model / output types

The output type is auto-detected from the prediction skeleton and the matcher/metrics adapt to
mirror `sleap_nn.evaluation.Evaluator`:

| sleap-nn model | Prediction `.slp` | Matcher | Metrics reported |
|---|---|---|---|
| single-instance | full skeleton, 1 inst/frame | OKS (`match_method="oks"`) | precision/recall/F1, PCK, distance, visibility |
| bottom-up (+ multiclass) | full skeleton, N inst/frame | OKS | same |
| top-down / centered-instance | full skeleton | OKS | same |
| **centroid-only** | **1-node (anchor) instances** | **centroid, pixel distance** (`match_method="centroid"`) | precision/recall/F1 + centroid distance (PCK/OKS/visibility are degenerate for one node and omitted) |
| segmentation / SAM (masks) | masks | — | not supported (this tool is keypoint/centroid only) |

A **1-node prediction skeleton** switches the tool to centroid mode: each instance collapses to its
centroid, GT centroids come from `compute_gt_centroids` (anchor node, else NaN-mean of visible
nodes), and matching is Hungarian on pixel distance with `match_threshold` (default 50px). Any
multi-node skeleton uses OKS matching.

**Detection is first-class in every mode.** TP / FP / FN (and precision/recall/F1) are shown for all
model types — they respond directly to instance-dropping filters, which is the point of a tuner.
For keypoint/top-down models the tool shows **two** detection views side by side:

- **Detections (OKS)** — from the OKS matcher (`match_threshold`), the instance-level detection.
- **Detections (centroid)** — the same TP/FP/FN but matched by centroid pixel distance, isolating
  *stage-1 detection quality* ("did we find the right animals?") from keypoint accuracy. This mirrors
  how sleap-nn evaluates a top-down model's centroid stage separately from its centered-instance
  stage. The two agree when detection is unambiguous and diverge exactly when keypoints degrade but
  the centroid is still correct (or vice versa).

## Faithfulness to sleap-nn

The evaluation is a direct port of `sleap_nn/evaluation.py` and the filters mirror
`sleap_nn/inference/filters.py`, verified against the model's own `metrics.val.0.npz`:

- **Matching** — greedy OKS matching (`match_instances` / `compute_oks`, cocoeval form,
  `stddev=0.025`, GT-bbox-area scale), sorted by instance score; centroid mode ports
  `match_centroids` + `compute_gt_centroids` (verified TP/FP/FN and centroid-distance percentiles
  against a synthetic 1-node export).
- **PCK** — `dist < threshold` over *all* node slots of matched pairs (missing → ∞), matching
  sleap-nn's `pck_metrics` (so `PCK@10` reproduces the `.npz` exactly, e.g. 0.9258).
- **Distance** — Euclidean per-node error, numpy-linear percentiles over finite values.
- **Visibility** — the same tp/fp/fn confusion as `visibility_metrics`.
- **Filters** — exact thresholds and canonical order (min_peak_value → node-count → score →
  overlap-NMS → centroid de-dup), each operating on already-predicted scores/coords.

### Why only these knobs?

`FilterConfig` filters act on the already-predicted `.slp`, so they reproduce inference exactly.
Inference-time knobs (`peak_threshold`, `integral_refinement`, `center_nms_kernel`) act on the
confidence maps *during* inference and cannot be reproduced from a `.slp` — they're intentionally
omitted. `min_centroid_distance` is a no-op for keypoint models in sleap-nn (centroid-only field);
here it de-dups on the centroid of visible keypoints as a convenience.

## Initial prompt

> Let's brainstorm vibe ideas useful for pose estimation models. Build the postprocessing filters
> helper: upload validation predictions + ground truth, recommend/visualize how performance changes
> as filter params change — how many duplicates/bad predictions we remove but also how many good
> predictions we lose — then get metrics on a test file. Follow the style of the existing vibes,
> and verify every filter and metric against the `scratch/repos/sleap-nn/sleap_nn` codebase.
