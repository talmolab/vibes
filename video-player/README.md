# Frame-Accurate Video Player

**Live:** https://vibes.tlab.sh/video-player/

Browser-based video player with frame-accurate seeking, zoom/pan, and efficient caching using WebCodecs API.

## Features

- **Frame-accurate seeking** - Navigate videos frame-by-frame with no frame drops using WebCodecs decoder
- **On-demand decoding** - Chunked file reading with intelligent sliding cache for instant playback of large videos
- **Zoom and pan** - Interactive zoom with mouse wheel (zooms toward cursor) and pan with click-drag, with bounds to prevent losing the video
- **Keyboard shortcuts** - Rapid navigation with arrow keys and spacebar playback control
- **URL and local file support** - Load videos from local files (File System Access API) or remote URLs with streaming support
- **Overlay system** - Optional frame index and timing stats overlays with toggle controls
- **Cache visualization** - Real-time view of cached frames and keyframe locations
- **Diagnostic logging** - Detailed performance metrics and debug information

## Usage

1. Click **Load Video File** to select a local video, or **Load from URL** to stream a remote video
2. Use keyboard shortcuts to navigate frames
3. Scroll to zoom in/out on the video
4. Click and drag to pan around zoomed video
5. Click **Play** or press Space to start/stop playback
6. Adjust **Cache Size** and **Lookahead** parameters to tune performance
7. Click on the frame cache visualization bar to jump to specific frames

## Keyboard Shortcuts

| Key          | Action       |
| ------------ | ------------ |
| ← / →        | ±1 frame     |
| ↑ / ↓        | ±10 frames   |
| Ctrl+← / →   | ±30 frames   |
| Ctrl+↑ / ↓   | ±100 frames  |
| Space        | Play/Pause   |
| Mouse Wheel  | Zoom         |
| Click + Drag | Pan          |

## Performance

- **Streaming support** - Videos with range request support stream efficiently without downloading the entire file
- **Intelligent prefetching** - Automatically prefetches frames in the current navigation direction
- **Configurable cache** - Adjust cache size (10-500 frames) and lookahead (1-100 frames) based on your needs
- **Keyframe-aware decoding** - Minimizes unnecessary decoding by respecting keyframe boundaries

## URL Loading Requirements

When loading videos from a URL:

- **CORS** - The server must include `Access-Control-Allow-Origin` headers. GitHub Pages, S3, GCS, and most CDNs support this.
- **Range requests** - For efficient streaming, the server should support HTTP range requests (`Accept-Ranges: bytes`). Without range request support, the entire file must be downloaded before playback begins. GitHub Pages supports range requests.

## Dependencies (CDN)

- [mp4box.js@0.5.2](https://github.com/gpac/mp4box.js) - MP4 demuxing and sample extraction

## Technical Details

Uses the WebCodecs API for hardware-accelerated video decoding with chunked file reading to avoid loading entire videos into memory. Implements a sliding LRU cache with intelligent prefetching based on access patterns. Supports both local files (via File System Access API with fallback to file input) and remote URLs (with range request streaming when available).

### B-Frame Handling

Videos encoded with B-frames (bidirectional predicted frames) require special handling because:

1. **Decode order ≠ presentation order**: mp4box.js returns samples sorted by DTS (decode time), but frames must be displayed in CTS (composition/presentation time) order
2. **Inter-frame dependencies**: B-frames depend on both past AND future reference frames (I-frames and P-frames)

The decoder addresses this by:

1. **Sorting samples by CTS** on load so `samples[N]` = presentation frame N
2. **Preserving `decodeIndex`** to track original decode order for each sample
3. **Feeding decoder in decode order** by sorting selected samples by `decodeIndex` before decoding
4. **Including ALL decode indices** in the range to ensure no reference frames are skipped (fixes blocky artifact bug)
5. **Mapping output by timestamp** to route decoded frames back to correct presentation indices

### Decode Index Gap Fix

When decoding a range of presentation frames, the code must include ALL samples whose decode indices fall within the required range - not just samples whose presentation indices are in the target range. Without this, reference frames (P-frames) that B-frames depend on may be skipped, causing blocky gray artifacts from incomplete inter-frame prediction.

## Initial prompt

The initial prompt for this vibe was not recorded. This README was reconstructed based on the implementation.
