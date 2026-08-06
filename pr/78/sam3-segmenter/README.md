# SAM3 Segmenter

**https://vibes.tlab.sh/sam3-segmenter/**

Interactive video segmentation using SAM3 (Segment Anything 3) with click prompting, multi-object tracking, and SLP export.

## Features

- Click positive (left-click) / negative (right-click) points to segment objects per frame
- IoU-based tracker for propagating masks across frames with configurable bbox/centroid prompting
- Multi-object support with track management (create, rename, delete, color-coded)
- Export segmentation masks to SLP format via sleap-io.js (SegmentationMask with RLE encoding)
- Settings: model quantization, mask opacity, track buffer, IoU threshold, tracker toggle
- Zoom/pan, keyboard shortcuts, dark theme, responsive layout

## Dependencies

- `@huggingface/transformers@4.0.0-next.8` — SAM3 model inference (WebGPU/WASM)
- `@talmolab/sleap-io.js@0.2.3` — video I/O, SLP export

## Initial prompt

Build an interactive video segmentation tool using SAM3 (Segment Anything 3) via Transformers.js. Users click on video frames to prompt the model with positive/negative points, preview segmentation masks in real-time, confirm masks to tracks, and propagate masks across frames using a lightweight IoU-based tracker. Support multi-object tracking with color-coded tracks, and export results to SLP format using sleap-io.js.
