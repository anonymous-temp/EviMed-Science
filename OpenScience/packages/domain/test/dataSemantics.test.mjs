/**
 * The dataset-semantics contract (plan 2026-10-02 §11.3 N03): facts carry a
 * basis and a stronger basis is never overwritten by a weaker one; a write is
 * checked item by item; source versions rebind without losing the old one; a
 * transformation says what changed; a check report keeps names and counts and
 * nothing a person's record said.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  DATA_CHECK_FAMILIES,
  DATA_CHECK_NOT_CHECKED_REASON_IDS,
  DATA_CHECK_OUTCOMES,
  DATA_DRIFT_BOUNDS,
  DATA_SEMANTICS_LIMITS,
  DATA_VALUE_SOURCES,
  SEMANTIC_BASES,
  VCR_COLUMN_SOURCES,
  VCR_COLUMN_SOURCE_EXPORT,
  VCR_MISSING_REASONS,
  applyCheckReport,
  applySemanticsPatch,
  applyTransformation,
  emptySemanticsAsset,
  fitAsset,
  interpretationOf,
  joinId,
  mergeFact,
  normalizeBinding,
  normalizeCheckReport,
  normalizeTransformation,
  semanticFacts,
  semanticsListing,
  summarizeSemantics,
} from "../index.mjs";

const T0 = "2026-10-04T08:00:00.000Z";
const T1 = "2026-10-05T08:00:00.000Z";
const T2 = "2026-10-06T08:00:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const inferred = { basis: "model_inferred", inferredFrom: ["column name creatinine_umol_l", "values 40-400 in data-profile.json"] };
const confirmed = (/** @type {string} */ statement) => ({ basis: "researcher_confirmed", statement });

/** @param {any} asset @param {string} target */
const factAt = (asset, target) => semanticFacts(asset).find((item) => item.target === target)?.fact;

test("the value sources are the 虚拟临研 column sources, not a parallel list, and every one has an export spelling", () => {
  assert.equal(DATA_VALUE_SOURCES, VCR_COLUMN_SOURCES);
  for (const source of DATA_VALUE_SOURCES) assert.ok(/** @type {Record<string, unknown>} */ (VCR_COLUMN_SOURCE_EXPORT)[source], source);
  // The three bases answer who vouches for a meaning; none of them is a value source.
  for (const basis of SEMANTIC_BASES) assert.equal(DATA_VALUE_SOURCES.includes(basis), false, basis);
});

test("every check outcome belongs to a family, and every not-checked reason is spoken in Chinese", () => {
  for (const [id, meta] of Object.entries(DATA_CHECK_OUTCOMES)) {
    assert.ok(DATA_CHECK_FAMILIES.includes(meta.family), id);
    assert.ok(["attention", "information"].includes(meta.severity), id);
    assert.ok(meta.zh.length >= 4, id);
  }
  assert.equal(new Set(DATA_CHECK_NOT_CHECKED_REASON_IDS).size, DATA_CHECK_NOT_CHECKED_REASON_IDS.length);
  // Each of the named failure classes of the plan has an outcome of its own.
  for (const id of ["duplicate_exact", "duplicate_conflicting", "join_cardinality_violation", "denominator_changed", "temporal_leakage",
    "type_changed", "unit_changed", "column_renamed_candidate", "new_codes"]) assert.ok(id in DATA_CHECK_OUTCOMES, id);
});

