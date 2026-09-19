import { createHash } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  HttpError,
  assertNoSymlinkPath,
  normalizeWorkspaceRelativePath,
  openScopedFileNoFollow,
  randomId,
  readTextFileNoFollow,
  safeId,
  withProjectStorageMutation,
  writeFileAtomicNoFollow,
  writeFileExclusiveNoFollow,
} from "./security.mjs";
import {
  citationIntegrityIssues,
  claimVerification,
  clinicalEvidencePackageErrorCode,
  validateClinicalEvidencePackage,
} from "./clinicalEvidenceQuality.mjs";
import { delegatedChildrenOf, socketToolResult } from "./dshRuntimeAdapter.mjs";
import {
  clinicalSafetyCautionNotice,
  describedQualityNotices,
  maxQualityNotices,
  normalizeQualityNotices,
  noticeCodePattern,
  noticeText,
  runNotice,
  runSideDegradedNotice,
} from "./runNotices.mjs";
import { describeRunArtifacts } from "./runArtifacts.mjs";
import { normalizeRunEstimate, routeReasonText } from "./runRoute.mjs";
import {
  assembleRunProgress,
  claimSummaryOf,
  foldToolEvent,
  normalizeRunUsage,
  normalizeStoredDeliverables,
  normalizeStoredProgress,
  observedCallsFromHistory,
  progressChildren,
  progressDigest,
  runDeliverables,
} from "./runProgress.mjs";
// The three classifications of a failure — repairable package, recoverable
// source, terminal source — moved into the domain when the run side started
// needing them too. They are re-exported here because the ledger's callers and
// its tests have always imported them from this module, and because a second
// definition is exactly the drift the move was made to stop.
import {
  CONNECTOR_CREDENTIALS,
  CONNECTOR_CREDENTIAL_IDS,
  PLAN_ITEM_STATES,
  SOCKET_TOOL_NAMES,
  capabilityBriefTask,
  capabilityTitle,
  gateIssueSeverity,
  isContractKind,
  isMcpToolName,
  recoverableEvidenceSourceErrorCodes,
  repairableEvidencePackageErrorCodes,
  runPhase,
  terminalEvidenceSourceErrorCodes,
  transition as domainTransition,
  transitionEvents,
  validateDeliveryReceipt,
  runStateFileFor,
  workspaceLayout,
} from "@evimed/domain";

// Pharmacist-authored cautions, shown to the reader as SAFETY notices (S5,
// 2026-09-18). Imported on a line of its own so the ledger's own import list
// stays as it is.
import { clinicalSafetyCautionHits } from "@evimed/domain";
// The evidence type stamped beside each preserved capture (C8), which a
// claim's structured GRADE certainty is read against (S6, 2026-09-18). A line
// of its own for the same reason as the one above.
import { sourceTypeOfSidecar, sourceTypeSidecarPath } from "@evimed/domain";

export { repairableEvidencePackageErrorCodes, recoverableEvidenceSourceErrorCodes, terminalEvidenceSourceErrorCodes };

/** @typedef {import('./runNotices.mjs').StoredNotice} StoredNotice */

// Exported for its own direct test: constructing a ledger event sequence that
// reaches this function while also being illegal under the *phase* table, but
// not under any of `foldEvents`' own (much stricter) corruption checks, is not
// reachable through the public `AgentRunStore` API — which is the point of
// those checks — so the adjacency logic itself needs a seam.
export { runPhaseHistory };

// Exported for its own test: the two-kernel resolution rule is not reachable
// from the public API without standing up a whole run, and the rule itself is
// what a future kernel change would break.
export { readRequiredFile as readRequiredFileForTest };
export { serializeNext as ledgerTextForTest };
// A notice the platform raises about a run, for the composition root's own
// notices (memory extraction) — one constructor, so a notice raised there is
// shaped like every other one.
export { runNotice };

const ledgerFileName = "runs.jsonl";
const terminalStatuses = new Set(["succeeded", "failed", "canceled"]);
const startFields = new Set(["sessionId"]);
const dispatchFields = new Set([
  "sessionId",
  "dispatchId",
  "automated",
  "estimatedMinutes",
  "question",
  "effectiveAgentId",
  "effectiveAgentVersion",
  "effectiveRuntimeAgent",
  "effectiveRouteReason",
]);
const dispatchStatuses = new Set(["dispatching", "accepted", "unknown", "rejected"]);
const defaultMaxRuns = 1000;
const defaultMaxBytes = 1024 * 1024;
// How many gate issues one deliverable frame carries. The repair loop sends the
// whole list to the run; a reader needs the shape of the problem, not 300 lines.
const maxDeliverableIssues = 40;
const maxArtifacts = 64;
const maxObservedChildSessions = 64;

// Which rule picked the agent: `matched:adr-analysis`, `matched:named:peer-review`
// or `llm:0.83`. Recording the decision without the reason makes a wrong route
// indistinguishable from a right one taken for the wrong reason — the regex
// firing on a stray word and the classifier answering at 0.76 look identical in
// the ledger, and there is no way to tell which layer to fix.
const routeReasonPattern = /^[a-z][a-z0-9_.:-]{0,63}$/;
// What an adopted run is marked with, in the one field a reader and
// `reserveRun` both look at.
const adoptedRouteReason = "adopted:runtime-ui";

/**
 * How many mid-run corrections one run accepts.
 *
 * A bound rather than a preference. Every correction is another instruction the
 * run has to hold in a context it is already spending, and an unbounded stream
 * of them keeps a run alive for as long as somebody keeps typing — which is a
 * budget the dispatch-time limits cannot see. Three is generous for the thing
 * this exists for: noticing part-way through that the question was wrong.
 */
export const MAX_RUN_CORRECTIONS = 3;

function invalid(message) {
  return new HttpError(400, "invalid_agent_run", message);
}

function ledgerFile(project) {
  return path.join(project.metaDir, ledgerFileName);
}

function assertObject(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(message);
  return value;
}

function assertOnlyFields(value, allowed) {
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  if (unknown.length > 0) throw invalid(`Unknown agent run field(s): ${unknown.sort().join(", ")}.`);
}

function normalizeStartInput(input) {
  assertObject(input, "Agent run start payload must be an object.");
  assertOnlyFields(input, startFields);
  return { sessionId: safeId(input.sessionId, "research session id") };
}

const maxQuestionPreview = 160;

function questionPreview(value) {
  if (typeof value !== "string") return null;
  // What the person asked, without the capability card's naming line: twelve
  // runs of one capability were listed under twelve copies of 「请以「X」能力完成
  // 以下任务：」 (B §4b). The capability itself is on the run as its route.
  const collapsed = capabilityBriefTask(value).task.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.length > maxQuestionPreview ? `${collapsed.slice(0, maxQuestionPreview)}…` : collapsed;
}

/** What a run is called, and where that name came from (C3). */
const titleSources = new Set(["auto", "question", "user"]);
const maxRunTitle = 80;
const maxDerivedTitle = 40;

/**
 * A title a run may carry: one line, bounded, and not blank. The same rule
 * for the researcher's own and the model's, because both are shown in the
 * same place.
 * @param {unknown} value @returns {string | null}
 */
export function normalizeRunTitle(value) {
  if (typeof value !== "string") return null;
  const line = [...value].map((char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char)).join("")
    .replace(/\s+/g, " ").trim();
  if (!line || [...line].length > maxRunTitle) return null;
  return line;
}

/**
 * The title a run has before anyone named it: what was asked, else the
 * capability it was routed to, else a plain placeholder. Marked `question`,
 * which is what an automatic title replaces and a researcher's never is.
 * @param {Record<string, any>} run
 */
function derivedRunTitle(run) {
  const question = typeof run.question === "string" ? [...run.question] : [];
  if (question.length) {
    return question.length > maxDerivedTitle ? `${question.slice(0, maxDerivedTitle - 1).join("")}…` : question.join("");
  }
  return capabilityTitle(run.effectiveAgentId) ?? "未命名的研究";
}

function normalizeDispatchInput(input) {
  assertObject(input, "Agent run dispatch payload must be an object.");
  assertOnlyFields(input, dispatchFields);
  const routeValues = [input.effectiveAgentId, input.effectiveAgentVersion, input.effectiveRuntimeAgent];
  if (routeValues.some((value) => value != null) && !routeValues.every((value) => typeof value === "string" && value.trim())) {
    throw invalid("Effective specialist identity must be supplied as one complete triple.");
  }
  if (input.effectiveAgentId != null && !/^[a-z0-9][a-z0-9-]{1,62}$/.test(input.effectiveAgentId)) {
    throw invalid("Effective specialist id is invalid.");
  }
  if (input.effectiveAgentVersion != null && !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(input.effectiveAgentVersion)) {
    throw invalid("Effective specialist version is invalid.");
  }
  if (input.effectiveRuntimeAgent != null && !/^evimed-[a-z0-9][a-z0-9-]{1,62}$/.test(input.effectiveRuntimeAgent)) {
    throw invalid("Effective runtime agent is invalid.");
  }
  if (input.effectiveRouteReason != null && !routeReasonPattern.test(input.effectiveRouteReason)) {
    throw invalid("Effective route reason is invalid.");
  }
  if (input.automated != null && typeof input.automated !== "boolean") throw invalid("automated must be a boolean.");
  const estimatedMinutes = input.estimatedMinutes == null ? null : normalizeRunEstimate(input.estimatedMinutes);
  if (input.estimatedMinutes != null && !estimatedMinutes) throw invalid("estimatedMinutes must be { min, max } minutes.");
  return {
    sessionId: safeId(input.sessionId, "research session id"),
    dispatchId: safeId(input.dispatchId, "agent run dispatch id"),
    // Started by a harness rather than a person; read by the inbox, which
    // records such a run's completion without notifying anyone (C1).
    automated: input.automated === true,
    // How long the route it took should take, as the dispatcher knew it (C3).
    estimatedMinutes,
    // What the reader asked, kept short. A run list identified only by
    // run_cf7f08fa4b78… is a list of hashes: thirty analyses side by side and
    // no way to tell which is which without opening each one.
    //
    // This is the only form of the question that reaches runs.jsonl. The ledger
    // has a byte ceiling (defaultMaxBytes) that a burst of progress events has
    // already burst once, at 1048462 of 1048576, and the run after it could not
    // start; briefs run to several thousand characters each.
    question: questionPreview(input.question),
    // The whole brief, for the delivery gate. Never serialized: it is held in
    // memory on the store (dispatchedBriefs) and passed straight to
    // validateClinicalEvidencePackage.
    briefText: typeof input.question === "string" && input.question.trim() ? input.question : null,
    effectiveAgentId: input.effectiveAgentId ?? null,
    effectiveAgentVersion: input.effectiveAgentVersion ?? null,
    effectiveRuntimeAgent: input.effectiveRuntimeAgent ?? null,
    effectiveRouteReason: input.effectiveRouteReason ?? null,
  };
}

function sanitizeErrorCode(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw invalid("errorCode must be a string.");
  const normalized = value.trim().toLowerCase();
  return /^[a-z][a-z0-9_.-]{0,63}$/.test(normalized) ? normalized : "runtime_error";
}

// What the verification field is allowed to say, and the whole of it:
//
//   null         every layer of the gate ran, and none of them found anything.
//   "unverified" a layer ran and found something the package cannot self-prove.
//   "unchecked"  a layer did not run at all.
//
// The third value is the one this field was missing. A run whose brief the
// server no longer holds — the brief lived in memory only until 2026-09-18,
// so a restart lost it — has its per-question coverage check skipped entirely, and used to finish
// with verification null: byte-identical, in the one machine-readable field
// operations and the UI read, to a package that passed the check. The same
// package with the brief in hand finished "unverified" with the missing
// question named. Losing the exam paper made the grade go up.
const verificationValues = Object.freeze(["unverified", "unchecked"]);

/** @param {any} value */
function normalizeVerification(value) {
  return verificationValues.includes(value) ? value : null;
}


function normalizeArtifacts(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw invalid("artifacts must be an array.");
  if (value.length > maxArtifacts) throw invalid(`artifacts must contain at most ${maxArtifacts} paths.`);
  const normalized = value.map((item) => {
    try {
      return normalizeWorkspaceRelativePath(item, "artifact path");
    } catch (error) {
      if (error instanceof HttpError) throw invalid(error.message);
      throw error;
    }
  });
  return [...new Set(normalized)].sort();
}

async function readLedgerText(project, maxBytes) {
  let opened;
  try {
    opened = await openScopedFileNoFollow(project.rootDir, ledgerFile(project));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "file_not_found") return "";
    throw error;
  }
  try {
    if (!opened.stat.isFile()) throw new HttpError(400, "not_a_file", "Agent run ledger is not a file.");
    if (opened.stat.size > maxBytes) {
      throw new HttpError(413, "agent_runs_too_large", "Agent run ledger exceeds its size limit.");
    }
    return await opened.handle.readFile("utf8");
  } finally {
    await opened.handle.close();
  }
}

function corrupt(message) {
  return new HttpError(500, "agent_runs_corrupt", message);
}

function parseEvents(text) {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) => {
    try {
      const event = JSON.parse(line);
      if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("shape");
      return event;
    } catch {
      throw corrupt("Agent run ledger contains invalid JSONL.");
    }
  });
}

function storedTimestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw corrupt(`Agent run ${label} is invalid.`);
  }
  return value;
}

function foldEvents(events) {
  const runs = new Map();
  for (const event of events) {
    if (event.event === "started") {
      const id = safeStoredId(event.id, "id");
      if (runs.has(id)) throw corrupt("Agent run ledger contains a duplicate start event.");
      const mode = event.mode;
      if (mode !== "open-domain" && mode !== "specialist") throw corrupt("Agent run mode is invalid.");
      const specialist = mode === "specialist";
      if (
        (specialist && ![event.agentId, event.agentVersion, event.runtimeAgent].every((item) => typeof item === "string" && item)) ||
        (!specialist && [event.agentId, event.agentVersion, event.runtimeAgent].some((item) => item !== null))
      ) throw corrupt("Agent run identity is invalid.");
      const effectiveAgentId = event.effectiveAgentId ?? (specialist ? event.agentId : null);
      const effectiveAgentVersion = event.effectiveAgentVersion ?? (specialist ? event.agentVersion : null);
      const effectiveRuntimeAgent = event.effectiveRuntimeAgent ?? (specialist ? event.runtimeAgent : null);
      const effectiveValues = [effectiveAgentId, effectiveAgentVersion, effectiveRuntimeAgent];
      if (effectiveValues.some((item) => item !== null) && !effectiveValues.every((item) => typeof item === "string" && item)) {
        throw corrupt("Agent run effective identity is invalid.");
      }
      if (specialist && (
        effectiveAgentId !== event.agentId
        || effectiveAgentVersion !== event.agentVersion
        || effectiveRuntimeAgent !== event.runtimeAgent
      )) throw corrupt("Specialist run effective identity does not match its session binding.");
      const effectiveRouteReason = event.effectiveRouteReason ?? null;
      if (effectiveRouteReason !== null && !(typeof effectiveRouteReason === "string" && routeReasonPattern.test(effectiveRouteReason))) {
        throw corrupt("Agent run effective route reason is invalid.");
      }
      if (typeof event.model !== "string" || !event.model) throw corrupt("Agent run model is invalid.");
      const startedAt = storedTimestamp(event.startedAt, "startedAt");
      const dispatchId = event.dispatchId == null ? null : safeStoredId(event.dispatchId, "dispatchId");
      const dispatchStatus = event.dispatchStatus ?? (dispatchId ? "dispatching" : "accepted");
      if (!dispatchStatuses.has(dispatchStatus)) throw corrupt("Agent run dispatch status is invalid.");
      runs.set(id, Object.freeze({
        id,
        dispatchId,
        dispatchStatus,
        ...(Object.hasOwn(event, "baselineCursor") ? { baselineCursor: event.baselineCursor } : {}),
        ...(event.nativeTurn ? { nativeTurn: validateNativeTurn(event.nativeTurn) } : {}),
        ...(event.kernelRequestIds ? { kernelRequestIds: event.kernelRequestIds.map(storedKernelRequestId) } : {}),
        sessionId: safeStoredId(event.sessionId, "sessionId"),
        mode,
        agentId: event.agentId,
        agentVersion: event.agentVersion,
        runtimeAgent: event.runtimeAgent,
        effectiveAgentId,
        effectiveAgentVersion,
        effectiveRuntimeAgent,
        effectiveRouteReason,
        model: event.model,
        // Read through the same preamble rule a new dispatch writes with, so
        // a ledger written before it lists the same way.
        question: typeof event.question === "string" && event.question ? questionPreview(event.question) : null,
        ...(event.automated === true ? { automated: true } : {}),
        ...(normalizeRunEstimate(event.estimatedMinutes) ? { estimatedMinutes: normalizeRunEstimate(event.estimatedMinutes) } : {}),
        // The session this run's session was forked from (C3), so a branch
        // can be followed back to the conversation it came from.
        ...(typeof event.forkedFrom === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(event.forkedFrom) ? { forkedFrom: event.forkedFrom } : {}),
        status: "running",
        createdAt: storedTimestamp(event.createdAt, "createdAt"),
        startedAt,
        finishedAt: null,
        durationMs: null,
        errorCode: null,
        artifacts: [],
        unverifiedArtifacts: [],
        verification: null,
        qualityNotices: [],
        observedMessages: 0,
        observedToolCalls: 0,
        observedRunSideActivity: null,
        observedKernelActivity: null,
        lastProgressAt: null,
      }));
      continue;
    }
    if (event.event === "runtime-turn" || event.event === "kernel-request") {
      const id = safeStoredId(event.id, "id");
      const current = runs.get(id);
      if (!current) throw corrupt("Runtime input refers to an unknown run.");
      runs.set(id, Object.freeze({ ...current,
        ...(event.event === "runtime-turn" ? { nativeTurn: validateNativeTurn(event.nativeTurn) } : {}),
        ...(event.rebased === true ? { nativeWorkflow: null } : {}),
        // A field on an existing event rather than an event kind of its own.
        // `foldEvents` throws on a kind it does not know, so a new kind means a
        // ledger an older control plane cannot read at all; an unknown *field*
        // is simply not folded, which costs the count and nothing else.
        ...(event.kind === "steer" ? { corrections: (current.corrections ?? 0) + 1 } : {}),
        kernelRequestIds: [...new Set([...(current.kernelRequestIds ?? []), ...(event.requestIds ?? []).map(storedKernelRequestId)])],
      }));
      continue;
    }
    if (event.event === "native-workflow") {
      const current = runs.get(event.id);
      if (!current?.nativeTurn || event.evidence?.turnStartSeq !== current.nativeTurn.startSeq) throw corrupt("Native workflow proof has no matching input.");
      runs.set(event.id, Object.freeze({ ...current, nativeWorkflow: event.evidence }));
      continue;
    }
    if (event.event === "dispatch") {
      const id = safeStoredId(event.id, "id");
      const current = runs.get(id);
      if (!current || current.status !== "running" || current.dispatchStatus !== "dispatching") {
        throw corrupt("Agent run ledger contains an invalid dispatch event.");
      }
      if (!["accepted", "unknown", "rejected"].includes(event.status)) {
        throw corrupt("Agent run dispatch event is invalid.");
      }
      runs.set(id, Object.freeze({ ...current, dispatchStatus: event.status }));
      continue;
    }
    if (event.event === "progress") {
      const id = safeStoredId(event.id, "id");
      const current = runs.get(id);
      // Progress is observational: it never changes a run's status, so a
      // malformed or late one is dropped rather than corrupting the ledger.
      if (!current || current.status !== "running") continue;
      if (!Number.isSafeInteger(event.messages) || event.messages < 0) continue;
      if (!Number.isSafeInteger(event.toolCalls) || event.toolCalls < 0) continue;
      // The run's plan and its progress aggregate, as last observed. Fields on
      // the existing gauge rather than an event kind of their own, so an older
      // control plane reads this ledger and simply does not fold them.
      const deliverables = normalizeStoredDeliverables(event.deliverables);
      const snapshot = normalizeStoredProgress(event.snapshot);
      runs.set(id, Object.freeze({
        ...current,
        ...(deliverables ? { deliverables } : {}),
        ...(snapshot ? { progress: { deliverables: deliverables ?? current.deliverables ?? [], ...snapshot } } : {}),
        observedMessages: event.messages,
        observedToolCalls: event.toolCalls,
        // The run's own side of the same observation. Absent on a run that
        // writes no projection and on every row written before this field
        // existed, so it is carried only when present rather than defaulted —
        // a default would read as "we observed zero activity", which is a
        // different claim from "we have not been told".
        ...(typeof event.runSideActivity === "string" ? { observedRunSideActivity: event.runSideActivity } : {}),
        ...(typeof event.kernelActivity === "string" && /^[a-f0-9]{64}$/.test(event.kernelActivity)
          ? { observedKernelActivity: event.kernelActivity }
          : {}),
        lastProgressAt: storedTimestamp(event.at, "at"),
      }));
      continue;
    }
    if (event.event === "finished") {
      const id = safeStoredId(event.id, "id");
      const current = runs.get(id);
      if (!current || current.status !== "running") throw corrupt("Agent run ledger contains an invalid terminal event.");
      if (!terminalStatuses.has(event.status)) throw corrupt("Agent run terminal status is invalid.");
      if (!Number.isSafeInteger(event.durationMs) || event.durationMs < 0) throw corrupt("Agent run duration is invalid.");
      const artifacts = normalizeStoredArtifacts(event.artifacts);
      const errorCode = event.errorCode == null ? null : String(event.errorCode);
      // The plan as the run ended it, and what its claims came to. Kept after
      // the end on purpose: which item was rejected and how many times it was
      // submitted is the record a researcher wants afterwards, and a finished
      // run's page used to have no way to show it (2026-09-18 review, B §4h).
      const deliverables = normalizeStoredDeliverables(event.deliverables);
      const snapshot = normalizeStoredProgress(event.snapshot);
      const claimSummary = normalizeClaimSummary(event.claimSummary);
      runs.set(id, Object.freeze({
        ...current,
        ...(deliverables ? { deliverables } : {}),
        ...(snapshot ? { progress: { deliverables: deliverables ?? current.deliverables ?? [], ...snapshot } } : {}),
        ...(claimSummary ? { claimSummary } : {}),
        // Who stopped a cancelled run: the researcher, or the platform
        // shutting down. Absent when the kernel reported the stop itself.
        ...(event.canceledBy === "user" || event.canceledBy === "platform" ? { canceledBy: event.canceledBy } : {}),
        // The kernel's finer reason, or the connector a failed research call
        // had no credential for — written since the sub-code existed and read
        // back only now, so a reader can say what to do about it.
        ...(typeof event.errorSubCode === "string" && /^[a-z][a-z0-9_.-]{0,63}$/.test(event.errorSubCode) ? { errorSubCode: event.errorSubCode } : {}),
        ...(typeof event.missingCredential === "string" && CONNECTOR_CREDENTIAL_IDS.has(event.missingCredential) ? { missingCredential: event.missingCredential } : {}),
        status: event.status,
        finishedAt: storedTimestamp(event.finishedAt, "finishedAt"),
        durationMs: event.durationMs,
        errorCode,
        artifacts,
        // Read with the same normalizer and defaulted to `[]`, so a run written
        // by an older build folds to "none written" rather than to `undefined`
        // — the browser distinguishes the two and would otherwise have to say
        // "unknown" about every run in the existing ledger.
        // `?? []` before the normalizer, not inside it: every row already on
        // every production ledger predates this field, and
        // `normalizeStoredArtifacts` throws `corrupt` on a non-array — which
        // would not have degraded one run, it would have made the whole ledger
        // unreadable the moment this shipped.
        unverifiedArtifacts: normalizeStoredArtifacts(event.unverifiedArtifacts ?? []),
        // A judgement can land either side of the delivery decision, so both
        // orders must fold to the same run. An admission already on the record
        // survives a terminal event that says nothing; a terminal finding
        // outranks it.
        verification: normalizeVerification(event.verification)
          ?? (current.verification === "unchecked" ? "unchecked" : null),
        // The run's own notices lead; anything appended after the fact — a
        // coverage judgement that was still running when the run finished —
        // follows, in whichever order the two events reached the ledger.
        // Described on read (C2): a stored notice, or a sentence an older
        // build wrote, becomes a titled item a reader can use.
        qualityNotices: [
          ...describedQualityNotices(event.qualityNotices),
          ...current.qualityNotices,
        ].slice(0, maxQualityNotices),
      }));
      continue;
    }
    // What the run left behind for the learning loop: where its transcript was
    // written, which methods were mounted and which were actually called, how
    // many repair rounds it took, and what the kernel compacted.
    //
    // Observational like `progress`, and for the same reason: none of it may
    // change a run's status, so a malformed one is dropped rather than
    // corrupting the ledger. It is also a *gauge* — `serializeNext` supersedes
    // the previous row for the same run — which is why every writer sends the
    // whole cumulative value rather than a delta. A history row here would grow
    // once per repair round and once per compaction, on a file with a 1 MiB
    // ceiling that has already been hit once.
    //
    // DEPLOYMENT CONSTRAINT, because `foldEvents` throws on an event kind it
    // does not know: once a project ledger has a `learning` row, a control
    // plane older than this branch cannot read that ledger at all — `list`,
    // `recover`, every dispatch and every monitor poll fail together with
    // `agent_runs_corrupt`, permanently, because the server cannot remove the
    // row. Rolling back past this change therefore requires either keeping this
    // branch's reader or removing the rows. The writer is unconditional on
    // purpose (the compaction distribution §6.5 needs measuring before any
    // policy changes), so this applies to a deployment that never turns the
    // learning loop on.
    if (event.event === "learning") {
      const id = safeStoredId(event.id, "id");
      const current = runs.get(id);
      if (!current) continue;
      const repairRounds = normalizeRepairRounds(event.repairRounds);
      runs.set(id, Object.freeze({
        ...current,
        ...(event.transcript ? { transcript: normalizeTranscriptReceipt(event.transcript) } : {}),
        ...(event.methodsLoaded ? { methodsLoaded: normalizeMethodDigests(event.methodsLoaded) } : {}),
        ...(event.methodsInvoked ? { methodsInvoked: normalizeMethodDigests(event.methodsInvoked) } : {}),
        ...(event.mountedSkills ? { mountedSkills: normalizeMountedSkills(event.mountedSkills) } : {}),
        ...(event.recalledMemories ? { recalledMemories: normalizeRecalledMemories(event.recalledMemories) } : {}),
        // `attempts` has been published to the browser since the repair loop
        // shipped and has always been 0, because nothing ever folded it. The
        // repair count is the number it was always meant to carry.
        ...(repairRounds ? { repairRounds, attempts: repairRounds.content + repairRounds.structural } : {}),
        ...(event.compaction ? { compaction: normalizeCompactionRecords(event.compaction) } : {}),
      }));
      continue;
    }
    // A finding that arrived after the delivery decision was made. It appends
    // to what the reader is told and may admit that a layer went unchecked; it
    // can never change a run's status, its error code or its artifacts, and it
    // can never turn "unverified" back into a clean bill.
    if (event.event === "notice") {
      const id = safeStoredId(event.id, "id");
      const current = runs.get(id);
      if (!current) throw corrupt("Agent run ledger contains a notice for an unknown run.");
      const added = describedQualityNotices(event.qualityNotices);
      // What the run is called and what it asked, when either was learned
      // after the start (C3). Fields on this event rather than a kind of their
      // own, so a control plane older than them reads the ledger and ignores
      // them. A researcher's title is locked: nothing but another of theirs
      // replaces it. A question is filled once and never rewritten.
      const title = normalizeRunTitle(event.title);
      const titleSource = titleSources.has(event.titleSource) ? event.titleSource : null;
      const labelled = title && titleSource && titleSource !== "question"
        && (current.titleSource !== "user" || titleSource === "user");
      const question = current.question == null && typeof event.question === "string" ? questionPreview(event.question) : null;
      runs.set(id, Object.freeze({
        ...current,
        ...(labelled ? { title, titleSource } : {}),
        ...(question ? { question } : {}),
        verification: event.verification === "unchecked" && current.verification === null
          ? "unchecked"
          : current.verification,
        qualityNotices: [...current.qualityNotices, ...added].slice(0, maxQualityNotices),
      }));
      continue;
    }
    throw corrupt("Agent run ledger contains an unsupported event.");
  }
  // Every run has a name (C3). One nobody gave a title is called by what it
  // asked; that is `question`, the source an automatic title may replace.
  for (const [id, run] of runs) {
    // Why it went where it went, in the reader's words (C3), derived from the
    // machine reason the ledger keeps for operations.
    const routeReason = routeReasonText(run.effectiveRouteReason, run.effectiveAgentId);
    const named = run.titleSource === "auto" || run.titleSource === "user";
    if (named && !routeReason) continue;
    runs.set(id, Object.freeze({
      ...run,
      ...(routeReason ? { routeReason } : {}),
      ...(named ? {} : { title: derivedRunTitle(run), titleSource: "question" }),
    }));
  }
  return runs;
}

/** How many method mounts and calls one run may record. The mount cap is the
 *  capsule's own (32); a run that reports more is reporting something else. */
const maxLearningMethods = 64;
const maxCompactionRecords = 64;

/** @param {any} value @returns {{path: string, completeness: string, bytes: number, sha256: string, messages: number} | undefined} */
function normalizeTranscriptReceipt(value) {
  if (!value || typeof value !== "object") return undefined;
  const completeness = String(value.completeness ?? "");
  if (!["complete", "partial", "unavailable"].includes(completeness)) return undefined;
  if (typeof value.path !== "string" || !value.path || value.path.length > 512) return undefined;
  if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) return undefined;
  const missing = normalizeTranscriptGaps(value.missing);
  return {
    path: value.path,
    completeness,
    bytes: Number.isSafeInteger(value.bytes) && value.bytes >= 0 ? value.bytes : 0,
    sha256: value.sha256,
    messages: Number.isSafeInteger(value.messages) && value.messages >= 0 ? value.messages : 0,
    ...(missing ? { missing } : {}),
  };
}

/**
 * Why a transcript is not complete, carried onto the run.
 *
 * `persistRunTranscript` has always returned the gaps and this normalizer has
 * always dropped them, so the run record said `partial` and nothing else. The
 * reason lived only in the header line of a file inside the project's data
 * volume: diagnosing the kernel refusing a subagent addressed at its own id took
 * an ssh session into the host, and a paired evaluation excluding a cell as
 * `transcript_partial` could not say which child, or why, in its own results.
 *
 * Bounded like everything else written to the ledger: a run with a hundred
 * unreadable children records the first sixteen, and every string has a cap.
 *
 * @param {unknown} value
 * @returns {{sessionId: string, fromSeq: number, reason: string, detail?: string}[] | undefined}
 */
function normalizeTranscriptGaps(value) {
  if (!Array.isArray(value)) return undefined;
  /** @type {{sessionId: string, fromSeq: number, reason: string, detail?: string}[]} */
  const gaps = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const sessionId = typeof item.sessionId === "string" ? item.sessionId.slice(0, 120) : "";
    const reason = typeof item.reason === "string" ? item.reason.slice(0, 48) : "";
    if (!sessionId || !reason) continue;
    gaps.push({
      sessionId,
      fromSeq: Number.isSafeInteger(item.fromSeq) && item.fromSeq >= 0 ? item.fromSeq : 0,
      reason,
      ...(typeof item.detail === "string" && item.detail ? { detail: item.detail.slice(0, 200) } : {}),
    });
    if (gaps.length >= 16) break;
  }
  return gaps.length > 0 ? gaps : undefined;
}

/** @param {any} value @returns {{name: string, digest: string, seq?: number}[] | undefined} */
/**
 * Skill names the control plane put into this run's prompt.
 *
 * Non-throwing on a bad shape, like `normalizeQualityNotices` and unlike
 * `normalizeStoredArtifacts`: this is a completion input, and a ledger line
 * that will not parse must degrade to "nothing mounted" rather than make every
 * run in the file unreadable.
 * @param {any} value @returns {string[] | undefined}
 */
function normalizeMountedSkills(value) {
  if (!Array.isArray(value)) return undefined;
  const names = value
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim().slice(0, 160));
  return names.length > 0 ? [...new Set(names)].slice(0, 32) : undefined;
}

/**
 * The durable memories a dispatch recalled, as the run detail shows them.
 *
 * Ids, kinds and scopes only — never the values. The ledger is a file in the
 * project workspace and a memory's content belongs in one place, the memory
 * store, where deleting it deletes it. What a reader needs here is "three
 * things you told us were used", with a link to go read them.
 */
function normalizeRecalledMemories(value) {
  if (!Array.isArray(value)) return undefined;
  const rows = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const id = typeof item.id === "string" ? item.id.trim().slice(0, 120) : "";
    if (!id) continue;
    rows.push(Object.freeze({
      id,
      kind: typeof item.kind === "string" ? item.kind.trim().slice(0, 48) : "note",
      scope: typeof item.scope === "string" ? item.scope.trim().slice(0, 16) : "user",
    }));
  }
  // 40, not the 16 a dispatch's recall alone fits in: the recall tool adds to
  // it over a conversation, and the panel that lists them must list them all.
  // Still bounded — the row is rewritten on every learning write.
  return rows.length > 0 ? rows.slice(0, 40) : undefined;
}

function normalizeMethodDigests(value) {
  if (!Array.isArray(value)) return undefined;
  /** @type {{name: string, digest: string, seq?: number, trial?: boolean}[]} */
  const entries = [];
  for (const item of value.slice(0, maxLearningMethods)) {
    if (!item || typeof item.name !== "string" || !item.name) continue;
    if (typeof item.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(item.digest)) continue;
    entries.push({
      name: item.name.slice(0, 128),
      digest: item.digest,
      ...(Number.isSafeInteger(item.seq) && item.seq >= 0 ? { seq: item.seq } : {}),
      // Whether this method was on trial rather than approved. Dropped here
      // once, and the ledger could no longer tell a measured arm from an
      // ordinary run -- so every later comparison would quietly mix the two.
      ...(item.trial === true ? { trial: true } : {}),
    });
  }
  return entries;
}

/**
 * A session's observed calls with a fresh read laid over them: the read wins
 * for every call it holds, and a call only the stream has seen so far is kept.
 * @param {Map<string, import('./runProgress.mjs').ObservedCall> | undefined} existing
 * @param {import('./runProgress.mjs').ObservedCall[]} read
 */
function mergeObservedCalls(existing, read) {
  const calls = existing ?? new Map();
  for (const call of read) if (call.callId) calls.set(call.callId, call);
  return calls;
}

/** The aggregate as the ledger stores it: the plan lives beside it, not in it.
 *  @param {import('./runProgress.mjs').RunProgress} progress */
function withoutDeliverables(progress) {
  const { deliverables: _deliverables, ...rest } = progress;
  return rest;
}

/** @param {any} value @returns {{ total: number, verified: number, unverified: number } | undefined} */
function normalizeClaimSummary(value) {
  if (!value || typeof value !== "object") return undefined;
  const read = (/** @type {unknown} */ number) => (Number.isSafeInteger(number) && Number(number) >= 0 ? Number(number) : 0);
  const total = read(value.total);
  if (!total) return undefined;
  return { total, verified: Math.min(total, read(value.verified)), unverified: Math.min(total, read(value.unverified)) };
}

/** @param {any} value @returns {{content: number, structural: number} | undefined} */
function normalizeRepairRounds(value) {
  if (!value || typeof value !== "object") return undefined;
  const content = Number.isSafeInteger(value.content) && value.content >= 0 ? value.content : 0;
  const structural = Number.isSafeInteger(value.structural) && value.structural >= 0 ? value.structural : 0;
  return { content, structural };
}

/** @param {any} value @returns {{at: string, seq: number, replaced: number, tokens: number, policy: string}[] | undefined} */
function normalizeCompactionRecords(value) {
  if (!Array.isArray(value)) return undefined;
  /** @type {{at: string, seq: number, replaced: number, tokens: number, policy: string}[]} */
  const entries = [];
  for (const item of value.slice(-maxCompactionRecords)) {
    if (!item || typeof item !== "object") continue;
    if (!Number.isSafeInteger(item.seq) || item.seq < 0) continue;
    entries.push({
      at: typeof item.at === "string" ? item.at.slice(0, 40) : "",
      seq: item.seq,
      replaced: Number.isSafeInteger(item.replaced) && item.replaced >= 0 ? item.replaced : 0,
      tokens: Number.isSafeInteger(item.tokens) && item.tokens >= 0 ? item.tokens : 0,
      policy: typeof item.policy === "string" ? item.policy.slice(0, 32) : "",
    });
  }
  return entries;
}

function safeStoredId(value, label) {
  try {
    return safeId(value, `agent run ${label}`);
  } catch {
    throw corrupt(`Agent run ${label} is invalid.`);
  }
}

function normalizeStoredArtifacts(value) {
  if (!Array.isArray(value) || value.length > maxArtifacts) throw corrupt("Agent run artifacts are invalid.");
  try {
    const normalized = value.map((item) => normalizeWorkspaceRelativePath(item, "artifact path"));
    if (new Set(normalized).size !== normalized.length) throw new Error("duplicates");
    return normalized;
  } catch {
    throw corrupt("Agent run artifacts are invalid.");
  }
}

/**
 * Whether `to` is reachable from `from` in the `run` phase table by any single
 * event — not by a specific one, because the raw ledger event that produced a
 * phase change (`dispatch` / `progress` / `finished`) does not name the phase
 * table's own event vocabulary (`deliver` / `accept` / `degrade` / …) directly,
 * and mapping one to the other one-for-one would be a second, narrower
 * definition of the same table this function already has.
 * @param {string} from @param {string} to @returns {boolean}
 */
function isLegalRunPhaseMove(from, to) {
  if (from === to) return true
  return transitionEvents("run", from).some((event) => domainTransition("run", from, event) === to)
}

/**
 * The phase sequence a run's own events produce, walked independently of
 * `foldEvents` (§7.1.1, decision 2026-08-24 #20).
 *
 * Deliberately a second, simpler pass rather than instrumentation added inside
 * `foldEvents` itself: that function's job is deciding whether the ledger is
 * corrupt, and it throws when it is. This one's job is a diagnostic count that
 * must never do that — a phase sequence that looks illegal is exactly the
 * "historical data must not crash reads" case the projection design calls out
 * — so it stays lenient by construction, on its own copy of the handful of
 * fields phase computation needs, rather than reusing a function that is
 * strict on purpose.
 *
 * @param {readonly Record<string, any>[]} events @param {string} runId
 * @returns {{ phase: string, illegalTransitions: number, notices: string[] }}
 */
