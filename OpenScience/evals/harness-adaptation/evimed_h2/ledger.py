"""One ledger file for everything the round spends: `rsi1-ledger.jsonl`, append-only, one row per paid thing, keyed.

A key is the identity of the thing that was paid for (a rollout's request id, an improver call's content address), so writing it twice
writes it once: a resumed round that finds a finished rollout or a cached reply adds nothing, and the file's totals are the money.

Rollout rows carry the settled cost the control plane recorded for the run (CNY, from the bundle's result.json). Improver rows carry the
token usage the CLI reported; for the Claude stages that is subscription usage (`usd_reported`, API-equivalent, no cash), for the DeepSeek
stage it is cash, estimated here from the platform's own reference rates because the CLI prices an unknown model as if it were Claude.
"""

from __future__ import annotations

import fcntl
import json
import threading
import time
from pathlib import Path

# CNY per million tokens at the platform's reference list (packages/domain/src/metering.mjs, evimed-reference-2026-10-17): the peak
# rate, so an estimate is an upper bound; the provider halves it off-peak.
DEEPSEEK_CNY_PER_M = {
    "deepseek-v4-pro": {"cache_hit": 0.3, "cache_miss": 9.0, "output": 27.0},
    "deepseek-flash": {"cache_hit": 0.04, "cache_miss": 2.0, "output": 8.0},
}


def deepseek_cny(model: str, usage: dict) -> float | None:
    base = model.split("[", 1)[0]
    rates = DEEPSEEK_CNY_PER_M.get(base)
    if not rates or not usage:
        return None
    miss = float(usage.get("input_tokens") or 0) + float(usage.get("cache_creation_input_tokens") or 0)
    hit = float(usage.get("cache_read_input_tokens") or 0)
    out = float(usage.get("output_tokens") or 0)
    return round((hit * rates["cache_hit"] + miss * rates["cache_miss"] + out * rates["output"]) / 1e6, 6)


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
            slot = by_stage.setdefault(r.get("stage", "?"), {"calls": 0, "cny": 0.0, "usd_reported": 0.0, "input": 0, "output": 0, "cache_read": 0})
            slot["calls"] += 1
            slot["cny"] += float(r.get("cny") or 0.0)
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
            "improver_cash_cny_estimated": round(sum(float(r.get("cny") or 0.0) for r in improver), 6),
            "by_stage": {k: {**v, "cny": round(v["cny"], 6), "usd_reported": round(v["usd_reported"], 4)} for k, v in by_stage.items()},
            "round_cash_cny": round(sum(float(r.get("cny") or 0.0) for r in solver + improver), 6),
        }
