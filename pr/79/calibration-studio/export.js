/**
 * Export module for multi-camera calibration
 * Handles TOML and JSON export formats
 */

// Helper for logging (uses global log function if available)
function exportLog(msg, level = 'info') {
    if (typeof log === 'function') {
        log(msg, level);
    } else {
        console.log(`[${level}] ${msg}`);
    }
}

// ============================================
// TOML Export
// ============================================

/**
 * Generate TOML output from calibration state
 * @param {Object} state - Global state with intrinsics and extrinsics
 * @param {Array} viewNames - Array of view names in order
 * @returns {string|null} TOML string or null if data missing
 */
function generateTomlOutput(state, viewNames) {
    if (Object.keys(state.intrinsics).length === 0 || Object.keys(state.extrinsics).length === 0) {
        return null;
    }

    let toml = '# Multi-Camera Calibration Output\n';
    toml += `# Generated: ${new Date().toISOString()}\n`;
    toml += `# Reference camera: ${viewNames[0]}\n\n`;

    for (let i = 0; i < viewNames.length; i++) {
        const name = viewNames[i];
        const intr = state.intrinsics[name];
        const extr = state.extrinsics[name];

        if (!intr || !extr) continue;

        toml += `[cam_${i}]\n`;
        toml += `name = "${name}"\n`;
        toml += `size = [${intr.imageSize.width}, ${intr.imageSize.height}]\n`;

        // Camera matrix as nested array
        const K = intr.cameraMatrix;
        toml += `matrix = [[${K[0][0].toFixed(6)}, ${K[0][1].toFixed(6)}, ${K[0][2].toFixed(6)}], `;
        toml += `[${K[1][0].toFixed(6)}, ${K[1][1].toFixed(6)}, ${K[1][2].toFixed(6)}], `;
        toml += `[${K[2][0].toFixed(6)}, ${K[2][1].toFixed(6)}, ${K[2][2].toFixed(6)}]]\n`;

        // Distortion coefficients
        const d = intr.distCoeffs;
        toml += `distortions = [${d.map(v => v.toFixed(10)).join(', ')}]\n`;

        // Rotation (Rodrigues vector)
        const r = extr.rvec;
        toml += `rotation = [${r.map(v => v.toFixed(10)).join(', ')}]\n`;

        // Translation
        const t = extr.tvec;
        toml += `translation = [${t.map(v => v.toFixed(6)).join(', ')}]\n`;

        toml += '\n';
    }

    return toml;
}

/**
 * Update TOML preview element
 * @param {Object} state - Global state
 * @param {Array} viewNames - Array of view names
 */
function updateTomlPreview(state, viewNames) {
    const preview = document.getElementById('tomlPreview');
    const toml = generateTomlOutput(state, viewNames);
    if (toml) {
        preview.textContent = toml;
        preview.style.color = '';  // Reset to default color
    } else {
        preview.textContent = '# Complete intrinsic and extrinsic calibration to generate TOML';
        preview.style.color = '#888';
    }
}

/**
 * Export calibration as TOML file
 * @param {Object} state - Global state
 * @param {Array} viewNames - Array of view names
 */
