/**
 * Calibration module for multi-camera calibration
 * Contains ChArUco detection, intrinsic/extrinsic calibration, and triangulation
 */

// Helper for logging (uses global log function if available)
function calibLog(msg, level = 'info') {
    if (typeof log === 'function') {
        log(msg, level);
    } else {
        console.log(`[${level}] ${msg}`);
    }
}

// ============================================
// ArUco Dictionary Handling
// ============================================

/**
 * Get OpenCV ArUco dictionary ID from name
 */
function getArucoDictId(dictName) {
    const ARUCO_DICT_MAP = {
        'DICT_4X4_50': cv.DICT_4X4_50,
        'DICT_4X4_100': cv.DICT_4X4_100,
        'DICT_4X4_250': cv.DICT_4X4_250,
        'DICT_4X4_1000': cv.DICT_4X4_1000,
        'DICT_5X5_50': cv.DICT_5X5_50,
        'DICT_5X5_100': cv.DICT_5X5_100,
        'DICT_5X5_250': cv.DICT_5X5_250,
        'DICT_5X5_1000': cv.DICT_5X5_1000,
        'DICT_6X6_50': cv.DICT_6X6_50,
        'DICT_6X6_100': cv.DICT_6X6_100,
        'DICT_6X6_250': cv.DICT_6X6_250,
        'DICT_6X6_1000': cv.DICT_6X6_1000,
    };
    return ARUCO_DICT_MAP[dictName];
}

/**
 * Create a ChArUco board with the given configuration
 */
function createCharucoBoard(config) {
    const dictId = getArucoDictId(config.dictName);
    if (dictId === undefined) {
        throw new Error(`Unknown dictionary: ${config.dictName}`);
    }

    const dictionary = cv.getPredefinedDictionary(dictId);
    const ids = new cv.Mat();
    const board = new cv.aruco_CharucoBoard(
        new cv.Size(config.boardX, config.boardY),
        config.squareLength,
        config.markerLength,
        dictionary,
        ids
    );
    ids.delete();

    return { board, dictionary };
}

// ============================================
// ChArUco Detection
// ============================================

/**
 * Detect ChArUco board in an image
 * @param {ImageData} imageData - Image data from canvas
 * @param {Object} config - Board configuration {boardX, boardY, squareLength, markerLength, dictName}
 * @returns {Object} Detection result with corners and IDs
 */
function detectCharuco(imageData, config) {
    const startTime = performance.now();

    // Convert to OpenCV Mat
    const convertStart = performance.now();
    const src = cv.matFromImageData(imageData);
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const convertTime = performance.now() - convertStart;

    // Create detector
    const setupStart = performance.now();
    const { board, dictionary } = createCharucoBoard(config);
    const detectorParams = new cv.aruco_DetectorParameters();
    const refineParams = new cv.aruco_RefineParameters(10.0, 3.0, true);
    const detector = new cv.aruco_ArucoDetector(dictionary, detectorParams, refineParams);
    const setupTime = performance.now() - setupStart;

    // Detect ArUco markers first
    const markerStart = performance.now();
    const markerCorners = new cv.MatVector();
    const markerIds = new cv.Mat();
    const rejectedCandidates = new cv.MatVector();

    detector.detectMarkers(gray, markerCorners, markerIds, rejectedCandidates);
    const markerTime = performance.now() - markerStart;

    const numMarkers = markerIds.rows;
    let result = {
        numMarkers: numMarkers,
        markerIds: [],
        charucoCorners: null,
        charucoIds: null,
        numCharucoCorners: 0,
        detectTime: 0,
    };

    // Extract marker IDs
    for (let i = 0; i < numMarkers; i++) {
        result.markerIds.push(markerIds.intAt(i, 0));
    }

    // If we have markers, try to detect ChArUco corners
    let charucoTime = 0;
    if (numMarkers > 0) {
        const charucoStart = performance.now();
        const charucoCorners = new cv.Mat();
        const charucoIds = new cv.Mat();

        const charucoParams = new cv.aruco_CharucoParameters();
        const charucoDetector = new cv.aruco_CharucoDetector(board, charucoParams, detectorParams, refineParams);

        charucoDetector.detectBoard(gray, charucoCorners, charucoIds, markerCorners, markerIds);
        charucoTime = performance.now() - charucoStart;

        result.numCharucoCorners = charucoIds.rows;

        if (charucoIds.rows > 0) {
            result.charucoCorners = [];
            result.charucoIds = [];
            for (let i = 0; i < charucoIds.rows; i++) {
                result.charucoIds.push(charucoIds.intAt(i, 0));
                result.charucoCorners.push({
                    x: charucoCorners.floatAt(i, 0),
                    y: charucoCorners.floatAt(i, 1)
                });
            }
        }

        charucoCorners.delete();
        charucoIds.delete();
        charucoDetector.delete();
        charucoParams.delete();
    }

    result.detectTime = performance.now() - startTime;

    // Add timing breakdown to result
    result.timings = {
        convert: convertTime,
        setup: setupTime,
        markers: markerTime,
        charuco: charucoTime,
        total: result.detectTime
    };

    // Log timing breakdown
    calibLog(`detectCharuco: ${result.detectTime.toFixed(1)}ms total | convert=${convertTime.toFixed(1)}ms, setup=${setupTime.toFixed(1)}ms, markers=${markerTime.toFixed(1)}ms, charuco=${charucoTime.toFixed(1)}ms | ${numMarkers} markers, ${result.numCharucoCorners} corners`);

    // Cleanup
    src.delete();
    gray.delete();
    markerCorners.delete();
    markerIds.delete();
    rejectedCandidates.delete();
    detector.delete();
    detectorParams.delete();
    refineParams.delete();
    board.delete();
    dictionary.delete();

    return result;
}

// ============================================
// Intrinsic Calibration
// ============================================

/**
 * Generate 3D object points for ChArUco corner IDs
 */
function getObjectPointsForCharucoCorners(charucoIds, config) {
    const objectPoints = [];
    const numCornersX = config.boardX - 1;

    for (let i = 0; i < charucoIds.length; i++) {
        const cornerId = charucoIds[i];
        const row = Math.floor(cornerId / numCornersX);
        const col = cornerId % numCornersX;
        const x = (col + 1) * config.squareLength;
        const y = (row + 1) * config.squareLength;
        const z = 0;
        objectPoints.push({ x, y, z });
    }
    return objectPoints;
}

/**
 * Compute intrinsic calibration for a camera
 * @param {Array} detections - Array of detection results with charucoCorners and charucoIds
 * @param {Object} imageSize - {width, height}
 * @param {Object} config - Board configuration
 * @param {number} minCorners - Minimum corners required per frame
 * @returns {Object} Calibration result with camera matrix, distortion coefficients, etc.
 */
