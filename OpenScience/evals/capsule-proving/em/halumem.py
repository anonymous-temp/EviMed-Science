#!/usr/bin/env python3
"""Resume just the concise answer variant on the original eight-user memory."""
import json
import pathlib
import subprocess
import sys

repo = pathlib.Path('/srv/evimed/wt/em/OpenScience')
runs = pathlib.Path('/srv/evimed/runs')
status = runs / 'EM-STATUS'
for arm in (sys.argv[1:] or ['product', 'keyword', 'no-memory']):
    out = runs / f'e0-halumem-dev-{arm}-1'
    facts = json.loads((out / 'run.json').read_text())
    args = ['node', 'evals/capsule-proving/run/run.mjs', '--set', 'halumem', '--split', 'dev',
            '--data', '/srv/evimed/data/memdata-data', '--out', str(out), '--arm', arm,
            '--only', facts['options']['only'], '--concurrency', '3', '--database-pool-max', '1',
            '--deepseek-key-file', '/srv/evimed/secrets/deepseek.api-key',
            '--plugin-tgz', '/srv/evimed/cache/dsh-memory-plugin-0.5.31.tgz',
            '--answers-only', '--variants-only', '--answer-variant', 'concise:answerStyle=concise']
    if arm == 'product':
        args += ['--engine-url', ','.join(facts['engine']['urls']), '--engine-key-file', '/srv/evimed/ovlab/root.key',
                 '--database-url-file', '/srv/evimed/ovlab/database.url']
    subprocess.run(args, cwd=repo, check=True)
    subprocess.run(['node', 'evals/capsule-proving/run/score.mjs', '--run', str(out),
                    '--data', '/srv/evimed/data/memdata-data', '--variant', 'concise',
                    '--judge-key-file', '/srv/evimed/secrets/dashscope.api-key'], cwd=repo, check=True)
    subprocess.run(['node', 'evals/capsule-proving/run/ledger.mjs', 'append', '--run', str(out), '--variant', 'concise',
                    '--ledger', '/srv/evimed/results/ledger.jsonl'], cwd=repo, check=True)
    with status.open('a') as stream:
        stream.write(f'halumem concise {arm} answers and ledger complete\n')
