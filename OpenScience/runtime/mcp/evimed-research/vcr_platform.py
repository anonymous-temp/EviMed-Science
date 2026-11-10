#!/usr/bin/env python3
"""「虚拟临床研究」's study data, deterministic compute and trial registry, through
the server's gateway (build contract 2026-09-28 §3.2).

Six tools a 虚拟临床研究 capability's run uses; none is ever forced into a turn.

- ``vcr_read`` reads the study in the shapes its pages show: the definition,
  the eligibility criteria, the assumption cards, the population, patient sets,
  comparator designs, trial scenarios, results, models and jobs. **Aggregates
  and structure only** -- no row of any person ever comes back. In the study
  owner's own conversation the head counts are exact; for anyone else a cell
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
  ``validate`` takes what ``start`` takes and queues nothing and waits for nothing: it answers the scenario as it would be frozen, the
  defaults the platform would fill in, the replicate count and what set it, the cost class, or the refusal by path -- so a run may
  validate and start in the same turn.
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
from contextlib import contextmanager
from contextvars import ContextVar

import hashlib
import math
import os
import re
import time
from pathlib import Path
import urllib.error
import urllib.request

import public_sources
from immutable_capture import managed_workspace, ImmutableCaptureError

# The closed vocabularies, as `apps/server/src/vcrService.mjs` defines them.
# `apps/server/test/vcrGateway.test.mjs` reads this file and holds these copies
# equal to the server's.
READ_WHATS = (
    "contracts", "data_intake",
    "study", "definition", "criteria", "assumptions", "evidence", "population", "patients", "comparator", "trial",
    "precedents", "matching", "subject_document", "followup_history", "model_source", "generated_records", "results", "report_model", "snapshot_profile", "models", "jobs",
    "trial_registry_record", "patient_context", "pack", "library", "model_assessments", "longitudinal", "candidate_trials", "soa", "regulatory_contacts",
    "candidates", "success_rates",
)
WRITE_WHATS = ("data_intake", "task_context", "patient_context",
    "definition", "protocol", "criteria", "assumption", "evidence_item", "precedent", "population", "patient_set",
    "comparator", "trial_scenario", "design_grid", "decision", "report", "model", "forecast", "step", "plan",
    "fact", "language_judgment", "field_map", "pack", "model_assessment", "history", "forecast_design", "trial_benchmark",
    "trial_judgment", "soa", "regulatory_contact", "result_record",
)
# The engine's job kinds, in the domain's order (`VCR_JOB_KINDS` in
# `packages/domain/src/vcrVocabulary.mjs`): the 24 of the first release, then the
# comparator-effect kinds appended after them; `test/test_vcr_platform.py` reads
# the domain and holds this list equal to it.
JOB_KINDS = ("fit_survival_model", "apply_prognostic_model",
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
    # a generated population against a second baseline table (2026-11-01)
    "population_check",
    # the confirmatory designs: futility boundaries, sample-size re-estimation, multi-arm, enrichment, counts (2026-11-03)
    "design_confirmatory",
    # quantitative bias analysis of an estimate and the G-computation simulated treatment comparison (2026-11-03)
    "bias_analysis", "stc_comparator",
    # network and dose-response meta-analysis and the empirical shrinkage of a published effect (2026-11-03)
    "network_meta", "dose_response_meta", "effect_shrinkage",
    # target-trial emulation from a person-period table: a sequence of trials and clone-censor-weight (2026-11-03)
    "target_trial_emulation",
    # dose-finding designs and Bayesian designs without MCMC (2026-11-03)
    "design_dose", "design_bayesian", "design_win_ratio",
    # dynamic borrowing of an external control arm: the power, SAM and elastic priors (2026-11-03)
    "borrowing_prior",
    # a prognostic model trained on the person's own historical table, cross-fitted, and a population-level disease-progression simulator (2026-11-03)
    "train_prognostic_model", "generate_progression",
    # patient and trial judged by the model, pair by pair (2026-11-04)
    "match_judge",
    # many patients' records taken in as a job (2026-11-04)
    "records_import",
    "forecast_trajectories", "evaluate_forecast", "compare_forecasts", "benchmark_trial_effect",
)
POOLING_METHODS = ("single_study", "random_effects_dl", "random_effects_reml", "random_effects_hksj", "fixed_effect")
POOLING_CALIBRES = ("closest", "overall", "next_closest")
# The empirical priors for the between-study spread a pooling may name (`packages/domain/src/vcrEvidencePriors.mjs`); a prior the run types in is not offered here.
TAU_PRIOR_KINDS = ("turner_2015", "turner_2015_generic", "bartos_2023")
# The virtual lab's actions (F4): the same operation the trial plugin's `virtual_trial_search` / `virtual_trial_compare` reach, so a study
# conversation without that plugin runs a design search or a design comparison through this one tool. They take a frozen manifest or an
# experiment and an id, never a job id; the lab answers them whole (a campaign advances on the platform, not in this call).
LAB_ACTIONS = ("search", "search_status", "search_cancel", "compare", "compare_status")
SIMULATE_ACTIONS = ("start", "status", "cancel", "shape", "validate", *LAB_ACTIONS)
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
                                   "prognostic_adjustment_comparator", "negative_control_comparator", "tipping_point", "stc_comparator", "bias_analysis",
                                   "target_trial_emulation", "borrowing_prior"),
}
# What the platform generates from the domain's scenario schemas (`pnpm generate:vcr-scenario-help`): every key each method's
# scenario reads. It rides in the image beside this file and is never edited by hand.
# The kinds whose result is a table of generated rows (`vcr_read what generated_records` reads it back).
RECORD_KINDS = tuple(OBJECT_SHAPES["population (definition)"] + OBJECT_SHAPES["patient_set (scenario)"])
# The kinds whose scenario states the truth a design assumes: a number read in a paper can be tied to its field there (`sources`).
SOURCE_KINDS = ("design_analytic", "design_simulation", "design_grid", "assurance", "procova")

# The generic design kinds the model opens first. A question that has a method of its own is answered by that kind, and in three live conversations
# (2026-11-04: dose escalation, a single-arm look every ten patients, a three-level composite) the model had shaped a generic kind and then wrote its own
# simulation for what another kind computes. The pointer rides on the shape answer, where the model is already choosing, and not in the tool description.
# Live 2026-11-07: an Alzheimer three-arm simulation, a comparison of designs computed earlier and a forecast for six listed patients each went
# to a script of the model's own; in the forecast conversation the model had shaped design_analytic for the sample-size half of the question.
# So the pointer also names the disease-progression kind, the batch forecast and the lab's two actions.
DESIGN_POINTER_KINDS = ("design_analytic", "design_simulation", "design_grid")
DESIGN_POINTER = ("This kind designs one trial of the usual kinds. If the question is of another sort, shape that kind instead of writing your own simulation: "
                  "design_dose (3+3, BOIN, CRM, Keyboard: which dose is chosen), design_bayesian (a single-arm trial looked at every few patients: BOP2, "
                  "predictive monitoring, against Simon), design_confirmatory (futility stops, sample-size re-estimation, multi-arm selection, enrichment), "
                  "design_win_ratio (death, then admissions, then a score, compared in order), network_meta (which of several treatments is best), "
                  "generate_progression (trial arms on a disease-progression model: the Alzheimer ADAS-cog model with a symptomatic or disease-modifying "
                  "drug hypothesis), forecast_trajectories (a forecast for each of the person's patients). Designs already computed are compared with "
                  "action compare, and the smallest design that meets stated requirements is found with action search; action shape with no kind gives "
                  "both forms.")
# The disease-progression kind: several drug hypotheses on the same people are one comparison, and a population's course is not a person's forecast.
PROGRESSION_POINTER = ("Several drug hypotheses on the same people (no drug, symptomatic, disease-modifying) are one start each, or one comparison: action "
                       "compare with arms [{name, method: \"patients.progression\", scenario}] that differ only in treatment (action shape with no kind "
                       "gives its form). The result is the course of a population, not a forecast for a named patient: that is forecast_trajectories.")
# Generated people are not the person's patients: a forecast for a list of real patients is the batch forecast.
GENERATED_PATIENTS_POINTER = ("These people are generated from stated assumptions; a forecast for each of the person's own patients is forecast_trajectories, "
                              "and the course of a disease under drug hypotheses is generate_progression.")
HELP_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vcr_scenario_help.json")
# Where the VCR methods are in the runtime image. They are capability skill bodies, which delegation injects into a planned
# capability's run; a plain conversation in a study uses these tools too and its skill catalogue does not list them, so the tools
# name the files (the deployment's own variable, as the guidance's skill roots are, with the image's path as the default).
SKILLS_ENV = "EVIMED_CAPABILITY_SKILLS_DIR"
SKILLS_DEFAULT = "/opt/evimed/capability-skills"
WRITE_MAX_ITEMS = 200
# The one operation whose answer waits on a container: the gateway's budget is the
# deployment's own intake timeout plus a margin, and this ceiling sits above it.
DIGITIZE_TIMEOUT_SECONDS = 100
# A candidates search reads up to its deadline (30 s by default) and then reorders what it found; the ceiling sits above the two.
CANDIDATES_TIMEOUT_SECONDS = 75
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
    def __init__(self, code: str, message: str, retryable: bool = False, issues: list | None = None, status: int | None = None):
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.status = status
        # The gateway's per-field findings of a refused job ({code, field}), when it sent them.
        self.issues = issues or []

    def stop_reason(self) -> str:
        """What the run should do next: fix the call, retry, or go on without.

        A code ending ``_invalid`` names a field the run got wrong -- except the
        credential's, which is the deployment's to fix (``unsupported``). So does
        any 400 from the gateway, whose sentence says what to send: a design that
        names no trial scenario was told to "go on without the study" here, and
        the run did, on 2026-11-01, one write short of the engine.
        """
        if self.code in AUTH_CODES:
            return "unsupported"
        if self.code.endswith("_invalid") or self.status == 400:
            return "invalid_input"
        return "retry" if self.retryable else "unsupported"


def _detailed_tool_definitions():
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
                "judgments with approved projected quotes and sourced facts; factContract gives the exact clinical metadata schema. what: candidate_trials lists the registry trials found for patients "
                "(filter.id or filter.registryId reads one with its criteria; filter.subjectKey returns that patient's trials in order "
                "with the verdict about each; once the model has judged them, ranking gives each trial's verdict, fit, reasons and "
                "per-clause labels with their evidence; matching with filter.protocolVersionId gives the same for a protocol's people, and its numbered clauses). "
                "what: subject_document with filter.subjectKey and filter.kind sentences reads a patient's record as numbered sentences, with the documentHash a trial_judgment write names; "
                "trial_registry_record gives numbered clauses. what: candidates searches the three registries for "
                "trials that might take one patient: write filter.condition and up to 32 filter.terms ranked by priority (the patient's problems in "
                "order of importance, English and Chinese both when the note is Chinese; earlier phrases weigh more and a phrase the deadline "
                "does not reach is reported), a filter.summary of the patient's problems, stage and treatments so far (your own words, no name "
                "or ID number, never the note) to put the list in the order of how it reads against the patient, and age, sex, region, status. "
                "Each registry is paged and merged; the answer says which registries were searched, which failed or were not reached, and what is not covered, "
                "returns the first rows and a searchId. Read the rest with filter.searchId and filter.offset, or judge the best N with "
                "vcr_simulate kind match_judge selection {subjectKey, searchId, candidateLimit}."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "what": {"type": "string", "enum": list(READ_WHATS)},
                    "filter": {
                        "type": "object",
                        "properties": {
                            "id": ID,
                            "parentId": ID,
                            "kind": ID,
                            "registryId": ID,
                            "registry": ID,
                            "collection": ID,
                            "collectionRevision": {"type": "string", "pattern": "^[a-f0-9]{64}$"},
                            "snapshotId": ID,
                            "cursor": {"type": "string", "maxLength": 2048},
                            "sourceId": ID,
                            "subjectKey": ID,
                            "documentId": ID,
                            "protocolVersionId": ID,
                            "query": {"type": "string", "minLength": 1, "maxLength": 200},
                            "limit": {"type": "integer", "minimum": 1, "maximum": 500, "default": 20},
                            "beforeSeq": {"type": "integer", "minimum": 0},
                            "offset": {"type": "integer", "minimum": 0, "maximum": 1048576},
                            # what: candidates -- the registry search a run writes and what it knows of the patient.
                            "condition": {"type": "string", "minLength": 1, "maxLength": 200},
                            "terms": {"type": "array", "items": {"type": "string", "minLength": 1, "maxLength": 200}, "maxItems": 32},
                            "summary": {"type": "string", "minLength": 1, "maxLength": 2000},
                            "searchId": ID,
                            "age": {"type": "number", "minimum": 0, "maximum": 130},
                            "sex": {"type": "string", "enum": ["male", "female"]},
                            "region": {"type": "string", "minLength": 1, "maxLength": 80},
                            "status": {"type": "string", "enum": ["open", "any"]},
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
                "its eligibility criteria (protocolText, the section as written, which the platform numbers; or criteria of kind and sourceText, "
                "with a requirement only for screening a table), assumption cards and their evidence items, precedents, population, "
                "patient-set, comparator and trial designs, a design grid, a decision record, a regulatory contact, the protocol's visit schedule "
                "(soa, one visit per item), a fitted literature model, "
                "a model's ICH M15 assessment record, patient facts, longitudinal research history, or the report text. A disease pack: data {use: <catalogue id>} binds one, "
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
                " what: trial_benchmark imports an existing external trial-effect JSON via data {predictionsFile: workspace-relative path}; "
                "actual effects are read from preserved evidence. Never generate the file's predictions yourself."
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
                "For matching, selection names one protocolVersionId or up to ten protocolVersionIds, subjectKeys "
                "and direction; continue a frozen batch with snapshotId and offset. "
                "match_judge has the model judge patients against trials, pair by pair, in a job of its own: selection takes subjectKey and registryIds "
                "(one patient, a list of trials, with collection and collectionRevision for a frozen set) or a searchId from candidates "
                "(the platform takes the trials from that saved list, best first; candidateLimit keeps the first N of either), or protocolVersionId and subjectKeys (one protocol, a roster); "
                "fit and thinking are optional. No scenario. Read the saved ranking back with vcr_read candidate_trials or matching. "
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
                    "modelId": ID,
                    "modelVersion": {"type": "string", "minLength": 1, "maxLength": 128, "pattern": r"^[A-Za-z0-9][A-Za-z0-9_.+-]*$"},
                    "selection": {"type": "object", "properties": {
                        "protocolVersionId": ID,
                        "protocolVersionIds": {"type": "array", "minItems": 1, "maxItems": 10, "items": ID},
                        "subjectKeys": {"type": "array", "minItems": 1, "maxItems": 5000, "items": ID},
                        "direction": {"type": "string", "enum": ["trial_to_patient", "patient_to_trial"]},
                        "asOf": {"type": "string"}, "offset": {"type": "integer", "minimum": 0}, "prefilter": {"type": "boolean"},
                        "snapshotId": {"type": "string", "pattern": "^[a-f0-9]{64}$"},
                        "subjectKey": ID,
                        "registryIds": {"type": "array", "minItems": 1, "maxItems": 500, "items": ID},
                        "searchId": ID,
                        "candidateLimit": {"type": "integer", "minimum": 1, "maximum": 500},
                        "registry": {"type": "string", "enum": ["clinicaltrials.gov", "chictr", "ctis"]},
                        "collection": ID,
                        "collectionRevision": {"type": "string", "pattern": "^[a-f0-9]{64}$"},
                        "fit": {"type": "boolean"},
                        "thinking": {"type": "string", "enum": ["high", "off"]},
                    }, "additionalProperties": False},
                    "reconstructionResultId": ID,
                    "jobId": ID,
                    "manifest": {"type": "object"},
                    "campaignId": ID,
                    "experiment": {"type": "object"},
                    "experimentId": ID,
                    "sources": {"type": "array", "maxItems": 8, "description": (
                        "A number you read in a paper and wrote into the scenario: [{field: its path in the scenario, e.g. truth.controlMedian, "
                        "publication: PMID or DOI, quote: the sentence that prints it}]. For a user-stated parameter, optionally use "
                        "{origin:user, field:design.nTreat, value:30, quote:<original human sentence>, unit:patients, context:<its meaning>}. "
                        "Bind only the stated meaning, arm and unit; equal digits elsewhere do not establish a parameter. Missing bindings stay assumptions."),
                        "items": {"oneOf": [
                            {"type": "object", "properties": {"field": {"type": "string"}, "publication": {"type": "string"}, "quote": {"type": "string"}},
                             "required": ["field", "publication", "quote"], "additionalProperties": False},
                            {"type": "object", "properties": {"origin": {"const": "user"}, "field": {"type": "string"},
                                "value": {"type": "number"}, "quote": {"type": "string"}, "unit": {"type": "string"}, "context": {"type": "string"},
                                "sessionId": {"type": "string"}, "messageSeq": {"type": "integer", "minimum": 0}},
                             "required": ["origin", "field", "value", "quote", "unit", "context"], "additionalProperties": False}
                        ]}},
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
                    "collection": ID,
                    "collectionRevision": {"type": "string", "pattern": "^[a-f0-9]{64}$"},
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
                "published numbers at risk (riskTable [{time, atRisk}], at least two rows; none printed: initialAtRisk, the arm's "
                "size; totalEvents and reportedMedian when printed). One arm is the control, two arms are control then treatment. You never state a "
                "coordinate: points are measured from the pixels and come back recorded with the algorithm version, the "
                "calibration as you stated it, the parameters used and quality indicators (xCoverage, bridgedColumns = "
                "stretches hidden under another curve and held, monotonicityRepairs, startSurvival). The answer is a "
                "receiptId: pass it to vcr_simulate as kind reconstruct_km with scenario {provenance:{receiptId}}, or write "
                "it as a literature comparator's configuration.provenance.receiptId. Measured on figures drawn from "
                "known curves: survival within 0.02 and time within 0.6% of the x range. Not reliable: curves "
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
                                "initialAtRisk": {"type": "integer", "minimum": 1},
                                "totalEvents": {"type": "number", "minimum": 0},
                                "reportedMedian": {"type": "number", "exclusiveMinimum": 0},
                            },
                            "anyOf": [{"required": ["riskTable"]}, {"required": ["initialAtRisk"]}],
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
                    "tauPrior": {
                        "type": "object",
                        "description": "Optional Cochrane reference for the spread between studies; gives two studies a prediction interval. Its shape is in vcr_simulate action=shape.",
                        "properties": {
                            "kind": {"type": "string", "enum": list(TAU_PRIOR_KINDS)},
                            "outcome": {"type": "string", "maxLength": 60},
                            "comparison": {"type": "string", "maxLength": 60},
                            "effectScale": {"type": "string", "maxLength": 40},
                        },
                        "required": ["kind"],
                        "additionalProperties": False,
                    },
                    "jobId": ID,
                },
                "required": ["action"],
                "additionalProperties": False,
            },
        },
    ]


def skills_root() -> str:
    """The directory holding the VCR methods' SKILL.md files, without a trailing slash."""
    root = os.environ.get(SKILLS_ENV, "").strip().rstrip("/")
    return root if root.startswith("/") else SKILLS_DEFAULT


