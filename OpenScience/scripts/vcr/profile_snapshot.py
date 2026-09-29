#!/usr/bin/env python3
"""Profile a 「虚拟临研」 data snapshot: structure, data dictionary, three clocks,
missing reasons and a Kahn-2016 quality profile (build plan 2026-09-28 §8.1
step 5, attachment C2 §2.7, cases C2-23 to C2-25).

Hidden knowledge
----------------

* **The column profiler is not rewritten here — it is imported.** Everything
  about fill rates, inferred types, sentinel dates, code shapes, join
  reachability and identifier masking already exists, has been reproduced on
  real hospital extracts, and carries the scars in its own comments
  (``capabilities/dataset-research-scoping/scripts/profile_dataset.py``). A
  second copy would drift, and the copy that drifts is the one that prints
  eighteen-digit identity numbers into a deliverable again. This script loads
  that file by path and adds the six things the inventory says it lacks: the
  field map, units and coding, the three clocks, missing reasons, the Kahn
  categories, and a byte-deterministic output.
* **Deterministic to the byte.** No timestamps, no locale, no set iteration in
  the output; every mapping is written with ``sort_keys`` and every float is
  rounded. A snapshot's profile is part of what makes it reproducible, so the
  same bytes in must give the same bytes out — profile a file twice and the two
  JSON files hash the same. That is why ``--as-of`` must be passed explicitly
  rather than defaulting to today: "today" is not an input.
* **A vocabulary entry is a cell of people.** The dataset-scoping profiler
  prints a column's full vocabulary with counts when the column has few
  distinct values, which is right for a researcher reading their own extract
  and wrong here: this profile is stored in the control plane and shown to a
  model, so ``OS_TIME: {410: 1, 377: 1, 289: 1}`` is three patients' survival
  times written into ``evimed_vcr.snapshots.profile``. Found by the
  integration test that scans every text and jsonb column of the schema for a
  value that exists only in the file. So every vocabulary entry below
  ``--min-cell-size`` (the domain's ``VCR_MIN_CELL_SIZE``) is dropped and
  counted, exactly as an aggregate handed to a model is (AC-26), and the raw
  example values the base profiler keeps for composite cells are dropped
  outright.
* **A column the field map calls an identifier is masked whatever its name
  looks like.** ``USUBJID`` is one token with no id-shaped suffix, so the
  base profiler's name rule does not catch it and it printed its subject ids.
  The study's own declaration wins over the heuristic.
* **A sealed column has no statistics, not even a fill rate.** The fill rate of
  a sealed outcome column is an event rate, and an event rate is the thing the
  seal exists to withhold (AC-32). So a sealed column appears by name with
  ``sealed: true`` and nothing else, and no quality finding is emitted about
  it — a finding that says "this outcome column has 14 implausible values" has
  already leaked more than the column would have.
* **Unknown is never absent.** A blank in a column whose declared missing
  reason is "not shared" or "restricted during the trial" is a question the
  data cannot answer. The profile says so per column, in the completeness
  category, because a reader who sees 0% fill and no reason writes "no
  treatment" into a table (plan §8.1, AC-06).
* **A unit error and an out-of-range value are different findings.** Both are
  conformance, but "every height is between 1.5 and 2.0 while the dictionary
  says centimetres" is a scale mistake with a correction factor, and a single
  weight of 4 000 kg is a typo. Reporting them as one finding makes the first
  one unfixable, because nothing says what to multiply by.
* **The checks are advisory, all of them.** Nothing here withholds a snapshot;
  the findings travel with it (platform principle 4, contract §0.6).

Usage::

    profile_snapshot.py cohort.csv visits.csv --json snapshot-profile.json \\
        --field-map field-map.json --sealed-fields OS_EVENT,OS_TIME --as-of 2026-09-28T00:00:00Z

The field map may also be piped in on stdin as JSON, which is how the control
plane's ``runSnapshotProfiler`` calls it.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import re
import sys
from collections import Counter
from datetime import date, datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 1

# The deterministic column profiler this one builds on. Kept as a path rather
# than a package import because the two live in different trees and neither is
# installable; a wrong path fails loudly here instead of silently profiling
# nothing.
DEFAULT_PROFILER = (
    Path(__file__).resolve().parents[2]
    / "capabilities"
    / "dataset-research-scoping"
    / "scripts"
    / "profile_dataset.py"
)

# Kahn 2016's three categories plus the two the plan splits out (§8.1 step 5).
CATEGORIES = ("conformance", "completeness", "plausibility", "duplication", "linkage")

# The three clocks. A fact carries all three and they are not interchangeable.
TIME_KINDS = ("occurred_at", "recorded_at", "visible_at")

# Missing reasons (domain `VCR_MISSING_REASONS`). Listed here so the script
# runs without the Node package; a word outside this list is a field-map error.
MISSING_REASONS = (
    "not_measured",
    "not_recorded",
    "not_shared",
    "restricted_in_trial",
    "out_of_window",
    "pending_result",
    "not_applicable",
)
# Reasons that mean "the data cannot answer" rather than "it did not happen".
UNKNOWN_REASONS = (
    "not_measured",
    "not_recorded",
    "not_shared",
    "restricted_in_trial",
    "out_of_window",
    "pending_result",
)

# Physiological bounds, by declared concept. These are plausibility (is this a
# possible human?), not conformance (does it match the dictionary) — Kahn draws
# the line there and so does this file. Units are the ones named beside them.
PLAUSIBLE_RANGES = {
    "age": (0.0, 130.0, "year"),
    "weight": (0.3, 500.0, "kg"),
    "height": (20.0, 260.0, "cm"),
    "bmi": (8.0, 100.0, "kg/m2"),
    "heart_rate": (10.0, 300.0, "bpm"),
    "systolic_bp": (30.0, 300.0, "mmHg"),
    "diastolic_bp": (10.0, 200.0, "mmHg"),
    "temperature": (25.0, 45.0, "C"),
}

# Coding systems whose values have a decidable shape. An unknown system is
# reported as such rather than silently passed (C2-25).
CODING_SHAPES = {
    "icd10": re.compile(r"^[A-Z]\d{2}(?:\.\d+)?(?:[xX]\d+)?$"),
    "icd10-cn": re.compile(r"^[A-Z]\d{2}(?:\.\d+)?(?:[xX]\d+)?(?:\+?[A-Z]\d{2}(?:\.\d+)?)?$"),
    "loinc": re.compile(r"^\d{1,5}-\d$"),
    "gbt15657": re.compile(r"^[A-Z]{2}[A-Z0-9]{2,6}$"),
    "atc": re.compile(r"^[A-Z]\d{2}[A-Z]{2}\d{2}$"),
}

# A scale mistake has to hold for the column, not for a cell.
UNIT_SUSPECT_SHARE = 0.9
UNIT_FACTORS = (-3, -2, -1, 1, 2, 3)

# Below this many people a vocabulary entry is a cell of individuals, not a
# category. Mirrors `VCR_MIN_CELL_SIZE`; the control plane passes it in so the
# domain stays the single place it is written.
DEFAULT_MIN_CELL_SIZE = 10

# Conventional subject-key column names, used when the field map does not say.
SUBJECT_KEY_NAMES = ("USUBJID", "SUBJID", "PATIENT_ID", "PATIENTID", "SUBJECT_ID", "PID")

DATE_FORMATS = ("%Y-%m-%d", "%Y/%m/%d", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S")


def load_profiler(path: Path):
    """Import the dataset profiler by path, or say exactly which file is missing."""
    if not path.is_file():
        raise SystemExit(
            f"the column profiler is not at {path}. "
            "Pass --profiler with the path to profile_dataset.py."
        )
    spec = importlib.util.spec_from_file_location("evimed_profile_dataset", path)
    if spec is None or spec.loader is None:  # pragma: no cover - importlib contract
        raise SystemExit(f"{path} could not be loaded as a Python module.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------------------
# Small deterministic helpers
# ---------------------------------------------------------------------------


def as_number(value: str):
    try:
        number = float(str(value).strip())
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def as_date(value: str):
    text = str(value).strip()
    if not text:
        return None
    for shape in DATE_FORMATS:
        try:
            parsed = datetime.strptime(text[: len(shape) + 8] if "T" in shape or " " in shape else text[:10], shape)
        except ValueError:
            continue
        return parsed.replace(tzinfo=timezone.utc)
    # ISO with a zone, which strptime above does not take.
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def round4(value: float) -> float:
    return round(float(value), 4)


def finding(category: str, check: str, table: str, column, rows: int, message: str, **detail) -> dict:
    """One quality finding. Every one is advisory; none withholds a snapshot."""
    entry = {
        "category": category,
        "check": check,
        "table": table,
        "column": column,
        "rows": int(rows),
        "severity": "advisory",
        "message": message,
    }
    for key, value in sorted(detail.items()):
        entry[key] = value
    return entry


# ---------------------------------------------------------------------------
# The field map
# ---------------------------------------------------------------------------


def read_field_map(args) -> dict:
    if args.field_map:
        return json.loads(Path(args.field_map).read_text(encoding="utf-8"))
    if not sys.stdin.isatty():
        body = sys.stdin.read().strip()
        if body:
            return json.loads(body)
    return {}


def map_for(field_map: dict, table: str, column: str) -> dict:
    """`table.column` wins over a bare `column`, so two tables can disagree."""
    entry = field_map.get(f"{table}.{column}")
    if entry is None:
        entry = field_map.get(column)
    return entry if isinstance(entry, dict) else {}


def resolved_field_map(field_map: dict, tables: list) -> dict:
    """The map as it applies, one entry per real column of the snapshot."""
    resolved = {}
    for name, header, _rows in tables:
        for column in header:
            entry = map_for(field_map, name, str(column))
            if not entry:
                continue
            resolved[f"{name}.{column}"] = {
                "concept": entry.get("concept", ""),
                "unit": entry.get("unit"),
                "codingSystem": entry.get("codingSystem"),
                "timeKind": entry.get("timeKind"),
                "missingReason": entry.get("missingReason"),
                "identifier": bool(entry.get("identifier", False)),
                "required": bool(entry.get("required", False)),
                "range": entry.get("range"),
                "type": entry.get("type"),
                "subjectKey": bool(entry.get("subjectKey", False)),
            }
    return resolved


def clocks_of(field_map: dict, tables: list) -> dict:
    clocks = {kind: [] for kind in TIME_KINDS}
    unmapped = []
    for name, header, _rows in tables:
        for column in header:
            kind = map_for(field_map, name, str(column)).get("timeKind")
            key = f"{name}.{column}"
            if kind in clocks:
                clocks[kind].append(key)
            else:
                unmapped.append(key)
    return {**{kind: sorted(values) for kind, values in clocks.items()}, "unmapped": sorted(unmapped)}


# ---------------------------------------------------------------------------
# `--as-of`: what the platform could see then (AC-15, data side)
# ---------------------------------------------------------------------------


def restrict_to_as_of(tables: list, field_map: dict, as_of):
    """Drop rows whose platform-visible date is after `as_of`.

    A row with no visible date is dropped too: "we do not know when we could
    see this" is not "we could always see it", and admitting it is exactly the
    time-travel the replay exists to prevent.
    """
    if as_of is None:
        return tables, {"applied": False, "hidden": 0, "undated": 0, "column": None}
    hidden = 0
    undated = 0
    column_used = None
    out = []
    for name, header, rows in tables:
        visible_columns = [
            index
            for index, column in enumerate(header)
            if map_for(field_map, name, str(column)).get("timeKind") == "visible_at"
        ]
        if not visible_columns:
            out.append((name, header, rows))
            continue
        index = visible_columns[0]
        column_used = column_used or f"{name}.{header[index]}"
        kept = []
        for row in rows:
            stamp = as_date(row[index]) if index < len(row) else None
            if stamp is None:
                undated += 1
                continue
            if stamp <= as_of:
                kept.append(row)
            else:
                hidden += 1
        out.append((name, header, kept))
    return out, {"applied": True, "hidden": hidden, "undated": undated, "column": column_used}


# ---------------------------------------------------------------------------
# The five Kahn categories
# ---------------------------------------------------------------------------


def conformance_findings(tables: list, field_map: dict, sealed: set, profiler) -> list:
    findings = []
    declared = set()
    for key in field_map:
        declared.add(key.split(".", 1)[-1])
    present = {str(column) for _name, header, _rows in tables for column in header}
    for column in sorted(declared - present):
        findings.append(
            finding(
                "conformance",
                "relational-conformance",
                "",
                column,
                1,
                f"字段映射声明了 {column}，快照里没有这一列。",
            )
        )
    for name, header, rows in tables:
        for index, column in enumerate(header):
            key = f"{name}.{column}"
            if key in sealed or str(column) in sealed:
                continue
            entry = map_for(field_map, name, str(column))
            if not entry:
                continue
            cells = [row[index] if index < len(row) else "" for row in rows]
            filled = [str(cell).strip() for cell in cells if str(cell).strip()]
            # Declared type versus the narrowest type the values satisfy.
            declared_type = entry.get("type")
            if declared_type:
                inferred = profiler.infer_type(filled)
                if inferred != "empty" and inferred != declared_type:
                    findings.append(
                        finding(
                            "conformance",
                            "value-type-conformance",
                            name,
                            str(column),
                            len(filled),
                            f"字段映射声明为 {declared_type}，实际取值形态是 {inferred}。",
                            declaredType=declared_type,
                            inferredType=inferred,
                        )
                    )
            bounds = entry.get("range")
            if isinstance(bounds, (list, tuple)) and len(bounds) == 2:
                low, high = float(bounds[0]), float(bounds[1])
                numbers = [value for value in (as_number(cell) for cell in filled) if value is not None]
                outside = [value for value in numbers if value < low or value > high]
                if outside:
                    findings.append(
                        finding(
                            "conformance",
                            "value-range-conformance",
                            name,
                            str(column),
                            len(outside),
                            f"{len(outside)} 个取值超出字段映射声明的范围 [{low}, {high}]。",
                            declaredRange=[low, high],
                            unit=entry.get("unit"),
                        )
                    )
                    # A whole column outside its declared range, and inside the
                    # same range scaled by a power of ten, is a unit mistake
                    # with a correction factor — not a column of typos.
                    if numbers and len(outside) / len(numbers) >= UNIT_SUSPECT_SHARE:
                        for power in UNIT_FACTORS:
                            scale = 10.0**power
                            inside = [value for value in numbers if low * scale <= value <= high * scale]
                            if len(inside) / len(numbers) >= UNIT_SUSPECT_SHARE:
                                findings.append(
                                    finding(
                                        "conformance",
                                        "unit-scale-mismatch",
                                        name,
                                        str(column),
                                        len(numbers),
                                        f"整列取值像是按 {scale:g} 倍记录的；声明单位是 {entry.get('unit') or '未声明'}。",
                                        suspectedFactor=round4(1.0 / scale),
                                        declaredRange=[low, high],
                                        unit=entry.get("unit"),
                                    )
                                )
                                break
            system = entry.get("codingSystem")
            if system:
                shape = CODING_SHAPES.get(str(system))
                if shape is None:
                    findings.append(
                        finding(
                            "conformance",
                            "coding-system-unknown",
                            name,
                            str(column),
                            1,
                            f"编码体系 {system} 不在本版已知的体系里，取值无法校验。",
                            codingSystem=str(system),
                        )
                    )
                else:
                    bad = [value for value in filled if not shape.match(value)]
                    if bad:
                        findings.append(
                            finding(
                                "conformance",
                                "coding-conformance",
                                name,
                                str(column),
                                len(bad),
                                f"{len(bad)} 个取值不符合 {system} 的编码形态。",
                                codingSystem=str(system),
                            )
                        )
    return findings


def completeness_findings(tables: list, field_map: dict, sealed: set) -> list:
    findings = []
    for name, header, rows in tables:
        for index, column in enumerate(header):
            key = f"{name}.{column}"
            if key in sealed or str(column) in sealed:
                continue
            cells = [row[index] if index < len(row) else "" for row in rows]
            blanks = sum(1 for cell in cells if not str(cell).strip())
            if not blanks:
                continue
            entry = map_for(field_map, name, str(column))
            reason = entry.get("missingReason")
            if entry.get("required") and blanks:
                findings.append(
                    finding(
                        "completeness",
                        "required-field-missing",
                        name,
                        str(column),
                        blanks,
                        f"这一列声明为必填，有 {blanks} 行为空。",
                        fillRate=round4((len(cells) - blanks) / len(cells)) if cells else 0.0,
                    )
                )
            if reason is None:
                findings.append(
                    finding(
                        "completeness",
                        "missing-reason-undeclared",
                        name,
                        str(column),
                        blanks,
                        f"有 {blanks} 行为空，字段映射没有说明缺失原因。",
                    )
                )
            elif reason not in MISSING_REASONS:
                findings.append(
                    finding(
                        "completeness",
                        "missing-reason-unknown",
                        name,
                        str(column),
                        blanks,
                        f"缺失原因 {reason} 不在词表内。",
                        missingReason=str(reason),
                    )
                )
            elif reason in UNKNOWN_REASONS:
                findings.append(
                    finding(
                        "completeness",
                        "unknown-is-not-absence",
                        name,
                        str(column),
                        blanks,
                        f"{blanks} 行的缺失原因是「{reason}」：这些取值是未知，不能当作没有发生。",
                        missingReason=str(reason),
                    )
                )
    return findings


def plausibility_findings(tables: list, field_map: dict, sealed: set, as_of) -> list:
    findings = []
    horizon = as_of or datetime.now(timezone.utc)
    for name, header, rows in tables:
        # Biologically impossible values, by declared concept.
        for index, column in enumerate(header):
            key = f"{name}.{column}"
            if key in sealed or str(column) in sealed:
                continue
            entry = map_for(field_map, name, str(column))
            concept = str(entry.get("concept") or "")
            bounds = PLAUSIBLE_RANGES.get(concept)
            cells = [row[index] if index < len(row) else "" for row in rows]
            filled = [str(cell).strip() for cell in cells if str(cell).strip()]
            if bounds:
                low, high, unit = bounds
                impossible = [
                    value
                    for value in (as_number(cell) for cell in filled)
                    if value is not None and (value < low or value > high)
                ]
                if impossible:
                    findings.append(
                        finding(
                            "plausibility",
                            "atemporal-implausible-value",
                            name,
                            str(column),
                            len(impossible),
                            f"{len(impossible)} 个取值超出 {concept} 的生理可能范围 [{low}, {high}] {unit}。",
                            concept=concept,
                            plausibleRange=[low, high],
                            unit=unit,
                        )
                    )
            # A date after the horizon happened after we asked.
            if entry.get("timeKind") or "date" in str(column).lower() or "dt" in str(column).lower():
                future = [
                    cell
                    for cell in filled
                    if (parsed := as_date(cell)) is not None and parsed > horizon
                ]
                if future:
                    findings.append(
                        finding(
                            "plausibility",
                            "temporal-future-date",
                            name,
                            str(column),
                            len(future),
                            f"{len(future)} 个日期晚于本次剖析的时间点。",
                            asOf=horizon.date().isoformat(),
                        )
                    )
        # The three clocks must not run backwards within a row.
        positions = {}
        for kind in TIME_KINDS:
            for index, column in enumerate(header):
                if map_for(field_map, name, str(column)).get("timeKind") == kind:
                    positions[kind] = index
                    break
        for earlier, later in (("occurred_at", "recorded_at"), ("recorded_at", "visible_at")):
            if earlier not in positions or later not in positions:
                continue
            bad = 0
            for row in rows:
                first = as_date(row[positions[earlier]]) if positions[earlier] < len(row) else None
                second = as_date(row[positions[later]]) if positions[later] < len(row) else None
                if first is None or second is None:
                    continue
                if second < first:
                    bad += 1
            if bad:
                findings.append(
                    finding(
                        "plausibility",
                        "temporal-clock-order",
                        name,
                        f"{header[positions[earlier]]}→{header[positions[later]]}",
                        bad,
                        f"{bad} 行的「{later}」早于「{earlier}」：三种时间的先后不成立。",
                        earlier=earlier,
                        later=later,
                    )
                )
    return findings


def subject_key_indexes(header, name: str, field_map: dict) -> list:
    """Which columns identify the person a row belongs to."""
    declared = [
        index
        for index, column in enumerate(header)
        if map_for(field_map, name, str(column)).get("subjectKey")
        or map_for(field_map, name, str(column)).get("concept") == "subject"
    ]
    if declared:
        return declared
    return [index for index, column in enumerate(header) if str(column).upper() in SUBJECT_KEY_NAMES]


def duplication_findings(tables: list, field_map: dict) -> list:
    findings = []
    for name, header, rows in tables:
        # A subject key that repeats in a one-row-per-subject table, and exact
        # duplicate rows anywhere. Both are the same defect to a reader of the
        # count and different defects to whoever has to fix the export.
        for index in subject_key_indexes(header, name, field_map):
            counts = Counter(
                str(row[index]).strip() for row in rows if index < len(row) and str(row[index]).strip()
            )
            repeated = {key: count for key, count in counts.items() if count > 1}
            if repeated:
                findings.append(
                    finding(
                        "duplication",
                        "duplicate-subject-id",
                        name,
                        str(header[index]),
                        sum(repeated.values()) - len(repeated),
                        f"{len(repeated)} 个受试者编号在这张表里出现多次。",
                        distinctRepeated=len(repeated),
                    )
                )
        seen = Counter(tuple(str(cell).strip() for cell in row) for row in rows)
        exact = {key: count for key, count in seen.items() if count > 1}
        if exact:
            findings.append(
                finding(
                    "duplication",
                    "duplicate-rows",
                    name,
                    None,
                    sum(exact.values()) - len(exact),
                    f"{len(exact)} 组完全相同的行出现了不止一次。",
                    distinctRepeated=len(exact),
                )
            )
    return findings


def linkage_findings(joins: list) -> list:
    findings = []
    for join in joins:
        if not join.get("reachable"):
            findings.append(
                finding(
                    "linkage",
                    "join-unreachable",
                    join.get("left", "").split(".", 1)[0],
                    join.get("left"),
                    1,
                    f"{join.get('left')} 与 {join.get('right')} 之间没有可达的关联：{join.get('reason') or '两侧没有共同取值'}。",
                    right=join.get("right"),
                    containment=join.get("containment", 0.0),
                )
            )
        elif float(join.get("containment") or 0.0) < 1.0:
            findings.append(
                finding(
                    "linkage",
                    "join-partial-containment",
                    join.get("left", "").split(".", 1)[0],
                    join.get("left"),
                    1,
                    f"{join.get('left')} 只有 {round4(float(join.get('containment') or 0.0) * 100)}% 的取值能在 {join.get('right')} 找到对应。",
                    right=join.get("right"),
                    containment=round4(float(join.get("containment") or 0.0)),
                )
            )
    return findings


# ---------------------------------------------------------------------------
# Sealing
# ---------------------------------------------------------------------------


def suppress_small_vocabularies(profile: dict, minimum: int) -> None:
    """Drop every vocabulary entry standing for fewer than `minimum` rows.

    In place. A category that 340 people share is a category; a value three
    people share is those three people. The count of what was dropped stays,
    so a reader is told the vocabulary is partial rather than shown a hole.
    """
    for table in profile.get("tables", []):
        for column in table.get("columns", []):
            vocabulary = column.get("vocabulary") or {}
            values = vocabulary.get("values") or []
            kept = [pair for pair in values if int(pair[1]) >= minimum]
            vocabulary["suppressedValues"] = len(values) - len(kept)
            vocabulary["minCellSize"] = minimum
            if len(kept) != len(values):
                vocabulary["complete"] = False
            vocabulary["values"] = kept
            column["vocabulary"] = vocabulary
            # The base profiler keeps up to three example composite cells.
            # They are raw values of real rows.
            composites = column.get("compositeSuspects")
            if isinstance(composites, dict):
                composites["examples"] = []


def mask_declared_identifiers(profile: dict, field_map: dict) -> None:
    """Mask every column the field map declares an identifier or a subject key.

    The base profiler decides by name shape and by value shape; neither catches
    `USUBJID`, which is one token with no id-shaped suffix. The study's own
    data dictionary is the authority and it is checked here.
    """
    for table in profile.get("tables", []):
        for column in table.get("columns", []):
            entry = map_for(field_map, table.get("name", ""), str(column.get("name")))
            if not (entry.get("identifier") or entry.get("subjectKey") or entry.get("concept") == "subject"):
                continue
            vocabulary = column.get("vocabulary") or {}
            vocabulary["identifying"] = True
            vocabulary["maskedBy"] = vocabulary.get("maskedBy") or "field-map"
            vocabulary["complete"] = False
            vocabulary["values"] = []
            column["vocabulary"] = vocabulary
            composites = column.get("compositeSuspects")
            if isinstance(composites, dict):
                composites["examples"] = []


def seal_profile(profile: dict, sealed: set) -> None:
    """Replace every sealed column's profile with its name. In place."""
    for table in profile.get("tables", []):
        kept = []
        for column in table.get("columns", []):
            key = f"{table.get('name')}.{column.get('name')}"
            if key in sealed or column.get("name") in sealed:
                kept.append({"name": column.get("name"), "sealed": True})
            else:
                kept.append(column)
        table["columns"] = kept


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def build(args) -> dict:
    profiler = load_profiler(Path(args.profiler) if args.profiler else DEFAULT_PROFILER)
    paths = sorted((Path(p) for p in args.inputs), key=lambda p: p.name)
    missing = [str(p) for p in paths if not p.is_file()]
    if missing:
        raise SystemExit("input file(s) not found: " + ", ".join(missing))

    field_map = read_field_map(args)
    sealed = {word.strip() for word in (args.sealed_fields or "").split(",") if word.strip()}
    minimum = int(args.min_cell_size)
    if minimum < 1:
        raise SystemExit("--min-cell-size must be at least 1")
    as_of = as_date(args.as_of) if args.as_of else None
    if args.as_of and as_of is None:
        raise SystemExit(f"--as-of is not a date: {args.as_of}")

    tables = []
    for path in paths:
        for name, header, rows in profiler.read_table(path):
            tables.append((name, [str(column) for column in header], [[str(cell) for cell in row] for row in rows]))
    tables, as_of_report = restrict_to_as_of(tables, field_map, as_of)

    # The base profile, computed on exactly the rows above.
    base = {"schemaVersion": getattr(profiler, "SCHEMA_VERSION", 1), "tables": []}
    values = {}
    for path in paths:
        digest = profiler.fingerprint(path)
        for name, header, rows in tables:
            if not name.startswith(path.name):
                continue
            columns = []
            for index, column in enumerate(header):
                cells = [row[index] if index < len(row) else "" for row in rows]
                column_profile, distinct = profiler.profile_column(str(column), cells)
                columns.append(column_profile)
                values[(name, str(column))] = distinct
            base["tables"].append(
                {
                    "name": name,
                    "sourceFile": path.name,
                    "sourceFingerprint": digest,
                    "rows": len(rows),
                    "columns": columns,
                }
            )
    profiler.mask_by_value_overlap(base, values)
    mask_declared_identifiers(base, field_map)
    suppress_small_vocabularies(base, minimum)
    base["joins"] = profiler.discover_joins(values)
    base["typeConflicts"] = profiler.find_type_conflicts(base["tables"])
    base["masking"] = profiler.masking_report(base)

    quality = {
        "conformance": conformance_findings(tables, field_map, sealed, profiler),
        "completeness": completeness_findings(tables, field_map, sealed),
        "plausibility": plausibility_findings(tables, field_map, sealed, as_of),
        "duplication": duplication_findings(tables, field_map),
        "linkage": linkage_findings(base["joins"]),
    }
    for category in CATEGORIES:
        quality[category].sort(key=lambda item: (item["check"], item["table"], str(item["column"] or "")))

    # Sealing happens last so the findings above are computed and then dropped
    # for sealed columns, rather than never computed and quietly absent.
    for category in CATEGORIES:
        quality[category] = [
            item
            for item in quality[category]
            if not (
                item["column"] is not None
                and (str(item["column"]) in sealed or f"{item['table']}.{item['column']}" in sealed)
            )
        ]
    seal_profile(base, sealed)

    return {
        "schemaVersion": SCHEMA_VERSION,
        "asOf": as_of.isoformat().replace("+00:00", "Z") if as_of else None,
        "asOfFilter": as_of_report,
        "snapshot": {
            "files": [
                {"name": path.name, "sha256": profiler.fingerprint(path), "bytes": path.stat().st_size}
                for path in paths
            ],
            "tables": len(base["tables"]),
            "rowCount": sum(table["rows"] for table in base["tables"]),
            "columnCount": sum(len(table["columns"]) for table in base["tables"]),
        },
        "profile": base,
        "fieldMap": resolved_field_map(field_map, tables),
        "clocks": clocks_of(field_map, tables),
        "sealed": sorted(sealed),
        "minCellSize": minimum,
        "quality": quality,
        "counts": {
            "findings": sum(len(quality[category]) for category in CATEGORIES),
            **{category: len(quality[category]) for category in CATEGORIES},
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Profile a 虚拟临研 data snapshot.")
    parser.add_argument("inputs", nargs="+", help="CSV, TSV or XLSX files of the snapshot")
    parser.add_argument("--json", dest="json_out", default="snapshot-profile.json", help="output file, or - for stdout")
    parser.add_argument("--field-map", dest="field_map", default=None, help="field-map JSON; stdin is read when absent")
    parser.add_argument("--sealed-fields", dest="sealed_fields", default="", help="comma-separated sealed column names")
    parser.add_argument("--as-of", dest="as_of", default=None, help="restrict to rows visible at this instant")
    parser.add_argument("--min-cell-size", dest="min_cell_size", type=int, default=DEFAULT_MIN_CELL_SIZE,
                        help="vocabulary entries standing for fewer rows than this are dropped")
    parser.add_argument("--profiler", dest="profiler", default=None, help="path to profile_dataset.py")
    args = parser.parse_args()

    profile = build(args)
    body = json.dumps(profile, ensure_ascii=False, indent=2, sort_keys=True)
    if args.json_out == "-":
        sys.stdout.write(body)
    else:
        Path(args.json_out).write_text(body, encoding="utf-8")
        print(
            f"profiled {profile['snapshot']['tables']} table(s), "
            f"{profile['snapshot']['rowCount']} row(s), "
            f"{profile['snapshot']['columnCount']} column(s), "
            f"{profile['counts']['findings']} quality finding(s), "
            f"{len(profile['sealed'])} sealed column(s)"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
