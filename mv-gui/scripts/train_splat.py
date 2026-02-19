#!/usr/bin/env python3
"""
train_splat.py — Offline 3D Gaussian Splatting training pipeline.

Extracts frames from multi-camera videos, converts calibration to COLMAP format,
and trains 3D Gaussian Splats using gsplat or nerfstudio. Outputs .ply files
that can be loaded in the mv-gui 3D viewport.

Environment Setup (conda — install CUDA + PyTorch together to avoid mismatches):

    # 1. Create env with CUDA toolkit
    conda create -n gsplat -y python=3.10 cuda-toolkit=11.8 \
        -c "nvidia/label/cuda-11.8.0" -c defaults

    # 2. Activate
    conda activate gsplat

    # 3. PyTorch + CUDA (must match toolkit version)
    pip install torch==2.1.2+cu118 torchvision==0.16.2+cu118 \
        --extra-index-url https://download.pytorch.org/whl/cu118

    # 4. Remaining dependencies
    pip install opencv-python numpy gsplat nerfstudio toml

Usage:
    python scripts/train_splat.py \
        --videos back.mp4 left.mp4 right.mp4 top.mp4 \
        --calibration calibration.toml \
        --frames 0,100,200,300 \
        --output splats/ \
        --iterations 3000

Output:
    splats/
        frame_0000.ply
        frame_0100.ply
        frame_0200.ply
        frame_0300.ply
        manifest.json
"""

import argparse
import json
import os
import sys

import cv2
import numpy as np


def parse_calibration_toml(path):
    """Parse calibration TOML file into camera parameters.

    Returns list of dicts with keys:
        name, matrix (3x3), distortions (5,), rvec (3,), tvec (3,), size (2,)
    """
    try:
        import tomllib
    except ImportError:
        import toml as tomllib

    with open(path, "rb" if hasattr(tomllib, "load") else "r") as f:
        data = (
            tomllib.load(f)
            if hasattr(tomllib, "load")
            else tomllib.loads(f.read())
        )

    cameras = []
    for cam_data in data.get("cameras", []):
        cam = {
            "name": cam_data["name"],
            "matrix": np.array(cam_data["matrix"], dtype=np.float64),
            "distortions": np.array(cam_data["distortions"], dtype=np.float64),
            "rvec": np.array(cam_data["rotation"], dtype=np.float64),
            "tvec": np.array(cam_data["translation"], dtype=np.float64),
            "size": cam_data["size"],
        }
        cameras.append(cam)
    return cameras


def extract_frame(video_path, frame_idx):
    """Extract a single frame from a video file.

    Returns BGR numpy array or None if frame not found.
    """
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"  Warning: Cannot open {video_path}")
        return None

    cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
    ret, frame = cap.read()
    cap.release()

    if not ret:
        print(f"  Warning: Cannot read frame {frame_idx} from {video_path}")
        return None

    return frame


def write_colmap_cameras(cameras, output_dir):
    """Write cameras in COLMAP text format for nerfstudio/gsplat.

    Creates cameras.txt and images.txt in COLMAP format.
    """
    cam_file = os.path.join(output_dir, "cameras.txt")
    with open(cam_file, "w") as f:
        f.write("# Camera list with one line of data per camera:\n")
        f.write("#   CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]\n")
        for i, cam in enumerate(cameras):
            fx = cam["matrix"][0, 0]
            fy = cam["matrix"][1, 1]
            cx = cam["matrix"][0, 2]
            cy = cam["matrix"][1, 2]
            w, h = cam["size"]
            # PINHOLE model: fx, fy, cx, cy
            f.write(f"{i + 1} PINHOLE {w} {h} {fx} {fy} {cx} {cy}\n")

    return cam_file


def write_colmap_images(cameras, frame_idx, output_dir):
    """Write image list in COLMAP text format.

    Each camera contributes one image per frame.
    """
    img_file = os.path.join(output_dir, "images.txt")
    with open(img_file, "w") as f:
        f.write("# Image list with two lines of data per image:\n")
        f.write("#   IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME\n")
        f.write("#   POINTS2D[] as (X, Y, POINT3D_ID)\n")

        for i, cam in enumerate(cameras):
            # Convert rvec to rotation matrix then to quaternion
            R, _ = cv2.Rodrigues(cam["rvec"])
            t = cam["tvec"]

            # Rotation matrix to quaternion (w, x, y, z)
            quat = rotation_matrix_to_quaternion(R)
            qw, qx, qy, qz = quat

            img_name = f"{cam['name']}_frame_{frame_idx:06d}.png"
            f.write(
                f"{i + 1} {qw} {qx} {qy} {qz} {t[0]} {t[1]} {t[2]} "
                f"{i + 1} {img_name}\n"
            )
            f.write("\n")  # Empty points line

    return img_file


def rotation_matrix_to_quaternion(R):
    """Convert 3x3 rotation matrix to quaternion (w, x, y, z)."""
    trace = R[0, 0] + R[1, 1] + R[2, 2]

    if trace > 0:
        s = 0.5 / np.sqrt(trace + 1.0)
        w = 0.25 / s
        x = (R[2, 1] - R[1, 2]) * s
        y = (R[0, 2] - R[2, 0]) * s
        z = (R[1, 0] - R[0, 1]) * s
    elif R[0, 0] > R[1, 1] and R[0, 0] > R[2, 2]:
        s = 2.0 * np.sqrt(1.0 + R[0, 0] - R[1, 1] - R[2, 2])
        w = (R[2, 1] - R[1, 2]) / s
        x = 0.25 * s
        y = (R[0, 1] + R[1, 0]) / s
        z = (R[0, 2] + R[2, 0]) / s
    elif R[1, 1] > R[2, 2]:
        s = 2.0 * np.sqrt(1.0 + R[1, 1] - R[0, 0] - R[2, 2])
        w = (R[0, 2] - R[2, 0]) / s
        x = (R[0, 1] + R[1, 0]) / s
        y = 0.25 * s
        z = (R[1, 2] + R[2, 1]) / s
    else:
        s = 2.0 * np.sqrt(1.0 + R[2, 2] - R[0, 0] - R[1, 1])
        w = (R[1, 0] - R[0, 1]) / s
        x = (R[0, 2] + R[2, 0]) / s
        y = (R[1, 2] + R[2, 1]) / s
        z = 0.25 * s

    return np.array([w, x, y, z])


