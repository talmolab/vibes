"""Tiny background job runner with an append-only event log (PLAN.md §8).

One worker thread per job; events are appended to a list so SSE and poll both work,
and late/reconnecting subscribers still see the whole history. Single-user, so no
cross-job locking beyond this.
"""

from __future__ import annotations

import threading
import time
import traceback
from itertools import count


class Job:
    def __init__(self, job_id: str, kind: str, meta: dict) -> None:
        self.id = job_id
        self.kind = kind
        self.meta = meta
        self.events: list[dict] = []
        self.status = "pending"
        self.result: dict | None = None
        self._lock = threading.Lock()

    def _emit(self, **ev) -> None:
        with self._lock:
            self.events.append(ev)

    def snapshot(self) -> dict:
        with self._lock:
            last = self.events[-1] if self.events else {}
        return {"job_id": self.id, "kind": self.kind, "status": self.status,
                "pct": last.get("pct"), "msg": last.get("msg"), "error": last.get("error"),
                "result": self.result, **self.meta}


class JobManager:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._ids = count(1)

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def start(self, kind: str, fn, meta: dict | None = None) -> Job:
        job = Job(f"job-{next(self._ids)}", kind, meta or {})
        self._jobs[job.id] = job

        def run():
            job.status = "running"
            job._emit(pct=0, msg="started", status="running")
            try:
                def progress(pct, msg):
                    job._emit(pct=pct, msg=msg, status="running")
                job.result = fn(progress) or {}
                job.status = "done"
                job._emit(pct=100, msg="done", status="done", result=job.result)
            except Exception as e:  # noqa: BLE001
                job.status = "error"
                job._emit(status="error", error=str(e), trace=traceback.format_exc())

        threading.Thread(target=run, daemon=True).start()
        return job

    def stream(self, job_id: str):
        """Yield every event (including history) until a terminal one, for SSE."""
        job = self._jobs[job_id]
        i = 0
        while True:
            if i < len(job.events):
                ev = job.events[i]
                i += 1
                yield ev
                if ev.get("status") in ("done", "error"):
                    return
            elif job.status in ("done", "error"):
                return
            else:
                time.sleep(0.05)
