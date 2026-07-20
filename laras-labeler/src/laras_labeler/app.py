"""FastAPI app factory (v0a): project-scoped frames, poses, behaviors, labels (PLAN.md §8).

Routes are inlined for now; they move to routers/ as the surface grows (training, predict).
"""

from __future__ import annotations

from pathlib import Path

import json
import shutil
import threading

from fastapi import FastAPI, File, HTTPException, Response, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field, field_validator

from fastapi.staticfiles import StaticFiles

from .config import Settings
from .features import quick_series
from .featurestore import FeatureStore
from .importers import Importer
from .jobs import JobManager
from .labels import LabelStore
from .predict import Predictor
from .project import DEFAULT_FEATURE_CONFIG, ProjectStore
from .training import Trainer
from .video import VideoManager

_IMMUTABLE = {"Cache-Control": "public, max-age=31536000, immutable"}


class NewProject(BaseModel):
    name: str


class NewVideo(BaseModel):
    video_path: str
    slp_path: str | None = None


class NewBehavior(BaseModel):
    name: str
    color: str | None = None
    key: str | None = None
    feature_set: str | None = None   # explicit choice; if omitted, one is auto-suggested from the name


class SetSpout(BaseModel):
    x: float | None = None   # video pixel coords; both None clears the spout
    y: float | None = None


class SetSpoutRoi(BaseModel):
    points: list[list[float]] | None = None   # [[x,y], ...] polygon vertices; None/empty clears the ROI

    @field_validator("points")
    @classmethod
    def _xy_pairs(cls, v):
        if v is not None and any(len(p) != 2 for p in v):
            raise ValueError("each ROI point must be exactly [x, y]")
        return v


class EditBehavior(BaseModel):
    name: str | None = None
    color: str | None = None
    key: str | None = None
    feature_set: str | None = None   # None keeps current; 'all'|'spout'|'cage'|'spout_cage'|'no_social'|'pose'|'social'|'social_pose'


class ReviewedBout(BaseModel):
    vid: str
    track: int
    start: int
    end: int
    label_value: int | None = None
    action: str = "reviewed"   # 'add' -> mark reviewed; 'remove' -> un-review


class LabelSpan(BaseModel):
    behavior_id: int
    track: int = 0
    start: int
    end: int
    value: int = Field(ge=0, le=2)  # 1 = Happening, 0 = Not-happening, 2 = Unknown (saved, excluded from training)
    source: str = "manual"          # provenance: 'manual' (painted) | 'candidate' (accepted from review) | 'imported'


class ImportRequest(BaseModel):
    csv_path: str
    behavior_col: str = "behavior"
    start_col: str = "start"
    end_col: str = "end"
    units: str = "frames"          # 'frames' | 'seconds'
    coverage: str = "complete"     # 'complete' (sample negatives) | 'partial'
    neg_ratio: float = 1.0


class ImportEventsRequest(BaseModel):
    json_path: str
    track: int | None = None       # None = all tracks (whole-frame); int = one track


