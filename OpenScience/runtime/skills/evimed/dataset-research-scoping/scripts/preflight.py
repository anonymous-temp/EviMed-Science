#!/usr/bin/env python3
"""Deterministic preflight for dataset research scoping deliverables.

Blocks on the four things a reader cannot check for themselves:

1. an identifier copied out of the source data,
2. profile numbers that do not match the script that claims to produce them,
3. an infeasible verdict that does not name the field it is missing, does not
   show that the gap actually binds, or does not say what the data can still
   answer,
4. a post-hoc power calculation.

Warns on four a reader can see: an unqualified fill rate, an unexplained blank
in the seven-element matrix, an external resource with no join key, and a
preprocessing item with no stated consequence.

It does not check how many candidate questions were produced. The right number
depends on the data, and a quota would only teach runs to pad.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

REQUIRED_OUTPUTS = (
    "data-profile.md",
    "data-profile.py",
    "data-quality.md",
    "feasibility-matrix.md",
    "external-linkage.md",
    "research-portfolio.md",
    "study-protocol.md",
    "scoping-run.json",
)
PROSE_OUTPUTS = (
    "data-profile.md",
    "data-quality.md",
    "feasibility-matrix.md",
    "external-linkage.md",
    "research-portfolio.md",
    "study-protocol.md",
)
# Columns whose values identify a person or an episode of care. Their values may
# never leave the data; a run refers to subjects by pseudonyms it assigns.
# Kept identical to profile_dataset.py's rule. Matching the subject word alone
# swept in RECORD_DATE and RECORD_CONTENT, whose values are timestamps and
# clinical text: every date in the report would then have read as a leaked
# identifier and blocked a sound package.
IDENTIFIER_EXPLICIT = re.compile(r"^(?:id|mrn|姓名|患者姓名|身份证号?|病案号|住院号|门诊号|就诊号)$", re.I)
IDENTIFIER_SUBJECT = re.compile(
    r"(?:patient|subject|person|case|record|admission|visit|encounter|inpatient|"
    r"病案|住院|门诊|患者|病人|就诊)",
    re.I,
)
IDENTIFIER_SUFFIX = re.compile(r"(?:^|_)(?:id|no|num|number|code)$", re.I)


def is_identifying(name: str) -> bool:
    """True when a column's values identify a person or an episode of care."""
    return bool(
        IDENTIFIER_EXPLICIT.match(name.strip())
        or (IDENTIFIER_SUBJECT.search(name) and IDENTIFIER_SUFFIX.search(name))
    )
# An identifier short enough to collide with an ordinary number in prose is not
# evidence of leakage; below this length a match is not reported.
IDENTIFIER_MIN_LENGTH = 5
POST_HOC_POWER = re.compile(
    r"(?:事后功效|事后检验效能|观测功效|观察到的功效|post[\s-]?hoc power|observed power|retrospective power)",
    re.I,
)
INFEASIBLE_LINE = re.compile(r"(?:不可行|infeasible|not feasible)", re.I)
MISSING_FIELD_LINE = re.compile(r"(?:缺失字段|缺少字段|缺字段|missing field|missing column)", re.I)
# Naming the missing field was the whole bar, and it turned out to reward
# refusal: a run could discharge its duty by pointing at an absent column and
# never ask what the data could still answer. An infeasible verdict now also
# owes the strongest remaining question, or an explicit statement that none
# exists — stated somewhere in the matrix, not necessarily on the verdict line.
FALLBACK_MENTION = re.compile(
    r"(?:退而求其次|降级|替代设计|仍可|仍然可以|还能|可改为|可降级为|弱化为|"
    r"fallback|degraded design|can still|weaker question|instead answer)",
    re.I,
)
# A binding test: the gap was compared against something in the same units
# rather than asserted from a general rule about what a method requires.
BINDING_TEST = re.compile(
    r"(?:半衰期|给药间隔|变异(?:度|系数)|CV|倍|数量级|相对极差|敏感性分析|"
    r"half-life|dosing interval|fold|order of magnitude|sensitivity analys)",
    re.I,
)
FILL_RATE_MENTION = re.compile(r"(?:填充率|fill rate|completeness)", re.I)
COMPLETENESS_QUALIFIER = re.compile(r"(?:density|documentation|breadth|predictive|Weiskopf)", re.I)
SEVEN_ELEMENTS = (
    ("eligibility", re.compile(r"(?:入组|合格|纳入)标准|eligibility", re.I)),
    ("treatment", re.compile(r"治疗策略|干预策略|treatment strateg", re.I)),
    ("assignment", re.compile(r"分配机制|assignment procedure", re.I)),
    ("timeZero", re.compile(r"时间零点|随访起[点始]|time zero|follow[- ]up start", re.I)),
    ("outcome", re.compile(r"结局|outcome", re.I)),
    ("contrast", re.compile(r"因果对比|causal contrast", re.I)),
    ("analysisPlan", re.compile(r"分析计划|analysis plan", re.I)),
)
BLANK_CELL = re.compile(r"(?:❌|⚠️|待定|TBD|N/?A|——|—)\s*$")
JOIN_KEY_MENTION = re.compile(r"(?:连接键|关联键|连接字段|join key|linkage key|join on|通过\s*`?\w+`?\s*连接)", re.I)
CONSEQUENCE_MENTION = re.compile(r"(?:否则|不做|将导致|会导致|后果|otherwise|leads to|breaks|invalidat)", re.I)


