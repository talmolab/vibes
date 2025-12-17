// h5ls Web Worker
// Uses h5wasm to read HDF5 file structure with WORKERFS (local) or createLazyFile (URL)

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

        // Process any pending messages
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

// Recursively collect all datasets and groups
function collectItems(group, prefix = '') {
    const datasets = [];
    const groups = [];

    try {
        const keys = group.keys();

        for (const key of keys) {
            const path = prefix ? `${prefix}/${key}` : key;

            try {
                const item = group.get(key);

                if (item.type === 'Dataset') {
                    // Collect attributes
                    const attrs = [];
                    try {
                        if (item.attrs) {
                            // h5wasm attrs is an object with attribute names as keys
                            const attrKeys = Object.keys(item.attrs).filter(k => !k.startsWith('_'));
                            attrs.push(...attrKeys);
                        }
                    } catch (e) {
                        log(`Error reading attrs for ${path}: ${e.message}`, 'warn');
                    }

                    datasets.push({
                        path,
                        shape: item.shape || [],
                        dtype: item.dtype || 'unknown',
                        size: item.size || 0,
                        attrs
                    });
                } else if (item.type === 'Group') {
                    // Collect group attributes
                    const attrs = [];
                    try {
                        if (item.attrs) {
                            const attrKeys = Object.keys(item.attrs).filter(k => !k.startsWith('_'));
                            attrs.push(...attrKeys);
                        }
                    } catch (e) {
                        log(`Error reading group attrs for ${path}: ${e.message}`, 'warn');
                    }

                    groups.push({ path, attrs });

                    // Recurse into group
                    const nested = collectItems(item, path);
                    datasets.push(...nested.datasets);
                    groups.push(...nested.groups);
                }
            } catch (err) {
                log(`Error reading ${path}: ${err.message}`, 'warn');
            }
        }
    } catch (err) {
        log(`Error listing ${prefix || '/'}: ${err.message}`, 'error');
    }

    return { datasets, groups };
}

// Load file using WORKERFS (zero-copy)
async function loadLocalFile(file) {
    setLoading('Mounting file with WORKERFS...');

    try {
        // Clean up previous mounts
        try { FS.unmount('/work'); } catch (e) { /* ignore */ }
        try { FS.rmdir('/work'); } catch (e) { /* ignore */ }

        FS.mkdir('/work');
        FS.mount(FS.filesystems.WORKERFS, { files: [file] }, '/work');

        const filePath = `/work/${file.name}`;
        log(`File mounted: ${filePath}`, 'info');

        setLoading('Opening HDF5 file...');
        const h5file = new h5wasm.File(filePath, 'r');
        log('File opened successfully', 'success');

        setLoading('Reading file structure...');
        const { datasets, groups } = collectItems(h5file);

        // Get root attributes
        const rootAttrs = [];
        try {
            if (h5file.attrs) {
                const attrKeys = Object.keys(h5file.attrs).filter(k => !k.startsWith('_'));
                rootAttrs.push(...attrKeys);
            }
        } catch (e) { /* ignore */ }

        postMessage({
            type: 'result',
            data: {
                filename: file.name,
                fileSize: file.size,
                source: 'Local file (WORKERFS)',
                datasets,
                groups,
                rootAttrs
            }
        });

        h5file.close();

    } catch (err) {
        log(`Error: ${err.message}`, 'error');
        postMessage({ type: 'error', data: { message: err.message } });
    }
}

// Load file from URL using createLazyFile (range requests) or full download
async function loadUrlFile(url) {
    setLoading('Checking server for range request support...');

    try {
        // Check if server supports range requests
        const headResponse = await fetch(url, { method: 'HEAD' });

        if (!headResponse.ok) {
            throw new Error(`Failed to fetch URL: ${headResponse.status} ${headResponse.statusText}`);
        }

        const contentLength = parseInt(headResponse.headers.get('Content-Length')) || 0;
        const acceptRanges = headResponse.headers.get('Accept-Ranges');
        const supportsRanges = acceptRanges === 'bytes';

        log(`Server: Content-Length=${contentLength}, Accept-Ranges=${acceptRanges || 'none'}`, 'info');

        const filename = url.split('/').pop().split('?')[0] || 'remote.h5';
        let source;

        if (supportsRanges && contentLength > 0) {
            // Use createLazyFile for streaming
            log('Using lazy file with HTTP range requests', 'success');
            setLoading('Creating lazy file...');

            // Clean up previous files
            try { FS.unlink(`/remote/${filename}`); } catch (e) { /* ignore */ }
            try { FS.rmdir('/remote'); } catch (e) { /* ignore */ }

            FS.mkdir('/remote');
            FS.createLazyFile('/remote', filename, url, true, false);

            source = 'URL (range requests)';
        } else {
            // Fall back to full download
            log('Server does not support range requests, downloading entire file...', 'warn');
            setLoading('Downloading file...');

            const response = await fetch(url);
            const arrayBuffer = await response.arrayBuffer();

            FS.writeFile(`/${filename}`, new Uint8Array(arrayBuffer));

            source = 'URL (full download)';
            log(`Downloaded ${(arrayBuffer.byteLength / 1024 / 1024).toFixed(2)} MB`, 'info');
        }

        const filePath = supportsRanges && contentLength > 0 ? `/remote/${filename}` : `/${filename}`;

        setLoading('Opening HDF5 file...');
        const h5file = new h5wasm.File(filePath, 'r');
        log('File opened successfully', 'success');

        setLoading('Reading file structure...');
        const { datasets, groups } = collectItems(h5file);

        // Get root attributes
        const rootAttrs = [];
        try {
            if (h5file.attrs) {
                const attrKeys = Object.keys(h5file.attrs).filter(k => !k.startsWith('_'));
                rootAttrs.push(...attrKeys);
            }
        } catch (e) { /* ignore */ }

        postMessage({
            type: 'result',
            data: {
                filename,
                fileSize: contentLength,
                source,
                datasets,
                groups,
                rootAttrs
            }
        });

        h5file.close();

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
