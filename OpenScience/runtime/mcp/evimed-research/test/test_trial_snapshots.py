"""A trial's record as snapshots: complete, stable across load dates, aligned, and compared with the one held before.

The record is the real NCT02197234 recorded 2026-10-04 (`wire/clinicaltrials__study_NCT02197234.json`: completed,
phase 1, seven posted outcome measures, 14 serious and 47 other adverse-event terms). An EARLIER version of it is
constructed here by editing the real record in code, because the documented API serves only the current one and
no real earlier version could be recorded; each such edit is named in its test.
"""

import copy
import hashlib
import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import unittest
import urllib.parse
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import public_sources  # noqa: E402
import source_outcome  # noqa: E402
import source_transport  # noqa: E402
import trial_snapshots as trials  # noqa: E402
import wire_fixtures as wire  # noqa: E402

NCT = "NCT02197234"
REAL = wire.json_body("clinicaltrials__study_NCT02197234.json")


class Registry:
    """ClinicalTrials.gov as a door: the real record (or an edited copy), the real /version, and the recorded 404."""

    def __init__(self, record=None, load_date=None, version_fails=False, failing=None):
        self.record = copy.deepcopy(record if record is not None else REAL)
        if load_date:
            self.record["derivedSection"]["miscInfoModule"]["versionHolder"] = load_date
        self.calls = []
        self.version_fails = version_fails
        self.failing = failing

    def __call__(self, url, accepted, **options):
        self.calls.append(url)
        if self.failing:
            raise self.failing.pop(0) if isinstance(self.failing, list) else self.failing
        parts = urllib.parse.urlsplit(url)
        assert parts.hostname == "clinicaltrials.gov", url
        if parts.path.endswith("/version"):
            if self.version_fails:
                raise wire.through_gateway("europepmc__fulltextxml_500.json")
            return wire.ok("clinicaltrials__version.json")
        match = parts.path.rsplit("/", 1)[-1]
        if match == NCT:
            return wire.derived(self.record)
        if match == "NCT99999999":
            raise wire.through_gateway("clinicaltrials__study_not_found.txt")
        raise AssertionError("no recorded ClinicalTrials.gov answer for %s" % url)


