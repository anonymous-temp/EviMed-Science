import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPlatformSkillSupply } from '../src/platformSkillSupply.mjs';

test('republishing a certified historical instruction template preserves its immutable runtime bytes', async () => {
  const dataDir=await mkdtemp(path.join(tmpdir(),'evolution-binding-legacy-'));
  try{
    const moduleUrl=new URL('../src/platformSkillSupply.mjs',import.meta.url);
    const legacySource=(await readFile(moduleUrl,'utf8')).replace('with a JSON object of named function arguments on stdin:', 'with JSON input on stdin:')
      .replace(/from '(\.\/[^']+)'/g,(_match,relative)=>`from '${new URL(relative,moduleUrl).href}'`)
      .replace("from '@evimed/domain'",`from '${new URL('../../../packages/domain/index.mjs',import.meta.url).href}'`);
    const legacy=await import(`data:text/javascript;base64,${Buffer.from(legacySource).toString('base64')}`);
    const config={dataDir,evolutionEnabled:true},candidate={id:'legacy-binding',publicationKind:'isolated-tool',entrypoint:'scripts/tool.py:calculate',files:{'SKILL.md':'---\nname: legacy-binding\ndescription: Legacy binding fixture.\n---\n\nUse calculate(specification).','scripts/tool.py':'def calculate(specification):\n return specification\n'}},options={card:{toolKind:'calculation'},evaluation:{ok:true,verificationLevel:'V2'}};
    const oldSupply=legacy.createPlatformSkillSupply(config),original=await oldSupply.publish(candidate,options),oldGeneration=await oldSupply.prepareForRuntime({id:'project'});
    const current=createPlatformSkillSupply(config),repeated=await current.publish(candidate,options),newGeneration=await current.prepareForRuntime({id:'project'});
    assert.equal(repeated.digest,original.digest);assert.equal(repeated.revision,original.revision);
    assert.deepEqual(newGeneration.pins,oldGeneration.pins);
  }finally{await rm(dataDir,{recursive:true,force:true});}
});

test('actual Python binding reports parameter names and received keys without values or implementation exceptions', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'evolution-binding-'));
  const supply = createPlatformSkillSupply({ dataDir, evolutionEnabled: true });
  const source = "def calculate(specification):\n if specification.get('explode'): raise ValueError('private-implementation-detail')\n return {'result': specification['n']}\n";
  try {
    const candidate = { id: 'binding-fixture', publicationKind: 'isolated-tool', entrypoint: 'scripts/tool.py:calculate', files: { 'SKILL.md': '---\nname: binding-fixture\ndescription: Public binding fixture.\n---\n\nUse calculate(specification).', 'scripts/tool.py': source } };
    const publication = await supply.publish(candidate, { card: { toolKind: 'calculation' }, evaluation: { ok: true, verificationLevel: 'V2' } });
    const repeated = await supply.publish(candidate, { card: { toolKind: 'calculation' }, evaluation: { ok: true, verificationLevel: 'V2' } });
    assert.equal(repeated.digest, publication.digest);
    assert.equal(repeated.revision, publication.revision);
    const generation = await supply.prepareForRuntime({ id: 'project' });
    const root = path.join(dataDir, 'candidate'); await mkdir(path.join(root, 'scripts'), { recursive: true }); await writeFile(path.join(root, 'scripts/tool.py'), source);
    const execute = async body => {
      const result = spawnSync('python3', ['-c', body.code.replace('/candidate/', root + '/')], { input: JSON.stringify(body.input), encoding: 'utf8' });
      return { ok: result.status === 0, output: result.stdout };
    };
    const invoke = args => supply.executeIsolated({}, { toolId: publication.id, digest: publication.digest, args }, execute, { pins: generation.pins });
    assert.deepEqual(await invoke({ specification: { n: 200 } }), { result: 200 });
    for (const args of [{ n: 'private-input-value' }, {}]) {
      await assert.rejects(invoke(args), error => {
        assert.equal(error.code, 'extension_contract_invalid');
        assert.deepEqual(error.argumentBinding, { code: 'argument-binding-invalid', expectedParameters: ['specification'], receivedKeys: Object.keys(args) });
        assert.equal(JSON.stringify(error).includes('private-input-value'), false);
        return true;
      });
    }
    await assert.rejects(invoke({ specification: { explode: true } }), error => {
      assert.equal(error.code, 'extension_contract_invalid');
      assert.equal(error.details, undefined);
      assert.equal(error.message.includes('private-implementation-detail'), false);
      return true;
    });
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
