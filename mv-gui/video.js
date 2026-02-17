/**
 * video.js - Video decoding and multi-view playback for mv-gui
 *
 * OnDemandVideoDecoder: Frame-accurate WebCodecs decoder with LRU cache and mp4box.js demuxing.
 * VideoController: Synchronized multi-view playback controller with overlay support.
 *
 * Dependencies: mp4box.all.min.js (MP4Box)
 */

// ---------------------------------------------------------------------------
// Logging helper
// ---------------------------------------------------------------------------
function videoLog(msg, level) {
    level = level || "log";
    if (typeof window !== "undefined" && window.logMessage) {
        window.logMessage("[video] " + msg, level);
    } else {
        if (level === "error") {
            console.error("[video] " + msg);
        } else if (level === "warn") {
            console.warn("[video] " + msg);
        } else {
            console.log("[video] " + msg);
        }
    }
}

// ---------------------------------------------------------------------------
// OnDemandVideoDecoder
// ---------------------------------------------------------------------------
class OnDemandVideoDecoder {
    constructor(options = {}) {
        this.cacheSize = options.cacheSize || 30;
        this.lookahead = options.lookahead || 5;
        this.cache = new Map();
        this.samples = [];
        this.keyframeIndices = [];
        this.decoder = null;
        this.config = null;
        this.videoTrack = null;
        this.mp4boxFile = null;
        this.url = null;
        this.fileSize = 0;
        this.supportsRangeRequests = false;
        this.isDecoding = false;
        this.pendingFrame = null;
        this.CHUNK_SIZE = 1024 * 1024; // 1 MB
    }

    async init(source) {
        // source can be a URL string or a File/Blob
        if (typeof source === "string") {
            this.url = source;
            this.sourceType = "url";
            // Probe for range request support and file size
            const headResp = await fetch(this.url, { method: "HEAD" });
            const acceptRanges = headResp.headers.get("Accept-Ranges");
            this.supportsRangeRequests = acceptRanges === "bytes";
            const contentLength = headResp.headers.get("Content-Length");
            this.fileSize = contentLength ? parseInt(contentLength, 10) : 0;
            videoLog("URL source: size=" + this.fileSize + " rangeRequests=" + this.supportsRangeRequests);
        } else if (source instanceof Blob || source instanceof File) {
            this.file = source;
            this.sourceType = "file";
            this.fileSize = source.size;
            this.supportsRangeRequests = true; // Blob.slice always works
            videoLog("File/Blob source: size=" + this.fileSize);
        } else {
            throw new Error("Unsupported source type");
        }

        await this.extractSamples();
        videoLog("Extracted " + this.samples.length + " samples, " + this.keyframeIndices.length + " keyframes");
    }

    async readChunk(offset, size) {
        if (this.sourceType === "file") {
            const slice = this.file.slice(offset, offset + size);
            const arrayBuffer = await slice.arrayBuffer();
            return arrayBuffer;
        }

        // URL source
        if (this.supportsRangeRequests) {
            const end = Math.min(offset + size - 1, this.fileSize - 1);
            const resp = await fetch(this.url, {
                headers: { Range: "bytes=" + offset + "-" + end },
            });
            return await resp.arrayBuffer();
        } else {
            // No range requests - fetch entire file (only once, then cache)
            if (!this._fullBuffer) {
                const resp = await fetch(this.url);
                this._fullBuffer = await resp.arrayBuffer();
                this.fileSize = this._fullBuffer.byteLength;
            }
            return this._fullBuffer.slice(offset, offset + size);
        }
    }

    getCodecDescription(trak) {
        // Extract codec-specific data (avcC / hvcC / etc.) from the sample entry
        for (const entry of trak.mdia.minf.stbl.stsd.entries) {
            // avcC for H.264
            if (entry.avcC) {
                const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
                entry.avcC.write(stream);
                return new Uint8Array(stream.buffer, 8); // skip box header
            }
            // hvcC for H.265
            if (entry.hvcC) {
                const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
                entry.hvcC.write(stream);
                return new Uint8Array(stream.buffer, 8);
            }
            // vpcC for VP9
            if (entry.vpcC) {
                const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
                entry.vpcC.write(stream);
                return new Uint8Array(stream.buffer, 8);
            }
            // av1C for AV1
            if (entry.av1C) {
                const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
                entry.av1C.write(stream);
                return new Uint8Array(stream.buffer, 8);
            }
        }
        return undefined;
    }

