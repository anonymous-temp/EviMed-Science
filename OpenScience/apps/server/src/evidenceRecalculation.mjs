/**
 * Recalculation cards (evidence-flywheel plan §5.1, F03, 2026-10-06): when the evolution module's independent reproduction of a
 * published result lands within its tolerance, or its disagreement with the paper has been adjudicated, the platform publishes what
 * it found as a first-hand card in the official zone the paper is about.
 *
 * The card says three things and each is checkable: what the paper printed (a quotation, verbatim from the preserved paper), what
 * the platform's reproduction computed (a calculation, with the evolution module's receipt behind it) and how far apart they are
 * against the tolerance the paper's printed precision allows — the difference and the tolerance rendered from machine values, none
 * typed. The verdict is a closed vocabulary (`reproduced`, `reproduced_with_difference`, `not_reproduced_adjudicated`).
 *
 * Hidden knowledge:
 *
 * - **A paper is said not to have been reproduced only when the disagreement is adjudicated.** The evaluator's own adjudication
 *   (a reviewer of another model family, code-verified, citing the evidence) is the only record that lets a card say the paper and
 *   the platform differ and why; a failed reproduction nobody has judged is the tool's problem, not a finding about the paper, and no
 *   card is published (counted `not_adjudicated`).
 * - **The tolerance is the evaluator's.** The half-width is `boundedHalfWidth` of the paper-gold rule, the one the evaluation scored the
 *   reproduction with, so a card cannot call a result reproduced that the evaluation called a miss, nor the other way round.
 * - **The receipt is written here and read from the evolution ledger.** The proof record (`evolution-research-proof`) says a tool
 *   reproduced a paper; it holds no numbers. The numbers the card stands on are written once, as an immutable
 *   `evolution-recalculation-receipt` beside it, from the values the comparison provider returned; the card cites that record and
 *   `evidenceCalculationReceipts.mjs` reads it back when the card is read.
 * - **The evaluation units carry scores, not the values scored** (`scoreUnit` returns `{ valid, distance }` per key), so the pairs of
 *   values this card needs come from a provider. The default provider reads `comparison` from the unit row; no producer writes it
 *   yet, which is why a deployment publishes no recalculation card until the evolution module records it (see the report).
 * - **No matching official zone is not an error.** The card goes where the paper's entities say it belongs (the zones' terms through
 *   the shared glossary); with no such zone nothing is published and the count says so.
 * - **Nothing here can fail the evolution loop.** The hook is told and never asked: a failure is counted and reported, and the proof
 *   that was just recorded stands.
 *
 * Build to delete: a reader that matches a card to its zone from the paper's own text needs no per-zone terms, and a unit that records
 * the values it scored needs no provider.
 *
 * @module evidenceRecalculation
 */

import { createHash } from "node:crypto";
import {
  EVIDENCE_PLATFORM_PRODUCER_NAME, EVIDENCE_RECALCULATION_VERDICT_LABELS_ZH, NUMBER_UNCOMPUTED, PLATFORM_PUBLISHER_USER_ID, evidenceCardClaims, renderNumberTemplate,
  verifyEvidenceCardClaims,
} from "@evimed/domain";
import { boundedHalfWidth, printedNumber } from "../../../evals/paper-gold/tolerance.mjs";
import { EVIDENCE_PROGRAMME_ZONES } from "./evidenceProgrammeData.mjs";

/** What the recalculation of a paper's results is called as an engine, and as the receipt's method. */
export const RECALCULATION_ENGINE = "evolution_recalculation";
/** The most results of one paper a card states (the paper-gold cases state a few central outcomes). */
export const RECALCULATION_ITEM_LIMIT = 4;
/** The reasons a proof makes no card, closed so the counter's label set is. */
export const RECALCULATION_OUTCOMES = Object.freeze([
  "published", "already_published", "no_comparison_values", "not_adjudicated", "no_matching_zone", "zone_unavailable", "card_refused", "error",
]);

