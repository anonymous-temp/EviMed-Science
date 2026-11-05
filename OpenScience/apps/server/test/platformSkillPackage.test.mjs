import {publishConfirmed} from './helpers/confirmedEvolutionPublication.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { validatePlatformSkillPackage } from '../src/platformSkillPackage.mjs';
import { createPlatformSkillSupply } from '../src/platformSkillSupply.mjs';
const valid={id:'package',publicationKind:'isolated-tool',entrypoint:'scripts/calculate.py:calculate',files:{'SKILL.md':'Public instructions','scripts/calculate.py':'def calculate():\n return 1'}};
test('publisher and public package validator agree on missing docs, malformed frontmatter and invalid isolated entrypoint',async t=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'package-contract-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 const supply=createPlatformSkillSupply({dataDir,evolutionEnabled:true});
 const failures=[{...valid,files:{'scripts/calculate.py':valid.files['scripts/calculate.py']}},{...valid,files:{...valid.files,'SKILL.md':'---\nname: present\n---\nText'}},{...valid,entrypoint:'outside.py:calculate'}];
 for(const candidate of failures){
  const result=validatePlatformSkillPackage(candidate);assert.equal(result.ok,false);
  await assert.rejects(publishConfirmed(supply,candidate,{card:{toolKind:'calculation'},evaluation:{ok:true,verificationLevel:'V2'}}),error=>error.code==='extension_contract_invalid'&&error.message.includes(result.issues[0].field));
 }
 assert.equal(validatePlatformSkillPackage(valid).ok,true);
 assert.equal((await publishConfirmed(supply,valid,{card:{toolKind:'calculation'},evaluation:{ok:true,verificationLevel:'V2'}})).id,'package');
});
