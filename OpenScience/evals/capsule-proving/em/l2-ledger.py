#!/usr/bin/env python3
"""Append missing L2 rows without running or rejudging any product-path turn."""
import json
import pathlib
import subprocess

repo = pathlib.Path('/srv/evimed/wt/em/OpenScience')
for repeat in [2, 3]:
    run = pathlib.Path(f'/srv/evimed/runs/lx-l2-evolve-{repeat}')
    source = json.loads((run / 'ledger-rows.json').read_text())
    for row in source:
        assert pathlib.Path(row['rawPath']).resolve() == run
        row['runId'] = run.name
        row.pop('ledgerId', None)
        row['notes'] = row.get('notes', '') + '; EM backfill: existing verdict, output-directory run id corrected; no replay; runtime-lock isolation was not recorded as enabled in this historical run'
    out = run / 'ledger-rows.em.json'
    out.write_text(json.dumps(source, ensure_ascii=False, indent=2) + '\n')
    subprocess.run(['node', 'evals/capsule-proving/run/ledger.mjs', 'add', '--json', str(out),
                    '--ledger', '/srv/evimed/results/ledger.jsonl'], cwd=repo, check=True)
