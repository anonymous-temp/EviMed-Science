// `vcr_read what: "candidates"` (M1): the registries asked together, the answers merged, the same trial once, the cut to a list, the filters
// by what each record states, the coverage said. Registry doubles throughout; the merge and the filters are exact operations and are held
// to nothing a model said. What the test shows is that the logic is right, not that the three registries cover enough.
import assert from "node:assert/strict";
import test from "node:test";

import { REGISTRY_UNAVAILABLE, chictrPrecedent, ctisListItem } from "../src/trialRegistryClient.mjs";
import {
  CANDIDATES_NOT_COVERED, ageBands, ageFit, candidateRequest, chictrCandidate, coverageSentence, ctgovCandidate, ctisCandidate,
  filterCandidates, interleave, mergeCandidates, regionFit, registryOutcome, sexFit, sexOf,
} from "../src/vcrCandidateSearch.mjs";
import { VCR_READ_WHATS, VcrService } from "../src/vcrService.mjs";
import { createVcrEvidencePipeline } from "../src/vcrEvidence.mjs";

const NOW = new Date("2026-11-01T08:00:00.000Z");
const AT = "2026-11-01T07:59:00.000Z";

/** A ClinicalTrials.gov list item asked for one patient (`search({ forPatient: true, withLocations })`). */
const ctgov = (id, extra = {}) => ({
  registry: "clinicaltrials.gov", registryId: id, title: `Trial ${id}`, overallStatus: "RECRUITING", phases: ["PHASE2"], conditions: ["Non-small Cell Lung Cancer"],
  interventions: ["Drug A"], url: `https://clinicaltrials.gov/study/${id}`, sex: "ALL", minimumAge: "18 Years", maximumAge: "N/A", secondaryIds: [], countries: ["China", "Japan"],
  ...extra,
});
/** A CTIS list item as the client builds one. */
const ctis = (number, extra = {}) => ctisListItem({ ctNumber: number, ctTitle: `EU ${number}`, ctStatus: 4, trialPhase: "Therapeutic exploratory (Phase II)", conditions: "lung cancer",
  product: "Drug B", trialCountries: ["Germany:2", "France:1"], ageGroup: "18-64 years, 65+ years", gender: "Male, Female", ...extra });
/** A ChiCTR listing: the evidence API's list item, through the client's own builder. */
const chictr = (number, extra = {}) => chictrPrecedent({ registrationNo: number, title: `中国 ${number}`, status: "招募中", phase: "III期临床试验", conditions: ["肺癌"], interventions: ["药物C"], url: `https://www.chictr.org.cn/showproj.html?proj=${number}`, ...extra }, { retrievedAt: AT });

test("a request is the condition, up to three other phrases and what is known of the patient; anything else is refused in words", () => {
  const good = candidateRequest({ condition: " non-small cell   lung cancer ", terms: ["NSCLC EGFR", "非小细胞肺癌", "non-small cell lung cancer"], age: 63, sex: "Female", region: "China", status: "any", limit: 5 });
  assert.equal(good.ok, true);
  assert.deepEqual(good.request, { condition: "non-small cell lung cancer", terms: ["NSCLC EGFR", "非小细胞肺癌"], age: 63, sex: "female", region: "China", scope: "any", limit: 5 },
    "the condition said again as a phrase is not a second search");
  assert.deepEqual(candidateRequest({ condition: "x" }).request, { condition: "x", terms: [], age: null, sex: null, region: null, scope: "open", limit: 20 });
  assert.equal(candidateRequest({ condition: "x", limit: 99 }, { limitMax: 12 }).request.limit, 12, "the list's size is the deployment's");
  for (const bad of [{}, { condition: "" }, { condition: "x", terms: "y" }, { condition: "x", terms: ["a", "b", "c", "d"] }, { condition: "x", age: -1 }, { condition: "x", age: "old" },
    { condition: "x", sex: "other" }, { condition: "x", region: "" }, { condition: "x", status: "closed" }, { condition: "x".repeat(201) }]) {
    const answer = candidateRequest(bad);
    assert.equal(answer.ok, false, JSON.stringify(bad).slice(0, 60));
    assert.match(answer.message, /filter\./);
  }
});

