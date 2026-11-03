#!/usr/bin/env python3
"""Development-side scoring of a round's runs with the lab's own scorers: any arm, at any time, on whatever has arrived.

  score_round.py --arm base=s1 [--arm cand=s2 ...] --rows rsi/screen/rows.json [--rows rsi/screen-bix/rows.json] [--domains medcalc,arb-deep,...]
                 [--ref base] [--repeats 1] [--name NAME] [--inbox DIR ...] [--requests FILE ...] [--cache DIR] [--bench-root DIR] [--out FILE]

An arm is NAME=PREFIX: its runs are the lane bundles `<PREFIX>.<domain>.<row>.r<k>` (`.tgz` + `.meta.json`) in the inbox (default
`$H2_RUNS_ROOT/inbox` and its `archive/`; `done.<rid>.tgz` is found too). Rows come from rows files ({domain: [ids]}) and must be
development rows (build_round_gold.py's refusal applies again here); their gold is the output of build_round_gold.py. The first arm is
the reference of the paired differences unless --ref says otherwise. Markdown goes to stdout, JSON to `$BENCH_ROOT/rsi/score/<NAME>.json`
(NAME defaults to the arm names joined by `+`). Nothing here prints a question or a gold answer.

Scoring is the lab's: `score_runs.mjs` calls evals/rsi-campaigns/harness_scorers.mjs (medcalc, arb-deep, arb-wide, mbc-normalized,
bixbench-deterministic), a run that did not succeed is scored on a null answer exactly as harness_campaign.mjs does, and
export_harness_arms.classify decides what is infrastructure. drb and rcb are judged families: they get delivery, time and cost here and
no score (judged_packets_round.py prepares their packets).

Counting rules
  * infrastructure (driver_error, dispatch_refused, interrupted, canceled, a runtime error code, an unreadable or altered bundle) is
    LISTED APART and is never a zero and never in a mean; a run whose bundle has not arrived is `missing`, also apart.
  * a genuine non-delivery (status failed with a solver-side code, or timeout) scores 0 and counts. `scoreAtCap` additionally scores the
    answer a timed-out run left in answer.md; `atCap` counts the timeouts that left a draft report (`lastReport`).
  * delivered = the driver's `deliveredWithinCap` (true only when the run ended on its own, inside the cap, with an answer or a report).
  * minutes = the run's own duration (`durationMs`), else the driver's wall clock; cost = the settled ledger cost (open or uncertain
    cost is `unsettled` and left out of the figures); tools = `observedToolCalls`.
  * language mismatch = the script of the answer (CJK or Latin letters, code and URLs left out) differs from the script of the request;
    drb takes the task's registered language when the request is not at hand.
  * contamination = lane.json's record of URLs naming a benchmark in the run's tool calls (record only; the run stays in the means).
  * BixBench: capsules with no question code can settle (or a dataset range the lab refuses) are judge-only and have no code score;
    `bixbench-deterministic` is a FLOOR, so the open-question share and the upper bound (needs_judge counted as correct) are printed.
  * paired differences: candidate minus reference per row over the rows scored in both, repeats averaged first; mean and percentile
    bootstrap 95% interval over rows (seed 20261028, 2,000 resamples). Descriptive, not a decision.

Python 3.10 compatible; run with `python3 -I`; needs node >= 22 for the scorers.
"""
import argparse
import datetime
import json
import pathlib
import statistics
import sys
from collections import Counter, defaultdict

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # python -I does not put the script's directory on sys.path
import round_lib as rl  # noqa: E402


# --------------------------------------------------------------------------------------------------------------------- arguments

def parse_arms(specs):
    arms = []
    for spec in specs:
        if '=' not in spec:
            raise rl.RoundError(f'--arm {spec!r} is NAME=PREFIX')
        name, prefix = spec.split('=', 1)
        if not name or not prefix or any(name == a[0] for a in arms) or any(prefix == a[1] for a in arms):
            raise rl.RoundError(f'--arm {spec!r}: names and prefixes must be non-empty and used once')
        arms.append((name, prefix))
    return arms


