# SLP Skeleton Viewer

**Live:** https://vibes.tlab.sh/slp-skeleton/

Interactive viewer for exploring skeleton structure from SLEAP `.slp` files. Load an SLP file from URL or local file and visualize the skeleton with interactive node/edge inspection.

## Features

- Load SLP files from URL (with lazy/streaming support) or local file
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

- Uses h5wasm via a Web Worker for HDF5 parsing
- Detects embedded video in `videoN/video` HDF5 datasets
- Supports PNG and JPEG encoded frames
- Frame extraction uses range requests for efficient streaming

## Known Issues

- `@talmolab/sleap-io.js` streaming mode has a bug where skeleton nodes aren't populated ([issue #26](https://github.com/talmolab/sleap-io.js/issues/26))
- Currently using direct h5wasm parsing as a workaround

## Initial prompt

```
create a new vibe called `slp-skeleton` that works similarly to `slp-viewer/` and `h5ls/` but uses `@talmolab/sleap-io.js` (see `../sleap-io.js/docs/` for usage reference) to show a SLP file from URL (lazy/streaming) and overlays the skeleton on the image with text labels for each node, selectable nodes and edges, and a widget on the right that shows all the info about the skeleton: nodes, edges, symmetries, indices, colors that correspond to the edge colors on viewer, and hovering on either table rows or the correspondng nodes or edges in the viewer will highlight both.
```
