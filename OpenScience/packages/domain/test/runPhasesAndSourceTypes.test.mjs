import assert from "node:assert/strict";
import test from "node:test";

import {
  RUN_ACTIVITY_PHASES,
  RUN_ACTIVITY_PHASE_LABELS_ZH,
  EVIDENCE_SOURCE_TYPES,
  EVIDENCE_SOURCE_TYPE_LABELS_ZH,
  phaseOfToolCall,
  evidenceSourceTypeOf,
  summarizeRunPhases,
} from "../index.mjs";

test("every phase and every source type has a Chinese label", () => {
  for (const phase of RUN_ACTIVITY_PHASES) assert.ok(/** @type {Record<string, string>} */ (RUN_ACTIVITY_PHASE_LABELS_ZH)[phase], phase);
  for (const type of EVIDENCE_SOURCE_TYPES) assert.ok(/** @type {Record<string, string>} */ (EVIDENCE_SOURCE_TYPE_LABELS_ZH)[type], type);
  assert.equal(Object.keys(EVIDENCE_SOURCE_TYPE_LABELS_ZH).length, EVIDENCE_SOURCE_TYPES.length);
});

test("phases label tool calls under every spelling the kernel reports", () => {
  assert.equal(phaseOfToolCall("mcp__evimed__literature_search"), "search");
  assert.equal(phaseOfToolCall("guideline_search"), "search");
  assert.equal(phaseOfToolCall("evimed_screen_batch"), "screen");
  assert.equal(phaseOfToolCall("mcp__evimed__open_access_full_text"), "fulltext");
  assert.equal(phaseOfToolCall("evimed_submit_deliverable"), "deliver");
  assert.equal(phaseOfToolCall("mcp__evimed__locate_quote"), "claims");
});

test("a write is writing only when it lands in a deliverable", () => {
  assert.equal(phaseOfToolCall("write", { filePath: "deliverables/clinical-evidence-synthesis/report.md" }), "write");
  assert.equal(phaseOfToolCall("edit", { path: "/workspace/deliverables/x/evidence-matrix.json" }), "write");
  assert.equal(phaseOfToolCall("write", { filePath: "work/build_matrix.py" }), null);
  assert.equal(phaseOfToolCall("bash", { command: "python3 build_matrix.py" }), null);
});

test("a plain question has no phase at all", () => {
  const summary = summarizeRunPhases([]);
  assert.equal(summary.current, null);
  assert.deepEqual(Object.values(summary.counts), [0, 0, 0, 0, 0, 0]);
});

test("the summary counts calls and names the furthest phase reached", () => {
  const summary = summarizeRunPhases([
    { tool: "mcp__evimed__literature_search" },
    { tool: "mcp__evimed__literature_search" },
    { tool: "read", input: { filePath: "notes.md" } },
    { tool: "mcp__evimed__open_access_full_text" },
    { tool: "bash" },
  ]);
  assert.equal(summary.counts.search, 2);
  assert.equal(summary.counts.fulltext, 1);
  assert.equal(summary.current, "fulltext");
  assert.deepEqual(summary.reached, ["search", "fulltext"], "a phase with no call behind it is not something to show");
});

test("the phase only advances: a run that delivered does not fall back to checking", () => {
  // `current` used to be the phase of the most recent labelled call, so a run
  // that delivered and then made one more checking call read 「核验」 for the
  // rest of its life, while 「筛选」 read 0 on nearly every run. A reader
  // watching a twenty-minute run asks how far it has got.
  const summary = summarizeRunPhases([
    { tool: "mcp__evimed__literature_search" },
    { tool: "write", input: { filePath: "deliverables/d1/clinical-evidence-report.md" } },
    { tool: "evimed_submit_deliverable" },
    { tool: "evimed_package_check" },
    { tool: "mcp__evimed__locate_quote" },
  ]);
  assert.equal(summary.current, "deliver");
  assert.deepEqual(summary.reached, ["search", "claims", "write", "deliver"]);
  assert.equal(summary.counts.claims, 2, "the counts are the evidence and are unchanged");
  assert.equal(summary.counts.screen, 0);
});

test("source types come from publication types, most specific form first", () => {
  assert.equal(evidenceSourceTypeOf({ publicationTypes: ["Review", "Meta-Analysis"] }), "meta-analysis");
  assert.equal(evidenceSourceTypeOf({ publicationTypes: ["Randomized Controlled Trial", "Multicenter Study"] }), "rct");
  assert.equal(evidenceSourceTypeOf({ publication_types: "Journal Article; Practice Guideline" }), "guideline");
  assert.equal(evidenceSourceTypeOf({ publicationTypes: ["Case Reports"] }), "case-report");
});

test("source types fall back to the finding tool, then the host, then other", () => {
  assert.equal(evidenceSourceTypeOf({ tool: "mcp__evimed__drug_label_search" }), "label");
  assert.equal(evidenceSourceTypeOf({ tool: "clinical_trial_search" }), "trial-registration");
  assert.equal(evidenceSourceTypeOf({ url: "https://www.nice.org.uk/guidance/ng136" }), "guideline");
  assert.equal(evidenceSourceTypeOf({ url: "https://www.nmpa.gov.cn/xxgk/ggtg/index.html" }), "regulatory");
  assert.equal(evidenceSourceTypeOf({ url: "https://example.org/blog" }), "other");
  assert.equal(evidenceSourceTypeOf(null), "other");
  assert.equal(evidenceSourceTypeOf({ sourceType: "label", publicationTypes: ["Review"] }), "label");
  assert.equal(evidenceSourceTypeOf({ sourceType: "not-a-type", publicationTypes: ["Review"] }), "review");
});
