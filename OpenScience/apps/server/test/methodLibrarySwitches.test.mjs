// The learned-method library's experiment switches (plan 2026-11-04 §5.4, defects 9, 12 and 14, and the method card's evidence):
// one fast test per switch. Each switch is off by default, and off is the mount as it was, byte for byte, so the same commit runs
// an experiment with the feature on and off.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.mjs";
import { SELECTION_FILE, capsuleMethodsDirName, materializeCapsuleMethods } from "../src/capsuleMethods.mjs";
import { methodRecordFrom } from "../src/learningService.mjs";
import { createMethodSimilarity } from "../src/methodSimilarity.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** @param {Record<string, string>} env */
function configUnder(env) {
  const saved = process.env;
  process.env = { ...env };
  try {
    return loadConfig({ rootDir: repoRoot });
  } finally {
    process.env = saved;
  }
}

async function scratchProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), "os-method-switches-"));
  const project = { id: "paper1", userId: "alice", rootDir: root, runtimeDir: path.join(root, "runtime") };
  await mkdir(project.runtimeDir, { recursive: true });
  return { project, directory: path.join(project.runtimeDir, capsuleMethodsDirName) };
}

/** @param {string} name @param {string} words @param {Record<string, string>} [metadata] @param {any} [extra] */
function learnedDoc(name, words, metadata = {}, extra = {}) {
  return {
    id: `method:learned:${name}`,
    payload: {
      status: "approved", statusChangedAt: "2026-09-01T00:00:00.000Z",
      frontmatter: { name, description: words, whenToUse: words, metadata: { role: "functional", ...metadata } },
      body: "## Purpose\nDo it.\n\n## Workflow\n1. Do it.",
      ...extra,
    },
  };
}

/* --------------------------------------------------------------------------------- A: OPEN_SCIENCE_METHOD_PYRAMID_ENABLED */

test("快测 A: the pyramid switch and the similarity floor are off by default and read from the environment", () => {
  const plain = loadConfig({ rootDir: repoRoot });
  assert.equal(plain.methodPyramidEnabled, false);
  assert.equal(plain.methodMountMinSimilarity, 0);
  const on = configUnder({ OPEN_SCIENCE_METHOD_PYRAMID_ENABLED: "true", OPEN_SCIENCE_METHOD_MOUNT_MIN_SIMILARITY: "0.35" });
  assert.equal(on.methodPyramidEnabled, true);
  assert.equal(on.methodMountMinSimilarity, 0.35);
  assert.equal(configUnder({ OPEN_SCIENCE_METHOD_MOUNT_MIN_SIMILARITY: "" }).methodMountMinSimilarity, 0, "an empty value is unset");
  for (const value of ["-0.1", "1", "abc"]) {
    assert.throws(() => configUnder({ OPEN_SCIENCE_METHOD_MOUNT_MIN_SIMILARITY: value }), /OPEN_SCIENCE_METHOD_MOUNT_MIN_SIMILARITY/);
  }

  // The record the levels are read from: no `derivedFrom` unless the library's names are given, and then only an abstract method's.
  const pattern = learnedDoc("evidence-pattern", "A frame.", { role: "abstract", derived_from: "span-step, run:run_1, ghost" });
  assert.equal("derivedFrom" in methodRecordFrom(pattern), false, "off: the record is what it always was");
  assert.deepEqual(methodRecordFrom(pattern, { libraryNames: new Set(["span-step", "evidence-pattern"]) }).derivedFrom, ["span-step"]);
});

test("快测 A: with the pyramid on, the mount writes the abstract parent first with its reason; off, the selection file is unchanged", async () => {
  const { project, directory } = await scratchProject();
  try {
    const documents = [
      learnedDoc("span-step", "Check GRADE certainty of evidence spans before effect sizes in the evidence summary table"),
      learnedDoc("evidence-pattern", "Zebra quartz framing for any multi step deliverable", { role: "abstract", derived_from: "span-step" },
        { learning: { counts: { carried: 9 } } }),
      learnedDoc("kayak-notes", "Kayak river rafting notes for the weekend"),
    ];
    const learning = { async approvedMethods() { return documents; } };
    const options = { capsules: null, learning, project, directory, keepDirectory: true, scopeId: "conversation",
      similarity: createMethodSimilarity(), query: "GRADE certainty of evidence spans and effect sizes in the summary table" };
    const read = async () => JSON.parse(await readFile(path.join(directory, SELECTION_FILE), "utf8"));

    const before = await materializeCapsuleMethods(options);
    const plain = await read();
    const off = await materializeCapsuleMethods({ ...options, methodSelection: { pyramid: false, minSimilarity: 0 } });
    assert.deepEqual(await read(), plain, "the switches off write the same selection");
    assert.equal(off.version, before.version);
    assert.deepEqual(off.learned, before.learned);
    assert.deepEqual(before.learned.map((method) => [method.name, method.reason]), [["span-step", "similarity"], ["kayak-notes", "explore"]]);

    const on = await materializeCapsuleMethods({ ...options, methodSelection: { pyramid: true } });
    assert.deepEqual(on.learned.map((method) => [method.name, method.reason]),
      [["evidence-pattern", "abstraction"], ["span-step", "similarity"], ["kayak-notes", "explore"]]);
    assert.deepEqual((await read()).methods.map((/** @type {any} */ entry) => entry.reason), ["abstraction", "similarity", "explore"]);
    assert.notEqual(on.version, before.version, "a different mount is a different version");
  } finally {
    await rm(project.rootDir, { recursive: true, force: true });
  }
});

