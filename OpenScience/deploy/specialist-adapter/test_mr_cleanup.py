"""Actual restricted-UID scratch cleanup; cached Linux only, no model/network."""
from __future__ import annotations

import os
import subprocess
import uuid
from pathlib import Path

import pytest


@pytest.mark.skipif(not os.getenv("EVIMED_AUDIT_CONTAINER_TEST_IMAGE"), reason="explicit cached Linux image required")
@pytest.mark.parametrize("mode", ["succeeded", "failed", "signal", "timeout", "worker_signal", "cleanup_failed", "preparation_failed", "succeeded_descendant", "failed_descendant", "signal_descendant", "timeout_descendant", "worker_signal_descendant"])
def test_analysis_owned_private_directories_preserve_outcome_and_cleanup(mode):
    repo = Path(__file__).resolve().parents[3]
    script = r'''
import json,os,signal,sys,threading,time
from pathlib import Path
sys.path[:0]=['/src/OpenScience/deploy/specialist-adapter','/src/项目代码/孟德尔随机化']
from evimed_specialist_adapter import audit_receipt
import evimed_mr_job as jobs
import evimed_local_inputs as inputs
requested_mode=MODE
with_descendant=requested_mode.endswith("_descendant")
mode=requested_mode.removesuffix("_descendant")
key=Path('/run/test-key');key.write_bytes(b'test-only-key');key.chmod(0o400)
os.environ['EVIMED_SPECIALIST_AUDIT_SIGNING_KEY_FILE']=str(key)
workspace=Path('/data/users/u/projects/p/workspace');workspace.mkdir(parents=True)
output=workspace/'mendelian-randomization-runs/mr-cleanup-test/output';output.mkdir(parents=True)
runner=Path('/agent/evimed_runner.py')
runner_body="import json,os,signal,subprocess,sys,tempfile,time\nfrom pathlib import Path\nos.fchdir(int(sys.argv[-1]))\nassert os.getuid()==65532\nanalysis=Path(tempfile.mkdtemp(prefix='mr_analysis_'))\nassert analysis.stat().st_mode&0o777==0o700\n(analysis/'result.csv').write_text('estimate,pvalue\\n0.2,0.01\\n')\nmode="+repr(mode)+"\n"
if with_descendant:
 descendant_code="import signal,time;from pathlib import Path;signal.signal(signal.SIGTERM,signal.SIG_IGN);Path('/tmp/descendant-ready').touch();time.sleep(60)"
 runner_body+="child=subprocess.Popen([sys.executable,'-c',"+repr(descendant_code)+"])\nPath('/tmp/descendant-pid').write_text(str(child.pid));Path('/tmp/descendant-pid').chmod(0o644)\nwhile not Path('/tmp/descendant-ready').exists(): time.sleep(.01)\n"
runner_body+="if mode in {'timeout','worker_signal'}: time.sleep(60)\nif mode=='cleanup_failed': analysis.chmod(0o000)\nPath('result.json').write_text(json.dumps({'status':'failed','error':'deliberate-analysis-failure'} if mode=='failed' else {'status':'succeeded'}))\nif mode=='signal': os.kill(os.getpid(),signal.SIGTERM)\nsys.exit(7 if mode=='failed' else 0)\n"
runner.write_text(runner_body)
request={'exposure':'BMI','outcome':'CHD'}
if mode=='preparation_failed':
 source={'type':'local_file','columnMapping':{'snp':'SNP','beta':'beta','se':'se','effect_allele':'effect_allele','other_allele':'other_allele','eaf':'eaf','pval':'pval'},'sampleSize':10000,'instrumentsPreclumped':True,'clumpingProvenance':'Provided independent instruments; LD not rechecked.'}
 for role in ('exposure','outcome'):
  path=workspace/(role+'.csv');path.write_text('SNP,beta,se,effect_allele,other_allele,eaf,pval\n'+('rs1,0.2,0.01,A,G,0.2,1e-10\n' if role=='exposure' else ''))
  request[role+'Source']={**source,'path':path.name}
bindings=inputs.capture_bindings(workspace,request,Path('/data'))
job=jobs.Job(workspace=workspace,output_root=output,data_root=Path('/data'),request=request,bindings=bindings,python=sys.executable,runner=runner,timeout=1 if mode=='timeout' else 10)
if mode=='worker_signal':
 def interrupt():
  for _ in range(100):
   if (not with_descendant or Path('/tmp/descendant-ready').exists()) and any(list(p.glob('mr_analysis_*')) for p in Path('/tmp').glob('evimed-mr-scratch-*')):
    os.kill(os.getpid(),signal.SIGTERM);return
   time.sleep(.02)
  raise AssertionError('runner never started')
 threading.Thread(target=interrupt,daemon=True).start()
try:
 outcome=jobs.execute(inputs,job,{},analysis_credentials=audit_receipt.analysis_credentials())
except inputs.MRInputError as error:
 assert mode=='preparation_failed'
 assert not getattr(error,'cleanup_error',None)
 outcome={'returnCode':1,'result':{'status':'failed'}}
if mode in {'succeeded','cleanup_failed'}:
 assert outcome['returnCode']==0 and outcome['result']['status']=='succeeded',outcome
 assert json.loads((output/'result.json').read_text())['status']=='succeeded'
else:
 assert outcome['returnCode']!=0 and outcome['result']['status']=='failed',outcome
 if mode=='failed': assert outcome['returnCode']==7 and outcome['result']['error']=='deliberate-analysis-failure'
 if mode=='timeout': assert outcome['result']['errorCode']=='mr_analysis_timeout'
 if mode in {'signal','worker_signal'}: assert outcome['result']['errorCode']=='mr_analysis_interrupted'
remaining=[*Path('/tmp').glob('evimed-mr-scratch-*'),*Path('/tmp').glob('evimed-mr-job-*')]
if mode=='cleanup_failed':
 assert outcome['cleanupError']['code']=='mr_analysis_cleanup_failed',outcome
 assert str(remaining[0]) not in json.dumps(outcome['cleanupError'])
else:
 assert not remaining,[(str(p),oct(p.stat().st_mode&0o777)) for p in remaining]
 assert 'cleanupError' not in outcome
if with_descendant:
 descendant=int(Path('/tmp/descendant-pid').read_text())
 proc=Path('/proc')/str(descendant)/'stat'
 state=proc.read_text().rsplit(')',1)[1].split()[0] if proc.exists() else None
 assert state in {None,'Z','X'}, {'descendantStillRunning':True,'state':state,'outcome':outcome}
print('verified-cleanup-'+requested_mode)
'''.replace("MODE", repr(mode))
    name = "evimed-mr-cleanup-test-" + uuid.uuid4().hex[:16]
    command = ["docker", "run", "--name", name, "--rm", "--pull", "never", "--network", "none", "--read-only",
        "--cap-drop", "ALL", "--cap-add", "SETUID", "--cap-add", "SETGID", "--security-opt", "no-new-privileges:true",
        "--tmpfs", "/tmp", "--tmpfs", "/run", "--tmpfs", "/data", "--tmpfs", "/agent",
        "--mount", f"type=bind,src={repo},dst=/src,readonly",
        os.environ["EVIMED_AUDIT_CONTAINER_TEST_IMAGE"], "python", "-c", script]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=20)
        assert result.returncode == 0, result.stderr
        assert "verified-cleanup-" + mode in result.stdout
    finally:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True, timeout=10, check=False)