    async extractSamples() {
        return new Promise(async (resolve, reject) => {
            this.mp4boxFile = MP4Box.createFile();

            this.mp4boxFile.onReady = (info) => {
                // Find video track
                const videoTrackInfo = info.tracks.find((t) => t.type === "video");
                if (!videoTrackInfo) {
                    reject(new Error("No video track found"));
                    return;
                }

                this.videoTrack = videoTrackInfo;
                const trak = this.mp4boxFile.getTrackById(videoTrackInfo.id);

                // Build codec string
                let codec = videoTrackInfo.codec;

                // Build decoder config
                const description = this.getCodecDescription(trak);
                this.config = {
                    codec: codec,
                    codedWidth: videoTrackInfo.video.width,
                    codedHeight: videoTrackInfo.video.height,
                };
                if (description) {
                    this.config.description = description;
                }

                videoLog("Video track: " + codec + " " + videoTrackInfo.video.width + "x" + videoTrackInfo.video.height);

                // Extract all samples from the track
                this.mp4boxFile.setExtractionOptions(videoTrackInfo.id, null, {
                    nbSamples: Infinity,
                });
                this.mp4boxFile.start();
            };

            this.mp4boxFile.onSamples = (trackId, user, samples) => {
                this.samples = samples;

                // Build keyframe index
                this.keyframeIndices = [];
                for (let i = 0; i < samples.length; i++) {
                    if (samples[i].is_sync) {
                        this.keyframeIndices.push(i);
                    }
                }

                resolve();
            };

            this.mp4boxFile.onError = (e) => {
                reject(e);
            };

            // Feed data to mp4box in chunks
            let offset = 0;
            while (offset < this.fileSize) {
                const chunkSize = Math.min(this.CHUNK_SIZE, this.fileSize - offset);
                const buffer = await this.readChunk(offset, chunkSize);
                buffer.fileStart = offset;
                this.mp4boxFile.appendBuffer(buffer);
                offset += chunkSize;
            }

            this.mp4boxFile.flush();
        });
    }

    findKeyframeBefore(frameIndex) {
        let best = 0;
        for (let i = 0; i < this.keyframeIndices.length; i++) {
            if (this.keyframeIndices[i] <= frameIndex) {
                best = this.keyframeIndices[i];
            } else {
                break;
            }
        }
        return best;
    }

    async getFrame(frameIndex) {
        if (frameIndex < 0 || frameIndex >= this.samples.length) {
            videoLog("Frame index out of range: " + frameIndex, "warn");
            return null;
        }

        // Check cache
        if (this.cache.has(frameIndex)) {
            // Move to end (most recently used)
            const frame = this.cache.get(frameIndex);
            this.cache.delete(frameIndex);
            this.cache.set(frameIndex, frame);
            return frame;
        }

        // Decode from nearest keyframe through requested frame + lookahead
        const keyframe = this.findKeyframeBefore(frameIndex);
        const endFrame = Math.min(frameIndex + this.lookahead, this.samples.length - 1);

        await this.decodeRange(keyframe, endFrame);

        // Return from cache
        if (this.cache.has(frameIndex)) {
            const frame = this.cache.get(frameIndex);
            this.cache.delete(frameIndex);
            this.cache.set(frameIndex, frame);
            return frame;
        }

        videoLog("Frame " + frameIndex + " not in cache after decode", "warn");
        return null;
    }

