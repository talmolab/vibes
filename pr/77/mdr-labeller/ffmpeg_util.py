"""Tiny ffmpeg encode helpers (no cv2 dependency) — H.264/yuv420p per project video policy."""
import subprocess
import numpy as np


def encode_mp4(frames, fps, out):
    """Pipe a list of BGR uint8 frames to ffmpeg -> H.264 mp4 (browser/loop friendly)."""
    h, w = frames[0].shape[:2]
    cmd = ["ffmpeg", "-y", "-f", "rawvideo", "-vcodec", "rawvideo", "-pix_fmt", "bgr24",
           "-s", f"{w}x{h}", "-r", str(fps), "-i", "-",
           "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "fast", "-crf", "24",
           "-movflags", "+faststart", "-loglevel", "error", out]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for fr in frames:
        p.stdin.write(np.ascontiguousarray(fr, dtype=np.uint8).tobytes())
    p.stdin.close()
    if p.wait() != 0:
        raise RuntimeError("ffmpeg mp4 encode failed")


def encode_jpg(frame, out):
    """Single BGR frame -> jpg (used for the cheap idle poster)."""
    h, w = frame.shape[:2]
    cmd = ["ffmpeg", "-y", "-f", "rawvideo", "-vcodec", "rawvideo", "-pix_fmt", "bgr24",
           "-s", f"{w}x{h}", "-i", "-", "-frames:v", "1", "-loglevel", "error", out]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    p.stdin.write(np.ascontiguousarray(frame, dtype=np.uint8).tobytes())
    p.stdin.close()
    if p.wait() != 0:
        raise RuntimeError("ffmpeg jpg encode failed")
