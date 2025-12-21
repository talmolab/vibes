/**
 * Video Player - Frame-accurate video playback with WebCodecs
 *
 * Provides a reusable video player with:
 * - Frame-accurate seeking via WebCodecs API
 * - LRU frame caching with lookahead
 * - Zoom/pan with mouse and touch support
 * - Overlay rendering hooks
 * - Debounced seekbar scrubbing
 */

// ============================================
// VideoDecoderWrapper - Low-level decoder with caching
// ============================================
class VideoDecoderWrapper {
    constructor(opts = {}) {
        this.cacheSize = opts.cacheSize || 60;
        this.lookahead = opts.lookahead || 30;
        this.cache = new Map();
        this.samples = [];
        this.keyframeIndices = [];
        this.decoder = null;
        this.config = null;
        this.videoTrack = null;
        this.mp4boxFile = null;
        this.file = null;
        this.url = null;
        this.fileSize = 0;
        this.supportsRangeRequests = false;
        this.isDecoding = false;
        this.onLog = opts.onLog || null;
    }

    _log(msg, level = 'info') {
        if (this.onLog) this.onLog(msg, level);
    }

    async init(source) {
        // Handle URL or File
        if (typeof source === 'string') {
            this.url = source;

            // Check for range request support by trying a small range request
            // (Accept-Ranges header may not be exposed due to CORS)
            const headResponse = await fetch(source, { method: 'HEAD' });
            if (!headResponse.ok) {
                throw new Error(`Failed to fetch video: ${headResponse.status}`);
            }

            this.fileSize = parseInt(headResponse.headers.get('Content-Length')) || 0;

            // Try a small range request to test support (CORS may hide Accept-Ranges header)
            if (this.fileSize > 0) {
                try {
                    const rangeTest = await fetch(source, {
                        method: 'GET',
                        headers: { 'Range': 'bytes=0-0' }
                    });
                    // 206 Partial Content = range requests supported
                    this.supportsRangeRequests = rangeTest.status === 206;
                } catch (e) {
                    this.supportsRangeRequests = false;
                }
            }

            if (!this.supportsRangeRequests || !this.fileSize) {
                // Fall back to fetching entire file
                this._log('Server does not support range requests, downloading entire file...', 'warn');
                const response = await fetch(source);
                const blob = await response.blob();
                this.file = new File([blob], 'video.mp4', { type: blob.type || 'video/mp4' });
                this.fileSize = this.file.size;
                this.url = null; // Use file-based reading
            } else {
                this._log(`Streaming enabled (${(this.fileSize / 1024 / 1024).toFixed(1)} MB, range requests)`, 'success');
            }
        } else {
            this.file = source;
            this.fileSize = this.file.size;
        }
        this.mp4boxFile = MP4Box.createFile();

        const ready = new Promise((res, rej) => {
            this.mp4boxFile.onError = rej;
            this.mp4boxFile.onReady = res;
        });

        let offset = 0, resolved = false;
        ready.then(() => resolved = true);

        while (offset < this.fileSize && !resolved) {
            const buf = await this.readChunk(offset, 1024 * 1024);
            buf.fileStart = offset;
            const next = this.mp4boxFile.appendBuffer(buf);
            offset = next === undefined ? offset + buf.byteLength : next;
            await new Promise(r => setTimeout(r, 0));
        }

        const info = await ready;
        if (!info.videoTracks.length) throw new Error('No video tracks');

        this.videoTrack = info.videoTracks[0];
        const trak = this.mp4boxFile.getTrackById(this.videoTrack.id);
        const desc = this.getCodecDesc(trak);

        const codec = this.videoTrack.codec.startsWith('vp08') ? 'vp8' : this.videoTrack.codec;
        this.config = { codec, codedWidth: this.videoTrack.video.width, codedHeight: this.videoTrack.video.height };
        if (desc) this.config.description = desc;

        const support = await window.VideoDecoder.isConfigSupported(this.config);
        if (!support.supported) throw new Error(`Codec ${codec} not supported`);

        this.extractSamples();
        const dur = this.videoTrack.duration / this.videoTrack.timescale;
        this.fps = this.samples.length / dur;

        return {
            codec,
            width: this.videoTrack.video.width,
            height: this.videoTrack.video.height,
            totalFrames: this.samples.length,
            fps: this.fps
        };
    }

