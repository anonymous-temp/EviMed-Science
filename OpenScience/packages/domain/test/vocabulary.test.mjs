import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ALL_ERROR_CODES,
  CONTRACT_KINDS,
  CONTRACT_VALIDATOR_KINDS,
  DOMAIN_VERSION,
  MAX_DELEGATION_DEPTH,
  MCP_TOOL_BASE_NAMES,
  MCP_TOOL_NAMES,
  RUN_EVENT_TYPES,
  SOCKET_TOOL_NAME_LIST,
  canTransition,
  classifyEvidenceSourceError,
  delegationToolFilter,
  isEviMedToolName,
  isProtectedWritePath,
  layeredIssues,
  mcpToolBaseName,
  narrateToolCall,
  resolveContractKind,
  runGate,
  runPhase,
  states,
  RUN_PHASES,
  TERMINAL_RUN_PHASES,
  transition,
  transitionEvents,
  turnEndErrorCode,
  validateCapabilityManifest,
  validateDeliveryReceipt,
  validateTaskPlan,
} from "../index.mjs";

test("every contract kind has a validator and every validator has a kind", () => {
  assert.deepEqual([...CONTRACT_VALIDATOR_KINDS].sort(), [...CONTRACT_KINDS].sort());
});

test("the model never sees a doubled prefix", () => {
  for (const name of MCP_TOOL_NAMES) {
    assert.ok(!name.includes("evimed__evimed_"), `${name} carries the prefix twice`);
    assert.ok(name.length < 64, `${name} exceeds the 64-character tool-name budget`);
  }
  assert.equal(MCP_TOOL_NAMES.length, MCP_TOOL_BASE_NAMES.length);
});

test("every spelling of an MCP tool resolves to the same base name", () => {
  // Four spellings, not two: what the server publishes (bare — and what a
  // kernel that adds no prefix of its own, OpenCode, shows the model), what DSH
  // shows the model, what OpenCode's own session history reports a call as
  // (`<server-registration-name>_<published-name>`, a third and independent
  // prefix), and the historic published spelling, which the OpenCode-history
  // prefix can itself wrap — `evimed-research_evimed_literature_search` is a
  // real value found in run ledgers recorded before the un-prefixing.
  assert.equal(mcpToolBaseName("mcp__evimed__literature_search"), "literature_search");
  assert.equal(mcpToolBaseName("evimed_literature_search"), "literature_search");
  assert.equal(mcpToolBaseName("literature_search"), "literature_search");
  assert.equal(mcpToolBaseName("evimed-research_literature_search"), "literature_search");
  assert.equal(mcpToolBaseName("evimed-research_evimed_literature_search"), "literature_search");
  assert.equal(mcpToolBaseName("mcp__other__literature_search"), null);
  assert.equal(mcpToolBaseName("evimed-research_bogus_tool"), null);
  // The socket's own tools are a disjoint vocabulary, not a fifth spelling of a
  // research tool — `evimed_plan` must not resolve to a base name that does
  // not exist, however close the prefix looks.
  assert.equal(mcpToolBaseName("evimed_plan"), null);
});

test("EviMed tool names cover both worlds", () => {
  assert.ok(isEviMedToolName("mcp__evimed__official_page_fetch"));
  assert.ok(isEviMedToolName("evimed_submit_deliverable"));
  assert.ok(!isEviMedToolName("bash"));
  assert.equal(SOCKET_TOOL_NAME_LIST.length, 8);
});

test("the path guard refuses the question, the receipt and the state projection", () => {
  assert.ok(isProtectedWritePath(".evimed-brief/research-brief.md"));
  assert.ok(isProtectedWritePath(".evimed-run/state.json"));
  assert.ok(isProtectedWritePath("delivery-receipt.json"));
  assert.ok(isProtectedWritePath("data/cohort/rows.csv"));
  assert.ok(isProtectedWritePath("deliverables/../.evimed-brief/x"));
  assert.ok(!isProtectedWritePath("deliverables/d1/report.md"));
  assert.ok(!isProtectedWritePath("task-plan.json"));
});

test("state transitions are enumerable and illegal moves throw", () => {
  assert.equal(transition("run", "running", "deliver"), "delivering");
  assert.equal(transition("planItem", "submitted", "reject"), "rejected");
  assert.equal(transition("evidence", "queued", "ready"), "ready");
  assert.equal(transition("claimTier", "gated", "reproduce"), "reproduced");
  assert.throws(() => transition("run", "accepted", "deliver"), /illegal run transition/);
  assert.throws(() => transition("evidence", "verified", "ready"), /illegal evidence transition/);
  assert.ok(!canTransition("planItem", "accepted", "reject"));
  for (const table of ["run", "planItem", "evidence", "claimTier"]) {
    for (const state of /** @type {Record<string, readonly string[]>} */ (states)[table] ?? []) {
      for (const event of transitionEvents(/** @type {any} */ (table), state)) {
        const next = transition(/** @type {any} */ (table), state, event);
        assert.ok(typeof next === "string" && next.length > 0);
      }
    }
  }
});

