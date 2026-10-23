import assert from "node:assert/strict";
import test from "node:test";
import { sourcePublicationInventory } from "../../../scripts/ops/source-publication-inventory.mjs";

test("inventory reports ambiguous notes, conflicting live families and deleted/current byte conflicts without source text", async () => {
  const row = (id, sha256, deleted_at = null) => ({ user_id: "u", project_id: "p", id, revision: 2, deleted_at,
    payload: { familyId: "f", paths: ["knowledge-base/notes/a.md"], fingerprint: { sha256 }, text: "PRIVATE BODY" } });
  const rows = [row("deleted", "old", "2026-10-22"), row("one", "new"), row("two", "new")];
  rows[1].payload.paths.push("knowledge-base/notes/b.md");
  const result = await sourcePublicationInventory(rows, { readDigest: async () => "new" });
  assert.deepEqual([...new Set(result.issues.map(issue => issue.code))].sort(),
    ["ambiguous_merged_notes", "conflicting_live_family", "file_hash_mismatch", "shared_path_hash_conflict"]);
  assert.ok(!JSON.stringify(result).includes("PRIVATE BODY"));
  assert.deepEqual(await sourcePublicationInventory([...rows].reverse(), { readDigest: async () => "new" }), result);
});

 test("historical publication rows do not conflict with the current family member", async () => {
  const row = (id, current) => ({ user_id: "u", project_id: "p", id, revision: 1, deleted_at: null,
    payload: { familyId: "f", publication: { current }, paths: [`knowledge-base/notes/.evimed-revisions/${id}/a.md`], fingerprint: { sha256: id } } });
  const result = await sourcePublicationInventory([row("old", false), row("new", true)], { readDigest: async (_row, rel) => rel.includes("old") ? "old" : "new" });
  assert.equal(result.issues.some(issue => issue.code === "conflicting_live_family"), false);
});
