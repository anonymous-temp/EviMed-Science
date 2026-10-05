import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEvaluationIsolation } from "../src/evaluationIsolation.mjs";
const policy = { aliases: ["10.1234/target", "PMID:123", "PMC123", "arxiv:2401.00001"], titles: ["Target published clinical paper"], cutoff: "2020-12-31" };
test("evaluation policy removes nested target aliases, title and post-cutoff rows without changing ordinary traffic", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "evaluation-"));
  try {
    const isolation = createEvaluationIsolation({ dataDir });
    await isolation.register("run", policy);
    const value = { nested: { results: [{ doi: "https://doi.org/10.1234/TARGET" }, { title: "Target Published Clinical Paper!" }, { pmcid: "PMC123" }, { date: "2021-01-01" }, { title: "Unrelated study", date: "2019-01-01" }] } };
    assert.deepEqual(await isolation.filter({ runId: "ordinary" }, "test", value), value);
    assert.deepEqual(await isolation.filter({ runId: "run" }, "test", value), { nested: { results: [{ title: "Unrelated study", date: "2019-01-01" }] } });
    await assert.rejects(isolation.assertRequest({ runId: "run" }, "web-read", "https://doi.org/10.1234/target"), { code: "evaluation_source_excluded" });
    assert.equal((await isolation.audit("run")).events.length, 5);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
test("intentionally unblocked target is detected as exposure, then citation", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "evaluation-"));
  try {
    const isolation = createEvaluationIsolation({ dataDir });
    await isolation.register("run", policy);
    assert.equal(await isolation.auditExposure({ runId: "run" }, "deliberate-leak", { text: "10.1234/target" }), true);
    assert.equal((await isolation.audit("run")).tier, "exposed_uncited");
    await isolation.recordCitations("run", "[1] doi:10.1234/target");
    assert.equal((await isolation.audit("run")).tier, "cited");
    const restarted = createEvaluationIsolation({ dataDir });
    assert.equal((await restarted.audit("run")).tier, "cited");
    await restarted.register("run", policy);
    await assert.rejects(restarted.register("run", { ...policy, aliases: [] }), /immutable/);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
test("PubMed XML cutoff selectively removes future and undated records", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "evaluation-"));
  try {
    const isolation = createEvaluationIsolation({ dataDir });
    await isolation.register("run", policy);
    const xml = '<PubmedArticleSet><PubmedArticle><PMID>456</PMID><PubDate><Year>2019</Year></PubDate></PubmedArticle><PubmedArticle><PMID>789</PMID><PubDate><Year>2022</Year></PubDate></PubmedArticle><PubmedArticle><PMID>321</PMID></PubmedArticle></PubmedArticleSet>';
    const filtered = await isolation.filterRaw({ runId: "run" }, "public-source", xml, "application/xml");
    assert.match(filtered, /456/);
    assert.doesNotMatch(filtered, /789|321/);
    await assert.rejects(isolation.filterRaw({ runId: "run" }, "public-source", "undated web prose", "text/plain"), { code: "evaluation_source_excluded" });
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
test("registered project policy protects requests before and during run binding", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "evaluation-"));
  try {
    const isolation = createEvaluationIsolation({ dataDir });
    const identity = { userId: "operator", projectId: "eval-paper-unit" };
    await isolation.registerPending(identity, policy);
    assert.equal(await isolation.isEvaluation({ ...identity, runId: "not-bound-yet" }), true);
    const restarted = createEvaluationIsolation({ dataDir });
    await restarted.bindRun(identity, "bound");
    await restarted.bindRun(identity, "bound");
    assert.equal(await isolation.isEvaluation({ ...identity, runId: "bound" }), true);
    await assert.rejects(isolation.registerPending({ ...identity, projectId: "customer" }, policy), /dedicated/);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("structured undated bibliographic results cannot bypass a frozen cutoff", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "evaluation-"));
  try {
    const isolation = createEvaluationIsolation({ dataDir });
    await isolation.register("run", policy);
    assert.deepEqual(await isolation.filter({ runId: "run" }, "search", { results: [{ title: "Undated hit" }, { title: "Dated hit", published: { "date-parts": [[2019, 1, 2]] } }] }), { results: [{ title: "Dated hit", published: { "date-parts": [[2019, 1, 2]] } }] });
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("encoded MCP text JSON and XML cannot bypass cutoff filtering", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "evaluation-"));
  try {
    const isolation = createEvaluationIsolation({ dataDir });
    await isolation.register("run", policy);
    const result = await isolation.filter({ runId: "run" }, "tooluniverse", { content: [{ type: "text", text: JSON.stringify({ results: [{ title: "Future", year: "2025" }, { title: "Known old", year: "2019" }] }) }, { type: "text", text: "<PubmedArticleSet><PubmedArticle><PMID>456</PMID><PubDate><Year>2019</Year></PubDate></PubmedArticle><PubmedArticle><PMID>987</PMID><PubDate><Year>2025</Year></PubDate></PubmedArticle></PubmedArticleSet>" }] });
    assert.deepEqual(JSON.parse(result.content[0].text), { results: [{ title: "Known old", year: "2019" }] });
    assert.doesNotMatch(result.content[1].text, /987/);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('identity-only gateway events bind durably to one exact run and retain pending provenance', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'eval-attribution-'));
  const identity = { userId: 'owner', projectId: 'eval-paper-attribution' }, policy = { aliases: ['10.1234/target'], titles: [] };
  try {
    const isolated = createEvaluationIsolation({ dataDir, resolveRunId: () => null });
    const pendingId = await isolated.registerPending(identity, policy);
    await assert.rejects(isolated.assertRequest(identity, 'web_read', '10.1234/target'));
    await isolated.bindRun(identity, 'actual-run');
    await assert.rejects(isolated.assertRequest(identity, 'web_read', '10.1234/target'));
    const restarted = createEvaluationIsolation({ dataDir, resolveRunId: () => null });
    await assert.rejects(restarted.assertRequest(identity, 'web_read', '10.1234/target'));
    const audit = await restarted.audit('actual-run');
    assert.equal(audit.events.length, 3);
    assert.equal(audit.events[0].runId, pendingId);
    assert.equal(audit.events[0].attributedRunId, 'actual-run');
    assert.equal(audit.events[1].runId, 'actual-run');
    assert.equal(audit.events[2].runId, 'actual-run');
    await assert.rejects(restarted.bindRun(identity, 'different-run'), /immutable/);
    assert.equal((await restarted.audit('unrelated')).events.length, 0);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

// The gateways ask this module on every request of every tenant (review of 「循证进化」, 2026-10-05, B2/F3).
// What it may do to a request that is not an evaluation's: nothing, and that includes failing it.
const tenant = { userId: "researcher", projectId: "my-study" };
const results = { results: [{ doi: "https://doi.org/10.1234/TARGET", title: "Target Published Clinical Paper!" }, { title: "Unrelated" }] };

test("an ordinary researcher's request is never looked up, filtered or failed, whatever state this module's store is in", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "evaluation-"));
  try {
    // The store's directory cannot be read (here: it is a file) and the run ledger cannot be parsed.
    await writeFile(path.join(dataDir, "evaluation-isolation"), "not a directory");
    let lookups = 0;
    const failures = [];
    const isolation = createEvaluationIsolation({ dataDir, resolveRunId: async () => { lookups += 1; throw new Error("agent_runs_corrupt"); }, reportFailure: code => failures.push(code) });
    assert.deepEqual(await isolation.filter(tenant, "web-search", results), results);
    assert.equal(await isolation.filterRaw(tenant, "public-source", "<xml/>", "application/xml"), "<xml/>");
    assert.equal(await isolation.isEvaluation(tenant), false);
    assert.equal(await isolation.assertRequest(tenant, "web-read", "https://doi.org/10.1234/target"), undefined);
    assert.equal(await isolation.auditExposure(tenant, "web-read", "10.1234/target"), false);
    assert.equal(lookups, 0, "no run lookup: the ledger is not this module's to read for an ordinary project");
    assert.deepEqual(failures, []);
    assert.deepEqual({ ...isolation.counters }, { runLookupFailed: 0, platformLookupFailed: 0, refused: 0, recalled: 0 });
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("an evaluation run whose policy cannot be read is refused by name, counted, and its project's scope still applies when the run is unknown", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "evaluation-"));
  try {
    const failures = [];
    const evaluating = { userId: "operator", projectId: "eval-paper-unit" };
    const isolation = createEvaluationIsolation({ dataDir, resolveRunId: async () => { throw new Error("agent_runs_corrupt"); }, reportFailure: code => failures.push(code) });
    await isolation.registerPending(evaluating, { aliases: policy.aliases, titles: policy.titles });
    // The run ledger is unreadable: the pending project scope answers, so nothing leaks.
    assert.equal(await isolation.isEvaluation(evaluating), true);
    assert.deepEqual(await isolation.filter(evaluating, "web-search", results), { results: [{ title: "Unrelated" }] });
    assert.equal(isolation.counters.runLookupFailed > 0, true);
    // A restart finds the directory unreadable: an evaluation request is refused, not served unfiltered.
    await rm(path.join(dataDir, "evaluation-isolation"), { recursive: true, force: true });
    await writeFile(path.join(dataDir, "evaluation-isolation"), "not a directory");
    const restarted = createEvaluationIsolation({ dataDir, resolveRunId: async () => "run-1", reportFailure: code => failures.push(code) });
    await assert.rejects(restarted.filter(evaluating, "web-search", results), { status: 503, code: "evaluation_policy_unreadable" });
    await assert.rejects(restarted.assertRequest(evaluating, "web-read", "x"), { code: "evaluation_policy_unreadable" });
    assert.equal(restarted.counters.refused, 2);
    assert.ok(failures.includes("evaluation_policy_unreadable") && failures.includes("evaluation_run_lookup_failed"));
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("a run of the evolution module's own other projects is not an evaluation: a lookup problem there is counted and ignored", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "evaluation-"));
  try {
    await writeFile(path.join(dataDir, "evaluation-isolation"), "not a directory");
    const isolation = createEvaluationIsolation({ dataDir, resolveRunId: async () => "scout-run" });
    for (const projectId of ["evimed-evolution", "evolution-eval-replay"]) {
      assert.deepEqual(await isolation.filter({ userId: "operator", projectId }, "web-search", results), results, projectId);
    }
    assert.equal(isolation.counters.platformLookupFailed, 2);
    assert.equal(isolation.counters.refused, 0);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("with the module off the layer is not composed at all, so no gateway has it in its path", async () => {
  const { createWebApiApp } = await import("../src/server.mjs");
  for (const [evolutionEnabled, expected] of [[false, "null"], [true, "object"]]) {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "evaluation-composition-"));
    const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: true, runTitlesEnabled: false, evolutionEnabled });
    await app.listen(0, "127.0.0.1");
    try {
      assert.equal(app.evaluationIsolation === null ? "null" : typeof app.evaluationIsolation, expected, `evolutionEnabled=${evolutionEnabled}`);
    } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
  }
});

