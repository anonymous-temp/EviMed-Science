/**
 * The files a project's conversations delivered, as the knowledge base page's 「对话产出」 lists them (2026-10-12,
 * knowledge base P0, gap G3): one line per deliverable — the report, the document or the draft a reader opens first — named
 * by the conversation it came out of, newest first, each a link to the file where its run left it.
 *
 * Hidden knowledge:
 *
 * - **An index, not a copy.** Nothing is written into the knowledge base: a file stays in the run's workspace, where the
 *   delivery gate and the result ledger know it, and enters the library only when the researcher presses 「存入知识库」 on it
 *   (which puts a copy in `knowledge-base/chat/`). The list is what the run ledger already says.
 * - **The researcher's own work.** The same runs the account's usage 明细 counts: a turn they
 *   asked for, finished, of a capability they use. A run a machine started (an autopilot episode, a continuation, a source
 *   being read), a capability that is the platform's own, a run the researcher deleted and a run that failed — which
 *   delivered nothing — are not listed.
 * - **One line per deliverable.** A package of a report, a matrix and a summary is one line, the file a reader opens first
 *   (`artifactPresentation`'s rank). A matrix, a table of data and a figure belong to the report they came with; the notes
 *   a run keeps on its own revisions, scratch and what a plan abandoned are not deliverables (`runArtifacts.mjs`).
 * - **An ordinary conversation's files are each a line.** A conversation with no capability behind it (the person asked for
 *   an e-mail, a workbook, a deck, a script) has no package to open first: every file it produced is what it was asked for,
 *   so each is listed, a workbook and a script included (course correction 2026-10-12, GA16). Such a run names them itself
 *   (`outputFiles`, `runArtifacts.mjs`).
 *
 * @module projectDeliverables
 */
import { artifactPresentation, deliverableIdOfPath } from "@evimed/domain";
import { isResearcherRun } from "./agentRuns.mjs";

/** The files listed, newest first: far beyond what one project's conversations deliver, and a bound all the same. */
export const PROJECT_DELIVERABLES_LIMIT = 1000;
/** The file roles a reader opens as a document of its own. */
const READABLE_ROLES = new Set(["report", "document", "draft"]);

/** @param {unknown} value @param {number} max */
function excerpt(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * @param {readonly any[]} runs a project's ledger
 * @param {{ describe?: (run: any) => { artifactKinds?: Record<string, string>, artifactRoles?: Record<string, string>, outputFiles?: string[] },
 *   isInternal?: (agentId: string) => boolean, limit?: number }} [options]
 *   `describe` says what kind and role each file of a run is, and which are an ordinary conversation's outputs
 *   (`AgentRunStore.withArtifactKinds`); `isInternal` is the registry's `visibility: internal`.
 * @returns {{ runId: string, title: string | null, path: string, at: string }[]}
 */
export function projectDeliverables(runs, { describe = () => ({}), isInternal = () => false, limit = PROJECT_DELIVERABLES_LIMIT } = {}) {
  /** @type {{ runId: string, title: string | null, path: string, at: string }[]} */
  const listed = [];
  for (const run of runs ?? []) {
    if (!run?.id || run.deleted === true || run.status !== "succeeded" || !isResearcherRun(run)) continue;
    const agent = String(run.effectiveAgentId ?? run.agentId ?? "");
    if (agent && isInternal(agent)) continue;
    const at = [run.finishedAt, run.startedAt, run.createdAt].find((value) => typeof value === "string" && Number.isFinite(Date.parse(value)));
    if (!at) continue;
    const { artifactKinds = {}, artifactRoles = {}, outputFiles = null } = describe(run) ?? {};
    // A conversation no capability took has files to show only as an ordinary conversation's outputs.
    if (!agent && !Array.isArray(outputFiles)) continue;
    const title = excerpt(run.title || run.question, 120) || null;
    if (Array.isArray(outputFiles)) {
      for (const path of outputFiles) listed.push({ runId: String(run.id), title, path, at: new Date(at).toISOString() });
      continue;
    }
    const paths = [...new Set([...(run.artifacts ?? []), ...(run.unverifiedArtifacts ?? [])].filter((path) => typeof path === "string" && path))];
    /** The file a reader opens first, for each deliverable. @type {Map<string, { path: string, rank: number }>} */
    const first = new Map();
    for (const path of paths) {
      if (artifactKinds[path] !== "deliverable") continue;
      const shown = artifactPresentation(path, artifactRoles[path] ?? null);
      if (!READABLE_ROLES.has(shown.role)) continue;
      const group = deliverableIdOfPath(path) ?? "";
      const held = first.get(group);
      if (!held || shown.rank < held.rank || (shown.rank === held.rank && path.localeCompare(held.path, "en") < 0)) first.set(group, { path, rank: shown.rank });
    }
    for (const { path } of [...first.values()].sort((left, right) => left.path.localeCompare(right.path, "en"))) {
      listed.push({ runId: String(run.id), title, path, at: new Date(at).toISOString() });
    }
  }
  return listed.sort((left, right) => right.at.localeCompare(left.at) || left.path.localeCompare(right.path, "en")).slice(0, Math.max(1, limit));
}