def scratch_runs():
    import os
    scratch = pathlib.Path(os.environ.get('RSI1_SCRATCH', '/tmp/rsi1-scratch'))
    return scratch / 'score' / 'runs'


# --------------------------------------------------------------------------------------------------------------------- one run

def minutes_of(result):
    if isinstance(result.get('durationMs'), (int, float)):
        return result['durationMs'] / 60000
    try:
        start = datetime.datetime.fromisoformat(result['startedAt'].replace('Z', '+00:00'))
        end = datetime.datetime.fromisoformat(result['finishedAt'].replace('Z', '+00:00'))
        return (end - start).total_seconds() / 60
    except (KeyError, ValueError, AttributeError):
        return None


def settled_cost(result):
    cost = result.get('cost') or {}
    if cost.get('openCost', 1) == 0 and cost.get('uncertain', 1) == 0 and isinstance(cost.get('cost'), (int, float)):
        return cost['cost']
    return None


def facts_of(record, prompt_language):
    """What the table reads from one ok run, apart from its score."""
    r = record.result
    last = r.get('lastReport') if isinstance(r.get('lastReport'), dict) else None
    contamination = (record.lane.get('contamination') or {}) if isinstance(record.lane, dict) else {}
    answer_language = rl.script_language(record.answer or '')
    return {
        'status': r.get('status'), 'errorCode': r.get('errorCode'), 'minutes': minutes_of(r), 'cost': settled_cost(r),
        'toolCalls': r.get('observedToolCalls') if isinstance(r.get('observedToolCalls'), (int, float)) else None,
        'delivered': r.get('deliveredWithinCap') is True, 'firstReportMs': r.get('firstReportAtMs') if isinstance(r.get('firstReportAtMs'), (int, float)) else None,
        'draft': None if last is None else {'saved': last.get('saved') is True, 'bytes': last.get('bytes')},
        'answerChars': len(record.answer or ''), 'agent': r.get('effectiveAgentId'),
        'languageMismatch': bool(prompt_language and answer_language and prompt_language != answer_language),
        'contamination': contamination.get('count') or 0, 'contaminationNames': sorted({n for h in contamination.get('hits') or [] for n in h.get('names') or []}),
        'infraRetries': record.meta.get('infraRetries') or 0,
        'flags': [f for f, bad in (('claimLost', record.lane.get('claimLost') is True), ('driverExit', record.lane.get('driverExit') not in (0, None)),
                                   ('runtimeNotKeyless', (record.lane.get('runtimeKeyless') or {}).get('ok') is False)) if bad],
    }


# --------------------------------------------------------------------------------------------------------------------- collection

def collect(arms, wanted, gold, items, args, requests, inboxes, cache, manifest):
    """Every expected run of every arm: [RunRecord] with .facts and, for code families, .score filled in."""
    records = []
    for name, prefix in arms:
        for domain, ids in wanted.items():
            for row in ids:
                for repeat in range(args.repeats):
                    rid = rl.rid_of(prefix, domain, row, repeat)
                    record = rl.RunRecord(name, domain, row, repeat, rid)
                    rl.load_run(record, inboxes, cache, args.infrastructure_code)
                    if record.state == 'ok' and record.result.get('key') != rl.expected_key(domain, row):
                        record.state, record.reason = 'corrupt', 'the bundle holds another item than the one requested'
                    records.append(record)
    jobs, by_id = [], {}
    for record in records:
        if record.state != 'ok':
            continue
        request = requests.get(record.rid) or {}
        prompt = ((request.get('item') or {}).get('prompt'))
        language = rl.script_language(prompt) if prompt else None
        if language is None and record.domain == 'drb':
            language = ((items['drb'].get(record.row) or {}).get('meta') or {}).get('language')
        record.facts = facts_of(record, language)
        if record.domain in rl.JUDGED:
            continue
        succeeded = record.facts['status'] == 'succeeded'
        job = {'id': record.rid, 'scorer': rl.SCORER[record.domain], 'row': gold[record.domain][record.row],
               'answer': record.answer if succeeded else None}
        if record.facts['status'] == 'timeout' and record.answer:
            job['atCapAnswer'] = record.answer
        jobs.append(job)
        by_id[record.rid] = record
    scored = rl.run_scorer(jobs)
    unscorable = {d: (manifest.get('domains', {}).get(d) or {}).get('unscorableByCode') or {} for d in wanted}
    for rid, record in by_id.items():
        result = scored.get(rid, {'error': 'no_result'})
        record.score = result.get('score')
        record.score_at_cap = result.get('scoreAtCap', result.get('score'))
        record.detail = result.get('detail')
        record.score_error = result.get('error')
        if record.score_error == 'row_invalid' and record.row in unscorable[record.domain]:
            record.score_error = 'judge_only'
    return records


