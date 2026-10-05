// The platform's evidence programme, the card's half (evidence-flywheel plan §5.1, F02): a finished episode whose claims were verified by
// the run and not refuted or weakened by the independent check becomes a card in the official zone; nothing else does. Real PostgreSQL,
// the real autopilot service folding real episodes; the result store's reads are the one double.
import assert from "node:assert/strict";
import test from "node:test";
import { claimVerification } from "@evimed/domain/clinical-evidence";
import { EVIDENCE_PROJECT_ID, PLATFORM_PUBLISHER_USER_ID, modelAnswer, programmeFixture, sha256 } from "./helpers/evidenceProgrammeFixture.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
const PUBLISHER = PLATFORM_PUBLISHER_USER_ID;
const project = { userId: PUBLISHER, id: EVIDENCE_PROJECT_ID };

const SOURCE_A = { path: ".evimed-sources/a1/osimertinib.txt", title: "FLAURA", url: "https://doi.org/10.1056/NEJMoa1713137", access: "full_text",
  text: "In FLAURA, osimertinib improved median progression-free survival to 18.9 months versus 10.2 months with standard EGFR tyrosine kinase inhibitors in previously untreated EGFR mutation-positive advanced non-small cell lung cancer." };
const SOURCE_B = { path: ".evimed-sources/b2/adaura.txt", title: "ADAURA", url: "https://doi.org/10.1056/NEJMoa2027071", access: "abstract",
  text: "In ADAURA, adjuvant osimertinib significantly improved disease-free survival compared with placebo in stage IB to IIIA EGFR mutation-positive non-small cell lung cancer after complete resection." };
const SOURCE_C = { path: ".evimed-sources/c3/other.txt", title: "Other", url: "https://doi.org/10.1000/other", access: "full_text",
  text: "A third source whose text supports a statement that the independent check later refuted." };
const claim = (id, source, quote, over = {}) => ({ claimId: id, claimType: "direct", claim: `${id}：${source.title} 的结论。`, applicability: "EGFR 突变阳性晚期患者", uncertainty: "开放标签设计。",
  sourceUrl: source.url, sourceTitle: source.title, artifactPath: source.path, accessLevel: source.access, supportQuote: quote, ...over });
const QUOTE_A = "osimertinib improved median progression-free survival to 18.9 months versus 10.2 months";
const QUOTE_B = "adjuvant osimertinib significantly improved disease-free survival compared with placebo";
const QUOTE_C = "supports a statement that the independent check later refuted";

/** The agenda-delta claim for a matrix claim of the same id (the standing prompt asks for exactly this). @param {string} id @param {Record<string, any>} [over] */
const agendaClaim = (id, over = {}) => ({ id, statement: `${id} statement`, type: "direct", tier: "unverified", sources: ["10.1056/NEJMoa1713137"], provenance: { episodeId: "", artifact: "deliverables/d1/clinical-evidence-report.md" }, ...over });

let counter = 0;
/**
 * Make the episode a decision chose, run it to its fold and leave its result where the programme reads it.
 * @param {any} fx @param {{ day: string, zone: string, taskType: string, matrixClaims: any[], sources: any[], agendaClaims: any[], machineValues?: any[], matrix?: boolean }} spec
 */
async function episodeOf(fx, { day, zone, taskType, matrixClaims, sources, agendaClaims, machineValues = [], matrix = true }) {
  fx.state.model = async () => modelAnswer({ actions: [{ zone, taskType, reason: "有新证据" }], reason: "测试" });
  const decision = await fx.programme.runDay(day);
  const action = decision.decision.actions.find((entry) => entry.zone === zone);
  assert.equal(action.status, "scheduled", JSON.stringify(action));
  return foldEpisode(fx, { action, matrixClaims, sources, agendaClaims, machineValues, matrix });
}

