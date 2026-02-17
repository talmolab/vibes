/**
 * interaction.js - Mouse and keyboard interaction system for the multi-view
 * pose proofreading GUI.
 *
 * Handles node selection, dragging, instance conversion, and all user
 * interaction with the overlay canvases. Works with the data model classes
 * from pose-data.js (Skeleton, Camera, Instance, FrameGroup, InstanceGroup,
 * Session).
 *
 * All coordinates are kept in video pixel space for data consistency. The
 * overlay canvases have the same dimensions as the video, so the default
 * coordinate transform is 1:1 unless zoom/pan is applied via CSS transforms.
 *
 * No imports/exports - follows the vibes pattern of global scope scripts
 * loaded via script tags.
 */

// ============================================
// InteractionManager
// ============================================

class InteractionManager {
    /**
     * @param {Object} callbacks - Functions the interaction manager uses to
     *   communicate with the rest of the application.
     * @param {Function} callbacks.getState - Returns the current application
     *   state object. Expected shape:
     *   {
     *     currentFrame: number,
     *     session: Session,
     *     views: Array<{ name, overlayCanvas, videoWidth, videoHeight, zoom? }>,
     *   }
     * @param {Function} callbacks.getInstanceGroups - (frameIdx) => InstanceGroup[]
     *   Returns all instance groups for the given frame index.
     * @param {Function} callbacks.onSelectionChanged - (selectedInstanceGroup, selectedNodeIdx) => void
     *   Called whenever the selection state changes.
     * @param {Function} callbacks.onNodeMoved - (viewName, instanceGroup, nodeIdx, newPos) => void
     *   Called when a node drag operation completes. newPos is [u, v] in video coords.
     * @param {Function} callbacks.onInstanceConverted - (instanceGroup) => void
     *   Called after a predicted instance is converted to a user instance
     *   (double-click interaction).
     * @param {Function} callbacks.onNodeVisibilityToggled - (viewName, instanceGroup, nodeIdx) => void
     *   Called after a right-click toggles a node's visibility.
     * @param {Function} callbacks.requestRedraw - () => void
     *   Triggers a full overlay redraw across all views.
     */
    constructor(callbacks) {
        /** @type {Object} */
        this.callbacks = callbacks || {};

        // ------------------------------------------------------------------
        // Selection state
        // ------------------------------------------------------------------

        /** @type {InstanceGroup|null} Currently selected instance group */
        this.selectedInstanceGroup = null;

        /** @type {number} Currently selected node index (-1 = no node selected) */
        this.selectedNodeIdx = -1;

        /**
         * Node currently under the cursor, or null.
         * @type {{ viewName: string, instanceGroupIdx: number, nodeIdx: number }|null}
         */
        this.hoveredNode = null;

        // ------------------------------------------------------------------
        // Drag state
        // ------------------------------------------------------------------

        /** @type {boolean} Whether a drag is in progress */
        this.isDragging = false;

        /**
         * Details of the active drag, or null.
         * @type {{
         *   viewName: string,
         *   instanceGroupIdx: number,
         *   nodeIdx: number,
         *   startPos: number[],
         *   currentPos: number[]
         * }|null}
         */
        this.dragInfo = null;

        // ------------------------------------------------------------------
        // Assignment mode state
        // ------------------------------------------------------------------

        /** @type {boolean} Whether assignment mode is active */
        this.assignmentMode = false;

        /** @type {UnlinkedInstance[]} Currently selected unlinked instances for assignment */
        this.assignmentSelection = [];

        // ------------------------------------------------------------------
        // Hit-test configuration
        // ------------------------------------------------------------------

        /** @type {number} Maximum distance in video pixels for a hit-test match */
        this.hitThreshold = 12;

        // ------------------------------------------------------------------
        // Internal bookkeeping for attach/detach
        // ------------------------------------------------------------------

        /** @type {Map<string, Object>} viewName -> { handlers } */
        this._boundHandlers = new Map();

        /** @type {Function|null} Bound keydown handler (document-level) */
        this._keyHandler = null;
    }

