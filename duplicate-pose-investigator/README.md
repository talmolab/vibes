# Duplicate Pose Investigator

**Live:** https://vibes.tlab.sh/duplicate-pose-investigator/

Browser-based tool for identifying and labeling duplicate pose detections in SLEAP tracking data. Analyze overlapping pose pairs using multiple metrics and evaluate threshold-based classification rules.

## Features

- **Multi-metric analysis** - Compute IOU (bounding box overlap), centroid distance, and bounding box centroid distance for all overlapping pose pairs
- **Interactive histograms** - Visualize metric distributions with clickable bars to sample pose pairs from specific ranges
- **Frame-accurate video playback** - View pose pairs overlaid on video frames using WebCodecs API
- **Pose annotation** - Label pairs as duplicate or not duplicate with keyboard shortcuts
- **Threshold evaluation** - Define classification rules (e.g., "IOU < 0.3 means not duplicate") and compute precision/accuracy
- **Real-time precision/accuracy plot** - Scatter plot updates as you add labels, showing performance of different threshold rules
- **Relabeling support** - Review and change labels after completing a range

## Usage

1. Click **Load Video** to select a video file (MP4, MOV, WebM)
2. Click **Load Poses** to select a SLEAP file (.slp or .h5)
3. Click **Compute Metrics** to analyze all overlapping pose pairs
4. Click on histogram bars to sample pairs from that metric range
5. Label each pair as **Duplicate** or **Not Duplicate** using buttons or keyboard
6. Add threshold rules to evaluate classification performance
7. Export labels as JSON when done

## Controls

| Input | Action |
| ----- | ------ |
| D | Mark as Duplicate |
| N | Mark as Not Duplicate |
| S | Skip current pair |

## Threshold Evaluation

For each metric, you can define a threshold rule:
- Select operator: `<`, `<=`, `>`, `>=`
- Enter threshold value
- Click **Add** to compute precision and accuracy

The rule defines when a pair is predicted as "not duplicate". For example:
- "IOU < 0.3" predicts pairs with low overlap are not duplicates
- "Centroid Distance > 50" predicts pairs with distant centroids are not duplicates

The precision/accuracy plot shows how well each rule performs against your ground truth labels.

## Dependencies (CDN)

- [Chart.js](https://www.chartjs.org/) - Histogram and scatter plot visualization
- [mp4box.js@0.5.2](https://github.com/gpac/mp4box.js) - MP4 demuxing
- [h5wasm@0.7.5](https://github.com/usnistgov/h5wasm) - HDF5/SLEAP file reading

## Technical Details

Uses WebCodecs API for frame-accurate video decoding with on-demand frame fetching. SLEAP files are parsed using h5wasm with support for both analysis format (tracks array) and native format (frames/instances/pred_points). Metrics are computed for all track pairs that have bounding box overlap (IOU > 0).

## Initial prompt

Create a tool for investigating duplicate pose detections in SLEAP tracking data. Should load video and .slp files, compute overlap metrics between pose pairs, display histograms of metrics, allow labeling pairs as duplicate/not duplicate, and evaluate threshold-based classification rules with precision/accuracy visualization.
