#!/usr/bin/env python3
"""Resumable, one-slot public benchmark driver. Verifiers and task images stay upstream.

SkillsBench: pinned BenchFlow CLI + Pi ACP. SkillLearnBench: pinned core.eval_runner
+ a Pi CLI registry entry. Both are MODEL + METHODS, NOT THE PRODUCT.
"""
import argparse
import base64
import contextlib
import datetime
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time
import tomllib
import yaml

HERE = pathlib.Path(__file__).resolve().parent
ROOT = pathlib.Path(os.environ.get('SB_ROOT', '/srv/evimed/sb'))
DATA = pathlib.Path('/srv/evimed/data/memdata-data/public')
RUNS = pathlib.Path('/srv/evimed/runs')
UPSTREAM = ROOT / 'upstream'
GATEWAY = 'http://172.17.0.1:19412/v1'


def trial_gateway(task, arm):
    context = {'runId': f'{task["bench"]}-{arm}-1', 'task': task['id'], 'arm': arm}
    token = base64.urlsafe_b64encode(json.dumps(context).encode()).decode().rstrip('=')
    return f'{GATEWAY}/trial/{token}'


def put(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(json.dumps(value, indent=2, default=str) + '\n')
    temp.replace(path)


def note(text):
    line = f'{datetime.datetime.now(datetime.timezone.utc).isoformat()} SB {text}'
    print(line, flush=True)
    with (RUNS / 'sb-STATUS').open('a') as f:
        f.write(line + '\n')


def check_verifier(task):
    verifier = pathlib.Path(task['path']) / ('verifier' if task['bench'] == 'sb' else 'tests')
    hashes = {p.relative_to(verifier).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sorted(verifier.rglob('*')) if p.is_file() and '__pycache__' not in p.parts}
    if hashes != task['verifierSha256']:
        raise ValueError(f'Official verifier changed: {task["id"]}')


def usage(run_id, task_id):
    file = ROOT / 'usage.jsonl'
    return [json.loads(s) for s in file.read_text().splitlines()
            if (j := json.loads(s)).get('runId') == run_id and j.get('task') == task_id] if file.exists() else []


def check_budget(start, deadline):
    if shutil.disk_usage(ROOT).free < 3 * 1024**3:
        raise RuntimeError('Shared disk below 3 GiB free: stop before creating another task container')
    balance = float((RUNS / 'BUDGET-LAST').read_text().split('balance ')[1].split()[0])
    if balance < 400:
        raise RuntimeError('Balance below CNY 400: do not start a new batch')
    # Other lanes share the balance; apply this lane's cap to its own usage rather than their spending.
    reference_file = ROOT / 'usage.jsonl'
    reference = sum(json.loads(s).get('costCny', 0) for s in reference_file.read_text().splitlines()) if reference_file.exists() else 0
    practice_file = ROOT / 'practice/usage.json'
    practice = json.loads(practice_file.read_text()).get('account', {}) if practice_file.exists() else {}
    if reference + practice.get('actualCost', 0) + practice.get('reservedCost', 0) >= 340:
        raise RuntimeError('Combined lane usage reached CNY 340; CNY 10 reserved for in-flight work')
    if time.time() > deadline:
        raise RuntimeError('Lane wall-clock allocation reached')


def resource_admission_issue(task):
    if task['bench'] != 'slb':
        return None
    directory = pathlib.Path(task['path'])
    script = (directory / 'tests/test.sh').read_text()
    config = tomllib.loads((directory / 'task.toml').read_text())
    declared = config.get('environment', {}).get('storage_mb', 0) * 1024**2
    available = shutil.disk_usage(ROOT).free
    policy = ROOT / 'resource-policy.json'
    if policy.exists():
        available = min(available, json.loads(policy.read_text())['storageBudgetBytes'])
    if re.search(r'--with\s+(?:torch|deepspeed)==', script) and available < declared:
        return f'Capacity unavailable before model dispatch: pinned verifier ML bootstrap, declared storage {declared} bytes, shared free {available} bytes. Official verifier is unchanged and unrun.'
    return None


def skills_for(task, arm):
    if arm == 'none':
        return None
    if arm == 'learned':
        if not (ROOT / 'practice/complete.json').exists():
            raise RuntimeError('Product practice must finish before the learned arm')
        return ROOT / 'learned'
    return pathlib.Path(task['path']) / 'environment/skills' if task['bench'] == 'sb' else DATA / 'skilllearnbench/skills/human_authored' / task['family']


def sb_oracle(task):
    out = RUNS / 'sb-oracle-1'
    record = out / 'records' / (task['id'] + '.json')
    if record.exists():
        return json.loads(record.read_text())
    out.mkdir(exist_ok=True)
    jobs = out / 'trials' / task['id']
    cmd = [sys.executable, str(HERE / 'bench_entry.py'), 'eval', 'run', '--tasks-dir', task['path'],
           '--agent', 'oracle', '--sandbox', 'docker', '--sandbox-user', 'agent',
           '--concurrency', '1', '--usage-tracking', 'off', '--jobs-dir', str(jobs)]
    note(f'oracle start {task["id"]}')
    with (out / (task['id'] + '.log')).open('a') as log:
        p = subprocess.run(cmd, stdout=log, stderr=log, timeout=2400)
    files = sorted(jobs.glob('*/*/result.json'))
    result = json.loads(files[-1].read_text()) if files else {'error': 'No oracle result'}
    rewards = result.get('rewards')
    score = next(iter(rewards.values()), 0) if isinstance(rewards, dict) else rewards
    row = {'passed': score == 1 and not result.get('verifier_error'), 'official': result, 'exit': p.returncode}
    put(record, row)
    note(f'oracle done {task["id"]} passed={row["passed"]}')
    return row


def sb_trial(task, arm, out):
    jobs = out / 'trials' / task['id']
    cmd = [sys.executable, str(HERE / 'bench_entry.py'), 'eval', 'run', '--tasks-dir', task['path'],
           '--agent', 'pi-acp', '--model', 'deepseek/deepseek-flash', '--reasoning-effort', 'high',
           '--sandbox', 'docker', '--sandbox-user', 'agent', '--concurrency', '1',
           '--usage-tracking', 'off', '--jobs-dir', str(jobs)]
    cmd += ['--agent-env', 'BENCHFLOW_PROVIDER_MODELS=' + json.dumps([
        {'id': 'deepseek-flash', 'reasoning': True, 'contextWindow': 1048576, 'maxTokens': 32768}])]
    cmd += ['--agent-env', 'PI_TELEMETRY=0']
    source = skills_for(task, arm)
    has_skills = source and any(source.rglob('SKILL.md'))
    cmd += ['--skill-mode', 'with-skill' if has_skills else 'no-skill']
    if has_skills:
        cmd += ['--skills-dir', str(source)]
    env = {**os.environ, 'DEEPSEEK_API_KEY': 'lab-proxy', 'DEEPSEEK_BASE_URL': trial_gateway(task, arm),
           'PI_TELEMETRY': '0'}
    with (out / f'{task["id"]}.log').open('a') as log:
        result = subprocess.run(cmd, env=env, stdout=log, stderr=log, timeout=sb_watchdog(task))
    files = sorted(jobs.glob('*/*/result.json'))
    if not files:
        raise RuntimeError(f'BenchFlow produced no result (exit {result.returncode}); see task log')
    official = json.loads(files[-1].read_text())
    return {'official': official, 'officialResultPath': str(files[-1]), 'referenceExit': result.returncode,
            'trialPath': str(files[-1].parent),
            'mounted': sorted(p.parent.name for p in source.rglob('SKILL.md')) if has_skills else []}


def sb_watchdog(task):
    # This wrapper must outlive the official agent and verifier, plus build/install time.
    config = yaml.safe_load((pathlib.Path(task['path']) / 'task.md').read_text().split('---', 2)[1])
    return float(config.get('agent', {}).get('timeout_sec', 1800)) + float(config.get('verifier', {}).get('timeout_sec', 600)) + 1200


def slb_trial(task, arm, out):
    sys.path.insert(0, str(UPSTREAM / 'slb'))
    from agents import AGENTS
    from core import eval_runner
    from benchflow.agents.registry import AGENTS as BENCH_AGENTS
    install = BENCH_AGENTS['pi-acp'].install_cmd.replace('@mariozechner/pi-coding-agent@latest', '@earendil-works/pi-coding-agent@1.5.2').replace('pi-acp@latest', 'pi-acp@0.0.34')
    import base64
    encoded = base64.b64encode((HERE / 'pi_solve.py').read_bytes()).decode()
    AGENTS['sb-pi'] = {'name': 'Reference Pi (DeepSeek)', 'env': ['SB_GATEWAY_URL'],
        'install': install + f' && echo {encoded} | base64 -d > /opt/benchflow/pi-solve.py',
        'run': 'timeout --signal=TERM --kill-after=10s 1700s python3 /opt/benchflow/pi-solve.py', 'trajectory_tee': '/logs/agent/pi.jsonl',
        'default_model': 'deepseek-flash'}
    os.environ['SB_GATEWAY_URL'] = trial_gateway(task, arm)
    os.environ['PI_TELEMETRY'] = '0'
    source = skills_for(task, arm)
    # An empty learned library is a measured outcome, not a reason to substitute human skills.
    has_skills = source and any(source.rglob('SKILL.md'))
    original_run = eval_runner.subprocess.run
    resource_facts = None
    def limited_run(command, *positional, **kwargs):
        nonlocal resource_facts
        container_start = isinstance(command, (list, tuple)) and list(command[:2]) == ['docker', 'run']
        if container_start:
            command = list(command[:2]) + ['--memory', '2g', '--memory-swap', '3g', '--cpus', '1'] + list(command[2:])
        result = original_run(command, *positional, **kwargs)
        if container_start and result.returncode == 0:
            try:
                observed = original_run(['docker', 'inspect', '--format',
                    '{{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{.HostConfig.NanoCpus}}', result.stdout.strip()],
                    capture_output=True, text=True, timeout=15)
                resource_facts = {'exit': observed.returncode, 'memoryMemorySwapNanoCpus': observed.stdout.strip()}
            except (subprocess.TimeoutExpired, OSError) as error:
                resource_facts = {'error': type(error).__name__}
        if isinstance(command, (list, tuple)) and list(command[:2]) == ['docker', 'exec'] and command[-1] == '/tests/test.sh':
            (out / f'{task["id"]}.verifier-stdout.txt').write_text(result.stdout or '')
            (out / f'{task["id"]}.verifier-stderr.txt').write_text(result.stderr or '')
        return result
    # Resource boundary only, applied equally to all arms. The pinned runner and verifier files remain unchanged.
    eval_runner.subprocess.run = limited_run
    try:
        with (out / f'{task["id"]}.log').open('a') as log, contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
            code, official = eval_runner.run_task(f'{task["family"]}/{task["id"]}',
                task_root=DATA / 'skilllearnbench/tasks', agent_id='sb-pi', model='deepseek-flash',
                skill_config=arm if has_skills else 'no_skill', skill_source_dir=source if has_skills else None,
                trial_id=f'sb-{arm}-1', trials_dir=out / 'trials', max_steps=100)
    finally:
        eval_runner.subprocess.run = original_run
        # These exact tags belong to this lane. The upstream runner keeps them after
        # deleting its container; retaining three arms' images exhausted the shared disk.
        tag = f'evaluation_{task["family"]}-{task["id"]}_{arm if has_skills else "no_skill"}:sb-{arm}-1'
        try:
            cleaned = original_run(['docker', 'image', 'rm', tag], capture_output=True, text=True, timeout=120)
            image_cleanup = {'tag': tag, 'exit': cleaned.returncode, 'error': cleaned.stderr[:500]}
        except (OSError, subprocess.TimeoutExpired) as error:
            image_cleanup = {'tag': tag, 'error': type(error).__name__}
    return {'official': official, 'referenceExit': code,
            'imageCleanup': image_cleanup,
            'resourceFacts': resource_facts,
            'verifierLogs': [str(out / f'{task["id"]}.verifier-stdout.txt'), str(out / f'{task["id"]}.verifier-stderr.txt')],
            'trialPath': str(eval_runner._trial_path(f'{task["family"]}/{task["id"]}', arm if has_skills else 'no_skill', f'sb-{arm}-1', trials_dir=out / 'trials')),
            'mounted': sorted(p.parent.name for p in source.rglob('SKILL.md')) if has_skills else []}


def active_tasks(manifest, bench, per_family=1):
    tasks = [t for t in manifest['tasks'] if t['bench'] == bench]
    if bench == 'slb' and per_family:
        counts, selected = {}, []
        for task in tasks:
            count = counts.get(task['family'], 0)
            if count < per_family:
                selected.append(task)
            counts[task['family']] = count + 1
        return selected
    return tasks


def infrastructure_record(record):
    official = record.get('official', {})
    return bool(record.get('infraError') or official.get('verifier_error') or
                (official.get('error') and official.get('verifier_exit') is None and official.get('rewards') is None))


def run(args):
    manifest_file = ROOT / 'manifest.json'
    manifest = json.loads(manifest_file.read_text())
    digest = hashlib.sha256(manifest_file.read_bytes()).hexdigest()
    batch = ROOT / 'batch.json'
    if not batch.exists():
        balance = float((RUNS / 'BUDGET-LAST').read_text().split('balance ')[1].split()[0])
        put(batch, {'startedAt': time.time(), 'balanceBefore': balance, 'deadline': time.time() + 9.5 * 3600})
    batch_info = json.loads(batch.read_text())
    tasks = active_tasks(manifest, args.bench, args.per_family)
    planned_ids = [t['id'] for t in tasks]
    if args.task:
        tasks = [t for t in tasks if t['id'] == args.task]
        if not tasks:
            raise ValueError('Unknown task')
    out = RUNS / f'{args.bench}-{args.arm}-1'
    config = {'bench': args.bench, 'arm': args.arm, 'manifestSha256': digest,
              'pins': manifest['pins'], 'adapter': 'model + our methods, not the product',
              'model': 'deepseek-flash', 'thinking': 'high', 'benchflow': '0.6.3',
              'pi': '@earendil-works/pi-coding-agent@1.5.2', 'pi-acp': '0.0.34', 'tasks': planned_ids,
              **({'perFamily': args.per_family, 'resources': {'cpus': 1, 'memoryBytes': 2147483648, 'memoryAndSwapBytes': 3221225472, 'agentTimeoutSeconds': 1700},
                  'capacityAmendment': 'Before any SkillLearnBench scoring: execute the first frozen held-out variant per family; second variants remain unused reserves. Default is one after the 6.3-minute smoke and shared lab load above 50.'} if args.bench == 'slb' else {})}
    if (out / 'run.json').exists() and json.loads((out / 'run.json').read_text()) != config:
        raise ValueError('Resume config mismatch')
    put(out / 'run.json', config)
    for task in tasks:
        record = out / 'records' / f'{task["id"]}.json'
        if record.exists():
            previous = json.loads(record.read_text())
            if not args.retry_infra or not infrastructure_record(previous):
                continue
            # Keep all previous trial artifacts; a new jobs directory prevents upstream resume from adopting stale errors.
            attempts = out / 'attempts'
            attempts.mkdir(exist_ok=True)
            trials = out / 'trials' / task['id'] if task['bench'] == 'sb' else pathlib.Path(previous.get('trialPath', out / 'trials/missing'))
            if trials.exists() and trials.resolve().is_relative_to((out / 'trials').resolve()):
                archived = attempts / f'{task["id"]}-trials-{time.time_ns()}'
                trials.rename(archived)
                previous['archivedTrialPath'] = str(archived)
            previous['archivedVerifierLogs'] = []
            for log in out.glob(f'{task["id"]}.verifier-*.txt'):
                archived_log = attempts / f'{log.name}-{time.time_ns()}'
                log.rename(archived_log)
                previous['archivedVerifierLogs'].append(str(archived_log))
            put(attempts / f'{task["id"]}-{time.time_ns()}.json', previous)
            oracle_file = RUNS / f'sb-oracle-1/records/{task["id"]}.json'
            if task['bench'] == 'sb' and oracle_file.exists() and not json.loads(oracle_file.read_text())['passed']:
                oracle_file.rename(attempts / f'{task["id"]}-oracle-{time.time_ns()}.json')
                oracle_trials = RUNS / 'sb-oracle-1/trials' / task['id']
                if oracle_trials.exists():
                    oracle_trials.rename(attempts / f'{task["id"]}-oracle-trials-{time.time_ns()}')
        check_budget(batch_info['balanceBefore'], batch_info['deadline'])
        check_verifier(task)
        put(ROOT / 'current.json', {'runId': out.name, 'task': task['id'], 'arm': args.arm})
        note(f'{out.name} start {task["id"]}')
        t0 = time.time()
        try:
            if issue := resource_admission_issue(task):
                raise RuntimeError(issue)
            if task['bench'] == 'sb':
                oracle = sb_oracle(task)
                if not oracle['passed']:
                    raise RuntimeError('Official oracle failed; task infrastructure is not validated (see sb-oracle-1)')
            result = sb_trial(task, args.arm, out) if args.bench == 'sb' else slb_trial(task, args.arm, out)
        except Exception as error:
            result = {'infraError': f'{type(error).__name__}: {error}', 'mounted': []}
        check_verifier(task)
        put(record, {'task': task, 'arm': args.arm, 'wallSeconds': time.time() - t0, **result,
                     'requests': usage(out.name, task['id'])})
        note(f'{out.name} done {task["id"]} infra={result.get("infraError", "-")}')
    note(f'{out.name} finished {len(list((out / "records").glob("*.json")))}/{len(tasks)}')


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--bench', choices=['sb', 'slb'], required=True)
    p.add_argument('--arm', choices=['none', 'flat', 'learned'], required=True)
    p.add_argument('--task')
    p.add_argument('--retry-infra', action='store_true')
    p.add_argument('--per-family', type=int, default=1, help='SkillLearnBench held-out variants per frozen family (0 uses the whole candidate pool)')
    run(p.parse_args())
