#!/usr/bin/env python3
"""Score one DA-Code task, or a whole run, with the official DA-Code code (github.com/yiyihum/da-code @ b211daf).

What the official pipeline does after its agent stops (run.py), and how each step is reproduced here by calling its code:
  1. post-process: for plot tasks, da_agent.configs.post_process.plot_process(mnt_dir, controller) re-runs the agent's plotting
     .py files with the official hook appended (scripts/image.py) and keeps dabench/plot.json + dabench/result.npy. The official
     controller executes inside the task container; here the same command runs inside the product's own sandbox runner
     (evimed-landlock-run, workspace-write profile) in the task's workspace, with the model's Python environment.
  2. result.json: {finished, steps, result, result_files, trajectory}; `result` is the Terminate(output=...) of the reply, parsed by
     the official da_agent.agent.action.Terminate.parse_action_from_text (the whole reply when the reply has none).
  3. the output folder: the workspace without the task's source files, as _cleanup_source_files() leaves it, except that a source
     file the agent changed is kept (it can be the requested output, e.g. "enter the results into the provided result.csv").
  4. score: da_agent.evaluators.evaluation.Evaluator(output_dir, gold_dir, timeout).evaluate(<this task's eval config>).
`aggregate` runs the official evaluate.py run_evaluation() over every task folder of the run.
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

REPO = '/srv/evimed/pp/dl/c2-ref/da-code-full'
# The product's own folders at the top of a project workspace (cell.mjs SKIP_TOP): never task output.
SKIP_TOP_NAMES = {'.openscience', '.evimed', 'runtime', '.dsh', '.git', 'node_modules', '__pycache__', '.cache', 'knowledge-base'}
MAX_COPY = 300 * 1024 * 1024


def product_folder(name):
    return name in SKIP_TOP_NAMES or name.startswith('.evimed-') or name.startswith('.dsh')


def official(repo):
    sys.path.insert(0, repo)
    from da_agent.agent.action import Terminate  # noqa: E402
    from da_agent.configs.post_process import plot_process  # noqa: E402
    from da_agent.evaluators.evaluation import Evaluator  # noqa: E402
    return Terminate, plot_process, Evaluator


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def tree(root):
    out = {}
    for current, dirs, files in os.walk(root):
        rel_dir = os.path.relpath(current, root)
        if rel_dir == '.':
            dirs[:] = [d for d in dirs if not product_folder(d)]
        dirs[:] = [d for d in dirs if d not in ('__pycache__', '.git', 'node_modules')]
        for name in files:
            rel = os.path.normpath(os.path.join(rel_dir, name))
            if rel_dir == '.' and product_folder(name):
                continue
            out[rel] = os.path.join(current, name)
    return out


class SandboxContainer:
    """The `container.exec_run` the official plot_process calls, run in the product's sandbox in the workspace."""

    def __init__(self, workspace, runner, python_bin, timeout):
        self.workspace, self.runner, self.python_bin, self.timeout, self.log = workspace, runner, python_bin, timeout, []

    def exec_run(self, cmd, **_kwargs):
        env = {'PATH': f"{self.python_bin}:/usr/local/bin:/usr/bin:/bin", 'HOME': '/tmp', 'TMPDIR': '/tmp', 'MPLBACKEND': 'Agg', 'LANG': 'C.UTF-8'}
        argv = [self.runner, '--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent',
                '--tmpfs', '/tmp', '--bind', self.workspace, self.workspace, '--', 'bash', '-c', f'cd {json.dumps(self.workspace)} && {cmd}']
        try:
            run = subprocess.run(argv, env=env, capture_output=True, text=True, timeout=self.timeout)
            self.log.append({'cmd': cmd, 'exit': run.returncode, 'stderr': run.stderr[-800:]})
            return (run.returncode, (run.stdout + run.stderr).encode())
        except subprocess.TimeoutExpired:
            self.log.append({'cmd': cmd, 'exit': None, 'stderr': 'timeout'})
            return (124, b'timeout')


class Controller:
    def __init__(self, container):
        self.container = container