test("a stronger basis is never overwritten by a weaker one, and the disagreement stays visible", () => {
  /** @param {any} value @param {string} basis @param {string} at */
  const fact = (value, basis, at) => ({ value, basis, via: "conversation", at });
  // Nothing there yet.
  assert.equal(mergeFact(undefined, fact("mmol/L", "model_inferred", T0)).outcome, "applied");
  // The same value from a stronger basis upgrades it in place.
  const upgraded = mergeFact(fact("mmol/L", "model_inferred", T0), fact("mmol/L", "researcher_confirmed", T1));
  assert.equal(upgraded.outcome, "upgraded");
  assert.equal(upgraded.fact.basis, "researcher_confirmed");
  // The same value from a weaker one changes nothing.
  assert.equal(mergeFact(fact("mmol/L", "researcher_confirmed", T0), fact("mmol/L", "model_inferred", T1)).outcome, "unchanged");
  // A later inference that disagrees with a confirmed fact is kept beside it, not over it.
  const kept = mergeFact(fact("mmol/L", "researcher_confirmed", T0), { ...fact("mg/dL", "model_inferred", T1), inferredFrom: ["header text"] });
  assert.equal(kept.outcome, "kept_stronger");
  assert.equal(kept.keptBasis, "researcher_confirmed");
  assert.equal(kept.fact.value, "mmol/L");
  assert.deepEqual(kept.fact.contested?.map((entry) => entry.value), ["mg/dL"]);
  // A dictionary does not overrule the researcher either, but the researcher overrules a dictionary.
  assert.equal(mergeFact(fact("a", "researcher_confirmed", T0), fact("b", "dictionary_stated", T1)).outcome, "kept_stronger");
  const over = mergeFact(fact("a", "dictionary_stated", T0), fact("b", "researcher_confirmed", T1));
  assert.equal(over.outcome, "applied");
  assert.deepEqual(over.fact.supersedes, { value: "a", basis: "dictionary_stated", at: T0 });
  // A researcher's own correction replaces their earlier word, and says it was a correction.
  assert.equal(mergeFact(fact("a", "researcher_confirmed", T0), fact("b", "researcher_confirmed", T1)).outcome, "corrected");
  // A dictionary beats an inference; an inference replaces an inference.
  assert.equal(mergeFact(fact("a", "model_inferred", T0), fact("b", "dictionary_stated", T1)).outcome, "applied");
  assert.equal(mergeFact(fact("a", "model_inferred", T0), fact("b", "model_inferred", T1)).outcome, "applied");
  // The contested list keeps three, newest last, without duplicates.
  /** @type {any} */
  let current = fact("x", "researcher_confirmed", T0);
  for (const value of ["1", "2", "3", "4", "3"]) current = mergeFact(current, fact(value, "model_inferred", T1)).fact;
  assert.deepEqual(current.contested?.map((/** @type {any} */ entry) => entry.value), ["2", "4", "3"]);
});

test("a writer's correction becomes a confirmed fact, and a later inference does not overwrite it (acceptance 5)", () => {
  const first = applySemanticsPatch(null, {
    datasetId: "visits", ...inferred,
    variables: [{ table: "visits.csv", name: "creatinine", unit: "mg/dL", type: "number" }],
  }, { now: T0, via: "conversation" });
  assert.deepEqual(first.issues, []);
  assert.equal(factAt(first.asset, "variable:visits.csv/creatinine:unit")?.basis, "model_inferred");

  const corrected = applySemanticsPatch(first.asset, {
    ...confirmed("这一列的单位是 mmol/L"),
    variables: [{ table: "visits.csv", name: "creatinine", unit: "mmol/L" }],
  }, { now: T1, via: "conversation" });
  const unit = factAt(corrected.asset, "variable:visits.csv/creatinine:unit");
  assert.equal(unit?.value, "mmol/L");
  assert.equal(unit?.basis, "researcher_confirmed");
  assert.equal(unit?.statement, "这一列的单位是 mmol/L");
  assert.deepEqual(unit?.supersedes, { value: "mg/dL", basis: "model_inferred", at: T0 });
  // The type the model inferred is still the model's, untouched by the correction of the unit.
  assert.equal(factAt(corrected.asset, "variable:visits.csv/creatinine:type")?.basis, "model_inferred");

  // Next week's run infers mg/dL again from a header: the confirmed fact stands and the outcome is named.
  const later = applySemanticsPatch(corrected.asset, {
    ...inferred, variables: [{ table: "visits.csv", name: "creatinine", unit: "mg/dL" }],
  }, { now: T2, via: "conversation" });
  assert.deepEqual(later.outcomes.map((outcome) => outcome.outcome), ["kept_stronger"]);
  assert.equal(factAt(later.asset, "variable:visits.csv/creatinine:unit")?.value, "mmol/L");
  assert.equal(factAt(later.asset, "variable:visits.csv/creatinine:unit")?.contested?.[0].value, "mg/dL");
  assert.equal(later.changed, true);
});