/* ----------------------------------------------------------------------- B: OPEN_SCIENCE_METHOD_OFFICIAL_IN_LOOP_ENABLED */

import { METHOD_SKILL_SCHEMA } from "@evimed/domain";
import { LearningService } from "../src/learningService.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";

const OFFICIAL = { key: "official:daily:base", packId: "daily", methodId: "base", name: "official-daily-base", description: "Base step for reports.",
  whenToUse: "When a report needs its base step.", scope: ["meta-analysis"], body: "Do the base step.", sha: "c".repeat(64), entryId: "fact-1", capsuleId: "official-copy:daily" };
const OFFICIAL_PIN = `sha256:${"c".repeat(64)}`;

test("快测 B: off by default; on, a person's method may pin an official one and the mount brings the official card with it", async () => {
  assert.equal(loadConfig({ rootDir: repoRoot }).methodOfficialInLoopEnabled, false);
  assert.equal(configUnder({ OPEN_SCIENCE_METHOD_OFFICIAL_IN_LOOP_ENABLED: "true" }).methodOfficialInLoopEnabled, true);

  // The pin resolves only when the switch gave the learning service the account's official methods.
  const sections = ["## Purpose", "P.", "", "## When to Use", "W.", "", "## Inputs", "I.", "", "## Workflow", "1. [reuse method: official-daily-base | when: always | provides: the base step]", "",
    "## Verification", "- Checked.", "", "## Constraints", "- Never.", "", "## Output", "O."].join("\n");
  const candidate = {
    projectId: "p1", body: sections, provenance: { origin: "inferred", runId: "run_1" }, dependencies: [{ name: OFFICIAL.name, digest: OFFICIAL_PIN }],
    frontmatter: { name: "report-on-base", description: "Writes the report on the official base step.", whenToUse: "When a report is asked for.",
      metadata: { role: "functional", applies_when: "A report.", not_when: "No report.", derived_from: "run:run_1", depends_on: `${OFFICIAL.name}@${OFFICIAL_PIN}`, evimed_schema: METHOD_SKILL_SCHEMA } },
  };
  const off = new LearningService({ documents: productDocumentsDouble() });
  await assert.rejects(off.createCandidate("u1", candidate), /method_depends_on_unresolved/);
  const on = new LearningService({ documents: productDocumentsDouble() });
  on.officialMethods = async () => [OFFICIAL];
  const created = await on.createCandidate("u1", candidate);
  assert.deepEqual(created.payload.dependencies, [{ name: OFFICIAL.name, digest: OFFICIAL_PIN }]);
  const stale = new LearningService({ documents: productDocumentsDouble() });
  stale.officialMethods = async () => [{ ...OFFICIAL, sha: "d".repeat(64) }];
  await assert.rejects(stale.createCandidate("u1", candidate), /method_depends_on_unresolved/, "a pin to another text of it does not resolve");

  const { project, directory } = await scratchProject();
  try {
    const learned = learnedDoc("report-on-base", "Writes the weekly report on the base step", {}, { dependencies: [{ name: OFFICIAL.name, digest: OFFICIAL_PIN }] });
    const capsules = { async active() { return { record: null, items: [] }; }, async entries() { return { items: [], nextCursor: null }; },
      async officialMethods() { return [OFFICIAL]; }, official: { noteMount() {} } };
    const options = { capsules, learning: { async approvedMethods() { return [learned]; } }, project, directory, keepDirectory: true, scopeId: "conversation",
      learnedFamily: /** @type {const} */ ("research"), similarity: createMethodSimilarity(), query: "Write the weekly report on the base step" };
    const flat = await materializeCapsuleMethods(options);
    assert.deepEqual(flat.official, [], "off: an official method of another scope is never offered, and a dependency is not read");
    const inLoop = await materializeCapsuleMethods({ ...options, methodSelection: { officialInLoop: true } });
    assert.deepEqual(inLoop.official.map((/** @type {any} */ entry) => entry.id), [OFFICIAL.key]);
    const selection = JSON.parse(await readFile(path.join(directory, SELECTION_FILE), "utf8"));
    assert.deepEqual(selection.methods.map((/** @type {any} */ entry) => entry.reason), ["similarity", "dependency"]);
  } finally {
    await rm(project.rootDir, { recursive: true, force: true });
  }
});