function runPhaseHistory(events, runId) {
  /** @type {Record<string, any> | null} */
  let record = null
  let phase = "reserved"
  let illegalTransitions = 0
  /** @type {string[]} */
  const notices = []
  for (const event of events) {
    if (event?.id !== runId) continue
    if (event.event === "started") {
      record = { status: "running", dispatchStatus: event.dispatchStatus ?? (event.dispatchId ? "dispatching" : "accepted"), hasProgressEvent: false, verification: null }
    } else if (!record) {
      continue // an event for a run this walk has not seen "started" for is not this function's problem to diagnose
    } else if (event.event === "dispatch") {
      record = { ...record, dispatchStatus: event.status }
    } else if (event.event === "progress") {
      record = { ...record, hasProgressEvent: true }
    } else if (event.event === "finished") {
      record = { ...record, status: event.status, verification: event.verification ?? record.verification }
    } else {
      continue
    }
    let next
    try {
      // `record` is built incrementally across four different branches above,
      // so its inferred type is wider than what `runPhase` accepts; the fields
      // that matter are exactly the ones assigned in this function, never
      // anything wider, so the cast just tells the checker what this loop
      // already guarantees by construction.
      next = runPhase(/** @type {Parameters<typeof runPhase>[0]} */ (record))
    } catch {
      continue // an unrecognized status is foldEvents' corruption check to raise, not this diagnostic's
    }
    if (!isLegalRunPhaseMove(phase, next)) {
      illegalTransitions += 1
      notices.push(`illegal_state_transition: ${phase} -> ${next}`)
    }
    phase = next
  }
  return { phase, illegalTransitions, notices }
}

/**
 * The ledger with one more event on it, minus the progress rows that event
 * supersedes.
 *
 * Progress is a live gauge: only a run's latest observation says anything, and
 * the ones before it are a record of how often the monitor woke up. The
 * started, dispatch and finished rows are the run's history and are never
 * dropped.
 *
 * The rule used to live at the progress call site alone, which fixed the path
 * that produced the bloat and left the path that has to survive it. A project
 * reached 7,800 progress rows across 31 runs and stopped 114 bytes under the
 * cap: progress kept writing, because it made its own room, and `finished`
 * could not, because it did not -- so a run that had actually completed could
 * never record that it had, and its monitor retried once a minute forever.
 * Holding the rule here means no call site can be the one that forgets.
 */
function serializeNext(events, event, maxBytes) {
  const superseded = new Set();
  const keep = [...events, event];
  for (let index = keep.length - 1; index >= 0; index -= 1) {
    const item = keep[index];
    // `learning` joins the gauges: every writer sends the whole cumulative
    // receipt, so only the last one is worth keeping. Adding it to the history
    // side instead would put one row per repair round and one per compaction on
    // a file that has already hit its ceiling once.
    if (item?.event !== "progress" && item?.event !== "native-workflow" && item?.event !== "learning") continue;
    const key = `${item.event}:${item.id}`;
    if (superseded.has(key)) keep[index] = null;
    else superseded.add(key);
  }
  const retained = keep.filter(Boolean);
  const text = `${retained.map((item) => JSON.stringify(item)).join("\n")}\n`;
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new HttpError(413, "agent_runs_too_large", "Agent run ledger exceeds its size limit.");
  }
  return text;
}

function messageRole(message) {
  return message?.info?.role ?? message?.role;
}

/** @param {any} value */
function validateNativeTurn(value) {
  if (!value || !Number.isSafeInteger(value.startSeq) || value.startSeq < 0
    || !Number.isSafeInteger(value.userSeq) || value.userSeq <= value.startSeq) {
    throw corrupt("Native run input has no valid log boundary.");
  }
  return { startSeq: value.startSeq, userSeq: value.userSeq };
}

/** Native request identities are opaque strings, not our short resource ids. */
function storedKernelRequestId(value) {
  if (typeof value !== "string" || !value || value.length > 512 || [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw corrupt("Runtime request identity is invalid.");
  }
  return value;
}

/** The log, not elapsed time or matching text, assigns messages to a run. */
function runHistory(run, history) {
  const turns = new Set(history.filter((message) => actualUserMessage(message) && (run.kernelRequestIds ?? []).includes(message.info?.sourceRequestId))
    .map((message) => message.info?.turnStartSeq).filter((seq) => Number.isSafeInteger(seq)));
  if (run.nativeTurn && !run.kernelRequestIds?.length) turns.add(run.nativeTurn.startSeq);
  if (turns.size) return history.filter((message) => turns.has(message.info?.turnStartSeq));
  // A lost acceptance is not permission to claim the next unrelated input.
  // Histories predating the DSH normalization retain their baseline behavior.
  return run.kernelRequestIds?.length && history.some((message) => message.info?.turnStartSeq != null) ? [] : history;
}

function actualUserMessage(message) {
  return messageRole(message) === "user" && message.info?.source === "user";
}

/**
 * What the person typed first in this run's own turns, as plain text: the
 * question a run adopted before it could be read was asked. By sender, not by
 * role — injected context is a user-role message too.
 * @param {Record<string, any>} run @param {any[]} history
 */
function firstUserText(run, history) {
  const message = runHistory(run, history).find(actualUserMessage);
  return (message?.parts ?? []).filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text).join(" ").trim();
}

/** Only completed control tools in the owned turn may establish workflow provenance. */
function nativeWorkflowEvidence(run, history) {
  let plan = null;
  let completion = null;
  let kernelRunId = null;
  const submissions = new Map();
  const delegates = new Set();
  for (const message of history) for (const part of message.parts ?? []) {
    if (part.type !== "tool" || part.state?.status !== "completed") continue;
    // The kernel's rendered text, not bare JSON: see `socketToolResult`.
    const result = socketToolResult(part.state?.output);
    if (!result || typeof result.ok !== "boolean") continue;
    const start = Number(message.info?.time?.created);
    const end = Number(part.state.completedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    const args = part.state.input ?? {};
    const span = { start, end, callId: String(part.callID ?? ""), messageId: messageId(message) };
    if (part.tool === "evimed_plan" && result.ok && ["write", "status"].includes(args.action)) {
      const items = args.action === "write" ? result.data?.deliverables : result.data?.items;
      if (!Number.isSafeInteger(result.data?.revision) || !Array.isArray(items)) continue;
      const definitions = items.filter((item) => typeof item?.id === "string" && isContractKind(item.contractKind))
        .map((item) => ({ id: item.id, contractKind: item.contractKind, capability: String(item.capability ?? "") }));
      if (args.action === "write" && !definitions.every((item) => args.deliverables?.some((input) => input.id === item.id && input.contractKind === item.contractKind && input.capability === item.capability))) continue;
      if (typeof result.data?.runId !== "string" || !result.data.runId || result.data.runId.length > 256) continue;
      if (kernelRunId && kernelRunId !== result.data.runId) return null;
      kernelRunId = result.data.runId;
      plan = { revision: result.data.revision, written: args.action === "write", items: definitions, ...span };
    }
    if (part.tool === "evimed_submit_deliverable" && typeof args.deliverableId === "string") {
      const id = args.deliverableId;
      const entry = submissions.get(id) ?? { id, attempts: 0, accepted: null, rejected: null };
      entry.attempts++;
      if (result.ok && result.data?.deliverableId === id && isContractKind(result.data?.contractKind)) {
        // An accepted submission's notices are the run-side gate's advisory
        // messages; the tool reply carries their text only.
        entry.accepted = { ...span, contractKind: result.data.contractKind,
          notices: normalizeQualityNotices((Array.isArray(result.data.notices) ? result.data.notices : []).map((text) => (
            typeof text === "string" ? runNotice("gate_advisory", text) : text))) };
      } else if (!result.ok) {
        // A rejection's issues keep their code and severity: the rendered
        // reply carries both (`- (<severity>) <code> <message>`).
        entry.rejected = { ...span, code: String(result.code ?? ""), notices: normalizeQualityNotices(result.issues ?? []) };
      }
      submissions.set(id, entry);
    }
    if (part.tool === "evimed_delegate" && result.ok && result.data?.deliverableId === args.deliverableId) delegates.add(args.deliverableId);
    if (part.tool === "evimed_complete_run") completion = { ok: result.ok, notices: normalizeQualityNotices(result.issues ?? result.data?.issues ?? []), ...span };
  }
  if (!plan && !submissions.size && !delegates.size && !completion) return null;
  const throughSeq = history.reduce((head, message) => Math.max(head,
    Number(messageId(message)?.replace(/^seq_/, "")) || 0,
    Number(message.info?.turnEnd?.seq) || 0,
    (message.parts ?? []).reduce((seq, part) => Math.max(seq, Number(part.state?.completedSeq) || 0), 0),
  ), run.nativeTurn.startSeq);
  return { turnStartSeq: run.nativeTurn.startSeq, throughSeq, throughMessage: messageId(history.at(-1)), endTime: history.at(-1)?.info?.turnEnd?.time ?? null,
    ...(kernelRunId ? { kernelRunId } : {}),
    plan, submissions: [...submissions.values()], delegates: [...delegates], completion };
}

function nativeWorkflowNotices(proof) {
  return normalizeQualityNotices([
    ...(proof?.submissions ?? []).flatMap((item) => [...(item.accepted?.notices ?? []), ...(item.rejected?.notices ?? [])]),
    ...(proof?.completion?.notices ?? []),
  ]);
}

/** Progress states a live run's own plan index may report as they are. None of
 *  them claims the work passed: that is `accepted`, which stays gated. */
const liveProjectionStates = new Set(["queued", "delegated", "submitted", "rejected", "failed"]);

/**
 * Match plan revision and item identity, never a projection's refresh timestamp.
 *
 * Two readings of one file, decided by whether the run is still going.
 *
 * Once the run has ended, every item's state is rebuilt from the tool calls the
 * parent session was seen to complete — the attribution a terminal verdict and
 * a skill receipt rest on, because the projection is a document the model's
 * workspace holds.
 *
 * While it is going, that rebuild is structurally wrong for delegated work and
 * it was the whole of F4 (2026-09-18): the child does the submitting, so its
 * `evimed_submit_deliverable` never appears in the parent's transcript, and a
 * blocking `evimed_delegate` does not complete until the child finishes, so the
 * parent's proof named no delegation either. Every item read `planned` with 0
 * attempts for 25 minutes while the plan index said item 1 was `rejected,
 * attempts 2`; and because the same rebuild emptied `subagents`, the monitor
 * never read a child's heartbeat and announced a stall. So a live run takes its
 * progress states — delegated, submitted, rejected — and its attempt counts
 * from the plan index, and keeps its children.
 *
 * `accepted` is the one state the proof exists to protect, and it stays gated
 * on evidence either way: an acceptance the parent was seen to receive, or a
 * delivery receipt for this kernel run whose files still match the digests
 * they were accepted at (`receiptAccepted`, read by the caller). A plan index
 * that says `accepted` without either reads as `submitted`.
 *
 * @param {Record<string, any>} projection @param {Record<string, any>} run
 * @param {{ receiptAccepted?: ReadonlySet<string> | null }} [options]
 * @returns {Record<string, any> | null}
 */
function scopeNativeProjection(projection, run, { receiptAccepted = null } = {}) {
  const proof = run.nativeWorkflow;
  if (!proof || projection.sessionId !== run.sessionId || !projection.runId) return null;
  if (proof.kernelRunId && projection.runId !== proof.kernelRunId) return null;
  const rawItems = Array.isArray(projection.plan?.items) ? projection.plan.items : [];
  const invoked = new Set([...(proof.submissions ?? []).map((item) => item.id), ...(proof.delegates ?? [])]);
  const definitions = (proof.plan?.written ? proof.plan.items : (proof.plan?.items ?? []).filter((item) => invoked.has(item.id))).map((item) => ({ ...item }));
  for (const submission of proof.submissions ?? []) if (submission.accepted && !definitions.some((item) => item.id === submission.id)) {
    definitions.push({ id: submission.id, contractKind: submission.accepted.contractKind, capability: "" });
  }
  if (proof.plan?.written && projection.plan?.revision !== proof.plan.revision) return null;
  if (!definitions.length || !definitions.every((item) => rawItems.some((raw) => raw.id === item.id && raw.contractKind === item.contractKind && (!item.capability || raw.capability === item.capability)))) return null;
  const live = run.status === "running";
  const items = definitions.map((definition) => {
    const raw = rawItems.find((item) => item.id === definition.id);
    const submission = proof.submissions.find((item) => item.id === definition.id);
    const witnessed = submission?.accepted ? "accepted" : submission?.rejected ? "submitted" : proof.delegates.includes(definition.id) ? "delegated" : "planned";
    if (!live) {
      // A delegated item its child got accepted: the receipt's evidence, as
      // while the run was going (see `scopeNativeReceipt`).
      const received = witnessed === "delegated" && receiptAccepted?.has(definition.id) === true;
      const attempts = Math.max(submission?.attempts ?? 0, received && Number.isSafeInteger(raw?.attempts) ? raw.attempts : 0);
      return { ...raw, status: received ? "accepted" : witnessed, attempts };
    }
    const reported = String(raw?.status ?? "planned");
    const accepted = witnessed === "accepted" || (reported === "accepted" && receiptAccepted?.has(definition.id) === true);
    const status = accepted ? "accepted"
      : liveProjectionStates.has(reported) ? reported
        : reported === "accepted" ? "submitted"
          : witnessed;
    const attempts = Math.max(submission?.attempts ?? 0, Number.isSafeInteger(raw?.attempts) && raw.attempts > 0 ? raw.attempts : 0);
    return { ...raw, status, attempts };
  });
  const planned = new Set(definitions.map((item) => item.id));
  const gateRuns = (Array.isArray(projection.gateRuns) ? projection.gateRuns : []).filter((gate) => (live
    ? planned.has(gate.deliverableId)
    : proof.submissions.some((item) => item.id === gate.deliverableId
      && [item.accepted, item.rejected].some((attempt) => attempt && Date.parse(gate.at) >= attempt.start && Date.parse(gate.at) <= attempt.end))));
  const subagents = (Array.isArray(projection.subagents) ? projection.subagents : []).filter((child) => (live || proof.delegates.includes(child.deliverableId))
    && definitions.some((item) => item.id === child.deliverableId && (live && !item.capability ? true : item.capability === child.capability)));
  return { ...projection, plan: { revision: proof.plan?.revision ?? projection.plan?.revision, items }, gateRuns, subagents,
    qualityNotices: nativeWorkflowNotices(proof), degraded: [] };
}

/** A receipt is cumulative. Only acceptance witnessed in this input's tool call belongs here. */
function scopeNativeReceipt(receipt, run) {
  const proof = run.nativeWorkflow;
  if (!proof || (proof.kernelRunId && proof.kernelRunId !== receipt.runId)) return null;
  const end = typeof proof.endTime === "number" ? proof.endTime : Date.parse(String(proof.endTime ?? ""));
  const entries = receipt.entries.filter((entry) => {
    const definition = proof.plan?.items?.find((item) => item.id === entry.deliverableId);
    const at = Date.parse(entry.acceptedAt);
    const witnessed = proof.submissions.some((submission) => {
      const accepted = submission.accepted;
      return accepted && submission.id === entry.deliverableId && accepted.contractKind === entry.contractKind
        && (!definition?.capability || definition.capability === entry.capability)
        && at >= accepted.start && at <= accepted.end;
    });
    if (witnessed) return true;
    // A delegated deliverable is submitted by its child, and the child's
    // `evimed_submit_deliverable` never reaches the parent's transcript. So an
    // accepted package of a task asked in the conversation window read as
    // 「已交付，但有核验没有通过」 with no finding to show (2026-09-19 live
    // walk: both deliverables accepted at their first submission). The live
    // projection already admits such an entry on the receipt's own evidence
    // (`receiptAcceptedDeliverables`); this is the same rule once the run has
    // ended: this turn's kernel run, a deliverable this turn planned and
    // delegated, accepted after the plan and before the turn ended. The
    // caller re-hashes every file the entry names (`verifiedReceiptArtifacts`).
    return Boolean(proof.kernelRunId) && proof.kernelRunId === receipt.runId
      && (proof.delegates ?? []).includes(entry.deliverableId)
      && Boolean(definition) && definition.contractKind === entry.contractKind
      && (!definition.capability || definition.capability === entry.capability)
      && Number.isFinite(at) && at >= Number(proof.plan?.start) && (!Number.isFinite(end) || at <= end);
  });
  return entries.length ? { ...receipt, entries } : null;
}

function messageId(message) {
  const value = message?.info?.id ?? message?.id;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function historyCursor(history) {
  if (!Array.isArray(history)) {
    throw new HttpError(502, "runtime_history_invalid", "Runtime session history is invalid.");
  }
  if (history.length === 0) return null;
  const cursor = messageId(history.at(-1));
  if (!cursor) {
    throw new HttpError(502, "runtime_history_cursor_invalid", "Runtime session history has no stable cursor.");
  }
  return cursor;
}

function assistantFinished(message) {
  return Boolean(message?.info?.time?.completed ?? message?.completed ?? message?.info?.error);
}

function parsedToolResult(part) {
  const output = part?.state?.output;
  if (typeof output !== "string" || !output.trim().startsWith("{")) return null;
  try {
    const value = JSON.parse(output);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function parsedToolResultStatus(part) {
  const value = parsedToolResult(part);
  return typeof value?.status === "string" ? value.status : null;
}

/**
 * Child session ids witnessed in successful delegation tool receipts — the
 * delegate call's own answer and every collecting call's (a retried child is
 * named only by the latter; see `delegatedChildrenOf`).
 */
function delegatedChildSessionIds(messages) {
  const ids = [];
  for (const message of messages) {
    for (const part of message?.parts ?? []) {
      if (part?.type !== "tool" || part?.state?.status !== "completed") continue;
      for (const child of delegatedChildrenOf(part?.tool, part?.state?.output)) {
        try {
          const id = storedKernelRequestId(child.childSessionId);
          if (!ids.includes(id)) ids.push(id);
        } catch { /* malformed child identities prove nothing */ }
      }
    }
  }
  return ids.slice(0, 32);
}

/**
 * Read authenticated kernel histories for delegated children, including nested
 * children.
 *
 * Each child is read under its parent's address. It used to be read at its own
 * id, which the kernel refuses for a subagent session — and the refusal was
 * swallowed here, so the delivery gate built its source-provenance map from the
 * root session alone. A clinical-evidence run whose child fetched a full text
 * was then refused for listing "a path no evidence tool reported preserving",
 * about a file that child had preserved: on 2026-09-16 that one sentence failed
 * ten of the twelve runs of a paired evaluation, the first of them in a fresh
 * project where nothing else could have written the file.
 *
 * A child that still cannot be read is returned by name rather than skipped in
 * silence, so the gate can say its verdict rests on an incomplete run.
 *
 * @param {Record<string, any>} project
 * @param {any[]} parentMessages
 * @param {(project: Record<string, any>, sessionId: string, options: {wake: boolean, parentSessionId: string | null}) => Promise<any>} readSessionHistory
 * @param {string | null} [rootSessionId] the session `parentMessages` belong to
 * @returns {Promise<{ assistants: any[], unreadable: string[] }>}
 */
async function readDelegatedAssistantMessages(project, parentMessages, readSessionHistory, rootSessionId = null) {
  /** @type {{ sessionId: string, parentSessionId: string | null }[]} */
  const queue = delegatedChildSessionIds(parentMessages).map((sessionId) => ({ sessionId, parentSessionId: rootSessionId }));
  const seen = new Set();
  const assistants = [];
  /** @type {string[]} */
  const unreadable = [];
  while (queue.length && seen.size < 32) {
    const next = /** @type {{ sessionId: string, parentSessionId: string | null }} */ (queue.shift());
    if (!next.sessionId || seen.has(next.sessionId)) continue;
    seen.add(next.sessionId);
    let history;
    try {
      history = await readSessionHistory(project, next.sessionId, { wake: false, parentSessionId: next.parentSessionId });
    } catch {
      unreadable.push(next.sessionId);
      continue;
    }
    if (!Array.isArray(history)) {
      unreadable.push(next.sessionId);
      continue;
    }
    const completed = history.filter((message) => messageId(message) && messageRole(message) === "assistant" && assistantFinished(message));
    assistants.push(...completed);
    for (const child of delegatedChildSessionIds(completed)) {
      if (!seen.has(child) && !queue.some((item) => item.sessionId === child) && seen.size + queue.length < 32) {
        queue.push({ sessionId: child, parentSessionId: next.sessionId });
      }
    }
  }
  return { assistants, unreadable };
}

// Tools whose job is to go and fetch from outside. Whether one succeeds depends
// on hosts nobody here controls, so its failures are graded differently from a
// tool that computes on data the run already holds. Searching was missing from
// this list, so one upstream returning 502 failed a run that had already found
// its evidence elsewhere and written every deliverable.
const evidenceSourceToolSuffixes = Object.freeze([
  "official_page_fetch",
  "open_access_full_text",
  "literature_search",
  "guideline_search",
  "biomedical_source_search",
  "drug_label_search",
  "pharmacy_reference_search",
  "clinical_trial_search",
  "patent_search",
]);
// Where the run finds the brief it was given. Written by the server at dispatch
// and read by the run and by its preflight; the delivery gate reads the
// server's own in-memory copy instead, so this file is a convenience for the
// run and never evidence about it.
export const workspaceBriefPath = ".evimed-brief/research-brief.md";


// Transport died before either side could say anything. The MCP client reports
// this as a bare string ("MCP error -32001: Request timed out") with no JSON
// envelope, so no code parses out of it and the failure fell through to
// terminal — the most recoverable class of failure there is, treated as the
// least. It only ever reached a verdict by luck: whether some later call to the
// same tool happened to succeed.
const transportFailureSignature = /\b(timed out|timeout|econnreset|econnrefused|etimedout|socket hang up|network error|connection (?:closed|reset|refused)|stream closed)\b/i;

function transportLevelToolFailure(part) {
  const raw = part?.state?.error;
  if (typeof raw !== "string" || !raw.trim() || raw.trim().startsWith("{")) return false;
  return transportFailureSignature.test(raw);
}

function evidenceSourceTool(tool) {
  if (typeof tool !== "string") return false;
  return evidenceSourceToolSuffixes.some((suffix) => tool === suffix || tool.endsWith(`_${suffix}`));
}

/**
 * The `.evimed-sources/` files this run's evidence tools reported writing, with
 * the sha256 each reported for them.
 *
 * `warning` counts as well as `success`. A warning is a caveat about the
 * retrieval — a guideline search answers `warning` for every result, "verify
 * the version before use" — not a claim that nothing was written; the digest
 * is what proves the bytes. Requiring `success` refused every package that
 * quoted a preserved guideline, in nine of twelve v8 ablation cells
 * (2026-09-16), while the run-side gate had accepted them.
 */
function successfulEvidenceSourceArtifacts(messages, runtimeWorkspaceRoot) {
  const artifacts = new Map();
  const runtimeRoot = path.resolve(runtimeWorkspaceRoot);
  for (const message of messages) {
    for (const part of message?.parts ?? []) {
      if (part?.type !== "tool" || part?.state?.status !== "completed" || !evidenceSourceTool(part.tool)) continue;
      const result = parsedToolResult(part);
      const hashes = result?.data?.artifactSha256s;
      if (
        (result?.status !== "success" && result?.status !== "warning")
        || !Array.isArray(result.artifacts)
        || !hashes
        || typeof hashes !== "object"
        || Array.isArray(hashes)
      ) continue;
      for (const value of result.artifacts) {
        if (typeof value !== "string") continue;
        try {
          const relative = path.isAbsolute(value)
            ? path.relative(runtimeRoot, path.resolve(value)).replace(/\\/g, "/")
            : value.replace(/\\/g, "/");
          if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) continue;
          const normalized = normalizeWorkspaceRelativePath(relative, "source artifact path");
          const digest = hashes[value];
          if (normalized.startsWith(".evimed-sources/") && /^[0-9a-f]{64}$/.test(digest ?? "")) {
            artifacts.set(normalized, digest);
          }
        } catch { /* untrusted tool metadata is omitted */ }
      }
    }
  }
  return artifacts;
}

/**
 * Skill names this run's own durable record says were injected.
 *
 * Under pre-injection a capability's skill bodies travel inside the child's
 * prompt, so the model never calls the `skill` tool and a transcript scan for
 * that call concludes the skill was missing — for every run, always. The
 * capability manifest requires `skills[]` precisely so delegation can inject
 * them, which is what makes the check answerable by construction instead of by
 * asking the model to confirm it loaded something.
 * @param {Record<string, any> | null | undefined} projection
 * @returns {Set<string>}
 */
function injectedSkills(projection) {
  const injected = new Set();
  for (const record of projection?.subagents ?? []) {
    for (const name of record?.skills ?? []) {
      if (typeof name === "string" && name.trim()) injected.add(name.trim());
    }
  }
  // Skills the composition put into the session's own system prompt rather
  // than leaving the model to fetch. Written by the run (the socket's
  // `evimed-guidance` provides the list and `evimed-store` projects it), so
  // this is the run's own receipt that the method was in front of it — the
  // same authority the delegation records above carry, not a claim from
  // configuration. Absent in an older runtime image, which reads as "nothing
  // was injected" and leaves the check exactly as it was.
  for (const name of projection?.injectedSkills ?? []) {
    if (typeof name === "string" && name.trim()) injected.add(name.trim());
  }
  return injected;
}

/**
 * Skill names the model loaded with the `skill` tool and actually received.
 *
 * The kernel's skill tool has one model-facing success shape, the
 * `<skill_content name="…">` block, and it renders a thrown lookup failure —
 * `skill "x" is unknown or no longer available` — as the text result of a
 * call that the session then reports as completed. Counting every completed
 * call as a load passed an evidence-appraisal run whose one `skill` call for
 * its own capability had returned exactly that error: the gate certified a
 * method the model never saw. A call is a load only when its result is the
 * block for the name that was asked for.
 * @param {any[]} messages @returns {Set<string>}
 */
function successfullyLoadedSkills(messages) {
  const loaded = new Set();
  for (const message of messages) {
    for (const part of message?.parts ?? []) {
      if (
        part?.type !== "tool"
        || part?.tool !== "skill"
        || part?.state?.status !== "completed"
      ) continue;
      const name = part?.state?.input?.name;
      if (typeof name !== "string" || !name.trim()) continue;
      if (skillContentDelivered(part?.state?.output, name.trim())) loaded.add(name.trim());
    }
  }
  return loaded;
}

/**
 * Whether a `skill` tool result is the kernel's rendered block for `name`.
 * The marker is the kernel's own output format, not prose: `dsh-skill`
 * renders `<skill_content name="<escaped name>">` first on every successful
 * path, and skill names admit no character that escaping would change.
 * @param {unknown} output @param {string} name
 */
function skillContentDelivered(output, name) {
  if (typeof output !== "string") return false;
  return output.trimStart().startsWith(`<skill_content name="${name}">`);
}

/**
 * Refusals a repair prompt is sent again for. Both can clear within seconds —
 * the kernel still settling the turn that just ended, a plugin configuration
 * being applied — and a refused repair costs the run its whole package.
 */
const TRANSIENT_REPAIR_REFUSALS = new Set(["runtime_session_error", "plugin_apply_in_progress"]);

/**
 * Send one repair prompt, again after a short wait when the refusal can be
 * transient, a bounded number of times.
 *
 * On 2026-09-16 a repair was refused 68 ms after it was authorized, half a
 * second after the run's last message, and the send sat in an empty catch — so
 * the run failed with its package and nothing anywhere said why. Every attempt
 * that fails is returned, so the run can name the refusal.
 *
 * @param {(text: string) => Promise<any>} sender @param {string} text @param {number[]} delaysMs
 * @returns {Promise<{ accepted: boolean, failures: unknown[] }>}
 */
async function sendRepair(sender, text, delaysMs) {
  /** @type {unknown[]} */
  const failures = [];
  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await sender(text);
      if (result?.accepted !== false) return { accepted: true, failures };
      failures.push(null);
      return { accepted: false, failures };
    } catch (error) {
      failures.push(error);
      const code = /** @type {any} */ (error)?.code;
      if (/** @type {any} */ (error)?.definitivelyRejected === true || !TRANSIENT_REPAIR_REFUSALS.has(code) || attempt >= delaysMs.length) {
        return { accepted: false, failures };
      }
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(delaysMs[attempt]) || 0)));
    }
  }
}

/**
 * Why a repair prompt did not reach the run, as one notice line: how many
 * times it was sent, and the last refusal's code and a bounded message.
 * @param {unknown[]} failures
 */
function repairDispatchFailure(failures) {
  const last = /** @type {any} */ (failures.at(-1));
  const tries = failures.length === 1 ? "" : ` after ${failures.length} attempts`;
  if (!last) return `The repair request was not accepted by the runtime${tries} (accepted: false), so no repair was attempted.`;
  const code = typeof last?.code === "string" ? last.code : "unknown";
  const message = String(last?.message ?? last).replace(/\s+/g, " ").slice(0, 240);
  return `The repair request could not be dispatched${tries} (${code}: ${message}), so no repair was attempted.`;
}

function parsedToolErrorCode(part) {
  const candidates = [part?.state?.error, parsedToolResult(part)];
  for (const candidate of candidates) {
    let value = candidate;
    if (typeof value === "string" && value.trim().startsWith("{")) {
      try {
        value = JSON.parse(value);
      } catch {
        continue;
      }
    }
    const code = value?.error?.code ?? value?.code;
    if (typeof code === "string" && code.trim()) return code.trim();
  }
  return null;
}

function failedToolPart(part) {
  return part?.type === "tool"
    && (part?.state?.status === "error" || parsedToolResultStatus(part) === "error");
}

function successfulToolPart(part) {
  return part?.type === "tool"
    && part?.state?.status === "completed"
    && parsedToolResultStatus(part) !== "error";
}

/**
 * The connector a failed research call was missing a credential for: the
 * public-source gateway refuses with `public_source_<connector>_credential_missing`
 * (hyphens as underscores), and a connector is one of the closed list a
 * researcher can hold a credential for (`CONNECTOR_CREDENTIALS`). Null for any
 * other code. A format, not a reading of prose.
 * @type {ReadonlyMap<string, string>}
 */
const missingCredentialCodes = new Map(CONNECTOR_CREDENTIALS.map((spec) => [
  `public_source_${spec.id.replaceAll("-", "_")}_credential_missing`, spec.id,
]));

/** @param {string | null} errorCode @returns {string | null} */
function missingCredentialConnector(errorCode) {
  return (errorCode && missingCredentialCodes.get(errorCode)) ?? null;
}

/**
 * The terminal outcome a turn's messages decide. Callers go on to add the
 * delivery verdict to it (`verification`, `qualityNotices`, …), hence open.
 * @param {any[]} messages
 * @returns {{ status: string, errorCode: string | null, errorSubCode: string | null, missingCredential?: string } & Record<string, any>}
 */
function terminalFromMessages(messages) {
  for (const message of messages) {
    const error = message?.info?.error;
    const serialized = JSON.stringify(error ?? "").toLowerCase();
    if (serialized.includes("abort") || serialized.includes("cancel")) {
      return { status: "canceled", errorCode: "runtime_canceled", errorSubCode: null };
    }
    // The sub-code the kernel already told us and the ledger threw away.
    // `runtime_session_error` covered a context overflow and an ordinary
    // session fault with the same string, so the one failure whose remedy is a
    // different context policy was indistinguishable from every other — which
    // is exactly the measurement the compaction decision needs.
    if (error) {
      const subCode = typeof error.subCode === "string" && error.subCode ? error.subCode : null;
      return { status: "failed", errorCode: "runtime_session_error", errorSubCode: subCode };
    }
  }
  const toolParts = messages.flatMap((message) => message?.parts ?? []).filter((part) => part?.type === "tool");
  for (const [index, part] of toolParts.entries()) {
    if (!failedToolPart(part)) continue;
    // A run's verdict is about the EviMed research work. Editor and shell tools
    // fail routinely while an agent explores — one `read` past end of file
    // failed an otherwise complete peer review — and whether the deliverables
    // exist is checked separately against the declared outputs.
    // Asked of the vocabulary, not by substring. A research tool has three
    // spellings — bare, `mcp__evimed__`-prefixed and the historic `evimed_` —
    // and a substring test both misses the bare one the rollback kernel shows
    // and matches the socket's own `evimed_plan`, which is not research work.
    if (typeof part.tool !== "string" || !isMcpToolName(part.tool)) continue;
    const errorCode = parsedToolErrorCode(part);
    // Keyed on the code, not on which tool asked. Every code in that set means
    // an external source was unreachable or had nothing to give, and that is
    // equally true whichever tool made the request. Pairing it with a
    // hand-listed set of "evidence source" tools meant the list decided the
    // verdict: an openFDA adverse-event query answering HTTP 400 failed a run
    // that had produced every deliverable, only because adr_case_query was not
    // on a list written before it mattered. A list of tools always lags the
    // tools; the code is the fact.
    if (recoverableEvidenceSourceErrorCodes.has(errorCode)) continue;
    if (errorCode === null && transportLevelToolFailure(part)) continue;
    const correctedByLaterSuccess = toolParts.slice(index + 1).some((candidate) => (
      candidate.tool === part.tool && successfulToolPart(candidate)
    ));
    if (!correctedByLaterSuccess) {
      // A source the researcher can open themselves: the account page takes
      // their own credential (connectorCredentials.mjs). Named as the sub-code
      // and as its own field, so the reader is told what to add rather than
      // that a tool failed.
      const missingCredential = missingCredentialConnector(errorCode);
      return { status: "failed", errorCode: "runtime_tool_error", errorSubCode: missingCredential, ...(missingCredential ? { missingCredential } : {}) };
    }
  }
  return { status: "succeeded", errorCode: null, errorSubCode: null };
}

/** @param {any} issues @param {any} shrinkage @param {boolean} revisionRequired */
function clinicalEvidenceRepairPrompt(issues, shrinkage = null, revisionRequired = true) {
  const bounded = issues
    .filter((issue) => typeof issue === "string" && issue.trim())
    .slice(0, 40)
    .map((issue) => `- ${issue.slice(0, 300)}`)
    .join("\n");
  const measured = shrinkage
    ? [`Your last revision removed ${shrinkage.lost} characters from clinical-evidence-report.md (${shrinkage.startSize} down to ${shrinkage.currentSize}). Restore that material with the support it was missing. Deleting a further line to clear a remaining issue is not an acceptable resolution.`]
    : [];
  return [
    "The server-side clinical evidence gate rejected the current package.",
    "When a capability child wrote the package, this resumed root session is its authenticated repair successor. Continue from the existing files and preserved sources; do not delegate any file or source to another child.",
    ...measured,
    ...(revisionRequired ? ["The local gate already accepted and froze this deliverable. Before changing any file, call evimed_revise_deliverable with the deliverable id and this server verdict as the reason. The server has already retained the accepted bytes outside the runtime workspace; the tool opens a new revision, after which you must repair and resubmit the new bytes."] : []),
    "Revise the named files in the existing academic package in place: clinical-evidence-report.md or clinical-evidence-matrix.json.",
    "Patch clinical-evidence-report.md with the edit tool, changing only the lines the issues name. Do not rewrite it with the write tool: replacing the whole file regenerates it from what you still hold in context, which after a long run is a compressed recollection, so the report comes back shorter and you cannot tell that it did. Measured across four production repairs, every whole-file rewrite lost content — one shed 1,863 characters and the next 4,125 — while targeted edits held the report steady and ended slightly longer.",
    "The same applies to the matrix: change what an issue names and leave the rest alone, preserving already valid evidence and source metadata. Rewriting it whole is warranted only when its structure is what the issue rejects, such as JSON that no longer parses.",
    "The matrix must remain strict JSON. Escape embedded quotation marks correctly instead of changing scientific wording to work around JSON syntax.",
    "Never create or modify a .evimed-sources artifact. When a material claim lacks usable support, go and retrieve one with the approved evidence tools. Deleting the claim is the last resort, not the first: it satisfies the gate while making the analysis smaller, and a report that answers the question is worth more than a shorter one that passes. If you do drop a claim, say in your reply which claim went and why no source could support it.",
    "Treat repeated numeric-fact messages as one report-wide audit task. For each number, first attach it to the citation and hidden matrix claim marker that support it; drop only the numbers that are genuinely incidental to the argument. Do not resolve this by stripping the report of its quantitative content — effect estimates, sample sizes and confidence intervals are the analysis, not decoration.",
    "This revision must not leave the report thinner than it was. You are repairing traceability, not trimming to fit; if the corrected report is materially shorter, you have removed evidence instead of grounding it.",
    "Improve scientific synthesis, comparison, clinical reasoning, evidence appraisal, and applicability where the issues identify a substantive gap. A weighed cross-source conclusion (a synthesized claim backed by at least two supporting sources) is preferable to a chain of single-source restatements, and the report must state its bottom line early in readable prose. Do not pad the report, repeat conclusions, or add claims merely to increase counts.",
    "Every evidence-matrix claim must appear in the report on a line with its exact numbered citation and hidden claim marker. Emergency-call support quotes must include both the call action and the qualifying symptom condition.",
    "Keep only limitations that materially affect interpretation, and synthesize them rather than writing a checklist. Remove tool names, gateway names, and first-person retrieval diaries from the analysis; a material limit on evidence accessibility (for example, a guideline whose full text is not openly available) belongs in the Limitations section, stated as a property of the evidence base rather than a narration of the retrieval run.",
    "The safety-first practical section must come before the reference list. Remove unsupported self-care details; every numbered step and bullet must have direct support, a numbered citation, and a matching hidden claim marker.",
    // The check is a tool call now, not a script.
    //
    // This used to name `$XDG_CONFIG_HOME/opencode/skills/.../preflight.py` —
    // an OpenCode path, for a script this repository no longer contains. Every
    // clinical repair therefore opened by ordering the run to execute something
    // that is not there, and spent one of its bounded attempts finding out. The
    // run-side gate is what preflight became: submitting is how a package asks
    // whether it passes, and its issues are the same issues.
    "After fixing the files, submit the package again with evimed_submit_deliverable.",
    "Fix every issue it returns and resubmit until it accepts, then read every required deliverable back before finishing:",
    bounded,
  ].join("\n");
}

/**
 * The repair prompt for the other fifteen capabilities.
 *
 * `canRepair` used to require `effectiveAgentId === "clinical-evidence-synthesis"`,
 * so a bibliometric or dataset-scoping run whose contract rejected it failed
 * outright — with the same actionable issue text the clinical loop repairs
 * from. The issues were never clinical: `requiredSpecialistArtifacts` produces
 * `specialist_required_output_missing` and `_stale` for every capability that
 * declares required outputs, which is all of them.
 *
 * The clinical prompt could not simply be reused. It names
 * `clinical-evidence-report.md`, the evidence matrix and the citation ledger by
 * hand, so sending it to a bibliometric run would order that run to repair
 * files it does not have and spend a bounded attempt discovering that — the
 * same failure as the OpenCode `preflight.py` path this file already fixed
 * once. What is shared is the part that is about repair rather than about
 * clinical evidence, and that part is the whole of this function.
 *
 * The issue list leads and is verbatim. Structured feedback that carries
 * position, observed value and an acceptable alternative raises repair success
 * by 42–44 points, and the gain comes from the third element (arXiv 2607.14167);
 * the gate's issues already have that shape, so restating them would only lose
 * it.
 *
 * @param {any} agent the capability record, for its own required outputs
 * @param {readonly string[]} issues
 * @param {boolean} revisionRequired
 */