function exportToml(state, viewNames) {
    const toml = generateTomlOutput(state, viewNames);
    if (!toml) {
        exportLog('Missing calibration data. Complete intrinsic and extrinsic calibration first.', 'error');
        return;
    }

    // Trigger download
    const blob = new Blob([toml], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'calibration.toml';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    exportLog('Exported calibration.toml', 'success');
}

// ============================================
// SBA JSON Export
// ============================================

/**
 * Generate SBA JSON output for bundle adjustment
 * @param {Object} state - Global state with detections, intrinsics, extrinsics
 * @param {Array} viewNames - Array of view names
 * @param {Object} config - Board configuration
 * @returns {Object|null} JSON data object or null if data missing
 */
function generateSbaJsonOutput(state, viewNames, config) {
    if (Object.keys(state.intrinsics).length === 0 || Object.keys(state.extrinsics).length === 0) {
        return null;
    }

    // Build cameras object with intrinsics and extrinsics
    const cameras = {};
    for (const name of viewNames) {
        const intr = state.intrinsics[name];
        const extr = state.extrinsics[name];
        if (!intr || !extr) continue;

        cameras[name] = {
            image_size: [intr.imageSize.width, intr.imageSize.height],
            // Intrinsics
            K: intr.cameraMatrix,
            dist_coeffs: intr.distCoeffs,
            intrinsics_rms_error: intr.rmsError,
            // Extrinsics (relative to reference camera)
            R: extr.R,
            rvec: extr.rvec,
            tvec: extr.tvec,
            extrinsics_rms_error: extr.rmsError,
            // Per-frame intrinsic calibration poses (board-to-camera)
            intrinsic_poses: {
                frames: intr.frameIndices,
                rvecs: intr.rvecs,
                tvecs: intr.tvecs,
                per_frame_errors: intr.perImageErrors
            }
        };
    }

    // Build observations: 2D detections per frame per camera
    const observations = [];
    for (const detection of state.detections) {
        const frameObs = {
            frame: detection.frame,
            views: {}
        };

        for (const viewName of viewNames) {
            const viewResult = detection.views[viewName];
            if (viewResult && !viewResult.error && viewResult.charucoCorners) {
                frameObs.views[viewName] = {
                    corner_ids: viewResult.charucoIds,
                    corners_2d: viewResult.charucoCorners.map(pt => [pt.x, pt.y]),
                    num_corners: viewResult.numCharucoCorners
                };
            }
        }

        // Only include frames with at least one valid detection
        if (Object.keys(frameObs.views).length > 0) {
            observations.push(frameObs);
        }
    }

    // Build triangulated points from extrinsics reprojection data
    const triangulated_points = [];
    if (state.extrinsicsReprojData && state.extrinsicsReprojData.length > 0) {
        for (const frameData of state.extrinsicsReprojData) {
            for (const pt of frameData.pointErrors) {
                triangulated_points.push({
                    frame: frameData.frame,
                    corner_id: pt.pointId,
                    point_3d: [pt.point3D.x, pt.point3D.y, pt.point3D.z],
                    mean_reproj_error: pt.meanError,
                    per_camera_errors: Object.fromEntries(
                        Object.entries(pt.perCameraErrors).map(([cam, data]) => [
                            cam,
                            {
                                error: data.error,
                                detected: [data.detected.x, data.detected.y],
                                projected: [data.projected.x, data.projected.y]
                            }
                        ])
                    )
                });
            }
        }
    }

    // Compute board corner 3D positions (in board coordinate frame)
    const board_corners_3d = {};
    const numCornersX = config.boardX - 1;
    const numCornersY = config.boardY - 1;
    for (let y = 0; y < numCornersY; y++) {
        for (let x = 0; x < numCornersX; x++) {
            const cornerId = y * numCornersX + x;
            board_corners_3d[cornerId] = [
                x * config.squareLength,
                y * config.squareLength,
                0
            ];
        }
    }

    const output = {
        metadata: {
            generated: new Date().toISOString(),
            generator: 'multicam-calibration-gui',
            reference_camera: viewNames[0],
            num_cameras: viewNames.length,
            num_frames: state.totalFrames,
            num_detection_frames: observations.length,
            num_triangulated_points: triangulated_points.length
        },
        board: {
            type: 'charuco',
            board_x: config.boardX,
            board_y: config.boardY,
            square_length: config.squareLength,
            marker_length: config.markerLength,
            corners_3d: board_corners_3d
        },
        cameras: cameras,
        observations: observations,
        triangulated_points: triangulated_points
    };

    return output;
}

/**
 * Export SBA data as JSON file
 * @param {Object} state - Global state
 * @param {Array} viewNames - Array of view names
 * @param {Object} config - Board configuration
 */
function exportSbaJson(state, viewNames, config) {
    const data = generateSbaJsonOutput(state, viewNames, config);
    if (!data) {
        exportLog('Missing calibration data. Complete intrinsic and extrinsic calibration first.', 'error');
        return;
    }

    const json = JSON.stringify(data, null, 2);

    // Trigger download
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'calibration_sba_data.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    exportLog(`Exported SBA data: ${data.observations.length} frames, ${data.triangulated_points.length} points`, 'success');
}
