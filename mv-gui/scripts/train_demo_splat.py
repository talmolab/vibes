#!/usr/bin/env python3
"""
train_demo_splat.py — Train a Gaussian splat from the mv-gui demo data.

Recreates the synthetic calibration from demo-data.js, extracts frame 0
from all 4 demo videos, and trains a 3DGS using the gsplat library directly
(no nerfstudio dependency needed).

Usage (from mv-gui/ directory):
    conda run -n gsplat python scripts/train_demo_splat.py

Output:
    sample_session/splats/frame_000000.ply
    sample_session/splats/manifest.json
"""

import json
import os
import struct
import sys

import cv2
import numpy as np
import torch


# ─── Camera calibration (mirrors demo-data.js exactly) ────────────────────────

def look_at(eye, target):
    """Compute rotation matrix and translation for a camera at `eye` looking at `target`.

    Mirrors the lookAt() function in demo-data.js.
    World coordinate system: Z-up.
    OpenCV camera convention: X-right, Y-down, Z-into-scene.
    """
    eye = np.array(eye, dtype=np.float64)
    target = np.array(target, dtype=np.float64)

    fwd = target - eye
    fwd = fwd / np.linalg.norm(fwd)

    # World up
    if abs(fwd[2]) > 0.95:
        up = np.array([0.0, -1.0, 0.0])
    else:
        up = np.array([0.0, 0.0, 1.0])

    x = np.cross(up, fwd)
    x = x / np.linalg.norm(x)

    y = np.cross(fwd, x)
    y = y / np.linalg.norm(y)

    R = np.array([x, y, fwd])  # 3x3, rows are camera axes
    t = -R @ eye

    return R, t


def create_demo_calibration(actual_w=None, actual_h=None):
    """Recreate the 4-camera calibration from demo-data.js.

    The demo calibration is defined for 640x480. If actual video dimensions
    are different, scale intrinsics proportionally.
    """
    DEMO_W, DEMO_H = 640, 480
    W = actual_w or DEMO_W
    H = actual_h or DEMO_H
    sx = W / DEMO_W  # scale factor for x
    sy = H / DEMO_H  # scale factor for y

    target = [0, 0, 0]

    # Base intrinsics at 640x480 resolution
    cam_defs = [
        ("back", [0, -350, 150], 600, 600, 320, 240),
        ("mid", [250, 250, 120], 620, 620, 320, 240),
        ("side", [-350, 30, 80], 580, 580, 320, 240),
        ("top", [0, 0, 400], 550, 550, 320, 240),
    ]

    cameras = []
    for name, eye, fx, fy, cx, cy in cam_defs:
        R, t = look_at(eye, target)
        cameras.append({
            "name": name, "R": R, "t": t,
            "fx": fx * sx, "fy": fy * sy,
            "cx": cx * sx, "cy": cy * sy,
            "w": W, "h": H
        })

    return cameras


# ─── Frame extraction ─────────────────────────────────────────────────────────

def extract_frame(video_path, frame_idx=0):
    """Extract a single frame from a video file. Returns BGR numpy array."""
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"  ERROR: Cannot open {video_path}")
        return None

    cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
    ret, frame = cap.read()
    cap.release()

    if not ret:
        print(f"  ERROR: Cannot read frame {frame_idx} from {video_path}")
        return None

    return frame


# ─── 3DGS Training using gsplat ──────────────────────────────────────────────