test("what a record states is read through closed tables: age bounds, sex, countries; what it does not state is unknown", () => {
  assert.equal(ageFit(ageBands({ registry: "clinicaltrials.gov", minimumAge: "18 Years", maximumAge: "75 Years" }), 75), "ok");
  assert.equal(ageFit(ageBands({ registry: "clinicaltrials.gov", minimumAge: "18 Years", maximumAge: "75 Years" }), 76), "outside");
  assert.equal(ageFit(ageBands({ registry: "clinicaltrials.gov", minimumAge: "6 Months", maximumAge: "N/A" }), 0.4), "outside");
  assert.equal(ageFit(ageBands({ registry: "clinicaltrials.gov", minimumAge: "6 Months", maximumAge: "N/A" }), 0.6), "ok");
  assert.equal(ageFit(ageBands({ registry: "clinicaltrials.gov", minimumAge: "N/A", maximumAge: "N/A" }), 90), "ok", "stated, with no bounds");
  assert.equal(ageFit(ageBands({ registry: "clinicaltrials.gov", minimumAge: null, maximumAge: null }), 40), "unknown", "not stated");
  assert.equal(ageFit(ageBands({ registry: "clinicaltrials.gov", minimumAge: "eighteen", maximumAge: "" }), 40), "unknown", "a word the table does not know is not a bound");
  assert.equal(ageFit(ageBands({ registry: "ctis", ageGroup: "0-17 years, 65+ years" }), 40), "outside", "the group the patient is not in");
  assert.equal(ageFit(ageBands({ registry: "ctis", ageGroup: "0-17 years, 65+ years" }), 17.5), "ok");
  assert.equal(ageFit(ageBands({ registry: "ctis", ageGroup: "" }), 40), "unknown");
  assert.deepEqual(["ALL", "MALE", "FEMALE", "Male, Female", "female", "", "Unknown"].map(sexOf), ["ALL", "MALE", "FEMALE", "ALL", "FEMALE", null, null]);
  assert.deepEqual([sexFit("ALL", "male"), sexFit("FEMALE", "male"), sexFit("MALE", "male"), sexFit(null, "male")], ["ok", "outside", "ok", "unknown"]);
  assert.deepEqual([regionFit(["China", "Japan"], "china"), regionFit(["Germany"], "China"), regionFit(null, "China"), regionFit([], "China")], ["ok", "outside", "unknown", "unknown"]);
});

test("one trial listed twice is one candidate: by id within a registry, and across registries by the other registration its record states", () => {
  const a = ctgovCandidate(ctgov("NCT07100001", { secondaryIds: ["2024-513060-26-00", "ChiCTR2400000009"] }));
  const again = ctgovCandidate(ctgov("NCT07100001"));
  const eu = ctisCandidate(ctis("2024-513060-26-00"));
  const cn = chictrCandidate(chictr("ChiCTR2400000009"));
  const other = chictrCandidate(chictr("ChiCTR2400000010"));
  const merged = mergeCandidates([a, again, eu, other, cn]);
  assert.deepEqual(merged.map((candidate) => candidate.registryId), ["NCT07100001", "ChiCTR2400000010"]);
  assert.deepEqual(merged[0].alsoRegisteredAs, [{ registry: "ctis", registryId: "2024-513060-26-00" }, { registry: "chictr", registryId: "ChiCTR2400000009" }],
    "the registry whose record has eligibility text is kept and names the others");
  assert.equal(merged[0].eligibilityText, "in_record");
  assert.equal(merged[1].eligibilityText, "not_in_listing");
  // Case and spacing do not make two ids.
  assert.equal(mergeCandidates([chictrCandidate(chictr("ChiCTR2400000011")), chictrCandidate(chictr("chictr 2400000011".replace("chictr ", "ChiCTR")))]).length, 1);
});

