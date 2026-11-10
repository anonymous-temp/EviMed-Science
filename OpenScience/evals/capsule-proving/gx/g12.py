"""Run existing product suites serially via the owner's lab-test script; retain its TAP tails."""
import json,re,subprocess,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
OUT='/srv/evimed/runs/gx-g12-1'
def remote(path,text):
    subprocess.run(['ssh','evimed-lab',f'mkdir -p {OUT}/logs && cat > {OUT}/{path}'],input=text,text=True,check=True,capture_output=True)
files=sorted({*ROOT.glob('apps/server/test/capsule*.test.mjs'),*ROOT.glob('apps/server/test/officialPack*.test.mjs'),*ROOT.glob('apps/server/test/officialPromotion*.test.mjs')})
results=[]; start=time.time()
for file in files:
    name=file.name
    area=('official-packs' if name.startswith('officialPack') else 'promotion-gate' if name.startswith('officialPromotion') else
          'sharing-versions-revocation' if any(x in name for x in ['Share','Sharing','Sender','Recipient','Sharer','Publication']) else
          'transfer-import-export' if any(x in name for x in ['Transfer','NativeExport']) else
          'container-tamper-sealing' if any(x in name for x in ['Container','Kdf','Scan']) else 'capsule-lifecycle')
    p=subprocess.run(['/home/coder/evimed-wt/memrun-brief/lab-test.sh','int',str(file.relative_to(ROOT))],capture_output=True,text=True)
    raw=p.stdout+p.stderr
    counts={k:int(v) for k,v in re.findall(r'^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$',raw,re.M)}
    row={'file':str(file.relative_to(ROOT)),'area':area,'exitCode':p.returncode,**counts}
    if 'tests' not in counts: row['infrastructureError']=True
    results.append(row); remote('logs/'+name+'.log',raw)
    summary={'automated':True,'files':len(files),'completedFiles':len(results),'wallSeconds':time.time()-start,'results':results,'areas':{}}
    for r in results:
        a=summary['areas'].setdefault(r['area'],{'files':0,'tests':0,'pass':0,'fail':0,'cancelled':0,'skipped':0,'infrastructureErrors':0})
        a['files']+=1
        for k in ['tests','pass','fail','cancelled','skipped']: a[k]+=r.get(k,0)
        a['infrastructureErrors']+=bool(r.get('infrastructureError'))
    remote('summary.json',json.dumps(summary,indent=2)+'\n')
    print(json.dumps(row),flush=True)