test("a write must say who vouches: the researcher's words, the dictionary file, or what an inference was read from", () => {
  const variables = [{ table: "visits.csv", name: "sbp", unit: "mmHg" }];
  /** @param {any} patch @param {string} [via] */
  const run = (patch, via = "conversation") => applySemanticsPatch(null, { datasetId: "visits", title: "Visits", variables, ...patch }, { now: T0, via });
  // No basis at all: the title still lands, the meaning does not, and the refusal names the field.
  const none = run({});
  assert.equal(none.asset.title, "Visits");
  assert.deepEqual(semanticFacts(none.asset), []);
  assert.equal(none.issues[0].code, "provenance_invalid");
  // A confirmation without the researcher's words is refused in the conversation, and fine from the page.
  assert.equal(run({ basis: "researcher_confirmed" }).issues[0].code, "provenance_invalid");
  assert.deepEqual(run({ basis: "researcher_confirmed" }, "page").issues, []);
  assert.equal(factAt(run({ basis: "researcher_confirmed" }, "page").asset, "variable:visits.csv/sbp:unit")?.via, "page");
  // A dictionary-stated fact names the file, with its hash when the tool computed one.
  assert.equal(run({ basis: "dictionary_stated" }).issues[0].code, "provenance_invalid");
  assert.equal(run({ basis: "dictionary_stated", statedIn: "../secret.csv" }).issues[0].code, "provenance_invalid");
  const stated = run({ basis: "dictionary_stated", statedIn: { path: "data/dictionary.csv", sha256: HASH_A } });
  assert.deepEqual(factAt(stated.asset, "variable:visits.csv/sbp:unit")?.statedIn, { path: "data/dictionary.csv", sha256: HASH_A });
  // An inference names what it was read from.
  assert.equal(run({ basis: "model_inferred" }).issues[0].code, "provenance_invalid");
  assert.equal(run({ basis: "model_inferred", inferredFrom: [] }).issues[0].code, "provenance_invalid");
  assert.deepEqual(run({ basis: "model_inferred", inferredFrom: "the column header" }).issues, []);
  assert.equal(run({ basis: "guessed", inferredFrom: "x" }).issues[0].code, "provenance_invalid");
});

