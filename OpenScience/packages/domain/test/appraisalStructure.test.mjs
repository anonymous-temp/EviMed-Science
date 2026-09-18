// Structured PICO, GRADE certainty and risk of bias on an evidence-matrix
// claim (plan §9.8 / P2-22). The model makes every judgement and writes it in
// parts; code recomputes the level from the parts and says when a stated level
// disagrees. Every case here asserts one of three things: the arithmetic is
// GRADE's and each tool's own; a finding is advisory and never unverifies a
// claim or holds a package back; and a package without the new fields — or
// with the PICO shape the skill taught first — is judged exactly as before.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CERTAINTY_LEVELS,
  CERTAINTY_LEVEL_LABELS_ZH,
  GATE_CHECK_IDS,
  RISK_OF_BIAS_TOOL_IDS,
  claimAppraisal,
  claimAppraisalFindings,
  evidenceDesignOf,
  gradeCertaintyFromParts,
  riskOfBiasOverall,
  runGate,
  sourceTypeOfSidecar,
  sourceTypeSidecarPath,
} from "../index.mjs";
import {
  CLINICAL_CHECK_TIERS,
  clinicalCheckTier,
  clinicalEvidenceCheckIds,
  validateClinicalEvidencePackage,
  validateEvidenceClaim,
} from "../src/clinicalEvidence.mjs";

const APPRAISAL_CHECKS = [
  "claim-pico-schema",
  "claim-pico-quote",
  "claim-certainty-schema",
  "claim-certainty-arithmetic",
  "claim-certainty-design",
  "claim-rob-schema",
  "claim-rob-overall",
];

/* ------------------------------------------------------------ GRADE ------ */

test("the certainty ladder is GRADE's four rungs, and a reader sees 高 / 中 / 低 / 极低", () => {
  assert.deepEqual([...CERTAINTY_LEVELS], ["very-low", "low", "moderate", "high"]);
  assert.deepEqual({ ...CERTAINTY_LEVEL_LABELS_ZH }, { high: "高", moderate: "中", low: "低", "very-low": "极低" });
});

test("randomized evidence starts at high and each step down drops a rung, clamped at very low", () => {
  const level = (/** @type {Record<string, unknown>} */ parts) => gradeCertaintyFromParts({ start: "high", ...parts })?.level;
  assert.equal(level({}), "high");
  assert.equal(level({ imprecision: -1 }), "moderate");
  assert.equal(level({ riskOfBias: -1, imprecision: -1 }), "low");
  assert.equal(level({ riskOfBias: -2, indirectness: -1 }), "very-low");
  // Five domains at their worst are nine steps; the ladder has three below high.
  assert.equal(level({ riskOfBias: -2, inconsistency: -2, indirectness: -2, imprecision: -2, publicationBias: -2 }), "very-low");
  const result = gradeCertaintyFromParts({ start: "high", riskOfBias: -1, imprecision: -1 });
  assert.equal(result?.down, 2);
  assert.deepEqual(result?.moves, { riskOfBias: -1, imprecision: -1 });
});

test("a step down reads in either sign and in GRADE's own words", () => {
  const level = (/** @type {unknown} */ imprecision) => gradeCertaintyFromParts({ start: "high", imprecision })?.level;
  assert.equal(level(1), "moderate", "a downgrade domain can only lower the rating, so 1 means one step down");
  assert.equal(level("-2"), "low");
  assert.equal(level("serious"), "moderate");
  assert.equal(level("Very Serious"), "low");
  assert.equal(level("not serious"), "high");
  assert.equal(gradeCertaintyFromParts({ start: "high", publicationBias: "strongly suspected" })?.level, "moderate");
  // Handbook table 5.2: publication bias, like the other four, moves one or two levels.
  assert.equal(gradeCertaintyFromParts({ start: "high", publicationBias: -2 })?.level, "low");
});

test("risk of bias may take a third step, the one ROBINS-I needs from a high start (GRADE guideline 18)", () => {
  assert.equal(gradeCertaintyFromParts({ start: "high", riskOfBias: -3 })?.level, "very-low");
  assert.equal(gradeCertaintyFromParts({ start: "high", imprecision: -3 }), null, "only risk of bias takes three");
});

test("observational evidence starts at low, rises for a large effect, and is clamped at high", () => {
  const observational = { design: /** @type {const} */ ("observational") };
  assert.equal(gradeCertaintyFromParts({ start: "low" }, observational)?.level, "low");
  assert.equal(gradeCertaintyFromParts({ start: "low", upgrades: { largeEffect: 1 } }, observational)?.level, "moderate");
  assert.equal(gradeCertaintyFromParts({ start: "low", upgrades: { largeEffect: 2 } }, observational)?.level, "high");
  assert.equal(gradeCertaintyFromParts({ start: "low", upgrades: { largeEffect: 2, doseResponse: 1, confounding: 1 } }, observational)?.level, "high");
  assert.equal(gradeCertaintyFromParts({ start: "low", riskOfBias: -1 }, observational)?.level, "very-low");
  assert.equal(gradeCertaintyFromParts({ start: "low", riskOfBias: -2, imprecision: -1 }, observational)?.level, "very-low", "clamped at the bottom rung");
  // Additive both ways (Handbook §5.3, "factors ... are additive").
  assert.equal(gradeCertaintyFromParts({ start: "low", imprecision: -1, upgrades: { largeEffect: 2 } }, observational)?.level, "moderate");
  // Written directly on the entry, or as booleans, the upgrade is still read.
  assert.equal(gradeCertaintyFromParts({ start: "low", doseResponse: true }, observational)?.level, "moderate");
  assert.equal(gradeCertaintyFromParts({ start: "low", upgrades: { largeEffect: "very large" } }, observational)?.level, "high");
});

