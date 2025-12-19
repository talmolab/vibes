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
    const src = cv.matFromImageData(imageData);
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    // Create detector
    const { board, dictionary } = createCharucoBoard(config);
    const detectorParams = new cv.aruco_DetectorParameters();
    const refineParams = new cv.aruco_RefineParameters(10.0, 3.0, true);
    const detector = new cv.aruco_ArucoDetector(dictionary, detectorParams, refineParams);

    // Detect ArUco markers first
    const markerCorners = new cv.MatVector();
    const markerIds = new cv.Mat();
    const rejectedCandidates = new cv.MatVector();

    detector.detectMarkers(gray, markerCorners, markerIds, rejectedCandidates);

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
    if (numMarkers > 0) {
        const charucoCorners = new cv.Mat();
        const charucoIds = new cv.Mat();

        const charucoParams = new cv.aruco_CharucoParameters();
        const charucoDetector = new cv.aruco_CharucoDetector(board, charucoParams, detectorParams, refineParams);

        charucoDetector.detectBoard(gray, charucoCorners, charucoIds, markerCorners, markerIds);

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
        const success = cv.solvePnP(objectPoints, imagePoints, cameraMatrix, distCoeffs, rvec, tvec);

        if (!success) {
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
    const covisibleFrames = graph[refViewName][targetViewName];
    if (covisibleFrames.length === 0) return null;

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

    return { R, rvec: avgRvec, tvec: avgTvec, rmsError: tStd, framesUsed: relativePoses.length };
}

// ============================================
// Triangulation
// ============================================

/**
 * Triangulate a 3D point from multiple 2D observations using DLT
 * Uses svd-js library for SVD computation
 */
function triangulatePoint(observations, intrinsics, extrinsics) {
    if (observations.length < 2) return null;

    const rows = [];

    for (const obs of observations) {
        const intr = intrinsics[obs.camera];
        const extr = extrinsics[obs.camera];
        if (!intr || !extr) continue;

        const K = intr.cameraMatrix;
        const R = extr.R;
        const t = extr.tvec;

        // Projection matrix P = K * [R | t]
        const P = [
            [K[0][0] * R[0][0] + K[0][1] * R[1][0] + K[0][2] * R[2][0],
             K[0][0] * R[0][1] + K[0][1] * R[1][1] + K[0][2] * R[2][1],
             K[0][0] * R[0][2] + K[0][1] * R[1][2] + K[0][2] * R[2][2],
             K[0][0] * t[0] + K[0][1] * t[1] + K[0][2] * t[2]],
            [K[1][0] * R[0][0] + K[1][1] * R[1][0] + K[1][2] * R[2][0],
             K[1][0] * R[0][1] + K[1][1] * R[1][1] + K[1][2] * R[2][1],
             K[1][0] * R[0][2] + K[1][1] * R[1][2] + K[1][2] * R[2][2],
             K[1][0] * t[0] + K[1][1] * t[1] + K[1][2] * t[2]],
            [K[2][0] * R[0][0] + K[2][1] * R[1][0] + K[2][2] * R[2][0],
             K[2][0] * R[0][1] + K[2][1] * R[1][1] + K[2][2] * R[2][1],
             K[2][0] * R[0][2] + K[2][1] * R[1][2] + K[2][2] * R[2][2],
             K[2][0] * t[0] + K[2][1] * t[1] + K[2][2] * t[2]]
        ];

        const x = obs.point.x;
        const y = obs.point.y;

        rows.push([x * P[2][0] - P[0][0], x * P[2][1] - P[0][1], x * P[2][2] - P[0][2], x * P[2][3] - P[0][3]]);
        rows.push([y * P[2][0] - P[1][0], y * P[2][1] - P[1][1], y * P[2][2] - P[1][2], y * P[2][3] - P[1][3]]);
    }

    if (rows.length < 4) return null;

    try {
        const { u, v, q } = SVDJS.SVD(rows);

        let minIdx = 0;
        let minVal = q[0];
        for (let i = 1; i < q.length; i++) {
            if (q[i] < minVal) {
                minVal = q[i];
                minIdx = i;
            }
        }

        const X = v[0][minIdx];
        const Y = v[1][minIdx];
        const Z = v[2][minIdx];
        const W_h = v[3][minIdx];

        if (Math.abs(W_h) < 1e-10) return null;

        return { x: X / W_h, y: Y / W_h, z: Z / W_h };
    } catch (e) {
        return null;
    }
}

/**
 * Project a 3D point to a camera
 */
function projectPoint(point3D, camera, intrinsics, extrinsics) {
    const intr = intrinsics[camera];
    const extr = extrinsics[camera];
    if (!intr || !extr) return null;

    const K = intr.cameraMatrix;
    const R = extr.R;
    const t = extr.tvec;
    const d = intr.distCoeffs;

    // Transform to camera coordinates
    const X_cam = [
        R[0][0] * point3D.x + R[0][1] * point3D.y + R[0][2] * point3D.z + t[0],
        R[1][0] * point3D.x + R[1][1] * point3D.y + R[1][2] * point3D.z + t[1],
        R[2][0] * point3D.x + R[2][1] * point3D.y + R[2][2] * point3D.z + t[2]
    ];

    if (X_cam[2] <= 0) return null;

    // Normalized coordinates
    const x_n = X_cam[0] / X_cam[2];
    const y_n = X_cam[1] / X_cam[2];

    // Apply distortion
    const r2 = x_n * x_n + y_n * y_n;
    const r4 = r2 * r2;
    const r6 = r4 * r2;
    const k1 = d[0], k2 = d[1], p1 = d[2], p2 = d[3], k3 = d[4];

    const radial = 1 + k1 * r2 + k2 * r4 + k3 * r6;
    const x_d = x_n * radial + 2 * p1 * x_n * y_n + p2 * (r2 + 2 * x_n * x_n);
    const y_d = y_n * radial + p1 * (r2 + 2 * y_n * y_n) + 2 * p2 * x_n * y_n;

    // Project to pixel coordinates
    const u = K[0][0] * x_d + K[0][2];
    const v = K[1][1] * y_d + K[1][2];

    return { x: u, y: v };
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
    const exportData = generateSbaJsonOutput(state, viewNames, config);
    if (!exportData) return null;

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

/**
 * Apply SBA results back to calibration state
 * @param {Object} sbaResult - Result from SBA solver
 * @param {Object} state - Global state to update
 * @param {Array} cameraNames - Array of camera names
 */
function applySbaResults(sbaResult, state, cameraNames) {
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
    }
}
