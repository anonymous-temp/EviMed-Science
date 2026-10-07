import assert from "node:assert/strict";
import test from "node:test";
import {
  ENTITY_BACKFILL_MAX_PASSES, ENTITY_BACKFILL_PASS_ROWS, ENTITY_EMPTY_GLOSSARY_RETRY_MS, ENTITY_TAGGING_MAX_ENTITY_KEYS,
  ENTITY_TAGGING_MAX_IDENTIFIER_KEYS, createEntityVocabulary, entityKeysInTexts, entityVocabularyMetricFamilies,
} from "../src/entityVocabulary.mjs";
import { FrontierGlossary } from "../src/frontierGlossary.mjs";

/** Glossary rows as `evimed_frontier.glossary` holds them. */
const ROWS = [
  { kind: "drug", term_en: "semaglutide", term_zh: "司美格鲁肽", keep_original: false, origin: "hand" },
  { kind: "drug", term_en: "semaglutide injection", term_zh: "司美格鲁肽", keep_original: false, origin: "hand" },
  { kind: "drug", term_en: "aspirin", term_zh: "阿司匹林", keep_original: false, origin: "hand" },
  { kind: "drug", term_en: "ASA", term_zh: "ASA", keep_original: true, origin: "hand" },
  { kind: "drug", term_en: "metformin", term_zh: "二甲双胍", keep_original: false, origin: "hand" },
  { kind: "trial", term_en: "SELECT", term_zh: "SELECT", keep_original: true, origin: "hand" },
  { kind: "org", term_en: "FDA", term_zh: "美国食品药品监督管理局", keep_original: false, origin: "hand" },
  { kind: "method", term_en: "meta-analysis", term_zh: "Meta分析", keep_original: false, origin: "hand" },
  { kind: "disease", term_en: "heart failure", term_zh: "心力衰竭", keep_original: false, origin: "hand" },
  { kind: "disease", term_en: "heart failure with preserved ejection fraction", term_zh: "射血分数保留的心力衰竭", keep_original: false, origin: "hand" },
  { kind: "disease", term_en: "Alzheimer's disease", term_zh: "阿尔茨海默病", keep_original: false, origin: "hand" },
];

/**
 * A product database that serves the glossary table and counts what it was asked.
 * @param {Array<Record<string, any>>} rows
 */
function database(rows = ROWS) {
  const queries = [];
  return { queries, async query(sql) { queries.push(sql); return { rows }; } };
}

/** @param {Record<string, any>} [overrides] */
function vocabulary(overrides = {}) {
  const db = overrides.database ?? database();
  return { db, vocab: createEntityVocabulary({ database: db, enabled: true, ...overrides }) };
}

test("a glossary drug is found by its Chinese name, its English name and an alias, and all three are one key", async () => {
  const { vocab } = vocabulary();
  for (const text of ["司美格鲁肽对心血管事件的影响", "Semaglutide and cardiovascular events", "Semaglutide injection once a week"]) {
    assert.deepEqual(await vocab.keysForText({ texts: [text] }), ["drug:semaglutide"], text);
  }
});

test("a Latin term is a whole word: ASA is not found inside another word, an acronym only as written", async () => {
  const { vocab } = vocabulary();
  assert.deepEqual(await vocab.keysForText({ texts: ["ASA after stenting"] }), ["drug:asa"]);
  assert.deepEqual(await vocab.keysForText({ texts: ["ASAP, BASAL and CASANOVA are other words; so is asa"] }), []);
  assert.deepEqual(await vocab.keysForText({ texts: ["semaglutides, a longer word"] }), []);
  assert.deepEqual(await vocab.keysForText({ texts: ["a select group of patients"] }), [], "the trial SELECT only as written");
  assert.deepEqual(await vocab.keysForText({ texts: ["the SELECT trial"] }), ["trial:select"]);
});

