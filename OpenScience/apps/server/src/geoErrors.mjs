/**
 * 讲错我方 — the life of an error an engine tells about our product (build
 * spec §5 "Errors", plan §4.3, the owner's geo-correct-misstatements).
 *
 * Hidden knowledge:
 *
 * - **One error per fact version and applicability per engine.** The fingerprint is the claim the
 *   statement contradicts, its version and its recorded clinical conditions,
 *   not the statement's wording: an engine phrases the same mistake
 *   differently every time it is asked, and a wording fingerprint would turn
 *   one error into ten rows and make the confirmation round below never see
 *   its own error again. This is the owner's dedup rule ("按 fact_key ×
 *   provider 去重"); the build spec's "normalised statement + claimId" names
 *   the same fact and adds the wording, which is what breaks it. A wrong
 *   statement always has a claim — the judge's verdict is dropped otherwise
 *   (`geoJudge.verifyJudgement`) — so the wording is only a fallback.
 * - **Detected, notified, confirmed.** A new error at `EC_NOTIFY_MIN_SEVERITY`
 *   (S3) or above calls the `notify` hook at once — before any confirmation,
 *   the owner's rule — exactly once (`notified_at`; a failed call is retried
 *   by `tickErrors`). A `confirm` round then asks that question on that engine
 *   `EC_CONFIRM_REPEATS` (10) more times, fresh each time; the share of valid
 *   answers that repeat the error gives the stability: at or above
 *   `EC_STABLE_MIN_SHARE` stable, above zero sporadic, zero unconfirmed.
 * - **The trace has five columns**: the statement and its snapshot; the
 *   source the engine cited for it (the inline marker next to the sentence —
 *   an engine that lists sources outside the answer cannot be attributed and
 *   says so, never guesses); that source's attribute (owned, partner outlet,
 *   encyclopedia, content farm, impostor, or none when nothing was retrieved);
 *   the action that attribute calls for; who is responsible. A third-party
 *   page not yet known is left unattributed until the sources table knows it
 *   — the owner's method reads the page before choosing a route, and that
 *   reading is the content run's, which fills `materials` later.
 * - **Closed only by measurement.** An error that has been acted on closes
 *   when a later fully judged answer explicitly verifies the same claim, version
 *   and applicability as correct (EC-G03); seen again after closing, it reopens (and a
 *   severe one notifies again).
 *
 * @module geoErrors
 */

import { errorFingerprint } from "./geoErrorIdentity.mjs";
import { GEO_METRICS, geoConstant, isOurCitation, geoClaimApplicability, geoClaimAssessmentIdentity, geoClaimForStatement, geoJudgementCoverage } from "@evimed/domain";
import { compactText } from "./geoParse.mjs";
import { enqueueRound, measurableEngines } from "./geoProbeQueue.mjs";
import { HttpError, randomId } from "./security.mjs";

export const GEO_ERROR_STATUSES = Object.freeze(["open", "acting", "awaiting_remeasure", "closed"]);
export const GEO_ERROR_ACTIONS = Object.freeze(["own_edit", "correction_letter", "encyclopedia_fix", "report_and_cover", "no_contact", "continuous_supply"]);
const SEVERITIES = Object.freeze(["S0", "S1", "S2", "S3", "S4"]);

/** @param {string} name @param {any} fallback */
function catalogue(name, fallback) {
  try { return geoConstant(name); } catch { return fallback; }
}

/** Severities that notify when detected. */
export const GEO_NOTIFY_SEVERITIES = Object.freeze(SEVERITIES.slice(Math.max(0, SEVERITIES.indexOf(String(catalogue("EC_NOTIFY_MIN_SEVERITY", "S3"))))));
const STABLE_SHARE = Number(catalogue("EC_STABLE_MIN_SHARE", 0.5));
/** How old an error without a confirmation round must be before the housekeeping queues one. */
export const CONFIRM_GRACE_MS = 60_000;

/** What each source attribute calls for, and who acts (the owner's route table). */
const ROUTES = Object.freeze({
  owned: { action: "own_edit", responsible: "client" },
  partner: { action: "correction_letter", responsible: "platform" },
  encyclopedia: { action: "encyclopedia_fix", responsible: "platform" },
  farm: { action: "report_and_cover", responsible: "platform" },
  impostor: { action: "no_contact", responsible: "client" },
  none: { action: "continuous_supply", responsible: "platform" },
});

export { errorFingerprint } from "./geoErrorIdentity.mjs";

