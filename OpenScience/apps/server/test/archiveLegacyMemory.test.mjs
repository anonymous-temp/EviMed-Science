import assert from "node:assert/strict";
import test from "node:test";

import { legacyReason } from "../../../scripts/ops/archive-legacy-memory.mjs";

// The one-off archive applies the 2026-09-20 write rules to what the old
// extractor already wrote. What it may touch is the whole safety of it.

const row = (overrides = {}) => ({ status: "active", origin: "system", kind: "project_fact", scope: "project", scope_id: "p1",
  value: "项目主题为 ≥70 岁老年人阿司匹林一级预防。", summary: "", ...overrides });

test("what the old rules wrote and the new ones refuse is named, by reason", () => {
  assert.equal(legacyReason(row({ kind: "analysis" })), "analysis-kind-retired");
  assert.equal(legacyReason(row({ scope_id: "default", kind: "follow_up" })), "default-project-fact");
  assert.equal(legacyReason(row({ value: "ledger 的 referenceNumber 字段是重建规范编号顺序的依据。" })), "run-bookkeeping");
});

test("anything the researcher said or edited is never touched, nor an episode, nor a clean fact", () => {
  for (const origin of ["explicit", "manual"]) assert.equal(legacyReason(row({ kind: "analysis", origin })), null, origin);
  assert.equal(legacyReason(row({ kind: "run_summary", scope_id: "default" })), null, "the timeline still reads episodes");
  assert.equal(legacyReason(row({ status: "archived", kind: "analysis" })), null);
  assert.equal(legacyReason(row()), null, "a project fact in a real project, in the researcher's words, stays");
});
