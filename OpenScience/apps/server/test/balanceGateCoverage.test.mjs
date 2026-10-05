// Every way this control plane starts research work, and whether the research
// allowance is asked before it begins.
//
// A balance gate that covers the chat route and not the other ways in is one the
// product walks around, and a new way of starting work is exactly where it would
// be forgotten. So the inventory is declared here: a run dispatched anywhere in
// `src` is either one of the researcher's (and its function asks the allowance
// before the dispatch) or one of the platform's own background jobs (which are
// never charged to anyone and so never gated). A new `agentRuns.dispatch(` that
// is in neither list fails this test with the question it has to answer.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { isChargeableResearchRun, isResearcherOwnedWork } from "@evimed/domain";

const SRC = path.resolve(import.meta.dirname, "../src");
/** What a function that dispatches a researcher's run must contain before it does. */
const GATE = /assertBalanceForStart\(|checkAutopilotBalance\(/;
/** Where a dispatch site's enclosing function (or route) begins. */
const ANCHOR = /^[ \t]*(?:async function (\w+)|(\w+): async \(|if \(pathname === "\/api\/agent-runs\/dispatch")/gm;

/** The researcher's own work: each asks the allowance before it dispatches. */
const RESEARCHER_OWNED = [
  "if",                 // POST /api/agent-runs/dispatch — the page's own question
  "dispatchVerification", // autopilot: an independent check of a proactive claim
  "dispatchEpisode",    // autopilot: one budgeted episode
  "dispatchVcrRun",     // 虚拟临研 programme step
  "dispatchGeoRun",     // 循证 GEO programme step
  "dispatchChannelRun", // a question that arrived through a messaging channel
];
/** The platform's own background work: charged to nobody, so asked of nobody. */
const PLATFORM_INTERNAL = {
  "learningRuntime.mjs": "the learning loop distils and relates methods in an internal project",
  "sourceUnderstandingRuntime.mjs": "reading a document into the knowledge base is the platform's cost",
  "evolutionRuns.mjs": "literature-driven tool development and protected paper evaluation use the platform's own budget",
};

test("every researcher-owned dispatch asks the allowance first, and the platform's own background jobs ask nobody", async () => {
  const files = (await readdir(SRC)).filter((name) => name.endsWith(".mjs"));
  const sites = [];
  for (const name of files) {
    const text = await readFile(path.join(SRC, name), "utf8");
    for (const match of text.matchAll(/agentRuns\.dispatch\(/g)) {
      const anchors = [...text.slice(0, match.index).matchAll(ANCHOR)];
      const anchor = anchors.at(-1);
      assert.ok(anchor, `${name}: a dispatch outside any function the test can name`);
      const holder = anchor[1] ?? anchor[2] ?? "if";
      sites.push({ file: name, holder, before: text.slice(anchor.index, match.index) });
    }
  }
  assert.ok(sites.length >= 8, `${sites.length} dispatch sites found; the scan did not walk`);

  const inServer = sites.filter((site) => site.file === "server.mjs");
  assert.deepEqual(inServer.map((site) => site.holder).sort(), [...RESEARCHER_OWNED].sort(),
    "server.mjs dispatches from a function this test does not know: is it the researcher's work (ask the allowance first and list it) or the platform's (list it with its reason)?");
  for (const site of inServer) {
    assert.match(site.before, GATE, `${site.holder} dispatches a researcher's run without asking the allowance before it`);
  }

  const elsewhere = sites.filter((site) => site.file !== "server.mjs");
  assert.deepEqual([...new Set(elsewhere.map((site) => site.file))].sort(), Object.keys(PLATFORM_INTERNAL).sort(),
    "a dispatch in a file that is neither the server's nor a declared platform job");
  for (const site of elsewhere) assert.doesNotMatch(site.before, /assertBalanceForStart\(/, `${site.file} gates work nobody is charged for`);
});

test("a turn typed into the kernel's own window is asked at the one method that begins a turn, and never for a steer", async () => {
  const ui = await readFile(path.join(SRC, "runtimeUiServer.mjs"), "utf8");
  const server = await readFile(path.join(SRC, "server.mjs"), "utf8");
  // The gate is handed in by the composition root and called from the spending method, on both transports.
  assert.match(server, /balanceGate: credits \? async \(project, payload\)/);
  assert.equal([...ui.matchAll(/authorizeMethod\(config, project, (?:method|endpoint), (?:boundWorkspace|false), usageLedger, runtimeManager, balanceGate, /g)].length, 2,
    "both the HTTP and the mux transport must pass the gate and the payload");
  assert.match(ui, /RUNTIME_UI_SPENDING_METHODS = new Set\(\["session\/prompt"\]\)/);
  assert.match(ui, /payload\?\.args\?\.request\?\.mode !== "steer"\) await balanceGate\(project, payload\)/);
});

test("what is gated is what is charged: programme and proactive steps are the researcher's, the platform's own jobs are not", () => {
  for (const reason of ["geo:evidence", "autopilot:literature-sentinel", "vcr:evidence"]) {
    assert.equal(isResearcherOwnedWork({ automated: true, effectiveAgentId: "geo-insight", effectiveRouteReason: reason }), true, reason);
  }
  assert.equal(isResearcherOwnedWork({ automated: false, effectiveAgentId: "open-domain-answer" }), true);
  for (const agent of ["source-understanding", "method-distillation", "method-relations"]) {
    assert.equal(isResearcherOwnedWork({ automated: true, effectiveAgentId: agent }), false, agent);
    assert.equal(isResearcherOwnedWork({ automated: false, effectiveAgentId: agent }), false, agent);
  }
  assert.equal(isResearcherOwnedWork({ automated: true, effectiveRouteReason: "platform-learning", effectiveAgentId: "adr-analysis" }), false, "a paired evaluation is the platform's");
  assert.equal(isResearcherOwnedWork({ automated: true, dispatchId: "methodeval_x", effectiveAgentId: "adr-analysis" }), false, "a harness's own run teaches nothing");
  assert.equal(isChargeableResearchRun({ automated: true, dispatchId: "methodeval_x", effectiveAgentId: "adr-analysis" }), true, "but a name typed into a dispatch is not what the platform dispatched");
});
