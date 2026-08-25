import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  HttpError,
  normalizeWorkspaceRelativePath,
  openScopedFileNoFollow,
  randomId,
  readTextFileNoFollow,
  safeId,
  withProjectStorageMutation,
  writeFileAtomicNoFollow,
} from "./security.mjs";
import {
  citationIntegrityIssues,
  clinicalEvidencePackageErrorCode,
  coverageJudgeContext,
  validateClinicalEvidencePackage,
} from "./clinicalEvidenceQuality.mjs";
// The three classifications of a failure — repairable package, recoverable
// source, terminal source — moved into the domain when the run side started
// needing them too. They are re-exported here because the ledger's callers and
// its tests have always imported them from this module, and because a second
// definition is exactly the drift the move was made to stop.
import {
  isMcpToolName,
  repairableEvidencePackageErrorCodes,
  recoverableEvidenceSourceErrorCodes,
  runPhase,
  terminalEvidenceSourceErrorCodes,
  transitionEvents,
  transition as domainTransition,
  validateDeliveryReceipt,
  workspaceLayout,
} from "@evimed/domain";

export { repairableEvidencePackageErrorCodes, recoverableEvidenceSourceErrorCodes, terminalEvidenceSourceErrorCodes };

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

const ledgerFileName = "runs.jsonl";
const terminalStatuses = new Set(["succeeded", "failed", "canceled"]);
const startFields = new Set(["sessionId"]);
const dispatchFields = new Set([
  "sessionId",
  "dispatchId",
  "question",
  "effectiveAgentId",
  "effectiveAgentVersion",
  "effectiveRuntimeAgent",
  "effectiveRouteReason",
]);
const dispatchStatuses = new Set(["dispatching", "accepted", "unknown", "rejected"]);
const defaultMaxRuns = 1000;
const defaultMaxBytes = 1024 * 1024;
const maxArtifacts = 64;
const maxQualityNotices = 40;
const maxQualityNoticeLength = 300;

