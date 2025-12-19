/**
 * Frame Exclusion Gallery module for multi-camera calibration
 * Manages UI galleries for excluding frames from intrinsic/extrinsic calibration
 *
 * Dependencies (global):
 *   - state: global state object with exclusions, intrinsics, extrinsics, views
 *   - log(msg, level): logging function
 *   - seekToFrame(frameIndex): video navigation function
 *   - drawSwarmPlot(): intrinsics swarm plot visualization
 *   - drawExtrinsicsSwarmPlot(): extrinsics swarm plot visualization
 */

// ============================================
// Exclusion State Management
// ============================================

/**
 * Initialize exclusions for a camera
 */
function initCameraExclusions(cameraName) {
    if (!state.exclusions.intrinsics[cameraName]) {
        state.exclusions.intrinsics[cameraName] = new Set();
    }
}

/**
 * Toggle intrinsics frame exclusion for a camera
 */
function toggleIntrinsicsExclusion(cameraName, calibFrameIndex) {
    initCameraExclusions(cameraName);
    const exclusions = state.exclusions.intrinsics[cameraName];

    if (exclusions.has(calibFrameIndex)) {
        exclusions.delete(calibFrameIndex);
        log(`Included intrinsics frame ${calibFrameIndex + 1} for ${cameraName}`, 'info');
    } else {
        exclusions.add(calibFrameIndex);
        log(`Excluded intrinsics frame ${calibFrameIndex + 1} for ${cameraName}`, 'warn');
    }

    updateIntrinsicsExclusionUI();
}

/**
 * Toggle extrinsics frame exclusion
 */
function toggleExtrinsicsExclusion(videoFrame) {
    if (state.exclusions.extrinsics.has(videoFrame)) {
        state.exclusions.extrinsics.delete(videoFrame);
        log(`Included extrinsics frame ${videoFrame}`, 'info');
    } else {
        state.exclusions.extrinsics.add(videoFrame);
        log(`Excluded extrinsics frame ${videoFrame}`, 'warn');
    }

    updateExtrinsicsExclusionUI();
}

/**
 * Check if a calibration frame is excluded for intrinsics
 */
function isIntrinsicsFrameExcluded(cameraName, calibFrameIndex) {
    return state.exclusions.intrinsics[cameraName]?.has(calibFrameIndex) || false;
}

/**
 * Check if a video frame is excluded for extrinsics
 */
function isExtrinsicsFrameExcluded(videoFrame) {
    return state.exclusions.extrinsics.has(videoFrame);
}

/**
 * Check if a video frame is excluded from intrinsics (by mapping to calibration index)
 */
function isVideoFrameExcludedFromIntrinsics(videoFrame) {
    const firstCam = Object.keys(state.intrinsics)[0];
    if (!firstCam) return false;

    const intrinsics = state.intrinsics[firstCam];
    const allValidFrames = intrinsics.allValidFrames;
    if (!allValidFrames) return false;

    // Find the calibration index for this video frame
    const calibIdx = allValidFrames.findIndex(f => f.frame === videoFrame);
    if (calibIdx < 0) return false;

    // Check if excluded in any camera
    for (const camName of Object.keys(state.intrinsics)) {
        if (isIntrinsicsFrameExcluded(camName, calibIdx)) {
            return true;
        }
    }
    return false;
}

/**
 * Get total count of intrinsics exclusions across all cameras
 */
function getIntrinsicsExclusionCount() {
    let total = 0;
    for (const cam in state.exclusions.intrinsics) {
        total += state.exclusions.intrinsics[cam].size;
    }
    return total;
}

// ============================================
// Thumbnail Capture
// ============================================

/**
 * Capture thumbnail for a frame (using first camera)
 */
async function captureThumbnail(videoFrame) {
    if (state.frameThumbnails[videoFrame]) {
        return state.frameThumbnails[videoFrame];
    }

    if (state.views.length === 0) return null;

    const view = state.views[0];
    const result = await view.decoder.getFrame(videoFrame);
    if (result && result.bitmap) {
        // Create small canvas for thumbnail
        const thumbCanvas = document.createElement('canvas');
        thumbCanvas.width = 160;
        thumbCanvas.height = 120;
        const thumbCtx = thumbCanvas.getContext('2d');
        thumbCtx.drawImage(result.bitmap, 0, 0, thumbCanvas.width, thumbCanvas.height);
        const dataURL = thumbCanvas.toDataURL('image/jpeg', 0.7);
        state.frameThumbnails[videoFrame] = dataURL;
        return dataURL;
    }
    return null;
}

