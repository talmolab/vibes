/**
 * gsplat-viewer.js - Gaussian Splat overlay for the 3D viewport.
 *
 * Uses gsplat.js (loaded from CDN via dynamic import) to render pre-trained
 * .ply / .splat files as a 3D background in the viewport. The splat renderer
 * runs on a separate canvas overlaid beneath the Three.js canvas, with camera
 * transforms synchronized each frame.
 *
 * No imports/exports - follows the vibes pattern of global scope scripts.
 */

// ============================================
// GaussianSplatViewer
// ============================================

class GaussianSplatViewer {
    /**
     * @param {HTMLElement} container - The viewport3d container element
     * @param {THREE.PerspectiveCamera} threeCamera - The Three.js camera to sync with
     * @param {THREE.OrbitControls} threeControls - Orbit controls for change detection
     */
    constructor(container, threeCamera, threeControls) {
        this.container = container;
        this.threeCamera = threeCamera;
        this.threeControls = threeControls;

        /** @type {HTMLCanvasElement} */
        this.canvas = null;

        /** @type {Object} gsplat.js module (SPLAT namespace) */
        this.SPLAT = null;

        /** @type {Object} gsplat.js WebGLRenderer */
        this.renderer = null;

        /** @type {Object} gsplat.js Scene */
        this.scene = null;

        /** @type {Object} gsplat.js Camera */
        this.camera = null;

        /** @type {Object} Current loaded splat object */
        this.currentSplat = null;

        /** @type {boolean} Whether the splat overlay is visible */
        this.visible = false;

        /** @type {boolean} Whether gsplat.js has been loaded */
        this._loaded = false;

        /** @type {boolean} Whether loading is in progress */
        this._loading = false;

        /** @type {number} Opacity 0-1 */
        this.opacity = 0.8;

        /** @type {string|null} Info about the loaded splat */
        this.splatInfo = null;
    }

    /**
     * Lazily load the gsplat.js library from CDN.
     * @returns {Promise<Object>} The SPLAT module namespace
     */
    async _loadLibrary() {
        if (this.SPLAT) return this.SPLAT;
        if (this._loading) {
            // Wait for in-progress load
            while (this._loading) {
                await new Promise(function (r) { setTimeout(r, 100); });
            }
            return this.SPLAT;
        }

        this._loading = true;
        try {
            this.SPLAT = await import('https://cdn.jsdelivr.net/npm/gsplat@latest');
            this._loaded = true;
            return this.SPLAT;
        } catch (err) {
            console.error('Failed to load gsplat.js from CDN:', err);
            throw err;
        } finally {
            this._loading = false;
        }
    }

    /**
     * Initialize the splat renderer. Creates a canvas and gsplat.js objects.
     * Called lazily on first splat load.
     */
    async _initRenderer() {
        if (this.renderer) return;

        const SPLAT = await this._loadLibrary();

        // Create canvas for gsplat.js — placed BEHIND the Three.js canvas
        this.canvas = document.createElement('canvas');
        this.canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;';
        this.canvas.width = this.container.clientWidth || 400;
        this.canvas.height = this.container.clientHeight || 300;

        // Insert before Three.js canvas so splats render behind the skeleton
        var threeCanvas = this.container.querySelector('canvas');
        if (threeCanvas) {
            // Make the Three.js canvas transparent so we can see splats behind it
            this.container.insertBefore(this.canvas, threeCanvas);
        } else {
            this.container.appendChild(this.canvas);
        }

        // Initialize gsplat.js components
        this.renderer = new SPLAT.WebGLRenderer(this.canvas);
        this.scene = new SPLAT.Scene();
        this.camera = new SPLAT.Camera();

        // Initial size
        this.renderer.setSize(this.canvas.width, this.canvas.height);
    }

    /**
     * Load a .splat or .ply file into the scene.
     * @param {File|string} fileOrUrl - File object or URL string
     * @param {Function} [onProgress] - Progress callback (0-1)
     * @returns {Promise<Object>} The loaded splat object
     */
    async loadSplat(fileOrUrl, onProgress) {
        await this._initRenderer();
        const SPLAT = this.SPLAT;

        // Clear previous splat
        if (this.currentSplat) {
            this.scene.reset();
            this.currentSplat = null;
        }

        var progressCb = onProgress || function () {};
        var splat;

        if (typeof fileOrUrl === 'string') {
            // URL string
            if (fileOrUrl.endsWith('.ply')) {
                splat = await SPLAT.PLYLoader.LoadAsync(fileOrUrl, this.scene, progressCb, '');
            } else {
                splat = await SPLAT.Loader.LoadAsync(fileOrUrl, this.scene, progressCb);
            }
            this.splatInfo = fileOrUrl.split('/').pop();
        } else if (fileOrUrl instanceof File) {
            // File object
            if (fileOrUrl.name.endsWith('.ply')) {
                splat = await SPLAT.PLYLoader.LoadFromFileAsync(fileOrUrl, this.scene, progressCb, '');
            } else {
                splat = await SPLAT.Loader.LoadFromFileAsync(fileOrUrl, this.scene, progressCb);
            }
            this.splatInfo = fileOrUrl.name;
        } else {
            throw new Error('loadSplat: expected File or URL string');
        }

        this.currentSplat = splat;
        this.visible = true;
        this.canvas.style.display = '';

        return splat;
    }

