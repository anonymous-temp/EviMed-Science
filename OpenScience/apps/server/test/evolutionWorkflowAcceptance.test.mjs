import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {workflowAcceptanceFixture,runEvolutionWorkflowAcceptance} from '../../../scripts/ops/evolution-workflow-acceptance.mjs';
test('workflow live acceptance plans an existing offline tool with only synthetic input and cannot silently execute',()=>{
 const fixture=workflowAcceptanceFixture();assert.deepEqual(fixture.candidate.executionTools,['evidence_deduplicate']);assert.deepEqual(Object.keys(fixture.candidate.files),['SKILL.md']);assert.equal(fixture.input.items.length,3);assert.equal(fixture.input.expected,undefined);assert.throws(()=>workflowAcceptanceFixture('../escape'));
 const result=spawnSync(process.execPath,['scripts/ops/evolution-workflow-acceptance.mjs'],{cwd:new URL('../../../',import.meta.url),encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).scored,false);
});
test('live workflow acceptance refuses an ordinary deployment before dispatch or publication',async()=>{await assert.rejects(runEvolutionWorkflowAcceptance({app:{config:{dataDir:'/production',databaseUrl:'production'}}}));});
