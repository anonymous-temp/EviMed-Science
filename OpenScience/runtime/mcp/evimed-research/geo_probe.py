#!/usr/bin/env python3
"""What the consumer LLM front-ends actually answer, through the server's probe gateway.

Every other connector here answers about the record: what was published, what a
label says, what a trial registered. This one answers about the present tense —
put a question to DeepSeek, Doubao, Yuanbao, Qianwen or Kimi as a patient would,
and see what comes back. That is the only way to establish whether a product is
visible in the channel where people now ask, and it is a measurement rather than
a retrieval: it has a denominator.

Which is why the failure mode is different from every other tool in this file's
neighbourhood. A source fetch that fails leaves a hole somebody notices. A probe
that fails and gets recorded produces a visibility number that is simply wrong
and looks exactly like a correct one. So: a vendor that did not answer is never
a vendor that had nothing to say, a vendor that is not logged in was never
asked, and neither may be cached, counted, or resumed over. The server marks
every one of those `measurement: "failed"`; this client refuses to flatten them
into an empty result on the way through.

The runtime never learns the probe host, never composes an upstream path, and
never holds a probe credential. It names one of three operations and the server
builds the request.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

import public_sources

MAX_QUESTION = 2_000
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
OPERATIONS = ("providers", "ask", "screenshot")
PROVIDERS = ("deepseek", "doubao", "kimi", "qianwen", "yuanbao")


class GeoProbeError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


def _gateway():
    url = os.environ.get("EVIMED_GEO_PROBE_GATEWAY_URL", "").strip()
    if not url:
        raise GeoProbeError(
            "geo_probe_unconfigured",
            "The GEO probe channel is not enabled for this deployment. Measured visibility is unavailable; "
            "state that in the report rather than presenting an estimate as a measurement.",
        )
    settings = public_sources._gateway_settings()  # noqa: SLF001 - one token, one owner
    if settings is None:
        raise GeoProbeError("geo_probe_unconfigured", "The managed gateway token is unavailable.")
    return url, settings[1]


def _validated(arguments: dict) -> dict:
    op = str(arguments.get("op") or "").strip().lower()
    if op not in OPERATIONS:
        raise GeoProbeError("geo_probe_op_invalid", "op must be one of: %s." % ", ".join(OPERATIONS))
    if op == "providers":
        return {"op": op}
    if op == "screenshot":
        name = str(arguments.get("name") or "")
        if not name:
            raise GeoProbeError("geo_probe_screenshot_name_invalid", "name is required for op=screenshot.")
        return {"op": op, "name": name}

    question = str(arguments.get("question") or "").strip()
    if not question or len(question) > MAX_QUESTION:
        raise GeoProbeError(
            "geo_probe_question_invalid",
            "A non-empty question of at most %d characters is required." % MAX_QUESTION,
        )
    payload = {"op": op, "question": question}
    providers = arguments.get("providers")
    if providers:
        values = providers if isinstance(providers, list) else [providers]
        for value in values:
            if value not in PROVIDERS:
                raise GeoProbeError("geo_probe_provider_invalid", "providers must be drawn from: %s." % ", ".join(PROVIDERS))
        payload["providers"] = values
    for flag in ("deep", "newChat"):
        if arguments.get(flag) is not None:
            value = arguments[flag]
            if value not in (0, 1, True, False):
                raise GeoProbeError("geo_probe_flag_invalid", "%s must be 0 or 1." % flag)
            payload[flag] = int(bool(value))
    return payload


def _post(payload: dict) -> dict:
    url, token = _gateway()
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "accept": "application/json",
            "authorization": "Bearer %s" % token,
            "content-type": "application/json",
            "user-agent": "EviMed-Research/1.2 (runtime geo probe)",
        },
        method="POST",
    )
    try:
        # One probe drives a browser through a whole answer; the upstream's own
        # ceiling is about five minutes and it serves one caller at a time.
        with public_sources._OPENER.open(request, timeout=400) as response:  # noqa: SLF001
            body = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        detail = ""
        try:
            detail = json.loads(error.read(64 * 1024).decode("utf-8", "replace")).get("code", "")
        except Exception:  # noqa: BLE001 - the status is the finding, not the parse
            detail = ""
        raise GeoProbeError(
            detail or "geo_probe_upstream_error",
            "The GEO probe gateway returned HTTP %d." % error.code,
            # 429 here is the probe being busy with another question. It is the
            # ordinary case in a batch, not an incident.
            retryable=error.code in (409, 429, 502, 503, 504),
        ) from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise GeoProbeError("geo_probe_unavailable", "The GEO probe gateway is unreachable.", retryable=True) from error

    if len(body) > MAX_RESPONSE_BYTES:
        raise GeoProbeError("geo_probe_response_too_large", "The GEO probe response exceeded the client limit.")
    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise GeoProbeError("geo_probe_response_invalid", "The GEO probe gateway returned a non-JSON response.") from error


def probe(arguments: dict) -> dict:
    payload = _validated(arguments)
    parsed = _post(payload)
    data = parsed.get("data") or {}
    warnings = list(parsed.get("warnings") or [])

    if payload["op"] == "providers":
        ready = data.get("ready") or []
        rows = data.get("providers") or []
        missing = [row.get("provider") for row in rows if not row.get("ready")]
        return {
            # "warning" and not "success" when a vendor is missing: a batch that
            # starts against an unready vendor spends its whole run producing
            # failures, and the operator finds out at the end.
            "status": "success" if rows and not missing else "warning",
            "summary": "%d of %d vendor(s) ready: %s." % (len(ready), len(rows), ", ".join(ready) or "none"),
            "data": data,
            "warnings": warnings + ([
                "Not ready: %s. These were never asked. Do not record them as vendors that did not mention the brand, "
                "and do not put them in a denominator." % ", ".join(str(name) for name in missing),
            ] if missing else []),
            "next_actions": [
                "Log in to any vendor listed as not ready before starting a batch; a run against an unready vendor produces failures, not findings.",
            ],
        }

    if payload["op"] == "screenshot":
        return {
            "status": "success",
            "summary": "Retrieved %s (%d bytes, sha256 %s)." % (data.get("name"), data.get("bytes") or 0, str(data.get("sha256"))[:12]),
            "data": data,
            "warnings": warnings,
            "next_actions": ["Cite the screenshot by its sha256; the file name alone does not identify what was measured."],
        }

    results = data.get("results") or []
    measured = [row for row in results if row.get("inDenominator")]
    failed = [row for row in results if not row.get("inDenominator")]
    surface = data.get("surface") or {}
    return {
        # A round where nothing was measured is a failure even though the call
        # succeeded. Returning "success" with an empty result set is how a batch
        # reports full coverage having measured none of it.
        "status": "success" if measured and not failed else ("warning" if measured else "error"),
        "summary": "Probed %d vendor(s): %d measured, %d failed (%s, %s)." % (
            len(results), len(measured), len(failed),
            surface.get("mode", "?"), surface.get("session", "?"),
        ),
        "data": data,
        "warnings": warnings + ([
            "Failed: %s. A failed probe is not a measurement — retry it, and keep it out of the denominator and out of any cache." % ", ".join(
                "%s (%s)" % (row.get("provider"), row.get("error")) for row in failed
            ),
        ] if failed else []),
        "next_actions": [
            "Record the surface (%s, %s) beside every number taken from this round; the same question in a different mode is a different measurement." % (
                surface.get("mode", "?"), surface.get("session", "?"),
            ),
            "Retry any failed vendor before computing a rate; a denominator that silently shrank overstates visibility.",
        ],
    }
