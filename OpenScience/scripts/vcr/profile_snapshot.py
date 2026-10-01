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
  value that exists only in the file. So a vocabulary entry standing for fewer
  than ``--min-cell-size`` (the domain's ``VCR_MIN_CELL_SIZE``) people is not
  printed, and the raw example values the base profiler keeps for composite
  cells are dropped outright.
* **Hiding one small entry is not hiding it.** A column of 340 people on arm A
  and 5 on arm B, with the 5 dropped, still says ``filled: 345`` and
  ``distinct: 2``: the 5 is the difference. So the hidden set is grown, smallest
  entries first, until it holds at least ``--min-cell-size`` people in at least
  two entries — the same rule the runtime's small-cell suppression applies to
  any table it hands a model — and if all the entries together are still too few
  the whole vocabulary is withheld. A hidden entry loses its label as well as its
  count: in a numeric column the label *is* somebody's value. What is left says
  how many entries were hidden (``suppressedValues``) and never which.
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
import csv
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

    A whole table with no `visible_at` column is left as it is and named in the
    report's `whole` — a standalone run has nothing better to do with it. The
    control plane never gets there: freezing a snapshot with a date refuses a
    file that derives rows and has no such column (`as_of_needs_visible_at`),
    and cuts every derived table and raw-file view to the same rows itself, so
    what the profiler counted and what the engine reads are the same rows.
    """
    if as_of is None:
        return tables, {"applied": False, "hidden": 0, "undated": 0, "column": None, "whole": []}
    hidden = 0
    undated = 0
    column_used = None
    whole = []
    out = []
    for name, header, rows in tables:
        visible_columns = [
            index
            for index, column in enumerate(header)
            if map_for(field_map, name, str(column)).get("timeKind") == "visible_at"
        ]
        if not visible_columns:
            whole.append(name)
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
    return out, {"applied": True, "hidden": hidden, "undated": undated, "column": column_used, "whole": sorted(whole)}


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


def absorb_small_entries(values: list, minimum: int):
    """Split a vocabulary into the entries that may be shown and how many were hidden.

    ``values`` is ``[[label, count], ...]``. Every entry under ``minimum`` is
    hidden, then the smallest of the rest are added until the hidden set holds at
    least ``minimum`` people in at least two entries. Ties are broken by position,
    so the same input hides the same entries. Returns ``(shown, hidden_count,
    withheld)``; ``withheld`` is true when even every entry together is too few,
    in which case nothing is shown.
    """
    counts = [int(pair[1]) for pair in values]
    hidden = {index for index, count in enumerate(counts) if count < minimum}
    if not hidden:
        return list(values), 0, False
    rest = sorted((count, index) for index, count in enumerate(counts) if index not in hidden)
    held = sum(counts[index] for index in hidden)
    while (len(hidden) < 2 or held < minimum) and rest:
        count, index = rest.pop(0)
        hidden.add(index)
        held += count
    if len(hidden) < 2 or held < minimum:
        return [], len(values), True
    return [pair for index, pair in enumerate(values) if index not in hidden], len(hidden), False


def suppress_small_vocabularies(profile: dict, minimum: int) -> None:
    """Apply :func:`absorb_small_entries` to every column's vocabulary. In place.

    A category that 340 people share is a category; a value three people share
    is those three people. The number of hidden entries stays, so a reader is
    told the vocabulary is partial rather than shown a hole.
    """
    for table in profile.get("tables", []):
        for column in table.get("columns", []):
            vocabulary = column.get("vocabulary") or {}
            values = vocabulary.get("values") or []
            shown, hidden, withheld = absorb_small_entries(values, minimum)
            vocabulary["suppressedValues"] = hidden
            vocabulary["minCellSize"] = minimum
            if hidden:
                vocabulary["complete"] = False
            if withheld:
                vocabulary["withheld"] = True
            vocabulary["values"] = shown
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
# XLSX -> CSV (standard library only)
# ---------------------------------------------------------------------------
#
# The web image has Python and nothing else: no openpyxl, and no way to install
# it at run time. A hospital's own export is an .xlsx more often than a .csv, and
# refusing it would send the data manager back to Excel for a step the platform
# can do. So a workbook is read here with `zipfile` and `xml.etree` and turned
# into the CSV the rest of the pipeline reads. Only the *cached values* are read
# (a formula's last result), a merged cell is its top-left value, and dates are
# written as dates — an Excel date is a number plus a number format, and a
# converter that ignores the format writes 45658 where the study needs
# 2025-01-01.
#
# A workbook is untrusted input, so the reader is bounded on every side: the
# archive's member count and uncompressed size, each XML part's size, and the
# rows and columns written. An XML part that declares a DOCTYPE or an entity is
# refused outright — nothing in a worksheet needs one, and an entity is how a
# small part becomes a large one.

XLSX_MAX_MEMBERS = 2000
XLSX_MAX_TOTAL_BYTES = 400 * 1024 * 1024
XLSX_MAX_PART_BYTES = 200 * 1024 * 1024
XLSX_MAX_ROWS = 1_048_576
XLSX_MAX_COLUMNS = 2000
_NS_MAIN = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_NS_REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
_NS_PKG_REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"
# Built-in number formats that are dates and/or times (ECMA-376 18.8.30).
_BUILTIN_DATE_FORMATS = frozenset(list(range(14, 23)) + list(range(27, 37)) + list(range(45, 48)) + list(range(50, 59)))
_BUILTIN_TIME_ONLY = frozenset({18, 19, 20, 21, 45, 46, 47})


class XlsxError(Exception):
    """A workbook this reader will not or cannot read; the message is safe to show."""


def _xlsx_part(archive, name: str) -> bytes:
    try:
        info = archive.getinfo(name)
    except KeyError as error:
        raise XlsxError(f"the workbook has no part {name}") from error
    if info.file_size > XLSX_MAX_PART_BYTES:
        raise XlsxError(f"the workbook part {name} is larger than this reader accepts")
    data = archive.read(name)
    head = data[:4096].lower()
    if b"<!doctype" in head or b"<!entity" in head:
        raise XlsxError(f"the workbook part {name} declares a DOCTYPE, which a worksheet never needs")
    return data


def _column_index(reference: str) -> int:
    letters = ""
    for character in reference:
        if character.isalpha():
            letters += character
        else:
            break
    index = 0
    for character in letters.upper():
        index = index * 26 + (ord(character) - 64)
    return index - 1


def _date_format_kind(code: str) -> str:
    """'date', 'time', 'datetime' or '' for a custom number-format code."""
    stripped = []
    quoted = False
    bracket = False
    escape = False
    for character in code:
        if escape:
            escape = False
            continue
        if character == "\\":
            escape = True
            continue
        if character == '"':
            quoted = not quoted
            continue
        if quoted:
            continue
        if character == "[":
            bracket = True
            continue
        if character == "]":
            bracket = False
            continue
        if bracket:
            # [h] and [mm] and [ss] are elapsed-time markers; the rest are colours and locales.
            if character.lower() in "hms":
                stripped.append(character.lower())
            continue
        stripped.append(character.lower())
    text = "".join(stripped)
    has_time = any(token in text for token in ("h", "s")) or "am/pm" in text or "a/p" in text
    has_date = any(token in text for token in ("y", "d")) or (("m" in text) and not has_time)
    if has_date and has_time:
        return "datetime"
    if has_time:
        return "time"
    if has_date:
        return "date"
    return ""


def _excel_serial(value: float, date1904: bool, kind: str) -> str:
    from datetime import timedelta

    epoch = datetime(1904, 1, 1) if date1904 else datetime(1899, 12, 30)
    if kind == "time":
        seconds = round((value % 1) * 86400)
        return f"{seconds // 3600 % 24:02d}:{seconds // 60 % 60:02d}:{seconds % 60:02d}"
    moment = epoch + timedelta(seconds=round(value * 86400))
    if kind == "date" or (moment.hour == 0 and moment.minute == 0 and moment.second == 0 and kind != "datetime"):
        return moment.strftime("%Y-%m-%d")
    return moment.strftime("%Y-%m-%d %H:%M:%S")


def _number_text(raw: str) -> str:
    try:
        number = float(raw)
    except ValueError:
        return raw
    if not math.isfinite(number):
        return ""
    if number == int(number) and abs(number) < 1e15:
        return str(int(number))
    return repr(number)


def _shared_string_text(item) -> str:
    """A shared string's text: its `<t>` and its runs, never the phonetic hints (furigana)."""
    parts = []
    for child in item:
        if child.tag == f"{_NS_MAIN}t":
            parts.append(child.text or "")
        elif child.tag == f"{_NS_MAIN}r":
            for node in child.findall(f"{_NS_MAIN}t"):
                parts.append(node.text or "")
    return "".join(parts)


def convert_xlsx(path: Path, sheet=None):
    """Read one worksheet of a workbook. Returns ``(rows, sheets, used)``.

    ``rows`` is a list of lists of strings with every fully empty row removed;
    ``sheets`` is the workbook's visible sheet names; ``used`` is the one read.
    """
    import xml.etree.ElementTree as ET
    import zipfile

    try:
        archive = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError) as error:
        raise XlsxError("the file is not an .xlsx workbook") from error
    with archive:
        members = archive.infolist()
        if len(members) > XLSX_MAX_MEMBERS or sum(item.file_size for item in members) > XLSX_MAX_TOTAL_BYTES:
            raise XlsxError("the workbook is larger than this reader accepts")
        if any(item.flag_bits & 0x1 for item in members):
            raise XlsxError("the workbook is password protected")
        names = set(archive.namelist())
        if "xl/workbook.xml" not in names:
            raise XlsxError("the file is not an .xlsx workbook")
        workbook = ET.fromstring(_xlsx_part(archive, "xl/workbook.xml"))
        properties = workbook.find(f"{_NS_MAIN}workbookPr")
        date1904 = properties is not None and properties.get("date1904") in ("1", "true")
        rels = {}
        if "xl/_rels/workbook.xml.rels" in names:
            for rel in ET.fromstring(_xlsx_part(archive, "xl/_rels/workbook.xml.rels")).findall(f"{_NS_PKG_REL}Relationship"):
                rels[rel.get("Id")] = rel.get("Target") or ""
        sheets = []
        for node in workbook.findall(f"{_NS_MAIN}sheets/{_NS_MAIN}sheet"):
            if node.get("state") in ("hidden", "veryHidden"):
                continue
            target = rels.get(node.get(f"{_NS_REL}id"), "").lstrip("/")
            if target and not target.startswith("xl/"):
                target = "xl/" + target
            sheets.append((node.get("name") or "", target))
        if not sheets:
            raise XlsxError("the workbook has no visible worksheet")

        shared = []
        if "xl/sharedStrings.xml" in names:
            for item in ET.fromstring(_xlsx_part(archive, "xl/sharedStrings.xml")).findall(f"{_NS_MAIN}si"):
                shared.append(_shared_string_text(item))

        date_styles = {}
        if "xl/styles.xml" in names:
            styles = ET.fromstring(_xlsx_part(archive, "xl/styles.xml"))
            custom = {}
            for fmt in styles.findall(f"{_NS_MAIN}numFmts/{_NS_MAIN}numFmt"):
                custom[int(fmt.get("numFmtId"))] = fmt.get("formatCode") or ""
            for position, xf in enumerate(styles.findall(f"{_NS_MAIN}cellXfs/{_NS_MAIN}xf")):
                fmt_id = int(xf.get("numFmtId") or 0)
                if fmt_id in custom:
                    kind = _date_format_kind(custom[fmt_id])
                elif fmt_id in _BUILTIN_DATE_FORMATS:
                    kind = "time" if fmt_id in _BUILTIN_TIME_ONLY else ("datetime" if fmt_id == 22 else "date")
                else:
                    kind = ""
                if kind:
                    date_styles[position] = kind

        order = list(range(len(sheets)))
        if sheet not in (None, ""):
            chosen = None
            for position, (name, _target) in enumerate(sheets):
                if name == str(sheet):
                    chosen = position
            if chosen is None and str(sheet).isdigit() and 1 <= int(str(sheet)) <= len(sheets):
                chosen = int(str(sheet)) - 1
            if chosen is None:
                raise XlsxError(f"the workbook has no worksheet {sheet}")
            order = [chosen]
        for position in order:
            name, target = sheets[position]
            if not target:
                continue
            rows = _read_sheet(archive, target, shared, date_styles, date1904)
            if rows:
                return rows, [entry[0] for entry in sheets], name
        raise XlsxError("no worksheet of the workbook holds any data")


