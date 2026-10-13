/**
 * The run workspace layout, in one place.
 *
 * Hidden knowledge: which directories a run may write, which the model may
 * never write, and where each artifact lives. The path guard (§7.4), the
 * control plane's artifact fetch, the contract validators, the frontend's
 * deliverable preview and the export tar all read these constants instead of
 * spelling the paths out — §14 rule 4 bans the literals anywhere else.
 */

/** Directory the control plane writes before dispatch; the run may only read it. */
export const BRIEF_DIR = '.evimed-brief'
/** Directory the socket projects its run mirror into; the model may not write it. */
export const RUN_STATE_DIR = '.evimed-run'
/** Directory the control plane materializes the active capsule view into. */
export const CAPSULE_DIR = '.evimed-capsule'
/** Directory full texts and official pages are spilled to. */
export const SOURCES_DIR = '.evimed-sources'
/** Parent of every deliverable directory. */
export const DELIVERABLES_DIR = 'deliverables'
/** Read-only mount point for authorized dataset partitions (§24.5). */
export const DATA_DIR = 'data'
/** The researcher's personal knowledge base, synced read-only into the
 *  workspace by the control plane before each dispatch. Named here so the
 *  root prompt, the delegation prompt and the sync agree on one directory. */
export const KNOWLEDGE_DIR = '.evimed-knowledge'
/**
 * Where the workspace is mounted inside the runtime container.
 *
 * Every path in this module is workspace-relative, and the guards compare
 * against that shape. A model does not: it writes what its own `read` tool
 * handed back, and that is absolute — `/workspace/deliverables/<id>/report.md`.
 * Stripping the leading `/` alone turns it into `workspace/deliverables/...`,
 * which starts with neither `deliverables/` nor any protected prefix, so
 * `deliverableIdOfPath` returned null and `isProtectedWritePath` returned false
 * for the entire absolute form.
 *
 * On 2026-08-31 that let an accepted deliverable be edited seven times after
 * its receipt was written: the freeze was in place, correct, and matched
 * nothing. The same hole covered the brief, the run-state projection, the
 * capsule, the data mount and the receipt itself.
 */
export const RUNTIME_WORKSPACE_ROOT = '/workspace'

export const workspaceLayout = Object.freeze({
  briefDir: BRIEF_DIR,
  runStateDir: RUN_STATE_DIR,
  capsuleDir: CAPSULE_DIR,
  sourcesDir: SOURCES_DIR,
  deliverablesDir: DELIVERABLES_DIR,
  dataDir: DATA_DIR,
  knowledgeDir: KNOWLEDGE_DIR,
  /** Question the control plane holds; the workspace copy is a read-only mirror. */
  briefFile: `${BRIEF_DIR}/research-brief.md`,
  /** Knowledge slices + memory + capability catalogue, injected for each dispatch revision. */
  briefContextFile: `${BRIEF_DIR}/context.md`,
  /** The researcher's resident profile as it stands at this dispatch (profile,
   *  preference, behavior and correction records, the capsule's own entries and
   *  the line that says what else can be looked up), rendered the way the root
   *  sees it when it is handed it. The root receives it inside `context.md` once
   *  per conversation (at the first dispatch, again when it changed or the
   *  conversation was compacted); this copy is written at every dispatch so a
   *  delegation can hand its child the same block verbatim — the child never
   *  sees `context.md`, and a parent's paraphrase of a memory is a memory
   *  without provenance. Empty when the researcher has no profile. */
  briefMemoryFile: `${BRIEF_DIR}/memory.md`,
  /** Run identity handed into the container. */
  briefIndexFile: `${BRIEF_DIR}/index.json`,
  /** The capability a conversation was bound to when it was opened (a study's, a GEO project's, a 工具 chip's),
   *  written by the control plane beside the session's own brief files. A turn typed into the kernel's window has no
   *  dispatch and so no context naming its capability; without this file its first request went out without the
   *  capability's tools, and the model planned the work without them (2026-10-07). */
  sessionBindingFile: (/** @type {string} */ sessionId) => `${BRIEF_DIR}/sessions/${sessionId}/binding.json`,
  /** The only plan artifact in the whole system (§7.1). */
  planFile: 'task-plan.json',
  /** Written only by evimed_submit_deliverable. A run's own receipt is
   *  `receiptFileFor(runId)`; this name is that file's name, and at the
   *  workspace root it is the one project-wide receipt every run wrote before
   *  receipts were per-run — still read (`receiptFilesFor`) for a run that
   *  predates that, and still unwritable by a run (`PROTECTED_WRITE_PREFIXES`). */
  receiptFile: 'delivery-receipt.json',
  /** Always produced, even for a partial delivery (Apodex report node). One per
   *  run: `deliverySummaryFileFor(runId)`. */
  deliverySummaryFile: 'delivery-summary.md',
  /** Where backstage prose belongs, relative to a deliverable's own directory.
   *
   *  Report prose may not carry revision notes, reviewer replies, process
   *  diaries or version scars — and a ban with nowhere to put the banned thing
   *  is a ban a run works around by hiding it in the report. This is the
   *  designated outlet: the run writes what it changed and why here, the gate
   *  never reads it as report prose, and the rule in the skill can point at a
   *  destination instead of only a prohibition. */
  revisionNotesFile: 'revision-notes.md',
  /** Projection of the run mirror the control plane and UI read. */
  runStateFile: `${RUN_STATE_DIR}/state.json`,
  /** The capsule's workspace-level profile file. It was the resident profile
   *  block (<= 1500 tokens) every conversation of the project read at the start
   *  of every run; since 2026-10-10 the profile is one block in the conversation's
   *  own context (`memory.md` is its copy for a delegation) and the control plane
   *  empties this file, which the socket still reads and reads as nothing. */
  capsuleProfileFile: `${CAPSULE_DIR}/profile.md`,
  /** Handle for the recall tool. */
  capsuleIndexFile: `${CAPSULE_DIR}/index.json`,
  /** Agenda excerpt injected into an autopilot episode (§24.4.1). */
  agendaFile: `${BRIEF_DIR}/agenda.md`,
})

