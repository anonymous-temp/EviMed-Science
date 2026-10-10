/**
 * What `geo_write` may put into a GEO project (build spec 2026-09-25 §4), item
 * by item.
 *
 * Hidden knowledge:
 *
 * - **Refused item by item, never the whole call** (principle 14). A claim
 *   without a quote, a question in a pool that does not exist, an article
 *   naming a claim the project does not hold — each is named in `issues` with
 *   its index and field and left out; everything valid is written. The answer
 *   is `{ ok, ids, issues }`: `ok` is false only when nothing was written.
 * - **Every word is checked against the domain's closed vocabularies**
 *   (`geoVocabulary.mjs`); free text is length-bounded and stripped of control
 *   characters. What the run cannot write is written by someone else: measured
 *   counts on sources (`cited`, mentions) belong to the measurement package,
 *   a source's market cell to the market, an article's `released` safety to a
 *   person pressing 「放行」, and a target's data type is never `measured`.
 * - **Locking a question set is the one write with rules about the whole set**
 *   (spec §4): all four pools among the measured questions, 40–120 measured
 *   (30–120 for a single step's minimal set), and — in the full program —
 *   three to five control groups making up about a fifth to a third of the
 *   groups. A set that misses one of these is not locked, and the issues say
 *   which; a minimal set without control groups is locked with a notice,
 *   because a single step does not compute a net effect. Whether a set is
 *   minimal is the program's to say (`geoProgramMinimal`: some step was asked
 *   for, and the questions step was not), never the run's.
 * - **What decides an article's placement is the platform's, not the run's.**
 *   Its gate is the run ledger's verdict on the deliverable it was written in
 *   (`articleGate`, handed in by the composition); a run's own `gate` field is
 *   ignored. Every article but a correction names its question group, because
 *   the control-group exclusion and the post-publication checks are keyed on
 *   it — an article without one could be placed into a control group unseen.
 * - **A link the brand published itself is registered, never placed**
 *   (`owned_links`, gap E6): a 百家号 post, a 公众号 article, a page on the
 *   brand's site. No order, no money and no gate stand behind it; it is
 *   written so that the post-publication rounds and the citation match cover
 *   it as they cover a placement. Its article and question group must be
 *   this project's; retiring names the link by id or address and stops its
 *   checks without deleting its history.
 *
 * @module geoWrites
 */

import {
  GEO_ARTICLE_GATES, GEO_ARTICLE_LAYERS, GEO_AUDIENCES, GEO_CLAIM_SOURCE_KINDS, GEO_CLAIM_STATUSES, GEO_COMPARISON_EVIDENCE_TYPES, GEO_ENGINE_LABELS_ZH, GEO_ENGINES,
  GEO_GAP_CLASSES, GEO_GAP_CLASS_LABELS_ZH,
  GEO_GROUP_SIGNALS, GEO_IDENTITY_STATUSES, GEO_OWNED_LINK_PLATFORMS, GEO_OWNED_LINK_STATUSES, GEO_POOLS, GEO_QUESTION_KINDS, GEO_QUESTION_PLATFORMS,
  GEO_RX_CLASSES, GEO_SOURCE_KINDS, GEO_SOURCE_KIND_LABELS_ZH, GEO_SOURCE_LAYERS, GEO_STEPS, GEO_STEP_STATUSES, GEO_TARGET_DATA_TYPES, GEO_TIERS,
  GEO_WRITE_WHATS, deliverableDir, deliverableIdOfPath, geoClaimJourneyStage, geoConstant } from "@evimed/domain";
import { GEO_OWNED_LINKS_MAX, geoOwnedLinkKey } from "./geoStore.mjs";
import { HttpError } from "./security.mjs";

/** @typedef {{ index?: number, group?: number, field?: string, code: string, message: string }} GeoIssue */

/** A deliverable id: one path segment. */
const DELIVERABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

export const GEO_WRITE_LIMITS = Object.freeze({
  claims: 200, sources: 200, articles: 50, targets: 60, groups: 80, questionsPerGroup: 60, questions: 400, competitors: 20,
  journeyEntries: 60, planEntries: 60, ownedLinks: 50, jsonBytes: 256 * 1024,
});
/** Measured questions a locked set holds: the full program, and a single step's minimal set. */
export const GEO_MEASURED_RANGE = Object.freeze({ full: Object.freeze([40, 120]), minimal: Object.freeze([30, 120]) });
/** Control groups in the full program, and the share of groups they make up (≈ 20–30 %, with a tolerance of five points). */
export const GEO_CONTROL_RANGE = Object.freeze({ groups: Object.freeze([3, 5]), share: Object.freeze([0.15, 0.35]) });

/**
 * Whether the program asked for this project's question map only as an
 * upstream of another step (a single step's minimal version, spec §2.2):
 * some step was requested, and the questions step itself was not. A project
 * nothing was requested for yet — a map written in plain conversation — is
 * held to the full program's rules.
 * @param {Record<string, { requested?: boolean }> | null | undefined} steps
 */
export function geoProgramMinimal(steps) {
  const requested = GEO_STEPS.filter((step) => steps?.[step]?.requested === true);
  return requested.length > 0 && !requested.includes("questions");
}

/**
 * An article's gate as the run ledger records it: the deliverable it was
 * written in, on the run that wrote it (`agentRuns.mjs` folds each
 * deliverable's `status` and `lastVerdict`). `passed` only for a deliverable
 * the gate accepted with a clean verdict; `failed` for one that failed or a
 * run that failed or was cancelled; `unverified` for everything else,
 * including a deliverable the ledger does not know.
 * @param {{ status?: string, deliverables?: Array<{ id: string, status?: string, lastVerdict?: string }> } | null | undefined} run
 * @param {string | null | undefined} deliverableId
 * @returns {"passed" | "unverified" | "failed"}
 */
export function geoArticleGateOf(run, deliverableId) {
  const deliverable = run && deliverableId ? (run.deliverables ?? []).find((item) => item?.id === deliverableId) : null;
  if (!run || !deliverable) return "unverified";
  if (deliverable.status === "failed" || run.status === "failed" || run.status === "canceled") return "failed";
  if (deliverable.lastVerdict === "pass" && (deliverable.status === "accepted" || deliverable.status === "delivered")) return "passed";
  return "unverified";
}

/** The steps a run reports on: the thinking steps. Diagnosis, distribution and
 *  monitoring are the platform's to mark, and `questions` is done by locking
 *  the set, never by saying so. */
export const GEO_RUN_STEPS = Object.freeze(["evidence", "journey", "questions", "sources", "content"]);
/** Runtime-safe safety values: `released` is a person's word, never a run's. */
const RUN_ARTICLE_SAFETY = Object.freeze(["clear", "open"]);
const SHA256 = /^[a-f0-9]{64}$/;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
const METRIC_ID = /^[A-Za-z0-9-]{1,24}$/;
const ROW_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** @param {unknown} value */
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
/** @param {string} value */
const stripControls = (value) => [...value].map((character) => {
  const code = character.charCodeAt(0);
  return code === 9 || code === 10 ? character : code < 32 || code === 127 ? " " : character;
}).join("");

/**
 * A field reader that records what it refuses, for one item.
 * @param {Record<string, any>} source @param {GeoIssue[]} issues @param {{ index?: number, group?: number }} where
 */
function fields(source, issues, where) {
  let refused = false;
  /** @param {string} field @param {string} code @param {string} message */
  const refuse = (field, code, message) => { refused = true; issues.push({ ...where, field, code, message }); return undefined; };
  return {
    get refused() { return refused; },
    refuse,
    /** @param {string} field @param {number} max @param {{ required?: boolean, multiline?: boolean }} [options] @returns {string | null | undefined} */
    text(field, max, { required = false, multiline = false } = {}) {
      const value = source[field];
      if (value == null || value === "") return required ? refuse(field, "missing", `${field} is required.`) : null;
      if (typeof value !== "string") return refuse(field, "invalid", `${field} must be text.`);
      const cleaned = multiline ? stripControls(value).trim() : stripControls(value).replace(/\s+/g, " ").trim();
      if (!cleaned) return required ? refuse(field, "missing", `${field} is required.`) : null;
      if ([...cleaned].length > max) return refuse(field, "too_long", `${field} is longer than ${max} characters.`);
      return cleaned;
    },
    /** @param {string} field @param {readonly string[]} allowed @param {{ required?: boolean, fallback?: string | null }} [options] @returns {string | null | undefined} */
    word(field, allowed, { required = false, fallback = null } = {}) {
      const value = source[field];
      if (value == null || value === "") return required ? refuse(field, "missing", `${field} is required.`) : fallback;
      if (typeof value !== "string" || !allowed.includes(value)) return refuse(field, "unknown_value", `${field} must be one of: ${allowed.join(", ")}.`);
      return value;
    },
    /** @param {string} field @returns {boolean | null | undefined} */
    flag(field) {
      const value = source[field];
      if (value == null) return null;
      if (typeof value !== "boolean") return refuse(field, "invalid", `${field} must be true or false.`);
      return value;
    },
    /** @param {string} field @param {number} min @param {number} max @param {{ integer?: boolean, required?: boolean }} [options] @returns {number | null | undefined} */
    number(field, min, max, { integer = false, required = false } = {}) {
      const value = source[field];
      if (value == null || value === "") return required ? refuse(field, "missing", `${field} is required.`) : null;
      if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isSafeInteger(value)) || value < min || value > max) {
        return refuse(field, "invalid", `${field} must be ${integer ? "a whole number" : "a number"} from ${min} to ${max}.`);
      }
      return value;
    },
    /** @param {string} field @returns {string | null | undefined} */
    instant(field) {
      const value = source[field];
      if (value == null || value === "") return null;
      if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return refuse(field, "invalid", `${field} must be an ISO date or instant.`);
      return new Date(value).toISOString();
    },
    /** @param {string} field @returns {string | null | undefined} */
    url(field) {
      const value = source[field];
      if (value == null || value === "") return null;
      if (typeof value !== "string" || value.length > 2048) return refuse(field, "invalid", `${field} must be an http(s) address.`);
      try {
        const parsed = new URL(value);
        if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("scheme");
        return parsed.href;
      } catch { return refuse(field, "invalid", `${field} must be an http(s) address.`); }
    },
    /** @param {string} field @param {number} maxItems @param {number} maxLength @returns {string[] | undefined} */
    texts(field, maxItems, maxLength) {
      const value = source[field];
      if (value == null) return [];
      if (!Array.isArray(value) || value.length > maxItems) return refuse(field, "invalid", `${field} must be a list of at most ${maxItems}.`);
      /** @type {string[]} */
      const out = [];
      for (const entry of value) {
        if (typeof entry !== "string" || !entry.trim() || [...entry].length > maxLength) {
          return refuse(field, "invalid", `${field} must hold texts of 1 to ${maxLength} characters.`);
        }
        out.push(stripControls(entry).replace(/\s+/g, " ").trim());
      }
      return out;
    },
    /**
     * Fields the platform does not store are dropped with one notice, and the
     * item is still written: the owner's method keeps richer records than the
     * project's tables (a claim carries its expiry triggers, reviewer, three
     * screens …), and refusing the whole item for them lost 77 of 80 claims
     * on the first production run (2026-09-25). The full record stays in the
     * deliverable's own files.
     * @param {readonly string[]} allowed
     */
    unknown(allowed) {
      const ignored = Object.keys(source).filter((key) => !allowed.includes(key));
      if (ignored.length) {
        issues.push({ ...where, field: ignored.slice(0, 20).join(","), code: "ignored_fields",
          message: `Not stored by the platform (kept only in the files): ${ignored.slice(0, 20).join(", ")}${ignored.length > 20 ? " …" : ""}.` });
      }
    },
  };
}

