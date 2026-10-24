import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { isCompiledPage } from "../src/openVikingSourceSync.mjs";
import { knowledgeDigest, knowledgeSourceSetDigest, readKnowledgeSourceInput, readKnowledgeSourceInputs } from "../src/knowledgeGeneration.mjs";

const hash = text => createHash("sha256").update(text).digest("hex");
const id = n => `src_${n.toString(16).padStart(32, "0")}`;
function fixture(count = 1) {
  const records = new Map(), captures = new Map(), calls = [];
  for (let n = 1; n <= count; n += 1) {
    const sourceId = id(n), text = `Captured content ${n}.`;
    const payload = { generation: 2, version: 3, familyId: `family-${n}`, status: "complete", paths: [`knowledge-base/documents/${n}.pdf`],
      connector: { type: "upload" }, fingerprint: { sha256: hash(`file-${n}`) }, docType: "other", metadata: { title: `Title ${n}` },
      analysis: { generation: 2, textSha256: hash(text), unitCount: 1, extractor: { name: "parser", version: "1", parser: "local" } } };
    records.set(sourceId, { id: sourceId, kind: "source", projectId: "project", revision: 4, payload, deletedAt: null });
    captures.set(sourceId, { input: { sourceId, generation: 2, units: [{ id: `${sourceId}:g2:u1`, start: 0, end: text.length, text }], text },
      extractor: payload.analysis.extractor, pageMap: null, metadata: payload.metadata, parserCoverage: { state: "complete" } });
  }
  const sources = {
    async get(owner, sourceId) { calls.push(["get", owner, sourceId]); return structuredClone(records.get(sourceId) ?? null); },
    async loadCapture(owner, source) { calls.push(["capture", owner, source.id]); return structuredClone(captures.get(source.id) ?? null); },
    async list(owner, { projectId, limit, cursor, ...filters }) {
      calls.push(["list", owner, projectId, filters]);
      const rows = [...records.values()], offset = Number(cursor ?? 0);
      return { items: rows.slice(offset, offset + limit).map(row => ({ id: row.id })), nextCursor: offset + limit < rows.length ? String(offset + limit) : null };
    },
  };
  return { records, captures, calls, sources, request: { sources, ownerId: "owner", projectId: "project", sourceId: id(1) } };
}

test("compiled origin is checked on every path even when a drive connector is attached", () => {
  for (const type of ["upload", "openlist", "internal"]) for (const folder of ["wiki", "kg"]) {
    assert.equal(isCompiledPage({ payload: { connector: { type }, paths: ["knowledge-base/documents/raw.pdf", `knowledge-base/${folder}/page.md`] } }), true);
  }
  assert.equal(isCompiledPage({ payload: { paths: ["knowledge-base/documents/wiki-notes.md"] } }), false);
});

test("source inputs bind the exact canonical capture, parser, page map and rendered bytes", async () => {
  const f = fixture(), initial = await readKnowledgeSourceInput(f.request);
  assert.equal(initial.receipt.sourceId, id(1));
  assert.equal(initial.receipt.sourceRevision, 4);
  assert.equal(initial.receipt.sourceGeneration, 2);
  assert.equal(initial.receipt.sourceVersion, 3);
  assert.equal(initial.receipt.renditionSha256, hash(initial.text));
  assert.notEqual(initial.receipt.renditionSha256, initial.receipt.textSha256);
  assert.match(initial.text, /Title 1/);
  f.records.get(id(1)).payload.metadata.title = "Renamed";
  f.captures.get(id(1)).metadata.title = "Renamed";
  f.records.get(id(1)).revision += 1;
  const renamed = await readKnowledgeSourceInput(f.request);
  assert.equal(renamed.receipt.textSha256, initial.receipt.textSha256);
  assert.notEqual(renamed.receipt.renditionSha256, initial.receipt.renditionSha256);
  assert.notEqual(renamed.receipt.metadataDigest, initial.receipt.metadataDigest);
  f.captures.get(id(1)).pageMap = [{ page: 1, start: 0, end: f.captures.get(id(1)).input.text.length, status: "ok" }];
  const mapped = await readKnowledgeSourceInput(f.request);
  assert.notEqual(mapped.receipt.pageMapDigest, renamed.receipt.pageMapDigest);
  assert.notEqual(mapped.receipt.renditionSha256, renamed.receipt.renditionSha256);
});

