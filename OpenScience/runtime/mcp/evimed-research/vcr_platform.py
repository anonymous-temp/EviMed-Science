#!/usr/bin/env python3
"""「虚拟临床研究」's study data, deterministic compute and trial registry, through
the server's gateway (build contract 2026-09-28 §3.2).

Six tools a 虚拟临床研究 capability's run uses; none is ever forced into a turn.

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
  the scenario and reads the result. A queued job is asked after a few times
  inside the call itself (``EVIMED_VCR_STATUS_WAIT_SECONDS``, 20 s by default),
  so a computation of seconds comes back finished from one ``start``; one that
  outlasts the wait is the engine's to finish -- its result is filed under its
  study object and the researcher is told when it is done, so the run is told
  to end its turn, not to loop on ``status``. ``shape`` is the one action that asks the
  platform nothing: it renders, from ``vcr_scenario_help.json`` (generated from
  the domain's scenario schemas), every key a job kind's scenario reads, and a
  refused start carries the keys of the place it was refused from the same file.
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
  the job. What is pooled is what the study already holds, checked
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
import math
import os
import re
import time
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
    # longitudinal virtual patients (2026-10-07)
    "generate_patients_longitudinal",
)
POOLING_METHODS = ("single_study", "random_effects_dl", "random_effects_reml", "random_effects_hksj", "fixed_effect")
POOLING_CALIBRES = ("closest", "overall", "next_closest")
SIMULATE_ACTIONS = ("start", "status", "cancel", "shape")
# The objects `vcr_write` takes whose configuration, scenario or definition carries the keys of a job kind's scenario (the
# platform projects the object onto that kind's schema and refuses what it does not read): where to look a shape up before
# writing one. `test_vcr_platform.py` holds every name to the domain's job kinds.
OBJECT_SHAPES = {
    "trial_scenario (configuration)": ("design_analytic", "design_simulation"),
    "design_grid": ("design_grid",),
    "patient_set (scenario)": ("generate_patients", "generate_patients_continuous", "generate_patients_binary", "generate_patients_longitudinal"),
    "population (definition)": ("generate_population", "literature_population", "synthesize_population"),
    "comparator (configuration)": ("weight_comparator", "propensity_weight_comparator", "weighted_cox_comparator", "aipw_comparator",
                                   "covariate_set_comparator", "maic_comparator", "maic_time_to_event_comparator", "map_prior", "procova",
                                   "prognostic_adjustment_comparator", "negative_control_comparator", "tipping_point"),
}
# What the platform generates from the domain's scenario schemas (`pnpm generate:vcr-scenario-help`): every key each method's
# scenario reads. It rides in the image beside this file and is never edited by hand.
HELP_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vcr_scenario_help.json")
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
# How long one `start` or `status` call may itself wait for a job to leave the queue and finish, so a computation of
# seconds needs no second call and a longer one is left to finish by itself. The bound is the deployment's
# (`OPEN_SCIENCE_VCR_STATUS_WAIT_SECONDS` in the control plane, forwarded as the variable below); 0 turns the wait off. It
# sits well under the kernel's 180 s tool limit together with the request ceiling above.
STATUS_WAIT_ENV = "EVIMED_VCR_STATUS_WAIT_SECONDS"
STATUS_WAIT_DEFAULT_SECONDS = 20.0
STATUS_WAIT_MAX_SECONDS = 60.0
STATUS_ASK_INTERVAL_SECONDS = 4.0
# The wait's clock and sleep; a test replaces them so that it does not sleep.
_clock = time.monotonic
_sleep = time.sleep
GATEWAY_CODE = re.compile(r"^(?:vcr|registry|engine)_[a-z0-9_]{1,60}$")
ID = {"type": "string", "minLength": 1, "maxLength": 160, "pattern": r"^[A-Za-z0-9_.:@-]+$"}


# The gateway's own refusals of the conversation's credential. They end in
# `_invalid` like a malformed field does, and are not one: the run cannot fix
# them by changing what it sent.
AUTH_CODES = ("vcr_gateway_token_invalid", "vcr_gateway_token_missing", "vcr_unconfigured")


class VcrPlatformError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False, issues: list | None = None):
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        # The gateway's per-field findings of a refused job ({code, field}), when it sent them.
        self.issues = issues or []

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
                "Read this 虚拟临床研究 study: its definition and estimand, structured eligibility criteria, assumption "
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
                "judgments with their evidence quotes and the facts written for them, and the language criteria still "
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
                "Write this 虚拟临床研究 study's definitions and designs: the research definition, a protocol version and "
                "its structured eligibility criteria, assumption cards and their evidence items, precedents, population, "
                "patient-set, comparator and trial designs, a design grid, a decision record, a fitted literature model, "
                "a model's ICH M15 assessment record, patient facts, sites and follow-up, or the report text. A disease pack: data {use: <catalogue id>} binds one, "
                "data {disease, sources, terms, endpoints, criteria…} drafts one for a disease with none (marked AI draft); a population "
                "item may carry fromLibrary {definitionId, version?} instead of a definition, or, for a real cohort, fromProtocol: true with a "
                "snapshotId (the protocol's own criteria become its rules); a definition may carry title (the study's name, 24 characters) "
                "and question. Numbers are not writable: results, counts, "
                "measures and execution records come from the engine, and an object's configuration, scenario or definition "
                "carries only the keys the engine reads for the job that computes it: before you write a trial scenario, "
                "patient set, population or comparator, call vcr_simulate with action shape and that job's kind "
                "(design_analytic and design_simulation for a trial scenario; generate_patients, "
                "generate_patients_continuous, generate_patients_binary or generate_patients_longitudinal (a trajectory over a "
                "visit schedule) for a patient set; generate_population for a "
                "population; the comparator kind for a comparator) and write those keys and no others. Items are checked "
                "one by one; refused items come back in issues and the rest are written."
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
        # The per-method shapes are not typed here: `action: "shape"` renders them from `vcr_scenario_help.json`, which is
        # generated from the domain's scenario schemas (`pnpm generate:vcr-scenario-help`), and a refusal of a started job
        # carries the keys of the place it was refused. The description stays short on purpose: it rides every request of the run.
        {
            "name": "vcr_simulate",
            "description": (
                "Queue a deterministic computation on the 虚拟临床研究 engine and read where it got to. start returns a "
                "jobId; status reports state, progress and the saved result; cancel stops it and keeps the completed "
                "batches. Every number in the answer is the engine's -- never compute one yourself. The scenario is the "
                "frozen setting of one method (kind). The engine reads only the keys its method names: a key it does not "
                "read, a required one that is missing, or a design or endpoint the method does not implement is refused "
                "by the field's path -- never guess a key. Before you write a scenario here, or the configuration of a "
                "trial scenario, patient set, population or comparator in vcr_write, call action shape with the kind: it "
                "answers every key that method reads (type, unit, range, default, required or optional, the endpoint or "
                "design it is read for) and a valid example; shape with no kind lists the kinds. Patient-level kinds "
                "name their data as inputs [{kind:'snapshot', id}] and nothing else. pool_evidence is evidence_pool and "
                "match_criteria is built by the platform from the protocol; maic_time_to_event_comparator takes "
                "reconstructionResultId, never rows. A computation of one of the study's objects (a trial scenario, population, patient "
                "set, comparator or design grid) names it: subjectId is the id vcr_write returned, and its result is filed under that "
                "object alone; with none, the one object the scenario fits is taken, and several are refused with the list. "
                "How to read the results is in the vcr-analysis skill."
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
                "虚拟临床研究 engine (DL / REML / HKSJ random effects or a fixed effect, with a prediction interval). Name "
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
            "虚拟临床研究 is not available in this conversation: the deployment has it switched off or has not opened it "
            "to this account. Go on without the platform's study data.",
        )
    try:
        settings = public_sources._gateway_settings()  # noqa: SLF001 - one token, one owner
    except public_sources.PublicSourceError as error:
        raise VcrPlatformError("vcr_unconfigured", "The managed gateway token is unavailable.") from error
    if settings is None:
        raise VcrPlatformError("vcr_unconfigured", "The managed gateway token is unavailable.")
    return base, settings[1]


def _field_issues(raw) -> list:
    """The per-field findings of a refused job, as the gateway sends them: a code and a path, nothing else the run reads."""
    out = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        code, field = item.get("code"), item.get("field")
        if isinstance(code, str) and re.match(r"^[a-z0-9_]{1,60}$", code) and isinstance(field, str) and 0 < len(field) <= 200:
            out.append({"code": code, "field": field})
    return out[:20]


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
        issues = []
        try:
            parsed_error = json.loads(error.read(64 * 1024).decode("utf-8", "replace"))
            code = parsed_error.get("code", "") if isinstance(parsed_error, dict) else ""
            message = parsed_error.get("error", "") if isinstance(parsed_error, dict) else ""
            issues = _field_issues(parsed_error.get("issues") if isinstance(parsed_error, dict) else None)
        except Exception:  # noqa: BLE001 - the status is the finding, not the parse
            code = ""
        # Only the gateway's own words reach the run: a code from anything else
        # on the path is not one the run's verdict knows how to read.
        if not isinstance(code, str) or not GATEWAY_CODE.match(code):
            code = "vcr_upstream_error"
        if not isinstance(message, str) or not message.strip() or len(message) > 400:
            message = "The 虚拟临床研究 gateway returned HTTP %d." % error.code
        raise VcrPlatformError(
            code,
            message,
            # A module that is off, or a deployment with no digitizer, is not an outage that passes.
            retryable=error.code in (429, 502, 503, 504) and code not in ("vcr_disabled", "vcr_curve_digitizer_unavailable"),
            issues=issues,
        ) from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise VcrPlatformError("vcr_gateway_unreachable", "The 虚拟临床研究 gateway is unreachable.", retryable=True) from error
    if len(body) > MAX_RESPONSE_BYTES:
        raise VcrPlatformError("vcr_response_too_large", "The 虚拟临床研究 answer exceeded the client limit.")
    try:
        parsed = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise VcrPlatformError("vcr_response_invalid", "The 虚拟临床研究 gateway returned a non-JSON answer.") from error
    data = parsed.get("data") if isinstance(parsed, dict) else None
    if not isinstance(data, dict):
        raise VcrPlatformError("vcr_response_invalid", "The 虚拟临床研究 gateway returned no data.")
    return data


def _module_absent(error: VcrPlatformError, what: str, verb: str) -> dict:
    """The module off, not open to this account, or a conversation outside a
    study: the tool worked, there is simply no study data here -- a warning the
    run reads and moves on from, never a failure it has to explain."""
    return {
        "status": "warning",
        "summary": "There is no 虚拟临床研究 study in this conversation, so there is no %s to %s." % (what, verb),
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
        "summary": "Read %s of this 虚拟临床研究 study." % what,
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


# --- the shape of a scenario, rendered from the generated help file ---------------------------------------------------------

_HELP = {}


def scenario_help() -> dict:
    """The generated help: every job kind's method and every key each method's scenario reads, read once."""
    if "help" not in _HELP:
        try:
            with open(HELP_FILE, "r", encoding="utf-8") as handle:
                parsed = json.load(handle)
        except (OSError, ValueError) as error:
            raise VcrPlatformError("vcr_scenario_help_unavailable", "The scenario help this build ships could not be read.") from error
        if not isinstance(parsed, dict) or not isinstance(parsed.get("kinds"), dict) or not isinstance(parsed.get("methods"), dict):
            raise VcrPlatformError("vcr_scenario_help_unavailable", "The scenario help this build ships is not in the shape this tool reads.")
        _HELP["help"] = parsed
    return _HELP["help"]


def _normal(path: str) -> str:
    """A path with a list index read as the list's item: ``designs[0].kind`` is ``designs[].kind``."""
    return re.sub(r"\[\d+\]", "[]", path)