/** Resolve the clinical identity actually recorded by this error, never an arbitrary same-id variant.
 * @param {any[]} statements @param {any} error @param {any[]} [frozenClaims] @param {{ includeNonWrong?: boolean }} [options] */
export function geoErrorOrigin(statements, error, frozenClaims = [], { includeNonWrong = false } = {}) {
  const candidates = statements.filter(statement => (includeNonWrong || statement.verdict === "wrong") && statement.claimId === error.claimId).map(statement => {
    if (statement.claimVersion != null && statement.applicability) return statement;
    const frozen = geoClaimForStatement(frozenClaims, statement);
    return frozen ? { ...statement, claimVersion: frozen.version ?? null, applicability: geoClaimApplicability(frozen) } : statement;
  });
  const exact = candidates.filter(statement => errorFingerprint(statement) === error.fingerprint);
  const matches = exact.length ? exact : candidates.filter(statement => errorFingerprint({ claimKey: statement.claimKey, text: statement.text }) === error.fingerprint);
  return new Set(matches.map(geoClaimAssessmentIdentity)).size === 1 ? matches[0] ?? null : null;
}

/** One clinical identity projection for analysis, diagnosis, and correction drafts. Current context is never an original substitute. */
export function geoErrorClinicalContext(row) {
  const original = geoErrorOrigin(row.origin_statements ?? [], { claimId: row.claim_id, fingerprint: row.fingerprint }, row.origin_claims ?? [], { includeNonWrong: true });
  const claim = original ? geoClaimForStatement(row.origin_claims ?? [], original) : null;
  return {
    claimVersion: original?.claimVersion ?? null,
    applicability: original?.applicability ?? null,
    originalErrorAssessment: original ? { statement: original, claim: claim ?? null, temporalBasis: "first_preserved_error_assessment" } : null,
    currentClaim: { version: row.claim_version ?? null, applicability: row.applicability ?? null, temporalBasis: "current_claim_context" },
  };
}

/** A business resolution is supported only by this complete, explicit and quote-anchored reading.
 * @param {any} original @param {any} answer @param {any} basis */
export function geoErrorResolutionSatisfied(original, answer, basis) {
  if (!original?.claimVersion || !original.applicability || answer?.status !== "valid" || !answer.judgedAt
    || geoJudgementCoverage(answer) !== "complete" || !basis) return false;
  const identity = geoClaimAssessmentIdentity(original);
  if (geoClaimAssessmentIdentity(basis) !== identity) return false;
  const readings = (answer.statements ?? []).filter(statement => geoClaimAssessmentIdentity(statement) === identity);
  return readings.length > 0 && readings.every(statement => statement.verdict === "correct") && readings.some(statement => compactText(statement.evidence).length >= 4
    && compactText(basis.quote).includes(compactText(statement.evidence)) && compactText(answer.answerText).includes(compactText(statement.text)));
}

const MARKERS = [/\[(\d{1,2})\]/gu, /\[\^(\d{1,2})\]/gu, /【(\d{1,2})】/gu, /\[citation:(\d{1,2})\]/gu, /\^(\d{1,2})\^/gu, /［(\d{1,2})］/gu];

/**
 * The citation the engine gave for a sentence: the first inline marker in the
 * sentence or just after it. Null when the sentence carries none.
 * @param {string} answer @param {string} sentence @param {Array<{ url?: string, domain?: string }>} citations
 */
export function citedFor(answer, sentence, citations) {
  const index = answer.indexOf(sentence);
  if (index < 0) return null;
  const window = answer.slice(index, index + sentence.length + 16);
  let best = null;
  for (const pattern of MARKERS) {
    for (const match of window.matchAll(pattern)) {
      const n = Number(match[1]);
      if (n >= 1 && n <= citations.length && (best === null || /** @type {number} */ (match.index) < best.at)) best = { at: /** @type {number} */ (match.index), n };
    }
  }
  return best ? citations[best.n - 1] : null;
}

/**
 * The source attribute of a cited page for this project.
 * @param {import("./geoMeasureStore.mjs").GeoMeasureStore} store @param {string} geoProjectId
 * @param {{ url?: string, domain?: string }} citation @param {{ domains?: string[], urls?: string[] }} owned
 * @returns {Promise<keyof typeof ROUTES | null>}
 */
