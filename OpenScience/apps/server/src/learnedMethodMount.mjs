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
 * The two sources share a directory on purpose. The plugin lists whatever it
 * finds there, a delegation carries a capsule entry's body and a learned
 * method's card, and the caps that matter — how many methods and how many
 * bytes of them ride along in every child's prompt — are properties of the
 * directory, not of either source. So this module selects against a
 * *remaining* budget rather than its own, and the caller spends one budget
 * across both.
 *
 * Same guarantees as the capsule half: only `approved` is mounted, no other
 * status reaches a run by any path, the rendered
 * document is exactly what `mountedMethodDigest` hashes (so the delegation
 * receipt and the control plane agree on which revision was in the room), and
 * nothing here can loosen a contract — a mounted method is text to read.
 *
 * @module
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { METHOD_FILE_PREFIXES, METHOD_MOUNT, computeMethodLevels, learnedMethodCardEntry, mountedMethodDigest, renderMethodSkill } from "@evimed/domain";
import { EVIDENCE_PROJECT_ID, FRONTIER_PROJECT_ID, LEARNING_PROJECT_ID, SOURCES_PROJECT_ID } from "./internalProjects.mjs";

/** @param {string} text @returns {string} */
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Which kind of work a learned method belongs to, from the capability it was
 * learnt in (`provenance.capabilityId`): `geo` for the four 「循证 GEO」
 * capabilities, `research` for everything else — the researcher's own
 * research, the answer line, and every method learnt before the capability
 * was recorded.
 *
 * A closed reading of platform identifiers, never of what the method says:
 * `applies_when` is prose, and deciding whether prose fits a run is language
 * (principle 1). Capability ids are ours; the GEO ones share the `geo-` prefix
 * (`capabilities/geo-*`).
 * @param {unknown} capabilityId @returns {"geo" | "research"}
 */
export function methodFamily(capabilityId) {
  return /^geo-[a-z0-9-]+$/.test(String(capabilityId ?? "")) ? "geo" : "research";
}

/**
 * Which learned methods a runtime may carry, from what it is being started
 * for: null for none.
 *
 *  - The learning, sources, frontier and evidence projects run the platform's own
 *    internal capabilities — a distillation, a relations pass, a document
 *    being read. A researcher's method has nothing to do there, and on
 *    2026-09-25 `claim-verdict-audit` was mounted into every source
 *    understanding run (audit 2026-09-26, L-G7).
 *  - A runtime reserved for a GEO run (its bounded dispatch id is `geo-…`)
 *    carries GEO methods only: the same method was in every geo-content
 *    writing run, where a rule for auditing clinical claim verdicts was noise.
 *  - Everything else — a conversation, a research run, an autopilot episode,
 *    an evaluation cell — carries research methods.
 * @param {{ projectId: string, boundedRunId?: string | null }} scope
 * @returns {"geo" | "research" | null}
 */
export function learnedMethodFamilyForRuntime({ projectId, boundedRunId = null }) {
  if ([LEARNING_PROJECT_ID, SOURCES_PROJECT_ID, FRONTIER_PROJECT_ID, EVIDENCE_PROJECT_ID].includes(String(projectId ?? ""))) return null;
  return String(boundedRunId ?? "").startsWith("geo-") ? "geo" : "research";
}

/** What `provenance.scope` may be: a capability id, or `conversation` for the ordinary answer line. */
const SCOPE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The scope a run's methods are read for when the run is the ordinary conversation. */
export const CONVERSATION_SCOPE = "conversation";

/**
 * The scope a method declares for itself: the capability it was learnt in, or `conversation` (`provenance.scope`, written by the
 * distillation). Null for a method that declares none — one learnt before the field existed. A closed reading of platform
 * identifiers, never of what the method says.
 * @param {any} payload @returns {string | null}
 */
export function methodScopeId(payload) {
  const scope = payload?.provenance?.scope;
  return typeof scope === "string" && SCOPE_ID.test(scope) ? scope : null;
}

/**
 * The scope of a run, from the capability it was routed to: that capability's id, or `conversation` when it was not routed to
 * one (the open-domain answer line is the conversation).
 * @param {unknown} capabilityId @param {string} [answerLineId] the answer line's capability id, which is the conversation
 * @returns {string}
 */
