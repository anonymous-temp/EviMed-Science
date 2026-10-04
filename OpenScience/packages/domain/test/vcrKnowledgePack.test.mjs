import assert from "node:assert/strict";
import test from "node:test";

import {
  VCR_PACK_CODE_SYSTEMS,
  VCR_PACK_LICENCES,
  VCR_PACK_REFUSED_CODE_SYSTEMS,
  VCR_PACK_SECTIONS,
  VCR_PACK_STATUSES,
  VCR_SHIPPED_PACKS,
  validateKnowledgePack,
  vcrPackConceptColumns,
  vcrPackEntrySources,
  vcrPackMatchesName,
  vcrPackRestrictedSource,
  vcrPackSummary,
  vcrRemapRowRuleColumns,
  vcrRequirementVariables,
  vcrRowRuleColumns,
  vcrSuggestColumnRemap,
} from "@evimed/domain";

/** A small pack that meets the `complete` level; each test breaks one thing. */
function sample() {
  return structuredClone({
    schema: "evimed.vcr.knowledge-pack/1", id: "demo", version: 1, status: "curated", updated: "2026-10-04",
    disease: { key: "demo", name: "Demo disease", nameZh: "示例疾病", aliases: ["demo"], aliasesZh: ["示例"] },
    sources: [
      { id: "ncit", title: "NCI Thesaurus", url: "https://evs.nci.nih.gov/ftp1/NCI_Thesaurus/Thesaurus.FLAT.zip", accessed: "2026-10-04", licence: "CC-BY-4.0", version: "26.09d" },
      { id: "nct1", title: "NCT00000001", url: "https://clinicaltrials.gov/study/NCT00000001", accessed: "2026-10-04", licence: "ctgov-terms", processed: "2026-10-02", modified: true },
      { id: "guide", title: "A guideline", url: "https://example.org/guideline", accessed: "2026-10-04", licence: "link-only" },
      { id: "own", title: "EviMed authored dataset field-name hints", url: "https://www.evimed.com/", accessed: "2026-10-04", licence: "evimed-own" },
    ],
    terms: [{ id: "t_disease", kind: "disease", label: "Demo", labelZh: "示例", definition: "A definition the thesaurus states.", concept: "demo_disease", codes: [{ system: "NCIt", code: "C2926" }], sources: ["ncit"] }],
    phenotypes: [{ id: "p_disease", label: "Demo disease", labelZh: "示例疾病", type: "diagnosis", rule: { op: "present", variable: "demo_disease" }, text: "Has the disease.", textZh: "患有该病。", terms: ["t_disease"], sources: ["guide"] }],
    endpoints: [{ id: "e_os", label: "Overall survival", labelZh: "总生存期", type: "time_to_event", definition: "Time from start to death.", definitionZh: "从开始到死亡的时间。", standard: { name: "Death from any cause" }, sources: ["guide"] }],
    criteria: [{
      id: "c_adult", kind: "inclusion", criterionType: "demographic",
      requirement: { op: "compare", variable: "age", comparator: "gte", value: 18, unit: "years" }, text: "Adults.", textZh: "成人。", sources: ["nct1"],
    }],
    mappings: [
      { id: "m_age", concept: "age", label: "Age", labelZh: "年龄", type: "number", role: "covariate", unit: "years", fieldNames: ["AGE", "age_years"], sources: ["own"] },
      { id: "m_disease", concept: "demo_disease", label: "Disease", labelZh: "疾病", type: "flag", fieldNames: ["DEMO"], sources: ["own"] },
    ],
    background: [{ id: "b_1", text: "A short background.", textZh: "一段背景。", sources: ["guide"] }],
  });
}

/** @param {readonly { code: string, field: string }[]} issues */
const codes = (issues) => issues.map((issue) => `${issue.code}@${issue.field}`);

test("a pack that meets the contract has no issues at either level", () => {
  assert.deepEqual(validateKnowledgePack(sample(), { level: "complete" }), []);
  assert.deepEqual(validateKnowledgePack(sample()), []);
  assert.deepEqual([...VCR_PACK_STATUSES], ["curated", "ai-draft"]);
  assert.equal(VCR_PACK_SECTIONS.length, 6);
});