// ============================================
// Intrinsics Exclusion Gallery
// ============================================

/**
 * Build and populate intrinsics exclusion gallery
 */
async function buildIntrinsicsExclusionGallery() {
    const gallery = document.getElementById('intrinsicsExclusionGallery');
    const grid = document.getElementById('intrinsicsExclusionGrid');

    if (Object.keys(state.intrinsics).length === 0) {
        gallery.style.display = 'none';
        return;
    }

    gallery.style.display = 'block';
    grid.innerHTML = '';

    // Get first camera's calibration data
    const firstCam = Object.keys(state.intrinsics)[0];
    const intrinsics = state.intrinsics[firstCam];

    // Use allValidFrames if available (shows all frames including excluded)
    // Otherwise fall back to frameIndices (first computation before any exclusions)
    const validFrames = intrinsics.allValidFrames || null;
    if (!validFrames && !intrinsics.frameIndices) return;

    // Initialize exclusions for all cameras
    for (const camName of Object.keys(state.intrinsics)) {
        initCameraExclusions(camName);
    }

    // Determine number of frames to show
    const numFrames = validFrames ? validFrames.length : intrinsics.frameIndices.length;

    // Build thumbnails for each calibration frame
    for (let calibIdx = 0; calibIdx < numFrames; calibIdx++) {
        const videoFrame = validFrames ? validFrames[calibIdx].frame : intrinsics.frameIndices[calibIdx];
        const thumbnail = await captureThumbnail(videoFrame);

        // Get error for this frame - use allPerImageErrors (includes excluded frames)
        let error = null;
        if (intrinsics.allPerImageErrors && intrinsics.allPerImageErrors[calibIdx] !== undefined) {
            error = intrinsics.allPerImageErrors[calibIdx];
            if (isNaN(error)) error = null;
        } else if (intrinsics.perImageErrors && intrinsics.perImageErrors[calibIdx] !== undefined) {
            // Fall back to old perImageErrors for compatibility
            error = intrinsics.perImageErrors[calibIdx];
        }

        // Check if excluded in any camera
        let isExcluded = false;
        for (const camName of Object.keys(state.intrinsics)) {
            if (isIntrinsicsFrameExcluded(camName, calibIdx)) {
                isExcluded = true;
                break;
            }
        }

        const isCurrent = (state.reprojectionFrameIndex === calibIdx);
        const isExcludedFromExtrinsics = isExtrinsicsFrameExcluded(videoFrame);

        // Show warning if exclusion status differs between intrinsics and extrinsics
        let crossWarning = '';
        if (isExcluded && !isExcludedFromExtrinsics) {
            crossWarning = '<div class="frame-thumbnail-cross-warning" title="Excluded here but included in extrinsics">⚠ in extr</div>';
        } else if (!isExcluded && isExcludedFromExtrinsics) {
            crossWarning = '<div class="frame-thumbnail-cross-warning" title="Included here but excluded from extrinsics">⚠ excl extr</div>';
        }

        const item = document.createElement('div');
        item.className = 'frame-thumbnail' + (isExcluded ? ' excluded' : '') + (isCurrent ? ' current' : '');
        item.dataset.calibIndex = calibIdx;
        item.dataset.videoFrame = videoFrame;

        item.innerHTML = `
            ${thumbnail ? `<img src="${thumbnail}" alt="Frame ${videoFrame}">` : ''}
            <div class="frame-thumbnail-label">F${videoFrame}${error ? ` • ${error.toFixed(2)}px` : ''}</div>
            ${isExcluded ? '<div class="frame-thumbnail-excluded-badge">✕</div>' : ''}
            ${crossWarning}
            <button class="frame-thumbnail-btn" title="${isExcluded ? 'Include frame' : 'Exclude frame'}">${isExcluded ? '✓' : '✕'}</button>
        `;

        // Click to navigate to frame
        item.addEventListener('click', async (e) => {
            if (e.target.classList.contains('frame-thumbnail-btn')) return;
            state.reprojectionFrameIndex = calibIdx;
            await seekToFrame(videoFrame);
        });

        // Button to toggle exclusion
        const btn = item.querySelector('.frame-thumbnail-btn');
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            // Check current exclusion state (not captured closure value)
            let currentlyExcluded = false;
            for (const camName of Object.keys(state.intrinsics)) {
                if (isIntrinsicsFrameExcluded(camName, calibIdx)) {
                    currentlyExcluded = true;
                    break;
                }
            }
            // Toggle exclusion for ALL cameras at once
            for (const camName of Object.keys(state.intrinsics)) {
                if (currentlyExcluded) {
                    state.exclusions.intrinsics[camName].delete(calibIdx);
                } else {
                    state.exclusions.intrinsics[camName].add(calibIdx);
                }
            }
            log(`${currentlyExcluded ? 'Included' : 'Excluded'} calibration frame ${calibIdx + 1} (video frame ${videoFrame})`, currentlyExcluded ? 'info' : 'warn');
            updateIntrinsicsExclusionUI();
        });

        grid.appendChild(item);
    }

    updateIntrinsicsExclusionStats();
}

