"""Where a job's engine sends its model calls: the model gateway, per job.

With ``EVIMED_ENGINE_MODEL_GATEWAY`` on (the compose file sets it from the
deployment's one lever, ``OPEN_SCIENCE_ENGINE_MODEL_GATEWAY_ENABLED``), an
admitted job's engine no longer calls DeepSeek with the key mounted in this
container. At admission the adapter asks the control plane
(``EVIMED_ENGINE_MODEL_TOKEN_URL``, ``/internal/engines/v1/model-token``) for a
credential for that one job, with two proofs: the runtime's own workload
token, which names the account and project and proves a runtime of theirs is
live, and an HMAC of the body under a key derived from the workload signing
secret, which a runtime never holds. The credential reaches the job's worker
through its spawn environment only -- never the state file -- and the engine
sees it as its API key, with the gateway as its base URL. The gateway then
reserves and settles each call, holds it to the certified model, the account's
caps and the starting run's budget, and books it with purpose ``engine``, so
the after-the-fact usage report is not sent for such a job.

The signature mirrors ``engineModelRequestSignature`` in the control plane's
``apps/server/src/modelGatewayEngineTokens.mjs``; one pinned vector sits in
both test suites.
"""
from __future__ import annotations

import hashlib
import hmac
import http.client
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from typing import Any

