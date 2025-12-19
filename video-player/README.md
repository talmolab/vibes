# Frame-Accurate Video Player

**Live:** https://v.tlab.sh/video-player/

Browser-based video player with frame-accurate seeking, zoom/pan, and efficient caching using WebCodecs API.

## Features

- **Frame-accurate seeking** - Navigate videos frame-by-frame with no frame drops using WebCodecs decoder
- **On-demand decoding** - Chunked file reading with intelligent sliding cache for instant playback of large videos
- **Zoom and pan** - Interactive zoom with mouse wheel and pan with click-drag
- **Keyboard shortcuts** - Rapid navigation with arrow keys and spacebar playback control
- **URL and local file support** - Load videos from local files (File System Access API) or remote URLs with streaming support
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

## Dependencies (CDN)

- [mp4box.js@0.5.2](https://github.com/gpac/mp4box.js) - MP4 demuxing and sample extraction

## Technical Details

Uses the WebCodecs API for hardware-accelerated video decoding with chunked file reading to avoid loading entire videos into memory. Implements a sliding LRU cache with intelligent prefetching based on access patterns. Supports both local files (via File System Access API with fallback to file input) and remote URLs (with range request streaming when available).

## Initial prompt

The initial prompt for this vibe was not recorded. This README was reconstructed based on the implementation.