/**
 * Update gallery highlight for current frame
 */
function updateIntrinsicsGalleryCurrentHighlight() {
    const grid = document.getElementById('intrinsicsExclusionGrid');
    if (!grid) return;

    grid.querySelectorAll('.frame-thumbnail').forEach(item => {
        const calibIdx = parseInt(item.dataset.calibIndex);
        if (calibIdx === state.reprojectionFrameIndex) {
            item.classList.add('current');
        } else {
            item.classList.remove('current');
        }
    });
}

/**
 * Update exclusion UI for intrinsics gallery
 */
function updateIntrinsicsExclusionUI() {
    const grid = document.getElementById('intrinsicsExclusionGrid');
    if (!grid) return;

    const firstCam = Object.keys(state.intrinsics)[0];
    if (!firstCam) return;

    grid.querySelectorAll('.frame-thumbnail').forEach(item => {
        const calibIdx = parseInt(item.dataset.calibIndex);
        const videoFrame = parseInt(item.dataset.videoFrame);

        // Check if excluded in any camera
        let isExcluded = false;
        for (const camName of Object.keys(state.intrinsics)) {
            if (isIntrinsicsFrameExcluded(camName, calibIdx)) {
                isExcluded = true;
                break;
            }
        }

        const isExcludedFromExtrinsics = isExtrinsicsFrameExcluded(videoFrame);

        if (isExcluded) {
            item.classList.add('excluded');
            const badge = item.querySelector('.frame-thumbnail-excluded-badge');
            if (!badge) {
                const newBadge = document.createElement('div');
                newBadge.className = 'frame-thumbnail-excluded-badge';
                newBadge.textContent = '✕';
                item.appendChild(newBadge);
            }
            const btn = item.querySelector('.frame-thumbnail-btn');
            if (btn) {
                btn.textContent = '✓';
                btn.title = 'Include frame';
            }
        } else {
            item.classList.remove('excluded');
            const badge = item.querySelector('.frame-thumbnail-excluded-badge');
            if (badge) badge.remove();
            const btn = item.querySelector('.frame-thumbnail-btn');
            if (btn) {
                btn.textContent = '✕';
                btn.title = 'Exclude frame';
            }
        }

        // Update cross-exclusion warning
        let crossWarning = item.querySelector('.frame-thumbnail-cross-warning');
        if (isExcluded && !isExcludedFromExtrinsics) {
            if (!crossWarning) {
                crossWarning = document.createElement('div');
                crossWarning.className = 'frame-thumbnail-cross-warning';
                item.appendChild(crossWarning);
            }
            crossWarning.textContent = '⚠ in extr';
            crossWarning.title = 'Excluded here but included in extrinsics';
        } else if (!isExcluded && isExcludedFromExtrinsics) {
            if (!crossWarning) {
                crossWarning = document.createElement('div');
                crossWarning.className = 'frame-thumbnail-cross-warning';
                item.appendChild(crossWarning);
            }
            crossWarning.textContent = '⚠ excl extr';
            crossWarning.title = 'Included here but excluded from extrinsics';
        } else if (crossWarning) {
            crossWarning.remove();
        }
    });

    updateIntrinsicsExclusionStats();

    // Redraw swarm plot to show excluded dots differently
    if (typeof drawSwarmPlot === 'function') {
        drawSwarmPlot();
    }

    // Update extrinsics gallery cross-warnings (without calling full updateExtrinsicsExclusionUI to avoid loop)
    const extrGrid = document.getElementById('extrinsicsExclusionGrid');
    if (extrGrid) {
        extrGrid.querySelectorAll('.frame-thumbnail').forEach(item => {
            const videoFrame = parseInt(item.dataset.videoFrame);
            const isExcluded = isExtrinsicsFrameExcluded(videoFrame);
            const isExcludedFromIntrinsics = isVideoFrameExcludedFromIntrinsics(videoFrame);

            let crossWarning = item.querySelector('.frame-thumbnail-cross-warning');
            if (isExcluded && !isExcludedFromIntrinsics) {
                if (!crossWarning) {
                    crossWarning = document.createElement('div');
                    crossWarning.className = 'frame-thumbnail-cross-warning';
                    item.appendChild(crossWarning);
                }
                crossWarning.textContent = '⚠ in intr';
                crossWarning.title = 'Excluded here but included in intrinsics';
            } else if (!isExcluded && isExcludedFromIntrinsics) {
                if (!crossWarning) {
                    crossWarning = document.createElement('div');
                    crossWarning.className = 'frame-thumbnail-cross-warning';
                    item.appendChild(crossWarning);
                }
                crossWarning.textContent = '⚠ excl intr';
                crossWarning.title = 'Included here but excluded from intrinsics';
            } else if (crossWarning) {
                crossWarning.remove();
            }
        });
    }
}