    async readChunk(off, size) {
        const end = Math.min(off + size, this.fileSize);

        if (this.url && this.supportsRangeRequests) {
            // Use HTTP range request for URL streaming
            const response = await fetch(this.url, {
                headers: { 'Range': `bytes=${off}-${end - 1}` }
            });
            return await response.arrayBuffer();
        } else {
            // Use File/Blob slice for local files
            return await this.file.slice(off, end).arrayBuffer();
        }
    }

    getCodecDesc(trak) {
        for (const e of trak.mdia.minf.stbl.stsd.entries) {
            const box = e.avcC || e.hvcC || e.vpcC || e.av1C;
            if (box) {
                const s = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
                box.write(s);
                return new Uint8Array(s.buffer, 8);
            }
        }
        return null;
    }

    extractSamples() {
        const info = this.mp4boxFile.getTrackSamplesInfo(this.videoTrack.id);
        if (!info?.length) throw new Error('No samples');
        const ts = this.videoTrack.timescale;
        this.samples = info.map((s, i) => ({
            offset: s.offset,
            size: s.size,
            timestamp: s.cts * 1e6 / ts,
            duration: s.duration * 1e6 / ts,
            isKeyframe: s.is_sync,
            cts: s.cts,
            decodeIndex: i
        })).sort((a, b) => a.cts - b.cts);
        this.samples.forEach((s, i) => { if (s.isKeyframe) this.keyframeIndices.push(i); });
    }

    findKeyframeBefore(idx) {
        let r = 0;
        for (const k of this.keyframeIndices) {
            if (k <= idx) r = k;
            else break;
        }
        return r;
    }

    async getFrame(idx) {
        if (idx < 0 || idx >= this.samples.length) return null;

        if (this.cache.has(idx)) {
            const bmp = this.cache.get(idx);
            this.cache.delete(idx);
            this.cache.set(idx, bmp); // Move to end (LRU)
            return { bitmap: bmp, fromCache: true };
        }

        if (this.isDecoding) {
            await new Promise(r => {
                const c = () => this.isDecoding ? setTimeout(c, 10) : r();
                c();
            });
            if (this.cache.has(idx)) return { bitmap: this.cache.get(idx), fromCache: true };
        }

        const kf = this.findKeyframeBefore(idx);
        const end = Math.min(idx + this.lookahead, this.samples.length - 1);
        await this.decodeRange(kf, end, idx);
        const bmp = this.cache.get(idx);
        return bmp ? { bitmap: bmp, fromCache: false } : null;
    }

    async decodeRange(start, end, target) {
        this.isDecoding = true;
        try {
            if (this.decoder) try { this.decoder.close(); } catch (e) {}

            let minDI = Infinity, maxDI = -Infinity;
            for (let i = start; i <= end; i++) {
                minDI = Math.min(minDI, this.samples[i].decodeIndex);
                maxDI = Math.max(maxDI, this.samples[i].decodeIndex);
            }

            const toFeed = [];
            for (let i = 0; i < this.samples.length; i++) {
                const s = this.samples[i];
                if (s.decodeIndex >= minDI && s.decodeIndex <= maxDI) toFeed.push({ pi: i, s });
            }
            toFeed.sort((a, b) => a.s.decodeIndex - b.s.decodeIndex);

            const dataMap = new Map();
            for (const { s } of toFeed) {
                dataMap.set(s.decodeIndex, new Uint8Array(await this.readChunk(s.offset, s.size)));
            }

            const tsMap = new Map();
            for (const { pi, s } of toFeed) tsMap.set(Math.round(s.timestamp), pi);

            const halfC = Math.floor(this.cacheSize / 2);
            const cStart = Math.max(start, target - halfC);
            const cEnd = Math.min(end, target + halfC);

            await new Promise((res, rej) => {
                let cnt = 0;
                this.decoder = new window.VideoDecoder({
                    output: f => {
                        let fi = tsMap.get(Math.round(f.timestamp));
                        if (fi === undefined) {
                            let best = Infinity;
                            for (const [t, i] of tsMap) {
                                const d = Math.abs(t - f.timestamp);
                                if (d < best) { best = d; fi = i; }
                            }
                        }
                        if (fi !== undefined && fi >= cStart && fi <= cEnd) {
                            createImageBitmap(f).then(b => {
                                this.addToCache(fi, b);
                                f.close();
                                if (++cnt >= toFeed.length) res();
                            }).catch(() => {
                                f.close();
                                if (++cnt >= toFeed.length) res();
                            });
                        } else {
                            f.close();
                            if (++cnt >= toFeed.length) res();
                        }
                    },
                    error: e => e.name === 'AbortError' ? res() : rej(e)
                });

                this.decoder.configure(this.config);

                for (const { s } of toFeed) {
                    this.decoder.decode(new EncodedVideoChunk({
                        type: s.isKeyframe ? 'key' : 'delta',
                        timestamp: s.timestamp,
                        duration: s.duration,
                        data: dataMap.get(s.decodeIndex)
                    }));
                }
                this.decoder.flush();
            });
        } finally {
            this.isDecoding = false;
        }
    }

