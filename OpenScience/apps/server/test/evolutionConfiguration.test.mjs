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

test('job retry admission reads its bounded deployment environment setting',()=>{
  const name='OPEN_SCIENCE_EVOLUTION_MAX_JOB_ATTEMPTS',prior=process.env[name];
  try{
    process.env[name]='4';assert.equal(loadConfig().evolutionMaxJobAttempts,4);
    process.env[name]='11';assert.ok(validateEvolutionConfiguration(loadConfig()).some(issue=>issue.key==='evolutionMaxJobAttempts'));
    process.env[name]='0';assert.ok(validateEvolutionConfiguration(loadConfig()).some(issue=>issue.key==='evolutionMaxJobAttempts'));
  }finally{if(prior===undefined)delete process.env[name];else process.env[name]=prior;}
});

// A setting of an optional module never stops the platform (review of 「循证进化」, 2026-10-05, S5).
// `??` does not cover an empty value and JSON.parse('') throws, so a variable that arrived empty or
// mangled stopped the API and the runtime controller at boot, with the module off.
const JSON_SETTINGS = ['OPEN_SCIENCE_EVOLUTION_DEPENDENCY_ALLOWLIST', 'OPEN_SCIENCE_EVOLUTION_ENABLED', 'OPEN_SCIENCE_EVOLUTION_MAX_JOB_ATTEMPTS'];
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
    // The module is on by default (2026-10-07); this is the deployment that switched it off.
    const config = withEnvironment({ OPEN_SCIENCE_EVOLUTION_ENABLED: 'false', OPEN_SCIENCE_EVOLUTION_DEPENDENCY_ALLOWLIST: raw }, () => loadConfig({ localAutoConfig: false }));
    assert.equal(config.evolutionEnabled, false, JSON.stringify(raw));
    assert.equal(config.evolutionRefusal, null);
    assert.ok(Array.isArray(config.evolutionDependencyAllowlist) || raw === '{}' || raw === 'null' || raw === '"x"' || raw === '[{"id":1}]', 'the parsed value is only read when the module is on');
  }
});

test('a malformed setting keeps a module that is on from starting, by name, and the platform still loads', () => {
  const cases = [
    ['OPEN_SCIENCE_EVOLUTION_DEPENDENCY_ALLOWLIST', ['{not json', '{}', '"x"', '[{"id":1}]'], { code: 'evolution_dependency_allowlist_invalid', key: 'evolutionDependencyAllowlist' }],
    ['OPEN_SCIENCE_EVOLUTION_MAX_JOB_ATTEMPTS', ['abc', '0', '11'], { code: 'evolution_setting_invalid', key: 'evolutionMaxJobAttempts' }],
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
    const config = withEnvironment({ OPEN_SCIENCE_EVOLUTION_ENABLED: 'true', OPEN_SCIENCE_EVOLUTION_DEPENDENCY_ALLOWLIST: raw }, () => loadConfig({ localAutoConfig: false }));
    assert.equal(config.evolutionEnabled, true, JSON.stringify(raw));
    assert.equal(config.evolutionRefusal, null);
  }
});

test('an API with a mangled evolution setting boots and has no evolution module', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { createWebApiApp } = await import('../src/server.mjs');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'os-evolution-config-'));
  const app = withEnvironment({ OPEN_SCIENCE_EVOLUTION_ENABLED: 'true', OPEN_SCIENCE_EVOLUTION_DEPENDENCY_ALLOWLIST: '{not json' },
    () => createWebApiApp({ dataDir, port: 0, runtimeMode: 'mock', devAuth: true, runTitlesEnabled: false }));
  try {
    await app.listen(0, '127.0.0.1');
    assert.equal(app.evolution ?? null, null);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

// The online module calls no model, so it has no budget to set: what remains is engineering limits, each read from its own variable.
test('every limit reads the default its schema states, a deployment variable overrides it, and a record is kept 180 days', () => {
  const saved = Object.fromEntries(Object.values(EVOLUTION_CONFIG_SCHEMA).map(field => [field.env, process.env[field.env]]));
  try {
    for (const field of Object.values(EVOLUTION_CONFIG_SCHEMA)) delete process.env[field.env];
    const config = loadConfig({ localAutoConfig: false });
    // The default written in config.mjs is the schema's, for every key the schema names.
    for (const [key, field] of Object.entries(EVOLUTION_CONFIG_SCHEMA)) assert.equal(config[key], field.default, `${key} reads the default its schema states`);
    assert.equal(config.evolutionSignalRetentionDays, 180);
    assert.deepEqual(validateEvolutionConfiguration(config), []);
    process.env.OPEN_SCIENCE_EVOLUTION_SIGNAL_RETENTION_DAYS = '90';
    assert.equal(loadConfig({ localAutoConfig: false }).evolutionSignalRetentionDays, 90);
    process.env.OPEN_SCIENCE_EVOLUTION_SIGNAL_RETENTION_DAYS = '14';
    assert.ok(validateEvolutionConfiguration(loadConfig({ localAutoConfig: false })).some(issue => issue.key === 'evolutionSignalRetentionDays'), 'the least is the signals export window, two months');
  } finally {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});