test("a dispatched run may finish before it is ever observed to progress", () => {
  // `finishInternal`'s only precondition is `status === "running"` — dispatch
  // acknowledgment and progress do not gate it — so a run that completes (or
  // gets cut short) before its first progress observation is a fast run, not a
  // corrupted sequence. The `dispatched` row has to allow every event
  // `running` does, or the phase-adjacency check (§7.1.1) flags every quick
  // success as illegal.
  for (const event of ["accept", "degrade", "deliver", "cancel", "fail"]) {
    assert.doesNotThrow(() => transition("run", "dispatched", event), `dispatched must accept "${event}"`);
  }
});

test("an unknown turn-end kind lands on a counted unknown code, never on success", () => {
  assert.deepEqual(turnEndErrorCode("completed"), { errorCode: null });
  assert.deepEqual(turnEndErrorCode("aborted"), { errorCode: "runtime_canceled" });
  assert.deepEqual(turnEndErrorCode("blocked"), { errorCode: "runtime_tool_error", subCode: "turn_blocked" });
  assert.deepEqual(turnEndErrorCode("max-tokens"), { errorCode: "runtime_session_error", subCode: "model_max_tokens" });
  assert.deepEqual(turnEndErrorCode("interrupted"), { errorCode: "runtime_stopped" });
  const unknown = turnEndErrorCode("teleported");
  assert.equal(unknown.errorCode, "runtime_turn_end_unknown");
  assert.equal(unknown.unknownKind, "teleported");
});

test("no evidence-source code is classified by omission", () => {
  assert.equal(classifyEvidenceSourceError("full_text_not_available"), "recoverable");
  assert.equal(classifyEvidenceSourceError("full_text_body_missing"), "terminal");
  assert.equal(classifyEvidenceSourceError("a_code_nobody_wrote"), "unknown");
  assert.ok(ALL_ERROR_CODES.length > 150);
  assert.equal(new Set(ALL_ERROR_CODES).size, ALL_ERROR_CODES.length, "duplicate error code");
});

test("a plan without clarifications is rejected, and cycles are found", () => {
  const good = validateTaskPlan({
    revision: 1,
    clarifications: ["Assumed adults; asked nothing because hosted question-asking is off."],
    deliverables: [
      { id: "a", contractKind: "clinical-evidence-report", capability: "clinical-evidence-synthesis", title: "A", dependsOn: [] },
      { id: "b", contractKind: "research-brief", capability: "research-brief", title: "B", dependsOn: ["a"] },
    ],
  });
  assert.ok(good.ok, JSON.stringify(good.issues));
  const noClarify = validateTaskPlan({ revision: 1, clarifications: [], deliverables: [], reason: "direct answer" });
  assert.deepEqual(noClarify.issues.map((issue) => issue.code), ["plan_missing_clarifications"]);
  const cyclic = validateTaskPlan({
    revision: 1,
    clarifications: ["x"],
    deliverables: [
      { id: "a", contractKind: "research-brief", capability: "research-brief", title: "A", dependsOn: ["b"] },
      { id: "b", contractKind: "research-brief", capability: "research-brief", title: "B", dependsOn: ["a"] },
    ],
  });
  assert.ok(cyclic.issues.some((issue) => /cycle/.test(issue.message)));
  const emptyNoReason = validateTaskPlan({ revision: 1, clarifications: ["x"], deliverables: [] });
  assert.ok(emptyNoReason.issues.some((issue) => /must give a reason/.test(issue.message)));
});

test("a receipt must name files with real digests", () => {
  const digest = "a".repeat(64);
  const ok = validateDeliveryReceipt({
    formatVersion: 1,
    runId: "run_1",
    bundleVersion: "0.1.0",
    domainVersion: DOMAIN_VERSION,
    entries: [{ deliverableId: "d1", contractKind: "research-brief", capability: "research-brief", files: [{ path: "brief.md", sha256: digest, bytes: 12 }], acceptedAt: "2026-08-23T00:00:00Z", attempt: 1, notices: [] }],
  });
  assert.ok(ok.ok, JSON.stringify(ok.issues));
  const bad = validateDeliveryReceipt({ formatVersion: 1, runId: "run_1", bundleVersion: "0.1.0", domainVersion: DOMAIN_VERSION, entries: [{ deliverableId: "d1", files: [{ path: "brief.md", sha256: "short", bytes: 1 }] }] });
  assert.ok(!bad.ok);
});