    async decodeRange(startFrame, endFrame) {
        // Coalesce overlapping decode requests
        if (this.isDecoding) {
            // Wait for current decode to finish, then retry
            this.pendingFrame = { start: startFrame, end: endFrame };
            return;
        }

        this.isDecoding = true;
        try {
            await this._decodeRangeInternal(startFrame, endFrame);
        } finally {
            this.isDecoding = false;

            // Process pending request if any
            if (this.pendingFrame) {
                const pending = this.pendingFrame;
                this.pendingFrame = null;
                await this.decodeRange(pending.start, pending.end);
            }
        }
    }

    async _decodeRangeInternal(startFrame, endFrame) {
        // Check if all frames are already cached
        let allCached = true;
        for (let i = startFrame; i <= endFrame; i++) {
            if (!this.cache.has(i)) {
                allCached = false;
                break;
            }
        }
        if (allCached) return;

        // Read sample data for the range
        const sampleDataMap = await this.readSampleDataRange(startFrame, endFrame);

        // Create a fresh decoder for this range
        return new Promise((resolve, reject) => {
            const framesToDecode = new Map(); // cts -> frameIndex
            for (let i = startFrame; i <= endFrame; i++) {
                const sample = this.samples[i];
                framesToDecode.set(sample.cts, i);
            }

            let decodedCount = 0;
            const totalExpected = endFrame - startFrame + 1;

            const decoder = new VideoDecoder({
                output: (videoFrame) => {
                    const cts = videoFrame.timestamp;
                    // Find matching frame index by timestamp
                    let matchedIndex = -1;

                    // Direct CTS match
                    if (framesToDecode.has(cts)) {
                        matchedIndex = framesToDecode.get(cts);
                    } else {
                        // Find closest CTS match
                        let bestDist = Infinity;
                        for (const [sampleCts, idx] of framesToDecode) {
                            const dist = Math.abs(sampleCts - cts);
                            if (dist < bestDist) {
                                bestDist = dist;
                                matchedIndex = idx;
                            }
                        }
                    }

                    if (matchedIndex >= 0 && matchedIndex >= startFrame && matchedIndex <= endFrame) {
                        this.addToCache(matchedIndex, videoFrame);
                        framesToDecode.delete(this.samples[matchedIndex].cts);
                    } else {
                        videoFrame.close();
                    }

                    decodedCount++;
                    if (decodedCount >= totalExpected) {
                        resolve();
                    }
                },
                error: (e) => {
                    videoLog("Decoder error: " + e.message, "error");
                    reject(e);
                },
            });

            decoder.configure(this.config);

            // Feed samples to the decoder
            for (let i = startFrame; i <= endFrame; i++) {
                const sample = this.samples[i];
                const sampleData = sampleDataMap.get(i);
                if (!sampleData) {
                    videoLog("Missing sample data for frame " + i, "warn");
                    decodedCount++; // Count as done to avoid hanging
                    if (decodedCount >= totalExpected) {
                        resolve();
                    }
                    continue;
                }

                const chunk = new EncodedVideoChunk({
                    type: sample.is_sync ? "key" : "delta",
                    timestamp: sample.cts,
                    duration: sample.duration,
                    data: sampleData,
                });

                decoder.decode(chunk);
            }

            decoder.flush().then(() => {
                decoder.close();
                // Resolve even if not all frames matched (timestamp mismatches)
                resolve();
            }).catch((e) => {
                videoLog("Decoder flush error: " + e.message, "error");
                try { decoder.close(); } catch (_) {}
                resolve(); // Don't reject - partial decode is OK
            });
        });
    }

