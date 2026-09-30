#!/usr/bin/env python3
"""Offline GEO agreement analysis; no clinical labels or reference truth are inferred.

Ordinal alpha uses coincidence-weighted cumulative category frequencies, not
squared numeric category differences. See the references in ../README.md.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from hashlib import sha256
from importlib.metadata import version
from itertools import combinations
import json
import math
import os
from pathlib import Path, PurePosixPath
import random
import stat
import sys
from typing import Any, Callable

from jsonschema import Draft202012Validator, FormatChecker

SEVERITIES = [f"S{i}" for i in range(5)]
VERDICTS = ["correct", "wrong", "unverifiable"]
MAX_INPUT_BYTES = 16 * 1024 * 1024


def kappa(a: list[int], b: list[int], *, size: int, weights: str = "linear") -> float | None:
    """Cohen's kappa on pairwise-complete ratings with a fixed category order."""
    if len(a) != len(b):
        raise ValueError("Unpaired ratings")
    if not a:
        return None
    distance = lambda i, j: (int(i != j) if weights == "nominal" else abs(i - j) ** (2 if weights == "quadratic" else 1))
    left, right, n = Counter(a), Counter(b), len(a)
    observed = sum(distance(i, j) for i, j in zip(a, b)) / n
    expected = sum(left[i] * right[j] * distance(i, j) for i in range(size) for j in range(size)) / n**2
    return 1 - observed / expected if expected else None


def ordinal_alpha(units: list[list[int | None]]) -> float | None:
    """Krippendorff ordinal alpha; singleton units supply no coincidences."""
    observed = [[0.0] * 5 for _ in range(5)]
    for ratings in units:
        counts = Counter(value for value in ratings if value is not None)
        count = sum(counts.values())
        if count < 2:
            continue
        for i in range(5):
            for j in range(5):
                observed[i][j] += (counts[i] * counts[j] - (counts[i] if i == j else 0)) / (count - 1)
    frequencies = [sum(row) for row in observed]
    total = sum(frequencies)
    if total < 2:
        return None
    actual, expected = 0.0, 0.0
    for i in range(5):
        for j in range(i + 1, 5):
            distance = (sum(frequencies[i:j + 1]) - (frequencies[i] + frequencies[j]) / 2) ** 2
            actual += 2 * observed[i][j] * distance
            expected += 2 * frequencies[i] * frequencies[j] / (total - 1) * distance
    return 1 - actual / expected if expected else None


def _read_scoped(root: Path, relative: str, limit: int = MAX_INPUT_BYTES) -> bytes:
    """Read a bounded regular file beneath the dataset, without following links."""
    parts = PurePosixPath(relative).parts
    if not parts or relative.startswith("/") or ".." in parts or "\\" in relative:
        raise ValueError("Artifact paths must be relative to the dataset directory")
    descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        child = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
        with os.fdopen(child, "rb") as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
                raise ValueError("Artifact is not a bounded regular file")
            content = handle.read(limit + 1)
            if len(content) > limit:
                raise ValueError("Artifact exceeds its size limit")
            return content
    finally:
        os.close(descriptor)


def _unique(rows: list[dict], key: str) -> dict[str, dict]:
    indexed = {row[key]: row for row in rows}
    if len(indexed) != len(rows) or any(not value.strip() for value in indexed):
        raise ValueError(f"Duplicate or empty {key}")
    return indexed