def _read_sheet(archive, target: str, shared: list, date_styles: dict, date1904: bool) -> list:
    import xml.etree.ElementTree as ET

    if target not in archive.namelist():
        raise XlsxError("a worksheet named by the workbook is missing")
    if archive.getinfo(target).file_size > XLSX_MAX_PART_BYTES:
        raise XlsxError("a worksheet is larger than this reader accepts")
    rows = []
    with archive.open(target) as handle:
        head = handle.read(4096).lower()
    if b"<!doctype" in head or b"<!entity" in head:
        raise XlsxError("a worksheet declares a DOCTYPE, which a worksheet never needs")
    with archive.open(target) as handle:
        for _event, element in ET.iterparse(handle, events=("end",)):
            if element.tag != f"{_NS_MAIN}row":
                continue
            cells = {}
            width = 0
            for cell in element.findall(f"{_NS_MAIN}c"):
                reference = cell.get("r") or ""
                column = _column_index(reference) if reference else width
                if column < 0 or column >= XLSX_MAX_COLUMNS:
                    continue
                kind = cell.get("t") or "n"
                value_node = cell.find(f"{_NS_MAIN}v")
                text = value_node.text if value_node is not None and value_node.text is not None else ""
                if kind == "s":
                    try:
                        text = shared[int(text)]
                    except (ValueError, IndexError):
                        text = ""
                elif kind == "inlineStr":
                    text = "".join(node.text or "" for node in cell.iter(f"{_NS_MAIN}t"))
                elif kind == "b":
                    text = "1" if text.strip() == "1" else "0"
                elif kind == "e":
                    text = ""
                elif kind in ("str", "d"):
                    pass
                elif text != "":
                    style = int(cell.get("s") or 0)
                    if style in date_styles:
                        try:
                            text = _excel_serial(float(text), date1904, date_styles[style])
                        except (ValueError, OverflowError):
                            pass
                    else:
                        text = _number_text(text)
                if text != "":
                    cells[column] = text
                    width = max(width, column + 1)
            element.clear()
            if not cells:
                continue
            if len(rows) >= XLSX_MAX_ROWS:
                raise XlsxError("the worksheet has more rows than a worksheet can")
            rows.append([cells.get(index, "") for index in range(width)])
    return rows


