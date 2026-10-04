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

# What each method reads from its frozen input file, written as an input that
# runs. Every key is one its engine requires, except a key ending in `?`, which
# may be left out; a tuple holds the alternatives a key admits, first the one
# an example takes; a list is an array. `also` holds further inputs that run,
# for what a note says in words.
#
# The engines check these shapes themselves and answer a wrong one with a
# failed job that names no key. The description used to offer meta.dl
# `studies {id,label,yi,vi}` and nothing else, and maxNodes as an option:
# an input written from it was one the executor refuses. So the description
# is rendered from this table, `calculate` takes its parameter names from it,
# and tests hold it to the validators that run: deterministic_replay.py for
# the first three methods, the control plane's VCR replay for the last two.
_TWO_ARM = {"kind": ("two_arm_fixed",)}
_BINARY = {"type": ("binary",)}
_TIME_TO_EVENT = {"endpoint": {"type": ("time_to_event",)}, "truth": {"hazardRatio": 0.7, "controlMedian": 12}}
_ANALYSIS = {"alpha": 0.05, "power": 0.8, "sided": 2}
METHOD_INPUTS = {
    "meta.dl": {
        "input": {"studies": [{"id": "s1", "label": "Study 1", "yi": 0.12, "vi": 0.04},
                              {"id": "s2", "label": "Study 2", "yi": 0.3, "vi": 0.09}],
                  "effectMeasure": ("MD", "SMD", "RD", "OR", "RR", "HR", "IRR"), "outcome": "Outcome"},
        "note": "two or more studies with distinct ids; yi is a study's effect on the analysis scale (the natural log "
                "for OR, RR, HR, IRR) and vi its variance, above 0",
    },
    "faers.signals": {
        "input": {"tables": [{"id": "T1", "a": 10, "b": 90, "c": 20, "d": 1880}]},
        "note": "2x2 counts, integers of 0 or more, one table per id: a the drug with the event, b the drug with other "
                "events, c other drugs with the event, d other drugs with other events",
        "parameters": {"optional": ("yates", "correctZeroCells")},
    },
    "bibliometric.network": {
        "input": {"edges": [{"source": "A", "target": "B", "weight": 2, "source_freq": 8, "target_freq": 7}]},
        "note": "each pair once; weight is the pair's co-occurrence count, source_freq and target_freq each node's own "
                "frequency, all above 0",
        "parameters": {"required": ("maxNodes",)},
    },
    "design.analytic": {
        "input": {"scenario": (
            {"design": _TWO_ARM, "endpoint": {"type": ("continuous",)}, "truth": {"effect": 5, "sd?": 12},
             "analysis?": {"alpha?": 0.05, "power?": 0.8, "sided?": 2}},
            {"design": _TWO_ARM, "endpoint": _BINARY, "truth": {"controlRate": 0.3, "treatmentRate": 0.45}},
            {"design": _TWO_ARM, **_TIME_TO_EVENT},
            {"design": {"kind": ("group_sequential",), "informationRates": [0.5, 1]}, **_TIME_TO_EVENT},
            {"design": {"kind": ("simon_two_stage",)}, "endpoint": _BINARY,
             "truth": {"nullRate": 0.2, "alternativeRate": 0.4}},
            {"design": {"kind": ("single_arm",), "n": 40}, "endpoint": _BINARY,
             "truth": {"nullRate": 0.2, "responseRate": 0.4},
             "analysis": {"method": ("exact_binomial",), "alternative": ("greater", "less")}},
        )},
        "also": (
            {"scenario": {"design": {"kind": "two_arm_fixed"}, "endpoint": {"type": "binary"},
                          "truth": {"controlRate": 0.3, "treatmentRate": 0.45}, "analysis": _ANALYSIS}},
            {"scenario": {"design": {"kind": "two_arm_fixed"}, "endpoint": {"type": "time_to_event"},
                          "truth": {"hazardRatio": 0.7, "controlMedian": 12}, "analysis": _ANALYSIS}},
            {"scenario": {"design": {"kind": "group_sequential", "informationRates": [0.5, 1]},
                          "endpoint": {"type": "time_to_event"},
                          "truth": {"hazardRatio": 0.7, "controlMedian": 12}, "analysis": _ANALYSIS}},
        ),
        "note": "the optional analysis fits every two_arm_fixed and group_sequential scenario and defaults to alpha "
                "0.025 in total, power 0.9, sided 1; sd defaults to 1; informationRates rise to 1",
    },
    "comparator.evalue": {
        "input": {"scenario": {"riskRatio": 3.9, "confidenceLimit?": 1.8,
                               "scale?": ("risk_ratio", "odds_ratio", "hazard_ratio"), "rare?": False}},
        "note": "riskRatio is the estimate on that scale and confidenceLimit the interval limit nearer 1; rare reads "
                "an odds or hazard ratio of a rare outcome as a risk ratio",
    },
}

