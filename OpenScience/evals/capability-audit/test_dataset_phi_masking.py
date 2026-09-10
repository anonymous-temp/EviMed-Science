#!/usr/bin/env python3
"""No raw personal value leaves a dataset profile.

Reproduced on 2026-09-10 against the real script: a twenty-row cohort with
PATIENT_NAME, ID_CARD, 电话, DOB, EMAIL and 住址 columns was profiled, and every
one of those columns came back `identifying=False` with its top values printed
into `data-profile.json` and `data-profile.md`. The rule asked only whether a
column *name* carried an id-shaped suffix token, and none of those six does. The
preflight's leakage scan asks the same function, so it agreed.

Two rules now, either sufficient: the name, extended to the names people
actually use, and the shape of the values — an identity number that verifies its
own check digit, a mainland mobile number, an e-mail address, a column of dates
that are lifespans rather than events. The second is what still works when the
column is called `col_7`, which is how anonymised extracts arrive.

Every case here is a closed format check. Personal names and free-text addresses
have no closed format and are deliberately not detected by value: recognising
them would be a pattern over language, which is what development principle 5
forbids. They are caught by name, and the report says which rule fired.
"""

from __future__ import annotations

import csv
import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
SCRIPT = REPO / "capabilities" / "dataset-research-scoping" / "scripts" / "profile_dataset.py"
PREFLIGHT = REPO / "capabilities" / "dataset-research-scoping" / "scripts" / "preflight.py"


def load(name: str, path: Path):
    sys.path.insert(0, str(path.parent))
    spec = importlib.util.spec_from_file_location(name, path)
    try:
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.pop(0)


def mainland_id(seed: int) -> str:
    body = ("110101%04d%02d%02d%03d" % (1940 + seed % 56, seed % 12 + 1, seed % 28 + 1, seed))[:17]
    weights = (7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2)
    return body + "10X98765432"[sum(int(body[i]) * weights[i] for i in range(17)) % 11]


def cohort(headers):
    """Forty rows of the six shapes, plus two columns that must stay readable."""
    rows = []
    for index in range(1, 41):
        rows.append(dict(zip(headers, [
            "张%s伟" % chr(0x4E00 + index),
            mainland_id(index),
            "138%08d" % (10000000 + index),
            "%d-%02d-%02d" % (1940 + (index * 3) % 56, index % 12 + 1, index % 28 + 1),
            "patient%02d@example.com" % index,
            "北京市朝阳区某路%d号" % index,
            "%d-%02d-%02d" % (2019 + index % 4, index % 12 + 1, index % 28 + 1),
            "I10",
        ])))
    return rows


NAMED = ["PATIENT_NAME", "ID_CARD", "电话", "DOB", "EMAIL", "住址", "ADMISSION_DATE", "DIAGNOSIS_CODE"]
ANONYMOUS = ["col_1", "col_2", "col_3", "col_4", "col_5", "col_6", "col_7", "col_8"]


