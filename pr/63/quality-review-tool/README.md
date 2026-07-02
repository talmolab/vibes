# Quality Review Tool

Browser-based batch review tool for pose quality scan results, with embedded SLP proofreading.

**Live:** https://vibes.tlab.sh/quality-review-tool/

**Solves**: Manually inspecting thousands of labeled frames to find labeling errors. Instead, automatically flag geometric anomalies across your entire dataset and review only the files that need attention.

## Pipeline Overview

```
scan_slp_quality()  →  quality_manifest.json  →  Quality Review Tool  →  SLEAP GUI
    (Python)              (flagged files)         (browser review)       (fix labels)
```

1. **Scan** — Run quality checks on all `.slp` files in a directory
2. **Review** — Load the manifest in this tool to triage flagged files
3. **Proofread** — Open flagged files in the embedded [SLP Viewer](../slp-viewer/), jumping to problem frames

## Step 1: Scan

The scanning backend is provided by the [`vibing`](https://github.com/LeoMeow123/vibes) Python package. Install it first:

```bash
pip install vibing[sleap]
```

Then run `scan_slp_quality()` to batch-check all `.slp` files in a directory:

```python
from vibing.pose import scan_slp_quality

# Basic — uses default thresholds
manifest = scan_slp_quality("/path/to/slp/files")
# Writes quality_manifest.json to the same directory

# Custom config
from vibing.pose import QualityConfig
config = QualityConfig(
    spatial_outlier_factor=3.0,   # more lenient spatial check
    temporal_jump_factor=2.0,     # more lenient jump check
    min_valid_keypoints=5,        # require at least 5 visible keypoints
)
manifest = scan_slp_quality("/path/to/slp/files", config=config)
```

The manifest is a JSON file listing every scanned file with its quality recommendation (`GOOD`, `REVIEW`, or `POOR`), per-flag frame counts, and flagged frame indices.

See the [vibing documentation](https://github.com/LeoMeow123/vibes) for full API details and additional configuration options.

## Step 2: Review

1. Open the [Quality Review Tool](https://vibes.tlab.sh/quality-review-tool/) in your browser
2. Click **Load Manifest** and select the `quality_manifest.json` file
3. Summary cards show counts of GOOD / REVIEW / POOR / ERROR files
4. Filter by recommendation category using the toggle buttons
5. Search by filename
6. Sort by any column (click column headers)
7. Expand a row to see per-flag breakdown with flagged frame indices

## Step 3: Proofread

1. Click **Open Data Folder** and select the folder containing your `.slp` and video files
2. Click **Proofread** on any row to open that file in the embedded SLP viewer
3. The viewer loads the `.slp` file and matched video, jumping to the first flagged frame
4. Flagged frames are marked on the timeline
5. Use **Shift+Arrow** keys to jump between flagged frames in the viewer

The tool auto-matches `.slp` files to videos by stripping the `.preds.*` suffix (e.g., `Day1_15666_Trial3.preds.slp` matches `Day1_15666_Trial3.mp4`).

## Quality Checks

The scanner runs 7 anomaly checks on each file, all scale-invariant (thresholds are relative to the animal's own median body length):

| Flag | Level | Description |
|------|-------|-------------|
| `spatial_outlier` | Keypoint | Keypoint far from centroid of other keypoints |
| `temporal_jump` | Keypoint | Keypoint jumped unreasonably between consecutive frames |
| `body_too_long` | Frame | Snout-to-tailbase distance exceeds upper threshold |
| `body_too_short` | Frame | Snout-to-tailbase distance below lower threshold |
| `hull_area_anomaly` | Frame | Convex hull area outside expected range |
| `aspect_ratio_anomaly` | Frame | Bounding-box aspect ratio too extreme |
| `insufficient_keypoints` | Frame | Fewer than `min_valid_keypoints` visible keypoints |

## Configuration

All spatial thresholds are multiples of the animal's median body length, making them work across camera setups without tuning.

| Parameter | Default | Description |
|-----------|---------|-------------|
| `spatial_outlier_factor` | 2.0 | Flag keypoint if distance from centroid > factor × median body length |
| `temporal_jump_factor` | 1.5 | Flag keypoint if frame-to-frame jump > factor × median body length |
| `min_body_length_factor` | 0.3 | Flag frame if body length < factor × median |
| `max_body_length_factor` | 2.5 | Flag frame if body length > factor × median |
| `hull_area_min_factor` | 0.2 | Flag frame if hull area < factor × median area |
| `hull_area_max_factor` | 3.0 | Flag frame if hull area > factor × median area |
| `aspect_ratio_max` | 5.0 | Flag frame if bounding-box aspect ratio exceeds this |
| `min_valid_keypoints` | 3 | Minimum finite keypoints required per frame |

## Recommendations

Files are classified based on the fraction of frames with any anomaly flag:

| Label | Flagged fraction | Meaning |
|-------|-----------------|---------|
| **GOOD** | < 1% | Tracking looks clean |
| **REVIEW** | 1% – 5% | Some issues worth checking |
| **POOR** | >= 5% | Significant problems — likely needs relabeling |

## Controls

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Shift+←` / `Shift+→` | Jump to previous/next flagged frame (in proofreading mode) |
| `←` / `→` | ±1 frame (in SLP viewer) |
| `Ctrl+←` / `Ctrl+→` | ±30 frames (in SLP viewer) |
| `Space` | Play/Pause (in SLP viewer) |

### Mouse

- **Click column headers** to sort the file table
- **Click a row** to expand/collapse per-flag details
- **Click Proofread** to open a file in the embedded SLP viewer

## Browser Support

- Chrome / Edge ✅ (full support including File System Access API for folder picker)
- Firefox ⚠️ (manifest review works; folder picker uses `webkitdirectory` fallback)
- Safari ⚠️ (manifest review works; limited folder access)

## Files

| File | Description |
|------|-------------|
| `index.html` | Self-contained application — no build steps, no dependencies |

## Dependencies

- [SLP Viewer](../slp-viewer/) — Embedded for proofreading (loaded via iframe)
- [`vibing`](https://github.com/LeoMeow123/vibes) — Python package for generating `quality_manifest.json` (install separately)