# Why the executor declines a calculation, in its closed vocabulary (the `refusals` of each method's record in
# method_records.json; a test holds this table to it). A refusal declines that one calculation: it names what
# to correct, and no other result is touched.
REFUSAL_REASONS = {
    "replay_single_study": "meta.dl needs at least two studies; one study has nothing to pool and no between-study variance.",
    "replay_duplicate_study_ids": "Two studies share an id, so the same study would be counted twice; give each study one row.",
    "replay_nonpositive_variance": "A study variance is zero or negative; each vi must be above 0.",
    "replay_nonfinite_value": "A value is not a finite number (NaN or infinity); a missing value must be left out or supplied, not passed on.",
    "replay_not_estimable": "A table has a zero cell and correctZeroCells is false, so its ratios are not estimable.",
    "replay_duplicate_table_ids": "Two tables share an id, so the same pair would be counted twice; give each pair one table.",
    "replay_empty_table": "A table has no reports at all (a, b, c and d are all 0).",
    "replay_duplicate_edges": "The same pair of nodes appears twice, and the graph would silently keep only one of the counts.",
    "replay_self_loop_edge": "An edge joins a node to itself.",
}
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


def _shape(value):
    """An input as the description writes it: keys, `[]` for an array, `|` between a key's alternatives."""
    if isinstance(value, dict):
        return "{%s}" % ",".join(key + _shape(item) for key, item in value.items())
    if isinstance(value, list):
        return "[%s]" % (_shape(value[0]) if isinstance(value[0], dict) else "")
    if isinstance(value, tuple):
        return ":" + "|".join(_shape(item) if isinstance(item, dict) else item for item in value)
    return ""


def _method_text(method):
    spec = METHOD_INPUTS[method]
    parameters = spec.get("parameters", {})
    return "; ".join(["%s %s -- %s" % (method, _shape(spec["input"]), spec["note"]),
                      *("parameters.%s is required" % name for name in parameters.get("required", ())),
                      *(["optional parameters " + ", ".join(parameters["optional"])] if parameters.get("optional") else [])])