test("the longest term wins where terms overlap: one disease, not two", async () => {
  const { vocab } = vocabulary();
  assert.deepEqual(await vocab.keysForText({ texts: ["Heart failure with preserved ejection fraction in older adults"] }),
    ["disease:heart failure with preserved ejection fraction"]);
  assert.deepEqual(await vocab.keysForText({ texts: ["射血分数保留的心力衰竭"] }), ["disease:heart failure with preserved ejection fraction"]);
  assert.deepEqual(await vocab.keysForText({ texts: ["Heart failure after a heart failure with preserved ejection fraction admission"] }),
    ["disease:heart failure", "disease:heart failure with preserved ejection fraction"], "a separate mention of the short term stands");
  assert.deepEqual(await vocab.keysForText({ texts: ["Heart failure with preserved ejection fraction", "heart failure"] }),
    ["disease:heart failure", "disease:heart failure with preserved ejection fraction"], "each text is its own, a term does not span two");
});

test("organisations and methods are not tagged out of text; drugs, diseases and trials are", async () => {
  const { vocab } = vocabulary();
  assert.deepEqual(await vocab.keysForText({ texts: ["FDA review of a meta-analysis of metformin in Alzheimer's disease; the SELECT trial"] }),
    ["disease:alzheimer's disease", "drug:metformin", "trial:select"]);
  const glossary = new FrontierGlossary(ROWS.map((row) => ({ kind: row.kind, termEn: row.term_en, termZh: row.term_zh, keepOriginal: row.keep_original })));
  assert.deepEqual(entityKeysInTexts(glossary, ["FDA and aspirin"], { kinds: ["org", "drug"] }).keys, ["drug:aspirin", "org:fda"]);
});

test("identifiers are keys too: found in the text and given beside it, DOI and PMID and trial numbers", async () => {
  const { vocab } = vocabulary();
  assert.deepEqual(await vocab.keysForText({
    texts: ["Semaglutide, see https://doi.org/10.1056/NEJMoa2307563 and PMID: 37952131, NCT03574597"],
  }), ["drug:semaglutide", "doi:10.1056/nejmoa2307563", "pmid:37952131", "reg:NCT03574597"]);
  assert.deepEqual(await vocab.keysForText({ texts: [], identifiers: { doi: "10.1000/ABC", pmid: "42", registryIds: ["chictr-rct-12002345"] } }),
    ["doi:10.1000/abc", "pmid:42", "reg:CHICTR-RCT-12002345"]);
  assert.deepEqual(await vocab.keysForText({ texts: ["x"], identifiers: ["PMID: 123456", { doi: "10.1000/q" }, "NCT01234567"] }),
    ["doi:10.1000/q", "pmid:123456", "reg:NCT01234567"], "a list reads its strings as text and its objects as identifiers");
  assert.deepEqual(await vocab.keysForText({ texts: [], identifiers: "https://pubmed.ncbi.nlm.nih.gov/37952131/" }), ["pmid:37952131"], "a string is read as text");
  // What a card states (`evidenceCardIdentifiers` in the domain): kind-prefixed and lower-cased. Read as stated — a
  // lower-case `registry:nct…` is no NCT number to a sentence reader, and `pmcid:` names no key the frontier holds.
  assert.deepEqual(await vocab.keysForText({ texts: [], identifiers: ["doi:10.1000/abc", "pmid:42", "registry:nct01234567", "pmcid:pmc1234567"] }),
    ["doi:10.1000/abc", "pmid:42", "reg:NCT01234567"]);
});

test("a name the glossary does not hold is not a key, and nothing is guessed", async () => {
  const { vocab } = vocabulary();
  assert.deepEqual(await vocab.keysForText({ texts: ["Tirzepatide and retatrutide in obesity"] }), []);
});

test("with the frontier off nothing is read and every answer is empty", async () => {
  const db = database();
  const off = createEntityVocabulary({ database: db, enabled: false });
  assert.equal(off.enabled, false);
  assert.deepEqual(await off.keysForText({ texts: ["semaglutide NCT03574597"] }), []);
  assert.equal(await off.tag({ texts: ["semaglutide"] }), null);
  assert.deepEqual(await off.keysForEntities({ drugs: ["semaglutide"] }), []);
  assert.deepEqual(await off.describe(["drug:semaglutide"]), []);
  assert.deepEqual(await off.entityKeysFor({ texts: ["semaglutide"] }), []);
  assert.deepEqual(await off.frontierItemsMatching({ entityKeys: ["drug:semaglutide"] }), []);
  assert.deepEqual(await off.backfill(), {});
  assert.equal(db.queries.length, 0, "no table touched");
  assert.equal(off.glossaryStore, null);
  // And no database at all is the same thing.
  assert.equal(createEntityVocabulary({ enabled: true }).enabled, false);
});

