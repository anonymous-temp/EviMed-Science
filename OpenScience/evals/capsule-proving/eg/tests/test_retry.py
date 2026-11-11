"""Exercise the real shell retry body without infrastructure or model calls."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest


class RetryTests(unittest.TestCase):
    def run_body(self, mode):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'out').mkdir()
            (root / 'out/provenance.json').write_text(json.dumps({'args': {'dataDir': str(root / 'data')}}))
            source = (Path(__file__).resolve().parents[1] / 'lab.sh').read_text().split('progress_count() {', 1)[1]
            body = 'progress_count() {' + source
            prelude = f'''set -euo pipefail
suite=g1
run_out={shlex.quote(str(root / 'out'))}
TREE=/unused
PORT=1
PG_PORT=2
export FAKE_ROOT={shlex.quote(str(root))}
export RETRY_MODE={shlex.quote(mode)}
sleep() {{ :; }}
nice() {{
  local count=0
  [[ ! -f "$FAKE_ROOT/count" ]] || read -r count <"$FAKE_ROOT/count"
  count=$((count+1)); echo "$count" >"$FAKE_ROOT/count"
  if [[ "$RETRY_MODE" == stop ]]; then return 3; fi
  if [[ "$RETRY_MODE" == progress && "$count" == 3 ]]; then
    mkdir -p "$FAKE_ROOT/data/users/u/projects/default/.openscience"
    printf '%s\\n' '{{"id":"accepted-human-input"}}' >"$FAKE_ROOT/data/users/u/projects/default/.openscience/runs.jsonl"
  fi
  if [[ "$RETRY_MODE" == progress && "$count" == 4 ]]; then return 0; fi
  return 1
}}
'''
            result = subprocess.run(['bash'], input=prelude + body, text=True, capture_output=True,
                                    env={**os.environ, 'BASH_ENV': '/dev/null'}, timeout=10)
            return result, int((root / 'count').read_text())

    def test_late_transport_failure_gets_a_new_retry_budget_after_work_progressed(self):
        result, calls = self.run_body('progress')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, 4)
        self.assertIn('noProgressFailures=1 rc=1 progress=1', result.stdout)

    def test_three_failures_without_new_work_release_the_slot(self):
        result, calls = self.run_body('stuck')
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(calls, 3)

    def test_budget_stop_is_never_retried(self):
        result, calls = self.run_body('stop')
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertEqual(calls, 1)


if __name__ == '__main__':
    unittest.main()
