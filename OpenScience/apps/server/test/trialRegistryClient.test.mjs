// The trial-registry client, against records recorded from the live API on
// 2026-09-28 (memory: a golden fixture is recorded from the wire, never
// written from the docs).
//
// The record itself is in `vcrEvidenceFixtures.mjs`, which is not a test file
// so that importing it does not re-run this suite.
import assert from "node:assert/strict";
import test from "node:test";

import { VCR_ENROLLMENT_KINDS } from "@evimed/domain";

import { FLAURA } from "./vcrEvidenceFixtures.mjs";
import {
  CTGOV_SEARCH_FIELDS, REGISTRY_NOT_FOUND, REGISTRY_UNAVAILABLE, REGISTRY_UNAVAILABLE_PARAMETERS,
  armRoleOf, chictrPrecedent, confidenceLevelOfDispersion, createChictrAdapter, createTrialRegistryClient, ctgovPrecedent,
  monthsBetween, reducedRegistryRecord, registryRecordHash, renderRegistryRecordText,
} from "../src/trialRegistryClient.mjs";
import { vcrChictrAdapter } from "../src/vcrComposition.mjs";


/** The retrieval clock every fixture-built precedent carries. */
const AT = "2026-09-28T00:00:00.000Z";

/** A scripted upstream: one entry per URL substring. */
function upstream(script) {
  const seen = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (url, init) => {
    seen.push(String(url));
    const answer = await script(String(url), init);
    if (answer.abort) {
      // A real socket keeps the event loop alive while it waits. This stand-in has to as
      // well: the client's deadline timer is unref'd on purpose, and Node 22's test runner
      // cancels a test whose only pending work is an unref'd timer.
      return new Promise((_resolve, reject) => {
        const hold = setTimeout(() => {}, 60_000);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(hold);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    }
    return new Response(answer.raw ?? JSON.stringify(answer.body ?? {}), {
      status: answer.status ?? 200, headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, seen };
}

const noSleep = async () => {};

test("the reduction keeps the design modules and drops everything a design parameter cannot come from", () => {
  const withNoise = {
    ...FLAURA,
    resultsSection: {
      ...FLAURA.resultsSection,
      // 628 rows of serious events on the live record: a safety read, and it
      // would dominate the bytes a quotation is checked against.
      adverseEventsModule: { seriousEvents: Array.from({ length: 628 }, (_unused, index) => ({ term: `event ${index}` })) },
    },
    documentSection: { largeDocumentModule: { largeDocs: [{ label: "SAP" }] } },
  };
  const reduced = reducedRegistryRecord(withNoise);
  assert.equal(reduced.resultsSection.adverseEventsModule, undefined, "adverse events are not a design parameter");
  assert.equal(reduced.documentSection, undefined);
  assert.ok(reduced.protocolSection.eligibilityModule.eligibilityCriteria.startsWith("Inclusion Criteria:"));
  assert.equal(reduced.hasResults, true);
  // The reduction never mutates what it was handed.
  assert.equal(withNoise.resultsSection.adverseEventsModule.seriousEvents.length, 628);
});

test("a long site list is truncated and its real count is stated, not read off the slice", () => {
  const many = {
    protocolSection: {
      contactsLocationsModule: { locations: Array.from({ length: 300 }, (_unused, index) => ({ facility: `Site ${index}`, country: "China" })) },
    },
  };
  const reduced = reducedRegistryRecord(many);
  assert.equal(reduced.protocolSection.contactsLocationsModule.locations.length, 200);
  assert.equal(reduced.protocolSection.contactsLocationsModule.locationsTotal, 300,
    "a length read off a truncated array is a wrong number that looks right");
  const built = ctgovPrecedent(many, { retrievedAt: AT });
  assert.equal(built.precedent.sites.count, 300);
  assert.equal(built.precedent.sites.listTruncated, true);
});

test("the preserved text is one line per leaf, and the hash is of the reduced record", () => {
  const reduced = reducedRegistryRecord(FLAURA);
  const body = renderRegistryRecordText(reduced, { header: "NCT02296125 · ClinicalTrials.gov" });
  const lines = body.split("\n");
  assert.equal(lines[0], "NCT02296125 · ClinicalTrials.gov");
  assert.ok(lines.includes("protocolSection.designModule.enrollmentInfo.count: 674"));
  assert.ok(lines.includes("protocolSection.designModule.enrollmentInfo.type: ACTUAL"));
  assert.ok(lines.includes("protocolSection.contactsLocationsModule.locations[0].country: United States"),
    "an array leaf carries its index, so a locator can point at one element");
  assert.ok(lines.some((line) => line.startsWith("protocolSection.eligibilityModule.eligibilityCriteria: Inclusion Criteria:")),
    "a multi-line field stays on its own line; the quote comparison folds the whitespace");
  // Two reductions of the same record hash the same; a changed field does not.
  assert.equal(registryRecordHash(reduced), registryRecordHash(reducedRegistryRecord(FLAURA)));
  assert.notEqual(
    registryRecordHash(reduced),
    registryRecordHash(reducedRegistryRecord({ ...FLAURA, hasResults: false })),
  );
});

test("ESTIMATED and ACTUAL stay apart, and only an ACTUAL figure may be a historical baseline", () => {
  const actual = ctgovPrecedent(FLAURA, { retrievedAt: AT });
  assert.equal(actual.precedent.enrollment.actual, 674);
  assert.equal(actual.precedent.enrollment.planned, null, "this record states one figure, not two");
  assert.equal(actual.precedent.enrollmentKind, "actual");
  const enrolment = actual.extractions.find((item) => item.parameter === "enrollment_actual");
  assert.equal(enrolment.historicalBaseline, true);

  const planned = ctgovPrecedent({
    ...FLAURA,
    protocolSection: {
      ...FLAURA.protocolSection,
      designModule: { ...FLAURA.protocolSection.designModule, enrollmentInfo: { count: 120, type: "ESTIMATED" } },
      statusModule: { ...FLAURA.protocolSection.statusModule, startDateStruct: { date: "2026-01-01", type: "ESTIMATED" } },
    },
  }, { retrievedAt: AT });
  assert.equal(planned.precedent.enrollment.planned, 120);
  assert.equal(planned.precedent.enrollment.actual, null);
  const plannedItem = planned.extractions.find((item) => item.parameter === "enrollment_estimated");
  assert.equal(plannedItem.enrollmentKind, "estimated");
  assert.equal(plannedItem.historicalBaseline, false, "a sponsor's plan is not a historical baseline (plan §6.2)");
  const plannedStart = planned.extractions.find((item) => item.parameter === "start_date");
  assert.equal(plannedStart.historicalBaseline, false);
  // The mapping goes through the domain's vocabulary, so an unknown word is null.
  const odd = ctgovPrecedent({
    protocolSection: { designModule: { enrollmentInfo: { count: 50, type: "SOMETHING_NEW" } } },
  }, { retrievedAt: AT });
  assert.equal(odd.precedent.enrollmentKind, null);
  assert.ok(VCR_ENROLLMENT_KINDS.includes("actual") && VCR_ENROLLMENT_KINDS.includes("estimated"));
});

test("every quotable value of the recorded record comes out, each with its own field path", () => {
  const { extractions } = ctgovPrecedent(FLAURA, { retrievedAt: AT });
  const byParameter = new Map();
  for (const item of extractions) byParameter.set(item.parameter, [...(byParameter.get(item.parameter) ?? []), item]);
  assert.deepEqual([...byParameter.keys()].sort(), [
    "accrual_to_primary_completion_months", "arm_started", "arm_withdrawn", "completion_date",
    "enrollment_actual", "hazard_ratio", "median_time", "primary_completion_date", "site_count", "start_date",
  ]);

  const hazard = byParameter.get("hazard_ratio")[0];
  assert.equal(hazard.value, 0.46);
  assert.equal(hazard.ciLow, 0.37);
  assert.equal(hazard.ciHigh, 0.57);
  assert.equal(hazard.arm, "Osimertinib 80 mg (Global Cohort) vs SoC EGFR-TKI (Global Cohort)",
    "an effect estimate names the two arms it compares, not a group id");
  assert.equal(hazard.detail.statisticalMethod, "Log Rank");
  assert.equal(hazard.detail.scale, "log");
  assert.equal(hazard.quote, "resultsSection.outcomeMeasuresModule.outcomeMeasures[0].analyses[0].paramValue: 0.46");

  const median = byParameter.get("median_time").find((item) => item.arm.startsWith("SoC"));
  assert.equal(median.value, 10.2);
  assert.equal(median.unit, "Months");
  assert.equal(median.sampleSize, 277, "the arm's denominator comes from denoms[], keyed by the same group id");

  // Derived values are `calculated` and name the fields they were computed from.
  const accrual = byParameter.get("accrual_to_primary_completion_months")[0];
  assert.equal(accrual.valueSource, "calculated");
  assert.equal(accrual.value, 30.5);
  assert.deepEqual(accrual.locator.inputs, [
    "protocolSection.statusModule.startDateStruct.date",
    "protocolSection.statusModule.primaryCompletionDateStruct.date",
  ]);
  assert.equal(byParameter.get("site_count")[0].valueSource, "calculated");
  assert.equal(byParameter.get("arm_withdrawn")[0].detail.reason, "Withdrawal by Subject");
});

test("what no registry carries comes back named, and never as 0", () => {
  const { precedent } = ctgovPrecedent(FLAURA, { retrievedAt: AT });
  const named = new Map(precedent.unavailable.map((entry) => [entry.parameter, entry.reason]));
  for (const parameter of ["screen_failure_rate", "accrual_per_site_per_month", "site_activation_date"]) {
    assert.ok(named.has(parameter), `${parameter} must be named as unavailable`);
    assert.ok(named.get(parameter).length > 4, "the reason is what a page prints beside 「不可得」");
  }
  assert.equal(precedent.unavailable.length, Object.keys(REGISTRY_UNAVAILABLE_PARAMETERS).length);
  assert.equal(
    precedent.extractions, undefined,
    "the precedent row carries no values of its own; they are separate rows with their own locators",
  );
});

test("months between two milestones, and nothing when one of them is missing", () => {
  assert.equal(monthsBetween("2014-12-03", "2017-06-19"), 30.5);
  assert.equal(monthsBetween("2014-12", "2015-12"), 12);
  assert.equal(monthsBetween("", "2017-06-19"), null);
  assert.equal(monthsBetween("2014-12-03", "not a date"), null);
});

test("a search asks for a projection and a total, and reads the page the live API answers", async () => {
  const { fetchImpl, seen } = upstream(() => ({
    body: {
      totalCount: 82,
      studies: [{
        protocolSection: {
          identificationModule: { nctId: "NCT04179890", briefTitle: "Afatinib followed by osimertinib" },
          statusModule: { overallStatus: "COMPLETED", startDateStruct: { date: "2019-11-01", type: "ACTUAL" } },
          designModule: { studyType: "OBSERVATIONAL", phases: [], enrollmentInfo: { count: 462, type: "ACTUAL" } },
          conditionsModule: { conditions: ["NSCLC"] },
          armsInterventionsModule: { interventions: [{ type: "DRUG", name: "Osimertinib" }] },
        },
        hasResults: true,
      }],
      nextPageToken: "ZVNj7o2E",
    },
  }));
  const client = createTrialRegistryClient({ fetchImpl, sleep: noSleep });
  const answer = await client.search({ condition: "non-small cell lung cancer", intervention: "osimertinib", limit: 3, hasResults: true });
  assert.equal(answer.status, "ok");
  assert.equal(answer.total, 82);
  assert.equal(answer.nextPageToken, "ZVNj7o2E");
  assert.equal(answer.items.length, 1);
  assert.equal(answer.items[0].enrollmentKind, "actual");
  assert.equal(answer.items[0].url, "https://clinicaltrials.gov/study/NCT04179890");
  const url = new URL(seen[0]);
  assert.equal(url.searchParams.get("countTotal"), "true");
  assert.equal(url.searchParams.get("pageSize"), "3");
  assert.equal(url.searchParams.get("aggFilters"), "results:with");
  assert.deepEqual(url.searchParams.get("fields").split("|"), [...CTGOV_SEARCH_FIELDS],
    "a candidate list asks for a page, not for 2 MB of record");
});

test("offline is a named answer, not an empty library", async () => {
  const refused = createTrialRegistryClient({
    fetchImpl: async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }); },
    sleep: noSleep,
  });
  const answer = await refused.search({ condition: "NSCLC" });
  assert.equal(answer.status, REGISTRY_UNAVAILABLE);
  assert.equal(answer.reason, "ENOTFOUND");
  assert.deepEqual(answer.items, []);
  assert.equal(answer.total, null, "「没查」 is not 「查到 0 条」");

  const unconfigured = createTrialRegistryClient({ baseUrl: "" });
  assert.equal(unconfigured.configured, false);
  assert.equal((await unconfigured.record("NCT02296125")).reason, "registry_not_configured");
});

test("a busy registry is retried up to the cap, inside one deadline, and a missing record is not an outage", async () => {
  let calls = 0;
  const { fetchImpl } = upstream(() => {
    calls += 1;
    return calls < 3 ? { status: 503 } : { body: FLAURA };
  });
  const client = createTrialRegistryClient({ fetchImpl, sleep: noSleep, maxAttempts: 3 });
  const answer = await client.record("NCT02296125");
  assert.equal(answer.status, "ok");
  assert.equal(calls, 3);
  assert.equal(client.status().counters.retried, 2);

  let always = 0;
  const alwaysBusy = createTrialRegistryClient({
    fetchImpl: upstream(() => { always += 1; return { status: 429 }; }).fetchImpl, sleep: noSleep, maxAttempts: 2,
  });
  const busy = await alwaysBusy.record("NCT02296125");
  assert.equal(busy.status, REGISTRY_UNAVAILABLE);
  assert.equal(always, 2, "the retry cap is a cap");

  const missing = createTrialRegistryClient({ fetchImpl: upstream(() => ({ status: 404 })).fetchImpl, sleep: noSleep });
  const gone = await missing.record("NCT00000000");
  assert.equal(gone.status, REGISTRY_NOT_FOUND, "a record that is not there is not a registry that is down");

  // A 400 is the caller's mistake and is not retried.
  let badRequests = 0;
  const bad = createTrialRegistryClient({
    fetchImpl: upstream(() => { badRequests += 1; return { status: 400 }; }).fetchImpl, sleep: noSleep, maxAttempts: 3,
  });
  assert.equal((await bad.search({ term: "x" })).reason, "http_400");
  assert.equal(badRequests, 1);
});

test("a deadline that runs out answers timeout rather than hanging, and a bad id never reaches the wire", async () => {
  let requests = 0;
  const { fetchImpl } = upstream(() => { requests += 1; return { abort: true }; });
  const client = createTrialRegistryClient({ fetchImpl, sleep: noSleep, timeoutMs: 400, maxAttempts: 3 });
  const answer = await client.record("NCT02296125");
  assert.equal(answer.status, REGISTRY_UNAVAILABLE);
  assert.equal(answer.reason, "timeout");
  assert.equal(requests, 1, "every attempt shares one deadline, so a spent deadline stops the retries");

  // A deadline too short to be worth starting a request on does not start one.
  const noTime = createTrialRegistryClient({ fetchImpl, sleep: noSleep, timeoutMs: 40 });
  assert.equal((await noTime.record("NCT02296125")).reason, "timeout");
  assert.equal(requests, 1);

  const guarded = createTrialRegistryClient({ fetchImpl: upstream(() => ({ body: FLAURA })).fetchImpl, sleep: noSleep });
  const refused = await guarded.record("../../etc/passwd");
  assert.equal(refused.reason, "registry_id_invalid");
  assert.equal(guarded.status().counters.requests, 0, "a refused id costs no request");
});

test("an answer past the size bound is abandoned while it streams", async () => {
  const huge = "x".repeat(9 * 1024 * 1024);
  const client = createTrialRegistryClient({
    fetchImpl: async () => new Response(huge, { status: 200, headers: { "content-type": "application/json" } }),
    sleep: noSleep,
  });
  const answer = await client.record("NCT02296125");
  assert.equal(answer.status, REGISTRY_UNAVAILABLE);
  assert.equal(answer.reason, "response_too_large");
});

test("the ChiCTR seat is unavailable until an adapter is wired, and never answers an empty list", async () => {
  const client = createTrialRegistryClient({ fetchImpl: upstream(() => ({ body: {} })).fetchImpl, sleep: noSleep });
  assert.equal(client.chictrConfigured, false);
  const answer = await client.searchChictr({ query: "肺癌" });
  assert.equal(answer.status, REGISTRY_UNAVAILABLE);
  assert.equal(answer.reason, "registry_not_configured");
  assert.deepEqual(answer.items, []);

  const wired = createTrialRegistryClient({
    fetchImpl: upstream(() => ({ body: {} })).fetchImpl,
    sleep: noSleep,
    chictrAdapter: async () => ({
      items: [{
        registrationNo: "ChiCTR2000030000", title: "某中药注射液治疗社区获得性肺炎的随机对照研究",
        status: "尚未开始", registrationDate: "2020-03-01", phase: "II期", sampleSize: 240,
        studyType: "干预性研究", conditions: ["社区获得性肺炎"], primarySponsor: "某医院",
        interventions: ["某中药注射液"], url: "https://www.chictr.org.cn/showproj.html?proj=1",
      }],
    }),
  });
  const built = await wired.searchChictr({ query: "社区获得性肺炎" });
  assert.equal(built.status, "ok");
  const [record] = built.items;
  assert.equal(record.precedent.registry, "chictr");
  assert.equal(record.precedent.enrollmentKind, null);
  const size = record.extractions.find((item) => item.parameter === "enrollment_unspecified");
  assert.equal(size.value, 240);
  assert.equal(size.historicalBaseline, false,
    "the shared evidence API does not say whether 240 was planned or reached, so it is not a baseline");
  const named = record.precedent.unavailable.map((entry) => entry.parameter);
  for (const parameter of ["eligibility_text", "arm_definitions", "outcome_definitions", "results"]) {
    assert.ok(named.includes(parameter), `${parameter} must be reported missing rather than empty`);
  }
});

test("a ChiCTR precedent's numbers are quotable out of its own rendering", () => {
  const built = chictrPrecedent({ registrationNo: "ChiCTR2100000001", title: "试验", sampleSize: 96, url: "https://example.org" }, { retrievedAt: AT });
  assert.ok(built.record.text.includes("sampleSize: 96"));
  assert.equal(built.extractions[0].quote, "sampleSize: 96");
  assert.equal(built.extractions[0].sourceRef, "chictr:ChiCTR2100000001");
});

test("an adapter that throws is an unavailable registry, not a crash", async () => {
  const client = createTrialRegistryClient({
    fetchImpl: upstream(() => ({ body: {} })).fetchImpl,
    sleep: noSleep,
    chictrAdapter: async () => { throw Object.assign(new Error("upstream said no"), { code: "evimed_trials_unavailable" }); },
  });
  const answer = await client.searchChictr({ query: "x" });
  assert.equal(answer.status, REGISTRY_UNAVAILABLE);
  assert.equal(answer.reason, "evimed_trials_unavailable");
});

test("CS-26 a group is a control or a treatment arm by the record's own arm types, and a title that matches none is unknown", () => {
  const arms = [{ label: "AZD9291+ placebo", type: "EXPERIMENTAL" }, { label: "Standard of Care", type: "ACTIVE_COMPARATOR" }, { label: "Other", type: "OTHER" }];
  assert.equal(armRoleOf("AZD9291+ placebo", arms), "treatment");
  assert.equal(armRoleOf("standard of care (global cohort)", arms), "control", "a group title that contains the arm's label is that arm");
  assert.equal(armRoleOf("Other", arms), "unknown");
  assert.equal(armRoleOf("Osimertinib 80 mg (Global Cohort)", arms), "unknown", "FLAURA's group titles match none of its arm labels: the run says which is which");
  const record = ctgovPrecedent(FLAURA, { retrievedAt: AT });
  const roles = new Map(record.extractions.filter((item) => item.parameter === "median_time").map((item) => [item.arm, item.armRole]));
  assert.deepEqual([...roles.values()], ["unknown", "unknown"]);
  assert.equal(record.extractions.find((item) => item.parameter === "hazard_ratio").armRole, "contrast");
  assert.equal(record.extractions.find((item) => item.parameter === "enrollment_actual").armRole, "overall");
});

test("E-9 a confidence bound is anchored by the field it came from, and only when the measure says it is a confidence interval", () => {
  const record = ctgovPrecedent(FLAURA, { retrievedAt: AT });
  const median = record.extractions.find((item) => item.parameter === "median_time");
  assert.equal(median.ciLow, 15.2);
  assert.match(median.locator.parts.ciLow.quote, /lowerLimit: 15\.2$/);
  assert.match(median.locator.parts.ciHigh.quote, /upperLimit: 21\.4$/);
  assert.match(median.locator.parts.sampleSize.quote, /denoms\[0\]\.counts\[\d\]\.value: 279$/);
  for (const part of Object.values(median.locator.parts)) assert.ok(record.record.text.includes(part.quote), `${part.path} is in the preserved text`);
  assert.equal(confidenceLevelOfDispersion("95% Confidence Interval"), 0.95);
  assert.equal(confidenceLevelOfDispersion("90% Confidence Interval"), 0.9);
  for (const label of ["Full Range", "Inter-Quartile Range", "Standard Deviation", "", undefined]) assert.equal(confidenceLevelOfDispersion(label), null, String(label));

  // Under an interquartile range the limits are quartiles, not a confidence interval: they stay out of the pool.
  const iqr = JSON.parse(JSON.stringify(FLAURA));
  for (const measure of iqr.resultsSection.outcomeMeasuresModule.outcomeMeasures) if (measure.dispersionType) measure.dispersionType = "Inter-Quartile Range";
  const unread = ctgovPrecedent(iqr, { retrievedAt: AT }).extractions.find((item) => item.parameter === "median_time");
  assert.equal(unread.ciLow, null);
  assert.equal(unread.ciHigh, null);
  assert.deepEqual(unread.detail.limitsAreNotACi, { lower: 15.2, upper: 21.4 }, "still on the record, named for what they are");
});

test("PA-41 ChiCTR is reached through the evidence API with the control plane's own credential, or not at all", async () => {
  /** @type {any[]} */
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), init });
    return new Response(JSON.stringify({ code: 200, data: { total: 1, list: [{ registrationNo: "ChiCTR2000030000", title: "试验", sampleSize: 96 }] } }), { status: 200 });
  };
  assert.equal(vcrChictrAdapter({ config: {}, fetchImpl }), null, "no credential, no seat");
  const adapter = vcrChictrAdapter({ config: { publicSourceCredentials: { evimedEvidence: "key-not-echoed" } }, fetchImpl });
  assert.equal(typeof adapter, "function");
  const client = createTrialRegistryClient({ fetchImpl, sleep: noSleep, chictrAdapter: adapter });
  const answer = await client.searchChictr({ query: "ChiCTR2000030000", limit: 5 });
  assert.equal(answer.status, "ok");
  assert.equal(answer.items[0].precedent.registryId, "ChiCTR2000030000");
  assert.equal(seen[0].url, "https://www.evimed.com/api-evimed/medicine-api/ai-api/review/api/clinical-trial");
  assert.deepEqual(JSON.parse(seen[0].init.body), { query: "ChiCTR2000030000", count: 5, registry: 0 }, "registry 0 is ChiCTR");
  assert.equal(seen[0].init.headers.authorization, "Bearer key-not-echoed");
  assert.equal(client.chictrConfigured, true);

  const refused = createChictrAdapter({ search: async () => { throw Object.assign(new Error("no"), { code: "http_403" }); } });
  const failing = createTrialRegistryClient({ fetchImpl, sleep: noSleep, chictrAdapter: refused });
  assert.equal((await failing.searchChictr({ query: "x" })).reason, "http_403");
  const unreadable = createTrialRegistryClient({ fetchImpl, sleep: noSleep, chictrAdapter: createChictrAdapter({ search: async () => ({ data: { total: 0 } }) }) });
  assert.equal((await unreadable.searchChictr({ query: "x" })).reason, "registry_answer_unreadable", "an answer with no list is not an empty library");
  assert.throws(() => createChictrAdapter({ search: null }), TypeError);
});
