/**
 * OffscreenCanvas Video Worker
 *
 * This worker owns:
 * - Video decoding (WebCodecs)
 * - Frame cache (Array-based for performance)
 * - Animation loop (requestAnimationFrame on OffscreenCanvas)
 * - Rendering with transform (zoom/pan)
 *
 * Main thread only sends commands (play, pause, seek, setTransform).
 * No ImageBitmap transfers during playback = no stutters.
 */

// Import mp4box.js for MP4 parsing
importScripts('https://cdn.jsdelivr.net/npm/mp4box@0.5.2/dist/mp4box.all.min.js');

// ============================================
// State
// ============================================
let canvas = null;
let ctx = null;
let videoInfo = null;
let samples = [];
let keyframeIndices = [];
let mp4boxFile = null;
let decoder = null;
let config = null;

// Cache - Array-based (proven 25% better than Map)
const CACHE_SIZE = 120;
let cache = new Array(CACHE_SIZE).fill(null);
let cacheValid = new Set();

// Playback state
let isPlaying = false;
let currentFrame = 0;
let fps = 30;
let lastFrameTime = 0;
let animationId = null;

// Decode state
let isDecoding = false;
let videoUrl = null;
let videoFile = null;
let fileSize = 0;
let supportsRangeRequests = false;
let lookahead = 60;

// Transform state (zoom/pan from main thread)
let scale = 1;
let offsetX = 0;  // CSS pixels from main thread
let offsetY = 0;  // CSS pixels from main thread
let baseScale = 1;
let drawX = 0;
let drawY = 0;
let devicePixelRatio = 1;  // Set during init

// Prefetch state
let prefetchRequested = false;
let lastAccessedFrame = -1;
let accessDirection = 1;

// Status update throttling
let lastStatusUpdate = 0;
const STATUS_UPDATE_INTERVAL = 50; // ms

// Timing instrumentation
let stutterCount = 0;
let frameTimings = [];

// ============================================
// Cache operations using Array
// ============================================
function getCacheIndex(frameIdx) {
    return frameIdx % CACHE_SIZE;
}

function addToCache(frameIdx, bitmap) {
    const idx = getCacheIndex(frameIdx);
    const existing = cache[idx];
    if (existing && existing.frameIdx !== frameIdx) {
        existing.bitmap.close();
        cacheValid.delete(existing.frameIdx);
    }
    cache[idx] = { frameIdx, bitmap };
    cacheValid.add(frameIdx);
}

function getFromCache(frameIdx) {
    if (!cacheValid.has(frameIdx)) return null;
    const slot = cache[getCacheIndex(frameIdx)];
    if (slot && slot.frameIdx === frameIdx) {
        return slot.bitmap;
    }
    cacheValid.delete(frameIdx);
    return null;
}

function clearCache() {
    for (let i = 0; i < cache.length; i++) {
        if (cache[i]) {
            cache[i].bitmap.close();
            cache[i] = null;
        }
    }
    cacheValid.clear();
}

// ============================================
// Status updates to main thread (throttled)
// ============================================
function sendStatus(force = false) {
    const now = performance.now();
    if (!force && now - lastStatusUpdate < STATUS_UPDATE_INTERVAL) return;
    lastStatusUpdate = now;

    self.postMessage({
        type: 'status',
        currentFrame,
        totalFrames: samples.length,
        cacheSize: cacheValid.size,
        isPlaying,
        isDecoding,
        stutterCount,
        fps: videoInfo?.fps || fps
    });
}

// ============================================
// File/URL reading
// ============================================
async function readChunk(offset, size) {
    const end = Math.min(offset + size, fileSize);

    if (videoUrl && supportsRangeRequests) {
        const response = await fetch(videoUrl, {
            headers: { 'Range': `bytes=${offset}-${end - 1}` }
        });
        return await response.arrayBuffer();
    } else if (videoFile) {
        return await videoFile.slice(offset, end).arrayBuffer();
    }
    throw new Error('No video source available');
}