# --------------------------------------------------------------------------------------------------------------------- aggregation

def per_row(records, value):
    """{row: mean of value(record) over its ok runs with a value} (repeats averaged)."""
    grouped = defaultdict(list)
    for record in records:
        v = value(record) if record.state == 'ok' else None
        if v is not None:
            grouped[record.row].append(v)
    return {row: statistics.fmean(vs) for row, vs in grouped.items()}


def bix_questions(records):
    """The BixBench open-question share: the questions code cannot settle, over the questions of the runs that arrived."""
    total = deterministic = needs_judge = correct = 0
    for record in records:
        if record.state != 'ok' or record.domain != 'bixbench' or not record.detail:
            continue
        for q in record.detail['questions']:
            total += 1
            if q['deterministic']:
                deterministic += 1
                correct += q['verdict'] == 'correct'
                needs_judge += q['verdict'] == 'needs_judge'
    open_questions = total - deterministic
    return {'questions': total, 'deterministic': deterministic, 'open': open_questions, 'deterministicNeedsJudge': needs_judge,
            'needsJudge': open_questions + needs_judge, 'needsJudgeShare': (open_questions + needs_judge) / total if total else None,
            'deterministicCorrect': correct}


def run_line(record):
    """One run in the JSON: its state and the numbers the tables read, no text."""
    line = {'rid': record.rid, 'row': record.row, 'repeat': record.repeat, 'state': record.state}
    if record.reason:
        line['reason'] = record.reason
    if record.state == 'ok':
        f = record.facts
        line.update({'status': f['status'], 'errorCode': f['errorCode'], 'score': getattr(record, 'score', None), 'scoreAtCap': getattr(record, 'score_at_cap', None),
                     'minutes': f['minutes'], 'costCny': f['cost'], 'toolCalls': f['toolCalls'], 'delivered': f['delivered'],
                     'firstReportMinutes': None if f['firstReportMs'] is None else f['firstReportMs'] / 60000, 'draft': f['draft'], 'answerChars': f['answerChars'],
                     'agent': f['agent'], 'languageMismatch': f['languageMismatch'], 'contamination': f['contamination']})
        if getattr(record, 'score_error', None):
            line['scoreError'] = record.score_error
    return line


