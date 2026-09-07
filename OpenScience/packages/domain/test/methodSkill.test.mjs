// What a learned method is allowed to be.
//
// The point of this file is the walk at the bottom: every code in
// METHOD_SKILL_ISSUE_CODES must be raised by some case here. A closed list of
// codes whose members are never constructed is not a specification, it is a
// list — and the run side repairs against these codes, so a code that has never
// fired is an instruction nobody has proven the validator can give.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  METHOD_SKILL_ISSUE_CODES,
  METHOD_SKILL_SCHEMA,
  isMethodDigest,
  formatDependsOn,
  methodBodySections,
  methodContentDigest,
  methodDigestInput,
  parseDependsOn,
  parsePythonToolShape,
  parseReuseReferences,
  parseSkillFrontmatter,
  preservedSectionItems,
  preservedSectionsIntact,
  renderMethodSkill,
  renderSkillFrontmatter,
  scriptStaticIssues,
  skillBodyDigest,
  toolConfigIssues,
  validateMethodSkill,
} from "../src/methodSkill.mjs";

/** @param {string} text @returns {string} */
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
/** @param {string} text @returns {string} */
const digestOf = (text) => `sha256:${sha256(text)}`;

const GOOD_BODY = [
  "## Purpose",
  "Repair a source-grounded report in place after the evidence gate returns addressable issues.",
  "",
  "## When to Use",
  "A delivered report failed the gate and every issue names a claim and a source.",
  "",
  "## Inputs",
  "The failing report, the accepted source ledger, and the gate verdict.",
  "",
  "## Workflow",
  "1. Read the verdict and group issues by claim.",
  "2. For each claim, re-open the source span it is bonded to.",
  "3. Edit only the sentences the verdict names.",
  "",
  "## Verification",
  "- Every edited claim still quotes its source verbatim.",
  "- No number changed without sweeping its dependent claims.",
  "",
  "## Constraints",
  "- Never widen a claim's tier to close an issue.",
  "- Never remove a citation to silence a check.",
  "",
  "## Output",
  "The repaired report, resubmitted through evimed_submit_deliverable.",
].join("\n");

/** @returns {Record<string, string>} */
const goodMetadata = () => ({
  role: "functional",
  applies_when: "A previously generated report and an accepted source ledger exist.",
  not_when: "The cited source is unavailable or does not support the requested correction.",
  derived_from: "run:run_1, feedback:evt_1",
  evimed_schema: METHOD_SKILL_SCHEMA,
});

/** @param {Record<string, unknown>} [overrides] @returns {Record<string, unknown>} */
const goodFrontmatter = (overrides = {}) => ({
  name: "evidence-preserving-report-repair",
  description: "Repairs a source-grounded report in place when the evidence gate returns addressable issues, editing only the sentences the verdict names.",
  whenToUse: "When a delivered report failed the evidence gate with addressable issues.",
  "allowed-tools": "read edit evimed_submit_deliverable",
  license: "internal",
  metadata: goodMetadata(),
  ...overrides,
});

/** @param {Partial<import("../src/methodSkill.mjs").MethodSkillInput>} [overrides] */
const validate = (overrides = {}) => validateMethodSkill({
  frontmatter: goodFrontmatter(),
  body: GOOD_BODY,
  directoryName: "evidence-preserving-report-repair",
  requireProvenance: true,
  ...overrides,
});

/** @type {Set<string>} */
const raised = new Set();
/** @param {{issues: {code: string}[]}} result @returns {{issues: {code: string}[]}} */
const collect = (result) => { for (const entry of result.issues) raised.add(entry.code); return result; };
/** @param {{issues: {code: string}[]}} result @param {string} code @returns {boolean} */
const has = (result, code) => collect(result).issues.some((entry) => entry.code === code);

/* ------------------------------------------------------------- the good case */

