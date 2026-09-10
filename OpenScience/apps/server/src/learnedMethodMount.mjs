/**
 * The learned methods a project's runs may read.
 *
 * Hidden knowledge: there are two independent sources of "the user's own
 * methods" and only one of them had a mount. `capsuleMethods.mjs` materialises
 * *capsule* work-style entries — things the researcher wrote or imported — into
 * the directory `packages/socket/plugins/capsule.mjs` reads. The methods this
 * module selects come from the other source: the `documents.kind="method"`
 * ledger the distillation loop writes, which had no path to a container at all.
 * Approving a learned method therefore changed nothing anywhere, and the
 * counters that decide whether one may be approved could never move, because
 * moving them requires the method to have been in a run.
 *
 * The two sources share a directory on purpose. The plugin registers whatever
 * it finds there as a skill, the delegation inlines the same bodies, and the
 * caps that matter — how many methods and how many bytes of them ride along in
 * every child's prompt — are properties of the directory, not of either source.
 * So this module selects against a *remaining* budget rather than its own, and
 * the caller spends one budget across both.
 *
 * Same guarantees as the capsule half: only `approved` is mounted (with one
 * named exception, `trialMethodIds`, documented on the selector), the rendered
 * document is exactly what `mountedMethodDigest` hashes (so the delegation
 * receipt and the control plane agree on which revision was in the room), and
 * nothing here can loosen a contract — a mounted method is text to read.
 *
 * @module
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { METHOD_FILE_PREFIXES, mountedMethodDigest, renderMethodSkill } from "@evimed/domain";

/** @param {string} text @returns {string} */
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * How many learned methods one runtime may mount when no budget is given.
 *
 * Deliberately smaller than the capsule half's 32. A capsule entry is something
 * the researcher wrote; a learned method is something the system inferred and a
 * paired evaluation admitted, and the library of those grows on its own. The
 * research on unbounded skill libraries is unambiguous that the failure mode is
 * silent — retrieval degrades, the wrong method gets injected, and nothing in
 * the run says so — which makes a cap the one control that cannot be deferred
 * until it is needed.
 */
export const MAX_MOUNTED_LEARNED_METHODS = 16;

/**
 * The directory name for one learned method.
 *
 * Always the digest form. A method id is `method:learned:<name>` where the name
 * is authored by a model, so it holds colons at minimum and arbitrary user text
 * at worst; `safeId` would reject every one of them. The leading `_` is the
 * same guarantee `capsuleMethods.mjs` relies on — `safeId` can never return a
 * name starting with `_`, so a learned method and a capsule entry sharing one
 * directory can never collide.
 *
 * @param {string} methodId
 * @returns {string}
 */
export function learnedMethodDirectoryName(methodId) {
  return `_lm${sha256(String(methodId ?? "")).slice(0, 32)}`;
}

/**
 * One learned method, as the bytes the plugin reads.
 *
 * The frontmatter is the method's own, not a rewritten one: `mountedMethodDigest`
 * hashes exactly this document, and the delegation receipt hashes the file the
 * plugin read. Rendering anything else here — a longer description, an added
 * provenance key — would make every receipt digest disagree with every stored
 * digest, and the symptom would not be an error. It would be a loop that
 * records nothing while reporting success.
 *
 * @param {{frontmatter: Record<string, unknown>, body: string}} payload
 * @returns {string}
 */
export function renderLearnedMethod(payload) {
  return renderMethodSkill(payload?.frontmatter ?? {}, payload?.body ?? "");
}

/**
 * The attached files of one method, keyed by their path under its directory.
 *
 * Only the two prefixes the domain allows, and only strings: the payload is a
 * stored document, so this is the last place before the filesystem where a
 * path that should never have been stored can still be dropped rather than
 * written. `writeFileAtomicNoFollow` scopes the write as well, so this is the
 * cheap half of two checks rather than the only one.
 * @param {any} payload @returns {Record<string, string>}
 */
export function methodFiles(payload) {
  const files = payload?.files;
  if (!files || typeof files !== "object" || Array.isArray(files)) return {};
  /** @type {Record<string, string>} */
  const kept = {};
  for (const [path, content] of Object.entries(files)) {
    if (typeof content !== "string") continue;
    if (!METHOD_FILE_PREFIXES.some((prefix) => path.startsWith(prefix))) continue;
    if (path.includes("..") || path.includes("\\") || path.startsWith("/")) continue;
    kept[path] = content;
  }
  return kept;
}

/** @param {any} payload @returns {number} */
function methodFileBytes(payload) {
  return Object.values(methodFiles(payload))
    .reduce((total, content) => total + Buffer.byteLength(content, "utf8"), 0);
}

