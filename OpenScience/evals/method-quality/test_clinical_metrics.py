import unittest
import clinical_metrics as m
import run_paired as runner
from pathlib import Path

class ClinicalMetricsTests(unittest.TestCase):
    def test_hidden_clinical_labels_are_refused_before_transport(self):
        reference={'labels':{'patient-example':'ineligible'},'states':['eligible','ineligible','unknown']}
        hidden=runner.HiddenReference('c',Path('hidden.json'),{'clinicalTasks':[{'task':'eligibility','reference':reference}]})
        class Sink(runner.Transport):
            def request(self,*args,**kwargs):
                raise AssertionError('A hidden answer reached the backend')
        with self.assertRaises(runner.HiddenReferenceLeak):
            runner.LeakGuardTransport(Sink(),hidden.secrets()).request('POST','http://example.invalid',{'prompt':reference})

    def test_duplicate_and_overlap_mentions_cannot_inflate_recall(self):
        entity = {"id": "e", "type": "drug", "start": 1, "end": 4}
        result = m.score("ner", {"entities": [entity]}, {"entities": [entity, entity]})["metrics"]
        self.assertEqual(result["strict"], {"tp": 1, "fp": 1, "fn": 0, "precision": .5, "recall": 1., "f1": 2/3})
        partial = dict(entity, start=2)
        result = m.score("ner", {"entities": [entity]}, {"entities": [partial]})["metrics"]
        self.assertEqual(result["strict"]["tp"], 0)
        self.assertEqual(result["overlap"]["tp"], 1)

    def test_empty_predictions_and_false_exclusion_keep_denominators(self):
        reference = {"labels": {"empty-chart": "eligible", "known": "eligible", "other": "ineligible"}}
        result = m.eligibility(reference, {"labels": {"known": "ineligible"}})
        self.assertEqual(result["n"], 3)
        self.assertEqual(result["missing"], 2)
        self.assertEqual(result["falseExclusionRate"], .5)
        self.assertEqual(result["eligibleRecall"], 0)

    def test_relations_bind_to_mentions_and_direction(self):
        a = {"id": "a", "type": "drug", "start": 0, "end": 2}
        b = {"id": "b", "type": "gene", "start": 3, "end": 5}
        reference = {"entities": [a, b], "relations": [{"type": "inhibits", "arg1": "a", "arg2": "b"}]}
        prediction = {"entities": [dict(a, id="x"), dict(b, id="y")], "relations": [{"type": "inhibits", "arg1": "x", "arg2": "y"}]}
        self.assertEqual(m.relations(reference, prediction)["tp"], 1)
        prediction["relations"][0].update(arg1="y", arg2="x")
        self.assertEqual(m.relations(reference, prediction)["tp"], 0)

    def test_related_variants_cannot_cross_holdout_and_repeats_do_not_add_clusters(self):
        with self.assertRaisesRegex(ValueError, "related_records"):
            m.verify_groups({"dev": {"briefs": ["a"]}, "holdout": {"briefs": ["b"]}, "sourceGroups": [{"id": "p1", "briefs": ["a", "b"]}]})
        result = m.cluster_interval([{"sourceGroup": "p1", "ok": 1, "n": 1}] * 10, "ok", "n")
        self.assertIsNone(result["low"])
        self.assertEqual(result["groups"], 1)

    def test_retrieval_and_privacy_do_not_hide_tradeoffs(self):
        self.assertEqual(m.retrieval({"eligibleTrials": ["a", "b"], "k": 2}, {"candidates": ["a", "a"]})["candidateRecall"], .5)
        result = m.privacy({"identifiers": [{"type": "person", "value": "TEST_NAME"}], "utilityAnchors": ["否认", "1.2 mg/dL"]}, {"text": "TEST_NAME 1.2 mg/dL"})
        self.assertEqual(result["identifierTypes"]["person"]["residual"], 1)
        self.assertEqual(result["retainedAnchors"], 1)

if __name__ == '__main__':
    unittest.main()