function specialistRepairPrompt(agent, issues, revisionRequired = false) {
  const bounded = issues
    .filter((issue) => typeof issue === "string" && issue.trim())
    .slice(0, 40)
    .map((issue) => `- ${issue.slice(0, 300)}`)
    .join("\n");
  // The capability's own manifest, not a list written here: `outputs` is what
  // `requiredSpecialistArtifacts` checked against, so naming anything else
  // would send the run after files the gate is not asking for.
  const required = (agent?.outputs ?? [])
    .filter((output) => output?.required && typeof output.path === "string" && output.path)
    .map((output) => output.path)
    .slice(0, 20);
  return [
    `The server-side delivery gate rejected this ${agent?.id ?? "capability"} package.`,
    "When a capability child wrote the package, this resumed root session is its authenticated repair successor. Continue from the existing files; do not delegate any file to another child.",
    ...(revisionRequired ? ["The local gate already accepted and froze this deliverable. Before changing any file, call evimed_revise_deliverable with the deliverable id and this server verdict as the reason. The server has already retained the accepted bytes outside the runtime workspace; the tool opens a new revision, after which you must repair and resubmit the new bytes."] : []),
    ...(required.length ? [`Revise the existing package in place. Its required deliverables are: ${required.join(", ")}.`] : ["Revise the existing package in place."]),
    // Capability-independent, and measured: four production clinical repairs
    // showed every whole-file rewrite losing content (1,863 and 4,125
    // characters in two of them) while targeted edits held steady. Nothing in
    // that mechanism is about clinical evidence — it is about regenerating a
    // long document from a compressed recollection.
    "Patch prose deliverables with the edit tool, changing only what the issues name. Do not rewrite a whole file with the write tool: replacing it regenerates it from what you still hold in context, which after a long run is a compressed recollection, so it comes back shorter and you cannot tell that it did. Rewriting a whole file is warranted only when its structure is what the issue rejects, such as a JSON deliverable that no longer parses.",
    "Every JSON deliverable must remain strict JSON. Escape embedded quotation marks correctly instead of changing wording to work around JSON syntax.",
    "Deleting content is the last resort, not the first: it satisfies the gate while making the work smaller. If you do drop something, say in your reply what went and why it could not be supported.",
    "After fixing the files, submit the package again with evimed_submit_deliverable.",
    "Fix every issue it returns and resubmit until it accepts, then read every required deliverable back before finishing:",
    bounded,
  ].join("\n");
}

/** @param {readonly string[]} deliverableIds */
function clinicalEvidenceResubmitPrompt(deliverableIds) {
  return [
    "The server-side clinical evidence gate accepted the current bytes, but the run ended without a local delivery receipt.",
    "Do not edit, rewrite, rename, or delete any deliverable file. The package already passed on the bytes now on disk.",
    `Call evimed_submit_deliverable once for each of ${deliverableIds.join(", ")} so the run-side gate can write the missing receipt.`,
    "If that submission accepts, call evimed_complete_run without partial mode and finish. If it rejects, follow only the returned issue and preserve the current files.",
  ].join("\n");
}

function artifactCandidates(message, runtimeWorkspaceRoot) {
  const candidates = [];
  const runtimeRoot = path.resolve(runtimeWorkspaceRoot);
  for (const part of message?.parts ?? []) {
    if (
      part?.type !== "tool" ||
      !["write", "edit"].includes(part.tool) ||
      part?.state?.status !== "completed"
    ) continue;
    // `file_path` is what the model actually sends. DSH's `write` and `edit`
    // declare `{ file_path, content }` / `{ file_path, old_string, ... }` and
    // camel-case it internally in `parseWriteArgs`/`parseEditArgs` — the
    // transcript records the raw model-facing arguments, so `filePath` is the
    // spelling that never arrives. Reading only it recognised no artifact from
    // any DSH write, which is indistinguishable from a run that wrote nothing.
    //
    // The older spellings stay for the kernel on its way out.
    const input = part?.state?.input;
    const value = input?.file_path ?? input?.filePath ?? input?.path;
    if (typeof value !== "string") continue;
    try {
      const relative = path.isAbsolute(value)
        ? path.relative(runtimeRoot, path.resolve(value)).replace(/\\/g, "/")
        : value.replace(/\\/g, "/");
      if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) continue;
      candidates.push(normalizeWorkspaceRelativePath(relative, "artifact path"));
    } catch { /* untrusted tool metadata is omitted */ }
  }
  return [...new Set(candidates)].slice(0, maxArtifacts).sort();
}

async function existingArtifacts(project, candidates, run = null, endTime = null) {
  const result = [];
  for (const relative of candidates) {
    let opened;
    try {
      opened = await openScopedFileNoFollow(project.workspaceDir, path.join(project.workspaceDir, relative));
      if (opened.stat.isFile() && (!run?.nativeTurn || (opened.stat.mtimeMs >= Date.parse(run.startedAt)
        && (endTime == null || opened.stat.mtimeMs <= endTime + 1)))) result.push(relative);
    } catch { /* missing, escaped, or linked artifacts are not recorded */ }
    finally { await opened?.handle.close().catch(() => {}); }
  }
  return result;
}

async function readRequiredFile(project, relative, freshSince = null) {
  // Prefer a file this run actually wrote.
  //
  // The root lookup below is first because a capability declares bare names and
  // nothing forbids writing them at the root. But a workspace is reused across
  // runs, so a same-named file left at the root by an earlier run shadows the
  // package today's run wrote into `deliverables/<id>/` — and because the root
  // file is returned before anything looks further, the run is then failed
  // `specialist_required_output_stale` for a file it did not write while its own
  // complete package sits one directory away, untouched.
  //
  // That is not hypothetical: it is what happened to the 2026-09-08 clinical
  // acceptance. A 70-minute run produced a full synthesis at
  // `deliverables/empa-kidney-durability/clinical-evidence-report.md`, and a
  // `clinical-evidence-report.md` from 2026-07-23 at the workspace root failed
  // it. The native-turn path above already iterates candidates and takes the
  // fresh one — with a comment saying "a root file from yesterday must not hide
  // today's nested deliverable" — so the rule existed and only one of the two
  // paths had it.
  //
  // Freshness decides only *which* candidate; it never invents one. When no
  // candidate is fresh the original order stands, so a genuinely stale package
  // still reaches the staleness verdict with the same file it always did.
  if (freshSince != null) {
    for (const candidate of [relative, ...await deliverableCandidatePaths(project, relative)]) {
      const found = await openWorkspaceText(project, candidate);
      if (found && found.stat.mtimeMs + 1_000 >= freshSince) return found;
    }
  }
  const direct = await openWorkspaceText(project, relative);
  if (direct) return direct;
  // Then under the deliverable directories.
  //
  // A capability declares its outputs as bare names — `clinical-evidence-report
  // .md` — and the gate's own message still says "at the workspace root",
  // because that is where the OpenCode composition wrote them. The DSH
  // composition writes each package into `deliverables/<deliverableId>/`: one
  // run can deliver several, the path guard fences each one, and §9.5 makes
  // that directory the only input its validator accepts. So one declared
  // name has two possible homes, and the gate that knew only the root
  // reported every DSH package as missing. The root lookup stays first
  // because the declared name is bare and nothing forbids writing it there.
  //
  // Resolved rather than configured: the deliverable id belongs to the run, not
  // to the deployment, and the receipt that names it is not always present —
  // this path also runs while the container is still alive.
  for (const candidate of await deliverableCandidatePaths(project, relative)) {
    const found = await openWorkspaceText(project, candidate);
    if (found) return found;
  }
  return null;
}

/** @param {Record<string, any>} project @param {string} relative */
async function openWorkspaceText(project, relative) {
  let opened;
  try {
    opened = await openScopedFileNoFollow(project.workspaceDir, path.join(project.workspaceDir, relative));
    if (!opened.stat.isFile() || opened.stat.size <= 0 || opened.stat.size > 8 * 1024 * 1024) return null;
    return { text: await opened.handle.readFile("utf8"), stat: opened.stat, relativePath: relative };
  } catch {
    return null;
  } finally {
    await opened?.handle.close().catch(() => {});
  }
}

/**
 * What a run's evidence matrices say about their own claims, by the same rule
 * the reader's 「依据」 marks use (`claimVerification`, the gate's own quote
 * comparison), so a count on a run row and the marks in its report cannot
 * disagree.
 *
 * Reads each matrix and at most 48 preserved sources it quotes, like the gate.
 * `previousKey` makes an unchanged set of matrices free: the caller polls, and
 * re-reading every source on every poll would be most of the monitor's work.
 *
 * @param {Record<string, any>} project @param {readonly string[]} relativePaths
 * @param {string | null} [previousKey]
 * @returns {Promise<{ key: string, total: number, verified: number, unverified: number } | null>}
 *   null when nothing changed since `previousKey`
 */
async function matrixClaimSummary(project, relativePaths, previousKey = null) {
  /** @type {{ relative: string, file: { text: string, stat: import('node:fs').Stats } }[]} */
  const found = [];
  for (const relative of relativePaths) {
    const file = await openWorkspaceText(project, relative);
    if (file) found.push({ relative, file });
  }
  const key = found.map(({ relative, file }) => `${relative}:${file.stat.size}:${file.stat.mtimeMs}`).join("|");
  if (previousKey !== null && key === previousKey) return null;
  const totals = { key, total: 0, verified: 0, unverified: 0 };
  for (const { file } of found) {
    let matrix;
    try { matrix = JSON.parse(file.text); } catch { continue; }
    const named = (Array.isArray(matrix?.claims) ? matrix.claims : []).flatMap((/** @type {any} */ claim) => [
      claim?.artifactPath,
      ...(Array.isArray(claim?.supportingSources) ? claim.supportingSources.map((/** @type {any} */ source) => source?.artifactPath) : []),
    ]).filter((value) => typeof value === "string" && value.startsWith(".evimed-sources/"));
    /** @type {Record<string, string>} */
    const sourceArtifacts = {};
    for (const artifactPath of [...new Set(named)].slice(0, 48)) {
      let relative;
      try { relative = normalizeWorkspaceRelativePath(artifactPath, "source artifact path"); } catch { continue; }
      const source = await openWorkspaceText(project, relative);
      if (source) sourceArtifacts[artifactPath] = source.text;
    }
    const summary = claimSummaryOf(claimVerification({ matrix, sourceArtifacts }));
    if (!summary) continue;
    totals.total += summary.total;
    totals.verified += summary.verified;
    totals.unverified += summary.unverified;
  }
  return totals;
}

/**
 * `deliverables/<id>/<name>` for every deliverable directory the run made.
 * @param {Record<string, any>} project @param {string} relative
 * @returns {Promise<string[]>}
 */
async function deliverableCandidatePaths(project, relative) {
  if (relative.includes("/")) return [];
  let entries;
  try {
    entries = await readdir(path.join(project.workspaceDir, workspaceLayout.deliverablesDir), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${workspaceLayout.deliverablesDir}/${entry.name}/${relative}`)
    .sort();
}

function citedHttpUrls(text) {
  // Exclude and strip trailing ASCII and CJK/full-width punctuation so a URL
  // written in Chinese prose (…example-a。) matches the same URL recorded inside
  // JSON quotes in the snapshot.
  return [...String(text).matchAll(/https?:\/\/[^\s)\]}>"'，。；、）】》「」『』！？…]+/g)]
    .map((match) => match[0].replace(/[.,;，。；、）】》「」『』！？…]+$/, ""));
}

// An address nobody outside this deployment can resolve. The named internal
// route was the instance that got written down; loopback and private addresses
// are the same defect, and a citation reaches a reader who is not on this
// network. Generalized rather than listed so a second internal hostname cannot
// arrive as a second bug.
function unresolvableCitationHost(url) {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  if (host === "::1" || host === "0.0.0.0" || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return false;
  const [a, b] = ipv4.slice(1).map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

// What stops a reader checking a citation, kept apart from what merely looks
// untidy. A reader follows the link and reads the source: an address that
// cannot be resolved, or one carrying credentials that must never ship, defeats
// that and is blocking. A source published over plain HTTP does not — the
// reader opens it and reads it — so it is a notice on delivered work.
//
// Requiring HTTPS as a condition of delivery discarded two complete production
// reports over one link each: a CQVIP journal record, and
// http://purl.obolibrary.org/obo/CHEBI_28093, where http:// is the canonical
// form of the persistent identifier and rewriting it as https would have made
// the citation less correct. A URL fragment was rejected on the same footing,
// though #section-3 is how a citation points at the passage it means; that is
// not a defect at all and is no longer treated as one.
function citationUrlDefects(text) {
  const blocking = [];
  const advisory = [];
  for (const value of citedHttpUrls(text)) {
    let url;
    try {
      url = new URL(value);
    } catch {
      blocking.push(`The citation ${value} is not a resolvable URL, so a reader cannot reach the source it names.`);
      continue;
    }
    if (url.username || url.password) {
      blocking.push(`The citation for ${url.hostname} carries credentials in the URL; cite the public address of the source instead.`);
      continue;
    }
    if ((url.hostname === "www.evimed.com" && url.pathname.startsWith("/api-evimed/")) || unresolvableCitationHost(url)) {
      blocking.push(`The citation ${value} points inside this deployment, which a reader outside it cannot open; cite the public source the record came from.`);
      continue;
    }
    if (url.protocol !== "https:") {
      advisory.push(`The citation ${value} is served over plain HTTP. The source is reachable and the claim stands; prefer the HTTPS address where the publisher offers one.`);
    }
  }
  return { blocking, advisory };
}

// Deliverables replaced wholesale after a repair was asked for. Patching with
// edit keeps everything the issues did not name; replacing the file regenerates
// it from what the run still holds in context, which late in a long run is a
// compressed recollection of its own evidence. The size notice reports that the
// report ended smaller; this reports why, and catches a rewrite that happens to
// come back the same length while having lost its detail.
function wholeFileRewritesDuringRepair(messages) {
  const rewrites = [];
  let repairing = false;
  for (const message of messages) {
    for (const part of message?.parts ?? []) {
      if (
        message?.info?.role === "user" && part?.type === "text"
        && String(part.text ?? "").includes("clinical evidence gate rejected")
      ) {
        repairing = true;
        continue;
      }
      if (!repairing || part?.type !== "tool" || part.tool !== "write") continue;
      const target = String(part?.state?.input?.filePath ?? part?.state?.input?.path ?? "");
      if (/clinical-evidence-report\.md$/.test(target)) rewrites.push(target);
    }
  }
  return rewrites;
}

// Subagent calls that were asked to read a retrieved-evidence file rather than
// to answer a question. The runtime writes an oversized tool result to
// tool-output/<id>, so a delegation prompt naming that path is by definition a
// delegated read of evidence the caller will go on to quote.
/**
 * Both halves have to widen together, and widening only one is worse than
 * widening neither.
 *
 * `task` is OpenCode's delegation tool. Under DSH no tool of that name exists:
 * the preset registers `@deepseek-ai/dsh-tool-subagent` as `subagent`, and the
 * socket registers its own `evimed_delegate`. The adapter passes the kernel's
 * tool name through verbatim, so `part.tool` is never `task` and this returned
 * `[]` for every DSH run — which silently unreachable three things: the
 * `specialist_delegated_evidence_read` verdict, one of the two triggers for
 * `qualityUnverified`, and the `MUST FIX —` lead line that tells a repair loop
 * the cause rather than only the symptom.
 *
 * And `evimed_delegate` takes `{deliverableId, brief, inputs}` — there is no
 * `prompt` key. Renaming the tool without also reading `brief` would fix the
 * kernel's own route and leave every socket delegation reading `""`, which is
 * the same silence with a shorter list of causes.
 */
const delegationToolNames = new Set(["task", "subagent", SOCKET_TOOL_NAMES.delegate]);

function delegatedDocumentReads(messages) {
  return messages
    .flatMap((message) => message?.parts ?? [])
    .filter((part) => part?.type === "tool" && delegationToolNames.has(part.tool))
    .filter((part) => {
      const input = part?.state?.input;
      const prompt = String(input?.prompt ?? input?.brief ?? "");
      return /tool-output\//.test(prompt) || /\.evimed-sources\//.test(prompt);
    });
}

function assistantProse(messages) {
  return messages
    .flatMap((message) => message?.parts ?? [])
    .filter((part) => part?.type === "text" && typeof part?.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/**
 * The specialist completion verdict, named once.
 *
 * It was declared on `requiredSpecialistArtifacts` and inferred on the function
 * that produces it, which held only while the domain's own checks returned
 * `any`. Once those were typed, the inferred union stopped matching the
 * declaration and the disagreement surfaced here rather than in whatever read
 * the field later. One typedef, both ends.
 *
 * @typedef {{
 *   artifacts: any[],
 *   errorCode: string|null,
 *   qualityIssues?: string[],
 *   qualityFindings?: StoredNotice[],
 *   qualityStructural?: boolean,
 *   qualityDegradable?: boolean,
 *   qualityUnverified?: boolean,
 *   qualityUnchecked?: boolean,
 *   qualityNotices?: StoredNotice[],
 * }} SpecialistCompletionVerdict
 *
 * `qualityIssues` are the strings the repair loop hands back to the run,
 * verbatim; `qualityFindings` are the same findings with their identity, for
 * the record. `qualityNotices` are findings that decide nothing.
 */

/**
 * `qualityStructural` marks the rejections whose whole issue list is one fact:
 * the deliverable did not parse, or a required file is not in the workspace.
 * Every site that sets it returns immediately with the issues it names, so the
 * flag is a statement about that return, not a guess about a mixed list — a
 * verdict carrying content findings alongside can never be marked here.
 *
 * The repair loop charges those rounds against a separate, finite allowance
 * (see reconcileSession). It changes no verdict and no issue text: the same
 * package is rejected with the same words, only the round is billed elsewhere.
 */

/** What a capability's contract says about a turn that produced nothing of it. */
const NATIVE_ANSWER_WHEN_NOTHING_STARTED = new Set([
  "specialist_required_output_missing",
  "specialist_required_output_stale",
  "specialist_required_skill_missing",
]);

/**
 * Whether a native turn began delivering: it wrote or read a plan, delegated a
 * deliverable, or submitted one (the parent's own tool calls, `nativeWorkflow`).
 * @param {Record<string, any>} run
 */
function nativeTurnStartedDelivery(run) {
  const proof = run.nativeWorkflow;
  return Boolean(proof && (proof.plan || (proof.delegates ?? []).length > 0 || (proof.submissions ?? []).length > 0));
}

/** TypeScript infers a destructured parameter as exactly the shape its
 *  defaults name, which rejects every other property a caller passes.
 *  @param {any} project
 *  @param {any} run
 *  @param {any} agentRegistry
 *  @param {any} sourceArtifactProvenance
 *  @param {any} assistantMessages
 *  @returns {Promise<SpecialistCompletionVerdict>}
 */
async function requiredSpecialistArtifacts(
  project,
  run,
  agentRegistry,
  sourceArtifactProvenance = new Map(),
  assistantMessages = [],
  briefText = null,
) {
  // Notices a check raises that do not decide the verdict. Collected here
  // because the checks below each return the moment they conclude, so a finding
  // that is not a reason to withhold anything has nowhere else to survive.
  /** @type {StoredNotice[]} */
  const advisories = [];
  // Layers that did not run. Separate from the advisories because "we looked
  // and found nothing to say" and "we did not look" are different facts, and
  // only the second one has to reach the machine-readable verdict.
  /** @type {string[]} */
  const skippedChecks = [];
  const outcome = await specialistCompletionOutcome(
    project,
    run,
    agentRegistry,
    sourceArtifactProvenance,
    assistantMessages,
    advisories,
    briefText,
    skippedChecks,
  );
  // A turn asked in the conversation window that started no delivery — no
  // plan, no delegation, no submission — and left none of the capability's
  // outputs is an answer, whatever the classifier guessed the question was.
  // There the research assistant decides whether to deliver files; the route
  // is a guess about the question, not a contract the turn took on. On
  // 2026-09-19 a follow-up in a finished aspirin conversation was routed to
  // clinical-evidence-synthesis (llm 0.76), answered in two sentences that
  // pointed at the report already delivered, and recorded as 「失败：运行时未载入
  // 能力方法」. A turn that did produce the capability's files, or that planned,
  // delegated or submitted, is judged by the contract exactly as before, and a
  // dispatched run always is.
  if (run.nativeTurn && (outcome.artifacts ?? []).length === 0 && NATIVE_ANSWER_WHEN_NOTHING_STARTED.has(String(outcome.errorCode))
    && !nativeTurnStartedDelivery(run)) {
    return { artifacts: [], errorCode: null };
  }
  const unchecked = skippedChecks.length > 0 ? { qualityUnchecked: true } : {};
  // The structured twin of `qualityIssues`, for the reader. The strings stay
  // exactly what they were, because the repair loop hands them back to the run
  // verbatim; the findings carry each one's identity, so the record can title
  // it in Chinese without translating the sentence (C2).
  const findings = qualityFindingsOf(outcome);
  if (advisories.length === 0) return { ...outcome, ...unchecked, ...(findings.length ? { qualityFindings: findings } : {}) };
  // An advisory riding along is a second fact, so the rejection is no longer
  // attributable to the structural cause alone and must be charged normally.
  // Marking the return site was the honest place to decide it; this is the one
  // place that can add to that list afterwards, so it is the one place that has
  // to take the mark back.
  return outcome.errorCode
    ? { ...outcome, ...unchecked, qualityStructural: false,
      qualityIssues: [...(outcome.qualityIssues ?? []), ...advisories.map(noticeText)],
      qualityFindings: [...findings, ...advisories] }
    : { ...outcome, ...unchecked, qualityNotices: advisories };
}

/**
 * Verdict codes whose issues are defects in the evidence a reader cannot see
 * for themselves — `must-fix`. Every other verdict's issues are advice: a
 * process gap, a bookkeeping gap, something the reader can check.
 */
const mustFixVerdictCodes = new Set([
  "specialist_citation_invalid",
  "specialist_citation_integrity_failed",
  "specialist_cited_source_unrecorded",
  "specialist_evidence_snapshot_missing",
  "specialist_evidence_snapshot_invalid",
  "specialist_evidence_snapshot_empty",
  "specialist_evidence_traceability_failed",
  "specialist_evidence_provenance_failed",
  "specialist_evidence_integrity_failed",
  "specialist_delegated_evidence_read",
  "specialist_required_output_missing",
  "specialist_required_output_stale",
]);

/**
 * The structured findings of a completion verdict: the ones the verdict built
 * itself (the clinical path, which knows each finding's check), or one per
 * issue string, identified by the verdict's own code.
 * @param {SpecialistCompletionVerdict} outcome @returns {StoredNotice[]}
 */
function qualityFindingsOf(outcome) {
  if (Array.isArray(outcome.qualityFindings)) return outcome.qualityFindings;
  const code = outcome.errorCode ?? "gate_notice";
  const severity = mustFixVerdictCodes.has(code) ? "must-fix" : "advice";
  return (outcome.qualityIssues ?? []).filter((issue) => typeof issue === "string" && issue.trim()).map((issue) => (
    issue.startsWith("SAFETY — ") ? runNotice(code, issue, { severity: "safety" })
      : issue.startsWith("MUST FIX — ") ? runNotice(code, issue, { severity: "must-fix" })
        : runNotice(code, issue, { severity })
  ));
}

/**
 * Every skill this run actually had, by any of the three routes: the model
 * loaded it with the `skill` tool, delegation injected its body into a child's
 * prompt, or the control plane mounted the body into the system prompt itself.
 * All three are "the capability's method was in front of the model"; only the
 * first leaves a tool call to scan for.
 *
 * The mounted names come from this store's own ledger rather than the run-side
 * projection, because the control plane is the party that did the mounting —
 * asking the runtime to confirm it would put the answer back in the hands of
 * the side that cannot know.
 * @param {any} project @param {any} assistantMessages @returns {Promise<Set<string>>}
 */
async function loadedOrInjectedSkills(project, assistantMessages, run = null) {
  const loaded = successfullyLoadedSkills(assistantMessages);
  for (const name of run?.mountedSkills ?? []) {
    if (typeof name === "string" && name.trim()) loaded.add(name.trim());
  }
  const read = await readRunStateProjection(project, project.workspaceDir, run);
  if (read.state !== "read") {
    // A native turn with no plan has nothing for `scopeNativeProjection` to
    // admit — a plain question the researcher typed into the kernel's page —
    // yet the composition put the answer persona into that session's system
    // prompt and the run's own index records it. Read the index as written
    // and take its injected skills, and nothing else, when it names this very
    // session: every plain question asked on the adopted path was delivered
    // 未核验 with 「运行时未载入能力方法」 (2026-09-15, again 2026-09-19).
    if (run?.nativeTurn && read.state === "unattributed" && run.sessionId) {
      const raw = await readRunStateProjection(project, project.workspaceDir, null);
      if (raw.state === "read" && raw.projection?.sessionId === run.sessionId) {
        for (const name of raw.projection?.injectedSkills ?? []) {
          if (typeof name === "string" && name.trim()) loaded.add(name.trim());
        }
      }
    }
    return loaded;
  }
  // A skill receipt is completion authority, so unlike display-only legacy
  // projections it must identify this exact control-plane run. A native turn's
  // projection already does: `scopeNativeProjection` admitted it by session
  // and kernel run, and its id is the kernel's (`native_…`), never the
  // ledger's. Comparing that id with the run's discarded the children's
  // injected methods on every adopted run and marked the first live aspirin
  // run of 2026-09-19 — both deliverables accepted first time — 未核验.
  if (run && !run.nativeTurn && read.projection?.runId !== run.id) return loaded;
  for (const name of injectedSkills(read.projection)) loaded.add(name);
  return loaded;
}

/** @param {any} project
 *  @param {any} run
 *  @param {any} agentRegistry
 *  @param {any} sourceArtifactProvenance
 *  @param {any} assistantMessages
 *  @param {StoredNotice[]} advisories
 *  @param {any} briefText
 *  @param {string[]} skippedChecks
 *  @returns {Promise<SpecialistCompletionVerdict>}
 */
async function specialistCompletionOutcome(
  project,
  run,
  agentRegistry,
  sourceArtifactProvenance,
  assistantMessages,
  advisories,
  briefText,
  skippedChecks = [],
) {
  if (!run.effectiveAgentId) return { artifacts: [], errorCode: null };
  const registry = await agentRegistry;
  const agent = registry?.get?.(run.effectiveAgentId);
  if (!agent || agent.version !== run.effectiveAgentVersion || agent.runtimeAgent !== run.effectiveRuntimeAgent) {
    return { artifacts: [], errorCode: "specialist_contract_unavailable" };
  }
  if (!agent.completionChecks.includes("requiredOutputsExist")) {
    // Answer-mode contract: the deliverable is the assistant reply itself, not
    // workspace files. The floor is proportional — required skills must have
    // actually been loaded, and any explicit citation URL in the reply prose
    // must be one a reader can open (no credentials, nothing internal to this
    // deployment). A direct answer with zero citations is legitimate and
    // passes. A missing skill load is a process gap, not an integrity
    // violation: deliver the reply marked "unverified" instead of discarding a
    // sound answer.
    if (agent.completionChecks.includes("skillsLoaded")) {
      const loadedSkills = await loadedOrInjectedSkills(project, assistantMessages, run);
      const requiredSkills = [...(agent.companionSkills ?? []), agent.skill];
      if (requiredSkills.some((skill) => !loadedSkills.has(skill))) {
        // Said in the product's language, because this sentence is shown to
        // the researcher on the run ledger and in their inbox — it was
        // English, and it was the first thing a first-time user read about
        // their own first answer (2026-09-15 walk, B8).
        const sentence = `本轮没有加载「${agent.skill}」方法，回答按未经人设校验交付。内容本身未被判定有误，可直接阅读；如需严格校验，重新提问即可。`;
        return {
          artifacts: [],
          errorCode: "specialist_required_skill_missing",
          qualityDegradable: true,
          // The managed-persona check did not run, which is what "unverified"
          // literally means. Unlike a bookkeeping gap between the report and
          // its apparatus, a reader cannot see that it was skipped.
          qualityUnverified: true,
          qualityIssues: [sentence],
          qualityFindings: [runNotice("specialist_required_skill_missing", sentence, { detail: sentence })],
        };
      }
    }
    if (agent.completionChecks.includes("citationsResolvable")) {
      const { blocking, advisory } = citationUrlDefects(assistantProse(assistantMessages));
      advisories.push(...advisory.map((text) => runNotice("citation_plain_http", text)));
      if (blocking.length > 0) {
        return {
          artifacts: [],
          errorCode: "specialist_citation_invalid",
          qualityDegradable: true,
          qualityUnverified: true,
          qualityIssues: blocking,
        };
      }
    }
    if (agent.completionChecks.includes("citationIntegrity")) {
      const issues = citationIntegrityIssues(assistantProse(assistantMessages));
      if (issues.length > 0) {
        return {
          artifacts: [],
          errorCode: "specialist_citation_integrity_failed",
          qualityDegradable: true,
          qualityUnverified: true,
          qualityIssues: issues,
        };
      }
    }
    return { artifacts: [], errorCode: null };
  }
  let skillGap = "";
  if (agent.completionChecks.includes("skillsLoaded")) {
    const loadedSkills = await loadedOrInjectedSkills(project, assistantMessages, run);
    const requiredSkills = [...(agent.companionSkills ?? []), agent.skill];
    const missing = requiredSkills.filter((skill) => !loadedSkills.has(skill));
    if (missing.length > 0) {
      // Name what was missing and the route that supplies it. A capability's
      // method bodies travel inside the delegated child's prompt; the root
      // session cannot fetch them with the `skill` tool, so a run that did the
      // work itself instead of delegating ends here after producing every
      // file — a verdict that, without this line, reads as a mystery.
      //
      // Held until the outputs have been read (2026-09-17). A process gap, as
      // on the answer line: a run that wrote its files is delivered with this
      // said and the mark on it; one that wrote nothing has nothing to deliver
      // and fails with this as the reason.
      skillGap = `The run finished without the ${missing.join(", ")} method(s) in front of the model. `
        + `Delegating the deliverable to the ${agent.id} capability with evimed_delegate injects every method its manifest lists; `
        + "the skill tool cannot load a capability method into the root session.";
    }
  }
  const required = agent.outputs.filter((output) => output.required).map((output) => output.path);
  // Declared and not demanded: read when the run wrote them, so the checks
  // below see the file that exists rather than an absence, and never a reason
  // to send a run back.
  const optional = new Set(agent.outputs.filter((output) => !output.required).map((output) => output.path));
  const artifacts = [];
  const files = new Map();
  for (const relative of [...required, ...optional]) {
    let file = null;
    let artifactPath = relative;
    let outsideNativeTurn = false;
    if (run.nativeTurn) {
      // The same workspace holds every turn's files. Apply the existing
      // freshness rule to the log's actual interval, not the later sweep time;
      // a root file from yesterday must not hide today's nested deliverable.
      const candidates = [relative, ...await deliverableCandidatePaths(project, relative)];
      for (const candidate of candidates) {
        const found = await openWorkspaceText(project, candidate);
        if (found && found.stat.mtimeMs >= Date.parse(run.startedAt)
          && (run.nativeTurn.endTime == null || found.stat.mtimeMs <= run.nativeTurn.endTime + 1)) {
          file = found;
          artifactPath = candidate;
          break;
        }
        if (found) outsideNativeTurn = true;
      }
    } else {
      file = await readRequiredFile(project, relative, Date.parse(run.startedAt));
      if (file) artifactPath = file.relativePath;
    }
    if (optional.has(relative) && (!file || file.stat.mtimeMs + 1_000 < Date.parse(run.startedAt))) continue;
    if (!file && skillGap && artifacts.length === 0) {
      return { artifacts: [], errorCode: "specialist_required_skill_missing", qualityIssues: [skillGap] };
    }
    if (!file) {
      if (outsideNativeTurn) return { artifacts, errorCode: "specialist_required_output_stale", qualityIssues: [
        `${relative} exists outside this native turn's log interval, so it cannot be delivered as this turn's output.`,
      ] };
      return {
        artifacts,
        errorCode: "specialist_required_output_missing",
        // One absent file, whatever else the package would have been judged on:
        // no content rule below has run yet.
        qualityStructural: true,
        // With the capability's first output absent there is nothing to hand
        // over. With it present, what exists is delivered and marked: the
        // reader gets the report and is told which companion file is missing.
        ...(relative !== required[0] && artifacts.length > 0 ? { qualityDegradable: true, qualityUnverified: true } : {}),
        qualityIssues: [
          `The required deliverable ${relative} is not in the workspace. Write it at exactly that name, either at the workspace root or inside this deliverable\u0027s ${workspaceLayout.deliverablesDir}/<id>/ directory, before finishing.`,
        ],
      };
    }
    if (file.stat.mtimeMs + 1_000 < Date.parse(run.startedAt)) {
      return {
        artifacts,
        errorCode: "specialist_required_output_stale",
        qualityIssues: [
          `${relative} predates this run, so it is a previous run's file rather than this one's output. Regenerate it from this run's own work.`,
        ],
      };
    }
    files.set(relative, file.text);
    artifacts.push(artifactPath);
  }
  if (skillGap) {
    return { artifacts, errorCode: "specialist_required_skill_missing", qualityDegradable: true, qualityUnverified: true, qualityIssues: [skillGap] };
  }
  if (agent.completionChecks.includes("citationsResolvable")) {
    const markdown = [...files].filter(([relative]) => relative.endsWith(".md")).map(([, text]) => text);
    const defects = markdown.map((text) => citationUrlDefects(text));
    advisories.push(...defects.flatMap((defect) => defect.advisory).map((text) => runNotice("citation_plain_http", text)));
    const blocking = defects.flatMap((defect) => defect.blocking);
    if (blocking.length > 0) {
      // Naming the URL, as every other gate message here does. This returned a
      // bare error code, so a run died with nothing to act on and the reason
      // had to be recovered by replaying the predicate over the transcript.
      return { artifacts, errorCode: "specialist_citation_invalid", qualityDegradable: true, qualityUnverified: true, qualityIssues: blocking };
    }
  }
  if (agent.completionChecks.includes("citationIntegrity")) {
    const markdown = [...files].filter(([relative]) => relative.endsWith(".md")).map(([, text]) => text);
    const issues = markdown.flatMap((text) => citationIntegrityIssues(text));
    if (issues.length > 0) {
      return {
        artifacts,
        errorCode: "specialist_citation_integrity_failed",
        qualityDegradable: true,
        qualityUnverified: true,
        qualityIssues: issues,
      };
    }
  }
  // Generalized "sources recorded" check (the reusable part of clinical
  // traceability) for agents that freeze a retrieval snapshot: every URL the
  // report cites must appear in evidence-snapshot.json, so a report cannot cite
  // a source that was never recorded in the frozen evidence set.
  if (agent.completionChecks.includes("citedSourcesRecorded")) {
    const snapshotEntry = [...files].find(([relative]) => relative.endsWith("evidence-snapshot.json"));
    if (!snapshotEntry) {
      return {
        artifacts,
        errorCode: "specialist_evidence_snapshot_missing",
        qualityStructural: true,
        qualityDegradable: true,
        qualityUnverified: true,
        qualityIssues: [
          "This package must include evidence-snapshot.json — the frozen record of every source the report cites. Write it before finishing.",
        ],
      };
    }
    let snapshot;
    try {
      snapshot = JSON.parse(snapshotEntry[1]);
    } catch {
      return {
        artifacts,
        errorCode: "specialist_evidence_snapshot_invalid",
        qualityStructural: true,
        qualityDegradable: true,
        qualityUnverified: true,
        qualityIssues: ["evidence-snapshot.json must contain strict valid JSON; escape quotation marks correctly inside string values."],
      };
    }
    if (!snapshot || typeof snapshot !== "object") {
      return {
        artifacts,
        errorCode: "specialist_evidence_snapshot_invalid",
        qualityStructural: true,
        qualityDegradable: true,
        qualityUnverified: true,
        qualityIssues: ["evidence-snapshot.json must be a JSON object or array of source records, not a bare string or number."],
      };
    }
    const recordedUrls = new Set(citedHttpUrls(snapshotEntry[1]));
    if (!recordedUrls.size) {
      return {
        artifacts,
        errorCode: "specialist_evidence_snapshot_empty",
        qualityDegradable: true,
        qualityUnverified: true,
        qualityIssues: [
          "evidence-snapshot.json records no source URL at all. Every source the report cites must appear there with the address it was retrieved from.",
        ],
      };
    }
    const citedUrls = [...files]
      .filter(([relative]) => relative.endsWith(".md"))
      .flatMap(([, text]) => citedHttpUrls(text));
    const unrecorded = [...new Set(citedUrls.filter((url) => !recordedUrls.has(url)))];
    if (unrecorded.length > 0) {
      // Naming them. Told only that some citation was unrecorded, a run has no
      // way to find which of forty it is, and the repair loop has nothing to
      // hand back.
      return {
        artifacts,
        errorCode: "specialist_cited_source_unrecorded",
        qualityDegradable: true,
        qualityUnverified: true,
        qualityIssues: unrecorded.slice(0, 12).map((url) =>
          `The report cites ${url}, which is absent from evidence-snapshot.json. Record the source there as retrieved, or drop the claim that rests on it.`),
      };
    }
  }
  if (agent.completionChecks.includes("evidenceClaimsTraceable")) {
    // A delegated read is where verbatim quotation dies. Search results too
    // large for the conversation are written to a tool-output file, and handing
    // that file to a subagent returns prose about the records instead of the
    // records: abstracts paraphrased, identifiers dropped. Quotes taken from
    // that reply cannot be found in the source, which the matrix check below
    // eventually catches — but only as "this quote does not match", long after
    // the cause. Name the cause instead.
    //
    // It names the cause, so it is carried into the verdict rather than
    // returned as one. Delegation is what makes quotations go wrong; it is not
    // itself a wrong quotation. When the matrix checks below find nothing —
    // every quote matched its preserved source — the package is traceable on
    // the evidence, and withholding it over how the agent got there delivers
    // nothing for a defect that did not occur. When they do find something,
    // this notice leads and explains it.
    const delegatedReads = delegatedDocumentReads(assistantMessages);
    const delegationNotice = delegatedReads.length > 0
      ? `Reading retrieved evidence was delegated to a subagent ${delegatedReads.length} time(s); a subagent replies in prose, so quotations taken from it are not the source's wording. Read tool-output files with the read tool. Delegate a question, never a document.`
      : null;
    let matrix;
    try {
      matrix = JSON.parse(files.get("clinical-evidence-matrix.json") ?? "");
    } catch {
      return {
        artifacts,
        errorCode: "specialist_evidence_traceability_failed",
        // The 2026-08-26 shape: the matrix would not parse, so every claim in
        // it was unreadable and the package came back as a wall of content
        // findings that were all one syntax error.
        qualityStructural: true,
        // The report is on disk and is delivered; without a readable matrix
        // none of its claims could be checked, and the mark says so.
        qualityDegradable: true,
        qualityUnverified: true,
        qualityIssues: [
          "clinical-evidence-matrix.json must contain strict valid JSON; escape quotation marks correctly inside string values.",
        ],
      };
    }
    const sourceArtifacts = new Map();
    const sourceTypes = new Map();
    // Which preserved sources to read: the ones the claims name, and nothing
    // else. It used to be a list in the run's own receipt, which failed a run
    // whole over one omitted field and let a path no claim cited decide the
    // verdict; the receipt is gone. A path with no provenance, or no file, is
    // named and the rest are still read — a claim resting on a source that
    // could not be read is reported by the validator as one this run did not
    // preserve, never as a misquotation.
    const namedPaths = [
      ...(Array.isArray(matrix?.claims) ? matrix.claims : []).flatMap((/** @type {any} */ claim) => [
        claim?.artifactPath,
        ...(Array.isArray(claim?.supportingSources) ? claim.supportingSources.map((/** @type {any} */ source) => source?.artifactPath) : []),
      ]),
    ].filter((value) => typeof value === "string" && value.trim());
    const sourcePaths = [...new Set(namedPaths)];
    /** @type {string[]} */
    const sourceGaps = [];
    /** The same gaps with their cause and file, for the record. @type {StoredNotice[]} */
    const sourceGapFindings = [];
    /** @param {string} text @param {string} code @param {string} [file] */
    const gap = (text, code, file) => {
      sourceGaps.push(text);
      sourceGapFindings.push(runNotice(code, text, { severity: "must-fix", ...(file ? { file } : {}) }));
    };
    let provenanceGap = false;
    if (sourcePaths.length > 48) {
      gap(`The package names ${sourcePaths.length} source artifacts; the first 48 were read. Cite one canonical path per distinct document rather than every companion file.`, "specialist_evidence_traceability_failed");
    }
    for (const rawPath of sourcePaths.slice(0, 48)) {
      let relative;
      try {
        relative = normalizeWorkspaceRelativePath(rawPath, "source artifact path");
      } catch {
        gap(`${JSON.stringify(rawPath)} is named as a source artifact and is not a safe workspace path, so it was not read.`, "specialist_evidence_traceability_failed");
        continue;
      }
      if (relative !== rawPath || !relative.startsWith(".evimed-sources/")) {
        gap(`${JSON.stringify(rawPath)} is named as a source artifact; it must be the exact .evimed-sources/... path a preserving tool returned, copied rather than typed. It was not read.`, "specialist_evidence_traceability_failed");
        continue;
      }
      const expectedDigest = sourceArtifactProvenance.get(relative);
      if (!expectedDigest) {
        // The package names a file no preserving tool reported writing in this
        // run — a path typed from memory, a leftover from an earlier run, or a
        // file the run created itself.
        provenanceGap = true;
        gap(`The evidence matrix cites ${relative}, but no evidence tool reported preserving that file during this run. Cite only the exact .evimed-sources/... paths the preserving tools returned in this run, copied from their output rather than typed.`, "specialist_evidence_provenance_failed", relative);
        continue;
      }
      const sourceFile = await readRequiredFile(project, relative);
      if (!sourceFile) {
        gap(`The source artifact ${relative} named by the package does not exist in the workspace.`, "specialist_evidence_traceability_failed", relative);
        continue;
      }
      // The current run's preserving-tool receipt binds these bytes. Immutable
      // captures retain their first publication mtime when retrieved again;
      // that filesystem timestamp is not the time of this run's retrieval.
      //
      // The one source finding that still withholds the package: the bytes a
      // tool preserved were changed afterwards, so nothing quoted from them can
      // be trusted and a reader has no way to see it.
      if (createHash("sha256").update(sourceFile.text, "utf8").digest("hex") !== expectedDigest) {
        return {
          artifacts,
          errorCode: "specialist_evidence_integrity_failed",
          qualityIssues: [
            `${relative} no longer matches what the preserving tool wrote, so quotations taken from it are not the source's wording. Do not edit, truncate or reformat preserved sources; retrieve the document again if it must be refreshed.`,
          ],
        };
      }
      sourceArtifacts.set(relative, sourceFile.text);
      // The design a GRADE upgrade depends on: the same `source.json` the run
      // side and the reader's claim_verification read, so all three agree.
      const sidecar = sourceTypeSidecarPath(relative);
      const stamped = sidecar ? sourceTypeOfSidecar((await openWorkspaceText(project, sidecar))?.text) : null;
      if (stamped) sourceTypes.set(relative, stamped);
    }
    const validation = validateClinicalEvidencePackage({
      reportText: files.get("clinical-evidence-report.md") ?? "",
      matrix,
      sourceArtifacts,
      sourceTypes,
      briefText,
    });
    // A well-established risk of the scene the report discusses that it never
    // mentions (clinical-safety-rules.json `cautionRules`): shown to the reader
    // as a SAFETY notice, never a reason to withhold the package — owner
    // decision 5 (2026-09-18). The run was advised of the same caution while it
    // could still add the sentence.
    for (const hit of clinicalSafetyCautionHits({ reportText: files.get("clinical-evidence-report.md") ?? "", question: briefText ?? undefined })) {
      advisories.push(clinicalSafetyCautionNotice(hit));
    }
    // A rule that did not run is said, not implied. The question-scoped safety
    // rule reads the brief as the dispatcher kept it; a run whose kept copy is
    // missing (dispatched before briefs were kept beside the ledger, or the
    // copy unreadable) is judged without it — and a package judged without a
    // rule must not read like one that passed it.
    if (briefText == null) {
      const sentence = "本次交付没有按原始题面核对「报告是否引入了题面没有提到的药品」：服务端没有找到这次运行保存的题面"
        + "（运行早于题面单独保存，或保存的那份无法读取）。其余检查照常完成。";
      advisories.push(runNotice("run_brief_lost", sentence, { detail: sentence }));
      skippedChecks.push("question-scoped-safety-rules");
    }
    // Which defect leads when a source named by the package had no tool
    // vouching for it: the same code that case has always carried.
    const provenanceVerdict = provenanceGap ? { errorCode: "specialist_evidence_provenance_failed" } : null;
    if (sourceGaps.length > 0 && validation.valid) {
      // Every claim that could be checked held, and some source named by the
      // package could not be read: delivered, and said.
      return {
        artifacts,
        errorCode: "specialist_evidence_traceability_failed",
        ...provenanceVerdict,
        qualityIssues: sourceGaps,
        qualityFindings: sourceGapFindings,
        qualityDegradable: true,
        qualityUnverified: true,
      };
    }
    if (!validation.valid) {
      // The analysis is on disk and every required deliverable exists. Ending
      // here as a bare failure threw all of it away and returned an error code:
      // across seven production runs the report was written every time and
      // delivered none of them. A reader given the analysis and told which
      // three quotations could not be matched to their sources is better served
      // than one given nothing, and the checks are worth more as a statement
      // attached to the work than as a reason to withhold it.
      //
      // Blocking issues lead, because they are the ones a reader cannot see for
      // themselves: a quotation absent from the source it names, or a clinical
      // framing that is unsafe. They are not hidden — they are the headline.
      const blocking = [...validation.blockingIssues];
      const rest = validation.issues.filter((issue) => !blocking.includes(issue));
      // Which check raised each finding, read off the validator's own record
      // (`issueChecks`, same texts, same order) rather than recovered from the
      // sentence. `clinical_evidence_issue` / `_notice` are the codes the
      // run-side gate gives the same findings.
      const checkOf = new Map((validation.issueChecks ?? []).map((/** @type {{ check: string | null, text: string }} */ entry) => [entry.text, entry.check]));
      /** @param {string} issue @param {'safety'|'must-fix'|'advice'} severity @param {string} text */
      const finding = (issue, severity, text) => runNotice(severity === "advice" ? "clinical_evidence_notice" : "clinical_evidence_issue", text, {
        severity,
        ...(checkOf.get(issue) ? { check: String(checkOf.get(issue)) } : {}),
      });
      return {
        artifacts,
        // Which defect this is, so the repair loop hands the run the named
        // numbers instead of one code that means "something in the package".
        // Every code the gate can name is repairable: the package is complete
        // and the issue is actionable inside it.
        errorCode: clinicalEvidencePackageErrorCode(blocking),
        ...provenanceVerdict,
        qualityIssues: [
          // What a reader is shown first: clinical framing that could hurt
          // somebody, then what they cannot see for themselves.
          ...validation.safetyIssues.map((/** @type {string} */ issue) => `SAFETY — ${issue}`),
          ...(delegationNotice ? [`MUST FIX — ${delegationNotice}`] : []),
          ...sourceGaps.map((issue) => `MUST FIX — ${issue}`),
          ...blocking.filter((/** @type {string} */ issue) => !validation.safetyIssues.includes(issue)).map((/** @type {string} */ issue) => `MUST FIX — ${issue}`),
          ...rest,
        ],
        qualityFindings: [
          ...validation.safetyIssues.map((/** @type {string} */ issue) => finding(issue, "safety", `SAFETY — ${issue}`)),
          ...(delegationNotice ? [runNotice("specialist_delegated_evidence_read", `MUST FIX — ${delegationNotice}`, { severity: "must-fix" })] : []),
          ...sourceGapFindings,
          ...blocking.filter((/** @type {string} */ issue) => !validation.safetyIssues.includes(issue)).map((/** @type {string} */ issue) => finding(issue, "must-fix", `MUST FIX — ${issue}`)),
          ...rest.map((/** @type {string} */ issue) => finding(issue, "advice", issue)),
        ],
        qualityDegradable: true,
        // "Unverified" is a statement about the evidence, so only a finding
        // about the evidence earns it. It used to fire on any remaining issue,
        // so a package whose only two notices were a gate bug of ours carried
        // the same mark as one with a quotation absent from its source — and a
        // mark that means everything means nothing. Bookkeeping still ships
        // attached to the run; it just no longer stamps it.
        qualityUnverified: blocking.length > 0 || sourceGaps.length > 0 || Boolean(delegationNotice),
      };
    }
    if (delegationNotice) {
      return {
        artifacts,
        errorCode: "specialist_delegated_evidence_read",
        qualityIssues: [delegationNotice],
        qualityDegradable: true,
        qualityUnverified: true,
      };
    }
  }
  return { artifacts, errorCode: null };
}

