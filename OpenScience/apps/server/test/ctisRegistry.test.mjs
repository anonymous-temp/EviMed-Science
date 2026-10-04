// The EU CTIS registry source: the public portal's JSON API, recorded from the
// wire on 2026-10-04 (`fixtures/ctis/provenance.json` says which request each
// file answers, and that two of them had contact e-mail and telephone values
// replaced before commit). Every number asserted about a fixture below was read
// from the fixture with `jq`, independently of the client.
//
// What a registry source owes a page: candidates and a record when the registry
// answers, and a NAMED state when it does not — configured / queried /
// successful-empty / unavailable — never an empty list for a registry that was
// not asked or would not answer.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CTIS_BASE_URL, CTIS_PUBLIC_STATUS, REGISTRY_NOT_FOUND, REGISTRY_UNAVAILABLE, createTrialRegistryClient,
  ctisDate, ctisListItem, ctisPhaseCodes, ctisPhasesOf, ctisPrecedent, reducedCtisRecord, renderRegistryRecordText,
} from "../src/trialRegistryClient.mjs";
import { createVcrEvidencePipeline, verifyExtraction } from "../src/vcrEvidence.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(path.join(HERE, "fixtures", "ctis", name), "utf8"));
const AT = "2026-10-04T12:00:00.000Z";
const AUTHORISED = "2026-525672-26-01";
const ENDED = "2024-513060-26-00";

/** A scripted portal: `script(url, init)` answers `{ body | raw | status | abort }`. */
function portal(script) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : null, headers: init?.headers ?? {} });
    const answer = await script(String(url), init);
    if (answer.abort) {
      return new Promise((_resolve, reject) => {
        // A real socket keeps the event loop alive while it waits; so does this stand-in (Node 22 cancels a test that waits on an unref'd timer).
        const hold = setTimeout(() => {}, 60_000);
        init?.signal?.addEventListener("abort", () => { clearTimeout(hold); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); });
      });
    }
    if (answer.throw) throw answer.throw;
    return new Response(answer.raw ?? JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, seen };
}
const noSleep = async () => {};
const clientOver = (script, extra = {}) => {
  const { fetchImpl, seen } = portal(script);
  return { client: createTrialRegistryClient({ fetchImpl, now: () => new Date(AT), sleep: noSleep, ...extra }), seen };
};
const ctis = (client) => client.coverage().find((entry) => entry.key === "ctis");

test("the portal's own status and phase tables, dates and phase words are closed vocabularies", () => {
  assert.equal(Object.keys(CTIS_PUBLIC_STATUS).length, 12);
  assert.equal(CTIS_PUBLIC_STATUS[8], "Ended");
  // `trialPhase` is a code in a record and a label in a search item; both are the same phases.
  assert.deepEqual(ctisPhasesOf("4"), ["PHASE2"]);
  assert.deepEqual(ctisPhasesOf("Therapeutic exploratory (Phase II)"), ["PHASE2"]);
  assert.deepEqual(ctisPhasesOf("Therapeutic confirmatory  (Phase III)"), ["PHASE3"], "the portal's own double space");
  assert.deepEqual(ctisPhasesOf("7"), ["PHASE1", "PHASE2"]);
  assert.deepEqual(ctisPhasesOf("Phase II and Phase III (Integrated)"), ["PHASE2", "PHASE3"]);
  assert.deepEqual(ctisPhasesOf("a phase of its own"), []);
  // The other way: PHASE2 asks for phase II alone, not for the integrated I/II or II/III.
  assert.deepEqual(ctisPhaseCodes(["PHASE2"]), [4]);
  assert.deepEqual(ctisPhaseCodes(["PHASE1", "PHASE2"]), [1, 2, 3, 4, 7, 8, 9]);
  assert.deepEqual(ctisPhaseCodes(["PHASE3", "phase4"]), [5, 6, 11]);
  assert.deepEqual(ctisPhaseCodes([]), []);
  assert.equal(ctisDate("01/10/2026"), "2026-10-01");
  assert.equal(ctisDate("2026-10-01T07:49:20.989"), "2026-10-01");
  assert.equal(ctisDate("2026-10-02T03:35:19.102067131"), "2026-10-02");
  for (const bad of ["", null, undefined, "31/02/2026", "2026-13-01", "ES: 01/10/2026", "October", 20261001]) assert.equal(ctisDate(bad), "", String(bad));
});