// ============================================
// MP4 parsing helpers
// ============================================
function findKeyframeBefore(idx) {
    let result = 0;
    for (const k of keyframeIndices) {
        if (k <= idx) result = k;
        else break;
    }
    return result;
}

function extractSamples() {
    const info = mp4boxFile.getTrackSamplesInfo(videoInfo.id);
    if (!info?.length) throw new Error('No samples');

    const ts = videoInfo.timescale;
    samples = info.map((s, i) => ({
        offset: s.offset,
        size: s.size,
        timestamp: s.cts * 1e6 / ts,
        duration: s.duration * 1e6 / ts,
        isKeyframe: s.is_sync,
        cts: s.cts,
        decodeIndex: i
    })).sort((a, b) => a.cts - b.cts);

    keyframeIndices = [];
    samples.forEach((s, i) => {
        if (s.isKeyframe) keyframeIndices.push(i);
    });
}

function getCodecDesc(trak) {
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

// ============================================
// Video initialization
// ============================================
async function initVideo(source) {
    // Handle URL or File
    if (typeof source === 'string') {
        videoUrl = source;
        videoFile = null;

        const headResponse = await fetch(source, { method: 'HEAD' });
        if (!headResponse.ok) {
            throw new Error(`Failed to fetch video: ${headResponse.status}`);
        }

        fileSize = parseInt(headResponse.headers.get('Content-Length')) || 0;

        // Test range request support
        if (fileSize > 0) {
            try {
                const rangeTest = await fetch(source, {
                    method: 'GET',
                    headers: { 'Range': 'bytes=0-0' }
                });
                supportsRangeRequests = rangeTest.status === 206;
            } catch (e) {
                supportsRangeRequests = false;
            }
        }

        if (!supportsRangeRequests || !fileSize) {
            // Fall back to fetching entire file
            self.postMessage({ type: 'log', message: 'Downloading entire file (no range support)...', level: 'warn' });
            const response = await fetch(source);
            const blob = await response.blob();
            videoFile = new File([blob], 'video.mp4', { type: blob.type || 'video/mp4' });
            fileSize = videoFile.size;
            videoUrl = null;
        }
    } else {
        // File object
        videoFile = source;
        videoUrl = null;
        fileSize = source.size;
        supportsRangeRequests = false;
    }

    mp4boxFile = MP4Box.createFile();

    const ready = new Promise((resolve, reject) => {
        mp4boxFile.onError = reject;
        mp4boxFile.onReady = resolve;
    });

    // Stream file until parsed
    let offset = 0;
    let resolved = false;
    ready.then(() => resolved = true);

    while (offset < fileSize && !resolved) {
        const buf = await readChunk(offset, 1024 * 1024);
        buf.fileStart = offset;
        const next = mp4boxFile.appendBuffer(buf);
        offset = next === undefined ? offset + buf.byteLength : next;
        await new Promise(r => setTimeout(r, 0));
    }

    const info = await ready;
    if (!info.videoTracks.length) throw new Error('No video tracks');

    videoInfo = info.videoTracks[0];
    const trak = mp4boxFile.getTrackById(videoInfo.id);
    const desc = getCodecDesc(trak);

    const codec = videoInfo.codec.startsWith('vp08') ? 'vp8' : videoInfo.codec;
    config = {
        codec,
        codedWidth: videoInfo.video.width,
        codedHeight: videoInfo.video.height
    };
    if (desc) config.description = desc;

    const support = await VideoDecoder.isConfigSupported(config);
    if (!support.supported) throw new Error(`Codec ${codec} not supported`);

    extractSamples();

    const duration = videoInfo.duration / videoInfo.timescale;
    fps = samples.length / duration;

    return {
        codec,
        width: videoInfo.video.width,
        height: videoInfo.video.height,
        totalFrames: samples.length,
        fps
    };
}

// ============================================
// Decode operations
// ============================================
async function readSampleDataByDecodeOrder(samplesToFeed) {
    const results = new Map();
    let totalBytes = 0;
    let totalRequests = 0;

    let i = 0;
    while (i < samplesToFeed.length) {
        const first = samplesToFeed[i];
        let regionEnd = i;
        let regionBytes = first.s.size;

        // Extend region for contiguous samples
        while (regionEnd < samplesToFeed.length - 1) {
            const current = samplesToFeed[regionEnd];
            const next = samplesToFeed[regionEnd + 1];
            if (next.s.offset === current.s.offset + current.s.size) {
                regionEnd++;
                regionBytes += next.s.size;
            } else {
                break;
            }
        }

        const buffer = await readChunk(first.s.offset, regionBytes);
        const bufferView = new Uint8Array(buffer);
        totalBytes += regionBytes;
        totalRequests++;

        let bufferOffset = 0;
        for (let j = i; j <= regionEnd; j++) {
            const { s } = samplesToFeed[j];
            results.set(s.decodeIndex, bufferView.slice(bufferOffset, bufferOffset + s.size));
            bufferOffset += s.size;
        }

        i = regionEnd + 1;
    }

    return { results, totalBytes, totalRequests };
}

async function decodeRange(start, end, target) {
    if (isDecoding) return;
    isDecoding = true;
    sendStatus(true);

    try {
        if (decoder) {
            try { decoder.close(); } catch (e) {}
        }

        // Find decode order range
        let minDI = Infinity, maxDI = -Infinity;
        for (let i = start; i <= end; i++) {
            minDI = Math.min(minDI, samples[i].decodeIndex);
            maxDI = Math.max(maxDI, samples[i].decodeIndex);
        }

        const toFeed = [];
        for (let i = 0; i < samples.length; i++) {
            const s = samples[i];
            if (s.decodeIndex >= minDI && s.decodeIndex <= maxDI) {
                toFeed.push({ pi: i, s });
            }
        }
        toFeed.sort((a, b) => a.s.decodeIndex - b.s.decodeIndex);

        // Read sample data with batching
        const { results: dataMap } = await readSampleDataByDecodeOrder(toFeed);

        // Map timestamps to frame indices
        const tsMap = new Map();
        for (const { pi, s } of toFeed) {
            tsMap.set(Math.round(s.timestamp), pi);
        }

        // Determine cache window
        const halfC = Math.floor(CACHE_SIZE / 2);
        const cStart = Math.max(start, target - halfC);
        const cEnd = Math.min(end, target + halfC);

        // Decode
        let cnt = 0;
        let resolveComplete;
        const completionPromise = new Promise(r => resolveComplete = r);

        decoder = new VideoDecoder({
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
                        addToCache(fi, b);
                        f.close();
                        if (++cnt >= toFeed.length) resolveComplete();
                    }).catch(() => {
                        f.close();
                        if (++cnt >= toFeed.length) resolveComplete();
                    });
                } else {
                    f.close();
                    if (++cnt >= toFeed.length) resolveComplete();
                }
            },
            error: e => {
                if (e.name !== 'AbortError') console.error('Decode error:', e);
                resolveComplete();
            }
        });

        decoder.configure(config);

        // Feed chunks
        for (const { s } of toFeed) {
            decoder.decode(new EncodedVideoChunk({
                type: s.isKeyframe ? 'key' : 'delta',
                timestamp: s.timestamp,
                duration: s.duration,
                data: dataMap.get(s.decodeIndex)
            }));
        }

        decoder.flush();
        await completionPromise;

    } finally {
        isDecoding = false;
        sendStatus(true);
    }
}

