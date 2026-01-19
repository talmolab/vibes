/**
 * Video decoding module for multi-camera calibration
 * Uses WebCodecs API with mp4box.js for frame-accurate video access
 */

// Helper for logging (uses global log function if available)
function videoLog(msg, level = 'info') {
    if (typeof log === 'function') {
        log(msg, level);
    } else {
        console.log(`[${level}] ${msg}`);
    }
}

/**
 * On-demand video decoder with frame caching
 * Based on video-player pattern using WebCodecs + mp4box.js
 */
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
        this.CHUNK_SIZE = 1024 * 1024;
    }

    async init(source) {
        // Handle both URL strings and File/Blob objects
        if (typeof source === 'string') {
            this.url = source;
            videoLog(`Checking video: ${source}`, 'info');

            const headResponse = await fetch(source, { method: 'HEAD' });
            if (!headResponse.ok) {
                throw new Error(`Failed to fetch URL: ${headResponse.status}`);
            }
            this.fileSize = parseInt(headResponse.headers.get('Content-Length')) || 0;
            this.supportsRangeRequests = headResponse.headers.get('Accept-Ranges') === 'bytes';

            if (!this.supportsRangeRequests || !this.fileSize) {
                videoLog('Downloading entire file (no range support)...', 'warn');
                const response = await fetch(source);
                this.file = await response.blob();
                this.fileSize = this.file.size;
                this.url = null;
            }
        } else {
            // File or Blob object (from file picker or directory picker)
            this.file = source;
            this.fileSize = source.size;
            videoLog(`Loading video file: ${source.name || 'blob'} (${(source.size / 1024 / 1024).toFixed(1)} MB)`, 'info');
        }

        this.mp4boxFile = MP4Box.createFile();

        const ready = new Promise((resolve, reject) => {
            this.mp4boxFile.onError = reject;
            this.mp4boxFile.onReady = resolve;
        });

        let offset = 0;
        let resolved = false;
        ready.then(() => { resolved = true; });

        while (offset < this.fileSize && !resolved) {
            const buffer = await this.readChunk(offset, this.CHUNK_SIZE);
            buffer.fileStart = offset;
            const nextOffset = this.mp4boxFile.appendBuffer(buffer);
            offset = nextOffset === undefined ? offset + buffer.byteLength : nextOffset;
            await new Promise(r => setTimeout(r, 0));
        }

        const info = await ready;
        if (info.videoTracks.length === 0) {
            throw new Error('No video tracks found');
        }

        this.videoTrack = info.videoTracks[0];
        const trak = this.mp4boxFile.getTrackById(this.videoTrack.id);
        const description = this.getCodecDescription(trak);

        const codec = this.videoTrack.codec.startsWith('vp08') ? 'vp8' : this.videoTrack.codec;
        this.config = {
            codec: codec,
            codedWidth: this.videoTrack.video.width,
            codedHeight: this.videoTrack.video.height,
        };
        if (description) this.config.description = description;

        const support = await VideoDecoder.isConfigSupported(this.config);
        if (!support.supported) {
            throw new Error(`Codec ${codec} not supported`);
        }

        this.extractSamples();

        const duration = this.videoTrack.duration / this.videoTrack.timescale;
        this.fps = this.samples.length / duration;

        return {
            codec: codec,
            width: this.videoTrack.video.width,
            height: this.videoTrack.video.height,
            totalFrames: this.samples.length,
            keyframes: this.keyframeIndices.length,
            duration: duration,
            fps: this.fps,
        };
    }

    async readChunk(offset, size) {
        const end = Math.min(offset + size, this.fileSize);
        if (this.url && this.supportsRangeRequests) {
            const response = await fetch(this.url, {
                headers: { 'Range': `bytes=${offset}-${end - 1}` }
            });
            return await response.arrayBuffer();
        } else {
            // Use blob/file slicing for local files or downloaded blobs
            return await this.file.slice(offset, end).arrayBuffer();
        }
    }

    getCodecDescription(trak) {
        for (const entry of trak.mdia.minf.stbl.stsd.entries) {
            const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
            if (box) {
                const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
                box.write(stream);
                return new Uint8Array(stream.buffer, 8);
            }
        }
        return null;
    }

    extractSamples() {
        const samplesInfo = this.mp4boxFile.getTrackSamplesInfo(this.videoTrack.id);
        if (!samplesInfo || samplesInfo.length === 0) {
            throw new Error('No samples found');
        }

        const timescale = this.videoTrack.timescale;
        for (let i = 0; i < samplesInfo.length; i++) {
            const sample = samplesInfo[i];
            this.samples.push({
                offset: sample.offset,
                size: sample.size,
                timestamp: sample.cts * 1e6 / timescale,
                duration: sample.duration * 1e6 / timescale,
                isKeyframe: sample.is_sync,
            });
            if (sample.is_sync) {
                this.keyframeIndices.push(i);
            }
        }
    }

    findKeyframeBefore(frameIndex) {
        let result = 0;
        for (const kf of this.keyframeIndices) {
            if (kf <= frameIndex) result = kf;
            else break;
        }
        return result;
    }

    async getFrame(frameIndex) {
        if (frameIndex < 0 || frameIndex >= this.samples.length) return null;
        if (this.cache.has(frameIndex)) {
            const bitmap = this.cache.get(frameIndex);
            this.cache.delete(frameIndex);
            this.cache.set(frameIndex, bitmap);
            return { bitmap, fromCache: true };
        }

        if (this.isDecoding) {
            this.pendingFrame = frameIndex;
            await new Promise(resolve => {
                const check = () => {
                    if (!this.isDecoding) resolve();
                    else setTimeout(check, 10);
                };
                check();
            });
            if (this.cache.has(frameIndex)) {
                return { bitmap: this.cache.get(frameIndex), fromCache: true };
            }
        }

        const keyframe = this.findKeyframeBefore(frameIndex);
        const endFrame = Math.min(frameIndex + this.lookahead, this.samples.length - 1);
        await this.decodeRange(keyframe, endFrame, frameIndex);

        const bitmap = this.cache.get(frameIndex);
        return bitmap ? { bitmap, fromCache: false } : null;
    }

    async decodeRange(startFrame, endFrame, targetFrame) {
        this.isDecoding = true;
        try {
            await this._decodeRangeInternal(startFrame, endFrame, targetFrame);
        } finally {
            this.isDecoding = false;
        }
    }

    async _decodeRangeInternal(startFrame, endFrame, targetFrame) {
        const expectedFrames = endFrame - startFrame + 1;
        let decodedCount = 0;

        if (this.decoder) {
            try { this.decoder.close(); } catch (e) {}
        }

        const sampleDataArray = await this.readSampleDataRange(startFrame, endFrame);

        // Build a map from timestamp to frame index for the range we're decoding
        const timestampToIndex = new Map();
        for (let i = startFrame; i <= endFrame; i++) {
            // Use rounded timestamp as key (timestamps are in microseconds)
            const ts = Math.round(this.samples[i].timestamp);
            timestampToIndex.set(ts, i);
        }

        // Debug: log timestamp map
        console.log(`[Decoder] Decoding range ${startFrame}-${endFrame}, timestamp map:`,
            Array.from(timestampToIndex.entries()).slice(0, 5).map(([ts, idx]) => `${idx}:${ts}`).join(', ') + '...');

        return new Promise((resolve, reject) => {
            this.decoder = new VideoDecoder({
                output: (frame) => {
                    // Match frame to correct index using timestamp
                    // VideoDecoder outputs frames in presentation order, not decode order
                    const frameTs = Math.round(frame.timestamp);
                    let frameIndex = timestampToIndex.get(frameTs);

                    // Debug: log timestamp matching
                    if (frameIndex === undefined) {
                        console.warn(`[Decoder] No exact match for timestamp ${frameTs}, map has:`,
                            Array.from(timestampToIndex.keys()).slice(0, 5).join(', ') + '...');
                    }

                    // Fallback: if exact match fails, find closest timestamp
                    if (frameIndex === undefined) {
                        let closestDiff = Infinity;
                        for (const [ts, idx] of timestampToIndex.entries()) {
                            const diff = Math.abs(ts - frameTs);
                            if (diff < closestDiff) {
                                closestDiff = diff;
                                frameIndex = idx;
                            }
                        }
                        console.warn(`[Decoder] Fallback matched timestamp ${frameTs} to index ${frameIndex} (diff=${closestDiff})`);
                    }

                    decodedCount++;
                    const localExpected = expectedFrames;
                    const localDecodedCount = decodedCount;

                    createImageBitmap(frame).then(bitmap => {
                        if (frameIndex !== undefined) {
                            this.addToCache(frameIndex, bitmap);
                        }
                        frame.close();
                        if (localDecodedCount >= localExpected) resolve();
                    }).catch(() => {
                        frame.close();
                        if (localDecodedCount >= localExpected) resolve();
                    });
                },
                error: (e) => {
                    if (e.name === 'AbortError') resolve();
                    else reject(e);
                }
            });

            this.decoder.configure(this.config);

            for (let i = startFrame; i <= endFrame; i++) {
                const sample = this.samples[i];
                const chunk = new EncodedVideoChunk({
                    type: sample.isKeyframe ? 'key' : 'delta',
                    timestamp: sample.timestamp,
                    duration: sample.duration,
                    data: sampleDataArray[i - startFrame],
                });
                this.decoder.decode(chunk);
            }

            this.decoder.flush();
        });
    }

    async readSampleDataRange(startFrame, endFrame) {
        const results = [];
        let regionStart = startFrame;

        while (regionStart <= endFrame) {
            const firstSample = this.samples[regionStart];
            let regionEnd = regionStart;
            let regionBytes = firstSample.size;

            while (regionEnd < endFrame) {
                const currentSample = this.samples[regionEnd];
                const nextSample = this.samples[regionEnd + 1];
                if (nextSample.offset === currentSample.offset + currentSample.size) {
                    regionEnd++;
                    regionBytes += nextSample.size;
                } else break;
            }

            const buffer = await this.readChunk(firstSample.offset, regionBytes);
            const bufferView = new Uint8Array(buffer);

            let bufferOffset = 0;
            for (let i = regionStart; i <= regionEnd; i++) {
                const sample = this.samples[i];
                results.push(bufferView.slice(bufferOffset, bufferOffset + sample.size));
                bufferOffset += sample.size;
            }

            regionStart = regionEnd + 1;
        }

        return results;
    }

    addToCache(frameIndex, bitmap) {
        if (this.cache.size >= this.cacheSize) {
            const firstKey = this.cache.keys().next().value;
            const oldBitmap = this.cache.get(firstKey);
            oldBitmap.close();
            this.cache.delete(firstKey);
        }
        this.cache.set(frameIndex, bitmap);
    }

    close() {
        if (this.decoder) this.decoder.close();
        for (const bitmap of this.cache.values()) bitmap.close();
        this.cache.clear();
    }
}