async function foldEpisode(fx, { action, matrixClaims, sources, agendaClaims, machineValues = [], matrix = true }) {
  counter += 1;
  const runId = `run_card_${counter}`;
  const episodeId = action.episodeId;
  await fx.autopilot.markEpisodeDispatched(PUBLISHER, episodeId, { runId, sessionId: `ses_card_${counter}` });
  if (matrix) {
    const matrixDoc = { claims: matrixClaims };
    const verification = claimVerification({ matrix: matrixDoc, sourceArtifacts: Object.fromEntries(sources.map((source) => [source.path, source.text])) });
    const versionId = `rv_${sha256(`matrix-${counter}`)}`;
    const inputs = sources.map((source, index) => {
      const sourceVersion = `rv_${sha256(`${source.path}-${counter}`)}`;
      fx.rawByVersion.set(sourceVersion, { bytes: Buffer.from(source.text), digest: sha256(source.text), capturedAt: "2026-10-05T00:30:00.000Z" });
      return { kind: "source", id: source.path, path: source.path, digest: sha256(source.text), versionId: sourceVersion, availability: "captured", index };
    });
    fx.resultsByRun.set(runId, [{ path: "deliverables/d1/clinical-evidence-matrix.json", versionId, digest: sha256(JSON.stringify(matrixDoc)), machineValues,
      review: { status: "available", matrixText: JSON.stringify(matrixDoc), verification, matrixVersionId: versionId, matrixDigest: sha256(JSON.stringify(matrixDoc)) }, inputs }]);
  } else fx.resultsByRun.set(runId, []);
  await fx.autopilot.completeRun(PUBLISHER, {
    projectId: EVIDENCE_PROJECT_ID, runId, episodeId, sessionId: `ses_card_${counter}`, status: "succeeded", artifacts: ["deliverables/d1/clinical-evidence-report.md"],
    deltaSchemaVersion: 1, costCny: 2, claims: agendaClaims.map((entry) => ({ ...entry, provenance: { ...entry.provenance, episodeId } })),
  });
  return { runId, episodeId, agendaId: action.agendaId };
}

/** Record the independent check of each claim: `verdicts` maps a claim id to `stands`, `refuted` or `weakened`. */
async function verify(fx, { runId, episodeId }, verdicts) {
  const episode = await fx.autopilot.getEpisode(PUBLISHER, episodeId);
  for (const [claimId, verdict] of Object.entries(verdicts)) {
    const found = episode.payload.claims.find((entry) => entry.id === claimId);
    await fx.autopilot.recordVerification(PUBLISHER, { episodeId, verificationId: found.verification.id, runId: `v_${runId}_${claimId}`, verdict, isolated: true, checkedSources: [] });
  }
}

const cardsOf = async (fx, zoneTitle) => (await fx.database.query(`SELECT c.* FROM evimed_frontier.evidence_cards c JOIN evimed_frontier.evidence_zones z ON z.id=c.zone_id WHERE z.title=$1 ORDER BY c.created_at, c.id`, [zoneTitle])).rows;
const outcomeOf = async (fx, day, episodeId) => (await fx.documents.get(PUBLISHER, "programme-decision", `programme-decision-${day}`)).payload.outcomes[episodeId];

async function setup(label, config = {}) {
  const state = { model: async () => modelAnswer({ actions: [], reason: "x" }) };
  const fx = await programmeFixture({ url, label, config, callModel: (deps, call) => state.model(deps, call) });
  fx.state = state;
  await fx.programme.ensureOfficialZones();
  return fx;
}

