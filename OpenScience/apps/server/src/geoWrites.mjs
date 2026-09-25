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
 *
 * @module geoWrites
 */

import {
  GEO_ARTICLE_GATES, GEO_ARTICLE_LAYERS, GEO_AUDIENCES, GEO_CLAIM_SOURCE_KINDS, GEO_CLAIM_STATUSES, GEO_ENGINES, GEO_GAP_CLASSES,
  GEO_GROUP_SIGNALS, GEO_IDENTITY_STATUSES, GEO_POOLS, GEO_QUESTION_KINDS, GEO_QUESTION_PLATFORMS, GEO_RX_CLASSES, GEO_SOURCE_KINDS,
  GEO_SOURCE_LAYERS, GEO_STEPS, GEO_STEP_STATUSES, GEO_TARGET_DATA_TYPES, GEO_TIERS, GEO_WRITE_WHATS,
} from "@evimed/domain";
import { HttpError } from "./security.mjs";

/** @typedef {{ index?: number, group?: number, field?: string, code: string, message: string }} GeoIssue */

export const GEO_WRITE_LIMITS = Object.freeze({
  claims: 200, sources: 200, articles: 50, targets: 60, groups: 80, questionsPerGroup: 60, questions: 400, competitors: 20,
  journeyEntries: 60, planEntries: 60, jsonBytes: 256 * 1024,
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
    /** @param {readonly string[]} allowed */
    unknown(allowed) {
      for (const key of Object.keys(source)) if (!allowed.includes(key)) refuse(key, "unknown_field", `${key} is not a field of this item.`);
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
const PRODUCT_LIST_FIELDS = Object.freeze({ aliases: [30, 80], misspellings: [30, 80] });
const COMPETITOR_FIELDS = Object.freeze(["brandName", "genericName", "holder", "indication", "reason"]);

/** @param {Record<string, any>} data @param {GeoIssue[]} issues */
function validatedProduct(data, issues) {
  /** @type {Record<string, any>} */
  const product = {};
  const read = fields(data, issues, {});
  const allowed = [...Object.keys(PRODUCT_TEXT_FIELDS), ...Object.keys(PRODUCT_LIST_FIELDS), "rx", "tcm", "variants", "identityStatus", "competitors"];
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
  /** @type {Record<string, string | null>[] | undefined} */
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
        const competitor = {
          brandName: item.text("brandName", 80), genericName: item.text("genericName", 120), holder: item.text("holder", 120),
          indication: item.text("indication", 1000, { multiline: true }), reason: item.text("reason", 300),
        };
        if (!competitor.brandName && !competitor.genericName) item.refuse("brandName", "missing", "A competitor needs a brand or generic name.");
        if (!item.refused) competitors?.push(/** @type {Record<string, string | null>} */ (competitor));
      });
    }
  }
  return { product, competitors };
}

// --- claims -------------------------------------------------------------------------------

const CLAIM_FIELDS = Object.freeze(["claimKey", "statement", "quote", "sourceRef", "sourceKind", "evidenceLevel", "population", "inLabel", "elements",
  "verifiedAt", "validUntil", "status"]);

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
      sourceKind: read.word("sourceKind", GEO_CLAIM_SOURCE_KINDS),
      evidenceLevel: read.text("evidenceLevel", 60),
      population: read.text("population", 300),
      inLabel: read.flag("inLabel"),
      elements: item.elements == null ? {} : (isObject(item.elements) && withinSize(item.elements, 8 * 1024) ? item.elements
        : read.refuse("elements", "invalid", "elements must be an object of at most 8 KB.")),
      verifiedAt: read.instant("verifiedAt"),
      validUntil: read.instant("validUntil"),
      status: read.word("status", GEO_CLAIM_STATUSES, { fallback: "active" }),
    };
    if (read.refused) return;
    seen.add(claimKey);
    claims.push(claim);
  });
  return claims;
}

// --- the question map -----------------------------------------------------------------------

