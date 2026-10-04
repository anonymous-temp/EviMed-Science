"""The deterministic checks of `data_semantics_checks.py`, on the longitudinal fixture and its second delivery.

The assets are built by the domain (`semantics_asset.build`), so a check here reads exactly what
the control plane stores. Each named outcome of the plan has a case that produces it and one that
shows its absence, and a check that cannot run is shown to say so rather than read as clean.
"""

import os
import pathlib
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import data_semantics_checks as checks  # noqa: E402
import semantics_asset  # noqa: E402
import semantics_fixtures  # noqa: E402

FIXTURES = pathlib.Path(__file__).resolve().parent / "fixtures" / "semantics"
INFERRED = {"basis": "model_inferred", "inferredFrom": ["column names and values of data/visits.csv"]}


def outcomes(result, family=None):
    return sorted(item["outcome"] for item in result["findings"] if family is None or item["family"] == family)


def find(result, outcome, **subject):
    hits = [item for item in result["findings"] if item["outcome"] == outcome and all(item["subject"].get(k) == v for k, v in subject.items())]
    assert len(hits) == 1, "%s %s: %r" % (outcome, subject, outcomes(result))
    return hits[0]


class Workspace(unittest.TestCase):
    """A workspace holding the first delivery under data/, and an asset recorded from it."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.workspace = directory.name
        (pathlib.Path(self.workspace) / "data").mkdir()
        for source, target in (("visits_v1.csv", "visits.csv"), ("patients.csv", "patients.csv"), ("outcomes.csv", "outcomes.csv"), ("dictionary.csv", "dictionary.csv")):
            shutil.copy(FIXTURES / source, pathlib.Path(self.workspace) / "data" / target)

    def path(self, name):
        return pathlib.Path(self.workspace) / "data" / name

    def deliver(self, name, source):
        """The researcher's second delivery replaces the file at the same path."""
        shutil.copy(FIXTURES / source, self.path(name))

    def bindings(self, *names, declared=None):
        out = []
        for name in names:
            (table,) = checks.read_tables(self.workspace, "data/" + name)
            out.append(checks.binding_of(table, declared))
        return out

    def asset(self, extra=(), bind=("visits.csv", "patients.csv", "outcomes.csv"), declared=None):
        base = {
            "datasetId": "visits", **INFERRED, "title": "Sepsis visits",
            "tables": [
                {"name": "visits.csv", "observationUnit": "one row per patient visit", "subjectKey": ["patient_id"], "observationKey": ["patient_id", "visit_no"]},
                {"name": "patients.csv", "observationUnit": "one row per patient", "subjectKey": ["patient_id"], "observationKey": ["patient_id"]},
                {"name": "outcomes.csv", "observationUnit": "one row per patient", "subjectKey": ["patient_id"], "observationKey": ["patient_id"]},
            ],
            "variables": [
                {"table": "visits.csv", "name": "sbp", "unit": "mmHg", "type": "integer", "role": "covariate", "measuredAt": {"column": "visit_date"}},
                {"table": "visits.csv", "name": "creatinine", "unit": "umol/L", "type": "number", "role": "covariate", "measuredAt": {"column": "visit_date"}},
                {"table": "visits.csv", "name": "heart_rate", "unit": "beats/min", "type": "integer"},
                {"table": "patients.csv", "name": "sex", "allowedValues": ["M", "F"]},
            ],
            "joins": [{"left": {"table": "visits.csv", "columns": ["patient_id"]}, "right": {"table": "patients.csv", "columns": ["patient_id"]}, "cardinality": "many_to_one"}],
            "bindings": self.bindings(*bind, declared=declared) if bind else [],
        }
        return semantics_asset.build([base, *extra])["asset"]

    def check(self, asset, files=("visits.csv", "patients.csv", "outcomes.csv"), **more):
        request = {"workspace": self.workspace, "files": [{"path": "data/" + name} for name in files], "asset": asset, **more}
        return checks.run_checks(request)