/**
 * Video playback controller with zoom/pan and frame seeking
 * Uses callback pattern to decouple from overlay and UI functions
 */
class VideoController {
    /**
     * @param {Object} state - Application state (views, currentFrame, totalFrames, etc.)
     * @param {Object} callbacks - Callback functions for UI and overlay updates
     * @param {Function} callbacks.updateSeekbar - Update seekbar UI
     * @param {Function} callbacks.drawOverlays - Draw all overlays for current frame
     * @param {Function} callbacks.updateGalleryHighlights - Update gallery current frame highlights
     * @param {Function} callbacks.log - Logging function
     */
    constructor(state, callbacks) {
        this.state = state;
        this.callbacks = callbacks;
        this.zoomState = {}; // viewName -> {scale, panX, panY}
        this.isSeeking = false;
        this.scrubTargetFrame = null;
    }

    // ============================================
    // Frame Seeking
    // ============================================

    async seekToFrame(frameIndex) {
        if (this.state.views.length === 0) return;

        frameIndex = Math.max(0, Math.min(frameIndex, this.state.totalFrames - 1));
        this.state.currentFrame = frameIndex;

        const startTime = performance.now();

        // Seek all views in parallel
        const results = await Promise.all(
            this.state.views.map(view => view.decoder.getFrame(frameIndex))
        );

        const seekTime = performance.now() - startTime;

        // Render all frames
        for (let i = 0; i < this.state.views.length; i++) {
            const result = results[i];
            const view = this.state.views[i];
            if (result && result.bitmap) {
                view.ctx.clearRect(0, 0, view.canvas.width, view.canvas.height);
                view.ctx.drawImage(result.bitmap, 0, 0);
            }
        }

        // Update UI via callbacks
        if (this.callbacks.updateSeekbar) {
            this.callbacks.updateSeekbar();
        }

        // Draw overlays via callback
        if (this.callbacks.drawOverlays) {
            this.callbacks.drawOverlays(frameIndex);
        }

        // Update gallery highlights
        if (this.callbacks.updateGalleryHighlights) {
            this.callbacks.updateGalleryHighlights();
        }

        if (!this.state.isPlaying && this.callbacks.log) {
            this.callbacks.log(`Frame ${frameIndex}: ${seekTime.toFixed(0)}ms`, 'info');
        }
    }

