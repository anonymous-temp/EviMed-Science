"""Add the two pins that have no files (PERSIST) and merge pins, counts and pools into results/intake-learning-<date>.json.
Run: python3 -P learning_finalize.py DATE"""
import hashlib, json, os, sys
HERE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
date = sys.argv[1]
src_path = os.path.join(HERE, 'sources.json')
src = json.load(open(src_path))
src['learning']['persist'] = {
    'name': 'PERSIST (npj Digit Med 8:605, "When helpfulness backfires")', 'status': 'no public data found', 'files': [], 'declaredLicense': 'paper: CC BY (PMC12534679)',
    'note': 'Searched the paper (PMC12534679 and its supplementary zip: figures and one PDF only), GitHub repository and Hugging Face dataset search (PERSIST, sycophancy + brand/generic): no dataset or code release exists. The probe is built from RABBITS pairs instead.',
    'totalBytes': 0, 'fetchedBytes': 0}
json.dump(src, open(src_path + '.tmp', 'w'), indent=2); os.replace(src_path + '.tmp', src_path)

counts = json.load(open(os.path.join(HERE, f'results/learning-counts-{date}.json')))
pools = json.load(open(os.path.join(HERE, f'results/intake-learning-pools-{date}.json')))
def files_digest(files):
    return hashlib.sha256(json.dumps(sorted((f['path'], f.get('sha256') or 'gitblob:' + str(f.get('gitBlobSha1'))) for f in files)).encode()).hexdigest()
sets = {}
for key, info in src['learning'].items():
    files = info['files']
    sets[key] = {'pin': info.get('revision'), 'repository': info.get('repository') or info.get('huggingface'), 'license': info.get('declaredLicense'), 'access': info.get('access', 'public'),
                 'filesPinned': len(files), 'filesFetched': sum(1 for f in files if not f.get('large')), 'filesLargeOnly': sum(1 for f in files if f.get('large')),
                 'totalBytesPinned': info['totalBytes'], 'bytesFetched': info['fetchedBytes'], 'fetched': info['fetchedBytes'] > 0,
                 'pinnedFilesSha256Digest': files_digest(files) if files else None, 'note': info.get('note') or info.get('role')}
    if key in counts: sets[key]['counts'] = counts[key]
c = lambda k: counts.get(k, {})
discrepancies = [
    f"MedLoCoMo: {c('medlocomo').get('patients')} patient folders, not 100 (the questions match: {c('medlocomo').get('questions')} with {c('medlocomo').get('adversarial')} adversarial); the repository declares no license",
    f"ScienceWorld: gold paths cover {c('scienceworld').get('taskTypesWithGoldPaths')} task types (ids {c('scienceworld').get('taskIds')}); id 5 is absent from the gold-path file although the engine has 30",
    f"Toucan: mcp_servers holds {c('toucan-servers').get('serverFiles')} labeled server files, {c('toucan-servers').get('serversWithListedTools')} with listed tools ({c('toucan-servers').get('toolsListed')} tools); the paper's 495 servers / 2,000+ tools are the subset the trajectories use and are not identifiable from these files alone",
    f"ResearchClawBench: {c('researchclawbench').get('tasks')} task folders on the pinned Hugging Face revision; the README says 40 (plus 10 from ResearchClawBench-Self)",
    "DA-Code: eval/eval_di.jsonl has 78 lines but 79 objects (two objects on one line); 500 tasks in total as the paper says; da_code/source (1.2 GB) is large-only",
    "DA-Code: the Hugging Face dataset LIAMA/DA-Code is not reachable; the data comes from the GitHub repository",
    "ALFWorld: the pinned tw-pddl archive (release 0.4.2, json_2.1.3 by name) unpacks under a json_2.1.1 folder; split counts 3,553 / 140 / 134 match the README, plus 200 valid_train games",
    "BFCL: version v4 data counted from the repository (4,706 items over 20 categories); the Hugging Face mirror is v3 and is not pinned",
    "tau2-bench: telecom has 2,285 tasks in tasks.json (the 114 'base' set is a split); airline 50, retail 114 match the paper; banking_knowledge and intake are newer domains",
    "SkillsBench: 87 tasks at the pinned main commit (tag v1.1 is an earlier commit); 14 credential-dependent packages in tasks-extra are not pinned. The plan's 'v4' label is not a tag or branch of the repository",
    "SkillLearnBench: 20 task families (the paper's '20 tasks') with 100 numbered variants in total",
    "GAIA: gated (auto approval behind a Hugging Face login); only the public card is pinned, no data",
    "PERSIST: no public dataset or code found; the probe uses RABBITS pairs",
    "WildChat: 119,302 Chinese conversations and 1,459 pseudo-users with 10+ conversations, as the plan says",
]
out = {'schema': 'capsule-proving-intake-learning/1', 'date': date, 'modelCallsInCode': 0, 'note': 'Kimi wrote the brand/generic sentence templates (one call); nothing else used a model.',
       'seed': 'capsule-proving-20261109-v1', 'sourceManifestSha256': hashlib.sha256(open(src_path, 'rb').read()).hexdigest(), 'sets': sets, 'pools': pools, 'discrepancies': discrepancies}
json.dump(out, open(os.path.join(HERE, f'results/intake-learning-{date}.json'), 'w'), indent=2, ensure_ascii=False)
print(len(sets), 'sets')