    addToCache(idx, bmp) {
        if (this.cache.size >= this.cacheSize) {
            const first = this.cache.keys().next().value;
            this.cache.get(first).close();
            this.cache.delete(first);
        }
        this.cache.set(idx, bmp);
    }

    close() {
        if (this.decoder) this.decoder.close();
        for (const b of this.cache.values()) b.close();
        this.cache.clear();
    }
}

// ============================================
// VideoPlayer - High-level player with UI integration
// ============================================
class VideoPlayer {
    /**
     * Create a video player
     * @param {Object} options
     * @param {HTMLElement} options.container - Container element for the canvas
     * @param {HTMLCanvasElement} [options.canvas] - Optional existing canvas element
     * @param {number} [options.cacheSize=60] - Number of frames to cache
     * @param {number} [options.lookahead=30] - Frames to decode ahead
     * @param {Function} [options.onFrameChange] - Callback(frameIndex, totalFrames) after frame changes
     * @param {Function} [options.renderOverlay] - Callback(ctx, info) to render overlays after frame
     * @param {Function} [options.onLog] - Callback(message, level) for logging
     */
    constructor(options) {
        this.container = options.container;
        this.canvas = options.canvas || this.container.querySelector('canvas');
        if (!this.canvas) {
            this.canvas = document.createElement('canvas');
            this.container.appendChild(this.canvas);
        }
        this.ctx = this.canvas.getContext('2d');

        this.decoder = null;
        this.currentFrame = 0;
        this.totalFrames = 0;
        this.fps = 30;
        this.isPlaying = false;
        this.playInterval = null;
        this.currentBitmap = null;

        // Zoom/pan state
        this.scale = 1;
        this.offsetX = 0;
        this.offsetY = 0;

        // Drag state
        this._isDragging = false;
        this._dragStartX = 0;
        this._dragStartY = 0;

        // Options
        this.cacheSize = options.cacheSize || 60;
        this.lookahead = options.lookahead || 30;

        // Callbacks
        this.onFrameChange = options.onFrameChange || null;
        this.renderOverlay = options.renderOverlay || null;
        this.onLog = options.onLog || null;

        // Bind methods for event listeners
        this._onMouseDown = this._onMouseDown.bind(this);
        this._onMouseMove = this._onMouseMove.bind(this);
        this._onMouseUp = this._onMouseUp.bind(this);
        this._onWheel = this._onWheel.bind(this);

        this._setupEventListeners();
    }

    _log(msg, level = 'info') {
        if (this.onLog) this.onLog(msg, level);
    }

    _setupEventListeners() {
        // Pan with mouse drag
        this.container.addEventListener('mousedown', this._onMouseDown);
        document.addEventListener('mousemove', this._onMouseMove);
        document.addEventListener('mouseup', this._onMouseUp);

        // Zoom with wheel
        this.container.addEventListener('wheel', this._onWheel);
    }

    _onMouseDown(e) {
        this._isDragging = true;
        this._dragStartX = e.clientX - this.offsetX;
        this._dragStartY = e.clientY - this.offsetY;
    }

    _onMouseMove(e) {
        if (this._isDragging) {
            this.offsetX = e.clientX - this._dragStartX;
            this.offsetY = e.clientY - this._dragStartY;
            this.render();
        }
    }

    _onMouseUp() {
        this._isDragging = false;
    }

    _onWheel(e) {
        e.preventDefault();
        const delta = Math.max(-100, Math.min(100, e.deltaY));
        const zoomFactor = Math.exp(-delta * 0.002);
        this.scale = Math.max(0.1, Math.min(50, this.scale * zoomFactor));
        this.render();
    }