    async scrubToFrame(frame) {
        if (this.isSeeking) {
            this.scrubTargetFrame = frame;
            return;
        }
        this.isSeeking = true;
        await this.seekToFrame(frame);
        this.isSeeking = false;

        // If target changed while seeking, seek to new target
        if (this.scrubTargetFrame !== null && this.scrubTargetFrame !== frame) {
            const nextFrame = this.scrubTargetFrame;
            this.scrubTargetFrame = null;
            this.scrubToFrame(nextFrame);
        }
    }

    // ============================================
    // Playback Controls
    // ============================================

    togglePlayback() {
        if (this.state.isPlaying) {
            this.stopPlayback();
        } else {
            this.startPlayback();
        }
    }

    startPlayback() {
        if (this.state.views.length === 0) return;
        this.state.isPlaying = true;

        if (this.callbacks.onPlaybackStateChange) {
            this.callbacks.onPlaybackStateChange(true);
        }
        if (this.callbacks.log) {
            this.callbacks.log('Playback started', 'info');
        }

        const interval = 1000 / this.state.fps;
        this.state.playInterval = setInterval(async () => {
            let nextFrame = this.state.currentFrame + 1;
            if (nextFrame >= this.state.totalFrames) nextFrame = 0;
            await this.seekToFrame(nextFrame);
        }, interval);
    }

