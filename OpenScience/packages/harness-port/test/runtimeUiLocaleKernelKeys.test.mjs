// The product's language pack is keyed by the kernel's own namespaces and keys, which live only in the kernel's
// client bundles (installed in the runtime image, not here). The 0.1.7 upgrade drew the running turn's header
// from a new key, so 「深度求索中，用时 N 秒」 came back on every live conversation while the override of the old
// key still passed (live walk 2026-10-10). These tests hold the pack to the recorded dictionaries of the pin.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { EVIMED_DICTIONARIES, EVIMED_OWN_KEYS } from '../src/runtimeUiLocale.mjs';

const recorded = JSON.parse(await readFile(new URL('../../contracts/dsh/client-locale.json', import.meta.url), 'utf8'));
const pins = JSON.parse(await readFile(new URL('../../../deps-version.json', import.meta.url), 'utf8'));

test("the recorded kernel dictionaries are the pinned kernel's", () => {
  assert.equal(recorded.pin, pins.dsh.version,
    're-record packages/contracts/dsh/client-locale.json with record-client-locale.mjs on every DSH pin change');
});

test('every key the product rephrases is a key the pinned kernel has', () => {
  for (const [namespace, dictionary] of Object.entries(EVIMED_DICTIONARIES)) {
    assert.ok(recorded.namespaces[namespace], `namespace ${namespace} is not among the recorded kernel dictionaries`);
    const own = /** @type {Record<string, readonly string[]>} */ (EVIMED_OWN_KEYS)[namespace] ?? [];
    for (const key of Object.keys(dictionary)) {
      if (own.includes(key)) continue;
      assert.ok(key in recorded.namespaces[namespace], `${namespace}:${key} — the pinned kernel has no such key (renamed or removed?)`);
    }
  }
});

test("a key the product owns is one the kernel does not have, and the pack defines it", () => {
  for (const [namespace, keys] of Object.entries(EVIMED_OWN_KEYS)) {
    for (const key of keys) {
      assert.equal(key in (recorded.namespaces[namespace] ?? {}), false, `${namespace}:${key} is the kernel's now: drop it from EVIMED_OWN_KEYS`);
      assert.equal(typeof EVIMED_DICTIONARIES[namespace]?.[key], 'string');
    }
  }
});

test('no kernel string that names the vendor as a verb or calls a sub-task a subagent is left as the kernel wrote it', () => {
  for (const [namespace, dictionary] of Object.entries(recorded.namespaces)) {
    for (const [key, value] of Object.entries(dictionary)) {
      if (typeof value !== 'string' || !/深度求索|子代理|子智能体|subagent/i.test(value)) continue;
      assert.notEqual(EVIMED_DICTIONARIES[namespace]?.[key], undefined, `${namespace}:${key} = 「${value}」 needs the product's wording in runtimeUiLocale.mjs`);
    }
  }
});
