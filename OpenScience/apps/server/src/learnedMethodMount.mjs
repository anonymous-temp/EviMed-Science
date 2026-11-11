import { CONTEXT_ITEM_FIELDS, contextPolicyIdentity } from "./geoContextItems.mjs";
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

import { METHOD_FILE_PREFIXES, METHOD_MOUNT, abstractMembersOf, computeMethodLevels, learnedMethodCardEntry, methodCardFacts, mountedMethodDigest, renderMethodSkill } from "@evimed/domain";
import { EVIDENCE_PROJECT_ID, FRONTIER_PROJECT_ID, LEARNING_PROJECT_ID, SOURCES_PROJECT_ID } from "./internalProjects.mjs";
import { createMethodSimilarity } from "./methodSimilarity.mjs";

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
 *  - Everything else — a conversation, a research run, a scheduled run,
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
 * resolve. `card`, given only where the mount writes one (`OPEN_SCIENCE_METHOD_CARD_EVIDENCE_ENABLED`, `methodCardFacts`), is budgeted with
 * the lines it adds; without it the bytes are what they always were.
 * @param {any} payload @param {string} directoryName @param {string} cardDirectory
 * @param {{ evidence: string[], counterexamples: string[], verified: boolean, rewrites?: {count: number, dates: string[]} } | null} [card]
 * @returns {number}
 */