test("a bad item is refused by name and every other item is written", () => {
  const result = applySemanticsPatch(null, {
    datasetId: "visits", ...inferred, population: "Adults admitted with sepsis, 2022-2024",
    timeWindow: { start: "2022-01-01", end: "2024-12-31" },
    tables: [
      { name: "visits.csv", observationUnit: "one row per patient visit", subjectKey: ["patient_id"], observationKey: ["patient_id", "visit_no"] },
      { name: "bad", observationKey: "patient_id" },
      { name: "x.csv", surprise: 1 },
    ],
    variables: [
      { table: "visits.csv", name: "sbp", unit: "mmHg", type: "number", range: [40, 300], measuredAt: { column: "visit_date" }, valueSource: "observed" },
      { table: "visits.csv", name: "sex", allowedValues: ["M", { code: "F", label: "Female" }, "M"], missingness: { tokens: ["NA", "-"], reason: "not_recorded" } },
      { table: "visits.csv", name: "age", unit: "years", type: "decimal" },
      { table: "visits.csv", name: "bmi", valueSource: "synthetic" },
      { table: "visits.csv", name: "w", missingness: { tokens: [], reason: "forgot" } },
    ],
    joins: [{ left: { table: "visits.csv", columns: ["patient_id"] }, right: { table: "patients.csv", columns: ["patient_id"] }, cardinality: "many_to_one" },
      { left: { table: "visits.csv", columns: ["a", "b"] }, right: { table: "patients.csv", columns: ["a"] }, cardinality: "one_to_one" },
      { left: { table: "visits.csv", columns: ["patient_id"] }, right: { table: "patients.csv", columns: ["patient_id"] } }],
  }, { now: T0, via: "conversation" });
  const refused = result.issues.map((issue) => `${issue.path}:${issue.code}`).sort();
  assert.deepEqual(refused, [
    "joins:join_invalid",
    `join:${joinId({ table: "visits.csv", columns: ["patient_id"] }, { table: "patients.csv", columns: ["patient_id"] })}:cardinality:cardinality_invalid`,
    "table:bad:observationKey:observationKey_invalid",
    "tables.surprise:field_unknown",
    "variable:visits.csv/age:type:type_invalid",
    "variable:visits.csv/bmi:valueSource:valueSource_invalid",
    "variable:visits.csv/w:missingness:missingness_invalid",
  ].sort());
  // Nothing was created for an item whose every value was refused.
  assert.deepEqual(result.asset.tables.map((table) => table.name), ["visits.csv"]);
  const targets = new Set(semanticFacts(result.asset).map((item) => item.target));
  for (const written of ["population", "timeWindow", "table:visits.csv:observationUnit", "table:visits.csv:subjectKey", "table:visits.csv:observationKey",
    "variable:visits.csv/sbp:unit", "variable:visits.csv/sbp:range", "variable:visits.csv/sbp:measuredAt", "variable:visits.csv/sbp:valueSource",
    "variable:visits.csv/sex:allowedValues", "variable:visits.csv/sex:missingness", "variable:visits.csv/age:unit",
    `join:${joinId({ table: "visits.csv", columns: ["patient_id"] }, { table: "patients.csv", columns: ["patient_id"] })}:cardinality`]) {
    assert.ok(targets.has(written), written);
  }
  assert.deepEqual(factAt(result.asset, "variable:visits.csv/sex:allowedValues")?.value, [{ code: "M" }, { code: "F", label: "Female" }]);
  assert.equal(factAt(result.asset, "variable:visits.csv/sbp:measuredAt")?.value.timeKind, "occurred_at");
  // The vocabularies of missing reasons and value sources are the 虚拟临研 ones.
  for (const reason of VCR_MISSING_REASONS) {
    assert.deepEqual(applySemanticsPatch(null, { datasetId: "d", ...inferred, variables: [{ table: "t", name: "c", missingness: { tokens: [], reason } }] }, { now: T0, via: "conversation" }).issues, []);
  }
  // `unit: null` is a statement (no unit), distinct from never having said.
  const noUnit = applySemanticsPatch(null, { datasetId: "d", ...inferred, variables: [{ table: "t", name: "c", unit: null }] }, { now: T0, via: "conversation" });
  assert.equal(factAt(noUnit.asset, "variable:t/c:unit")?.value, null);
  assert.equal(applySemanticsPatch(null, { datasetId: "Not A Slug", ...inferred }, { now: T0, via: "conversation" }).issues[0].code, "dataset_invalid");
});

test("rewriting the same meaning changes nothing, and the summary counts facts by who vouches for them", () => {
  const patch = { datasetId: "d", ...inferred, variables: [{ table: "t.csv", name: "c", unit: "mg", type: "number" }] };
  const once = applySemanticsPatch(null, patch, { now: T0, via: "conversation" });
  const twice = applySemanticsPatch(once.asset, patch, { now: T1, via: "conversation" });
  assert.equal(twice.changed, false);
  assert.equal(twice.asset.updatedAt, T0);
  assert.deepEqual(twice.outcomes.map((outcome) => outcome.outcome), ["unchanged", "unchanged"]);
  const mixed = applySemanticsPatch(twice.asset, { ...confirmed("单位是 mg"), variables: [{ table: "t.csv", name: "c", unit: "mg" }] }, { now: T2, via: "conversation" });
  const summary = summarizeSemantics(mixed.asset);
  assert.deepEqual([summary.researcherConfirmed, summary.dictionaryStated, summary.modelInferred, summary.facts], [1, 0, 1, 2]);
  assert.equal(semanticsListing(mixed.asset).summary.variables, 1);
});