test("a search item is a candidate: status and phase in words, planned enrolment never a baseline, contacts nowhere", () => {
  const page = fixture("search-breast-cancer-page1.json");
  assert.equal(page.data.length, 2);
  const first = ctisListItem(page.data[0]);
  // jq over the fixture's first item.
  assert.equal(first.registryId, "2026-525672-26-01");
  assert.equal(first.overallStatus, "Authorised, recruitment pending");
  assert.equal(first.statusCode, 2);
  assert.deepEqual(first.phases, ["PHASE2"]);
  assert.equal(first.decisionDate, "2026-10-01");
  assert.equal(first.enrollment, 150);
  assert.equal(first.enrollmentKind, null, "the list says only how many; planned or actual is not stated, so it is never a baseline");
  assert.deepEqual(first.countries, ["Spain"]);
  assert.deepEqual(first.conditions, ["Increased risk of breast cancer"]);
  assert.equal(first.hasResults, false);
  assert.equal(first.url, "https://euclinicaltrials.eu/ctis-public/view/2026-525672-26-01");
  assert.match(first.primaryEndpoint, /^Relative percentage change in mammographic breast density/);
  const second = ctisListItem(page.data[1]);
  assert.deepEqual(second.countries, ["France", "Italy", "Spain", "Portugal", "Germany", "Belgium"]);
  assert.deepEqual(second.phases, ["PHASE1"]);
  assert.equal(second.sponsor, "Novartis Pharma AG");
  assert.equal(second.decisionDate, "2026-09-29", "the overall decision date, not the per-country list");
  // An item with no usable number is not a candidate.
  assert.equal(ctisListItem({}).registryId, "");
});

test("a search is one POST of the portal's own body, answered with candidates, a total and the next page", async () => {
  const { client, seen } = clientOver(() => ({ body: fixture("search-breast-cancer-page1.json") }));
  const result = await client.searchCtis({ condition: "breast cancer", intervention: "linzagolix", term: "mammographic", phases: ["PHASE2"], statuses: [3, 4, 99], hasResults: false, limit: 2 });
  assert.equal(result.status, "ok");
  assert.equal(result.registry, "ctis");
  assert.equal(result.total, 460);
  assert.equal(result.nextPageToken, "2");
  assert.equal(result.retrievedAt, AT);
  assert.deepEqual(result.items.map((item) => item.registryId), ["2026-525672-26-01", "2024-518348-19-00"]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, `${CTIS_BASE_URL}/search`);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].headers["content-type"], "application/json");
  assert.deepEqual(seen[0].body, {
    pagination: { page: 1, size: 2 }, sort: { property: "decisionDate", direction: "DESC" },
    searchCriteria: { containAll: "mammographic", medicalCondition: "breast cancer", productName: "linzagolix", trialPhaseCode: [4], status: [3, 4], hasStudyResults: false },
  });
  assert.deepEqual(ctis(client), { key: "ctis", label: "EU CTIS", configured: true, coverage: "structured", availability: "available", reason: null, lastCheckedAt: AT });
  assert.equal(client.status().counters.searches, 1);
});

test("paging is by page number: the next token is the next page, and the last page has none", async () => {
  const { client, seen } = clientOver((url, init) => {
    const page = JSON.parse(init.body).pagination.page;
    return { body: page === 1000 ? fixture("search-breast-cancer-page1000.json") : { ...fixture("search-breast-cancer-page1.json"), pagination: { totalRecords: 460, currentPage: page, totalPages: 230, nextPage: true, prevPage: page > 1 } } };
  });
  assert.equal((await client.searchCtis({ condition: "x", limit: 2, pageToken: "7" })).nextPageToken, "8");
  assert.equal(seen[0].body.pagination.page, 7);
  // A token that is not a page number is page one, never a request for page NaN.
  await client.searchCtis({ condition: "x", limit: 2, pageToken: "garbage" });
  assert.equal(seen[1].body.pagination.page, 1);
  // Past the last page the portal answers 200 with the real total and no rows: that is a successful search with nothing on this page.
  const past = await client.searchCtis({ condition: "breast cancer", limit: 2, pageToken: "1000" });
  assert.equal(past.status, "ok");
  assert.deepEqual([past.items.length, past.total, past.nextPageToken], [0, 460, null]);
  // The page size is held to the portal's 1 to 100.
  await client.searchCtis({ condition: "x", limit: 5000 });
  await client.searchCtis({ condition: "x", limit: 0 });
  assert.deepEqual(seen.slice(-2).map((call) => call.body.pagination.size), [100, 1]);
});

