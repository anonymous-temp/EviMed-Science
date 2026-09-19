import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { CAPSULE_FACT_KINDS } from "@evimed/domain";
import { CAPSULE_WORK_STYLE_FACT_KINDS } from "../src/capsuleMethods.mjs";
import { createLibraryRoutes, describeLibrarySource, libraryCapsuleEntries, userLibraryDir } from "../src/libraryService.mjs";

const SOURCE = `src_${"a".repeat(32)}`;
const anchor = (quote, start = 10) => ({ sourceId: SOURCE, generation: 1, unitId: `${SOURCE}:g1:u1`, start, end: start + quote.length, quote });

const understanding = {
  generation: 1,
  slots: {
    design: { state: "known", value: "多中心随机对照试验", evidence: [anchor("随机对照", 3)] },
    population: { state: "unknown", reason: "文中没有写" },
  },
  claims: [
    { id: "c1", statement: "利伐沙班推荐剂量为 20 mg 每日一次", evidence: [anchor("推荐剂量为20 mg", 40), anchor("每日一次", 52)] },
    { id: "c2", statement: "利伐沙班推荐剂量为 20 mg 每日一次", evidence: [anchor("推荐剂量为20 mg", 40)] },
  ],
  methods: [{ id: "m1", title: "按肾功能调整剂量", description: "先算肌酐清除率，再查表。", whenToUse: "开始抗凝前",
    steps: ["计算 CrCl", "对照说明书减量"], checks: ["复核体重"], pitfalls: [], evidence: [anchor("肌酐清除率", 80)], status: "draft" }],
};

test("an understanding becomes facts and a labelled draft, each saying whose words it holds", () => {
  const entries = libraryCapsuleEntries({ title: "房颤抗凝指南", sourceId: SOURCE, understanding });
  assert.deepEqual(entries.map((entry) => entry.factKind), ["project_fact", "project_fact", "analysis"], "the unknown slot and the repeated claim add nothing");
  assert.equal(entries[0].content, "据资料《房颤抗凝指南》，研究设计：多中心随机对照试验");
  assert.equal(entries[1].content, "据资料《房颤抗凝指南》：利伐沙班推荐剂量为 20 mg 每日一次");
  assert.match(entries[2].content, /^方法草稿（整理自资料《房颤抗凝指南》；这是这份资料的做法，不是你的方法，也没有验证过）：按肾功能调整剂量\n/);
  assert.match(entries[2].content, /步骤：\n1\. 计算 CrCl\n2\. 对照说明书减量\n核查：\n- 复核体重$/);
  // The quotes travel with the entry, verbatim, pointing into the document.
  assert.deepEqual(entries[1].provenance, [
    { type: "source", id: `${SOURCE}#40-50`, excerpt: "推荐剂量为20 mg" },
    { type: "source", id: `${SOURCE}#52-56`, excerpt: "每日一次" },
  ]);
  // Never a preference, never something a method mount could load.
  for (const entry of entries) {
    assert.ok(CAPSULE_FACT_KINDS.includes(entry.factKind));
    assert.ok(!CAPSULE_WORK_STYLE_FACT_KINDS.includes(entry.factKind), entry.factKind);
    assert.ok(!["profile", "preference", "stance", "expertise", "writing_style"].includes(entry.factKind));
  }
  // Keyed by content: the same understanding keys the same way twice, a changed claim does not.
  assert.deepEqual(libraryCapsuleEntries({ title: "房颤抗凝指南", sourceId: SOURCE, understanding }).map((entry) => entry.key), entries.map((entry) => entry.key));
  const changed = libraryCapsuleEntries({ title: "房颤抗凝指南", sourceId: SOURCE,
    understanding: { ...understanding, claims: [{ id: "c1", statement: "利伐沙班推荐剂量为 15 mg", evidence: [anchor("15 mg", 60)] }] } });
  assert.equal(changed.filter((entry) => entries.some((old) => old.key === entry.key)).length, 2, "the slot and the method are unchanged");
});

test("an entry is bounded to what a capsule entry holds, and a quote to what provenance holds", () => {
  const long = "长".repeat(30_000);
  const [entry] = libraryCapsuleEntries({ title: "t", sourceId: SOURCE, understanding: { claims: [{ id: "c", statement: long,
    evidence: [anchor("引".repeat(2_500))] }] } });
  assert.equal(entry.content.length, 20_000);
  assert.ok(entry.content.endsWith("…"));
  assert.equal(entry.provenance[0].excerpt.length, 2_000);
});

test("the library's directory is the account's, where the runtime mounts it from", () => {
  assert.equal(userLibraryDir({ dataDir: "/data" }, "user-1"), path.join("/data", "users", "user-1", "library"));
  assert.throws(() => userLibraryDir({ dataDir: "/data" }, "../other"), { code: "invalid_id" });
});

test("a document is described from its record: metadata when parsed, the file name when not", () => {
  const described = describeLibrarySource({ id: SOURCE, payload: {
    paths: ["knowledge-base/指南.pdf"], docType: "review-guideline",
    metadata: { title: " 房颤指南 ", authors: ["张三", " ", "李四"], doi: "10.1/x", doiCheck: { status: "unconfirmed" } },
    analysis: { pageCount: 12, tokenEstimate: 3_000, textSha256: "b".repeat(64), parserRevision: "evimed-extract@0.5.0" },
  } });
  assert.deepEqual(described, { title: "房颤指南", authors: ["张三", "李四"], doi: "10.1/x", doiStatus: "unconfirmed",
    kind: "review-guideline", format: "pdf", name: "指南.pdf", pageCount: 12, tokens: 3_000,
    index: { parserRevision: "evimed-extract@0.5.0", textSha256: "b".repeat(64) } });
  const bare = describeLibrarySource({ id: SOURCE, payload: { paths: ["knowledge-base/notes.md"], analysis: {} } });
  assert.equal(bare.title, "notes.md");
  assert.equal(bare.doi, null);
  assert.equal(bare.index, null);
});

test("the routes answer only their own paths, and a switched-off library says so", async () => {
  const store = { async ensureSessionUser() { return { user: { id: "user-1" } }; }, async assertCsrf() {} };
  const handler = createLibraryRoutes({ store, service: null, maxJsonBytes: 1024 });
  assert.equal(await handler({ url: "/api/sources", method: "GET" }, {}), false);
  await assert.rejects(handler({ url: "/api/library", method: "GET" }, {}), { code: "library_unavailable", status: 503 });
  const served = createLibraryRoutes({ store, service: {}, maxJsonBytes: 1024 });
  await assert.rejects(served({ url: "/api/library/not-a-source", method: "DELETE" }, {}), { code: "not_found", status: 404 });
  await assert.rejects(served({ url: `/api/library/${SOURCE}/publish-to-capsule`, method: "GET" }, {}), { code: "not_found" });
});