test("a table's exact source version rebinds without losing the one it replaced", () => {
  const column = { name: "sbp", type: "number", missing: 2, distinct: 40, numeric: { n: 98, min: 70, p25: 110, median: 125, p75: 140, max: 220, mean: 126 } };
  const bind = (/** @type {string} */ sha256, /** @type {string} */ now, /** @type {string} */ path = "data/visits.csv", rows = 100) =>
    ({ bindings: [{ table: "visits.csv", path, sha256, bytes: 2048, rows, columns: [column] }] });
  const first = applySemanticsPatch(null, { datasetId: "visits", ...bind(HASH_A, T0) }, { now: T0, via: "conversation" });
  assert.deepEqual(first.outcomes, [{ target: "binding:visits.csv", outcome: "bound" }]);
  assert.equal(first.asset.tables[0].name, "visits.csv");
  const same = applySemanticsPatch(first.asset, bind(HASH_A, T1), { now: T1, via: "conversation" });
  assert.deepEqual(same.outcomes, [{ target: "binding:visits.csv", outcome: "unchanged" }]);
  assert.equal(same.changed, false);
  const moved = applySemanticsPatch(first.asset, bind(HASH_A, T1, "knowledge-base/visits.csv"), { now: T1, via: "conversation" });
  assert.equal(moved.asset.bindings[0].path, "knowledge-base/visits.csv");
  const second = applySemanticsPatch(first.asset, bind(HASH_B, T1, "data/visits.csv", 120), { now: T1, via: "conversation" });
  assert.deepEqual(second.outcomes, [{ target: "binding:visits.csv", outcome: "rebound" }]);
  assert.equal(second.asset.bindings[0].sha256, HASH_B);
  assert.deepEqual(second.asset.bindingHistory, [{ table: "visits.csv", sha256: HASH_A, rows: 100, boundAt: T0, supersededAt: T1 }]);
  // The page may state meaning; it may not state which bytes a meaning came from.
  const fromPage = applySemanticsPatch(first.asset, bind(HASH_B, T2), { now: T2, via: "page" });
  assert.equal(fromPage.issues[0].code, "bindings_not_allowed");
  assert.equal(fromPage.asset.bindings[0].sha256, HASH_A);
});

test("a binding keeps aggregates only: no summary under the small-cell floor, no long vocabulary, no malformed hash", () => {
  /** The one column profile a binding of this shape keeps. @param {any} extra @returns {any} */
  const profile = (extra) => {
    const result = normalizeBinding({ table: "t.csv", path: "t.csv", sha256: HASH_A, bytes: 1, rows: 5, columns: [{ name: "c", type: "number", missing: 0, distinct: 5, ...extra }] }, T0);
    assert.ok("binding" in result, JSON.stringify(result));
    return result.binding.columns[0];
  };
  assert.equal(profile({ numeric: { n: DATA_DRIFT_BOUNDS.minCell - 1, min: 1, p25: 2, median: 3, p75: 4, max: 5, mean: 3 } }).numeric, undefined);
  assert.equal(profile({ numeric: { n: DATA_DRIFT_BOUNDS.minCell, min: 1, p25: 2, median: 3, p75: 4, max: 5, mean: 3 } }).numeric.n, DATA_DRIFT_BOUNDS.minCell);
  const many = profile({ type: "text", codes: Array.from({ length: DATA_DRIFT_BOUNDS.vocabularyMax + 1 }, (_, index) => `c${index}`) });
  assert.equal(many.codes, undefined);
  assert.equal(many.codesWithheld, "high_cardinality");
  assert.equal(profile({ codes: ["M", "F"], type: "text" }).codes.length, 2);
  assert.ok("problem" in normalizeBinding({ table: "t.csv", path: "../t.csv", sha256: HASH_A, bytes: 1, rows: 1, columns: [] }, T0));
  assert.ok("problem" in normalizeBinding({ table: "t.csv", path: "t.csv", sha256: "xyz", bytes: 1, rows: 1, columns: [] }, T0));
  assert.ok("problem" in normalizeBinding({ table: "t.csv", path: "t.csv", sha256: HASH_A, bytes: 1, rows: 1, columns: [{ name: "c", type: "number", missing: 0, row: [1, 2] }] }, T0));
});

