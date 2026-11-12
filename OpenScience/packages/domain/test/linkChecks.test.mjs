// The report-only broken-link checks: one case for each issue kind, and a clean library and page set
// that report nothing. The invented records are the graph's own shape with a body and front matter,
// which is what the consolidation pass now hands `methodLibraryLinkIssues`.
import assert from "node:assert/strict";
import test from "node:test";

import { knowledgeLinkIssues, methodLibraryLinkIssues } from "../index.mjs";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;

/** @param {import("../src/methodGraph.mjs").MethodRelation[]} [relations] */
const learning = (relations = []) => ({ digest: DIGEST_A, counts: {}, observations: [], relations, level: 0 });

/**
 * @param {string} name
 * @param {{id?: string, digest?: string, status?: string, dependencies?: {name: string, digest: string}[], relations?: import("../src/methodGraph.mjs").MethodRelation[], provenance?: import("../src/methodGraph.mjs").MethodProvenance & {pendingRetirements?: {methodId: string, baseDigest: string}[]}, body?: string, frontmatter?: Record<string, unknown>}} [options]
 */
const method = (name, options = {}) => ({
  id: options.id ?? `method:learned:${name}`,
  name,
  digest: options.digest ?? DIGEST_A,
  status: options.status ?? "approved",
  dependencies: options.dependencies ?? [],
  learning: learning(options.relations ?? []),
  provenance: options.provenance ?? { origin: "inferred", runId: "run_1" },
  ...(options.body ? { body: options.body } : {}),
  ...(options.frontmatter ? { frontmatter: options.frontmatter } : {}),
});

/** @param {import("../src/linkChecks.mjs").MethodLinkReport | import("../src/linkChecks.mjs").KnowledgeLinkReport} result @param {string} kind */
function assertKind(result, kind) {
  assert.ok(result.issues.some((issue) => issue.kind === kind), `expected ${kind}: ${JSON.stringify(result.issues)}`);
  assert.equal(result.counts[kind], 1, `one ${kind}`);
}

test("a clean library has no broken links", () => {
  const result = methodLibraryLinkIssues([
    method("base-step"),
    method("uses-base", {
      dependencies: [{ name: "base-step", digest: DIGEST_A }],
      body: "## Purpose\n\nUse it.\n\n[reuse method: base-step | when: always | provides: the base step]",
      frontmatter: { metadata: { role: "functional", derived_from: "run:run_1" } },
      relations: [{ type: "shared_part", target: "method:learned:base-step", evidence: "they share a step", proposedBy: "job_1" }],
      provenance: { origin: "inferred", runId: "run_1", mergedFrom: [{ methodId: "method:learned:base-step", digest: DIGEST_A }] },
    }),
  ]);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(Object.values(result.counts), new Array(Object.keys(result.counts).length).fill(0));
});

test("a dependency on a method the library does not hold is dangling", () => {
  const result = methodLibraryLinkIssues([method("uses-ghost", { dependencies: [{ name: "ghost-step", digest: DIGEST_B }] })]);
  assertKind(result, "dangling_dependency");
  assert.equal(result.issues[0].target, "ghost-step");
});

test("a pin at a revision the dependency no longer holds has moved", () => {
  const result = methodLibraryLinkIssues([
    method("base-step", { digest: DIGEST_B }),
    method("uses-base", { dependencies: [{ name: "base-step", digest: DIGEST_C }] }),
  ]);
  assertKind(result, "moved_digest");
  assert.equal(result.issues[0].target, "base-step");
});

test("an effective method reusing one that is not approved is not in effect", () => {
  const result = methodLibraryLinkIssues([
    method("base-step", { status: "candidate" }),
    method("uses-base", { dependencies: [{ name: "base-step", digest: DIGEST_A }] }),
  ]);
  assertKind(result, "dependency_not_in_effect");
  assert.equal(result.issues[0].target, "base-step");
});

test("a reuse cycle is a cycle", () => {
  const result = methodLibraryLinkIssues([
    method("one", { dependencies: [{ name: "two", digest: DIGEST_B }] }),
    method("two", { digest: DIGEST_B, dependencies: [{ name: "one", digest: DIGEST_A }] }),
  ]);
  assertKind(result, "cycle");
});

test("two methods with one name are a duplicate name", () => {
  const result = methodLibraryLinkIssues([method("same-name"), method("same-name", { id: "method:learned:same-name-2", digest: DIGEST_B })]);
  assertKind(result, "duplicate_name");
});

test("a pin that is not a sha256 digest is unparsable", () => {
  const result = methodLibraryLinkIssues([
    method("base-step"),
    method("uses-base", { dependencies: [{ name: "base-step", digest: "revision-1" }] }),
  ]);
  assertKind(result, "unparsable_digest");
  assert.equal(result.issues[0].target, "base-step");
});

test("a reuse reference the body makes but depends_on does not declare is undeclared", () => {
  const result = methodLibraryLinkIssues([
    method("base-step"),
    method("uses-base", { body: "[reuse method: base-step | when: always | provides: the base step]" }),
  ]);
  assertKind(result, "reuse_reference_undeclared");
  assert.equal(result.issues[0].target, "base-step");
});

test("a reuse reference naming a method the library does not hold is missing", () => {
  const result = methodLibraryLinkIssues([
    method("uses-ghost", {
      dependencies: [{ name: "ghost-step", digest: DIGEST_B }],
      body: "[reuse method: ghost-step | when: always | provides: the missing step]",
    }),
  ]);
  assertKind(result, "reuse_reference_missing");
  assert.equal(result.issues.find((issue) => issue.kind === "reuse_reference_missing")?.target, "ghost-step");
});