def tool_definitions():
    """Compact root catalogue; the workflow skill and shape action carry detail."""
    root = skills_root()
    descriptions = {
        "vcr_read": "Read this conversation's research. what=study opens compact context and enables specialist tools. patient_context lists uploads (text, PDF, Word, scans), knowledge-base documents, this study's patients and authenticated human messages (messageSeq); follow nextUploadRead for more uploads. subject_document reads original material; kind=sentences numbers it. trial_registry_record reads one registry (filter registryId). contracts gives write syntax before any task exists; data_intake lists upload handles; candidate_trials reads patient trial matches. Any eligibility verdict you deliver is copied from the saved read-back (matching or candidate_trials with filter.subjectKey), never retyped.",
        "vcr_write": "Save research objects, never calculated results. data_intake imports a patient table or record folder, nothing to confirm (see contracts). protocol: data={title,protocolText}. patient_context takes data={sourceId,generation,sha256} from uploads, {sourceId} for a knowledge-base original, or {messageSeq} for a human case; add subjectKey for a patient already here; their trials are re-judged. task_context opens a task. A fact for structured screening states only what its quote says: what the text does not mention is unknown, never negated. trial_judgment saves your judgment of a patient against a trial or protocol, with sentence ids as evidence. For object contracts use the workflow skill (read %s/vcr-matching/SKILL.md before matching trials; vcr-protocol, vcr-evidence, vcr-analysis and vcr-package sit beside it; none is in the catalogue) and vcr_simulate action=shape for numerical inputs." % root,
        # The one line of the module a general conversation always reads: the classes of question in a person's words. Live 2026-11-07: an
        # Alzheimer three-arm simulation, a comparison of designs computed earlier and a forecast for six listed patients went to the
        # model's own scripts; they are named here within the same 420 characters ("modelId requires modelVersion" is said by the
        # gateway's refusal of a modelId without it, the pointer to the result page by the answer of start).
        "vcr_simulate": "Trial sample size, power or events; comparing designs (saved too) or searching one; dose finding; disease-progression arms (Alzheimer ADAS-cog); patient forecasts; synthetic cohort from a baseline table; external control; comparing several drugs (network meta-analysis): calculate here, not in your script. No study needed. action=shape with kind gives fields; do not guess keys. Jobs that outlive this turn resume here.",
    }
    tools = _detailed_tool_definitions()
    for tool in tools:
        if tool["name"] in descriptions:
            tool["description"] = descriptions[tool["name"]]
            # The wrapper and gateway retain their complete validation. The root
            # learns method-specific fields from shape, not a permanent schema.
            props = tool["inputSchema"]["properties"]
            for name in ("filter", "data", "scenario", "selection"):
                if name in props:
                    props[name] = {"type": "object"}
            if "items" in props:
                props["items"] = {"type": "array", "items": {"type": "object"}}
    return tools


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