test("upgrades count for observational evidence only — randomized evidence is not rated up (Handbook §5.3)", () => {
  const parts = { start: "high", imprecision: -1, upgrades: { largeEffect: 1 } };
  const randomized = gradeCertaintyFromParts(parts, { design: "randomized" });
  assert.equal(randomized?.level, "moderate", "the large effect does not lift randomized evidence back to high");
  assert.equal(randomized?.upgradesCounted, false);
  assert.equal(randomized?.designFrom, "sources");

  // No stamped design: the instrument decides before the start does.
  const robinsI = gradeCertaintyFromParts({ start: "high", riskOfBias: -2, upgrades: { largeEffect: 1 } }, { tools: ["ROBINS-I"] });
  assert.equal(robinsI?.level, "moderate", "ROBINS-I-assessed evidence is non-randomized: its upgrade counts");
  assert.deepEqual([robinsI?.design, robinsI?.designFrom], ["observational", "tool"]);
  const rob2 = gradeCertaintyFromParts({ start: "low", upgrades: { largeEffect: 1 } }, { tools: ["RoB 2"] });
  assert.deepEqual([rob2?.level, rob2?.upgradesCounted], ["low", false]);

  // Nothing else to go on: GRADE's own convention, high for randomized.
  const fromStart = gradeCertaintyFromParts(parts);
  assert.deepEqual([fromStart?.level, fromStart?.upgradesCounted, fromStart?.designFrom], ["moderate", false, "start"]);
  const lowStart = gradeCertaintyFromParts({ start: "low", upgrades: { largeEffect: 1 } });
  assert.deepEqual([lowStart?.level, lowStart?.upgradesCounted], ["moderate", true]);
});

test("parts that cannot be read give no level rather than a guessed one", () => {
  assert.equal(gradeCertaintyFromParts({ start: "moderate" }), null, "GRADE starts at high or low only");
  assert.equal(gradeCertaintyFromParts({ start: "high", imprecision: "somewhat" }), null);
  assert.equal(gradeCertaintyFromParts({ start: "low", upgrades: { largeEffect: 3 } }), null);
  assert.equal(gradeCertaintyFromParts({ start: "low", upgrades: { doseResponse: -1 } }), null, "an upgrade is never negative");
  assert.equal(gradeCertaintyFromParts("low"), null, "a bare level has no parts to recompute");
  assert.equal(gradeCertaintyFromParts(null), null);
});

test("a design is decided only when every cited source's stamped type decides it", () => {
  assert.equal(evidenceDesignOf(["rct", "rct"]), "randomized");
  assert.equal(evidenceDesignOf(["observational", "case-report"]), "observational");
  assert.equal(evidenceDesignOf(["rct", "observational"]), "unknown");
  assert.equal(evidenceDesignOf(["rct", null]), "unknown", "a source with no stamped type leaves it open");
  assert.equal(evidenceDesignOf(["meta-analysis"]), "unknown", "a review's design says nothing about what it contains");
  assert.equal(evidenceDesignOf(["clinical-trial"]), "unknown", "PubMed's generic Clinical Trial is not necessarily randomized");
  assert.equal(evidenceDesignOf([]), "unknown");
});

/* ----------------------------------------------------- risk of bias ------ */

/** @param {string} tool @param {string[]} judgements @param {string} [overall] */
function rob(tool, judgements, overall) {
  return riskOfBiasOverall({ tool, domains: Object.fromEntries(judgements.map((judgement, index) => [`D${index + 1}`, judgement])), ...(overall ? { overall } : {}) });
}

test("RoB 2: low only when every domain is low, high when any is, some concerns otherwise (Cochrane Handbook 8.2.b)", () => {
  assert.equal(rob("RoB 2", ["low", "low", "low", "low", "low"])?.computed, "low");
  assert.equal(rob("rob2", ["low", "some concerns", "low", "low", "low"])?.computed, "some-concerns");
  assert.equal(rob("rob2", ["low", "Some concerns", "Low risk of bias", "high risk", "low"])?.computed, "high");
  // Several some-concerns domains may be judged high: either answer is the tool's.
  const several = rob("rob2", ["some", "some", "low", "low", "low"], "high");
  assert.deepEqual([several?.computed, several?.allowed, several?.agrees], ["some-concerns", ["some-concerns", "high"], true]);
  assert.equal(rob("rob2", ["some", "low", "low", "low", "low"], "high")?.agrees, false, "one some-concerns domain is not several");
  assert.equal(rob("rob2", ["low", "low", "low", "low", "low"], "some concerns")?.agrees, false);
});

