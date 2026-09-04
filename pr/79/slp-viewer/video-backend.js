/**
 * VideoBackend - Abstract interface for video frame providers
 *
 * This module defines a common interface for accessing video frames regardless
 * of the underlying source (embedded HDF5 frames, MP4 files, etc.).
 *
 * Architecture:
 *   VideoBackend (abstract interface)
 *   ├── HDF5VideoBackend - For embedded frames in pkg.slp files
 *   └── MediaVideoBackend - For external MP4/WebM files (wraps VideoPlayer)
 *
 * Usage:
 *   const backend = new HDF5VideoBackend(worker, videoInfo);
 *   const frame = await backend.getFrame(frameIndex);
 *   if (frame) {
 *       ctx.drawImage(frame.bitmap, 0, 0);
 *   }
 *
 * @module video-backend
 */

/**
 * @typedef {Object} FrameResult
 * @property {ImageBitmap} bitmap - Decoded frame ready for canvas
 * @property {number} frameIndex - The embedded frame index that was requested
 * @property {number} displayFrame - The display frame number
 * @property {boolean} fromCache - Whether frame was served from cache
 */

/**
 * Abstract base class for video backends
 * @abstract
 */
class VideoBackend {
    constructor() {
        if (new.target === VideoBackend) {
            throw new Error('VideoBackend is abstract and cannot be instantiated directly');
        }
    }

    /**
     * Total number of frames available
     * @type {number}
     * @abstract
     */
    get frameCount() {
        throw new Error('Not implemented');
    }

    /**
     * Video dimensions
     * @type {{width: number, height: number}}
     * @abstract
     */
    get dimensions() {
        throw new Error('Not implemented');
    }

    /**
     * Frames per second (may be estimated for embedded videos)
     * @type {number}
     */
    get fps() {
        return 30; // Default
    }

    /**
     * Backend type identifier
     * @type {string}
     * @abstract
     */
    get type() {
        throw new Error('Not implemented');
    }

    /**
     * Get a frame as ImageBitmap (async)
     * @param {number} frameIndex - Frame to retrieve
     * @returns {Promise<FrameResult|null>} Frame result, or null if unavailable
     * @abstract
     */
    async getFrame(frameIndex) {
        throw new Error('Not implemented');
    }

    /**
     * Get a frame synchronously (from cache only)
     * @param {number} frameIndex - Frame to retrieve
     * @returns {FrameResult|null} Frame result if cached, null otherwise
     */
    getFrameSync(frameIndex) {
        return null; // Default: no sync access
    }

    /**
     * Check if a specific frame is available
     * @param {number} frameIndex - Frame index to check
     * @returns {boolean}
     */
    hasFrame(frameIndex) {
        return frameIndex >= 0 && frameIndex < this.frameCount;
    }

    /**
     * Preload frames for look-ahead buffering
     * @param {number} startFrame - Start of range to preload
     * @param {number} endFrame - End of range to preload
     * @returns {Promise<void>}
     */
    async preload(startFrame, endFrame) {
        // Default: no-op. Subclasses can implement.
    }

    /**
     * Release resources
     * @abstract
     */
    close() {
        throw new Error('Not implemented');
    }
}

/**
 * Video backend for embedded HDF5 frames in pkg.slp files
 *
 * Works with a frame-worker.js instance that uses SLPPackageReader.
 */
class HDF5VideoBackend extends VideoBackend {
    /**
     * Create an HDF5VideoBackend
     *
     * @param {Worker} worker - Web Worker running frame-worker.js
     * @param {Object} videoInfo - Video metadata from SLPPackageReader.getVideos()
     * @param {Object} [options]
     * @param {number} [options.cacheSize=60] - Number of decoded frames to cache
     */
    constructor(worker, videoInfo, options = {}) {
        super();

        /** @type {Worker} */
        this._worker = worker;

        /** @type {Object} Video metadata */
        this._videoInfo = videoInfo;

        /** @type {number} */
        this._cacheSize = options.cacheSize || 60;

        /** @type {Map<number, ImageBitmap>} LRU frame cache (embeddedIdx -> bitmap) */
        this._cache = new Map();

        /** @type {Map<number, {promise: Promise, resolve: Function, reject: Function}>} Pending frame requests */
        this._pending = new Map();

        /** @type {Function|null} Message handler */
        this._messageHandler = null;

        /** @type {boolean} */
        this._closed = false;

        this._setupWorkerListener();
    }

    get frameCount() {
        return this._videoInfo.frameCount;
    }

    get dimensions() {
        return {
            width: this._videoInfo.width,
            height: this._videoInfo.height
        };
    }

    get type() {
        return 'hdf5';
    }

    /**
     * Get the video key (e.g., 'video0')
     * @type {string}
     */
    get videoKey() {
        return this._videoInfo.key;
    }

    /**
     * Get the frame_numbers mapping
     * @type {number[]}
     */
    get frameNumbers() {
        return this._videoInfo.frameNumbers;
    }

