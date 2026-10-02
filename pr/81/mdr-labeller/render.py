"""
render.py — per-event skeleton-overlay clip rendering for the refinement labeller.

A faithful port of utils.approach_behavior.clip_frames (same crop, rank colors,
approacher->approachee arrow, red contact dot) with two additions the web grid needs:
  * a variable frame count (short mp4 for a tile, single frame for the idle poster);
  * an on-disk cache keyed by (event, clip params) with a per-key render lock so
    concurrent requests for the same tile render once.

Renders reuse the real pipeline: it imports utils.approach_behavior for VIDEO_BASE,
TM_BASE, RANK_COLORS_BGR, SKELETON_EDGES, and event_track_ranks. Only the `approach`
source uses this module (it pulls in cv2 + the pipeline); the demo source does not.
"""
import os
import sys
import glob
import hashlib
import threading

import numpy as np
import cv2

from ffmpeg_util import encode_mp4, encode_jpg

_HCM = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _HCM not in sys.path:
    sys.path.insert(0, _HCM)
from utils import approach_behavior as ab  # noqa: E402

_locks = {}
_locks_guard = threading.Lock()


def _lock_for(key):
    with _locks_guard:
        lk = _locks.get(key)
        if lk is None:
            lk = _locks[key] = threading.Lock()
        return lk


def clip_params(clip_cfg):
    return dict(pad=int(clip_cfg.get("pad_before", 40)), win=int(clip_cfg.get("window", 160)),
                cell=int(clip_cfg.get("cell", 260)), fps=int(clip_cfg.get("fps", 50)))


def _cache_key(ev, p, kind):
    s = (f'{ev["cohort"]}|{ev["stem"]}|{ev["cs"]}|{ev["appr"]}|{ev["appe"]}'
         f'|{p["pad"]}|{p["win"]}|{p["cell"]}|{kind}')
    return hashlib.md5(s.encode()).hexdigest()[:16]


def _draw(fr, kp3, colors, appr, appe, tm, fi):
    """Overlay 3 rank-colored skeletons on frame `fr` (in-place) + approacher arrow."""
    for m in range(3):
        kp = kp3[m]
        col = colors[m]
        okp = np.isfinite(kp[:, 0])
        for ni in range(ab.N_NODES):
            if okp[ni]:
                cv2.circle(fr, (int(kp[ni, 0]), int(kp[ni, 1])), 4, col, -1)
        for u, v in ab.SKELETON_EDGES:
            if okp[u] and okp[v]:
                cv2.line(fr, (int(kp[u, 0]), int(kp[u, 1])), (int(kp[v, 0]), int(kp[v, 1])), col, 2)
    if appr is not None and appe is not None:
        ca = np.nanmean(tm[fi, :, :, appr], axis=0)
        cb = np.nanmean(tm[fi, :, :, appe], axis=0)
        if np.isfinite(ca).all() and np.isfinite(cb).all():
            cv2.arrowedLine(fr, (int(ca[0]), int(ca[1])), (int(cb[0]), int(cb[1])),
                            (255, 255, 255), 3, tipLength=0.3)


def render_bgr(ev, p, only_first=False):
    """Return a list of BGR frames for `ev` (single contact frame if only_first), or None."""
    coh, stem, cs = ev["cohort"], ev["stem"], int(ev["cs"])
    appr, appe = int(ev["appr"]), int(ev["appe"])
    hits = sorted(glob.glob(os.path.join(ab.VIDEO_BASE, coh, f"{stem}*.mp4")))
    if not hits:
        return None
    try:
        tm = np.load(f"{ab.TM_BASE}/{coh}/{stem}_tracks_matrix.npz")["tracks_matrix"]
    except Exception:
        return None
    ranks = ab.event_track_ranks(coh, stem, cs)
    colors = [ab.RANK_COLORS_BGR.get(ranks[m] if ranks else 0, (180, 180, 180)) for m in range(3)]

    f0 = max(0, cs - p["pad"])
    f1 = min(tm.shape[0], cs + p["win"])
    kx = tm[f0:f1, :, 0, :].ravel()
    ky = tm[f0:f1, :, 1, :].ravel()
    vx, vy = kx[np.isfinite(kx)], ky[np.isfinite(ky)]
    if len(vx) < 2:
        return None

    cap = cv2.VideoCapture(hits[0])
    W, H = int(cap.get(3)), int(cap.get(4))
    x0 = int(max(0, vx.min() - 100)); y0 = int(max(0, vy.min() - 100))
    x1 = int(min(W, vx.max() + 100)); y1 = int(min(H, vy.max() + 100))
    cw, ch = x1 - x0, y1 - y0
    if cw > ch:
        y0 = max(0, y0 - (cw - ch) // 2); y1 = min(H, y0 + cw)
    else:
        x0 = max(0, x0 - (ch - cw) // 2); x1 = min(W, x0 + ch)
    cell = p["cell"]
    contact_rel = cs - f0

    frames = []
    try:
        if only_first:
            cap.set(cv2.CAP_PROP_POS_FRAMES, cs)
            ret, fr = cap.read()
            if not ret:
                return None
            if cs < tm.shape[0]:
                _draw(fr, [tm[cs, :, :, m] for m in range(3)], colors, appr, appe, tm, cs)
            crop = fr[y0:y1, x0:x1]
            if not crop.size:
                return None
            c = cv2.resize(crop, (cell, cell))
            cv2.circle(c, (cell - 12, 12), 6, (50, 50, 255), -1)
            frames.append(c)
        else:
            cap.set(cv2.CAP_PROP_POS_FRAMES, f0)
            for rel in range(f1 - f0):
                ret, fr = cap.read()
                if not ret:
                    break
                fi = f0 + rel
                if fi < tm.shape[0]:
                    _draw(fr, [tm[fi, :, :, m] for m in range(3)], colors, appr, appe, tm, fi)
                crop = fr[y0:y1, x0:x1]
                if not crop.size:
                    continue
                c = cv2.resize(crop, (cell, cell))
                if rel >= contact_rel:
                    cv2.circle(c, (cell - 12, 12), 6, (50, 50, 255), -1)
                frames.append(c)
    finally:
        cap.release()
    return frames or None


def ensure_poster(ev, clip_cfg, cache_dir):
    p = clip_params(clip_cfg)
    d = os.path.join(cache_dir, "posters")
    os.makedirs(d, exist_ok=True)
    out = os.path.join(d, _cache_key(ev, p, "poster") + ".jpg")
    if os.path.exists(out):
        return out
    with _lock_for(out):
        if os.path.exists(out):
            return out
        fr = render_bgr(ev, p, only_first=True)
        if not fr:
            return None
        encode_jpg(fr[0], out)
        return out


def ensure_clip(ev, clip_cfg, cache_dir):
    p = clip_params(clip_cfg)
    d = os.path.join(cache_dir, "clips")
    os.makedirs(d, exist_ok=True)
    out = os.path.join(d, _cache_key(ev, p, "clip") + ".mp4")
    if os.path.exists(out):
        return out
    with _lock_for(out):
        if os.path.exists(out):
            return out
        fr = render_bgr(ev, p, only_first=False)
        if not fr:
            return None
        encode_mp4(fr, p["fps"], out)
        return out
