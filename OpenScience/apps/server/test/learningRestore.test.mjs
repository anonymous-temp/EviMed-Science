// Putting back the method a project deletion took (audit 2026-09-26, L-G1):
// `pre-submission-freeze-check` went with its project on 2026-09-23, and the
// learning loop's own result archive — in the account's learning project,
// which no project deletion touches — still holds the SKILL.md it wrote.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { METHOD_SKILL_SCHEMA, renderMethodSkill } from "@evimed/domain";

import { LEARNING_PROJECT_ID } from "../src/internalProjects.mjs";
import { LearningService } from "../src/learningService.mjs";
import { findArchivedMethod, parseArguments, restoreLearnedMethod } from "../../../scripts/ops/restore-learned-method.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";

const BODY = [
  "## Purpose", "Freeze the package before it is submitted.", "",
  "## When to Use", "Before a delivery is submitted.", "",
  "## Inputs", "The package.", "",
  "## Workflow", "1. Freeze it.", "",
  "## Verification", "- Nothing changed after the freeze.", "",
  "## Constraints", "- Never edit a frozen file.", "",
  "## Output", "A frozen package.",
].join("\n");

/** @param {string} body */
const skill = (body) => renderMethodSkill({
  name: "pre-submission-freeze-check",
  description: "Freezes a package before it is submitted so nothing changes between the check and the delivery.",
  whenToUse: "Before a delivery is submitted.",
  metadata: { role: "functional", applies_when: "A package is about to be submitted.", not_when: "Nothing is being delivered.",
    derived_from: "run:run_1f85b832", evimed_schema: METHOD_SKILL_SCHEMA },
}, body);

/** One archived distillation result, as `archiveLatestResult` writes it. */
async function archive(dataDir, dispatchId, { body = BODY, candidate = {}, receipt = true, at = null } = {}) {
  const directory = path.join(dataDir, "users", "cdss-access", "projects", LEARNING_PROJECT_ID, ".openscience", "learning-results", dispatchId);
  const deliverable = path.join(directory, "deliverables", "method-candidate");
  await mkdir(deliverable, { recursive: true });
  await writeFile(path.join(deliverable, "SKILL.md"), skill(body));
  await writeFile(path.join(deliverable, "method-candidate.json"), JSON.stringify({ schemaVersion: 1, operation: "create", ...candidate }));
  if (receipt) await writeFile(path.join(directory, "delivery-receipt.json"), "{}");
  if (at) await utimes(path.join(deliverable, "SKILL.md"), at, at);
  return directory;
}

test("the newest complete archive of the method is found, and restored at account level with where it came from", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-restore-method-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await archive(dataDir, "method-distillation-old", { body: `${BODY}\n\nAn older draft.`, at: new Date("2026-09-20T00:00:00Z") });
  await archive(dataDir, "method-distillation-new", {
    at: new Date("2026-09-21T00:00:00Z"),
    candidate: { evidence: [{ runId: "run_1f85b832", seqRange: [1, 2], quote: "…" }], risk: { touchesSafety: true },
      display: { title: "提交前先冻结", summary: "提交交付物之前先把包冻结，核对之后不再改动。" } },
  });
  await archive(dataDir, "method-distillation-partial", { body: `${BODY}\n\nNever finished.`, receipt: false, at: new Date("2026-09-22T00:00:00Z") });
  await archive(dataDir, "method-distillation-other", { at: new Date("2026-09-23T00:00:00Z") }).then(async (directory) => {
    await writeFile(path.join(directory, "deliverables", "method-candidate", "SKILL.md"), skill(BODY).replace("pre-submission-freeze-check", "another-method"));
  });

  const found = await findArchivedMethod({ dataDir, userId: "cdss-access", name: "pre-submission-freeze-check" });
  assert.match(found?.file ?? "", /method-distillation-new/, "the newest archive that is complete, not a newer partial one");

  const documents = productDocumentsDouble();
  const learning = new LearningService({ documents });
  const report = await restoreLearnedMethod({ learning, dataDir, userId: "cdss-access", name: "pre-submission-freeze-check", apply: false });
  assert.equal(report.state, "restorable");
  assert.equal(report.sourceRunId, "run_1f85b832");
  assert.equal(report.title, "提交前先冻结");
  assert.equal(documents.rows.size, 0, "a report writes nothing");

  const restored = await restoreLearnedMethod({ learning, dataDir, userId: "cdss-access", name: "pre-submission-freeze-check",
    sourceProjectId: "deleted-project", apply: true });
  assert.equal(restored.state, "restored");
  assert.equal(restored.status, "approved");
  const method = await learning.getMethod("cdss-access", "method:learned:pre-submission-freeze-check");
  assert.equal(method.projectId, null, "the account's, so no project deletion takes it again");
  assert.equal(method.payload.provenance.sourceProjectId, "deleted-project");
  assert.equal(method.payload.provenance.runId, "run_1f85b832");
  assert.match(method.payload.provenance.restoredFrom, /learning-results\/method-distillation-new/);
  assert.equal(method.payload.provenance.safetyRelated, true);
  assert.equal(method.payload.display.title, "提交前先冻结");
  assert.equal(method.payload.body.trim(), BODY, "the archived body, as the SKILL.md parser reads it");

  // Idempotent: the second run finds it in the library and leaves it alone.
  const again = await restoreLearnedMethod({ learning, dataDir, userId: "cdss-access", name: "pre-submission-freeze-check", apply: true });
  assert.equal(again.state, "present");
  assert.equal(documents.rows.size, 1);
  // A name no archive holds is said so.
  assert.equal((await restoreLearnedMethod({ learning, dataDir, userId: "cdss-access", name: "never-learnt", apply: true })).state, "not_archived");
});

test("the command line names one account and one method, and nothing else", () => {
  assert.deepEqual(parseArguments(["--user", "cdss-access", "--name", "pre-submission-freeze-check"]),
    { apply: false, userId: "cdss-access", name: "pre-submission-freeze-check", dataDir: null, archive: null, sourceProjectId: null });
  assert.equal(parseArguments(["--user", "u", "--name", "a-b", "--apply", "--data-dir", "/data"]).apply, true);
  assert.throws(() => parseArguments(["--name", "a-b"]), /--user is required/);
  assert.throws(() => parseArguments(["--user", "u", "--name", "../etc"]), /kebab-case/);
  assert.throws(() => parseArguments(["--user", "u", "--name", "a", "--force"]), /unknown argument/);
});