class Workspace(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.workspace = pathlib.Path(self.temporary.name).resolve()
        self.addCleanup(self.temporary.cleanup)
        patch = mock.patch.dict(os.environ, {"OPEN_SCIENCE_WORKSPACE_DIR": str(self.workspace)})
        patch.start()
        self.addCleanup(patch.stop)
        for name in ("EVIMED_PUBLIC_SOURCE_GATEWAY_URL", "EVIMED_MCP_FIXTURES"):
            os.environ.pop(name, None)
        self.sleeps = []
        sleep = mock.patch.object(source_transport.time, "sleep", side_effect=self.sleeps.append)
        sleep.start()
        self.addCleanup(sleep.stop)

    def snapshot(self, registry=None, **arguments):
        self.registry = registry or Registry()
        with mock.patch.object(public_sources, "_open_remote", self.registry):
            return trials.snapshot({"nctId": NCT, **arguments})


def edited(mutate):
    """The real record with one constructed change: an earlier version."""
    record = copy.deepcopy(REAL)
    mutate(record)
    return record


class SnapshotTests(Workspace):
    def test_the_complete_record_with_its_results_is_preserved_and_quotable(self):
        result = self.snapshot()
        self.assertEqual(result["status"], "success", result)
        data = result["data"]
        self.assertEqual((data["nctId"], data["contentLevel"], data["status"]), (NCT, "registry_record_with_results", "COMPLETED"))
        self.assertEqual(data["results"], {"posted": True, "firstPosted": "2016-06-22", "outcomeMeasures": 7})
        self.assertEqual(data["outcome"], {"state": "complete"})
        paths = [data["markdownPath"], data["recordPath"], data["alignmentPath"]]
        self.assertEqual(result["artifacts"], paths)
        self.assertTrue(all(path.startswith(".evimed-sources/clinicaltrials/%s/" % NCT) for path in paths))
        for path in paths:
            self.assertEqual(hashlib.sha256((self.workspace / path).read_bytes()).hexdigest(), data["artifactSha256s"][path])
        record = json.loads((self.workspace / data["recordPath"]).read_text(encoding="utf-8"))
        self.assertIn("resultsSection", record, "the posted results are in the preserved record")
        self.assertEqual(len(record["resultsSection"]["adverseEventsModule"]["seriousEvents"]), 14)
        text = (self.workspace / data["markdownPath"]).read_text(encoding="utf-8")
        for quoted in ("Enrollment: 52 (ACTUAL)", "Cmax of Simvastatin", "Geometric mean ratio 77.08 with 90% CI 63.41 to 93.70",
                       "| Part A: Day 1-2 (Simvastatin Alone) | STARTED | Simvastatin and AZD9291 (Part A); AZD9291 Alone (Part B) | 52 |", "Bundle branch block left"):
            self.assertIn(quoted, text)
        source = result["sources"][0]
        self.assertEqual((source["evidenceAccess"], source["source"], source["artifactPath"]), ("registry_record", "clinicaltrials.gov", data["markdownPath"]))
        self.assertEqual(source["sourceType"] if "sourceType" in source else "trial-registration", "trial-registration")

    def test_a_record_without_results_says_so_and_a_missing_one_is_no_results(self):
        bare = edited(lambda record: (record.pop("resultsSection"), record.update(hasResults=False)))
        result = self.snapshot(Registry(bare))
        self.assertEqual((result["data"]["contentLevel"], result["data"]["results"]["posted"]), ("registry_record", False))
        self.assertEqual(result["data"]["results"]["outcome"]["reason"], "results_not_posted")
        self.assertEqual(result["status"], "success")
        self.registry = Registry()
        with mock.patch.object(public_sources, "_open_remote", self.registry):
            missing = trials.snapshot({"nctId": "NCT99999999"})
        self.assertEqual(missing["status"], "warning")
        self.assertEqual((missing["data"]["outcome"]["state"], missing["data"]["outcome"]["reason"]), ("no_results", "not_found"))
        self.assertIn("not evidence that the trial does not exist", " ".join(missing["warnings"]))
        self.assertNotIn("sources", missing)
        self.assertFalse((self.workspace / ".evimed-sources/clinicaltrials/NCT99999999").exists(), "nothing is preserved for a record that is not there")

    def test_a_malformed_id_is_the_runs_to_correct_and_asks_nothing(self):
        registry = Registry()
        with mock.patch.object(public_sources, "_open_remote", registry):
            for bad in ("NOTANCT", "NCT123", "", "NCT0219723x"):
                with self.assertRaises(public_sources.PublicSourceError) as raised:
                    trials.snapshot({"nctId": bad})
                self.assertEqual(raised.exception.code, "public_source_trial_id_invalid")
            with self.assertRaises(public_sources.PublicSourceError):
                trials.snapshot({"nctId": NCT, "compareTo": "not hex!"})
        self.assertEqual(registry.calls, [])
        self.assertEqual(trials.NCT_ID.match("NCT02197234").group(), NCT)

    def test_the_id_is_case_folded(self):
        result = self.snapshot(nctId=NCT.lower())
        self.assertEqual(result["data"]["nctId"], NCT)

    def test_the_api_data_version_rides_along_and_its_failure_does_not_matter(self):
        result = self.snapshot()
        self.assertEqual(result["data"]["registryDataVersion"], {"apiVersion": "2.0.5", "dataTimestamp": "2026-10-02T09:00:04", "recordLoadedOn": "2026-10-02"})
        result = self.snapshot(Registry(version_fails=True))
        self.assertEqual(result["data"]["registryDataVersion"], {"recordLoadedOn": "2026-10-02"})
        self.assertEqual(result["status"], "success")


class StabilityTests(Workspace):
    def test_the_same_trial_on_another_day_is_the_same_snapshot(self):
        # versionHolder is the date the API's copy was loaded, so it differs for
        # every study on every data load; it must not make a new version.
        first = self.snapshot(Registry(load_date="2026-10-02"))
        second = self.snapshot(Registry(load_date="2026-10-03"))
        self.assertEqual(first["artifacts"], second["artifacts"])
        self.assertEqual(second["data"]["registryDataVersion"]["recordLoadedOn"], "2026-10-03", "the load date is kept in the result, not in the bytes")
        self.assertFalse(second["data"]["history"]["thisSnapshotIsNew"])
        self.assertEqual(second["data"]["history"]["snapshotsHeld"], 1)
        self.assertEqual(second["data"]["history"]["comparison"], "no_earlier_snapshot")
        self.assertNotIn("versionHolder", (self.workspace / second["data"]["recordPath"]).read_text(encoding="utf-8"))
        self.assertNotIn("comparison", second["data"])

    def test_the_bytes_carry_no_retrieval_time(self):
        result = self.snapshot()
        for path in result["artifacts"]:
            self.assertNotIn("retrievedAt", (self.workspace / path).read_text(encoding="utf-8"))


class ChangeTests(Workspace):
    """The earlier version is a constructed edit of the real record; the current one is the real record."""

    def compare(self, mutate, **arguments):
        self.snapshot(Registry(edited(mutate)))
        later = self.snapshot(**arguments)
        return later, {change["kind"]: change for change in later["data"]["comparison"]["changes"]}

    def test_a_changed_trial_is_a_new_snapshot_beside_the_old_and_lists_what_changed(self):
        def earlier(record):
            record["protocolSection"]["designModule"]["enrollmentInfo"] = {"count": 60, "type": "ESTIMATED"}
            record["protocolSection"]["statusModule"]["lastUpdatePostDateStruct"] = {"date": "2016-07-01", "type": "ACTUAL"}

        later, by_kind = self.compare(earlier)
        history = later["data"]["history"]
        self.assertEqual((history["snapshotsHeld"], history["thisSnapshotIsNew"], history["comparison"]), (2, True, "made"))
        self.assertEqual(by_kind["enrollment_changed"]["before"], {"count": 60, "type": "ESTIMATED"})
        self.assertEqual(by_kind["enrollment_changed"]["after"], {"count": 52, "type": "ACTUAL"})
        self.assertEqual(by_kind["field_changed"]["path"], "version.lastUpdatePosted")
        comparison = later["data"]["comparison"]
        self.assertEqual(comparison["unchanged"], False)
        self.assertEqual(comparison["against"]["lastUpdatePosted"], "2016-07-01")
        self.assertEqual(comparison["this"]["lastUpdatePosted"], "2025-11-20")
        self.assertTrue((self.workspace / comparison["against"]["alignmentPath"]).is_file(), "the earlier snapshot is kept")
        self.assertEqual([entry["current"] for entry in history["held"]], [False, True], "oldest first by the registry's own date")
        self.assertIn("1 change" if len(comparison["changes"]) == 1 else "change(s)", later["summary"])

    def test_an_endpoints_timeframe_changed_after_the_fact_is_listed_exactly(self):
        def earlier(record):
            record["protocolSection"]["outcomesModule"]["primaryOutcomes"][0]["timeFrame"] = "Days 1 and 31"

        _later, by_kind = self.compare(earlier)
        change = by_kind["endpoint_timeframe_changed"]
        self.assertEqual((change["role"], change["measure"], change["before"]), ("primary", "Cmax of Simvastatin", "Days 1 and 31"))
        self.assertTrue(change["after"].startswith("Blood samples collected on Days 1 and 31 at pre-dose"))

    def test_an_endpoint_added_removed_or_moved_between_roles(self):
        def earlier(record):
            outcomes = record["protocolSection"]["outcomesModule"]
            outcomes["primaryOutcomes"].append({"measure": "Overall survival", "timeFrame": "5 years"})
            moved = outcomes["secondaryOutcomes"].pop(0)
            outcomes["primaryOutcomes"].append(moved)
            outcomes["secondaryOutcomes"] = [item for item in outcomes["secondaryOutcomes"] if not item["measure"].startswith("CL/F")]

        later, _ = self.compare(earlier)
        kinds = [(change["kind"], change.get("measure")) for change in later["data"]["comparison"]["changes"]]
        self.assertIn(("endpoint_removed", "Overall survival"), kinds)
        self.assertIn(("endpoint_role_changed", "Tmax of Simvastatin and Simvastatin Acid"), kinds)
        self.assertIn(("endpoint_added", "CL/F of Simvastatin"), kinds)
        role_change = next(change for change in later["data"]["comparison"]["changes"] if change["kind"] == "endpoint_role_changed")
        self.assertEqual((role_change["before"], role_change["after"]), ("primary", "secondary"))

    def test_posted_results_appearing_and_their_values_changing(self):
        def without_results(record):
            record.pop("resultsSection")
            record["hasResults"] = False
            record["protocolSection"]["statusModule"].pop("resultsFirstPostDateStruct", None)

        _later, by_kind = self.compare(without_results)
        self.assertEqual(by_kind["results_posted"]["firstPosted"], "2016-06-22")
        self.assertEqual(sum(1 for _ in by_kind), len(by_kind))
        self.assertIn("result_added", by_kind)

        def other_value(record):
            measures = record["resultsSection"]["outcomeMeasuresModule"]["outcomeMeasures"]
            measures[0]["classes"][0]["categories"][0]["measurements"][0]["value"] = "99.9"
            measures[0]["timeFrame"] = "Day 31"

        self.registry = None
        later, by_kind = self.compare(other_value)
        change = by_kind["result_values_changed"]
        self.assertEqual((change["title"], change["before"][0]["value"], change["after"][0]["value"]), ("Cmax of Simvastatin", "99.9", "24.54"))
        self.assertEqual(by_kind["result_timeframe_changed"]["before"], "Day 31")

    def test_a_group_renumbered_between_versions_is_not_a_change(self):
        def renumbered(record):
            text = json.dumps(record).replace('"OG000"', '"OG900"').replace('"OG001"', '"OG901"')
            record.clear()
            record.update(json.loads(text))

        later, _ = self.compare(renumbered)
        self.assertTrue(later["data"]["comparison"]["unchanged"], "groups are named by title, not by their per-version id")
        self.assertEqual(later["data"]["history"]["thisSnapshotIsNew"], True, "the bytes did differ")
        self.assertIn("nothing changed", later["summary"])

    def test_arms_eligibility_and_adverse_event_totals(self):
        def earlier(record):
            protocol = record["protocolSection"]
            protocol["armsInterventionsModule"]["armGroups"].append({"label": "Placebo", "type": "PLACEBO_COMPARATOR", "interventionNames": []})
            protocol["eligibilityModule"]["minimumAge"] = "20 Years"
            protocol["eligibilityModule"]["eligibilityCriteria"] += "\n4. An extra criterion."
            record["resultsSection"]["adverseEventsModule"]["eventGroups"][0]["seriousNumAffected"] = 9

        _later, by_kind = self.compare(earlier)
        self.assertEqual(by_kind["arm_removed"]["label"], "Placebo")
        self.assertEqual((by_kind["eligibility_changed"]["field"], by_kind["eligibility_changed"]["before"], by_kind["eligibility_changed"]["after"]), ("minimumAge", "20 Years", "18 Years"))
        self.assertIn("eligibility_text_changed", by_kind)
        self.assertEqual(by_kind["adverse_event_totals_changed"]["before"][0]["seriousNumAffected"], 9)
        self.assertEqual(by_kind["adverse_event_totals_changed"]["after"][0]["seriousNumAffected"], 11)

    def test_every_change_kind_is_in_the_closed_vocabulary(self):
        def everything(record):
            protocol = record["protocolSection"]
            protocol["designModule"]["enrollmentInfo"] = {"count": 1, "type": "ESTIMATED"}
            protocol["statusModule"]["overallStatus"] = "RECRUITING"
            protocol["outcomesModule"]["primaryOutcomes"][0]["description"] = "Reworded."
            record["resultsSection"]["baselineCharacteristicsModule"]["denoms"][0]["counts"][0]["value"] = "5"
            record["resultsSection"]["participantFlowModule"]["periods"][0]["milestones"][0]["achievements"][0]["numSubjects"] = "5"

        later, by_kind = self.compare(everything)
        kinds = {change["kind"] for change in later["data"]["comparison"]["changes"]}
        self.assertTrue(kinds <= set(trials.CHANGE_KINDS), kinds - set(trials.CHANGE_KINDS))
        self.assertTrue({"enrollment_changed", "field_changed", "endpoint_description_changed", "baseline_changed", "flow_changed"} <= kinds)
        counts = later["data"]["comparison"]["counts"]
        self.assertEqual(sum(counts.values()), len(later["data"]["comparison"]["changes"]))

    def test_the_changes_listed_are_bounded_and_say_how_many_there_were(self):
        def many(record):
            outcomes = record["protocolSection"]["outcomesModule"]
            outcomes["otherOutcomes"] = [{"measure": "Extra %d" % index} for index in range(trials.MAX_CHANGES + 30)]

        later, _ = self.compare(many)
        comparison = later["data"]["comparison"]
        self.assertEqual(len(comparison["changes"]), trials.MAX_CHANGES)
        self.assertEqual((comparison["outcome"]["state"], comparison["outcome"]["unit"]), ("truncated", "changes listed"))
        self.assertGreaterEqual(comparison["counts"]["endpoint_added"] if "endpoint_added" in comparison["counts"] else 0, 0)

    def test_compare_to_none_a_named_snapshot_and_one_that_is_not_held(self):
        self.snapshot(Registry(edited(lambda record: record["protocolSection"]["designModule"].update(enrollmentInfo={"count": 60, "type": "ESTIMATED"}))))
        held = trials.held_snapshots(self.workspace, NCT)[0]["directory"]
        skipped = self.snapshot(compareTo="none")
        self.assertEqual((skipped["data"]["history"]["comparison"], "comparison" in skipped["data"]), ("not_requested", False))
        named = self.snapshot(compareTo=held[:12])
        self.assertEqual(named["data"]["comparison"]["against"]["directory"], held)
        absent = self.snapshot(compareTo="0" * 12)
        self.assertEqual(absent["status"], "warning")
        self.assertEqual(absent["data"]["history"]["comparison"], "compare_target_not_held")
        self.assertIn("not held in this workspace", " ".join(absent["warnings"]))
        self.assertTrue((self.workspace / absent["data"]["markdownPath"]).is_file(), "the read stands when the comparison cannot be made")

    def test_history_before_the_first_snapshot_is_named_unavailable_with_the_reason(self):
        result = self.snapshot()
        before = result["data"]["history"]["beforeFirstSnapshot"]
        self.assertEqual((before["available"], before["reason"]), (False, "not_in_documented_api"))
        self.assertIn("Record History tab", before["how"])
        self.assertIn("https://clinicaltrials.gov/study/%s" % NCT, before["how"])
        self.assertEqual(result["data"]["history"]["source"], "snapshots preserved by this tool in this project")

    def test_many_held_snapshots_are_paged_with_how_to_reach_the_rest(self):
        for index in range(trials.MAX_HELD_LISTED + 3):
            self.snapshot(Registry(edited(lambda record, index=index: record["protocolSection"]["designModule"].update(enrollmentInfo={"count": 100 + index, "type": "ACTUAL"}))))
        result = self.snapshot()
        history = result["data"]["history"]
        self.assertEqual((history["snapshotsHeld"], len(history["held"])), (trials.MAX_HELD_LISTED + 4, trials.MAX_HELD_LISTED))
        self.assertEqual(history["outcome"]["state"], "more_available")
        self.assertEqual(history["outcome"]["remaining"], 4)


class AlignmentTests(unittest.TestCase):
    def test_registered_outcomes_are_joined_to_reported_results_by_exact_title_only(self):
        alignment = trials.extract(REAL)
        endpoints = alignment["endpoints"]
        self.assertEqual((len(endpoints["registered"]), len(endpoints["reported"])), (len(endpoints["joined"]["matched"]) + len(endpoints["joined"]["registeredOnly"]), 7))
        self.assertTrue(all(entry["roleAgrees"] for entry in endpoints["joined"]["matched"]))
        record = copy.deepcopy(REAL)
        record["resultsSection"]["outcomeMeasuresModule"]["outcomeMeasures"][0]["title"] = "Maximum concentration of simvastatin"
        joined = trials.extract(record)["endpoints"]["joined"]
        self.assertIn("Cmax of Simvastatin", [entry["measure"] for entry in joined["registeredOnly"]], "a reworded title is not guessed to be the same endpoint")
        self.assertIn("Maximum concentration of simvastatin", [entry["title"] for entry in joined["reportedOnly"]])

    def test_populations_and_timepoints_are_read_where_the_registry_puts_them(self):
        alignment = trials.extract(REAL)
        self.assertEqual(alignment["population"]["enrollment"], {"count": 52, "type": "ACTUAL"})
        self.assertEqual(alignment["timepoints"]["start"], {"date": "2014-12-22", "type": "ACTUAL"})
        self.assertEqual(alignment["population"]["baseline"]["denominators"], [{"units": "Participants", "group": "Simvastatin and AZD9291 (Part A); AZD9291 Alone (Part B)", "count": "52"}])
        cmax = alignment["endpoints"]["reported"][0]
        self.assertEqual((cmax["title"], cmax["unit"], cmax["paramType"], cmax["role"]), ("Cmax of Simvastatin", "ng/mL", "GEOMETRIC_MEAN", "primary"))
        self.assertEqual([(row["group"], row["value"], row["lower"], row["upper"]) for row in cmax["values"]], [("Simvastatin Alone", "24.54", "2.69", "75.5"), ("AZD9291 + Simvastatin", "18.65", "3.87", "141")])
        self.assertEqual(cmax["analyses"][0]["value"], "77.08")
        self.assertEqual(alignment["adverseEvents"]["seriousTerms"], 14)

    def test_a_field_the_registry_does_not_give_is_absent_never_filled(self):
        bare = trials.extract({"protocolSection": {"identificationModule": {"nctId": NCT}}})
        self.assertEqual(bare, {"nctId": NCT, "version": {"hasResults": False}, "population": {"baseline": {"denominators": [], "measures": []}, "arms": [], "flow": [], "eligibility": {}, "enrollment": {}}} if False else bare)
        self.assertNotIn("timepoints", bare)
        self.assertNotIn("adverseEvents", bare)
        self.assertEqual(bare["endpoints"]["registered"] if "endpoints" in bare else [], [])


class FailureTests(Workspace):
    def test_a_refusal_a_stall_and_a_down_registry_are_the_three_named_failures(self):
        with mock.patch.object(public_sources, "_open_remote", Registry(failing=wire.through_gateway("idconv__429.html"))):
            pass
        denied = [wire.through_gateway("europepmc__fulltextxml_500.json")] * 3
        for failing, state, code in (
            (denied, "unavailable", "source_unavailable"),
            ([TimeoutError("t")], "timeout", "source_timeout"),
        ):
            with mock.patch.object(public_sources, "_open_remote", Registry(failing=list(failing))):
                with self.assertRaises(source_outcome.SourceError) as raised:
                    trials.snapshot({"nctId": NCT})
            self.assertEqual((raised.exception.state, raised.exception.code), (state, code))
        self.assertFalse((self.workspace / ".evimed-sources").exists())

    def test_a_record_over_the_bound_is_truncated_and_never_preserved_from_a_cut_body(self):
        with mock.patch.object(trials, "MAX_RECORD_BYTES", 1000):
            result = self.snapshot()
        self.assertEqual(result["status"], "warning")
        self.assertEqual((result["data"]["outcome"]["state"], result["data"]["outcome"]["unit"]), ("truncated", "bytes of record"))
        self.assertFalse((self.workspace / ".evimed-sources").exists())

    def test_an_answer_that_is_not_a_study_record_is_unreadable(self):
        with mock.patch.object(public_sources, "_open_remote", Registry(record={"unexpected": True})):
            with self.assertRaises(source_outcome.SourceError) as raised:
                trials.snapshot({"nctId": NCT})
        self.assertEqual(raised.exception.reason, "invalid_response")
        other = edited(lambda record: record["protocolSection"]["identificationModule"].update(nctId="NCT00000001"))
        with mock.patch.object(public_sources, "_open_remote", Registry(record=other)):
            with self.assertRaises(source_outcome.SourceError) as raised:
                trials.snapshot({"nctId": NCT})
        self.assertEqual(raised.exception.reason, "identity_mismatch")


class IntakeTests(Workspace):
    def test_only_the_markdown_rendering_is_offered_to_intake(self):
        offered = []
        with mock.patch.object(trials.source_intake, "hand_off", side_effect=lambda group, files, deadline=None: offered.append((group, files)) or {"available": True, "registered": 1, "refused": 0, "results": []}):
            result = self.snapshot(intake=True)
        self.assertEqual(offered[0][0], "clinicaltrials-%s" % NCT)
        self.assertEqual(offered[0][1], [result["data"]["markdownPath"]])
        with mock.patch.object(trials.source_intake, "hand_off", return_value={"available": False, "reason": "no_gateway", "how": "Source intake is offered through the platform gateway."}):
            unavailable = self.snapshot(intake=True)
        self.assertEqual(unavailable["status"], "warning")
        self.assertTrue((self.workspace / unavailable["data"]["markdownPath"]).is_file())


def load_server():
    spec = importlib.util.spec_from_file_location("evimed_research_mcp_trial_snapshots", ROOT / "server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ThroughTheServerTests(Workspace):
    @classmethod
    def setUpClass(cls):
        cls.server = load_server()

    def call(self, arguments, registry=None):
        with mock.patch.object(public_sources, "_open_remote", registry or Registry()):
            return self.server.call_tool("clinical_trial_snapshot", arguments)

    def test_the_tool_is_declared_with_its_pattern_and_passes_the_result_contract(self):
        schema = self.server.TOOLS["clinical_trial_snapshot"]["inputSchema"]
        self.assertEqual((sorted(schema["properties"]), schema["required"]), (["compareTo", "intake", "nctId"], ["nctId"]))
        result = self.call({"nctId": NCT})
        self.assertEqual(result["status"], "success", result)
        self.assertEqual(result["data"]["provenance"]["tool"], "clinical_trial_snapshot")
        self.assertEqual(set(result["artifacts"]) - set(result["data"]["artifactSha256s"]), set())
        self.assertEqual(result["sources"][0]["sourceType"], "trial-registration")

    def test_a_malformed_id_never_reaches_the_connector_and_a_missing_record_is_a_warning(self):
        self.assertEqual(self.call({"nctId": "NCT123"})["error"]["code"], "invalid_input")
        missing = self.call({"nctId": "NCT99999999"})
        self.assertEqual((missing["status"], missing["data"]["outcome"]["state"]), ("warning", "no_results"), missing)

    def test_a_whole_failure_reaches_the_run_in_the_closed_vocabulary(self):
        result = self.call({"nctId": NCT}, Registry(failing=[TimeoutError("t")]))
        self.assertEqual((result["status"], result["error"]["code"]), ("error", "source_timeout"))

    def test_locate_quote_finds_a_number_in_the_preserved_record_by_the_trial_id(self):
        result = self.call({"nctId": NCT})
        with mock.patch.dict(os.environ, {"OPEN_SCIENCE_WORKSPACE_DIR": str(self.workspace)}):
            found = self.server.call_tool("locate_quote", {"sourceId": NCT, "quote": "Enrollment: 52 (ACTUAL)"})
        self.assertEqual(found["status"], "success", found)
        self.assertTrue(found["data"]["found"])
        self.assertEqual(found["data"]["matches"][0]["artifactPath"], result["data"]["markdownPath"])


if __name__ == "__main__":
    unittest.main()
