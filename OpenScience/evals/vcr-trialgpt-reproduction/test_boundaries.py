"""Network-free regressions for immutable scoring targets and malformed responses."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import prepare
from run import payload, score_all
from score import OBJECT_SCHEMAS, parse
from upstream import load


def file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class TargetBindingTests(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.prepared = self.root / 'prepared'
        self.out = self.root / 'out'
        self.prepared.mkdir()
        self.out.mkdir()
        (self.prepared / 'requests.json').write_text('[]')
        (self.prepared / 'manifest.json').write_text('{"input_sha256":"original-input"}')
        self.gold_file = self.root / 'gold.json'
        self.gold = [{'annotation_id': index, 'patient_id': 'p',
                      'criterion_type': 'inclusion', 'expert_eligibility': 'included',
                      'expert_sentences': '[]'} for index in range(1015)]
        self.gold_file.write_text(json.dumps(self.gold))
        protocol = {'prepared_sha256': file_hash(self.prepared / 'requests.json'),
                    'manifest_sha256': file_hash(self.prepared / 'manifest.json'),
                    'dev_patients': ['p'], 'evaluation_patients': [], 'requests': {}, 'arms': {'original_flash': ['deepseek-v4-flash', False]}}
        (self.out / 'FROZEN.json').write_text(json.dumps(protocol))
        self.bind_targets()

    def bind_targets(self) -> None:
        targets = {'gold_sha256': file_hash(self.gold_file),
                   'input_sha256': 'original-input',
                   'protocol_sha256': file_hash(self.out / 'FROZEN.json')}
        (self.out / 'TARGETS.json').write_text(json.dumps(targets))

    def test_bound_targets_keep_complete_missing_prediction_denominator(self) -> None:
        result = score_all(self.prepared, self.out, self.gold_file)
        for arm in result.values():
            self.assertEqual(arm['all']['denominator'], 1015)
            self.assertEqual(arm['all']['valid_predictions'], 0)
            self.assertEqual(arm['all']['accuracy'], 0)

    def test_changed_gold_bytes_rejected_even_with_same_identities(self) -> None:
        self.gold[0]['expert_eligibility'] = 'not included'
        self.gold_file.write_text(json.dumps(self.gold))
        with self.assertRaisesRegex(ValueError, 'bound bytes'):
            score_all(self.prepared, self.out, self.gold_file)

    def test_changed_manifest_rejected(self) -> None:
        (self.prepared / 'manifest.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'manifest freeze'):
            score_all(self.prepared, self.out, self.gold_file)

    def test_changed_protocol_rejected_by_target_binding(self) -> None:
        protocol_file = self.out / 'FROZEN.json'
        protocol_file.write_text(protocol_file.read_text() + '\n')
        with self.assertRaisesRegex(ValueError, 'Target/protocol'):
            score_all(self.prepared, self.out, self.gold_file)

    def test_short_or_duplicate_gold_rejected_even_if_hash_rebound(self) -> None:
        for gold in (self.gold[:-1], self.gold[:-1] + [self.gold[0]]):
            with self.subTest(size=len(gold)):
                self.gold_file.write_text(json.dumps(gold))
                self.bind_targets()
                with self.assertRaisesRegex(ValueError, 'full 1015'):
                    score_all(self.prepared, self.out, self.gold_file)

    def test_scoring_uses_only_frozen_secondary_arm(self) -> None:
        protocol_file = self.out / 'FROZEN.json'
        protocol = json.loads(protocol_file.read_text())
        protocol['arms'] = {'reasoned_pro': ['deepseek-v4-pro', False]}
        protocol_file.write_text(json.dumps(protocol))
        self.bind_targets()
        self.assertEqual(set(score_all(self.prepared, self.out, self.gold_file)), {'reasoned_pro'})


class MalformedResponseTests(unittest.TestCase):
    def test_invalid_choice_and_message_containers_are_missing_predictions(self) -> None:
        request = {'user': '0. Fact.\nHere is the clinical trial:',
                   'criterion_type': 'inclusion', 'expected_indexes': ['0']}
        bodies = [None, [], {}, {'choices': []}, {'choices': None}]
        bodies.extend({'choices': [choice]} for choice in
                      (None, [], 'invalid', {}, {'message': None}, {'message': []}))
        for body in bodies:
            with self.subTest(body=body):
                self.assertEqual(parse(body, request), {})

    def test_six_closed_shapes_preserve_the_same_prediction(self) -> None:
        request = {'user': '0. Fact.\nHere is the clinical trial:',
                   'criterion_type': 'inclusion', 'expected_indexes': ['0']}
        for schema in OBJECT_SCHEMAS:
            with self.subTest(schema=schema):
                value = dict(zip(schema, ['why', [0], 'included']))
                body = {'choices': [{'message': {'content': json.dumps({'0': value})}}]}
                self.assertEqual(parse(body, request), {'0': ('why', [0], 'included')})
                self.assertEqual(parse(body, request, normalize_shapes=False), {})
                value['unexpected'] = 'extra'
                body['choices'][0]['message']['content'] = json.dumps({'0': value})
                self.assertEqual(parse(body, request), {})


class PreparationBoundaryTests(unittest.TestCase):
    def test_existing_preparation_is_preserved_and_changed_values_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / 'frozen.json'
            value = {'patient': 'p', 'criteria': ['one']}
            prepare.preserve_json(destination, value)
            original, timestamp = destination.read_bytes(), destination.stat().st_mtime_ns
            prepare.preserve_json(destination, value)
            self.assertEqual(destination.stat().st_mtime_ns, timestamp)
            with self.assertRaisesRegex(ValueError, 'Frozen preparation differs'):
                prepare.preserve_json(destination, {'patient': 'other'})
            self.assertEqual(destination.read_bytes(), original)

    def test_source_pin_allows_only_trailing_lf_changes(self) -> None:
        acquired = prepare.RUN / 'upstream/TrialGPT.py'
        if not acquired.exists():
            self.skipTest('Pinned upstream fixture has not been acquired')
        source = acquired.read_bytes()
        with tempfile.TemporaryDirectory() as directory:
            candidate = Path(directory) / 'TrialGPT.py'
            for suffix in (b'', b'\n', b'\n\n\n'):
                candidate.write_bytes(source.rstrip(b'\n') + suffix)
                functions, _ = load(candidate)
                self.assertEqual(functions['parse_criteria']('Adult patient'), '0. Adult patient\n')
            candidate.write_bytes(source.replace(b'Adult', b'Other') + b'# tampered\n')
            with patch('upstream.ast.parse') as parser:
                with self.assertRaisesRegex(ValueError, 'pinned official blob'):
                    load(candidate)
                parser.assert_not_called()

    def test_secondary_arm_changes_only_thinking_from_original_pro(self) -> None:
        row = {'system': 'original', 'strict_system': 'strict', 'user': 'same patient'}
        original, reasoned = payload(row, 'original_pro'), payload(row, 'reasoned_pro')
        self.assertEqual(original['thinking'], {'type': 'disabled'})
        self.assertEqual(reasoned['thinking'], {'type': 'enabled'})
        reasoned['thinking'] = original['thinking']
        self.assertEqual(reasoned, original)


if __name__ == '__main__':
    unittest.main()