def _parent_of(path: str) -> str:
    normal = _normal(path)
    cut = normal.rfind(".")
    return "" if cut < 0 else normal[:cut]


def _find_row(by_path: dict, path: str):
    normal = _normal(path)
    if normal in by_path:
        return by_path[normal]
    return by_path.get(normal[:-2]) if normal.endswith("[]") else None


def _number(value) -> str:
    return json.dumps(value, ensure_ascii=False)


def _condition(condition: dict) -> str:
    path = str(condition.get("path", ""))
    if isinstance(condition.get("in"), list):
        return "%s is %s" % (path, "|".join(str(item) for item in condition["in"]))
    if isinstance(condition.get("notIn"), list):
        return "%s is not %s" % (path, "|".join(str(item) for item in condition["notIn"]))
    if condition.get("present") is True:
        return "%s is given" % path
    if condition.get("present") is False:
        return "%s is not given" % path
    return path


def _own_gates(row: dict, parent) -> list:
    """The conditions this row adds to the ones its object already carries (every row repeats its ancestors')."""
    inherited = parent.get("when", []) if isinstance(parent, dict) else []
    gates = [_condition(item) for item in row.get("when", []) if item not in inherited]
    variant = row.get("variant")
    if isinstance(variant, dict) and not (isinstance(parent, dict) and parent.get("variant") == variant):
        gates.append("%s is %s" % (variant.get("on"), "|".join(str(item) for item in variant.get("is", []))))
    return gates


