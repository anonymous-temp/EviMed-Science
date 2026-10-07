// `scripts/ops/reclassify-sources.mjs`: the type a document shows moves to the one list of types, the judge asked on the stored
// text where it can be, and nothing about a document's content, depth or understanding moves with it.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SOURCE_TYPES } from "@evimed/domain";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { ProductJobs } from "../src/productJobs.mjs";
import { SourceService } from "../src/sourceService.mjs";
import { parseArguments, reclassifySources } from "../../../scripts/ops/reclassify-sources.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const durable = { timeout: 30_000, skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const NOW = new Date("2026-10-08T09:00:00.000Z");

async function fixture(t) {
  const database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  const owner = `reclassify_${randomUUID()}`;
  const documents = new ProductDocuments(database);
  const sources = new SourceService(documents, new ProductJobs(database));
  t.after(async () => {
    await database.query("DELETE FROM evimed_control.users WHERE id=$1", [owner]);
    await database.close();
  });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Owner','development')", [owner]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Default',1048576)", [owner]);
  let counter = 0;
  /** A document as the old first pass left it: its type is a guess from the name and the format. */
  const legacy = async (name, docType, patch = {}) => {
    counter += 1;
    const { source } = await sources.register(owner, { projectId: "default", connector: { type: "upload", id: "default-library" }, path: `knowledge-base/${name}`,
      sha256: counter.toString(16).padStart(64, "0"), size: 100, mimeType: "application/octet-stream", mtime: "2026-09-06T00:00:00.000Z" });
    return documents.put(owner, "source", source.id, { ...source.payload, docType, depth: "structured", status: "complete", ...patch },
      { expectedRevision: source.revision, projectId: "default" });
  };
  return { database, documents, sources, owner, legacy };
}

/** The service as the script reads it: real records, and a stored text only for the documents the test gives one. */
const withText = (sources, texts) => ({ get: (userId, id) => sources.get(userId, id), loadCapture: async (_userId, source) => (texts.has(source.id) ? { input: { text: texts.get(source.id) } } : null) });

test("a document's type is judged from its stored text, else its format says it; what a person or the judge decided stays", durable, async (t) => {
  const { documents, sources, owner, legacy } = await fixture(t);
  const policy = await legacy("hospital-rules.pdf", "published-paper");
  const label = await legacy("amoxicillin.docx", "published-paper");
  const unsure = await legacy("minutes.pdf", "published-paper");
  const table = await legacy("cohort.xlsx", "cohort-data");
  const textFile = await legacy("memo.md", "note-memo");
  const named = await legacy("by-me.pdf", "research-protocol", { override: { docType: "research-protocol", depth: "deep", reason: "mine", at: "x" } });
  const judged = await legacy("judged.pdf", "drug-label", { typeClassification: { origin: "judge", generation: 1 } });
  const stale = await legacy("old-recording.pdf", "audio-recording", { typeClassification: { origin: "judge", generation: 1 } });
  const texts = new Map([[policy.id, "医院药事管理制度汇编"], [label.id, "阿莫西林说明书"], [unsure.id, "会议记录"], [textFile.id, "# 备忘"]]);
  const asked = [];
  const judge = async (request) => {
    asked.push(request.filename.replace("knowledge-base/", ""));
    assert.ok(request.text.length <= 1500);
    return { [policy.id]: "policy-document", [label.id]: "drug-label", [textFile.id]: "other" }[request.sourceId] ?? null;
  };
  const stored = new Map();
  for (const source of [policy, label, unsure, table, textFile, named, judged, stale]) stored.set(source.id, source.payload);

  // Report mode writes nothing.
  const report = await reclassifySources(documents.database, { apply: false, userId: owner, limit: 100, judge, now: () => NOW, sources: withText(sources, texts) });
  assert.equal(report.applied, false);
  assert.deepEqual(report.items.map((item) => [item.before, item.after, item.by]).sort(), [
    ["audio-recording", "document", "format"],
    ["cohort-data", "dataset", "format"],
    ["note-memo", "document", "format"],
    ["published-paper", "document", "format"],
    ["published-paper", "drug-label", "judge"],
    ["published-paper", "policy-document", "judge"],
  ]);
  for (const [id, payload] of stored) assert.equal((await sources.get(owner, id)).payload.docType, payload.docType, "report mode changes nothing");
  assert.deepEqual(asked.sort(), ["amoxicillin.docx", "hospital-rules.pdf", "memo.md", "minutes.pdf"], "only text documents with a stored text are asked about; tables and the decided are not");

  const applied = await reclassifySources(documents.database, { apply: true, userId: owner, limit: 100, judge, now: () => NOW, sources: withText(sources, texts) });
  assert.equal(applied.judged, 2);
  assert.equal(applied.format, 4);
  assert.equal(applied.failed, 0);
  const after = async (source) => (await sources.get(owner, source.id)).payload;
  assert.equal((await after(policy)).docType, "policy-document");
  assert.deepEqual((await after(policy)).typeClassification, { origin: "judge", generation: 1, reclassifiedAt: NOW.toISOString() });
  assert.equal((await after(label)).docType, "drug-label");
  assert.equal((await after(unsure)).docType, "document", "the judge did not settle: the format's type, never a paper");
  assert.equal((await after(table)).docType, "dataset");
  assert.equal((await after(textFile)).docType, "document", "a judge that only says other leaves the format's type");
  assert.equal((await after(stale)).docType, "document", "a type the list no longer has is brought onto it");
  assert.equal((await after(named)).docType, "research-protocol", "what the researcher set is theirs");
  assert.equal((await after(judged)).docType, "drug-label");
  // Nothing else about a document moved: not its depth, status, generation, understanding, or what it says.
  for (const source of [policy, label, unsure, table, textFile, named, judged, stale]) {
    const { docType: _docType, typeClassification: _classification, updatedAt: _updatedAt, ...rest } = await after(source);
    const { docType: _before, typeClassification: _was, updatedAt: _wasAt, ...original } = stored.get(source.id);
    assert.deepEqual(rest, original, "only the type moved");
  }

  // Idempotent: what the run decided is not asked again, and a second run has nothing to do.
  asked.length = 0;
  const second = await reclassifySources(documents.database, { apply: true, userId: owner, limit: 100, judge, now: () => NOW, sources: withText(sources, texts) });
  assert.equal(second.documents, 0);
  assert.deepEqual(asked, []);
});

