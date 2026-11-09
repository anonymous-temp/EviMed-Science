import {loadConfig} from '../src/config.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { EVOLUTION_CONFIG_SCHEMA, validateEvolutionConfiguration } from '../src/evolutionConfiguration.mjs';

test('evolution deployment defaults fit their closed resource bounds', () => {
  assert.deepEqual(validateEvolutionConfiguration({}),[]);
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

test('a retention setting outside its bounds is replaced by the default and said by key, and the platform still loads', () => {
  const name = 'OPEN_SCIENCE_EVOLUTION_SIGNAL_RETENTION_DAYS', prior = process.env[name], write = process.stderr.write;
  const said = [];
  try {
    process.stderr.write = (chunk) => { said.push(String(chunk)); return true; };
    for (const raw of ['abc', '14', '1000']) {
      process.env[name] = raw;
      const config = loadConfig({ localAutoConfig: false });
      assert.equal(config.evolutionSignalRetentionDays, EVOLUTION_CONFIG_SCHEMA.evolutionSignalRetentionDays.default, raw);
      assert.deepEqual(validateEvolutionConfiguration(config), [], raw);
    }
  } finally { process.stderr.write = write; if (prior === undefined) delete process.env[name]; else process.env[name] = prior; }
  assert.equal(said.filter(line => line.includes('evolution_setting_invalid (evolutionSignalRetentionDays)')).length, 3);
  assert.ok(said.every(line => !/abc|1000/.test(line)), 'a value is never echoed');
});

// A setting of the module never stops the platform (review of 「循证进化」, 2026-10-05, S5).
// `??` does not cover an empty value and JSON.parse('') throws, so a variable that arrived empty or
// mangled stopped the API and the runtime controller at boot.
const NAME = 'OPEN_SCIENCE_EVOLUTION_DEPENDENCY_ALLOWLIST';
function withAllowlist(raw, run) {
  const prior = process.env[NAME], write = process.stderr.write;
  try { process.env[NAME] = raw; process.stderr.write = () => true; return run(); }
  finally { process.stderr.write = write; if (prior === undefined) delete process.env[NAME]; else process.env[NAME] = prior; }
}
const MANGLED = ['{not json', '{}', '"x"', '[{"id":1}]', '[1,2'];

test('a malformed dependency allowlist admits nothing and the platform still loads; empty is not set, and a good value is kept', () => {
  for (const raw of MANGLED) assert.deepEqual(withAllowlist(raw, () => loadConfig({ localAutoConfig: false })).evolutionDependencyAllowlist, [], raw);
  for (const raw of ['', '[]']) assert.deepEqual(withAllowlist(raw, () => loadConfig({ localAutoConfig: false })).evolutionDependencyAllowlist, [], JSON.stringify(raw));
  const entry = { id: 'numpy', version: '1', digest: `sha256:${'a'.repeat(64)}`, filename: 'numpy.whl', url: 'https://files.pythonhosted.org/packages/numpy.whl' };
  assert.deepEqual(withAllowlist(JSON.stringify([entry]), () => loadConfig({ localAutoConfig: false })).evolutionDependencyAllowlist, [entry]);
});

test('an API with a mangled evolution setting boots', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { createWebApiApp } = await import('../src/server.mjs');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'os-evolution-config-'));
  const app = withAllowlist('{not json', () => createWebApiApp({ dataDir, port: 0, runtimeMode: 'mock', devAuth: true, runTitlesEnabled: false }));
  try {
    await app.listen(0, '127.0.0.1');
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

// The module calls no model, so it has no budget to set: what remains is engineering limits, each read from its own variable.
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
    assert.ok(validateEvolutionConfiguration({ evolutionSignalRetentionDays: 14 }).some(issue => issue.key === 'evolutionSignalRetentionDays'), 'the least is the signals export window, two months');
    assert.equal(loadConfig({ localAutoConfig: false }).evolutionSignalRetentionDays, 180, 'a value under it is replaced by the default');
  } finally {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});