function computeIntrinsics(detections, imageSize, config, minCorners) {
    // Collect all valid detections
    const allObjectPoints = [];
    const allImagePoints = [];
    const frameIndices = [];

    for (const detection of detections) {
        if (!detection.charucoCorners || detection.numCharucoCorners < minCorners) continue;

        const objPts = getObjectPointsForCharucoCorners(detection.charucoIds, config);
        const imgPts = detection.charucoCorners;

        allObjectPoints.push(objPts);
        allImagePoints.push(imgPts);
        frameIndices.push(detection.frame);
    }

    if (allObjectPoints.length < 3) {
        return null;
    }

    // Convert to OpenCV format
    const objectPointsMat = new cv.MatVector();
    const imagePointsMat = new cv.MatVector();

    for (let i = 0; i < allObjectPoints.length; i++) {
        const objPts = allObjectPoints[i];
        const imgPts = allImagePoints[i];

        const objMat = new cv.Mat(objPts.length, 1, cv.CV_32FC3);
        for (let j = 0; j < objPts.length; j++) {
            objMat.floatPtr(j, 0)[0] = objPts[j].x;
            objMat.floatPtr(j, 0)[1] = objPts[j].y;
            objMat.floatPtr(j, 0)[2] = objPts[j].z;
        }
        objectPointsMat.push_back(objMat);

        const imgMat = new cv.Mat(imgPts.length, 1, cv.CV_32FC2);
        for (let j = 0; j < imgPts.length; j++) {
            imgMat.floatPtr(j, 0)[0] = imgPts[j].x;
            imgMat.floatPtr(j, 0)[1] = imgPts[j].y;
        }
        imagePointsMat.push_back(imgMat);
    }

    // Initialize camera matrix
    const cx = imageSize.width / 2;
    const cy = imageSize.height / 2;
    const focalEstimate = imageSize.width / (2 * Math.tan(30 * Math.PI / 180));

    const cameraMatrix = cv.matFromArray(3, 3, cv.CV_64F, [
        focalEstimate, 0, cx,
        0, focalEstimate, cy,
        0, 0, 1
    ]);

    const distCoeffs = cv.Mat.zeros(5, 1, cv.CV_64F);
    const rvecs = new cv.MatVector();
    const tvecs = new cv.MatVector();
    const imageSizeMat = new cv.Size(imageSize.width, imageSize.height);

    try {
        const flags = cv.CALIB_USE_INTRINSIC_GUESS;
        const stdDeviationsIntrinsics = new cv.Mat();
        const stdDeviationsExtrinsics = new cv.Mat();
        const perViewErrors = new cv.Mat();

        const rmsError = cv.calibrateCameraExtended(
            objectPointsMat,
            imagePointsMat,
            imageSizeMat,
            cameraMatrix,
            distCoeffs,
            rvecs,
            tvecs,
            stdDeviationsIntrinsics,
            stdDeviationsExtrinsics,
            perViewErrors,
            flags
        );

        const perImageErrors = [];
        for (let i = 0; i < perViewErrors.rows; i++) {
            perImageErrors.push(perViewErrors.doubleAt(i, 0));
        }

        stdDeviationsIntrinsics.delete();
        stdDeviationsExtrinsics.delete();
        perViewErrors.delete();

        // Extract results
        const fx = cameraMatrix.doubleAt(0, 0);
        const fy = cameraMatrix.doubleAt(1, 1);
        const cx_out = cameraMatrix.doubleAt(0, 2);
        const cy_out = cameraMatrix.doubleAt(1, 2);

        const k1 = distCoeffs.doubleAt(0, 0);
        const k2 = distCoeffs.doubleAt(1, 0);
        const p1 = distCoeffs.doubleAt(2, 0);
        const p2 = distCoeffs.doubleAt(3, 0);
        const k3 = distCoeffs.doubleAt(4, 0);

        const result = {
            imageSize: imageSize,
            cameraMatrix: [[fx, 0, cx_out], [0, fy, cy_out], [0, 0, 1]],
            distCoeffs: [k1, k2, p1, p2, k3],
            fx, fy, cx: cx_out, cy: cy_out,
            k1, k2, p1, p2, k3,
            rmsError: rmsError,
            framesUsed: allObjectPoints.length,
            rvecs: [],
            tvecs: [],
            objectPoints: allObjectPoints,
            imagePoints: allImagePoints,
            frameIndices: frameIndices,
            perImageErrors: perImageErrors,
        };

        // Extract per-frame poses
        for (let i = 0; i < rvecs.size(); i++) {
            const rvec = rvecs.get(i);
            const tvec = tvecs.get(i);
            result.rvecs.push([rvec.doubleAt(0, 0), rvec.doubleAt(1, 0), rvec.doubleAt(2, 0)]);
            result.tvecs.push([tvec.doubleAt(0, 0), tvec.doubleAt(1, 0), tvec.doubleAt(2, 0)]);
            rvec.delete();
            tvec.delete();
        }

        // Cleanup
        for (let i = 0; i < objectPointsMat.size(); i++) {
            objectPointsMat.get(i).delete();
            imagePointsMat.get(i).delete();
        }
        objectPointsMat.delete();
        imagePointsMat.delete();
        cameraMatrix.delete();
        distCoeffs.delete();
        rvecs.delete();
        tvecs.delete();

        return result;

    } catch (err) {
        // Cleanup on error
        for (let i = 0; i < objectPointsMat.size(); i++) {
            objectPointsMat.get(i).delete();
            imagePointsMat.get(i).delete();
        }
        objectPointsMat.delete();
        imagePointsMat.delete();
        cameraMatrix.delete();
        distCoeffs.delete();
        rvecs.delete();
        tvecs.delete();
        throw err;
    }
}

/**
 * Compute intrinsic calibration for a camera with exclusion support
 * @param {Array} viewDetections - Array of {frame, charucoCorners, charucoIds, numCharucoCorners} for one view
 * @param {Object} imageSize - {width, height}
 * @param {Object} config - Board configuration
 * @param {number} minCorners - Minimum corners required per frame
 * @param {Set} exclusions - Set of calibration frame indices to exclude
 * @returns {Object} Calibration result with camera matrix, distortion coefficients, per-frame errors, etc.
 */