/**
 * The run's own projection of itself, read from the workspace.
 *
 * Hidden knowledge: what the control plane may and may not learn about a run in
 * flight, and why this file rather than the kernel's storage. DSH's storage
 * format carries no compatibility promise — rc.8 changed it with no migration —
 * so the socket projects its durable tables into `.evimed-run/state.json`
 * and that is what is read here for progress. It is scoped against observed
 * workflow receipts and is never used as final source-SHA authority; that
 * authority comes from authenticated kernel histories.
 *
 * Three outcomes, deliberately, because collapsing them is the bug this whole
 * area keeps producing:
 *
 * - `missing` — a run that writes no projection is normal. An answer-mode run
 *   has no plan, no evidence table and no deliverables, so there is nothing to
 *   project. This must never read as "not progressing".
 * - `unreadable` — the file is there and does not parse. That is a named
 *   failure worth surfacing (§14 rule 18), and it is emphatically not evidence
 *   of a stall: treating it as one would mean the fix for stall misjudgement
 *   introduced a fresh source of it.
 * - `read` — the projection, with the counters that move.
 *
 * @param {Record<string, any>} project @param {string} workspaceRoot
 * @returns {Promise<{ state: 'missing'|'unreadable'|'read', projection?: Record<string, any> }>}
 */
/**
 * The delivery receipt, or null when the run left none.
 *
 * Read from the project's own workspace on the host — not from the container
 * path the runtime reports. Those are two different meanings of "the
 * workspace": one is where a tool's own paths are relative to, the other is a
 * directory this process can open, and using the first for the second is how
 * the run-state projection came to read `/workspace` on a host that has no
 * such directory.
 *
 * @param {Record<string, any>} project
 * @returns {Promise<import('@evimed/domain').DeliveryReceipt|null>}
 */
async function readDeliveryReceipt(project, run = null) {
  let text;
  try {
    text = await readTextFileNoFollow(project.workspaceDir, path.join(project.workspaceDir, workspaceLayout.receiptFile), "");
  } catch {
    return null;
  }
  if (!text) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  // Validated, not trusted: the receipt is written inside the sandbox, and a
  // malformed one must read as "no receipt" rather than as an accepted run.
  const validated = validateDeliveryReceipt(parsed);
  if (!validated.ok) return null;
  // Another run's receipt is no receipt. Only native turns were ever checked
  // against their run; every other run trusted the workspace's one receipt file
  // whole, and that file is shared by every run of the project — so a run could
  // be credited, or snapshotted, with a package a previous run had delivered.
  // A dispatched run's receipt carries the control plane's own run id, which is
  // what this compares.
  if (run && !run.nativeTurn && run.id && validated.receipt.runId !== run.id) return null;
  const receipt = run?.nativeTurn ? scopeNativeReceipt(validated.receipt, run) : validated.receipt;
  return receipt ? (await verifiedReceiptArtifacts(project, receipt)).receipt : null;
}

/**
 * The receipt's files, confirmed present and unchanged since they were graded.
 * @param {Record<string, any>} project
 * @param {import('@evimed/domain').DeliveryReceipt} receipt
 * @returns {Promise<{ artifacts: string[], mismatched: string[], receipt: import('@evimed/domain').DeliveryReceipt }>}
 */
async function verifiedReceiptArtifacts(project, receipt) {
  /** @type {string[]} */
  const artifacts = [];
  /** @type {string[]} */
  const mismatched = [];
  const entries = [];
  for (const entry of receipt.entries ?? []) {
    const files = [];
    for (const file of entry.files ?? []) {
      let resolved = String(file.path ?? "");
      let matched = false;
      try {
        const relative = normalizeWorkspaceRelativePath(resolved, "receipt artifact path");
        const id = String(entry.deliverableId ?? "");
        if (!id || id === "." || id === ".." || /[/\\]/.test(id)) throw new Error("Invalid deliverable identity.");
        const prefix = `${workspaceLayout.deliverablesDir}/${id}/`;
        if (relative.startsWith(`${workspaceLayout.deliverablesDir}/`) && !relative.startsWith(prefix)) throw new Error("Receipt crosses deliverable identity.");
        const candidates = [relative];
        // Version-one writers hashed logical names but wrote the files under
        // this one declared deliverable. Never search other deliverables.
        if (receipt.formatVersion <= 1 && !relative.startsWith(`${workspaceLayout.deliverablesDir}/`)) {
          candidates.push(normalizeWorkspaceRelativePath(`${prefix}${relative}`, "legacy receipt artifact path"));
        }
        for (const candidate of candidates) {
          let opened;
          try {
            opened = await openScopedFileNoFollow(project.workspaceDir, path.join(project.workspaceDir, candidate));
            if (!opened.stat.isFile()) continue;
            const digest = createHash("sha256").update(await opened.handle.readFile()).digest("hex");
            if (digest === String(file.sha256 ?? "")) {
              resolved = candidate;
              matched = true;
              artifacts.push(candidate);
              break;
            }
          } catch { /* only these two explicitly scoped locations are candidates */ }
          finally { await opened?.handle.close().catch(() => {}); }
        }
      } catch { /* malformed and cross-deliverable paths never resolve */ }
      if (!matched) mismatched.push(resolved);
      files.push({ ...file, path: resolved });
    }
    entries.push({ ...entry, files });
  }
  return { artifacts: [...new Set(artifacts)].slice(0, maxArtifacts).sort(), mismatched: [...new Set(mismatched)], receipt: { ...receipt, entries } };
}

/** The file name a repair grant for one accepted receipt entry is kept under.
 *  The same three values `consumeRepairAuthorization` is handed by the run.
 *  @param {string} runId @param {Record<string, any>} entry */
function repairGrantKey(runId, entry) {
  const acceptedDigest = createHash("sha256").update(JSON.stringify(entry)).digest("hex");
  return createHash("sha256").update(JSON.stringify([runId, entry.deliverableId, acceptedDigest])).digest("hex");
}

/**
 * Whether a receipt's drift is a revision the control plane authorized.
 *
 * A repair round mints a one-time grant per accepted clinical report. The run
 * consumes it to reopen the frozen deliverable, and from then until a
 * resubmission is accepted its files differ from the receipt, which still
 * names the accepted bytes — preserved outside the workspace when the grant
 * was minted. That drift is the revision, not tampering. `revising` holds the
 * deliverables whose grant was consumed; `explained` says every mismatched file
 * belongs to one of them.
 * @param {Record<string, any>} project
 * @param {{ mismatched: string[], receipt: Record<string, any> }} verified
 * @returns {Promise<{ revising: Set<string>, explained: boolean }>}
 */
async function revisionDrift(project, verified) {
  const revising = new Set();
  for (const entry of verified.receipt.entries ?? []) {
    if (entry.contractKind !== "clinical-evidence-report") continue;
    const claim = path.join(project.metaDir, "repair-authorizations", `${repairGrantKey(verified.receipt.runId, entry)}.claimed.json`);
    if (await readTextFileNoFollow(project.rootDir, claim, "").catch(() => "")) revising.add(String(entry.deliverableId));
  }
  const explained = verified.mismatched.length > 0 && verified.mismatched.every((filePath) => (verified.receipt.entries ?? []).some((entry) => (
    revising.has(String(entry.deliverableId)) && (entry.files ?? []).some((/** @type {any} */ file) => file.path === filePath)
  )));
  return { revising, explained };
}

/** What the ledger says about an authorized revision that did not pass.
 *  @param {{ mismatched: string[], receipt: Record<string, any> }} verified @param {Set<string>} revising
 *  @returns {StoredNotice} */
function revisionNotAcceptedNotice(verified, revising) {
  const sentence = `交付物「${[...revising].join("、")}」按服务端门禁的要求开启了修订，改动了 ${verified.mismatched.length} 个文件，修订版没有通过门禁，所以没有新的回执；被接受时的版本另存在控制面。`;
  return runNotice("run_revision_not_accepted", sentence, { detail: sentence });
}

/**
 * The run's own admissions from its projection: `degraded` lines say part of
 * its bookkeeping could not be kept, `qualityNotices` lines are its own notes.
 * Both are the socket's technical English, kept as `text` only.
 * @param {Record<string, any>} projection @returns {StoredNotice[]}
 */
function runSideNotices(projection) {
  // A native run's scoped projection carries the parent's own gate findings,
  // already structured (`scopeNativeProjection`); the socket's own lines are
  // plain strings.
  /** @param {unknown} value @param {(line: string) => StoredNotice} named @returns {StoredNotice[]} */
  const entries = (value, named) => (Array.isArray(value) ? value : []).flatMap((item) => (
    typeof item === "string" ? (item ? [named(item)] : []) : normalizeQualityNotices([item])));
  return [
    // Each degraded line by the template it was written with, so a reader
    // sees what went missing rather than 「另有技术提示」.
    ...entries(projection?.degraded, runSideDegradedNotice),
    ...entries(projection?.qualityNotices, (line) => runNotice("run_side_notice", line)),
  ];
}

/** The kernel could not tie this run's work state to this request. @returns {StoredNotice} */
function unattributedNotice() {
  const sentence = "内核没有把这次运行的工作状态对应到本次请求，因此无法确认交付是否通过验收。";
  return runNotice("run_unattributed", sentence, { detail: sentence });
}

/**
 * The run-side gate's advisory findings on an accepted package, with their
 * identity back.
 *
 * The receipt keeps each finding's message only. The gate run that accepted
 * the package keeps the whole finding in the run's projection, so a note whose
 * text is exactly one of those findings' messages takes that finding's code,
 * check and position — a lookup by the finding's own text, never a reading of
 * it. A note no gate run carries is advice under `gate_advisory`.
 * @param {readonly any[]} entries receipt entries
 * @param {Record<string, any> | null} projection
 * @returns {StoredNotice[]}
 */
function receiptNotices(entries, projection) {
  /** @type {Map<string, Record<string, any>>} */
  const known = new Map();
  for (const gate of Array.isArray(projection?.gateRuns) ? projection.gateRuns : []) {
    for (const issue of Array.isArray(gate?.issues) ? gate.issues : []) {
      if (issue && typeof issue.message === "string" && !known.has(issue.message)) known.set(issue.message, issue);
    }
  }
  return (entries ?? []).flatMap((entry) => (Array.isArray(entry?.notices) ? entry.notices : []))
    .filter((line) => typeof line === "string" && line)
    .map((line) => {
      const issue = known.get(line);
      if (!issue) return runNotice("gate_advisory", line);
      return runNotice(noticeCodePattern.test(String(issue.code ?? "")) ? String(issue.code) : "gate_advisory", line, {
        severity: gateIssueSeverity(issue),
        ...(typeof issue.check === "string" && issue.check ? { check: issue.check } : {}),
        ...(typeof issue.path === "string" && issue.path ? { file: issue.path } : {}),
        ...(Number.isSafeInteger(issue.line) && issue.line > 0 ? { line: issue.line } : {}),
      });
    });
}

/**
 * Preserve locally accepted bytes in control-plane-only project metadata before
 * repair, and mint the grant that lets the run reopen a frozen deliverable.
 *
 * Called once per repair round. From the second round on, a deliverable's
 * revision may already be open: the earlier grant was consumed, the files
 * changed, and the resubmission was not accepted. That round needs no second
 * grant — the run-side item is no longer frozen — and the drift is not a
 * reason to refuse the repair. Refusing it ("accepted receipt drifted before
 * repair") ended a v8 ablation cell after one round as
 * `specialist_receipt_digest_mismatch` with no files (2026-09-16). Drift in a
 * deliverable nobody authorized is still refused.
 */