    /**
     * Load a video from a File or URL
     * @param {File|string} source - Video file or URL
     * @returns {Promise<Object>} Video info { codec, width, height, totalFrames, fps }
     */
    async load(source) {
        if (this.decoder) {
            this.decoder.close();
        }

        this._log('Loading video...', 'info');

        this.decoder = new VideoDecoderWrapper({
            cacheSize: this.cacheSize,
            lookahead: this.lookahead,
            onLog: this.onLog
        });

        const info = await this.decoder.init(source);

        this.totalFrames = info.totalFrames;
        this.fps = info.fps;
        this.currentFrame = 0;
        this.scale = 1;
        this.offsetX = 0;
        this.offsetY = 0;

        this._log(`Video loaded: ${info.width}x${info.height}, ${info.totalFrames} frames, ${info.fps.toFixed(1)} fps`, 'success');

        // Load first frame
        await this.seek(0);

        return info;
    }

    /**
     * Get video geometry for coordinate transforms
     * @returns {Object} { baseScale, drawX, drawY, effectiveScale }
     */
    getVideoGeometry() {
        if (!this.currentBitmap) return { baseScale: 1, drawX: 0, drawY: 0, effectiveScale: 1 };

        const containerWidth = this.container.clientWidth;
        const containerHeight = this.container.clientHeight;
        const videoAspect = this.currentBitmap.width / this.currentBitmap.height;
        const containerAspect = containerWidth / containerHeight;

        let baseScale, drawX, drawY;
        if (videoAspect > containerAspect) {
            baseScale = containerWidth / this.currentBitmap.width;
            drawX = 0;
            drawY = (containerHeight - this.currentBitmap.height * baseScale) / 2;
        } else {
            baseScale = containerHeight / this.currentBitmap.height;
            drawX = (containerWidth - this.currentBitmap.width * baseScale) / 2;
            drawY = 0;
        }

        return {
            baseScale,
            drawX,
            drawY,
            effectiveScale: baseScale * this.scale
        };
    }

    /**
     * Render the current frame to canvas
     */
    render() {
        if (!this.currentBitmap) return;

        const dpr = window.devicePixelRatio || 1;
        const containerWidth = this.container.clientWidth;
        const containerHeight = this.container.clientHeight;

        if (this.canvas.width !== containerWidth * dpr || this.canvas.height !== containerHeight * dpr) {
            this.canvas.width = containerWidth * dpr;
            this.canvas.height = containerHeight * dpr;
        }

        const { baseScale, drawX, drawY, effectiveScale } = this.getVideoGeometry();

        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.save();
        this.ctx.scale(dpr, dpr);
        this.ctx.imageSmoothingEnabled = effectiveScale < 2;
        this.ctx.translate(this.offsetX, this.offsetY);
        this.ctx.translate(drawX, drawY);
        this.ctx.scale(effectiveScale, effectiveScale);
        this.ctx.drawImage(this.currentBitmap, 0, 0);
        this.ctx.restore();

        // Render overlay if provided
        if (this.renderOverlay) {
            this.renderOverlay(this.ctx, {
                bitmap: this.currentBitmap,
                frameIndex: this.currentFrame,
                totalFrames: this.totalFrames,
                scale: this.scale,
                offsetX: this.offsetX,
                offsetY: this.offsetY,
                baseScale,
                drawX,
                drawY,
                effectiveScale,
                dpr,
                containerWidth,
                containerHeight
            });
        }
    }

    /**
     * Seek to a specific frame
     * @param {number} frameIndex - Frame to seek to (wraps around)
     * @returns {Promise<boolean>} True if successful
     */
    async seek(frameIndex) {
        if (!this.decoder) return false;

        // Wrap around
        if (this.totalFrames > 0) {
            frameIndex = ((frameIndex % this.totalFrames) + this.totalFrames) % this.totalFrames;
        }

        const result = await this.decoder.getFrame(frameIndex);
        if (result && result.bitmap) {
            this.currentFrame = frameIndex;
            this.currentBitmap = result.bitmap;
            this.render();

            if (this.onFrameChange) {
                this.onFrameChange(this.currentFrame, this.totalFrames);
            }

            return true;
        }

        return false;
    }

    /**
     * Start playback
     */
    play() {
        if (!this.decoder || this.isPlaying) return;

        this.isPlaying = true;
        this._log('Playback started', 'info');

        this.playInterval = setInterval(async () => {
            await this.seek(this.currentFrame + 1);
        }, 1000 / this.fps);
    }

    /**
     * Pause playback
     */
    pause() {
        if (!this.isPlaying) return;

        this.isPlaying = false;
        if (this.playInterval) {
            clearInterval(this.playInterval);
            this.playInterval = null;
        }
        this._log('Playback paused', 'info');
    }

