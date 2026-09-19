"""Tell the control plane what a finished job spent at the model provider.

The engines call DeepSeek from their own containers, and the runtime calls
this adapter directly, so the control plane never sees a job end and none of
an engine's tokens reached its usage ledger. The engine's runner now counts
every provider response and writes the totals into ``result.json`` as
``usage``; this module forwards them, once per job, to the control plane's
internal ``/internal/usage/v1/engine`` (``EVIMED_USAGE_REPORT_URL``), which
records one settled ledger row with purpose ``engine``.

Best effort by design: the job's own result never depends on the report. A
report that cannot be delivered is written to the job's log rather than
dropped without a trace.

The signature mirrors ``engineUsageSignature`` in the control plane's
``apps/server/src/engineUsage.mjs``: an HMAC-SHA256 of the exact body under a
key derived from the workload signing secret with the label below. The same
pinned vector sits in both test suites.
"""
from __future__ import annotations

import hashlib
import hmac
import http.client
import json
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any

KEY_DOMAIN = b"evimed/engine-usage/key/v1"
SIGNATURE_HEADER = "X-EviMed-Engine-Usage-Signature"
_COUNT_FIELDS = ("requests", "cacheHitTokens", "cacheMissTokens", "outputTokens")
_MAX_COUNT = 10**12


def signature(secret: str, body: bytes) -> str:
    """The report's signature, lowercase hex."""
    key = hmac.new(secret.encode("utf-8"), KEY_DOMAIN, hashlib.sha256).digest()
    return hmac.new(key, body, hashlib.sha256).hexdigest()


def normalize(usage: Any) -> dict[str, Any] | None:
    """The runner's usage block, or None when it reported none or a malformed one.

    Checked here rather than trusted: the block comes out of a file the engine
    process wrote, and a count that is not a whole number would be refused by
    the control plane after the job had already ended.
    """
    if not isinstance(usage, dict):
        return None
    counts: dict[str, Any] = {}
    for field in _COUNT_FIELDS:
        value = usage.get(field)
        if type(value) is not int or value < 0 or value > _MAX_COUNT:
            return None
        counts[field] = value
    model = usage.get("model")
    if not isinstance(model, str) or len(model) > 100:
        return None
    return {**counts, "model": model}


def report(
    *,
    url: str,
    secret: str,
    kind: str,
    job_id: str,
    user_id: str,
    project_id: str,
    status: str,
    finished_at: str,
    usage: dict[str, Any],
    attempt: int = 1,
    attempts: int = 3,
    sleep: Callable[[float], None] = time.sleep,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> str:
    """Deliver one report and say what happened, for the job log.

    A refusal (4xx other than 429) is final: the control plane has decided the
    report can never be recorded, and sending it again changes nothing. Server
    errors, 429 and transport failures are retried a bounded number of times.
    """
    if not url:
        return "not configured"
    body = json.dumps(
        {
            "v": 1,
            "kind": kind,
            "jobId": job_id,
            "attempt": attempt,
            "userId": user_id,
            "projectId": project_id,
            "status": status,
            "finishedAt": finished_at,
            "usage": usage,
        },
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    try:
        request = urllib.request.Request(
            url,
            data=body,
            method="POST",
            headers={
                "content-type": "application/json",
                SIGNATURE_HEADER: f"v1={signature(secret, body)}",
            },
        )
    except ValueError:
        # An address urllib cannot send to (no scheme, say): a deployment
        # mistake for the job log to name, never an exception out of a job
        # that has already ended.
        return "not sent (invalid report URL)"
    last = ""
    for index in range(max(1, attempts)):
        try:
            with opener(request, timeout=10) as response:  # noqa: S310 — operator-configured internal URL
                return f"recorded (HTTP {response.status})"
        except urllib.error.HTTPError as error:
            last = f"HTTP {error.code}"
            if error.code < 500 and error.code != 429:
                return f"refused ({last})"
        except (urllib.error.URLError, OSError, TimeoutError, http.client.HTTPException, ValueError) as error:
            last = type(error).__name__
        if index + 1 < attempts:
            sleep(2**index)
    return f"undelivered ({last})"
