/**
 * Bundle Adjustment Wrapper for calibration-studio
 *
 * This module provides a clean API for running sparse bundle adjustment
 * using the apex-solver-wasm WASM module.
 *
 * Usage:
 *   import { runBundleAdjustment, initSBA } from './sba-wrapper.js';
 *
 *   // Optional: pre-initialize (will auto-init on first call otherwise)
 *   await initSBA();
 *
 *   // Run optimization
 *   const result = await runBundleAdjustment({
 *     cameras: [...],
 *     points: [...],
 *     observations: [...],
 *     point_to_frame: [...],  // optional
 *   }, {
 *     max_iterations: 100,
 *     robust_loss: 'huber',
 *     // ... other config options
 *   });
 */

// Configuration for WASM module location
// The WASM files are in the same directory as this wrapper
const WASM_MODULE_URL = new URL('./sba_solver_wasm.js', import.meta.url).href;

let wasmModule = null;
let initialized = false;

/**
 * Initialize the WASM module.
 * Called automatically on first use, but can be called explicitly for preloading.
 *
 * @param {string} [moduleUrl] - Optional URL to load module from (for CDN usage)
 * @returns {Promise<void>}
 */
export async function initSBA(moduleUrl = WASM_MODULE_URL) {
    if (initialized) return;

    wasmModule = await import(moduleUrl);
    await wasmModule.default();
    initialized = true;
}

/**
 * Default configuration for bundle adjustment.
 * All options can be overridden via the config parameter.
 */
const DEFAULT_CONFIG = {
    // Solver settings
    max_iterations: 100,
    cost_tolerance: 1e-6,
    parameter_tolerance: 1e-8,
    gradient_tolerance: 1e-10,

    // Robust loss function
    robust_loss: 'huber',      // 'none', 'huber', or 'cauchy'
    robust_loss_param: 1.0,    // Scale parameter for robust loss

    // What to optimize
    optimize_extrinsics: true,
    optimize_points: true,
    optimize_intrinsics: false,

    // Outlier handling
    outlier_threshold: 0,      // 0 = disabled, otherwise filter observations with error > threshold

    // Gauge fixing
    reference_camera: 0,       // Camera index to hold fixed (gauge reference)

    // Frame filtering
    ignore_frames: [],         // Array of frame indices to exclude from optimization
};

/**
 * Run sparse bundle adjustment on calibration data.
 *
 * @param {Object} data - Input data
 * @param {Array<CameraParams>} data.cameras - Camera parameters
 * @param {Array<[number, number, number]>} data.points - 3D points
 * @param {Array<Observation>} data.observations - 2D observations
 * @param {Array<number>} [data.point_to_frame] - Optional mapping from point index to frame index
 * @param {Object} [config] - Configuration options (merged with defaults)
 * @returns {Promise<BundleAdjustmentResult>}
 *
 * @typedef {Object} CameraParams
 * @property {[number, number, number, number]} rotation - Quaternion [w, x, y, z]
 * @property {[number, number, number]} translation - Translation [x, y, z]
 * @property {[number, number]} focal - Focal lengths [fx, fy]
 * @property {[number, number]} principal - Principal point [cx, cy]
 * @property {[number, number, number, number, number]} distortion - [k1, k2, p1, p2, k3]
 *
 * @typedef {Object} Observation
 * @property {number} camera_idx - Camera index
 * @property {number} point_idx - Point index
 * @property {number} x - Observed x coordinate
 * @property {number} y - Observed y coordinate
 *
 * @typedef {Object} BundleAdjustmentResult
 * @property {Array<CameraParams>} cameras - Optimized camera parameters
 * @property {Array<[number, number, number]>} points - Optimized 3D points
 * @property {number} initial_cost - Initial sum of squared reprojection errors
 * @property {number} final_cost - Final cost after optimization
 * @property {number} iterations - Number of iterations performed
 * @property {boolean} converged - Whether the solver converged
 * @property {string} status - Convergence status message
 * @property {Array<number>} [cost_history] - Cost at each iteration (if available)
 * @property {number} [num_observations_used] - Number of observations used (after filtering)
 * @property {number} [num_observations_filtered] - Number of outliers filtered
 * @property {number} [num_observations_filtered_by_frame] - Number filtered by frame
 */