/**
 * Update exclusion stats display for intrinsics
 */
function updateIntrinsicsExclusionStats() {
    const statsEl = document.getElementById('intrinsicsExclusionStats');
    if (!statsEl) return;

    const firstCam = Object.keys(state.intrinsics)[0];
    const intr = firstCam ? state.intrinsics[firstCam] : null;

    // Use allValidFrames for total count if available
    const totalFrames = intr?.allValidFrames?.length || intr?.frameIndices?.length || 0;
    const allValidFrames = intr?.allValidFrames;

    // Count unique excluded frames (since we exclude across all cameras)
    const excludedFrames = new Set();
    for (const camName in state.exclusions.intrinsics) {
        for (const idx of state.exclusions.intrinsics[camName]) {
            excludedFrames.add(idx);
        }
    }

    // Count mismatched exclusions (excluded here but not in extrinsics, or vice versa)
    let mismatchCount = 0;
    if (allValidFrames) {
        for (let calibIdx = 0; calibIdx < allValidFrames.length; calibIdx++) {
            const videoFrame = allValidFrames[calibIdx].frame;
            const excludedHere = excludedFrames.has(calibIdx);
            const excludedInExtrinsics = isExtrinsicsFrameExcluded(videoFrame);
            if (excludedHere !== excludedInExtrinsics) {
                mismatchCount++;
            }
        }
    }

    let statsText = `${excludedFrames.size} / ${totalFrames} excluded`;
    if (mismatchCount > 0) {
        statsText += ` (⚠ ${mismatchCount} differ from extrinsics)`;
    }
    statsEl.textContent = statsText;

    if (mismatchCount > 0) {
        statsEl.style.color = '#f97316'; // Orange for mismatch warning
    } else if (excludedFrames.size > 0) {
        statsEl.style.color = '#fbbf24';
    } else {
        statsEl.style.color = '#888';
    }
}

// ============================================
// Extrinsics Exclusion Gallery
// ============================================

/**
 * Build extrinsics exclusion gallery
 */
