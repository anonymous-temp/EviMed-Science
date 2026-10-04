"""Admitted deterministic calculations over frozen aggregate inputs.

The dispatcher names three existing engine functions. It never imports a module
named by the request, invokes model/retrieval code, installs a dependency or
executes an imported script. VCR jobs remain on the existing protected R service.

Every method has a record (`method_records.json`, one file for the adapter, the
control plane and the calculation tool): its assumptions, inputs, the refusals it
may answer with, the diagnostics it may attach, whether it draws random numbers,
and the references its numbers were checked against. A result carries the record's
identity, version and digest, the seed (none: no admitted method is seeded) and the
diagnostics its own input earned, so a rerun can say whether it ran the same method
and what it noticed about the data. A refusal declines that one calculation under a
named code; the rest of the research is untouched.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import math
import os
import platform
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Any

from . import audit_receipt

METHODS = {
    "meta.dl": {
        "environment": "EVIMED_REPLAY_META_ROOT", "defaultRoot": "/engines/meta",
        "files": ("new_meta/__init__.py", "new_meta/engines/__init__.py", "new_meta/engines/meta_engine.py",
                  "new_meta/schemas/__init__.py", "new_meta/schemas/meta_result.py"),
        "packages": ("numpy", "scipy", "pydantic"),
        "comparison": {"absoluteTolerance": 1e-10, "relativeTolerance": 1e-9},
    },
    "faers.signals": {
        "environment": "EVIMED_REPLAY_SAFETY_ROOT", "defaultRoot": "/engines/safety",
        "files": ("safety_agent/__init__.py", "safety_agent/signals/__init__.py", "safety_agent/signals/disproportionality.py",
                  "safety_agent/signals/tables.py", "safety_agent/signals/_gamma.py", "safety_agent/signals/rules.py", "safety_agent/signals/mgps_fit.py"),
        "packages": ("numpy", "scipy", "pandas"),
        "comparison": {"absoluteTolerance": 1e-10, "relativeTolerance": 1e-9},
    },
    "bibliometric.network": {
        "environment": "EVIMED_REPLAY_BIBLIOMETRIC_ROOT", "defaultRoot": "/engines/bibliometric",
        "files": ("src/bibliometric/__init__.py", "src/bibliometric/analysis/__init__.py", "src/bibliometric/analysis/network_analyzer.py"),
        "packages": ("numpy", "pandas", "networkx"),
        "comparison": {"absoluteTolerance": 1e-8, "relativeTolerance": 1e-8},
    },
}
MAX_INPUT_BYTES = 8 * 1024 * 1024
RECORDS_FILE = "method_records.json"
_RECORDS: dict[str, Any] | None = None


class ReplayError(ValueError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def method_records() -> dict[str, Any]:
    """The method records shipped beside this module (read once)."""
    global _RECORDS
    if _RECORDS is None:
        try:
            loaded = json.loads((Path(__file__).with_name(RECORDS_FILE)).read_bytes())
            if not isinstance(loaded, dict) or loaded.get("schemaVersion") != 1 or not isinstance(loaded.get("methods"), dict):
                raise ValueError()
        except (OSError, ValueError):
            raise ReplayError("replay_environment_unavailable") from None
        _RECORDS = loaded["methods"]
    return _RECORDS


def record_identity(method: str) -> dict[str, str]:
    """The record's id, version and digest, which a result carries to say what ran."""
    record = method_records().get(method)
    if not isinstance(record, dict) or record.get("id") != method or not isinstance(record.get("version"), str):
        raise ReplayError("replay_method_unsupported")
    return {"id": method, "version": record["version"], "digest": digest(canonical(record))}


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def engine_root(method: str) -> Path:
    if method not in METHODS:
        raise ReplayError("replay_method_unsupported")
    spec = METHODS[method]
    value = Path(os.getenv(spec["environment"], spec["defaultRoot"]))
    if not value.is_absolute() or not value.is_dir() or value.is_symlink():
        raise ReplayError("replay_engine_unavailable")
    return value


