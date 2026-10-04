#!/usr/bin/env python3
"""What a project's datasets mean, through the server's gateway, and the deterministic checks against it.

One tool, four actions, shared by the two capabilities that start from a researcher's data
(`dataset-research-scoping`, `statistical-analysis`) so that the meaning one run establishes is the
meaning the next run starts from:

- ``read``: the recorded interpretation of this project's datasets -- per table the observation unit
  and the keys that identify a patient and one observation, per variable its definition, type, unit,
  code system, allowed values, missingness, role and measurement time, the population and time
  window, the joins, the recorded transformations, the last check -- each fact with **who vouches
  for it**: the researcher (their words are kept), a data dictionary they supplied (the file is
  named) or the model (what it was read from). It also says whether the files still are the bytes
  the meaning was read from.
- ``write``: record what you establish, with its basis. A researcher's correction ("这一列的单位是
  mmol/L") is written as ``researcher_confirmed`` with their words and is never overwritten by a
  later inference -- a weaker statement that disagrees comes back as ``kept_stronger`` and stays
  beside the fact as a contested statement. ``files`` binds the exact versions (the tool hashes
  them); ``allowedValues: "observed"`` copies a coded column's values from the file instead of
  typing them.
- ``check``: profile the files against the record and report, as named outcomes with counts and the
  rows concerned, what drifted (columns added, removed or renamed, a changed type, unit, code list,
  scale or missingness), observations repeated by the declared key, joins that are not the
  multiplicity they were declared with, denominators that changed between steps, and predictors
  measured after the outcome window opens. Nothing is withheld or stopped by a finding, and a check
  that could not run says why instead of reading as clean.
- ``transform``: record a derived variable or a filter with its inputs and the hash of the code that
  made it, so a repeat analysis applies the same transformation or is told what changed.

The meaning lives in the control plane's product ledger; the rows never leave the workspace. With the
module off, ``read`` and ``write`` and ``transform`` answer a warning the run reads and goes on from,
and ``check`` still runs on what the call itself declares.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import PurePosixPath

import data_semantics_checks as checks
import public_sources

ACTIONS = ("read", "write", "check", "transform")
BASES = ("researcher_confirmed", "dictionary_stated", "model_inferred")
# The domain's closed vocabularies (`packages/domain/src/dataSemantics.mjs`; `test_data_semantics.py` holds these equal).
VARIABLE_TYPES = ("integer", "number", "date", "text")
VARIABLE_ROLES = ("identifier", "time", "exposure", "outcome", "covariate", "other")
VALUE_SOURCES = ("observed", "extracted", "calculated", "imputed")
MISSING_REASONS = ("not_measured", "not_recorded", "not_shared", "restricted_in_trial", "out_of_window", "pending_result", "not_applicable")
TIME_KINDS = ("occurred_at", "recorded_at", "visible_at")
JOIN_CARDINALITIES = ("one_to_one", "one_to_many", "many_to_one", "many_to_many")
TRANSFORM_KINDS = ("derive", "filter", "join", "recode", "dedupe", "aggregate", "other")
STEP_KINDS = ("filter", "dedupe", "recode", "derive", "join", "aggregate", "other")
ERROR_CODES = (
    "semantics_disabled", "semantics_unconfigured", "semantics_unavailable", "semantics_gateway_unreachable",
    "semantics_gateway_token_missing", "semantics_gateway_token_invalid", "semantics_rate_limited", "semantics_response_invalid",
    "semantics_response_too_large", "semantics_upstream_error", "semantics_request_invalid", "semantics_request_too_large",
    "semantics_dataset_invalid", "semantics_asset_not_found", "semantics_asset_too_large", "semantics_too_many_datasets",
    "semantics_revision_conflict",
)
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
TIMEOUT_SECONDS = 20
READ_VARIABLE_CAP = 150
FINDINGS_SHOWN = 60
GATEWAY_CODE = re.compile(r"^semantics_[a-z0-9_]{1,60}$")
DATASET_ID = r"^[a-z0-9][a-z0-9_-]{0,63}$"
# The gateway's own refusals of the conversation's credential: the run cannot fix them by changing what it sent.
AUTH_CODES = ("semantics_gateway_token_invalid", "semantics_gateway_token_missing", "semantics_unconfigured")
# What a run is told when the recorded meaning is not there: it goes on from the files.
ABSENT_CODES = ("semantics_disabled", "semantics_asset_not_found")


class DataSemanticsError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable

    def stop_reason(self) -> str:
        if self.code in AUTH_CODES:
            return "unsupported"
        if self.code.endswith("_invalid") or self.code in ("semantics_request_too_large", "semantics_asset_too_large", "semantics_too_many_datasets"):
            return "invalid_input"
        return "retry" if self.retryable else "unsupported"


# --- the tool's description --------------------------------------------------

def tool_definitions():
    columns = {"type": "array", "minItems": 1, "maxItems": 6, "items": {"type": "string", "minLength": 1, "maxLength": 128}}
    side = {"type": "object", "properties": {"table": {"type": "string", "minLength": 1, "maxLength": 120}, "columns": columns}, "required": ["table", "columns"], "additionalProperties": False}
    return [{
        "name": "dataset_semantics",
        "description": (
            "Remember and check what the researcher's data MEANS, so a later analysis of the same dataset in this project starts from the "
            "same interpretation instead of inferring it again. Rows never leave the workspace; only meaning, counts and row numbers do. "
            "action=read: the recorded interpretation (tables, observation unit, patient and observation keys, per-variable definition, "
            "type, unit, code system, allowed values, missingness, role, measurement time; population, time window, joins, "
            "transformations, last check) with who vouches for each fact -- researcher_confirmed (their words are kept), "
            "dictionary_stated (the file is named) or model_inferred (what it was read from) -- and whether the files still are the "
            "bytes it was read from. Start here before profiling a dataset the project may already hold. "
            "action=write: record what you establish, one basis per call (basis + statement | statedIn | inferredFrom). Write what the "
            "researcher says as researcher_confirmed with their own words; it is never overwritten by a later inference (a weaker "
            "statement that disagrees comes back kept_stronger and is kept beside it). files=[{path}] binds the exact file versions "
            "(the tool hashes them); allowedValues:\"observed\" copies a coded column's values from the file. A refused item comes back "
            "in issues and the rest is written. "
            "action=check: profile files (default: the recorded paths) against the record and report named outcomes with counts and "
            "the rows concerned -- drift (source_changed, column_renamed_candidate, unit_changed, possible_unit_change, type_changed, "
            "new_codes, distribution_shift, missingness_shift ...), duplicate_exact / duplicate_conflicting by the declared "
            "observationKey, join_cardinality_violation / join_orphans / join_key_invalid, denominator_increase / decrease / changed "
            "between steps, temporal_leakage (a predictor measured after leakage.cutoff), transformation_code_changed. A finding is "
            "information for the analysis to handle and states nothing is removed or chosen for you; not_checked says why a check could "
            "not run -- it is never a clean result. A rename is only a candidate: confirm it with write (variable aliases). "
            "action=transform: record a derived variable or filter with its inputs and the code file that makes it; the answer says "
            "whether it is new, the same, or what changed since the recorded version."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": list(ACTIONS)},
                "datasetId": {"type": "string", "minLength": 1, "maxLength": 64, "pattern": DATASET_ID,
                              "description": "One dataset of the project (lowercase letters, digits, - _). Omitted: read lists them; check and write use the one the files belong to."},
                "table": {"type": "string", "minLength": 1, "maxLength": 120, "description": "read: only this table."},
                # write
                "title": {"type": "string", "minLength": 1, "maxLength": 120},
                "basis": {"type": "string", "enum": list(BASES), "description": "write: who vouches for every fact in this call."},
                "statement": {"type": "string", "minLength": 1, "maxLength": 400, "description": "basis researcher_confirmed: what the researcher said, in their words."},
                "statedIn": {"type": "string", "minLength": 1, "maxLength": 512, "description": "basis dictionary_stated: the data dictionary file (workspace-relative); the tool hashes it."},
                "inferredFrom": {"type": "array", "minItems": 1, "maxItems": 5, "items": {"type": "string", "minLength": 1, "maxLength": 200},
                                 "description": "basis model_inferred: what the inference was read from (column names, values in data-profile.json ...)."},
                "population": {"type": "string", "minLength": 1, "maxLength": 400},
                "timeWindow": {"type": "object", "properties": {"start": {"type": "string"}, "end": {"type": "string"}, "note": {"type": "string", "maxLength": 200}}, "additionalProperties": False},
                "tables": {"type": "array", "maxItems": 20, "items": {"type": "object", "properties": {
                    "name": {"type": "string", "minLength": 1, "maxLength": 120},
                    "observationUnit": {"type": "string", "maxLength": 200, "description": "e.g. one row per patient visit."},
                    "subjectKey": columns, "observationKey": {**columns, "description": "Columns that together identify ONE observation (patient + visit): duplicates are judged by them."}},
                    "required": ["name"], "additionalProperties": False}},
                "variables": {"type": "array", "maxItems": 100, "items": {"type": "object", "properties": {
                    "table": {"type": "string", "minLength": 1, "maxLength": 120}, "name": {"type": "string", "minLength": 1, "maxLength": 128},
                    "definition": {"type": "string", "maxLength": 400}, "type": {"type": "string", "enum": list(VARIABLE_TYPES)},
                    "unit": {"description": "A unit string, or null when the variable has none."},
                    "codeSystem": {"type": "string", "maxLength": 40},
                    "allowedValues": {"description": "[{code,label?}] or bare codes, or \"observed\" to copy the column's values."},
                    "range": {"type": "array", "minItems": 2, "maxItems": 2, "items": {"type": "number"}},
                    "missingness": {"type": "object", "properties": {"tokens": {"type": "array", "maxItems": 10, "items": {"type": "string"}}, "reason": {"type": "string", "enum": list(MISSING_REASONS)}}, "additionalProperties": False},
                    "role": {"type": "string", "enum": list(VARIABLE_ROLES)},
                    "measuredAt": {"type": "object", "properties": {"column": {"type": "string"}, "timeKind": {"type": "string", "enum": list(TIME_KINDS)}}, "required": ["column"], "additionalProperties": False},
                    "valueSource": {"type": "string", "enum": list(VALUE_SOURCES), "description": "How the column's values came to be (observed / extracted / calculated / imputed)."},
                    "aliases": {**columns, "description": "Former names of this column: a renamed column keeps what is known about it."}},
                    "required": ["table", "name"], "additionalProperties": False}},
                "joins": {"type": "array", "maxItems": 20, "items": {"type": "object", "properties": {
                    "left": side, "right": side, "cardinality": {"type": "string", "enum": list(JOIN_CARDINALITIES), "description": "Rows of the left table per key, then of the right."}},
                    "required": ["left", "right"], "additionalProperties": False}, "description": "write: declare joins. check: also check these (cardinality optional)."},
                "files": {"type": "array", "maxItems": 20, "items": {"type": "object", "properties": {
                    "path": {"type": "string", "minLength": 1, "maxLength": 512}, "table": {"type": "string", "maxLength": 120, "description": "The recorded table this file is the new version of, when its name differs."}},
                    "required": ["path"], "additionalProperties": False}, "description": "write: bind these exact versions. check: the files to check."},
                # check
                "complete": {"type": "boolean", "description": "check: the files are the whole delivery, so a recorded table with no file is reported table_removed."},
                "observationKeys": {"type": "object", "description": "check: {table: [columns]} observation keys to use in addition to the recorded ones."},
                "subjectKeys": {"type": "object", "description": "check: {table: [columns]} subject keys likewise."},
                "leakage": {"type": "object", "properties": {
                    "cutoff": {"type": "object", "properties": {"table": {"type": "string"}, "column": {"type": "string"}}, "required": ["table", "column"], "additionalProperties": False,
                               "description": "The column holding when the outcome window opens (or the outcome time itself), per subject."},
                    "subjectColumns": columns,
                    "predictors": {"type": "array", "maxItems": 50, "items": {"type": "object", "properties": {
                        "table": {"type": "string"}, "column": {"type": "string"}, "timeColumn": {"type": "string"}}, "required": ["column"], "additionalProperties": False},
                        "description": "Default: recorded covariates and exposures that have a measuredAt column."}}, "additionalProperties": False},
                "steps": {"type": "array", "maxItems": 30, "items": {"type": "object", "properties": {
                    "label": {"type": "string", "minLength": 1, "maxLength": 80}, "kind": {"type": "string", "enum": list(STEP_KINDS)},
                    "table": {"type": "string"}, "path": {"type": "string"}, "rows": {"type": "integer", "minimum": 0}, "subjects": {"type": "integer", "minimum": 0},
                    "subjectColumns": columns}, "required": ["label"], "additionalProperties": False},
                    "description": "check: the analysis's steps in order, each measured from a file (table or path) or reported (rows, subjects), to size every exclusion."},
                # transform
                "transformation": {"type": "object", "properties": {
                    "name": {"type": "string", "minLength": 1, "maxLength": 64}, "kind": {"type": "string", "enum": list(TRANSFORM_KINDS)},
                    "description": {"type": "string", "maxLength": 300},
                    "inputs": {"type": "array", "minItems": 1, "maxItems": 10, "items": {"type": "object", "properties": {
                        "table": {"type": "string"}, "columns": {"type": "array", "maxItems": 20, "items": {"type": "string"}}}, "required": ["table"], "additionalProperties": False}},
                    "output": {"type": "object", "properties": {"table": {"type": "string"}, "column": {"type": "string"}}, "additionalProperties": False},
                    "codePath": {"type": "string", "maxLength": 512, "description": "The script that does it (workspace-relative); the tool hashes it."},
                    "parameters": {"type": "object"}}, "required": ["name", "kind", "inputs"], "additionalProperties": False},
            },
            "required": ["action"],
            "additionalProperties": False,
        },
    }]


# --- the gateway -------------------------------------------------------------

def _gateway():
    base = os.environ.get("EVIMED_SEMANTICS_GATEWAY_URL", "").strip().rstrip("/")
    if not base:
        raise DataSemanticsError(
            "semantics_disabled",
            "Recorded data meaning is not available in this conversation (the deployment has it off). Go on from the files, and keep the "
            "interpretation you establish in your own notes in the workspace.",
        )
    try:
        settings = public_sources._gateway_settings()  # noqa: SLF001 - one token, one owner
    except public_sources.PublicSourceError as error:
        raise DataSemanticsError("semantics_unconfigured", "The managed gateway token is unavailable.") from error
    if settings is None:
        raise DataSemanticsError("semantics_unconfigured", "The managed gateway token is unavailable.")
    return base, settings[1]


def _post(operation: str, payload: dict) -> dict:
    base, token = _gateway()
    request = urllib.request.Request(
        "%s/%s" % (base, operation), data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"accept": "application/json", "authorization": "Bearer %s" % token, "content-type": "application/json",
                 "user-agent": "EviMed-Research/1.2 (runtime dataset semantics)"},
        method="POST",
    )
    try:
        with public_sources._OPENER.open(request, timeout=TIMEOUT_SECONDS) as response:  # noqa: SLF001
            body = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        code, message = "", ""
        try:
            parsed = json.loads(error.read(64 * 1024).decode("utf-8", "replace"))
            code = parsed.get("code", "") if isinstance(parsed, dict) else ""
            message = parsed.get("error", "") if isinstance(parsed, dict) else ""
        except Exception:  # noqa: BLE001 - the status is the finding, not the parse
            code = ""
        # Only the gateway's own words reach the run.
        if not isinstance(code, str) or not GATEWAY_CODE.match(code):
            code = "semantics_upstream_error"
        if not isinstance(message, str) or not message.strip() or len(message) > 400:
            message = "The data-semantics gateway returned HTTP %d." % error.code
        raise DataSemanticsError(code, message, retryable=error.code in (429, 502, 503, 504) and code not in ABSENT_CODES) from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise DataSemanticsError("semantics_gateway_unreachable", "The data-semantics gateway is unreachable.", retryable=True) from error
    if len(body) > MAX_RESPONSE_BYTES:
        raise DataSemanticsError("semantics_response_too_large", "The answer exceeded the client limit.")
    try:
        parsed = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise DataSemanticsError("semantics_response_invalid", "The gateway returned a non-JSON answer.") from error
    data = parsed.get("data") if isinstance(parsed, dict) else None
    if not isinstance(data, dict):
        raise DataSemanticsError("semantics_response_invalid", "The gateway returned no data.")
    return data


def _workspace() -> str:
    raw = os.environ.get("OPEN_SCIENCE_WORKSPACE_DIR", "").strip()
    if not raw or not os.path.isabs(raw) or "\0" in raw:
        raise DataSemanticsError("semantics_request_invalid", "The managed project workspace is unavailable, so no file can be read.")
    return raw


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _asset_or_none(dataset_id):
    """(asset, why not): the stored asset in full for one dataset, or the project's list when none is named.

    A dataset nobody has written yet is `(None, None)`; a module that is off for this deployment is
    `(None, the error)`, so a caller can tell "nothing recorded" from "recording is not available".
    """
    try:
        if dataset_id:
            return _post("read", {"datasetId": dataset_id}).get("dataset"), None
        return _post("read", {}).get("datasets") or [], None
    except DataSemanticsError as error:
        if error.code == "semantics_asset_not_found":
            return (None if dataset_id else []), None
        if error.code in ABSENT_CODES:
            return None, error
        raise


# --- compact views for the model ---------------------------------------------

def _fact_view(fact: dict) -> dict:
    view = {"value": fact["value"], "basis": fact["basis"]}
    for key in ("statement", "statedIn", "inferredFrom"):
        if key in fact:
            view[key] = fact[key]
    if fact.get("supersedes"):
        view["replaced"] = fact["supersedes"]["value"]
    if fact.get("contested"):
        view["contested"] = [{"value": c["value"], "basis": c["basis"]} for c in fact["contested"]]
    return view


def _asset_view(dataset: dict, workspace: str | None, only_table=None) -> tuple:
    asset = dataset["asset"]
    bindings = {b["table"]: b for b in asset.get("bindings", [])}
    tables, shown, truncated = [], 0, False
    for table in asset.get("tables", []):
        if only_table and table["name"] != only_table:
            continue
        binding = bindings.get(table["name"])
        entry = {"name": table["name"]}
        if binding:
            entry["boundTo"] = {"path": binding["path"], "sha256": binding["sha256"], "rows": binding["rows"], "columns": [c["name"] for c in binding.get("columns", [])]}
            if workspace:
                try:
                    current = checks.file_sha256(workspace, binding["path"], checks.MAX_BYTES)
                    entry["boundTo"]["now"] = "same_bytes" if current == binding["sha256"] else "bytes_changed"
                except checks.TableError:
                    entry["boundTo"]["now"] = "file_not_found"
        for facet, fact in table.get("facts", {}).items():
            entry[facet] = _fact_view(fact)
        variables = {}
        for variable in table.get("variables", []):
            if shown >= READ_VARIABLE_CAP:
                truncated = True
                break
            variables[variable["name"]] = {facet: _fact_view(fact) for facet, fact in variable.get("facts", {}).items()}
            shown += 1
        entry["variables"] = variables
        tables.append(entry)
    view = {
        # The digest is a handle a run cites ("I used interpretation 3f9a…"); twelve characters name it.
        "datasetId": asset["datasetId"], "title": asset.get("title"), "revision": dataset["revision"], "interpretation": dataset["interpretation"][:12],
        "summary": dataset["summary"], "tables": tables,
    }
    for facet, fact in asset.get("facts", {}).items():
        view[facet] = _fact_view(fact)
    if asset.get("joins"):
        view["joins"] = [{"id": j["id"], **{facet: _fact_view(fact) for facet, fact in j.get("facts", {}).items()}} for j in asset["joins"]]
    if asset.get("transformations"):
        view["transformations"] = [{"name": t["name"], "version": t["version"], "kind": t["kind"], "inputs": t["inputs"], "output": t.get("output"),
                                    "code": t.get("code"), "parameters": t.get("parameters"), "description": t.get("description")} for t in asset["transformations"]]
    if asset.get("denominators"):
        view["denominators"] = asset["denominators"]
    if asset.get("lastCheck"):
        check = asset["lastCheck"]
        view["lastCheck"] = {"checkedAt": check["checkedAt"], "summary": check["summary"],
                             "findings": [{"outcome": f["outcome"], "subject": f["subject"], "count": f.get("count")} for f in check["findings"][:20]]}
    if asset.get("bindingHistory"):
        view["earlierVersions"] = asset["bindingHistory"][-5:]
    return view, truncated


# --- actions -----------------------------------------------------------------

def _need(arguments: dict, allowed: tuple, action: str):
    extra = sorted(set(arguments) - set(allowed) - {"action"})
    if extra:
        raise DataSemanticsError("semantics_request_invalid", "%s does not take: %s." % (action, ", ".join(extra)))


def _absent_answer(error: DataSemanticsError, what: str) -> dict:
    return {
        "status": "warning",
        "summary": "No recorded meaning is available, so %s." % what,
        "data": {"available": False, "code": error.code},
        "warnings": [str(error)],
        "next_actions": ["Go on from the files: infer what you need, say what you assumed, and keep the interpretation in the workspace."],
    }


def read(arguments: dict) -> dict:
    _need(arguments, ("datasetId", "table"), "read")
    workspace = os.environ.get("OPEN_SCIENCE_WORKSPACE_DIR", "").strip() or None
    dataset_id = arguments.get("datasetId")
    found, absent = _asset_or_none(dataset_id)
    if absent:
        return _absent_answer(absent, "read the dataset's meaning from the files again")
    if dataset_id:
        if not found:
            return {"status": "warning", "summary": "Nothing is recorded for dataset %s." % dataset_id, "data": {"datasets": []},
                    "warnings": ["No meaning has been written for %s." % dataset_id], "next_actions": ["Profile the data and write what you establish (action=write)."]}
        view, truncated = _asset_view(found, workspace, arguments.get("table"))
        warnings = ["Only the first %d variables are shown; read one table at a time with table." % READ_VARIABLE_CAP] if truncated else []
        return _read_answer(view, warnings)
    datasets = found or []
    if not datasets:
        return {"status": "success", "summary": "This project has no recorded dataset meaning yet.", "data": {"datasets": []}, "warnings": [],
                "next_actions": ["Profile the data, then write the observation unit, keys, units, codes and population you establish, with their basis."]}
    if len(datasets) == 1:
        full, _absent = _asset_or_none(datasets[0]["datasetId"])
        if full:
            view, truncated = _asset_view(full, workspace, arguments.get("table"))
            return _read_answer(view, ["Only the first %d variables are shown; read one table at a time with table." % READ_VARIABLE_CAP] if truncated else [])
    return {"status": "success", "summary": "This project records %d datasets; read one with datasetId." % len(datasets),
            "data": {"datasets": datasets}, "warnings": [], "next_actions": ["Read the dataset you are working on with datasetId."]}


def _read_answer(view: dict, warnings: list) -> dict:
    summary = view["summary"]
    changed = [t["name"] for t in view["tables"] if t.get("boundTo", {}).get("now") in ("bytes_changed", "file_not_found")]
    notes = []
    if changed:
        notes.append("The files of %s are not the bytes this meaning was read from: run action=check on them before relying on it." % ", ".join(changed))
    if view.get("lastCheck") and view["lastCheck"]["summary"]["attention"]:
        notes.append("The last check of this dataset had %d finding(s) that wanted a decision." % view["lastCheck"]["summary"]["attention"])
    return {
        "status": "warning" if (warnings or changed) else "success",
        "summary": "Recorded meaning of %s: %d facts (%d researcher-confirmed, %d from a dictionary, %d inferred by the model) over %d tables." % (
            view["datasetId"], summary["facts"], summary["researcherConfirmed"], summary["dictionaryStated"], summary["modelInferred"], summary["tables"]),
        "data": {"dataset": view}, "warnings": warnings + notes,
        "next_actions": ["Use researcher_confirmed and dictionary_stated facts as given; treat model_inferred ones as hypotheses to confirm against the data, "
                         "and write a correction the researcher makes as researcher_confirmed with their words."],
    }


def _expand_files(arguments: dict, workspace: str, declared_tables: dict):
    """The bindings of the files named, the tables read, and what could not be read."""
    bindings, tables, problems = [], {}, []
    for entry in arguments.get("files") or []:
        try:
            read_tables = checks.read_tables(workspace, entry["path"])
        except checks.TableError as error:
            problems.append({"path": entry["path"], "reason": error.reason, "message": str(error)})
            continue
        for table in read_tables:
            name = entry.get("table") if entry.get("table") and len(read_tables) == 1 else table.name
            if name in tables:
                problems.append({"path": entry["path"], "reason": "table_name_conflict", "message": "%s is already the name of another file's table in this call; give one of them a table name." % name})
                continue
            table.name = name
            tables[name] = table
            declared = {"variables": declared_tables.get(name, {}).get("variables", {}), "identifierColumns": declared_tables.get(name, {}).get("identifierColumns", set())}
            bindings.append(checks.binding_of(table, declared))
    return bindings, tables, problems


def write(arguments: dict) -> dict:
    allowed = ("datasetId", "title", "basis", "statement", "statedIn", "inferredFrom", "population", "timeWindow", "tables", "variables", "joins", "files")
    _need(arguments, allowed, "write")
    workspace = os.environ.get("OPEN_SCIENCE_WORKSPACE_DIR", "").strip()
    dataset_id = arguments.get("datasetId") or _default_dataset_id(arguments)
    if not dataset_id:
        raise DataSemanticsError("semantics_dataset_invalid", "datasetId is required (lowercase letters, digits, - _) when there is no file to name it after.")
    local_issues = []
    patch = {key: arguments[key] for key in ("title", "basis", "statement", "inferredFrom", "population", "timeWindow", "tables", "variables", "joins") if key in arguments}
    patch["datasetId"] = dataset_id
    if "statedIn" in arguments:
        if not workspace:
            raise DataSemanticsError("semantics_request_invalid", "statedIn needs the workspace file it names.")
        try:
            patch["statedIn"] = {"path": arguments["statedIn"], "sha256": checks.file_sha256(workspace, arguments["statedIn"])}
        except checks.TableError as error:
            raise DataSemanticsError("semantics_request_invalid", "statedIn: %s" % error) from error
    existing, absent = _asset_or_none(dataset_id)
    declared = checks.resolve(existing["asset"] if existing else None)["tables"]
    bindings, tables = [], {}
    if arguments.get("files"):
        if not workspace:
            raise DataSemanticsError("semantics_request_invalid", "files need the workspace they are in.")
        bindings, tables, problems = _expand_files(arguments, workspace, declared)
        local_issues.extend({"path": "files", "code": "file_%s" % item["reason"], "message": item["message"]} for item in problems)
        if bindings:
            patch["bindings"] = bindings
    # allowedValues: "observed" is copied from the file, never typed -- and never for a column that identifies people.
    for index, variable in enumerate(patch.get("variables") or []):
        if variable.get("allowedValues") != "observed":
            continue
        variable = dict(variable)
        table = tables.get(variable["table"])
        if table is None:
            local_issues.append({"index": index, "path": "variable:%s/%s:allowedValues" % (variable["table"], variable["name"]), "code": "allowedValues_observed_needs_file",
                                 "message": "\"observed\" copies the values from a file: name it in files."})
            del variable["allowedValues"]
        else:
            values, why = checks.observed_vocabulary(table, variable["name"], {"variables": declared.get(table.name, {}).get("variables", {}), "identifierColumns": declared.get(table.name, {}).get("identifierColumns", set())})
            if values is None:
                local_issues.append({"index": index, "path": "variable:%s/%s:allowedValues" % (variable["table"], variable["name"]), "code": "allowedValues_withheld_%s" % why,
                                     "message": "%s is not offered as a code list (%s)." % (variable["name"], why.replace("_", " "))})
                del variable["allowedValues"]
            else:
                variable["allowedValues"] = values
        patch["variables"][index] = variable
    if absent:
        return _absent_answer(absent, "nothing was recorded; the files were still read (%d bound)" % len(bindings))
    result = _post("write", {"patch": patch})
    issues = [issue for issue in (result.get("issues") or []) if isinstance(issue, dict)] + local_issues
    kept = [o for o in result.get("outcomes", []) if o.get("outcome") == "kept_stronger"]
    counts = {}
    for outcome in result.get("outcomes", []):
        counts[outcome["outcome"]] = counts.get(outcome["outcome"], 0) + 1
    warnings = ["%s: %s" % (issue.get("path") or "item", issue.get("message") or issue.get("code")) for issue in issues[:20]]
    if kept:
        warnings.append("%d statement(s) were NOT applied because a stronger one is recorded (%s); they are kept beside it as contested." % (
            len(kept), ", ".join(o["target"] for o in kept[:5])))
    return {
        "status": "warning" if (issues or kept) else "success",
        "summary": "Recorded dataset %s (revision %d): %s%s." % (
            dataset_id, result["revision"], ", ".join("%d %s" % (n, name) for name, n in sorted(counts.items())) or "no change",
            ", %d refused" % len(issues) if issues else ""),
        "data": {"datasetId": dataset_id, "revision": result["revision"], "changed": result["changed"], "counts": counts, "keptStronger": kept,
                 "issues": issues, "interpretation": result.get("interpretation"), "summary": result.get("summary"), "bound": [{"table": b["table"], "sha256": b["sha256"], "rows": b["rows"]} for b in bindings],
                 **({"profileTrimmed": True} if result.get("trimmed") else {})},
        "warnings": warnings,
        "next_actions": (["Correct the refused items and write only those again."] if issues else [])
                        + (["A recorded statement outranks your inference. If the data now contradicts it, say so to the researcher rather than overwriting it."] if kept else []),
    }


def _default_dataset_id(arguments: dict):
    for entry in arguments.get("files") or []:
        stem = re.sub(r"[^a-z0-9_-]+", "-", PurePosixPath(entry["path"]).stem.lower()).strip("-_")[:64]
        if re.match(DATASET_ID, stem or "-"):
            return stem
    return None


def _choose_dataset(arguments: dict, listing: list, files: list):
    """The dataset the files belong to: the one named, else the one whose tables these files are, else the only one."""
    if arguments.get("datasetId"):
        return arguments["datasetId"]
    names = {PurePosixPath(f["path"]).name for f in files}
    paths = {f["path"] for f in files}
    matching = [d["datasetId"] for d in listing if any(t["path"] in paths or t["table"] in names for t in d.get("tables", []))]
    if len(matching) == 1:
        return matching[0]
    if not files and len(listing) == 1:
        return listing[0]["datasetId"]
    return None


def check(arguments: dict) -> dict:
    allowed = ("datasetId", "files", "complete", "observationKeys", "subjectKeys", "joins", "leakage", "steps")
    _need(arguments, allowed, "check")
    workspace = _workspace()
    asset_view, absent, listing = None, None, []
    try:
        if arguments.get("datasetId"):
            asset_view, absent = _asset_or_none(arguments["datasetId"])
        else:
            listing, absent = _asset_or_none(None)
            if listing:
                chosen = _choose_dataset(arguments, listing, arguments.get("files") or [])
                if chosen:
                    asset_view, absent = _asset_or_none(chosen)
    except DataSemanticsError as error:
        if error.code not in ABSENT_CODES and not error.retryable:
            raise
        absent = error
    asset = asset_view["asset"] if asset_view else None
    files = arguments.get("files")
    if not files:
        files = [{"path": b["path"], "table": b["table"]} for b in (asset or {}).get("bindings", [])]
        if not files:
            raise DataSemanticsError("semantics_request_invalid", "check needs files: this project has no recorded paths for that dataset.")
    for key in ("observationKeys", "subjectKeys"):
        for table, columns in (arguments.get(key) or {}).items():
            if not isinstance(columns, list) or not columns or not all(isinstance(c, str) and c for c in columns):
                raise DataSemanticsError("semantics_request_invalid", "%s.%s is a list of column names." % (key, table))
    request = {"workspace": workspace, "files": files, "asset": asset, **{k: arguments[k] for k in ("complete", "observationKeys", "subjectKeys", "joins", "leakage", "steps") if k in arguments}}
    result = checks.run_checks(request)
    findings = sorted(result["findings"], key=lambda item: (item["severity"] != "attention", item["family"], item["outcome"]))
    counts = {
        "attention": sum(1 for f in findings if f["severity"] == "attention"), "information": sum(1 for f in findings if f["severity"] == "information"),
        "notChecked": len(result["notChecked"]), "clean": len(result["clean"]),
    }
    recorded, recorded_reason = False, None
    if asset:
        report = {
            "checkedAt": _now(), "bindings": [{"table": t["table"], "sha256": t["sha256"]} for t in result["tables"]], "interpretation": asset_view.get("interpretation"),
            "findings": [{k: v for k, v in f.items() if k != "examples"} for f in result["findings"]],
            "notChecked": [{"family": n["family"], "reason": n["reason"], "subject": n["subject"]} for n in result["notChecked"]],
            "clean": result["clean"],
        }
        try:
            _post("report", {"datasetId": asset["datasetId"], "report": report, "denominators": result["denominators"]})
            recorded = True
        except DataSemanticsError as error:
            # Failure keeps the partial result: the check stands, it just was not kept.
            recorded_reason = error.code
    else:
        recorded_reason = (absent.code if absent else "no_asset")
    attention = [f for f in findings if f["severity"] == "attention"]
    warnings = [f["message"] for f in attention[:12]]
    warnings.extend(result["warnings"][:5])
    not_checked = [{"family": n["family"], "reason": n["reason"], "subject": n["subject"], "message": n["message"]} for n in result["notChecked"]]
    next_actions = []
    if any(f["outcome"] in ("column_renamed_candidate", "possible_unit_change", "unit_changed") for f in attention):
        next_actions.append("A rename or a unit change is a candidate: confirm it with the researcher or the data dictionary, then record it (write: variable aliases, unit with its basis) and bind the new version (write: files).")
    if any(f["family"] == "duplicates" for f in attention):
        next_actions.append("Decide how to treat repeated observations and say it; nothing was removed. An exact repeat is safe to drop; rows that disagree need a rule.")
    if not_checked:
        next_actions.append("A check that did not run is not a clean result: declare what it needs (observation key, cutoff, measurement time) or say it was not checked.")
    next_actions.append("Go on with the analysis: a finding is information for it, and what you do about each is part of what you report.")
    return {
        "status": "warning" if attention else "success",
        "summary": "Checked %d table(s) of %s: %d finding(s) to decide on, %d to know, %d check(s) not run, %d clean." % (
            len(result["tables"]), (asset or {}).get("datasetId") or "an unrecorded dataset", counts["attention"], counts["information"], counts["notChecked"], counts["clean"]),
        "data": {"datasetId": (asset or {}).get("datasetId"), "interpretation": (asset_view or {}).get("interpretation"), "tables": result["tables"], "counts": counts,
                 "findings": findings[:FINDINGS_SHOWN], **({"findingsOmitted": len(findings) - FINDINGS_SHOWN} if len(findings) > FINDINGS_SHOWN else {}),
                 "notChecked": not_checked, "clean": result["clean"], "joins": result["joins"], "denominators": result["denominators"],
                 "recorded": recorded, **({"notRecordedBecause": recorded_reason} if recorded_reason else {})},
        "warnings": warnings, "next_actions": next_actions,
    }


def transform(arguments: dict) -> dict:
    _need(arguments, ("datasetId", "transformation"), "transform")
    spec = arguments.get("transformation")
    if not isinstance(spec, dict):
        raise DataSemanticsError("semantics_request_invalid", "transform takes a transformation object.")
    workspace = os.environ.get("OPEN_SCIENCE_WORKSPACE_DIR", "").strip()
    record = {k: spec[k] for k in ("name", "kind", "description", "inputs", "output", "parameters") if k in spec}
    if spec.get("codePath"):
        if not workspace:
            raise DataSemanticsError("semantics_request_invalid", "codePath needs the workspace file it names.")
        try:
            record["code"] = {"path": spec["codePath"], "sha256": checks.file_sha256(workspace, spec["codePath"])}
        except checks.TableError as error:
            raise DataSemanticsError("semantics_request_invalid", "codePath: %s" % error) from error
    dataset_id = arguments.get("datasetId")
    asset_view, absent = (_asset_or_none(dataset_id) if dataset_id else (None, None))
    if not dataset_id:
        listing, absent = _asset_or_none(None)
        if not absent and len(listing or []) == 1:
            dataset_id = listing[0]["datasetId"]
            asset_view, absent = _asset_or_none(dataset_id)
        elif not absent:
            raise DataSemanticsError("semantics_dataset_invalid", "datasetId names the dataset this transformation is applied to.")
    if absent and absent.code == "semantics_disabled":
        return _absent_answer(absent, "the transformation was not recorded")
    # The versions of the data it was applied to: the bytes at the recorded path now.
    bound = []
    for item in record.get("inputs") or []:
        binding = next((b for b in (asset_view or {}).get("asset", {}).get("bindings", []) if b["table"] == item.get("table")), None)
        if binding and workspace:
            try:
                bound.append({"table": binding["table"], "sha256": checks.file_sha256(workspace, binding["path"], checks.MAX_BYTES)})
            except checks.TableError:
                bound.append({"table": binding["table"], "sha256": binding["sha256"]})
    if bound:
        record["boundTo"] = bound
    result = _post("transform", {"datasetId": dataset_id, "transformation": record})
    status = result["status"]
    changed = result.get("changed") or []
    return {
        "status": "warning" if status == "changed" else "success",
        "summary": "Transformation %s is %s (version %d)%s." % (record["name"], {"new": "new", "same": "the recorded one", "changed": "changed"}[status], result["version"],
                                                                " -- " + ", ".join(changed) + " differ from the last version" if changed else ""),
        "data": {"datasetId": dataset_id, "name": record["name"], "status": status, "version": result["version"], "changed": changed, "rebound": result.get("rebound", False)},
        "warnings": ["%s is not what was recorded: %s changed. Results from the earlier version are not the same computation." % (record["name"], ", ".join(changed))] if status == "changed" else [],
        "next_actions": ["Say in the report which version of each transformation produced which result."] if status != "same" else [],
    }


def call(arguments: dict) -> dict:
    action = arguments.get("action")
    if action not in ACTIONS:
        raise DataSemanticsError("semantics_request_invalid", "action must be one of: %s." % ", ".join(ACTIONS))
    return {"read": read, "write": write, "check": check, "transform": transform}[action](arguments)
