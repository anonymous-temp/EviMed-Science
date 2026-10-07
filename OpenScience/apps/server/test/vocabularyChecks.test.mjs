// Vocabulary CHECKs are read out of a module's own generated DDL, so a word the
// domain adds reaches databases that already have the table (vocabularyChecks.mjs).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { VCR_JOB_KINDS, VCR_REVIEW_STATES } from "@evimed/domain";
import { declaredVocabularyChecks } from "../src/vocabularyChecks.mjs";
import { vcrSchemaSql } from "../src/vcrPersistence.mjs";

test("every vocabulary CHECK the 虚拟临床研究 DDL declares is found, jobs.kind with every job kind", async () => {
  const checks = declaredVocabularyChecks(vcrSchemaSql(), "evimed_vcr");
  const kinds = checks.find((check) => check.table === "jobs" && check.column === "kind");
  assert.ok(kinds, "jobs.kind is a declared vocabulary check");
  assert.deepEqual([...kinds.words].sort(), [...VCR_JOB_KINDS].sort());
  const review = checks.find((check) => check.table === "criteria" && check.column === "review_state");
  assert.deepEqual([...(review?.words ?? [])].sort(), [...VCR_REVIEW_STATES].sort());
  // The walk proves it walked: as many column checks as the source splices from
  // a vocabulary (each table's own line; an ALTER restating a column counts once).
  const source = await readFile(new URL("../src/vcrPersistence.mjs", import.meta.url), "utf8");
  const spliced = (source.match(/^\s+\w+\s+text\b[^\n]*CHECK \(\w+ (?:IS NULL OR \w+ )?IN \$\{inList\(/gm) ?? []).length;
  assert.ok(spliced >= 30, `read ${spliced} spliced checks`);
  assert.ok(checks.length >= spliced, `${checks.length} found for ${spliced} spliced`);
});

test("a NOT IN, a table-level CHECK and a check with no word list are left alone", () => {
  const ddl = [
    "CREATE TABLE IF NOT EXISTS s.t (",
    "  a text NOT NULL CHECK (a IN ('x', 'y')),",
    "  b text CHECK (b NOT IN ('z')),",
    "  c integer CHECK (c > 0),",
    "  CHECK (a <> 'q')",
    ");",
    "ALTER TABLE s.t ADD COLUMN IF NOT EXISTS d text CHECK (d IS NULL OR d IN ('m'));",
  ].join("\n");
  assert.deepEqual(declaredVocabularyChecks(ddl, "s").map(({ table, column, words }) => [table, column, words]),
    [["t", "a", ["x", "y"]], ["t", "d", ["m"]]]);
});
