# Pose Subspace Trip

**Live:** https://vibes.tlab.sh/pose-subspace-trip/

A trippy variant of [Pose Subspace Analysis](../pose-subspace-analysis/). Instead of plotting your pose on a 2D PCA scatter, the PCA projection of your live pose **drives a real-time 3D visualization** — you control the trip with your body.

Capture a few extreme poses to define your control axes (the principal components of your captured pose set). Then move through that subspace and watch the scene transform: orbit, fold, twist, recolor, zoom, and re-symmetrize in response to where your body sits in pose-space.

## How it works

1. **Capture** — MediaPipe detects your body/hand keypoints; capture 3+ distinct poses.
2. **Subspace** — PCA (power iteration) finds up to 6 principal components of your captured poses. These become your control axes.
3. **Project** — every frame, your live pose is projected onto the subspace and each coordinate is normalized by the spread of the training poses (so a "normal" range of motion maps to roughly ±1).
4. **Drive** — the 6 normalized coordinates are smoothed and used to parametrize the chosen visualization.

## Visualizations

Switch with the **Visualization** selector:

### Pose Constellation (default)

Your keypoints become **3D point-sources** — glowing nodes joined by neon edges, projected in real perspective. Rather than an abstract field, this is your actual skeleton rendered in 3D, then transformed by your PCA subspace:

| Axis | Transform |
|------|-----------|
| PC1 · orbit | 3D rotation of the figure (yaw) over time |
| PC2 · fold | recursive nesting — your skeleton repeated at shrinking scales |
| PC3 · twist | helical twist (joints rotate by their height) + inter-copy rotation |
| PC4 · color | hue of the constellation |
| PC5 · zoom | camera dolly (focal length) |
| PC6 · symmetry | kaleidoscopic mandala — N rotated copies of your body |

Motion-trail feedback gives moving poses a luminous wake.

### Fractal Hyperspace

The PCA coordinates feed a WebGL fragment shader that ray-marches a [mandelbox](https://en.wikipedia.org/wiki/Mandelbox) fractal through a kaleidoscope:

| Axis | Shader parameter |
|------|------------------|
| PC1 · orbit | camera orbit angle around the fractal |
| PC2 · fold | mandelbox scale (fractal density/structure) |
| PC3 · twist | per-iteration rotation of folding space |
| PC4 · color | palette hue shift + kaleidoscope segment count |
| PC5 · zoom | camera distance / dolly + roll |
| PC6 · symmetry | sphere-fold radius (how tight the folds pull in) |

Before you capture 3 poses, both visualizations run an **idle animation** and respond to a generic fallback signal (body centroid, size, and spread), so they're interactive immediately — but the real expressiveness comes from your custom PCA axes.

## Controls

- **Start Camera / Stop / Capture Pose** — webcam control and pose collection
- **Track** — Body, Left Hand, Right Hand, or Both Hands
- **Features** — Keypoints (normalized coords), Distances (pairwise), or Angles (pairwise) — the representation PCA is computed on
- **Display** — Video + Keypoints (default; live webcam with a colored skeleton overlay) or Point Light (white Gaussian glows on black)
- **Model** — MediaPipe complexity: Lite (fast, default) / Full / Heavy
- **Sens.** — how far a given pose change pushes the visualization
- **Smooth** — temporal smoothing of the control signal (low = snappy, high = flowy)
- **Visualization** — Pose Constellation (default) or Fractal Hyperspace
- **Quality** — internal render resolution scale (Low/Medium/High) for performance
- **⛶ Fullscreen** — expand the visualization canvas

The six bars under the gallery show your live position along each control axis in real time.

## Tips

- Capture poses that are **as different as possible** (arms up, crouched, leaning left/right, hands together/apart). The more spread in your captured set, the more distinct the control axes.
- **Hands mode** is great for fine, expressive control with a single hand.
- Higher **Sens.** + lower **Smooth** = chaotic; lower **Sens.** + higher **Smooth** = meditative.

## Technical details

- **Detection:** MediaPipe `PoseLandmarker` + `HandLandmarker` (`@mediapipe/tasks-vision@0.10.14`)
- **PCA:** power iteration with Gram-Schmidt orthogonalization, top 6 components; per-axis normalization by training-projection standard deviation
- **Pose Constellation:** Canvas 2D — keypoints centered and rotated in 3D, perspective-projected, then replicated into recursive + rotational copies; additive glow sprites with motion-trail feedback
- **Fractal Hyperspace:** raw WebGL1 fullscreen-triangle fragment shader, ray-marched mandelbox distance estimator with kaleidoscopic domain folding and an [iq cosine palette](https://iquilezles.org/articles/palettes/)
- Everything runs locally in the browser; no data leaves your machine

## Dependencies (CDN)

- [@mediapipe/tasks-vision@0.10.14](https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs) — pose and hand detection

## Initial prompt

> create a variant of the pca pose subspace one where instead of simple PCA proj, use it to parametrize a super trippy 3d visualization that you control with your pose
