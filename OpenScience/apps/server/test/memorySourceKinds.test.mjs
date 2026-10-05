// A memory may name an evidence card or a frontier item as a source (flywheel F19) — and extraction never invents the link: it is
// written only when the run's own tool result carried that id in a structured id field.
import assert from "node:assert/strict";
import test from "node:test";
import { MemoryIntelligence, toolResultIds } from "../src/memoryIntelligence.mjs";
import { MEMORY_SOURCE_TYPES } from "../src/researchMemoryPersistence.mjs";
import { sourceLinkOf } from "../src/researchMemory.mjs";

const config = { deepseekProviderEnabled: true, deepseekApiKey: "unit-test-key", deepseekBaseUrl: "https://api.deepseek.com", deepseekModel: "deepseek-v4-pro",
  memoryExtractionEnabled: true, memoryExtractionTimeoutMs: 1_000 };
const CARD = `ec_${"a1".repeat(16)}`;
const ITEM = "k3x9q2m7p4zt";
const run = { id: "run_1", sessionId: "session_1", mode: "open-domain", effectiveAgentId: "clinical-evidence-synthesis", model: "deepseek/deepseek-v4-pro", status: "succeeded",
  artifacts: ["r.md"], startedAt: "2026-07-22T01:00:00.000Z", finishedAt: "2026-07-22T01:01:00.000Z", durationMs: 60_000 };

class StoreDouble {
  constructor() { this.writes = []; this.records = []; }
  async listRecords() { return this.records; }
  async upsertRecord(_user, input, evidence, options = {}) { this.writes.push({ input, links: options.sourceLinks ?? [] }); const record = { ...input, id: `r${this.writes.length}`, version: 1, evidence: evidence ? [evidence] : [], evidenceCount: evidence ? 1 : 0 }; this.records.push(record); return record; }
}

/** The extractor reads one tool result (a frontier search that returned a card and an item) and the researcher's own message. */
function messages(toolData) {
  return [
    { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: `我关注的是 ${CARD} 这张卡和 ${ITEM}。` }] },
    { info: { id: "a1", role: "assistant" }, parts: [{ type: "tool", tool: "frontier_search", state: { status: "completed", input: { q: "房颤" },
      output: JSON.stringify({ status: "success", summary: "2 results", data: toolData }) } }, { type: "text", text: "找到了。" }] },
  ];
}
async function extract(toolData, sources) {
  const store = new StoreDouble();
  const intelligence = new MemoryIntelligence(config, store, { fetchImpl: async (_input, init) => {
    const payload = JSON.parse(JSON.parse(String(init.body)).messages[1].content);
    const user = payload.sources.find((source) => source.role === "user");
    return Response.json({ choices: [{ message: { content: JSON.stringify({ candidates: [{ scope: "project", kind: "project_fact", key: "project.fact.anticoag", value: "关注房颤抗凝", summary: "关注房颤抗凝",
      origin: "explicit", confidence: 1, importance: 0.8, sensitive: false, sourceRef: user.sourceRef, evidenceQuote: "我关注的是", sources }] }) } }] });
  } });
  await intelligence.recordRun({ id: "project_1", userId: "user_1" }, run, messages(toolData));
  // The run's own summary is written beside the candidate; the candidate is the one with a key of its own.
  return store.writes.filter((write) => write.input.key === "project.fact.anticoag");
}

test("the two new kinds are source kinds with their own id formats", () => {
  assert.deepEqual(MEMORY_SOURCE_TYPES, ["knowledge_source", "doi", "evidence_card", "frontier_item"]);
  assert.deepEqual(sourceLinkOf({ type: "evidence_card", id: CARD }), { type: "evidence_card", id: CARD, version: null });
  assert.deepEqual(sourceLinkOf({ type: "frontier_item", id: ITEM }), { type: "frontier_item", id: ITEM, version: null });
  assert.equal(sourceLinkOf({ type: "evidence_card", id: "not-a-card" }), null);
  assert.equal(sourceLinkOf({ type: "frontier_item", id: "Short" }), null);
});

test("an id the run's tool result carried is recorded; one only a message mentions, or the result never carried, is not", async () => {
  const carried = await extract({ items: [{ id: ITEM, title: "新证据" }], cards: [{ id: CARD, title: "房颤抗凝" }] }, [CARD, ITEM]);
  assert.deepEqual(carried[0].links.map((link) => [link.type, link.id]), [["evidence_card", CARD], ["frontier_item", ITEM]]);
  // The researcher's own message names both, and the result carried neither: nothing is invented from a message.
  const mentioned = await extract({ items: [{ id: "zz9y8x7w6v5u", title: "别的条目" }] }, [CARD, ITEM]);
  assert.deepEqual(mentioned[0].links, []);
  // A result that carried the item but not the card links the item only.
  const partial = await extract({ items: [{ id: ITEM }] }, [CARD, ITEM]);
  assert.deepEqual(partial[0].links.map((link) => link.type), ["frontier_item"]);
});

test("toolResultIds reads the id fields of a tool source's data, and only a tool's", () => {
  const found = toolResultIds([
    { role: "tool", text: `tool: x\ndata: ${JSON.stringify({ cards: [{ cardId: CARD }], items: [{ publicId: ITEM }] })}` },
    { role: "user", text: `"id":"${"q".repeat(20)}"` },
  ]);
  assert.deepEqual([...found].sort(), [CARD, ITEM].sort());
});
