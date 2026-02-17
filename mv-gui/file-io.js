/**
 * file-io.js - File loading for calibration, videos, and sessions.
 *
 * Provides:
 *   - pickFiles(): Generic file picker
 *   - parseCalibrationTOML(text): Parse sleap-io TOML calibration → Camera[]
 *   - parseCalibrationJSON(text): Parse JSON calibration → Camera[]
 *   - loadCalibrationFile(): Full flow: pick file → parse → return Camera[]
 *   - pickVideoFiles(): Pick multiple .mp4 files
 *
 * Depends on pose-data.js (Camera class).
 * All functions are vanilla JS globals -- no imports/exports.
 */

// ============================================
// Generic file picker
// ============================================

/**
 * Open a file picker dialog and return selected files.
 *
 * @param {Object} [options]
 * @param {string} [options.accept] - Accept attribute (e.g. ".toml,.json")
 * @param {boolean} [options.multiple] - Allow multiple file selection
 * @returns {Promise<File[]>} Array of selected files (empty if cancelled)
 */
function pickFiles(options) {
    options = options || {};
    return new Promise(function (resolve) {
        const input = document.createElement('input');
        input.type = 'file';
        if (options.accept) input.accept = options.accept;
        if (options.multiple) input.multiple = true;

        input.addEventListener('change', function () {
            const files = input.files ? Array.from(input.files) : [];
            resolve(files);
        });

        // Handle cancel (no change event fires)
        input.addEventListener('cancel', function () {
            resolve([]);
        });

        input.click();
    });
}

// ============================================
// TOML calibration parser
// ============================================

/**
 * Parse a sleap-io format TOML calibration string into Camera objects.
 *
 * TOML format (per camera section):
 *   [cam_N]
 *   name = "back"
 *   size = [ 1280, 1024,]
 *   matrix = [ [ fx, 0.0, cx,], [ 0.0, fy, cy,], [ 0.0, 0.0, 1.0,],]
 *   distortions = [ k1, k2, p1, p2, k3,]
 *   rotation = [ rx, ry, rz,]
 *   translation = [ tx, ty, tz,]
 *
 * @param {string} text - TOML file content
 * @returns {Camera[]} Array of Camera objects
 */
function parseCalibrationTOML(text) {
    const cameras = [];

    // Split into sections by [section_name] headers
    // Match lines like [cam_0], [cam_1], [metadata], etc.
    const sectionRegex = /^\[([^\]]+)\]\s*$/gm;
    const sections = [];
    let match;
    while ((match = sectionRegex.exec(text)) !== null) {
        sections.push({ name: match[1], start: match.index + match[0].length });
    }

    for (let i = 0; i < sections.length; i++) {
        const section = sections[i];
        // Skip non-camera sections (e.g. [metadata])
        if (!section.name.startsWith('cam_')) continue;

        const end = i + 1 < sections.length ? sections[i + 1].start : text.length;
        const body = text.substring(section.start, end);

        // Parse key-value pairs from the section body
        const props = parseTOMLSection(body);

        const name = props.name || section.name;
        const size = props.size || [640, 480];
        const matrix = props.matrix || [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
        const dist = props.distortions || [0, 0, 0, 0, 0];
        const rvec = props.rotation || [0, 0, 0];
        const tvec = props.translation || [0, 0, 0];

        cameras.push(new Camera(name, matrix, dist, rvec, tvec, size));
    }

    return cameras;
}

/**
 * Parse key-value pairs from a TOML section body.
 * Handles strings, arrays, and nested arrays with trailing commas.
 *
 * @param {string} body - Section text (lines after [section_name])
 * @returns {Object} Key-value map
 */
function parseTOMLSection(body) {
    const result = {};
    const lines = body.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith('#') || line.startsWith('[')) continue;

        const eqIdx = line.indexOf('=');
        if (eqIdx === -1) continue;

        const key = line.substring(0, eqIdx).trim();
        let value = line.substring(eqIdx + 1).trim();

        // Remove quotes for string values
        if (value.startsWith('"') && value.endsWith('"')) {
            result[key] = value.slice(1, -1);
            continue;
        }

        // Clean trailing commas inside arrays (TOML allows them, JSON doesn't)
        // Replace ",]" with "]" and ", ]" with "]"
        value = value.replace(/,\s*\]/g, ']');

        // Try to parse as JSON (arrays, numbers, booleans)
        try {
            result[key] = JSON.parse(value);
        } catch (e) {
            // Store as string if can't parse
            result[key] = value;
        }
    }

    return result;
}

// ============================================
// JSON calibration parser
// ============================================