test("an AI draft is the floor: one language, no mappings, a link-only source", () => {
  const draft = {
    id: "rare_disease", status: "ai-draft", disease: { key: "rare_disease", nameZh: "某罕见病" },
    sources: [{ id: "paper", title: "A review", url: "https://example.org/review", accessed: "2026-10-04", licence: "link-only" }],
    terms: [{ id: "t1", labelZh: "某罕见病", kind: "disease", sources: ["paper"] }],
    endpoints: [{ id: "e1", labelZh: "症状评分变化", type: "continuous", definitionZh: "治疗后评分相对基线的变化。", standard: { name: "the scale named in the review" }, sources: ["paper"] }],
    criteria: [{
      id: "c1", kind: "exclusion", criterionType: "pregnancy", requirement: { op: "absent", variable: "pregnancy" }, textZh: "妊娠者除外。", sources: ["paper"],
    }],
  };
  assert.deepEqual(validateKnowledgePack(draft), []);
  const strict = codes(validateKnowledgePack(draft, { level: "complete" }));
  assert.ok(strict.some((code) => code.startsWith("pack_label_missing@")), "a complete pack carries both languages");
  assert.ok(strict.some((code) => code.startsWith("pack_variable_unmapped@")), "a complete pack maps every variable a rule names");
  assert.ok(strict.some((code) => code.startsWith("pack_section_empty@")), "a complete pack has every working section");
  assert.ok(strict.some((code) => code === "pack_shape_invalid@status"), "a shipped pack is curated");
});

test("every entry is sourced, and a source that is not in the pack's table is refused by name", () => {
  const pack = sample();
  delete pack.criteria[0].sources;
  pack.endpoints[0].sources = ["nowhere"];
  assert.deepEqual(codes(validateKnowledgePack(pack)), ["pack_entry_source_unknown@endpoints[0].sources[0]", "pack_entry_source_missing@criteria[0].sources"]);
  const none = sample();
  none.sources = [];
  assert.ok(codes(validateKnowledgePack(none)).includes("pack_source_missing@sources"));
});

test("a source states its URL, title, access date and a licence from the closed table", () => {
  const pack = sample();
  Object.assign(pack.sources[2], { url: "not a link", accessed: "yesterday", licence: "public-domain-i-think" });
  delete pack.sources[3].title;
  const found = codes(validateKnowledgePack(pack));
  for (const wanted of ["pack_source_incomplete@sources[2].url", "pack_source_incomplete@sources[2].accessed",
    "pack_source_licence_unknown@sources[2].licence", "pack_source_incomplete@sources[3].title"]) assert.ok(found.includes(wanted), wanted);
  assert.deepEqual(Object.keys(VCR_PACK_LICENCES).sort(), ["Apache-2.0", "CC-BY-4.0", "ctgov-terms", "evimed-own", "link-only"]);
});

test("ClinicalTrials.gov content states its processing date and that it was modified", () => {
  const pack = sample();
  delete pack.sources[1].processed;
  pack.sources[1].modified = false;
  assert.deepEqual(codes(validateKnowledgePack(pack)), ["pack_source_incomplete@sources[1].processed", "pack_source_incomplete@sources[1].modified"]);
});

test("WHO ICTRP, ATC/DDD and MedDRA are refused as sources and as code systems", () => {
  for (const url of ["https://trialsearch.who.int/Trial2.aspx?TrialID=X", "https://atcddd.fhi.no/atc_ddd_index/", "https://www.meddra.org/how-to-use/support-documentation"]) {
    assert.ok(vcrPackRestrictedSource(url), url);
    const pack = sample();
    pack.sources[2].url = url;
    assert.ok(codes(validateKnowledgePack(pack)).includes("pack_source_restricted@sources[2].url"), url);
  }
  assert.equal(vcrPackRestrictedSource("https://clinicaltrials.gov/study/NCT00000001"), null);
  for (const system of ["ATC", "MedDRA", "SNOMED CT", "LOINC", "RxNorm"]) {
    assert.ok(VCR_PACK_REFUSED_CODE_SYSTEMS.includes(system), system);
    const pack = sample();
    pack.terms[0].codes = [{ system, code: "1234" }];
    assert.deepEqual(codes(validateKnowledgePack(pack)), ["pack_code_system_restricted@terms[0].codes[0].system"], system);
  }
  const unknown = sample();
  unknown.terms[0].codes = [{ system: "Homemade", code: "1" }];
  assert.deepEqual(codes(validateKnowledgePack(unknown)), ["pack_code_system_unknown@terms[0].codes[0].system"]);
});