// Live acceptance of 2026-10-05 (release 90e0869f2): every gateway request of a bound evaluation run was refused 503
// `evaluation_policy_unreadable`, so the blocked isolation control recorded no exclusion event and a builder could
// read no source. The run's bounded runtime authenticates with a token whose `runId` is the dispatch id
// (`reserveBoundedRuntimeSession({ runId: dispatchId })`), while the project is bound to the run ledger's id; the
// "bound to another run" rule compared the two id spaces. One run, two names: both are the bound run, and any third
// id is still another run.
test("a bound evaluation run is known by its ledger id and by the dispatch id its bounded runtime's token carries", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "evaluation-"));
  try {
    const failures = [];
    // As server.mjs composes it: the token's run id when it has one, else the run attributed from the ledger.
    const attributed = { value: null };
    const isolation = createEvaluationIsolation({ dataDir, resolveRunId: identity => identity.runId ?? attributed.value, reportFailure: code => failures.push(code) });
    const project = { userId: "operator", projectId: "eval-paper-isolation-live-blocked" };
    await isolation.registerPending(project, { aliases: policy.aliases, titles: policy.titles });
    await isolation.bindRun(project, "run_ledger", { dispatchId: "evolution_isolation_live_blocked" });
    const bounded = { ...project, runId: "evolution_isolation_live_blocked" };
    await assert.rejects(isolation.assertRequest(bounded, "public-source", { url: "https://doi.org/10.1234/target" }), { status: 403, code: "evaluation_source_excluded" });
    assert.deepEqual(await isolation.filter(bounded, "web-search", results), { results: [{ title: "Unrelated" }] });
    // A workload-token request carries no run id; the ledger attributes it to the same run.
    attributed.value = "run_ledger";
    await assert.rejects(isolation.assertRequest(project, "tooluniverse", "PMID:123"), { status: 403, code: "evaluation_source_excluded" });
    const audit = await isolation.audit("run_ledger");
    assert.deepEqual(audit.events.map(event => [event.runId, event.tier]), [["run_ledger", "blocked"], ["run_ledger", "blocked"], ["run_ledger", "blocked"]]);
    assert.deepEqual(failures, []);
    // Any other run id in this project is still another run: refused by name, never served unfiltered.
    await assert.rejects(isolation.assertRequest({ ...project, runId: "evolution_other" }, "public-source", { url: "https://example.org" }), { status: 503, code: "evaluation_policy_unreadable" });
    // The binding is immutable in both names, and survives a restart.
    await isolation.bindRun(project, "run_ledger", { dispatchId: "evolution_isolation_live_blocked" });
    await assert.rejects(isolation.bindRun(project, "run_ledger", { dispatchId: "evolution_other" }), /immutable/);
    const restarted = createEvaluationIsolation({ dataDir, resolveRunId: identity => identity.runId ?? null });
    await assert.rejects(restarted.assertRequest(bounded, "web-read", "https://pmc.ncbi.nlm.nih.gov/articles/PMC123/"), { status: 403, code: "evaluation_source_excluded" });
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

// Ruling of 2026-10-05, after two builder runs of the live acceptance wrote the method paper's DOI in their own
// reasoning and parked their branches: what a model names from its own memory is not something the platform served,
// and no isolation can remove it. It is its own tier, `recalled`: recorded with where it was said, counted, and not an
// exposure. What disqualifies is unchanged: anything the run was handed or got back that matches the target
// (`exposed`), a deliverable that cites it (`cited`); a gateway's `blocked` event stays what it was.
const development = { userId: "operator", projectId: "eval-paper-build-recall" };
const targetPolicy = { aliases: ["10.1136/bmj.i6", "PMID:26810254"], titles: ["Net benefit approaches to the evaluation of prediction models"] };
const voices = (parts, tool = null) => ({
  served: { header: { completeness: "complete" }, messages: [{ role: "user", parts: [{ type: "text", text: "Implement the method from the card." }] }, ...(tool ? [{ role: "assistant", parts: [tool] }] : [])] },
  own: parts.map((text, index) => ({ step: { message: 2 + index, part: 0, voice: index ? "reply" : "reasoning" }, text })),
});

test("a target the model names from its own memory is recalled: recorded with its step, counted once, and not an exposure", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "evaluation-"));
  try {
    const isolation = createEvaluationIsolation({ dataDir });
    const run = { ...development, runId: "run_recall" };
    await isolation.register(run.runId, targetPolicy);
    const heard = await isolation.auditTranscript(run, "builder-transcript", voices(["Background: Vickers et al., BMJ 2016;352:i6, doi:10.1136/bmj.i6. Let me not over-cite.", "Done."]));
    assert.deepEqual(heard, { tier: "recalled", reason: "identifier", step: { message: 2, part: 0, voice: "reasoning" } });
    const audit = await isolation.audit(run.runId);
    assert.equal(audit.tier, "recalled");
    assert.deepEqual(audit.events.map(event => [event.gateway, event.tier, event.reason, event.step]), [["builder-transcript", "recalled", "identifier", { message: 2, part: 0, voice: "reasoning" }]]);
    assert.equal(isolation.counters.recalled, 1);
    // The same run is audited again for every later candidate of its branch: one finding, not one per audit.
    await isolation.auditTranscript(run, "builder-transcript", voices(["doi:10.1136/bmj.i6"]));
    assert.equal((await isolation.audit(run.runId)).events.length, 1); assert.equal(isolation.counters.recalled, 1);
    // A registered title is matched as the policy matches it everywhere else; nothing else in open language is.
    const titled = { ...development, runId: "run_recall_title" };
    await isolation.register(titled.runId, targetPolicy);
    assert.equal((await isolation.auditTranscript(titled, "builder-transcript", voices(["The tutorial 'Net benefit approaches to the evaluation of prediction models' defines it."]))).tier, "recalled");
    // Authors, a journal and a topic are open language: only the policy's identifiers and registered titles are matched.
    const clean = { ...development, runId: "run_clean" };
    await isolation.register(clean.runId, targetPolicy);
    assert.deepEqual(await isolation.auditTranscript(clean, "builder-transcript", voices(["A famous BMJ tutorial by Vickers and colleagues defines net benefit."])), { tier: "unexposed" });
    assert.equal((await isolation.audit(clean.runId)).events.length, 0);
    // An ordinary project is never asked, as everywhere in this module.
    assert.deepEqual(await isolation.auditTranscript({ userId: "researcher", projectId: "my-study", runId: run.runId }, "builder-transcript", voices(["doi:10.1136/bmj.i6"])), { tier: "unexposed" });
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("what the run was handed or got back still exposes it, a cited deliverable is still cited, and a mention beside a matched source event is not a recall", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "evaluation-"));
  try {
    const isolation = createEvaluationIsolation({ dataDir });
    // Served: a tool result carried the target. The model's own later mention changes nothing.
    const served = { ...development, runId: "run_served" };
    await isolation.register(served.runId, targetPolicy);
    const heard = await isolation.auditTranscript(served, "builder-transcript", voices(["It says doi:10.1136/bmj.i6."], { type: "tool", tool: "mcp__evimed__web_read", status: "completed", output: "{\"status\":\"ok\",\"data\":{\"doi\":\"10.1136/bmj.i6\"}}" }));
    assert.equal(heard.tier, "exposed");
    assert.equal((await isolation.audit(served.runId)).tier, "exposed_uncited");
    // Cited: the deliverable names it; the recall beside it does not soften that.
    const cited = { ...development, runId: "run_cited" };
    await isolation.register(cited.runId, targetPolicy);
    await isolation.recordCitations(cited.runId, { artifacts: ["deliverables/tool-candidate/tool-candidate.json"], reply: "Implemented after doi:10.1136/bmj.i6." });
    await isolation.auditTranscript(cited, "builder-transcript", voices(["I will cite doi:10.1136/bmj.i6."]));
    assert.equal((await isolation.audit(cited.runId)).tier, "cited");
    // Blocked: a gateway matched the target for this run (here its own request named it). The event stays `blocked`,
    // and a mention beside a matched source event is classified as it always was.
    const asked = { ...development, runId: "run_asked" };
    await isolation.register(asked.runId, targetPolicy);
    await assert.rejects(isolation.assertRequest(asked, "public-source", { url: "https://doi.org/10.1136/bmj.i6" }), { code: "evaluation_source_excluded" });
    assert.equal((await isolation.auditTranscript(asked, "builder-transcript", voices(["Let me fetch doi:10.1136/bmj.i6."]))).tier, "exposed");
    assert.deepEqual((await isolation.audit(asked.runId)).events.map(event => event.tier), ["blocked", "exposed"]);
    assert.equal(isolation.counters.recalled, 0);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