_EXECUTION_CONTEXT = ContextVar("vcr_execution_context", default=None)


@contextmanager
def invocation(execution_context):
    """Keep native context per synchronous call, including nested wrappers."""
    token = _EXECUTION_CONTEXT.set(execution_context)
    try:
        yield
    finally:
        _EXECUTION_CONTEXT.reset(token)


def _post(operation: str, payload: dict, timeout: int = TIMEOUT_SECONDS) -> dict:
    base, token = _gateway()
    request = urllib.request.Request(
        "%s/%s" % (base, operation),
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "accept": "application/json",
            **({"X-EviMed-Execution-Context": json.dumps(_EXECUTION_CONTEXT.get())} if _EXECUTION_CONTEXT.get() else {}),
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
            status=error.code,
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


def _longitudinal_comparison_summary(data: dict) -> str:
    """Surface the engine's per-baseline directions without recomputing scores.
    This reads only the already-projected answer, including any suppression."""
    sentences = []
    seen = set()
    for record in data.get("records", []) + data.get("related", []):
        if record.get("kind") != "evaluation" or record.get("id") in seen:
            continue
        seen.add(record.get("id"))
        for group in record.get("summary", {}).get("groups", []):
            if group.get("suppressed") or group.get("displayReason"):
                continue
            directions = []
            for name, baseline in group.get("baselines", {}).items():
                for metric, comparison in baseline.get("comparisons", {}).items():
                    if comparison.get("model") is None or comparison.get("baseline") is None:
                        continue
                    preferred = comparison.get("preferred")
                    wording = {"model": "model better than " + name,
                               "baseline": name + " better than model", "equal": "model equal to " + name}.get(preferred)
                    if wording:
                        directions.append(metric + ": " + wording)
            if directions:
                sentences.append("%s at %s days: %s." % (record.get("id"), group.get("horizonDays"), "; ".join(directions)))
    return " ".join(sentences) + (" These are same-subject point estimates, not significance tests." if sentences else "")


def read(arguments: dict) -> dict:
    what = arguments.get("what")
    if what not in READ_WHATS:
        raise VcrPlatformError("vcr_read_what_invalid", "what must be one of: %s." % ", ".join(READ_WHATS))
    payload = {"what": what}
    if isinstance(arguments.get("filter"), dict) and arguments["filter"]:
        payload["filter"] = arguments["filter"]
    try:
        # A search for a patient's trials pages many registries and then reorders the list: it has its own deadline server-side.
        data = _post("read", payload, timeout=CANDIDATES_TIMEOUT_SECONDS if what == "candidates" else TIMEOUT_SECONDS)
    except VcrPlatformError as error:
        if error.code in _absent_codes():
            return _module_absent(error, what, "read")
        raise
    warnings = []
    next_actions = []
    if what == "patient_context":
        if data.get("uploads"):
            next_actions.append("Choose the original attachment in uploads and call vcr_write what=patient_context with its exact data={sourceId,generation,sha256}.")
        if data.get("nextUploadRead"):
            next_actions.append("Follow data.nextUploadRead exactly to see more original attachments.")
        if data.get("candidates"):
            next_actions.append("To preserve an authenticated human case, call vcr_write what=patient_context with data={messageSeq}.")
        if data.get("nextBeforeSeq") is not None:
            next_actions.append("To see earlier human messages, repeat patient_context with filter.beforeSeq set to data.nextBeforeSeq.")
    if what == "matching" and (arguments.get("filter") or {}).get("kind") not in ("contract", "terminology", "table_meaning"):
        next_actions.append("Read matching filter.kind=contract for the criteria grammar and the fact contract used to screen a table by rules; vcr_read what=patient_context lists original uploads and authenticated human cases.")
        if data.get("subjectKey"):
            if data.get("ranking"):
                pass
            elif data.get("assessment") is None:
                next_actions.append("Nothing is saved for this person yet. To judge them from their record start vcr_simulate action=start kind=match_judge; to screen a table on its columns by rules, kind=match_criteria. Read matching with this subjectKey when it completes. Do not invent judgments.")
            else:
                next_actions.append("The saved assessment contains criterion judgments and approved evidence. To read one criterion narrowly use filter.subjectKey plus filter.id=criterionId; missing evidence remains unknown.")
                next_actions.append("Deliver from this read-back: copy summary, each judgment's state and applicable and the evidence quotes as saved; if your own reasoning differs, say so beside the saved verdict, do not replace it.")
        else:
            next_actions.append("Read one returned subjectKey to obtain its saved assessment and quoted evidence; use filter.id for one criterion if needed.")
    judged = what in ("candidate_trials", "matching") and isinstance(data.get("ranking"), list) and data["ranking"] and isinstance(data["ranking"][0], dict) and data["ranking"][0].get("verdictLabel")
    if judged:
        next_actions.append("ranking holds the saved judgments, in order: copy verdictLabel, reasons and each clause's display words and evidence from it, and say how many pairs finished (finished) and which did not (failed, by code). Never report a pair it does not hold.")
    elif what == "candidate_trials" and data.get("subjectKey") and data.get("ranking"):
        next_actions.append("ranking holds this patient's saved verdict for each trial, in the platform's order. A delivered per-trial table copies registryId, eligibility, criteriaCounts and evidenceGaps from it; a criterion belongs to the trial it was saved under, so never move one between trials.")
        next_actions.append("Say how much is decided with each trial (decided of applicable: unknown and waiting criteria stay in the total) and, from undecided, which criteria are open and why. status is the registry's word as of statusAsOf, not a place at a centre. The order puts trials the patient is not excluded from first and the better-decided first; 符合 says the stated criteria are met, it is not a recommendation.")
    if what == "subject_document" and isinstance(data.get("passages"), list) and data.get("passageSearch") is not None:
        next_actions.append("passages are sentences of the record found by the words they share with the criterion, each with its start and end (UTF-16 offsets): a hint, never a "
                            "verdict. Read around one with offset=start-300. A fact still needs a verbatim quote that the platform checks at write. When no passage fits, write no fact: the "
                            "criterion stays unknown -- do not write it negated, and do not take silence in a hint for silence in the record.")
    if what == "subject_document" and isinstance(data.get("long"), dict):
        next_actions.append("This record is long: ask for the part a criterion bears on by repeating the read with filter.id (a criterion id) or filter.query (a few words) instead of reading every window.")
    rerank = data.get("rerank") if isinstance(data.get("rerank"), dict) else {}
    if what == "candidates" and data.get("collection") and data.get("available") is not False:
        if data.get("searchId"):
            next_actions.append("Judge the best of them with vcr_simulate kind match_judge, selection {subjectKey, searchId, candidateLimit}: the platform takes the trials, with their collection and revision, "
                                "from this saved list in the order shown. Carry the collection and collectionRevision of a row into trial_registry_record. Read more rows with filter.searchId and filter.offset.")
        else:
            next_actions.append("Judge them with vcr_simulate kind match_judge, selection {subjectKey, registryIds, collection, collectionRevision}; carry the same collection and collectionRevision into trial_registry_record. ")
        next_actions.append("Use the collection's snapshot date for registry fields, and keep retrieval rank separate from eligibility.")
    elif what == "candidates" and data.get("available") is not False:
        next_actions.append("Say in the reply what data.coverage says: the registries searched and the day (asOf), any that failed or were not reached and why, and that CDE and ICTRP are not covered. "
                            "These are listings found by the search you wrote, merged and de-duplicated; their order is not a ranking of who fits (data.order says how they are ordered) and none is a judgement about the patient.")
        next_actions.append("A field listed in a candidate's unknown is one the registry did not state, so the candidate was kept, not cleared: ChiCTR's list gives no sex, age or "
                            "country and no eligibility text; the judging job reads its registry page for the conditions, and a trial whose page cannot be read is judged without them and says so. leftOut counts what a record's own stated status, age, sex or country ruled out.")
        retrieval = data.get("retrieval") if isinstance(data.get("retrieval"), dict) else {}
        if retrieval.get("reachedAllPhrases") is False:
            next_actions.append("The search deadline passed before every phrase was asked: registries[].failed lists the phrases with reason search_deadline. Search again with the unreached phrases first, or fewer phrases.")
        if rerank.get("state") == "skipped" and rerank.get("summaryGiven") is False:
            next_actions.append("The list is in retrieval order. Add filter.summary (your summary of the patient's problems, stage and treatments, no name or ID number) to have it ordered by how each trial reads against the patient.")
        if data.get("searchId"):
            next_actions.append("To judge the best of these, start vcr_simulate kind match_judge with selection {subjectKey, searchId, candidateLimit} (the platform takes the trials from this saved list, best first). "
                                "A handful may be judged here: read the numbered clauses with trial_registry_record and the numbered sentences with subject_document, then save with vcr_write what trial_judgment.")
        else:
            next_actions.append("To judge the patient against these candidates, start vcr_simulate kind match_judge with selection {subjectKey, registryIds}. A handful may be judged here: "
                                "read the numbered clauses with trial_registry_record and the numbered sentences with subject_document, then save with vcr_write what trial_judgment.")
    if what == 'report_model':
        next_actions.append('For longitudinal report numbers, append the exact field inside a record summary to its numberPath, without another .summary segment. For example: longitudinal.byId.<id>.groups[0].requested. Use vcr_read longitudinal filter.id for one full record when this report model is large; only fields actually returned are bindable.')
    if what == 'longitudinal':
        next_actions.append('Records and related are both readable results. filter.id selects that exact record; filter.parentId selects its evaluations. A prediction carries relatedIds for its latest evaluation. Empty filtered pages do not prove no validation exists.')
        next_actions.append('A numeric metrics value marked availability=computed is a computed estimate, including zero and zero-width intervals. Only null/unavailable metrics have missing inputs; read unavailableReason. Predictive samples support CRPS without an sd. With adequate follow-up, zero events still permit Brier, while AUROC/AP need both classes.')
        next_actions.append('A prediction_set contains independently evaluable endpoint component ids. Compare changed inputs/models with mode input_sensitivity/model_version, or updated origins with mode update; update comparisons pair equal calendar target dates. Every record.numberPath resolves to its summary in report_model.longitudinal.byId, independent of list order. Incident risk evaluations report prevalent exclusions separately; local calibration separation does not verify provider training independence.')
    if data.get("more") is True:
        warnings.append("More items exist than this answer holds.")
        if what == "candidates" and data.get("nextCursor"):
            next_actions.append("Repeat the same candidates filters with filter.cursor set to data.nextCursor.")
        elif what == "candidates" and data.get("searchId") and data.get("nextOffset") is not None:
            next_actions.append("Read the next rows of this search with filter.searchId=%s and filter.offset=%s; no registry is asked again." % (data["searchId"], data["nextOffset"]))
        else:
            next_actions.append("Follow data.nextRead exactly, carrying its filter.cursor; do not use offset for intake." if what == "data_intake" else "Call again with filter.offset to read the next page, or narrow the filter.")
    if what == 'data_intake' and data.get('sourceRead'):
        next_actions.append('data.sourceRead lists owned knowledge-base upload originals separately; the default upload page lists this root and project-level upload receipts.')
    if data.get("available") is False:
        # A package this deployment has not composed: named, and only the step
        # that needed it is affected.
        warnings.append(str(data.get("message") or "This part of the platform is not available on this deployment."))
        next_actions.append("Do the steps that do not need it, and say in the report what is missing and why.")
    if what == "results" and any(_type_one_verdicts(result) for result in data.get("results") or [] if isinstance(result, dict)):
        # Live D8, phase 3 (2026-11-07): a grid's null check of 2.44% +/- 0.11% was read here and answered "can confirm it does not exceed 2.5%".
        next_actions.append(TYPE_ONE_VERDICT_LINE)
    if what == "results" and any(_progression_differences(result) for result in data.get("results") or []):
        next_actions.append(PROGRESSION_DIFFERENCE_LINE)
    return {
        "status": "warning" if warnings else "success",
        "summary": ("Read %s of this 虚拟临床研究 study. %s" % (what, _longitudinal_comparison_summary(data) if what == "longitudinal" else "")).strip(),
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
    if what == "trial_benchmark" and isinstance(payload.get("data"), dict) and "predictionsFile" in payload["data"]:
        try:
            workspace = managed_workspace()
            file = (workspace / Path(payload["data"]["predictionsFile"])).resolve(strict=True)
            if not file.is_relative_to(workspace) or not file.is_file() or file.stat().st_size > 400 * 1024:
                raise ValueError("Select a trial-prediction JSON inside the workspace, at most 400 KB.")
            raw = file.read_bytes()
            document = json.loads(raw)
            if not isinstance(document, dict) or not isinstance(document.get("comparisons"), list):
                raise ValueError("The trial-prediction file requires comparisons.")
            document["sourceFile"] = {"name": file.name, "sha256": hashlib.sha256(raw).hexdigest()}
            payload["data"] = document
        except (OSError, ValueError, TypeError, ImmutableCaptureError) as error:
            raise VcrPlatformError("vcr_benchmark_invalid", "Read a valid external trial-prediction JSON from this workspace.") from error
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
    # A reminder is not a refusal: the object it is about is saved and computed as it stands (a record not written yet, a role not
    # stated), and the answer says what to add in a next version.
    reminders = [issue for issue in issues if issue.get("code") in _REMINDER_CODES]
    refused = [issue for issue in issues if issue.get("code") not in _REMINDER_CODES]
    next_actions = []
    if what == "task_context" and data.get("untitled") is True:
        # A conversation's study is named by the model's words and by nothing a person said: asked for once, in the answer that makes it.
        next_actions.append("This research has no title yet: write task_context again with data={\"title\": ...}, a short name for the research question "
                            "(at most 40 characters; the question's name, never a person or an identifier).")
    if refused:
        next_actions.append("Correct the refused items and write only those again.")
    for result in data.get("results") or []:
        # Words the platform read as the closed ones, and the names to call the saved objects by: said once, in the answer that has them.
        if isinstance(result, dict) and result.get("applied"):
            next_actions.append("data.results[].applied lists words the platform read as the vocabulary's own (field: what you wrote, what it took); write the closed word next time.")
        if isinstance(result, dict) and result.get("named"):
            next_actions.append("Refer to the saved objects in your reply by data.results[].named[].name, never by id.")
    if reminders:
        next_actions.append("The warnings that name a record or a role are reminders: the object is saved and its result is delivered as it "
                            "stands. Add what they name by writing the same object again (a new version), without waiting for anyone.")
    if any(issue.get("code") in ("vcr_evidence_values_inconsistent", "vcr_evidence_second_read_differs") for issue in reminders):
        next_actions.append("A warning that names numbers which do not agree (or two readings of one passage) is advice: read those numbers in the source again; if one was copied wrong, "
                            "write the item again with the right one, otherwise leave it. The value is kept as read either way.")
    return _with_entry({
        "status": "warning" if issues else "success",
        "summary": "Wrote %s: %d written%s%s." % (what, len(ids), ", %d refused" % len(refused) if refused else "",
                                                   ", %d reminder(s)" % len(reminders) if reminders else ""),
        "data": data,
        "warnings": [_issue_line(issue) for issue in issues[:20]],
        "next_actions": next_actions,
    }, data)


# The write issues that are reminders of a record the object has not got yet, not refusals (the object is saved).
_REMINDER_CODES = frozenset({"vcr_comparator_record_incomplete", "vcr_assumption_role_missing", "vcr_evidence_item_incomplete", "vcr_evidence_reported_unverified",
                            "vcr_evidence_values_inconsistent", "vcr_evidence_second_read_differs"})


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
    # What the key asks of a person, derived by the platform from the schema's structure (an object has no role: its keys do).
    if row.get("fieldRole") in ("research_fact", "defaultable"):
        text += "; role: %s" % row["fieldRole"]
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
    elif kind == "lengthRule":
        plus = int(rule.get("plus") or 0)
        text = "%s lists %s than %s" % (rule.get("key"), "%d more value%s" % (plus, "" if plus == 1 else "s") if plus > 0 else "as many values", rule.get("of"))
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


# Live 2026-11-07: asked for each of six listed patients' MMSE over 24 months, with no forecast service in the deployment, the model wrote
# per-patient projections with prediction intervals of its own. The answer says what a forecast needs and what to say when it is not there.
FORECAST_PROVIDER_NOTE = ("A forecast for named patients needs their history stored for this study and a forecast service: providerId is one that vcr_read "
                          "what longitudinal lists. With none listed, no individual forecast can be computed here: say so and never project a patient "
                          "yourself; the course of a population under stated assumptions is generate_progression or generate_patients_longitudinal.")


def _control_plane_shape(kind: str):
    """A forecast kind runs in the control plane, not the engine: its scenario names stored histories, forecasts and outcomes by id,
    plus options. The keys come from the generated help's ``longitudinal`` section (the validator's own lists)."""
    help_ = scenario_help()
    entry = help_["kinds"].get(kind)
    method_id = entry.get("method") if isinstance(entry, dict) else None
    schema = help_.get("longitudinal", {}).get(method_id) if method_id else None
    if not isinstance(schema, dict):
        return None
    required, optional = list(schema.get("required", [])), list(schema.get("optional", []))
    fields = schema.get("fields") if isinstance(schema.get("fields"), dict) else {}

    def say(key: str) -> str:
        # a field the domain describes (the batch forecast's mode, actions and versioning) is said in the domain's words
        return fields.get(key) or ("id of a stored record" if key.endswith("Id") else "value")

    keys = ["%s: %s; required" % (key, say(key)) for key in required]
    keys += ["%s: %s; optional" % (key, say(key)) for key in optional]
    return {
        "status": "success",
        "summary": "The scenario of %s (method %s) reads %d keys; the platform computes it from the stored records they name." % (kind, method_id, len(keys)),
        "data": {"kind": kind, "method": method_id, "controlPlane": True, "keys": keys,
                 "notes": ["Ids name records already stored for this study (vcr_read what: longitudinal); the platform computes every metric."]
                 + ([FORECAST_PROVIDER_NOTE] if kind == "forecast_trajectories" else [])},
        "warnings": [],
        "next_actions": ["Write exactly these keys and no others, then queue it with vcr_simulate action start."],
    }


# The lab's own shapes (F4), answered by `shape` with no kind so the tool description stays as short as it was. The keys inside a manifest
# are the domain's `vcrCampaignManifest`; `test_vcr_platform.py` holds the words that matter (the frozen evaluator, the analysis level).
LAB_SHAPES = {
    "search": "action search with manifest {question, objective {measure, direction minimize|maximize, truth}, constraints [{measure, op <=|>=, bound, "
              "kind error_control|design|safety, truth}], space {method design.simulate|design.dose|design.analytic|patients.progression, scenario, "
              "truths [{name, truth}], and either variables [{path, values}] or candidates [{set}]}, stages {screening {replicates}, final {count}}, "
              "budget {maxCandidates, cpuSeconds}}. Only design paths vary: the truth, endpoint, sidedness and what is measured are the evaluator. "
              "An error-control bound is fixed and never relaxed; it passes only on its conservative bound, never on a point estimate. The analysis "
              "level (analysis.alpha, design.simulate and patients.progression) may be a variable only at or below that bound, with an error-control "
              "constraint stated: it is how a design gains margin under the same constraint. A changed manifest is a new campaign. Read with "
              "search_status {campaignId}, stop with search_cancel {campaignId}.",
    "compare": "action compare with experiment {question, arms [{name, resultId} | {name, method, scenario}], comparison {measures, reference}}: saved "
               "design results attach by id and are never rerun. A design this conversation cannot read by id (computed in another conversation) is "
               "an arm {name, method, scenario} stated again from its numbers. The arms of a disease experiment are {name, method: "
               "\"patients.progression\", scenario} that differ only in treatment. Read with compare_status {experimentId}.",
}


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
                "lab": LAB_SHAPES,
            },
            "warnings": [],
            "next_actions": ["Call vcr_simulate with action shape and the kind you are about to write or queue."],
        }
    if kind not in JOB_KINDS:
        raise VcrPlatformError("vcr_simulate_payload_invalid", "kind must be one of: %s." % ", ".join(JOB_KINDS))
    control = _control_plane_shape(kind)
    if control is not None:
        return control
    if kind == "match_judge":
        # Not an engine method: the platform freezes the pairs from a selection, and nothing is stated in a scenario.
        return {
            "status": "success",
            "summary": "match_judge is built by the platform from a selection; there is no scenario.",
            "data": {"kind": kind, "method": "matching.judge", "builtByPlatform": True, "runStates": [], "keys": [],
                     "notes": ["One patient against trials: selection {subjectKey, registryIds, registry?, collection?, collectionRevision?}. "
                               "One protocol against patients: selection {protocolVersionId?, subjectKeys?} (the latest version and the whole roster when absent). "
                               "fit (default true) is the trial-level judgment of every pair; each person's best-ranked pairs are then judged clause by clause, as many as the deployment sets; "
                               "thinking is high or off. A collection named alone is the one in force. "
                               "The answer states the most it can cost before the work begins. A pair already judged for the same text and settings is not paid for twice. "
                               "Read the result back: vcr_read what candidate_trials with filter.subjectKey, or what matching with filter.protocolVersionId."]},
            "warnings": [],
            "next_actions": ["Start it with vcr_simulate action start, kind match_judge and a selection."],
        }
    if kind == "records_import":
        # Not an engine method and not started from a run: the platform takes uploads in when data_intake asks it to.
        return {
            "status": "success",
            "summary": "records_import is the platform's own job: it takes an upload in when vcr_write data_intake asks, and states no scenario.",
            "data": {"kind": kind, "method": "matching.import_records", "builtByPlatform": True, "runStates": [], "keys": [],
                     "notes": ["Many notes, a hospital's export, PDF and scans are taken in as records; what was taken in, skipped and why is in its receipt. "
                               "Read progress with vcr_read what=data_intake."]},
            "warnings": [],
            "next_actions": ["Use vcr_write what=data_intake (read contracts first); the import job is queued for you."],
        }
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
        # an object row (tauPrior) is only its keys; the note below says what it takes
        keys = [_row_line(by_path[name], by_path) for name in platform if name in by_path and by_path[name].get("type") != "object"]
        data["builtByPlatform"] = True
        data["runStates"] = list(platform)
        data["keys"] = keys
        if kind == "pool_evidence":
            notes.append("Use the evidence_pool tool: you name the parameter and the endpoint definition, never the numbers; the pooled values are this study's verified extractions.")
            notes.append("tauPrior (optional) is the Cochrane reference for how much studies of one comparison differ, so that two studies get a prediction interval: {kind: turner_2015, outcome, comparison} "
                         "for a binary outcome on the log odds ratio scale, {kind: turner_2015_generic}, or {kind: bartos_2023, effectScale: log_odds_ratio | log_risk_ratio | risk_difference | log_hazard_ratio}. "
                         "Say which prior you used and why that setting fits, and that it is a reference for such comparisons in general, not for this drug.")
        elif kind == "match_criteria":
            notes.append("Start it with an empty scenario: the platform freezes the newest protocol version's criteria and the facts written for the study.")
        else:
            notes.append("State only %s; the rates are explicit design assumptions, never recruitment records." % ", ".join(platform))
        data["notes"] = notes
        summary = "%s is built by the platform from the study; you state %s." % (kind, ", ".join(platform) if platform else "nothing")
    else:
        data["keys"] = [_row_line(row, by_path) for row in rows]
        if method.get("rules"):
            data["rules"] = [_rule_line(rule) for rule in method["rules"]]
        if method.get("gridCells"):
            notes.append("A grid has at most %s cells (designs x truths), and every cell is a valid scenario of its own." % method["gridCells"])
        if kind in DESIGN_POINTER_KINDS:
            notes.append(DESIGN_POINTER)
        if kind == "generate_progression":
            notes.append(PROGRESSION_POINTER)
        if kind in ("generate_patients", "generate_patients_continuous", "generate_patients_binary", "generate_patients_longitudinal"):
            notes.append(GENERATED_PATIENTS_POINTER)
        if kind == "literature_population":
            # On 2026-11-01 the run read this path's evidence bindings, saw no source to bind a pasted table to, and left for its own R.
            notes.append("A baseline table the person pasted, with no paper preserved to bind its numbers to, goes through generate_population with the "
                         "same numbers: the same engine and the same page, no bindings. Say the numbers are theirs and were not checked against a paper.")
        if notes:
            data["notes"] = notes
        data["examples"] = list(method.get("examples", []))
        summary = "The scenario of %s (method %s) reads %d keys." % (kind, method_id, len(rows))
    templates = method.get("templates") if platform is None else None
    if templates:
        # The smallest valid scenario of each common path: the facts of the research and the choices the question makes, nothing the
        # platform defaults. Its numbers are placeholders for the study's own.
        data["templates"] = [{"name": template["name"], "label": template["label"], "scenario": template["scenario"]} for template in templates]
    data["legend"] = ("path: type; required or optional (required whenever the key is read); default; read only when <condition> (the key is refused "
                      "when the condition does not hold); role. A path with [] is inside each item of a list. A key not listed is refused by its path. "
                      "role research_fact: only the research can give it; ask about it only if the answer would change the next computation, one "
                      "question at a time, and otherwise go on with a stated assumption. role defaultable: settle it yourself (a default is filled "
                      "and listed in applied, an optional key may be left out, a choice among words follows from the question) and say which "
                      "value you took; do not ask. An object has no role: its keys do.")
    next_actions = [
        "Write exactly these keys and no others; a number the engine computes (a result, a count, a measure) is never a key.",
        "Check a filled scenario without queueing it with vcr_simulate action validate (kind and scenario): it answers the defaults the platform "
        "would fill, the replicate count and any refusal by path, and does not wait, so you may start in the same turn.",
        "Then queue it with vcr_simulate action start, or write it as the object's configuration with vcr_write.",
    ]
    if kind in SOURCE_KINDS:
        # A median read in a paper went straight into the scenario in 6 of 6 live designs and the result page called it an assumption: the paper
        # rides on the same call.
        next_actions.append("A number you read in a paper (a control median, a hazard ratio, a rate) is tied to it in the same call, beside the scenario: "
                            'sources [{"field": "truth.controlMedian", "publication": "PMID 18650514", "quote": "<the sentence that prints the number>"}]. '
                            "The number is the one in the scenario; the result page then says it comes from the paper. A number of your own stays an assumption.")
    if kind in RECORD_KINDS:
        # Three of the four live conversations that did not enter the module for a cohort wrote their own script because they could not tell whether its rows could be handed to
        # the person as a file (2026-11-02: "I don't know if it writes a CSV I can access"). They can be read back.
        next_actions.append("The result keeps the generated rows. For a file the person asks for, the result page has 下载 CSV for the whole table: "
                            "give the page link the answer's resultEntry carries and say so. vcr_read what generated_records with filter.id = the "
                            "result's id returns the rows, at most 50 per call, for working with them yourself.")
    return {
        "status": "success",
        "summary": summary,
        "data": data,
        "warnings": [],
        "next_actions": next_actions,
    }


