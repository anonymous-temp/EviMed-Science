import json
import unittest
from score import parse, score


class ScoringTests(unittest.TestCase):
    def test_invalid_evidence_and_missing_mapping_keep_denominator(self):
        request = {'id': 'a', 'user': '0. Present.\nHere is the clinical trial:',
                   'criterion_type': 'inclusion', 'expected_indexes': ['0'],
                   'criterion_map': {'1': {'status': 'matched', 'indexes': ['0']},
                                     '2': {'status': 'missing', 'indexes': []}}}
        gold = [{'annotation_id': i, 'patient_id': 'p', 'gpt4_eligibility': 'included',
                 'gpt4_sentences': '[0]', 'expert_eligibility': 'included', 'expert_sentences': '[0]', 'criterion_type': 'inclusion'} for i in (1, 2)]
        def body(evidence):
            return {'choices': [{'message': {'content': json.dumps({'0': ['reason', evidence, 'included']})}}]}
        self.assertEqual(parse(body([9]), request), {})
        result = score([request], {'a': body([0])}, gold)
        self.assertEqual((result['denominator'], result['valid_predictions']), (2, 1))
        self.assertEqual(result['evidence_exact_over_all'], .5)


if __name__ == '__main__':
    unittest.main()

class DuplicateTests(unittest.TestCase):
    def test_duplicate_keys_rejected_when_conflicting(self):
        req = {'user': '0. Fact.\nHere is the clinical trial:', 'criterion_type': 'exclusion', 'expected_indexes': ['0']}
        def body(s):
            return {'choices': [{'message': {'content': s}}]}
        a = '["why",[0],"excluded"]'
        b = '["why",[0],"not excluded"]'
        self.assertEqual(parse(body('{"0":'+a+',"0":'+b+'}'), req), {})
        self.assertEqual(parse(body('{"0":'+a+',"0":'+a+'}'), req)['0'][2], 'excluded')


class ReferenceTests(unittest.TestCase):
    def test_expert_is_primary_and_gpt4_is_separate(self):
        request = {'id': 'x', 'user': '0. Fact.\nHere is the clinical trial:', 'criterion_type': 'inclusion',
                   'expected_indexes': ['0'], 'criterion_map': {'1': {'status': 'matched', 'indexes': ['0']}}}
        gold = [{'annotation_id': 1, 'patient_id': 'p', 'criterion_type': 'inclusion',
                 'expert_eligibility': 'not applicable', 'expert_sentences': '[]',
                 'gpt4_eligibility': 'included', 'gpt4_sentences': '[0]'}]
        body = {'choices': [{'finish_reason': 'stop', 'message': {'content': '```json\n{"0":["reason",[0],"included"]}\n```'}}]}
        primary = score([request], {'x': body}, gold)
        self.assertEqual((primary['correct'], primary['false_favorable_count']), (0, 1))
        self.assertEqual(score([request], {'x': body}, gold, reference='gpt4')['correct'], 1)
        body['choices'][0]['finish_reason'] = 'length'
        self.assertEqual(score([request], {'x': body}, gold)['valid_predictions'], 0)

class ShapeTests(unittest.TestCase):
    def test_closed_schema_and_original_array_count(self):
        req = {'id': 'x', 'user': '0. Fact.\nHere is the clinical trial:', 'criterion_type': 'inclusion',
               'expected_indexes': ['0'], 'criterion_map': {'1': {'status': 'matched', 'indexes': ['0']}}}
        gold = [{'annotation_id': 1, 'patient_id': 'p', 'criterion_type': 'inclusion',
                 'expert_eligibility': 'included', 'expert_sentences': '[0]'}]
        obj = {'reasoning': 'why', 'sentence_ids': [0], 'label': 'included'}
        def body(value):
            return {'choices': [{'message': {'content': json.dumps({'0': value})}}]}
        result = score([req], {'x': body(obj)}, gold)
        self.assertEqual((result['valid_predictions'], result['wire_schema_compliant_predictions'], result['equivalent_shape_predictions']), (1, 0, 1))
        self.assertEqual(parse(body(obj), req, normalize_shapes=False), {})
        self.assertEqual(parse(body({**obj, 'other': 1}), req), {})
        self.assertEqual(parse(body({**obj, 'eligibility': 'included'}), req), {})
        self.assertEqual(parse(body({**obj, 'sentence_ids': [7]}), req), {})
        self.assertEqual(parse(body({**obj, 'label': 'Included'}), req), {})