test("a search that matches nothing is a successful empty answer, and says the registry answered", async () => {
  const { client } = clientOver(() => ({ body: fixture("search-no-match.json") }));
  const result = await client.searchCtis({ term: "zzzqqqxxyy" });
  assert.deepEqual([result.status, result.total, result.items, result.nextPageToken], ["ok", 0, [], null]);
  assert.equal(ctis(client).availability, "available");
  assert.equal(ctis(client).reason, null);
});

test("a body the portal refuses reads as unreadable, never as 0 results: it answers 200, showWarning and no rows", async () => {
  const { client } = clientOver(() => ({ body: fixture("search-refused-body.json") }));
  const result = await client.searchCtis({ term: "anything" });
  assert.equal(result.status, REGISTRY_UNAVAILABLE);
  assert.equal(result.reason, "registry_answer_unreadable");
  assert.deepEqual(result.items, []);
  assert.equal(result.total, null, "no total is claimed for a search that was not answered");
  assert.deepEqual(ctis(client), { key: "ctis", label: "EU CTIS", configured: true, coverage: "structured", availability: "unavailable", reason: "registry_answer_unreadable", lastCheckedAt: AT });
  // The same for an answer that is not the portal's shape at all.
  for (const body of [{}, { data: [] }, { pagination: { totalRecords: 1 } }, { data: "x", pagination: {} }, []]) {
    const odd = clientOver(() => ({ body }));
    assert.equal((await odd.client.searchCtis({ term: "x" })).reason, "registry_answer_unreadable", JSON.stringify(body));
  }
  const text = clientOver(() => ({ raw: "<html>maintenance</html>" }));
  assert.equal((await text.client.searchCtis({ term: "x" })).status, REGISTRY_UNAVAILABLE);
});

test("an upstream that is down is unavailable with a named reason, retried inside one deadline, and recovers", async () => {
  let answer = { status: 503 };
  const { client, seen } = clientOver(() => answer, { maxAttempts: 3 });
  const down = await client.searchCtis({ term: "x" });
  assert.equal(down.status, REGISTRY_UNAVAILABLE);
  assert.equal(down.reason, "http_503");
  assert.deepEqual(down.items, []);
  assert.equal(seen.length, 3, "a 5xx is retried, a search being safe to repeat");
  assert.equal(client.status().counters.retried, 2);
  assert.deepEqual([ctis(client).availability, ctis(client).reason], ["unavailable", "http_503"]);
  answer = { status: 404 };
  assert.equal((await client.searchCtis({ term: "x" })).reason, "http_404", "a missing search endpoint is the endpoint gone, not a trial that is not there");
  answer = { status: 400 };
  const bad = await client.searchCtis({ term: "x" });
  assert.equal(bad.reason, "http_400");
  answer = { throw: Object.assign(new Error("nope"), { code: "ENOTFOUND" }) };
  assert.equal((await client.searchCtis({ term: "x" })).reason, "ENOTFOUND");
  answer = { body: fixture("search-breast-cancer-page1.json") };
  assert.equal((await client.searchCtis({ term: "x" })).status, "ok");
  assert.deepEqual([ctis(client).availability, ctis(client).reason], ["available", null]);
  // The other registries' rows were never touched by any of it.
  assert.equal(client.coverage().find((entry) => entry.key === "clinicaltrials.gov").availability, "not_queried");
});

test("a portal that does not answer in time is a timeout, not an empty list", async () => {
  const { client } = clientOver(() => ({ abort: true }), { timeoutMs: 300, maxAttempts: 1 });
  const result = await client.searchCtis({ term: "x" });
  assert.equal(result.status, REGISTRY_UNAVAILABLE);
  assert.equal(result.reason, "timeout");
  assert.equal(ctis(client).reason, "timeout");
});

