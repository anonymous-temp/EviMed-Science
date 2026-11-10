import { test } from "node:test";
import assert from "node:assert/strict";

import { archiveSessionKind, binomialCdf, classifyColumn, classifyFindings, classifyPlace, g4Counted, g5Verdict, probeExpectation, summarizeG4, summarizeG5,
  upperBound } from "../redline/classify.mjs";
import { enginePlace, holds, searchBlockKind, zipPathsWith } from "../redline/scan.mjs";
import { createRequire } from "node:module";

const { zipSync } = createRequire(new URL("../../../apps/server/package.json", import.meta.url))("fflate");

test("engine paths fall into the scan places the plan names", () => {
  assert.equal(enginePlace("memories/notes/locker.md"), "engine-files");
  assert.equal(enginePlace("memories/notes/.overview.md"), "engine-summaries");
  assert.equal(enginePlace("sessions/dsh-rl_x_m/history/archive_001/messages.jsonl"), "archive");
  assert.equal(enginePlace("resources/history/a/b/c-0.md"), "raw-history");
  assert.equal(enginePlace("privacy/session/x/values.json"), "privacy-tree");
  assert.equal(enginePlace("peers/.abstract.md"), "engine-summaries");
  assert.equal(enginePlace("skills/x.md"), "engine-other");
  assert.equal(archiveSessionKind("sessions/dsh-rl_a/history/archive_001/messages.jsonl"), "conversation");
  assert.equal(archiveSessionKind("sessions/evimed-page-abc/history/archive_001/messages.jsonl"), "write-session");
  assert.equal(archiveSessionKind("sessions/mcp-store-abc/history/archive_001/messages.jsonl"), "write-session");
});

test("served memory, the page, the model surfaces and the export are red lines after every delete path", () => {
  for (const deleteVia of ["forget-in-conversation", "memory-page-edit", "memory-page-delete", "delete-conversation", "memory-reset", "delete-account"]) {
    for (const place of ["engine-files", "page", "model-search", "model-list-read", "plugin-recall", "resident", "export", "capsule-entries"]) {
      assert.equal(classifyPlace(place, ["x"], { deleteVia }).class, "redline", `${place} after ${deleteVia}`);
    }
    assert.equal(classifyColumn("evimed_memory.native_files.body", deleteVia).class, "redline");
  }
});

test("source copies are red lines only for the deletions that destroy the source", () => {
  const archive = ["sessions/dsh-rl_a/history/archive_001/messages.jsonl"];
  assert.equal(classifyPlace("archive", archive, { deleteVia: "forget-in-conversation" }).class, "by-design");
  assert.equal(classifyPlace("archive", archive, { deleteVia: "memory-page-delete" }).class, "by-design");
  for (const deleteVia of ["delete-conversation", "memory-reset", "delete-account"]) {
    assert.equal(classifyPlace("archive", archive, { deleteVia }).class, "redline", deleteVia);
    assert.equal(classifyPlace("raw-history", ["resources/history/a-0.md"], { deleteVia }).class, "redline", deleteVia);
    assert.equal(classifyPlace("privacy-tree", ["privacy/session/a/v.json"], { deleteVia }).class, "redline", deleteVia);
    assert.equal(classifyPlace("vectors", ["memories/notes/a.md"], { deleteVia }).class, "redline", deleteVia);
  }
  assert.equal(classifyPlace("raw-history", ["resources/history/a-0.md"], { deleteVia: "memory-page-edit" }).class, "by-design");
  // A page write session is not the deleted conversation; it is flagged, not a red line, when only a conversation was deleted.
  assert.equal(classifyPlace("archive", ["sessions/evimed-page-x/history/archive_001/messages.jsonl"], { deleteVia: "delete-conversation" }).class, "flag");
  assert.equal(classifyPlace("archive", ["sessions/mcp-store-x/history/archive_001/messages.jsonl"], { deleteVia: "memory-page-delete" }).class, "flag");
  assert.equal(classifyPlace("vectors", ["memories/notes/a.md"], { deleteVia: "memory-page-delete" }).class, "flag");
  assert.equal(classifyPlace("engine-summaries", ["memories/notes/.overview.md"], { deleteVia: "delete-account" }).class, "flag");
});

test("ledger columns: rejection words and undo/edit history are by design, other clear text is a flag", () => {
  assert.equal(classifyColumn("evimed_memory.native_rejections.text", "memory-page-delete").class, "by-design");
  assert.equal(classifyColumn("evimed_memory.native_rejections.text", "memory-reset").class, "flag");
  assert.equal(classifyColumn("evimed_memory.native_revisions.before", "forget-in-conversation").class, "by-design");
  assert.equal(classifyColumn("evimed_memory.native_revisions.before", "memory-page-edit").class, "by-design");
  assert.equal(classifyColumn("evimed_memory.native_revisions.after", "memory-page-delete").class, "flag");
  assert.equal(classifyColumn("evimed_source_deletion.conversations.frozen", "delete-conversation").class, "flag");
  const mixed = classifyPlace("ledger", ["evimed_memory.native_rejections.text", "evimed_memory.native_files.body"], { deleteVia: "memory-page-delete" });
  assert.equal(mixed.class, "redline");
  assert.equal(classifyPlace("ledger", ["evimed_memory.native_rejections.text"], { deleteVia: "memory-page-delete" }).class, "by-design");
});

