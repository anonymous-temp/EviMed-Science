import assert from "node:assert/strict";
import test from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { rewriteCompiledLinks, KnowledgeVaultExport, frontMatter, noteName, pageTitle, understandingBody } from "../src/knowledgeVaultExport.mjs";

const PROJECT = { id: "prj_1", name: "房颤抗凝" };
const hex = (character, length = 32) => character.repeat(length);

/** A source row as the list returns it. */
function source(n, { path = `knowledge-base/doc-${n}.pdf`, docType = "paper-rct", title, metadata, status = "complete", understood = true, extra = {} } = {}) {
  return { id: `src_${hex(String(n))}`, kind: "source", projectId: PROJECT.id, revision: 1, createdAt: `2026-10-0${n}T00:00:00Z`,
    payload: { paths: [path], docType, status, generation: 1, ...(title ? { title } : {}), ...(metadata ? { metadata } : {}),
      ...(understood ? { currentUnderstandingId: `understanding:${n}` } : {}), fingerprint: { size: 100, sha256: hex("a", 64) }, outputs: {}, ...extra } };
}
const understanding = (src, output) => ({ projectId: PROJECT.id, payload: { recordType: "source-understanding", sourceId: src.id, generation: 1, output } });

function exporter({ sources, understandings = {}, texts = {}, ...limits }) {
  const reads = [];
  const vault = new KnowledgeVaultExport({
    sources: { list: async (_user, { cursor }) => { reads.push(cursor); return { items: cursor ? [] : sources, nextCursor: null }; } },
    documents: { get: async (_user, kind, id) => { assert.equal(kind, "knowledge"); return understandings[id] ?? null; } },
    readText: async (_project, rel) => { if (!(rel in texts)) throw new Error("missing"); return texts[rel]; },
    ...limits,
  });
  return vault;
}
const unpack = (file) => Object.fromEntries(Object.entries(unzipSync(file.bytes)).map(([name, bytes]) => [name, strFromU8(bytes)]));
const linksOf = (text) => [...text.matchAll(/\[\[([^\]|]+)\|[^\]]*\]\]/g)].map((match) => match[1]);

const trial = source(1, { title: "ROCKET AF", metadata: { title: "Rivaroxaban versus warfarin", authors: ["Patel MR", "Mahaffey KW", "Garg J"], publicationDate: "2011-09-08", doi: "10.1056/NEJMoa1009638", source: "N Engl J Med", keywords: ["atrial fibrillation", "Rivaroxaban"] } });
const review = source(2, { docType: "review-guideline", metadata: { title: "房颤抗凝指南", authors: ["中华医学会"], publicationDate: "2023", keywords: ["Atrial Fibrillation"] } });