test("an asset too big for a ledger document loses its profiles first and is refused by name after that", () => {
  const asset = emptySemanticsAsset("big", T0);
  const columns = Array.from({ length: 300 }, (_, index) => ({ name: `column_${index}`, type: "number", missing: 1, distinct: 9,
    numeric: { n: 500, min: 1.123456789, p25: 2.123456789, median: 3.123456789, p75: 4.123456789, max: 5.123456789, mean: 3.123456789 } }));
  asset.bindings = Array.from({ length: 12 }, (_, index) => ({ table: `t${index}.csv`, path: `t${index}.csv`, sha256: HASH_A, bytes: 1, rows: 1, boundAt: T0, columns }));
  const fitted = fitAsset(asset);
  assert.ok(fitted);
  assert.equal(fitted.trimmed, true);
  assert.equal(fitted.asset.bindings[0].profileTrimmed, true);
  assert.equal(fitted.asset.bindings[0].columns[0].numeric, undefined);
  const hopeless = emptySemanticsAsset("huge", T0);
  hopeless.title = "x".repeat(DATA_SEMANTICS_LIMITS.assetBytes + 1);
  assert.equal(fitAsset(hopeless), null);
});

test("a transformation says whether it is new, the same, or what changed — and a rebound is not a change", () => {
  const asset = emptySemanticsAsset("visits", T0);
  /** @param {any} extra */
  const record = (extra = {}) => {
    const normalized = normalizeTransformation({
      name: "egfr", kind: "derive", description: "CKD-EPI 2021", inputs: [{ table: "visits.csv", columns: ["creatinine", "age", "sex"] }],
      output: { table: "visits.csv", column: "egfr" }, code: { path: "analysis/egfr.py", sha256: HASH_A }, parameters: { equation: "ckd-epi-2021" },
      boundTo: [{ table: "visits.csv", sha256: HASH_A }], ...extra,
    });
    assert.ok("transformation" in normalized, JSON.stringify(normalized));
    return normalized.transformation;
  };
  assert.deepEqual(applyTransformation(asset, record(), T0), { status: "new", version: 1, changed: [], rebound: false });
  assert.deepEqual(applyTransformation(asset, record(), T1), { status: "same", version: 1, changed: [], rebound: false });
  // The same transformation over a new delivery of the data: the definition did not change.
  assert.deepEqual(applyTransformation(asset, record({ boundTo: [{ table: "visits.csv", sha256: HASH_B }] }), T1), { status: "same", version: 1, changed: [], rebound: true });
  assert.equal(asset.transformations[0].boundTo?.[0].sha256, HASH_B);
  // New code, new parameters: the next version, and the fields that moved.
  const changed = applyTransformation(asset, record({ code: { path: "analysis/egfr.py", sha256: HASH_B }, parameters: { equation: "mdrd" }, boundTo: [{ table: "visits.csv", sha256: HASH_B }] }), T2);
  assert.deepEqual(changed, { status: "changed", version: 2, changed: ["code", "parameters"], rebound: false });
  assert.equal(asset.transformations[0].history.length, 2);
  assert.equal(asset.transformations.length, 1);
  assert.ok("problem" in normalizeTransformation({ name: "bad name", kind: "derive", inputs: [{ table: "t" }] }));
  assert.ok("problem" in normalizeTransformation({ name: "x", kind: "magic", inputs: [{ table: "t" }] }));
  assert.ok("problem" in normalizeTransformation({ name: "x", kind: "filter", inputs: [] }));
  assert.ok("problem" in normalizeTransformation({ name: "x", kind: "filter", inputs: [{ table: "t" }], code: { path: "/etc/passwd", sha256: HASH_A } }));
  assert.ok("problem" in normalizeTransformation({ name: "x", kind: "filter", inputs: [{ table: "t" }], extra: 1 }));
});