    // ======================================================================
    // Coordinate transforms
    // ======================================================================

    /**
     * Convert mouse coordinates on an overlay canvas to video pixel
     * coordinates.
     *
     * Because the overlay canvas dimensions match the video dimensions the
     * default mapping is 1:1. When CSS zoom/pan transforms are applied
     * (view.zoom.scale, view.zoom.offsetX/Y) we need to undo them so the
     * returned coordinates are always in the original video pixel space.
     *
     * @param {number} canvasX - event.offsetX on the overlay canvas
     * @param {number} canvasY - event.offsetY on the overlay canvas
     * @param {string} viewName - Camera view name (e.g. 'back')
     * @returns {number[]} [videoX, videoY] in video pixel coordinates
     */
    canvasToVideo(canvasX, canvasY, viewName) {
        const state = this._getState();
        if (!state) return [canvasX, canvasY];

        const view = this._findView(state, viewName);
        if (!view) return [canvasX, canvasY];

        const canvas = view.overlayCanvas;
        if (!canvas) return [canvasX, canvasY];

        // event.offsetX/offsetY are in the element's LOCAL coordinate space
        // (the browser applies the inverse CSS transform automatically).
        // We need to convert from CSS layout pixels to canvas intrinsic
        // coordinates (= video pixel space).
        //
        // Use offsetWidth/offsetHeight (CSS layout size, EXCLUDES CSS
        // transforms) instead of getBoundingClientRect() (which INCLUDES
        // transforms and would give wrong ratios when zoomed).
        const cssW = canvas.offsetWidth;
        const cssH = canvas.offsetHeight;
        if (cssW === 0 || cssH === 0) return [canvasX, canvasY];

        const videoX = canvasX * (canvas.width / cssW);
        const videoY = canvasY * (canvas.height / cssH);
        return [videoX, videoY];
    }

    // ======================================================================
    // Hit testing
    // ======================================================================

    /**
     * Find the nearest visible node to the given video-space position in a
     * specific camera view at a given frame.
     *
     * Searches through all instance groups at frameIdx for the given view
     * and returns the closest non-null point within the hit threshold.
     *
     * @param {number} videoX - X coordinate in video pixels
     * @param {number} videoY - Y coordinate in video pixels
     * @param {string} viewName - Camera view name
     * @param {number} frameIdx - Frame index
     * @returns {{
     *   instanceGroupIdx: number,
     *   instanceGroup: InstanceGroup,
     *   instanceIdx: number,
     *   nodeIdx: number,
     *   distance: number,
     * }|null} The nearest hit, or null if nothing is within threshold.
     */
    findNearestNode(videoX, videoY, viewName, frameIdx) {
        const groups = this._getInstanceGroups(frameIdx);
        if (!groups || groups.length === 0) return null;

        // Compute a scale-aware hit threshold. The base threshold (12) is
        // in CSS pixels. Convert to video pixels so the clickable area
        // feels consistent regardless of the display size.
        // Use offsetWidth (excludes CSS transforms) for correct ratio when zoomed.
        let threshold = this.hitThreshold;
        const state = this._getState();
        if (state) {
            const view = this._findView(state, viewName);
            if (view && view.overlayCanvas) {
                const cssW = view.overlayCanvas.offsetWidth;
                if (cssW > 0) {
                    const cssToVideo = view.overlayCanvas.width / cssW;
                    threshold = this.hitThreshold * cssToVideo;
                }
            }
        }

        let best = null;
        let bestDist = threshold;

        for (let g = 0; g < groups.length; g++) {
            const group = groups[g];
            const instance = group.getInstance(viewName);
            if (!instance || !instance.points) continue;

            for (let n = 0; n < instance.points.length; n++) {
                const pt = instance.points[n];
                if (pt == null) continue;

                const dx = pt[0] - videoX;
                const dy = pt[1] - videoY;
                const dist = Math.sqrt(dx * dx + dy * dy);

                if (dist < bestDist) {
                    bestDist = dist;
                    best = {
                        instanceGroupIdx: g,
                        instanceGroup: group,
                        instanceIdx: g, // index within the groups array
                        nodeIdx: n,
                        distance: dist,
                    };
                }
            }
        }

        return best;
    }