test("an overall that needs every domain cannot be claimed from some of them", () => {
  const partial = rob("rob2", ["low", "low", "low"], "low");
  assert.equal(partial?.computed, null, "three of five domains leave the overall open");
  assert.deepEqual(partial?.allowed, ["some-concerns", "high"]);
  assert.equal(partial?.agrees, false);
  assert.deepEqual([partial?.rated, partial?.expected], [3, 5]);
  // A high domain decides it however many others are rated.
  assert.equal(rob("rob2", ["high"])?.computed, "high");
});

test("ROBINS-I: the most severe domain decides, and a domain without information rules out low (Sterne 2016, table 2)", () => {
  const six = (/** @type {string} */ last) => ["low", "low", "low", "low", "low", last];
  assert.equal(rob("ROBINS-I", six("low"))?.computed, "low");
  assert.equal(rob("ROBINS-I", six("moderate"))?.computed, "moderate");
  assert.equal(rob("ROBINS-I", six("serious risk of bias"))?.computed, "serious");
  assert.equal(rob("ROBINS-I", [...six("serious"), "critical"])?.computed, "critical");
  const noInformation = rob("robins-i", six("no information"), "low");
  assert.deepEqual([noInformation?.computed, noInformation?.allowed, noInformation?.agrees], [null, ["moderate", "no-information"], false]);
  assert.equal(rob("robins-i", six("NI"), "no information")?.agrees, true);
  assert.equal(rob("robins-i", [...six("NI").slice(0, 5), "serious"], "no information")?.agrees, false, "serious outranks a gap in information");
});

test("ROBINS-E and QUADAS-2 follow their own rules", () => {
  const seven = ["low", "low", "some concerns", "high", "high", "low", "low"];
  assert.deepEqual(rob("ROBINS-E", seven)?.allowed, ["high", "very-high"], "several high domains may be judged very high");
  assert.equal(rob("ROBINS-E", ["low", "low", "low", "low", "low", "high", "low"], "very high")?.agrees, false);
  assert.equal(rob("QUADAS-2", ["low", "low", "low", "low"])?.computed, "low");
  assert.deepEqual(rob("QUADAS-2", ["low", "unclear", "low", "low"])?.allowed, ["unclear", "high"]);
  assert.deepEqual(rob("QUADAS-2", ["low", "unclear", "high", "low"])?.allowed, ["high"]);
});

test("AMSTAR 2: critical flaws and non-critical weaknesses decide the confidence (Shea 2017, box 2)", () => {
  /** @param {Record<number, string>} answers @param {Record<string, unknown>} [extra] */
  const amstar = (answers, extra = {}) => riskOfBiasOverall({
    tool: "AMSTAR 2",
    domains: Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`item ${index + 1}`, answers[index + 1] ?? "yes"])),
    ...extra,
  });
  assert.equal(amstar({})?.computed, "high");
  assert.equal(amstar({ 1: "no" })?.computed, "high", "one non-critical weakness");
  const weak = amstar({ 1: "no", 3: "no" });
  assert.deepEqual([weak?.computed, weak?.allowed], ["moderate", ["moderate", "low"]]);
  assert.equal(amstar({ 2: "no" })?.computed, "low", "item 2, a registered protocol, is critical");
  assert.equal(amstar({ 2: "no", 9: "no" })?.computed, "critically-low");
  assert.equal(amstar({ 12: "not applicable", 3: "partial yes" })?.computed, "high", "partial yes and not applicable are not flaws");
  // The paper lets appraisers choose the critical items; the choice is honoured.
  assert.equal(amstar({ 3: "no" }, { criticalItems: [3] })?.computed, "low");
  assert.equal(amstar({ 2: "no" }, { overall: "high" })?.agrees, false);
  // Items keyed any way a number can be written.
  const keyed = riskOfBiasOverall({ tool: "amstar2", domains: [{ item: 2, answer: "No" }, { domain: "Q4", judgement: "no" }] });
  assert.equal(keyed?.computed, "critically-low", "two critical flaws decide it before all sixteen are rated");
});

test("a tool this module does not recompute is recorded as written", () => {
  const nos = riskOfBiasOverall({ tool: "Newcastle-Ottawa", domains: { selection: "3 stars" }, overall: "good" });
  assert.deepEqual([nos?.recomputed, nos?.stated, nos?.computed, nos?.agrees], [false, "good", null, null]);
  assert.equal(riskOfBiasOverall({ domains: { D1: "low" } }), null, "no tool, nothing to read the levels against");
  assert.deepEqual([...RISK_OF_BIAS_TOOL_IDS], ["rob2", "robins-i", "robins-e", "quadas2", "amstar2"]);
});

/* ------------------------------------------------------- claim level ----- */

