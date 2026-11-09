"""Count items of the pinned learning and agent sets from the fetched data (not from READMEs).
Run: python3 -P learning_counts.py DATA_DIR OUT_JSON      (reads only; zip members are read as data, nothing is extracted or run)"""
import collections, csv, glob, json, os, sys, zipfile
import pyarrow as pa

D = sys.argv[1]
P = lambda *a: os.path.join(D, *a)
out = {}

def section(name):
    def deco(fn):
        try:
            out[name] = fn()
        except Exception as e:  # a count that cannot be made is a finding, not a skipped line
            out[name] = {'error': f'{type(e).__name__}: {e}'}
        return fn
    return deco

def jl(path):
    # one DA-Code eval line holds two objects back to back; read every object, however the lines are cut
    dec = json.JSONDecoder(); rows = []
    for l in open(path, encoding='utf8'):
        l = l.strip(); i = 0
        while i < len(l):
            obj, j = dec.raw_decode(l, i); rows.append(obj); i = j
            while i < len(l) and l[i].isspace(): i += 1
    return rows

@section('alfworld')
def _():
    z = zipfile.ZipFile(P('alfworld', 'release-0.4.2', 'json_2.1.3_tw-pddl.zip'))
    games = collections.Counter(); kinds = collections.Counter()
    for n in z.namelist():
        if n.endswith('game.tw-pddl'):
            parts = n.split('/'); games[parts[1]] += 1; kinds[parts[2].split('-')[0]] += 1
    return {'asset': 'release 0.4.2 json_2.1.3_tw-pddl.zip', 'zipTopFolder': z.namelist()[0].split('/')[0], 'gamesBySplit': dict(games), 'games': sum(games.values()), 'taskTypes': dict(kinds),
            'note': 'game counts are game.tw-pddl files; the README quotes 3,553 train / 140 valid_seen / 134 valid_unseen for the original data'}

@section('scienceworld')
def _():
    z = zipfile.ZipFile(P('scienceworld', 'goldpaths', 'goldpaths-all.zip'))
    d = json.loads(z.read(z.namelist()[0]))
    tasks = {k: {'name': v['taskName'], 'goldSequences': len(v['goldActionSequences'])} for k, v in d.items()}
    return {'taskTypesWithGoldPaths': len(tasks), 'goldSequences': sum(t['goldSequences'] for t in tasks.values()), 'taskIds': sorted(map(int, tasks)),
            'note': 'the engine defines 30 task types; the gold-path file covers the ids listed and the jar (not executed here) generates the variations'}

@section('infiagent-dabench')
def _():
    q = jl(P('infiagent-dabench', 'examples/DA-Agent/data/da-dev-questions.jsonl')); l = jl(P('infiagent-dabench', 'examples/DA-Agent/data/da-dev-labels.jsonl'))
    tables = glob.glob(P('infiagent-dabench', 'examples/DA-Agent/data/da-dev-tables/*'))
    return {'questions': len(q), 'labels': len(l), 'distinctIds': len({x['id'] for x in q}), 'tables': len(tables), 'level': dict(collections.Counter(x.get('level') for x in q))}

@section('da-code')
def _():
    r = {}
    for f in sorted(glob.glob(P('da-code', 'da_code/configs/*/*'))):
        rel = f.split('da-code/da_code/configs/')[1]
        if f.endswith('.jsonl'):
            rows = jl(f); r[rel] = len(rows)
            if rel == 'task/all.jsonl':
                all_ids = [x['id'] for x in rows]; r['task/all.jsonl distinctIds'] = len(set(all_ids))
                r['task/all.jsonl byType'] = dict(collections.Counter(x['type'] for x in rows))
    gold = [f for f in glob.glob(P('da-code', 'da_code/gold/**'), recursive=True) if os.path.isfile(f)]
    task_files = {k: v for k, v in r.items() if k.startswith('task/')}
    r['note'] = 'eval/eval_di.jsonl has 78 lines but 79 objects: one line holds two JSON objects back to back'
    return {'configFiles': r, 'goldFiles': len(gold), 'sourceFilesPinnedLargeOnly': 284}

@section('scienceagentbench')
def _():
    rows = list(csv.DictReader(open(P('scienceagentbench', 'ScienceAgentBench.csv'), encoding='utf8')))
    import pyarrow.parquet as pq
    return {'tasks': len(rows), 'distinctIds': len({r['instance_id'] for r in rows}), 'domains': dict(collections.Counter(r['domain'] for r in rows)),
            'verifiedParquetRows': pq.ParquetFile(P('scienceagentbench', 'data/verified-00000-of-00001.parquet')).metadata.num_rows}