test("an unconfigured CTIS seat answers by name and makes no request", async () => {
  const { client, seen } = clientOver(() => { throw new Error("must not query"); }, { ctisBaseUrl: "" });
  assert.deepEqual(ctis(client), { key: "ctis", label: "EU CTIS", configured: false, coverage: "structured", availability: "unavailable", reason: "registry_not_configured", lastCheckedAt: null });
  assert.equal((await client.searchCtis({ term: "x" })).reason, "registry_not_configured");
  assert.equal((await client.recordCtis(AUTHORISED)).reason, "registry_not_configured");
  assert.deepEqual(seen, []);
  assert.equal(client.ctisConfigured, false);
  const configured = clientOver(() => ({ body: {} }));
  assert.equal(configured.client.ctisConfigured, true);
});

test("an authorised, not-yet-started trial: what the application states, planned and never actual", () => {
  const built = ctisPrecedent(fixture(`retrieve-authorised-${AUTHORISED}.json`), { retrievedAt: AT });
  const { precedent, extractions, record } = built;
  assert.equal(precedent.registry, "ctis");
  assert.equal(precedent.registryId, AUTHORISED);
  assert.equal(record.url, "https://euclinicaltrials.eu/ctis-public/view/2026-525672-26-01");
  assert.match(precedent.title, /^Study evaluating whether linzagolix or bilastine/, "the public title is preferred to the full one");
  assert.deepEqual(precedent.pico.conditions, ["Increased risk of breast cancer"]);
  assert.deepEqual(precedent.pico.interventions.map((item) => [item.name, item.type]), [
    ["Yselty 100 mg film-coated tablets", "Test"], ["Bilastina Teva 20 mg comprimidos bucodispersables EFG", "Test"],
  ]);
  assert.deepEqual(precedent.pico.stdAges, ["18-64 years"]);
  assert.equal(precedent.pico.sex, "FEMALE");
  assert.equal(precedent.pico.healthyVolunteers, false);
  assert.deepEqual(precedent.design.phases, ["PHASE2"]);
  assert.equal(precedent.design.overallStatus, "Authorised");
  assert.equal(precedent.design.leadSponsor, "Consorci Mar Parc De Salut De Barcelona");
  assert.equal(precedent.design.hasResults, false);
  // jq: three arms in one treatment period, each a title and free text; no structured arm type is read out of the words.
  assert.deepEqual(precedent.design.arms.map((arm) => [arm.label, arm.type]), [["Linzagolix", ""], ["Bilastine", ""], ["Lifestyle intervention", ""]]);
  assert.match(precedent.design.arms[0].description, /^Experimental, Linzagolix 100 mg/);
  assert.equal(precedent.design.allocationCode, "1");
  assert.equal(precedent.design.allocation, "", "a code the portal publishes no table for is carried as a code, not interpreted");
  // jq: 6 principal inclusion and 16 exclusion criteria, 1 primary and 7 secondary endpoints.
  assert.equal((precedent.eligibilityText.match(/^- /gm) ?? []).length, 22);
  assert.match(precedent.eligibilityText, /^Principal inclusion criteria:\n- Women aged 35 to 50 years\./);
  assert.deepEqual(precedent.endpoints.map((entry) => entry.role), ["primary", ...Array(7).fill("secondary")]);
  assert.match(precedent.endpoints[0].measure, /^Relative percentage change in mammographic breast density/);
  // jq: Spain 150 planned, rest of the world 0, one site; no notified events yet.
  assert.deepEqual([precedent.enrollment.planned, precedent.enrollment.actual, precedent.enrollmentKind], [150, null, "estimated"]);
  assert.deepEqual(precedent.sites, { count: 1, countries: ["Spain"], countryCount: 1, listTruncated: false });
  assert.deepEqual(precedent.enrollment.milestones, {
    recruitment_start_date: { date: "2026-10-01", type: "estimated" }, completion_date: { date: "2029-03-31", type: "estimated" },
  });
  assert.deepEqual(extractions.map((item) => item.parameter), ["enrollment_estimated", "recruitment_start_date", "completion_date", "site_count"]);
  for (const item of extractions) assert.equal(item.historicalBaseline, item.parameter === "site_count", `${item.parameter}: a plan is never a baseline`);
  const planned = extractions[0];
  assert.deepEqual([planned.value, planned.enrollmentKind, planned.valueSource, planned.detail.country], [150, "estimated", "extracted", "Spain"]);
  assert.equal(extractions[3].valueSource, "calculated");
  // What the public record does not carry is named, never zeroed.
  const missing = precedent.unavailable.map((entry) => entry.parameter);
  for (const parameter of ["enrollment_actual", "arm_types", "outcome_measures", "screen_failure_rate", "site_activation_date"]) assert.ok(missing.includes(parameter), parameter);
  assert.ok(!missing.includes("arm_definitions"), "this record does state its arms");
  assert.equal(precedent.sources[0].recordHash, record.hash);
});