test("an identifier is accepted only from an allowed system, in its format, beside a source that publishes it", () => {
  const badFormat = sample();
  badFormat.terms[0].codes = [{ system: "NCIt", code: "2926" }];
  assert.deepEqual(codes(validateKnowledgePack(badFormat)), ["pack_code_invalid@terms[0].codes[0].code"]);

  const unpublished = sample();
  unpublished.terms[0].sources = ["guide"];
  unpublished.terms[0].definition = undefined;
  assert.deepEqual(codes(validateKnowledgePack(unpublished)), ["pack_code_unpublished@terms[0].codes[0].system"]);

  const omop = sample();
  omop.sources.push({ id: "ohdsi", title: "OHDSI PhenotypeLibrary v3.37.0, cohort 503", url: "https://raw.githubusercontent.com/OHDSI/PhenotypeLibrary/v3.37.0/inst/cohorts/503.json", accessed: "2026-10-04", licence: "Apache-2.0" });
  omop.terms[0].codes.push({ system: "OMOP", code: "201826" });
  omop.terms[0].sources.push("ohdsi");
  assert.deepEqual(validateKnowledgePack(omop), []);
});

test("copied text needs a source that allows it: a verbatim definition is never behind a link-only source", () => {
  const pack = sample();
  pack.terms[0].sources = ["guide"];
  pack.terms[0].codes = [];
  assert.deepEqual(codes(validateKnowledgePack(pack)), ["pack_text_not_reusable@terms[0].definition"]);
  pack.terms[0].definition = undefined;
  assert.deepEqual(validateKnowledgePack(pack), []);
});

test("a rule is the closed requirement grammar: an expression, an unknown op or a malformed node is refused with its path", () => {
  const pack = sample();
  pack.criteria[0].requirement = { op: "compare", variable: "age", comparator: ">=", value: 18 };
  pack.phenotypes[0].rule = { op: "present", variable: "demo_disease", expression: "x > 1" };
  pack.criteria.push({ id: "c_two", kind: "exclusion", criterionType: "other", requirement: { op: "language", text: "x", key: "ok" }, applicability: { op: "frobnicate" }, text: "x", textZh: "x", sources: ["nct1"] });
  const found = validateKnowledgePack(pack);
  assert.ok(found.every((issue) => ["pack_rule_malformed"].includes(issue.code)), JSON.stringify(found));
  const fields = found.map((issue) => issue.field);
  assert.ok(fields.some((field) => field.startsWith("criteria[0].requirement")));
  assert.ok(fields.some((field) => field.startsWith("phenotypes[0].rule")));
  assert.ok(fields.some((field) => field.startsWith("criteria[1].applicability")));
  const missing = sample();
  delete missing.criteria[0].requirement;
  assert.deepEqual(codes(validateKnowledgePack(missing)), ["pack_rule_missing@criteria[0].requirement"]);
});

test("ids are unique across the pack and every term reference resolves", () => {
  const pack = sample();
  pack.endpoints[0].id = "t_disease";
  pack.phenotypes[0].terms = ["t_disease", "t_nowhere"];
  assert.deepEqual(codes(validateKnowledgePack(pack)), ["pack_id_duplicate@endpoints[0].id", "pack_term_unknown@phenotypes[0].terms[1]"]);
});

test("a complete pack maps every variable its rules name, and says which are missing", () => {
  const pack = sample();
  pack.mappings = pack.mappings.filter((mapping) => mapping.concept !== "age");
  assert.deepEqual(codes(validateKnowledgePack(pack, { level: "complete" })), ["pack_variable_unmapped@criteria[0].requirement"]);
  assert.deepEqual(validateKnowledgePack(pack, { level: "draft" }), [], "a draft is not held to it");
  assert.deepEqual(vcrRequirementVariables({ op: "all", operands: [{ op: "present", variable: "a" }, { op: "not", operand: { op: "absent", variable: "b" } }, { op: "present", variable: "a" }] }), ["a", "b"]);
});

