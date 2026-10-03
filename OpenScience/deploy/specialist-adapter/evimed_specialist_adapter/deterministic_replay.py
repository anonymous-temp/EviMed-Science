"""Admitted deterministic calculations over frozen aggregate inputs.

The dispatcher names three existing engine functions. It never imports a module
named by the request, invokes model/retrieval code, installs a dependency or
executes an imported script. VCR jobs remain on the existing protected R service.
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


class ReplayError(ValueError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


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
            "comparison": spec["comparison"]}


def _object(value: Any, allowed: set[str], required: set[str] | None = None) -> dict:
    if not isinstance(value, dict) or set(value) - allowed or not (allowed if required is None else required).issubset(value):
        raise ReplayError("replay_input_invalid")
    return value


def _number(value: Any, *, positive=False, integer=False) -> float:
    if type(value) not in (int, float) or not math.isfinite(value) or (positive and value <= 0) or (integer and (value < 0 or int(value) != value)):
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
        studies = []
        for row in _rows(value["studies"], 1024):
            _object(row, {"id", "label", "yi", "vi"})
            vi = _number(row["vi"], positive=True)
            studies.append(StudyEffect(study_id=_label(row["id"]), study_label=_label(row["label"]),
                                       yi=_number(row["yi"]), vi=vi, se=math.sqrt(vi)))
        result = random_effects_dl(studies, value["effectMeasure"], _label(value["outcome"]))
        return {"method": method, "values": result.model_dump(mode="json"), "executedMethod": result.execution_metadata().model_dump(mode="json")}
    if method == "faers.signals":
        _object(parameters, {"yates", "correctZeroCells"}, set())
        if any(type(flag) is not bool for flag in parameters.values()):
            raise ReplayError("replay_input_invalid")
        _object(value, {"tables"})
        from safety_agent.signals.tables import ContingencyTable2x2
        from safety_agent.signals.disproportionality import ror, prr, chi_square, information_component
        rows = []
        for row in _rows(value["tables"], 1024):
            _object(row, {"id", "a", "b", "c", "d"})
            table = ContingencyTable2x2(**{cell: _number(row[cell], integer=True) for cell in "abcd"})
            corrected = table.needs_correction
            if corrected:
                if not parameters.get("correctZeroCells", True):
                    raise ReplayError("replay_not_estimable")
                table = table.corrected()
            rows.append({"id": _label(row["id"]), "table": asdict(table), "haldaneAnscombeApplied": corrected,
                         "ror": asdict(ror(table)), "prr": asdict(prr(table)),
                         "chi2": asdict(chi_square(table, yates=parameters.get("yates", False))),
                         "ic": asdict(information_component(table))})
        # EBGM is omitted: a captured 2x2 table alone does not identify the fitted prior.
        return {"method": method, "values": rows, "omitted": [{"statistic": "EBGM", "reason": "fitted_prior_not_part_of_this_recipe"}]}
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
        graph = _build_graph(pd.DataFrame(rows), int(max_nodes))
        centrality = _compute_centrality(graph) if graph.number_of_nodes() else {}
        return {"method": method, "values": {"nodeCount": graph.number_of_nodes(), "edgeCount": graph.number_of_edges(),
                "centrality": {node: centrality[node] for node in sorted(centrality)}},
                "omitted": [{"statistic": "community_detection_and_layout", "reason": "original_path_not_declared_deterministic"}]}
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
            "codeFiles": observed["codeFiles"], "environment": observed["environment"], "comparison": observed["comparison"]}}


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