test("a capability manifest names its contract, its skills and its tools", () => {
  const manifest = {
    id: "clinical-evidence-synthesis",
    version: "3.0.0",
    title: "Clinical Evidence Synthesis",
    description: "Turns a clinical question into a traceable evidence package.",
    whenToUse: "Delegate here when the deliverable is an evidence review of a clinical question.",
    persona: "You are a clinical evidence analyst.",
    skills: ["clinical-evidence-synthesis"],
    tools: ["mcp__evimed__literature_search", "mcp__evimed__open_access_full_text"],
    produces: [{ contractKind: "clinical-evidence-report", outputs: [{ path: "clinical-evidence-report.md", required: true }], checks: ["requiredOutputsExist"] }],
    inputs: { required: ["question"], optional: ["population"] },
    safetyClass: "clinical",
    estimatedMinutes: [30, 120],
  };
  const result = validateCapabilityManifest(manifest);
  assert.ok(result.ok, JSON.stringify(result.issues));
  // `result.ok` above is what rules out null; the validator's return type
  // cannot express that, so the narrowing is stated here.
  const valid = /** @type {any} */ (result.manifest);
  assert.deepEqual(resolveContractKind(valid), { ok: true, contractKind: "clinical-evidence-report" });
  assert.ok(delegationToolFilter(valid).includes("evimed_submit_deliverable"));
  assert.ok(delegationToolFilter(valid).includes("write"), "a child that cannot write cannot deliver");
  const legacy = validateCapabilityManifest({ ...manifest, tools: ["evimed_literature_search"] });
  assert.ok(legacy.issues.some((issue) => /legacy spelling/.test(issue.message)));
});

test("the gate returns a verdict rather than throwing, and layers its issues", () => {
  const verdict = runGate({
    contractKind: "research-brief",
    files: new Map([["brief.md", "# 标题\n结论。"]]),
    expectedOutputs: [{ path: "brief.md", required: true }, { path: "sources.csv", required: true }],
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.errorCode, "deliverable_rejected");
  assert.equal(layeredIssues(verdict.issues).required.length, 1);
  const unknown = runGate({ contractKind: "not-a-kind", files: new Map() });
  assert.equal(unknown.errorCode, "contract_kind_unknown");
});

test("prose that names the machinery is rejected in both tool spellings", () => {
  for (const leak of ["调用 mcp__evimed__literature_search 得到 12 条", "调用 evimed_literature_search 得到 12 条"]) {
    const verdict = runGate({
      contractKind: "research-brief",
      files: new Map([["brief.md", `# 标题\n${leak}`]]),
      expectedOutputs: [{ path: "brief.md", required: true }],
    });
    assert.ok(verdict.issues.some((issue) => issue.code === "runtime_leakage"), leak);
  }
});

test("clinical content under a non-clinical contract is caught by the trigger, not by the plan", () => {
  const verdict = runGate({
    contractKind: "research-brief",
    files: new Map([["brief.md", "# 标题\n速效救心丸的用法建议如下。"]]),
    expectedOutputs: [{ path: "brief.md", required: true }],
  });
  assert.ok(verdict.issues.some((issue) => issue.code === "clinical_content_without_clinical_contract"));
});

test("narration is deterministic and unknown tools are visibly unknown", () => {
  const known = narrateToolCall("mcp__evimed__guideline_search", { query: "房颤" }, { results: [1, 2] });
  assert.deepEqual(known, { text: "检索指南：「房颤」 → 2 条", known: true });
  assert.equal(narrateToolCall("mystery_tool").known, false);
  for (const name of ["mcp__evimed__literature_search", "evimed_plan", "bash"]) {
    assert.ok(narrateToolCall(name).known, name);
  }
});

test("delegation depth is a constant, not a configuration field", () => {
  assert.equal(MAX_DELEGATION_DEPTH, 1);
});

test("the run event union is closed and unique", () => {
  assert.equal(new Set(RUN_EVENT_TYPES).size, RUN_EVENT_TYPES.length);
  assert.ok(RUN_EVENT_TYPES.includes("unknown"), "an unknown event must be representable, not dropped");
});

test("the domain declares no dependencies and reaches for no node builtins", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.dependencies, undefined, "@evimed/domain must stay dependency-free");
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(new URL("../src/", import.meta.url))).filter((name) => name.endsWith(".mjs"));
  for (const name of [...files, "../index.mjs"]) {
    const source = await readFile(new URL(name.startsWith("..") ? name : `../src/${name}`, import.meta.url), "utf8");
    assert.ok(!/from\s+["']node:/.test(source), `${name} imports a node builtin`);
    assert.ok(!/require\(/.test(source), `${name} uses require`);
  }
});

test("no two modules export the same name, and the root re-exports every one of them", async () => {
  // The root re-exports by name now, so a collision is a load-time
  // `SyntaxError: Duplicate export` rather than a silent `undefined` — that is
  // the point of the lint rule banning `export *` here. This test survives the
  // change because it checks the other half: that the explicit list stayed in
  // step with the modules, which a hand-maintained list is exactly the kind of
  // thing to drift out of. A name defined in `src/` and missing from the root
  // is unreachable, and one listed twice is the old bug wearing a new hat.
  //
  // The delivery gate lives behind its own subpath
  // (`@evimed/domain/clinical-evidence`) precisely so its sixty internal names
  // never enter the root namespace, so it is not expected here.
  const indexSource = await readFile(new URL("../index.mjs", import.meta.url), "utf8");
  assert.equal(/^export \*/m.test(indexSource), false, "`export *` is banned at the root; re-export by name");
  const files = [...indexSource.matchAll(/^\} from '\.\/src\/([\w.]+)'$/gm)].map((match) => match[1]);
  assert.ok(files.length >= 12, `the index re-exports ${files.length} modules; this test expected more`);
  assert.equal(new Set(files).size, files.length, "a module is re-exported twice");

  const listed = new Set(
    [...indexSource.matchAll(/^ {2}([A-Za-z_$][\w$]*),$/gm)].map((match) => match[1]),
  );
  /** @type {Map<string, string[]>} */
  const owners = new Map();
  for (const file of files) {
    const source = await readFile(new URL(`../src/${file}`, import.meta.url), "utf8");
    for (const [, name] of source.matchAll(/^export (?:const|function|class|async function) ([A-Za-z_$][\w$]*)/gm)) {
      owners.set(name, [...(owners.get(name) ?? []), file]);
    }
  }
  const collisions = [...owners.entries()].filter(([, files_]) => files_.length > 1);
  assert.deepEqual(collisions, [], `a name is defined in more than one module: ${JSON.stringify(collisions)}`);

  // Nothing defined in a re-exported module may be missing from the list, or it
  // is defined and unreachable.
  const unlisted = [...owners.keys()].filter((name) => !listed.has(name));
  assert.deepEqual(unlisted, [], `defined in src/ but not re-exported from the root: ${unlisted.join(", ")}`);

  // And every exported name actually resolves through the package root.
  const root = await import("../index.mjs");
  for (const name of owners.keys()) {
    assert.notEqual(/** @type {Record<string, unknown>} */ (root)[name], undefined, `${name} resolves to undefined through the package root`);
  }
});

