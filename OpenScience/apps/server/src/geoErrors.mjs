/**
 * 讲错我方 — the life of an error an engine tells about our product (build
 * spec §5 "Errors", plan §4.3, the owner's geo-correct-misstatements).
 *
 * Hidden knowledge:
 *
 * - **One error per fact per engine.** The fingerprint is the claim the
 *   statement contradicts (its `claim_key`, stable across claim versions),
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
 *   when a later judged answer to the same question on the same engine no
 *   longer carries it (EC-G03); seen again after closing, it reopens (and a
 *   severe one notifies again).
 *
 * @module geoErrors
 */

import { createHash } from "node:crypto";
import { GEO_METRICS, geoConstant, isOurCitation } from "@evimed/domain";
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

/**
 * The error's fingerprint: the contradicted claim's key, or (only without
 * one) the statement's folded wording.
 * @param {{ claimKey?: string | null, text?: string | null }} statement
 */
export function errorFingerprint(statement) {
  const basis = statement.claimKey ? `claim:${statement.claimKey}` : `text:${compactText(statement.text)}`;
  return createHash("sha256").update(basis).digest("hex").slice(0, 32);
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
    return { citedSource: { url: null, domain: null, attribute: null, basis: "not_attributable", candidates, checkedAt: now.toISOString() },
      action: null, responsible: "platform" };
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
 * Tell the owner of the project, once, about an urgent error.
 * @param {{ store: import("./geoMeasureStore.mjs").GeoMeasureStore, notify?: (event: Record<string, any>) => unknown, now?: () => Date }} deps
 * @param {ReturnType<typeof import("./geoMeasureStore.mjs").errorRow>} error
 * @param {{ projectId?: string, brandName?: string | null, claimStatement?: string | null, questionText?: string | null }} context
 * @param {string} [occurrence]  `first`, or `seen:<snapshot>` for an error seen again after it was closed
 */
async function notifyError(deps, error, context, occurrence = "first") {
  if (typeof deps.notify !== "function") return false;
  const now = (deps.now ?? (() => new Date()))();
  try {
    await deps.notify({
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
      idempotencyKey: `geo:wrong_ours:${error.id}:${occurrence}`,
    });
  } catch {
    return false;
  }
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
  if (!wrong.length) return out;
  const round = snapshot.roundId ? await deps.store.round(snapshot.roundId) : null;
  for (const statement of wrong) {
    const claim = context.claims.find((entry) => entry.id === statement.claimId) ?? null;
    const trace = await traceError(deps.store, snapshot, String(statement.text), context.owned, now);
    const { error, created } = await deps.store.upsertError({
      id: randomId("ge_"), userId: snapshot.userId, geoProjectId: snapshot.geoProjectId,
      fingerprint: errorFingerprint({ claimKey: statement.claimKey ?? claim?.key ?? null, text: statement.text }),
      engine: snapshot.engine, questionId: snapshot.questionId, snapshotId: snapshot.id, statement: String(statement.text).slice(0, 1_000),
      errorType: statement.errorType, severity: statement.severity, claimId: statement.claimId, evidenceQuote: statement.evidence ?? null,
      confirm: null, citedSource: trace.citedSource, action: trace.action, responsible: trace.responsible,
      now, askedAt: snapshot.askedAt ? new Date(snapshot.askedAt) : now,
    });
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
  return out;
}

/** Whether a set of statements repeats an error. @param {Array<Record<string, any>>} statements @param {string} fingerprint */
function repeatsError(statements, fingerprint) {
  return statements.some((statement) => statement?.verdict === "wrong" && errorFingerprint({ claimKey: statement.claimKey ?? null, text: statement.text }) === fingerprint);
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
  const error = await deps.store.error(errorId);
  if (!error || error.geoProjectId !== geoProjectId) throw new HttpError(404, "geo_error_not_found", "Error not found.");
  if (status !== "acting" && status !== "awaiting_remeasure") throw new HttpError(400, "geo_error_status_invalid", "An error moves to acting or awaiting re-measurement.");
  if (action !== null && !GEO_ERROR_ACTIONS.includes(action)) throw new HttpError(400, "geo_error_action_invalid", "Unknown error action.");
  if (error.status === "closed") throw new HttpError(409, "geo_error_closed", "The error is closed.");
  const now = (deps.now ?? (() => new Date()))();
  const next = error.status === "awaiting_remeasure" && status === "acting" ? "awaiting_remeasure" : status;
  await deps.store.updateError(errorId, {
    materials: [...error.materials, ...materials.map((material) => ({ ...material, at: now.toISOString() }))],
    ...(action ? { action } : {}), ...(responsible ? { responsible } : {}),
    status: next, updated_at: now,
  });
  return { id: errorId, status: next };
}

/**
 * The errors' housekeeping: notifications that did not go out, confirmation
 * rounds to queue and to read, errors a later answer shows gone, and traces
 * whose source the sources table now knows.
 * @param {{ store: import("./geoMeasureStore.mjs").GeoMeasureStore, config?: Record<string, any>, now?: () => Date,
 *   notify?: (event: Record<string, any>) => unknown, inclusion?: any }} deps
 */
export async function tickErrors(deps) {
  const { store } = deps;
  await store.ready();
  const now = (deps.now ?? (() => new Date()))();
  const counts = { notified: 0, confirmsQueued: 0, confirmsRead: 0, closed: 0, traced: 0 };
  /** @type {Map<string, any>} */
  const contexts = new Map();
  const context = async (/** @type {string} */ geoProjectId) => {
    if (!contexts.has(geoProjectId)) contexts.set(geoProjectId, await store.projectContext(geoProjectId));
    return contexts.get(geoProjectId);
  };

  if (typeof deps.notify === "function") {
    for (const error of await store.errorsToNotify([...GEO_NOTIFY_SEVERITIES], 20)) {
      const ctx = await context(error.geoProjectId);
      if (!ctx) continue;
      const claim = ctx.claims.find((/** @type {any} */ entry) => entry.id === error.claimId) ?? null;
      if (await notifyError(deps, error, { projectId: ctx.project.projectId, brandName: ctx.project.product?.brandName ?? null,
        claimStatement: claim?.statement ?? null })) counts.notified += 1;
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
    const seen = valid.filter((answer) => repeatsError(answer.statements, error.fingerprint)).length;
    const share = valid.length ? seen / valid.length : null;
    const stability = share === null || seen === 0 ? "unconfirmed" : share >= STABLE_SHARE ? "stable" : "sporadic";
    await store.updateError(error.id, {
      confirm: { ...error.confirm, status: "done", valid: valid.length, seen, share, stability, readAt: now.toISOString() },
    });
    counts.confirmsRead += 1;
  }

  for (const error of await store.errorsToClose(20)) {
    if (!error.questionId || !error.updatedAt) continue;
    const later = await store.laterJudgedAnswers(error.geoProjectId, error.questionId, error.engine, new Date(error.updatedAt));
    const latest = later.find((answer) => answer.status === "valid");
    if (!latest || repeatsError(latest.statements, error.fingerprint)) continue;
    await store.updateError(error.id, { status: "closed", closed_snapshot_id: latest.id, updated_at: now });
    counts.closed += 1;
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
