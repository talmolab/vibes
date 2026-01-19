# SLP Skeleton Viewer

**Live:** https://vibes.tlab.sh/slp-skeleton/

Interactive viewer for exploring skeleton structure from SLEAP `.slp` files. Load an SLP file from URL or local file and visualize the skeleton with interactive node/edge inspection.

## Features

- Load SLP files from URL (with lazy/streaming support) or local file
- Renders skeleton overlay on pose coordinates from the first instance
- Interactive node and edge highlighting (hover/click on viewer or table)
- Color-coded edges matching the viewer display
- Tabs for Nodes, Edges, and Symmetries
- Frame navigation to browse different poses
- URL state persistence for shareable links

## Usage

1. Enter an SLP file URL or click "Open File" to load a local `.slp` file
2. The skeleton will be displayed with the pose from the first labeled frame
3. Hover over nodes/edges in the viewer or table to highlight them
4. Click to select and keep highlighted
5. Use the tabs to view different skeleton properties
6. Navigate frames with the slider to see different poses

## Initial prompt

```
create a new vibe called `slp-skeleton` that works similarly to `slp-viewer/` and `h5ls/` but uses `@talmolab/sleap-io.js` (see `../sleap-io.js/docs/` for usage reference) to show a SLP file from URL (lazy/streaming) and overlays the skeleton on the image with text labels for each node, selectable nodes and edges, and a widget on the right that shows all the info about the skeleton: nodes, edges, symmetries, indices, colors that correspond to the edge colors on viewer, and hovering on either table rows or the correspondng nodes or edges in the viewer will highlight both.
```

Note: Due to `@talmolab/sleap-io.js` not being browser-bundleable without a build step (has Node.js dependencies), the implementation uses h5wasm directly via a Web Worker, similar to the existing `slp-viewer` and `h5ls` vibes.
