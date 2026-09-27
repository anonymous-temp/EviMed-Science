// The write-quality incidents as an eval corpus (audit 2026-09-26, M-9).
//
// The live replay needs a model and runs offline in `evals/`. What this file
// holds without one: that the corpus is whole — one case per class, each with
// the verbatims it was filed from — and that the classes code can decide are
// decided the way the case expects when the incident's own candidate comes
// back from the model.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PLATFORM_CONTEXT_TAGS } from "@evimed/domain";
import { MemoryIntelligence, conversationMemorySources } from "../src/memoryIntelligence.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const runner = await import(pathToFileURL(path.join(repoRoot, "evals/memory-write-quality/run_write_quality_eval.mjs")).href);

const cases = await runner.loadCases(path.join(repoRoot, "evals/memory-write-quality/cases"));

const config = {
  deepseekProviderEnabled: true,
  deepseekApiKey: "unit-test-key",
  deepseekBaseUrl: "https://api.deepseek.com",
  deepseekModel: "deepseek-v4-pro",
  memoryExtractionEnabled: true,
  memoryExtractionTimeoutMs: 1_000,
};

class StoreDouble {
  constructor() { this.records = new Map(); this.configured = false; }
  async listRecords() { return [...this.records.values()]; }
  async upsertRecord(_userId, input) {
    const stored = { ...input, id: input.key, version: 1, revisions: [], evidence: [], evidenceCount: 0 };
    this.records.set([input.scope, input.scopeId ?? "", input.kind, input.key].join("\u0000"), stored);
    return stored;
  }
  async getRecord() { throw Object.assign(new Error("not found"), { code: "memory_not_found" }); }
}

test("the corpus holds one well-formed case of every write-quality class", () => {
  // A corpus that loaded nothing would pass every assertion below.
  assert.ok(cases.length >= runner.REQUIRED_CLASSES.length, `loaded only ${cases.length} cases`);
  assert.deepEqual(cases.flatMap(runner.caseIssues), []);
  for (const name of runner.REQUIRED_CLASSES) {
    assert.equal(cases.filter((item) => item.class === name).length, 1, `one case of ${name}`);
  }
  for (const item of cases) {
    for (const record of item.written) {
      assert.ok(record.summary || record.key || record.verbatimFragment, `${item.id} names what was written`);
    }
  }
});

test("the catch-all incident, replayed with the model's own candidate, is refused at write time", async () => {
  const item = cases.find((entry) => entry.class === "default-project-follow-up");
  const store = new StoreDouble();
  const result = await new MemoryIntelligence(config, store, {
    fetchImpl: async (_input, init) => {
      const sources = JSON.parse(JSON.parse(String(init.body)).messages[1].content).sources;
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        candidates: item.replay.incidentCandidates.map((candidate) => ({
          importance: 0.6, sensitive: false, ...candidate,
          sourceRef: sources.find((source) => source.sourceRef.endsWith(`/messages/${candidate.sourceRef}`)).sourceRef,
        })),
      }) } }] });
    },
  }).recordRun({ id: item.replay.projectId, userId: "usr_eval" }, { id: "run_eval", sessionId: "session_eval", status: "succeeded",
    finishedAt: "2026-09-26T00:00:00Z" }, runner.replayMessages(item));

  const written = [...store.records.values()].filter((record) => record.kind !== "run_summary");
  assert.equal(result.proposed, 1, "the incident's candidate reached validation");
  assert.deepEqual(runner.decidedVerdicts(item, written).map((verdict) => verdict.passed), [true]);
});

test("the platform-brief incident is refused before any model sees it, whatever registered tag the dispatcher uses", () => {
  const item = cases.find((entry) => entry.class === "platform-brief-as-user-words");
  const verdicts = runner.briefVerdicts(item, { conversationMemorySources, tags: PLATFORM_CONTEXT_TAGS });
  assert.ok(verdicts.length >= 15, `checked only ${verdicts.length} tags`);
  assert.ok(verdicts.every((verdict) => verdict.passed), verdicts.filter((verdict) => !verdict.passed).map((verdict) => verdict.check).join("; "));
  // And the incident as production recorded it — no tag — is exactly what
  // reached the extractor as the researcher's words.
  const untagged = conversationMemorySources(runner.replayMessages(item), "session_eval");
  assert.equal(untagged.sources.length, 1);
});

test("the code-decided checks read the written records, not their prose", () => {
  const byClass = Object.fromEntries(cases.map((item) => [item.class, item]));
  assert.deepEqual(runner.decidedVerdicts(byClass["internal-id"], [{ key: "k", kind: "project_fact", value: "草稿 ge_c4de7529 已写", summary: "" }])
    .map((verdict) => verdict.passed), [false]);
  assert.deepEqual(runner.decidedVerdicts(byClass["near-duplicates"], [
    { key: "a", kind: "follow_up", value: "x", summary: "" }, { key: "b", kind: "follow_up", value: "y", summary: "" },
  ]).map((verdict) => verdict.passed), [false]);
  assert.deepEqual(runner.decidedVerdicts(byClass["hollow-summary"], []), [], "a judgement class has no code verdict");
});