    stopPlayback() {
        this.state.isPlaying = false;

        if (this.callbacks.onPlaybackStateChange) {
            this.callbacks.onPlaybackStateChange(false);
        }

        if (this.state.playInterval) {
            clearInterval(this.state.playInterval);
            this.state.playInterval = null;
        }

        if (this.callbacks.log) {
            this.callbacks.log('Playback stopped', 'info');
        }
    }

    // ============================================
    // Seekbar Setup
    // ============================================

    /**
     * Setup seekbar scrubbing handlers
     * @param {HTMLElement} seekbar - The seekbar element
     * @param {Function} updateVisual - Callback to update seekbar visual (progress, thumb, frame display)
     */
    setupSeekbar(seekbar, updateVisual) {
        let isScrubbing = false;
        let scrubTargetFrame = null;

        const getFrameFromSeekbar = (e) => {
            const rect = seekbar.getBoundingClientRect();
            const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
            const percent = x / rect.width;
            // Map 0-100% to frame indices 0 to (totalFrames-1)
            const maxFrame = Math.max(0, this.state.totalFrames - 1);
            return Math.round(percent * maxFrame);
        };

        seekbar.addEventListener('mousedown', (e) => {
            e.preventDefault(); // Prevent text selection
            isScrubbing = true;
            document.body.style.userSelect = 'none'; // Prevent text selection while dragging
            const frame = getFrameFromSeekbar(e);
            updateVisual(frame);
            this.scrubToFrame(frame);
        });

        document.addEventListener('mousemove', (e) => {
            if (!isScrubbing) return;
            const frame = getFrameFromSeekbar(e);
            updateVisual(frame);
            scrubTargetFrame = frame;
            this.scrubToFrame(frame);
        });

        document.addEventListener('mouseup', () => {
            if (isScrubbing) {
                document.body.style.userSelect = ''; // Restore text selection
                if (scrubTargetFrame !== null) {
                    this.seekToFrame(scrubTargetFrame);
                }
            }
            isScrubbing = false;
            scrubTargetFrame = null;
        });
    }

    // ============================================
    // Keyboard Handlers
    // ============================================

    /**
     * Setup keyboard navigation handlers
     * Call this once after VideoController is created
     */
    setupKeyboardHandlers() {
        document.addEventListener('keydown', (e) => {
            if (this.state.views.length === 0) return;
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

            // Frame navigation
            let delta = 0;
            if (e.key === 'ArrowLeft') delta = -1;
            else if (e.key === 'ArrowRight') delta = 1;
            else if (e.key === 'ArrowUp') delta = 10;
            else if (e.key === 'ArrowDown') delta = -10;
            else if (e.key === ' ') {
                this.togglePlayback();
                e.preventDefault();
                return;
            }
            else if (e.key === 'Home') {
                this.seekToFrame(0);
                e.preventDefault();
                return;
            }
            else if (e.key === 'End') {
                this.seekToFrame(this.state.totalFrames - 1);
                e.preventDefault();
                return;
            }

            if (delta !== 0) {
                this.seekToFrame(this.state.currentFrame + delta);
                e.preventDefault();
            }

            // Global zoom with +/- keys
            if (e.key === '+' || e.key === '=') {
                this.zoomAllVideos(1.2);
                e.preventDefault();
            } else if (e.key === '-' || e.key === '_') {
                this.zoomAllVideos(1 / 1.2);
                e.preventDefault();
            } else if (e.key === '0') {
                this.resetAllZoom();
                e.preventDefault();
            }
        });
    }

