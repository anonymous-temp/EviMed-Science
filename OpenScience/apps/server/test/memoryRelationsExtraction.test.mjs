// What extraction may say about time, disagreement and provenance (N13).
//
// Whether a source gives a date, whether a statement disagrees with a stored
// one and which of a result's sources a fact rests on are the model's
// judgements. What code checks is the closed half, and a failed check drops the
// field — never the memory it rode on, and never the run.
import assert from "node:assert/strict";
import test from "node:test";
import { MemoryIntelligence } from "../src/memoryIntelligence.mjs";
import { HttpError } from "../src/security.mjs";

const SOURCE = `src_${"d".repeat(32)}`;

class Store {
  constructor(records = []) {
    this.records = new Map();
    this.next = 1;
    this.upserts = [];
    this.supersessions = [];
    this.conflicts = [];
    /** @type {Error | null} */
    this.conflictFailure = null;
    for (const record of records) this.put(record);
  }

  put(record) {
    const stored = { id: `record_${this.next++}`, version: 1, evidence: [], revisions: [], evidenceCount: 0,
      createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z", confidence: 1, importance: 0.7,
      sensitive: false, summary: "", ...record };
    this.records.set(stored.id, stored);
    return stored;
  }

  async listRecords() { return [...this.records.values()]; }

  async upsertRecord(_userId, input, evidence, options = {}) {
    this.upserts.push({ input, options });
    const existing = [...this.records.values()].find((record) => record.scope === input.scope
      && (record.scopeId ?? "") === (input.scopeId ?? "") && record.kind === input.kind && record.key === input.key);
    return this.put({ ...existing, ...input, id: existing?.id, version: (existing?.version ?? 0) + 1, evidenceCount: evidence ? 1 : 0 });
  }

  async supersede(userId, previousId, input, evidence, options = {}) {
    this.supersessions.push({ previousId, input, options });
    const record = await this.upsertRecord(userId, input, evidence, options);
    const previous = this.records.get(previousId);
    this.records.set(previousId, { ...previous, status: "superseded", supersededBy: record.id });
    return { record, superseded: this.records.get(previousId) };
  }

  async markConflict(_userId, recordId, otherId, options = {}) {
    if (this.conflictFailure) throw this.conflictFailure;
    this.conflicts.push({ recordId, otherId, reason: options.reason });
    return { recordId, otherId, state: "open", created: true };
  }
}

/** The write for one key — the first upsert of a run is its summary. */
const writeOf = (store, key) => store.upserts.find((upsert) => upsert.input.key === key);

const config = {
  deepseekProviderEnabled: true, deepseekApiKey: "unit-test-key", deepseekBaseUrl: "https://api.deepseek.com",
  deepseekModel: "deepseek-v4-flash", memoryExtractionEnabled: true, memoryExtractionTimeoutMs: 1_000,
};
const project = () => ({ id: "project_1", userId: "user_1" });
const run = (id = "run_1") => ({ id, sessionId: "session_1", status: "succeeded", startedAt: "2026-10-01T00:00:00Z", finishedAt: "2026-10-01T00:01:00Z" });
const userMessage = (id, text) => ({ info: { id, role: "user" }, parts: [{ type: "text", text }] });
const toolMessage = (id, output) => ({ info: { id, role: "assistant" }, parts: [{ type: "tool", tool: "kb_search", state: { status: "completed", input: { query: "q" }, output: JSON.stringify(output) } }] });

/** A model that proposes exactly one candidate, built from the first source it was shown. */
function proposing(build) {
  const seen = { system: "" };
  const fetchImpl = async (_input, init) => {
    const request = JSON.parse(String(init.body));
    seen.system = request.messages[0].content;
    const { sources } = JSON.parse(request.messages[1].content);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ candidates: [build(sources)] }) } }] });
  };
  return { fetchImpl, seen };
}

const base = (sources, extra = {}) => ({
  scope: "project", kind: "project_fact", key: "project.guideline.dose", value: "2024 版指南推荐利伐沙班 15 mg qd", summary: "指南剂量",
  origin: "explicit", importance: 0.7, sensitive: false, sourceRef: sources[0].sourceRef, evidenceQuote: sources[0].text, ...extra,
});