async function attributeOf(store, geoProjectId, citation, owned) {
  if (isOurCitation(citation, owned)) return "owned";
  const domain = String(citation.domain ?? "").toLowerCase();
  if (!domain) return null;
  const source = await store.sourceForDomain(geoProjectId, domain);
  if (source?.layer === "owned") return "owned";
  if (source?.impostor) return "impostor";
  if (await store.placedOnDomain(geoProjectId, domain)) return "partner";
  if (source?.kind === "encyclopedia") return "encyclopedia";
  if (source?.blacklistReason) return "farm";
  return null;
}

/**
 * What to do about a wrong statement no single source can be pinned on (the
 * answer cites several and marks none beside the sentence): the route the
 * candidates call for, by what we can reach first — our own page among them
 * (the client edits it), else an encyclopedia entry (the platform files a
 * fix), else the coverage layer is supplied with the right content. G7,
 * 2026-09-26: 37 of 66 errors had no action at all, so nothing ever moved
 * them. The error stays unattributed; only its disposition is a default.
 * @param {import("./geoMeasureStore.mjs").GeoMeasureStore} store @param {string} geoProjectId
 * @param {string[]} candidates @param {{ domains?: string[], urls?: string[] }} owned
 * @returns {Promise<{ action: string, responsible: string }>}
 */
async function candidateRoute(store, geoProjectId, candidates, owned) {
  const attributes = new Set();
  for (const domain of candidates) attributes.add(await attributeOf(store, geoProjectId, { domain }, owned));
  for (const attribute of /** @type {const} */ (["owned", "encyclopedia"])) {
    if (attributes.has(attribute)) return ROUTES[attribute];
  }
  return ROUTES.none;
}

/**
 * The trace columns 2–5 for one wrong statement in one snapshot.
 * @param {import("./geoMeasureStore.mjs").GeoMeasureStore} store
 * @param {{ geoProjectId: string, answerText: string | null, citations: any[] }} snapshot @param {string} sentence
 * @param {{ domains?: string[], urls?: string[] }} owned @param {Date} now
 */
export async function traceError(store, snapshot, sentence, owned, now) {
  const citations = Array.isArray(snapshot.citations) ? snapshot.citations : [];
  if (!citations.length) {
    return { citedSource: { url: null, domain: null, attribute: "none", basis: "no_retrieval", checkedAt: now.toISOString() }, ...ROUTES.none };
  }
  const cited = citedFor(String(snapshot.answerText ?? ""), sentence, citations);
  if (!cited) {
    const candidates = [...new Set(citations.map((citation) => String(citation?.domain ?? "")).filter(Boolean))].slice(0, 5);
    const fallback = await candidateRoute(store, snapshot.geoProjectId, candidates, owned);
    return { citedSource: { url: null, domain: null, attribute: null, basis: "not_attributable", candidates, checkedAt: now.toISOString() },
      ...fallback };
  }
  const attribute = await attributeOf(store, snapshot.geoProjectId, cited, owned);
  const route = attribute ? ROUTES[attribute] : { action: null, responsible: "platform" };
  return {
    citedSource: { url: cited.url ?? null, domain: cited.domain ?? null, attribute, basis: "inline_marker", checkedAt: now.toISOString() },
    ...route,
  };
}

/** @param {string} engine */
const engineLabel = (engine) => /** @type {Record<string, { display_name: string }>} */ (GEO_METRICS.engines)[engine]?.display_name ?? engine;

/**
 * Which telling of an error a notice is: `first`, or `seen:<snapshot>` for the sighting that brought it back (an error reopened after
 * closing, or seen again before its first notice went out — the parse tick tells it under that sighting's snapshot). A notice that is
 * tried again names the same telling, so the inbox's own key keeps it one item: tried again as `first`, the notice of a reopened error
 * read back the item of its first telling and the reopening was never told.
 * @param {{ firstSnapshotId?: string | null, lastSnapshotId?: string | null }} error
 */
export function errorNoticeOccurrence(error) {
  // An error a re-assessment brought back is told as that re-assessment (`judgment:<version>`), whichever pass tells it.
  const correction = /** @type {any} */ (error).judgmentCorrection;
  if (correction?.kind === "judgment_reactivated" && correction?.assessmentVersion) return `judgment:${correction.assessmentVersion}`;
  const { firstSnapshotId: first, lastSnapshotId: last } = error;
  return first && last && last !== first ? `seen:${last}` : "first";
}

/** The inbox key of an error's notice. @param {{ id: string, firstSnapshotId?: string | null, lastSnapshotId?: string | null }} error */
export function errorNoticeKey(error) {
  return `geo:wrong_ours:${error.id}:${errorNoticeOccurrence(error)}`;
}