async function buildExtrinsicsExclusionGallery() {
    const gallery = document.getElementById('extrinsicsExclusionGallery');
    const grid = document.getElementById('extrinsicsExclusionGrid');

    if (!state.extrinsicsReprojData || state.extrinsicsReprojData.length === 0) {
        gallery.style.display = 'none';
        return;
    }

    gallery.style.display = 'block';
    grid.innerHTML = '';

    // Build thumbnails for each frame with triangulation data
    for (let idx = 0; idx < state.extrinsicsReprojData.length; idx++) {
        const frameData = state.extrinsicsReprojData[idx];
        const videoFrame = frameData.frame;
        const thumbnail = await captureThumbnail(videoFrame);

        // Calculate mean error for this frame
        const errors = frameData.pointErrors.map(p => p.meanError);
        const meanError = errors.reduce((a, b) => a + b, 0) / errors.length;

        const isExcluded = isExtrinsicsFrameExcluded(videoFrame);
        const isExcludedFromIntrinsics = isVideoFrameExcludedFromIntrinsics(videoFrame);
        const isCurrent = (state.extrinsicsReprojFrameIndex === idx);

        // Show warning if exclusion status differs between intrinsics and extrinsics
        let crossWarning = '';
        if (isExcluded && !isExcludedFromIntrinsics) {
            crossWarning = '<div class="frame-thumbnail-cross-warning" title="Excluded here but included in intrinsics">⚠ in intr</div>';
        } else if (!isExcluded && isExcludedFromIntrinsics) {
            crossWarning = '<div class="frame-thumbnail-cross-warning" title="Included here but excluded from intrinsics">⚠ excl intr</div>';
        }

        const item = document.createElement('div');
        item.className = 'frame-thumbnail' + (isExcluded ? ' excluded' : '') + (isCurrent ? ' current' : '');
        item.dataset.frameIndex = idx;
        item.dataset.videoFrame = videoFrame;

        item.innerHTML = `
            ${thumbnail ? `<img src="${thumbnail}" alt="Frame ${videoFrame}">` : ''}
            <div class="frame-thumbnail-label">F${videoFrame} • ${meanError.toFixed(2)}px</div>
            ${isExcluded ? '<div class="frame-thumbnail-excluded-badge">✕</div>' : ''}
            ${crossWarning}
            <button class="frame-thumbnail-btn" title="${isExcluded ? 'Include frame' : 'Exclude frame'}">${isExcluded ? '✓' : '✕'}</button>
        `;

        // Click to navigate
        item.addEventListener('click', async (e) => {
            if (e.target.classList.contains('frame-thumbnail-btn')) return;
            state.extrinsicsReprojFrameIndex = idx;
            await seekToFrame(videoFrame);
        });

        // Button to toggle exclusion
        const btn = item.querySelector('.frame-thumbnail-btn');
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleExtrinsicsExclusion(videoFrame);
        });

        grid.appendChild(item);
    }

    updateExtrinsicsExclusionStats();
}

/**
 * Update gallery highlight for extrinsics current frame
 */
function updateExtrinsicsGalleryCurrentHighlight() {
    const grid = document.getElementById('extrinsicsExclusionGrid');
    if (!grid) return;

    grid.querySelectorAll('.frame-thumbnail').forEach(item => {
        const idx = parseInt(item.dataset.frameIndex);
        if (idx === state.extrinsicsReprojFrameIndex) {
            item.classList.add('current');
        } else {
            item.classList.remove('current');
        }
    });
}

/**
 * Update exclusion UI for extrinsics gallery
 */
function updateExtrinsicsExclusionUI() {
    const grid = document.getElementById('extrinsicsExclusionGrid');
    if (!grid) return;

    grid.querySelectorAll('.frame-thumbnail').forEach(item => {
        const videoFrame = parseInt(item.dataset.videoFrame);
        const isExcluded = isExtrinsicsFrameExcluded(videoFrame);
        const isExcludedFromIntrinsics = isVideoFrameExcludedFromIntrinsics(videoFrame);

        if (isExcluded) {
            item.classList.add('excluded');
            let badge = item.querySelector('.frame-thumbnail-excluded-badge');
            if (!badge) {
                badge = document.createElement('div');
                badge.className = 'frame-thumbnail-excluded-badge';
                badge.textContent = '✕';
                item.appendChild(badge);
            }
            const btn = item.querySelector('.frame-thumbnail-btn');
            if (btn) {
                btn.textContent = '✓';
                btn.title = 'Include frame';
            }
        } else {
            item.classList.remove('excluded');
            const badge = item.querySelector('.frame-thumbnail-excluded-badge');
            if (badge) badge.remove();
            const btn = item.querySelector('.frame-thumbnail-btn');
            if (btn) {
                btn.textContent = '✕';
                btn.title = 'Exclude frame';
            }
        }

        // Update cross-exclusion warning
        let crossWarning = item.querySelector('.frame-thumbnail-cross-warning');
        if (isExcluded && !isExcludedFromIntrinsics) {
            if (!crossWarning) {
                crossWarning = document.createElement('div');
                crossWarning.className = 'frame-thumbnail-cross-warning';
                item.appendChild(crossWarning);
            }
            crossWarning.textContent = '⚠ in intr';
            crossWarning.title = 'Excluded here but included in intrinsics';
        } else if (!isExcluded && isExcludedFromIntrinsics) {
            if (!crossWarning) {
                crossWarning = document.createElement('div');
                crossWarning.className = 'frame-thumbnail-cross-warning';
                item.appendChild(crossWarning);
            }
            crossWarning.textContent = '⚠ excl intr';
            crossWarning.title = 'Included here but excluded from intrinsics';
        } else if (crossWarning) {
            crossWarning.remove();
        }
    });

    updateExtrinsicsExclusionStats();

    // Also update intrinsics gallery to reflect cross-exclusion state
    updateIntrinsicsExclusionUI();

    // Redraw extrinsics swarm plot
    if (typeof drawExtrinsicsSwarmPlot === 'function') {
        drawExtrinsicsSwarmPlot();
    }
}

