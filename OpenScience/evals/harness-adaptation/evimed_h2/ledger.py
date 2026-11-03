"""One ledger file for everything the round spends: `rsi1-ledger.jsonl`, append-only, one row per paid thing, keyed.

A key is the identity of the thing that was paid for (a rollout's request id, an improver call's content address), so writing it twice
writes it once: a resumed round that finds a finished rollout or a cached reply adds nothing, and the file's totals are the money.

Rollout rows carry the settled cost the control plane recorded for the run (CNY, from the bundle's result.json): the solver is the only
cash the round spends. Improver rows carry the token usage the CLI reported and its API-equivalent `usd_reported`: every improver stage is
Claude on the box's own login, subscription usage with no cash figure.
"""

from __future__ import annotations

import fcntl
import json
import threading
import time
from pathlib import Path


class Ledger:
    def __init__(self, path: Path | str):
        self.path = Path(path)
        self._lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.touch(exist_ok=True)

    def _read(self) -> list[dict]:
        rows = []
        for line in self.path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    continue  # a torn last line from a killed process: the key is simply not there
        return rows

    def rows(self) -> list[dict]:
        with self._lock:
            return self._read()

    def append(self, key: str, **fields) -> bool:
        """Write the row unless its key is already there. Returns whether it was written."""
        row = {"t": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "key": key, **fields}
        with self._lock, open(self.path, "a+", encoding="utf-8") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            try:
                handle.seek(0)
                content = handle.read()
                for line in content.splitlines():
                    if line.strip():
                        try:
                            if json.loads(line).get("key") == key:
                                return False
                        except ValueError:
                            continue
                handle.seek(0, 2)
                if content and not content.endswith("\n"):
                    handle.write("\n")  # a killed writer's torn last line must not swallow this row
                handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
                handle.flush()
                return True
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)

    def totals(self) -> dict:
        rows = self.rows()
        solver = [r for r in rows if r.get("kind") == "rollout" and not r.get("cached")]
        improver = [r for r in rows if r.get("kind") == "improver" and not r.get("cached")]
        by_stage: dict[str, dict] = {}
        for r in improver:
            slot = by_stage.setdefault(r.get("stage", "?"), {"calls": 0, "usd_reported": 0.0, "input": 0, "output": 0, "cache_read": 0})
            slot["calls"] += 1
            slot["usd_reported"] += float(r.get("usd_reported") or 0.0)
            usage = r.get("usage") or {}
            slot["input"] += int(usage.get("input_tokens") or 0)
            slot["output"] += int(usage.get("output_tokens") or 0)
            slot["cache_read"] += int(usage.get("cache_read_input_tokens") or 0)
        return {
            "rollouts": len(solver),
            "rollouts_without_cost": sum(1 for r in solver if r.get("cny") is None),
            "solver_cny": round(sum(float(r.get("cny") or 0.0) for r in solver), 6),
            "improver_calls": len(improver),
            "by_stage": {k: {**v, "usd_reported": round(v["usd_reported"], 4)} for k, v in by_stage.items()},
        }