/** How long a notice the inbox refused waits before it is tried again: a minute, doubling, at most an hour. @param {number} refusals */
export function notifyRetryDelayMs(refusals) {
  return Math.min(3_600_000, 60_000 * 2 ** Math.max(0, refusals - 1));
}

/**
 * Tell the owner of the project, once, about an urgent error. The error is
 * marked told (`notified_at`) only when the notice was delivered or there was
 * nothing to deliver; a notice the inbox refused (the hook answers `false`)
 * leaves it untold, to be tried again by `tickErrors` after a wait and by the
 * orchestrator's own pass over untold errors. 2026-10-25: a refusal used to
 * mark the error told, and an S3/S4 notice the inbox did not take was lost.
 * @param {{ store: import("./geoMeasureStore.mjs").GeoMeasureStore, notify?: (event: Record<string, any>) => unknown, now?: () => Date,
 *   state?: { notifyRetry?: Map<string, { refusals: number, at: number }> } }} deps
 * @param {ReturnType<typeof import("./geoMeasureStore.mjs").errorRow>} error
 * @param {{ projectId?: string, brandName?: string | null, claimStatement?: string | null, questionText?: string | null }} context
 * @param {string} [occurrence]  `first`, or `seen:<snapshot>` for an error seen again after it was closed
 */
async function notifyError(deps, error, context, occurrence = "first") {
  if (typeof deps.notify !== "function") return false;
  const now = (deps.now ?? (() => new Date()))();
  const retry = deps.state?.notifyRetry ?? null;
  let delivered;
  try {
    const reassessed = errorNoticeOccurrence(error);
    const noticeOccurrence = reassessed.startsWith("judgment:") ? reassessed : occurrence;
    delivered = await deps.notify({
      kind: "wrong_ours",
      severity: "safety",
      userId: error.userId,
      geoProjectId: error.geoProjectId,
      projectId: context.projectId ?? null,
      errorId: error.id,
      engine: error.engine,
      engineLabel: engineLabel(error.engine),
      brandName: context.brandName ?? null,
      statement: error.statement,
      errorType: error.errorType,
      level: error.severity,
      severityBasis: error.severityBasis,
      claimStatement: context.claimStatement ?? null,
      evidenceQuote: error.evidenceQuote,
      questionText: context.questionText ?? null,
      snapshotId: error.lastSnapshotId ?? error.firstSnapshotId,
      idempotencyKey: `geo:wrong_ours:${error.id}:${noticeOccurrence}`,
    });
  } catch {
    delivered = false;
  }
  if (delivered === false) {
    if (retry) {
      const refusals = (retry.get(error.id)?.refusals ?? 0) + 1;
      if (retry.size > 5_000) retry.clear();
      retry.set(error.id, { refusals, at: now.getTime() + notifyRetryDelayMs(refusals) });
    }
    return false;
  }
  retry?.delete(error.id);
  await deps.store.updateError(error.id, { notified_at: now });
  return true;
}

/**
 * Queue (or join) the confirmation round of an error: its question on its
 * engine, `EC_CONFIRM_REPEATS` fresh asks. A confirmation round already open
 * for the same question and engine is shared.
 * @param {Parameters<typeof enqueueRound>[0]} deps
 * @param {ReturnType<typeof import("./geoMeasureStore.mjs").errorRow>} error
 * @param {{ roundId?: string | null, kind?: string | null, ref?: any } | null} [origin]  the round the error was seen in
 * @returns {Promise<Record<string, unknown> | null>} the `confirm` value, or null when no round could be queued
 */