    async readSampleDataRange(startFrame, endFrame) {
        const sampleDataMap = new Map();

        // Collect byte ranges needed
        const ranges = [];
        for (let i = startFrame; i <= endFrame; i++) {
            const sample = this.samples[i];
            ranges.push({
                index: i,
                offset: sample.offset,
                size: sample.size,
            });
        }

        // Sort by offset for sequential reading
        ranges.sort((a, b) => a.offset - b.offset);

        // Merge nearby ranges into larger reads to reduce I/O
        const mergedReads = [];
        let current = null;

        for (const range of ranges) {
            if (!current) {
                current = {
                    offset: range.offset,
                    end: range.offset + range.size,
                    samples: [range],
                };
            } else {
                const gap = range.offset - current.end;
                // Merge if gap is small (< 64KB)
                if (gap < 65536) {
                    current.end = Math.max(current.end, range.offset + range.size);
                    current.samples.push(range);
                } else {
                    mergedReads.push(current);
                    current = {
                        offset: range.offset,
                        end: range.offset + range.size,
                        samples: [range],
                    };
                }
            }
        }
        if (current) {
            mergedReads.push(current);
        }

        // Read merged ranges and extract sample data
        for (const read of mergedReads) {
            const readSize = read.end - read.offset;
            const buffer = await this.readChunk(read.offset, readSize);

            for (const sample of read.samples) {
                const localOffset = sample.offset - read.offset;
                const data = new Uint8Array(buffer, localOffset, sample.size);
                sampleDataMap.set(sample.index, data);
            }
        }

        return sampleDataMap;
    }

    addToCache(frameIndex, videoFrame) {
        // Evict oldest if at capacity
        if (this.cache.size >= this.cacheSize) {
            const oldest = this.cache.keys().next().value;
            const oldFrame = this.cache.get(oldest);
            if (oldFrame && typeof oldFrame.close === "function") {
                oldFrame.close();
            }
            this.cache.delete(oldest);
        }

        this.cache.set(frameIndex, videoFrame);
    }

    close() {
        // Close all cached VideoFrames
        for (const [key, frame] of this.cache) {
            if (frame && typeof frame.close === "function") {
                frame.close();
            }
        }
        this.cache.clear();

        if (this.decoder) {
            try {
                this.decoder.close();
            } catch (_) {}
            this.decoder = null;
        }

        this.samples = [];
        this.keyframeIndices = [];
        this.mp4boxFile = null;
        this.config = null;
        this.videoTrack = null;
        videoLog("Decoder closed");
    }
}

// ---------------------------------------------------------------------------
// VideoController - Synchronized multi-view playback with overlay support
// ---------------------------------------------------------------------------
class VideoController {
    /**
     * @param {Object} state - Shared application state
     *   state.views: Array of { name, decoder, canvas, ctx, overlayCanvas, overlayCtx }
     *   state.currentFrame: number
     *   state.totalFrames: number
     *   state.fps: number
     *   state.isPlaying: boolean
     *   state.playInterval: number|null
     * @param {Object} callbacks
     *   callbacks.updateSeekbar: (frameIndex) => void
     *   callbacks.drawOverlays: (frameIndex) => void
     *   callbacks.onPlaybackStateChange: (isPlaying) => void
     *   callbacks.log: (msg, level) => void
     */
    constructor(state, callbacks) {
        this.state = state;
        this.callbacks = callbacks || {};
        this._scrubPending = false;
        this._scrubTarget = null;
        this._isSeeking = false;
    }

    /**
     * Seek all views to the given frame in parallel, render, and call callbacks.
     */
    async seekToFrame(frameIndex) {
        if (frameIndex < 0) frameIndex = 0;
        if (frameIndex >= this.state.totalFrames) frameIndex = this.state.totalFrames - 1;

        this.state.currentFrame = frameIndex;

        // Decode all views in parallel
        const views = this.state.views.filter((v) => v.decoder);
        const framePromises = views.map((view) =>
            view.decoder.getFrame(frameIndex).catch((e) => {
                videoLog("Error decoding frame " + frameIndex + " for view " + view.name + ": " + e.message, "error");
                return null;
            })
        );

        const frames = await Promise.all(framePromises);

        // Render each frame to its canvas and clear/redraw overlays
        for (let i = 0; i < views.length; i++) {
            const view = views[i];
            const videoFrame = frames[i];

            if (videoFrame) {
                // Draw video frame to the main canvas
                view.ctx.drawImage(videoFrame, 0, 0, view.canvas.width, view.canvas.height);
            }

            // Clear the overlay canvas for fresh overlay drawing
            if (view.overlayCtx && view.overlayCanvas) {
                view.overlayCtx.clearRect(0, 0, view.overlayCanvas.width, view.overlayCanvas.height);
            }
        }

        // Call overlay drawing callback (e.g., render pose skeletons)
        if (this.callbacks.drawOverlays) {
            this.callbacks.drawOverlays(frameIndex);
        }

        // Update seekbar position
        if (this.callbacks.updateSeekbar) {
            this.callbacks.updateSeekbar(frameIndex);
        }
    }