test("a finished episode with verified, standing claims writes one card in the official zone with its lineage and claims, and a second run of the topic revises it in place", options, async () => {
  const fx = await setup("cardone");
  try {
    const first = await episodeOf(fx, { day: "2026-10-05", zone: "nsclc", taskType: "evidence-update", sources: [SOURCE_A, SOURCE_B],
      matrixClaims: [claim("CLM-001", SOURCE_A, QUOTE_A), claim("CLM-002", SOURCE_B, QUOTE_B)],
      agendaClaims: [agendaClaim("CLM-001"), agendaClaim("CLM-002")] });
    // Until the independent checks are in, there is nothing to publish and nothing is refused.
    assert.equal((await fx.programme.onRunFinished(project, { id: first.runId })).state, "pending_verification");
    assert.equal((await cardsOf(fx, "非小细胞肺癌")).length, 0);
    await verify(fx, first, { "CLM-001": "stands" });
    assert.equal((await fx.programme.onRunFinished(project, { id: first.runId })).state, "pending_verification", "one check is still out");
    await verify(fx, first, { "CLM-002": "stands" });
    const settled = await fx.programme.onRunFinished(project, { id: first.runId });
    assert.equal(settled.state, "published");

    const cards = await cardsOf(fx, "非小细胞肺癌");
    assert.equal(cards.length, 1);
    const [card] = cards;
    assert.equal(card.id, settled.cardId);
    assert.equal(card.user_id, PUBLISHER, "the platform's own card");
    assert.equal(card.state, "published");
    assert.equal(card.originality, "synthesis");
    assert.equal(card.producer.kind, "platform");
    assert.equal(card.producer.name, "EviMed 证据中心");
    assert.deepEqual(card.claims.map((entry) => entry.claimId), ["CLM-001", "CLM-002"]);
    assert.equal(card.lineage.agendaId, first.agendaId);
    assert.equal(card.lineage.episodeId, first.episodeId);
    assert.equal(card.lineage.runId, first.runId);
    assert.match(card.lineage.resultVersionId, /^rv_[a-f0-9]{64}$/);
    assert.equal(card.editorial, null, "the zone's own AI upkeep does not adopt a card the programme keeps");
    assert.equal(card.disclosure.model, "deepseek-flash");
    assert.ok(card.disclosure.aiSteps.includes("review"), "the independent re-check ran");
    assert.deepEqual(card.sources.map((source) => source.title), ["FLAURA", "ADAURA"]);
    assert.equal(card.sources[0].documentText, SOURCE_A.text, "the preserved text of the source the run captured");
    assert.equal(card.sources[0].fetchedSha256, sha256(SOURCE_A.text));
    assert.equal(card.sources[0].coverage, "full-text");
    assert.equal(card.content.answer, "CLM-001：FLAURA 的结论。", "the first sentence is a claim that stood");
    assert.deepEqual(card.entity_keys.filter((key) => key.startsWith("disease:")), ["disease:non-small cell lung cancer"], "tagged with the shared vocabulary");
    const read = await fx.zones.detail(fx.publisherUser, card.zone_id, card.id);
    assert.equal(read.evidence.claimVerification.verified, 2, "a reader sees both claims ✓");
    assert.equal(read.evidence.claims.every((entry) => entry.verification.mark === "✓"), true);
    const recorded = await outcomeOf(fx, "2026-10-05", first.episodeId);
    assert.deepEqual([recorded.outcome, recorded.cardId, recorded.revision, recorded.claims], ["published", card.id, 1, 2]);

    // The same topic again, the next day: the card is revised, not made twice.
    const second = await episodeOf(fx, { day: "2026-10-06", zone: "nsclc", taskType: "evidence-update", sources: [SOURCE_A],
      matrixClaims: [claim("CLM-001", SOURCE_A, QUOTE_A)], agendaClaims: [agendaClaim("CLM-001")] });
    await verify(fx, second, { "CLM-001": "stands" });
    const revised = await fx.programme.onRunFinished(project, { id: second.runId });
    assert.equal(revised.state, "revised");
    const after = await cardsOf(fx, "非小细胞肺癌");
    assert.equal(after.length, 1, "one card for the agenda's question");
    assert.equal(after[0].id, card.id);
    assert.equal(after[0].revision, 2);
    assert.equal(after[0].lineage.episodeId, second.episodeId, "its lineage is the run that made this revision");
    assert.deepEqual(after[0].claims.map((entry) => entry.claimId), ["CLM-001"]);
    assert.equal((await fx.database.query("SELECT count(*)::int AS n FROM evimed_frontier.evidence_card_revisions WHERE card_id=$1", [card.id])).rows[0].n, 2, "and the first revision is kept");
    // Settling again changes nothing: the outcome is final.
    assert.equal((await fx.programme.settleEpisode(second.episodeId)).state, "revised");
    assert.equal((await cardsOf(fx, "非小细胞肺癌"))[0].revision, 2);
    assert.deepEqual(fx.programme.status().counters.cards.published, 1);
  } finally { await fx.close(); }
});

