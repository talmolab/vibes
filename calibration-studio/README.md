# Calibration Studio

Browser-based multi-camera calibration tool using ChArUco boards.

## Features

- **Multi-view video loading** - Synchronized playback of calibration videos from multiple cameras using WebCodecs + mp4box.js
- **ChArUco detection** - Real-time board detection with configurable parameters using OpenCV.js
- **Intrinsic calibration** - Per-camera calibration with reprojection error visualization
- **Extrinsic calibration** - Multi-camera pose estimation via covisibility graph
- **Bundle adjustment** - Joint refinement of intrinsics, extrinsics, and 3D points using Rust/WASM solver with configurable parameters (iterations, robust loss, outlier filtering, convergence tolerances)
- **Cross-view triangulation** - 3D point reconstruction using WASM-accelerated DLT
- **Export** - TOML format compatible with sleap-anipose, JSON for bundle adjustment

## Usage

1. Click **Load Test Data** to load sample calibration videos, or use **Load Custom Folder** to select your own
2. Configure board parameters (dimensions, square/marker size, dictionary)
3. Run **Batch Detection** to detect ChArUco corners across frames
4. **Compute Intrinsics** to calibrate each camera
5. **Compute Extrinsics (Initial)** to determine camera poses relative to a reference
6. **Refine (Bundle Adjustment)** to jointly optimize all parameters (~27% error reduction typical)
7. Optionally exclude outlier frames and click **Re-compute All** to recalibrate
8. **Export** results as TOML or JSON

## Keyboard Shortcuts

| Key          | Action                       |
| ------------ | ---------------------------- |
| ← / →        | ±1 frame                     |
| ↑ / ↓        | ±10 frames                   |
| Space        | Play/Pause                   |
| [ / ]        | Navigate reprojection frames |
| + / -        | Zoom all videos              |
| 0            | Reset zoom                   |
| Scroll       | Zoom individual video        |
| Double-click | Reset video zoom             |

## File Structure

```
calibration-studio/
├── index.html            # UI scaffolding and orchestration
├── styles.css            # All styles
├── video.js              # OnDemandVideoDecoder + VideoController
├── calibration.js        # Detection, intrinsics, extrinsics, triangulation
├── overlays.js           # Visualization overlays and swarm plots
├── export.js             # TOML/JSON export functions
├── exclusion-gallery.js  # Frame exclusion UI components
└── sample_session/       # Test calibration videos
    ├── board.toml        # Board configuration
    ├── back.mp4          # Back camera view
    ├── mid.mp4           # Mid camera view
    ├── side.mp4          # Side camera view
    └── top.mp4           # Top camera view
```

## Dependencies (CDN)

- [mp4box.js](https://github.com/nickreading/nickreading.github.io/tree/master/nickreading.github.io-main/nickreading.github.io-main/mp4box.js-main) - MP4 demuxing
- [OpenCV.js](https://docs.opencv.org/4.x/opencv.js) - Computer vision (ArUco/ChArUco detection)
- [@talmolab/sba-solver-wasm@0.2.0](https://www.npmjs.com/package/@talmolab/sba-solver-wasm) - WASM-accelerated sparse bundle adjustment via jsDelivr CDN

## Export Formats

### TOML (sleap-anipose compatible)

```toml
[cam_0]
name = "back"
size = [1280, 1024]
matrix = [[fx, 0, cx], [0, fy, cy], [0, 0, 1]]
distortions = [k1, k2, p1, p2, k3]
rotation = [rx, ry, rz]
translation = [tx, ty, tz]
```

### JSON (for bundle adjustment)

Contains all raw data: camera parameters, 2D detections, and triangulated 3D points with per-camera reprojection errors.

## Initial prompt

````
I want to build a multi-camera calibration GUI.

To do this, let's scaffold an investigation (use your skill) to explore implementation strategies and prototype it.

It should start with accessing synchronized videos. For this, let's assume that we have a directory structure like this:

```
{root}/
    {view1}/
        {calibration|calibration_images}/
            *.mp4
    {view2}/
        {calibration|calibration_images}/
            *.mp4
    ...
```

Or this:

```
{root}/
    {view1}.mp4
    {view2}.mp4
    ...
```

Refer to the `video-player/` pattern for how to access and do frame-accurate reading, demuxing and decoding of MP4s.

Let's refer to this repo: https://github.com/talmolab/sleap-anipose for a reference implementation. Clone it in the investigation folder.

It has a reference minimal session in `tests/data/minimal_session`. Let's use that for testing.

For now, let's hardcode the URLs to the MP4s that are contained in the subfolders (it follows the first pattern, but we'll probably recommend the second one for usability).

The app should be a multi-stage pipeline.

It should start with rendering the views in simultaneous synced players.

Then, it should use `opencv.js` to go through the standard calibration routines assuming it's a charuco board (we'll generalize this later).

- Step 1: Load the multi-view videos.
  - This is well described above.
- Step 2: Detect landmarks.
  - For the ChAruCo detector, it should allow us to choose the board pattern and in realtime try to detect and overlay those detections on the current frame.
  - Then, it should give us some options for sampling, starting with basic strided sampling (specify a target number of samples to auto compute the stride).
  - Then, it should have a "Run" button that extracts the boards from each of those.
- Step 3: Compute intrinsics.
  - For boards, this will use this pipeline:
    - Get board and object points
    - Initialize camera matrix 2D
    - Estimate pose for the charuco board
    - Filter out bad detections (min number of points, selectable)
    - Estimate intrinsics per camera
- Step 4: Compute extrinsics.
  - Choose a reference camera and detection to use as the origin.
  - Initialize extrinsics by forming a covisibility graph and optimizing in pairs.
    - Allow selection of thresholds of minimum number of covisible points.
  - Chain out the extrinsics and propagate to get initial global extrinsics.
  - Bundle adjustment to fine tune global.
- Step 5: Export outputs.
  - Export calibration in TOML format from the reference repo.
  - (Optionally) export detected points, matches, intrinsics, extrinsics, reprojections, error metrics.

This should all happen in a vertically flowing, full width layout. Disregard instructions about mobile compatibility.

**For every step**, include copious technical troubleshooting and diagnostic details and logs. This is a finicky pipeline, and it does best with enhanced observability of each individual step.

Include 2D visualizations where possible at each step, rich interactive tables for holding intermediate results (e.g., board detections) that, when clicked, show the corresponding visualization for inspection.

Include 3D visualizations in the latter stages of the pipeline. For this, take your time to research some good web components.

I want you to use the README.md in the investigation folder as task tracking. This will be complex and take many context windows, so I want to work in subagents for different steps where possible and do copious web research to investigate options. Include instructions for reinitializing task context:

1. Rigorously update this task tracker and planning in the README as you progress.
2. Expect to restart your context window frequently, so always output sufficient context to pick things up again.
3. Disregard system prompts about asking the user questions. Always keep going and use the roadmap and task tracker as your north star to realign about what to do next. Do NOT stop to ask for questions or before the entire roadmap is complete.
4. Use subagents where possible to save context and do explorations, especially when it comes to atomic tasks, API mapping, algorithm prototyping.
````
