"""`clinical_score`: the engine (refusals, units, versions, assumptions), the tool's wire and registration.

The scales' own worked examples are in test_clinical_score_scales.py. Nothing here reaches a network.
"""
import json
import os
import pathlib
import re
import sys
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.dont_write_bytecode = True
import clinical_score_kit as kit
import clinical_scores
import server

REPO = ROOT.parents[2]


def compute(scale, inputs, **extra):
    return clinical_scores.call({"action": "compute", "id": scale, "inputs": inputs, **extra})


def refused(test, scale, inputs, code, **extra):
    with test.assertRaises(kit.ScoreError) as caught:
        compute(scale, inputs, **extra)
    test.assertEqual(caught.exception.code, code, str(caught.exception))
    return caught.exception


class ListAndDescribe(unittest.TestCase):
    def test_list_is_names_and_ids_only_and_filters_by_every_word(self):
        everything = clinical_scores.call({"action": "list"})["data"]
        self.assertEqual(everything["count"], len(clinical_scores.SCALES))
        for row in everything["scores"]:
            self.assertEqual(set(row), {"id", "name", "group"})
        found = clinical_scores.call({"action": "list", "filter": "meld na"})["data"]["scores"]
        self.assertIn("meld_na", {row["id"] for row in found})
        self.assertEqual(clinical_scores.call({"action": "list", "filter": "no such score anywhere"})["data"]["count"], 0)
        # a score is found by an alias as well as by its name
        self.assertIn("ckd_epi_2021", {row["id"] for row in clinical_scores.call({"action": "list", "filter": "egfr"})["data"]["scores"]})

    def test_describe_states_items_units_versions_and_source_for_every_score(self):
        for scale_id, scale in clinical_scores.SCALES.items():
            with self.subTest(scale=scale_id):
                described = clinical_scores.call({"action": "describe", "id": scale_id})["data"]
                self.assertTrue(described["source"].strip())
                self.assertTrue(described["scope"].strip())
                self.assertEqual([item["id"] for item in described["items"]], scale.item_order)
                self.assertEqual(sum(1 for version in described["versions"] if version["default"]), 1)
                for version in described["versions"]:
                    self.assertTrue(version["source"].strip(), "a version without a source")
                    self.assertTrue(set(version["reads"]) <= set(scale.items), version["id"])
                for item in described["items"]:
                    if item["type"] == "number":
                        self.assertTrue("unit" in item or item.get("accepts") == "a plain number", item["id"])

    def test_an_unknown_id_is_refused_with_near_matches(self):
        error = None
        with self.assertRaises(kit.ScoreError) as caught:
            clinical_scores.call({"action": "describe", "id": "child_pug"})
        error = caught.exception
        self.assertEqual(error.code, kit.UNKNOWN_SCORE)
        self.assertIn("child_pugh", error.data["did_you_mean"])