async function ensureFrame(frameIdx) {
    if (getFromCache(frameIdx)) return true;

    const keyframe = findKeyframeBefore(frameIdx);
    const end = Math.min(frameIdx + lookahead, samples.length - 1);
    await decodeRange(keyframe, end, frameIdx);

    return getFromCache(frameIdx) !== null;
}

async function prefetch() {
    if (isDecoding) return;

    // Find first uncached frame ahead
    let target = currentFrame + 1;
    while (target < samples.length && getFromCache(target)) {
        target++;
    }

    if (target >= samples.length) return;

    // Count cached frames ahead
    let cachedAhead = 0;
    for (let i = currentFrame + 1; i < Math.min(currentFrame + lookahead, samples.length); i++) {
        if (getFromCache(i)) cachedAhead++;
    }

    // Prefetch if running low
    if (cachedAhead < lookahead * 0.6) {
        const keyframe = findKeyframeBefore(target);
        const end = Math.min(target + lookahead, samples.length - 1);
        await decodeRange(keyframe, end, target);
    }
}

// ============================================
// Rendering with transform
// ============================================
function updateVideoGeometry() {
    if (!videoInfo || !canvas) return;

    const videoWidth = videoInfo.video.width;
    const videoHeight = videoInfo.video.height;
    const videoAspect = videoWidth / videoHeight;
    const canvasAspect = canvas.width / canvas.height;

    if (videoAspect > canvasAspect) {
        baseScale = canvas.width / videoWidth;
        drawX = 0;
        drawY = (canvas.height - videoHeight * baseScale) / 2;
    } else {
        baseScale = canvas.height / videoHeight;
        drawX = (canvas.width - videoWidth * baseScale) / 2;
        drawY = 0;
    }
}