    /**
     * Coalesced seeking during scrubbing - drops intermediate frames
     * to keep the UI responsive during fast mouse drags.
     */
    scrubToFrame(frame) {
        this._scrubTarget = frame;

        if (this._isSeeking) {
            // Already seeking, the target is saved and will be processed
            return;
        }

        this._processScrub();
    }

    async _processScrub() {
        if (this._scrubTarget === null) return;

        this._isSeeking = true;
        const target = this._scrubTarget;
        this._scrubTarget = null;

        try {
            await this.seekToFrame(target);
        } catch (e) {
            videoLog("Scrub seek error: " + e.message, "error");
        }

        this._isSeeking = false;

        // If another scrub came in while we were seeking, process it
        if (this._scrubTarget !== null) {
            this._processScrub();
        }
    }

    /**
     * Toggle playback on/off.
     */
    togglePlayback() {
        if (this.state.isPlaying) {
            this.stopPlayback();
        } else {
            this.startPlayback();
        }
    }

    /**
     * Start automatic forward playback using setInterval.
     */
    startPlayback() {
        if (this.state.isPlaying) return;

        this.state.isPlaying = true;
        const intervalMs = Math.round(1000 / (this.state.fps || 30));

        this.state.playInterval = setInterval(async () => {
            if (!this.state.isPlaying) {
                this.stopPlayback();
                return;
            }

            let nextFrame = this.state.currentFrame + 1;
            if (nextFrame >= this.state.totalFrames) {
                // Loop back to start or stop
                this.stopPlayback();
                return;
            }

            await this.seekToFrame(nextFrame);
        }, intervalMs);

        if (this.callbacks.onPlaybackStateChange) {
            this.callbacks.onPlaybackStateChange(true);
        }

        videoLog("Playback started at " + (this.state.fps || 30) + " fps");
    }

    /**
     * Stop automatic playback.
     */
    stopPlayback() {
        if (this.state.playInterval) {
            clearInterval(this.state.playInterval);
            this.state.playInterval = null;
        }
        this.state.isPlaying = false;

        if (this.callbacks.onPlaybackStateChange) {
            this.callbacks.onPlaybackStateChange(false);
        }

        videoLog("Playback stopped");
    }

    /**
     * Setup seekbar for mouse-based scrubbing.
     * @param {HTMLElement} seekbar - The seekbar container element
     * @param {Function} updateVisual - (frameIndex) => void, updates seekbar visual position
     */
    setupSeekbar(seekbar, updateVisual) {
        let isDragging = false;

        const getFrameFromEvent = (e) => {
            const rect = seekbar.getBoundingClientRect();
            const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            return Math.round(fraction * (this.state.totalFrames - 1));
        };

        seekbar.addEventListener("mousedown", (e) => {
            isDragging = true;
            const frame = getFrameFromEvent(e);
            if (updateVisual) updateVisual(frame);
            this.scrubToFrame(frame);
            e.preventDefault();
        });

        document.addEventListener("mousemove", (e) => {
            if (!isDragging) return;
            const frame = getFrameFromEvent(e);
            if (updateVisual) updateVisual(frame);
            this.scrubToFrame(frame);
            e.preventDefault();
        });

        document.addEventListener("mouseup", (e) => {
            if (!isDragging) return;
            isDragging = false;
        });
    }

