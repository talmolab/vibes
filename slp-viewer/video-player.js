/**
 * Video Player - Frame-accurate video playback with WebCodecs
 *
 * Provides a reusable video player with:
 * - Frame-accurate seeking via WebCodecs API
 * - LRU frame caching with lookahead
 * - Zoom/pan with mouse and touch support
 * - Overlay rendering hooks
 * - Debounced seekbar scrubbing
 * - OffscreenCanvas mode for stutter-free playback (when supported)
 */

// ============================================
// Feature Detection
// ============================================
const supportsOffscreenCanvas = (() => {
    try {
        const testCanvas = document.createElement('canvas');
        return typeof testCanvas.transferControlToOffscreen === 'function';
    } catch (e) {
        return false;
    }
})();

// ============================================
// Performance Timing Utility
// ============================================
class PerfTimer {
    constructor() {
        this.marks = new Map();
        this.measures = [];
        this.enabled = true;
    }

    mark(name) {
        if (!this.enabled) return;
        this.marks.set(name, performance.now());
    }

    measure(name, startMark, endMark) {
        if (!this.enabled) return 0;
        const start = this.marks.get(startMark);
        const end = endMark ? this.marks.get(endMark) : performance.now();
        if (start === undefined) return 0;
        const duration = end - start;
        this.measures.push({ name, duration, timestamp: Date.now() });
        // Keep only last 100 measures
        if (this.measures.length > 100) this.measures.shift();
        return duration;
    }

    getStats() {
        const stats = {};
        for (const m of this.measures) {
            if (!stats[m.name]) stats[m.name] = { count: 0, total: 0, min: Infinity, max: 0 };
            stats[m.name].count++;
            stats[m.name].total += m.duration;
            stats[m.name].min = Math.min(stats[m.name].min, m.duration);
            stats[m.name].max = Math.max(stats[m.name].max, m.duration);
        }
        for (const name in stats) {
            stats[name].avg = stats[name].total / stats[name].count;
        }
        return stats;
    }

    clear() {
        this.marks.clear();
        this.measures = [];
    }
}

// Global perf timer instance
const perfTimer = new PerfTimer();