test("the capsule container's schema refuses what must never travel", async () => {
  const { validateCapsuleManifest, canonicalJson, merkleRoot } = await import("../index.mjs");
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  const digest = (/** @type {unknown} */ input) => String(input).length.toString(16).padStart(64, "0");
  assert.equal(merkleRoot([], digest).length, 64);
  const restricted = validateCapsuleManifest({
    formatVersion: "1.0",
    capsuleId: "c",
    version: 1,
    createdAt: "2026-08-23T00:00:00Z",
    issuer: { userId: "u", signingKeyId: "k" },
    scope: ["workstyle"],
    layers: ["sources"],
    entries: [{ path: "documents/x.pdf", sha256: "a".repeat(64), bytes: 1, mime: "application/pdf", layer: "sources" }],
    merkleRoot: "b".repeat(64),
    prevManifestSha256: null,
  });
  assert.ok(restricted.issues.some((issue) => issue.code === "capsule_restricted_content"));
});

test("off-peak is passed through, and an unknown model is unpriced rather than guessed", async () => {
  const { isPeak, priceUsage, spendingPermission, estimateCost } = await import("../index.mjs");
  // Beijing 10:00 on a Monday is 02:00 UTC — inside the provider's peak window.
  assert.equal(isPeak(new Date("2026-08-24T02:00:00Z")), true);
  assert.equal(isPeak(new Date("2026-08-24T20:00:00Z")), false);
  assert.equal(isPeak(new Date("2026-08-23T02:00:00Z")), false, "weekends are off-peak all day");

  const peak = priceUsage({ resourceType: "model", model: "deepseek-v4-pro", cacheHit: 1_000_000, cacheMiss: 0, output: 0, peak: true });
  const offPeak = priceUsage({ resourceType: "model", model: "deepseek-v4-pro", cacheHit: 1_000_000, cacheMiss: 0, output: 0, peak: false });
  assert.equal(offPeak.cost, peak.cost / 2, "the discount is passed through, not kept");

  const unknown = priceUsage({ resourceType: "model", model: "a-model-nobody-priced", output: 1000, peak: false });
  assert.deepEqual({ cost: unknown.cost, priced: unknown.priced }, { cost: 0, priced: false });

  const storage = priceUsage({ resourceType: "storage", gigabyteDays: 10, peak: false });
  assert.ok(storage.cost > 0, "storage has no peak window; a disk does not cost less at night");

  assert.equal(spendingPermission({ balance: 0, dailyLimit: 10, spentToday: 0 }).interactive, false);
  assert.equal(spendingPermission({ balance: 5, dailyLimit: 10, spentToday: 0 }).autopilot, false, "unattended work stops while money remains");
  assert.equal(spendingPermission({ balance: 500, dailyLimit: 10, spentToday: 0 }).autopilot, true);
  assert.equal(estimateCost({ samples: [] , estimatedMinutes: [10, 30] }).basis, "manifest");
  assert.equal(estimateCost({ samples: [1, 2, 3, 4, 5, 6] }).basis, "history");
});