test("without a judge every undecided document takes the type its format says, and never a paper", durable, async (t) => {
  const { documents, sources, owner, legacy } = await fixture(t);
  const pdf = await legacy("a.pdf", "published-paper");
  const deck = await legacy("a.pptx", "lecture-slides");
  const image = await legacy("a.png", "image-figure");
  const page = await legacy("a.html", "note-memo");
  const result = await reclassifySources(documents.database, { apply: true, userId: owner, limit: 100, judge: null, now: () => NOW, sources: withText(sources, new Map()) });
  assert.equal(result.format, 4);
  assert.deepEqual(await Promise.all([pdf, deck, image, page].map(async (source) => (await sources.get(owner, source.id)).payload.docType)),
    ["document", "lecture-slides", "image-figure", "webpage"]);
  for (const item of result.items) assert.ok(SOURCE_TYPES.includes(item.after));
});

test("the report never carries what a document says, and a document that moved meanwhile is left for the next run", durable, async (t) => {
  const { documents, sources, owner, legacy } = await fixture(t);
  const pdf = await legacy("secret-contract.pdf", "published-paper", { outputs: { summary: "绝密的合同条款" } });
  const raced = await legacy("raced.pdf", "published-paper");
  const racing = { get: async (userId, id) => { const source = await sources.get(userId, id); if (id === raced.id) await documents.put(userId, "source", id, { ...source.payload, updatedAt: "moved" }, { expectedRevision: source.revision, projectId: "default" }); return source; }, loadCapture: async () => null };
  const result = await reclassifySources(documents.database, { apply: true, userId: owner, limit: 100, judge: null, now: () => NOW, sources: racing });
  assert.ok(!JSON.stringify(result).includes("绝密"));
  assert.equal(result.skipped, 1);
  assert.equal(result.failed, 0);
  assert.equal((await sources.get(owner, pdf.id)).payload.docType, "document");
  assert.equal((await sources.get(owner, raced.id)).payload.docType, "published-paper", "left as it was");
});

test("the arguments are report-only unless --apply, and a bad one is refused", () => {
  assert.deepEqual(parseArguments([]), { apply: false, judge: true, userId: null, limit: 1000 });
  assert.deepEqual(parseArguments(["--apply", "--no-judge", "--user", "u1", "--limit", "20"]), { apply: true, judge: false, userId: "u1", limit: 20 });
  assert.throws(() => parseArguments(["--limit", "0"]), /limit/);
  assert.throws(() => parseArguments(["--user"]), /needs a value/);
  assert.throws(() => parseArguments(["--force"]), /unknown argument/);
});