test("a well-formed method raises nothing", () => {
  const result = validate();
  assert.deepEqual(result.issues, [], result.issues.map((entry) => `${entry.code}: ${entry.message}`).join("\n"));
  assert.equal(result.ok, true);
});

/* -------------------------------------------------------------- frontmatter */

test("the frontmatter subset parser reads what we write and refuses what it cannot read", () => {
  const parsed = parseSkillFrontmatter([
    "---",
    "name: a-method",
    "description: >-",
    "  folded across",
    "  two lines",
    "notes: |",
    "  literal",
    "  lines",
    "user-invocable: true",
    "metadata:",
    "  role: atomic",
    "  applies_when: \"quoted: with a colon\"",
    "---",
    "",
    "body text",
  ].join("\n"));
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.frontmatter.name, "a-method");
  assert.equal(parsed.frontmatter.description, "folded across two lines");
  assert.equal(parsed.frontmatter.notes, "literal\nlines");
  assert.equal(parsed.frontmatter["user-invocable"], true);
  assert.deepEqual(parsed.frontmatter.metadata, { role: "atomic", applies_when: "quoted: with a colon" });
  assert.equal(parsed.body, "body text");

  assert.ok(has(parseSkillFrontmatter("no frontmatter here"), "method_frontmatter_missing"));
  assert.ok(has(parseSkillFrontmatter("---\nname: x\nstill going"), "method_frontmatter_unterminated"));
  assert.ok(has(parseSkillFrontmatter("---\n- a sequence item\n---\n"), "method_frontmatter_unsupported"));
  assert.ok(has(parseSkillFrontmatter("---\nname:\ta-tab\n---\n"), "method_frontmatter_unsupported"));
  assert.ok(has(parseSkillFrontmatter("---\ndescription: value # comment\n---\n"), "method_frontmatter_unsupported"));
  assert.ok(has(parseSkillFrontmatter("---\nmetadata:\n  outer:\n    inner: x\n---\n"), "method_frontmatter_unsupported"));
});

test("bare words two YAML versions disagree about are refused rather than guessed at", () => {
  // `no` is a string in YAML 1.2 and the boolean false in YAML 1.1. Whichever
  // parser reads the mounted file is not ours to choose, so the ambiguity is
  // the defect.
  for (const word of ["yes", "no", "on", "off", "True", "null", "~"]) {
    assert.ok(has(parseSkillFrontmatter(`---\nuser-invocable: ${word}\n---\n`), "method_frontmatter_ambiguous_scalar"), word);
  }
  assert.deepEqual(parseSkillFrontmatter("---\nuser-invocable: true\n---\n").issues, []);
  assert.deepEqual(parseSkillFrontmatter("---\nnote: \"no\"\n---\n").issues, []);
});

test("rendering is canonical, so a round trip does not move the digest", () => {
  const frontmatter = goodFrontmatter();
  const rendered = renderMethodSkill(frontmatter, GOOD_BODY);
  const reparsed = parseSkillFrontmatter(rendered);
  assert.deepEqual(reparsed.issues, []);
  assert.deepEqual(reparsed.frontmatter, frontmatter);
  assert.equal(
    methodContentDigest({ frontmatter, body: GOOD_BODY }, sha256),
    methodContentDigest({ frontmatter: reparsed.frontmatter, body: reparsed.body }, sha256),
  );
  assert.ok(renderSkillFrontmatter({ a: true, b: "x" }).includes("a: true"));
});

/* ------------------------------------------------------------------ digests */