test("a check report keeps outcome names, counts and row numbers — never a value, a key or an unknown outcome", () => {
  const report = normalizeCheckReport({
    checkedAt: T0, bindings: [{ table: "visits.csv", sha256: HASH_A }, { table: "bad", sha256: "nope" }], interpretation: HASH_B,
    findings: [
      { outcome: "duplicate_exact", subject: { table: "visits.csv", column: "patient_id,visit_no", secret: "x" }, count: 3,
        rows: [4, 5, 0, -2, 1.5, ...Array.from({ length: 40 }, (_, index) => index + 10)], detail: { groups: 3, extraRows: 3, row: { patient: "P-001" }, key: "k".repeat(200), list: [1, 2, 3] } },
      { outcome: "temporal_leakage", subject: { table: "visits.csv", predictor: "sbp" }, count: 7, severity: "information" },
      { outcome: "made_up_outcome", count: 1 },
      "not an object",
    ],
    notChecked: [{ family: "joins", reason: "join_table_unavailable", subject: { join: "a->b" } }, { family: "joins", reason: "because" }],
    clean: [{ family: "drift", subject: { table: "visits.csv" } }, { family: "nonsense" }],
  });
  assert.ok(report);
  assert.equal(report.findings.length, 2);
  const [duplicates, leakage] = report.findings;
  assert.deepEqual(duplicates.subject, { table: "visits.csv", column: "patient_id,visit_no" });
  assert.equal(duplicates.rows.length, DATA_DRIFT_BOUNDS.sampleRows);
  assert.deepEqual(duplicates.rows.slice(0, 3), [4, 5, 10]);
  assert.deepEqual(duplicates.detail, { groups: 3, extraRows: 3, list: [1, 2, 3] });
  assert.equal(duplicates.family, "duplicates");
  assert.equal(leakage.severity, "information");
  assert.deepEqual(report.bindings, [{ table: "visits.csv", sha256: HASH_A }]);
  assert.deepEqual(report.notChecked, [{ family: "joins", reason: "join_table_unavailable", subject: { join: "a->b" } }]);
  assert.deepEqual(report.clean, [{ family: "drift", subject: { table: "visits.csv" } }]);
  assert.deepEqual(report.summary, { attention: 1, information: 1, notChecked: 1, clean: 1 });
  assert.equal(report.interpretation, HASH_B);
  assert.equal(normalizeCheckReport({ findings: [] }), null);
  assert.equal(normalizeCheckReport("x"), null);
});

test("a stored report and its denominators replace the last ones, oldest labels falling away first", () => {
  const asset = emptySemanticsAsset("d", T0);
  const report = { checkedAt: T0, bindings: [], findings: [], notChecked: [], clean: [] };
  assert.deepEqual(applyCheckReport(asset, report, { cohort: { rows: 120, subjects: 40 }, analysed: { rows: 100, subjects: 35, source: "reported" }, "": { rows: 1 }, bad: { rows: -1 } }, T0), { ok: true });
  assert.deepEqual(Object.keys(asset.denominators).sort(), ["analysed", "cohort"]);
  assert.equal(asset.denominators.analysed.source, "reported");
  assert.equal(asset.denominators.cohort.source, "measured");
  const many = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`step${index}`, { rows: index }]));
  applyCheckReport(asset, report, many, T1);
  assert.equal(Object.keys(asset.denominators).length, DATA_SEMANTICS_LIMITS.denominators);
  assert.equal(applyCheckReport(asset, { nope: 1 }, {}, T2).ok, false);
});

test("the interpretation digest input moves with what the data is said to mean and with nothing else", () => {
  const first = applySemanticsPatch(null, { datasetId: "d", ...inferred, variables: [{ table: "t.csv", name: "c", unit: "mg" }] }, { now: T0, via: "conversation" }).asset;
  const base = interpretationOf(first);
  // A new delivery, a new check and a transformation are not a new interpretation.
  const rebound = applySemanticsPatch(first, { bindings: [{ table: "t.csv", path: "t.csv", sha256: HASH_B, bytes: 1, rows: 1, columns: [] }] }, { now: T1, via: "conversation" }).asset;
  applyCheckReport(rebound, { checkedAt: T1, bindings: [], findings: [], notChecked: [], clean: [] }, {}, T1);
  assert.equal(interpretationOf(rebound), base);
  // The same words at another time are not one either.
  assert.equal(interpretationOf(applySemanticsPatch(first, { ...inferred, variables: [{ table: "t.csv", name: "c", unit: "mg" }] }, { now: T2, via: "conversation" }).asset), base);
  // A changed value, or the same value with a stronger basis, is.
  assert.notEqual(interpretationOf(applySemanticsPatch(first, { ...inferred, variables: [{ table: "t.csv", name: "c", unit: "g" }] }, { now: T1, via: "conversation" }).asset), base);
  assert.notEqual(interpretationOf(applySemanticsPatch(first, { ...confirmed("单位是 mg"), variables: [{ table: "t.csv", name: "c", unit: "mg" }] }, { now: T1, via: "conversation" }).asset), base);
});
