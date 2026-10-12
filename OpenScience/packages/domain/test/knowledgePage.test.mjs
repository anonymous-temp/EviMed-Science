import assert from "node:assert/strict";
import test from "node:test";

import {
  KNOWLEDGE_PAGE_LIMITS,
  KNOWLEDGE_UPDATE_HEADING,
  checkKnowledgeEvidence,
  isKnowledgePageSlug,
  knowledgePagePath,
  knowledgePageSlugOfPath,
  knowledgePatchIssues,
  knowledgeSourceMarker,
  mergeUserEditedKnowledgePage,
  parseKnowledgePage,
  renderKnowledgeIndex,
  renderKnowledgePage,
  settleKnowledgePage,
  sourceCitationReferences,
  verifyKnowledgePage,
} from "../index.mjs";

const A = `src_${"a".repeat(32)}`;
const B = `src_${"b".repeat(32)}`;
const TEXTS = new Map([
  [A, "In the primary efficacy analysis, rivaroxaban was non-inferior to warfarin for stroke prevention. Major bleeding occurred in 3.6% of patients."],
  [B, "Apixaban reduced major bleeding compared with warfarin (hazard ratio 0.69). The arrow A --> B marks the pathway."],
]);
/** @param {string} id @returns {{ text: string } | null} */
const resolve = (id) => (TEXTS.has(id) ? { text: String(TEXTS.get(id)) } : null);

const QUOTE_A = "rivaroxaban was non-inferior to warfarin for stroke prevention";
const QUOTE_B = "Apixaban reduced major bleeding compared with warfarin";

/** @returns {any} */
function page() {
  return {
    type: "topic", title: "Anticoagulants in atrial fibrillation",
    sections: [
      { heading: "Stroke prevention", claims: [{ text: "Rivaroxaban was non-inferior to warfarin.", kind: "direct", evidence: [{ sourceId: A, quote: QUOTE_A }] }] },
      { heading: "Bleeding", claims: [{ text: "Two agents are reported to bleed less or comparably.", kind: "synthesized", confidence: "moderate",
        evidence: [{ sourceId: A, quote: "Major bleeding occurred in 3.6% of patients" }, { sourceId: B, quote: QUOTE_B }] }] },
    ],
    related: ["warfarin-inr"],
  };
}

test("a page the platform writes is read back as the same claims with the same quotations", () => {
  const markdown = renderKnowledgePage(page());
  assert.match(markdown, /^---\ntype: topic\ntitle: "Anticoagulants in atrial fibrillation"\n---\n/);
  assert.match(markdown, /\[\[warfarin-inr\]\]/);
  const parsed = parseKnowledgePage(markdown);
  assert.equal(parsed.title, "Anticoagulants in atrial fibrillation");
  assert.equal(parsed.frontMatter.type, "topic");
  const claims = parsed.units.filter((unit) => unit.kind === "claim");
  assert.equal(claims.length, 2);
  assert.deepEqual(claims[0].evidence, [{ sourceId: A, quote: QUOTE_A }]);
  assert.equal(claims[0].section, "Stroke prevention");
  assert.equal(claims[1].evidence.length, 2);
  assert.deepEqual(claims[1].claimMeta, { kind: "synthesized", confidence: "moderate" });
  assert.deepEqual(parsed.units.filter((unit) => unit.kind === "nav").map((unit) => unit.links), [["warfarin-inr"]]);
  // The comment is the platform's citation protocol: the reader of a reply finds the same references in it.
  assert.deepEqual(sourceCitationReferences(markdown).map((entry) => entry.sourceId), [A, A, B]);
});

test("a quotation holding the end of a comment cannot end it early", () => {
  const marker = knowledgeSourceMarker(B, "The arrow A --> B marks the pathway.");
  assert.equal(marker.slice(0, -3).includes("-->"), false);
  const [unit] = parseKnowledgePage(`- The pathway is drawn as an arrow. ${marker}`).units;
  assert.equal(unit.evidence[0].quote, "The arrow A --> B marks the pathway.");
  assert.equal(checkKnowledgeEvidence(unit.evidence[0], resolve).status, "verified");
});