def train_gaussian_splat(cameras, images, output_ply, iterations=2000, num_points=5000):
    """Train a 3D Gaussian Splat from multi-view images using gsplat.

    This is a minimal training loop that:
    1. Initializes random 3D Gaussians in the scene
    2. Renders them from each camera viewpoint
    3. Optimizes to match the input images
    """
    from gsplat import rasterization

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"  Device: {device}")

    if not torch.cuda.is_available():
        print("  WARNING: No CUDA device found. Training will be very slow.")

    # Prepare camera data as tensors
    num_cams = len(cameras)
    H, W = images[0].shape[:2]

    # Convert images to float tensors (0-1, RGB)
    gt_images = []
    for img in images:
        img_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        gt_images.append(torch.from_numpy(img_rgb).to(device))

    # Build camera matrices (world-to-camera)
    viewmats = []
    Ks = []
    for cam in cameras:
        # 4x4 world-to-camera matrix
        viewmat = np.eye(4, dtype=np.float32)
        viewmat[:3, :3] = cam["R"]
        viewmat[:3, 3] = cam["t"]
        viewmats.append(torch.from_numpy(viewmat).to(device))

        # 3x3 intrinsic matrix
        K = np.array([
            [cam["fx"], 0, cam["cx"]],
            [0, cam["fy"], cam["cy"]],
            [0, 0, 1]
        ], dtype=np.float32)
        Ks.append(torch.from_numpy(K).to(device))

    # Initialize Gaussians
    # Place random points in the scene volume (the demo scene is roughly ±50mm around origin)
    print(f"  Initializing {num_points} Gaussians...")
    means = torch.randn(num_points, 3, device=device) * 50.0  # xyz positions
    means.requires_grad_(True)

    # Log-scale (so actual scale = exp(log_scales))
    log_scales = torch.zeros(num_points, 3, device=device) + np.log(5.0)
    log_scales.requires_grad_(True)

    # Quaternions (w, x, y, z) — start with identity
    quats = torch.zeros(num_points, 4, device=device)
    quats[:, 0] = 1.0
    quats.requires_grad_(True)

    # Colors (RGB, sigmoid-space)
    colors_raw = torch.zeros(num_points, 3, device=device)
    colors_raw.requires_grad_(True)

    # Opacities (sigmoid-space)
    opacities_raw = torch.zeros(num_points, 1, device=device) - 1.0  # start ~0.27
    opacities_raw.requires_grad_(True)

    # Optimizer
    optimizer = torch.optim.Adam([
        {"params": [means], "lr": 0.01},
        {"params": [log_scales], "lr": 0.005},
        {"params": [quats], "lr": 0.001},
        {"params": [colors_raw], "lr": 0.01},
        {"params": [opacities_raw], "lr": 0.01},
    ])

    print(f"  Training for {iterations} iterations...")

    for step in range(iterations):
        optimizer.zero_grad()

        total_loss = 0.0

        # Cycle through cameras
        cam_idx = step % num_cams

        # Current Gaussian parameters
        scales = torch.exp(log_scales)
        colors = torch.sigmoid(colors_raw)
        opacities = torch.sigmoid(opacities_raw).squeeze(-1)

        # Render
        renders, alphas, meta = rasterization(
            means=means,
            quats=quats / (quats.norm(dim=-1, keepdim=True) + 1e-8),
            scales=scales,
            opacities=opacities,
            colors=colors,
            viewmats=viewmats[cam_idx][None],  # [1, 4, 4]
            Ks=Ks[cam_idx][None],  # [1, 3, 3]
            width=W,
            height=H,
            packed=False,
        )

        # renders shape: [1, H, W, 3]
        rendered = renders[0]  # [H, W, 3]

        # L1 + SSIM-like loss
        gt = gt_images[cam_idx]
        l1_loss = torch.abs(rendered - gt).mean()

        total_loss = l1_loss
        total_loss.backward()
        optimizer.step()

        if step % 200 == 0 or step == iterations - 1:
            print(f"    Step {step:4d}/{iterations}: loss={total_loss.item():.4f} (cam={cameras[cam_idx]['name']})")

    # Export to PLY
    print(f"  Exporting {num_points} Gaussians to PLY...")
    export_gaussians_to_ply(
        means.detach().cpu().numpy(),
        torch.exp(log_scales).detach().cpu().numpy(),
        (quats / (quats.norm(dim=-1, keepdim=True) + 1e-8)).detach().cpu().numpy(),
        torch.sigmoid(colors_raw).detach().cpu().numpy(),
        torch.sigmoid(opacities_raw).detach().cpu().numpy().squeeze(-1),
        output_ply
    )
    print(f"  Saved: {output_ply}")
    return True


