import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {RECEIPT_FORMAT_VERSION} from '@evimed/domain';
import {transcriptPath,TRANSCRIPT_SCHEMA_VERSION} from '../src/runTranscripts.mjs';
import {createEvolutionScorerEvidence} from '../src/evolutionScorerEvidence.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
test('production scorer evidence reads exact delivered Python as text and JSON as numeric with receipt hashes',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'scorer-evidence-'));
 try{
  const project={id:'eval-paper-audit',rootDir:root,workspaceDir:path.join(root,'workspace'),metaDir:path.join(root,'.openscience')};
  await fs.mkdir(project.workspaceDir,{recursive:true});await fs.mkdir(path.dirname(transcriptPath(project,'run-audit')),{recursive:true});
  const code='def calculate():\n return 2\n',json=JSON.stringify({analysis:{estimate:2}}),run={id:'run-audit',artifacts:[{path:'code.py'},{path:'numeric.json'}]};
  await fs.writeFile(path.join(project.workspaceDir,'code.py'),code);await fs.writeFile(path.join(project.workspaceDir,'numeric.json'),json);
  const receipt={formatVersion:RECEIPT_FORMAT_VERSION,runId:run.id,bundleVersion:'1',domainVersion:'1',entries:[{deliverableId:'audit-delivery',contractKind:'evolution-tool-candidate',capability:'statistical-analysis',acceptedAt:new Date().toISOString(),files:[{path:'code.py',sha256:sha(code),bytes:Buffer.byteLength(code)},{path:'numeric.json',sha256:sha(json),bytes:Buffer.byteLength(json)}]}]};
  await fs.writeFile(path.join(project.workspaceDir,'delivery-receipt.json'),JSON.stringify(receipt));
  const transcript={schemaVersion:TRANSCRIPT_SCHEMA_VERSION,runId:run.id,completeness:'complete',missing:[]};
  await fs.writeFile(transcriptPath(project,run.id),JSON.stringify(transcript)+'\n');
  const read=createEvolutionScorerEvidence({service:{owner:async()=>'operator'},store:{userById:async()=>({id:'operator'}),requireProject:async()=>project},agentRuns:{list:async()=>[run]},timeoutMs:10});
  const actual=await read({producerProjectId:project.id,producerRunId:run.id});
  assert.equal(actual.deliveredText.find(row=>row.path==='code.py').text,code);assert.equal(actual.numeric['analysis.estimate'],2);assert.equal(actual.completeDurableTranscript,true);assert.equal(actual.traceCoverage.complete,true);
  await fs.writeFile(path.join(project.workspaceDir,'code.py'),'changed producer code');
  const changed=await read({producerProjectId:project.id,producerRunId:run.id});assert.ok(changed.artifactIssues.length);assert.equal(changed.deliveredText.some(row=>row.path==='code.py'),false);
  await fs.writeFile(transcriptPath(project,run.id),JSON.stringify(transcript)+'\n'+JSON.stringify({parts:[{type:'tool',tool:'mcp__evimed__meta_analysis',input:{action:'start'}}]})+'\n');
  assert.equal((await read({producerProjectId:project.id,producerRunId:run.id})).traceCoverage.complete,false);
  const composition=await fs.readFile(new URL('../src/evolutionComposition.mjs',import.meta.url),'utf8');
  assert.ok(composition.includes('readEvidence:createEvolutionScorerEvidence({service,store,agentRuns})'));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
