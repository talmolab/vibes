"""Fetch a clip's arena ROIs from the HCM database on demand (best-effort).

The HCM `recordings.rois` column holds per-recording GeoJSON polygons from UNet segmentation
(class_name 'water' = spout, 'cage-outer' = arena boundary). A camera's ROI is fixed to within a few
pixels, so we take the MEDOID polygon for the camera (the recording whose polygon center is closest to
the camera's median center) — robust to a single-recording segmentation glitch. Mirrors
scripts/import_hcm_spout_roi.py, but callable in-process so the labeler can auto-fill a newly-loaded
clip's ROIs.

Everything here degrades gracefully: sqlalchemy is imported lazily and any DB error (not installed,
off-VPN, timeout, no ROI) returns None rather than raising — so video loading never blocks on it.
"""
import os
from __future__ import annotations

import re

DATABASE_URL = os.environ.get("HCM_DATABASE_URL", "")  # set HCM_DATABASE_URL locally; do not commit credentials
CAM_RE = re.compile(r"cam[_-]?0*(\d+)")

# HCM segmentation class_name -> labeler ROI config field
ROI_CLASS = {"water": "spout_roi", "cage-outer": "cage_roi"}

_MEDOID_SQL = """
WITH cand AS (
  SELECT r.id, feat->'geometry'->'coordinates'->0 AS ring
  FROM recordings r JOIN batches b ON r.batch_id = b.batch_id
  CROSS JOIN LATERAL jsonb_array_elements(r.rois->'features') AS feat
  WHERE b.cage = :cam AND jsonb_typeof(r.rois) = 'object' AND r.rois->>'status' LIKE 'valid%'
    AND feat->'properties'->>'class_name' = :cls
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
    out: dict = {}
    try:
        engine = create_engine(DATABASE_URL, connect_args={"connect_timeout": timeout})
        with engine.connect() as conn:
            for cls in classes:
                field = ROI_CLASS.get(cls)
                if not field:
                    continue
                row = conn.execute(text(_MEDOID_SQL), {"cam": cam, "cls": cls}).first()
                if row and row[0]:
                    poly = _clean_ring(row[0])
                    if len(poly) >= 3:
                        out[field] = poly
    except Exception:
        return {}
    return {"camera": cam, **out} if out else {}
