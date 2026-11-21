"""Two lab workers share the fixed 55 scenario runs; completed failures are never retried."""
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path


def process_token(pid):
    try:
        fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        return None if fields[0] == 'Z' else fields[19]
    except FileNotFoundError:
        return None


class ScenarioQueue:
    def __init__(self, directory, runs, owner, tasks):
        self.directory = Path(directory)
        self.runs = [Path(p).resolve() for p in runs]
        self.owner = Path(owner).resolve()
        if self.owner not in self.runs:
            raise ValueError('Worker must own one of the declared result directories')
        self.tasks = list(tasks)
        if len(set(self.tasks)) != len(self.tasks):
            raise ValueError('Scenario/repetition pairs must be unique')
        self.pid, self.token = os.getpid(), process_token(os.getpid())
        (self.directory / 'claims').mkdir(parents=True, exist_ok=True)
        with self.lock():
            manifest = self.directory / 'manifest.json'
            value = {'schema': 'eg-g3-queue/1', 'runs': list(map(str, self.runs)), 'tasks': [list(t) for t in self.tasks]}
            if manifest.exists() and json.loads(manifest.read_text()) != value:
                raise ValueError('Existing G3 queue has a different fixed cohort')
            manifest.write_text(json.dumps(value, indent=1))

    def lock(self):
        handle = (self.directory / 'queue.lock').open('a')
        fcntl.flock(handle, fcntl.LOCK_EX)
        return handle

    @staticmethod
    def key(task):
        return f'{task[0]}-r{task[1]}'

    def completed(self, task):
        files = [root / 'results' / f'{self.key(task)}.json' for root in self.runs]
        found = [p for p in files if p.exists()]
        if len(found) > 1:
            raise ValueError(f'Duplicate G3 result: {self.key(task)}')
        if not found:
            return False
        result = json.loads(found[0].read_text())
        if result.get('id') != task[0] or result.get('rep') != task[1] or result.get('status') not in ['pass', 'fail', 'inconclusive', 'not_available', 'error']:
            raise ValueError(f'Invalid G3 result: {self.key(task)}')
        return True

    def complete(self):
        with self.lock():
            return all(self.completed(task) for task in self.tasks)

    def claim(self):
        with self.lock():
            for task in self.tasks:
                file = self.directory / 'claims' / f'{self.key(task)}.json'
                if self.completed(task):
                    file.unlink(missing_ok=True)
                    continue
                prior = json.loads(file.read_text()) if file.exists() else None
                if prior and prior.get('token') and process_token(prior['pid']) == prior['token']:
                    continue
                if prior:
                    with (self.directory / 'interruptions.jsonl').open('a') as log:
                        log.write(json.dumps({'task': list(task), 'prior': prior, 'at': datetime.now(timezone.utc).isoformat()}) + '\n')
                file.write_text(json.dumps({'pid': self.pid, 'token': self.token, 'owner': str(self.owner)}))
                return task
        return None

    def release(self, task):
        with self.lock():
            file = self.directory / 'claims' / f'{self.key(task)}.json'
            if file.exists():
                claim = json.loads(file.read_text())
                if claim == {'pid': self.pid, 'token': self.token, 'owner': str(self.owner)}:
                    if not self.completed(task):
                        with (self.directory / 'interruptions.jsonl').open('a') as log:
                            log.write(json.dumps({'task': list(task), 'prior': claim, 'reason': 'worker_abandoned_before_result', 'at': datetime.now(timezone.utc).isoformat()}) + '\n')
                    file.unlink()