// ============================================
// VideoDecoderWrapper - Low-level decoder with caching
// ============================================
class VideoDecoderWrapper {
    constructor(opts = {}) {
        this.cacheSize = opts.cacheSize || 60;
        this.lookahead = opts.lookahead || 60;
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

        // Performance tracking
        this.lastSeekTime = 0;
        this.lastFromCache = false;
        this.lastDecodeStats = null;

        // Pending frame queue - skip stale requests during rapid seeking
        this.pendingFrame = null;

        // Prefetch state
        this.prefetchRequested = false;
        this.lastAccessedFrame = -1;
        this.accessDirection = 1; // 1 = forward, -1 = backward
        this._prefetchInterval = null;
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

    /**
     * Read sample data with batching - groups contiguous samples into single reads
     * This dramatically reduces HTTP requests for range-based streaming
     */
    async readSampleDataByDecodeOrder(samplesToFeed) {
        const results = new Map();
        let totalBytes = 0;
        let totalRequests = 0;

        // samplesToFeed is already sorted by decodeIndex
        // Group samples that are contiguous in the file for batch reading
        let i = 0;
        while (i < samplesToFeed.length) {
            const first = samplesToFeed[i];
            let regionEnd = i;
            let regionBytes = first.s.size;

            // Extend region while samples are contiguous in file
            while (regionEnd < samplesToFeed.length - 1) {
                const current = samplesToFeed[regionEnd];
                const next = samplesToFeed[regionEnd + 1];

                // Check if next sample immediately follows current in file
                if (next.s.offset === current.s.offset + current.s.size) {
                    regionEnd++;
                    regionBytes += next.s.size;
                } else {
                    break;
                }
            }

            // Read the entire contiguous region in one request
            const buffer = await this.readChunk(first.s.offset, regionBytes);
            const bufferView = new Uint8Array(buffer);
            totalBytes += regionBytes;
            totalRequests++;

            // Extract individual samples from the batch
            let bufferOffset = 0;
            for (let j = i; j <= regionEnd; j++) {
                const { pi, s } = samplesToFeed[j];
                results.set(s.decodeIndex, bufferView.slice(bufferOffset, bufferOffset + s.size));
                bufferOffset += s.size;
            }

            i = regionEnd + 1;
        }

        return { results, totalBytes, totalRequests };
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

    hasFrame(idx) {
        return this.cache.has(idx);
    }

    getFrameSync(idx) {
        if (idx < 0 || idx >= this.samples.length) return null;

        // Update access tracking (same as getFrame)
        if (this.lastAccessedFrame >= 0) {
            const delta = idx - this.lastAccessedFrame;
            if (delta > 0) this.accessDirection = 1;
            else if (delta < 0) this.accessDirection = -1;
        }
        this.lastAccessedFrame = idx;

        if (this.cache.has(idx)) {
            const bmp = this.cache.get(idx);
            this.cache.delete(idx);
            this.cache.set(idx, bmp); // LRU update
            this.lastFromCache = true;
            this.lastSeekTime = 0.1; // Near-instant
            return { bitmap: bmp, fromCache: true };
        }
        // Trigger background decode but don't wait
        if (!this.isDecoding) {
            this.getFrame(idx); // Fire and forget only if not already decoding
        }
        this.lastFromCache = false;
        return null;
    }

    async getFrame(idx) {
        perfTimer.mark('getFrame_start');
        const getFrameStart = performance.now();

        if (idx < 0 || idx >= this.samples.length) return null;

        // Track access direction for prefetching
        if (this.lastAccessedFrame >= 0) {
            const delta = idx - this.lastAccessedFrame;
            if (delta > 0) this.accessDirection = 1;
            else if (delta < 0) this.accessDirection = -1;
        }
        this.lastAccessedFrame = idx;

        // Check cache first
        if (this.cache.has(idx)) {
            const bmp = this.cache.get(idx);
            this.cache.delete(idx);
            this.cache.set(idx, bmp); // Move to end (LRU)
            this.lastSeekTime = performance.now() - getFrameStart;
            this.lastFromCache = true;
            perfTimer.measure('getFrame_cacheHit', 'getFrame_start');

            // Trigger background prefetch if we're getting close to cache edge
            this.maybeStartPrefetch(idx);

            return { bitmap: bmp, fromCache: true };
        }

        // If currently decoding, queue this frame and wait
        if (this.isDecoding) {
            this.pendingFrame = idx;
            perfTimer.mark('waitForDecode_start');
            const waitStart = performance.now();

            // Wait for current decode to finish
            await new Promise(r => {
                const c = () => this.isDecoding ? setTimeout(c, 10) : r();
                c();
            });

            const waitTime = performance.now() - waitStart;
            perfTimer.measure('waitForDecode', 'waitForDecode_start');

            // Check cache again - might have been decoded
            if (this.cache.has(idx)) {
                const bmp = this.cache.get(idx);
                this.cache.delete(idx);
                this.cache.set(idx, bmp);
                this.lastSeekTime = performance.now() - getFrameStart;
                this.lastFromCache = true;
                return { bitmap: bmp, fromCache: true };
            }

            // If there's a newer pending frame, skip this one (stale request)
            if (this.pendingFrame !== null && this.pendingFrame !== idx) {
                return null;
            }
        }

        const kf = this.findKeyframeBefore(idx);
        const end = Math.min(idx + this.lookahead, this.samples.length - 1);

        this._log(`Decode range: keyframe=${kf} -> end=${end} (${end - kf + 1} frames) for target ${idx}`, 'info');

        await this.decodeRange(kf, end, idx);

        const bmp = this.cache.get(idx);
        this.lastSeekTime = performance.now() - getFrameStart;
        this.lastFromCache = false;
        perfTimer.measure('getFrame_decode', 'getFrame_start');

        return bmp ? { bitmap: bmp, fromCache: false } : null;
    }

    /**
     * Check if we should start prefetching ahead
     */
    maybeStartPrefetch(currentFrame) {
        if (this.isDecoding || this.prefetchRequested) return;

        // Find the edge of cached frames in the access direction
        let cachedAhead = 0;
        if (this.accessDirection > 0) {
            // Moving forward - count cached frames ahead
            for (let i = currentFrame + 1; i < this.samples.length && this.cache.has(i); i++) {
                cachedAhead++;
            }
        } else {
            // Moving backward - count cached frames behind
            for (let i = currentFrame - 1; i >= 0 && this.cache.has(i); i++) {
                cachedAhead++;
            }
        }

        // Trigger prefetch when less than 2/3 of lookahead is cached (more aggressive)
        if (cachedAhead < (this.lookahead * 2 / 3)) {
            this.prefetchRequested = true;
            // Use setTimeout to not block the current frame return
            setTimeout(() => this.prefetch(currentFrame), 0);
        }
    }

    /**
     * Prefetch frames in the current access direction
     */
    async prefetch(fromFrame) {
        if (this.isDecoding) {
            this.prefetchRequested = false;
            return;
        }

        const direction = this.accessDirection;
        let targetFrame;

        if (direction > 0) {
            // Find first uncached frame ahead
            targetFrame = fromFrame + 1;
            while (targetFrame < this.samples.length && this.cache.has(targetFrame)) {
                targetFrame++;
            }
            if (targetFrame >= this.samples.length) {
                this.prefetchRequested = false;
                return;
            }
        } else {
            // Find first uncached frame behind
            targetFrame = fromFrame - 1;
            while (targetFrame >= 0 && this.cache.has(targetFrame)) {
                targetFrame--;
            }
            if (targetFrame < 0) {
                this.prefetchRequested = false;
                return;
            }
        }

        // Decode a range around the target
        const keyframe = this.findKeyframeBefore(targetFrame);
        const endFrame = Math.min(targetFrame + this.lookahead, this.samples.length - 1);

        this._log(`Prefetch: keyframe=${keyframe} -> end=${endFrame} for target ${targetFrame}`, 'info');

        await this.decodeRange(keyframe, endFrame, targetFrame);
        this.prefetchRequested = false;
    }

    async decodeRange(start, end, target) {
        perfTimer.mark('decodeRange_start');
        const decodeRangeStart = performance.now();
        this.isDecoding = true;

        const stats = {
            framesToDecode: 0,
            bytesToRead: 0,
            readRequests: 0,
            readTime: 0,
            decodeTime: 0,
            bitmapTime: 0,
        };

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

            stats.framesToDecode = toFeed.length;

            // Read sample data with batching - groups contiguous samples
            perfTimer.mark('readSamples_start');
            const readStart = performance.now();
            const { results: dataMap, totalBytes, totalRequests } = await this.readSampleDataByDecodeOrder(toFeed);
            stats.bytesToRead = totalBytes;
            stats.readRequests = totalRequests;
            stats.readTime = performance.now() - readStart;
            perfTimer.measure('readSamples', 'readSamples_start');
            this._log(`Read ${toFeed.length} samples in ${totalRequests} batches (${(totalBytes / 1024).toFixed(0)} KB) in ${stats.readTime.toFixed(0)}ms`, 'info');

            const tsMap = new Map();
            for (const { pi, s } of toFeed) tsMap.set(Math.round(s.timestamp), pi);

            const halfC = Math.floor(this.cacheSize / 2);
            const cStart = Math.max(start, target - halfC);
            const cEnd = Math.min(end, target + halfC);

            perfTimer.mark('decode_start');
            const decodeStart = performance.now();

            // Set up decoder with completion tracking
            let cnt = 0;
            let bitmapTimeTotal = 0;
            let resolveComplete, rejectComplete;
            const completionPromise = new Promise((res, rej) => {
                resolveComplete = res;
                rejectComplete = rej;
            });

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
                        const bmpStart = performance.now();
                        createImageBitmap(f).then(b => {
                            bitmapTimeTotal += performance.now() - bmpStart;
                            this.addToCache(fi, b);
                            f.close();
                            if (++cnt >= toFeed.length) {
                                stats.bitmapTime = bitmapTimeTotal;
                                resolveComplete();
                            }
                        }).catch(() => {
                            f.close();
                            if (++cnt >= toFeed.length) resolveComplete();
                        });
                    } else {
                        f.close();
                        if (++cnt >= toFeed.length) resolveComplete();
                    }
                },
                error: e => e.name === 'AbortError' ? resolveComplete() : rejectComplete(e)
            });

            this.decoder.configure(this.config);

            // Feed chunks in batches with yielding to prevent blocking render
            const BATCH_SIZE = 15;
            for (let i = 0; i < toFeed.length; i += BATCH_SIZE) {
                const batch = toFeed.slice(i, i + BATCH_SIZE);
                for (const { s } of batch) {
                    this.decoder.decode(new EncodedVideoChunk({
                        type: s.isKeyframe ? 'key' : 'delta',
                        timestamp: s.timestamp,
                        duration: s.duration,
                        data: dataMap.get(s.decodeIndex)
                    }));
                }
                // Yield to event loop every batch to let render loop run
                if (i + BATCH_SIZE < toFeed.length) {
                    await new Promise(r => setTimeout(r, 0));
                }
            }
            this.decoder.flush();

            // Wait for all frames to be processed
            await completionPromise;

            stats.decodeTime = performance.now() - decodeStart;
            perfTimer.measure('decode', 'decode_start');

            const totalTime = performance.now() - decodeRangeStart;
            this._log(`Decode complete: ${stats.framesToDecode} frames in ${totalTime.toFixed(0)}ms (read: ${stats.readTime.toFixed(0)}ms, decode: ${stats.decodeTime.toFixed(0)}ms, bitmap: ${stats.bitmapTime.toFixed(0)}ms)`, 'success');

            this.lastDecodeStats = stats;
            perfTimer.measure('decodeRange', 'decodeRange_start');
        } finally {
            this.isDecoding = false;

            // Check for pending prefetch request and trigger it
            if (this._pendingPrefetchTarget !== null && this._pendingPrefetchTarget !== undefined) {
                const target = this._pendingPrefetchTarget;
                this._pendingPrefetchTarget = null;
                // Use setTimeout to avoid recursion and let the event loop breathe
                setTimeout(() => {
                    if (!this.isDecoding && target < this.samples.length) {
                        this._log(`Executing queued prefetch: frame ${target}`, 'info');
                        this.getFrame(target);
                    }
                }, 10);
            }
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

    /**
     * Start continuous prefetch loop during playback
     */
    _startPrefetchLoop() {
        if (this._prefetchInterval) return;
        this._pendingPrefetchTarget = null;

        this._prefetchInterval = setInterval(() => {
            // Prefetch ahead of current playback position
            const currentFrame = this.lastAccessedFrame;
            if (currentFrame < 0) return;

            const cacheEnd = this._findCacheEnd(currentFrame);
            const framesAhead = cacheEnd - currentFrame;

            // If we have less than 40 frames ahead cached, we need to prefetch
            if (framesAhead < 40 && cacheEnd + 1 < this.samples.length) {
                const prefetchTarget = cacheEnd + 1;

                // If already decoding, just remember we need to prefetch this target
                if (this.isDecoding) {
                    if (this._pendingPrefetchTarget !== prefetchTarget) {
                        this._pendingPrefetchTarget = prefetchTarget;
                        this._log(`Queued prefetch: frame ${prefetchTarget} (${framesAhead} frames ahead, decoding...)`, 'info');
                    }
                    return;
                }

                // Not decoding - start prefetch now
                this._pendingPrefetchTarget = null;
                this._log(`Proactive prefetch: frame ${prefetchTarget} (${framesAhead} frames ahead)`, 'info');
                this.getFrame(prefetchTarget); // Fire and forget
            }
        }, 50); // Check every 50ms for more responsive prefetching
    }

    /**
     * Stop prefetch loop
     */
    _stopPrefetchLoop() {
        if (this._prefetchInterval) {
            clearInterval(this._prefetchInterval);
            this._prefetchInterval = null;
        }
    }

    /**
     * Find the last consecutive cached frame starting from fromFrame
     */
    _findCacheEnd(fromFrame) {
        let end = fromFrame;
        while (end < this.samples.length && this.cache.has(end)) {
            end++;
        }
        return end - 1;
    }

    /**
     * Bidirectional prefetch around a frame (for scrubbing)
     */
    _prefetchAround(frameIndex) {
        if (this.isDecoding) return;

        const prefetchRadius = 30; // Frames before and after

        // Find first uncached frame ahead
        for (let i = 1; i <= prefetchRadius; i++) {
            const ahead = frameIndex + i;
            if (ahead < this.samples.length && !this.cache.has(ahead)) {
                this._log(`Bidirectional prefetch ahead: frame ${ahead}`, 'info');
                this.getFrame(ahead);
                return; // One prefetch at a time
            }
        }

        // If all ahead are cached, try behind
        for (let i = 1; i <= prefetchRadius; i++) {
            const behind = frameIndex - i;
            if (behind >= 0 && !this.cache.has(behind)) {
                this._log(`Bidirectional prefetch behind: frame ${behind}`, 'info');
                this.getFrame(behind);
                return;
            }
        }
    }

    close() {
        this._stopPrefetchLoop();
        if (this.decoder) this.decoder.close();
        for (const b of this.cache.values()) b.close();
        this.cache.clear();
    }
}