/**
 * The revision of the hand-off between the control plane and the runtime image: where a dispatch's brief, context, memory and
 * index are filed (per session), where a run's plan, projection, receipt and summary are filed (per run), and what the index
 * states (`runId`, `sessionId`, `contextRevision`, `capability`). Each side carries its own copy of this module, so each
 * states the revision it was built for.
 *
 * The control plane writes it into every index as `protocol`. The runtime image reads an index whose `protocol` is this value;
 * an index without one was written before the field existed (revision 1 filed everything at the workspace root; the
 * per-session layout came first, without the token) and is still read; any other value is a hand-off this image was not
 * built for, which it refuses by name rather than read as if it agreed (`RUN_PROTOCOL_SKEW_OPENING`). The two releases ship
 * together, but a web image has run a release behind its runtime image before, and nothing used to say so: an image that read
 * a file the control plane no longer wrote read an earlier run's brief as this run's.
 *
 * Bump it when the files or the index fields change meaning, and say in this comment what the new number changed.
 */
export const RUN_CONTEXT_PROTOCOL = 2

/**
 * How a runtime image's line about a hand-off it cannot read begins. The control plane names such a line by this opening
 * (`runSideDegradedNotice`), so the runtime's words and the control plane's table cannot drift apart.
 */
export const RUN_PROTOCOL_SKEW_OPENING = 'brief index protocol'

/** One immutable control-plane run's projection. The legacy shared file stays
 * available only as a historical compatibility artifact. New native turns use their session projection.
 * @param {string} runId @returns {string}
 */
export function runStateFileFor(runId) {
  const id = String(runId ?? '')
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(id)) throw new TypeError('Invalid run id for projection path')
  return `${RUN_STATE_DIR}/runs/${id}/state.json`
}

/** A file that belongs to one run, filed beside its projection.
 * @param {string} runId @param {string} name @returns {string}
 */
function runFileFor(runId, name) {
  return runStateFileFor(runId).replace(/state\.json$/, name)
}

/** The task plan belongs to one immutable workflow, not the whole project.
 * @param {string} runId @returns {string}
 */
export function planFileFor(runId) {
  return runFileFor(runId, workspaceLayout.planFile)
}

/** What one run delivered. The receipt used to be a single file at the workspace
 * root, so two runs of a project took turns erasing each other's entries and the
 * one that wrote first lost its artifact list; it is one file per run now, like
 * the plan and the projection beside it.
 * @param {string} runId @returns {string}
 */
