# Webcam Heart Rate

**Live:** https://vibes.tlab.sh/webcam-heart-rate/

Real-time heart rate estimation from your webcam using remote photoplethysmography (rPPG) via [vitallens.js](https://docs.rouast.com/js/). Built from the [Webcam Pose Tracking](../webcam-pose-tracking/) vibe, with the MediaPipe pose model swapped out for vitallens.

## Features

- **Live heart rate** - BPM readout with a pulsing heart and a confidence percentage, drawn over the video
- **Pulse waveform** - Scrolling PPG waveform strip (last 6 s) overlaid on the video
- **Face box** - Detected face region, colored by signal quality (green ≥80%, amber ≥50%, red below)
- **HR trend** - Heart rate history chart for the last 2 minutes
- **Method picker** - Local `POS`, `CHROM`, and `G` rPPG algorithms (no API key, nothing leaves the browser), or the `VitalLens API` (needs a free key from [rouast.com/api](https://www.rouast.com/api/)), which adds respiratory rate and HRV
- **Recording** - Save the annotated canvas (video + overlays) as MP4/WebM
- **Mirror mode** - Selfie-view flip
- **URL state** - `#pos`, `#chrom`, `#g`, or `#vitallens` preselects the method (the API key is never stored or put in the URL)

## Usage

1. Click "Start Camera" and allow camera access
2. Face the camera, hold still, and use even lighting
3. The first estimate appears after ~5 s of continuous face detection
4. Switch methods at any time; the estimator restarts

## Notes

- Uses `vitallens@0.4.5` from jsDelivr (pinned). The library runs face detection in a Web Worker and loads its model files relative to the CDN script.
- Local methods estimate heart rate only. Respiratory rate (after ~10 s) and HRV (after ~20 s) need the VitalLens API.
- In API mode, vitallens sends cropped, downscaled face frames to `api.rouast.com`. The API allows cross-origin requests (`access-control-allow-origin: *`), so it works directly from vibes.tlab.sh without the nocors proxy.
- Failures inside vitallens's prediction loop (e.g. a bad API key) are only `console.error`'d by the library, so the page intercepts `console.error` while running and shows the message under the video.
- For fun and general wellness only. Not a medical device.

## Initial prompt

> take the webcam pose demo and replace the pose stuff with this: https://docs.rouast.com/js/ for heart rate estimation in real time
