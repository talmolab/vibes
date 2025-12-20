# Video Event Annotator

https://vibes.tlab.sh/event-annotator/

Frame-accurate event segment annotation with multi-track timeline, zoom/pan, and JSON export/import.

## Features

- Load local MP4/WebM videos
- Frame-accurate navigation (arrow keys, Home/End)
- Hotkey-driven annotation (W=Walking, R=Running, E=Eating, X=Eraser)
- Multi-track timeline visualization with segment overlap handling
- Click segments to select, Delete to remove
- Zoom/pan with mouse wheel, drag, pinch gestures
- Resizable canvas
- JSON export/import for annotations

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Left/Right | Previous/Next frame |
| Ctrl+Left/Right | Jump 30 frames |
| Home/End | First/Last frame |
| Space | Play/Pause |
| Up/Down | Zoom in/out |
| W R E | Start/end event annotation |
| X | Eraser mode |
| Escape | Cancel current annotation |
| Delete | Remove selected segment |

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
> 4. **"No Event" Eraser Mode**
>    - Special event type that works like an eraser
>    - Has a **black marquee** while active
>    - "Eats away" at the ends of other event segments in the current track
>    - Effectively removes portions of existing events
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
>    - **Directed events**: e.g., "Person X [keypoints] is holding Object Y [segmentation mask]"
>    - **Multi-subject events**: e.g., "Animal A and B are fighting"