test("an ended trial in three member states: notified dates are actual, the planned and the actual are kept apart", () => {
  const { precedent, extractions } = ctisPrecedent(fixture(`retrieve-ended-${ENDED}.json`), { retrievedAt: AT });
  assert.equal(precedent.design.overallStatus, "Ended");
  assert.deepEqual(precedent.design.phases, ["PHASE1", "PHASE2"]);
  assert.equal(precedent.design.hasResults, true);
  assert.deepEqual(precedent.results.summaryDocuments.map((entry) => [entry.type, entry.version, entry.submitted]), [
    ["Summary of Results", "Final", "2025-02-18"], ["Laypersons Summary of Results", "Final", "2025-02-18"],
  ]);
  assert.equal(precedent.results.outcomeMeasures, 0, "a summary of results is a document: no outcome number is read out of it");
  assert.equal(precedent.pico.sex, "ALL");
  assert.deepEqual(precedent.pico.stdAges, ["18-64 years", "65+ years"]);
  assert.deepEqual(precedent.design.arms, [], "the public part of this record lists no arms");
  assert.ok(precedent.unavailable.some((entry) => entry.parameter === "arm_definitions"));
  // jq: 8 + 8 + 8 planned in France, Germany and Spain; 26 for the rest of the world; 2 + 2 + 4 sites.
  assert.deepEqual([precedent.enrollment.planned, precedent.enrollmentKind], [24, "estimated"]);
  assert.deepEqual(precedent.sites, { count: 8, countries: ["France", "Germany", "Spain"], countryCount: 3, listTruncated: false });
  const byParameter = Object.groupBy(extractions, (item) => item.parameter);
  assert.deepEqual(byParameter.enrollment_estimated.map((item) => [item.value, item.detail.country]), [[8, "France"], [8, "Germany"], [8, "Spain"]]);
  assert.deepEqual(byParameter.enrollment_estimated_rest_of_world.map((item) => item.value), [26]);
  // jq: startDateEU 2021-04-07 and endDateEU 2024-09-17 are notified events (actual); the application's estimated recruitment start is a plan.
  assert.deepEqual([byParameter.start_date[0].valueText, byParameter.start_date[0].enrollmentKind, byParameter.start_date[0].historicalBaseline], ["2021-04-07", "actual", true]);
  assert.deepEqual([byParameter.completion_date[0].valueText, byParameter.completion_date[0].enrollmentKind], ["2024-09-17", "actual"]);
  assert.equal(byParameter.completion_date.length, 1, "the planned end is not stored beside the actual one");
  assert.deepEqual([byParameter.recruitment_start_date[0].valueText, byParameter.recruitment_start_date[0].enrollmentKind, byParameter.recruitment_start_date[0].historicalBaseline], ["2021-09-21", "estimated", false]);
  // 2021-04-07 to 2024-09-17: 41 months and 10 days.
  assert.deepEqual([byParameter.trial_duration_months[0].value, byParameter.trial_duration_months[0].valueSource, byParameter.trial_duration_months[0].historicalBaseline], [41.3, "calculated", true]);
  assert.deepEqual(byParameter.trial_duration_months[0].locator.inputs, ["startDateEU", "endDateEU"]);
  // jq: each member state's notified events, in order, with the early-termination reason.
  assert.deepEqual(byParameter.msc_trial_start_date.map((item) => [item.detail.country, item.valueText]), [["France", "2022-03-31"], ["Germany", "2022-08-17"], ["Spain", "2021-04-07"]]);
  assert.deepEqual(byParameter.msc_recruitment_start_date.map((item) => item.valueText), ["2022-08-24", "2022-08-25", "2021-09-21"]);
  assert.equal(byParameter.msc_early_termination_date.length, 3);
  assert.ok(byParameter.msc_early_termination_date.every((item) => item.valueText === "2024-09-17" && item.detail.reason === "Sponsor Decision"));
  assert.equal(byParameter.site_count[0].value, 8);
  assert.equal(extractions.length, 18);
});