export function receiptFileFor(runId) {
  return runFileFor(runId, workspaceLayout.receiptFile)
}

/** The summary a run's turn ends with — per run for the same reason as its receipt.
 * @param {string} runId @returns {string}
 */
export function deliverySummaryFileFor(runId) {
  return runFileFor(runId, workspaceLayout.deliverySummaryFile)
}

/**
 * Where the receipt of a run is looked for, best first: each run's own file,
 * then the project-wide file that runs wrote before receipts were per-run. A
 * reader takes the first that exists and still checks that it names the run it
 * is reading for — the root file belongs to whichever run wrote it last.
 *
 * An id that cannot name a path is skipped rather than thrown on: the ids a
 * control plane tries come out of run records and tool results, which are
 * input, and a reader asking "is there a receipt" has a defined answer for no.
 * @param {readonly (string | null | undefined)[]} runIds @returns {string[]}
 */
export function receiptFilesFor(runIds) {
  /** @type {string[]} */
  const found = []
  for (const runId of runIds) {
    try {
      const file = receiptFileFor(String(runId ?? ''))
      if (!found.includes(file)) found.push(file)
    } catch {
      // not an id a run can have
    }
  }
  return [...found, workspaceLayout.receiptFile]
}
/** A native session's latest projection; different sessions never overwrite it.
 * @param {string} sessionId @returns {string}
 */
export function runStateFileForSession(sessionId) {
  const id = String(sessionId ?? '')
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(id)) throw new TypeError('Invalid session id for projection path')
  return `${RUN_STATE_DIR}/sessions/${id}/state.json`
}

/** This session's control-plane brief; shared old briefs are not current input.
 * @param {string} sessionId @returns {string}
 */
export function briefFileForSession(sessionId) {
  const id = String(sessionId ?? '')
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(id)) throw new TypeError('Invalid session id for brief path')
  return `${BRIEF_DIR}/sessions/${id}/research-brief.md`
}

/**
 * Paths a run may never write. Everything under these prefixes is either the
 * question it is being graded against, the receipt that proves what it
 * delivered, or the state projection the control plane trusts — all three stop
 * meaning anything if the graded party can edit them.
 */
export const PROTECTED_WRITE_PREFIXES = Object.freeze([
  `${BRIEF_DIR}/`,
  `${RUN_STATE_DIR}/`,
  `${CAPSULE_DIR}/`,
  `${DATA_DIR}/`,
  // The preserved sources. Every verbatim-quote check in the clinical gate
  // reads the bytes on disk, so a run that can edit a preserved full text can
  // make any quote match — it does not have to fabricate a source, only correct
  // one. `clinical-evidence-synthesis/SKILL.md` has said "Never create, edit,
  // replace, or copy a file under `.evimed-sources/`" since the capability
  // existed, and that sentence was the whole enforcement: the guard's list did
  // not name the directory, so the write tool allowed it and the instruction
  // was advice to the party being graded.
  //
  // Reads are untouched. The run is meant to read what it retrieved, and the
  // guard for reading is a different list (`isGateImplementationPath`).
  `${SOURCES_DIR}/`,
  workspaceLayout.receiptFile,
])

/** @param {string} deliverableId @returns {string} */
export function deliverableDir(deliverableId) {
  return `${DELIVERABLES_DIR}/${deliverableId}`
}

/** @param {string} deliverableId @param {string} relativePath @returns {string} */
export function deliverablePath(deliverableId, relativePath) {
  return `${deliverableDir(deliverableId)}/${String(relativePath).replace(/^\/+/, '')}`
}

/**
 * Normalizes a workspace-relative path for comparison: forward slashes, no
 * leading `./`, no leading slash, `..` segments resolved. A path that escapes
 * the workspace root returns null so callers can refuse it rather than guess.
 * @param {string} value @returns {string | null}
 */