export function runScopeOf(capabilityId, answerLineId = "open-domain-answer") {
  const id = String(capabilityId ?? "");
  return !id || id === answerLineId || !SCOPE_ID.test(id) ? CONVERSATION_SCOPE : id;
}

/**
 * Whether a method may be mounted for a run of this scope.
 *
 * The join the mount used to make by family — `geo` or `research`, by the capability the method was learnt in — made by the
 * scope the method declares: a method learnt in `meta-analysis` is for runs of it, one learnt in the conversation for the
 * conversation. A method that declares none (learnt before `provenance.scope`) keeps the family reading it always had, so a
 * research method is still never mounted into a GEO writing run (audit 2026-09-26, L-G7) and a GEO one never into research.
 *
 * `scopeId` null is a mount with no run in view (a runtime start): the conversation's and, in a GEO runtime, GEO's own.
 * @param {any} payload @param {{ scopeId: string | null, family: "geo" | "research" | null }} run
 * @returns {boolean}
 */
export function methodFitsScope(payload, { scopeId, family }) {
  const declared = methodScopeId(payload);
  if (declared) {
    if (scopeId !== null) return declared === scopeId;
    return family === "geo" ? methodFamily(declared) === "geo" : declared === CONVERSATION_SCOPE;
  }
  return family === null ? true : methodFamily(payload?.provenance?.capabilityId) === family;
}

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
 * What one learned method puts in front of the model when it is mounted: its
 * card (`learnedMethodCardEntry`, the lines the socket writes into the method
 * block and every delegation), not its text, which stays in its file until a
 * run reads it (2026-09-28). The path is the one the runtime sees
 * (`cardDirectory`); a remote launcher's install path differs from the
 * container's by a few bytes, which a budget of kilobytes does not need to
 * resolve.
 * @param {any} payload @param {string} directoryName @param {string} cardDirectory
 * @returns {number}
 */
export function learnedMethodCardBytes(payload, directoryName, cardDirectory) {
  const frontmatter = payload?.frontmatter ?? {};
  const lines = learnedMethodCardEntry({
    name: String(frontmatter.name ?? ""),
    description: String(frontmatter.description ?? ""),
    whenToUse: String(frontmatter.whenToUse ?? ""),
    path: `${String(cardDirectory).replace(/\/+$/, "")}/${directoryName}/SKILL.md`,
  });
  return Buffer.byteLength(`${lines.join("\n")}\n`, "utf8");
}

/**
 * @typedef {object} MountedLearnedMethod
 * @property {string} id
 * @property {string} name
 * @property {string} digest
 * @property {string} directoryName
 * @property {string} document
 * @property {Record<string, string>} files
 * @property {number} bytes
 * @property {number} promptBytes
 * @property {"similarity" | "dependency" | "explore" | "recent"} reason why its card is in front of the run (`METHOD_MOUNT_REASONS`)
 */