test("a note per document: the metadata as front matter, then the summary and the claims with their quotations byte for byte", async () => {
  const quote = "In the primary efficacy analysis,\nrivaroxaban was non-inferior to warfarin (HR 0.79; 95% CI 0.66–0.96).";
  const vault = exporter({ sources: [review, trial], understandings: {
    "understanding:1": understanding(trial, { summary: "利伐沙班在非瓣膜性房颤中不劣于华法林。", claims: [
      { id: "c1", statement: "主要终点上利伐沙班不劣于华法林。", evidence: [{ sourceId: trial.id, quote }, { sourceId: trial.id, quote: "“二次引用”" }] },
      { id: "c2", statement: "   ", evidence: [] }] }),
    "understanding:2": understanding(review, { summary: "指南推荐。", claims: [] }),
  } });
  const file = await vault.export("owner", PROJECT);
  assert.equal(file.mimeType, "application/zip");
  assert.deepEqual([file.notes, file.pages], [2, 0]);
  const files = unpack(file);
  assert.deepEqual(Object.keys(files).sort(), ["房颤抗凝/index.md", "房颤抗凝/sources/ROCKET AF.md", "房颤抗凝/sources/房颤抗凝指南.md"]);
  const note = files["房颤抗凝/sources/ROCKET AF.md"];
  assert.match(note, /^---\ntitle: "ROCKET AF"\nauthors: \["Patel MR", "Mahaffey KW", "Garg J"\]\nyear: 2011\ndoi: "10\.1056\/NEJMoa1009638"\nsource: "N Engl J Med"\ntype: "[^"]+"\nkeywords: \["atrial fibrillation", "Rivaroxaban"\]\n---\n/);
  assert.match(note, /# ROCKET AF\n\n## 摘要\n\n利伐沙班在非瓣膜性房颤中不劣于华法林。\n\n## 论断\n\n1\. 主要终点上利伐沙班不劣于华法林。\n   > In the primary efficacy analysis,\n   > rivaroxaban was non-inferior to warfarin \(HR 0\.79; 95% CI 0\.66–0\.96\)\.\n   > “二次引用”\n/);
  assert.equal((note.match(/^2\. /gm) ?? []).length, 0, "a claim with no statement is not a claim");
  // The two share a keyword (case folded), so each points at the other, and both at the index.
  assert.match(note, /## 相关\n\n- \[\[sources\/房颤抗凝指南\|房颤抗凝指南\]\]\n/);
  assert.match(files["房颤抗凝/sources/房颤抗凝指南.md"], /- \[\[sources\/ROCKET AF\|ROCKET AF\]\]/);
  assert.match(note, /\n\n---\n\[\[index\|知识库索引\]\]\n$/);
  assert.match(files["房颤抗凝/sources/房颤抗凝指南.md"], /year: 2023/, "a bare year is a year");
});

test("the index lists every note, and every link in the vault lands on a file in it", async () => {
  const twin = source(3, { title: "ROCKET AF", metadata: { title: "x" } });
  const odd = source(4, { title: "A/B: C? #1 [draft] | ^x" });
  const vault = exporter({ sources: [trial, twin, odd, review], understandings: {
    "understanding:1": understanding(trial, { summary: "一。", claims: [] }), "understanding:3": understanding(twin, { summary: "二。", claims: [] }),
    "understanding:4": understanding(odd, { summary: "三。", claims: [] }), "understanding:2": understanding(review, { summary: "四。", claims: [] }),
  } });
  const files = unpack(await vault.export("owner", PROJECT));
  const root = "房颤抗凝/";
  const names = Object.keys(files).filter((name) => name.includes("/sources/")).map((name) => name.slice(root.length, -3));
  assert.deepEqual(names.sort(), ["sources/A B C 1 draft x", "sources/ROCKET AF", "sources/ROCKET AF (2)", "sources/房颤抗凝指南"].sort(),
    "a repeated name is numbered and a character Obsidian refuses in a link is a space");
  const index = files[`${root}index.md`];
  assert.match(index, /^---\ntitle: "房颤抗凝"\n---\n/);
  assert.deepEqual(linksOf(index).sort(), names.sort(), "the index names every note and only them");
  assert.match(index, /\[\[sources\/ROCKET AF\|ROCKET AF\]\] — Patel MR、Mahaffey KW 等 · 2011/);
  for (const [name, text] of Object.entries(files)) for (const target of linksOf(text)) {
    assert.ok(`${root}${target}.md` in files || target === "index" && `${root}index.md` in files, `${name} links to ${target}, which is not in the vault`);
  }
});

test("a document that cannot be read yet is not exported and not named; a note is the researcher's own text", async () => {
  const reading = source(5, { title: "还在读取", status: "parsing", understood: false });
  const failed = source(6, { title: "没读出来", status: "failed", understood: false });
  const note = source(7, { path: "knowledge-base/notes/组会-1a2b.md", docType: "note-memo", title: "组会记录", understood: true });
  const vault = exporter({ sources: [reading, failed, note, review], texts: { "knowledge-base/notes/组会-1a2b.md": "# 组会记录\n\n确定 C1–C3 分开合并。\n" },
    understandings: { "understanding:7": understanding(note, { summary: "不该出现的摘要", claims: [] }), "understanding:2": understanding(review, { summary: "指南。", claims: [] }) } });
  const files = unpack(await vault.export("owner", PROJECT));
  assert.deepEqual(Object.keys(files).filter((name) => name.includes("/sources/")).sort(), ["房颤抗凝/sources/房颤抗凝指南.md", "房颤抗凝/sources/组会记录.md"]);
  const text = files["房颤抗凝/sources/组会记录.md"];
  assert.match(text, /^---\ntitle: "组会记录"\ntype: "[^"]+"\n---\n\n# 组会记录\n\n确定 C1–C3 分开合并。\n\n---\n\[\[index\|知识库索引\]\]\n$/);
  assert.equal(text.split("# 组会记录").length, 2, "the note's own heading is not written twice");
  assert.doesNotMatch(text, /不该出现的摘要/);
  assert.doesNotMatch(files["房颤抗凝/index.md"], /还在读取|没读出来/);
});

test("knowledge pages are exported where the folder holds them, and the vault is the documents where it does not", async () => {
  const page = source(8, { path: "knowledge-base/wiki/concepts/doac.md", docType: "wiki-page", understood: false });
  const index = source(9, { path: "knowledge-base/wiki/index.md", docType: "wiki-page", understood: false });
  const withPages = exporter({ sources: [page, index, review], texts: {
    "knowledge-base/wiki/concepts/doac.md": '---\ntitle: "直接口服抗凝药"\n---\n# 直接口服抗凝药\n\n见 [[华法林]]。\n',
    "knowledge-base/wiki/index.md": "# 目录\n\n- [[concepts/doac]]\n",
  }, understandings: { "understanding:2": understanding(review, { summary: "指南。", claims: [] }) } });
  const file = await withPages.export("owner", PROJECT);
  assert.equal(file.pages, 2);
  const files = unpack(file);
  assert.equal(files["房颤抗凝/wiki/concepts/doac.md"], '---\ntitle: "直接口服抗凝药"\n---\n# 直接口服抗凝药\n\n见 [[华法林]]。\n', "a page is exported as it is");
  assert.match(files["房颤抗凝/index.md"], /## 知识页\n\n- \[\[wiki\/concepts\/doac\|直接口服抗凝药\]\]\n- \[\[wiki\/index\|目录\]\]\n/);
  // Without any, there is no heading for them and the export is not an error.
  const without = unpack(await exporter({ sources: [review], understandings: { "understanding:2": understanding(review, { summary: "指南。", claims: [] }) } }).export("owner", PROJECT));
  assert.doesNotMatch(without["房颤抗凝/index.md"], /知识页/);
  assert.equal(Object.keys(without).some((name) => name.includes("/wiki/")), false);
});

test("a page link written from the tree's root, in a page below it, still leads to the page by its name", async () => {
  // The engine writes `concept/Alpha.md` from `method/Run.md` as often as `../concept/Alpha.md`; read from the page's own
  // directory the first names nothing, and the name is the one thing both say.
  const alpha = source(8, { path: "knowledge-base/wiki/concept/Alpha.md", docType: "wiki-page", understood: false });
  const run = source(9, { path: "knowledge-base/wiki/method/Run.md", docType: "wiki-page", understood: false });
  const other = source(7, { path: "knowledge-base/wiki/method/Alpha.md", docType: "wiki-page", understood: false });
  const files = unpack(await exporter({ sources: [alpha, run], roots: () => ({ wiki: "viking://user/u/resources/p/p/wiki", kg: "viking://user/u/resources/p/p/kg" }), texts: {
    "knowledge-base/wiki/concept/Alpha.md": "# Alpha\n",
    "knowledge-base/wiki/method/Run.md": "# Run\n\n[Alpha](concept/Alpha.md) and [Gone](concept/Gone.md).\n",
  } }).export("owner", PROJECT));
  assert.match(files["房颤抗凝/wiki/method/Run.md"], /\[Alpha\]\(\.\.\/concept\/Alpha\.md\)/, "found by its name");
  assert.match(files["房颤抗凝/wiki/method/Run.md"], /\[Gone\]\(concept\/Gone\.md\)/, "a page the vault does not hold is left as written");
  // Two pages of one name are not guessed between.
  const ambiguous = unpack(await exporter({ sources: [alpha, run, other], roots: () => ({ wiki: "viking://user/u/resources/p/p/wiki", kg: "viking://user/u/resources/p/p/kg" }), texts: {
    "knowledge-base/wiki/concept/Alpha.md": "# Alpha\n", "knowledge-base/wiki/method/Alpha.md": "# Alpha too\n",
    "knowledge-base/wiki/method/Run.md": "# Run\n\n[Alpha](concept/Alpha.md)\n",
  } }).export("owner", PROJECT));
  assert.match(ambiguous["房颤抗凝/wiki/method/Run.md"], /\[Alpha\]\(\.\.\/concept\/Alpha\.md\)/, "its own path still resolves");
});

test("an understanding that cannot be read costs the note its body and not the vault", async () => {
  const reported = [];
  const vault = new KnowledgeVaultExport({
    sources: { list: async () => ({ items: [trial, review], nextCursor: null }) },
    documents: { get: async (_user, _kind, id) => { if (id === "understanding:1") throw Object.assign(new Error("down"), { code: "product_state_unavailable" }); return understanding(review, { summary: "指南。", claims: [] }); } },
    report: (code) => reported.push(code),
  });
  const files = unpack(await vault.export("owner", PROJECT));
  assert.equal(Object.keys(files).length, 3);
  assert.doesNotMatch(files["房颤抗凝/sources/ROCKET AF.md"], /## 摘要/);
  assert.match(files["房颤抗凝/sources/ROCKET AF.md"], /doi: /);
  assert.deepEqual(reported, ["product_state_unavailable"]);
  // An understanding that belongs to another generation of the document is not this document's.
  const stale = new KnowledgeVaultExport({ sources: { list: async () => ({ items: [review], nextCursor: null }) },
    documents: { get: async () => ({ projectId: PROJECT.id, payload: { sourceId: review.id, generation: 9, output: { summary: "旧一代", claims: [] } } }) } });
  assert.doesNotMatch(Object.values(unpack(await stale.export("owner", PROJECT))).join("\n"), /旧一代/);
});

test("the archive limits refuse the export the way the project and account exports are refused", async () => {
  const understandings = { "understanding:1": understanding(trial, { summary: "一。", claims: [] }), "understanding:2": understanding(review, { summary: "二。", claims: [] }) };
  await assert.rejects(exporter({ sources: [trial, review], understandings, maxEntries: 2 }).export("owner", PROJECT), { status: 413, code: "archive_too_large" });
  await assert.rejects(exporter({ sources: [trial, review], understandings, maxBytes: 100 }).export("owner", PROJECT), { status: 413, code: "archive_too_large" });
  assert.equal((await exporter({ sources: [trial, review], understandings, maxEntries: 3 }).export("owner", PROJECT)).notes, 2);
});

test("an empty library is a vault with an index, and the helpers are what they say", () => {
  assert.equal(noteName("  ", "资料"), "资料");
  assert.equal(noteName("../.hidden/名字", "x"), "hidden 名字");
  assert.equal(frontMatter([["a", "x\"y"], ["b", []], ["c", 2011], ["d", null], ["e", ["p", "q"]]]), '---\na: "x\\"y"\nc: 2011\ne: ["p", "q"]\n---\n');
  assert.equal(pageTitle('---\ntitle: "T"\n---\n# H\n', "f"), "T");
  assert.equal(pageTitle("# 标题 \n正文", "f"), "标题");
  assert.equal(pageTitle("没有标题", "f"), "f");
  assert.equal(understandingBody({ summary: "", claims: [] }), "");
});

test("a compiled page's links lead into the vault: documents to their notes, pages to their files, quotations kept", () => {
  const roots = { wiki: "viking://user/u-1/resources/p/p-1/wiki", kg: "viking://user/u-1/resources/p/p-1/kg" };
  const src = "src_00000000000000000000000000000001";
  const notes = new Map([[src, "sources/Alpha 协议.md"]]);
  const pages = new Map([["wiki/index.md", "wiki/index.md"], ["wiki/concept/Alpha 协议.md", "wiki/concept/Alpha 协议.md"], ["wiki/entity/Beta网关.md", "wiki/entity/Beta网关.md"]]);
  const context = { roots, noteOf: (/** @type {string} */ id) => notes.get(id) ?? null,
    pageOf: (/** @type {string} */ tree, /** @type {string} */ rel) => pages.get(`${tree}/${rel}`) ?? pages.get(`${tree}/${rel}.md`) ?? null };
  const page = [
    "---", "type: entity", "title: Beta 网关", "sources:", `  - viking://user/u-1/resources/p/p-1/sources/${src}.md`, "---", "",
    `周期为 64 秒 [Alpha](viking://user/u-1/resources/p/p-1/sources/${src}.md "默认同步周期为 \\"64\\" 秒")，另见 [协议](../concept/Alpha 协议.md#定义)、`,
    `[目录](${roots.wiki}/index.md)、[丢了后缀](viking://user/u-1/resources/p/p-1/sources/${src})、[外部](https://example.org/a b) 和 [不在库里](viking://user/u-1/resources/p/p-1/sources/src_ffffffffffffffffffffffffffffffff.md)。`, "",
  ].join("\n");
  const rewritten = rewriteCompiledLinks(page, { ...context, file: "wiki/entity/Beta网关.md", tree: "wiki", rel: "entity/Beta网关.md" });
  assert.equal(rewritten, [
    "---", "type: entity", "title: Beta 网关", "sources:", "  - ../../sources/Alpha%20%E5%8D%8F%E8%AE%AE.md", "---", "",
    '周期为 64 秒 [Alpha](../../sources/Alpha%20%E5%8D%8F%E8%AE%AE.md "默认同步周期为 \\"64\\" 秒")，另见 [协议](../concept/Alpha%20%E5%8D%8F%E8%AE%AE.md#定义)、',
    "[目录](../index.md)、[丢了后缀](../../sources/Alpha%20%E5%8D%8F%E8%AE%AE.md)、[外部](https://example.org/a b) 和 [不在库里](viking://user/u-1/resources/p/p-1/sources/src_ffffffffffffffffffffffffffffffff.md)。", "",
  ].join("\n"));
  // The graph's relations name their evidence by address too.
  const relations = `${JSON.stringify({ from: "beta", relation: "implements", label: "实现", to: "alpha", evidence: [`viking://user/u-1/resources/p/p-1/sources/${src}.md`] })}\n`;
  assert.deepEqual(JSON.parse(rewriteCompiledLinks(relations, { ...context, file: "kg/relations.jsonl", tree: "kg", rel: "relations.jsonl" })).evidence, ["../sources/Alpha%20%E5%8D%8F%E8%AE%AE.md"]);
});