    /**
     * Find the nearest unlinked instance node to the given video-space position.
     *
     * @param {number} videoX
     * @param {number} videoY
     * @param {string} viewName
     * @param {number} frameIdx
     * @returns {{ unlinked: UnlinkedInstance, nodeIdx: number, distance: number }|null}
     */
    findNearestUnlinkedNode(videoX, videoY, viewName, frameIdx) {
        const state = this._getState();
        if (!state || !state.session) return null;

        const fg = state.session.getFrameGroup(frameIdx);
        if (!fg) return null;

        const unlinkedList = fg.getUnlinkedInstances(viewName);
        if (!unlinkedList || unlinkedList.length === 0) return null;

        // Compute threshold (use offsetWidth to exclude CSS transforms)
        let threshold = this.hitThreshold;
        const view = this._findView(state, viewName);
        if (view && view.overlayCanvas) {
            const cssW = view.overlayCanvas.offsetWidth;
            if (cssW > 0) {
                const cssToVideo = view.overlayCanvas.width / cssW;
                threshold = this.hitThreshold * cssToVideo;
            }
        }

        let best = null;
        let bestDist = threshold;

        for (let u = 0; u < unlinkedList.length; u++) {
            const ul = unlinkedList[u];
            const points = ul.instance.points;
            if (!points) continue;

            for (let n = 0; n < points.length; n++) {
                const pt = points[n];
                if (pt == null) continue;

                const dx = pt[0] - videoX;
                const dy = pt[1] - videoY;
                const dist = Math.sqrt(dx * dx + dy * dy);

                if (dist < bestDist) {
                    bestDist = dist;
                    best = {
                        unlinked: ul,
                        nodeIdx: n,
                        distance: dist,
                    };
                }
            }
        }

        return best;
    }

    // ======================================================================
    // Assignment mode
    // ======================================================================

    /**
     * Toggle assignment mode on/off.
     * @param {boolean} [enabled] - Force on/off; omit to toggle
     */
    setAssignmentMode(enabled) {
        if (enabled === undefined) enabled = !this.assignmentMode;
        this.assignmentMode = enabled;
        if (!enabled) {
            this.assignmentSelection = [];
        }
        this._requestRedraw();
    }

    /**
     * Add an unlinked instance to the assignment selection.
     * Only allows one selection per camera view.
     * @param {UnlinkedInstance} unlinked
     */
    addToAssignmentSelection(unlinked) {
        // Check if we already have one from this camera
        for (let i = 0; i < this.assignmentSelection.length; i++) {
            if (this.assignmentSelection[i].cameraName === unlinked.cameraName) {
                // Replace it
                this.assignmentSelection[i] = unlinked;
                this._requestRedraw();
                return;
            }
        }
        this.assignmentSelection.push(unlinked);
        this._requestRedraw();
    }

    /**
     * Get the IDs of currently selected unlinked instances for assignment.
     * @returns {number[]}
     */
    getAssignmentSelectedIds() {
        return this.assignmentSelection.map(function (ul) { return ul.id; });
    }

    // ======================================================================
    // Selection
    // ======================================================================

    /**
     * Select an instance group and optionally a specific node.
     *
     * @param {InstanceGroup|null} instanceGroup - The group to select, or
     *   null to clear.
     * @param {number} [nodeIdx=-1] - Node index to select, or -1 for none.
     */
    select(instanceGroup, nodeIdx) {
        if (nodeIdx === undefined) nodeIdx = -1;

        const changed = (
            this.selectedInstanceGroup !== instanceGroup ||
            this.selectedNodeIdx !== nodeIdx
        );

        this.selectedInstanceGroup = instanceGroup;
        this.selectedNodeIdx = nodeIdx;

        if (changed && this.callbacks.onSelectionChanged) {
            this.callbacks.onSelectionChanged(this.selectedInstanceGroup, this.selectedNodeIdx);
        }
    }

