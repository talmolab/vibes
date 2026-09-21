# Hand Dissection Lab

**Live:** https://vibes.tlab.sh/hand-dissection-lab/

A companion to [Pose Subspace Analysis](../pose-subspace-analysis/) that opens up the model itself.
Instead of treating hand tracking as a black box that emits 21 points, this runs MediaPipe's
**hand landmark network on its own** in raw TensorFlow.js, so you can watch its internal layers
respond to your hand, read kinematic features off the landmarks in real time, and compare a
hand-crafted pose subspace against the one the network learned for itself.

Everything runs locally in the browser. No video leaves your machine.

## The four panels

### 1. The network, standalone

MediaPipe's `HandLandmarker` task bundle gives you landmarks but no way inside. So this loads the
underlying **BlazeHand landmark network** directly as a TF.js graph model:

| | |
|---|---|
| Input | `1 × 256 × 256 × 3`, a wrist-aligned crop |
| Outputs | `[1, 63]` &mdash; 21 keypoints as (x, y, z) in crop pixels; `[1, 1]` &mdash; hand presence |
| Body | 45 ReLU activations in a 7-stage pyramid, 344 graph nodes |

MediaPipe still does the *tracking* (finding and following the hand), but the crop it produces is
fed to the standalone network, which predicts landmarks independently. Both skeletons are drawn on
the crop &mdash; magenta for MediaPipe, cyan for the standalone net &mdash; with their mean
disagreement reported in crop pixels. They should sit nearly on top of each other.

The crop is built the way the real BlazeHand pipeline builds it: rotated so the wrist &rarr; middle
knuckle axis points up, then squared off around the hand's extent. **Crop scale** widens or tightens
that box, which is a quick way to see how sensitive the network is to its framing &mdash; pull it in
too far and the landmarks degrade as the fingers leave the frame.

### 2. Layer Explorer

Pick any of the 45 ReLU layers and see every channel at once as a tiled heatmap.

| Stage | Resolution | Channels | Layers |
|---|---|---|---|
| 1 | 128&times;128 | 32 | 4 |
| 2 | 64&times;64 | 64 | 6 |
| 3 | 32&times;32 | 128 | 7 |
| 4 | 16&times;16 | 192 | 7 |
| 5 | 8&times;8 | 192 | 7 |
| 6 | 4&times;4 | 192 | 7 |
| 7 | 2&times;2 | 192 | 7 |

Early layers look like oriented edge and skin-tone detectors and track the silhouette of your hand.
By the middle stages the maps have become sparse and blobby, firing near particular joints. The last
stage is 2&times;2 &mdash; almost all spatial detail is gone, and what is left is the 768-number
summary the landmark head reads off.

- **Stage bars** above the mosaic show mean activation per stage, so you can watch energy move
  through the pyramid as you move.
- **Per channel** scaling normalises each tile to its own maximum (good for seeing what a weak
  channel is doing); **Shared** uses one scale across the layer (good for seeing which channels
  actually dominate).
- **Sort by energy** reorders tiles strongest-first, which makes it obvious how few channels carry
  most of the response.
- Hover any tile for its channel index, mean, and max.

The mosaic keeps its last frame when tracking drops out, so a **no hand &mdash; last frame**
badge appears over it rather than letting a stale activation map read as live.

On a wide screen the explorer spans two rows down the right-hand side, with Input above and the
Feature Scope below it on the left, so the layer mosaic and the kinematic traces stay visible
together. Below 1100px everything stacks into a single column.

### 3. Feature Scope

A lightweight realtime kinematic extractor reading straight off the landmarks each frame. Distances
are expressed in **palm-lengths** (wrist to middle knuckle), so they stay stable as you move toward
or away from the camera.

| Trace | What it is |
|---|---|
| Fingertip speed | Per-finger tip speed in palm-lengths/s, plus the mean across all 21 points |
| Finger curl | Mean flexion of each finger's three joints, 0 = straight, 1 = fully folded |
| Pinch aperture | Thumb tip to index tip distance |
| Finger spread | Mean angle between neighbouring finger directions |
| Palm roll | Orientation of the knuckle line in the image plane |

The same features are drawn on the hand itself: **speed** as per-keypoint velocity arrows and
fingertip trails, **angles** as arcs at each joint tinted by flexion. **Speed smoothing** sets the
exponential smoothing on the velocity estimates &mdash; low is twitchy and responsive, high is
readable but lags.

Joint flexion uses the wrist as the proximal reference for the knuckle angle, so MCP flexion is
measured relative to the palm rather than to an anatomical axis. Curl and the pairwise distances are
invariant to rotation, translation and scale; palm roll deliberately is not.

### 4. Pose Subspace

The part carried over from Pose Subspace Analysis, with the interesting addition. Capture a few
distinct hand shapes, then switch between three representations of the same captures:

| Representation | Dimensions |
|---|---|
| Geometric | 25 &mdash; 15 joint flexion angles + 10 pairwise fingertip distances |
| Pairwise distances | 210 &mdash; every landmark pair, palm-normalised |
| Learned embedding | 768 &mdash; the network's final 2&times;2&times;192 activation, flattened |

PCA runs on whichever you pick, and your live hand is projected into it as a pink dot with a trail.
The comparison is the point: hand-crafted geometry tends to concentrate variance in PC1 because the
features are highly correlated, while the learned embedding usually spreads it across more
components &mdash; it is encoding things the geometric features throw away, including appearance and
the network's own confidence.

Capture poses that are as different as you can make them; three is the minimum.

## Performance

The standalone network is an extra forward pass on top of MediaPipe's tracking, so it runs on its
own async cycle rather than blocking the camera loop &mdash; the tracker, overlays and feature scope
stay at camera rate while the dissection updates as fast as it can. The measured rate is shown in
the stats line. On a real GPU it comfortably keeps up; on software WebGL it drops to a couple of
hertz and the mosaic visibly lags your hand.

Activation mosaics are assembled **on the GPU** (normalise &rarr; tile &rarr; colormap via a 256-entry
LUT gather) so only the finished image is read back, rather than pulling up to 500k floats per frame
across the bus.

## Technical notes

- **Detection/tracking:** MediaPipe `HandLandmarker` (`@mediapipe/tasks-vision@0.10.14`)
- **Dissected model:** BlazeHand landmark net via `tf.loadGraphModel(..., {fromTFHub: true})`,
  tapped with `model.execute(input, [nodeNames])` on `StatefulPartitionedCall/model/activation_N/Relu`
- **PCA:** power iteration with Gram-Schmidt deflation; eigenvalues taken as the projected variance
  so explained-variance percentages are honest
- **Crop transform:** built with canvas transforms; the resulting `DOMMatrix` is inverted to map
  network landmarks back into video coordinates

## Dependencies (CDN)

- [@tensorflow/tfjs@4.22.0](https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js) &mdash; runs the standalone network
- [@mediapipe/tasks-vision@0.10.14](https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs) &mdash; hand tracking
- Hand landmark weights from `tfhub.dev/mediapipe/tfjs-model/handskeleton/1` (~8 MB, loaded once)

## Initial prompt

> take a look at pose subspace analysis, I want to build something based on it, showing some of the
> intermediate layer visualization and perhaps run a model that is only the hand? I am also curious
> if we can visualize some features like speed or angles, similar to a lightweight realtime feature
> extractor.