def read_text(root: Path, name: str) -> str:
    path = root / name
    if not path.is_file():
        return ""
    return path.read_text(encoding="utf-8", errors="replace")


def identifier_values(dataset_paths: list[Path]) -> set[str]:
    """Every value held by an identifier-shaped column of the source data."""
    values: set[str] = set()
    for path in dataset_paths:
        suffix = path.suffix.lower()
        tables: list[tuple[list[str], list[list[str]]]] = []
        if suffix in {".xlsx", ".xlsm"}:
            try:
                from openpyxl import load_workbook
            except ImportError:  # pragma: no cover - environment dependent
                continue
            workbook = load_workbook(path, read_only=True, data_only=True)
            for sheet in workbook.worksheets:
                rows = [["" if c is None else str(c) for c in row] for row in sheet.iter_rows(values_only=True)]
                if rows:
                    tables.append((rows[0], rows[1:]))
            workbook.close()
        else:
            delimiter = "\t" if suffix in {".tsv", ".tab"} else ","
            with path.open("r", encoding="utf-8-sig", newline="") as handle:
                rows = list(csv.reader(handle, delimiter=delimiter))
            if rows:
                tables.append(([str(h) for h in rows[0]], [[str(c) for c in r] for r in rows[1:]]))

        for header, rows in tables:
            for index, column_name in enumerate(header):
                if not is_identifying(str(column_name)):
                    continue
                for row in rows:
                    if index >= len(row):
                        continue
                    value = str(row[index]).strip()
                    if len(value) >= IDENTIFIER_MIN_LENGTH:
                        values.add(value)
    return values


def check_identifier_leakage(root: Path, dataset_paths: list[Path], issues: list[str]) -> int:
    values = identifier_values(dataset_paths)
    if not values:
        return 0
    leaked = 0
    for name in PROSE_OUTPUTS:
        text = read_text(root, name)
        if not text:
            continue
        for value in sorted(values):
            if value in text:
                leaked += 1
                issues.append(
                    f"{name}: carries the source identifier {value!r}. Refer to subjects by a pseudonym you assign."
                )
    return leaked