    /**
     * Clear the current selection entirely.
     */
    clearSelection() {
        this.select(null, -1);
    }

    // ======================================================================
    // Mouse event handlers
    // ======================================================================

    /**
     * Handle mousedown on an overlay canvas.
     *
     * - Left click on node: select the instance group + node, begin drag.
     * - Left click on empty area: clear selection.
     * - Double-click on a predicted instance: convert to user instance.
     * - Right-click on a node: toggle node visibility (null <-> restore).
     *
     * @param {MouseEvent} e
     * @param {string} viewName
     */
    onMouseDown(e, viewName) {
        const state = this._getState();
        if (!state) return;

        const [vx, vy] = this.canvasToVideo(e.offsetX, e.offsetY, viewName);
        const frameIdx = state.currentFrame;

        // --- Right-click: toggle node visibility ---
        if (e.button === 2) {
            e.preventDefault();
            const hit = this.findNearestNode(vx, vy, viewName, frameIdx);
            if (hit) {
                this._toggleNodeVisibility(viewName, hit.instanceGroup, hit.nodeIdx);
            }
            return;
        }

        // --- Left click ---
        if (e.button !== 0) return;

        // --- Double-click: convert predicted -> user ---
        if (e.detail === 2) {
            const hit = this.findNearestNode(vx, vy, viewName, frameIdx);
            if (hit) {
                this._convertToUserInstance(hit.instanceGroup);
            }
            return;
        }

        // --- Assignment mode: click unlinked instances to assign ---
        if (this.assignmentMode) {
            const ulHit = this.findNearestUnlinkedNode(vx, vy, viewName, frameIdx);
            if (ulHit) {
                this.addToAssignmentSelection(ulHit.unlinked);
                this._requestRedraw();
                return;
            }
        }

        // --- Single left click ---
        const hit = this.findNearestNode(vx, vy, viewName, frameIdx);
        if (hit) {
            // Select the instance group and node
            this.select(hit.instanceGroup, hit.nodeIdx);

            // Start drag
            this.isDragging = true;
            this.dragInfo = {
                viewName: viewName,
                instanceGroupIdx: hit.instanceGroupIdx,
                nodeIdx: hit.nodeIdx,
                startPos: [vx, vy],
                currentPos: [vx, vy],
            };

            // Mark event as consumed so zoom handler doesn't also activate
            e._consumedByInteraction = true;
        } else {
            // No linked instance hit — try unlinked instances.
            // Auto-enter assignment mode on first click of an unlinked instance.
            const ulHit = this.findNearestUnlinkedNode(vx, vy, viewName, frameIdx);
            if (ulHit) {
                if (!this.assignmentMode) {
                    this.setAssignmentMode(true);
                }
                this.addToAssignmentSelection(ulHit.unlinked);
                e._consumedByInteraction = true;
            } else {
                // Clicked on empty space - let the event bubble for zoom/pan
                this.clearSelection();
            }
        }

        this._requestRedraw();
    }