function computeIntrinsicsForCamera(viewDetections, imageSize, config, minCorners, exclusions = new Set()) {
    const startTime = performance.now();
    calibLog(`computeIntrinsicsForCamera: Starting with ${viewDetections.length} detections, imageSize=${imageSize.width}x${imageSize.height}, minCorners=${minCorners}, exclusions=${exclusions.size}`);

    // First pass: Collect all valid detections (for frame indexing consistency)
    const filterStart = performance.now();
    const allValidFrames = [];
    for (const detection of viewDetections) {
        if (!detection.charucoCorners || detection.numCharucoCorners < minCorners) continue;

        allValidFrames.push({
            frame: detection.frame,
            objPts: getObjectPointsForCharucoCorners(detection.charucoIds, config),
            imgPts: detection.charucoCorners
        });
    }

    // Second pass: Filter out excluded frames
    const allObjectPoints = [];
    const allImagePoints = [];
    const frameIndices = [];
    const originalCalibIndices = [];

    for (let calibIdx = 0; calibIdx < allValidFrames.length; calibIdx++) {
        if (exclusions.has(calibIdx)) continue;

        const validFrame = allValidFrames[calibIdx];
        allObjectPoints.push(validFrame.objPts);
        allImagePoints.push(validFrame.imgPts);
        frameIndices.push(validFrame.frame);
        originalCalibIndices.push(calibIdx);
    }

    const usedFrames = allObjectPoints.length;
    const filterTime = performance.now() - filterStart;
    calibLog(`computeIntrinsicsForCamera: Filtered ${allValidFrames.length} valid frames -> ${usedFrames} frames after exclusions (${filterTime.toFixed(1)}ms)`);

    if (usedFrames < 3) {
        calibLog(`computeIntrinsicsForCamera: Insufficient frames (${usedFrames} < 3), returning null`, 'warn');
        return null;
    }

    // Convert to OpenCV format
    const cvConvertStart = performance.now();
    const objectPointsMat = new cv.MatVector();
    const imagePointsMat = new cv.MatVector();

    for (let i = 0; i < allObjectPoints.length; i++) {
        const objPts = allObjectPoints[i];
        const imgPts = allImagePoints[i];

        const objMat = new cv.Mat(objPts.length, 1, cv.CV_32FC3);
        for (let j = 0; j < objPts.length; j++) {
            objMat.floatPtr(j, 0)[0] = objPts[j].x;
            objMat.floatPtr(j, 0)[1] = objPts[j].y;
            objMat.floatPtr(j, 0)[2] = objPts[j].z;
        }
        objectPointsMat.push_back(objMat);

        const imgMat = new cv.Mat(imgPts.length, 1, cv.CV_32FC2);
        for (let j = 0; j < imgPts.length; j++) {
            imgMat.floatPtr(j, 0)[0] = imgPts[j].x;
            imgMat.floatPtr(j, 0)[1] = imgPts[j].y;
        }
        imagePointsMat.push_back(imgMat);
    }

    // Initialize camera matrix
    const cx = imageSize.width / 2;
    const cy = imageSize.height / 2;
    const focalEstimate = imageSize.width / (2 * Math.tan(30 * Math.PI / 180));

    const cameraMatrix = cv.matFromArray(3, 3, cv.CV_64F, [
        focalEstimate, 0, cx,
        0, focalEstimate, cy,
        0, 0, 1
    ]);

    const distCoeffs = cv.Mat.zeros(5, 1, cv.CV_64F);
    const rvecs = new cv.MatVector();
    const tvecs = new cv.MatVector();
    const imageSizeMat = new cv.Size(imageSize.width, imageSize.height);
    const cvConvertTime = performance.now() - cvConvertStart;
    calibLog(`computeIntrinsicsForCamera: OpenCV data conversion took ${cvConvertTime.toFixed(1)}ms`);

    try {
        const calibStart = performance.now();
        const flags = cv.CALIB_USE_INTRINSIC_GUESS;
        const stdDeviationsIntrinsics = new cv.Mat();
        const stdDeviationsExtrinsics = new cv.Mat();
        const perViewErrors = new cv.Mat();

        const rmsError = cv.calibrateCameraExtended(
            objectPointsMat, imagePointsMat, imageSizeMat,
            cameraMatrix, distCoeffs, rvecs, tvecs,
            stdDeviationsIntrinsics, stdDeviationsExtrinsics, perViewErrors, flags
        );
        const calibTime = performance.now() - calibStart;
        calibLog(`computeIntrinsicsForCamera: cv.calibrateCameraExtended took ${calibTime.toFixed(1)}ms, RMS=${rmsError.toFixed(4)}px`);

        const perImageErrors = [];
        for (let i = 0; i < perViewErrors.rows; i++) {
            perImageErrors.push(perViewErrors.doubleAt(i, 0));
        }

        stdDeviationsIntrinsics.delete();
        stdDeviationsExtrinsics.delete();
        perViewErrors.delete();

        // Extract results
        const fx = cameraMatrix.doubleAt(0, 0);
        const fy = cameraMatrix.doubleAt(1, 1);
        const cx_out = cameraMatrix.doubleAt(0, 2);
        const cy_out = cameraMatrix.doubleAt(1, 2);

        const k1 = distCoeffs.doubleAt(0, 0);
        const k2 = distCoeffs.doubleAt(1, 0);
        const p1 = distCoeffs.doubleAt(2, 0);
        const p2 = distCoeffs.doubleAt(3, 0);
        const k3 = distCoeffs.doubleAt(4, 0);

        const result = {
            imageSize: imageSize,
            cameraMatrix: [[fx, 0, cx_out], [0, fy, cy_out], [0, 0, 1]],
            distCoeffs: [k1, k2, p1, p2, k3],
            fx, fy, cx: cx_out, cy: cy_out,
            k1, k2, p1, p2, k3,
            rmsError: rmsError,
            framesUsed: usedFrames,
            rvecs: [],
            tvecs: [],
            objectPoints: allObjectPoints,
            imagePoints: allImagePoints,
            frameIndices: frameIndices,
            perImageErrors: perImageErrors,
            allValidFrames: allValidFrames,
            originalCalibIndices: originalCalibIndices,
        };

        // Extract per-frame poses
        for (let i = 0; i < rvecs.size(); i++) {
            const rvec = rvecs.get(i);
            const tvec = tvecs.get(i);
            result.rvecs.push([rvec.doubleAt(0, 0), rvec.doubleAt(1, 0), rvec.doubleAt(2, 0)]);
            result.tvecs.push([tvec.doubleAt(0, 0), tvec.doubleAt(1, 0), tvec.doubleAt(2, 0)]);
            rvec.delete();
            tvec.delete();
        }

        // Compute reprojection errors for ALL frames (including excluded)
        const reprojStart = performance.now();
        const allPerImageErrors = [];
        const allRvecs = [];
        const allTvecs = [];

        const camMatForReproj = cv.matFromArray(3, 3, cv.CV_64F, [fx, 0, cx_out, 0, fy, cy_out, 0, 0, 1]);
        const distCoeffsForReproj = cv.matFromArray(5, 1, cv.CV_64F, [k1, k2, p1, p2, k3]);

        for (let calibIdx = 0; calibIdx < allValidFrames.length; calibIdx++) {
            const frame = allValidFrames[calibIdx];
            const objPts = frame.objPts;
            const imgPts = frame.imgPts;

            const objMat = new cv.Mat(objPts.length, 1, cv.CV_32FC3);
            for (let j = 0; j < objPts.length; j++) {
                objMat.floatPtr(j, 0)[0] = objPts[j].x;
                objMat.floatPtr(j, 0)[1] = objPts[j].y;
                objMat.floatPtr(j, 0)[2] = objPts[j].z;
            }

            const rvecMat = new cv.Mat();
            const tvecMat = new cv.Mat();

            try {
                const imgMat = new cv.Mat(imgPts.length, 1, cv.CV_32FC2);
                for (let j = 0; j < imgPts.length; j++) {
                    imgMat.floatPtr(j, 0)[0] = imgPts[j].x;
                    imgMat.floatPtr(j, 0)[1] = imgPts[j].y;
                }

                cv.solvePnP(objMat, imgMat, camMatForReproj, distCoeffsForReproj, rvecMat, tvecMat);

                allRvecs.push([rvecMat.doubleAt(0, 0), rvecMat.doubleAt(1, 0), rvecMat.doubleAt(2, 0)]);
                allTvecs.push([tvecMat.doubleAt(0, 0), tvecMat.doubleAt(1, 0), tvecMat.doubleAt(2, 0)]);

                const projectedPts = new cv.Mat();
                const jacobian = new cv.Mat();
                cv.projectPoints(objMat, rvecMat, tvecMat, camMatForReproj, distCoeffsForReproj, projectedPts, jacobian);

                let sumSqError = 0;
                for (let j = 0; j < imgPts.length; j++) {
                    const dx = projectedPts.floatAt(j, 0) - imgPts[j].x;
                    const dy = projectedPts.floatAt(j, 1) - imgPts[j].y;
                    sumSqError += dx * dx + dy * dy;
                }
                allPerImageErrors.push(Math.sqrt(sumSqError / imgPts.length));

                projectedPts.delete();
                jacobian.delete();
                imgMat.delete();
            } catch (e) {
                allPerImageErrors.push(NaN);
                allRvecs.push(null);
                allTvecs.push(null);
            }

            objMat.delete();
            rvecMat.delete();
            tvecMat.delete();
        }

        camMatForReproj.delete();
        distCoeffsForReproj.delete();
        const reprojTime = performance.now() - reprojStart;
        calibLog(`computeIntrinsicsForCamera: Reprojection errors computed for ${allValidFrames.length} frames in ${reprojTime.toFixed(1)}ms`);

        result.allPerImageErrors = allPerImageErrors;
        result.allRvecs = allRvecs;
        result.allTvecs = allTvecs;
        result.allFrameIndices = allValidFrames.map(f => f.frame);

        // Cleanup
        for (let i = 0; i < objectPointsMat.size(); i++) {
            objectPointsMat.get(i).delete();
            imagePointsMat.get(i).delete();
        }
        objectPointsMat.delete();
        imagePointsMat.delete();
        cameraMatrix.delete();
        distCoeffs.delete();
        rvecs.delete();
        tvecs.delete();

        const totalTime = performance.now() - startTime;
        const avgError = allPerImageErrors.filter(e => !isNaN(e)).reduce((a, b) => a + b, 0) / allPerImageErrors.filter(e => !isNaN(e)).length;
        calibLog(`computeIntrinsicsForCamera: Complete in ${totalTime.toFixed(1)}ms | fx=${fx.toFixed(1)}, fy=${fy.toFixed(1)}, RMS=${rmsError.toFixed(4)}px, avgReproj=${avgError.toFixed(4)}px`);

        return result;

    } catch (err) {
        // Cleanup on error
        for (let i = 0; i < objectPointsMat.size(); i++) {
            objectPointsMat.get(i).delete();
            imagePointsMat.get(i).delete();
        }
        objectPointsMat.delete();
        imagePointsMat.delete();
        cameraMatrix.delete();
        distCoeffs.delete();
        rvecs.delete();
        tvecs.delete();
        throw err;
    }
}