// ============================================
// OffscreenVideoController - Worker-based decoder/renderer
// ============================================
class OffscreenVideoController {
    /**
     * Controller that delegates decoding and rendering to a Web Worker
     * using OffscreenCanvas. Zero frame transfers during playback.
     */
    constructor(opts = {}) {
        this.worker = null;
        this.canvas = null;
        this.offscreen = null;
        this.onLog = opts.onLog || null;
        this.onFrameChange = opts.onFrameChange || null;
        this.onReady = opts.onReady || null;
        this.onTransformUpdate = opts.onTransformUpdate || null;

        // Mimic VideoDecoderWrapper properties for compatibility
        this.samples = [];
        this.cache = { size: 0 };
        this.cacheSize = opts.cacheSize || 120;
        this.lastSeekTime = 0;
        this.lastFromCache = true;
        this.lastDecodeStats = null;
        this.isDecoding = false;
        this.fps = 30;

        // State synced from worker
        this._currentFrame = 0;
        this._totalFrames = 0;
        this._cacheSize = 0;
        this._isPlaying = false;
        this._stutterCount = 0;

        // Transform state (main thread is source of truth for zoom/pan calculations)
        this.scale = 1;
        this.offsetX = 0;
        this.offsetY = 0;
        this.baseScale = 1;
        this.drawX = 0;
        this.drawY = 0;
        this.videoWidth = 0;
        this.videoHeight = 0;

        // Pending operations
        this._initPromise = null;
        this._initResolve = null;
        this._seekResolve = null;

        this._boundOnMessage = this._onMessage.bind(this);
    }

    _log(msg, level = 'info') {
        if (this.onLog) this.onLog(msg, level);
    }