test("the digest is over canonical content, so key order and line endings do not move it", () => {
  const one = { frontmatter: { b: "2", a: "1", metadata: { z: "9", y: "8" } }, body: "line\r\nline2  " };
  const two = { frontmatter: { a: "1", metadata: { y: "8", z: "9" }, b: "2" }, body: "line\nline2" };
  assert.equal(methodDigestInput(one), methodDigestInput(two));
  assert.equal(methodContentDigest(one, sha256), methodContentDigest(two, sha256));
  assert.ok(isMethodDigest(methodContentDigest(one, sha256)));
  assert.equal(isMethodDigest("sha256:short"), false);

  // Attached files participate, sorted by path, or a script could change under
  // an unchanged digest and keep counters it did not earn.
  const withFiles = { ...one, files: { "scripts/b.py": "x", "scripts/a.py": "y" } };
  const sameFiles = { ...two, files: { "scripts/a.py": "y", "scripts/b.py": "x" } };
  assert.equal(methodContentDigest(withFiles, sha256), methodContentDigest(sameFiles, sha256));
  assert.notEqual(methodContentDigest(withFiles, sha256), methodContentDigest(one, sha256));
});

test("a skill body digest is the same string wherever it is computed", () => {
  assert.equal(skillBodyDigest("a body\n", sha256), skillBodyDigest("a body\r\n\n", sha256));
  assert.ok(isMethodDigest(skillBodyDigest("a body", sha256)));
});

/* ------------------------------------------------------------- dependencies */

test("depends_on pins a name to a digest, and anything else is malformed", () => {
  const parsed = parseDependsOn(`a-method@${digestOf("a")}, b-method@${digestOf("b")}`);
  assert.equal(parsed.dependencies.length, 2);
  assert.deepEqual(parsed.malformed, []);
  assert.equal(formatDependsOn(parsed.dependencies), `a-method@${digestOf("a")}, b-method@${digestOf("b")}`);
  assert.deepEqual(parseDependsOn("bare-name").malformed, ["bare-name"]);
  assert.deepEqual(parseDependsOn("x@sha256:nothex").malformed, ["x@sha256:nothex"]);
  assert.deepEqual(parseDependsOn(undefined).dependencies, []);
});

test("a reuse reference in the prose must be pinned in depends_on", () => {
  const digest = digestOf("resolve");
  const body = `${GOOD_BODY}\n\n[reuse method: resolve-claim-to-source-span | when: a claim lacks a span | provides: the span]`;
  assert.ok(has(validate({ body }), "method_depends_on_shape"));

  const pinned = validate({
    body,
    frontmatter: goodFrontmatter({
      metadata: { ...goodMetadata(), depends_on: `resolve-claim-to-source-span@${digest}` },
    }),
    resolveDigest: (dependency) => dependency.digest === digest,
  });
  assert.deepEqual(pinned.issues, []);

  const { references, malformed } = parseReuseReferences("[reuse method: a | when: b | provides: c] and [reuse method: broken]");
  assert.deepEqual(references, [{ name: "a", when: "b", provides: "c" }]);
  assert.deepEqual(malformed, ["[reuse method: broken]"]);
});

/* ---------------------------------------------------------------- body rules */

test("the section template, the length budget, and the reference depth are all decidable", () => {
  assert.deepEqual(methodBodySections(GOOD_BODY), ["Purpose", "When to Use", "Inputs", "Workflow", "Verification", "Constraints", "Output"]);
  assert.ok(has(validate({ body: GOOD_BODY.replace("## Verification", "## Checks") }), "method_body_section_missing"));
  assert.ok(has(validate({ body: "" }), "method_body_empty"));
  assert.ok(has(validate({ body: `${GOOD_BODY}\n${"filler\n".repeat(600)}` }), "method_body_too_long"));
  assert.ok(has(validate({ body: `${GOOD_BODY}\n\nSee [that](references/deep/deeper.md).` }), "method_reference_too_deep"));
  assert.deepEqual(validate({ body: `${GOOD_BODY}\n\nSee [that](references/near.md).` }).issues, []);
  assert.ok(has(validate({ body: `${GOOD_BODY}\n\n[reuse method: half-written]` }), "method_reuse_reference_shape"));
});

