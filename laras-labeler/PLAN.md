# laras-labeler — Implementation Plan

> A local, pose-based, human-in-the-loop behavior classifier — a lightweight, modern
> [JAABA](https://jaaba.sourceforge.net/). Annotate positive/negative **frames** across videos →
> derive features from multi-animal poses → train a scikit-learn classifier → get per-frame
> predictions back in the annotation UI to guide the next labels.
>
> Built on **`sleap-io`** (poses + video), **`movement`** (cleaning + kinematics),
> **`scikit-learn`** (ML), served through a vibe-style web UI, run entirely via **`uv`**.

This document is a **self-contained handoff** for a fresh session/engineer. It captures every design
decision, the empirically-verified library recipes, the normative data contracts, the architecture,
the on-disk format, the milestones with acceptance criteria, and the known risks. Read it top to
bottom before writing code. Where a decision was genuinely open, this doc **picks a default and
marks it normative** so you never have to stop and ask.

**Notation (used consistently throughout):** `F` = frames, `T` = tracks / individuals (animals),
`N` = skeleton nodes / keypoints, `C` = coords (x,y). The core pose tensor is **`(F, T, N, C)`**.

---

## Build status (live — updated as of the first implementation session)

**Working & verified end-to-end (backend + web GUI):**
- v0a: on-disk projects (`project.json` + parquet labels), backend-served frames + poses, canvas
  video + multi-track pose overlay, **3-state annotation** (Happening / Not-happening / Unknown),
  undo/redo, project+video selectors (load any server-side video+`.slp` by path).
- v0b loop: **import annotations → train → predict → yes/no review**. Feature pipeline (§4) with
  background job + SSE + hash-invalidated memmap; per-behavior classifier; grouped-CV metrics;
  prediction heatstrip; uncertainty-ranked candidate review.
- **Importer for the event-annotator export JSON** (`segments`/`eventTypes`/`trackIdx`), with
  **mutual-exclusion negatives** (a tiled ethogram gives negatives for free — no sampling).
- Real data loads: a 15000-frame, 3-track SLEAP clip off an SMB share renders + annotates in the GUI.

**Decisions made this session (some override the plan below — this section wins on conflict):**
- **Model = `RandomForestClassifier` + constant imputer, NOT HistGradientBoosting** (D6). Measured:
  HGB ~5 s/fit on the target Intel Mac (kills interactivity); RF ~0.6 s. HGB/LightGBM = later upgrade.
- **Import format = the event-annotator export JSON** (this is the user's real format). CSV importer
  also exists as a generic fallback.
- **Per-track (per-animal) classification is the target model, and it is validated.** Head-to-head on
  real data (`compute_per_track_features` vs whole-frame pooled), grouped-CV AP:
  Walking 0.71→**0.87**, Climbing 0.21→**0.49**, Rearing 0.36→**0.52**, Jump Down 0.17→**0.24**.
  Per-track wins on every behavior with signal (focal animal's own features beat pooling over all mice).
- **Skeleton-role resolution matters and was buggy:** real skeleton uses `TTI` (tail-torso interface)
  as the tail base; the resolver now knows it. A role-unresolved feature is dropped (not crashed).
  **TODO: expose a skeleton-role picker** so axis keypoints are never silently wrong.
- **Labels are imperfect** (owner's note): use the model as a **label-error finder** — a
  `disagreements` candidate mode (confident model⊥label) should surface likely-mislabeled bouts for
  yes/no correction. This also fixes the empty-review-queue on a fully-labeled clip.
- **Architecture = backend-served app, frontend restyled toward event-annotator** (owner choice):
  the Python backend serves SMB videos + poses + projects + ML; the web GUI is being evolved to
  match event-annotator's UX (per-track timeline rows, hotkey paint-to-commit, zoom/pan, behavior modal).
- **Video playback = client-side MediaBunny (reused from event-annotator), NOT backend JPEG.** Backend
  per-frame JPEG over SMB is ~1 s/frame (even sequential) — unusable for real-time playback, and the
  native `<video>` element can't decode this codec (readyState 0). Fix: the frontend fetches the mp4
  from `GET …/video/{vid}/stream.mp4` (FileResponse, range-capable) and decodes it with
  `sleapio.MediaBunnyVideoBackend.fromBlob` (WebCodecs) → `getFrame(idx)` onto a canvas, with a
  prefetch window and an rAF playback clock. Result: **smooth 30 fps playback + fast frame-accurate
  stepping/scrubbing**. Gotcha that cost time: use `.finally()` (not `.then()`) to clear the
  playback-busy flag, or a rejected frame promise stalls the loop (this is what event-annotator does).
  The per-frame JPEG endpoint remains as a fallback; `sio reencode` is no longer needed for playback.

**DONE since:** **per-track upgrade shipped end-to-end** — labels have a `track` column; features
stored as `(F, T, D_pt=272)` memmap (`compute_per_track_features`); train pools per-`(track, frame)`
examples with bouts grouped per `(video, track)`; predict/candidates per `(track, behavior)`.
**JAABA two-lane timeline** shipped: each behavior shows a *manual* lane (labels) + an *auto* lane of
**clickable predicted bouts** — clicking one opens the yes/no review ("is track T doing X?"). Active
**track selector** drives labels, predictions, feature time-series, and review. Verified on the real
clip (Rearing per-track AP 0.54, grouped-CV; clicking a predicted bout at 2250–2306 p=0.94).
**Disagreement review shipped** (the "annotations aren't perfect" workflow): the Review panel has a
**mode toggle** — *New detections* (unlabeled predicted bouts, as before) vs *Label disagreements*
(`Predictor.disagreements`), which ranks your *labeled* bouts by how confidently the model contradicts
the label sign (pos label + low p, or neg label + high p; same smooth/hysteresis/length filter as
detection bouts). Each item is a yes/no — **y flips** the (trimmable) range to the model's verdict,
**n keeps** your label — so a confident model surfaces likely mislabels for one-key correction.
Verified E2E through the real HTTP route (a deliberately-wrong positive label on a model-says-no clip
surfaces as a disagreement suggesting neg; new-mode excludes labeled frames).
**Training-set provenance shipped:** `train()` now snapshots the exact bouts it learned from — one dict
per CV group `(video, track, [start,end), value, n_frames)` — into a frozen `model/<bid>/trainset.json`
(labels change post-train, so it's captured at fit time, not reconstructed). Served by
`GET …/behaviors/{bid}/trainset`; a **"🗂 Training set" panel** lists clip→track→bout (click a bout to
jump; **Copy JSON** exports all). Models trained before this feature degrade gracefully to a `stale`
video-list+totals view (from `meta.json`) instead of 404. The **learning curve** (Stats panel, already
shipped) gained a **bouts↔frames x-axis toggle** (`statsXMode`). Verified with unit + real-HTTP tests
(exact bout provenance, Unknown excluded, frozen against relabel, stale fallback) and an adversarial
multi-agent review whose 5 confirmed UI-integration findings were all fixed (frozen behavior id on
jump; close-review-before-jump; out-of-range-track guard; stale-model message).
**Review + playback polish shipped:** (a) candidate accept-range can now be **extended** past the model's
proposal, not just shortened (trim clamps to `[0, n_frames]`; keyboard `[`/`]` at the playhead extend
beyond the zoom window). (b) A **whole-clip overview strip** (shown when zoomed/reviewing) draws the
zoom window + labels + predicted bouts + candidate, click/drag to jump; the review card shows a
frame/time/%-through **location readout**. (c) **Playback perf**: `renderTimeline`/`drawFeatures`/overview
used to reallocate canvases + recompute the heatstrip (O(behaviors×W)) and feature min/max
(O(features×F)) *every played frame*; now the "base" is snapshotted to offscreen bitmaps and playback
frames blit base + redraw only the playhead (`repaintTimeline`/`repaintFeatures`/`repaintOverview`),
with the fast path keyed on W/H/tlView/dpr and falling back to a full render (which recaptures) on any
change. An adversarial review's 7 confirmed findings were all fixed (tlView/dpr in the cache guard;
stop-playback + no-mid-drag-view-widen on trim to kill a cursor-feedback runaway; cache invalidation
on behavior/track switch; overview base-cache to drop per-frame O(F) work).
**Already-labeled bouts no longer re-suggested:** the model re-fires on its own training frames, so
(a) the clickable auto-lane predicted bouts now subtract the labeled mask (`unlabeledSubruns`, mirroring
the backend `candidates()`), recomputed live on every paint/undo/label-reload, and (b) **Review** reloads
the candidate queue on open (it was only refreshed on train/predict/switch, so manual labels since the
last train left a stale queue). The faint probability heat-strip still shows the model's raw belief
everywhere; *Label disagreements* still surfaces model-vs-label conflicts.
**Label provenance shipped:** every label write now carries a `source` (`manual` painted / `candidate`
accepted from review / `imported`) — threaded per-span through `put_labels`/`put_spans`; accepting a
candidate tags `candidate`, hand-painting `manual`, and *disagree→keep* writes nothing (so a
hand-labeled bout stays `manual`). A **🏷 Label sources** panel (`GET /label-stats` →
`LabelStore.source_stats`) shows, per behavior → track → source, how many positive/negative **bouts**
(contiguous same-value, same-source runs) you labeled by hand vs accepted from candidates vs imported —
answering "how many bouts did I label prior to training vs add from predictions, on which track."
Per-frame **provenance is tracked in a parallel `sourceState` array** so undo/redo restores each frame's
original source (not a single op-level source), and legacy/NaN sources are backfilled to `manual`.
**Feature-diff panel shipped:** **📈 Feature diff** (`Trainer.feature_diff` → `GET …/feature-diff`) shows,
for a behavior, how each keypoint feature separates positive vs negative labeled frames — a ranked
**separability** bar chart (Mann-Whitney AUC; blue=higher-during-behavior, red=lower) with Cohen's d, and
a grid of **dual pos/neg density histograms** for the top features. Guards: a real per-feature support
floor (a mostly-occluded column can't saturate the ranking), clamped Cohen's d, and per-class-union
histogram ranges. Both features passed an adversarial review; its 8 confirmed findings are all fixed
(undo/redo source loss; NaN-source drop; permissive support gate + d blow-up; imbalanced histogram
clipping; unescaped names; invisible swatch).
**Egocentric + body-length feature normalization shipped** (`FEATURE_CODE_VERSION=2`, invalidates caches):
speeds/accel/approach are now divided by the per-track median body length → **body-lengths/sec**
(size- & zoom-invariant; config `normalize_scale`), and the posture spread is computed in the **heading
frame** with new `ego_len`/`ego_width` extents (rotation-invariant; config `egocentric`) — replacing the
old world-axis bounding box. Verified: 2× scaling leaves normalized features bit-identical; a 30° global
rotation moves the egocentric spread 1.3% vs 60% for the old world-frame spread; real 15-keypoint mouse
data computes cleanly (D 272→304, `body_length` median = 1.00). NB: RandomForest is invariant to
per-feature scaling, so body-length norm mainly helps **pooling across differently-sized animals/zoom**;
the egocentric (rotation) invariance helps within a single clip too. An adversarial review's 2 medium
findings were fixed: (a) velocity normalization falls back to raw pixels for a degenerate track whose
nose/tail were never co-detected (`ref` NaN) instead of NaN-wiping its only locomotion signal; (b) a
version bump changes `D`, so `predict_one` now skips (rather than crashes) a model whose feature
dimension doesn't match the recomputed cache — that behavior just needs a retrain.
**Remove-clips shipped:** `DELETE …/videos/{vid}` → `Project.remove_video` drops the manifest entry and
its derived data (labels parquet, feature cache, predictions dir) and deletes uploaded media that lives
*inside* the project — but never a source video/SLP on an external path (e.g. SMB). `LabelStore`/
`VideoManager` evict their caches. The clip bar now always shows (even with one clip) and each chip has a
**✕** that confirms then removes; removing the active clip switches to another (or an empty state),
removing a non-active clip stays put. Verified E2E (derived data deleted, external source kept, media
cleaned, other clips intact, 404 on unknown).
**Distance-to-spout features shipped:** a shared arena landmark stored in `feature_config["spout"]=[x,y]`
(so changing it auto-invalidates the feature cache) adds per-animal `spout_dist` (nose→spout),
`spout_dist_centroid`, `spout_approach_rate` (closing speed), `spout_facing`, and `spout_in_zone`
(within `spout_zone_bl` body lengths) — all body-length-normalized, present only when a spout is set
(D 304→384). `PUT …/spout` sets/clears it; the project GET exposes it. UI: a **◎ Set spout** button →
click the video to place a marker (screen→video coords via the overlay rect, so zoom/pan-correct),
right-click to clear; the marker draws on every clip. Verified: an animal walking at the spout shows
distance → 0.12 BL, positive approach-rate, in-zone flip, facing ≈ 0; no-spout projects are unchanged;
setting the spout changes the config hash; the endpoint round-trips. NB: spatiotemporal embeddings
(windowed egocentric-pose PCA / spectral) remain a possible follow-up.
**Spout-ROI (polygon) features shipped:** the spout can now also be a *region* — a polygon stored in
`feature_config["spout_roi"]=[[x,y],...]` (the natural home for the segmentation "water" ROI, e.g. the
HCM DB's per-recording `rois` water polygon, which sits low-center at ~(280–330, 490–530) in the
1280×1024 frame). Adds per-animal `spout_roi_dist` (nose→region, **0 when the nose is inside**),
`spout_roi_dist_centroid`, and `spout_roi_inside` (nose-in-region indicator) — body-length-normalized,
present only when an ROI is set (D +48 → e.g. 304→352 with no point spout). Geometry is a vectorized
`_poly_signed_dist` (min distance to each edge, clamped to 0 inside via ray-casting point-in-polygon;
NaN query points stay NaN, not "outside"). More precise than the point + circular `spout_in_zone` for
an irregular landmark. `PUT …/spout-roi` sets (≥3 pts, else 400) / clears it; the project GET exposes
it. UI: a **◇ Set spout ROI** button → click to drop polygon vertices, **Enter** finishes, **Esc**
cancels, **right-click** removes the last vertex (or clears a committed ROI); the polygon draws on every
clip. Verified end-to-end: known-point distances (0 inside / 10px left-of-edge / 95px below / NaN
absent); real mice-sample pipeline (D 304→352, all 3 features finite, `inside`∈[0,1], `dist`≥0, none
dropped); HTTP round-trip with hash-invalidation on set and restore on clear, and the ≥3-point guard.
**HCM spout-ROI importer:** `scripts/import_hcm_spout_roi.py` (standalone, inline uv deps — no coupling
to the labeler install) reads the HCM DB's per-recording segmentation "water" polygon and sets it as a
project's `spout_roi` via `PUT …/spout-roi`. It picks the **medoid** polygon per camera (the recording
whose water-bbox center is closest to the camera's median center, over ~9–14k recordings), so a single
segmentation glitch can't win. `--list-cameras` / `--camera cam_05` (print) / `+ --pid <project>` (set).
Coords are the native HCM frame (1280×1024) and are NOT rescaled — use only on same-camera videos.
Verified against the live DB: all 4 cameras return a clean 9–11-vertex polygon at 0.0px from the median
center, and `--pid` round-trips into a running labeler's `project.json`.
**2-mouse social gate shipped** (from Leo's locked v8 drinking filter,
`vast/leo/2026-07-07-AD-identity-eating/DRINKING_FILTER.md` §Step 5.2): `candidates()` now drops a
predicted drinking bout where **≥2 mice have their nose in the spout ROI at once for ≥ `social_gate_s`**
(default 0.5 s) — the "can't attribute the drink to one animal" case. Uses the per-track
`spout_roi_inside` already in the feature cache: `drink_count[f] = #tracks nose-in-ROI`, drop if the
longest run of `drink_count≥2` inside the bout ≥ `round(social_gate_s·fps)`. Each candidate carries
`max_concurrent` + `social_overlap`; the review card flags survivors with brief overlap (⚠ N mice at
spout). No-op without a spout ROI or with <2 tracks. Verified: a 2-mouse-overlap bout is dropped, a
single-mouse bout kept, and the threshold is configurable per behavior. NB: the full v8 filter also has
a capsule tip-zone, a max-duration cap, and a Welch-PSD lick estimate — not yet ported (this took only
the social gate).

**Roadmap (next):** (1) **multi-video** (train on A, predict on B) — backend already fans out; needs
per-video CV grouping + a cross-video held-out eval. (2) JAABA **ground-truthing** (prediction-blind
held-out eval; honor `source='groundtruth'` in `gather`). (3) **skeleton-role picker** (resolver +
`skeleton_roles` manifest slot + hash-invalidation all exist; only a GET/PUT-roles endpoint + modal
missing). (4) more/selectable features in the time-series panel; behavior-manager modal; zoom/pan.
The measured metrics are **floors** (imperfect labels) — real separability is higher.

---

## 0. Design decisions (locked)

Decided with the tool's owner. **Honor them; if you deviate, flag it.**

| # | Decision | Choice | Consequence |
|---|---|---|---|
| D1 | **Label unit** | **Whole-frame, animal-agnostic.** A behavior label attaches to `(video, frame)` — "grooming is happening in this frame," not "animal 2 is grooming." | Training sample = one per frame. Multi-animal poses feed **features**, not the label target. Timeline has one label/prediction row per behavior (no per-animal sub-rows). |
| D2 | **Label states** | **3-state: positive / negative / unlabeled**, trained only on pos+neg. Unlabeled ≠ negative. | JAABA-correct. Most frames stay unlabeled and are only ever *predicted*. |
| D3 | **Data scale** | **~1 hour @ 30 fps ≈ 108k frames per video**, multiple such chunks. | Build for large-per-video from day 1: on-demand server frames, per-video pose preload, **memmapped features**, background full-corpus prediction. |
| D4 | **First milestone** | **Reliably label behaviors in ONE video**, with the assistive train→predict loop on that same video. | v0 = single-video end-to-end. Multi-video is v1. Labeling reliability (frame-accuracy, persistence, undo) is the v0 acceptance bar. |
| D5 | **Frame delivery** | **Python backend is authoritative.** FastAPI serves exact frames via `sleap-io` `get_frame(i)`; the video lives on / is uploaded to the server. | "Frame N is exactly frame N." No HTML5-decoder frame-accuracy guessing at label time. |
| D6 | **ML backend** | scikit-learn, **one binary classifier per behavior** (see §5, §8, §9 for the per-behavior persistence/API scheme). **v0 uses `RandomForestClassifier` + constant imputer, NOT HistGradientBoosting** — measured: HGB is ~5s/fit at 50 iters on the target Intel Mac (kills the interactive loop), RF fits in ~0.6s. HGB/LightGBM remain a drop-in upgrade on faster hardware. | RF is fast enough for interactive retrain; `class_weight='balanced_subsample'`; NaN imputed (pose data ~0.6% NaN). |
| D7 | **Stack** | FastAPI + `pyproject.toml` package + `laras-labeler` console script + committed `uv.lock`; single `index.html` (inline CSS) + native ES modules, no bundler. | Launch: `uv run laras-labeler <projects-dir>`. True to the "vibe" aesthetic, scaled to a real app. |

### Assumption to confirm with the owner (flagged, not blocking)

- **D1 is read as whole-frame** from "the unit will be frames" + the original brief ("annotate some
  positive and some negative frames"). If per-animal attribution ("*which* animal is grooming") is
  actually wanted, it is an **additive** change: give each training sample a `target` = an animal
  slot, build per-animal feature vectors (§4 already computes them before pooling), and add
  per-animal rows to the timeline. Do not build it in v0 unless the owner asks.

---

## 1. Environment — verified facts (do not re-litigate)

Confirmed empirically on the owner's machine (Intel macOS, `uv 0.11.x`):

- **`sleap-io == 0.8.0`**, `sio` CLI installed as a `uv` tool at `~/.local/bin/sio`.
- **`movement == 0.17.0`** installs and runs, **but** a naive `pip install movement` **fails** on
  Intel macOS. **The real blocker is `pyproj`** (via `xarray[viz]` → `cartopy`), which needs the PROJ
  C library and has no Intel-macOS wheel (empirically: `Failed to build pyproj==3.7.2 … proj
  executable not found`). **`numba`/`llvmlite` are NOT the blocker** (they have wheels), and you
  **cannot** drop the `viz` extra with consumer-side pins because `movement` forces
  `xarray[accel,io,viz]` transitively. **Verified-working install:** `uv pip install movement==0.17.0
  --no-deps`, then install its runtime set directly — `numpy pandas xarray scipy sleap-io attrs pooch
  tqdm shapely PyYAML loguru orjson bottleneck` (loguru+orjson required to import; bottleneck for
  interpolation/ffill; matplotlib+shapely only for `movement.roi`; numba/llvmlite unnecessary). For
  the packaged build (§10), either replicate this (`movement --no-deps` + explicit runtime deps) or
  add `[tool.uv]` dependency overrides that swap out cartopy/pyproj — and **verify movement imports
  in CI on the target platform.**
- **`uv run --with sleap-io …` can fail** on this machine because a broken anaconda package
  (`pyodbc-4.0.0_unsupported.dist-info`) poisons metadata resolution. Use **`uv run --isolated
  --with …`** or the packaged env. The shipped `pyproject.toml` + `uv.lock` sidesteps this entirely.
- **Sample fixture for development:** `../slp-viewer/mice.tracked.slp`
  (+ `mice.mp4` beside it). 1410 frames, 768×1024 grayscale, ~47 fps, **2 tracks**, 15-node mouse
  skeleton (`nose, head, earL, earR, neck, shoulderL, shoulderR, tail_base, haunchL, haunchR, trunk,
  tail0, tail1, tail2, tail_tip`; **no `centroid` node** — see §4.3), 1409 labeled frames of
  `PredictedInstance`. Small but multi-animal. It is **not** 1 hr, so also build the long-video
  fixture in §12 to exercise frame-serving and the memmap/streaming paths at D3 scale.

---

## 2. System architecture

Python backend does everything heavy; the browser is the labeling surface. This split is forced
(`movement`/`sklearn` are Python) and is what lets the loop scale to 108k-frame videos.

```
┌──────────────── Browser (127.0.0.1:PORT) ─────────────────┐
│ index.html (inline CSS) + native ES modules               │
│  ├ app.js       state, routing, fetch API client           │
│  ├ viewer.js    <img> frame + <canvas> pose overlay        │
│  └ timeline.js  <canvas> ethogram + prediction heatstrip   │
└─────────┬───────────────────────────────────────▲─────────┘
   JSON / JPEG frames / binary poses               │ SSE training progress
┌─────────▼───────────────────────────────────────┴─────────┐
│ FastAPI (uvicorn, single worker, 127.0.0.1) — STATELESS    │
│  ├ StaticFiles → serves the frontend                       │
│  ├ VideoManager  sleap-io backend, LRU frame cache, JPEG   │
│  ├ PoseStore     Labels.numpy() → float32 (F,T,N,C)        │
│  ├ FeatureCache  movement clean+kinematics → memmap (F,D)  │
│  ├ Jobs          background thread + queue (features/train) │
│  ├ Trainer       HistGradientBoosting + StratifiedGroupKFold│
│  └ Predictor     2-phase: on-screen first, full corpus bg  │
└─────────┬──────────────────────────────────────────────────┘
          ▼
   projects root on disk: one directory per project (§9)
```

Every request carries its `{pid}` (project id) — the server holds **no "active project" state** (§8).

---

## 3. Data & label model

### 3.1 Poses → dense array (sleap-io, verified)

`Labels.numpy()` is the one-call path to an ML-ready tensor.

```python
import sleap_io as sio, numpy as np

labels = sio.load_file(".../mice.tracked.slp")
pose = labels.numpy(return_confidence=True)   # (F, T, N, 3) float32 = [x, y, score]
xy   = pose[..., :2]                            # (F, T, N, 2)
conf = pose[..., 2]                             # (F, T, N)

track_names = [t.name for t in labels.tracks]           # axis-1 (T) order = identity slots
node_names  = labels.skeletons[0].node_names            # axis-2 (N) order
edges       = labels.skeletons[0].edge_inds             # [(src_i, dst_i), ...] for bones/angles
```

**Axis order: `(F, T, N, C)` = `(n_frames, n_tracks, n_nodes, coords)`.** Verified on the sample:
`(1410, 2, 15, 3)`.

**Gotchas (must handle):**
- **Axis 0 length = full video frame count** (1410), padded with all-NaN rows for frames that have
  no `LabeledFrame` (e.g. frame 296 in the sample). `pose[frame_idx]` indexes directly by video
  frame.
- **`labels.labeled_frames` is a list, NOT frame-indexed** (`labeled_frames[i] != frame i`). To go
  frame#→LabeledFrame use `labels.find(video, frame_idx)`, never positional indexing.
- **Two distinct missing cases** (encode differently downstream):
  - `conf == NaN` (and `xy == NaN`) ⇒ the whole instance/animal is **absent** that frame.
  - `conf == 0.0` with `xy == NaN` ⇒ instance present but that **keypoint dropped** (occluded).
- **Multi-video:** `frame_idx` is per-video → always slice with `labels.numpy(video=<Video|idx|path>)`.
- Confidence can exceed 1.0 — do not assume [0,1] when thresholding: **per-keypoint** `conf` peaks
  ~1.47 on the sample; **instance-level** `Instance.score` peaks ~1.05. (The `conf` array you gate on
  is per-keypoint.)

### 3.2 Label store

Per-frame, per-behavior tri-state. Stored per video as parquet.

```
labels/<video_id>.parquet
  frame:       int32
  behavior_id: int16
  value:       int8      # +1 positive, 0 negative  (unlabeled rows simply absent)
  source:      category  # 'manual' | 'imported' | 'groundtruth'   ('groundtruth' rows NEVER train, v1)
```

Absent `(frame, behavior_id)` ⇒ **unlabeled** ⇒ excluded from training. Labeling *input* is
range-painting that expands to per-frame rows (reuse `event-annotator`'s paint/merge/erase algebra,
§11), but the stored unit is the frame.

### 3.3 Normative data contracts (resolve these once, reference everywhere)

These are the contracts a fresh session would otherwise stop to ask about. **They are normative.**

- **`video_id`** — `slugify(Path(video_path).stem)`. On collision within a project, append `-2`,
  `-3`, … (or a short hash of the absolute path). Stored in `project.json.videos[].video_id`.
  **Reject** re-adding a `video_path` already present. `video_id` is unique **within a project only**
  (it is always used under `/api/projects/{pid}/…`). It is the filename key for
  `labels/<id>.parquet`, `poses/<id>.npz`, `features/<id>.npy`, `predictions/<id>.parquet`.
- **`bout_id` (for grouped CV, derived, not stored)** — computed **per behavior** from that
  behavior's labeled rows: sort by `frame`; **start a new bout whenever `value` changes OR `frame`
  is non-consecutive** (any unlabeled gap breaks the run). Each bout is **class-pure** by
  construction. Key = `f"{video_id}:{behavior_id}:{run_index}"` (globally unique across videos so
  multi-video group-by-bout works). Group-by-*video* (v1) simply uses `video_id` as the group.
- **Label-span semantics (paint & API)** — ranges are **half-open `[start, end)`, `end` exclusive**.
  `PUT` **overwrites** every frame in the range for that `behavior_id` with `value`. `DELETE` removes
  those rows (→ unlabeled). The reused event-annotator paint algebra must adopt the same half-open
  convention (watch the boundary frame).
- **Feature vector length `D`** — see §4.4: in v0 `D` is a **pure function of `feature_config`**,
  independent of the number of animals. Per-slot features (identity-dependent) are **off by default**.
- **`feature_config_hash`** — `sha256` of canonical JSON of
  `{stats, radii_seconds, offsets, wradius_seconds, pool_aggregates, confidence_threshold,
  skeleton_roles, feature_code_version}`. Project-wide (one feature scheme per project).
- **`slp_content_hash`** — hash of the `.slp` file bytes (or `sio show` header + mtime+size), stored
  per-video so a changed `.slp` invalidates that video's pose/feature caches.
- **Per-video `features` status** — `'none' | 'pending' | 'ready' | 'error'` **plus** the
  `feature_config_hash` + `slp_content_hash` it is ready for. Training/prediction **refuse** a video
  whose features are not `'ready'` for the current hashes (or trigger a recompute job first).
- **`has_poses`** — per-video boolean. A video may be added with **no `.slp`** (labeling-only mode):
  frames + labels work; features/train/predict for that video are disabled; it is excluded from the
  training corpus. Frames with zero instances yield all-NaN feature rows (kept — HGB-native).

---

## 4. Feature pipeline (pose → per-frame feature vector)

Goal: a **fixed-length** `float32` vector **per frame**, built from all animals' poses, cached once
per video, reused across every retrain. Cleaning + base kinematics come from `movement`; social
relatives + across-animal pooling + window stats + assembly are our thin layer.

### 4.1 Ingest into movement (verified transpose — mind the axis names)

`movement.io.load_poses.from_sleap_file` takes a *path* and reads only the first video, so **do not
use it** for multi-video / in-memory work. Feed our sleap-io array via `from_numpy`. movement's dims
are `(time, space, keypoint, individual)`, i.e. our `(F, T, N, C)` maps to movement position
`(F, C, N, T)` and confidence `(F, N, T)`:

```python
from movement.io import load_poses
fps = video_meta["fps"]                                   # ALWAYS the real per-video fps (§4.5) — never a literal
position   = np.transpose(pose[..., :2], (0, 3, 2, 1)).astype("float32")  # (F, T, N, C) -> (F, C, N, T)
confidence = np.transpose(pose[..., 2],  (0, 2, 1)).astype("float32")     # (F, T, N)    -> (F, N, T)
ds = load_poses.from_numpy(position, confidence,
        individual_names=track_names, keypoint_names=node_names,
        fps=fps, source_software="SLEAP")
```

With `fps` set, movement's `time` coord is in **seconds** and derivatives are **per-second** — this
is why window radii are defined in seconds (§4.5).

### 4.2 Cleaning (movement.filtering) — fixed order

`filter_by_confidence(threshold=confidence_threshold)` → `interpolate_over_time` → optional
`rolling_filter(statistic='median')` / `savgol_filter`. Constraints (verified on the sample):
`interpolate_over_time` (default `max_gap=None`) fills only **interior** gaps and does **not
extrapolate** leading/trailing NaNs — so residual edge NaNs remain and **still trip `savgol_filter`**
(`ValueError: mode='interp' does not support NaNs in edge windows`, SciPy ≥ 1.17) *even after
interpolation*. Running savgol "after interpolation" is **not** sufficient by itself. Fixes: pass
`savgol_filter(..., mode='nearest')` (movement forwards `**kwargs` to SciPy), or fill/trim the
leading/trailing NaNs first, or prefer **`rolling_filter(statistic='median')`** (NaN-tolerant, verified
to work). Operate on `ds.position` (the DataArray), not the Dataset. **v0 default `confidence_threshold = 0.0`** (keep all keypoints; rely on
interpolation+smoothing) — SLEAP scores are not in [0,1], so a nonzero gate needs per-dataset tuning;
store the value in `feature_config`.

### 4.3 Skeleton roles (make features skeleton-agnostic)

Features reference **semantic roles**, not hardcoded node names. Add a **`skeleton_roles`** map to
`project.json`, auto-populated on video-add by matching common node names, user-editable:

```jsonc
"skeleton_roles": { "nose": "nose", "tail_base": "tail_base",
                    "left_ear": "earL", "right_ear": "earR" }
```

Derived, not stored as nodes:
- **centroid** = mean of that animal's **visible (non-NaN)** keypoints that frame (the sample has no
  `centroid` node).
- **body-length reference** = median over time of `dist(nose, tail_base)` per animal; distances are
  divided by it so features transfer across body sizes / pixel scales.

**Graceful degradation:** if a required role is unresolved, **drop only the features that need it**
(record which in `features/<id>.meta.json`) rather than crashing; surface unresolved roles in the UI.

### 4.4 Base features, across-animal pooling, whole-frame assembly (D1)

Because the **label is whole-frame** but there are `T` animals, reduce per-animal signals to
**animal-count-invariant** frame-level signals so `D` is fixed across videos regardless of how many
animals are present.

**Order of operations (normative): compute per-animal base → reduce social to focal-vs-nearest →
POOL across animals → THEN window (§4.5).**

**A. Per-animal individual base features** (~12; movement gives most for free — `compute_velocity`,
`compute_speed`, `compute_acceleration`, `compute_forward_vector`/`_angle`, `compute_turning_angle`,
pairwise `dim='keypoint'` for body length): centroid speed, nose speed, tail_base speed, forward
(along-heading) speed, lateral speed, acceleration magnitude, heading, angular velocity, |turn|, body
length, body-bend angle (nose–centroid–tail_base), convex-hull area. All distances body-length-normalized.

**B. Social base features (focal-vs-nearest-other)** (~6): for each animal, find the nearest other
animal (min centroid distance) and compute nose-nose, nose-tail, centroid-centroid distance
(normalized), facing angle (focal heading vs focal→other vector), in-front-cone (±45° binary),
approach rate (signed d/dt of inter-animal distance). Compose angles from `compute_forward_vector` +
`movement.utils.vector.compute_signed_angle_2d`. **If `T < 2` (no other animal): social features =
NaN** (HGB-safe).

> **Inter-animal distance API (verified gotcha).** `compute_pairwise_distances` requires the `pairs`
> argument — a bare `compute_pairwise_distances(pos, dim='individual')` raises `TypeError`. Select the
> keypoint first and pass `pairs`: `compute_pairwise_distances(pos.sel(keypoint='nose'),
> dim='individual', pairs='all')` → per-pair distance over time; take the min over other individuals
> for nearest-other. (Passing full `position` with `dim='individual'` yields a keypoint×keypoint cross
> matrix, e.g. `(F, 15, 15)`, not a scalar — so always `.sel(keypoint=…)` or use the derived centroid.)

**C. Pool across present animals** → frame-level signals. Each base feature (A and B) is reduced over
the animals present that frame into a fixed **`pool_aggregates = {min, mean, max}`** (3). Add
`n_animals_present` (int). **Empty frame (0 animals): all pooled features = NaN, `n_animals_present`
= 0.** This is the step that makes `D` independent of animal count.

- Frame-level base signal count `B = (n_individual_base + n_social_base) × |pool_aggregates| + 1`.
  Sample: `(12 + 6) × 3 + 1 = 55`.

**Per-slot features (identity-dependent) are OFF by default (v0).** If enabled via config, they
concatenate per-track base features by identity slot (NaN-padded when absent) and require **identical
`n_tracks` across all project videos** (recorded in `feature_config`; reject adding a video whose
track count differs). This is the natural hook for the per-animal D1 extension.

### 4.5 Window features (JAABA's heart — pruned for v0)

Each frame-level base signal `B` (§4.4C) is expanded with windowed statistics, **plus its raw
instantaneous value**:
- **Stats (v0):** `mean, std, min, max, change` (`change` = mean of a small end-window minus mean of
  a small start-window; a smoothed slope). (5 stats.)
- **Radii (v0), in SECONDS:** derive from a single `wradius_seconds` "behavior timescale" knob as
  `{small≈0.07s, wradius/2, wradius}`; **convert to per-video frame counts at compute time**
  (`round(sec * fps)`), so timescales are physical and consistent across videos of differing fps.
  Default `wradius_seconds ≈ 0.5` → radii ≈ `{2, 8, 16}` frames at 30 fps. (3 radii.)
- **Offset (v0):** centered only. (v1: backward −1 / forward +1 for onset-sensitive behaviors.)
- **Transforms (v0):** `none` + `absolute` on inherently-signed features (angular velocity, |turn|,
  approach rate). (v1: JAABA `relative` = per-trajectory percentile normalization, and `flip`.)

**Feature count `D` (derivable, not magic):**
`D = B × (n_stats × n_radii × n_offsets + 1_raw)`. Sample: `55 × (5×3×1 + 1) = 55 × 16 = 880`.
Compute windowed mean/std/min/max with cumulative sums / running min-max (O(F) per signal,
independent of radius). Keep systematic, auditable names
(`social_nose_nose__poolmin__win_std__r8`) for the feature-importance panel.

### 4.6 Feature cache (memmap, D3-critical)

Per-video features are **large and static**; the labeled training set is **tiny and changing** —
optimize separately. Compute features **as a background job** on video-add (never synchronously — it
takes seconds→minutes at D3), store a `float32` memmap:

```
features/<video_id>.npy         # shape (F, D) float32, memmapped
features/<video_id>.meta.json   # {feature_names[D], D, feature_config_hash, slp_content_hash,
                                #  fps, dropped_features[], status}
```

**Sizing at D3** (F=108k, D≈880): `108000 × 880 × 4 B ≈ 380 MB/video` on disk — keep as memmap,
never fully in RAM. Predictions are `float32 (F, n_behaviors)` ≈ tiny. Every retrain slices labeled
rows; every prediction streams from the memmap. **Never recompute features on a retrain.**

**Invalidation:** on video open/train, compare stored vs current `feature_config_hash` and
`slp_content_hash`; on mismatch, set status `pending` and recompute (background) before training.
Because `feature_config` is project-wide, a `wradius`/stats change invalidates **all** video caches.

---

## 5. ML backend (scikit-learn) — one model per behavior

### 5.1 Model, semantics, validation

- **Model:** `HistGradientBoostingClassifier(loss="log_loss", learning_rate=0.1, max_iter=200,
  max_leaf_nodes=31, l2_regularization=1.0, early_stopping=True, class_weight="balanced",
  random_state=0)`, wrapped in a trivial `Pipeline([("clf", ...)])`. **No StandardScaler, no
  imputer** — trees are scale-invariant and HGB learns the NaN split direction (occlusion is signal).
- **One binary classifier PER behavior.** Everything below is scoped to a single `behavior_id`.
- **Training data:** rows for that `behavior_id` with `value ∈ {0,1}`; unlabeled excluded (D2);
  `source='groundtruth'` excluded (v1).
- **Validation without leakage:** use **`StratifiedGroupKFold` grouped by `bout_id`** (§3.3);
  upgrade `groups` to `video_id` once ≥ ~5 videos (honest "unseen-session" estimate). Report
  positive-class **P/R/F1**, confusion matrix, **PR curve + average precision** (PR, not ROC).
- **Refuse to report** (don't let sklearn raise) when there aren't enough *groups per class*:
  compute `n_pos_groups`/`n_neg_groups` (distinct bouts with y=1 / y=0), set
  `n_splits = min(5, n_pos_groups, n_neg_groups)`, and return a `{"warning": …}` when either `< 2`.

### 5.2 train() / predict() sketch (per behavior; verified API)

```python
import numpy as np, joblib, hashlib, json
from sklearn.pipeline import Pipeline
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.model_selection import StratifiedGroupKFold, cross_val_predict
from sklearn.metrics import (precision_recall_fscore_support, average_precision_score,
                             confusion_matrix)

def make_model():
    return Pipeline([("clf", HistGradientBoostingClassifier(
        loss="log_loss", learning_rate=0.1, max_iter=200, max_leaf_nodes=31,
        l2_regularization=1.0, early_stopping=True, class_weight="balanced", random_state=0))])

def train_behavior(behavior_id, rows, feature_cache, feature_config_hash):
    # rows: iterable of (video_id, frame, y in {0,1}, bout_id)  -- already filtered to THIS behavior
    X = np.asarray([feature_cache.row(v, f) for (v, f, y, b) in rows], np.float32)   # NaNs OK
    y = np.array([y for (*_, y, b) in rows], np.int8)
    groups = np.array([b for (*_, b) in rows])
    metrics = grouped_eval(X, y, groups)
    pipe = make_model().fit(X, y)
    version = _version(behavior_id, rows, feature_config_hash, pipe.get_params())
    path = f"model/{behavior_id}/{version}.joblib"
    joblib.dump(pipe, path)
    _write_meta(behavior_id, version, feature_config_hash, metrics)   # model/<bid>/meta.json (authoritative)
    return pipe, version, metrics

def _version(behavior_id, rows, feature_config_hash, params):
    key = json.dumps({"b": behavior_id, "rows": sorted((v, f, y) for (v, f, y, _b) in rows),
                      "fc": feature_config_hash, "p": {k: str(v) for k, v in params.items()}},
                     sort_keys=True)
    return hashlib.sha256(key.encode()).hexdigest()[:16]

def grouped_eval(X, y, groups):
    pos_g = len(np.unique(groups[y == 1])); neg_g = len(np.unique(groups[y == 0]))
    if pos_g < 2 or neg_g < 2:
        return {"warning": "not enough labeled bouts per class", "n_pos_groups": pos_g, "n_neg_groups": neg_g}
    n_splits = min(5, pos_g, neg_g)
    cv = StratifiedGroupKFold(n_splits=n_splits, shuffle=True, random_state=0)
    proba = cross_val_predict(make_model(), X, y, groups=groups, cv=cv, method="predict_proba")[:, 1]
    pred = (proba >= 0.5).astype(int)
    p, r, f1, _ = precision_recall_fscore_support(y, pred, labels=[1], average="binary", zero_division=0)
    return {"precision": p, "recall": r, "f1": f1,
            "average_precision": average_precision_score(y, proba),
            "confusion": confusion_matrix(y, pred).tolist(),
            "n_pos_groups": pos_g, "n_neg_groups": neg_g, "n_splits": n_splits}
```

**Version key** includes `behavior_id` **and** `feature_config_hash`, so (a) two behaviors never
collide on a filename and (b) a feature-scheme change forces a new model file and marks predictions
stale. Model column order in `predict` output is **ascending `behavior_id`**.

**Two-phase predict (keeps the loop interactive):** on retrain of a behavior, `predict_proba` the
**visible timeline window first** (single-digit ms → instant overlay), then enqueue a **background,
chunked, cancellable** full-corpus job that streams into the prediction store. Cancel any in-flight
job for that behavior when a new retrain starts. Tag every batch with its model `version`.

**Latency budget:** feature compute once per video (off the interactive path); train ~10–100 ms (HGB,
few-thousand labeled rows); on-screen predict single-digit ms; full-corpus seconds–minutes,
backgrounded.

### 5.3 Prediction post-processing (per-frame proba → clean bouts)

JAABA's cheap 3-stage pipeline, all per-behavior sliders in the UI: **(1) smooth** (box or short
median filter) → **(2) hysteresis threshold** (enter where `p ≥ hi`, extend while `p ≥ lo`, discard
candidates that never reach `hi`) → **(3) min-bout-length + min-gap** (delete too-short bouts, merge
across sub-threshold gaps). HMM/Viterbi is a v2 option. Store predictions as
`predictions/<video_id>.parquet`: `frame:int32` + one **`float32`** column per behavior (column name
= behavior id). (Wire + on-disk dtype is committed `float32`; quantization is a possible later
optimization, not v0.)

---

## 6. Human-in-the-loop / active learning

Fuse JAABA's "label the errors" with A-SOiD's uncertainty sampling:

1. **Seed:** owner paints a few clear positive and negative ranges for a behavior.
2. **Train** that behavior → **score every frame** → overlay a **prediction heatstrip** under the
   timeline (green confident-positive, red confident-negative, **yellow band for p≈0.5**).
3. **Suggest frames by uncertainty:** rank unlabeled frames by margin `1 − |2p − 1|` (max at p=0.5).
   **Diversify** — at most one suggestion per contiguous uncertain run, round-robin across videos —
   else you get 20 identical wobble frames. Present each as a short clip (± context) with a one-click
   label.
4. **Correct confident errors** (JAABA's highest-value labels).
5. **Retrain + repeat.** Show running grouped-CV P/R/F1 so the owner knows when marginal value flattens.
6. **Ground-truthing mode (v1, honest eval):** a separate, **prediction-blind, randomly (or
   balanced-randomly) sampled** label set (`source='groundtruth'`) that **never trains** the model →
   a trustworthy confusion matrix. Keep strictly separate from the active-learning pool.

**Calibration:** skip in v0 (ranking needs only monotonic scores). Add
`CalibratedClassifierCV(method="isotonic", cv=<group-aware cv>)` in v1 when the overlay's numbers
must mean "70% ≈ 70% of the time."

---

## 7. Video & pose delivery (D5, sized for 108k-frame videos)

**Frames — server-side, exact, cached.** `GET /api/projects/{pid}/frame/{video_id}/{idx}.jpg` →
`image/jpeg` from an **LRU cache** keyed `(pid, video_id, idx)`, decode-on-miss via `sleap-io`
`video.backend.get_frame(idx)` with `keep_open=True` (decoder stays warm). Long `Cache-Control`
(immutable). `?gray=1` uses the grayscale path. Cannot preload 108k frames — rely on LRU + a
**client prefetch window** (prefetch `i+1..i+N` and a few behind into a ring; "play" is a
`requestAnimationFrame` loop swapping already-fetched `ImageBitmap`s at fps). Keep an *optional* HTML5
`<video>` range-stream mode for fast scrubbing, but **never trust its frame numbers at label time** —
snap to the server frame.

**Reencode caveat (frame-identity is sacred).** `sio reencode` (adds keyframes for fast seeks) is
**optional** and must be **frame-preserving**: before using a reencoded file, verify
`n_frames(reencoded) == pose.shape[0] == n_frames(original)`; **hard-fail on mismatch**. Default:
serve the **original**; only serve a reencoded copy when the 1:1 mapping is verified. The reencoded
file may live in the project dir (`media/`) and is referenced via `project.json.videos[].playback_path`
(distinct from `video_path`, which stays what the `.slp` points at) — this does not violate "never
copy the *original*."

**Poses — preload per open video as one binary blob.** `GET /api/projects/{pid}/poses/{video_id}` →
`application/octet-stream` little-endian `float32 [F,T,N,C]` + a tiny JSON header (shape + skeleton
nodes/edges). At D3 ~39 MB (2 animals) — fine to preload; overlay draw = zero-latency array slice.
**Fallback** for pathological videos: `?start=&end=` windowed fetches, same wire format. Do **not**
send poses as JSON.

**Overlay:** a `<canvas>` absolutely positioned over the frame `<img>`, sized to intrinsic W×H,
CSS-scaled; per frame change `clearRect` then draw skeleton edges + nodes, colored per track,
alpha-scaled by keypoint confidence (the `slp-viewer`/`event-annotator` pattern).

**Timeline / ethogram — `<canvas>`, not DOM** (108k cells kills DOM layout). Stacked tracks, x = frame
index (pan/zoom via offset+scale). Rows: one **label track per behavior** (painted half-open spans) +
a **prediction heatstrip** (per-frame proba as color/opacity) + playhead. **Downsample to ≤1 column
per device pixel** (max/mean-pool proba to canvas width) so draw cost is bounded by width, not frame
count. Cache each track to an offscreen canvas; re-render only on data/zoom change.

---

## 8. API surface (FastAPI, REST + one SSE stream) — everything project-scoped

**Scoping rule (normative):** the server is **stateless / no active-project**. **Every stateful
route is nested under `/api/projects/{pid}/…`.** Pydantic models for bodies/responses; binary where
it pays.

```
# Projects & videos
GET    /api/projects                                     list project dirs under root
POST   /api/projects                                     create {name} -> dir + manifest
GET    /api/projects/{pid}                               manifest (behaviors, videos, per-behavior model status)
POST   /api/projects/{pid}/videos                        add {video_path, slp_path?} -> {video_id, job_id?}
                                                          (slp_path optional; kicks off feature job if poses)
GET    /api/projects/{pid}/videos/{video_id}             {n_frames, fps, w, h, has_poses, features_status}

# Frames & poses
GET    /api/projects/{pid}/frame/{video_id}/{idx}.jpg    image/jpeg (LRU, immutable), ?gray=1
GET    /api/projects/{pid}/poses/{video_id}              octet-stream float32 [F,T,N,C] + header, ?start=&end=
GET    /api/projects/{pid}/skeleton/{video_id}           {nodes:[...], edges:[[i,j]...], roles:{...}}

# Behaviors (full CRUD; labels keyed by stable behavior_id survive rename/recolor)
GET    /api/projects/{pid}/behaviors
POST   /api/projects/{pid}/behaviors                     {name, color, key} -> {behavior_id}
PUT    /api/projects/{pid}/behaviors/{bid}               edit name/color/key/postproc (in place)
DELETE /api/projects/{pid}/behaviors/{bid}               cascade-deletes that behavior's label rows
                                                          (reject duplicate hotkeys at POST/PUT)

# Labels  (half-open [start,end); PUT overwrites, DELETE -> unlabeled)
GET    /api/projects/{pid}/labels/{video_id}[?behavior=bid]
PUT    /api/projects/{pid}/labels/{video_id}             [{behavior_id,start,end,value}]
DELETE /api/projects/{pid}/labels/{video_id}?behavior=bid&start=&end=

# Training & predictions  (PER BEHAVIOR)
POST   /api/projects/{pid}/behaviors/{bid}/train         -> {job_id}   (one behavior per job)
GET    /api/projects/{pid}/jobs/{job_id}/events          SSE progress (features OR train jobs)
GET    /api/projects/{pid}/jobs/{job_id}                 {kind, status, pct, metrics?}   (poll fallback)
GET    /api/projects/{pid}/behaviors/{bid}/model         {version, trained_at, cv_metrics, top_features?(v1)}
POST   /api/projects/{pid}/behaviors/{bid}/predict/{video_id}   (re)run inference for this behavior+video
GET    /api/projects/{pid}/predict/{video_id}            octet-stream float32 [F, n_behaviors] (asc behavior_id)
GET    /api/projects/{pid}/behaviors/{bid}/suggest/{video_id}?n=&strategy=   active-learning frame picks
```

`suggest` strategies: `uncertainty` (default), `random`, `sparse` (uniform coverage). `predict`/train
**refuse** a `video_id` whose `features_status != 'ready'` for the current `feature_config_hash`
(returns 409 with the pending `job_id`).

**Jobs = SSE**, not WebSocket. Both **feature-compute** and **training** are background jobs with the
same contract: the endpoint enqueues and returns `{job_id}`; a worker **thread** pushes
`{"pct","msg","behavior_id?"}` onto a `queue.Queue`; `…/jobs/{job_id}/events` drains it until a
terminal `done`/`error`. Single-user ⇒ one train job per behavior at a time; reject overlap with 409.
**Simplest fallback:** poll `…/jobs/{job_id}` (same model). Ship polling first if it saves time; SSE
is a non-breaking upgrade.

---

## 9. On-disk project format (a directory, inspectable, mostly re-derivable)

Original videos and `.slp` are **referenced by path, never copied**; a *reencoded playback copy* may
live in `media/` (§7). Everything else laras-labeler produces lives in the project dir. Re-opening =
read `project.json`, lazy-load the rest.

```
my-project/
├── project.json                      manifest — schema-versioned single source of truth (pointers/summaries)
├── media/<video_id>.mp4              OPTIONAL verified-frame-identical reencode for fast seeking
├── labels/<video_id>.parquet         ground truth (frame, behavior_id, value, source)   ← BACK THIS UP
├── poses/<video_id>.npz              OPTIONAL cache: float32 [F,T,N,C] + skeleton         (re-derivable)
├── features/<video_id>.npy           per-frame feature memmap (F, D)
├── features/<video_id>.meta.json     feature_names[D], D, feature_config_hash, slp_content_hash, fps, status
├── model/<behavior_id>/<version>.joblib     trained sklearn Pipeline (per behavior)
├── model/<behavior_id>/meta.json            AUTHORITATIVE per-behavior model metadata (version, cv metrics, hashes)
└── predictions/<video_id>.parquet    per-frame per-behavior float32 (column per behavior_id)
```

```jsonc
// project.json  (holds only pointers/summaries; per-model truth lives in model/<bid>/meta.json)
{
  "schema_version": 1,
  "name": "social-behavior-pilot",
  "created": "2026-07-01T10:00:00Z",
  "skeleton_roles": { "nose":"nose", "tail_base":"tail_base", "left_ear":"earL", "right_ear":"earR" },
  "feature_config": { "wradius_seconds": 0.5, "stats": ["mean","std","min","max","change"],
                      "radii_seconds": [0.07, 0.25, 0.5], "offsets": [0],
                      "pool_aggregates": ["min","mean","max"], "confidence_threshold": 0.0,
                      "per_slot": false, "feature_code_version": 1, "hash": "…" },
  "behaviors": [
    {"id": 0, "name": "grooming", "color": "#e15759", "key": "1",
     "postproc": {"smooth": 5, "hi": 0.6, "lo": 0.4, "min_bout": 10, "min_gap": 5},
     "model": {"version": "…", "trained_at": "…", "cv_f1": 0.87}}       // summary pointer only
  ],
  "videos": [
    {"video_id": "cam0", "video_path": "/data/exp/cam0.mp4", "playback_path": "media/cam0.mp4",
     "slp_path": "/data/exp/cam0.predictions.slp", "slp_content_hash": "…", "has_poses": true,
     "n_frames": 108000, "fps": 30.0, "width": 1280, "height": 1024,
     "features_status": "ready", "features_config_hash": "…"}
  ]
}
```

Formats: **JSON** manifest/meta; **parquet** for labels/predictions (columnar, read by
pandas/polars/duckdb for offline analysis); **npy memmap / npz** for feature/pose caches; **joblib**
for models. Only manual labels + behavior definitions are irreplaceable — `poses/`, `features/`,
`predictions/`, `media/` are caches you can delete and rebuild.

---

## 10. Project layout, packaging, launch (D7)

```
laras-labeler/
├── pyproject.toml            deps, [project.scripts], hatchling build
├── uv.lock                   committed
├── PLAN.md                   this file
├── README.md
└── src/laras_labeler/
    ├── __main__.py           python -m laras_labeler
    ├── cli.py                arg parse -> pick free port -> start uvicorn -> open browser when ready
    ├── app.py                FastAPI factory, StaticFiles mount, lifespan
    ├── config.py             host/port, projects root, cache sizes
    ├── models.py             Pydantic schemas
    ├── project.py            load/save project dir; video_id/hashing; manifest
    ├── video.py              VideoManager: sleap-io backends, LRU frame cache, reencode verify
    ├── poses.py              PoseStore: slp -> float32 arrays, range slices
    ├── features.py           skeleton roles, movement clean+kinematics, social, pool, window (§4)
    ├── jobs.py               background job runner (thread + queue), SSE event source
    ├── training.py           Trainer (per behavior) + grouped_eval
    ├── predict.py            Predictor (two-phase) + postproc (smooth/hysteresis) + suggest
    ├── routers/              projects, videos, frames, poses, labels, behaviors, jobs, training, predict
    └── web/                  index.html (inline CSS) + app.js + viewer.js + timeline.js
```
(`training` router serves train + model; `predict` router serves predict + suggest; `jobs` router
serves the shared SSE/poll endpoints.)

```toml
# pyproject.toml (essentials)
[project]
name = "laras-labeler"
requires-python = ">=3.11"
dependencies = [
  "fastapi>=0.115", "uvicorn[standard]>=0.30",
  "sleap-io>=0.8", "movement>=0.17",
  "scikit-learn>=1.5", "numpy>=1.26", "pandas>=2", "pyarrow>=17",
  "joblib>=1.4", "pydantic>=2",
]
# movement 0.17 forces xarray[accel,io,viz]; the `viz` extra pulls cartopy -> pyproj (needs the PROJ C
# lib; no Intel-macOS wheel) and fails to build. numba/llvmlite are NOT the blocker. Install movement's
# core WITHOUT viz — see §1 for the verified recipe (uv dependency overrides for cartopy/pyproj, or
# `movement --no-deps` + its runtime set). Verify movement imports on the target platform in CI.
[project.scripts]
laras-labeler = "laras_labeler.cli:main"
[tool.hatch.build.targets.wheel]
packages = ["src/laras_labeler"]   # ships web/* as package data
```

**Launch** (binds `127.0.0.1`; opens the browser only once the socket accepts):

```bash
uv run laras-labeler ~/laras-projects              # dev, from a clone
uv run laras-labeler ~/laras-projects --no-browser --reload
uv tool install .                                  # day-to-day
uvx --from git+https://github.com/…/laras-labeler laras-labeler ~/laras-projects   # zero-install
```

---

## 11. Frontend & UX (reuse from vibes repo)

**Reuse near-wholesale from `../event-annotator/index.html`** (crib by
`file:line`):
- Canvas video+overlay renderer: `renderFrame` (:542), `getVideoGeometry`/`constrainOffset`/
  `zoomToPoint` (:402), `drawPose` (:591), track colors `getTrackColor` (:248).
- Interaction: wheel-zoom (:692), drag-pan (:695), pinch/touch (:728), resize reflow
  `handleContainerResize` (:737), click-to-select-track by nearest centroid (:700).
- Ethogram timeline: `getTimelineRows` (:1048), `renderTimelineTracks` (:1077).
- Paint/erase bout algebra: `addSegment` (:888, auto-merge), `eraseSegments` (:895,
  contain/split/trim). **Adapt: store as per-frame labels (§3.2) with half-open `[start,end)` spans.**
- Keyboard scheme (:1189): `←/→` ±1 (Ctrl ±30), `Home/End`, `Space` play, `+/-` zoom, number keys
  select behavior, paint/erase keys, `Delete` remove, `Esc` cancel. Add **Ctrl+Z / Ctrl+Shift+Z**.
- Behavior-manager modal with live hotkey capture (:982); dark single-file house style.

**Undo/redo (v0a acceptance gate):** client-side **operation stack** of label mutations, each stored
as its inverse patch; Ctrl+Z/Ctrl+Shift+Z; flushed to the server as PUT/DELETE. **Session-only** —
the resulting *labels* persist across reload, the *history* does not. (No server-side undo journal in
v0.)

**Also useful:** `slp-viewer/` overlay pattern; `video-player/index.html` (frame-accurate WebCodecs
player) as a reference for a future client-side exact+smooth mode; `pose-subspace-analysis`
`computeFeatures` (:586) for JS feature intuition (real features run in Python).

**Discard from event-annotator:** single-video `frameIndex` (`videoIdx===0`, :379); positional
`trackIdx` identity; `loadVideo` wiping annotations (:417); export that omits poses.

**New UI panels (beyond event-annotator):** (1) prediction heatstrip row + confidence overlay; (2)
"Train <behavior>" button + live SSE progress + grouped-CV metrics (P/R/F1, confusion, PR curve, with
the "not enough labeled bouts per class" guard); (3) "Suggest frames" list (uncertainty picks) with
one-click label + jump; (4) per-behavior post-processing sliders (smooth / hi / lo / min-bout /
min-gap); (5) **feature-importance list — v1** (permutation importance, top-15, lazy; `top_features`
is optional in the model response until then).

---

## 12. Milestones & acceptance criteria

**Long-video fixture (build first for D3 testing):** concat the sample to ~108k frames, e.g.
`sio` / ffmpeg loop of `mice.mp4`, paired with a tiled/looped pose array of matching length, so
frame-serving and the memmap/streaming paths are exercised at real scale. (The 1410-frame sample
alone cannot exercise them.)

### v0 — Single video, full loop (D4). *Acceptance bar = reliable labeling.*

Sequence so the labeling milestone stands even if ML slips:

**v0a — Frame-accurate labeling on one video (the D4 milestone):**
- Launch `uv run laras-labeler`; create a project; add one video + its `.slp` (feature job kicks off).
- Backend serves exact frames (LRU + prefetch) and poses (binary blob); overlay renders skeleton.
- Scrub/step is frame-accurate; playback is smooth via prefetch.
- Paint pos/neg half-open ranges per behavior → stored as per-frame labels; erase/merge; **undo/redo**.
- Project **saves and re-opens** with labels intact.
- ✅ *Accept when:* labeling is smooth, frame-exact, and persists across restarts — on the mice sample
  **and** on the concatenated long-video fixture (frame-serving at 108k).

**v0b — Assistive loop on that same video:**
- Feature job completes → memmap cache with `features_status='ready'`.
- Train **one behavior** → grouped-CV metrics panel (with the per-class-groups guard).
- Two-phase predict → **prediction heatstrip** overlays the timeline; post-proc sliders.
- Uncertainty **suggest-frames** list with one-click label + jump.
- ✅ *Accept when:* label a few ranges → Train (<~2 s) → predictions appear and visibly improve after
  correcting a few suggested/erroneous frames. (Feature-importance panel is **out of scope** here.)

### v1 — Multi-video + honest eval + better active learning
Multi-video project (per-video caches, group-by-video CV), asymmetric window offsets (±1), JAABA
`relative`/`flip` transforms, diversity-aware uncertainty sampling (cluster-then-select),
**ground-truthing mode** (`source='groundtruth'`, prediction-blind sampling → trustworthy confusion
matrix), probability calibration, **feature-importance panel**, all inter-animal pairs, label import
(JAABA/BORIS/SimBA/CSV).

### v2 — Power features
`harmonic`/`hist` window stats; A-SOiD-style unsupervised discovery proposing sub-behaviors from
uncertain clusters; HMM/Viterbi smoothing; **per-animal attribution mode** (D1 extension: enable
per-slot features + per-animal label/timeline rows); LightGBM/XGBoost backend; write labels back to
`.slp` (`Instance.from_numpy` on matching `LabeledFrame`).

---

## 13. Risks & mitigations

| Risk | Mitigation |
|---|---|
| `movement` build failure on Intel macOS — real blocker is **pyproj** (via `xarray[viz]`→cartopy), NOT numba/llvmlite | Install movement core WITHOUT viz: `movement --no-deps` + its runtime deps, or uv dependency overrides for cartopy/pyproj; commit `uv.lock`; CI-test a clean install on the target platform (§1). |
| Whole-frame vs per-animal (D1) wrong | Feature layer computes per-animal vectors before pooling; extension is additive (§0, §4.4, v2). Confirm with owner before v1. |
| Frame serving too slow at 108k | Verified-identical `sio reencode` for keyframes; LRU + client prefetch ring; optional HTML5 range-stream fast-scrub. |
| Reencode drops/reorders frames → overlay desync | Verify `n_frames(reencoded)==pose.shape[0]==n_frames(original)`; hard-fail on mismatch; default to serving the original. |
| Validation leakage (adjacent frames) | Grouped CV by bout → by video; per-class-group guard refuses to report under-powered estimates. |
| Feature memory at scale (~380 MB/video × many) | memmap on disk, lazy per-video load, never fully in RAM; predictions/labels stay tiny. |
| Feature-dimension mismatch across videos | v0 pooled-only ⇒ `D` = f(feature_config), animal-count-invariant; per-slot off by default and gated on equal `n_tracks`. |
| Stale caches / silent wrong model | `feature_config_hash`+`slp_content_hash` in feature meta; `feature_config_hash` in model version; mismatch → recompute/retrain, mark predictions stale. |
| Two behaviors overwrite one model | Per-behavior paths `model/<bid>/<version>`; version includes `behavior_id`. |
| Uncertainty sampling returns 20 identical frames | Diversify: one pick per uncertain run, round-robin across videos. |
| Video with no/partial `.slp` | `slp_path` optional; `has_poses` flag; labeling-only mode; all-NaN feature rows kept; excluded from training corpus. |
| SLEAP confidence exceeds 1.0 | Don't assume [0,1]; v0 default `confidence_threshold=0.0` (keep all); tune per dataset. |
| Feature compute blocks add-video HTTP | Background job + `features_status`; train/predict gate on `ready`. |
| `.slp` re-tracked → labels drift | Labels are frame+behavior (not per-animal-slot) so they survive re-tracking; `slp_content_hash` warns on change. |

---

## 14. Reference — verified APIs & sources

- **sleap-io 0.8.0:** `Labels.numpy(video=None, untracked=False, return_confidence=False,
  user_instances=True)` → `(F,T,N,3)`; `video.backend.get_frame(i)` → `uint8 HxWxC`;
  `labels.find(video, frame_idx)`; write via `labels.save(".slp")` / `Instance.from_numpy`.
  Docs: https://io.sleap.ai/ · `sio --help` (show/export/convert/render/embed/merge/reencode/trim).
- **movement 0.17.0:** `movement.io.load_poses.from_numpy(position(F,C,N,T), confidence(F,N,T), …)`;
  `movement.filtering.{filter_by_confidence, interpolate_over_time, rolling_filter, savgol_filter}`;
  `movement.kinematics.{compute_velocity, compute_speed, compute_acceleration, compute_forward_vector,
  compute_pairwise_distances(data, dim='individual'|'keypoint', pairs=…), compute_turning_angle,
  compute_path_*}`  (`pairs` is REQUIRED, e.g. `'all'`; `dim='individual'` returns a per-pair/keypoint
  cross DataArray, not a scalar — `.sel(keypoint=…)` first);
  `movement.utils.vector.compute_signed_angle_2d`; `movement.roi`.
  Docs: https://movement.neuroinformatics.dev/
- **scikit-learn:** `HistGradientBoostingClassifier` (NaN-native, `class_weight='balanced'` since
  1.2), `StratifiedGroupKFold`, `cross_val_predict(method='predict_proba')`, `permutation_importance`,
  `CalibratedClassifierCV`.
- **Prior art:** JAABA (Kabra et al. 2013, Nat Methods; WindowFeatureComputation / Training /
  GroundTruthing pages), MARS (PMC8631946), SimBA feature catalog, A-SOiD (Nat Methods 2024;
  uncertainty-driven active learning), B-SOiD (compact 3-family features + temporal binning).
  Explicitly **not** DeepEthogram-style pixel end-to-end (GPU, many labels, kills interactivity +
  interpretability).
- **Web:** FastAPI + StaticFiles + SSE; PEP 723 vs packaged (chose packaged); rVFC frame-accuracy
  caveats (why server-side frames win for labeling).

---

*End of plan. Build the long-video fixture, then v0a → v0b on the mice sample, then generalize to
multi-video (v1). Every "how exactly…?" a fresh session hits should be answered by §3.3 (contracts),
§4 (features/`D`), §5 (per-behavior models), §8 (project-scoped API), or §9 (on-disk) — if not, that's
a doc bug worth fixing before coding.*