def one(args):
    Terminate, plot_process, Evaluator = official(args.repo)
    with open(args.task_file, encoding='utf-8') as handle:
        task = json.load(handle)
    task_id, workspace = task['id'], args.workspace
    reply = open(args.reply_file, encoding='utf-8').read() if args.reply_file and os.path.exists(args.reply_file) else ''
    meta = json.load(open(args.meta_file, encoding='utf-8'))

    source = {}
    if os.path.isdir(task['sourceDir']):
        for rel, path in tree(task['sourceDir']).items():
            source[rel] = sha256(path)

    # 1. post-process (plot tasks), in the workspace, as the official env does before cleanup.
    post_files, post_errors, exec_log = [], [], []
    if os.path.isdir(workspace):
        for name in task.get('postProcess', []):
            if name != 'plot_process':
                post_errors.append(f'unknown post-process {name}')
                continue
            container = SandboxContainer(workspace, args.runner, args.python_bin, args.post_timeout)
            files, error = plot_process(workspace, Controller(container))
            post_files.extend(files if isinstance(files, list) else list(files))
            post_errors.append(error)
            exec_log.extend(container.log)

    # 3. the output folder.
    out = os.path.join(args.out_root, task_id)
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(os.path.join(out, 'dabench'), exist_ok=True)
    added, changed, copied, skipped = [], [], [], []
    if os.path.isdir(workspace):
        for rel, path in sorted(tree(workspace).items()):
            if not os.path.isfile(path):
                continue
            digest = sha256(path)
            if rel in source and source[rel] == digest:
                continue  # an untouched source file: removed by the official cleanup
            (changed if rel in source else added).append(os.path.join(out, rel))
            if os.path.getsize(path) > MAX_COPY:
                skipped.append(rel)
                continue
            target = os.path.join(out, rel)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            shutil.copy2(path, target)
            copied.append(rel)

    # 2. result.json, the official shape.
    action = Terminate.parse_action_from_text(reply) if reply else None
    result = action.output if action is not None else reply.strip()
    trajectory = meta.get('trajectory', [])
    dabench = {'finished': bool(meta.get('finished')), 'steps': len(trajectory), 'result': result,
               'result_files': {'added_files': added, 'changed_files': changed,
                                'post_process_files': [os.path.join(out, 'dabench', os.path.basename(f)) if f else '' for f in post_files],
                                'error': post_errors},
               'trajectory': trajectory}
    with open(os.path.join(out, 'dabench', 'result.json'), 'w', encoding='utf-8') as handle:
        json.dump(dabench, handle, ensure_ascii=False, indent=1)

    # 4. the official evaluator on this one task.
    score, info, error = 0.0, None, None
    if task.get('eval'):
        with tempfile.NamedTemporaryFile('w', suffix='.jsonl', delete=False, encoding='utf-8') as handle:
            handle.write(json.dumps(task['eval']) + '\n')
            eval_file = handle.name
        try:
            results = Evaluator(output_dir=args.out_root, gold_dir=args.gold_dir, timeout_seconds=args.timeout_seconds).evaluate(eval_file)
            if results:
                score = float(results[0].get('total_score') or 0.0)
                info = results[0].get('info')
        except Exception as exc:  # the official evaluator's own failure is a recorded zero, not a crash of the run
            error = f'{type(exc).__name__}: {exc}'[:1000]
        finally:
            os.unlink(eval_file)
    else:
        error = 'no eval config'
    verdict = {'id': task_id, 'score': score, 'pass': score >= 1.0, 'finished': dabench['finished'], 'result': result[:2000],
               'terminateFound': action is not None, 'postProcessErrors': [e for e in post_errors if e], 'postProcessLog': exec_log,
               'added': [os.path.relpath(p, out) for p in added], 'changed': [os.path.relpath(p, out) for p in changed],
               'notCopied': skipped, 'info': info, 'error': error,
               'scorer': 'da-code da_agent.evaluators.evaluation.Evaluator @b211daf'}
    with open(args.verdict_out, 'w', encoding='utf-8') as handle:
        json.dump(verdict, handle, ensure_ascii=False, indent=1, default=str)
    print(json.dumps({'score': score, 'finished': dabench['finished'], 'error': error}))


def aggregate(args):
    sys.path.insert(0, args.repo)
    from evaluate import run_evaluation  # noqa: E402  the official evaluate.py
    ids = [d for d in sorted(os.listdir(args.out_root)) if os.path.exists(os.path.join(args.out_root, d, 'dabench', 'result.json'))]
    configs = {}
    with open(os.path.join(args.repo_data, 'da_code/configs/eval/eval_all.jsonl'), encoding='utf-8') as handle:
        for line in handle:
            if line.strip():
                row = json.loads(line)
                configs[row['id']] = row
    os.makedirs(args.result_dir, exist_ok=True)
    eval_json = os.path.join(args.result_dir, 'eval_c2.jsonl')
    with open(eval_json, 'w', encoding='utf-8') as handle:
        for task_id in ids:
            handle.write(json.dumps(configs[task_id]) + '\n')
    run_evaluation(args.out_root, args.gold_dir, eval_json, args.result_dir, args.timeout_seconds)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['one', 'aggregate'])
    parser.add_argument('--repo', default=REPO)
    parser.add_argument('--repo-data', default='/srv/evimed/data/memdata-data/public/da-code')
    parser.add_argument('--gold-dir', default='/srv/evimed/data/c2-dacode-full/gold')
    parser.add_argument('--out-root', required=True)
    parser.add_argument('--timeout-seconds', type=int, default=300)
    parser.add_argument('--task-file')
    parser.add_argument('--workspace')
    parser.add_argument('--reply-file')
    parser.add_argument('--meta-file')
    parser.add_argument('--verdict-out')
    parser.add_argument('--runner', default='/srv/evimed/pp/runtime/evimed-landlock-run')
    parser.add_argument('--python-bin', default='/srv/evimed/pp/runtime-venv-c2/bin')
    parser.add_argument('--post-timeout', type=int, default=300)
    parser.add_argument('--result-dir')
    args = parser.parse_args()
    one(args) if args.mode == 'one' else aggregate(args)


if __name__ == '__main__':
    main()
