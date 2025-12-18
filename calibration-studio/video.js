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

    async init(url) {
        this.url = url;
        videoLog(`Checking video: ${url}`, 'info');

        const headResponse = await fetch(url, { method: 'HEAD' });
        if (!headResponse.ok) {
            throw new Error(`Failed to fetch URL: ${headResponse.status}`);
        }
        this.fileSize = parseInt(headResponse.headers.get('Content-Length')) || 0;
        this.supportsRangeRequests = headResponse.headers.get('Accept-Ranges') === 'bytes';

        if (!this.supportsRangeRequests || !this.fileSize) {
            videoLog('Downloading entire file (no range support)...', 'warn');
            const response = await fetch(url);
            this.fileBlob = await response.blob();
            this.fileSize = this.fileBlob.size;
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
        if (this.fileBlob) {
            return await this.fileBlob.slice(offset, end).arrayBuffer();
        } else {
            const response = await fetch(this.url, {
                headers: { 'Range': `bytes=${offset}-${end - 1}` }
            });
            return await response.arrayBuffer();
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