class SecondDelivery(Workspace):
    """The fixture the plan names: one renamed column, one unit change, duplicated visit rows."""

    def test_the_unchanged_first_delivery_is_clean_and_says_it_is_the_recorded_version(self):
        result = self.check(self.asset())
        self.assertEqual(outcomes(result), ["source_unchanged"] * 3)
        self.assertEqual(result["notChecked"], [])
        # Nothing was found by the three families that looked at content; each says it looked.
        families = sorted({item["family"] for item in result["clean"]})
        self.assertEqual(families, ["duplicates", "joins"])

    def test_a_second_delivery_shows_the_rename_the_unit_change_and_the_duplicates_and_nothing_else(self):
        asset = self.asset()
        self.deliver("visits.csv", "visits_v2.csv")
        result = self.check(asset)
        self.assertEqual(outcomes(result, "drift"), ["column_renamed_candidate", "possible_unit_change", "source_changed", "source_unchanged", "source_unchanged"])
        self.assertEqual(outcomes(result, "duplicates"), ["duplicate_exact"])
        self.assertEqual([item for item in outcomes(result) if item not in ("column_renamed_candidate", "possible_unit_change", "source_changed", "source_unchanged", "duplicate_exact")], [])

        renamed = find(result, "column_renamed_candidate", table="visits.csv")
        self.assertEqual((renamed["detail"]["from"], renamed["detail"]["to"]), ("sbp", "systolic_bp"))
        self.assertIn("same position", renamed["detail"]["evidence"])
        self.assertEqual(renamed["severity"], "attention")

        unit = find(result, "possible_unit_change", table="visits.csv", column="creatinine")
        self.assertEqual((unit["detail"]["from"], unit["detail"]["to"]), ("umol/L", "mg/dL"))
        self.assertEqual(unit["detail"]["hint"], "declared_unit_matches")
        self.assertAlmostEqual(unit["detail"]["ratio"], 1 / semantics_fixtures.UMOL_PER_MGDL, delta=0.0005)

        changed = find(result, "source_changed", table="visits.csv")
        self.assertEqual((changed["detail"]["rowsBefore"], changed["detail"]["rowsAfter"]), (180, 183))

        duplicates = find(result, "duplicate_exact", table="visits.csv")
        self.assertEqual(duplicates["count"], 3)
        self.assertEqual(duplicates["detail"], {"groups": 3, "extraRows": 3})
        # The rows concerned are row numbers of the delivered file, and each is the second copy of a visit.
        (table,) = checks.read_tables(self.workspace, "data/visits.csv")
        for number in duplicates["rows"]:
            index = table.numbers.index(number)
            self.assertEqual(table.rows[index], table.rows[index - 1])
        self.assertEqual(len(duplicates["examples"]), 3)
        # Nothing about a patient reaches the findings: no key value, only a pseudonym of one.
        flat = repr(result["findings"])
        self.assertNotIn("P00", flat)

    def test_every_finding_is_information_for_the_analysis_to_use_none_stops_the_rest(self):
        asset = self.asset()
        self.deliver("visits.csv", "visits_v2.csv")
        result = self.check(asset, leakage={"cutoff": {"table": "outcomes.csv", "column": "window_start"}, "predictors": [{"table": "visits.csv", "column": "creatinine"}]})
        # The leakage family ran on the same delivery and its answer sits beside the drift, not instead of it.
        self.assertIn("temporal_leakage", outcomes(result))
        self.assertIn("duplicate_exact", outcomes(result))
        self.assertEqual({item["severity"] for item in result["findings"]}, {"attention", "information"})

    def test_a_delivery_under_a_new_file_name_is_matched_by_its_columns_and_says_so(self):
        asset = self.asset()
        shutil.copy(FIXTURES / "visits_v2.csv", self.path("visits_delivery_2.csv"))
        result = self.check(asset, files=("visits_delivery_2.csv", "patients.csv", "outcomes.csv"))
        visits = next(item for item in result["tables"] if item["file"] == "visits_delivery_2.csv")
        self.assertEqual(visits["table"], "visits.csv")
        self.assertTrue(visits["matchedBy"].startswith("columns:"), visits)
        self.assertIn("possible_unit_change", outcomes(result))
        # An explicit mapping wins over any guess, and says it was a mapping.
        mapped = checks.run_checks({"workspace": self.workspace, "asset": asset, "files": [{"path": "data/visits_delivery_2.csv", "table": "visits.csv"}]})
        self.assertEqual(mapped["tables"][0]["matchedBy"], "mapping")
        self.assertIn("possible_unit_change", outcomes(mapped))

    def test_a_recorded_former_name_is_a_known_rename_not_a_candidate(self):
        asset = self.asset(extra=[{**INFERRED, "variables": [{"table": "visits.csv", "name": "systolic_bp", "aliases": ["sbp"]}]}])
        self.deliver("visits.csv", "visits_v2.csv")
        result = self.check(asset)
        known = find(result, "column_renamed_known", table="visits.csv", column="systolic_bp")
        self.assertEqual((known["detail"]["from"], known["detail"]["to"]), ("sbp", "systolic_bp"))
        self.assertNotIn("column_renamed_candidate", outcomes(result))

    def test_a_header_that_changes_its_unit_is_a_unit_change_not_a_removed_column_and_an_added_one(self):
        first = self.path("visits.csv")
        text = first.read_text(encoding="utf-8").replace("creatinine,", "creatinine (umol/L),", 1)
        first.write_text(text, encoding="utf-8")
        asset = self.asset(declared=None)
        second = text.replace("creatinine (umol/L),", "creatinine (mg/dL),", 1)
        first.write_text(second, encoding="utf-8")
        result = self.check(asset, files=("visits.csv",))
        unit = find(result, "unit_changed", table="visits.csv", column="creatinine")
        self.assertEqual((unit["detail"]["from"], unit["detail"]["to"], unit["detail"]["evidence"]), ("umol/L", "mg/dL", "header"))
        self.assertNotIn("column_removed", outcomes(result))
        self.assertNotIn("column_added", outcomes(result))

    def test_a_scale_change_with_no_known_conversion_is_a_distribution_shift_with_its_ratio(self):
        asset = self.asset()
        path = self.path("visits.csv")
        rows = path.read_text(encoding="utf-8").splitlines()
        rewritten = [rows[0]]
        for line in rows[1:]:
            cells = line.split(",")
            cells[3] = str(int(cells[3]) * 7)
            rewritten.append(",".join(cells))
        path.write_text("\n".join(rewritten) + "\n", encoding="utf-8")
        result = self.check(asset, files=("visits.csv",))
        shift = find(result, "distribution_shift", table="visits.csv", column="sbp")
        self.assertAlmostEqual(shift["detail"]["ratio"], 7.0, places=1)
        self.assertEqual(shift["severity"], "information")
        self.assertNotIn("possible_unit_change", outcomes(result))

    def test_a_shift_inside_the_bounds_is_not_reported(self):
        asset = self.asset()
        path = self.path("visits.csv")
        rows = path.read_text(encoding="utf-8").splitlines()
        rewritten = [rows[0]]
        for index, line in enumerate(rows[1:]):
            cells = line.split(",")
            cells[3] = str(int(cells[3]) + (1 if index % 2 else 0))
            rewritten.append(",".join(cells))
        path.write_text("\n".join(rewritten) + "\n", encoding="utf-8")
        result = self.check(asset, files=("visits.csv",))
        self.assertEqual(outcomes(result, "drift"), ["source_changed"])

    def test_a_type_change_a_new_code_and_a_stray_missing_marker_each_have_their_outcome(self):
        asset = self.asset(extra=[{**INFERRED, "variables": [{"table": "visits.csv", "name": "heart_rate", "missingness": {"tokens": ["999"], "reason": "not_recorded"}}]}])
        path = self.path("visits.csv")
        lines = path.read_text(encoding="utf-8").splitlines()
        cells = lines[2].split(",")
        cells[3] = "n/a"           # a stray marker in a numeric column that is not declared
        cells[5] = "999"           # the declared marker: no finding
        lines[2] = ",".join(cells)
        cells = lines[3].split(",")
        cells[4] = "high"          # creatinine stops being a number? only one value: it is ignored by type unless ALL differ
        lines[3] = ",".join(cells)
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        patients = self.path("patients.csv")
        patients.write_text(patients.read_text(encoding="utf-8").replace("P040,", "P040,", 1).replace(",M,", ",U,", 3), encoding="utf-8")
        result = self.check(asset, files=("visits.csv", "patients.csv"))
        stray = find(result, "undeclared_missing_tokens", table="visits.csv", column="sbp")
        self.assertEqual(stray["detail"]["tokens"], ["n/a"])
        self.assertEqual(stray["count"], 1)
        self.assertFalse([item for item in result["findings"] if item["outcome"] == "undeclared_missing_tokens" and item["subject"].get("column") == "heart_rate"])
        codes = find(result, "new_codes", table="patients.csv", column="sex")
        self.assertEqual(codes["detail"]["codes"], ["U"])
        self.assertEqual(codes["count"], 3)
        self.assertEqual(find(result, "type_changed", table="visits.csv", column="creatinine")["detail"], {"from": "number", "to": "text"})

    def test_declared_codes_that_do_not_occur_are_information(self):
        asset = self.asset(extra=[{**INFERRED, "variables": [{"table": "patients.csv", "name": "sex", "allowedValues": ["M", "F", "X"]}]}])
        patients = self.path("patients.csv")
        patients.write_text(patients.read_text(encoding="utf-8") + "P041,M,A,S1\n", encoding="utf-8")
        result = self.check(asset, files=("patients.csv",))
        unseen = find(result, "codes_not_seen", table="patients.csv", column="sex")
        self.assertEqual(unseen["detail"]["codes"], ["X"])
        self.assertEqual(unseen["severity"], "information")

    def test_a_table_that_appears_or_disappears_is_named(self):
        asset = self.asset()
        shutil.copy(FIXTURES / "dictionary.csv", self.path("extra_sites.csv"))
        added = self.check(asset, files=("visits.csv", "patients.csv", "extra_sites.csv"), complete=True)
        self.assertEqual(find(added, "table_added", table="extra_sites.csv")["severity"], "attention")
        self.assertEqual(find(added, "table_removed", table="outcomes.csv")["severity"], "attention")

    def test_missingness_that_moves_beyond_the_bound_is_information(self):
        asset = self.asset()
        path = self.path("visits.csv")
        lines = path.read_text(encoding="utf-8").splitlines()
        out = [lines[0]]
        for index, line in enumerate(lines[1:]):
            cells = line.split(",")
            if index % 3 == 0:
                cells[5] = ""
            out.append(",".join(cells))
        path.write_text("\n".join(out) + "\n", encoding="utf-8")
        shift = find(self.check(asset, files=("visits.csv",)), "missingness_shift", table="visits.csv", column="heart_rate")
        self.assertGreater(shift["detail"]["after"] - shift["detail"]["before"], checks.MISSING_RATE_DELTA)

    def test_without_a_recorded_version_the_columns_cannot_be_compared_and_that_is_said(self):
        asset = self.asset(bind=())
        result = self.check(asset, files=("visits.csv",))
        self.assertEqual([item["reason"] for item in result["notChecked"] if item["family"] == "drift"], ["no_baseline"])
        self.assertNotIn("source_unchanged", outcomes(result))
        # And with no asset at all: the content checks still run on what the caller declares.
        bare = checks.run_checks({"workspace": self.workspace, "files": [{"path": "data/visits.csv"}], "asset": None, "observationKeys": {"visits.csv": ["patient_id", "visit_no"]}})
        self.assertEqual([item["reason"] for item in bare["notChecked"]], ["no_asset"])
        self.assertEqual([item["family"] for item in bare["clean"]], ["duplicates"])


