"""What keeps an evaluation's answer key out of the thing under test.

Hidden knowledge: this was the middle of `run_paired.py`, the paired method-evaluation runner (a candidate method against a frozen baseline, scored on seven
dimensions). That runner measured one thing the platform no longer does — a method is not withheld from a run to measure it, and its own runs are the detector — and
its inputs went with the legacy memory engine it drove through `PATCH /api/memory/records`, so it was deleted on 2026-10-25. This is the part that was never about
paired evaluation and is still what the clinical and VCR evaluations stand on: the hidden reference is loaded into the scorer's memory and into nothing else, and a
transport refuses to send a body that carries any value of it, by content, so a brief edited to quote its own answer key fails before dispatch instead of quietly
scoring perfectly. `packages/contracts/openmed/implementation.json` names it as the implementation of the leak check.

  HiddenReference     `evals/<capability>/hidden/<id>.reference.json`, the answer key, and the values of it that must never be sent (`secrets()`).
  LeakGuardTransport  wraps any `Transport` and raises `HiddenReferenceLeak` for a request body that carries one of them.

No inference, network or model weights; the transport is whatever the caller injects.
"""

from __future__ import annotations

import json
import urllib.parse
from pathlib import Path
from typing import Any, Iterable


class EvalError(RuntimeError):
    """A failure with an actionable message."""


class HiddenReferenceLeak(EvalError):
    """A request body carried the answer key. Never recoverable, never per-cell.

    Whatever produced it invalidates every score in the batch, so this aborts
    instead of being caught and counted: a run that was shown the reference and
    a run that was not are not the same experiment.
    """


class HiddenReference:
    """`evals/<capability>/hidden/<id>.reference.json` — the answer key.

    It is loaded into the scorer's memory and into nothing else. `secrets()` is
    what LeakGuardTransport refuses to transmit: the artifact digests, the
    golden trace's return digests, and every expected value long enough to be
    recognisable, so a leak is caught by content rather than by trusting that
    the payload builder never took the wrong argument.
    """

    __slots__ = ("brief_id", "path", "payload", "_secrets")

    def __init__(self, brief_id: str, path: Path, payload: dict[str, Any]):
        self.brief_id = brief_id
        self.path = path
        self.payload = payload
        self._secrets = frozenset(self._collect_secrets(payload))

    @staticmethod
    def _collect_secrets(payload: Any, found: set[str] | None = None) -> set[str]:
        found = set() if found is None else found
        if isinstance(payload, dict):
            for key, value in payload.items():
                if key in ("sha256", "returnDigest", "digest", "expected", "canary") and isinstance(value, str):
                    if len(value) >= 8:
                        found.add(value)
                HiddenReference._collect_secrets(value, found)
                if key == "clinicalTasks" and isinstance(value, list):
                    for task in value:
                        if isinstance(task, dict) and isinstance(task.get("reference"), dict):
                            found.add(json.dumps(task["reference"], ensure_ascii=False, sort_keys=True))
        elif isinstance(payload, list):
            for item in payload:
                HiddenReference._collect_secrets(item, found)
        return found

    def secrets(self) -> frozenset[str]:
        return self._secrets


def load_hidden_references(hidden_dir: Path | None, brief_ids: Iterable[str]) -> dict[str, HiddenReference]:
    references: dict[str, HiddenReference] = {}
    if hidden_dir is None:
        return references
    for brief_id in brief_ids:
        path = hidden_dir / f"{brief_id}.reference.json"
        if not path.is_file():
            continue
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise EvalError(f"{path}: a hidden reference must be a JSON object")
        references[brief_id] = HiddenReference(brief_id, path, payload)
    return references


def all_secrets(references: dict[str, HiddenReference]) -> set[str]:
    return {secret for reference in references.values() for secret in reference.secrets()}


class Transport:
    """The whole HTTP surface a runner uses; a test substitutes it wholesale."""

    def request(
        self,
        method: str,
        url: str,
        body: Any = None,
        headers: dict[str, str] | None = None,
        timeout: int = 60,
    ) -> tuple[int, Any, dict[str, str]]:
        raise NotImplementedError


class LeakGuardTransport(Transport):
    """Refuses to send a body that carries the answer key.

    This is the enforcement of "the hidden reference is never sent to the run
    under test". It sits under every request a runner makes — dispatch, upload,
    session binding — because the interesting leak is not the one in the
    dispatch payload a reviewer reads, it is the one in a fixture upload or a
    session note that nobody looks at.
    """

    def __init__(self, inner: Transport, secrets: Iterable[str]):
        self.inner = inner
        self.secrets = frozenset(secret for secret in secrets if isinstance(secret, str) and len(secret) >= 8)
        self.checked = 0

    def request(self, method, url, body=None, headers=None, timeout=60):
        if body is not None:
            blob = json.dumps(body, ensure_ascii=False, sort_keys=True)
            for secret in self.secrets:
                if secret in blob:
                    raise HiddenReferenceLeak(
                        f"{method} {urllib.parse.urlsplit(url).path} would have carried a hidden-reference "
                        f"value ({secret[:12]}...). The batch is void; fix the brief or the fixture."
                    )
            self.checked += 1
        return self.inner.request(method, url, body=body, headers=headers, timeout=timeout)
