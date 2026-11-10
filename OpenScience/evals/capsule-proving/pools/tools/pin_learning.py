"""Pin and fetch the learning and agent sets into sources.json (`learning` key).
Run: python3 -P pin_learning.py SOURCES_JSON DATA_DIR [--only key,key] [--no-download]
Every file is verified against its git blob sha1 (GitHub tree or Hugging Face blobId) before its sha256 is recorded.
Files above the per-set size limit are pinned (git blob sha1, bytes, url) but not downloaded: large:true."""
import concurrent.futures, hashlib, json, os, re, subprocess, sys, urllib.parse, urllib.request

UA = 'capsule-proving-fetch/1'
sources_path, data = sys.argv[1], sys.argv[2]
only = None
if '--only' in sys.argv:
    only = sys.argv[sys.argv.index('--only') + 1].split(',')
no_download = '--no-download' in sys.argv
CACHE = os.environ.get('PIN_CACHE', '/tmp/claude-1001/-home-coder-workspace-EviMedScience/b2f649e5-c7af-4d72-9513-5d00f66d277b/scratchpad/t')

def get_json(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)

GH = lambda repo, commit, includes, limit, **kw: dict(kind='github', repo=repo, commit=commit, includes=includes, limit=limit, **kw)
HF = lambda repo, rev, includes, limit, **kw: dict(kind='hf', repo=repo, commit=rev, includes=includes, limit=limit, **kw)
ALL = r'.'