// ============================================
// Matrix Utilities
// ============================================

function transposeMatrix(R) {
    return [
        [R[0][0], R[1][0], R[2][0]],
        [R[0][1], R[1][1], R[2][1]],
        [R[0][2], R[1][2], R[2][2]],
    ];
}

function negateVector(v) {
    return [-v[0], -v[1], -v[2]];
}

function composeRotation(R1, R2) {
    const result = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            for (let k = 0; k < 3; k++) {
                result[i][j] += R2[i][k] * R1[k][j];
            }
        }
    }
    return result;
}

function rotateVector(R, v) {
    return [
        R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2],
        R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2],
        R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2],
    ];
}

function addVectors(v1, v2) {
    return [v1[0] + v2[0], v1[1] + v2[1], v1[2] + v2[2]];
}

function matrixToRodrigues(R) {
    const Rmat = cv.matFromArray(3, 3, cv.CV_64F, R.flat());
    const rvec = new cv.Mat();
    cv.Rodrigues(Rmat, rvec);
    const result = [rvec.doubleAt(0, 0), rvec.doubleAt(1, 0), rvec.doubleAt(2, 0)];
    Rmat.delete();
    rvec.delete();
    return result;
}

// ============================================
// Extrinsic Calibration
// ============================================

/**
 * Build covisibility graph showing which camera pairs see the board together
 */
function buildCovisibilityGraph(detections, viewNames, minCovisible) {
    const startTime = performance.now();
    calibLog(`buildCovisibilityGraph: Building graph for ${viewNames.length} cameras from ${detections.length} detections, minCovisible=${minCovisible}`);

    const graph = {};

    for (const viewName of viewNames) {
        graph[viewName] = {};
        for (const otherView of viewNames) {
            if (otherView !== viewName) {
                graph[viewName][otherView] = [];
            }
        }
    }

    for (const detection of detections) {
        const validViews = [];
        for (const viewName of viewNames) {
            const viewResult = detection.views[viewName];
            if (viewResult && !viewResult.error && viewResult.charucoCorners &&
                viewResult.numCharucoCorners >= minCovisible) {
                validViews.push(viewName);
            }
        }

        for (let i = 0; i < validViews.length; i++) {
            for (let j = i + 1; j < validViews.length; j++) {
                const view1 = validViews[i];
                const view2 = validViews[j];

                const ids1 = new Set(detection.views[view1].charucoIds);
                const ids2 = new Set(detection.views[view2].charucoIds);
                const commonIds = [...ids1].filter(id => ids2.has(id));

                if (commonIds.length >= minCovisible) {
                    graph[view1][view2].push({ frame: detection.frame, commonIds });
                    graph[view2][view1].push({ frame: detection.frame, commonIds });
                }
            }
        }
    }

    const totalTime = performance.now() - startTime;

    // Count total covisible pairs
    let totalPairs = 0;
    for (const v1 of viewNames) {
        for (const v2 of viewNames) {
            if (v1 < v2) {
                totalPairs += graph[v1][v2].length;
            }
        }
    }
    calibLog(`buildCovisibilityGraph: Complete in ${totalTime.toFixed(1)}ms | ${totalPairs} covisible frame pairs found`);

    return graph;
}

/**
 * Find path from reference camera to all others using BFS
 */
function findPoseChain(graph, refViewName, viewNames) {
    const visited = new Set([refViewName]);
    const queue = [refViewName];
    const parent = { [refViewName]: null };

    while (queue.length > 0) {
        const current = queue.shift();
        for (const neighbor of viewNames) {
            if (neighbor !== current && !visited.has(neighbor)) {
                if (graph[current][neighbor] && graph[current][neighbor].length > 0) {
                    visited.add(neighbor);
                    parent[neighbor] = current;
                    queue.push(neighbor);
                }
            }
        }
    }

    return parent;
}

/**
 * Compute board pose for a view on a frame using solvePnP
 */
