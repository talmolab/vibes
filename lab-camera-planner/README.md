# Lab Camera Planner

**https://vibes.tlab.sh/lab-camera-planner/**

Plan your lab camera setup: compare DJI Action 6, GoPro HERO 13, and Basler ace 2 side-by-side, calculate FOV and mounting distance, and get personalized recommendations for animal tracking experiments.

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

## Human-scale setups

The tool was built around rodent arenas but the optics are scale-free, so it also plans
human-subject rigs (interaction studies, gait, clinical recording):

- **Distance range** adapts to the computed working distance instead of a fixed 200 cm ceiling
- **Target feature** selector replaces the raw "animal width" field. Each preset carries its own
  pixel thresholds, because "enough pixels" means something different per measure:

  | Target | Width | Usable | Comfortable | For |
  |---|---|---|---|---|
  | Mouse body | 3 cm | 15 px | 30 px | SLEAP |
  | Rat body | 6 cm | 15 px | 30 px | SLEAP |
  | Human torso | 50 cm | 125 px | 250 px | body pose |
  | Human hand | 19 cm | 40 px | 100 px | hand tracking |
  | Human head | 16 cm | 150 px | 240 px | face landmarks |
  | Inter-ocular | 6.3 cm | 60 px | 95 px | facial AUs / gaze |

- **Arena presets** for head-and-shoulders, one seated person, a seated dyad, consult and exam
  rooms, and a walking path
- **Oblique (wall/corner) mounting** option. The math still assumes a plane perpendicular to the
  optical axis, so the tool flags that real coverage is a trapezoid and you should evaluate at
  the distance to the farthest subject
- **Basler lens ladder** extended both ways — 2.8/3.5/4/5 mm for small rooms, 25/35/50 mm for
  detail tiers — and the multi-camera planner now takes any lens rather than assuming 6 mm
- **"Lens fit" reverse lookup**: given the distance you actually have, the longest focal length
  that still frames the volume. In a small room the distance is fixed and the lens is the free
  variable, which is the inverse of the question the tool originally answered
- Lenses under 6 mm carry a barrel-distortion and C-mount/image-circle warning

Rodent defaults are unchanged: the target selector opens on "Mouse body" with the original
15/30 px SLEAP thresholds.

## Room 445 planner

The **Room 445** tab (open directly with `#room`) plans a specific rig: 15 Basler a2A1920-165g5c
cameras around two seated participants facing each other in the Empathy & Compassion Center
room (210 × 304 cm). Unlike the other tabs it models the room in 3D:

- A seated body model (19 keypoints per person, plus torso/head/limb and chair volumes) placed
  from the hip-to-hip spacing
- Each camera is a pinhole with a real look-at pose (position + aim target), so framing, oblique
  angles and foreshortening come out of the projection instead of a flat-plane approximation
- Per keypoint: in frame, occluded (by the other person, own limbs or chairs), and px/cm
- Faces: pixels between the eyes as they actually project, plus angle off frontal. A gaze/AU view
  needs ≤45° and ≥60 px (≥95 px comfortable)
- **Auto-fit**: the longest lens on the ladder that keeps each camera's target (a head box with
  room for motion, one person, both people, or legs + hands) in frame with an 8% margin
- Coverage matrix (views per keypoint group, per person), a simulated 1920×1200 frame for the
  selected camera, plan and side views with drag-to-move, depth of field at the chosen aperture
- Shopping list (lens counts), aggregate bandwidth, raw vs. encoded storage per hour
- The layout persists in localStorage; "Copy plan as text" exports it

Room geometry comes from a LiDAR point cloud of the room (9.9M points, 5 mm voxels), aligned to
the walls: 305 cm long, 210 cm wide by tape (the scan reads ~216 because of a few cm of wall
doubling from drift), a 273 cm drop ceiling on a 60 cm tile grid, an 84 × 205 cm door at the far end
of one long wall, the grey wall (outlets) opposite it, a 132 cm wall monitor at 120–195 cm on
one short wall, and a 28 × 22 cm full-height column in that wall's corner. The column and
monitor block views like any other object. A camera placed inside the column, the monitor, the
doorway or above the ceiling is flagged.

Default layout: 6 face cameras (3 per person, placed over the partner's head and on both side
walls at about 35°), 4 body cameras in the high corners, and 5 wide cameras (side walls high and
low, plus one looking straight down).

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