async function confirmationFor(deps, error, origin = null) {
  const repeats = Number(catalogue("EC_CONFIRM_REPEATS", 10));
  if (!error.questionId) return { status: "unavailable", stability: "unconfirmed", asked: 0, reason: "no_question" };
  if (!measurableEngines(deps).includes(error.engine)) return { status: "unavailable", stability: "unconfirmed", asked: 0, reason: "engine_unavailable" };
  if (origin?.kind === "confirm" && origin.ref?.questionId === error.questionId && origin.ref?.engine === error.engine && origin.roundId) {
    return { status: "pending", roundId: origin.roundId, asked: repeats, valid: null, seen: null, stability: "unconfirmed" };
  }
  const open = await deps.store.openRoundWithRef(error.geoProjectId, "confirm", { questionId: error.questionId, engine: error.engine });
  if (open) return { status: "pending", roundId: open, asked: repeats, valid: null, seen: null, stability: "unconfirmed" };
  try {
    const round = await enqueueRound(deps, {
      geoProjectId: error.geoProjectId, kind: "confirm", questionIds: [error.questionId], engines: [error.engine], repeat: repeats,
      ref: { errorId: error.id, questionId: error.questionId, engine: error.engine, reason: "confirm" },
    });
    return { status: "pending", roundId: round.roundId, asked: round.planned, valid: null, seen: null, stability: "unconfirmed" };
  } catch (cause) {
    if (cause instanceof HttpError) return { status: "unavailable", stability: "unconfirmed", asked: 0, reason: cause.code };
    return null;
  }
}

/**
 * Record the 讲错我方 of one judged answer: create or update an error per
 * contradicted fact, notify the urgent new ones, queue their confirmation.
 * @param {{ store: import("./geoMeasureStore.mjs").GeoMeasureStore, now?: () => Date, notify?: (event: Record<string, any>) => unknown, inclusion?: any }} deps
 * @param {{ snapshot: { id: string, userId: string, geoProjectId: string, roundId: string | null, questionId: string | null, engine: string,
 *   askedAt: string | null, answerText: string | null, citations: any[] }, statements: Array<Record<string, any>>,
 *   context: NonNullable<Awaited<ReturnType<import("./geoMeasureStore.mjs").GeoMeasureStore["projectContext"]>>>,
 *   question?: { text: string } | null }} input
 * @returns {Promise<{ created: number, seen: number, notified: number }>}
 */
export async function recordErrorsFromFacts(deps, { snapshot, statements, context, question = null }) {
  const now = (deps.now ?? (() => new Date()))();
  const out = { created: 0, seen: 0, notified: 0 };
  const wrong = statements.filter((statement) => statement.verdict === "wrong");
  await deps.store.reconcileLegacyErrors?.(snapshot, statements);
  // Recorded below, the facts row stops owing them (`errorsRecorded`); one that throws first leaves the debt for the housekeeping.
  const round = snapshot.roundId ? await deps.store.round(snapshot.roundId) : null;
  for (const statement of wrong) {
    const claim = geoClaimForStatement(context.claims, statement);
    const trace = await traceError(deps.store, snapshot, String(statement.text), context.owned, now);
    const { error, created } = await deps.store.upsertError({
      id: randomId("ge_"), userId: snapshot.userId, geoProjectId: snapshot.geoProjectId,
      fingerprint: errorFingerprint({ ...statement, claimKey: statement.claimKey ?? claim?.key ?? null }),
      engine: snapshot.engine, questionId: snapshot.questionId, snapshotId: snapshot.id, statement: String(statement.text).slice(0, 1_000),
      verifiedStatement: statement, errorType: statement.errorType, severity: statement.severity, claimId: statement.claimId, evidenceQuote: statement.evidence ?? null,
      confirm: null, citedSource: trace.citedSource, action: trace.action, responsible: trace.responsible,
      now, askedAt: snapshot.askedAt ? new Date(snapshot.askedAt) : now,
    });
    if (!error) continue;
    if (!created) {
      out.seen += 1;
      if (!error.notifiedAt && GEO_NOTIFY_SEVERITIES.includes(String(error.severity)) && error.status !== "closed") {
        // Not notified yet and seen again: reopened after closing (or its first notice failed).
        if (await notifyError(deps, error, { projectId: context.project.projectId, brandName: context.project.product?.brandName ?? null,
          claimStatement: claim?.statement ?? null, questionText: question?.text ?? null }, `seen:${snapshot.id}`)) out.notified += 1;
      }
      continue;
    }
    out.created += 1;
    // Severity is graded at detection and urgent ones are told before any confirmation.
    if (GEO_NOTIFY_SEVERITIES.includes(String(error.severity))) {
      if (await notifyError(deps, error, { projectId: context.project.projectId, brandName: context.project.product?.brandName ?? null,
        claimStatement: claim?.statement ?? null, questionText: question?.text ?? null })) out.notified += 1;
    }
    const confirm = await confirmationFor(deps, error, round ? { roundId: round.id, kind: round.kind, ref: round.ref } : null);
    if (confirm) await deps.store.updateError(error.id, { confirm });
  }
  await deps.store.errorsRecorded(snapshot.id, statements);
  return out;
}

