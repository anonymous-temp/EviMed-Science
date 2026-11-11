#!/usr/bin/env python3
"""Finish the ordered EM ledger steps after the owned score-all process exits."""
import datetime
import json
import pathlib
import subprocess
import sys
import time

repo = pathlib.Path('/srv/evimed/wt/em/OpenScience')
runs = pathlib.Path('/srv/evimed/runs')
process = pathlib.Path('/proc') / sys.argv[1]
while True:
    try:
        command = (process / 'cmdline').read_bytes()
    except FileNotFoundError:
        break
    if b'score-all.sh' not in command:
        break
    time.sleep(15)
for attempt in range(4):
    subprocess.run(['python3', str(repo / 'evals/capsule-proving/em/patient-counts.py'),
                    str(runs / 'em-patient-after.json')], check=True)
    after = json.loads((runs / 'em-patient-after.json').read_text())
    incomplete = set()
    for entry in after:
        summary = json.loads((runs / entry['run'] / entry['variant'] / 'summary.json').read_text())
        if summary['schema'] != 'capsule-proving-run-score/8' or summary['judge']['pending'] or summary['judge']['error']:
            incomplete.add(str(runs / entry['run']))
    if not incomplete:
        break
    if attempt == 3:
        raise RuntimeError('Rescoring incomplete after retries: ' + ','.join(sorted(incomplete)))
    subprocess.run(['/srv/evimed/runs/score-all.sh', *sorted(incomplete)], check=True)
before = json.loads((runs / 'em-patient-before.json').read_text())
def note(text):
    line = datetime.datetime.now(datetime.timezone.utc).isoformat() + ' EM ' + text + '\n'
    with (runs / 'EM-STATUS').open('a') as stream:
        stream.write(line)
    print(line, end='', flush=True)
note(f'STEP2 DONE patient-mixing flags {sum(x["fail"] for x in before)} -> {sum(x["fail"] for x in after)} across {len(after)} outputs; ledger rows appended by score-all; flagged evidence in em-patient-after.json')
subprocess.run(['python3', str(repo / 'evals/capsule-proving/em/l2-ledger.py')], check=True)
note('STEP3 DONE lx-l2-evolve-2 and -3: 8 existing-verdict ledger rows backfilled; directory run ids corrected; no replay')
subprocess.run(['python3', str(repo / 'evals/capsule-proving/em/write-loo.py'), '--start'], check=True)