test("a refuted claim and a claim the run could not verify never reach a card; the rest of the episode still does", options, async () => {
  const fx = await setup("cardrefuted");
  try {
    const run = await episodeOf(fx, { day: "2026-10-05", zone: "nsclc", taskType: "evidence-update", sources: [SOURCE_A, SOURCE_B, SOURCE_C],
      matrixClaims: [claim("CLM-001", SOURCE_A, QUOTE_A), claim("CLM-002", SOURCE_C, QUOTE_C), claim("CLM-003", SOURCE_B, "this passage is not in the source at all")],
      agendaClaims: [agendaClaim("CLM-001"), agendaClaim("CLM-002")] });
    await verify(fx, run, { "CLM-001": "stands", "CLM-002": "refuted" });
    const result = await fx.programme.onRunFinished(project, { id: run.runId });
    assert.equal(result.state, "published");
    const [card] = await cardsOf(fx, "非小细胞肺癌");
    assert.deepEqual(card.claims.map((entry) => entry.claimId), ["CLM-001"], "refuted and misquoted claims stay in the internal project");
    assert.deepEqual(card.sources.map((source) => source.title), ["FLAURA"], "and so do the sources only they stood on");
    const recorded = await outcomeOf(fx, "2026-10-05", run.episodeId);
    assert.deepEqual(recorded.excluded, { refuted: 1, run_not_verified: 1 });
    assert.match(card.limitations, /另有 2 条结论没有通过核验或复核/);
    const counters = fx.programme.status().counters;
    assert.deepEqual([counters.claimsExcluded.refuted, counters.claimsExcluded.run_not_verified, counters.claimsPublished], [1, 1, 1]);
    // The episode itself still holds every claim, graded as they were.
    const episode = await fx.autopilot.getEpisode(PUBLISHER, run.episodeId);
    assert.deepEqual(episode.payload.claims.map((entry) => entry.refutation).sort(), ["refuted", "stands"]);
  } finally { await fx.close(); }
});

test("a card with no qualifying claim is not written, and the reason is recorded", options, async () => {
  const fx = await setup("cardnone");
  try {
    const run = await episodeOf(fx, { day: "2026-10-05", zone: "nsclc", taskType: "evidence-update", sources: [SOURCE_A, SOURCE_C],
      matrixClaims: [claim("CLM-001", SOURCE_A, QUOTE_A), claim("CLM-002", SOURCE_C, "not in the source")],
      agendaClaims: [agendaClaim("CLM-001")] });
    await verify(fx, run, { "CLM-001": "refuted" });
    const result = await fx.programme.onRunFinished(project, { id: run.runId });
    assert.equal(result.state, "no_qualifying_claims");
    assert.equal((await cardsOf(fx, "非小细胞肺癌")).length, 0);
    const recorded = await outcomeOf(fx, "2026-10-05", run.episodeId);
    assert.equal(recorded.outcome, "no_qualifying_claims");
    assert.deepEqual(recorded.excluded, { refuted: 1, run_not_verified: 1 });
    assert.equal((await fx.programme.settleEpisode(run.episodeId)).state, "no_qualifying_claims", "final: not looked at again");
  } finally { await fx.close(); }
});