SPECS = {
 'alfworld': GH('alfworld/alfworld', 'aaba6870f86c5be6a08a491f32a50b906227bc3e', [r'^(?!media/)'], 300_000_000, license='MIT', role='C1 text-game family',
    note='Game data is a release asset, not in the tree: json_2.1.3_tw-pddl.zip of release 0.4.2 (what alfworld-download fetches) is pinned below as extraAssets.',
    extraAssets=[{'path': 'release-0.4.2/json_2.1.3_tw-pddl.zip', 'url': 'https://github.com/alfworld/alfworld/releases/download/0.4.2/json_2.1.3_tw-pddl.zip', 'bytes': 36507267}]),
 'scienceworld': GH('allenai/ScienceWorld', 'e8216d6044e8e39be9fcb185e3b2dfb602584b52', [r'^(?!media/)'], 300_000_000, license='Apache-2.0', role='C1 text-game family; the jar is data here and is never executed by the fetcher'),
 'infiagent-dabench': GH('InfiAgent/InfiAgent', '3d6c4a70198e0a41fadf539f5b43c88b8c1a2d9c', [r'^(LICENSE|README\.md|examples/DA-Agent/)'], 300_000_000, license='Apache-2.0', role='C2 data analysis'),
 'da-code': GH('yiyihum/da-code', 'b211daf51fdc9b52d5087c9df28ac50191bcabed', [r'^(LICENSE|README\.md|da_code/(configs|gold)/|da_agent/evaluators/)', r'^da_code/source/'], 300_000_000, license='MIT', role='C2 data analysis',
    largeRegex=r'^da_code/source/', note='da_code/source (1.2 GB of task data) is pinned and large-only; tasks and gold are fetched. The HF dataset LIAMA/DA-Code is not reachable.'),
 'scienceagentbench': HF('osunlp/ScienceAgentBench', '9c6e96c9e74572e979b0930ee735041cef528cb7', [ALL], 300_000_000, license='cc-by-4.0', role='C2 scientific data tasks (102)',
    note='HF holds the task table only; datasets and gold programs are distributed separately by the authors and are not pinned.'),
 'scienceagentbench-code': GH('OSU-NLP-Group/ScienceAgentBench', 'c26e151ed601ba109dc4d35e057ff8e73fec469d', [ALL], 300_000_000, license='MIT', role='harness code, read only'),
 'tau2-bench': GH('sierra-research/tau2-bench', '033bf082f48e4a3c6a1256208e93cf2ce9c3bb6f', [r'^(LICENSE|README\.md|pyproject\.toml|data/tau2/domains/(?!.*(voice|audio_difficulty)))'], 300_000_000, license='MIT',
    note='Branch main at pin time; release v2.0.0 is commit 989d3285ae669e49503324bdb9981bf14fccedeb. Voice task files are not pinned.'),
 'bfcl': GH('ShishirPatil/gorilla', '6ea57973c7a6097fd7c5915698c54c17c5b1b6c8', [r'^(LICENSE|berkeley-function-call-leaderboard/(README\.md|CHANGELOG\.md|TEST_CATEGORIES\.md|pyproject\.toml|bfcl_eval/data/))'], 300_000_000, license='Apache-2.0',
    note='BFCL v4 data inside the gorilla repository (the HF mirror gorilla-llm/Berkeley-Function-Calling-Leaderboard is v3 and is not used).'),
 'multisessioncollab': GH('Shuhaibm/multisessioncollab', '88e1a4b3f4107230970de7bc1a4f9d3a527e8ef1', [ALL], 300_000_000, license='MIT', role='simulated-user design and code; problems are loaded from public datasets at run time'),
 'skillsbench': GH('benchflow-ai/skillsbench', 'f860ecf02ef53412a030f8661c83d644b739ff01', [r'^(LICENSE|README\.md|tasks/)'], 1_000_000, license='Apache-2.0',
    note='Branch main at pin time. Release v1.1 is commit b63b7b2850226b6aa4fb5929a8c1ac7bc4d9a6af; tasks-extra (14 credential-dependent packages) is not pinned. Files over 1 MB are large-only.'),
 'skilllearnbench': GH('cxcscmu/SkillLearnBench', '726e1f79b96b0cb3d729d0e55a1c847e0b5353ae', [r'^(LICENSE|README\.md|BASELINES\.md|eval_keypoints/|skills/|tasks/)'], 1_000_000, license='MIT',
    note='Task folders are task families with numbered variants. Files over 1 MB are large-only.'),
 'cl-bench': GH('pgasawa/continual-learning-bench', '5f8c50eb1e84b2eda2ef4faff757dfc812a0ea26', [r'^(?!assets/)'], 1_000_000, license='Apache-2.0', largeRegex=r'^final_results/',
    role='same task family across sessions; code-graded', note='Not the Tencent-Hunyuan CL-bench. final_results/runs (265 MB of published runs) is pinned and large-only.'),
 'memorybench': HF('THUIR/MemoryBench', '3acd60a4bd35b43b408f0e6db4c5f1e88df5e96d', [ALL], 300_000_000, license='mit', role='user-feedback learning; feedback is simulated by a model'),
 'memorybench-code': GH('THUIR/MemoryBench', '247ba8c1e327fa297c0d57aaad0e3cbd66bac656', [r'^(LICENSE|README\.md|configs/|memorybench\.py|src/|run_scripts/|requirements\.txt)'], 300_000_000, license='MIT'),
 'medlocomo': GH('leozzy13/MedLoCoMo', '0f25894e8651879a956ec07252df6ffe1fd3c2cc', [r'^(README\.md|main\.py|requirements\.txt|MedLoCoMo/[^/]+/(combined_conversation|benchmark_qa|cross_admission_qa|patient_summary)\.json)$'], 300_000_000,
    license=None, role='English medical long-dialogue memory control, derived from MIMIC-IV',
    note='The repository declares no license. Per-admission conversation, packet and prompt files (2,982 patients-admissions) are not pinned. Derived from credentialed MIMIC-IV/MIMIC-IV-Note data: keep the copy local, never redistribute.'),
 'rabbits': GH('BittermanLab/RABBITS', '6d1bdb6a8e0791be7b4fb47426753e86006c55bb', [r'^(README\.md|requirements\.txt|data/|results/|src/[^/]+\.py)'], 300_000_000, license='README badge says Apache-2.0 (LICENSE.txt linked but absent from the repository)',
    role='brand and generic drug name pairs (English)', note='No license file in the repository; the README badge names Apache-2.0.'),
 'gaia': HF('gaia-benchmark/GAIA', '682dd723ee1e1697e00360edccf2366dc8418dd9', [r'^README\.md$'], 300_000_000, license='none stated in the card metadata', access='gated',
    role='general-assistant benchmark (has a leaderboard)', note='Gated (auto approval: a Hugging Face login that has accepted the dataset terms is required for the data files and the metadata). Only the public card is pinned. The 2023 validation and test folders and metadata files are not fetched; no credentials were requested or used.'),
 'acebench': GH('chenchen0103/ACEBench', '56dd66cf6439b0d9655ee1b353e4cd745c6f664e', [ALL], 300_000_000, license='MIT (LICENSE.md, Microsoft Corporation)', role='tool-use benchmark; en and zh data side by side'),
 'toucan-servers': GH('TheAgentArk/Toucan', 'a1976dea7688c0f36533aa6e3a3fa4c27e017b4b', [r'^(LICENSE|README\.md|mcp_servers/|datagen/prompts/|datagen/README\.MD)'], 300_000_000, license='MIT (GitHub LICENSE, Agent Ark); the Hugging Face card says apache-2.0',
    role='ToolVerse source: labeled MCP server and tool schemas, no trajectories', note='The Hugging Face card says apache-2.0; the GitHub repository LICENSE is recorded as it reads (see licenseText).'),
 'toucan-hf': HF('Agent-Ark/Toucan-1.5M', '0df3cf37f2abefb380370cfb02eabea2a35ae782', [r'^(README\.md|\.gitattributes)$'], 300_000_000, license='apache-2.0',
    note='Identity of the trajectory dataset (21.8 GB, 1.5M rows; tool lists ride inside every row). Only the card is pinned; trajectories are deliberately not pinned or fetched.'),
 'researchclawbench': HF('InternScience/ResearchClawBench', 'fa82414b2ead64ea3a4df2c0688512198c42ba59', [r'^(LICENSE|README\.md|CONTRIBUTING\.md|eval\.yaml|download_tasks\.py|build_viewer_manifest\.py|tasks/[^/]+/(task_info\.json|target_study/checklist\.json))$'], 300_000_000, license='mit',
    role='L9 long research tasks', note='Only task descriptions and rubric checklists are pinned and fetched; task data, related-work PDFs and target papers (2.6 GB in all, 8,800+ files) are not pinned.'),
 'researchclawbench-data': HF('InternScience/ResearchClawBench', 'fa82414b2ead64ea3a4df2c0688512198c42ba59', [r'^tasks/(Life_000|Information_004|Astronomy_004|Chemistry_004|Earth_004|Energy_004|Information_007|Life_006|Energy_001|Material_004)/(data/|related_work/|target_study/(?!checklist\.json$))'], 300_000_000, license='mit',
    largeRegex=r'(^tasks/Information_004/related_work/paper_001\.pdf$|/target_study/)', role='L9 long research tasks: the inputs of the ten selected tasks',
    note='data/ and related_work/ of the ten tasks of pools/l9-long-tasks-20261109.json (the files the agent is given) are fetched, except Information_004/related_work/paper_001.pdf (78 MB, large-only). target_study/ (the target paper, its images and figures: the answer key, which the agent must never see) is pinned large-only; the checklists are in the researchclawbench entry. Chemistry_004 has no data file (only a .gitkeep): its task is computational.'),
 'evoclawbench': GH('pzy2000/EvoClawBench', 'd9ec3e1a8873a1dbd142102abc00568765d21088', [ALL], 300_000_000, license='MIT (LICENSE: Anonymous Authors)', role='skill learning from own runs (arXiv 2607.09711)',
    note='Branch anonymous, the one the paper names. Branch main (commit 73d827a41e1799a8f1e45c621a56216a6d0ffe35, 129 MB) is a later working tree and is not pinned. The repository carries workspaces/ (the authors\' own run outputs) beside tasks/ and assets/.'),
 'precisionmembench': GH('tenurehq/precisionmembench', '61a712a1754e7d27b6dee42da32a2c214b003ece', [ALL], 300_000_000, license='MIT', role='low priority: memory retrieval precision (89 cases)'),
 'precisionmembench-hf': HF('tenurehq/precisionmembench', 'bf1a508a14fd38e4d316ff8932e8b9c4dea2a394', [ALL], 300_000_000, license='mit', role='the leaderboard and per-system results; the cases are in the GitHub repository'),
 'cimemories': GH('facebookresearch/CIMemories', 'e39806e92ec66db120c0f3b73c9cb105e7ff5314', [ALL], 300_000_000, license='CC BY-NC 4.0 (data; the code LICENSE is read as `other`)', role='low priority: contextual integrity of memory; non-commercial'),
 'cimemories-hf': HF('facebook/CIMemories', '7a2bde79f747d011b23095e6bb035c6f64127d9f', [ALL], 300_000_000, license='cc-by-nc-4.0', largeRegex=r'^test\.csv$', role='low priority; CC BY-NC, local only',
    note='test.csv (1.7 GB, the expanded prompts) is large-only.'),
 'webshop': GH('princeton-nlp/WebShop', '64fa2a5c15c7daa698b9ac93f5bb5437b634c9bd', [ALL], 300_000_000, license='MIT', largeRegex=r'(^|/)chromedriver$',
    role='C1 text-game family candidate: deployment cost', note='DEPLOYMENT (README and setup.sh at the pin): Python 3.8.13 in conda, Java (openjdk 11) for Pyserini/Lucene, faiss-cpu, spaCy en_core_web_lg, and a Pyserini index built by search_engine/run_indexing.sh; the Flask site or the text env runs in one process, no other service. Product data is NOT in the repository: setup.sh fetches it with gdown from Google Drive (small: items_shuffle_1000 + items_ins_v2_1000, 1,000 products, the default; all: 1.18 M products, items_shuffle and items_ins_v2, several GB) plus items_human_ins, so those files are not pinned by hash and were not fetched. The repository (this entry) holds the code, 12,087-instruction goal files under baseline_models/data and the search engine; chromedriver (16 MB binary, only for the browser demo) is pinned large-only and never executed. Python 3.8 is end of life: a modern Python needs dependency pins checked first.'),
}
if only:
    SPECS = {k: v for k, v in SPECS.items() if k in only}