test("a method may not name an absent tool, an absolute skill root, or a credential", () => {
  assert.ok(has(validate({ body: `${GOOD_BODY}\n\nCall writing_audit() first.` }), "method_unmounted_tool_reference"));
  assert.ok(has(validate({ body: `${GOOD_BODY}\n\nRead /opt/evimed/skills/core/x.` }), "method_skill_root_leak"));
  assert.ok(has(validate({ body: `${GOOD_BODY}\n\nUse api_key sk-live-1.` }), "method_sensitive_content"));
  // The mounted set is what decides, and a caller may narrow it.
  assert.ok(has(validate({ mountedTools: ["read"] }), "method_allowed_tools_unknown"));
});

/* --------------------------------------------------------------- frontmatter rules */

test("every frontmatter rule fires on its own violation", () => {
  /** @param {string} key @returns {Record<string, unknown>} */
  const without = (key) => {
    /** @type {Record<string, unknown>} */
    const copy = { ...goodFrontmatter() };
    delete copy[key];
    return copy;
  };
  assert.ok(has(validate({ frontmatter: without("name") }), "method_name_missing"));
  assert.ok(has(validate({ frontmatter: goodFrontmatter({ name: "Not--Kebab" }), directoryName: "Not--Kebab" }), "method_name_shape"));
  assert.ok(has(validate({ frontmatter: goodFrontmatter({ name: "a".repeat(65) }), directoryName: "a".repeat(65) }), "method_name_shape"));
  assert.ok(has(validate({ directoryName: "some-other-directory" }), "method_name_directory_mismatch"));
  assert.ok(has(validate({ frontmatter: without("description") }), "method_description_missing"));
  assert.ok(has(validate({ frontmatter: goodFrontmatter({ description: "x".repeat(1025) }) }), "method_description_too_long"));
  assert.ok(has(validate({ frontmatter: without("whenToUse") }), "method_when_to_use_missing"));
  assert.ok(has(validate({ frontmatter: goodFrontmatter({ "user-invocable": "true" }) }), "method_invocation_flag_type"));
  assert.ok(has(validate({ frontmatter: goodFrontmatter({ userInvocable: true }) }), "method_legacy_camel_key"));
  assert.ok(has(validate({ frontmatter: goodFrontmatter({ "allowed-tools": "read teleport" }) }), "method_allowed_tools_unknown"));
  assert.ok(has(validate({ frontmatter: without("metadata") }), "method_metadata_shape"));
  assert.ok(has(validate({ frontmatter: goodFrontmatter({ metadata: { ...goodMetadata(), count: 3 } }) }), "method_metadata_shape"));
  assert.ok(has(validate({ frontmatter: goodFrontmatter({ metadata: { ...goodMetadata(), evimed_schema: "method-skill/9" } }) }), "method_metadata_schema_unknown"));
  assert.ok(has(validate({ frontmatter: goodFrontmatter({ metadata: { ...goodMetadata(), role: "supreme" } }) }), "method_role_unknown"));
  assert.ok(has(validate({ frontmatter: goodFrontmatter({ metadata: { ...goodMetadata(), applies_when: "" } }) }), "method_applies_when_missing"));
  assert.ok(has(validate({ frontmatter: goodFrontmatter({ metadata: { ...goodMetadata(), not_when: "" } }) }), "method_not_when_missing"));
  assert.ok(has(validate({ frontmatter: goodFrontmatter({ metadata: { ...goodMetadata(), derived_from: "" } }) }), "method_derived_from_missing"));
  assert.ok(has(validate({ frontmatter: goodFrontmatter({ metadata: { ...goodMetadata(), depends_on: "bare" } }) }), "method_depends_on_shape"));
  assert.ok(has(validate({
    frontmatter: goodFrontmatter({ metadata: { ...goodMetadata(), depends_on: `evidence-preserving-report-repair@${digestOf("self")}` } }),
  }), "method_depends_on_self"));
  assert.ok(has(validate({
    frontmatter: goodFrontmatter({ metadata: { ...goodMetadata(), depends_on: `other@${digestOf("other")}` } }),
    resolveDigest: () => false,
  }), "method_depends_on_unresolved"));
  // Provenance is only demanded of what the loop learned; a hand-written method
  // imported by a person is not required to name a run.
  assert.equal(validate({ frontmatter: goodFrontmatter({ metadata: { ...goodMetadata(), derived_from: "" } }), requireProvenance: false })
    .issues.some((entry) => entry.code === "method_derived_from_missing"), false);
});

