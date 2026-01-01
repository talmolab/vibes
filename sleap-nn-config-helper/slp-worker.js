// SLP Loader Web Worker
// Uses h5wasm to read SLEAP labels files and extract pose data

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
        log('h5wasm initialized', 'success');

        while (pendingMessages.length > 0) {
            const msg = pendingMessages.shift();
            await handleMessage(msg);
        }
    } catch (err) {
        postMessage({ type: 'error', data: { message: `Failed to initialize h5wasm: ${err.message}` } });
    }
})();

function log(message, level = 'info') {
    postMessage({ type: 'log', data: { message, level } });
}

function setLoading(message) {
    postMessage({ type: 'loading', data: { message } });
}

// Parse the skeleton from metadata JSON
function parseSkeleton(metadataJson) {
    let nodes = [];
    const edges = [];

    // Top-level nodes array contains actual node definitions with names
    const topLevelNodes = metadataJson.nodes || [];

    // Helper to get node name from a reference
    function getNodeName(nodeRef) {
        // If it's a py_state object (SLEAP format)
        if (nodeRef?.py_state?.values) {
            return nodeRef.py_state.values[0];
        }
        // If it has a name property directly
        if (nodeRef?.name) {
            return nodeRef.name;
        }
        // If it's a string, return as-is
        if (typeof nodeRef === 'string') {
            return nodeRef;
        }
        // If it has an id that references top-level nodes
        if (nodeRef?.id !== undefined) {
            const idx = parseInt(nodeRef.id, 10);
            if (!isNaN(idx) && topLevelNodes[idx]) {
                return getNodeName(topLevelNodes[idx]);
            }
        }
        // If it's a number (index into top-level nodes)
        if (typeof nodeRef === 'number') {
            if (topLevelNodes[nodeRef]) {
                return getNodeName(topLevelNodes[nodeRef]);
            }
        }
        return String(nodeRef);
    }

    if (metadataJson.skeletons && metadataJson.skeletons.length > 0) {
        // Always use first skeleton only
        const skel = metadataJson.skeletons[0];

        // Get node names from skeleton.nodes
        if (skel.nodes && Array.isArray(skel.nodes)) {
            nodes = skel.nodes.map(nodeRef => getNodeName(nodeRef));
        }

        // Parse edges from skeleton links
        if (skel.links) {
            for (const link of skel.links) {
                const srcIdx = link.source;
                const dstIdx = link.target;
                if (typeof srcIdx === 'number' && typeof dstIdx === 'number') {
                    edges.push([srcIdx, dstIdx]);
                }
            }
        }
    }

    // Fallback: if no nodes from skeleton, try top-level
    if (nodes.length === 0 && topLevelNodes.length > 0) {
        nodes = topLevelNodes.map(n => getNodeName(n));
    }

    log(`Parsed ${nodes.length} nodes, ${edges.length} edges`, 'info');
    log(`Node names: ${nodes.join(', ')}`, 'info');

    return {
        name: metadataJson.skeletons?.[0]?.graph?.name || 'skeleton',
        nodes,
        edges,
        symmetries: []
    };
}

// Parse tracks from tracks_json dataset
function parseTracks(tracksData) {
    if (!tracksData || tracksData.length === 0) return [];

    return Array.from(tracksData).map(t => {
        if (typeof t === 'string') {
            try {
                const parsed = JSON.parse(t);
                // Handle different track formats:
                // 1. Object with name property: { name: "F", ... }
                if (parsed.name) return parsed.name;
                // 2. py_state format: { py_state: { values: ["F", ...] } }
                if (parsed.py_state?.values?.[0]) return parsed.py_state.values[0];
                // 3. Array format [spawned_on, name]: [0, "F"]
                if (Array.isArray(parsed) && parsed.length >= 2) return String(parsed[1]);
                // 4. Simple string or other
                return typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
            } catch {
                return t;
            }
        }
        return String(t);
    });
}

