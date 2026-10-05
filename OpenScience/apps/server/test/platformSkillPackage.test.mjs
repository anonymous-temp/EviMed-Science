import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { validatePlatformSkillPackage } from '../src/platformSkillPackage.mjs';
import { createPlatformSkillSupply } from '../src/platformSkillSupply.mjs';
import { createEvolutionBuilder } from '../src/evolutionBuild.mjs';
const valid={id:'package',publicationKind:'isolated-tool',entrypoint:'scripts/calculate.py:calculate',files:{'SKILL.md':'Public instructions','scripts/calculate.py':'def calculate():\n return 1'}};
test('publisher and public package validator agree on missing docs, malformed frontmatter and invalid isolated entrypoint',async t=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'package-contract-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 const supply=createPlatformSkillSupply({dataDir,evolutionEnabled:true});
 const failures=[{...valid,files:{'scripts/calculate.py':valid.files['scripts/calculate.py']}},{...valid,files:{...valid.files,'SKILL.md':'---\nname: present\n---\nText'}},{...valid,entrypoint:'outside.py:calculate'}];
 for(const candidate of failures){
  const result=validatePlatformSkillPackage(candidate);assert.equal(result.ok,false);
  await assert.rejects(supply.publish(candidate,{card:{toolKind:'calculation'},evaluation:{ok:true,verificationLevel:'V2'}}),error=>error.code==='extension_contract_invalid'&&error.message.includes(result.issues[0].field));
 }
 assert.equal(validatePlatformSkillPackage(valid).ok,true);
 assert.equal((await supply.publish(valid,{card:{toolKind:'calculation'},evaluation:{ok:true,verificationLevel:'V2'}})).id,'package');
});
test('single candidate public package defect produces precise repair feedback before hidden evaluation',async()=>{
 let evaluations=0;const failures=[];
 const candidate={...valid,files:{'scripts/calculate.py':valid.files['scripts/calculate.py']}};
 const result=await createEvolutionBuilder({dispatch:async()=>candidate,verification:{verify:async()=>({ok:true})},evaluator:{evaluate:async()=>{evaluations++;throw Error('must not evaluate invalid package');}},publisher:{publish:async()=>{throw Error('must not publish invalid package');}},recordFailure:async failure=>failures.push(failure)}).build({id:'card'});
 assert.equal(result.status,'repair');assert.equal(evaluations,0);assert.equal(result.feedback.issues[0].field,'files.SKILL.md');assert.equal(result.feedback.issueCodes[0],'package_skill_missing');assert.equal(failures[0].gapCode,'method-implementation');assert.equal(Object.hasOwn(candidate.files,'SKILL.md'),false);
});