test("the filters leave out what a record's own stated fields rule out, count it under the first filter that did, and keep what is not stated, marked unknown", () => {
  const rows = [
    ctgovCandidate(ctgov("NCT07100002")),
    ctgovCandidate(ctgov("NCT07100003", { overallStatus: "COMPLETED" })),
    ctgovCandidate(ctgov("NCT07100004", { minimumAge: "70 Years" })),
    ctgovCandidate(ctgov("NCT07100005", { sex: "MALE" })),
    ctgovCandidate(ctgov("NCT07100006", { countries: ["Germany"] })),
    ctgovCandidate(ctgov("NCT07100007", { overallStatus: "COMPLETED", minimumAge: "70 Years" })),
    ctgovCandidate(ctgov("NCT07100008", { countries: null, sex: null })),
    chictrCandidate(chictr("ChiCTR2400000012")),
    ctisCandidate(ctis("2024-513061-26-00", { ageGroup: "65+ years" })),
  ];
  const { kept, dropped } = filterCandidates(mergeCandidates(rows), { age: 63, sex: "female", region: "China", scope: "open" });
  assert.deepEqual(kept.map((candidate) => [candidate.registryId, candidate.unknown]), [
    ["NCT07100002", []],
    ["NCT07100008", ["sex", "region"]],
    ["ChiCTR2400000012", ["age", "sex", "region"]],
  ], "a listing that states nothing is not dropped for it (its status is the one word the table knows)");
  // Closed (2, one of them also under the age bound and counted once, under status), the age bound (1) and CTIS's age group (1), the sex (1), the other country (1).
  assert.deepEqual(dropped, { status: 2, age: 2, sex: 1, region: 1 });
  // With no filters nothing is left out; with status any, a closed trial stays.
  const open = filterCandidates(mergeCandidates(rows), { age: null, sex: null, region: null, scope: "open" });
  assert.equal(open.kept.length, 7, "the two closed ones are the only ones out when only the status is asked for");
  assert.equal(filterCandidates(mergeCandidates(rows), { age: null, sex: null, region: null, scope: "any" }).kept.length, rows.length);
  // A word the status table does not know is unknown, not closed.
  assert.deepEqual(filterCandidates([ctgovCandidate(ctgov("NCT07100009", { overallStatus: "Some New Word" }))], { age: null, sex: null, region: null, scope: "open" }).kept[0].unknown, ["status"]);
});

test("the list is cut to its size taking the registries in turn, and says when there is more", () => {
  const rows = [
    ...[1, 2, 3, 4].map((n) => ({ registry: "clinicaltrials.gov", registryId: `NCT0720000${n}` })),
    ...[1, 2].map((n) => ({ registry: "ctis", registryId: `2024-51306${n}-26-00` })),
    ...[1, 2, 3].map((n) => ({ registry: "chictr", registryId: `ChiCTR240000002${n}` })),
  ];
  const first = interleave(rows, 5);
  assert.deepEqual(first.list.map((row) => row.registryId), ["NCT07200001", "2024-513061-26-00", "ChiCTR2400000021", "NCT07200002", "2024-513062-26-00"]);
  assert.equal(first.more, true);
  assert.equal(interleave(rows, 20).more, false);
  assert.deepEqual(interleave(rows, 20).list.map((row) => row.registry), ["clinicaltrials.gov", "ctis", "chictr", "clinicaltrials.gov", "ctis", "chictr", "clinicaltrials.gov", "chictr", "clinicaltrials.gov"]);
  assert.deepEqual(interleave([], 5), { list: [], more: false });
});

