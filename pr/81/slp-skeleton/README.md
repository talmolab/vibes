# SLP Skeleton Viewer

**Live:** https://vibes.tlab.sh/slp-skeleton/

Interactive viewer for exploring skeleton structure from SLEAP `.slp` files. Load an SLP file from URL or local file and visualize the skeleton with interactive node/edge inspection.

## Features

- Load SLP files from URL (with streaming via HTTP range requests) or local file
- Renders skeleton overlay on pose coordinates
- **Embedded image support** - displays frame images underneath skeleton (for `.pkg.slp` files)
- Interactive node and edge highlighting (hover/click on viewer or table)
- Color-coded edges matching the viewer display
- Tabs for Nodes, Edges, and Symmetries
- Frame navigation with image caching
- URL state persistence for shareable links
- "Images" badge indicator when embedded video data is detected

## Usage

1. Enter an SLP file URL or click "Open File" to load a local `.slp` file
2. The skeleton will be displayed with the pose from the first labeled frame
3. If embedded images are available, the frame will render underneath the skeleton
4. Hover over nodes/edges in the viewer or table to highlight them
5. Click to select and keep highlighted
6. Use the tabs to view different skeleton properties
7. Navigate frames with the slider to see different poses

## Technical Notes

- Uses [`@talmolab/sleap-io.js`](https://github.com/talmolab/sleap-io.js) v0.1.8 for SLP parsing
- Automatic Web Worker for HDF5 operations (keeps main thread responsive)
- HTTP range requests for efficient streaming (downloads only needed data)
- Supports PNG and JPEG encoded embedded frames
- O(1) frame lookup with BGR channel handling

## Changelog

### v0.1.9
- URL state persistence for frame index and zoom/pan (`frame`, `zoom`, `panX`, `panY` params)
- Skeleton renders immediately while image loads (no waiting for slow network)
- CSS-animated loading spinner indicator
- Fixed race condition when loading from URL with frame param

### v0.1.8
- Nodes, edges, and labels stay constant size when zooming
- Fixed pan constraints to allow panning in all directions

### v0.1.7
- Added zoom and pan controls (mouse wheel, drag, pinch-to-zoom)
- Reset View button (R key shortcut)

## Initial prompt

```
create a new vibe called `slp-skeleton` that works similarly to `slp-viewer/` and `h5ls/` but uses `@talmolab/sleap-io.js` (see `../sleap-io.js/docs/` for usage reference) to show a SLP file from URL (lazy/streaming) and overlays the skeleton on the image with text labels for each node, selectable nodes and edges, and a widget on the right that shows all the info about the skeleton: nodes, edges, symmetries, indices, colors that correspond to the edge colors on viewer, and hovering on either table rows or the correspondng nodes or edges in the viewer will highlight both.
```
