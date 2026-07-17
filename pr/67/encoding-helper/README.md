# Encoding Helper

**Live:** https://vibes.tlab.sh/encoding-helper/

A didactic, in-browser video **encoding lab**. Load an MP4 and it inspects the container, teaches you how MP4 storage and H.264 encoding actually work (tied to the numbers in *your* file), runs empirical seeking tests, and re-encodes video directly in the browser — while always producing a copy-paste `ffmpeg` command for local/headless/batch use.

Companion to [Video Info Tool](https://vibes.tlab.sh/video-info-tool/) and [Frame-Accurate Video Player](https://vibes.tlab.sh/video-player/).

## Features

- **Inspect** - rich metadata plus a visual MP4 **atom map** (`ftyp`/`moov`/`mdat`/`moof`, byte offsets & sizes, moov-before-mdat "faststart" detection) and per-frame GOP/I-frame/B-frame structure
- **Identify the codec** - infers the codec family from the container (H.264/AVC, H.265/HEVC, VP8/VP9, AV1, AAC, Opus, FLAC, MP3, AC-3/E-AC-3, PCM) and decodes its embedded profile/level/tier straight out of the RFC 6381 codec string, with a short explainer on what that codec actually is and why you'd (not) choose it
- **Teach** - interactive explanations tied to the loaded file: CRF vs. bitrate, x264 presets, GOP/keyframe interval, I/P/B frames, `yuv420p` chroma subsampling, even-dimension requirements, and the moov-atom/faststart tradeoff
- **Measure** - empirical seeking tests (nearest-keyframe distance per timestamp, decode wall-clock, keyframe-interval histogram) with a scatter plot of distance vs. decode time, plus before/after compression stats
- **Re-encode** - H.264/MP4 directly in the browser, saved back to disk via the File System Access API, with two engines:
  - **ffmpeg.wasm (exact)** - runs the literal CRF/preset command, byte-for-byte equivalent to the CLI, lazy-loaded (~30 MB), GPL
  - **mediabunny / WebCodecs (fast)** - hardware-accelerated, no CRF (bitrate/quality-preset only), surfaced honestly as an approximation
- **Encode Test (A/B)** - encodes just a short window (1-10s) of the video at the chosen CRF/preset, then decodes the original and the result side-by-side with synchronized pixel-level zoom & pan, one-click **Fit**/**Actual Size (100%)** buttons, a pixel grid that appears once zoomed in far enough to make individual pixels visible, and a scrub slider — so you can judge a quality setting before committing to a full re-encode
- **Always emits a CLI command** - a live, editable `ffmpeg` command mirroring [sleap-io](https://github.com/talmolab/sleap-io)'s `reencode`, for anyone who wants to run it locally, headless, or in batch
- **Report / Export** - compiles metadata, the codec explainer, the atom map, GOP/keyframe stats, the seeking test and Encode Test results (if run), and the CLI command into one report — copy as Markdown, download a `.md` file, or print to PDF via the browser's native print dialog

## Usage

1. Load a video via drag-and-drop, the file picker, or **Load Sample** (bundled `mice.mp4`)
2. Explore the **Inspect** tab for metadata, the codec explainer, the atom map, and GOP/frame structure
3. Run the **Seeking Test** to measure nearest-keyframe distance and decode latency across the timeline (and see it plotted)
4. Tune CRF, preset, keyframe interval, B-frames, faststart, and audio handling in the **Re-encode** tab
5. Copy the generated `ffmpeg` command, or click **Encode (exact)** / **Encode (fast)** to transcode in-browser and save the result
6. Try different CRF/preset values on a short clip in the **Encode Test** tab and compare against the original side-by-side before running the full encode
7. Head to the **Report** tab to copy/download a Markdown summary of everything above, or print it to PDF

## Dependencies (CDN)

- [mediabunny@1.50.8](https://github.com/Vanilagy/mediabunny) - metadata, packet/GOP analysis, frame seeking, WebCodecs-based fast re-encode
- [mp4box.js@0.5.2](https://github.com/gpac/mp4box.js) - MP4 atom map and sample table (keyframes/GOP/B-frames)
- [@ffmpeg/ffmpeg@0.12.15](https://github.com/ffmpegwasm/ffmpeg.wasm) + `@ffmpeg/core@0.12.10` - exact in-browser re-encode (lazy-loaded on demand; `@ffmpeg/util`'s helpers are reimplemented locally since its UMD build throws when loaded via a plain `<script>` tag)

## Notes

- GitHub Pages serves no custom headers, so only the **single-thread** ffmpeg.wasm core is used (no COOP/COEP, no `coi-serviceworker`) - this keeps the tool a single self-contained page at the cost of some encode speed
- WebCodecs exposes no CRF control, only target bitrate/quality presets - the "fast" engine cannot byte-match the CLI command, and the UI says so
- Firefox's H.264 WebCodecs *encoder* support is weak; the fast engine feature-detects and falls back to ffmpeg.wasm/CLI-only
- ffmpeg.wasm is GPL-licensed; credited in the footer

## Initial prompt

> New vibe: encoding-helper — didactic in-browser video encoding lab (inspect, teach, seek-test, reencode). See [GitHub issue #66](https://github.com/talmolab/vibes/issues/66) for the full spec, motivated by the BBQS Day 3 working session on video → behavioral annotation pipelines (Acquisition and QC tracks), with sleap-io's `reencode` as the shared transcoding baseline this tool makes legible.
