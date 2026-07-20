import importlib.util
import pathlib
import unittest


RUNNER_FILE = pathlib.Path(__file__).resolve().parent / "run_benchmark.py"


def load_runner():
    spec = importlib.util.spec_from_file_location("drug_evidence_quality_test", RUNNER_FILE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class DrugEvidenceQualityBenchmarkTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runner = load_runner()
        cls.result = cls.runner.run_benchmark()

    def test_reference_replay_has_no_failed_quality_gate(self):
        self.assertEqual(self.result["status"], "pass")
        self.assertEqual(self.result["summary"]["failed"], 0)

    def test_published_selection_arithmetic_and_context_guard_both_pass(self):
        checks = {item["id"]: item for item in self.result["checks"]}
        self.assertEqual(checks["selection-arithmetic"]["status"], "pass")
        self.assertEqual(checks["selection-reference-order"]["status"], "pass")
        self.assertEqual(checks["selection-live-context-guard"]["status"], "pass")

    def test_reference_defects_remain_warnings_not_scores(self):
        checks = {item["id"]: item for item in self.result["checks"]}
        self.assertEqual(checks["reference-search-cutoff-validity"]["status"], "warning")
        self.assertEqual(checks["reference-price-date"]["status"], "warning")
        self.assertEqual(checks["cross-publication-score-drift"]["status"], "warning")
        self.assertEqual(checks["licensed-source-boundary"]["status"], "warning")

    def test_off_label_and_comprehensive_method_coverage_pass(self):
        checks = {item["id"]: item for item in self.result["checks"]}
        self.assertEqual(checks["comprehensive-domain-coverage"]["status"], "pass")
        self.assertEqual(checks["off-label-method-coverage"]["status"], "pass")
        self.assertEqual(checks["agent-integration-controls"]["status"], "pass")


if __name__ == "__main__":
    unittest.main()