test("a registry's searches come to a state: searched, partial, failed, or not configured; and the coverage is a sentence the run can copy", () => {
  assert.equal(registryOutcome([{ query: "a", status: "ok", found: 3, total: 9 }]).state, "searched");
  const partial = registryOutcome([{ query: "a", status: "ok", found: 3, total: 9 }, { query: "b", status: REGISTRY_UNAVAILABLE, reason: "timeout", found: 0 }]);
  assert.deepEqual([partial.state, partial.searched, partial.failed], ["partial", [{ query: "a", found: 3, total: 9 }], [{ query: "b", reason: "timeout" }]]);
  assert.equal(registryOutcome([{ query: "a", status: REGISTRY_UNAVAILABLE, reason: "timeout", found: 0 }]).state, "failed");
  assert.equal(registryOutcome([{ query: "a", status: REGISTRY_UNAVAILABLE, reason: "registry_not_configured", found: 0 }]).state, "not_configured");
  const sentence = coverageSentence([
    { registry: "clinicaltrials.gov", name: "ClinicalTrials.gov", state: "searched", failed: [] },
    { registry: "ctis", name: "CTIS", state: "failed", failed: [{ reason: "timeout" }, { reason: "timeout" }] },
    { registry: "chictr", name: "ChiCTR", state: "not_configured", failed: [{ reason: "registry_not_configured" }] },
  ], "2026-11-01T08:00:00.000Z");
  assert.match(sentence, /已查（2026-11-01）：ClinicalTrials\.gov/);
  assert.match(sentence, /CTIS没查到：timeout/);
  assert.match(sentence, /ChiCTR没查到：本部署或本账户没有接入/);
  assert.match(sentence, /没有覆盖：.*CDE.*ICTRP/);
  assert.deepEqual(CANDIDATES_NOT_COVERED.map((entry) => entry.id), ["cde", "ictrp"]);
});

// --- the pipeline over registry doubles ---------------------------------------------------

/** A registry client double that records what it is asked. @param {Record<string, any>} [overrides] */
function registryDouble(overrides = {}) {
  const asked = { ctgov: [], ctis: [], chictr: [] };
  return {
    asked,
    async search(request) {
      asked.ctgov.push(request);
      return overrides.ctgov?.(request) ?? { status: "ok", total: 2, retrievedAt: AT, items: [
        ctgov("NCT07300001", { secondaryIds: ["2024-513070-26-00"] }), ctgov("NCT07300002", { overallStatus: "NOT_YET_RECRUITING", countries: ["Germany"] })] };
    },
    async searchCtis(request) {
      asked.ctis.push(request);
      return overrides.ctis?.(request) ?? { status: "ok", total: 1, retrievedAt: AT, items: [ctis("2024-513070-26-00"), ctis("2024-513071-26-00", { ageGroup: "0-17 years" })] };
    },
    async searchChictr(request) {
      asked.chictr.push(request);
      return overrides.chictr?.(request) ?? { status: "ok", total: 1, retrievedAt: AT, items: [chictr("ChiCTR2400000031")] };
    },
  };
}

test("the candidates of one search: three registries, merged, the duplicate once, the filters applied, the coverage said (M1)", async () => {
  const registry = registryDouble();
  const pipeline = createVcrEvidencePipeline({ store: {}, registry, now: () => NOW });
  const answer = await pipeline.patientCandidates({ userId: "u1", filter: { condition: "non-small cell lung cancer", terms: ["非小细胞肺癌"], age: 63, sex: "female", region: "China" } });
  assert.equal(answer.available, true);
  assert.equal(answer.status, "ok");
  assert.equal(answer.asOf, NOW.toISOString());
  // Each phrase went to each registry: the condition as a condition, the phrase as a term; ChiCTR takes both as text.
  assert.deepEqual(registry.asked.ctgov.map((request) => [request.condition ?? null, request.term ?? null]), [["non-small cell lung cancer", null], [null, "非小细胞肺癌"]]);
  assert.ok(registry.asked.ctgov.every((request) => request.forPatient === true && request.withLocations === true && request.status.includes("RECRUITING")), "the sites are asked for because a country was named");
  assert.deepEqual(registry.asked.ctis.map((request) => [request.condition ?? null, request.term ?? null, request.statuses]), [["non-small cell lung cancer", null, [2, 3, 4]], [null, "非小细胞肺癌", [2, 3, 4]]]);
  assert.deepEqual(registry.asked.chictr.map((request) => [request.query, request.userId]), [["non-small cell lung cancer", "u1"], ["非小细胞肺癌", "u1"]]);

  assert.deepEqual(answer.candidates.map((candidate) => candidate.registryId), ["NCT07300001", "ChiCTR2400000031"], "the registries in turn, each in its own order");
  const first = answer.candidates[0];
  assert.deepEqual(first.alsoRegisteredAs, [{ registry: "ctis", registryId: "2024-513070-26-00" }], "the EU registration the CT.gov record states is the same trial");
  assert.equal(first.eligibilityText, "in_record");
  assert.deepEqual(first.unknown, []);
  const listing = answer.candidates.find((candidate) => candidate.registry === "chictr");
  assert.equal(listing.eligibilityText, "not_in_listing");
  assert.deepEqual(listing.unknown, ["age", "sex", "region"], "nothing the registry did not state is made up, and the candidate is kept");
  // NCT07300002 runs in Germany only; the CTIS trial for children is outside the age: both counted, neither listed.
  assert.deepEqual(answer.leftOut, { status: 0, age: 1, sex: 0, region: 1 });
  assert.deepEqual(answer.registries.map((entry) => [entry.registry, entry.state, entry.searched.length, entry.failed.length]),
    [["clinicaltrials.gov", "searched", 2, 0], ["ctis", "searched", 2, 0], ["chictr", "searched", 2, 0]]);
  assert.match(answer.registries.find((entry) => entry.registry === "chictr").limits, /没有入排条件原文/);
  assert.deepEqual(answer.notCovered.map((entry) => entry.registry), ["cde", "ictrp"]);
  assert.match(answer.coverage, /已查（2026-11-01）/);
  assert.match(answer.coverage, /没有覆盖：.*CDE.*ICTRP/);
  assert.equal(answer.registryReadAt, AT);
  assert.equal(JSON.stringify(answer).includes('"score"'), false, "no candidate carries a score");
});