/** @param {unknown} value @param {number} max */
function withinSize(value, max) {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8") <= max;
}

/** @param {number} status @param {string} code @param {string} message */
const failure = (status, code, message) => new HttpError(status, code, message);

/**
 * The array a write's `items` must be.
 * @param {Record<string, any>} body @param {number} max
 */
function itemsOf(body, max) {
  if (!Array.isArray(body.items)) throw failure(400, "geo_write_payload_invalid", "This write takes an items array.");
  if (body.items.length === 0 || body.items.length > max) throw failure(400, "geo_write_payload_invalid", `items must hold 1 to ${max} entries.`);
  return /** @type {unknown[]} */ (body.items);
}

/** @param {Record<string, any>} body */
function dataOf(body) {
  if (!isObject(body.data)) throw failure(400, "geo_write_payload_invalid", "This write takes a data object.");
  return /** @type {Record<string, any>} */ (body.data);
}

/** @param {unknown} item @param {number} index @param {GeoIssue[]} issues */
function notAnObject(item, index, issues) {
  if (isObject(item)) return false;
  issues.push({ index, code: "invalid", message: "Each item must be an object." });
  return true;
}

// --- product ----------------------------------------------------------------------------

const PRODUCT_TEXT_FIELDS = Object.freeze({ brandName: 80, genericName: 120, approvalNo: 60, holder: 120, form: 60, strength: 120,
  indication: 4000, labelRef: 500 });
const PRODUCT_LIST_FIELDS = Object.freeze({ aliases: [30, 80], misspellings: [30, 80], genericAliases: [10, 80] });
const COMPETITOR_FIELDS = Object.freeze(["brandName", "genericName", "aliases", "genericAliases", "singleSource", "holder", "indication", "reason"]);
/**
 * The identity a measurement counts by (SPEC §2.1): what an answer may call
 * the product, how it is misspelled, the approval number that tells one
 * holder's product from another's, prescription or not, and whether the
 * identity is confirmed. Missing after a write is a notice, not a refusal —
 * the rest of the identity is still written.
 */
export const GEO_IDENTITY_FIELDS = Object.freeze(["aliases", "misspellings", "approvalNo", "rx", "identityStatus", "singleSource"]);

/** @param {Record<string, any>} data @param {GeoIssue[]} issues */
function validatedProduct(data, issues) {
  /** @type {Record<string, any>} */
  const product = {};
  const read = fields(data, issues, {});
  const allowed = [...Object.keys(PRODUCT_TEXT_FIELDS), ...Object.keys(PRODUCT_LIST_FIELDS), "rx", "tcm", "variants", "identityStatus", "singleSource",
    "competitors"];
  read.unknown(allowed);
  for (const [field, max] of Object.entries(PRODUCT_TEXT_FIELDS)) {
    if (!(field in data)) continue;
    const value = read.text(field, max, { multiline: field === "indication" });
    if (value !== undefined) product[field] = value;
  }
  for (const [field, [items, length]] of Object.entries(PRODUCT_LIST_FIELDS)) {
    if (!(field in data)) continue;
    const value = read.texts(field, items, length);
    if (value !== undefined) product[field] = value;
  }
  if ("rx" in data) {
    const rx = data.rx === null ? null : read.word("rx", GEO_RX_CLASSES);
    if (rx !== undefined) product.rx = rx;
  }
  if ("tcm" in data) {
    const tcm = read.flag("tcm");
    if (tcm !== undefined) product.tcm = tcm;
  }
  // Whether one approved holder markets the generic: then the generic name
  // counts as a mention of this product (`geoParse.countedNames`).
  if ("singleSource" in data) {
    const single = read.flag("singleSource");
    if (single !== undefined) product.singleSource = single;
  }
  if ("identityStatus" in data) {
    const status = read.word("identityStatus", GEO_IDENTITY_STATUSES);
    if (status !== undefined) product.identityStatus = status;
  }
  if ("variants" in data) {
    if (!Array.isArray(data.variants) || data.variants.length > 30 || !data.variants.every((variant) => isObject(variant) || typeof variant === "string")
      || !withinSize(data.variants, 16 * 1024)) {
      read.refuse("variants", "invalid", "variants must be a list of at most 30 objects or texts.");
    } else {
      product.variants = data.variants;
    }
  }
  /** @type {Array<Record<string, string | string[] | null>> | undefined} */
  let competitors;
  if ("competitors" in data) {
    if (!Array.isArray(data.competitors) || data.competitors.length > GEO_WRITE_LIMITS.competitors) {
      read.refuse("competitors", "invalid", `competitors must be a list of at most ${GEO_WRITE_LIMITS.competitors}.`);
    } else {
      competitors = [];
      data.competitors.forEach((/** @type {unknown} */ entry, /** @type {number} */ index) => {
        if (notAnObject(entry, index, issues)) return;
        const item = fields(/** @type {Record<string, any>} */ (entry), issues, { index });
        item.unknown(COMPETITOR_FIELDS);
        // `aliases`: the other names an answer uses for it (the generic
        // name's short form, the English brand) — the parser recognises a
        // rival only by a registered name.
        const competitor = {
          brandName: item.text("brandName", 80), genericName: item.text("genericName", 120), aliases: item.texts("aliases", 10, 80) ?? [],
          genericAliases: item.texts("genericAliases", 10, 80) ?? [], singleSource: item.flag("singleSource") ?? null,
          holder: item.text("holder", 120), indication: item.text("indication", 1000, { multiline: true }), reason: item.text("reason", 300),
        };
        if (!competitor.brandName && !competitor.genericName) item.refuse("brandName", "missing", "A competitor needs a brand or generic name.");
        if (!item.refused) competitors?.push(/** @type {any} */ (competitor));
      });
      // Only a list given empty clears the project's rivals; a list whose
      // every entry was refused leaves them as they were.
      if (!competitors?.length && data.competitors.length) competitors = undefined;
    }
  }
  return { product, competitors };
}

// --- claims -------------------------------------------------------------------------------

const CLAIM_FIELDS = Object.freeze(["claimKey", "statement", "quote", "sourceRef", "sourceLabel", "sourceRefLabel", "sourceKind", "evidenceLevel",
  "population", "inLabel", "elements", "verifiedAt", "validUntil", "status", "journeyStage", "clinicalQuestion", "comparisonType", "artifactPath"]);

/**
 * The preserved source file a claim's quotation is in: a path inside the workspace's `.evimed-sources/`, never absolute and never
 * climbing out. The card's own ruler reads it later; a path outside the preserving tools' folder is refused for this item.
 * @param {unknown} value @param {{ refuse: (field: string, code: string, message: string) => any }} read
 */
function claimArtifactPath(value, read) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > 500 || value.includes("\\") || value.includes("\0") || value.startsWith("/")
    || !value.startsWith(".evimed-sources/") || value.split("/").some((part) => part === ".." || part === ".")) {
    return read.refuse("artifactPath", "invalid", "artifactPath is a file under .evimed-sources/ that a preserving tool returned.");
  }
  return value;
}

/**
 * A claim's journey stage as the card says it: an object `{ key, label }` or the label alone, read by the domain. A value it
 * cannot read is refused for this item only.
 * @param {unknown} value @param {{ refuse: (field: string, code: string, message: string) => any }} read
 */
function claimJourneyStage(value, read) {
  if (value == null || value === "") return null;
  const stage = geoClaimJourneyStage(value);
  return stage ?? read.refuse("journeyStage", "invalid", "journeyStage is a stage label, or { key, label } with a key of letters, digits, . _ or -.");
}

