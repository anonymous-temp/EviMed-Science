import json
import tempfile
import unittest
from pathlib import Path

import evaluation_isolation as isolation


class Recorder(isolation.Transport):
    def __init__(self):
        self.sent = []

    def request(self, method, url, body=None, headers=None, timeout=60):
        self.sent.append((method, url, body))
        return 200, {"data": {}}, {}


KEY = {
    "goldenTrace": [
        {"turn": 1, "tool": "evimed_search", "args": {"query": "empagliflozin"}, "returnDigest": "sha256:" + "b" * 64},
        {"turn": 2, "tool": "write", "args": {"path": "deliverables/report.md"}},
    ],
    "expectedArtifacts": [{"path": "deliverables/report.md", "sha256": "c" * 64}],
    "deterministicChecks": [{"id": "no-fabricated-dose", "kind": "artifact_not_contains", "expected": "每日三次 200 mg"}],
    "clinicalTasks": [{"task": "eligibility", "reference": {"labels": {"patient-example": "ineligible"}}}],
}


class HiddenReferenceTests(unittest.TestCase):
    def setUp(self):
        self.reference = isolation.HiddenReference("fam-001-a", Path("hidden/fam-001-a.reference.json"), KEY)

    def test_the_values_that_would_give_the_answer_away_are_collected_and_the_rest_is_not(self):
        secrets = self.reference.secrets()
        self.assertIn("c" * 64, secrets)
        self.assertIn("sha256:" + "b" * 64, secrets)
        self.assertIn("每日三次 200 mg", secrets)
        self.assertIn(json.dumps(KEY["clinicalTasks"][0]["reference"], ensure_ascii=False, sort_keys=True), secrets)
        self.assertNotIn("evimed_search", secrets)
        self.assertNotIn("empagliflozin", secrets)

    def test_the_answer_key_is_refused_before_any_transport_sees_it(self):
        sink = Recorder()
        guard = isolation.LeakGuardTransport(sink, self.reference.secrets())
        with self.assertRaises(isolation.HiddenReferenceLeak):
            guard.request("POST", "http://control.invalid/api/runs", body={"prompt": f"produce the artifact with digest {'c' * 64}"})
        self.assertEqual(sink.sent, [], "a leak is stopped before dispatch, not noticed after it")

    def test_the_guard_covers_an_upload_and_not_only_the_dispatch_body(self):
        guard = isolation.LeakGuardTransport(Recorder(), {"c" * 64})
        with self.assertRaises(isolation.HiddenReferenceLeak):
            guard.request("POST", "http://control.invalid/api/files/upload", body={"filename": "f.txt", "data": "c" * 64})

    def test_hidden_clinical_labels_are_refused_by_what_they_say(self):
        reference = KEY["clinicalTasks"][0]["reference"]
        guard = isolation.LeakGuardTransport(Recorder(), self.reference.secrets())
        with self.assertRaises(isolation.HiddenReferenceLeak):
            guard.request("POST", "http://example.invalid", {"prompt": reference})

    def test_a_body_that_carries_nothing_of_it_passes_through_and_is_counted(self):
        sink = Recorder()
        guard = isolation.LeakGuardTransport(sink, self.reference.secrets())
        self.assertEqual(guard.request("POST", "http://control.invalid/api/runs", body={"prompt": "write a weekly report"})[0], 200)
        self.assertEqual(guard.request("GET", "http://control.invalid/api/ready")[0], 200)
        self.assertEqual(guard.checked, 1, "a request with no body has nothing to carry")
        self.assertEqual(len(sink.sent), 2)

    def test_a_short_value_is_not_a_secret(self):
        guard = isolation.LeakGuardTransport(Recorder(), {"abc", 7, None, "x" * 8})
        self.assertEqual(guard.secrets, frozenset({"x" * 8}), "a three-letter string would refuse half the platform's requests")


class LoadingTests(unittest.TestCase):
    def test_references_are_read_for_the_briefs_that_have_one_and_a_wrong_shape_is_an_error(self):
        with tempfile.TemporaryDirectory() as directory:
            hidden = Path(directory)
            (hidden / "a.reference.json").write_text(json.dumps(KEY), encoding="utf-8")
            (hidden / "bad.reference.json").write_text("[1]", encoding="utf-8")
            found = isolation.load_hidden_references(hidden, ["a", "no-key-for-this-one"])
            self.assertEqual(list(found), ["a"])
            self.assertIn("c" * 64, isolation.all_secrets(found))
            with self.assertRaises(isolation.EvalError):
                isolation.load_hidden_references(hidden, ["bad"])
            self.assertEqual(isolation.load_hidden_references(None, ["a"]), {})


if __name__ == "__main__":
    unittest.main()