def listing(key, s):
    cache = os.path.join(CACHE, f'pin-{key}.json')
    if os.path.exists(cache):
        return json.load(open(cache))
    if s['kind'] == 'github':
        d = get_json(f"https://api.github.com/repos/{s['repo']}/git/trees/{s['commit']}?recursive=1")
        assert not d.get('truncated')
        out = [{'path': x['path'], 'bytes': x['size'], 'gitBlobSha1': x['sha']} for x in d['tree'] if x['type'] == 'blob']
    else:
        d = get_json(f"https://huggingface.co/api/datasets/{s['repo']}/revision/{s['commit']}?blobs=true")
        assert d['sha'] == s['commit']
        out = [{'path': x['rfilename'], 'bytes': x['size'], 'gitBlobSha1': x.get('blobId'), **({'sha256': x['lfs']['sha256']} if x.get('lfs') else {})} for x in d['siblings']]
    json.dump(out, open(cache, 'w'))
    return out

def url_of(s, path):
    q = urllib.parse.quote(path)
    if s['kind'] == 'github':
        return f"https://raw.githubusercontent.com/{s['repo']}/{s['commit']}/{q}"
    return f"https://huggingface.co/datasets/{s['repo']}/resolve/{s['commit']}/{q}"

def git_sha1(path):
    size = os.path.getsize(path)
    h = hashlib.sha1(f'blob {size}\0'.encode())
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()