    // ============================================
    // Zoom & Pan
    // ============================================

    initZoom(viewName) {
        if (!this.zoomState[viewName]) {
            this.zoomState[viewName] = { scale: 1, panX: 0, panY: 0 };
        }
    }

    applyZoom(viewName) {
        const view = this.state.views.find(v => v.name === viewName);
        if (!view || !view.canvas) return;

        const zs = this.zoomState[viewName];
        if (!zs) return;

        const cell = view.canvas.closest('.video-cell');
        if (zs.scale > 1) {
            cell.classList.add('zoomed');
        } else {
            cell.classList.remove('zoomed');
        }

        view.canvas.style.transform = `scale(${zs.scale}) translate(${zs.panX}px, ${zs.panY}px)`;
    }

    zoomVideo(viewName, factor, centerX = 0.5, centerY = 0.5) {
        this.initZoom(viewName);
        const zs = this.zoomState[viewName];

        const oldScale = zs.scale;
        zs.scale = Math.max(1, Math.min(10, zs.scale * factor));

        // If zooming out to 1x, reset pan
        if (zs.scale === 1) {
            zs.panX = 0;
            zs.panY = 0;
        }

        this.applyZoom(viewName);
    }

    zoomAllVideos(factor) {
        this.state.views.forEach(view => {
            this.zoomVideo(view.name, factor);
        });
    }

    resetAllZoom() {
        this.state.views.forEach(view => {
            this.zoomState[view.name] = { scale: 1, panX: 0, panY: 0 };
            this.applyZoom(view.name);
        });
    }

    setupZoomHandlers(viewName, canvas) {
        const cell = canvas.closest('.video-cell');
        this.initZoom(viewName);

        // Scroll wheel zoom
        cell.addEventListener('wheel', (e) => {
            e.preventDefault();
            const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
            this.zoomVideo(viewName, factor);
        }, { passive: false });

        // Pan with mouse drag when zoomed
        let isPanning = false;
        let panStartX, panStartY;
        let panStartPosX, panStartPosY;

        cell.addEventListener('mousedown', (e) => {
            const zs = this.zoomState[viewName];
            if (zs && zs.scale > 1) {
                isPanning = true;
                cell.classList.add('panning');
                panStartX = e.clientX;
                panStartY = e.clientY;
                panStartPosX = zs.panX;
                panStartPosY = zs.panY;
                e.preventDefault();
            }
        });

        document.addEventListener('mousemove', (e) => {
            if (!isPanning) return;
            const zs = this.zoomState[viewName];
            if (!zs) return;

            const dx = (e.clientX - panStartX) / zs.scale;
            const dy = (e.clientY - panStartY) / zs.scale;

            // Limit pan to keep image visible based on actual canvas dimensions
            const view = this.state.views.find(v => v.name === viewName);
            const canvasW = view ? view.canvas.width : 640;
            const canvasH = view ? view.canvas.height : 480;
            const maxPanX = canvasW * (1 - 1 / zs.scale) / 2;
            const maxPanY = canvasH * (1 - 1 / zs.scale) / 2;
            zs.panX = Math.max(-maxPanX, Math.min(maxPanX, panStartPosX + dx));
            zs.panY = Math.max(-maxPanY, Math.min(maxPanY, panStartPosY + dy));

            this.applyZoom(viewName);
        });

        document.addEventListener('mouseup', () => {
            if (isPanning) {
                isPanning = false;
                cell.classList.remove('panning');
            }
        });

        // Double-click to reset zoom
        cell.addEventListener('dblclick', (e) => {
            this.zoomState[viewName] = { scale: 1, panX: 0, panY: 0 };
            this.applyZoom(viewName);
            e.preventDefault();
        });
    }
}