/**
 * The approved learned methods this project's runs should mount.
 *
 * Project-scoped methods first, then account-wide ones, deduplicated by id —
 * the same ordering rule the capsule half uses for activations, and for the
 * same reason: what a run reads and what a run recalls must not come from
 * different places. Within each scope the most recently approved comes first,
 * so what survives truncation is the most recent thing that passed a gate.
 *
 * `statusChangedAt` is the field `#setStatus` stamps on every promotion, and it
 * is also what `createCandidate` stamps on a method that was effective from
 * birth, so both routes into `approved` sort on the same clock.
 *
 * Ties break on id compared as code units rather than by `localeCompare`, whose
 * answer depends on the host's locale data; "the same methods select the same
 * mount" has to hold across machines.
 *
 * `trialMethodIds` is the one way a method that is not approved reaches a run,
 * and it exists because without it the loop cannot close. Promotion needs
 * observed trajectories; trajectories need the method to have been mounted;
 * only approved methods are mounted. The plan resolves that circle at the
 * paired evaluation, which sets the method snapshot for the runs it measures —
 * so the component whose entire job is measurement names the candidate it is
 * measuring, and nothing else ever passes this argument. A researcher's own run
 * cannot receive an unproven method by any path.
 *
 * @param {any} learning `LearningService`
 * @param {{userId: string, projectId: string, maxCount?: number, maxBytes?: number, trialMethodIds?: readonly string[]}} scope
 * @returns {Promise<{id: string, name: string, digest: string, directoryName: string, document: string, files: Record<string, string>, bytes: number, trial?: boolean}[]>}
 */
export async function selectLearnedMethods(learning, scope) {
  if (!learning) return [];
  const maxCount = Number.isSafeInteger(scope.maxCount) ? Number(scope.maxCount) : MAX_MOUNTED_LEARNED_METHODS;
  const maxBytes = Number.isSafeInteger(scope.maxBytes) ? Number(scope.maxBytes) : Number.POSITIVE_INFINITY;
  if (maxCount <= 0 || maxBytes <= 0) return [];

  /** @type {any[]} */
  const documents = [];
  /** @type {Set<string>} */
  const trials = new Set();
  for (const methodId of scope.trialMethodIds ?? []) {
    let document = null;
    // A trial id that names nothing, or a retired method, is skipped rather
    // than thrown: an evaluation of a method that has since been withdrawn
    // should measure nothing, not fail to start.
    try { document = await learning.getMethod(scope.userId, methodId); } catch { continue; }
    if (document?.payload?.status !== "candidate") continue;
    documents.push(document);
    trials.add(String(document.id));
  }
  for (const projectId of [scope.projectId, null]) {
    const page = await learning.approvedMethods(scope.userId, { projectId });
    for (const document of page ?? []) {
      if (documents.some((existing) => existing.id === document.id)) continue;
      documents.push(document);
    }
  }

  /** @type {{id: string, name: string, digest: string, directoryName: string, document: string, files: Record<string, string>, bytes: number, approvedAt: number, trial?: boolean}[]} */
  const candidates = [];
  for (const document of documents) {
    const payload = document?.payload ?? {};
    const name = String(payload.frontmatter?.name ?? "");
    const body = String(payload.body ?? "");
    // A method with no name cannot be registered as a skill and cannot be
    // attributed back from a receipt, which makes mounting it strictly worse
    // than not: its bytes ride in every prompt and nothing it does is counted.
    if (!name || !body.trim()) continue;
    const rendered = renderLearnedMethod(payload);
    candidates.push({
      id: String(document.id),
      ...(trials.has(String(document.id)) ? { trial: true } : {}),
      name,
      digest: mountedMethodDigest(payload, sha256),
      directoryName: learnedMethodDirectoryName(String(document.id)),
      document: rendered,
      // A code skill's scripts, tests and tool schema, which the validator has
      // already checked against each other and against the prefix rules. They
      // ride in the byte budget with the body: the container is what has to
      // hold them, and a method whose body is small and whose scripts are not
      // taxes the launch exactly as much.
      files: methodFiles(payload),
      bytes: Buffer.byteLength(rendered, "utf8") + methodFileBytes(payload),
      approvedAt: Date.parse(String(payload.statusChangedAt ?? payload.createdAt ?? "")) || 0,
    });
  }
  // A method under trial sorts first and is never the one truncation drops: it
  // is the reason the evaluation run exists, and an evaluation that silently
  // measured the baseline twice would report "no difference" forever.
  candidates.sort((left, right) => Number(trials.has(right.id)) - Number(trials.has(left.id))
    || right.approvedAt - left.approvedAt
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  /** @type {{id: string, name: string, digest: string, directoryName: string, document: string, files: Record<string, string>, bytes: number, trial?: boolean}[]} */
  const selected = [];
  let bytes = 0;
  for (const { approvedAt: _approvedAt, ...candidate } of candidates) {
    if (selected.length >= maxCount) break;
    if (candidate.trial) { bytes += candidate.bytes; selected.push(candidate); continue; }
    // Unlike the capsule half, the first candidate is not exempt from the byte
    // budget. A capsule entry the user wrote is theirs to make enormous; an
    // inferred method that alone exceeds the prompt budget is a distillation
    // defect, and mounting it anyway would tax every child of every run.
    if (bytes + candidate.bytes > maxBytes) continue;
    bytes += candidate.bytes;
    selected.push(candidate);
  }
  return selected;
}