test("an empty or unreadable glossary tags nothing, not even an identifier, and says so with null", async () => {
  const empty = vocabulary({ database: database([]) }).vocab;
  assert.deepEqual(await empty.keysForText({ texts: ["semaglutide 10.1056/nejmoa2307563"] }), []);
  assert.equal(await empty.tag({ texts: ["semaglutide"] }), null, "unable to tag is not the same as found nothing");
  assert.deepEqual(await empty.describe(["drug:semaglutide"]), []);
  const broken = createEntityVocabulary({ database: { async query() { throw Object.assign(new Error("down"), { code: "42P01" }); } }, enabled: true });
  assert.equal(await broken.tag({ texts: ["semaglutide"] }), null);
  assert.deepEqual(await broken.keysForText({ texts: ["semaglutide"] }), []);
  // Found nothing, with a glossary, is [] and not null.
  assert.deepEqual(await vocabulary().vocab.tag({ texts: ["nothing here"] }), []);
});

test("an empty glossary is looked for again after a while: a table seeded after boot is picked up", async () => {
  let clock = 1_000_000;
  let rows = [];
  const { vocab } = vocabulary({ database: { async query() { return { rows }; } }, now: () => clock });
  assert.deepEqual(await vocab.keysForText({ texts: ["semaglutide"] }), []);
  rows = ROWS;
  clock += ENTITY_EMPTY_GLOSSARY_RETRY_MS - 1;
  assert.deepEqual(await vocab.keysForText({ texts: ["semaglutide"] }), [], "not yet");
  clock += 2;
  assert.deepEqual(await vocab.keysForText({ texts: ["semaglutide"] }), ["drug:semaglutide"]);
});

test("the keys of one record are bounded and come back in a stable order", async () => {
  const many = Array.from({ length: 40 }, (_, index) => ({ kind: "drug", term_en: `drugname${String(index).padStart(2, "0")}`, term_zh: `药${index}名`, keep_original: false, origin: "hand" }));
  const { vocab } = vocabulary({ database: database(many) });
  const text = [...many].reverse().map((row) => row.term_en).join(" ");
  const keys = await vocab.keysForText({ texts: [text] });
  assert.equal(keys.length, ENTITY_TAGGING_MAX_ENTITY_KEYS);
  assert.deepEqual(keys, [...keys].sort(), "sorted, so an unchanged text gives an unchanged array");
  assert.deepEqual(await vocab.keysForText({ texts: [text] }), keys);
  assert.ok(keys.includes("drug:drugname39"), "the first terms of the text are the ones kept");
  const registered = Array.from({ length: 30 }, (_, index) => `NCT${String(index).padStart(8, "0")}`);
  const withIds = await vocab.keysForText({ texts: [], identifiers: { registryIds: registered } });
  assert.equal(withIds.length, ENTITY_TAGGING_MAX_IDENTIFIER_KEYS);
  // A text is read to a bound and only so many texts are read.
  const far = `${"x ".repeat(25_000)} semaglutide`;
  assert.deepEqual((await vocabulary().vocab.keysForText({ texts: [far] })), [], "past the character bound is not read");
  const crowded = [...Array.from({ length: 24 }, () => "nothing"), "semaglutide"];
  assert.deepEqual((await vocabulary().vocab.keysForText({ texts: crowded })), [], "past the text bound is not read");
  assert.equal(vocab.stats().counters.truncated >= 2, true, "and the cut is counted");
});

test("a frontier item's keys are what the glossary's own entity-key function gives, byte for byte", async () => {
  const { vocab } = vocabulary();
  const glossary = new FrontierGlossary(ROWS.map((row) => ({ kind: row.kind, termEn: row.term_en, termZh: row.term_zh, keepOriginal: row.keep_original })));
  const fixtures = [
    { drugs: ["司美格鲁肽", "semaglutide injection"], trials: ["SELECT"], orgs: ["美国食品药品监督管理局"], diseases: ["肥胖", "阿尔茨海默病"] },
    { drugs: ["tirzepatide"], trials: [], orgs: [], diseases: [] },
    { drugs: [], trials: [], orgs: [], diseases: [] },
    null,
  ];
  for (const entities of fixtures) assert.deepEqual(await vocab.keysForEntities(entities), glossary.entityKeys(entities));
  assert.deepEqual(await vocab.keysForEntities(fixtures[0]), ["drug:semaglutide", "trial:select", "org:fda", "disease:肥胖", "disease:alzheimer's disease"]);
});