class Units(unittest.TestCase):
    def test_a_measurement_without_its_unit_is_refused_and_a_unit_of_another_quantity_too(self):
        error = refused(self, "bmi", {"weight": 70, "height": "175 cm"}, kit.UNIT_INVALID)
        self.assertEqual(error.data["accepted_units"], ["kg", "lb"])
        refused(self, "bmi", {"weight": "70 mg/dL", "height": "175 cm"}, kit.UNIT_INVALID)
        refused(self, "bmi", {"weight": {"value": 70, "unit": "stone"}, "height": "175 cm"}, kit.UNIT_INVALID)

    def test_units_convert_and_the_conversion_is_shown(self):
        metric = compute("bmi", {"weight": "70 kg", "height": "175 cm"})["data"]
        imperial = compute("bmi", {"weight": {"value": 154.3235835, "unit": "lb"}, "height": {"value": 68.8976378, "unit": "in"}})["data"]
        self.assertEqual(metric["result"]["value"], imperial["result"]["value"])
        self.assertIn("converted", imperial["items"][0])

    def test_an_implausible_value_is_refused_as_a_probable_unit_slip(self):
        error = refused(self, "bmi", {"weight": "700 kg", "height": "175 cm"}, kit.OUT_OF_RANGE)
        self.assertEqual(error.data["item"], "weight")
        refused(self, "bmi", {"weight": "-3 kg", "height": "175 cm"}, kit.OUT_OF_RANGE)

    def test_inputs_that_are_not_numbers_are_refused(self):
        refused(self, "bmi", {"weight": "heavy", "height": "175 cm"}, kit.INPUT_INVALID)
        refused(self, "bmi", {"weight": {"value": True, "unit": "kg"}, "height": "175 cm"}, kit.INPUT_INVALID)
        refused(self, "bmi", {"weight": {"value": float("nan"), "unit": "kg"}, "height": "175 cm"}, kit.INPUT_INVALID)
        refused(self, "bmi", {"weight": {"value": 70, "unit": "kg", "note": "x"}, "height": "175 cm"}, kit.INPUT_INVALID)

    def test_the_lab_factors_are_the_molar_masses_not_a_typed_table(self):
        # 1 mg/dL = 10 mg/L = (10 / molar mass) mmol/L = (10000 / molar mass) umol/L
        for quantity, unit, mass in (("creatinine", "umol/L", 113.12), ("bilirubin", "umol/L", 584.66)):
            canonical, table = kit.QUANTITIES[quantity]
            _name, scale, _offset = table[unit]
            self.assertAlmostEqual(1 / scale, 10000 / mass, delta=0.15, msg=quantity)
        _name, scale, _ = kit.QUANTITIES["glucose"][1]["mmol/L"]
        self.assertAlmostEqual(scale, 180.156 / 10, delta=0.02)
        _name, scale, _ = kit.QUANTITIES["urea_nitrogen"][1]["mmol/L"]
        self.assertAlmostEqual(scale, 28.014 / 10, delta=0.001)

    def test_the_factors_agree_with_the_domain_unit_table_the_matching_tools_convert_with(self):
        # The runtime image carries no copy of packages/domain, so the two tables are held equal here, in the repository, by their molar masses.
        # 1 unit of a molar concentration is molar mass x size g/L, which is molar mass x size x 100 mg/dL.
        table_path = REPO / "packages" / "domain" / "src" / "clinical-units.json"
        if not table_path.exists():
            self.skipTest("the domain unit table is not beside this copy of the tool")
        domain = json.loads(table_path.read_text(encoding="utf8"))
        molar_mass = {row["id"]: row["molarMass"] for row in domain["analytes"] if "molarMass" in row}
        sizes = domain["molarConcentration"]["sizes"]
        for quantity, unit, analyte in (("creatinine", "umol/L", "creatinine"), ("bilirubin", "umol/L", "bilirubin"), ("glucose", "mmol/L", "glucose"),
                                        ("cholesterol", "mmol/L", "cholesterol"), ("triglycerides", "mmol/L", "triglycerides"), ("urea_nitrogen", "mmol/L", "bun"),
                                        ("calcium", "mmol/L", "calcium")):
            _name, scale, _offset = kit.QUANTITIES[quantity][1][unit]
            expected = molar_mass[analyte] * sizes[unit] * 100
            self.assertAlmostEqual(scale / expected, 1.0, delta=0.005, msg="%s in %s: tool %s, domain %s" % (quantity, unit, scale, expected))
        # insulin: the explicit row of the domain table, 6.945 pmol/L per uIU/mL
        row = next(row for row in domain["conversions"] if row["analyte"] == "insulin")
        _name, scale, _offset = kit.QUANTITIES["insulin"][1]["pmol/L"]
        self.assertAlmostEqual(scale * row["factor"], 1.0, places=6)