def export_gaussians_to_ply(means, scales, quats, colors, opacities, path):
    """Export Gaussian splat data as a .ply file compatible with gsplat.js viewer.

    Uses the standard 3DGS PLY format with spherical harmonics (DC only).
    """
    n = means.shape[0]

    # Convert colors to SH DC coefficients
    # color = sigmoid(sh_dc * C0 + 0.5) approximately, but the standard convention is:
    # SH DC coefficient = (color - 0.5) / C0 where C0 = 0.28209479177387814
    C0 = 0.28209479177387814
    sh_dc = (colors - 0.5) / C0

    # Convert opacities to logit (inverse sigmoid)
    opacities_logit = np.log(opacities / (1.0 - opacities + 1e-8) + 1e-8)

    # Log-space scales for PLY
    log_scales = np.log(scales + 1e-8)

    header = f"""ply
format binary_little_endian 1.0
element vertex {n}
property float x
property float y
property float z
property float nx
property float ny
property float nz
property float f_dc_0
property float f_dc_1
property float f_dc_2
property float opacity
property float scale_0
property float scale_1
property float scale_2
property float rot_0
property float rot_1
property float rot_2
property float rot_3
end_header
"""

    with open(path, "wb") as f:
        f.write(header.encode("ascii"))

        for i in range(n):
            # Position
            f.write(struct.pack("<fff", means[i, 0], means[i, 1], means[i, 2]))
            # Normals (unused, write zeros)
            f.write(struct.pack("<fff", 0.0, 0.0, 0.0))
            # SH DC (RGB)
            f.write(struct.pack("<fff", sh_dc[i, 0], sh_dc[i, 1], sh_dc[i, 2]))
            # Opacity (logit space)
            f.write(struct.pack("<f", opacities_logit[i]))
            # Scales (log space)
            f.write(struct.pack("<fff", log_scales[i, 0], log_scales[i, 1], log_scales[i, 2]))
            # Rotation quaternion (w, x, y, z)
            f.write(struct.pack("<ffff", quats[i, 0], quats[i, 1], quats[i, 2], quats[i, 3]))


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    # Paths
    script_dir = os.path.dirname(os.path.abspath(__file__))
    base_dir = os.path.dirname(script_dir)  # mv-gui/
    sample_dir = os.path.join(base_dir, "sample_session")
    output_dir = os.path.join(sample_dir, "splats")
    os.makedirs(output_dir, exist_ok=True)

    video_names = ["back.mp4", "mid.mp4", "side.mp4", "top.mp4"]
    frame_idx = 0

    print("=== Demo Gaussian Splat Training ===\n")

    # 1. Extract frame 0 from all videos (need resolution before calibration)
    print(f"1. Extracting frame {frame_idx} from all videos...")
    images = []
    for name in video_names:
        path = os.path.join(sample_dir, name)
        if not os.path.exists(path):
            print(f"   ERROR: Video not found: {path}")
            sys.exit(1)

        frame = extract_frame(path, frame_idx)
        if frame is None:
            sys.exit(1)

        images.append(frame)
        print(f"   {name}: {frame.shape[1]}x{frame.shape[0]}")

    # Get actual resolution from first video
    actual_h, actual_w = images[0].shape[:2]
    print(f"   Actual resolution: {actual_w}x{actual_h}")
    print()

    # 2. Create calibration scaled to actual video resolution
    print("2. Creating camera calibration...")
    cameras = create_demo_calibration(actual_w, actual_h)
    for cam in cameras:
        print(f"   {cam['name']}: fx={cam['fx']:.0f}, fy={cam['fy']:.0f}, pos={-np.linalg.solve(cam['R'], cam['t']).round(1)}")
    print()

    # Save extracted frames for reference
    frames_dir = os.path.join(output_dir, "frames")
    os.makedirs(frames_dir, exist_ok=True)
    for name, img in zip(video_names, images):
        cv2.imwrite(os.path.join(frames_dir, name.replace(".mp4", ".png")), img)
    print()

    # 3. Train
    print("3. Training Gaussian Splat...")
    output_ply = os.path.join(output_dir, f"frame_{frame_idx:06d}.ply")

    success = train_gaussian_splat(
        cameras, images, output_ply,
        iterations=3000,
        num_points=10000
    )

    if not success:
        print("Training failed!")
        sys.exit(1)
    print()

    # 4. Create manifest
    print("4. Creating manifest...")
    manifest = {
        "frames": {str(frame_idx): f"frame_{frame_idx:06d}.ply"},
        "training_config": {
            "cameras": [c["name"] for c in cameras],
            "iterations": 3000,
            "num_points": 10000,
        }
    }
    manifest_path = os.path.join(output_dir, "manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"   Manifest: {manifest_path}")

    print(f"\nDone! Load {output_ply} in the mv-gui 3D viewport.")


if __name__ == "__main__":
    main()