const sha = (/** @type {unknown} */ value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** @param {unknown} value @returns {any[]} */
const listOf = (value) => (Array.isArray(value) ? value : []);

/**
 * Whether the evaluator's own record of a disagreement with the paper is an adjudication a card may rest on: the reviewer's verdict
 * is the paper's error or a reasonable difference (never the platform's), it was verified by code, by a reviewer of another model
 * family, citing evidence, with the proof that verified it (`publishEvaluationGaps` holds an adjudication to the same conditions).
 * @param {any} review the unit's `disagreement` @returns {boolean}
 */
export function isAdjudicated(review) {
  return ["paper_error", "reasonable_difference"].includes(review?.verdict) && review.codeVerified === true && Boolean(review.reviewerFamily)
    && listOf(review.evidenceIds).length > 0 && /^[a-f0-9]{64}$/.test(review.verificationProof?.proofHash ?? "");
}

/**
 * One published number against the platform's recalculation of it: the difference, the tolerance the paper's printed precision allows
 * (the evaluator's `boundedHalfWidth`), whether it lands within it, and whether it matches at the precision the paper printed.
 * @param {{ published: { value: number, printed?: string, absoluteTolerance?: number, relativeTolerance?: number, toleranceReason?: string }, recalculated: { value: number } }} item
 * @returns {{ difference: number, tolerance: number, within: boolean, matchesPrinted: boolean }}
 */
export function compareRecalculation({ published, recalculated }) {
  const { halfWidth } = boundedHalfWidth({ value: published.value, printed: published.printed, absoluteTolerance: published.absoluteTolerance,
    relativeTolerance: published.relativeTolerance, toleranceReason: published.toleranceReason });
  const difference = recalculated.value - published.value;
  const printed = printedNumber(published.printed);
  const matchesPrinted = printed ? Number(recalculated.value.toFixed(Math.min(printed.decimals, 12))) === published.value : recalculated.value === published.value;
  return { difference, tolerance: halfWidth, within: Math.abs(difference) <= halfWidth, matchesPrinted };
}

/**
 * The verdict for the results of one paper, or why there is none: every result within tolerance is a reproduction (at the printed
 * precision, or with a difference); a result outside it is a non-reproduction a card may state only when the disagreement is adjudicated.
 * @param {ReturnType<typeof compareRecalculation>[]} comparisons @param {{ adjudicated: boolean }} context
 * @returns {{ verdict: "reproduced" | "reproduced_with_difference" | "not_reproduced_adjudicated" } | { verdict: null, reason: "not_adjudicated" | "no_results" }}
 */
export function recalculationVerdict(comparisons, { adjudicated }) {
  if (!comparisons.length) return { verdict: null, reason: "no_results" };
  if (comparisons.some((entry) => !entry.within)) return adjudicated ? { verdict: "not_reproduced_adjudicated" } : { verdict: null, reason: "not_adjudicated" };
  return { verdict: comparisons.every((entry) => entry.matchesPrinted) ? "reproduced" : "reproduced_with_difference" };
}

/**
 * The receipt of one recalculation: the immutable record the card's calculation claims are read back from. Its values are the machine
 * values the sentences are rendered from, at fixed paths (`recalculated[i].value`, `published[i].value`, `difference[i]`, `tolerance[i]`).
 * @param {{ proofId: string, toolId: string, artifactDigest: string, paperId: string, goldSourceHash: string | null, items: any[], comparisons: ReturnType<typeof compareRecalculation>[] }} input
 */
export function recalculationReceipt({ proofId, toolId, artifactDigest, paperId, goldSourceHash, items, comparisons }) {
  const values = items.flatMap((item, index) => [
    { key: `recalculated[${index}].value`, value: item.recalculated.value, unit: item.recalculated.unit ?? null },
    { key: `published[${index}].value`, value: item.published.value, unit: item.recalculated.unit ?? null },
    { key: `difference[${index}]`, value: comparisons[index].difference, unit: item.recalculated.unit ?? null },
    { key: `tolerance[${index}]`, value: comparisons[index].tolerance, unit: item.recalculated.unit ?? null },
  ]);
  const method = `${toolId}@${artifactDigest.slice(0, 16)}`.slice(0, 200);
  const inputs = [{ identifier: paperId.slice(0, 200), ...(goldSourceHash && /^[a-f0-9]{64}$/.test(goldSourceHash) ? { hash: goldSourceHash } : {}) }];
  return { id: `evolution-recalculation-receipt-${sha([proofId, method, values]).slice(0, 32)}`, engine: RECALCULATION_ENGINE, method, inputs, values };
}

/** The format a recalculation is printed in: whole numbers as they are, anything else to three places. @param {any[]} items */
const formatOf = (items) => (items.every((item) => Number.isInteger(item.published.value) && Number.isInteger(item.recalculated.value)) ? "int" : "f3");

/**
 * The card for one reproduced paper: pure and deterministic. A quotation claim and a calculation claim for each result, the verdict in the
 * first sentence, and the card's claims checked against the receipt it cites before it is returned.
 *
 * @param {{ paper: { id: string, title: string, url: string | null, source: any, doi?: string | null },
 *   items: any[], verdict: string, adjudication: any | null, receipt: ReturnType<typeof recalculationReceipt>, proofId: string, model: string, at: Date }} input
 * @returns {{ status: "card", card: Record<string, any>, requestId: string } | { status: "refused", reason: "card_refused" }}
 */
export function buildRecalculationCard({ paper, items, verdict, adjudication, receipt, proofId, model, at }) {
  const label = /** @type {Record<string, string>} */ (EVIDENCE_RECALCULATION_VERDICT_LABELS_ZH)[verdict];
  const format = formatOf(items);
  /** @type {any[]} */
  const claims = [];
  items.forEach((item, index) => {
    claims.push({ claimId: `QUOTE-${index + 1}`, claimType: "direct", claim: `论文原文报告了这个数值：「${item.published.quote}」`.slice(0, 1500), sourceIndexes: [1], supportQuote: item.published.quote });
    const rendered = renderNumberTemplate(
      `平台复算值为 {{n:recalculated[${index}].value|${format}}}，论文报告值为 {{n:published[${index}].value|${format}}}，差值为 {{n:difference[${index}]|${format}}}，容差为 {{n:tolerance[${index}]|${format}}}。`,
      (path) => { const found = receipt.values.find((entry) => entry.key === path); return found ? { value: found.value, unit: found.unit ?? null } : { value: undefined, unit: null }; });
    if (rendered.text.includes(NUMBER_UNCOMPUTED) || rendered.bindings.some((binding) => !binding.ok)) return;
    const [first, ...more] = rendered.bindings;
    claims.push({
      claimId: `CALC-${index + 1}`, claimType: "calculated", valueSource: "calculated", claim: rendered.text,
      calculation: { engine: receipt.engine, method: receipt.method, receiptId: receipt.id, inputs: receipt.inputs, valuePath: first.path, machineValue: first.value, format: first.format,
        alsoValues: more.map((binding) => ({ valuePath: binding.path, machineValue: binding.value, format: binding.format })) },
    });
  });
  const source = { title: paper.source?.title || paper.title, url: paper.source?.url ?? paper.url ?? null, excerpt: String(paper.source?.documentText ?? paper.source?.excerpt ?? "").slice(0, 12_000),
    ...(typeof paper.source?.documentText === "string" && paper.source.documentText.length <= 2_000_000 ? { documentText: paper.source.documentText } : {}), coverage: "excerpt" };
  const receiptSource = { title: `复算回执：${receipt.method}`, url: null, excerpt: receipt.values.map((entry) => `${entry.key}\t${entry.value}`).join("\n").slice(0, 12_000), coverage: "excerpt" };
  // The card checks itself again: its quotations against the paper it preserves, its numbers against the receipt it cites. What does not come out ✓ is not published.
  try { evidenceCardClaims(claims, 2); } catch { return { status: "refused", reason: "card_refused" }; }
  const verification = verifyEvidenceCardClaims({ claims, sources: [source, receiptSource] }, { receipts: new Map([[receipt.id, { receiptId: receipt.id, engine: receipt.engine, method: receipt.method, inputs: receipt.inputs, values: receipt.values }]]) });
  if (verification.claims.length === 0 || verification.claims.some((entry) => entry.status !== "verified")) return { status: "refused", reason: "card_refused" };

  const lead = claims.find((claim) => claim.claimType === "calculated") ?? claims[0];
  const adjudicationLine = verdict === "not_reproduced_adjudicated" && adjudication
    ? `裁定意见：${adjudication.verdict === "paper_error" ? "差异来自论文本身的错误" : "差异在合理范围内"}（另一模型家族复核，代码验证，证明哈希 ${adjudication.verificationProof.proofHash.slice(0, 12)}）。` : "";
  const answer = `${label}：${lead.claim}`.slice(0, 600);
  const generated = at.toISOString();
  const card = {
    title: `复算核验：${paper.title}（${label}）`.slice(0, 300),
    subtype: "academic",
    summary: answer,
    body: [
      "## 结论", `${label}。`, ...(adjudicationLine ? [adjudicationLine] : []),
      "", "## 论文报告与平台复算", ...claims.map((claim, position) => `${position + 1}. ${claim.claim}`),
      "", "## 方法", `平台独立复算：${receipt.method}；回执 ${receipt.id}。容差按论文印出数字的精度计算，与评测打分用的是同一规则。`,
    ].join("\n"),
    sources: [source, receiptSource],
    limitations: ["这是对一篇已发表论文的独立复算，不是对其结论是否正确的评价。", adjudicationLine].filter(Boolean).join("\n"),
    provenance: `平台复算核验：${proofId}`,
    content: { question: `平台能否独立复现《${paper.title}》报告的数值？`, answer, context: `复算由平台的循证进化模块完成，每个数字都来自复算回执。` },
    claims,
    producer: { kind: "platform", name: EVIDENCE_PLATFORM_PRODUCER_NAME, relation: "none" },
    originality: "recalculation",
    lineage: paper.doi ? { verifiedStudy: { doi: paper.doi } } : null,
    disclosure: { model, generatedAt: generated, lastCheckedAt: generated, aiSteps: ["extract"], authors: [], reviewers: [] },
    state: "published",
  };
  return { status: "card", card, requestId: `recalc-${sha(proofId).slice(0, 40)}` };
}

/**
 * The matcher of a paper to the official zone it belongs to: the zones the programme defines (by title, since three are an operator's)
 * with the terms their entities are read from, through the shared glossary. The zone with the most keys in common with the paper's wins;
 * with none in common there is none.
 *
 * @param {{ database: any, entityVocabulary: { keysForText(input: { texts: string[] }): Promise<string[] | null> } }} dependencies
 */
export function createOfficialZoneMatcher({ database, entityVocabulary }) {
  /** @param {string[]} texts @returns {Promise<{ id: string, title: string, writable: boolean, keys: string[] } | null>} */
  return async function match(texts) {
    const paperKeys = new Set((await entityVocabulary.keysForText({ texts })) ?? []);
    if (!paperKeys.size) return null;
    const rows = (await database.query("SELECT id,title,user_id FROM evimed_frontier.evidence_zones WHERE kind='official' AND state='published'")).rows;
    /** @type {{ id: string, title: string, writable: boolean, keys: string[], shared: number } | null} */
    let best = null;
    for (const row of rows) {
      const definition = EVIDENCE_PROGRAMME_ZONES.find((zone) => zone.title === row.title);
      if (!definition?.topic.terms.length) continue;
      const keys = (await entityVocabulary.keysForText({ texts: [...definition.topic.terms] })) ?? [];
      const shared = keys.filter((key) => paperKeys.has(key)).length;
      if (shared > (best?.shared ?? 0)) best = { id: row.id, title: row.title, writable: true, keys, shared };
    }
    return best;
  };
}

/**
 * The publisher of recalculation cards, off unless its switch is on and the evolution module that records the proofs is on beside it.
 *
 * @param {{
 *   config: any, evolution: any, zones: any, matchZone: (texts: string[]) => Promise<{ id: string, title: string } | null>,
 *   comparisons?: ((input: { paperId: string, rows: any[], proofId: string }) => Promise<any> | any) | null,
 *   publisherUser?: { id: string, name?: string }, now?: () => Date, report?: (message: string) => void }} dependencies
 */
export function createEvidenceRecalculation({ config, evolution, zones, matchZone, comparisons = null, publisherUser = { id: PLATFORM_PUBLISHER_USER_ID, name: EVIDENCE_PLATFORM_PRODUCER_NAME }, now = () => new Date(), report = () => {} }) {
  const enabled = config?.evidenceRecalculationCardsEnabled === true && config?.evolutionEnabled === true && Boolean(evolution && zones);
  const counters = { /** @type {Record<string, number>} */ outcomes: Object.fromEntries(RECALCULATION_OUTCOMES.map((outcome) => [outcome, 0])),
    verdicts: /** @type {Record<string, number>} */ ({ reproduced: 0, reproduced_with_difference: 0, not_reproduced_adjudicated: 0 }) };
  /** @param {string} outcome */
  const count = (outcome) => { counters.outcomes[outcome] = (counters.outcomes[outcome] ?? 0) + 1; return outcome; };
  /** The default provider: the comparison a producer recorded on the evaluation unit. @param {{ rows: any[] }} input */
  const fromRows = ({ rows }) => rows.find((row) => row?.comparison && typeof row.comparison === "object")?.comparison ?? null;

  /**
   * Told that a research-proof was recorded for a paper. Replayable: the outcome is kept in the evolution ledger and a published proof
   * is not published twice.
   * @param {{ proofId: string, toolId: string, artifactDigest: string, paperId: string, passed: boolean, rows: any[] }} proof
   * @returns {Promise<{ outcome: string, cardId?: string, verdict?: string }>}
   */
  async function onProofRecorded(proof) {
    if (!enabled) return { outcome: "off" };
    try {
      const recordId = `evolution-recalculation-card-${sha(proof.proofId).slice(0, 32)}`;
      const prior = await evolution.get(recordId);
      if (prior?.payload?.status === "published") return { outcome: count("already_published"), cardId: prior.payload.cardId };
      const found = await Promise.resolve((comparisons ?? fromRows)({ paperId: proof.paperId, rows: proof.rows, proofId: proof.proofId }));
      const items = listOf(found?.items).filter((item) => Number.isFinite(item?.published?.value) && typeof item.published.quote === "string" && item.published.quote.trim()
        && Number.isFinite(item?.recalculated?.value)).slice(0, RECALCULATION_ITEM_LIMIT);
      if (!found || !items.length || !found.source) return { outcome: count("no_comparison_values") };
      const compared = items.map(compareRecalculation);
      const adjudication = proof.rows.map((row) => row?.disagreement).find(isAdjudicated) ?? null;
      const decided = recalculationVerdict(compared, { adjudicated: adjudication != null });
      if (!decided.verdict) return { outcome: count(/** @type {any} */ (decided).reason === "not_adjudicated" ? "not_adjudicated" : "no_comparison_values") };
      const texts = [found.title, found.source.title, ...items.map((item) => item.published.quote)].filter((text) => typeof text === "string" && text.trim());
      const zone = await matchZone(texts);
      if (!zone) return { outcome: count("no_matching_zone") };
      const receipt = recalculationReceipt({ proofId: proof.proofId, toolId: proof.toolId, artifactDigest: proof.artifactDigest, paperId: proof.paperId,
        goldSourceHash: found.source.sha256 ?? proof.rows[0]?.goldSourceHash ?? null, items, comparisons: compared });
      const built = buildRecalculationCard({ paper: { id: proof.paperId, title: String(found.title || found.source.title || proof.paperId), url: found.url ?? found.source.url ?? null,
        source: found.source, doi: /^doi:/i.test(proof.paperId) ? proof.paperId.replace(/^doi:/i, "") : /^10\./.test(proof.paperId) ? proof.paperId : null },
      items, verdict: decided.verdict, adjudication, receipt, proofId: proof.proofId, model: String(config?.deepseekModel || "deepseek-flash"), at: now() });
      if (built.status !== "card") return { outcome: count(built.reason) };
      // The receipt first: a card that cites a record that is not there reads as unavailable.
      await evolution.save("recalculation-receipt", receipt.id, { engine: receipt.engine, method: receipt.method, inputs: receipt.inputs, values: receipt.values, proofId: proof.proofId,
        toolId: proof.toolId, artifactDigest: proof.artifactDigest, paperId: proof.paperId, verdict: decided.verdict, createdAt: now().toISOString() });
      const saved = await zones.saveEditorial(publisherUser, { ...built.card, requestId: built.requestId }, zone.id, null, true, "programme");
      const cardId = saved.evidence.id;
      await evolution.save("recalculation-card", recordId, { proofId: proof.proofId, paperId: proof.paperId, verdict: decided.verdict, status: "published", cardId, zoneId: zone.id, receiptId: receipt.id,
        publishedAt: now().toISOString() }, prior);
      counters.verdicts[decided.verdict] += 1;
      count("published");
      return { outcome: "published", cardId, verdict: decided.verdict };
    } catch (error) {
      // A card is advice to the evolution loop and never part of it: the proof just recorded stands.
      count("error");
      report(`evidence recalculation ${proof?.proofId}: ${typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "failed"}`);
      return { outcome: "error" };
    }
  }

  return { enabled, onProofRecorded, status: () => ({ enabled, counters: structuredClone(counters) }) };
}

/** The operator-metric families of the publisher, with the module off and nothing to read reporting zero. @param {ReturnType<typeof createEvidenceRecalculation> | null} publisher @param {any} config */
export function evidenceRecalculationMetricFamilies(publisher, config) {
  const status = publisher?.status();
  return [
    { name: "open_science_evidence_recalculation_cards_enabled", type: "gauge", help: "Whether recalculation cards are switched on (OPEN_SCIENCE_EVIDENCE_RECALCULATION_CARDS_ENABLED).", series: [{ value: config?.evidenceRecalculationCardsEnabled === true ? 1 : 0 }] },
    { name: "open_science_evidence_recalculation_outcomes_total", type: "counter", help: "Recalculation proofs by what became of them: published, or why no card was made.",
      series: RECALCULATION_OUTCOMES.map((outcome) => ({ value: status?.counters.outcomes[outcome] ?? 0, labels: { outcome } })) },
    { name: "open_science_evidence_recalculation_verdicts_total", type: "counter", help: "Published recalculation cards by verdict.",
      series: Object.keys({ reproduced: 0, reproduced_with_difference: 0, not_reproduced_adjudicated: 0 }).map((verdict) => ({ value: status?.counters.verdicts[verdict] ?? 0, labels: { verdict } })) },
  ];
}