test("every quotation is checked against the document it names, and only a standing quotation makes a sentence stand", () => {
  const markdown = [
    "# T", "",
    `- Stands. ${knowledgeSourceMarker(A, QUOTE_A)}`,
    `- Invented quotation. ${knowledgeSourceMarker(A, "rivaroxaban cured every patient in the trial")}`,
    `- Document not in this project. ${knowledgeSourceMarker(`src_${"c".repeat(32)}`, QUOTE_A)}`,
    `- Too short to carry anything. ${knowledgeSourceMarker(A, "warfarin")}`,
    "- My own thought, no quotation.",
  ].join("\n");
  const result = verifyKnowledgePage(parseKnowledgePage(markdown), resolve);
  assert.deepEqual(result.units.map((unit) => unit.status), ["verified", "unverified", "unverified", "unverified", "unsupported"]);
  assert.deepEqual(result.units.map((unit) => unit.reasons), [[], ["quote_not_found"], ["source_unavailable"], ["quote_invalid"], []]);
  assert.deepEqual(result.counts, { claims: 5, verified: 1, unverified: 3, unsupported: 1 });
  // A verified quotation that is unambiguous in the document comes back with where it is.
  const [first] = result.units;
  assert.equal(String(TEXTS.get(A)).slice(Number(first.evidence[0].start), Number(first.evidence[0].end)), QUOTE_A);
});

test("a statement across documents is read as one, and a researcher's edit that lost its confidence word is a notice, not a failure", () => {
  const markdown = [`- Both reduce bleeding. ${knowledgeSourceMarker(A, "Major bleeding occurred in 3.6% of patients")} ${knowledgeSourceMarker(B, QUOTE_B)}`].join("\n");
  const result = verifyKnowledgePage(parseKnowledgePage(markdown), resolve);
  assert.equal(result.units[0].kind, "synthesized");
  assert.equal(result.units[0].status, "verified");
  assert.deepEqual(result.notices, ["synthesized_without_confidence"]);
});

test("links that lead nowhere are named when the pages are known, and navigation lines are not sentences", () => {
  const markdown = renderKnowledgePage(page());
  const result = verifyKnowledgePage(parseKnowledgePage(markdown), resolve, { pages: new Set(["other"]) });
  assert.deepEqual(result.dangling, ["warfarin-inr"]);
  assert.equal(result.counts.claims, 2);
});

