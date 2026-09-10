/**
 * The work-style methods a project's active capsules contribute to a run.
 *
 * Hidden knowledge: what was missing before this existed. `capsuleTransferService`
 * renders `method_preference` entries into `methods/<id>/SKILL.md` inside a
 * signed, encrypted pack; `packages/socket/plugins/capsule.mjs` reads a
 * directory of exactly that shape and registers each method as a skill. Both
 * halves worked, and the directory name handed to the plugin was the empty
 * string at every launch site, so a pack could be exported, transferred,
 * imported and approved and then never reach a single run. This module is the
 * missing middle: it writes the entries the user approved into a directory the
 * container mounts read-only.
 *
 * A capsule is context, never permission (`@evimed/domain/capsule`). Nothing
 * here can loosen a contract or a safety rule; the strongest thing a mounted
 * method does is give the model text to read.
 *
 * @module
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { NEVER_SHARED_LAYERS } from "@evimed/domain";
import { MAX_MOUNTED_LEARNED_METHODS, selectLearnedMethods } from "./learnedMethodMount.mjs";
import { assertNoSymlinkPath, safeId, writeFileAtomicNoFollow } from "./security.mjs";

/** The directory name under the project's runtime root. */
export const capsuleMethodsDirName = "capsule-methods";

/**
 * The fact kinds a mounted method may carry.
 *
 * The same four kinds `capsuleTransferService.mjs` calls `WORKSTYLE` — what a
 * work-style pack is allowed to contain is exactly what a work-style pack is
 * allowed to execute, and a test reads that file as text to hold the two lists
 * to one another. They are two constants only because the transfer service's
 * copy is private to it; neither may grow without the other.
 *
 * Kinds are not the whole predicate: see `UNMOUNTABLE_LAYERS`.
 */
export const CAPSULE_WORK_STYLE_FACT_KINDS = Object.freeze([
  "method_preference",
  "writing_style",
  "preference",
  "tooling",
]);

/**
 * Only approved entries are mounted.
 *
 * An imported pack arrives as candidates on purpose: `capsuleTransferService`
 * writes every received entry with `status: "candidate"`, so that adopting
 * someone else's work style is an act the recipient performs rather than a
 * consequence of opening a file. Mounting a candidate would run a stranger's
 * methods on the strength of the transfer alone. Retired entries are excluded
 * for the mirror-image reason: "was true once" is kept as history, not as
 * instruction.
 */
const MOUNTABLE_STATUS = "approved";

/**
 * The layers a method may not come from.
 *
 * `capsuleTransferService`'s export predicate is `status = 'approved' AND
 * factKind = ANY(<work-style kinds>) AND layer <> 'sources'`, and this filter is
 * that predicate — all three clauses, not two. The layer clause is not a
 * formality copied for symmetry: the sources layer holds what the user's own
 * documents say, which is why it never leaves the account, and a note about a
 * corpus registered as a skill is not a method the user wrote.
 */
const UNMOUNTABLE_LAYERS = NEVER_SHARED_LAYERS;

/** The activation cap `CapsuleService.recall` applies, applied to the same list. */
const ACTIVE_CAPSULE_LIMIT = 8;

/** One page of entries. `ProductDocuments.list` allows 100 at most. */
const CAPSULE_ENTRY_PAGE = 100;

/**
 * How many pages of one capsule are read before the read gives up.
 *
 * `CapsuleService.entries` cannot filter by status or fact kind — it lists the
 * capsule's facts of every kind, newest first — so the approved work-style rows
 * of a capsule that has accumulated a thousand notes are somewhere on page
 * eleven, and a single unpaged read mounts nothing while reporting nothing.
 * This is a runtime launch, though, not a report: the work has to stay bounded,
 * so a capsule is read at most this many pages deep. What that leaves out is
 * everything created before the thousandth-newest fact — whatever its
 * confirmation time, because the list is ordered by creation and the selection
 * is not; it stays recallable through `evimed_capsule_recall` rather than
 * mounted.
 */
export const MAX_CAPSULE_ENTRY_PAGES = 10;

/**
 * How many methods one runtime may mount.
 *
 * Eight capsules times a thousand entries is a skill root nobody can read.
 * Bounds the number of directories `packages/socket/plugins/capsule.mjs`
 * registers as skills, not the user's memory: entries beyond it stay in the
 * capsule and stay recallable through `evimed_capsule_recall`.
 */
export const MAX_MOUNTED_CAPSULE_METHODS = 32;