test("an abstract method derived from a method the library does not hold is missing", () => {
  const result = methodLibraryLinkIssues([
    method("abstract-one", { frontmatter: { metadata: { role: "abstract", derived_from: "method:learned:ghost-step" } } }),
  ]);
  assertKind(result, "derived_from_missing");
  assert.equal(result.issues[0].target, "method:learned:ghost-step");
});

test("derived_from on a non-abstract method is a run id and is ignored", () => {
  const result = methodLibraryLinkIssues([
    method("functional-one", { frontmatter: { metadata: { role: "functional", derived_from: "run:run_1" } } }),
  ]);
  assert.deepEqual(result.issues, []);
});

test("a relation target the library does not hold is missing", () => {
  const result = methodLibraryLinkIssues([
    method("relates", { relations: [{ type: "shared_part", target: "method:learned:ghost-step", evidence: "e", proposedBy: "job_1" }] }),
  ]);
  assertKind(result, "relation_target_missing");
  assert.equal(result.issues[0].target, "method:learned:ghost-step");
});

test("a merge source the library does not hold is missing", () => {
  const result = methodLibraryLinkIssues([
    method("merged", { provenance: { origin: "inferred", mergedFrom: [{ methodId: "method:learned:ghost-step", digest: DIGEST_B }] } }),
  ]);
  assertKind(result, "merged_from_missing");
  assert.equal(result.issues[0].target, "method:learned:ghost-step");
});

test("a merge source that is retired but still held is not a missing link", () => {
  const result = methodLibraryLinkIssues([
    method("source", { status: "retired", digest: DIGEST_B }),
    method("merged", { provenance: { origin: "inferred", mergedFrom: [{ methodId: "method:learned:source", digest: DIGEST_B }] } }),
  ]);
  assert.deepEqual(result.issues, []);
});

test("a pending retirement naming a method the library does not hold is missing", () => {
  const result = methodLibraryLinkIssues([
    method("merged", { provenance: { origin: "inferred", pendingRetirements: [{ methodId: "method:learned:ghost-step", baseDigest: DIGEST_B }] } }),
  ]);
  assertKind(result, "pending_retirement_missing");
  assert.equal(result.issues[0].target, "method:learned:ghost-step");
});

test("a record that cannot be read is unreadable, not an exception", () => {
  const result = methodLibraryLinkIssues([null, { name: 7 }, method("fine")]);
  assert.equal(result.counts.unreadable, 2);
  assert.equal(result.issues.length, 2);
  assert.ok(result.issues.every((issue) => issue.kind === "unreadable"));
});

test("a clean page set has no broken links", () => {
  const result = knowledgeLinkIssues({
    pages: [
      { path: "index.md", content: "# Index\n\n[Alpha](entity/alpha.md)\n", dependsOn: ["src_1"] },
      { path: "entity/alpha.md", content: "---\ntype: entity\ntitle: Alpha\nsources: [viking://resources/src_1.md]\n---\n\n# Alpha\n", dependsOn: ["src_1"] },
    ],
    sources: ["src_1"],
    graph: [
      { path: "entities/alpha.md", content: "---\ntype: entity\nid: alpha\ntitle: Alpha\nentity_type: concept\nsources: [viking://resources/src_1.md]\n---\n" },
      { path: "relations.jsonl", content: "" },
    ],
  });
  assert.deepEqual(result.issues, []);
  assert.deepEqual(Object.values(result.counts), new Array(Object.keys(result.counts).length).fill(0));
});

test("a page link that leads nowhere is unresolved", () => {
  const result = knowledgeLinkIssues({ pages: [{ path: "index.md", content: "# Index\n\n[Missing](missing.md)\n" }], sources: [] });
  assertKind(result, "page_link_unresolved");
  assert.equal(result.issues[0].page, "index.md");
  assert.equal(result.issues[0].target, "missing.md");
});

test("a compiled graph problem becomes graph_problem:<name>", () => {
  const result = knowledgeLinkIssues({
    pages: [],
    sources: ["src_1"],
    graph: [
      { path: "entities/alpha.md", content: "---\ntype: entity\nid: alpha\ntitle: Alpha\nsources: [viking://resources/src_1.md]\n---\n" },
      { path: "relations.jsonl", content: '{"from":"alpha","relation":"related_to","label":"related","to":"ghost","evidence":["viking://resources/src_1.md"]}\n' },
    ],
  });
  assertKind(result, "graph_problem:relation_endpoint_unknown");
  assert.equal(result.issues[0].target, "ghost");
});

test("a page's dependsOn source the knowledge base does not hold is missing", () => {
  const result = knowledgeLinkIssues({
    pages: [{ path: "index.md", content: "# Index\n", dependsOn: ["src_1", "src_missing"] }],
    sources: ["src_1"],
  });
  assertKind(result, "depends_on_source_missing");
  assert.equal(result.issues[0].page, "index.md");
  assert.equal(result.issues[0].target, "src_missing");
});

test("a page that cannot be read is unreadable, not an exception", () => {
  const result = knowledgeLinkIssues({ pages: [null, { path: "index.md" }], sources: [] });
  assert.equal(result.counts.unreadable, 2);
  assert.ok(result.issues.every((issue) => issue.kind === "unreadable"));
});