class Duplicates(Workspace):
    def test_identical_rows_and_rows_that_disagree_are_different_outcomes(self):
        path = self.path("visits.csv")
        lines = path.read_text(encoding="utf-8").splitlines()
        lines.insert(3, lines[2])                                   # an exact copy of visit 1 of P001
        conflicting = lines[10].split(",")
        conflicting[3] = str(int(conflicting[3]) + 20)
        lines.insert(11, ",".join(conflicting))                      # the same visit with another blood pressure
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        result = self.check(self.asset(), files=("visits.csv",))
        exact = find(result, "duplicate_exact", table="visits.csv")
        conflict = find(result, "duplicate_conflicting", table="visits.csv")
        self.assertEqual((exact["count"], exact["detail"]["groups"]), (1, 1))
        self.assertEqual((conflict["count"], conflict["detail"]["groups"]), (1, 1))
        self.assertEqual(conflict["detail"]["differingColumns"], ["sbp"])
        self.assertEqual(exact["rows"], [3])         # the copy sits right after the visit it copies, which is row 2
        self.assertEqual(conflict["rows"], [11])
        self.assertEqual(outcomes(result, "duplicates"), ["duplicate_conflicting", "duplicate_exact"])

    def test_no_declared_key_is_not_checked_never_clean(self):
        asset = semantics_asset.build([{"datasetId": "d", **INFERRED, "tables": [{"name": "visits.csv", "observationUnit": "one row per visit"}]}])["asset"]
        result = checks.run_checks({"workspace": self.workspace, "files": [{"path": "data/visits.csv"}], "asset": asset})
        self.assertEqual([(item["family"], item["reason"]) for item in result["notChecked"] if item["family"] == "duplicates"], [("duplicates", "observation_key_undeclared")])
        self.assertEqual([item for item in result["clean"] if item["family"] == "duplicates"], [])

    def test_a_key_column_that_is_not_in_the_file_is_not_checked_and_a_recorded_alias_finds_it(self):
        self.deliver("visits.csv", "visits_v2.csv")
        text = self.path("visits.csv").read_text(encoding="utf-8").replace("visit_no", "visit_number", 1)
        self.path("visits.csv").write_text(text, encoding="utf-8")
        result = self.check(self.asset(), files=("visits.csv",))
        gap = [item for item in result["notChecked"] if item["family"] == "duplicates"]
        self.assertEqual([(item["reason"], item["subject"]["column"]) for item in gap], [("key_column_missing", "visit_no")])
        # Once the new name is recorded with its former one, the same key resolves and the duplicates appear.
        asset = self.asset(extra=[{**INFERRED, "variables": [{"table": "visits.csv", "name": "visit_number", "aliases": ["visit_no"]}]}])
        self.assertIn("duplicate_exact", outcomes(self.check(asset, files=("visits.csv",))))

    def test_a_key_with_a_blank_part_is_left_out_and_said(self):
        path = self.path("visits.csv")
        lines = path.read_text(encoding="utf-8").splitlines()
        cells = lines[5].split(",")
        cells[1] = ""
        lines[5] = ",".join(cells)
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        result = self.check(self.asset(), files=("visits.csv",))
        self.assertTrue(any("blank part" in warning for warning in result["warnings"]))
        self.assertEqual(outcomes(result, "duplicates"), [])