const SOURCE = ".evimed-sources/aspree/fulltext.md";
const SOURCE_TEXT = "We enrolled community-dwelling persons 70 years of age or older who did not have cardiovascular disease. "
  + "Participants received 100 mg of enteric-coated aspirin or placebo daily. "
  + "Major hemorrhage occurred in 361 persons in the aspirin group and 265 in the placebo group (hazard ratio, 1.38; 95% CI, 1.18 to 1.62).";

/** A direct claim bound verbatim to its source. @param {Record<string, unknown>} [overrides] */
function directClaim(overrides = {}) {
  return {
    claimId: "CLM-001",
    claim: "70 岁及以上成人每日服用阿司匹林使大出血风险升高（HR 1.38）。",
    referenceNumber: 1,
    sourceUrl: "https://www.nejm.org/doi/10.1056/NEJMoa1800722",
    sourceTitle: "Effect of Aspirin on Cardiovascular Events and Bleeding in the Healthy Elderly",
    artifactPath: SOURCE,
    identifier: "doi:10.1056/NEJMoa1800722",
    accessLevel: "full_text",
    supportQuote: "Major hemorrhage occurred in 361 persons in the aspirin group and 265 in the placebo group (hazard ratio, 1.38; 95% CI, 1.18 to 1.62).",
    applicability: "70 岁及以上、无心血管病史的社区成人",
    uncertainty: "单一大型试验",
    ...overrides,
  };
}

/** @param {any} claim @param {Record<string, string>} [sourceTypes] */
function judge(claim, sourceTypes = {}) {
  return validateEvidenceClaim({ claim, sourceArtifacts: { [SOURCE]: SOURCE_TEXT }, sourceTypes });
}

/** @param {ReturnType<typeof judge>} verdict */
function appraisalIssues(verdict) {
  return verdict.issues.filter((issue) => APPRAISAL_CHECKS.includes(issue.code));
}

test("the seven appraisal checks are on the one axis, and every one of them is advice", () => {
  const axis = new Set(GATE_CHECK_IDS);
  for (const id of APPRAISAL_CHECKS) {
    assert.ok(clinicalEvidenceCheckIds.includes(id), `${id} is not a clinical check id`);
    assert.ok(axis.has(id), `${id} is not on GATE_CHECK_IDS`);
    assert.equal(clinicalCheckTier(id), "advisory", `${id} must never block`);
    assert.equal(Object.hasOwn(CLINICAL_CHECK_TIERS, id), false, `${id} must stay out of CLINICAL_CHECK_TIERS`);
  }
});

test("a claim without the new fields is judged exactly as before, and raises nothing new", () => {
  const verdict = judge(directClaim());
  assert.equal(verdict.status, "verified", JSON.stringify(verdict.issues));
  assert.deepEqual(appraisalIssues(verdict), []);
  assert.equal(claimAppraisal(directClaim()), null);
});

test("the PICO the skill taught first — {population, intervention, outcome} — is read as it stands", () => {
  const legacy = directClaim({ pico: { population: "≥70 岁社区成人", intervention: "阿司匹林 100 mg/d", outcome: "大出血" }, picoMatch: { population: "same", intervention: "same", outcome: "same" } });
  assert.deepEqual(judge(legacy), judge(directClaim()), "not one finding more, not one less");
  assert.deepEqual(claimAppraisal(legacy)?.pico, {
    population: "≥70 岁社区成人", intervention: "阿司匹林 100 mg/d", exposure: false, comparator: null, outcomes: ["大出血"], timeframe: null, setting: null,
  });
  assert.equal(claimAppraisal(directClaim({ pico: { population: "成人", exposure: "吸烟", outcomes: ["肺癌"] } }))?.pico?.exposure, true, "PECO is labelled as such");
});

test("a PICO part's quote is held to the same verbatim check as the claim's own, and a miss is advice", () => {
  const pico = {
    population: { text: "≥70 岁社区成人", quote: "community-dwelling persons 70 years of age or older" },
    intervention: { text: "阿司匹林 100 mg/d", quote: "100 mg of enteric-coated aspirin" },
    comparator: "安慰剂",
    outcomes: [{ text: "大出血", quote: "Major hemorrhage occurred" }],
  };
  const verified = judge(directClaim({ pico }));
  assert.deepEqual(appraisalIssues(verified), [], "every part's quote is in the preserved source");
  assert.equal(verified.status, "verified");

  const misquoted = judge(directClaim({ pico: { ...pico, population: { text: "≥70 岁", quote: "adults aged 65 or older" } } }));
  const issues = appraisalIssues(misquoted);
  assert.deepEqual(issues.map((issue) => [issue.code, issue.tier]), [["claim-pico-quote", "advisory"]]);
  assert.match(issues[0].message, /^CLM-001\.pico\.population\.quote was not found in its preserved source artifact\./);
  assert.equal(misquoted.status, "verified", "a PICO quote is advice; the claim's own bond is what verifies it");
});

