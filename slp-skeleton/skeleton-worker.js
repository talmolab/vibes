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

// Load and parse SLP file
async function loadSlpFile(h5file, filename) {
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

    // Read frames with poses
    setLoading('Reading pose data...');
    let frames = [];
    try {
        frames = await readFrames(h5file, skeleton.nodes.length);
    } catch (e) {
        // Frames are optional - skeleton-only viewing is fine
        console.warn('Could not read frames:', e.message);
    }

    return { skeleton, frames, filename };
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

// Load local file
async function loadLocalFile(file) {
    setLoading('Mounting file...');

    try {
        try { FS.unmount('/work'); } catch (e) {}
        try { FS.rmdir('/work'); } catch (e) {}

        FS.mkdir('/work');
        FS.mount(FS.filesystems.WORKERFS, { files: [file] }, '/work');

        const filePath = `/work/${file.name}`;
        setLoading('Opening SLP file...');
        const h5file = new h5wasm.File(filePath, 'r');

        const result = await loadSlpFile(h5file, file.name);
        h5file.close();

        postMessage({ type: 'result', data: result });
    } catch (err) {
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

        const result = await loadSlpFile(h5file, filename);
        h5file.close();

        postMessage({ type: 'result', data: result });
    } catch (err) {
        postMessage({ type: 'error', data: { message: err.message } });
    }
}

async function handleMessage(data) {
    const { type, file, url } = data;
    if (type === 'loadFile') {
        await loadLocalFile(file);
    } else if (type === 'loadUrl') {
        await loadUrlFile(url);
    }
}

onmessage = async function(e) {
    if (!h5wasmReady) {
        pendingMessages.push(e.data);
        return;
    }
    await handleMessage(e.data);
};