@section('tau2-bench')
def _():
    r = {}
    for dom in sorted(os.listdir(P('tau2-bench', 'data/tau2/domains'))):
        f = P('tau2-bench', 'data/tau2/domains', dom, 'tasks.json')
        if os.path.exists(f):
            d = json.load(open(f)); r[dom] = len(d['tasks']) if isinstance(d, dict) else len(d)
    splits = {}
    for dom in r:
        f = P('tau2-bench', 'data/tau2/domains', dom, 'split_tasks.json')
        if os.path.exists(f):
            splits[dom] = {k: len(v) for k, v in json.load(open(f)).items()}
    return {'tasksByDomain': r, 'splits': splits, 'publicDomainsOfTheOriginalBenchmark': {k: r.get(k) for k in ('airline', 'retail', 'telecom')}}

@section('bfcl')
def _():
    p = P('bfcl', 'berkeley-function-call-leaderboard/bfcl_eval/data')
    r = {os.path.basename(f)[:-5]: sum(1 for l in open(f, encoding='utf8') if l.strip()) for f in sorted(glob.glob(p + '/BFCL_v4_*.json'))}
    pa_ = {os.path.basename(f)[:-5]: sum(1 for l in open(f, encoding='utf8') if l.strip()) for f in sorted(glob.glob(p + '/possible_answer/BFCL_v4_*.json'))}
    py = open(P('bfcl', 'berkeley-function-call-leaderboard/pyproject.toml')).read()
    changelog = open(P('bfcl', 'berkeley-function-call-leaderboard/CHANGELOG.md'), encoding='utf8').read().splitlines()
    version = [l for l in changelog if l.startswith('## ') or l.startswith('# ')][:3]
    return {'version': version, 'categories': r, 'items': sum(r.values()), 'withPossibleAnswers': pa_, 'itemsWithPossibleAnswers': sum(pa_.values())}

@section('multisessioncollab')
def _():
    profiles = json.load(open(P('multisessioncollab', 'collaborativeagents/user_profiles/user_profiles.json')))
    cache = {f.split('cache/')[1]: len(json.load(open(f))) for f in glob.glob(P('multisessioncollab', 'collaborativeagents/datasets/cache/*/*.json'))}
    return {'userProfiles': len(profiles), 'cachedProblemFiles': cache}

@section('skillsbench')
def _():
    tasks = sorted(os.listdir(P('skillsbench', 'tasks')))
    skills = sum(len(glob.glob(P('skillsbench', 'tasks', t, 'environment/skills/*/SKILL.md'))) for t in tasks)
    return {'tasks': len(tasks), 'tasksWithTaskMd': sum(os.path.exists(P('skillsbench', 'tasks', t, 'task.md')) for t in tasks), 'skillFilesInTasks': skills,
            'largeFilesPinnedNotFetched': sum(1 for f in json.load(open(P('..', 'sources.json')))['learning']['skillsbench']['files'] if f.get('large'))} if False else {'tasks': len(tasks), 'tasksWithTaskMd': sum(os.path.exists(P('skillsbench', 'tasks', t, 'task.md')) for t in tasks), 'skillFilesInTasks': skills}

@section('skilllearnbench')
def _():
    fam = collections.Counter(); 
    for d in glob.glob(P('skilllearnbench', 'tasks/*/*/')):
        fam[d.split('/')[-3]] += 1
    return {'taskFamilies': len(fam), 'variants': sum(fam.values()), 'variantsPerFamily': dict(sorted(fam.items())), 'handWrittenSkillDirs': len(glob.glob(P('skilllearnbench', 'skills/*')))}

@section('cl-bench')
def _():
    fams = sorted(d for d in os.listdir(P('cl-bench', 'src/tasks')) if os.path.isdir(P('cl-bench', 'src/tasks', d)) and not d.startswith('__'))
    return {'taskFamilies': fams, 'count': len(fams), 'dataDirs': sorted(os.listdir(P('cl-bench', 'data'))), 'configDirs': sorted(os.listdir(P('cl-bench', 'configs')))}