// Load and parse SLP file
async function loadSlpFile(h5file, filename, fileSize, source) {
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

    log(`SLP version: ${metadataJson.version || 'unknown'}`, 'info');

    // Parse skeleton
    const skeleton = parseSkeleton(metadataJson);
    log(`Skeleton: ${skeleton.nodes.length} nodes, ${skeleton.edges.length} edges`, 'info');

    // Read tracks
    setLoading('Reading tracks...');
    let tracks = [];
    try {
        const tracksDataset = h5file.get('tracks_json');
        if (tracksDataset && tracksDataset.shape[0] > 0) {
            tracks = parseTracks(tracksDataset.value);
        }
    } catch (e) {
        log(`No tracks found: ${e.message}`, 'warn');
    }
    log(`Tracks: ${tracks.length}`, 'info');

    // Read frames dataset
    setLoading('Reading frames...');
    const framesDataset = h5file.get('frames');
    if (!framesDataset) {
        throw new Error('No frames dataset found');
    }
    const framesRaw = framesDataset.value;

    // h5wasm returns compound datasets as array of arrays or object with typed arrays
    // Normalize to columnar format
    let framesData;
    if (Array.isArray(framesRaw) && framesRaw.length > 0 && Array.isArray(framesRaw[0])) {
        // Array of tuples - convert to columnar
        const fields = ['frame_id', 'video', 'frame_idx', 'instance_id_start', 'instance_id_end'];
        framesData = {};
        for (let i = 0; i < fields.length; i++) {
            framesData[fields[i]] = framesRaw.map(row => row[i]);
        }
    } else if (framesRaw && typeof framesRaw === 'object' && framesRaw.frame_id) {
        // Already columnar
        framesData = framesRaw;
    } else {
        // Try to detect structure
        log(`Frames data type: ${typeof framesRaw}, isArray: ${Array.isArray(framesRaw)}`, 'warn');
        if (framesRaw) log(`First element: ${JSON.stringify(framesRaw[0] || framesRaw).substring(0, 200)}`, 'warn');
        throw new Error('Unexpected frames data format');
    }

    log(`Frames: ${framesData.frame_id.length}`, 'info');

    // Read instances dataset
    setLoading('Reading instances...');
    const instancesDataset = h5file.get('instances');
    if (!instancesDataset) {
        throw new Error('No instances dataset found');
    }
    const instancesRaw = instancesDataset.value;

    // Normalize instances to columnar format
    let instancesData;
    const instanceFields = ['instance_id', 'instance_type', 'frame_id', 'skeleton', 'track',
                           'from_predicted', 'score', 'point_id_start', 'point_id_end', 'tracking_score'];
    if (Array.isArray(instancesRaw) && instancesRaw.length > 0 && Array.isArray(instancesRaw[0])) {
        instancesData = {};
        for (let i = 0; i < instanceFields.length; i++) {
            instancesData[instanceFields[i]] = instancesRaw.map(row => row[i]);
        }
    } else if (instancesRaw && typeof instancesRaw === 'object' && instancesRaw.instance_id) {
        instancesData = instancesRaw;
    } else {
        log(`Instances data type: ${typeof instancesRaw}, isArray: ${Array.isArray(instancesRaw)}`, 'warn');
        throw new Error('Unexpected instances data format');
    }

    log(`Instances: ${instancesData.instance_id.length}`, 'info');

    // Read points - check for both user and predicted points
    setLoading('Reading points...');
    let pointsData = null;
    let predPointsData = null;

    // Helper to normalize points data
    function normalizePoints(raw, fields) {
        if (!raw || raw.length === 0) return null;
        if (Array.isArray(raw) && raw.length > 0 && Array.isArray(raw[0])) {
            const data = {};
            for (let i = 0; i < fields.length; i++) {
                data[fields[i]] = raw.map(row => row[i]);
            }
            return data;
        } else if (raw && typeof raw === 'object' && raw.x !== undefined) {
            return raw;
        }
        return null;
    }

    try {
        const pointsDataset = h5file.get('points');
        if (pointsDataset && pointsDataset.shape[0] > 0) {
            pointsData = normalizePoints(pointsDataset.value, ['x', 'y', 'visible', 'complete']);
            if (pointsData) {
                log(`User points: ${pointsData.x.length}`, 'info');
                // Debug: check visible field
                if (pointsData.visible) {
                    const visibleSample = Array.from(pointsData.visible.slice(0, 10));
                    log(`User points visible sample: ${JSON.stringify(visibleSample)}`, 'info');
                } else {
                    log(`User points: NO visible field!`, 'warn');
                }
            }
        }
    } catch (e) {
        // No user points
    }

    try {
        const predPointsDataset = h5file.get('pred_points');
        if (predPointsDataset && predPointsDataset.shape[0] > 0) {
            predPointsData = normalizePoints(predPointsDataset.value, ['x', 'y', 'visible', 'complete', 'score']);
            if (predPointsData) log(`Predicted points: ${predPointsData.x.length}`, 'info');
        }
    } catch (e) {
        // No predicted points
    }

    if (!pointsData && !predPointsData) {
        throw new Error('No points data found in SLP file');
    }

    // Read video info (path, dimensions, channels)
    let videoPath = null;
    let videoWidth = 0;
    let videoHeight = 0;
    let videoChannels = 0;  // 0 = unknown, 1 = grayscale, 3 = RGB
    try {
        const videosDataset = h5file.get('videos_json');
        if (videosDataset && videosDataset.shape[0] > 0) {
            const videoJson = JSON.parse(videosDataset.value[0]);
            videoPath = videoJson.backend?.filename || videoJson.filename;
            // Try to get dimensions from video metadata
            // Shape is typically [frames, height, width] or [frames, height, width, channels]
            const shape = videoJson.backend?.shape || videoJson.shape || [];
            videoHeight = shape[1] || 0;
            videoWidth = shape[2] || 0;
            // Channels: if shape has 4 elements, 4th is channels; otherwise assume grayscale
            if (shape.length >= 4) {
                videoChannels = shape[3];
            } else if (shape.length === 3) {
                // [frames, height, width] - grayscale
                videoChannels = 1;
            }
            if (videoWidth > 0 && videoHeight > 0) {
                log(`Video: ${videoWidth}x${videoHeight}, ${videoChannels === 1 ? 'grayscale' : videoChannels === 3 ? 'RGB' : 'unknown channels'}`, 'info');
            }
        }
    } catch (e) {
        log(`Could not read video path: ${e.message}`, 'warn');
    }

    // Build frame data structure
    const totalFrames = framesData.frame_id.length;
    setLoading(`Building pose data (0/${totalFrames})...`);
    const frames = [];
    const numNodes = skeleton.nodes.length;

    // Debug counters
    let debugUserInstances = 0;
    let debugPredInstances = 0;
    let debugNullPoints = 0;
    let debugValidPoints = 0;

    for (let i = 0; i < framesData.frame_id.length; i++) {
        // Progress update every 500 frames
        if (i > 0 && i % 500 === 0) {
            setLoading(`Building pose data (${i}/${totalFrames})...`);
        }
        const frameIdx = Number(framesData.frame_idx[i]);
        const instStart = Number(framesData.instance_id_start[i]);
        const instEnd = Number(framesData.instance_id_end[i]);

        const instances = [];

        for (let j = instStart; j < instEnd; j++) {
            const instanceType = instancesData.instance_type[j];
            const trackIdx = instancesData.track[j];
            const score = instancesData.score[j];
            const ptStart = Number(instancesData.point_id_start[j]);
            const ptEnd = Number(instancesData.point_id_end[j]);

            // Get points from appropriate dataset
            const pts = instanceType === 1 ? predPointsData : pointsData;
            if (!pts) continue;

            const points = [];
            for (let k = ptStart; k < ptEnd && k < ptStart + numNodes; k++) {
                const x = pts.x[k];
                const y = pts.y[k];

                // Check visible flag (0 = not visible/not labeled)
                // In HDF5, visible is typically stored as 0 or 1 (or true/false)
                let isVisible = true;  // Default to visible
                if (pts.visible) {
                    const visibleVal = pts.visible[k];
                    // Explicitly check for falsy values: 0, false, null, undefined
                    isVisible = visibleVal === 1 || visibleVal === true || visibleVal > 0;
                }

                // Check if coordinates are valid (not NaN, not Inf, and within reasonable bounds)
                const hasValidCoords = !isNaN(x) && !isNaN(y) &&
                                       isFinite(x) && isFinite(y) &&
                                       Math.abs(x) < 1e6 && Math.abs(y) < 1e6;  // Sanity check

                // Point is valid only if visible AND has valid coordinates
                if (isVisible && hasValidCoords) {
                    points.push([x, y]);
                } else {
                    points.push(null);
                }
            }

            // Pad if we have fewer points than nodes
            while (points.length < numNodes) {
                points.push(null);
            }

            const instType = instanceType === 1 ? 'predicted' : 'user';
            if (instType === 'user') {
                debugUserInstances++;
                points.forEach(p => {
                    if (p === null) debugNullPoints++;
                    else debugValidPoints++;
                });
            } else {
                debugPredInstances++;
            }

            instances.push({
                trackIdx: trackIdx,
                score: score,
                type: instType,
                points: points
            });
        }

        if (instances.length > 0) {
            frames.push({
                frameIdx,
                instances
            });
        }
    }

    log(`Built ${frames.length} frames with pose data`, 'success');
    log(`DEBUG: ${debugUserInstances} user instances, ${debugPredInstances} predicted instances`, 'info');
    log(`DEBUG: User instance points: ${debugValidPoints} valid, ${debugNullPoints} null (${(debugNullPoints / (debugValidPoints + debugNullPoints) * 100).toFixed(1)}% null)`, 'info');

    return {
        filename,
        fileSize,
        source,
        skeleton,
        tracks,
        frames,
        videoPath,
        videoWidth,
        videoHeight,
        videoChannels
    };
}

