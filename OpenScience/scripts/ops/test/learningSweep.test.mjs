import assert from "node:assert/strict";
import test from "node:test";

import { METHOD_SKILL_SCHEMA, retiredFeaturesOfMethod } from "@evimed/domain";

import { HandbookLibrary } from "../../../apps/server/src/handbookLibrary.mjs";
import { LearningService } from "../../../apps/server/src/learningService.mjs";
import { productDocumentsDouble } from "../../../apps/server/test/helpers/productDocumentsDouble.mjs";
import { APPLIED_REASON, STALE_REASON, findStale, parseArguments, sweepAccount } from "../learning-sweep.mjs";

const SECTIONS = ["## Purpose", "Do a thing.", "", "## When to Use", "When needed.", "", "## Inputs", "A frozen input.", "", "## Workflow", "1. Do it.", "",
  "## Verification", "- It was done.", "", "## Constraints", "- Never do the other thing.", "", "## Output", "The thing."];
const frontmatter = (name) => ({ name, description: `Does ${name} when ${name} is needed.`, whenToUse: `When ${name} is needed.`,
  metadata: { role: "functional", applies_when: "Needed.", not_when: "Not needed.", derived_from: "run:run_0", evimed_schema: METHOD_SKILL_SCHEMA } });
const digest = (letter) => `sha256:${letter.repeat(64)}`;

