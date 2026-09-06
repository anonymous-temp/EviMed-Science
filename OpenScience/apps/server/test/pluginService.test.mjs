import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validatePluginConfig, projectPluginId, exportPluginPayload } from '../src/pluginService.mjs';

test('only the approved binary and bounded integer timeout can be configured', () => {
  assert.deepEqual(validatePluginConfig({ expectedRevision: 0, enabled: true, settings: { timeoutMs: 4000 } }),
    { enabled: true, settings: { timeoutMs: 4000 } });
  for (const input of [
    { expectedRevision: 0, enabled: 'true', settings: { timeoutMs: 4000 } },
    { expectedRevision: 0, enabled: true, settings: { timeoutMs: 1999 } },
    { expectedRevision: 0, enabled: true, settings: { timeoutMs: 15001 } },
    { expectedRevision: 0, enabled: true, settings: { timeoutMs: 4000.5 } },
    { expectedRevision: 0, enabled: true, settings: { timeoutMs: 4000, userAgent: 'override' } },
    { expectedRevision: 0, enabled: true, settings: { timeoutMs: 4000 }, version: '0.3.3' },
  ]) assert.throws(() => validatePluginConfig(input), { status: 400 });
  assert.throws(() => validatePluginConfig({ expectedRevision: 0, enabled: true, settings: { timeoutMs: 6000 } }, 5000), { status: 400 });
});

test('project document identities cannot alias another project', () => {
  assert.notEqual(projectPluginId('a'), projectPluginId('a:dsh-cite'));
});

test('account export projects only the exact supported configuration shape', () => {
  const payload = { schemaVersion: 1, pluginId: 'dsh-cite', binaryVersion: '0.3.2', enabled: false, settings: { timeoutMs: 4000 } };
  assert.deepEqual(exportPluginPayload(payload), payload);
  for (const value of [{ ...payload, token: 'private' }, { ...payload, binaryVersion: '0.3.3' },
    { ...payload, settings: { timeoutMs: 4000, gatewayUrl: 'https://private' } }, { enabled: true }]) {
    assert.throws(() => exportPluginPayload(value), { code: 'account_export_unsupported_state' });
  }
});