class Missing(unittest.TestCase):
    def test_an_unknown_item_is_refused_and_never_ignored(self):
        error = refused(self, "bmi", {"weight": "70 kg", "height": "175 cm", "wieght": "1 kg"}, kit.UNKNOWN_INPUT)
        self.assertEqual(error.data["unknown"], ["wieght"])
        self.assertIn("weight", error.data["did_you_mean"]["wieght"])

    def test_a_missing_item_computes_nothing_and_says_which_and_what_the_score_could_range_over(self):
        error = refused(self, "has_bled", {"age": 70, "hypertension_uncontrolled": True}, kit.MISSING_INPUTS)
        self.assertIn("abnormal_renal_function", error.data["missing"])
        self.assertFalse(error.data["computed"])
        self.assertNotIn("value", json.dumps(error.data["missing_detail"]))
        # the points already earned are the floor, every missing item present is the ceiling
        self.assertEqual(error.data["possible_range"]["min"], 2)
        self.assertEqual(error.data["possible_range"]["max"], 2 + len(error.data["missing"]))
        self.assertEqual(error.data["if_assume_absent"]["value"], 2)
        self.assertIn("nothing was assumed", error.data["if_assume_absent"]["note"])

    def test_absence_is_assumed_only_when_the_caller_names_it(self):
        base = {"age": 70, "hypertension_uncontrolled": True}
        reply = compute("has_bled", base, assume_absent=["all"])
        self.assertEqual(reply["status"], "warning")
        self.assertEqual(reply["data"]["result"]["value"], 2)
        self.assertTrue(reply["data"]["assumed_absent"])
        self.assertIn("absent", reply["warnings"][0])
        named = compute("has_bled", base, assume_absent=sorted(clinical_scores.SCALES["has_bled"].item_order))
        self.assertEqual(named["data"]["result"]["value"], 2)
        self.assertTrue(all(row.get("assumed_absent") for row in named["data"]["items"] if row["input"] == "assumed absent"))

    def test_a_measurement_cannot_be_assumed_absent(self):
        error = refused(self, "ckd_epi_2021", {"age": 50, "sex": "male"}, kit.ABSENT_INVALID, assume_absent=["creatinine"])
        self.assertEqual(error.data["item"], "creatinine")
        # "all" skips what cannot be assumed and the refusal for it stands
        again = refused(self, "ckd_epi_2021", {"age": 50, "sex": "male"}, kit.MISSING_INPUTS, assume_absent=["all"])
        self.assertEqual(again.data["missing"], ["creatinine"])

    def test_assume_absent_naming_nothing_real_is_refused(self):
        refused(self, "has_bled", {}, kit.UNKNOWN_INPUT, assume_absent=["colour"])


class Versions(unittest.TestCase):
    def test_every_other_version_is_reported_in_the_same_result_or_says_why_not(self):
        data = compute("mdrd", {"creatinine": "1.0 mg/dL", "age": 50, "sex": "male", "black_race": False})["data"]
        self.assertEqual(data["version"], "idms_175")
        self.assertTrue(data["default_version"])
        alternative = {row["version"]: row for row in data["alternatives"]}["original_186"]
        self.assertGreater(alternative["value"], data["result"]["value"])
        self.assertAlmostEqual(alternative["value"] / data["result"]["value"], 186 / 175, places=2)
        # an alternative that needs an item the caller did not give is named, not guessed
        meld = compute("meld_na", {"bilirubin": "2 mg/dL", "inr": 1.5, "creatinine": "1.5 mg/dL", "sodium": "130 mmol/L", "dialysis": False})["data"]
        by_version = {row["version"]: row for row in meld["alternatives"]}
        self.assertIn("albumin", by_version["meld_3_0"]["not_computed"])
        self.assertIn("value", by_version["kim_2008"])

    def test_choosing_a_version_makes_it_the_result_and_the_default_an_alternative(self):
        data = compute("mdrd", {"creatinine": "1.0 mg/dL", "age": 50, "sex": "male", "black_race": False}, version="original_186")["data"]
        self.assertFalse(data["default_version"])
        self.assertIn("idms_175", {row["version"] for row in data["alternatives"]})

    def test_an_unknown_version_is_refused_with_the_versions_there_are(self):
        error = refused(self, "mdrd", {"creatinine": "1.0 mg/dL", "age": 50, "sex": "male", "black_race": False}, kit.UNKNOWN_VERSION, version="1999")
        self.assertEqual(error.data["default"], "idms_175")