/** Whether a set of statements repeats the exact error identity. @param {Array<Record<string, any>>} statements @param {Record<string, any> | null} original */
function repeatsError(statements, original) {
  return Boolean(original && statements.some(statement => statement.verdict === "wrong" && geoClaimAssessmentIdentity(statement) === geoClaimAssessmentIdentity(original)));
}

/**
 * Mark an error acted on — materials attached by a content run, an action
 * chosen — and move it forward: `open` → `acting` → `awaiting_remeasure`.
 * Closing is measurement's alone (`tickErrors`).
 * @param {{ store: import("./geoMeasureStore.mjs").GeoMeasureStore, now?: () => Date }} deps
 * @param {{ geoProjectId: string, errorId: string, materials?: Array<Record<string, unknown>>, action?: string | null,
 *   responsible?: string | null, status?: "acting" | "awaiting_remeasure" }} change
 */
export async function noteErrorAction(deps, { geoProjectId, errorId, materials = [], action = null, responsible = null, status = "acting" }) {
  if (status !== "acting" && status !== "awaiting_remeasure") throw new HttpError(400, "geo_error_status_invalid", "An error moves to acting or awaiting re-measurement.");
  if (action !== null && !GEO_ERROR_ACTIONS.includes(action)) throw new HttpError(400, "geo_error_action_invalid", "Unknown error action.");
  const now = (deps.now ?? (() => new Date()))();
  return deps.store.appendErrorAction(geoProjectId, errorId, { materials: materials.map(material => ({ ...material, at: now.toISOString() })), action, responsible, status, now });
}

/** How many confirmation rounds one error is given, the first included: a skipped one is asked again, never without bound. */
export const GEO_CONFIRM_TRIES = 3;

/**
 * Whether an engine is back after `since`: this deployment can ask it, the
 * breaker does not hold it paused, and either the breaker saw it answer a
 * re-check since, or it gave a counted answer since (the durable sign, for a
 * process that restarted).
 * @param {{ store: import("./geoMeasureStore.mjs").GeoMeasureStore, inclusion?: any, state?: { breaker?: any } }} deps
 * @param {string} engine @param {Date} since
 */
async function engineBack(deps, engine, since) {
  if (!measurableEngines(deps).includes(engine)) return false;
  const breaker = deps.state?.breaker ?? null;
  if (breaker?.paused?.().includes(engine)) return false;
  if (breaker?.resumedAfter?.(engine, since.getTime())) return true;
  return deps.store.engineAnsweredSince(engine, since);
}

/**
 * The errors' housekeeping: notifications that did not go out, confirmation
 * rounds to queue, to read and — when their engine was not asked — to queue
 * again once it is back, errors a later answer shows gone, and traces whose
 * source the sources table now knows.
 * @param {{ store: import("./geoMeasureStore.mjs").GeoMeasureStore, config?: Record<string, any>, now?: () => Date,
 *   notify?: (event: Record<string, any>) => unknown, inclusion?: any, state?: { breaker?: any, notifyRetry?: Map<string, { refusals: number, at: number }> } }} deps
 */
