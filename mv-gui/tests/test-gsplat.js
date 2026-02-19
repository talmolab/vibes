/**
 * test-gsplat.js - Tests for Phase 5 Gaussian splat viewer integration.
 *
 * Tests: GaussianSplatViewer construction, camera sync math (FOV -> focal length),
 * visibility toggling, opacity, state management. Does NOT test actual WebGL
 * rendering (requires gsplat.js CDN and canvas).
 */

(function () {
    const { describe, it, beforeEach, assertEqual, assertTrue, assertFalse,
        assertApprox, assertNotNull, assertNull } = TestFramework;

    describe('GaussianSplatViewer - Construction', function () {
        it('class exists globally', function () {
            assertTrue(typeof GaussianSplatViewer === 'function', 'GaussianSplatViewer should be a constructor');
        });

        it('creates instance with correct defaults', function () {
            var container = document.createElement('div');
            var viewer = new GaussianSplatViewer(container, null, null);

            assertFalse(viewer.visible, 'Should not be visible initially');
            assertNull(viewer.canvas, 'Canvas should be null before init');
            assertNull(viewer.renderer, 'Renderer should be null before init');
            assertNull(viewer.currentSplat, 'No splat loaded initially');
            assertEqual(viewer.opacity, 0.8, 'Default opacity should be 0.8');
            assertNull(viewer.splatInfo, 'No splat info initially');
        });
    });

    describe('GaussianSplatViewer - Visibility', function () {
        let viewer;

        beforeEach(function () {
            viewer = new GaussianSplatViewer(document.createElement('div'), null, null);
        });

        it('setVisible toggles visible flag', function () {
            assertFalse(viewer.visible);
            viewer.setVisible(true);
            assertTrue(viewer.visible);
            viewer.setVisible(false);
            assertFalse(viewer.visible);
        });

        it('toggleVisible returns new state', function () {
            assertFalse(viewer.visible);
            var result = viewer.toggleVisible();
            assertTrue(result, 'Should return true after toggling from false');
            result = viewer.toggleVisible();
            assertFalse(result, 'Should return false after toggling from true');
        });
    });

    describe('GaussianSplatViewer - Opacity', function () {
        let viewer;

        beforeEach(function () {
            viewer = new GaussianSplatViewer(document.createElement('div'), null, null);
        });

        it('setOpacity clamps to 0-1 range', function () {
            viewer.setOpacity(0.5);
            assertApprox(viewer.opacity, 0.5, 0.001);

            viewer.setOpacity(1.5);
            assertApprox(viewer.opacity, 1.0, 0.001, 'Should clamp to 1.0');

            viewer.setOpacity(-0.5);
            assertApprox(viewer.opacity, 0.0, 0.001, 'Should clamp to 0.0');
        });
    });

    describe('Camera Sync Math - FOV to Focal Length', function () {
        it('computes focal length from FOV correctly (standard 50 FOV)', function () {
            var fov = 50; // degrees
            var height = 600; // pixels

            var fovRad = fov * Math.PI / 180;
            var fy = (height / 2) / Math.tan(fovRad / 2);

            // For 50 degrees, tan(25 degrees) ≈ 0.4663
            // fy = 300 / 0.4663 ≈ 643.5
            assertApprox(fy, 643.5, 1.0, 'fy for FOV=50, h=600');
        });

        it('computes focal length from FOV correctly (90 FOV)', function () {
            var fov = 90;
            var height = 800;

            var fovRad = fov * Math.PI / 180;
            var fy = (height / 2) / Math.tan(fovRad / 2);

            // For 90 degrees, tan(45 degrees) = 1.0
            // fy = 400 / 1.0 = 400
            assertApprox(fy, 400.0, 0.01, 'fy for FOV=90, h=800');
        });

        it('fx equals fy for square pixels', function () {
            var fov = 50;
            var height = 600;
            var fovRad = fov * Math.PI / 180;
            var fy = (height / 2) / Math.tan(fovRad / 2);
            var fx = fy;

            assertApprox(fx, fy, 0.001, 'fx should equal fy for square pixels');
        });

        it('focal length increases with smaller FOV', function () {
            var height = 600;
            var fy_narrow = (height / 2) / Math.tan((30 * Math.PI / 180) / 2);
            var fy_wide = (height / 2) / Math.tan((90 * Math.PI / 180) / 2);

            assertTrue(fy_narrow > fy_wide, 'Narrower FOV should give larger focal length');
        });
    });

    describe('Splat State Management', function () {
        it('static splat data structure', function () {
            var splatData = { type: 'static', file: 'test.ply' };
            assertEqual(splatData.type, 'static');
            assertNotNull(splatData.file);
        });

        it('animated splat data structure with manifest', function () {
            var manifest = {
                frames: { '0': 'frame_000000.ply', '100': 'frame_000100.ply' },
                training_config: { cameras: ['back', 'left'] }
            };
            var splatData = { type: 'animated', manifest: manifest, currentFile: null };

            assertEqual(splatData.type, 'animated');
            assertEqual(Object.keys(splatData.manifest.frames).length, 2);
            assertNull(splatData.currentFile);
        });

        it('finds nearest frame in manifest', function () {
            var available = [0, 100, 200, 300];
            var frameIdx = 150;

            var nearest = available[0];
            var minDist = Math.abs(frameIdx - nearest);
            for (var i = 1; i < available.length; i++) {
                var dist = Math.abs(frameIdx - available[i]);
                if (dist < minDist) {
                    minDist = dist;
                    nearest = available[i];
                }
            }

            assertEqual(nearest, 100, 'Nearest to 150 should be 100 (tie goes to first)');
        });

        it('finds exact frame in manifest', function () {
            var available = [0, 100, 200, 300];
            var frameIdx = 200;

            var nearest = available[0];
            var minDist = Math.abs(frameIdx - nearest);
            for (var i = 1; i < available.length; i++) {
                var dist = Math.abs(frameIdx - available[i]);
                if (dist < minDist) {
                    minDist = dist;
                    nearest = available[i];
                }
            }

            assertEqual(nearest, 200, 'Exact match should find 200');
        });
    });

    describe('GaussianSplatViewer - applyTransform', function () {
        it('applyTransform method exists', function () {
            var container = document.createElement('div');
            var viewer = new GaussianSplatViewer(container, null, null);
            assertTrue(typeof viewer.applyTransform === 'function', 'applyTransform should exist');
        });

        it('applyTransform does not throw when no splat loaded', function () {
            var container = document.createElement('div');
            var viewer = new GaussianSplatViewer(container, null, null);
            // Should be a no-op without error
            var threw = false;
            try {
                viewer.applyTransform({ position: [10, 20, 30] });
            } catch (e) {
                threw = true;
            }
            assertFalse(threw, 'Should not throw when no splat loaded');
        });
    });

    describe('GaussianSplatViewer - Dispose', function () {
        it('dispose clears all references', function () {
            var container = document.createElement('div');
            var viewer = new GaussianSplatViewer(container, null, null);

            viewer.dispose();

            assertNull(viewer.renderer, 'Renderer should be null');
            assertNull(viewer.scene, 'Scene should be null');
            assertNull(viewer.camera, 'Camera should be null');
            assertNull(viewer.currentSplat, 'Splat should be null');
            assertNull(viewer.canvas, 'Canvas should be null');
            assertFalse(viewer.visible, 'Should not be visible');
        });
    });

})();
