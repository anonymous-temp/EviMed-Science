import {loadConfig} from '../src/config.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { EVOLUTION_CONFIG_SCHEMA, validateEvolutionConfiguration } from '../src/evolutionConfiguration.mjs';

test('evolution deployment defaults fit their closed resource bounds', () => {
  assert.deepEqual(validateEvolutionConfiguration({evolutionEnabled:false}),[]);
  for(const [key,field] of Object.entries(EVOLUTION_CONFIG_SCHEMA)) {
    assert.deepEqual(validateEvolutionConfiguration({[key]:field.default}),[]);
    assert.ok(validateEvolutionConfiguration({[key]:field.max+1}).some(issue=>issue.key===key));
  }
});
test('dependency admission requires exact public artifact identity and returns no URL content', () => {
  const entry={id:'numpy',version:'1',digest:`sha256:${'a'.repeat(64)}`,filename:'numpy.whl',url:'https://files.pythonhosted.org/packages/numpy.whl'};
  assert.deepEqual(validateEvolutionConfiguration({evolutionDependencyAllowlist:[entry]}),[]);
  for(const url of ['http://files.pythonhosted.org/a',['https://operator', 'test-placeholder@example.com/a'].join(':'),'https://127.0.0.1/a','https://example.com/a?secret=token']) {
    const issues=validateEvolutionConfiguration({evolutionDependencyAllowlist:[{...entry,url}]});
    assert.deepEqual(issues,[{code:'evolution_dependency_allowlist_invalid',key:'evolutionDependencyAllowlist'}]);
  }
  assert.ok(validateEvolutionConfiguration({evolutionDependencyAllowlist:[entry,entry]}).length);
});

test('zero budgets cannot turn isolated evolution into unlimited model spending',()=>{
  for(const key of ['evolutionDailyBudgetCny','evolutionRunBudgetCny'])assert.deepEqual(validateEvolutionConfiguration({[key]:0}),[{code:'evolution_setting_invalid',key}]);
});


test('job retry admission reads its bounded deployment environment setting',()=>{
  const name='OPEN_SCIENCE_EVOLUTION_MAX_JOB_ATTEMPTS',prior=process.env[name];
  try{
    process.env[name]='4';assert.equal(loadConfig().evolutionMaxJobAttempts,4);
    process.env[name]='11';assert.ok(validateEvolutionConfiguration(loadConfig()).some(issue=>issue.key==='evolutionMaxJobAttempts'));
    process.env[name]='0';assert.ok(validateEvolutionConfiguration(loadConfig()).some(issue=>issue.key==='evolutionMaxJobAttempts'));
  }finally{if(prior===undefined)delete process.env[name];else process.env[name]=prior;}
});