    /**
     * Get the display frame for an embedded index
     * @param {number} embeddedIdx
     * @returns {number}
     */
    getDisplayFrame(embeddedIdx) {
        return this._videoInfo.frameNumbers[embeddedIdx] ?? embeddedIdx;
    }

    /**
     * Get the embedded index for a display frame
     * @param {number} displayFrame
     * @returns {number} -1 if not found
     */
    getEmbeddedIndex(displayFrame) {
        return this._videoInfo.frameNumbers.indexOf(displayFrame);
    }

    /**
     * Set up listener for worker messages
     * @private
     */
    _setupWorkerListener() {
        this._messageHandler = (e) => {
            if (e.data.type === 'frame' && e.data.videoKey === this._videoInfo.key) {
                this._handleFrameResult(e.data);
            }
        };
        this._worker.addEventListener('message', this._messageHandler);
    }

    /**
     * Handle frame result from worker
     * @private
     */
    async _handleFrameResult(data) {
        const { embeddedIdx, displayFrame, pngBytes, format } = data;

        // Resolve pending promise if exists
        const pending = this._pending.get(embeddedIdx);
        if (pending) {
            try {
                // Decode PNG to ImageBitmap
                const blob = new Blob([pngBytes], { type: `image/${format || 'png'}` });
                const bitmap = await createImageBitmap(blob);

                // Add to cache
                this._addToCache(embeddedIdx, bitmap);

                // Resolve
                pending.resolve({
                    bitmap: bitmap,
                    frameIndex: embeddedIdx,
                    displayFrame: displayFrame,
                    fromCache: false
                });
            } catch (err) {
                pending.reject(err);
            }
            this._pending.delete(embeddedIdx);
        }
    }

    /**
     * Add frame to LRU cache
     * @private
     */
    _addToCache(embeddedIdx, bitmap) {
        // Evict oldest if at capacity
        if (this._cache.size >= this._cacheSize) {
            const oldestKey = this._cache.keys().next().value;
            const oldBitmap = this._cache.get(oldestKey);
            if (oldBitmap) {
                oldBitmap.close();
            }
            this._cache.delete(oldestKey);
        }
        this._cache.set(embeddedIdx, bitmap);
    }

    /**
     * Get a frame by embedded index (async)
     *
     * @param {number} embeddedIdx - Embedded frame index (0 to frameCount-1)
     * @returns {Promise<FrameResult|null>}
     */
    async getFrame(embeddedIdx) {
        if (this._closed) return null;
        if (embeddedIdx < 0 || embeddedIdx >= this.frameCount) {
            return null;
        }

        // Check cache first
        if (this._cache.has(embeddedIdx)) {
            const bitmap = this._cache.get(embeddedIdx);
            // Move to end (LRU update)
            this._cache.delete(embeddedIdx);
            this._cache.set(embeddedIdx, bitmap);

            return {
                bitmap: bitmap,
                frameIndex: embeddedIdx,
                displayFrame: this.getDisplayFrame(embeddedIdx),
                fromCache: true
            };
        }

        // Check if already pending
        if (this._pending.has(embeddedIdx)) {
            return this._pending.get(embeddedIdx).promise;
        }

        // Request from worker
        let resolve, reject;
        const promise = new Promise((res, rej) => {
            resolve = res;
            reject = rej;
        });
        this._pending.set(embeddedIdx, { promise, resolve, reject });

        this._worker.postMessage({
            type: 'getFrame',
            videoKey: this._videoInfo.key,
            embeddedIdx: embeddedIdx
        });

        return promise;
    }

    /**
     * Get a frame synchronously (from cache only)
     *
     * @param {number} embeddedIdx - Embedded frame index
     * @returns {FrameResult|null} Frame if cached, null otherwise
     */
    getFrameSync(embeddedIdx) {
        if (this._closed) return null;
        if (embeddedIdx < 0 || embeddedIdx >= this.frameCount) {
            return null;
        }

        if (this._cache.has(embeddedIdx)) {
            const bitmap = this._cache.get(embeddedIdx);
            // Move to end (LRU update)
            this._cache.delete(embeddedIdx);
            this._cache.set(embeddedIdx, bitmap);

            return {
                bitmap: bitmap,
                frameIndex: embeddedIdx,
                displayFrame: this.getDisplayFrame(embeddedIdx),
                fromCache: true
            };
        }

        // Trigger async fetch but don't wait
        if (!this._pending.has(embeddedIdx)) {
            this.getFrame(embeddedIdx);
        }

        return null;
    }

    /**
     * Preload a range of frames
     *
     * @param {number} startFrame - Start of range
     * @param {number} endFrame - End of range (inclusive)
     * @returns {Promise<void>}
     */
    async preload(startFrame, endFrame) {
        if (this._closed) return;

        const promises = [];
        for (let i = startFrame; i <= endFrame && i < this.frameCount; i++) {
            if (!this._cache.has(i) && !this._pending.has(i)) {
                promises.push(this.getFrame(i));
            }
        }

        // Wait for all frames to load
        await Promise.allSettled(promises);
    }