// Which rule picked the agent: `matched:adr-analysis`, `matched:named:peer-review`
// or `llm:0.83`. Recording the decision without the reason makes a wrong route
// indistinguishable from a right one taken for the wrong reason — the regex
// firing on a stray word and the classifier answering at 0.76 look identical in
// the ledger, and there is no way to tell which layer to fix.
const routeReasonPattern = /^[a-z][a-z0-9_.:-]{0,63}$/;

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
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.length > maxQuestionPreview ? `${collapsed.slice(0, maxQuestionPreview)}…` : collapsed;
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
  return {
    sessionId: safeId(input.sessionId, "research session id"),
    dispatchId: safeId(input.dispatchId, "agent run dispatch id"),
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
// server no longer holds — the brief lives in memory only, so a restart loses
// it — has its per-question coverage check skipped entirely, and used to finish
// with verification null: byte-identical, in the one machine-readable field
// operations and the UI read, to a package that passed the check. The same
// package with the brief in hand finished "unverified" with the missing
// question named. Losing the exam paper made the grade go up.
const verificationValues = Object.freeze(["unverified", "unchecked"]);

/** @param {any} value */
function normalizeVerification(value) {
  return verificationValues.includes(value) ? value : null;
}

function normalizeQualityNotices(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string" && item.trim())
    .slice(0, maxQualityNotices)
    .map((item) => item.slice(0, maxQualityNoticeLength));
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
        question: typeof event.question === "string" && event.question ? event.question : null,
        status: "running",
        createdAt: storedTimestamp(event.createdAt, "createdAt"),
        startedAt,
        finishedAt: null,
        durationMs: null,
        errorCode: null,
        artifacts: [],
        verification: null,
        qualityNotices: [],
        observedMessages: 0,
        observedToolCalls: 0,
        observedRunSideActivity: null,
        lastProgressAt: null,
      }));
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
      runs.set(id, Object.freeze({
        ...current,
        observedMessages: event.messages,
        observedToolCalls: event.toolCalls,
        // The run's own side of the same observation. Absent on a run that
        // writes no projection and on every row written before this field
        // existed, so it is carried only when present rather than defaulted —
        // a default would read as "we observed zero activity", which is a
        // different claim from "we have not been told".
        ...(typeof event.runSideActivity === "string" ? { observedRunSideActivity: event.runSideActivity } : {}),
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
      runs.set(id, Object.freeze({
        ...current,
        status: event.status,
        finishedAt: storedTimestamp(event.finishedAt, "finishedAt"),
        durationMs: event.durationMs,
        errorCode,
        artifacts,
        // A judgement can land either side of the delivery decision, so both
        // orders must fold to the same run. An admission already on the record
        // survives a terminal event that says nothing; a terminal finding
        // outranks it.
        verification: normalizeVerification(event.verification)
          ?? (current.verification === "unchecked" ? "unchecked" : null),
        // The run's own notices lead; anything appended after the fact — a
        // coverage judgement that was still running when the run finished —
        // follows, in whichever order the two events reached the ledger.
        qualityNotices: [
          ...(Array.isArray(event.qualityNotices) ? event.qualityNotices.filter((item) => typeof item === "string") : []),
          ...current.qualityNotices,
        ].slice(0, maxQualityNotices),
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
      const added = Array.isArray(event.qualityNotices)
        ? event.qualityNotices.filter((item) => typeof item === "string" && item)
        : [];
      runs.set(id, Object.freeze({
        ...current,
        verification: event.verification === "unchecked" && current.verification === null
          ? "unchecked"
          : current.verification,
        qualityNotices: [...current.qualityNotices, ...added].slice(0, maxQualityNotices),
      }));
      continue;
    }
    throw corrupt("Agent run ledger contains an unsupported event.");
  }
  return runs;
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

function serializeNext(events, event, maxBytes) {
  const text = `${[...events, event].map((item) => JSON.stringify(item)).join("\n")}\n`;
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new HttpError(413, "agent_runs_too_large", "Agent run ledger exceeds its size limit.");
  }
  return text;
}

function messageRole(message) {
  return message?.info?.role ?? message?.role;
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
// Missing deliverables that earn a code of their own rather than the generic
// one, because the generic one is discarded and these are repairable in place.
const missingOutputErrorCodes = Object.freeze({
  "question-coverage.json": "specialist_question_coverage_missing",
});
const missingOutputRepairAdvice = Object.freeze({
  "question-coverage.json":
    "Write one entry per atomic sub-question of the brief — split the numbered questions on 、, —, 或 and coordinate clauses — "
    + 'as {"schemaVersion":1,"entries":[{"id":"2.3","question":"<the sub-question, transcribed>","status":"answered","reportLines":[64],"claimIds":["CLM-005"]}]}. '
    + 'An entry with "status":"gap" carries searches:[{"query":"<a search this run actually ran>","database":"PubMed","searchedAt":"YYYY-MM-DD"}] instead, '
    + "and every query must appear in clinical-evidence-search.json. Everything the ledger needs is already in the package you have written.",
});


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

function successfulEvidenceSourceArtifacts(messages, runtimeWorkspaceRoot) {
  const artifacts = new Map();
  const runtimeRoot = path.resolve(runtimeWorkspaceRoot);
  for (const message of messages) {
    for (const part of message?.parts ?? []) {
      if (part?.type !== "tool" || part?.state?.status !== "completed" || !evidenceSourceTool(part.tool)) continue;
      const result = parsedToolResult(part);
      const hashes = result?.data?.artifactSha256s;
      if (
        result?.status !== "success"
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
  return injected;
}

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
      if (typeof name === "string" && name.trim()) loaded.add(name.trim());
    }
  }
  return loaded;
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

function successfulEvidenceSearchQueries(messages) {
  const searchTools = [
    "literature_search",
    "guideline_search",
    "biomedical_source_search",
  ];
  return messages
    .flatMap((message) => message?.parts ?? [])
    .filter((part) => (
      successfulToolPart(part)
      && typeof part.tool === "string"
      && searchTools.some((tool) => part.tool === tool || part.tool.endsWith(`_${tool}`))
    ))
    .map((part) => part?.state?.input?.query)
    .filter((query) => typeof query === "string" && query.trim());
}

function terminalFromMessages(messages) {
  for (const message of messages) {
    const error = message?.info?.error;
    const serialized = JSON.stringify(error ?? "").toLowerCase();
    if (serialized.includes("abort") || serialized.includes("cancel")) {
      return { status: "canceled", errorCode: "runtime_canceled" };
    }
    if (error) return { status: "failed", errorCode: "runtime_session_error" };
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
    if (!correctedByLaterSuccess) return { status: "failed", errorCode: "runtime_tool_error" };
  }
  return { status: "succeeded", errorCode: null };
}

/** @param {any} issues @param {any} shrinkage */
function clinicalEvidenceRepairPrompt(issues, shrinkage = null) {
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
    ...measured,
    "Revise the named files in the existing academic package in place: clinical-evidence-report.md, clinical-evidence-matrix.json, clinical-evidence-search.json, citation-ledger.csv, references.bib, citation-audit.md, or clinical-evidence-run.json.",
    "Patch clinical-evidence-report.md with the edit tool, changing only the lines the issues name. Do not rewrite it with the write tool: replacing the whole file regenerates it from what you still hold in context, which after a long run is a compressed recollection, so the report comes back shorter and you cannot tell that it did. Measured across four production repairs, every whole-file rewrite lost content — one shed 1,863 characters and the next 4,125 — while targeted edits held the report steady and ended slightly longer.",
    "The same applies to the other deliverables: change what an issue names and leave the rest alone, preserving already valid evidence and source metadata. Rewriting a whole file is warranted only when its structure is what the issue rejects, such as a JSON deliverable that no longer parses.",
    "Every JSON deliverable must remain strict JSON. Escape embedded quotation marks correctly instead of changing scientific wording to work around JSON syntax.",
    "Never create or modify a .evimed-sources artifact. When a material claim lacks usable support, go and retrieve one with the approved evidence tools. Deleting the claim is the last resort, not the first: it satisfies the gate while making the analysis smaller, and a report that answers the question is worth more than a shorter one that passes. If you do drop a claim, say in your reply which claim went and why no source could support it.",
    "Treat repeated numeric-fact messages as one report-wide audit task. For each number, first attach it to the citation and hidden matrix claim marker that support it; drop only the numbers that are genuinely incidental to the argument. Do not resolve this by stripping the report of its quantitative content — effect estimates, sample sizes and confidence intervals are the analysis, not decoration.",
    "This revision must not leave the report thinner than it was. You are repairing traceability, not trimming to fit; if the corrected report is materially shorter, you have removed evidence instead of grounding it.",
    "The search log must exactly match successful evidence-search calls from this run. Never invent, duplicate, or omit completed searches.",
    "Improve scientific synthesis, comparison, clinical reasoning, evidence appraisal, and applicability where the issues identify a substantive gap. A weighed cross-source conclusion (a synthesized claim backed by at least two supporting sources) is preferable to a chain of single-source restatements, and the report must state its bottom line early in readable prose. Do not pad the report, repeat conclusions, or add claims merely to increase counts.",
    "Every evidence-matrix claim must appear in the report on a line with its exact numbered citation and hidden claim marker. Emergency-call support quotes must include both the call action and the qualifying symptom condition.",
    "citation-audit.md must record the citation checks actually performed and their findings, including unresolved identifiers, duplicates, corrections or retractions, metadata-only records, and claim-source mismatches.",
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

function artifactCandidates(message, runtimeWorkspaceRoot) {
  const candidates = [];
  const runtimeRoot = path.resolve(runtimeWorkspaceRoot);
  for (const part of message?.parts ?? []) {
    if (
      part?.type !== "tool" ||
      !["write", "edit"].includes(part.tool) ||
      part?.state?.status !== "completed"
    ) continue;
    const value = part?.state?.input?.filePath ?? part?.state?.input?.path;
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

async function existingArtifacts(project, candidates) {
  const result = [];
  for (const relative of candidates) {
    let opened;
    try {
      opened = await openScopedFileNoFollow(project.workspaceDir, path.join(project.workspaceDir, relative));
      if (opened.stat.isFile()) result.push(relative);
    } catch { /* missing, escaped, or linked artifacts are not recorded */ }
    finally { await opened?.handle.close().catch(() => {}); }
  }
  return result;
}

async function readRequiredFile(project, relative) {
  const direct = await openWorkspaceText(project, relative);
  if (direct) return direct;
  // Then under the deliverable directories.
  //
  // A capability declares its outputs as bare names — `clinical-evidence-report
  // .md` — and the gate's own message still says "at the workspace root",
  // because that is where the OpenCode composition wrote them. The DSH
  // composition writes each package into `deliverables/<deliverableId>/`: one
  // run can deliver several, the path guard fences each one, and §9.5 makes
  // that directory the only input its validator accepts. So the same declared
  // name has two homes depending on which kernel produced it, and a gate that
  // knows only the first reports every DSH package as missing.
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
    return { text: await opened.handle.readFile("utf8"), stat: opened.stat };
  } catch {
    return null;
  } finally {
    await opened?.handle.close().catch(() => {});
  }
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
function delegatedDocumentReads(messages) {
  return messages
    .flatMap((message) => message?.parts ?? [])
    .filter((part) => part?.type === "tool" && part.tool === "task")
    .filter((part) => {
      const prompt = String(part?.state?.input?.prompt ?? "");
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
 *   qualityDegradable?: boolean,
 *   qualityUnverified?: boolean,
 *   qualityUnchecked?: boolean,
 *   qualityNotices?: string[],
 * }} SpecialistCompletionVerdict
 */

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
  judgeCoverage = null,
) {
  // Notices a check raises that do not decide the verdict. Collected here
  // because the checks below each return the moment they conclude, so a finding
  // that is not a reason to withhold anything has nowhere else to survive.
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
    judgeCoverage,
    skippedChecks,
  );
  const unchecked = skippedChecks.length > 0 ? { qualityUnchecked: true } : {};
  if (advisories.length === 0) return { ...outcome, ...unchecked };
  return outcome.errorCode
    ? { ...outcome, ...unchecked, qualityIssues: [...(outcome.qualityIssues ?? []), ...advisories] }
    : { ...outcome, ...unchecked, qualityNotices: advisories };
}

/**
 * Every skill this run actually had, from either route: the model loaded it
 * with the `skill` tool, or delegation injected its body into the child's
 * prompt. Both are "the capability's method was in front of the model"; only
 * the first leaves a tool call to scan for.
 * @param {any} project @param {any} assistantMessages @returns {Promise<Set<string>>}
 */
async function loadedOrInjectedSkills(project, assistantMessages) {
  const loaded = successfullyLoadedSkills(assistantMessages);
  const read = await readRunStateProjection(project, project.workspaceDir);
  if (read.state !== "read") return loaded;
  for (const name of injectedSkills(read.projection)) loaded.add(name);
  return loaded;
}

/** @param {any} project
 *  @param {any} run
 *  @param {any} agentRegistry
 *  @param {any} sourceArtifactProvenance
 *  @param {any} assistantMessages
 *  @param {string[]} advisories
 *  @param {any} briefText
 *  @param {((context: any) => void)|null} judgeCoverage
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
  judgeCoverage = null,
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
      const loadedSkills = await loadedOrInjectedSkills(project, assistantMessages);
      const requiredSkills = [...(agent.companionSkills ?? []), agent.skill];
      if (requiredSkills.some((skill) => !loadedSkills.has(skill))) {
        return {
          artifacts: [],
          errorCode: "specialist_required_skill_missing",
          qualityDegradable: true,
          // The managed-persona check did not run, which is what "unverified"
          // literally means. Unlike a bookkeeping gap between the report and
          // its apparatus, a reader cannot see that it was skipped.
          qualityUnverified: true,
          qualityIssues: [
            `The ${agent.skill} skill was not loaded in this turn; the reply was delivered without managed-persona verification.`,
          ],
        };
      }
    }
    if (agent.completionChecks.includes("citationsResolvable")) {
      const { blocking, advisory } = citationUrlDefects(assistantProse(assistantMessages));
      advisories.push(...advisory);
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
  if (agent.completionChecks.includes("skillsLoaded")) {
    const loadedSkills = await loadedOrInjectedSkills(project, assistantMessages);
    const requiredSkills = [...(agent.companionSkills ?? []), agent.skill];
    if (requiredSkills.some((skill) => !loadedSkills.has(skill))) {
      return { artifacts: [], errorCode: "specialist_required_skill_missing" };
    }
  }
  const required = agent.outputs.filter((output) => output.required).map((output) => output.path);
  const artifacts = [];
  const files = new Map();
  for (const relative of required) {
    const file = await readRequiredFile(project, relative);
    if (!file) {
      return {
        artifacts,
        errorCode: missingOutputErrorCodes[relative] ?? "specialist_required_output_missing",
        qualityIssues: [
          `The required deliverable ${relative} is not in the workspace. Write it at exactly that name, either at the workspace root or inside this deliverable\u0027s ${workspaceLayout.deliverablesDir}/<id>/ directory, before finishing.`,
          ...(missingOutputRepairAdvice[relative] ? [missingOutputRepairAdvice[relative]] : []),
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
    artifacts.push(relative);
  }
  if (agent.completionChecks.includes("citationsResolvable")) {
    const markdown = [...files].filter(([relative]) => relative.endsWith(".md")).map(([, text]) => text);
    const defects = markdown.map((text) => citationUrlDefects(text));
    advisories.push(...defects.flatMap((defect) => defect.advisory));
    const blocking = defects.flatMap((defect) => defect.blocking);
    if (blocking.length > 0) {
      // Naming the URL, as every other gate message here does. This returned a
      // bare error code, so a run died with nothing to act on and the reason
      // had to be recovered by replaying the predicate over the transcript.
      return { artifacts, errorCode: "specialist_citation_invalid", qualityIssues: blocking };
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
        qualityIssues: ["evidence-snapshot.json must contain strict valid JSON; escape quotation marks correctly inside string values."],
      };
    }
    if (!snapshot || typeof snapshot !== "object") {
      return {
        artifacts,
        errorCode: "specialist_evidence_snapshot_invalid",
        qualityIssues: ["evidence-snapshot.json must be a JSON object or array of source records, not a bare string or number."],
      };
    }
    const recordedUrls = new Set(citedHttpUrls(snapshotEntry[1]));
    if (!recordedUrls.size) {
      return {
        artifacts,
        errorCode: "specialist_evidence_snapshot_empty",
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
        qualityIssues: [
          "clinical-evidence-matrix.json must contain strict valid JSON; escape quotation marks correctly inside string values.",
        ],
      };
    }
    let runReceipt;
    try {
      runReceipt = JSON.parse(files.get("clinical-evidence-run.json") ?? "");
    } catch {
      return {
        artifacts,
        errorCode: "specialist_evidence_traceability_failed",
        qualityIssues: ["clinical-evidence-run.json must contain strict valid JSON."],
      };
    }
    const sourceArtifacts = new Map();
    const sourcePaths = runReceipt?.successfulSourceArtifacts;
    // Every return below used to be bare. A run that had preserved five sources
    // and written all seven deliverables was failed after 45 minutes because
    // its receipt omitted one field, and it was told only
    // "specialist_evidence_traceability_failed" — which is also why it could
    // not be repaired: the repair path requires issues to hand back, so a
    // silent failure is not merely unhelpful, it is unfixable.
    if (!Array.isArray(sourcePaths)) {
      return {
        artifacts,
        errorCode: "specialist_evidence_traceability_failed",
        qualityIssues: [
          "clinical-evidence-run.json must contain successfulSourceArtifacts: an array of the .evimed-sources paths this run preserved, one canonical path per distinct document.",
        ],
      };
    }
    if (sourcePaths.length > 48) {
      return {
        artifacts,
        errorCode: "specialist_evidence_traceability_failed",
        qualityIssues: [
          `clinical-evidence-run.json lists ${sourcePaths.length} source artifacts; at most 48 are accepted. List one canonical path per distinct document rather than every companion file.`,
        ],
      };
    }
    for (const rawPath of sourcePaths) {
      let relative;
      try {
        relative = normalizeWorkspaceRelativePath(rawPath, "source artifact path");
      } catch {
        return {
          artifacts,
          errorCode: "specialist_evidence_traceability_failed",
          qualityIssues: [
            `clinical-evidence-run.json lists ${JSON.stringify(rawPath)} as a source artifact, which is not a safe workspace path.`,
          ],
        };
      }
      if (relative !== rawPath || !relative.startsWith(".evimed-sources/")) {
        return {
          artifacts,
          errorCode: "specialist_evidence_traceability_failed",
          qualityIssues: [
            `clinical-evidence-run.json lists ${JSON.stringify(rawPath)} as a source artifact; it must be the exact .evimed-sources/... path a preserving tool returned, copied rather than typed.`,
          ],
        };
      }
      const expectedDigest = sourceArtifactProvenance.get(relative);
      if (!expectedDigest) {
        // The receipt names a file no preserving tool reported writing in this
        // run — a path typed from memory, a leftover from an earlier run, or a
        // file the run created itself. Whatever the cause, the run needs to be
        // told which path, and this returned bare: two production packages died
        // here with a complete report on disk and nothing to act on.
        return {
          artifacts,
          errorCode: "specialist_evidence_provenance_failed",
          qualityIssues: [
            `clinical-evidence-run.json lists ${relative}, but no evidence tool reported preserving that file during this run. List only the exact .evimed-sources/... paths the preserving tools returned in this run, copied from their output rather than typed.`,
          ],
        };
      }
      const sourceFile = await readRequiredFile(project, relative);
      if (!sourceFile) {
        return {
          artifacts,
          errorCode: "specialist_evidence_traceability_failed",
          qualityIssues: [`The source artifact ${relative} named in clinical-evidence-run.json does not exist in the workspace.`],
        };
      }
      if (sourceFile.stat.mtimeMs + 1_000 < Date.parse(run.startedAt)) {
        return {
          artifacts,
          errorCode: "specialist_evidence_traceability_failed",
          qualityIssues: [
            `The source artifact ${relative} predates this run, so it was not retrieved by it. Retrieve the source in this run, or drop the claims that rest on it.`,
          ],
        };
      }
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
    }
    const validation = validateClinicalEvidencePackage({
      reportText: files.get("clinical-evidence-report.md") ?? "",
      matrix,
      runReceipt,
      sourceArtifacts,
      executedSearchQueries: successfulEvidenceSearchQueries(assistantMessages),
      searchLogText: files.get("clinical-evidence-search.json") ?? "",
      referencesText: files.get("references.bib") ?? "",
      citationLedgerText: files.get("citation-ledger.csv") ?? "",
      citationAuditText: files.get("citation-audit.md") ?? "",
      questionCoverageText: files.get("question-coverage.json") ?? "",
      briefText,
      workspaceBriefText: (await readRequiredFile(project, workspaceBriefPath))?.text ?? null,
    });
    // Said out loud whichever way the package goes: an advisory rides on a
    // delivered run as a notice, and is appended to the issues of a failed one.
    // The alternative — a coverage check that quietly does less after a restart
    // — is a package delivered as if it had been checked against the brief.
    if (validation.coverageDegradedNotice) {
      advisories.push(validation.coverageDegradedNotice);
      // The notice explains it to a human. This is the same fact in the field a
      // machine reads: the brief-versus-ledger comparison did not happen.
      skippedChecks.push("brief-question-coverage");
    }
    // The semantic half, on a package that has already cleared every
    // deterministic check that can withhold it. Deliberately last, deliberately
    // conditional on there being nothing blocking: a package heading back round
    // the repair loop will be judged when it comes back clean, and a model call
    // per repair attempt is a cost with no reader on the other end.
    //
    // Started, not awaited. The judgement's median wall clock is 161 s (max 226
    // s over 29 live runs) and this function is awaited by reconcileSession,
    // which is awaited by the dispatch and start HTTP handlers — so awaiting it
    // here hung a user's request for three minutes to compute something that
    // cannot change the answer being computed. It produces notices only, so it
    // is attached to the run when it comes back.
    if (typeof judgeCoverage === "function" && validation.blockingIssues.length === 0) {
      try {
        judgeCoverage(coverageJudgeContext({
          briefText,
          questionCoverageText: files.get("question-coverage.json") ?? "",
          reportText: files.get("clinical-evidence-report.md") ?? "",
        }));
      } catch {
        // A judge that will not even start is a judge that did not run. It is
        // not a reason to withhold a package that passed everything that can
        // withhold it.
      }
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
      return {
        artifacts,
        // Which defect this is, so the repair loop hands the run the named
        // numbers instead of one code that means "something in the package".
        // Every code the gate can name is repairable: the package is complete
        // and the issue is actionable inside it.
        errorCode: clinicalEvidencePackageErrorCode(blocking),
        qualityIssues: [
          ...(delegationNotice ? [`MUST FIX — ${delegationNotice}`] : []),
          ...blocking.map((issue) => `MUST FIX — ${issue}`),
          ...rest,
        ],
        qualityDegradable: true,
        // "Unverified" is a statement about the evidence, so only a finding
        // about the evidence earns it. It used to fire on any remaining issue,
        // so a package whose only two notices were a gate bug of ours carried
        // the same mark as one with a quotation absent from its source — and a
        // mark that means everything means nothing. Bookkeeping still ships
        // attached to the run; it just no longer stamps it.
        qualityUnverified: blocking.length > 0 || Boolean(delegationNotice),
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
 * so the socket projects its four durable tables into `.evimed-run/state.json`
 * and that is what is read here. The path guard makes the file unwritable by
 * the model, so it is a projection of what happened rather than a claim about
 * it.
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
async function readDeliveryReceipt(project) {
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
  return validateDeliveryReceipt(parsed) ? parsed : null;
}

/**
 * The receipt's files, confirmed present and unchanged since they were graded.
 * @param {Record<string, any>} project
 * @param {import('@evimed/domain').DeliveryReceipt} receipt
 * @returns {Promise<{ artifacts: string[], mismatched: string[] }>}
 */
async function verifiedReceiptArtifacts(project, receipt) {
  /** @type {string[]} */
  const artifacts = [];
  /** @type {string[]} */
  const mismatched = [];
  for (const entry of receipt.entries ?? []) {
    for (const file of entry.files ?? []) {
      const relative = normalizeWorkspaceRelativePath(String(file.path ?? ""), "receipt artifact path");
      let opened;
      try {
        opened = await openScopedFileNoFollow(project.workspaceDir, path.join(project.workspaceDir, relative));
        if (!opened.stat.isFile()) { mismatched.push(relative); continue; }
        const digest = createHash("sha256").update(await opened.handle.readFile()).digest("hex");
        if (digest !== String(file.sha256 ?? "")) mismatched.push(relative);
        else artifacts.push(relative);
      } catch {
        mismatched.push(relative);
      } finally {
        await opened?.handle.close().catch(() => {});
      }
    }
  }
  return { artifacts: [...new Set(artifacts)].slice(0, maxArtifacts).sort(), mismatched: [...new Set(mismatched)] };
}

async function readRunStateProjection(project, workspaceRoot) {
  let text;
  try {
    text = await readTextFileNoFollow(workspaceRoot, path.join(workspaceRoot, workspaceLayout.runStateFile), "");
  } catch {
    // Unreadable for any reason the filesystem gives — including absent, which
    // `readTextFileNoFollow` reports as an empty string rather than a throw.
    return { state: "unreadable" };
  }
  if (!text) return { state: "missing" };
  try {
    const projection = JSON.parse(text);
    if (!projection || typeof projection !== "object" || Array.isArray(projection)) return { state: "unreadable" };
    return { state: "read", projection };
  } catch {
    return { state: "unreadable" };
  }
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
    this.model = String(options.model ?? "").trim();
    this.maxRuns = options.maxRuns ?? defaultMaxRuns;
    this.maxBytes = options.maxBytes ?? defaultMaxBytes;
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? (() => randomId("run_"));
    this.readSessionHistory = options.readSessionHistory ?? (async () => []);
    this.readSessionStatus = options.readSessionStatus ?? (async () => "idle");
    this.runtimeWorkspaceRoot = options.runtimeWorkspaceRoot ?? (async (project) => project.workspaceDir);
    /** Whoever forwards a run's own projection to the browser. @type {(project: any, run: any, type: string, data: any) => void} */
    this.onRunProjection = options.onRunProjection ?? (() => {});
    /** Per-run memory, so a fixed-interval poll does not repeat itself. */
    this.projectionDigests = new Map();
    this.projectionAdmissions = new Map();
    this.projectionNoticed = new Set();
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
    this.maxClinicalRepairAttempts = options.maxClinicalRepairAttempts ?? 2;
    if (!Number.isSafeInteger(this.maxClinicalRepairAttempts) || this.maxClinicalRepairAttempts < 0) {
      throw new TypeError("AgentRunStore maxClinicalRepairAttempts must be a non-negative integer.");
    }
    this.monitors = new Map();
    this.projects = new Map();
    this.dispatchOwners = new Set();
    this.clinicalRepairAttempts = new Map();
    this.clinicalRepairBaselineCursors = new Map();
    this.clinicalRepairSenders = new Map();
    // Report size when repair first began, so a shrinking revision is measured
    // against where it started rather than against the previous attempt only.
    this.clinicalRepairReportSizes = new Map();
    // The brief each in-flight run was dispatched with, by run id. In memory
    // only: it is what the delivery gate checks question coverage against, and
    // it is far too large for the run ledger (see normalizeDispatchInput).
    // A restart therefore loses it, and the gate degrades in the open rather
    // than checking a brief the run itself could have written.
    this.dispatchedBriefs = new Map();
    // The semantic coverage judge (coverageJudge.mjs), or null in a deployment
    // that has none. It is asked at most once per run: the entry is written
    // before the call so a second pass over the same finished run — the monitor
    // polls, and a repair loop re-enters this path — reuses the answer instead
    // of paying for it again.
    this.coverageJudge = options.coverageJudge ?? null;
    /** @type {Map<string, Promise<{ notices: string[], judged?: boolean }>>} */
    this.coverageJudgements = new Map();
    if (!this.model) throw new Error("AgentRunStore requires a configured model.");
  }

  /** Announce a committed state change. Isolated: a listener must never be able
   *  to fail the write it is observing.
   *  isolated: evimed_run_state_listener_failures_total
   *  @param {Record<string, any>} project @param {Record<string, any> | null | undefined} run */
  notifyState(project, run) {
    if (!run) return;
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

  async recover(project) {
    let runs = await this.list(project);
    for (const run of runs.filter((item) => item.status === "running")) {
      if (run.dispatchStatus === "dispatching" && !this.dispatchOwners.has(run.id)) {
        await this.markDispatch(project, run.id, "unknown");
      }
      this.scheduleMonitor(project, run.id);
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
    question = null,
    effectiveAgentId = session.mode === "specialist" ? session.agentId : null,
    effectiveAgentVersion = session.mode === "specialist" ? session.agentVersion : null,
    effectiveRuntimeAgent = session.mode === "specialist" ? session.runtimeAgent : null,
    effectiveRouteReason = session.mode === "specialist" ? "session-binding" : null,
  } = {}) {
    return withProjectStorageMutation(project, async () => {
      const events = parseEvents(await readLedgerText(project, this.maxBytes));
      const runs = foldEvents(events);
      const duplicate = dispatchId == null
        ? null
        : [...runs.values()].find((run) => run.dispatchId === dispatchId);
      if (duplicate) return { run: duplicate, owner: false };
      if ([...runs.values()].some((run) => run.sessionId === session.sessionId && run.status === "running")) {
        throw new HttpError(409, "agent_run_active", "This research session already has an active run.");
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
        createdAt: now,
        startedAt: now,
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
    const unknown = await this.markDispatch(project, run.id, "unknown");
    this.projects.set(`${project.userId}:${project.id}`, project);
    this.scheduleMonitor(project, run.id);
    return unknown;
  }

  async dispatch(project, input, sendPrompt) {
    const {
      sessionId,
      dispatchId,
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
    const reservation = await this.reserveRun(project, session, { baselineCursor, dispatchId, question, ...selected });
    const record = reservation.run;
    if (!reservation.owner) return this.existingDispatch(project, record);
    this.projects.set(`${project.userId}:${project.id}`, project);
    // The brief, before the prompt goes out, so it is held whatever happens
    // next. This is the authoritative copy and the only one the gate reads.
    if (briefText) {
      this.dispatchedBriefs.set(record.id, briefText);
      await this.writeWorkspaceBrief(project, briefText);
    }
    try {
      const result = await sendPrompt(session, record);
      if (result?.accepted === false) {
        throw new HttpError(502, "runtime_prompt_rejected", "Runtime rejected the prompt before accepting it.");
      }
      const accepted = await this.markDispatch(project, record.id, "accepted");
      this.clinicalRepairSenders.set(record.id, (repairText) => sendPrompt(session, record, repairText));
      this.scheduleMonitor(project, record.id);
      return accepted;
    } catch (error) {
      if (error?.code === "runtime_prompt_rejected" || error?.definitivelyRejected === true) {
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

  /** One semantic coverage judgement per run, off the request path.
   *
   *  Started here and never awaited by the caller: the delivery decision does
   *  not depend on it and must not wait three minutes for it. When it comes
   *  back, its notices are appended to the run wherever the run has got to —
   *  including after the run has finished, which is the normal case.
   *
   *  The cost ceiling is the other point: one run, one model call. The
   *  in-flight promise is cached rather than its result, so two monitor passes
   *  landing together do not both issue a call, and the entry survives a repair
   *  round so a re-judged package is not paid for twice.
   *  @param {any} project @param {string} runId @param {any} context */
  scheduleCoverageJudgement(project, runId, context) {
    // No judge, or nothing judgeable: no call, and nothing to remember.
    if (!this.coverageJudge || !context) return null;
    const existing = this.coverageJudgements.get(runId);
    if (existing) return existing;
    const pending = (async () => {
      /** @type {any} */
      let result;
      try {
        result = await this.coverageJudge.judge(context);
      } catch {
        // A judge that throws is a judge that did not run, and a run already
        // delivered is not revisited for it.
        result = { notices: [], judged: false, verdicts: [] };
      }
      const notices = Array.isArray(result?.notices) ? result.notices : [];
      if (notices.length > 0) {
        try {
          // A judge that was asked and could not answer says so, and that is
          // the "this layer was not checked" fact, not a finding about the
          // package. It may only add the admission, never withdraw one.
          const unchecked = result?.judged === false;
          await this.appendQualityNotices(project, runId, notices, { unchecked });
        } catch (error) {
          process.stderr.write(
            `coverage judgement could not be attached to ${runId}: ${error?.code ?? (error instanceof Error ? error.message : String(error))}\n`,
          );
        }
      }
      return result;
    })();
    this.coverageJudgements.set(runId, pending);
    return pending;
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

  /** Wait for every coverage judgement still in flight. Shutdown and tests
   *  only — no request path may call this, which is the whole point of D2. */
  async settleCoverageJudgements() {
    await Promise.allSettled([...this.coverageJudgements.values()]);
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
    const receipt = await readDeliveryReceipt(project);
    if (!receipt) {
      // Nothing durable: the runtime really did stop before it delivered.
      // Whatever the projection saw of it travels with the verdict, because a
      // run that died mid-flight is exactly when its last recorded state is
      // worth having.
      const projection = await readRunStateProjection(project, project.workspaceDir);
      // Deduplicated against what the run already admitted while it was alive.
      // `publishRunProjection` puts these same lines on the ledger as they
      // appear, so re-adding the whole set here reported every admission twice
      // for a run the monitor had been watching, and not at all for one that
      // died before its first poll. The set is the same one that path keeps.
      const admitted = this.projectionAdmissions.get(run.id) ?? new Set();
      const notices = (projection.state === "read"
        ? [...(projection.projection?.degraded ?? []), ...(projection.projection?.qualityNotices ?? [])]
        : []
      ).filter((line) => typeof line === "string" && line && !admitted.has(line));
      return this.finishInternal(project, run.id, {
        status: "failed",
        errorCode: "runtime_stopped",
        artifacts: [],
        ...(notices.length ? { qualityNotices: notices.slice(0, 20) } : {}),
      });
    }
    const { artifacts, mismatched } = await verifiedReceiptArtifacts(project, receipt);
    if (mismatched.length) {
      // A file that does not match the digest it was graded under is not the
      // file that was graded. Refusing is the only honest answer: the
      // alternative is delivering something no gate has seen.
      return this.finishInternal(project, run.id, {
        status: "failed",
        errorCode: "specialist_receipt_digest_mismatch",
        artifacts: [],
        qualityNotices: mismatched.slice(0, 10).map((entry) => `delivery-receipt.json names ${entry} with a digest the file no longer matches`),
      });
    }
    return this.finishInternal(project, run.id, {
      status: "succeeded",
      errorCode: null,
      artifacts,
      qualityNotices: receipt.entries.flatMap((entry) => entry.notices ?? []).slice(0, 20),
    });
  }

  async finishInternal(project, rawRunId, terminal) {
    const runId = safeId(rawRunId, "agent run id");
    if (!terminalStatuses.has(terminal.status)) throw new Error("Invalid internal terminal status.");
    const normalized = {
      status: terminal.status,
      errorCode: sanitizeErrorCode(terminal.errorCode),
      artifacts: normalizeArtifacts(terminal.artifacts),
      verification: normalizeVerification(terminal.verification),
      qualityNotices: normalizeQualityNotices(terminal.qualityNotices),
    };
    const outcome = await withProjectStorageMutation(project, async () => {
      const events = parseEvents(await readLedgerText(project, this.maxBytes));
      const runs = foldEvents(events);
      const current = runs.get(runId);
      if (!current) throw new HttpError(404, "agent_run_not_found", "Agent run not found.");
      if (current.status !== "running") return { run: current, transitioned: false };
      const finishedAt = this.now().toISOString();
      const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(current.startedAt));
      const event = { event: "finished", id: runId, ...normalized, finishedAt, durationMs };
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
      this.clinicalRepairBaselineCursors.delete(runId);
      this.clinicalRepairSenders.delete(runId);
      this.clinicalRepairReportSizes.delete(runId);
      // The projection memories are per-run gauges, not a record: a finished
      // run's digests and admissions would otherwise be held for the life of
      // the process.
      this.projectionDigests.delete(runId);
      this.projectionAdmissions.delete(runId);
      this.projectionNoticed.delete(runId);
      // The gate has already run by the time a run reaches a terminal state,
      // so the brief has done its work; keeping it would grow with every run.
      this.dispatchedBriefs.delete(runId);
      // The judgement is not on the delivery path any more, so a terminal run
      // routinely still has one in flight. Dropping the entry here would drop
      // the only thing stopping a second, separately billed call — so it is
      // released when the call settles, not when the run does.
      const pendingJudgement = this.coverageJudgements.get(runId);
      if (pendingJudgement) {
        const release = () => {
          if (this.coverageJudgements.get(runId) === pendingJudgement) this.coverageJudgements.delete(runId);
        };
        pendingJudgement.then(release, release);
      }
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

  async cancelSession(project, rawSessionId) {
    const sessionId = safeId(rawSessionId, "research session id");
    const run = (await this.list(project)).find(
      (item) => item.sessionId === sessionId && item.status === "running",
    );
    if (!run) return null;
    this.monitors.get(run.id)?.cancel();
    return this.finishInternal(project, run.id, {
      status: "canceled",
      errorCode: "runtime_canceled",
      artifacts: [],
    });
  }

  async reconcileSession(project, sessionId) {
    const events = parseEvents(await readLedgerText(project, this.maxBytes));
    const runs = foldEvents(events);
    const run = [...runs.values()].find((item) => item.sessionId === sessionId && item.status === "running");
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
    const baselineIndex = baselineCursor == null
      ? -1
      : history.findIndex((message) => messageId(message) === baselineCursor);
    if (baselineCursor != null && baselineIndex < 0) return run;
    const allAssistants = history
      .slice(baselineIndex + 1)
      .filter((message) => messageId(message) && messageRole(message) === "assistant" && assistantFinished(message));
    const repairBaselineCursor = this.clinicalRepairBaselineCursors.get(run.id) ?? null;
    const repairBaselineIndex = repairBaselineCursor == null
      ? baselineIndex
      : history.findIndex((message) => messageId(message) === repairBaselineCursor);
    if (repairBaselineCursor != null && repairBaselineIndex < 0) return run;
    const assistants = history
      .slice(repairBaselineIndex + 1)
      .filter((message) => messageId(message) && messageRole(message) === "assistant" && assistantFinished(message));
    if (assistants.length === 0) return run;
    let sessionStatus;
    try {
      sessionStatus = await this.readSessionStatus(project, sessionId, { wake: false });
    } catch {
      return run;
    }
    if (sessionStatus !== "idle") return run;
    const terminal = terminalFromMessages(assistants);
    let runtimeWorkspaceRoot;
    try {
      runtimeWorkspaceRoot = await this.runtimeWorkspaceRoot(project);
    } catch {
      runtimeWorkspaceRoot = project.workspaceDir;
    }
    const candidates = [...new Set(
      allAssistants.flatMap((message) => artifactCandidates(message, runtimeWorkspaceRoot)),
    )].slice(0, maxArtifacts).sort();
    let artifacts = await existingArtifacts(project, candidates);
    if (terminal.status === "succeeded" && run.effectiveAgentId) {
      let completion;
      try {
        const sourceArtifactProvenance = successfulEvidenceSourceArtifacts(allAssistants, runtimeWorkspaceRoot);
        completion = await requiredSpecialistArtifacts(
          project,
          run,
          this.agentRegistry,
          sourceArtifactProvenance,
          allAssistants,
          // Only what this process dispatched. A run recovered from the ledger
          // after a restart has no brief here, and the gate is told so rather
          // than reading the copy in the workspace.
          this.dispatchedBriefs.get(run.id) ?? null,
          // Fire-and-forget by design: the gate hands the judge its context and
          // carries on deciding. See scheduleCoverageJudgement.
          this.coverageJudge ? (context) => { this.scheduleCoverageJudgement(project, run.id, context); } : null,
        );
      } catch {
        completion = { artifacts: [], errorCode: "specialist_contract_unavailable" };
      }
      artifacts = [...new Set([...artifacts, ...completion.artifacts])].sort();
      if (completion.errorCode) {
        const repairSender = this.clinicalRepairSenders.get(run.id);
        const repairAttempts = this.clinicalRepairAttempts.get(run.id) ?? 0;
        const canRepair = run.effectiveAgentId === "clinical-evidence-synthesis"
          && repairableEvidencePackageErrorCodes.has(completion.errorCode)
          && Array.isArray(completion.qualityIssues)
          && completion.qualityIssues.length > 0
          && repairAttempts < this.maxClinicalRepairAttempts
          && typeof repairSender === "function";
        if (canRepair) {
          this.clinicalRepairAttempts.set(run.id, repairAttempts + 1);
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
            const repair = await repairSender(clinicalEvidenceRepairPrompt(completion.qualityIssues, previous));
            if (repair?.accepted !== false) return run;
          } catch { /* a rejected repair remains a terminal, fail-closed outcome */ }
          terminal.status = "failed";
          terminal.errorCode = "specialist_evidence_repair_failed";
          terminal.qualityNotices = completion.qualityIssues;
        } else if (completion.qualityDegradable) {
          // Repairs are exhausted or unavailable and only process-documentation
          // or presentation gaps remain (no integrity or structural violation).
          // Deliver the package marked "unverified" with the reasons attached
          // instead of discarding the whole run.
          terminal.status = "succeeded";
          terminal.errorCode = null;
          // A finding outranks an admission: "we checked and it did not hold
          // up" is the more serious of the two and is what the reader is shown.
          terminal.verification = completion.qualityUnverified
            ? "unverified"
            : completion.qualityUnchecked ? "unchecked" : null;
          terminal.qualityNotices = completion.qualityIssues;
        } else {
          terminal.status = "failed";
          terminal.errorCode = completion.errorCode;
          if (Array.isArray(completion.qualityIssues)) terminal.qualityNotices = completion.qualityIssues;
        }
      } else {
        // Nothing withheld the package. A check may still have had something to
        // say — and a check may not have run at all, which is the one thing a
        // clean-looking delivery must not be allowed to hide.
        if (completion.qualityUnchecked) terminal.verification = "unchecked";
        if (Array.isArray(completion.qualityNotices) && completion.qualityNotices.length > 0) {
          terminal.qualityNotices = [...(terminal.qualityNotices ?? []), ...completion.qualityNotices];
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
        `The report was replaced with the write tool ${rewrites.length} time(s) while repairing, instead of being patched with edit; a rewrite regenerates the report from context rather than from the evidence on disk.`,
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
          `Repair reduced the report from ${startSize} to ${finalSize} characters (${lost}% smaller) over ${repairSizes.length} round(s); traceability was restored by removing analysis rather than by grounding it.`,
        ];
      }
    }
    return this.finishInternal(project, run.id, { ...terminal, artifacts });
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
   * signal, the browser's evidence and budget frames, and the run's own
   * quality notices. They are together because they come from one file and
   * splitting them would mean reading it three times on three schedules.
   *
   * @param {any} project @param {Record<string, any>} run
   * @returns {Promise<{ signature: string | null, unreadable: boolean }>}
   */
  async readRunSideActivity(project, run) {
    let workspaceRoot;
    try {
      workspaceRoot = await this.runtimeWorkspaceRoot(project);
    } catch {
      workspaceRoot = project.workspaceDir;
    }
    const read = await readRunStateProjection(project, workspaceRoot);
    if (read.state === "missing") return { signature: null, unreadable: false };
    if (read.state === "unreadable") {
      // Said once per run, not once per poll: the monitor wakes on a fixed
      // interval and a notice per wake would bury the ledger in one repeated
      // sentence. isolated: evimed_run_projection_unreadable_total
      if (!this.projectionNoticed.has(run.id)) {
        this.projectionNoticed.add(run.id);
        await this.appendQualityNotices(project, run.id, [
          "运行自述文件 .evimed-run/state.json 无法解析，本次运行的证据与预算明细不可见；运行本身不受影响。",
        ]).catch(() => {});
      }
      return { signature: null, unreadable: true };
    }
    const projection = read.projection ?? {};
    this.publishRunProjection(project, run, projection);
    return { signature: runSideActivitySignature(projection), unreadable: false };
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

    // The run's own admissions ride the ledger, not the stream: they outlive
    // the socket a browser is holding, and a reader who opens the run tomorrow
    // must still see that a layer went unchecked.
    const admissions = [
      ...(Array.isArray(projection?.degraded) ? projection.degraded : []),
      ...(Array.isArray(projection?.qualityNotices) ? projection.qualityNotices : []),
    ].filter((line) => typeof line === "string" && line);
    const already = this.projectionAdmissions.get(run.id) ?? new Set();
    const fresh = admissions.filter((line) => !already.has(line));
    if (!fresh.length) return;
    for (const line of fresh) already.add(line);
    this.projectionAdmissions.set(run.id, already);
    this.appendQualityNotices(project, run.id, fresh).catch(() => {});
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
    const messages = history.length;
    const toolCalls = history.reduce(
      (total, message) => total + (message?.parts ?? []).filter((part) => part?.type === "tool").length,
      0,
    );

    // The run's own projection, read on the monitor's existing cycle rather
    // than on a loop of its own. This is what makes a delegated stretch
    // distinguishable from a dead run: the two counts above are the root
    // session's, and the root session is *supposed* to go quiet while its
    // children work. Before this, a run that delegated and waited looked
    // exactly like one that had died, and the stall threshold closed it.
    const runSide = await this.readRunSideActivity(project, run);
    const activity = runSide.signature;

    const stillByHistory = messages === (run.observedMessages ?? 0) && toolCalls === (run.observedToolCalls ?? 0);
    const stillByRunSide = activity === null || activity === (run.observedRunSideActivity ?? null);
    // Unreadable is neither moved nor still. Returning `false` here would make
    // a corrupt projection feed the stall counter, which is the same mistake
    // the history read already learned not to make one function up.
    if (runSide.unreadable && stillByHistory) return null;
    if (stillByHistory && stillByRunSide) return false;
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
      };
      // Only the latest observation of a run is worth keeping. Appending every
      // one filled the ledger with 7,800 progress rows across 31 runs and left
      // it 114 bytes under the limit, after which no further run could start at
      // all: the ledger holds started/dispatch/finished, which cannot be
      // dropped, in the same bounded file as progress, which is a live gauge
      // and is replaced by its successor. Superseded rows for this run go.
      const retained = events.filter((item) => !(item?.event === "progress" && item?.id === run.id));
      const text = serializeNext(retained, event, this.maxBytes);
      await writeFileAtomicNoFollow(project.rootDir, ledgerFile(project), text, { encoding: "utf8", mode: 0o600 });
    });
    return true;
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
      // eslint-disable-next-line no-unmodified-loop-condition -- set by the cancel closure registered below
      for (let poll = 0; poll < this.monitorMaxPolls && !canceled; poll += 1) {
        const runs = await this.list(project);
        const run = runs.find((item) => item.id === runId);
        if (!run || run.status !== "running") return;
        const reconciled = await this.reconcileSession(project, run.sessionId);
        if (reconciled?.status !== "running") return;
        // A ledger of started/dispatch/finished cannot tell a run that is
        // working from one that died an hour ago, so both wait out the full
        // timeout. Record what is observably happening, and stop early once
        // nothing has happened for long enough that nothing will.
        // Three outcomes, not two: it moved, it did not move, or we could not
        // tell. Only the middle one is evidence of a stall.
        const moved = await this.recordProgress(project, run).catch(() => null);
        if (moved === true) idlePolls = 0;
        else if (moved === false) idlePolls += 1;
        if (this.monitorStallPolls > 0 && idlePolls >= this.monitorStallPolls) {
          await this.finishInternal(project, runId, {
            status: "failed",
            errorCode: "runtime_monitor_stalled",
            artifacts: [],
          });
          return;
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
    })().finally(() => {
      if (this.monitors.get(runId)?.promise === promise) this.monitors.delete(runId);
    });
    this.monitors.set(runId, { promise, cancel: () => { canceled = true; wake?.(); } });
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
      });
    }
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
    this.projects.clear();
    this.dispatchOwners.clear();
    // Not awaited: a judgement can take minutes and shutdown must not wait on
    // one. Anything still in flight will fail its append against a store that
    // is going away, which scheduleCoverageJudgement already swallows.
    this.coverageJudgements.clear();
    this.clinicalRepairAttempts.clear();
    this.clinicalRepairBaselineCursors.clear();
    this.clinicalRepairSenders.clear();
  }
}

/** Test seam: the skill check's two routes, without a whole run around them.
 *  @param {any} project @param {any} assistantMessages @returns {Promise<Set<string>>} */
export function loadedOrInjectedSkillsForTest(project, assistantMessages) {
  return loadedOrInjectedSkills(project, assistantMessages);
}