test("every value that can be quoted is quoted from the record's own preserved text, and verifies against it", () => {
  for (const name of [`retrieve-authorised-${AUTHORISED}.json`, `retrieve-ended-${ENDED}.json`]) {
    const { extractions, record } = ctisPrecedent(fixture(name), { retrievedAt: AT });
    assert.ok(record.text.startsWith(`${record.reduced.ctNumber} · EU CTIS (EMA, euclinicaltrials.eu) · retrieved ${AT}`));
    for (const item of extractions) {
      const checked = verifyExtraction({ extraction: item, sourceText: record.text, checkedAt: AT });
      assert.equal(checked.state, "verified", `${name}: ${item.parameter} ${item.quote}`);
      assert.ok(record.text.includes(item.quote), `${item.parameter}'s quotation is a line of the text`);
    }
  }
  // A number that is not in the quotation is refused, so the check is not vacuous.
  const { extractions, record } = ctisPrecedent(fixture(`retrieve-ended-${ENDED}.json`), { retrievedAt: AT });
  const planned = extractions.find((item) => item.parameter === "enrollment_estimated");
  assert.equal(verifyExtraction({ extraction: { ...planned, value: 80 }, sourceText: record.text }).state, "quote_missing_number");
});

test("the record keeps no person: no sponsor or site contact, e-mail address or telephone number reaches the preserved text", () => {
  for (const name of [`retrieve-authorised-${AUTHORISED}.json`, `retrieve-ended-${ENDED}.json`]) {
    const raw = fixture(name);
    const { record } = ctisPrecedent(raw, { retrievedAt: AT });
    assert.doesNotMatch(record.text, /@|\+\d{6,}|redacted|functionalName|publicContacts|scientificContacts|telephone|Principal investigator/i, name);
    // The sponsor is its organisation, and the sites are the hospitals' names.
    assert.match(record.text, /authorizedPartI\.sponsors\[0\]\.name: /);
    assert.match(record.text, /authorizedPartsII\[0\]\.trialSites\[0\]: /);
    assert.ok(!JSON.stringify(record.reduced).includes("functionalEmailAddress"));
    // The reduction is a whitelist: a field it does not name is not carried.
    assert.ok(!("documents" in record.reduced) && !("correctiveMeasures" in record.reduced));
    assert.ok(JSON.stringify(raw).length > JSON.stringify(record.reduced).length * 1.5, "the reduced record is far smaller than the wire body");
  }
});

test("the reduction is pure and idempotent over what it keeps, and the hash is the reduced record's", () => {
  const raw = fixture(`retrieve-authorised-${AUTHORISED}.json`);
  const before = JSON.stringify(raw);
  const once = reducedCtisRecord(raw);
  assert.equal(JSON.stringify(raw), before, "the input is not mutated");
  assert.deepEqual(reducedCtisRecord(raw), once, "the same input reduces to the same record");
  const a = ctisPrecedent(raw, { retrievedAt: AT });
  const b = ctisPrecedent(raw, { retrievedAt: "2026-10-05T00:00:00.000Z" });
  assert.equal(a.record.hash, b.record.hash, "the hash does not move with the retrieval clock");
  assert.notEqual(a.record.text, b.record.text);
  assert.equal(renderRegistryRecordText(a.record.reduced, { header: "" }), b.record.text.split("\n").slice(2).join("\n"));
  // A record of a trial with an enormous site list says how many it cut, and counts from the whole.
  const crowded = structuredClone(raw);
  const site = crowded.authorizedApplication.authorizedPartsII[0].trialSites[0];
  crowded.authorizedApplication.authorizedPartsII[0].trialSites = Array.from({ length: 450 }, () => site);
  const long = ctisPrecedent(crowded, { retrievedAt: AT });
  assert.equal(long.record.reduced.authorizedApplication.authorizedPartsII[0].trialSites.length, 200);
  assert.equal(long.record.reduced.authorizedApplication.authorizedPartsII[0].trialSitesTotal, 450);
  assert.deepEqual([long.precedent.sites.count, long.precedent.sites.listTruncated], [450, true]);
  assert.equal(long.extractions.find((item) => item.parameter === "site_count").value, 450);
});

