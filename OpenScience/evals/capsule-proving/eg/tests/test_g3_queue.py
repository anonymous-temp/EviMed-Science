import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from g3_queue import ScenarioQueue


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.runs = [self.root / 'a', self.root / 'b']
        self.tasks = [('S1', 1), ('S2', 1)]

    def tearDown(self):
        self.tmp.cleanup()

    def queue(self, owner):
        return ScenarioQueue(self.root / 'queue', self.runs, self.runs[owner], self.tasks)

    def result(self, owner, task, status):
        file = self.runs[owner] / 'results' / f'{task[0]}-r{task[1]}.json'
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(json.dumps({'id': task[0], 'rep': task[1], 'status': status}))

    def test_workers_never_claim_the_same_live_run(self):
        a, b = self.queue(0), self.queue(1)
        self.assertEqual(a.claim(), ('S1', 1))
        self.assertEqual(b.claim(), ('S2', 1))
        self.assertIsNone(a.claim())
        self.assertFalse(a.complete())

    def test_completed_failures_and_inconclusive_runs_are_closed(self):
        a = self.queue(0)
        self.result(0, self.tasks[0], 'fail')
        self.result(1, self.tasks[1], 'inconclusive')
        self.assertIsNone(a.claim())
        self.assertTrue(a.complete())

    def test_dead_worker_is_reclaimed_and_recorded(self):
        a = self.queue(0)
        file = self.root / 'queue/claims/S1-r1.json'
        file.write_text(json.dumps({'pid': 999999999, 'token': 'gone', 'owner': str(self.runs[1])}))
        self.assertEqual(a.claim(), self.tasks[0])
        self.assertEqual(len((self.root / 'queue/interruptions.jsonl').read_text().splitlines()), 1)

    def test_duplicate_result_or_changed_cohort_is_rejected(self):
        a = self.queue(0)
        self.result(0, self.tasks[0], 'pass')
        self.result(1, self.tasks[0], 'pass')
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            a.claim()
        with self.assertRaisesRegex(ValueError, 'different fixed cohort'):
            ScenarioQueue(self.root / 'queue', self.runs, self.runs[0], [('S1', 2)])

    def test_foreign_release_cannot_steal_work_and_abandonment_is_recorded(self):
        a, b = self.queue(0), self.queue(1)
        task = a.claim()
        b.release(task)
        self.assertEqual(b.claim(), self.tasks[1])
        a.release(task)
        self.assertEqual(a.claim(), task)
        record = json.loads((self.root / 'queue/interruptions.jsonl').read_text().strip())
        self.assertEqual(record['reason'], 'worker_abandoned_before_result')

    def test_reused_pid_does_not_keep_an_old_claim_alive(self):
        a = self.queue(0)
        file = self.root / 'queue/claims/S1-r1.json'
        file.write_text(json.dumps({'pid': os.getpid(), 'token': 'different-start-time', 'owner': str(self.runs[1])}))
        self.assertEqual(a.claim(), self.tasks[0])
        self.assertEqual(len((self.root / 'queue/interruptions.jsonl').read_text().splitlines()), 1)


if __name__ == '__main__':
    unittest.main()
