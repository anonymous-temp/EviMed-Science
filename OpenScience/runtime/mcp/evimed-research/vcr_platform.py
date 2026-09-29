#!/usr/bin/env python3
"""「虚拟临研」's study data, deterministic compute and trial registry, through
the server's gateway (build contract 2026-09-28 §3.2).

Five tools a 虚拟临研 capability's run uses; none is ever forced into a turn.

- ``vcr_read`` reads the study in the shapes its pages show: the definition,
  the eligibility criteria, the assumption cards, the population, patient sets,
  comparator designs, trial scenarios, results, models and jobs. **Aggregates
  and structure only** -- no row of any person ever comes back, and a cell
  speaking for fewer than ten people is merged or withheld by the server before
  it leaves.
- ``vcr_write`` writes what the run decides: the research definition, the
  structured eligibility criteria, assumption cards, population, comparator and
  trial designs, decision records and report text. The server checks every item
  against closed vocabularies and refuses invalid items one by one; what was
  refused comes back in ``issues`` and everything else is written. **It cannot
  write a number**: results, counts, measures and execution records are the
  engine's, and an item carrying one of those fields is refused by name.
- ``vcr_simulate`` queues a frozen scenario on the deterministic engine and
  reports where it got to (``start`` / ``status`` / ``cancel``, the same shape
  as ``meta_analysis``). The model never computes a statistic itself; it states
  the scenario and reads the result.
- ``trial_registry_record`` fetches one registry record as structured fields --
  eligibility text, arms, endpoints, planned and actual enrolment. The run
  never reaches a registry itself; the control plane does.
- ``evidence_pool`` hands several extracted estimates to the engine to be
  pooled into one assumption distribution, and returns the job to poll. The
  pooling is the engine's (DL / REML / HKSJ with a prediction interval), not
  the model's.

The runtime does not know where the study's data lives. It posts to the
server's own route with the same runtime token as the public-source gateway;
the token names the account and the project, and the project names the study --
there is no id a run could point elsewhere. With the module off, or not open to
this account, the runtime is given no route and every tool answers
``vcr_disabled`` without a request, as a warning the run reads and moves on
from.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request

import public_sources

# The closed vocabularies, as `apps/server/src/vcrService.mjs` defines them.
# `apps/server/test/vcrGateway.test.mjs` reads this file and holds these copies
# equal to the server's.
READ_WHATS = (
    "study", "definition", "criteria", "assumptions", "population", "patients", "comparator", "trial",
    "precedents", "matching", "results", "snapshot_profile", "models", "jobs", "trial_registry_record",
)
WRITE_WHATS = (
    "definition", "protocol", "criteria", "assumption", "population", "patient_set", "comparator",
    "trial_scenario", "design_grid", "decision", "report", "model", "forecast", "step",
)
JOB_KINDS = (
    "profile_snapshot", "build_cohort", "generate_population", "synthesize_population", "generate_patients",
    "reconstruct_km", "pool_evidence", "weight_comparator", "rmst", "design_analytic", "design_simulation",
    "design_grid", "assurance", "accrual_forecast", "map_prior", "match_criteria",
)
POOLING_METHODS = ("single_study", "random_effects_dl", "random_effects_reml", "random_effects_hksj", "fixed_effect")
SIMULATE_ACTIONS = ("start", "status", "cancel")
READ_MAX_LIMIT = 50
WRITE_MAX_ITEMS = 200
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
# Reads, writes and job submissions answer within ten seconds server-side; the
# client's ceiling leaves room for one retry under the kernel's 180 s limit.
TIMEOUT_SECONDS = 30
GATEWAY_CODE = re.compile(r"^(?:vcr|registry|engine)_[a-z0-9_]{1,60}$")
ID = {"type": "string", "minLength": 1, "maxLength": 160, "pattern": r"^[A-Za-z0-9_.:@-]+$"}


class VcrPlatformError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


def tool_definitions():
    return [
        {
            "name": "vcr_read",
            "description": (
                "Read this 虚拟临研 study: its definition and estimand, structured eligibility criteria, assumption "
                "cards with their sources, population and patient sets, comparator designs, trial scenarios, saved "
                "results, the model and method library, and queued jobs. Aggregates and structure only -- never a "
                "patient-level row, and never a cell speaking for fewer than ten people."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "what": {"type": "string", "enum": list(READ_WHATS)},
                    "filter": {
                        "type": "object",
                        "properties": {
                            "kind": ID,
                            "registryId": ID,
                            "registry": ID,
                            "snapshotId": ID,
                            "subjectKey": ID,
                            "query": {"type": "string", "minLength": 1, "maxLength": 200},
                            "limit": {"type": "integer", "minimum": 1, "maximum": READ_MAX_LIMIT, "default": 20},
                            "offset": {"type": "integer", "minimum": 0, "maximum": 10000},
                        },
                        "additionalProperties": False,
                    },
                },
                "required": ["what"],
                "additionalProperties": False,
            },
        },
        {
            "name": "vcr_write",
            "description": (
                "Write this 虚拟临研 study's definitions and designs: the research definition, a protocol version and "
                "its structured eligibility criteria, assumption cards, population, patient-set, comparator and trial "
                "designs, a design grid, a decision record, a registered forecast, a fitted literature model, or the "
                "report text. Numbers are not writable: results, counts, measures and execution records come from the "
                "engine. Items are checked one by one; refused items come back in issues and the rest are written."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "what": {"type": "string", "enum": list(WRITE_WHATS)},
                    "items": {"type": "array", "minItems": 1, "maxItems": WRITE_MAX_ITEMS, "items": {"type": "object"}},
                    "data": {"type": "object"},
                },
                "required": ["what"],
                "additionalProperties": False,
            },
        },
        {
            "name": "vcr_simulate",
            "description": (
                "Queue a deterministic computation on the 虚拟临研 engine and read where it got to: cohort building, "
                "population or patient generation, comparator weighting, RMST, analytic or simulated trial design, "
                "assurance, accrual forecasting or criterion evaluation. start returns a jobId; status reports state "
                "and progress; cancel stops it and keeps the completed batches. Every number in the answer is the "
                "engine's -- never compute one yourself."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": list(SIMULATE_ACTIONS), "default": "start"},
                    "kind": {"type": "string", "enum": list(JOB_KINDS)},
                    "scenario": {"type": "object"},
                    "inputs": {"type": "array", "maxItems": 200, "items": {"type": "object"}},
                    "seed": {"type": "integer", "minimum": 0, "maximum": 2147483647},
                    "replicates": {"type": "integer", "minimum": 1, "maximum": 10000000},
                    "cpuSecondsLimit": {"type": "integer", "minimum": 1, "maximum": 86400},
                    "subjectId": {"type": "string", "minLength": 1, "maxLength": 120},
                    "jobId": ID,
                },
                "required": ["action"],
                "additionalProperties": False,
            },
        },
        {
            "name": "trial_registry_record",
            "description": (
                "Fetch one trial-registry record as structured fields: PICO, design, arms, planned and actual "
                "enrolment with their dates, sites, the eligibility text as written, endpoints and published results. "
                "Planned and actual enrolment are kept apart -- the gap between them is the most useful accrual prior "
                "there is."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "registryId": ID,
                    "registry": {"type": "string", "minLength": 1, "maxLength": 40},
                },
                "required": ["registryId"],
                "additionalProperties": False,
            },
        },
        {
            "name": "evidence_pool",
            "description": (
                "Pool several extracted estimates into one assumption distribution on the 虚拟临研 engine "
                "(DL / REML / HKSJ random effects or a fixed effect, with a prediction interval). start returns a "
                "jobId; status reports the pooled estimate, heterogeneity and the prediction interval. The pooling is "
                "the engine's: state the inputs, read the result, and never average the numbers yourself."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["start", "status"], "default": "start"},
                    "parameter": {"type": "string", "minLength": 1, "maxLength": 120},
                    "method": {"type": "string", "enum": list(POOLING_METHODS), "default": "random_effects_reml"},
                    "studies": {
                        "type": "array", "minItems": 1, "maxItems": 200,
                        "items": {
                            "type": "object",
                            "properties": {
                                "sourceRef": {"type": "string", "minLength": 1, "maxLength": 300},
                                "estimate": {"type": "number"},
                                "standardError": {"type": "number"},
                                "ciLow": {"type": "number"},
                                "ciHigh": {"type": "number"},
                                "sampleSize": {"type": "integer", "minimum": 1},
                                "events": {"type": "integer", "minimum": 0},
                            },
                            "required": ["sourceRef", "estimate"],
                            "additionalProperties": False,
                        },
                    },
                    "jobId": ID,
                },
                "required": ["action"],
                "additionalProperties": False,
            },
        },
    ]


def _gateway():
    base = os.environ.get("EVIMED_VCR_GATEWAY_URL", "").strip().rstrip("/")
    if not base:
        raise VcrPlatformError(
            "vcr_disabled",
            "虚拟临研 is not available in this conversation: the deployment has it switched off or has not opened it "
            "to this account. Go on without the platform's study data.",
        )
    try:
        settings = public_sources._gateway_settings()  # noqa: SLF001 - one token, one owner
    except public_sources.PublicSourceError as error:
        raise VcrPlatformError("vcr_unconfigured", "The managed gateway token is unavailable.") from error
    if settings is None:
        raise VcrPlatformError("vcr_unconfigured", "The managed gateway token is unavailable.")
    return base, settings[1]


def _post(operation: str, payload: dict, timeout: int = TIMEOUT_SECONDS) -> dict:
    base, token = _gateway()
    request = urllib.request.Request(
        "%s/%s" % (base, operation),
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "accept": "application/json",
            "authorization": "Bearer %s" % token,
            "content-type": "application/json",
            "user-agent": "EviMed-Research/1.2 (runtime vcr platform)",
        },
        method="POST",
    )
    try:
        with public_sources._OPENER.open(request, timeout=timeout) as response:  # noqa: SLF001
            body = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        code = ""
        message = ""
        try:
            parsed_error = json.loads(error.read(64 * 1024).decode("utf-8", "replace"))
            code = parsed_error.get("code", "") if isinstance(parsed_error, dict) else ""
            message = parsed_error.get("error", "") if isinstance(parsed_error, dict) else ""
        except Exception:  # noqa: BLE001 - the status is the finding, not the parse
            code = ""
        # Only the gateway's own words reach the run: a code from anything else
        # on the path is not one the run's verdict knows how to read.
        if not isinstance(code, str) or not GATEWAY_CODE.match(code):
            code = "vcr_upstream_error"
        if not isinstance(message, str) or not message.strip() or len(message) > 400:
            message = "The 虚拟临研 gateway returned HTTP %d." % error.code
        raise VcrPlatformError(
            code,
            message,
            retryable=error.code in (429, 502, 503, 504) and code != "vcr_disabled",
        ) from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise VcrPlatformError("vcr_gateway_unreachable", "The 虚拟临研 gateway is unreachable.", retryable=True) from error
    if len(body) > MAX_RESPONSE_BYTES:
        raise VcrPlatformError("vcr_response_too_large", "The 虚拟临研 answer exceeded the client limit.")
    try:
        parsed = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise VcrPlatformError("vcr_response_invalid", "The 虚拟临研 gateway returned a non-JSON answer.") from error
    data = parsed.get("data") if isinstance(parsed, dict) else None
    if not isinstance(data, dict):
        raise VcrPlatformError("vcr_response_invalid", "The 虚拟临研 gateway returned no data.")
    return data


def _module_absent(error: VcrPlatformError, what: str, verb: str) -> dict:
    """The module off, not open to this account, or a conversation outside a
    study: the tool worked, there is simply no study data here -- a warning the
    run reads and moves on from, never a failure it has to explain."""
    return {
        "status": "warning",
        "summary": "There is no 虚拟临研 study in this conversation, so there is no %s to %s." % (what, verb),
        "data": {"what": what, "code": error.code},
        "warnings": [str(error)],
        "next_actions": ["Go on without the platform's study data, or work in the study's own conversation."],
    }


def _absent_codes():
    return ("vcr_disabled", "vcr_no_study")


def read(arguments: dict) -> dict:
    what = arguments.get("what")
    if what not in READ_WHATS:
        raise VcrPlatformError("vcr_read_what_invalid", "what must be one of: %s." % ", ".join(READ_WHATS))
    payload = {"what": what}
    if isinstance(arguments.get("filter"), dict) and arguments["filter"]:
        payload["filter"] = arguments["filter"]
    try:
        data = _post("read", payload)
    except VcrPlatformError as error:
        if error.code in _absent_codes():
            return _module_absent(error, what, "read")
        raise
    warnings = []
    next_actions = []
    if data.get("more") is True:
        warnings.append("More items exist than this answer holds.")
        next_actions.append("Call again with filter.offset to read the next page, or narrow the filter.")
    if data.get("available") is False:
        # A package this deployment has not composed: named, and only the step
        # that needed it is affected.
        warnings.append(str(data.get("message") or "This part of the platform is not available on this deployment."))
        next_actions.append("Do the steps that do not need it, and say in the report what is missing and why.")
    return {
        "status": "warning" if warnings else "success",
        "summary": "Read %s of this 虚拟临研 study." % what,
        "data": data,
        "warnings": warnings,
        "next_actions": next_actions,
    }


def write(arguments: dict) -> dict:
    what = arguments.get("what")
    if what not in WRITE_WHATS:
        raise VcrPlatformError("vcr_write_what_invalid", "what must be one of: %s." % ", ".join(WRITE_WHATS))
    if "items" in arguments and "data" in arguments:
        raise VcrPlatformError("vcr_write_payload_invalid", "A write carries items or data, not both.")
    payload = {"what": what}
    for key in ("items", "data"):
        if key in arguments:
            payload[key] = arguments[key]
    try:
        data = _post("write", payload)
    except VcrPlatformError as error:
        if error.code in _absent_codes():
            return _module_absent(error, what, "write")
        raise
    issues = [issue for issue in data.get("issues") or [] if isinstance(issue, dict)]
    ids = data.get("ids") if isinstance(data.get("ids"), list) else []
    if not data.get("ok"):
        return {
            "status": "warning",
            "summary": "Nothing was written to %s: %d issue(s)." % (what, len(issues)),
            "data": data,
            "warnings": [_issue_line(issue) for issue in issues[:20]],
            "next_actions": ["Correct the named items and write them again; nothing else changed."],
        }
    return {
        "status": "warning" if issues else "success",
        "summary": "Wrote %s: %d written%s." % (what, len(ids), ", %d refused" % len(issues) if issues else ""),
        "data": data,
        "warnings": [_issue_line(issue) for issue in issues[:20]],
        "next_actions": ["Correct the refused items and write only those again."] if issues else [],
    }


def _issue_line(issue: dict) -> str:
    where = []
    if isinstance(issue.get("index"), int):
        where.append("item %d" % issue["index"])
    if issue.get("field"):
        where.append(str(issue["field"]))
    prefix = "%s: " % ", ".join(where) if where else ""
    return "%s%s" % (prefix, str(issue.get("message") or issue.get("code") or "refused"))


def simulate(arguments: dict) -> dict:
    action = arguments.get("action") or "start"
    if action not in SIMULATE_ACTIONS:
        raise VcrPlatformError("vcr_simulate_action_invalid", "action must be one of: %s." % ", ".join(SIMULATE_ACTIONS))
    payload = {"action": action}
    if action == "start":
        kind = arguments.get("kind")
        if kind not in JOB_KINDS:
            raise VcrPlatformError("vcr_simulate_payload_invalid", "kind must be one of: %s." % ", ".join(JOB_KINDS))
        payload["kind"] = kind
        for key in ("scenario", "inputs", "seed", "replicates", "cpuSecondsLimit", "subjectId"):
            if arguments.get(key) is not None:
                payload[key] = arguments[key]
    else:
        job_id = arguments.get("jobId")
        if not isinstance(job_id, str) or not job_id:
            raise VcrPlatformError("vcr_simulate_payload_invalid", "jobId is the id start answered with.")
        payload["jobId"] = job_id
    try:
        data = _post("simulate", payload)
    except VcrPlatformError as error:
        if error.code in _absent_codes():
            return _module_absent(error, "computation", "queue")
        raise
    return _job_answer(data, action)


def _job_answer(data: dict, action: str) -> dict:
    state = str(data.get("state") or "queued")
    job_id = str(data.get("jobId") or "")
    if state == "awaiting_budget":
        return {
            "status": "warning",
            "summary": "Job %s is waiting for the study's compute budget to be confirmed." % job_id,
            "data": data,
            "warnings": [str(data.get("message") or "This computation is over the study's compute budget and stopped for one confirmation.")],
            "next_actions": [
                "Tell the researcher what is waiting and what it costs; the study page has the one confirmation.",
                "Go on with the steps that do not need this computation.",
            ],
        }
    if state in ("queued", "running"):
        progress = data.get("progress") if isinstance(data.get("progress"), dict) else {}
        done = progress.get("done")
        total = progress.get("total")
        where = " (%s/%s)" % (done, total) if isinstance(done, int) and isinstance(total, int) and total else ""
        return {
            "status": "success",
            "summary": "Job %s is %s%s." % (job_id, state, where),
            "data": data,
            "warnings": [],
            "next_actions": ["Call again with action status and this jobId; do other work while it runs."],
        }
    if state == "failed":
        error = data.get("error") if isinstance(data.get("error"), dict) else {}
        partial = bool(error.get("partial"))
        return {
            "status": "warning",
            "summary": "Job %s failed%s." % (job_id, " but kept its completed batches" if partial else ""),
            "data": data,
            "warnings": [str(error.get("message") or error.get("code") or "The computation failed.")],
            "next_actions": [
                "Report what was computed and what was not; never write a zero for a number that was not computed.",
                "If the failure names a missing input, supply it and queue the job again.",
            ],
        }
    if state == "canceled":
        return {
            "status": "warning",
            "summary": "Job %s was cancelled; the completed batches are kept." % job_id,
            "data": data, "warnings": [], "next_actions": [],
        }
    return {
        "status": "success",
        "summary": "Job %s succeeded." % job_id if action != "cancel" else "Job %s is cancelled." % job_id,
        "data": data,
        "warnings": [],
        "next_actions": ["Read the result with vcr_read (what: results) and cite the fields, never retyped numbers."],
    }


def registry_record(arguments: dict) -> dict:
    registry_id = arguments.get("registryId")
    if not isinstance(registry_id, str) or not registry_id.strip():
        raise VcrPlatformError("vcr_request_invalid", "registryId is the trial's registration number.")
    payload = {"what": "trial_registry_record", "filter": {"registryId": registry_id.strip()}}
    registry = arguments.get("registry")
    if isinstance(registry, str) and registry.strip():
        payload["filter"]["registry"] = registry.strip()
    try:
        data = _post("read", payload)
    except VcrPlatformError as error:
        if error.code in _absent_codes():
            return _module_absent(error, "trial registry", "read")
        raise
    if data.get("available") is False:
        return {
            "status": "warning",
            "summary": "The trial registry is not available on this deployment.",
            "data": data,
            "warnings": [str(data.get("message") or "The registry channel is not composed here.")],
            "next_actions": ["Use the literature and clinical-trial search tools instead, and say where each field came from."],
        }
    record = data.get("record") if isinstance(data.get("record"), dict) else data
    return {
        "status": "success",
        "summary": "Read registry record %s." % registry_id,
        "data": record,
        "warnings": [],
        "next_actions": ["Keep planned and actual enrolment apart; a planned number is not evidence of accrual speed."],
    }


def evidence_pool(arguments: dict) -> dict:
    action = arguments.get("action") or "start"
    if action not in ("start", "status"):
        raise VcrPlatformError("vcr_simulate_action_invalid", "action must be start or status.")
    if action == "status":
        return simulate({"action": "status", "jobId": arguments.get("jobId")})
    studies = arguments.get("studies")
    if not isinstance(studies, list) or not studies:
        raise VcrPlatformError("vcr_simulate_payload_invalid", "studies is a non-empty list of extracted estimates.")
    parameter = arguments.get("parameter")
    if not isinstance(parameter, str) or not parameter.strip():
        raise VcrPlatformError("vcr_simulate_payload_invalid", "parameter names what is being pooled.")
    method = arguments.get("method") or "random_effects_reml"
    if method not in POOLING_METHODS:
        raise VcrPlatformError("vcr_simulate_payload_invalid", "method must be one of: %s." % ", ".join(POOLING_METHODS))
    return simulate({
        "action": "start",
        "kind": "pool_evidence",
        "subjectId": parameter.strip()[:120],
        "scenario": {"parameter": parameter.strip(), "method": method, "studies": studies},
    })
