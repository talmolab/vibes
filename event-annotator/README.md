# Video Event Annotator

https://vibes.tlab.sh/event-annotator/

Frame-accurate event segment annotation with multi-row timeline, zoom/pan, and JSON export/import.

## Features

- Load local MP4/WebM videos (uses File System Access API when available)
- Load from URL with `?url=` query parameter support
- Frame-accurate navigation (arrow keys, Home/End)
- Hotkey-driven annotation (press to start, press again to commit)
- Timeline with one row per event type (events CAN overlap across types)
- Click segments to select, Delete to remove
- Zoom/pan with mouse wheel, drag, pinch gestures
- Resizable canvas
- JSON export/import for annotations
- Debug log panel for troubleshooting

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Left/Right | Previous/Next frame |
| Ctrl+Left/Right | Jump 30 frames |
| Home/End | First/Last frame |
| Space | Play/Pause |
| Up/Down | Zoom in/out |
| W R E | Start/end event annotation |
| Escape | Cancel current annotation |
| Delete | Remove selected segment |

## Design

### Data Model

```javascript
// Event types define what behaviors can be annotated
eventTypes: [
    { id: 'walking', name: 'Walking', hotkey: 'w', color: '#4ade80' },
    { id: 'running', name: 'Running', hotkey: 'r', color: '#60a5fa' },
    { id: 'eating', name: 'Eating', hotkey: 'e', color: '#f472b6' },
]

// Segments are the actual annotations
segments: [
    {
        id: 'uuid',
        eventTypeId: 'walking',
        startFrame: 100,
        endFrame: 250,
        subjectId: null  // null = frame-level event, or ID for subject-assigned
    }
]
```

### Key Concepts

| Concept | Represents | Example |
|---------|------------|---------|
| **Event Type** | WHAT (behavior/action) | Walking, Running, Eating |
| **Segment** | WHEN (frame range) | frames 100-250 |
| **Subject** | WHO (optional, future) | "Mouse A", "Person 1" |

### Event Overlap Rules

- **Different event types CAN overlap** - a person can walk and chew gum simultaneously
- **Same event type merges** - overlapping "walking" segments combine into one
- **Each event type gets its own timeline row** - visual clarity, no ambiguity

### Segment Editing

| Action | How |
|--------|-----|
| Create segment | Press hotkey to start, navigate, press again to commit |
| Remove segment | Click to select, press Delete |
| Adjust boundaries | Delete and re-annotate (drag-to-resize is future work) |
| Cancel in-progress | Press Escape |

### Why No Global Eraser?

Since events can overlap (walking + eating at the same time), a "paint to erase"
mode would be ambiguous - which events should it erase? Instead:

- **Select + Delete** for removing specific segments
- **Clear All** button for bulk removal
- **Future: drag segment edges** to resize

### Future: Subject Assignment

When detection data is available (poses, bboxes, masks), segments can be
assigned to specific subjects:

```javascript
// Frame-level event (no subject)
{ eventTypeId: 'walking', startFrame: 10, endFrame: 50, subjectId: null }

// Subject-assigned event
{ eventTypeId: 'walking', startFrame: 10, endFrame: 50, subjectId: 'mouse_a' }
```

The UI would then allow grouping/filtering by subject:

```
[Frame-level Events]
  Walking   [████]
  Eating         [████]

Mouse A (detection)
  Walking   [██████]
  Running        [████]

Mouse A + Mouse B (interaction)
  Fighting       [████]
```

### Future: Detection Integration

Planned support for spatial annotations:

| Detection Type | Data |
|----------------|------|
| Bounding Box | `{ x, y, width, height }` |
| Keypoints/Pose | `[{ name, x, y, confidence }, ...]` |
| Centroid | `{ x, y }` |
| Segmentation Mask | `{ rle: '...' }` or polygon |

These would enable:
- **Undirected events**: "Mouse A is walking"
- **Directed events**: "Person X is holding Object Y"
- **Multi-subject events**: "Mouse A and B are fighting"

## Initial Prompt

> Build a video event segment annotator as a new vibe. It should:
>
> ### Event Annotation Features
>
> 1. **Multiple Event Types**
>    - Support defining multiple event types (e.g., "walking", "running", "eating")
>    - Each event type can have its own hotkey for quick annotation
>    - Event types are non-mutually exclusive (can overlap)
>
> 2. **Multi-Track Timeline**
>    - Different event types should be organized into separate tracks
>    - Timeline visualization showing temporal segments for each track
>    - Events within the same track cannot overlap, but events across tracks can
>
> 3. **Frame-Accurate Annotation Workflow**
>    - Press a hotkey to denote the **start frame** of an event
>    - Use play or arrow keys to navigate to the **end frame**
>    - Press the same hotkey again to **finalize** the event segment
>    - While "painting" is enabled, show a **marquee** around the growing event segment
>
> ### Future Detection Support
>
> The system should be designed to later support:
>
> 1. **Detections** (per-frame annotations with spatial components):
>    - Poses (keypoint sets)
>    - Bounding boxes
>    - Centroids
>    - Segmentation masks
>
> 2. **Subject/Object Assignment**:
>    - Assign events to specific detected subjects/objects
>    - **Undirected events**: e.g., "Animal A [bounding box] is walking [event type]"
>    - **Directed events**: e.g., "Person X [keypoints] is holding [event type] Object Y [segmentation mask]"
>    - **Multi-subject events**: e.g., "Animal A [keypoints] and B [keypoints] are fighting [event type]"
