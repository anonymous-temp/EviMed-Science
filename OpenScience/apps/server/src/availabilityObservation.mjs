/**
 * What one finished run says about the things it used, as observations the
 * availability record can fold.
 *
 * Hidden knowledge: the run ledger holds the capability a run was routed to and
 * its version, how it ended, what it wrote and which notices it carried; the
 * persisted transcript holds every tool call and how each ended; the product
 * ledger holds the result versions the run produced and the settled spend is in
 * the usage ledger. Joining them is the whole of what a "hosted receipt" can
 * honestly be here: nothing new is written by a run for this — the join is made
 * afterwards, from records that already existed.
 *
 * Pure. The collector reads the ledgers and hands the values in; nothing here
 * touches a file or a database, so every named case is a unit test.
 *
 * Two rules this file keeps that the rest of the platform keeps too:
 *
 * - **Unknown stays unknown.** A tool call that is still open is not an outcome. A
 *   call a data source refused for want of a credential is not a failure of the
 *   tool, and not a success either (`connectorForMissingCode`): it says nothing,
 *   and is left out. A transcript that could not be read yields no tool
 *   observations at all, never invented ones. A skill is recorded only where its
 *   version is genuinely known — the capability's own at the capability's
 *   version, a personal skill at its pinned revision and digest.
 * - **A failure is evidence only about what failed.** `operationOutcomeOfRun`
 *   decides which runs say something about their capability; a tool's outcome
 *   is counted whatever the run's, because a call that succeeded in a run that
 *   was later cancelled really did succeed.
 *
 * @module availabilityObservation
 */

import { connectorForMissingCode, mcpToolBaseName, operationOutcomeOfRun } from "@evimed/domain";
import { EVIMED_AGENT_TOOL_IDS } from "./agentRegistry.mjs";
import { invokedSkillsBySession } from "./methodObservations.mjs";

/** The code the kernel gives a call to a tool the session does not mount (`agentRuns.mjs`'s `UNKNOWN_TOOL_CODE`). */
const UNKNOWN_TOOL_CODE = "UNKNOWN_TOOL";

/** How many skill versions one reference carries; the schema bounds it at sixteen. */
const MAX_SKILLS = 16;

/** @param {unknown} value @returns {string | null} an ISO time, or null */
function isoOf(value) {
  const time = typeof value === "number" ? value : Date.parse(String(value ?? ""));
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : null;
}

