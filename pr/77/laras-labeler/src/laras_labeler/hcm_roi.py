"""Fetch a clip's arena ROIs from the HCM database on demand (best-effort).

The HCM `recordings.rois` column holds per-recording GeoJSON polygons from UNet segmentation
(class_name 'water' = spout, 'cage-outer' = arena boundary).

We prefer THIS recording's OWN polygon, so a clip is scored against the arena as it actually was —
the spout in particular does get nudged between recordings (~19 px on cam_07). When the clip can't be
matched to a recording, or that recording has no valid segmentation, we fall back per class to the
camera MEDOID polygon (the recording whose polygon center is closest to the camera's median center),
which is robust to a single-recording segmentation glitch — that is what happens for a recording whose
rois status is 'change-detected' rather than 'valid'. Same medoid idea as
scripts/import_hcm_spout_roi.py, but recording-first and callable in-process so the labeler can
auto-fill a newly-loaded clip's ROIs.

Everything here degrades gracefully: sqlalchemy is imported lazily and any DB error (not installed,
off-VPN, timeout, no ROI) returns None rather than raising — so video loading never blocks on it.
"""
from __future__ import annotations

import os
import re

DATABASE_URL = os.environ.get("HCM_DATABASE_URL", "")  # set HCM_DATABASE_URL locally; do not commit credentials
CAM_RE = re.compile(r"cam[_-]?0*(\d+)")

# HCM segmentation class_name -> labeler ROI config field
ROI_CLASS = {"water": "spout_roi", "cage-outer": "cage_roi"}

# clip ids embed the recording: ..._2025_06_16_00_01_05_cam_07.12.predictions... -> the directory
# 2025-06-16-00-01-05 and file cam_07.12.mp4 in recordings.video_path. Anchored on the cam token so
# the leading session date can't be mistaken for the recording start.
REC_RE = re.compile(r"(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(cam_\d+)\.(\d+)")

_RECORDING_SQL = """
SELECT feat->'geometry'->'coordinates'->0 AS ring
FROM recordings r
CROSS JOIN LATERAL jsonb_array_elements(r.rois->'features') AS feat
WHERE r.video_path LIKE :pat AND jsonb_typeof(r.rois) = 'object'
  AND r.rois->>'status' LIKE 'valid%'
  AND feat->'properties'->>'class_name' = :cls
LIMIT 1;
"""

# Medoid over the most recent MEDOID_SAMPLE recordings, not all of them: a camera can have >12k
# valid-ROI recordings (cam_07 did), and unnesting every polygon takes ~45 s. Sampling 300 picks a
# polygon with the same centroid to <0.1 px in ~0.2 s, because a camera's arena is fixed.
MEDOID_SAMPLE = 300

_MEDOID_SQL = """
WITH recs AS (
  SELECT r.id, r.rois
  FROM recordings r JOIN batches b ON r.batch_id = b.batch_id
  WHERE b.cage = :cam AND jsonb_typeof(r.rois) = 'object' AND r.rois->>'status' LIKE 'valid%'
  ORDER BY r.id DESC LIMIT :lim
),
cand AS (
  SELECT recs.id, feat->'geometry'->'coordinates'->0 AS ring
  FROM recs CROSS JOIN LATERAL jsonb_array_elements(recs.rois->'features') AS feat
  WHERE feat->'properties'->>'class_name' = :cls
),
ctr AS (
  SELECT c.id, (MIN((pt->>0)::float)+MAX((pt->>0)::float))/2 AS cx,
               (MIN((pt->>1)::float)+MAX((pt->>1)::float))/2 AS cy
  FROM cand c CROSS JOIN LATERAL jsonb_array_elements(c.ring) AS pt GROUP BY c.id
),
med AS (
  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY cx) AS mx,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY cy) AS my FROM ctr
)
SELECT c.ring FROM ctr JOIN cand c USING (id) CROSS JOIN med
ORDER BY sqrt(power(ctr.cx-med.mx,2)+power(ctr.cy-med.my,2)) ASC LIMIT 1;
"""


def camera_of(video_id: str) -> str | None:
    m = CAM_RE.search(video_id or "")
    return f"cam_{int(m.group(1)):02d}" if m else None


def recording_like(video_id: str) -> str | None:
    """LIKE pattern selecting the ONE recording a clip was cut from, or None if unparseable."""
    m = REC_RE.search(video_id or "")
    if not m:
        return None
    y, mo, d, hh, mm, ss, cam, hour = m.groups()
    return f"%/{y}-{mo}-{d}-{hh}-{mm}-{ss}/{cam}.{hour}.mp4"


def _clean_ring(ring) -> list[list[float]]:
    pts: list[list[float]] = []
    for p in ring:
        xy = [round(float(p[0]), 1), round(float(p[1]), 1)]
        if not pts or pts[-1] != xy:
            pts.append(xy)
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    return pts


def fetch_rois(video_id: str, classes=("cage-outer", "water"), timeout: int = 8) -> dict:
    """Best-effort: {roi_field: polygon} for a clip's camera, e.g. {'cage_roi': [[x,y],...]}.
    Returns {} (never raises) if sqlalchemy is missing, the DB is unreachable, the camera can't be
    parsed, or no valid polygon exists — so callers can treat it as an optional enrichment."""
    cam = camera_of(video_id)
    if not cam:
        return {}
    try:
        from sqlalchemy import create_engine, text
    except Exception:
        return {}
    if not DATABASE_URL:
        # No credential configured. Returning early rather than letting create_engine("") raise into
        # the catch-all below keeps "nobody set HCM_DATABASE_URL" distinguishable from "the DB is down"
        # for anyone reading a log — both end in {}, but only one is a misconfiguration.
        return {}
    out: dict = {}
    source: dict = {}
    pat = recording_like(video_id)
    try:
        engine = create_engine(DATABASE_URL, connect_args={"connect_timeout": timeout})
        with engine.connect() as conn:
            for cls in classes:
                field = ROI_CLASS.get(cls)
                if not field:
                    continue
                # this recording's own polygon first, camera medoid only as a fallback
                attempts = [(_MEDOID_SQL, {"cam": cam, "cls": cls, "lim": MEDOID_SAMPLE}, "camera medoid")]
                if pat:   # only attempt the per-recording lookup when the clip id names a recording
                    attempts.insert(0, (_RECORDING_SQL, {"pat": pat, "cls": cls}, "recording"))
                for sql, params, src in attempts:
                    row = conn.execute(text(sql), params).first()
                    if row and row[0]:
                        poly = _clean_ring(row[0])
                        if len(poly) >= 3:
                            out[field], source[field] = poly, src
                            break
    except Exception:
        return {}
    return {"camera": cam, "source": source, **out} if out else {}