async function snapshotAcceptedPackageForRepair(project, run, runtimeGeneration = null) {
  const receipt = await readDeliveryReceipt(project, run);
  if (!receipt) return { revisionRequired: false, snapshotPath: null };
  if (typeof runtimeGeneration !== "string" || !runtimeGeneration || runtimeGeneration.length > 256) {
    throw new Error("active runtime generation is unavailable for repair authorization");
  }
  const verified = await verifiedReceiptArtifacts(project, receipt);
  const { revising, explained } = await revisionDrift(project, verified);
  if (verified.mismatched.length > 0 && !explained) {
    throw new Error(`accepted receipt drifted before repair: ${verified.mismatched.slice(0, 6).join(", ")}`);
  }
  const acceptedDigest = createHash("sha256").update(JSON.stringify(verified.receipt)).digest("hex");
  const directory = path.join(project.metaDir, "repair-revisions");
  const snapshotPath = path.join(directory, `${safeId(run.id, "run id")}-${acceptedDigest}.json`);
  // Kept when it exists: an earlier round took it before any revision changed
  // the files, and what is on disk now is less than it holds.
  if (!(await readTextFileNoFollow(project.rootDir, snapshotPath, "").catch(() => ""))) {
    const metadata = new Map(verified.receipt.entries.flatMap((entry) => entry.files.map((file) => [file.path, file])));
    const files = [];
    for (const relative of verified.artifacts) {
      const value = await readRequiredFile(project, relative);
      const recorded = metadata.get(relative);
      if (!value || !recorded) throw new Error(`accepted repair source disappeared: ${relative}`);
      const digest = createHash("sha256").update(value.text, "utf8").digest("hex");
      if (digest !== recorded.sha256 || Buffer.byteLength(value.text) !== recorded.bytes) {
        throw new Error(`accepted repair source changed during snapshot: ${relative}`);
      }
      files.push({ path: relative, sha256: digest, bytes: recorded.bytes, text: value.text });
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFileAtomicNoFollow(project.rootDir, snapshotPath, `${JSON.stringify({
      formatVersion: 1,
      controlPlaneRunId: run.id,
      acceptedDigest,
      acceptedReceipt: verified.receipt,
      files,
      preservedAt: new Date().toISOString(),
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
  const authorizationDirectory = path.join(project.metaDir, "repair-authorizations");
  await mkdir(authorizationDirectory, { recursive: true, mode: 0o700 });
  const authorizations = [];
  for (const entry of verified.receipt.entries.filter((candidate) => candidate.contractKind === "clinical-evidence-report")) {
    if (revising.has(String(entry.deliverableId))) continue;
    const authorization = {
      formatVersion: 1,
      controlPlaneRunId: run.id,
      runtimeGeneration,
      runId: verified.receipt.runId,
      deliverableId: entry.deliverableId,
      acceptedDigest: createHash("sha256").update(JSON.stringify(entry)).digest("hex"),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      consumedAt: null,
    };
    const key = repairGrantKey(verified.receipt.runId, entry);
    const target = path.join(authorizationDirectory, `${key}.json`);
    const claim = path.join(authorizationDirectory, `${key}.claimed.json`);
    await withProjectStorageMutation(project, async () => {
      if (await readTextFileNoFollow(project.rootDir, claim, "").catch(() => "")) {
        throw new Error("repair authorization for these accepted bytes was already consumed");
      }
      const existing = await readTextFileNoFollow(project.rootDir, target, "").catch(() => "");
      if (existing) {
        let current;
        try { current = JSON.parse(existing); } catch { throw new Error("existing repair authorization is unreadable"); }
        if (
          current?.runId !== authorization.runId
          || current?.deliverableId !== authorization.deliverableId
          || current?.acceptedDigest !== authorization.acceptedDigest
        ) throw new Error("existing repair authorization conflicts with current accepted bytes");
        if (current.consumedAt !== null) throw new Error("repair authorization for these accepted bytes was already consumed");
        // Still usable: the same runtime can consume it inside its window.
        // One minted for a runtime that has since been replaced, or one left
        // unused past its window, can never be consumed, and refusing to
        // replace it left every later round without a grant.
        if (current.runtimeGeneration === runtimeGeneration
          && Number.isFinite(Date.parse(current.expiresAt)) && Date.parse(current.expiresAt) > Date.now()) return;
      }
      await writeFileAtomicNoFollow(project.rootDir, target, `${JSON.stringify(authorization, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    });
    authorizations.push({
      runId: authorization.runId,
      deliverableId: authorization.deliverableId,
      acceptedDigest: authorization.acceptedDigest,
    });
  }
  return { revisionRequired: authorizations.length > 0, snapshotPath, authorizations };
}

/** Consume one repair authorization whose accepted bytes already have a private snapshot.
 * @param {Record<string, any>} project @param {Record<string, any>} input
 * @param {{ runtimeGeneration?: string|null, controlRunRepairing?: (controlPlaneRunId: string) => Promise<boolean>, revalidateRuntimeGeneration?: () => Promise<string|null> }} [options] */
async function consumeRepairAuthorization(project, input, {
  runtimeGeneration = null,
  controlRunRepairing = async () => false,
  revalidateRuntimeGeneration = async () => null,
} = {}) {
  const runId = typeof input?.runId === "string" ? input.runId : "";
  const deliverableId = typeof input?.deliverableId === "string" ? input.deliverableId : "";
  const acceptedDigest = typeof input?.acceptedDigest === "string" ? input.acceptedDigest : "";
  if (!runId || runId.length > 256 || !deliverableId || deliverableId.length > 128 || !/^[0-9a-f]{64}$/.test(acceptedDigest)) {
    return { authorized: false };
  }
  const key = createHash("sha256").update(JSON.stringify([runId, deliverableId, acceptedDigest])).digest("hex");
  const directory = path.join(project.metaDir, "repair-authorizations");
  const target = path.join(directory, `${key}.json`);
  const claim = path.join(directory, `${key}.claimed.json`);
  return withProjectStorageMutation(project, async () => {
    const text = await readTextFileNoFollow(project.rootDir, target, "").catch(() => "");
    if (!text) return { authorized: false };
    let authorization;
    try { authorization = JSON.parse(text); } catch { return { authorized: false }; }
    if (
      authorization?.formatVersion !== 1
      || authorization.runId !== runId
      || authorization.deliverableId !== deliverableId
      || authorization.acceptedDigest !== acceptedDigest
      || authorization.runtimeGeneration !== runtimeGeneration
      || authorization.consumedAt !== null
      || !Number.isFinite(Date.parse(authorization.expiresAt))
      || Date.parse(authorization.expiresAt) <= Date.now()
    ) return { authorized: false };
    if (!(await controlRunRepairing(authorization.controlPlaneRunId))) return { authorized: false };
    if (await revalidateRuntimeGeneration() !== runtimeGeneration) return { authorized: false };
    try {
      await writeFileExclusiveNoFollow(project.rootDir, claim, `${JSON.stringify({
        formatVersion: 1,
        controlPlaneRunId: authorization.controlPlaneRunId,
        runtimeGeneration,
        runId,
        deliverableId,
        acceptedDigest,
        claimedAt: new Date().toISOString(),
      }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      if (error?.code === "EEXIST") return { authorized: false };
      throw error;
    }
    authorization.consumedAt = new Date().toISOString();
    await writeFileAtomicNoFollow(project.rootDir, target, `${JSON.stringify(authorization, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return { authorized: true };
  });
}

/**
 * Every file the run actually wrote under `deliverables/`, as artifact paths.
 *
 * Read from the workspace rather than from a receipt, because this is the
 * question a receipt cannot answer: a run that never submitted, or whose
 * submission the gate refused, has no receipt and still has files.
 *
 * Bounded by `maxArtifacts` and one directory deep on purpose. The ids come out
 * of directories the container created, so they are input — the same
 * single-segment rule `deliverableCandidatePaths` and `unsubmittedDeliverables`
 * apply, for the same reason: joined unchecked, `..` here names a path outside
 * the workspace.
 *
 * @param {Record<string, any>} project
 * @returns {Promise<string[]>}
 */
/**
 * @param {any} project
 * @param {number | null} [since] epoch ms the run started; a file last written
 *   before it is an earlier run's, in the same workspace
 */
async function writtenDeliverableFiles(project, since = null) {
  /** @type {string[]} */
  const found = [];
  /** @type {import('node:fs').Dirent[]} */
  let ids;
  try {
    ids = await readdir(path.join(project.workspaceDir, workspaceLayout.deliverablesDir), { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of ids) {
    if (found.length >= maxArtifacts) break;
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    if (!id || id.includes("/") || id.includes("\\") || id === "." || id === "..") continue;
    let files;
    try {
      files = await readdir(path.join(project.workspaceDir, workspaceLayout.deliverablesDir, id), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (found.length >= maxArtifacts) break;
      if (!file.isFile()) continue;
      if (since != null) {
        // The same second of slack the required-output freshness rule allows.
        const written = await stat(path.join(project.workspaceDir, workspaceLayout.deliverablesDir, id, file.name)).catch(() => null);
        if (!written || written.mtimeMs + 1_000 < since) continue;
      }
      found.push(`${workspaceLayout.deliverablesDir}/${id}/${file.name}`);
    }
  }
  return found;
}

/**
 * The sentence a recovered package carries, so "unverified" is a label on work
 * that exists rather than a synonym for nothing.
 */
const UNVERIFIED_DELIVERY_NOTICE = "这次运行没有通过交付前的质量门，因此下面的文件标记为「未经核验」——"
  + "它们是运行真实写出来的成果，没有被删除，可以直接查看和取用，只是还没有拿到质量门的通过判定。"
  + "上面的退回理由说明了差在哪里；按它修好后重新提交，同一份成果就会变成已核验。";


async function readRunStateProjection(project, workspaceRoot, run = null) {
  let text;
  try {
    const relative = run && !run.nativeTurn ? runStateFileFor(run.id) : workspaceLayout.runStateFile;
    text = await readTextFileNoFollow(workspaceRoot, path.join(workspaceRoot, relative), "");
    // Compatibility with a runtime image from before per-run projections. The
    // run-id check below still rejects another run's shared file.
    if (!text && run && !run.nativeTurn) {
      text = await readTextFileNoFollow(workspaceRoot, path.join(workspaceRoot, workspaceLayout.runStateFile), "");
    }
  } catch {
    // Unreadable for any reason the filesystem gives — including absent, which
    // `readTextFileNoFollow` reports as an empty string rather than a throw.
    return { state: "unreadable" };
  }
  if (!text) return { state: "missing" };
  try {
    const projection = JSON.parse(text);
    if (!projection || typeof projection !== "object" || Array.isArray(projection)) return { state: "unreadable" };
    if (!run?.nativeTurn) {
      if (run && projection.runId && projection.runId !== run.id) return { state: "unattributed" };
      return { state: "read", projection };
    }
    // Only read when the plan index claims an acceptance the parent cannot
    // have witnessed: the receipt check hashes every accepted file, and this
    // function runs on every monitor poll.
    // Once the run has ended, also for a delegated item: only the receipt can
    // say its child's submission was accepted.
    const claimsAcceptance = Array.isArray(projection.plan?.items)
      && (run.status === "running"
        ? projection.plan.items.some((/** @type {any} */ item) => item?.status === "accepted")
        : (run.nativeWorkflow?.delegates ?? []).length > 0);
    const receiptAccepted = claimsAcceptance ? await receiptAcceptedDeliverables(project, String(projection.runId ?? "")) : null;
    const scoped = scopeNativeProjection(projection, run, { receiptAccepted });
    return scoped ? { state: "read", projection: scoped } : { state: "unattributed" };
  } catch {
    return { state: "unreadable" };
  }
}

/**
 * The deliverables a delivery receipt accepts for one kernel run, counting
 * only entries whose every file still matches the digest it was accepted at.
 *
 * The receipt is written by the run-side gate alone and only on acceptance,
 * under a path the sandbox refuses the model's writes to, and each file it
 * names is re-hashed here — which is what lets a live native run show a
 * child's acceptance its parent never witnessed without taking the plan
 * index's word for it.
 * @param {Record<string, any>} project @param {string} kernelRunId
 * @returns {Promise<Set<string>>}
 */
async function receiptAcceptedDeliverables(project, kernelRunId) {
  /** @type {Set<string>} */
  const accepted = new Set();
  if (!kernelRunId) return accepted;
  let parsed;
  try {
    const text = await readTextFileNoFollow(project.workspaceDir, path.join(project.workspaceDir, workspaceLayout.receiptFile), "");
    if (!text) return accepted;
    parsed = JSON.parse(text);
  } catch {
    return accepted;
  }
  const validated = validateDeliveryReceipt(parsed);
  if (!validated.ok || validated.receipt.runId !== kernelRunId) return accepted;
  for (const entry of validated.receipt.entries ?? []) {
    const verified = await verifiedReceiptArtifacts(project, { ...validated.receipt, entries: [entry] });
    if (verified.artifacts.length > 0 && verified.mismatched.length === 0) accepted.add(String(entry.deliverableId));
  }
  return accepted;
}

/**
 * Deliverables the run wrote and never submitted.
 *
 * Both halves must hold, because either alone is a different story: a plan
 * item that was never attempted might simply never have been started, and
 * files on disk might belong to an item that was submitted and rejected. Only
 * "planned, never attempted, and its directory has files in it" means the run
 * did the work and stopped without asking for a verdict.
 *
 * @param {any} project @param {{ state: string, projection?: Record<string, any> }} projection
 * @returns {Promise<{ id: string, files: number }[]>}
 */
async function unsubmittedDeliverables(project, projection) {
  if (projection.state !== "read") return [];
  const items = projection.projection?.plan?.items;
  if (!Array.isArray(items)) return [];
  /** @type {{ id: string, files: number }[]} */
  const found = [];
  for (const item of items) {
    if (item?.status !== "planned" || Number(item?.attempts ?? 0) !== 0) continue;
    // The id comes out of a file the container wrote, so it is input, not a
    // name we chose. One path segment only — the same rule
    // `deliverableCandidatePaths` applies, and for the same reason: joined
    // unchecked, `../..` here reads a directory outside the workspace.
    const id = String(item?.id ?? "");
    if (!id || id.includes("/") || id.includes("\\") || id === "." || id === "..") continue;
    let files = 0;
    try {
      const entries = await readdir(path.join(project.workspaceDir, workspaceLayout.deliverablesDir, id), { withFileTypes: true });
      files = entries.filter((entry) => entry.isFile()).length;
    } catch {
      // No directory means nothing was written for it: an item that was never
      // started, not one that was written and abandoned.
      continue;
    }
    if (files > 0) found.push({ id, files });
  }
  return found;
}

/**
 * Planned deliverables the receipt does not account for.
 *
 * A combined run plans two capabilities, one is accepted and one is not, and
 * the receipt carries an entry only for the accepted one. The success branch
 * built its notices from `receipt.entries`, so the dropped deliverable left no
 * trace anywhere on the run row: succeeded, one artifact, no error code, no
 * notice. A single-capability run cannot reach that state — with its one item
 * rejected there is no receipt at all — so this is exactly the shape a reader
 * is least equipped to notice, and the run says nothing is wrong.
 *
 * A notice, never a refusal: the accepted package really was accepted, and the
 * reader is owed the fact that something else they asked for is not here.
 * @param {any} projection a `readRunStateProjection` result
 * @param {any} receipt
 * @returns {StoredNotice[]}
 */
function droppedDeliverableNotices(projection, receipt) {
  if (projection?.state !== "read") return [];
  const items = projection.projection?.plan?.items;
  if (!Array.isArray(items)) return [];
  const accounted = new Set(
    (receipt?.entries ?? [])
      .map((/** @type {any} */ entry) => String(entry?.deliverableId ?? entry?.id ?? ""))
      .filter(Boolean),
  );
  const notices = [];
  for (const item of items) {
    const id = String(item?.id ?? "");
    if (!id || accounted.has(id)) continue;
    // `accepted` without a receipt entry would be a bookkeeping contradiction
    // rather than a dropped deliverable, and saying "not delivered" about it
    // would be the false claim this exists to prevent. Report what the plan
    // itself calls unfinished.
    const state = String(item?.status ?? item?.state ?? "");
    if (state === "accepted") continue;
    const label = String(item?.title ?? item?.capability ?? "").trim();
    const sentence = label
      ? `计划中的交付物「${label}」（${id}）没有通过验收，本次运行没有交付它；其余通过验收的内容不受影响。`
      : `计划中的交付物 ${id} 没有通过验收，本次运行没有交付它；其余通过验收的内容不受影响。`;
    notices.push(runNotice("run_deliverable_dropped", sentence, { detail: sentence }));
  }
  return notices.slice(0, 10);
}

/**
 * The browser's `deliverable/update` frames, built from the run's own record.
 *
 * Hidden knowledge: why this exists at all, and where every field comes from.
 * The stream has declared `deliverable/update` since it was written and the
 * browser has had the listener, the fold branch and the `deliverables` array
 * since then too — but nothing ever sent one, so the panel that shows a
 * package's verdict and the issues it was sent back with was empty on every
 * run in production. `streamTypesReachTheBrowser` pinned that as a promise the
 * stream made and did not keep.
 *
 * Nothing here is invented at the call site. Every field is a field of the
 * run's own plan index (`packages/socket/src/runMirror.mjs` `plan_index`,
 * itself an index over `@evimed/domain`'s `PlanDeliverable`) or of the delivery
 * receipt `validateDeliveryReceipt` accepts:
 *
 * - `id`, `contractKind`, `capability`, `title` — the plan's own copy of the
 *   deliverable, checked against `isContractKind` so an unknown kind travels as
 *   an empty string rather than as a label the browser cannot render;
 * - `status` — a `PLAN_ITEM_STATES` value, and only those. A status the
 *   vocabulary does not have is dropped to `planned`, because a run-written
 *   file is input, not a name we chose;
 * - `childSessionId` — which subagent the item was delegated to, so the run
 *   tree can hang the deliverable under the child that produced it instead of
 *   guessing from the capability name;
 * - `issues` — the gate's own verdict on the last attempt (`GateIssue`:
 *   `{code, message, severity, path?, line?}`), which is what the repair loop
 *   sends back to the run and therefore what a person watching a second attempt
 *   needs to see;
 * - `receipt` — present only once `delivery-receipt.json` exists, and then it is
 *   that receipt's own entry for this deliverable, digests included.
 *
 * @param {Record<string, any>} projection the parsed `.evimed-run/state.json`
 * @param {import('@evimed/domain').DeliveryReceipt|null} [receipt]
 * @returns {Record<string, any>[]} one frame payload per planned deliverable
 */
function deliverableFrames(projection, receipt = null) {
  const items = Array.isArray(projection?.plan?.items) ? projection.plan.items : [];
  const entries = new Map((receipt?.entries ?? []).map((entry) => [String(entry.deliverableId), entry]));
  const children = Array.isArray(projection?.subagents) ? projection.subagents : [];
  /** @type {Record<string, any>[]} */
  const frames = [];
  const seen = new Set();
  for (const item of items) {
    const id = String(item?.id ?? "").trim();
    if (!id) continue;
    seen.add(id);
    const contractKind = String(item?.contractKind ?? "").trim();
    const status = String(item?.status ?? "planned");
    const entry = entries.get(id);
    // The plan index writes the last verdict as `issues` and names no child
    // (the socket's `publicItem`); this read `lastIssues` and
    // `item.childSessionId`, so every frame went out with no issues and no
    // child — the panel a second attempt is watched on was empty by
    // construction. The child is the plan index's delegation row.
    const issues = normalizeGateIssues(Array.isArray(item?.issues) ? item.issues : item?.lastIssues);
    const child = [...children].reverse().find((row) => String(row?.deliverableId ?? "") === id);
    const childSessionId = child?.childSessionId ?? item?.childSessionId;
    const attempts = Number.isSafeInteger(item?.attempts) && item.attempts > 0 ? item.attempts : 0;
    frames.push({
      id,
      contractKind: isContractKind(contractKind) ? contractKind : "",
      capability: String(item?.capability ?? "").trim(),
      title: String(item?.title ?? "").trim() || id,
      status: PLAN_ITEM_STATES.includes(status) ? status : "planned",
      attempts,
      childSessionId: childSessionId ? String(childSessionId) : null,
      issues,
      mustFixCount: issues.filter((issue) => issue.severity === "required").length,
      ...(entry ? { receipt: receiptEntryView(entry) } : {}),
    });
  }
  // A receipt entry with no plan item behind it is not an anomaly to drop. The
  // projection is optional — an answer-mode run writes none, and a run whose
  // container died before the projection landed still leaves the receipt — so
  // publishing only what the plan index knows about meant a delivered package
  // reached the browser with an empty deliverables panel, which is the exact
  // emptiness this whole change exists to remove. `evimed_submit_deliverable`
  // is the only writer of a receipt entry and only writes one on acceptance, so
  // the status is `accepted` by construction, not by assumption.
  for (const entry of entries.values()) {
    const id = String(entry.deliverableId ?? "").trim();
    if (!id || seen.has(id)) continue;
    const contractKind = String(entry.contractKind ?? "").trim();
    frames.push({
      id,
      contractKind: isContractKind(contractKind) ? contractKind : "",
      capability: String(entry.capability ?? "").trim(),
      title: id,
      status: "accepted",
      attempts: Number.isSafeInteger(entry.attempt) && entry.attempt > 0 ? entry.attempt : 0,
      childSessionId: null,
      issues: [],
      mustFixCount: 0,
      receipt: receiptEntryView(entry),
    });
  }
  return frames;
}

/**
 * One receipt entry, as the browser reads it.
 *
 * Copied field by field rather than forwarded: the receipt is a validated
 * durable record and the frame is a view of it, and passing the object through
 * would put whatever else the file happened to contain on the wire.
 *
 * @param {import('@evimed/domain').DeliveryReceiptEntry} entry
 * @returns {Record<string, any>}
 */
function receiptEntryView(entry) {
  return {
    deliverableId: entry.deliverableId,
    contractKind: entry.contractKind,
    capability: entry.capability,
    attempt: entry.attempt,
    acceptedAt: entry.acceptedAt,
    files: entry.files.map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes })),
    notices: [...entry.notices],
  };
}

/** Severities a `GateIssue` may carry. Anything else is advisory, never dropped. */
const gateIssueSeverities = new Set(["required", "advisory", "optional"]);

/**
 * The gate's issues, read defensively.
 *
 * They come out of a file the container wrote, so they are input. An issue
 * whose severity is not one the browser knows is shown as advisory rather than
 * discarded: losing the sentence is worse than mislabelling its urgency.
 *
 * @param {unknown} value @returns {{ code: string, message: string, severity: string, path?: string, line?: number }[]}
 */
function normalizeGateIssues(value) {
  if (!Array.isArray(value)) return [];
  /** @type {{ code: string, message: string, severity: string, path?: string, line?: number }[]} */
  const issues = [];
  for (const raw of value.slice(0, maxDeliverableIssues)) {
    if (!raw || typeof raw !== "object") continue;
    const message = String(/** @type {any} */ (raw).message ?? "").trim();
    if (!message) continue;
    const severity = String(/** @type {any} */ (raw).severity ?? "");
    const line = Number(/** @type {any} */ (raw).line);
    const issuePath = String(/** @type {any} */ (raw).path ?? "").trim();
    issues.push({
      code: String(/** @type {any} */ (raw).code ?? "").trim() || "unnamed_issue",
      message,
      severity: gateIssueSeverities.has(severity) ? severity : "advisory",
      ...(issuePath ? { path: issuePath } : {}),
      ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}),
    });
  }
  return issues;
}

/**
 * What in the run's own projection counts as the run having done something.
 *
 * The root session's message and tool-call counts are the other half of the
 * progress signal, and they are exactly what goes still during a delegated
 * stretch: the orchestrator hands work to children and waits. Everything named
 * here keeps moving while it waits.
 *
 * Measured against what the projection actually carries, which is less than it
 * looks: `subagents` is initialised and never written to by any plugin, and
 * `budget.steps` counts the *root* session only — a subagent's session never
 * gets a `runId` (its brief injection returns before that line), so the run
 * mirror and the gate-run table are never written on its behalf. Evidence is
 * the one table a child does reach, because the evidence plugin's tool-observed
 * hook is not gated on a run id.
 *
 * @param {Record<string, any>} projection
 * @returns {string} a signature that changes exactly when the run has moved
 */
function runSideActivitySignature(projection) {
  const evidence = projection?.evidence ?? {};
  const budget = projection?.budget ?? {};
  const plan = projection?.plan ?? {};
  return [
    Number(evidence.total ?? 0) || 0,
    Number(budget.children ?? 0) || 0,
    Number(budget.steps ?? 0) || 0,
    Number(plan.revision ?? 0) || 0,
    Array.isArray(projection?.gateRuns) ? projection.gateRuns.length : 0,
  ].join(":");
}

export class AgentRunStore {
  constructor(researchSessions, options = {}) {
    this.researchSessions = researchSessions;
    this.agentRegistry = Promise.resolve(options.agentRegistry);
    // The same registry, once it has loaded, for the one synchronous reader:
    // a pushed `run/state` describes its artifacts like the list does.
    /** @type {any} */
    this.loadedAgentRegistry = null;
    this.agentRegistry.then((registry) => { this.loadedAgentRegistry = registry ?? null; }, () => {});
    this.model = String(options.model ?? "").trim();
    this.maxRuns = options.maxRuns ?? defaultMaxRuns;
    this.maxBytes = options.maxBytes ?? defaultMaxBytes;
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? (() => randomId("run_"));
    this.readSessionHistory = options.readSessionHistory ?? (async () => []);
    this.readSessionStatus = options.readSessionStatus ?? (async () => "idle");
    this.readChildSessionActivity = options.readChildSessionActivity ?? (async () => []);
    this.runtimeWorkspaceRoot = options.runtimeWorkspaceRoot ?? (async (project) => project.workspaceDir);
    this.runtimeGeneration = options.runtimeGeneration ?? (async () => null);
    // Workflow-owned runs may retain a different workspace after a user changes
    // the active workspace. Null means its durable owner cannot authorize recovery.
    this.resolveRunProject = options.resolveRunProject ?? (async (project) => project);
    /** Whoever forwards a run's own projection to the browser. @type {(project: any, run: any, type: string, data: any) => void} */
    this.onRunProjection = options.onRunProjection ?? (() => {});
    // The progress aggregate (`run/progress`): the minimum gap between two
    // frames for one run, how often a child's own history is re-read to
    // reconcile its tool calls, and how often the kernel is asked for children
    // nothing named yet. Each is a bound on work the monitor does per poll.
    this.progressPublishIntervalMs = options.progressPublishIntervalMs ?? 2_000;
    this.childHistoryIntervalMs = options.childHistoryIntervalMs ?? 20_000;
    this.childDiscoveryIntervalMs = options.childDiscoveryIntervalMs ?? 5_000;
    /** What one run cost so far, for the aggregate; null when unattributed. @type {(project: any, run: any) => Promise<any>} */
    this.readRunUsage = options.readRunUsage ?? (async () => null);
    /** runId -> the live progress state the monitor and the event pump feed. */
    this.progressTrackers = new Map();
    /** runId -> when its question was last looked for (epoch ms). @type {Map<string, number>} */
    this.questionBackfills = new Map();
    /** Label writes still in flight, awaited on close. @type {Set<Promise<void>>} */
    this.backgroundLabels = new Set();
    /** Per-run memory, so a fixed-interval poll does not repeat itself. */
    this.projectionDigests = new Map();
    /** runId -> deliverableId -> the frame last sent for it. Same reason. */
    this.deliverableDigests = new Map();
    this.projectionAdmissions = new Map();
    this.projectionNoticed = new Set();
    /** Trusted DSH event-pump activity, scoped by project and run. */
    this.kernelActivities = new Map();
    /** Kernel-confirmed child sequence baselines/high-water marks per run. */
    this.childKernelHeads = new Map();
    /** Changes only when a bound child's sequence exceeds its own high-water. */
    this.childKernelActivities = new Map();
    this.monitorIntervalMs = options.monitorIntervalMs ?? 500;
    this.monitorMaxPolls = options.monitorMaxPolls ?? 3600;
    // Consecutive polls with no new message and no new tool call before a run
    // is called stalled. Zero disables the check and waits out the timeout.
    this.monitorStallPolls = options.monitorStallPolls ?? 0;
    this.onRunFinished = options.onRunFinished ?? (async () => {});
    this.onRunFinishedError = options.onRunFinishedError ?? (async () => {});
    // Every state change the ledger commits is announced. The browser's live
    // view used to be built by re-reading the ledger on a timer, which meant a
    // run could sit in a state for seconds after reaching it; announcing at the
    // commit makes "what the ledger says" and "what the page shows" the same
    // thing without a second polling loop.
    this.onRunStateChanged = options.onRunStateChanged ?? (() => {});
    // Server-side repair rounds. Off unless asked for (2026-09-17): twelve live
    // runs spent 24 of them, 10 to 35 minutes each, and none produced a package
    // that passed clean. The run still repairs inside its own turn, against the
    // same rules, through `evimed_submit_deliverable`; what the server finds
    // afterwards is attached to the delivery instead of sent back.
    // `OPEN_SCIENCE_GATE_REPAIR_ROUNDS` turns them on again.
    this.maxClinicalRepairAttempts = options.maxClinicalRepairAttempts ?? 0;
    // Waits before sending a refused repair again; see `sendRepair`.
    this.repairRetryDelaysMs = Array.isArray(options.repairRetryDelaysMs) ? options.repairRetryDelaysMs : [1_500, 4_000];
    if (!Number.isSafeInteger(this.maxClinicalRepairAttempts) || this.maxClinicalRepairAttempts < 0) {
      throw new TypeError("AgentRunStore maxClinicalRepairAttempts must be a non-negative integer.");
    }
    // Rounds charged apart from the repair budget because the whole rejection
    // was one structural fact (see SpecialistCompletionVerdict.qualityStructural).
    // Defaults to the repair budget itself, so the worst case a deployment can
    // reach is twice the rounds it already allows — never an unbounded loop.
    this.maxClinicalStructuralRepairAttempts =
      options.maxClinicalStructuralRepairAttempts ?? this.maxClinicalRepairAttempts;
    if (
      !Number.isSafeInteger(this.maxClinicalStructuralRepairAttempts)
      || this.maxClinicalStructuralRepairAttempts < 0
    ) {
      throw new TypeError("AgentRunStore maxClinicalStructuralRepairAttempts must be a non-negative integer.");
    }
    this.monitors = new Map();
    /** One reconciliation per project session; monitor and explicit callers join it. */
    this.reconciles = new Map();
    this.projects = new Map();
    this.dispatchOwners = new Set();
    this.clinicalRepairAttempts = new Map();
    /** Structural repair rounds spent per run; finite and never refilled. */
    this.clinicalStructuralRepairAttempts = new Map();
    this.clinicalRepairBaselineCursors = new Map();
    this.clinicalRepairSenders = new Map();
    // Report size when repair first began, so a shrinking revision is measured
    // against where it started rather than against the previous attempt only.
    this.clinicalRepairReportSizes = new Map();
    // The brief each in-flight run was dispatched with, by run id. In memory
    // only: the question-scoped safety rule reads it, and it is far too large
    // for the run ledger (see normalizeDispatchInput). A restart therefore
    // loses it, and the gate says so rather than reading a brief the run itself
    // could have written.
    this.dispatchedBriefs = new Map();
    if (!this.model) throw new Error("AgentRunStore requires a configured model.");
  }

  /** Announce a committed state change. Isolated: a listener must never be able
   *  to fail the write it is observing.
   *  isolated: evimed_run_state_listener_failures_total
   *  @param {Record<string, any>} project @param {Record<string, any> | null | undefined} run */
  /**
   * A run with the kind of every file it left (`artifactKinds`) and their
   * counts (`artifactCounts`) — `runArtifacts.mjs`. Computed on read from the
   * plan on the record and the registry's declared outputs, so every run ever
   * recorded is described and `artifacts` keeps its shape for older readers.
   * @param {Record<string, any>} run @param {any} [registry]
   * @returns {Record<string, any>}
   */
  withArtifactKinds(run, registry = this.loadedAgentRegistry) {
    let described = null;
    try {
      described = describeRunArtifacts(run, (capabilityId) => {
        const outputs = registry?.get?.(capabilityId)?.outputs;
        return Array.isArray(outputs) ? outputs.map((/** @type {any} */ output) => String(output?.path ?? "")).filter(Boolean) : null;
      });
    } catch { /* isolated: a record that cannot be described is still a record */ }
    return described ? { ...run, ...described } : run;
  }

  notifyState(project, folded) {
    if (!folded) return;
    const run = this.withArtifactKinds(folded);
    // The one choke point every push notification passes through, so `phase`
    // (§7.1.1) reaches `run/state` the same way it reaches `list()` — a fresh
    // record straight from `foldEvents` has the ledger's own four-value
    // `status` but nothing computed from it yet. Computed outside the isolating
    // try below: a phase that fails to compute must not silently cancel the
    // state-change notification itself, only the one field derived from it.
    let phase = null;
    try {
      // `run` is `Record<string, any>` here (every notifyState caller folds a
      // record from a different branch of `foldEvents`), so the same cast as
      // `runPhaseHistory` applies for the same reason: the fields `runPhase`
      // reads are exactly the ones every folded run record carries.
      phase = runPhase(/** @type {Parameters<typeof runPhase>[0]} */ ({ ...run, hasProgressEvent: Boolean(run.lastProgressAt) }));
    } catch { /* isolated: evimed_run_phase_projection_failures_total */ }
    try {
      this.onRunStateChanged(project, { ...run, phase });
    } catch { /* isolated: evimed_run_state_listener_failures_total */ }
  }

  /**
   * The accepted revisions of this run's package, preserved before repair.
   *
   * `snapshotAcceptedPackageForRepair` has written these since the repair loop
   * was built — the whole text of every file, under the receipt digest they
   * were accepted at — and nothing could read them back. That is the second
   * half of the aripiprazole failure: the run kept editing after its package
   * was accepted, the receipt stopped matching, and the version that *had*
   * passed the gate was sitting in `.openscience/repair-revisions/` with no
   * route to it. A snapshot nobody can open is a backup that does not exist.
   *
   * Read-only and metadata-first: the digests and byte counts, not the text.
   * A package is a dozen files of report prose, and a list endpoint that
   * inlined all of them would be the reason nobody calls it. `readRepairRevisionFile`
   * fetches one file when a person asks for it.
   *
   * @param {Record<string, any>} project @param {string} rawRunId
   * @returns {Promise<{acceptedDigest: string, preservedAt: string, files: {path: string, sha256: string, bytes: number}[]}[]>}
   */
  async listRepairRevisions(project, rawRunId) {
    const runId = safeId(rawRunId, "agent run id");
    const directory = path.join(project.metaDir, "repair-revisions");
    /** @type {string[]} */
    let names;
    try {
      names = (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.startsWith(`${runId}-`) && entry.name.endsWith(".json"))
        .map((entry) => entry.name);
    } catch {
      // No directory is "this run was never repaired", which is the ordinary
      // case and not an error.
      return [];
    }
    const revisions = [];
    for (const name of names.sort()) {
      const text = await readTextFileNoFollow(project.rootDir, path.join(directory, name), "").catch(() => "");
      if (!text) continue;
      let parsed;
      try { parsed = JSON.parse(text); } catch { continue; }
      // A snapshot this build cannot read is skipped rather than throwing: one
      // unreadable file must not make the other revisions unreachable too.
      if (parsed?.formatVersion !== 1 || parsed?.controlPlaneRunId !== runId) continue;
      revisions.push({
        acceptedDigest: String(parsed.acceptedDigest ?? ""),
        preservedAt: String(parsed.preservedAt ?? ""),
        files: (Array.isArray(parsed.files) ? parsed.files : []).map((file) => ({
          path: String(file?.path ?? ""), sha256: String(file?.sha256 ?? ""), bytes: Number(file?.bytes ?? 0),
        })).filter((file) => file.path),
      });
    }
    return revisions;
  }

  /**
   * One file out of one preserved revision, as it was when the gate accepted it.
   *
   * The digest is re-checked against the text rather than trusted from the
   * snapshot's own field: the point of handing this back is that it is the
   * version that passed, so "this is what passed" has to be provable here and
   * not merely recorded.
   *
   * @param {Record<string, any>} project @param {string} rawRunId
   * @param {string} acceptedDigest @param {string} relative
   * @returns {Promise<{path: string, sha256: string, bytes: number, text: string, preservedAt: string}>}
   */
  async readRepairRevisionFile(project, rawRunId, acceptedDigest, relative) {
    const runId = safeId(rawRunId, "agent run id");
    const digest = safeId(String(acceptedDigest ?? ""), "accepted digest");
    const wanted = normalizeWorkspaceRelativePath(relative, "artifact path");
    const file = path.join(project.metaDir, "repair-revisions", `${runId}-${digest}.json`);
    const text = await readTextFileNoFollow(project.rootDir, file, "").catch(() => "");
    if (!text) throw new HttpError(404, "repair_revision_not_found", "No preserved revision for that run and digest.");
    let parsed;
    try { parsed = JSON.parse(text); } catch {
      throw new HttpError(409, "repair_revision_unreadable", "The preserved revision could not be read.");
    }
    if (parsed?.formatVersion !== 1 || parsed?.controlPlaneRunId !== runId) {
      throw new HttpError(404, "repair_revision_not_found", "No preserved revision for that run and digest.");
    }
    const entry = (Array.isArray(parsed.files) ? parsed.files : []).find((candidate) => candidate?.path === wanted);
    if (!entry || typeof entry.text !== "string") {
      throw new HttpError(404, "repair_revision_file_not_found", "That file is not part of the preserved revision.");
    }
    const actual = createHash("sha256").update(entry.text, "utf8").digest("hex");
    if (actual !== String(entry.sha256)) {
      throw new HttpError(409, "repair_revision_digest_mismatch", "The preserved revision no longer matches its recorded digest.");
    }
    return {
      path: wanted, sha256: actual, bytes: Buffer.byteLength(entry.text), text: entry.text,
      preservedAt: String(parsed.preservedAt ?? ""),
    };
  }

  /**
   * The conversation a researcher last worked in, in this project (C4 "me"
   * `lastSessionId`): the session of the run that moved most recently, so the
   * shell can reopen it instead of a blank page. Work a machine started —
   * an evaluation, an autopilot episode — is not "last open".
   * @param {any} project @returns {Promise<string | null>}
   */
  async lastSessionId(project) {
    let latest = null;
    let at = "";
    for (const run of foldEvents(parseEvents(await readLedgerText(project, this.maxBytes))).values()) {
      if (run.automated === true || String(run.effectiveRouteReason ?? "").startsWith("autopilot:")) continue;
      const moved = [run.lastProgressAt, run.finishedAt, run.startedAt].filter((value) => typeof value === "string").sort().at(-1) ?? "";
      if (moved > at) {
        at = moved;
        latest = run.sessionId;
      }
    }
    return latest;
  }

  /**
   * The runs of a project that are still going, by id — what the model
   * gateway asks to attribute an interactive runtime's request to its run
   * (E §9.4). A fold with no phase walk, because it is asked per request.
   * @param {any} project @returns {Promise<string[]>}
   */
  async activeRunIds(project) {
    const runs = foldEvents(parseEvents(await readLedgerText(project, this.maxBytes)));
    return [...runs.values()].filter((run) => run.status === "running").map((run) => run.id);
  }

  /**
   * The runs of a project that are still going, with the conversation each is
   * in — what the capsule gateway asks to know whose recall it is answering
   * (an incognito conversation, a 「本次不用」). The same fold as
   * `activeRunIds`, asked per recall.
   * @param {any} project @returns {Promise<{ id: string, sessionId: string }[]>}
   */
  async activeRuns(project) {
    const runs = foldEvents(parseEvents(await readLedgerText(project, this.maxBytes)));
    return [...runs.values()].filter((run) => run.status === "running").map((run) => ({ id: run.id, sessionId: run.sessionId }));
  }

  /**
   * How much a project has been used, for its list row (C4): how many runs it
   * holds and when anything last happened in one. Cheaper than `list` — no
   * phase walk — because the project list reads it for every project.
   * @param {any} project @returns {Promise<{ runCount: number, lastActivityAt: string | null }>}
   */
  async activitySummary(project) {
    const runs = [...foldEvents(parseEvents(await readLedgerText(project, this.maxBytes))).values()];
    let last = null;
    for (const run of runs) {
      for (const at of [run.finishedAt, run.lastProgressAt, run.startedAt]) {
        if (typeof at === "string" && (!last || at > last)) last = at;
      }
    }
    return { runCount: runs.length, lastActivityAt: last };
  }

  async list(project) {
    const events = parseEvents(await readLedgerText(project, this.maxBytes));
    const runs = [...foldEvents(events).values()];
    // `phase` is a projection, never a stored field (§7.1.1): computed fresh on
    // every read from the same four ledger values every other reader already
    // sees, plus a diagnostic walk of this run's own events that counts an
    // illegal phase sequence rather than ever refusing to return the run.
    return runs
      .map((run) => {
        const history = runPhaseHistory(events, run.id);
        return {
          ...run,
          phase: history.phase,
          phaseIllegalTransitions: history.illegalTransitions,
          ...(history.notices.length ? { phaseNotices: history.notices } : {}),
        };
      })
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  /**
   * The deliverables each running run is working through, for the runs page's
   * step list (2026-09-16 review, P2 #14): a thirteen-minute run showed a phase
   * chip and a tool-call count, and nothing about which of its deliverables
   * were done. Read from the run's own projection file and only for runs still
   * running — a finished run's outcome is its artifacts — and for at most three
   * of them per request. Best effort: an unreadable projection adds nothing.
   * @param {Record<string, any>} project @param {Record<string, any>[]} runs
   */
  async withPlanProgress(project, runs) {
    // Bounded, because each running run is a projection read on a list
    // request; eight covers any account's concurrent runs today (the project
    // cap is one or two), where the old three silently dropped the fourth.
    let budget = 8;
    const registry = await this.agentRegistry.catch(() => null);
    return Promise.all(runs.map(async (run) => {
      if (run.status !== "running" || budget <= 0) return this.withArtifactKinds(run, registry);
      budget -= 1;
      // `readRunStateProjection` answers every failure with a state, never a throw.
      const read = /** @type {{ state: string, projection?: any }} */ (await readRunStateProjection(project, project.workspaceDir, run));
      const projection = read.state === "read" ? read.projection ?? null : null;
      const items = Array.isArray(projection?.plan?.items) ? projection.plan.items : null;
      const deliverables = items?.length ? runDeliverables(projection, null, null) : run.deliverables;
      const live = this.progressTrackers.get(run.id)?.last;
      return {
        ...run,
        ...(items?.length ? {
          // The pre-C3 view the shell has read since the step list shipped;
          // `deliverables` below is the same plan with verdicts and children.
          planItems: items.slice(0, 12).map((/** @type {any} */ item) => ({
            id: String(item?.id ?? "").slice(0, 120),
            title: String(item?.title ?? item?.id ?? "").slice(0, 160),
            status: PLAN_ITEM_STATES.includes(item?.status) ? item.status : "planned",
            attempts: Number.isSafeInteger(item?.attempts) ? item.attempts : 0,
          })),
        } : {}),
        ...(deliverables?.length ? { deliverables } : {}),
        ...(live ? { progress: { ...live, deliverables: deliverables ?? live.deliverables } } : {}),
      };
    }));
  }

  async recover(project) {
    let runs = await this.list(project);
    for (const run of runs.filter((item) => item.status === "running")) {
      const runProject = await this.resolveRunProject(project, run);
      if (!runProject) continue;
      if (run.dispatchStatus === "dispatching" && !this.dispatchOwners.has(run.id)) {
        await this.markDispatch(runProject, run.id, "unknown");
      }
      this.scheduleMonitor(runProject, run.id);
    }
    this.projects.set(`${project.userId}:${project.id}`, project);
    runs = await this.list(project);
    return runs;
  }

  /** @param {Record<string, any>} project @param {Record<string, any>} input */
  async start(project, input) {
    const { sessionId } = normalizeStartInput(input);
    const session = await this.researchSessions.get(project, sessionId);
    if (!session) throw new HttpError(404, "research_session_not_found", "Research session not found.");
    await this.reconcileSession(project, sessionId);
    const baselineCursor = await this.captureBaseline(project, sessionId);
    const record = await this.createRun(project, session, { baselineCursor });
    this.projects.set(`${project.userId}:${project.id}`, project);
    this.scheduleMonitor(project, record.id);
    return record;
  }

  async captureBaseline(project, sessionId) {
    let history;
    try {
      history = await this.readSessionHistory(project, sessionId, { wake: true });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, "runtime_history_unavailable", "Runtime session history is unavailable.");
    }
    return historyCursor(history);
  }

  /** @param {Record<string, any>} project @param {Record<string, any>} session
   *  @param {Record<string, any>} options */
  async createRun(project, session, { baselineCursor, dispatchId = null } = {}) {
    return (await this.reserveRun(project, session, { baselineCursor, dispatchId })).run;
  }

  /** @param {Record<string, any>} project @param {Record<string, any>} session
   *  @param {Record<string, any>} options */
  async reserveRun(project, session, {
    baselineCursor,
    dispatchId = null,
    automated = false,
    estimatedMinutes = null,
    forkedFrom = null,
    question = null,
    effectiveAgentId = session.mode === "specialist" ? session.agentId : null,
    effectiveAgentVersion = session.mode === "specialist" ? session.agentVersion : null,
    effectiveRuntimeAgent = session.mode === "specialist" ? session.runtimeAgent : null,
    effectiveRouteReason = session.mode === "specialist" ? "session-binding" : null,
    nativeTurn = null,
    kernelRequestIds = null,
    legacyRunId = null,
    startedAt = null,
  } = {}) {
    return withProjectStorageMutation(project, async () => {
      const events = parseEvents(await readLedgerText(project, this.maxBytes));
      const runs = foldEvents(events);
      if (nativeTurn) {
        kernelRequestIds = (kernelRequestIds ?? []).map(storedKernelRequestId);
        nativeTurn = validateNativeTurn(nativeTurn);
        const owned = [...runs.values()].find((run) => run.sessionId === session.sessionId && (
          kernelRequestIds.length
            ? kernelRequestIds.some((id) => (run.kernelRequestIds ?? []).includes(id))
            : !run.kernelRequestIds?.length && run.nativeTurn?.startSeq === nativeTurn.startSeq
        ));
        if (owned) return { run: owned, owner: false };
        const legacy = runs.get(legacyRunId);
        if (legacy && !legacy.nativeTurn && legacy.sessionId === session.sessionId
          && String(legacy.effectiveRouteReason ?? "").startsWith(adoptedRouteReason)) {
          const event = { event: "runtime-turn", id: legacy.id, nativeTurn, requestIds: kernelRequestIds ?? [] };
          await writeFileAtomicNoFollow(project.rootDir, ledgerFile(project), serializeNext(events, event, this.maxBytes), { encoding: "utf8", mode: 0o600 });
          return { run: foldEvents([...events, event]).get(legacy.id), owner: false };
        }
      }
      const duplicate = dispatchId == null
        ? null
        : [...runs.values()].find((run) => run.dispatchId === dispatchId);
      if (duplicate) return { run: duplicate, owner: false };
      const active = [...runs.values()].find((run) => run.sessionId === session.sessionId && run.status === "running");
      // An adopted run is a placeholder for a session nobody had claimed. A
      // dispatch is somebody claiming it, so it takes the session over instead
      // of being refused by the placeholder -- otherwise the first real request
      // on a session the browser application had already opened is answered
      // `agent_run_active` by a run that exists only because nothing else did.
      const adopted = !nativeTurn && !active?.nativeTurn && active?.effectiveRouteReason === adoptedRouteReason;
      if (active && !adopted && !nativeTurn) {
        throw new HttpError(409, "agent_run_active", "This research session already has an active run.");
      }
      if (adopted) {
        // How long it ran, not how long the record sat there.
        //
        // A superseded run is usually one the control plane lost track of —
        // restarted, abandoned, left over from days ago — and the wall-clock
        // difference to now describes the ledger, not the work. `durationMs`
        // feeds the run list and every duration statistic read off it, where a
        // three-day "run" is not an outlier to explain but a wrong number.
        //
        // Two honest bounds, whichever is tighter: the last moment anything was
        // observed, and the monitor's own ceiling — past which this run would
        // have been ended, so it cannot have been working longer.
        const supersededStartedAt = Date.parse(active.startedAt);
        const observedUntil = active.lastProgressAt ? Date.parse(active.lastProgressAt) : supersededStartedAt;
        const ceiling = this.monitorIntervalMs * this.monitorMaxPolls;
        const worked = Math.max(0, observedUntil - supersededStartedAt);
        events.push({
          event: "finished",
          id: active.id,
          status: "canceled",
          errorCode: "superseded_by_dispatch",
          artifacts: [],
          finishedAt: this.now().toISOString(),
          durationMs: Number.isSafeInteger(ceiling) && ceiling > 0 ? Math.min(worked, ceiling) : worked,
        });
        runs.delete(active.id);
      }
      if (runs.size >= this.maxRuns) {
        throw new HttpError(409, "agent_run_limit_reached", "This project has reached its agent run limit.");
      }
      const now = this.now().toISOString();
      const id = safeId(this.id(), "agent run id");
      if (runs.has(id)) throw new HttpError(409, "agent_run_id_conflict", "Agent run id already exists.");
      const event = {
        event: "started",
        id,
        dispatchId,
        dispatchStatus: dispatchId ? "dispatching" : "accepted",
        ...(nativeTurn ? { nativeTurn } : {}),
        kernelRequestIds: kernelRequestIds ?? (dispatchId ? [randomId("req_")] : []),
        sessionId: session.sessionId,
        mode: session.mode,
        agentId: session.agentId,
        agentVersion: session.agentVersion,
        runtimeAgent: session.runtimeAgent,
        effectiveAgentId,
        effectiveAgentVersion,
        effectiveRuntimeAgent,
        effectiveRouteReason,
        model: this.model,
        question,
        ...(automated === true ? { automated: true } : {}),
        ...(normalizeRunEstimate(estimatedMinutes) ? { estimatedMinutes: normalizeRunEstimate(estimatedMinutes) } : {}),
        ...(typeof forkedFrom === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(forkedFrom) ? { forkedFrom } : {}),
        createdAt: now,
        startedAt: startedAt == null ? now : storedTimestamp(startedAt, "startedAt"),
        baselineCursor,
      };
      const text = serializeNext(events, event, this.maxBytes);
      if (dispatchId) this.dispatchOwners.add(id);
      try {
        await writeFileAtomicNoFollow(project.rootDir, ledgerFile(project), text, { encoding: "utf8", mode: 0o600 });
      } catch (error) {
        this.dispatchOwners.delete(id);
        throw error;
      }
      const run = foldEvents([...events, event]).get(id);
      this.notifyState(project, run);
      return { run, owner: true };
    });
  }

  async existingDispatch(project, run) {
    if (run.status !== "running" || run.dispatchStatus !== "dispatching") return run;
    if (this.dispatchOwners.has(run.id)) return run;
    const runProject = await this.resolveRunProject(project, run);
    if (!runProject) return run;
    const unknown = await this.markDispatch(runProject, run.id, "unknown");
    this.projects.set(`${project.userId}:${project.id}`, runProject);
    this.scheduleMonitor(runProject, run.id);
    return unknown;
  }

  async dispatch(project, input, sendPrompt) {
    const {
      sessionId,
      dispatchId,
      automated,
      estimatedMinutes,
      question,
      briefText,
      effectiveAgentId,
      effectiveAgentVersion,
      effectiveRuntimeAgent,
      effectiveRouteReason,
    } = normalizeDispatchInput(input);
    if (typeof sendPrompt !== "function") throw new TypeError("Agent run dispatch requires a prompt sender.");
    const existing = (await this.list(project)).find((run) => run.dispatchId === dispatchId);
    if (existing) return this.existingDispatch(project, existing);
    const session = await this.researchSessions.get(project, sessionId);
    if (!session) throw new HttpError(404, "research_session_not_found", "Research session not found.");
    await this.reconcileSession(project, sessionId);
    const baselineCursor = await this.captureBaseline(project, sessionId);
    const selected = session.mode === "specialist"
      ? {
          effectiveAgentId: session.agentId,
          effectiveAgentVersion: session.agentVersion,
          effectiveRuntimeAgent: session.runtimeAgent,
          effectiveRouteReason: "session-binding",
        }
      : { effectiveAgentId, effectiveAgentVersion, effectiveRuntimeAgent, effectiveRouteReason };
    const reservation = await this.reserveRun(project, session, { baselineCursor, dispatchId, automated, estimatedMinutes, question, ...selected });
    const record = reservation.run;
    if (!reservation.owner) return this.existingDispatch(project, record);
    this.projects.set(`${project.userId}:${project.id}`, project);
    // The brief, before the prompt goes out, so it is held whatever happens
    // next. This is the authoritative copy and the only one the gate reads.
    if (briefText) {
      await this.keepBrief(project, record.id, briefText);
      await this.writeWorkspaceBrief(project, briefText);
    }
    try {
      const result = await sendPrompt(session, record);
      if (result?.accepted === false) {
        throw new HttpError(502, "runtime_prompt_rejected", "Runtime rejected the prompt before accepting it.");
      }
      const accepted = await this.markDispatch(project, record.id, "accepted");
      this.clinicalRepairSenders.set(record.id, async (repairText) => {
        const updated = await this.recordKernelRequest(project, record.id, randomId("req_"));
        return sendPrompt(session, updated, repairText);
      });
      this.scheduleMonitor(project, record.id);
      return accepted;
    } catch (error) {
      // Refused before the prompt was sent: nothing is running, so nothing may
      // be left looking as if it were. A capacity or lock refusal (429 / 423)
      // is raised before any kernel call; treating it as "unknown" left a run
      // `running` behind the 429 the person was shown, and `agent_run_active`
      // then refused their retry on the same session (E §9.3).
      if (error?.code === "runtime_prompt_rejected" || error?.definitivelyRejected === true
        || (error instanceof HttpError && (error.status === 429 || error.status === 423))) {
        await this.markDispatch(project, record.id, "rejected");
        await this.finishInternal(project, record.id, {
          status: "failed",
          errorCode: typeof error?.code === "string" ? error.code : "runtime_prompt_rejected",
          artifacts: [],
        });
      } else {
        await this.markDispatch(project, record.id, "unknown");
        this.scheduleMonitor(project, record.id);
      }
      throw error;
    } finally {
      this.dispatchOwners.delete(record.id);
    }
  }

  /** Append to what a run tells its reader, after the delivery decision.
   *
   *  A separate ledger event rather than a rewrite of the terminal one: the
   *  terminal event is the delivery decision and stays exactly as it was
   *  written. This can add notices and can admit that a layer went unchecked;
   *  it cannot move a run's status, error code or artifacts, and folding is
   *  order-independent, so a notice that lands before the run finishes reads
   *  the same as one that lands after.
   *  @param {any} project @param {string} rawRunId @param {any} notices
   *  @param {{ unchecked?: boolean }} options */
  async appendQualityNotices(project, rawRunId, notices, { unchecked = false } = {}) {
    const runId = safeId(rawRunId, "agent run id");
    const normalized = normalizeQualityNotices(notices);
    if (normalized.length === 0) return null;
    return withProjectStorageMutation(project, async () => {
      const events = parseEvents(await readLedgerText(project, this.maxBytes));
      const current = foldEvents(events).get(runId);
      if (!current) return null;
      const event = {
        event: "notice",
        id: runId,
        at: this.now().toISOString(),
        qualityNotices: normalized,
        ...(unchecked ? { verification: "unchecked" } : {}),
      };
      const text = serializeNext(events, event, this.maxBytes);
      await writeFileAtomicNoFollow(project.rootDir, ledgerFile(project), text, { encoding: "utf8", mode: 0o600 });
      const noticed = foldEvents([...events, event]).get(runId);
      this.notifyState(project, noticed);
      return noticed;
    });
  }

  /**
   * What a run is called and what it asked, when either is learned after the
   * run started (C3).
   *
   * One `notice` event carries both, which an older control plane folds as a
   * notice with nothing in it. A title from anywhere but the researcher never
   * replaces theirs, and a question is filled once: this returns the run
   * unchanged, without writing, when there is nothing it may change.
   * @param {any} project @param {string} rawRunId
   * @param {{ title?: string, titleSource?: 'auto'|'user', question?: string }} labels
   */
  async recordRunLabels(project, rawRunId, { title, titleSource, question } = {}) {
    const runId = safeId(rawRunId, "agent run id");
    const named = title === undefined ? null : normalizeRunTitle(title);
    if (title !== undefined && !named) throw new HttpError(400, "invalid_payload", `A run title is one line of 1 to ${maxRunTitle} characters.`);
    if (named && titleSource !== "auto" && titleSource !== "user") throw invalid("A run title needs its source.");
    const asked = question === undefined ? null : questionPreview(question);
    return withProjectStorageMutation(project, async () => {
      const events = parseEvents(await readLedgerText(project, this.maxBytes));
      const current = foldEvents(events).get(runId);
      if (!current) throw new HttpError(404, "agent_run_not_found", "The run is unavailable.");
      const retitle = named && (current.titleSource !== "user" || titleSource === "user")
        && !(current.title === named && current.titleSource === titleSource);
      const fill = asked && current.question == null;
      if (!retitle && !fill) return current;
      const event = {
        event: "notice",
        id: runId,
        at: this.now().toISOString(),
        qualityNotices: [],
        ...(retitle ? { title: named, titleSource } : {}),
        ...(fill ? { question: asked } : {}),
      };
      const text = serializeNext(events, event, this.maxBytes);
      await writeFileAtomicNoFollow(project.rootDir, ledgerFile(project), text, { encoding: "utf8", mode: 0o600 });
      const labelled = foldEvents([...events, event]).get(runId);
      this.notifyState(project, labelled);
      return labelled;
    });
  }

  /**
   * Fills in, in the background, what a few runs with no question asked.
   *
   * A session typed into the kernel's own application is adopted before its
   * first message can be read, and a monitor that never runs (nothing to
   * grade) never reads it afterwards, so those runs were listed forever by a
   * placeholder. The list route calls this and does not wait: the answer goes
   * out as it stands, the ledger is filled from the session's own first user
   * message — read without waking a stopped runtime — and the next read shows
   * it. Bounded per call and per run, because a list is read often.
   * isolated: evimed_run_question_backfill_failures_total
   * @param {any} project @param {readonly Record<string, any>[]} runs @param {{ limit?: number }} [options]
   */
  backfillQuestions(project, runs, { limit = 3 } = {}) {
    const nowMs = this.now().getTime();
    const due = runs
      .filter((run) => run?.question == null && run?.sessionId
        && nowMs - (this.questionBackfills.get(run.id) ?? -Infinity) >= 10 * 60_000)
      .slice(0, limit);
    for (const run of due) {
      this.questionBackfills.set(run.id, nowMs);
      if (this.questionBackfills.size > 2_000) this.questionBackfills.delete(this.questionBackfills.keys().next().value);
      const pending = (async () => {
        const history = await this.readSessionHistory(project, run.sessionId, { wake: false });
        const asked = Array.isArray(history) ? firstUserText(run, history) : "";
        if (asked) await this.recordRunLabels(project, run.id, { question: asked });
      })().catch(() => {});
      this.backgroundLabels.add(pending);
      void pending.finally(() => this.backgroundLabels.delete(pending));
    }
  }

  /**
   * The run's own account of what it did, scoped to this run.
   *
   * `readRunStateProjection` already refuses another run's file, an
   * unparseable one, and — for a native-workflow run — one whose plan revision
   * or item identities do not match the tool calls this run actually made. The
   * terminal hook needs exactly that guarantee: it attributes method outcomes
   * to deliverables, and a projection belonging to a different run would
   * attribute them confidently to the wrong ones.
   *
   * Null for every unreadable state rather than a throw, because the only
   * caller runs beside a finished run's real work.
   * @param {any} project @param {Record<string, any>} run
   * @returns {Promise<Record<string, any> | null>}
   */
  async runWorkflowProjection(project, run) {
    try {
      const read = await readRunStateProjection(project, project.workspaceDir, run);
      return read.state === "read" ? (read.projection ?? null) : null;
    } catch {
      return null;
    }
  }

  /**
   * Record what a run left for the learning loop.
   *
   * Merge semantics, not replace: the row is a gauge, so the last one written
   * is the only one kept, and a caller that sent only `compaction` must not
   * erase the transcript receipt a different caller wrote a second earlier.
   * Four independent writers reach this — the terminal hook (transcript,
   * mounted methods, invoked methods), the repair loop (rounds), the event pump
   * (compaction) and the reconciler — and none of them holds the others' facts.
   *
   * Returns null rather than throwing for an unknown run: every caller is on a
   * best-effort path beside the run's real work, and none of them may be the
   * reason a run fails.
   * @param {any} project
   * @param {string} rawRunId
   * @param {{transcript?: any, methodsLoaded?: any[], methodsInvoked?: any[], mountedSkills?: string[], recalledMemories?: {id: string, kind?: string, scope?: string}[], appendRecalledMemories?: {id: string, kind?: string, scope?: string}[], repairRounds?: {content?: number, structural?: number}, compaction?: any[], appendCompaction?: any}} patch
   */
  async recordLearning(project, rawRunId, patch) {
    const runId = safeId(rawRunId, "agent run id");
    return withProjectStorageMutation(project, async () => {
      const events = parseEvents(await readLedgerText(project, this.maxBytes));
      const current = foldEvents(events).get(runId);
      if (!current) return null;
      const compaction = patch.appendCompaction
        ? [...(current.compaction ?? []), patch.appendCompaction]
        : patch.compaction;
      // What the run pulled in through the recall tool, added to what its
      // dispatch recalled: the 「本次用到的背景」 panel lists both, and a
      // conversation typed in the kernel's own window has only the first.
      // Merged inside the ledger's mutation, so two recalls at once both land.
      const recalled = patch.appendRecalledMemories
        ? [...(current.recalledMemories ?? []), ...patch.appendRecalledMemories]
          .filter((item, index, all) => all.findIndex((other) => other?.id === item?.id) === index)
        : patch.recalledMemories;
      const event = {
        event: "learning",
        id: runId,
        at: this.now().toISOString(),
        ...(patch.transcript ? { transcript: patch.transcript } : current.transcript ? { transcript: current.transcript } : {}),
        ...(patch.methodsLoaded ? { methodsLoaded: patch.methodsLoaded } : current.methodsLoaded ? { methodsLoaded: current.methodsLoaded } : {}),
        ...(patch.methodsInvoked ? { methodsInvoked: patch.methodsInvoked } : current.methodsInvoked ? { methodsInvoked: current.methodsInvoked } : {}),
        ...(patch.mountedSkills ? { mountedSkills: patch.mountedSkills } : current.mountedSkills ? { mountedSkills: current.mountedSkills } : {}),
        // Which durable memories this dispatch actually recalled.
        //
        // The recall happened at dispatch and then existed only as a file in
        // the workspace (`memory.md`), so a researcher reading an answer had no
        // way to see what the platform had used about them, and a support
        // question about "why did it assume that" could only be answered by
        // reading a container's filesystem (2026-09-16 review, M4③). Recorded
        // like `mountedSkills` and for the same reason: something the ledger
        // has not recorded cannot be told apart from something that never
        // happened.
        //
        // Normalized on the way IN, not only on the way out. Folding drops the
        // extra keys when the ledger is read, but the event is what gets
        // written to `runs.jsonl` — so a caller handing over whole memory rows
        // would put their values in a file in the project workspace, where
        // deleting the memory would not delete them.
        ...(recalled
          ? { recalledMemories: normalizeRecalledMemories(recalled) ?? [] }
          : current.recalledMemories ? { recalledMemories: current.recalledMemories } : {}),
        ...(patch.repairRounds
          ? { repairRounds: { content: patch.repairRounds.content ?? 0, structural: patch.repairRounds.structural ?? 0 } }
          : current.repairRounds ? { repairRounds: current.repairRounds } : {}),
        ...(compaction ? { compaction } : {}),
      };
      // Nothing but the timestamp to write means nothing to write.
      if (Object.keys(event).length <= 3) return current;
      const text = serializeNext(events, event, this.maxBytes);
      await writeFileAtomicNoFollow(project.rootDir, ledgerFile(project), text, { encoding: "utf8", mode: 0o600 });
      const updated = foldEvents([...events, event]).get(runId);
      this.notifyState(project, updated);
      return updated;
    });
  }

  /**
   * Persist the repair counts the loop has been keeping in memory.
   *
   * The five repair maps on this store are lost on a control-plane restart,
   * which is how an adopted run silently gets a fresh repair budget. Writing
   * the count each time it moves does not fix that — the budget still lives in
   * memory — but it does make the number durable for the distiller, which needs
   * "this package took two rounds to pass" as its strongest signal that
   * something is worth learning.
   * @param {any} project @param {string} runId
   */
  async recordRepairRounds(project, runId) {
    const content = this.clinicalRepairAttempts.get(runId) ?? 0;
    const structural = this.clinicalStructuralRepairAttempts?.get(runId) ?? 0;
    if (!content && !structural) return null;
    // isolated: evimed_agent_run_learning_write_failed_total
    return this.recordLearning(project, runId, { repairRounds: { content, structural } }).catch(() => null);
  }

  /** Put a read-only copy of the brief in the workspace.
   *
   *  The brief used to exist only inside the prompt, which meant a run could
   *  only work from what was still in its context: after an hour of retrieval
   *  the fifth question is a recollection. A file on disk it can re-read is not.
   *
   *  It is a copy, not the source of truth. The delivery gate reads the
   *  server's in-memory copy and never this one, because a run that supplies
   *  its own brief is setting its own exam; this file exists so the run — and
   *  the run-side preflight — can see what was asked. The gate compares the two
   *  and says so if they differ.
   *
   *  Failure to write is not a reason to refuse a dispatch: the brief is still
   *  in the prompt and still on the run record.
   *  @param {any} project @param {string} briefText */
  async writeWorkspaceBrief(project, briefText) {
    try {
      await writeFileAtomicNoFollow(
        project.workspaceDir,
        path.join(project.workspaceDir, workspaceBriefPath),
        briefText,
        { encoding: "utf8", mode: 0o444 },
      );
    } catch { /* advisory copy only; the authoritative one is on the run record */ }
  }

  /**
   * Where a run's brief is kept: beside the ledger, outside the workspace the
   * run can write and outside the ledger's 1 MiB ceiling (briefs run to
   * several thousand characters), readable by this process alone.
   * @param {any} project @param {string} runId
   */
  briefFile(project, runId) {
    return path.join(project.metaDir, "briefs", `${safeId(runId, "agent run id")}.txt`);
  }

  /**
   * Holds the brief for the delivery gate, and keeps it durably (0600).
   *
   * It used to live only in this process's memory, so a control-plane restart
   * mid-run judged the package without it: the question-scoped clinical safety
   * rules — the pharmacist-authored layer — silently did not run for that run
   * (2026-09-18 review, E §9.1). A failed write is said and not fatal: the
   * in-memory copy still serves the gate while this process lives.
   * @param {any} project @param {string} runId @param {string} briefText
   */
  async keepBrief(project, runId, briefText) {
    this.dispatchedBriefs.set(runId, briefText);
    try {
      await writeFileAtomicNoFollow(project.rootDir, this.briefFile(project, runId), briefText, { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      process.stderr.write(`run brief not kept for ${runId}: ${typeof error?.code === "string" ? error.code : "write_failed"}\n`);
    }
  }

  /**
   * The brief the gate reads: the one in memory, else the one kept beside the
   * ledger — which is how a restarted control plane gets it back.
   * @param {any} project @param {string} runId @returns {Promise<string | null>}
   */
  async dispatchedBrief(project, runId) {
    const held = this.dispatchedBriefs.get(runId);
    if (held != null) return held;
    try {
      const kept = await readTextFileNoFollow(project.rootDir, this.briefFile(project, runId), "");
      if (kept) {
        this.dispatchedBriefs.set(runId, kept);
        return kept;
      }
    } catch { /* unreadable is missing: the gate says it judged without it */ }
    return null;
  }

  /** The brief leaves with the run's delivery decision. @param {any} project @param {string} runId */
  async dropBrief(project, runId) {
    this.dispatchedBriefs.delete(runId);
    try {
      const file = this.briefFile(project, runId);
      await assertNoSymlinkPath(project.rootDir, file, { allowMissingTail: true });
      await rm(file, { force: true });
    } catch { /* isolated: evimed_run_brief_remove_failures_total — a stale brief is bytes, not a wrong verdict */ }
  }

  async markDispatch(project, rawRunId, status) {
    const runId = safeId(rawRunId, "agent run id");
    if (!["accepted", "unknown", "rejected"].includes(status)) throw new Error("Invalid dispatch status.");
    return withProjectStorageMutation(project, async () => {
      const events = parseEvents(await readLedgerText(project, this.maxBytes));
      const runs = foldEvents(events);
      const current = runs.get(runId);
      if (!current) throw new HttpError(404, "agent_run_not_found", "Agent run not found.");
      if (current.status !== "running" || current.dispatchStatus !== "dispatching") return current;
      const event = { event: "dispatch", id: runId, status };
      const text = serializeNext(events, event, this.maxBytes);
      await writeFileAtomicNoFollow(project.rootDir, ledgerFile(project), text, { encoding: "utf8", mode: 0o600 });
      const dispatched = foldEvents([...events, event]).get(runId);
      this.notifyState(project, dispatched);
      return dispatched;
    });
  }

  /**
   * The verdict a run leaves behind, read from the workspace rather than from
   * the container.
   *
   * `delivery-receipt.json` is written by exactly one caller — the run-side
   * gate, and only when it accepts — and names every delivered file with its
   * sha256. That makes it the one thing a control plane can trust after the
   * runtime is gone: the files it names can be checked against the digests it
   * carries, so "these are the artifacts that were graded" is provable rather
   * than assumed.
   *
   * @param {Record<string, any>} project @param {Record<string, any>} run
   * @returns {Promise<Record<string, any>|null>}
   */

  async finishFromDurableRecord(project, run) {
    if (run.nativeTurn) run = (await this.list(project)).find((item) => item.id === run.id) ?? run;
    const receipt = await readDeliveryReceipt(project, run);
    if (run.nativeWorkflow?.completion?.ok === false) {
      const verified = receipt ? await verifiedReceiptArtifacts(project, receipt) : null;
      return this.finishInternal(project, run.id, {
        status: "failed", errorCode: "specialist_deliverable_not_accepted",
        artifacts: verified && !verified.mismatched.length ? verified.artifacts : [],
        qualityNotices: nativeWorkflowNotices(run.nativeWorkflow),
      });
    }
    if (!receipt) {
      // Nothing durable: the runtime really did stop before it delivered.
      // Whatever the projection saw of it travels with the verdict, because a
      // run that died mid-flight is exactly when its last recorded state is
      // worth having.
      const projection = await readRunStateProjection(project, project.workspaceDir, run);
      // Deduplicated against what the run already admitted while it was alive.
      // `publishRunProjection` puts these same lines on the ledger as they
      // appear, so re-adding the whole set here reported every admission twice
      // for a run the monitor had been watching, and not at all for one that
      // died before its first poll. The set is the same one that path keeps.
      const admitted = this.projectionAdmissions.get(run.id) ?? new Set();
      const notices = projection.state === "read"
        ? runSideNotices(projection.projection ?? {}).filter((notice) => !admitted.has(notice.text))
        : [];
      // Two failures end here and they are not the same failure. A run cut off
      // mid-flight lost its work; a run that wrote every file its contract asks
      // for and never submitted any of them for grading produced a complete
      // package and stopped short of asking for a verdict. Both leave a gone
      // container and no receipt, so reported under one code the second reads
      // as infrastructure trouble and its actual cause is invisible — which is
      // what run 7 looked like: seven deliverable files on disk, the plan item
      // still `planned`, `attempts: 0`, and a ledger entry saying the runtime
      // stopped.
      //
      // Decided from the record, never from a guess: the projection has to say
      // a deliverable was planned and never attempted, and the files it names
      // have to actually be there.
      const unsubmitted = await unsubmittedDeliverables(project, projection);
      // A third cause ends here, and it is neither of the two above: a run that
      // submitted its package again and again and was rejected every time. Its
      // items are `submitted` with a positive attempt count, so
      // `unsubmittedDeliverables` does not see them, and it was reported
      // `runtime_stopped` — which reads as infrastructure trouble for a run that
      // worked for an hour and did not meet the contract. The live path already
      // says this; the durable path has to say the same thing about the same
      // fact.
      const rejected = projection.state === "read" && Array.isArray(projection.projection?.plan?.items)
        ? projection.projection.plan.items.filter((item) => item?.status !== "accepted" && Number(item?.attempts ?? 0) > 0)
        : [];
      // Before the terminal state, not after: a settled run closes its own
      // stream (`runIsSettled` in the browser's `useRunStream`), so a frame
      // published after `finishInternal` reaches nobody who was watching.
      if (projection.state === "read") this.publishDeliverables(project, run, projection.projection ?? {}, null);
      return this.finishInternal(project, run.id, {
        status: "failed",
        errorCode: projection.state === "unattributed" ? "specialist_deliverable_not_accepted" : unsubmitted.length
          ? "runtime_deliverable_never_submitted"
          : rejected.length ? "specialist_deliverable_not_accepted" : "runtime_stopped",
        artifacts: [],
        qualityNotices: [
          ...(projection.state === "unattributed" ? [unattributedNotice()] : []),
          ...unsubmitted.map((entry) => {
            const sentence = `交付物「${entry.id}」的文件已经写好（${entry.files} 个），但从未提交校验，因此没有通过质量门。`;
            return runNotice("run_deliverable_never_submitted", sentence, { detail: sentence });
          }),
          ...(unsubmitted.length ? [] : rejected.map((entry) => {
            const sentence = `交付物「${entry.id}」提交了 ${Number(entry.attempts ?? 0)} 次，每次都被契约校验拒绝，因此产物未经质量门。`;
            return runNotice("run_deliverable_rejected_every_time", sentence, { detail: sentence });
          })),
          ...notices,
        ].slice(0, 20),
      });
    }
    const verifiedReceipt = await verifiedReceiptArtifacts(project, receipt);
    const { artifacts, mismatched } = verifiedReceipt;
    if (mismatched.length) {
      // A file that does not match the digest it was graded under is not the
      // file that was graded. Refusing is the only honest answer: the
      // alternative is delivering something no gate has seen.
      //
      // No amendment on this path, unlike the live one. This runs when the
      // container is gone, so the gate cannot be re-run over the bytes on disk
      // and nothing has judged them — which is precisely the case the receipt
      // exists to catch.
      //
      // Unless the files moved under a revision the server authorized: then
      // the run ended with its revision not accepted, which is what it says.
      const drift = await revisionDrift(project, verifiedReceipt);
      if (drift.explained) {
        return this.finishInternal(project, run.id, {
          status: "failed",
          errorCode: "specialist_deliverable_not_accepted",
          artifacts: [],
          qualityNotices: [revisionNotAcceptedNotice(verifiedReceipt, drift.revising)],
        });
      }
      return this.finishInternal(project, run.id, {
        status: "failed",
        errorCode: "specialist_receipt_digest_mismatch",
        artifacts: [],
        qualityNotices: mismatched.slice(0, 10).map((entry) => runNotice("run_receipt_mismatch",
          `delivery-receipt.json names ${entry} with a digest the file no longer matches, and the runtime is gone so no gate can judge the current bytes`,
          { file: entry, detail: "回执记下的文件在通过之后被改动，运行已经结束，改动后的内容无法再核验。" })),
      });
    }
    const delivered = await readRunStateProjection(project, project.workspaceDir, run);
    this.publishDeliverables(project, run, delivered.state === "read" ? delivered.projection ?? {} : {}, receipt);

    return this.finishInternal(project, run.id, {
      status: "succeeded",
      errorCode: null,
      artifacts,
      qualityNotices: [
        ...receiptNotices(receipt.entries, delivered.state === "read" ? delivered.projection ?? null : null),
        // The plan, not just the receipt. A receipt can only speak for what it
        // holds an entry for, so on its own it cannot report an absence.
        ...droppedDeliverableNotices(delivered, receipt),
      ].slice(0, 20),
    });
  }

  /**
   * What the record keeps about a run's plan once it ends.
   *
   * The plan is read the way a live run's is — the plan index's own states,
   * `accepted` gated on a witnessed acceptance or a verified receipt — because
   * the stricter terminal reading rebuilds every item from the parent's own
   * tool calls, and a delegated item's submissions are never among them: it
   * would record 0 attempts for an item a child submitted twice. The outcome
   * then decides what each item became (`runDeliverables`).
   *
   * @param {any} project @param {string} runId
   * @param {{ status: string, artifacts: string[], unverifiedArtifacts: string[] }} normalized
   */
  async finalRunFacts(project, runId, normalized) {
    const run = (await this.list(project)).find((item) => item.id === runId);
    if (!run || run.status !== "running") return null;
    const read = await readRunStateProjection(project, project.workspaceDir, run);
    const projection = read.state === "read" ? read.projection ?? null : null;
    const receipt = await readDeliveryReceipt(project, run).catch(() => null);
    const deliverables = runDeliverables(projection, receipt, {
      status: normalized.status,
      artifacts: normalized.artifacts,
      unverifiedArtifacts: normalized.unverifiedArtifacts,
    });
    const matrices = [...normalized.artifacts, ...normalized.unverifiedArtifacts]
      .filter((file) => file.endsWith("clinical-evidence-matrix.json"));
    const claims = matrices.length ? await matrixClaimSummary(project, matrices, null) : null;
    const tracker = this.progressTracker(runId);
    tracker.project ??= project;
    tracker.startedAt ??= run.startedAt;
    if (projection) tracker.projection = projection;
    if (claims?.total) tracker.matrix = { ...claims, at: this.now().getTime() };
    const composed = this.composeProgress(tracker, run, deliverables);
    // A run that has ended has no child still working: the last observation
    // before a cancel said `running`, and the finished record kept saying it.
    const closed = normalized.status === "succeeded" ? "done" : "failed";
    const progress = composed && Array.isArray(composed.children)
      ? { ...composed, children: composed.children.map((/** @type {any} */ child) => (child?.state === "running" || child?.state === "idle" ? { ...child, state: closed } : child)) }
      : composed;
    return {
      deliverables,
      claimSummary: claims?.total ? { total: claims.total, verified: claims.verified, unverified: claims.unverified } : null,
      // A snapshot only of what was observed: a run this process never
      // watched (finished from the durable record after a restart) keeps the
      // last one its ledger holds rather than a picture of zero calls.
      snapshot: tracker.sessions.size > 0 ? withoutDeliverables(progress) : null,
      progress,
      tracker,
    };
  }

  async finishInternal(project, rawRunId, terminal) {
    const runId = safeId(rawRunId, "agent run id");
    if (!terminalStatuses.has(terminal.status)) throw new Error("Invalid internal terminal status.");
    const normalized = {
      status: terminal.status,
      errorCode: sanitizeErrorCode(terminal.errorCode),
      // The kernel's own finer reason, when it gave one. Kept beside the code
      // rather than folded into it: `runtime_session_error` is a stable string
      // other things key on, and a context overflow is a different remedy from
      // a session fault -- which the ledger could not distinguish at all.
      ...(sanitizeErrorCode(terminal.errorSubCode) ? { errorSubCode: sanitizeErrorCode(terminal.errorSubCode) } : {}),
      ...(CONNECTOR_CREDENTIAL_IDS.has(terminal.missingCredential) ? { missingCredential: terminal.missingCredential } : {}),
      artifacts: normalizeArtifacts(terminal.artifacts),
      /** Files the run wrote that no gate accepted. Empty is "none"; the field
       *  is always present so a reader never has to treat absent as unknown. */
      unverifiedArtifacts: normalizeArtifacts(terminal.unverifiedArtifacts),
      verification: normalizeVerification(terminal.verification),
      qualityNotices: normalizeQualityNotices(terminal.qualityNotices),
      ...(terminal.status === "canceled" && (terminal.canceledBy === "user" || terminal.canceledBy === "platform")
        ? { canceledBy: terminal.canceledBy } : {}),
    };

    // Delivery is a label, not a switch.
    //
    // This is the one funnel every terminal path in this file goes through, and
    // it is deliberately here rather than at the fifteen call sites that build
    // a `terminal`: a refusal branch added next month gets this for free, and
    // the alternative — remembering, at each of fifteen sites, that a verdict is
    // not a reason to hide the work — is the arrangement that produced the
    // number below.
    //
    // In production over 179 finished runs, 28 ended gate-refused with
    // `artifacts: []` at p90 58 minutes. The most recent was a complete
    // nine-file clinical package. Every one of those files was on disk, in the
    // workspace, at the moment the ledger recorded that the run had produced
    // nothing — and the browser rendered 「暂无交付物。」 over the top of them.
    // From the researcher's side that is indistinguishable from an hour of work
    // being deleted, which is exactly what they reported it as.
    //
    // A separate field, not `artifacts`.
    //
    // `artifacts` means "the gate accepted these", and five modules rely on
    // exactly that: `server.mjs` picks the autopilot's verification result out
    // of it, `autopilotService` reads `agenda-delta.json` out of it, and
    // `learningRuntime` and `sourceUnderstandingRuntime` read a bounded run's
    // output out of it. Widening it would have made an ungraded file readable
    // as a verified result — the same defect class as an autopilot verification
    // that was never sound — so the fix would have bought the researcher their
    // files at the price of the guarantee that makes those files worth having.
    //
    // So the verdict is untouched, `artifacts` keeps its meaning, and what the
    // run wrote is stated as its own fact for the surfaces that show a person
    // their work. A run that genuinely wrote nothing still reports nothing,
    // because this reads the workspace instead of asserting.
    if (normalized.status !== "succeeded" && normalized.artifacts.length === 0) {
      // Only what this run wrote. Unfiltered, the metformin run cancelled on
      // 2026-09-19 two minutes in "recovered" 34 files an aspirin run had
      // written two days earlier in the same workspace, and its claim summary
      // counted their 284 claims.
      const started = Date.parse((await this.list(project).catch(() => [])).find((item) => item.id === runId)?.startedAt ?? "");
      const recovered = await writtenDeliverableFiles(project, Number.isFinite(started) ? started : null).catch(() => []);
      if (recovered.length > 0) {
        normalized.unverifiedArtifacts = normalizeArtifacts(recovered);
        normalized.qualityNotices = normalizeQualityNotices([
          ...normalized.qualityNotices,
          runNotice("run_unverified_delivery", UNVERIFIED_DELIVERY_NOTICE, { detail: UNVERIFIED_DELIVERY_NOTICE }),
        ]);
      }
    }
    // The plan as the run ends it, what its claims came to, and its last
    // progress picture — computed before the terminal write and published
    // ahead of it, because a watching tab closes its stream on the terminal
    // `run/state` and a frame sent after that reaches nobody. Best effort: a
    // record the run cannot be described in is still a finished run.
    const facts = await this.finalRunFacts(project, runId, normalized).catch(() => null);
    if (facts?.tracker && facts.progress) this.publishProgress(project, runId, facts.tracker, facts.progress, { force: true });
    const outcome = await withProjectStorageMutation(project, async () => {
      const events = parseEvents(await readLedgerText(project, this.maxBytes));
      const runs = foldEvents(events);
      const current = runs.get(runId);
      if (!current) throw new HttpError(404, "agent_run_not_found", "Agent run not found.");
      if (current.status !== "running") return { run: current, transitioned: false };
      const finishedAt = current.nativeTurn && terminal.finishedAt
        ? storedTimestamp(terminal.finishedAt, "finishedAt") : this.now().toISOString();
      const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(current.startedAt));
      const event = {
        event: "finished",
        id: runId,
        ...normalized,
        finishedAt,
        durationMs,
        ...(facts?.deliverables?.length ? { deliverables: facts.deliverables } : {}),
        ...(facts?.claimSummary ? { claimSummary: facts.claimSummary } : {}),
        ...(facts?.snapshot ? { snapshot: facts.snapshot } : {}),
      };
      const text = serializeNext(events, event, this.maxBytes);
      await writeFileAtomicNoFollow(project.rootDir, ledgerFile(project), text, { encoding: "utf8", mode: 0o600 });
      const finished = foldEvents([...events, event]).get(runId);
      this.notifyState(project, finished);
      return { run: finished, transitioned: true };
    });
    const result = outcome.run;
    if (result.status !== "running") {
      this.dispatchOwners.delete(runId);
      this.clinicalRepairAttempts.delete(runId);
      this.clinicalStructuralRepairAttempts.delete(runId);
      this.clinicalRepairBaselineCursors.delete(runId);
      this.clinicalRepairSenders.delete(runId);
      this.clinicalRepairReportSizes.delete(runId);
      // The projection memories are per-run gauges, not a record: a finished
      // run's digests and admissions would otherwise be held for the life of
      // the process.
      this.projectionDigests.delete(runId);
      this.deliverableDigests.delete(runId);
      this.projectionAdmissions.delete(runId);
      this.projectionNoticed.delete(runId);
      const kernelKey = `${project.userId}\0${project.id}\0${runId}`;
      this.kernelActivities.delete(kernelKey);
      this.childKernelHeads.delete(kernelKey);
      this.childKernelActivities.delete(kernelKey);
      // The gate has already run by the time a run reaches a terminal state,
      // so the brief has done its work; keeping it would grow with every run.
      await this.dropBrief(project, runId);
      const tracker = this.progressTrackers.get(runId);
      if (tracker?.timer) clearTimeout(tracker.timer);
      this.progressTrackers.delete(runId);
    }
    if (outcome.transitioned) {
      try {
        await this.onRunFinished(project, result);
      } catch (error) {
        try {
          await this.onRunFinishedError(error, project, result);
        } catch { /* terminal ledger state must remain authoritative */ }
      }
    }
    return result;
  }

  /** @param {any} project @param {string} rawSessionId @param {{ by?: 'user' | 'platform' | null }} [options] */
  async cancelSession(project, rawSessionId, { by = null } = {}) {
    const sessionId = safeId(rawSessionId, "research session id");
    const run = (await this.list(project)).find(
      (item) => item.sessionId === sessionId && item.status === "running",
    );
    if (!run) return null;
    return this.cancelRunRecord(project, run, { by });
  }

  /**
   * Stops one run's observation and records it cancelled (C3). Idempotent: a
   * run already over is returned as it is. The kernel side — its sessions —
   * is the caller's, because only the caller knows which it may reach.
   * @param {any} project @param {string} rawRunId @param {{ by?: 'user' | 'platform' | null }} [options]
   */
  async cancelRun(project, rawRunId, { by = null } = {}) {
    const runId = safeId(rawRunId, "agent run id");
    const run = (await this.list(project)).find((item) => item.id === runId);
    if (!run) throw new HttpError(404, "agent_run_not_found", "The run is unavailable.");
    if (run.status !== "running") return run;
    return this.cancelRunRecord(project, run, { by });
  }

  /**
   * Every child session this control plane knows a run to have: its plan's
   * deliverables, its last progress aggregate, and what the live tracker
   * observed. Candidates for the caller to act on, bounded.
   * @param {Record<string, any>} run @returns {string[]}
   */
  knownChildSessions(run) {
    const tracker = this.progressTrackers.get(run.id);
    const ids = [
      ...(Array.isArray(run.deliverables) ? run.deliverables : []).map((item) => item?.childSessionId),
      ...(Array.isArray(run.progress?.children) ? run.progress.children : []).map((child) => child?.childSessionId),
      ...(tracker ? [...tracker.children, ...tracker.kernelChildren.map((child) => child.sessionId)] : []),
    ];
    return [...new Set(ids.filter((id) => typeof id === "string" && id && id !== run.sessionId))].slice(0, 64);
  }

  /** @param {any} project @param {Record<string, any>} run @param {{ by?: 'user' | 'platform' | null }} options */
  async cancelRunRecord(project, run, { by = null }) {
    const monitor = this.monitors.get(run.id);
    monitor?.cancel();
    let finished;
    try {
      finished = await this.finishInternal(project, run.id, {
        status: "canceled",
        errorCode: "runtime_canceled",
        artifacts: [],
        ...(by ? { canceledBy: by } : {}),
      });
    } finally {
      // Cancellation is complete only after the observer has left every read
      // and storage mutation. Keep this in finally: even a failed terminal
      // ledger write must not return control while the observer can still
      // recreate paths in a project the caller is about to remove.
      await monitor?.promise?.catch(() => {});
    }
    return finished;
  }

  async reconcileSession(project, sessionId, runId = null) {
    let targetRunId = runId;
    if (!targetRunId) {
      const events = parseEvents(await readLedgerText(project, this.maxBytes));
      targetRunId = [...foldEvents(events).values()].find((candidate) => (
        candidate.sessionId === sessionId && candidate.status === "running"
      ))?.id ?? null;
    }
    if (!targetRunId) return null;
    const key = JSON.stringify([project.userId, project.id, sessionId, targetRunId]);
    const existing = this.reconciles.get(key);
    if (existing) return existing;
    const active = this.reconcileSessionOnce(project, sessionId, targetRunId).finally(() => {
      if (this.reconciles.get(key) === active) this.reconciles.delete(key);
    });
    this.reconciles.set(key, active);
    return active;
  }

  async reconcileSessionOnce(project, sessionId, runId = null) {
    const events = parseEvents(await readLedgerText(project, this.maxBytes));
    const runs = foldEvents(events);
    let run = [...runs.values()].find((item) => item.sessionId === sessionId && item.status === "running" && (!runId || item.id === runId));
    if (!run) return null;
    const started = events.find((event) => event.event === "started" && event.id === run.id);
    const baselineCursor = started?.baselineCursor ?? null;
    let history;
    try {
      history = await this.readSessionHistory(project, sessionId, { wake: false });
    } catch (error) {
      if (error?.code === "runtime_not_running") {
        // A gone container is not a verdict.
        //
        // Everything this function derives came from a transcript that exists
        // only while the runtime is alive, so the end of a run — the moment
        // the kernel goes idle and the container exits — was read as the run
        // having failed. The first real end-to-end run was recorded
        // `failed / artifacts 0` with a complete, valid deliverable set on
        // disk beside the ledger entry that said there was none.
        //
        // The durable record is what decides now: the receipt the run-side
        // gate writes when it accepts a package, and the run-state projection
        // beside it. Only when neither exists is a vanished runtime still a
        // failure, and it is reported as one that says so.
        return this.finishFromDurableRecord(project, run);
      }
      return run;
    }
    if (!Array.isArray(history)) return run;
    history = runHistory(run, history);
    if (run.nativeTurn) {
      run = await this.recordNativeWorkflow(project, run, history);
      if (run.status !== "running") return run;
    }
    const ownsTurns = Boolean(run.nativeTurn) || history.some((message) => actualUserMessage(message) && (run.kernelRequestIds ?? []).includes(message.info?.sourceRequestId));
    if (run.dispatchId && ownsTurns && !history.some((message) => actualUserMessage(message) && message.info?.sourceRequestId === run.kernelRequestIds?.at(-1))) return run;
    const ownEnd = history.at(-1)?.info?.turnEnd;
    if (ownsTurns && !ownEnd) return run;
    const baselineIndex = ownsTurns && !run.nativeTurn ? -1 : baselineCursor == null
      ? -1
      : history.findIndex((message) => messageId(message) === baselineCursor);
    if (baselineCursor != null && baselineIndex < 0 && !ownsTurns) return run;
    const allAssistants = history
      .slice(baselineIndex + 1)
      .filter((message) => messageId(message) && messageRole(message) === "assistant" && assistantFinished(message));
    const delegated = await readDelegatedAssistantMessages(project, allAssistants, this.readSessionHistory, sessionId);
    const delegatedAssistants = delegated.assistants;
    const allRunAssistants = [...allAssistants, ...delegatedAssistants];
    const repairBaselineCursor = this.clinicalRepairBaselineCursors.get(run.id) ?? null;
    const repairBaselineIndex = repairBaselineCursor == null
      ? baselineIndex
      : history.findIndex((message) => messageId(message) === repairBaselineCursor);
    if (repairBaselineCursor != null && repairBaselineIndex < 0) return run;
    const assistants = history
      .slice(repairBaselineIndex + 1)
      .filter((message) => messageId(message) && messageRole(message) === "assistant" && assistantFinished(message));
    if (assistants.length === 0) {
      if (ownEnd?.code) return this.finishInternal(project, run.id, {
        ...terminalFromMessages([{ info: { error: { name: ownEnd.kind, code: ownEnd.code, subCode: ownEnd.subCode } } }, ...history]),
        artifacts: [],
        ...(run.nativeTurn && ownEnd.time ? { finishedAt: new Date(ownEnd.time).toISOString() } : {}),
      });
      return run;
    }
    if (!ownEnd) {
      try {
        if (await this.readSessionStatus(project, sessionId, { wake: false }) !== "idle") return run;
      } catch { return run; }
    }
    // A steering input can be the final message in a turn. The end belongs to
    // the turn, irrespective of the role of the message carrying it.
    const terminal = terminalFromMessages(ownEnd?.code
      ? [{ info: { error: { name: ownEnd.kind, code: ownEnd.code, subCode: ownEnd.subCode } } }, ...assistants]
      : assistants);
    let runtimeWorkspaceRoot;
    try {
      runtimeWorkspaceRoot = await this.runtimeWorkspaceRoot(project);
    } catch {
      runtimeWorkspaceRoot = project.workspaceDir;
    }
    const candidates = [...new Set(
      allRunAssistants.flatMap((message) => artifactCandidates(message, runtimeWorkspaceRoot)),
    )].slice(0, maxArtifacts).sort();
    let artifacts = await existingArtifacts(project, candidates, run, ownEnd?.time);
    // Whether the control plane itself ran the full evidence gate over the
    // bytes on disk and found nothing. Only then may a package the run never
    // got a receipt for go out without a mark.
    let serverGateClean = false;
    if (terminal.status === "succeeded" && run.effectiveAgentId) {
      let completion;
      try {
        const sourceArtifactProvenance = successfulEvidenceSourceArtifacts(allRunAssistants, runtimeWorkspaceRoot);
        completion = await requiredSpecialistArtifacts(
          project,
          run.nativeTurn ? { ...run, nativeTurn: { ...run.nativeTurn, endTime: ownEnd?.time } } : run,
          this.agentRegistry,
          sourceArtifactProvenance,
          allRunAssistants,
          // Only what this control plane dispatched: held in memory, and kept
          // beside the ledger so a restart does not lose it. Never the copy in
          // the workspace, which the run can write.
          await this.dispatchedBrief(project, run.id),
        );
      } catch {
        completion = { artifacts: [], errorCode: "specialist_contract_unavailable" };
      }
      // A provenance verdict reached without some of the run is said to be one.
      //
      // The check refuses a source path that no preserving tool reported in
      // this run, and "this run" is only what could be read of it. When a
      // delegated session could not be read, the file the refusal names may be
      // exactly one that session preserved — so the issue carries which
      // sessions were missing, and the run is not accused of typing a path it
      // may well have copied. The verdict itself is unchanged: this states what
      // the verdict rests on, it does not soften it.
      if (completion.errorCode === "specialist_evidence_provenance_failed" && delegated.unreadable.length > 0) {
        const partial = `This check could read only part of the run: ${delegated.unreadable.length} delegated session(s) `
          + `(${delegated.unreadable.slice(0, 4).join(", ")}) could not be read, so a source one of them preserved `
          + "is not visible here. Re-list the paths from the preserving tools' own output.";
        completion = {
          ...completion,
          qualityIssues: [...(completion.qualityIssues ?? []), partial],
          qualityFindings: [
            ...(completion.qualityFindings ?? []),
            runNotice("run_partial_read", partial, { detail: `有 ${delegated.unreadable.length} 个子任务的记录无法读取，这一项结论只基于能读到的部分。` }),
          ],
        };
      }
      artifacts = [...new Set([...artifacts, ...completion.artifacts])].sort();
      serverGateClean = !completion.errorCode && !completion.qualityUnchecked
        && (await this.agentRegistry)?.get?.(run.effectiveAgentId)?.completionChecks?.includes("evidenceClaimsTraceable") === true;
      if (completion.errorCode) {
        const repairSender = this.clinicalRepairSenders.get(run.id);
        // Read here and written below, across awaits. Safe because a run's
        // whole evaluation is single-flight (`reconcileSession` hands every
        // concurrent caller the evaluation already in flight), so no second
        // reader can see the count between the two — the lock this
        // read-modify-write needs, and the reason it has no other.
        const repairAttempts = this.clinicalRepairAttempts.get(run.id) ?? 0;
        // A rejection whose every issue is one structural fact — the deliverable
        // did not parse, or a required file is not there — teaches the run one
        // thing, not N. On 2026-08-26 a single JSON syntax error came back as 24
        // content findings and the package died with its repair budget spent on
        // one typo. Such a round is charged against a separate allowance.
        //
        // How it still terminates, since a structural cause can repeat unchanged:
        // the allowance is finite, fixed at construction and never refilled, so
        // once it is used up every further structural rejection is charged to the
        // ordinary repair budget exactly as before. The hard ceiling is
        // maxClinicalStructuralRepairAttempts + maxClinicalRepairAttempts rounds.
        // Same rule and same reason as the run-side `structuralAttemptAllowance`
        // in packages/socket/plugins/run-policy.mjs.
        const structuralAttempts = this.clinicalStructuralRepairAttempts.get(run.id) ?? 0;
        const structuralRound = completion.qualityStructural === true
          && structuralAttempts < this.maxClinicalStructuralRepairAttempts;
        // Every capability, not one.
        //
        // This required `effectiveAgentId === "clinical-evidence-synthesis"`,
        // so the other fifteen went straight to `failed` on a rejection the
        // clinical line repairs from — and the issues were never clinical:
        // `requiredSpecialistArtifacts` raises `specialist_required_output_missing`
        // and `_stale` for every capability that declares required outputs,
        // which is all of them. Nothing else here was capability-specific
        // either: the repair sender is registered for every dispatched run, and
        // `snapshotAcceptedPackageForRepair` already answers
        // `{revisionRequired: false}` when there is no accepted receipt to
        // preserve, which is the ordinary shape of a package that never got
        // past its required files.
        //
        // The prompt is chosen below, and that is the part that could not be
        // shared: the clinical one names its own deliverables by hand.
        //
        // Bounded by `qualityFileDeliverable`, which is the answer line's
        // absence rather than a capability name. An open-domain answer's
        // deliverable *is* the reply, so there is no package to revise and no
        // `evimed_submit_deliverable` to call — a repair prompt there would
        // order a run to patch files it was never asked to write. That line
        // already has the right behaviour for a citation it cannot vouch for:
        // deliver the answer and mark it unverified.
        const repairAgent = (await this.agentRegistry)?.get?.(run.effectiveAgentId);
        const fileDeliverable = repairAgent?.completionChecks?.includes("requiredOutputsExist") === true;
        const canRepair = fileDeliverable
          && repairableEvidencePackageErrorCodes.has(completion.errorCode)
          && Array.isArray(completion.qualityIssues)
          && completion.qualityIssues.length > 0
          && (structuralRound || repairAttempts < this.maxClinicalRepairAttempts)
          && typeof repairSender === "function";
        // Why a repair that was due did not happen, when it did not. The
        // package is still what it was, so it goes on to the same delivery
        // decision as one that was never sent back, with this said first.
        let repairNotRun = "";
        let repairNotRunCode = "";
        if (canRepair) {
          let revision;
          let repairRefusal = "";
          try {
            revision = await snapshotAcceptedPackageForRepair(project, run, await this.runtimeGeneration(project));
          } catch (error) {
            revision = null;
            repairNotRunCode = "specialist_evidence_repair_snapshot_failed";
            // With its reason. It said only the first half of this sentence,
            // and replaced the issues with it; finding the cause in a v8
            // ablation cell took a host inspection.
            repairNotRun = `The accepted package could not be preserved outside the runtime workspace before repair (${String(error?.message ?? error).slice(0, 300)}), so no revision was authorized.`;
          }
          if (revision) {
            if (structuralRound) this.clinicalStructuralRepairAttempts.set(run.id, structuralAttempts + 1);
            else this.clinicalRepairAttempts.set(run.id, repairAttempts + 1);
            // The count has to reach the ledger here rather than at the end: the
            // maps are deleted in `finishInternal`, so a run that finishes takes
            // the only record of how hard it was with it. It is also the signal
            // the distiller cares about most — a package that passed on the
            // second attempt is a lesson, one that passed first time is not.
            void this.recordRepairRounds(project, run.id);
            this.clinicalRepairBaselineCursors.set(run.id, messageId(assistants.at(-1)));
          // Record the report's size on the way into each repair. A repair that
          // answers with a whole-file write regenerates the report from what is
          // still in context — a compressed recollection after a long run — and
          // it comes back shorter without the run noticing. Two production
          // repairs cost 1,863 and 4,125 characters that way, while a run that
          // patched with edit ended slightly longer than it started.
          //
          // The notice has to survive the repair being accepted: this branch
          // returns early on success, so anything written to `terminal` here is
          // discarded. Keep it on the run and attach it when the run finishes.
            const beforeRepair = (await readRequiredFile(project, "clinical-evidence-report.md"))?.text?.length ?? 0;
            const sizes = this.clinicalRepairReportSizes.get(run.id) ?? [];
            if (beforeRepair > 0) this.clinicalRepairReportSizes.set(run.id, [...sizes, beforeRepair]);
            try {
              const previous = sizes.length > 0 && beforeRepair > 0 && beforeRepair < sizes[0]
                ? { startSize: sizes[0], currentSize: beforeRepair, lost: sizes[0] - beforeRepair }
                : null;
              const repair = await sendRepair(repairSender, run.effectiveAgentId === "clinical-evidence-synthesis"
                ? clinicalEvidenceRepairPrompt(completion.qualityIssues, previous, revision.revisionRequired)
                : specialistRepairPrompt(repairAgent, completion.qualityIssues, revision.revisionRequired), this.repairRetryDelaysMs);
              if (repair.accepted) return run;
              // Not silent: see `sendRepair`.
              repairRefusal = repairDispatchFailure(repair.failures);
            } catch (error) {
              repairRefusal = repairDispatchFailure([error]);
            }
            repairNotRunCode = "specialist_evidence_repair_failed";
            repairNotRun = repairRefusal;
          }
        }
        // The findings with their identity (C2), and why a repair that was due
        // did not happen, when it did not.
        const notices = [
          ...qualityFindingsOf(completion),
          ...(repairNotRun ? [runNotice("run_repair_not_dispatched", repairNotRun)] : []),
        ];
        if (completion.qualityDegradable) {
          // What the run wrote is delivered with what was found said about it,
          // never withheld for it (2026-09-17). Withholding is for a package
          // that cannot be handed over at all — see the branch below.
          terminal.status = "succeeded";
          terminal.errorCode = null;
          // A finding outranks an admission: "we checked and it did not hold
          // up" is the more serious of the two and is what the reader is shown.
          terminal.verification = completion.qualityUnverified
            ? "unverified"
            : completion.qualityUnchecked ? "unchecked" : null;
          terminal.qualityNotices = notices;
        } else {
          // Nothing to hand over (the capability's own output is absent or is a
          // previous run's), a contract this deployment no longer has, or a
          // preserved source whose bytes were changed after a tool wrote them.
          terminal.status = "failed";
          terminal.errorCode = repairNotRunCode || completion.errorCode;
          if (notices.length > 0) terminal.qualityNotices = notices;
        }
      } else {
        // Nothing withheld the package. A check may still have had something to
        // say — and a check may not have run at all, which is the one thing a
        // clean-looking delivery must not be allowed to hide.
        if (completion.qualityUnchecked) terminal.verification = "unchecked";
        if (Array.isArray(completion.qualityNotices) && completion.qualityNotices.length > 0) {
          terminal.qualityNotices = [...(terminal.qualityNotices ?? []), ...completion.qualityNotices];
        }
        // The model can spend its last local attempt, repair the returned issue
        // in place, and then discover that the ceiling prevents the corrected
        // bytes from writing a receipt. The server has just run the same domain
        // gate over those current bytes and accepted them; failing the run now
        // would discard a valid package over missing bookkeeping. Send one
        // bounded, same-run request whose only job is to submit unchanged bytes.
        const repairSender = this.clinicalRepairSenders.get(run.id);
        const repairAttempts = this.clinicalRepairAttempts.get(run.id) ?? 0;
        const currentReceipt = await readDeliveryReceipt(project, run);
        const projection = await readRunStateProjection(project, project.workspaceDir, run);
        const unaccepted = projection.state === "read" && Array.isArray(projection.projection?.plan?.items)
          ? projection.projection.plan.items.filter((item) => item?.status !== "accepted" && Number(item?.attempts ?? 0) > 0)
          : [];
        const canResubmit = run.effectiveAgentId === "clinical-evidence-synthesis"
          && completion.artifacts.length > 0
          && !currentReceipt
          && unaccepted.length > 0
          && repairAttempts < this.maxClinicalRepairAttempts
          && typeof repairSender === "function";
        if (canResubmit) {
          this.clinicalRepairAttempts.set(run.id, repairAttempts + 1);
          this.clinicalRepairBaselineCursors.set(run.id, messageId(assistants.at(-1)));
          const repair = await sendRepair(repairSender, clinicalEvidenceResubmitPrompt(unaccepted.map((item) => String(item.id))), this.repairRetryDelaysMs);
          if (repair.accepted) return run;
          const refusal = repairDispatchFailure(repair.failures);
          terminal.status = "failed";
          terminal.errorCode = "specialist_evidence_repair_failed";
          terminal.qualityNotices = [
            runNotice("run_resubmit_not_dispatched", "The server accepted the current package, but the run-side receipt resubmission could not be dispatched."),
            runNotice("run_resubmit_not_dispatched", refusal),
          ];
        }
      }
    }
    // Whatever the verdict, say if repair cost the report its substance. The
    // sizes were captured on the way into each repair round, so this compares
    // where the report started against where it ended rather than comparing two
    // different runs to each other.
    // The full history: `assistants` is filtered to assistant messages, so the
    // repair prompt that marks the start of a repair round is not in it.
    const rewrites = wholeFileRewritesDuringRepair(history);
    if (rewrites.length > 0) {
      terminal.qualityNotices = [
        ...(terminal.qualityNotices ?? []),
        runNotice("run_report_rewritten", `The report was replaced with the write tool ${rewrites.length} time(s) while repairing, instead of being patched with edit; a rewrite regenerates the report from context rather than from the evidence on disk.`, {
          detail: `修订时有 ${rewrites.length} 次整篇重写了报告，而不是按问题逐处修改；整篇重写凭记忆重生成内容，可能遗漏原有证据。`,
        }),
      ];
    }
    const repairSizes = this.clinicalRepairReportSizes.get(run.id) ?? [];
    if (repairSizes.length > 0) {
      const finalSize = (await readRequiredFile(project, "clinical-evidence-report.md"))?.text?.length ?? 0;
      const startSize = repairSizes[0];
      if (finalSize > 0 && startSize > 0 && finalSize < startSize * 0.8) {
        const lost = Math.round(((startSize - finalSize) / startSize) * 100);
        terminal.qualityNotices = [
          ...(terminal.qualityNotices ?? []),
          runNotice("run_report_shrunk", `Repair reduced the report from ${startSize} to ${finalSize} characters (${lost}% smaller) over ${repairSizes.length} round(s); traceability was restored by removing analysis rather than by grounding it.`, {
            detail: `经过 ${repairSizes.length} 轮修订，报告从 ${startSize} 字缩短到 ${finalSize} 字（少了 ${lost}%）：问题是靠删内容而不是补依据解决的。`,
          }),
        ];
      }
    }
    // What we ship has to be what was graded, on this path too.
    //
    // The receipt names each accepted file by sha256, and `finishFromDurableRecord`
    // refuses a mismatch — but that function is only reached when the container
    // is already gone. With the container still alive this path finished from
    // the transcript and never opened the receipt, so a run that kept editing
    // after acceptance shipped as `succeeded`: six of eight files differing from
    // the digests they were accepted under, none of them seen by any gate. The
    // verification was written for the rare case and skipped on the ordinary
    // one.
    // And a deliverable no gate ever accepted must not be recorded as a clean
    // success.
    //
    // The check below only fires when a receipt exists. RQ-03 ran out its seven
    // attempts with the last submission still two required issues short, wrote
    // 「部分交付」 in its own summary, produced no receipt at all — and the
    // ledger recorded `succeeded` with 16 artifacts. Absence of the durable
    // record read as nothing to check rather than as nothing accepted, which is
    // the empty-is-not-error shape one more time.
    //
    // What that defect was is a success nobody could tell from a verified one —
    // not that the files reached the reader. So the files are delivered and the
    // run is marked unverified, and it is a failure only when there is nothing
    // to deliver (2026-09-17: this rule alone turned seven of twelve finished
    // v9 packages, judged 3.1/5 useful, into 失败).
    //
    // Read from the run's own projection, so this only speaks about runs that
    // planned a contract deliverable: an answer-line turn plans none and is
    // unaffected.
    if (terminal.status === "succeeded") {
      const projection = await readRunStateProjection(project, project.workspaceDir, run);
      /** @param {(string | StoredNotice)[]} notices */
      const unaccepted = (notices) => {
        if (artifacts.length === 0) {
          terminal.status = "failed";
          terminal.errorCode = "specialist_deliverable_not_accepted";
        } else if (!serverGateClean) {
          terminal.verification = "unverified";
        }
        terminal.qualityNotices = [...(terminal.qualityNotices ?? []), ...notices];
      };
      if (run.nativeTurn) {
        const proof = run.nativeWorkflow;
        const requiresAcceptance = proof?.plan?.items?.length || proof?.submissions?.length;
        const currentReceipt = await readDeliveryReceipt(project, run);
        const incomplete = proof?.completion?.ok === false || (requiresAcceptance && !currentReceipt);
        if (incomplete || (projection.state === "unattributed" && artifacts.length > 0 && !currentReceipt)) {
          unaccepted([...nativeWorkflowNotices(proof),
            ...(projection.state === "unattributed" ? [unattributedNotice()] : []),
          ]);
        }
      }
      const planned = projection.state === "read" && Array.isArray(projection.projection?.plan?.items)
        ? projection.projection.plan.items
        : [];
      const accepted = planned.filter((item) => item?.status === "accepted");
      if (terminal.status === "succeeded" && planned.length > 0 && accepted.length === 0 && !(await readDeliveryReceipt(project, run))) {
        const sentence = artifacts.length === 0
          ? `本次运行计划了 ${planned.length} 件交付物，没有一件通过契约校验，也没有留下文件。`
          : serverGateClean
            ? `本次运行计划的 ${planned.length} 件交付物没有拿到运行内的回执；服务端已用同一套规则核验了盘上的文件并通过。`
            : `本次运行计划的 ${planned.length} 件交付物没有通过运行内的契约校验，文件按「未核验」交付，未通过的项列在下面。`;
        unaccepted([runNotice("run_planned_none_accepted", sentence, { detail: sentence })]);
      }
    }
    const finalReceipt = await readDeliveryReceipt(project, run);
    // The receipt's own entries reach the browser here, on the path that runs
    // every time, and ahead of the terminal `run/state` that makes a watching
    // tab close its stream.
    const finalProjection = await readRunStateProjection(project, project.workspaceDir, run);
    // Guarded on having something to say, not on the projection being readable:
    // an answer-mode run writes no projection and a receipt alone is still a
    // delivered package, and requiring both is how the durable path came to
    // publish nothing for exactly the run that had delivered.
    if (finalProjection.state === "read" || finalReceipt) {
      this.publishDeliverables(project, run, finalProjection.state === "read" ? finalProjection.projection ?? {} : {}, finalReceipt);
    }
    if (finalReceipt) {
      // The advisory findings the gate recorded when it accepted the package
      // travel with the verdict, on this path too.
      //
      // `finishFromDurableRecord` has carried them since it was written; this
      // path never opened the receipt, so a run whose container outlived it
      // reported none of them. Same fact, two paths, and the one that runs
      // every time was the one that dropped it — a package accepted with
      // twenty-five advisory notes reached the ledger with zero. Deduplicated,
      // because a notice already admitted while the run was alive is the same
      // notice.
      const seen = new Set((terminal.qualityNotices ?? []).map(noticeText));
      const accepted = receiptNotices(finalReceipt.entries, finalProjection.state === "read" ? finalProjection.projection ?? null : null)
        .filter((notice) => !seen.has(notice.text));
      if (accepted.length) {
        terminal.qualityNotices = [...(terminal.qualityNotices ?? []), ...accepted].slice(0, 20);
      }
      const verified = await verifiedReceiptArtifacts(project, finalReceipt);
      if (verified.mismatched.length) {
        // Changed bytes and a broken delivery are not the same thing.
        //
        // Every industry that ships artifacts says the same: a verified thing
        // that is modified becomes a new thing to verify, never a thing to
        // destroy. This branch destroyed it — `artifacts: []` on a package the
        // gate had accepted — and on 2026-08-31 that discarded 38 minutes of
        // work whose files were, at that moment, gate-clean.
        //
        // We are in the one position where re-verification is free: on this
        // path `specialistCompletionOutcome` has already run the same domain
        // gate over the bytes now on disk (`readRequiredFile` reads current
        // content, not the receipt's copy), and `terminal.status` carries its
        // verdict. So a mismatch here means the run changed accepted files and
        // the changed files still pass — amend, and say which moved.
        //
        // The receipt file itself is not rewritten: workspaceLayout records
        // that it is written only by evimed_submit_deliverable, and the ledger
        // entry this returns is the control plane's own durable record of what
        // it verified and shipped.
        const amendable = terminal.status === "succeeded" && artifacts.length > 0;
        // A failed repair whose files moved under a revision the server
        // authorized is that failed repair, and it is already the verdict in
        // `terminal`. Calling it a digest mismatch told the reader the files
        // were tampered with and dropped them from the ledger (v8 ablation,
        // 2026-09-16).
        const drift = amendable || terminal.status !== "failed" ? null : await revisionDrift(project, verified);
        if (drift?.explained) {
          terminal.qualityNotices = [revisionNotAcceptedNotice(verified, drift.revising), ...(terminal.qualityNotices ?? [])];
        } else if (!amendable) {
          return this.finishInternal(project, run.id, {
            status: "failed",
            errorCode: "specialist_receipt_digest_mismatch",
            artifacts: [],
            // First: behind twenty gate issues they were cut off, and the
            // ledger never said which files had moved.
            qualityNotices: [
              ...verified.mismatched.slice(0, 10).map((entry) => runNotice("run_receipt_mismatch",
                `delivery-receipt.json names ${entry} with a digest the file no longer matches, and the package did not pass on the bytes now on disk`,
                { file: entry, detail: `回执记下的文件在通过之后被改动，改动后的内容没有通过核验。` })),
              ...(terminal.qualityNotices ?? []),
            ].slice(0, 20),
          });
        } else {
          const changed = `交付物在写下回执之后被改动了 ${verified.mismatched.length} 个文件：${verified.mismatched.slice(0, 6).join("、")}。`
            + (terminal.verification
              ? "服务端已用同一套规则对盘上的实际字节重新核验，结论就是这次交付的核验标签；发出去的是盘上的这一版，不是回执记下的那一版。"
              : "服务端已用同一套门禁对盘上的实际字节重判并通过，按实际交付重出回执；发出去的就是被验过的那一版。")
            + "若这不是有意的收尾修改，请让运行在最后一次修改之后再提交一次。";
          terminal.qualityNotices = [
            ...(terminal.qualityNotices ?? []),
            runNotice("run_files_changed_after_receipt", changed, { detail: changed }),
          ].slice(0, 20);
        }
      }
    }
    return this.finishInternal(project, run.id, { ...terminal, artifacts,
      ...(run.nativeTurn && ownEnd?.time ? { finishedAt: new Date(ownEnd.time).toISOString() } : {}),
    });
  }

  /** Append what is observably happening, when it changes.
   *
   * Returns whether the run moved since the last observation, which is what
   * separates a long run from a dead one. Only a change is written, so the
   * ledger does not grow with every poll of a quiet run. */
  /**
   * Reads the run's own projection and turns it into the three things the
   * control plane needs from it.
   *
   * One read, three consumers, on the monitor's existing cycle: the stall
   * change record, the browser's evidence and budget frames, and the run's
   * own quality notices. The change record is diagnostic only: this file lives
   * in the model's workspace, so authenticated kernel events own the stall
   * signal. They stay together because they come from one file and splitting
   * them would mean reading it three times on three schedules.
   *
   * @param {any} project @param {Record<string, any>} run
   * @returns {Promise<{ signature: string | null, unreadable: boolean, childSessionIds: string[], projection: Record<string, any> | null }>}
   */
  async readRunSideActivity(project, run) {
    // Read from the host, because that is where this process opens files.
    //
    // `runtimeWorkspaceRoot()` answers a different question: what root the
    // model's own absolute paths are relative to. Under docker that is
    // `/workspace` — the path INSIDE the container — so using it here asked
    // the host for `/workspace/.evimed-run/state.json`, which does not exist
    // on the host, and the projection read `missing` for the entire life of
    // every containerised run. Two production runs recorded
    // `observedRunSideActivity: null` from start to finish while the file sat
    // on disk the whole time; the browser got no evidence or budget frames,
    // the stall signal had nothing to read, and the run's own degraded lines
    // never reached the ledger.
    //
    // One accessor was being used for two questions. `artifactCandidates` and
    // `successfulEvidenceSourceArtifacts` still take the container root, and
    // correctly: they relativise paths the model wrote.
    const read = await readRunStateProjection(project, project.workspaceDir, run);
    if (read.state === "unattributed") return { signature: null, unreadable: true, childSessionIds: [], projection: null };
    if (read.state === "missing") return { signature: null, unreadable: false, childSessionIds: [], projection: null };
    if (read.state === "unreadable") {
      // Said once per run, not once per poll: the monitor wakes on a fixed
      // interval and a notice per wake would bury the ledger in one repeated
      // sentence. isolated: evimed_run_projection_unreadable_total
      if (!this.projectionNoticed.has(run.id)) {
        this.projectionNoticed.add(run.id);
        const sentence = "运行自述文件 .evimed-run/state.json 无法解析，本次运行的证据与预算明细不可见；运行本身不受影响。";
        await this.appendQualityNotices(project, run.id, [
          runNotice("run_projection_unreadable", sentence, { detail: sentence }),
        ]).catch(() => {});
      }
      return { signature: null, unreadable: true, childSessionIds: [], projection: null };
    }
    const projection = read.projection ?? {};
    this.publishRunProjection(project, run, projection);
    // Two rows name a working child: the delegation's own `subagents` row and,
    // since 2026-09-18, the plan item it works on (`childSessionId` from the
    // moment the child exists). Either alone has gone missing before, and
    // both are only candidates — the kernel's session list confirms the
    // parent before a head counts.
    const settledItem = new Set(["accepted", "delivered", "failed"]);
    const childSessionIds = [...new Set([
      ...(Array.isArray(projection.subagents) ? projection.subagents : [])
        .filter((child) => child?.status === "running" && typeof child?.childSessionId === "string")
        .map((child) => child.childSessionId.trim()),
      ...(Array.isArray(projection.plan?.items) ? projection.plan.items : [])
        .filter((item) => typeof item?.childSessionId === "string" && !settledItem.has(String(item?.status ?? "")))
        .map((item) => item.childSessionId.trim()),
    ].filter(Boolean))].slice(0, 64);
    return { signature: runSideActivitySignature(projection), unreadable: false, childSessionIds, projection };
  }

  /**
   * Forwards the projection's own facts to whoever is watching the run.
   *
   * Debounced on content rather than on time: the monitor polls on a fixed
   * interval and most polls change nothing, so an undebounced publish would
   * send the same two frames every tick forever and a reader could not tell a
   * change from a heartbeat.
   *
   * @param {any} project @param {Record<string, any>} run @param {Record<string, any>} projection
   */
  publishRunProjection(project, run, projection) {
    const evidence = {
      total: Number(projection?.evidence?.total ?? 0) || 0,
      byStatus: projection?.evidence?.byStatus && typeof projection.evidence.byStatus === "object" ? projection.evidence.byStatus : {},
    };
    const budget = {
      steps: Number(projection?.budget?.steps ?? 0) || 0,
      tokens: Number(projection?.budget?.tokens ?? 0) || 0,
      children: Number(projection?.budget?.children ?? 0) || 0,
      limits: projection?.budget?.limits && typeof projection.budget.limits === "object" ? projection.budget.limits : {},
    };
    const sent = this.projectionDigests.get(run.id) ?? {};
    const next = { evidence: JSON.stringify(evidence), budget: JSON.stringify(budget) };
    // isolated: evimed_run_projection_publish_failures_total — a listener that
    // throws must not end the run whose progress it was told about.
    try {
      if (next.evidence !== sent.evidence) this.onRunProjection(project, run, "evidence/update", evidence);
      if (next.budget !== sent.budget) this.onRunProjection(project, run, "budget/update", budget);
    } catch { /* isolated */ }
    this.projectionDigests.set(run.id, next);
    // The plan's own verdicts, on the same cycle and the same channel. A
    // deliverable is rejected and repaired *while the run is going*, which is
    // exactly when the panel showing why is worth having — waiting for the
    // terminal state would show a person the last verdict and none of the ones
    // that cost the run its forty minutes.
    this.publishDeliverables(project, run, projection, null);

    // The run's own admissions ride the ledger, not the stream: they outlive
    // the socket a browser is holding, and a reader who opens the run tomorrow
    // must still see that a layer went unchecked.
    const admissions = runSideNotices(projection);
    const already = this.projectionAdmissions.get(run.id) ?? new Set();
    const fresh = admissions.filter((notice) => !already.has(notice.text));
    if (!fresh.length) return;
    for (const notice of fresh) already.add(notice.text);
    this.projectionAdmissions.set(run.id, already);
    this.appendQualityNotices(project, run.id, fresh).catch(() => {});
  }

  /**
   * Publishes one `deliverable/update` per planned deliverable that changed.
   *
   * Debounced per deliverable rather than per projection: the plan index is
   * rewritten whenever any item moves, so digesting the whole list would resend
   * every deliverable every time one of them was graded.
   *
   * @param {any} project @param {Record<string, any>} run
   * @param {Record<string, any>} projection
   * @param {import('@evimed/domain').DeliveryReceipt|null} receipt
   */
  publishDeliverables(project, run, projection, receipt) {
    const sent = this.deliverableDigests.get(run.id) ?? new Map();
    // isolated: evimed_run_deliverable_publish_failures_total — a listener that
    // throws must not end the run whose verdict it was told about.
    try {
      for (const frame of deliverableFrames(projection, receipt)) {
        const digest = JSON.stringify(frame);
        if (sent.get(frame.id) === digest) continue;
        sent.set(frame.id, digest);
        this.onRunProjection(project, run, "deliverable/update", frame);
      }
    } catch { /* isolated */ }
    this.deliverableDigests.set(run.id, sent);
  }

  /**
   * The live progress state of one run, created on first use and dropped when
   * the run finishes.
   * @param {string} runId
   */
  progressTracker(runId) {
    let tracker = this.progressTrackers.get(runId);
    if (!tracker) {
      tracker = {
        /** sessionId -> call key -> the observed call. Root and children alike. @type {Map<string, Map<string, import('./runProgress.mjs').ObservedCall>>} */
        sessions: new Map(),
        /** Sessions the kernel attributed to this run as children. @type {Set<string>} */
        children: new Set(),
        /** childSessionId -> the head sequence its history was last read at. @type {Map<string, { at: number, seq: number }>} */
        childReads: new Map(),
        /** childSessionId -> how its last turn ended, from its own stream. @type {Map<string, string>} */
        childEnds: new Map(),
        /** sessionId -> when it was last seen doing something (epoch ms). @type {Map<string, number>} */
        activity: new Map(),
        /** The kernel's last word on this run's direct children. @type {{ sessionId: string, running: boolean }[]} */
        kernelChildren: [],
        discoveredAt: 0,
        /** @type {{ key: string, at: number, total: number, verified: number, unverified: number } | null} */
        matrix: null,
        /** @type {Record<string, any> | null} */
        projection: null,
        /** @type {any} */
        usage: null,
        usageAt: 0,
        /** @type {string | null} */
        startedAt: null,
        /** @type {import('./runProgress.mjs').RunProgress | null} */
        last: null,
        publishedDigest: "",
        publishedAt: 0,
        /** @type {ReturnType<typeof setTimeout> | null} */
        timer: null,
        /** @type {any} */
        project: null,
      };
      this.progressTrackers.set(runId, tracker);
    }
    return tracker;
  }

  /**
   * One event the kernel's stream carried for a run, the parent's or a
   * child's, handed over by the event pump.
   *
   * The monitor reads the parent's whole history every poll and is exact
   * about it; a child's work reached nothing at all before this, so a
   * delegated run's progress stopped at the parent's blocked tool call. The
   * stream is what makes a child's search count within a second, and the
   * monitor's occasional re-read of the child's own history (see
   * `reconcileChildCalls`) is what makes the count right if the stream missed
   * something. A call is keyed by its id, so a replay counts once.
   *
   * @param {any} project @param {string} runId
   * @param {{ sessionId: string, child?: boolean, replay?: boolean, event: import('@evimed/domain').RunEvent }} observed
   */
  noteRunEvent(project, runId, observed) {
    if (!runId || !observed?.sessionId || !observed.event) return;
    const tracker = this.progressTracker(runId);
    tracker.project ??= project;
    const nowMs = this.now().getTime();
    if (!observed.replay) tracker.activity.set(observed.sessionId, nowMs);
    if (observed.child) tracker.children.add(observed.sessionId);
    // A delegation's receipt names its child before the child's own stream
    // has said anything (see `delegatedChildrenOf`); the monitor's next read
    // asks the kernel about it like any other candidate.
    if (observed.event.type === "tool/result") {
      for (const found of delegatedChildrenOf(observed.event.tool, observed.event.output)) {
        if (found.childSessionId !== observed.sessionId) tracker.children.add(found.childSessionId);
      }
    }
    let calls = tracker.sessions.get(observed.sessionId);
    if (!calls) {
      calls = new Map();
      tracker.sessions.set(observed.sessionId, calls);
    }
    let changed = foldToolEvent(calls, observed.event, nowMs);
    if (observed.child && observed.event.type === "turn/end") {
      tracker.childEnds.set(observed.sessionId, String(observed.event.endKind ?? ""));
      changed = true;
    }
    // A child that starts a new turn is running again, whatever its last one did.
    if (observed.child && observed.event.type === "turn/start" && tracker.childEnds.delete(observed.sessionId)) changed = true;
    if (changed && tracker.startedAt && tracker.last) {
      this.publishProgress(tracker.project ?? project, runId, tracker, this.composeProgress(tracker, { startedAt: tracker.startedAt }));
    }
  }

  /**
   * The aggregate from what the tracker holds.
   * @param {ReturnType<AgentRunStore['progressTracker']>} tracker @param {{ startedAt?: string | null }} run
   * @param {import('./runProgress.mjs').RunDeliverable[] | null} [deliverables]
   */
  composeProgress(tracker, run, deliverables = null) {
    const projection = tracker.projection;
    return assembleRunProgress({
      deliverables: deliverables ?? runDeliverables(projection, null, null),
      calls: [...tracker.sessions.values()].flatMap((calls) => [...calls.values()]),
      projection,
      matrixClaims: tracker.matrix,
      children: progressChildren({ projection, kernelChildren: tracker.kernelChildren, ended: tracker.childEnds, lastActivity: tracker.activity }),
      usage: tracker.usage,
      startedAt: run.startedAt ?? tracker.startedAt ?? null,
      now: this.now().toISOString(),
    });
  }

  /**
   * Publishes one run's aggregate when it changed, at most once per
   * `progressPublishIntervalMs`, with the last change sent when the interval
   * ends — so a burst of child tool calls is one frame, and the frame after a
   * burst is never the one that was dropped.
   * isolated: evimed_run_progress_publish_failures_total
   * @param {any} project @param {string} runId @param {ReturnType<AgentRunStore['progressTracker']>} tracker
   * @param {import('./runProgress.mjs').RunProgress} progress @param {{ force?: boolean }} [options]
   */
  publishProgress(project, runId, tracker, progress, { force = false } = {}) {
    tracker.last = progress;
    const send = () => {
      if (tracker.timer) clearTimeout(tracker.timer);
      tracker.timer = null;
      const latest = tracker.last;
      if (!latest) return;
      const digest = progressDigest(latest);
      if (digest === tracker.publishedDigest) return;
      tracker.publishedDigest = digest;
      tracker.publishedAt = Date.now();
      try {
        this.onRunProjection(project, { id: runId }, "run/progress", latest);
      } catch { /* isolated */ }
    };
    if (progressDigest(progress) === tracker.publishedDigest) return;
    const wait = tracker.publishedAt + this.progressPublishIntervalMs - Date.now();
    if (force || wait <= 0) {
      send();
      return;
    }
    if (!tracker.timer) {
      tracker.timer = setTimeout(send, wait);
      tracker.timer.unref?.();
    }
  }

  /**
   * Re-reads a child's own history when its head has moved, to reconcile the
   * tool calls the stream reported for it.
   *
   * Bounded twice: only a child whose kernel head advanced since its last
   * read, and at most once per `childHistoryIntervalMs` each. Read under the
   * parent's address — the only one the kernel accepts for a child.
   * @param {any} project @param {Record<string, any>} run
   * @param {ReturnType<AgentRunStore['progressTracker']>} tracker
   * @param {{ sessionId: string, asOfSeq: number }[]} childActivity
   */
  async reconcileChildCalls(project, run, tracker, childActivity) {
    const nowMs = this.now().getTime();
    for (const child of childActivity.slice(0, 16)) {
      const last = tracker.childReads.get(child.sessionId);
      if (last && (child.asOfSeq <= last.seq || nowMs - last.at < this.childHistoryIntervalMs)) continue;
      tracker.childReads.set(child.sessionId, { at: nowMs, seq: child.asOfSeq });
      if (last) tracker.activity.set(child.sessionId, nowMs);
      tracker.children.add(child.sessionId);
      let history;
      try {
        history = await this.readSessionHistory(project, child.sessionId, { wake: false, parentSessionId: run.sessionId });
      } catch {
        continue; // an unread child still counts through its live events
      }
      tracker.sessions.set(child.sessionId, mergeObservedCalls(tracker.sessions.get(child.sessionId), observedCallsFromHistory(Array.isArray(history) ? history : [])));
    }
  }

  /**
   * What the run has cost so far, for the aggregate: at most every ten
   * seconds, because it is a query against the usage ledger per poll otherwise.
   * An unattributed run reads null and the aggregate carries no usage rather
   * than a zero it did not measure.
   * @param {any} project @param {Record<string, any>} run
   * @param {ReturnType<AgentRunStore['progressTracker']>} tracker
   */
  async refreshRunUsage(project, run, tracker) {
    const nowMs = this.now().getTime();
    if (tracker.usageAt && nowMs - tracker.usageAt < 10_000) return;
    tracker.usageAt = nowMs;
    const usage = await this.readRunUsage(project, run);
    tracker.usage = usage && typeof usage === "object" && Number(usage.requests) > 0 ? normalizeRunUsage(usage) : null;
  }

  /**
   * The claim counts of the run's evidence matrices, when no claim tool has
   * reported them: re-read only when a matrix file changed, and at most every
   * fifteen seconds, because it re-reads every preserved source it quotes.
   * @param {any} project @param {ReturnType<AgentRunStore['progressTracker']>} tracker
   */
  async refreshMatrixClaims(project, tracker) {
    const nowMs = this.now().getTime();
    if (tracker.matrix && nowMs - tracker.matrix.at < 15_000) return;
    const ids = (Array.isArray(tracker.projection?.plan?.items) ? tracker.projection.plan.items : [])
      .map((/** @type {any} */ item) => String(item?.id ?? ""))
      .filter((id) => id && !id.includes("/") && !id.includes("\\") && id !== "." && id !== "..")
      .slice(0, 12);
    const paths = ids.map((id) => `${workspaceLayout.deliverablesDir}/${id}/clinical-evidence-matrix.json`);
    const summary = await matrixClaimSummary(project, paths, tracker.matrix?.key ?? null);
    tracker.matrix = summary
      ? { ...summary, at: nowMs }
      : (tracker.matrix ? { ...tracker.matrix, at: nowMs } : null);
  }

  /**
   * Records one event already attributed by RuntimeEventPump's project-scoped
   * root/child session maps. The digest, rather than a model-writable
   * workspace counter, is what the stall monitor compares on its next poll.
   * Replayed opening snapshots carry the same session/sequence pair and
   * therefore do not manufacture movement.
   * @param {{ userId: string, id: string }} project
   * @param {string} runId
   * @param {{ sessionId: string, seq: number, stream?: {attemptId: string, index: number} }} activity
   */
  noteKernelActivity(project, runId, activity) {
    if (!project?.userId || !project?.id || !runId || !activity?.sessionId || !Number.isSafeInteger(activity.seq) || activity.seq < 0) return;
    if (activity.stream && (!activity.stream.attemptId || !Number.isSafeInteger(activity.stream.index) || activity.stream.index < 0)) return;
    const key = `${project.userId}\0${project.id}\0${runId}`;
    this.kernelActivities.set(
      key,
      createHash("sha256").update(JSON.stringify([activity.sessionId, activity.seq, ...(activity.stream ? [activity.stream.attemptId, activity.stream.index] : [])])).digest("hex"),
    );
  }

  async recordProgress(project, run) {
    let history;
    try {
      history = await this.readSessionHistory(project, run.sessionId, { wake: false });
    } catch (error) {
      // "Could not read" is not "did not move". Returning false for both fed the
      // stall counter on every failed read, so a run that was working normally
      // through a spell of 502s from its runtime was closed as
      // runtime_monitor_stalled — indistinguishable from one that had actually
      // died, with nothing anywhere recording that a read had failed. Unknown is
      // its own answer: the counter is left alone and the failure is said out
      // loud.
      process.stderr.write(
        `agent run progress unreadable for ${run.id}: ${error?.code ?? (error instanceof Error ? error.message : String(error))}\n`,
      );
      return null;
    }
    if (!Array.isArray(history)) return null;
    // A run adopted before its first message could be read learns what it
    // asked here, on the first poll that can read it (C3).
    if (run.question == null) {
      const asked = firstUserText(run, history);
      if (asked) await this.recordRunLabels(project, run.id, { question: asked }).catch(() => {});
    }
    history = runHistory(run, history);
    const messages = history.length;
    const toolCalls = history.reduce(
      (total, message) => total + (message?.parts ?? []).filter((part) => part?.type === "tool").length,
      0,
    );

    // The run's own projection is still read on the monitor's existing cycle
    // for UI frames and durable diagnostics. It cannot prove liveness: it is a
    // workspace document the model can influence. Child liveness comes from
    // RuntimeEventPump's authenticated, project/run-attributed sequence below.
    const runSide = await this.readRunSideActivity(project, run);
    const activity = runSide.signature;
    const eventActivity = this.kernelActivities.get(`${project.userId}\0${project.id}\0${run.id}`) ?? null;
    const tracker = this.progressTracker(run.id);
    tracker.project = project;
    tracker.startedAt = run.startedAt;
    if (runSide.projection) tracker.projection = runSide.projection;
    const nowMs = this.now().getTime();
    // Which children to ask the kernel about. The projection names the ones a
    // delegation recorded; the event stream names the ones the kernel itself
    // announced on the parent's log. Both are only *candidates*: the kernel's
    // session list must confirm each one's parent before its head counts.
    const candidates = [...new Set([...runSide.childSessionIds, ...tracker.children])].slice(0, 64);
    // And every few seconds, children nothing named yet. A child the kernel
    // lists under this run's root session and created after this run began is
    // this run's work — the case F4 was: a delegated child writing every
    // minute that no projection row and no stream event had named.
    const discover = nowMs - tracker.discoveredAt >= this.childDiscoveryIntervalMs;
    if (discover) tracker.discoveredAt = nowMs;
    let childActivity = [];
    let childActivityUnreadable = false;
    if (candidates.length > 0 || discover) {
      try {
        const observed = await this.readChildSessionActivity(
          project,
          run.sessionId,
          candidates,
          discover ? { discoverSince: Date.parse(run.startedAt) - 5_000 } : {},
        );
        const allowed = new Set(candidates);
        childActivity = (Array.isArray(observed) ? observed : []).filter((child) =>
          (allowed.has(child?.sessionId) || child?.discovered === true)
          && typeof child?.sessionId === "string"
          && child.sessionId.length > 0
          && child.sessionId.length <= 512
          && Number.isSafeInteger(child?.asOfSeq)
          && child.asOfSeq >= 0,
        ).map((child) => ({
          sessionId: child.sessionId,
          asOfSeq: child.asOfSeq,
          running: child.running === true,
        })).slice(0, 256).sort((left, right) => left.sessionId.localeCompare(right.sessionId, "en"));
      } catch {
        // An unreadable catalogue is unknown activity, never proof of a stall
        // and never permission to trust the projection's own counters — when
        // there was a child to ask about. A discovery read that fails finds
        // nothing, which is what it found before it existed.
        if (candidates.length > 0) childActivityUnreadable = true;
      }
    }
    // The aggregate a reader sees, before any stall arithmetic: it is a
    // statement of what was observed, and a poll that cannot tell whether the
    // run moved can still say what it has done.
    tracker.sessions.set(run.sessionId, mergeObservedCalls(tracker.sessions.get(run.sessionId), observedCallsFromHistory(history)));
    if (!childActivityUnreadable) {
      tracker.kernelChildren = childActivity.map((child) => ({ sessionId: child.sessionId, running: child.running }));
      for (const child of childActivity) tracker.children.add(child.sessionId);
      await this.reconcileChildCalls(project, run, tracker, childActivity);
    }
    await this.refreshMatrixClaims(project, tracker).catch(() => {});
    await this.refreshRunUsage(project, run, tracker).catch(() => {});
    const progress = this.composeProgress(tracker, run);
    this.publishProgress(project, run.id, tracker, progress);
    if (childActivityUnreadable) return null;
    const kernelKey = `${project.userId}\0${project.id}\0${run.id}`;
    const heads = this.childKernelHeads.get(kernelKey) ?? new Map();
    let childAdvanced = false;
    let runningChildBaselined = false;
    for (const child of childActivity) {
      const previous = heads.get(child.sessionId);
      // First sight is the server-owned binding and baseline, not progress.
      // Re-adding a historical child or changing its running flag therefore
      // cannot reset the stall clock; only a later kernel sequence may.
      if (previous === undefined && heads.size < maxObservedChildSessions) {
        heads.set(child.sessionId, child.asOfSeq);
        if (child.running) runningChildBaselined = true;
      }
      else if (child.asOfSeq > previous) {
        heads.set(child.sessionId, child.asOfSeq);
        childAdvanced = true;
      }
    }
    this.childKernelHeads.set(kernelKey, heads);
    // A newly authenticated running child is neither movement nor stillness:
    // its current head is the baseline. Preserve the existing idle count for
    // this poll so a retry that appears at N-1 does not die before its next
    // kernel sequence, while the hard unique-child cap prevents churn from
    // buying unbounded grace.
    if (runningChildBaselined && !childAdvanced) return null;
    if (childAdvanced) {
      this.childKernelActivities.set(
        kernelKey,
        createHash("sha256").update(JSON.stringify([...heads].sort(([left], [right]) => left.localeCompare(right, "en")))).digest("hex"),
      );
    }
    const childActivityDigest = this.childKernelActivities.get(kernelKey) ?? null;
    const kernelActivity = eventActivity || childActivityDigest
      ? createHash("sha256").update(JSON.stringify({ eventActivity, childActivity: childActivityDigest })).digest("hex")
      : null;

    const stillByHistory = messages === (run.observedMessages ?? 0) && toolCalls === (run.observedToolCalls ?? 0);
    const stillByRunSide = activity === null || activity === (run.observedRunSideActivity ?? null);
    const stillByKernel = kernelActivity === null || kernelActivity === (run.observedKernelActivity ?? null);
    // Unreadable is neither moved nor still. Returning `false` here would make
    // a corrupt projection feed the stall counter, which is the same mistake
    // the history read already learned not to make one function up.
    if (runSide.unreadable && stillByHistory && stillByKernel) return null;
    if (stillByHistory && stillByRunSide && stillByKernel) return false;
    await withProjectStorageMutation(project, async () => {
      const events = parseEvents(await readLedgerText(project, this.maxBytes));
      const current = foldEvents(events).get(run.id);
      if (!current || current.status !== "running") return;
      const event = {
        event: "progress",
        id: run.id,
        at: this.now().toISOString(),
        messages,
        toolCalls,
        ...(activity === null ? {} : { runSideActivity: activity }),
        ...(kernelActivity === null ? {} : { kernelActivity }),
        // The aggregate, stored so a reader who opens the run later (or a
        // restarted control plane) sees the last observed picture. The plan
        // is stored once, beside the snapshot, never inside it twice.
        ...(progress.deliverables.length ? { deliverables: progress.deliverables } : {}),
        snapshot: withoutDeliverables(progress),
      };
      // Superseded progress rows go, for every run rather than only this one:
      // `serializeNext` holds that rule now, so the terminal path drops them too.
      const text = serializeNext(events, event, this.maxBytes);
      await writeFileAtomicNoFollow(project.rootDir, ledgerFile(project), text, { encoding: "utf8", mode: 0o600 });
    });
    // The projection is still recorded and published, but it is a workspace
    // document the model can influence. Only root history or an authenticated
    // DSH event may reset the stall counter.
    return !stillByHistory || !stillByKernel;
  }

  scheduleMonitor(project, runId) {
    if (this.monitors.has(runId)) return;
    let canceled = false;
    /**
     * Wakes the monitor out of its inter-poll sleep.
     *
     * Without it, cancelling a monitor only takes effect at the *next* poll,
     * which by default is four hours away — so shutdown either returned while
     * the monitor was still writing to the project's storage, or would have had
     * to wait out the interval. The first is what happened: a canceled monitor
     * mid-`finishInternal` kept running after its project directory was gone.
     * @type {(() => void) | null}
     */
    let wake = null;
    const promise = (async () => {
      let idlePolls = 0;
      // Once per run: a notice repeated every poll is a log, not a notice.
      let stallNoticed = false;
      // eslint-disable-next-line no-unmodified-loop-condition -- set by the cancel closure registered below
      for (let poll = 0; poll < this.monitorMaxPolls && !canceled; poll += 1) {
        const runs = await this.list(project);
        const run = runs.find((item) => item.id === runId);
        if (!run || run.status !== "running") return;
        const reconciled = await this.reconcileSession(project, run.sessionId, run.id);
        if (reconciled?.status !== "running") return;
        // A ledger of started/dispatch/finished cannot tell a run that is
        // working from one that died an hour ago, so both wait out the full
        // timeout. Record what is observably happening, and stop early once
        // nothing has happened for long enough that nothing will.
        // Three outcomes, not two: it moved, it did not move, or we could not
        // tell. Only the middle one is evidence of a stall.
        // Reconciliation may have appended progress. Compare against the
        // record it just returned, not the stale pre-reconciliation snapshot;
        // otherwise the same counters look new on every poll and a dead run
        // reaches the global timeout instead of the stall threshold.
        const moved = await this.recordProgress(project, reconciled).catch(() => null);
        if (moved === true) idlePolls = 0;
        else if (moved === false) idlePolls += 1;
        // A stall threshold is a guess about what "long enough that nothing
        // more will happen" means, and it was ending runs on that guess. A
        // clinical review spends whole stretches inside one tool call with no
        // counter moving, and the run this ended still had its files on disk —
        // the same shape as the delivery complaint, arriving through the
        // monitor instead of the gate. Principle #4 says a check ships as a
        // notice until an observed distribution earns it the right to block.
        //
        // So the threshold now says so, once, and the run carries on.
        // Termination belongs to the global clock (`monitorMaxPolls`, four
        // hours), which is a budget rather than an inference about liveness,
        // and whose terminal path already publishes whatever the workspace
        // holds.
        if (this.monitorStallPolls > 0 && idlePolls >= this.monitorStallPolls && !stallNoticed) {
          stallNoticed = true;
          const minutes = Math.round((idlePolls * this.monitorIntervalMs) / 60_000);
          // Says what was measured and nothing else. It used to add 「工作区
          // 也没有变化」, which nothing here ever checks — and in F4 it was shown
          // while a child wrote a file every minute. What the counter does
          // read is the parent's messages and tool calls, the kernel's events
          // for the parent and every child it attributed, and each child's
          // head in the kernel's own session list.
          const sentence = `这次运行已有约 ${minutes} 分钟没有可观测的进展：主会话和各子任务都没有新消息、也没有新工具调用。运行仍在继续，没有被终止；如果确认它确实卡住了，可以停止它，已经写出的文件不会丢失。`;
          await this.appendQualityNotices(project, runId, [
            runNotice("run_stall_observed", sentence, { detail: sentence }),
          ]).catch(() => null);
        }
        // Checked here as well as in the loop condition. A cancel that lands
        // while a poll is in flight would otherwise be followed by a sleep that
        // nothing wakes — the loop only re-reads `canceled` after it — so the
        // shutdown waiting on this monitor would wait out a full interval,
        // which is four hours by default.
        if (canceled) return;
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, this.monitorIntervalMs);
          timer.unref?.();
          wake = () => {
            clearTimeout(timer);
            resolve(undefined);
          };
        });
        wake = null;
      }
      if (!canceled) {
        await this.finishInternal(project, runId, {
          status: "failed",
          errorCode: "runtime_monitor_timeout",
          artifacts: [],
        });
      }
    })().catch(async (error) => {
      // Nobody awaits this promise. It is stored in `this.monitors` so shutdown
      // can wait on it — and `closeProject` does `await monitor?.promise?.catch()`
      // — but on the detached path a rejection here is an unhandled rejection,
      // which Node turns into process exit.
      //
      // That is not theoretical. Production crash-looped 48 times on
      // 2026-08-30: startup adopted the previous life's running runs, a monitor
      // called through to the runtime controller, the controller answered 502
      // `runtime_cleanup_failed`, and the whole web boundary died two seconds
      // after it began listening. An orphaned container that will not go away
      // is a housekeeping problem; it took down the API for every user.
      //
      // A monitor observes one run. Its failures belong to that run.
      const code = error instanceof HttpError ? error.code : "runtime_monitor_failed";
      process.stderr.write(`${JSON.stringify({
        at: new Date().toISOString(), event: "agent_run.monitor_failed", runId, code,
      })}\n`);
      try {
        await this.finishInternal(project, runId, {
          status: "failed",
          errorCode: code,
          artifacts: [],
        });
      } catch {
        // The ledger write failing is the second failure of the same run, and
        // there is no third place to report it. It must not re-throw: that
        // would land back here as the very unhandled rejection this catch
        // exists to prevent.
      }
    }).finally(() => {
      if (this.monitors.get(runId)?.promise === promise) this.monitors.delete(runId);
    });
    this.monitors.set(runId, { promise, cancel: () => { canceled = true; wake?.(); } });
  }

  /**
   * Re-arms observation for every run a previous process left running.
   *
   * A restarted control plane used to forget its in-flight runs entirely: the
   * startup orphan sweep killed their containers, and nothing ever monitored
   * them again, so a run whose turn had already completed -- deliverables,
   * summary and all on disk -- sat "running" in the ledger forever. Observed
   * live on 2026-08-26: the sweep reaped the container at 14:18:40 and the
   * run's last ledger event stayed a progress row from 12:42.
   *
   * Adoption is just `scheduleMonitor`, which is idempotent per run id. A
   * monitor whose container is gone hits `runtime_not_running` on its first
   * read and finishes the run from the durable record -- the same bridge a
   * mid-run container death crosses; one that finds the container alive keeps
   * observing as if the restart never happened. Called after the orphan sweep,
   * not before, so the monitors read a world the sweep is done rearranging.
   *
   * @param {readonly any[]} projects
   * @returns {Promise<{ adopted: number }>}
   */
  /**
   * A kernel session this control plane did not start, recorded as a run.
   *
   * The browser application creates sessions directly on the kernel. Before
   * this they existed nowhere in the ledger: the event pump followed only what
   * a dispatch had registered, so such a session was never followed, its events
   * reached no `/api/runs/:id/events` subscriber, and any approval it asked for
   * was declined by a control plane that could not route it.
   *
   * Adopted as `open-domain` with no agent, because nobody chose one, and with
   * `verification: "unchecked"` from the first event rather than at the end.
   * That value already means "a layer did not run at all", and no layer can run
   * here: the delivery gate checks a deliverable contract, and a session typed
   * into a chat box declares none. Recording it as an ordinary run would make
   * ungated work indistinguishable from work that passed.
   *
   * @param {Record<string, any>} project @param {string} sessionId
   * @param {{ question?: string|null, effectiveAgentId?: string|null, effectiveAgentVersion?: string|null, effectiveRuntimeAgent?: string|null, effectiveRouteReason?: string|null, estimatedMinutes?: { min: number, max: number } | null, forkedFrom?: string | null, transcript?: import('@evimed/domain').RunTranscript, routeTurn?: (text: string) => Promise<any> }} [routed]
   */
  async adoptRuntimeSession(project, sessionId, routed = {}) {
    const id = safeId(sessionId, "runtime session id");
    if (routed.transcript) return this.adoptRuntimeTurns(project, id, routed.transcript, routed.routeTurn, { forkedFrom: routed.forkedFrom ?? null });
    const existing = (await this.list(project)).find((run) => run.sessionId === id);
    if (existing) return existing;
    // A session this control plane is starting is announced by the kernel
    // before the dispatch has written its run, so "no run yet" does not mean
    // "nobody owns it". What does mean that is the research session: a
    // dispatch binds one first and refuses without it, and a session typed
    // into the browser application has none. Adopting on the ledger alone
    // raced every dispatch and took the session out from under it -- the run
    // that followed was refused with `agent_run_active`.
    if (await this.researchSessions.get(project, id)) return null;
    // `reserveRun` rather than `createRun`: the latter forwards only the cursor
    // and the dispatch id, so the route reason that marks this run adopted --
    // the field `reserveRun` itself reads to decide a later dispatch may take
    // the session over -- would have been dropped on the way in.
    const { run } = await this.reserveRun(project, {
      sessionId: id,
      mode: "open-domain",
      agentId: null,
      agentVersion: null,
      runtimeAgent: null,
    }, {
      baselineCursor: null,
      question: routed.question ?? null,
      estimatedMinutes: routed.estimatedMinutes ?? null,
      effectiveAgentId: routed.effectiveAgentId ?? null,
      effectiveAgentVersion: routed.effectiveAgentVersion ?? null,
      effectiveRuntimeAgent: routed.effectiveRuntimeAgent ?? null,
      // The route reason still says the session was adopted, and now also says
      // where it was routed, because both are true and a reader needs both:
      // `adopted:runtime-ui` alone could not tell a graded run from an ungraded
      // one.
      // Joined with `:` because the reason pattern allows it and `+` is not in
      // the character class -- a reason the ledger refuses is a run that cannot
      // be written at all.
      effectiveRouteReason: routed.effectiveRouteReason
        ? `${adoptedRouteReason}:${routed.effectiveRouteReason}`.slice(0, 64)
        : adoptedRouteReason,
    });
    if (routed.effectiveRuntimeAgent) {
      // A contract was found for what the person actually asked, so the run is
      // graded like any other and the monitor is what carries it to a verdict.
      this.scheduleMonitor(project, run.id);
    } else {
      // Nothing to grade against: no text to route, so no contract. Said in the
      // one machine-readable field rather than left to look like a pass.
      await this.appendQualityNotices(project, run.id, [
        runNotice("run_adopted_unchecked",
          "Adopted from the runtime's own browser application with no readable first message, so no deliverable contract could be selected and the delivery gate did not run on this session.",
          { detail: "这次对话没有可读的首条提问，无法匹配交付契约，所以没有做交付核验。" }),
      ], { unchecked: true });
    }
    return (await this.list(project)).find((item) => item.id === run.id) ?? run;
  }

  /**
   * Record a researcher's mid-run correction, before the kernel is told.
   *
   * Hidden knowledge: this is deliberately *not* a second dispatch. A dispatch
   * creates a run, a run binds a deliverable contract, and one research session
   * may have one active run — which is why `agent_run_active` refuses a second
   * one and why that refusal stays exactly as it is. A correction is input to
   * the run that is already going, attributed to it, graded by the contract it
   * already has. The published implementations of this feature agree on the
   * same shape: a steered message belongs to the response it steers, not to a
   * turn of its own, because splitting it off is what makes a later compaction
   * summarise away one half of a modified instruction.
   *
   * Bounded per run. A client that could correct without limit could keep a
   * run alive indefinitely, and every correction is another thing the run must
   * hold in a context it is already spending.
   *
   * Written before the prompt is sent, like the repair path: a request id the
   * ledger has not seen cannot be matched to the run it belongs to.
   *
   * @param {any} project @param {string} runId @param {string} requestId
   */
  async recordCorrection(project, runId, requestId) {
    return withProjectStorageMutation(project, async () => {
      const events = parseEvents(await readLedgerText(project, this.maxBytes));
      const run = foldEvents(events).get(runId);
      if (!run || run.status !== "running") {
        throw new HttpError(409, "agent_run_not_running", "The run is no longer accepting corrections.");
      }
      if ((run.corrections ?? 0) >= MAX_RUN_CORRECTIONS) {
        throw new HttpError(409, "agent_run_correction_limit", `A run accepts at most ${MAX_RUN_CORRECTIONS} corrections.`);
      }
      const event = { event: "kernel-request", id: runId, kind: "steer", requestIds: [storedKernelRequestId(requestId)] };
      await writeFileAtomicNoFollow(project.rootDir, ledgerFile(project), serializeNext(events, event, this.maxBytes), { encoding: "utf8", mode: 0o600 });
      const updated = foldEvents([...events, event]).get(runId);
      this.notifyState(project, updated);
      return updated;
    });
  }

  /** Persist a repair's native request identity before sending it. */
  async recordKernelRequest(project, runId, requestId) {
    return withProjectStorageMutation(project, async () => {
      const events = parseEvents(await readLedgerText(project, this.maxBytes));
      const run = foldEvents(events).get(runId);
      if (!run || run.status !== "running") throw new HttpError(409, "agent_run_active", "The run is no longer accepting repair prompts.");
      const event = { event: "kernel-request", id: runId, requestIds: [storedKernelRequestId(requestId)] };
      await writeFileAtomicNoFollow(project.rootDir, ledgerFile(project), serializeNext(events, event, this.maxBytes), { encoding: "utf8", mode: 0o600 });
      const updated = foldEvents([...events, event]).get(runId);
      this.notifyState(project, updated);
      return updated;
    });
  }

  /** A captured legacy baseline identifies its first consumed user input. */
  async bindLegacyKernelRequests(project, runId, requestIds) {
    return withProjectStorageMutation(project, async () => {
      const events = parseEvents(await readLedgerText(project, this.maxBytes));
      const run = foldEvents(events).get(runId);
      if (!run || run.kernelRequestIds?.length) return run;
      const event = { event: "kernel-request", id: runId, requestIds: requestIds.map(storedKernelRequestId) };
      await writeFileAtomicNoFollow(project.rootDir, ledgerFile(project), serializeNext(events, event, this.maxBytes), { encoding: "utf8", mode: 0o600 });
      const updated = foldEvents([...events, event]).get(runId);
      this.notifyState(project, updated);
      return updated;
    });
  }

  /** Persist observed tool provenance before the kernel can disappear. */
  async recordNativeWorkflow(project, run, history) {
    const evidence = nativeWorkflowEvidence(run, history);
    if (!evidence) return run;
    const candidate = { ...run, nativeWorkflow: evidence };
    const projection = await readRunStateProjection(project, project.workspaceDir);
    const scoped = projection.state === "read" ? scopeNativeProjection(projection.projection, candidate) : null;
    if (scoped) evidence.kernelRunId = scoped.runId;
    else {
      const receipt = await readDeliveryReceipt(project);
      const current = receipt ? scopeNativeReceipt(receipt, candidate) : null;
      if (current && !(await verifiedReceiptArtifacts(project, current)).mismatched.length) evidence.kernelRunId = current.runId;
    }
    return withProjectStorageMutation(project, async () => {
      const events = parseEvents(await readLedgerText(project, this.maxBytes));
      const current = foldEvents(events).get(run.id);
      if (!current || current.status !== "running") return current ?? run;
      const previousSeq = current.nativeWorkflow?.throughSeq
        ?? Number(current.nativeWorkflow?.throughMessage?.replace(/^seq_/, ""));
      if (Number.isFinite(previousSeq) && evidence.throughSeq <= previousSeq) return current;
      if (JSON.stringify(current.nativeWorkflow) === JSON.stringify(evidence)) return current;
      const event = { event: "native-workflow", id: run.id, evidence };
      await writeFileAtomicNoFollow(project.rootDir, ledgerFile(project), serializeNext(events, event, this.maxBytes), { encoding: "utf8", mode: 0o600 });
      return foldEvents([...events, event]).get(run.id);
    });
  }

  /**
   * Observe committed user inputs. Queueing, steering and sending remain the
   * kernel's job; request identities already in our ledger belong to dispatch
   * or repair, and multiple user inputs in one kernel turn are steering.
   * @param {any} project @param {string} sessionId
   * @param {import('@evimed/domain').RunTranscript} transcript
   * @param {(text: string) => Promise<any>} [routeTurn]
   * @param {{ forkedFrom?: string | null }} [options] the session this one was forked from
   */
  async adoptRuntimeTurns(project, sessionId, transcript, routeTurn = async () => ({}), { forkedFrom = null } = {}) {
    if (transcript.sessionId !== sessionId) throw new HttpError(400, "invalid_agent_run", "Runtime transcript identity does not match.");
    const binding = await this.researchSessions.get(project, sessionId);
    // A fork begins with a copy of the session it branched from. Those turns
    // are that session's runs already; only what came after the cut is work
    // done here.
    const seedEnd = Number.isSafeInteger(transcript.seedEndSeq) ? Number(transcript.seedEndSeq) : -1;
    const turns = (transcript.turns ?? []).map((turn) => ({
      ...turn,
      inputs: transcript.messages.filter((message) => message.turnStartSeq === turn.startSeq && message.role === "user" && message.source === "user"),
    })).filter((turn) => turn.inputs.length > 0 && turn.startSeq > seedEnd);
    const knownRuns = await this.list(project);
    const source = forkedFrom && /^[A-Za-z0-9_-]{1,128}$/.test(forkedFrom) ? forkedFrom : null;
    const notifiedLegacy = new Set();
    for (const [index, turn] of turns.entries()) {
      const first = turn.inputs[0];
      const requestIds = turn.inputs.map((message) => message.sourceRequestId).filter((id) => typeof id === "string" && id);
      let run = knownRuns.find((item) => item.sessionId === sessionId && (
        requestIds.length
          ? requestIds.some((id) => (item.kernelRequestIds ?? []).includes(id))
          : !item.kernelRequestIds?.length && item.nativeTurn?.startSeq === turn.startSeq
      ));
      if (run?.nativeTurn && requestIds.length
        && (run.nativeTurn.startSeq !== turn.startSeq || run.nativeTurn.userSeq !== first.seq)) {
        const ownedId = run.id;
        run = await withProjectStorageMutation(project, async () => {
          const events = parseEvents(await readLedgerText(project, this.maxBytes));
          const current = foldEvents(events).get(ownedId);
          if (!current || !requestIds.some((id) => current.kernelRequestIds?.includes(id))) {
            throw new HttpError(409, "runtime_input_changed", "The migrated turn no longer has its recorded request identity.");
          }
          const event = { event: "runtime-turn", id: ownedId, nativeTurn: { startSeq: turn.startSeq, userSeq: first.seq }, requestIds, rebased: true };
          await writeFileAtomicNoFollow(project.rootDir, ledgerFile(project), serializeNext(events, event, this.maxBytes), { encoding: "utf8", mode: 0o600 });
          return foldEvents([...events, event]).get(ownedId);
        });
        knownRuns[knownRuns.findIndex((item) => item.id === ownedId)] = run;
      }
      if (!run) {
        const legacyOrdinary = knownRuns.filter((item) => item.sessionId === sessionId && item.dispatchId && !item.kernelRequestIds?.length);
        const legacyBaseline = (item) => {
          if (item.baselineCursor === null) return turns.some((candidate) => candidate.turn === 1) ? -1 : null;
          const cursor = /^seq_(\d+)$/.test(item.baselineCursor ?? "") ? Number(item.baselineCursor.slice(4)) : null;
          return cursor != null && transcript.messages.some((message) => message.seq === cursor) ? cursor : null;
        };
        const unknownLegacy = legacyOrdinary.some((item) => legacyBaseline(item) == null);
        const matches = legacyOrdinary.filter((item) => {
          const cursor = legacyBaseline(item);
          return cursor != null && turns.find((candidate) => candidate.startSeq > cursor)?.startSeq === turn.startSeq;
        });
        if (matches.length === 1 && requestIds.length && !unknownLegacy) {
          const legacyProject = await this.resolveRunProject(project, matches[0]);
          if (!legacyProject) continue;
          run = await this.bindLegacyKernelRequests(legacyProject, matches[0].id, requestIds);
          knownRuns[knownRuns.findIndex((item) => item.id === run.id)] = run;
        } else if (matches.length > 1 || unknownLegacy) {
          const notice = runNotice("run_legacy_unattributed",
            "Native replay could not be attributed because a legacy ordinary run has no unique verifiable input boundary.");
          for (const item of legacyOrdinary) if (!item.qualityNotices?.some((existing) => noticeText(existing) === notice.text) && !notifiedLegacy.has(item.id)) {
            const legacyProject = await this.resolveRunProject(project, item);
            if (!legacyProject) continue;
            await this.appendQualityNotices(legacyProject, item.id, [notice], { unchecked: true });
            notifiedLegacy.add(item.id);
          }
          continue;
        }
      }
      if (!run) {
        // The pre-turn ledger adopted exactly the first input of a session.
        // Bind that historical row once instead of replaying it as new work.
        const legacy = index === 0 ? knownRuns.find((item) => item.sessionId === sessionId && !item.nativeTurn
          && String(item.effectiveRouteReason ?? "").startsWith(adoptedRouteReason)) : null;
        const question = first.parts.map((part) => part.type === "text" ? part.text : "").join(" ").trim();
        const routed = legacy ? {} : await routeTurn(question);
        const reservation = await this.reserveRun(project, binding ?? {
          sessionId, mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null,
        }, {
          baselineCursor: `seq_${first.seq}`,
          nativeTurn: { startSeq: turn.startSeq, userSeq: first.seq },
          startedAt: turn.time > 0 ? new Date(turn.time).toISOString() : null,
          kernelRequestIds: requestIds,
          legacyRunId: legacy?.id,
          question: questionPreview(question),
          estimatedMinutes: routed.estimatedMinutes ?? null,
          forkedFrom: source,
          effectiveAgentId: routed.effectiveAgentId ?? binding?.agentId ?? null,
          effectiveAgentVersion: routed.effectiveAgentVersion ?? binding?.agentVersion ?? null,
          effectiveRuntimeAgent: routed.effectiveRuntimeAgent ?? binding?.runtimeAgent ?? null,
          effectiveRouteReason: `${adoptedRouteReason}${routed.effectiveRouteReason ? `:${routed.effectiveRouteReason}` : ""}`.slice(0, 64),
        });
        run = reservation.run;
        // The first run of a fork is named after the line it branched from,
        // 「分支：<that run's title>」; the researcher can rename it like any.
        if (reservation.owner && source && !knownRuns.some((item) => item.sessionId === sessionId && item.id !== run.id)) {
          const origin = knownRuns.filter((item) => item.sessionId === source)
            .sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)))[0];
          const named = [...String(origin?.title ?? "一次对话")];
          run = await this.recordRunLabels(project, run.id, {
            title: `分支：${named.length > 40 ? `${named.slice(0, 39).join("")}…` : named.join("")}`,
            titleSource: "auto",
          }).catch(() => run);
        }
        const knownIndex = knownRuns.findIndex((item) => item.id === run.id);
        if (knownIndex >= 0) knownRuns[knownIndex] = run;
        else knownRuns.push(run);
        if (reservation.owner && !run.effectiveRuntimeAgent) {
          await this.appendQualityNotices(project, run.id, [runNotice("run_adopted_unchecked",
            "The native input could not be assigned a deliverable contract; its delivery checks are unchecked.",
            { detail: "这次提问没有匹配到交付契约，所以没有做交付核验。" })], { unchecked: true });
        }
      }
      if (run.status === "running" && !(run.dispatchStatus === "dispatching" && this.dispatchOwners.has(run.id))) {
        const runProject = await this.resolveRunProject(project, run);
        if (!runProject) continue;
        await this.reconcileSession(runProject, sessionId, run.id);
        this.scheduleMonitor(runProject, run.id);
      }
    }
    const active = (await this.list(project)).filter((run) => run.sessionId === sessionId && run.status === "running");
    return active.sort((a, b) => (b.nativeTurn?.startSeq ?? -1) - (a.nativeTurn?.startSeq ?? -1))[0] ?? null;
  }

  async adoptRunningRuns(projects) {
    let adopted = 0;
    for (const project of projects) {
      /** @type {any[]} */
      let runs = [];
      try {
        runs = await this.list(project);
      } catch {
        // A project whose ledger cannot be read is not a reason to skip the
        // rest; its own reads will surface the problem to its own user.
        continue;
      }
      for (const run of runs) {
        if (run.status !== "running") continue;
        const runProject = await this.resolveRunProject(project, run);
        if (!runProject) continue;
        if (run.dispatchStatus === "dispatching" && !this.dispatchOwners.has(run.id)) {
          await this.markDispatch(runProject, run.id, "unknown");
        }
        this.scheduleMonitor(runProject, run.id);
        adopted += 1;
      }
    }
    return { adopted };
  }

  /**
   * Every child session this run started, for the transcript capture.
   *
   * The run-side projection is the only place that knows them: the kernel does
   * not emit `subagent/descriptor` into the parent's log at this pin, so the
   * transcript walk finds no children on its own and records the orchestrator
   * alone. `runSideActivity` reads the same file but filters to `running`
   * children, which at finish time is none of them — this wants all of them,
   * settled included, because a settled child is exactly the one whose work
   * needs keeping.
   *
   * Returns `[]` for a run that never delegated and for a projection that
   * cannot be read; the caller's own delegation count is what turns the second
   * case into a recorded gap rather than a silent one.
   *
   * @param {Record<string, any>} project @param {Record<string, any>} run
   * @returns {Promise<{ sessionId: string, label: string, capability: string|null }[]>}
   */
  async childSessionsOf(project, run) {
    const read = await readRunStateProjection(project, project.workspaceDir, run);
    if (read.state !== "read") return [];
    const seen = new Set();
    /** @type {{ sessionId: string, label: string, capability: string|null }[]} */
    const children = [];
    for (const child of read.projection?.subagents ?? []) {
      const sessionId = typeof child?.childSessionId === "string" ? child.childSessionId.trim() : "";
      if (!sessionId || seen.has(sessionId)) continue;
      seen.add(sessionId);
      children.push({
        sessionId,
        label: typeof child?.deliverableId === "string" && child.deliverableId ? child.deliverableId : "subagent",
        capability: typeof child?.capability === "string" && child.capability ? child.capability : null,
      });
      if (children.length >= 64) break;
    }
    return children;
  }

  async closeProject(project, status = "canceled") {
    const runs = await this.list(project);
    for (const run of runs.filter((item) => item.status === "running")) {
      const monitor = this.monitors.get(run.id);
      monitor?.cancel();
      // Awaited, not merely cancelled. `cancel()` sets a flag the loop reads
      // between polls; returning before the loop has actually stopped leaves a
      // monitor writing to storage the caller believes it has finished with,
      // and the failure surfaces somewhere else entirely — a run that cannot
      // be found, in a project directory that has already been removed.
      await monitor?.promise?.catch(() => {});
      if (status === "failed") {
        // The container exiting is what makes the transcript unreadable, so
        // this path and `reconcileSession`'s `runtime_not_running` branch are
        // two routes out of one event — and this one wins the race, because it
        // is driven by the exit itself rather than by the next read that
        // notices it. `finishInternal` no-ops on an already-terminal run, so
        // whichever arrives first decides. Writing `runtime_stopped` here
        // therefore made the durable bridge unreachable in exactly the case it
        // was built for: a finished package on disk, graded and receipted,
        // reported as a run that stopped before delivering.
        //
        // A cancel keeps its own verdict below: the operator asked for the run
        // to stop, and answering "succeeded" would contradict them.
        await this.finishFromDurableRecord(project, run);
        continue;
      }
      await this.finishInternal(project, run.id, {
        status,
        errorCode: "runtime_canceled",
        artifacts: [],
        // The platform stopping, not the researcher: said, because the inbox
        // tells the one and not the other.
        ...(status === "canceled" ? { canceledBy: "platform" } : {}),
      });
    }
  }

  async consumeRepairAuthorization(project, input, { revalidateRuntimeGeneration = async () => null } = {}) {
    return consumeRepairAuthorization(project, input, {
      runtimeGeneration: input?.runtimeGeneration,
      revalidateRuntimeGeneration,
      controlRunRepairing: async (controlPlaneRunId) => {
        const current = (await this.list(project)).find((candidate) => candidate.id === controlPlaneRunId);
        return current?.status === "running"
          && this.clinicalRepairBaselineCursors.has(controlPlaneRunId)
          && this.clinicalRepairSenders.has(controlPlaneRunId);
      },
    });
  }

  async closeAll() {
    for (const project of this.projects.values()) {
      try {
        await this.closeProject(project, "canceled");
      } catch {
        // isolated: evimed_agent_run_close_all_failures_total — one project's
        // ledger being unreadable (oversized, corrupted) must not stop every
        // other project's runs from being marked canceled on shutdown.
      }
    }
    await Promise.allSettled([...this.backgroundLabels]);
    this.projects.clear();
    this.dispatchOwners.clear();
    this.clinicalRepairAttempts.clear();
    this.clinicalStructuralRepairAttempts.clear();
    this.clinicalRepairBaselineCursors.clear();
    this.clinicalRepairSenders.clear();
  }
}