export async function runBundleAdjustment(data, config = {}) {
    // Ensure WASM is initialized
    await initSBA();

    // Validate required data
    if (!data.cameras || !Array.isArray(data.cameras)) {
        throw new Error('data.cameras is required and must be an array');
    }
    if (!data.points || !Array.isArray(data.points)) {
        throw new Error('data.points is required and must be an array');
    }
    if (!data.observations || !Array.isArray(data.observations)) {
        throw new Error('data.observations is required and must be an array');
    }

    // Create bundle adjuster instance
    const ba = new wasmModule.WasmBundleAdjuster();

    // Set input data
    ba.set_cameras(JSON.stringify(data.cameras));
    ba.set_points(JSON.stringify(data.points));
    ba.set_observations(JSON.stringify(data.observations));

    // Set optional point-to-frame mapping (needed for frame filtering)
    if (data.point_to_frame && Array.isArray(data.point_to_frame)) {
        ba.set_point_to_frame(JSON.stringify(data.point_to_frame));
    }

    // Merge config with defaults
    const fullConfig = { ...DEFAULT_CONFIG, ...config };
    ba.set_config(JSON.stringify(fullConfig));

    // Run optimization
    const resultJson = ba.optimize();

    return JSON.parse(resultJson);
}

/**
 * Compute reprojection error for a single observation.
 * Useful for computing per-observation errors before/after optimization.
 *
 * @param {[number, number, number]} point3d - 3D point
 * @param {CameraParams} camera - Camera parameters
 * @param {[number, number]} observed - Observed 2D point
 * @returns {number} Reprojection error in pixels
 */
export function computeReprojectionError(point3d, camera, observed) {
    const projected = projectPoint(point3d, camera);
    if (isNaN(projected[0]) || isNaN(projected[1])) {
        return Infinity;
    }
    return Math.sqrt(
        Math.pow(projected[0] - observed[0], 2) +
        Math.pow(projected[1] - observed[1], 2)
    );
}

/**
 * Project a 3D point to 2D using camera parameters.
 *
 * @param {[number, number, number]} point3d - 3D point in world coordinates
 * @param {CameraParams} camera - Camera parameters
 * @returns {[number, number]} Projected 2D point in pixels
 */
export function projectPoint(point3d, camera) {
    // Transform point from world to camera coordinates
    const [w, x, y, z] = camera.rotation;
    const p = point3d;

    // Quaternion rotation: p' = q * p * q^-1
    const rotated = quaternionRotate([w, x, y, z], p);

    // Add translation
    const camPoint = [
        rotated[0] + camera.translation[0],
        rotated[1] + camera.translation[1],
        rotated[2] + camera.translation[2]
    ];

    // Check for points behind camera
    if (camPoint[2] <= 0) {
        return [NaN, NaN];
    }

    // Normalize
    const xn = camPoint[0] / camPoint[2];
    const yn = camPoint[1] / camPoint[2];

    // Apply distortion
    const [k1, k2, p1, p2, k3] = camera.distortion;
    const r2 = xn * xn + yn * yn;
    const r4 = r2 * r2;
    const r6 = r4 * r2;

    const radial = 1 + k1 * r2 + k2 * r4 + k3 * r6;
    const xd = xn * radial + 2 * p1 * xn * yn + p2 * (r2 + 2 * xn * xn);
    const yd = yn * radial + 2 * p2 * xn * yn + p1 * (r2 + 2 * yn * yn);

    // Project to pixels
    const [fx, fy] = camera.focal;
    const [cx, cy] = camera.principal;

    return [fx * xd + cx, fy * yd + cy];
}

// Helper: quaternion rotation
function quaternionRotate(q, v) {
    const [w, x, y, z] = q;
    const [vx, vy, vz] = v;

    // t = 2 * cross(q.xyz, v)
    const tx = 2 * (y * vz - z * vy);
    const ty = 2 * (z * vx - x * vz);
    const tz = 2 * (x * vy - y * vx);

    // v' = v + w * t + cross(q.xyz, t)
    return [
        vx + w * tx + (y * tz - z * ty),
        vy + w * ty + (z * tx - x * tz),
        vz + w * tz + (x * ty - y * tx)
    ];
}

/**
 * Compute statistics for an array of errors.
 *
 * @param {number[]} errors - Array of error values
 * @returns {Object} Statistics object with min, max, mean, median, p90, p95, p99
 */
export function computeErrorStats(errors) {
    if (!errors.length) return null;

    const sorted = [...errors].sort((a, b) => a - b);
    const n = sorted.length;

    return {
        min: sorted[0],
        max: sorted[n - 1],
        mean: errors.reduce((a, b) => a + b, 0) / n,
        median: n % 2 === 0 ? (sorted[n/2 - 1] + sorted[n/2]) / 2 : sorted[Math.floor(n/2)],
        p90: sorted[Math.floor(n * 0.9)],
        p95: sorted[Math.floor(n * 0.95)],
        p99: sorted[Math.floor(n * 0.99)],
        count: n
    };
}
