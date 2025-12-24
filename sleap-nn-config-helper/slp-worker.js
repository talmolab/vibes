// SLP Loader Web Worker
// Uses h5wasm to read SLEAP labels files and extract pose data

importScripts('https://cdn.jsdelivr.net/npm/h5wasm@0.8.8/dist/iife/h5wasm.js');

let h5wasmReady = false;
let FS = null;

// Initialize h5wasm
(async () => {
    try {
        await h5wasm.ready;
        FS = h5wasm.FS;
        h5wasmReady = true;
    } catch (err) {
        postMessage({ error: `Failed to initialize h5wasm: ${err.message}` });
    }
})();

// Parse the skeleton from metadata JSON
function parseSkeleton(metadataJson) {
    const nodes = metadataJson.nodes.map(n => n.name || n);
    const edges = [];
    if (metadataJson.skeletons && metadataJson.skeletons.length > 0) {
        const skel = metadataJson.skeletons[0];
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
    return {
        name: metadataJson.skeletons?.[0]?.graph?.name || 'skeleton',
        nodes,
        edges
    };
}

// Parse tracks from tracks_json dataset
function parseTracks(tracksData) {
    if (!tracksData || tracksData.length === 0) return [];
    return Array.from(tracksData).map(t => {
        if (typeof t === 'string') {
            try {
                const parsed = JSON.parse(t);
                return parsed.name || parsed.py_state?.values?.[0] || parsed;
            } catch {
                return t;
            }
        }
        return String(t);
    });
}

// Helper to normalize compound datasets to columnar format
function normalizeDataset(raw, fields) {
    if (!raw || raw.length === 0) return null;
    if (Array.isArray(raw) && raw.length > 0 && Array.isArray(raw[0])) {
        const data = {};
        for (let i = 0; i < fields.length; i++) {
            data[fields[i]] = raw.map(row => row[i]);
        }
        return data;
    } else if (raw && typeof raw === 'object' && raw[fields[0]] !== undefined) {
        return raw;
    }
    return null;
}

// Load and parse SLP file from ArrayBuffer
async function parseSlpFile(arrayBuffer) {
    // Write buffer to virtual filesystem
    const filename = 'temp.slp';
    FS.writeFile(`/${filename}`, new Uint8Array(arrayBuffer));

    const h5file = new h5wasm.File(`/${filename}`, 'r');

    // Read metadata
    const metadataGroup = h5file.get('metadata');
    if (!metadataGroup) throw new Error('No metadata group found');

    const jsonAttr = metadataGroup.attrs['json'];
    if (!jsonAttr) throw new Error('No json attribute in metadata');

    const jsonStr = typeof jsonAttr.value === 'string' ? jsonAttr.value :
                    new TextDecoder().decode(jsonAttr.value);
    const metadataJson = JSON.parse(jsonStr);

    const skeleton = parseSkeleton(metadataJson);

    // Read tracks
    let tracks = [];
    try {
        const tracksDataset = h5file.get('tracks_json');
        if (tracksDataset && tracksDataset.shape[0] > 0) {
            tracks = parseTracks(tracksDataset.value);
        }
    } catch (e) { /* no tracks */ }

    // Read video info
    let videoWidth = 1920, videoHeight = 1080;
    try {
        const videosDataset = h5file.get('videos_json');
        if (videosDataset && videosDataset.shape[0] > 0) {
            const videoJson = JSON.parse(videosDataset.value[0]);
            videoWidth = videoJson.backend?.shape?.[2] || videoJson.shape?.[2] || 1920;
            videoHeight = videoJson.backend?.shape?.[1] || videoJson.shape?.[1] || 1080;
        }
    } catch (e) { /* use defaults */ }

    // Read frames
    const framesDataset = h5file.get('frames');
    if (!framesDataset) throw new Error('No frames dataset found');
    const framesData = normalizeDataset(framesDataset.value,
        ['frame_id', 'video', 'frame_idx', 'instance_id_start', 'instance_id_end']);
    if (!framesData) throw new Error('Could not parse frames dataset');

    // Read instances
    const instancesDataset = h5file.get('instances');
    if (!instancesDataset) throw new Error('No instances dataset found');
    const instancesData = normalizeDataset(instancesDataset.value,
        ['instance_id', 'instance_type', 'frame_id', 'skeleton', 'track',
         'from_predicted', 'score', 'point_id_start', 'point_id_end', 'tracking_score']);
    if (!instancesData) throw new Error('Could not parse instances dataset');

    // Read points
    let pointsData = null, predPointsData = null;
    try {
        const pointsDataset = h5file.get('points');
        if (pointsDataset && pointsDataset.shape[0] > 0) {
            pointsData = normalizeDataset(pointsDataset.value, ['x', 'y', 'visible', 'complete']);
        }
    } catch (e) { /* no user points */ }

    try {
        const predPointsDataset = h5file.get('pred_points');
        if (predPointsDataset && predPointsDataset.shape[0] > 0) {
            predPointsData = normalizeDataset(predPointsDataset.value, ['x', 'y', 'visible', 'complete', 'score']);
        }
    } catch (e) { /* no pred points */ }

    if (!pointsData && !predPointsData) throw new Error('No points data found');

    // Build frames with instances and compute stats
    const frames = [];
    const numNodes = skeleton.nodes.length;
    let totalInstances = 0;
    let maxInstancesPerFrame = 0;
    let instanceSizes = [];
    let overlapFrames = 0;

    for (let i = 0; i < framesData.frame_id.length; i++) {
        const frameIdx = Number(framesData.frame_idx[i]);
        const instStart = Number(framesData.instance_id_start[i]);
        const instEnd = Number(framesData.instance_id_end[i]);
        const instances = [];
        const bboxes = [];

        for (let j = instStart; j < instEnd; j++) {
            const instanceType = instancesData.instance_type[j];
            const ptStart = Number(instancesData.point_id_start[j]);
            const ptEnd = Number(instancesData.point_id_end[j]);

            const pts = instanceType === 1 ? predPointsData : pointsData;
            if (!pts) continue;

            const points = [];
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

            for (let k = ptStart; k < ptEnd && k < ptStart + numNodes; k++) {
                const x = pts.x[k];
                const y = pts.y[k];
                const visible = pts.visible ? pts.visible[k] : true;

                if (visible && !isNaN(x) && !isNaN(y)) {
                    points.push({ x, y });
                    minX = Math.min(minX, x);
                    minY = Math.min(minY, y);
                    maxX = Math.max(maxX, x);
                    maxY = Math.max(maxY, y);
                } else {
                    points.push({ x: null, y: null });
                }
            }

            while (points.length < numNodes) {
                points.push({ x: null, y: null });
            }

            instances.push({ points });

            if (minX !== Infinity) {
                const w = maxX - minX;
                const h = maxY - minY;
                instanceSizes.push(Math.max(w, h));
                bboxes.push({ minX, minY, maxX, maxY });
            }
        }

        if (instances.length > 0) {
            frames.push({ frameIdx, instances });
            totalInstances += instances.length;
            maxInstancesPerFrame = Math.max(maxInstancesPerFrame, instances.length);

            // Check for overlap
            if (bboxes.length > 1) {
                let hasOverlap = false;
                for (let a = 0; a < bboxes.length && !hasOverlap; a++) {
                    for (let b = a + 1; b < bboxes.length && !hasOverlap; b++) {
                        const ba = bboxes[a], bb = bboxes[b];
                        if (!(ba.maxX < bb.minX || bb.maxX < ba.minX ||
                              ba.maxY < bb.minY || bb.maxY < ba.minY)) {
                            hasOverlap = true;
                        }
                    }
                }
                if (hasOverlap) overlapFrames++;
            }
        }
    }

    h5file.close();
    FS.unlink(`/${filename}`);

    const avgInstancesPerFrame = frames.length > 0 ? totalInstances / frames.length : 0;
    const maxInstanceSize = instanceSizes.length > 0 ? Math.round(Math.max(...instanceSizes)) : 100;
    const multiInstanceFrames = frames.filter(f => f.instances.length > 1).length;
    const overlapFrequency = multiInstanceFrames > 0 ? overlapFrames / multiInstanceFrames : 0;

    return {
        skeleton,
        tracks,
        frames,
        stats: {
            videoWidth,
            videoHeight,
            avgInstancesPerFrame,
            maxInstancesPerFrame,
            maxInstanceSize,
            overlapFrequency
        }
    };
}

// Message handler
onmessage = async function(e) {
    const { type, buffer } = e.data;

    if (type !== 'parse') {
        postMessage({ error: 'Unknown message type' });
        return;
    }

    // Wait for h5wasm to be ready
    let attempts = 0;
    while (!h5wasmReady && attempts < 50) {
        await new Promise(r => setTimeout(r, 100));
        attempts++;
    }

    if (!h5wasmReady) {
        postMessage({ error: 'h5wasm failed to initialize' });
        return;
    }

    try {
        const result = await parseSlpFile(buffer);
        postMessage(result);
    } catch (err) {
        postMessage({ error: err.message });
    }
};