function render() {
    if (!ctx || !samples.length) return;

    const bitmap = getFromCache(currentFrame);
    if (!bitmap) return;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    // offsetX/offsetY are in CSS pixels from main thread, scale to device pixels
    ctx.translate(offsetX * devicePixelRatio, offsetY * devicePixelRatio);
    ctx.translate(drawX, drawY);

    const effectiveScale = baseScale * scale;
    ctx.scale(effectiveScale, effectiveScale);

    // Disable smoothing when zoomed in for crisp pixels
    ctx.imageSmoothingEnabled = effectiveScale < 2;

    ctx.drawImage(bitmap, 0, 0);
    ctx.restore();

    // Draw timing stats overlay (top-right corner)
    // Frame index is shown by main thread overlay, so only show cache/stutters here
    const statsText = [`Cache: ${cacheValid.size}/${CACHE_SIZE}`, `Stutters: ${stutterCount}`];
    const padding = 8;
    const lineHeight = 18;
    const boxWidth = 130;
    const boxHeight = statsText.length * lineHeight + padding * 2;
    const boxX = canvas.width - boxWidth - 10;
    const boxY = 10;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(boxX, boxY, boxWidth, boxHeight);
    ctx.fillStyle = '#4ade80';
    ctx.font = '14px monospace';
    for (let i = 0; i < statsText.length; i++) {
        ctx.fillText(statsText[i], boxX + padding, boxY + padding + (i + 1) * lineHeight - 4);
    }
}

// ============================================
// Animation loop
// ============================================
function playLoop(timestamp) {
    if (!isPlaying) return;

    const frameDuration = 1000 / fps;
    const elapsed = timestamp - lastFrameTime;

    if (elapsed >= frameDuration) {
        // Track stutters
        if (lastFrameTime > 0 && elapsed > frameDuration * 2) {
            stutterCount++;
            frameTimings.push({
                frame: currentFrame,
                elapsed,
                expected: frameDuration,
                stutter: true
            });
        }

        const framesToAdvance = Math.floor(elapsed / frameDuration);
        currentFrame += framesToAdvance;

        // Wrap around
        if (currentFrame >= samples.length) {
            currentFrame = currentFrame % samples.length;
        }

        // Render if frame available
        if (getFromCache(currentFrame)) {
            render();
        }

        lastFrameTime = timestamp - (elapsed % frameDuration);
        sendStatus();
    }

    // Continue loop
    animationId = self.requestAnimationFrame(playLoop);

    // Background prefetch
    prefetch();
}

function play() {
    if (isPlaying || !samples.length) return;

    isPlaying = true;
    lastFrameTime = performance.now();
    stutterCount = 0;
    frameTimings = [];

    animationId = self.requestAnimationFrame(playLoop);
    sendStatus(true);
}