test("an unknown key anywhere is refused, so a number a calculation could read has nowhere to live", () => {
  const pack = sample();
  pack.eventRate = 0.4;
  pack.endpoints[0].hazardRatio = 0.7;
  assert.deepEqual(codes(validateKnowledgePack(pack)), ["pack_shape_invalid@eventRate", "pack_shape_invalid@endpoints[0].hazardRatio"]);
  assert.deepEqual(codes(validateKnowledgePack(null)), ["pack_shape_invalid@"]);
});

test("entry sources resolve with their licence's kind of use; the summary counts what the pack holds", () => {
  const pack = sample();
  const resolved = vcrPackEntrySources(pack, pack.criteria[0]);
  assert.deepEqual(resolved.map((source) => [source.id, source.use, source.processed, source.modified]), [["nct1", "attribution", "2026-10-02", true]]);
  assert.equal(vcrPackEntrySources(pack, pack.phenotypes[0])[0].use, "link-only");
  const summary = vcrPackSummary(pack);
  assert.deepEqual(summary.counts, { terms: 1, phenotypes: 1, endpoints: 1, criteria: 1, mappings: 2, background: 1 });
  assert.equal(summary.status, "curated");
  assert.equal(summary.sources.length, 4);
});

test("a pack answers a search word by its names; the concept columns come from a field map by concept or by name, whole-string", () => {
  const pack = sample();
  assert.ok(vcrPackMatchesName(pack, "demo"));
  assert.ok(vcrPackMatchesName(pack, "示例"));
  assert.ok(vcrPackMatchesName(pack, ""));
  assert.equal(vcrPackMatchesName(pack, "lung"), false);

  const fieldMap = [
    { table: "adsl.csv", column: "AGE" },
    { table: "adsl.csv", column: "DX", concept: "demo_disease" },
    { table: "adsl.csv", column: "SMOKING", concept: "smoking_history" },
    { table: "adsl.csv", column: "AGEGR1" },
  ];
  const mapped = vcrPackConceptColumns(pack, fieldMap);
  assert.deepEqual(mapped.realised, [
    { concept: "age", table: "adsl.csv", column: "AGE", by: "name" },
    { concept: "demo_disease", table: "adsl.csv", column: "DX", by: "concept" },
  ]);
  assert.deepEqual(mapped.missing, []);
  assert.deepEqual(mapped.unknown, ["smoking_history"], "a concept the field map names and the pack does not know is listed, not dropped");
  assert.deepEqual(vcrPackConceptColumns(pack, []).missing, ["age", "demo_disease"]);
});

test("a definition's rules are renamed to another dataset's columns only where the pack's mappings make it unambiguous", () => {
  const rule = { op: "all", operands: [
    { op: "compare", column: "AGE", comparator: "gte", value: 18 },
    { op: "not", operand: { op: "in", column: "ECOG_PS", values: [3, 4] } },
    { op: "present", column: "ECOG_PS" },
  ] };
  assert.deepEqual(vcrRowRuleColumns(rule), ["AGE", "ECOG_PS"]);
  const pack = {
    mappings: [
      { concept: "age", fieldNames: ["AGE", "age_years"] },
      { concept: "ecog", fieldNames: ["ECOG", "ECOG_PS", "ecogps"] },
      { concept: "sex", fieldNames: ["SEX", "gender"] },
    ],
  };
  const same = vcrSuggestColumnRemap(pack, ["AGE", "ECOG_PS"], ["AGE", "ECOG_PS"]);
  assert.deepEqual(same, { suggested: [], unmatched: [] }, "columns the target has need nothing");
  const mapped = vcrSuggestColumnRemap(pack, ["AGE", "ECOG_PS"], ["age_years", "ecogps", "SEX"]);
  assert.deepEqual(mapped.suggested, [
    { from: "AGE", to: "age_years", concept: "age" },
    { from: "ECOG_PS", to: "ecogps", concept: "ecog" },
  ]);
  const renamed = vcrRemapRowRuleColumns(rule, Object.fromEntries(mapped.suggested.map((entry) => [entry.from, entry.to])));
  assert.deepEqual(vcrRowRuleColumns(renamed), ["age_years", "ecogps"]);
  assert.deepEqual(vcrRowRuleColumns(rule), ["AGE", "ECOG_PS"], "the input is not changed");
  // two candidates, or a column no mapping knows, is left for a person
  const ambiguous = vcrSuggestColumnRemap({ mappings: [{ concept: "age", fieldNames: ["AGE", "age_years", "AGEYR"] }] }, ["AGE"], ["age_years", "AGEYR"]);
  assert.deepEqual(ambiguous, { suggested: [], unmatched: ["AGE"] });
  assert.deepEqual(vcrSuggestColumnRemap(pack, ["SMOKING"], ["age"]), { suggested: [], unmatched: ["SMOKING"] });
  assert.deepEqual(vcrSuggestColumnRemap(null, ["AGE"], ["age"]), { suggested: [], unmatched: ["AGE"] }, "a study with no pack suggests nothing");
});