/** @param {unknown} output @returns {Record<string, any> | null} */
function parsedResult(output) {
  if (typeof output !== "string" || !output.trim().startsWith("{")) return null;
  try {
    const value = JSON.parse(output);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * How one persisted tool call ended, in the normalized transcript's own shape
 * (`part.status`, `part.output`, `part.error` — not the ledger's nested
 * `part.state`, which is a different spelling of the same facts).
 *
 * @param {any} part
 * @returns {{ outcome: "succeeded" | "failed" | "not-mounted", code: string | null } | null} null for an open call, or one that proves nothing about the tool
 */
export function toolCallOutcome(part) {
  const status = part?.status;
  if (status === "pending" || (status !== "completed" && status !== "error")) return null;
  const said = `unknown tool "${part?.tool}"`;
  if (status === "error") {
    const unknown = part?.error?.code === UNKNOWN_TOOL_CODE
      || [part?.error?.message, part?.output].some((text) => typeof text === "string" && text.includes(said));
    if (unknown) return { outcome: "not-mounted", code: null };
    const code = typeof part?.error?.code === "string" && part.error.code ? part.error.code : null;
    return connectorForMissingCode(code) ? null : { outcome: "failed", code };
  }
  const result = parsedResult(part?.output);
  if (result?.status === "error") {
    const code = typeof result?.error?.code === "string" && result.error.code ? result.error.code
      : typeof result?.code === "string" && result.code ? result.code : null;
    // A data source nobody configured for this researcher is a named state of its
    // own (`connectorNeeds`), not an outage of the tool.
    return connectorForMissingCode(code) ? null : { outcome: "failed", code };
  }
  return { outcome: "succeeded", code: null };
}

/**
 * @typedef {object} ToolTally
 * @property {number} succeeded
 * @property {number} failed
 * @property {number} notMounted
 * @property {string | null} succeededAt the latest finish among the calls that succeeded
 * @property {string | null} failedAt
 * @property {string | null} failedCode the code of the latest failure that gave one
 * @property {string | null} notMountedAt
 */

/**
 * Every research tool the transcript called, tallied by how its calls ended.
 * Only tools the catalogue names are counted; the kernel's own file and shell
 * tools fail routinely while an agent explores and are not the catalogue's.
 *
 * @param {readonly any[]} messages the persisted transcript's messages, every session
 * @param {{ fallbackAt: string | null, toolIds?: ReadonlySet<string> }} options `fallbackAt` stands in for a call with no time of its own
 * @returns {Map<string, ToolTally>}
 */
export function tallyToolCalls(messages, { fallbackAt, toolIds = EVIMED_AGENT_TOOL_IDS }) {
  /** @type {Map<string, ToolTally>} */
  const tally = new Map();
  for (const message of messages ?? []) {
    for (const part of message?.parts ?? []) {
      if (part?.type !== "tool") continue;
      const tool = mcpToolBaseName(String(part.tool ?? ""));
      if (!tool || !toolIds.has(tool)) continue;
      const result = toolCallOutcome(part);
      if (!result) continue;
      const at = isoOf(part.completedAt) ?? isoOf(message?.time) ?? fallbackAt;
      const row = tally.get(tool) ?? { succeeded: 0, failed: 0, notMounted: 0, succeededAt: null, failedAt: null, failedCode: null, notMountedAt: null };
      tally.set(tool, row);
      /** @param {string | null} current @returns {string | null} the later of the two times */
      const latest = (current) => (!current || (at && Date.parse(at) >= Date.parse(current)) ? at ?? current : current);
      if (result.outcome === "succeeded") {
        row.succeeded += 1;
        row.succeededAt = latest(row.succeededAt);
      } else if (result.outcome === "failed") {
        row.failed += 1;
        const newer = !row.failedAt || (at && Date.parse(at) >= Date.parse(row.failedAt));
        row.failedAt = latest(row.failedAt);
        // The code travels with the latest failure, but an earlier failure's code fills in a latest one that gave none.
        if (result.code && (newer || !row.failedCode)) row.failedCode = result.code;
      } else {
        row.notMounted += 1;
        row.notMountedAt = latest(row.notMountedAt);
      }
    }
  }
  return tally;
}

/**
 * The skill versions a successful capability run genuinely had.
 *
 * The capability's own skill and its companions are the work's definition at
 * the capability's version; a digest of the deployed body is added only when the
 * run is fresh enough that the body now deployed is the one it ran (a backfilled
 * run from last month may have run an older body, and an unknown digest is
 * better than a wrong one). A personal skill counts when the transcript shows
 * the model actually called it, by the revision and digest the run pinned.
 *
 * @param {{ manifest: any, run: any, invoked: ReadonlySet<string>, bodyDigest: string | null }} input
 * @returns {{ name: string, source: string, version: string | null, digest: string | null }[]}
 */
export function skillVersionsOfRun({ manifest, run, invoked, bodyDigest }) {
  /** @type {{ name: string, source: string, version: string | null, digest: string | null }[]} */
  const skills = [];
  if (manifest?.skill) {
    skills.push({ name: String(manifest.skill), source: "delegated", version: String(manifest.version ?? "") || null, digest: bodyDigest });
    for (const companion of manifest.companionSkills ?? []) {
      skills.push({ name: String(companion), source: "delegated", version: String(manifest.version ?? "") || null, digest: null });
    }
  }
  for (const pin of run?.personalSkillGeneration?.pins ?? []) {
    if (!invoked.has(pin.nativeName)) continue;
    skills.push({ name: pin.nativeName, source: "personal", version: `r${pin.revision}`, digest: pin.digest });
  }
  return skills.slice(0, MAX_SKILLS);
}

/**
 * The observations one finished run yields: one for its capability when the run
 * says something about it, and one per tool outcome the transcript shows.
 *
 * @param {{
 *   run: any,
 *   projectId: string,
 *   manifest: any | null,
 *   messages: readonly any[] | null,
 *   results: { total: number, bound: number },
 *   costCny: number | null,
 *   bodyDigest?: string | null,
 *   toolIds?: ReadonlySet<string>,
 * }} input `messages` is null when the transcript could not be read: tools are then unknown, never guessed
 * @returns {import("@evimed/domain").OperationObservation[]}
 */
export function observationsOfRun({ run, projectId, manifest, messages, results, costCny, bodyDigest = null, toolIds = EVIMED_AGENT_TOOL_IDS }) {
  const finishedAt = isoOf(run?.finishedAt);
  if (!finishedAt) return [];
  const base = {
    runId: typeof run.id === "string" ? run.id : null,
    dispatchId: typeof run.dispatchId === "string" ? run.dispatchId : null,
    sessionId: typeof run.sessionId === "string" ? run.sessionId : null,
    projectId,
  };
  /** @type {import("@evimed/domain").OperationObservation[]} */
  const observations = [];
  const invoked = new Set([...invokedSkillsBySession(messages ? [{ sessionId: "all", transcript: { messages } }] : []).get("all") ?? []]);

  const capabilityId = typeof run.effectiveAgentId === "string" ? run.effectiveAgentId : null;
  const capabilityVersion = typeof run.effectiveAgentVersion === "string" ? run.effectiveAgentVersion : null;
  if (capabilityId && capabilityVersion) {
    const outcome = operationOutcomeOfRun({
      status: String(run.status ?? ""),
      errorCode: run.errorCode ?? null,
      artifacts: Array.isArray(run.artifacts) ? run.artifacts.length : 0,
      resultVersions: results.total,
      requiresFiles: manifest ? (manifest.outputs ?? []).some((/** @type {any} */ output) => output?.required) : true,
    });
    if (outcome === "succeeded") {
      observations.push({
        kind: "capability", id: capabilityId, version: capabilityVersion, outcome,
        durationMs: Number.isFinite(run.durationMs) ? run.durationMs : null,
        costCny,
        ref: { at: finishedAt, ...base, resultVersions: results.total, boundResultVersions: results.bound, skills: skillVersionsOfRun({ manifest, run, invoked, bodyDigest }) },
      });
    } else if (outcome === "failed") {
      observations.push({
        kind: "capability", id: capabilityId, version: capabilityVersion, outcome,
        ref: { at: finishedAt, ...base, code: run.status === "succeeded" ? "specialist_required_output_missing" : String(run.errorCode ?? "unknown") },
      });
    }
  }

  if (messages) {
    for (const [tool, row] of tallyToolCalls(messages, { fallbackAt: finishedAt, toolIds })) {
      if (row.succeeded) observations.push({ kind: "tool", id: tool, outcome: "succeeded", count: row.succeeded, ref: { at: row.succeededAt ?? finishedAt, ...base } });
      if (row.failed) observations.push({ kind: "tool", id: tool, outcome: "failed", count: row.failed, ref: { at: row.failedAt ?? finishedAt, ...base, ...(row.failedCode ? { code: row.failedCode } : {}) } });
      if (row.notMounted) observations.push({ kind: "tool", id: tool, outcome: "not-mounted", count: row.notMounted, ref: { at: row.notMountedAt ?? finishedAt, ...base } });
    }
  }
  return observations;
}