def validate_relations(data: dict) -> None:
    """Check cross-record evidence bonds which JSON Schema cannot express."""
    units = _unique(data["units"], "unitId")
    raters = _unique(data["raters"], "raterId")
    ratings = _unique(data["ratings"], "ratingId")
    _unique(data["references"], "unitId")
    groups, answers, seen = {}, {}, set()
    for unit in units.values():
        if sha256(unit["answer"].encode()).hexdigest() != unit["answerSha256"]:
            raise ValueError("Answer checksum mismatch")
        for key, table, identity in ((unit["groupId"], groups, unit["datasetSplit"]),
                                     (unit["answerId"], answers, (unit["groupId"], unit["answerSha256"], unit["datasetSplit"]))):
            if key in table and table[key] != identity:
                raise ValueError("Answer identity or dataset split leakage")
            table[key] = identity
        if unit["unitKind"] == "statement":
            span = unit["span"]
            if not span or not 0 <= span["start"] < span["end"] <= len(unit["answer"]) or unit["answer"][span["start"]:span["end"]] != unit["statement"]:
                raise ValueError("Statement does not match its Unicode span")
        elif unit["span"] is not None:
            raise ValueError("An omitted element has no quote span")
        _unique(unit["evidence"], "sourceId")
    for rating in ratings.values():
        if rating["unitId"] not in units or rating["raterId"] not in raters:
            raise ValueError("Rating references an unknown unit or rater")
        identity = (rating["unitId"], rating["raterId"], rating["round"])
        if identity in seen:
            raise ValueError("Repeated rating for the same rater, unit and round")
        seen.add(identity)
        if rating["rubricVersion"] != data["rubric"]["version"]:
            raise ValueError("Rating rubric version mismatch")
        if rating["status"] == "rated" and rating["verdict"] is None:
            raise ValueError("A rated statement must have a verdict")
        if rating["verdict"] == "wrong" and not rating["errorType"]:
            raise ValueError("A wrong verdict must name its error type")
        source_ids = {source["sourceId"] for source in units[rating["unitId"]]["evidence"]}
        if not set(rating["evidenceSourceIds"]).issubset(source_ids):
            raise ValueError("Rating cites an unknown source")
    for reference in data["references"]:
        if reference["unitId"] not in units or reference["ruleVersion"] != data["analysis"]["referenceRule"]:
            raise ValueError("Reference unit or prespecified rule mismatch")
        if reference["severity"] and reference["verdict"] != "wrong":
            raise ValueError("Reference severity only applies to a wrong verdict")
        people = set()
        for rating_id in reference["sourceRatingIds"]:
            rating = ratings.get(rating_id)
            if not rating or rating["unitId"] != reference["unitId"] or (reference["basis"] != "unresolved" and rating["status"] != "rated"):
                raise ValueError("Reference lacks its cited source ratings")
            person = raters[rating["raterId"]]
            if not _independent_pharmacist(person, rating):
                raise ValueError("Reference must derive from independent pharmacist labels")
            people.add(person["raterId"])
        if reference["basis"] == "independent_pharmacist_consensus" and len(people) < 2:
            raise ValueError("A consensus reference requires at least two independent pharmacists")


def load_dataset(file: str | Path) -> tuple[dict, str]:
    file = Path(file).absolute()
    raw = _read_scoped(file.parent, file.name)
    data = json.loads(raw)
    schema = json.loads(Path(__file__).with_name("dataset.schema.json").read_text())
    Draft202012Validator(schema, format_checker=FormatChecker()).validate(data)
    validate_relations(data)
    rubric = data["rubric"]
    if not rubric["codebookPath"] or not rubric["sha256"] or not rubric["version"]:
        raise ValueError("The rubric must be frozen and hashed")
    if sha256(_read_scoped(file.parent, rubric["codebookPath"])).hexdigest() != rubric["sha256"]:
        raise ValueError("Rubric checksum mismatch")
    checked = set()
    for unit in data["units"]:
        for source in unit["evidence"]:
            identity = (source["artifactPath"], source["sha256"])
            if identity in checked:
                continue
            if sha256(_read_scoped(file.parent, source["artifactPath"])).hexdigest() != source["sha256"]:
                raise ValueError("Source checksum mismatch")
            checked.add(identity)
    return data, sha256(raw).hexdigest()


def _independent_pharmacist(person: dict, rating: dict) -> bool:
    return (person["kind"] == "pharmacist" and person["independent"] and bool(person["qualificationBasis"])
            and rating["blindedToModel"] and rating["blindedToOtherRaters"])


def _ci(rows: list[Any], groups: list[str], statistic: Callable, repeats: int, seed: int) -> dict:
    clusters = defaultdict(list)
    for row, group in zip(rows, groups):
        clusters[group].append(row)
    result = {"method": "group_percentile_bootstrap", "resamplingUnit": "groupId", "clusters": len(clusters),
              "requestedReplicates": repeats, "validReplicates": 0, "lower": None, "upper": None}
    if len(clusters) < 2 or repeats < 50:
        return {**result, "reason": "fewer_than_two_clusters" if len(clusters) < 2 else "bootstrap_disabled"}
    values, rng, keys = [], random.Random(seed), list(clusters)
    for _ in range(repeats):
        sampled = [row for key in rng.choices(keys, k=len(keys)) for row in clusters[key]]
        value = statistic(sampled)
        if value is not None and math.isfinite(value):
            values.append(value)
    result["validReplicates"] = len(values)
    if len(values) < repeats * .8:
        return {**result, "reason": "too_many_undefined_replicates"}
    values.sort()
    def quantile(p):
        position = (len(values) - 1) * p
        lower = math.floor(position)
        return values[lower] + (values[math.ceil(position)] - values[lower]) * (position - lower)
    return {**result, "lower": quantile(.025), "upper": quantile(.975), "reason": None}