    /**
     * Toggle playback
     */
    toggle() {
        if (this.isPlaying) {
            this.pause();
        } else {
            this.play();
        }
    }

    /**
     * Set zoom level
     * @param {number} newScale - Zoom scale (1 = 100%)
     */
    setZoom(newScale) {
        this.scale = Math.max(0.1, Math.min(50, newScale));
        this.render();
    }

    /**
     * Reset view to default zoom and pan
     */
    resetView() {
        this.scale = 1;
        this.offsetX = 0;
        this.offsetY = 0;
        this.render();
    }

    /**
     * Get current frame index
     */
    get frame() {
        return this.currentFrame;
    }

    /**
     * Get total frame count
     */
    get frames() {
        return this.totalFrames;
    }

    /**
     * Get current bitmap
     */
    get bitmap() {
        return this.currentBitmap;
    }

    /**
     * Get playback state
     */
    get playing() {
        return this.isPlaying;
    }

    /**
     * Get current zoom level
     */
    get zoom() {
        return this.scale;
    }

    /**
     * Clean up resources
     */
    destroy() {
        this.pause();

        // Remove event listeners
        this.container.removeEventListener('mousedown', this._onMouseDown);
        document.removeEventListener('mousemove', this._onMouseMove);
        document.removeEventListener('mouseup', this._onMouseUp);
        this.container.removeEventListener('wheel', this._onWheel);

        if (this.decoder) {
            this.decoder.close();
            this.decoder = null;
        }

        this.currentBitmap = null;
    }
}

// ============================================
// SeekbarController - Debounced seekbar scrubbing
// ============================================
class SeekbarController {
    /**
     * Create a seekbar controller with debounced scrubbing
     * @param {Object} options
     * @param {HTMLElement} options.seekbar - Seekbar track element
     * @param {HTMLElement} options.progress - Progress fill element
     * @param {HTMLElement} options.thumb - Thumb element
     * @param {Function} options.onSeek - Callback(frameIndex) when seeking
     * @param {Function} options.getTotal - Function returning total frames
     */
    constructor(options) {
        this.seekbar = options.seekbar;
        this.progress = options.progress;
        this.thumb = options.thumb;
        this.onSeek = options.onSeek;
        this.getTotal = options.getTotal;

        this._isScrubbing = false;
        this._pendingFrame = null;
        this._isSeeking = false;

        this._onMouseDown = this._onMouseDown.bind(this);
        this._onMouseMove = this._onMouseMove.bind(this);
        this._onMouseUp = this._onMouseUp.bind(this);

        this.seekbar.addEventListener('mousedown', this._onMouseDown);
        document.addEventListener('mousemove', this._onMouseMove);
        document.addEventListener('mouseup', this._onMouseUp);
    }

    _onMouseDown(e) {
        e.preventDefault();
        this._isScrubbing = true;
        document.body.style.userSelect = 'none';
        this._handleSeek(e);
    }

    _onMouseMove(e) {
        if (this._isScrubbing) {
            this._handleSeek(e);
        }
    }

    _onMouseUp() {
        if (this._isScrubbing) {
            document.body.style.userSelect = '';
            this._isScrubbing = false;
        }
    }

    async _handleSeek(e) {
        const rect = this.seekbar.getBoundingClientRect();
        const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
        const total = this.getTotal();
        const frame = total > 1 ? Math.round((x / rect.width) * (total - 1)) : 0;

        // Immediate visual feedback
        this.update(frame, total);

        // Debounced actual seeking
        this._pendingFrame = frame;
        if (this._isSeeking) return;

        this._isSeeking = true;
        while (this._pendingFrame !== null) {
            const targetFrame = this._pendingFrame;
            this._pendingFrame = null;
            await this.onSeek(targetFrame);
        }
        this._isSeeking = false;
    }

    /**
     * Update seekbar visual position
     * @param {number} frame - Current frame
     * @param {number} total - Total frames
     */
    update(frame, total) {
        const p = total > 1 ? (frame / (total - 1)) * 100 : 0;
        this.progress.style.width = p + '%';
        this.thumb.style.left = p + '%';
    }

    /**
     * Clean up event listeners
     */
    destroy() {
        this.seekbar.removeEventListener('mousedown', this._onMouseDown);
        document.removeEventListener('mousemove', this._onMouseMove);
        document.removeEventListener('mouseup', this._onMouseUp);
    }
}
