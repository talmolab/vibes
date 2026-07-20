"""`laras-labeler` entry point (PLAN.md §10): launch uvicorn, open the browser when ready.

v0a bootstraps an in-memory "dev" project pointing at the mice sample so there is
something to label immediately. On-disk projects (§9) land in a later step.
"""

import os
from __future__ import annotations

import argparse
import socket
import threading
import time
import webbrowser
from pathlib import Path

import uvicorn

from .config import Settings
from .project import ProjectStore

SAMPLE_SLP = Path(os.environ.get("LARAS_SAMPLE_SLP",""))


def _free_port(host: str, preferred: int) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind((host, preferred))
            return preferred
        except OSError:
            s.bind((host, 0))
            return s.getsockname()[1]


def _open_when_ready(host: str, port: int) -> None:
    url = f"http://{host}:{port}/"
    for _ in range(100):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex((host, port)) == 0:
                webbrowser.open(url)
                return
        time.sleep(0.1)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="laras-labeler")
    ap.add_argument("projects_root", nargs="?", default="~/laras-projects",
                    help="directory of on-disk projects (a 'dev' project is seeded on first run)")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=0, help="0 = auto-pick (prefers 8760)")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args(argv)

    projects_root = Path(args.projects_root).expanduser()
    port = args.port or _free_port(args.host, 8760)
    settings = Settings(projects_root=projects_root, host=args.host, port=port)
    store = ProjectStore(projects_root)
    store.ensure_dev(SAMPLE_SLP)

    from .app import create_app

    app = create_app(settings, store)
    if not args.no_browser:
        threading.Thread(target=_open_when_ready, args=(args.host, port), daemon=True).start()
    print(f"laras-labeler -> http://{args.host}:{port}/")
    uvicorn.run(app, host=args.host, port=port, log_level="info")


if __name__ == "__main__":
    main()