test("a claim cannot grade itself, and only a reproduced or refuter-tested direct claim leads a digest", async () => {
  const { digestPlacement, tierRaiseAllowed, validateAgendaClaim, directionVerdict } = await import("../index.mjs");
  const selfGraded = validateAgendaClaim({ statement: "x", type: "synthesized", tier: "reproduced", sources: ["a"], provenance: {}, what_would_change: "y" });
  assert.ok(selfGraded.issues.some((issue) => issue.code === "agenda_claim_self_graded"));

  const unfalsifiable = validateAgendaClaim({ statement: "x", type: "derived", tier: "unverified", sources: ["a"], provenance: {} });
  assert.ok(unfalsifiable.issues.some((issue) => issue.code === "agenda_claim_unfalsifiable"));

  const invented = validateAgendaClaim({ statement: "x", type: "direct", tier: "unverified", sources: ["a"], provenance: {}, effect: { measure: "composite-benefit-index" } });
  assert.ok(invented.issues.some((issue) => issue.code === "agenda_effect_measure_unknown"));

  assert.equal(digestPlacement({ tier: "reproduced", type: "derived" }).headline, true);
  assert.equal(digestPlacement({ tier: "gated", type: "direct", refutation: "stands" }).headline, true);
  assert.equal(digestPlacement({ tier: "gated", type: "synthesized", refutation: "stands" }).headline, false);
  assert.equal(digestPlacement({ tier: "unverified", type: "direct" }).headline, false);

  assert.equal(tierRaiseAllowed({ from: "unverified", to: "gated", gatePassed: true }).ok, true);
  assert.equal(tierRaiseAllowed({ from: "unverified", to: "gated", gatePassed: true, refutation: "refuted" }).ok, false);
  assert.equal(tierRaiseAllowed({ from: "unverified", to: "reproduced", reproductionMatched: true }).ok, false);
  assert.equal(tierRaiseAllowed({ from: "gated", to: "reproduced", reproductionMatched: true }).ok, true);

  assert.equal(directionVerdict({ episodesWithoutGatedClaim: 0, consecutiveFailures: 0, daysSinceDigestOpened: 8, userRejected: false }).action, "pause-thread");
  assert.equal(directionVerdict({ episodesWithoutGatedClaim: 3, consecutiveFailures: 0, daysSinceDigestOpened: 0, userRejected: false }).action, "halve");
  assert.equal(directionVerdict({ episodesWithoutGatedClaim: 0, consecutiveFailures: 0, daysSinceDigestOpened: 0, userRejected: false }).action, "run");
});

test("triage picks a depth for a reason it can state, and indexing is complete by construction", async () => {
  const { chooseDepth, indexCompleteness, distillationCompleteness, outputBelowFloor } = await import("../index.mjs");
  const own = chooseDepth({ sourceType: "published-paper-other", authorship: "self", value: {} });
  assert.equal(own.depth, "deep");
  assert.ok(own.reasons.some((reason) => reason.includes("本人")));

  const duplicate = chooseDepth({ sourceType: "published-paper-own", value: {}, duplicateOf: "v1.pdf" });
  assert.equal(duplicate.depth, "skip");

  const thin = chooseDepth({ sourceType: "published-paper-other", value: { knowledgeValue: 0.2 } });
  assert.equal(thin.depth, "index_only");

  assert.deepEqual(
    indexCompleteness([{ unitId: "1", status: "extracted" }, { unitId: "2", status: "indexed_only" }], 3),
    { complete: false, accounted: 2, expected: 3, missing: 1 },
  );
  const audited = distillationCompleteness([{ unitId: "1", answered: true }, { unitId: "2", answered: false }], "deep");
  assert.equal(audited.withinTarget, false, "one miss in two is far above the deep target");
  assert.equal(distillationCompleteness([], "deep").withinTarget, true);

  assert.equal(outputBelowFloor({ sourceType: "published-paper-own", claims: 2 }).suspicious, true);
  assert.equal(outputBelowFloor({ sourceType: "published-paper-own", claims: 7 }).suspicious, false);
  assert.equal(outputBelowFloor({ sourceType: "lecture-slides", slides: 30, slidesCovered: 12 }).suspicious, true);
  assert.equal(outputBelowFloor({ sourceType: "note" }).suspicious, false);
});

