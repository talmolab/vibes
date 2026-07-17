# Clip Extractor

**Live:** https://vibes.tlab.sh/clip-extractor/

A single-file video player built on [sleap-io.js](https://github.com/talmolab/sleap-io) for **selecting a frame range and extracting it as an upload-ready payload**. Load a video from a remote URL or a local file, optionally attach a SLEAP `.slp`, scrub to an in/out range, then extract the clip with [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) and package it — together with SLP-free annotation JSON — for a `POST` to a backend REST API.

## Features

- **Load anything sleap-io.js can open**
  - Remote video URL (streamed via `MediaBunnyVideoBackend.fromUrl`, with a full-download fallback)
  - Local file via the File System Access picker (`showOpenFilePicker`), a file input, or drag-and-drop
  - Optional SLEAP `.slp` (remote URL or local), loaded with `loadSlp({ openVideos: false })`
- **Frame-accurate player** — play/pause, step, scrub, speed control, and a B-frame decode→display reorder (from `getFrameTimes`) so playback never jumps backwards. Keyboard: `Space` play/pause, `←/→` step (`Shift` = ±10), `I`/`O` set in/out.
- **Pose overlay** — skeleton edges + nodes drawn per track when a `.slp` is loaded.
- **Two extraction outputs (selectable)**
  - **MP4 clip** via ffmpeg.wasm — *precise* (frame-exact `trim` filter, re-encoded) or *fast* (keyframe-aligned stream copy). The live `ffmpeg` command is shown.
  - **Frame images** — each frame in the range decoded to PNG or JPEG (optionally with the pose overlay burned in).
- **SLP-free annotation JSON** — the selected range's labels are re-indexed **clip-relative** (`clip_frame` 0..N alongside `source_frame`) and emitted as a self-describing `sleap-clip-annotations/v1` document with skeleton, tracks, and per-instance points. No SLP dependency on the backend.
- **Two payload packagings (selectable)** — `multipart/form-data` (clip/frames + `annotations.json` + `metadata.json` parts) or a single `application/json` body with base64-embedded media. A **dry-run preview** shows the exact request; **Send** POSTs to a configurable endpoint with optional custom headers; **Download** saves the payload locally.

## Usage

1. Load a video (URL, **Open file…**, drag-drop, or **Load sample (mice)**), and optionally a `.slp`.
2. Scrub and press **[ Set In** / **Set Out ]** (or `I` / `O`) to mark the clip range.
3. In **Extract**, pick *MP4 clip* or *Frame images* and press **Extract selection**. (First MP4 extraction downloads the ~30 MB ffmpeg.wasm core, cached thereafter.)
4. In **Transmit**, choose a packaging, **Preview request** (dry run), then **Send POST** to your endpoint or **Download payload**.

URL params: `?url=<video>&slp=<labels>` auto-load on open.

## Notes

- The backend upload protocol is intentionally **TBD** — the tool builds and previews the request and can POST to any endpoint you provide. Cross-origin sends require the backend to allow CORS.
- Remote video/SLP URLs must be CORS-accessible (or served from a `*.tlab.sh` origin via the [nocors](https://github.com/talmolab/nocors) proxy).
- ffmpeg.wasm is GPL-licensed and lazy-loaded only when an MP4 clip is extracted.

## Initial prompt

> let's start a /new-vibe in a new PR. use sleap-io.js extensively (look at the other open PR and other vibes that have video players -- though careful, some of them are out of date). make a video player that supports both remote web endpoints + local file system access api reading (this is all handled by sleap-io.js) and is optimized for selecting a clip that we will extract with ffmpeg wasm (see PR 67 and related issue) to transmit to a ember backend (details on the handoff TBD). right now it should just be able to pull up a video, optionally with an SLP file (also sleap-io.js) and pull out the frames (+ annotations, encoded out as json for payload transmission, no SLP dependency), and get it ready for transmission to a POST request to a REST API backend (again, protocol TBD) for upload

Follow-ups locked the name (`clip-extractor`), both extraction outputs (MP4 clip + frame images), and both payload formats (multipart + JSON/base64) with a dry-run preview.
