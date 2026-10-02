"""Frozen aggregate calculations on the control plane's owned engine jobs.

The runtime sends a method and an existing aggregate input path. The control
plane preserves the bytes, admits fixed code/environment identities and binds
actual completed engine receipts to immutable results. No recipe, executable,
connection credential or patient-level table is supplied by the model.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

import public_sources
from execution_context import validate_context

METHODS = ("meta.dl", "faers.signals", "bibliometric.network", "design.analytic", "comparator.evalue")
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
TIMEOUT_SECONDS = 30
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}")


class ResearchCalculateError(Exception):
    def __init__(self, code, message, retryable=False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect())


def tool_definitions():
    return [{"name": "research_calculate", "description": (
        "Compute frozen aggregate JSON with an admitted deterministic engine: meta.dl studies {id,label,yi,vi}, "
        "faers.signals 2x2 tables {id,a,b,c,d}, bibliometric.network edges {source,target,weight,source_freq,target_freq}, "
        "or VCR design.analytic/comparator.evalue scenarios. action=start/status/cancel; completed results preserve "
        "input/code/environment identities and original bytes. No scripts, retrieval, fitted EBGM prior or patient rows."),
        "inputSchema": {"type": "object", "additionalProperties": False, "required": ["action"], "properties": {
            "action": {"type": "string", "enum": ["start", "status", "cancel"]},
            "method": {"type": "string", "enum": list(METHODS)},
            "inputPath": {"type": "string", "minLength": 1, "maxLength": 2048,
                          "description": "Workspace-relative frozen aggregate JSON (at most 8 MiB); never a patient-level file."},
            "parameters": {"type": "object", "additionalProperties": False, "properties": {
                "maxNodes": {"type": "integer", "minimum": 1, "maximum": 500},
                "yates": {"type": "boolean"}, "correctZeroCells": {"type": "boolean"}}},
            "requestId": {"type": "string", "minLength": 1, "maxLength": 160},
            "jobId": {"type": "string", "minLength": 1, "maxLength": 160},
        }}}]


def _gateway():
    base = os.environ.get("EVIMED_RESULT_GATEWAY_URL", "").strip().rstrip("/")
    parsed = urllib.parse.urlsplit(base)
    if not base:
        raise ResearchCalculateError("result_engine_unavailable", "Deterministic calculation is unavailable in this conversation.")
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ResearchCalculateError("result_gateway_unconfigured", "The deterministic calculation gateway is not configured.")
    try:
        settings = public_sources._gateway_settings()
    except public_sources.PublicSourceError:
        raise ResearchCalculateError("result_gateway_unconfigured", "The managed calculation credential is unavailable.") from None
    if settings is None:
        raise ResearchCalculateError("result_gateway_unconfigured", "The managed calculation credential is unavailable.")
    return base, settings[1]


def _read_response(response, deadline, limit):
    chunks, total = [], 0
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError()
        # read1 performs one underlying read rather than waiting to fill a big
        # buffer; every streamed body chunk shares the original total deadline.
        sock = getattr(getattr(getattr(response, "fp", None), "raw", None), "_sock", None)
        if sock is not None:
            sock.settimeout(remaining)
        chunk = (getattr(response, "read1", None) or response.read)(min(65536, limit + 1 - total))
        if not chunk:
            break
        total += len(chunk)
        if total > limit:
            raise ResearchCalculateError("result_response_too_large", "Calculation response exceeded the client limit.")
        chunks.append(chunk)
    return b"".join(chunks)


def calculate(arguments, execution_context=None):
    if not isinstance(arguments, dict) or set(arguments) - {"action", "method", "inputPath", "parameters", "requestId", "jobId"}:
        raise ResearchCalculateError("result_input_invalid", "Unsupported calculation request fields.")
    action = arguments.get("action")
    if action not in {"start", "status", "cancel"}:
        raise ResearchCalculateError("result_input_invalid", "A calculation action is required.")
    context = None
    if execution_context is not None:
        try:
            context = validate_context(execution_context)
        except ValueError:
            raise ResearchCalculateError("result_execution_context_invalid", "The calculation turn cannot be identified.") from None
    payload = dict(arguments); payload.pop("action")
    if action == "start":
        if not context:
            raise ResearchCalculateError("result_execution_context_unavailable", "The calculation needs an owned conversation turn.")
        if set(payload) - {"method", "inputPath", "parameters", "requestId"} or payload.get("method") not in METHODS:
            raise ResearchCalculateError("result_input_invalid", "Select an admitted deterministic method.")
        relative = payload.get("inputPath")
        if (not isinstance(relative, str) or not relative or len(relative) > 2048 or relative.startswith("/") or "\\" in relative
                or any(ord(char) < 32 for char in relative) or any(part in {"", ".", ".."} for part in relative.split("/"))):
            raise ResearchCalculateError("result_input_invalid", "The aggregate input must be a workspace-relative file.")
        parameters = payload.setdefault("parameters", {})
        if not isinstance(parameters, dict):
            raise ResearchCalculateError("result_input_invalid", "Calculation parameters must be structured fields.")
        allowed = {"yates", "correctZeroCells"} if payload["method"] == "faers.signals" else {"maxNodes"} if payload["method"] == "bibliometric.network" else set()
        if set(parameters) - allowed:
            raise ResearchCalculateError("result_input_invalid", "This method does not accept the supplied parameter.")
        if "maxNodes" in parameters and (type(parameters["maxNodes"]) is not int or not 1 <= parameters["maxNodes"] <= 500):
            raise ResearchCalculateError("result_input_invalid", "maxNodes must be between 1 and 500.")
        if any(type(parameters[key]) is not bool for key in {"yates", "correctZeroCells"} & set(parameters)):
            raise ResearchCalculateError("result_input_invalid", "Signal options must be booleans.")
        payload.setdefault("requestId", "calculate-" + hashlib.sha256((context["sessionId"] + ":" + context["callId"]).encode()).hexdigest())
        if not isinstance(payload["requestId"], str) or not _ID.fullmatch(payload["requestId"]):
            raise ResearchCalculateError("result_input_invalid", "Invalid calculation request identifier.")
    elif set(payload) != {"jobId"} or not isinstance(payload.get("jobId"), str) or not _ID.fullmatch(payload["jobId"]):
        raise ResearchCalculateError("result_input_invalid", "Supply the owned calculation job identifier.")
    base, token = _gateway()
    headers = {"authorization": "Bearer " + token, "content-type": "application/json", "accept": "application/json"}
    if context:
        headers["X-EviMed-Execution-Context"] = json.dumps(context, separators=(",", ":"))
    request = urllib.request.Request(base + "/" + action, data=json.dumps(payload, ensure_ascii=False).encode(), headers=headers, method="POST")
    deadline = time.monotonic() + TIMEOUT_SECONDS
    try:
        with _OPENER.open(request, timeout=TIMEOUT_SECONDS) as response:
            body = _read_response(response, deadline, MAX_RESPONSE_BYTES)
    except urllib.error.HTTPError as error:
        code = "result_gateway_error"
        try:
            detail = json.loads(_read_response(error, deadline, 65536))
            reported = detail.get("code") if isinstance(detail, dict) else None
            if isinstance(reported, str) and re.fullmatch(r"(?:result|replay)_[a-z0-9_]{1,80}", reported):
                code = reported
        except (ValueError, TimeoutError, OSError, ResearchCalculateError):
            pass
        raise ResearchCalculateError(code, "The calculation gateway refused the request.", error.code in {429, 502, 503, 504}) from None
    except (TimeoutError, urllib.error.URLError, OSError):
        # A lost response is not proof a job stopped. The stable requestId lets
        # the gateway resolve the same admission rather than compute twice.
        raise ResearchCalculateError("result_gateway_unreachable", "Calculation response is unavailable; inspect the same request before starting another.", True) from None
    try:
        parsed = json.loads(body)
        data = parsed.get("data") if isinstance(parsed, dict) else None
        if not isinstance(data, dict) or not isinstance(data.get("id"), str) or not isinstance(data.get("state"), str):
            raise ValueError()
    except (ValueError, UnicodeDecodeError):
        raise ResearchCalculateError("result_response_invalid", "Calculation response did not identify an owned job.") from None
    state = data["state"]
    return {"status": "warning" if state in {"failed", "canceled", "timed_out", "ownership_unknown"} else "success",
            "summary": "Deterministic calculation is " + state + ".", "data": data,
            **({"warnings": ["The selected calculation has no usable new result; prior results remain available."],
                "next_actions": ["Read the named failure and continue from preserved work."]} if state in {"failed", "canceled", "timed_out", "ownership_unknown"} else {})}