def create_app(settings: Settings, store: ProjectStore) -> FastAPI:
    app = FastAPI(title="laras-labeler", version="0.1.0")

    # index.html is served by StaticFiles; without this the browser heuristically caches it and can
    # keep running stale UI code after an edit. no-cache forces revalidation (ETag 304 keeps it cheap).
    @app.middleware("http")
    async def _no_cache_html(request, call_next):
        resp = await call_next(request)
        ctype = resp.headers.get("content-type", "")
        if ctype.startswith("text/html") and "cache-control" not in resp.headers:
            resp.headers["Cache-Control"] = "no-cache"
        return resp

    vm = VideoManager(store, settings.frame_cache_size, settings.jpeg_quality)
    labels = LabelStore(store)
    features = FeatureStore(store, vm)
    jobs = JobManager()
    trainer = Trainer(store, labels, features)
    predictor = Predictor(store, features, trainer, labels)
    importer = Importer(store, labels, vm)
    app.state.settings = settings
    app.state.store = store
    app.state.vm = vm
    app.state.labels = labels
    app.state.features = features
    app.state.jobs = jobs
    app.state.trainer = trainer
    app.state.predictor = predictor

    def _behavior(pid: str, bid: int):
        proj = _proj(pid)
        if not any(b["id"] == bid for b in proj.behaviors):
            raise HTTPException(404, "behavior not found")
        return proj

    def _proj(pid: str):
        proj = store.get(pid)
        if proj is None:
            raise HTTPException(404, "project not found")
        return proj

    def _video(pid: str, vid: str):
        proj = _proj(pid)
        if proj.video(vid) is None:
            raise HTTPException(404, "video not found")
        return proj

    def _meta(pid: str, vid: str) -> dict:
        proj = store.get(pid)
        entry = proj.video(vid) or {}
        fc = proj.manifest.get("feature_config", {})
        # effective arena landmarks for THIS clip: a per-clip value overrides the project-wide default
        eff = {k: (entry[k] if entry.get(k) is not None else fc.get(k)) for k in ("spout", "spout_roi", "cage_roi")}
        return {**vm.meta(pid, vid), "features": features.status(pid, vid), **eff}

    # Feature pre-warm: the first Train computes any missing feature cache lazily (a multi-minute cold
    # cost that lands inside the human-in-the-loop window). Instead we fire that same background compute
    # as soon as a clip is added or the project is opened, so by train time the cache is already warm.
    # Fire-and-forget + de-duped against in-flight warms; repeated calls (e.g. project-state polls) are
    # cheap no-ops once a clip is ready or already warming.
    _prewarming: set = set()
    _prewarm_lock = threading.Lock()

    def _prewarm_features(pid: str, vids=None) -> list[str]:
        proj = store.get(pid)
        if proj is None:
            return []
        if vids is None:
            vids = [v["video_id"] for v in proj.videos]
        started = []
        for vid in vids:
            entry = proj.video(vid)
            if not entry or not entry.get("has_poses"):
                continue
            if features.status(pid, vid).get("status") == "ready":   # warm already (incl. source_missing)
                continue
            with _prewarm_lock:
                if (pid, vid) in _prewarming:
                    continue
                _prewarming.add((pid, vid))

            def _fn(progress, _pid=pid, _vid=vid):
                try:
                    return features.compute(_pid, _vid, progress)
                finally:
                    with _prewarm_lock:
                        _prewarming.discard((_pid, _vid))

            jobs.start("prewarm", _fn, meta={"pid": pid, "video_id": vid})
            started.append(vid)
        return started

    # Self-heal ROI auto-load: the per-clip DB fetch is best-effort and gives up silently on any hiccup
    # (a transient DB/VPN blip leaves a clip without ROIs). On project open, retry the fetch in the
    # BACKGROUND (never blocks the request on the DB) for any pose clip still missing an ROI — capped at
    # a few tries per clip so a camera that genuinely has no ROI isn't re-queried forever.
    _roi_loading: set = set()
    _roi_attempts: dict = {}
    _MAX_ROI_TRIES = 3

    def _autoload_missing_rois(pid: str) -> None:
        from . import hcm_roi
        proj = store.get(pid)
        if proj is None:
            return
        for v in proj.videos:
            if not v.get("has_poses"):
                continue
            vid = v["video_id"]
            if v.get("cage_roi") and v.get("spout_roi"):    # nothing missing
                continue
            key = (pid, vid)
            with _prewarm_lock:
                if key in _roi_loading or _roi_attempts.get(key, 0) >= _MAX_ROI_TRIES:
                    continue
                _roi_loading.add(key)
                _roi_attempts[key] = _roi_attempts.get(key, 0) + 1

            def _fn(progress, _pid=pid, _vid=vid, _key=key):
                try:
                    got = hcm_roi.fetch_rois(_vid)
                    entry = store.get(_pid).video(_vid)
                    changed = False
                    for field in ("cage_roi", "spout_roi"):
                        if got.get(field) and entry is not None and not entry.get(field):
                            entry[field] = got[field]; changed = True
                    if changed:
                        store.get(_pid).save()
                finally:
                    with _prewarm_lock:
                        _roi_loading.discard(_key)

            jobs.start("roi-autoload", _fn, meta={"pid": pid, "video_id": vid})

    # ---- projects & videos ----
    @app.get("/api/projects")
    def list_projects():
        return [{"pid": p.pid, "name": p.name, "videos": [v["video_id"] for v in p.videos]}
                for p in store.list()]

    @app.post("/api/projects")
    def create_project(body: NewProject):
        p = store.create(body.name)
        return {"pid": p.pid, "name": p.name}

    @app.get("/api/projects/{pid}")
    def get_project(pid: str):
        p = _proj(pid)
        _prewarm_features(pid)              # warm feature caches on project open so the first Train is fast
        _autoload_missing_rois(pid)         # background-retry ROI fetch for clips still missing one (self-heals transient DB blips)
        return {
            "pid": p.pid, "name": p.name,
            "behaviors": p.behaviors,
            "videos": [_meta(pid, v["video_id"]) for v in p.videos],
            "spout": p.manifest.get("feature_config", {}).get("spout"),   # [x,y] arena landmark, shared across clips
            "spout_roi": p.manifest.get("feature_config", {}).get("spout_roi"),   # [[x,y],...] polygon region
            "cage_roi": p.manifest.get("feature_config", {}).get("cage_roi"),   # [[x,y],...] cage-boundary polygon
        }

    @app.get("/api/projects/{pid}/feature-sets")
    def feature_sets_info(pid: str):
        """Exactly what each feature-set option feeds the model: the base signals (and column count) it
        selects, computed live from this project's real feature names — so it reflects the ROIs/features
        actually available and can't drift from the selection logic. Signals grouped by family."""
        from .featurestore import select_feature_cols
        p = _proj(pid)
        fnames = []
        for v in p.videos:                                    # first clip with computed features defines the families
            try:
                fn = features.meta(pid, v["video_id"]).get("feature_names")
            except (FileNotFoundError, ValueError):
                fn = None
            if fn:
                fnames = fn; break
        def family(b):
            if b.startswith("spout_roi"): return "spout ROI"
            if b.startswith("spout"): return "spout point"
            if b.startswith("cage"): return "cage ROI"
            if b.startswith("social"): return "social"
            return "pose/kinematics"
        sets = {}
        for s in ["all", "spout", "spout_cage", "cage", "no_social", "pose", "social", "social_pose"]:
            cols = select_feature_cols(fnames, s) if fnames else []
            bases, seen = [], set()
            for c in cols:
                b = fnames[c].split("__")[0]
                if b not in seen:
                    seen.add(b); bases.append(b)
            groups: dict[str, list] = {}
            for b in bases:
                groups.setdefault(family(b), []).append(b)
            sets[s] = {"n_cols": len(cols), "n_signals": len(bases), "by_family": groups}
        return {"have_features": bool(fnames), "sets": sets}

    @app.put("/api/projects/{pid}/spout")
    def set_spout(pid: str, body: SetSpout):
        """Set (or clear) the shared arena-landmark point used by the distance-to-spout features.
        Lives in feature_config, so changing it invalidates the feature cache -> recompute + retrain."""
        p = _proj(pid)
        fc = p.manifest.setdefault("feature_config", dict(DEFAULT_FEATURE_CONFIG))
        fc["spout"] = None if body.x is None or body.y is None else [float(body.x), float(body.y)]
        p.save()
        return {"spout": fc["spout"]}

    @app.put("/api/projects/{pid}/spout-roi")
    def set_spout_roi(pid: str, body: SetSpoutRoi):
        """Set (or clear) the shared spout ROI polygon used by the spout-ROI features.
        Lives in feature_config, so changing it invalidates the feature cache -> recompute + retrain."""
        p = _proj(pid)
        fc = p.manifest.setdefault("feature_config", dict(DEFAULT_FEATURE_CONFIG))
        pts = body.points or []
        if pts and len(pts) < 3:
            raise HTTPException(400, "a spout ROI needs at least 3 points")
        fc["spout_roi"] = [[float(x), float(y)] for x, y in pts] if pts else None
        p.save()
        return {"spout_roi": fc["spout_roi"]}

    @app.put("/api/projects/{pid}/videos/{vid}/spout")
    def set_video_spout(pid: str, vid: str, body: SetSpout):
        """Set (or clear) THIS clip's spout point — overrides the project-wide default for this clip
        only (clips from different cameras carry their own landmark). Invalidates just this clip's cache."""
        p = _video(pid, vid)
        entry = p.video(vid)
        entry["spout"] = None if body.x is None or body.y is None else [float(body.x), float(body.y)]
        p.save()
        return {"spout": entry["spout"]}

    @app.put("/api/projects/{pid}/videos/{vid}/spout-roi")
    def set_video_spout_roi(pid: str, vid: str, body: SetSpoutRoi):
        """Set (or clear) THIS clip's spout ROI polygon — overrides the project-wide default for this
        clip only. Invalidates just this clip's feature cache (per-clip feature hash)."""
        p = _video(pid, vid)
        entry = p.video(vid)
        pts = body.points or []
        if pts and len(pts) < 3:
            raise HTTPException(400, "a spout ROI needs at least 3 points")
        entry["spout_roi"] = [[float(x), float(y)] for x, y in pts] if pts else None
        p.save()
        return {"spout_roi": entry["spout_roi"]}

    @app.put("/api/projects/{pid}/cage-roi")
    def set_cage_roi(pid: str, body: SetSpoutRoi):
        """Set (or clear) the shared cage-boundary ROI polygon used by the cage-ROI features
        (wall distance + normalized cage position). Lives in feature_config -> invalidates the
        feature cache -> recompute + retrain."""
        p = _proj(pid)
        fc = p.manifest.setdefault("feature_config", dict(DEFAULT_FEATURE_CONFIG))
        pts = body.points or []
        if pts and len(pts) < 3:
            raise HTTPException(400, "a cage ROI needs at least 3 points")
        fc["cage_roi"] = [[float(x), float(y)] for x, y in pts] if pts else None
        p.save()
        return {"cage_roi": fc["cage_roi"]}

    @app.put("/api/projects/{pid}/videos/{vid}/cage-roi")
    def set_video_cage_roi(pid: str, vid: str, body: SetSpoutRoi):
        """Set (or clear) THIS clip's cage-boundary ROI polygon — overrides the project-wide default
        for this clip only (clips from different cameras carry their own cage). Invalidates just this
        clip's feature cache (per-clip feature hash)."""
        p = _video(pid, vid)
        entry = p.video(vid)
        pts = body.points or []
        if pts and len(pts) < 3:
            raise HTTPException(400, "a cage ROI needs at least 3 points")
        entry["cage_roi"] = [[float(x), float(y)] for x, y in pts] if pts else None
        p.save()
        return {"cage_roi": entry["cage_roi"]}

    @app.post("/api/projects/{pid}/videos/{vid}/autoload-roi")
    def autoload_roi(pid: str, vid: str, overwrite: bool = False):
        """Best-effort: fill THIS clip's cage (and spout) ROI from the HCM database by matching the
        clip's camera to the medoid segmentation polygon. Only fills a MISSING ROI unless overwrite=true.
        Silently no-ops (set: {}) if the DB is unreachable (off-VPN), sqlalchemy isn't installed, the
        camera can't be parsed, or no valid polygon exists — so video loading never depends on it."""
        from . import hcm_roi
        p = _video(pid, vid)
        entry = p.video(vid)
        got = hcm_roi.fetch_rois(vid)
        set_fields = {}
        for field in ("cage_roi", "spout_roi"):
            if got.get(field) and (overwrite or not entry.get(field)):
                entry[field] = got[field]
                set_fields[field] = got[field]
        if set_fields:
            p.save()
        return {"camera": got.get("camera"), "set": set_fields}

    @app.post("/api/projects/{pid}/videos")
    def add_video(pid: str, body: NewVideo):
        p = _proj(pid)
        try:
            entry = p.add_video(body.video_path, body.slp_path)
        except ValueError as e:
            raise HTTPException(409, str(e))
        _prewarm_features(pid, [entry["video_id"]])   # start computing features immediately in the background
        return entry

    @app.post("/api/projects/{pid}/videos/upload")
    async def upload_video(pid: str, video: UploadFile = File(...), slp: UploadFile | None = File(None)):
        proj = _proj(pid)
        media = proj.path / "media"
        media.mkdir(exist_ok=True)
        vpath = media / (video.filename or "video.mp4")
        with open(vpath, "wb") as f:
            shutil.copyfileobj(video.file, f)
        spath = None
        if slp is not None and slp.filename:
            spath = media / slp.filename
            with open(spath, "wb") as f:
                shutil.copyfileobj(slp.file, f)
        try:
            entry = proj.add_video(str(vpath), str(spath) if spath else None)
            _prewarm_features(pid, [entry["video_id"]])   # background feature compute right after upload
            return entry
        except ValueError as e:
            if "already added" in str(e):   # re-loading the same file -> just reopen it
                existing = next((v for v in proj.videos if v["video_path"] == str(vpath)), None)
                if existing:
                    _prewarm_features(pid, [existing["video_id"]])   # warm in case its cache is stale/missing
                    return existing
            raise HTTPException(400, str(e))
        except Exception as e:
            raise HTTPException(400, f"could not register uploaded video: {e}")

    @app.post("/api/projects/{pid}/videos/{vid}/import")
    def import_annotations(pid: str, vid: str, body: ImportRequest):
        _video(pid, vid)
        try:
            return importer.import_csv(pid, vid, body.csv_path, body.behavior_col,
                                       body.start_col, body.end_col, body.units,
                                       body.coverage, body.neg_ratio)
        except (ValueError, FileNotFoundError) as e:
            raise HTTPException(400, str(e))

    @app.post("/api/projects/{pid}/videos/{vid}/import-events")
    def import_events(pid: str, vid: str, body: ImportEventsRequest):
        _video(pid, vid)
        try:
            return importer.import_event_annotator(pid, vid, body.json_path, body.track)
        except (ValueError, FileNotFoundError, KeyError) as e:
            raise HTTPException(400, str(e))

    @app.get("/api/projects/{pid}/videos/{vid}")
    def get_video(pid: str, vid: str):
        _video(pid, vid)
        return _meta(pid, vid)

    @app.delete("/api/projects/{pid}/videos/{vid}")
    def remove_video(pid: str, vid: str):
        """Remove a clip and its derived data (labels/features/predictions) from the project."""
        proj = _video(pid, vid)
        proj.remove_video(vid)            # deletes labels/features/predictions files + manifest entry
        labels.forget(pid, vid)           # evict cached label DataFrame
        vm.forget(pid, vid)               # evict cached video handle + frames
        return {"ok": True, "videos": [v["video_id"] for v in proj.videos]}

    # ---- features & jobs ----
    @app.post("/api/projects/{pid}/videos/{vid}/features")
    def compute_features(pid: str, vid: str):
        entry = _video(pid, vid).video(vid)
        if not entry.get("has_poses"):
            raise HTTPException(409, "video has no poses")
        if features.status(pid, vid)["status"] == "ready":
            return {"status": "ready"}
        job = jobs.start("features", lambda p: features.compute(pid, vid, p),
                         meta={"pid": pid, "video_id": vid})
        return {"job_id": job.id, "status": "pending"}

    @app.get("/api/projects/{pid}/jobs/{jid}")
    def get_job(pid: str, jid: str):
        job = jobs.get(jid)
        if job is None:
            raise HTTPException(404, "job not found")
        return job.snapshot()

    @app.get("/api/projects/{pid}/jobs/{jid}/events")
    def job_events(pid: str, jid: str):
        if jobs.get(jid) is None:
            raise HTTPException(404, "job not found")
        def gen():
            for ev in jobs.stream(jid):
                yield f"data: {json.dumps(ev)}\n\n"
        return StreamingResponse(gen(), media_type="text/event-stream")

    # ---- training + prediction (the human-in-the-loop) ----
    @app.post("/api/projects/{pid}/behaviors/{bid}/train")
    def train_behavior(pid: str, bid: int):
        _behavior(pid, bid)

        def job(progress):
            r = trainer.train(pid, bid, lambda p, m: progress(int(p * 0.7), m))
            r["predict"] = predictor.predict_behavior(pid, bid, lambda p, m: progress(70 + int(p * 0.3), m))
            return r

        j = jobs.start("train", job, meta={"pid": pid, "behavior_id": bid})
        return {"job_id": j.id}

    @app.get("/api/projects/{pid}/behaviors/{bid}/model")
    def get_model(pid: str, bid: int):
        _behavior(pid, bid)
        meta = trainer.model_meta(pid, bid)
        if meta is None:
            raise HTTPException(404, "no trained model")
        return meta

    @app.get("/api/projects/{pid}/behaviors/{bid}/history")
    def get_history(pid: str, bid: int):
        _behavior(pid, bid)
        return {"history": trainer.history(pid, bid), "meta": trainer.model_meta(pid, bid)}

    @app.get("/api/projects/{pid}/behaviors/{bid}/feature-diff")
    def get_feature_diff(pid: str, bid: int, top_n: int = 12):
        """Per-feature positive-vs-negative separation (AUC + histograms) for this behavior."""
        _behavior(pid, bid)
        return trainer.feature_diff(pid, bid, top_n=top_n)

    @app.get("/api/projects/{pid}/behaviors/{bid}/trainset")
    def get_trainset(pid: str, bid: int):
        """Frozen provenance of the current model — which videos/tracks/bouts it was trained on."""
        proj = _behavior(pid, bid)
        ts = trainer.trainset(pid, bid)
        if ts is not None:
            return ts
        # A model trained before per-bout provenance existed has meta.json but no trainset.json.
        # It still predicts fine — degrade gracefully to the video list + totals meta.json does have,
        # marked `stale` so the UI can say "retrain to record per-bout detail" instead of "no model".
        meta = trainer.model_meta(pid, bid)
        if meta is None:
            raise HTTPException(404, "no trained model")
        return {
            "version": meta.get("version"), "trained_at": meta.get("trained_at"),
            "n_videos": len(meta.get("videos_used", [])),
            "n_pos": meta.get("n_pos", 0), "n_neg": meta.get("n_neg", 0),
            "n_pos_bouts": meta.get("n_pos_bouts", 0), "n_neg_bouts": meta.get("n_neg_bouts", 0),
            "videos": [{"video_id": v, "name": Path(str((proj.video(v) or {}).get("video_path", ""))).name or v,
                        "pos_bouts": None, "neg_bouts": None, "pos_frames": None, "neg_frames": None, "tracks": []}
                       for v in meta.get("videos_used", [])],
            "bouts": [], "stale": True,
        }

    @app.post("/api/projects/{pid}/videos/{vid}/predict")
    def predict_video(pid: str, vid: str):
        """Apply already-trained behavior models to one video (e.g. a newly loaded clip) without retraining."""
        entry = _video(pid, vid).video(vid)
        if not entry.get("has_poses"):
            raise HTTPException(409, "video has no poses")
        if not predictor.trained_behaviors(pid):
            raise HTTPException(409, "no trained model yet — train a behavior first")

        def job(progress):
            if features.status(pid, vid)["status"] != "ready":
                features.compute(pid, vid, lambda p, m: progress(int(p * 0.6), f"features: {m}"))
            return predictor.predict_video(pid, vid, lambda p, m: progress(60 + int(p * 0.4), m))

        j = jobs.start("predict", job, meta={"pid": pid, "video_id": vid})
        return {"job_id": j.id}

    @app.get("/api/projects/{pid}/predict/{vid}")
    def get_predict(pid: str, vid: str, behavior: int, track: int = 0):
        _video(pid, vid)
        proba = predictor.get_proba(pid, vid, behavior, track)
        if proba is None:
            raise HTTPException(404, "no predictions")
        blob = proba.astype("<f4").tobytes()
        return Response(content=blob, media_type="application/octet-stream",
                        headers={"X-Shape": str(len(proba)), "Cache-Control": "no-cache"})

    @app.get("/api/projects/{pid}/behaviors/{bid}/candidates/{vid}")
    def get_candidates(pid: str, vid: str, bid: int, track: int = 0, n: int = 12, mode: str = "new"):
        _behavior(pid, bid)
        _video(pid, vid)
        return predictor.candidates(pid, vid, bid, track, n, mode)

    @app.post("/api/projects/{pid}/behaviors/{bid}/reviewed")
    def set_reviewed(pid: str, bid: int, body: ReviewedBout):
        """Mark (or un-mark) a bout as reviewed-for-mislabels, so it drops out of the mislabel queue
        and appears in the 'Reviewed' tab. Persisted per behavior."""
        _behavior(pid, bid)
        if body.action == "remove":
            return predictor.unmark_reviewed(pid, bid, body.vid, body.track, body.start, body.end)
        return predictor.mark_reviewed(pid, bid, body.vid, body.track, body.start, body.end,
                                       body.label_value, "reviewed")

    _SRC_MISSING = "video/pose source file missing on disk (moved, deleted, or an ephemeral scratch dir was cleaned up) — playback unavailable for this clip; labels/features/model are unaffected"

    @app.get("/api/projects/{pid}/skeleton/{vid}")
    def get_skeleton(pid: str, vid: str):
        try:
            return vm.skeleton(pid, vid)
        except KeyError:
            raise HTTPException(404, "video not found")
        except FileNotFoundError:
            raise HTTPException(404, _SRC_MISSING)

    @app.get("/api/projects/{pid}/features/{vid}/series")
    def feature_series(pid: str, vid: str, track: int = 0):
        proj = _video(pid, vid)
        try:
            ov = vm._get(pid, vid)
        except FileNotFoundError:
            raise HTTPException(404, _SRC_MISSING)
        pose = ov.poses()                                    # (F, T, N, 3)
        nodes = list(ov.labels.skeletons[0].node_names)
        roles = proj.manifest.get("skeleton_roles", {})
        series = quick_series(pose, nodes, float(vm.meta(pid, vid)["fps"]), roles)
        F, T = pose.shape[0], pose.shape[1]
        t = max(0, min(T - 1, track))
        names = list(series)
        blob = b"".join(series[n][:, t].astype("<f4").tobytes() for n in names)
        return Response(content=blob, media_type="application/octet-stream",
                        headers={"X-Series": ",".join(names), "X-Frames": str(F),
                                 "Cache-Control": "no-cache"})

    @app.get("/api/projects/{pid}/poses/{vid}")
    def get_poses(pid: str, vid: str):
        try:
            shape, blob = vm.poses_blob(pid, vid)
        except KeyError:
            raise HTTPException(404, "video not found")
        except FileNotFoundError:
            raise HTTPException(404, _SRC_MISSING)
        headers = {"X-Pose-Shape": ",".join(map(str, shape)), "Cache-Control": "no-cache"}
        return Response(content=blob, media_type="application/octet-stream", headers=headers)

    @app.get("/api/projects/{pid}/frame/{vid}/{idx}.jpg")
    def get_frame(pid: str, vid: str, idx: int, gray: int = 1):
        try:
            data = vm.frame_jpeg(pid, vid, idx, gray=bool(gray))
        except KeyError:
            raise HTTPException(404, "video not found")
        except IndexError:
            raise HTTPException(404, "frame out of range")
        except FileNotFoundError:
            raise HTTPException(404, _SRC_MISSING)
        return Response(content=data, media_type="image/jpeg", headers=_IMMUTABLE)

    @app.get("/api/projects/{pid}/video/{vid}/stream.mp4")
    def stream_video(pid: str, vid: str):
        proj = _video(pid, vid)
        entry = proj.video(vid)
        path = entry.get("playback_path") or entry["video_path"]
        if not Path(path).exists():
            raise HTTPException(404, _SRC_MISSING)
        # FileResponse serves HTTP range requests -> the browser <video> element streams it natively.
        # Cache-Control: this Starlette version's FileResponse sets ETag/Last-Modified but does NOT
        # honor conditional requests (verified: a matching If-None-Match still gets a full 200, not
        # 304) — so without an explicit max-age, every page refresh re-fetches the whole file (often
        # 40-50MB) with zero caching benefit, which is the actual cause of "videos take a long time to
        # load on refresh". The video file for a given vid is effectively immutable once imported, so a
        # day-long cache is safe; the rare case of replacing a clip's media (e.g. a VAST recovery) needs
        # a hard-refresh (⌘⇧R) or cache-clear to pick up, same as any long-lived static asset.
        return FileResponse(path, media_type="video/mp4", headers={"Cache-Control": "private, max-age=86400"})

    # ---- behaviors ----
    @app.get("/api/projects/{pid}/behaviors")
    def list_behaviors(pid: str):
        return _proj(pid).behaviors

    @app.post("/api/projects/{pid}/behaviors")
    def add_behavior(pid: str, body: NewBehavior):
        from .featurestore import suggest_feature_set
        try:
            beh = _proj(pid).add_behavior(body.name, body.color, body.key)
        except ValueError as e:
            raise HTTPException(409, str(e))
        # never start a behavior on 'all' by accident: use the caller's choice, else auto-suggest from the name.
        fset, reason = (body.feature_set, "explicit choice") if body.feature_set else suggest_feature_set(body.name)
        if fset:
            beh = _proj(pid).update_behavior(beh["id"], feature_set=fset)
        beh["suggested_feature_set"] = fset
        beh["suggest_reason"] = reason
        return beh

    @app.get("/api/projects/{pid}/suggest-feature-set")
    def suggest_fset(pid: str, name: str):
        """Preview the auto-suggested feature set for a behavior name (so the create dialog can pre-select
        it and show why), grounded in the empirical axis rule."""
        from .featurestore import suggest_feature_set
        fset, reason = suggest_feature_set(name)
        return {"feature_set": fset, "reason": reason}

    @app.put("/api/projects/{pid}/behaviors/{bid}")
    def edit_behavior(pid: str, bid: int, body: EditBehavior):
        try:
            return _proj(pid).update_behavior(bid, **body.model_dump())
        except KeyError:
            raise HTTPException(404, "behavior not found")
        except ValueError as e:
            raise HTTPException(409, str(e))

    @app.post("/api/projects/{pid}/behaviors/{bid}/clone")
    def clone_behavior(pid: str, bid: int, with_labels: bool = False):
        """Create a parallel behavior for A/B comparison. with_labels=False -> empty (relabel from
        scratch, e.g. to compare how many labels are needed). with_labels=True -> copy the source's
        INITIAL/seed labels only (hand-painted 'manual' + 'imported', NOT the candidate-review labels)
        so the clone shares the same starting point but runs its OWN candidate process + further
        labeling independently on the new model."""
        _behavior(pid, bid)
        try:
            nb = _proj(pid).clone_behavior(bid)
        except KeyError:
            raise HTTPException(404, "behavior not found")
        if with_labels:
            nb["labels_copied"] = labels.copy_labels(pid, bid, nb["id"], initial_only=True)["frames_copied"]
        return nb

    @app.post("/api/projects/{pid}/behaviors/{bid}/copy-labels-from/{src_bid}")
    def copy_labels(pid: str, bid: int, src_bid: int, initial_only: bool = True):
        """Overwrite this behavior's labels with a copy of another behavior's. initial_only=True (default)
        copies only the seed labels (excludes candidate-review labels); pass initial_only=false for a
        fully-identical copy."""
        _behavior(pid, bid); _behavior(pid, src_bid)
        return labels.copy_labels(pid, src_bid, bid, initial_only=initial_only)

    @app.delete("/api/projects/{pid}/behaviors/{bid}")
    def delete_behavior(pid: str, bid: int):
        _proj(pid).delete_behavior(bid)
        labels.delete_behavior(pid, bid)  # cascade
        return {"ok": True}

    # ---- labels (half-open [start, end); PUT overwrites, DELETE -> unlabeled) ----
    @app.get("/api/projects/{pid}/labels/{vid}")
    def get_labels(pid: str, vid: str, track: int = 0, behavior: int | None = None):
        _video(pid, vid)
        return labels.get_runs_src(pid, vid, track, behavior)   # [start, end, value, source] per run

    @app.put("/api/projects/{pid}/labels/{vid}")
    def put_labels(pid: str, vid: str, spans: list[LabelSpan]):
        _video(pid, vid)
        labels.put_spans(pid, vid, [s.model_dump() for s in spans])
        return {"ok": True}

    @app.delete("/api/projects/{pid}/labels/{vid}")
    def delete_labels(pid: str, vid: str, behavior: int, track: int, start: int, end: int):
        _video(pid, vid)
        labels.delete_range(pid, vid, behavior, track, start, end)
        return {"ok": True}

    @app.get("/api/projects/{pid}/label-stats")
    def label_stats(pid: str):
        """Provenance of the current labels — per behavior/track/source bout+frame counts."""
        _proj(pid)
        return labels.source_stats(pid)

    web = Path(__file__).parent / "web"
    app.mount("/", StaticFiles(directory=str(web), html=True), name="web")
    return app
