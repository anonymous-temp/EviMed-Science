import json
from pathlib import Path
import tempfile
import unittest

from local_audit import audit_relations


class RelationalAuditTests(unittest.TestCase):
    def test_repeated_patients_missing_demographics_and_unmatched_labels_stay_distinct(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "inp_record.csv").write_text("patient_id,case_no\np1,c1\np1,c2\np2,c3\n")
            (root / "patient_info.csv").write_text("patient_id\np1\n")
            (root / "case_labels.csv").write_text("patient_id,case_no\np1,c1\np9,c9\n")
            result = audit_relations(root)
        self.assertEqual(result["data"]["admissions"]["rows"], 3)
        self.assertEqual(result["data"]["admissions"]["uniquePatients"], 2)
        self.assertEqual(result["data"]["relations"], {
            "admittedPatientsWithoutDemographics": 1, "admissionsWithoutLabel": 2, "labelsWithoutAdmission": 1,
            "labelCasesWithPatientMismatch": 0,
        })
        self.assertNotIn('"p1"', json.dumps(result))
        self.assertNotIn('"c1"', json.dumps(result))

    def test_missing_key_schema_is_explicit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "inp_record.csv").write_text("observation,value\na,1\n")
            with self.assertRaisesRegex(ValueError, "Required keys absent"):
                audit_relations(root)

    def test_same_admission_with_wrong_patient_and_blank_keys_are_not_clean(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "inp_record.csv").write_text("patient_id,case_no\np1,c1\np1,\np1,\n")
            (root / "patient_info.csv").write_text("patient_id\np1\n")
            (root / "case_labels.csv").write_text("patient_id,case_no\np9,c1\n")
            result = audit_relations(root)
        self.assertEqual(result["data"]["relations"]["labelCasesWithPatientMismatch"], 1)
        self.assertEqual(result["data"]["relations"]["admissionsWithoutLabel"], 1)
        self.assertEqual(result["data"]["relations"]["labelsWithoutAdmission"], 1)
        self.assertEqual(result["data"]["admissions"]["rowsWithMissingKey"], 2)
        self.assertEqual(result["data"]["admissions"]["duplicateAdmissionRows"], 0)

    def test_incomplete_patient_keys_are_missing_not_a_contradiction(self):
        for admission, label in [('p1,c1', ',c1'), (',c1', 'p2,c1')]:
            with self.subTest(admission=admission), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / "inp_record.csv").write_text(f"patient_id,case_no\n{admission}\n")
                (root / "patient_info.csv").write_text("patient_id\np1\np2\n")
                (root / "case_labels.csv").write_text(f"patient_id,case_no\n{label}\n")
                result = audit_relations(root)
                self.assertEqual(result['data']['relations']['labelCasesWithPatientMismatch'], 0)
                self.assertEqual(sum(result['data'][name]['rowsWithMissingKey'] for name in ['admissions', 'labels']), 1)
