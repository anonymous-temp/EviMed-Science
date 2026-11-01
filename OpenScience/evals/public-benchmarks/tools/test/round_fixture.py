"""A tiny synthetic benchmark work directory and lane bundles for the round scoring tests (never the real data).

make_bench(tmp) writes pools, raw data and judge material for a handful of invented rows:
  medcalc     dev 101 102 103   conf 900   dropped 901   baseline 902      (calculator 2 decimal, 4 integer)
  mbc         dev 0 1 2         conf 3     (MedBrowseComp-shaped CSV, index = row id)
  arb-deep    dev deep-0 deep-1 conf deep-2 ; arb-wide dev wide-3 conf wide-4
  bixbench    dev bix-1 (str + range) bix-2 (all llm) bix-3 (reversed range)   conf bix-9
  drb         dev 11 12   conf 13 (criteria, reference and query already in the score assets, so nothing is fetched)
  rcb         dev Earth_001   conf Earth_002
The gold values are recognisable marks (GOLD_MARK) so a test can prove they never reach an output.
"""
import hashlib
import io
import json
import pathlib
import tarfile

GOLD_MARK = '7.7777'
QUESTION_MARK = 'QUESTIONTEXT-MARK'


def write(path, text):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')
    return path


def pool(development, confirmation, dropped=(), baseline=(), **extra):
    return {'schema': 'bench-pools/1', 'digest': 'd' * 64, 'rule': 'test', 'pools': {'main': {
        'universe': len(development) + len(confirmation), 'development': list(development), 'confirmation': list(confirmation),
        'dropped': list(dropped), 'excludedBaseline': list(baseline)}}, **extra}


