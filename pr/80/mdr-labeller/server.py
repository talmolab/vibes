"""
server.py — stdlib HTTP server for the Lumon refinement labeller (no web-framework deps).

Serves the static UI, a JSON API (config / events / label), cached posters, and
Range-enabled mp4 clips (rendered on demand by the configured source). Single-user,
local: ThreadingHTTPServer + per-render locks in the source/render layer.

  python3 server.py                         # uses config.json (source="approach")
  python3 server.py --source demo --port 8752
  python3 server.py --config myconfig.json

Then open http://127.0.0.1:<port>/ . Needs a browser on the same machine (or an SSH
tunnel: ssh -L 8752:127.0.0.1:8752 host).
"""
import os
import re
import json
import argparse
import mimetypes
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
SRC = None
CFG = None


def build_source(cfg):
    name = cfg.get("source", "demo")
    if name == "approach":
        from source_approach import ApproachSource
        return ApproachSource(cfg)
    if name == "demo":
        from sources import DemoSource
        return DemoSource(cfg)
    raise ValueError(f"unknown source: {name!r}")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    # ---- helpers ----
    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _serve_file(self, path, ctype=None, allow_range=True):
        if not path or not os.path.exists(path):
            self._json({"error": "not found"}, 404)
            return
        if ctype is None:
            ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        size = os.path.getsize(path)
        start, end, code = 0, size - 1, 200
        rng = self.headers.get("Range") if allow_range else None
        if rng:
            m = re.match(r"bytes=(\d+)-(\d*)", rng)
            if m:
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else size - 1
                end = min(end, size - 1)
                code = 206
        length = max(0, end - start + 1)
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if code == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(65536, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    break
                remaining -= len(chunk)

    def _static(self, rel):
        rel = rel.lstrip("/")
        full = os.path.normpath(os.path.join(STATIC, rel))
        if not full.startswith(STATIC):
            self._json({"error": "forbidden"}, 403)
            return
        self._serve_file(full, allow_range=False)

    # ---- routes ----
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        qs = self.path.split("?", 1)[1] if "?" in self.path else ""
        if path == "/":
            self._serve_file(os.path.join(STATIC, "index.html"), "text/html; charset=utf-8", allow_range=False)
            return
        if path.startswith("/static/"):
            self._static(path[len("/static/"):])
            return
        if path == "/api/config":
            self._json({
                "labels": SRC.labels, "label_display": SRC.label_display,
                "file_code": SRC.file_code, "file_sub": SRC.file_sub, "refiner": SRC.refiner,
                "total": SRC.total(), "done": SRC.done_count(), "counts": SRC.counts(),
                "grid": CFG.get("grid", {}),
            })
            return
        if path == "/api/events":
            limit = 60
            m = re.search(r"limit=(\d+)", qs)
            if m:
                limit = min(200, int(m.group(1)))
            self._json({"events": SRC.next_events(limit)})
            return
        if path == "/api/binned":
            m = re.search(r"behavior=([^&]+)", qs)
            beh = urllib.parse.unquote(m.group(1)) if m else ""
            self._json({"behavior": beh, "events": SRC.binned(beh) if beh in SRC.labels else []})
            return
        m = re.match(r"/poster/(\d+)$", path)
        if m:
            try:
                self._serve_file(SRC.poster_path(int(m.group(1))), "image/jpeg", allow_range=False)
            except Exception:
                self._json({"error": "render failed"}, 500)
            return
        m = re.match(r"/clip/(\d+)$", path)
        if m:
            try:
                self._serve_file(SRC.clip_path(int(m.group(1))), "video/mp4", allow_range=True)
            except Exception:
                self._json({"error": "render failed"}, 500)
            return
        self._json({"error": "not found"}, 404)

    def _body(self):
        n = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(n) or b"{}")

    def _state(self, **extra):
        return {"ok": True, "done": SRC.done_count(), "total": SRC.total(),
                "counts": SRC.counts(), **extra}

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/label":
            data = self._body()
            eid, behavior = data.get("id"), data.get("behavior")
            if eid is None or behavior not in SRC.labels:
                self._json({"error": "bad label"}, 400)
                return
            SRC.label(eid, behavior)
            nxt = SRC.next_events(1)
            self._json(self._state(label=behavior, next=(nxt[0] if nxt else None)))
            return
        if path == "/api/unlabel":
            data = self._body()
            eid = data.get("id")
            if eid is None:
                self._json({"error": "bad id"}, 400)
                return
            ev = SRC.unlabel(eid)
            self._json(self._state(event=ev))
            return
        if path == "/api/relabel":
            data = self._body()
            eid, behavior = data.get("id"), data.get("behavior")
            if eid is None or behavior not in SRC.labels:
                self._json({"error": "bad label"}, 400)
                return
            SRC.relabel(eid, behavior)
            self._json(self._state(label=behavior))
            return
        self._json({"error": "not found"}, 404)


def main():
    global SRC, CFG
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.path.join(HERE, "config.json"))
    ap.add_argument("--source", default=None, help="override config source (approach|demo)")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8752)
    args = ap.parse_args()

    CFG = json.load(open(args.config))
    if args.source:
        CFG["source"] = args.source
    SRC = build_source(CFG)
    print(f"[refinement_labeller] source={CFG['source']}  events={SRC.total()}  "
          f"done={SRC.done_count()}  ->  http://{args.host}:{args.port}/")
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