// §7.1.1 (decision 2026-08-24 #20): the ledger's own vocabulary has four
// values; these nine are a projection nothing stores. Exhaustive over the
// dimensions `runPhase` actually branches on, with the expected phase stated
// directly from the spec's own table — not re-derived from the function's
// priority order, so this cannot pass by coincidentally mirroring a bug in the
// implementation.
test("runPhase covers every reachable combination of the ledger's own fields", () => {
  const dispatchStatuses = ["dispatching", "accepted", "unknown", "rejected"];
  const bools = [false, true];
  for (const dispatchStatus of dispatchStatuses) {
    for (const hasProgressEvent of bools) {
      for (const turnEnded of bools) {
        for (const awaitingRepairDispatch of bools) {
          const record = { status: "running", dispatchStatus, hasProgressEvent, turnEnded, awaitingRepairDispatch };
          const expected = awaitingRepairDispatch
            ? "repairing"
            : turnEnded
              ? "delivering"
              : hasProgressEvent
                ? "running"
                : dispatchStatus === "accepted"
                  ? "dispatched"
                  : "reserved"; // dispatching, and the unlisted unknown/rejected fall back the same way
          assert.equal(runPhase(/** @type {Parameters<typeof runPhase>[0]} */ (record)), expected, JSON.stringify(record));
        }
      }
    }
  }

  // The fields above default away cleanly: a caller supplying only what
  // today's ledger fold actually produces (no turnEnded/awaitingRepairDispatch
  // — §3.1's richer signal is a later change) reads as the conservative
  // in-progress phases, never as delivering or repairing by accident.
  assert.equal(runPhase({ status: "running", dispatchStatus: "dispatching", hasProgressEvent: false }), "reserved");
  assert.equal(runPhase({ status: "running", dispatchStatus: "accepted", hasProgressEvent: false }), "dispatched");
  assert.equal(runPhase({ status: "running", hasProgressEvent: true }), "running");

  // succeeded: accepted vs. degraded, over every verification value and partial.
  const verifications = [null, "verified", "unverified", "unchecked"];
  for (const verification of verifications) {
    for (const partial of bools) {
      const record = { status: "succeeded", verification, partial, hasProgressEvent: true };
      const degraded = partial || verification === "unverified" || verification === "unchecked";
      assert.equal(runPhase(/** @type {Parameters<typeof runPhase>[0]} */ (record)), degraded ? "degraded" : "accepted", JSON.stringify(record));
    }
  }
  // verification omitted entirely reads the same as null (not yet checked, and
  // not disqualifying) rather than throwing on a caller that has nothing to say.
  assert.equal(runPhase({ status: "succeeded", hasProgressEvent: true }), "accepted");

  // Terminal ledger statuses map straight across, regardless of every other
  // field — a canceled or failed run is not reclassified by stale progress data.
  assert.equal(runPhase({ status: "failed", hasProgressEvent: true, turnEnded: true }), "failed");
  assert.equal(runPhase(/** @type {Parameters<typeof runPhase>[0]} */ ({ status: "canceled", awaitingRepairDispatch: true })), "canceled");

  // Deliberately outside the union: this asserts the throw, so the cast is
  // the point rather than a workaround.
  assert.throws(() => runPhase(/** @type {any} */ ({ status: "bogus", hasProgressEvent: false })), /unknown ledger status/);

  // The projection's own vocabulary is exactly the nine names the table uses,
  // in the order the design doc lists them, and the terminal subset is the
  // four this function can actually return from a settled ledger status.
  assert.deepEqual([...RUN_PHASES], [
    "reserved", "dispatched", "running", "delivering", "repairing",
    "accepted", "degraded", "failed", "canceled",
  ]);
  assert.deepEqual([...TERMINAL_RUN_PHASES], ["accepted", "degraded", "failed", "canceled"]);
  for (const phase of TERMINAL_RUN_PHASES) assert.ok(RUN_PHASES.includes(phase));
});

test("no file in this package opts out of the type check", async () => {
  // `typecheck:domain` gates this package under `strict`, and as of the
  // clinicalEvidence annotation pass nothing is exempt. The check stays because
  // the failure it guards against is a re-run of the same story: an exemption
  // nobody counts is how a staged migration becomes a permanent one — the list
  // grows a file at a time, each addition reasonable, and a year later the
  // check covers nothing. Re-exempting a file is now a visible edit here.
  //
  // tsconfig `exclude` cannot do this job: `index.mjs` imports its siblings, so
  // TypeScript pulls them back in as dependencies and checks them anyway. The
  // marker has to be in the file, which is also where a reader meets it.
  const { readdir } = await import("node:fs/promises");
  const roots = ["src", "test"];
  const exempt = [];
  for (const root of roots) {
    for (const name of await readdir(new URL(`../${root}/`, import.meta.url))) {
      if (!name.endsWith(".mjs")) continue;
      const source = await readFile(new URL(`../${root}/${name}`, import.meta.url), "utf8");
      if (/^\s*\/\/\s*@ts-nocheck\b/m.test(source)) exempt.push(`${root}/${name}`);
    }
  }
  const index = await readFile(new URL("../index.mjs", import.meta.url), "utf8");
  if (/^\s*\/\/\s*@ts-nocheck\b/m.test(index)) exempt.push("index.mjs");
  assert.deepEqual(exempt, [], `a file opted out of the type check: ${exempt.join(", ")}`);
});