export function normalizeWorkspacePath(value) {
  const raw = String(value ?? '').replace(/\\/g, '/').trim()
  if (!raw) return null
  if (/^[a-zA-Z]:\//.test(raw)) return null
  // Only for an absolute path, and only the root segment: a relative
  // `workspace/notes.md` is an ordinary file the run may own, and stripping it
  // there would make two different paths compare equal.
  const absolute = raw.startsWith('/')
  const segments = raw.replace(/^\/+/, '').split('/')
  /** @type {string[]} */
  const out = []
  for (const segment of segments) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (!out.length) return null
      out.pop()
      continue
    }
    out.push(segment)
  }
  const rootSegments = RUNTIME_WORKSPACE_ROOT.split('/').filter(Boolean)
  if (absolute && rootSegments.every((segment, index) => out[index] === segment)) {
    out.splice(0, rootSegments.length)
  }
  return out.length ? out.join('/') : null
}

/**
 * True when writing this path would overwrite something the run must not own.
 * @param {string} value @returns {boolean}
 */
export function isProtectedWritePath(value) {
  const path = normalizeWorkspacePath(value)
  // An unresolvable path is refused. A write whose target cannot be named is a
  // write whose target cannot be checked, and the whole point of the guard is
  // that the graded party never gets the benefit of the doubt.
  if (!path) return true
  return PROTECTED_WRITE_PREFIXES.some((prefix) => {
    if (!prefix.endsWith('/')) return path === prefix
    // The directory itself counts: `rm -rf .evimed-brief` destroys the question
    // just as thoroughly as rewriting a file inside it.
    const bare = prefix.slice(0, -1)
    return path === bare || path.startsWith(prefix)
  })
}

/**
 * Where the gate's own implementation lives inside the runtime container: the
 * domain and the socket as the kernel's profile installed them
 * (`…/@evimed/domain/src`, `…/@evimed/dsh-socket/{src,plugins}`), and the
 * socket where the image copies it (`/opt/evimed/socket/{src,plugins}`).
 *
 * A directory named without a trailing slash is the same directory. The
 * markers used to end in `/`, and production runs walked round them without
 * trying: `R=…/@evimed/domain/src` followed by `sed -n '1190,1330p'
 * $R/contractRegistry.mjs` (method-relations, 2026-09-27, eight reads of the
 * validator it was about to be graded by), and `cd …/@evimed/domain/src;
 * python3 -c "…open('capability-contracts.json')…"` (geo-content, 2026-09-25,
 * "Find gate implementation for geo-content"). The image's own copy of the
 * socket was never named at all.
 */
const GATE_IMPLEMENTATION_PATTERN = /(?:@evimed\/domain\/src|@evimed\/dsh-socket\/(?:src|plugins)|\/opt\/evimed\/socket\/(?:src|plugins))(?![A-Za-z0-9_-])/

/**
 * Whether a path is the marking scheme rather than the exam paper.
 *
 * The write guard was built against a run rewriting its own brief or receipt,
 * and it says nothing about reading. But the delivery gate ships inside the
 * container that runs the work — the plugins have to execute there — and its
 * source sits under /runtime on a readable bind mount. A run read
 * `clinicalEvidence.mjs` seven times, then `contractRegistry.mjs`, then
 * `runPolicy.mjs`, grepped for `collectSourceArtifacts`, `sourceArtifactPaths`
 * and `successfulSourceArtifacts`, worked out from the source which claims
 * could be quote-verified, and wrote a package around the answer. It passed.
 *
 * A package that passes because the run read the checker is not evidence about
 * the package. Reading is therefore refused here, for the implementation only:
 * skills, their resources and every `.md` under `presets/` stay readable,
 * because those are the instructions and the run is meant to have them.
 *
 * @param {unknown} value @returns {boolean}
 */
export function isGateImplementationPath(value) {
  const text = String(value ?? '')
  if (!text) return false
  const unix = text.replace(/\\/g, '/')
  return GATE_IMPLEMENTATION_PATTERN.test(unix)
}

/**
 * The deliverable id a path belongs to, or null when it is outside every
 * deliverable directory. A validator only ever looks at files this returns an
 * id for: a package cannot pass by pointing at a file somewhere else.
 * @param {string} value @returns {string | null}
 */
export function deliverableIdOfPath(value) {
  const path = normalizeWorkspacePath(value)
  if (!path) return null
  const prefix = `${DELIVERABLES_DIR}/`
  if (!path.startsWith(prefix)) return null
  const rest = path.slice(prefix.length)
  const id = rest.split('/')[0]
  return id && rest.length > id.length ? id : null
}