def prepare_frame_data(cameras, video_paths, frame_idx, output_dir):
    """Extract frames from all cameras and write COLMAP-format data.

    Returns path to the frame working directory.
    """
    frame_dir = os.path.join(output_dir, f"frame_{frame_idx:06d}")
    images_dir = os.path.join(frame_dir, "images")
    sparse_dir = os.path.join(frame_dir, "sparse", "0")
    os.makedirs(images_dir, exist_ok=True)
    os.makedirs(sparse_dir, exist_ok=True)

    # Extract frames
    for cam, video_path in zip(cameras, video_paths):
        frame = extract_frame(video_path, frame_idx)
        if frame is not None:
            img_name = f"{cam['name']}_frame_{frame_idx:06d}.png"
            cv2.imwrite(os.path.join(images_dir, img_name), frame)

    # Write COLMAP camera and image files
    write_colmap_cameras(cameras, sparse_dir)
    write_colmap_images(cameras, frame_idx, sparse_dir)

    # Write empty points3D.txt (needed by nerfstudio)
    with open(os.path.join(sparse_dir, "points3D.txt"), "w") as f:
        f.write("# 3D point list\n")

    return frame_dir


def train_splat_nerfstudio(frame_dir, output_ply, iterations=3000):
    """Train 3DGS using nerfstudio's splatfacto method.

    Requires nerfstudio to be installed.
    """
    try:
        import subprocess

        cmd = [
            "ns-train",
            "splatfacto",
            "--data",
            frame_dir,
            "--max-num-iterations",
            str(iterations),
            "--output-dir",
            os.path.join(frame_dir, "outputs"),
            "colmap",
        ]
        print(f"  Running: {' '.join(cmd)}")
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"  nerfstudio error: {result.stderr}")
            return False

        # Find the output PLY file
        outputs_dir = os.path.join(frame_dir, "outputs")
        for root, dirs, files in os.walk(outputs_dir):
            for f in files:
                if f.endswith(".ply"):
                    import shutil

                    shutil.copy(os.path.join(root, f), output_ply)
                    return True

        print("  Warning: No .ply output found from nerfstudio")
        return False

    except (ImportError, FileNotFoundError):
        print("  nerfstudio not found. Install with: pip install nerfstudio")
        return False


def create_manifest(output_dir, frame_indices, camera_names):
    """Create manifest.json for the mv-gui to load per-frame splats."""
    frames = {}
    for idx in frame_indices:
        ply_name = f"frame_{idx:06d}.ply"
        ply_path = os.path.join(output_dir, ply_name)
        if os.path.exists(ply_path):
            frames[str(idx)] = ply_name

    manifest = {
        "frames": frames,
        "training_config": {
            "cameras": camera_names,
        },
    }

    manifest_path = os.path.join(output_dir, "manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    return manifest_path


def main():
    parser = argparse.ArgumentParser(
        description="Train 3D Gaussian Splats from multi-camera video"
    )
    parser.add_argument(
        "--videos", nargs="+", required=True, help="Video file paths (one per camera)"
    )
    parser.add_argument(
        "--calibration", required=True, help="Calibration TOML file path"
    )
    parser.add_argument(
        "--frames",
        required=True,
        help="Comma-separated frame indices to train on",
    )
    parser.add_argument(
        "--output", default="splats/", help="Output directory for .ply files"
    )
    parser.add_argument(
        "--iterations", type=int, default=3000, help="Training iterations per frame"
    )
    parser.add_argument(
        "--method",
        choices=["nerfstudio"],
        default="nerfstudio",
        help="Training method",
    )

    args = parser.parse_args()

    # Parse inputs
    frame_indices = [int(x.strip()) for x in args.frames.split(",")]
    cameras = parse_calibration_toml(args.calibration)
    camera_names = [c["name"] for c in cameras]

    print(f"Cameras: {camera_names}")
    print(f"Videos: {args.videos}")
    print(f"Frames: {frame_indices}")
    print(f"Output: {args.output}")
    print(f"Iterations: {args.iterations}")
    print()

    if len(args.videos) != len(cameras):
        print(
            f"Error: {len(args.videos)} videos but {len(cameras)} cameras in calibration"
        )
        sys.exit(1)

    os.makedirs(args.output, exist_ok=True)

    # Process each frame
    for frame_idx in frame_indices:
        print(f"Processing frame {frame_idx}...")

        # Prepare COLMAP data
        frame_dir = prepare_frame_data(
            cameras, args.videos, frame_idx, args.output
        )
        output_ply = os.path.join(args.output, f"frame_{frame_idx:06d}.ply")

        # Train
        if args.method == "nerfstudio":
            success = train_splat_nerfstudio(
                frame_dir, output_ply, args.iterations
            )
        else:
            print(f"  Unknown method: {args.method}")
            success = False

        if success:
            print(f"  Saved: {output_ply}")
        else:
            print(f"  Failed to train frame {frame_idx}")
        print()

    # Create manifest
    manifest_path = create_manifest(args.output, frame_indices, camera_names)
    print(f"Manifest: {manifest_path}")
    print("Done!")


if __name__ == "__main__":
    main()