test("describe names a key for display: the Chinese name for an entity, the identifier itself otherwise", async () => {
  const { vocab } = vocabulary();
  assert.deepEqual(await vocab.describe(["drug:semaglutide", "trial:select", "disease:tirzepatide-induced", "doi:10.1000/a", "pmid:42", "reg:NCT01234567", "nonsense", "drug:semaglutide"]), [
    { key: "drug:semaglutide", type: "drug", label: "司美格鲁肽" },
    { key: "trial:select", type: "trial", label: "SELECT" },
    { key: "disease:tirzepatide-induced", type: "disease", label: "tirzepatide-induced" },
    { key: "doi:10.1000/a", type: "doi", label: "10.1000/a" },
    { key: "pmid:42", type: "pmid", label: "PMID 42" },
    { key: "reg:NCT01234567", type: "registry", label: "NCT01234567" },
  ]);
});

test("the adapter the evidence-zone service receives has exactly the signature entityKeysFor({ texts, identifiers }) => Promise<string[]>", async () => {
  const { vocab } = vocabulary();
  const { entityKeysFor } = vocab;
  const pending = entityKeysFor({ texts: ["司美格鲁肽的证据专区"], identifiers: { pmid: "37952131" } });
  assert.ok(pending instanceof Promise);
  assert.deepEqual(await pending, ["drug:semaglutide", "pmid:37952131"]);
  assert.deepEqual(await entityKeysFor({ texts: ["司美格鲁肽的证据专区"], identifiers: { pmid: "37952131" } }), await vocab.keysForText({ texts: ["司美格鲁肽的证据专区"], identifiers: { pmid: "37952131" } }));
  assert.deepEqual(await entityKeysFor(), []);
  assert.deepEqual(await entityKeysFor({}), []);
});

test("the counters say what the taggings found, and the glossary's size", async () => {
  const { vocab } = vocabulary();
  assert.deepEqual(entityVocabularyMetricFamilies(vocab.stats()).find((family) => family.name.endsWith("glossary_entries"))?.series, [{ value: 0 }], "nothing is read before the first use");
  await vocab.keysForText({ texts: ["semaglutide"] });
  await vocab.keysForText({ texts: ["nothing"] });
  await vocab.keysForText({ texts: ["aspirin", "metformin"] });
  const families = entityVocabularyMetricFamilies(vocab.stats());
  const byName = Object.fromEntries(families.map((family) => [family.name, family.series]));
  assert.deepEqual(byName.open_science_entity_vocabulary_enabled, [{ value: 1 }]);
  assert.deepEqual(byName.open_science_entity_vocabulary_glossary_entries, [{ value: ROWS.length }]);
  assert.deepEqual(byName.open_science_entity_vocabulary_taggings_total, [
    { labels: { outcome: "found" }, value: 2 }, { labels: { outcome: "empty" }, value: 1 }, { labels: { outcome: "unavailable" }, value: 0 }]);
  const off = createEntityVocabulary({ enabled: false });
  await off.keysForText({ texts: ["x"] });
  assert.deepEqual(entityVocabularyMetricFamilies(off.stats()).map((family) => [family.name, family.series]),
    [["open_science_entity_vocabulary_enabled", [{ value: 0 }]]], "off: the gauge alone");
  assert.deepEqual(entityVocabularyMetricFamilies(null).length, 1);
});

