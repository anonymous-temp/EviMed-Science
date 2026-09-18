import assert from "node:assert/strict";
import test from "node:test";

import { MEMORY_KINDS, MEMORY_KIND_LABELS_ZH } from "../src/researchMemoryPersistence.mjs";

// A memory is named on screen by its kind, never by its key: the inbox of
// 2026-09-19 read 「记忆「preference.response_length」原本记的是…」.
test("every memory kind has the Chinese name a notice uses for it", () => {
  assert.deepEqual(Object.keys(MEMORY_KIND_LABELS_ZH).sort(), [...MEMORY_KINDS].sort());
  for (const label of Object.values(MEMORY_KIND_LABELS_ZH)) assert.match(label, /^[一-鿿]{2,6}$/);
});
