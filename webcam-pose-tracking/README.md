# Webcam Pose Tracking

**Live:** https://vibes.tlab.sh/webcam-pose-tracking/

Real-time body pose estimation using MediaPipe's vision tasks directly in your browser.

## Features

- **Real-time pose detection** - Track body keypoints at 30+ FPS using your webcam
- **Multiple model options** - Choose between Lite (fast), Full (balanced), or Heavy (accurate) models
- **Skeleton visualization** - See body connections drawn in real-time
- **Hand tracking** - Optional detailed hand landmark detection with 21 keypoints per hand
- **Customizable display** - Toggle skeleton, keypoints, and hands independently
- **Mirror mode** - Video mirroring for a natural selfie-view experience
- **Performance stats** - Live FPS and keypoint count display
- **GPU acceleration** - Uses WebGPU/WebGL for hardware-accelerated inference
- **Privacy-first** - All processing happens locally in your browser, no data sent to servers

## Usage

1. Click "Start Camera" to request webcam access
2. Allow camera permissions when prompted
3. Your pose will be tracked in real-time with skeleton overlay
4. Adjust settings:
   - **Model**: Select speed vs accuracy tradeoff
   - **Show Skeleton**: Toggle body connection lines
   - **Show Points**: Toggle keypoint visualization
   - **Show Hands**: Enable detailed hand tracking (loads additional model)
   - **Mirror Video**: Toggle horizontal flip for selfie mode
5. Click "Stop Camera" to end the session

The pose detector tracks 33 body landmarks including face, torso, arms, and legs. Hand tracking adds 21 landmarks per hand when enabled.

## Initial prompt

The initial prompt for this vibe was not recorded. This README was reconstructed based on the implementation.
