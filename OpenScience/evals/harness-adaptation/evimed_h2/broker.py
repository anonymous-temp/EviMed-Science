"""The adapter's side of the lab broker: `lab/brokerctl.py` as a subprocess, and nothing about how the lab runs a request.

brokerctl's verbs, as built: `submit REQUEST.json` (idempotent by rid; refuses an answer, a rubric or a score), `status --json`
(pending count, the claimed rids, `resultsReady`, `infraFailed`), `fetch DIR` (every ready bundle as `<rid>.tgz` + `<rid>.meta.json`, and a
`<rid>.infra-failed.json` marker for a request that never ran to an answer; each is deleted on the host once verified here).
`fetch` takes everything that is ready, whoever asked for it, so concurrent callers share one inbox and one lock.
"""

from __future__ import annotations

import fcntl
import json
import re
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from . import config
from .errors import ContaminationRefused, InfrastructureFailure

BROKERCTL = config.PACKAGE_ROOT / "lab" / "brokerctl.py"


class BrokerClient:
    """The interface the adapter uses. `BrokerctlClient` is the real one; tests pass a fake with the same three verbs."""

    def submit(self, request: dict, fetch_manifests: list[Path] | None = None) -> str:
        raise NotImplementedError

    def status(self) -> dict:
        raise NotImplementedError

    def fetch(self, inbox: Path) -> None:
        raise NotImplementedError


class BrokerctlClient(BrokerClient):
    def __init__(self, argv: list[str] | None = None, *, env: dict | None = None, timeout: int = 1800):
        self.argv = list(argv or [sys.executable, str(BROKERCTL)])
        self.env = env
        self.timeout = timeout

    def _run(self, *words: str, timeout: int | None = None) -> subprocess.CompletedProcess:
        try:
            return subprocess.run([*self.argv, *words], capture_output=True, text=True, timeout=timeout or self.timeout, env=self.env)
        except subprocess.TimeoutExpired:
            raise InfrastructureFailure("broker", f"brokerctl {words[0]} timed out") from None
        except OSError as exc:
            raise InfrastructureFailure("broker", f"brokerctl could not start ({type(exc).__name__})") from None

    def submit(self, request: dict, fetch_manifests=None) -> str:
        with tempfile.TemporaryDirectory(prefix="h2-submit-") as scratch:
            path = Path(scratch) / f"{request['rid']}.json"
            path.write_text(json.dumps(request, ensure_ascii=False), encoding="utf-8")
            extra: list[str] = []
            for manifest in fetch_manifests or []:
                extra += ["--fetch", str(manifest)]
            done = self._run("submit", *extra, str(path))
        if done.returncode == 2 and "refused" in done.stderr:
            raise ContaminationRefused(f"the broker refused request {request['rid']}: {done.stderr.strip()[:300]}")
        if done.returncode != 0:
            raise InfrastructureFailure("broker", f"submit failed ({done.returncode}): {done.stderr.strip()[:300]}")
        found = re.search(r"(\d+) accepted, (\d+) already there", done.stdout)
        return "existing" if found and int(found.group(2)) else "accepted"

    def status(self) -> dict:
        done = self._run("status", "--json", timeout=300)
        if done.returncode != 0:
            raise InfrastructureFailure("broker", f"status failed ({done.returncode}): {done.stderr.strip()[:300]}")
        try:
            return json.loads(done.stdout)
        except ValueError:
            raise InfrastructureFailure("broker", "status did not answer JSON") from None

    def fetch(self, inbox: Path) -> None:
        inbox.mkdir(parents=True, exist_ok=True)
        done = self._run("fetch", str(inbox))
        if done.returncode != 0:
            raise InfrastructureFailure("broker", f"fetch failed ({done.returncode}): {done.stderr.strip()[:300]}")


class Inbox:
    """Where fetched bundles land, and the one lock that serializes fetching across threads and processes."""

    _thread_lock = threading.Lock()

    def __init__(self, path: Path, client: BrokerClient, *, poll_s: float = 30.0, clock=time.monotonic, sleep=time.sleep):
        self.path = Path(path)
        self.client = client
        self.poll_s = poll_s
        self.clock, self.sleep = clock, sleep
        self.path.mkdir(parents=True, exist_ok=True)
        self._status: dict | None = None
        self._status_at: float | None = None
        self._status_lock = threading.Lock()

    def bundle(self, rid: str) -> Path:
        return self.path / f"{rid}.tgz"

    def marker(self, rid: str) -> Path:
        return self.path / f"{rid}.infra-failed.json"

    def status(self) -> dict:
        """One status call per poll interval however many threads wait."""
        with self._status_lock:
            now = self.clock()
            if self._status is None or self._status_at is None or now - self._status_at >= self.poll_s:
                self._status = self.client.status()
                self._status_at = now
            return self._status

    def fetch(self) -> None:
        with self._thread_lock, open(self.path / ".fetch.lock", "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                self.client.fetch(self.path)
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)
        with self._status_lock:
            self._status_at = None

    def archive(self, rid: str, tag: str) -> None:
        folder = self.path / "archive"
        folder.mkdir(exist_ok=True)
        for name in (f"{rid}.tgz", f"{rid}.meta.json", f"{rid}.infra-failed.json"):
            source = self.path / name
            if source.exists():
                source.replace(folder / f"{tag}.{name}")

    def wait_for(self, rid: str, *, max_wait_s: float) -> str:
        """Block until the request's bundle is in the inbox ('bundle') or the lab gave up on it ('infra'); else raise on the deadline."""
        started = self.clock()
        while True:
            if self.bundle(rid).is_file():
                return "bundle"
            if self.marker(rid).is_file():
                return "infra"
            state = self.status()
            if rid in state.get("resultsReady", []) or rid in state.get("infraFailed", []):
                self.fetch()
                if self.bundle(rid).is_file() or self.marker(rid).is_file():
                    continue  # brokerctl exits 0 when one transfer failed verification; then it is asked again after a pause
            if self.clock() - started >= max_wait_s:
                raise InfrastructureFailure("lab_wait", f"request {rid} was not finished after {max_wait_s:.0f} s; it is still the lab's, ask again later")
            self.sleep(self.poll_s)