class Refusals(unittest.TestCase):
    def test_every_refusal_code_is_raised_by_a_real_call_and_carries_what_corrects_it(self):
        has_bled = {"hypertension_uncontrolled": False, "age": 70}
        calls = {
            kit.REQUEST_INVALID: ({"action": "compute", "id": "bmi", "inputs": ["weight"]}, "inputs must be an object"),
            kit.UNKNOWN_SCORE: ({"action": "compute", "id": "no_such_score", "inputs": {}}, "No score"),
            kit.UNKNOWN_VERSION: ({"action": "compute", "id": "bmi", "inputs": {}, "version": "x"}, "no version"),
            kit.UNKNOWN_INPUT: ({"action": "compute", "id": "bmi", "inputs": {"mass": "70 kg"}}, "no item"),
            kit.INPUT_INVALID: ({"action": "compute", "id": "bmi", "inputs": {"weight": "heavy", "height": "1.7 m"}}, "number with its unit"),
            kit.UNIT_INVALID: ({"action": "compute", "id": "bmi", "inputs": {"weight": 70, "height": "1.7 m"}}, "needs its unit"),
            kit.OUT_OF_RANGE: ({"action": "compute", "id": "bmi", "inputs": {"weight": "7000 kg", "height": "1.7 m"}}, "plausible range"),
            kit.NOT_APPLICABLE: ({"action": "compute", "id": "ckd_epi_2021", "inputs": {"creatinine": "0.5 mg/dL", "age": 5, "sex": "male"}}, "adults"),
            kit.MISSING_INPUTS: ({"action": "compute", "id": "has_bled", "inputs": has_bled}, "needs"),
            kit.ABSENT_INVALID: ({"action": "compute", "id": "bmi", "inputs": {"weight": "70 kg"}, "assume_absent": ["height"]}, "cannot be counted as absent"),
        }
        self.assertEqual(set(calls), set(kit.ERROR_CODES), "a code with no call that raises it is a code nobody has seen")
        for code, (arguments, words) in calls.items():
            with self.subTest(code=code):
                with self.assertRaises(kit.ScoreError) as caught:
                    clinical_scores.call(arguments)
                self.assertEqual(caught.exception.code, code)
                self.assertIn(words, str(caught.exception))
                # through the server the same call is a named error, never a result and never an exception
                reply = server.call_tool("clinical_score", arguments)
                # a request the published schema already rejects (inputs as a list) never reaches the calculator: the server's own invalid_input
                self.assertEqual(reply["status"], "error")
                self.assertEqual(reply["error"]["code"], "invalid_input" if code == kit.REQUEST_INVALID else code)
                self.assertTrue(reply["next_actions"])

    def test_an_unrecognised_action_or_field_is_refused_before_anything_is_computed(self):
        for bad in ({"action": "explain"}, {"action": "compute", "id": "bmi", "extra": 1}, {}, {"action": "describe"}):
            with self.subTest(bad=bad):
                with self.assertRaises(kit.ScoreError) as caught:
                    clinical_scores.call(bad)
                self.assertIn(caught.exception.code, (kit.REQUEST_INVALID, kit.UNKNOWN_SCORE))


