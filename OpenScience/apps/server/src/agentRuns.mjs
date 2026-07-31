import { createHash } from "node:crypto";
import path from "node:path";
import {
  HttpError,
  normalizeWorkspaceRelativePath,
  openScopedFileNoFollow,
  randomId,
  safeId,
  withProjectStorageMutation,
  writeFileAtomicNoFollow,
} from "./security.mjs";
import { citationIntegrityIssues, validateClinicalEvidencePackage } from "./clinicalEvidenceQuality.mjs";

const ledgerFileName = "runs.jsonl";
const terminalStatuses = new Set(["succeeded", "failed", "canceled"]);
const startFields = new Set(["sessionId"]);
const dispatchFields = new Set([
  "sessionId",
  "dispatchId",
  "effectiveAgentId",
  "effectiveAgentVersion",
  "effectiveRuntimeAgent",
]);
const dispatchStatuses = new Set(["dispatching", "accepted", "unknown", "rejected"]);
const defaultMaxRuns = 1000;
const defaultMaxBytes = 1024 * 1024;
const maxArtifacts = 64;
const maxQualityNotices = 40;
const maxQualityNoticeLength = 300;

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
  return {
    sessionId: safeId(input.sessionId, "research session id"),
    dispatchId: safeId(input.dispatchId, "agent run dispatch id"),
    effectiveAgentId: input.effectiveAgentId ?? null,
    effectiveAgentVersion: input.effectiveAgentVersion ?? null,
    effectiveRuntimeAgent: input.effectiveRuntimeAgent ?? null,
  };
}

function sanitizeErrorCode(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw invalid("errorCode must be a string.");
  const normalized = value.trim().toLowerCase();
  return /^[a-z][a-z0-9_.-]{0,63}$/.test(normalized) ? normalized : "runtime_error";
}

function normalizeVerification(value) {
  return value === "unverified" ? "unverified" : null;
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
        model: event.model,
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
        verification: event.verification === "unverified" ? "unverified" : null,
        qualityNotices: Array.isArray(event.qualityNotices)
          ? event.qualityNotices.filter((item) => typeof item === "string").slice(0, maxQualityNotices)
          : [],
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

const evidenceSourceToolSuffixes = Object.freeze([
  "evimed_official_page_fetch",
  "evimed_open_access_full_text",
]);
const recoverableEvidenceSourceErrorCodes = new Set([
  "full_text_not_available",
  "full_text_upstream_unavailable",
  "official_page_upstream_unavailable",
]);

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
    "evimed_literature_search",
    "evimed_guideline_search",
    "evimed_biomedical_source_search",
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
    if (typeof part.tool !== "string" || !part.tool.includes("evimed_")) continue;
    const errorCode = parsedToolErrorCode(part);
    if (evidenceSourceTool(part.tool) && recoverableEvidenceSourceErrorCodes.has(errorCode)) continue;
    const correctedByLaterSuccess = toolParts.slice(index + 1).some((candidate) => (
      candidate.tool === part.tool && successfulToolPart(candidate)
    ));
    if (!correctedByLaterSuccess) return { status: "failed", errorCode: "runtime_tool_error" };
  }
  return { status: "succeeded", errorCode: null };
}

