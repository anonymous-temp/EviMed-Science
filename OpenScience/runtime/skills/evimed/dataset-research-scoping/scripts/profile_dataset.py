#!/usr/bin/env python3
"""Mechanical data profiling for dataset research scoping.

Single-column profiling, inclusion-dependency discovery across tables, and the
trap detectors that a real hospital extract needed (sentinel dates, a join key
that is present but empty, a column typed differently in two tables, composite
values in one cell).

Deterministic by construction: the same inputs produce byte-identical JSON, so
the preflight can re-run this and compare. Nothing here reads the network, and
no cell value is printed except as an aggregate or a vocabulary entry.

Copy this file into the workspace as data-profile.py and run it there, so the
deliverable regenerates from a deliverable:

    python3 data-profile.py data/*.xlsx --json data-profile.json --markdown data-profile.md
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import sys
from datetime import date
from collections import Counter
from pathlib import Path

SCHEMA_VERSION = 1
# Above this many distinct values a vocabulary is reported as its most frequent
# entries rather than in full; below it, the full vocabulary is the finding.
VOCABULARY_COMPLETE_MAX = 30
VOCABULARY_SAMPLE = 15
# A column whose name looks like a join key is checked for containment in every
# other table that has a column of the same name.
JOIN_KEY_PATTERN = re.compile(r"(?:^|_)(?:id|no|code|key|num|number)$", re.I)
# Columns whose values identify a person or an episode of care. Their cardinality
# and fill rate are findings; their values are not. Printing the vocabulary of a
# five-patient PATIENT_ID column writes five real hospital numbers into the
# deliverable — which is what the preflight's first gate exists to catch, and it
# caught this script doing it. Joins are still computed from the real values;
# they are simply never emitted.
#
# Matching the subject word alone was too broad: RECORD_DATE and RECORD_CONTENT
# contain "record", so a vital-signs table had its most analytic column masked.
# An identifier is a subject word carrying an id-shaped suffix, or one of the
# few names that are identifiers outright.
# Matching the subject word as a substring was too broad (RECORD_DATE), and
# matching it as a whole word was too narrow: a real front-page column is
# MED_REC_NO — the medical record number, abbreviated — which neither rule
# caught, so its full vocabulary of hospital numbers was printed into the
# profile and handed over as a clean deliverable. Names are split into tokens
# and a column identifies when a subject token meets an id-shaped last token.
IDENTIFIER_EXPLICIT = re.compile(r"^(?:id|mrn|姓名|患者姓名|身份证号?|病案号|住院号|门诊号|就诊号)$", re.I)
IDENTIFIER_SUBJECT_TOKENS = frozenset({
    "patient", "subject", "person", "case", "record", "rec", "admission",
    "visit", "encounter", "inpatient", "outpatient", "mrn",
})
# "adm" and "reg" were in this set and masked ADM_DEPT_CODE, the admitting
# department — a covariate, not a person. A subject token must be a word that
# names the subject, not any abbreviation that begins one.
IDENTIFIER_SUFFIX_TOKENS = frozenset({"id", "no", "num", "number", "code", "sn"})
IDENTIFIER_SUBJECT_CJK = re.compile(r"(?:病案|住院|门诊|患者|病人|就诊|身份证|姓名)")


def is_identifying(name: str) -> bool:
    """True when a column's name says its values identify a person or an episode.

    Name only. `identifying_reason` below is what callers should ask: a column
    identifies when its name says so **or** when its values are shaped like an
    identity number, a phone number, an e-mail address or a date of birth.
    """
    cleaned = name.strip()
    if IDENTIFIER_EXPLICIT.match(cleaned):
        return True
    if IDENTIFIER_PERSONAL_NAMES.match(cleaned):
        return True
    tokens = [t for t in re.split(r"[^0-9A-Za-z]+", cleaned) if t]
    if tokens and tokens[-1].lower() in IDENTIFIER_SUFFIX_TOKENS:
        if any(t.lower() in IDENTIFIER_SUBJECT_TOKENS for t in tokens):
            return True
        if IDENTIFIER_SUBJECT_CJK.search(cleaned):
            return True
    return False


# A column name is not the only thing that identifies a person, and on real
# extracts it was not even the usual one. PATIENT_NAME, NAME, PHONE, TEL,
# ADDRESS, DOB, BIRTH_DATE, ID_CARD, 出生日期, 电话 and 住址 all read as ordinary
# columns to the rule above — none carries an id-shaped suffix token — so a
# twenty-row cohort had every personal name, every eighteen-digit identity
# number, every mobile number, every date of birth, every e-mail address and
# every home address printed into `data-profile.json` and `data-profile.md` as
# "vocabulary", and the preflight's leakage scan, which asks the same function,
# let all of it through. Reproduced on exactly that file: eight columns, six of
# them emitted raw.
#
# Two answers, and the second is the one that keeps working when a column is
# called `col_7`. First the names above, as names. Then the values themselves:
# an identity number that verifies its own check digit, a mainland mobile
# number, an e-mail address, a column of dates that are lifespans rather than
# events. These are closed format checks over values — arithmetic and fixed
# shapes — not judgements about language, which is the line development
# principle 1 draws and principle 5 forbids crossing.
IDENTIFIER_PERSONAL_NAMES = re.compile(
    r"^(?:"
    r"name|full[_\s-]?name|first[_\s-]?name|last[_\s-]?name|surname|given[_\s-]?name|patient[_\s-]?name"
    r"|phone|phone[_\s-]?no|tel|telephone|mobile|cell|contact[_\s-]?no"
    r"|address|addr|home[_\s-]?address|postcode|zip|zipcode"
    r"|dob|birth|birthday|birth[_\s-]?date|date[_\s-]?of[_\s-]?birth"
    r"|email|e[_\s-]?mail|mail"
    r"|id[_\s-]?card|idcard|id[_\s-]?no|idno|ssn|passport|passport[_\s-]?no"
    r"|姓名|名字|电话|手机|手机号码?|联系电话|联系方式|住址|地址|家庭住址|通讯地址|邮编"
    r"|出生日期|出生年月|生日|邮箱|电子邮箱|电子邮件|身份证|证件号码?|护照号码?"
    r")$",
    re.I,
)

MAINLAND_ID_18 = re.compile(r"^\d{17}[\dXx]$")
MAINLAND_ID_15 = re.compile(r"^\d{15}$")
# +86 or a bare 11-digit number beginning 13-19. Separators are stripped first.
MAINLAND_MOBILE = re.compile(r"^(?:\+?86)?1[3-9]\d{9}$")
EMAIL_ADDRESS = re.compile(r"^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$")
# ISO 7064:1983 MOD 11-2, the check digit every mainland identity number carries.
ID_CHECK_WEIGHTS = (7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2)
ID_CHECK_CODES = "10X98765432"
# A shape has to hold for most of the column, not for one cell: one stray
# "13800138000" in a free-text note must not mask a clinical column, and a
# column of identity numbers with two typos must still be masked. And a shape
# read off two values is a coincidence, so a short column is judged by name only.
VALUE_SHAPE_MIN_VALUES = 5
VALUE_SHAPE_MIN_SHARE = 0.8
# Nobody alive was born more than this long ago, and a birth is never in the
# future — the two bounds that make a lifespan distinguishable from an event.
BIRTH_YEAR_REACH = 130
# Three properties together separate a column of births from a column of events,
# and all three are needed. It spreads across at least this many years — a
# cohort contains people of different ages. Nothing in it is from the last year.
# And it reaches back at least a generation: every cohort has someone over
# thirty in it, while an event column, however long the follow-up, starts when
# the study did. A 2010-2016 admission window is narrow, a 2015-2026 one is
# current, and a twenty-year 2005-2025 follow-up — which passes both of the
# first two — is caught by the third.
BIRTH_YEAR_SPREAD = 15
BIRTH_YEAR_OLDEST_AT_LEAST = 30


def is_mainland_id_number(value: str) -> bool:
    """An 18-digit identity number that verifies its own check digit.

    The checksum is what makes this safe to run over every column in a hospital
    extract: an arbitrary 18-character code passes it about one time in eleven,
    a real identity number always. A 15-digit legacy number carries no check
    digit, so it is recognised only by its length and its date part.
    """
    cleaned = value.strip().replace(" ", "")
    if MAINLAND_ID_15.match(cleaned):
        return _plausible_id_birth(cleaned[6:12], century="19")
    if not MAINLAND_ID_18.match(cleaned):
        return False
    if not _plausible_id_birth(cleaned[6:14]):
        return False
    total = sum(int(cleaned[index]) * ID_CHECK_WEIGHTS[index] for index in range(17))
    return cleaned[17].upper() == ID_CHECK_CODES[total % 11]


def _plausible_id_birth(digits: str, century: str = "") -> bool:
    text = century + digits
    if len(text) != 8:
        return False
    year, month, day = int(text[:4]), int(text[4:6]), int(text[6:8])
    return 1 <= month <= 12 and 1 <= day <= 31 and 1900 <= year <= date.today().year


def is_mobile_number(value: str) -> bool:
    return bool(MAINLAND_MOBILE.match(re.sub(r"[\s()-]", "", value.strip())))


def is_email_address(value: str) -> bool:
    return bool(EMAIL_ADDRESS.match(value.strip()))


# A date, in either component order, with an optional time. Declared inside
# this block rather than borrowed, so the block is byte-identical in
# profile_dataset.py and preflight.py — the four-copy rule applies to both.
BIRTH_DATE_SHAPE = re.compile(
    r"^(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{4})"
    r"(?:[ tT]\d{1,2}:\d{2}(?::\d{2})?)?\s*$",
)


def _parsed_year(value: str):
    if not BIRTH_DATE_SHAPE.match(value):
        return None
    head = re.split(r"[ tT]", value.strip())[0]
    parts = re.split(r"[-/]", head)
    for part in parts:
        if len(part) == 4 and part.isdigit():
            return int(part)
    return None


def looks_like_birth_dates(values: list) -> bool:
    """Dates that describe lifespans rather than events.

    A date column is not identifying because it is a date — admission dates,
    sample dates and follow-up dates are covariates and have to stay readable.
    What a column of birth dates has and an event column does not is reach: its
    values span decades, none of them is recent, and all of them are inside a
    human lifetime. Judged on the values, so a column called `col_7` is caught
    and `ADMISSION_DATE` is not.
    """
    years = [year for year in (_parsed_year(v) for v in values) if year is not None]
    if len(years) < VALUE_SHAPE_MIN_VALUES or len(years) < VALUE_SHAPE_MIN_SHARE * len(values):
        return False
    today = date.today()
    if min(years) < today.year - BIRTH_YEAR_REACH or max(years) > today.year:
        return False
    if max(years) > today.year - 1:
        return False
    if min(years) > today.year - BIRTH_YEAR_OLDEST_AT_LEAST:
        return False
    return max(years) - min(years) >= BIRTH_YEAR_SPREAD


def identifying_value_shape(values: list):
    """The shape that makes a column's values identify a person, or None.

    Returns the name of the shape so the profile can say why a column was
    masked. A masking nobody can see the reason for is one a researcher works
    around by exporting the column again under another name.

    Four shapes, and the list stops where format stops. A personal name and a
    street address have no closed format — recognising them means a pattern over
    language, which is the thing development principle 5 forbids and the thing
    that never converges. They are caught by column name, which is how they
    arrive in every real extract seen so far; an anonymised column of names is a
    known gap, recorded here rather than papered over with a surname list that
    would be wrong for most of the world.
    """
    candidates = [str(v).strip() for v in values if str(v).strip()]
    if len(candidates) < VALUE_SHAPE_MIN_VALUES:
        return None
    floor = VALUE_SHAPE_MIN_SHARE * len(candidates)
    for shape, matches in (
        ("id-number", is_mainland_id_number),
        ("mobile-number", is_mobile_number),
        ("email-address", is_email_address),
    ):
        if sum(1 for value in candidates if matches(value)) >= floor:
            return shape
    if looks_like_birth_dates(candidates):
        return "birth-date"
    return None


def identifying_reason(name: str, values: list):
    """Why a column is masked — its name, or the shape of what it holds."""
    if is_identifying(name):
        return "column-name"
    return identifying_value_shape(values)


# Dates that are really "unset". These parse as text and fail as dates, which is
# why 11.5% of one real END_DATETIME column silently broke every duration.
SENTINEL_PATTERN = re.compile(
    r"^\s*(?:0{1,4}[-/]0{1,2}[-/]0{1,4}(?:[ t].*)?|0000-00-00.*|9999[-/].*|n/?a|null|nil|none|unknown|未知|无)\s*$",
    re.I,
)
# One cell carrying several values: 129/74, a pipe-delimited comorbidity list.
COMPOSITE_PATTERN = re.compile(r"^[^|;,/\\]+(?:\s*[|;/\\]\s*[^|;,/\\]+)+$")
INTEGER_PATTERN = re.compile(r"^[+-]?\d+$")
NUMBER_PATTERN = re.compile(r"^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$")
# Both orders, because a real extract exported day-first: matching only
# year-first left 915 of one column's timestamps looking like composite values,
# which buried the genuine composites — the pipe-delimited comorbidity strings —
# under an entire column of false positives.
DATE_PATTERN = re.compile(
    r"^(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{4})"
    r"(?:[ tT]\d{1,2}:\d{2}(?::\d{2})?)?\s*$",
)


# A day-first date whose first two components are both 12 or under reads equally
# well as month-first, and nothing in the cell says which. On the real extract
# more than half of one column's values were ambiguous this way, so a reader who
# guesses wrong silently reorders the timeline — and every temporal design, every
# time-zero, every before-and-after rests on that order. The count is reported
# per column so the run has to state which convention it adopted and on what.
AMBIGUOUS_DATE = re.compile(r"^(\d{1,2})[-/](\d{1,2})[-/]\d{4}")
# A code column that holds more than one shape is holding more than one coding
# system. The real 诊断记录 DIAGNOSIS_CODE carried ICD-10 alongside three
# families of Chinese TCM syndrome codes, and a run that treats the column as
# one vocabulary maps a quarter of its rows to nothing.
CODE_SHAPES = (
    ("icd10", re.compile(r"^[A-Z]\d{2}(?:\.\d+)?(?:x\d+)?$", re.I)),
    ("alpha-numeric-block", re.compile(r"^[A-Z]{2,4}\d{2,4}$")),
    ("dotted-numeric", re.compile(r"^[A-Z]?\d{2}(?:\.\d{2}){1,3}$", re.I)),
    ("loinc", re.compile(r"^\d{1,5}-\d$")),
    ("numeric", re.compile(r"^\d+$")),
)
CODE_COLUMN = re.compile(r"(?:code|编码|代码)$", re.I)
CODE_SHAPE_MIN = 2


def is_blank(value: str) -> bool:
    return not value or not value.strip()


def date_ambiguity(values: list[str]) -> dict:
    """How many values cannot say for themselves whether they are D/M or M/D."""
    dated = [v for v in values if DATE_PATTERN.match(v)]
    if not dated:
        return {"dateValues": 0, "ambiguous": 0, "share": 0.0}
    ambiguous = 0
    for value in dated:
        match = AMBIGUOUS_DATE.match(value)
        if match and int(match.group(1)) <= 12 and int(match.group(2)) <= 12:
            ambiguous += 1
    return {
        "dateValues": len(dated),
        "ambiguous": ambiguous,
        "share": round(ambiguous / len(dated), 4),
    }


def code_shapes(name: str, values: list[str]) -> dict:
    """The distinct code shapes a coded column holds, and how many rows each."""
    if not CODE_COLUMN.search(name.strip()):
        return {"applies": False, "shapes": {}}
    found: Counter = Counter()
    for value in values:
        label = next((key for key, pattern in CODE_SHAPES if pattern.match(value)), "other")
        found[label] += 1
    return {
        "applies": True,
        "shapes": dict(sorted(found.items(), key=lambda kv: (-kv[1], kv[0]))),
        "mixed": len(found) >= CODE_SHAPE_MIN,
    }


def infer_type(values: list[str]) -> str:
    """The narrowest type every non-blank value satisfies."""
    if not values:
        return "empty"
    if all(INTEGER_PATTERN.match(v.strip()) for v in values):
        return "integer"
    if all(NUMBER_PATTERN.match(v.strip()) for v in values):
        return "number"
    if all(DATE_PATTERN.match(v.strip()) for v in values):
        return "date"
    return "text"


def profile_column(name: str, cells: list[str]) -> tuple[dict, set[str]]:
    """Returns the emitted profile and, separately, the distinct values.

    The values are used to compute join reachability and are never written out.
    """
    filled = [c for c in cells if not is_blank(c)]
    stripped = [c.strip() for c in filled]
    counts = Counter(stripped)
    distinct = len(counts)
    # Name **or** value shape. Asking only the name printed twenty identity
    # numbers, twenty mobile numbers and twenty home addresses into a
    # deliverable, because none of those column names carries an id-shaped
    # suffix token.
    masked_by = identifying_reason(name, stripped)
    identifying = masked_by is not None
    complete = distinct <= VOCABULARY_COMPLETE_MAX and not identifying
    shown = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    if identifying:
        shown = []
    elif not complete:
        shown = shown[:VOCABULARY_SAMPLE]
    sentinels = sorted({v for v in stripped if SENTINEL_PATTERN.match(v)})
    # A date is slash-separated and a sentinel date is both; neither is a cell
    # carrying two values, and reporting them as composite buries the real ones.
    composites = [
        v for v in stripped
        if COMPOSITE_PATTERN.match(v) and not SENTINEL_PATTERN.match(v) and not DATE_PATTERN.match(v)
    ]
    return {
        "name": name,
        "rows": len(cells),
        "filled": len(filled),
        # Density completeness in Weiskopf's sense: the proportion of rows where
        # this field carries a value. It says nothing about whether the value is
        # correct, and it is not the other three completeness definitions.
        "densityCompleteness": round(len(filled) / len(cells), 4) if cells else 0.0,
        "distinct": distinct,
        "inferredType": infer_type(stripped),
        # `maskedBy` names the rule that withheld the values. A masking with no
        # stated reason is one a researcher works around by exporting the column
        # again under a different name, which defeats it entirely.
        "vocabulary": {"complete": complete, "identifying": identifying, "maskedBy": masked_by, "values": [[v, c] for v, c in shown]},
        "sentinelSuspects": sentinels,
        "dateAmbiguity": date_ambiguity(stripped),
        "codeShapes": code_shapes(name, stripped),
        "compositeSuspects": {
            "count": len(composites),
            "examples": [] if identifying else sorted({v for v in composites})[:3],
        },
    }, set(counts)


def read_delimited(path: Path, delimiter: str) -> list[tuple[str, list[str], list[list[str]]]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.reader(handle, delimiter=delimiter))
    if not rows:
        return [(path.name, [], [])]
    return [(path.name, [str(h) for h in rows[0]], [[str(c) for c in r] for r in rows[1:]])]


def read_excel(path: Path) -> list[tuple[str, list[str], list[list[str]]]]:
    try:
        from openpyxl import load_workbook
    except ImportError:  # pragma: no cover - environment dependent
        raise SystemExit(
            f"{path.name} is an Excel workbook and openpyxl is not installed. "
            "Install openpyxl, or export each sheet to CSV and profile those."
        )
    workbook = load_workbook(path, read_only=True, data_only=True)
    tables = []
    for sheet in workbook.worksheets:
        rows = [["" if c is None else str(c) for c in row] for row in sheet.iter_rows(values_only=True)]
        if not rows:
            tables.append((f"{path.name}#{sheet.title}", [], []))
            continue
        tables.append((f"{path.name}#{sheet.title}", rows[0], rows[1:]))
    workbook.close()
    return tables


def read_table(path: Path) -> list[tuple[str, list[str], list[list[str]]]]:
    suffix = path.suffix.lower()
    if suffix in {".xlsx", ".xlsm"}:
        return read_excel(path)
    if suffix in {".tsv", ".tab"}:
        return read_delimited(path, "\t")
    return read_delimited(path, ",")


def fingerprint(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def profile_tables(paths: list[Path]) -> tuple[dict, dict[tuple[str, str], set[str]]]:
    tables = []
    values: dict[tuple[str, str], set[str]] = {}
    for path in paths:
        digest = fingerprint(path)
        for name, header, rows in read_table(path):
            columns = []
            for index, column_name in enumerate(header):
                cells = [row[index] if index < len(row) else "" for row in rows]
                profile, distinct = profile_column(str(column_name), cells)
                columns.append(profile)
                values[(name, str(column_name))] = distinct
            tables.append({
                "name": name,
                "sourceFile": path.name,
                "sourceFingerprint": digest,
                "rows": len(rows),
                "columns": columns,
            })
    return {"schemaVersion": SCHEMA_VERSION, "tables": tables}, values


# A column with no name at all cannot be classified by name, and one real sheet
# has exactly that: an unnamed column carrying CASE_NO values, whose vocabulary
# was printed in full because the rule had nothing to match on. Identifiers
# travel across columns regardless of what the column is called, so any column
# whose values are mostly values of an identifying column is masked too.
VALUE_OVERLAP_MASK_RATIO = 0.5


def mask_by_value_overlap(profile: dict, values: dict[tuple[str, str], set[str]]) -> None:
    pool: set[str] = set()
    for table in profile["tables"]:
        for column in table["columns"]:
            if column["vocabulary"]["identifying"]:
                pool |= values.get((table["name"], column["name"]), set())
    if not pool:
        return
    for table in profile["tables"]:
        for column in table["columns"]:
            if column["vocabulary"]["identifying"]:
                continue
            own = values.get((table["name"], column["name"]), set())
            if not own:
                continue
            if len(own & pool) / len(own) >= VALUE_OVERLAP_MASK_RATIO:
                column["vocabulary"]["identifying"] = True
                column["vocabulary"]["maskedBy"] = "value-overlap"
                column["vocabulary"]["complete"] = False
                column["vocabulary"]["values"] = []
                column["compositeSuspects"]["examples"] = []


def discover_joins(values: dict[tuple[str, str], set[str]]) -> list[dict]:
    """Inclusion dependencies: is every value of A.col also a value of B.col?

    Computed from the real values, which are never emitted. A key that is
    present but empty is the finding this exists to surface — one real diagnosis
    table carried PATIENT_ID at 0% fill, which no schema diagram would show.
    """
    candidates = {key: v for key, v in values.items() if JOIN_KEY_PATTERN.search(key[1])}
    joins = []
    for (left_table, column_name), left_values in sorted(candidates.items()):
        for (right_table, right_column), right_values in sorted(candidates.items()):
            if left_table >= right_table or column_name != right_column:
                continue
            if not left_values or not right_values:
                joins.append({
                    "left": f"{left_table}.{column_name}",
                    "right": f"{right_table}.{right_column}",
                    "reachable": False,
                    "reason": "one side has no values at all",
                    "containment": 0.0,
                })
                continue
            matched = len(left_values & right_values)
            joins.append({
                "left": f"{left_table}.{column_name}",
                "right": f"{right_table}.{right_column}",
                "reachable": matched > 0,
                "reason": "" if matched else "no value of the left key occurs in the right key",
                "containment": round(matched / len(left_values), 4),
            })
    return joins


def find_type_conflicts(tables: list[dict]) -> list[dict]:
    by_name: dict[str, dict[str, str]] = {}
    for table in tables:
        for column in table["columns"]:
            if column["inferredType"] == "empty":
                continue
            by_name.setdefault(column["name"], {})[table["name"]] = column["inferredType"]
    conflicts = []
    for column_name, types in sorted(by_name.items()):
        if len(set(types.values())) > 1:
            conflicts.append({"column": column_name, "types": dict(sorted(types.items()))})
    return conflicts


# What each masking reason means, in the baseline UI language. The profile says
# which rule fired, not merely that something was withheld.
MASK_REASON_LABELS = {
    "column-name": "列名",
    "id-number": "取值形态：身份证号（校验位通过）",
    "mobile-number": "取值形态：手机号",
    "email-address": "取值形态：电子邮箱",
    "birth-date": "取值形态：出生日期",
    "value-overlap": "取值与标识符列重合",
}


def masking_report(profile: dict) -> list[dict]:
    """Every column whose values were withheld, and the rule that withheld it."""
    return [
        {"table": table["name"], "column": column["name"], "reason": column["vocabulary"].get("maskedBy") or "column-name"}
        for table in profile["tables"]
        for column in table["columns"]
        if column["vocabulary"]["identifying"]
    ]


def render_markdown(profile: dict) -> str:
    lines = ["# 数据剖析（data profile）", ""]
    lines.append(
        "本文件由 `data-profile.py` 生成，数字全部可复算：对同一批输入重跑该脚本即得同一份 JSON。"
    )
    lines.append("")
    lines.append(
        "**填充率的口径**：本表的填充率是 Weiskopf 四义中的 **density completeness**"
        "（该字段在多少比例的行上有值），不涉及取值是否正确，也不是其余三种完整性。"
    )
    lines.append("")
    masked = profile.get("masking") or []
    lines.append(
        "**遮蔽口径**：以下 %d 列的取值不写入本文件，也不写入 JSON。判定依据为列名或取值形态"
        "（身份证号按校验位核验、手机号、电子邮箱、出生日期），或与标识符列取值重合。"
        % len(masked)
    )
    if masked:
        lines.append("")
        for item in masked:
            lines.append(
                "- `%s`.`%s` — %s" % (item["table"], item["column"], MASK_REASON_LABELS.get(item["reason"], item["reason"]))
            )
    lines.append("")
    for table in profile["tables"]:
        lines.append(f"## {table['name']}")
        lines.append("")
        lines.append(f"- 来源文件：`{table['sourceFile']}`（`{table['sourceFingerprint']}`）")
        lines.append(f"- 行数：{table['rows']}；列数：{len(table['columns'])}")
        lines.append("")
        lines.append("| 字段 | 填充率 | 取值基数 | 推断类型 | 词表 | 备注 |")
        lines.append("|---|---|---|---|---|---|")
        for column in table["columns"]:
            vocabulary = column["vocabulary"]
            rendered = "、".join(f"`{v}`×{c}" for v, c in vocabulary["values"][:8])
            if vocabulary["identifying"]:
                rendered = "（标识符列，取值不外带；判定依据：%s）" % MASK_REASON_LABELS.get(
                    vocabulary.get("maskedBy") or "column-name", vocabulary.get("maskedBy")
                )
            elif not vocabulary["complete"]:
                rendered = f"（高基数，仅列高频）{rendered}"
            notes = []
            if column["sentinelSuspects"]:
                notes.append("哨兵值：" + "、".join(f"`{s}`" for s in column["sentinelSuspects"][:3]))
            if column["compositeSuspects"]["count"]:
                notes.append(f"复合值 {column['compositeSuspects']['count']} 处")
            ambiguity = column.get("dateAmbiguity") or {}
            if ambiguity.get("ambiguous"):
                notes.append(
                    f"日期歧义 {ambiguity['ambiguous']}/{ambiguity['dateValues']}"
                    f"（{ambiguity['share']:.0%} 无法自证日/月次序）"
                )
            shapes = column.get("codeShapes") or {}
            if shapes.get("mixed"):
                notes.append(
                    "编码形态混用："
                    + "、".join(f"{k} {v}" for k, v in shapes["shapes"].items())
                )
            if column["filled"] == 0:
                notes.append("**该列全空**")
            lines.append(
                f"| `{column['name']}` | {column['densityCompleteness']:.1%} "
                f"({column['filled']}/{column['rows']}) | {column['distinct']} | "
                f"{column['inferredType']} | {rendered or '—'} | {'；'.join(notes) or '—'} |"
            )
        lines.append("")

    lines.append("## 跨表连接可达性（inclusion dependency）")
    lines.append("")
    if not profile["joins"]:
        lines.append("未发现同名的候选连接键。")
    else:
        lines.append("| 左 | 右 | 可达 | 包含度 | 说明 |")
        lines.append("|---|---|---|---|---|")
        for join in profile["joins"]:
            reachable = {True: "✅", False: "❌", None: "⚠️"}[join["reachable"]]
            containment = "—" if join["containment"] is None else f"{join['containment']:.1%}"
            lines.append(
                f"| `{join['left']}` | `{join['right']}` | {reachable} | {containment} | {join['reason'] or '—'} |"
            )
    lines.append("")

    lines.append("## 跨表类型不一致")
    lines.append("")
    if not profile["typeConflicts"]:
        lines.append("未发现同名字段在不同表中被推断为不同类型。")
    else:
        lines.append("| 字段 | 各表推断类型 |")
        lines.append("|---|---|")
        for conflict in profile["typeConflicts"]:
            rendered = "；".join(f"{table}={kind}" for table, kind in conflict["types"].items())
            lines.append(f"| `{conflict['column']}` | {rendered} |")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Profile a dataset for research scoping.")
    parser.add_argument("inputs", nargs="+", help="CSV, TSV, or XLSX files to profile")
    parser.add_argument("--json", dest="json_out", default="data-profile.json")
    parser.add_argument("--markdown", dest="markdown_out", default="data-profile.md")
    args = parser.parse_args()

    paths = [Path(p) for p in args.inputs]
    missing = [str(p) for p in paths if not p.is_file()]
    if missing:
        raise SystemExit("input file(s) not found: " + ", ".join(missing))

    profile, values = profile_tables(sorted(paths, key=lambda p: p.name))
    mask_by_value_overlap(profile, values)
    profile["joins"] = discover_joins(values)
    profile["typeConflicts"] = find_type_conflicts(profile["tables"])
    # Written after the overlap pass, so it names every masked column including
    # the ones masked for carrying another column's identifiers.
    profile["masking"] = masking_report(profile)

    Path(args.json_out).write_text(json.dumps(profile, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
    Path(args.markdown_out).write_text(render_markdown(profile), encoding="utf-8")
    empty_columns = sum(1 for t in profile["tables"] for c in t["columns"] if c["filled"] == 0)
    print(
        f"profiled {len(profile['tables'])} table(s), "
        f"{sum(len(t['columns']) for t in profile['tables'])} column(s), "
        f"{empty_columns} entirely empty, "
        f"{len(profile['joins'])} candidate join(s), "
        f"{len(profile['typeConflicts'])} type conflict(s), "
        f"{len(profile['masking'])} masked column(s)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