/* ----------------------------------------------------------------- code skills */

const SCRIPT = [
  "def normalize_identifier(value, scheme='doi'):",
  "    return f'{scheme}:{value.strip().lower()}'",
  "",
  "if __name__ == '__main__':",
  "    assert normalize_identifier(' 10.1/AB ') == 'doi:10.1/ab'",
  "",
].join("\n");
const TOOL_CONFIG = JSON.stringify({
  name: "normalize_identifier",
  description: "Normalise a bibliographic identifier.",
  parameters: {
    type: "object",
    properties: {
      value: { type: "string", description: "the raw identifier" },
      scheme: { type: "string", description: "the identifier scheme" },
    },
    required: ["value"],
  },
});

test("a code skill's schema is checked against the function it claims to describe", () => {
  const shape = parsePythonToolShape(SCRIPT);
  assert.equal(shape.name, "normalize_identifier");
  assert.equal(shape.hasMain, true);
  assert.deepEqual(shape.parameters, [{ name: "value", required: true }, { name: "scheme", required: false }]);
  assert.deepEqual(toolConfigIssues(SCRIPT, JSON.parse(TOOL_CONFIG), "scripts/normalize_identifier.tool.json"), []);

  const renamed = JSON.parse(TOOL_CONFIG); renamed.name = "something_else";
  assert.ok(toolConfigIssues(SCRIPT, renamed, "p").some((entry) => entry.code === "method_tool_config_mismatch"));
  const invented = JSON.parse(TOOL_CONFIG); invented.parameters.properties.extra = { type: "string", description: "d" };
  assert.ok(toolConfigIssues(SCRIPT, invented, "p").some((entry) => entry.code === "method_tool_config_mismatch"));
  const wrongRequired = JSON.parse(TOOL_CONFIG); wrongRequired.parameters.required = ["value", "scheme"];
  assert.ok(toolConfigIssues(SCRIPT, wrongRequired, "p").some((entry) => entry.code === "method_tool_config_mismatch"));
  const untyped = JSON.parse(TOOL_CONFIG); delete untyped.parameters.properties.value.type;
  assert.ok(toolConfigIssues(SCRIPT, untyped, "p").some((entry) => entry.code === "method_tool_config_invalid"));
  assert.ok(toolConfigIssues("value = 1\n", JSON.parse(TOOL_CONFIG), "p").some((entry) => entry.code === "method_script_shape"));
  assert.ok(toolConfigIssues(SCRIPT.replace(/if __name__[\s\S]*/, ""), JSON.parse(TOOL_CONFIG), "p")
    .some((entry) => entry.code === "method_script_shape"));
});

test("a code skill may not reach the network or name an absolute path", () => {
  assert.ok(scriptStaticIssues("import requests\n", "scripts/x.py").some((entry) => entry.code === "method_script_import_denied"));
  assert.ok(scriptStaticIssues("from urllib.request import urlopen\n", "scripts/x.py").some((entry) => entry.code === "method_script_import_denied"));
  assert.ok(scriptStaticIssues("p = '/etc/passwd'\n", "scripts/x.py").some((entry) => entry.code === "method_script_absolute_path"));
  assert.deepEqual(scriptStaticIssues("import json\np = 'work/out.json'\n", "scripts/x.py"), []);
});

