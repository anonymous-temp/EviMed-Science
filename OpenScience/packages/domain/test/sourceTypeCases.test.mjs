import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { EVIDENCE_SOURCE_TYPES, EVIDENCE_SOURCE_TYPE_LABELS_ZH, evidenceSourceTypeOf, isEvidenceSourceType } from "../index.mjs";
import sourceTypeTable from "../src/source-types.json" with { type: "json" };

const { cases } = JSON.parse(await readFile(new URL("./fixtures/source-type-cases.json", import.meta.url), "utf8"));

test("every shared case gets the same type the research server gives it", () => {
  // Walked, not assumed: an empty case list would pass the loop.
  assert.ok(cases.length >= 25);
  for (const { record, expected, note } of cases) {
    assert.equal(evidenceSourceTypeOf(record), expected, note);
  }
});

test("the table names only known types, and every type has its badge", () => {
  assert.deepEqual([...EVIDENCE_SOURCE_TYPES], sourceTypeTable.types);
  for (const type of EVIDENCE_SOURCE_TYPES) assert.ok(EVIDENCE_SOURCE_TYPE_LABELS_ZH[type], type);
  const named = [
    ...sourceTypeTable.publicationTypes.map(([, type]) => type),
    ...Object.values(sourceTypeTable.articleTypes),
    ...Object.values(sourceTypeTable.tools),
    ...Object.values(sourceTypeTable.connectors),
    ...sourceTypeTable.urls.map(([, , type]) => type),
  ];
  for (const type of named) assert.ok(isEvidenceSourceType(type), type);
});

test("a narrower URL row always sits above its host's catch-all", () => {
  // First match wins, so a path row below a catch-all for the same host could
  // never fire — the table would look complete and answer otherwise.
  const rows = sourceTypeTable.urls;
  rows.forEach(([host, prefix], index) => {
    if (!prefix) return;
    const shadow = rows.slice(0, index).find(([other, otherPrefix]) => (host === other || host.endsWith(`.${other}`)) && prefix.startsWith(otherPrefix));
    assert.equal(shadow, undefined, `${host}${prefix} is shadowed by ${shadow?.join("")}`);
  });
});