export async function tickErrors(deps) {
  const { store } = deps;
  await store.ready();
  const now = (deps.now ?? (() => new Date()))();
  const counts = { recorded: 0, notified: 0, confirmsQueued: 0, confirmsRead: 0, confirmsRequeued: 0, closed: 0, traced: 0, disposed: 0 };
  /** @type {Map<string, any>} */
  const contexts = new Map();
  const context = async (/** @type {string} */ geoProjectId) => {
    if (!contexts.has(geoProjectId)) contexts.set(geoProjectId, await store.projectContext(geoProjectId));
    return contexts.get(geoProjectId);
  };

  // Wrong statements the ledger does not hold (Q-6): the facts were written and the process stopped, or a write failed, before the error
  // was, and nothing parses an answer twice. The facts row owes the error until it is recorded; a minute's grace leaves a fresh one to
  // the parse tick that wrote it. The call is the parse tick's own and idempotent (one error per fact per engine; the notice and the
  // confirmation round are keyed), so a row that was recorded after all is recorded once.
  /** @type {Map<string, any>} */
  const owedContexts = new Map();
  /** @type {Map<string, Map<string, any>>} */
  const owedQuestions = new Map();
  for (const owed of await store.factsOwingErrors(20, new Date(now.getTime() - CONFIRM_GRACE_MS))) {
    const { snapshot } = owed;
    const key = `${snapshot.geoProjectId}:${snapshot.roundId ?? "live"}`;
    if (!owedContexts.has(key)) owedContexts.set(key, await store.projectContext(snapshot.geoProjectId, snapshot.roundId));
    const ctx = owedContexts.get(key);
    if (!ctx) continue;
    if (!owedQuestions.has(snapshot.geoProjectId)) {
      owedQuestions.set(snapshot.geoProjectId, new Map((await store.questions(snapshot.geoProjectId)).map((/** @type {any} */ question) => [question.id, question])));
    }
    const question = owedQuestions.get(snapshot.geoProjectId)?.get(String(snapshot.questionId)) ?? null;
    const recorded = await recordErrorsFromFacts(deps, { snapshot, statements: owed.statements, context: ctx, question });
    counts.recorded += recorded.created;
    counts.notified += recorded.notified;
  }

  // Untold urgent errors, at most 20 tries a tick, each refused one after its wait (`notifyRetryDelayMs`): an inbox that is down is
  // not asked every five seconds, and the errors waiting behind a refused one are reached.
  if (typeof deps.notify === "function") {
    const retry = deps.state?.notifyRetry ?? null;
    let tried = 0;
    for (const error of await store.errorsToNotify([...GEO_NOTIFY_SEVERITIES], 100)) {
      if (tried >= 20) break;
      if ((retry?.get(error.id)?.at ?? 0) > now.getTime()) continue;
      const ctx = await context(error.geoProjectId);
      if (!ctx) continue;
      tried += 1;
      const preserved = (await store.query(`SELECT f.statements,r.ref FROM evimed_geo.facts f JOIN evimed_geo.snapshots s ON s.id=f.snapshot_id
        LEFT JOIN evimed_geo.rounds r ON r.id=s.round_id WHERE f.snapshot_id=$1`, [error.firstSnapshotId])).rows[0];
      const original = geoErrorOrigin(preserved?.statements ?? [], error, preserved?.ref?.evaluationBasis?.claims ?? []);
      const claim = original ? geoClaimForStatement(preserved?.ref?.evaluationBasis?.claims ?? ctx.claims, original) : null;
      if (await notifyError(deps, error, { projectId: ctx.project.projectId, brandName: ctx.project.product?.brandName ?? null,
        claimStatement: claim?.statement ?? null }, errorNoticeOccurrence(error))) counts.notified += 1;
    }
  }

  // A minute's grace: a new error's own parse tick queues its confirmation.
  for (const error of await store.errorsWithoutConfirm(20, new Date(now.getTime() - CONFIRM_GRACE_MS))) {
    const confirm = await confirmationFor(deps, error);
    if (!confirm) continue;
    await store.updateError(error.id, { confirm });
    if (confirm.status === "pending") counts.confirmsQueued += 1;
  }

  for (const error of await store.errorsAwaitingConfirm(20)) {
    const roundId = String(error.confirm?.roundId ?? "");
    if (error.roundStatus === "cancelled") {
      await store.updateError(error.id, { confirm: { ...error.confirm, status: "cancelled", stability: "unconfirmed" } });
      counts.confirmsRead += 1;
      continue;
    }
    const answers = (await store.roundAnswers(roundId))
      .filter((answer) => answer.questionId === error.questionId && answer.engine === error.engine);
    // Wait until every answer the round got has been read.
    if (answers.some((answer) => (answer.status === "valid" || answer.status === "refusal") && !answer.parsed)) continue;
    const valid = answers.filter((answer) => (answer.status === "valid" && answer.judged) || answer.status === "refusal");
    // A round that got no answer from the engine — never asked it (paused,
    // or no channel), or asked and heard nothing back (the probe host down,
    // every ask failed or suspect) — confirmed nothing: the confirmation is
    // skipped, not read as 「未确认」, and it is asked again once the engine is
    // back (G1; the second half 2026-10-25, when every ask of a round failed
    // at an unreachable host and the error read 「未确认」 for good). The round
    // itself stays as it was — a new round is queued, and no count of this
    // one is rewritten.
    if (!answers.some((answer) => answer.status === "valid" || answer.status === "refusal")) {
      const skippedRounds = [...new Set([...(Array.isArray(error.confirm?.skippedRounds) ? error.confirm.skippedRounds : []), roundId])];
      await store.updateError(error.id, {
        confirm: { ...error.confirm, status: "skipped", stability: "unconfirmed", tries: Number(error.confirm?.tries ?? 1), skippedRounds,
          skippedAt: now.toISOString() },
      });
      counts.confirmsRead += 1;
      continue;
    }
    const origin = (await store.query(`SELECT f.statements,r.ref FROM evimed_geo.facts f JOIN evimed_geo.snapshots s ON s.id=f.snapshot_id
      LEFT JOIN evimed_geo.rounds r ON r.id=s.round_id WHERE f.snapshot_id=$1 AND f.geo_project_id=$2 AND f.user_id=$3`,
      [error.firstSnapshotId, error.geoProjectId, error.userId])).rows[0];
    const original = geoErrorOrigin(origin?.statements ?? [], error, origin?.ref?.evaluationBasis?.claims ?? []);
    const seen = original?.claimVersion && original.applicability ? valid.filter(answer => repeatsError(answer.statements, original)).length : null;
    const share = valid.length && seen !== null ? seen / valid.length : null;
    const stability = share === null || seen === 0 ? "unconfirmed" : share >= STABLE_SHARE ? "stable" : "sporadic";
    await store.updateError(error.id, {
      confirm: { ...error.confirm, status: "done", valid: valid.length, seen, share, stability, readAt: now.toISOString() },
    });
    counts.confirmsRead += 1;
  }

  for (const error of await store.errorsConfirmSkipped(20, GEO_CONFIRM_TRIES)) {
    const since = new Date(String(error.confirm?.skippedAt ?? error.updatedAt ?? now.toISOString()));
    if (!(await engineBack(deps, error.engine, since))) continue;
    const confirm = await confirmationFor(deps, error);
    if (!confirm || confirm.status !== "pending") continue;
    await store.updateError(error.id, {
      confirm: { ...confirm, tries: Number(error.confirm?.tries ?? 1) + 1, skippedRounds: error.confirm?.skippedRounds ?? [] },
    });
    counts.confirmsRequeued += 1;
  }

  for (const error of await store.errorsToClose(20)) {
    if (!error.questionId || !error.updatedAt) continue;
    const later = await store.laterJudgedAnswers(error.id);
    const latest = later[0];
    if (!latest || latest.status !== "valid" || !latest.judgedAt || geoJudgementCoverage(latest) !== "complete") continue;
    const origin = (await store.query(`SELECT f.statements,r.ref FROM evimed_geo.facts f JOIN evimed_geo.snapshots s ON s.id=f.snapshot_id
      LEFT JOIN evimed_geo.rounds r ON r.id=s.round_id WHERE f.snapshot_id=$1 AND f.geo_project_id=$2 AND f.user_id=$3`,
      [error.firstSnapshotId, error.geoProjectId, error.userId])).rows[0];
    const original = geoErrorOrigin(origin?.statements ?? [], error, origin?.ref?.evaluationBasis?.claims ?? []);
    if (!original?.claimVersion || !original.applicability) continue;
    const basisContext = await store.projectContext(error.geoProjectId, latest.roundId);
    const basis = geoClaimForStatement(basisContext?.claims ?? [], original);
    if (!geoErrorResolutionSatisfied(original, latest, basis)) continue;
    if (await store.closeErrorIfCurrent(error, latest, now)) counts.closed += 1;
  }

  // An unattributable error recorded before it got a default disposition gets one now.
  for (const error of await store.errorsWithoutDisposition(20)) {
    const ctx = await context(error.geoProjectId);
    if (!ctx) continue;
    const candidates = Array.isArray(error.citedSource?.candidates) ? error.citedSource.candidates.map(String) : [];
    const route = await candidateRoute(store, error.geoProjectId, candidates, ctx.owned);
    await store.updateError(error.id, { action: route.action, responsible: route.responsible });
    counts.disposed += 1;
  }

  for (const error of await store.errorsToTrace(20)) {
    if (error.citedSource?.checkedAt && now.getTime() - Date.parse(String(error.citedSource.checkedAt)) < 3_600_000) continue;
    const ctx = await context(error.geoProjectId);
    if (!ctx) continue;
    const attribute = await attributeOf(store, error.geoProjectId, /** @type {any} */ (error.citedSource), ctx.owned);
    const route = attribute ? ROUTES[attribute] : null;
    await store.updateError(error.id, {
      cited_source: { ...error.citedSource, attribute, checkedAt: now.toISOString() },
      ...(route && !error.action ? { action: route.action, responsible: route.responsible } : {}),
    });
    if (attribute) counts.traced += 1;
  }
  return counts;
}