export function learnedMethodCardBytes(payload, directoryName, cardDirectory, card = null) {
  const frontmatter = payload?.frontmatter ?? {};
  const lines = learnedMethodCardEntry({
    name: String(frontmatter.name ?? ""),
    description: String(frontmatter.description ?? ""),
    whenToUse: String(frontmatter.whenToUse ?? ""),
    path: `${String(cardDirectory).replace(/\/+$/, "")}/${directoryName}/SKILL.md`,
    ...(card ? { card } : {}),
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
 * @property {"similarity" | "dependency" | "explore" | "recent" | "abstraction"} reason why its card is in front of the run (`METHOD_MOUNT_REASONS`)
 * @property {{ evidence: string[], counterexamples: string[], verified: boolean, rewrites?: {count: number, dates: string[]} }} [card] what the card adds (`OPEN_SCIENCE_METHOD_CARD_EVIDENCE_ENABLED`)
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
 * pulled in by similarity can be read against a real library; `kept`, above; and `levels`, each method's level as the mount read it.
 *
 * Two experiment switches, both off by default (plan 2026-11-04 §5.4), so one commit runs with and without them:
 *  - `pyramid` (`OPEN_SCIENCE_METHOD_PYRAMID_ENABLED`, defect 12): an abstract method's members (`metadata.derived_from`) count toward
 *    its level, and after the similarity selection and the downward closure the mount adds, for the selected methods, the most
 *    relevant abstract parent each, at most `METHOD_MOUNT.abstractMax`, reason `abstraction` (`planMethodSelection`); the cards are
 *    listed abstract → functional → atomic.
 *  - `minSimilarity` (`OPEN_SCIENCE_METHOD_MOUNT_MIN_SIMILARITY`, defect 9): a cosine floor for the similarity selection; 0 is none.
 * And `cardEvidence` (`OPEN_SCIENCE_METHOD_CARD_EVIDENCE_ENABLED`, off by default): each method carries `card` (`methodCardFacts`: up to two
 * quotations it rests on, two situations it is not for, and whether it was used after its last change and not corrected), budgeted with the
 * card's lines. SKILL.md and the digest are untouched.
 *
 * @param {any} learning `LearningService`
 * @param {{userId: string, contextPolicy?: any, contextItems?: any, contextProvenance?: any, projectId: string, maxCount?: number, maxBytes?: number, family?: "geo" | "research" | null,
 *   scopeId?: string | null, query?: string | null, similarity?: { nearest: Function } | null, keep?: Iterable<string> | null,
 *   cardDirectory?: string | null, onLeftOut?: ((methodId: string) => void) | null, pyramid?: boolean, minSimilarity?: number, cardEvidence?: boolean}} scope
 * @returns {Promise<MountedLearnedMethod[] & { mode?: "embedding" | "lexical" | "recent", topScore?: number | null, kept?: MountedLearnedMethod[], levels?: Map<string, number> }>}
 */
export async function selectLearnedMethods(learning, scope) {
  /** @type {any} */
  const empty = [];
  if (!learning) return empty;
  if(scope.contextPolicy?.kind === "geo-project" && (scope.contextPolicy.ownerId!==scope.userId || scope.contextPolicy.controlProjectId!==scope.projectId)) return empty;
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
  const shared=scope.contextPolicy?.kind === "geo-project";
  if(shared) {
    if(!scope.contextItems || !learning.listMethods || !learning.getMethod) return empty;
    let cursor=null; const seen=new Set();
    do {
      const page=await learning.listMethods(scope.userId,{projectId:scope.contextPolicy.controlProjectId,status:"approved",limit:100,cursor,fields:CONTEXT_ITEM_FIELDS});
      for(const metadata of page.items) {
        if(metadata.payload?.provenance?.sourceProjectId!==scope.contextPolicy.controlProjectId || !await scope.contextItems.method(scope.contextPolicy,metadata)) continue;
        const full=await learning.getMethod(scope.userId,metadata.id,{expectedRevision:metadata.revision}).catch(error=>{
          if(error?.code==='method_not_found')return null;throw error;
        });
        if(full?.revision===metadata.revision && full.payload.status==="approved" && await scope.contextItems.method(scope.contextPolicy,full)) library.set(full.id,full);
      }
      cursor=page.nextCursor;
      if(cursor && seen.has(cursor)) return empty;
      seen.add(cursor);
    } while(cursor);
    // Missing or foreign dependencies exclude their dependents before ranking,
    // exploration, rendering and keep handling. Require the exact name@digest.
    let changed=true;
    while(changed) {
      changed=false;
      for(const [id,document] of library) if((document.payload.dependencies??[]).some(dependency=>
        ![...library.values()].some(other=>other.payload.frontmatter?.name===dependency.name && other.payload.contentDigest===dependency.digest))) {
        library.delete(id); changed=true;
      }
    }
  } else {
    // The owner's own library, without what a shared GEO project learnt: a member's correction is that project's method and
    // never one of the owner's other conversations (`GeoContextProvenance.ordinaryDocument`; owner ruling 2026-10-25).
    const provenance = scope.contextProvenance ?? learning.contextProvenance ?? null;
    /** @type {Map<string, Promise<any>>} */
    const policies = new Map();
    for (const document of await learning.approvedMethods(scope.userId) ?? []) {
      if (library.has(document.id)) continue;
      if (provenance && !await provenance.ordinaryDocument(scope.userId, document, policies)) continue;
      library.set(document.id, document);
    }
  }

  // The pyramid (`OPEN_SCIENCE_METHOD_PYRAMID_ENABLED`, `pyramid`): an abstract method's members count toward its level and the mount
  // adds the most relevant abstract parent above what it selected. Off, every line below reads the library as it always did.
  const pyramid = scope.pyramid === true;
  const libraryNames = pyramid
    ? new Set([...library.values()].map((document) => String(document?.payload?.frontmatter?.name ?? "")).filter(Boolean)) : null;

  /** @typedef {MountedLearnedMethod & PlanEntry & { payload: any }} Entry */
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
    const card = scope.cardEvidence === true ? methodCardFacts(payload) : null;
    entries.set(String(document.id), {
      id: String(document.id),
      ...(shared ? {revision:document.revision,contentDigest:payload.contentDigest,contextPolicy:contextPolicyIdentity(scope.contextPolicy)} : {}),
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
      promptBytes: cardDirectory ? learnedMethodCardBytes(payload, directoryName, cardDirectory, card) : bytes,
      reason: "recent",
      // What the card adds (`cardEvidence`); absent when the switch is off, so the entry is what it always was.
      ...(card ? { card } : {}),
      payload,
      source: document,
      approvedAt: Date.parse(String(payload.statusChangedAt ?? payload.createdAt ?? "")) || 0,
      carried: Number(payload.learning?.counts?.carried ?? 0) + Number(payload.learning?.counts?.explored ?? 0),
      dependencies: Array.isArray(payload.dependencies) ? payload.dependencies : [],
      derivedFrom: libraryNames ? abstractMembersOf(payload.frontmatter, libraryNames) : [],
      role: typeof payload.frontmatter?.metadata?.role === "string" ? payload.frontmatter.metadata.role : null,
    });
  }

  // Who may be mounted for this run: the scope join when a scope is named, the family alone otherwise (the callers that name
  // neither mount the whole library).
  const scoped = scope.scopeId !== undefined;
  const family = scope.family ?? (scoped ? methodFamily(scope.scopeId ?? "") : null);
  const fits = (/** @type {Entry} */ entry) => (scoped
    ? methodFitsScope(entry.payload, { scopeId: scope.scopeId ?? null, family })
    : family === null || methodFamily(entry.payload?.provenance?.capabilityId) === family);
  const candidates = [...entries.values()].filter(fits).sort(byRecency);

  const plan = await planMethodSelection(/** @type {Map<string, PlanEntry>} */ (entries), candidates, {
    query: scope.query, similarity: scope.similarity, pyramid, minSimilarity: scope.minSimilarity,
    fits: (/** @type {PlanEntry} */ entry) => fits(/** @type {Entry} */ (entry)),
  });

  /** @type {MountedLearnedMethod[]} */
  const selected = [];
  let spent = 0;
  const exposure = plan.explored.length;
  for (const { entry: planned, reason } of [...plan.ranked, ...plan.reused, ...plan.parents, ...plan.explored]) {
    const entry = /** @type {Entry} */ (planned);
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
    if(shared && !await scope.contextItems.method(scope.contextPolicy,entry.source)) continue;
    spent += entry.promptBytes;
    selected.push({ ...mountedOf(entry), reason });
  }
  // The pyramid lists the cards from the most abstract down, so a run reads the frame before the steps (SkillPyramid's two-stage
  // use); within a level the order is the selection's. The budget above was spent in the selection's order, nearest first.
  if (pyramid) orderByLevel(selected, plan.levels);
  const selectedNames = new Set(selected.map((method) => method.directoryName));
  const wanted = new Set(shared ? [] : scope.keep ?? []);
  /** @type {MountedLearnedMethod[]} */
  const kept = [];
  for (const entry of entries.values()) {
    if (!wanted.has(entry.directoryName) || selectedNames.has(entry.directoryName)) continue;
    kept.push({ ...mountedOf(entry), reason: "recent" });
  }
  Object.defineProperty(selected, "mode", { value: plan.mode, enumerable: false });
  Object.defineProperty(selected, "topScore", { value: plan.topScore, enumerable: false });
  Object.defineProperty(selected, "kept", { value: kept, enumerable: false });
  // The person's own methods that were candidates for this run, selected or not: what an official method of the same scope is read against.
  Object.defineProperty(selected, "candidates", { value: candidates.map((entry) => entry.source), enumerable: false });
  // Each method's level in the library as the mount read it (`computeMethodLevels`; with the pyramid, abstract members counted).
  Object.defineProperty(selected, "levels", { value: plan.levels, enumerable: false });
  // What the selected methods reuse, by pin, whatever library holds it: an official method one of them depends on is the official tier's to
  // mount (`selectOfficialMethods`, in-loop), because the learned library does not hold it.
  Object.defineProperty(selected, "dependencies", { value: selected.flatMap((method) => entries.get(method.id)?.dependencies ?? []), enumerable: false });
  return /** @type {any} */ (selected);
}

/** Most recently approved first, ties on id compared as code units (see `selectLearnedMethods`). @param {PlanEntry} left @param {PlanEntry} right */
const byRecency = (left, right) => right.approvedAt - left.approvedAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

/** The fields a selection works with and never hands out. */
const PLAN_FIELDS = ["payload", "approvedAt", "carried", "dependencies", "source", "derivedFrom", "role", "method"];

/** A selected entry as the caller receives it: what is mounted, without what the selection read. @param {Record<string, any>} entry */
function mountedOf(entry) {
  /** @type {Record<string, any>} */
  const mounted = {};
  for (const [key, value] of Object.entries(entry)) if (!PLAN_FIELDS.includes(key)) mounted[key] = value;
  return /** @type {any} */ (mounted);
}

/**
 * Sort in place from the highest level to the lowest, stable within a level: abstract, then functional, then atomic.
 * @param {{ name: string }[]} methods @param {Map<string, number>} levels
 */
function orderByLevel(methods, levels) {
  const indexed = methods.map((method, index) => ({ method, index, level: levels.get(method.name) ?? 0 }));
  indexed.sort((left, right) => right.level - left.level || left.index - right.index);
  indexed.forEach(({ method }, index) => { methods[index] = method; });
}

/**
 * @typedef {object} PlanEntry
 * @property {string} id
 * @property {string} name
 * @property {{ name: string, digest?: string }[]} dependencies  what it reuses (`depends_on`)
 * @property {string[]} derivedFrom  for an abstract method, the library's methods it abstracts (`abstractMembersOf`); empty unless the pyramid is read
 * @property {string | null} role  `metadata.role`, a label: only `abstract` is read, to find a selected method's parents
 * @property {number} approvedAt
 * @property {number} carried  how often it has been in front of a model (`counts.carried` + `counts.explored`)
 * @property {any} source  the document the similarity module reads
 */

/**
 * The order in which a library is offered to a run, before any budget is spent: the retrieval SkillPyramid makes (plan 2026-10-23
 * §5, S5), with the upward pass of plan 2026-11-04 §5.4 defect 12 when `pyramid` is set. Pure apart from the similarity call.
 *
 *  1. `pinned`, when given: methods the run must carry because something else it carries reuses them (an official method a
 *     person's own method depends on), reason `dependency`.
 *  2. `ranked`: the `nearest` candidates closest to `query` (`similarity.nearest`, with a cosine floor `minSimilarity` when above
 *     0), reason `similarity`; without a query, or when the similarity cannot answer, every candidate most recently approved first,
 *     reason `recent` (unless `recentFallback` is false, when nothing is ranked). `screenRanked` may take hits back first: those are
 *     neither selected nor followed.
 *  3. `reused`: what those reuse, by name, from the whole library (`entries`), reason `dependency`, highest level first, capped by
 *     level (`abstractMax` at level 2 and above, `functionalMax` at level 1; atomic ones uncapped).
 *  4. `parents` (pyramid only): for the methods above, in their order, the single most relevant abstract method each was derived
 *     into or is reused by (`role: abstract`, its `derivedFrom` or `dependencies` naming the method), at most `abstractMax` in all,
 *     reason `abstraction`. Most relevant: covering the most of what was selected, then closest to the query, then most recently
 *     approved. A parent must be one this run may be offered (`fits`).
 *  5. `explored`: when a query ranked the library, `explore` slots for the candidates that have been in front of a model least.
 *
 * `levels` is `computeMethodLevels` over the library — with the pyramid, abstract members counted.
 * @param {Map<string, PlanEntry>} entries the whole library by id
 * @param {readonly PlanEntry[]} candidates the entries this run may be offered by similarity or exposure, most recently approved first
 * @param {{ query?: string | null, similarity?: { nearest: Function } | null, pyramid?: boolean, minSimilarity?: number, nearest?: number,
 *   explore?: number, abstractMax?: number, functionalMax?: number, recentFallback?: boolean, pinned?: readonly PlanEntry[],
 *   fits?: ((entry: PlanEntry) => boolean) | null, screenRanked?: ((ranked: PlanEntry[]) => Promise<Set<string> | null>) | null }} [options]
 * @returns {Promise<{ pinned: {entry: PlanEntry, reason: string}[], ranked: {entry: PlanEntry, reason: string}[], reused: {entry: PlanEntry, reason: string}[],
 *   parents: {entry: PlanEntry, reason: string}[], explored: {entry: PlanEntry, reason: string}[], mode: "embedding" | "lexical" | "recent",
 *   topScore: number | null, levels: Map<string, number> }>}
 */
export async function planMethodSelection(entries, candidates, options = {}) {
  const pyramid = options.pyramid === true;
  const nearestLimit = Number.isSafeInteger(options.nearest) ? Number(options.nearest) : METHOD_MOUNT.nearest;
  const abstractMax = Number.isSafeInteger(options.abstractMax) ? Number(options.abstractMax) : METHOD_MOUNT.abstractMax;
  const functionalMax = Number.isSafeInteger(options.functionalMax) ? Number(options.functionalMax) : METHOD_MOUNT.functionalMax;
  const exploreSlots = Number.isSafeInteger(options.explore) ? Number(options.explore) : METHOD_MOUNT.explore;
  const minSimilarity = Number(options.minSimilarity ?? 0);
  const byId = (/** @type {PlanEntry} */ left, /** @type {PlanEntry} */ right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

  /** @type {{entry: PlanEntry, reason: string}[]} */
  const pinned = [];
  const taken = new Set();
  for (const entry of options.pinned ?? []) {
    if (taken.has(entry.id)) continue;
    taken.add(entry.id);
    pinned.push({ entry, reason: "dependency" });
  }

  /** @type {{entry: PlanEntry, reason: string}[]} */
  const ranked = [];
  /** @type {"embedding" | "lexical" | "recent"} */
  let mode = "recent";
  /** @type {number | null} */
  let topScore = null;
  /** @type {Map<string, number>} closeness to the query of every candidate the similarity scored, for choosing a parent */
  const scores = new Map();
  const query = String(options.query ?? "").trim();
  const pool = candidates.filter((entry) => !taken.has(entry.id));
  if (query && options.similarity && pool.length) {
    try {
      // The pyramid asks for every candidate's closeness, so a parent can be chosen by it; the flat mount asks for the nearest only.
      const near = await options.similarity.nearest(query, pool.map((entry) => entry.source), {
        limit: pyramid ? pool.length : nearestLimit,
        ...(Number.isFinite(minSimilarity) && minSimilarity > 0 ? { minScore: minSimilarity } : {}),
      });
      mode = near.mode === "embedding" ? "embedding" : "lexical";
      topScore = near.length ? Number(near[0].score) : null;
      for (const hit of near) {
        const entry = entries.get(String(hit.method?.id));
        if (!entry || taken.has(entry.id)) continue;
        scores.set(entry.id, Number(hit.score));
        if (ranked.length < nearestLimit) ranked.push({ entry, reason: "similarity" });
      }
    } catch {
      // A ranking that cannot be made is a mount that has no question to rank by, never a run without methods.
      ranked.length = 0;
      scores.clear();
      mode = "recent";
      topScore = null;
    }
  }
  const ranking = mode !== "recent";
  if (!ranking && options.recentFallback !== false) for (const entry of pool) ranked.push({ entry, reason: "recent" });
  // A caller may take hits back before anything is drawn in for them (the official tier yields a hit to the person's own method that says
  // the same thing): what it takes back is neither selected nor a reason for a dependency or a parent.
  if (options.screenRanked && ranked.length) {
    const dropped = await options.screenRanked(ranked.map(({ entry }) => entry));
    if (dropped?.size) for (let index = ranked.length - 1; index >= 0; index -= 1) if (dropped.has(ranked[index].entry.id)) ranked.splice(index, 1);
  }
  for (const { entry } of ranked) taken.add(entry.id);

  // What the selected reuse. A dependency is pulled in whatever scope it was learnt in: the reference names a method by name and
  // would point at nothing without it. Higher levels are capped (the bundle SkillPyramid retrieves is one abstract method, a few
  // functional ones and the atomic ones they need), the highest level first.
  const levels = computeMethodLevels(/** @type {any} */ ([...entries.values()].map((entry) => ({
    name: entry.name, dependencies: entry.dependencies, ...(pyramid && entry.derivedFrom?.length ? { derivedFrom: entry.derivedFrom } : {}),
  })))).levels;
  const byName = new Map([...entries.values()].map((entry) => [entry.name, entry]));
  /** @type {{entry: PlanEntry, reason: string}[]} */
  const reused = [];
  let abstract = 0;
  let functional = 0;
  const queue = [...pinned, ...ranked].map(({ entry }) => entry);
  while (queue.length) {
    const entry = /** @type {PlanEntry} */ (queue.shift());
    const wanted = entry.dependencies
      .map((dependency) => byName.get(String(dependency?.name ?? "")))
      .filter((dependency) => dependency && !taken.has(dependency.id))
      .sort((left, right) => (levels.get(/** @type {PlanEntry} */ (right).name) ?? 0) - (levels.get(/** @type {PlanEntry} */ (left).name) ?? 0));
    for (const dependency of /** @type {PlanEntry[]} */ (wanted)) {
      if (taken.has(dependency.id)) continue;
      const level = levels.get(dependency.name) ?? 0;
      if (level >= 2) { if (abstract >= abstractMax) continue; abstract += 1; }
      else if (level === 1) { if (functional >= functionalMax) continue; functional += 1; }
      taken.add(dependency.id);
      reused.push({ entry: dependency, reason: "dependency" });
      queue.push(dependency);
    }
  }

  // Upward: the abstract method a selected one belongs to, which the similarity alone almost never reaches (defect 12).
  /** @type {{entry: PlanEntry, reason: string}[]} */
  const parents = [];
  if (pyramid && abstractMax > 0) {
    /** @param {PlanEntry} entry @returns {Set<string>} */
    const membersOf = (entry) => new Set([...(entry.derivedFrom ?? []), ...entry.dependencies.map((dependency) => String(dependency?.name ?? ""))]);
    /** @type {Map<string, PlanEntry[]>} */
    const parentsOf = new Map();
    for (const entry of entries.values()) {
      if (entry.role !== "abstract") continue;
      for (const member of membersOf(entry)) parentsOf.set(member, [...(parentsOf.get(member) ?? []), entry]);
    }
    const chosen = [...pinned, ...ranked, ...reused].map(({ entry }) => entry);
    const chosenNames = new Set(chosen.map((entry) => entry.name));
    const covers = (/** @type {PlanEntry} */ parent) => [...membersOf(parent)].filter((name) => chosenNames.has(name)).length;
    const closeness = (/** @type {PlanEntry} */ parent) => scores.get(parent.id) ?? Number.NEGATIVE_INFINITY;
    for (const entry of chosen) {
      if (parents.length >= abstractMax) break;
      const options_ = (parentsOf.get(entry.name) ?? []).filter((parent) => !taken.has(parent.id) && (!options.fits || options.fits(parent)));
      if (!options_.length) continue;
      options_.sort((left, right) => covers(right) - covers(left) || (closeness(right) - closeness(left) || 0) || right.approvedAt - left.approvedAt || byId(left, right));
      taken.add(options_[0].id);
      parents.push({ entry: options_[0], reason: "abstraction" });
    }
  }

  // The exposure slot: only where a question ranked the library, because without one every method is already exposure.
  /** @type {{entry: PlanEntry, reason: string}[]} */
  const explored = [];
  if (ranking && exploreSlots > 0) {
    const rest = candidates.filter((entry) => !taken.has(entry.id))
      .sort((left, right) => left.carried - right.carried || left.approvedAt - right.approvedAt || byId(left, right));
    for (const entry of rest.slice(0, exploreSlots)) explored.push({ entry, reason: "explore" });
  }
  return { pinned, ranked, reused, parents, explored, mode, topScore, levels };
}

/** Where a runtime sees the mounted methods (`runtimeCapsuleMethodsDir` in `capsuleMethods.mjs`, which imports this module): the path a card names. */
const OFFLINE_CARD_DIRECTORY = "/runtime/capsule-methods";

/**
 * The mount's own selection, for an offline experiment that has a library of method documents and no control-plane database (plan
 * 2026-11-04 §5.5 C1: libraries built from text-game trajectories, selected "flat" — every switch off — or "pyramid" — `options.pyramid`
 * — by exactly the product's code). A thin adapter over `selectLearnedMethods`: the library stands in for the account's approved
 * methods (a document without a `status` is read as approved; any other status is not mounted, as in the product), the task text is
 * the conversation's first message, and `embed` (texts → vectors) is the embedder, without which closeness is read by shared words
 * (`createMethodSimilarity`). No scope is applied unless `options.scopeId` or `options.family` names one.
 *
 * Returns the cards in the order a run is shown them, each with why it is there (`METHOD_MOUNT_REASONS`), its level in the library,
 * and the card's lines (`learnedMethodCardEntry`); `mode` and `topScore` say how the library was ranked.
 * @param {{ library: readonly any[], taskText?: string | null, embed?: ((texts: string[]) => Promise<number[][]>) | null,
 *   options?: { pyramid?: boolean, minSimilarity?: number, cardEvidence?: boolean, scopeId?: string | null, family?: "geo" | "research" | null,
 *     maxCount?: number, maxBytes?: number, cardDirectory?: string, similarity?: { nearest: Function } | null } }} input
 * @returns {Promise<{ cards: { id: string, name: string, reason: string, level: number, digest: string, directoryName: string, promptBytes: number, lines: string[] }[],
 *   mode: "embedding" | "lexical" | "recent", topScore: number | null }>}
 */
export async function selectMethodsForTask({ library, taskText = null, embed = null, options = {} }) {
  const documents = (library ?? []).filter((document) => document && (document.payload?.status ?? "approved") === "approved");
  const cardDirectory = typeof options.cardDirectory === "string" && options.cardDirectory ? options.cardDirectory : OFFLINE_CARD_DIRECTORY;
  const selected = await selectLearnedMethods({ approvedMethods: async () => documents }, {
    userId: "offline",
    projectId: "offline",
    query: taskText,
    similarity: options.similarity ?? createMethodSimilarity({ embed }),
    cardDirectory,
    pyramid: options.pyramid === true,
    minSimilarity: Number(options.minSimilarity ?? 0),
    cardEvidence: options.cardEvidence === true,
    ...(options.scopeId === undefined ? {} : { scopeId: options.scopeId }),
    ...(options.family === undefined ? {} : { family: options.family }),
    ...(Number.isSafeInteger(options.maxCount) ? { maxCount: options.maxCount } : {}),
    ...(Number.isSafeInteger(options.maxBytes) ? { maxBytes: options.maxBytes } : {}),
  });
  const byId = new Map(documents.map((document) => [String(document.id), document]));
  const levels = /** @type {any} */ (selected).levels ?? new Map();
  return {
    cards: selected.map((method) => {
      const frontmatter = byId.get(method.id)?.payload?.frontmatter ?? {};
      return {
        id: method.id, name: method.name, reason: method.reason, level: levels.get(method.name) ?? 0, digest: method.digest,
        directoryName: method.directoryName, promptBytes: method.promptBytes,
        ...(method.card ? { card: method.card } : {}),
        lines: learnedMethodCardEntry({ name: method.name, description: String(frontmatter.description ?? ""), whenToUse: String(frontmatter.whenToUse ?? ""),
          path: `${cardDirectory.replace(/\/+$/, "")}/${method.directoryName}/SKILL.md`, ...(method.card ? { card: method.card } : {}) }),
      };
    }),
    mode: /** @type {any} */ (selected).mode ?? "recent",
    topScore: /** @type {any} */ (selected).topScore ?? null,
  };
}

// ------------------------------------------------------------------------------------------------------ the platform's tier

/**
 * How many official methods one run is offered at most: the platform's defaults are the lowest tier of what a run is given, and a base tier
 * that fills the room is the tax on every conversation that principle 16 forbids. Three cards, the ones nearest to what was asked.
 *
 * `inLoop` is the tier's own cap when it is selected like the person's library (`OPEN_SCIENCE_METHOD_OFFICIAL_IN_LOOP_ENABLED`): still at most
 * `nearest` by similarity, and room for what those reuse, the abstract method above them and the official methods a person's own selected
 * method depends on, which count toward it. Provisional, like the other mount numbers: what it leaves out is counted (`onLeftOut`).
 */
export const OFFICIAL_METHOD_MOUNT = Object.freeze({ nearest: 3, inLoop: 6 });

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
 * `inLoop` (`OPEN_SCIENCE_METHOD_OFFICIAL_IN_LOOP_ENABLED`, off by default; plan 2026-11-04 §5.4 defect 14): instead of "nearest three, flat",
 * the tier is selected by the same selection as the person's library (`planMethodSelection`): the official methods a selected method of the
 * person's depends on (`personalDependencies`, by name) first, reason `dependency`, even without a question; then the nearest of this run's
 * scope, less those the personal delta takes back; what they reuse; and with `pyramid` the abstract method above them (reason `abstraction`,
 * cards abstract first). All of it within `OFFICIAL_METHOD_MOUNT.inLoop`, the dependencies of the person's methods included. `minSimilarity`
 * is the similarity floor (`OPEN_SCIENCE_METHOD_MOUNT_MIN_SIMILARITY`).
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
 *   onLeftOut?: ((methodKey: string) => void) | null, inLoop?: boolean, pyramid?: boolean, minSimilarity?: number,
 *   personalDependencies?: readonly { name: string, digest?: string }[] }} scope
 * @returns {Promise<any[] & { leftOut: { id: string, name: string, reason: "personal_method", twin: { id: string, name: string }, score: number }[], deltaMode: "embedding" | "lexical" | null, kept: any[] }>}
 */
export async function selectOfficialMethods(methods, scope) {
  const mounted = (/** @type {any} */ method, reason = "similarity") => {
    const { document, digest } = officialMethodDocument(method);
    const directoryName = officialMethodDirectoryName(method.key);
    const bytes = Buffer.byteLength(document, "utf8");
    const promptBytes = scope.cardDirectory
      ? learnedMethodCardBytes({ frontmatter: { name: method.name, description: method.description, whenToUse: method.whenToUse } }, directoryName, scope.cardDirectory) : bytes;
    return { id: method.key, name: method.name, digest, directoryName, document, files: {}, bytes, promptBytes, reason, official: true,
      packId: method.packId, methodId: method.methodId, sha: method.sha, entryId: method.entryId };
  };
  /** @type {any} */
  const result = [];
  Object.defineProperty(result, "leftOut", { value: [], enumerable: false });
  Object.defineProperty(result, "deltaMode", { value: null, enumerable: false, writable: true });
  const wanted = new Set(scope.keep ?? []);
  const kept = (methods ?? []).map((method) => mounted(method)).filter((method) => wanted.has(method.directoryName));
  Object.defineProperty(result, "kept", { value: kept, enumerable: false, writable: true });
  const inLoop = scope.inLoop === true;
  const maxCount = Number.isSafeInteger(scope.maxCount) ? Number(scope.maxCount) : inLoop ? OFFICIAL_METHOD_MOUNT.inLoop : OFFICIAL_METHOD_MOUNT.nearest;
  const maxBytes = Number.isSafeInteger(scope.maxBytes) ? Number(scope.maxBytes) : Number.POSITIVE_INFINITY;
  const query = String(scope.query ?? "").trim();
  const runScope = scope.scopeId == null ? CONVERSATION_SCOPE : scope.scopeId;
  const docOf = (/** @type {any} */ method) => ({ id: method.key,
    payload: { frontmatter: { name: method.name, description: method.description, whenToUse: method.whenToUse }, contentDigest: `sha256:${method.sha}` }, method });
  const finish = () => {
    const selectedNames = new Set(result.map((/** @type {any} */ method) => method.directoryName));
    Object.defineProperty(result, "kept", { value: kept.filter((method) => !selectedNames.has(method.directoryName)), enumerable: false, writable: true });
    return result;
  };

  if (inLoop) {
    if (!methods?.length || maxCount <= 0 || scope.family === null || scope.family === "geo") return result;
    const cap = Math.min(maxCount, OFFICIAL_METHOD_MOUNT.inLoop);
    /** @type {Map<string, PlanEntry & { method: any }>} */
    const entries = new Map(methods.map((method) => [method.key, { id: method.key, name: method.name,
      dependencies: Array.isArray(method.dependencies) ? method.dependencies : [], derivedFrom: [], role: method.role ?? null,
      approvedAt: 0, carried: 0, source: docOf(method), method }]));
    const inScope = (/** @type {PlanEntry} */ entry) => /** @type {any} */ (entry).method.scope.includes(runScope);
    const reused = new Set((scope.personalDependencies ?? []).map((dependency) => String(dependency?.name ?? "")));
    const plan = await planMethodSelection(entries, [...entries.values()].filter(inScope), {
      query: scope.similarity ? query : null, similarity: scope.similarity ?? null, pyramid: scope.pyramid === true, minSimilarity: scope.minSimilarity,
      nearest: Math.min(cap, OFFICIAL_METHOD_MOUNT.nearest), explore: 0, recentFallback: false, fits: inScope,
      pinned: [...entries.values()].filter((entry) => reused.has(entry.name)),
      screenRanked: async (hits) => {
        const covered = await personalTwins(hits.map((entry) => /** @type {any} */ (entry).source), scope, result);
        for (const hit of hits) {
          const twin = covered.get(hit.id);
          if (twin) result.leftOut.push({ id: hit.id, name: hit.name, reason: "personal_method", twin: twin.twin, score: Math.round(twin.score * 1e4) / 1e4 });
        }
        return new Set(covered.keys());
      },
    });
    let spent = 0;
    for (const { entry, reason } of [...plan.pinned, ...plan.ranked, ...plan.reused, ...plan.parents]) {
      if (result.length >= cap) break;
      const chosen = mounted(/** @type {any} */ (entry).method, reason);
      if (spent + chosen.promptBytes > maxBytes) { scope.onLeftOut?.(chosen.id); continue; }
      spent += chosen.promptBytes;
      result.push(chosen);
    }
    if (scope.pyramid === true) orderByLevel(result, plan.levels);
    return finish();
  }

  if (!methods?.length || maxCount <= 0 || scope.family === null || scope.family === "geo" || !query || !scope.similarity) return result;
  const docs = methods.filter((method) => method.scope.includes(runScope)).map(docOf);
  if (!docs.length) return result;
  /** @type {any[]} */
  let near;
  try { near = await scope.similarity.nearest(query, docs, { limit: Math.min(maxCount, OFFICIAL_METHOD_MOUNT.nearest) }); } catch { return result; }
  const hits = near.map((hit) => hit.method).filter(Boolean);
  if (!hits.length) return result;

  // The person's own methods that say the same thing win.
  const covered = await personalTwins(hits, scope, result);
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
  return finish();
}

/**
 * Which official hits say the same thing as one of the person's own methods (`OFFICIAL_PERSONAL_DELTA_COSINE`), each with the method it yields to
 * and how near: decided only by embedding, and `result.deltaMode` says how it was read. A nearness that cannot be read leaves every hit in.
 * @param {readonly any[]} hits official method documents (`{ id, payload, method }`) @param {{ personal?: readonly any[], similarity?: any }} scope
 * @param {any} result the selection, whose `deltaMode` is set
 * @returns {Promise<Map<string, { twin: { id: string, name: string }, score: number }>>}
 */
async function personalTwins(hits, scope, result) {
  /** @type {Map<string, { twin: { id: string, name: string }, score: number }>} */
  const covered = new Map();
  const personal = [...(scope.personal ?? [])];
  if (!personal.length || !hits.length || !scope.similarity) return covered;
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
  return covered;
}
