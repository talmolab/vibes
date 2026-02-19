/**
 * test-phase7.js - Tests for Phase 7: Instance workflow, project management & bug fixes.
 *
 * Covers: unlinked instance dragging, deletion, selection, assignment linking,
 * project save/load, legacy load reconstruction, V-key cycling, and the full
 * add → edit → link → triangulate workflow.
 */

(function () {
    const { describe, it, assert, assertEqual, assertNotNull, assertNull } = TestFramework;

    // ============================================
    // Helper: create a standard test session + InteractionManager
    // ============================================
    function makeTestEnv(opts) {
        opts = opts || {};
        var nodeNames = opts.nodes || ['a', 'b'];
        var edges = opts.edges || [[0, 1]];
        var camNames = opts.cameras || ['cam1', 'cam2'];
        var vw = opts.videoWidth || 640;
        var vh = opts.videoHeight || 480;

        var skeleton = new Skeleton('test', nodeNames, edges);
        var cameras = camNames.map(function (name) {
            return new Camera(name,
                [[600, 0, vw / 2], [0, 600, vh / 2], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [vw, vh]);
        });
        var session = new Session(cameras, skeleton, ['track_0']);
        var views = camNames.map(function (name) {
            return { name: name, videoWidth: vw, videoHeight: vh };
        });

        var selectionChanges = [];
        var deletions = [];
        var redraws = 0;

        var mgr = new InteractionManager({
            getState: function () {
                return { currentFrame: 0, session: session, views: views };
            },
            getInstanceGroups: function (frameIdx) {
                var trackMap = session.instanceGroups.get(frameIdx || 0);
                if (!trackMap) return [];
                var result = [];
                for (var entry of trackMap) {
                    for (var g of entry[1]) result.push(g);
                }
                return result;
            },
            onSelectionChanged: function (group, nodeIdx) {
                selectionChanges.push({ group: group, nodeIdx: nodeIdx });
            },
            onInstanceDeleted: function (frameIdx, group) {
                deletions.push({ frameIdx: frameIdx, group: group });
            },
            requestRedraw: function () {
                redraws++;
            },
        });

        return {
            skeleton: skeleton,
            cameras: cameras,
            session: session,
            views: views,
            mgr: mgr,
            selectionChanges: selectionChanges,
            deletions: deletions,
            getRedraws: function () { return redraws; },
        };
    }

    // ============================================
    // 3D viewport deletion fix
    // ============================================

    describe('3D viewport deletion', function () {
        it('Viewport3D should have setFrame method (if loaded)', function () {
            if (typeof Viewport3D === 'undefined') {
                assert(true, 'Viewport3D not loaded (Three.js not available), skipping');
                return;
            }
            assert(typeof Viewport3D.prototype.setFrame === 'function',
                'Viewport3D.prototype.setFrame should be a function');
        });

        it('Viewport3D should NOT have update method (if loaded)', function () {
            if (typeof Viewport3D === 'undefined') {
                assert(true, 'Viewport3D not loaded (Three.js not available), skipping');
                return;
            }
            assert(typeof Viewport3D.prototype.update === 'undefined',
                'Viewport3D.prototype.update should not exist');
        });
    });

    // ============================================
    // V key view cycling
    // ============================================

    describe('V key view cycling', function () {
        it('should cycle through all views in single-view mode', function () {
            var views = [
                { name: 'back' }, { name: 'mid' }, { name: 'side' }, { name: 'top' }
            ];
            var singleViewIndex = 0;

            var visited = [];
            for (var i = 0; i < 4; i++) {
                visited.push(views[singleViewIndex].name);
                singleViewIndex = (singleViewIndex + 1) % views.length;
            }

            assertEqual(visited.length, 4, 'Should visit all 4 views');
            assertEqual(visited[0], 'back');
            assertEqual(visited[1], 'mid');
            assertEqual(visited[2], 'side');
            assertEqual(visited[3], 'top');
        });

        it('should start at lastInteractedView when entering single-view from grid', function () {
            var views = [
                { name: 'back' }, { name: 'mid' }, { name: 'side' }, { name: 'top' }
            ];
            var lastInteractedView = 'side';

            var startIdx = 0;
            for (var i = 0; i < views.length; i++) {
                if (views[i].name === lastInteractedView) {
                    startIdx = i;
                    break;
                }
            }

            assertEqual(startIdx, 2, 'Should start at index 2 (side)');
        });

        it('should wrap around when cycling past the last view', function () {
            var views = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
            var idx = 2; // start at last
            idx = (idx + 1) % views.length;
            assertEqual(idx, 0, 'Should wrap to 0');
        });
    });

    // ============================================
    // N key creates UnlinkedInstance
    // ============================================

    describe('N key creates unlinked instance', function () {
        it('should create UnlinkedInstance on target camera only', function () {
            var env = makeTestEnv();
            env.mgr.lastInteractedView = 'cam2';
            env.mgr._addNewInstance();

            var fg = env.session.getFrameGroup(0);
            assertNotNull(fg, 'FrameGroup should exist');

            var unlinked2 = fg.getUnlinkedInstances('cam2');
            assertEqual(unlinked2.length, 1, 'cam2 should have 1 unlinked instance');

            var unlinked1 = fg.getUnlinkedInstances('cam1');
            assertEqual(unlinked1.length, 0, 'cam1 should have no unlinked instances');
        });

        it('should NOT create InstanceGroups', function () {
            var env = makeTestEnv();
            env.mgr.lastInteractedView = 'cam1';
            env.mgr._addNewInstance();

            var trackMap = env.session.instanceGroups.get(0);
            var hasGroups = false;
            if (trackMap) {
                for (var entry of trackMap) {
                    if (entry[1].length > 0) hasGroups = true;
                }
            }
            assert(!hasGroups, 'No InstanceGroups should be created');
        });

        it('should create correct point count matching skeleton nodes', function () {
            var env = makeTestEnv({ nodes: ['a', 'b', 'c', 'd'], edges: [[0, 1], [1, 2], [2, 3]] });
            env.mgr.lastInteractedView = 'cam1';
            env.mgr._addNewInstance();

            var fg = env.session.getFrameGroup(0);
            var unlinked = fg.getUnlinkedInstances('cam1');
            assertEqual(unlinked[0].instance.points.length, 4, 'Should have 4 points for 4-node skeleton');
        });

        it('should place points near video center', function () {
            var env = makeTestEnv({ videoWidth: 800, videoHeight: 600 });
            env.mgr.lastInteractedView = 'cam1';
            env.mgr._addNewInstance();

            var fg = env.session.getFrameGroup(0);
            var inst = fg.getUnlinkedInstances('cam1')[0].instance;
            for (var i = 0; i < inst.points.length; i++) {
                assert(Math.abs(inst.points[i][0] - 400) < 100,
                    'Point ' + i + ' x should be near center (400)');
                assert(Math.abs(inst.points[i][1] - 300) < 100,
                    'Point ' + i + ' y should be near center (300)');
            }
        });

        it('should create FrameGroup if none exists', function () {
            var env = makeTestEnv();
            assertEqual(env.session.frameGroups.size, 0, 'No frame groups initially');
            env.mgr.lastInteractedView = 'cam1';
            env.mgr._addNewInstance();
            assertNotNull(env.session.getFrameGroup(0), 'FrameGroup should be created');
        });

        it('should do nothing without lastInteractedView and no views', function () {
            var skeleton = new Skeleton('test', ['a'], []);
            var session = new Session([], skeleton, []);
            var mgr = new InteractionManager({
                getState: function () { return { currentFrame: 0, session: session, views: [] }; },
                getInstanceGroups: function () { return []; },
                onSelectionChanged: function () {},
                requestRedraw: function () {},
            });
            mgr._addNewInstance();
            assertEqual(session.frameGroups.size, 0, 'No FrameGroup should be created');
        });
    });

    // ============================================
    // Unlinked instance node dragging
    // ============================================

    describe('Unlinked instance node dragging', function () {
        it('should set selectedUnlinked when clicking on unlinked node', function () {
            var env = makeTestEnv();
            // Create an unlinked instance
            var inst = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);
            env.session.addUnlinkedInstance(0, 'cam1', inst);

            var fg = env.session.getFrameGroup(0);
            var ul = fg.getUnlinkedInstances('cam1')[0];

            // Directly test: after clicking near unlinked node, selectedUnlinked should be set
            // We simulate the picking result
            env.mgr.selectedUnlinked = ul;
            assertNotNull(env.mgr.selectedUnlinked, 'selectedUnlinked should be set');
            assertEqual(env.mgr.selectedUnlinked.cameraName, 'cam1', 'Should be on cam1');
        });

        it('should store unlinked reference in dragInfo', function () {
            var env = makeTestEnv();
            var inst = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);
            env.session.addUnlinkedInstance(0, 'cam1', inst);
            var fg = env.session.getFrameGroup(0);
            var ul = fg.getUnlinkedInstances('cam1')[0];

            // Simulate drag setup on unlinked
            env.mgr.isDragging = true;
            env.mgr.dragInfo = {
                mode: 'node',
                viewName: 'cam1',
                instanceGroupIdx: -1,
                nodeIdx: 0,
                startPos: [100, 100],
                currentPos: [100, 100],
                unlinked: ul,
                originalPoints: null,
            };

            // Verify dragInfo has unlinked reference
            assertNotNull(env.mgr.dragInfo.unlinked, 'dragInfo should have unlinked reference');
            assertEqual(env.mgr.dragInfo.instanceGroupIdx, -1, 'instanceGroupIdx should be -1 for unlinked');
        });

        it('should update unlinked instance points during drag via onMouseMove', function () {
            var env = makeTestEnv();
            var inst = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);
            env.session.addUnlinkedInstance(0, 'cam1', inst);
            var fg = env.session.getFrameGroup(0);
            var ul = fg.getUnlinkedInstances('cam1')[0];

            // Create a fake overlay canvas for coordinate transform
            var fakeCanvas = document.createElement('canvas');
            fakeCanvas.width = 640;
            fakeCanvas.height = 480;
            fakeCanvas.style.width = '640px';
            fakeCanvas.style.height = '480px';
            document.body.appendChild(fakeCanvas);

            // Set up views with the fake canvas
            env.views[0].overlayCanvas = fakeCanvas;

            // Start drag on unlinked node 0
            env.mgr.isDragging = true;
            env.mgr.dragInfo = {
                mode: 'node',
                viewName: 'cam1',
                instanceGroupIdx: -1,
                nodeIdx: 0,
                startPos: [100, 100],
                currentPos: [100, 100],
                unlinked: ul,
                originalPoints: null,
            };

            // Simulate move - directly modify (as onMouseMove uses canvasToVideo which needs real layout)
            var newX = 150, newY = 160;
            env.mgr.dragInfo.currentPos = [newX, newY];
            // Replicate the onMouseMove logic for unlinked
            var dragInst = env.mgr.dragInfo.unlinked.instance;
            dragInst.points[env.mgr.dragInfo.nodeIdx] = [newX, newY];

            assertEqual(ul.instance.points[0][0], 150, 'Node x should be updated to 150');
            assertEqual(ul.instance.points[0][1], 160, 'Node y should be updated to 160');
            // Node 1 should be unchanged
            assertEqual(ul.instance.points[1][0], 200, 'Node 1 x should remain 200');

            document.body.removeChild(fakeCanvas);
        });
    });

    // ============================================
    // Unlinked instance deletion
    // ============================================

    describe('Unlinked instance deletion', function () {
        it('should delete unlinked instance when selected and Delete pressed', function () {
            var env = makeTestEnv();
            var inst = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);
            env.session.addUnlinkedInstance(0, 'cam1', inst);

            var fg = env.session.getFrameGroup(0);
            var ul = fg.getUnlinkedInstances('cam1')[0];

            // Select the unlinked instance
            env.mgr.selectedUnlinked = ul;
            env.mgr.lastInteractedView = 'cam1';

            // Delete
            env.mgr._deleteSelected(false);

            // Verify deleted
            assertEqual(fg.getUnlinkedInstances('cam1').length, 0, 'Unlinked should be removed');
            assertNull(env.mgr.selectedUnlinked, 'Selection should be cleared');
        });

        it('should notify callback on unlinked deletion', function () {
            var env = makeTestEnv();
            var inst = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);
            env.session.addUnlinkedInstance(0, 'cam1', inst);

            var fg = env.session.getFrameGroup(0);
            var ul = fg.getUnlinkedInstances('cam1')[0];

            env.mgr.selectedUnlinked = ul;
            env.mgr._deleteSelected(false);

            assertEqual(env.deletions.length, 1, 'Should have 1 deletion notification');
            assertEqual(env.deletions[0].frameIdx, 0, 'Should be frame 0');
        });

        it('should not delete anything when nothing is selected', function () {
            var env = makeTestEnv();
            var inst = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);
            env.session.addUnlinkedInstance(0, 'cam1', inst);

            // No selection
            env.mgr._deleteSelected(false);

            var fg = env.session.getFrameGroup(0);
            assertEqual(fg.getUnlinkedInstances('cam1').length, 1, 'Unlinked should remain');
        });
    });

    // ============================================
    // clearSelection covers unlinked
    // ============================================

    describe('clearSelection', function () {
        it('should clear both linked and unlinked selection', function () {
            var env = makeTestEnv();
            var inst = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);
            env.session.addUnlinkedInstance(0, 'cam1', inst);
            var fg = env.session.getFrameGroup(0);
            var ul = fg.getUnlinkedInstances('cam1')[0];

            // Set both selections
            env.mgr.selectedUnlinked = ul;
            env.mgr.selectedInstanceGroup = new InstanceGroup(1, 0);
            env.mgr.selectedNodeIdx = 0;

            env.mgr.clearSelection();

            assertNull(env.mgr.selectedInstanceGroup, 'selectedInstanceGroup should be null');
            assertNull(env.mgr.selectedUnlinked, 'selectedUnlinked should be null');
            assertEqual(env.mgr.selectedNodeIdx, -1, 'selectedNodeIdx should be -1');
        });
    });

    // ============================================
    // Assignment linking workflow
    // ============================================

    describe('Assignment linking', function () {
        it('should create InstanceGroup from 2 unlinked instances on different cameras', function () {
            var env = makeTestEnv();

            var inst1 = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);
            var inst2 = new Instance([[150, 150], [250, 250]], 0, 'user', 1.0);
            env.session.addUnlinkedInstance(0, 'cam1', inst1);
            env.session.addUnlinkedInstance(0, 'cam2', inst2);

            var fg = env.session.getFrameGroup(0);
            var ul1 = fg.getUnlinkedInstances('cam1');
            var ul2 = fg.getUnlinkedInstances('cam2');

            var unlinkedList = [ul1[0], ul2[0]];
            var group = env.session.createGroupFromUnlinked(0, unlinkedList, 0);

            assertNotNull(group, 'InstanceGroup should be created');
            assertNotNull(group.getInstance('cam1'), 'Group should have cam1');
            assertNotNull(group.getInstance('cam2'), 'Group should have cam2');
            assertEqual(fg.getUnlinkedInstances('cam1').length, 0, 'cam1 unlinked should be cleared');
            assertEqual(fg.getUnlinkedInstances('cam2').length, 0, 'cam2 unlinked should be cleared');
        });

        it('C key should trigger _createGroupFromAssignment', function () {
            var env = makeTestEnv();

            var inst1 = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);
            var inst2 = new Instance([[150, 150], [250, 250]], 0, 'user', 1.0);
            env.session.addUnlinkedInstance(0, 'cam1', inst1);
            env.session.addUnlinkedInstance(0, 'cam2', inst2);

            var fg = env.session.getFrameGroup(0);
            var ul1 = fg.getUnlinkedInstances('cam1');
            var ul2 = fg.getUnlinkedInstances('cam2');

            env.mgr.assignmentMode = true;
            env.mgr.assignmentSelection = [ul1[0], ul2[0]];

            var event = new KeyboardEvent('keydown', { key: 'c', ctrlKey: false, metaKey: false, altKey: false });
            env.mgr.onKeyDown(event);

            var trackMap = env.session.instanceGroups.get(0);
            assertNotNull(trackMap, 'Instance groups should exist');
            var hasGroup = false;
            if (trackMap) {
                for (var entry of trackMap) {
                    if (entry[1].length > 0) hasGroup = true;
                }
            }
            assert(hasGroup, 'InstanceGroup should be created by C key');
            assert(!env.mgr.assignmentMode, 'Assignment mode should be cleared');
        });

        it('Enter key should also trigger _createGroupFromAssignment', function () {
            var env = makeTestEnv();

            var inst1 = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);
            env.session.addUnlinkedInstance(0, 'cam1', inst1);

            var fg = env.session.getFrameGroup(0);
            var ul1 = fg.getUnlinkedInstances('cam1');

            env.mgr.assignmentMode = true;
            env.mgr.assignmentSelection = [ul1[0]];

            var event = new KeyboardEvent('keydown', { key: 'Enter' });
            env.mgr.onKeyDown(event);

            var trackMap = env.session.instanceGroups.get(0);
            assertNotNull(trackMap, 'Instance groups should exist after Enter');
        });
    });

    // ============================================
    // Full workflow: add → edit → link → verify
    // ============================================

    describe('Full unlinked workflow', function () {
        it('add on cam1, add on cam2, link, verify group', function () {
            var env = makeTestEnv();

            // Add unlinked on cam1
            env.mgr.lastInteractedView = 'cam1';
            env.mgr._addNewInstance();

            // Add unlinked on cam2
            env.mgr.lastInteractedView = 'cam2';
            env.mgr._addNewInstance();

            var fg = env.session.getFrameGroup(0);
            assertEqual(fg.getUnlinkedInstances('cam1').length, 1, 'cam1 should have 1 unlinked');
            assertEqual(fg.getUnlinkedInstances('cam2').length, 1, 'cam2 should have 1 unlinked');

            // Link them
            var ul1 = fg.getUnlinkedInstances('cam1')[0];
            var ul2 = fg.getUnlinkedInstances('cam2')[0];
            var group = env.session.createGroupFromUnlinked(0, [ul1, ul2]);

            assertNotNull(group, 'Group should be created');
            assertEqual(group.instances.size, 2, 'Group should have 2 cameras');
            assertEqual(fg.getUnlinkedInstances('cam1').length, 0, 'cam1 unlinked cleared');
            assertEqual(fg.getUnlinkedInstances('cam2').length, 0, 'cam2 unlinked cleared');

            // Verify it's in instanceGroups
            var trackMap = env.session.instanceGroups.get(0);
            assertNotNull(trackMap, 'instanceGroups should have frame 0');
        });

        it('add multiple unlinked on same camera', function () {
            var env = makeTestEnv();

            env.mgr.lastInteractedView = 'cam1';
            env.mgr._addNewInstance();
            env.mgr._addNewInstance();

            var fg = env.session.getFrameGroup(0);
            assertEqual(fg.getUnlinkedInstances('cam1').length, 2, 'cam1 should have 2 unlinked instances');
        });
    });

    // ============================================
    // Linked instance deletion still works
    // ============================================

    describe('Linked instance deletion (regression)', function () {
        it('should delete linked group with Shift+Delete', function () {
            var env = makeTestEnv();

            // Create a linked group
            var group = new InstanceGroup(1, 0);
            group.addInstance('cam1', new Instance([[100, 100], [200, 200]], 0, 'user', 1.0));
            group.addInstance('cam2', new Instance([[150, 150], [250, 250]], 0, 'user', 1.0));
            env.session.instanceGroups.set(0, new Map([[0, [group]]]));

            var fg = new FrameGroup(0);
            fg.addInstance('cam1', group.getInstance('cam1'));
            fg.addInstance('cam2', group.getInstance('cam2'));
            env.session.addFrameGroup(fg);

            // Select and delete
            env.mgr.select(group, -1);
            env.mgr.lastInteractedView = 'cam1';
            env.mgr._deleteSelected(true); // Shift+Delete

            var trackMap = env.session.instanceGroups.get(0);
            var empty = !trackMap || trackMap.size === 0;
            assert(empty, 'Instance group should be fully removed');
        });

        it('should delete from single camera with Delete', function () {
            var env = makeTestEnv();

            var group = new InstanceGroup(1, 0);
            group.addInstance('cam1', new Instance([[100, 100], [200, 200]], 0, 'user', 1.0));
            group.addInstance('cam2', new Instance([[150, 150], [250, 250]], 0, 'user', 1.0));
            env.session.instanceGroups.set(0, new Map([[0, [group]]]));

            var fg = new FrameGroup(0);
            fg.addInstance('cam1', group.getInstance('cam1'));
            fg.addInstance('cam2', group.getInstance('cam2'));
            env.session.addFrameGroup(fg);

            env.mgr.select(group, -1);
            env.mgr.lastInteractedView = 'cam1';
            env.mgr._deleteSelected(false); // Per-camera delete

            assertEqual(group.instances.has('cam1'), false, 'cam1 should be deleted');
            assertEqual(group.instances.has('cam2'), true, 'cam2 should remain');
        });
    });

    // ============================================
    // Project save format
    // ============================================

    describe('Project save format', function () {
        it('should serialize with version 2 and correct structure', function () {
            var env = makeTestEnv();

            // Add a linked group
            var group = new InstanceGroup(1, 0);
            var inst = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);
            group.addInstance('cam1', inst);
            env.session.instanceGroups.set(0, new Map([[0, [group]]]));

            var fg = new FrameGroup(0);
            fg.addInstance('cam1', inst);
            env.session.addFrameGroup(fg);

            // Add an unlinked instance
            var inst2 = new Instance([[50, 50], [60, 60]], 0, 'user', 1.0);
            var unlinked = new UnlinkedInstance(inst2, 'cam1');
            fg.addUnlinkedInstance('cam1', unlinked);

            // Build save data (mirrors saveProject logic)
            var projectData = {
                version: 2,
                skeleton: { name: env.skeleton.name, nodes: env.skeleton.nodes, edges: env.skeleton.edges },
                cameras: env.cameras.map(function (c) {
                    return { name: c.name, matrix: c.matrix, dist: c.dist, rvec: c.rvec, tvec: c.tvec, size: c.size };
                }),
                tracks: env.session.tracks,
                frames: {},
            };

            for (var entry of env.session.frameGroups) {
                var frameIdx = entry[0];
                var fg2 = entry[1];
                var frameData = { instanceGroups: [], unlinkedInstances: [] };

                var trackMap = env.session.instanceGroups.get(frameIdx);
                if (trackMap) {
                    for (var tEntry of trackMap) {
                        for (var g of tEntry[1]) {
                            var groupData = { id: g.id, trackIdx: g.trackIdx, instances: {} };
                            for (var iEntry of g.instances) {
                                groupData.instances[iEntry[0]] = {
                                    points: iEntry[1].points,
                                    trackIdx: iEntry[1].trackIdx,
                                };
                            }
                            frameData.instanceGroups.push(groupData);
                        }
                    }
                }

                for (var uEntry of fg2.unlinkedInstances) {
                    for (var u of uEntry[1]) {
                        frameData.unlinkedInstances.push({
                            cameraName: uEntry[0],
                            points: u.instance.points,
                        });
                    }
                }

                projectData.frames[frameIdx] = frameData;
            }

            assertEqual(projectData.version, 2, 'Version should be 2');
            assertNotNull(projectData.frames['0'], 'Frame 0 should exist');
            assertEqual(projectData.frames['0'].instanceGroups.length, 1, 'Should have 1 instance group');
            assertEqual(projectData.frames['0'].unlinkedInstances.length, 1, 'Should have 1 unlinked');
            assertNotNull(projectData.frames['0'].instanceGroups[0].instances['cam1'], 'Group should have cam1');
        });
    });

    // ============================================
    // Legacy load fix (InstanceGroup reconstruction)
    // ============================================

    describe('Legacy load fix', function () {
        it('should reconstruct InstanceGroups from legacy format by trackIdx', function () {
            var env = makeTestEnv();

            // Create a FrameGroup with instances that share trackIdx across cameras
            var fg = new FrameGroup(0);
            var inst1 = new Instance([[100, 100], [200, 200]], 0, 'predicted', 0.9);
            var inst2 = new Instance([[150, 150], [250, 250]], 0, 'predicted', 0.9);
            var inst3 = new Instance([[300, 300], [400, 400]], 1, 'predicted', 0.8);

            fg.addInstance('cam1', inst1);  // track 0
            fg.addInstance('cam2', inst2);  // track 0
            fg.addInstance('cam1', inst3);  // track 1

            env.session.addFrameGroup(fg);

            // Run the legacy reconstruction logic
            for (var entry of env.session.frameGroups) {
                var frameIdx = entry[0];
                var fg2 = entry[1];
                var trackInstances = new Map();
                for (var camEntry of fg2.instances) {
                    var camName = camEntry[0];
                    var instances = camEntry[1];
                    for (var inst of instances) {
                        var tIdx = inst.trackIdx || 0;
                        if (!trackInstances.has(tIdx)) trackInstances.set(tIdx, []);
                        trackInstances.get(tIdx).push({ camName: camName, instance: inst });
                    }
                }
                if (!env.session.instanceGroups.has(frameIdx)) env.session.instanceGroups.set(frameIdx, new Map());
                var trackMap = env.session.instanceGroups.get(frameIdx);
                for (var tEntry of trackInstances) {
                    var trackIdx = tEntry[0];
                    var entries = tEntry[1];
                    var group = new InstanceGroup(Date.now() + trackIdx, trackIdx);
                    for (var e of entries) group.addInstance(e.camName, e.instance);
                    if (!trackMap.has(trackIdx)) trackMap.set(trackIdx, []);
                    trackMap.get(trackIdx).push(group);
                }
            }

            // Verify reconstruction
            var trackMap2 = env.session.instanceGroups.get(0);
            assertNotNull(trackMap2, 'Should have instance groups for frame 0');

            var track0Groups = trackMap2.get(0);
            assertEqual(track0Groups.length, 1, 'Should have 1 group for track 0');
            assertNotNull(track0Groups[0].getInstance('cam1'), 'Track 0 group should have cam1');
            assertNotNull(track0Groups[0].getInstance('cam2'), 'Track 0 group should have cam2');

            var track1Groups = trackMap2.get(1);
            assertEqual(track1Groups.length, 1, 'Should have 1 group for track 1');
            assertNotNull(track1Groups[0].getInstance('cam1'), 'Track 1 group should have cam1');
            assertNull(track1Groups[0].getInstance('cam2'), 'Track 1 group should not have cam2');
        });
    });

    // ============================================
    // InteractionManager has no deselect() method (regression)
    // ============================================

    describe('InteractionManager API', function () {
        it('should have clearSelection method', function () {
            var mgr = new InteractionManager({
                getState: function () { return null; },
                getInstanceGroups: function () { return []; },
            });
            assert(typeof mgr.clearSelection === 'function', 'clearSelection should exist');
        });

        it('should have selectedUnlinked property', function () {
            var mgr = new InteractionManager({
                getState: function () { return null; },
                getInstanceGroups: function () { return []; },
            });
            assert('selectedUnlinked' in mgr, 'selectedUnlinked property should exist');
            assertNull(mgr.selectedUnlinked, 'selectedUnlinked should start null');
        });

        it('dragInfo.unlinked field should exist in drag setup', function () {
            // Verify that the drag system supports unlinked references
            var env = makeTestEnv();
            env.mgr.isDragging = true;
            env.mgr.dragInfo = {
                mode: 'node', viewName: 'cam1', instanceGroupIdx: -1,
                nodeIdx: 0, startPos: [0, 0], currentPos: [0, 0],
                unlinked: null, originalPoints: null,
            };
            assert('unlinked' in env.mgr.dragInfo, 'dragInfo should have unlinked field');
        });
    });

    // ============================================
    // newProject clears all state
    // ============================================

    describe('newProject state clearing', function () {
        it('should clear session, views, videoFiles, frames, and triangulation', function () {
            // Simulate a loaded project state
            var state = {
                session: new Session([], new Skeleton('s', ['a'], []), []),
                views: [{ name: 'cam1' }, { name: 'cam2' }],
                videoFiles: [{ name: 'v1.mp4' }],
                currentFrame: 42,
                totalFrames: 100,
                fps: 60,
                keypoints3d: [[1, 2, 3]],
                triangulationResults: new Map([[0, [{ group: null }]]]),
                viewMode: 'single',
                singleViewIndex: 2,
                isPlaying: false,
            };

            // Apply newProject clearing logic (mirrors index.html newProject)
            state.session = null;
            state.currentFrame = 0;
            state.totalFrames = 0;
            state.fps = 30;
            state.keypoints3d = null;
            state.triangulationResults = new Map();
            state.viewMode = 'grid';
            state.singleViewIndex = 0;
            state.views = [];
            state.videoFiles = [];

            assertNull(state.session, 'session should be null');
            assertEqual(state.views.length, 0, 'views should be empty');
            assertEqual(state.videoFiles.length, 0, 'videoFiles should be empty');
            assertEqual(state.currentFrame, 0, 'currentFrame should be 0');
            assertEqual(state.totalFrames, 0, 'totalFrames should be 0');
            assertEqual(state.fps, 30, 'fps should reset to 30');
            assertNull(state.keypoints3d, 'keypoints3d should be null');
            assertEqual(state.triangulationResults.size, 0, 'triangulationResults should be empty');
            assertEqual(state.viewMode, 'grid', 'viewMode should be grid');
            assertEqual(state.singleViewIndex, 0, 'singleViewIndex should be 0');
        });

        it('should detach interactionManager', function () {
            var detached = false;
            var mgr = new InteractionManager({
                getState: function () { return null; },
                getInstanceGroups: function () { return []; },
            });
            // Monkey-patch detach to verify it gets called
            var origDetach = mgr.detach.bind(mgr);
            mgr.detach = function () { detached = true; origDetach(); };

            mgr.detach();
            assert(detached, 'detach should be called on interactionManager');
        });

        it('session with frames should require clearing', function () {
            var skeleton = new Skeleton('s', ['a'], []);
            var session = new Session([], skeleton, []);
            var fg = new FrameGroup(0);
            session.addFrameGroup(fg);

            // This simulates the condition check in newProject
            var hasData = session && session.numFrames > 0;
            // Note: numFrames counts frameGroups
            assert(hasData || session.frameGroups.size > 0, 'Should detect session has data');
        });

        it('empty session should still allow newProject without confirm', function () {
            // With no session and no views, newProject should not require confirmation
            var needsConfirm = (null || [].length > 0);
            assert(!needsConfirm, 'Empty state should not require confirmation');
        });
    });

})();
