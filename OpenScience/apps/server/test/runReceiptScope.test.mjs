import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readDeliveryReceipt } from "../src/agentRuns.mjs";
import { receiptFileFor, workspaceLayout } from "@evimed/domain";

// A run's receipt is its own file (`receiptFileFor`). It used to be one file at
// the workspace root that the run writing last owned, so two runs alive in one
// project erased each other's entries and the control plane, which lists a
// run's artifacts from its receipt, silently dropped the files from both
// records (2026-10-10). Here the reader's half: each run reads its own file,
// and the project-wide file older runs wrote still serves the run it names.

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