def summarize(arm, domain, records, rows_expected, repeats, gold_rows, submitted):
    mine = [r for r in records if r.arm == arm and r.domain == domain]
    ok = [r for r in mine if r.state == 'ok']
    missing = [r.rid for r in mine if r.state == 'missing']
    not_requested = [rid for rid in missing if submitted is not None and rid not in submitted]
    statuses = Counter(r.facts['status'] for r in ok)
    minutes = [r.facts['minutes'] for r in ok if r.facts['minutes'] is not None]
    costs = [r.facts['cost'] for r in ok if r.facts['cost'] is not None]
    tools = [r.facts['toolCalls'] for r in ok if r.facts['toolCalls'] is not None]
    timeouts = [r for r in ok if r.facts['status'] == 'timeout']
    first = [r.facts['firstReportMs'] / 60000 for r in ok if r.facts['firstReportMs'] is not None]
    out = {
        'rowsExpected': rows_expected, 'runsExpected': rows_expected * repeats, 'runsPresent': len(mine) - len(missing), 'runsOk': len(ok),
        'missing': missing, 'notRequested': not_requested,
        'infra': [{'rid': r.rid, 'reason': r.reason} for r in mine if r.state == 'infra'],
        'corrupt': [{'rid': r.rid, 'reason': r.reason} for r in mine if r.state == 'corrupt'],
        'infraRetries': sum(r.facts['infraRetries'] for r in ok),
        'status': dict(sorted(statuses.items())),
        'delivered': sum(r.facts['delivered'] for r in ok), 'deliveredRate': (sum(r.facts['delivered'] for r in ok) / len(ok)) if ok else None,
        'timeouts': len(timeouts),
        'atCap': {'timeouts': len(timeouts), 'withDraft': sum(r.facts['draft'] is not None for r in timeouts),
                  'withSavedDraft': sum(bool(r.facts['draft'] and r.facts['draft']['saved']) for r in timeouts),
                  'runsWithFirstReport': len(first), 'medianFirstReportMinutes': rl.median_or_none(first)},
        'minutes': {'median': rl.median_or_none(minutes), 'n': len(minutes)},
        'costCny': {'median': rl.median_or_none(costs), 'total': sum(costs) if costs else 0.0, 'n': len(costs), 'unsettled': len(ok) - len(costs)},
        'toolCalls': {'median': rl.median_or_none(tools), 'n': len(tools)},
        'languageMismatch': {'count': sum(r.facts['languageMismatch'] for r in ok), 'rids': [r.rid for r in ok if r.facts['languageMismatch']]},
        'contamination': {'runs': sum(r.facts['contamination'] > 0 for r in ok), 'hits': sum(r.facts['contamination'] for r in ok),
                          'rids': [r.rid for r in ok if r.facts['contamination'] > 0]},
        'flags': [{'rid': r.rid, 'flags': r.facts['flags']} for r in ok if r.facts['flags']],
        'agents': dict(sorted(Counter(r.facts['agent'] for r in ok).items(), key=lambda kv: str(kv[0]))),
    }
    out['runs'] = [run_line(r) for r in mine]
    if domain in rl.JUDGED:
        out['score'] = None
        out['scoreNote'] = 'judged family: no code score; see judged_packets_round.py'
        return out
    coded = [r for r in ok if getattr(r, 'score', None) is not None]
    judge_only = [r.rid for r in ok if getattr(r, 'score_error', None) == 'judge_only']
    errors = [{'rid': r.rid, 'error': r.score_error} for r in ok if getattr(r, 'score_error', None) not in (None, 'judge_only')]
    rows_scored = per_row(mine, lambda r: getattr(r, 'score', None))
    rows_at_cap = per_row(mine, lambda r: getattr(r, 'score_at_cap', None))
    out.update({
        'score': rl.mean_ci(list(rows_scored.values())), 'scoreAtCap': rl.mean_ci(list(rows_at_cap.values())) if rows_at_cap != rows_scored else None,
        'runsScored': len(coded), 'judgeOnlyRuns': judge_only, 'scorerErrors': errors, 'perRow': dict(sorted(rows_scored.items(), key=lambda kv: rl.natural_key(kv[0]))),
    })
    if domain == 'bixbench':
        out['bixbench'] = bix_questions(mine)
        det = out['bixbench']
        # Upper bound over the capsules code can score: needs_judge counted as correct.
        if det['deterministic']:
            out['bixbench']['floorQuestionShare'] = det['deterministicCorrect'] / det['deterministic']
            out['bixbench']['upperQuestionShare'] = (det['deterministicCorrect'] + det['deterministicNeedsJudge']) / det['deterministic']
    if domain == 'mbc':
        verdicts = Counter((r.detail or {}).get('verdict') for r in ok if r.detail)
        out['mbc'] = {'correct': verdicts.get('correct', 0), 'needsJudge': verdicts.get('needs_judge', 0), 'incorrect': verdicts.get('incorrect', 0),
                      'upperRunShare': ((verdicts.get('correct', 0) + verdicts.get('needs_judge', 0)) / sum(verdicts.values())) if verdicts else None}
    return out


def slice_label(domain, key, items):
    if domain == 'medcalc':
        meta = next((i['meta'] for i in items.values() if i['meta'].get('calculator_id') == key), None)
        return f'{key} {meta["calculator"]}' if meta else str(key)
    return str(key)


