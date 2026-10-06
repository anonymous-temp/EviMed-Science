/**
 * The publication standard of the platform's own evidence programme, as a pure function (evidence-flywheel plan §5.1,
 * F02, 2026-10-05): which of an episode's conclusions become a card, and what the card says.
 *
 * The platform is the author here, and the standard is its editorial one — it stops no user's operation and gates no
 * run. Everything it decides is a deterministic property of what the run left behind (principle 1), so there is no
 * model in this file and no regex over prose:
 *
 * - **A claim is published only when both checks stand.** The run's own verification (`claimVerification`: the
 *   quotation is in the preserved source it names) says `verified`, and the independent re-check of the same claim,
 *   where one ran, did not refute or weaken it. A claim whose quotation was not found, whose source was not there, that
 *   has no quotation, or that is the analyst's own estimate stays out of the card — it stays in the internal project's
 *   episode, which is exactly where the plan puts a ⚠ claim. A claim whose independent check is still queued is not
 *   decided yet: the card waits (`pending`), it is not written without the check nor refused because of it.
 * - **The first sentence is a headline or nothing.** The card's answer is the text of a claim that `digestPlacement` would
 *   place as a headline (reproduced, or direct + gated + stands) — the same rule the researcher's own digest uses. When no
 *   claim is one, the answer says so in a fixed sentence and states no finding. A synthesized claim keeps its confidence
 *   label wherever it appears.
 * - **The card checks itself again.** After it is assembled, `verifyEvidenceCardClaims` runs the card's own claims against
 *   the card's own sources — the comparison the reader's ✓/⚠ uses — and a claim that does not come out ✓ is dropped.
 *   The mark a run gave and the mark a reader sees cannot disagree, and a ⚠ cannot reach a card by a difference of
 *   normalisation between two copies of the text.
 * - **Numbers are never typed by the model.** A comparison is accepted only when each of its numbers is a machine value
 *   the result version recorded (`machineValues`); with none, the card carries claims and no comparison.
 * - **An original analysis carries four more rules** (the anti-paper-mill rules, plan §2.4/§5.1): it needs the selector's
 *   decision behind it (`evidence_programme_decision_required`, by name, for every card); it states its reporting standard
 *   in `disclosure`; it is titled a 「发现」 only when a result of its run records a replication in a second independent
 *   dataset (`REPLICATION_MACHINE_VALUE_KEY`), and otherwise its title and answer say 「信号，待验证」; and at most
 *   `originalPerWeek` of them are published in a rolling week — the next is deferred, not dropped.
 *
 * Which model capability would make it deletable: a reviewer that reads a card against its sources and is trusted as
 * a quotation matcher is — until then, the deterministic comparison is the floor and this file is its caller.
 *
 * @module evidenceProgrammeCard
 */

import {
  EVIDENCE_AI_STEPS, EVIDENCE_PLATFORM_PRODUCER_NAME, digestPlacement, evidenceCardClaims, evidenceStructuredContent,
  verifyEvidenceCardClaims,
} from "@evimed/domain";
import { HttpError } from "./security.mjs";
import { evidenceSourceUrl } from "./evidenceZoneService.mjs";
import { ORIGINAL_ANALYSIS_ENGINES, ORIGINAL_ANALYSIS_LABELS, PROGRAMME_CARD_TITLES, REPLICATION_MACHINE_VALUE_KEY } from "./evidenceProgrammeData.mjs";

/** Why a claim of an episode's matrix is not in the card, closed so the counter's label set is. */
export const PROGRAMME_CLAIM_EXCLUSIONS = Object.freeze(["run_not_verified", "derived_claim", "refuted", "weakened", "source_unavailable", "claim_shape", "card_not_verified"]);

/** Why no card is written for an episode, closed for the same reason. `pending` and `deferred` are not refusals: the episode is looked at again. */
export const PROGRAMME_CARD_OUTCOMES = Object.freeze(["published", "revised", "no_qualifying_claims", "no_evidence_matrix", "episode_failed", "decision_required", "zone_unavailable", "pending_verification", "deferred_original_cap"]);