    /**
     * Handle mousemove on an overlay canvas.
     *
     * If dragging: update the node position in the Instance.points array
     * and trigger a redraw for real-time visual feedback.
     *
     * If not dragging: update the hovered-node state for visual feedback
     * (e.g. cursor change, highlight ring).
     *
     * @param {MouseEvent} e
     * @param {string} viewName
     */
    onMouseMove(e, viewName) {
        const state = this._getState();
        if (!state) return;

        const [vx, vy] = this.canvasToVideo(e.offsetX, e.offsetY, viewName);

        if (this.isDragging && this.dragInfo && this.dragInfo.viewName === viewName) {
            // Update the drag position
            this.dragInfo.currentPos = [vx, vy];

            // Directly update the Instance point data for live preview
            const groups = this._getInstanceGroups(state.currentFrame);
            if (groups && groups.length > this.dragInfo.instanceGroupIdx) {
                const group = groups[this.dragInfo.instanceGroupIdx];
                const instance = group.getInstance(viewName);
                if (instance && instance.points && instance.points.length > this.dragInfo.nodeIdx) {
                    instance.points[this.dragInfo.nodeIdx] = [vx, vy];
                }
            }

            this._requestRedraw();
            return;
        }

        // Not dragging - update hover state
        const frameIdx = state.currentFrame;
        const hit = this.findNearestNode(vx, vy, viewName, frameIdx);

        const prevHover = this.hoveredNode;
        if (hit) {
            this.hoveredNode = {
                viewName: viewName,
                instanceGroupIdx: hit.instanceGroupIdx,
                nodeIdx: hit.nodeIdx,
            };
        } else {
            this.hoveredNode = null;
        }

        // Also check unlinked instances for cursor feedback
        let hoverUnlinked = false;
        if (!this.hoveredNode) {
            const ulHit = this.findNearestUnlinkedNode(vx, vy, viewName, frameIdx);
            if (ulHit) hoverUnlinked = true;
        }

        // Update cursor style on the overlay canvas
        const view = this._findView(state, viewName);
        if (view && view.overlayCanvas) {
            view.overlayCanvas.style.cursor = (this.hoveredNode || hoverUnlinked) ? 'pointer' : 'default';
        }

        // Redraw if hover state changed (for highlight rendering)
        const hoverChanged = !this._hoveredNodesEqual(prevHover, this.hoveredNode);
        if (hoverChanged) {
            this._requestRedraw();
        }
    }

    /**
     * Handle mouseup on an overlay canvas.
     *
     * If a drag was in progress: finalize the node position, mark the
     * instance as modified, and invoke the onNodeMoved callback so the
     * application can re-triangulate.
     *
     * @param {MouseEvent} e
     * @param {string} viewName
     */
    onMouseUp(e, viewName) {
        if (!this.isDragging || !this.dragInfo) return;

        const state = this._getState();
        if (!state) {
            this._endDrag();
            return;
        }

        const info = this.dragInfo;

        // Only finalize if the drag actually moved
        const dx = info.currentPos[0] - info.startPos[0];
        const dy = info.currentPos[1] - info.startPos[1];
        const didMove = Math.sqrt(dx * dx + dy * dy) > 0.5;

        if (didMove) {
            // Ensure the final position is written to the data
            const groups = this._getInstanceGroups(state.currentFrame);
            if (groups && groups.length > info.instanceGroupIdx) {
                const group = groups[info.instanceGroupIdx];
                const instance = group.getInstance(info.viewName);
                if (instance && instance.points && instance.points.length > info.nodeIdx) {
                    instance.points[info.nodeIdx] = [info.currentPos[0], info.currentPos[1]];

                    // Mark instance as user-edited
                    instance.type = 'user';
                }

                // Notify the application
                if (this.callbacks.onNodeMoved) {
                    this.callbacks.onNodeMoved(
                        info.viewName,
                        group,
                        info.nodeIdx,
                        [info.currentPos[0], info.currentPos[1]]
                    );
                }
            }
        }

        this._endDrag();
        this._requestRedraw();
    }

    /**
     * Handle mouse leaving an overlay canvas. Clears hover state.
     *
     * @param {string} viewName
     */
    onMouseLeave(viewName) {
        if (this.hoveredNode && this.hoveredNode.viewName === viewName) {
            this.hoveredNode = null;

            const state = this._getState();
            const view = state ? this._findView(state, viewName) : null;
            if (view && view.overlayCanvas) {
                view.overlayCanvas.style.cursor = 'default';
            }

            this._requestRedraw();
        }
    }

    // ======================================================================
    // Keyboard event handler
    // ======================================================================

    /**
     * Handle keydown events for interaction shortcuts.
     *
     * - Tab: cycle through instance groups in the current frame.
     * - Delete / Backspace: delete the selected instance (via callback).
     * - Escape: clear selection.
     * - N: add a new empty instance at the current frame (via callback).
     *
     * @param {KeyboardEvent} e
     */
    onKeyDown(e) {
        // Do not intercept when the user is typing in an input
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
            return;
        }

