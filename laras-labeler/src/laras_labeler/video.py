"""VideoManager: authoritative frame serving + pose transport (PLAN.md §7).

- Frames come from sleap-io's video backend (exact get_frame(idx)) -> JPEG, LRU-cached.
- Poses come from poseio's vectorized HDF5 read (falling back to Labels.numpy) -> (F, T, N, 3)
  float32, sent as a little-endian binary blob (shape in the X-Pose-Shape header).
"""

from __future__ import annotations

import io
import threading
from collections import OrderedDict
from pathlib import Path

import numpy as np
import sleap_io as sio
from PIL import Image

from . import poseio


class OpenVideo:
    """A lazily-opened sleap-io Labels + Video, with cached pose array.

    Constructing this is cheap: the sleap-io `Labels` object costs seconds to build, so it is loaded
    only when something actually needs it (frame serving, skeleton edges). Poses, node names and track
    names all come from `poseio`'s HDF5 reads, so a feature build never materializes it at all."""

    def __init__(self, video_path: str, slp_path: str | None = None,
                 n_frames_hint: int | None = None) -> None:
        self.source = str(slp_path or video_path)
        # Callers (and the HTTP layer) rely on a missing source failing here, as FileNotFoundError.
        if not Path(self.source).exists():
            raise FileNotFoundError(self.source)
        self._labels: sio.Labels | None = None
        self._header: poseio.PoseHeader | None = None
        self._header_read = False
        self._poses: np.ndarray | None = None
        self._n_frames_hint = n_frames_hint

    @property
    def labels(self) -> sio.Labels:
        if self._labels is None:
            self._labels = sio.load_file(self.source)
        return self._labels

    @property
    def video(self):
        return self.labels.videos[0]

    @property
    def header(self) -> poseio.PoseHeader | None:
        """Node/track names from the .slp's JSON header (~2 ms), or None for a non-.slp source."""
        if not self._header_read:
            self._header = poseio.read_header(self.source)
            self._header_read = True
        return self._header

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

    @property
    def node_names(self) -> list[str]:
        h = self.header
        return list(h.node_names) if h else list(self.labels.skeletons[0].node_names)

    @property
    def track_names(self) -> list[str]:
        h = self.header
        return list(h.track_names) if h else [t.name for t in self.labels.tracks]

    def poses(self) -> np.ndarray:
        if self._poses is None:
            # (F, T, N, 3) = [x, y, score]; padded to full video length, NaN for gaps.
            fast = poseio.read_poses(self.source, n_frames_hint=self._n_frames_hint,
                                     header=self.header)
            if fast is None:
                fast = self.labels.numpy(return_confidence=True).astype("float32")
            self._poses = fast
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
            # n_frames was recorded from video.shape[0] at add_video time — the same length sleap-io
            # pads Labels.numpy() to — so passing it lets the pose read skip opening the video.
            ov = OpenVideo(entry["video_path"], entry.get("slp_path"), entry.get("n_frames"))
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