/** The confidence labels a synthesized claim keeps, in the reader's words. */
const CONFIDENCE_ZH = Object.freeze({ high: "高", moderate: "中", low: "低" });
/** The tiers of a claim the independent re-check can raise: `reproduced` first, for the headline choice. */
const TIER_RANK = Object.freeze({ reproduced: 0, gated: 1, unverified: 2 });

/** @param {unknown} value @returns {any[]} */
const listOf = (value) => (Array.isArray(value) ? value : []);
/** @param {unknown} value @param {number} max */
const clip = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");
/** @param {string} artifactPath */
const baseName = (artifactPath) => String(artifactPath).split("/").filter(Boolean).at(-1) ?? String(artifactPath);

/**
 * Sort an episode's matrix claims into the ones that may be published, the ones that may not, and the ones that cannot
 * be told yet. Pure: it reads the matrix, the run's verification verdict and the episode's own claims, and nothing else.
 *
 * @param {{ matrix: any, verification: any, agendaClaims?: any[] }} input
 *   `verification` is the run's `claimVerification` verdict as the result version stored it; `agendaClaims` are the
 *   episode's claims with the independent re-check's verdict (`refutation`, `verification.status`).
 * @returns {{ included: { claim: any, agendaClaim: any | null, headline: boolean, headlineReason: string | null }[],
 *   excluded: { claimId: string, reason: (typeof PROGRAMME_CLAIM_EXCLUSIONS)[number] }[], pending: number }}
 */
export function evaluateProgrammeClaims({ matrix, verification, agendaClaims = [] }) {
  const verdicts = new Map(listOf(verification?.claims).map((entry) => [String(entry?.claimId), entry]));
  const counterparts = new Map(listOf(agendaClaims).filter((claim) => claim && typeof claim.id === "string").map((claim) => [claim.id, claim]));
  /** @type {ReturnType<typeof evaluateProgrammeClaims>["included"]} */
  const included = [];
  /** @type {ReturnType<typeof evaluateProgrammeClaims>["excluded"]} */
  const excluded = [];
  let pending = 0;
  for (const claim of listOf(matrix?.claims)) {
    const claimId = typeof claim?.claimId === "string" ? claim.claimId : null;
    if (!claimId) continue;
    const status = verdicts.get(claimId)?.status;
    if (String(claim.claimType ?? "direct") === "derived" || status === "derived") { excluded.push({ claimId, reason: "derived_claim" }); continue; }
    if (status !== "verified") { excluded.push({ claimId, reason: "run_not_verified" }); continue; }
    const counterpart = counterparts.get(claimId) ?? null;
    if (counterpart?.verification?.status === "queued") { pending += 1; continue; }
    if (counterpart?.refutation === "refuted") { excluded.push({ claimId, reason: "refuted" }); continue; }
    if (counterpart?.refutation === "weakened") { excluded.push({ claimId, reason: "weakened" }); continue; }
    const placement = counterpart ? digestPlacement({ tier: counterpart.tier, type: counterpart.type ?? claim.claimType, refutation: counterpart.refutation }) : null;
    included.push({ claim, agendaClaim: counterpart, headline: placement?.headline === true, headlineReason: placement?.headline ? placement.reason : null });
  }
  return { included, excluded, pending };
}

/**
 * The comparisons of a card: the candidates a provider offered, kept only when the structure is valid and every number in
 * one is a machine value the result recorded. A number nobody computed is not a number a reader may see as arithmetic.
 * @param {{ candidates?: any[], machineValues?: any[], sourceCount: number }} input @returns {any[]}
 */
