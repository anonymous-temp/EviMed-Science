"""The money guard: the provider's balance, read at most once a minute, and the round's own cap.

Every new rollout (the solver, the only cash the round spends) asks `ensure()` first. Below the floor the call waits (the round is paused,
not failed: the same process resumes by itself when the balance recovers); a balance that cannot be read at all is not guessed.
"""

from __future__ import annotations

import json
import threading
import time
import urllib.request
from pathlib import Path

from . import config
from .errors import BudgetStop, InfrastructureFailure


def read_balance_cny(key_file: Path | None = None, url: str = config.DEEPSEEK_BALANCE_URL, timeout: int = 20) -> float:
    """The CNY balance of the key in `key_file`. The key goes to its own service and nowhere else; no error text carries it."""
    key = Path(key_file or config.DEEPSEEK_KEY_FILE).read_text(encoding="utf-8").strip()
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {key}", "User-Agent": "evimed-rsi1/0.1"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        raise InfrastructureFailure("balance", f"the balance endpoint could not be read ({type(exc).__name__})") from None
    for info in body.get("balance_infos") or []:
        if info.get("currency") == "CNY":
            return float(info["total_balance"])
    raise InfrastructureFailure("balance", "the balance answer has no CNY entry")


class BalanceGuard:
    def __init__(self, *, fetch=read_balance_cny, floor: float = config.BALANCE_FLOOR_CNY, min_interval: float = config.BALANCE_MIN_INTERVAL_S,
                 cap_cny: float | None = config.ROUND_CAP_CNY, spent=None, clock=time.monotonic, sleep=time.sleep, log=print,
                 max_pause_s: float | None = None):
        self.fetch, self.floor, self.min_interval, self.cap = fetch, floor, min_interval, cap_cny
        self.spent = spent  # callable -> CNY the round has spent so far (the ledger's settled solver cost)
        self.clock, self.sleep, self.log, self.max_pause_s = clock, sleep, log, max_pause_s
        self._lock = threading.Lock()
        self._last: float | None = None
        self._at: float | None = None
        self.reads = 0

    def balance(self) -> float:
        with self._lock:
            now = self.clock()
            if self._at is None or now - self._at >= self.min_interval:
                self._last = self.fetch()
                self._at = now
                self.reads += 1
            return float(self._last)

    def ensure(self, what: str = "a new paid call") -> float:
        if self.cap is not None and self.spent is not None:
            spent = float(self.spent())
            if spent >= self.cap:
                raise BudgetStop(f"the round has spent {spent:.2f} CNY, its cap is {self.cap:.2f}; refusing {what}")
        paused_since = None
        while True:
            balance = self.balance()
            if balance >= self.floor:
                return balance
            if paused_since is None:
                paused_since = self.clock()
                self.log(f"PAUSED: balance {balance:.2f} CNY is below the floor {self.floor:.2f}; waiting before {what}")
            if self.max_pause_s is not None and self.clock() - paused_since >= self.max_pause_s:
                raise BudgetStop(f"balance stayed below {self.floor:.2f} CNY for {self.max_pause_s:.0f} s")
            self.sleep(self.min_interval)
