"""VideoManager: authoritative frame serving + pose transport (PLAN.md §7).

- Frames come from sleap-io's video backend (exact get_frame(idx)) -> JPEG, LRU-cached.
- Poses come from Labels.numpy(return_confidence=True) -> (F, T, N, 3) float32, sent as a
  little-endian binary blob (shape in the X-Pose-Shape header).
"""

from __future__ import annotations

import io
import threading
from collections import OrderedDict

import numpy as np
import sleap_io as sio
from PIL import Image


class OpenVideo:
    """A lazily-opened sleap-io Labels + Video, with cached pose array."""

    def __init__(self, video_path: str, slp_path: str | None = None) -> None:
        source = str(slp_path or video_path)
        self.labels = sio.load_file(source)
        self.video = self.labels.videos[0]
        self._poses: np.ndarray | None = None

    @property
    def n_frames(self) -> int:
        return int(self.video.shape[0])

    @property
    def fps(self) -> float:
        return float(self.video.fps or 30.0)

    @property
    def height(self) -> int:
        return int(self.video.shape[1])

    @property
    def width(self) -> int:
        return int(self.video.shape[2])

    def poses(self) -> np.ndarray:
        if self._poses is None:
            # (F, T, N, 3) = [x, y, score]; padded to full video length, NaN for gaps.
            self._poses = self.labels.numpy(return_confidence=True).astype("float32")
        return self._poses

    def skeleton(self) -> dict:
        sk = self.labels.skeletons[0]
        return {
            "nodes": list(sk.node_names),
            "edges": [list(e) for e in sk.edge_inds],
            "tracks": [t.name for t in self.labels.tracks],
        }

    def frame(self, idx: int) -> np.ndarray:
        return np.asarray(self.video[idx])


def encode_jpeg(img: np.ndarray, quality: int = 85) -> bytes:
    a = np.asarray(img)
    if a.ndim == 3 and a.shape[-1] == 1:
        a, mode = a[..., 0], "L"
    elif a.ndim == 2:
        mode = "L"
    else:
        mode = "RGB"
    im = Image.fromarray(a, mode=mode)
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


class VideoManager:
    def __init__(self, store, frame_cache_size: int = 256, jpeg_quality: int = 85) -> None:
        self.store = store  # ProjectStore
        self._open: dict[tuple[str, str], OpenVideo] = {}
        self._frames: "OrderedDict[tuple, bytes]" = OrderedDict()
        self._cap = frame_cache_size
        self._quality = jpeg_quality
        self._lock = threading.Lock()

    def _entry(self, pid: str, vid: str) -> dict:
        proj = self.store.get(pid)
        entry = proj.video(vid) if proj else None
        if entry is None:
            raise KeyError(f"{pid}/{vid}")
        return entry

    def _get(self, pid: str, vid: str) -> OpenVideo:
        key = (pid, vid)
        ov = self._open.get(key)
        if ov is None:
            entry = self._entry(pid, vid)
            ov = OpenVideo(entry["video_path"], entry.get("slp_path"))
            self._open[key] = ov
        return ov

    def forget(self, pid: str, vid: str) -> None:
        """Drop the cached handle + decoded frames for a video that's being removed."""
        with self._lock:
            self._open.pop((pid, vid), None)
            for k in [k for k in self._frames if k[0] == pid and k[1] == vid]:
                del self._frames[k]

    def meta(self, pid: str, vid: str) -> dict:
        e = self._entry(pid, vid)
        return {k: e[k] for k in ("video_id", "n_frames", "fps", "width", "height", "has_poses")}

    def skeleton(self, pid: str, vid: str) -> dict:
        return self._get(pid, vid).skeleton()

    def poses_blob(self, pid: str, vid: str) -> tuple[tuple[int, ...], bytes]:
        arr = self._get(pid, vid).poses()
        blob = np.ascontiguousarray(arr, dtype="<f4").tobytes()
        return arr.shape, blob

    def frame_jpeg(self, pid: str, vid: str, idx: int, gray: bool = True) -> bytes:
        key = (pid, vid, idx, gray)
        with self._lock:
            hit = self._frames.get(key)
            if hit is not None:
                self._frames.move_to_end(key)
                return hit
        ov = self._get(pid, vid)
        if idx < 0 or idx >= ov.n_frames:
            raise IndexError(idx)
        data = encode_jpeg(ov.frame(idx), self._quality)
        with self._lock:
            self._frames[key] = data
            self._frames.move_to_end(key)
            while len(self._frames) > self._cap:
                self._frames.popitem(last=False)
        return data