def manifest(method: str) -> dict[str, Any]:
    """Measure exact admitted source and installed package identities.

    Installation paths and environment variable values are deliberately absent.
    The adapter itself is included because normalization selects the calculation.
    """
    root = engine_root(method)
    spec = METHODS[method]
    try:
        files = []
        for name in spec["files"]:
            blob = audit_receipt._read_file(root, name)
            files.append({"path": name, "sha256": digest(blob), "bytes": len(blob)})
        adapter = Path(__file__)
        files.append({"path": "adapter/deterministic_replay.py", "sha256": digest(adapter.read_bytes()), "bytes": adapter.stat().st_size})
        environment = {"python": platform.python_version(), "implementation": platform.python_implementation(),
                       "platform": sys.platform, "machine": platform.machine(),
                       "packages": {name: importlib.metadata.version(name) for name in spec["packages"]}}
    except (OSError, ValueError, importlib.metadata.PackageNotFoundError):
        raise ReplayError("replay_environment_unavailable") from None
    return {"method": method, "version": "1", "codeDigest": digest(canonical(files)), "codeFiles": files,
            "environmentDigest": digest(canonical(environment)), "environment": environment,
            "comparison": spec["comparison"], "methodRecord": record_identity(method)}


def _object(value: Any, allowed: set[str], required: set[str] | None = None) -> dict:
    if not isinstance(value, dict) or set(value) - allowed or not (allowed if required is None else required).issubset(value):
        raise ReplayError("replay_input_invalid")
    return value


def _number(value: Any, *, positive=False, integer=False, nonpositive="replay_input_invalid") -> float:
    """A finite number, in range. A NaN or infinity is its own refusal: it is a missing or broken
    value, not a malformed request, and the researcher can fix it. `nonpositive` names the refusal for a
    value that must be above zero and is not."""
    if type(value) not in (int, float):
        raise ReplayError("replay_input_invalid")
    if not math.isfinite(value):
        raise ReplayError("replay_nonfinite_value")
    if positive and value <= 0:
        raise ReplayError(nonpositive)
    if integer and (value < 0 or int(value) != value):
        raise ReplayError("replay_input_invalid")
    return value


def _label(value: Any) -> str:
    if not isinstance(value, str) or not value or len(value) > 200 or any(ord(char) < 32 for char in value):
        raise ReplayError("replay_input_invalid")
    return value


def _rows(value: Any, limit: int) -> list:
    if not isinstance(value, list) or not 1 <= len(value) <= limit:
        raise ReplayError("replay_input_invalid")
    return value


def _diagnostic(code: str, severity: str, **detail: Any) -> dict[str, Any]:
    """One thing a method noticed about this input. The codes are the record's `diagnostics`."""
    return {"code": code, "severity": severity, **({"detail": detail} if detail else {})}


def _pooling_diagnostics(rows: list[dict], measure: str, fitted: dict[str, Any]) -> list[dict[str, Any]]:
    """What a random-effects pooling should say about the data it was given.

    `fitted` is the engine's result as a plain dict; a missing field reads as absent, so a
    result that does not carry it earns no diagnostic from it rather than a failure.
    """
    found = []
    k = len(rows)
    if fitted.get("fallback_reason") == "fewer_than_three_studies":
        found.append(_diagnostic("two_studies_fixed_effect_fallback", "notice", studies=k))
    elif k < 5:
        found.append(_diagnostic("few_studies", "notice", studies=k))
    if fitted.get("model") == "random" and fitted.get("tau_squared") == 0:
        found.append(_diagnostic("tau_squared_at_boundary", "notice", studies=k))
    i_squared = fitted.get("i_squared")
    if isinstance(i_squared, (int, float)) and i_squared >= 75:
        found.append(_diagnostic("heterogeneity_considerable", "warning", iSquaredPercent=i_squared))
    weights = [(item.get("study_id"), item.get("weight")) for item in fitted.get("studies") or [] if isinstance(item, dict)]
    heaviest = max(((weight, study) for study, weight in weights if isinstance(weight, (int, float))), default=None)
    if heaviest is not None and heaviest[0] >= 50:
        found.append(_diagnostic("dominant_study", "notice", studyId=heaviest[1], weightPercent=heaviest[0]))
    seen: dict[tuple[float, float], list[str]] = {}
    for row in rows:
        seen.setdefault((float(row["yi"]), float(row["vi"])), []).append(row["id"])
    twins = [ids for ids in seen.values() if len(ids) > 1]
    if twins:
        found.append(_diagnostic("duplicate_effects", "warning", studyIds=sorted(item for ids in twins for item in ids)[:20]))
    if measure in {"OR", "RR", "HR", "IRR"} and any(abs(float(row["yi"])) > 10 for row in rows):
        found.append(_diagnostic("ratio_effect_on_raw_scale_suspected", "warning", effectMeasure=measure))
    if "prediction_interval" in fitted and fitted["prediction_interval"] is None:
        found.append(_diagnostic("prediction_interval_unavailable", "notice"))
    found.append(_diagnostic("small_study_tests_not_run", "notice"))
    return found


