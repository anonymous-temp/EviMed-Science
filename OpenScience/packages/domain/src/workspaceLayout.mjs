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
  /** Question the control plane holds; the workspace copy is a read-only mirror. */
  briefFile: `${BRIEF_DIR}/research-brief.md`,
  /** Knowledge slices + memory + capability catalogue, injected at session start. */
  briefContextFile: `${BRIEF_DIR}/context.md`,
  /** Run identity handed into the container. */
  briefIndexFile: `${BRIEF_DIR}/index.json`,
  /** The only plan artifact in the whole system (§7.1). */
  planFile: 'task-plan.json',
  /** Written only by evimed_submit_deliverable. */
  receiptFile: 'delivery-receipt.json',
  /** Always produced, even for a partial delivery (Apodex report node). */
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
  /** Resident capsule profile block, <= 1500 tokens. */
  capsuleProfileFile: `${CAPSULE_DIR}/profile.md`,
  /** Handle for the recall tool. */
  capsuleIndexFile: `${CAPSULE_DIR}/index.json`,
  /** Agenda excerpt injected into an autopilot episode (§24.4.1). */
  agendaFile: `${BRIEF_DIR}/agenda.md`,
})

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

/** Where the gate's own implementation lives inside the runtime container. */
const GATE_IMPLEMENTATION_MARKERS = Object.freeze([
  '@evimed/domain/src/',
  '@evimed/dsh-socket/src/',
  '@evimed/dsh-socket/plugins/',
])

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
  return GATE_IMPLEMENTATION_MARKERS.some((marker) => unix.includes(marker))
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