test("a date the source states becomes the fact's interval; the model is told what to give and what not to invent", async () => {
  const text = "2024 版指南自 2024-03-01 起推荐利伐沙班 15 mg qd，2026-01-01 前有效";
  const store = new Store();
  const { fetchImpl, seen } = proposing((sources) => base(sources, { validFrom: "2024-03-01", validUntil: "2026-01-01" }));
  await new MemoryIntelligence(config, store, { fetchImpl }).recordRun(project(), run(), [userMessage("m1", text)]);
  const written = writeOf(store, "project.guideline.dose").input;
  assert.equal(written.validFrom, "2024-03-01T00:00:00.000Z");
  assert.equal(written.invalidSince, "2026-01-01T00:00:00.000Z");
  assert.match(seen.system, /validFrom and\/or validUntil as ISO dates/);
  assert.match(seen.system, /Never invent a date/);
});

test("a date the source never mentions, one that is not a date, or an empty interval is dropped and the memory is kept", async () => {
  for (const [label, extra, text] of [
    ["a year the source does not contain", { validUntil: "2019-05-01" }, "2024 版指南推荐利伐沙班 15 mg qd"],
    ["not an ISO date", { validFrom: "last spring" }, "2024 版指南推荐利伐沙班 15 mg qd"],
    ["an inverted interval", { validFrom: "2025-01-01", validUntil: "2024-01-01" }, "2024 和 2025 年的指南推荐利伐沙班"],
    ["a month the model made up in a year the source gives (a day is not checked, a year is)", { validFrom: "2023-01-01" }, "2024 版指南推荐利伐沙班 15 mg qd"],
  ]) {
    const store = new Store();
    const { fetchImpl } = proposing((sources) => base(sources, extra));
    const result = await new MemoryIntelligence(config, store, { fetchImpl }).recordRun(project(), run(), [userMessage("m1", text)]);
    assert.equal(result.extracted, 1, `${label}: the memory is written`);
    assert.equal(writeOf(store, "project.guideline.dose").input.validFrom ?? null, null, label);
    assert.equal(writeOf(store, "project.guideline.dose").input.invalidSince ?? null, null, label);
  }
});

test("a re-observation keeps the interval a source stated and adopts one for a fact that had none", async () => {
  const text = "2024 版指南自 2024-03-01 起推荐利伐沙班 15 mg qd";
  const store = new Store([{ scope: "project", scopeId: "project_1", kind: "project_fact", key: "project.guideline.dose",
    value: "2024 版指南推荐利伐沙班 15 mg qd", origin: "explicit", status: "active", validFrom: "2024-02-01T00:00:00Z", supersededBy: null }]);
  const again = proposing((sources) => base(sources, { validFrom: "2024-03-01" }));
  await new MemoryIntelligence(config, store, { fetchImpl: again.fetchImpl }).recordRun(project(), run(), [userMessage("m1", text)]);
  assert.equal(writeOf(store, "project.guideline.dose").input.validFrom, "2024-02-01T00:00:00Z", "what was recorded first stands");
});

test("sources the fact rests on are recorded only when they are well-formed and appear in the source it quotes", async () => {
  const output = { summary: "found", data: { hits: [{ sourceId: SOURCE, text: "利伐沙班 15 mg qd" }, { doi: "10.1056/NEJMoa1009638" }] } };
  const store = new Store();
  const { fetchImpl } = proposing((sources) => {
    const tool = sources.find((source) => source.role === "tool");
    return {
      scope: "project", kind: "project_fact", key: "project.cites", value: "试验结果支持利伐沙班 15 mg qd", summary: "引用",
      origin: "system", importance: 0.6, sensitive: false, sourceRef: tool.sourceRef, evidenceQuote: "利伐沙班 15 mg qd",
      // one real id, one DOI in another letter case, one id the result never showed, one that is no id at all
      sources: [SOURCE, "10.1056/nejmoa1009638", `src_${"e".repeat(32)}`, "the 2024 guideline", SOURCE],
    };
  });
  const result = await new MemoryIntelligence(config, store, { fetchImpl })
    .recordRun(project(), run(), [userMessage("m1", "继续"), toolMessage("m2", output)]);
  assert.equal(result.extracted, 1);
  assert.deepEqual(writeOf(store, "project.cites").options.sourceLinks, [
    { type: "knowledge_source", id: SOURCE, version: null },
    { type: "doi", id: "10.1056/nejmoa1009638", version: null },
  ], "recorded as identifiers, deduplicated, with no version invented");
});