    /**
     * Get a frame by display frame number
     *
     * @param {number} displayFrame - Original video frame number
     * @returns {Promise<FrameResult|null>} Null if frame not embedded
     */
    async getFrameByDisplay(displayFrame) {
        const embeddedIdx = this.getEmbeddedIndex(displayFrame);
        if (embeddedIdx === -1) {
            return null;
        }
        return this.getFrame(embeddedIdx);
    }

    /**
     * Check if a display frame exists
     * @param {number} displayFrame
     * @returns {boolean}
     */
    hasDisplayFrame(displayFrame) {
        return this.getEmbeddedIndex(displayFrame) !== -1;
    }

    /**
     * Clear the frame cache
     */
    clearCache() {
        for (const bitmap of this._cache.values()) {
            bitmap.close();
        }
        this._cache.clear();
    }

    /**
     * Release resources
     */
    close() {
        if (this._closed) return;
        this._closed = true;

        if (this._messageHandler) {
            this._worker.removeEventListener('message', this._messageHandler);
            this._messageHandler = null;
        }
        this.clearCache();

        // Reject pending requests
        for (const pending of this._pending.values()) {
            pending.reject(new Error('Backend closed'));
        }
        this._pending.clear();
    }
}

/**
 * Video backend wrapping an existing VideoDecoderWrapper
 *
 * This provides a consistent interface for MP4/WebM videos decoded via WebCodecs.
 */
class MediaVideoBackend extends VideoBackend {
    /**
     * Create a MediaVideoBackend
     *
     * @param {Object} decoder - VideoDecoderWrapper or similar with getFrame(idx)
     */
    constructor(decoder) {
        super();

        /** @type {Object} */
        this._decoder = decoder;
    }

    get frameCount() {
        return this._decoder.samples?.length || 0;
    }

    get dimensions() {
        return {
            width: this._decoder.config?.codedWidth || 0,
            height: this._decoder.config?.codedHeight || 0
        };
    }

    get fps() {
        return this._decoder.fps || 30;
    }

    get type() {
        return 'media';
    }

    /**
     * Get a frame
     * @param {number} frameIndex
     * @returns {Promise<FrameResult|null>}
     */
    async getFrame(frameIndex) {
        if (!this._decoder) return null;

        const result = await this._decoder.getFrame(frameIndex);
        if (!result || !result.bitmap) {
            return null;
        }
        return {
            bitmap: result.bitmap,
            frameIndex: frameIndex,
            displayFrame: frameIndex,
            fromCache: result.fromCache
        };
    }

    /**
     * Get a frame synchronously (from cache only)
     * @param {number} frameIndex
     * @returns {FrameResult|null}
     */
    getFrameSync(frameIndex) {
        if (!this._decoder) return null;

        const result = this._decoder.getFrameSync(frameIndex);
        if (!result || !result.bitmap) {
            return null;
        }
        return {
            bitmap: result.bitmap,
            frameIndex: frameIndex,
            displayFrame: frameIndex,
            fromCache: true
        };
    }

    /**
     * Preload a range of frames
     * @param {number} startFrame
     * @param {number} endFrame
     * @returns {Promise<void>}
     */
    async preload(startFrame, endFrame) {
        // VideoDecoderWrapper handles prefetching internally via decodeRange
        // Just request the first frame to trigger prefetch
        if (this._decoder && startFrame < this.frameCount) {
            await this._decoder.getFrame(startFrame);
        }
    }

    hasFrame(frameIndex) {
        return frameIndex >= 0 && frameIndex < this.frameCount;
    }

    close() {
        if (this._decoder && typeof this._decoder.close === 'function') {
            this._decoder.close();
        }
        this._decoder = null;
    }
}

/**
 * Factory function to create the appropriate backend for a video
 *
 * @param {Object} options
 * @param {string} options.type - 'hdf5' or 'media'
 * @param {Worker} [options.worker] - Required for hdf5 type
 * @param {Object} [options.videoInfo] - Required for hdf5 type
 * @param {Object} [options.decoder] - Required for media type
 * @param {number} [options.cacheSize] - Cache size for HDF5 backend
 * @returns {VideoBackend}
 */
function createVideoBackend(options) {
    switch (options.type) {
        case 'hdf5':
            if (!options.worker || !options.videoInfo) {
                throw new Error('HDF5 backend requires worker and videoInfo');
            }
            return new HDF5VideoBackend(options.worker, options.videoInfo, options);

        case 'media':
            if (!options.decoder) {
                throw new Error('Media backend requires decoder');
            }
            return new MediaVideoBackend(options.decoder);

        default:
            throw new Error(`Unknown backend type: ${options.type}`);
    }
}

// Export for different module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { VideoBackend, HDF5VideoBackend, MediaVideoBackend, createVideoBackend };
} else if (typeof window !== 'undefined') {
    window.VideoBackend = VideoBackend;
    window.HDF5VideoBackend = HDF5VideoBackend;
    window.MediaVideoBackend = MediaVideoBackend;
    window.createVideoBackend = createVideoBackend;
}