/**
 * The approved learned methods a run should mount, out of the researcher's whole library, whichever project each was learnt in.
 *
 * With the first message of the conversation (`query`) and the module that reads closeness (`similarity`, `methodSimilarity.mjs`),
 * the mount is the one SkillPyramid's retrieval makes (plan 2026-10-23 §5, S5):
 *
 *  1. the methods of this run's scope (`methodFitsScope`) nearest to the message, at most `METHOD_MOUNT.nearest`, reason
 *     `similarity`;
 *  2. what those reuse (`depends_on`, by name, whatever scope it was learnt in: a reference to a method that is not there points
 *     at nothing), reason `dependency`, at most `METHOD_MOUNT.abstractMax` abstract and `METHOD_MOUNT.functionalMax` functional
 *     methods and as many atomic ones as the budget carries (level: `computeMethodLevels` over the library, the graph's own
 *     reading and what the consolidation pass stores as `learning.level`);
 *  3. `METHOD_MOUNT.explore` slot held for the method of this scope that has been in front of a model least (`counts.carried`
 *     plus `counts.explored`, then the oldest), reason `explore`: a method that is never among the nearest would otherwise
 *     never be opened and never show that it works.
 *
 * Without a message (a runtime that has just started, the agent-memory API's recall) there is nothing to rank by, and the most
 * recently approved come first, as they always did, reason `recent`.
 *
 * `statusChangedAt` is the field `#setStatus` stamps on every promotion, and it is also what `createCandidate` stamps on a method
 * that was effective from birth, so both routes into `approved` sort on the same clock. Ties break on id compared as code units
 * rather than by `localeCompare`, whose answer depends on the host's locale data: "the same methods select the same mount" has to
 * hold across machines.
 *
 * A researcher's own run cannot receive a method that is not approved by any path: there used to be one, a trial that the
 * paired evaluation named for the runs it measured, and it was deleted with the evaluation (2026-10-10).
 *
 * `scopeId` is the run's scope (`runScopeOf`; null when no run is in view). `family`, when given, is the kind of work the runtime
 * is for (`learnedMethodFamilyForRuntime`): only methods of that family are mounted, and `null` mounts none. Given neither, the
 * whole library is a candidate, as before.
 *
 * `maxBytes` is spent on what each method costs the prompt (`promptBytes`), in the order above, so what a tight budget drops is
 * the exposure first and the nearest last. Given `cardDirectory` — where the runtime sees the mounted methods — that is the
 * method's card, because a mount hands a run the card and leaves the text in its file; without it, the method's text and attached
 * files, which is what a caller that hands the text out (the agent-memory recall API) pays. Budgeting a mount on the text is how
 * `claim-verdict-audit` went unmounted from 2026-09-26: the 32 KiB were spent on bodies no run was shown any more. `bytes` is
 * always the text and files, what the mount writes to disk.
 *
 * `onLeftOut`, when given, is told the id of each method the byte budget left out (not the count cap), so a launch can count
 * what it could not carry.
 *
 * `keep` is the directory names a running runtime was already given (`learnedMethodDirectoryName`): the methods among them that
 * are still approved come back as `kept`, whether or not this selection holds them. A conversation that began in the runtime
 * was shown a card naming a file, and the directory is the one thing every conversation of the runtime shares; a method that
 * left the selection because another conversation began is not a method that left the researcher, and its file stays until the
 * runtime restarts. One that is no longer approved is not kept: a rule the researcher removed is gone at once.
 *
 * The array carries non-enumerable facts for the caller, as `methodSimilarity`'s do: `mode`, `"embedding"`, `"lexical"` or
 * `"recent"`, and `topScore`, the closeness of the nearest method (null when nothing was ranked), so the number of methods
 * pulled in by similarity can be read against a real library; and `kept`, above.
 *
 * @param {any} learning `LearningService`
 * @param {{userId: string, projectId: string, maxCount?: number, maxBytes?: number, family?: "geo" | "research" | null,
 *   scopeId?: string | null, query?: string | null, similarity?: { nearest: Function } | null, keep?: Iterable<string> | null,
 *   cardDirectory?: string | null, onLeftOut?: ((methodId: string) => void) | null}} scope
 * @returns {Promise<MountedLearnedMethod[] & { mode?: "embedding" | "lexical" | "recent", topScore?: number | null, kept?: MountedLearnedMethod[] }>}
 */
