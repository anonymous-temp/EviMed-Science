#!/usr/bin/env python3
"""L7 diagnostic layers using pinned upstream prompts/parsers and a labelled substitute judge.

This is DeepSeek Flash (thinking off), NOT the published GPT-5-mini judge.
Run after all agent trials, so reference key points can never reach learning/inference.
"""
import argparse
import asyncio
import importlib.util
import json
import os
import pathlib
import sys
from openai import AsyncOpenAI

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from run import ROOT, RUNS, DATA, UPSTREAM, GATEWAY, note, put


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def trajectory(record):
    root = pathlib.Path(record['trialPath'])
    sessions = sorted((root / 'agent/sessions').rglob('*.jsonl'))
    if not sessions:
        raise ValueError('No persisted reference-agent session; trajectory is unknown')
    steps = []
    for file in sessions:
        for line in file.read_text().splitlines():
            event = json.loads(line)
            msg = event.get('message')
            if not isinstance(msg, dict) or msg.get('role') not in ['user', 'assistant', 'toolResult']:
                continue
            msg = {k: v for k, v in msg.items() if k in ['role', 'content', 'toolCallId', 'toolName', 'isError', 'stopReason']}
            if isinstance(msg.get('content'), list):
                # Preserve actions and results, not private reasoning. Do not truncate away failed steps.
                msg['content'] = [block for block in msg['content'] if block.get('type') != 'thinking']
            steps.append(msg)
    if not steps:
        raise ValueError('Persisted session has no messages')
    return json.dumps(steps, ensure_ascii=False)


async def main(args):
    # Freeze once per family: the first held-out variant in the frozen manifest.
    manifest = json.loads((ROOT / 'manifest.json').read_text())
    tasks = {}
    for task in manifest['tasks']:
        if task['bench'] == 'slb':
            tasks.setdefault(task['family'], task)
    out = ROOT / 'judges'
    out.mkdir(exist_ok=True)
    skill_dir = UPSTREAM / 'slb/evaluation/skill/metrics'
    traj_dir = UPSTREAM / 'slb/evaluation/trajectory/metrics'
    coverage = module('sb_coverage', skill_dir / 'compute_coverage.py')
    executability = module('sb_executability', skill_dir / 'compute_executability.py')
    safety = module('sb_safety', skill_dir / 'compute_safety.py')
    keypoints = module('sb_keypoints', traj_dir / 'metric_llm_key_points.py')
    order = module('sb_order', traj_dir / 'metric_llm_execution_order.py')
    completeness = module('sb_completeness', traj_dir / 'metric_llm_completeness.py')
    os.environ['OPENAI_API_KEY'] = 'lab-proxy'
    os.environ['OPENAI_BASE_URL'] = GATEWAY
    client = AsyncOpenAI(api_key='lab-proxy', base_url=GATEWAY)
    semaphore = asyncio.Semaphore(1)
    put(out / 'config.json', {'judge': 'deepseek-flash', 'thinking': 'disabled',
        'officialJudge': False, 'publishedJudge': 'gpt-5-mini', 'pin': manifest['pins']['slb'],
        'sampling': 'First held-out variant per frozen family, paired across all three arms; skill quality evaluated once per family/skill arm.',
        'transport': 'Pinned metric functions and exact prompts/normalizers. Local Responses-to-Chat-Completions transport facade; Pi persisted message/tool trace, with thinking blocks omitted, no truncation.',
        'variants': {k: v['id'] for k, v in tasks.items()}})
    try:
        for arm in ['none', 'flat', 'learned']:
            for family, task in tasks.items():
                destination = out / arm / (family + '.json')
                if destination.exists():
                    continue
                record_file = RUNS / f'slb-{arm}-1/records/{task["id"]}.json'
                if not record_file.exists():
                    raise ValueError(f'Agent trial missing: {record_file}')
                record = json.loads(record_file.read_text())
                put(ROOT / 'current.json', {'runId': f'slb-{arm}-1-judge', 'task': task['id'],
                                             'arm': arm, 'purpose': 'judge'})
                note(f'judge {arm}/{family} start')
                points_dir = DATA / f'skilllearnbench/eval_keypoints/{family}/{task["id"]}'
                instruction = (pathlib.Path(task['path']) / 'instruction.md').read_text()
                result = {'family': family, 'variant': task['id'], 'arm': arm,
                          'judge': 'deepseek-flash', 'officialJudge': False}
                source = DATA / 'skilllearnbench/skills/human_authored' / family if arm == 'flat' else ROOT / 'learned'
                skill_dirs = sorted({p.parent for p in source.rglob('SKILL.md')}) if arm != 'none' else []
                if skill_dirs:
                    try:
                        result['skillCoverage'] = await asyncio.to_thread(coverage._evaluate_one_run,
                            config=arm, run_id=family, skill_dirs=skill_dirs, config_root=source,
                            points=coverage._load_key_points(points_dir / 'skill-key-points.generated.json'),
                            model='deepseek-flash', raw_dir=out / 'raw')
                        exe, safe = {}, {}
                        for directory in skill_dirs:
                            name = directory.name
                            _, exe[name], _ = await executability._eval_skill(client, semaphore, model='deepseek-flash',
                                task_intro=instruction, skill_name=name, generated_skill=executability._build_single_skill_blob(directory))
                            _, safe[name], _ = await safety._eval_skill(client, semaphore, model='deepseek-flash',
                                config=arm, task_intro=instruction, skill_name=name, generated_skill=safety._build_single_skill_blob(directory))
                        result['executability'], result['safety'] = exe, safe
                    except Exception as error:
                        result['skillQualityError'] = f'{type(error).__name__}: {error}'[:1500]
                else:
                    result['skillQuality'] = {'status': 'not-applicable', 'reason': 'No skills available', 'skills': 0}
                try:
                    trace = trajectory(record)
                    result['trajectoryChars'] = len(trace)
                    result['keyPointRecall'] = await keypoints.compute(
                        keypoints._load_key_points(points_dir / 'traj-key-points.generated.json'), trace,
                        model='deepseek-flash', client=client, semaphore=semaphore, max_concurrency=1)
                    oracle = (points_dir / 'traj-extracted-oracle.json').read_text()
                    result['executionOrder'] = await order.compute(instruction, oracle, trace,
                        model='deepseek-flash', client=client, semaphore=semaphore)
                    result['completeness'] = await completeness.compute(instruction, oracle, trace,
                        model='deepseek-flash', client=client, semaphore=semaphore)
                except Exception as error:
                    result['trajectoryError'] = f'{type(error).__name__}: {error}'[:1500]
                put(destination, result)
                note(f'judge {arm}/{family} done skillError={bool(result.get("skillQualityError"))} trajectoryError={bool(result.get("trajectoryError"))}')
    finally:
        await client.close()


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    asyncio.run(main(p.parse_args()))