# The kinds whose complete example a conversation has been given, once: (session, kind). A refusal that is the first of its kind in a
# conversation carries one valid scenario to copy; the later ones carry the keys of the place they were refused and nothing more.
_EXAMPLED = set()


def _first_example(kind, method) -> str:
    """One complete, valid scenario of the kind (from the generated help), the first time a refusal of it is answered in this conversation."""
    context = _EXECUTION_CONTEXT.get()
    session = context.get("sessionId", "") if isinstance(context, dict) else ""
    if (session, kind) in _EXAMPLED:
        return ""
    examples = method.get("examples") if isinstance(method, dict) else None
    scenario = examples[0].get("scenario") if isinstance(examples, list) and examples and isinstance(examples[0], dict) else None
    if not isinstance(scenario, dict) or not scenario:
        return ""
    if len(_EXAMPLED) > 2000:
        _EXAMPLED.clear()
    _EXAMPLED.add((session, kind))
    return " A complete valid scenario of %s, to copy and change to this study's own numbers: %s" % (
        kind, json.dumps(scenario, ensure_ascii=False, separators=(",", ":")))


def refusal_hint(kind, issues: list) -> str:
    """The keys of the place a job was refused, from the same generated help, so the repair needs no second lookup.

    The first refusal of a kind in a conversation also carries a whole valid example of it: on 2026-11-01 a design comparison spent
    fourteen refused calls learning, key by key, what one example would have shown.
    """
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
    return "From the engine's schema for %s (method %s) -- %s. Every key and its range: vcr_simulate action shape, kind %s.%s" % (
        kind, method_id, " | ".join(lines), kind, _first_example(kind, method))


