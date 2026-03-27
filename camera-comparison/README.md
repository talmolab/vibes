# Camera Comparison

**https://vibes.tlab.sh/camera-comparison/**

Compare lab camera systems (DJI Action 6, GoPro HERO 13, Basler ace 2) with interactive FOV calculator, setup wizard, multi-cam planner, and distortion preview.

## Features

- Side-by-side specs comparison with best-in-class highlighting
- App & software ratings with real-world experience (DJI Mimo, GoPro Quik, Pylon + [Multi-Cam Sync](https://github.com/LeoMeow123/multi-cam-sync))
- Interactive FOV calculator with draggable camera, distance slider, arena presets, and comparison mode
- Animal tracking feasibility indicator (pixel count on body for SLEAP)
- Recording time estimator (file size, battery, thermal limits)
- Auto-generated setup checklist
- Camera recommendation wizard (7-step questionnaire with scoring)
- Multi-camera planner (drag cameras around arena, see coverage overlap)
- Interactive lens distortion comparison with per-mode presets (Wide/Linear) and custom k1/k2 input
- Pixel density heatmap in top-down view
- Export diagram as PNG
- Dark/light theme toggle
- Theory tutorial (FOV, GSD, shutter types, distortion, mounting)

## Camera specs

Verified from official sources: [dji.com](https://www.dji.com/osmo-action-6), [gopro.com](https://gopro.com/en/us/shop/cameras/buy/hero13black/CHDHX-131-master.html), [docs.baslerweb.com](https://docs.baslerweb.com/a2a1920-165g5mbas)

| | DJI Action 6 | GoPro HERO 13 | Basler a2A1920-165g5m |
|---|---|---|---|
| Sensor | 1/1.1" square | 1/1.9" | 1/2.3" IMX392 |
| Max res | 8K/30fps | 5.3K/30fps | 1920x1200/168fps |
| FOV | 155° | 156° | 58° (6mm lens) |
| Color | RGB 10-bit | RGB 10-bit | Mono 12-bit |
| Shutter | Rolling | Rolling | Global |
| Price | ~$436 | ~$359 | ~$985 + lens |

## Dependencies

None - runs entirely in browser using native APIs.