function computeBoardPose(detection, viewName, config, intrinsics) {
    const startTime = performance.now();
    const viewResult = detection.views[viewName];
    if (!viewResult || viewResult.error || !viewResult.charucoCorners || viewResult.numCharucoCorners < 6) {
        return null;
    }

    const intr = intrinsics[viewName];
    if (!intr) return null;

    const objPts = getObjectPointsForCharucoCorners(viewResult.charucoIds, config);
    const imgPts = viewResult.charucoCorners;

    const objectPoints = cv.matFromArray(objPts.length, 3, cv.CV_64F,
        objPts.flatMap(p => [p.x, p.y, p.z]));
    const imagePoints = cv.matFromArray(imgPts.length, 2, cv.CV_64F,
        imgPts.flatMap(p => [p.x, p.y]));
    const cameraMatrix = cv.matFromArray(3, 3, cv.CV_64F, intr.cameraMatrix.flat());
    const distCoeffs = cv.matFromArray(5, 1, cv.CV_64F, intr.distCoeffs);

    const rvec = new cv.Mat();
    const tvec = new cv.Mat();

    try {
        const pnpStart = performance.now();
        const success = cv.solvePnP(objectPoints, imagePoints, cameraMatrix, distCoeffs, rvec, tvec);
        const pnpTime = performance.now() - pnpStart;

        if (!success) {
            calibLog(`computeBoardPose: solvePnP failed for ${viewName} on frame ${detection.frame}`, 'warn');
            objectPoints.delete(); imagePoints.delete(); cameraMatrix.delete();
            distCoeffs.delete(); rvec.delete(); tvec.delete();
            return null;
        }

        const R = new cv.Mat();
        cv.Rodrigues(rvec, R);

        const result = {
            R: [
                [R.doubleAt(0, 0), R.doubleAt(0, 1), R.doubleAt(0, 2)],
                [R.doubleAt(1, 0), R.doubleAt(1, 1), R.doubleAt(1, 2)],
                [R.doubleAt(2, 0), R.doubleAt(2, 1), R.doubleAt(2, 2)],
            ],
            rvec: [rvec.doubleAt(0, 0), rvec.doubleAt(1, 0), rvec.doubleAt(2, 0)],
            tvec: [tvec.doubleAt(0, 0), tvec.doubleAt(1, 0), tvec.doubleAt(2, 0)],
        };

        R.delete(); objectPoints.delete(); imagePoints.delete();
        cameraMatrix.delete(); distCoeffs.delete(); rvec.delete(); tvec.delete();

        const totalTime = performance.now() - startTime;
        calibLog(`computeBoardPose: ${viewName} frame=${detection.frame} | solvePnP=${pnpTime.toFixed(1)}ms, total=${totalTime.toFixed(1)}ms | T=[${result.tvec.map(v => v.toFixed(1)).join(', ')}]`);

        return result;
    } catch (err) {
        objectPoints.delete(); imagePoints.delete(); cameraMatrix.delete();
        distCoeffs.delete(); rvec.delete(); tvec.delete();
        return null;
    }
}

/**
 * Compute relative pose between two cameras
 */
function computeRelativePose(refViewName, targetViewName, graph, detections, config, intrinsics) {
    const startTime = performance.now();
    const covisibleFrames = graph[refViewName][targetViewName];
    if (covisibleFrames.length === 0) {
        calibLog(`computeRelativePose: No covisible frames for ${refViewName} -> ${targetViewName}`, 'warn');
        return null;
    }

    calibLog(`computeRelativePose: Computing ${refViewName} -> ${targetViewName} from ${covisibleFrames.length} covisible frames`);
    const relativePoses = [];

    for (const covis of covisibleFrames) {
        const detection = detections.find(d => d.frame === covis.frame);
        if (!detection) continue;

        const pose1 = computeBoardPose(detection, refViewName, config, intrinsics);
        const pose2 = computeBoardPose(detection, targetViewName, config, intrinsics);

        if (!pose1 || !pose2) continue;

        const R1_T = transposeMatrix(pose1.R);
        const R_rel = composeRotation(R1_T, pose2.R);
        const R1_T_t1 = rotateVector(R1_T, pose1.tvec);
        const t_rel = addVectors(pose2.tvec, negateVector(rotateVector(pose2.R, R1_T_t1)));

        relativePoses.push({ R: R_rel, tvec: t_rel });
    }

    if (relativePoses.length === 0) return null;

    // Average the poses
    const rvecs = relativePoses.map(p => matrixToRodrigues(p.R));
    const tvecs = relativePoses.map(p => p.tvec);

    const avgRvec = [
        rvecs.reduce((s, v) => s + v[0], 0) / rvecs.length,
        rvecs.reduce((s, v) => s + v[1], 0) / rvecs.length,
        rvecs.reduce((s, v) => s + v[2], 0) / rvecs.length,
    ];
    const avgTvec = [
        tvecs.reduce((s, v) => s + v[0], 0) / tvecs.length,
        tvecs.reduce((s, v) => s + v[1], 0) / tvecs.length,
        tvecs.reduce((s, v) => s + v[2], 0) / tvecs.length,
    ];

    const rvecMat = cv.matFromArray(3, 1, cv.CV_64F, avgRvec);
    const Rmat = new cv.Mat();
    cv.Rodrigues(rvecMat, Rmat);

    const R = [
        [Rmat.doubleAt(0, 0), Rmat.doubleAt(0, 1), Rmat.doubleAt(0, 2)],
        [Rmat.doubleAt(1, 0), Rmat.doubleAt(1, 1), Rmat.doubleAt(1, 2)],
        [Rmat.doubleAt(2, 0), Rmat.doubleAt(2, 1), Rmat.doubleAt(2, 2)],
    ];

    rvecMat.delete();
    Rmat.delete();

    const tStd = Math.sqrt(
        tvecs.reduce((s, v) => s + (v[0] - avgTvec[0])**2 + (v[1] - avgTvec[1])**2 + (v[2] - avgTvec[2])**2, 0) / tvecs.length
    );

    const totalTime = performance.now() - startTime;
    calibLog(`computeRelativePose: ${refViewName} -> ${targetViewName} complete in ${totalTime.toFixed(1)}ms | ${relativePoses.length} poses averaged, T=[${avgTvec.map(v => v.toFixed(1)).join(', ')}], std=${tStd.toFixed(2)}`);

    return { R, rvec: avgRvec, tvec: avgTvec, rmsError: tStd, framesUsed: relativePoses.length };
}

// ============================================
// Triangulation (WASM-accelerated)
// ============================================

// WASM module reference (loaded dynamically)
let wasmTriangulation = null;

/**
 * Initialize WASM triangulation module
 * @returns {Promise<Object>} The WASM wrapper module
 */
async function initTriangulationWasm() {
    if (wasmTriangulation) return wasmTriangulation;
    const startTime = performance.now();
    calibLog('initTriangulationWasm: Loading WASM module from CDN...');
    wasmTriangulation = await import(
        'https://cdn.jsdelivr.net/npm/@talmolab/sba-solver-wasm@0.2.0/wrapper.js'
    );
    await wasmTriangulation.initSBA();
    const loadTime = performance.now() - startTime;
    calibLog(`initTriangulationWasm: WASM module loaded and initialized in ${loadTime.toFixed(1)}ms`, 'success');
    return wasmTriangulation;
}