class Joins(Workspace):
    def join(self, cardinality, left="visits.csv", right="patients.csv", columns=("patient_id",)):
        return {"left": {"table": left, "columns": list(columns)}, "right": {"table": right, "columns": list(columns)}, "cardinality": cardinality}

    def test_a_join_that_is_what_it_was_declared_to_be_is_clean_and_its_shape_is_reported(self):
        result = self.check(self.asset(), files=("visits.csv", "patients.csv"))
        self.assertEqual(outcomes(result, "joins"), [])
        self.assertEqual([item["subject"]["join"] for item in result["clean"] if item["family"] == "joins"], ["visits.csv.patient_id->patients.csv.patient_id"])
        profile = result["joins"][0]
        self.assertEqual((profile["declared"], profile["observed"], profile["leftKeys"], profile["rightKeys"], profile["leftRows"], profile["rightRows"]), ("many_to_one", "many_to_one", 40, 40, 180, 40))

    def test_a_duplicate_key_on_the_one_side_would_multiply_rows_and_the_check_says_by_how_many(self):
        patients = self.path("patients.csv")
        lines = patients.read_text(encoding="utf-8").splitlines()
        lines.append(lines[1])                              # P001 appears twice
        patients.write_text("\n".join(lines) + "\n", encoding="utf-8")
        result = self.check(self.asset(), files=("visits.csv", "patients.csv"))
        violation = find(result, "join_cardinality_violation", table="patients.csv")
        self.assertEqual(violation["detail"]["declared"], "many_to_one")
        self.assertEqual(violation["detail"]["observed"], "many_to_many")
        self.assertEqual(violation["detail"]["side"], "right")
        self.assertEqual(violation["detail"]["repeatedKeys"], 1)
        # P001 has three visits: the join would turn 180 rows into 183.
        self.assertEqual((violation["detail"]["leftRows"], violation["detail"]["rowsAfterJoin"]), (180, 183))
        self.assertEqual(violation["rows"], [41])

    def test_keys_with_no_partner_are_named_and_the_severe_side_is_the_many_side(self):
        patients = self.path("patients.csv")
        lines = patients.read_text(encoding="utf-8").splitlines()
        patients.write_text("\n".join([lines[0], *lines[2:]]) + "\nP900,F,A,S1\n", encoding="utf-8")   # P001 gone, P900 has no visits
        result = self.check(self.asset(), files=("visits.csv", "patients.csv"))
        orphans = find(result, "join_orphans", join="visits.csv.patient_id->patients.csv.patient_id")
        self.assertEqual(orphans["detail"], {"leftOnlyKeys": 1, "leftOnlyRows": 3, "rightOnlyKeys": 1, "rightOnlyRows": 1, "leftRows": 180, "rightRows": 40})
        self.assertEqual(orphans["severity"], "attention")
        self.assertEqual(orphans["rows"], [1, 2, 3])
        # Only childless parents: information, not attention.
        patients.write_text("\n".join(lines) + "\nP900,F,A,S1\n", encoding="utf-8")
        mild = find(self.check(self.asset(), files=("visits.csv", "patients.csv")), "join_orphans", join="visits.csv.patient_id->patients.csv.patient_id")
        self.assertEqual(mild["severity"], "information")

    def test_a_missing_empty_or_differently_typed_key_is_an_invalid_join(self):
        visits = self.path("visits.csv")
        text = visits.read_text(encoding="utf-8")
        visits.write_text(text.replace("patient_id", "pid", 1), encoding="utf-8")
        result = self.check(self.asset(), files=("visits.csv", "patients.csv"))
        self.assertEqual(find(result, "join_key_invalid", table="visits.csv")["detail"]["problem"], "column_missing")
        visits.write_text(text, encoding="utf-8")
        patients = self.path("patients.csv")
        ptext = patients.read_text(encoding="utf-8")
        patients.write_text("patient_id,sex,arm,site\n" + "\n".join(",".join(["", *line.split(",")[1:]]) for line in ptext.splitlines()[1:]) + "\n", encoding="utf-8")
        self.assertEqual(find(self.check(self.asset(), files=("visits.csv", "patients.csv")), "join_key_invalid", table="patients.csv")["detail"]["problem"], "all_blank")
        # Numeric keys on one side and ids on the other: equal-looking keys that are not.
        patients.write_text("patient_id,sex,arm,site\n" + "\n".join("%d,M,A,S1" % index for index in range(1, 41)) + "\n", encoding="utf-8")
        mismatch = find(self.check(self.asset(), files=("visits.csv", "patients.csv")), "join_key_invalid")
        self.assertEqual(mismatch["detail"]["problem"], "type_mismatch")

    def test_a_join_whose_other_table_was_not_given_is_not_checked(self):
        result = self.check(self.asset(), files=("visits.csv",))
        self.assertEqual([(item["family"], item["reason"]) for item in result["notChecked"]], [("joins", "join_table_unavailable")])

    def test_an_inline_join_without_a_declared_cardinality_reports_the_shape_it_found(self):
        asset = semantics_asset.build([{"datasetId": "d", **INFERRED, "tables": [{"name": "visits.csv", "subjectKey": ["patient_id"]}]}])["asset"]
        result = checks.run_checks({"workspace": self.workspace, "files": [{"path": "data/visits.csv"}, {"path": "data/outcomes.csv"}], "asset": asset,
                                    "joins": [self.join(None, right="outcomes.csv")]})
        self.assertEqual(result["joins"][0]["observed"], "many_to_one")
        self.assertEqual(result["joins"][0]["declared"], None)

    def test_a_declared_one_to_one_that_is_many_to_one_is_a_violation_on_the_left(self):
        asset = self.asset(extra=[{**INFERRED, "joins": [self.join("one_to_one")]}])
        result = self.check(asset, files=("visits.csv", "patients.csv"))
        violation = find(result, "join_cardinality_violation", table="visits.csv")
        self.assertEqual((violation["detail"]["declared"], violation["detail"]["observed"], violation["detail"]["side"]), ("one_to_one", "many_to_one", "left"))
        self.assertEqual(violation["detail"]["repeatedKeys"], 40)