/** @param {unknown[]} items @param {GeoIssue[]} issues */
function validatedClaims(items, issues) {
  const seen = new Set();
  /** @type {any[]} */
  const claims = [];
  items.forEach((entry, index) => {
    if (notAnObject(entry, index, issues)) return;
    const item = /** @type {Record<string, any>} */ (entry);
    const read = fields(item, issues, { index });
    read.unknown(CLAIM_FIELDS);
    const claimKey = read.text("claimKey", 80, { required: true });
    if (claimKey && !/^[A-Za-z0-9._:-]{1,80}$/.test(claimKey)) read.refuse("claimKey", "invalid", "claimKey must be letters, digits, . _ : or -.");
    if (claimKey && seen.has(claimKey)) read.refuse("claimKey", "duplicate", "The same claimKey appears twice in this write.");
    const claim = {
      claimKey,
      statement: read.text("statement", 1000, { required: true }),
      quote: read.text("quote", 4000, { required: true, multiline: true }),
      sourceRef: read.text("sourceRef", 500, { required: true }),
      // The reader's name for the source; the method's records call it sourceRefLabel.
      sourceLabel: read.text(item.sourceLabel != null ? "sourceLabel" : "sourceRefLabel", 300),
      sourceKind: read.word("sourceKind", GEO_CLAIM_SOURCE_KINDS),
      evidenceLevel: read.text("evidenceLevel", 60),
      population: read.text("population", 300),
      inLabel: read.flag("inLabel"),
      elements: item.elements == null ? {} : (isObject(item.elements) && withinSize(item.elements, 8 * 1024) ? item.elements
        : read.refuse("elements", "invalid", "elements must be an object of at most 8 KB.")),
      verifiedAt: read.instant("verifiedAt"),
      validUntil: read.instant("validUntil"),
      status: read.word("status", GEO_CLAIM_STATUSES, { fallback: "active" }),
      // Where the claim stands on the patient journey and the key clinical question it answers decide the product-zone card it
      // is written into; how a difference is known is a closed word (the unanchored comparison is only for reference).
      journeyStage: claimJourneyStage(item.journeyStage, read),
      clinicalQuestion: read.text("clinicalQuestion", 300),
      comparisonType: read.word("comparisonType", GEO_COMPARISON_EVIDENCE_TYPES),
      // The preserved source file (inside the workspace) the quotation is in, so the card's own ruler can read it.
      artifactPath: claimArtifactPath(item.artifactPath, read),
    };
    if (read.refused) return;
    for (const field of ["sourceKind", "evidenceLevel", "population", "inLabel", "elements", "verifiedAt", "validUntil", "status"]) {
      if (!Object.hasOwn(item, field)) delete claim[field];
    }
    if (!Object.hasOwn(item, "sourceLabel") && !Object.hasOwn(item, "sourceRefLabel")) delete claim.sourceLabel;
    seen.add(claimKey);
    claims.push(claim);
  });
  return claims;
}

// --- the question map -----------------------------------------------------------------------

const GROUP_FIELDS = Object.freeze(["valueContext", "pool", "name", "typicalQuestion", "journeyStage", "audience", "bridge", "weight", "isControl", "signal", "questions"]);
const QUESTION_FIELDS = Object.freeze(["text", "kind", "pool", "platform", "sourceUrl", "collectedAt", "isMeasured"]);

/**
 * A group name's leading internal number (「P1-01 品牌身份」): the method's
 * numbering of a group inside its pool — a closed format, the pool id and a
 * number — which means nothing to a reader (F-G10). The name keeps the rest.
 */
const GROUP_NUMBER = /^\s*P[1-4]\s*[-_.]\s*\d{1,3}\s*[·:：、.\-—]?\s*/u;

/** @param {string | null | undefined} name */
export function geoGroupName(name) {
  if (typeof name !== "string") return name;
  const stripped = name.replace(GROUP_NUMBER, "").trim();
  return stripped || name.trim();
}

/**
 * @param {Record<string, any>} data @param {GeoIssue[]} issues
 * @param {string} [writtenAt] when the write reached the platform: a real phrasing written without its `collectedAt` was collected by then
 */
function validatedGroups(data, issues, writtenAt = new Date().toISOString()) {
  const read = fields(data, issues, {});
  read.unknown(["groups", "note"]);
  const note = read.text("note", 500);
  if (!Array.isArray(data.groups) || data.groups.length === 0 || data.groups.length > GEO_WRITE_LIMITS.groups) {
    throw failure(400, "geo_write_payload_invalid", `data.groups must hold 1 to ${GEO_WRITE_LIMITS.groups} groups.`);
  }
  /** @type {any[]} */
  const groups = [];
  let total = 0;
  let stamped = 0;
  data.groups.forEach((/** @type {unknown} */ entry, /** @type {number} */ index) => {
    if (notAnObject(entry, index, issues)) return;
    const item = /** @type {Record<string, any>} */ (entry);
    const group = fields(item, issues, { index });
    group.unknown(GROUP_FIELDS);
    const name = group.text("name", 80, { required: true });
    const value = {
      pool: group.word("pool", GEO_POOLS, { required: true }),
      name: typeof name === "string" ? geoGroupName(name) : name,
      valueContext: isObject(item.valueContext) ? item.valueContext : {},
      typicalQuestion: group.text("typicalQuestion", 300),
      journeyStage: group.text("journeyStage", 60),
      audience: group.word("audience", GEO_AUDIENCES),
      bridge: group.text("bridge", 300),
      weight: group.number("weight", 0, 1_000_000),
      isControl: group.flag("isControl") ?? false,
      signal: group.word("signal", GEO_GROUP_SIGNALS),
      /** @type {any[]} */
      questions: [],
    };
    const questions = item.questions == null ? [] : item.questions;
    if (!Array.isArray(questions) || questions.length > GEO_WRITE_LIMITS.questionsPerGroup) {
      group.refuse("questions", "invalid", `questions must be a list of at most ${GEO_WRITE_LIMITS.questionsPerGroup}.`);
    }
    if (group.refused) return;
    questions.forEach((/** @type {unknown} */ questionEntry, /** @type {number} */ questionIndex) => {
      if (!isObject(questionEntry)) {
        issues.push({ group: index, index: questionIndex, code: "invalid", message: "Each question must be an object." });
        return;
      }
      const question = fields(/** @type {Record<string, any>} */ (questionEntry), issues, { group: index, index: questionIndex });
      question.unknown(QUESTION_FIELDS);
      const parsed = {
        text: question.text("text", 300, { required: true }),
        kind: question.word("kind", GEO_QUESTION_KINDS, { fallback: "real" }),
        pool: question.word("pool", GEO_POOLS, { fallback: value.pool }),
        platform: question.word("platform", GEO_QUESTION_PLATFORMS),
        sourceUrl: question.url("sourceUrl"),
        collectedAt: question.instant("collectedAt"),
        isMeasured: question.flag("isMeasured") ?? false,
      };
      if (question.refused) return;
      // A real phrasing has a day it was heard (G9: 56 of 56 written without
      // one). The run passes the post's own `collectedAt`; without it the
      // phrasing was collected no later than this write, and says so.
      if (parsed.kind === "real" && !parsed.collectedAt) {
        parsed.collectedAt = writtenAt;
        stamped += 1;
      }
      if (total >= GEO_WRITE_LIMITS.questions) {
        issues.push({ group: index, index: questionIndex, code: "too_many", message: `A set holds at most ${GEO_WRITE_LIMITS.questions} questions.` });
        return;
      }
      total += 1;
      value.questions.push(parsed);
    });
    groups.push(value);
  });
  if (stamped) {
    issues.push({ field: "collectedAt", code: "notice",
      message: `${stamped} real phrasing(s) came without collectedAt and are dated to this write; pass each post's collectedAt from social_posts_search.` });
  }
  return { groups, note };
}

/**
 * Whether a set may be locked (spec §4), as issues; empty when it may.
 * @param {Array<{ pool: string | null, isControl: boolean, questions: Array<{ isMeasured: boolean, pool: string | null }> }>} groups
 * @param {boolean} minimal
 * @returns {{ refusals: GeoIssue[], notices: GeoIssue[], measured: number }}
 */
export function geoLockCheck(groups, minimal) {
  /** @type {GeoIssue[]} */
  const refusals = [];
  /** @type {GeoIssue[]} */
  const notices = [];
  const measuredGroups = groups.filter((group) => group.questions.some((question) => question.isMeasured));
  const measuredQuestions = groups.flatMap((group) => group.questions.filter((question) => question.isMeasured)
    .map((question) => ({ ...question, pool: question.pool ?? group.pool })));
  const measured = measuredQuestions.length;
  const [low, high] = minimal ? GEO_MEASURED_RANGE.minimal : GEO_MEASURED_RANGE.full;
  if (measured === 0) {
    refusals.push({ field: "measured", code: "measured_count", message: "No question is selected for measurement. Write the questions with isMeasured: true, then lock this set; existing probe answers are not required." });
  }
  if (measured > 0 && (measured < low || measured > high)) notices.push({ field: "measured", code: "notice", message: `This set measures ${measured} questions, outside the suggested ${low}–${high}; interpret within its actual scope.` });
  const missing = GEO_POOLS.filter((pool) => !measuredQuestions.some((question) => question.pool === pool));
  if (missing.length) notices.push({ field: "pools", code: "notice", message: `Pools without measured questions remain unmeasured: ${missing.join(", ")}.` });
  const control = measuredGroups.filter((group) => group.isControl).length;
  const share = measuredGroups.length ? control / measuredGroups.length : 0;
  const [fewest, most] = GEO_CONTROL_RANGE.groups;
  const [lowShare, highShare] = GEO_CONTROL_RANGE.share;
  const controlIssue = control < fewest || control > most
    ? `${fewest} to ${most} control groups are needed; this set has ${control}.`
    : share < lowShare || share > highShare
      ? `Control groups should be about 20–30 % of the groups; here they are ${Math.round(share * 100)} %.`
      : null;
  if (controlIssue) notices.push({ field: "control", code: "notice", message: controlIssue });
  return { refusals, notices, measured };
}