// Load local file
async function loadLocalFile(file) {
    setLoading('Mounting file...');

    try {
        // Clean up previous mounts
        try { FS.unmount('/work'); } catch (e) { /* ignore */ }
        try { FS.rmdir('/work'); } catch (e) { /* ignore */ }

        FS.mkdir('/work');
        FS.mount(FS.filesystems.WORKERFS, { files: [file] }, '/work');

        const filePath = `/work/${file.name}`;
        log(`File mounted: ${filePath}`, 'info');

        setLoading('Opening SLP file...');
        const h5file = new h5wasm.File(filePath, 'r');
        log('File opened successfully', 'success');

        const result = await loadSlpFile(h5file, file.name, file.size, 'Local file');

        h5file.close();

        postMessage({ type: 'result', data: result });

    } catch (err) {
        log(`Error: ${err.message}`, 'error');
        postMessage({ type: 'error', data: { message: err.message } });
    }
}

// Load from URL
async function loadUrlFile(url) {
    setLoading('Checking server...');

    try {
        const headResponse = await fetch(url, { method: 'HEAD' });

        if (!headResponse.ok) {
            throw new Error(`Failed to fetch URL: ${headResponse.status} ${headResponse.statusText}`);
        }

        const contentLength = parseInt(headResponse.headers.get('Content-Length')) || 0;
        const acceptRanges = headResponse.headers.get('Accept-Ranges');
        const supportsRanges = acceptRanges === 'bytes';

        log(`Server: ${(contentLength / 1024 / 1024).toFixed(1)} MB, ranges=${supportsRanges}`, 'info');

        const filename = url.split('/').pop().split('?')[0] || 'remote.slp';
        let source;
        let filePath;

        if (supportsRanges && contentLength > 0) {
            log('Using lazy file with range requests', 'success');
            setLoading('Creating lazy file...');

            try { FS.unlink(`/remote/${filename}`); } catch (e) { /* ignore */ }
            try { FS.rmdir('/remote'); } catch (e) { /* ignore */ }

            FS.mkdir('/remote');
            FS.createLazyFile('/remote', filename, url, true, false);

            filePath = `/remote/${filename}`;
            source = 'URL (range requests)';
        } else {
            log('Downloading entire file...', 'warn');
            setLoading('Downloading file...');

            const response = await fetch(url);
            const arrayBuffer = await response.arrayBuffer();

            FS.writeFile(`/${filename}`, new Uint8Array(arrayBuffer));

            filePath = `/${filename}`;
            source = 'URL (full download)';
            log(`Downloaded ${(arrayBuffer.byteLength / 1024 / 1024).toFixed(2)} MB`, 'info');
        }

        setLoading('Opening SLP file...');
        const h5file = new h5wasm.File(filePath, 'r');
        log('File opened successfully', 'success');

        const result = await loadSlpFile(h5file, filename, contentLength, source);

        h5file.close();

        postMessage({ type: 'result', data: result });

    } catch (err) {
        log(`Error: ${err.message}`, 'error');
        postMessage({ type: 'error', data: { message: err.message } });
    }
}

// Handle messages
async function handleMessage(data) {
    const { type, file, url } = data;

    if (type === 'loadLocal') {
        await loadLocalFile(file);
    } else if (type === 'loadUrl') {
        await loadUrlFile(url);
    }
}

// Message handler
onmessage = async function(e) {
    if (!h5wasmReady) {
        log('Queuing request until h5wasm is ready...', 'info');
        pendingMessages.push(e.data);
        return;
    }

    await handleMessage(e.data);
};
