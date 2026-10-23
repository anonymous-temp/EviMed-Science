import assert from "node:assert/strict";
import test from "node:test";

import { RETIRED_FEATURES, methodTextOf, retiredFeaturesIn, retiredFeaturesOfMethod } from "../index.mjs";
import table from "../src/skill-packages.json" with { type: "json" };

test("a text names a retired feature by one of its literal terms, without regard to case, once per feature", () => {
  assert.deepEqual(retiredFeaturesIn("Write Clinical-Evidence-Run.json, then clinical-evidence-run.json again."),
    [{ feature: "run-receipt", since: "2026-09-17", term: "clinical-evidence-run.json" }]);
  assert.deepEqual(retiredFeaturesIn("每个交付物最多 3 次提交次数；改动前先做 paired evaluation。").map((hit) => hit.feature), ["submit-limit", "paired-evaluation"]);
  assert.deepEqual(retiredFeaturesIn("Keep a short summary first."), []);
  assert.deepEqual(retiredFeaturesIn(null), []);
});

test("the list is closed, dated and each feature has a term", () => {
  assert.ok(RETIRED_FEATURES.length >= 7);
  const ids = RETIRED_FEATURES.map((feature) => feature.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const feature of RETIRED_FEATURES) {
    assert.match(feature.since, /^\d{4}-\d{2}-\d{2}$/, feature.id);
    assert.ok(feature.terms.length > 0 && feature.terms.every((term) => term.length >= 4), `${feature.id}: a term short enough to occur in ordinary prose`);
  }
});

test("a file name on the list is written by no capability the platform ships", () => {
  // The honesty of the list. `citation-ledger.csv` was one of the six files of the clinical evidence package and is still a
  // deliverable of three capabilities, so it is not here; a name that some capability produces again must leave the list.
  const produced = new Set();
  for (const row of /** @type {any[]} */ (table.packages)) {
    for (const operation of row.operations ?? []) for (const name of operation.produces ?? []) produced.add(String(name).split("/").pop());
  }
  assert.ok(produced.has("citation-ledger.csv"), "the table is read: it still lists the ledger of the appraisal capability");
  for (const feature of RETIRED_FEATURES) {
    for (const term of feature.terms.filter((value) => /\.[a-z]{2,4}$/.test(value))) {
      assert.equal(produced.has(term), false, `${feature.id}: ${term} is produced by a shipped capability`);
    }
  }
});

test("a method is read where the model reads it: frontmatter, metadata, body, attached files and the researcher's line", () => {
  const method = {
    frontmatter: { name: "freeze-first", description: "d", whenToUse: "w", metadata: { applies_when: "before references.bib is written" } },
    body: "## Purpose\nx", files: { "scripts/a.py": "# writes citation-audit.md" }, display: { title: "t", summary: "a paired evaluation decides" },
  };
  assert.deepEqual(retiredFeaturesOfMethod(method).map((hit) => hit.feature), ["citation-audit", "bibliography", "paired-evaluation"]);
  assert.match(methodTextOf(method), /freeze-first[\s\S]*Purpose[\s\S]*a paired evaluation decides/);
  assert.deepEqual(retiredFeaturesOfMethod({ frontmatter: { name: "ok" }, body: "plain" }), []);
  assert.deepEqual(retiredFeaturesOfMethod(null), []);
});
