# /// script
# requires-python = ">=3.11"
# dependencies = ["sqlalchemy", "psycopg2-binary"]
# ///
"""Auto-populate a laras-labeler project's spout ROI from the HCM database's water polygon.

The HCM (Home Cage Monitoring) DB stores a per-recording GeoJSON "water" polygon (the spout ROI,
import os
from UNet segmentation) in `recordings.rois`. It's fixed per camera to within a few pixels, so we
pick the *medoid* polygon for a camera — the recording whose water-polygon center is closest to the
camera's median center — as a clean, real representative, and set it as the project's `spout_roi`
(feature_config["spout_roi"] = [[x,y], ...]) via the running labeler's PUT endpoint.

Coordinates are in the native HCM frame (1280x1024). Only use this against a project whose videos are
that same camera/resolution — the ROI is not rescaled.

The HCM DB is on Salk's internal network (VPN / on-site / Tailscale).

Usage (uv resolves the inline deps and auto-isolates, dodging the local anaconda metadata poisoning):
    # print the medoid water polygon for a camera
    uv run scripts/import_hcm_spout_roi.py --camera cam_05

    # list the cameras that have a water ROI
    uv run scripts/import_hcm_spout_roi.py --list-cameras

    # fetch it AND set it on a running labeler project
    uv run scripts/import_hcm_spout_roi.py --camera cam_05 --pid dev
    uv run scripts/import_hcm_spout_roi.py --camera cam_05 --pid dev --url http://127.0.0.1:8760
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

from sqlalchemy import create_engine, text

DATABASE_URL = os.environ.get("HCM_DATABASE_URL", "")  # set HCM_DATABASE_URL locally; do not commit credentials

# medoid water polygon for one camera: the recording whose water-polygon bbox-center is closest to
# the camera's median bbox-center (so a single-recording segmentation glitch can't win).
MEDOID_SQL = """
WITH cand AS (
  SELECT r.id, feat->'geometry'->'coordinates'->0 AS ring
  FROM recordings r
  JOIN batches b ON r.batch_id = b.batch_id
  CROSS JOIN LATERAL jsonb_array_elements(r.rois->'features') AS feat
  WHERE b.cage = :cam
    AND jsonb_typeof(r.rois) = 'object'
    AND r.rois->>'status' LIKE 'valid%'
    AND feat->'properties'->>'class_name' = :cls
),
ctr AS (
  SELECT c.id,
         (MIN((pt->>0)::float) + MAX((pt->>0)::float)) / 2 AS cx,
         (MIN((pt->>1)::float) + MAX((pt->>1)::float)) / 2 AS cy
  FROM cand c CROSS JOIN LATERAL jsonb_array_elements(c.ring) AS pt
  GROUP BY c.id
),
med AS (
  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY cx) AS mx,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY cy) AS my,
         COUNT(*) AS n
  FROM ctr
)
SELECT c.ring, ctr.cx, ctr.cy, med.mx, med.my, med.n,
       sqrt(power(ctr.cx - med.mx, 2) + power(ctr.cy - med.my, 2)) AS dist
FROM ctr JOIN cand c USING (id) CROSS JOIN med
ORDER BY dist ASC
LIMIT 1;
"""

LIST_SQL = """
SELECT b.cage, COUNT(*) AS n_recordings
FROM recordings r
JOIN batches b ON r.batch_id = b.batch_id
WHERE jsonb_typeof(r.rois) = 'object'
  AND r.rois->>'status' LIKE 'valid%'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(r.rois->'features') f
              WHERE f->'properties'->>'class_name' = :cls)
GROUP BY b.cage
ORDER BY b.cage;
"""

# HCM segmentation class_name -> the labeler ROI it maps to (config field + PUT endpoint suffix).
ROI_KINDS = {"water": ("spout_roi", "spout-roi"), "cage-outer": ("cage_roi", "cage-roi")}


def _connect():
    try:
        engine = create_engine(DATABASE_URL, connect_args={"connect_timeout": 10})
        conn = engine.connect()
        conn.execute(text("SET timezone='America/Los_Angeles'"))
        return conn
    except Exception as e:  # noqa: BLE001
        sys.exit(f"Could not reach the HCM database ({e.__class__.__name__}).\n"
                 "It's on Salk's internal network — connect via VPN, on-site, or Tailscale.")


def _clean_ring(ring: list) -> list[list[float]]:
    """DB ring -> open polygon of [x,y] floats. GeoJSON rings repeat the first vertex at the end;
    drop it (our geometry closes the ring implicitly) and any consecutive duplicates."""
    pts: list[list[float]] = []
    for p in ring:
        xy = [round(float(p[0]), 1), round(float(p[1]), 1)]
        if not pts or pts[-1] != xy:
            pts.append(xy)
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    return pts


CAM_RE = re.compile(r"cam[_-]?0*(\d+)")


def _camera_of(video_id: str) -> str | None:
    """Extract the camera (e.g. 'cam_07') from a clip's video_id."""
    m = CAM_RE.search(video_id)
    return f"cam_{int(m.group(1)):02d}" if m else None


