# Pose Subspace Analysis

**Live:** https://vibes.tlab.sh/pose-subspace-analysis/

Interactive webcam-based tool for exploring pose and hand keypoint manifolds using real-time PCA visualization.

## Features

- **Live pose/hand detection** - MediaPipe Pose and Hand Landmarker models with configurable complexity (lite/full/heavy)
- **Multi-keypoint modes** - Track full body pose, individual hands (left/right), or both hands simultaneously
- **Display modes** - Standard video + skeleton overlay, or point-light display (Johansson-style white Gaussian glows on black, optional connections) for studying motion structure free of visual context
- **Frame capture** - Build training datasets from live webcam feed with visual gallery
- **Feature engineering** - Compute pairwise distances, pairwise angles, or normalized coordinates
- **Real-time PCA** - 2D subspace projection using power iteration algorithm with variance explained
- **Live pose matching** - Projects current pose onto learned subspace and shows closest training frame
- **Interactive visualization** - Hover over PCA scatter points to preview corresponding frames
- **Color-coded gallery** - Each captured frame assigned a unique color for easy tracking across plot and gallery
- **Flexible layout** - Full-width page with toggle between side-by-side panels and stacked (full-width video on top)

## Usage

1. Click **Start Camera** to enable webcam (models load automatically on first start)
2. Select keypoint mode (pose/left hand/right hand/both hands)
3. Choose model complexity (lite/full/heavy) - heavier models are more accurate but slower
4. Select feature type:
   - **Pairwise Distances** - All Euclidean distances between keypoint pairs (rotation/translation invariant)
   - **Pairwise Angles** - All angles between keypoint pairs (translation invariant)
   - **Normalized Keypoints** - Raw coordinates centered and scaled by bounding box
5. Choose **Display** mode:
   - **Video + Keypoints** (default) - colored skeleton on the live webcam image
   - **Point Light** - keypoints rendered as white Gaussian glows on black; toggle **Show connections** to show or hide skeleton lines
6. Optionally toggle **Stack panels (full-width video)** at the top of the page to switch between side-by-side and stacked layouts
7. **Capture Frame** to add current pose to training set (minimum 3 frames required for PCA)
8. Watch the PCA plot update in real-time:
   - Training frames shown as colored dots matching gallery borders
   - Live pose shown as pink dot
   - Closest training frame displays below plot
9. Hover over PCA scatter points to preview corresponding frames in tooltip
10. Remove unwanted frames by clicking the × button in gallery (colors auto-regenerate)

## Technical Details

### PCA Implementation

- Uses power iteration to compute top 2 principal components
- Orthogonalizes components using Gram-Schmidt
- Computes explained variance ratio for each PC
- Caches projections to avoid redundant computation during live tracking

### Feature Modes

- **Pairwise Distances**: `n(n-1)/2` distance features for `n` keypoints (invariant to rotation and translation)
- **Pairwise Angles**: `n(n-1)/2` angle features using `atan2(dy, dx)` (invariant to translation)
- **Normalized Keypoints**: `3n` features (x, y, z) after centering and scaling by max dimension

### Pose Matching

- Euclidean distance in 2D PCA space
- Updates at webcam frame rate (~30 fps)
- Displays closest training frame with overlaid keypoints

## Dependencies (CDN)

- [@mediapipe/tasks-vision@0.10.14](https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs) - Pose and hand detection

## Initial prompt

The initial prompt for this vibe was not recorded. This README was reconstructed based on the implementation.