    /**
     * Setup keyboard handlers for video navigation, playback, and zoom.
     *   ArrowRight / ArrowLeft: +1 / -1 frame
     *   Shift+ArrowRight / Shift+ArrowLeft: +10 / -10 frames
     *   Space: toggle play/pause
     *   Home: go to first frame
     *   End: go to last frame
     *   + / =: zoom in all views
     *   - / _: zoom out all views
     *   0: reset zoom on all views
     */
    setupKeyboardHandlers() {
        document.addEventListener("keydown", (e) => {
            // Ignore if user is typing in an input field
            if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) {
                return;
            }

            switch (e.key) {
                case "ArrowRight":
                    e.preventDefault();
                    if (e.shiftKey) {
                        this.seekToFrame(this.state.currentFrame + 10);
                    } else {
                        this.seekToFrame(this.state.currentFrame + 1);
                    }
                    break;

                case "ArrowLeft":
                    e.preventDefault();
                    if (e.shiftKey) {
                        this.seekToFrame(this.state.currentFrame - 10);
                    } else {
                        this.seekToFrame(this.state.currentFrame - 1);
                    }
                    break;

                case " ":
                    e.preventDefault();
                    this.togglePlayback();
                    break;

                case "Home":
                    e.preventDefault();
                    this.seekToFrame(0);
                    break;

                case "End":
                    e.preventDefault();
                    this.seekToFrame(this.state.totalFrames - 1);
                    break;

                case "+":
                case "=":
                    e.preventDefault();
                    this.zoomAllVideos(1.2);
                    break;

                case "-":
                case "_":
                    e.preventDefault();
                    this.zoomAllVideos(1 / 1.2);
                    break;

                case "0":
                    e.preventDefault();
                    this.resetAllZoom();
                    break;
            }
        });

