import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadAgentRegistry } from "../src/agentRegistry.mjs";
import { readDeliveryReceipt, requiredSpecialistArtifactsForTest } from "../src/agentRuns.mjs";
import { deliverySummaryFileFor, receiptFileFor, workspaceLayout } from "@evimed/domain";

// A run's receipt is its own file (`receiptFileFor`). It used to be one file at
// the workspace root that the run writing last owned, so two runs alive in one
// project erased each other's entries and the control plane, which lists a
// run's artifacts from its receipt, silently dropped the files from both
// records (2026-10-10). Here the reader's half: each run reads its own file,
// and the project-wide file older runs wrote still serves the run it names.
// The summary the run policy ends a turn with moved the same way, and the last
// test says what a researcher sees of that.

const sha = (text) => createHash("sha256").update(text).digest("hex");

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evimed-receipt-scope-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = { rootDir: root, baseDir: root, workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, ".openscience") };
  await fs.mkdir(project.workspaceDir, { recursive: true });
  const put = async (relative, text) => {
    const file = path.join(project.workspaceDir, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  };
  /** A deliverable's file on disk, and the receipt entry that names it. */
  const deliver = async (id, { acceptedAt = "2026-10-10T05:10:14.688Z" } = {}) => {
    const text = `# ${id}\n`;
    const relative = `deliverables/${id}/report.md`;
    await put(relative, text);
    return {
      deliverableId: id, contractKind: "research-brief", capability: "research-brief", acceptedAt, attempt: 1, notices: [],
      files: [{ path: relative, sha256: sha(text), bytes: Buffer.byteLength(text) }],
    };
  };
  const receipt = (runId, entries) => ({ formatVersion: 1, runId, bundleVersion: "1", domainVersion: "1", entries });
  return { project, put, deliver, receipt };
}

const ids = (receipt) => receipt?.entries.map((entry) => entry.deliverableId).sort() ?? null;

test("two runs of one project each read their own receipt, whatever the other delivered", async (t) => {
  const f = await workspace(t);
  const [a1, a2, b1] = [await f.deliver("a1"), await f.deliver("a2"), await f.deliver("b1")];
  await f.put(receiptFileFor("run_a"), JSON.stringify(f.receipt("run_a", [a1, a2])));
  await f.put(receiptFileFor("run_b"), JSON.stringify(f.receipt("run_b", [b1])));

  const a = await readDeliveryReceipt(f.project, { id: "run_a" });
  const b = await readDeliveryReceipt(f.project, { id: "run_b" });
  assert.deepEqual(ids(a), ["a1", "a2"], "run A keeps both of its packages");
  assert.deepEqual(ids(b), ["b1"], "run B keeps its package, which A's later acceptance did not replace");
  assert.equal(a.runId, "run_a");
  assert.equal(b.runId, "run_b");
  assert.equal(await readDeliveryReceipt(f.project, { id: "run_c" }), null, "a run that delivered nothing has no receipt, however many others do");
});

test("the project-wide receipt of a run that predates per-run receipts still serves that run and no other", async (t) => {
  const f = await workspace(t);
  const old = await f.deliver("old");
  await f.put(workspaceLayout.receiptFile, JSON.stringify(f.receipt("run_old", [old])));

  assert.deepEqual(ids(await readDeliveryReceipt(f.project, { id: "run_old" })), ["old"]);
  assert.equal(await readDeliveryReceipt(f.project, { id: "run_new" }), null, "a stranger's receipt is not this run's delivery");

  // The run's own file, once it has one, is the receipt; the old file is not merged in.
  const fresh = await f.deliver("fresh");
  await f.put(receiptFileFor("run_old"), JSON.stringify(f.receipt("run_old", [fresh])));
  assert.deepEqual(ids(await readDeliveryReceipt(f.project, { id: "run_old" })), ["fresh"]);
});

test("a conversation turn finds the receipt under the id its workflow was named, and no other turn's", async (t) => {
  const f = await workspace(t);
  const accepted = Date.parse("2026-10-10T05:10:14.688Z");
  const entry = await f.deliver("d1", { acceptedAt: new Date(accepted).toISOString() });
  entry.contractKind = "clinical-evidence-report";
  entry.capability = "clinical-evidence-synthesis";
  await f.put(receiptFileFor("native_aaa"), JSON.stringify(f.receipt("native_aaa", [entry])));
  const turn = (kernelRunId) => ({
    id: "ledger_turn", sessionId: "session_a", status: "succeeded", nativeTurn: { startSeq: 1 },
    nativeWorkflow: {
      kernelRunId,
      plan: { revision: 1, written: true, items: [{ id: "d1", contractKind: entry.contractKind, capability: entry.capability }], start: accepted - 1_000 },
      submissions: [{ id: "d1", attempts: 1, accepted: { start: accepted - 500, end: accepted + 500, contractKind: entry.contractKind }, rejected: null }],
      delegates: [], endTime: accepted + 2_000,
    },
  });

  assert.deepEqual(ids(await readDeliveryReceipt(f.project, turn("native_aaa"))), ["d1"]);
  assert.equal(await readDeliveryReceipt(f.project, turn("native_bbb")), null, "another session's workflow has a file of its own, and it holds nothing");
});