class Denominators(Workspace):
    def steps(self):
        return [
            {"label": "delivered", "kind": "filter", "table": "visits.csv"},
            {"label": "analysed", "kind": "filter", "rows": 150, "subjects": 35},
        ]

    def test_every_exclusion_is_sized_and_a_step_can_be_measured_or_reported(self):
        result = self.check(self.asset(), files=("visits.csv",), steps=self.steps())
        decrease = find(result, "denominator_decrease", step="delivered -> analysed")
        self.assertEqual(decrease["severity"], "information")
        self.assertEqual(decrease["detail"], {"rowsBefore": 180, "rowsAfter": 150, "subjectsBefore": 40, "subjectsAfter": 35, "what": ["rows", "subjects"], "share": 0.166667})
        self.assertEqual(decrease["count"], 30)
        self.assertEqual(result["denominators"]["delivered"], {"rows": 180, "subjects": 40, "source": "measured"})
        self.assertEqual(result["denominators"]["analysed"], {"rows": 150, "subjects": 35, "source": "reported"})

    def test_a_filter_cannot_add_rows(self):
        steps = [{"label": "cohort", "rows": 100, "subjects": 30}, {"label": "analysed", "kind": "filter", "rows": 120, "subjects": 30}]
        result = self.check(self.asset(), files=("visits.csv",), steps=steps)
        increase = find(result, "denominator_increase", step="cohort -> analysed")
        self.assertEqual((increase["detail"]["rowsBefore"], increase["detail"]["rowsAfter"], increase["detail"]["what"]), (100, 120, ["rows"]))
        # A join may, because fanning out is what a join does when the key repeats.
        steps[1]["kind"] = "join"
        self.assertNotIn("denominator_increase", outcomes(self.check(self.asset(), files=("visits.csv",), steps=steps)))

    def test_a_step_that_is_not_the_count_recorded_last_time_says_so(self):
        asset = self.asset()
        first = self.check(asset, files=("visits.csv",), steps=self.steps())
        recorded = semantics_asset.build([{"datasetId": "d", **INFERRED}])["asset"]
        recorded["denominators"] = {label: {**value, "at": "2026-10-04T08:00:00.000Z"} for label, value in first["denominators"].items()}
        again = checks.run_checks({"workspace": self.workspace, "files": [{"path": "data/visits.csv"}], "asset": recorded, "steps": self.steps()})
        self.assertNotIn("denominator_changed", outcomes(again))
        self.assertIn({"family": "denominators", "subject": {"step": "analysed"}}, again["clean"])
        # The same analysis over the second delivery: 183 rows now, not 180.
        self.deliver("visits.csv", "visits_v2.csv")
        changed = checks.run_checks({"workspace": self.workspace, "files": [{"path": "data/visits.csv"}], "asset": recorded, "steps": self.steps()})
        step = find(changed, "denominator_changed", step="delivered")
        self.assertEqual((step["detail"]["rowsBefore"], step["detail"]["rowsAfter"]), (180, 183))

    def test_a_step_given_as_a_file_is_counted_from_the_file(self):
        shutil.copy(self.path("visits.csv"), self.path("cohort.csv"))
        steps = [{"label": "delivered", "path": "data/visits.csv", "subjectColumns": ["patient_id"]}, {"label": "cohort", "path": "data/cohort.csv", "subjectColumns": ["patient_id"]}]
        result = self.check(self.asset(), files=("visits.csv",), steps=steps)
        self.assertEqual(result["denominators"], {"delivered": {"rows": 180, "subjects": 40, "source": "measured"}, "cohort": {"rows": 180, "subjects": 40, "source": "measured"}})
        self.assertEqual(outcomes(result, "denominators"), [])
        missing = self.check(self.asset(), files=("visits.csv",), steps=[{"label": "gone", "path": "data/nothing.csv"}])
        self.assertEqual([(item["family"], item["reason"]) for item in missing["notChecked"] if item["family"] == "denominators"], [("denominators", "file_unreadable")])


