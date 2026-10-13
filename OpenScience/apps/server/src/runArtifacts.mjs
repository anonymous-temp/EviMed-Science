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
 * An ordinary conversation is the exception to "work" (course correction
 * 2026-10-12, GA16): it has no capability contract, so there is no declared
 * output to compare a file with, and the file it was asked for — a Word file, a
 * workbook, a deck, a script — is the whole point of the run. Its files are
 * `deliverable`s of the generic `file-deliverable` contract unless they are
 * scratch (`ordinaryOutputPath`: a closed list of hidden, dependency, cache and
 * scratch directories and the platform's own files), and the run record names them
 * in `outputFiles` so the card, the project's outputs and the inbox can say what
 * was produced instead of "result is in the conversation".
 *
 * Computed on read from the plan the ledger already holds and the registry
 * the server already has, so it applies to every run ever recorded and the
 * ledger does not carry a second copy of every path.
 *
 * @module runArtifacts
 */

import { FILE_DELIVERABLE_KIND, artifactPresentation, compareArtifacts, deliverableIdOfPath, isProtectedWritePath, normalizeWorkspacePath, workspaceLayout } from "@evimed/domain";

/** @typedef {'deliverable' | 'revision-notes' | 'work' | 'superseded'} ArtifactKind */

export const ARTIFACT_KINDS = Object.freeze(/** @type {const} */ (["deliverable", "revision-notes", "work", "superseded"]));

/**
 * @typedef {object} ArtifactContext
 * @property {Set<string> | null} planIds the run's current plan, or null when it had none
 * @property {(deliverableId: string) => Set<string> | null} declaredIn declared outputs of a deliverable's capability, relative to its directory; null when unknown
 * @property {Set<string> | null} declaredAtRoot declared outputs of the run's own capability, for the pre-directory layout
 * @property {boolean} [ordinary] the run is an ordinary conversation: it has no capability contract, so its files are its outputs
 * @property {ReadonlySet<string> | null} [recorded] the files the run named as its outputs when it ended, which are then the
 *   whole of them: what the registry would say about the run today is not asked
 */

/** @param {string} path */
function hasDotSegment(path) {
  return path.split("/").some((segment) => segment.startsWith("."));
}

/**
 * Directories whose files are never a conversation's product: dependencies a package manager unpacked, bytecode and
 * caches, and the scratch places a script writes its intermediate files to. Compared in lower case, by whole name.
 */
export const SCRATCH_DIRECTORIES = Object.freeze(new Set([
  "node_modules", "__pycache__", "site-packages", "venv", "tmp", "temp", "cache", "scratch", "work",
]));

/**
 * The directories a render step writes page images to. The office skills tell the run to look at its own file after it saves
 * it (`render --output-dir preview-1`, `--out-dir page-5`, a new directory each time), so the pictures and the manifest beside
 * them are the run's way of checking its work, not what it was asked for. A whole name, a stem and an optional number: a
 * folder the person named (`pages/`, `site/preview-copy/`) is not matched. A page the run really hands over goes through
 * `present`, which is not filtered.
 * Deletable when the office kit renders under a dot directory.
 */
const RENDER_DIRECTORY = /^(?:previews?|renders?)(?:[-_]?\d+)?$|^page-\d+$/i;

/**
 * The first-level directories that are not the conversation's: the read-only dataset mount, the project's document library
 * (mounted read-only into the runtime and written by the platform's own intake) and the account's personal library (mounted
 * read-only too). The two names are spelled out because `researchContext.mjs` and `runtimeManager.mjs`, which own the
 * constants, sit in an import cycle with this module; a test holds them equal.
 */
export const PLATFORM_ROOT_DIRECTORIES = Object.freeze(new Set([workspaceLayout.dataDir, "knowledge-base", "library"]));

/** The platform's own files at the workspace root: the plan, the receipt and the summary a run's gate writes. */
const PLATFORM_ROOT_FILES = Object.freeze(/** @type {Set<string>} */ (new Set([workspaceLayout.planFile, workspaceLayout.receiptFile, workspaceLayout.deliverySummaryFile])));

/**
 * Whether a directory name can hold an ordinary conversation's outputs.
 * @param {string} name @param {boolean} atRoot whether it sits directly in the workspace
 */
export function isOrdinaryOutputDirectory(name, atRoot) {
  if (!name || name.startsWith(".")) return false;
  if (SCRATCH_DIRECTORIES.has(name.toLowerCase()) || RENDER_DIRECTORY.test(name)) return false;
  return !(atRoot && PLATFORM_ROOT_DIRECTORIES.has(name));
}

/**
 * Whether a workspace-relative file path can be an ordinary conversation's output: visible, outside every scratch,
 * dependency and platform directory, not one of the platform's own files, and not a protected write path.
 * @param {string} value
 */
export function ordinaryOutputPath(value) {
  const path = normalizeWorkspacePath(value) ?? "";
  if (!path || hasDotSegment(path)) return false;
  const segments = path.split("/");
  const directories = segments.slice(0, -1);
  if (directories.some((name, index) => !isOrdinaryOutputDirectory(name, index === 0))) return false;
  if (directories.length === 0 && PLATFORM_ROOT_FILES.has(segments[0])) return false;
  return !isProtectedWritePath(path);
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
  if (context.ordinary) return ordinaryOutputPath(path) ? "deliverable" : "work";
  return context.declaredAtRoot?.has(path) ? "deliverable" : "work";
}

/**
 * One file's kind for a run that recorded its own outputs: they are deliverables, and nothing else it left is.
 * @param {string} value @param {ReadonlySet<string>} recorded
 * @returns {ArtifactKind}
 */
function recordedKindOf(value, recorded) {
  const path = normalizeWorkspacePath(value) ?? String(value ?? "");
  return recorded.has(path) || recorded.has(String(value)) ? "deliverable" : "work";
}

/**
 * The kinds of every file on a run record, and how many of each.
 *
 * @param {Record<string, any>} run a folded run record
 * @param {(capabilityId: string) => readonly string[] | null} declaredOutputsOf the registry's declared output paths for a capability, or null
 * @returns {{ artifactKinds: Record<string, ArtifactKind>, artifactCounts: { deliverable: number, revisionNotes: number, work: number, superseded: number },
 *   outputFiles?: string[] } | null} `outputFiles` is present for an ordinary conversation only: the files it produced, in the order a reader looks for them
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
  // What the run recorded of itself outranks what is inferred: it was decided once, with the transcript and the workspace
  // in hand, at the moment the run ended.
  const recorded = Array.isArray(run?.outputFiles) && run.outputFiles.length > 0 ? new Set(run.outputFiles.map(String)) : null;
  const ordinary = recorded !== null || isOrdinaryConversation(run, declared(run?.effectiveAgentId), plan);
  /** @type {ArtifactContext} */
  const context = {
    planIds,
    // A deliverable the plan names is judged by its own capability; one on a
    // run without a plan by the run's. An ordinary conversation has no capability
    // to declare anything, so a file in a deliverable directory is shown unless
    // it is scratch.
    declaredIn: (deliverableId) => (ordinary ? null : declared(capabilityOf.get(deliverableId) ?? run?.effectiveAgentId)),
    declaredAtRoot: ordinary ? null : declared(run?.effectiveAgentId),
    ordinary,
  };
  /** @type {Record<string, ArtifactKind>} */
  const artifactKinds = {};
  const artifactCounts = { deliverable: 0, revisionNotes: 0, work: 0, superseded: 0 };
  for (const path of paths) {
    const kind = recorded ? recordedKindOf(path, recorded) : artifactKindOf(path, context);
    artifactKinds[path] = kind;
    if (kind === "revision-notes") artifactCounts.revisionNotes += 1;
    else artifactCounts[kind] += 1;
  }
  if (!ordinary) return { artifactKinds, artifactCounts };
  const outputFiles = paths.filter((path) => artifactKinds[path] === "deliverable")
    .sort((left, right) => compareArtifacts({ path: left, role: ordinaryRole(left) }, { path: right, role: ordinaryRole(right) }))
    .slice(0, ORDINARY_OUTPUT_LIMIT);
  return { artifactKinds, artifactCounts, outputFiles };
}

