# vibes.tlab.sh

[![GitHub](https://img.shields.io/badge/GitHub-talmolab%2Fvibes-blue?logo=github)](https://github.com/talmolab/vibes)

Self-contained HTML tools and applets for the web.

## Vibes

- [Hello World](hello-world/) - A simple greeting to test the setup
- [Idle Quest](idle-quest/) - An idle RPG with combat, upgrades, zones, and prestige
- [GitHub Discussion to Markdown](github-discussion-markdown/) - Convert GitHub discussions to structured markdown
- [Webcam Pose Tracking](webcam-pose-tracking/) - Real-time body pose estimation using MediaPipe
- [Pose Subspace Analysis](pose-subspace-analysis/) - Interactive keypoint subspace construction using PCA
- [Pose Subspace Trip](pose-subspace-trip/) - Drive trippy 3D visualizations (pose constellation or ray-marched fractal) with your body via a pose-driven PCA subspace
- [Frame-Accurate Video Player](video-player/) - Local video player with frame-accurate seeking, zoom/pan, and playback controls
- [h5ls](h5ls/) - HDF5/SLP file explorer using h5wasm with streaming support
- [Label ROI](labelroi/) - Video ROI annotation tool with zoom/pan, hover highlighting, and YAML export
- [Calibration Studio](calibration-studio/) - Multi-camera calibration tool with ChArUco detection, intrinsic/extrinsic calibration, and TOML export
- [Link Unfurl Preview](link-unfurl/) - Preview how links appear when shared on social media
- [Video Event Annotator](event-annotator/) - Frame-accurate event segment annotation with multi-track timeline
- [SLP Viewer](slp-viewer/) - SLEAP pose visualization with video overlay, embedded pkg.slp support, track colors, and shareable links
- [Pixel Scale Tool](pixel-scale-tool/) - Convert pixel measurements to real-world units using reference points
- [SLP Skeleton](slp-skeleton/) - Interactive skeleton structure viewer for SLEAP .slp files with node/edge inspection
- [Quality Review](quality-review-tool/) - Batch pose quality scanner results viewer with embedded SLP proofreading
- [GitHub Stats](gh-stats/) - Contribution stats dashboard with commits, LOC, PRs, and activity heatmap
- [PyPI Name Checker](pypi-name-checker/) - Check Python package name availability with suggestions
- [CORS Check](cors-check/) - Test URL CORS status and get the right fetch code
- [SLEAP Config Picker](sleap-config-picker/) - Interactive sleap-nn training config generator with SLP file analysis
- [Video Info Tool](video-info-tool/) - Quick video metadata extraction (FPS, resolution, duration, frame count)
- [SLEAP-NN Metrics](sleap-nn-metrics/) - Visualize and compare SLEAP-NN evaluation metrics with interactive charts
- [SAM3 Segmenter](sam3-segmenter/) - Interactive video segmentation using SAM3 with click prompting, tracking, and SLP export
- [GPU Dashboard](gpu-dashboard/) - Monitor GPUs across multiple workstations with real-time stats and inference progress tracking
- [Lab Camera Planner](lab-camera-planner/) - Plan lab camera setups with FOV calculator, specs comparison, and recommendation wizard
- [Salk Email Signature](salk-signature/) - Build a branded Salk email signature from reorderable, typed lines with live preview and one-click rich-HTML copy for Outlook, Apple Mail, and Gmail
- [Encoding Helper](encoding-helper/) - Didactic in-browser video encoding lab: MP4 atom map, GOP/keyframe analysis, seeking tests, and H.264 re-encoding with a live ffmpeg CLI command builder
- [Clip Extractor](clip-extractor/) - Load a video (URL or local) ± a SLEAP .slp, select an in/out range, extract it as an MP4 clip (ffmpeg.wasm) or frame images with SLP-free annotation JSON, and package it for a backend POST
- [MDR Labeller](mdr-labeller/) - Severance/Lumon "Macrodata Refinement"-styled behavior labeller: hover clip tiles to play, drag them into ethogram bins to label (local Python-backed tool, not a hosted page)

## About

Each "vibe" is a self-contained HTML application with inline CSS and JavaScript. No build steps, no frameworks - just HTML that works.

Inspired by [simonw/tools](https://github.com/simonw/tools) and the [vibe coding](https://simonwillison.net/2025/Dec/10/html-tools/) philosophy.

A [Talmo Lab](https://talmolab.org) project.

## Contributing

Want to create a new vibe? See [CONTRIBUTING.md](https://github.com/talmolab/vibes/blob/main/CONTRIBUTING.md) for development setup and guidelines.

## License

BSD-3