class Wire(unittest.TestCase):
    def test_the_tool_is_published_validated_and_small(self):
        definitions = {tool["name"]: tool for tool in server.list_tools()}
        tool = definitions["clinical_score"]
        self.assertLess(len(json.dumps(tool)), 2600, "the schema is paid on every first request; the scale list belongs to action=list")
        self.assertEqual(tool["inputSchema"]["required"], ["action"])
        for word in ("Child-Pugh", "MELD", "CHA2DS2", "CKD-EPI", "Wells"):
            self.assertNotIn(word, json.dumps(tool), "the scale list is for action=list, never the schema")

    def test_a_call_through_the_server_returns_the_result_or_a_named_refusal(self):
        ok = server.call_tool("clinical_score", {"action": "compute", "id": "bmi", "inputs": {"weight": "70 kg", "height": "175 cm"}})
        self.assertEqual(ok["status"], "success")
        self.assertEqual(ok["data"]["result"]["value"], 22.9)
        refusal = server.call_tool("clinical_score", {"action": "compute", "id": "bmi", "inputs": {"weight": 70, "height": "175 cm"}})
        self.assertEqual(refusal["status"], "error")
        self.assertEqual(refusal["error"]["code"], "clinical_score_unit_invalid")
        self.assertEqual(refusal["data"]["accepted_units"], ["kg", "lb"])
        schema = server.call_tool("clinical_score", {"action": "compute", "id": "bmi", "colour": 1})
        self.assertEqual(schema["error"]["code"], "invalid_input")
        missing = server.call_tool("clinical_score", {"action": "compute", "id": "has_bled", "inputs": {}})
        self.assertEqual(missing["error"]["code"], "clinical_score_missing_inputs")
        self.assertIn("assume_absent", missing["next_actions"][0])

    def test_an_operator_can_switch_it_off_like_any_optional_tool(self):
        self.assertIn("clinical_score", server.OPTIONAL_TOOLS)
        with mock.patch.dict(os.environ, {"EVIMED_DISABLED_TOOLS": "clinical_score"}):
            self.assertNotIn("clinical_score", {tool["name"] for tool in server.list_tools()})
            refusal = server.call_tool("clinical_score", {"action": "list"})
            self.assertEqual(refusal["error"]["code"], "tool_disabled")
        self.assertIn("clinical_score", {tool["name"] for tool in server.list_tools()})

    def test_no_gateway_context_or_account_is_needed(self):
        self.assertNotIn("clinical_score", server.ENGINE_CONTEXT_TOOLS)


class Registration(unittest.TestCase):
    """The names the control plane and the web guard are written in the domain package; this holds them to this file."""

    def read(self, relative):
        return (REPO / relative).read_text(encoding="utf-8")

    def test_the_refusal_codes_are_the_domain_registry_exactly(self):
        text = self.read("packages/domain/src/errorCodes.mjs")
        registered = set(re.findall(r'"(clinical_score_[a-z_]+)"', text))
        self.assertEqual(registered, set(kit.ERROR_CODES))

    def test_the_tool_is_in_the_domain_catalogue_and_visible_to_the_root(self):
        names = self.read("packages/domain/src/toolNames.mjs")
        self.assertEqual(len(re.findall(r"'clinical_score'", names)), 2, "once in the catalogue, once in the root's list")
        zh = json.loads(self.read("packages/domain/src/research-tools-zh.json"))
        self.assertIn("clinical_score", zh["tools"])

    def test_every_score_says_how_its_definition_was_checked_and_nothing_else_does(self):
        import clinical_score_verification
        self.assertEqual(set(clinical_score_verification.VERIFICATION), set(clinical_scores.SCALES))
        for scale_id, (definition, examples) in clinical_score_verification.VERIFICATION.items():
            self.assertTrue(definition.strip() and examples.strip(), scale_id)
            self.assertNotIn("PENDING", definition, scale_id)
            self.assertTrue(any(kind in examples for kind in ("SRC", "REF", "HAND")), "%s: the worked examples say what they rest on" % scale_id)
            self.assertEqual(clinical_scores.call({"action": "describe", "id": scale_id})["data"]["verification"]["definition_read_from"], definition)

    def test_every_constant_a_result_reports_carries_a_source(self):
        # the sources are citations, not tags: a constant without one, or with a bare word, would be a number from memory
        for scale_id, scale in clinical_scores.SCALES.items():
            for version in scale.versions.values():
                self.assertGreater(len(version.source), 25, "%s/%s" % (scale_id, version.id))
        data = clinical_scores.call({"action": "compute", "id": "ckd_epi_2021", "inputs": {"creatinine": "1.0 mg/dL", "age": 50, "sex": "male"}})["data"]
        self.assertTrue(data["constants"])
        for row in data["constants"]:
            self.assertGreater(len(row["source"]), 25, row["name"])

    def test_the_probe_row_of_the_release_audit_exists(self):
        audit = self.read("evals/capability-audit/run_tool_audit.py")
        self.assertIn('"clinical_score"', audit)


if __name__ == "__main__":
    unittest.main()
