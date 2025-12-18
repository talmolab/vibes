# Calibration Studio

Browser-based multi-camera calibration tool using ChArUco boards.

## Features

- **Multi-view video loading** - Synchronized playback of calibration videos from multiple cameras using WebCodecs + mp4box.js
- **ChArUco detection** - Real-time board detection with configurable parameters using OpenCV.js
- **Intrinsic calibration** - Per-camera calibration with reprojection error visualization
- **Extrinsic calibration** - Multi-camera pose estimation via covisibility graph
- **Cross-view triangulation** - 3D point reconstruction using DLT (svd-js)
- **Export** - TOML format compatible with sleap-anipose, JSON for bundle adjustment

## Usage

1. Click **Load Test Data** to load sample calibration videos, or use **Load Custom Folder** to select your own
2. Configure board parameters (dimensions, square/marker size, dictionary)
3. Run **Batch Detection** to detect ChArUco corners across frames
4. **Compute Intrinsics** to calibrate each camera
5. **Compute Extrinsics** to determine camera poses relative to a reference
6. **Export** results as TOML or JSON

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| ← / → | ±1 frame |
| ↑ / ↓ | ±10 frames |
| Space | Play/Pause |
| [ / ] | Navigate reprojection frames |
| + / - | Zoom all videos |
| 0 | Reset zoom |
| Scroll | Zoom individual video |
| Double-click | Reset video zoom |

## File Structure

```
calibration-studio/
├── index.html        # Main UI and application logic
├── video.js          # OnDemandVideoDecoder (WebCodecs + mp4box.js)
├── calibration.js    # Detection, calibration, and math utilities
└── sample_session/   # Test calibration videos
    ├── board.toml    # Board configuration
    ├── back.mp4      # Back camera view
    ├── mid.mp4       # Mid camera view
    ├── side.mp4      # Side camera view
    └── top.mp4       # Top camera view
```

## Dependencies (CDN)

- [mp4box.js](https://github.com/nickreading/nickreading.github.io/tree/master/nickreading.github.io-main/nickreading.github.io-main/mp4box.js-main) - MP4 demuxing
- [OpenCV.js](https://docs.opencv.org/4.x/opencv.js) - Computer vision (ArUco/ChArUco detection)
- [svd-js](https://www.npmjs.com/package/svd-js) - SVD for DLT triangulation

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