def _bounds(row: dict) -> str:
    parts = []
    for key, mark in (("min", ">="), ("gt", ">"), ("max", "<="), ("lt", "<")):
        if key in row:
            parts.append("%s%s" % (mark, _number(row[key])))
    return " ".join(parts)


def _type_text(row: dict) -> str:
    kind = row.get("type")
    if kind in ("number", "integer"):
        text = " ".join(part for part in (kind, _bounds(row)) if part)
        return "%s (%s)" % (text, row["unit"]) if row.get("unit") else text
    if kind == "boolean":
        return "true|false"
    if kind == "string":
        if isinstance(row.get("values"), list):
            return "one of %s" % "|".join(str(item) for item in row["values"])
        if isinstance(row.get("valuesBy"), dict):
            by = row["valuesBy"]
            return "one of, by %s: %s" % (by.get("path"), "; ".join("%s %s" % (key, "|".join(value)) for key, value in by.get("map", {}).items()))
        text = {"column": "column name", "input id": "id of one of the job's inputs"}.get(row.get("role"), "string")
        return "%s (at most %s characters)" % (text, row["maxLength"]) if "maxLength" in row else text
    if kind == "list":
        items = row.get("items") or {}
        text = "list of %s" % ("objects" if items.get("type") == "object" else _type_text(items))
        count = row.get("count") or {}
        if count:
            text += " (%s..%s items)" % (count.get("min", 0), count.get("max", "any"))
        for key, words in (("increasing", "strictly increasing"), ("unique", "distinct")):
            if row.get(key):
                text += ", %s" % words
        if "last" in row:
            text += ", last = %s" % _number(row["last"])
        return text
    if kind == "object":
        return "object"
    if kind == "map":
        text = "object of %s keyed by column name" % _type_text(row.get("of") or {})
        return "%s, the keys exactly the columns named in %s" % (text, row["keysFrom"]) if row.get("keysFrom") else text
    if kind == "matrix":
        text = "square matrix of numbers from %s to %s" % (_number(row.get("min")), _number(row.get("max")))
        return "%s, as many rows as %s lists" % (text, row["size"]) if row.get("size") else text
    if kind == "rules":
        return "list of {name, rule} in the row-rule grammar"
    if kind == "rule":
        return "one row rule in the row-rule grammar"
    return str(kind)