const GROUP_FIELDS = Object.freeze(["pool", "name", "typicalQuestion", "journeyStage", "audience", "bridge", "weight", "isControl", "signal", "questions"]);
const QUESTION_FIELDS = Object.freeze(["text", "kind", "pool", "platform", "sourceUrl", "collectedAt", "isMeasured"]);

/** @param {Record<string, any>} data @param {GeoIssue[]} issues */
function validatedGroups(data, issues) {
  const read = fields(data, issues, {});
  read.unknown(["groups", "note"]);
  const note = read.text("note", 500);
  if (!Array.isArray(data.groups) || data.groups.length === 0 || data.groups.length > GEO_WRITE_LIMITS.groups) {
    throw failure(400, "geo_write_payload_invalid", `data.groups must hold 1 to ${GEO_WRITE_LIMITS.groups} groups.`);
  }
  /** @type {any[]} */
  const groups = [];
  let total = 0;
  data.groups.forEach((/** @type {unknown} */ entry, /** @type {number} */ index) => {
    if (notAnObject(entry, index, issues)) return;
    const item = /** @type {Record<string, any>} */ (entry);
    const group = fields(item, issues, { index });
    group.unknown(GROUP_FIELDS);
    const value = {
      pool: group.word("pool", GEO_POOLS, { required: true }),
      name: group.text("name", 80, { required: true }),
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
      if (total >= GEO_WRITE_LIMITS.questions) {
        issues.push({ group: index, index: questionIndex, code: "too_many", message: `A set holds at most ${GEO_WRITE_LIMITS.questions} questions.` });
        return;
      }
      total += 1;
      value.questions.push(parsed);
    });
    groups.push(value);
  });
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
  if (measured < low || measured > high) {
    refusals.push({ field: "measured", code: "measured_count", message: `A ${minimal ? "minimal" : "full"} set measures ${low} to ${high} questions; this one measures ${measured}.` });
  }
  const missing = GEO_POOLS.filter((pool) => !measuredQuestions.some((question) => question.pool === pool));
  if (missing.length) refusals.push({ field: "pools", code: "pools_missing", message: `Every pool needs a measured question; missing: ${missing.join(", ")}.` });
  const control = measuredGroups.filter((group) => group.isControl).length;
  const share = measuredGroups.length ? control / measuredGroups.length : 0;
  const [fewest, most] = GEO_CONTROL_RANGE.groups;
  const [lowShare, highShare] = GEO_CONTROL_RANGE.share;
  const controlIssue = control < fewest || control > most
    ? `${fewest} to ${most} control groups are needed; this set has ${control}.`
    : share < lowShare || share > highShare
      ? `Control groups should be about 20–30 % of the groups; here they are ${Math.round(share * 100)} %.`
      : null;
  if (controlIssue) (minimal ? notices : refusals).push({ field: "control", code: minimal ? "notice" : "control_groups", message: controlIssue });
  return { refusals, notices, measured };
}

// --- journey, strategy, placement plan ---------------------------------------------------------

