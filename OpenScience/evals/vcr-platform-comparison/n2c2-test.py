"""Offline synthetic fixtures only. Protected patient text never belongs in tests."""
import importlib.util
import os
from unittest.mock import patch
import json
from pathlib import Path
import stat
import tempfile
import unittest
import zipfile

HERE = Path(__file__).resolve().parent


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


prep = module("n2c2_prepare", "n2c2-prepare.py")
scorer = module("n2c2_score", "n2c2-score.py")
DEFINITION = json.loads((HERE / "n2c2-protocol.json").read_bytes())
TAGS = [row["tag"] for row in DEFINITION["criteria"]]
TEXT = "Record date: 2020-01-15\nSynthetic baseline 🙂.\nRecord date: 2020-07-16\nSynthetic later correction.\n"


def xml(text=TEXT, training=True):
    tags = "".join('<' + tag + ' met="met" />' for tag in TAGS) if training else ""
    return ('<PatientMatching><TEXT><![CDATA[' + text + ']]></TEXT><TAGS>' + tags
            + '</TAGS></PatientMatching>').encode()


def archive(path, rows, prefix="train/"):
    with zipfile.ZipFile(path, "w") as zipped:
        for name, body in rows:
            zipped.writestr(prefix + name + ".xml", body)


class Preparation(unittest.TestCase):
    def test_training_labels_are_removed_and_original_text_and_dates_are_preserved(self):
        text, provenance = prep.patient_text(xml(), "train")
        self.assertEqual(text, TEXT.encode())
        self.assertNotIn(b'<TAGS', text)
        self.assertNotIn(b'met="', text)
        self.assertEqual(provenance["annotationElementsRemoved"], 13)
        self.assertEqual(provenance["asOf"], "2020-07-16")
        self.assertEqual(len(provenance["segments"]), 2)
        for segment in provenance["segments"]:
            fragment = TEXT[segment["start"]:segment["end"]]
            self.assertEqual(prep.sha(fragment.encode()), segment["sha256"])
        self.assertGreater(provenance["segments"][1]["utf16Start"], provenance["segments"][1]["start"])

    def test_test_labels_entities_invalid_dates_and_undated_inputs_are_rejected(self):
        for body, split in [(xml(), "test"), (xml("<!ENTITY unsafe>"), "train"),
                            (xml("Record date: 2020-02-30\nSynthetic."), "train"),
                            (xml("Synthetic undated record."), "train")]:
            with self.assertRaises((ValueError, Exception)):
                prep.patient_text(body, split)

    def test_patient_archive_and_files_are_isolated(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "train.zip"
            archive(source, [("1", xml()), ("2", xml(TEXT.replace("baseline", "second baseline")))])
            out = root / "out"
            cases, provenance = prep.build_split(source, "train", out, out, DEFINITION, 2)
            self.assertEqual(len(cases), 2)
            self.assertNotEqual(cases[0]["files"][0]["path"], cases[1]["files"][0]["path"])
            for case, original in zip(cases, provenance):
                self.assertEqual({row["name"] for row in case["files"]}, {"patient.txt", "protocol.txt"})
                patient = Path(case["files"][0]["path"]).read_bytes()
                self.assertEqual(prep.sha(patient), original["textSha256"])
                self.assertNotIn(b"<TAGS", patient)
                self.assertEqual(Path(case["files"][0]["path"]).stat().st_mode & 0o077, 0)

    def test_unsafe_archive_member_and_unexpected_count_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "bad.zip"
            with zipfile.ZipFile(source, "w") as zipped:
                zipped.writestr("../record.xml", xml())
            with self.assertRaises(ValueError):
                list(prep.archive_patients(source, "train/"))
            source = root / "one.zip"
            archive(source, [("1", xml())])
            with self.assertRaises(ValueError):
                prep.build_split(source, "train", root / "out", root / "out", DEFINITION, 2)

    def test_protocol_contains_full_definitions_without_scoring_default_rules(self):
        text = prep.protocol_text(DEFINITION)
        for criterion in DEFINITION["criteria"]:
            self.assertIn("[" + criterion["tag"] + "] " + criterion["text"], text)
        self.assertNotIn("unknownAsMet", text)
        self.assertNotIn("Binary sensitivity", text)
        self.assertIn("two or more of the following", text)
        self.assertIn("excluding Vitamin D", text)

    def test_authorization_binds_exact_dataset_provider_source_and_experiment(self):
        root = Path("/user-supplied")
        record = {"schema": 1, "dataset": "n2c2-2018-t1", "userConfirmed": True,
                  "provider": "deepseek-official", "destination": "https://api.deepseek.com",
                  "purpose": "vcr-platform-evaluation", "confirmationReference": "user-confirmation-20261104",
                  "experimentId": "vcrbench-n2c2-offline",
                  "dataProvenance": {"kind": "user-supplied", "sourceRoot": str(root), "archiveSha256": prep.PINS}}
        prep.authorization(record, root)
        for changes in [{"userConfirmed": False}, {"destination": "https://other.invalid"},
                        {"dataset": "other"}, {"experimentId": "../other"}, {"labels": {"A": "met"}}]:
            with self.assertRaises(ValueError):
                prep.authorization({**record, **changes}, root)

    def test_private_output_location_is_mandatory(self):
        with self.assertRaises(ValueError):
            prep.private_path(Path("/tmp/public-report"))
        self.assertEqual(prep.private_path(Path("/tmp/.evimed-local/acceptance/data")).name, "data")


class Scoring(unittest.TestCase):
    def case(self):
        criteria = [{**row, "text": row["text"], "kind": "inclusion", "state": "satisfied",
                     "decidedBy": "code", "criterionId": "criterion-" + str(i), "applicable": True}
                    for i, row in enumerate(DEFINITION["criteria"])]
        return {"status": "settled", "matching": {"direction": "trial_to_patient", "candidateRoster": ["subject-one"],
                "selected": {"candidate": {"id": "subject-one"}, "assessmentId": "saved", "criteria": criteria}}}

    def test_unknown_unprocessed_and_unmapped_are_distinct(self):
        case = self.case()
        rows = case["matching"]["selected"]["criteria"]
        rows[0]["state"] = "unknown"
        rows[1]["state"] = "unknown"
        rows[1]["decidedBy"] = None
        rows[2]["text"] = "Truncated condition"
        results = scorer.predictions(case, DEFINITION["criteria"])
        self.assertEqual([row["state"] for row in results[:3]], ["clinical_unknown", "unprocessed", "unmapped"])
        self.assertEqual(len(results), 13)

    def test_duplicate_clauses_wrong_kind_and_missing_assessment_do_not_score_as_unknown(self):
        case = self.case()
        rows = case["matching"]["selected"]["criteria"]
        rows.append(dict(rows[0]))
        rows[1]["kind"] = "exclusion"
        result = scorer.predictions(case, DEFINITION["criteria"])
        self.assertEqual(result[0]["state"], "unmapped")
        self.assertEqual(result[1]["state"], "unmapped")
        case["matching"]["selected"]["assessmentId"] = None
        self.assertEqual({row["state"] for row in scorer.predictions(case, DEFINITION["criteria"])}, {"unprocessed"})

    def test_incomplete_attempt_keeps_saved_decisive_rows_and_separate_execution_state(self):
        case = self.case()
        case["status"] = "run_failed"
        result = scorer.predictions(case, DEFINITION["criteria"])
        self.assertEqual(result[0]["state"], "satisfied")
        self.assertEqual(result[0]["caseStatus"], "run_failed")

    def test_annotation_sensitivities_never_turn_unprocessed_into_met(self):
        self.assertEqual(scorer.binary({"tag": "ENGLISH", "state": "clinical_unknown"}, "c"), "met")
        self.assertEqual(scorer.binary({"tag": "ENGLISH", "state": "clinical_unknown"}, "b"), "not met")
        for state in ("unprocessed", "unmapped", "not_applicable", "pending_recheck"):
            self.assertEqual(scorer.binary({"tag": "ENGLISH", "state": state}, "c"), "not met")

    def test_pending_recheck_with_a_date_stays_pending_in_sensitivity_c(self):
        case = self.case()
        row = case["matching"]["selected"]["criteria"][7]
        row["state"], row["recheckAt"] = "pending_recheck", "2021-01-15T00:00:00.000Z"
        result = scorer.predictions(case, DEFINITION["criteria"])[7]
        self.assertEqual(result["state"], "pending_recheck")
        self.assertEqual(result["recheckAt"], row["recheckAt"])
        self.assertEqual(scorer.binary(result, "c"), "not met")
        units = [{"caseId": "synthetic", **value} for value in scorer.predictions(case, DEFINITION["criteria"])]
        self.assertEqual(scorer.complete_assessment_patients(units), set())
        units[7]["state"] = "clinical_unknown"
        self.assertEqual(scorer.complete_assessment_patients(units), {"synthetic"})

    def test_freeze_then_tampering_is_rejected_before_any_gold_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / ".evimed-local" / "acceptance"
            campaign, prepared, frozen = root / "campaign", root / "prepared", root / "predictions"
            (campaign / "synthetic-case").mkdir(parents=True)
            prepared.mkdir()
            manifest = {"task": "protocol_matching", "dataset": "n2c2-2018-t1", "split": "test",
                        "cases": [{"id": "synthetic-case"}], "sealedGoldSha256": "a" * 64,
                        "sourceArchiveSha256": "b" * 64}
            provenance = {"cases": [{"caseId": "synthetic-case", "originalXmlId": "synthetic"}]}
            scorer.save(prepared / "provenance.json", provenance)
            manifest["provenanceSha256"] = scorer.sha((prepared / "provenance.json").read_bytes())
            scorer.save(prepared / "cases.json", manifest)
            scorer.save(campaign / "FROZEN.json", {"task": "protocol_matching", "split": "test",
                        "planned": ["synthetic-case"], "manifestSha256": scorer.sha((prepared / "cases.json").read_bytes()),
                        "protocolDefinitionSha256": scorer.sha(scorer.DEFINITION.read_bytes())})
            case = self.case()
            case["caseId"] = "synthetic-case"
            scorer.save(campaign / "synthetic-case/case.json", case)
            with patch.object(scorer, "gold_labels", side_effect=AssertionError("Gold must remain closed")) as gold:
                scorer.freeze(campaign, prepared / "cases.json", frozen)
                gold.assert_not_called()
                (campaign / "synthetic-case/case.json").write_text("{}")
                with self.assertRaisesRegex(ValueError, "first-attempt"):
                    scorer.score(frozen, root / "missing-source", root / "metrics")
                gold.assert_not_called()

    def test_exact_official_script_matches_independent_formula_on_synthetic_labels(self):
        source = Path(os.environ.get("EVIMED_N2C2_ROOT", ".evimed-local/acceptance/n2c2-2018-t1"))
        archive = source / "raw/track1_eval_script.zip"
        if not archive.is_file():
            self.skipTest("The user-provided official scorer archive is not configured")
        self.assertEqual(scorer.sha(archive.read_bytes()), DEFINITION["source"]["archiveSha256"]["raw/track1_eval_script.zip"])
        with zipfile.ZipFile(archive) as zipped:
            script = zipped.read("track1_eval.py")
        labels, units = {}, []
        for patient_index, patient in enumerate(["synthetic-a", "synthetic-b"]):
            labels[patient] = {}
            for index, tag in enumerate(TAGS):
                labels[patient][tag] = "met" if (index + patient_index) % 2 else "not met"
                units.append({"originalXmlId": patient, "tag": tag,
                              "state": ["satisfied", "not_satisfied", "clinical_unknown"][(index + patient_index) % 3]})
        for reading in ["b", "c"]:
            with tempfile.TemporaryDirectory() as tmp:
                output = scorer.official_score(script, units, labels, reading, Path(tmp))
            expected = scorer.binary_metrics(units, labels, reading)
            micro = next(line for line in output.splitlines() if "Overall (micro)" in line)
            macro = next(line for line in output.splitlines() if "Overall (macro)" in line)
            self.assertAlmostEqual(float(micro.split()[9]), expected["microOverallF1"], delta=0.000051)
            self.assertAlmostEqual(float(macro.split()[9]), expected["macroOverallF1"], delta=0.000051)

    def test_gold_reader_is_separate_and_validates_all_criterion_labels(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "gold.zip"
            archive(source, [("1", xml())], "gold/")
            values = scorer.gold_labels(source, "gold/", TAGS)
            self.assertEqual(len(values["1"]), 13)
            self.assertEqual(values["1"]["HBA1C"], "met")

    def test_exact_whole_clause_alignment_preserves_qualifiers(self):
        criterion = DEFINITION["criteria"][1]
        self.assertTrue(scorer.clause_matches("[" + criterion["tag"] + "] " + criterion["text"], criterion))
        self.assertFalse(scorer.clause_matches(criterion["text"].replace("two or more", "one"), criterion))


if __name__ == "__main__":
    unittest.main()