class Leakage(Workspace):
    cutoff = {"table": "outcomes.csv", "column": "window_start"}

    def test_visits_after_the_window_opens_are_leakage_and_the_count_is_exact(self):
        result = self.check(self.asset(), files=("visits.csv", "outcomes.csv"), leakage={"cutoff": self.cutoff})
        # No predictor is named: the recorded covariates with a measurement time are checked.
        leaked = sorted(item["subject"]["predictor"] for item in result["findings"] if item["outcome"] == "temporal_leakage")
        self.assertEqual(leaked, ["creatinine", "sbp"])
        creatinine = find(result, "temporal_leakage", predictor="creatinine")
        # Patients with 4, 5 and 6 visits (ten each) have 1, 2 and 3 visits after the third.
        self.assertEqual(creatinine["count"], 60)
        self.assertEqual(creatinine["detail"]["subjects"], 30)
        self.assertEqual(creatinine["detail"]["rowsChecked"], 180)
        self.assertEqual(creatinine["detail"]["cutoffColumn"], "window_start")
        self.assertEqual(len(creatinine["rows"]), checks.SAMPLE_ROWS)

    def test_a_predictor_measured_only_before_the_window_is_clean(self):
        visits = self.path("visits.csv")
        lines = visits.read_text(encoding="utf-8").splitlines()
        visits.write_text("\n".join(line for index, line in enumerate(lines) if index == 0 or int(line.split(",")[1]) <= 3) + "\n", encoding="utf-8")
        result = self.check(self.asset(), files=("visits.csv", "outcomes.csv"), leakage={"cutoff": self.cutoff, "predictors": [{"table": "visits.csv", "column": "sbp"}]})
        self.assertEqual(outcomes(result, "leakage"), [])
        self.assertIn({"family": "leakage", "subject": {"table": "visits.csv", "predictor": "sbp"}}, result["clean"])

    def test_a_missing_cutoff_or_measurement_time_is_not_checked_and_never_clean(self):
        asset = self.asset()
        none = self.check(asset, files=("visits.csv", "outcomes.csv"), leakage={})
        self.assertEqual([item["reason"] for item in none["notChecked"] if item["family"] == "leakage"], ["cutoff_undeclared"])
        no_time = self.check(asset, files=("visits.csv", "outcomes.csv"), leakage={"cutoff": self.cutoff, "predictors": [{"table": "visits.csv", "column": "heart_rate"}]})
        self.assertEqual([item["reason"] for item in no_time["notChecked"] if item["family"] == "leakage"], ["measurement_time_undeclared"])
        explicit = self.check(asset, files=("visits.csv", "outcomes.csv"), leakage={"cutoff": self.cutoff, "predictors": [{"table": "visits.csv", "column": "heart_rate", "timeColumn": "visit_date"}]})
        self.assertEqual(find(explicit, "temporal_leakage", predictor="heart_rate")["detail"]["timeColumn"], "visit_date")
        gone = self.check(asset, files=("visits.csv", "outcomes.csv"), leakage={"cutoff": {"table": "outcomes.csv", "column": "nope"}})
        self.assertEqual([item["reason"] for item in gone["notChecked"] if item["family"] == "leakage"], ["cutoff_undeclared"])

    def test_times_that_cannot_be_read_are_counted_not_guessed(self):
        outcomes_file = self.path("outcomes.csv")
        outcomes_file.write_text("patient_id,window_start,event_date,event\n" + "\n".join("P%03d,03/04/2023,2023-12-01,0" % index for index in range(1, 41)) + "\n", encoding="utf-8")
        result = self.check(self.asset(), files=("visits.csv", "outcomes.csv"), leakage={"cutoff": self.cutoff})
        self.assertEqual([item["reason"] for item in result["notChecked"] if item["family"] == "leakage"], ["time_unparseable"])
        self.assertEqual(outcomes(result, "leakage"), [])

    def test_a_measurement_on_the_cutoff_day_is_not_after_it(self):
        outcomes_file = self.path("outcomes.csv")
        outcomes_file.write_text("patient_id,window_start,event_date,event\n" + "\n".join("P%03d,2023-04-05 10:00,2023-12-01,0" % index for index in range(1, 41)) + "\n", encoding="utf-8")
        visits = self.path("visits.csv")
        visits.write_text("patient_id,visit_no,visit_date,sbp,creatinine,heart_rate\nP001,1,2023-04-05,120,90.0,70\nP001,2,2023-04-05 09:00,121,90.0,70\nP001,3,2023-04-05 11:00,122,90.0,70\nP001,4,2023-04-06,123,90.0,70\n", encoding="utf-8")
        result = self.check(self.asset(bind=()), files=("visits.csv", "outcomes.csv"), leakage={"cutoff": self.cutoff, "predictors": [{"table": "visits.csv", "column": "sbp"}]})
        # A date-only measurement cannot be after a moment the same day; the 11:00 one is, as is the next day's.
        self.assertEqual(find(result, "temporal_leakage", predictor="sbp")["rows"], [3, 4])