// --- the packs that ship ----------------------------------------------------------

const SHIPPED = Object.entries(VCR_SHIPPED_PACKS);
const NCT_URL = /^https:\/\/clinicaltrials\.gov\/study\/NCT\d{8}$/;

test("the three curated packs ship, load through the validator at the complete level and are what the owner chose", () => {
  assert.deepEqual(Object.keys(VCR_SHIPPED_PACKS).sort(), ["breast_cancer", "nsclc", "type_2_diabetes"]);
  for (const [id, pack] of SHIPPED) {
    assert.equal(pack.id, id);
    assert.equal(pack.status, "curated", id);
    assert.deepEqual(validateKnowledgePack(pack, { level: "complete" }), [], id);
    assert.ok(Object.isFrozen(pack) && Object.isFrozen(pack.criteria[0]), `${id}: a shipped pack is read, never edited in place`);
    const counts = vcrPackSummary(pack).counts;
    assert.ok(counts.terms >= 10 && counts.phenotypes >= 5 && counts.endpoints >= 5 && counts.criteria >= 10 && counts.mappings >= 10, `${id}: ${JSON.stringify(counts)}`);
  }
  // each is found by the names a researcher types, in both languages
  const found = (/** @type {string} */ word) => SHIPPED.filter(([, pack]) => vcrPackMatchesName(pack, word)).map(([id]) => id);
  assert.deepEqual([found("NSCLC"), found("肺癌"), found("乳腺癌"), found("breast"), found("T2DM"), found("糖尿病")],
    [["nsclc"], ["nsclc"], ["breast_cancer"], ["breast_cancer"], ["type_2_diabetes"], ["type_2_diabetes"]]);
});