test("a registry that fails costs its own results and says so; the others stand (M1)", async () => {
  const registry = registryDouble({ ctis: () => ({ status: REGISTRY_UNAVAILABLE, reason: "timeout", items: [], total: null }) });
  const pipeline = createVcrEvidencePipeline({ store: {}, registry, now: () => NOW });
  const answer = await pipeline.patientCandidates({ userId: "u1", filter: { condition: "lung cancer", terms: ["NSCLC"] } });
  assert.equal(answer.status, "ok", "two registries answered");
  assert.ok(answer.candidates.length >= 2);
  const row = answer.registries.find((entry) => entry.registry === "ctis");
  assert.deepEqual([row.state, row.failed, row.searched], ["failed", [{ query: "lung cancer", reason: "timeout" }, { query: "NSCLC", reason: "timeout" }], []]);
  assert.match(answer.coverage, /CTIS.*没查到：timeout/);

  // One phrase of one registry failing leaves the registry partial and its other phrase's results in.
  let calls = 0;
  const partial = createVcrEvidencePipeline({ store: {}, now: () => NOW, registry: registryDouble({ chictr: () => (++calls === 1
    ? { status: "ok", total: 1, retrievedAt: AT, items: [chictr("ChiCTR2400000041")] } : { status: REGISTRY_UNAVAILABLE, reason: "http_500", items: [] }) }) });
  const one = await partial.patientCandidates({ userId: "u1", filter: { condition: "肺癌", terms: ["肺腺癌"] } });
  const chictrRow = one.registries.find((entry) => entry.registry === "chictr");
  assert.deepEqual([chictrRow.state, chictrRow.searched.length, chictrRow.failed], ["partial", 1, [{ query: "肺腺癌", reason: "http_500" }]]);
  assert.ok(one.candidates.some((candidate) => candidate.registryId === "ChiCTR2400000041"));
  assert.match(one.coverage, /部分检索词失败/);

  // A client that throws is a registry that did not answer, not a failed read.
  const thrown = createVcrEvidencePipeline({ store: {}, now: () => NOW, registry: registryDouble({ ctgov: () => { throw Object.assign(new Error("boom"), { code: "ECONNRESET" }); } }) });
  const survived = await thrown.patientCandidates({ userId: "u1", filter: { condition: "x" } });
  assert.deepEqual(survived.registries.find((entry) => entry.registry === "clinicaltrials.gov").failed, [{ query: "x", reason: "ECONNRESET" }]);
  assert.ok(survived.candidates.length > 0);
});