test("a PICO quote needs a source: its own for a synthesized claim, and an unpreserved own source is not reported twice", () => {
  const synthesized = {
    claimId: "CLM-002",
    claimType: "synthesized",
    claim: "两项试验方向一致。",
    applicability: "a",
    uncertainty: "b",
    confidence: "moderate",
    referenceNumber: 1,
    referenceNumbers: [1, 2],
    supportingSources: [],
    pico: { population: { text: "≥70 岁", quote: "70 years of age or older" }, intervention: "阿司匹林", outcomes: ["大出血"] },
  };
  const found = claimAppraisalFindings(synthesized, { label: "claims[1]" });
  assert.equal(found.picoQuotes.length, 1);
  const verdict = judge(synthesized);
  assert.ok(verdict.issues.some((issue) => issue.code === "claim-pico-quote" && /names no source/.test(issue.message)), JSON.stringify(verdict.issues));

  // The claim's own source was never preserved: its artifact-path finding
  // already says so, and the part's quote adds nothing to it.
  const unpreserved = validateEvidenceClaim({ claim: directClaim({ pico: { population: { text: "x", quote: "y" }, intervention: "i", outcomes: ["o"] } }), sourceArtifacts: {} });
  assert.deepEqual(appraisalIssues(unpreserved), []);
});

test("a malformed PICO is named precisely, once per problem", () => {
  const messages = (/** @type {unknown} */ pico) => claimAppraisalFindings(directClaim({ pico }), { label: "claims[0]" }).picoSchema;
  assert.match(messages("adults; aspirin; bleeding")[0], /^claims\[0\]\.pico must be an object/);
  assert.deepEqual(messages({ intervention: "阿司匹林" }), [
    "claims[0].pico names no population, outcomes. A PICO names the population, the intervention (or exposure) and at least one outcome the source actually studied.",
  ]);
  assert.deepEqual(messages({ population: { quote: "q" }, intervention: "i", outcomes: ["o"] }), [
    "claims[0].pico.population needs a non-empty text.",
  ], "a part present and unreadable is one problem, not also a missing one");
  assert.deepEqual(messages({ population: "p", exposure: "吸烟", outcomes: "肺癌" }), [], "PECO and a single outcome read as written");
  assert.deepEqual(messages({ population: "p", intervention: "i", outcomes: [], comparator: "" }), [
    "claims[0].pico names no outcomes. A PICO names the population, the intervention (or exposure) and at least one outcome the source actually studied.",
  ]);
});

test("a certainty whose label its parts do not give is advice, and says what the parts give", () => {
  const certainty = { start: "high", riskOfBias: -1, imprecision: -1, rationale: { riskOfBias: "分配隐藏不清", imprecision: "事件数少" }, label: "moderate" };
  const verdict = judge(directClaim({ certainty }), { [SOURCE]: "rct" });
  const issues = appraisalIssues(verdict);
  assert.deepEqual(issues.map((issue) => [issue.code, issue.tier]), [["claim-certainty-arithmetic", "advisory"]]);
  assert.equal(issues[0].message, 'CLM-001.certainty is labelled "moderate", but its parts give "low": it starts at high, is rated down 2 (riskOfBias -1, imprecision -1) and up 0. Correct the label or the part that is wrong; the reader is shown both.');
  assert.equal(verdict.status, "verified", "a disagreeing label never unverifies the claim");
  assert.deepEqual(claimAppraisal(directClaim({ certainty }), { sourceTypes: { [SOURCE]: "rct" } })?.certainty, [
    { outcome: null, stated: "moderate", computed: "low", agrees: false, upgradesCounted: false },
  ]);
  assert.deepEqual(appraisalIssues(judge(directClaim({ certainty: { ...certainty, label: "low" } }), { [SOURCE]: "rct" })), []);
});

test("the design stamped on the sources checks where a certainty starts and whether it may rise", () => {
  const rct = { [SOURCE]: "rct" };
  const lowStart = appraisalIssues(judge(directClaim({ certainty: { start: "low", label: "low" } }), rct));
  assert.deepEqual(lowStart.map((issue) => issue.code), ["claim-certainty-design"]);
  assert.match(lowStart[0].message, /starts at low, but every source it cites is a randomized trial/);

  const upgraded = appraisalIssues(judge(directClaim({ certainty: { start: "high", imprecision: -1, upgrades: { largeEffect: 1 }, rationale: "见正文" } }), rct));
  assert.deepEqual(upgraded.map((issue) => issue.code), ["claim-certainty-design"]);
  assert.match(upgraded[0].message, /rates up for largeEffect \+1, but every source it cites is a randomized trial\. GRADE rates up observational evidence, so the upgrade was not counted\./);

  const cohort = { [SOURCE]: "observational" };
  const highStart = appraisalIssues(judge(directClaim({ certainty: { start: "high", label: "high" } }), cohort));
  assert.deepEqual(highStart.map((issue) => issue.code), ["claim-certainty-design"]);
  assert.match(highStart[0].message, /record riskOfBias\.tool "robins-i"/);
  // Assessed with ROBINS-I, a high start is GRADE guideline 18, not an error.
  const robins = directClaim({
    certainty: { start: "high", riskOfBias: -2, rationale: "ROBINS-I 严重", label: "low" },
    riskOfBias: { tool: "ROBINS-I", domains: { D1: "serious", D2: "low", D3: "low", D4: "low", D5: "low", D6: "low" }, overall: "serious" },
  });
  assert.deepEqual(appraisalIssues(judge(robins, cohort)), []);
  // No stamped type at all: nothing to check the start against.
  assert.deepEqual(appraisalIssues(judge(directClaim({ certainty: { start: "low", label: "low" } }))), []);
});