test("classifyFindings separates not-applicable, not-found and found places and decides reappearance", () => {
  const verdict = classifyFindings({
    "engine-files": [], archive: ["sessions/dsh-a/history/archive_001/messages.jsonl"], ledger: ["evimed_memory.native_rejections.text"],
    "line-origin-index": ["evimed_memory.native_line_origins.fingerprint"], page: null, "model-search": [],
  }, { deleteVia: "forget-in-conversation" });
  assert.equal(verdict.reappeared, false);
  assert.deepEqual(verdict.places.page, { found: null, where: [], class: null });
  assert.equal(verdict.places["engine-files"].found, false);
  assert.equal(verdict.places.archive.class, "by-design");
  assert.deepEqual(verdict.flags, ["line-origin-index"]);
  const hit = classifyFindings({ "model-search": ["history"] }, { deleteVia: "memory-page-delete" });
  assert.equal(hit.reappeared, true);
  assert.deepEqual(hit.redline, ["model-search"]);
});

test("the exact one-sided upper bound matches the closed form and known values", () => {
  assert.equal(upperBound(0, 0), null);
  assert.ok(Math.abs(upperBound(0, 3000) - (1 - 0.05 ** (1 / 3000))) < 1e-12);
  assert.ok(Math.abs(upperBound(0, 300) - 0.009937) < 1e-5);
  // Clopper-Pearson one-sided 95% for 1/100 is 0.0466; for 5/50 it is 0.1982.
  assert.ok(Math.abs(upperBound(1, 100) - 0.04656) < 1e-4, String(upperBound(1, 100)));
  assert.ok(Math.abs(upperBound(5, 50) - 0.19817) < 1e-3, String(upperBound(5, 50)));
  assert.equal(upperBound(4, 4), 1);
  assert.ok(Math.abs(binomialCdf(0, 10, 0.1) - 0.9 ** 10) < 1e-12);
  assert.ok(Math.abs(binomialCdf(10, 10, 0.3) - 1) < 1e-12);
});

test("the G4 summary counts only planted, deleted, error-free, drivable trials and lists red lines first", () => {
  const base = { plantVia: "statement", deleteVia: "memory-page-delete", relearn: "none" };
  const rows = [
    { ...base, trialId: "g4-1", planted: true, deleted: true, reappeared: false, controlsSurvived: true, places: { ledger: { found: true, where: ["x"], class: "by-design" } } },
    { ...base, trialId: "g4-2", planted: true, deleted: true, reappeared: true, controlsSurvived: false, places: { "model-search": { found: true, where: ["history"], class: "redline" } } },
    { ...base, trialId: "g4-3", planted: false, deleted: false, places: {} },
    { ...base, trialId: "g4-4", planted: true, deleted: false, error: "boom", places: {} },
    { ...base, trialId: "g4-5", plantVia: "memory-page-add", deleteVia: "delete-conversation", planted: true, deleted: false, notDrivable: "no conversation", places: {} },
    { ...base, trialId: "g4-6", planted: true, deleted: false, reappeared: true, deletion: { outcomes: ["409:busy"] }, places: { "engine-files": { found: true, where: ["x"], class: "redline" } } },
    { ...base, trialId: "g4-7", deleteVia: "delete-conversation", planted: true, deleted: false, reappeared: true, unfinishedDelete: true,
      deletion: { outcomes: ["202:pending", "pending:account_memory_busy"] }, places: { "model-search": { found: true, where: ["memories:x"], class: "redline" } } },
  ];
  assert.equal(g4Counted(rows[0]), true);
  assert.equal(g4Counted(rows[4]), false);
  const summary = summarizeG4(rows);
  assert.deepEqual(Object.keys(summary).slice(0, 3), ["rule", "redLines", "totals"]);
  assert.equal(summary.totals.counted, 2);
  assert.equal(summary.totals.reappeared, 1);
  assert.equal(summary.totals.notPlanted, 1);
  assert.equal(summary.totals.notDrivable, 1);
  assert.equal(summary.totals.errors, 1);
  assert.equal(summary.totals.deleteFailed, 2, "an unfinished delete is not a reappearance");
  assert.equal(summary.totals.reappeared, 1);
  assert.deepEqual(summary.failedDeletes[0], { trialId: "g4-6", cell: "statement×memory-page-delete", outcomes: ["409:busy"] });
  assert.equal(summary.redLines.length, 2, "an accepted delete that never finished while the marker is reachable is listed with the red lines");
  assert.equal(summary.redLines[0].trialId, "g4-2");
  assert.equal(summary.redLines[0].kind, "reappeared");
  assert.deepEqual(summary.redLines[1], { trialId: "g4-7", cell: "statement×delete-conversation", kind: "unfinished-delete",
    outcomes: ["202:pending", "pending:account_memory_busy"], places: [{ place: "model-search", where: ["memories:x"] }] });
  assert.deepEqual(summary.redLines[0].places, [{ place: "model-search", where: ["history"] }]);
  const cell = summary.cells["statement×memory-page-delete"];
  assert.equal(cell.n, 2);
  assert.equal(cell.controlsChecked, 2);
  assert.equal(cell.controlsSurvived, 1);
  assert.equal(cell.byDesign.ledger, 1);
});