// --- journey, strategy, placement plan ---------------------------------------------------------

/** What a full journey carries beside its stages and care nodes (plan §3.2). */
export const GEO_JOURNEY_EXPECTED = Object.freeze(["subtypes", "personas", "files"]);

/** @param {Record<string, any>} data @param {GeoIssue[]} issues */
function validatedJourney(data, issues) {
  const read = fields(data, issues, {});
  read.unknown(["subtypes", "personas", "stages", "careNodes", "files", "decisions", "valueContext"]);
  /** @type {Record<string, any[]>} */
  const journey = { subtypes: [], personas: [], stages: [], careNodes: [], files: [], decisions: [], valueContext: [] };
  /** @param {string} field @param {(entry: Record<string, any>, index: number) => Record<string, any> | null} parse */
  const list = (field, parse) => {
    const value = data[field];
    if (value == null) return;
    if (!Array.isArray(value) || value.length > GEO_WRITE_LIMITS.journeyEntries) {
      read.refuse(field, "invalid", `${field} must be a list of at most ${GEO_WRITE_LIMITS.journeyEntries}.`);
      return;
    }
    value.forEach((entry, index) => {
      if (!isObject(entry)) { issues.push({ field, index, code: "invalid", message: `${field} entries are objects.` }); return; }
      if (!withinSize(entry, 16 * 1024)) { issues.push({ field, index, code: "too_long", message: `A ${field} entry is at most 16 KB.` }); return; }
      const parsed = parse(entry, index);
      if (parsed) journey[field].push(parsed);
    });
  };
  /** @param {string} field @param {Record<string, any>} entry @param {number} index @param {string[]} allowed @param {string} required */
  const open = (field, entry, index, allowed, required) => {
    const item = fields(entry, issues, { index });
    item.unknown([...allowed, "valueContext"]);
    const out = Object.fromEntries(allowed.map((key) => [key, Array.isArray(entry[key]) ? item.texts(key, 30, 500)
      : typeof entry[key] === "number" && Number.isFinite(entry[key]) ? String(entry[key]) : item.text(key, 2000, { multiline: true })]));
    if (!out[required]) item.refuse(required, "missing", `A ${field} entry needs ${required}.`);
    return item.refused ? null : { ...out, ...(isObject(entry.valueContext) ? { valueContext: entry.valueContext } : {}) };
  };
  list("decisions", (entry) => entry);
  if (isObject(data.valueContext)) Object.assign(journey, { valueContext: data.valueContext });
  list("subtypes", (entry, index) => open("subtypes", entry, index, ["name", "definition", "size", "sizeQuality", "note"], "name"));
  list("personas", (entry, index) => open("personas", entry, index, ["name", "age", "situation", "voice", "note"], "name"));
  list("stages", (entry, index) => {
    const item = fields(entry, issues, { index });
    item.unknown(["stage", "emotion", "thinking", "questions", "infoSources", "valueContext"]);
    const stage = { valueContext: isObject(/** @type {any} */ (entry)?.valueContext) ? /** @type {any} */ (entry).valueContext : {}, stage: item.text("stage", 60, { required: true }), emotion: item.text("emotion", 300), thinking: item.text("thinking", 1000),
      questions: item.texts("questions", 30, 300), infoSources: item.texts("infoSources", 30, 200) };
    return item.refused ? null : stage;
  });
  list("careNodes", (entry, index) => {
    const item = fields(entry, issues, { index });
    item.unknown(["node", "redFlags"]);
    const node = { node: item.text("node", 200, { required: true }), redFlags: item.texts("redFlags", 30, 300) };
    return item.refused ? null : node;
  });
  list("files", (entry, index) => {
    const item = fields(entry, issues, { index });
    item.unknown(["path", "title"]);
    const file = { path: item.text("path", 512, { required: true }), title: item.text("title", 200) };
    if (file.path && (file.path.startsWith("/") || file.path.split("/").includes(".."))) item.refuse("path", "invalid", "path is relative to the workspace.");
    return item.refused ? null : file;
  });
  return journey;
}

/** An engine as a run may name it: the platform's id, or its reader's name (「豆包」). */
const ENGINE_BY_LABEL = Object.freeze(Object.fromEntries(Object.entries(GEO_ENGINE_LABELS_ZH).map(([engine, label]) => [label, engine])));
/** A gap class as the method writes it in Chinese (「缺证据」), or the platform's id. */
const GAP_CLASS_BY_LABEL = Object.freeze(Object.fromEntries(Object.entries(GEO_GAP_CLASS_LABELS_ZH).map(([id, label]) => [label, id])));
/** The method's promise ceiling (`expectations.json` `promise_ceiling.value`), in the reader's words. */
const PROMISE_WORDS = Object.freeze({
  mention_and_accuracy: "可以承诺被提及并讲对",
  accuracy_only: "只承诺讲对，不承诺被提及",
  undetermined: "样本不足，暂不承诺",
});
/** The method's layout (`source_table.json` `layout`): its parts, by their names on the wire. */
const LAYOUT_PARTS = Object.freeze({ layers: "layers", byEngine: "byEngine", by_engine: "byEngine", constraints: "constraints",
  excluded: "excluded", clientActions: "clientActions", client_actions: "clientActions" });
/** The measured parts of the method's per-engine record: the platform's own rows (M-10, the citations), never stored twice. */
const MEASURED_EXPECTATION_PARTS = Object.freeze(["retrieval", "citationMix", "citation_mix", "citationDisplay", "citation_display", "bodyUse",
  "body_use", "ownEcosystem", "own_ecosystem", "priors", "surface", "clusterLeverage", "cluster_leverage"]);

/** @param {unknown} value */
function engineId(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return GEO_ENGINES.includes(trimmed) ? trimmed : /** @type {Record<string, string>} */ (ENGINE_BY_LABEL)[trimmed] ?? trimmed;
}

/**
 * The promise as the page says it: text as written, or the method's ceiling
 * object `{ value, basis }` in words, its basis after it.
 * @param {unknown} value
 */
function promiseText(value) {
  if (typeof value === "string") return value;
  if (!isObject(value)) return value;
  const record = /** @type {Record<string, any>} */ (value);
  const word = /** @type {Record<string, string>} */ (PROMISE_WORDS)[String(record.value ?? "")] ?? (typeof record.value === "string" ? record.value : null);
  const basis = typeof record.basis === "string" && record.basis.trim() ? record.basis.trim() : null;
  return word && basis ? `${word}（${basis}）` : word ?? basis;
}

/**
 * What a `strategy` write says, field by field: only what it carries is
 * returned, so a write of one field leaves the rest of the strategy as it
 * was (`GeoStore.writeStrategy` merges forward). The method pack's names are
 * read too (G3/G4, 2026-09-26: the run wrote `provider`, `promiseCeiling`,
 * `layersNeeded` and the method's layout, all were dropped, and the page's
 * 「投哪一层」「这个周期能做到」 stayed empty).
 * @param {Record<string, any>} data @param {GeoIssue[]} issues
 */
