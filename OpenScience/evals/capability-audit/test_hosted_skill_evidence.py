"""Adversarial controls for hosted bounded-method receipt validation."""
import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from hosted_skill_evidence import validate_row

class HostedSkillEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.repo=Path(self.temp.name)
        self.body='# Bounded method\nTransform source into an estimate.\n'
        self.package={'id':'core/fixture','manifest':'skill/SKILL.md'}
        self.receipt('skill/SKILL.md',self.body)
        self.package['manifestSha256']=hashlib.sha256(self.body.encode()).hexdigest()
        self.output=self.receipt('retained/output.json','{"estimate":17}\n');self.output['workspaceRelativePath']='task/output.json'
        self.row={'packageId':'core/fixture','manifestSha256':self.package['manifestSha256'],'passed':True,
            'scope':{'projectId':'default','workspaceRelativePath':'.r/workspace','sessionId':'session-1','runId':'run-1'},
            'runReceipt':self.receipt('retained/run.json',json.dumps({'id':'run-1','sessionId':'session-1','projectId':'default','status':'succeeded'})),
            'dispatch':{'kind':'control-plane-injected','bodyReceipt':self.receipt('retained/body.md',self.body)},
            'inputReceipts':[self.receipt('retained/input.json','{"x":8,"y":9}\n')],'artifacts':[self.output],
            'toolExecutions':[{'name':'bash','callId':'call-1','status':'succeeded','outputReceipts':[self.output]}],
            'assertions':[{'artifact':self.output,'operation':'json-equals','keys':['estimate'],'value':17}]}
        self.transcript={'sessionId':'session-1','messages':[
            {'role':'user','parts':[{'type':'text','text':self.body}]},
            {'role':'tool','parts':[{'type':'tool','tool':'bash','callId':'call-1','status':'completed','error':None,'input':{'command':'python calculate.py task/output.json'},'output':'wrote task/output.json'}]}]}
        self.save_transcript()
    def tearDown(self):self.temp.cleanup()
    def receipt(self,name,text):
        p=self.repo/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text)
        return {'path':name,'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
    def save_transcript(self):self.row['transcriptReceipt']=self.receipt('retained/transcript.json',json.dumps(self.transcript))
    def test_current_body_actual_operation_and_content(self):
        result=validate_row(self.repo,self.package,self.row)
        self.assertEqual(result['state'],'bounded-hosted-task-matched');self.assertEqual(result['currentImageExecution'],'unknown')
    def test_controls_reject_false_qualification(self):
        mutations=[lambda r:r.update(manifestSha256='stale'),lambda r:r['scope'].update(sessionId='other'),lambda r:r['scope'].update(workspaceRelativePath='../escape'),lambda r:r['dispatch'].update(kind='delegated-skill-tool'),lambda r:r['toolExecutions'][0].update(callId='invented'),lambda r:r['toolExecutions'][0].update(name='read'),lambda r:r['toolExecutions'][0].update(outputReceipts=[]),lambda r:r.update(assertions=[]),lambda r:r['assertions'][0].update(value=18),lambda r:r['artifacts'][0].update(sha256='changed')]
        for mutate in mutations:
            row=copy.deepcopy(self.row);mutate(row)
            with self.subTest(row=row),self.assertRaises(ValueError):validate_row(self.repo,self.package,row)
    def test_missing_project_field_requires_real_registry_scope(self):
        self.row['runReceipt']=self.receipt('retained/run.json',json.dumps({'id':'run-1','sessionId':'session-1','status':'succeeded'}))
        with self.assertRaises(ValueError):validate_row(self.repo,self.package,self.row)
        self.row['sessionRegistryReceipt']=self.receipt('retained/registry.json',json.dumps({'request':{'method':'GET','path':'/api/research-sessions','projectId':'default'},'response':[{'sessionId':'session-1'}]}))
        self.row['projectReceipt']=self.receipt('retained/projects.json',json.dumps([{'id':'default'}]))
        self.assertEqual(validate_row(self.repo,self.package,self.row)['state'],'bounded-hosted-task-matched')
        self.row['sessionRegistryReceipt']=self.receipt('retained/registry.json',json.dumps({'request':{'method':'GET','path':'/api/research-sessions','projectId':'other'},'response':[{'sessionId':'session-1'}]}))
        with self.assertRaises(ValueError):validate_row(self.repo,self.package,self.row)

    def test_literal_shell_cwd_binds_only_exact_output_basename(self):
        part=self.transcript['messages'][1]['parts'][0]
        part['input']={'command':"cd /workspace/task && python3 - <<'EOF'\nwrite('output.json')\nEOF"}
        part['output']='done';self.save_transcript()
        self.assertEqual(validate_row(self.repo,self.package,self.row)['state'],'bounded-hosted-task-matched')
        part['input']['command']=part['input']['command'].replace('/workspace/task','/workspace/other');self.save_transcript()
        with self.assertRaises(ValueError):validate_row(self.repo,self.package,self.row)

    def test_catalogue_is_not_loaded_body(self):
        self.transcript['messages'][0]['parts'][0]['text']='Skill fixture is available.';self.save_transcript()
        with self.assertRaises(ValueError):validate_row(self.repo,self.package,self.row)
    def test_failed_tool_cannot_certify_method(self):
        self.transcript['messages'][1]['parts'][0]['error']='failure';self.save_transcript()
        with self.assertRaises(ValueError):validate_row(self.repo,self.package,self.row)
if __name__=='__main__':unittest.main()