test("a statement that disagrees with a stored one is kept beside it, marked, and replaces nothing", async () => {
  const label = { scope: "project", scopeId: "project_1", kind: "project_fact", key: "project.dose.label", value: "说明书写 20 mg qd",
    origin: "system", status: "active" };
  const store = new Store([label]);
  const { fetchImpl, seen } = proposing((sources) => base(sources, { key: "project.dose.said", value: "研究者说在用 10 mg qd", conflictsWith: "project.dose.label" }));
  const result = await new MemoryIntelligence(config, store, { fetchImpl }).recordRun(project(), run(), [userMessage("m1", "我们在用 10 mg qd")]);
  const [written] = result.written;
  assert.equal(written.key, "project.dose.said");
  assert.deepEqual(store.supersessions, [], "a disagreement replaces nothing");
  assert.equal([...store.records.values()].find((record) => record.key === "project.dose.label").status, "active", "the stored statement stays in force");
  assert.deepEqual(store.conflicts.map((conflict) => [conflict.recordId, conflict.otherId]), [[written.id, "record_1"]]);
  assert.deepEqual(result.disagreements, [{ recordId: written.id, otherId: "record_1", key: "project.dose.said", otherKey: "project.dose.label" }]);
  assert.match(seen.system, /give the stored fact's key as conflictsWith/);
});

test("a disagreement the store cannot verify is reported and the new fact is still kept", async () => {
  for (const [conflictsWith, stored, why] of [
    ["project.nothing", [], /no memory in force this conversation can see/],
    // another project's memory is not this conversation's to dispute
    ["project.dose.label", [{ scope: "project", scopeId: "project_2", kind: "project_fact", key: "project.dose.label", value: "x", origin: "system", status: "active" }], /no memory in force this conversation can see/],
    // a replaced statement is not in force
    ["project.dose.label", [{ scope: "project", scopeId: "project_1", kind: "project_fact", key: "project.dose.label", value: "x", origin: "system", status: "superseded" }], /no memory in force this conversation can see/],
  ]) {
    const store = new Store(stored);
    const { fetchImpl } = proposing((sources) => base(sources, { key: "project.dose.said", conflictsWith }));
    const result = await new MemoryIntelligence(config, store, { fetchImpl }).recordRun(project(), run(), [userMessage("m1", "我们在用 10 mg qd")]);
    assert.equal(result.extracted, 1, "the memory is written");
    assert.ok(result.rejectionReasons.some((reason) => why.test(reason)), result.rejectionReasons.join("; "));
    assert.deepEqual(store.conflicts, []);
    assert.deepEqual(result.disagreements, []);
  }
});

test("a store that refuses the relation costs the run nothing; one that fails unexpectedly is not swallowed", async () => {
  const label = { scope: "project", scopeId: "project_1", kind: "project_fact", key: "project.dose.label", value: "x", origin: "system", status: "active" };
  const refuse = new Store([label]);
  refuse.conflictFailure = new HttpError(409, "memory_conflict_invalid", "A replaced or archived memory is not in conflict with anything.");
  const { fetchImpl } = proposing((sources) => base(sources, { key: "project.dose.said", conflictsWith: "project.dose.label" }));
  const result = await new MemoryIntelligence(config, refuse, { fetchImpl }).recordRun(project(), run(), [userMessage("m1", "我们在用 10 mg qd")]);
  assert.equal(result.extracted, 1);
  assert.ok(result.rejectionReasons.some((reason) => /could not be marked as disagreeing.*memory_conflict_invalid/.test(reason)));

  const broken = new Store([label]);
  broken.conflictFailure = new Error("connection lost");
  await assert.rejects(() => new MemoryIntelligence(config, broken, { fetchImpl }).recordRun(project(), run(), [userMessage("m1", "我们在用 10 mg qd")]),
    /connection lost/, "an unexpected failure is traceable, never reported as success");
});

test("an outside agent's episode proposes and disputes nothing: no disagreement is recorded for a memory that is not in force", async () => {
  const label = { scope: "project", scopeId: "project_1", kind: "project_fact", key: "project.dose.label", value: "x", origin: "system", status: "active" };
  const store = new Store([label]);
  const { fetchImpl } = proposing((sources) => base(sources, { key: "project.dose.said", conflictsWith: "project.dose.label" }));
  const result = await new MemoryIntelligence(config, store, { fetchImpl })
    .recordRun(project(), run(), [userMessage("m1", "我们在用 10 mg qd")], { holdForOwner: true });
  assert.deepEqual(store.conflicts, []);
  assert.deepEqual(result.disagreements, []);
});

test("a run that wrote nothing still returns the one result shape, with its disagreements empty", async () => {
  const result = await new MemoryIntelligence({ ...config, memoryExtractionEnabled: false }, new Store(), {}).recordRun(project(), run(), []);
  assert.deepEqual(result.disagreements, []);
});
