// Skeleton Worker - Extracts skeleton structure from SLEAP SLP files using h5wasm
importScripts('https://cdn.jsdelivr.net/npm/h5wasm@0.8.8/dist/iife/h5wasm.js');

let h5wasmReady = false;
let FS = null;
let pendingMessages = [];

// Initialize h5wasm
(async () => {
    try {
        await h5wasm.ready;
        FS = h5wasm.FS;
        h5wasmReady = true;
        while (pendingMessages.length > 0) {
            await handleMessage(pendingMessages.shift());
        }
    } catch (err) {
        postMessage({ type: 'error', data: { message: `Failed to initialize h5wasm: ${err.message}` } });
    }
})();

function setLoading(message) {
    postMessage({ type: 'loading', data: { message } });
}

// Parse skeleton from metadata JSON
function parseSkeleton(metadataJson) {
    const nodes = metadataJson.nodes.map(n => n.name || n);

    // Parse edges from skeleton links
    const edges = [];
    const skeletonData = metadataJson.skeletons?.[0];
    if (skeletonData?.links) {
        for (const link of skeletonData.links) {
            const srcIdx = link.source;
            const dstIdx = link.target;
            if (typeof srcIdx === 'number' && typeof dstIdx === 'number') {
                edges.push([srcIdx, dstIdx]);
            }
        }
    }

    // Parse symmetries - stored in the graph's symmetries array
    const symmetries = [];
    if (skeletonData?.graph?.symmetries) {
        for (const sym of skeletonData.graph.symmetries) {
            // symmetries may be stored as node indices or node names
            if (Array.isArray(sym) && sym.length === 2) {
                let nodeA = sym[0];
                let nodeB = sym[1];
                // If they're names, convert to indices
                if (typeof nodeA === 'string') {
                    nodeA = nodes.indexOf(nodeA);
                }
                if (typeof nodeB === 'string') {
                    nodeB = nodes.indexOf(nodeB);
                }
                if (nodeA >= 0 && nodeB >= 0) {
                    symmetries.push([nodeA, nodeB]);
                }
            }
        }
    }

    return {
        name: skeletonData?.graph?.name || 'Skeleton',
        nodes,
        edges,
        symmetries
    };
}

// Global state for keeping h5file open for frame extraction
let currentH5File = null;
let videoInfo = null;

// Check for embedded video data
function detectEmbeddedVideo(h5file) {
    const keys = h5file.keys();
    const videoGroups = keys.filter(k => k.match(/^video\d+$/));

    if (videoGroups.length === 0) return null;

    const videos = [];
    for (const groupName of videoGroups) {
        try {
            const group = h5file.get(groupName);
            const groupKeys = group.keys();

            if (groupKeys.includes('video')) {
                const videoDataset = group.get('video');
                const shape = videoDataset.shape;

                // Read frame_numbers if available (maps frame idx to storage idx)
                let frameNumbers = null;
                if (groupKeys.includes('frame_numbers')) {
                    const frameNumDataset = group.get('frame_numbers');
                    frameNumbers = Array.from(frameNumDataset.value);
                }

                // Detect format from first few bytes
                let format = 'raw';
                try {
                    const sample = videoDataset.slice([[0, 1]]);
                    if (sample && sample.length > 0) {
                        const bytes = new Uint8Array(sample.buffer || sample);
                        // PNG magic: 137 80 78 71
                        if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) {
                            format = 'png';
                        }
                        // JPEG magic: 255 216 255
                        else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
                            format = 'jpeg';
                        }
                    }
                } catch (e) {}

                videos.push({
                    group: groupName,
                    dataset: `${groupName}/video`,
                    shape,
                    frameNumbers,
                    format,
                    numFrames: shape[0]
                });
            }
        } catch (e) {
            console.warn(`Error checking video group ${groupName}:`, e);
        }
    }

    return videos.length > 0 ? videos : null;
}

// Extract a single frame from embedded video
async function extractFrame(frameIdx, videoIdx = 0) {
    if (!currentH5File || !videoInfo || videoIdx >= videoInfo.length) {
        return null;
    }

    const video = videoInfo[videoIdx];

    // Map frame index to storage index using frame_numbers
    let storageIdx = frameIdx;
    if (video.frameNumbers) {
        const idx = video.frameNumbers.indexOf(frameIdx);
        if (idx >= 0) {
            storageIdx = idx;
        } else {
            // Frame not in embedded data
            return null;
        }
    }

    if (storageIdx < 0 || storageIdx >= video.numFrames) {
        return null;
    }

    try {
        const dataset = currentH5File.get(video.dataset);
        const frameData = dataset.slice([[storageIdx, storageIdx + 1]]);

        if (video.format === 'png' || video.format === 'jpeg') {
            // Return encoded image data as blob
            const bytes = new Uint8Array(frameData.buffer || frameData);
            const blob = new Blob([bytes], { type: `image/${video.format}` });
            return await createImageBitmap(blob);
        } else {
            // Raw format - need shape info to create ImageData
            // For now, return null for raw formats
            return null;
        }
    } catch (e) {
        console.error('Error extracting frame:', e);
        return null;
    }
}