test("a malformed certainty is named precisely, and a bare level is shown without being reproached", () => {
  const schema = (/** @type {unknown} */ certainty) => claimAppraisalFindings(directClaim({ certainty }), { label: "claims[0]" }).certaintySchema;
  assert.deepEqual(schema("moderate"), [], "a stated level with no parts");
  assert.deepEqual(claimAppraisal(directClaim({ certainty: "moderate" }))?.certainty, [{ outcome: null, stated: "moderate", computed: null, agrees: null, upgradesCounted: false }]);
  assert.match(schema("fairly good")[0], /^claims\[0\]\.certainty is "fairly good", which is not a certainty level\./);
  assert.match(schema({ start: "medium" })[0], /^claims\[0\]\.certainty\.start is "medium"; use "high"/);
  assert.match(schema({ start: "high", imprecision: "a lot" })[0], /^claims\[0\]\.certainty\.imprecision is "a lot"; a move down is 0, -1 \(serious\) or -2 \(very serious\)\./);
  assert.match(schema({ start: "high", label: "B" })[0], /^claims\[0\]\.certainty\.label is "B"; use high, moderate, low or very-low\./);
  assert.deepEqual(schema({ start: "high", imprecision: -1, indirectness: "serious" }), [
    "claims[0].certainty moves the rating for indirectness, imprecision with no rationale. Each step GRADE takes carries its reason under rationale.<domain>; the number is only its size.",
  ]);
  assert.deepEqual(schema([{ start: "high", outcome: "大出血" }, { start: "high" }]), [
    "claims[0].certainty[1] names no outcome. When a claim rates more than one outcome, each certainty names the outcome it rates.",
  ]);
  assert.deepEqual(schema([]), ["claims[0].certainty is an empty list; give one certainty per outcome the claim rates, or leave the field out."]);
});

test("a risk-of-bias overall its domains do not give is advice, on the claim and on each supporting source", () => {
  const verdict = judge(directClaim({ riskOfBias: { tool: "RoB 2", domains: { D1: "low", D2: "some concerns", D3: "low", D4: "low", D5: "low" }, overall: "low" } }));
  const issues = appraisalIssues(verdict);
  assert.deepEqual(issues.map((issue) => [issue.code, issue.tier]), [["claim-rob-overall", "advisory"]]);
  assert.match(issues[0].message, /^CLM-001\.riskOfBias\.overall is "low", but its domains give "some-concerns"\. RoB 2 is low only when every domain is low/);
  assert.equal(verdict.status, "verified");

  const synthesized = {
    claimType: "synthesized",
    supportingSources: [
      { artifactPath: SOURCE, riskOfBias: { tool: "rob2", domains: { D1: "low", D2: "low", D3: "low", D4: "low", D5: "high" }, overall: "some concerns" } },
      { artifactPath: SOURCE, riskOfBias: { tool: "rob2", domains: ["low"] } },
    ],
  };
  const found = claimAppraisalFindings(synthesized, { label: "claims[4]" });
  assert.equal(found.robOverall.length, 1);
  assert.match(found.robOverall[0], /^claims\[4\]\.supportingSources\[0\]\.riskOfBias\.overall is "some-concerns", but its domains give "high"\./);
  assert.match(found.robSchema[0], /^claims\[4\]\.supportingSources\[1\]\.riskOfBias\.domains lists 1 judgement\(s\) with no domain/, "a bare judgement in a list rates no domain");
  const view = claimAppraisal(synthesized)?.riskOfBias;
  assert.deepEqual(view?.map((entry) => [entry.source, entry.toolName, entry.stated, entry.computed, entry.agrees]), [
    [0, "RoB 2", "some-concerns", "high", false],
    [1, "RoB 2", null, null, null],
  ]);
  assert.equal(view?.[1].recomputed, false, "an unreadable domain list is not judged");
});

