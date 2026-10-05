import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createPlatformSkillSupply,platformSkillGenerationRoot} from '../src/platformSkillSupply.mjs';

test('unknown scope and libraries over thirty expose one search entry with scoped results',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'platform-search-')),config={dataDir,evolutionEnabled:true};
  const pins=Array.from({length:32},(_,index)=>({id:`method-${index}`,revision:1,digest:`sha256:${index.toString(16).padStart(64,'0')}`,nativeName:`platform-${index.toString(16).padStart(24,'0')}`,publicationKind:'skill',capabilityIds:index===31?['other']:['statistics'],track:index===31?'P':'M',content:{'SKILL.md':`---\nname: method-${index}\ndescription: Numerical method ${index}.\n---\n\nInstructions ${index}.`}}));
  const supply=createPlatformSkillSupply(config,{listActive:async()=>pins});
  try{
    const generation=await supply.prepareForRuntime({id:'project',capabilityId:'statistics',track:'M'});
    assert.equal(generation.pins.length,32);assert.ok(!generation.pins.some(pin=>pin.id==='method-31'));
    assert.equal(generation.pins.filter(pin=>pin.files.some(file=>file.path==='SKILL.md')).length,1);
    const search=generation.pins.find(pin=>pin.id==='platform-tool-search');
    const script=path.join(platformSkillGenerationRoot(config,generation.reference),'skills',search.nativeName,'scripts/search_tools.py');
    const result=spawnSync('python3',[script,'--capability','statistics','--query','Numerical method 7'],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
    const output=JSON.parse(result.stdout);assert.equal(output.tools.length,30);assert.ok(output.tools.every(tool=>tool.capabilityIds.includes('statistics')));assert.ok(output.tools.every(tool=>tool.file.endsWith('/INSTRUCTIONS.md')));
    const unscoped=await supply.prepareForRuntime({id:'project'});assert.equal(unscoped.pins.filter(pin=>pin.files.some(file=>file.path==='SKILL.md')).length,1);
    const limited=await supply.prepareForRuntime({id:'project',capabilityId:'other',track:'P'});assert.deepEqual(limited.pins.map(pin=>pin.id),['method-31']);
  }finally{await fs.rm(dataDir,{recursive:true,force:true});}
});

test('generation capacity reserves one search pin and rejects oversized libraries before writing', async () => {
  const { PLATFORM_SKILL_GENERATION_MAX_PINS, PLATFORM_SKILL_MAX_TOOLS } = await import('../src/platformSkillLimits.mjs');
  assert.equal(PLATFORM_SKILL_MAX_TOOLS + 1, PLATFORM_SKILL_GENERATION_MAX_PINS);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'platform-search-limit-'));
  const supply = createPlatformSkillSupply({ dataDir, evolutionEnabled: true }, { listActive: async () => Array.from({ length: PLATFORM_SKILL_MAX_TOOLS + 1 }, () => ({})) });
  try {
    await assert.rejects(supply.prepareForRuntime({ id: 'project' }), error => error.code === 'extension_contract_invalid');
    assert.deepEqual(await fs.readdir(dataDir), []);
  } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
});