    _onMessage(e) {
        const { type, ...data } = e.data;

        switch (type) {
            case 'ready':
                this.fps = data.fps;
                this.videoWidth = data.width;
                this.videoHeight = data.height;
                this._totalFrames = data.totalFrames;
                this.samples = new Array(data.totalFrames); // Placeholder for length
                if (this._initResolve) {
                    this._initResolve(data);
                    this._initResolve = null;
                }
                break;

            case 'status':
                this._currentFrame = data.currentFrame ?? this._currentFrame;
                this._totalFrames = data.totalFrames ?? this._totalFrames;
                this._cacheSize = data.cacheSize ?? this._cacheSize;
                this._isPlaying = data.isPlaying ?? this._isPlaying;
                this._stutterCount = data.stutterCount ?? this._stutterCount;
                this.isDecoding = data.isDecoding ?? this.isDecoding;
                this.cache.size = this._cacheSize;

                if (data.phase === 'ready' && this.onReady) {
                    this.onReady();
                }

                if (this.onFrameChange && data.currentFrame !== undefined) {
                    this.onFrameChange(data.currentFrame, this._totalFrames);
                }

                // If we were waiting for a seek to complete
                if (this._seekResolve && !this.isDecoding) {
                    this._seekResolve();
                    this._seekResolve = null;
                }
                break;

            case 'transformInfo':
                this.baseScale = data.baseScale;
                this.drawX = data.drawX;
                this.drawY = data.drawY;
                this.videoWidth = data.videoWidth || this.videoWidth;
                this.videoHeight = data.videoHeight || this.videoHeight;
                // Trigger callback so overlay can re-render with updated geometry
                if (this.onTransformUpdate) {
                    this.onTransformUpdate();
                }
                break;

            case 'timingAnalysis':
                this._log(`Timing: ${data.stutterCount} stutters in ${data.totalFrames} frames`,
                    data.stutterCount > 5 ? 'warn' : 'success');
                break;

            case 'log':
                this._log(data.message, data.level);
                break;

            case 'error':
                this._log(`Worker error: ${data.error}`, 'error');
                break;
        }
    }

    async init(source, canvas, containerWidth, containerHeight) {
        this.canvas = canvas;

        // Transfer canvas control to worker
        this.offscreen = canvas.transferControlToOffscreen();

        // Determine worker path - try to find it relative to current script
        let workerUrl = 'video-offscreen-worker.js';
        try {
            // Try to get path from current script element
            const scripts = document.getElementsByTagName('script');
            for (const script of scripts) {
                if (script.src && script.src.includes('video-player.js')) {
                    workerUrl = script.src.replace('video-player.js', 'video-offscreen-worker.js');
                    break;
                }
            }
        } catch (e) {
            // Fallback to relative path
        }
        this.worker = new Worker(workerUrl);
        this.worker.onmessage = this._boundOnMessage;
        this.worker.onerror = (e) => {
            this._log(`Worker error: ${e.message}`, 'error');
        };

        const dpr = window.devicePixelRatio || 1;

        // Create init promise
        this._initPromise = new Promise((resolve) => {
            this._initResolve = resolve;
        });

        // Send init message with canvas
        const initMsg = {
            type: 'init',
            canvas: this.offscreen,
            width: containerWidth * dpr,
            height: containerHeight * dpr,
            dpr: dpr
        };

        if (typeof source === 'string') {
            initMsg.videoUrl = source;
        } else {
            initMsg.videoFile = source;
        }

        this.worker.postMessage(initMsg, [this.offscreen]);

        // Wait for ready
        const info = await this._initPromise;
        this._log(`OffscreenCanvas mode active: ${info.width}x${info.height}, ${info.totalFrames} frames`, 'success');

        return info;
    }

    play() {
        if (this.worker) {
            this.worker.postMessage({ type: 'play' });
        }
    }

    pause() {
        if (this.worker) {
            this.worker.postMessage({ type: 'pause' });
        }
    }

    async seek(frameIndex) {
        if (!this.worker) return;

        // Create a promise that resolves when seek completes
        const seekPromise = new Promise((resolve) => {
            this._seekResolve = resolve;
        });

        this.worker.postMessage({ type: 'seek', frame: frameIndex });

        // Wait briefly for seek, but don't block indefinitely
        await Promise.race([
            seekPromise,
            new Promise(r => setTimeout(r, 100))
        ]);
    }

    resize(width, height) {
        if (this.worker) {
            const dpr = window.devicePixelRatio || 1;
            this.worker.postMessage({
                type: 'resize',
                width: width * dpr,
                height: height * dpr,
                dpr: dpr
            });
        }
    }

    setTransform(scale, offsetX, offsetY) {
        this.scale = scale;
        this.offsetX = offsetX;
        this.offsetY = offsetY;
        if (this.worker) {
            this.worker.postMessage({
                type: 'setTransform',
                scale,
                offsetX,
                offsetY
            });
        }
    }

    resetTransform() {
        this.scale = 1;
        this.offsetX = 0;
        this.offsetY = 0;
        if (this.worker) {
            this.worker.postMessage({ type: 'resetTransform' });
        }
    }

    getTransformInfo() {
        // Return current transform info for zoom calculations
        return {
            scale: this.scale,
            offsetX: this.offsetX,
            offsetY: this.offsetY,
            baseScale: this.baseScale,
            drawX: this.drawX,
            drawY: this.drawY,
            videoWidth: this.videoWidth,
            videoHeight: this.videoHeight
        };
    }

    get currentFrame() {
        return this._currentFrame;
    }

    get totalFrames() {
        return this._totalFrames;
    }

    get isPlaying() {
        return this._isPlaying;
    }

    get stutterCount() {
        return this._stutterCount;
    }