/** How many of an ordinary conversation's files one record names as its outputs. A script that writes a hundred pictures is one output, not a hundred lines. */
export const ORDINARY_OUTPUT_LIMIT = 20;

/**
 * Whether a run is an ordinary conversation: one whose capability (the answer line, or none) delivers no declared files and
 * whose plan, if it wrote one, names no capability — a plan of `file-deliverable` items is the same conversation with its
 * file written down. A run whose capability the registry does not know (`declared` is null) is left as it was recorded.
 * @param {Record<string, any>} run
 * @param {Set<string> | null} declaredForAgent the registry's declared outputs for the run's own capability, or null when unknown
 * @param {readonly any[]} plan
 */
export function isOrdinaryConversation(run, declaredForAgent, plan) {
  if (plan.some((item) => item?.capability && item?.contractKind !== FILE_DELIVERABLE_KIND)) return false;
  if (!run?.effectiveAgentId) return true;
  return declaredForAgent !== null && declaredForAgent.size === 0;
}

/**
 * The role an ordinary conversation's file is shown under. A script the person asked for is a draft they open, not the
 * run's scratch; every other file keeps what its name says it is.
 * @param {string} path
 * @returns {import("@evimed/domain").ArtifactRole}
 */
export function ordinaryRole(path) {
  const role = /** @type {import("@evimed/domain").ArtifactRole} */ (artifactPresentation(path).role);
  return role === "work" && /\.(py|r|mjs|cjs|js|ts|sh|bash|ps1)$/i.test(path) ? "draft" : role;
}

/** Reading roles declared by the runtime's capability contracts, applied to the actual run files.
 * @param {any} run @param {(id: string) => any[] | undefined} outputsOf
 * @param {readonly string[] | null} [outputFiles] an ordinary conversation's output files (`describeRunArtifacts`), shown under `ordinaryRole`
 */
export function describeRunArtifactRoles(run, outputsOf, outputFiles = null) {
  const roles = {};
  const ordinary = new Set(outputFiles ?? []);
  for (const path of [...(run.artifacts ?? []), ...(run.unverifiedArtifacts ?? [])]) {
    if (ordinary.has(path)) {
      roles[path] = artifactPresentation(path, ordinaryRole(path)).role;
      continue;
    }
    const id = deliverableIdOfPath(path);
    const capability = run.deliverables?.find(item => item.id === id)?.capability ?? run.effectiveAgentId ?? run.agentId;
    const relative = id ? path.slice(`${workspaceLayout.deliverablesDir}/${id}/`.length) : path;
    const declared = outputsOf(capability)?.find(output => output.path === relative)?.role;
    roles[path] = artifactPresentation(path, declared).role;
  }
  return roles;
}