def make_bench(tmp):
    root = pathlib.Path(tmp)
    # --- pools
    write(root / 'pools/medcalc.json', json.dumps(pool(['101', '102', '103'], ['900'], ['901'], ['902'], verified={'changedRowIds': ['103']})))
    write(root / 'pools/medbrowsecomp.json', json.dumps(pool(['0', '1', '2'], ['3'])))
    arb = pool(['deep-0', 'deep-1'], ['deep-2'])
    arb['pools'] = {'deep': arb['pools']['main'], 'wide': pool(['wide-3'], ['wide-4'])['pools']['main']}
    write(root / 'pools/arb.json', json.dumps(arb))
    write(root / 'pools/bixbench.json', json.dumps(pool(['bix-1', 'bix-2', 'bix-3'], ['bix-9'], capsuleUuids={
        'bix-1': 'uuid-1', 'bix-2': 'uuid-2', 'bix-3': 'uuid-3', 'bix-9': 'uuid-9'})))
    write(root / 'pools/drb.json', json.dumps(pool(['11', '12'], ['13'])))
    write(root / 'pools/rcb.json', json.dumps(pool(['Earth_001'], ['Earth_002'])))
    # --- medcalc
    header = 'Row Number,Calculator ID,Calculator Name,Category,Output Type,Note ID,Note Type,Patient Note,Question,Relevant Entities,Ground Truth Answer,Lower Limit,Upper Limit,Ground Truth Explanation\n'
    rows = [('101', 2, 'Creatinine Clearance', 'decimal', GOLD_MARK, '7.0', '8.5'), ('102', 4, 'Some Score', 'integer', '3', '3', '3'),
            ('103', 2, 'Creatinine Clearance', 'decimal', '12.5', '12.0', '13.0'), ('900', 2, 'Creatinine Clearance', 'decimal', '5', '4', '6'),
            ('901', 2, 'Creatinine Clearance', 'decimal', '5', '4', '6'), ('902', 2, 'Creatinine Clearance', 'decimal', '5', '4', '6')]
    write(root / 'data/medcalc/test_data.csv', header + ''.join(f'{r[0]},{r[1]},{r[2]},lab test,{r[3]},n-{r[0]},Extracted,note {r[0]},question {r[0]},{{}},{r[4]},{r[5]},{r[6]},expl\n' for r in rows))
    # --- mbc
    mbc = [('Ingredient', 'ASPIRIN'), ('Applicant_Full_Name', 'ACME PHARMA'), ('Patent_Expire_Date_Text', '12/31/2031'), ('Ingredient', 'WARFARIN')]
    write(root / 'data/medbrowsecomp/MedBrowseComp_605.csv', 'prompt,gold,task_name\n' + ''.join(f'"{QUESTION_MARK} NCT0000000{i} {t}",{g},{t}\n' for i, (t, g) in enumerate(mbc)))
    # --- arb (line index is the id suffix)
    arb_lines = [{'type': 'deep', 'question': f'{QUESTION_MARK} deep 0', 'answer': ['Alpha Network For Graphs'], 'arxiv_id': ['2401.00001'], 'category': 'Computer Vision'},
                 {'type': 'deep', 'question': f'{QUESTION_MARK} deep 1', 'answer': ['None'], 'arxiv_id': [''], 'category': 'NLP'},
                 {'type': 'deep', 'question': 'deep 2', 'answer': ['Beta'], 'arxiv_id': ['2401.00002'], 'category': 'NLP'},
                 {'type': 'wide', 'question': f'{QUESTION_MARK} wide 3', 'answer': ['One Paper', 'Two Paper'], 'arxiv_id': ['2401.00010', '2401.00011'], 'category': 'NLP'},
                 {'type': 'wide', 'question': 'wide 4', 'answer': ['Three Paper'], 'arxiv_id': ['2401.00012'], 'category': 'NLP'}]
    write(root / 'data/autoresearchbench_data/AutoResearchBench.jsonl', ''.join(json.dumps(r) + '\n' for r in arb_lines))
    # --- bixbench
    def bq(uuid, short, n, mode, ideal, cats='Transcriptomics'):
        return {'question_id': f'{short}-q{n}', 'short_id': short, 'capsule_uuid': uuid, 'question': f'{QUESTION_MARK} {short} q{n}', 'ideal': ideal, 'eval_mode': mode,
                'distractors': ['x'], 'hypothesis': 'h', 'paper': 'p', 'categories': cats, 'data_folder': f'folder-{uuid}'}
    bix = [bq('uuid-1', 'bix-1', 1, 'str_verifier', 'SNP rs42'), bq('uuid-1', 'bix-1', 2, 'range_verifier', '(1.0,2.0)'), bq('uuid-1', 'bix-1', 3, 'llm_verifier', 'enriched in T cells'),
           bq('uuid-2', 'bix-2', 1, 'llm_verifier', 'a'), bq('uuid-2', 'bix-2', 2, 'llm_verifier', 'b'),
           bq('uuid-3', 'bix-3', 1, 'range_verifier', '(5.0,4.0)'), bq('uuid-3', 'bix-3', 2, 'str_verifier', 'yes'),
           bq('uuid-9', 'bix-9', 1, 'str_verifier', 'conf')]
    write(root / 'data/bixbench_meta/BixBench.jsonl', ''.join(json.dumps(r) + '\n' for r in bix))
    # --- drb: judge material is already in the score assets
    assets = root / 'rsi/score/assets/drb'
    queries = []
    for i, lang in (('11', 'en'), ('12', 'zh')):
        prompt = f'{QUESTION_MARK} drb {i}'
        queries.append({'id': int(i), 'prompt': prompt, 'topic': 'Health', 'language': lang})
        criteria = {'id': int(i), 'prompt': prompt, 'dimension_weight': {'comprehensiveness': 0.5, 'insight': 0.5},
                    'criterions': {'comprehensiveness': [{'criterion': 'c0', 'weight': 0.6}, {'criterion': 'c1', 'weight': 0.4}], 'insight': [{'criterion': 'i0', 'weight': 1.0}]}}
        write(assets / 'criteria' / f'{i}.json', json.dumps(criteria))
        write(assets / 'reference' / f'{i}.md', f'reference article {i}')
    write(assets / 'query.jsonl', ''.join(json.dumps(q) + '\n' for q in queries))
    # --- rcb
    write(root / 'data/rcb_meta/Earth_001/task_info.json', json.dumps({'task': f'{QUESTION_MARK} earth task', 'data': []}))
    checklist = [{'type': 'text', 'content': 'text rubric', 'weight': 1.0, 'keywords': ['k']}, {'type': 'image', 'path': './images/fig1.png', 'weight': 1.0, 'content': 'image rubric'}]
    write(root / 'data/rcb_judge/Earth_001/checklist.json', json.dumps(checklist))
    (root / 'data/rcb_judge/Earth_001/images').mkdir(parents=True, exist_ok=True)
    (root / 'data/rcb_judge/Earth_001/images/fig1.png').write_bytes(b'\x89PNG-target')
    return root


