# Multiview 3D

**Live:** https://vibes.tlab.sh/multiview-3d/

Synchronized multi-view pose visualization with DLT triangulation and interactive 3D skeleton rendering. Load a multi-camera session directory containing SLEAP annotations (.slp), videos (.mp4), and calibration data (.toml) to view synchronized 2D poses across camera views alongside a triangulated 3D skeleton.

## Features

- Load multi-view session directories (each camera subdirectory with .mp4 + .slp files)
- Parse SLEAP `.slp` files via [sleap-io.js](https://github.com/talmolab/sleap-io.js) for skeleton and pose data
- Synchronized video playback across all camera views
- 2D skeleton overlay on each camera view with color-coded edges
- DLT (Direct Linear Transform) triangulation from 2D keypoints to 3D
- Three.js 3D viewer with:
  - Triangulated 3D skeleton with edges and nodes
  - Camera frustum visualization showing camera positions/orientations
  - OrbitControls for interactive rotation, zoom, and pan
- TOML calibration file parsing (intrinsics + extrinsics)
- Frame navigation: prev/next, slider, keyboard shortcuts (Left/Right arrows, Space)
- URL parameter support for auto-loading sessions

## Usage

### Directory Picker
1. Click "Load Session" and select a session directory with structure:
   ```
   session/
   ├── cam1/
   │   ├── video.mp4
   │   └── annotations.slp
   ├── cam2/
   │   ├── video.mp4
   │   └── annotations.slp
   └── calibration.toml
   ```

### URL Parameters
Load a session automatically via query parameters:
```
?session=<base-url>&cameras=back,mid,top&toml=calibration.toml
```

### Keyboard Shortcuts
- **Left/Right arrows**: Previous/next frame
- **Space**: Play/pause

## Technical Notes

- Uses [`@talmolab/sleap-io.js`](https://github.com/talmolab/sleap-io.js) v0.1.9 for SLP parsing
- DLT triangulation ported from [sleap-3d](https://github.com/talmolab/sleap-3d) (Jacobi eigensolver for SVD)
- Camera calibration: Rodrigues rotation vectors, 3x3 intrinsic matrices, distortion coefficients
- Three.js v0.164.0 for 3D visualization with OrbitControls
- HTML5 `<video>` elements for synchronized video decoding

## Initial prompt

```
start a new branch and use sleap-io.js (see https://iojs.sleap.ai/usage.md) to render multiview videos that i can triangulate. use the fixtures in `/Users/joshuapark/code/sleap-3d/tests/fixtures/data/minimal_session`. use playwright mcp for testing. this is just a 3D visualizer with sync'd multiview data that also has calibration. refer to `calibration-studio` for some of the practices and interface design, but use the `sleap-io.js` library for parsing and video decoding stuff. port in the triangulation code and also add a three.js based visualizer in addition to the sync'd 2D views.
```