/**
 * Build WASM-format cameras array from intrinsics and extrinsics
 * @param {Array} viewNames - Array of camera names in order
 * @param {Object} intrinsics - Intrinsic parameters keyed by camera name
 * @param {Object} extrinsics - Extrinsic parameters keyed by camera name
 * @returns {Array} Array of CameraParams in WASM format
 */
function buildWasmCameras(viewNames, intrinsics, extrinsics) {
    return viewNames.map(name => {
        const intr = intrinsics[name];
        const extr = extrinsics[name];
        const quat = rotationMatrixToQuaternion(extr.R);
        return {
            rotation: quat,
            translation: [extr.tvec[0], extr.tvec[1], extr.tvec[2]],
            focal: [intr.fx, intr.fy],
            principal: [intr.cx, intr.cy],
            distortion: [intr.k1, intr.k2, intr.p1, intr.p2, intr.k3]
        };
    });
}

/**
 * Triangulate multiple 3D points using WASM-accelerated DLT
 * @param {Array} pointObservations - Array of observation arrays, one per point
 *        Each observation: { camera_idx, x, y }
 * @param {Array} cameras - WASM-format cameras array
 * @returns {Promise<Object>} Batch triangulation result with points array
 */
async function triangulatePointsWasm(pointObservations, cameras) {
    const wasm = await initTriangulationWasm();
    return await wasm.triangulatePoints(pointObservations, cameras);
}

/**
 * Project a 3D point using WASM wrapper's projectPoint (JS implementation)
 * @param {Array} point3d - [x, y, z] point
 * @param {Object} camera - WASM-format camera
 * @returns {Array} [u, v] pixel coordinates
 */
function projectPointWasm(point3d, camera) {
    // Use the wrapper's projectPoint (pure JS, no async needed)
    if (!wasmTriangulation) return null;
    return wasmTriangulation.projectPoint(point3d, camera);
}

// ============================================
// Quaternion Utilities (for SBA)
// ============================================

/**
 * Convert 3x3 rotation matrix to quaternion [w, x, y, z]
 */
function rotationMatrixToQuaternion(R) {
    const trace = R[0][0] + R[1][1] + R[2][2];
    let w, x, y, z;

    if (trace > 0) {
        const s = 0.5 / Math.sqrt(trace + 1.0);
        w = 0.25 / s;
        x = (R[2][1] - R[1][2]) * s;
        y = (R[0][2] - R[2][0]) * s;
        z = (R[1][0] - R[0][1]) * s;
    } else if (R[0][0] > R[1][1] && R[0][0] > R[2][2]) {
        const s = 2.0 * Math.sqrt(1.0 + R[0][0] - R[1][1] - R[2][2]);
        w = (R[2][1] - R[1][2]) / s;
        x = 0.25 * s;
        y = (R[0][1] + R[1][0]) / s;
        z = (R[0][2] + R[2][0]) / s;
    } else if (R[1][1] > R[2][2]) {
        const s = 2.0 * Math.sqrt(1.0 + R[1][1] - R[0][0] - R[2][2]);
        w = (R[0][2] - R[2][0]) / s;
        x = (R[0][1] + R[1][0]) / s;
        y = 0.25 * s;
        z = (R[1][2] + R[2][1]) / s;
    } else {
        const s = 2.0 * Math.sqrt(1.0 + R[2][2] - R[0][0] - R[1][1]);
        w = (R[1][0] - R[0][1]) / s;
        x = (R[0][2] + R[2][0]) / s;
        y = (R[1][2] + R[2][1]) / s;
        z = 0.25 * s;
    }

    // Normalize
    const norm = Math.sqrt(w*w + x*x + y*y + z*z);
    return [w/norm, x/norm, y/norm, z/norm];
}

/**
 * Convert quaternion [w, x, y, z] to 3x3 rotation matrix
 */
function quaternionToRotationMatrix(q) {
    const [w, x, y, z] = q;
    return [
        [1 - 2*y*y - 2*z*z,     2*x*y - 2*z*w,     2*x*z + 2*y*w],
        [    2*x*y + 2*z*w, 1 - 2*x*x - 2*z*z,     2*y*z - 2*x*w],
        [    2*x*z - 2*y*w,     2*y*z + 2*x*w, 1 - 2*x*x - 2*y*y]
    ];
}

// ============================================
// SBA Data Preparation
// ============================================

/**
 * Prepare SBA input from calibration state
 * @param {Object} state - Global state with intrinsics, extrinsics, detections
 * @param {Array} viewNames - Array of view names
 * @param {Object} config - Board configuration {boardX, boardY, squareLength, markerLength, dictName}
 * @param {Function} generateSbaJsonOutput - Function to generate SBA JSON data
 * @returns {Object|null} SBA input data or null if missing data
 */
function prepareSbaInput(state, viewNames, config, generateSbaJsonOutput) {
    const startTime = performance.now();
    calibLog(`prepareSbaInput: Preparing SBA input for ${viewNames.length} cameras`);

    const exportStart = performance.now();
    const exportData = generateSbaJsonOutput(state, viewNames, config);
    const exportTime = performance.now() - exportStart;
    calibLog(`prepareSbaInput: Generated export data in ${exportTime.toFixed(1)}ms`);

    if (!exportData) {
        calibLog('prepareSbaInput: Failed to generate export data', 'error');
        return null;
    }

    // Build cameras array in WASM format
    const cameras = viewNames.map(name => {
        const intr = state.intrinsics[name];
        const extr = state.extrinsics[name];

        // Convert rotation matrix to quaternion [w, x, y, z]
        const quat = rotationMatrixToQuaternion(extr.R);

        return {
            rotation: quat,
            translation: [extr.tvec[0], extr.tvec[1], extr.tvec[2]],
            focal: [intr.fx, intr.fy],
            principal: [intr.cx, intr.cy],
            distortion: [intr.k1, intr.k2, intr.p1, intr.p2, intr.k3]
        };
    });

    // Build points array from triangulated points
    const points = [];
    const pointToFrame = [];
    const pointIdMap = new Map();

    for (const tp of exportData.triangulated_points) {
        const pointIdx = points.length;
        points.push([tp.point_3d[0], tp.point_3d[1], tp.point_3d[2]]);
        pointToFrame.push(tp.frame);
        pointIdMap.set(`${tp.frame}-${tp.corner_id}`, pointIdx);
    }

    // Build observations array
    const observations = [];
    const cameraIndexMap = new Map(viewNames.map((n, i) => [n, i]));

    for (const obs of exportData.observations) {
        for (const [camName, camObs] of Object.entries(obs.views)) {
            const camIdx = cameraIndexMap.get(camName);

            for (let i = 0; i < camObs.corner_ids.length; i++) {
                const cornerId = camObs.corner_ids[i];
                const key = `${obs.frame}-${cornerId}`;
                const pointIdx = pointIdMap.get(key);

                if (pointIdx !== undefined) {
                    observations.push({
                        camera_idx: camIdx,
                        point_idx: pointIdx,
                        x: camObs.corners_2d[i][0],
                        y: camObs.corners_2d[i][1]
                    });
                }
            }
        }
    }

    const totalTime = performance.now() - startTime;
    calibLog(`prepareSbaInput: Complete in ${totalTime.toFixed(1)}ms | ${cameras.length} cameras, ${points.length} points, ${observations.length} observations`, 'success');

    return {
        cameras,
        points,
        observations,
        point_to_frame: pointToFrame,
        metadata: {
            camera_names: viewNames,
            num_cameras: cameras.length,
            num_points: points.length,
            num_observations: observations.length
        }
    };
}