def _signal_diagnostics(rows: list[dict], corrected: dict[str, bool]) -> list[dict[str, Any]]:
    found = []
    for row in rows:
        a, b, c, d = (row[cell] for cell in "abcd")
        if corrected.get(row["id"]):
            found.append(_diagnostic("zero_cell_corrected", "notice", tableId=row["id"]))
        if a < 3:
            found.append(_diagnostic("small_case_count", "warning", tableId=row["id"], cases=a))
        n = a + b + c + d
        smallest_expected = min((a + b) * (a + c), (a + b) * (b + d), (c + d) * (a + c), (c + d) * (b + d)) / n
        if smallest_expected < 5:
            found.append(_diagnostic("chi_square_expected_count_below_5", "warning", tableId=row["id"], smallestExpected=smallest_expected))
    if len(rows) > 1:
        found.append(_diagnostic("multiplicity_unadjusted", "notice", tables=len(rows)))
    return found


def _network_diagnostics(rows: list[dict], max_nodes: int, graph_edges: int) -> list[dict[str, Any]]:
    found = []
    frequency: dict[str, float] = {}
    for row in rows:
        frequency[row["source"]] = max(frequency.get(row["source"], 0), row["source_freq"])
        frequency[row["target"]] = max(frequency.get(row["target"], 0), row["target_freq"])
    over = [(row["source"], row["target"]) for row in rows if row["weight"] > min(frequency[row["source"]], frequency[row["target"]])]
    if over:
        found.append(_diagnostic("cooccurrence_exceeds_frequency", "warning", edges=len(over)))
    ranked = sorted(frequency, key=frequency.get, reverse=True)
    if len(ranked) > max_nodes and frequency[ranked[max_nodes - 1]] == frequency[ranked[max_nodes]]:
        found.append(_diagnostic("node_limit_cutoff_tie", "notice", maxNodes=max_nodes, frequency=frequency[ranked[max_nodes]]))
    kept = set(ranked[:max_nodes])
    parent = {node: node for node in kept}

    def find(node):
        while parent[node] != node:
            parent[node] = parent[parent[node]]
            node = parent[node]
        return node
    joined = [row for row in rows if row["source"] in kept and row["target"] in kept]
    for row in joined:
        parent[find(row["source"])] = find(row["target"])
    touched = {node for row in joined for node in (row["source"], row["target"])}
    if not joined or not graph_edges:
        found.append(_diagnostic("no_edges_between_kept_nodes", "warning", maxNodes=max_nodes))
    elif len({find(node) for node in touched}) > 1:
        found.append(_diagnostic("disconnected_graph", "notice", components=len({find(node) for node in touched})))
    return found


def _with_identity(method: str, result: dict[str, Any], diagnostics: list[dict[str, Any]]) -> dict[str, Any]:
    """Attach what a result must say about itself: the method record it ran, no seed, what it noticed."""
    return {**result, "methodRecord": record_identity(method), "seeded": False, "seed": None, "diagnostics": diagnostics}