export function programmeComparisons({ candidates = [], machineValues = [], sourceCount }) {
  const recorded = new Set(listOf(machineValues).filter((entry) => Number.isFinite(entry?.value)).map((entry) => Number(entry.value)));
  /** @type {any[]} */
  const kept = [];
  for (const candidate of listOf(candidates)) {
    const numbers = [candidate?.denominator, candidate?.control?.events, candidate?.intervention?.events, candidate?.participants, candidate?.studies]
      .filter((value) => value != null);
    if (!numbers.length || numbers.some((value) => !recorded.has(Number(value)))) continue;
    try {
      evidenceStructuredContent({ comparisons: [candidate] }, sourceCount);
      kept.push(candidate);
    } catch { /* an invalid candidate is left out, the card keeps its claims */ }
  }
  return kept;
}

/**
 * Whether a result of the run records a replication in a second independent dataset.
 * @param {any[]} machineValues @returns {boolean}
 */
export function analysisReplicated(machineValues) {
  return listOf(machineValues).some((entry) => entry?.key === REPLICATION_MACHINE_VALUE_KEY && Number.isFinite(entry.value) && Number(entry.value) >= 1);
}

/**
 * One matrix claim as a card claim over a source index map, or null when the card contract cannot hold it.
 * @param {any} claim @param {Map<string, number>} indexOf artifact path → 1-based source index
 */
function cardClaim(claim, indexOf) {
  const type = String(claim.claimType ?? "direct");
  const base = { claimId: claim.claimId, claimType: type, claim: clip(claim.claim, 1600),
    ...(clip(claim.applicability, 800) ? { applicability: clip(claim.applicability, 800) } : {}),
    ...(clip(claim.uncertainty, 800) ? { uncertainty: clip(claim.uncertainty, 800) } : {}) };
  if (type === "synthesized") {
    const bonds = listOf(claim.supportingSources).map((source) => ({ sourceIndex: indexOf.get(String(source?.artifactPath)), supportQuote: source?.supportQuote }));
    if (bonds.some((bond) => !bond.sourceIndex || typeof bond.supportQuote !== "string")) return null;
    return { ...base, confidence: claim.confidence, supportingSources: bonds.map((bond) => ({ sourceIndex: bond.sourceIndex, supportQuote: bond.supportQuote })) };
  }
  const index = indexOf.get(String(claim.artifactPath));
  if (!index || typeof claim.supportQuote !== "string") return null;
  return { ...base, claimType: "direct", sourceIndexes: [index], supportQuote: claim.supportQuote };
}

/** The artifact paths a matrix claim stands on. @param {any} claim @returns {string[]} */
function pathsOf(claim) {
  if (String(claim.claimType ?? "direct") === "synthesized") return listOf(claim.supportingSources).map((source) => String(source?.artifactPath ?? "")).filter(Boolean);
  return typeof claim.artifactPath === "string" && claim.artifactPath ? [claim.artifactPath] : [];
}

/**
 * The card's sources from the preserved text each included claim stands on, in the order the claims first name them. A source
 * keeps its preserved text (so the card re-verifies on its own) and the hash of the bytes the run captured; one too large to keep
 * is kept as the quotations the card stands on, which is all a reader's ✓ needs.
 * @param {any[]} claims matrix claims @param {Map<string, any>} captured artifact path → `{ text, digest, capturedAt }`
 */
