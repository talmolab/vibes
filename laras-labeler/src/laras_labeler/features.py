"""Pose -> per-frame feature matrix (PLAN.md §4).

Pipeline: sleap-io pose array -> movement cleaning -> per-animal base kinematics +
focal-vs-nearest-other social features -> pool across animals (animal-count-invariant)
-> JAABA-style window features. Output is a fixed-length (F, D) float32 matrix whose
D depends only on feature_config (all base slots always present; missing ones are NaN),
so it is comparable across videos in a project.
"""

from __future__ import annotations

import warnings

import numpy as np

FEATURE_CODE_VERSION = 7

# Canonical base features (always present so D is stable; unresolved ones stay NaN).
# ego_len/ego_width = the animal's extent along / perpendicular to its own heading (egocentric posture).
# elongation = ego_len/ego_width (>1 normal elongated stance, ~1 compact/foreshortened — e.g. rearing
# seen top-down). stillness_duration = consecutive seconds below a speed threshold (a running count,
# not a windowed stat — captures SUSTAINED stillness, which a windowed mean/std of speed can't tell
# apart from a brief pause). ear/shoulder/haunch_width = paired-keypoint spreads (body-length
# normalized) — posture cues an EDA found strongly separate rearing (haunch_width AUC 0.79, ear_width
# 0.23); NaN when the skeleton lacks that L/R pair.
# spine_len = neck->tail-base distance (EDA AUC 0.76 for rearing). kpt_conf_{mean,min}/kpt_visible_frac
# = raw pose-tracking quality: a rearing/foreshortened mouse self-occludes, so confidence drops and
# fewer keypoints are cleanly visible — an indirect but cheap rearing cue orthogonal to geometry.
INDIVIDUAL = [
    "centroid_speed", "nose_speed", "tail_speed", "forward_speed", "lateral_speed",
    "accel_mag", "angular_velocity", "abs_turn", "body_length", "body_bend", "spread_area",
    "ego_len", "ego_width", "elongation", "stillness_duration",
    "ear_width", "shoulder_width", "haunch_width", "spine_len",
    "kpt_conf_mean", "kpt_conf_min", "kpt_visible_frac",
]
SOCIAL = [
    "social_centroid_dist", "social_nose_nose", "social_nose_tail",
    "social_facing_angle", "social_in_cone", "social_approach_rate",
]
# Distance-to-spout (a fixed arena landmark). Only present when feature_config["spout"] = [x, y] is set.
SPOUT = [
    "spout_dist", "spout_dist_centroid", "spout_approach_rate", "spout_facing", "spout_in_zone",
]
# Spout ROI (a polygon region, e.g. the segmentation "water" ROI). Only present when
# feature_config["spout_roi"] = [[x,y], ...] is set. Distance INTO the region (0 when inside) + an
# inside indicator — more precise than the point + circular-zone above for an irregular landmark.
SPOUT_ROI = [
    "spout_roi_dist", "spout_roi_dist_centroid", "spout_roi_inside",
]
# Cage ROI (the arena-boundary polygon, e.g. the segmentation "cage-outer" ROI). Only present when
# feature_config["cage_roi"] = [[x,y], ...] is set. Gives an arena-relative frame the raw-pixel
# features lack: distance to the nearest cage wall (thigmotaxis / wall-following, body-length-
# normalized) + the animal's normalized position within the cage bounding box (comparable across
# cameras). cage_dist is UNCLAMPED (the mouse is always inside, so a clamped "distance into region"
# would be ~0 — we want how far it is FROM the wall).
# cage_min_dist = closest of ANY keypoint to the wall (not just the nose) — an EDA found this the single
# strongest rearing-on-rim signal (AUC 0.83), since a rearing/climbing mouse plants some body part at
# the wall even when the nose is elsewhere.
# cage_facing = heading vs the outward (toward-wall) radial direction — is the mouse oriented toward
# the wall (climbing/rearing on the rim orient outward). cage_approach = closing speed toward the
# nearest wall (bearing/direction of motion). Mirror of spout_facing / spout_approach_rate.
CAGE_ROI = [
    "cage_dist", "cage_dist_centroid", "cage_x", "cage_y", "cage_min_dist",
    "cage_facing", "cage_approach",
]
BASE_FEATURES = INDIVIDUAL + SOCIAL