// Load and parse SLP file
async function loadSlpFile(h5file, filename, keepOpen = false) {
    setLoading('Parsing SLP metadata...');

    // Read metadata
    const metadataGroup = h5file.get('metadata');
    if (!metadataGroup) {
        throw new Error('No metadata group found in SLP file');
    }

    const jsonAttr = metadataGroup.attrs['json'];
    if (!jsonAttr) {
        throw new Error('No json attribute in metadata group');
    }

    let metadataJson;
    try {
        const jsonStr = typeof jsonAttr.value === 'string' ? jsonAttr.value :
                        new TextDecoder().decode(jsonAttr.value);
        metadataJson = JSON.parse(jsonStr);
    } catch (e) {
        throw new Error(`Failed to parse metadata JSON: ${e.message}`);
    }

    // Parse skeleton
    const skeleton = parseSkeleton(metadataJson);

    // Check for embedded video
    setLoading('Checking for embedded video...');
    videoInfo = detectEmbeddedVideo(h5file);
    const hasEmbeddedImages = videoInfo !== null;

    // Read frames with poses
    setLoading('Reading pose data...');
    let frames = [];
    try {
        frames = await readFrames(h5file, skeleton.nodes.length);
    } catch (e) {
        // Frames are optional - skeleton-only viewing is fine
        console.warn('Could not read frames:', e.message);
    }

    // Keep file open if we have embedded images
    if (hasEmbeddedImages && keepOpen) {
        currentH5File = h5file;
    }

    return { skeleton, frames, filename, hasEmbeddedImages, videoInfo };
}

// Read frame data
async function readFrames(h5file, numNodes) {
    const framesDataset = h5file.get('frames');
    if (!framesDataset) return [];

    const framesRaw = framesDataset.value;
    let framesData;
    if (Array.isArray(framesRaw) && framesRaw.length > 0 && Array.isArray(framesRaw[0])) {
        const fields = ['frame_id', 'video', 'frame_idx', 'instance_id_start', 'instance_id_end'];
        framesData = {};
        for (let i = 0; i < fields.length; i++) {
            framesData[fields[i]] = framesRaw.map(row => row[i]);
        }
    } else if (framesRaw?.frame_id) {
        framesData = framesRaw;
    } else {
        return [];
    }

    // Read instances
    const instancesDataset = h5file.get('instances');
    if (!instancesDataset) return [];
    const instancesRaw = instancesDataset.value;

    let instancesData;
    const instanceFields = ['instance_id', 'instance_type', 'frame_id', 'skeleton', 'track',
                           'from_predicted', 'score', 'point_id_start', 'point_id_end', 'tracking_score'];
    if (Array.isArray(instancesRaw) && instancesRaw.length > 0 && Array.isArray(instancesRaw[0])) {
        instancesData = {};
        for (let i = 0; i < instanceFields.length; i++) {
            instancesData[instanceFields[i]] = instancesRaw.map(row => row[i]);
        }
    } else if (instancesRaw?.instance_id) {
        instancesData = instancesRaw;
    } else {
        return [];
    }

    // Read points
    let pointsData = null;
    let predPointsData = null;

    function normalizePoints(raw, fields) {
        if (!raw || raw.length === 0) return null;
        if (Array.isArray(raw) && raw.length > 0 && Array.isArray(raw[0])) {
            const data = {};
            for (let i = 0; i < fields.length; i++) {
                data[fields[i]] = raw.map(row => row[i]);
            }
            return data;
        } else if (raw?.x !== undefined) {
            return raw;
        }
        return null;
    }

    try {
        const pointsDataset = h5file.get('points');
        if (pointsDataset?.shape[0] > 0) {
            pointsData = normalizePoints(pointsDataset.value, ['x', 'y', 'visible', 'complete']);
        }
    } catch (e) {}

    try {
        const predPointsDataset = h5file.get('pred_points');
        if (predPointsDataset?.shape[0] > 0) {
            predPointsData = normalizePoints(predPointsDataset.value, ['x', 'y', 'visible', 'complete', 'score']);
        }
    } catch (e) {}

    if (!pointsData && !predPointsData) return [];

    // Build frames
    const frames = [];
    for (let i = 0; i < framesData.frame_id.length; i++) {
        const frameIdx = Number(framesData.frame_idx[i]);
        const instStart = Number(framesData.instance_id_start[i]);
        const instEnd = Number(framesData.instance_id_end[i]);
        const instances = [];

        for (let j = instStart; j < instEnd; j++) {
            const instanceType = instancesData.instance_type[j];
            const ptStart = Number(instancesData.point_id_start[j]);
            const ptEnd = Number(instancesData.point_id_end[j]);

            const pts = instanceType === 1 ? predPointsData : pointsData;
            if (!pts) continue;

            const points = [];
            for (let k = ptStart; k < ptEnd && k < ptStart + numNodes; k++) {
                const x = pts.x[k];
                const y = pts.y[k];
                const visible = pts.visible[k];
                if (visible && !isNaN(x) && !isNaN(y)) {
                    points.push([x, y]);
                } else {
                    points.push(null);
                }
            }
            while (points.length < numNodes) points.push(null);

            instances.push({ points });
        }

        if (instances.length > 0) {
            frames.push({ frameIdx, instances });
        }
    }

    return frames;
}

