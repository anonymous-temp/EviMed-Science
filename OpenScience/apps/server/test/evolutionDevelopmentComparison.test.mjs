import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createEvolutionVerificationController } from '../src/evolutionVerificationController.mjs';
import { createEvolutionDevelopmentComparison } from '../src/evolutionDevelopmentComparison.mjs';
const image = 'docker.m.daocloud.io/library/python:3.12-slim-bookworm';
const available = spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }).status === 0;
test('real isolated development agreement beats simplicity; ties select smaller sources and unexecuted options cannot rank', { skip: !available }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'development-comparison-'));
  const controller = createEvolutionVerificationController({ dataDir, evolutionEnabled: true, runtimeContainerBin: 'docker', runtimeContainerImage: image });
  try {
    const implementation = body => ({ id:'tool-example', publicationKind:'isolated-tool', entrypoint: 'scripts/calculate.py:calculate', files: { 'SKILL.md':'Public calculation instructions', 'scripts/calculate.py': body } });
    const wrong = implementation('def calculate(value):\n return 0\n');
    const correct = implementation('def calculate(value):\n intermediate = value * 2\n return intermediate\n');
    const simple = implementation('def calculate(value):\n return value*2\n');
    const compare = createEvolutionDevelopmentComparison({ execute: (body, options) => controller.execute(body, options), verification: { verify: async option => ({ ok: option.entrypoint !== 'invalid' }) } });
    const card = { developmentCases: [{ id: 'public-double', input: { value: 3 }, expected: 6 }] };
    const result = await compare({ ...wrong, alternatives: [correct, { ...simple, entrypoint: 'invalid' }] }, card);
    assert.equal(result.candidate.files['scripts/calculate.py'], correct.files['scripts/calculate.py']);
    assert.equal(result.comparison.options[0].agreement, 0);
    assert.equal(result.comparison.options[1].agreement, 1);
    assert.equal(result.comparison.options[2].executed, false);
    const tied = await compare({ ...correct, alternatives: [simple] }, card);
    assert.equal(tied.candidate.files['scripts/calculate.py'], simple.files['scripts/calculate.py']);
    assert.equal((await compare(correct, card)).comparison.status, 'single-implementation');
  } finally { await controller.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
});

test('declared tight absolute and relative tolerances and output shapes control development ranking', async () => {
  const execute = async body => ({ ok: true, joined: true, executionStarted: true, output: body.files.result });
  const compare = createEvolutionDevelopmentComparison({ execute, verification: { verify: async () => ({ ok: true }) } });
  const option = value => ({ id:'tool-example', publicationKind:'isolated-tool', entrypoint: 'scripts/calculate.py:calculate', files: { 'SKILL.md':'Public calculation instructions', result: JSON.stringify(value) } });
  const primary = { ...option({ value: 1.0000000005 }), alternatives: [option({ value: 1 })] };
  const card = { developmentCases: [{ id: 'tight', input: {}, expected: { value: 1 }, absoluteTolerance: 1e-10 }] };
  const result = await compare(primary, card);
  assert.equal(result.comparison.options[0].agreement, 0);
  assert.equal(result.comparison.options[1].agreement, 1);
  assert.equal(result.candidate.files.result, '{"value":1}');
  const relative = await compare({ ...option({ value: 100.5 }), alternatives: [option({ value: 100, extra: 1 })] }, { developmentCases: [{ id: 'relative', input: {}, expected: { value: 100 }, absoluteTolerance: 0, relativeTolerance: 0.01 }] });
  assert.equal(relative.comparison.options[0].agreement, 1);
  assert.equal(relative.comparison.options[1].agreement, 0);
  for (const tolerance of [-1, '1e-10', null]) {
    const invalid = await compare(primary, { developmentCases: [{ ...card.developmentCases[0], absoluteTolerance: tolerance }] });
    assert.equal(invalid.comparison.status, 'invalid-development-case');
    assert.equal(invalid.comparison.ranked, false);
  }
});

test('smaller executable alternatives without a publishable package cannot outrank the valid delivered primary', async () => {
  let executions=0;
  const primary={id:'tool-diagnostic-example',publicationKind:'isolated-tool',entrypoint:'scripts/calculate.py:calculate',files:{'SKILL.md':'Public complete method instructions that intentionally make this valid package larger.','scripts/calculate.py':'def calculate(value):\n return value*2\n'}};
  const missing={files:{'scripts/calculate.py':'def calculate(value):\n return value*2\n'},entrypoint:primary.entrypoint};
  const malformed={files:{...primary.files,'SKILL.md':'---\nname: invalid-description\n---\nMethod'},entrypoint:primary.entrypoint};
  const before=JSON.stringify(primary);
  const compare=createEvolutionDevelopmentComparison({verification:{verify:async()=>({ok:true})},execute:async()=>{executions++;return{ok:true,joined:true,executionStarted:true,output:'6'};}});
  const result=await compare({...primary,alternatives:[missing,malformed]},{developmentCases:[{id:'public-double',input:{value:3},expected:6}]});
  assert.equal(result.comparison.ranked,true);assert.equal(result.candidate.files['SKILL.md'],primary.files['SKILL.md']);
  assert.equal(result.comparison.options[0].agreement,1);assert.equal(result.comparison.options[1].executed,false);assert.equal(result.comparison.options[2].executed,false);assert.equal(executions,1);
  assert.deepEqual(result.comparison.options[1].packageIssues,[{code:'package_skill_missing',field:'files.SKILL.md',message:'Every published package requires a nonempty SKILL.md.'}]);
  assert.equal(result.comparison.options[2].packageIssues[0].code,'package_skill_frontmatter_invalid');
  assert.equal(JSON.stringify(primary),before);assert.equal(Object.hasOwn(missing.files,'SKILL.md'),false);
});
