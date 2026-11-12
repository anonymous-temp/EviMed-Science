"""One explicitly supervised, development-only few-shot diagnostic; no product activation."""
import argparse
from concurrent.futures import ThreadPoolExecutor,as_completed
import hashlib,json,sys,time
from pathlib import Path
from run import payload,ProviderClient,request_digest,write_json,model_matches
from score import score

GUIDANCE='''Clinical calibration: a trial's target disease is not evidence that the patient has it. Symptoms, possible diagnoses and planned procedures do not establish a confirmed diagnosis, required severity or completed intervention. Check every qualifier, indication and AND/OR condition. Keep applicability separate from whether a criterion is met. The reference examples below use this public benchmark's annotation convention; they are training examples, not new facts about the patient being assessed. Return only the original requested JSON for the current patient and criterion IDs.'''

def prepare(base,prepared,gold_file,out):
    f=json.loads((base/'FROZEN.json').read_text());t=json.loads((base/'TARGETS.json').read_text())
    if hashlib.sha256((prepared/'requests.json').read_bytes()).hexdigest()!=f['prepared_sha256']:raise ValueError('Base inputs differ')
    if hashlib.sha256((base/'FROZEN.json').read_bytes()).hexdigest()!=t['protocol_sha256']:raise ValueError('Base target binding differs')
    if hashlib.sha256(gold_file.read_bytes()).hexdigest()!=t['gold_sha256']:raise ValueError('Target bytes differ')
    rows=json.loads((prepared/'requests.json').read_text());gold=json.loads(gold_file.read_text())
    dev=set(f['dev_patients']);evaluation=set(f['evaluation_patients']);assert not dev&evaluation
    examples=[]
    for kind,lab in [('inclusion','included'),('inclusion','not included'),('exclusion','excluded'),('exclusion','not excluded'),('exclusion','not applicable'),('inclusion','not enough information')]:
        candidates=[r for r in gold if r['patient_id']in dev and r['criterion_type']==kind and r['expert_eligibility']==lab and isinstance(r['criterion_text'],str) and len(r['criterion_text'])>=5]
        if not candidates:continue
        r=min(candidates,key=lambda x:hashlib.sha256(f"calibration-v1-{x['annotation_id']}".encode()).hexdigest())
        examples.append({'training_patient_id':r['patient_id'],'annotation_id':r['annotation_id'],'patient_note':r['note'],'trial_title':r['trial_title'],'criterion_type':kind,'criterion':r['criterion_text'],'answer':["Reference annotation for this training example.",json.loads(r['expert_sentences']),lab]})
    supplement=GUIDANCE+'\nREFERENCE TRAINING EXAMPLES:\n'+json.dumps(examples,ensure_ascii=False)
    bodies={}
    for row in rows:
        b=payload(row,'original_flash');b['messages'][0]['content']+='\n\n'+supplement;bodies[row['id']]=b
    protocol={'registered_at_epoch':time.time(),'designation':'Post-primary supervised public regression diagnostic, not zero-shot replication or independent clinical validation','dev_patients':f['dev_patients'],'evaluation_patients':f['evaluation_patients'],'examples':examples,'guidance':GUIDANCE,'requests_sha256':hashlib.sha256((prepared/'requests.json').read_bytes()).hexdigest(),'gold_sha256':t['gold_sha256'],'requests':{k:request_digest('deepseek',v) for k,v in bodies.items()}}
    write_json(out/'FROZEN.json',protocol);write_json(out/'payloads.json',bodies)
    write_json(out/'TARGETS.json',{'gold_sha256':t['gold_sha256'],'protocol_sha256':hashlib.sha256((out/'FROZEN.json').read_bytes()).hexdigest()})
    return rows,bodies,protocol

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--base',type=Path,required=True);p.add_argument('--prepared',type=Path,required=True);p.add_argument('--gold',type=Path,required=True);p.add_argument('--out',type=Path,required=True);a=p.parse_args();a.out.mkdir(parents=True,exist_ok=True)
    if (a.out/'FROZEN.json').exists():
        rows=json.loads((a.prepared/'requests.json').read_text());bodies=json.loads((a.out/'payloads.json').read_text());f=json.loads((a.out/'FROZEN.json').read_text())
    else:rows,bodies,f=prepare(a.base,a.prepared,a.gold,a.out)
    if hashlib.sha256((a.prepared/'requests.json').read_bytes()).hexdigest()!=f['requests_sha256']:raise ValueError('Frozen calibrated input differs')
    target=json.loads((a.out/'TARGETS.json').read_text())
    if hashlib.sha256((a.out/'FROZEN.json').read_bytes()).hexdigest()!=target['protocol_sha256']:raise ValueError('Calibration target binding differs')
    bound_gold=target['gold_sha256']
    if hashlib.sha256(a.gold.read_bytes()).hexdigest()!=bound_gold:raise ValueError('Frozen calibration targets differ')
    client=ProviderClient(a.out/'receipts')
    def one(row):
        b=bodies[row['id']]
        if request_digest('deepseek',b)!=f['requests'][row['id']]:raise ValueError('Frozen request differs')
        r=client.request('deepseek','deepseek-v4-flash',b,'cal-'+hashlib.sha256(row['id'].encode()).hexdigest()[:20])
        if r['status']in[401,402,403]:raise ValueError('Provider refused')
        return row['id'],r
    receipts={}
    with ThreadPoolExecutor(max_workers=4)as pool:
        for task in as_completed([pool.submit(one,r)for r in rows]):
            k,v=task.result();receipts[k]=v
    valid={k:v['body']for k,v in receipts.items()if v['status']==200 and not v['error'] and model_matches('deepseek','deepseek-v4-flash',(v.get('body')or{}).get('model'))}
    gold=json.loads(a.gold.read_text());result={part:score(rows,valid,gold,patients)for part,patients in [('all',None),('dev',f['dev_patients']),('evaluation',f['evaluation_patients'])]}
    result['requests']={'attempted':len(receipts),'cost_cny':sum(v['cost']or 0 for v in receipts.values()),'failed':sum(bool(v['error'])for v in receipts.values())};write_json(a.out/'summary.json',result)
    print(json.dumps({k:result[k]['accuracy']for k in ['all','dev','evaluation']}))