test("rows made without a glossary are backfilled after the glossary loads: bounded passes, a failing module counted and left", async () => {
  const { vocab } = vocabulary();
  /** @type {number[]} */
  const calls = [];
  let remaining = ENTITY_BACKFILL_PASS_ROWS * 2 + 7;
  vocab.registerBackfill("autopilot", async ({ limit }) => {
    calls.push(limit);
    const tagged = Math.min(limit, remaining);
    remaining -= tagged;
    return { tagged };
  });
  vocab.registerBackfill("geo", async () => { throw Object.assign(new Error("down"), { code: "42P01" }); });
  const reports = [];
  const reporting = vocabulary({ report: (code) => reports.push(code) }).vocab;
  reporting.registerBackfill("geo", async () => { throw Object.assign(new Error("down"), { code: "42P01" }); });
  assert.deepEqual(await vocab.backfill(), { autopilot: ENTITY_BACKFILL_PASS_ROWS * 2 + 7, geo: 0 });
  assert.deepEqual(calls, [100, 100, 100], "a pass that comes back short is the last");
  assert.equal(vocab.stats().counters.backfillFailures, 1);
  assert.deepEqual(vocab.stats().counters.backfilled, { autopilot: 207 }, "a failed run tagged nothing");
  await reporting.backfill();
  assert.deepEqual(reports, ["entity vocabulary backfill geo: 42P01"]);
  // A runner never runs more passes than the bound.
  const endless = vocabulary().vocab;
  let runs = 0;
  endless.registerBackfill("vcr", async ({ limit }) => { runs += 1; return { tagged: limit }; });
  await endless.backfill();
  assert.equal(runs, ENTITY_BACKFILL_MAX_PASSES);
});

test("the first non-empty glossary load starts the backfill; a vocabulary that is off never does", async () => {
  /** @type {string[]} */
  const ran = [];
  const { vocab } = vocabulary();
  vocab.registerBackfill("autopilot", async () => { ran.push("autopilot"); return { tagged: 0 }; });
  await vocab.keysForText({ texts: ["semaglutide"] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ran, ["autopilot"]);
  await vocab.keysForText({ texts: ["semaglutide"] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ran, ["autopilot"], "once per load, not once per call");
  const empty = vocabulary({ database: database([]) }).vocab;
  empty.registerBackfill("autopilot", async () => { ran.push("empty"); return { tagged: 0 }; });
  await empty.keysForText({ texts: ["semaglutide"] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ran, ["autopilot"], "an empty glossary tags nothing, so there is nothing to backfill");
  const off = createEntityVocabulary({ enabled: false });
  off.registerBackfill("autopilot", async () => { ran.push("off"); return { tagged: 0 }; });
  await off.keysForText({ texts: ["semaglutide"] });
  await off.refresh();
  assert.deepEqual(ran, ["autopilot"]);
});

test("the glossary reports where each term sits, and `match` still reports the entries in the order they are named", () => {
  const glossary = new FrontierGlossary(ROWS.map((row) => ({ kind: row.kind, termEn: row.term_en, termZh: row.term_zh, keepOriginal: row.keep_original })));
  const text = "司美格鲁肽 and Semaglutide injection in heart failure";
  const spans = glossary.spans(text).map((span) => [span.entry.termEn, text.slice(span.start, span.end), span.start]);
  assert.deepEqual(spans.filter(([, surface]) => surface === "Semaglutide injection"), [["semaglutide injection", "Semaglutide injection", 10]]);
  assert.deepEqual(spans.filter(([term]) => term === "semaglutide").map(([, surface]) => surface).sort(), ["Semaglutide", "司美格鲁肽"]);
  assert.deepEqual(spans.filter(([term]) => term === "heart failure"), [["heart failure", "heart failure", 35]]);
  assert.deepEqual(glossary.match(text).map((entry) => entry.termEn), ["semaglutide", "semaglutide injection", "heart failure"]);
});

test("a glossary store can be told to load again, whatever its time to live says", async () => {
  const { FrontierGlossaryStore } = await import("../src/frontierGlossary.mjs");
  let rows = [];
  let calls = 0;
  const store = new FrontierGlossaryStore({ database: { async query() { calls += 1; return { rows }; } }, ttlMs: 3_600_000, now: () => 0 });
  assert.equal((await store.current()).size, 0);
  rows = ROWS;
  assert.equal((await store.current()).size, 0, "within its time to live");
  assert.equal((await store.refresh()).size, ROWS.length);
  assert.equal(calls, 2);
  const [first, second] = await Promise.all([store.refresh(), store.refresh()]);
  assert.equal(first, second, "concurrent refreshes share one load");
});