test("attached files must be complete, safe, and within budget", () => {
  /** @type {Record<string, string>} */
  const files = {
    "scripts/normalize_identifier.py": SCRIPT,
    "scripts/normalize_identifier.tool.json": TOOL_CONFIG,
    "tests/test_normalize_identifier.py": "from scripts.normalize_identifier import normalize_identifier\n",
  };
  assert.deepEqual(validate({ files }).issues, []);
  assert.ok(has(validate({ files: { "references/x.md": "hi" } }), "method_files_prefix"));
  assert.ok(has(validate({ files: { "scripts/../escape.py": "x" } }), "method_files_path"));
  assert.ok(has(validate({ files: { ...files, "scripts/big.py": "x".repeat(70000) } }), "method_files_too_large"));
  /** @type {Record<string, string>} */
  const noTest = { ...files }; delete noTest["tests/test_normalize_identifier.py"];
  assert.ok(has(validate({ files: noTest }), "method_files_incomplete"));
  /** @type {Record<string, string>} */
  const noConfig = { ...files }; delete noConfig["scripts/normalize_identifier.tool.json"];
  assert.ok(has(validate({ files: noConfig }), "method_files_incomplete"));
  const orphanConfig = { "scripts/orphan.tool.json": TOOL_CONFIG };
  assert.ok(has(validate({ files: orphanConfig }), "method_files_incomplete"));
  assert.ok(has(validate({ files: { ...files, "scripts/normalize_identifier.tool.json": "{ not json" } }), "method_tool_config_invalid"));
  assert.ok(has(validate({ files: { ...files, "scripts/net.py": "import socket\n" } }), "method_script_import_denied"));
  assert.ok(has(validate({ files: { ...files, "scripts/abs.py": "p = '/var/lib/x'\n" } }), "method_script_absolute_path"));
  assert.ok(has(validate({ files: { ...files, "tests/test_secret.py": "api_key = 'sk-1'\n" } }), "method_sensitive_content"));
  assert.ok(has(validate({ files: { "scripts/lonely.py": "value = 1\n", "scripts/lonely.tool.json": TOOL_CONFIG, "tests/test_lonely.py": "" } }), "method_script_shape"));
  assert.ok(has(validate({ files: { "scripts/x.py": SCRIPT, "scripts/x.tool.json": TOOL_CONFIG, "tests/test_x.py": "" } }), "method_tool_config_mismatch"));
});

/* -------------------------------------------------- the builder's hard rule */

test("a rewrite may add verification and constraint items but may not drop one", () => {
  assert.deepEqual(preservedSectionItems(GOOD_BODY), [
    "Every edited claim still quotes its source verbatim.",
    "No number changed without sweeping its dependent claims.",
    "Never widen a claim's tier to close an issue.",
    "Never remove a citation to silence a check.",
  ]);
  const grown = GOOD_BODY.replace("## Output", "- One more check.\n\n## Output");
  assert.deepEqual(preservedSectionsIntact(GOOD_BODY, grown), { ok: true, dropped: [] });
  const shrunk = GOOD_BODY.replace("- Never remove a citation to silence a check.\n", "");
  const verdict = preservedSectionsIntact(GOOD_BODY, shrunk);
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.dropped, ["Never remove a citation to silence a check."]);
});

/* ---------------------------------------------------------------- the walk */

test("every declared issue code is raised by some case in this file", () => {
  // Proof that the walk walked: if this set were empty the assertion below
  // would pass vacuously for an empty code list, so the count is checked too.
  assert.ok(raised.size > 20, `only ${raised.size} codes were exercised; the cases above did not run`);
  const never = METHOD_SKILL_ISSUE_CODES.filter((code) => !raised.has(code));
  assert.deepEqual(never, [], `declared but never raised: ${never.join(", ")}`);
  const unknown = [...raised].filter((code) => !METHOD_SKILL_ISSUE_CODES.includes(code));
  assert.deepEqual(unknown, [], `raised but undeclared: ${unknown.join(", ")}`);
});
