# Pixel Scale Tool

**[Launch Tool](https://vibes.tlab.sh/pixel-scale-tool/)** | [Source](index.html)

Browser-based tool for converting pixel measurements to real-world units (cm, mm, etc.) using reference points in your video or image.

## Features

- Load video or image files directly in browser
- Click two points on a known reference (ruler, cage edge, arena wall)
- Enter real-world distance to calculate scale factor
- Frame-by-frame navigation for videos
- Copy generated Python code for use in analysis scripts
- Supports cm, mm, m, and inches

## Usage

1. **Load** a video or image file
2. **Click two points** on something with a known real-world distance
3. **Enter the distance** (e.g., "30 cm")
4. **Copy** the generated Python code

## Output

The tool generates ready-to-use Python code:

```python
# Pixel Scale Calibration
# Reference: 30 cm = 450.5 pixels

px_per_cm = 15.0167
cm_per_px = 0.066593

def px_to_cm(pixels):
    return pixels / px_per_cm

def cm_to_px(cm):
    return cm * px_per_cm
```

## Controls

| Action | Description |
|--------|-------------|
| Click | Place reference point (2 points needed) |
| Reset Points | Clear current points and start over |
| Previous/Next Frame | Navigate video frames |

## Dependencies

None - runs entirely in browser using native APIs.