def _row_line(row: dict, by_path: dict) -> str:
    parent = _find_row(by_path, _parent_of(row["path"])) if _parent_of(row["path"]) else None
    if row.get("required") is True:
        need = "required once %s is given" % row["within"] if row.get("within") else "required"
    elif row.get("requiredWhen"):
        need = "required when %s" % " and ".join(_condition(item) for item in row["requiredWhen"])
    else:
        need = "optional"
    text = "%s: %s; %s" % (row["path"], _type_text(row), need)
    if "default" in row:
        text += "; default %s" % _number(row["default"])
    gates = _own_gates(row, parent)
    if gates:
        text += "; read only when %s" % " and ".join(gates)
    return text


def _rule_line(rule: dict) -> str:
    kind = rule.get("kind")
    if kind == "exactlyOne":
        text = "exactly one of %s" % ", ".join(rule.get("keys", []))
    elif kind == "atLeastOne":
        text = "at least one of %s" % ", ".join(rule.get("keys", []))
    else:
        text = "when %s is given, %s must be given too" % (rule.get("key"), ", ".join(rule.get("needs", [])))
    gates = [_condition(item) for item in rule.get("when", [])]
    variant = rule.get("variant")
    if isinstance(variant, dict):
        gates.append("%s is %s" % (variant.get("on"), "|".join(str(item) for item in variant.get("is", []))))
    return "%s (when %s)" % (text, " and ".join(gates)) if gates else text