class Transformations(Workspace):
    def asset_with_transformation(self):
        code = pathlib.Path(self.workspace) / "analysis"
        code.mkdir()
        (code / "egfr.py").write_text("print('egfr')\n", encoding="utf-8")
        sha = checks.file_sha256(self.workspace, "analysis/egfr.py")
        patch = {"transformations": []}
        asset = self.asset()
        asset["transformations"] = [{"name": "egfr", "kind": "derive", "inputs": [{"table": "visits.csv", "columns": ["creatinine"]}], "code": {"path": "analysis/egfr.py", "sha256": sha},
                                     "version": 1, "recordedAt": "2026-10-04T08:00:00.000Z", "history": []}]
        del patch
        return asset, code / "egfr.py"

    def test_the_recorded_code_is_the_code_that_is_there_or_the_check_says_what_changed(self):
        asset, script = self.asset_with_transformation()
        self.assertIn({"family": "transformations", "subject": {"step": "egfr"}}, self.check(asset, files=("visits.csv",))["clean"])
        script.write_text("print('egfr v2')\n", encoding="utf-8")
        changed = find(self.check(asset, files=("visits.csv",)), "transformation_code_changed", step="egfr")
        self.assertEqual(changed["detail"]["version"], 1)
        self.assertNotEqual(changed["detail"]["recorded"], changed["detail"]["current"])
        script.unlink()
        self.assertEqual(find(self.check(asset, files=("visits.csv",)), "transformation_code_missing", step="egfr")["detail"]["path"], "analysis/egfr.py")