export async function selectLearnedMethods(learning, scope) {
  /** @type {any} */
  const empty = [];
  if (!learning) return empty;
  const maxCount = Number.isSafeInteger(scope.maxCount) ? Number(scope.maxCount) : MAX_MOUNTED_LEARNED_METHODS;
  const maxBytes = Number.isSafeInteger(scope.maxBytes) ? Number(scope.maxBytes) : Number.POSITIVE_INFINITY;
  // A spent byte budget still reads the library, so that what it leaves out
  // is counted (`onLeftOut`) rather than silently absent; a count cap of zero
  // has nothing to count.
  if (maxCount <= 0) return empty;
  if (scope.family === null) return empty;

  const cardDirectory = typeof scope.cardDirectory === "string" && scope.cardDirectory ? scope.cardDirectory : null;
  // The whole library, not this project's: how a researcher works follows
  // them, and a method learnt in one project is theirs in the next (owner's
  // capsule vision — one capsule per person; 2026-09-21). It used to read this
  // project's methods plus account-wide ones, and nothing ever wrote an
  // account-wide one, so a method learnt in 「我的研究」 never reached a new
  // project at all.
  /** @type {Map<string, any>} */
  const library = new Map();
  for (const document of await learning.approvedMethods(scope.userId) ?? []) {
    if (!library.has(document.id)) library.set(document.id, document);
  }

  /** @typedef {MountedLearnedMethod & { payload: any, approvedAt: number, carried: number, dependencies: {name: string, digest?: string}[], source: any }} Entry */
  /** @type {Map<string, Entry>} */
  const entries = new Map();
  for (const document of library.values()) {
    const payload = document?.payload ?? {};
    const name = String(payload.frontmatter?.name ?? "");
    const body = String(payload.body ?? "");
    // A method with no name cannot be registered as a skill and cannot be
    // attributed back from a receipt, which makes mounting it strictly worse
    // than not: its bytes ride in every prompt and nothing it does is counted.
    if (!name || !body.trim()) continue;
    const rendered = renderLearnedMethod(payload);
    const directoryName = learnedMethodDirectoryName(String(document.id));
    const bytes = Buffer.byteLength(rendered, "utf8") + methodFileBytes(payload);
    entries.set(String(document.id), {
      id: String(document.id),
      name,
      digest: mountedMethodDigest(payload, sha256),
      directoryName,
      document: rendered,
      // A code skill's scripts, tests and tool schema, which the validator has
      // already checked against each other and against the prefix rules. They
      // count in `bytes` with the body, which is what a caller that hands the
      // text out pays; a mount's run is shown only the card (`promptBytes`),
      // and reads the body and the scripts from the directory.
      files: methodFiles(payload),
      bytes,
      promptBytes: cardDirectory ? learnedMethodCardBytes(payload, directoryName, cardDirectory) : bytes,
      reason: "recent",
      payload,
      source: document,
      approvedAt: Date.parse(String(payload.statusChangedAt ?? payload.createdAt ?? "")) || 0,
      carried: Number(payload.learning?.counts?.carried ?? 0) + Number(payload.learning?.counts?.explored ?? 0),
      dependencies: Array.isArray(payload.dependencies) ? payload.dependencies : [],
    });
  }

  // Who may be mounted for this run: the scope join when a scope is named, the family alone otherwise (the callers that name
  // neither mount the whole library).
  const scoped = scope.scopeId !== undefined;
  const family = scope.family ?? (scoped ? methodFamily(scope.scopeId ?? "") : null);
  const fits = (/** @type {Entry} */ entry) => (scoped
    ? methodFitsScope(entry.payload, { scopeId: scope.scopeId ?? null, family })
    : family === null || methodFamily(entry.payload?.provenance?.capabilityId) === family);
  const byRecency = (/** @type {Entry} */ left, /** @type {Entry} */ right) => right.approvedAt - left.approvedAt
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const candidates = [...entries.values()].filter(fits).sort(byRecency);

  /** @type {{entry: Entry, reason: MountedLearnedMethod["reason"]}[]} */
  const ranked = [];
  /** @type {"embedding" | "lexical" | "recent"} */
  let mode = "recent";
  /** @type {number | null} */
  let topScore = null;
  const query = String(scope.query ?? "").trim();
  if (query && scope.similarity && candidates.length) {
    try {
      const near = await scope.similarity.nearest(query, candidates.map((entry) => entry.source), { limit: METHOD_MOUNT.nearest });
      mode = near.mode === "embedding" ? "embedding" : "lexical";
      topScore = near.length ? Number(near[0].score) : null;
      for (const hit of near) {
        const entry = entries.get(String(hit.method?.id));
        if (entry) ranked.push({ entry, reason: "similarity" });
      }
    } catch {
      // A ranking that cannot be made is a mount that has no question to rank by, never a run without methods.
      ranked.length = 0;
      mode = "recent";
    }
  }
  const ranking = mode !== "recent";
  if (!ranking) for (const entry of candidates) ranked.push({ entry, reason: "recent" });

  // What the nearest reuse. A dependency is pulled in whatever scope it was learnt in: the reference names a method by name and
  // would point at nothing without it. Higher levels are capped (the bundle SkillPyramid retrieves is one abstract method, a few
  // functional ones and the atomic ones they need), the highest level first.
  const levels = computeMethodLevels(/** @type {any} */ ([...entries.values()].map((entry) => ({ name: entry.name, dependencies: entry.dependencies }))));
  const byName = new Map([...entries.values()].map((entry) => [entry.name, entry]));
  const taken = new Set(ranked.map(({ entry }) => entry.id));
  /** @type {{entry: Entry, reason: MountedLearnedMethod["reason"]}[]} */
  const reused = [];
  let abstract = 0;
  let functional = 0;
  const queue = ranked.map(({ entry }) => entry);
  while (queue.length) {
    const entry = /** @type {Entry} */ (queue.shift());
    const wanted = entry.dependencies
      .map((dependency) => byName.get(String(dependency?.name ?? "")))
      .filter((dependency) => dependency && !taken.has(dependency.id))
      .sort((left, right) => (levels.levels.get(/** @type {Entry} */ (right).name) ?? 0) - (levels.levels.get(/** @type {Entry} */ (left).name) ?? 0));
    for (const dependency of /** @type {Entry[]} */ (wanted)) {
      if (taken.has(dependency.id)) continue;
      const level = levels.levels.get(dependency.name) ?? 0;
      if (level >= 2) { if (abstract >= METHOD_MOUNT.abstractMax) continue; abstract += 1; }
      else if (level === 1) { if (functional >= METHOD_MOUNT.functionalMax) continue; functional += 1; }
      taken.add(dependency.id);
      reused.push({ entry: dependency, reason: "dependency" });
      queue.push(dependency);
    }
  }

  // The exposure slot: only where a question ranked the library, because without one every method is already exposure.
  /** @type {{entry: Entry, reason: MountedLearnedMethod["reason"]}[]} */
  const explored = [];
  if (ranking) {
    const pool = candidates.filter((entry) => !taken.has(entry.id))
      .sort((left, right) => left.carried - right.carried || left.approvedAt - right.approvedAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    for (const entry of pool.slice(0, METHOD_MOUNT.explore)) explored.push({ entry, reason: "explore" });
  }

  /** @type {MountedLearnedMethod[]} */
  const selected = [];
  let spent = 0;
  const exposure = explored.length;
  for (const { entry, reason } of [...ranked, ...reused, ...explored]) {
    if (selected.length >= maxCount) break;
    // The exposure slot is held: the others may not take it.
    if (reason !== "explore" && selected.length >= maxCount - exposure) continue;
    // Unlike the capsule half, the first candidate is not exempt from the byte
    // budget. A capsule entry the user wrote is theirs to make enormous; an
    // inferred method that alone exceeds the prompt budget is a distillation
    // defect, and mounting it anyway would tax every child of every run.
    if (spent + entry.promptBytes > maxBytes) {
      scope.onLeftOut?.(entry.id);
      continue;
    }
    spent += entry.promptBytes;
    const { payload: _payload, approvedAt: _approvedAt, carried: _carried, dependencies: _dependencies, source: _source, ...mounted } = entry;
    selected.push({ ...mounted, reason });
  }
  const selectedNames = new Set(selected.map((method) => method.directoryName));
  const wanted = new Set(scope.keep ?? []);
  /** @type {MountedLearnedMethod[]} */
  const kept = [];
  for (const entry of entries.values()) {
    if (!wanted.has(entry.directoryName) || selectedNames.has(entry.directoryName)) continue;
    const { payload: _payload, approvedAt: _approvedAt, carried: _carried, dependencies: _dependencies, source: _source, ...mounted } = entry;
    kept.push({ ...mounted, reason: "recent" });
  }
  Object.defineProperty(selected, "mode", { value: mode, enumerable: false });
  Object.defineProperty(selected, "topScore", { value: topScore, enumerable: false });
  Object.defineProperty(selected, "kept", { value: kept, enumerable: false });
  // The person's own methods that were candidates for this run, selected or not: what an official method of the same scope is read against.
  Object.defineProperty(selected, "candidates", { value: candidates.map((entry) => entry.source), enumerable: false });
  return /** @type {any} */ (selected);
}

// ------------------------------------------------------------------------------------------------------ the platform's tier

/**
 * How many official methods one run is offered at most: the platform's defaults are the lowest tier of what a run is given, and a base tier
 * that fills the room is the tax on every conversation that principle 16 forbids. Three cards, the ones nearest to what was asked.
 */
export const OFFICIAL_METHOD_MOUNT = Object.freeze({ nearest: 3 });

/**
 * How close an official method must be to one of the person's own, by the cosine of their texts' embeddings (`methodSimilarity.pairs`), for
 * the two to be read as about the same thing — and the person's wins. 0.70 and no lower: the one distribution there is of this library, the
 * closest pair of a production library read off the hourly pass on 2026-10-25 (`METHOD_SIMILARITY_PAIR_FLOOR`), was 0.70, and those two
 * methods were related, not the same; the 0.50 candidate floor is a floor for "worth reading together". Being too eager takes a default away
 * from a person whose own method is only near it; being too lax mounts two cards the second of which says "where they differ, the person's
 * own comes first" — so the threshold errs high. Provisional like the numbers it stands beside: every method left out records its score
 * (`leftOut[].score`), so the number is moved by what it shows.
 *
 * With no embedder (the lexical fallback of `methodSimilarity`) the nearness is not decided at all: shared words say two texts use the same
 * vocabulary and not that they say the same thing, and a withheld method needs a better reason than that. Both stay candidates, the person's
 * listed first, and the receipt says the delta was `lexical`.
 */
export const OFFICIAL_PERSONAL_DELTA_COSINE = 0.7;

/** What a mounted official method is called on disk: `_om` and a digest of its identity, which `_lm` (learned) and the entry ids (a capsule's own) never are. @param {string} methodKey */
export function officialMethodDirectoryName(methodKey) {
  return `_om${sha256(String(methodKey ?? "")).slice(0, 32)}`;
}

/**
 * The file an official method is mounted as: its own frontmatter (`name`, `description`, `whenToUse`) and its body, the same shape a learned
 * method's is, so the digest the mount, the receipt and the counters agree on (`mountedMethodDigest`) is computed the one way.
 * @param {{ name: string, description: string, whenToUse: string, body: string }} method
 * @returns {{ document: string, digest: string }}
 */
export function officialMethodDocument(method) {
  const payload = { frontmatter: { name: method.name, description: method.description, whenToUse: method.whenToUse }, body: method.body };
  return { document: renderLearnedMethod(payload), digest: mountedMethodDigest(payload, sha256) };
}

/**
 * The official methods a run is offered — the platform's tier, below everything of the person's own.
 *
 *  1. Of the methods of this run's scope (a capability's id, or `conversation`: the same vocabulary a learned method declares) the nearest
 *     `OFFICIAL_METHOD_MOUNT.nearest` to the first message of the conversation (`query`). Without a question there is nothing to rank by,
 *     and a base tier with no reason to be in front of a run is not in it. A runtime that is not for research (`family`: a GEO run, the
 *     platform's own projects) is offered none.
 *  2. Against the person's own methods that were candidates for the run (`personal`: what they wrote and what was learnt, whichever of them
 *     the mount carried): an official method about the same thing as one of them (`OFFICIAL_PERSONAL_DELTA_COSINE`) is left out of this run, and
 *     the receipt says which one and how near. Nothing is left out on a guess: with no embedder the delta is not decided.
 *
 * What is chosen is spent against what the person's own methods left of the byte budget, by the card each costs; whatever does not fit is
 * counted as left out like any other (`onLeftOut`). `keep` names what a running runtime was already given, as for the learned half: those
 * still in force stay readable on disk (`kept`).
 *
 * The array carries non-enumerable facts for the caller: `leftOut`, the methods the delta kept out with their reason, and `kept`.
 *
 * @param {readonly import('./officialPacks.mjs').OfficialMethod[]} methods the account's official methods (`OfficialPacks.methodsFor`)
 * @param {{ scopeId?: string | null, family?: "geo" | "research" | null, query?: string | null, similarity?: { nearest: Function, pairs: Function } | null,
 *   personal?: readonly any[], maxCount?: number, maxBytes?: number, cardDirectory?: string | null, keep?: Iterable<string> | null,
 *   onLeftOut?: ((methodKey: string) => void) | null }} scope
 * @returns {Promise<any[] & { leftOut: { id: string, name: string, reason: "personal_method", twin: { id: string, name: string }, score: number }[], deltaMode: "embedding" | "lexical" | null, kept: any[] }>}
 */
export async function selectOfficialMethods(methods, scope) {
  const mounted = (/** @type {any} */ method) => {
    const { document, digest } = officialMethodDocument(method);
    const directoryName = officialMethodDirectoryName(method.key);
    const bytes = Buffer.byteLength(document, "utf8");
    const promptBytes = scope.cardDirectory
      ? learnedMethodCardBytes({ frontmatter: { name: method.name, description: method.description, whenToUse: method.whenToUse } }, directoryName, scope.cardDirectory) : bytes;
    return { id: method.key, name: method.name, digest, directoryName, document, files: {}, bytes, promptBytes, reason: "similarity", official: true,
      packId: method.packId, methodId: method.methodId, sha: method.sha, entryId: method.entryId };
  };
  /** @type {any} */
  const result = [];
  Object.defineProperty(result, "leftOut", { value: [], enumerable: false });
  Object.defineProperty(result, "deltaMode", { value: null, enumerable: false, writable: true });
  const wanted = new Set(scope.keep ?? []);
  const kept = (methods ?? []).map(mounted).filter((method) => wanted.has(method.directoryName));
  Object.defineProperty(result, "kept", { value: kept, enumerable: false, writable: true });
  const maxCount = Number.isSafeInteger(scope.maxCount) ? Number(scope.maxCount) : OFFICIAL_METHOD_MOUNT.nearest;
  const maxBytes = Number.isSafeInteger(scope.maxBytes) ? Number(scope.maxBytes) : Number.POSITIVE_INFINITY;
  const query = String(scope.query ?? "").trim();
  if (!methods?.length || maxCount <= 0 || scope.family === null || scope.family === "geo" || !query || !scope.similarity) return result;

  const runScope = scope.scopeId == null ? CONVERSATION_SCOPE : scope.scopeId;
  const docs = methods.filter((method) => method.scope.includes(runScope)).map((method) => ({ id: method.key,
    payload: { frontmatter: { name: method.name, description: method.description, whenToUse: method.whenToUse }, contentDigest: `sha256:${method.sha}` }, method }));
  if (!docs.length) return result;
  /** @type {any[]} */
  let near;
  try { near = await scope.similarity.nearest(query, docs, { limit: Math.min(maxCount, OFFICIAL_METHOD_MOUNT.nearest) }); } catch { return result; }
  const hits = near.map((hit) => hit.method).filter(Boolean);
  if (!hits.length) return result;

  // The person's own methods that say the same thing win.
  /** @type {Map<string, { twin: { id: string, name: string }, score: number }>} */
  const covered = new Map();
  const personal = [...(scope.personal ?? [])];
  if (personal.length) {
    try {
      const everything = [...hits, ...personal];
      const pairs = await scope.similarity.pairs(everything, { topK: everything.length, floor: OFFICIAL_PERSONAL_DELTA_COSINE });
      result.deltaMode = pairs.mode === "embedding" ? "embedding" : "lexical";
      if (pairs.mode === "embedding") {
        const own = new Map(personal.map((document) => [String(document.id), document]));
        for (const pair of pairs) {
          const [official, other] = hits.some((hit) => hit.id === pair.a) ? [pair.a, pair.b] : [pair.b, pair.a];
          if (!hits.some((hit) => hit.id === official) || !own.has(other)) continue;
          const held = covered.get(official);
          if (!held || pair.score > held.score) {
            const document = own.get(other);
            covered.set(official, { twin: { id: String(other), name: String(document?.payload?.frontmatter?.name ?? document?.name ?? other) }, score: pair.score });
          }
        }
      }
    } catch {
      // A nearness that cannot be read leaves both in: nothing is withheld on a failure.
      result.deltaMode = "lexical";
    }
  }
  let spent = 0;
  for (const hit of hits) {
    const twin = covered.get(hit.id);
    if (twin) {
      result.leftOut.push({ id: hit.id, name: hit.method.name, reason: "personal_method", twin: twin.twin, score: Math.round(twin.score * 1e4) / 1e4 });
      continue;
    }
    if (result.length >= maxCount) break;
    const entry = mounted(hit.method);
    if (spent + entry.promptBytes > maxBytes) { scope.onLeftOut?.(entry.id); continue; }
    spent += entry.promptBytes;
    result.push(entry);
  }
  const selectedNames = new Set(result.map((method) => method.directoryName));
  Object.defineProperty(result, "kept", { value: kept.filter((method) => !selectedNames.has(method.directoryName)), enumerable: false, writable: true });
  return result;
}