def _comparison(rows: list[tuple[int, int]], labels: list[str], ordinal: bool) -> dict:
    matrix = [[0] * len(labels) for _ in labels]
    for a, b in rows:
        matrix[a][b] += 1
    a, b = [row[0] for row in rows], [row[1] for row in rows]
    result = {"labels": labels, "matrix": matrix, "n": len(rows),
              "exactAgreement": sum(x == y for x, y in rows) / len(rows) if rows else None}
    if ordinal:
        result.update(withinOneAgreement=sum(abs(x - y) <= 1 for x, y in rows) / len(rows) if rows else None,
                      linearKappa=kappa(a, b, size=5), quadraticKappa=kappa(a, b, size=5, weights="quadratic"))
    else:
        result["kappa"] = kappa(a, b, size=len(labels), weights="nominal")
    return result


def analyze(data: dict, dataset_digest: str, *, bootstrap: int = 999, seed: int = 20260930,
            round_name: str = "independent_initial", split: str = "held_out") -> dict:
    """Describe supplied annotations; agreement is not clinical correctness."""
    # Unit tests may call this directly; the CLI also checks schema and files.
    validate_relations(data)
    raters = {r["raterId"]: r for r in data["raters"]}
    units = {u["unitId"]: u for u in data["units"] if split == "all" or u["datasetSplit"] == split}
    observed = [r for r in data["ratings"] if r["round"] == round_name and r["unitId"] in units]
    humans = [r for r in observed if _independent_pharmacist(raters[r["raterId"]], r)]
    rated = {(r["raterId"], r["unitId"]): r for r in observed if r["status"] == "rated"}
    people = sorted({r["raterId"] for r in humans})
    eligible = {(r["raterId"], r["unitId"]): r for r in humans if r["status"] == "rated"}
    result = {"schemaVersion": "geo-agreement/1", "datasetId": data["datasetId"], "datasetSha256": dataset_digest,
              "rubric": data["rubric"], "raterMetadata": data["raters"], "severity_basis": "initial", "round": round_name, "split": split,
              "status": "sample_described" if eligible else "awaiting_independent_labels",
              "independentPharmacistLabels": len(eligible), "units": len(units), "raters": len(people),
              "missingness": dict(Counter(r["severityMissingReason"] or "observed" for r in humans)),
              "unassignedRaterUnitPairs": len(people) * len(units) - len(humans),
              "excludedRatings": len(observed) - len(humans), "agreementResults": None, "modelComparisons": [],
              "software": {"python": sys.version.split()[0], "jsonschema": version("jsonschema"), "algorithm": "geo-agreement/1"},
              "bootstrap": {"replicates": bootstrap, "seed": seed},
              "limitations": ["Agreement measures repeatability, not clinical correctness.",
                              "S0-S4 is a local prospective-harm rubric, not the official NCC MERP outcome index.",
                              "Cluster bootstrap intervals can be unstable with few independent groups or nonrandom missingness.",
                              "Supplied consensus references are reported separately and never overwrite independent ratings."]}
    if eligible:
        pairs = []
        for left, right in combinations(people, 2):
            both = [(u, eligible[(left, u)], eligible[(right, u)]) for u in units if (left, u) in eligible and (right, u) in eligible]
            verdict_rows = [(VERDICTS.index(a["verdict"]), VERDICTS.index(b["verdict"])) for _, a, b in both]
            complete = [(u, SEVERITIES.index(a["severity"]), SEVERITIES.index(b["severity"])) for u, a, b in both if a["severity"] and b["severity"]]
            rows = [(a, b) for _, a, b in complete]
            severity = _comparison(rows, SEVERITIES, True)
            severity["linearKappaCi"] = _ci(rows, [units[u]["groupId"] for u, _, _ in complete],
                lambda sample: kappa([a for a, _ in sample], [b for _, b in sample], size=5), bootstrap, seed)
            verdict = _comparison(verdict_rows, VERDICTS, False)
            verdict["kappaCi"] = _ci(verdict_rows, [units[u]["groupId"] for u, _, _ in both],
                lambda sample: kappa([a for a, _ in sample], [b for _, b in sample], size=3, weights="nominal"), bootstrap, seed)
            pairs.append({"raters": [left, right], "verdict": verdict, "severity": severity})
        severity_rows = [[SEVERITIES.index(eligible[(person, u)]["severity"]) if (person, u) in eligible and eligible[(person, u)]["severity"] else None for person in people] for u in units]
        paired = [(u, row) for u, row in zip(units, severity_rows) if sum(v is not None for v in row) >= 2]
        result["agreementResults"] = {"pairs": pairs, "ordinalAlpha": {"value": ordinal_alpha(severity_rows),
            "pairableUnits": len(paired), "coverage": dict(Counter(SEVERITIES[v] for row in severity_rows for v in row if v is not None)),
            "ci": _ci([row for _, row in paired], [units[u]["groupId"] for u, _ in paired], ordinal_alpha, bootstrap, seed)}}
    references = [r for r in data["references"] if r["unitId"] in units and not r["disputed"] and r["basis"] != "unresolved" and r["verdict"]]
    selected_references = [r for r in data["references"] if r["unitId"] in units]
    result["referenceCoverage"] = {"provided": len(selected_references), "included": len(references),
        "disputedOrUnresolved": len(selected_references) - len(references)}
    for person in data["raters"]:
        if person["kind"] != "model":
            continue
        compared = [(r, rated.get((person["raterId"], r["unitId"]))) for r in references]
        present = [(ref, model) for ref, model in compared if model]
        rows = [(VERDICTS.index(ref["verdict"]), VERDICTS.index(model["verdict"])) for ref, model in present]
        positive = [(ref, model) for ref, model in compared if ref["verdict"] == "wrong" and ref["severity"] in ["S3", "S4"]]
        missing_severity = [(ref, model) for ref, model in positive if model and model["verdict"] == "wrong" and model["severity"] is None]
        assessed = [(ref, model) for ref, model in positive if model and not (model["verdict"] == "wrong" and model["severity"] is None)]
        missed = [ref["unitId"] for ref, model in assessed if model["verdict"] != "wrong" or model["severity"] not in ["S3", "S4"]]
        detection = [int(model["verdict"] == "wrong" and model["severity"] in ["S3", "S4"]) for _, model in assessed]
        ratio = lambda sample: sum(sample) / len(sample) if sample else None
        result["modelComparisons"].append({"modelRater": person["raterId"], "modelVersion": person["modelVersion"],
            "referenceRule": data["analysis"]["referenceRule"], "references": len(references), "missingModel": len(compared) - len(present),
            "verdict": _comparison(rows, VERDICTS, False),
            "falseWrong": {"count": sum(ref["verdict"] == "correct" and model["verdict"] == "wrong" for ref, model in present), "denominator": sum(ref["verdict"] == "correct" for ref, _ in present)},
            "missedWrong": {"count": sum(ref["verdict"] == "wrong" and model["verdict"] != "wrong" for ref, model in present), "denominator": sum(ref["verdict"] == "wrong" for ref, _ in present)},
            "seriousErrors": {"definition": "Reference wrong/S3-S4; detected only when the model also labels wrong/S3-S4. Missing model ratings and wrong verdicts with missing severity are excluded and counted separately.", "referencePositive": len(positive), "assessed": len(assessed), "missingModel": sum(model is None for _, model in positive), "missingSeverity": len(missing_severity),
                "missed": len(missed), "missedUnitIds": missed, "sensitivity": ratio(detection),
                "sensitivityCi": _ci(detection, [units[ref["unitId"]]["groupId"] for ref, _ in assessed], ratio, bootstrap, seed)}})
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--bootstrap", type=int, default=999)
    parser.add_argument("--seed", type=int, default=20260930)
    parser.add_argument("--round", choices=["independent_initial", "independent_repeat"], default="independent_initial")
    parser.add_argument("--split", choices=["codebook_pilot", "development", "held_out", "all"], default="held_out")
    args = parser.parse_args()
    if not 0 <= args.bootstrap <= 10000:
        parser.error("--bootstrap must be between 0 and 10000")
    if args.output.resolve() == args.dataset.resolve():
        parser.error("The report must not overwrite its dataset")
    data, digest = load_dataset(args.dataset)
    report = analyze(data, digest, bootstrap=args.bootstrap, seed=args.seed, round_name=args.round, split=args.split)
    # Exclusive create preserves previous analysis rounds and the annotations.
    with args.output.open("x", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2, allow_nan=False)
        handle.write("\n")
    print(json.dumps({"status": report["status"], "units": report["units"], "independentPharmacistLabels": report["independentPharmacistLabels"]}))


if __name__ == "__main__":
    main()
