"""Offline tests for the development-only calibration diagnostic."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import calibrate
from run import payload, request_digest


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class CalibrationTests(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.base, self.prepared, self.out = (self.root / name for name in ('base', 'prepared', 'out'))
        for path in (self.base, self.prepared, self.out):
            path.mkdir()
        self.rows = [{'id': 'current', 'system': 'original instructions',
                      'strict_system': 'strict instructions', 'user': 'current patient note'},
                     {'id': 'other', 'system': 'other instructions',
                      'strict_system': 'other strict instructions', 'user': 'other patient note'}]
        (self.prepared / 'requests.json').write_text(json.dumps(self.rows))
        labels = [('inclusion', 'included'), ('inclusion', 'not included'),
                  ('exclusion', 'excluded'), ('exclusion', 'not excluded'),
                  ('exclusion', 'not applicable'), ('inclusion', 'not enough information')]
        self.gold = []
        for index, (kind, label) in enumerate(labels):
            for group in ('dev', 'evaluation'):
                self.gold.append({'annotation_id': f'{group}-{index}', 'patient_id': group,
                                  'criterion_type': kind, 'expert_eligibility': label,
                                  'criterion_text': f'{group} criterion {index}',
                                  'note': f'{group} note {index}', 'trial_title': f'{group} trial',
                                  'expert_sentences': '[0]'})
        self.gold_file = self.root / 'gold.json'
        self.gold_file.write_text(json.dumps(self.gold))
        frozen = {'prepared_sha256': sha(self.prepared / 'requests.json'),
                  'dev_patients': ['dev'], 'evaluation_patients': ['evaluation']}
        (self.base / 'FROZEN.json').write_text(json.dumps(frozen))
        targets = {'gold_sha256': sha(self.gold_file),
                   'protocol_sha256': sha(self.base / 'FROZEN.json')}
        (self.base / 'TARGETS.json').write_text(json.dumps(targets))

    def prepare(self) -> tuple:
        with patch('calibrate.time.time', return_value=123):
            return calibrate.prepare(self.base, self.prepared, self.gold_file, self.out)

    def test_examples_are_deterministic_and_development_only(self) -> None:
        _, bodies, protocol = self.prepare()
        examples = protocol['examples']
        self.assertEqual(len(examples), 6)
        self.assertEqual({example['training_patient_id'] for example in examples}, {'dev'})
        self.assertEqual(self.prepare()[2], protocol)
        supplement = bodies['current']['messages'][0]['content'].split('REFERENCE TRAINING EXAMPLES:\n')[1]
        self.assertNotIn('evaluation', supplement)
        self.assertEqual(json.loads(supplement), examples)
        self.assertEqual(bodies['other']['messages'][0]['content'].split('REFERENCE TRAINING EXAMPLES:\n')[1], supplement)
        truth = {row['annotation_id']: row for row in self.gold}
        for example in examples:
            row = truth[example['annotation_id']]
            self.assertEqual(example['patient_note'], row['note'])
            self.assertEqual(example['criterion'], row['criterion_text'])
            self.assertEqual(example['answer'][1:], [[0], row['expert_eligibility']])

    def test_payload_keeps_original_flash_settings_and_binds_exact_digest(self) -> None:
        _, bodies, protocol = self.prepare()
        original = payload(self.rows[0], 'original_flash')
        calibrated = bodies['current']
        self.assertTrue(calibrated['messages'][0]['content'].startswith(original['messages'][0]['content']))
        comparable = json.loads(json.dumps(calibrated))
        comparable['messages'][0]['content'] = original['messages'][0]['content']
        self.assertEqual(comparable, original)
        self.assertEqual(protocol['requests']['current'], request_digest('deepseek', calibrated))
        targets = json.loads((self.out / 'TARGETS.json').read_text())
        self.assertEqual(targets['protocol_sha256'], sha(self.out / 'FROZEN.json'))
        self.assertEqual(targets['gold_sha256'], sha(self.gold_file))

    def test_changed_input_bytes_are_rejected(self) -> None:
        (self.prepared / 'requests.json').write_text('[]')
        with self.assertRaisesRegex(ValueError, 'Base inputs differ'):
            self.prepare()

    def test_changed_gold_bytes_are_rejected(self) -> None:
        self.gold[0]['expert_eligibility'] = 'not included'
        self.gold_file.write_text(json.dumps(self.gold))
        with self.assertRaisesRegex(ValueError, 'Target bytes differ'):
            self.prepare()

    def test_changed_base_protocol_bytes_are_rejected(self) -> None:
        frozen = self.base / 'FROZEN.json'
        frozen.write_text(frozen.read_text() + '\n')
        with self.assertRaisesRegex(ValueError, 'Base target binding differs'):
            self.prepare()


if __name__ == '__main__':
    unittest.main()