/**
 * Update extrinsics exclusion stats
 */
function updateExtrinsicsExclusionStats() {
    const statsEl = document.getElementById('extrinsicsExclusionStats');
    if (!statsEl) return;

    const excluded = state.exclusions.extrinsics.size;
    const total = state.extrinsicsReprojData ? state.extrinsicsReprojData.length : 0;

    // Count mismatched exclusions
    let mismatchCount = 0;
    if (state.extrinsicsReprojData) {
        for (const frameData of state.extrinsicsReprojData) {
            const videoFrame = frameData.frame;
            const excludedHere = isExtrinsicsFrameExcluded(videoFrame);
            const excludedInIntrinsics = isVideoFrameExcludedFromIntrinsics(videoFrame);
            if (excludedHere !== excludedInIntrinsics) {
                mismatchCount++;
            }
        }
    }

    let statsText = `${excluded} / ${total} excluded`;
    if (mismatchCount > 0) {
        statsText += ` (⚠ ${mismatchCount} differ from intrinsics)`;
    }
    statsEl.textContent = statsText;

    if (mismatchCount > 0) {
        statsEl.style.color = '#f97316'; // Orange for mismatch warning
    } else if (excluded > 0) {
        statsEl.style.color = '#fbbf24';
    } else {
        statsEl.style.color = '#888';
    }
}

// ============================================
// Clear Exclusions
// ============================================

/**
 * Clear all intrinsics exclusions
 */
function clearIntrinsicsExclusions() {
    for (const cam in state.exclusions.intrinsics) {
        state.exclusions.intrinsics[cam].clear();
    }
    log('Cleared all intrinsics exclusions', 'info');
    updateIntrinsicsExclusionUI();
}

/**
 * Clear all extrinsics exclusions
 */
function clearExtrinsicsExclusions() {
    state.exclusions.extrinsics.clear();
    log('Cleared all extrinsics exclusions', 'info');
    updateExtrinsicsExclusionUI();
}

// ============================================
// Keyboard Shortcuts
// ============================================

/**
 * Setup keyboard shortcut for toggling exclusion (X key)
 */
function setupExclusionKeyboardShortcut() {
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

        if (e.key === 'x' || e.key === 'X') {
            // Toggle exclusion based on which overlay is active
            if (state.showReprojection && Object.keys(state.intrinsics).length > 0) {
                // Toggle intrinsics exclusion for current calibration frame
                const calibIdx = state.reprojectionFrameIndex;

                // Check if currently excluded
                let isExcluded = false;
                for (const camName of Object.keys(state.intrinsics)) {
                    if (isIntrinsicsFrameExcluded(camName, calibIdx)) {
                        isExcluded = true;
                        break;
                    }
                }

                // Toggle for all cameras
                for (const camName of Object.keys(state.intrinsics)) {
                    if (isExcluded) {
                        state.exclusions.intrinsics[camName].delete(calibIdx);
                    } else {
                        state.exclusions.intrinsics[camName].add(calibIdx);
                    }
                }

                const firstCam = Object.keys(state.intrinsics)[0];
                const videoFrame = state.intrinsics[firstCam]?.frameIndices?.[calibIdx];
                log(`${isExcluded ? 'Included' : 'Excluded'} calibration frame ${calibIdx + 1} (video frame ${videoFrame})`, isExcluded ? 'info' : 'warn');
                updateIntrinsicsExclusionUI();
                e.preventDefault();
            } else if (state.showExtrinsicsReproj && state.extrinsicsReprojData) {
                // Toggle extrinsics exclusion for current frame
                const videoFrame = state.extrinsicsReprojData[state.extrinsicsReprojFrameIndex]?.frame;
                if (videoFrame !== undefined) {
                    toggleExtrinsicsExclusion(videoFrame);
                    e.preventDefault();
                }
            }
        }
    });
}

/**
 * Setup event listeners for exclusion controls
 */
function setupExclusionEventListeners() {
    document.getElementById('clearIntrinsicsExclusionsBtn').addEventListener('click', clearIntrinsicsExclusions);
    document.getElementById('clearExtrinsicsExclusionsBtn').addEventListener('click', clearExtrinsicsExclusions);
}