function pause() {
    if (!isPlaying) return;

    isPlaying = false;
    animationId = null;
    sendStatus(true);

    // Send timing analysis
    if (frameTimings.length > 0) {
        self.postMessage({
            type: 'timingAnalysis',
            stutterCount,
            totalFrames: frameTimings.length,
            timings: frameTimings.slice(-100)
        });
    }
}

async function seek(frameIdx) {
    if (!samples.length) return;

    frameIdx = Math.max(0, Math.min(frameIdx, samples.length - 1));
    currentFrame = frameIdx;

    await ensureFrame(frameIdx);
    render();
    sendStatus(true);
}

// ============================================
// Message handler
// ============================================
self.onmessage = async (e) => {
    const { type, ...data } = e.data;

    try {
        switch (type) {
            case 'init': {
                canvas = data.canvas;
                ctx = canvas.getContext('2d');

                canvas.width = data.width || 1280;
                canvas.height = data.height || 720;
                devicePixelRatio = data.dpr || 1;

                // Initialize video
                const source = data.videoUrl || data.videoFile;
                const info = await initVideo(source);

                updateVideoGeometry();

                // Front-load decode
                const frontLoadEnd = Math.min(CACHE_SIZE * 2, samples.length - 1);
                self.postMessage({
                    type: 'status',
                    phase: 'decoding',
                    message: `Front-loading ${frontLoadEnd + 1} frames...`
                });

                await decodeRange(0, frontLoadEnd, 0);

                self.postMessage({
                    type: 'status',
                    phase: 'ready',
                    message: `Front-loaded ${cacheValid.size} frames`
                });

                render();

                self.postMessage({ type: 'ready', ...info });
                // Send initial transform info so overlay can render correctly
                self.postMessage({
                    type: 'transformInfo',
                    scale,
                    offsetX,
                    offsetY,
                    baseScale,
                    drawX,
                    drawY,
                    videoWidth: videoInfo?.video?.width || 0,
                    videoHeight: videoInfo?.video?.height || 0,
                    canvasWidth: canvas?.width || 0,
                    canvasHeight: canvas?.height || 0
                });
                sendStatus(true);
                break;
            }

            case 'play':
                play();
                break;

            case 'pause':
                pause();
                break;

            case 'seek':
                await seek(data.frame);
                break;

            case 'resize':
                if (canvas) {
                    canvas.width = data.width;
                    canvas.height = data.height;
                    devicePixelRatio = data.dpr || devicePixelRatio;
                    updateVideoGeometry();
                    render();
                    // Notify main thread of updated geometry for overlay sync
                    self.postMessage({
                        type: 'transformInfo',
                        scale,
                        offsetX,
                        offsetY,
                        baseScale,
                        drawX,
                        drawY,
                        videoWidth: videoInfo?.video?.width || 0,
                        videoHeight: videoInfo?.video?.height || 0,
                        canvasWidth: canvas?.width || 0,
                        canvasHeight: canvas?.height || 0
                    });
                }
                break;

            case 'setTransform':
                scale = data.scale ?? scale;
                offsetX = data.offsetX ?? offsetX;
                offsetY = data.offsetY ?? offsetY;
                render();
                break;

            case 'resetTransform':
                scale = 1;
                offsetX = 0;
                offsetY = 0;
                render();
                break;

            case 'getTransformInfo': {
                // Return info needed for zoom-to-cursor calculations
                self.postMessage({
                    type: 'transformInfo',
                    scale,
                    offsetX,
                    offsetY,
                    baseScale,
                    drawX,
                    drawY,
                    videoWidth: videoInfo?.video?.width || 0,
                    videoHeight: videoInfo?.video?.height || 0,
                    canvasWidth: canvas?.width || 0,
                    canvasHeight: canvas?.height || 0
                });
                break;
            }

            default:
                console.warn('Unknown message type:', type);
        }
    } catch (err) {
        self.postMessage({ type: 'error', error: err.message });
    }
};