function cardSources(claims, captured) {
  /** @type {Map<string, any>} */
  const sources = new Map();
  for (const claim of claims) {
    const bonds = String(claim.claimType ?? "direct") === "synthesized" ? listOf(claim.supportingSources) : [claim];
    for (const bond of bonds) {
      const artifactPath = String(bond?.artifactPath ?? "");
      if (!artifactPath) continue;
      const held = captured.get(artifactPath);
      const entry = sources.get(artifactPath) ?? { artifactPath, title: "", url: null, quotes: [], accessLevel: null, held };
      if (!entry.title && typeof bond.sourceTitle === "string" && bond.sourceTitle.trim()) entry.title = bond.sourceTitle.trim().slice(0, 500);
      if (!entry.url && typeof bond.sourceUrl === "string") { try { entry.url = evidenceSourceUrl(bond.sourceUrl); } catch { /* a source without a usable address is cited by its title */ } }
      if (!entry.accessLevel && typeof bond.accessLevel === "string") entry.accessLevel = bond.accessLevel;
      if (typeof bond.supportQuote === "string") entry.quotes.push(bond.supportQuote);
      sources.set(artifactPath, entry);
    }
  }
  const ordered = [...sources.values()];
  return ordered.map((entry) => {
    const text = typeof entry.held?.text === "string" ? entry.held.text : "";
    // A source with no public address is not kept whole: the card keeps the passages it stands on and no more (`EvidenceZoneService`).
    const keepWhole = text.length > 0 && text.length <= 2_000_000 && Boolean(entry.url);
    const excerpt = keepWhole ? text.slice(0, 12_000) : [...new Set(entry.quotes)].join("\n\n").slice(0, 12_000);
    return {
      artifactPath: entry.artifactPath,
      source: {
        title: entry.title || baseName(entry.artifactPath),
        url: entry.url,
        excerpt: excerpt || null,
        ...(keepWhole ? { documentText: text } : {}),
        coverage: keepWhole && entry.accessLevel === "full_text" ? "full-text" : entry.accessLevel === "abstract" ? "abstract" : "excerpt",
        ...(entry.held?.digest ? { fetchedSha256: entry.held.digest } : {}),
        ...(entry.held?.capturedAt ? { checkedAt: entry.held.capturedAt } : {}),
      },
    };
  });
}

/**
 * The card the programme would write for one finished episode, or why it writes none. Pure and deterministic: the same
 * inputs make the same card, which is what makes a replay of the settling step harmless.
 *
 * @param {{
 *   zone: { id: string, title: string }, question: string, taskType: string, capabilityId: string | null,
 *   decisionId: string | null, agenda: { id: string }, episode: { id: string }, runId: string, resultVersionId: string,
 *   evaluation: ReturnType<typeof evaluateProgrammeClaims>, captured: Map<string, { text: string | null, digest?: string | null, capturedAt?: string | null }>,
 *   machineValues?: any[], comparisonCandidates?: any[], model: string, at: Date, revising?: boolean,
 *   originalThisWeek?: number, originalPerWeek?: number }} input
 * @returns {{ status: "card", card: Record<string, any>, requestId: string, originality: string, replicated: boolean, headlineClaimId: string | null,
 *     excluded: { claimId: string, reason: string }[], includedCount: number }
 *   | { status: "refused", outcome: "no_qualifying_claims", excluded: { claimId: string, reason: string }[] }
 *   | { status: "deferred", outcome: "deferred_original_cap", originalThisWeek: number }}
 */
