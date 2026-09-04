// ============================================
// Overlay and Visualization Functions
// ============================================

/**
 * Draw detection overlay on video canvases
 * @param {Array} results - Detection results per view
 * @param {Object} state - Application state with views array
 */
function drawDetectionOverlay(results, state) {
    for (let i = 0; i < state.views.length; i++) {
        const view = state.views[i];
        const result = results[i];
        if (!result || result.error || !result.charucoCorners) continue;

        const ctx = view.ctx;

        // Draw detected corners
        ctx.fillStyle = '#4ade80';
        ctx.strokeStyle = '#22c55e';
        ctx.lineWidth = 2;

        for (let j = 0; j < result.charucoCorners.length; j++) {
            const corner = result.charucoCorners[j];
            const id = result.charucoIds[j];

            // Draw corner point
            ctx.beginPath();
            ctx.arc(corner.x, corner.y, 6, 0, 2 * Math.PI);
            ctx.fill();
            ctx.stroke();

            // Draw ID label
            ctx.font = '12px monospace';
            ctx.fillStyle = '#fff';
            ctx.fillText(id.toString(), corner.x + 8, corner.y - 8);
            ctx.fillStyle = '#4ade80';
        }
    }
}

/**
 * Draw unified legend for all overlays
 * @param {Object} state - Application state
 */
function drawOverlayLegends(state) {
    const showIntrinsics = state.showReprojection && Object.keys(state.intrinsics).length > 0;
    const showExtrinsics = state.showExtrinsicsReproj && state.extrinsicsReprojData && state.extrinsicsReprojData.length > 0;

    if (!showIntrinsics && !showExtrinsics) return;

    // Calculate legend height based on what's shown
    // Each entry is ~20px, plus 8px padding top/bottom
    let numEntries = 1;  // "Detected" is always shown
    if (showIntrinsics) numEntries++;  // "Reproj (intrinsic)"
    if (showExtrinsics) numEntries++;  // "Triangulated"
    const legendHeight = 16 + numEntries * 20;

    for (let i = 0; i < state.views.length; i++) {
        const view = state.views[i];
        const ctx = view.ctx;
        const legendX = view.canvas.width - 148;

        ctx.font = '12px system-ui, sans-serif';
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(legendX, 8, 140, legendHeight);

        let yOffset = 22;

        // Detected (pastel green circle) - always shown when any reprojection overlay is on
        ctx.fillStyle = '#86efac';
        ctx.beginPath();
        ctx.arc(legendX + 14, yOffset, 5, 0, 2 * Math.PI);
        ctx.fill();
        ctx.strokeStyle = '#166534';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.fillText('Detected', legendX + 27, yOffset + 4);
        yOffset += 20;

        // Reproj (intrinsic) - red X
        if (showIntrinsics) {
            ctx.strokeStyle = '#ef4444';
            ctx.lineWidth = 2;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(legendX + 9, yOffset - 5);
            ctx.lineTo(legendX + 19, yOffset + 5);
            ctx.moveTo(legendX + 19, yOffset - 5);
            ctx.lineTo(legendX + 9, yOffset + 5);
            ctx.stroke();
            ctx.fillStyle = '#fff';
            ctx.fillText('Reproj (intrinsic)', legendX + 27, yOffset + 4);
            yOffset += 20;
        }

        // Triangulated - pastel blue cross
        if (showExtrinsics) {
            ctx.strokeStyle = '#60a5fa';
            ctx.lineWidth = 1.5;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(legendX + 9, yOffset);
            ctx.lineTo(legendX + 19, yOffset);
            ctx.moveTo(legendX + 14, yOffset - 5);
            ctx.lineTo(legendX + 14, yOffset + 5);
            ctx.stroke();
            ctx.fillStyle = '#fff';
            ctx.fillText('Triangulated', legendX + 27, yOffset + 4);
        }
    }
}

/**
 * Draw intrinsics reprojection overlay
 * @param {Object} state - Application state
 * @param {string} phase - 'circles', 'markers', or 'all'
 */