def simulate(arguments: dict) -> dict:
    action = arguments.get("action") or "start"
    if action not in SIMULATE_ACTIONS:
        raise VcrPlatformError("vcr_simulate_action_invalid", "action must be one of: %s." % ", ".join(SIMULATE_ACTIONS))
    if action == "shape":
        return shape(arguments)
    if action in LAB_ACTIONS:
        return lab(arguments, action)
    payload = {"action": action}
    if action in ("start", "validate"):
        kind = arguments.get("kind")
        if kind not in JOB_KINDS:
            raise VcrPlatformError("vcr_simulate_payload_invalid", "kind must be one of: %s." % ", ".join(JOB_KINDS))
        payload["kind"] = kind
        for key in ("scenario", "inputs", "seed", "replicates", "cpuSecondsLimit", "subjectId", "reconstructionResultId", "selection", "modelId", "modelVersion", "sources"):
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
        hint = refusal_hint(payload.get("kind"), error.issues) if action in ("start", "validate") else ""
        if hint:
            raise VcrPlatformError(error.code, "%s %s" % (error, hint), error.retryable, error.issues) from error
        raise
    if action == "validate":
        return _validate_answer(data, payload.get("kind"))
    if action in ("start", "status"):
        data = _wait_for_job(data)
    return _with_entry(_with_applied(_job_answer(data, action), data), data)