test("a safety rule missing what its kind needs is refused at load, not mid-delivery", async () => {
  // The file is data so a pharmacist can edit it without touching server code,
  // which is exactly what makes an omitted `pattern` a realistic mistake. Every
  // branch of the evaluator calls `.test()` on it unconditionally, so before
  // this check such a rule threw the first time a *finished package* was graded
  // — inside a delivery decision, not at startup. Surfaced by typing the file.
  const { compileClinicalSafetyRule, validateLoadedSafetyRules } = await import("../src/clinicalEvidence.mjs");
  if (!validateLoadedSafetyRules) return; // exported only for this check
  assert.throws(
    () => validateLoadedSafetyRules([compileClinicalSafetyRule({ id: "r1", kind: "practical_forbidden", message: "m" })]),
    /rule "r1" is missing pattern/,
  );
  assert.throws(
    () => validateLoadedSafetyRules([compileClinicalSafetyRule({ id: "r2", kind: "practical_required_when_report_matches", message: "m", pattern: "x" })]),
    /rule "r2" is missing triggerPattern/,
  );
  // The rules this build actually ships must pass their own check.
  assert.doesNotThrow(() => validateLoadedSafetyRules(null));
});

test("a research tool is recognised in the spelling each kernel publishes it under", () => {
  // DSH's model-facing name is `mcp__<serverName>__<rawName>` verbatim — the
  // same form OpenCode used, and the first branch already handled it. A
  // previous commit added a bare `evimed__` branch on the belief that DSH
  // published that shape; DSH's own type declarations say otherwise, so the
  // branch is gone. These spellings stay because the parser must keep accepting
  // every form a recorded transcript may carry.
  assert.equal(mcpToolBaseName("mcp__evimed__literature_search"), "literature_search", "the published name");
  assert.equal(mcpToolBaseName("evimed_literature_search"), "literature_search", "the single-underscore spelling");
  assert.equal(mcpToolBaseName("literature_search"), "literature_search", "the bare name");
  assert.equal(mcpToolBaseName("mcp__evimed__not_a_tool"), null, "an unknown name is still unknown in every spelling");
});

test("the open-vocabulary prose patterns are frozen at their current count", async () => {
  // Principle #5, made mechanical: no new open-vocabulary prose regex in this
  // file. `clinicalEvidence.mjs` grew to ~4.9k lines and a few hundred regex
  // literals by answering every register complaint with another word list, and
  // a keyword wall over open language never converges — each addition fixes the
  // instance in front of it and mis-fires on the next phrasing nobody thought
  // of. The judgement belongs to the model-judge path (plan C1); the code keeps
  // the decidable half.
  //
  // The proxy is coarse on purpose: a regex literal carrying CJK is a pattern
  // about Chinese prose. A few of them are closed sets — the 〔推导〕 marker
  // vocabulary, for one — and freezing those costs nothing, because a closed
  // set does not need to grow to stay correct.
  //
  // A rise means a new prose pattern. The alternatives, in order: put a
  // medicine or scenario rule in `clinical-safety-rules.json`, write an eval
  // case (`evals/writing-incidents/`), or hand it to the reviewer. Widening a
  // pattern here is the one thing this test exists to stop.
  //
  // Comments are stripped first. Every scanner written for this repository has
  // had to learn that its own explanation of a pattern reads as the pattern.
  const source = await readFile(new URL("../src/clinicalEvidence.mjs", import.meta.url), "utf8");
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const literals = code.match(/\/(?:[^/\\\n[]|\\.|\[(?:[^\]\\]|\\.)*\])+\/[gimsuyv]*/g) ?? [];
  // The walk has to prove it walked: a regex that stops matching literals would
  // otherwise report zero prose patterns and pass forever.
  assert.ok(literals.length > 200, `only ${literals.length} regex literals found — the scan did not read the file`);

  const prose = literals.filter((literal) => /[\u4e00-\u9fff]/.test(literal));
  assert.equal(
    prose.length,
    117,
    `open-vocabulary prose patterns moved from 117 to ${prose.length}. `
      + "Adding one is frozen (principle #5): put medicine/scenario rules in clinical-safety-rules.json, "
      + "write an eval case, or hand the judgement to the reviewer. "
      + "Removing them is the direction of travel — lower this number and say which rule moved where.",
  );
});