function drawReprojectionOverlay(state, phase = 'all') {
    if (!state.showReprojection || Object.keys(state.intrinsics).length === 0) return;

    // Try to find the calibration frame index for the current video frame
    const firstIntrinsics = Object.values(state.intrinsics)[0];
    if (firstIntrinsics && firstIntrinsics.frameIndices) {
        const matchIdx = firstIntrinsics.frameIndices.indexOf(state.currentFrame);
        if (matchIdx !== -1) {
            state.reprojectionFrameIndex = matchIdx;
        }
    }

    for (let i = 0; i < state.views.length; i++) {
        const view = state.views[i];
        const intrinsics = state.intrinsics[view.name];
        if (!intrinsics || !intrinsics.objectPoints || !intrinsics.imagePoints) continue;

        const frameIdx = state.reprojectionFrameIndex % intrinsics.objectPoints.length;
        const objPts = intrinsics.objectPoints[frameIdx];
        const imgPts = intrinsics.imagePoints[frameIdx];
        const rvec = intrinsics.rvecs[frameIdx];
        const tvec = intrinsics.tvecs[frameIdx];

        if (!objPts || !imgPts || !rvec || !tvec) continue;

        // Compute reprojected points using OpenCV
        const objMat = new cv.Mat(objPts.length, 1, cv.CV_64FC3);
        for (let j = 0; j < objPts.length; j++) {
            objMat.doublePtr(j, 0)[0] = objPts[j].x;
            objMat.doublePtr(j, 0)[1] = objPts[j].y;
            objMat.doublePtr(j, 0)[2] = objPts[j].z;
        }

        const rvecMat = cv.matFromArray(3, 1, cv.CV_64F, rvec);
        const tvecMat = cv.matFromArray(3, 1, cv.CV_64F, tvec);
        const cameraMat = cv.matFromArray(3, 3, cv.CV_64F, intrinsics.cameraMatrix.flat());
        const distMat = cv.matFromArray(5, 1, cv.CV_64F, intrinsics.distCoeffs);
        const projectedPts = new cv.Mat();

        try {
            cv.projectPoints(objMat, rvecMat, tvecMat, cameraMat, distMat, projectedPts);
        } catch (err) {
            console.error(`Intrinsics reprojection error for ${view.name}:`, err);
            objMat.delete();
            rvecMat.delete();
            tvecMat.delete();
            cameraMat.delete();
            distMat.delete();
            projectedPts.delete();
            continue;
        }

        try {
            const ctx = view.ctx;

            // Phase 1: Draw original detected points (pastel green circles with dark border)
            if (phase === 'circles' || phase === 'all') {
                for (let j = 0; j < imgPts.length; j++) {
                    const pt = imgPts[j];
                    ctx.beginPath();
                    ctx.arc(pt.x, pt.y, 6, 0, 2 * Math.PI);
                    ctx.fillStyle = '#86efac';  // Pastel green
                    ctx.fill();
                    ctx.strokeStyle = '#166534';  // Dark green border
                    ctx.lineWidth = 1.5;
                    ctx.stroke();
                }
            }

            // Phase 2: Draw reprojected points (red X's with white shadow)
            if (phase === 'markers' || phase === 'all') {
                const xSize = 5;
                for (let j = 0; j < projectedPts.rows; j++) {
                    const px = projectedPts.doubleAt(j, 0);
                    const py = projectedPts.doubleAt(j, 1);

                    // White shadow for visibility
                    ctx.strokeStyle = '#fff';
                    ctx.lineWidth = 4;
                    ctx.lineCap = 'round';
                    ctx.beginPath();
                    ctx.moveTo(px - xSize, py - xSize);
                    ctx.lineTo(px + xSize, py + xSize);
                    ctx.moveTo(px + xSize, py - xSize);
                    ctx.lineTo(px - xSize, py + xSize);
                    ctx.stroke();

                    // Red X
                    ctx.strokeStyle = '#ef4444';
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.moveTo(px - xSize, py - xSize);
                    ctx.lineTo(px + xSize, py + xSize);
                    ctx.moveTo(px + xSize, py - xSize);
                    ctx.lineTo(px - xSize, py + xSize);
                    ctx.stroke();
                }
            }

            // Frame info (only draw once in markers phase or 'all')
            if (phase === 'markers' || phase === 'all') {
                ctx.font = '12px system-ui, sans-serif';
                ctx.fillStyle = 'rgba(0,0,0,0.7)';
                ctx.fillRect(8, view.canvas.height - 30, 140, 22);
                ctx.fillStyle = '#aaa';
                ctx.fillText(`Intr ${frameIdx + 1}/${intrinsics.objectPoints.length}`, 12, view.canvas.height - 14);
            }

        } finally {
            objMat.delete();
            rvecMat.delete();
            tvecMat.delete();
            cameraMat.delete();
            distMat.delete();
            projectedPts.delete();
        }
    }
}