/**
 * How many bytes of method text one runtime may mount.
 *
 * The count cap alone bounds nothing that matters. `capsule.mjs` provides the
 * loaded methods as `evimedCapsuleMethods`, and `plugins/run-policy.mjs` passes
 * that array — full bodies, not names — into `buildDelegation` for every
 * delegation, so each method's bytes are re-inlined into every child's prompt.
 * An entry may hold 20,000 characters (`CapsuleService.addEntry`), so a
 * count-only cap admits a 640,000-character tax on every child a run starts.
 * This is the bound that is actually about the prompt.
 *
 * Applied to the rendered SKILL.md, because that whole file — frontmatter
 * included — is what the plugin reads and what the delegation inlines.
 */
export const MAX_MOUNTED_CAPSULE_METHOD_BYTES = 32 * 1024;

/**
 * The directory name for one entry.
 *
 * A capsule entry id is user data. `productId` accepts any 200-character string
 * without control characters, `/` and `..` included, so an id reaches this
 * module as a path traversal unless it is sanitised — that is what `safeId` is
 * for.
 *
 * The digest branch is not a fallback for hostile ids alone. `CapsuleService.note`
 * mints ids like `runtime-note:<sha256>` — a colon, and past `safeId`'s length —
 * and an approved note is the ordinary way a `method_preference` enters a
 * capsule, so refusing those ids outright would leave this feature dark for the
 * path that produces most of its content. The digest form starts with `_`,
 * which `safeId` can never return, so the two forms cannot collide.
 *
 * @param {unknown} entryId
 * @returns {string}
 */
export function capsuleMethodDirectoryName(entryId) {
  const value = String(entryId ?? "");
  try {
    return safeId(value, "capsule entry id");
  } catch {
    return `_${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32)}`;
  }
}

/**
 * One method, as the bytes the plugin reads.
 *
 * The three frontmatter keys the plugin's own reader recognizes are `name`,
 * `description` and `whenToUse`; the rest is provenance for a human opening the
 * file. The body is the user's own text, unedited — a method rewritten on its
 * way to the run is not the method the user approved.
 *
 * @param {{ directoryName: string, factKind: string, content: string }} method
 * @returns {string}
 */
export function renderCapsuleMethod(method) {
  const digest = createHash("sha256").update(method.content, "utf8").digest("hex");
  return [
    "---",
    `name: method-${method.directoryName}`,
    `description: 用户记忆胶囊中的工作方式（${method.factKind}），作为背景参考，不替代证据，也不改变交付要求。`,
    "whenToUse: 当这条方法适用于当前任务时参考它。",
    `source_kind: ${method.factKind}`,
    `source_digest: ${digest}`,
    "---",
    "",
    `${String(method.content).trimEnd()}`,
    "",
  ].join("\n");
}

/**
 * Whether one capsule entry may be mounted: the export predicate, in code.
 *
 * @param {any} entry
 * @returns {boolean}
 */
function isMountableEntry(entry) {
  const payload = entry?.payload;
  return payload?.status === MOUNTABLE_STATUS
    && CAPSULE_WORK_STYLE_FACT_KINDS.includes(String(payload.factKind))
    && !UNMOUNTABLE_LAYERS.includes(String(payload.layer ?? ""))
    && typeof payload.content === "string"
    && payload.content.trim() !== "";
}

/**
 * When an entry last became the approved thing it is now.
 *
 * `updateEntry` stamps `curatedAt` whenever the status changes, and an entry
 * the user typed themselves is born approved and never carries one — hence the
 * fall back to the record's own creation time. An unparseable or absent value
 * sorts last rather than throwing: the entry is still mountable, it is simply
 * the least recent thing the user confirmed.
 *
 * @param {any} entry
 * @returns {number}
 */