    /**
     * Synchronize the gsplat.js camera with the Three.js camera.
     * Copies position, rotation, and projection parameters.
     */
    syncCamera() {
        if (!this.camera || !this.threeCamera || !this.SPLAT) return;

        var SPLAT = this.SPLAT;
        var pos = this.threeCamera.position;
        var quat = this.threeCamera.quaternion;

        // Copy position
        this.camera.position = new SPLAT.Vector3(pos.x, pos.y, pos.z);

        // Copy rotation (Three.js Quaternion → gsplat.js Quaternion)
        // gsplat.js Quaternion constructor: (w, x, y, z)
        this.camera.rotation = new SPLAT.Quaternion(quat.w, quat.x, quat.y, quat.z);

        // Compute focal length from FOV:
        // fy = (height/2) / tan(fov/2)
        var h = this.canvas.height || 1;
        var w = this.canvas.width || 1;
        var fovRad = this.threeCamera.fov * Math.PI / 180;
        var fy = (h / 2) / Math.tan(fovRad / 2);
        var fx = fy; // square pixels

        this.camera.data.fx = fx;
        this.camera.data.fy = fy;
        this.camera.data.near = this.threeCamera.near;
        this.camera.data.far = this.threeCamera.far;
        this.camera.data.width = w;
        this.camera.data.height = h;

        this.camera.update();
    }

    /**
     * Render one frame. Call this from the main render loop.
     */
    render() {
        if (!this.visible || !this.currentSplat || !this.renderer) return;

        this.syncCamera();
        this.renderer.render(this.scene, this.camera);
    }

    /**
     * Set visibility of the splat overlay.
     * @param {boolean} vis
     */
    setVisible(vis) {
        this.visible = vis;
        if (this.canvas) {
            this.canvas.style.display = vis ? '' : 'none';
        }
    }

    /**
     * Toggle visibility.
     * @returns {boolean} New visibility state
     */
    toggleVisible() {
        this.setVisible(!this.visible);
        return this.visible;
    }

    /**
     * Set opacity of the splat canvas.
     * @param {number} opacity - 0 to 1
     */
    setOpacity(opacity) {
        this.opacity = Math.max(0, Math.min(1, opacity));
        if (this.canvas) {
            this.canvas.style.opacity = String(this.opacity);
        }
    }

    /**
     * Handle container resize.
     * @param {number} [width] - Override width
     * @param {number} [height] - Override height
     */
    resize(width, height) {
        if (!this.canvas || !this.renderer) return;

        var w = width || this.container.clientWidth;
        var h = height || this.container.clientHeight;
        if (w === 0 || h === 0) return;

        this.canvas.width = w;
        this.canvas.height = h;
        this.renderer.setSize(w, h);
    }

    /**
     * Apply a rigid transform (position, rotation, scale) to the loaded splat.
     * Useful for aligning coordinate systems.
     * @param {Object} transform - { position: [x,y,z], rotation: [rx,ry,rz], scale: [sx,sy,sz] }
     */
    applyTransform(transform) {
        if (!this.currentSplat || !this.SPLAT) return;
        var SPLAT = this.SPLAT;

        if (transform.position) {
            this.currentSplat.position = new SPLAT.Vector3(
                transform.position[0], transform.position[1], transform.position[2]
            );
            this.currentSplat.applyPosition();
        }
        if (transform.rotation) {
            var euler = new SPLAT.Vector3(
                transform.rotation[0], transform.rotation[1], transform.rotation[2]
            );
            this.currentSplat.rotation = SPLAT.Quaternion.FromEuler(euler);
            this.currentSplat.applyRotation();
        }
        if (transform.scale) {
            this.currentSplat.scale = new SPLAT.Vector3(
                transform.scale[0], transform.scale[1], transform.scale[2]
            );
            this.currentSplat.applyScale();
        }
    }

    /**
     * Clean up all resources.
     */
    dispose() {
        if (this.scene) {
            this.scene.reset();
        }
        if (this.canvas && this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }
        this.renderer = null;
        this.scene = null;
        this.camera = null;
        this.currentSplat = null;
        this.canvas = null;
        this.visible = false;
    }
}