test("G5 probe expectations: export is the reader's own account, the capsule half never carries another account's memory", () => {
  assert.equal(probeExpectation({ reader: "other-account", expectVisible: false }, "export"), false);
  assert.equal(probeExpectation({ reader: "same-account-other-project", expectVisible: true }, "export"), "n/a");
  assert.equal(probeExpectation({ reader: "geo-member", expectVisible: true }, "capsule-search"), false);
  assert.equal(probeExpectation({ reader: "same-account-no-project", expectVisible: true }, "capsule-search"), "any");
  assert.equal(probeExpectation({ reader: "geo-member", expectVisible: true }, "search"), true);
});

test("G5 verdicts: cross-account visibility is the red line, same-account leaks and misses are reported apart", () => {
  const leak = g5Verdict({ reader: "other-account", expectVisible: false }, { search: true, read: "refused", list: false, "resident-block": false, "capsule-search": false, export: false });
  assert.equal(leak.redLine, true);
  assert.deepEqual(leak.leaks, ["search"]);
  assert.equal(leak.perProbe.read.visible, false);
  const same = g5Verdict({ reader: "same-account-other-project", expectVisible: false }, { search: false, read: false, list: true, export: true });
  assert.equal(same.redLine, false);
  assert.equal(same.sameAccountLeak, true);
  assert.deepEqual(same.leaks, ["list"], "the account export is not a project read");
  const miss = g5Verdict({ reader: "geo-member", expectVisible: true }, { search: false, read: false, list: false, export: false });
  assert.equal(miss.functionalMiss, true);
  assert.equal(miss.redLine, false);
  const fine = g5Verdict({ reader: "geo-member", expectVisible: true }, { search: true, read: true, list: true, export: false, "capsule-search": false });
  assert.equal(fine.functionalMiss, false);
  assert.equal(fine.redLine, false);
});

test("the G5 summary lists red lines first and bounds the cross-account rate", () => {
  const rows = [
    { trialId: "g5-1", reader: "other-account", concurrent: true, expectVisible: false, planted: true, verdict: g5Verdict({ reader: "other-account", expectVisible: false }, { search: false, export: false }) },
    { trialId: "g5-2", reader: "geo-nonmember", concurrent: false, expectVisible: false, planted: true, verdict: g5Verdict({ reader: "geo-nonmember", expectVisible: false }, { search: true }) },
    { trialId: "g5-3", reader: "same-account-no-project", concurrent: false, expectVisible: true, planted: false },
    { trialId: "g5-4", reader: "other-account", concurrent: false, expectVisible: false, error: "x" },
  ];
  const summary = summarizeG5(rows);
  assert.deepEqual(Object.keys(summary).slice(0, 2), ["rule", "redLines"]);
  assert.equal(summary.redLines.length, 1);
  assert.equal(summary.redLines[0].trialId, "g5-2");
  assert.equal(summary.totals.crossAccountTrials, 2);
  assert.equal(summary.totals.notPlanted, 1);
  assert.equal(summary.totals.errors, 1);
  assert.equal(summary.cells["other-account×search"].n, 1);
  assert.ok(summary.totals.upperBound95 > 0.5);
});

test("search answer blocks and export archives are read for the marker without their text", () => {
  assert.equal(searchBlockKind("{\"memories\":[]}", 0), "memories");
  assert.equal(searchBlockKind("Original conversation excerpts (historical context…)", 2), "history");
  assert.equal(searchBlockKind("Capsule notes", 1), "capsule");
  const inner = zipSync({ "personal/memories/notes/a.md": Buffer.from("locker Q-12345") });
  const outer = zipSync({ "memory/memory.json": Buffer.from("{}"), "memory/native-memory.zip": inner, "README.txt": Buffer.from("Q-12345 here") });
  assert.deepEqual(zipPathsWith(outer, "Q-12345").sort(), ["README.txt", "memory/native-memory.zip!/personal/memories/notes/a.md"]);
  assert.deepEqual(zipPathsWith(outer, "Z-99999"), []);
});

test("a marker is found in any letter case, in file names inside archives too", () => {
  assert.equal(holds("projects/r-47162 采购申请.md", "R-47162"), true);
  assert.equal(holds("R-4716", "R-47162"), false);
  const zip = zipSync({ "personal/memories/projects/r-47162 申请.md": Buffer.from("no code in the body") });
  assert.deepEqual(zipPathsWith(zip, "R-47162"), ["personal/memories/projects/r-47162 申请.md"]);
});