/**
 * Draw swarm plot for intrinsics per-image errors
 * @param {Object} state - Application state
 */
function drawSwarmPlot(state) {
    const canvas = document.getElementById('swarmPlotCanvas');
    const ctx = canvas.getContext('2d');
    const tooltip = document.getElementById('swarmTooltip');

    // Get all camera names and their errors
    const cameras = Object.keys(state.intrinsics);
    if (cameras.length === 0) return;

    // Collect all errors for computing scale (use allPerImageErrors to include excluded frames)
    let allErrors = [];
    cameras.forEach(cam => {
        const errors = state.intrinsics[cam].allPerImageErrors || state.intrinsics[cam].perImageErrors || [];
        allErrors = allErrors.concat(errors.filter(e => !isNaN(e)));
    });

    if (allErrors.length === 0) return;

    // Clear canvas
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    // Layout constants
    const padding = { left: 60, right: 30, top: 30, bottom: 50 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;

    // Compute log scale range (ensure positive values)
    const minError = Math.max(0.01, Math.min(...allErrors));
    const maxError = Math.max(...allErrors);
    const logMin = Math.log10(minError * 0.8);
    const logMax = Math.log10(maxError * 1.2);

    // Y scale function (log scale)
    const yScale = (val) => {
        const logVal = Math.log10(Math.max(0.01, val));
        return padding.top + plotHeight - ((logVal - logMin) / (logMax - logMin)) * plotHeight;
    };

    // X scale function (categorical)
    const xBandWidth = plotWidth / cameras.length;
    const xScale = (cameraIndex) => padding.left + xBandWidth * (cameraIndex + 0.5);

    // Draw grid lines and Y axis labels
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#888';
    ctx.font = '11px monospace';
    ctx.textAlign = 'right';

    // Generate nice log scale tick values
    const tickValues = [];
    for (let exp = Math.floor(logMin); exp <= Math.ceil(logMax); exp++) {
        tickValues.push(Math.pow(10, exp));
        if (exp < Math.ceil(logMax)) {
            tickValues.push(2 * Math.pow(10, exp));
            tickValues.push(5 * Math.pow(10, exp));
        }
    }

    tickValues.filter(v => v >= minError * 0.8 && v <= maxError * 1.2).forEach(val => {
        const y = yScale(val);
        if (y >= padding.top && y <= padding.top + plotHeight) {
            ctx.beginPath();
            ctx.moveTo(padding.left, y);
            ctx.lineTo(width - padding.right, y);
            ctx.stroke();
            ctx.fillText(val.toFixed(val < 1 ? 2 : 1), padding.left - 8, y + 4);
        }
    });

    // Y axis label
    ctx.save();
    ctx.translate(15, height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#aaa';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText('RMS Error (pixels)', 0, 0);
    ctx.restore();

    // Clear swarm dots array
    state.swarmDots = [];

    // Camera colors (consistent with theme)
    const colors = ['#667eea', '#4ade80', '#fbbf24', '#ef4444', '#a78bfa', '#22d3ee'];

    // Draw dots for each camera (all frames including excluded)
    cameras.forEach((cam, camIdx) => {
        // Use allPerImageErrors to show all frames, fall back to perImageErrors for compatibility
        const errors = state.intrinsics[cam].allPerImageErrors || state.intrinsics[cam].perImageErrors || [];
        const exclusions = state.exclusions.intrinsics[cam] || new Set();
        const x = xScale(camIdx);
        const color = colors[camIdx % colors.length];

        // Jitter dots horizontally to create swarm effect
        // Use seeded random based on index for consistency
        const jitterWidth = xBandWidth * 0.6;

        errors.forEach((error, calibIdx) => {
            if (isNaN(error)) return; // Skip failed frames

            const isExcluded = exclusions.has(calibIdx);
            const y = yScale(error);
            // Deterministic jitter based on error value and index
            const jitter = ((calibIdx * 7919 + Math.floor(error * 1000)) % 100 - 50) / 50 * jitterWidth / 2;
            const dotX = x + jitter;
            const dotY = y;
            const radius = isExcluded ? 4 : 5;

            // Store dot info for hover detection
            state.swarmDots.push({
                x: dotX,
                y: dotY,
                radius: radius,
                camera: cam,
                imageIndex: calibIdx,
                error: error,
                color: color,
                isExcluded: isExcluded
            });

            // Draw dot (excluded frames with reduced opacity and dashed stroke)
            ctx.beginPath();
            ctx.arc(dotX, dotY, radius, 0, 2 * Math.PI);
            ctx.fillStyle = isExcluded ? color + '40' : color; // 25% opacity for excluded
            ctx.fill();
            ctx.strokeStyle = isExcluded ? '#888' : '#fff';
            ctx.lineWidth = isExcluded ? 1 : 1.5;
            ctx.stroke();
        });

        // Draw camera label on X axis
        ctx.fillStyle = color;
        ctx.font = 'bold 12px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(cam, x, height - padding.bottom + 20);
    });

    // Draw axis lines
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, padding.top + plotHeight);
    ctx.lineTo(width - padding.right, padding.top + plotHeight);
    ctx.stroke();
}

/**
 * Setup hover handling for intrinsics swarm plot
 * @param {Object} state - Application state
 * @param {Object} videoController - VideoController instance
 */
function setupSwarmPlotHover(state, videoController) {
    const canvas = document.getElementById('swarmPlotCanvas');
    const tooltip = document.getElementById('swarmTooltip');
    let hoveredDot = null;

    canvas.addEventListener('mousemove', async (e) => {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const mx = (e.clientX - rect.left) * scaleX;
        const my = (e.clientY - rect.top) * scaleY;

        // Find closest dot
        let closest = null;
        let closestDist = Infinity;
        for (const dot of state.swarmDots) {
            const dist = Math.sqrt((mx - dot.x) ** 2 + (my - dot.y) ** 2);
            if (dist < dot.radius + 5 && dist < closestDist) {
                closest = dot;
                closestDist = dist;
            }
        }

        if (closest) {
            // Show tooltip
            tooltip.style.display = 'block';
            tooltip.style.left = `${e.clientX - canvas.parentElement.getBoundingClientRect().left + 10}px`;
            tooltip.style.top = `${e.clientY - canvas.parentElement.getBoundingClientRect().top - 30}px`;
            tooltip.innerHTML = `<strong>${closest.camera}</strong><br>Image ${closest.imageIndex + 1}<br>RMS: ${closest.error.toFixed(4)} px`;
            canvas.style.cursor = 'pointer';

            // If different dot than before, update reprojection view
            if (!hoveredDot || hoveredDot.camera !== closest.camera || hoveredDot.imageIndex !== closest.imageIndex) {
                hoveredDot = closest;

                // Show reprojection for this specific image
                state.showReprojection = true;
                state.reprojectionFrameIndex = closest.imageIndex;
                document.getElementById('intrinsicsOverlayCheck').checked = true;

                // Get the actual video frame for this calibration frame
                const firstIntrinsics = Object.values(state.intrinsics)[0];
                const videoFrame = firstIntrinsics?.frameIndices ? firstIntrinsics.frameIndices[closest.imageIndex] : closest.imageIndex;

                // Seek to correct video frame (overlay drawn automatically)
                await videoController.seekToFrame(videoFrame);
            }
        } else {
            tooltip.style.display = 'none';
            canvas.style.cursor = 'default';
            hoveredDot = null;
        }
    });

    canvas.addEventListener('mouseleave', () => {
        tooltip.style.display = 'none';
        canvas.style.cursor = 'default';
    });

    // Click to lock the reprojection view
    canvas.addEventListener('click', (e) => {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const mx = (e.clientX - rect.left) * scaleX;
        const my = (e.clientY - rect.top) * scaleY;

        // Find clicked dot
        for (const dot of state.swarmDots) {
            const dist = Math.sqrt((mx - dot.x) ** 2 + (my - dot.y) ** 2);
            if (dist < dot.radius + 5) {
                console.log(`Locked reprojection view: ${dot.camera} image ${dot.imageIndex + 1} (RMS: ${dot.error.toFixed(4)})`);
                break;
            }
        }
    });
}

/**
 * Draw extrinsics swarm plot
 * @param {Object} state - Application state
 */
function drawExtrinsicsSwarmPlot(state) {
    const canvas = document.getElementById('extrinsicsSwarmCanvas');
    const ctx = canvas.getContext('2d');

    if (!state.extrinsicsReprojData || state.extrinsicsReprojData.length === 0) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#888';
        ctx.font = '14px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No cross-view reprojection data available', canvas.width / 2, canvas.height / 2);
        return;
    }

    const cameras = state.views.map(v => v.name);

    // Collect all per-camera errors
    const cameraErrors = {};
    cameras.forEach(cam => { cameraErrors[cam] = []; });

    state.extrinsicsReprojData.forEach((frameData, frameIdx) => {
        frameData.pointErrors.forEach((pt, ptIdx) => {
            for (const [cam, errData] of Object.entries(pt.perCameraErrors)) {
                cameraErrors[cam].push({
                    error: errData.error,
                    frameIndex: frameIdx,
                    pointIndex: ptIdx,
                    pointId: pt.pointId,
                    frame: frameData.frame
                });
            }
        });
    });

    // Collect all errors for scale
    let allErrors = [];
    cameras.forEach(cam => {
        allErrors = allErrors.concat(cameraErrors[cam].map(e => e.error));
    });

    if (allErrors.length === 0) return;

    // Clear canvas
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    // Layout
    const padding = { left: 60, right: 30, top: 30, bottom: 50 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;

    // Log scale
    const minError = Math.max(0.01, Math.min(...allErrors));
    const maxError = Math.max(...allErrors);
    const logMin = Math.log10(minError * 0.8);
    const logMax = Math.log10(maxError * 1.2);

    const yScale = (val) => {
        const logVal = Math.log10(Math.max(0.01, val));
        return padding.top + plotHeight - ((logVal - logMin) / (logMax - logMin)) * plotHeight;
    };

    const xBandWidth = plotWidth / cameras.length;
    const xScale = (camIdx) => padding.left + xBandWidth * (camIdx + 0.5);

    // Grid lines
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#888';
    ctx.font = '11px monospace';
    ctx.textAlign = 'right';

    const tickValues = [];
    for (let exp = Math.floor(logMin); exp <= Math.ceil(logMax); exp++) {
        tickValues.push(Math.pow(10, exp));
        if (exp < Math.ceil(logMax)) {
            tickValues.push(2 * Math.pow(10, exp));
            tickValues.push(5 * Math.pow(10, exp));
        }
    }

    tickValues.filter(v => v >= minError * 0.8 && v <= maxError * 1.2).forEach(val => {
        const y = yScale(val);
        if (y >= padding.top && y <= padding.top + plotHeight) {
            ctx.beginPath();
            ctx.moveTo(padding.left, y);
            ctx.lineTo(width - padding.right, y);
            ctx.stroke();
            ctx.fillText(val.toFixed(val < 1 ? 2 : 1), padding.left - 8, y + 4);
        }
    });

    // Y axis label
    ctx.save();
    ctx.translate(15, height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#aaa';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText('Reproj Error (pixels)', 0, 0);
    ctx.restore();

    // Clear dots array
    state.extrinsicsSwarmDots = [];

    const colors = ['#667eea', '#4ade80', '#fbbf24', '#ef4444', '#a78bfa', '#22d3ee'];

    // Draw dots
    cameras.forEach((cam, camIdx) => {
        const errors = cameraErrors[cam];
        const x = xScale(camIdx);
        const color = colors[camIdx % colors.length];
        const jitterWidth = xBandWidth * 0.6;

        errors.forEach((errData, idx) => {
            const y = yScale(errData.error);
            const jitter = ((idx * 7919 + Math.floor(errData.error * 1000)) % 100 - 50) / 50 * jitterWidth / 2;
            const dotX = x + jitter;
            const dotY = y;
            const radius = 4;

            // Check if this frame is excluded
            const isExcluded = isExtrinsicsFrameExcluded(errData.frame);

            state.extrinsicsSwarmDots.push({
                x: dotX,
                y: dotY,
                radius: radius,
                camera: cam,
                frameIndex: errData.frameIndex,
                pointIndex: errData.pointIndex,
                pointId: errData.pointId,
                frame: errData.frame,
                error: errData.error,
                color: color,
                excluded: isExcluded
            });

            // Draw dot with reduced opacity if excluded
            ctx.globalAlpha = isExcluded ? 0.3 : 1.0;
            ctx.beginPath();
            ctx.arc(dotX, dotY, radius, 0, 2 * Math.PI);
            ctx.fillStyle = color;
            ctx.fill();
            ctx.strokeStyle = isExcluded ? '#666' : '#fff';
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.globalAlpha = 1.0;
        });

        // Camera label
        ctx.fillStyle = color;
        ctx.font = 'bold 12px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(cam, x, height - padding.bottom + 20);
    });

    // Axes
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, padding.top + plotHeight);
    ctx.lineTo(width - padding.right, padding.top + plotHeight);
    ctx.stroke();

    // Stats summary
    const meanError = allErrors.reduce((a, b) => a + b, 0) / allErrors.length;
    const medianError = [...allErrors].sort((a, b) => a - b)[Math.floor(allErrors.length / 2)];
    ctx.fillStyle = '#aaa';
    ctx.font = '11px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`Mean: ${meanError.toFixed(3)} px | Median: ${medianError.toFixed(3)} px | N: ${allErrors.length}`, width - padding.right, padding.top - 10);
}