@section('memorybench')
def _():
    r = {}
    for d in sorted(glob.glob(P('memorybench', 'dataset', '*'))):
        name = os.path.basename(d)
        if not os.path.isdir(d):
            continue
        r[name] = {}
        for split in ('train', 'test'):
            f = glob.glob(os.path.join(d, split, '*.arrow'))
            if f:
                with open(f[0], 'rb') as fh:
                    try:
                        t = pa.ipc.open_stream(fh).read_all()
                    except Exception:
                        t = pa.ipc.open_file(f[0]).read_all()
                r[name][split] = t.num_rows
    langs = {}
    return {'datasets': len(r), 'rowsBySplit': r, 'trainRows': sum(v.get('train', 0) for v in r.values()), 'testRows': sum(v.get('test', 0) for v in r.values())}

@section('medlocomo')
def _():
    base = P('medlocomo', 'MedLoCoMo')
    pats = [d for d in os.listdir(base) if os.path.isdir(os.path.join(base, d))]
    c = collections.Counter(); ids = set(); adm = 0; turns = 0
    for p in pats:
        for q in json.load(open(os.path.join(base, p, 'benchmark_qa.json')))['qas']:
            ids.add(q['qa_id']); c[q['question_type']] += 1
        cc = json.load(open(os.path.join(base, p, 'combined_conversation.json'))); adm += len(cc['admissions'])
        turns += sum(len(a['conversation_lines']) for a in cc['admissions'])
    return {'patients': len(pats), 'questions': len(ids), 'adversarial': c['adversarial'], 'byType': dict(c), 'admissions': adm, 'turns': turns,
            'planSays': {'patients': 100, 'questions': 17892, 'adversarial': 5964}}

@section('rabbits')
def _():
    g = list(csv.DictReader(open(P('rabbits', 'data/generic_to_brand.csv'))))
    r = {'genericToBrandRows': len(g)}
    for f in ('annotated_medqa_new.csv', 'annotated_medmcqa_new.csv'):
        r[f] = sum(1 for _ in csv.DictReader(open(P('rabbits', 'data', f), encoding='utf8')))
    return r

@section('acebench')
def _():
    r = {}
    for lang in ('en', 'zh'):
        r[lang] = {os.path.basename(f)[5:-5]: sum(1 for l in open(f, encoding='utf8') if l.strip()) for f in sorted(glob.glob(P('acebench', f'data_all/data_{lang}/data_*.json')))}
    pa_ = {lang: sum(1 for f in glob.glob(P('acebench', f'data_all/data_{lang}/possible_answer/*.json'))) for lang in ('en', 'zh')}
    return {'itemsByLang': {k: sum(v.values()) for k, v in r.items()}, 'categories': r, 'possibleAnswerFiles': pa_}

@section('researchclawbench')
def _():
    tasks = sorted(glob.glob(P('researchclawbench', 'tasks/*/task_info.json')))
    dom = collections.Counter(os.path.basename(os.path.dirname(t)).rsplit('_', 1)[0] for t in tasks)
    return {'tasks': len(tasks), 'domains': dict(dom)}

@section('toucan-servers')
def _():
    files = sorted(glob.glob(P('toucan-servers', 'mcp_servers/*_labeled.json')))
    tools = 0; withTools = 0; connected = 0; featured = 0; names = set(); primary = collections.Counter()
    for f in files:
        d = json.load(open(f)); m = d['metadata']; lab = d['labels']
        r = m.get('remote_server_response') or {}
        tl = (r.get('tools') or []) if r.get('is_success') else []
        tools += len(tl); withTools += bool(tl); names.update((m['server_id'], t['name']) for t in tl)
        connected += bool(lab.get('is_connected')); featured += bool(lab.get('featured_server')); primary[lab.get('primary_label')] += 1
    return {'serverFiles': len(files), 'serversWithListedTools': withTools, 'serversConnected': connected, 'featuredServers': featured, 'toolsListed': tools, 'distinctServerToolPairs': len(names),
            'primaryLabels': len(primary), 'planSays': {'servers': 495, 'tools': '2000+'},
            'note': 'mcp_servers holds every crawled server with labels and, where the crawl connected, the tool schemas in metadata.remote_server_response.tools; the 495 of the paper are the subset the trajectories use'}

json.dump(out, open(sys.argv[2], 'w'), indent=2, ensure_ascii=False)
print(json.dumps({k: (v if 'error' in v else 'ok') for k, v in out.items()}))
