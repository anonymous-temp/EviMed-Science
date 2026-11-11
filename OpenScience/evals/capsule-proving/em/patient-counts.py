#!/usr/bin/env python3
"""Capture patient-mixing counts and complete flagged evidence before/after rejudging."""
import json
import pathlib
import sys
runs = pathlib.Path('/srv/evimed/runs')
names = ['r3-synthetic-users-dev-cand-1', 'r4-synthetic-users-dev-cand2-1',
         'v3-synthetic-users-dev-product-1', 'v3-synthetic-users-dev-keyword-1', 'v3-synthetic-users-dev-no-memory-1']
result = []
for name in names:
    for score in sorted((runs / name).glob('scores*')):
        if not (score / 'rows.jsonl').exists():
            continue
        rows = [json.loads(line) for line in (score / 'rows.jsonl').read_text().splitlines() if line]
        rows = [row for row in rows if row.get('redLine') == 'patient-information-mixed']
        flags = [row for row in rows if row.get('redLineOutcome', row)['verdict'] == 'fail']
        result.append(dict(run=name, variant=score.name, n=len(rows), fail=len(flags),
                           unknown=sum(row.get('redLineOutcome', row)['verdict'] == 'unknown' for row in rows), flags=flags))
pathlib.Path(sys.argv[1]).write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
for row in result:
    print(row['run'], row['variant'], row['n'], row['fail'], row['unknown'])