    close() {
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }
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
     * @param {boolean} [options.showTimingOverlay=false] - Show timing stats overlay
     * @param {boolean} [options.useOffscreenCanvas=true] - Use OffscreenCanvas mode if supported
     */
    constructor(options) {
        this.container = options.container;

        // Determine if we should use OffscreenCanvas mode
        const preferOffscreen = options.useOffscreenCanvas !== false;
        this.useOffscreenCanvas = preferOffscreen && supportsOffscreenCanvas;

        // Set up canvases
        this.canvas = options.canvas || this.container.querySelector('canvas');
        if (!this.canvas) {
            this.canvas = document.createElement('canvas');
            this.canvas.style.position = 'absolute';
            this.canvas.style.top = '0';
            this.canvas.style.left = '0';
            this.canvas.style.width = '100%';
            this.canvas.style.height = '100%';
            this.container.appendChild(this.canvas);
        }

        // For OffscreenCanvas mode, we need a separate overlay canvas
        this.overlayCanvas = null;
        this.overlayCtx = null;
        if (this.useOffscreenCanvas) {
            this.overlayCanvas = document.createElement('canvas');
            this.overlayCanvas.style.position = 'absolute';
            this.overlayCanvas.style.top = '0';
            this.overlayCanvas.style.left = '0';
            this.overlayCanvas.style.width = '100%';
            this.overlayCanvas.style.height = '100%';
            this.overlayCanvas.style.pointerEvents = 'none'; // Let events pass through
            this.container.appendChild(this.overlayCanvas);
            this.overlayCtx = this.overlayCanvas.getContext('2d');
            // Note: this.ctx will be null in OffscreenCanvas mode (canvas transferred to worker)
            this.ctx = null;
        } else {
            this.ctx = this.canvas.getContext('2d');
        }

        // OffscreenCanvas controller (used instead of decoder when in OffscreenCanvas mode)
        this.offscreenController = null;

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

        // Drag state (mouse)
        this._isDragging = false;
        this._dragStartX = 0;
        this._dragStartY = 0;

        // Touch state (single finger pan)
        this._touchStartX = null;
        this._touchStartY = null;
        this._touchStartOffsetX = null;
        this._touchStartOffsetY = null;

        // Pinch zoom state
        this._initialPinchDistance = null;
        this._initialPinchScale = null;
        this._pinchCenterX = null;
        this._pinchCenterY = null;

        // Container size tracking for resize handling
        this._lastContainerWidth = 0;
        this._lastContainerHeight = 0;
        this._resizeObserver = null;

        // Options
        this.cacheSize = options.cacheSize || 60;
        this.lookahead = options.lookahead || 30;
        this.showTimingOverlay = options.showTimingOverlay || false;

        // Callbacks
        this.onFrameChange = options.onFrameChange || null;
        this.renderOverlay = options.renderOverlay || null;
        this.onLog = options.onLog || null;

        // Bind methods for event listeners
        this._onMouseDown = this._onMouseDown.bind(this);
        this._onMouseMove = this._onMouseMove.bind(this);
        this._onMouseUp = this._onMouseUp.bind(this);
        this._onWheel = this._onWheel.bind(this);
        this._onTouchStart = this._onTouchStart.bind(this);
        this._onTouchMove = this._onTouchMove.bind(this);
        this._onTouchEnd = this._onTouchEnd.bind(this);

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

        // Touch events for mobile
        this.container.addEventListener('touchstart', this._onTouchStart, { passive: false });
        this.container.addEventListener('touchmove', this._onTouchMove, { passive: false });
        this.container.addEventListener('touchend', this._onTouchEnd);

        // Handle container resize to keep view stable
        this._resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const newWidth = entry.contentRect.width;
                const newHeight = entry.contentRect.height;

                // Skip initial observation or if size hasn't changed
                if (this._lastContainerWidth === 0 ||
                    (newWidth === this._lastContainerWidth && newHeight === this._lastContainerHeight)) {
                    this._lastContainerWidth = newWidth;
                    this._lastContainerHeight = newHeight;
                    continue;
                }

                this._handleContainerResize(this._lastContainerWidth, this._lastContainerHeight, newWidth, newHeight);
                this._lastContainerWidth = newWidth;
                this._lastContainerHeight = newHeight;
                this.render();
            }
        });
        this._resizeObserver.observe(this.container);
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
            this._constrainOffset();
            this._syncTransformToWorker();
            this.render();
        }
    }

    _onMouseUp() {
        this._isDragging = false;
    }

    _onWheel(e) {
        e.preventDefault();

        // Get cursor position relative to container
        const rect = this.container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // Normalize deltaY for different input devices (mouse vs trackpad)
        let delta = e.deltaY;
        if (e.deltaMode === 1) delta *= 40; // line mode
        delta = Math.max(-100, Math.min(100, delta)); // Clamp to prevent huge jumps

        // Exponential scaling: ~10% zoom per 100px of scroll
        const zoomFactor = Math.exp(-delta * 0.001);
        const newScale = Math.max(0.1, Math.min(50, this.scale * zoomFactor));

        // Zoom towards cursor position
        this._zoomToPoint(mouseX, mouseY, newScale);
        this._syncTransformToWorker();
        this.render();
    }

    // ============================================
    // Touch event handlers
    // ============================================

    _getTouchDistance(touches) {
        const dx = touches[0].clientX - touches[1].clientX;
        const dy = touches[0].clientY - touches[1].clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    _getTouchCenter(touches, rect) {
        return {
            x: (touches[0].clientX + touches[1].clientX) / 2 - rect.left,
            y: (touches[0].clientY + touches[1].clientY) / 2 - rect.top
        };
    }

    _onTouchStart(e) {
        if (e.touches.length === 2) {
            // Pinch-to-zoom start
            e.preventDefault();
            this._initialPinchDistance = this._getTouchDistance(e.touches);
            this._initialPinchScale = this.scale;
            const rect = this.container.getBoundingClientRect();
            const center = this._getTouchCenter(e.touches, rect);
            this._pinchCenterX = center.x;
            this._pinchCenterY = center.y;
            // Clear single-finger pan state to prevent snap when lifting one finger
            this._touchStartX = null;
            this._touchStartY = null;
            this._touchStartOffsetX = null;
            this._touchStartOffsetY = null;
        } else if (e.touches.length === 1) {
            // Single-finger pan start
            this._touchStartX = e.touches[0].clientX;
            this._touchStartY = e.touches[0].clientY;
            this._touchStartOffsetX = this.offsetX;
            this._touchStartOffsetY = this.offsetY;
        }
    }

    _onTouchMove(e) {
        if (e.touches.length === 2 && this._initialPinchDistance !== null) {
            // Pinch-to-zoom
            e.preventDefault();
            const rect = this.container.getBoundingClientRect();
            const currentCenter = this._getTouchCenter(e.touches, rect);
            const currentDistance = this._getTouchDistance(e.touches);
            const pinchRatio = currentDistance / this._initialPinchDistance;
            const newScale = Math.max(0.1, Math.min(50, this._initialPinchScale * pinchRatio));

            // Zoom towards pinch center
            const { baseScale, drawX, drawY } = this.getVideoGeometry();
            const effectiveScale = baseScale * this.scale;
            const videoX = (this._pinchCenterX - this.offsetX - drawX) / effectiveScale;
            const videoY = (this._pinchCenterY - this.offsetY - drawY) / effectiveScale;

            const newEffectiveScale = baseScale * newScale;
            this.offsetX = this._pinchCenterX - drawX - videoX * newEffectiveScale;
            this.offsetY = this._pinchCenterY - drawY - videoY * newEffectiveScale;

            // Pan with pinch center movement
            this.offsetX += currentCenter.x - this._pinchCenterX;
            this.offsetY += currentCenter.y - this._pinchCenterY;
            this._pinchCenterX = currentCenter.x;
            this._pinchCenterY = currentCenter.y;

            this.scale = newScale;
            this._constrainOffset();
            this._syncTransformToWorker();
            this.render();
        } else if (e.touches.length === 1 && this._touchStartX !== null) {
            // Single-finger pan
            e.preventDefault();
            this.offsetX = this._touchStartOffsetX + (e.touches[0].clientX - this._touchStartX);
            this.offsetY = this._touchStartOffsetY + (e.touches[0].clientY - this._touchStartY);
            this._constrainOffset();
            this._syncTransformToWorker();
            this.render();
        }
    }

    _onTouchEnd(e) {
        if (e.touches.length < 2) {
            this._initialPinchDistance = null;
            this._initialPinchScale = null;
            this._pinchCenterX = null;
            this._pinchCenterY = null;
        }
        if (e.touches.length === 0) {
            this._touchStartX = null;
            this._touchStartY = null;
            this._touchStartOffsetX = null;
            this._touchStartOffsetY = null;
        }
    }

    // ============================================
    // Zoom and pan helpers
    // ============================================

    /**
     * Sync transform state to worker (for OffscreenCanvas mode)
     */
    _syncTransformToWorker() {
        if (this.useOffscreenCanvas && this.offscreenController) {
            this.offscreenController.setTransform(this.scale, this.offsetX, this.offsetY);
        }
    }

    /**
     * Constrain offset to keep at least 25% of image visible on each axis
     */
    _constrainOffset() {
        if (this.useOffscreenCanvas) {
            // In OffscreenCanvas mode, use controller's video dimensions
            if (!this.offscreenController) return;
            const { videoWidth, videoHeight, baseScale } = this.offscreenController.getTransformInfo();
            if (!videoWidth || !videoHeight) return;

            const containerWidth = this.container.clientWidth;
            const containerHeight = this.container.clientHeight;
            const videoAspect = videoWidth / videoHeight;
            const containerAspect = containerWidth / containerHeight;

            let drawX, drawY;
            if (videoAspect > containerAspect) {
                drawX = 0;
                drawY = (containerHeight - videoHeight * baseScale) / 2;
            } else {
                drawX = (containerWidth - videoWidth * baseScale) / 2;
                drawY = 0;
            }

            const scaledWidth = videoWidth * baseScale * this.scale;
            const scaledHeight = videoHeight * baseScale * this.scale;

            const minVisible = 0.25;
            const minVisibleX = scaledWidth * minVisible;
            const minVisibleY = scaledHeight * minVisible;

            const minOffsetX = minVisibleX - scaledWidth - drawX;
            const maxOffsetX = containerWidth - minVisibleX - drawX;
            const minOffsetY = minVisibleY - scaledHeight - drawY;
            const maxOffsetY = containerHeight - minVisibleY - drawY;

            this.offsetX = Math.max(minOffsetX, Math.min(maxOffsetX, this.offsetX));
            this.offsetY = Math.max(minOffsetY, Math.min(maxOffsetY, this.offsetY));
            return;
        }

        if (!this.currentBitmap) return;

        const containerWidth = this.container.clientWidth;
        const containerHeight = this.container.clientHeight;
        const { baseScale, drawX, drawY } = this.getVideoGeometry();

        const scaledWidth = this.currentBitmap.width * baseScale * this.scale;
        const scaledHeight = this.currentBitmap.height * baseScale * this.scale;

        // Require at least 25% visible on each axis
        const minVisible = 0.25;
        const minVisibleX = scaledWidth * minVisible;
        const minVisibleY = scaledHeight * minVisible;

        // Calculate bounds accounting for the centering offset (drawX, drawY)
        const minOffsetX = minVisibleX - scaledWidth - drawX;
        const maxOffsetX = containerWidth - minVisibleX - drawX;
        const minOffsetY = minVisibleY - scaledHeight - drawY;
        const maxOffsetY = containerHeight - minVisibleY - drawY;

        this.offsetX = Math.max(minOffsetX, Math.min(maxOffsetX, this.offsetX));
        this.offsetY = Math.max(minOffsetY, Math.min(maxOffsetY, this.offsetY));
    }

    /**
     * Zoom towards a specific point (in container coordinates)
     */
    _zoomToPoint(pointX, pointY, newScale) {
        const { baseScale, drawX, drawY } = this.getVideoGeometry();
        const effectiveScale = baseScale * this.scale;

        // Find video point under the target point
        const videoX = (pointX - this.offsetX - drawX) / effectiveScale;
        const videoY = (pointY - this.offsetY - drawY) / effectiveScale;

        // Calculate new offset to keep that video point at the same container position
        const newEffectiveScale = baseScale * newScale;
        this.offsetX = pointX - drawX - videoX * newEffectiveScale;
        this.offsetY = pointY - drawY - videoY * newEffectiveScale;

        this.scale = newScale;
        this._constrainOffset();
    }

    /**
     * Handle container resize to keep view stable
     */
    _handleContainerResize(oldW, oldH, newW, newH) {
        if (this.useOffscreenCanvas) {
            // In OffscreenCanvas mode, notify the worker of the resize
            if (this.offscreenController) {
                this.offscreenController.resize(newW, newH);
                // Also update overlay canvas size
                if (this.overlayCanvas) {
                    const dpr = window.devicePixelRatio || 1;
                    this.overlayCanvas.width = newW * dpr;
                    this.overlayCanvas.height = newH * dpr;
                }
            }
            return;
        }

        if (!this.currentBitmap || oldW === 0 || oldH === 0) return;

        const videoAspect = this.currentBitmap.width / this.currentBitmap.height;

        // Calculate old geometry
        const oldContainerAspect = oldW / oldH;
        let oldBaseScale, oldDrawX, oldDrawY;
        if (videoAspect > oldContainerAspect) {
            oldBaseScale = oldW / this.currentBitmap.width;
            oldDrawX = 0;
            oldDrawY = (oldH - this.currentBitmap.height * oldBaseScale) / 2;
        } else {
            oldBaseScale = oldH / this.currentBitmap.height;
            oldDrawX = (oldW - this.currentBitmap.width * oldBaseScale) / 2;
            oldDrawY = 0;
        }

        // Calculate new geometry
        const newContainerAspect = newW / newH;
        let newBaseScale, newDrawX, newDrawY;
        if (videoAspect > newContainerAspect) {
            newBaseScale = newW / this.currentBitmap.width;
            newDrawX = 0;
            newDrawY = (newH - this.currentBitmap.height * newBaseScale) / 2;
        } else {
            newBaseScale = newH / this.currentBitmap.height;
            newDrawX = (newW - this.currentBitmap.width * newBaseScale) / 2;
            newDrawY = 0;
        }

        // Find what video point was at old container center
        const oldCenterX = oldW / 2;
        const oldCenterY = oldH / 2;
        const oldEffectiveScale = oldBaseScale * this.scale;
        const videoCenterX = (oldCenterX - this.offsetX - oldDrawX) / oldEffectiveScale;
        const videoCenterY = (oldCenterY - this.offsetY - oldDrawY) / oldEffectiveScale;

        // Calculate new offset to put that video point at new container center
        const newCenterX = newW / 2;
        const newCenterY = newH / 2;
        const newEffectiveScale = newBaseScale * this.scale;
        this.offsetX = newCenterX - newDrawX - videoCenterX * newEffectiveScale;
        this.offsetY = newCenterY - newDrawY - videoCenterY * newEffectiveScale;

        this._constrainOffset();
    }

    /**
     * Load a video from a File or URL
     * @param {File|string} source - Video file or URL
     * @returns {Promise<Object>} Video info { codec, width, height, totalFrames, fps }
     */
    async load(source) {
        // Clean up previous decoder/controller
        if (this.decoder) {
            this.decoder.close();
            this.decoder = null;
        }
        if (this.offscreenController) {
            this.offscreenController.close();
            this.offscreenController = null;
        }

        this._log(`Loading video... (OffscreenCanvas: ${this.useOffscreenCanvas ? 'yes' : 'no'})`, 'info');

        // Initialize container size tracking for resize handling
        this._lastContainerWidth = this.container.clientWidth;
        this._lastContainerHeight = this.container.clientHeight;

        let info;

        if (this.useOffscreenCanvas) {
            // OffscreenCanvas mode - use worker-based controller
            this.offscreenController = new OffscreenVideoController({
                cacheSize: this.cacheSize,
                onLog: this.onLog,
                onFrameChange: (frame, total) => {
                    this.currentFrame = frame;
                    this.totalFrames = total;
                    if (this.onFrameChange) {
                        this.onFrameChange(frame, total);
                    }
                    // Render overlay when frame changes
                    this._renderOverlayOnly();
                },
                onTransformUpdate: () => {
                    // Re-render overlay when worker reports updated geometry (e.g., after resize)
                    this._renderOverlayOnly();
                }
            });

            info = await this.offscreenController.init(
                source,
                this.canvas,
                this.container.clientWidth,
                this.container.clientHeight
            );

            this.totalFrames = info.totalFrames;
            this.fps = info.fps;
            this.currentFrame = 0;

            // Sync transform state
            this.scale = 1;
            this.offsetX = 0;
            this.offsetY = 0;

        } else {
            // Traditional mode - use VideoDecoderWrapper
            this.decoder = new VideoDecoderWrapper({
                cacheSize: this.cacheSize,
                lookahead: this.lookahead,
                onLog: this.onLog
            });

            info = await this.decoder.init(source);

            this.totalFrames = info.totalFrames;
            this.fps = info.fps;
            this.currentFrame = 0;
            this.scale = 1;
            this.offsetX = 0;
            this.offsetY = 0;

            // Load first frame
            await this.seek(0);
        }

        this._log(`Video loaded: ${info.width}x${info.height}, ${info.totalFrames} frames, ${info.fps.toFixed(1)} fps`, 'success');

        return info;
    }

    /**
     * Render overlay only (for OffscreenCanvas mode)
     */
    _renderOverlayOnly() {
        if (!this.useOffscreenCanvas || !this.overlayCanvas || !this.renderOverlay) return;
        if (!this.offscreenController) return;

        const dpr = window.devicePixelRatio || 1;
        const containerWidth = this.container.clientWidth;
        const containerHeight = this.container.clientHeight;

        // Ensure overlay canvas is sized correctly
        if (this.overlayCanvas.width !== containerWidth * dpr ||
            this.overlayCanvas.height !== containerHeight * dpr) {
            this.overlayCanvas.width = containerWidth * dpr;
            this.overlayCanvas.height = containerHeight * dpr;
        }

        // Clear overlay
        this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);

        // Get transform info from controller
        // Note: Worker reports values in device pixels (canvas sized with DPR)
        // but overlay rendering uses ctx.scale(dpr, dpr), so we need CSS pixels
        const transform = this.offscreenController.getTransformInfo();

        // Convert device pixel values to CSS pixels for overlay rendering
        // baseScale, drawX, drawY from worker are in device pixels
        const baseScaleCSS = transform.baseScale / dpr;
        const drawXCSS = transform.drawX / dpr;
        const drawYCSS = transform.drawY / dpr;

        // Render overlay with CSS-pixel coordinates
        this.renderOverlay(this.overlayCtx, {
            bitmap: null, // No bitmap access in OffscreenCanvas mode
            frameIndex: this.currentFrame,
            totalFrames: this.totalFrames,
            scale: transform.scale,
            offsetX: transform.offsetX,
            offsetY: transform.offsetY,
            baseScale: baseScaleCSS,
            drawX: drawXCSS,
            drawY: drawYCSS,
            effectiveScale: baseScaleCSS * transform.scale,
            dpr,
            containerWidth,
            containerHeight
        });
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
        if (this.useOffscreenCanvas) {
            // In OffscreenCanvas mode, worker handles video rendering
            // We only render the overlay
            this._renderOverlayOnly();
            return;
        }

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

        // Render timing overlay if enabled
        if (this.showTimingOverlay && this.decoder) {
            this._renderTimingOverlay(dpr);
        }
    }

    /**
     * Render timing stats overlay in top-right corner
     */
    _renderTimingOverlay(dpr) {
        const ctx = this.ctx;
        const decoder = this.decoder;

        ctx.save();
        ctx.scale(dpr, dpr);

        const fontSize = 11;
        const lineHeight = 14;
        const padding = 8;
        const rightMargin = 10;
        const topMargin = 10;

        ctx.font = `${fontSize}px monospace`;

        // Build stats lines
        const lines = [];
        lines.push(`Seek: ${decoder.lastSeekTime.toFixed(1)}ms (${decoder.lastFromCache ? 'cache' : 'decode'})`);
        lines.push(`Cache: ${decoder.cache.size}/${decoder.cacheSize}`);

        if (decoder.lastDecodeStats) {
            const s = decoder.lastDecodeStats;
            lines.push(`Last decode: ${s.framesToDecode} frames`);
            lines.push(`  Read: ${s.readTime.toFixed(0)}ms (${s.readRequests} reqs, ${(s.bytesToRead/1024).toFixed(0)}KB)`);
            lines.push(`  Decode: ${s.decodeTime.toFixed(0)}ms`);
            lines.push(`  Bitmap: ${s.bitmapTime.toFixed(0)}ms`);
        }

        // Get perf stats
        const perfStats = perfTimer.getStats();
        if (Object.keys(perfStats).length > 0) {
            lines.push('--- Averages ---');
            for (const [name, stat] of Object.entries(perfStats)) {
                if (stat.count > 1) {
                    lines.push(`${name}: ${stat.avg.toFixed(1)}ms (n=${stat.count})`);
                }
            }
        }

        // Calculate box dimensions
        let maxWidth = 0;
        for (const line of lines) {
            maxWidth = Math.max(maxWidth, ctx.measureText(line).width);
        }
        const boxWidth = maxWidth + padding * 2;
        const boxHeight = lines.length * lineHeight + padding * 2;

        const containerWidth = this.container.clientWidth;
        const x = containerWidth - boxWidth - rightMargin;
        const y = topMargin;

        // Draw background
        ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
        ctx.fillRect(x, y, boxWidth, boxHeight);

        // Draw text
        ctx.fillStyle = '#4ade80';
        for (let i = 0; i < lines.length; i++) {
            const lineY = y + padding + (i + 1) * lineHeight - 3;
            const line = lines[i];
            // Color code
            if (line.includes('Read:')) ctx.fillStyle = '#fbbf24';
            else if (line.includes('Decode:')) ctx.fillStyle = '#667eea';
            else if (line.includes('Bitmap:')) ctx.fillStyle = '#f472b6';
            else if (line.includes('---')) ctx.fillStyle = '#888';
            else if (line.includes('Seek:')) ctx.fillStyle = decoder.lastFromCache ? '#4ade80' : '#fbbf24';
            else ctx.fillStyle = '#aaa';

            ctx.fillText(line, x + padding, lineY);
        }

        ctx.restore();
    }

    /**
     * Seek to a specific frame
     * @param {number} frameIndex - Frame to seek to (wraps around)
     * @returns {Promise<boolean>} True if successful
     */
    async seek(frameIndex) {
        // Wrap around
        if (this.totalFrames > 0) {
            frameIndex = ((frameIndex % this.totalFrames) + this.totalFrames) % this.totalFrames;
        }

        if (this.useOffscreenCanvas && this.offscreenController) {
            // OffscreenCanvas mode - send seek command to worker
            await this.offscreenController.seek(frameIndex);
            this.currentFrame = frameIndex;
            return true;
        }

        if (!this.decoder) return false;

        const result = await this.decoder.getFrame(frameIndex);
        if (result && result.bitmap) {
            this.currentFrame = frameIndex;
            this.currentBitmap = result.bitmap;
            this.render();

            if (this.onFrameChange) {
                this.onFrameChange(this.currentFrame, this.totalFrames);
            }

            // Trigger bidirectional prefetch around seek target (for scrubbing)
            if (!this.isPlaying) {
                this.decoder._prefetchAround(frameIndex);
            }

            return true;
        }

        return false;
    }

    /**
     * Start playback
     */
    play() {
        if (this.isPlaying) return;

        if (this.useOffscreenCanvas && this.offscreenController) {
            // OffscreenCanvas mode - worker handles playback
            this.offscreenController.play();
            this.isPlaying = true;
            this._log('Playback started (OffscreenCanvas)', 'info');
            return;
        }

        if (!this.decoder) return;
        this.isPlaying = true;
        this._lastPlayTime = performance.now();
        this._playbackFrame = this.currentFrame;
        this._log('Playback started', 'info');
        this.decoder._startPrefetchLoop();
        this._playLoop();
    }

    _playLoop() {
        if (!this.isPlaying) return;

        const now = performance.now();
        const elapsed = now - this._lastPlayTime;
        const frameDuration = 1000 / this.fps;

        if (elapsed >= frameDuration) {
            const framesToAdvance = Math.floor(elapsed / frameDuration);
            this._playbackFrame += framesToAdvance;

            // Wrap around
            if (this._playbackFrame >= this.totalFrames) {
                this._playbackFrame = this._playbackFrame % this.totalFrames;
            }

            // Try to get frame synchronously
            const result = this.decoder.getFrameSync(this._playbackFrame);
            if (result && result.bitmap) {
                this.currentFrame = this._playbackFrame;
                this.currentBitmap = result.bitmap;
                this.render();
                if (this.onFrameChange) {
                    this.onFrameChange(this.currentFrame, this.totalFrames);
                }
            }
            // If no frame available, skip it (prefetch will catch up)

            this._lastPlayTime = now - (elapsed % frameDuration);
        }

        requestAnimationFrame(() => this._playLoop());
    }

    /**
     * Pause playback
     */
    pause() {
        if (!this.isPlaying) return;

        this.isPlaying = false;

        if (this.useOffscreenCanvas && this.offscreenController) {
            // OffscreenCanvas mode - worker handles pause
            this.offscreenController.pause();
            this._log('Playback paused (OffscreenCanvas)', 'info');
            return;
        }

        if (this.playInterval) {
            clearInterval(this.playInterval);
            this.playInterval = null;
        }
        if (this.decoder) {
            this.decoder._stopPrefetchLoop();
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
     * Set zoom level (zooms towards center of container)
     * @param {number} newScale - Zoom scale (1 = 100%)
     */
    setZoom(newScale) {
        const centerX = this.container.clientWidth / 2;
        const centerY = this.container.clientHeight / 2;
        this._zoomToPoint(centerX, centerY, Math.max(0.1, Math.min(50, newScale)));
        this._syncTransformToWorker();
        this.render();
    }

    /**
     * Zoom by a factor (zooms towards center of container)
     * @param {number} factor - Zoom factor (>1 zoom in, <1 zoom out)
     */
    zoomBy(factor) {
        const newScale = Math.max(0.1, Math.min(50, this.scale * factor));
        this.setZoom(newScale);
    }

    /**
     * Reset view to default zoom and pan
     */
    resetView() {
        this.scale = 1;
        this.offsetX = 0;
        this.offsetY = 0;
        this._constrainOffset();
        if (this.useOffscreenCanvas && this.offscreenController) {
            this.offscreenController.resetTransform();
        }
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

        // Remove mouse event listeners
        this.container.removeEventListener('mousedown', this._onMouseDown);
        document.removeEventListener('mousemove', this._onMouseMove);
        document.removeEventListener('mouseup', this._onMouseUp);
        this.container.removeEventListener('wheel', this._onWheel);

        // Remove touch event listeners
        this.container.removeEventListener('touchstart', this._onTouchStart);
        this.container.removeEventListener('touchmove', this._onTouchMove);
        this.container.removeEventListener('touchend', this._onTouchEnd);

        // Disconnect resize observer
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }

        // Clean up OffscreenCanvas controller
        if (this.offscreenController) {
            this.offscreenController.close();
            this.offscreenController = null;
        }

        // Clean up overlay canvas
        if (this.overlayCanvas && this.overlayCanvas.parentNode) {
            this.overlayCanvas.parentNode.removeChild(this.overlayCanvas);
            this.overlayCanvas = null;
            this.overlayCtx = null;
        }

        if (this.decoder) {
            this.decoder._stopPrefetchLoop();
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