def slices(arm, domain, records, gold_rows, items):
    mine = [r for r in records if r.arm == arm and r.domain == domain]
    rows = per_row(mine, lambda r: getattr(r, 'score', None))
    if domain == 'bixbench':
        # One capsule is one row: the slice is the capsule, with its topic; a capsule without a code score says why.
        out = {}
        for row in gold_rows:
            states = {r.state for r in mine if r.row == row}
            judge_only = any(getattr(r, 'score_error', None) == 'judge_only' for r in mine if r.row == row)
            note = None if row in rows else 'judge-only' if judge_only else ('missing' if states <= {'missing'} else 'no scored run')
            out[f'{row} {gold_rows[row]["topic"]}'] = {'n': 1 if row in rows else 0, 'mean': rows.get(row), 'note': note}
        return out
    field = rl.SLICE_FIELD[domain]
    grouped = defaultdict(list)
    for row, value in rows.items():
        grouped[gold_rows[row][field]].append(value)
    return {slice_label(domain, key, items): {'n': len(vs), 'mean': statistics.fmean(vs)} for key, vs in sorted(grouped.items(), key=lambda kv: str(kv[0]))}


def paired(reference, candidate, domain, records):
    """Candidate minus reference per row over the rows scored in both, for score, cost and minutes."""
    out = {}
    for label, value in (('score', lambda r: getattr(r, 'score', None)), ('costCny', lambda r: r.facts['cost']), ('minutes', lambda r: r.facts['minutes'])):
        if label == 'score' and domain in rl.JUDGED:
            continue
        a = per_row([r for r in records if r.arm == reference and r.domain == domain], value)
        b = per_row([r for r in records if r.arm == candidate and r.domain == domain], value)
        common = sorted(set(a) & set(b), key=rl.natural_key)
        diffs = [b[row] - a[row] for row in common]
        out[label] = {'rows': len(common), 'mean': statistics.fmean(diffs) if diffs else None, 'ci95': rl.bootstrap_ci(diffs),
                      'better': sum(d > 0 for d in diffs), 'same': sum(d == 0 for d in diffs), 'worse': sum(d < 0 for d in diffs)}
    return out


# --------------------------------------------------------------------------------------------------------------------- output

def f3(x):
    return '-' if x is None else f'{x:.3f}'


def f1(x):
    return '-' if x is None else f'{x:.1f}'


def ci(x):
    return '' if not x else f' [{x[0]:.3f}, {x[1]:.3f}]'


def short(ids, limit=16):
    ids = list(ids)
    return ', '.join(ids[:limit]) + (f', ... (+{len(ids) - limit})' if len(ids) > limit else '')


def row_part(rid, prefix, domain):
    """`<row>.r<k>` of `<prefix>.<domain>.<row>.r<k>`: the lists name rows, the prefix and domain are in the heading."""
    head = f'{prefix}.{domain}.'
    return rid[len(head):] if rid.startswith(head) else rid


