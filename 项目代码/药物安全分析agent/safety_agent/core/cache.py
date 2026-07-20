"""Two-level TTL cache: in-memory dict in front of JSON files on disk.

Used by the openFDA client so repeated count queries within the TTL
(default 24 h) never hit the network twice. All failures of the disk
layer degrade to "cache miss" — a broken cache must never break a
request, but every degradation is logged (no silent swallowing).
"""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path
from typing import Any

from .logging import get_logger

logger = get_logger(__name__)


class TwoLevelCache:
    """Memory + disk cache keyed by a SHA-256 of the request identity."""

    def __init__(self, cache_dir: Path | None, ttl_seconds: float) -> None:
        self._dir = cache_dir
        self._ttl = ttl_seconds
        self._memory: dict[str, tuple[float, Any]] = {}

    @staticmethod
    def make_key(*parts: str) -> str:
        """Stable cache key from request-defining parts."""
        h = hashlib.sha256()
        for part in parts:
            h.update(part.encode("utf-8"))
            h.update(b"\x00")
        return h.hexdigest()

    @property
    def enabled(self) -> bool:
        return self._ttl > 0

    def get(self, key: str) -> Any | None:
        """Return the cached payload or None on miss/expiry."""
        if not self.enabled:
            return None
        now = time.time()
        entry = self._memory.get(key)
        if entry is not None:
            expires_at, payload = entry
            if expires_at > now:
                return payload
            del self._memory[key]
        payload = self._read_disk(key, now)
        if payload is not None:
            self._memory[key] = (now + self._ttl, payload)
        return payload

    def set(self, key: str, payload: Any) -> None:
        """Store a JSON-serializable payload in both levels."""
        if not self.enabled:
            return
        expires_at = time.time() + self._ttl
        self._memory[key] = (expires_at, payload)
        self._write_disk(key, expires_at, payload)

    # -- disk level ------------------------------------------------------

    def _path(self, key: str) -> Path | None:
        if self._dir is None:
            return None
        return self._dir / f"{key}.json"

    def _read_disk(self, key: str, now: float) -> Any | None:
        path = self._path(key)
        if path is None or not path.is_file():
            return None
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
            expires_at = float(record["expires_at"])
            if expires_at <= now:
                path.unlink(missing_ok=True)
                return None
            return record["payload"]
        except (OSError, ValueError, KeyError, TypeError) as exc:
            # Corrupt cache files are treated as a miss and removed; the
            # warning keeps the degradation visible instead of silent.
            logger.warning("discarding unreadable cache file %s: %s", path, exc)
            try:
                path.unlink(missing_ok=True)
            except OSError:
                logger.warning("could not remove corrupt cache file %s", path)
            return None

    def _write_disk(self, key: str, expires_at: float, payload: Any) -> None:
        path = self._path(key)
        if path is None:
            return
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            record = {"expires_at": expires_at, "payload": payload}
            path.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
        except (OSError, TypeError, ValueError) as exc:
            logger.warning("disk cache write failed for %s: %s", path, exc)