/** The account of the live audit: learnt before the rulings, so written past the check that would refuse them today. */
async function account() {
  const documents = productDocumentsDouble();
  const learning = new LearningService({ documents, now: () => new Date("2026-10-23T00:00:00.000Z") });
  const handbooks = new HandbookLibrary({ learning, now: () => new Date("2026-10-23T00:00:00.000Z") });
  const method = (name, body = SECTIONS.join("\n")) => learning.createCandidate("u1", { projectId: "p1", frontmatter: frontmatter(name), body, provenance: { origin: "inferred", runId: "run_0" } });
  const taught = await method("quote-first");
  // A method that names a retired file: written the way a record of 2026-09 was, with no check in front of it.
  const stale = await method("write-the-search-log");
  await documents.put("u1", "method", stale.id, { ...stale.payload, body: [...SECTIONS, "", "Write clinical-evidence-search.json before submitting."].join("\n") }, { expectedRevision: stale.revision });
  const staleBody = [...SECTIONS, "", "Stay inside the submission limit; keep references.bib current."].join("\n");
  const handbook = (id, name, body, extra = {}) => documents.put("u1", "method", id, {
    recordType: "capability-handbook", capabilityId: "clinical-evidence-synthesis", status: "active", frontmatter: frontmatter(name), body, dependencies: [],
    contentDigest: digest("a"), provenance: { origin: "inferred" }, ...extra,
  }, { expectedRevision: 0 });
  await handbook("method:capability-handbook:clinical-evidence-synthesis:freeze-check", "freeze-check", staleBody);
  await handbook("method:capability-handbook:clinical-evidence-synthesis:fine", "fine", SECTIONS.join("\n"));
  const candidate = (id, name, body, disposition) => documents.put("u1", "method", id, {
    recordType: "handbook-candidate", status: "candidate", capabilityId: "clinical-evidence-synthesis", frontmatter: frontmatter(name), body, contentDigest: digest("b"),
    dispositions: disposition ? { [digest("b")]: { disposition, at: "2026-10-01T00:00:00.000Z" } } : {}, provenance: { origin: "inferred", derivedFrom: "reviewer" },
  }, { expectedRevision: 0 });
  await candidate("method:handbook:clinical-evidence-synthesis:freeze-check", "freeze-check", staleBody, "applied");
  await candidate("method:handbook:clinical-evidence-synthesis:waiting", "waiting", [...SECTIONS, "", "Use the 配对评测 first."].join("\n"), "queued");
  await candidate("method:handbook:clinical-evidence-synthesis:applied-fine", "applied-fine", SECTIONS.join("\n"), "applied");
  await candidate("method:handbook:clinical-evidence-synthesis:waiting-fine", "waiting-fine", SECTIONS.join("\n"), "queued");
  return { documents, learning, handbooks, taught, stale, deps: { documents, learning, handbooks, retiredFeaturesOfMethod } };
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

test("the report lists what names a retired feature, and the candidates already applied, and writes nothing", async () => {
  const a = await account();
  const report = await sweepAccount(a.deps, { user: "u1" });
  assert.equal(report.mode, "report");
  assert.deepEqual(report.items.map((item) => [item.kind, item.id.split(":").at(-1), item.code, item.features]).sort(), [
    ["handbook", "freeze-check", "stale_feature", ["bibliography", "submit-limit"]],
    ["handbook-candidate", "applied-fine", "applied", []],
    ["handbook-candidate", "freeze-check", "stale_feature", ["bibliography", "submit-limit"]],
    ["handbook-candidate", "waiting", "stale_feature", ["paired-evaluation"]],
    ["method", "write-the-search-log", "stale_feature", ["search-log"]],
  ]);
  assert.deepEqual(report.byKind, { method: 1, handbook: 1, "handbook-candidate": 3 });
  assert.deepEqual((await findStale(a.deps, "u1")).findings.length, 5, "reading changes nothing");
  assert.equal((await a.learning.getMethod("u1", a.stale.id)).payload.status, "approved");
  // The report names ids, titles and closed feature names: not a body.
  assert.doesNotMatch(JSON.stringify(report), /clinical-evidence-search\.json|Stay inside the submission/);
});

test("--apply puts each away the way the page does, closes the candidate the handbook loop would take up, and keeps everything else", async () => {
  const a = await account();
  /** @type {any[]} */ const audits = [];
  const applied = await sweepAccount({ ...a.deps, audit: (event, detail) => { audits.push([event, detail]); }, now: () => new Date("2026-10-23T09:00:00.000Z") }, { user: "u1", apply: true });
  assert.equal(applied.retired, 5);
  assert.equal((await a.learning.getMethod("u1", a.stale.id)).payload.status, "retired");
  assert.equal((await a.learning.getMethod("u1", a.stale.id)).payload.statusReason, STALE_REASON);
  assert.equal((await a.learning.getMethod("u1", a.taught.id)).payload.status, "approved", "a method that names nothing retired stays");
  const handbook = await a.documents.get("u1", "method", "method:capability-handbook:clinical-evidence-synthesis:freeze-check");
  assert.deepEqual([handbook.payload.status, handbook.payload.statusReason], ["retired", STALE_REASON]);
  assert.equal((await a.documents.get("u1", "method", "method:capability-handbook:clinical-evidence-synthesis:fine")).payload.status, "active");
  const waiting = await a.documents.get("u1", "method", "method:handbook:clinical-evidence-synthesis:waiting");
  assert.deepEqual([waiting.payload.status, waiting.payload.statusReason], ["retired", STALE_REASON]);
  assert.deepEqual(waiting.payload.dispositions[digest("b")], { disposition: "rejected", reason: "stale_feature", at: "2026-10-23T09:00:00.000Z" }, "closed, so the handbook loop does not take it up again");
  const duplicate = await a.documents.get("u1", "method", "method:handbook:clinical-evidence-synthesis:applied-fine");
  assert.deepEqual([duplicate.payload.status, duplicate.payload.statusReason], ["retired", APPLIED_REASON]);
  assert.equal(duplicate.payload.dispositions[digest("b")].disposition, "applied", "an applied candidate keeps its own record");
  assert.equal((await a.documents.get("u1", "method", "method:handbook:clinical-evidence-synthesis:waiting-fine")).payload.status, "candidate");
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
  assert.equal(restored.restored, 5);
  assert.equal((await a.learning.getMethod("u1", a.stale.id)).payload.status, "approved");
  assert.equal((await a.documents.get("u1", "method", "method:capability-handbook:clinical-evidence-synthesis:freeze-check")).payload.status, "active",
    "a handbook that names a retired feature is still given back: what was written before the list is not held to it");
  assert.equal((await a.documents.get("u1", "method", "method:handbook:clinical-evidence-synthesis:waiting")).payload.status, "candidate");
  assert.equal((await a.documents.get("u1", "method", "method:handbook:clinical-evidence-synthesis:applied-fine")).payload.status, "candidate");
  assert.equal((await a.learning.getMethod("u1", byHand.id)).payload.status, "retired", "stopped by hand stays stopped");
  assert.equal((await sweepAccount(a.deps, { user: "u1", restore: true })).restored, 0);
});

test("a lesson that names a retired feature is refused when it is written, and a handbook is given back whatever it names", async () => {
  const { learning } = await account();
  await assert.rejects(learning.createCandidate("u1", { projectId: "p1", frontmatter: frontmatter("new-stale"), body: [...SECTIONS, "", "Write citation-audit.md."].join("\n"),
    provenance: { origin: "inferred", runId: "run_1" } }), (error) => error?.code === "method_invalid" && /method_stale_feature/.test(error.message));
  await assert.rejects(learning.validateHandbook("u1", { frontmatter: frontmatter("h"), body: [...SECTIONS, "", "Write citation-audit.md."].join("\n"), provenance: { origin: "inferred", derivedFrom: "reviewer" } }),
    (error) => error?.code === "method_invalid");
  await learning.validateHandbook("u1", { frontmatter: frontmatter("h"), body: [...SECTIONS, "", "Write citation-audit.md."].join("\n"), provenance: { origin: "inferred", derivedFrom: "reviewer" } }, { allowStale: true });
});