test("a card built for an episode no decision chose is refused by name, and an episode with no matrix writes none", options, async () => {
  const fx = await setup("cardnodecision");
  try {
    const zone = (await fx.programme.ensureOfficialZones()).find((entry) => entry.key === "nsclc");
    // An agenda and episode made outside the programme's decision: the topic did not come from the selector.
    const agenda = await fx.autopilot.create(PUBLISHER, { projectId: EVIDENCE_PROJECT_ID, title: "x", prompt: "y", taskTypes: ["evidence-update"], schedule: { kind: "once", timeZone: "UTC", time: "00:00", date: "2099-12-31" },
      dailyBudgetCny: 30, weeklyBudgetCny: 210, maxEpisodeCny: 10 });
    await fx.documents.put(PUBLISHER, "agenda", agenda.id, { ...agenda.payload, programme: { zoneKey: "nsclc", zoneId: zone.id } }, { expectedRevision: agenda.revision, projectId: EVIDENCE_PROJECT_ID });
    const started = await fx.autopilot.start(PUBLISHER, agenda.id, { expectedRevision: (await fx.autopilot.get(PUBLISHER, agenda.id)).revision });
    const { episode } = await fx.autopilot.runNow(PUBLISHER, started.id, { requestId: "no-decision-1" });
    const run = await foldEpisode(fx, { action: { episodeId: episode.id, agendaId: agenda.id }, matrixClaims: [claim("CLM-001", SOURCE_A, QUOTE_A)], sources: [SOURCE_A], agendaClaims: [] });
    const result = await fx.programme.settleEpisode(run.episodeId);
    assert.equal(result.state, "decision_required", "the card is refused by the name evidence_programme_decision_required");
    assert.equal((await cardsOf(fx, "非小细胞肺癌")).length, 0);
    assert.equal(fx.programme.status().counters.cards.decision_required, 1);
  } finally { await fx.close(); }
});

test("an episode whose result has no evidence matrix is looked at three times and then left; one whose run failed writes no card", options, async () => {
  const fx = await setup("cardmatrix", { evidenceProgrammeMaxConcurrency: 3 });
  try {
    const run = await episodeOf(fx, { day: "2026-10-05", zone: "nsclc", taskType: "evidence-update", sources: [], matrixClaims: [], agendaClaims: [], matrix: false });
    for (let attempt = 1; attempt <= 4; attempt += 1) assert.equal((await fx.programme.settleEpisode(run.episodeId)).state, attempt <= 3 ? "no_evidence_matrix" : "no_evidence_matrix");
    assert.equal((await outcomeOf(fx, "2026-10-05", run.episodeId)).attempts, 3, "the fourth look found the outcome final and wrote nothing");
    assert.equal((await cardsOf(fx, "非小细胞肺癌")).length, 0);
    // A run that failed.
    fx.state.model = async () => modelAnswer({ actions: [{ zone: "breast-cancer", taskType: "evidence-update", reason: "有新证据" }], reason: "测试" });
    const decision = await fx.programme.runDay("2026-10-06");
    const action = decision.decision.actions[0];
    await fx.autopilot.markEpisodeDispatched(PUBLISHER, action.episodeId, { runId: "run_failed_1", sessionId: "ses_failed_1" });
    await fx.autopilot.completeRun(PUBLISHER, { projectId: EVIDENCE_PROJECT_ID, runId: "run_failed_1", episodeId: action.episodeId, sessionId: "ses_failed_1", status: "failed", artifacts: [], costCny: 1 });
    assert.equal((await fx.programme.onRunFinished(project, { id: "run_failed_1" })).state, "episode_failed");
    assert.equal((await cardsOf(fx, "乳腺癌")).length, 0);
  } finally { await fx.close(); }
});

test("the sweep finds an episode whose hook never fired, and the hook ignores every run that is not the programme's", options, async () => {
  const fx = await setup("cardsweep");
  try {
    const run = await episodeOf(fx, { day: "2026-10-05", zone: "nsclc", taskType: "evidence-update", sources: [SOURCE_A],
      matrixClaims: [claim("CLM-001", SOURCE_A, QUOTE_A)], agendaClaims: [agendaClaim("CLM-001")] });
    await verify(fx, run, { "CLM-001": "stands" });
    assert.equal((await cardsOf(fx, "非小细胞肺癌")).length, 0, "no hook has fired");
    assert.equal((await fx.programme.sweep()).settled, 1);
    assert.equal((await cardsOf(fx, "非小细胞肺癌")).length, 1);
    assert.equal((await fx.programme.sweep()).settled, 0, "nothing is left to settle");
    assert.equal(await fx.programme.onRunFinished({ userId: fx.researcherId, id: "default" }, { id: run.runId }), null, "a researcher's run is not the programme's");
    assert.equal(await fx.programme.onRunFinished({ userId: PUBLISHER, id: "some-other-project" }, { id: run.runId }), null);
  } finally { await fx.close(); }
});