test("a capability that declares a delivery summary lists its own, which the platform's per-run record neither replaces nor shadows", async (t) => {
  // The run policy ends a turn with a summary of the run (its id, the deliverables, what is open). It was one file at the
  // workspace root, and three capabilities declare a `delivery-summary.md` of their own as a required output. The server
  // looks for a declared output at the root first, so for them the platform's record stood in for the capability's own
  // summary in the run's file list -- the researcher's 「交付摘要」 opened a process record, the project-wide file at that,
  // which the next run replaced (the recorded run evals/evidence-appraisal/results/2026-10-03-appraisal-001-sglt2-hfpef
  // lists both, the real summary and the bare root one). Nothing else ever listed it: the file routes need a path, the
  // hosted frame has no workspace tree (runtimeUiShell.mjs removes the kernel's sidebar), and the web's `listDir` has no caller.
  // It is a per-run record under the protected run directory now, and the capability's own summary is the one that is listed.
  const registry = await loadAgentRegistry({ packageDirs: [new URL("../../../runtime/skills/evimed", import.meta.url).pathname], capabilityDirs: [new URL("../../../capabilities", import.meta.url).pathname] });
  const name = workspaceLayout.deliverySummaryFile;
  const owners = registry.list({ includeInternal: true }).filter((agent) => agent.outputs.some((output) => output.path === name && output.required));
  assert.ok(owners.length >= 3, `the walk found ${owners.length} capabilities that declare ${name}`);
  for (const agent of owners) {
    const f = await workspace(t);
    const run = { id: "run_x", sessionId: "ses_x", effectiveAgentId: agent.id, effectiveAgentVersion: agent.version, effectiveRuntimeAgent: agent.runtimeAgent,
      startedAt: new Date(Date.now() - 60_000).toISOString(), mountedSkills: [agent.skill, ...(agent.companionSkills ?? [])] };
    // The package, as the run-side gate accepts it: every required file in the deliverable's own directory.
    for (const output of agent.outputs.filter((candidate) => candidate.required)) await f.put(`deliverables/d1/${output.path}`, `# ${output.path}\n内容。\n`);
    // The platform's record of this run, where the run policy files it, and an earlier run's at the root from before it did.
    await f.put(deliverySummaryFileFor(run.id), "# 交付摘要\n\n- 运行 id：run_x\n");
    await f.put(name, "# 交付摘要\n\n- 运行 id：an_earlier_run\n");
    const earlier = new Date(Date.now() - 2 * 3_600_000);
    await fs.utimes(path.join(f.project.workspaceDir, name), earlier, earlier);

    for (const asked of [run, { ...run, nativeTurn: { startSeq: 1 } }]) {
      const outcome = await requiredSpecialistArtifactsForTest(f.project, asked, registry);
      assert.equal(outcome.errorCode, null, `${agent.id}: ${JSON.stringify(outcome.qualityIssues)}`);
      assert.ok(outcome.artifacts.includes(`deliverables/d1/${name}`), `${agent.id}: its own summary is listed: ${JSON.stringify(outcome.artifacts)}`);
      assert.equal(outcome.artifacts.includes(name), false, `${agent.id}: the root file of an earlier run is not`);
      assert.equal(outcome.artifacts.some((file) => file.startsWith(".evimed-run/")), false, `${agent.id}: nor is the platform's record, which is not a deliverable`);
    }

    // The negative control, which is why the record is not filed at the root any more: a fresh file there is found first
    // and is what the run lists in the capability's place.
    await f.put(name, "# 交付摘要\n\n- 运行 id：run_x\n");
    const shadowed = await requiredSpecialistArtifactsForTest(f.project, run, registry);
    assert.ok(shadowed.artifacts.includes(name) && !shadowed.artifacts.includes(`deliverables/d1/${name}`), `${agent.id}: ${JSON.stringify(shadowed.artifacts)}`);
  }
});
