#!/usr/bin/env python3
"""「虚拟临研」's study data, deterministic compute and trial registry, through
the server's gateway (build contract 2026-09-28 §3.2).

Six tools a 虚拟临研 capability's run uses; none is ever forced into a turn.

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
- ``curve_digitize`` reads a published Kaplan-Meier figure into curve points by
  a deterministic digitizer the platform runs on a figure the study already
  holds. The run states a calibration (what the axis labels say), which curve,
  and the risk table the paper prints; it never states a coordinate. The result
  is a curve record (``receiptId``) the reconstruction accepts exactly like a
  person's selection, with the algorithm version and the quality of the trace.
- ``evidence_pool`` asks the platform to pool this study's *verified*
  extractions of one parameter into an assumption distribution, and returns
  the job to poll. What is pooled is what the study already holds, checked
  against its source (quote and locator) -- a run names the parameter, never
  the numbers; the pooling is the engine's (DL / REML / HKSJ with a
  prediction interval), not the model's.

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
    "study", "definition", "criteria", "assumptions", "evidence", "population", "patients", "comparator", "trial",
    "precedents", "matching", "subject_document", "results", "report_model", "snapshot_profile", "models", "jobs",
    "trial_registry_record", "pack", "library", "model_assessments",
)
WRITE_WHATS = (
    "definition", "protocol", "criteria", "assumption", "evidence_item", "precedent", "population", "patient_set",
    "comparator", "trial_scenario", "design_grid", "decision", "report", "model", "forecast", "step", "plan",
    "fact", "language_judgment", "site", "followup", "field_map", "pack", "model_assessment",
)
# The engine's job kinds, in the domain's order (`VCR_JOB_KINDS` in
# `packages/domain/src/vcrVocabulary.mjs`): the 24 of the first release, then the
# comparator-effect kinds appended after them; `test/test_vcr_platform.py` reads
# the domain and holds this list equal to it.
JOB_KINDS = (
    "profile_snapshot", "build_cohort", "generate_population", "literature_population", "synthesize_population",
    "population_quality", "generate_patients", "generate_patients_continuous", "generate_patients_binary",
    "reconstruct_km", "pool_evidence", "weight_comparator", "propensity_weight_comparator", "maic_comparator",
    "evalue", "rmst", "design_analytic", "design_simulation", "design_grid", "assurance", "procova",
    "accrual_forecast", "map_prior", "match_criteria",
    "weighted_cox_comparator", "maic_time_to_event_comparator", "aipw_comparator", "covariate_set_comparator",
    # robustness methods (2026-10-04)
    "negative_control_comparator", "tipping_point", "prognostic_adjustment_comparator",
)
POOLING_METHODS = ("single_study", "random_effects_dl", "random_effects_reml", "random_effects_hksj", "fixed_effect")
POOLING_CALIBRES = ("closest", "overall", "next_closest")
SIMULATE_ACTIONS = ("start", "status", "cancel")
READ_MAX_LIMIT = 50
WRITE_MAX_ITEMS = 200
# The one operation whose answer waits on a container: the gateway's budget is the
# deployment's own intake timeout plus a margin, and this ceiling sits above it.
DIGITIZE_TIMEOUT_SECONDS = 100
DIGITIZE_FIELDS = ("imageArtifactId", "imageSha256", "calibration", "plotArea", "arms", "reportedLogHazardRatio")
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
# Reads, writes and job submissions answer within ten seconds server-side; the
# client's ceiling leaves room for one retry under the kernel's 180 s limit.
TIMEOUT_SECONDS = 30
GATEWAY_CODE = re.compile(r"^(?:vcr|registry|engine)_[a-z0-9_]{1,60}$")
ID = {"type": "string", "minLength": 1, "maxLength": 160, "pattern": r"^[A-Za-z0-9_.:@-]+$"}


# The gateway's own refusals of the conversation's credential. They end in
# `_invalid` like a malformed field does, and are not one: the run cannot fix
# them by changing what it sent.
AUTH_CODES = ("vcr_gateway_token_invalid", "vcr_gateway_token_missing", "vcr_unconfigured")


class VcrPlatformError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable

    def stop_reason(self) -> str:
        """What the run should do next: fix the call, retry, or go on without.

        A code ending ``_invalid`` names a field the run got wrong -- except the
        credential's, which is the deployment's to fix (``unsupported``).
        """
        if self.code in AUTH_CODES:
            return "unsupported"
        if self.code.endswith("_invalid"):
            return "invalid_input"
        return "retry" if self.retryable else "unsupported"


def tool_definitions():
    return [
        {
            "name": "vcr_read",
            "description": (
                "Read this 虚拟临研 study: its definition and estimand, structured eligibility criteria, assumption "
                "cards with their sources, verified evidence, population and patient sets, comparator designs, trial "
                "scenarios, saved results, the report model, the model and method library, and queued jobs. "
                "Aggregates and structure only -- never a patient-level row, and never a cell speaking for fewer than "
                "ten people (a published trial's own figures -- registry records, extracted values, precedents -- are "
                "not this study's people and come back whole). what: study also returns intendedUseCeiling, the "
                "highest use the study's results can be labelled with and why. what: pack reads the study's disease knowledge pack "
                "(an index of its sections; filter.kind reads one section whole) or, with none bound, the catalogue "
                "(filter.query searches it); what: library lists the account's reusable population definitions. "
                "what: matching answers criterion by criterion (how many subjects stand where, and the gaps) "
                "and lists the study's own subject pseudonyms; with filter.subjectKey it returns that one subject's "
                "judgments with approved projected quotes and sourced facts; factContract gives the exact clinical metadata schema, and the language criteria still "
                "waiting for the run's answer."
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
                            "sourceId": ID,
                            "subjectKey": ID,
                            "documentId": ID,
                            "protocolVersionId": ID,
                            "query": {"type": "string", "minLength": 1, "maxLength": 200},
                            "limit": {"type": "integer", "minimum": 1, "maximum": READ_MAX_LIMIT, "default": 20},
                            "offset": {"type": "integer", "minimum": 0, "maximum": 1048576},
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
                "its structured eligibility criteria, assumption cards and their evidence items, precedents, population, "
                "patient-set, comparator and trial designs, a design grid, a decision record, a fitted literature model, "
                "a model's ICH M15 assessment record, patient facts, sites and follow-up, or the report text. A disease pack: data {use: <catalogue id>} binds one, "
                "data {disease, sources, terms, endpoints, criteria…} drafts one for a disease with none (marked AI draft); a population "
                "item may carry fromLibrary {definitionId, version?} instead of a definition. Numbers are not writable: results, counts, "
                "measures and execution records come from the engine, and an object's configuration carries only the "
                "keys the engine reads (see vcr_simulate). Items are checked one by one; refused items come back in "
                "issues and the rest are written."
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
        # The shapes below are held to the domain's scenario schemas by
        # `test/test_vcr_platform.py`: every key a shape offers is one the
        # method's schema reads, and a key the schema reads for some endpoint
        # types only says which (`key[time_to_event]`). `accrual?` used to stand
        # unmarked on all three patient generators; a run that followed it for a
        # binary set was refused for a field the engine does not read.
        {
            "name": "vcr_simulate",
            "description": (
                "Queue deterministic 虚拟临研 computation. start returns jobId; status returns progress and saved "
                "results; cancel preserves completed batches. Numbers come from the engine, never the model. "
                "Invalid scenario fields and unsupported designs/endpoints are refused by name (the field's path). "
                "Shapes (key? is optional; key[e] is read only when endpoint.type is e and refused for "
                "any other): design_analytic {design{kind,informationRates?,spending?,allocation?}, "
                "endpoint{type}, truth{...}, analysis{alpha,power,sided}, accrual?[time_to_event]}; design_simulation "
                "{design{kind,nTreat,nControl?,informationRates?}, endpoint{type}, truth{null?,...}, "
                "analysis{method,alpha,sided,tau?}, accrual?[time_to_event], performance?, targetMcse?}; design_grid "
                "the same plus designs[] and truths[]; assurance {design, endpoint, designPrior{mean,sd,kind,basis}, "
                "truth[continuous|binary], analysis}; generate_population {n, population{variables[{name,family,...}],"
                "correlation?,constraints?,missing?}}; literature_population {n, "
                "baselineTable[{variable,mean,sd|proportion|proportions}]}; generate_patients {design{nTreat,nControl?}, "
                "endpoint, truth, accrual?}; generate_patients_binary and generate_patients_continuous "
                "{design{nTreat,nControl?}, endpoint, truth}; reconstruct_km {curve[{time,surv}], "
                "riskTable[{time,atRisk}], provenance{kind,tool}, totalEvents?, treatmentArm?}; rmst {tau, ...}; "
                "weight_comparator {covariates[], estimand, endpoint, tau[time_to_event], ...}; map_prior "
                "{historical{...}, ...}; procova {endpoint, truth{effect,sd}, prognostic{rho}, analysis}. Truth spells "
                "the null case truth.null (boolean); accrual (enrolment, follow-up, dropout as accrual.dropoutAnnual) "
                "exists only for a time_to_event endpoint; alpha is the total, "
                "sided is 1 or 2. Patient-level kinds (profile_snapshot, build_cohort, weight_comparator, ...) name "
                "their data as inputs [{kind:'snapshot', id}] and nothing else. pool_evidence and match_criteria are "
                "built by the platform. For matching, selection names one protocolVersionId or up to ten protocolVersionIds, "
                "subjectKeys and direction; continue a frozen batch with snapshotId and offset. The other comparator and robustness kinds and all shapes are in the "
                "vcr-analysis skill; maic_time_to_event_comparator takes reconstructionResultId, never rows."
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
                    "selection": {"type": "object", "properties": {
                        "protocolVersionId": ID,
                        "protocolVersionIds": {"type": "array", "minItems": 1, "maxItems": 10, "items": ID},
                        "subjectKeys": {"type": "array", "minItems": 1, "maxItems": 5000, "items": ID},
                        "direction": {"type": "string", "enum": ["trial_to_patient", "patient_to_trial"]},
                        "asOf": {"type": "string"}, "offset": {"type": "integer", "minimum": 0},
                        "snapshotId": {"type": "string", "pattern": "^[a-f0-9]{64}$"},
                    }, "additionalProperties": False},
                    "reconstructionResultId": ID,
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
            "name": "curve_digitize",
            "description": (
                "Read a published Kaplan-Meier figure into curve points, deterministically, so a survival curve can be "
                "reconstructed. The figure must already be a PNG or JPEG in this study's workspace (imageArtifactId, a "
                "workspace-relative path; imageSha256 pins it by hash). You state the calibration as the axis labels "
                "read: x.min and x.max are the values of the FIRST and LAST tick on the time axis (x.unit names the unit), "
                "y.min and y.max those on the survival axis, y.scale is 'fraction' (0 to 1) or 'percent' (0 to 100); "
                "if the axes have no tick marks, plotArea (pixels) gives the box whose edges carry those values. Each "
                "arm names its curve by color ('#rrggbb' as you see it, matched to the nearest curve color in the figure; "
                "a black curve is '#000000') or by legendOrder (1 = the first legend entry from the top), and states the "
                "published numbers at risk (riskTable [{time, atRisk}], at least two rows; totalEvents and reportedMedian "
                "when printed). One arm is the control, two arms are control then treatment. You never state a "
                "coordinate: points are measured from the pixels and come back recorded with the algorithm version, the "
                "calibration as you stated it, the parameters used and quality indicators (xCoverage, bridgedColumns = "
                "stretches hidden under another curve and held, monotonicityRepairs, startSurvival). The answer is a "
                "receiptId: pass it to vcr_simulate as kind reconstruct_km with scenario {provenance:{receiptId}}, or write "
                "it as a literature comparator's configuration.provenance.receiptId. Measured against figures drawn from "
                "known curves: survival within 0.02 (typically 0.002; 0.017 at JPEG quality 60) and time within 0.6% of "
                "the x range (typically 0.1%), with gridlines, censoring marks, dashes and a legend. Not reliable: curves "
                "of one colour drawn over each other, shaded bands over a curve, 3D figures, a black curve along the frame, "
                "text touching the curve. It refuses rather than guesses (plot_area_ambiguous lists candidate boxes, "
                "colour_required lists the colors found, legend_not_found, curve_rising for a cumulative-incidence plot) and "
                "records nothing then: read what it asks for and call again. An impossible calibration is refused with the reason."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "imageArtifactId": {"type": "string", "minLength": 1, "maxLength": 2048},
                    "imageSha256": {"type": "string", "pattern": r"^[a-f0-9]{64}$"},
                    "calibration": {
                        "type": "object",
                        "properties": {
                            "x": {
                                "type": "object",
                                "properties": {
                                    "min": {"type": "number", "minimum": 0},
                                    "max": {"type": "number", "exclusiveMinimum": 0},
                                    "unit": {"type": "string", "minLength": 1, "maxLength": 20},
                                },
                                "required": ["min", "max", "unit"],
                                "additionalProperties": False,
                            },
                            "y": {
                                "type": "object",
                                "properties": {
                                    "min": {"type": "number", "minimum": 0},
                                    "max": {"type": "number", "exclusiveMinimum": 0, "maximum": 110},
                                    "scale": {"type": "string", "enum": ["fraction", "percent"]},
                                },
                                "required": ["min", "max", "scale"],
                                "additionalProperties": False,
                            },
                        },
                        "required": ["x", "y"],
                        "additionalProperties": False,
                    },
                    "plotArea": {
                        "type": "object",
                        "properties": {
                            "left": {"type": "number", "minimum": 0},
                            "top": {"type": "number", "minimum": 0},
                            "right": {"type": "number", "minimum": 0},
                            "bottom": {"type": "number", "minimum": 0},
                        },
                        "required": ["left", "top", "right", "bottom"],
                        "additionalProperties": False,
                    },
                    "arms": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 2,
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string", "maxLength": 60},
                                "curve": {
                                    "type": "object",
                                    "properties": {
                                        "color": {"type": "string", "pattern": r"^#?[0-9a-fA-F]{6}$"},
                                        "legendOrder": {"type": "integer", "minimum": 1, "maximum": 8},
                                    },
                                    "additionalProperties": False,
                                },
                                "riskTable": {
                                    "type": "array",
                                    "minItems": 2,
                                    "maxItems": 200,
                                    "items": {
                                        "type": "object",
                                        "properties": {"time": {"type": "number", "minimum": 0}, "atRisk": {"type": "number", "minimum": 0}},
                                        "required": ["time", "atRisk"],
                                        "additionalProperties": False,
                                    },
                                },
                                "totalEvents": {"type": "number", "minimum": 0},
                                "reportedMedian": {"type": "number", "exclusiveMinimum": 0},
                            },
                            "required": ["riskTable"],
                            "additionalProperties": False,
                        },
                    },
                    "reportedLogHazardRatio": {"type": "number"},
                },
                "required": ["imageArtifactId", "calibration", "arms"],
                "additionalProperties": False,
            },
        },
        {
            "name": "evidence_pool",
            "description": (
                "Pool this study's verified extractions of one parameter into an assumption distribution on the "
                "虚拟临研 engine (DL / REML / HKSJ random effects or a fixed effect, with a prediction interval). Name "
                "the parameter and the endpoint definition it is measured under -- the values pooled are the ones the "
                "study already holds, checked against their source, never numbers you bring. start returns a jobId "
                "(or says why nothing was started: no verified evidence, no such parameter) and lists every study it "
                "left out with the reason (refused); status reports the pooled "
                "estimate, heterogeneity and the prediction interval. Never average the numbers yourself."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["start", "status"], "default": "start"},
                    "parameter": {"type": "string", "minLength": 1, "maxLength": 120},
                    "endpointKey": {"type": "string", "minLength": 1, "maxLength": 80, "pattern": r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$"},
                    "calibres": {"type": "array", "minItems": 1, "maxItems": 3, "items": {"type": "string", "enum": list(POOLING_CALIBRES)}},
                    "method": {"type": "string", "enum": list(POOLING_METHODS), "default": "random_effects_reml"},
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
            # A module that is off, or a deployment with no digitizer, is not an outage that passes.
            retryable=error.code in (429, 502, 503, 504) and code not in ("vcr_disabled", "vcr_curve_digitizer_unavailable"),
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
        for key in ("scenario", "inputs", "seed", "replicates", "cpuSecondsLimit", "subjectId", "reconstructionResultId", "selection"):
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
    if state == "not_started":
        reason = str(data.get("reason") or "")
        return {
            "status": "warning",
            "summary": "Nothing was started%s." % (": %s" % reason if reason else ""),
            "data": data,
            "warnings": [str(data.get("message") or "The platform did not queue this computation.")],
            "next_actions": [
                "Read what the study holds (vcr_read), supply what is missing, and start again; say in the report what could not be pooled.",
            ],
        }
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
    # Every way a registry answer can be "not a record": the channel is not
    # composed (`available: false`), or it answered with one of its own statuses
    # (`registry_not_found`, `registry_unavailable`, ...). None of them is a
    # success, and none of them is evidence that the trial does not exist.
    status = str(data.get("status") or data.get("code") or "")
    if data.get("available") is False or status.startswith("registry_"):
        not_found = status == "registry_not_found"
        return {
            "status": "warning",
            "summary": ("The registry has no record %s." % registry_id) if not_found else "The trial registry could not be read.",
            "data": data,
            "warnings": [str(data.get("message") or ("No registry record was found under this id." if not_found
                                                     else "The registry channel is not available here (%s)." % (status or "unavailable")))],
            "next_actions": (
                ["Check the registration number; do not treat a missing record as a trial that did not happen."] if not_found
                else ["Use the literature and clinical-trial search tools instead, and say where each field came from."]
            ),
        }
    record = data.get("record") if isinstance(data.get("record"), dict) else None
    if record is None:
        return {
            "status": "warning",
            "summary": "The registry answer for %s carried no record." % registry_id,
            "data": data,
            "warnings": ["The gateway answered without a record; nothing was read."],
            "next_actions": ["Try again once, then use the literature and clinical-trial search tools."],
        }
    return {
        "status": "success",
        "summary": "Read registry record %s." % registry_id,
        "data": record,
        "warnings": [],
        "next_actions": ["Keep planned and actual enrolment apart; a planned number is not evidence of accrual speed."],
    }


def digitize(arguments: dict) -> dict:
    unknown = [key for key in arguments if key not in DIGITIZE_FIELDS]
    if unknown:
        raise VcrPlatformError("vcr_request_invalid", "%s is not a field of curve_digitize (a coordinate is never stated: it is measured)." % ", ".join(sorted(unknown)))
    for key in ("imageArtifactId", "calibration", "arms"):
        if arguments.get(key) in (None, "", [], {}):
            raise VcrPlatformError("vcr_request_invalid", "%s is required." % key)
    payload = {key: arguments[key] for key in DIGITIZE_FIELDS if arguments.get(key) is not None}
    try:
        data = _post("digitize", payload, timeout=DIGITIZE_TIMEOUT_SECONDS)
    except VcrPlatformError as error:
        if error.code in _absent_codes():
            return _module_absent(error, "figure", "digitize")
        raise
    if data.get("state") == "refused":
        reason = str(data.get("reason") or "refused")
        lines = [str(data.get("message") or "The figure could not be traced.")]
        actions = ["Nothing was recorded. Read what the refusal asks for, state it, and call curve_digitize again."]
        if isinstance(data.get("candidates"), list) and data["candidates"]:
            actions.append("Pass plotArea as the one candidate box that holds the curve (pixels: left, top, right, bottom), with the values at its edges.")
        if isinstance(data.get("palette"), list) and data["palette"]:
            actions.append("Name the curve by one of these colors: %s." % ", ".join(str(item) for item in data["palette"][:8]))
        return {
            "status": "warning",
            "summary": "Nothing was digitized: %s." % reason,
            "data": data,
            "warnings": lines,
            "next_actions": actions,
        }
    digitization = data.get("digitization") if isinstance(data.get("digitization"), dict) else {}
    curves = digitization.get("curves") if isinstance(digitization.get("curves"), list) else []
    warnings = [str(item) for item in (digitization.get("warnings") or [])][:12]
    return {
        "status": "warning" if warnings else "success",
        "summary": "Digitized %d curve(s) from the figure; curve record %s." % (len(curves), data.get("receiptId")),
        "data": data,
        "warnings": warnings,
        "next_actions": [
            "Pass receiptId to vcr_simulate (kind reconstruct_km, scenario {provenance:{receiptId}}), or write it as the literature comparator's configuration.provenance.receiptId.",
            "In the report, give the calibration as your reading of the axis labels and the quality indicators; a warning names what to check, and the reconstruction's own quality control decides whether the curve may be used.",
        ],
    }


def evidence_pool(arguments: dict) -> dict:
    action = arguments.get("action") or "start"
    if action not in ("start", "status"):
        raise VcrPlatformError("vcr_simulate_action_invalid", "action must be start or status.")
    if action == "status":
        return simulate({"action": "status", "jobId": arguments.get("jobId")})
    parameter = arguments.get("parameter")
    if not isinstance(parameter, str) or not parameter.strip():
        raise VcrPlatformError("vcr_simulate_payload_invalid", "parameter names what is being pooled.")
    endpoint_key = arguments.get("endpointKey")
    if not isinstance(endpoint_key, str) or not re.match(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$", endpoint_key):
        raise VcrPlatformError(
            "vcr_simulate_payload_invalid",
            "endpointKey is the short id of the endpoint definition the parameter is measured under (it cannot be empty).",
        )
    scenario = {"parameter": parameter.strip(), "endpointKey": endpoint_key}
    calibres = arguments.get("calibres")
    if calibres is not None:
        if not isinstance(calibres, list) or not calibres or any(item not in POOLING_CALIBRES for item in calibres):
            raise VcrPlatformError("vcr_simulate_payload_invalid", "calibres is a list drawn from: %s." % ", ".join(POOLING_CALIBRES))
        scenario["calibres"] = calibres
    method = arguments.get("method")
    if method is not None:
        if method not in POOLING_METHODS:
            raise VcrPlatformError("vcr_simulate_payload_invalid", "method must be one of: %s." % ", ".join(POOLING_METHODS))
        scenario["method"] = method
    return simulate({
        "action": "start",
        "kind": "pool_evidence",
        "subjectId": parameter.strip()[:120],
        "scenario": scenario,
    })
