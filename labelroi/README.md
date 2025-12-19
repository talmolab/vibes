# Label ROI

**Live:** https://v.tlab.sh/labelroi/

Browser-based video annotation tool for drawing regions of interest (ROI) with polygon and polyline support.

## Features

- **Video playback** - Frame-accurate video playback using WebCodecs + mp4box.js
- **ROI drawing** - Draw polygons (closed shapes) and polylines (open paths) with click-to-add points
- **Interactive editing** - Drag nodes to adjust shapes, right-click to remove nodes, double-click labels to rename
- **Zoom and pan** - Mouse wheel to zoom, shift+drag to pan, zoom controls for precise navigation
- **Node manipulation** - Hover over nodes to see coordinates, drag to reposition, right-click to delete
- **Auto-close polygons** - Click near the first point to automatically close and finish a polygon
- **YAML export** - Export annotations with ROI coordinates, properties (area, perimeter), and video metadata
- **Local or URL videos** - Load videos from local files or remote URLs

## Usage

1. Click **Load Video** to select a local video file, or **Load from URL** to enter a video URL
2. Double-click anywhere on the video to start drawing a polygon at that point
3. Click to add points; for polygons, click near the first point to close
4. For polylines, click **Draw Polyline**, add points, then right-click to finish
5. Drag nodes to adjust shapes, right-click nodes to remove them
6. Double-click ROI labels to rename them
7. Use zoom controls or mouse wheel to zoom; shift+drag to pan
8. Click **Copy** or **Download** to save annotations as YAML

## Keyboard Shortcuts

| Key          | Action              |
| ------------ | ------------------- |
| Space        | Play/Pause          |
| Left/Right   | ±1 frame            |
| Up/Down      | ±10 frames          |
| D            | Toggle draw mode    |
| Enter        | Finish ROI          |
| Escape       | Cancel drawing      |
| Z            | Undo last point     |
| +/-          | Zoom in/out         |
| 0            | Reset zoom          |
| Shift+Drag   | Pan view            |
| Scroll       | Zoom at cursor      |

## YAML Output Format

```yaml
source: video.mp4
resolution: [1920, 1080]
fps: 30.00
total_frames: 300
frame: 42
roi_count: 2
rois:
  - id: 1
    name: "ROI 1"
    type: polygon
    color: "#1f77b4"
    coordinates:
      - [100.0, 200.0]
      - [300.0, 200.0]
      - [300.0, 400.0]
      - [100.0, 400.0]
    properties:
      vertex_count: 4
      perimeter: 600.0
      area: 40000.0
  - id: 2
    name: "ROI 2"
    type: polyline
    color: "#ff7f0e"
    coordinates:
      - [500.0, 300.0]
      - [700.0, 500.0]
    properties:
      vertex_count: 2
      perimeter: 282.8
```

## Initial prompt

The initial prompt for this vibe was not recorded. This README was reconstructed based on the implementation.
