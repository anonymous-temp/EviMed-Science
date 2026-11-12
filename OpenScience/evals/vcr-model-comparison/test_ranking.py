import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from ranking import card, metrics, payload, parse_receipt, evaluated_order, validate_requests, run, freeze, verify_freeze, reviewed_failure_matches_topic


class RankingTests(unittest.TestCase):
    def test_reviewed_failure_attribution_handles_batches_and_pairs(self):
        self.assertTrue(reviewed_failure_matches_topic('dashscope-2021-49', 'dashscope', 2021, '49'))
        self.assertTrue(reviewed_failure_matches_topic('jev114-2021-49-08', 'jev114', 2021, '49'))
        self.assertFalse(reviewed_failure_matches_topic('jev114-2021-49-08', 'jev114', 2021, '4'))
        self.assertFalse(reviewed_failure_matches_topic(None, 'dashscope', 2021, '49'))

    def test_card_never_serializes_labels_or_metadata(self):
        self.assertEqual(card({'title': 'Trial', 'qrel': 2, 'source_archive': 'secret'}), 'title: Trial')

    def test_metrics_use_global_ideal_and_fixed_ten_denominator(self):
        result = metrics(['a', 'b'], {'a': 1, 'b': 2, 'c': 2})
        self.assertEqual(result['p10_eligible'], 0.1)
        self.assertEqual(result['mrr_eligible'], 0.5)
        self.assertEqual(result['recall10_eligible'], 0.5)
        self.assertLess(result['ndcg10_global'], result['ndcg10_pool'])

    def test_failure_falls_back_without_dropping_patient(self):
        row = {'year': 2021, 'topic_id': '1', 'patient': 'patient',
               'candidates': [{'id': str(i), 'text': 'trial'} for i in range(10)]}
        with tempfile.TemporaryDirectory() as temp:
            frozen = freeze([row], 'jev113', None, Path(temp))
            order, status = evaluated_order(row, 'jev113', Path(temp), frozen)
            self.assertEqual(order, [str(i) for i in range(10)])
            self.assertEqual(status, 'fallback_missing_or_failed')
        self.assertEqual(validate_requests([row], 'jev113', None)['requests'], 10)
        self.assertIn('never instructions', payload('jev113', row, 0)['questions']['relevance']['instructions'])

    def test_invalid_partial_or_failed_response_rejected(self):
        with self.assertRaises(ValueError):
            parse_receipt('dashscope', {'status': 200, 'body': {'results': [{'index': 0, 'relevance_score': 1}]}})
        with self.assertRaises(ValueError):
            parse_receipt('jev113', {'status': 401, 'error': 'http_401'})
        with self.assertRaises(ValueError):
            parse_receipt('jev113', {'status': 200, 'body': {'answers': {'relevance': {'type': 'score', 'score': 4}}}})

    def test_first_failure_is_persisted_and_stops_resume(self):
        class FakeClient:
            calls = 0
            def __init__(self, out):
                self.out = out
            def configured(self, provider):
                return True
            def request(self, provider, model, body, label):
                FakeClient.calls += 1
                receipt = {'status': 401, 'error': 'http_401'}
                (self.out / (label + '.json')).write_text(json.dumps(receipt))
                return receipt
        row = {'year': 2021, 'topic_id': '1', 'patient': 'patient',
               'candidates': [{'id': str(i), 'text': 'trial'} for i in range(10)]}
        with tempfile.TemporaryDirectory() as temp, patch('api.ProviderClient', FakeClient):
            freeze([row], 'jev113', None, Path(temp))
            with self.assertRaises(ValueError):
                run([row], 'jev113', None, Path(temp), None)
            stop = json.loads((Path(temp) / 'jev113' / 'STOP.json').read_text())
            self.assertEqual(stop['candidate_index'], 0)
            with self.assertRaises(RuntimeError):
                run([row], 'jev113', None, Path(temp), None)
            self.assertEqual(FakeClient.calls, 1)

    def test_identity_frozen_and_receipt_validation(self):
        row = {'year': 2021, 'topic_id': '1', 'patient': 'patient',
               'candidates': [{'id': str(i), 'text': f'trial {i}'} for i in range(10)]}
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)
            frozen = freeze([row], 'jev113', None, path)
            changed = json.loads(json.dumps(row))
            changed['candidates'][0], changed['candidates'][1] = changed['candidates'][1], changed['candidates'][0]
            with self.assertRaises(ValueError): verify_freeze([changed], 'jev113', None, path)
            with self.assertRaises(ValueError): freeze([changed], 'jev113', None, path)
            with self.assertRaises(ValueError): evaluated_order(changed, 'jev113', path, frozen)
            label = 'jev113-2021-1-00'
            receipt = {'status': 200, 'requested_model': 'jev-1.13.0',
                       'request_sha256': frozen['request_sha256'][label],
                       'body': {'model': 'jev-1.13.0', 'answers': {'relevance': {'type': 'score', 'score': 2}}}}
            self.assertEqual(parse_receipt('jev113', receipt, frozen['request_sha256'][label], 'jev-1.13.0'), 2)
            for key, value in [('request_sha256', 'wrong'), ('requested_model', 'wrong')]:
                altered = {**receipt, key: value}
                with self.assertRaises(ValueError): parse_receipt('jev113', altered, frozen['request_sha256'][label], 'jev-1.13.0')
            receipt['body']['model'] = 'wrong'
            with self.assertRaises(ValueError): parse_receipt('jev113', receipt, frozen['request_sha256'][label], 'jev-1.13.0')
            for i in range(10):
                item_label = f'jev113-2021-1-{i:02d}'
                item = {'status': 200, 'requested_model': 'jev-1.13.0',
                        'request_sha256': frozen['request_sha256'][item_label],
                        'body': {'model': 'jev-1.13.0', 'answers': {'relevance': {'type': 'score', 'score': i / 4}}}}
                (path / 'jev113' / (item_label + '.json')).write_text(json.dumps(item))
            self.assertEqual(evaluated_order(row, 'jev113', path, frozen)[1], 'ok')
            item['request_sha256'] = 'incorrect'
            (path / 'jev113' / (item_label + '.json')).write_text(json.dumps(item))
            self.assertEqual(evaluated_order(row, 'jev113', path, frozen)[1], 'fallback_missing_or_failed')


    def test_rejects_boolean_score_and_float_indices(self):
        receipt = {'status': 200, 'body': {'answers': {'relevance': {'type': 'score', 'score': True}}}}
        with self.assertRaises(ValueError): parse_receipt('jev113', receipt)
        receipt = {'status': 200, 'body': {'results': [{'index': float(i), 'relevance_score': 0.1} for i in range(10)]}}
        with self.assertRaises(ValueError): parse_receipt('dashscope', receipt)

    def test_reviewed_transport_resume_never_retries_failed_label(self):
        row = {'year': 2021, 'topic_id': '1', 'patient': 'patient',
               'candidates': [{'id': str(i), 'text': f'trial {i}'} for i in range(10)]}
        class FakeClient:
            calls = []
            def __init__(self, out): self.out = out
            def configured(self, provider): return True
            def request(self, provider, model, body, label):
                FakeClient.calls.append(label)
                return {'status': 200, 'requested_model': model,
                        'request_sha256': frozen['request_sha256'][label],
                        'body': {'model': model, 'answers': {'relevance': {'type': 'score', 'score': 1}}}}
        with tempfile.TemporaryDirectory() as temp, patch('api.ProviderClient', FakeClient):
            path = Path(temp)
            frozen = freeze([row], 'jev114', None, path)
            label = 'jev114-2021-1-03'
            out = path / 'jev114'
            (out / 'STOP.json').write_text(json.dumps({'label': label}))
            (out / (label + '.json')).write_text(json.dumps({'status': None, 'error': 'request_URLError'}))
            result = run([row], 'jev114', None, path, None, label)
            self.assertEqual(len(FakeClient.calls), 9)
            self.assertNotIn(label, FakeClient.calls)
            self.assertEqual(result['skipped_failed_label'], label)
            self.assertTrue((out / 'STOP.json').exists())
            self.assertTrue((out / 'resume-reviewed-transport.json').exists())

    def test_post_primary_dashscope_ablation_keeps_primary_payload(self):
        from ranking import INSTRUCTION, RUBRIC
        row = {'year': 2021, 'topic_id': '1', 'patient': 'patient',
               'candidates': [{'id': str(i), 'text': 'trial'} for i in range(10)]}
        original = payload('dashscope', row, dash_model='qwen3-rerank')
        new = payload('dashscope_clinical', row, dash_model='qwen3-rerank')
        self.assertNotIn('instruct', original)
        self.assertEqual({k: v for k, v in new.items() if k != 'instruct'}, original)
        self.assertIn(INSTRUCTION, new['instruct'])
        for level in RUBRIC: self.assertIn(level, new['instruct'])


if __name__ == '__main__':
    unittest.main()