def _children(rows: list, by_path: dict, node: str) -> list:
    """The keys the engine reads directly inside a node, each with the endpoint, design or variant that gates it."""
    parent = _find_row(by_path, node) if node else None
    out = []
    for row in rows:
        if _parent_of(row["path"]) != node:
            continue
        key = row["path"][len(node) + 1:] if node else row["path"]
        inherited = parent.get("when", []) if isinstance(parent, dict) else []
        # `key[time_to_event]`: read only for that endpoint; `key[piecewise]`: only for that variant; anything else is said in full.
        tags = []
        for condition in row.get("when", []):
            if condition not in inherited:
                tags.append("|".join(condition["in"]) if condition.get("path") == "endpoint.type" and isinstance(condition.get("in"), list) else _condition(condition))
        variant = row.get("variant")
        if isinstance(variant, dict) and not (isinstance(parent, dict) and parent.get("variant") == variant):
            tags.append("|".join(str(item) for item in variant.get("is", [])))
        out.append("%s[%s]" % (key, " and ".join(tags)) if tags else key)
    return out


def _method_of(kind: str):
    help_ = scenario_help()
    entry = help_["kinds"].get(kind)
    if not isinstance(entry, dict):
        return None, None, None
    method_id = entry.get("method")
    method = help_["methods"].get(method_id)
    return (entry, method_id, method) if isinstance(method, dict) else (None, None, None)


