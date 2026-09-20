// What may become a memory about a researcher, and what may not.
//
// Measured on production on 2026-09-20: 「对你的理解」 held 0 rows while
// 「项目档案」 held 16, and all sixteen were the run talking about itself — a
// report's numbers, a ledger's field name, what the gate had asked for. The
// page could be rebuilt and still show exactly that, so the rules are here, on
// the write side, and each of them is either a closed vocabulary or a shape
// (principle 5): whether a sentence is *about* the machinery is language, and
// it stays with the extraction instructions.
import assert from "node:assert/strict";
import test from "node:test";

import { PLATFORM_JARGON_ZH, runBookkeepingIn } from "@evimed/domain";
import { MemoryIntelligence } from "../src/memoryIntelligence.mjs";

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

const project = (id = "cancer-2026") => ({ id, userId: "usr_1" });
const run = (id = "run_1") => ({
  id, sessionId: "session_1", mode: "chat", agentId: "a", agentVersion: "1", effectiveAgentId: "a",
  effectiveAgentVersion: "1", effectiveRuntimeAgent: "a", model: "m", status: "succeeded", errorCode: null,
  artifacts: [], startedAt: "2026-09-20T01:00:00.000Z", finishedAt: "2026-09-20T01:10:00.000Z", durationMs: 600_000,
});
const message = (id, text, role = "user") => ({ info: { id, role }, parts: [{ type: "text", text }] });

/** One extraction, with the candidates a model would have to return to store
 *  the thing under test. */
function extractor(store, candidates) {
  return new MemoryIntelligence(config, store, {
    fetchImpl: async (_input, init) => {
      const sources = JSON.parse(JSON.parse(String(init.body)).messages[1].content).sources;
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        candidates: candidates.map((candidate) => ({
          origin: "explicit", importance: 0.7, sensitive: false,
          sourceRef: sources[0].sourceRef, evidenceQuote: sources[0].text.slice(0, 12),
          ...candidate,
        })),
      }) } }] });
    },
  });
}

test("the platform's own Chinese words and identifier shapes are a closed list, and a run's bookkeeping trips it", () => {
  // Each term names where the platform itself says it, so a reader can check
  // that it is our word and not a researcher's.
  assert.ok(PLATFORM_JARGON_ZH.length >= 10);
  for (const entry of PLATFORM_JARGON_ZH) {
    assert.match(entry.term, /^[一-鿿]{2,6}$/, `${entry.term} is a Chinese term`);
    assert.ok(entry.saidIn.length > 10, `${entry.term} says where the platform says it`);
  }
  // The row measured on production, and its two halves.
  assert.deepEqual(runBookkeepingIn("ledger 的 referenceNumber 字段是重建规范编号顺序的依据"), ["referenceNumber"]);
  assert.deepEqual(runBookkeepingIn("门禁要求台账里每条交付物都有出处"), ["门禁", "台账", "交付物"]);
  assert.deepEqual(runBookkeepingIn("覆盖率写在 coverage-ledger.md 里"), ["coverage-ledger.md"]);
  // Research prose is untouched, including the identifiers research really uses.
  for (const clean of [
    "老年患者的利伐沙班剂量按肾功能调整",
    "队列来自 NCT00403767，随访 24 周",
    "报告先给 GRADE 分级再给效应量",
    "PMID 12345678 的主要终点是全因死亡",
  ]) assert.deepEqual(runBookkeepingIn(clean), [], clean);
});

test("a report's number is refused, and the standing shape of the project is kept", async () => {
  const store = new StoreDouble();
  const result = await extractor(store, [
    { scope: "project", kind: "project_fact", key: "project.fact.cohort", value: "队列限定 65 岁以上的房颤患者", summary: "队列口径" },
    { scope: "project", kind: "analysis", key: "project.analysis.hr", value: "主要终点 HR 0.88（0.75-1.03）", summary: "效应量" },
    { scope: "project", kind: "project_fact", key: "project.fact.ledger", value: "ledger 的 referenceNumber 字段是重建编号顺序的依据", summary: "编号" },
    { scope: "project", kind: "project_fact", key: "project.fact.gate", value: "门禁要求台账里每条交付物都有出处", summary: "门禁要求" },
  ]).recordRun(project(), run(), [message("u1", "队列限定 65 岁以上的房颤患者，先看主要终点。")]);

  assert.equal(result.extracted, 1, "only the standing fact is stored");
  assert.equal(result.rejected, 3);
  const reasons = result.rejectionReasons.join(" | ");
  assert.match(reasons, /unknown kind "analysis"/, "「分析口径」 is no longer a kind extraction may write");
  assert.match(reasons, /referenceNumber/, "a field name out of the work in progress");
  assert.match(reasons, /门禁|台账|交付物/, "the platform's own words");
  assert.deepEqual([...store.records.values()].filter((record) => record.kind !== "run_summary").map((record) => record.key),
    ["project.fact.cohort"]);
});

test("the catch-all project never gets a fact about itself, and a real project still does", async () => {
  const candidate = [{ scope: "project", kind: "project_fact", key: "project.fact.topic", value: "本项目研究房颤抗凝", summary: "项目主题" }];

  const shared = new StoreDouble();
  const inDefault = await extractor(shared, candidate).recordRun(project("default"), run(), [message("u1", "本项目研究房颤抗凝。")]);
  assert.equal(inDefault.extracted, 0);
  assert.match(inDefault.rejectionReasons.join(" "), /catch-all project, which has no single subject/);

  const named = new StoreDouble();
  const inNamed = await extractor(named, candidate).recordRun(project("af-2026"), run(), [message("u1", "本项目研究房颤抗凝。")]);
  assert.equal(inNamed.extracted, 1);
});

test("one conversation leaves one 「做过的研究」 summary, keyed by the conversation", async () => {
  const store = new StoreDouble();
  const intelligence = extractor(store, []);
  await intelligence.recordRun(project(), run("run_1"), [message("u1", "房颤抗凝该怎么选？")]);
  await intelligence.recordRun(project(), run("run_2"), [message("u2", "换个问题：出血风险怎么估？")]);
  const summaries = [...store.records.values()].filter((record) => record.kind === "run_summary");
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].key, "run.session.session_1");
  assert.equal(summaries[0].scopeId, "cancer-2026", "scoped to the project it happened in");
});

test("an inference stays an inference, whatever the model calls it", async () => {
  const store = new StoreDouble();
  const result = await extractor(store, [
    { scope: "user", kind: "behavior", key: "behavior.tables", value: "习惯先看表格再看正文", summary: "先看表格", origin: "inferred" },
  ]).recordRun(project(), run(), [message("u1", "先给我表格，正文后面再看。")]);
  assert.equal(result.extracted, 1);
  const stored = [...store.records.values()].find((record) => record.kind === "behavior");
  assert.equal(stored.origin, "inferred", "the platform's own observation is never the researcher's word");
  assert.ok(stored.confidence < 1);
});