class Reading(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.workspace = pathlib.Path(directory.name)

    def test_a_workspace_path_cannot_leave_the_workspace_or_follow_a_link(self):
        (self.workspace / "a.csv").write_text("x\n1\n", encoding="utf-8")
        outside = tempfile.TemporaryDirectory()
        self.addCleanup(outside.cleanup)
        (pathlib.Path(outside.name) / "secret.csv").write_text("x\n1\n", encoding="utf-8")
        os.symlink(outside.name, self.workspace / "linked")
        os.symlink(pathlib.Path(outside.name) / "secret.csv", self.workspace / "link.csv")
        for bad in ("../a.csv", "/etc/passwd", "a/../a.csv", "linked/secret.csv", "link.csv", "nothing.csv", "a\\b.csv", ""):
            with self.assertRaises(checks.TableError, msg=bad) as caught:
                checks.read_tables(str(self.workspace), bad)
            self.assertEqual(caught.exception.reason, "file_unreadable", bad)
        (self.workspace / "dir.csv").mkdir()
        with self.assertRaises(checks.TableError):
            checks.read_tables(str(self.workspace), "dir.csv")

    def test_formats_encodings_and_limits(self):
        (self.workspace / "bom.csv").write_bytes("﻿id,体重\n1,60\n".encode("utf-8"))
        (self.workspace / "gbk.csv").write_bytes("编号,体重\n1,60\n".encode("gb18030"))
        (self.workspace / "t.tsv").write_text("a\tb\n1\t2\n\n3\t4\n", encoding="utf-8")
        (self.workspace / "notes.docx").write_bytes(b"PK")
        self.assertEqual(checks.read_tables(str(self.workspace), "bom.csv")[0].columns, ["id", "体重"])
        self.assertEqual(checks.read_tables(str(self.workspace), "gbk.csv")[0].columns, ["编号", "体重"])
        tsv = checks.read_tables(str(self.workspace), "t.tsv")[0]
        self.assertEqual((tsv.columns, tsv.rows, tsv.numbers), (["a", "b"], [["1", "2"], ["3", "4"]], [1, 3]))   # the blank record still counts in the numbering
        with self.assertRaises(checks.TableError) as caught:
            checks.read_tables(str(self.workspace), "notes.docx")
        self.assertEqual(caught.exception.reason, "format_unsupported")
        (self.workspace / "big.csv").write_text("a\n" + "1\n" * 100, encoding="utf-8")
        original = checks.MAX_BYTES
        checks.MAX_BYTES = 50
        try:
            with self.assertRaises(checks.TableError) as caught:
                checks.read_tables(str(self.workspace), "big.csv")
        finally:
            checks.MAX_BYTES = original
        self.assertEqual(caught.exception.reason, "file_too_large")

    def test_a_workbook_is_one_table_per_sheet_when_a_reader_is_installed(self):
        try:
            from openpyxl import Workbook
        except ImportError:
            self.skipTest("no Excel reader installed")
        book = Workbook()
        book.active.title = "visits"
        book.active.append(["patient_id", "sbp"])
        book.active.append(["P1", 120])
        other = book.create_sheet("labs")
        other.append(["patient_id", "crp"])
        other.append(["P1", 4.2])
        book.save(self.workspace / "x.xlsx")
        tables = checks.read_tables(str(self.workspace), "x.xlsx")
        self.assertEqual([t.name for t in tables], ["x.xlsx#visits", "x.xlsx#labs"])
        self.assertEqual(tables[0].rows, [["P1", "120"]])

    def test_a_duplicated_header_is_made_unique_not_dropped(self):
        (self.workspace / "d.csv").write_text("a,a,b\n1,2,3\n", encoding="utf-8")
        self.assertEqual(checks.read_tables(str(self.workspace), "d.csv")[0].columns, ["a", "a__2", "b"])


class Profiles(unittest.TestCase):
    def test_a_profile_is_aggregates_and_the_header_unit(self):
        profile = checks.profile_column("Weight (kg)", [str(60 + i) for i in range(20)] + ["", "NA"])
        self.assertEqual((profile["type"], profile["missing"], profile["distinct"], profile["headerUnit"]), ("integer", 2, 20, "kg"))
        self.assertEqual(profile["numeric"]["n"], 20)
        self.assertEqual((profile["numeric"]["min"], profile["numeric"]["median"], profile["numeric"]["max"]), (60.0, 69.5, 79.0))

    def test_no_summary_under_the_floor_and_none_for_an_identifier(self):
        self.assertNotIn("numeric", checks.profile_column("x", [str(i) for i in range(checks.MIN_CELL - 1)]))
        self.assertNotIn("numeric", checks.profile_column("record_no", [str(i) for i in range(50)], identifying=True))
        self.assertNotIn("numeric", checks.profile_column("when", ["2023-01-01"] * 20))

    def test_identifying_columns_are_recognised_by_name_and_by_shape(self):
        for name in ("patient_id", "PatientID", "mrn", "住院号", "visit_no", "Name", "phone", "email", "身份证号", "subject_code"):
            self.assertTrue(checks.name_is_identifying(name), name)
        for name in ("sbp", "creatinine", "arm", "site", "adm_dept_code", "record_date", "heart_rate", "sex"):
            self.assertFalse(checks.name_is_identifying(name), name)
        self.assertTrue(checks.values_are_identifying(["13800138000"] * 6))
        self.assertTrue(checks.values_are_identifying(["a@b.cn"] * 6))
        self.assertFalse(checks.values_are_identifying(["M", "F"] * 6))
        self.assertFalse(checks.values_are_identifying(["13800138000"] * 4))

    def test_a_vocabulary_is_given_only_for_a_column_that_is_a_code_list(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        workspace = pathlib.Path(directory.name)
        shutil.copy(FIXTURES / "visits_v1.csv", workspace / "v.csv")
        shutil.copy(FIXTURES / "patients.csv", workspace / "p.csv")
        (visits,) = checks.read_tables(str(workspace), "v.csv")
        (patients,) = checks.read_tables(str(workspace), "p.csv")
        self.assertEqual(checks.observed_vocabulary(patients, "arm"), (["A", "B"], None))
        self.assertEqual(checks.observed_vocabulary(patients, "sex"), (["F", "M"], None))
        self.assertEqual(checks.observed_vocabulary(visits, "patient_id"), (None, "identifying"))
        self.assertEqual(checks.observed_vocabulary(visits, "creatinine"), (None, "high_cardinality"))
        self.assertEqual(checks.observed_vocabulary(visits, "nope"), (None, "key_column_missing"))

    def test_unit_conversions_name_the_pair_whose_factor_the_ratio_has(self):
        found = checks.unit_candidates(1 / 88.4, "umol/L")
        self.assertEqual((found[0]["from"], found[0]["to"], found[0]["hint"]), ("umol/L", "mg/dL", "declared_unit_matches"))
        glucose = checks.unit_candidates(18.0, None)[0]
        self.assertEqual((glucose["from"], glucose["to"], glucose["measure"]), ("mmol/L", "mg/dL", "glucose"))
        self.assertEqual(checks.unit_candidates(7.0, "umol/L"), [])
        self.assertEqual(checks.unit_key("µmol / L"), "umol/l")

    def test_unreadable_or_ambiguous_times_are_not_guessed(self):
        self.assertIsNone(checks.parse_time("03/04/2023"))
        self.assertIsNone(checks.parse_time("soon"))
        self.assertEqual(checks.parse_time("2023-04-05"), (checks.datetime(2023, 4, 5), False))
        self.assertEqual(checks.parse_time("2023/04/05 10:30"), (checks.datetime(2023, 4, 5, 10, 30), True))
        self.assertEqual(checks.parse_time("20230405"), (checks.datetime(2023, 4, 5), False))


class Vocabulary(unittest.TestCase):
    def test_this_module_holds_the_domains_vocabulary_and_bounds(self):
        outcomes_, reasons, families, bounds = semantics_asset.domain_exports("DATA_CHECK_OUTCOMES", "DATA_CHECK_NOT_CHECKED_REASON_IDS", "DATA_CHECK_FAMILIES", "DATA_DRIFT_BOUNDS")
        self.assertEqual({key: (value["family"], value["severity"]) for key, value in outcomes_.items()}, checks.OUTCOMES)
        self.assertEqual(list(checks.NOT_CHECKED_REASONS), reasons)
        self.assertEqual(list(checks.FAMILIES), families)
        self.assertEqual((checks.MIN_CELL, checks.MEDIAN_SHIFT_IQR, checks.SCALE_RATIO, checks.MISSING_RATE_DELTA, checks.VOCABULARY_MAX, checks.SAMPLE_ROWS),
                         (bounds["minCell"], bounds["medianShiftIqr"], bounds["scaleRatio"], bounds["missingRateDelta"], bounds["vocabularyMax"], bounds["sampleRows"]))

    def test_the_committed_fixture_files_are_what_the_generator_builds(self):
        for name, text in semantics_fixtures.build().items():
            self.assertEqual((FIXTURES / name).read_text(encoding="utf-8"), text, name)


if __name__ == "__main__":
    unittest.main()