test("an original analysis names its standard, says 信号，待验证 without a replication, and at most two are published in a rolling week", options, async () => {
  const fx = await setup("cardoriginal", { evidenceProgrammeMaxConcurrency: 3 });
  try {
    const engine = [{ key: "ror.fatigue", value: 2.4, unit: "ratio" }];
    fx.state.model = async () => modelAnswer({ actions: [
      { zone: "nsclc", taskType: "signal-monitoring", reason: "有安全警示" }, { zone: "breast-cancer", taskType: "signal-monitoring", reason: "有安全警示" },
      { zone: "type2-diabetes", taskType: "signal-monitoring", reason: "有安全警示" }], reason: "三个药物安全信号" });
    const decision = (await fx.programme.runDay("2026-10-05")).decision;
    assert.deepEqual(decision.actions.map((action) => action.status), ["scheduled", "scheduled", "scheduled"]);
    const runs = [];
    for (const action of decision.actions) {
      const run = await foldEpisode(fx, { action, sources: [SOURCE_A], matrixClaims: [claim("CLM-001", SOURCE_A, QUOTE_A)], agendaClaims: [agendaClaim("CLM-001")], machineValues: engine });
      await verify(fx, run, { "CLM-001": "stands" });
      runs.push(run);
    }
    const results = [];
    for (const run of runs) results.push((await fx.programme.onRunFinished(project, { id: run.runId })).state);
    assert.deepEqual(results, ["published", "published", "deferred_original_cap"], "the third is deferred, not dropped");
    const published = [...await cardsOf(fx, "非小细胞肺癌"), ...await cardsOf(fx, "乳腺癌")];
    for (const card of published) {
      assert.equal(card.originality, "original_analysis");
      assert.equal(card.disclosure.reportingStandard, "READUS-PV", "the reporting standard is in disclosure");
      assert.match(card.title, /（信号，待验证）/);
      assert.match(card.content.answer, /^信号，待验证：/);
    }
    assert.equal((await cardsOf(fx, "2 型糖尿病")).length, 0);
    assert.equal(fx.programme.status().counters.original.deferred >= 1, true);
    assert.equal((await outcomeOf(fx, "2026-10-05", runs[2].episodeId)).outcome, "deferred_original_cap");
    // A week later the cap has room, and the sweep publishes what was waiting.
    fx.clock.at = new Date(Date.now() + 8 * 86_400_000);
    await fx.programme.sweep();
    const late = await cardsOf(fx, "2 型糖尿病");
    assert.equal(late.length, 1, "deferred, then published");
    assert.equal(late[0].originality, "original_analysis");
  } finally { await fx.close(); }
});

test("an original analysis replicated in a second independent dataset is a 「发现」", options, async () => {
  const fx = await setup("cardfinding");
  try {
    const run = await episodeOf(fx, { day: "2026-10-05", zone: "nsclc", taskType: "signal-monitoring", sources: [SOURCE_A],
      matrixClaims: [claim("CLM-001", SOURCE_A, QUOTE_A)], agendaClaims: [agendaClaim("CLM-001")],
      machineValues: [{ key: "ror.fatigue", value: 2.4 }, { key: "replication.independent_dataset_count", value: 1 }] });
    await verify(fx, run, { "CLM-001": "stands" });
    assert.equal((await fx.programme.onRunFinished(project, { id: run.runId })).state, "published");
    const [card] = await cardsOf(fx, "非小细胞肺癌");
    assert.match(card.title, /（发现）/);
    assert.doesNotMatch(card.content.answer, /信号，待验证/);
    assert.equal(fx.programme.status().counters.original.finding, 1);
  } finally { await fx.close(); }
});