test("foreign, deleted, unreadable and derived sources are refused before reading captured content", async () => {
  const f = fixture();
  for (const change of [row => { row.projectId = "foreign"; }, row => { row.deletedAt = "2026-10-24"; },
    row => { row.payload.status = "removed"; }, row => { row.payload.analysis.generation = 1; },
    row => { row.payload.paths.push("knowledge-base/wiki/derived.md"); }]) {
    const original = structuredClone(f.records.get(id(1))); change(f.records.get(id(1)));
    assert.equal(await readKnowledgeSourceInput(f.request), null);
    f.records.set(id(1), original);
  }
  assert.equal(f.calls.filter(call => call[0] === "capture").length, 0);
  f.records.get(id(1)).payload.status = "needs_attention";
  assert.ok(await readKnowledgeSourceInput(f.request), "a readable partial parse remains usable");
});

test("invalid capture or a source changed while captured cannot certify a generation input", async () => {
  for (const change of [capture => { capture.input.text += "changed"; }, capture => { capture.input.units[0].start = 1; },
    capture => { capture.input.units[0].id = "foreign-unit"; }, capture => { capture.input.generation = 1; },
    capture => { capture.input.units[0].end = String(capture.input.units[0].end); },
    capture => { capture.pageMap = [{ page: 1, start: 0, end: 999, status: "ok" }]; }]) {
    const f = fixture(); change(f.captures.get(id(1)));
    await assert.rejects(readKnowledgeSourceInput(f.request), { code: "knowledge_source_capture_invalid" });
  }
  const f = fixture(), load = f.sources.loadCapture;
  f.sources.loadCapture = async (...args) => { const capture = await load(...args); f.records.get(id(1)).revision += 1; return capture; };
  await assert.rejects(readKnowledgeSourceInput(f.request), { code: "knowledge_source_changed" });
  const missing = fixture(); missing.captures.clear();
  await assert.rejects(readKnowledgeSourceInput(missing.request), { code: "knowledge_source_capture_invalid" });
  for (const pageMap of [null, [{ page: 1, start: 0, end: 1, status: "ok" }]]) {
    const announced = fixture(); announced.records.get(id(1)).payload.analysis.pageCount = 2;
    announced.captures.get(id(1)).pageMap = pageMap;
    await assert.rejects(readKnowledgeSourceInput(announced.request), { code: "knowledge_source_capture_invalid" });
  }
});

test("the source manifest covers all pages, includes partial readable inputs and never accepts a truncated scan", async () => {
  const f = fixture(101); f.records.get(id(101)).payload.status = "needs_attention";
  const inputs = await readKnowledgeSourceInputs(f.request);
  assert.equal(inputs.length, 101); assert.equal(inputs.at(-1).receipt.sourceId, id(101));
  assert.ok(f.calls.filter(call => call[0] === "list").every(call => !Object.hasOwn(call[3], "state")));
  await assert.rejects(readKnowledgeSourceInputs({ ...f.request, maxSources: 100 }), { code: "knowledge_source_scan_incomplete" });
  const digest = knowledgeSourceSetDigest({ referenceId: "policy", revision: 1 }, inputs);
  assert.equal(knowledgeSourceSetDigest({ revision: 1, referenceId: "policy" }, [...inputs].reverse()), digest);
  assert.notEqual(knowledgeSourceSetDigest({ referenceId: "policy", revision: 2 }, inputs), digest);
  assert.notEqual(knowledgeSourceSetDigest({ referenceId: "policy", revision: 1 }, inputs.slice(1)), digest);
  assert.equal(knowledgeDigest({ b: 2, a: 1 }), knowledgeDigest({ a: 1, b: 2 }));
});

test("duplicate rows, nonprogressing pagination and ledger failures never produce a complete manifest", async () => {
  const f = fixture();
  f.sources.list = async () => ({ items: [{ id: id(1) }], nextCursor: "same" });
  await assert.rejects(readKnowledgeSourceInputs(f.request), { code: "knowledge_source_scan_incomplete" });
  f.sources.list = async () => { throw Object.assign(new Error("database unavailable"), { code: "ledger_unavailable" }); };
  await assert.rejects(readKnowledgeSourceInputs(f.request), { code: "ledger_unavailable" });
});