        videoLog("Keyboard handlers installed");
    }

    // -----------------------------------------------------------------------
    // Zoom and pan
    // -----------------------------------------------------------------------

    /**
     * Initialize zoom state for a view.
     * Call this for each view after setup.
     */
    initZoom(view) {
        view.zoom = {
            scale: 1.0,
            offsetX: 0,
            offsetY: 0,
        };
    }

    /**
     * Apply the current zoom/pan transform to a view's canvases.
     * Uses translate then scale so offset is in content (video pixel) space.
     */
    applyZoom(view) {
        if (!view.zoom) return;

        const z = view.zoom;
        const transform = "translate(" + z.offsetX + "px, " + z.offsetY + "px) scale(" + z.scale + ")";

        if (view.canvas) {
            view.canvas.style.transform = transform;
            view.canvas.style.transformOrigin = "0 0";
        }
        if (view.overlayCanvas) {
            view.overlayCanvas.style.transform = transform;
            view.overlayCanvas.style.transformOrigin = "0 0";
        }

        // Toggle zoomed indicator on the cell
        const cell = view.canvas ? view.canvas.closest('.video-cell') : null;
        if (cell) {
            if (z.scale > 1.01 || Math.abs(z.offsetX) > 1 || Math.abs(z.offsetY) > 1) {
                cell.classList.add('zoomed');
            } else {
                cell.classList.remove('zoomed');
            }
        }
    }

    /**
     * Zoom a single view by a multiplier factor, optionally centered on a
     * point in CSS-pixel space (relative to the container).
     * factor > 1 = zoom in, factor < 1 = zoom out.
     *
     * @param {Object} view - View object with .zoom state
     * @param {number} factor - Zoom multiplier
     * @param {number} [cssX] - X position in CSS pixels (relative to container)
     * @param {number} [cssY] - Y position in CSS pixels (relative to container)
     */
    zoomVideo(view, factor, cssX, cssY) {
        if (!view.zoom) this.initZoom(view);

        const z = view.zoom;
        const oldScale = z.scale;
        const newScale = Math.max(0.25, Math.min(10, oldScale * factor));

        if (cssX !== undefined && cssY !== undefined) {
            // Cursor-centered zoom: keep the point under the cursor stable.
            // The transform is: translate(offset) then scale(s) from origin 0,0.
            // A point at CSS position (cssX, cssY) maps to content position:
            //   contentX = (cssX - offsetX) / scale
            // After scale change, to keep the same content point under cssX:
            //   cssX = contentX * newScale + newOffsetX
            //   newOffsetX = cssX - contentX * newScale
            const contentX = (cssX - z.offsetX) / oldScale;
            const contentY = (cssY - z.offsetY) / oldScale;
            z.offsetX = cssX - contentX * newScale;
            z.offsetY = cssY - contentY * newScale;
        }

        z.scale = newScale;
        this.applyZoom(view);
    }

    /**
     * Reset zoom and pan on a single view.
     * @param {Object} view
     */
    resetZoom(view) {
        if (!view.zoom) this.initZoom(view);
        view.zoom.scale = 1.0;
        view.zoom.offsetX = 0;
        view.zoom.offsetY = 0;
        this.applyZoom(view);
    }

    /**
     * Zoom to fit a rectangle (in CSS pixels relative to container) into the view.
     * @param {Object} view - View object
     * @param {number} x1 - Left edge (CSS px)
     * @param {number} y1 - Top edge (CSS px)
     * @param {number} x2 - Right edge (CSS px)
     * @param {number} y2 - Bottom edge (CSS px)
     * @param {HTMLElement} container - The video cell element
     */
    zoomToRect(view, x1, y1, x2, y2, container) {
        if (!view.zoom) this.initZoom(view);

        const z = view.zoom;
        const rectW = Math.abs(x2 - x1);
        const rectH = Math.abs(y2 - y1);
        if (rectW < 5 || rectH < 5) return; // Too small, ignore

        const containerW = container.clientWidth;
        const containerH = container.clientHeight;

        // Convert the CSS-pixel rectangle corners to content space under current transform
        const contentX1 = (Math.min(x1, x2) - z.offsetX) / z.scale;
        const contentY1 = (Math.min(y1, y2) - z.offsetY) / z.scale;
        const contentX2 = (Math.max(x1, x2) - z.offsetX) / z.scale;
        const contentY2 = (Math.max(y1, y2) - z.offsetY) / z.scale;
        const contentW = contentX2 - contentX1;
        const contentH = contentY2 - contentY1;

        // New scale to fit the content rect into the container
        const newScale = Math.min(containerW / contentW, containerH / contentH);
        const clampedScale = Math.max(0.25, Math.min(10, newScale));

        // Center the content rect in the container
        const contentCenterX = (contentX1 + contentX2) / 2;
        const contentCenterY = (contentY1 + contentY2) / 2;
        z.offsetX = containerW / 2 - contentCenterX * clampedScale;
        z.offsetY = containerH / 2 - contentCenterY * clampedScale;
        z.scale = clampedScale;

        this.applyZoom(view);
    }

    /**
     * Zoom all views by the same factor.
     */
    zoomAllVideos(factor) {
        for (const view of this.state.views) {
            this.zoomVideo(view, factor);
        }
    }

    /**
     * Reset zoom and pan on all views.
     */
    resetAllZoom() {
        for (const view of this.state.views) {
            this.resetZoom(view);
        }
        videoLog("Zoom reset on all views");
    }

    /**
     * Setup mouse wheel zoom, middle-button pan, box zoom (Shift+drag),
     * and double-click reset handlers for a single view.
     *
     * @param {Object} view - The view object
     * @param {HTMLElement} container - The container element that wraps both canvases
     */
    setupZoomHandlers(view, container) {
        if (!view.zoom) this.initZoom(view);

        // ---- Mouse wheel zoom (cursor-centered) ----
        container.addEventListener("wheel", (e) => {
            e.preventDefault();
            const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;

            // Get cursor position relative to the container
            const rect = container.getBoundingClientRect();
            const cssX = e.clientX - rect.left;
            const cssY = e.clientY - rect.top;

            this.zoomVideo(view, factor, cssX, cssY);
        }, { passive: false });

        // ---- Double-click to reset zoom ----
        container.addEventListener("dblclick", (e) => {
            // Only reset if actually zoomed (avoid interfering with overlay dblclick)
            if (view.zoom && (view.zoom.scale > 1.01 || view.zoom.scale < 0.99 ||
                Math.abs(view.zoom.offsetX) > 1 || Math.abs(view.zoom.offsetY) > 1)) {
                e.preventDefault();
                e.stopPropagation();
                this.resetZoom(view);
            }
        });

        // ---- Drag state for pan / box zoom ----
        let isPanning = false;
        let isBoxZooming = false;
        let lastX = 0;
        let lastY = 0;
        let boxStartX = 0;
        let boxStartY = 0;
        let boxOverlay = null;
        // Track if drag moved enough to distinguish from a click
        let dragStartX = 0;
        let dragStartY = 0;
        let leftDragPending = false;

        container.addEventListener("mousedown", (e) => {
            // Middle button -> always pan
            if (e.button === 1) {
                isPanning = true;
                lastX = e.clientX;
                lastY = e.clientY;
                e.preventDefault();
                return;
            }

            // Left button on empty space -> box zoom or pan
            if (e.button === 0 && !e._consumedByInteraction) {
                // Wait for mousemove to decide between box zoom and pan.
                // We start as a "pending" state and decide on first move.
                leftDragPending = true;
                dragStartX = e.clientX;
                dragStartY = e.clientY;
                lastX = e.clientX;
                lastY = e.clientY;

                const rect = container.getBoundingClientRect();
                boxStartX = e.clientX - rect.left;
                boxStartY = e.clientY - rect.top;
            }
        });

        const isZoomed = () => {
            if (!view.zoom) return false;
            return view.zoom.scale > 1.05 ||
                Math.abs(view.zoom.offsetX) > 2 ||
                Math.abs(view.zoom.offsetY) > 2;
        };

        document.addEventListener("mousemove", (e) => {
            if (isPanning) {
                const dx = e.clientX - lastX;
                const dy = e.clientY - lastY;
                lastX = e.clientX;
                lastY = e.clientY;

                view.zoom.offsetX += dx;
                view.zoom.offsetY += dy;
                this.applyZoom(view);
                return;
            }

            if (leftDragPending) {
                // Check if we've moved enough to start a drag (3px dead zone)
                const dx = e.clientX - dragStartX;
                const dy = e.clientY - dragStartY;
                if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;

                leftDragPending = false;

                if (isZoomed()) {
                    // Already zoomed in -> pan mode
                    isPanning = true;
                    lastX = e.clientX;
                    lastY = e.clientY;
                } else {
                    // At 1x -> box zoom mode
                    isBoxZooming = true;
                    boxOverlay = document.createElement("div");
                    boxOverlay.className = "box-zoom-overlay";
                    boxOverlay.style.left = boxStartX + "px";
                    boxOverlay.style.top = boxStartY + "px";
                    boxOverlay.style.width = "0px";
                    boxOverlay.style.height = "0px";
                    container.appendChild(boxOverlay);
                }
            }

            if (isBoxZooming && boxOverlay) {
                const rect = container.getBoundingClientRect();
                const currentX = e.clientX - rect.left;
                const currentY = e.clientY - rect.top;

                const x = Math.min(boxStartX, currentX);
                const y = Math.min(boxStartY, currentY);
                const w = Math.abs(currentX - boxStartX);
                const h = Math.abs(currentY - boxStartY);

                boxOverlay.style.left = x + "px";
                boxOverlay.style.top = y + "px";
                boxOverlay.style.width = w + "px";
                boxOverlay.style.height = h + "px";
            }
        });

        document.addEventListener("mouseup", (e) => {
            leftDragPending = false;

            if (e.button === 1 && isPanning) {
                isPanning = false;
            }

            if (e.button === 0 && isPanning) {
                isPanning = false;
            }

            if (isBoxZooming) {
                isBoxZooming = false;
                const rect = container.getBoundingClientRect();
                const endX = e.clientX - rect.left;
                const endY = e.clientY - rect.top;

                if (boxOverlay && boxOverlay.parentNode) {
                    boxOverlay.parentNode.removeChild(boxOverlay);
                }
                boxOverlay = null;

                this.zoomToRect(view, boxStartX, boxStartY, endX, endY, container);
            }
        });
    }
}