function clinicalEvidenceRepairPrompt(issues) {
  const bounded = issues
    .filter((issue) => typeof issue === "string" && issue.trim())
    .slice(0, 40)
    .map((issue) => `- ${issue.slice(0, 300)}`)
    .join("\n");
  return [
    "The server-side clinical evidence gate rejected the current package.",
    "Revise the named files in the existing academic package in place: clinical-evidence-report.md, clinical-evidence-matrix.json, clinical-evidence-search.json, citation-ledger.csv, references.bib, citation-audit.md, or clinical-evidence-run.json.",
    "Only rewrite a file when an issue below names or requires it; preserve already valid evidence and source metadata.",
    "Every JSON deliverable must remain strict JSON. Escape embedded quotation marks correctly instead of changing scientific wording to work around JSON syntax.",
    "Never create or modify a .evimed-sources artifact. If a material claim lacks usable support, retrieve an additional verified source with the approved evidence tools or remove the claim; never patch around missing evidence.",
    "Treat repeated numeric-fact messages as one report-wide audit task: remove nonessential numbers or place each retained quantitative proposition on a line with the correct numbered citation and matching hidden matrix claim marker.",
    "The search log must exactly match successful evidence-search calls from this run. Never invent, duplicate, or omit completed searches.",
    "Improve scientific synthesis, comparison, clinical reasoning, evidence appraisal, and applicability where the issues identify a substantive gap. A weighed cross-source conclusion (a synthesized claim backed by at least two supporting sources) is preferable to a chain of single-source restatements, and the report must state its bottom line early in readable prose. Do not pad the report, repeat conclusions, or add claims merely to increase counts.",
    "Every evidence-matrix claim must appear in the report on a line with its exact numbered citation and hidden claim marker. Emergency-call support quotes must include both the call action and the qualifying symptom condition.",
    "citation-audit.md must record the citation checks actually performed and their findings, including unresolved identifiers, duplicates, corrections or retractions, metadata-only records, and claim-source mismatches.",
    "Keep only limitations that materially affect interpretation, and synthesize them rather than writing a checklist. Remove tool names, gateway names, and first-person retrieval diaries from the analysis; a material limit on evidence accessibility (for example, a guideline whose full text is not openly available) belongs in the Limitations section, stated as a property of the evidence base rather than a narration of the retrieval run.",
    "The safety-first practical section must come before the reference list. Remove unsupported self-care details; every numbered step and bullet must have direct support, a numbered citation, and a matching hidden claim marker.",
    "After fixing the files, run: python \"$XDG_CONFIG_HOME/opencode/skills/clinical-evidence-synthesis/scripts/preflight.py\" --workspace .",
    "Fix every preflight issue, rerun it until it returns ok=true, and read every required deliverable back before finishing:",
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

function citedHttpUrls(text) {
  // Exclude and strip trailing ASCII and CJK/full-width punctuation so a URL
  // written in Chinese prose (…example-a。) matches the same URL recorded inside
  // JSON quotes in the snapshot.
  return [...String(text).matchAll(/https?:\/\/[^\s)\]}>"'，。；、）】》「」『』！？…]+/g)]
    .map((match) => match[0].replace(/[.,;，。；、）】》「」『』！？…]+$/, ""));
}

function validExplicitCitations(text) {
  const urls = [...String(text).matchAll(/https?:\/\/[^\s)\]}>"']+/g)].map((match) => match[0]);
  return urls.every((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && !url.hash
        && !(url.hostname === "www.evimed.com" && url.pathname.startsWith("/api-evimed/"));
    } catch {
      return false;
    }
  });
}

function assistantProse(messages) {
  return messages
    .flatMap((message) => message?.parts ?? [])
    .filter((part) => part?.type === "text" && typeof part?.text === "string")
    .map((part) => part.text)
    .join("\n");
}

async function requiredSpecialistArtifacts(
  project,
  run,
  agentRegistry,
  sourceArtifactProvenance = new Map(),
  assistantMessages = [],
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
    // must be well-formed (HTTPS, no credentials, no internal API endpoints).
    // A direct answer with zero citations is legitimate and passes. A missing
    // skill load is a process gap, not an integrity violation: deliver the
    // reply marked "unverified" instead of discarding a sound answer.
    if (agent.completionChecks.includes("skillsLoaded")) {
      const loadedSkills = successfullyLoadedSkills(assistantMessages);
      const requiredSkills = [...(agent.companionSkills ?? []), agent.skill];
      if (requiredSkills.some((skill) => !loadedSkills.has(skill))) {
        return {
          artifacts: [],
          errorCode: "specialist_required_skill_missing",
          qualityDegradable: true,
          qualityIssues: [
            `The ${agent.skill} skill was not loaded in this turn; the reply was delivered without managed-persona verification.`,
          ],
        };
      }
    }
    if (agent.completionChecks.includes("citationsResolvable")) {
      const prose = assistantProse(assistantMessages);
      if (!validExplicitCitations(prose)) {
        return {
          artifacts: [],
          errorCode: "specialist_citation_invalid",
          qualityDegradable: true,
          qualityIssues: [
            "The reply cites a malformed or non-public URL (citations must be credential-free HTTPS public sources, never internal API routes); delivered unverified.",
          ],
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
          qualityIssues: issues,
        };
      }
    }
    return { artifacts: [], errorCode: null };
  }
  if (agent.completionChecks.includes("skillsLoaded")) {
    const loadedSkills = successfullyLoadedSkills(assistantMessages);
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
      return { artifacts, errorCode: "specialist_required_output_missing" };
    }
    if (file.stat.mtimeMs + 1_000 < Date.parse(run.startedAt)) {
      return { artifacts, errorCode: "specialist_required_output_stale" };
    }
    files.set(relative, file.text);
    artifacts.push(relative);
  }
  if (agent.completionChecks.includes("citationsResolvable")) {
    const markdown = [...files].filter(([relative]) => relative.endsWith(".md")).map(([, text]) => text);
    if (markdown.some((text) => !validExplicitCitations(text))) {
      return { artifacts, errorCode: "specialist_citation_invalid" };
    }
  }
  if (agent.completionChecks.includes("citationIntegrity")) {
    const markdown = [...files].filter(([relative]) => relative.endsWith(".md")).map(([, text]) => text);
    const issues = markdown.flatMap((text) => citationIntegrityIssues(text));
    if (issues.length > 0) {
      return { artifacts, errorCode: "specialist_citation_integrity_failed", qualityDegradable: true, qualityIssues: issues };
    }
  }
  // Generalized "sources recorded" check (the reusable part of clinical
  // traceability) for agents that freeze a retrieval snapshot: every URL the
  // report cites must appear in evidence-snapshot.json, so a report cannot cite
  // a source that was never recorded in the frozen evidence set.
  if (agent.completionChecks.includes("citedSourcesRecorded")) {
    const snapshotEntry = [...files].find(([relative]) => relative.endsWith("evidence-snapshot.json"));
    if (!snapshotEntry) {
      return { artifacts, errorCode: "specialist_evidence_snapshot_missing" };
    }
    let snapshot;
    try {
      snapshot = JSON.parse(snapshotEntry[1]);
    } catch {
      return { artifacts, errorCode: "specialist_evidence_snapshot_invalid" };
    }
    if (!snapshot || typeof snapshot !== "object") {
      return { artifacts, errorCode: "specialist_evidence_snapshot_invalid" };
    }
    const recordedUrls = new Set(citedHttpUrls(snapshotEntry[1]));
    if (!recordedUrls.size) {
      return { artifacts, errorCode: "specialist_evidence_snapshot_empty" };
    }
    const citedUrls = [...files]
      .filter(([relative]) => relative.endsWith(".md"))
      .flatMap(([, text]) => citedHttpUrls(text));
    if (citedUrls.some((url) => !recordedUrls.has(url))) {
      return { artifacts, errorCode: "specialist_cited_source_unrecorded" };
    }
  }
  if (agent.completionChecks.includes("evidenceClaimsTraceable")) {
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
    if (!Array.isArray(sourcePaths) || sourcePaths.length > 48) {
      return { artifacts, errorCode: "specialist_evidence_traceability_failed" };
    }
    for (const rawPath of sourcePaths) {
      let relative;
      try {
        relative = normalizeWorkspaceRelativePath(rawPath, "source artifact path");
      } catch {
        return { artifacts, errorCode: "specialist_evidence_traceability_failed" };
      }
      if (relative !== rawPath || !relative.startsWith(".evimed-sources/")) {
        return { artifacts, errorCode: "specialist_evidence_traceability_failed" };
      }
      const expectedDigest = sourceArtifactProvenance.get(relative);
      if (!expectedDigest) {
        return { artifacts, errorCode: "specialist_evidence_provenance_failed" };
      }
      const sourceFile = await readRequiredFile(project, relative);
      if (!sourceFile || sourceFile.stat.mtimeMs + 1_000 < Date.parse(run.startedAt)) {
        return { artifacts, errorCode: "specialist_evidence_traceability_failed" };
      }
      if (createHash("sha256").update(sourceFile.text, "utf8").digest("hex") !== expectedDigest) {
        return { artifacts, errorCode: "specialist_evidence_integrity_failed" };
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
    });
    if (!validation.valid) {
      return {
        artifacts,
        errorCode: "specialist_evidence_traceability_failed",
        qualityIssues: validation.issues,
        // Degradable only when every remaining issue is a process-documentation
        // or presentation gap — never when an integrity or structural issue
        // (fabricated quote, unsupported number, missing section, no claims,
        // internal-API citation, un-persisted source) remains.
        qualityDegradable: validation.blockingIssues.length === 0,
      };
    }
  }
  return { artifacts, errorCode: null };
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
    this.monitorIntervalMs = options.monitorIntervalMs ?? 500;
    this.monitorMaxPolls = options.monitorMaxPolls ?? 3600;
    // Consecutive polls with no new message and no new tool call before a run
    // is called stalled. Zero disables the check and waits out the timeout.
    this.monitorStallPolls = options.monitorStallPolls ?? 0;
    this.onRunFinished = options.onRunFinished ?? (async () => {});
    this.onRunFinishedError = options.onRunFinishedError ?? (async () => {});
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
    if (!this.model) throw new Error("AgentRunStore requires a configured model.");
  }

  async list(project) {
    const events = parseEvents(await readLedgerText(project, this.maxBytes));
    return [...foldEvents(events).values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
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

  async createRun(project, session, { baselineCursor, dispatchId = null } = {}) {
    return (await this.reserveRun(project, session, { baselineCursor, dispatchId })).run;
  }

  async reserveRun(project, session, {
    baselineCursor,
    dispatchId = null,
    effectiveAgentId = session.mode === "specialist" ? session.agentId : null,
    effectiveAgentVersion = session.mode === "specialist" ? session.agentVersion : null,
    effectiveRuntimeAgent = session.mode === "specialist" ? session.runtimeAgent : null,
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
        model: this.model,
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
      effectiveAgentId,
      effectiveAgentVersion,
      effectiveRuntimeAgent,
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
        }
      : { effectiveAgentId, effectiveAgentVersion, effectiveRuntimeAgent };
    const reservation = await this.reserveRun(project, session, { baselineCursor, dispatchId, ...selected });
    const record = reservation.run;
    if (!reservation.owner) return this.existingDispatch(project, record);
    this.projects.set(`${project.userId}:${project.id}`, project);
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
      return foldEvents([...events, event]).get(runId);
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
      return { run: foldEvents([...events, event]).get(runId), transitioned: true };
    });
    const result = outcome.run;
    if (result.status !== "running") {
      this.dispatchOwners.delete(runId);
      this.clinicalRepairAttempts.delete(runId);
      this.clinicalRepairBaselineCursors.delete(runId);
      this.clinicalRepairSenders.delete(runId);
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
        return this.finishInternal(project, run.id, {
          status: "failed",
          errorCode: "runtime_stopped",
          artifacts: [],
        });
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
        );
      } catch {
        completion = { artifacts: [], errorCode: "specialist_contract_unavailable" };
      }
      artifacts = [...new Set([...artifacts, ...completion.artifacts])].sort();
      if (completion.errorCode) {
        const repairSender = this.clinicalRepairSenders.get(run.id);
        const repairAttempts = this.clinicalRepairAttempts.get(run.id) ?? 0;
        const canRepair = run.effectiveAgentId === "clinical-evidence-synthesis"
          && completion.errorCode === "specialist_evidence_traceability_failed"
          && Array.isArray(completion.qualityIssues)
          && completion.qualityIssues.length > 0
          && repairAttempts < this.maxClinicalRepairAttempts
          && typeof repairSender === "function";
        if (canRepair) {
          this.clinicalRepairAttempts.set(run.id, repairAttempts + 1);
          this.clinicalRepairBaselineCursors.set(run.id, messageId(assistants.at(-1)));
          try {
            const repair = await repairSender(clinicalEvidenceRepairPrompt(completion.qualityIssues));
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
          terminal.verification = "unverified";
          terminal.qualityNotices = completion.qualityIssues;
        } else {
          terminal.status = "failed";
          terminal.errorCode = completion.errorCode;
          if (Array.isArray(completion.qualityIssues)) terminal.qualityNotices = completion.qualityIssues;
        }
      }
    }
    return this.finishInternal(project, run.id, { ...terminal, artifacts });
  }

  /** Append what is observably happening, when it changes.
   *
   * Returns whether the run moved since the last observation, which is what
   * separates a long run from a dead one. Only a change is written, so the
   * ledger does not grow with every poll of a quiet run. */
  async recordProgress(project, run) {
    let history;
    try {
      history = await this.readSessionHistory(project, run.sessionId, { wake: false });
    } catch {
      return false;
    }
    if (!Array.isArray(history)) return false;
    const messages = history.length;
    const toolCalls = history.reduce(
      (total, message) => total + (message?.parts ?? []).filter((part) => part?.type === "tool").length,
      0,
    );
    if (messages === (run.observedMessages ?? 0) && toolCalls === (run.observedToolCalls ?? 0)) return false;
    await withProjectStorageMutation(project, async () => {
      const events = parseEvents(await readLedgerText(project, this.maxBytes));
      const current = foldEvents(events).get(run.id);
      if (!current || current.status !== "running") return;
      const event = { event: "progress", id: run.id, at: this.now().toISOString(), messages, toolCalls };
      const text = serializeNext(events, event, this.maxBytes);
      await writeFileAtomicNoFollow(project.rootDir, ledgerFile(project), text, { encoding: "utf8", mode: 0o600 });
    });
    return true;
  }

  scheduleMonitor(project, runId) {
    if (this.monitors.has(runId)) return;
    let canceled = false;
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
        const moved = await this.recordProgress(project, run).catch(() => false);
        idlePolls = moved ? 0 : idlePolls + 1;
        if (this.monitorStallPolls > 0 && idlePolls >= this.monitorStallPolls) {
          await this.finishInternal(project, runId, {
            status: "failed",
            errorCode: "runtime_monitor_stalled",
            artifacts: [],
          });
          return;
        }
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, this.monitorIntervalMs);
          timer.unref?.();
        });
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
    this.monitors.set(runId, { promise, cancel: () => { canceled = true; } });
  }

  async closeProject(project, status = "canceled") {
    const runs = await this.list(project);
    for (const run of runs.filter((item) => item.status === "running")) {
      this.monitors.get(run.id)?.cancel();
      await this.finishInternal(project, run.id, {
        status,
        errorCode: status === "failed" ? "runtime_stopped" : "runtime_canceled",
        artifacts: [],
      });
    }
  }

  async closeAll() {
    for (const project of this.projects.values()) await this.closeProject(project, "canceled");
    this.projects.clear();
    this.dispatchOwners.clear();
    this.clinicalRepairAttempts.clear();
    this.clinicalRepairBaselineCursors.clear();
    this.clinicalRepairSenders.clear();
  }
}