/** @param {Record<string, any>} data @param {GeoIssue[]} issues */
function validatedJourney(data, issues) {
  const read = fields(data, issues, {});
  read.unknown(["subtypes", "personas", "stages", "careNodes", "files"]);
  /** @type {Record<string, any[]>} */
  const journey = { subtypes: [], personas: [], stages: [], careNodes: [], files: [] };
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
    item.unknown(allowed);
    const out = Object.fromEntries(allowed.map((key) => [key, Array.isArray(entry[key]) ? item.texts(key, 30, 500)
      : typeof entry[key] === "number" && Number.isFinite(entry[key]) ? String(entry[key]) : item.text(key, 2000, { multiline: true })]));
    if (!out[required]) item.refuse(required, "missing", `A ${field} entry needs ${required}.`);
    return item.refused ? null : out;
  };
  list("subtypes", (entry, index) => open("subtypes", entry, index, ["name", "definition", "size", "sizeQuality", "note"], "name"));
  list("personas", (entry, index) => open("personas", entry, index, ["name", "age", "situation", "voice", "note"], "name"));
  list("stages", (entry, index) => {
    const item = fields(entry, issues, { index });
    item.unknown(["stage", "emotion", "thinking", "questions", "infoSources"]);
    const stage = { stage: item.text("stage", 60, { required: true }), emotion: item.text("emotion", 300), thinking: item.text("thinking", 1000),
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

/** @param {Record<string, any>} data @param {GeoIssue[]} issues */
function validatedStrategy(data, issues) {
  const read = fields(data, issues, {});
  read.unknown(["battlefield", "expectations", "gaps", "layout", "summary", "sources"]);
  /** @type {Record<string, any>} */
  const strategy = { summary: read.text("summary", 4000, { multiline: true }) ?? null };
  if (data.battlefield != null) {
    const battlefield = isObject(data.battlefield) ? fields(data.battlefield, issues, { }) : null;
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
        const item = fields(/** @type {Record<string, any>} */ (entry), issues, { index });
        item.unknown(["engine", "promise", "layers", "cites", "leverage"]);
        const layers = item.texts("layers", 3, 20);
        if (layers && layers.some((layer) => !GEO_SOURCE_LAYERS.includes(layer))) item.refuse("layers", "unknown_value", `layers are ${GEO_SOURCE_LAYERS.join(", ")}.`);
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
        const item = fields(/** @type {Record<string, any>} */ (entry), issues, { index });
        item.unknown(["class", "groupId", "group", "text", "priority"]);
        const value = { class: item.word("class", GEO_GAP_CLASSES, { required: true }), groupId: item.text("groupId", 80), group: item.text("group", 120),
          text: item.text("text", 1000, { required: true }), priority: item.number("priority", 0, 1000) };
        if (!item.refused) strategy.gaps.push(value);
      });
    }
  }
  if (data.layout != null) {
    if (!isObject(data.layout)) read.refuse("layout", "invalid", "layout is an object keyed by engine.");
    else {
      strategy.layout = {};
      for (const [engine, entry] of Object.entries(data.layout)) {
        if (!GEO_ENGINES.includes(engine) || !isObject(entry)) {
          issues.push({ field: `layout.${engine}`, code: "unknown_value", message: `layout is keyed by engine (${GEO_ENGINES.join(", ")}) with layer lists.` });
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

// --- sources, targets, articles, placement plan, step ---------------------------------------------

const SOURCE_FIELDS = Object.freeze(["domain", "name", "kind", "layer", "icpOwner", "icpMatches", "newsIndexed", "medicalVertical", "impostor",
  "blacklistReason", "checkedAt"]);

/** @param {unknown[]} items @param {GeoIssue[]} issues */
function validatedSources(items, issues) {
  const seen = new Set();
  /** @type {any[]} */
  const sources = [];
  items.forEach((entry, index) => {
    if (notAnObject(entry, index, issues)) return;
    const read = fields(/** @type {Record<string, any>} */ (entry), issues, { index });
    read.unknown(SOURCE_FIELDS);
    const rawDomain = read.text("domain", 253, { required: true });
    const domain = rawDomain ? rawDomain.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "") : rawDomain;
    if (domain && !HOSTNAME.test(domain)) read.refuse("domain", "invalid", "domain must be a host name, e.g. example.com.");
    if (domain && seen.has(domain)) read.refuse("domain", "duplicate", "The same domain appears twice in this write.");
    const source = {
      domain, name: read.text("name", 120), kind: read.word("kind", GEO_SOURCE_KINDS), layer: read.word("layer", GEO_SOURCE_LAYERS),
      icpOwner: read.text("icpOwner", 120), icpMatches: read.flag("icpMatches"), newsIndexed: read.flag("newsIndexed"),
      medicalVertical: read.flag("medicalVertical"), impostor: read.flag("impostor") ?? false, blacklistReason: read.text("blacklistReason", 300),
      checkedAt: read.instant("checkedAt"),
    };
    if (read.refused) return;
    seen.add(domain);
    sources.push(source);
  });
  return sources;
}

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
    const key = `${target.tier}\u0000${metricId}\u0000${pool}`;
    if (!read.refused && seen.has(key)) read.refuse("metricId", "duplicate", "This tier, metric and pool appear twice in this write.");
    if (read.refused) return;
    seen.add(key);
    targets.push(target);
  });
  return targets;
}

const ARTICLE_FIELDS = Object.freeze(["path", "layer", "title", "groupId", "claimIds", "gate", "safety", "contentSha256", "protectedSha256",
  "deliverableId", "runId"]);

/**
 * @param {unknown[]} items @param {GeoIssue[]} issues
 * @param {{ claimIds: Set<string>, groupIds: Set<string> }} known
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
    const pathValue = read.text("path", 512, { required: true });
    if (pathValue && (pathValue.startsWith("/") || pathValue.includes("\\") || pathValue.split("/").some((part) => part === ".." || part === "."))) {
      read.refuse("path", "invalid", "path is the deliverable's path relative to the workspace.");
    }
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
    const article = {
      path: pathValue, layer, title: read.text("title", 200), groupId, claimIds,
      safety: read.word("safety", RUN_ARTICLE_SAFETY, { required: true }),
      contentSha256, protectedSha256, deliverableId: read.text("deliverableId", 120), runId: read.text("runId", 120),
    };
    if (read.refused) return;
    seen.add(pathValue);
    articles.push(article);
  });
  return articles;
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
    case "product": {
      const { product, competitors } = validatedProduct(dataOf(body), issues);
      if (!Object.keys(product).length && competitors === undefined) return done([]);
      const merged = { ...project.product, ...product };
      await store.updateProject(userId, project.id, { product: merged, ...(competitors !== undefined ? { competitors } : {}) });
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
      return done([String(written.version)], { version: written.version });
    }
    case "strategy": {
      const data = dataOf(body);
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
      const written = await store.writeStrategy(userId, project.id, strategy);
      return done([String(written.version)], { version: written.version, sourceIds });
    }
    case "sources": {
      const sources = validatedSources(itemsOf(body, GEO_WRITE_LIMITS.sources), issues);
      return done(sources.length ? await store.upsertSources(userId, project.id, sources) : []);
    }
    case "targets": {
      const targets = validatedTargets(itemsOf(body, GEO_WRITE_LIMITS.targets), issues);
      if (!targets.length) return done([]);
      const tiers = new Set(targets.map((target) => target.tier));
      const missing = GEO_TIERS.filter((tier) => !tiers.has(tier));
      if (missing.length) issues.push({ field: "tier", code: "notice", message: `Targets are written in three tiers; missing: ${missing.join(", ")}.` });
      const written = await store.writeTargets(userId, project.id, targets);
      return done([String(written.version)], { version: written.version });
    }
    case "articles": {
      const items = itemsOf(body, GEO_WRITE_LIMITS.articles);
      const [claimIds, groups] = await Promise.all([
        store.claimIds(project.id),
        store.query(`SELECT id FROM evimed_geo.question_groups WHERE geo_project_id = $1`, [project.id]),
      ]);
      const articles = validatedArticles(items, issues, { claimIds, groupIds: new Set(groups.rows.map((/** @type {any} */ row) => String(row.id))) });
      for (const article of articles) {
        const gate = articleGate ? await articleGate(project, { runId: article.runId ?? null, deliverableId: article.deliverableId ?? null, path: article.path }) : null;
        article.gate = GEO_ARTICLE_GATES.includes(String(gate)) ? gate : "unverified";
      }
      const ids = articles.length ? await store.registerArticles(userId, project.id, articles) : [];
      return done(ids, { articles: articles.map((article, index) => ({ id: ids[index], path: article.path, gate: article.gate })) });
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
