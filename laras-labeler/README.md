# laras-labeler

A local, pose-based, human-in-the-loop behavior classifier — a lightweight, modern
[JAABA](https://jaaba.sourceforge.net/). Annotate positive/negative **frames** across videos, derive
features from multi-animal poses (`sleap-io` + `movement`), train a `scikit-learn` classifier, and
get per-frame predictions back in the annotation UI to guide the next labels.

**See [`PLAN.md`](PLAN.md) for the full design** (data contracts, feature/ML pipeline, API, on-disk
format, milestones).

## Status

- **v0a foundation — DONE & verified.** `uv` package scaffold; core `SLP → Labels.numpy() → movement
  clean → kinematics/pairwise` pipeline verified on the mice sample; FastAPI backend serving
  **authoritative frames + pose blob**; minimal browser viewer (frame + skeleton overlay, scrub,
  play, arrow-key step).
- **Next:** labeling (paint pos/neg ranges → per-frame parquet store, ethogram timeline, undo/redo)
  → on-disk project layer (PLAN §9) → feature cache job (PLAN §4) → **v0b** train/predict loop +
  prediction heatstrip.

## Run (dev)

The heavy part is the `movement` install; on Intel macOS it needs the viz-free recipe (PLAN §1):

```bash
git clone https://github.com/talmolab/vibes.git
cd vibes/laras-labeler          # run all commands from inside this folder
uv venv --python 3.12 .venv
uv pip install --python .venv sleap-io scikit-learn fastapi "uvicorn[standard]" python-multipart \
    pandas pyarrow joblib pydantic numpy scipy xarray
uv pip install --python .venv movement==0.17.0 --no-deps
uv pip install --python .venv attrs pooch tqdm shapely PyYAML loguru orjson bottleneck
uv pip install --python .venv -e . --no-deps

# launch — pass a folder for your projects (created on first run); it prints the URL and opens the browser
.venv/bin/laras-labeler ~/laras-projects
```

Verify the core pipeline headlessly:

```bash
.venv/bin/python scripts/verify_pipeline.py
```

v0a bootstraps an in-memory "dev" project pointing at
`../slp-viewer/mice.tracked.slp`. Point it at your own data once the
on-disk project layer lands.