test("every entry of every shipped pack is sourced, every source has a link, a title, an access date and a licence from the closed table, and no source is restricted", () => {
  for (const [id, pack] of SHIPPED) {
    const table = new Map(pack.sources.map((/** @type {any} */ source) => [source.id, source]));
    for (const source of pack.sources) {
      assert.match(source.url, /^https:\/\//, `${id}/${source.id}: a link`);
      assert.ok(source.title.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(source.accessed), `${id}/${source.id}`);
      assert.ok(Object.keys(VCR_PACK_LICENCES).includes(source.licence), `${id}/${source.id}: licence ${source.licence}`);
      assert.equal(vcrPackRestrictedSource(source.url), null, `${id}/${source.id}: a restricted source`);
      assert.ok(!/ictrp|atcddd|whocc|meddra/i.test(source.url), `${id}/${source.id}: ${source.url}`);
    }
    let cited = 0;
    for (const section of VCR_PACK_SECTIONS) {
      for (const entry of pack[section]) {
        assert.ok(entry.sources.length >= 1 && entry.sources.every((/** @type {string} */ ref) => table.has(ref)), `${id}/${entry.id}: sources`);
        for (const resolved of vcrPackEntrySources(pack, entry)) assert.ok(resolved.use && resolved.licenceName !== undefined, `${id}/${entry.id}`);
        cited += 1;
      }
    }
    assert.ok(cited >= 60, `${id}: the walk found the entries (${cited})`);
    // every source is cited by something, so the table is what the pack rests on and nothing else
    const used = new Set(VCR_PACK_SECTIONS.flatMap((section) => pack[section].flatMap((/** @type {any} */ entry) => entry.sources)));
    assert.deepEqual(pack.sources.map((/** @type {any} */ source) => source.id).filter((/** @type {string} */ ref) => !used.has(ref)), [], `${id}: an uncited source`);
  }
});

test("ClinicalTrials.gov content is attributed with its processing date and a statement that it was modified; each record is a real NCT id; OHDSI's library status is stated", () => {
  let registry = 0;
  let ohdsi = 0;
  for (const [id, pack] of SHIPPED) {
    for (const source of pack.sources) {
      if (source.licence === "ctgov-terms") {
        registry += 1;
        assert.match(source.url, NCT_URL, `${id}/${source.id}`);
        assert.equal(source.id, source.url.slice(-11).toLowerCase(), `${id}: the source id is the registry id`);
        assert.ok(source.title.startsWith(source.url.slice(-11)), `${id}/${source.id}: the title names the record`);
        assert.deepEqual([source.processed, source.modified], ["2026-10-02", true], `${id}/${source.id}`);
      }
      if (source.licence === "Apache-2.0") {
        ohdsi += 1;
        assert.match(source.url, /^https:\/\/raw\.githubusercontent\.com\/OHDSI\/PhenotypeLibrary\/v3\.37\.0\/inst\/cohorts\/\d+\.json$/, `${id}/${source.id}: the release and the cohort file that was read`);
        assert.match(source.note ?? "", /Pending|Accepted/, `${id}/${source.id}: the library status is stated`);
        assert.match(source.note ?? "", /LICENSE/, `${id}/${source.id}: the missing licence file is said`);
      }
      if (source.licence === "CC-BY-4.0") assert.match(source.version ?? "", /^\d{2}\.\d{2}[a-z]?$/, `${id}/${source.id}: the NCIt version that was read`);
    }
  }
  assert.ok(registry >= 60 && ohdsi >= 5, `the walk found them (${registry} registry records, ${ohdsi} OHDSI cohorts)`);
});

test("no shipped pack carries a restricted or licensed code system, and every code is in the format of its system beside a source that publishes it", () => {
  const allowed = Object.keys(VCR_PACK_CODE_SYSTEMS);
  let codes = 0;
  for (const [id, pack] of SHIPPED) {
    for (const term of pack.terms) {
      for (const code of term.codes ?? []) {
        codes += 1;
        assert.ok(allowed.includes(code.system), `${id}/${term.id}: ${code.system}`);
        assert.ok(!VCR_PACK_REFUSED_CODE_SYSTEMS.some((refused) => refused.toLowerCase() === String(code.system).toLowerCase()), `${id}/${term.id}`);
      }
      // a verbatim definition is an NCI Thesaurus one, with that source cited
      if (term.definition) assert.ok(term.sources.includes("ncit") && (term.codes ?? []).some((/** @type {any} */ code) => code.system === "NCIt"), `${id}/${term.id}`);
    }
  }
  assert.ok(codes >= 80, `the walk found the codes (${codes})`);
});

test("a pack holds definitions, never a number a calculation uses: no entry carries a key outside the contract, and every endpoint names the standard it is assessed by", () => {
  for (const [id, pack] of SHIPPED) {
    for (const endpoint of pack.endpoints) {
      assert.ok(endpoint.standard?.name?.length > 0, `${id}/${endpoint.id}`);
      assert.ok(["continuous", "binary", "time_to_event"].includes(endpoint.type), `${id}/${endpoint.id}`);
    }
    const text = JSON.stringify(pack);
    for (const forbidden of ["eventRate", "hazardRatio", "effectSize", "dropoutRate", "\"counts\"", "\"measures\""]) assert.ok(!text.includes(forbidden), `${id}: ${forbidden}`);
    // a criterion's requirement and a phenotype's rule are the closed grammar, with no expression anywhere
    assert.ok(!/"expression"/.test(text), id);
  }
});
