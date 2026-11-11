#!/usr/bin/env python3
"""Fresh red-line ingests, matched feature ablations, and a lane-local CNY cap.

Uses two EM-owned engines; never reconfigures another lane's engine. The six
synthetic ingests retain every session of every planted-instruction dev user.
Usage: python3 write-loo.py [--start]
"""
import datetime
import json
import os
import pathlib
import signal
import subprocess
import sys
import time

REPO = pathlib.Path('/srv/evimed/wt/em/OpenScience')
RUNS = pathlib.Path('/srv/evimed/runs')
DATA = pathlib.Path('/srv/evimed/data/memdata-data')
STATUS = RUNS / 'EM-STATUS'
CAP = 150
# Pinned platform reference rates, CNY / million tokens; cache usage is observed.
DEEPSEEK = (2, .04, 8)
QWEN = (12, 1.5, 36)

def note(message):
    with STATUS.open('a') as stream:
        stream.write(datetime.datetime.now(datetime.timezone.utc).isoformat() + ' EM ' + message + '\n')
    print(message, flush=True)

def jsonl(file):
    if not file.exists():
        return []
    return [json.loads(line) for line in file.read_text().splitlines() if line.strip()]

def usage_cost(usage, prices, native=False):
    prompt = usage.get('prompt_tokens' if native else 'promptTokens', 0)
    cached = usage.get('prompt_cache_hit_tokens' if native else 'cachedTokens',
                       usage.get('prompt_tokens_details', {}).get('cached_tokens', 0))
    output = usage.get('completion_tokens' if native else 'completionTokens', 0)
    return (max(0, prompt - cached) * prices[0] + cached * prices[1] + output * prices[2]) / 1e6

def spend():
    total = 0
    requests = set()
    for run in RUNS.glob('em-loo-*'):
        for file in (run / 'cases').glob('*/*.jsonl'):
            if file.name != 'ingest.jsonl' and not file.name.startswith('answers'):
                continue
            for row in jsonl(file):
                total += usage_cost(row.get('usage', {}), DEEPSEEK)
        for file in run.glob('scores*/judge-results.jsonl'):
            for row in jsonl(file):
                request = row.get('requestId')
                if request and request not in requests:
                    requests.add(request)
                    total += usage_cost(row.get('usage') or {}, QWEN, native=True)
    return total

def run(args, log):
    while True:
        available = int(next(line.split()[1] for line in pathlib.Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:')))
        if os.getloadavg()[0] <= 16 and available >= 1_000_000:
            break
        note(f'WAIT host pressure: load={os.getloadavg()[0]:.1f}, available KiB={available}')
        time.sleep(60)
    if spend() >= CAP - 5:
        raise RuntimeError('lane cap reserve reached before new work')
    with log.open('a') as stream:
        child = subprocess.Popen(args, cwd=REPO, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
        while child.poll() is None:
            # Maximum two concurrent questions/ingests per runner plus up to two
            # judge requests; reserve CNY 5 for work not yet settled to disk.
            used = spend()
            (RUNS / 'EM-BUDGET.json').write_text(json.dumps(dict(capCny=CAP, settledCostCny=used, reserveCny=5)) + '\n')
            if used >= CAP - 5:
                os.killpg(child.pid, signal.SIGTERM)
                child.wait()
                raise RuntimeError('lane CNY 150 cap: own child stopped with CNY 5 reserve')
            time.sleep(15)
        if child.returncode:
            raise RuntimeError(f'command exited {child.returncode}; see {log}')

def main():
    users = []
    for directory in sorted((DATA / 'dev').iterdir()):
        gold = directory / 'gold.json'
        if gold.exists() and any(q.get('category') == 'injection' for q in json.loads(gold.read_text()).get('questions', [])):
            users.append(directory.name)
    comparisons = [
        ('med-m10', 'no-safety', 'memorySafetyNotesEnabled', 19361),
        ('g6', 'no-redaction', 'memoryHistorySecretRedactionEnabled', 19360),
        ('synthetic-users', 'no-pasted-check', 'memoryPastedInstructionCheckEnabled', 19360),
    ]
    manifest = dict(scope='matched-set leave-one-out', syntheticUsers=users, capCny=CAP, rates=dict(deepseek=DEEPSEEK, qwen=QWEN),
                    engines=dict(candidate='ovem1:19360', noSafety='ovem2:19361'),
                    originalBalance=(RUNS / 'BUDGET-LAST').read_text().strip(), comparisons=comparisons)
    manifest_file = RUNS / 'em-loo-manifest.json'
    if not manifest_file.exists():
        manifest['startedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        manifest_file.write_text(json.dumps(manifest, indent=2) + '\n')
    if '--start' not in sys.argv:
        print(json.dumps(manifest, indent=2)); return
    for dataset, variant, feature, port in comparisons:
        for repeat in [1, 2, 3]:
            for config, engine in [('baseline', 19360), (variant, port)]:
                name = f'em-loo-{dataset}-{config}-{repeat}'
                out = RUNS / name
                if (out / 'EM-COMPLETE').exists():
                    continue
                out.mkdir(exist_ok=True)
                template = '/srv/evimed/wt/em/templates/candidate' if engine == 19360 else str(REPO / 'deploy/web/openviking/memory-templates')
                args = ['node', 'evals/capsule-proving/run/run.mjs', '--set', dataset, '--split', 'dev', '--arm', 'product',
                        '--data', str(DATA), '--out', str(out), '--engine-url', f'http://127.0.0.1:{engine}',
                        '--engine-key-file', '/srv/evimed/ovlab/root.key', '--database-url-file', '/srv/evimed/ovlab/database.url',
                        '--deepseek-key-file', '/srv/evimed/secrets/deepseek.api-key', '--plugin-tgz', '/srv/evimed/cache/dsh-memory-plugin-0.5.31.tgz',
                        '--templates-dir', template, '--concurrency', '2', '--database-pool-max', '1', '--extraction-timeout-ms', '900000',
                        '--label', 'EM matched red-line write-side ablation; round-3 configuration; fresh namespace']
                for key in ['memorySearchHintEnabled', 'memoryOpeningIndexEnabled', 'memorySafetyNotesEnabled',
                            'memoryHistorySecretRedactionEnabled', 'memoryPastedInstructionCheckEnabled', 'memoryHistoryRetrievalV2Enabled']:
                    args += ['--config', key + '=' + ('false' if config != 'baseline' and key == feature else 'true')]
                if dataset == 'synthetic-users':
                    args += ['--only', ','.join(users), '--question-category', 'injection']
                note('START ' + name)
                run(args, out / 'run.log')
                run(['node', 'evals/capsule-proving/run/score.mjs', '--run', str(out), '--data', str(DATA),
                     '--judge-key-file', '/srv/evimed/secrets/dashscope.api-key', '--judge-concurrency', '2'], out / 'score.log')
                run(['node', 'evals/capsule-proving/run/ledger.mjs', 'append', '--run', str(out),
                     '--ledger', '/srv/evimed/results/ledger.jsonl'], out / 'ledger.log')
                (out / 'EM-COMPLETE').write_text('answers, scores and ledger complete\n')
                note('DONE ' + name + f' settled CNY {spend():.2f}')
    note('STEP4 DONE all 18 matched-set fresh ingests scored and ledgered')

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        note('STOP ' + str(error))
        raise