def convert_xlsx_main(args) -> int:
    if not args.convert_to:
        raise SystemExit("--convert-xlsx needs --to")
    try:
        rows, sheets, used = convert_xlsx(Path(args.convert_xlsx), args.convert_sheet)
    except XlsxError as error:
        sys.stderr.write(f"xlsx: {error}\n")
        return 3
    width = max((len(row) for row in rows), default=0)
    with open(args.convert_to, "w", encoding="utf-8", newline="") as out:
        writer = csv.writer(out, lineterminator="\n")
        for row in rows:
            writer.writerow(row + [""] * (width - len(row)))
    sys.stdout.write(json.dumps({"sheets": sheets, "used": used, "rows": len(rows), "columns": width}, ensure_ascii=False))
    return 0


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def build(args) -> dict:
    profiler = load_profiler(Path(args.profiler) if args.profiler else DEFAULT_PROFILER)
    names = list(args.table_name or [])
    if names and len(names) != len(args.inputs):
        raise SystemExit("--table-name is given once per input file, in the same order")
    # A file is known by the name it was uploaded under, not by the content hash
    # it is stored as: the profile is read by people and by a model, and
    # ``3f9c…e1.csv`` tells neither of them what the table is.
    entries = sorted(
        ((Path(path), names[index] if names else Path(path).name) for index, path in enumerate(args.inputs)),
        key=lambda entry: entry[1],
    )
    paths = [path for path, _display in entries]
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
    origin = {}
    for path, display in entries:
        for name, header, rows in profiler.read_table(path):
            shown = display + name[len(path.name):]
            origin[shown] = (path, display)
            tables.append((shown, [str(column) for column in header], [[str(cell) for cell in row] for row in rows]))
    tables, as_of_report = restrict_to_as_of(tables, field_map, as_of)

    # The base profile, computed on exactly the rows above.
    base = {"schemaVersion": getattr(profiler, "SCHEMA_VERSION", 1), "tables": []}
    values = {}
    fingerprints = {path: profiler.fingerprint(path) for path in paths}
    for name, header, rows in tables:
        path, display = origin[name]
        columns = []
        for index, column in enumerate(header):
            cells = [row[index] if index < len(row) else "" for row in rows]
            column_profile, distinct = profiler.profile_column(str(column), cells)
            columns.append(column_profile)
            values[(name, str(column))] = distinct
        base["tables"].append(
            {
                "name": name,
                "sourceFile": display,
                "sourceFingerprint": fingerprints[path],
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
                {"name": display, "sha256": fingerprints[path], "bytes": path.stat().st_size}
                for path, display in entries
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
    parser.add_argument("inputs", nargs="*", help="CSV, TSV or XLSX files of the snapshot")
    parser.add_argument("--json", dest="json_out", default="snapshot-profile.json", help="output file, or - for stdout")
    parser.add_argument("--field-map", dest="field_map", default=None, help="field-map JSON; stdin is read when absent")
    parser.add_argument("--sealed-fields", dest="sealed_fields", default="", help="comma-separated sealed column names")
    parser.add_argument("--as-of", dest="as_of", default=None, help="restrict to rows visible at this instant")
    parser.add_argument("--min-cell-size", dest="min_cell_size", type=int, default=DEFAULT_MIN_CELL_SIZE,
                        help="vocabulary entries standing for fewer rows than this are dropped")
    parser.add_argument("--profiler", dest="profiler", default=None, help="path to profile_dataset.py")
    parser.add_argument("--table-name", dest="table_name", action="append", default=None,
                        help="the name to profile a file under; once per input, in input order")
    parser.add_argument("--convert-xlsx", dest="convert_xlsx", default=None, metavar="XLSX",
                        help="convert one worksheet of this workbook to UTF-8 CSV and exit; --to names the output")
    parser.add_argument("--to", dest="convert_to", default=None, help="output path of --convert-xlsx")
    parser.add_argument("--sheet", dest="convert_sheet", default=None,
                        help="worksheet to convert: a name or a 1-based position (default: the first with data)")
    args = parser.parse_args()
    if args.convert_xlsx:
        return convert_xlsx_main(args)
    if not args.inputs:
        parser.error("at least one input file is required")

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
