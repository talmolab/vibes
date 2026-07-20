# vibes.tlab.sh

[![GitHub](https://img.shields.io/badge/GitHub-talmolab%2Fvibes-blue?logo=github)](https://github.com/talmolab/vibes)

Self-contained HTML tools and applets for the web.

## Vibes

- [Hello World](hello-world/) <a href="hello-world/README" class="readme-badge">[README]</a><br><span class="vibe-desc">A simple greeting to test the setup</span>
- [Idle Quest](idle-quest/) <a href="idle-quest/README" class="readme-badge">[README]</a><br><span class="vibe-desc">An idle RPG with combat, upgrades, zones, and prestige</span>
- [GitHub Discussion to Markdown](github-discussion-markdown/) <a href="github-discussion-markdown/README" class="readme-badge">[README]</a><br><span class="vibe-desc">Convert GitHub discussions to structured markdown</span>
- [Webcam Pose Tracking](webcam-pose-tracking/) <a href="webcam-pose-tracking/README" class="readme-badge">[README]</a><br><span class="vibe-desc">Real-time body pose estimation using MediaPipe</span>
- [Pose Subspace Analysis](pose-subspace-analysis/) <a href="pose-subspace-analysis/README" class="readme-badge">[README]</a><br><span class="vibe-desc">Interactive keypoint subspace construction using PCA</span>
- [Pose Subspace Trip](pose-subspace-trip/) <a href="pose-subspace-trip/README" class="readme-badge">[README]</a><br><span class="vibe-desc">Drive trippy 3D visualizations (pose constellation or ray-marched fractal) with your body via a pose-driven PCA subspace</span>
- [Frame-Accurate Video Player](video-player/) <a href="video-player/README" class="readme-badge">[README]</a><br><span class="vibe-desc">Local video player with frame-accurate seeking, zoom/pan, and playback controls</span>
- [h5ls](h5ls/) <a href="h5ls/README" class="readme-badge">[README]</a><br><span class="vibe-desc">HDF5/SLP file explorer using h5wasm with streaming support</span>
- [Label ROI](labelroi/) <a href="labelroi/README" class="readme-badge">[README]</a><br><span class="vibe-desc">Video ROI annotation tool with zoom/pan, hover highlighting, and YAML export</span>
- [Calibration Studio](calibration-studio/) <a href="calibration-studio/README" class="readme-badge">[README]</a><br><span class="vibe-desc">Multi-camera calibration tool with ChArUco detection, intrinsic/extrinsic calibration, and TOML export</span>
- [Link Unfurl Preview](link-unfurl/) <a href="link-unfurl/README" class="readme-badge">[README]</a><br><span class="vibe-desc">Preview how links appear when shared on social media</span>
- [Video Event Annotator](event-annotator/) <a href="event-annotator/README" class="readme-badge">[README]</a><br><span class="vibe-desc">Frame-accurate event segment annotation with multi-track timeline</span>
- [SLP Viewer](slp-viewer/) <a href="slp-viewer/README" class="readme-badge">[README]</a><br><span class="vibe-desc">SLEAP pose visualization with video overlay, embedded pkg.slp support, track colors, and shareable links</span>
- [Pixel Scale Tool](pixel-scale-tool/) <a href="pixel-scale-tool/README" class="readme-badge">[README]</a><br><span class="vibe-desc">Convert pixel measurements to real-world units using reference points</span>
- [SLP Skeleton](slp-skeleton/) <a href="slp-skeleton/README" class="readme-badge">[README]</a><br><span class="vibe-desc">Interactive skeleton structure viewer for SLEAP .slp files with node/edge inspection</span>
- [Quality Review](quality-review-tool/) <a href="quality-review-tool/README" class="readme-badge">[README]</a><br><span class="vibe-desc">Batch pose quality scanner results viewer with embedded SLP proofreading</span>
- [GitHub Stats](gh-stats/) <a href="gh-stats/README" class="readme-badge">[README]</a><br><span class="vibe-desc">Contribution stats dashboard with commits, LOC, PRs, and activity heatmap</span>
- [PyPI Name Checker](pypi-name-checker/) <a href="pypi-name-checker/README" class="readme-badge">[README]</a><br><span class="vibe-desc">Check Python package name availability with suggestions</span>
- [CORS Check](cors-check/) <a href="cors-check/README" class="readme-badge">[README]</a><br><span class="vibe-desc">Test URL CORS status and get the right fetch code</span>
- [SLEAP Config Picker](sleap-config-picker/)<br><span class="vibe-desc">Interactive sleap-nn training config generator with SLP file analysis</span>
- [Video Info Tool](video-info-tool/)<br><span class="vibe-desc">Quick video metadata extraction (FPS, resolution, duration, frame count)</span>
- [SLEAP-NN Metrics](sleap-nn-metrics/)<br><span class="vibe-desc">Visualize and compare SLEAP-NN evaluation metrics with interactive charts</span>
- [SAM3 Segmenter](sam3-segmenter/) <a href="sam3-segmenter/README" class="readme-badge">[README]</a><br><span class="vibe-desc">Interactive video segmentation using SAM3 with click prompting, tracking, and SLP export</span>
- [GPU Dashboard](gpu-dashboard/) <a href="gpu-dashboard/README" class="readme-badge">[README]</a><br><span class="vibe-desc">Monitor GPUs across multiple workstations with real-time stats and inference progress tracking</span>
- [Lab Camera Planner](lab-camera-planner/) <a href="lab-camera-planner/README" class="readme-badge">[README]</a><br><span class="vibe-desc">Plan lab camera setups with FOV calculator, specs comparison, and recommendation wizard</span>
- [Salk Email Signature](salk-signature/) <a href="salk-signature/README" class="readme-badge">[README]</a><br><span class="vibe-desc">Build a branded Salk email signature from reorderable, typed lines with live preview and one-click rich-HTML copy for Outlook, Apple Mail, and Gmail</span>
- [Encoding Helper](encoding-helper/) <a href="encoding-helper/README" class="readme-badge">[README]</a><br><span class="vibe-desc">Didactic in-browser video encoding lab: MP4 atom map, GOP/keyframe analysis, seeking tests, and H.264 re-encoding with a live ffmpeg CLI command builder</span>
- [Clip Extractor](clip-extractor/) <a href="clip-extractor/README" class="readme-badge">[README]</a><br><span class="vibe-desc">Load a video (URL or local) ± a SLEAP .slp, select an in/out range, extract it as an MP4 clip (ffmpeg.wasm) or frame images with SLP-free annotation JSON, and package it for a backend POST</span>
- [MDR Labeller](mdr-labeller/) <a href="mdr-labeller/README" class="readme-badge">[README]</a><br><span class="vibe-desc">Severance/Lumon "Macrodata Refinement"-styled behavior labeller: hover clip tiles to play, drag them into ethogram bins to label (local Python-backed tool, not a hosted page)</span>

## About

Each "vibe" is a self-contained HTML application with inline CSS and JavaScript. No build steps, no frameworks - just HTML that works.

Inspired by [simonw/tools](https://github.com/simonw/tools) and the [vibe coding](https://simonwillison.net/2025/Dec/10/html-tools/) philosophy.

A [Talmo Lab](https://talmolab.org) project.

## Contributing

Want to create a new vibe? See [CONTRIBUTING.md](https://github.com/talmolab/vibes/blob/main/CONTRIBUTING.md) for development setup and guidelines.

## License

BSD-3