# What each lab action takes: the one object that names the work, or the id that reads or stops it. The keys inside a manifest are the
# lab's (`shape` with no kind answers them), not the scenario help's.
_LAB_INPUT = {"search": "manifest", "compare": "experiment", "search_status": "campaignId", "search_cancel": "campaignId", "compare_status": "experimentId"}


def lab(arguments: dict, action: str) -> dict:
    """``vcr_simulate`` lab actions: freeze a design search or a comparison of named designs, read it, stop it. Nothing is computed
    here: the platform evaluates every candidate on the engine, one unit at a time, and says why it stopped."""
    key = _LAB_INPUT[action]
    value = arguments.get(key)
    if action in ("search", "compare"):
        if not isinstance(value, dict) or not value:
            raise VcrPlatformError("vcr_simulate_payload_invalid", "%s is the %s object; action shape with no kind says what it holds." % (
                key, "frozen campaign" if action == "search" else "experiment of named arms and their comparison"))
    elif not isinstance(value, str) or not value:
        raise VcrPlatformError("vcr_simulate_payload_invalid", "%s is the id %s answered with." % (key, "search" if key == "campaignId" else "compare"))
    try:
        data = _post("simulate", {"action": action, key: value})
    except VcrPlatformError as error:
        if error.code in _absent_codes():
            return _module_absent(error, "design search", "queue")
        raise
    return _lab_answer(data, action)