/** Test seam: the skill check's two routes, without a whole run around them.
 *  @param {any} project @param {any} assistantMessages @returns {Promise<Set<string>>} */
export function loadedOrInjectedSkillsForTest(project, assistantMessages, run = null) {
  return loadedOrInjectedSkills(project, assistantMessages, run);
}

/** Test seam: which receipt entries belong to one native run.
 * @param {Record<string, any>} receipt @param {Record<string, any>} run */
export function scopeNativeReceiptForTest(receipt, run) {
  return scopeNativeReceipt(receipt, run);
}

/** Test seam: the authenticated tool transcript binds one projection to one native run.
 * @param {Record<string, any>} projection @param {Record<string, any>} run
 * @param {{ receiptAccepted?: ReadonlySet<string> | null }} [options] */
export function scopeNativeProjectionForTest(projection, run, options) {
  return scopeNativeProjection(projection, run, options);
}

/** Test seam: child histories are the source-provenance boundary, not workspace projection JSON.
 * @param {Record<string, any>} project @param {Record<string, any>[]} messages @param {any} reader @param {string | null} [rootSessionId] */
export function readDelegatedAssistantMessagesForTest(project, messages, reader, rootSessionId = null) {
  return readDelegatedAssistantMessages(project, messages, reader, rootSessionId);
}