ROLE_CANDIDATES = {
    "nose": ["nose", "snout", "nose_tip", "head"],
    # tail_base = the caudal end of the body axis (nose->tail_base gives heading).
    # "tti" = tail-torso interface (the anatomical tail base in SLEAP mouse rigs).
    "tail_base": ["tail_base", "tailbase", "tail-base", "tti", "tail_0", "tail0",
                  "tail_start", "hips", "trunk", "tail_1", "tail1", "tail"],
}


def resolve_roles(node_names: list[str], roles: dict | None) -> dict[str, int]:
    idx: dict[str, int] = {}
    lower = {n.lower(): i for i, n in enumerate(node_names)}
    roles = roles or {}
    for role, cands in ROLE_CANDIDATES.items():
        chosen = roles.get(role)
        if chosen and chosen in node_names:
            idx[role] = node_names.index(chosen)
            continue
        for c in cands:
            if c.lower() in lower:
                idx[role] = lower[c.lower()]
                break
    return idx


# left/right keypoint pairs used by the width features; each entry lists lowercased name candidates.
WIDTH_PAIRS = {
    "ear_width": (["ear_l", "left_ear", "earleft", "ear_left"], ["ear_r", "right_ear", "earright", "ear_right"]),
    "shoulder_width": (["shoulder_left", "shoulder_l", "left_shoulder", "leftshoulder"],
                       ["shoulder_right", "shoulder_r", "right_shoulder", "rightshoulder"]),
    "haunch_width": (["haunch_left", "haunch_l", "hip_left", "left_haunch", "left_hip"],
                     ["haunch_right", "haunch_r", "hip_right", "right_haunch", "right_hip"]),
}


def _find_node(node_names: list[str], cands: list[str]) -> int | None:
    lower = {n.lower(): i for i, n in enumerate(node_names)}
    for c in cands:
        if c in lower:
            return lower[c]
    return None


def role_node_map(node_names: list[str], role_idx: dict[str, int]) -> dict[str, str]:
    return {role: node_names[i] for role, i in role_idx.items()}


def _grad_t(x: np.ndarray, fps: float) -> np.ndarray:
    return np.gradient(x, axis=0) * fps