def _lab_answer(data: dict, action: str) -> dict:
    stop = data.get("stop") if isinstance(data.get("stop"), dict) else None
    status = str(data.get("status") or "")
    ident = str(data.get("id") or data.get("campaignId") or data.get("experimentId") or "")
    running = status == "running" or (stop is None and data.get("kind") == "campaign" and status != "stopped")
    if action in ("search", "compare") or running:
        next_actions = [
            "The platform evaluates every candidate on the engine without you; do not wait for it in this turn and never run a status loop. Tell the "
            "researcher what was started, where it appears (the study's lab page) and how it is judged, then end the turn or go on with other work.",
            "Give no number of your own for any candidate: the numbers, bounds and verdicts are the engine's and are read back with %s." % (
                "search_status (campaignId)" if data.get("kind") == "campaign" or action.startswith("search") else "compare_status (experimentId)"),
        ]
    else:
        next_actions = [
            "Report the stop reason in the researcher's words, the best design with its final numbers and their error, which constraints were met, "
            "undecided or not met, and the budget used; cite the fields, never retyped numbers.",
        ]
        if any(isinstance(point, dict) and "againstReference" in point for arm in data.get("arms") or [] if isinstance(arm, dict)
               for point in arm.get("trajectory") or []):
            next_actions.append(PROGRESSION_DIFFERENCE_LINE)
        undecided = data.get("undecided") if isinstance(data.get("undecided"), dict) else None
        if undecided and undecided.get("advice"):
            next_actions.append(
                "The campaign stopped undecided: give the closest design and say what would decide it (undecided.advice) in your own sentence. The frozen "
                "constraint never changes and a point estimate never passes it: a lower analysis level or more replicates is a NEW campaign the researcher asks for.")
    return {
        "status": "success",
        "summary": "%s %s%s." % ("Design search" if data.get("kind") == "campaign" else "Design comparison", ident,
                               " is running" if running else (" stopped: %s" % stop.get("reason") if stop else " is read")) if ident else "Done.",
        "data": data, "warnings": [], "next_actions": next_actions,
    }


# How a simulated type I error is said wherever the platform judged it: the result's own typeOneError, or a design grid cell's.
TYPE_ONE_VERDICT_LINE = ("Say each type I error in the words of its verdict (data.typeOneError.text, a result's typeOneError.text, or a grid "
                         "cell's in diagnostics.cells), the platform's verdict on its conservative bound: \"not above\" only when that text says "
                         "so; never conclude it from the estimate, and give no interval of your own.")


# How the difference between two arms of a disease-progression run, or between two arms of a comparison, is said: the platform's own.
PROGRESSION_DIFFERENCE_LINE = ("The difference between arms at each visit is the platform's: diagnostics.progression.curves[].difference (treated less "
                               "untreated) in a run, trajectory[].againstReference (an arm less the reference arm) in a comparison, both calculated "
                               "exactly in the typical study; the simulated difference at the analysis visit carries its Monte Carlo SE. Cite them; "
                               "never subtract the means yourself.")


def _progression_differences(result) -> bool:
    """Whether a result is a progression run whose curves carry the platform's differences between its arms."""
    if not isinstance(result, dict) or result.get("kind") != "progression_simulation":
        return False
    progression = (result.get("diagnostics") or {}).get("progression") if isinstance(result.get("diagnostics"), dict) else None
    curves = progression.get("curves") if isinstance(progression, dict) else None
    return any(isinstance(curve, dict) and isinstance(curve.get("difference"), dict) for curve in curves or [])


def _type_one_verdicts(holder) -> bool:
    """Whether an answer's object carries a type I verdict: its own, or one of its design grid cells'."""
    if not isinstance(holder, dict):
        return False
    if isinstance(holder.get("typeOneError"), dict) and isinstance(holder["typeOneError"].get("text"), str):
        return True
    diagnostics = holder.get("diagnostics") if isinstance(holder.get("diagnostics"), dict) else {}
    return any(isinstance(cell, dict) and isinstance(cell.get("typeOneError"), dict) for cell in diagnostics.get("cells") or [])


