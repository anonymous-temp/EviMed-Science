"""Deterministic capacity order; never changes the frozen task sample."""
import itertools
import json
import pathlib
import tomllib
import yaml
from prepare import order
from run import ROOT, active_tasks, put


def execution_queue(manifest):
    streams = {}
    for bench in ['sb', 'slb']:
        items = []
        for task in active_tasks(manifest, bench):
            path = pathlib.Path(task['path'])
            config = yaml.safe_load((path / 'task.md').read_text().split('---', 2)[1]) if bench == 'sb' else tomllib.loads((path / 'task.toml').read_text())
            items.append({'bench': bench, 'task': task['id'],
                          'nativeAgentTimeoutSeconds': config.get('agent', {}).get('timeout_sec', 1800)})
        streams[bench] = sorted(items, key=lambda t: (t['nativeAgentTimeoutSeconds'], order(t['task'], manifest['seed'])))
    return [task for pair in itertools.zip_longest(streams['sb'], streams['slb']) for task in pair if task]


if __name__ == '__main__':
    manifest = json.loads((ROOT / 'manifest.json').read_text())
    tasks = execution_queue(manifest)
    receipt = {'seed': manifest['seed'], 'rule': 'Within each benchmark, native agent timeout ascending, then SHA256(seed + colon + task id); alternate benchmarks. Complete none/learned/flat per task. Sample unchanged; no outcome enters ordering.', 'tasks': tasks}
    file = ROOT / 'execution-queue.json'
    if file.exists() and json.loads(file.read_text()) != receipt:
        raise ValueError('Execution queue changed; review before resuming')
    put(file, receipt)
    for task in tasks:
        print(task['bench'] + '\t' + task['task'])
