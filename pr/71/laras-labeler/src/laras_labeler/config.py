"""Runtime settings (PLAN.md §10)."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass
class Settings:
    projects_root: Path
    host: str = "127.0.0.1"
    port: int = 8760
    frame_cache_size: int = 256
    jpeg_quality: int = 85