function validatedStrategy(data, issues) {
  const read = fields(data, issues, {});
  read.unknown(["battlefield", "expectations", "gaps", "layout", "summary", "sources", "secondary"]);
  /** @type {Record<string, any>} */
  const strategy = {};
  const summary = read.text("summary", 4000, { multiline: true });
  if (summary) strategy.summary = summary;
  const battlefieldData = isObject(data.battlefield) ? { ...data.battlefield }
    : Array.isArray(data.battlefield) ? { groups: data.battlefield } : data.battlefield;
  if (isObject(battlefieldData) && data.secondary != null && battlefieldData.secondary == null) battlefieldData.secondary = data.secondary;
  if (battlefieldData != null) {
    const battlefield = isObject(battlefieldData) ? fields(battlefieldData, issues, { }) : null;
    if (!battlefield) read.refuse("battlefield", "invalid", "battlefield is an object { groups, reason }.");
    else {
      battlefield.unknown(["groups", "reason", "secondary"]);
      const value = { groups: battlefield.texts("groups", 30, 120), reason: battlefield.text("reason", 1000), secondary: battlefield.texts("secondary", 30, 120) };
      if (!battlefield.refused) strategy.battlefield = value;
    }
  }
  if (data.expectations != null) {
    if (!Array.isArray(data.expectations) || data.expectations.length > GEO_ENGINES.length) {
      read.refuse("expectations", "invalid", "expectations is a list with one entry per engine.");
    } else {
      strategy.expectations = [];
      data.expectations.forEach((/** @type {unknown} */ entry, /** @type {number} */ index) => {
        if (!isObject(entry)) { issues.push({ field: "expectations", index, code: "invalid", message: "An expectation is an object." }); return; }
        const raw = /** @type {Record<string, any>} */ (entry);
        /** @type {Record<string, any>} */
        const given = {
          ...raw,
          engine: engineId(raw.engine ?? raw.provider),
          promise: promiseText(raw.promise ?? raw.promiseCeiling ?? raw.promise_ceiling),
          layers: raw.layers ?? raw.layersNeeded ?? raw.layers_needed,
        };
        for (const alias of ["provider", "promiseCeiling", "promise_ceiling", "layersNeeded", "layers_needed", ...MEASURED_EXPECTATION_PARTS]) delete given[alias];
        const item = fields(given, issues, { index });
        item.unknown(["engine", "promise", "layers", "cites", "leverage"]);
        const listed = item.texts("layers", 10, 40);
        const layers = listed ? listed.filter((layer) => GEO_SOURCE_LAYERS.includes(layer)) : listed;
        if (listed && layers && layers.length < listed.length) {
          issues.push({ index, field: "layers", code: "notice", message: `Only ${GEO_SOURCE_LAYERS.join(", ")} are placement layers; the others were left out.` });
        }
        const value = { engine: item.word("engine", GEO_ENGINES, { required: true }), promise: item.text("promise", 500), layers,
          cites: item.texts("cites", 20, 200), leverage: item.text("leverage", 500) };
        if (!item.refused) strategy.expectations.push(value);
      });
    }
  }
  if (data.gaps != null) {
    if (!Array.isArray(data.gaps) || data.gaps.length > GEO_WRITE_LIMITS.planEntries) {
      read.refuse("gaps", "invalid", `gaps is a list of at most ${GEO_WRITE_LIMITS.planEntries}.`);
    } else {
      strategy.gaps = [];
      data.gaps.forEach((/** @type {unknown} */ entry, /** @type {number} */ index) => {
        if (!isObject(entry)) { issues.push({ field: "gaps", index, code: "invalid", message: "A gap is an object." }); return; }
        const raw = /** @type {Record<string, any>} */ (entry);
        const label = raw.class ?? raw.category;
        /** @type {Record<string, any>} */
        const given = { ...raw, class: typeof label === "string" ? /** @type {Record<string, string>} */ (GAP_CLASS_BY_LABEL)[label.trim()] ?? label.trim() : label };
        delete given.category;
        const item = fields(given, issues, { index });
        item.unknown(["class", "groupId", "group", "text", "priority"]);
        const value = { class: item.word("class", GEO_GAP_CLASSES, { required: true }), groupId: item.text("groupId", 80), group: item.text("group", 120),
          text: item.text("text", 1000, { required: true }), priority: item.number("priority", 0, 1000) };
        if (!item.refused) strategy.gaps.push(value);
      });
    }
  }
  if (data.layout != null) {
    if (!isObject(data.layout)) read.refuse("layout", "invalid", "layout is an object: by engine, or the method's { layers, byEngine, constraints }.");
    else if (Object.keys(data.layout).some((key) => key in LAYOUT_PARTS)) {
      // The method's layout, kept as written and bounded, for the runs that
      // read it back (content, proposal); the page reads each source's layer.
      /** @type {Record<string, any>} */
      const plan = {};
      for (const [key, value] of Object.entries(data.layout)) {
        const part = /** @type {Record<string, string>} */ (LAYOUT_PARTS)[key];
        if (!part) { issues.push({ field: `layout.${key}`, code: "ignored_fields", message: `Not stored by the platform (kept only in the files): ${key}.` }); continue; }
        plan[part] = value;
      }
      if (withinSize(plan, 32 * 1024)) strategy.layout = plan;
      else read.refuse("layout", "too_long", "layout is at most 32 KB.");
    } else {
      strategy.layout = {};
      for (const [key, entry] of Object.entries(data.layout)) {
        const engine = engineId(key);
        if (typeof engine !== "string" || !GEO_ENGINES.includes(engine) || !isObject(entry)) {
          issues.push({ field: `layout.${key}`, code: "unknown_value", message: `layout is keyed by engine (${GEO_ENGINES.join(", ")}) with layer lists.` });
          continue;
        }
        const item = fields(/** @type {Record<string, any>} */ (entry), issues, { });
        item.unknown([...GEO_SOURCE_LAYERS]);
        const value = Object.fromEntries(GEO_SOURCE_LAYERS.map((layer) => [layer, item.texts(layer, 50, 200)]));
        if (!item.refused) strategy.layout[engine] = value;
      }
    }
  }
  return strategy;
}

/**
 * A strategy write read without writing it: what would be stored and what
 * would be refused or noted — the backfill script's dry run.
 * @param {Record<string, any>} data
 */
export function geoStrategyDraft(data) {
  /** @type {GeoIssue[]} */
  const issues = [];
  const strategy = validatedStrategy(data, issues);
  /** @type {GeoIssue[]} */
  const sourceIssues = [];
  const sources = Array.isArray(data.sources) ? validatedSources(data.sources.slice(0, GEO_WRITE_LIMITS.sources), sourceIssues) : [];
  return { strategy, sources, issues: [...issues, ...sourceIssues.map((issue) => ({ ...issue, field: `sources.${issue.field ?? ""}`.replace(/\.$/, "") }))] };
}

// --- sources, targets, articles, placement plan, step ---------------------------------------------

const SOURCE_FIELDS = Object.freeze(["valueContext", "domain", "name", "kind", "layer", "icpOwner", "icpMatches", "newsIndexed", "medicalVertical", "impostor",
  "blacklistReason", "checkedAt"]);

/**
 * The method pack's words for a source (`source_table.json`, owner geo-skills
 * 3.0) and the platform's: a strategy run writes the method's record, so its
 * names are accepted and stored under the platform's (G3, 2026-09-26 — the
 * run wrote `threeConditions` and `sourceType`, both were dropped as unknown,
 * and 963 sources ended with no condition checked). Each key is the method's
 * field; the value is the platform's.
 */
const SOURCE_ALIASES = Object.freeze({
  displayName: "name", display_name: "name", sourceType: "kind", source_type: "kind",
  icpOwnerMatch: "icpMatches", icp_owner_match: "icpMatches", icp_matches: "icpMatches",
  news_indexed: "newsIndexed", medical_vertical: "medicalVertical", checkedOn: "checkedAt", checked_on: "checkedAt", checked_at: "checkedAt",
  blacklist_reason: "blacklistReason", icp_owner: "icpOwner",
});
/** The condition object the method nests the three checks in, and its key for each. */
const CONDITION_ALIASES = Object.freeze({
  icpMatches: ["icpMatches", "icpOwnerMatch", "icp_owner_match", "icp_matches", "icp"],
  newsIndexed: ["newsIndexed", "news_indexed", "news"],
  medicalVertical: ["medicalVertical", "medical_vertical", "medical"],
  checkedAt: ["checkedAt", "checkedOn", "checked_on", "checked_at"],
});
/**
 * The method's fine-grained source types, and the one of the platform's seven
 * public-study kinds each is counted under — a closed table, the method's own
 * list (`source_table.schema.json` `source_type`). The platform's own Chinese
 * labels are accepted too.
 */
const SOURCE_TYPE_KINDS = Object.freeze({
  指南与共识: "academic", 说明书与监管机构: "government", 期刊与文献库: "academic", 学会与医院: "academic", 医学科普平台: "vertical",
  百科: "encyclopedia", 问答与社区: "qa", 自媒体号: "wemedia", 电商与药房: "ecommerce", 新闻媒体: "news", 企业自有: "brand", 竞品自有: "brand",
  内容农场: "other", 冒名站: "other", 未分类: "other",
  ...Object.fromEntries(Object.entries(GEO_SOURCE_KIND_LABELS_ZH).map(([kind, label]) => [label, kind])),
  新闻: "news", 垂直门户: "vertical", 品牌官网: "brand", 政府: "government", 其他: "other",
});
/** The method's layers the platform does not place into: stored as no layer (the site is still recorded). */
const UNPLACED_LAYERS = Object.freeze(["correction_only", "excluded", "unassigned", "blacklist"]);

/**
 * One source entry in the platform's own words: the method's names renamed,
 * its nested three conditions lifted, its source type mapped to a kind, and
 * its impostor record (`{ flag: true }`) read as the flag.
 * @param {Record<string, any>} entry @param {GeoIssue[]} issues @param {number} index
 */
function sourceInPlatformWords(entry, issues, index) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === "threeConditions" || key === "three_conditions") continue;
    const platform = /** @type {Record<string, string>} */ (SOURCE_ALIASES)[key] ?? key;
    if (!(platform in out) || key === platform) out[platform] = value;
  }
  const conditions = entry.threeConditions ?? entry.three_conditions;
  if (isObject(conditions)) {
    for (const [field, names] of Object.entries(CONDITION_ALIASES)) {
      const name = names.find((candidate) => conditions[candidate] !== undefined);
      if (name !== undefined && out[field] == null) out[field] = conditions[name];
    }
  } else if (conditions != null) {
    issues.push({ index, field: "threeConditions", code: "invalid", message: "threeConditions is an object { icpMatches, newsIndexed, medicalVertical, checkedAt }." });
  }
  if (typeof out.kind === "string" && !GEO_SOURCE_KINDS.includes(out.kind)) {
    const mapped = /** @type {Record<string, string>} */ (SOURCE_TYPE_KINDS)[out.kind.trim()];
    if (mapped) {
      if (out.kind.trim() === "冒名站" && out.impostor == null) out.impostor = true;
      out.kind = mapped;
    }
  }
  if (isObject(out.impostor)) out.impostor = typeof out.impostor.flag === "boolean" ? out.impostor.flag : null;
  if (typeof out.layer === "string" && UNPLACED_LAYERS.includes(out.layer)) {
    if (out.layer === "blacklist" && !out.blacklistReason) out.blacklistReason = "blacklist";
    issues.push({ index, field: "layer", code: "notice", message: `layer ${out.layer} is recorded as no placement layer (anchor, coverage and owned are placed into).` });
    out.layer = null;
  }
  return out;
}