KEY_DOMAIN = b"evimed/engine-model-token/key/v1"
SIGNATURE_HEADER = "X-EviMed-Engine-Signature"
#: The worker's spawn environment carries these two; `_child_environment`
#: removes them and hands the engine the names it reads.
TOKEN_ENV = "EVIMED_JOB_MODEL_TOKEN"
BASE_URL_ENV = "EVIMED_JOB_MODEL_BASE_URL"
POLICY_ENV = "EVIMED_JOB_MODEL_POLICY"
CONTEXT_HEADER = "X-EviMed-Execution-Context"
EFFORTS = frozenset({"off", "low", "high", "max"})
_TOKEN = re.compile(r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")
_RESPONSE_LIMIT = 16 * 1024


class EngineModelUnavailable(RuntimeError):
    """No credential for this job; the message names why, never a secret."""



def validate_context(value):
    """Bound caller metadata; the control plane verifies the owning session."""
    fields = {"v", "sessionId", "callId", "rootCallId", "provider", "model", "reasoningEffort"}
    if (not isinstance(value, dict) or set(value) - fields or value.get("v") != 1
            or value.get("provider") != "deepseek-official"
            or value.get("model") not in {"deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"}
            or not isinstance(value.get("sessionId"), str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", value["sessionId"])
            or any(not isinstance(value.get(key), str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_:.-]{0,199}", value[key])
                   for key in ("callId", "rootCallId"))
            or ("reasoningEffort" in value and value["reasoningEffort"] not in EFFORTS)):
        raise EngineModelUnavailable("the engine execution context is invalid")
    return dict(value)


def context_header(raw):
    if raw is None:
        return None
    if not isinstance(raw, str) or len(raw.encode("utf-8")) > 4096:
        raise EngineModelUnavailable("the engine execution context is invalid")
    try:
        return validate_context(json.loads(raw))
    except (ValueError, TypeError):
        raise EngineModelUnavailable("the engine execution context is invalid") from None


def model_policy(value):
    if not isinstance(value, dict) or value.get("reasoningEffort") not in EFFORTS:
        raise EngineModelUnavailable("the control plane answered without a usable model policy")
    return {"reasoningEffort": value["reasoningEffort"], "source": str(value.get("source") or "deployment-default"),
            **({"sessionId": value["sessionId"]} if isinstance(value.get("sessionId"), str) else {})}

def enabled() -> bool:
    """Whether this deployment routes engine model calls through the gateway."""
    return os.getenv("EVIMED_ENGINE_MODEL_GATEWAY", "").strip().casefold() in {"1", "true", "yes", "on"}


def _http_url(value: str) -> str:
    parsed = urllib.parse.urlsplit(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise EngineModelUnavailable("the model gateway address is not an absolute HTTP(S) URL")
    return value


def token_url() -> str:
    """The control plane's credential endpoint, or a refusal naming the setting."""
    value = os.getenv("EVIMED_ENGINE_MODEL_TOKEN_URL", "").strip()
    if not value:
        raise EngineModelUnavailable("EVIMED_ENGINE_MODEL_TOKEN_URL is not configured")
    return _http_url(value)


def signature(secret: str, body: bytes) -> str:
    """The request's signature, lowercase hex."""
    key = hmac.new(secret.encode("utf-8"), KEY_DOMAIN, hashlib.sha256).digest()
    return hmac.new(key, body, hashlib.sha256).hexdigest()


def request_credential(
    *,
    url: str,
    secret: str,
    workload_token: str | None,
    kind: str,
    job_id: str,
    opener: Callable[..., Any] | None = None,
    execution_context: dict | None = None,
) -> dict[str, str]:
    """The spawn-environment entries that route one job through the gateway.

    One attempt, bounded: admission is a request the runtime is waiting on, and
    a control plane that cannot answer in seconds cannot meter the job either.
    Any failure refuses the job rather than falling back to a provider key --
    with the lever on, this container is not meant to hold one.
    """
    if not workload_token:
        raise EngineModelUnavailable("the job arrived without a workload token")
    payload = {"v": 1, "kind": kind, "jobId": job_id}
    if execution_context is not None:
        payload["executionContext"] = validate_context(execution_context)
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "content-type": "application/json",
            "accept": "application/json",
            "Authorization": f"Bearer {workload_token}",
            SIGNATURE_HEADER: f"v1={signature(secret, body)}",
        },
    )
    try:
        with (opener or urllib.request.urlopen)(request, timeout=5) as response:  # noqa: S310 — operator-configured internal URL
            payload = json.loads(response.read(_RESPONSE_LIMIT + 1)[:_RESPONSE_LIMIT].decode("utf-8"))
    except urllib.error.HTTPError as error:
        code = ""
        try:
            # The control plane's refusal envelope: `{"error": message, "code": code}`.
            detail = json.loads(error.read(4096).decode("utf-8"))
            code = str(detail.get("code") or "") if isinstance(detail, dict) else ""
        except (OSError, ValueError, AttributeError):
            pass
        suffix = f", {code}" if re.fullmatch(r"[a-z][a-z0-9_]{0,79}", code) else ""
        raise EngineModelUnavailable(f"the control plane refused the job's model credential (HTTP {error.code}{suffix})") from None
    except (urllib.error.URLError, OSError, TimeoutError, http.client.HTTPException, ValueError):
        raise EngineModelUnavailable("the control plane did not issue the job's model credential") from None
    data = payload.get("data") if isinstance(payload, dict) else None
    token = data.get("token") if isinstance(data, dict) else None
    base_url = data.get("baseUrl") if isinstance(data, dict) else None
    if not isinstance(token, str) or len(token) > 8 * 1024 or not _TOKEN.fullmatch(token):
        raise EngineModelUnavailable("the control plane answered without a usable credential")
    if not isinstance(base_url, str) or not base_url:
        raise EngineModelUnavailable("the control plane answered without the gateway address")
    environment = {TOKEN_ENV: token, BASE_URL_ENV: _http_url(base_url.rstrip("/"))}
    if execution_context is not None or data.get("modelPolicy") is not None:
        policy = model_policy(data.get("modelPolicy"))
        if execution_context is not None and (policy.get("sessionId") != execution_context["sessionId"]
                or (execution_context.get("reasoningEffort") is not None
                    and policy["reasoningEffort"] != execution_context["reasoningEffort"])):
            raise EngineModelUnavailable("the issued model policy differs from the job's session")
        environment[POLICY_ENV] = json.dumps(policy, separators=(",", ":"))
    return environment


def child_environment(token: str, base_url: str, policy: dict | None = None) -> dict[str, str]:
    """What the engine reads, pointed at the gateway with the job's credential.

    Every engine appends ``/chat/completions`` to whichever of these base URLs
    it reads, which is the gateway's route under ``/internal/model/v1``. The
    policy is the one the runtime-side launcher sets
    (``runtime/mcp/evimed-research/specialist_jobs.py``): the gateway enables
    thinking on every call, and an engine that knows so budgets its answers
    for it instead of truncating a short flash-tier answer.
    """
    selected = model_policy(policy or {"reasoningEffort": "high", "source": "deployment-default"})
    effort = selected["reasoningEffort"]
    return {
        "EVIMED_MODEL_GATEWAY_POLICY": "high-thinking" if effort in {"high", "max"} else "managed-thinking",
        "LLM_REASONING_EFFORT": effort,
        "LLM_ENABLE_THINKING": "false" if effort == "off" else "true",
        "DEEPSEEK_API_KEY": token,
        "DEEPSEEK_BASE_URL": base_url,
        "LLM_API_KEY": token,
        "LLM_BASE_URL": base_url,
    }
