"""Tell EviMed's control plane what a finished MetaAgent job spent at the provider.

MetaAgent calls DeepSeek itself, and the EviMed runtime calls this service
directly, so the control plane never sees a job end and none of a job's tokens
reached its usage ledger. Every job already leaves an ``llm_usage_manifest.json``
in its project; when the job ends, the adapter reads it and sends the totals,
once, to the control plane's internal ``/internal/usage/v1/engine``
(``EVIMED_USAGE_REPORT_URL``), which records one settled ledger row with
purpose ``engine``.

Best effort by design: the job's own result never depends on the report, and
one that cannot be delivered is written to the job log instead.

The signature mirrors ``engineUsageSignature`` in the control plane
(``OpenScience/apps/server/src/engineUsage.mjs``) and the specialist adapter's
``usage_report.py``: an HMAC-SHA256 of the exact body under a key derived from
the workload signing secret. One pinned vector sits in all three test suites.
"""
from __future__ import annotations

import hashlib
import hmac
import http.client
import json
import time
import urllib.error
import urllib.request
from collections import Counter
from collections.abc import Callable
from typing import Any

KEY_DOMAIN = b"evimed/engine-usage/key/v1"
SIGNATURE_HEADER = "X-EviMed-Engine-Usage-Signature"
COUNT_FIELDS = ("requests", "cacheHitTokens", "cacheMissTokens", "outputTokens")


def signature(secret: str, body: bytes) -> str:
    """The report's signature, lowercase hex."""
    key = hmac.new(secret.encode("utf-8"), KEY_DOMAIN, hashlib.sha256).digest()
    return hmac.new(key, body, hashlib.sha256).hexdigest()


def usage_from_manifest(manifest: Any) -> dict[str, Any] | None:
    """A job's provider usage from its ``llm_usage_manifest.json``.

    Counted from the events rather than the summary: an event that records an
    API error was never answered and is not a billed request.
    """
    if not isinstance(manifest, dict) or not isinstance(manifest.get("events"), list):
        return None
    totals = {field: 0 for field in COUNT_FIELDS}
    models: Counter[str] = Counter()
    for event in manifest["events"]:
        if not isinstance(event, dict) or str(event.get("error_type") or "").strip():
            continue
        prompt = max(0, int(event.get("prompt_tokens") or 0))
        hit = max(0, int(event.get("prompt_cache_hit_tokens") or 0))
        miss_value = event.get("prompt_cache_miss_tokens")
        miss = max(0, int(miss_value)) if miss_value is not None else max(0, prompt - hit)
        totals["requests"] += 1
        totals["cacheHitTokens"] += hit
        totals["cacheMissTokens"] += miss
        totals["outputTokens"] += max(0, int(event.get("completion_tokens") or 0))
        if event.get("model"):
            models[str(event["model"])] += 1
    return {**totals, "model": models.most_common(1)[0][0] if models else ""}


def delta(current: dict[str, Any], reported: Any) -> dict[str, Any]:
    """What ``current`` adds to what was already reported for this job.

    A resumed job's manifest carries every attempt's events, and each attempt
    reports only its own share, so no token is counted twice.
    """
    earlier = reported if isinstance(reported, dict) else {}
    counts = {field: max(0, int(current.get(field) or 0) - int(earlier.get(field) or 0)) for field in COUNT_FIELDS}
    return {**counts, "model": str(current.get("model") or "")}


def report(
    *,
    url: str,
    secret: str,
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

    A refusal (4xx other than 429) is final; server errors, 429 and transport
    failures are retried a bounded number of times.
    """
    if not url:
        return "not configured"
    body = json.dumps(
        {
            "v": 1,
            "kind": "meta-analysis",
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
            headers={"content-type": "application/json", SIGNATURE_HEADER: f"v1={signature(secret, body)}"},
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