/** @param {unknown[]} items @param {GeoIssue[]} issues */
function validatedSources(items, issues) {
  const seen = new Set();
  /** @type {any[]} */
  const sources = [];
  items.forEach((entry, index) => {
    if (notAnObject(entry, index, issues)) return;
    const read = fields(sourceInPlatformWords(/** @type {Record<string, any>} */ (entry), issues, index), issues, { index });
    read.unknown(SOURCE_FIELDS);
    const rawDomain = read.text("domain", 253, { required: true });
    const domain = rawDomain ? rawDomain.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "") : rawDomain;
    if (domain && !HOSTNAME.test(domain)) read.refuse("domain", "invalid", "domain must be a host name, e.g. example.com.");
    if (domain && seen.has(domain)) read.refuse("domain", "duplicate", "The same domain appears twice in this write.");
    const source = {
      valueContext: isObject(/** @type {any} */ (entry)?.valueContext) ? /** @type {any} */ (entry).valueContext : {},
      domain, name: read.text("name", 120), kind: read.word("kind", GEO_SOURCE_KINDS), layer: read.word("layer", GEO_SOURCE_LAYERS),
      icpOwner: read.text("icpOwner", 120), icpMatches: read.flag("icpMatches"), newsIndexed: read.flag("newsIndexed"),
      medicalVertical: read.flag("medicalVertical"), impostor: read.flag("impostor") ?? false, blacklistReason: read.text("blacklistReason", 300),
      checkedAt: read.instant("checkedAt"),
    };
    if (read.refused) return;
    // A verdict on the three conditions is dated: a condition written true or
    // false without the day it was checked is a notice (the market admits
    // only sites whose three conditions were checked and hold).
    const judged = [source.icpMatches, source.newsIndexed, source.medicalVertical].some((value) => typeof value === "boolean");
    if (judged && !source.checkedAt) issues.push({ index, field: "checkedAt", code: "notice", message: "A checked condition carries the day it was checked (checkedAt)." });
    seen.add(domain);
    sources.push(source);
  });
  return sources;
}

/** The metrics the page states a target beside: the index and mention over P2 and P3. */
export const GEO_HEADLINE_TARGETS = Object.freeze(["M-19", "M-01S"]);

const TARGET_FIELDS = Object.freeze(["tier", "metricId", "pool", "baseline", "target", "horizonWeeks", "placements", "budgetCny", "dataType"]);

/** @param {unknown[]} items @param {GeoIssue[]} issues */
function validatedTargets(items, issues) {
  const seen = new Set();
  /** @type {any[]} */
  const targets = [];
  items.forEach((entry, index) => {
    if (notAnObject(entry, index, issues)) return;
    const item = /** @type {Record<string, any>} */ (entry);
    const read = fields(item, issues, { index });
    read.unknown(TARGET_FIELDS);
    const metricId = read.text("metricId", 24, { required: true });
    if (metricId && !METRIC_ID.test(metricId)) read.refuse("metricId", "invalid", "metricId is a metric id such as M-01 or GVI.");
    const pool = item.pool == null || item.pool === "all" ? "all" : read.word("pool", GEO_POOLS);
    const dataType = read.word("dataType", GEO_TARGET_DATA_TYPES, { required: true });
    const target = {
      tier: read.word("tier", GEO_TIERS, { required: true }), metricId, pool,
      baseline: read.number("baseline", -1e9, 1e9), target: read.number("target", -1e9, 1e9),
      horizonWeeks: read.number("horizonWeeks", 1, 104, { integer: true }), placements: read.number("placements", 0, 10_000, { integer: true }),
      budgetCny: read.number("budgetCny", 0, 10_000_000), dataType,
    };
    // Factual accuracy is a hard line in every tier, not a number that climbs
    // with the budget (the owner's ACCURACY_HARD_LINE; production 2026-09-25:
    // a strategy wrote 76 / 84 / 90 %).
    const hardLine = Number(geoConstant("ACCURACY_HARD_LINE")) * 100;
    if (!read.refused && metricId === "M-06" && typeof target.target === "number" && target.target < hardLine) {
      read.refuse("target", "below_hard_line", `事实准确率在每一档都是硬线：目标不低于 ${hardLine}%。`);
    }
    const key = `${target.tier}\u0000${metricId}\u0000${pool}`;
    if (!read.refused && seen.has(key)) read.refuse("metricId", "duplicate", "This tier, metric and pool appear twice in this write.");
    if (read.refused) return;
    seen.add(key);
    targets.push(target);
  });
  return targets;
}

const ARTICLE_FIELDS = Object.freeze(["valueContext", "path", "layer", "title", "groupId", "claimIds", "gate", "safety", "contentSha256", "protectedSha256",
  "deliverableId", "runId", "errorIds"]);

/**
 * @param {unknown[]} items @param {GeoIssue[]} issues
 * @param {{ claimIds: Set<string>, groupIds: Set<string>, errorIds: Set<string> }} known
 */
function validatedArticles(items, issues, known) {
  const seen = new Set();
  /** @type {any[]} */
  const articles = [];
  items.forEach((entry, index) => {
    if (notAnObject(entry, index, issues)) return;
    const item = /** @type {Record<string, any>} */ (entry);
    const read = fields(item, issues, { index });
    read.unknown(ARTICLE_FIELDS);
    const given = read.text("path", 512, { required: true });
    if (given && (given.startsWith("/") || given.includes("\\") || given.split("/").some((part) => part === ".." || part === "."))) {
      read.refuse("path", "invalid", "path is the article's path relative to the workspace, or to its deliverable folder.");
    }
    const namedDeliverable = read.text("deliverableId", 120);
    if (namedDeliverable && !DELIVERABLE_ID.test(namedDeliverable)) read.refuse("deliverableId", "invalid", "deliverableId is this deliverable's id.");
    // The run writes inside its deliverable folder and may name the file
    // relative to it (`articles/<id>.md`); the platform keeps the workspace
    // path — the unique key, and what the page and the market open. Two
    // batches' `articles/card.md` were one row before (production, 2026-09-25).
    const pathValue = given && namedDeliverable && !given.startsWith("deliverables/") ? `${deliverableDir(namedDeliverable)}/${given}` : given;
    const deliverableId = namedDeliverable ?? (pathValue ? deliverableIdOfPath(pathValue) : null);
    if (pathValue && seen.has(pathValue)) read.refuse("path", "duplicate", "The same path appears twice in this write.");
    const claimIds = read.texts("claimIds", 200, 80) ?? [];
    const unknownClaims = claimIds.filter((id) => !known.claimIds.has(id));
    if (unknownClaims.length) read.refuse("claimIds", "not_found", `Claims not in this project: ${unknownClaims.slice(0, 5).join(", ")}.`);
    const layer = read.word("layer", GEO_ARTICLE_LAYERS, { required: true });
    const groupId = read.text("groupId", 80);
    if (groupId && !known.groupIds.has(groupId)) read.refuse("groupId", "not_found", "groupId is not a question group of this project.");
    if (!groupId && layer && layer !== "correction") {
      read.refuse("groupId", "missing", "Every article but a correction names the question group it answers.");
    }
    // The platform reads the gate from its own record; the run's word is not asked for.
    if (item.gate != null && (typeof item.gate !== "string" || !GEO_ARTICLE_GATES.includes(item.gate))) {
      read.refuse("gate", "unknown_value", `gate must be one of: ${GEO_ARTICLE_GATES.join(", ")}.`);
    }
    const contentSha256 = read.text("contentSha256", 64, { required: true });
    if (contentSha256 && !SHA256.test(contentSha256)) read.refuse("contentSha256", "invalid", "contentSha256 is a lowercase sha256.");
    const protectedSha256 = read.text("protectedSha256", 64);
    if (protectedSha256 && !SHA256.test(protectedSha256)) read.refuse("protectedSha256", "invalid", "protectedSha256 is a lowercase sha256.");
    // The 讲错我方 a correction answers (G7): each is an error of this project.
    const errorIds = read.texts("errorIds", 20, 80) ?? [];
    const unknownErrors = errorIds.filter((id) => !known.errorIds.has(id));
    if (unknownErrors.length) read.refuse("errorIds", "not_found", `Errors not in this project: ${unknownErrors.slice(0, 5).join(", ")}.`);
    if (layer === "correction" && !errorIds.length && !read.refused) {
      issues.push({ index, field: "errorIds", code: "notice", message: "A correction names the errors it corrects (errorIds, from geo_read errors); without them the error does not move to 处置中." });
    }
    const article = {
      valueContext: isObject(item.valueContext) ? item.valueContext : {},
      path: pathValue, layer, title: read.text("title", 200), groupId, claimIds,
      safety: read.word("safety", RUN_ARTICLE_SAFETY, { required: true }),
      contentSha256, protectedSha256, deliverableId, runId: read.text("runId", 120), errorIds,
    };
    if (read.refused) return;
    seen.add(pathValue);
    articles.push(article);
  });
  return articles;
}

// --- owned links ------------------------------------------------------------------------

const OWNED_LINK_FIELDS = Object.freeze(["url", "platform", "title", "publishedAt", "articleId", "groupId", "id", "status", "runId"]);
/** A publication date may be the brand's local day, which is up to a day ahead of UTC midnight. */
const OWNED_LINK_FUTURE_MS = 24 * 3_600_000;