test("a submission the gate could not read is not a submission that was judged", async () => {
  // The late avalanche. Two runs spent seven submissions each on the trajectory
  // 8 → 13 → 1 → 83 → 7 → 13 → 2, and the 83 arrived the moment the matrix
  // schema was finally right: every content rule ran for the first time and
  // reported at once. That report was correct. What was wrong is that the four
  // submissions before it — which the gate could not evaluate at all — had
  // already spent more than half the budget on learning the contract.
  const { unreadableSubmission } = await import("../index.mjs");

  /** @param {string} code @param {string} message @returns {any} */
  const required = (code, message) => ({ code, message, severity: "required" });
  assert.equal(
    unreadableSubmission({ issues: [required("required_output_missing", "citation-ledger.csv is missing.")] }),
    true,
    "an absent required file is the gate unable to read the package",
  );
  assert.equal(
    unreadableSubmission({
      issues: [required("clinical_evidence_issue", "clinical-evidence-matrix.json uses a different claim shape from the contract's.")],
    }),
    true,
    "a matrix in another schema is the same fact reported in prose",
  );

  // Negative controls — the three ways this could give away the budget.
  // 1. A content rejection is what the budget is FOR.
  assert.equal(
    unreadableSubmission({
      issues: [required("clinical_evidence_issue", "claims[0].supportQuote was not found in its preserved source artifact.")],
    }),
    false,
  );
  // 2. Mixed is judged: the gate read enough to say something about the work,
  //    so the attempt bought a content answer and must be charged for one.
  assert.equal(
    unreadableSubmission({
      issues: [
        required("required_output_missing", "references.bib is missing."),
        required("clinical_evidence_issue", "claims[0].supportQuote was not found in its preserved source artifact."),
      ],
    }),
    false,
    "one readable finding makes the submission a judged one",
  );
  // 3. An accepted package is not an unreadable one.
  assert.equal(unreadableSubmission({ issues: [] }), false);
  assert.equal(unreadableSubmission({ issues: [{ code: "x", message: "y", severity: "advisory" }] }), false);
});

test("citing a retracted paper is reported, and not looking is not the same as finding nothing", async () => {
  // Plan F1. Retraction Watch has been Crossref's since 2023-09 — free, daily,
  // and both hosts are already on the gateway allowlist — so this is a closed-
  // set comparison between the identifiers a package cites and a list of
  // retracted ones. Notice first (principle #4, six blocking points), because a
  // real distribution has to exist before anything blocks on it.
  const { citedIdentifiers, retractionNotices } = await import("../index.mjs");

  const pkg = {
    referencesText: "[1] Someone A, et al. A trial. J Test. 2019. https://doi.org/10.1000/Retracted.1\n"
      + "[2] Другой B. Another. 2021. PMID: 34281600\n",
    citationLedgerText: "ref,identifier\n3,PMC8287819\n",
    matrix: { claims: [{ identifier: "10.1000/kept.2", artifactPath: ".evimed-sources/PMC5892298/fulltext.md" }] },
  };

  // Read from wherever the package names them: a claim can carry an identifier
  // the prose never prints, and the question is what the work rests on.
  const cited = citedIdentifiers(pkg);
  assert.ok(cited.dois.includes("10.1000/retracted.1"), `DOIs: ${cited.dois}`);
  assert.ok(cited.dois.includes("10.1000/kept.2"), "an identifier that appears only in the matrix still counts");
  assert.ok(cited.pmids.includes("34281600"), `PMIDs: ${cited.pmids}`);
  assert.ok(cited.pmcids.includes("8287819") && cited.pmcids.includes("5892298"), `PMCIDs: ${cited.pmcids}`);

  const notices = retractionNotices(pkg, [
    { doi: "10.1000/RETRACTED.1", title: "A trial", retractionDate: "2024-02-01" },
  ]);
  assert.equal(notices.length, 1, `expected one hit: ${notices}`);
  assert.match(notices[0], /已撤稿/);
  assert.match(notices[0], /2024-02-01/);

  // Negative controls.
  // 1. A clean package earns no notice — the check must not fire on everything.
  assert.deepEqual(retractionNotices(pkg, [{ doi: "10.9999/unrelated" }]), []);
  // 2. Not looking is its own answer. An absent list used to be indistinguishable
  //    from a clean result, which is the empty-is-not-error shape this codebase
  //    keeps meeting; here it would let a run say "no retracted sources" having
  //    never checked.
  const unchecked = retractionNotices(pkg, null);
  assert.equal(unchecked.length, 1);
  assert.match(unchecked[0], /未执行/);
  // 3. A package citing nothing has nothing to check, and that is silence.
  assert.deepEqual(retractionNotices({}, []), []);
});