def _unit(v: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(v, axis=-1, keepdims=True)
    with np.errstate(invalid="ignore", divide="ignore"):
        return v / n


def _signed_angle(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Signed angle (rad) from vector a to vector b; shapes (..., 2)."""
    dot = a[..., 0] * b[..., 0] + a[..., 1] * b[..., 1]
    cross = a[..., 0] * b[..., 1] - a[..., 1] * b[..., 0]
    return np.arctan2(cross, dot)


def _poly_signed_dist(pts: np.ndarray, poly: np.ndarray):
    """Distance from each query point to a polygon, 0 when inside, + an inside indicator.

    pts: (F, T, 2) query points; poly: (V, 2) polygon vertices (open ring — the closing edge is
    implicit). Returns (dist, inside, boundary) each (F,T): dist is the Euclidean distance to the
    polygon boundary clamped to 0 wherever the point is inside; inside is 1.0/0.0; boundary is the
    UNCLAMPED distance to the nearest edge (nonzero even inside — used for wall-proximity). All are
    NaN where the query point is NaN, so absent animals stay NaN rather than reading as 'outside'."""
    px, py = pts[..., 0], pts[..., 1]                                # (F,T)
    ax, ay = poly[:, 0], poly[:, 1]
    bx, by = np.roll(ax, -1), np.roll(ay, -1)                        # next vertex (closes the ring)
    dmin = np.full(px.shape, np.inf)
    inside = np.zeros(px.shape, dtype=bool)
    with np.errstate(invalid="ignore", divide="ignore"):
        for i in range(len(poly)):
            ex, ey = bx[i] - ax[i], by[i] - ay[i]
            l2 = ex * ex + ey * ey
            if l2 <= 1e-12:
                d = np.hypot(px - ax[i], py - ay[i])
            else:
                t = np.clip(((px - ax[i]) * ex + (py - ay[i]) * ey) / l2, 0.0, 1.0)
                d = np.hypot(px - (ax[i] + t * ex), py - (ay[i] + t * ey))
            dmin = np.minimum(dmin, d)
            cond = ((ay[i] > py) != (by[i] > py)) & \
                   (px < (bx[i] - ax[i]) * (py - ay[i]) / (by[i] - ay[i] + 1e-12) + ax[i])
            inside ^= cond
    nan = np.isnan(px) | np.isnan(py)
    dist = np.where(nan, np.nan, np.where(inside, 0.0, dmin))
    inside_f = np.where(nan, np.nan, inside.astype("float64"))
    boundary = np.where(nan, np.nan, dmin)          # nearest-edge distance, unclamped (nonzero inside too)
    return dist, inside_f, boundary


def _clean(pose_xy: np.ndarray, conf: np.ndarray, node_names: list[str],
           track_names: list[str], fps: float, threshold: float) -> np.ndarray:
    """movement cleaning: confidence filter -> interpolate -> rolling median. Returns (F,T,N,2)."""
    from movement.filtering import filter_by_confidence, interpolate_over_time, rolling_filter
    from movement.io import load_poses

    # sleap (F,T,N,C) -> movement position (F,C,N,T), confidence (F,N,T)
    position = np.transpose(pose_xy, (0, 3, 2, 1)).astype("float32")
    confidence = np.transpose(conf, (0, 2, 1)).astype("float32")
    ds = load_poses.from_numpy(position, confidence, individual_names=track_names,
                               keypoint_names=node_names, fps=fps, source_software="SLEAP")
    pos = ds.position
    if threshold > 0:
        pos = filter_by_confidence(pos, ds.confidence, threshold=threshold)
    pos = interpolate_over_time(pos)
    pos = rolling_filter(pos, window=5, statistic="median", min_periods=1)
    # back to (F, T, N, 2)
    return pos.transpose("time", "individual", "keypoint", "space").to_numpy()


def quick_series(pose_xyc: np.ndarray, node_names: list[str], fps: float, roles: dict | None = None):
    """Head/nose-focused per-frame features for the GUI time-series, computed fast from raw poses.
    Returns {name: (F, T) float32}."""
    P = pose_xyc[..., :2].astype("float64")
    F, T, N, _ = P.shape
    lower = {n.lower(): i for i, n in enumerate(node_names)}

    def find(cands):
        for c in cands:
            if c in lower:
                return lower[c]
        return None

    ni = find(["nose", "snout", "nose_tip"])
    hi = find(["head", "head_center", "skull", "neck"])
    series: dict[str, np.ndarray] = {}
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        nose = P[:, :, ni, :] if ni is not None else None
        head = P[:, :, hi, :] if hi is not None else None
        if nose is not None:
            series["nose_speed"] = np.linalg.norm(_grad_t(nose, fps), axis=-1).astype("float32")
        if head is not None:
            series["head_speed"] = np.linalg.norm(_grad_t(head, fps), axis=-1).astype("float32")
        if nose is not None and head is not None:
            series["nose_head_dist"] = np.linalg.norm(nose - head, axis=-1).astype("float32")
        if T >= 2:
            base = nose if nose is not None else np.nanmean(P, axis=2)   # nose-to-nearest-other
            ci, cj = base[:, :, None, :], base[:, None, :, :]
            d = np.linalg.norm(ci - cj, axis=-1)
            d = np.where(np.eye(T, dtype=bool)[None] | np.isnan(d), np.inf, d)
            nn = np.min(d, axis=2)
            series["nearest_dist"] = np.where(np.isfinite(nn), nn, np.nan).astype("float32")
    return series


def _radii(config: dict, fps: float) -> list[int]:
    return sorted({max(1, int(round(r * fps))) for r in config.get("radii_seconds", [0.07, 0.25, 0.5])})


def _window_signals(signals: dict[str, np.ndarray], radii: list[int]):
    """Expand each 1D signal into raw + {mean,std,min,max,change} x radii -> (F, D), names."""
    import pandas as pd
    names, cols = [], []
    for sig, s in signals.items():
        ser = pd.Series(s)
        names.append(f"{sig}__raw"); cols.append(s.astype("float32"))
        for r in radii:
            roll = ser.rolling(2 * r + 1, center=True, min_periods=1)
            for stat, fn in (("mean", roll.mean), ("std", roll.std),
                             ("min", roll.min), ("max", roll.max)):
                names.append(f"{sig}__{stat}__r{r}"); cols.append(fn().to_numpy("float32"))
            change = (ser.shift(-r) - ser.shift(r)).to_numpy("float32")
            names.append(f"{sig}__change__r{r}"); cols.append(change)
    X = np.ascontiguousarray(np.stack(cols, axis=1), dtype="float32")
    return X, names


def _base_features(pose_xyc: np.ndarray, node_names: list[str], track_names: list[str],
                   fps: float, config: dict, roles: dict | None):
    """-> (base {name:(F,T)}, present (F,T), dropped, resolved_roles, F, T). Unpooled, unmasked."""
    F, T, N, _ = pose_xyc.shape
    conf = pose_xyc[..., 2]
    role_idx = resolve_roles(node_names, roles)
    has_axis = "nose" in role_idx and "tail_base" in role_idx
    do_ego = bool(config.get("egocentric", True))          # posture extents in the heading frame (rotation-invariant)
    do_scale = bool(config.get("normalize_scale", True))   # velocities/accel in body-lengths/s (size- & zoom-invariant)

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        P = _clean(pose_xyc[..., :2], conf, node_names, track_names, fps,
                   float(config.get("confidence_threshold", 0.0))).astype("float64")

        present = ~np.all(np.isnan(P).reshape(F, T, -1), axis=2)  # (F,T)
        centroid = np.nanmean(P, axis=2)                          # (F,T,2)

        spout = config.get("spout")                               # [x, y] arena landmark, shared across clips (or None)
        spout_roi = config.get("spout_roi")                       # [[x,y], ...] polygon region (or None)
        cage_roi = config.get("cage_roi")                         # [[x,y], ...] arena-boundary polygon (or None)
        feat_names = (list(INDIVIDUAL)
                      + (list(SPOUT) if spout is not None else [])
                      + (list(SPOUT_ROI) if spout_roi is not None else [])
                      + (list(CAGE_ROI) if cage_roi is not None else [])
                      + list(SOCIAL))
        base = {k: np.full((F, T), np.nan) for k in feat_names}
        dropped: list[str] = []

        v_cent = _grad_t(centroid, fps)
        base["centroid_speed"] = np.linalg.norm(v_cent, axis=-1)
        base["accel_mag"] = np.linalg.norm(_grad_t(v_cent, fps), axis=-1)

        mins, maxs = np.nanmin(P, axis=2), np.nanmax(P, axis=2)   # (F,T,2)
        area = (maxs[..., 0] - mins[..., 0]) * (maxs[..., 1] - mins[..., 1])

        ref = np.full(T, np.nan)
        if has_axis:
            nose = P[:, :, role_idx["nose"], :]
            tail = P[:, :, role_idx["tail_base"], :]
            axis_vec = nose - tail
            heading = _unit(axis_vec)
            body_len = np.linalg.norm(axis_vec, axis=-1)
            with np.errstate(invalid="ignore"):
                ref = np.nanmedian(np.where(body_len > 0, body_len, np.nan), axis=0)
            ref = np.where(np.isfinite(ref) & (ref > 1e-6), ref, np.nan)

            base["nose_speed"] = np.linalg.norm(_grad_t(nose, fps), axis=-1)
            base["tail_speed"] = np.linalg.norm(_grad_t(tail, fps), axis=-1)
            base["forward_speed"] = np.sum(v_cent * heading, axis=-1)
            perp = np.stack([-heading[..., 1], heading[..., 0]], axis=-1)
            base["lateral_speed"] = np.sum(v_cent * perp, axis=-1)
            angvel = np.full((F, T), np.nan)
            angvel[1:] = _signed_angle(heading[:-1], heading[1:]) * fps
            base["angular_velocity"] = angvel
            base["abs_turn"] = np.abs(angvel)
            base["body_length"] = body_len / ref
            base["body_bend"] = np.abs(_signed_angle(nose - centroid, tail - centroid))
            # egocentric posture: extent of the animal ALONG vs PERPENDICULAR to its own heading
            # (rotate each keypoint into the body frame), body-length-normalized -> heading-invariant.
            off = P - centroid[:, :, None, :]
            along = np.sum(off * heading[:, :, None, :], axis=-1)      # (F,T,N)
            across = np.sum(off * perp[:, :, None, :], axis=-1)
            elen = np.nanmax(along, axis=2) - np.nanmin(along, axis=2)  # (F,T)
            ewid = np.nanmax(across, axis=2) - np.nanmin(across, axis=2)
            base["ego_len"] = elen / ref
            base["ego_width"] = ewid / ref
            with np.errstate(invalid="ignore", divide="ignore"):
                base["elongation"] = base["ego_len"] / np.where(base["ego_width"] > 1e-6, base["ego_width"], np.nan)
            base["spread_area"] = (elen * ewid) / (ref ** 2) if do_ego else area / (ref ** 2)
        else:
            dropped += ["nose_speed", "tail_speed", "forward_speed", "lateral_speed",
                        "angular_velocity", "abs_turn", "body_length", "body_bend", "ego_len", "ego_width", "elongation"]
            base["spread_area"] = area  # unnormalized fallback

        # paired-keypoint widths (ear/shoulder/haunch spread), body-length normalized. Present only if
        # the skeleton has that L/R pair; otherwise NaN + dropped. invv falls back to raw px for ref-NaN.
        invw = (np.where(np.isfinite(ref) & (ref > 0), 1.0 / ref, 1.0) if do_scale else np.ones(T))[None, :]
        for wname, (lcands, rcands) in WIDTH_PAIRS.items():
            li, ri = _find_node(node_names, lcands), _find_node(node_names, rcands)
            if li is not None and ri is not None:
                base[wname] = np.linalg.norm(P[:, :, li, :] - P[:, :, ri, :], axis=-1) * invw
            else:
                dropped.append(wname)

        # optional: ALL pairwise inter-keypoint distances (JABS-style), body-length normalized. Gated by
        # config (default off) because it adds C(N,2) base signals (~105 for a 15-node skeleton -> ~1680
        # windowed columns) that overfit small label sets. Added straight to `base` (pooling iterates
        # base.items(), so they flow through windowing without needing to be in the static feat_names).
        if config.get("pairwise_distances"):
            clean = lambda s: "".join(ch if ch.isalnum() else "" for ch in s.lower())  # strip separators so no '__' sneaks into the base name
            for i in range(N):
                for j in range(i + 1, N):
                    base[f"pd_{clean(node_names[i])}_{clean(node_names[j])}"] = \
                        np.linalg.norm(P[:, :, i, :] - P[:, :, j, :], axis=-1) * invw

        # spine length: neck -> tail-base (body-length normalized). EDA AUC 0.76 for rearing. Needs a
        # 'neck' node + the resolved tail_base; otherwise dropped.
        neck_i = _find_node(node_names, ["neck", "base_of_neck", "base_neck"])
        if neck_i is not None and "tail_base" in role_idx:
            base["spine_len"] = np.linalg.norm(P[:, :, neck_i, :] - P[:, :, role_idx["tail_base"], :], axis=-1) * invw
        else:
            dropped.append("spine_len")

        # pose-tracking quality from the RAW confidence (before cleaning): a rearing/foreshortened mouse
        # self-occludes, so per-keypoint confidence drops and fewer keypoints are cleanly visible. An
        # indirect rearing cue that's orthogonal to the geometric features.
        with np.errstate(invalid="ignore"):
            base["kpt_conf_mean"] = np.nanmean(conf, axis=2)                          # (F,T)
            base["kpt_conf_min"] = np.nanmin(conf, axis=2)
        vthr = float(config.get("kpt_visible_thresh", 0.5))
        base["kpt_visible_frac"] = (np.isfinite(conf) & (conf > vthr)).sum(axis=2) / max(1, N)

        # social: focal vs nearest other
        if T >= 2:
            ci, cj = centroid[:, :, None, :], centroid[:, None, :, :]
            dcc = np.linalg.norm(ci - cj, axis=-1)                # (F,T,T)
            dcc = np.where(np.eye(T, dtype=bool)[None] | np.isnan(dcc), np.inf, dcc)
            nearest = np.argmin(dcc, axis=2)                      # (F,T)
            d_cc = np.min(dcc, axis=2)
            d_cc = np.where(np.isfinite(d_cc), d_cc, np.nan)
            fi = np.arange(F)[:, None]
            cen_o = centroid[fi, nearest]
            norm = ref if has_axis else np.ones(T)
            base["social_centroid_dist"] = d_cc / norm
            if has_axis:
                nose_o, tail_o = nose[fi, nearest], tail[fi, nearest]
                base["social_nose_nose"] = np.linalg.norm(nose - nose_o, axis=-1) / ref
                base["social_nose_tail"] = np.linalg.norm(nose - tail_o, axis=-1) / ref
                facing = _signed_angle(heading, cen_o - centroid)
                base["social_facing_angle"] = np.abs(facing)
                base["social_in_cone"] = (np.abs(facing) < np.pi / 4).astype(float)
                base["social_approach_rate"] = -_grad_t(d_cc, fps)
            else:
                dropped += ["social_nose_nose", "social_nose_tail", "social_facing_angle",
                            "social_in_cone", "social_approach_rate"]
        else:
            dropped += SOCIAL  # single animal -> social features NaN

        # distance to a fixed arena landmark (the spout) — the strongest signal for approach/consummatory
        # behaviours like drinking. All body-length-normalized (invv falls back to raw px for ref-NaN tracks).
        if spout is not None:
            sp = np.asarray(spout, dtype="float64").reshape(2)
            invv = np.where(np.isfinite(ref) & (ref > 0), 1.0 / ref, 1.0) if do_scale else np.ones(T)
            invv = invv[None, :]
            d_cent = np.linalg.norm(centroid - sp, axis=-1)             # (F,T) raw px
            base["spout_dist_centroid"] = d_cent * invv
            base["spout_approach_rate"] = -_grad_t(d_cent, fps) * invv  # closing speed toward the spout
            zone = float(config.get("spout_zone_bl", 2.0))
            base["spout_in_zone"] = (base["spout_dist_centroid"] < zone).astype(float)
            if has_axis:
                base["spout_dist"] = np.linalg.norm(nose - sp, axis=-1) * invv   # nose->spout (the mouth reaches it)
                base["spout_facing"] = np.abs(_signed_angle(heading, sp - centroid))
            else:
                dropped += ["spout_dist", "spout_facing"]

        # spout ROI (a polygon region, e.g. the segmentation "water" ROI): distance INTO the region
        # (0 when the keypoint is inside) + a nose-inside indicator — the precise "at/in the spout"
        # signal for consummatory behaviours. Distances body-length-normalized (invv falls back to px).
        if spout_roi is not None:
            poly = np.asarray(spout_roi, dtype="float64").reshape(-1, 2)
            invv = (np.where(np.isfinite(ref) & (ref > 0), 1.0 / ref, 1.0) if do_scale
                    else np.ones(T))[None, :]
            d_cent, _, _ = _poly_signed_dist(centroid, poly)
            base["spout_roi_dist_centroid"] = d_cent * invv
            if has_axis:
                d_nose, inside_nose, _ = _poly_signed_dist(nose, poly)
                base["spout_roi_dist"] = d_nose * invv          # nose->region (0 inside)
                base["spout_roi_inside"] = inside_nose          # nose inside the region (drinking)
            else:
                dropped += ["spout_roi_dist", "spout_roi_inside"]

        # cage ROI (the arena-boundary polygon, e.g. the "cage-outer" segmentation ROI): distance to
        # the nearest cage WALL (unclamped — the mouse is always inside, so we want how far it is from
        # the wall = thigmotaxis / wall-following) + the animal's normalized position within the cage
        # bounding box (an arena-relative coordinate frame that generalizes across cameras). Wall
        # distances are body-length-normalized (invv falls back to raw px for ref-NaN tracks).
        if cage_roi is not None:
            cpoly = np.asarray(cage_roi, dtype="float64").reshape(-1, 2)
            invv = (np.where(np.isfinite(ref) & (ref > 0), 1.0 / ref, 1.0)
                    if do_scale else np.ones(T))[None, :]
            _, _, wall_cent = _poly_signed_dist(centroid, cpoly)
            base["cage_dist_centroid"] = wall_cent * invv
            cx0, cx1 = float(cpoly[:, 0].min()), float(cpoly[:, 0].max())
            cy0, cy1 = float(cpoly[:, 1].min()), float(cpoly[:, 1].max())
            base["cage_x"] = (centroid[..., 0] - cx0) / max(cx1 - cx0, 1e-6)   # 0=left wall .. 1=right wall
            base["cage_y"] = (centroid[..., 1] - cy0) / max(cy1 - cy0, 1e-6)   # 0=top .. 1=bottom (image coords)
            # closest of ANY keypoint to the wall — a rearing/climbing mouse plants some body part at the
            # wall even when the nose is elsewhere (EDA: strongest rearing signal, AUC 0.83).
            wall_min = np.full((F, T), np.inf)
            for n in range(N):
                _, _, wn = _poly_signed_dist(P[:, :, n, :], cpoly)
                wall_min = np.fmin(wall_min, wn)              # fmin ignores NaN (missing keypoints)
            wall_min = np.where(np.isfinite(wall_min), wall_min, np.nan)
            base["cage_min_dist"] = wall_min * invv
            # bearing/direction to the wall (mirrors spout_facing/spout_approach_rate):
            base["cage_approach"] = -_grad_t(wall_cent, fps) * invv   # closing speed toward the nearest wall (centroid)
            if has_axis:
                _, _, wall_nose = _poly_signed_dist(nose, cpoly)
                base["cage_dist"] = wall_nose * invv            # nose->nearest wall
                cxc, cyc = (cx0 + cx1) / 2, (cy0 + cy1) / 2      # cage-bbox center
                outward = centroid - np.array([cxc, cyc])        # radial direction toward the wall (F,T,2)
                base["cage_facing"] = np.abs(_signed_angle(heading, outward))   # 0 = facing the wall, pi = facing the cage center
            else:
                dropped += ["cage_dist", "cage_facing"]

        # body-length-normalize the velocity/accel family so speeds are in body-lengths/s (invariant to
        # animal size & camera zoom). Distances are already /ref above; angles stay as-is. No axis -> skip.
        if has_axis and do_scale:
            # per-track scale = 1/body-length; a track whose nose/tail were never co-detected has ref=NaN
            # -> keep its raw-pixel speeds (centroid_speed/accel_mag don't need the axis) rather than
            # NaN-wiping them to a constant-0 imputation, which would strip that track's only locomotion signal.
            inv = np.where(np.isfinite(ref) & (ref > 0), 1.0 / ref, 1.0)[None, :]
            for k in ("centroid_speed", "nose_speed", "tail_speed", "forward_speed",
                      "lateral_speed", "accel_mag", "social_approach_rate"):
                base[k] = base[k] * inv

        # stillness duration: consecutive SECONDS below a speed threshold, computed on centroid_speed
        # (always available, unlike nose/tail speed) in whatever units it ended up in above (body-
        # lengths/s normally, raw px/s for the rare ref-NaN fallback track). A running count that resets
        # to 0 the instant speed exceeds the threshold or the track briefly drops out (NaN) — distinct
        # from a windowed mean/std of speed, which can't tell a long stillness bout from a brief pause.
        import pandas as pd
        thresh = float(config.get("stillness_speed_bl", 0.5))
        low = np.isfinite(base["centroid_speed"]) & (base["centroid_speed"] < thresh)
        still = np.zeros((F, T), dtype="float64")
        for tt in range(T):
            s = pd.Series(low[:, tt].astype("int64"))
            grp = (~s.astype(bool)).cumsum()          # increments on each non-low frame -> groups consecutive low-runs
            still[:, tt] = s.groupby(grp).cumsum().to_numpy("float64")
        base["stillness_duration"] = still / fps

    return base, present, dropped, role_node_map(node_names, role_idx), F, T


def compute_feature_matrix(pose_xyc: np.ndarray, node_names: list[str], track_names: list[str],
                           fps: float, config: dict, roles: dict | None):
    """Whole-frame: pool base features across animals -> (X (F,D) float32, names, dropped, roles)."""
    base, present, dropped, resolved, F, T = _base_features(pose_xyc, node_names, track_names, fps, config, roles)
    aggs = config.get("pool_aggregates", ["min", "mean", "max"])
    reduce = {"min": np.nanmin, "mean": np.nanmean, "max": np.nanmax}
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        pooled: dict[str, np.ndarray] = {}
        for k, arr in base.items():
            arr = np.where(present, arr, np.nan)
            for ag in aggs:
                pooled[f"{k}__{ag}"] = reduce[ag](arr, axis=1)
        pooled["n_animals_present"] = present.sum(axis=1).astype("float64")
        X, names = _window_signals(pooled, _radii(config, fps))
    return X, names, dropped, resolved


def compute_per_track_features(pose_xyc: np.ndarray, node_names: list[str], track_names: list[str],
                               fps: float, config: dict, roles: dict | None):
    """Per focal animal: window each track's own base features -> (X (F,T,D) float32, names, dropped, roles)."""
    base, present, dropped, resolved, F, T = _base_features(pose_xyc, node_names, track_names, fps, config, roles)
    radii = _radii(config, fps)
    Xs, names = [], None
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        for t in range(T):
            signals = {k: np.where(present[:, t], arr[:, t], np.nan) for k, arr in base.items()}
            Xt, names = _window_signals(signals, radii)
            Xs.append(Xt)
    X = np.stack(Xs, axis=1)  # (F, T, D)
    return X, names, dropped, resolved
