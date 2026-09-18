/**
 * What each file a run left behind is: a product, the run's notes on its own
 * revisions, scratch, or a leftover of a plan the run abandoned.
 *
 * Hidden knowledge: a run's artifact list was every file it wrote, and the
 * runs page counted them all as its output. The aspirin run on 2026-09-18
 * "produced 41 files": 19 under `work/`, 12 under
 * `deliverables/clinical-evidence/.evimed-retrieval/`, and a whole
 * `deliverables/clinical-evidence/` directory a plan revision had abandoned
 * beside the real `deliverables/clinical-evidence-synthesis/` — and two
 * product files. A reader cannot find the two in the forty-one.
 *
 * Decided by closed vocabularies only, never by reading a file or its name
 * as language (principle 1):
 *   - `deliverable` — a path a deliverable's contract declares: the outputs
 *     of the capability that owns it (`capability.yaml` `produces[].outputs`,
 *     as the registry carries them), inside that deliverable's directory — or,
 *     for a run laid out before deliverable directories, at the workspace
 *     root for the run's own capability.
 *   - `revision-notes` — the deliverable's designated backstage file
 *     (`workspaceLayout.revisionNotesFile`).
 *   - `superseded` — anything under a deliverable directory whose id is no
 *     longer in the run's plan.
 *   - `work` — everything else: `work/`, dot directories such as
 *     `.evimed-retrieval/`, scratch scripts, undeclared files.
 *
 * Computed on read from the plan the ledger already holds and the registry
 * the server already has, so it applies to every run ever recorded and the
 * ledger does not carry a second copy of every path.
 *
 * @module runArtifacts
 */

import { deliverableIdOfPath, normalizeWorkspacePath, workspaceLayout } from "@evimed/domain";

/** @typedef {'deliverable' | 'revision-notes' | 'work' | 'superseded'} ArtifactKind */

export const ARTIFACT_KINDS = Object.freeze(/** @type {const} */ (["deliverable", "revision-notes", "work", "superseded"]));

/**
 * @typedef {object} ArtifactContext
 * @property {Set<string> | null} planIds the run's current plan, or null when it had none
 * @property {(deliverableId: string) => Set<string> | null} declaredIn declared outputs of a deliverable's capability, relative to its directory; null when unknown
 * @property {Set<string> | null} declaredAtRoot declared outputs of the run's own capability, for the pre-directory layout
 */

/** @param {string} path */
function hasDotSegment(path) {
  return path.split("/").some((segment) => segment.startsWith("."));
}

/**
 * One file's kind.
 * @param {string} value a workspace-relative path as the run record holds it
 * @param {ArtifactContext} context
 * @returns {ArtifactKind}
 */
export function artifactKindOf(value, context) {
  const path = normalizeWorkspacePath(value) ?? String(value ?? "");
  const id = deliverableIdOfPath(path);
  if (id) {
    if (context.planIds && !context.planIds.has(id)) return "superseded";
    const rest = path.slice(`${workspaceLayout.deliverablesDir}/${id}/`.length);
    if (rest === workspaceLayout.revisionNotesFile) return "revision-notes";
    if (hasDotSegment(rest)) return "work";
    const declared = context.declaredIn(id);
    // A capability this build does not know declares nothing we can read: a
    // file in a live deliverable's directory is shown, not hidden as scratch.
    if (!declared) return rest.startsWith("work/") ? "work" : "deliverable";
    return declared.has(rest) ? "deliverable" : "work";
  }
  if (hasDotSegment(path)) return "work";
  return context.declaredAtRoot?.has(path) ? "deliverable" : "work";
}

/**
 * The kinds of every file on a run record, and how many of each.
 *
 * @param {Record<string, any>} run a folded run record
 * @param {(capabilityId: string) => readonly string[] | null} declaredOutputsOf the registry's declared output paths for a capability, or null
 * @returns {{ artifactKinds: Record<string, ArtifactKind>, artifactCounts: { deliverable: number, revisionNotes: number, work: number, superseded: number } } | null}
 */
export function describeRunArtifacts(run, declaredOutputsOf) {
  const paths = [...new Set([
    ...(Array.isArray(run?.artifacts) ? run.artifacts : []),
    ...(Array.isArray(run?.unverifiedArtifacts) ? run.unverifiedArtifacts : []),
  ].filter((path) => typeof path === "string" && path))];
  if (paths.length === 0) return null;
  const plan = Array.isArray(run?.deliverables) ? run.deliverables : [];
  const planIds = plan.length ? new Set(plan.map((item) => String(item?.id ?? "")).filter(Boolean)) : null;
  /** @type {Map<string, Set<string> | null>} */
  const byCapability = new Map();
  const declared = (/** @type {string | null | undefined} */ capabilityId) => {
    const id = typeof capabilityId === "string" ? capabilityId : "";
    if (!id) return null;
    if (!byCapability.has(id)) {
      const outputs = declaredOutputsOf(id);
      byCapability.set(id, Array.isArray(outputs) ? new Set(outputs) : null);
    }
    return byCapability.get(id) ?? null;
  };
  const capabilityOf = new Map(plan.map((item) => [String(item?.id ?? ""), item?.capability]));
  /** @type {ArtifactContext} */
  const context = {
    planIds,
    // A deliverable the plan names is judged by its own capability; one on a
    // run without a plan by the run's.
    declaredIn: (deliverableId) => declared(capabilityOf.get(deliverableId) ?? run?.effectiveAgentId),
    declaredAtRoot: declared(run?.effectiveAgentId),
  };
  /** @type {Record<string, ArtifactKind>} */
  const artifactKinds = {};
  const artifactCounts = { deliverable: 0, revisionNotes: 0, work: 0, superseded: 0 };
  for (const path of paths) {
    const kind = artifactKindOf(path, context);
    artifactKinds[path] = kind;
    if (kind === "revision-notes") artifactCounts.revisionNotes += 1;
    else artifactCounts[kind] += 1;
  }
  return { artifactKinds, artifactCounts };
}