test("when no registry answers the answer says so and lists nothing; a deployment without a registry client says it is unavailable (M1)", async () => {
  const down = () => ({ status: REGISTRY_UNAVAILABLE, reason: "registry_not_configured", items: [], total: null });
  const none = await createVcrEvidencePipeline({ store: {}, now: () => NOW, registry: registryDouble({ ctgov: down, ctis: down, chictr: down }) })
    .patientCandidates({ userId: "u1", filter: { condition: "x" } });
  assert.equal(none.available, true);
  assert.equal(none.status, REGISTRY_UNAVAILABLE);
  assert.deepEqual(none.candidates, []);
  assert.deepEqual(none.registries.map((entry) => entry.state), ["not_configured", "not_configured", "not_configured"]);
  assert.match(none.coverage, /没有一个登记库查通/);
  const absent = await createVcrEvidencePipeline({ store: {}, registry: null }).patientCandidates({ userId: "u1", filter: { condition: "x" } });
  assert.deepEqual([absent.available, absent.code], [false, "registry_unavailable"]);
  const refused = await createVcrEvidencePipeline({ store: {}, registry: registryDouble() }).patientCandidates({ userId: "u1", filter: { condition: "" } });
  assert.deepEqual([refused.available, refused.code], [false, "vcr_read_filter_invalid"]);
});

test("the list is capped and says there is more; the registry is asked for twice that, and a status of any is not sent as a filter (M1)", async () => {
  const many = (prefix, n) => Array.from({ length: n }, (_, at) => ctgov(`NCT${prefix}${String(at).padStart(4, "0")}`));
  const registry = registryDouble({ ctgov: () => ({ status: "ok", total: 40, retrievedAt: AT, items: many("0731", 12) }),
    ctis: () => ({ status: "ok", total: 0, retrievedAt: AT, items: [] }), chictr: () => ({ status: "ok", total: 0, retrievedAt: AT, items: [] }) });
  const answer = await createVcrEvidencePipeline({ store: {}, registry, now: () => NOW }).patientCandidates({ userId: "u1", filter: { condition: "x", limit: 5, status: "any" }, limitMax: 20 });
  assert.equal(answer.candidates.length, 5);
  assert.equal(answer.more, true);
  assert.equal(answer.found, 12);
  assert.equal(registry.asked.ctgov[0].limit, 10, "twice the list's size, never less than ten");
  assert.deepEqual(registry.asked.ctgov[0].status, []);
  assert.equal(registry.asked.ctgov[0].withLocations, false, "no country named, no sites asked for");
});

// --- the service: a read of its own that needs no study ------------------------------------------------

test("candidates is a read of its own, a registry search that needs no study, and it marks the trials the account has structured before (M1, M2)", async () => {
  assert.ok(VCR_READ_WHATS.includes("candidates"));
  const evidence = createVcrEvidencePipeline({ store: {}, registry: registryDouble(), now: () => NOW });
  const held = [];
  const patientTrials = { async parsedHeld(study, trials) { held.push([study.userId, trials.map((trial) => trial.registryId)]); return new Set(["clinicaltrials.gov\u0000NCT07300001"]); } };
  const service = new VcrService({ store: {}, config: { vcrCandidateSearchMax: 3 }, evidence, patientTrials });
  const answer = await service.runtimeRead({ id: null, userId: "u1", projectId: "prj_1", scope: "conversation" }, "candidates", { condition: "lung cancer" });
  assert.equal(answer.available, true);
  assert.equal(answer.candidates.length, 3, "the deployment's size caps the list");
  assert.equal(answer.candidates[0].registryId, "NCT07300001");
  assert.equal(answer.candidates[0].parsedBefore, true);
  assert.ok(answer.candidates.slice(1).every((candidate) => candidate.parsedBefore === undefined));
  assert.equal(held[0][0], "u1");
  // The registry's own figures are not this study's people: nothing is hollowed by the small-cell floor.
  assert.equal(answer.registries[0].searched[0].total, 2);
  const absent = await new VcrService({ store: {}, config: {} }).runtimeRead({ id: null, userId: "u1", scope: "conversation" }, "candidates", { condition: "x" });
  assert.deepEqual([absent.available, absent.code], [false, "registry_unavailable"]);
});