test("a malformed risk-of-bias record is named precisely", () => {
  const schema = (/** @type {unknown} */ riskOfBias) => claimAppraisalFindings(directClaim({ riskOfBias }), { label: "claims[0]" }).robSchema;
  assert.match(schema("low")[0], /^claims\[0\]\.riskOfBias must be an object: \{ tool, domains/);
  assert.match(schema({ domains: { D1: "low" } })[0], /^claims\[0\]\.riskOfBias names no tool\./);
  assert.match(schema({ tool: "RoB 2", domains: { D1: "moderate" } })[0], /D1 "moderate" off RoB 2's scale; RoB 2 rates each domain low \/ some-concerns \/ high\./);
  assert.match(schema({ tool: "RoB 2", domains: { D1: "low" }, overall: "fine" })[0], /^claims\[0\]\.riskOfBias\.overall is "fine"; RoB 2's overall judgement is low \/ some-concerns \/ high\./);
  assert.match(schema({ tool: "AMSTAR 2", domains: { protocol: "yes" } })[0], /"protocol", which is not an AMSTAR 2 item number/);
  assert.match(schema({ tool: "RoB 2", domains: {}, criticalItems: [2] })[0], /criticalItems belongs to AMSTAR 2, not RoB 2/);
  assert.deepEqual(schema({ tool: "Jadad", domains: { randomization: 2 }, overall: 4 }), [], "a tool we do not recompute has its own scale");
});

/* ------------------------------------------------------ package level ---- */

/**
 * The server suite's small valid package (clinicalEvidenceQuality.test.mjs), rebuilt here.
 * @returns {{ reportText: string, matrix: { schemaVersion: number, claims: Record<string, any>[] }, briefText: string, sourceArtifacts: Record<string, string> }}
 */
function validPackage() {
  /** @param {number} index @param {string} domain */
  const claim = (index, domain) => ({
    claimId: `CLM-00${index}`,
    claim: `Material clinical proposition ${index}`,
    sourceUrl: `https://${domain}/evidence/${index}`,
    sourceTitle: `Authoritative source ${index}`,
    artifactPath: index % 2 ? ".evimed-sources/a/page.md" : ".evimed-sources/b/fulltext.md",
    identifier: `DOC-${index}`,
    accessLevel: index % 2 ? "official_page" : "full_text",
    supportQuote: `This directly observed source passage supports material clinical proposition number ${index}.`,
    applicability: "The population and emergency-care setting match the question.",
    uncertainty: "Indirectness remains for individual diagnosis.",
    referenceNumber: index,
  });
  const claims = [claim(1, "professional.heart.org"), claim(2, "www.cochrane.org"), claim(3, "professional.heart.org"), claim(4, "www.cochrane.org")];
  const reportText = [
    "# 急性胸部压迫感与速效救心丸的证据边界", "",
    "## 摘要", "急性胸部压迫感需要优先排除时间敏感的心血管急症。".repeat(12), "",
    "## 临床问题与鉴别", "症状不能单独完成病因归类。[1] <!-- claim:CLM-001 --> 诊断需要规范评估。[2] <!-- claim:CLM-002 -->", "",
    "## 检索与方法", "证据来源覆盖临床指南、系统评价与官方资料，按预设资格标准筛选，并逐条核对主张与来源原文。", "",
    "## 结果", "纳入证据共同支持安全优先、分层评估的处置路径，症状描述只能调整先验判断。", "",
    "## 药物角色", "速效救心丸不应延误急诊评估。[3] <!-- claim:CLM-003 --> 证据范围应被明确限定。[4] <!-- claim:CLM-004 -->", "",
    "## 讨论", "指南、诊断研究与官方资料方向一致而层级不同，个体决策仍需结合现场评估。", "",
    "## 科学局限", "现有证据对个体诊断存在间接性，且不同地区急救路径存在适用性差异。".repeat(8), "",
    "## 结论与实际处置", `速效救心丸不应延误急诊评估。[3] <!-- claim:CLM-003 --> ${"结论必须同时保留临床紧迫性、适用边界和不确定性。".repeat(30)}`, "",
    "## 参考文献",
    ...claims.map((item) => `${item.referenceNumber}. ${item.sourceTitle}. ${item.sourceUrl}`),
  ].join("\n");
  return {
    reportText,
    matrix: { schemaVersion: 1, claims },
    briefText: "胸部压迫感与速效救心丸应如何处置？",
    sourceArtifacts: {
      ".evimed-sources/a/page.md": claims.filter((item) => item.artifactPath.endsWith("page.md")).map((item) => item.supportQuote).join("\n"),
      ".evimed-sources/b/fulltext.md": claims.filter((item) => item.artifactPath.endsWith("fulltext.md")).map((item) => item.supportQuote).join("\n"),
    },
  };
}

test("in a whole package the appraisal findings are notices: nothing blocks, nothing is withheld", () => {
  const clean = validateClinicalEvidencePackage(validPackage());
  assert.deepEqual(clean.findings, [], JSON.stringify(clean.findings));

  const input = validPackage();
  input.matrix.claims[0] = {
    ...input.matrix.claims[0],
    pico: { population: "急性胸痛患者", intervention: "规范评估", outcomes: ["漏诊"] },
    certainty: { start: "high", indirectness: -1, rationale: { indirectness: "人群间接" }, label: "high" },
    riskOfBias: { tool: "QUADAS-2", domains: { selection: "low", index: "low", reference: "unclear", flow: "low" }, overall: "low" },
  };
  const verdict = validateClinicalEvidencePackage(input);
  assert.deepEqual(verdict.findings.map((finding) => [finding.check, finding.tier]), [
    ["claim-certainty-arithmetic", "advisory"],
    ["claim-rob-overall", "advisory"],
  ]);
  assert.deepEqual(verdict.blockingIssues, [], "advice never becomes a must-fix");
  assert.deepEqual(verdict.safetyIssues, []);

  // The registry's verdict: `ok` stands, the notices ride along with their ids.
  const files = new Map([["clinical-evidence-report.md", input.reportText], ["clinical-evidence-matrix.json", JSON.stringify(input.matrix)]]);
  const gate = runGate({ contractKind: "clinical-evidence-report", files, expectedOutputs: [], briefText: input.briefText, sourceArtifacts: input.sourceArtifacts });
  assert.equal(gate.ok, true);
  assert.equal(gate.errorCode, null);
  const notices = gate.issues.filter((issue) => APPRAISAL_CHECKS.includes(String(issue.check)));
  assert.deepEqual(notices.map((issue) => [issue.check, issue.severity, issue.code]), [
    ["claim-certainty-arithmetic", "advisory", "clinical_evidence_notice"],
    ["claim-rob-overall", "advisory", "clinical_evidence_notice"],
  ]);
});

test("the gate reads the stamped design it is handed, through the registry", () => {
  const input = validPackage();
  input.matrix.claims[1] = { ...input.matrix.claims[1], certainty: { start: "low", label: "low" } };
  const files = new Map([["clinical-evidence-report.md", input.reportText], ["clinical-evidence-matrix.json", JSON.stringify(input.matrix)]]);
  /** @param {Record<string, string>} [sourceTypes] */
  const design = (sourceTypes) => runGate({ contractKind: "clinical-evidence-report", files, expectedOutputs: [], briefText: input.briefText, sourceArtifacts: input.sourceArtifacts, sourceTypes })
    .issues.filter((issue) => issue.check === "claim-certainty-design").length;
  assert.equal(design(), 0, "with no stamped type the start is the author's to state");
  assert.equal(design({ ".evimed-sources/b/fulltext.md": "rct" }), 1);
});

// The one real clinical package in the repository — the 2026-09-08 EMPA-KIDNEY
// acceptance run — carries the PICO shape the skill taught before this module
// on all of its claims. Its verdict is the regression this change has to leave
// alone: identical findings with that PICO present or stripped, and none of
// them from an appraisal check.
test("a real delivered package, with the PICO shape taught before, is judged exactly as it was", async () => {
  const base = new URL("../../../evals/clinical-review-quality/results/2026-09-08-review-001-empa-kidney-report-family/deliverable/deliverables/empa-kidney-durability/", import.meta.url);
  const reportText = await readFile(new URL("clinical-evidence-report.md", base), "utf8");
  const matrix = JSON.parse(await readFile(new URL("clinical-evidence-matrix.json", base), "utf8"));
  const withPico = matrix.claims.filter((/** @type {any} */ claim) => claim.pico);
  assert.ok(withPico.length >= 40, `only ${withPico.length} claims carry a PICO — the fixture is not the one this test is about`);

  /** @type {Record<string, string>} */
  const sourceArtifacts = {};
  for (const claim of matrix.claims) {
    for (const source of claim.claimType === "synthesized" ? claim.supportingSources ?? [] : [claim]) {
      if (typeof source.artifactPath === "string") {
        sourceArtifacts[source.artifactPath] = `${sourceArtifacts[source.artifactPath] ?? ""}\n${String(source.supportQuote ?? "").replace(/\s*…\s*/g, "\n")}`;
      }
    }
  }
  const stripped = { ...matrix, claims: matrix.claims.map((/** @type {any} */ claim) => { const { pico: _pico, picoMatch: _picoMatch, ...rest } = claim; return rest; }) };
  const before = validateClinicalEvidencePackage({ reportText, matrix: stripped, sourceArtifacts });
  const after = validateClinicalEvidencePackage({ reportText, matrix, sourceArtifacts });
  assert.ok(after.findings.length > 0, "the replay reached the checks");
  assert.deepEqual(after.findings, before.findings);
  assert.deepEqual(after.findings.filter((finding) => APPRAISAL_CHECKS.includes(String(finding.check))), []);
  for (const claim of matrix.claims) {
    assert.deepEqual(
      validateEvidenceClaim({ claim, claims: matrix.claims, sourceArtifacts }).issues.filter((issue) => APPRAISAL_CHECKS.includes(issue.code)),
      [],
      `${claim.claimId} raised an appraisal finding on the taught PICO shape`,
    );
  }
});

/* ------------------------------------------------------ source types ----- */

test("the stamped type sits beside the capture, and only a type the table knows is read from it", () => {
  assert.equal(sourceTypeSidecarPath(".evimed-sources/PMC7614055/3629ce/fulltext.md"), ".evimed-sources/PMC7614055/3629ce/source.json");
  assert.equal(sourceTypeSidecarPath(".evimed-sources/a/../../etc/passwd"), null);
  assert.equal(sourceTypeSidecarPath("deliverables/x/report.md"), null);
  assert.equal(sourceTypeSidecarPath(".evimed-sources/fulltext.md"), null, "a capture is a directory");
  assert.equal(sourceTypeOfSidecar('{"schemaVersion":1,"sourceType":"rct","sourceId":"PMC1"}\n'), "rct");
  assert.equal(sourceTypeOfSidecar('{"sourceType":"randomised"}'), null);
  assert.equal(sourceTypeOfSidecar("not json"), null);
  assert.equal(sourceTypeOfSidecar(null), null);
});