def compute(method: str, value: dict[str, Any], parameters: dict[str, Any]) -> dict[str, Any]:
    """Call fixed numeric engine functions; no narrative generation involved."""
    root = engine_root(method)
    source = str(root / "src") if method == "bibliometric.network" else str(root)
    if source not in sys.path:
        sys.path.insert(0, source)
    if method == "meta.dl":
        _object(parameters, set(), set())
        _object(value, {"studies", "effectMeasure", "outcome"})
        if value["effectMeasure"] not in {"OR", "RR", "HR", "IRR", "RD", "MD", "SMD"}:
            raise ReplayError("replay_input_invalid")
        from new_meta.engines.meta_engine import random_effects_dl
        from new_meta.schemas.meta_result import StudyEffect
        rows, studies = [], []
        for row in _rows(value["studies"], 1024):
            _object(row, {"id", "label", "yi", "vi"})
            vi = _number(row["vi"], positive=True, nonpositive="replay_nonpositive_variance")
            yi = _number(row["yi"])
            rows.append({"id": _label(row["id"]), "yi": yi, "vi": vi})
            studies.append(StudyEffect(study_id=rows[-1]["id"], study_label=_label(row["label"]), yi=yi, vi=vi, se=math.sqrt(vi)))
        # A study entered twice is counted twice; one study alone has nothing to pool.
        if len({row["id"] for row in rows}) != len(rows):
            raise ReplayError("replay_duplicate_study_ids")
        if len(rows) < 2:
            raise ReplayError("replay_single_study")
        result = random_effects_dl(studies, value["effectMeasure"], _label(value["outcome"]))
        fitted = result.model_dump(mode="json")
        return _with_identity(method, {"method": method, "values": fitted, "executedMethod": result.execution_metadata().model_dump(mode="json")},
                              _pooling_diagnostics(rows, value["effectMeasure"], fitted))
    if method == "faers.signals":
        _object(parameters, {"yates", "correctZeroCells"}, set())
        if any(type(flag) is not bool for flag in parameters.values()):
            raise ReplayError("replay_input_invalid")
        _object(value, {"tables"})
        from safety_agent.signals.tables import ContingencyTable2x2
        from safety_agent.signals.disproportionality import ror, prr, chi_square, information_component
        rows, panels, corrected_tables = [], [], {}
        for row in _rows(value["tables"], 1024):
            _object(row, {"id", "a", "b", "c", "d"})
            rows.append({"id": _label(row["id"]), **{cell: _number(row[cell], integer=True) for cell in "abcd"}})
        if len({row["id"] for row in rows}) != len(rows):
            raise ReplayError("replay_duplicate_table_ids")
        for row in rows:
            if sum(row[cell] for cell in "abcd") == 0:
                raise ReplayError("replay_empty_table")
            table = ContingencyTable2x2(**{cell: row[cell] for cell in "abcd"})
            corrected = table.needs_correction
            if corrected:
                if not parameters.get("correctZeroCells", True):
                    raise ReplayError("replay_not_estimable")
                table = table.corrected()
            corrected_tables[row["id"]] = corrected
            panels.append({"id": row["id"], "table": asdict(table), "haldaneAnscombeApplied": corrected,
                           "ror": asdict(ror(table)), "prr": asdict(prr(table)),
                           "chi2": asdict(chi_square(table, yates=parameters.get("yates", False))),
                           "ic": asdict(information_component(table))})
        # EBGM is omitted: a captured 2x2 table alone does not identify the fitted prior.
        return _with_identity(method, {"method": method, "values": panels, "omitted": [{"statistic": "EBGM", "reason": "fitted_prior_not_part_of_this_recipe"}]},
                              _signal_diagnostics(rows, corrected_tables))
    if method == "bibliometric.network":
        _object(parameters, {"maxNodes"})
        max_nodes = _number(parameters["maxNodes"], positive=True, integer=True)
        if max_nodes > 500:
            raise ReplayError("replay_input_invalid")
        _object(value, {"edges"})
        import pandas as pd
        from bibliometric.analysis.network_analyzer import _build_graph, _compute_centrality
        rows = []
        for row in _rows(value["edges"], 10000):
            _object(row, {"source", "target", "weight", "source_freq", "target_freq"})
            rows.append({"source": _label(row["source"]), "target": _label(row["target"]),
                         "weight": _number(row["weight"], positive=True),
                         "source_freq": _number(row["source_freq"], positive=True), "target_freq": _number(row["target_freq"], positive=True)})
        if len({row[field] for row in rows for field in ("source", "target")}) > 2000:
            raise ReplayError("replay_input_invalid")
        # The graph keeps one weight per unordered pair, so a pair given twice would silently lose a count.
        if any(row["source"] == row["target"] for row in rows):
            raise ReplayError("replay_self_loop_edge")
        pairs = [frozenset((row["source"], row["target"])) for row in rows]
        if len(set(pairs)) != len(pairs):
            raise ReplayError("replay_duplicate_edges")
        graph = _build_graph(pd.DataFrame(rows), int(max_nodes))
        centrality = _compute_centrality(graph) if graph.number_of_nodes() else {}
        return _with_identity(method, {"method": method, "values": {"nodeCount": graph.number_of_nodes(), "edgeCount": graph.number_of_edges(),
                "centrality": {node: centrality[node] for node in sorted(centrality)}},
                "omitted": [{"statistic": "community_detection_and_layout", "reason": "original_path_not_declared_deterministic"}]},
                _network_diagnostics(rows, int(max_nodes), graph.number_of_edges()))
    raise ReplayError("replay_method_unsupported")


def validate_recipe(value: Any) -> dict[str, Any]:
    _object(value, {"method", "version", "input", "parameters", "codeDigest", "environmentDigest"})
    if value["method"] not in METHODS or value["version"] != "1":
        raise ReplayError("replay_method_unsupported")
    _object(value["input"], {"path", "sha256"})
    audit_receipt._parts(value["input"]["path"])
    for digest_value in (value["input"]["sha256"], value["codeDigest"], value["environmentDigest"]):
        if not isinstance(digest_value, str) or len(digest_value) != 64 or any(char not in "0123456789abcdef" for char in digest_value):
            raise ReplayError("replay_recipe_invalid")
    if not isinstance(value["parameters"], dict):
        raise ReplayError("replay_recipe_invalid")
    return value


