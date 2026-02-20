# Plan: Fix Drag Freeze + Labels Not Showing

## Bug 1: Node Drag Freeze After First Move

### Symptoms
- Click unlinked instance → highlighted (correct)
- Drag one node → node moves (correct)
- Release → instance stays highlighted (correct)
- Try to drag another node → **NOTHING HAPPENS** (BUG)
- Click empty space → deselects → can now drag again

### Root Cause Analysis
After extensive investigation, the most likely cause is **interference between the zoom handler's document-level event listeners and the interaction manager**:

1. **Zoom handler registers document-level `mousemove` and `mouseup` handlers** in `video.js:1197-1274`. These fire for ALL mouse events regardless of `stopPropagation()` on child elements... actually `stopPropagation()` DOES prevent bubbling to document. But there may be timing issues with event dispatch.

2. **Potential `leftDragPending` ghost state**: The zoom handler's closure variable `leftDragPending` could be set to `true` if any mousedown event leaks past `stopPropagation()` (race condition during redraw), causing subsequent mouse moves to trigger box-zoom mode, which creates a blocking overlay div.

3. **Assignment mode state complexity**: The `onMouseDown` handler has complex branching for assignment mode that could mask the drag start path in certain states.

### Fix Strategy

**A. Restructure zoom handler to use a global interaction lock** (`video.js`)
- Add `window.__mvguiInteractionActive` flag
- Check this flag in zoom handler's container mousedown AND document-level listeners
- Set the flag in interaction manager during drags

**B. Guard against stale drag state** (`interaction.js`)
- At the start of `onMouseDown`, check if `isDragging` is true and force `_endDrag()` cleanup
- This catches any scenario where mouseup was missed

**C. Simplify unlinked node mousedown path** (`interaction.js`)
- Make drag initiation UNCONDITIONAL for any node hit
- Assignment mode selection handled as side-effect only, never blocking drag

**D. Add diagnostic logging** (`interaction.js`)
- Log every mousedown: what was hit, what state was set
- Log every mousemove during drag: confirm drag is active
- Log mouseup: confirm drag cleanup

---

## Bug 2: Node Labels Not Showing on 2D Views

### Symptoms
- Labels checkbox checked (default on)
- Node names exist in skeleton
- Points exist on instances
- No labels visible on any 2D overlay view

### Root Cause Analysis
Labels in `drawSkeleton()` (for linked instances) are gated by `showLabels` option. Labels in `drawUnlinkedInstances()` are ALWAYS drawn (not gated by `showLabels`). The code paths look correct on paper.

Possible causes:
1. **Canvas coordinate mismatch**: If `videoWidth`/`videoHeight` don't match the actual video, the `toCanvas` transform could place labels off-screen
2. **Font rendering at very small scale**: If `scale` is very small, `Math.round(11 * scale)` could produce a font size of 0
3. **Labels drawn behind other elements**: The labels are drawn at alpha = 0.5 (unlinked instance alpha), making them nearly invisible

### Fix Strategy

**A. Make labels more robust** (`overlays.js`)
- Ensure minimum font size of 10px regardless of scale
- Draw labels with full opacity (override globalAlpha for label text)
- Add index-based fallback labels ("node 0", "node 1") when skeleton nodes don't have names
- Add a dark background rectangle behind each label for readability

**B. Verify rendering pipeline** (`index.html`)
- Confirm `showLabels` flows correctly from checkbox → drawAllOverlays → drawFrameOverlays → drawSkeleton
- Add console.log in drawFrameOverlays to verify showLabels value during debug

---

## Implementation Order

1. Fix drag freeze (interaction.js + video.js)
2. Fix labels (overlays.js)
3. Remove debug logging after confirming fixes work