def shape(arguments: dict) -> dict:
    """``vcr_simulate`` action shape: what a job kind's scenario reads, rendered from the generated help. Asks the
    platform nothing, so it answers with the module off too."""
    kind = arguments.get("kind")
    help_ = scenario_help()
    if kind is None:
        return {
            "status": "success",
            "summary": "%d job kinds; ask for one with action shape and its kind." % len(help_["kinds"]),
            "data": {
                "kinds": {name: "%s%s" % (entry["method"], " (%s)" % "|".join(help_["methods"][entry["method"]].get("endpoints", []))
                                         if help_["methods"].get(entry["method"], {}).get("endpoints") else "")
                          for name, entry in help_["kinds"].items()},
                "objects": {name: list(kinds) for name, kinds in OBJECT_SHAPES.items()},
            },
            "warnings": [],
            "next_actions": ["Call vcr_simulate with action shape and the kind you are about to write or queue."],
        }
    if kind not in JOB_KINDS:
        raise VcrPlatformError("vcr_simulate_payload_invalid", "kind must be one of: %s." % ", ".join(JOB_KINDS))
    entry, method_id, method = _method_of(kind)
    if method is None:
        raise VcrPlatformError("vcr_scenario_help_unavailable", "This build's scenario help has no entry for %s." % kind)
    rows = method.get("rows", [])
    by_path = {row["path"]: row for row in rows}
    platform = entry.get("platformBuilt")
    notes = list(method.get("notes", []))
    data = {"kind": kind, "method": method_id}
    if method.get("endpoints"):
        data["endpoints"] = list(method["endpoints"])
    if platform is not None:
        # The platform freezes this scenario itself; the run states only the keys named here.
        keys = [_row_line(by_path[name], by_path) for name in platform if name in by_path]
        data["builtByPlatform"] = True
        data["runStates"] = list(platform)
        data["keys"] = keys
        if kind == "pool_evidence":
            notes.append("Use the evidence_pool tool: you name the parameter and the endpoint definition, never the numbers; the pooled values are this study's verified extractions.")
        elif kind == "match_criteria":
            notes.append("Start it with an empty scenario: the platform freezes the newest protocol version's criteria and the facts written for the study.")
        else:
            notes.append("State only %s; the sites' rates come from the study's ledger and site records." % ", ".join(platform))
        data["notes"] = notes
        summary = "%s is built by the platform from the study; you state %s." % (kind, ", ".join(platform) if platform else "nothing")
    else:
        data["keys"] = [_row_line(row, by_path) for row in rows]
        if method.get("rules"):
            data["rules"] = [_rule_line(rule) for rule in method["rules"]]
        if method.get("gridCells"):
            notes.append("A grid has at most %s cells (designs x truths), and every cell is a valid scenario of its own." % method["gridCells"])
        if notes:
            data["notes"] = notes
        data["examples"] = list(method.get("examples", []))
        summary = "The scenario of %s (method %s) reads %d keys." % (kind, method_id, len(rows))
    data["legend"] = ("path: type; required or optional (required whenever the key is read); default; read only when <condition> (the key is refused "
                      "when the condition does not hold). A path with [] is inside each item of a list. A key not listed is refused by its path.")
    return {
        "status": "success",
        "summary": summary,
        "data": data,
        "warnings": [],
        "next_actions": [
            "Write exactly these keys and no others; a number the engine computes (a result, a count, a measure) is never a key.",
            "Then queue it with vcr_simulate action start, or write it as the object's configuration with vcr_write.",
        ],
    }


def refusal_hint(kind, issues: list) -> str:
    """The keys of the place a job was refused, from the same generated help, so the repair needs no second lookup."""
    if not isinstance(kind, str) or not issues:
        return ""
    try:
        entry, method_id, method = _method_of(kind)
    except VcrPlatformError:
        return ""
    if method is None or entry.get("platformBuilt") is not None:
        return ""
    rows = method.get("rows", [])
    by_path = {row["path"]: row for row in rows}
    lines = []
    for issue in issues[:6]:
        field = issue["field"]
        path = field[len("scenario."):] if field.startswith("scenario.") else ("" if field == "scenario" else field)
        row = _find_row(by_path, path) if path else None
        if issue["code"] in ("scenario_value_invalid", "scenario_field_missing") and row is not None:
            line = _row_line(row, by_path)
        elif issue["code"] in ("design_not_supported", "endpoint_not_supported"):
            line = "; ".join(method.get("notes", [])[:1]) or "endpoints this method implements: %s" % "|".join(method.get("endpoints", []))
        else:
            node = _parent_of(path) if path else ""
            line = "inside %s the engine reads: %s" % (node or "the scenario", ", ".join(_children(rows, by_path, node)))
        if line not in lines:
            lines.append(line)
    if not lines:
        return ""
    return "From the engine's schema for %s (method %s) -- %s. Every key, its range and an example: vcr_simulate action shape, kind %s." % (
        kind, method_id, " | ".join(lines), kind)


