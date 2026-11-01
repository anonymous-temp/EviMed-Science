#!/bin/bash
# Pull a queue's results (text only: result.json, answer.md, transcript.json, files/) from the production host and build
# answers/<queue>.jsonl ({key, text, status, cost, durationMs, route}) for the scorers. Usage: collect.sh <queue> [...]
set -eu
cd "${BENCH_ROOT:-.}"
mkdir -p results answers
for q in "$@"; do
  rsync -a --delete --rsync-path="sudo rsync" --exclude '*.zip' --max-size=20m evimed:/srv/evimed-science/shared/benchmarks/results/"$q"/ results/"$q"/
  python3 - "$q" <<'PY'
import json, pathlib, sys
q = sys.argv[1]; root = pathlib.Path('results') / q; out = []
for d in sorted(p for p in root.iterdir() if p.is_dir()):
    r = d / 'result.json'
    if not r.exists():
        continue
    res = json.loads(r.read_text())
    a = d / 'answer.md'
    last = res.get('lastReport') or None
    # delivery: complete = the run ended on its own; at-cap = it timed out with a report-like file written (lastReport, saved);
    # none = nothing to read. Scorers and report.py read it; a timeout is 0 in the strict figure and its at-cap report in the other.
    delivery = 'complete' if res.get('status') == 'succeeded' else 'at-cap' if res.get('status') == 'timeout' and last and last.get('saved') else 'none'
    out.append({'key': res['key'], 'text': a.read_text() if a.exists() else '', 'status': res.get('status'),
                'cost': (res.get('cost') or {}).get('cost'), 'durationMs': res.get('durationMs'),
                'route': res.get('effectiveAgentId'), 'reason': res.get('effectiveRouteReason'), 'tools': res.get('observedToolCalls'),
                'delivery': delivery, 'lastReport': last, 'deliveredWithinCap': res.get('deliveredWithinCap'),
                'firstReportAtMs': res.get('firstReportAtMs'), 'infrastructureFailure': bool(res.get('infrastructureFailure')),
                'dir': str(d)})
pathlib.Path('answers', f'{q}.jsonl').write_text(''.join(json.dumps(o, ensure_ascii=False) + '\n' for o in out))
print(q, len(out), 'results;', sum(1 for o in out if o['status'] == 'succeeded'), 'succeeded')
PY
done