test("a record is retrieved by its EU CT number: a bad number costs no request, an unknown one is not found, an outage is unavailable", async () => {
  let answer = { body: fixture(`retrieve-authorised-${AUTHORISED}.json`) };
  const { client, seen } = clientOver(() => answer);
  const found = await client.recordCtis(` ${AUTHORISED} `);
  assert.equal(found.status, "ok");
  assert.equal(found.precedent.registryId, AUTHORISED);
  assert.equal(found.record.sourceRef, `ctis:${AUTHORISED}`);
  assert.deepEqual(seen.map((call) => [call.method, call.url]), [["GET", `${CTIS_BASE_URL}/retrieve/${AUTHORISED}`]]);
  assert.equal(client.status().counters.records, 1);
  assert.equal(ctis(client).lastCheckedAt, AT);

  const before = ctis(client);
  for (const bad of ["../../etc/passwd", "NCT02296125", "2026-525672-26", "2026-525672-26-0", "2026-52567-26-01", "", "2026-525672-26-01/extra", "2026-525672-26-01?x=1", null]) {
    assert.equal((await client.recordCtis(bad)).reason, "registry_id_invalid", String(bad));
  }
  assert.equal(seen.length, 1, "a refused number costs no request");
  assert.deepEqual(ctis(client), before, "a local refusal is not an observation of the registry");

  // The portal's answer for an unknown number is 200 and `{}`: not found, and the registry did answer.
  answer = { body: fixture("retrieve-unknown.json") };
  const unknown = await client.recordCtis("2099-000000-00-00");
  assert.deepEqual([unknown.status, unknown.reason, unknown.registryId], [REGISTRY_NOT_FOUND, REGISTRY_NOT_FOUND, "2099-000000-00-00"]);
  assert.equal(ctis(client).availability, "available", "a missing trial is not an outage");

  // A record that is another trial's, or not a record, is unreadable and says so.
  answer = { body: fixture(`retrieve-ended-${ENDED}.json`) };
  assert.equal((await client.recordCtis(AUTHORISED)).reason, "registry_record_unreadable");
  answer = { body: { surprise: true } };
  assert.equal((await client.recordCtis(AUTHORISED)).reason, "registry_record_unreadable");
  assert.equal(ctis(client).availability, "unavailable");
  answer = { status: 502 };
  const outage = await client.recordCtis(AUTHORISED);
  assert.deepEqual([outage.status, outage.reason, outage.registryId], [REGISTRY_UNAVAILABLE, "http_502", AUTHORISED]);
  answer = { body: fixture(`retrieve-authorised-${AUTHORISED}.json`) };
  assert.equal((await client.recordCtis(AUTHORISED)).status, "ok");
  assert.equal(ctis(client).availability, "available");
});

// --- the evidence pipeline: CTIS beside ClinicalTrials.gov and ChiCTR --------------

const store = { transaction: async () => { throw new Error("not under test"); } };

