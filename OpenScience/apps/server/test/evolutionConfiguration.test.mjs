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

test('the daily count of paper scouting runs reads its bounded deployment environment setting, and zero turns paper scouting off',()=>{
  const name='OPEN_SCIENCE_EVOLUTION_MAX_PAPER_SCOUTS_PER_DAY',prior=process.env[name];
  try{
    delete process.env[name];assert.equal(loadConfig().evolutionMaxPaperScoutsPerDay,8);
    process.env[name]='3';assert.equal(loadConfig().evolutionMaxPaperScoutsPerDay,3);
    process.env[name]='0';assert.deepEqual(validateEvolutionConfiguration(loadConfig()),[]);
    process.env[name]='201';assert.ok(validateEvolutionConfiguration(loadConfig()).some(issue=>issue.key==='evolutionMaxPaperScoutsPerDay'));
    process.env[name]='1.5';assert.ok(validateEvolutionConfiguration(loadConfig()).some(issue=>issue.key==='evolutionMaxPaperScoutsPerDay'));
  }finally{if(prior===undefined)delete process.env[name];else process.env[name]=prior;}
});

// A setting of an optional module never stops the platform (review of 「循证进化」, 2026-10-05, S5).
// `??` does not cover an empty value and JSON.parse('') throws, so a variable that arrived empty or
// mangled stopped the API and the runtime controller at boot, with the module off.
const JSON_SETTINGS = ['OPEN_SCIENCE_EVOLUTION_DEPENDENCY_ALLOWLIST', 'OPEN_SCIENCE_RUNTIME_EGRESS_ALLOWED_PEERS', 'OPEN_SCIENCE_EVOLUTION_ENABLED', 'OPEN_SCIENCE_EVOLUTION_DAILY_BUDGET_CNY'];
function withEnvironment(values, run) {
  const prior = Object.fromEntries(JSON_SETTINGS.map(name => [name, process.env[name]]));
  try {
    for (const name of JSON_SETTINGS) delete process.env[name];
    Object.assign(process.env, values);
    return run();
  } finally {
    for (const [name, value] of Object.entries(prior)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
}
const MANGLED = ['', '  ', '{not json', 'null', '{}', '"x"', '[{"id":1}]', '[1,2'];

test('a malformed JSON setting never stops the platform while the module is off, and is ignored', () => {
  for (const raw of MANGLED) {
    for (const name of ['OPEN_SCIENCE_EVOLUTION_DEPENDENCY_ALLOWLIST', 'OPEN_SCIENCE_RUNTIME_EGRESS_ALLOWED_PEERS']) {
      const config = withEnvironment({ [name]: raw }, () => loadConfig({ localAutoConfig: false }));
      assert.equal(config.evolutionEnabled, false, `${name}=${JSON.stringify(raw)}`);
      assert.equal(config.evolutionRefusal, null);
      assert.ok(Array.isArray(config.evolutionDependencyAllowlist) || raw === '{}' || raw === 'null' || raw === '"x"' || raw === '[{"id":1}]', 'the parsed value is only read when the module is on');
      if (name.includes('EGRESS')) assert.deepEqual(config.runtimeEgressAllowedPeers, [], `${name}=${JSON.stringify(raw)}`);
    }
  }
});

test('a malformed JSON setting keeps a module that is on from starting, by name, and the platform still loads', () => {
  const cases = [
    ['OPEN_SCIENCE_EVOLUTION_DEPENDENCY_ALLOWLIST', ['{not json', '{}', '"x"', '[{"id":1}]'], { code: 'evolution_dependency_allowlist_invalid', key: 'evolutionDependencyAllowlist' }],
    ['OPEN_SCIENCE_RUNTIME_EGRESS_ALLOWED_PEERS', ['{not json', '{}', '[{"containerId":"x"}]'], { code: 'evolution_setting_invalid', key: 'runtimeEgressAllowedPeers' }],
    ['OPEN_SCIENCE_EVOLUTION_DAILY_BUDGET_CNY', ['abc', '0'], { code: 'evolution_setting_invalid', key: 'evolutionDailyBudgetCny' }],
  ];
  for (const [name, values, expected] of cases) {
    for (const raw of values) {
      const config = withEnvironment({ OPEN_SCIENCE_EVOLUTION_ENABLED: 'true', [name]: raw }, () => loadConfig({ localAutoConfig: false }));
      assert.equal(config.evolutionEnabled, false, `${name}=${raw}: the module stays off`);
      assert.deepEqual(config.evolutionRefusal, expected, `${name}=${raw}`);
    }
  }
  // Empty is "not set", not wrong, and a good value is kept.
  for (const raw of ['', '[]']) {
    const config = withEnvironment({ OPEN_SCIENCE_EVOLUTION_ENABLED: 'true', OPEN_SCIENCE_EVOLUTION_DEPENDENCY_ALLOWLIST: raw, OPEN_SCIENCE_RUNTIME_EGRESS_ALLOWED_PEERS: raw }, () => loadConfig({ localAutoConfig: false }));
    assert.equal(config.evolutionEnabled, true, JSON.stringify(raw));
    assert.equal(config.evolutionRefusal, null);
  }
  const peer = { containerId: 'a'.repeat(64), imageId: `sha256:${'b'.repeat(64)}` };
  const config = withEnvironment({ OPEN_SCIENCE_EVOLUTION_ENABLED: 'true', OPEN_SCIENCE_RUNTIME_EGRESS_ALLOWED_PEERS: JSON.stringify([peer]) }, () => loadConfig({ localAutoConfig: false }));
  assert.deepEqual([config.evolutionEnabled, config.runtimeEgressAllowedPeers], [true, [peer]]);
});

test('an API with a mangled evolution setting boots and has no evolution module', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { createWebApiApp } = await import('../src/server.mjs');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'os-evolution-config-'));
  const app = withEnvironment({ OPEN_SCIENCE_EVOLUTION_ENABLED: 'true', OPEN_SCIENCE_EVOLUTION_DEPENDENCY_ALLOWLIST: '', OPEN_SCIENCE_RUNTIME_EGRESS_ALLOWED_PEERS: '{not json' },
    () => createWebApiApp({ dataDir, port: 0, runtimeMode: 'mock', devAuth: true, runTitlesEnabled: false }));
  try {
    await app.listen(0, '127.0.0.1');
    assert.equal(app.evolution ?? null, null);
    assert.equal(app.evaluationIsolation, null, 'and no gateway carries its exclusion layer');
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
