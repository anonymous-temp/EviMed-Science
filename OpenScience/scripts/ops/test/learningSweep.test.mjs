import assert from "node:assert/strict";
import test from "node:test";

import { METHOD_SKILL_SCHEMA, retiredFeaturesOfMethod } from "@evimed/domain";

import { LearningService } from "../../../apps/server/src/learningService.mjs";
import { productDocumentsDouble } from "../../../apps/server/test/helpers/productDocumentsDouble.mjs";
import { STALE_REASON, findStale, parseArguments, sweepAccount } from "../learning-sweep.mjs";

const SECTIONS = ["## Purpose", "Do a thing.", "", "## When to Use", "When needed.", "", "## Inputs", "A frozen input.", "", "## Workflow", "1. Do it.", "",
  "## Verification", "- It was done.", "", "## Constraints", "- Never do the other thing.", "", "## Output", "The thing."];
const frontmatter = (name) => ({ name, description: `Does ${name} when ${name} is needed.`, whenToUse: `When ${name} is needed.`,
  metadata: { role: "functional", applies_when: "Needed.", not_when: "Not needed.", derived_from: "run:run_0", evimed_schema: METHOD_SKILL_SCHEMA } });
const digest = (letter) => `sha256:${letter.repeat(64)}`;

/** The account of the live audit: learnt before the rulings, so written past the check that would refuse them today. */
async function account() {
  const documents = productDocumentsDouble();
  const learning = new LearningService({ documents, now: () => new Date("2026-10-23T00:00:00.000Z") });
  const method = (name, body = SECTIONS.join("\n")) => learning.createCandidate("u1", { projectId: "p1", frontmatter: frontmatter(name), body, provenance: { origin: "inferred", runId: "run_0" } });
  const taught = await method("quote-first");
  // A method that names a retired file: written the way a record of 2026-09 was, with no check in front of it.
  const stale = await method("write-the-search-log");
  await documents.put("u1", "method", stale.id, { ...stale.payload, body: [...SECTIONS, "", "Write clinical-evidence-search.json before submitting."].join("\n") }, { expectedRevision: stale.revision });
  const paired = await method("pair-first");
  await documents.put("u1", "method", paired.id, { ...paired.payload, body: [...SECTIONS, "", "Use the 配对评测 first, and stay inside the submission limit."].join("\n") }, { expectedRevision: paired.revision });
  return { documents, learning, taught, stale, paired, deps: { documents, learning, retiredFeaturesOfMethod } };
}

test("the arguments name an account, or --all for the report, and at most one of apply and restore", () => {
  assert.deepEqual(parseArguments(["--user", "u1"]), { user: "u1", all: false, apply: false, restore: false });
  assert.deepEqual(parseArguments(["--all"]), { user: "", all: true, apply: false, restore: false });
  assert.throws(() => parseArguments([]), /--user/);
  assert.throws(() => parseArguments(["--user", "u1", "--apply", "--restore"]), /two runs/);
  assert.throws(() => parseArguments(["--all", "--apply"]), /name one account/);
  assert.throws(() => parseArguments(["--user", "u1", "--all"]), /two runs/);
  assert.throws(() => parseArguments(["--frobnicate"]), /unknown argument/);
});

test("the report lists what names a retired feature, and writes nothing", async () => {
  const a = await account();
  const report = await sweepAccount(a.deps, { user: "u1" });
  assert.equal(report.mode, "report");
  assert.deepEqual(report.items.map((item) => [item.kind, item.id.split(":").at(-1), item.code, item.features]).sort(), [
    ["method", "pair-first", "stale_feature", ["submit-limit", "paired-evaluation"]],
    ["method", "write-the-search-log", "stale_feature", ["search-log"]],
  ]);
  assert.deepEqual(report.byKind, { method: 2 });
  assert.deepEqual((await findStale(a.deps, "u1")).findings.length, 2, "reading changes nothing");
  assert.equal((await a.learning.getMethod("u1", a.stale.id)).payload.status, "approved");
  // The report names ids, titles and closed feature names: not a body.
  assert.doesNotMatch(JSON.stringify(report), /clinical-evidence-search\.json|Stay inside the submission/);
});

test("--apply puts each away the way the page does and keeps everything else", async () => {
  const a = await account();
  /** @type {any[]} */ const audits = [];
  const applied = await sweepAccount({ ...a.deps, audit: (event, detail) => { audits.push([event, detail]); } }, { user: "u1", apply: true });
  assert.equal(applied.retired, 2);
  assert.equal((await a.learning.getMethod("u1", a.stale.id)).payload.status, "retired");
  assert.equal((await a.learning.getMethod("u1", a.stale.id)).payload.statusReason, STALE_REASON);
  assert.equal((await a.learning.getMethod("u1", a.paired.id)).payload.status, "retired");
  assert.equal((await a.learning.getMethod("u1", a.taught.id)).payload.status, "approved", "a method that names nothing retired stays");
  assert.deepEqual(audits.map(([event]) => event), ["learning.sweep.apply"]);
  // Idempotent: nothing is left to put away.
  assert.equal((await sweepAccount(a.deps, { user: "u1" })).wouldRetire, 0);
  assert.equal((await sweepAccount(a.deps, { user: "u1", apply: true })).retired, 0);
});

test("--restore gives back exactly what the sweep put away, in one step each, and leaves what was stopped for another reason", async () => {
  const a = await account();
  // A method the researcher stopped by hand, whose text also names a retired feature.
  const byHand = await a.learning.createCandidate("u1", { projectId: "p1", frontmatter: frontmatter("by-hand"), body: SECTIONS.join("\n"), provenance: { origin: "inferred", runId: "run_0" } });
  await a.documents.put("u1", "method", byHand.id, { ...byHand.payload, body: [...SECTIONS, "", "references.bib"].join("\n") }, { expectedRevision: byHand.revision });
  await a.learning.retire("u1", byHand.id, { expectedRevision: (await a.learning.getMethod("u1", byHand.id)).revision, reason: "停用了" });
  await sweepAccount(a.deps, { user: "u1", apply: true });
  const restored = await sweepAccount(a.deps, { user: "u1", restore: true });
  assert.equal(restored.restored, 2);
  assert.equal((await a.learning.getMethod("u1", a.stale.id)).payload.status, "approved");
  assert.equal((await a.learning.getMethod("u1", a.paired.id)).payload.status, "approved");
  assert.equal((await a.learning.getMethod("u1", byHand.id)).payload.status, "retired", "stopped by hand stays stopped");
  assert.equal((await sweepAccount(a.deps, { user: "u1", restore: true })).restored, 0);
});

test("a lesson that names a retired feature is refused when it is written", async () => {
  const { learning } = await account();
  await assert.rejects(learning.createCandidate("u1", { projectId: "p1", frontmatter: frontmatter("new-stale"), body: [...SECTIONS, "", "Write citation-audit.md."].join("\n"),
    provenance: { origin: "inferred", runId: "run_1" } }), (error) => error?.code === "method_invalid" && /method_stale_feature/.test(error.message));
});