/**
 * Draw extrinsics reprojection overlay on videos
 * @param {Object} state - Application state
 * @param {string} phase - 'circles', 'markers', or 'all'
 */
function drawExtrinsicsReprojectionOverlay(state, phase = 'all') {
    if (!state.showExtrinsicsReproj || !state.extrinsicsReprojData || state.extrinsicsReprojData.length === 0) return;

    // Try to find extrinsics data for the current video frame
    let frameIdx = state.extrinsicsReprojData.findIndex(d => d.frame === state.currentFrame);
    if (frameIdx === -1) {
        // Fall back to the stored reprojection frame index
        frameIdx = state.extrinsicsReprojFrameIndex % state.extrinsicsReprojData.length;
    } else {
        // Update the stored index to match
        state.extrinsicsReprojFrameIndex = frameIdx;
    }
    const frameData = state.extrinsicsReprojData[frameIdx];

    for (let i = 0; i < state.views.length; i++) {
        const view = state.views[i];
        const viewName = view.name;
        const ctx = view.ctx;

        // Draw all points for this frame
        for (const pt of frameData.pointErrors) {
            const errData = pt.perCameraErrors[viewName];
            if (!errData) continue;

            // Phase 1: Pastel green circle for detected
            if (phase === 'circles' || phase === 'all') {
                ctx.beginPath();
                ctx.arc(errData.detected.x, errData.detected.y, 6, 0, 2 * Math.PI);
                ctx.fillStyle = '#86efac';  // Pastel green
                ctx.fill();
                ctx.strokeStyle = '#166534';  // Dark green border
                ctx.lineWidth = 1.5;
                ctx.stroke();
            }

            // Phase 2: Pastel blue thin cross (+) for triangulated
            if (phase === 'markers' || phase === 'all') {
                const px = errData.projected.x;
                const py = errData.projected.y;
                const crossSize = 6;

                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 3;
                ctx.lineCap = 'round';
                ctx.beginPath();
                ctx.moveTo(px - crossSize, py);
                ctx.lineTo(px + crossSize, py);
                ctx.moveTo(px, py - crossSize);
                ctx.lineTo(px, py + crossSize);
                ctx.stroke();

                ctx.strokeStyle = '#60a5fa';  // Pastel blue
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(px - crossSize, py);
                ctx.lineTo(px + crossSize, py);
                ctx.moveTo(px, py - crossSize);
                ctx.lineTo(px, py + crossSize);
                ctx.stroke();
            }
        }

        // Frame info (only draw once in markers phase or 'all')
        if (phase === 'markers' || phase === 'all') {
            ctx.font = '12px system-ui, sans-serif';
            const frameInfoX = state.showReprojection ? 156 : 8;
            ctx.fillStyle = 'rgba(0,0,0,0.7)';
            ctx.fillRect(frameInfoX, view.canvas.height - 30, 150, 22);
            ctx.fillStyle = '#aaa';
            ctx.fillText(`Extr ${frameIdx + 1}/${state.extrinsicsReprojData.length}`, frameInfoX + 4, view.canvas.height - 14);
        }
    }
}