def check_profile_recomputable(root: Path, dataset_paths: list[Path], issues: list[str]) -> bool:
    script = root / "data-profile.py"
    recorded = root / "data-profile.json"
    if not script.is_file():
        issues.append("data-profile.py is missing: the profile numbers must come from a script that is kept.")
        return False
    if not recorded.is_file():
        issues.append("data-profile.json is missing: data-profile.py must write the machine-readable profile it renders.")
        return False
    if not dataset_paths:
        issues.append(
            "scoping-run.json: priorDataContact.filesReceived names no readable dataset file, "
            "so the profile cannot be recomputed."
        )
        return False
    with tempfile.TemporaryDirectory() as work:
        target = Path(work) / "recomputed.json"
        try:
            completed = subprocess.run(
                [sys.executable, str(script), *[str(p) for p in dataset_paths],
                 "--json", str(target), "--markdown", str(Path(work) / "recomputed.md")],
                cwd=root, capture_output=True, text=True, timeout=600,
            )
        except (OSError, subprocess.SubprocessError) as error:
            issues.append(f"data-profile.py could not be re-run: {error}")
            return False
        if completed.returncode != 0:
            issues.append(f"data-profile.py exited {completed.returncode} when re-run: {completed.stderr.strip()[:400]}")
            return False
        try:
            fresh = json.loads(target.read_text(encoding="utf-8"))
            stored = json.loads(recorded.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            issues.append(f"the recomputed profile could not be compared: {error}")
            return False
    if fresh != stored:
        issues.append(
            "data-profile.json does not match what data-profile.py produces from the same inputs; "
            "the reported numbers are not the script's."
        )
        return False
    return True


def check_infeasible_verdicts(root: Path, issues: list[str]) -> int:
    text = read_text(root, "feasibility-matrix.md")
    if not text.strip():
        issues.append("feasibility-matrix.md is empty: every candidate question needs a verdict.")
        return 0
    verdicts = 0
    for line_number, line in enumerate(text.splitlines(), start=1):
        if not INFEASIBLE_LINE.search(line):
            continue
        verdicts += 1
        if not MISSING_FIELD_LINE.search(line):
            issues.append(
                f"feasibility-matrix.md line {line_number}: an infeasible verdict must name the missing field."
            )
    if verdicts:
        # Whole-document checks: a refusal is only a verdict once it has been
        # shown to bind and the remaining question has been stated. Requiring
        # these per line would force boilerplate onto every row, so they are
        # required of the matrix as a whole.
        if not BINDING_TEST.search(text):
            issues.append(
                "feasibility-matrix.md declares questions infeasible without showing anywhere that the gap "
                "actually binds — compare it against the effect being studied in the same units "
                "(half-life against dosing interval, assay CV against between-subject spread), "
                "rather than citing a general requirement."
            )
        if not FALLBACK_MENTION.search(text):
            issues.append(
                "feasibility-matrix.md declares questions infeasible without naming the strongest question "
                "the data can still answer. State the degraded design and its assumption, or say explicitly "
                "that none exists."
            )
    return verdicts


def check_post_hoc_power(root: Path, issues: list[str]) -> None:
    for name in PROSE_OUTPUTS:
        text = read_text(root, name)
        for line_number, line in enumerate(text.splitlines(), start=1):
            if POST_HOC_POWER.search(line):
                issues.append(
                    f"{name} line {line_number}: post-hoc power is uninformative for a fixed dataset. "
                    "Report the minimum detectable effect and the expected interval width instead."
                )


def check_prior_data_contact(root: Path, issues: list[str]) -> list[Path]:
    raw = read_text(root, "scoping-run.json")
    if not raw.strip():
        issues.append("scoping-run.json is missing.")
        return []
    try:
        receipt = json.loads(raw)
    except json.JSONDecodeError as error:
        issues.append(f"scoping-run.json is not valid JSON: {error}")
        return []
    contact = receipt.get("priorDataContact")
    if not isinstance(contact, dict):
        issues.append(
            "scoping-run.json: priorDataContact is required. Record it before profiling — "
            "written afterwards it records what you already knew."
        )
        return []
    files = contact.get("filesReceived")
    if not isinstance(files, list) or not files:
        issues.append("scoping-run.json: priorDataContact.filesReceived must list the files received.")
        files = []
    for field in ("partsInspected", "outcomeDistributionSeen"):
        if field not in contact:
            issues.append(f"scoping-run.json: priorDataContact.{field} is required.")

    paths = []
    for entry in files:
        if not isinstance(entry, str) or ".." in entry or entry.startswith("/"):
            issues.append(f"scoping-run.json: priorDataContact.filesReceived entry {entry!r} must be a workspace path.")
            continue
        candidate = root / entry
        if candidate.is_file():
            paths.append(candidate)
        else:
            issues.append(f"scoping-run.json: priorDataContact.filesReceived entry {entry!r} does not exist.")
    return sorted(paths, key=lambda p: p.name)


def collect_warnings(root: Path) -> list[str]:
    warnings: list[str] = []

    for name in ("data-profile.md", "data-quality.md"):
        text = read_text(root, name)
        if FILL_RATE_MENTION.search(text) and not COMPLETENESS_QUALIFIER.search(text):
            warnings.append(
                f"{name}: reports a fill rate without saying which of Weiskopf's four completeness "
                "definitions it measures."
            )

    matrix = read_text(root, "feasibility-matrix.md")
    if matrix:
        for label, pattern in SEVEN_ELEMENTS:
            for line in matrix.splitlines():
                if pattern.search(line) and BLANK_CELL.search(line.rstrip()):
                    warnings.append(
                        f"feasibility-matrix.md: the {label} element is left blank without an explanation."
                    )
                    break

    linkage = read_text(root, "external-linkage.md")
    if linkage.strip() and not JOIN_KEY_MENTION.search(linkage):
        warnings.append("external-linkage.md: names resources without naming the field that joins them.")

    quality = read_text(root, "data-quality.md")
    for line in quality.splitlines():
        stripped = line.strip()
        if not stripped.startswith(("-", "*", "|")) or len(stripped) < 8:
            continue
        if re.search(r"(?:预处理|preprocess|清洗|clean)", stripped, re.I) and not CONSEQUENCE_MENTION.search(stripped):
            warnings.append(
                "data-quality.md: a preprocessing item does not say which analysis breaks if it is skipped."
            )
            break

    return warnings


def main() -> int:
    parser = argparse.ArgumentParser(description="Preflight dataset research scoping deliverables.")
    parser.add_argument("--workspace", default=".")
    args = parser.parse_args()
    root = Path(args.workspace).resolve()

    issues: list[str] = []
    for name in REQUIRED_OUTPUTS:
        if not (root / name).is_file():
            issues.append(f"{name} is missing.")

    dataset_paths = check_prior_data_contact(root, issues)
    leaked = check_identifier_leakage(root, dataset_paths, issues)
    recomputable = check_profile_recomputable(root, dataset_paths, issues)
    infeasible = check_infeasible_verdicts(root, issues)
    check_post_hoc_power(root, issues)
    warnings = collect_warnings(root)

    payload = {
        "ok": not issues,
        "workspace": str(root),
        "metrics": {
            "datasetFiles": len(dataset_paths),
            "identifierLeaks": leaked,
            "profileRecomputable": recomputable,
            "infeasibleVerdicts": infeasible,
        },
        "issues": issues,
        "warnings": warnings,
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if not issues else 1


if __name__ == "__main__":
    sys.exit(main())