def tool_definitions():
    return [{"name": "research_calculate", "description": (
        "Compute frozen aggregate JSON with an admitted deterministic engine. inputPath is a JSON file in its method's "
        "shape, written here with ? after an optional key and | between a key's alternatives; a missing key, or one the "
        "engine does not read, fails the calculation. "
        + ". ".join(_method_text(method) for method in METHODS)
        + ". action=start/status/cancel; completed results preserve input/code/environment identities and original "
        "bytes. No scripts, retrieval, fitted EBGM prior or patient rows. action=render fills a report template's "
        "{{n:alias.key|f2}} references from machine values into a NEW file."),
        "inputSchema": {"type": "object", "additionalProperties": False, "required": ["action"], "properties": {
            "action": {"type": "string", "enum": ["start", "status", "cancel", "render"]},
            "method": {"type": "string", "enum": list(METHODS)},
            "inputPath": {"type": "string", "minLength": 1, "maxLength": 2048,
                          "description": "Workspace-relative frozen aggregate JSON in its method's shape (at most 8 MiB); never a patient-level file."},
            "parameters": {"type": "object", "additionalProperties": False, "properties": {
                "maxNodes": {"type": "integer", "minimum": 1, "maximum": 500,
                             "description": "bibliometric.network, required: the graph keeps this many of the most frequent nodes."},
                "yates": {"type": "boolean", "description": "faers.signals: Yates-correct the chi-square (default false)."},
                "correctZeroCells": {"type": "boolean",
                                     "description": "faers.signals: add 0.5 to every cell of a table that has a zero (default true); false fails the calculation on such a table."}}},
            "requestId": {"type": "string", "minLength": 1, "maxLength": 160},
            "jobId": {"type": "string", "minLength": 1, "maxLength": 160},
            "templatePath": {"type": "string", "minLength": 1, "maxLength": 2048,
                             "description": "render: workspace-relative text template with {{n:alias.key|format}} references; key is a "
                                            "machine value's key (values.pooled_effect); formats raw int f1 f2 f3 pct0 pct1 pct2 thousands months text."},
            "outputPath": {"type": "string", "minLength": 1, "maxLength": 2048,
                           "description": "render: workspace-relative NEW file for the report; an existing file is never overwritten."},
            "calculations": {"type": "object", "maxProperties": 8, "description":
                             "render: alias -> {jobId} of a finished calculation | {versionId} of a result | {resultsPath, receiptPath?} of a "
                             "results JSON and its run_analysis.py receipt. An unresolved reference reads 未计算; typed numbers stay and are checked."},
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


def _workspace_path(value, what):
    if (not isinstance(value, str) or not value or len(value) > 2048 or value.startswith("/") or "\\" in value
            or any(ord(char) < 32 for char in value) or any(part in {"", ".", ".."} for part in value.split("/"))):
        raise ResearchCalculateError("result_input_invalid", "The %s must be a workspace-relative file." % what)
    return value


_ALIAS = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,39}")
_JOB = re.compile(r"replay_[a-f0-9]{64}")
_VERSION = re.compile(r"rv_[a-f0-9]{64}")


def _render_payload(payload):
    """A render request as the gateway reads it: two paths and the calculations its references name."""
    if set(payload) != {"templatePath", "outputPath", "calculations"}:
        raise ResearchCalculateError("result_input_invalid", "Render takes templatePath, outputPath and calculations.")
    templates = _workspace_path(payload["templatePath"], "template")
    outputs = _workspace_path(payload["outputPath"], "output")
    calculations = payload["calculations"]
    if not isinstance(calculations, dict) or not 1 <= len(calculations) <= 8:
        raise ResearchCalculateError("result_input_invalid", "Name one to eight calculations.")
    checked = {}
    for alias, source in calculations.items():
        if not isinstance(alias, str) or not _ALIAS.fullmatch(alias) or not isinstance(source, dict):
            raise ResearchCalculateError("result_input_invalid", "A calculation is an alias and one source.")
        if set(source) == {"jobId"} and isinstance(source["jobId"], str) and _JOB.fullmatch(source["jobId"]):
            checked[alias] = {"jobId": source["jobId"]}
        elif set(source) == {"versionId"} and isinstance(source["versionId"], str) and _VERSION.fullmatch(source["versionId"]):
            checked[alias] = {"versionId": source["versionId"]}
        elif set(source) <= {"resultsPath", "receiptPath"} and "resultsPath" in source:
            checked[alias] = {key: _workspace_path(value, key) for key, value in source.items()}
        else:
            raise ResearchCalculateError("result_input_invalid", "A calculation is a finished job, a result version or a results file.")
    return {"templatePath": templates, "outputPath": outputs, "calculations": checked}


def calculate(arguments, execution_context=None):
    if not isinstance(arguments, dict) or set(arguments) - {"action", "method", "inputPath", "parameters", "requestId", "jobId",
                                                            "templatePath", "outputPath", "calculations"}:
        raise ResearchCalculateError("result_input_invalid", "Unsupported calculation request fields.")
    action = arguments.get("action")
    if action not in {"start", "status", "cancel", "render"}:
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
        accepted = METHOD_INPUTS[payload["method"]].get("parameters", {})
        if set(parameters) - {*accepted.get("required", ()), *accepted.get("optional", ())}:
            raise ResearchCalculateError("result_input_invalid", "This method does not accept the supplied parameter.")
        # The engine refuses the job without it, and says only that it failed.
        for required in accepted.get("required", ()):
            if required not in parameters:
                raise ResearchCalculateError("result_input_invalid", "%s requires parameters.%s." % (payload["method"], required))
        if "maxNodes" in parameters and (type(parameters["maxNodes"]) is not int or not 1 <= parameters["maxNodes"] <= 500):
            raise ResearchCalculateError("result_input_invalid", "maxNodes must be between 1 and 500.")
        if any(type(parameters[key]) is not bool for key in {"yates", "correctZeroCells"} & set(parameters)):
            raise ResearchCalculateError("result_input_invalid", "Signal options must be booleans.")
        payload.setdefault("requestId", "calculate-" + hashlib.sha256((context["sessionId"] + ":" + context["callId"]).encode()).hexdigest())
        if not isinstance(payload["requestId"], str) or not _ID.fullmatch(payload["requestId"]):
            raise ResearchCalculateError("result_input_invalid", "Invalid calculation request identifier.")
    elif action == "render":
        if not context:
            raise ResearchCalculateError("result_execution_context_unavailable", "Rendering needs an owned conversation turn.")
        payload = _render_payload(payload)
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
    if action == "render":
        notes = []
        if data.get("unresolved"):
            notes.append("Some references named no value; the report reads 未计算 there. Check the alias and key against the calculation's machine values.")
        if data.get("unbound"):
            notes.append("Some numbers the template typed match no calculation value; they stay in the report and are listed as unverified.")
        return {"status": "success", "summary": "The report was rendered from the calculations' values.", "data": data,
                **({"warnings": notes} if notes else {})}
    next_actions = ["Read the named failure and continue from preserved work."]
    reported = data.get("error") if isinstance(data.get("error"), dict) else {}
    refusal = REFUSAL_REASONS.get(reported.get("code")) if isinstance(reported.get("code"), str) else None
    if state == "failed" and refusal:
        # The executor declined this calculation and said why: that, not the input's shape, is what to correct.
        next_actions.append("Correct that one input and start the calculation again; every other result is unaffected.")
    elif state == "failed":
        # A wrong input shape arrives here as a bare failure; without this the
        # run looks for the cause in its container instead of in its file.
        next_actions.append("Before starting another, compare the input file with its method's shape in this tool's "
                            "description: the engine fails a missing or unread key without naming it.")
    warned = {"failed", "canceled", "timed_out", "ownership_unknown"}
    return {"status": "warning" if state in warned else "success",
            "summary": "Deterministic calculation is " + state + ".", "data": data,
            **({"warnings": [*([refusal] if state == "failed" and refusal else []),
                             "The selected calculation has no usable new result; prior results remain available."],
                "next_actions": next_actions} if state in warned else {})}