        const state = this._getState();
        if (!state) return;

        switch (e.key) {
            case 'Tab': {
                e.preventDefault();
                this._cycleSelection(e.shiftKey);
                break;
            }

            case 'Delete':
            case 'Backspace': {
                if (this.selectedInstanceGroup) {
                    e.preventDefault();
                    this._deleteSelected();
                }
                break;
            }

            case 'Escape': {
                e.preventDefault();
                if (this.assignmentMode) {
                    this.setAssignmentMode(false);
                } else {
                    this.clearSelection();
                }
                this._requestRedraw();
                break;
            }

            case 'n':
            case 'N': {
                // Only handle plain 'n', not Ctrl+N (new window) etc.
                if (!e.ctrlKey && !e.metaKey && !e.altKey) {
                    e.preventDefault();
                    this._addNewInstance();
                }
                break;
            }

            case 'a':
            case 'A': {
                if (!e.ctrlKey && !e.metaKey && !e.altKey) {
                    e.preventDefault();
                    this.setAssignmentMode();
                }
                break;
            }

            case 'Enter': {
                if (this.assignmentMode && this.assignmentSelection.length >= 1) {
                    e.preventDefault();
                    this._createGroupFromAssignment();
                }
                break;
            }
        }
    }

    // ======================================================================
    // Attach / Detach
    // ======================================================================

    /**
     * Attach event listeners to all overlay canvases and the document
     * (for keyboard).
     *
     * @param {Array<{ name: string, overlayCanvas: HTMLCanvasElement }>} views
     *   The view objects containing overlay canvases.
     */
    attach(views) {
        if (!views || views.length === 0) return;

        for (const view of views) {
            const canvas = view.overlayCanvas;
            if (!canvas) continue;

            const viewName = view.name;

            // Create bound handlers so we can remove them later
            const handlers = {
                mousedown: (e) => this.onMouseDown(e, viewName),
                mousemove: (e) => this.onMouseMove(e, viewName),
                mouseup: (e) => this.onMouseUp(e, viewName),
                mouseleave: () => this.onMouseLeave(viewName),
                contextmenu: (e) => e.preventDefault(), // suppress right-click menu
            };

            canvas.addEventListener('mousedown', handlers.mousedown);
            canvas.addEventListener('mousemove', handlers.mousemove);
            canvas.addEventListener('mouseup', handlers.mouseup);
            canvas.addEventListener('mouseleave', handlers.mouseleave);
            canvas.addEventListener('contextmenu', handlers.contextmenu);

            this._boundHandlers.set(viewName, { canvas, handlers });
        }

        // Document-level mouseup to catch drags that leave the canvas
        this._docMouseUpHandler = (e) => {
            if (this.isDragging && this.dragInfo) {
                this.onMouseUp(e, this.dragInfo.viewName);
            }
        };
        document.addEventListener('mouseup', this._docMouseUpHandler);

        // Keyboard handler
        this._keyHandler = (e) => this.onKeyDown(e);
        document.addEventListener('keydown', this._keyHandler);
    }

    /**
     * Remove all event listeners that were added by attach().
     */
    detach() {
        for (const [viewName, entry] of this._boundHandlers) {
            const canvas = entry.canvas;
            const h = entry.handlers;
            canvas.removeEventListener('mousedown', h.mousedown);
            canvas.removeEventListener('mousemove', h.mousemove);
            canvas.removeEventListener('mouseup', h.mouseup);
            canvas.removeEventListener('mouseleave', h.mouseleave);
            canvas.removeEventListener('contextmenu', h.contextmenu);
        }
        this._boundHandlers.clear();

        if (this._docMouseUpHandler) {
            document.removeEventListener('mouseup', this._docMouseUpHandler);
            this._docMouseUpHandler = null;
        }

        if (this._keyHandler) {
            document.removeEventListener('keydown', this._keyHandler);
            this._keyHandler = null;
        }
    }

    // ======================================================================
    // Internal helpers
    // ======================================================================

    /**
     * Safely call getState from callbacks.
     * @returns {Object|null}
     * @private
     */
    _getState() {
        if (this.callbacks.getState) {
            return this.callbacks.getState();
        }
        return null;
    }

    /**
     * Safely call getInstanceGroups from callbacks.
     * @param {number} frameIdx
     * @returns {InstanceGroup[]|null}
     * @private
     */
    _getInstanceGroups(frameIdx) {
        if (this.callbacks.getInstanceGroups) {
            return this.callbacks.getInstanceGroups(frameIdx);
        }
        return null;
    }

    /**
     * Safely call requestRedraw from callbacks.
     * @private
     */
    _requestRedraw() {
        if (this.callbacks.requestRedraw) {
            this.callbacks.requestRedraw();
        }
    }

    /**
     * Find a view object by name from the current application state.
     * @param {Object} state
     * @param {string} viewName
     * @returns {Object|null}
     * @private
     */
    _findView(state, viewName) {
        if (!state || !state.views) return null;
        for (let i = 0; i < state.views.length; i++) {
            if (state.views[i].name === viewName) return state.views[i];
        }
        return null;
    }

    /**
     * End the current drag operation without finalizing (internal cleanup).
     * @private
     */
    _endDrag() {
        this.isDragging = false;
        this.dragInfo = null;
    }

    /**
     * Compare two hoveredNode objects for equality.
     * @param {Object|null} a
     * @param {Object|null} b
     * @returns {boolean}
     * @private
     */
    _hoveredNodesEqual(a, b) {
        if (a === b) return true;
        if (a == null || b == null) return false;
        return (
            a.viewName === b.viewName &&
            a.instanceGroupIdx === b.instanceGroupIdx &&
            a.nodeIdx === b.nodeIdx
        );
    }

    /**
     * Toggle a node's visibility. If the point is non-null, set it to null
     * (hide). If it is null, there is nothing to restore without a
     * reprojection source, so we leave it null and let the callback handle
     * restoration logic.
     *
     * @param {string} viewName
     * @param {InstanceGroup} group
     * @param {number} nodeIdx
     * @private
     */
    _toggleNodeVisibility(viewName, group, nodeIdx) {
        const instance = group.getInstance(viewName);
        if (!instance || !instance.points) return;

        if (instance.points[nodeIdx] != null) {
            // Hide the point
            instance.points[nodeIdx] = null;
        }
        // If the point is already null, the callback is responsible for
        // deciding how to restore it (e.g. from reprojection).

        if (this.callbacks.onNodeVisibilityToggled) {
            this.callbacks.onNodeVisibilityToggled(viewName, group, nodeIdx);
        }

        this._requestRedraw();
    }

    /**
     * Convert all instances in an InstanceGroup from 'predicted' to 'user'.
     * This creates a deep copy of the point data so edits do not corrupt
     * the original predictions.
     *
     * @param {InstanceGroup} group
     * @private
     */
    _convertToUserInstance(group) {
        if (!group || !group.instances) return;

        let converted = false;

        // Iterate over all views in the group
        for (const [camName, instance] of group.instances) {
            if (instance.type === 'predicted') {
                // Deep copy the points array
                instance.points = instance.points.map(pt =>
                    pt != null ? [pt[0], pt[1]] : null
                );
                instance.type = 'user';
                converted = true;
            }
        }

        if (converted) {
            this.select(group, this.selectedNodeIdx);

            if (this.callbacks.onInstanceConverted) {
                this.callbacks.onInstanceConverted(group);
            }

            this._requestRedraw();
        }
    }

    /**
     * Cycle selection through the instance groups at the current frame.
     * Tab = forward, Shift+Tab = backward.
     *
     * @param {boolean} reverse - If true, cycle backward.
     * @private
     */
    _cycleSelection(reverse) {
        const state = this._getState();
        if (!state) return;

        const groups = this._getInstanceGroups(state.currentFrame);
        if (!groups || groups.length === 0) return;

        let currentIdx = -1;
        if (this.selectedInstanceGroup) {
            for (let i = 0; i < groups.length; i++) {
                if (groups[i] === this.selectedInstanceGroup) {
                    currentIdx = i;
                    break;
                }
            }
        }

        let nextIdx;
        if (currentIdx === -1) {
            // Nothing selected yet - pick first or last
            nextIdx = reverse ? groups.length - 1 : 0;
        } else if (reverse) {
            nextIdx = (currentIdx - 1 + groups.length) % groups.length;
        } else {
            nextIdx = (currentIdx + 1) % groups.length;
        }

        this.select(groups[nextIdx], -1);
        this._requestRedraw();
    }

    /**
     * Delete the currently selected instance group. The actual deletion is
     * left to the application via the onSelectionChanged callback - we
     * simply clear our selection and notify. A real implementation would
     * call a dedicated deletion callback; here we clear selection as a
     * safe default.
     *
     * @private
     */
    _deleteSelected() {
        if (!this.selectedInstanceGroup) return;

        // Store reference before clearing
        const group = this.selectedInstanceGroup;

        // Clear selection first
        this.clearSelection();

        // The application should handle actual deletion. For now we just
        // trigger a redraw. A dedicated onInstanceDeleted callback could
        // be added if needed.
        this._requestRedraw();
    }

    /**
     * Create an InstanceGroup from the current assignment selection.
     * @private
     */
    _createGroupFromAssignment() {
        const state = this._getState();
        if (!state || !state.session) return;
        if (this.assignmentSelection.length < 1) return;

        const frameIdx = state.currentFrame;
        const group = state.session.createGroupFromUnlinked(frameIdx, this.assignmentSelection);

        // Clear assignment mode
        this.assignmentSelection = [];
        this.assignmentMode = false;

        // Select the newly created group
        this.select(group, -1);
        this._requestRedraw();
    }

    /**
     * Add a new empty instance at the current frame. This is a stub that
     * relies on the application providing a callback for actual creation.
     * Since the callbacks spec does not include an addInstance callback,
     * this method is provided as a hook point. Subclasses or future
     * callback additions can extend this.
     *
     * @private
     */
    _addNewInstance() {
        const state = this._getState();
        if (!state || !state.session) return;

        // Create a new empty InstanceGroup with null points for all nodes
        const skeleton = state.session.skeleton;
        const numNodes = skeleton ? skeleton.nodes.length : 0;
        const emptyPoints = new Array(numNodes).fill(null);

        // Determine the next track index
        const groups = this._getInstanceGroups(state.currentFrame) || [];
        const usedTracks = new Set(groups.map(g => g.trackIdx));
        let newTrackIdx = 0;
        while (usedTracks.has(newTrackIdx)) {
            newTrackIdx++;
        }

        // Create a new InstanceGroup (the application can override this
        // behavior by watching onSelectionChanged after the group is added)
        const newGroup = new InstanceGroup(Date.now(), newTrackIdx);

        // Add empty instances for all cameras
        if (state.session.cameras) {
            for (const cam of state.session.cameras) {
                const instance = new Instance(
                    emptyPoints.map(() => null), // fresh null array per view
                    newTrackIdx,
                    'user',
                    1.0
                );
                newGroup.addInstance(cam.name, instance);
            }
        }

        // Store it in the session's instanceGroups map
        const frameIdx = state.currentFrame;
        if (!state.session.instanceGroups.has(frameIdx)) {
            state.session.instanceGroups.set(frameIdx, new Map());
        }
        const trackMap = state.session.instanceGroups.get(frameIdx);
        if (!trackMap.has(newTrackIdx)) {
            trackMap.set(newTrackIdx, []);
        }
        trackMap.get(newTrackIdx).push(newGroup);

        // Also add to FrameGroup
        const frameGroup = state.session.getFrameGroup(frameIdx);
        if (frameGroup) {
            for (const [camName, instance] of newGroup.instances) {
                frameGroup.addInstance(camName, instance);
            }
        }

        // Select the new group
        this.select(newGroup, -1);
        this._requestRedraw();
    }
}