test("precedent candidates ask CTIS beside the others, with their own row each, and an unreachable one is a row and not an empty library", async () => {
  const searched = [];
  const registry = {
    search: async () => ({ status: "ok", total: 1, items: [{ registry: "clinicaltrials.gov", registryId: "NCT00000001", title: "x", conditions: ["breast cancer"], interventions: [], phases: ["PHASE2"], hasResults: false }] }),
    searchChictr: async () => ({ status: "ok", total: 0, items: [] }),
    searchCtis: async (request) => { searched.push(request); return { status: "ok", total: 460, items: fixture("search-breast-cancer-page1.json").data.map(ctisListItem) }; },
  };
  const pipeline = createVcrEvidencePipeline({ store, registry });
  const found = await pipeline.findPrecedents({ userId: "u", target: { condition: "breast cancer", intervention: "linzagolix", phases: ["PHASE2"] }, limit: 10 });
  assert.equal(found.status, "ok");
  assert.deepEqual(found.registries.map((row) => [row.registry, row.status, row.total]), [["clinicaltrials.gov", "ok", 1], ["chictr", "ok", 0], ["ctis", "ok", 460]]);
  assert.deepEqual(searched[0], { condition: "breast cancer", intervention: "linzagolix", phases: ["PHASE2"], hasResults: null, limit: 10 });
  const ctisCandidates = found.candidates.filter((candidate) => candidate.registry === "ctis");
  assert.deepEqual(ctisCandidates.map((candidate) => candidate.registryId).sort(), ["2024-518348-19-00", "2026-525672-26-01"]);
  assert.ok(ctisCandidates.every((candidate) => candidate.similarity.score >= 0 && candidate.url.startsWith("https://euclinicaltrials.eu/ctis-public/view/")));
  // The portal that does not answer is a row that says so; the candidates of the others still come back.
  registry.searchCtis = async () => ({ status: REGISTRY_UNAVAILABLE, reason: "timeout", items: [], total: null, nextPageToken: null });
  const degraded = await pipeline.findPrecedents({ userId: "u", target: { condition: "breast cancer" }, limit: 10 });
  assert.equal(degraded.status, "ok");
  assert.deepEqual(degraded.registries.find((row) => row.registry === "ctis"), { registry: "ctis", status: REGISTRY_UNAVAILABLE, reason: "timeout", total: null });
  assert.equal(degraded.candidates.length, 1);
  // A deployment whose registry client predates CTIS, or a caller who leaves it out, is unchanged.
  delete registry.searchCtis;
  assert.deepEqual((await pipeline.findPrecedents({ userId: "u", target: { condition: "x" } })).registries.map((row) => row.registry), ["clinicaltrials.gov", "chictr"]);
  assert.deepEqual((await pipeline.findPrecedents({ userId: "u", target: { condition: "x" }, includeCtis: false, includeChictr: false })).registries.map((row) => row.registry), ["clinicaltrials.gov"]);
});

test("the runtime's registry read serves a CTIS record, with its values verified against its text, and names a missing one", async () => {
  const registry = {
    record: async () => { throw new Error("a CTIS number is never sent to ClinicalTrials.gov"); },
    recordCtis: async (id) => (id === AUTHORISED ? { status: "ok", ...ctisPrecedent(fixture(`retrieve-authorised-${AUTHORISED}.json`), { retrievedAt: AT }) } : { status: REGISTRY_NOT_FOUND, reason: REGISTRY_NOT_FOUND }),
  };
  const pipeline = createVcrEvidencePipeline({ store, registry, now: () => new Date(AT) });
  const read = await pipeline.readRegistryRecord({ registry: "ctis", registryId: AUTHORISED });
  assert.equal(read.available, true);
  assert.equal(read.registry, "ctis");
  assert.equal(read.record.values.length, 4);
  assert.ok(read.record.values.every((value) => value.verification === "verified"));
  assert.equal(read.record.values.find((value) => value.parameter === "enrollment_estimated").enrollmentKind, "estimated");
  assert.equal(read.sources[0].registry, "ctis");
  assert.deepEqual(read.issues.map((issue) => issue.code), ["no_results_section"]);
  const missing = await pipeline.readRegistryRecord({ registry: "ctis", registryId: "2099-000000-00-00" });
  assert.deepEqual([missing.available, missing.status, missing.code], [false, REGISTRY_NOT_FOUND, REGISTRY_NOT_FOUND]);
  // A registry client that predates CTIS says the registry is not configured instead of throwing.
  const old = createVcrEvidencePipeline({ store, registry: { record: registry.record } });
  assert.equal((await old.readRegistryRecord({ registry: "ctis", registryId: AUTHORISED })).code, REGISTRY_UNAVAILABLE);
});
