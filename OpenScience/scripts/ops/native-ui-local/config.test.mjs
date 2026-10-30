import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureConfig, loopbackOrigin, childEnvironment } from './config.mjs';
const env = { EVIMED_LOCAL_NATIVE_ACCEPTANCE: '1', EVIMED_ACCEPTANCE_ROOT: '/tmp/evimed-native-test', EVIMED_ACCEPTANCE_SHELL_ORIGIN: 'http://127.0.0.1:18879', EVIMED_ACCEPTANCE_UI_ORIGIN: 'http://127.0.0.1:18880' };
test('fixture rejects external origins, credentials, arbitrary state and production environment', () => {
  for (const origin of ['https://127.0.0.1:88', 'http://localhost:88', 'http://127.0.0.1:88/a', 'http://user@127.0.0.1:88', 'http://example.com:88']) assert.throws(() => loopbackOrigin(origin));
  assert.throws(() => fixtureConfig({ ...env, EVIMED_ACCEPTANCE_ROOT: '/Users/state' }));
  assert.throws(() => fixtureConfig({ ...env, DATABASE_URL: 'postgres://production' }));
  assert.throws(() => fixtureConfig({ ...env, OPEN_SCIENCE_MODEL_KEY: 'secret' }));
  for (const value of ['-1', '81', 'NaN', '1.5']) assert.throws(() => fixtureConfig({ ...env, EVIMED_ACCEPTANCE_STREAM_LINES: value }));
  assert.throws(() => fixtureConfig({ ...env, EVIMED_ACCEPTANCE_THEME_OFF: 'theme' }));
  assert.equal(fixtureConfig({ ...env, EVIMED_ACCEPTANCE_THEME_OFF: '1' }).themeOff, true);
  assert.equal(fixtureConfig(env).root, env.EVIMED_ACCEPTANCE_ROOT);
});
test('child inherits only execution necessities and explicit fixture values', () => {
  const child = childEnvironment({ DSH_HOME: '/tmp/evimed-native-test/home' });
  assert.deepEqual(Object.keys(child).sort(), ['DSH_HOME', 'HOME', 'LANG', 'PATH', 'TMPDIR']);
  assert.equal(child.HOME, child.DSH_HOME);
});
