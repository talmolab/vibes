# MDR Labeller

**Landing page:** https://vibes.tlab.sh/mdr-labeller/

A Severance / Lumon *"Macrodata Refinement"*-styled web front-end for labelling animal
social-behavior clips. A dense grid of rounded clip tiles sits where the show's floating
numbers do: **hover a tile to enlarge it and play** the rank-colored skeleton clip; **drag
it into one of the numbered bins** (the ethogram) to label it — or press the bin's number
key while hovering. The bins fill and the top completion bar advances as you refine, MDR-style.

> **Not a hosted vibe.** Unlike the other tools in this repo, this one runs a small Python
> backend (`server.py`) that renders behavior clips on demand with `ffmpeg`, so it can't run
> on `vibes.tlab.sh` — clone the repo and run it locally. A self-contained **demo mode**
> (synthetic clips) needs only `numpy` + `ffmpeg`; **real mode** reads a pre-rendered
> behavior-clip corpus. The landing page above is a static description of the tool.

It is a drop-in alternative to a keyboard-driven labelling GUI: same inputs and the
**identical `labels.csv` schema** (`cohort, stem, contact_start, appr, appe, rank_appr,
rank_appe, condition, behavior`), so the two share resume state (dedup on
`(cohort, stem, contact_start)`).

## Run

Demo mode — synthetic clips, no external data, needs only `numpy` + the `ffmpeg` CLI:

```bash
cd mdr-labeller
python3 server.py --source demo
# open the printed URL (default http://127.0.0.1:8752/)
```

Real mode reads a behavior-clip corpus (`index.csv` + pre-rendered `clips/` + posters) and
writes labels to a `labels.csv`. It needs `numpy`, `opencv-python` (`cv2`), `pandas`, and the
`ffmpeg` CLI. Point the config at your corpus (see below), then either run the server
directly or use the one-shot launcher:

```bash
./run.sh start        # launch detached on :8752 (survives logout via setsid)
./run.sh status
./run.sh stop
./run.sh restart
```

Env overrides: `PORT=8752`, `SOURCE=demo|approach` (empty = config), `LABELLER_PYTHON=python3`.
`run.sh` prints the exact `ssh -L …` tunnel line for the host it's on. The server binds to
**loopback**, so reach it from your laptop over SSH:
`ssh -L 8752:127.0.0.1:8752 <user>@<host>` then open `http://127.0.0.1:8752/`.

## Interactions

- **Idle tiles** are poster images (one decoded frame — cheap for a dense grid).
- **Hover** loads/renders that clip's short H.264 mp4 and plays it; only the hovered clip decodes.
- **Drag** the still-playing tile into a bin (a placeholder holds its grid slot → zero extra
  decode), or press the bin's number key while hovering.
- **`z`** while hovering opens a fullscreen lightbox.
- **Hover a bin** for a flyout of its filed clips; drag one back out to un-file, or onto
  another bin to re-file.

## How clips work

A web grid of dozens of hoverable tiles can't stream frames live, so each event is rendered
**once** to a cached short H.264 mp4 (`ffmpeg`, `yuv420p`) plus a cheap single-frame poster.
First hover of an un-cached event incurs the render (~1s); it's cached under `cache/`
(git-ignored) thereafter. `render.py` reuses the source pipeline's exact overlay (crop,
rank colors, approacher→approachee arrow, red contact dot).

## Config (`config.json`)

| Key | Meaning |
|-----|---------|
| `source` | `"approach"` (real) or `"demo"` (synthetic). CLI `--source` overrides. |
| `labels` | The bins / ethogram, in key order (`1..N`). Swap freely — this is the label set. |
| `label_display` | Optional short names shown on bins (long label → short). |
| `file_code` / `file_sub` | The Lumon "file" name + subtitle in the header. |
| `clip` | `pad_before`, `window`, `cell` (px), `fps` for the rendered clip. |
| `grid` | `tile_px` (idle tile size), `zoom` (hover scale factor). |
| `approach.*` | Paths to the corpus / features / labels for real mode (see keys in the file). |

## Files

| File | Role |
|------|------|
| `index.html` | Static landing page for the vibes gallery (this description). |
| `server.py` | stdlib HTTP server: static UI, JSON API, Range-enabled mp4, on-demand render. |
| `sources.py` | `BaseSource` (serving/served/done bookkeeping) + `DemoSource` (synthetic). |
| `source_approach.py` | Real source: corpus/features → events, `labels.csv` schema. |
| `render.py` | Per-event skeleton clip/poster rendering + cache. |
| `ffmpeg_util.py` | H.264/yuv420p mp4 + jpg encode helpers. |
| `run.sh` | One-shot detached launcher (`start`/`status`/`stop`/`restart`). |
| `static/` | `index.html`, `styles.css`, `app.js` (the Lumon UI + grid/drag logic). |

## Adding a different clip source

Subclass `BaseSource` (see `DemoSource`): implement `done_key`, `load_done`, `write_label`,
`counts`, `poster_path`, `clip_path`, and populate `self.events` (dicts with an int `id`).
Register it in `server.build_source` and set `source` in the config. The label set comes from
`config.labels`, so a new source only supplies events + clips.

---

A [Talmo Lab](https://talmolab.org) vibe.
