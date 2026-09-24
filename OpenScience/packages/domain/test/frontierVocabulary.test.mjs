import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  FRONTIER_ACCESSES,
  FRONTIER_ACCESS_LABELS_ZH,
  FRONTIER_DATE_PRECISIONS,
  FRONTIER_EGRESSES,
  FRONTIER_EGRESS_LABELS_ZH,
  FRONTIER_ENRICHMENT_KEYS,
  FRONTIER_ENTRY_DEFECTS,
  FRONTIER_EVIDENCE_AUTHORITY_COEFFICIENTS,
  FRONTIER_EVIDENCE_TYPES,
  FRONTIER_EVIDENCE_TYPE_LABELS_ZH,
  FRONTIER_FACT_KEYS,
  FRONTIER_HEALTH_LABELS_ZH,
  FRONTIER_HEALTH_STATES,
  FRONTIER_HEAT_BILINGUAL_FACTOR,
  FRONTIER_HEAT_DISPLAY_SCALE,
  FRONTIER_HEAT_HALF_LIFE_HOURS,
  FRONTIER_HEAT_METHOD_ZH,
  FRONTIER_HEAT_PRIMARY_FACTOR,
  FRONTIER_HOT_BADGE_HOURS,
  FRONTIER_HOT_MIN_INSTITUTIONS,
  FRONTIER_HOT_TREND,
  FRONTIER_HOT_WINDOW_HOURS,
  FRONTIER_ITEM_FLAGS,
  FRONTIER_ITEM_FLAG_LABELS_ZH,
  FRONTIER_LANES,
  FRONTIER_LANE_LABELS_ZH,
  FRONTIER_LAUNCH_TIERS,
  FRONTIER_MASTHEAD_TITLES,
  FRONTIER_MODEL_FLAGS,
  FRONTIER_OPEN_ACCESS_STATUSES,
  FRONTIER_SOURCE_LANES,
  FRONTIER_SOURCE_TYPES,
  FRONTIER_SOURCE_TYPE_LABELS_ZH,
  FRONTIER_SPECIALTIES,
  FRONTIER_SPECIALTY_LABELS_ZH,
  FRONTIER_TEXT_STATUSES,
  FRONTIER_VOCABULARY_FALLBACKS,
  FRONTIER_VOCABULARY_NAMES,
  frontierAuthorityScore,
  frontierEvidenceFromPublicationTypes,
  frontierHeatDisplay,
  frontierLabel,
  frontierScoreLevel,
  frontierValue,
  isFrontierMastheadTitle,
  isFrontierValue,
  mastheadTitleKey,
} from "../index.mjs";

// The knowledge-source plugin's contract, the normative home of the enums
// (workspace docs, checked out with the repository in CI).
const contractUrl = new URL("../../../../docs/superpowers/specs/2026-09-21-medical-frontier-feed-assets/contract/knowledge-plugin-openapi.yaml", import.meta.url);

/**
 * The enums and property names of an OpenAPI YAML file, by path. Not a YAML
 * parser: the contract writes every enum as a one-line flow sequence
 * (`enum: [a, b]`, possibly inside a one-line flow mapping), and nesting by
 * indentation — which is all this needs to follow.
 * @param {string} text
 */