def numeric_unit(method: str, result: dict, fields: tuple) -> str:
    """Name the actual numeric scale, without inventing an unrecorded outcome unit."""
    field = fields[-1]
    if method == "meta.dl":
        measure = result["values"]["effect_measure"]
        original = {"OR": "odds_ratio", "RR": "risk_ratio", "HR": "hazard_ratio", "IRR": "incidence_rate_ratio",
                    "RD": "risk_difference", "MD": "mean_difference_unspecified_unit", "SMD": "standardized_mean_difference"}[measure]
        analysis = "log_" + original if measure in {"OR", "RR", "HR", "IRR"} else original
        if field == "n_studies":
            return "count"
        if field in {"i_squared", "weight"}:
            return "percent"
        if field in {"p_value", "q_p_value", "q_statistic", "h_squared", "subgroup_q_between", "subgroup_q_between_p"}:
            return "dimensionless"
        if field in {"tau_squared", "vi"}:
            return analysis + "_squared"
        if field in {"pooled_log", "ci_lower_log", "ci_upper_log", "yi", "se"}:
            return analysis
        if field in {"pooled_effect", "ci_lower", "ci_upper"} or fields[0] == "prediction_interval":
            return original
    elif method == "faers.signals" and len(fields) >= 2:
        if fields[1] == "table":
            return "count"
        if fields[1] == "ic":
            return "log2_reporting_ratio"
        if fields[1] in {"ror", "prr", "chi2"}:
            return "dimensionless"
    elif method == "bibliometric.network":
        if field in {"nodeCount", "edgeCount"}:
            return "count"
        if fields[0] == "centrality":
            if field in {"weighted_degree", "closeness"}:
                return "cooccurrence_weight"
            if field in {"degree", "betweenness"}:
                return "dimensionless"
    raise ReplayError("replay_output_unit_unknown")


def execute(recipe: dict[str, Any], input_bytes: bytes) -> dict[str, Any]:
    recipe = validate_recipe(recipe)
    if len(input_bytes) > MAX_INPUT_BYTES:
        raise ReplayError("replay_input_too_large")
    if digest(input_bytes) != recipe["input"]["sha256"]:
        raise ReplayError("replay_input_changed")
    observed = manifest(recipe["method"])
    if recipe["codeDigest"] != observed["codeDigest"]:
        raise ReplayError("replay_code_changed")
    if recipe["environmentDigest"] != observed["environmentDigest"]:
        raise ReplayError("replay_environment_incompatible")
    try:
        value = json.loads(input_bytes)
        result = compute(recipe["method"], value, recipe["parameters"])
        encoded = canonical(result)
    except ReplayError:
        raise
    except (ValueError, TypeError, KeyError, OverflowError):
        raise ReplayError("replay_input_invalid") from None
    machine_values = []
    def collect(value, key, fields=()):
        if type(value) in (int, float):
            comparison = observed["comparison"]
            machine_values.append({"key": key, "value": value, "unit": numeric_unit(recipe["method"], result, fields),
                                   "absoluteTolerance": comparison["absoluteTolerance"], "relativeTolerance": comparison["relativeTolerance"]})
        elif isinstance(value, dict):
            for field in sorted(value):
                collect(value[field], f"{key}.{field}" if key else field, (*fields, field))
        elif isinstance(value, list):
            for index, item in enumerate(value):
                collect(item, f"{key}[{index}]", (*fields, index))
    collect(result["values"], "values")
    return {"schemaVersion": 1, "result": result, "machineValues": machine_values, "recipe": recipe,
            "receipt": {"method": recipe["method"], "version": "1",
            "recipeDigest": digest(canonical(recipe)), "inputDigest": digest(input_bytes), "outputDigest": digest(encoded),
            "codeDigest": observed["codeDigest"], "environmentDigest": observed["environmentDigest"],
            "codeFiles": observed["codeFiles"], "environment": observed["environment"], "comparison": observed["comparison"],
            "methodRecord": observed["methodRecord"], "seed": None}}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--recipe", required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    target = Path(args.output)
    try:
        recipe_file, input_file = Path(args.recipe), Path(args.input)
        recipe = json.loads(audit_receipt._read_file(recipe_file.parent, recipe_file.name, 128 * 1024))
        blob = audit_receipt._read_file(input_file.parent, input_file.name, MAX_INPUT_BYTES)
        value = execute(recipe, blob)
        data = canonical(value)
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        return 0
    except (ReplayError, OSError, ValueError) as error:
        # This CLI's fixed diagnostic carries no input content or installation paths.
        print(getattr(error, "code", "replay_execution_failed"), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
