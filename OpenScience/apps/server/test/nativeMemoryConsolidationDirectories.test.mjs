// Which memory directories a consolidation pass asks the engine about (v0.5.3 refuses the memories root: an upstream defect at the tag).
import assert from "node:assert/strict";
import test from "node:test";

import { consolidationDirectories, NativeMemoryConsolidation } from "../src/nativeMemoryConsolidation.mjs";

const root = "viking://user/u-0123456789abcdef01234567/memories";
const file = (path) => ({ uri: `${root}/${path}` });

test("the directories are the memory types that hold at least two files the platform reads, sorted", () => {
  const files = [
    file("profile.md"),
    file("preferences/self/a.md"), file("preferences/self/b.md"), file("preferences/corrections/c.md"),
    file("entities/person/p.md"), file("entities/person/q.md"),
    file("decisions/one.md"),
    file("observations/note.md"), file("observations/other.md"),
    file("evimed/user/preference/rec1.md"), file("evimed/user/preference/rec2.md"),
    file("preferences/.overview.md"),
  ];
  assert.deepEqual(consolidationDirectories(files, root), ["entities", "preferences"]);
});

test("a root with nothing in a type directory has no directory to ask for, and a file outside the root is nobody's", () => {
  assert.deepEqual(consolidationDirectories([file("profile.md"), file("entities/a.md")], root), []);
  assert.deepEqual(consolidationDirectories([{ uri: "viking://user/other/memories/entities/a.md" }, { uri: "viking://user/other/memories/entities/b.md" }], root), []);
});

test("one preference and one correction do not qualify as two files of the same type", () => {
  assert.deepEqual(consolidationDirectories([file("preferences/self/a.md"), file("preferences/corrections/b.md")], root), []);
  assert.deepEqual(consolidationDirectories([file("preferences/corrections/a.md"), file("preferences/corrections/b.md")], root), ["preferences"]);
});

test("the read-only eligibility snapshot reports every missing threshold even inside the hourly recheck window", async () => {
  const state = { consolidation_checked_at: new Date("2026-11-21T00:00:00.000Z"), consolidation_lease_until: new Date("2026-11-21T00:06:00.000Z"),
    extraction_pending: true, latest_commit: new Date("2026-11-21T00:02:00.000Z") };
  const files = [file("profile.md"), file("preferences/self/a.md"), file("preferences/corrections/b.md"), file("notes/.overview.md")];
  const consolidation = new NativeMemoryConsolidation(/** @type {any} */ ({
    config: { nativeMemoryConsolidationEnabled: true, memoryEngineEnabled: true },
    now: () => new Date("2026-11-21T00:05:00.000Z"),
    overlay: { configured: true },
    resources: { configured: true },
    sessions: { configured: true, memoryRoot: () => root, tree: async () => files },
  }));
  const facts = await consolidation.diagnosticFacts({
    async query(sql, args) {
      assert.match(sql.trim(), /^SELECT/);
      assert.deepEqual(args, ["alice"]);
      return { rows: [state] };
    },
  }, "alice");
  const result = await consolidation.diagnose("alice", facts);
  assert.deepEqual(result.blockers, ["hourly_check", "lease", "extraction_pending", "quiet_period", "too_few_files", "too_few_same_type"]);
  assert.equal(result.recheckRemainingMs, 55 * 60_000);
  assert.equal(result.quietRemainingMs, 7 * 60_000);
  assert.equal(result.leaseRemainingMs, 60_000);
  assert.equal(result.files, 3);
  assert.equal(result.missingFiles, 1);
  assert.equal(result.missingSameTypeFiles, 1);
});