def _validate_answer(data: dict, kind) -> dict:
    """The answer of ``action: validate``: what the platform would do with this scenario, said without queueing it and without waiting.

    A valid scenario comes back with the defaults the platform would fill in (to be said in the reply with their values, as after a
    start), the replicate count and what set it, and the job's cost class; a refused one comes back with its issues by path and the
    keys of the place it was refused. Either way nothing was queued, and the run may go on to start in the same turn.
    """
    if data.get("checked") is False:
        return {
            "status": "success",
            "summary": "validate does not check %s: the platform completes its scenario when it starts." % (kind or "this kind"),
            "data": data,
            "warnings": [str(data.get("message") or "The platform builds this scenario itself.")],
            "next_actions": ["Start it with action start; a field that is refused comes back by its path."],
        }
    issues = data.get("issues") if isinstance(data.get("issues"), list) else []
    if data.get("valid") is False:
        hint = refusal_hint(kind, [issue for issue in issues if isinstance(issue.get("code"), str) and isinstance(issue.get("field"), str)])
        return {
            "status": "warning",
            "summary": "The scenario is not valid as written (%d issue%s); nothing was queued." % (len(issues), "" if len(issues) == 1 else "s"),
            "data": data,
            "warnings": [_issue_line(issue) for issue in issues[:20]],
            "next_actions": [line for line in (
                "Fix exactly the fields named, then validate again or start; do not ask the researcher about a field the schema defaults.",
                hint,
            ) if line],
        }
    actions = ["Nothing was queued and nothing was waited on: start with the same scenario in this turn when it is what the study intends."]
    actions.extend(_source_lines(data))
    if isinstance(data.get("applied"), list) and data["applied"]:
        actions.append("data.applied lists what the platform will fill in because the scenario states none of it. Say each with its value in your reply; "
                       "one that is not what the study intends is stated in the scenario before it is started.")
    if isinstance(data.get("normalized"), list) and data["normalized"]:
        actions.append("data.normalized lists keys that only described what the method does anyway; the platform leaves them out and they change nothing.")
    return {
        "status": "success",
        "summary": "The scenario is valid; nothing was queued.",
        "data": data,
        "warnings": [],
        "next_actions": actions,
    }


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
    if _EXECUTION_CONTEXT.get():
        return first  # Native async completion resumes the originating conversation.
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


def _with_applied(answer: dict, data: dict) -> dict:
    """The answer with the one action a list of applied defaults adds: say them.

    `data.applied` (field and value) is what the platform filled in because the scenario stated none -- a dropout of 0, an alpha of
    0.025. They are premises of the result the researcher reads, so the reply names them with their values; one that is not what the
    study intends is stated in the scenario and the job queued again.
    """
    applied = data.get("applied") if isinstance(data, dict) else None
    lines = []
    if isinstance(applied, list) and applied:
        lines.append("data.applied lists what the platform filled in because the scenario did not state it. Say each with its value in your "
                     "reply; one that is not what the study intends is stated in the scenario and the job queued again.")
    if isinstance(data, dict) and isinstance(data.get("normalized"), list) and data["normalized"]:
        lines.append("data.normalized lists keys of your scenario that only described what the method does anyway; the platform left them out and "
                     "they changed nothing. Leave them out next time.")
    lines.extend(_source_lines(data))
    return {**answer, "next_actions": [*answer.get("next_actions", []), *lines]} if lines else answer


def _source_lines(data: dict) -> list:
    """Report source binding without treating model interpretation as observed data."""
    sources = data.get("sources") if isinstance(data, dict) else None
    if not isinstance(sources, list) or not sources:
        return []
    kept = [entry for entry in sources if isinstance(entry, dict) and entry.get("state") == "assumption"]
    line = ("data.sources says, for each paper you named, whether its number is now tied to the paper (carried) or stays an assumption, and why. "
            "In the reply, say which premises come from which paper and which are assumptions.")
    if kept:
        line += " Fix the entries that stayed assumptions by their reason and send them again with the next start, or leave the paper out."
    return [line]


def _with_entry(answer: dict, data: dict) -> dict:
    """The answer with the one action a result entry adds: give the researcher the platform's own link, once, at the end of the reply.

    The entry (`data.resultEntry`: study, tab, label, and the absolute address when the deployment has one) is built by the control
    plane. Nothing is added to the answer when it carries none, and the model never writes an address of its own: a relative one
    would resolve to the conversation, not to the application.
    """
    entry = data.get("resultEntry") if isinstance(data, dict) else None
    if not isinstance(entry, dict) or not isinstance(entry.get("label"), str) or not entry["label"]:
        return answer
    url = entry.get("url")
    if isinstance(url, str) and url:
        line = ("data.resultEntry is where the researcher reads this. Once, at the end of your reply, give it as this link, "
                "copied as it is: [%s](%s). Never write an address yourself." % (entry["label"], url))
    else:
        line = ("data.resultEntry names the page where the researcher reads this (%s). Once, at the end of your reply, say that page by "
                "name. Never write an address yourself." % entry["label"])
    return {**answer, "next_actions": [*answer.get("next_actions", []), line]}


MATCH_BATCH_KINDS = ("match_judge", "records_import")


def _job_read_back(data: dict) -> str:
    """Where a finished job's answer is read: `results` holds a judging job's counts, not its verdicts."""
    if data.get("kind") == "match_judge":
        return "vcr_read (what: candidate_trials with filter.subjectKey, or what: matching with filter.protocolVersionId)"
    return "vcr_read (what: results)"


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
                "Do not work out the same quantity yourself meanwhile and give no number of your own for it: the number the researcher "
                "is given is the engine's. A small job is usually finished by the time you have written your reply, so look once more "
                "with status just before you answer and use the result if it is there; one more look is not a loop.",
                "In a later turn, when asked, read the result with %s." % _job_read_back(data),
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
    actions = ["Read the result with %s and cite the fields, never retyped numbers." % _job_read_back(data)]
    result = data.get("result") if isinstance(data.get("result"), dict) else {}
    if _type_one_verdicts(data) or _type_one_verdicts(result):
        # Live D8 (2026-11-07): 2.53% +/- 0.11% was headed "the simulation supports not exceeding 2.5%"; its upper bound is 2.75%.
        actions.append(TYPE_ONE_VERDICT_LINE)
    if _progression_differences(result):
        # Live D6 (2026-11-07): three Alzheimer arms were compared by a reply that subtracted the arms' means itself.
        actions.append(PROGRESSION_DIFFERENCE_LINE)
    if result.get("conclusion") == "limited" and data.get("kind") in MATCH_BATCH_KINDS:
        actions.insert(0, "This job stopped before the end: say how far it got and what is left, and that starting the same selection again goes on from there.")
        return {
            "status": "warning",
            "summary": "Job %s stopped before the end; what was done is kept." % job_id,
            "data": data,
            "warnings": [],
            "next_actions": actions,
        }
    if result.get("kind") in ("trial_scenario", "design_grid"):
        # A design is chosen by the researcher: the reply recommends one in a sentence and says which bound decided it.
        actions.append("When designs are compared, close with one sentence of recommendation that says which constraint decided it (the type I error "
                       "bound, the target power, the sample size or the duration), from the numbers in the result; the platform does not pick the design.")
        # Live D6 (2026-11-07): a simulated power of 83.8% (MCSE 0.37%) was given a "95% interval 81.8-85.8%" of the model's own.
        actions.append("A simulated number is said with the Monte Carlo SE its measure carries (83.8% ± 0.37%); work out no interval, sensitivity or "
                       "derived figure of your own: a further number is another start.")
    return {
        "status": "success",
        "summary": "Job %s succeeded." % job_id if action != "cancel" else "Job %s is cancelled." % job_id,
        "data": data,
        "warnings": [],
        "next_actions": actions,
    }


def registry_record(arguments: dict) -> dict:
    registry_id = arguments.get("registryId")
    if not isinstance(registry_id, str) or not registry_id.strip():
        raise VcrPlatformError("vcr_request_invalid", "registryId is the trial's registration number.")
    payload = {"what": "trial_registry_record", "filter": {"registryId": registry_id.strip()}}
    registry = arguments.get("registry")
    if isinstance(registry, str) and registry.strip():
        payload["filter"]["registry"] = registry.strip()
    collection = arguments.get("collection")
    revision = arguments.get("collectionRevision")
    if collection is not None or revision is not None:
        if not isinstance(collection, str) or not collection.strip() or not isinstance(revision, str) or not re.fullmatch(r"[a-f0-9]{64}", revision):
            raise VcrPlatformError("vcr_request_invalid", "A frozen record needs collection and collectionRevision from candidates.")
        payload["filter"]["collection"] = collection.strip()
        payload["filter"]["collectionRevision"] = revision
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
                else ["Report that the selected collection could not be read."] if collection
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
        "data": {**record, **({"collection": data["collection"]} if data.get("collection") else {}), **({"clauses": data["clauses"]} if data.get("clauses") else {})},
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
    tau_prior = arguments.get("tauPrior")
    if tau_prior is not None:
        if not isinstance(tau_prior, dict) or tau_prior.get("kind") not in TAU_PRIOR_KINDS:
            raise VcrPlatformError("vcr_simulate_payload_invalid", "tauPrior.kind is one of: %s." % ", ".join(TAU_PRIOR_KINDS))
        scenario["tauPrior"] = tau_prior
    return simulate({
        "action": "start",
        "kind": "pool_evidence",
        "subjectId": parameter.strip()[:120],
        "scenario": scenario,
    })