function confirmedAtMs(entry) {
  for (const value of [entry?.payload?.curatedAt, entry?.createdAt]) {
    const parsed = Date.parse(String(value ?? ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/**
 * The mountable entries of one capsule, paged to the page bound.
 *
 * Every page inside the bound is read, even once the capsule has offered more
 * candidates than a runtime can mount. It used to stop there, on the ground
 * that nothing later could change the selection — but the list order and the
 * selection order are not the same order. `ProductDocuments.list` sorts by
 * `created_at DESC` and `ProductDocuments.put` leaves `created_at` alone when a
 * status changes, while the selection ranks by `payload.curatedAt`: approving a
 * year-old note today moves it to the front of the selection and not one row in
 * the list. Stopping early therefore dropped exactly the entry the user had
 * just put in force, before it was ever ranked.
 *
 * The bound that remains is `MAX_CAPSULE_ENTRY_PAGES`, which is the bound a
 * capsule of unmountable facts already pays on every launch, so the worst case
 * per capsule is unchanged.
 *
 * @param {any} capsules @param {string} userId @param {string} capsuleId
 * @returns {Promise<any[]>}
 */
async function mountableCapsuleEntries(capsules, userId, capsuleId) {
  /** @type {any[]} */
  const candidates = [];
  let cursor = null;
  for (let page = 0; page < MAX_CAPSULE_ENTRY_PAGES; page += 1) {
    /** @type {any} */
    const result = await capsules.entries(userId, capsuleId, { limit: CAPSULE_ENTRY_PAGE, cursor });
    for (const entry of result?.items ?? []) {
      if (isMountableEntry(entry)) candidates.push(entry);
    }
    cursor = result?.nextCursor ?? null;
    if (!cursor) break;
  }
  return candidates;
}

/**
 * The methods this project's active capsules contribute, in a stable order.
 *
 * The active set is read the way `CapsuleService.recall` reads it — this
 * project's activations first, then the account-wide ones, deduplicated, capped
 * at eight — so the memory a run reads and the memory a run recalls cannot come
 * from different capsules.
 *
 * The candidates are ranked most-recently-confirmed first and truncated against
 * both caps, so what survives truncation is what the user most recently said is
 * how they work, and the order is a function of the entries alone: the same
 * entries in a different page order select the same methods.
 *
 * The highest-ranked method is mounted even when it alone exceeds the byte
 * budget. 20,000 characters of Chinese is 60,000 bytes, and a budget that can
 * silently select nothing is the failure this module exists to end; the budget
 * bounds what follows it.
 *
 * A capsule named by an activation record but no longer present is skipped:
 * deleting a capsule must not stop the project's runtime from starting. Any
 * other failure propagates, because mounting nothing quietly is the failure
 * this module exists to end.
 *
 * @param {any} capsules `CapsuleService`
 * @param {{ userId: string, projectId: string }} scope
 * @returns {Promise<{ id: string, directoryName: string, capsuleId: string, factKind: string, content: string, document: string, bytes: number }[]>}
 */
export async function selectCapsuleMethods(capsules, { userId, projectId }) {
  const local = await capsules.active(userId, projectId);
  const account = await capsules.active(userId, null);
  const active = [...local.items, ...account.items]
    .filter((item, index, all) => all.findIndex((other) => other.capsuleId === item.capsuleId) === index)
    .slice(0, ACTIVE_CAPSULE_LIMIT);
  /** @type {{ id: string, directoryName: string, capsuleId: string, factKind: string, content: string, document: string, bytes: number, confirmedAt: number }[]} */
  const candidates = [];
  for (const selection of active) {
    /** @type {any[]} */
    let entries;
    try {
      entries = await mountableCapsuleEntries(capsules, userId, String(selection.capsuleId));
    } catch (error) {
      if (/** @type {any} */ (error)?.code === "capsule_not_found") continue;
      throw error;
    }
    for (const entry of entries) {
      const method = {
        id: String(entry.id),
        directoryName: capsuleMethodDirectoryName(entry.id),
        capsuleId: String(selection.capsuleId),
        factKind: String(entry.payload.factKind),
        content: String(entry.payload.content),
      };
      const document = renderCapsuleMethod(method);
      candidates.push({
        ...method,
        document,
        bytes: Buffer.byteLength(document, "utf8"),
        confirmedAt: confirmedAtMs(entry),
      });
    }
  }
  // Newest confirmation first, ties broken by id. Compared as code units rather
  // than with `localeCompare`, whose result depends on the host's locale data:
  // "the same entries select the same methods" has to hold across machines, not
  // only across two runs on one.
  candidates.sort((left, right) => right.confirmedAt - left.confirmedAt
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  /** @type {{ id: string, directoryName: string, capsuleId: string, factKind: string, content: string, document: string, bytes: number }[]} */
  const selected = [];
  let bytes = 0;
  for (const { confirmedAt: _confirmedAt, ...candidate } of candidates) {
    if (selected.length >= MAX_MOUNTED_CAPSULE_METHODS) break;
    if (selected.length > 0 && bytes + candidate.bytes > MAX_MOUNTED_CAPSULE_METHOD_BYTES) break;
    bytes += candidate.bytes;
    selected.push(candidate);
  }
  return selected;
}

/**
 * Write the project's mountable methods, and say how many there are.
 *
 * Two sources land in one directory. The capsule half is what the researcher
 * wrote or imported; the learned half is what the distillation loop inferred
 * and a paired evaluation admitted. The plugin registers whatever it finds
 * here, so from the run's point of view they are the same thing, and the caps
 * that matter — how many methods and how many bytes ride along in every
 * child's prompt — are properties of the directory rather than of either
 * source. One budget is therefore spent across both, capsules first.
 *
 * Reaching the learned half at all is the point of this parameter. The
 * selector existed and had no caller: approving a learned method changed
 * nothing anywhere, and the counters that decide whether one may be approved
 * could never move, because moving them requires the method to have been in a
 * run. `learning` closes that circle; without it this function behaves exactly
 * as it did before, which is what a deployment with no product database gets.
 *
 * The directory is rebuilt from scratch on every launch rather than merged
 * into: a method the user retired between two runs has to disappear from the
 * runtime, and a leftover file is a rule the user believes they removed. It is
 * created only when there is something to write, so a project with no methods
 * leaves no directory for anything to find, mount or write into.
 *
 * Files are written with the no-follow atomic helpers under the methods
 * directory as their own scoped root, so a directory name that somehow escaped
 * sanitisation is refused by the path scope as well. They land read-only
 * (0444) inside 0700 directories: the container reads them, and nothing —
 * including the run — writes its own method.
 *
 * @param {{ capsules: any, project: any, directory: string, learning?: any,
 *   trialMethodIds?: readonly string[], writeFile?: typeof writeFileAtomicNoFollow }} options
 * @returns {Promise<{ directory: string, count: number, bytes: number,
 *   learned: {id: string, name: string, digest: string, trial?: boolean}[] }>}
 */
export async function materializeCapsuleMethods({
  capsules,
  project,
  directory,
  learning = null,
  trialMethodIds = [],
  writeFile = writeFileAtomicNoFollow,
}) {
  await assertNoSymlinkPath(project.rootDir, directory, { allowMissingTail: true });
  const userId = String(project.userId);
  const projectId = String(project.id);
  const capsuleMethods = capsules
    ? await selectCapsuleMethods(capsules, { userId, projectId })
    : [];
  const capsuleBytes = capsuleMethods.reduce((total, method) => total + method.bytes, 0);
  // What the capsule half left on the table. Both numbers can go to zero or
  // below, and `selectLearnedMethods` returns nothing for a non-positive
  // budget, so a project whose capsules already fill the directory mounts no
  // learned method rather than overflowing the prompt.
  const learnedMethods = learning
    ? await selectLearnedMethods(learning, {
      userId,
      projectId,
      maxCount: Math.min(MAX_MOUNTED_LEARNED_METHODS, MAX_MOUNTED_CAPSULE_METHODS - capsuleMethods.length),
      maxBytes: MAX_MOUNTED_CAPSULE_METHOD_BYTES - capsuleBytes,
      trialMethodIds,
    })
    : [];
  const methods = [...capsuleMethods, ...learnedMethods];
  await fs.rm(directory, { recursive: true, force: true });
  const learned = learnedMethods.map((method) => ({
    id: method.id,
    name: method.name,
    digest: method.digest,
    ...(method.trial ? { trial: true } : {}),
  }));
  if (methods.length === 0) return { directory, count: 0, bytes: 0, learned };
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await assertNoSymlinkPath(project.rootDir, directory);
  let bytes = 0;
  for (const method of methods) {
    await writeFile(
      directory,
      path.join(directory, method.directoryName, "SKILL.md"),
      method.document,
      { encoding: "utf8", mode: 0o444 },
    );
    // A code skill is a body plus the scripts it tells the run to execute.
    // Writing only the body mounted an instruction to run a file that was not
    // there, which reads to the model as its own mistake. Same scope root and
    // same read-only mode as the body: the container executes them, and
    // nothing — including the run — writes its own.
    const files = "files" in method ? method.files : {};
    for (const [relative, content] of Object.entries(files ?? {})) {
      await writeFile(
        directory,
        path.join(directory, method.directoryName, relative),
        content,
        { encoding: "utf8", mode: 0o444 },
      );
    }
    bytes += method.bytes;
  }
  return { directory, count: methods.length, bytes, learned };
}