// ============================================
// Cross-View Reprojection
// ============================================

/**
 * Get matched points between two views for a specific frame
 * @param {Array} detections - Array of detection results
 * @param {string} view1Name - Name of first view
 * @param {string} view2Name - Name of second view
 * @param {number} frameIndex - Frame index
 * @param {Array} commonIds - Array of common corner IDs
 * @returns {Object|null} Object with points1 and points2 arrays, or null
 */
function getMatchedPointsForFrame(detections, view1Name, view2Name, frameIndex, commonIds) {
    const detection = detections.find(d => d.frame === frameIndex);
    if (!detection) return null;

    const result1 = detection.views[view1Name];
    const result2 = detection.views[view2Name];

    if (!result1 || !result2) return null;

    const points1 = [];
    const points2 = [];

    for (const id of commonIds) {
        const idx1 = result1.charucoIds.indexOf(id);
        const idx2 = result2.charucoIds.indexOf(id);

        if (idx1 >= 0 && idx2 >= 0) {
            points1.push(result1.charucoCorners[idx1]);
            points2.push(result2.charucoCorners[idx2]);
        }
    }

    return { points1, points2 };
}

/**
 * Compute cross-view reprojection errors by triangulating points and reprojecting
 * Uses WASM-accelerated batch triangulation for better performance
 * @param {Array} detections - Array of detection results
 * @param {Array} viewNames - Array of view names
 * @param {Object} intrinsics - Intrinsic parameters per camera
 * @param {Object} extrinsics - Extrinsic parameters per camera
 * @returns {Promise<Array>} Array of frame errors with point reprojection data
 */
async function computeCrossViewReprojectionErrors(detections, viewNames, intrinsics, extrinsics) {
    const startTime = performance.now();
    calibLog(`computeCrossViewReprojectionErrors: Starting for ${detections.length} detections, ${viewNames.length} cameras`);

    // Initialize WASM and build cameras array once
    const initStart = performance.now();
    await initTriangulationWasm();
    const wasmCameras = buildWasmCameras(viewNames, intrinsics, extrinsics);
    const cameraIndexMap = new Map(viewNames.map((name, idx) => [name, idx]));
    const initTime = performance.now() - initStart;
    calibLog(`computeCrossViewReprojectionErrors: Camera setup complete in ${initTime.toFixed(1)}ms`);

    const frameErrors = [];
    let totalTriangulations = 0;
    let totalPoints = 0;

    for (const detection of detections) {
        // Get cameras with valid detections
        const validCameras = [];
        for (const viewName of viewNames) {
            const viewResult = detection.views[viewName];
            if (viewResult && !viewResult.error && viewResult.charucoCorners && viewResult.numCharucoCorners >= 4) {
                validCameras.push(viewName);
            }
        }

        if (validCameras.length < 2) continue;

        // Find common corner IDs across all valid cameras
        let commonIds = new Set(detection.views[validCameras[0]].charucoIds);
        for (let i = 1; i < validCameras.length; i++) {
            const ids = new Set(detection.views[validCameras[i]].charucoIds);
            commonIds = new Set([...commonIds].filter(id => ids.has(id)));
        }

        if (commonIds.size < 4) continue;

        // Build batch observations for WASM triangulation
        const pointIds = [...commonIds];
        const pointObservations = [];  // Array of observation arrays for batch triangulation
        const originalObservations = [];  // Keep original format for reprojection

        for (const pointId of pointIds) {
            const wasmObs = [];
            const origObs = [];
            for (const camera of validCameras) {
                const viewResult = detection.views[camera];
                const idx = viewResult.charucoIds.indexOf(pointId);
                if (idx >= 0) {
                    const corner = viewResult.charucoCorners[idx];
                    wasmObs.push({
                        camera_idx: cameraIndexMap.get(camera),
                        x: corner.x,
                        y: corner.y
                    });
                    origObs.push({ camera, point: corner });
                }
            }
            if (wasmObs.length >= 2) {
                pointObservations.push(wasmObs);
                originalObservations.push({ pointId, observations: origObs });
            }
        }

        if (pointObservations.length === 0) continue;

        // Batch triangulate all points for this frame using WASM
        const triangResult = await triangulatePointsWasm(pointObservations, wasmCameras);

        // Process results and compute per-camera reprojection errors
        const pointErrors = [];
        for (let i = 0; i < triangResult.points.length; i++) {
            const point3D = triangResult.points[i];
            if (!point3D || triangResult.failed_indices.includes(i)) continue;

            const { pointId, observations } = originalObservations[i];

            // Compute reprojection error for each camera
            const perCameraErrors = {};
            let totalError = 0;
            let numCameras = 0;

            for (const obs of observations) {
                const camIdx = cameraIndexMap.get(obs.camera);
                const projected = projectPointWasm(point3D, wasmCameras[camIdx]);
                if (projected && !isNaN(projected[0])) {
                    const dx = projected[0] - obs.point.x;
                    const dy = projected[1] - obs.point.y;
                    const error = Math.sqrt(dx * dx + dy * dy);
                    perCameraErrors[obs.camera] = {
                        error: error,
                        detected: obs.point,
                        projected: { x: projected[0], y: projected[1] }
                    };
                    totalError += error;
                    numCameras++;
                }
            }

            if (numCameras > 0) {
                pointErrors.push({
                    pointId: pointId,
                    point3D: { x: point3D[0], y: point3D[1], z: point3D[2] },
                    cameras: validCameras,
                    meanError: totalError / numCameras,
                    perCameraErrors: perCameraErrors
                });
            }
        }

        if (pointErrors.length > 0) {
            frameErrors.push({
                frame: detection.frame,
                pointErrors: pointErrors,
                cameras: validCameras
            });
            totalPoints += pointErrors.length;
        }
        totalTriangulations++;
    }

    const totalTime = performance.now() - startTime;
    const avgPointsPerFrame = frameErrors.length > 0 ? (totalPoints / frameErrors.length).toFixed(1) : 0;
    const meanError = frameErrors.length > 0
        ? (frameErrors.reduce((sum, f) => sum + f.pointErrors.reduce((s, p) => s + p.meanError, 0) / f.pointErrors.length, 0) / frameErrors.length).toFixed(3)
        : 'N/A';

    calibLog(`computeCrossViewReprojectionErrors: Complete in ${totalTime.toFixed(1)}ms | ${frameErrors.length} frames, ${totalPoints} points triangulated, avg ${avgPointsPerFrame} pts/frame, mean reproj=${meanError}px`, 'success');

    return frameErrors;
}