ROWS = {'medcalc': ['101', '102', '103'], 'mbc': ['0', '1', '2'], 'arb-deep': ['deep-0', 'deep-1'], 'arb-wide': ['wide-3'], 'bixbench': ['bix-1', 'bix-2', 'bix-3'],
        'drb': ['11', '12'], 'rcb': ['Earth_001']}
KEYS = {'medcalc': 'medcalc', 'mbc': 'medbrowsecomp', 'arb-deep': 'arb', 'arb-wide': 'arb', 'bixbench': 'bixbench', 'drb': 'drb', 'rcb': 'researchclawbench'}


def write_rows(path, rows=None):
    return write(path, json.dumps(rows or ROWS))


# ----------------------------------------------------------------------------------------------------------------- bundles

def bundle(inbox, rid, domain, row, answer='Final answer: 8.0', status='succeeded', error_code=None, files=None, cost=0.01, minutes=1.0, extra_result=None,
           lane=None, key=None, archived=False, tamper=False, meta=None, hostile=False):
    """Write <inbox>/<rid>.tgz (+ .meta.json) as the lanes do: members under <rid>/ : result.json, answer.md, lane.json, files/..."""
    inbox = pathlib.Path(inbox)
    inbox.mkdir(parents=True, exist_ok=True)
    result = {'key': key or f'{KEYS[domain]}/{row}', 'status': status, 'errorCode': error_code, 'durationMs': int(minutes * 60000), 'observedToolCalls': 3,
              'deliveredWithinCap': status == 'succeeded' and bool(answer), 'firstReportAtMs': None, 'lastReport': None, 'effectiveAgentId': 'open-domain-answer',
              'cost': {'cost': cost, 'openCost': 0, 'uncertain': 0}, 'capture': {'transcript': 'ok'}, 'startedAt': '2026-11-01T10:00:00.000Z', 'finishedAt': '2026-11-01T10:01:00.000Z',
              **(extra_result or {})}
    lane_record = {'rid': rid, 'status': status, 'driverExit': 0, 'claimLost': False, 'runtimeKeyless': {'ok': True, 'failures': []}, 'dropped': [], 'kept': 3,
                   'contamination': {'count': 0, 'hits': [], 'names': ['bixbench'], 'scanned': True, 'datasetHostUrls': 0}, **(lane or {})}
    members = {'result.json': json.dumps(result), 'lane.json': json.dumps(lane_record)}
    if answer is not None:
        members['answer.md'] = answer
    for rel, text in (files or {}).items():
        members[f'files/{rel}'] = text
    path = inbox / f'{"done." if archived else ""}{rid}.tgz'
    with tarfile.open(path, 'w:gz') as archive:
        for rel, text in members.items():
            data = text if isinstance(text, bytes) else text.encode('utf-8')
            info = tarfile.TarInfo(f'{rid}/{rel}')
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
        if hostile:  # members a lane never writes: an escape, a link, a file under another run's name
            for name, kind in (('../escape.txt', 'file'), (f'{rid}/link', 'symlink'), ('other-run/result.json', 'file')):
                info = tarfile.TarInfo(name)
                if kind == 'symlink':
                    info.type, info.linkname = tarfile.SYMTYPE, '/etc/passwd'
                    archive.addfile(info)
                else:
                    info.size = 4
                    archive.addfile(info, io.BytesIO(b'evil'))
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    record = {'rid': rid, 'sha256': 'f' * 64 if tamper else digest, 'bytes': path.stat().st_size, 'image': 'base', 'infraRetries': 0, 'worker': 'w1', **(meta or {})}
    (inbox / f'{"done." if archived else ""}{rid}.meta.json').write_text(json.dumps(record))
    return path


def request(rid, domain, row, prompt):
    return {'rid': rid, 'image': 'base', 'item': {'key': f'{KEYS[domain]}/{row}', 'prompt': prompt}, 'probe': {'preamble': None, 'line': None}}