def render(report):
    lines = [f'# Round scores: {report["name"]} (development rows, lab scorers; descriptive)', '']
    lines.append(f'arms: ' + '; '.join(f'{n}={p}' for n, p in report['arms'].items()) + f'; reference {report["reference"]}; repeats {report["repeats"]}')
    lines.append(f'inbox: {", ".join(report["inboxes"])}  |  generated {report["generatedAt"]}')
    lines.append('')
    lines.append('| family | arm | runs ok/exp | score (mean over rows) | delivered | timeouts | failed | min med | CNY med | CNY total | tools med | lang | contam | infra | missing |')
    lines.append('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    for domain, fam in report['families'].items():
        for arm, s in fam['arms'].items():
            score = f'{f3(s["score"]["mean"])}{ci(s["score"]["ci95"])} n={s["score"]["n"]}' if s.get('score') else ('judged' if domain in rl.JUDGED else '-')
            lines.append(f'| {domain} | {arm} | {s["runsOk"]}/{s["runsExpected"]} | {score} | {s["delivered"]}/{s["runsOk"]} | {s["timeouts"]} | {s["status"].get("failed", 0)} '
                         f'| {f1(s["minutes"]["median"])} | {f3(s["costCny"]["median"])} | {s["costCny"]["total"]:.2f}{"*" if s["costCny"]["unsettled"] else ""} '
                         f'| {f1(s["toolCalls"]["median"])} | {s["languageMismatch"]["count"]} | {s["contamination"]["runs"]} | {len(s["infra"]) + len(s["corrupt"])} | {len(s["missing"])} |')
    lines.append('')
    lines.append('score = per-row mean (repeats averaged) of the lab scorer, a non-delivery counts 0, infrastructure and missing runs are not in it; CI = bootstrap over rows. `*` = some cost unsettled.')
    for domain, fam in report['families'].items():
        for arm, s in fam['arms'].items():
            notes = []
            if s.get('scoreAtCap'):
                notes.append(f'score at cap (timed-out answers scored too) {f3(s["scoreAtCap"]["mean"])}')
            if s['timeouts']:
                a = s['atCap']
                notes.append(f'{s["timeouts"]} timeout(s): {a["withDraft"]} left a draft report ({a["withSavedDraft"]} saved)')
            if s['atCap']['runsWithFirstReport']:
                notes.append(f'first report written in {s["atCap"]["runsWithFirstReport"]} run(s), median {f1(s["atCap"]["medianFirstReportMinutes"])} min')
            if s.get('bixbench') and s['bixbench']['questions']:
                b = s['bixbench']
                notes.append(f'{b["needsJudge"]}/{b["questions"]} questions need a judge ({f3(b["needsJudgeShare"])}: {b["open"]} open + {b["deterministicNeedsJudge"]} unsettled of '
                             f'{b["deterministic"]} deterministic); code floor {f3(b.get("floorQuestionShare"))}, upper bound {f3(b.get("upperQuestionShare"))} on the deterministic questions')
            if s.get('judgeOnlyRuns'):
                notes.append(f'{len(s["judgeOnlyRuns"])} run(s) are judge-only (no code score): {short([row_part(i, report["arms"][arm], domain) for i in s["judgeOnlyRuns"]], 6)}')
            if s.get('mbc') and s['mbc']['needsJudge']:
                notes.append(f'{s["mbc"]["needsJudge"]} case(s) need a judge; upper bound {f3(s["mbc"]["upperRunShare"])}')
            if s['infraRetries']:
                notes.append(f'{s["infraRetries"]} infrastructure retr{"y" if s["infraRetries"] == 1 else "ies"} before delivery')
            if s['agents'] and domain not in ('drb', 'rcb'):
                notes.append('route ' + ', '.join(f'{k}:{v}' for k, v in s['agents'].items()))
            if notes:
                lines.append(f'- {domain}/{arm}: ' + '; '.join(notes))
    for domain, fam in report['families'].items():
        if not fam.get('slices') or not any(v for sl in fam['slices'].values() for v in sl.values() if v['mean'] is not None or v.get('note')):
            continue
        arms = list(fam['arms'])
        lines += ['', f'### {domain} by {"capsule" if domain == "bixbench" else rl.SLICE_FIELD[domain]}', '']
        lines.append('| slice | ' + ' | '.join(arms) + (' | ' + ' | '.join(f'{a} - {report["reference"]}' for a in arms if a != report['reference']) if len(arms) > 1 else '') + ' |')
        lines.append('|---|' + '---|' * (len(arms) + (len(arms) - 1 if len(arms) > 1 else 0)))
        labels = sorted({k for a in arms for k in fam['slices'][a]})
        for label in labels:
            def cell(a):
                x = fam['slices'][a].get(label)
                if x is None:
                    return '-'
                return f'{f3(x["mean"])} ({x["n"]})' if x['mean'] is not None else (x.get('note') or '-')
            cells = [cell(a) for a in arms]
            diffs = []
            for a in arms:
                if a != report['reference'] and len(arms) > 1:
                    ref, cand = fam['slices'][report['reference']].get(label), fam['slices'][a].get(label)
                    diffs.append(f'{cand["mean"] - ref["mean"]:+.3f}' if ref and cand and ref['mean'] is not None and cand['mean'] is not None else '-')
            lines.append(f'| {label} | ' + ' | '.join(cells + diffs) + ' |')
    if any(fam.get('paired') for fam in report['families'].values()):
        lines += ['', '### Paired differences (candidate minus reference, per row; descriptive)', '',
                  '| family | arm | measure | rows | mean diff | 95% CI | better/same/worse |', '|---|---|---|---|---|---|---|']
        for domain, fam in report['families'].items():
            for arm, measures in (fam.get('paired') or {}).items():
                for label, p in measures.items():
                    lines.append(f'| {domain} | {arm} | {label} | {p["rows"]} | {f3(p["mean"]) if p["mean"] is not None else "-"} | '
                                 f'{("[" + f3(p["ci95"][0]) + ", " + f3(p["ci95"][1]) + "]") if p["ci95"] else "-"} | {p["better"]}/{p["same"]}/{p["worse"]} |')
    lines += ['', '### Missing, infrastructure and flags', '']
    anything = False
    for domain, fam in report['families'].items():
        for arm, s in fam['arms'].items():
            rp = lambda rid: row_part(rid, report['arms'][arm], domain)  # noqa: E731
            for label, ids in (('missing', [rp(i) for i in s['missing']]), ('not requested', [rp(i) for i in s['notRequested']]),
                               ('infrastructure', [f'{rp(i["rid"])} ({i["reason"]})' for i in s['infra']]),
                               ('corrupt', [f'{rp(i["rid"])} ({i["reason"]})' for i in s['corrupt']]),
                               ('scorer errors', [f'{rp(i["rid"])} ({i["error"]})' for i in s.get('scorerErrors', [])]),
                               ('language mismatch', [rp(i) for i in s['languageMismatch']['rids']]), ('contamination hits', [rp(i) for i in s['contamination']['rids']]),
                               ('lane flags', [f'{rp(i["rid"])} {"+".join(i["flags"])}' for i in s['flags']])):
                if ids:
                    anything = True
                    lines.append(f'- {domain}/{arm} {label} ({len(ids)}): {short(ids)}')
    if report['unexpected']:
        anything = True
        for arm, ids in report['unexpected'].items():
            lines.append(f'- {arm} bundles in the inbox for rows not in the rows files ({len(ids)}): {short(ids, 12)}')
    if not anything:
        lines.append('none')
    totals = report['totals']
    lines += ['', f'runs: {totals["ok"]} scored-or-counted of {totals["expected"]} expected; {totals["missing"]} missing, {totals["infra"]} infrastructure, {totals["corrupt"]} corrupt.']
    return '\n'.join(lines) + '\n'


def unexpected_bundles(arms, wanted, inboxes, repeats):
    """Bundles of an arm's prefix in the inbox that no row of the rows files accounts for."""
    expected = {rl.rid_of(prefix, d, row, k) for _, prefix in arms for d, ids in wanted.items() for row in ids for k in range(repeats)}
    found = defaultdict(set)
    for directory in inboxes:
        directory = pathlib.Path(directory)
        if not directory.is_dir():
            continue
        for path in directory.glob('*.tgz'):
            rid = path.name[:-4]
            rid = rid[5:] if rid.startswith('done.') else rid
            for name, prefix in arms:
                if rid.startswith(prefix + '.') and rid not in expected:
                    found[name].add(rid)
    return {name: sorted(ids, key=rl.natural_key) for name, ids in found.items()}


def build_report(args):
    root = rl.bench_root(args.bench_root)
    arms = parse_arms(args.arm)
    if not arms:
        raise rl.RoundError('give at least one --arm NAME=PREFIX')
    reference = args.ref or arms[0][0]
    if reference not in [a[0] for a in arms]:
        raise rl.RoundError(f'--ref {reference} is not one of the arms')
    wanted = rl.load_rows_files(args.rows, args.domains.split(',') if args.domains else None)
    for domain, ids in wanted.items():
        rl.check_development(root, domain, ids)
    gold = {d: rl.load_gold_rows(root, d, ids) for d, ids in wanted.items()}
    items = {d: rl.load_gold_items(root, d) for d in wanted}
    manifest = rl.read_json(rl.score_dir(root) / 'gold' / 'manifest.json') or {}
    inboxes = [pathlib.Path(p) for p in (args.inbox or rl.default_inboxes())]
    request_files = args.requests if args.requests is not None else sorted(str(p) for p in (root / 'rsi').glob('*/requests.jsonl'))
    requests = rl.load_requests(request_files)
    cache = pathlib.Path(args.cache) if args.cache else scratch_runs()
    cache.mkdir(parents=True, exist_ok=True)
    records = collect(arms, wanted, gold, items, args, requests, inboxes, cache, manifest)
    families = {}
    for domain, ids in wanted.items():
        fam = {'scorer': rl.SCORER[domain], 'benchmark': rl.BENCHMARK[domain], 'rows': len(ids), 'arms': {}, 'slices': {}, 'paired': {}}
        for name, prefix in arms:
            submitted = {rid for rid in requests if rid.startswith(f'{prefix}.{domain}.')} if any(r.startswith(f'{prefix}.') for r in requests) else None
            fam['arms'][name] = summarize(name, domain, records, len(ids), args.repeats, gold[domain], submitted)
            if domain not in rl.JUDGED:
                fam['slices'][name] = slices(name, domain, records, gold[domain], items[domain])
        if domain in rl.JUDGED:
            fam.pop('slices')
        for name, _ in arms:
            if name != reference:
                fam['paired'][name] = paired(reference, name, domain, records)
        families[domain] = fam
    count = Counter(r.state for r in records)
    return {
        'schema': rl.SCHEMA_SCORE, 'role': 'development', 'name': args.name or '+'.join(a[0] for a in arms),
        'generatedAt': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'arms': dict(arms), 'reference': reference, 'repeats': args.repeats, 'inboxes': [str(p) for p in inboxes], 'rowsFiles': list(args.rows),
        'goldManifest': {d: (manifest.get('domains', {}).get(d) or {}).get('itemsSha256') for d in wanted},
        'families': families, 'unexpected': unexpected_bundles(arms, wanted, inboxes, args.repeats),
        'totals': {'expected': len(records), 'ok': count['ok'], 'missing': count['missing'], 'infra': count['infra'], 'corrupt': count['corrupt']},
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--arm', action='append', required=True, help='NAME=PREFIX (repeatable; the first is the reference)')
    parser.add_argument('--rows', action='append', required=True, help='rows.json {domain: [ids]} (repeatable; merged)')
    parser.add_argument('--domains', help='comma list; default every domain in the rows files')
    parser.add_argument('--ref', help='reference arm of the paired differences (default: the first arm)')
    parser.add_argument('--repeats', type=int, default=1)
    parser.add_argument('--name')
    parser.add_argument('--inbox', action='append', help='directory of <rid>.tgz bundles (repeatable; default $H2_RUNS_ROOT/inbox and inbox/archive)')
    parser.add_argument('--requests', action='append', help='requests.jsonl of the lane requests (repeatable; default rsi/*/requests.jsonl)')
    parser.add_argument('--cache', help='where bundles are unpacked (default $RSI1_SCRATCH/score/runs)')
    parser.add_argument('--infrastructure-code', action='append', default=[], help='an extra errorCode to treat as infrastructure')
    parser.add_argument('--bench-root')
    parser.add_argument('--out', help='JSON file (default $BENCH_ROOT/rsi/score/<name>.json)')
    args = parser.parse_args(argv)
    if args.repeats < 1:
        print('score_round: --repeats is at least 1', file=sys.stderr)
        return 2
    try:
        report = build_report(args)
    except rl.RoundError as error:
        print(f'score_round: {error}', file=sys.stderr)
        return 2
    out = pathlib.Path(args.out) if args.out else rl.score_dir(rl.bench_root(args.bench_root)) / f'{report["name"]}.json'
    rl.write_atomic(out, json.dumps(report, ensure_ascii=False, indent=1) + '\n')
    sys.stdout.write(render(report))
    print(f'\njson: {out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