def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()

def fetch(key, entry):
    path = os.path.join(data, key, entry['path'])
    def ok(p):
        # an LFS file's blobId is its pointer's hash: verify those by the LFS sha256 instead
        if os.path.getsize(p) != entry['bytes']:
            return False
        if entry.get('sha256'):
            return sha256(p) == entry['sha256']
        return entry.get('gitBlobSha1') is None or git_sha1(p) == entry['gitBlobSha1']
    if os.path.exists(path) and ok(path):
        return sha256(path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    for attempt in range(4):
        r = subprocess.run(['curl', '-sSfL', '-A', UA, '--retry', '2', '-o', path + '.part', entry['url']])
        if r.returncode == 0 and os.path.exists(path + '.part') and ok(path + '.part'):
            os.rename(path + '.part', path)
            return sha256(path)
        if os.path.exists(path + '.part'):
            os.remove(path + '.part')
    raise SystemExit(f'{key}/{entry["path"]}: could not fetch a verified copy')

learning = {}
for key, s in SPECS.items():
    files = []
    for item in listing(key, s):
        if not any(re.search(p, item['path']) for p in s['includes']):
            continue
        large = item['bytes'] > s['limit'] or (s.get('largeRegex') and re.search(s['largeRegex'], item['path']) is not None)
        files.append({'path': item['path'], 'url': url_of(s, item['path']), 'bytes': item['bytes'], 'gitBlobSha1': item.get('gitBlobSha1'),
                      **({'sha256': item['sha256']} if item.get('sha256') else {}), **({'large': True} if large else {})})
    for extra in s.get('extraAssets', []):
        files.append({**extra, 'gitBlobSha1': None})
    todo = [f for f in files if not f.get('large')]
    if not no_download:
        with concurrent.futures.ThreadPoolExecutor(6) as ex:
            for f, digest in zip(todo, ex.map(lambda f: fetch(key, f), todo)):
                if f.get('sha256') and f['sha256'] != digest:
                    raise SystemExit(f'{key}/{f["path"]}: sha256 differs from the LFS pointer')
                f['sha256'] = digest
        with open(os.path.join(os.environ.get('CAPSULE_PROVING_DATA', '.'), 'STATUS'), 'a') as st:
            import datetime
            st.write(f"{datetime.datetime.now(datetime.UTC).isoformat()} public DONE learning pin+fetch {key} files={len(files)} fetched={len(todo)}\n")
    meta = {k: v for k, v in s.items() if k not in ('kind', 'repo', 'commit', 'includes', 'limit', 'largeRegex', 'extraAssets')}
    learning[key] = {'name': key, **({'repository': f"https://github.com/{s['repo']}", 'revision': s['commit']} if s['kind'] == 'github' else {'huggingface': s['repo'], 'revision': s['commit']}),
                     'declaredLicense': s.get('license') or 'none declared', **{k: v for k, v in meta.items() if k != 'license'},
                     'totalBytes': sum(f['bytes'] for f in files), 'fetchedBytes': sum(f['bytes'] for f in todo), 'files': files}
    print(key, len(files), 'files', learning[key]['totalBytes'] // 10**6, 'MB total', learning[key]['fetchedBytes'] // 10**6, 'MB fetched', flush=True)
    fresh = json.load(open(sources_path))  # re-read right before writing: other sessions edit this file
    fresh.setdefault('learning', {})[key] = learning[key]
    json.dump(fresh, open(sources_path + '.tmp', 'w'), indent=2); os.replace(sources_path + '.tmp', sources_path)