def _medoid(conn, cam: str, cls: str = "water"):
    """(poly, row) for a camera's medoid ROI of class `cls`, or (None, None) if none/degenerate."""
    row = conn.execute(text(MEDOID_SQL), {"cam": cam, "cls": cls}).mappings().first()
    if row is None:
        return None, None
    poly = _clean_ring(row["ring"])
    return (poly, row) if len(poly) >= 3 else (None, None)


def _put(base: str, timeout: int = 15):
    """Return a call(path, body?) -> JSON helper. Relative paths are prefixed with `base`; GET when
    body is None, else PUT. Exits with a helpful message on HTTP/URL error."""
    def call(path, body=None):
        url = path if path.startswith("http") else base + path
        req = urllib.request.Request(url, data=body,
                                     method="PUT" if body is not None else "GET",
                                     headers={"Content-Type": "application/json"} if body is not None else {})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            sys.exit(f"Labeler error: HTTP {e.code} — {e.read().decode(errors='replace')}")
        except urllib.error.URLError as e:
            sys.exit(f"Could not reach the labeler at {base} ({e.reason}). Is it running?")
    return call


def _set_clip_roi(call, pid: str, vid: str, poly: list, endpoint: str = "spout-roi") -> int:
    q = urllib.parse.quote(vid, safe="")
    got = call(f"/api/projects/{pid}/videos/{q}/{endpoint}", json.dumps({"points": poly}).encode())
    return len(next((v for v in got.values() if isinstance(v, list)), []))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--camera", help="camera/cage, e.g. cam_05")
    ap.add_argument("--list-cameras", action="store_true", help="list cameras that have a water ROI, then exit")
    ap.add_argument("--all-clips", action="store_true",
                    help="set a per-clip ROI on EVERY clip in --pid, auto-detecting each clip's camera")
    ap.add_argument("--pid", help="labeler project id to set the ROI on (omit to just print)")
    ap.add_argument("--roi", choices=sorted(ROI_KINDS), default="water",
                    help="which HCM segmentation ROI to import: 'water' -> spout_roi (default), "
                         "'cage-outer' -> cage_roi (arena boundary)")
    ap.add_argument("--url", default="http://127.0.0.1:8760", help="labeler base URL (default %(default)s)")
    args = ap.parse_args()
    base = args.url.rstrip("/")
    cls = args.roi                                  # HCM class_name to pull
    field, endpoint = ROI_KINDS[cls]                # labeler config field + PUT endpoint suffix

    conn = _connect()

    if args.list_cameras:
        for row in conn.execute(text(LIST_SQL), {"cls": cls}).mappings():
            print(f"{row['cage']:10s} {row['n_recordings']:>7d} recordings with a {cls} ROI")
        return

    # --- per-clip: set each clip's ROI from its own camera (for projects that mix cameras) ---
    if args.all_clips:
        if not args.pid:
            ap.error("--all-clips requires --pid")
        call = _put(base)
        proj = call(f"/api/projects/{args.pid}")
        vids = [v["video_id"] for v in proj.get("videos", [])]
        if not vids:
            sys.exit(f"project {args.pid!r} has no clips.")
        cache: dict[str, list | None] = {}
        n_set = 0
        for vid in vids:
            cam = _camera_of(vid)
            if not cam:
                print(f"  ✗ {vid[:40]}… — no camera in the id; skipped"); continue
            if cam not in cache:
                poly, row = _medoid(conn, cam, cls)
                cache[cam] = poly
                if poly is None:
                    print(f"  ✗ {cam}: no {cls} ROI in the DB")
            poly = cache[cam]
            if poly is None:
                continue
            k = _set_clip_roi(call, args.pid, vid, poly, endpoint)
            n_set += 1
            print(f"  ✓ {cam} → {vid[:44]}…  ({k} vertices)")
        print(f"\nSet per-clip {field} on {n_set}/{len(vids)} clips of project {args.pid!r}. Retrain to rebuild features.")
        return

    if not args.camera:
        ap.error("--camera is required (or use --list-cameras / --all-clips)")

    poly, row = _medoid(conn, args.camera, cls)
    if poly is None:
        sys.exit(f"No valid {cls} ROI found for camera {args.camera!r}. Try --list-cameras.")

    print(f"camera {args.camera}: medoid {cls} ROI ({len(poly)} vertices), chosen from {row['n']} recordings")
    print(f"  center ~({row['cx']:.0f}, {row['cy']:.0f}), {row['dist']:.1f}px from the camera median center")
    print(f"  {field} = {json.dumps(poly)}")

    if not args.pid:
        print("\n(no --pid given — not setting it on any project; pass --pid <project> to apply)")
        return

    call = _put(base)
    got = call(f"/api/projects/{args.pid}/{endpoint}", json.dumps({"points": poly}).encode())
    print(f"\n✓ Set project-wide {field} on {args.pid!r} ({len(got.get(field) or [])} vertices).")
    print("  (For a project that mixes cameras, use --all-clips to set a per-clip ROI instead.)")


if __name__ == "__main__":
    main()