def simulate(arguments: dict) -> dict:
    action = arguments.get("action") or "start"
    if action not in SIMULATE_ACTIONS:
        raise VcrPlatformError("vcr_simulate_action_invalid", "action must be one of: %s." % ", ".join(SIMULATE_ACTIONS))
    if action == "shape":
        return shape(arguments)
    payload = {"action": action}
    if action == "start":
        kind = arguments.get("kind")
        if kind not in JOB_KINDS:
            raise VcrPlatformError("vcr_simulate_payload_invalid", "kind must be one of: %s." % ", ".join(JOB_KINDS))
        payload["kind"] = kind
        for key in ("scenario", "inputs", "seed", "replicates", "cpuSecondsLimit", "subjectId", "reconstructionResultId"):
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
        # A refused scenario names the keys of the place it was refused, read from the same help the shape action renders.
        hint = refusal_hint(payload.get("kind"), error.issues) if action == "start" else ""
        if hint:
            raise VcrPlatformError(error.code, "%s %s" % (error, hint), error.retryable, error.issues) from error
        raise
    if action in ("start", "status"):
        data = _wait_for_job(data)
    return _job_answer(data, action)


def _status_wait_seconds() -> float:
    """The deployment's bound on one call's own wait: a number of seconds from 0 (no wait) to a minute, 20 when unset or unreadable."""
    try:
        value = float(os.environ.get(STATUS_WAIT_ENV, str(STATUS_WAIT_DEFAULT_SECONDS)))
    except ValueError:
        return STATUS_WAIT_DEFAULT_SECONDS
    if not math.isfinite(value):
        return STATUS_WAIT_DEFAULT_SECONDS
    return min(max(value, 0.0), STATUS_WAIT_MAX_SECONDS)


def _is_computing(data: dict) -> bool:
    return str(data.get("state") or "queued") in ("queued", "running")


def _wait_for_job(first: dict) -> dict:
    """Ask the platform again, every few seconds, for a job that was just queued or is still running, until it leaves
    that state or the bound runs out; return what the last answer said. A job that finishes within the bound comes back
    finished from the one call. Whatever goes wrong while waiting only ends the waiting: the answer already in hand was
    a success and stays one."""
    job_id = first.get("jobId")
    bound = _status_wait_seconds()
    if bound <= 0 or not isinstance(job_id, str) or not job_id or not _is_computing(first):
        return first
    started = _clock()
    answer = first
    while True:
        remaining = bound - (_clock() - started)
        if remaining <= 0:
            return answer
        _sleep(min(STATUS_ASK_INTERVAL_SECONDS, remaining))
        try:
            fresh = _post("simulate", {"action": "status", "jobId": job_id})
        except Exception:  # noqa: BLE001 - the start succeeded; a failed look at it must not turn that into an error
            return answer
        # The start's own fields (the studies a pool left out, the other calibres' jobs) stay; the state is the latest.
        answer = {**first, **{key: value for key, value in fresh.items() if key != "action"}}
        if not _is_computing(answer):
            return answer


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
                "Only the researcher's confirmation releases this job: do not wait for it and do not poll its status again.",
                "Tell the researcher what is waiting and what it costs; the study page has the one confirmation.",
                "Go on with the results you have and the steps that do not need this computation, and say in the report which computation did not run.",
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
            "next_actions": [
                "The engine computes this without you: the result is saved under its study object and shown on the study page, "
                "and the researcher gets a notice when it finishes.",
                "Do not wait for it in this turn -- no status loop, no sleep or wait command. Tell the researcher what is "
                "computing, where the result will appear and how far it got, answer with what you already have, and end the turn "
                "(or go on with work that does not need this result).",
                "In a later turn, when asked, read the result with vcr_read (what: results).",
            ],
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