export function buildProgrammeCard(input) {
  if (!input.decisionId) {
    throw new HttpError(409, "evidence_programme_decision_required", "A programme card is written only for a topic the selector decided on.");
  }
  const engine = input.capabilityId && Object.hasOwn(ORIGINAL_ANALYSIS_ENGINES, input.capabilityId) ? ORIGINAL_ANALYSIS_ENGINES[input.capabilityId] : null;
  // An engine's analysis is the platform's own first-hand work only when the engine left a receipt: a result with machine values.
  const original = Boolean(engine) && listOf(input.machineValues).length > 0;
  const replicated = original && analysisReplicated(input.machineValues ?? []);
  /** @type {{ claimId: string, reason: string }[]} */
  const excluded = [...input.evaluation.excluded];

  // Sources first (their texts decide which claims can stand), then the claims over them, then the card's own re-check.
  let candidates = input.evaluation.included.filter((entry) => {
    const absent = pathsOf(entry.claim).some((path) => typeof input.captured.get(path)?.text !== "string" || !input.captured.get(path)?.text);
    if (absent) excluded.push({ claimId: entry.claim.claimId, reason: "source_unavailable" });
    return !absent;
  });
  /** @type {{ artifactPath: string, source: any }[]} */
  let sources = [];
  /** @type {any[]} */
  let claims = [];
  // Assemble, check, and assemble again over what stood: dropping a claim can leave a source nothing stands on, or take a
  // synthesis's second source with it, and the indexes of every claim after it move. Each round that changes anything removes at
  // least one claim, so the loop ends.
  for (;;) {
    sources = cardSources(candidates.map((entry) => entry.claim), input.captured);
    const indexOf = new Map(sources.map((entry, position) => [entry.artifactPath, position + 1]));
    /** @type {typeof candidates} */
    const holdable = [];
    /** @type {any[]} */
    const held = [];
    for (const entry of candidates) {
      const made = cardClaim(entry.claim, indexOf);
      let ok = made != null;
      if (made) { try { evidenceCardClaims([made], sources.length); } catch { ok = false; } }
      if (!ok) { excluded.push({ claimId: entry.claim.claimId, reason: "claim_shape" }); continue; }
      holdable.push(entry); held.push(made);
    }
    // The card's own comparison of its quotations with its own sources: a claim that is not ✓ here is not published.
    const verdict = verifyEvidenceCardClaims({ claims: held, sources: sources.map((entry) => entry.source) });
    const standing = new Set(verdict.claims.filter((entry) => entry.status === "verified").map((entry) => entry.claimId));
    for (const entry of holdable) if (!standing.has(entry.claim.claimId)) excluded.push({ claimId: entry.claim.claimId, reason: "card_not_verified" });
    const stable = holdable.length === candidates.length && holdable.every((entry) => standing.has(entry.claim.claimId));
    candidates = holdable.filter((entry) => standing.has(entry.claim.claimId));
    if (stable || !candidates.length) { claims = stable ? held : []; break; }
  }
  if (!claims.length) return { status: "refused", outcome: "no_qualifying_claims", excluded };

  if (original && !input.revising && Number(input.originalPerWeek ?? 0) <= Number(input.originalThisWeek ?? 0)) {
    return { status: "deferred", outcome: "deferred_original_cap", originalThisWeek: Number(input.originalThisWeek ?? 0) };
  }

  // The first sentence: a headline claim, reproduced ones first, else the neutral sentence that states no finding.
  const headlines = candidates.filter((entry) => entry.headline).sort((left, right) =>
    (TIER_RANK[/** @type {keyof typeof TIER_RANK} */ (left.agendaClaim?.tier)] ?? 3) - (TIER_RANK[/** @type {keyof typeof TIER_RANK} */ (right.agendaClaim?.tier)] ?? 3));
  const lead = headlines[0] ?? null;
  const labelled = (/** @type {any} */ claim) => (String(claim.claimType) === "synthesized" ? `${claim.claim}（综合判断，把握度：${CONFIDENCE_ZH[/** @type {keyof typeof CONFIDENCE_ZH} */ (claim.confidence)] ?? "未标注"}）` : claim.claim);
  const leadClaim = lead ? claims.find((made) => made.claimId === lead.claim.claimId) : null;
  const caution = original ? (replicated ? "" : `${ORIGINAL_ANALYSIS_LABELS.unreplicated}：`) : "";
  const answer = leadClaim ? `${caution}${labelled(leadClaim)}`
    : `${caution}这张卡汇总了 ${claims.length} 条引文已逐字核对的结论；其中没有达到“发现”标准的结论，请逐条阅读下面的限定。`;

  const independent = candidates.filter((entry) => entry.agendaClaim?.refutation === "stands" || entry.agendaClaim?.tier === "reproduced").length;
  const lines = claims.map((made, position) => {
    const numbers = (made.sourceIndexes ?? []).map((index) => `[${index}]`).join("");
    const how = made.claimType === "synthesized" ? `综合判断（把握度：${CONFIDENCE_ZH[/** @type {keyof typeof CONFIDENCE_ZH} */ (made.confidence)] ?? "未标注"}），来源 ${numbers}` : `直接引用，来源 ${numbers}`;
    return `${position + 1}. ${made.claim}（${how}）`;
  });
  const applicability = [...new Set(claims.map((made) => made.applicability).filter(Boolean))];
  const uncertainty = [...new Set(claims.map((made) => made.uncertainty).filter(Boolean))];
  const excludedCount = new Set(excluded.map((entry) => entry.claimId)).size;
  const body = [
    "## 已逐字核对的结论", ...lines,
    ...(applicability.length ? ["", "## 适用范围", ...applicability.map((line) => `- ${line}`)] : []),
    ...(uncertainty.length ? ["", "## 不确定性", ...uncertainty.map((line) => `- ${line}`)] : []),
  ].join("\n");

  const label = original ? (replicated ? ORIGINAL_ANALYSIS_LABELS.replicated : ORIGINAL_ANALYSIS_LABELS.unreplicated) : null;
  const taskTitle = PROGRAMME_CARD_TITLES[/** @type {keyof typeof PROGRAMME_CARD_TITLES} */ (input.taskType)] ?? "证据更新";
  const title = `${input.zone.title}：${taskTitle}${label ? `（${label}）` : ""}`.slice(0, 300);
  const standard = original && engine ? engine.standard : null;
  const sourcesOut = sources.map((entry) => entry.source);
  const comparisons = programmeComparisons({ candidates: input.comparisonCandidates, machineValues: input.machineValues, sourceCount: sourcesOut.length });
  const reviewed = candidates.some((entry) => entry.agendaClaim?.verification?.status === "recorded");
  const at = input.at.toISOString();
  const context = `本卡由平台议程完成：${claims.length} 条结论的引文已逐字核对${independent ? `，其中 ${independent} 条经独立复核未被推翻` : ""}。${standard ? `按 ${standard} 报告规范写成。` : ""}`;
  const card = {
    title,
    subtype: "academic",
    summary: answer.slice(0, 600),
    body,
    sources: sourcesOut,
    limitations: [
      ...uncertainty.slice(0, 5),
      excludedCount ? `另有 ${excludedCount} 条结论没有通过核验或复核，没有放进这张卡，留在平台的内部研究记录里。` : "",
      original && !replicated ? "这是一项尚未在第二个独立数据集中复现的信号，不能当作发现。" : "",
    ].filter(Boolean).join("\n").slice(0, 12_000),
    provenance: programmeCardProvenance(input.agenda.id, input.taskType),
    content: { question: input.question, answer, context, ...(comparisons.length ? { comparisons } : {}) },
    claims,
    producer: { kind: "platform", name: EVIDENCE_PLATFORM_PRODUCER_NAME, relation: "none" },
    originality: original ? "original_analysis" : "synthesis",
    lineage: { agendaId: input.agenda.id, episodeId: input.episode.id, runId: input.runId, resultVersionId: input.resultVersionId },
    disclosure: {
      model: input.model, generatedAt: at, lastCheckedAt: at,
      aiSteps: EVIDENCE_AI_STEPS.filter((step) => step !== "review" || reviewed),
      authors: [], reviewers: [],
      ...(standard ? { reportingStandard: standard } : {}),
    },
    state: "published",
  };
  return { status: "card", card, requestId: programmeCardRequestId(input.agenda.id, input.taskType), originality: card.originality, replicated,
    headlineClaimId: leadClaim?.claimId ?? null, excluded, includedCount: claims.length };
}

/**
 * The text that marks a card as the one a programme agenda keeps for a task type: a revision of the same topic is found by
 * it, in the zone, instead of a second card being made. A code-built string and an exact match, never a reading of prose.
 * @param {string} agendaId @param {string} taskType
 */
export function programmeCardProvenance(agendaId, taskType) {
  return `平台议程（${taskType}）：${agendaId}`;
}

/** The request identity a programme card is created under: a replay of the creation finds the same card. @param {string} agendaId @param {string} taskType */
export function programmeCardRequestId(agendaId, taskType) {
  return `programme-${agendaId}-${taskType}`.slice(0, 100);
}