// Close current file if open
function closeCurrentFile() {
    if (currentH5File) {
        try {
            currentH5File.close();
        } catch (e) {}
        currentH5File = null;
    }
    videoInfo = null;
}

// Load local file
async function loadLocalFile(file) {
    setLoading('Mounting file...');
    closeCurrentFile();

    try {
        try { FS.unmount('/work'); } catch (e) {}
        try { FS.rmdir('/work'); } catch (e) {}

        FS.mkdir('/work');
        FS.mount(FS.filesystems.WORKERFS, { files: [file] }, '/work');

        const filePath = `/work/${file.name}`;
        setLoading('Opening SLP file...');
        const h5file = new h5wasm.File(filePath, 'r');

        const result = await loadSlpFile(h5file, file.name, true);

        // Close file if no embedded images (otherwise keep open for frame extraction)
        if (!result.hasEmbeddedImages) {
            h5file.close();
        }

        postMessage({ type: 'result', data: result });
    } catch (err) {
        postMessage({ type: 'error', data: { message: err.message } });
    }
}

// Load from URL
async function loadUrlFile(url) {
    setLoading('Checking server...');
    closeCurrentFile();

    try {
        const headResponse = await fetch(url, { method: 'HEAD' });
        if (!headResponse.ok) {
            throw new Error(`Failed to fetch URL: ${headResponse.status} ${headResponse.statusText}`);
        }

        const contentLength = parseInt(headResponse.headers.get('Content-Length')) || 0;
        const acceptRanges = headResponse.headers.get('Accept-Ranges');
        const supportsRanges = acceptRanges === 'bytes';

        const filename = url.split('/').pop().split('?')[0] || 'remote.slp';
        let filePath;

        if (supportsRanges && contentLength > 0) {
            setLoading('Creating lazy file...');
            try { FS.unlink(`/remote/${filename}`); } catch (e) {}
            try { FS.rmdir('/remote'); } catch (e) {}

            FS.mkdir('/remote');
            FS.createLazyFile('/remote', filename, url, true, false);
            filePath = `/remote/${filename}`;
        } else {
            setLoading('Downloading file...');
            const response = await fetch(url);
            const arrayBuffer = await response.arrayBuffer();
            FS.writeFile(`/${filename}`, new Uint8Array(arrayBuffer));
            filePath = `/${filename}`;
        }

        setLoading('Opening SLP file...');
        const h5file = new h5wasm.File(filePath, 'r');

        const result = await loadSlpFile(h5file, filename, true);

        // Close file if no embedded images (otherwise keep open for frame extraction)
        if (!result.hasEmbeddedImages) {
            h5file.close();
        }

        postMessage({ type: 'result', data: result });
    } catch (err) {
        postMessage({ type: 'error', data: { message: err.message } });
    }
}

// Handle getFrame request
async function handleGetFrame(frameIdx, videoIdx) {
    try {
        const imageBitmap = await extractFrame(frameIdx, videoIdx);
        if (imageBitmap) {
            // Transfer the ImageBitmap to the main thread
            postMessage({ type: 'frame', data: { frameIdx, videoIdx, image: imageBitmap } }, [imageBitmap]);
        } else {
            postMessage({ type: 'frame', data: { frameIdx, videoIdx, image: null } });
        }
    } catch (err) {
        postMessage({ type: 'frame', data: { frameIdx, videoIdx, image: null, error: err.message } });
    }
}

async function handleMessage(data) {
    const { type, file, url, frameIdx, videoIdx } = data;
    if (type === 'loadFile') {
        await loadLocalFile(file);
    } else if (type === 'loadUrl') {
        await loadUrlFile(url);
    } else if (type === 'getFrame') {
        await handleGetFrame(frameIdx, videoIdx || 0);
    }
}

onmessage = async function(e) {
    if (!h5wasmReady) {
        pendingMessages.push(e.data);
        return;
    }
    await handleMessage(e.data);
};