class ProfileMasking(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load("evimed_profile_dataset_test", SCRIPT)

    def profile(self, headers):
        directory = Path(tempfile.mkdtemp())
        source = directory / "cohort.csv"
        rows = cohort(headers)
        with source.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=headers)
            writer.writeheader()
            writer.writerows(rows)
        result = subprocess.run(
            [sys.executable, str(SCRIPT), str(source),
             "--json", str(directory / "data-profile.json"),
             "--markdown", str(directory / "data-profile.md")],
            capture_output=True, text=True, cwd=directory,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        emitted = (directory / "data-profile.json").read_text("utf-8") + (directory / "data-profile.md").read_text("utf-8")
        return json.loads((directory / "data-profile.json").read_text("utf-8")), emitted, rows

    def masked(self, profile):
        return {column["name"]: column["vocabulary"].get("maskedBy") for column in profile["tables"][0]["columns"]}

    def test_no_personal_value_reaches_the_deliverable_when_columns_are_named(self):
        profile, emitted, rows = self.profile(NAMED)
        for row in rows:
            for column in ("PATIENT_NAME", "ID_CARD", "电话", "DOB", "EMAIL", "住址"):
                self.assertNotIn(row[column], emitted, "%s value reached the profile" % column)
        # And the scan proves it scanned: the two columns that must stay
        # readable are still there, with their values.
        self.assertIn("I10", emitted)
        self.assertIn(rows[0]["ADMISSION_DATE"], emitted)

    def test_every_named_personal_column_is_masked_and_says_why(self):
        profile, _, _ = self.profile(NAMED)
        reasons = self.masked(profile)
        for column in ("PATIENT_NAME", "ID_CARD", "电话", "DOB", "EMAIL", "住址"):
            self.assertEqual(reasons[column], "column-name", column)
        self.assertIsNone(reasons["ADMISSION_DATE"], "an event date is a covariate and has to stay readable")
        self.assertIsNone(reasons["DIAGNOSIS_CODE"])

    def test_value_shapes_are_caught_when_the_column_name_says_nothing(self):
        profile, emitted, rows = self.profile(ANONYMOUS)
        reasons = self.masked(profile)
        self.assertEqual(reasons["col_2"], "id-number")
        self.assertEqual(reasons["col_3"], "mobile-number")
        self.assertEqual(reasons["col_4"], "birth-date")
        self.assertEqual(reasons["col_5"], "email-address")
        self.assertIsNone(reasons["col_7"], "an admission-date column must survive the birth-date rule")
        self.assertIsNone(reasons["col_8"])
        for row in rows:
            for column in ("col_2", "col_3", "col_4", "col_5"):
                self.assertNotIn(row[column], emitted)

    def test_the_profile_reports_what_it_withheld(self):
        profile, emitted, _ = self.profile(NAMED)
        masked = {entry["column"] for entry in profile["masking"]}
        self.assertEqual(masked, {"PATIENT_NAME", "ID_CARD", "电话", "DOB", "EMAIL", "住址"})
        self.assertIn("遮蔽口径", emitted)
        # The per-column reason, on a profile where the shapes are what fired.
        _, anonymous, _ = self.profile(ANONYMOUS)
        for label in ("身份证号（校验位通过）", "手机号", "电子邮箱", "出生日期"):
            self.assertIn(label, anonymous)


class ValueShapes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load("evimed_profile_dataset_shapes_test", SCRIPT)

    def test_an_identity_number_is_recognised_by_its_check_digit(self):
        valid = mainland_id(7)
        self.assertTrue(self.module.is_mainland_id_number(valid))
        # One digit changed: the check digit no longer agrees, so an arbitrary
        # 18-character code does not become an identifier by being 18 long.
        broken = valid[:5] + ("0" if valid[5] != "0" else "1") + valid[6:]
        self.assertFalse(self.module.is_mainland_id_number(broken))
        self.assertFalse(self.module.is_mainland_id_number("123456789012345678"))

    def test_ordinary_analytic_columns_are_not_mistaken_for_identifiers(self):
        for values in (
            ["120", "118", "134", "126", "142", "119", "128"],          # systolic pressure
            ["I10", "E11.9", "J44.1", "I50.0", "N18.3", "I10", "E11"],  # diagnosis codes
            ["2021-03-04", "2021-06-19", "2022-01-08", "2022-04-30", "2022-09-11", "2023-02-02"],
            ["12.4", "13.1", "11.8", "14.0", "12.9", "13.3", "12.1"],   # haemoglobin
        ):
            self.assertIsNone(self.module.identifying_value_shape(values), values)

    def test_one_stray_value_does_not_mask_a_clinical_column(self):
        # A free-text note that happens to contain a phone number is not a
        # column of phone numbers, and masking it would cost the column.
        values = ["咳嗽三天", "13800138000", "胸闷", "发热", "乏力", "头痛", "腹痛"]
        self.assertIsNone(self.module.identifying_value_shape(values))

    def test_a_short_column_is_judged_by_name_only(self):
        # Two values of a shape is a coincidence, not a column.
        self.assertIsNone(self.module.identifying_value_shape([mainland_id(1), mainland_id(2)]))

    def test_birth_dates_need_spread_age_and_reach(self):
        from datetime import date

        now = date.today().year
        births = ["%d-05-04" % year for year in range(1945, 1995, 5)]
        self.assertTrue(self.module.looks_like_birth_dates(births))
        # Wide but current: a follow-up column running up to this year.
        current = ["%d-05-04" % year for year in range(now - 20, now + 1, 2)]
        self.assertFalse(self.module.looks_like_birth_dates(current))
        # Old but narrow: a closed six-year admission window.
        narrow = ["%d-05-04" % year for year in range(now - 16, now - 9)]
        self.assertFalse(self.module.looks_like_birth_dates(narrow))
        # Wide and not current, but it starts when the study did: a twenty-year
        # follow-up ending last year. Only the reach test separates this one.
        followup = ["%d-05-04" % year for year in range(now - 21, now, 2)]
        self.assertFalse(self.module.looks_like_birth_dates(followup))


class PreflightAgreesWithTheProfiler(unittest.TestCase):
    """The two must ask the same question, or they agree on the wrong answer.

    The preflight's leakage scan collects identifier values from identifying
    columns and then looks for them in the deliverables. While it asked only the
    column name, a deliverable could carry every identity number in the dataset
    and the scan reported clean — the same blindness, one step later, where it
    is the last thing between a run and a delivered package.
    """

    def test_the_two_copies_of_the_rule_are_byte_identical(self):
        profiler = SCRIPT.read_text("utf-8")
        preflight = PREFLIGHT.read_text("utf-8")
        start = "IDENTIFIER_PERSONAL_NAMES = re.compile("
        end = "def identifying_reason(name: str, values: list):"
        for source, label in ((profiler, "profile_dataset.py"), (preflight, "preflight.py")):
            self.assertIn(start, source, label)
            self.assertIn(end, source, label)
        block = lambda text: text[text.index(start):text.index(end)]
        self.assertEqual(
            hashlib.sha256(block(profiler).encode("utf-8")).hexdigest(),
            hashlib.sha256(block(preflight).encode("utf-8")).hexdigest(),
            "the identification rule differs between the profiler and the preflight",
        )
        self.assertGreater(len(block(profiler)), 2000, "the block scan matched almost nothing")

    def test_the_preflight_collects_the_same_columns(self):
        preflight = load("evimed_dataset_preflight_test", PREFLIGHT)
        rows = cohort(ANONYMOUS)
        for column, expected in (("col_2", "id-number"), ("col_3", "mobile-number"), ("col_5", "email-address")):
            values = [row[column] for row in rows]
            self.assertEqual(preflight.identifying_reason(column, values), expected)
        self.assertIsNone(preflight.identifying_reason("col_8", [row["col_8"] for row in rows]))


if __name__ == "__main__":
    unittest.main()