function readContract(text) {
  /** @type {Map<string, string[]>} */
  const enums = new Map();
  /** @type {Map<string, string[]>} */
  const children = new Map();
  /** @type {Array<{ indent: number, key: string }>} */
  const stack = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = /^(\s*)(?:- )?([A-Za-z_][\w-]*):(.*)$/.exec(line);
    if (!match) continue;
    const indent = match[1].length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack.map((entry) => entry.key).join(".");
    const key = match[2];
    const list = children.get(parent) ?? [];
    list.push(key);
    children.set(parent, list);
    const path = parent ? `${parent}.${key}` : key;
    const inline = /\benum:\s*\[([^\]]*)\]/.exec(key === "enum" ? `enum:${match[3]}` : match[3]);
    if (inline) {
      enums.set(key === "enum" ? path : `${path}.enum`, inline[1].split(",").map((value) => value.trim().replace(/^["']|["']$/g, "")).filter(Boolean));
    }
    stack.push({ indent, key });
  }
  return { enums, children };
}

const contract = readContract(await readFile(contractUrl, "utf8"));
/** @param {string} name */
const schema = (name) => `components.schemas.${name}`;

test("the contract reader walked the file: it found the schemas this test compares", () => {
  // A reader that silently found nothing would make every comparison below
  // compare two empty lists and pass for ever.
  assert.ok(contract.enums.size >= 12, `only ${contract.enums.size} enums found`);
  assert.ok((contract.children.get(`${schema("Entry")}.properties.facts.properties`) ?? []).length >= 10);
});

test("every vocabulary the plugin also speaks equals the contract's enum, value for value and in order", () => {
  /** @type {Array<[string, readonly string[], string]>} */
  const pairs = [
    ["Lane", FRONTIER_SOURCE_LANES, `${schema("Lane")}.enum`],
    ["SourceType", FRONTIER_SOURCE_TYPES, `${schema("SourceType")}.enum`],
    ["Egress", FRONTIER_EGRESSES, `${schema("Egress")}.enum`],
    ["Access", FRONTIER_ACCESSES, `${schema("Access")}.enum`],
    ["LaunchTier", FRONTIER_LAUNCH_TIERS, `${schema("LaunchTier")}.enum`],
    ["Health_State", FRONTIER_HEALTH_STATES, `${schema("Health_State")}.enum`],
    ["DatePrecision", FRONTIER_DATE_PRECISIONS, `${schema("DatePrecision")}.enum`],
    ["Entry.defects", FRONTIER_ENTRY_DEFECTS, `${schema("Entry")}.properties.defects.items.enum`],
    ["EntryText.status", FRONTIER_TEXT_STATUSES, `${schema("EntryText")}.properties.status.enum`],
    ["EntryText.enrichment.open_access", FRONTIER_OPEN_ACCESS_STATUSES, `${schema("EntryText")}.properties.enrichment.properties.open_access.enum`],
  ];
  for (const [name, ours, path] of pairs) {
    assert.ok(contract.enums.has(path), `${name}: the contract has no enum at ${path}`);
    assert.deepEqual([...ours], contract.enums.get(path), `${name} differs from the contract`);
  }
});

test("the facts and enrichment whitelists are exactly the contract's property names", () => {
  assert.deepEqual([...FRONTIER_FACT_KEYS], contract.children.get(`${schema("Entry")}.properties.facts.properties`));
  assert.deepEqual([...FRONTIER_ENRICHMENT_KEYS], contract.children.get(`${schema("EntryText")}.properties.enrichment.properties`));
});

test("the eight reader lanes are the contract's lanes without mixed, and every fallback is a member of its vocabulary", () => {
  assert.deepEqual([...FRONTIER_LANES, "mixed"], [...FRONTIER_SOURCE_LANES]);
  assert.equal(FRONTIER_LANES.length, 8);
  assert.ok(FRONTIER_SOURCE_LANES.includes(FRONTIER_VOCABULARY_FALLBACKS.lane));
  assert.ok(FRONTIER_SOURCE_TYPES.includes(FRONTIER_VOCABULARY_FALLBACKS.sourceType));
  assert.ok(FRONTIER_HEALTH_STATES.includes(FRONTIER_VOCABULARY_FALLBACKS.health));
  assert.equal(FRONTIER_SPECIALTIES.length, 21);
  assert.equal(FRONTIER_EVIDENCE_TYPES.length, 10);
  assert.equal(FRONTIER_ITEM_FLAGS.length, 12);
  for (const flag of FRONTIER_MODEL_FLAGS) assert.ok(FRONTIER_ITEM_FLAGS.includes(flag));
});

test("every value has a Chinese label, and no label names a value that does not exist", () => {
  /** @type {Array<[readonly string[], Readonly<Record<string, string>>]>} */
  const vocabularies = [
    [FRONTIER_SOURCE_LANES, FRONTIER_LANE_LABELS_ZH],
    [FRONTIER_SOURCE_TYPES, FRONTIER_SOURCE_TYPE_LABELS_ZH],
    [FRONTIER_EVIDENCE_TYPES, FRONTIER_EVIDENCE_TYPE_LABELS_ZH],
    [FRONTIER_SPECIALTIES, FRONTIER_SPECIALTY_LABELS_ZH],
    [FRONTIER_ITEM_FLAGS, FRONTIER_ITEM_FLAG_LABELS_ZH],
    [FRONTIER_HEALTH_STATES, FRONTIER_HEALTH_LABELS_ZH],
    [FRONTIER_EGRESSES, FRONTIER_EGRESS_LABELS_ZH],
    [FRONTIER_ACCESSES, FRONTIER_ACCESS_LABELS_ZH],
  ];
  for (const [values, labels] of vocabularies) {
    assert.deepEqual(Object.keys(labels).sort(), [...values].sort());
    for (const value of values) {
      assert.ok(typeof labels[value] === "string" && labels[value].trim(), `${value} has no label`);
      assert.doesNotMatch(labels[value], /^[a-z-]+$/, `${value}'s label is an identifier`);
    }
  }
  // The normative wording of the spec's table, spot-checked.
  assert.equal(FRONTIER_LANE_LABELS_ZH.ai, "AI 与医学");
  assert.equal(FRONTIER_LANE_LABELS_ZH.mixed, "待定");
  assert.equal(FRONTIER_EVIDENCE_TYPE_LABELS_ZH["systematic-review"], "系统评价与Meta分析");
  assert.equal(FRONTIER_ITEM_FLAG_LABELS_ZH.preprint, "未经同行评议");
  assert.equal(FRONTIER_ITEM_FLAG_LABELS_ZH["registry-unpublished"], "注册，未发表结果");
  assert.equal(FRONTIER_HEALTH_LABELS_ZH.unreadable, "暂时读不到");
});

test("a value this build does not know falls back and is reported as unknown, never refused", () => {
  assert.deepEqual(frontierValue("lane", "evidence"), { value: "evidence", known: true });
  assert.deepEqual(frontierValue("lane", "conference"), { value: "mixed", known: false });
  assert.deepEqual(frontierValue("sourceType", "podcast"), { value: "media", known: false });
  assert.deepEqual(frontierValue("health", "sleeping"), { value: "degraded", known: false });
  assert.deepEqual(frontierValue("health", undefined), { value: "degraded", known: false });
  // No fallback: the caller drops the value (a defect, a flag) or refuses it.
  assert.deepEqual(frontierValue("defect", "haunted"), { value: null, known: false });
  assert.deepEqual(frontierValue("egress", "carrier-pigeon"), { value: null, known: false });
  assert.equal(isFrontierValue("specialty", "cardiology"), true);
  assert.equal(isFrontierValue("specialty", "Cardiology"), false);
  assert.equal(isFrontierValue("flag", 7), false);
  assert.throws(() => isFrontierValue(/** @type {any} */ ("colour"), "red"), /Unknown frontier vocabulary/);
  assert.deepEqual([...FRONTIER_VOCABULARY_NAMES], ["lane", "sourceType", "evidenceType", "specialty", "flag", "health", "egress", "access", "launchTier", "datePrecision", "defect"]);
});

test("a label is the Chinese word or null, never the key", () => {
  assert.equal(frontierLabel("lane", "public-health"), "公共卫生");
  assert.equal(frontierLabel("specialty", "tcm"), "中医药");
  assert.equal(frontierLabel("flag", "press-release"), "企业新闻稿·数据未发表");
  assert.equal(frontierLabel("health", "drifted"), "漂移");
  assert.equal(frontierLabel("access", "html-list"), "网页列表");
  assert.equal(frontierLabel("egress", "relay"), "海外中继");
  assert.equal(frontierLabel("lane", "gossip"), null);
  assert.equal(frontierLabel("lane", null), null);
  assert.equal(frontierLabel("defect", "no-date"), null, "defects have no reader-facing label");
});

test("PubMed publication types replace the model's evidence type only when they name a design", () => {
  /** @param {unknown} types */
  const decide = (types) => frontierEvidenceFromPublicationTypes(types);
  assert.deepEqual(decide(["Journal Article", "Randomized Controlled Trial"]), { evidenceType: "rct", matched: "randomized controlled trial", demote: false });
  assert.equal(decide(["Review", "Systematic Review", "Meta-Analysis"]).evidenceType, "systematic-review");
  assert.equal(decide(["Systematic Review", "Practice Guideline"]).evidenceType, "guideline", "a guideline built on a review is a guideline");
  assert.equal(decide(["Network Meta-Analysis"]).evidenceType, "systematic-review");
  assert.equal(decide(["Observational Study", "Research Support, N.I.H., Extramural"]).evidenceType, "observational");
  assert.equal(decide(["Case Reports"]).evidenceType, "other");
  assert.equal(decide(["Review"]).evidenceType, "review-opinion");
  assert.equal(decide(["  randomized   controlled trial "]).evidenceType, "rct", "compared case- and space-insensitively");
  // A research letter is research: the design wins over the format.
  assert.equal(decide(["Letter", "Randomized Controlled Trial"]).evidenceType, "rct");
  // Designs NLM leaves open are the model's call.
  for (const open of [["Clinical Trial, Phase III"], ["Multicenter Study", "Comparative Study"], ["Journal Article"], ["Journal Article", "English Abstract"], [], null, "rct"]) {
    assert.deepEqual(decide(open), { evidenceType: null, matched: null, demote: false }, JSON.stringify(open));
  }
});

test("an article that is only a letter, comment or editorial is demoted; a journal's news piece is not", () => {
  assert.deepEqual(frontierEvidenceFromPublicationTypes(["Journal Article", "Comment"]), { evidenceType: "review-opinion", matched: "comment", demote: true });
  assert.deepEqual(frontierEvidenceFromPublicationTypes(["Editorial"]), { evidenceType: "review-opinion", matched: "editorial", demote: true });
  assert.deepEqual(frontierEvidenceFromPublicationTypes(["Letter", "Comment"]), { evidenceType: "review-opinion", matched: "letter", demote: true });
  assert.deepEqual(frontierEvidenceFromPublicationTypes(["Biography", "Portrait", "Historical Article"]), { evidenceType: null, matched: null, demote: false },
    "a type outside both tables means it is not only non-research");
  assert.deepEqual(frontierEvidenceFromPublicationTypes(["News"]), { evidenceType: "other", matched: "news", demote: false });
  assert.deepEqual(frontierEvidenceFromPublicationTypes(["Comment", "News"]), { evidenceType: "other", matched: "news", demote: false });
});

test("a bare Letter decides only after the model read the article and found no research design", () => {
  const undecided = { evidenceType: null, matched: null, demote: false };
  const letter = { evidenceType: "review-opinion", matched: "letter", demote: true };
  assert.deepEqual(frontierEvidenceFromPublicationTypes(["Letter"]), undecided, "before the edit: the model reads it first");
  assert.deepEqual(frontierEvidenceFromPublicationTypes(["Letter", "Research Support, Non-U.S. Gov't"], { modelType: "rct" }), undecided,
    "a research letter (JAMA's secondary analysis of an RCT) keeps the design the model read");
  assert.deepEqual(frontierEvidenceFromPublicationTypes(["Letter"], { modelType: "observational" }), undecided);
  assert.deepEqual(frontierEvidenceFromPublicationTypes(["Letter"], { modelType: "review-opinion" }), letter, "correspondence stays demoted");
  assert.deepEqual(frontierEvidenceFromPublicationTypes(["Letter"], { modelType: "other" }), letter);
  assert.deepEqual(frontierEvidenceFromPublicationTypes(["Letter", "Comment"], { modelType: "rct" }), letter, "a letter that comments is correspondence");
});

test("the authority score is the grade times the evidence coefficient, discounted for a preprint", () => {
  assert.equal(frontierAuthorityScore({ authority: 5, evidenceType: "rct" }), 30);
  assert.equal(frontierAuthorityScore({ authority: 5, evidenceType: "observational" }), 24);
  assert.equal(frontierAuthorityScore({ authority: 5, evidenceType: "real-world" }), 23, "30 × 0.75 = 22.5 rounds up");
  assert.equal(frontierAuthorityScore({ authority: 3, evidenceType: "other" }), 11, "30 × 3/5 × 0.6 = 10.8");
  assert.equal(frontierAuthorityScore({ authority: 4, evidenceType: "rct", preprint: true }), 14, "30 × 4/5 × 0.6 = 14.4");
  assert.equal(frontierAuthorityScore({ authority: 2, evidenceType: "press-release" }), 6);
  assert.equal(frontierAuthorityScore({ authority: 5, evidenceType: null }), 18, "no evidence type counts as other");
  assert.equal(frontierAuthorityScore({ authority: 5, evidenceType: "horoscope" }), 18);
  assert.equal(frontierAuthorityScore({ authority: 9, evidenceType: "guideline" }), 30, "a grade out of range is clamped");
  assert.equal(frontierAuthorityScore({ authority: "x", evidenceType: "guideline" }), 6);
  for (const type of FRONTIER_EVIDENCE_TYPES) assert.ok(FRONTIER_EVIDENCE_AUTHORITY_COEFFICIENTS[type] > 0, type);
});

test("a score reads as a level, never as its number", () => {
  assert.equal(frontierScoreLevel("authority", 30), "high");
  assert.equal(frontierScoreLevel("authority", 20), "high");
  assert.equal(frontierScoreLevel("authority", 19), "medium");
  assert.equal(frontierScoreLevel("authority", 10), "medium");
  assert.equal(frontierScoreLevel("authority", 9), "low");
  assert.equal(frontierScoreLevel("novelty", 14), "high");
  assert.equal(frontierScoreLevel("relevance", 7), "medium");
  assert.equal(frontierScoreLevel("relevance", 6), "low");
  assert.equal(frontierScoreLevel("impact", null), null);
  assert.equal(frontierScoreLevel("impact", undefined), null);
});

test("a masthead is recognised by its whole title only", () => {
  for (const title of ["Editorial Board", "EDITORIAL BOARD", "Issue Information", "Table of Contents.", " Cover ", "Front Matter",
    "Editorial Board & Table of Contents", "目录", "本期导读", "In This Issue:"]) {
    assert.equal(isFrontierMastheadTitle(title), true, title);
  }
  for (const title of ["Covering the uninsured", "Cover story: semaglutide in heart failure", "Issue Information and more",
    "The editorial board of a journal decides", "", null, "Index of multiple deprivation and stroke"]) {
    assert.equal(isFrontierMastheadTitle(title), false, String(title));
  }
  assert.equal(mastheadTitleKey("  Issue\u00A0Information  "), "issue information");
  for (const title of FRONTIER_MASTHEAD_TITLES) assert.equal(mastheadTitleKey(title), title, `${title} is written in key form`);
});

test("the heat a page shows is the computed heat times ten, rounded; nothing to show is null, never a zero made up", () => {
  assert.equal(FRONTIER_HEAT_DISPLAY_SCALE, 10);
  assert.equal(frontierHeatDisplay(3.84), 38);
  assert.equal(frontierHeatDisplay(1.25), 13);
  assert.equal(frontierHeatDisplay(0), 0);
  assert.equal(frontierHeatDisplay("2.2"), 22, "a numeric string from the database is a number");
  assert.equal(frontierHeatDisplay(-0.4), 0, "heat is never negative on the page");
  for (const nothing of [null, undefined, "", Number.NaN, Number.POSITIVE_INFINITY, "hot", true]) {
    assert.equal(frontierHeatDisplay(nothing), null, String(nothing));
  }
});

test("「热度怎么算」 states the numbers the hot list is computed with, every one of them", () => {
  const text = FRONTIER_HEAT_METHOD_ZH.join("\n");
  assert.ok(Object.isFrozen(FRONTIER_HEAT_METHOD_ZH) && FRONTIER_HEAT_METHOD_ZH.length >= 3);
  for (const [name, value] of Object.entries({ FRONTIER_HEAT_HALF_LIFE_HOURS, FRONTIER_HEAT_PRIMARY_FACTOR, FRONTIER_HEAT_BILINGUAL_FACTOR,
    FRONTIER_HEAT_DISPLAY_SCALE, FRONTIER_HOT_WINDOW_HOURS, FRONTIER_HOT_MIN_INSTITUTIONS, trendHours: FRONTIER_HOT_TREND.hours,
    trendStep: FRONTIER_HOT_TREND.stepHours, trendHistory: FRONTIER_HOT_TREND.minHistoryHours, badgeNew: FRONTIER_HOT_BADGE_HOURS.new,
    badgeRising: FRONTIER_HOT_BADGE_HOURS.rising })) {
    // As a whole number: 1.5 is not stated by 11.5, nor 36 by 360.
    const stated = new RegExp(`(?<![\\d.])${String(value).replace(".", "\\.")}(?![\\d.])`);
    assert.match(text, stated, `${name} (${value}) is not stated`);
  }
  // It explains attention, not evidence: the one misreading a heat number invites.
  assert.match(text, /不衡量证据强弱/);
  assert.doesNotMatch(text, /爆|AI 评分|推荐/, "the words the plan keeps out of the medical version");
});
