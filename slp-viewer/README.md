# SLP Viewer

Browser-based viewer for [SLEAP](https://sleap.ai) pose predictions overlaid on video. Load an SLP file and its corresponding video to visualize pose data directly in your browser.

**Live:** https://vibes.tlab.sh/slp-viewer/

## Features

- **Frame-accurate video playback** via WebCodecs API with intelligent caching
- **SLEAP file parsing** using h5wasm (Web Worker for non-blocking loading)
- **Pose overlay rendering** with track-based coloring and configurable display
- **Zoom/pan support** with mouse wheel, drag, and touch gestures
- **Stutter-free playback** via OffscreenCanvas architecture (98% stutter reduction)
- **URL streaming** with HTTP range requests for large videos
- **Shareable links** with URL state encoding for SLP and video files
- **Responsive design** with resizable canvas and mobile-friendly controls

## Architecture

### Video Playback (OffscreenCanvas Mode)

The video player uses a worker-based architecture for smooth playback:

```
┌─────────────────────────────────────────────────────────────────┐
│  MAIN THREAD                                                     │
│  ┌──────────────────┐  ┌──────────────────┐                     │
│  │ Video Canvas     │  │ Overlay Canvas   │ ← Skeleton rendering│
│  │ (transferred to  │  │ (poses, UI)      │                     │
│  │  worker)         │  │                  │                     │
│  └────────┬─────────┘  └──────────────────┘                     │
│           │ Commands: play, pause, seek, setTransform           │
│           ▼                                                      │
├──────────────────────────────────────────────────────────────────┤
│  WORKER (video-offscreen-worker.js)                              │
│  - Owns OffscreenCanvas (via transferControlToOffscreen)        │
│  - MP4 parsing (mp4box.js) + WebCodecs VideoDecoder             │
│  - Array-based frame cache (120 frames, 25% faster than Map)    │
│  - requestAnimationFrame loop                                    │
│  - NO ImageBitmap transfers during playback                     │
└──────────────────────────────────────────────────────────────────┘
```

### SLP Parsing

SLEAP `.slp` files are HDF5 format. We use [h5wasm](https://github.com/usnistgov/h5wasm) in a Web Worker to parse them without blocking the UI:

- Extracts skeleton structure (nodes, edges)
- Reads frame and instance data
- Builds efficient frame-indexed lookup for overlay rendering

## Files

| File | Description |
|------|-------------|
| `index.html` | Main application with UI and overlay rendering |
| `video-player.js` | VideoPlayer class with OffscreenCanvas support |
| `video-offscreen-worker.js` | Worker that owns canvas, decoding, and rendering |
| `slp-worker.js` | Web Worker for parsing SLEAP HDF5 files |
| `mice.mp4` | Demo video (1410 frames @ 47fps) |
| `mice.tracked.slp` | Demo SLEAP predictions |

## Performance

Extensive profiling revealed that ImageBitmap transfers from worker to main thread were blocking browser rAF scheduling. The OffscreenCanvas approach eliminates this by having the worker own and render to the canvas directly.

| Approach | Stutters per 500 frames | Rate |
|----------|------------------------|------|
| Baseline (worker transfers) | ~20 | 4.0% |
| OffscreenCanvas mode | ~0.25 | 0.05% |

Other optimizations:
- **Batched sample reading** groups contiguous samples into single HTTP requests (62+ requests → 1)
- **Read time improvement:** 89ms → 4ms (22x faster)
- **Pending frame queue** eliminates decode lock contention during rapid seeking
- **Background prefetch** proactively decodes frames before cache runs out

## Controls

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `←` / `→` | ±1 frame |
| `Ctrl+←` / `Ctrl+→` | ±30 frames |
| `Home` / `End` | First/Last frame |
| `Space` | Play/Pause |
| `P` | Toggle poses |

### Mouse/Touch

- **Mouse wheel:** Zoom towards cursor
- **Click + drag:** Pan
- **Pinch:** Zoom (touch devices)
- **Single finger drag:** Pan (touch devices)

## Browser Support

- Chrome 69+ ✅
- Firefox 105+ ✅
- Safari 16.4+ ⚠️ (partial OffscreenCanvas support)
- Falls back to main-thread rendering on older browsers

## Usage

1. Click "Load Demo" to try with sample data, or
2. Click "Load SLP File" to select your SLEAP predictions file
3. Click "Load Video" to select the corresponding video
4. Use the seekbar and keyboard shortcuts to navigate
5. Adjust overlay settings (node size, edge width, toggles)

## Shareable Links

When loading files from URLs (including the demo), the browser URL is updated with query parameters:

```
?slp=<encoded-slp-url>&video=<encoded-video-url>
```

This URL can be shared and will auto-load the files when visited. Example demo link:

```
https://vibes.tlab.sh/slp-viewer/?slp=https%3A%2F%2Fvibes.tlab.sh%2Fslp-viewer%2Fmice.tracked.slp&video=https%3A%2F%2Fvibes.tlab.sh%2Fslp-viewer%2Fmice.mp4
```

Note: Local files cannot be shared via URL (the URL params are cleared when loading local files).

## Dependencies

All loaded via CDN:
- [mp4box.js](https://github.com/nickreese/nickreese-mp4box.js) - MP4 demuxing
- [h5wasm](https://github.com/usnistgov/h5wasm) - HDF5 parsing