/**
 * Links the brand published itself: each item registers one (`url`,
 * `platform`, `title`, `publishedAt`; `articleId` when it carries one of the
 * project's articles, `groupId` for the questions its checks ask) or, with
 * `status: "retired"`, retires one named by `id` or `url`.
 * @param {unknown[]} items @param {GeoIssue[]} issues
 * @param {{ articles: Map<string, string | null>, groupIds: Set<string> }} known @param {Date} now
 */
function validatedOwnedLinks(items, issues, known, now) {
  const seen = new Set();
  /** @type {Array<{ index: number, url: string, urlKey: string, platform: string, title: string, publishedAt: string, articleId: string | null,
   *   groupId: string | null, runId: string | null }>} */
  const register = [];
  /** @type {Array<{ index: number, id: string | null, urlKey: string | null }>} */
  const retire = [];
  items.forEach((entry, index) => {
    if (notAnObject(entry, index, issues)) return;
    const read = fields(/** @type {Record<string, any>} */ (entry), issues, { index });
    read.unknown(OWNED_LINK_FIELDS);
    const status = read.word("status", GEO_OWNED_LINK_STATUSES, { fallback: "active" });
    const url = read.url("url");
    const keyed = url ? geoOwnedLinkKey(url) : null;
    const urlKey = keyed?.key || null;
    if (url && !urlKey) read.refuse("url", "invalid", "url must be the address of a page.");
    if (keyed?.generic) read.refuse("url", "invalid", "This address names no single page (a 百家号 post is …/s?id=…, a 公众号 article …/s/… or …/s?__biz=…).");
    if (urlKey && seen.has(urlKey)) read.refuse("url", "duplicate", "The same address appears twice in this write.");
    if (status === "retired") {
      const id = read.text("id", 80);
      if (id && !ROW_ID.test(id)) read.refuse("id", "invalid", "id is an owned link's id (geo_read owned_links).");
      if (!id && !url && !read.refused) read.refuse("id", "missing", "A retirement names the link by its id or its url.");
      if (read.refused) return;
      if (urlKey) seen.add(urlKey);
      retire.push({ index, id: id ?? null, urlKey: urlKey ?? null });
      return;
    }
    if (url === null) read.refuse("url", "missing", "url is required.");
    const platform = read.word("platform", GEO_OWNED_LINK_PLATFORMS, { required: true });
    const title = read.text("title", 200, { required: true });
    const publishedAt = read.instant("publishedAt");
    if (publishedAt === null) read.refuse("publishedAt", "missing", "publishedAt is required: the day the page went live.");
    if (publishedAt && Date.parse(publishedAt) > now.getTime() + OWNED_LINK_FUTURE_MS) read.refuse("publishedAt", "invalid", "publishedAt is in the future.");
    const articleId = read.text("articleId", 80);
    if (articleId && !known.articles.has(articleId)) read.refuse("articleId", "not_found", "articleId is not an article of this project.");
    const named = read.text("groupId", 80);
    if (named && !known.groupIds.has(named)) read.refuse("groupId", "not_found", "groupId is not a question group of this project.");
    const runId = read.text("runId", 120);
    if (read.refused || !url || !urlKey || !platform || !title || !publishedAt) return;
    const groupId = named ?? (articleId ? known.articles.get(articleId) ?? null : null);
    if (!groupId) {
      issues.push({ index, field: "groupId", code: "notice",
        message: "Registered. Without a question group (groupId, or an articleId whose article names one) its citations are matched, but no post-publication round asks about it." });
    }
    seen.add(urlKey);
    register.push({ index, url, urlKey, platform, title, publishedAt, articleId: articleId ?? null, groupId, runId: runId ?? null });
  });
  return { register, retire };
}

/** @param {Record<string, any>} data @param {GeoIssue[]} issues */
function validatedPlacementPlan(data, issues) {
  const read = fields(data, issues, {});
  read.unknown(["preferred", "avoid", "note"]);
  /** @type {Record<string, any>} */
  const plan = { note: read.text("note", 1000, { multiline: true }), preferred: [], avoid: read.texts("avoid", 50, 253) ?? [] };
  if (data.preferred != null) {
    if (!Array.isArray(data.preferred) || data.preferred.length > GEO_WRITE_LIMITS.planEntries) {
      read.refuse("preferred", "invalid", `preferred is a list of at most ${GEO_WRITE_LIMITS.planEntries}.`);
    } else {
      data.preferred.forEach((/** @type {unknown} */ entry, /** @type {number} */ index) => {
        if (!isObject(entry)) { issues.push({ field: "preferred", index, code: "invalid", message: "A preference is an object." }); return; }
        const item = fields(/** @type {Record<string, any>} */ (entry), issues, { index });
        item.unknown(["layer", "engines", "outlets", "groupIds", "articleIds", "reason"]);
        const engines = item.texts("engines", GEO_ENGINES.length, 20);
        if (engines && engines.some((engine) => !GEO_ENGINES.includes(engine))) item.refuse("engines", "unknown_value", `engines are ${GEO_ENGINES.join(", ")}.`);
        const value = { layer: item.word("layer", GEO_SOURCE_LAYERS), engines, outlets: item.texts("outlets", 50, 253),
          groupIds: item.texts("groupIds", 50, 80), articleIds: item.texts("articleIds", 50, 80), reason: item.text("reason", 500) };
        if (!item.refused) plan.preferred.push(value);
      });
    }
  }
  return plan;
}

/**
 * Whether the project has a finished measurement the strategy can be read
 * from: a baseline, or a single step's own round. The strategy, the three
 * tiers and the 信源 step are calibrated against it by definition; written
 * before it, they are numbers with nothing under them, and the program would
 * take the step as done and never write it from the measurement (production,
 * 2026-09-25: a conversation delegated the strategy an hour before the
 * baseline was due and wrote 24 targets).
 * @param {{ query: (sql: string, values: unknown[]) => Promise<{ rows: any[] }> }} store @param {string} geoProjectId
 */
async function baselineMeasured(store, geoProjectId) {
  const result = await store.query(`SELECT 1 FROM evimed_geo.rounds WHERE geo_project_id = $1 AND kind IN ('baseline', 'single_step')
    AND status IN ('done', 'partial') LIMIT 1`, [geoProjectId]);
  return result.rows.length > 0;
}

const BASELINE_MISSING = Object.freeze({ code: "baseline_missing",
  message: "This project has no finished baseline yet. The platform measures the locked questions first and then schedules the strategy on its own; nothing to do in this run." });

/**
 * One `geo_write` call against a resolved GEO project.
 * @param {{ store: import("./geoStore.mjs").GeoStore, project: any, what: string, body: Record<string, any>,
 *   renameProject?: ((userId: string, projectId: string, name: string) => Promise<unknown>) | null,
 *   articleGate?: ((project: any, ref: { runId: string | null, deliverableId: string | null, path: string }) => Promise<string>) | null }} input
 *   `articleGate` reads an article's gate from the run ledger; without it every article is `unverified`
 * @returns {Promise<{ ok: boolean, ids: string[], issues: GeoIssue[], [key: string]: any }>}
 */