/** Test seam: repair snapshots live in control-plane-private project metadata. */
export function snapshotAcceptedPackageForRepairForTest(project, run, runtimeGeneration) {
  return snapshotAcceptedPackageForRepair(project, run, runtimeGeneration);
}

/** Test seam: one accepted digest authorizes exactly one revision transition. */
export function consumeRepairAuthorizationForTest(project, input, options) {
  return consumeRepairAuthorization(project, input, options);
}

/** Test seam: which files a message claims to have written, without a run
 *  around it. The spelling of one argument decided whether any DSH run was
 *  ever seen to produce an artifact.
 *  @param {any} message @param {string} runtimeWorkspaceRoot @returns {string[]} */
export function artifactCandidatesForTest(message, runtimeWorkspaceRoot) {
  return artifactCandidates(message, runtimeWorkspaceRoot);
}

/** Test seam: which delegations read evidence the caller will go on to quote.
 *  Both the tool name and the argument key had to widen together; widening one
 *  leaves the same silence with a shorter list of causes.
 *  @param {any[]} messages @returns {any[]} */
export function delegatedDocumentReadsForTest(messages) {
  return delegatedDocumentReads(messages);
}

/** Test seam: the instruction a rejected clinical package is sent back with.
 *  It used to open by ordering the run to execute a script this repository no
 *  longer contains, spending one bounded attempt on finding that out.
 *  @param {any[]} issues @param {any} [shrinkage] @param {boolean} [revisionRequired] @returns {string} */
export function clinicalEvidenceRepairPromptForTest(issues, shrinkage = null, revisionRequired = true) {
  return clinicalEvidenceRepairPrompt(issues, shrinkage, revisionRequired);
}