/**
 * Parse a JSON calibration object into Camera objects.
 *
 * Expected format:
 *   { "cameras": [
 *       { "name": "back", "size": [w,h], "matrix": [[...]], "dist": [...],
 *         "rvec": [...], "tvec": [...] },
 *       ...
 *   ]}
 *
 * Or the export format from mv-gui:
 *   { "cameras": [
 *       { "name": "...", "matrix": [[...]], "dist": [...],
 *         "rvec": [...], "tvec": [...], "size": [...] },
 *       ...
 *   ]}
 *
 * @param {string} text - JSON file content
 * @returns {Camera[]} Array of Camera objects
 */
function parseCalibrationJSON(text) {
    const data = JSON.parse(text);
    const cameras = [];

    const camArray = data.cameras || data;
    if (!Array.isArray(camArray)) {
        throw new Error('JSON calibration must contain a "cameras" array or be an array');
    }

    for (let i = 0; i < camArray.length; i++) {
        const c = camArray[i];
        const name = c.name || ('cam_' + i);
        const matrix = c.matrix || [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
        const dist = c.dist || c.distortions || [0, 0, 0, 0, 0];
        const rvec = c.rvec || c.rotation || [0, 0, 0];
        const tvec = c.tvec || c.translation || [0, 0, 0];
        const size = c.size || [640, 480];

        cameras.push(new Camera(name, matrix, dist, rvec, tvec, size));
    }

    return cameras;
}

// ============================================
// High-level file loading flows
// ============================================

/**
 * Open a file picker for calibration files (.toml, .json) and parse them.
 *
 * @returns {Promise<Camera[]|null>} Array of cameras, or null if cancelled/error
 */
async function loadCalibrationFile() {
    const files = await pickFiles({ accept: '.toml,.json' });
    if (files.length === 0) return null;

    const file = files[0];
    const text = await file.text();

    if (file.name.endsWith('.toml')) {
        return parseCalibrationTOML(text);
    } else if (file.name.endsWith('.json')) {
        return parseCalibrationJSON(text);
    } else {
        throw new Error('Unsupported calibration format: ' + file.name);
    }
}

/**
 * Open a file picker for video files (.mp4, .avi, .webm).
 *
 * @returns {Promise<File[]>} Array of video files (empty if cancelled)
 */
async function pickVideoFiles() {
    return pickFiles({ accept: '.mp4,.avi,.webm,.mov', multiple: true });
}

/**
 * Match video files to camera names by filename.
 * Tries to match the filename stem (without extension) to camera names.
 *
 * @param {File[]} files - Video files
 * @param {Camera[]} cameras - Camera objects with .name
 * @returns {Map<string, File>} camera name -> File
 */
function matchVideosToCameras(files, cameras) {
    const result = new Map();
    const cameraNames = cameras.map(function (c) { return c.name; });

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        // Get filename without extension
        const stem = file.name.replace(/\.[^.]+$/, '');

        // Try exact match
        if (cameraNames.indexOf(stem) >= 0) {
            result.set(stem, file);
            continue;
        }

        // Try case-insensitive match
        const lower = stem.toLowerCase();
        for (let j = 0; j < cameraNames.length; j++) {
            if (cameraNames[j].toLowerCase() === lower) {
                result.set(cameraNames[j], file);
                break;
            }
        }
    }

    return result;
}

/**
 * Build a dynamic video grid in the given container for the specified camera names.
 * Creates video cells with canvases and overlay canvases.
 *
 * @param {HTMLElement} gridElement - The .video-grid container
 * @param {string[]} cameraNames - Array of camera names
 * @returns {Object[]} Array of { name, canvas, overlayCanvas, cell } for each camera
 */
function buildVideoGrid(gridElement, cameraNames) {
    // Clear existing cells
    gridElement.innerHTML = '';

    // Compute grid layout
    const count = cameraNames.length;
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);
    gridElement.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
    gridElement.style.gridTemplateRows = 'repeat(' + rows + ', 1fr)';

    const views = [];
    for (let i = 0; i < cameraNames.length; i++) {
        const name = cameraNames[i];

        const cell = document.createElement('div');
        cell.className = 'video-cell';
        cell.id = 'cell-' + name;

        const label = document.createElement('span');
        label.className = 'view-label';
        label.textContent = name;

        const canvas = document.createElement('canvas');
        canvas.id = 'canvas-' + name;

        const overlayCanvas = document.createElement('canvas');
        overlayCanvas.className = 'overlay-canvas';
        overlayCanvas.id = 'overlay-' + name;

        cell.appendChild(label);
        cell.appendChild(canvas);
        cell.appendChild(overlayCanvas);
        gridElement.appendChild(cell);

        views.push({
            name: name,
            canvas: canvas,
            overlayCanvas: overlayCanvas,
            cell: cell,
        });
    }

    return views;
}
