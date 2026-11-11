#!/usr/bin/env python3
"""Render observed run/ledger summaries; never extrapolate a task success score."""
import argparse
import collections
import csv
import json
import pathlib
import statistics


def load(path, default=None):
    return json.loads(path.read_text()) if path.exists() else default


def mean(values):
    return statistics.mean(values) if values else None


def fmt(value, digits=3):
    return 'n/a' if value is None else f'{value:.{digits}f}'


def main(args):
    root, runs = args.root, args.runs
    results = load(root / 'summary.json', [])
    accounting = load(root / 'accounting.json', {})
    manifest = load(root / 'manifest.json', {})
    amendments = load(root / 'protocol-amendments.json', [])
    queue = load(root / 'execution-queue.json', {})
    learning = load(root / 'practice/complete.json', {})
    lines = ['# SkillsBench / SkillLearnBench pilot — 2026-11-11', '',
        '**All scored rows are model + skills in the reference harness, not the product.**', '',
        '| Run | Passed / planned | Wilson 95% | Scored / infrastructure / missing | Tokens per model-invoked task | CNY per model-invoked task | Mount incidences / read events (distinct mounted / opened) |',
        '| --- | --- | --- | --- | --- | --- | --- |']
    for r in results:
        interval = 'n/a' if r['ci95'] is None else f"{100*r['ci95'][0]:.1f}–{100*r['ci95'][1]:.1f}%"
        per = r.get('perModelTask') or {}
        lines.append(f"| {r['bench']}-{r['arm']}-1 | {r['pass']}/{r['n']} ({fmt(100*r['value'],1)}%) | {interval} | {r['scored']} / {r['error']} / {r['unknown']} | {fmt(per.get('tokens'),0)} | {fmt(per.get('costCny'))} | {r['mounted']} / {r['opened']} ({r.get('distinctMounted', 'unknown')} / {r.get('distinctOpened', 'unknown')}) |")
    lines += ['', 'Rates above keep infrastructure failures and missing tasks in the planned denominator. Wilson intervals describe this feasibility-conditioned pilot, not a population estimate of the full benchmark. Scorer-only rates and every task are in the JSON/CSV. A partial run is not a final benchmark score. Tokens include cached prompt tokens and completion/reasoning tokens. Costs are timestamp-adjusted billing estimates; peak equivalents are retained separately.', '',
              '## Sampling and per-domain results', '', manifest.get('samplingRule', ''), '',
              'Capacity amendment before any SkillLearnBench scoring: only the first frozen held-out variant per family is primary (six families/categories, one variant each); the other six candidates are unused reserves. No scored result selected or removed a task.']
    if queue:
        lines += ['', 'Execution capacity rule: ' + queue['rule'] + ' The exact order is retained in `execution-queue.json`.']
    for amendment in amendments:
        lines += ['', f"Harness qualification amendment ({amendment['at']}): {amendment['reason']} Original artifacts: `{amendment['archiveRunId']}`; {len(amendment['tasks'])} tasks repeated. Calibration usage remains in total lane cost, separate from primary per-task inference cost."]
    lines += ['', 'Scorer-only rates (excluding unavailable verifiers/admission, never replacing the planned-denominator rates above):']
    for r in results:
        interval = r.get('scoredCi95')
        ci = 'n/a' if not interval else f'{100*interval[0]:.1f}–{100*interval[1]:.1f}%'
        lines.append(f"- {r['bench']}-{r['arm']}-1: {r['pass']}/{r['scored']}, Wilson 95% {ci}; {r.get('modelInvoked', 0)} tasks invoked the model.")
    for bench in ['sb', 'slb']:
        arms = {r['arm']: r for r in results if r['bench'] == bench}
        categories = sorted(manifest.get('perDomain', {}).get(bench, {}))
        lines += ['', f'### {"SkillsBench" if bench == "sb" else "SkillLearnBench"}', '',
                  '| Domain/category | No skills | Official flat | Product-learned methods |', '| --- | --- | --- | --- |']
        for category in categories:
            cells = []
            for arm in ['none', 'flat', 'learned']:
                part = arms.get(arm, {}).get('byCategory', {}).get(category)
                cells.append('not completed' if not part else f"{part['pass']}/{part['n']}" + (f"; {part['error']} infrastructure" if part['error'] else ''))
            lines.append('| ' + category + ' | ' + ' | '.join(cells) + ' |')
    lines += ['', 'Each SkillsBench domain has one primary task per arm. Each SkillLearnBench row is one sampled family in a README category, not coverage of all 15 sub-domains. The manifest and per-task CSV identify the exact tasks.', '', '## Learning and reuse', '']
    if learning:
        statuses = collections.Counter(m.get('status') for m in learning.get('methods', []))
        jobs = collections.Counter((j.get('kind'), j.get('status')) for j in learning.get('jobs', {}).get('jobs', []))
        lines += [f"The real product learned {learning.get('learned', 0)} methods; {learning.get('approved', 0)} were approved and exported. Statuses: {dict(statuses)}. Learning reached a quiet queue: {learning.get('reachedQuiet')}.", '',
                  'Learning job outcomes: ' + '; '.join(f'{kind}/{status}: {n}' for (kind, status), n in sorted(jobs.items())) + '.', '']
    else:
        lines += ['Product learning has not completed; learned/approved counts are unavailable.', '']
    for r in results:
        if r['arm'] == 'learned':
            reuse = r.get('learning', {})
            lines.append(f"- {r['bench']}: {reuse.get('distinctOpenedInOtherTasks', 'unknown')} distinct learned methods observed opened in {reuse.get('tasksOpeningLearned', 'unknown')} held-out tasks; {r['opened']} read-tool openings in total.")
    practice_records = [load(p) for p in (root / 'practice').glob('*.json') if p.name.startswith(('sb-', 'slb-'))]
    turns = collections.Counter(t.get('run', {}).get('status', 'unknown') for r in practice_records for t in r.get('turns', []))
    lines += ['', f'Practice task records: {len(practice_records)}; turn outcomes: {dict(turns)}. These are simulated attended user requests (`automated` omitted), not real-user approval. Practice paths were relocated into the product workspace, and practice outputs were not graded by official container verifiers. Failed/time-limited practice and failed learning jobs remain visible.', '',
              'Scored trials use BenchFlow 0.6.3 + Pi ACP for SkillsBench, and the pinned SkillLearnBench runner + Pi CLI for SkillLearnBench. The learned library comes from product practice/distillation across both benchmark practice pools; its mounting and openings here are reference-agent behavior, not product ranking or capsule observer events. Observed openings require a successful read-tool call; shell reads are not counted. This is a frozen practice-to-held-out transfer pilot, not the full continual curriculum, online adaptation or forgetting measurement.', '',
              '## L7 diagnostic layers', '',
              'Task outcomes above use the unchanged official deterministic verifiers. The following optional diagnostic measurements use pinned upstream prompts/parsers with **DeepSeek Flash, thinking off**, replacing the published GPT-5-mini judge. This is also the solver family, so diagnostic self-judging bias is possible. The transport facade and removal of thinking blocks from Pi traces are disclosed in `judges/config.json`; no judge feedback reaches learning or solving.', '',
              '| Arm | Skill coverage | Executability (native scale) | Safety (native scale) | Trajectory key-point recall | Order (1–5) | Completion (1–5) | Judge errors |',
              '| --- | --- | --- | --- | --- | --- | --- | --- |']
    for arm in ['none', 'flat', 'learned']:
        judged = [load(p) for p in (root / 'judges' / arm).glob('*.json')]
        coverage = [j['skillCoverage']['coverage'] for j in judged if 'skillCoverage' in j]
        exe = [m['summary']['overall_score'] for j in judged for m in j.get('executability', {}).values()]
        safety = [m['summary']['overall_score'] for j in judged for m in j.get('safety', {}).values()]
        recall = [j['keyPointRecall']['trajectory_key_point_recall'] for j in judged if 'keyPointRecall' in j]
        order = [j['executionOrder']['score'] for j in judged if 'executionOrder' in j]
        completion = [j['completeness']['score'] for j in judged if 'completeness' in j]
        errors = sum(bool(j.get('skillQualityError')) + bool(j.get('trajectoryError')) for j in judged)
        lines.append(f"| {arm} | {fmt(mean(coverage))} (n={len(coverage)}) | {fmt(mean(exe))} (n={len(exe)}) | {fmt(mean(safety))} (n={len(safety)}) | {fmt(mean(recall))} (n={len(recall)}) | {fmt(mean(order))} | {fmt(mean(completion))} | {errors} |")
    lines += ['', 'Skill quality is evaluated once per sampled family/skill arm; trajectory diagnostics use the first held-out variant per family, paired across arms. Means with different units are not combined into a new score. Missing/no-skill diagnostics are n/a, not zero quality.', '',
              '## Cost, time and full-run scenario', '',
              f"Lane known-cost estimate: CNY {fmt(accounting.get('totalObservedCny'))}; conservative peak-equivalent bound plus product reservations: CNY {fmt(accounting.get('conservativeUpperBoundCny'))}. This includes paid smokes, inference, product practice/learning and available diagnostics.", '',
              f"Primary task costs in the table are solver inference only. Paid pre-compatibility calibration: CNY {fmt(accounting.get('precompatCalibration', {}).get('costCny'))}; smokes: CNY {fmt(accounting.get('smokes', {}).get('costCny'))}; diagnostic judges: CNY {fmt(accounting.get('judges', {}).get('costCny'))}. Product practice/learning: CNY {fmt((accounting.get('practice') or {}).get('account', {}).get('actualCost'))} (its learning subtotal is included, not added again). Shared engine embedding/reranking charges are not separately allocated; this is known model usage, not an isolated vendor invoice.", '',
              f"Shared provider balance: {accounting.get('balanceBefore', 'unknown')} → {accounting.get('balanceAfter', 'unknown')}. Other lanes were active; the balance delta is not this lane's spend. Start: {accounting.get('startedAt')}; report: {accounting.get('at')}.", '']
    for bench, full_n in [('sb', 87), ('slb', 100)]:
        rows = [r for r in results if r['bench'] == bench]
        if len(rows) != 3 or not all(r['complete'] for r in rows):
            lines.append(f'- {bench}: full-run budget scenario pending completed paired arms; no zero-cost assumption for missing runs.')
            continue
        cost = sum(r['tokens']['costCnyPeakEquivalent'] / r['modelInvoked'] * full_n for r in rows if r.get('modelInvoked'))
        hours = sum(sum(t['wallSeconds'] for t in r['rows']) / r['completed'] * full_n / 3600 for r in rows if r['completed'])
        lines.append(f"- {bench}: linear scenario for {full_n} instances × {len(rows)} arms: CNY {cost:.2f} model spend at peak-equivalent pilot prices, {hours:.1f} sequential lab hours at observed throughput (including baseline oracle setup where applicable).")
    lines += ['', 'These are budget scenarios, not validated full-run quotes or extrapolated success scores. Unseen heavy/credentialed tasks, host rental, a complete official-judge evaluation and additional independent practice are not priced. A full SkillsBench learned-method submission needs external practice (the pilot practice tasks are part of its 87-task corpus); the SkillLearnBench first variants are learning inputs, so an entirely held-out extension has 80 remaining variants, distinct from a 100-instance published-protocol run.', '',
              '## Comparability', '',
              'The [SkillsBench paper](https://arxiv.org/abs/2602.12670) reports +16.6 percentage points averaged across 18 model/harness configurations. It is not an expected gain for this model. [Vals](https://www.vals.ai/benchmarks/skillsbench) reports DeepSeek V4.1 Flash with **OpenHands** at 69.80% (2026-10-29). [DeepSeek documents](https://api-docs.deepseek.com/quick_start/pricing/) `deepseek-flash` as V4.1-Flash-1017; this lane records the requested/returned alias, not an independent weight fingerprint. Pi, the data pin, the feasibility-conditioned sample, resource limits and the skill-generation protocol differ. Absolute leaderboard rank and full-set success cannot be inferred.', '',
              'The product supplies learned skill bodies here, not the scored execution harness. The official self-generation view is a different generation protocol. SkillLearnBench uses a Sonnet 4.6 reference solver and GPT-5-mini judge; these DeepSeek measurements are not a reproduction of those published absolute scores. The optional official-pyramid arm would require additional paid trials and was omitted.', '',
              '## Verification and artifacts', '',
              f"Data pins: SkillsBench `{manifest.get('pins', {}).get('sb')}`; SkillLearnBench `{manifest.get('pins', {}).get('slb')}`. Selected files match the intake pin; verifier SHA256 maps are checked before/after every task. Upstream runner receipts, Python dependency freeze, exact prompts/outputs, official results and private account state stay on the lab. No runtime/provider secrets or raw account credentials belong in the committed report.", '',
              'Runner checks: 10 Node tests and 17 Python tests (27 total), run on the lab; the official task/oracle outcomes are separate evidence. See the final delivery note for the latest check counts. Source, STATUS, run manifests and ledger rows are separately reviewable; no deployment or leaderboard submission occurred.', '',
              '## Leaderboard submission requirements (five lines)', '',
              '1. Freeze the product configuration, code/data/agent pins and learning boundary; do not tune a leaderboard-only product.',
              '2. Run the complete required sets/repeats with unchanged official verifiers and retain every result, error and trajectory.',
              '3. Disclose model, harness, skill sources, practice/test separation, generated methods, resource limits, tokens and spend.',
              '4. Include all three SkillLearnBench layers with its required solver/judge, or obtain agreement to clearly labelled substitutions.',
              '5. Package reproducible artifacts and confirm the current submission route/acceptance with maintainers; this pilot is not a submission.', '']
    args.out.write_text('\n'.join(lines))
    with args.out.with_suffix('.csv').open('w', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(['bench', 'arm', 'task', 'category', 'pass', 'scored', 'error', 'agent_error', 'agent_timed_out', 'wall_seconds',
                         'prompt_tokens', 'completion_tokens', 'cached_tokens', 'cost_cny', 'peak_equivalent_cny',
                         'mounted', 'opened'])
        for result in results:
            for row in result['rows']:
                tokens = row['tokens']
                writer.writerow([result['bench'], result['arm'], row['task'], row['category'], row['pass'], row['scored'],
                    row.get('error'), row.get('agentError'), row.get('agentTimedOut'), row['wallSeconds'], tokens['prompt'], tokens['completion'], tokens['cached'],
                    tokens['costCny'], tokens['costCnyPeakEquivalent'], ';'.join(row.get('mounted', [])), ';'.join(row.get('opened', []))])
    print(args.out)


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--root', type=pathlib.Path, default=pathlib.Path('/srv/evimed/sb'))
    p.add_argument('--runs', type=pathlib.Path, default=pathlib.Path('/srv/evimed/runs'))
    p.add_argument('--out', type=pathlib.Path, default=pathlib.Path('/srv/evimed/sb/report.md'))
    main(p.parse_args())