/**
 * Setup hover handling for extrinsics swarm plot
 * @param {Object} state - Application state
 * @param {Object} videoController - VideoController instance
 */
function setupExtrinsicsSwarmHover(state, videoController) {
    const canvas = document.getElementById('extrinsicsSwarmCanvas');
    const tooltip = document.getElementById('extrinsicsSwarmTooltip');
    let hoveredDot = null;

    canvas.addEventListener('mousemove', async (e) => {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const mx = (e.clientX - rect.left) * scaleX;
        const my = (e.clientY - rect.top) * scaleY;

        let closest = null;
        let closestDist = Infinity;
        for (const dot of state.extrinsicsSwarmDots) {
            const dist = Math.sqrt((mx - dot.x) ** 2 + (my - dot.y) ** 2);
            if (dist < dot.radius + 5 && dist < closestDist) {
                closest = dot;
                closestDist = dist;
            }
        }

        if (closest) {
            tooltip.style.display = 'block';
            tooltip.style.left = `${e.clientX - canvas.parentElement.getBoundingClientRect().left + 10}px`;
            tooltip.style.top = `${e.clientY - canvas.parentElement.getBoundingClientRect().top - 30}px`;
            tooltip.innerHTML = `<strong>${closest.camera}</strong><br>Frame ${closest.frame + 1}, Point ${closest.pointId}<br>Error: ${closest.error.toFixed(4)} px`;
            canvas.style.cursor = 'pointer';

            if (!hoveredDot || hoveredDot.frameIndex !== closest.frameIndex || hoveredDot.pointIndex !== closest.pointIndex) {
                hoveredDot = closest;

                state.showExtrinsicsReproj = true;
                state.extrinsicsReprojFrameIndex = closest.frameIndex;
                document.getElementById('extrinsicsOverlayCheck').checked = true;

                // Seek to the video frame corresponding to this point
                await videoController.seekToFrame(closest.frame);
            }
        } else {
            tooltip.style.display = 'none';
            canvas.style.cursor = 'default';
            hoveredDot = null;
        }
    });

    canvas.addEventListener('mouseleave', () => {
        tooltip.style.display = 'none';
        canvas.style.cursor = 'default';
    });
}
