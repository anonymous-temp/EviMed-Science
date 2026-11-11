from datetime import datetime, timezone, timedelta
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from slot_capacity import can_admit, process_token


class CapacityTests(unittest.TestCase):
    def test_free_capacity_can_be_admitted(self):
        self.assertTrue(can_admit({'other'}, {'other'}, 'own'))

    def test_admitted_campaign_can_restart_its_cold_slot_at_the_limit(self):
        self.assertTrue(can_admit({'other'}, {'other', 'own'}, 'own', campaign_owned=True))

    def test_foreign_reservation_cannot_be_reused(self):
        self.assertFalse(can_admit({'other'}, {'other', 'own'}, 'own'))

    def test_active_own_slot_cannot_start_a_second_batch(self):
        self.assertFalse(can_admit({'own'}, {'own'}, 'own', campaign_owned=True))

    def test_startup_batch_claim_prevents_duplicate_admission(self):
        self.assertFalse(can_admit(set(), {'own'}, 'own', campaign_owned=True, batch_claimed=True))

    def test_campaign_ownership_never_raises_the_global_limit(self):
        self.assertFalse(can_admit({'a', 'b'}, {'a', 'b', 'own'}, 'own', campaign_owned=True))


class HolderTests(unittest.TestCase):
    def run_holder(self, token, seconds):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            deadline = datetime.now(timezone.utc) + timedelta(seconds=seconds)
            child = subprocess.Popen([sys.executable, str(Path(__file__).resolve().parents[1] / 'hold_slot.py'),
                                      '--campaign-pid', str(os.getpid()), '--campaign-token', token, '--deadline', deadline.isoformat(), '--locks-dir', str(root)])
            file = root / f'eg-reservation-{child.pid}.json'
            temporary = file.with_suffix('.json.tmp')
            temporary.write_text(json.dumps({'pid': child.pid, 'slot': 'test-slot', 'campaignPid': os.getpid(), 'campaignToken': token}))
            temporary.replace(file)
            try:
                result = child.wait(timeout=5)
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait()
            return result, file.exists()

    def test_deadline_releases_a_live_campaigns_slot(self):
        self.assertEqual(self.run_holder(process_token(os.getpid()), 0.3), (0, False))

    def test_changed_owner_process_identity_releases_the_slot(self):
        self.assertEqual(self.run_holder('wrong-process-start-time', 30), (0, False))


if __name__ == '__main__':
    unittest.main()
