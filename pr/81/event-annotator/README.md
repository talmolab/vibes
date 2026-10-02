# Video Event Annotator

https://vibes.tlab.sh/event-annotator/

Frame-accurate event segment annotation with track-level support, multi-row timeline, zoom/pan, and JSON export/import.

## Features

- Load local MP4/WebM videos (uses File System Access API when available)
- Load from URL with `?url=` query parameter support
- **Track-level annotation** - Load SLEAP `.slp` files and assign events to specific tracked subjects
- Frame-accurate navigation (arrow keys, Home/End)
- Hotkey-driven annotation (press to start, press again to commit)
- **Customizable event types** - add, edit, remove event types with custom names, colors, and hotkeys
- **Erase mode** - selectively remove or trim segments for specific event types
- Timeline with rows per event type × track combination
- Pose overlay visualization with track highlighting
- Click segments to select, Delete to remove
- Zoom/pan with mouse wheel, drag, pinch gestures
- Resizable canvas
- JSON export/import for annotations (includes event type definitions and track data)
- Debug log panel for troubleshooting

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Left/Right | Previous/Next frame |
| Ctrl+Left/Right | Jump 30 frames |
| Home/End | First/Last frame |
| Space | Play/Pause |
| +/- | Zoom in/out |
| Up/Down | Cycle through timeline rows (event type × track) |
| Tab/Shift+Tab | Cycle through tracks (keeps same event type) |
| 0-9 | Select track (0=frame-level, 1-9=tracks) |
| F | Toggle Focus Track mode |
| W, R, E | Event hotkeys (start/commit painting) |
| Z | Paint selected row (use after selecting with ↑/↓) |
| X | Erase selected event type |
| Escape | Cancel current annotation |
| Delete | Remove selected segment |

## Track-Level Annotation

When you load a SLEAP `.slp` file (via "Load SLP" button or `?slp=` URL parameter), the annotator enables track-aware features:

### Track Selection
- **Click on video** - Select the nearest track by clicking on an animal
- **Number keys (1-9)** - Quick select tracks by index
- **Key 0** - Select frame-level (no track assignment)
- **Up/Down arrows** - Cycle through timeline rows (event type × track)

### Timeline Organization
- Each event type gets a row per track: "Walking - Track 0", "Walking - Track 1", etc.
- Frame-level events (no track) appear as "Walking (frame-level)"
- **Focus Track** checkbox filters to show only the selected track's rows

### Erasing Events
1. Select a timeline row (click or use ↑/↓)
2. Press `X` to start erasing that specific event type
3. Navigate to define the erase range
4. Press `X` again to commit

The eraser only affects the selected event type on the selected track - other events are preserved.

## Data Model

```javascript
// Event types define what behaviors can be annotated
eventTypes: [
    { id: 'walking', name: 'Walking', hotkey: 'w', color: '#4ade80' },
    { id: 'running', name: 'Running', hotkey: 'r', color: '#60a5fa' },
    { id: 'eating', name: 'Eating', hotkey: 'e', color: '#f472b6' },
    { id: '_none', name: 'None', hotkey: 'x', color: '#666666', isEraser: true },
]

// Segments are the actual annotations
segments: [
    {
        id: 'uuid',
        eventTypeId: 'walking',
        startFrame: 100,
        endFrame: 250,
        trackIdx: 0  // null = frame-level, 0+ = specific track
    }
]

// Track data from SLP file
tracks: ['Track 0', 'Track 1', 'Track 2']
```

## Key Concepts

| Concept | Represents | Example |
|---------|------------|---------|
| **Event Type** | WHAT (behavior/action) | Walking, Running, Eating |
| **Segment** | WHEN (frame range) | frames 100-250 |
| **Track** | WHO (tracked subject) | "Track 0", "Track 1" |

## Event Overlap Rules

- **Different event types CAN overlap** - a mouse can walk and groom simultaneously
- **Same event type + same track merges** - overlapping "walking" segments on Track 0 combine into one
- **Same event type on different tracks are independent** - Track 0 walking and Track 1 walking are separate
- **Each (event type × track) gets its own timeline row** - visual clarity, no ambiguity

## Segment Editing

| Action | How |
|--------|-----|
| Create segment | Press hotkey to start, navigate, press again to commit |
| Create on selected row | Select row with ↑/↓, press Z to paint, navigate, Z again |
| Remove segment | Click to select, press Delete |
| Erase range | Select row, press X, navigate, X again (trims/splits segments) |
| Adjust boundaries | Delete and re-annotate, or use erase to trim |
| Cancel in-progress | Press Escape |

## URL Parameters

- `?url=VIDEO_URL` - Load video from URL
- `?slp=SLP_URL` - Load SLEAP pose data from URL

Example: `https://vibes.tlab.sh/event-annotator/?url=https://example.com/video.mp4&slp=https://example.com/poses.slp`

## Export Format

```json
{
  "videoFile": "mice.mp4",
  "totalFrames": 1410,
  "fps": 47.0,
  "tracks": ["Track 0", "Track 1"],
  "hasPoseData": true,
  "slpFile": "mice.tracked.slp",
  "eventTypes": [...],
  "segments": [
    { "id": "uuid", "eventTypeId": "walking", "startFrame": 100, "endFrame": 200, "trackIdx": 0 }
  ],
  "exportedAt": "2025-12-26T..."
}
```

## TODO

### Future Work

- Drag segment edges to resize
- Playback speed control
- Undo/redo
- Support for multi-subject events (e.g., "Track 0 and Track 1 are fighting")