test("the index page has nothing to check", () => {
  const markdown = renderKnowledgeIndex([
    { slug: "aspirin", type: "entity", title: "Aspirin [low dose]", claims: 4, sources: 2 },
    { slug: "afib", type: "topic", title: "Atrial fibrillation", claims: 9, sources: 3 },
  ]);
  assert.match(markdown, /^---\ntype: index\n/);
  assert.match(markdown, /## 主题\n\n- \[\[afib\|Atrial fibrillation\]\] · 9 条 · 3 份资料/);
  assert.ok(markdown.includes("## 实体\n\n- [[aspirin|Aspirin low dose]] · 4 条 · 2 份资料"));
  const result = verifyKnowledgePage(parseKnowledgePage(markdown), resolve);
  assert.deepEqual(result.counts, { claims: 0, verified: 0, unverified: 0, unsupported: 0 });
});

test("a claim that does not stand is held beside the page, never written into it, and the page is not refused", () => {
  /** @type {any} */
  const compiled = {
    slug: "afib", type: "topic", title: "Atrial fibrillation",
    sections: [{ heading: "Findings", claims: [
      { text: "Stands.", kind: "direct", evidence: [{ sourceId: A, quote: QUOTE_A }] },
      { text: "Invented.", kind: "direct", evidence: [{ sourceId: A, quote: "rivaroxaban cured every patient in the trial" }] },
      { text: "Cross-document with one document.", kind: "synthesized", confidence: "high", evidence: [{ sourceId: A, quote: QUOTE_A }] },
      { text: "Direct with two documents.", kind: "direct", evidence: [{ sourceId: A, quote: QUOTE_A }, { sourceId: B, quote: QUOTE_B }] },
      { text: "Cross-document, no confidence.", kind: "synthesized", evidence: [{ sourceId: A, quote: QUOTE_A }, { sourceId: B, quote: QUOTE_B }] },
      { text: "Cross-document, both stand.", kind: "synthesized", confidence: "low", evidence: [{ sourceId: A, quote: QUOTE_A }, { sourceId: B, quote: QUOTE_B }] },
    ] }],
  };
  const settled = settleKnowledgePage(compiled, resolve);
  assert.deepEqual(settled.counts, { claims: 6, kept: 2, held: 4 });
  assert.deepEqual(settled.held.map((entry) => entry.reasons), [["quote_not_found"], ["single_document"], ["multiple_documents"], ["missing_confidence"]]);
  assert.deepEqual(settled.sources.sort(), [A, B]);
  const markdown = renderKnowledgePage(settled.page);
  assert.ok(markdown.includes("Stands.") && markdown.includes("Cross-document, both stand."));
  assert.ok(!markdown.includes("Invented.") && !markdown.includes("Direct with two documents."), "a held claim is not in the file a search reads");
  assert.deepEqual(verifyKnowledgePage(parseKnowledgePage(markdown), resolve).counts, { claims: 2, verified: 2, unverified: 0, unsupported: 0 });
});

test("a section whose claims were all held is left out, and a page of nothing but held claims has no claims to write", () => {
  const settled = settleKnowledgePage(/** @type {any} */ ({ slug: "x", type: "topic", title: "X", sections: [{ heading: "H", claims: [
    { text: "Invented.", kind: "direct", evidence: [{ sourceId: A, quote: "a passage that is not in the document at all" }] }] }] }), resolve);
  assert.equal(settled.counts.kept, 0);
  assert.equal(parseKnowledgePage(renderKnowledgePage(settled.page)).units.length, 0);
});

/** @returns {any} */
const input = () => ({ schemaVersion: 1, sources: [{ sourceId: A, title: "A", text: String(TEXTS.get(A)) }, { sourceId: B, title: "B", text: String(TEXTS.get(B)) }],
  pages: [{ slug: "warfarin-inr", type: "entity", title: "Warfarin" }] });

/** @returns {any} */
const patch = () => ({ schemaVersion: 1, pages: [{ op: "create", slug: "afib", type: "topic", title: "Atrial fibrillation",
  sections: [{ heading: "Findings", claims: [{ text: "Stands.", kind: "direct", evidence: [{ sourceId: A, quote: QUOTE_A }] }] }], related: ["warfarin-inr"] }] });

test("a patch the run can submit has no issue; a quotation it cannot find is advice, a patch nobody can read is required", () => {
  assert.deepEqual(knowledgePatchIssues(patch(), input()), []);

  const invented = patch();
  invented.pages[0].sections[0].claims[0].evidence[0].quote = "rivaroxaban cured every patient in the trial";
  const advice = knowledgePatchIssues(invented, input());
  assert.deepEqual(advice.map((entry) => [entry.severity, entry.check]), [["advisory", "knowledge-wiki-quote"]]);
  assert.match(advice[0].message, /pages\[0\]\.sections\[0\]\.claims\[0\]\.evidence\[0\]\.quote is not in document/);

  const strange = patch();
  strange.pages[0].slug = "Not A Slug";
  strange.pages[0].sections[0].claims[0].evidence[0].sourceId = `src_${"9".repeat(32)}`;
  strange.pages[0].sections[0].claims[0].kind = "derived";
  const required = knowledgePatchIssues(strange, input());
  assert.ok(required.length >= 1 && required.every((entry) => entry.severity === "required"));
  assert.match(required[0].message, /slug must be/);
});

test("the patch's rules: kinds need their quotations, operations need the page to exist or not, links need a page", () => {
  const messages = (/** @type {(value: any) => void} */ mutate) => { const value = patch(); mutate(value); return knowledgePatchIssues(value, input()).filter((entry) => entry.severity === "required").map((entry) => entry.message); };
  assert.ok(messages((value) => { value.pages[0].sections[0].claims[0].kind = "synthesized"; value.pages[0].sections[0].claims[0].confidence = "high"; })
    .some((message) => /at least two different documents/.test(message)));
  assert.ok(messages((value) => { value.pages[0].sections[0].claims[0].kind = "synthesized"; })
    .some((message) => /confidence must be one of/.test(message)));
  assert.ok(messages((value) => { value.pages[0].sections[0].claims[0].evidence.push({ sourceId: B, quote: QUOTE_B }); })
    .some((message) => /direct claim quotes one document/.test(message)));
  assert.ok(messages((value) => { value.pages[0].sections[0].claims[0].evidence = []; })
    .some((message) => /every statement of a page quotes its documents/.test(message)));
  assert.ok(messages((value) => { value.pages[0].op = "update"; }).some((message) => /does not exist/.test(message)));
  assert.ok(messages((value) => { value.pages[0].slug = "warfarin-inr"; }).some((message) => /already exists/.test(message)));
  assert.ok(messages((value) => { value.pages[0].related = ["nowhere"]; }).some((message) => /neither an existing page nor a page of this patch/.test(message)));
  assert.ok(messages((value) => { value.pages[0].sections[0].claims[0].text = "see <!-- evimed-source:{} -->"; }).some((message) => /comment marker/.test(message)));
  assert.ok(messages((value) => { value.pages.push({ ...value.pages[0] }); }).some((message) => /appears twice/.test(message)));
  assert.ok(messages((value) => { value.pages = []; }).length === 0, "an empty patch is advice, not a refusal");
  assert.ok(messages((value) => { value.schemaVersion = 2; }).some((message) => /schemaVersion/.test(message)));
  assert.deepEqual(knowledgePatchIssues("not an object", input()).map((entry) => entry.severity), ["required"]);
});

test("a retire operation needs only the page", () => {
  const value = { schemaVersion: 1, pages: [{ op: "retire", slug: "warfarin-inr", mergedInto: "afib", reason: "merged" }, { op: "create", slug: "afib", type: "topic", title: "T",
    sections: [{ heading: "H", claims: [{ text: "Stands.", kind: "direct", evidence: [{ sourceId: A, quote: QUOTE_A }] }] }] }] };
  assert.deepEqual(knowledgePatchIssues(value, input()), []);
});

test("the compiler's newer page never rewrites a researcher's: it is added to under one heading", () => {
  const compiled = renderKnowledgePage(page());
  const mine = renderKnowledgePage({ ...page(), sections: [page().sections[0]] }).replace("Rivaroxaban was non-inferior to warfarin.", "My own wording of the same finding.");
  const merged = mergeUserEditedKnowledgePage(mine, compiled);
  assert.equal(merged.added, 2, "both of the compiler's sentences are new to the researcher's page");
  assert.ok(merged.markdown.startsWith(mine.trimEnd()));
  assert.ok(merged.markdown.includes(`## ${KNOWLEDGE_UPDATE_HEADING}`));
  assert.ok(merged.markdown.includes("My own wording of the same finding."));
  // What the page already says is not added again, and nothing is added when nothing is new.
  const same = mergeUserEditedKnowledgePage(compiled, compiled);
  assert.deepEqual([same.added, same.markdown], [0, compiled]);
  // The added sentences are checked like any: the quotations came with them.
  assert.equal(verifyKnowledgePage(parseKnowledgePage(merged.markdown), resolve).counts.unverified, 0);
});

test("slugs and paths are a closed format", () => {
  for (const good of ["afib", "房颤", "vit-d3", "a"]) assert.equal(isKnowledgePageSlug(good), true, good);
  for (const bad of ["", "Afib", "a b", "-a", "a/b", "index", "a".repeat(64), "../x", "a.md"]) assert.equal(isKnowledgePageSlug(bad), false, bad);
  assert.equal(knowledgePagePath("afib"), "knowledge-base/wiki/afib.md");
  assert.equal(knowledgePageSlugOfPath("knowledge-base/wiki/afib.md"), "afib");
  assert.equal(knowledgePageSlugOfPath("knowledge-base/wiki/index.md"), "index");
  assert.equal(knowledgePageSlugOfPath("knowledge-base/notes/afib.md"), null);
  assert.equal(knowledgePageSlugOfPath("knowledge-base/wiki/sub/afib.md"), null);
  assert.ok(KNOWLEDGE_PAGE_LIMITS.pages > 0);
});

test("fenced code and rules are not sentences", () => {
  const markdown = ["# T", "", "```", "- not a sentence", "```", "", "---", "", `- A sentence. ${knowledgeSourceMarker(A, QUOTE_A)}`].join("\n");
  const parsed = parseKnowledgePage(markdown);
  assert.deepEqual(parsed.units.map((unit) => unit.text), ["A sentence."]);
});
