"""`dataset_semantics` end to end: the Python tool, the real gateway and service on a ledger double, and the domain
contract, as one. The scenarios are the plan's (§11.3 N03): a second analysis starts from the stored
interpretation; a researcher's correction is a confirmed fact a later inference does not overwrite; a second
delivery of the dataset shows its drift, its duplicates and its changed denominators without stopping anything.
"""

import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import data_semantics  # noqa: E402
import data_semantics_checks as checks  # noqa: E402
import semantics_asset  # noqa: E402

OPEN_SCIENCE = pathlib.Path(__file__).resolve().parents[4]
SERVER = OPEN_SCIENCE / "apps" / "server" / "test" / "helpers" / "dataSemanticsGatewayServer.mjs"
FIXTURES = pathlib.Path(__file__).resolve().parent / "fixtures" / "semantics"
INFERRED = {"basis": "model_inferred", "inferredFrom": ["column names and values of data/visits.csv"]}


def start_gateway(enabled=True):
    node = shutil.which("node")
    assert node, "node must be installed: the tool is tested against the real gateway and service"
    process = subprocess.Popen([node, str(SERVER), "--enabled", "true" if enabled else "false"], cwd=OPEN_SCIENCE / "apps" / "server",
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    line = process.stdout.readline()
    assert line.startswith("PORT="), line + (process.stderr.read() if process.poll() is not None else "")
    return process, int(line.strip().split("=")[1])


class Tool(unittest.TestCase):
    enabled = True

    def setUp(self):
        process, port = start_gateway(self.enabled)
        self.port = port

        def stop():
            process.stdin.close()
            process.wait(timeout=20)
            process.stdout.close()
            process.stderr.close()

        self.addCleanup(stop)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.workspace = pathlib.Path(directory.name) / "workspace"
        (self.workspace / "data").mkdir(parents=True)
        for source, target in (("visits_v1.csv", "visits.csv"), ("patients.csv", "patients.csv"), ("outcomes.csv", "outcomes.csv"), ("dictionary.csv", "dictionary.csv")):
            shutil.copy(FIXTURES / source, self.workspace / "data" / target)
        token = pathlib.Path(directory.name) / "gateway-token"
        token.write_text("runtime-token-for-tests\n", encoding="utf-8")
        os.chmod(token, 0o600)
        base = "http://127.0.0.1:%d" % port
        patcher = mock.patch.dict(os.environ, {
            "EVIMED_SEMANTICS_GATEWAY_URL": base + "/internal/semantics/v1", "EVIMED_PUBLIC_SOURCE_GATEWAY_URL": base + "/internal/sources/v1/fetch",
            "EVIMED_MODEL_GATEWAY_TOKEN_FILE": str(token), "OPEN_SCIENCE_WORKSPACE_DIR": str(self.workspace),
        })
        patcher.start()
        self.addCleanup(patcher.stop)

    def path(self, name):
        return self.workspace / "data" / name

    def call(self, **arguments):
        return data_semantics.call(arguments)

    def ledger(self):
        import urllib.request
        with urllib.request.urlopen("http://127.0.0.1:%d/__ledger" % self.port, timeout=10) as response:
            return json.loads(response.read())

    def record_first_delivery(self, extra=None):
        """What a scoping run establishes on the first delivery, and records."""
        return self.call(
            action="write", datasetId="visits", title="Sepsis visits", **INFERRED,
            population="Adults admitted with sepsis, 2023", files=[{"path": "data/visits.csv"}, {"path": "data/patients.csv"}, {"path": "data/outcomes.csv"}],
            tables=[
                {"name": "visits.csv", "observationUnit": "one row per patient visit", "subjectKey": ["patient_id"], "observationKey": ["patient_id", "visit_no"]},
                {"name": "patients.csv", "observationUnit": "one row per patient", "subjectKey": ["patient_id"], "observationKey": ["patient_id"]},
                {"name": "outcomes.csv", "observationUnit": "one row per patient", "subjectKey": ["patient_id"], "observationKey": ["patient_id"]},
            ],
            variables=[
                {"table": "visits.csv", "name": "sbp", "unit": "mmHg", "type": "integer", "role": "covariate", "measuredAt": {"column": "visit_date"}, "valueSource": "observed"},
                {"table": "visits.csv", "name": "creatinine", "unit": "umol/L", "type": "number", "role": "covariate", "measuredAt": {"column": "visit_date"}},
                {"table": "visits.csv", "name": "heart_rate", "unit": "beats/min", "type": "integer"},
                {"table": "patients.csv", "name": "sex", "allowedValues": "observed"},
                {"table": "patients.csv", "name": "arm", "allowedValues": "observed"},
                {"table": "patients.csv", "name": "patient_id", "allowedValues": "observed"},
            ],
            joins=[{"left": {"table": "visits.csv", "columns": ["patient_id"]}, "right": {"table": "patients.csv", "columns": ["patient_id"]}, "cardinality": "many_to_one"}],
            **(extra or {}),
        )


class Definition(unittest.TestCase):
    def test_the_tool_is_one_bounded_definition_and_its_vocabularies_are_the_domains(self):
        [definition] = data_semantics.tool_definitions()
        self.assertEqual(definition["name"], "dataset_semantics")
        schema = definition["inputSchema"]
        self.assertEqual(schema["required"], ["action"])
        self.assertFalse(schema["additionalProperties"])
        self.assertLess(len(definition["description"]), 3600, "the description rides every request of the two capabilities that offer it")
        types, roles, sources, reasons, kinds, cardinalities, transforms, bases, codes = semantics_asset.domain_exports(
            "DATA_VARIABLE_TYPES", "DATA_VARIABLE_ROLES", "DATA_VALUE_SOURCES", "VCR_MISSING_REASONS", "VCR_TIME_KINDS", "DATA_JOIN_CARDINALITIES",
            "DATA_TRANSFORM_KINDS", "SEMANTIC_BASES", "DATA_SEMANTICS_ERROR_CODES")
        self.assertEqual(list(data_semantics.VARIABLE_TYPES), types)
        self.assertEqual(list(data_semantics.VARIABLE_ROLES), roles)
        # The value sources are the 虚拟临研 column sources: one vocabulary, not a parallel one.
        self.assertEqual(list(data_semantics.VALUE_SOURCES), sources)
        self.assertEqual(list(data_semantics.MISSING_REASONS), reasons)
        self.assertEqual(list(data_semantics.TIME_KINDS), kinds)
        self.assertEqual(list(data_semantics.JOIN_CARDINALITIES), cardinalities)
        self.assertEqual(list(data_semantics.TRANSFORM_KINDS), transforms)
        self.assertEqual(list(data_semantics.BASES), bases)
        self.assertEqual(list(data_semantics.ERROR_CODES), codes)
        variable = schema["properties"]["variables"]["items"]["properties"]
        self.assertEqual(variable["valueSource"]["enum"], sources)
        self.assertEqual(variable["missingness"]["properties"]["reason"]["enum"], reasons)

    def test_the_tool_is_registered_beside_the_other_research_tools_and_is_not_optional(self):
        import server
        self.assertIn("dataset_semantics", server.TOOLS)
        self.assertNotIn("dataset_semantics", server.OPTIONAL_TOOLS)
        self.assertIn("dataset_semantics", [tool["name"] for tool in server.list_tools()])


class Establish(Tool):
    def test_a_first_analysis_records_what_it_establishes_and_a_second_starts_from_it(self):
        recorded = self.record_first_delivery()
        # Recorded in full; the one thing the tool declined to copy (an identifier as a code list) is told, not hidden.
        self.assertEqual(recorded["status"], "warning")
        self.assertEqual(len(recorded["warnings"]), 1)
        self.assertEqual(recorded["data"]["revision"], 1)
        self.assertEqual({item["table"] for item in recorded["data"]["bound"]}, {"visits.csv", "patients.csv", "outcomes.csv"})
        # The patient identifier is not offered as a code list; the real code lists are copied from the file, not typed.
        self.assertEqual([issue["code"] for issue in recorded["data"]["issues"]], ["allowedValues_withheld_identifying"])

        # A later conversation of the project: no interpretation to redo.
        read = self.call(action="read")
        dataset = read["data"]["dataset"]
        self.assertEqual(read["status"], "success", read.get("warnings"))
        self.assertEqual(dataset["datasetId"], "visits")
        self.assertEqual(dataset["population"]["basis"], "model_inferred")
        visits = next(t for t in dataset["tables"] if t["name"] == "visits.csv")
        self.assertEqual(visits["observationKey"]["value"], ["patient_id", "visit_no"])
        self.assertEqual(visits["variables"]["creatinine"]["unit"], {"value": "umol/L", "basis": "model_inferred", "inferredFrom": INFERRED["inferredFrom"]})
        self.assertEqual(visits["boundTo"]["now"], "same_bytes")
        self.assertEqual(visits["boundTo"]["rows"], 180)
        patients = next(t for t in dataset["tables"] if t["name"] == "patients.csv")
        self.assertEqual(patients["variables"]["sex"]["allowedValues"]["value"], [{"code": "F"}, {"code": "M"}])
        self.assertEqual(dataset["joins"][0]["cardinality"]["value"], "many_to_one")
        self.assertEqual(dataset["summary"]["modelInferred"], dataset["summary"]["facts"])
        # The same interpretation, named by one digest a run can cite.
        self.assertEqual(self.call(action="read", datasetId="visits")["data"]["dataset"]["interpretation"], dataset["interpretation"])
        self.assertEqual(self.call(action="read", table="patients.csv")["data"]["dataset"]["tables"][0]["name"], "patients.csv")

    def test_a_researchers_correction_is_a_confirmed_fact_that_a_later_inference_does_not_overwrite(self):
        self.call(action="write", datasetId="labs", **INFERRED, variables=[{"table": "labs.csv", "name": "creatinine", "unit": "mg/dL"}])
        corrected = self.call(action="write", datasetId="labs", basis="researcher_confirmed", statement="这一列的单位是 mmol/L",
                              variables=[{"table": "labs.csv", "name": "creatinine", "unit": "mmol/L"}])
        self.assertEqual(corrected["status"], "success")
        self.assertEqual(corrected["data"]["counts"], {"applied": 1})
        later = self.call(action="write", datasetId="labs", **INFERRED, variables=[{"table": "labs.csv", "name": "creatinine", "unit": "mg/dL"}])
        self.assertEqual(later["status"], "warning")
        self.assertEqual([item["outcome"] for item in later["data"]["keptStronger"]], ["kept_stronger"])
        self.assertTrue(any("NOT applied" in warning for warning in later["warnings"]))
        unit = self.call(action="read", datasetId="labs")["data"]["dataset"]["tables"][0]["variables"]["creatinine"]["unit"]
        self.assertEqual(unit["value"], "mmol/L")
        self.assertEqual(unit["basis"], "researcher_confirmed")
        self.assertEqual(unit["statement"], "这一列的单位是 mmol/L")
        self.assertEqual(unit["contested"], [{"value": "mg/dL", "basis": "model_inferred"}])
        self.assertEqual(unit["replaced"], "mg/dL")
        # Each version is the ledger's own revision.
        self.assertEqual(self.ledger()["revisions"][next(iter(self.ledger()["revisions"]))], 3)

    def test_a_confirmation_without_the_researchers_words_is_refused_by_name_and_nothing_about_meaning_is_written(self):
        refused = self.call(action="write", datasetId="d", basis="researcher_confirmed", variables=[{"table": "t.csv", "name": "c", "unit": "mg"}])
        self.assertEqual(refused["status"], "warning")
        self.assertEqual(refused["data"]["issues"][0]["code"], "provenance_invalid")
        self.assertEqual(refused["data"]["summary"]["facts"], 0)

    def test_a_data_dictionary_is_named_by_its_file_and_its_hash(self):
        self.call(action="write", datasetId="visits", basis="dictionary_stated", statedIn="data/dictionary.csv",
                  variables=[{"table": "visits.csv", "name": "sbp", "unit": "mmHg", "definition": "Systolic blood pressure"}])
        unit = self.call(action="read", datasetId="visits")["data"]["dataset"]["tables"][0]["variables"]["sbp"]["unit"]
        self.assertEqual(unit["basis"], "dictionary_stated")
        self.assertEqual(unit["statedIn"], {"path": "data/dictionary.csv", "sha256": checks.file_sha256(str(self.workspace), "data/dictionary.csv")})
        with self.assertRaises(data_semantics.DataSemanticsError) as caught:
            self.call(action="write", datasetId="visits", basis="dictionary_stated", statedIn="data/nothing.csv", variables=[{"table": "visits.csv", "name": "sbp", "unit": "mmHg"}])
        self.assertEqual(caught.exception.code, "semantics_request_invalid")

    def test_observed_codes_are_copied_from_the_file_and_withheld_where_they_would_identify_or_sprawl(self):
        result = self.call(action="write", datasetId="visits", **INFERRED, files=[{"path": "data/visits.csv"}, {"path": "data/patients.csv"}], variables=[
            {"table": "patients.csv", "name": "arm", "allowedValues": "observed"},
            {"table": "visits.csv", "name": "patient_id", "allowedValues": "observed"},
            {"table": "visits.csv", "name": "creatinine", "allowedValues": "observed"},
            {"table": "visits.csv", "name": "heart_rate", "allowedValues": "observed"},
            {"table": "missing.csv", "name": "x", "allowedValues": "observed"},
        ])
        codes = sorted(issue["code"] for issue in result["data"]["issues"])
        self.assertEqual(codes, ["allowedValues_observed_needs_file", "allowedValues_withheld_high_cardinality", "allowedValues_withheld_high_cardinality", "allowedValues_withheld_identifying"])
        arm = self.call(action="read", datasetId="visits", table="patients.csv")["data"]["dataset"]["tables"][0]["variables"]["arm"]
        self.assertEqual(arm["allowedValues"]["value"], [{"code": "A"}, {"code": "B"}])

    def test_a_file_that_cannot_be_read_is_named_and_the_rest_is_still_recorded(self):
        result = self.call(action="write", datasetId="visits", **INFERRED, files=[{"path": "data/visits.csv"}, {"path": "data/gone.csv"}, {"path": "../etc/passwd"}],
                           tables=[{"name": "visits.csv", "observationUnit": "one row per visit"}])
        self.assertEqual(result["status"], "warning")
        self.assertEqual([item["table"] for item in result["data"]["bound"]], ["visits.csv"])
        self.assertEqual(sorted(issue["code"] for issue in result["data"]["issues"]), ["file_file_unreadable", "file_file_unreadable"])

    def test_the_binding_holds_aggregates_and_no_row_of_a_patient(self):
        self.record_first_delivery()
        stored = json.dumps(self.ledger())
        self.assertNotIn("P001", stored)
        self.assertNotIn("2023-01-31", stored)
        binding = next(row for row in self.ledger()["rows"])["payload"]["bindings"]
        patient_id = next(c for b in binding for c in b["columns"] if c["name"] == "patient_id")
        self.assertEqual(set(patient_id), {"name", "type", "missing", "distinct"})   # no numeric summary, no vocabulary


class SecondDelivery(Tool):
    """The plan's workflow: the extract is delivered again, with one renamed column, one unit change and duplicated visits."""

    def test_the_new_delivery_is_seen_for_what_it_is_and_nothing_is_stopped(self):
        self.record_first_delivery()
        shutil.copy(FIXTURES / "visits_v2.csv", self.path("visits.csv"))

        # The first thing a follow-up reads says the bytes are no longer the ones the meaning came from.
        read = self.call(action="read")
        self.assertEqual(read["status"], "warning")
        self.assertEqual(next(t for t in read["data"]["dataset"]["tables"] if t["name"] == "visits.csv")["boundTo"]["now"], "bytes_changed")
        self.assertTrue(any("not the bytes" in warning for warning in read["warnings"]))

        result = self.call(action="check", files=[{"path": "data/visits.csv"}, {"path": "data/patients.csv"}], steps=[
            {"label": "delivered", "kind": "filter", "table": "visits.csv"}, {"label": "analysed", "kind": "filter", "rows": 150, "subjects": 35}])
        self.assertEqual(result["status"], "warning")           # something wants a decision -- and the call still succeeded
        found = {(item["outcome"], item["subject"].get("column", item["subject"].get("table"))) for item in result["data"]["findings"]}
        self.assertIn(("column_renamed_candidate", "systolic_bp"), found)
        self.assertIn(("possible_unit_change", "creatinine"), found)
        self.assertIn(("duplicate_exact", "patient_id+visit_no"), found)
        self.assertIn(("source_changed", "visits.csv"), found)
        duplicates = next(item for item in result["data"]["findings"] if item["outcome"] == "duplicate_exact")
        self.assertEqual(duplicates["count"], 3)
        self.assertEqual(len(duplicates["rows"]), 3)
        decrease = next(item for item in result["data"]["findings"] if item["outcome"] == "denominator_decrease")
        self.assertEqual((decrease["detail"]["rowsBefore"], decrease["detail"]["rowsAfter"]), (183, 150))
        self.assertTrue(result["data"]["recorded"])
        self.assertTrue(any("candidate" in action for action in result["next_actions"]))
        self.assertTrue(any("Go on with the analysis" in action for action in result["next_actions"]))

        # The control plane keeps names and counts, not the pseudonymised keys the run was shown.
        report = self.call(action="read", datasetId="visits")["data"]["dataset"]["lastCheck"]
        self.assertGreaterEqual(report["summary"]["attention"], 3)
        stored = json.dumps(self.ledger())
        self.assertNotIn("examples", stored)
        self.assertNotIn("P001", stored)

    def test_the_rename_is_confirmed_the_new_version_is_bound_and_the_next_check_is_quiet_about_it(self):
        self.record_first_delivery()
        self.call(action="write", datasetId="visits", basis="researcher_confirmed", statement="systolic_bp 就是以前的 sbp，单位 mmHg，没变",
                  variables=[{"table": "visits.csv", "name": "systolic_bp", "aliases": ["sbp"], "unit": "mmHg"}])
        shutil.copy(FIXTURES / "visits_v2.csv", self.path("visits.csv"))
        self.call(action="write", datasetId="visits", **INFERRED, files=[{"path": "data/visits.csv"}],
                  variables=[{"table": "visits.csv", "name": "creatinine", "unit": "mg/dL"}])
        dataset = self.call(action="read", datasetId="visits", table="visits.csv")["data"]["dataset"]
        variables = dataset["tables"][0]["variables"]
        self.assertIn("systolic_bp", variables)
        self.assertNotIn("sbp", variables)
        # The meaning travelled with the rename: the researcher's confirmation of the unit is on the new name.
        self.assertEqual(variables["systolic_bp"]["unit"]["basis"], "researcher_confirmed")
        self.assertEqual(variables["systolic_bp"]["role"]["value"], "covariate")
        # The model re-inferred creatinine's unit from the delivery; the record of the earlier delivery stays in the history.
        self.assertEqual(variables["creatinine"]["unit"]["value"], "mg/dL")
        self.assertEqual(len(dataset["earlierVersions"]), 1)
        again = self.call(action="check", files=[{"path": "data/visits.csv"}])
        self.assertEqual([item["outcome"] for item in again["data"]["findings"] if item["family"] == "drift"], ["source_unchanged"])
        # The delivery still holds its three repeated visits; that is the data, not drift, and it is still said.
        self.assertEqual([item["outcome"] for item in again["data"]["findings"] if item["family"] != "drift"], ["duplicate_exact"])

    def test_a_check_with_no_files_checks_the_recorded_paths_again(self):
        self.record_first_delivery()
        result = self.call(action="check")
        self.assertEqual(result["status"], "success")
        self.assertEqual([item["outcome"] for item in result["data"]["findings"]], ["source_unchanged"] * 3)
        self.assertEqual(result["data"]["notChecked"], [])
        # Each family that looked at the delivered content says it found nothing, rather than saying nothing.
        self.assertEqual(sorted({item["family"] for item in result["data"]["clean"]}), ["duplicates", "joins"])

    def test_the_recorded_meaning_names_the_checks_declarations_and_leakage_is_judged_from_it(self):
        self.record_first_delivery()
        result = self.call(action="check", leakage={"cutoff": {"table": "outcomes.csv", "column": "window_start"}})
        leaked = sorted(item["subject"]["predictor"] for item in result["data"]["findings"] if item["outcome"] == "temporal_leakage")
        self.assertEqual(leaked, ["creatinine", "sbp"])
        self.assertEqual(result["status"], "warning")


class Transformations(Tool):
    def test_a_repeat_analysis_is_told_whether_its_transformation_is_the_recorded_one(self):
        self.record_first_delivery()
        script = self.workspace / "analysis"
        script.mkdir()
        (script / "egfr.py").write_text("# CKD-EPI 2021\n", encoding="utf-8")
        spec = {"name": "egfr", "kind": "derive", "description": "eGFR from creatinine, age and sex", "inputs": [{"table": "visits.csv", "columns": ["creatinine"]}],
                "output": {"table": "visits.csv", "column": "egfr"}, "codePath": "analysis/egfr.py", "parameters": {"equation": "ckd-epi-2021"}}
        first = self.call(action="transform", datasetId="visits", transformation=spec)
        self.assertEqual((first["data"]["status"], first["data"]["version"]), ("new", 1))
        self.assertEqual(first["status"], "success")
        same = self.call(action="transform", datasetId="visits", transformation=spec)
        self.assertEqual((same["data"]["status"], same["data"]["version"], same["next_actions"]), ("same", 1, []))
        (script / "egfr.py").write_text("# MDRD\n", encoding="utf-8")
        changed = self.call(action="transform", datasetId="visits", transformation={**spec, "parameters": {"equation": "mdrd"}})
        self.assertEqual((changed["data"]["status"], changed["data"]["version"], changed["data"]["changed"]), ("changed", 2, ["code", "parameters"]))
        self.assertEqual(changed["status"], "warning")
        # The recorded transformations are what a repeat analysis reads, with the hash of the code that made them.
        read = self.call(action="read", datasetId="visits")["data"]["dataset"]["transformations"]
        self.assertEqual([(t["name"], t["version"]) for t in read], [("egfr", 2)])
        self.assertEqual(len(read[0]["code"]["sha256"]), 64)
        # If the script is edited after it was recorded, the next check says so.
        (script / "egfr.py").write_text("# something else\n", encoding="utf-8")
        found = self.call(action="check")["data"]["findings"]
        self.assertIn("transformation_code_changed", [item["outcome"] for item in found])

    def test_a_transformation_names_a_dataset_and_a_real_script(self):
        with self.assertRaises(data_semantics.DataSemanticsError) as caught:
            self.call(action="transform", transformation={"name": "t", "kind": "filter", "inputs": [{"table": "a.csv"}]})
        self.assertEqual(caught.exception.code, "semantics_dataset_invalid")
        self.record_first_delivery()
        with self.assertRaises(data_semantics.DataSemanticsError) as caught:
            self.call(action="transform", datasetId="visits", transformation={"name": "t", "kind": "filter", "inputs": [{"table": "a.csv"}], "codePath": "nope.py"})
        self.assertEqual(caught.exception.code, "semantics_request_invalid")


class Absence(Tool):
    enabled = False

    def test_with_the_module_off_every_action_answers_a_warning_and_a_check_still_runs_on_what_it_declares(self):
        for arguments in ({"action": "read"}, {"action": "write", "datasetId": "d", **INFERRED, "population": "x"},
                          {"action": "transform", "datasetId": "d", "transformation": {"name": "t", "kind": "filter", "inputs": [{"table": "a.csv"}]}}):
            result = self.call(**arguments)
            self.assertEqual(result["status"], "warning", arguments["action"])
            self.assertEqual(result["data"], {"available": False, "code": "semantics_disabled"})
            self.assertTrue(any("files" in action for action in result["next_actions"]))
        checked = self.call(action="check", files=[{"path": "data/visits.csv"}], observationKeys={"visits.csv": ["patient_id", "visit_no"]})
        self.assertEqual(checked["status"], "success")
        self.assertFalse(checked["data"]["recorded"])
        self.assertEqual(checked["data"]["notRecordedBecause"], "semantics_disabled")
        self.assertEqual([item["reason"] for item in checked["data"]["notChecked"]], ["no_asset"])
        self.assertEqual(checked["data"]["counts"]["clean"], 1)


class Failures(unittest.TestCase):
    def test_no_gateway_is_the_same_warning_and_an_unreachable_one_is_a_retryable_failure(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("EVIMED_SEMANTICS_GATEWAY_URL", None)
            result = data_semantics.call({"action": "read"})
            self.assertEqual(result["data"]["code"], "semantics_disabled")
        token = tempfile.NamedTemporaryFile("w", delete=False)
        self.addCleanup(os.unlink, token.name)
        token.write("t\n")
        token.close()
        os.chmod(token.name, 0o600)
        with mock.patch.dict(os.environ, {"EVIMED_SEMANTICS_GATEWAY_URL": "http://127.0.0.1:9/internal/semantics/v1", "EVIMED_PUBLIC_SOURCE_GATEWAY_URL": "http://127.0.0.1:9/s",
                                          "EVIMED_MODEL_GATEWAY_TOKEN_FILE": token.name}):
            with self.assertRaises(data_semantics.DataSemanticsError) as caught:
                data_semantics.call({"action": "read"})
        self.assertEqual((caught.exception.code, caught.exception.retryable, caught.exception.stop_reason()), ("semantics_gateway_unreachable", True, "retry"))

    def test_a_malformed_call_is_the_runs_to_fix(self):
        for arguments in ({"action": "forget"}, {"action": "read", "files": []}, {"action": "write", "colour": 1}, {"action": "check", "observationKeys": {"t": "x"}}):
            with self.assertRaises(data_semantics.DataSemanticsError) as caught:
                data_semantics.call(arguments)
            self.assertEqual(caught.exception.stop_reason(), "invalid_input", arguments)

    def test_through_the_server_a_failure_is_a_coded_answer_and_a_success_carries_its_provenance(self):
        import server
        token = tempfile.NamedTemporaryFile("w", delete=False)
        self.addCleanup(os.unlink, token.name)
        token.write("t\n")
        token.close()
        os.chmod(token.name, 0o600)
        with mock.patch.dict(os.environ, {"EVIMED_SEMANTICS_GATEWAY_URL": "http://127.0.0.1:9/internal/semantics/v1", "EVIMED_PUBLIC_SOURCE_GATEWAY_URL": "http://127.0.0.1:9/s",
                                          "EVIMED_MODEL_GATEWAY_TOKEN_FILE": token.name}):
            failed = server.call_tool("dataset_semantics", {"action": "read"})
        self.assertEqual(failed["status"], "error")
        self.assertEqual(failed["error"]["code"], "semantics_gateway_unreachable")
        self.assertEqual(failed["error"]["stopReason"], "retry")
        with mock.patch.dict(os.environ, {}):
            os.environ.pop("EVIMED_SEMANTICS_GATEWAY_URL", None)
            absent = server.call_tool("dataset_semantics", {"action": "read"})
        self.assertEqual(absent["status"], "warning")
        self.assertEqual(absent["data"]["provenance"]["tool"], "dataset_semantics")


if __name__ == "__main__":
    unittest.main()
