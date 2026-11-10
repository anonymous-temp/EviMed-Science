#!/usr/bin/env python3
"""Score InfiAgent-DABench answers with the official closed-form evaluator (examples/DA-Agent/eval_closed_form.py, pinned 3d6c4a7).

Two modes, both calling the official code rather than re-implementing it:

  one       --id N --response-file F --out J   one question: the official evaluate_responses() on that answer; writes the verdict
  aggregate --responses R --out-dir D          the whole run: runs the official script itself (its printed accuracies and its
                                               eval_outputs/*_evaluation_analysis.json land in D)

A question whose answer is missing or empty is a failure here. The official script silently drops such questions from its
denominator; `aggregate` therefore writes every question with a placeholder answer, so the official figure and ours agree.
"""
import argparse
import json
import os
import subprocess
import sys

DEFAULT_DIR = '/srv/evimed/data/memdata-data/public/infiagent-dabench/examples/DA-Agent'
EMPTY = '(no answer)'


def official(dabench_dir):
    sys.path.insert(0, dabench_dir)
    import eval_closed_form  # noqa: E402  the pinned official evaluator
    return eval_closed_form


def read_jsonl(path):
    with open(path, encoding='utf-8') as handle:
        return [json.loads(line) for line in handle if line.strip()]


def one(args):
    ecf = official(args.dabench_dir)
    labels = {row['id']: row for row in read_jsonl(os.path.join(args.dabench_dir, 'data/da-dev-labels.jsonl'))}
    label = labels[int(args.id)]
    with open(args.response_file, encoding='utf-8') as handle:
        response = handle.read()
    results = ecf.evaluate_responses([label], [{'id': int(args.id), 'response': response or EMPTY}])
    result = results[0] if results else None
    correctness = (result or {}).get('correctness', {})
    predicted = (result or {}).get('predicted_answers', {})
    expected = (result or {}).get('label_answers', {a[0]: a[1] for a in label['common_answers']})
    passed = bool(response.strip()) and bool(correctness) and all(correctness.values())
    # Code-decided detail for the failure classes: which expected names never appeared in the @name[value] form.
    missing = [name for name in expected if name not in predicted]
    verdict = {
        'id': int(args.id), 'pass': passed, 'score': 1.0 if passed else 0.0,
        'subScore': (sum(correctness.values()) / len(correctness)) if correctness else 0.0,
        'correctness': correctness, 'predicted': predicted, 'expected': expected, 'missingNames': missing,
        'emptyResponse': not response.strip(), 'scorer': 'infiagent-dabench eval_closed_form.evaluate_responses @3d6c4a7',
    }
    with open(args.out, 'w', encoding='utf-8') as handle:
        json.dump(verdict, handle, ensure_ascii=False, indent=1)
    print(json.dumps({'pass': passed, 'subScore': verdict['subScore']}))


def aggregate(args):
    rows = read_jsonl(args.responses)
    os.makedirs(args.out_dir, exist_ok=True)
    complete = os.path.join(args.out_dir, 'responses.jsonl')
    with open(complete, 'w', encoding='utf-8') as handle:
        for row in rows:
            handle.write(json.dumps({'id': row['id'], 'response': row.get('response') or EMPTY}, ensure_ascii=False) + '\n')
    script = os.path.join(args.dabench_dir, 'eval_closed_form.py')
    run = subprocess.run([sys.executable, script, '--questions_file_path', os.path.join(args.dabench_dir, 'data/da-dev-questions.jsonl'),
                          '--labels_file_path', os.path.join(args.dabench_dir, 'data/da-dev-labels.jsonl'), '--responses_file_path', complete],
                         cwd=args.out_dir, capture_output=True, text=True, timeout=600)
    with open(os.path.join(args.out_dir, 'official-stdout.txt'), 'w', encoding='utf-8') as handle:
        handle.write(run.stdout + run.stderr)
    if run.returncode != 0:
        sys.stderr.write(run.stderr[-2000:])
        sys.exit(run.returncode)
    print(run.stdout)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['one', 'aggregate'])
    parser.add_argument('--dabench-dir', default=DEFAULT_DIR)
    parser.add_argument('--id')
    parser.add_argument('--response-file')
    parser.add_argument('--out')
    parser.add_argument('--responses')
    parser.add_argument('--out-dir')
    args = parser.parse_args()
    one(args) if args.mode == 'one' else aggregate(args)


if __name__ == '__main__':
    main()