export async function geoRuntimeWrite({ store, project, what, body, renameProject = null, articleGate = null }) {
  if (!GEO_WRITE_WHATS.includes(what)) throw failure(400, "geo_write_what_invalid", `what must be one of: ${GEO_WRITE_WHATS.join(", ")}.`);
  if (!withinSize(body, GEO_WRITE_LIMITS.jsonBytes)) throw failure(413, "geo_request_too_large", "The write is larger than 256 KB.");
  /** @type {GeoIssue[]} */
  const issues = [];
  const userId = project.userId;
  const done = (/** @type {string[]} */ ids, extra = {}) => ({ ok: ids.length > 0, ids, issues, ...extra });
  switch (what) {
    case "value": {
      const written = await store.writeValue(userId, project.id, dataOf(body));
      return done([String(written.version)], { value: written });
    }
    case "research": {
      const result = await store.requestResearch(userId, project.id, dataOf(body));
      if (result.notice) issues.push({ code: "notice", message: result.notice });
      return done(result.request ? [result.request.id] : [], { research: result.request });
    }
    case "product": {
      const { product, competitors } = validatedProduct(dataOf(body), issues);
      if (!Object.keys(product).length && competitors === undefined) return done([]);
      const merged = { ...project.product, ...product };
      await store.updateProject(userId, project.id, { product: merged, ...(competitors !== undefined ? { competitors } : {}) });
      const missing = GEO_IDENTITY_FIELDS.filter((field) => merged[field] == null || (Array.isArray(merged[field]) && field !== "misspellings" && !merged[field].length));
      if (merged.brandName && missing.length) {
        issues.push({ field: missing.join(","), code: "notice",
          message: `The product identity still lacks: ${missing.join(", ")}. The measurement counts mentions by these names and by singleSource (whether the generic name is this product's alone).` });
      }
      // The sidebar names the project by its control-plane name; a project
      // created before its brand was known takes the brand once it is.
      if (product.brandName && renameProject) await renameProject(userId, project.projectId, product.brandName).catch(() => null);
      return done([project.id], { product: merged });
    }
    case "claims": {
      const claims = validatedClaims(itemsOf(body, GEO_WRITE_LIMITS.claims), issues);
      const written = claims.length ? await store.upsertClaims(userId, project.id, claims) : [];
      return done(written.map((entry) => entry.id), { claims: written });
    }
    case "questions": {
      const { groups, note } = validatedGroups(dataOf(body), issues);
      if (!groups.length) return done([]);
      const written = await store.writeQuestionSet(userId, project.id, { groups, note: note ?? null });
      return done(written.groupIds, { version: written.version, questionIds: written.questionIds });
    }
    case "lock_questions": {
      const data = body.data == null ? {} : dataOf(body);
      const read = fields(data, issues, {});
      read.unknown(["version", "minimal"]);
      const requested = read.number("version", 1, 1_000_000, { integer: true });
      const declared = read.flag("minimal");
      if (read.refused) return done([]);
      const minimal = geoProgramMinimal(project.steps);
      if (declared != null && declared !== minimal) {
        issues.push({ field: "minimal", code: "notice", message: `The program decides this; the set is locked as a ${minimal ? "minimal" : "full"} set.` });
      }
      const sets = await store.questionSets(project.id);
      const version = requested ?? sets[0]?.version ?? null;
      const set = sets.find((entry) => entry.version === version);
      if (!set || version == null) {
        issues.push({ field: "version", code: "not_found", message: "There is no question set to lock; write the questions first." });
        return done([]);
      }
      if (set.lockedAt) return done([String(version)], { version, lockedAt: set.lockedAt, measuredCount: set.measuredCount, alreadyLocked: true });
      const check = geoLockCheck(await store.questionMap(project.id, version), minimal);
      if (check.refusals.length) {
        issues.push(...check.refusals);
        return done([], { version });
      }
      issues.push(...check.notices);
      const locked = await store.lockQuestionSet(project.id, version, check.measured);
      await store.setStep(project.id, "questions", { status: minimal ? "minimal" : "done" });
      return done([String(version)], { version, lockedAt: locked?.lockedAt ?? null, measuredCount: check.measured });
    }
    case "journey": {
      const journey = validatedJourney(dataOf(body), issues);
      const written = await store.writeJourney(userId, project.id, journey);
      // What a full journey carries beside its stages (plan §3.2): the
      // subtype tree, the personas and the full matrix as a file. Missing is a
      // notice — the stages are written either way (G10: all three were
      // empty on the first production project).
      const missing = GEO_JOURNEY_EXPECTED.filter((part) => !journey[part]?.length);
      if (missing.length) {
        issues.push({ field: missing.join(","), code: "notice",
          message: `A full journey also carries ${missing.join(", ")}: the patient subtypes with their size, 3–5 personas, and the full stage × column matrix saved as a file and listed in files.` });
      }
      return done([String(written.version)], { version: written.version });
    }
    case "strategy": {
      const data = dataOf(body);
      if (!(await baselineMeasured(store, project.id))) { issues.push({ ...BASELINE_MISSING }); return done([]); }
      const strategy = validatedStrategy(data, issues);
      /** @type {string[]} */
      let sourceIds = [];
      if (data.sources != null) {
        if (!Array.isArray(data.sources) || data.sources.length > GEO_WRITE_LIMITS.sources) {
          issues.push({ field: "sources", code: "invalid", message: `sources is a list of at most ${GEO_WRITE_LIMITS.sources}.` });
        } else {
          /** @type {GeoIssue[]} */
          const sourceIssues = [];
          const sources = validatedSources(data.sources, sourceIssues);
          issues.push(...sourceIssues.map((issue) => ({ ...issue, field: `sources.${issue.field ?? ""}`.replace(/\.$/, "") })));
          if (sources.length) sourceIds = await store.upsertSources(userId, project.id, sources);
        }
      }
      // A write that carries only sources is a sources write: it makes no
      // strategy version (G4 — sixteen versions, the last one empty, and the
      // page and the program read only the last).
      if (!Object.keys(strategy).length) {
        const latest = await store.latestStrategy(project.id);
        return done(sourceIds, { version: latest?.version ?? null, sourceIds });
      }
      const written = await store.writeStrategy(userId, project.id, strategy);
      return done([String(written.version)], { version: written.version, sourceIds });
    }
    case "sources": {
      const sources = validatedSources(itemsOf(body, GEO_WRITE_LIMITS.sources), issues);
      return done(sources.length ? await store.upsertSources(userId, project.id, sources) : []);
    }
    case "targets": {
      if (!(await baselineMeasured(store, project.id))) { itemsOf(body, GEO_WRITE_LIMITS.targets); issues.push({ ...BASELINE_MISSING }); return done([]); }
      const targets = validatedTargets(itemsOf(body, GEO_WRITE_LIMITS.targets), issues);
      if (!targets.length) return done([]);
      const tiers = new Set(targets.map((target) => target.tier));
      const missing = GEO_TIERS.filter((tier) => !tiers.has(tier));
      if (missing.length) issues.push({ field: "tier", code: "notice", message: `Targets are written in three tiers; missing: ${missing.join(", ")}.` });
      // The page's two headline numbers are the index (M-19) and mention over
      // P2 and P3 (M-01S): without a project-wide target for each, neither
      // shows one (G16).
      for (const tier of tiers) {
        const absent = GEO_HEADLINE_TARGETS.filter((metricId) => !targets.some((target) => target.tier === tier && target.metricId === metricId && target.pool === "all"));
        if (absent.length) issues.push({ field: "metricId", code: "notice", message: `Tier ${tier} has no project-wide (pool all) target for ${absent.join(", ")}.` });
      }
      const written = await store.writeTargets(userId, project.id, targets);
      return done([String(written.version)], { version: written.version });
    }
    case "articles": {
      const items = itemsOf(body, GEO_WRITE_LIMITS.articles);
      const [claimIds, groups, errors] = await Promise.all([
        store.claimIds(project.id),
        store.query(`SELECT id FROM evimed_geo.question_groups WHERE geo_project_id = $1`, [project.id]),
        store.query(`SELECT id FROM evimed_geo.errors WHERE geo_project_id = $1`, [project.id]),
      ]);
      const articles = validatedArticles(items, issues, { claimIds, groupIds: new Set(groups.rows.map((/** @type {any} */ row) => String(row.id))),
        errorIds: new Set(errors.rows.map((/** @type {any} */ row) => String(row.id))) });
      for (const article of articles) {
        const gate = articleGate ? await articleGate(project, { runId: article.runId ?? null, deliverableId: article.deliverableId ?? null, path: article.path }) : null;
        article.gate = GEO_ARTICLE_GATES.includes(String(gate)) ? gate : "unverified";
      }
      const ids = articles.length ? await store.registerArticles(userId, project.id, articles) : [];
      // A correction written for an error is that error's material, and the
      // error is being handled (G7: 12 corrections were written and all 66
      // errors stayed 「待处理」). Closing stays the measurement's.
      /** @type {string[]} */
      const acting = [];
      for (const [index, article] of articles.entries()) {
        if (!article.errorIds.length || !ids[index]) continue;
        acting.push(...await store.attachCorrection(project.id, article.errorIds, {
          articleId: ids[index], path: article.path, layer: article.layer, title: article.title ?? null, runId: article.runId ?? null,
        }));
      }
      return done(ids, { articles: articles.map((article, index) => ({ id: ids[index], path: article.path, gate: article.gate })),
        ...(acting.length ? { errorsActing: [...new Set(acting)] } : {}) });
    }
    case "owned_links": {
      const known = await store.ownedLinkContext(project.id);
      const { register, retire } = validatedOwnedLinks(itemsOf(body, GEO_WRITE_LIMITS.ownedLinks), issues, known, new Date());
      // A project holds at most GEO_OWNED_LINKS_MAX live links: the page and
      // the citation match read them all. A page already live is an update.
      let room = GEO_OWNED_LINKS_MAX - known.liveKeys.size;
      const admitted = register.filter((link) => {
        if (known.liveKeys.has(link.urlKey) || room-- > 0) return true;
        issues.push({ index: link.index, field: "url", code: "limit", message: `A project holds at most ${GEO_OWNED_LINKS_MAX} live links; retire one first.` });
        return false;
      });
      const registered = admitted.length ? await store.upsertOwnedLinks(userId, project.id, admitted) : [];
      const retired = retire.length ? await store.retireOwnedLinks(project.id, retire) : [];
      retired.forEach((id, position) => {
        if (!id) issues.push({ index: retire[position].index, field: retire[position].id ? "id" : "url", code: "not_found", message: "No link of this project has that id or address." });
      });
      const retiredIds = retired.filter((id) => id !== null);
      return done([...registered, ...retiredIds], { registered, retired: retiredIds });
    }
    case "placement_plan": {
      const plan = validatedPlacementPlan(dataOf(body), issues);
      const written = await store.writePlacementPlan(userId, project.id, plan);
      return done([String(written.version)], { version: written.version });
    }
    case "step": {
      const data = dataOf(body);
      const read = fields(data, issues, {});
      read.unknown(["step", "status", "note"]);
      const step = read.word("step", GEO_STEPS, { required: true });
      const status = read.word("status", GEO_STEP_STATUSES, { required: true });
      const note = read.text("note", 300);
      if (step && !GEO_RUN_STEPS.includes(step)) read.refuse("step", "refused", `${step} is marked by the platform, not by a run.`);
      if (step === "questions" && (status === "done" || status === "minimal")) {
        read.refuse("status", "refused", "The questions step is done when the set is locked (what: lock_questions).");
      }
      if (step === "sources" && status !== "none" && !read.refused && !(await baselineMeasured(store, project.id))) {
        read.refuse("status", BASELINE_MISSING.code, BASELINE_MISSING.message);
      }
      if (read.refused || !step || !status) return done([]);
      const updated = await store.setStep(project.id, step, { status, ...(note ? { note } : {}) });
      return done([project.id], { steps: updated?.steps ?? null });
    }
    default:
      throw failure(400, "geo_write_what_invalid", "Unknown write.");
  }
}

/** Whether a row id a filter names has the shape of one. @param {unknown} value */
export function geoRowIdShape(value) {
  return typeof value === "string" && ROW_ID.test(value);
}