// ============================================
// Absolute Extrinsics Computation
// ============================================

/**
 * Compute pairwise relative poses between cameras
 * @param {Object} graph - Covisibility graph from buildCovisibilityGraph
 * @param {Object} parent - Parent map from findPoseChain
 * @param {Array} detections - Detection results
 * @param {Object} config - Board configuration
 * @param {Object} intrinsics - Intrinsic parameters per camera
 * @param {string} refViewName - Reference camera name
 * @param {Array} viewNames - Array of view names
 * @returns {Object} relativePoses object keyed by "source->target"
 */
function computePairwiseRelativePoses(graph, parent, detections, config, intrinsics, refViewName, viewNames) {
    const relativePoses = {};

    for (const viewName of viewNames) {
        if (viewName !== refViewName && parent[viewName]) {
            const pose = computeRelativePose(parent[viewName], viewName, graph, detections, config, intrinsics);
            if (pose) {
                relativePoses[`${parent[viewName]}->${viewName}`] = pose;
            }
        }
    }

    return relativePoses;
}

/**
 * Chain relative poses to compute absolute extrinsics for all cameras
 * @param {Object} relativePoses - Object keyed by "source->target" with R, rvec, tvec, rmsError
 * @param {Object} parent - Parent map from findPoseChain
 * @param {string} refViewName - Reference camera name
 * @param {Array} viewNames - Array of view names
 * @returns {Object} extrinsics object keyed by camera name with R, rvec, tvec
 */
function chainRelativePoses(relativePoses, parent, refViewName, viewNames) {
    const extrinsics = {};

    // Reference camera is at origin
    extrinsics[refViewName] = {
        viewName: refViewName,
        R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
        rvec: [0, 0, 0],
        tvec: [0, 0, 0],
        rmsError: 0,
    };

    // Compute absolute poses for other cameras
    for (const viewName of viewNames) {
        if (viewName === refViewName) continue;

        // Build path from reference to this camera
        const path = [];
        let current = viewName;
        while (current !== refViewName) {
            path.unshift(current);
            current = parent[current];
        }

        // Chain the transformations
        let R_abs = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
        let t_abs = [0, 0, 0];
        let totalError = 0;

        current = refViewName;
        for (const next of path) {
            const poseKey = `${current}->${next}`;
            const pose = relativePoses[poseKey];

            if (pose) {
                // T_abs = T_rel * T_abs
                // R_new = R_rel * R_abs
                // t_new = R_rel * t_abs + t_rel
                t_abs = addVectors(rotateVector(pose.R, t_abs), pose.tvec);
                R_abs = composeRotation(R_abs, pose.R);
                totalError += pose.rmsError;
            }
            current = next;
        }

        const rvec = matrixToRodrigues(R_abs);

        extrinsics[viewName] = {
            viewName: viewName,
            R: R_abs,
            rvec: rvec,
            tvec: t_abs,
            rmsError: totalError / path.length,
        };
    }

    return extrinsics;
}

/**
 * Compute absolute extrinsics for all cameras relative to a reference
 * Combines relative pose computation and pose chaining
 * @param {Object} graph - Covisibility graph from buildCovisibilityGraph
 * @param {Object} parent - Parent map from findPoseChain
 * @param {Array} detections - Detection results
 * @param {Object} config - Board configuration
 * @param {Object} intrinsics - Intrinsic parameters per camera
 * @param {string} refViewName - Reference camera name
 * @param {Array} viewNames - Array of view names
 * @returns {Object} Object with extrinsics and relativePoses
 */
function computeAbsoluteExtrinsics(graph, parent, detections, config, intrinsics, refViewName, viewNames) {
    const startTime = performance.now();
    calibLog(`computeAbsoluteExtrinsics: Computing for ${viewNames.length} cameras, reference=${refViewName}`);

    // Compute pairwise relative poses
    const relStart = performance.now();
    const relativePoses = computePairwiseRelativePoses(graph, parent, detections, config, intrinsics, refViewName, viewNames);
    const relTime = performance.now() - relStart;
    calibLog(`computeAbsoluteExtrinsics: Pairwise relative poses computed in ${relTime.toFixed(1)}ms (${Object.keys(relativePoses).length} pairs)`);

    // Chain to get absolute poses
    const chainStart = performance.now();
    const extrinsics = chainRelativePoses(relativePoses, parent, refViewName, viewNames);
    const chainTime = performance.now() - chainStart;
    calibLog(`computeAbsoluteExtrinsics: Pose chaining complete in ${chainTime.toFixed(1)}ms`);

    const totalTime = performance.now() - startTime;
    calibLog(`computeAbsoluteExtrinsics: Complete in ${totalTime.toFixed(1)}ms | ${Object.keys(extrinsics).length} camera poses computed`, 'success');

    return { extrinsics, relativePoses };
}

// ============================================
// SBA Results
// ============================================

/**
 * Apply SBA results back to calibration state
 * @param {Object} sbaResult - Result from SBA solver
 * @param {Object} state - Global state to update
 * @param {Array} cameraNames - Array of camera names
 */
function applySbaResults(sbaResult, state, cameraNames) {
    const startTime = performance.now();
    calibLog(`applySbaResults: Applying results for ${cameraNames.length} cameras`);

    for (let i = 0; i < cameraNames.length; i++) {
        const name = cameraNames[i];
        const cam = sbaResult.cameras[i];

        // Update intrinsics
        state.intrinsics[name].fx = cam.focal[0];
        state.intrinsics[name].fy = cam.focal[1];
        state.intrinsics[name].cx = cam.principal[0];
        state.intrinsics[name].cy = cam.principal[1];
        state.intrinsics[name].k1 = cam.distortion[0];
        state.intrinsics[name].k2 = cam.distortion[1];
        state.intrinsics[name].p1 = cam.distortion[2];
        state.intrinsics[name].p2 = cam.distortion[3];
        state.intrinsics[name].k3 = cam.distortion[4];

        // Update camera matrix
        state.intrinsics[name].cameraMatrix = [
            [cam.focal[0], 0, cam.principal[0]],
            [0, cam.focal[1], cam.principal[1]],
            [0, 0, 1]
        ];
        state.intrinsics[name].distCoeffs = [...cam.distortion];

        // Update extrinsics
        const R = quaternionToRotationMatrix(cam.rotation);
        state.extrinsics[name].R = R;
        state.extrinsics[name].tvec = [...cam.translation];
        state.extrinsics[name].rvec = matrixToRodrigues(R);

        calibLog(`applySbaResults: ${name} | fx=${cam.focal[0].toFixed(1)}, fy=${cam.focal[1].toFixed(1)}, T=[${cam.translation.map(v => v.toFixed(1)).join(', ')}]`);
    }

    const totalTime = performance.now() - startTime;
    calibLog(`applySbaResults: Complete in ${totalTime.toFixed(1)}ms`, 'success');
}
